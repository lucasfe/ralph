import { execa } from 'execa'
import { commandExists } from '../utils/which.js'
import { resolveRepoSession } from '../repo-session.js'

class LiveAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

// #167 — attach THIS terminal to the loop running in the repo you are standing in, so
// `tmux attach -t ralph-<name>-<hash>` stops being a line somebody copies out of `ralph
// start`'s launch box (start.js:1067) or `ralph status`'s advice block (status.js:247).
// No arguments and no flags: the repo decides which session, and there is only one.
//
// THE DECISION ORDER IS FIXED AND EACH STEP PRINTS EXACTLY ONE ANSWER. Three of the five
// are refusals a user can act on, and the order is what makes each of them the RIGHT
// answer rather than merely a true one:
//
//   1. no tmux binary   — a pure PATH check, so it costs no spawn and it goes first.
//                         Otherwise the probes and the attach below run against a binary
//                         that is not there and the user reads execa's ENOENT instead of a
//                         dependency name.
//   2. inside tmux AND  — refusing to nest is the point; the remedy is a DIFFERENT tmux
//      a live session     command (`switch-client`), which is why this cannot be folded
//                         into any other arm. The session question is answered FIRST and
//                         `alive` is part of this condition, because `switch-client -t
//                         <session>` is no answer for a session just measured dead: tmux
//                         would reply `can't find session` and the user would still not
//                         know the loop had stopped. A dead session falls through to step
//                         4 whatever `$TMUX` says, so this arm only ever names a session
//                         that exists.
//   3. no terminal      — before the spawn, so `ralph live | cat` (a hook, a CI step) gets
//                         an error about what it did rather than tmux's `open terminal
//                         failed: not a terminal`.
//   4. no live session  — EXIT 0. "Nothing to attach to" is not a failure, exactly as
//                         `ralph stop` treats "nothing to kill" (stop.js:47-50). One line,
//                         naming the session, `ralph status`, then `ralph start` and the
//                         DIRECTORY to run it in. `status` leads because "no session under
//                         this name" is a weaker claim than "no loop": it is the only one of
//                         the three that can see a loop launched from a subdirectory, and
//                         `start` is the one that could add a second one to the same tree.
//   5. otherwise        — attach, and exit with tmux's own code. WHICH CLOSING NOTICE IS
//                         PRINTED IS DECIDED BY A SECOND `has-session`, NOT BY THAT CODE:
//                         measured against tmux 3.6b on an isolated socket, a session killed
//                         by the server while the client is attached makes `tmux attach` exit
//                         0, exactly as a clean detach does, so the code cannot tell "you
//                         detached, the loop runs on" from "the loop finished and its own
//                         EXIT trap took the session with it".
//
// THE RUNNER IS SPENT TWO WAYS ON ONE BINARY: captured for the two `has-session` probes
// (the first inside ../repo-session.js, which owns the liveness question; the second
// inline after the attach, which is a different question — see step 5), and
// `stdio: 'inherit'` for the attach itself, the way ./cycle.js:678-685 spawns the bash
// loop. An attach with captured stdio is not an attach at all — tmux would find no
// terminal on the other end.
//
// REFUSALS GO ENTIRELY TO STDERR, hints included, which is a deliberate departure from
// `ralph start`'s ❌-on-stderr/hint-on-stdout split (start.js:705-707). One of the
// refusals here is triggered BY a redirected stdout, so a hint on stdout would go down
// the very pipe the user just proved is not a terminal. The things that are not refusals —
// the no-session notice, and whichever of the two closing notices step 5 selects — are
// stdout, because they are this command's output.
export async function liveCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  exec = execa,
  // The same PATH probe `ralph start` and `ralph doctor` gate on (../utils/which.js), so
  // "tmux is installed" means one thing across the CLI. Deliberately NOT a `tmux -V`
  // spawn: this arm exists because there may be nothing to spawn.
  hasCommand = commandExists,
  // #167: `$TMUX` is the only thing that can answer "am I already inside tmux", and
  // reading it off `process.env` inside the function would make step 2 untestable — the
  // suite runs from whatever shell a developer happens to be in.
  processEnv = process.env,
  // ...and terminal-ness, injected rather than read off `process.stdout` for the same
  // reason. Derived from the RESOLVED streams above by the same left-to-right
  // destructuring trick ./start.js:122 and ./cycle.js:94 use, so injecting a stream is
  // enough to control it and an explicit override still wins.
  //
  // BOTH ENDS, unlike either of those two — which gate a readline on `stdin` alone
  // (start.js:122) and escape sequences on `stdout` alone (start.js:152). `tmux attach`
  // needs a real terminal on each, so `ralph live > file` and `ralph live < /dev/null` are
  // both refusals, and folding them into one flag would let one of the two through.
  isTTY = Boolean(stdout?.isTTY) && Boolean(stdin?.isTTY),
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')
  const err = (msg) => stderr.write(msg + '\n')

  if (!hasCommand('tmux')) {
    // `not found in PATH` is ./doctor.js's own wording for a missing dep
    // (doctor.js:343), and `ralph doctor` is where the install command for this platform
    // is printed — so this arm names the dependency and hands off rather than growing a
    // second copy of lib/deps.js's install table.
    err("❌ 'tmux' not found in PATH — `ralph live` has no way to attach.")
    err('   Install it, then re-check with: ralph doctor')
    throw new LiveAbort('tmux not installed', 1)
  }

  // The repo's session, resolved once — root, name and liveness in one call, and all three
  // answers are used: the root by step 4, the name by every message that mentions one, the
  // liveness by steps 2 and 4. It runs ahead of the refusals below because step 2 needs two
  // of the three, and the two spawns it costs are read-only.
  const { root, session, alive } = await resolveRepoSession({ cwd, exec })

  // Nesting a session inside itself is what `tmux attach` does from inside tmux, and it
  // is never what anybody meant. `.trim()` because an EMPTY `$TMUX` names no socket:
  // present-but-empty is NOT inside tmux, and refusing on it would strand a user who is
  // not in tmux at all.
  //
  // `alive &&` because the session question is answered FIRST: this arm's whole content is
  // `switch-client -t <session>`, and that is not a remedy for a session that is not there
  // — tmux would answer `can't find session` and the user would still not know their loop
  // stopped. A dead session gets step 4's notice from inside tmux exactly as it does from
  // outside; only a live one can be switched to.
  if (alive && (processEnv.TMUX ?? '').trim() !== '') {
    err('❌ Already inside tmux — `ralph live` will not nest one session inside another.')
    err(`   Switch:  tmux switch-client -t ${session}`)
    // The same detach wording `ralph start`'s launch box prints (start.js:1068), so a
    // reader who has seen one has seen the other.
    err('   Detach:  inside the session, Ctrl+B then D')
    throw new LiveAbort('already inside tmux', 1)
  }

  if (!isTTY) {
    err('❌ `ralph live` needs a terminal — stdout and stdin must both be a TTY.')
    err('   Run it in a terminal, not through a pipe, a hook or a CI step.')
    throw new LiveAbort('not a terminal', 1)
  }

  if (!alive) {
    // THIS LINE SAYS "NO SESSION", WHICH IS NOT THE SAME CLAIM AS "NO LOOP", so the safe
    // command comes before the one that starts things. The gap is measurable, not
    // hypothetical:
    //
    //   * `ralph start` launches under `sessionNameFor(cwd)` (start.js:679, spent at :983),
    //     so a loop launched in `lib/` is running under a name derived from `lib/` and this
    //     command — anchored on the TOPLEVEL — cannot see it.
    //   * `ralph status` can: templates/ralph.sh:57 anchors `PROJECT_ROOT` on the git
    //     toplevel whatever directory it was launched from and records the run there
    //     (ralph.sh:395-398), and status.js:305,312 reads `record?.session ||
    //     sessionNameFor(root)` from that same toplevel. It finds the run this command just
    //     reported absent.
    //   * Nothing would stop a second one. templates/ralph.sh takes no lock of its own —
    //     only `ralph cycle` does — and `ralph start`'s single guard is a `has-session` on
    //     its own cwd-derived name (start.js:703), which by construction misses the loop in
    //     `lib/`. Two agent loops committing to one working tree is the failure mode.
    //
    // Hence `ralph status` FIRST and `ralph start` second: the first move offered is the one
    // that can prove whether a loop exists, and the second is the one to make once it has.
    //
    // THE DIRECTORY IS STILL PART OF THE ADVICE, because `ralph start` typed anywhere else
    // opens a session under a different name than the one this line names — `root` makes the
    // remedy produce exactly the session reported missing. It cannot make it safe on its
    // own, which is what the ordering above is for. #168 took the `ralph stop` half of the
    // divergence away (stop.js:45 resolves through the same module now, so `stop` kills what
    // this command reports); `ralph start` is the half that is left, and the whole reason the
    // first bullet above is still true.
    //
    // Phrased as places and commands rather than as `cd <root> && ralph start`: a
    // directory name can contain spaces, `;` and `#` (lib/lock.js:22 sanitizes them out of
    // the session name for exactly that reason), and an unquoted path pasted into a
    // compound shell line is a different command than the one meant.
    //
    // `JSON.stringify` for the path and not for the session, because the two have different
    // guarantees: `sessionNameFor` has already reduced its input to `[A-Za-z0-9_-]`, while
    // `root` is whatever git printed and a directory name may legally contain a NEWLINE. Raw
    // interpolation would split this one answer across two lines and leave the second one
    // looking like a second answer.
    out(
      `ℹ️  No tmux session '${session}' running — check with 'ralph status', or start the loop with 'ralph start' in ${JSON.stringify(root)}`,
    )
    return { exitCode: 0, attached: false, session }
  }

  const attach = await exec('tmux', ['attach', '-t', session], { stdio: 'inherit', reject: false })

  // Everything above this line is silent on stdout, and that is the rule rather than an
  // accident: from here down tmux has owned the screen, so a line printed before the
  // attach is one the user cannot scroll back to.
  //
  // NOTHING AT ALL AFTER AN ATTACH THAT NEVER HAPPENED. A non-zero code here means tmux
  // did not get as far as a session — measured, an attach to a session that was already
  // gone exits 1 — and tmux has already written its own `can't find session` to the
  // inherited stderr. This command's exit code is that code (below), so a line here would
  // add nothing to what the user just read. `?.` because the shapes this can hand back
  // include `{ failed: true }` with no `exitCode` and a runner that resolved with nothing.
  if (attach?.exitCode === 0) {
    // WHICH notice, decided by asking tmux — not by the code above. Measured against tmux
    // 3.6b on an isolated socket: when the session's own process exits, or another client
    // kills the session, while this client is attached, `tmux attach` exits 0, the same 0 a
    // deliberate Ctrl+B D produces. The code says "you were attached and you no longer
    // are"; it cannot say whether the session outlived the client, and that is the entire
    // content of the notice.
    //
    // The window is not theoretical: templates/ralph.sh:50 installs
    // `trap 'tmux kill-session -t "$_RALPH_TEARDOWN_SESSION" …' EXIT`, so a queue that
    // drains while somebody watches ends with the session killed under their client.
    const still = await exec('tmux', ['has-session', '-t', session], { reject: false })
    if (still?.exitCode === 0) {
      out(`ℹ️  Detached — the loop is still running in '${session}'.`)
      out('   Progress:  ralph status')
      out('   Kill:      ralph stop')
    } else {
      // No `ralph stop` on this branch: there is nothing left to kill, and offering it
      // would be the same false line the other branch avoids. `ralph status` is the honest
      // next step — status.js:215 renders the post-mortem for a run that has ended, which is
      // exactly what a session that ended under the client leaves behind.
      out(`ℹ️  Session '${session}' is gone — the loop ended while you were attached.`)
      out('   What happened:  ralph status')
    }
  }

  // tmux's own code, and `1` for a result with no code at all (an execa failure shape) —
  // a spawn nobody can grade is not a success.
  return { exitCode: attach?.exitCode ?? 1, attached: true, session }
}

export { LiveAbort }
