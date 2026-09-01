import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveRepoSession } from './repo-session.js'
import { sessionNameFor } from './lock.js'

// #167 — the one place that answers "which tmux session belongs to this repo, and is
// it alive?". Three commands still ask it inline (status.js:313, cycle.js:148 and
// stop.js:24), each with its own spelling of the root, which is how `ralph stop` is keyed
// on the CWD while `ralph cycle` is keyed on the git toplevel — two different sessions for
// one repo, depending on which directory you are standing in. `ralph live` is this module's
// first consumer and #168 is where `ralph stop` moves onto it; nothing has been taken away
// from the three yet.
//
// Hermetic throughout: every spawn goes through an injected `exec` that records what it
// was asked and answers with execa-shaped results, so nothing here reaches a real git or
// a real tmux. The failure shapes are execa's own — with `{ reject: false }` a missing
// binary resolves as `{ failed: true, exitCode: undefined }` rather than throwing
// (measured against execa 9), so the doubles below answer that rather than raising.

const ROOT = '/repo'
const SUBDIR = '/repo/lib/commands'

const TOPLEVEL = 'git rev-parse --show-toplevel'
const hasSession = (session) => `tmux has-session -t ${session}`

// An explicit sentinel for "the call resolves with nothing", the way
// lib/commands/status.qa.test.js spells it: a literal `undefined` handed to `makeExec`
// would be swallowed by its own defaults, which is the opposite of the case under test.
const RESOLVES_UNDEFINED = Symbol('resolves undefined')

function makeExec({ gitResult = { exitCode: 0, stdout: `${ROOT}\n` }, tmuxResult = { exitCode: 0 } } = {}) {
  const calls = []
  const unwrap = (r) => (r === RESOLVES_UNDEFINED ? undefined : r)
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'git') return unwrap(gitResult)
    if (cmd === 'tmux') return unwrap(tmuxResult)
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`)
  }
  exec.calls = calls
  exec.of = (cmd) => calls.filter((c) => c.cmd === cmd)
  return exec
}

describe('resolveRepoSession — the repo root, the session name and its liveness (#167)', () => {
  it('answers all three from one call, anchored on the git toplevel', async () => {
    const exec = makeExec()
    const answer = await resolveRepoSession({ cwd: SUBDIR, exec })
    expect(answer).toEqual({ root: ROOT, session: sessionNameFor(ROOT), alive: true })
  })

  it('spends exactly two spawns: the toplevel probe, then one has-session', async () => {
    // Both are read-only and both are on the critical path of a command a user runs
    // interactively, so the COUNT is asserted rather than the mere presence of a call —
    // a second liveness probe BEFORE the attach is how a `ralph live` that agrees with
    // itself turns into one that can attach to a session it just reported dead. (`ralph
    // live` does ask again AFTER the attach, about a later moment — that probe is its own,
    // inline, and not this module's business.)
    const exec = makeExec()
    await resolveRepoSession({ cwd: SUBDIR, exec })
    expect(exec.calls.map((c) => c.key)).toEqual([TOPLEVEL, hasSession(sessionNameFor(ROOT))])
  })

  it('runs the toplevel probe IN the working directory it was handed', async () => {
    // The whole point of the git anchor: `git rev-parse` answers about the process's
    // own cwd unless it is told otherwise, so a probe without this option would report
    // the toplevel of whatever directory the vitest worker (or the user's shell before
    // a `cd`) happens to be in.
    const exec = makeExec()
    await resolveRepoSession({ cwd: SUBDIR, exec })
    expect(exec.of('git')[0].options.cwd).toBe(SUBDIR)
    expect(exec.of('git')[0].options.reject).toBe(false)
  })

  it('never lets a probe failure become a throw', async () => {
    // `{ reject: false }` on both spawns, so neither a repo-less directory nor a
    // missing binary reaches the caller as an exception.
    const exec = makeExec()
    await resolveRepoSession({ cwd: SUBDIR, exec })
    for (const call of exec.calls) expect(call.options.reject).toBe(false)
  })

  it('trims the newline git prints after the toplevel', async () => {
    const exec = makeExec({ gitResult: { exitCode: 0, stdout: '/Users/me/repos/ralph\n' } })
    const answer = await resolveRepoSession({ cwd: SUBDIR, exec })
    expect(answer.root).toBe('/Users/me/repos/ralph')
    // ...and the trimmed root is what the session was derived from, not the raw stdout.
    expect(answer.session).toBe(sessionNameFor('/Users/me/repos/ralph'))
  })

  it('passes the derived session as a single argv element, never through a shell', async () => {
    const exec = makeExec()
    await resolveRepoSession({ cwd: SUBDIR, exec })
    const probe = exec.of('tmux')[0]
    expect(probe.args).toEqual(['has-session', '-t', sessionNameFor(ROOT)])
    expect(probe.options.shell).toBe(undefined)
  })
})

describe('resolveRepoSession — the root falls back to the cwd outside a git repo (#167)', () => {
  const degradations = {
    'git exited non-zero (not a work tree)': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' },
    'git is not installed (execa ENOENT shape)': { failed: true },
    'git answered with nothing at all': RESOLVES_UNDEFINED,
    'git exited 0 with no stdout property': { exitCode: 0 },
    'git exited 0 with an empty toplevel': { exitCode: 0, stdout: '' },
    'git exited 0 with whitespace only': { exitCode: 0, stdout: '  \n ' },
  }

  for (const [label, gitResult] of Object.entries(degradations)) {
    it(`uses the cwd when ${label}`, async () => {
      const exec = makeExec({ gitResult })
      const answer = await resolveRepoSession({ cwd: SUBDIR, exec })
      expect(answer.root).toBe(SUBDIR)
      // And the session follows the fallback root, so the probe and any message a
      // caller prints name the same session.
      expect(answer.session).toBe(sessionNameFor(SUBDIR))
      expect(exec.of('tmux')[0].args).toEqual(['has-session', '-t', sessionNameFor(SUBDIR)])
    })
  }
})

describe('resolveRepoSession — liveness is one has-session exit code (#167)', () => {
  const verdicts = {
    'tmux exited 0': [{ exitCode: 0 }, true],
    'tmux exited 1 (no such session)': [{ exitCode: 1, stderr: "can't find session" }, false],
    'tmux exited 127 (not installed)': [{ exitCode: 127, stderr: 'tmux: command not found' }, false],
    'tmux is not installed (execa ENOENT shape)': [{ failed: true }, false],
    'tmux answered with nothing at all': [RESOLVES_UNDEFINED, false],
    'tmux timed out': [{ timedOut: true, failed: true }, false],
  }

  for (const [label, [tmuxResult, alive]] of Object.entries(verdicts)) {
    it(`reports alive=${alive} when ${label}`, async () => {
      const exec = makeExec({ tmuxResult })
      expect((await resolveRepoSession({ cwd: SUBDIR, exec })).alive).toBe(alive)
    })
  }

  it('keys on the exit code and never on tmux output text', async () => {
    // A CLI is free to reword or localise what it prints; the exit code is the part it
    // promises. Same rule lib/jira-auth.js states for `acli`.
    const exec = makeExec({ tmuxResult: { exitCode: 0, stdout: "can't find session: ralph-x" } })
    expect((await resolveRepoSession({ cwd: SUBDIR, exec })).alive).toBe(true)
  })
})

describe('resolveRepoSession — the session name is lib/lock.js\'s, byte for byte (#167)', () => {
  // The acceptance criterion this file exists for: this module must not learn a second
  // way to spell a session name. Asserted against `sessionNameFor` itself for every
  // shape of directory name a repo can have — the hostile ones included, since a repo
  // directory can be called anything — rather than against a literal, so a change to
  // the derivation moves both sides at once and a REIMPLEMENTATION here moves only one.
  const roots = [
    '/repo',
    '/Users/me/repos/ralph',
    '/Users/me/repos/some.weird repo',
    '/Users/me/repos/my repo (1)',
    '/Users/me/repos/ralph; rm -rf $HOME #',
    '/Users/me/repos/über-café',
    '/repo/',
    '/',
  ]

  for (const root of roots) {
    it(`derives sessionNameFor(${JSON.stringify(root)}) exactly`, async () => {
      const exec = makeExec({ gitResult: { exitCode: 0, stdout: `${root}\n` } })
      const answer = await resolveRepoSession({ cwd: SUBDIR, exec })
      expect(answer.session).toBe(sessionNameFor(answer.root))
      // Byte-identical, stated as bytes rather than as string equality alone: this is
      // the name a tmux target is spelled with.
      expect([...answer.session]).toEqual([...sessionNameFor(answer.root)])
    })
  }

  it('derives it from the RESOLVED root, never from the cwd it was handed', async () => {
    // What makes `ralph live` work from `lib/` or `test/`: two different subdirectories
    // of one repo have to reach one session. Both cwds are non-empty and different, so
    // a module keyed on the cwd would answer two names here.
    const fromRoot = await resolveRepoSession({ cwd: ROOT, exec: makeExec() })
    const fromSubdir = await resolveRepoSession({ cwd: SUBDIR, exec: makeExec() })
    expect(fromSubdir.session).toBe(fromRoot.session)
    expect(fromSubdir.session).toBe(sessionNameFor(ROOT))
    expect(fromSubdir.session).not.toBe(sessionNameFor(SUBDIR))
  })
})

describe('resolveRepoSession — what it deliberately cannot reach (#167)', () => {
  const SOURCE = readFileSync(fileURLToPath(new URL('./repo-session.js', import.meta.url)), 'utf8')

  it('imports the session-name helper and nothing else', async () => {
    // #167 scopes this module to two questions, and the import list is the honest way
    // to ask whether it stayed there — a claim about the source, which is the kind of
    // claim a sweep may make (CONTRIBUTING.md, "What a static source sweep may be
    // asked"). What it rules out, in one assertion: `.ralph/run-state.json` (whose
    // recorded session `ralph status` prefers, and which a stale or half-written file
    // can contradict), the cycle lock's `peekLock` — exported by the very module this
    // one does import, so nothing but the named-import list distinguishes them — and
    // any filesystem at all, since neither question is answered on disk.
    const imports = [...SOURCE.matchAll(/^import .*$/gm)].map((m) => m[0])
    expect(imports).toEqual(["import { sessionNameFor } from './lock.js'"])
  })

  it('spawns nothing but git and tmux', async () => {
    // The behavioural half of the same claim: `makeExec` throws on any other binary,
    // so a third spawn would fail this file rather than pass it quietly.
    const exec = makeExec()
    await resolveRepoSession({ cwd: SUBDIR, exec })
    expect([...new Set(exec.calls.map((c) => c.cmd))]).toEqual(['git', 'tmux'])
  })
})
