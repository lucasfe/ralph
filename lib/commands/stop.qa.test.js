import { describe, it, expect } from 'vitest'
import { stopCommand, StopAbort } from './stop.js'
import { sessionNameFor } from '../lock.js'

// #6 QA augmentation — stop.js was fully translated. These probe interpolation
// preservation the dev's suite does not: the per-project session name must be
// interpolated into every English line, and the kill-failure message must carry
// the TRIMMED tmux stderr (adversarial: padded/multiline stderr).

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
  }
}

function makeExec(handlers = {}) {
  const calls = []
  const exec = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    return handlers[key] ?? { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

describe('QA stop — English lines interpolate the derived session name (#6)', () => {
  const CWD = '/Users/me/repos/some.weird repo'
  const SESSION = sessionNameFor(CWD)

  it('"No tmux session" notice embeds the exact derived session name', async () => {
    const stdout = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd: CWD, stdout, stderr: makeStream(), exec })
    expect(result).toEqual({ exitCode: 0, killed: false })
    expect(stdout.output()).toContain(`No tmux session '${SESSION}' running.`)
    expect(stdout.output()).not.toMatch(/Nenhuma|sess[aã]o/i)
  })

  it('success line embeds the derived session name in the English "terminated" message', async () => {
    const stdout = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd: CWD, stdout, stderr: makeStream(), exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(stdout.output()).toContain(`tmux session '${SESSION}' terminated.`)
    expect(stdout.output()).not.toMatch(/encerrada/)
  })

  it('kill-failure surfaces the TRIMMED tmux stderr in the English failure line', async () => {
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: {
        exitCode: 1,
        stdout: '',
        stderr: '   server not running on /tmp/tmux\n\n',
      },
    })
    await expect(
      stopCommand({ cwd: CWD, stdout: makeStream(), stderr, exec }),
    ).rejects.toBeInstanceOf(StopAbort)
    expect(stderr.output()).toContain('❌ Failed to kill tmux session: server not running on /tmp/tmux')
    // trailing whitespace/newlines were trimmed off the interpolated value.
    expect(stderr.output()).not.toMatch(/tmux\n\n/)
    expect(stderr.output()).not.toMatch(/Falha ao matar/)
  })
})

// ---------------------------------------------------------------------------
// #168 QA augmentation — `ralph stop` resolves its session through
// ../repo-session.js instead of hashing the cwd it was handed. The module's own two files
// (../repo-session.test.js, ../repo-session.qa.test.js) pin what it RESOLVES: the two-spawn
// ledger (../repo-session.test.js:54-64), six degradation shapes (:103-110), six liveness
// verdicts (:126-133) and the derived name's shape for eleven hostile roots
// (../repo-session.qa.test.js:65-77). What is attacked here is `stop`'s COMPOSITION of it,
// which neither of those files can see:
//
//   * the `has-session` now happens INSIDE the module (../repo-session.js:52) while the
//     `kill-session` stays outside it (stop.js:52), so the only place the two targets can be
//     held together is here;
//   * every degraded answer has to reach an ENGLISH LINE, and the module prints nothing;
//   * `stop` owns the kill spawn's options and the failure line, neither of which the
//     module has an opinion about.
//
// The two line templates below hold `stop`'s two stdout answers, spelled once: an
// exact-equality assertion written against a mistyped template would fail identically to a
// real regression, so both are shared and the specs differ only in what they put in them.
// ---------------------------------------------------------------------------

const TOPLEVEL = 'git rev-parse --show-toplevel'

const NOTICE = (session) => `ℹ️  No tmux session '${session}' running.\n`
const TERMINATED = (session) => `✅ tmux session '${session}' terminated.\n`

// An explicit sentinel for "the runner resolves with nothing", the spelling
// ../repo-session.test.js:31 uses: a literal `undefined` handed to `makeTracer` would be
// swallowed by its own defaults, which is the opposite of the case under test.
const RESOLVES_UNDEFINED = Symbol('resolves undefined')

// Every spawn recorded WHOLE — cmd, args and options — because what the specs below assert
// is the argv `stop` hands tmux and the options it hands each spawn, and the
// `${cmd} ${args}` key the runner above records carries neither. Each of the three spawns
// answers from its own knob so a spec says which shape it is driving, and an unrecognized
// spawn throws (../repo-session.test.js:40's rule), so a fourth one — or a renamed
// subcommand — fails a spec rather than passing it quietly.
function makeTracer({
  git = { exitCode: 0, stdout: '' },
  has = { exitCode: 0, stdout: '', stderr: '' },
  kill = { exitCode: 0, stdout: '', stderr: '' },
} = {}) {
  const spawns = []
  const unwrap = (r) => (r === RESOLVES_UNDEFINED ? undefined : r)
  const exec = async (cmd, args = [], options = {}) => {
    spawns.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'git' && args[0] === 'rev-parse') return unwrap(git)
    if (cmd === 'tmux' && args[0] === 'has-session') return unwrap(has)
    if (cmd === 'tmux' && args[0] === 'kill-session') return unwrap(kill)
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`)
  }
  exec.spawns = spawns
  exec.keys = () => spawns.map((s) => s.key)
  exec.of = (sub) => spawns.filter((s) => s.args[0] === sub)
  // The `-t` value AS TMUX RECEIVED IT, read off the recorded argv rather than recomputed,
  // so a spec can compare the probe's target with the kill's without naming either.
  exec.targetsOf = (sub) => exec.of(sub).map((s) => s.args[s.args.indexOf('-t') + 1])
  return exec
}

// git answering with a toplevel, spelled the way it prints one: a single
// newline-terminated line, measured by piping `git rev-parse --show-toplevel` in this repo
// through `od -c` — the repo path, then exactly one `\n`, and nothing else.
const toplevel = (root) => ({ exitCode: 0, stdout: `${root}\n` })

describe('QA stop — the name it kills is the name it probed, within one call (#168)', () => {
  // The two spawns that have to agree now sit on opposite sides of a module boundary:
  // `resolveRepoSession` spends the `has-session` (../repo-session.js:52) and `stop` spends
  // the `kill-session` (stop.js:52), both off the one `session` it destructured at
  // stop.js:45. Nothing outside this block holds them together — the module's suite never
  // sees a kill at all, and the dev's #168 specs name the expected session up front
  // (test/commands/stop.test.js:311-312), which is the one thing a spec about a MISMATCH may
  // not do.
  const ROOT = '/srv/anchored-repo'
  const SUBDIR = '/srv/anchored-repo/lib/commands'

  it('kills the exact target it probed, and prints that same target, all read off the argv', async () => {
    const stdout = makeStream()
    const exec = makeTracer({ git: toplevel(ROOT) })
    const result = await stopCommand({ cwd: SUBDIR, stdout, stderr: makeStream(), exec })
    expect(result).toEqual({ exitCode: 0, killed: true })

    const [probed] = exec.targetsOf('has-session')
    const [killed] = exec.targetsOf('kill-session')
    // A killed session that was never probed is the failure this spec exists for: `stop`
    // would report a liveness verdict about one name and destroy another.
    expect(killed).toBe(probed)
    // ...and the ✅ line is about the session that was killed, not a third derivation.
    expect(stdout.output()).toBe(TERMINATED(probed))
    // Only now, having compared the three answers against each other, is the name pinned —
    // the ROOT's, and specifically not the cwd's, which is the divergence #168 is about.
    expect(probed).toBe(sessionNameFor(ROOT))
    expect(probed).not.toBe(sessionNameFor(SUBDIR))
  })

  it('spends the kill with `{ reject: false }` and nothing else', async () => {
    // The option that makes the failure path BE a path. Measured against the execa in
    // node_modules (9.6.1): with `{ reject: false }` a `sh -c 'exit 3'` resolves as
    // `{ exitCode: 3, failed: true }`, and without it the same call throws
    // `Command failed with exit code 3`. So a kill spawned without this option would never
    // reach stop.js:53's `result.exitCode !== 0`: the raw execa error would propagate past
    // the `❌` line and past `StopAbort` to bin/ralph.js:116-120, which exits cleanly only on
    // a `StopAbort` and re-throws everything else — a sentence about tmux replaced by an
    // unhandled rejection. Asserted as the WHOLE options object, the way
    // ../repo-session.qa.test.js:272-280 asserts the module's two, so an added option is a
    // decision somebody makes here rather than one that arrives.
    const exec = makeTracer({ git: toplevel(ROOT) })
    await stopCommand({ cwd: SUBDIR, stdout: makeStream(), stderr: makeStream(), exec })
    expect(exec.of('kill-session')[0].options).toEqual({ reject: false })
  })
})

describe('QA stop — a degraded toplevel still names the CWD\'s session in the line the user reads (#168)', () => {
  // ../repo-session.test.js:102-123 pins that these shapes resolve to the cwd. What it
  // cannot pin is that the fallback name reaches `stop`'s two English lines and its kill
  // target, because the module prints nothing and kills nothing — and that fallback is the
  // whole reason the dozen pre-#168 specs in test/commands/stop.test.js could keep the
  // cwd-derived names they were written against. Two source lines produce it and each has
  // its own trap: ../repo-session.js:71 reads `probe?.exitCode`, so a result with no
  // `exitCode` at all — execa's shape for a missing binary, measured against the 9.6.1 in
  // node_modules as `{ failed: true, code: 'ENOENT' }`, with no `exitCode` key on it — and a
  // runner that resolves with nothing must both degrade rather than throw on the way to the
  // line; :72 reads `(probe.stdout || '').trim() || cwd`, so an exit-0 answer with nothing to
  // say must not hash the empty string. The user-visible promise under all of it: `ralph stop`
  // in a directory that is in no work tree still kills the loop `ralph start` opened there,
  // and still says which session it killed.
  const CWD = '/srv/plain dir/work'

  const shapes = {
    'git exited 0 with an empty toplevel': { exitCode: 0, stdout: '' },
    'git exited 0 with whitespace only': { exitCode: 0, stdout: '  \t \n' },
    'git exited 0 with no stdout property at all': { exitCode: 0 },
    'git is missing (the measured execa ENOENT shape, no exitCode)': { failed: true, code: 'ENOENT' },
    'the runner resolved with nothing': RESOLVES_UNDEFINED,
  }

  for (const [label, git] of Object.entries(shapes)) {
    it(`names the cwd-derived session on BOTH paths when ${label}`, async () => {
      const session = sessionNameFor(CWD)

      const killedOut = makeStream()
      const live = makeTracer({ git })
      const killed = await stopCommand({ cwd: CWD, stdout: killedOut, stderr: makeStream(), exec: live })
      expect(killed).toEqual({ exitCode: 0, killed: true })
      expect(live.targetsOf('has-session')).toEqual([session])
      expect(live.targetsOf('kill-session')).toEqual([session])
      expect(killedOut.output()).toBe(TERMINATED(session))

      const noticeOut = makeStream()
      const dead = makeTracer({ git, has: { exitCode: 1 } })
      const missed = await stopCommand({ cwd: CWD, stdout: noticeOut, stderr: makeStream(), exec: dead })
      expect(missed).toEqual({ exitCode: 0, killed: false })
      expect(noticeOut.output()).toBe(NOTICE(session))
      // Nothing to kill, so nothing killed — stated as the whole ordered ledger, which also
      // says the degraded resolution cost exactly one git probe and one has-session.
      expect(dead.keys()).toEqual([TOPLEVEL, `tmux has-session -t ${session}`])
    })
  }
})

describe('QA stop — the two roots that are not "a subdirectory of the repo" (#168)', () => {
  it('does not perturb the common case: a cwd that IS its own toplevel', async () => {
    // The overwhelmingly common invocation — `ralph stop` typed at the repo root — and the
    // one case where the answer cannot have changed. It earns a spec because nothing else
    // drives it: every pre-#168 spec in test/commands/stop.test.js reaches the cwd-derived
    // name through the FALLBACK, since its `makeExec` answers the toplevel probe with git's
    // out-of-repo exit 128 by default (test/commands/stop.test.js:27-31), and the #6 block
    // at the top of this file answers it with an empty exit-0 stdout. "git answered, and
    // what it answered was the cwd" is a third path into the same expected output.
    const cwd = '/srv/anchored-repo'
    const session = sessionNameFor(cwd)
    const stdout = makeStream()
    const exec = makeTracer({ git: toplevel(cwd) })
    const result = await stopCommand({ cwd, stdout, stderr: makeStream(), exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(exec.keys()).toEqual([
      TOPLEVEL,
      `tmux has-session -t ${session}`,
      `tmux kill-session -t ${session}`,
    ])
    expect(stdout.output()).toBe(TERMINATED(session))
  })

  it('follows git to a toplevel that is not an ancestor of the cwd', async () => {
    // Not hypothetical, and not hostile either: on macOS `/tmp` is a symlink to
    // `/private/tmp`, and git answers with the resolved path. Measured — in a `realrepo`
    // created under `/tmp/qa168` with a sibling symlink `linked` pointing at it,
    // `git rev-parse --show-toplevel` run from `/tmp/qa168/linked/lib` printed
    // `/private/tmp/qa168/realrepo` and exited 0. So the toplevel is a string with no
    // relationship to the cwd `stop` was handed, and `stop` has to spend it verbatim rather
    // than treat it as a prefix of, or a directory under, the one it knows.
    const cwd = '/tmp/qa168/linked/lib'
    const root = '/private/tmp/qa168/realrepo'
    const stdout = makeStream()
    const exec = makeTracer({ git: toplevel(root) })
    await stopCommand({ cwd, stdout, stderr: makeStream(), exec })
    expect(exec.targetsOf('kill-session')).toEqual([sessionNameFor(root)])
    expect(exec.targetsOf('kill-session')).not.toEqual([sessionNameFor(cwd)])
    // ...and no path reaches the terminal from either spelling. `root` is deliberately not
    // destructured at stop.js:45 and nothing `stop` prints mentions a directory, so an
    // answer about a session cannot start disagreeing with the user about where they are.
    expect(stdout.output()).not.toContain('/')
    // The label half of the name still comes from the resolved root's basename, by
    // construction (../lock.js:21) — which is the only trace of the directory there is.
    expect(stdout.output()).toContain('-realrepo-')
  })
})

describe('QA stop — one line and one tmux target, whatever the repo directory is called (#168)', () => {
  // #168 changed WHERE the string being sanitized comes from: it used to be the cwd the
  // shell handed the process, and it is now a line of another program's stdout.
  // `sessionNameFor` replaces every character outside `[A-Za-z0-9_-]` in the basename
  // (../lock.js:22, read there) and ../repo-session.qa.test.js:59-114 states the resulting
  // shape for eleven roots. What `stop` needs out of that shape is two properties
  // only its own output can be asked about: the name reaches tmux as ONE argv element —
  // where a `:` would re-point the target at a window, a `.` at a pane, and a leading `=`
  // at an exact-match target — and each printed answer stays ONE LINE, where an interior
  // newline would split a single verdict into two sentences on the user's terminal.
  const ONE_TOKEN = /^ralph-[A-Za-z0-9_-]*-[0-9a-f]{8}$/
  const CWD = '/srv/somewhere/deep'

  const roots = {
    'spaces, parentheses, a semicolon, a $ and a #': '/srv/my repo (1); rm -rf $HOME #',
    'a newline inside the directory name': '/srv/two\nlines',
    'tmux target punctuation — a colon, a dot and a leading =': '/srv/=a:b.c',
  }

  for (const [label, root] of Object.entries(roots)) {
    it(`prints one line and spends one target for a toplevel with ${label}`, async () => {
      const session = sessionNameFor(root)
      expect(session).toMatch(ONE_TOKEN)

      const killedOut = makeStream()
      const live = makeTracer({ git: toplevel(root) })
      await stopCommand({ cwd: CWD, stdout: killedOut, stderr: makeStream(), exec: live })
      // One argv element, so nothing in the name can arrive at tmux as a second argument,
      // and no shell to re-read any of it as syntax.
      expect(live.of('kill-session')[0].args).toEqual(['kill-session', '-t', session])
      expect(live.of('kill-session')[0].options.shell).toBe(undefined)
      expect(killedOut.output()).toBe(TERMINATED(session))

      const noticeOut = makeStream()
      const dead = makeTracer({ git: toplevel(root), has: { exitCode: 1 } })
      await stopCommand({ cwd: CWD, stdout: noticeOut, stderr: makeStream(), exec: dead })
      expect(noticeOut.output()).toBe(NOTICE(session))

      // The line count the two equalities above already imply, stated so it is not inferred
      // from a template literal: one trailing newline and no second line, for a root that
      // contains one.
      for (const answer of [killedOut.output(), noticeOut.output()]) {
        expect(answer.split('\n')).toHaveLength(2)
        expect(answer.endsWith('\n')).toBe(true)
      }
    })
  }
})

describe('QA stop — the kill failure line, after a root-anchored resolution (#168)', () => {
  // The #6 block at the top of this file drives this path through the cwd: its `makeExec`
  // answers every unhandled key — the toplevel probe included — with
  // `{ exitCode: 0, stdout: '' }`, so it measures the FALLBACK. The interleaving that earns
  // its own specs is a kill that fails after git DID answer, because the failure line is the
  // one thing `stop` prints that it did not derive (stop.js:54).
  const ROOT = '/srv/anchored-repo'
  const SUBDIR = '/srv/anchored-repo/lib'

  it('carries the trimmed tmux stderr, writes nothing to stdout, and aborts with exitCode 1', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    // tmux's own wording for a target it cannot find, measured by running
    // `tmux kill-session -t no-such-session-qa168` against the tmux on this machine
    // (/opt/homebrew/bin/tmux): `can't find session: <name>` on stderr, exit 1. Padded at
    // both ends here, which is what the trim is for.
    const exec = makeTracer({
      git: toplevel(ROOT),
      kill: { exitCode: 1, stdout: '', stderr: `  \n can't find session: ${sessionNameFor(ROOT)} \n\n` },
    })
    let caught
    try {
      await stopCommand({ cwd: SUBDIR, stdout, stderr, exec })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StopAbort)
    expect(caught.exitCode).toBe(1)
    expect(stderr.output()).toBe(
      `❌ Failed to kill tmux session: can't find session: ${sessionNameFor(ROOT)}\n`,
    )
    // No ✅ and no ℹ️: a kill that failed is not a termination, and it is not "no session
    // running" either — asserted as the whole stream, so a reassuring line cannot hide
    // behind a `toContain`.
    expect(stdout.output()).toBe('')
    // And the whole call, in order: one toplevel probe, one liveness probe, one kill, and no
    // retry after the failure.
    expect(exec.keys()).toEqual([
      TOPLEVEL,
      `tmux has-session -t ${sessionNameFor(ROOT)}`,
      `tmux kill-session -t ${sessionNameFor(ROOT)}`,
    ])
  })

  it('keeps an interior newline in the stderr it interpolates, which the trim cannot reach', async () => {
    // `.trim()` at stop.js:54 removes the padding at the ends and nothing in the middle, so
    // a two-line tmux error becomes a two-line `❌` answer. Pinned as the measured shape of
    // the failure line rather than argued for as a requirement: #168 moved where the SESSION
    // NAME comes from and touched nothing about this message, so a `stop` that started
    // collapsing tmux's own words would be a different change, and this is the assertion
    // that would make it announce itself.
    const stderr = makeStream()
    const exec = makeTracer({
      git: toplevel(ROOT),
      kill: { exitCode: 1, stdout: '', stderr: '\nfirst line\nsecond line\n' },
    })
    await expect(
      stopCommand({ cwd: SUBDIR, stdout: makeStream(), stderr, exec }),
    ).rejects.toBeInstanceOf(StopAbort)
    expect(stderr.output()).toBe('❌ Failed to kill tmux session: first line\nsecond line\n')
  })

  it('still prints the failure line when the kill reports no stderr property at all', async () => {
    // `(result.stderr || '')` at stop.js:54 is what makes this a line rather than a
    // `TypeError` on `undefined.trim()`. The dev's nearest spec answers with `stderr: ''`
    // (test/commands/stop.test.js:272), which exercises the `.trim()` and not the `||`.
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeTracer({ git: toplevel(ROOT), kill: { exitCode: 2 } })
    await expect(
      stopCommand({ cwd: SUBDIR, stdout, stderr, exec }),
    ).rejects.toBeInstanceOf(StopAbort)
    // The prefix and the separator survive with nothing after them, trailing space included:
    // an empty explanation, not a missing answer.
    expect(stderr.output()).toBe('❌ Failed to kill tmux session: \n')
    expect(stdout.output()).toBe('')
  })

  it('documents the asymmetry: a kill that resolves with NOTHING throws where the probes degrade', async () => {
    // The two liveness-side probes tolerate a runner that resolves with no result at all —
    // `probe?.exitCode` at ../repo-session.js:71 and :53 — and `stop`'s own kill does not:
    // stop.js:53 reads `result.exitCode` unguarded, so the same shape is a `TypeError` there.
    // #168 is what put the tolerant pair inside the module; the kill was written this way
    // before it and is unchanged. Unreachable through the CLI, on the measurements the two
    // specs above rest on: execa 9.6.1 with `{ reject: false }` resolved an execa-shaped
    // object for both failures measured here — `{ exitCode: 3, failed: true }` for a non-zero
    // exit and `{ failed: true, code: 'ENOENT' }` for a binary that does not exist — and
    // `undefined` is not a value it can hand back. bin/ralph.js:113-121 is where the cost
    // would land: it exits on a `StopAbort` and re-throws everything else. Pinned
    // so the boundary is written down rather than found by whoever injects the first runner
    // that is not execa — the way ../repo-session.qa.test.js:224-255 pins the rejecting one.
    const exec = makeTracer({ git: toplevel(ROOT), kill: RESOLVES_UNDEFINED })
    const thrown = await stopCommand({
      cwd: SUBDIR,
      stdout: makeStream(),
      stderr: makeStream(),
      exec,
    }).catch((e) => e)
    expect(thrown).toBeInstanceOf(TypeError)
    expect(thrown).not.toBeInstanceOf(StopAbort)
  })
})
