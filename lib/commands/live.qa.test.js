import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { liveCommand, LiveAbort } from './live.js'
import { startCommand } from './start.js'
import { stopCommand } from './stop.js'
import { sessionNameFor } from '../lock.js'
import { codeWithoutComments } from '../../test/helpers/source-code.js'

// #167 QA augmentation — `ralph live`. The dev's lib/commands/live.test.js drives all five
// steps of the decision order, the `$TMUX` and TTY halves, tmux's exit codes and the
// hostile-path interpolation. What is attacked here is what the dev's file asserts one path
// at a time and never as a LEDGER, plus three things it does not reach at all:
//
//   1. WHAT EACH PATH SPENDS AND SAYS, as one table per invariant rather than one
//      assertion per test. Three of the four spawns are read-only and one is not, so "which
//      spawns happened, in which order" is the safety property of this command; step 3 exists
//      because stdout may be a pipe, so "no refusal writes a byte to stdout" is the reason
//      the whole refusal surface is on stderr.
//   2. THE DEFAULT `processEnv`, which every test in the dev's file overrides. The default
//      is `process.env`, and #167 added `TMUX` to test/setup/hermetic-env.js precisely so
//      that a developer running this suite from inside the tmux window `ralph start` opened
//      does not silently take the inside-tmux branch. Nothing exercises that entry unless a
//      test lets the default stand, so two tests here do.
//   3. WHETHER THE SESSION `ralph live` DERIVES IS THE ONE THE OTHER TWO COMMANDS USE,
//      driven through `startCommand` and `stopCommand` rather than reasoned about.
//
// Hermetic throughout: injected `exec`, injected streams, an injected environment bag and
// an injected `hasCommand`, so nothing here reaches a real tmux, a real git or a real
// terminal. Three process spawns are the exception — `node bin/ralph.js --help`,
// `live --foo` and `stop --foo` — and commander answers all three itself, before either
// command's action runs, so none of them can reach a session on the machine running this.

const REPO = '/repo'
const SUBDIR = '/repo/lib/commands'
const SESSION = sessionNameFor(REPO)

const TOPLEVEL = 'git rev-parse --show-toplevel'
const HAS = `tmux has-session -t ${SESSION}`
const ATTACH = `tmux attach -t ${SESSION}`

function makeStream(extra = {}) {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
    // Every write here is one `msg + '\n'`, so the trailing empty element is the line
    // terminator of the last line and not a line of its own.
    lines: () => (chunks.length === 0 ? [] : chunks.join('').split('\n').slice(0, -1)),
    ...extra,
  }
}

// `has-session` is asked twice on the attach path, about two different moments: before the
// attach ("is there anything to attach to") and after it ("did the session outlive the
// client"). `hasSessionAfterAttach` defaults to the first answer, so a row that says nothing
// about it gets the ordinary case — a detach from a loop that carries on.
function makeExec({
  gitResult = { exitCode: 0, stdout: `${REPO}\n` },
  hasSessionResult = { exitCode: 0 },
  hasSessionAfterAttach = hasSessionResult,
  attachResult = { exitCode: 0 },
} = {}) {
  const calls = []
  let attached = false
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'git') return gitResult
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return attached ? hasSessionAfterAttach : hasSessionResult
    }
    if (cmd === 'tmux' && args[0] === 'attach') {
      attached = true
      return attachResult
    }
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`)
  }
  exec.calls = calls
  exec.keys = () => calls.map((c) => c.key)
  exec.at = (key) => calls.find((c) => c.key === key)
  return exec
}

// The one state that reaches the attach: tmux installed, outside tmux, a terminal on both
// ends, a live session in the repo containing the cwd. Every row below is this minus one
// thing. `processEnv` is injected on purpose in this helper — the two tests that exercise
// the DEFAULT build their bag without it.
const deps = (overrides = {}) => ({
  cwd: SUBDIR,
  stdout: makeStream(),
  stderr: makeStream(),
  stdin: { isTTY: true },
  exec: makeExec(),
  hasCommand: () => true,
  processEnv: {},
  isTTY: true,
  ...overrides,
})

// The five paths, as the one thing that distinguishes each from the attach state. `exec` is
// spelled as `execOptions` so that `run` below can build a FRESH recorder per invocation —
// a shared one would accumulate another test's calls into this table's ledgers.
const PATHS = {
  'step 1 — no tmux binary': { hasCommand: () => false },
  'step 2 — already inside tmux': { processEnv: { TMUX: '/private/tmp/tmux-501/default,74212,0' } },
  'step 3 — not a terminal': { isTTY: false },
  'step 4 — no live session': { execOptions: { hasSessionResult: { exitCode: 1 } } },
  'step 5 — the attach': {},
}

const run = async (override = {}) => {
  const { execOptions, ...rest } = override
  const d = deps({ ...rest, exec: makeExec(execOptions) })
  const outcome = await liveCommand(d).then(
    (result) => ({ result, error: null }),
    (error) => ({ result: null, error }),
  )
  return { d, ...outcome }
}

describe('QA live — the spawn ledger, one row per path (#167)', () => {
  // A `tmux attach` is the only spawn here that takes the screen, so the property that
  // matters is not "was the attach right" but "which spawns happened at all, in which
  // order". The dev's file asserts the full ledger for steps 1, 3, 4 and 5; step 2 is
  // asserted there only as `attach === undefined`, which a second `has-session` or a
  // stray `tmux ls` would satisfy.
  const ledgers = {
    'step 1 — no tmux binary': [],
    'step 2 — already inside tmux': [TOPLEVEL, HAS],
    'step 3 — not a terminal': [TOPLEVEL, HAS],
    'step 4 — no live session': [TOPLEVEL, HAS],
    'step 5 — the attach': [TOPLEVEL, HAS, ATTACH, HAS],
  }

  for (const [label, keys] of Object.entries(ledgers)) {
    it(`spends exactly ${keys.length} spawn(s) on ${label}`, async () => {
      const { d } = await run(PATHS[label])
      expect(d.exec.keys()).toEqual(keys)
    })
  }

  it('asks each question at most once, and attaches at most once, on every path', async () => {
    // ONE PROBE PER MOMENT, not one probe per command. Two probes BEFORE the attach are how
    // a command that agrees with itself turns into one that can attach to a session it just
    // reported dead; two attaches would be two screens; and the probe AFTER the attach is a
    // different question — the session outliving the client — so it is capped on its own
    // side of the split rather than lumped in. Counted per path rather than trusted from the
    // ledgers above, since a duplicate spawn under a DIFFERENT session name would pass
    // those.
    for (const [label, override] of Object.entries(PATHS)) {
      const { d } = await run(override)
      const attachAt = d.exec.calls.findIndex((c) => c.cmd === 'tmux' && c.args[0] === 'attach')
      const split = attachAt === -1 ? d.exec.calls.length : attachAt
      const probes = (calls) => calls.filter((c) => c.cmd === 'tmux' && c.args[0] === 'has-session')
      expect(probes(d.exec.calls.slice(0, split)).length, `${label}: before`).toBeLessThanOrEqual(1)
      expect(probes(d.exec.calls.slice(split)).length, `${label}: after`).toBeLessThanOrEqual(1)
      const of = (sub) => d.exec.calls.filter((c) => c.cmd === 'tmux' && c.args[0] === sub)
      expect(of('attach').length, label).toBeLessThanOrEqual(1)
      expect(d.exec.calls.filter((c) => c.cmd === 'git').length, label).toBeLessThanOrEqual(1)
    }
  })

  it('never spawns the attach on a path that refuses, and never before the refusal', async () => {
    // The whole point of step 3 running BEFORE the spawn: tmux's own `open terminal
    // failed: not a terminal` says nothing about what the user did. Stated as a property
    // of all three refusals at once — an attach anywhere in a refusing path's ledger
    // fails this, whatever session name it carried.
    for (const label of ['step 1 — no tmux binary', 'step 2 — already inside tmux', 'step 3 — not a terminal']) {
      const { d, error } = await run(PATHS[label])
      expect(error, label).toBeInstanceOf(LiveAbort)
      expect(
        d.exec.calls.some((c) => c.cmd === 'tmux' && c.args[0] === 'attach'),
        label,
      ).toBe(false)
    }
  })

  it('makes the attach the last spawn that can take the screen', async () => {
    // Exactly one spawn follows the attach and it is a CAPTURED `has-session` — the fact the
    // closing notice is chosen by. Anything else after the attach (a second attach, a
    // `kill-session`, anything with `stdio: 'inherit'`) would either take the terminal back
    // or change the session the user just left, so the assertion is on the shape of the tail
    // rather than on the count alone.
    const { d } = await run(PATHS['step 5 — the attach'])
    const keys = d.exec.keys()
    expect(keys.indexOf(ATTACH)).toBe(keys.length - 2)
    expect(keys.at(-1)).toBe(HAS)
    expect(d.exec.calls.at(-1).options).toEqual({ reject: false })
  })

  it('spawns the attach with those two options and NO others', async () => {
    // Asserted as the whole options object, not key by key: the options that are absent
    // are the load-bearing ones. A `timeout` would kill the user's session from under them
    // after N ms; a `cwd` or an `env` would make an attach depend on where it was typed;
    // `stdio: 'inherit'` is what makes it an attach at all, and `reject: false` is what
    // turns tmux's exit code into this command's.
    const { d } = await run(PATHS['step 5 — the attach'])
    expect(d.exec.at(ATTACH).options).toEqual({ stdio: 'inherit', reject: false })
  })
})

describe('QA live — the stream ledger: one answer, on one stream (#167)', () => {
  // WHY STDOUT MUST BE EMPTY ON EVERY REFUSAL, and why it is worth a table: step 3 fires
  // BECAUSE stdout is not a terminal, so a hint written there goes down the very pipe the
  // user just proved is not one — `ralph live | cat` would print advice into `cat` and the
  // error into the terminal. The dev's file asserts the empty stdout for step 1 only.
  const ledgers = {
    'step 1 — no tmux binary': { out: 0, err: 2 },
    'step 2 — already inside tmux': { out: 0, err: 3 },
    'step 3 — not a terminal': { out: 0, err: 2 },
    'step 4 — no live session': { out: 1, err: 0 },
    'step 5 — the attach': { out: 3, err: 0 },
  }

  for (const [label, { out, err }] of Object.entries(ledgers)) {
    it(`writes ${out} line(s) to stdout and ${err} to stderr on ${label}`, async () => {
      const { d } = await run(PATHS[label])
      expect(d.stdout.lines()).toHaveLength(out)
      expect(d.stderr.lines()).toHaveLength(err)
      // Every line is terminated, so nothing is left half-written on either stream.
      for (const stream of [d.stdout, d.stderr]) {
        const text = stream.output()
        expect(text === '' || text.endsWith('\n')).toBe(true)
      }
    })
  }

  it('puts the refusal AND its hints on stderr, never a mix of the two streams', async () => {
    // `ralph start` splits ❌-on-stderr from hint-on-stdout (start.js:705-707); this
    // command deliberately does not, and the departure is only real if every line of every
    // refusal is on stderr. Asserted on the needle each refusal is recognised by.
    const needles = {
      'step 1 — no tmux binary': ["'tmux' not found in PATH", 'ralph doctor'],
      'step 2 — already inside tmux': ['Already inside tmux', 'tmux switch-client -t', 'Ctrl+B then D'],
      'step 3 — not a terminal': ['needs a terminal', 'not through a pipe'],
    }
    for (const [label, phrases] of Object.entries(needles)) {
      const { d } = await run(PATHS[label])
      for (const phrase of phrases) {
        expect(d.stderr.output(), `${label}: ${phrase}`).toContain(phrase)
        expect(d.stdout.output(), `${label}: ${phrase}`).not.toContain(phrase)
      }
    }
  })

  it('refuses on stderr alone when there is no stdout object to write to', async () => {
    // The invariant that makes this safe rather than lucky: EVERY stdout write in this
    // command sits behind the TTY gate, so the only stream a refusal ever touches is stderr.
    // A caller that hands `stdout: null` (or a stdout that is closed by the time the
    // command runs) therefore gets the refusal rather than a TypeError on `stdout.write`.
    const stderr = makeStream()
    const d = deps({ stdout: null, stdin: null, stderr, isTTY: undefined })
    const error = await liveCommand(d).catch((e) => e)
    expect(error).toBeInstanceOf(LiveAbort)
    expect(error.message).toBe('not a terminal')
    expect(stderr.lines()).toHaveLength(2)
  })

  it('keeps the two notices that are not refusals on stdout', async () => {
    for (const label of ['step 4 — no live session', 'step 5 — the attach']) {
      const { d } = await run(PATHS[label])
      expect(d.stderr.output(), label).toBe('')
      expect(d.stdout.output(), label).toContain(SESSION)
    }
  })
})

describe('QA live — the exit-code contract (#167)', () => {
  it('gives every refusal a non-zero code and a message of its own', async () => {
    // The codes are deliberately the same `1` — nothing downstream branches on which
    // refusal it was, and bin/ralph.js spends only `e.exitCode`. What has to differ is the
    // MESSAGE, because that is the only thing that tells two aborts apart for a
    // programmatic caller (and `ralph live` has three).
    const seen = new Map()
    for (const label of ['step 1 — no tmux binary', 'step 2 — already inside tmux', 'step 3 — not a terminal']) {
      const { error } = await run(PATHS[label])
      expect(error, label).toBeInstanceOf(LiveAbort)
      // bin/ralph.js gates on `instanceof LiveAbort`, which needs the prototype chain to
      // reach Error for the rethrow of anything else to be meaningful.
      expect(error, label).toBeInstanceOf(Error)
      expect(error.exitCode, label).toBe(1)
      seen.set(error.message, label)
    }
    expect([...seen.keys()]).toEqual(['tmux not installed', 'already inside tmux', 'not a terminal'])
  })

  it('defaults a LiveAbort built with no code to 1', async () => {
    // The class's own default, which no path above exercises because all three pass a code.
    expect(new LiveAbort('nothing to attach to').exitCode).toBe(1)
    expect(new LiveAbort('nothing to attach to').message).toBe('nothing to attach to')
  })

  it('treats "nothing to attach to" as success — exactly 0, not merely falsy', async () => {
    const { result } = await run(PATHS['step 4 — no live session'])
    expect(result).toEqual({ exitCode: 0, attached: false, session: SESSION })
    expect(Object.is(result.exitCode, 0)).toBe(true)
  })

  const codes = {
    'a clean detach': [{ exitCode: 0 }, 0],
    'a tmux that could not attach': [{ exitCode: 1 }, 1],
    'a client killed by the server': [{ exitCode: 130 }, 130],
    'an exit code of 255': [{ exitCode: 255 }, 255],
    'a signal death, which execa reports with no code': [{ signal: 'SIGHUP', failed: true }, 1],
    // execa's own no-child shape: `code` is the libuv error name and there is no `exitCode`
    // at all (measured against execa 9 under `{ reject: false }`, where a missing binary
    // resolves rather than raising). `code` must not be mistaken for an exit code:
    // bin/ralph.js spends this number on `process.exit`, and `process.exit('ENOENT')` is an
    // ERR_INVALID_ARG_TYPE on node 20 — a stack trace where an exit code was promised.
    'a spawn that never produced a child': [{ code: 'ENOENT', failed: true }, 1],
    'a runner that resolved with nothing at all': [null, 1],
  }

  for (const [label, [attachResult, exitCode]] of Object.entries(codes)) {
    it(`hands back tmux's own code for ${label}`, async () => {
      const { result } = await run({ execOptions: { attachResult } })
      expect(result.exitCode).toBe(exitCode)
      expect(result.attached).toBe(true)
    })
  }
})

describe('QA live — the `$TMUX` bag, including the default nobody injects (#167)', () => {
  // `$TMUX` is a socket path, a client pid and a session index — so its VALUE means
  // nothing and its emptiness means everything. Any non-empty value is inside tmux,
  // including three whose TEXT reads as a negative: a test that sniffed the value
  // (`=== 'true'`, or a shell's `[ "$TMUX" = 1 ]`) would attach from inside tmux, which is
  // the one thing this step exists to prevent.
  const inside = {
    'a real socket triple': '/private/tmp/tmux-501/default,74212,0',
    'the string 0': '0',
    'the string false': 'false',
    'the string undefined': 'undefined',
    'a socket path with a space in it': '/tmp/my sockets/default,1,0',
  }

  for (const [label, TMUX] of Object.entries(inside)) {
    it(`refuses to nest when TMUX is ${label}`, async () => {
      const { d, error } = await run({ processEnv: { TMUX } })
      expect(error).toBeInstanceOf(LiveAbort)
      expect(error.message).toBe('already inside tmux')
      expect(d.exec.at(ATTACH)).toBe(undefined)
    })
  }

  {
    // A plain property read, so a bag built as `Object.create(process.env)` — the shape a
    // wrapper that wants to override one name without copying the rest produces — answers
    // from its prototype. `Object.hasOwn`-style logic would miss it and attach from inside
    // tmux, which is the one thing step 2 exists to prevent.
    const label = 'inherited from the bag\'s prototype'
    it(`refuses to nest when TMUX is ${label}`, async () => {
      const processEnv = Object.create({ TMUX: '/private/tmp/tmux-501/default,74212,0' })
      expect(Object.hasOwn(processEnv, 'TMUX')).toBe(false)
      const { d, error } = await run({ processEnv })
      expect(error).toBeInstanceOf(LiveAbort)
      expect(error.message).toBe('already inside tmux')
      expect(d.exec.at(ATTACH)).toBe(undefined)
    })
  }

  const notInside = {
    'the name is absent': {},
    'the name is present and empty': { TMUX: '' },
    'the value is a tab and a newline': { TMUX: '\t\n' },
    'the name is present with an explicit undefined': { TMUX: undefined },
    'the bag has no prototype at all': Object.assign(Object.create(null), {}),
  }

  for (const [label, processEnv] of Object.entries(notInside)) {
    it(`attaches when ${label}`, async () => {
      const { d, result } = await run({ processEnv })
      expect(result.attached).toBe(true)
      expect(d.exec.at(ATTACH)).not.toBe(undefined)
    })
  }

  it('reads `process.env` when no bag is injected — and the suite has no TMUX in it (#41)', async () => {
    // THE ENTRY #167 ADDED TO test/setup/hermetic-env.js, exercised. Every test in the
    // dev's file overrides `processEnv`, so nothing there would notice if `TMUX` fell off
    // that list — and tmux exports the name in every shell inside a session, so a
    // developer running the suite from the window `ralph start` opened would take the
    // inside-tmux branch on their machine and not on CI. The harness deletes it, so a
    // command that lets the default stand attaches here.
    expect(process.env.TMUX).toBe(undefined)
    const d = deps()
    delete d.processEnv
    const result = await liveCommand(d)
    expect(result.attached).toBe(true)
    expect(d.stderr.output()).toBe('')
  })

  it('...and it really is `process.env` that the default reads', async () => {
    // The other half of the claim above: without this, a default that read an empty
    // literal would pass the test above for the wrong reason. Assigning inside a test is
    // the sanctioned opt-in (test/setup/hermetic-env.js restores the value afterwards).
    process.env.TMUX = '/private/tmp/tmux-501/default,999,0'
    const d = deps()
    delete d.processEnv
    const error = await liveCommand(d).catch((e) => e)
    expect(error).toBeInstanceOf(LiveAbort)
    expect(error.message).toBe('already inside tmux')
    expect(d.stderr.output()).toContain(`tmux switch-client -t ${SESSION}`)
  })
})

describe('QA live — the session name reaches every message unmangled (#167)', () => {
  // Three of the five answers name a session, and the name is the byte a user pastes into
  // tmux. The dev's file covers one hostile path; these are the shapes that could break the
  // MESSAGE rather than the name — a newline would split one answer into two lines, and a
  // long path could be truncated into a session that does not exist.
  const roots = {
    'a path with a newline in it': '/Users/me/repos/two\nlines',
    'a non-ASCII path': '/Users/me/repos/über-café',
    'the filesystem root': '/',
    'a 300-character path': `/${'x'.repeat(300)}`,
  }

  for (const [label, root] of Object.entries(roots)) {
    const session = sessionNameFor(root)
    const exec = (extra) => makeExec({ gitResult: { exitCode: 0, stdout: `${root}\n` }, ...extra })

    it(`names it verbatim in the inside-tmux refusal for ${label}`, async () => {
      const d = deps({ cwd: root, exec: exec(), processEnv: { TMUX: '/tmp/tmux-501/default,1,0' } })
      await liveCommand(d).catch(() => {})
      expect(d.stderr.lines()).toHaveLength(3)
      expect(d.stderr.lines()[1]).toBe(`   Switch:  tmux switch-client -t ${session}`)
    })

    it(`names it verbatim in the no-session notice for ${label}, on one line, status before start`, async () => {
      // ONE LINE FOR EVERY ROOT, including the one with a newline in it: the notice
      // interpolates the ROOT as well as the session now, and a raw path would split one
      // answer into two lines — which is why live.js hands the path through
      // `JSON.stringify` and the session (already reduced to `[A-Za-z0-9_-]`) verbatim.
      // The command order rides along on the same line, so it is checked for every root
      // rather than only the friendly one.
      const d = deps({ cwd: root, exec: exec({ hasSessionResult: { exitCode: 1 } }) })
      await liveCommand(d)
      expect(d.stdout.lines()).toHaveLength(1)
      const line = d.stdout.lines()[0]
      expect(line).toContain(`No tmux session '${session}' running`)
      expect(line.indexOf('ralph status')).toBeGreaterThan(-1)
      expect(line.indexOf('ralph status')).toBeLessThan(line.indexOf('ralph start'))
    })

    it(`names it verbatim in the closing notice for ${label}, and spawns it as one argv element`, async () => {
      const d = deps({ cwd: root, exec: exec() })
      const result = await liveCommand(d)
      expect(result.session).toBe(session)
      expect(d.stdout.lines()).toHaveLength(3)
      expect(d.stdout.lines()[0]).toBe(`ℹ️  Detached — the loop is still running in '${session}'.`)
      expect(d.exec.at(`tmux attach -t ${session}`).args).toEqual(['attach', '-t', session])
    })
  }
})

describe('QA live — which closing notice, decided by a fact and not by a code (#167)', () => {
  it('does not tell the user the loop is still running when the attach failed', async () => {
    // THE RACE THIS IS ABOUT: liveness is one `has-session` probe, and the session can die
    // between that probe and the attach — templates/ralph.sh:50 traps EXIT and kills its own
    // session, so a `ralph live` typed as the queue drains is exactly this window. tmux then
    // prints its own `can't find session` on the inherited stderr and exits 1.
    //
    // The notice used to be printed on every path out of the attach, so what the user read
    // next was "Detached — the loop is still running in '<session>'" followed by `ralph stop`
    // for a session that was already gone. Nothing detached, nothing was running, and the one
    // line the command wrote itself was the false one. A non-zero code now prints nothing at
    // all, and this is the test that holds that shut.
    const d = deps({
      exec: makeExec({ attachResult: { exitCode: 1, stderr: `can't find session: ${SESSION}` } }),
    })
    const result = await liveCommand(d)
    expect(result.exitCode).toBe(1)
    expect(d.stdout.output()).not.toContain('still running')
  })

  it('does not tell the user the loop is still running when the SESSION died under the client', async () => {
    // THE OTHER HALF OF THE SAME RACE, and the half a code cannot see: the session outlives
    // the probe long enough to be attached to, then ends while the client is inside it. tmux
    // hands back 0 — the identical 0 a deliberate Ctrl+B D produces — so an exit-code gate
    // prints "the loop is still running" plus `ralph stop` for a session the server has
    // already reaped. templates/ralph.sh:50 makes this the NORMAL end of a watched run, not
    // an edge: the loop's own EXIT trap kills the session the watcher is sitting in.
    const d = deps({
      exec: makeExec({ attachResult: { exitCode: 0 }, hasSessionAfterAttach: { exitCode: 1 } }),
    })
    const result = await liveCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.stdout.output()).not.toContain('still running')
    // Nor a `ralph stop` for something already gone — the honest answer is what happened.
    expect(d.stdout.output()).not.toContain('ralph stop')
    expect(d.stdout.lines()).toEqual([
      `ℹ️  Session '${SESSION}' is gone — the loop ended while you were attached.`,
      '   What happened:  ralph status',
    ])
  })

  const gone = {
    'tmux says no such session': { exitCode: 1 },
    'the probe itself failed to run': { failed: true },
    'the probe resolved with nothing': null,
  }

  for (const [label, hasSessionAfterAttach] of Object.entries(gone)) {
    it(`treats "${label}" as no longer running, never as still running`, async () => {
      // Same rule as the pre-attach probe (../repo-session.js): only a literal 0 is a live
      // session. Anything else — including an answer nobody can grade — must not become the
      // one line this command writes that a user could act on.
      const d = deps({ exec: makeExec({ hasSessionAfterAttach }) })
      await liveCommand(d)
      expect(d.stdout.output()).not.toContain('still running')
      expect(d.stdout.output()).toContain('is gone')
    })
  }

  it('closes with the still-running notice when tmux still has the session', async () => {
    // The anti-vacuity half: the notice is right, and required, for the path it describes.
    const d = deps()
    await liveCommand(d)
    expect(d.stdout.lines()).toEqual([
      `ℹ️  Detached — the loop is still running in '${SESSION}'.`,
      '   Progress:  ralph status',
      '   Kill:      ralph stop',
    ])
  })

  it('asks about THIS session, captured, and spends nothing else on the answer', async () => {
    const d = deps()
    await liveCommand(d)
    const probes = d.exec.calls.filter((c) => c.args[0] === 'has-session')
    expect(probes).toHaveLength(2)
    expect(probes[1].args).toEqual(['has-session', '-t', SESSION])
    // Not `stdio: 'inherit'`: after a detach the user is back at their shell, and tmux's own
    // `can't find session` on their terminal would be noise under the line that explains it.
    expect(probes[1].options).toEqual({ reject: false })
  })
})

describe('QA live — the inside-tmux refusal answers the session question first (#167)', () => {
  it('sends a dead session to step 4 even from inside tmux, rather than advising `switch-client`', async () => {
    // `alive` is resolved before this refusal (step 2's remedy needs the NAME, so the probe
    // has already run) and it is part of the condition. Inside any tmux session, in a repo
    // whose loop is not running, `tmux switch-client -t <session>` would be advice tmux
    // answers with `can't find session` — and the user would never learn the loop had
    // stopped or that `ralph start` is the remedy. The fact is in hand, so it decides:
    // being inside tmux only changes the answer when there is a live session to switch to.
    const d = deps({
      exec: makeExec({ hasSessionResult: { exitCode: 1 } }),
      processEnv: { TMUX: '/private/tmp/tmux-501/default,74212,0' },
    })
    const result = await liveCommand(d)
    expect(result).toEqual({ exitCode: 0, attached: false, session: SESSION })
    expect(d.exec.keys()).toEqual([TOPLEVEL, HAS])
    expect(d.stderr.output()).toBe('')
    expect(d.stdout.output()).not.toContain('switch-client')
    expect(d.stdout.output()).toContain(`No tmux session '${SESSION}' running`)
    expect(d.stdout.output()).toContain('ralph start')
  })

  it('still refuses to nest when the session IS live, so the rule is not a blanket pass', async () => {
    // The anti-vacuity half: `alive &&` narrows the refusal, it does not remove it. A nested
    // `tmux attach` is still what step 2 exists to prevent.
    const { d, error } = await run(PATHS['step 2 — already inside tmux'])
    expect(error).toBeInstanceOf(LiveAbort)
    expect(error.message).toBe('already inside tmux')
    expect(d.stderr.output()).toContain(`tmux switch-client -t ${SESSION}`)
    expect(d.exec.at(ATTACH)).toBe(undefined)
  })
})

describe('QA live — the session it derives is the session the other commands use (#167)', () => {
  // THE REASON ../repo-session.js EXISTS, asked of the three commands together rather than
  // of the module alone: a name `ralph live` derives differently from the name `ralph start`
  // opened is a `ralph live` that reports "no session running" over a live loop. Both
  // siblings are DRIVEN here — the claim is about what they spawn, and a sweep of their
  // source could only see how the read is spelled (CONTRIBUTING.md, "What a static source
  // sweep may be asked").

  // `ralph start`, hermetic: every seam injected, the queue answered from `gh`, the launch
  // captured rather than run. The session is read off the `tmux new` argv, which is the only
  // place start.js commits to a name.
  async function startSessionFor(cwd) {
    const calls = []
    const exec = async (cmd, args = []) => {
      calls.push({ cmd, args })
      if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
      if (cmd === 'gh' && args[0] === 'issue' && args.includes('--search')) {
        return { exitCode: 0, stdout: '3', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const result = await startCommand({
      cwd,
      stdout: makeStream(),
      stderr: makeStream(),
      exec,
      exists: () => false,
      readFile: () => '',
      loadEnv: () => ({}),
      hasCommand: () => true,
      ask: async () => true,
      update: async () => ({
        latestVersion: null,
        isNewer: false,
        shouldPrompt: false,
        source: 'disabled',
        updatedCache: null,
      }),
      sendWa: async () => ({ ok: true }),
      readCache: () => ({ latest_version: null }),
      peekLock: () => null,
      now: () => Date.parse('2026-08-31T12:00:00Z'),
      home: '/home/me',
      processEnv: {},
    })
    expect(result.started).toBe(true)
    const launch = calls.find((c) => c.cmd === 'tmux' && c.args[0] === 'new')
    return launch.args[launch.args.indexOf('-s') + 1]
  }

  // `ralph stop`, hermetic: git answers that `cwd` is inside REPO — #168 moved `stop` onto
  // ../repo-session.js, so the toplevel probe is part of the answer and a runner that
  // refused it would measure the degraded path instead of this one — and tmux answers that
  // there is nothing to kill, so the name is read off the probe `stop` spends before
  // deciding that.
  async function stopSessionFor(cwd) {
    const calls = []
    const exec = async (cmd, args = []) => {
      calls.push({ cmd, args })
      if (cmd === 'git') return { exitCode: 0, stdout: `${REPO}\n`, stderr: '' }
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    const result = await stopCommand({ cwd, stdout: makeStream(), stderr: makeStream(), exec })
    expect(result).toEqual({ exitCode: 0, killed: false })
    const probe = calls.find((c) => c.cmd === 'tmux' && c.args[0] === 'has-session')
    return probe.args[probe.args.indexOf('-t') + 1]
  }

  // `ralph live`, with git answering that `cwd` is inside REPO.
  async function liveSessionFor(cwd) {
    const d = deps({ cwd })
    const result = await liveCommand(d)
    expect(result.attached).toBe(true)
    return result.session
  }

  it('agrees with `ralph start` and `ralph stop` when all three are typed at the repo root', async () => {
    // The state every README instruction puts a user in, and the one that has to hold: the
    // name in `ralph start`'s launch box, the name `ralph stop` kills and the name
    // `ralph live` attaches to are one string.
    const [started, stopped, attached] = [
      await startSessionFor(REPO),
      await stopSessionFor(REPO),
      await liveSessionFor(REPO),
    ]
    expect(attached).toBe(sessionNameFor(REPO))
    expect(started).toBe(attached)
    expect(stopped).toBe(attached)
  })

  it('documents the remaining divergence: from a SUBDIRECTORY only `ralph start` hashes the directory', async () => {
    // `ralph live` and — since #168 — `ralph stop` both resolve the git toplevel
    // (../repo-session.js), while `ralph start` (start.js:679) still hashes the cwd it was
    // handed, so the three names agree only when the cwd IS the toplevel. #168 closed the
    // half that was a live bug in a command that KILLS things: `ralph stop` typed in `lib/`
    // used to probe a name nothing had created, print the no-session notice, exit 0 and leave
    // the loop running. What is left is the launch side, and its consequence is real:
    //
    //   * `ralph start` in `lib/`, then `ralph live` anywhere → "No tmux session
    //     'ralph-repo-…' running — check with 'ralph status', or start the loop with
    //     'ralph start' in "/repo"", exit 0, over a loop that is running under
    //     `ralph-commands-…`. The report is honest about what it measured (no session under
    //     THAT name) and wrong about the repo (a loop is running), which is why the hint
    //     leads with `ralph status`: status anchors on the toplevel and reads the record
    //     templates/ralph.sh:395-398 writes there whatever directory it was launched from
    //     (status.js:305,312), so it FINDS the loop this command missed. `ralph start` comes
    //     second because it is the dangerous half — templates/ralph.sh takes no lock and
    //     start's only guard is a `has-session` on its own cwd-derived name (start.js:703),
    //     which by construction misses that loop, so following it first would put a second
    //     agent loop on one working tree.
    //   * `ralph stop` cannot reach that loop either, and now for the opposite reason: it
    //     asks about the repo's session from every directory, and a loop launched under a
    //     subdirectory's name is not the repo's session. Typed in that same subdirectory it
    //     used to reach it — both commands hashed the cwd, so both spelled one name — and
    //     that agreement held only while the two directories matched: the same rule left
    //     `ralph stop` in `lib/` unable to kill the loop `ralph start` had opened at the
    //     root, which is the bug #168 fixed. `stop` is now anchored where `live` is, because
    //     two commands that disagree about which session a repo has are worse than two that
    //     answer alike.
    //
    // Pinned here so the state of the repo is written down rather than inferred: `stopped`
    // now agrees with `attached`, and the one assertion still recording a divergence is
    // `started`'s, which flips when `ralph start` migrates.
    const [started, stopped, attached] = [
      await startSessionFor(SUBDIR),
      await stopSessionFor(SUBDIR),
      await liveSessionFor(SUBDIR),
    ]
    expect(attached).toBe(sessionNameFor(REPO))
    expect(stopped).toBe(attached)
    expect(started).toBe(sessionNameFor(SUBDIR))
    expect(started).not.toBe(attached)
  })
})

describe('QA live — the CLI wiring (#167)', () => {
  const BIN = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))

  it('lists `live` between `start` and `stop`, the order a session is lived through', async () => {
    // The claim bin/ralph.js's own comment makes about where the command sits. Commander
    // prints commands in registration order, so the help output is where it is checkable.
    const result = await execa('node', [BIN, '--help'], { reject: false })
    const index = (name) => result.stdout.split('\n').findIndex((l) => new RegExp(`^\\s+${name}\\b`).test(l))
    expect(index('start')).toBeGreaterThan(-1)
    expect(index('live')).toBeGreaterThan(index('start'))
    expect(index('stop')).toBeGreaterThan(index('live'))
  })

  it('rejects a flag of its own before the command runs, the way its siblings do', async () => {
    // Commander answers an unknown option itself, so nothing is spawned and no session is
    // touched — the same answer `ralph stop --foo` gives, which is what makes this a
    // convention rather than a special case.
    const live = await execa('node', [BIN, 'live', '--foo'], { reject: false })
    const stop = await execa('node', [BIN, 'stop', '--foo'], { reject: false })
    expect(live.exitCode).toBe(1)
    expect(live.stderr).toContain("unknown option '--foo'")
    expect(live.stdout).toBe('')
    expect(stop.exitCode).toBe(live.exitCode)
  })

  it('spends the result and the abort the way #167 says, checked against bin/ralph.js', async () => {
    // A CLAIM ABOUT ANOTHER FILE, so it is asserted where it can be — on that file's
    // source, comments stripped, scoped to the `live` block. Driving it would mean running
    // the real command, which attaches to a real tmux session on a developer's machine.
    // What has to hold: the exit code is tmux's (`result.exitCode`, not a bare 0), a
    // LiveAbort exits with its own code, and nothing in the block prints — three refusals
    // have already written their own lines to stderr, and a second copy of the abort's
    // internal message ('not a terminal') is not an answer a user can act on.
    const code = codeWithoutComments(BIN)
    const block = code.slice(code.indexOf(".command('live')"), code.indexOf(".command('stop')"))
    expect(block).toContain('await liveCommand()')
    expect(block).toContain('process.exit(result.exitCode ?? 0)')
    expect(block).toContain('e instanceof LiveAbort')
    expect(block).toContain('process.exit(e.exitCode ?? 1)')
    expect(block).toContain('throw e')
    expect(block).not.toMatch(/\.message/)
    expect(block).not.toMatch(/console\.|stderr|stdout/)
    // ANTI-VACUITY: a slice that stopped matching would make every negative above pass for
    // free, and an empty `block` would satisfy `not.toMatch` twice over.
    expect(block.length).toBeGreaterThan(100)
    expect(block.length).toBeLessThan(code.length)
    expect(code).toContain("import { liveCommand, LiveAbort } from '../lib/commands/live.js'")
  })
})
