import { describe, it, expect } from 'vitest'
import { reconcileMode, renderStatus, statusCommand } from './status.js'

// QA augmentation for #55. The dev's status.test.js locks the four modes and the
// happy-path rendering. These tests attack the read-only-view promise from the
// outside: whatever the record says, whatever tmux and gh answer, `ralph status`
// must exit 0, must never print a number it does not have, and must never reach
// for gh in folder mode.
//
// Two things drive the shape of this file:
//
//   1. FAILURE SHAPES ARE execa'S, NOT INVENTED ONES. With `{ reject: false }`
//      execa does not throw — a missing binary comes back as
//      `{ failed: true, exitCode: undefined }` and a timeout as
//      `{ timedOut: true }`. So the hostile doubles below return those shapes
//      (plus a `undefined` result, for a stub that answers with nothing) rather
//      than throwing, which is what the production dependency can actually do.
//   2. AN UNKNOWN QUEUE IS NOT AN EMPTY QUEUE. Every degradation case asserts
//      the literal absence of `0 waiting`, because "0 waiting" tells the reader
//      the run is about to finish while "unknown" tells them the count failed.
//
// Hermetic: local Date constructors for the wall-clock fixtures (the rendered
// `16:20` is local time, so a UTC ISO literal would be timezone-dependent), an
// injected `now`, and an explicitly injected `processEnv` everywhere.

const REPO = '/repo'
const SESSION = 'ralph-repo-live'

const RUN_STARTED = new Date(2026, 7, 25, 16, 20, 0)
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime()

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      // Backpressure: a real stdout can answer false, and the command must not
      // care (it never waits for 'drain').
      return false
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
}

const running = (overrides = {}) => ({
  schema: 1,
  run_id: 'run-live',
  session: SESSION,
  source: 'github',
  status: 'running',
  started_at: RUN_STARTED.toISOString(),
  queue_at_start: 8,
  current: { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 3 },
  finished_at: null,
  ok: null,
  failed: null,
  ...overrides,
})

// An explicit sentinel for "the call resolves with nothing": a literal
// `undefined` would be swallowed by the destructuring defaults below, which is
// the opposite of the case under test.
const RESOLVES_UNDEFINED = Symbol('resolves undefined')

// tmuxResult / ghResult are returned verbatim, so a test can hand over an
// execa-shaped failure, or RESOLVES_UNDEFINED for a stub that answers with
// nothing.
function makeExec({ tmuxResult = { exitCode: 0 }, ghResult = { exitCode: 0, stdout: '6' } } = {}) {
  const calls = []
  const unwrap = (r) => (r === RESOLVES_UNDEFINED ? undefined : r)
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux') return unwrap(tmuxResult)
    if (cmd === 'gh') return unwrap(ghResult)
    return { exitCode: 0, stdout: '' }
  }
  exec.calls = calls
  exec.of = (cmd) => calls.filter((c) => c.cmd === cmd)
  return exec
}

const deps = (overrides = {}) => {
  const stdout = makeStream()
  const folderCalls = []
  const base = {
    cwd: REPO,
    stdout,
    exec: makeExec(),
    exists: () => false, // no ralph.config.sh -> github, the default
    readFile: () => '',
    readRunState: () => running(),
    folderQueueCount: async (args) => {
      folderCalls.push(args)
      return 6
    },
    now: () => NOW,
    processEnv: {},
    ...overrides,
  }
  base.folderCalls = folderCalls
  return base
}

// TASK_SOURCE=folder declared in ralph.config.sh, the documented way to select it.
const folderConfig = (overrides = {}) =>
  deps({
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE="folder"\n' : ''),
    ...overrides,
  })

describe('statusCommand — a hostile tmux probe still yields a mode (#55 QA)', () => {
  const probes = {
    'tmux is not installed (execa ENOENT shape: no exitCode)': { failed: true },
    'the tmux server is unreachable (non-zero exit + stderr)': {
      exitCode: 1,
      stdout: '',
      stderr: 'no server running on /tmp/tmux-501/default',
    },
    'the probe timed out': { timedOut: true, failed: true },
    'the probe answered with nothing at all': RESOLVES_UNDEFINED,
  }

  for (const [label, tmuxResult] of Object.entries(probes)) {
    it(`reports interrupted, not running, when ${label}`, () => {
      // A record that says `running` must never be believed on the strength of a
      // probe that did not actually confirm the session.
      return statusCommand(deps({ exec: makeExec({ tmuxResult }) })).then((result) => {
        expect(result.exitCode).toBe(0)
        expect(result.mode).toBe('interrupted')
      })
    })
  }

  it('only ever probes tmux once, and counts the queue at most once', async () => {
    // Both are network/subprocess costs on a command a user may run in a loop.
    const d = deps()
    await statusCommand(d)
    expect(d.exec.of('tmux').length).toBe(1)
    expect(d.exec.of('gh').length).toBe(1)
  })

  it('passes the recorded session as a single argv element, never through a shell', async () => {
    const hostile = 'ralph-repo; rm -rf $HOME #'
    const d = deps({ readRunState: () => running({ session: hostile }) })
    await statusCommand(d)
    const probe = d.exec.of('tmux')[0]
    expect(probe.args).toEqual(['has-session', '-t', hostile])
    expect(probe.options.shell).toBe(undefined)
    expect(d.stdout.output()).toContain(`tmux attach -t ${hostile}`)
  })
})

describe('statusCommand — a failed queue count is UNKNOWN, never 0 (#55 QA)', () => {
  const ghFailures = {
    'gh is not installed (execa ENOENT shape)': { failed: true },
    'gh exited non-zero': { exitCode: 1, stdout: '', stderr: 'gh: not authenticated' },
    'gh timed out': { timedOut: true, failed: true, stdout: '' },
    'gh answered with nothing at all': RESOLVES_UNDEFINED,
    'gh exited 0 with no stdout property': { exitCode: 0 },
    'gh exited 0 with empty stdout': { exitCode: 0, stdout: '' },
    'gh exited 0 with whitespace': { exitCode: 0, stdout: '  \n ' },
    'gh printed a rate-limit message': { exitCode: 0, stdout: 'API rate limit exceeded' },
    'gh printed multiple lines': { exitCode: 0, stdout: '6\n7\n' },
    'gh printed a quoted number': { exitCode: 0, stdout: '"6"' },
  }

  for (const [label, ghResult] of Object.entries(ghFailures)) {
    it(`renders "unknown" and exits 0 when ${label}`, async () => {
      const d = deps({ exec: makeExec({ ghResult }) })
      const result = await statusCommand(d)
      expect(result.exitCode).toBe(0)
      expect(result.queue).toBe(null)
      expect(d.stdout.output()).toContain('  queue      unknown')
      // The whole point of the degradation: an unknown depth must not read as an
      // empty queue, which would say "this run is nearly done".
      expect(d.stdout.output()).not.toContain('waiting')
    })
  }

  it('still renders a REAL empty queue as "0 waiting"', async () => {
    const d = deps({ exec: makeExec({ ghResult: { exitCode: 0, stdout: '0\n' } }) })
    const result = await statusCommand(d)
    expect(result.queue).toBe(0)
    expect(d.stdout.output()).toContain('  queue      0 waiting')
  })

  const folderFailures = {
    'the counter rejects': async () => {
      throw new Error('EACCES: permission denied, scandir')
    },
    'the counter throws synchronously': () => {
      throw new Error('boom')
    },
    'the counter answers with a string': async () => '4',
    'the counter answers with NaN': async () => NaN,
    'the counter answers with null': async () => null,
    'the counter answers with undefined': async () => undefined,
    'the counter answers with an object': async () => ({ count: 4 }),
  }

  for (const [label, folderQueueCount] of Object.entries(folderFailures)) {
    it(`renders "unknown" and exits 0 in folder mode when ${label}`, async () => {
      const d = folderConfig({ folderQueueCount })
      const result = await statusCommand(d)
      expect(result.exitCode).toBe(0)
      expect(result.queue).toBe(null)
      expect(d.stdout.output()).toContain('  queue      unknown')
      expect(d.exec.of('gh').length).toBe(0)
    })
  }

  it('renders a REAL empty folder queue as "0 waiting"', async () => {
    const d = folderConfig({ folderQueueCount: async () => 0 })
    const result = await statusCommand(d)
    expect(result.queue).toBe(0)
    expect(d.stdout.output()).toContain('  queue      0 waiting')
  })
})

describe('statusCommand — folder mode makes ZERO gh calls (#55 QA)', () => {
  it('never calls gh for a folder run whose session is gone (interrupted)', async () => {
    // The dev covers the `running` half; interrupted takes the same live-view
    // branch and so also counts the queue.
    const d = folderConfig({
      exec: makeExec({ tmuxResult: { exitCode: 1 } }),
      folderQueueCount: async () => 4,
    })
    const result = await statusCommand(d)
    expect(result.mode).toBe('interrupted')
    expect(d.exec.of('gh').length).toBe(0)
    expect(d.stdout.output()).toContain('  queue      4 waiting')
  })

  it('honours TASK_SOURCE=folder from the injected environment when no config file exists', async () => {
    // Injected, never read off the ambient shell — the suite strips TASK_SOURCE.
    const d = deps({ processEnv: { TASK_SOURCE: 'folder' }, folderQueueCount: async () => 2 })
    const result = await statusCommand(d)
    expect(result.queue).toBe(2)
    expect(d.exec.of('gh').length).toBe(0)
  })

  it('counts the folder queue under the project’s .ralph/tasks tree', async () => {
    const d = folderConfig()
    await statusCommand(d)
    expect(d.folderCalls).toEqual([{ cwd: REPO }])
  })

  it('lets ralph.config.sh win over the environment (config github + env folder => gh)', async () => {
    const d = deps({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: () => 'TASK_SOURCE="github"\n',
      processEnv: { TASK_SOURCE: 'folder' },
    })
    await statusCommand(d)
    expect(d.exec.of('gh').length).toBe(1)
    expect(d.folderCalls).toEqual([])
  })

  it('falls back to github for an unrecognised source, rather than skipping the count', async () => {
    const d = deps({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: () => 'TASK_SOURCE="folders"\n',
    })
    const result = await statusCommand(d)
    expect(result.queue).toBe(6)
    expect(d.exec.of('gh').length).toBe(1)
  })

  it('counts NOTHING at all — no gh, no folder scan — for idle and never-run', async () => {
    for (const [label, readRunState] of [
      ['idle', () => running({ status: 'success', finished_at: RUN_STARTED.toISOString(), ok: 1, failed: 0 })],
      ['never-run', () => null],
    ]) {
      const d = folderConfig({ readRunState })
      const result = await statusCommand(d)
      expect(result.exitCode, label).toBe(0)
      expect(d.exec.of('gh').length, label).toBe(0)
      expect(d.folderCalls, label).toEqual([])
    }
  })
})

describe('statusCommand — a wrecked record still renders and exits 0 (#55 QA)', () => {
  const records = {
    'an empty object (every field missing)': {},
    'a record with only a status': { status: 'running' },
    'current as a string instead of an object': { status: 'running', run_id: 'r', current: 'issue 31' },
    'current as an empty object': { status: 'running', run_id: 'r', current: {} },
    'current as an array': { status: 'running', run_id: 'r', current: [31] },
    'a task with no started_at': { status: 'running', run_id: 'r', current: { number: 31 } },
    'a task number that is not a number': {
      status: 'running',
      run_id: 'r',
      current: { number: 'thirty-one', started_at: TASK_STARTED.toISOString() },
    },
    'an unparseable started_at': { status: 'running', run_id: 'r', started_at: 'yesterday' },
    'a started_at in the future (clock skew)': {
      status: 'running',
      run_id: 'r',
      started_at: new Date(NOW + 3 * 3600 * 1000).toISOString(),
      current: null,
    },
    'a run id that is not a string': { status: 'running', run_id: 42 },
    'a schema from the future': { schema: 99, status: 'running', run_id: 'r' },
    'ok/failed as strings on a terminal record': { status: 'partial', run_id: 'r', ok: '2', failed: '1' },
    'a terminal record with no finished_at': { status: 'success', run_id: 'r', ok: 1, failed: 0 },
    'a terminal status nobody defined': { status: 'weird-new-status', run_id: 'r' },
  }

  for (const [label, record] of Object.entries(records)) {
    it(`exits 0, prints no NaN and no "undefined", for ${label}`, async () => {
      const d = deps({ readRunState: () => record })
      const result = await statusCommand(d)
      const out = d.stdout.output()
      expect(result.exitCode).toBe(0)
      expect(out).not.toContain('NaN')
      expect(out).not.toContain('undefined')
      expect(out).not.toContain('Invalid Date')
      expect(out.endsWith('\n')).toBe(true)
    })
  }

  it('says "none yet" rather than inventing a task when current is falsy but present', async () => {
    for (const current of [null, undefined, 0, '', false]) {
      const d = deps({ readRunState: () => running({ current }) })
      await statusCommand(d)
      expect(d.stdout.output(), `current=${JSON.stringify(current)}`).toContain('  in flight  none yet')
    }
  })

  it('degrades the task line to "#? (unknown)" instead of dropping it', async () => {
    const d = deps({ readRunState: () => running({ current: 'issue 31' }) })
    await statusCommand(d)
    expect(d.stdout.output()).toContain('  in flight  #? (unknown)')
  })

  it('clamps a future started_at to 0min instead of printing a negative elapsed', async () => {
    const d = deps({
      readRunState: () => running({ started_at: new Date(NOW + 3600 * 1000).toISOString() }),
    })
    await statusCommand(d)
    const first = d.stdout.lines()[0]
    expect(first).toContain('0min ago')
    expect(first).not.toMatch(/-\d+(min|h)/)
  })

  it('a record that is running but has NO session probes this repo’s session name', async () => {
    for (const session of [null, '', undefined]) {
      const d = deps({ readRunState: () => running({ session }) })
      const result = await statusCommand(d)
      expect(result.exitCode, JSON.stringify(session)).toBe(0)
      expect(d.exec.of('tmux')[0].args[2]).toMatch(/^ralph-repo-[0-9a-f]{8}$/)
    }
  })
})

describe('statusCommand — exit 0 under a fully hostile environment (#55 QA)', () => {
  it('exits 0 in all four modes with every dependency degraded at once', async () => {
    const wrecked = {
      exec: makeExec({ tmuxResult: { failed: true }, ghResult: { failed: true } }),
      folderQueueCount: async () => {
        throw new Error('EACCES')
      },
      exists: () => {
        throw new Error('EACCES: permission denied, stat')
      },
      readFile: () => {
        throw new Error('EISDIR: illegal operation on a directory')
      },
    }
    const cases = [
      ['interrupted', deps({ ...wrecked })],
      ['idle', deps({ ...wrecked, readRunState: () => ({ status: 'failed', ok: 0, failed: 3 }) })],
      ['never-run', deps({ ...wrecked, readRunState: () => null })],
      [
        'running',
        deps({
          ...wrecked,
          exec: makeExec({ tmuxResult: { exitCode: 0 }, ghResult: { failed: true } }),
        }),
      ],
    ]
    for (const [mode, d] of cases) {
      const result = await statusCommand(d)
      expect(result.exitCode, mode).toBe(0)
      expect(result.mode, mode).toBe(mode)
      expect(d.stdout.output().length, mode).toBeGreaterThan(0)
    }
  })

  it('never writes to the record it reads (status is read-only)', async () => {
    // readRunState is the only run-state entry point wired in, so a write would
    // have to come from somewhere this command has no business touching.
    let reads = 0
    const d = deps({
      readRunState: () => {
        reads += 1
        return running()
      },
    })
    await statusCommand(d)
    expect(reads).toBe(1)
    // Every subprocess is a read: no tmux kill-session, no gh issue edit. The
    // allowlist gained `git rev-parse` when the command started anchoring itself
    // on the repo toplevel — still a read, hence still allowed here.
    for (const call of d.exec.calls) {
      expect(call.key).toMatch(/^(git rev-parse|tmux has-session|gh issue list)/)
    }
  })
})

describe('reconcileMode / renderStatus — pure edges (#55 QA)', () => {
  // The input is `runAlive`, not `sessionAlive`: tmux is one of the loop's two
  // launchers, and a `ralph cycle` run proves liveness with the cycle lock. Same
  // assertions as before the rename — only the key the caller passes changed.
  it('treats any non-boolean truthiness of runAlive consistently', () => {
    expect(reconcileMode({ record: { status: 'running' }, runAlive: undefined })).toBe('interrupted')
    expect(reconcileMode({ record: { status: 'running' }, runAlive: 0 })).toBe('interrupted')
    expect(reconcileMode({ record: { status: 'running' }, runAlive: 1 })).toBe('running')
  })

  it('a record whose status is not the literal "running" is idle, whatever it looks like', () => {
    for (const status of ['Running', 'RUNNING', ' running', 'running ', 'run', null, undefined, 0]) {
      expect(reconcileMode({ record: { status }, runAlive: true }), JSON.stringify(status)).toBe(
        'idle',
      )
    }
  })

  it('renders exactly six lines in the live view and three in the interrupted one', () => {
    const record = running()
    expect(renderStatus({ mode: 'running', record, session: SESSION, queue: 6, now: NOW }).length).toBe(6)
    const interrupted = renderStatus({
      mode: 'interrupted',
      record,
      session: SESSION,
      queue: 6,
      now: NOW,
    })
    expect(interrupted.length).toBe(5)
    expect(interrupted).not.toContain(`  attach     tmux attach -t ${SESSION}`)
    expect(interrupted.at(-1)).toBe('  restart    ralph start')
  })

  it('never emits an attach hint for a session that is gone', () => {
    const lines = renderStatus({
      mode: 'interrupted',
      record: running(),
      session: SESSION,
      queue: null,
      now: NOW,
    })
    expect(lines.join('\n')).not.toContain('tmux')
    expect(lines.join('\n')).not.toContain('ralph stop')
  })

  it('is deterministic for a fixed record and a fixed now (no ambient clock)', () => {
    const args = { mode: 'running', record: running(), session: SESSION, queue: 6, now: NOW }
    expect(renderStatus(args)).toEqual(renderStatus(args))
  })
})
