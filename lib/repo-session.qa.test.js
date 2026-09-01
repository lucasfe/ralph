import { describe, it, expect } from 'vitest'
import { resolveRepoSession } from './repo-session.js'
import { sessionNameFor } from './lock.js'

// #167 QA augmentation — the shared answer to "which tmux session belongs to this repo,
// and is it alive?". The dev's lib/repo-session.test.js pins the two-spawn ledger, six
// degradation shapes, six liveness verdicts and eight roots checked against
// `sessionNameFor`. What is attacked here is the property a CONSUMER depends on rather
// than the equality: the derived name is a value `ralph live` interpolates into English
// sentences and hands tmux as one `-t` argument, so what has to hold for every root git
// can answer with is that the name is a SINGLE TOKEN — no whitespace, and none of the
// three characters tmux itself reads as target syntax (`:` window, `.` pane, and the
// leading `=` of an exact-match target).
//
// Two more angles the dev's file does not reach: the SHAPES git's stdout can arrive in
// (CRLF, padding, more than one line, a non-string), and the boundary of "no probe
// failure becomes a throw" — which holds for every failure execa can produce with
// `{ reject: false }` (measured below) and not for a runner that rejects.
//
// Hermetic throughout: one injected `exec` that records what it was asked and answers
// with execa-shaped results, so nothing here reaches a real git or a real tmux.

const CWD = '/repo/lib/commands'
const TOPLEVEL = 'git rev-parse --show-toplevel'

// An explicit sentinel, the spelling lib/repo-session.test.js uses: a literal `undefined`
// handed to `makeExec` would be swallowed by its own default, which is the opposite of the
// case under test.
const RESOLVES_UNDEFINED = Symbol('resolves undefined')

function makeExec({ gitResult = { exitCode: 0, stdout: `/repo\n` }, tmuxResult = { exitCode: 0 } } = {}) {
  const calls = []
  const unwrap = (r) => (r === RESOLVES_UNDEFINED ? undefined : r)
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'git') {
      if (typeof gitResult === 'function') return gitResult()
      return unwrap(gitResult)
    }
    if (cmd === 'tmux') {
      if (typeof tmuxResult === 'function') return tmuxResult()
      return unwrap(tmuxResult)
    }
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`)
  }
  exec.calls = calls
  exec.of = (cmd) => calls.filter((c) => c.cmd === cmd)
  return exec
}

// The root a probe reports, fed the way git feeds it: one line, newline-terminated.
const toplevel = (root) => makeExec({ gitResult: { exitCode: 0, stdout: `${root}\n` } })

// What a tmux `-t` argument may contain and still name the session it was derived from:
// `ralph-`, then the sanitized basename, then `-` and eight hex digits of the path hash.
// Anchored, so a name with a space, a newline, a `:` or a `.` anywhere in it fails.
const ONE_TOKEN = /^ralph-[A-Za-z0-9_-]*-[0-9a-f]{8}$/

describe('QA resolveRepoSession — the derived name is one tmux target, whatever the root is (#167)', () => {
  // A repo directory can be called anything, and the name derived from it is spent in two
  // places that both need it to be a single token: `tmux ... -t <name>` (where a `:` or a
  // `.` would re-point the target at a window or a pane that was never asked for) and the
  // middle of a sentence `ralph live` prints (where a newline would split one answer into
  // two lines). `sessionNameFor` is the oracle for the value; this table is about its SHAPE.
  const roots = {
    'spaces, parentheses, a semicolon and a $': '/Users/me/repos/my repo (1); rm -rf $HOME #',
    'a command substitution': '/Users/me/repos/$(id -u)',
    'backticks': '/Users/me/repos/`whoami`',
    'both quote characters': `/Users/me/repos/it's "mine"`,
    'a newline inside the path': '/Users/me/repos/two\nlines',
    'tmux target punctuation — a colon and a dot': '/Users/me/repos/a:b.c',
    'a leading = , which tmux reads as an exact-match target': '/Users/me/repos/=exact',
    'non-ASCII letters': '/Users/me/repos/über-café',
    'a basename that is only emoji': '/Users/me/repos/🚀🚀',
    'the filesystem root': '/',
    'a 300-character basename': `/${'x'.repeat(300)}`,
  }

  for (const [label, root] of Object.entries(roots)) {
    it(`stays one token for a root with ${label}`, async () => {
      const exec = toplevel(root)
      const answer = await resolveRepoSession({ cwd: CWD, exec })
      expect(answer.root).toBe(root)
      expect(answer.session).toBe(sessionNameFor(root))
      expect(answer.session).toMatch(ONE_TOKEN)
      // ...and it reaches tmux as exactly one argv element, so nothing in it can become a
      // second argument or a shell word.
      expect(exec.of('tmux')[0].args).toEqual(['has-session', '-t', answer.session])
      expect(exec.of('tmux')[0].options.shell).toBe(undefined)
    })
  }

  it('never truncates: the name is `ralph-` + the basename + `-` + eight hex digits', async () => {
    // A LENGTH claim rather than a prefix one, because truncation is the mangle that
    // survives every regex above: a name cut short still matches ONE_TOKEN, still starts
    // with `ralph-`, and names a session that does not exist. 15 = `ralph-` (6) + `-` (1) +
    // eight hex digits (8), and the sanitizer is 1:1 on UTF-16 code units, so the basename
    // contributes its own length whatever is in it. Driven over the whole table above.
    for (const root of Object.values(roots)) {
      const basename = root.replace(/\/+$/, '').split('/').pop() || ''
      const { session } = await resolveRepoSession({ cwd: CWD, exec: toplevel(root) })
      expect(session.length, root).toBe(15 + basename.length)
    }
  })

  it('preserves the case of the directory name, which tmux compares case-sensitively', async () => {
    // `ralph-Ralph-…` and `ralph-ralph-…` are two different sessions to tmux, so a
    // lowercasing "normalization" anywhere in this path would derive a name that
    // `ralph start` never created.
    const { session } = await resolveRepoSession({ cwd: CWD, exec: toplevel('/Users/Me/Repos/Ralph') })
    expect(session).toBe(sessionNameFor('/Users/Me/Repos/Ralph'))
    expect(session).toContain('-Ralph-')
  })
})

describe('QA resolveRepoSession — the shapes git\'s stdout can arrive in (#167)', () => {
  // `git rev-parse --show-toplevel` prints one newline-terminated line, which the dev's
  // file covers. These are the shapes a shell, a wrapper on PATH or a hostile hook can put
  // in front of it — and the requirement is the same for all of them: either a usable root
  // or the cwd fallback, never a root with a stray byte in it, because the byte would land
  // in the hash and in the printed name.
  const shapes = {
    'a CRLF line ending': ['/repo\r\n', '/repo'],
    'trailing spaces and a tab': ['/repo \t \n', '/repo'],
    'leading whitespace': ['  /repo\n', '/repo'],
    'no line ending at all': ['/repo', '/repo'],
    'a blank line after the toplevel': ['/repo\n\n', '/repo'],
  }

  for (const [label, [stdout, root]] of Object.entries(shapes)) {
    it(`reads the root off ${label}`, async () => {
      const exec = makeExec({ gitResult: { exitCode: 0, stdout } })
      const answer = await resolveRepoSession({ cwd: CWD, exec })
      expect(answer.root).toBe(root)
      expect(answer.session).toBe(sessionNameFor(root))
    })
  }

  it('cannot turn a multi-line answer into a second tmux argument', async () => {
    // Two lines is not a shape git produces, so the interesting question is not which line
    // wins but whether the extra one can escape: the root keeps the newline (`.trim()` only
    // touches the ends), and the derived name still has to be one token in one argv element.
    const exec = makeExec({ gitResult: { exitCode: 0, stdout: '/repo\n/tmp\n' } })
    const answer = await resolveRepoSession({ cwd: CWD, exec })
    expect(answer.root).toBe('/repo\n/tmp')
    expect(answer.session).toMatch(ONE_TOKEN)
    expect(exec.of('tmux')[0].args).toEqual(['has-session', '-t', answer.session])
  })

  it('falls back to the cwd when stdout is a falsy non-string', async () => {
    // `(probe.stdout || '')` is what makes this the fallback rather than a crash — a `0`
    // has no `.trim()`.
    const answer = await resolveRepoSession({ cwd: CWD, exec: makeExec({ gitResult: { exitCode: 0, stdout: 0 } }) })
    expect(answer.root).toBe(CWD)
  })

  it('documents the gap: a TRUTHY non-string stdout throws instead of falling back', async () => {
    // The boundary of the degradation table. `(probe.stdout || '').trim()` reaches `.trim`
    // on the value itself, so a Buffer or an array has none and the call rejects with a
    // TypeError rather than degrading to the cwd. Not reachable through `ralph live`: the
    // only runner it passes is execa, which returns a string unless a caller asks for
    // `encoding: 'buffer'` or `lines: true`, and nothing in lib/ does. Pinned so the shape
    // of the boundary is written down rather than discovered by whoever adds the first
    // caller that does.
    const buffer = await resolveRepoSession({
      cwd: CWD,
      exec: makeExec({ gitResult: { exitCode: 0, stdout: Buffer.from('/repo\n') } }),
    }).catch((e) => e)
    expect(buffer).toBeInstanceOf(TypeError)
    const lines = await resolveRepoSession({
      cwd: CWD,
      exec: makeExec({ gitResult: { exitCode: 0, stdout: ['/repo'] } }),
    }).catch((e) => e)
    expect(lines).toBeInstanceOf(TypeError)
  })

  it('documents the gap: a directory name that ENDS in whitespace loses it to the trim', async () => {
    // `.trim()` cannot tell git's line ending from the last character of a legal directory
    // name, so a repo at `/repo/my dir ` (trailing space, which POSIX allows) resolves to
    // `/repo/my dir` and hashes to a different session than the one a cwd-keyed command
    // derives for the same repo — `ralph start` at that path opens `sessionNameFor(cwd)`
    // (start.js:679). Both names are single tokens, so nothing breaks loudly; the run is
    // simply invisible to `ralph live`. Pinned as the known cost of the trim.
    const padded = '/repo/my dir '
    const { root, session } = await resolveRepoSession({ cwd: CWD, exec: toplevel(padded) })
    expect(root).toBe('/repo/my dir')
    expect(session).not.toBe(sessionNameFor(padded))
  })

  it('documents the gap: a trailing slash in the root is a different session', async () => {
    // The hash is over the path AS GIVEN while the basename is taken after stripping
    // trailing slashes, so `/repo/` and `/repo` share a label and not a hash. git only ever
    // prints a trailing slash for a repo at the filesystem root (`/`), where there is no
    // second spelling to disagree with — which is why this is a gap and not a defect.
    const withSlash = await resolveRepoSession({ cwd: CWD, exec: toplevel('/repo/') })
    const without = await resolveRepoSession({ cwd: CWD, exec: toplevel('/repo') })
    expect(withSlash.session).toBe(sessionNameFor('/repo/'))
    expect(withSlash.session).not.toBe(without.session)
    expect(withSlash.session.startsWith('ralph-repo-')).toBe(true)
    expect(without.session.startsWith('ralph-repo-')).toBe(true)
  })
})

describe('QA resolveRepoSession — liveness is the exit code, strictly (#167)', () => {
  const verdicts = {
    'a numeric 0': [{ exitCode: 0 }, true],
    'a STRING zero, which is not an exit code': [{ exitCode: '0' }, false],
    'a negative code': [{ exitCode: -1 }, false],
    'a code far outside the 0-255 range': [{ exitCode: 4294967296 }, false],
    'a signal death with no code': [{ exitCode: undefined, signal: 'SIGKILL', failed: true }, false],
    'a 0 alongside an execa `failed` flag': [{ exitCode: 0, failed: true }, true],
  }

  for (const [label, [tmuxResult, alive]] of Object.entries(verdicts)) {
    it(`reports alive=${alive} for ${label}`, async () => {
      const answer = await resolveRepoSession({ cwd: CWD, exec: makeExec({ tmuxResult }) })
      expect(answer.alive).toBe(alive)
      // A boolean, never the truthy value itself: `ralph live` branches on it.
      expect(typeof answer.alive).toBe('boolean')
    })
  }
})

describe('QA resolveRepoSession — the boundaries of "no probe failure becomes a throw" (#167)', () => {
  it('documents the gap: a runner that REJECTS is not caught here', async () => {
    // `{ reject: false }` is the whole guard, and it covers every failure execa can produce:
    // measured against execa 9, a missing binary resolves as
    // `{ failed: true, code: 'ENOENT', exitCode: undefined }` and a non-executable target as
    // the same shape with `code: 'EACCES'` — neither raises. So a rejection needs a runner
    // that is not execa, or an execa spawn that fails before the child exists (a fork that
    // hits EAGAIN). There is no try/catch on either probe, so it propagates — unlike
    // start.js:1147-1152, which wraps its own tmux spawn for exactly this case. Through
    // `ralph live` the consequence is a stack trace instead of a named refusal, because
    // bin/ralph.js re-throws anything that is not a LiveAbort.
    const boom = new Error('spawn EAGAIN')
    const gitThrows = await resolveRepoSession({
      cwd: CWD,
      exec: makeExec({
        gitResult: () => {
          throw boom
        },
      }),
    }).catch((e) => e)
    expect(gitThrows).toBe(boom)

    const tmuxThrows = await resolveRepoSession({
      cwd: CWD,
      exec: makeExec({
        tmuxResult: () => {
          throw boom
        },
      }),
    }).catch((e) => e)
    expect(tmuxThrows).toBe(boom)
  })

  it('documents the gap: with no cwd AND no toplevel there is nothing to hash', async () => {
    // `exec` has no default by design and `cwd` has none either, so the fallback root of a
    // call with neither is `undefined` — which `sessionNameFor` dereferences. Unreachable
    // through `ralph live` (liveCommand defaults `cwd` to `process.cwd()`), and reachable
    // for a caller that forgets it only on the DEGRADED path, which is the trap: the same
    // call works whenever git answers.
    const noCwd = await resolveRepoSession({ exec: makeExec({ gitResult: { exitCode: 128, stdout: '' } }) }).catch(
      (e) => e,
    )
    expect(noCwd).toBeInstanceOf(TypeError)
    const answered = await resolveRepoSession({ exec: toplevel('/repo') })
    expect(answered.root).toBe('/repo')
    expect(answered.session).toBe(sessionNameFor('/repo'))
  })

  it('runs the toplevel probe with the cwd and nothing else in its options', async () => {
    // A read-only probe on the critical path of an interactive command: no `stdio`, no
    // `shell`, no `timeout`, no environment of its own. Asserted as the whole options object
    // rather than key by key, so an added option is a decision somebody makes here.
    const exec = makeExec()
    await resolveRepoSession({ cwd: CWD, exec })
    expect(exec.of('git')[0].options).toEqual({ cwd: CWD, reject: false })
    expect(exec.of('tmux')[0].options).toEqual({ reject: false })
  })
})
