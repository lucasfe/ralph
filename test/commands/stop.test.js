import { describe, it, expect } from 'vitest'
import { stopCommand, StopAbort } from '../../lib/commands/stop.js'
import { sessionNameFor } from '../../lib/lock.js'

// Per-project session name used across the suite. stopCommand resolves its session
// through lib/repo-session.js (#168), which anchors on the git toplevel and falls back to
// the cwd when there is no toplevel to anchor on; tests default to cwd '/repo'.
//
// #168 IS WHY EVERY CALL LIST IN THIS FILE OPENS WITH A GIT PROBE. `stopCommand` used to
// spell its own `sessionNameFor(cwd)` and spend exactly one spawn before the kill; it now
// calls `resolveRepoSession` (lib/repo-session.js:46-54), whose first act is
// `git rev-parse --show-toplevel` (repo-session.js:70). Any git-anchored resolution costs
// that spawn, so the four places here that pin the exact ordered call list — three
// `exec.calls` ledgers and the `targets` one below — grew one entry each. Deliberately kept
// exact rather than relaxed to a `filter`, because the count is what says `stop` still
// spends ONE `has-session` (the module's) and never a second one of its own. Nothing about
// what `stop` prints, returns or exits with moved with them.
const SESSION = sessionNameFor('/repo')

const TOPLEVEL = 'git rev-parse --show-toplevel'

// The default answer to that probe: a directory that is not in a work tree. Exit 128 and
// git's own `fatal:` wording, both measured by running `git rev-parse --show-toplevel` in
// /tmp. This is the degradation lib/repo-session.js:71 turns into the cwd fallback, so
// every test that says nothing about git keeps the cwd-derived session name it asserted
// before #168 — which is why the specs below could stay pointed at the same names.
const NOT_A_REPO = {
  exitCode: 128,
  stdout: '',
  stderr: 'fatal: not a git repository (or any of the parent directories): .git',
}

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

function makeExec(handlers, { git = NOT_A_REPO } = {}) {
  const calls = []
  const spawns = []
  const exec = async (cmd, args, options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    // The whole spawn, options included, alongside the key list the assertions below are
    // written against: the toplevel probe has to run IN the caller's cwd, and a key string
    // cannot say whether it did.
    spawns.push({ key, cmd, args, options })
    // The toplevel probe is answered by its own knob rather than by `handlers`, so a test
    // about the git anchor says so explicitly and every other test keeps its handler map
    // exactly as it was written.
    if (key === TOPLEVEL) return git
    if (handlers[key]) return handlers[key]
    throw new Error(`unexpected exec: ${key}`)
  }
  exec.calls = calls
  exec.spawns = spawns
  return exec
}

describe('stopCommand', () => {
  it('reports no session when tmux has-session fails', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd: '/repo', stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: false })
    expect(stdout.output()).toContain(`No tmux session '${SESSION}'`)
  })

  it('kills the session when present', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd: '/repo', stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(stdout.output()).toContain(`tmux session '${SESSION}' terminated`)
  })

  it('throws StopAbort when kill-session fails', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: 'boom' },
    })
    await expect(
      stopCommand({ cwd: '/repo', stdout, stderr, exec }),
    ).rejects.toBeInstanceOf(StopAbort)
    expect(stderr.output()).toContain('Failed to kill tmux session')
  })

  it('targets the cwd-derived session name, not the literal "ralph"', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    await stopCommand({ cwd: '/repo', stdout, stderr, exec })
    expect(exec.calls).toContain(`tmux has-session -t ${SESSION}`)
    expect(exec.calls).toContain(`tmux kill-session -t ${SESSION}`)
    expect(exec.calls.some((c) => c === 'tmux has-session -t ralph')).toBe(false)
    expect(exec.calls.some((c) => c === 'tmux kill-session -t ralph')).toBe(false)
  })

  it('stops only the current project, leaving other projects untouched', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const otherSession = sessionNameFor('/other-project')
    const workSession = sessionNameFor('/work')
    const exec = makeExec({
      [`tmux has-session -t ${workSession}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${workSession}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd: '/work', stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(stdout.output()).toContain(`tmux session '${workSession}' terminated`)
    // Never touches another project's session.
    expect(exec.calls.some((c) => c.includes(otherSession))).toBe(false)
  })

  // --- QA: edge cases & adversarial scenarios -------------------------------

  it('uses a valid, consistent session name for a cwd with spaces/parens', async () => {
    const cwd = '/Users/x/my repo (1)'
    const session = sessionNameFor(cwd)
    // sessionNameFor must sanitize away spaces/parens so the name is a safe
    // tmux target (no characters tmux would misinterpret).
    expect(session).toMatch(/^[A-Za-z0-9_-]+$/)
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd, stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    // Both tmux calls target the identical derived name (no has/kill mismatch), after the
    // toplevel probe #168 put in front of them.
    expect(exec.calls).toEqual([
      TOPLEVEL,
      `tmux has-session -t ${session}`,
      `tmux kill-session -t ${session}`,
    ])
  })

  it('uses the same derived name for has-session and kill-session within one call', async () => {
    // Adversarial: a mismatch between the two would mean checking one session
    // and killing another. Assert internal consistency by capturing the raw
    // session targets passed to exec rather than precomputing them.
    const cwd = '/some/deep/nested/project'
    const stdout = makeStream()
    const stderr = makeStream()
    const targets = []
    const exec = async (cmd, args) => {
      // args = ['rev-parse', '--show-toplevel'] for the git probe #168 added, then
      // ['has-session'|'kill-session', '-t', <session>] for the two tmux calls. This runner
      // answers exit 0 with an empty stdout to everything, so the toplevel is empty and
      // lib/repo-session.js:72 falls back to the cwd — which is why the expected name below
      // is still `sessionNameFor(cwd)`.
      targets.push({ cmd, sub: args[0], session: args[2] })
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const result = await stopCommand({ cwd, stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(targets).toHaveLength(3)
    expect(targets[0]).toEqual({ cmd: 'git', sub: 'rev-parse', session: undefined })
    expect(targets[1].sub).toBe('has-session')
    expect(targets[2].sub).toBe('kill-session')
    expect(targets[1].session).toBe(targets[2].session)
    expect(targets[1].session).toBe(sessionNameFor(cwd))
  })

  it('trailing-slash and clean cwd are internally consistent (each call self-consistent)', async () => {
    // NOTE: in the current impl sessionNameFor('/repo') !== sessionNameFor('/repo/')
    // because the hash is over the full (unnormalized) path. This test does not
    // assert they are equal; it asserts each call uses ONE name consistently.
    for (const cwd of ['/repo', '/repo/']) {
      const session = sessionNameFor(cwd)
      const stdout = makeStream()
      const stderr = makeStream()
      const exec = makeExec({
        [`tmux has-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
        [`tmux kill-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
      })
      const result = await stopCommand({ cwd, stdout, stderr, exec })
      expect(result).toEqual({ exitCode: 0, killed: true })
      expect(exec.calls).toEqual([
        TOPLEVEL,
        `tmux has-session -t ${session}`,
        `tmux kill-session -t ${session}`,
      ])
    }
  })

  it('defaults cwd to process.cwd() when omitted', async () => {
    const session = sessionNameFor(process.cwd())
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    // cwd intentionally omitted -> should resolve via process.cwd().
    const result = await stopCommand({ stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(exec.calls).toContain(`tmux has-session -t ${session}`)
    expect(exec.calls).toContain(`tmux kill-session -t ${session}`)
  })

  it('treats a non-zero, non-1 has-session exit (e.g. 127 / tmux missing) as no session', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: {
        exitCode: 127,
        stdout: '',
        stderr: 'tmux: command not found',
      },
      // Deliberately NO kill-session handler: makeExec throws on unexpected
      // calls, so if stopCommand attempted a kill this test would error out.
    })
    const result = await stopCommand({ cwd: '/repo', stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: false })
    expect(exec.calls).toEqual([TOPLEVEL, `tmux has-session -t ${SESSION}`])
    expect(exec.calls.some((c) => c.startsWith('tmux kill-session'))).toBe(false)
    expect(stdout.output()).toContain(`No tmux session '${SESSION}'`)
  })

  it('StopAbort on kill failure carries exitCode 1 and reports the stderr', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: {
        exitCode: 1,
        stdout: '',
        stderr: '  permission denied  ',
      },
    })
    let caught
    try {
      await stopCommand({ cwd: '/repo', stdout, stderr, exec })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StopAbort)
    expect(caught.exitCode).toBe(1)
    // stderr surfaced to the user (trimmed).
    expect(stderr.output()).toContain('permission denied')
    expect(stderr.output()).toContain('Failed to kill tmux session')
    // No success message emitted.
    expect(stdout.output()).not.toContain('terminated')
  })

  it('does not emit a kill message when kill-session fails', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: { exitCode: 2, stdout: '', stderr: '' },
    })
    await expect(
      stopCommand({ cwd: '/repo', stdout, stderr, exec }),
    ).rejects.toBeInstanceOf(StopAbort)
    // Even with empty stderr, the failure message is still printed.
    expect(stderr.output()).toContain('Failed to kill tmux session')
  })
})

// ---------------------------------------------------------------------------
// #168 — the session belongs to the REPO, not to the directory you typed the
// command in. Everything above this line drives a cwd that is its own toplevel (or a
// directory in no repo at all), which is the only state in which the two answers agree.
// ---------------------------------------------------------------------------

describe('stopCommand — the session is the git toplevel\'s, not the cwd\'s (#168)', () => {
  const ROOT = '/repo'
  const SUBDIR = '/repo/lib'
  const ROOT_SESSION = sessionNameFor(ROOT)
  const SUBDIR_SESSION = sessionNameFor(SUBDIR)

  // A repo whose toplevel git will report, spelled the way git prints it: one
  // newline-terminated line.
  const inRepo = (handlers) => makeExec(handlers, { git: { exitCode: 0, stdout: `${ROOT}\n` } })

  it('kills the ROOT-derived session when run from a subdirectory of the repo', async () => {
    // THE BUG #168 IS ABOUT. `sessionNameFor` hashes the path it is handed, so `/repo` and
    // `/repo/lib` are two different session names for one loop: before the fix, `ralph stop`
    // typed in `lib/` probed a name no session had, printed `ℹ️  No tmux session '…'
    // running.`, exited 0, and left the loop running.
    //
    // Stated as an assertion first so this spec cannot pass vacuously: if the two names were
    // ever equal the rest of the test would hold whichever path `stop` hashed.
    expect(SUBDIR_SESSION).not.toBe(ROOT_SESSION)

    const stdout = makeStream()
    const stderr = makeStream()
    const exec = inRepo({
      [`tmux has-session -t ${ROOT_SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${ROOT_SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      // No handler for either SUBDIR-derived name on purpose: `makeExec` throws on a key it
      // was not given, so a cwd-keyed `stop` fails this test loudly instead of quietly
      // killing nothing.
    })
    const result = await stopCommand({ cwd: SUBDIR, stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(exec.calls).toEqual([
      TOPLEVEL,
      `tmux has-session -t ${ROOT_SESSION}`,
      `tmux kill-session -t ${ROOT_SESSION}`,
    ])
    // ...and the line the user reads names the session that was actually killed.
    expect(stdout.output()).toContain(`✅ tmux session '${ROOT_SESSION}' terminated.`)
    expect(stdout.output()).not.toContain(SUBDIR_SESSION)
    // ONE liveness probe, the module's. `resolveRepoSession` already spends a `has-session`
    // (lib/repo-session.js:52) and returns its verdict as `alive`, so a `stop` that also
    // kept its own inline probe would ask tmux the same question twice.
    expect(exec.calls.filter((c) => c.startsWith('tmux has-session'))).toHaveLength(1)
  })

  it('names the ROOT-derived session in the no-session notice from a subdirectory', async () => {
    // The other half of the same fix: when there really is no loop, the notice has to name
    // the session the repo WOULD have — otherwise the honest answer is about a name nobody
    // ever created.
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = inRepo({
      [`tmux has-session -t ${ROOT_SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd: SUBDIR, stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: false })
    expect(stdout.output()).toBe(`ℹ️  No tmux session '${ROOT_SESSION}' running.\n`)
    expect(stderr.output()).toBe('')
    // No kill after a miss, and no second probe either.
    expect(exec.calls).toEqual([TOPLEVEL, `tmux has-session -t ${ROOT_SESSION}`])
  })

  it('runs the toplevel probe IN the cwd it was handed', async () => {
    // `git rev-parse` answers about the process's own working directory unless it is told
    // otherwise, so a probe without this option would report the toplevel of whatever
    // directory the vitest worker happens to be in — a different repo's session name, or
    // none. `reject: false` alongside it, since a directory in no work tree is an ordinary
    // answer here and not an exception.
    const exec = inRepo({
      [`tmux has-session -t ${ROOT_SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${ROOT_SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    await stopCommand({ cwd: SUBDIR, stdout: makeStream(), stderr: makeStream(), exec })
    const probe = exec.spawns[0]
    expect(probe.key).toBe(TOPLEVEL)
    expect(probe.options.cwd).toBe(SUBDIR)
    expect(probe.options.reject).toBe(false)
  })

  it('falls back to the cwd-derived session outside any git repo', async () => {
    // Unchanged behaviour, stated rather than assumed: a directory in no work tree gets the
    // session name `stop` derived before #168, so `ralph stop` in a plain directory still
    // kills the loop `ralph start` opened there. `NOT_A_REPO` is git's real answer for that
    // case (exit 128), which is what the file's default is too.
    const cwd = '/tmp/not-a-repo'
    const session = sessionNameFor(cwd)
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec(
      {
        [`tmux has-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
        [`tmux kill-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
      },
      { git: NOT_A_REPO },
    )
    const result = await stopCommand({ cwd, stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(exec.calls).toEqual([
      TOPLEVEL,
      `tmux has-session -t ${session}`,
      `tmux kill-session -t ${session}`,
    ])
    expect(stdout.output()).toBe(`✅ tmux session '${session}' terminated.\n`)
    expect(stderr.output()).toBe('')
  })
})
