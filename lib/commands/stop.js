import { execa } from 'execa'
import { resolveRepoSession } from '../repo-session.js'

class StopAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export async function stopCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')
  const err = (msg) => stderr.write(msg + '\n')

  // THE REPO'S session, not the directory you typed the command in (#168). Still
  // per-project — `stop` kills one name and never every `ralph-*` session, so other
  // projects' loops are untouched — but the name is now derived from the git TOPLEVEL
  // rather than from `cwd`, because `sessionNameFor` hashes the path it is handed
  // (lib/lock.js:20-24) and `/repo` and `/repo/lib` are therefore two different names for
  // one loop. Typed in a subdirectory this command used to probe a session nothing had
  // created, print the no-session notice below, exit 0 and leave the loop running: a
  // confident answer about a name, read as an answer about the repo.
  //
  // Outside a git work tree the module degrades to the `cwd` (lib/repo-session.js:71), so
  // `ralph stop` in a plain directory still kills the loop `ralph start` opened there — a
  // session name is a label, and there is nothing to anchor on to derive a better one.
  //
  // WHY THE MODULE RATHER THAN THE TWO LINES IT REPLACES: the derivation and the liveness
  // probe are one answer, and `ralph live` (lib/commands/live.js:115) already gets it from
  // there. Two commands that can disagree about which session a repo has are two commands
  // that can each be right about a different name — `live` reporting no session over a loop
  // `stop` would happily kill. `resolveRepoSession` also spends the `has-session` itself
  // (lib/repo-session.js:52) and hands back its verdict as `alive`, so there is no inline
  // probe here any more; a second one would ask tmux the same question twice.
  //
  // `root` is deliberately not destructured: this command spends it only through the name,
  // and nothing it prints mentions a directory. `ralph live` is the caller that needs the
  // path itself, for the `ralph start` hint that has to name where to type it
  // (live.js:182).
  const { session, alive } = await resolveRepoSession({ cwd, exec })

  if (!alive) {
    out(`ℹ️  No tmux session '${session}' running.`)
    return { exitCode: 0, killed: false }
  }

  const result = await exec('tmux', ['kill-session', '-t', session], { reject: false })
  if (result.exitCode !== 0) {
    err(`❌ Failed to kill tmux session: ${(result.stderr || '').trim()}`)
    throw new StopAbort('tmux kill-session failed', 1)
  }
  out(`✅ tmux session '${session}' terminated.`)
  return { exitCode: 0, killed: true }
}

export { StopAbort }
