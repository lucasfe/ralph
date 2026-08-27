import { describe, it, expect } from 'vitest'
import { formatClock, formatElapsed, reconcileMode, renderStatus, statusCommand } from './status.js'
import {
  formatClock as progressFormatClock,
  formatElapsed as progressFormatElapsed,
} from '../progress.js'
import { metricsPath } from '../issue-metrics.js'
import { buildPostMortem, renderPostMortem } from '../post-mortem.js'
import { digestLogPath } from '../digest-file.js'
import { formatHistoryEntry } from '../digest.js'

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
    // The dev covers the `running` half; interrupted renders the report card (#59)
    // and so also counts the queue — the card's `queue` line is about what the NEXT
    // run would pick up, which is a live count either way.
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

  it('counts NOTHING at all — no gh, no folder scan, no config read — for never-run', async () => {
    // The one mode that still pays for nothing. #59 gave idle a report card whose
    // `queue` line reports what the next run would pick up, so idle counts now; a
    // repo with no record has no run to report on and a one-line pointer at
    // `ralph start` needs no inputs, so this mode must stay free.
    const configPaths = []
    const d = folderConfig({
      readRunState: () => null,
      exists: (p) => {
        configPaths.push(String(p))
        return String(p).endsWith('ralph.config.sh')
      },
    })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('never-run')
    expect(d.exec.of('gh').length).toBe(0)
    expect(d.folderCalls).toEqual([])
    expect(configPaths).toEqual([])
  })

  it('counts the folder queue for an idle repo — the card reports what waits next', async () => {
    const scans = []
    const d = folderConfig({
      readRunState: () =>
        running({ status: 'success', finished_at: RUN_STARTED.toISOString(), ok: 1, failed: 0 }),
      folderQueueCount: async (args) => {
        scans.push(args)
        return 4
      },
    })
    const result = await statusCommand(d)
    expect(result.mode).toBe('idle')
    expect(d.exec.of('gh').length).toBe(0)
    expect(scans).toEqual([{ cwd: REPO }])
    expect(d.stdout.output()).toContain('  queue      4 waiting')
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

// #57 QA — the I/O shell around lib/progress.js. The arithmetic is attacked in
// lib/progress.qa.test.js; what is left here is the read itself: issues.jsonl is a
// file the loop appends to while this command reads it, so every shape `readFile`
// can answer with — a throw, nothing, a Buffer, a 2 MiB half-written log — must
// still leave a view on the terminal and a 0 exit code, and the two modes that
// have no run to report must not read it at all.
describe('statusCommand — a hostile metrics read still renders (#57 QA)', () => {
  const MIN = 60000
  const RUN_ID = 'run-live' // the id the `running()` record above carries
  const metricsRow = (row) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(row)
  const METRICS = [
    metricsRow({ issue_number: 29, run_id: RUN_ID, ts: 1, duration_ms: 97 * MIN, total_cost_usd: 34.1 }),
    metricsRow({ issue_number: 30, run_id: RUN_ID, ts: 2, duration_ms: 71 * MIN, total_cost_usd: 28.75 }),
  ].join('\n')

  const isMetrics = (p) => String(p).endsWith('issues.jsonl')

  // A stack trace is the one thing a read-only view may never print: it means the
  // command aborted inside its own best-effort read.
  const expectNoStackTrace = (out) => {
    expect(out).not.toMatch(/\n\s+at /)
    expect(out).not.toMatch(/Error:/)
    expect(out).not.toContain('EACCES')
  }

  const answers = {
    'the read throws an Error': () => {
      throw new Error('EACCES: permission denied, open issues.jsonl')
    },
    'the read throws a string': () => {
      throw 'EISDIR'
    },
    'the read throws a non-Error object with no message': () => {
      throw { code: 'EMFILE' }
    },
    'the read answers with undefined': () => undefined,
    'the read answers with null': () => null,
    'the read answers with a number': () => 42,
    'the read answers with an object whose toString throws': () => ({
      toString: () => {
        throw new Error('no')
      },
    }),
  }

  for (const [label, answer] of Object.entries(answers)) {
    it(`renders pace/eta/spend as unknown and exits 0 when ${label}`, async () => {
      const d = deps({ readFile: (p) => (isMetrics(p) ? answer(p) : '') })
      const result = await statusCommand(d)
      const out = d.stdout.output()
      expect(result.exitCode).toBe(0)
      expect(out).toContain('  pace       unknown')
      expect(out).toContain('  eta        unknown')
      expect(out).toContain('  spend      unknown')
      // Unknown, never a zero — `$0.00 so far` would read as a free run.
      expect(out).not.toContain('$0.00')
      expect(out).not.toContain('NaN')
      expectNoStackTrace(out)
      // The queue read is independent of the metrics read and must survive it.
      expect(out).toContain('  queue      6 waiting')
    })
  }

  it('parses a Buffer, the shape a real readFileSync answers with', async () => {
    // status.js passes 'utf8', but a mocked or patched fs can hand back a Buffer
    // and the numbers must still come out.
    const d = deps({ readFile: (p) => (isMetrics(p) ? Buffer.from(METRICS) : '') })
    await statusCommand(d)
    expect(d.stdout.output()).toContain('  pace       ~84 min/task · $31.4/task')
    expect(d.stdout.output()).toContain('  spend      $62.85 so far')
  })

  it('reads the rows at the end of a 2 MiB file the loop is still appending to', async () => {
    const junk = 'npm WARN deprecated foo@1.0.0\n'.repeat(70000) // > 2 MiB of noise
    const d = deps({ readFile: (p) => (isMetrics(p) ? junk + METRICS + '\n' : '') })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.stdout.output()).toContain('  pace       ~84 min/task · $31.4/task')
  })

  it('reads the metrics file at the RUN’s root, from any subdirectory', async () => {
    const seen = []
    const d = deps({
      cwd: '/repo/deep/nested',
      readFile: (p) => {
        seen.push(String(p))
        return isMetrics(p) ? METRICS : ''
      },
    })
    // makeExec answers `git rev-parse` with an empty stdout, so the root degrades
    // to the cwd — assert the path is built from whatever root resolveRoot chose,
    // never from a hardcoded '.'.
    await statusCommand(d)
    expect(seen).toContain(metricsPath('/repo/deep/nested'))
  })

  it('makes NO read at all — metrics or config — for never-run', async () => {
    // Idle and interrupted read issues.jsonl now (#59: the report card is built from
    // the ended run's own events, and its queue line from a live count). never-run is
    // the mode that still costs nothing at all: with no record there is no run those
    // reads could say anything about, and the one-line pointer needs no inputs.
    const seen = []
    const d = deps({
      readRunState: () => null,
      readFile: (p) => {
        seen.push(String(p))
        return ''
      },
    })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('never-run')
    expect(seen).toEqual([])
    expect(d.stdout.output()).not.toContain('pace')
  })

  it('reads the metrics for an idle repo and reports a total, never a pace or an ETA', async () => {
    const seen = []
    const d = deps({
      readRunState: () =>
        running({ status: 'success', finished_at: RUN_STARTED.toISOString(), ok: 1, failed: 0 }),
      readFile: (p) => {
        seen.push(String(p))
        return isMetrics(p) ? METRICS : ''
      },
    })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('idle')
    expect(seen).toContain(metricsPath(REPO))
    const out = d.stdout.output()
    // The same $62.85 the live view calls "so far" is a FINAL total once the run is
    // over — and there is no next task to project a pace or an ETA onto.
    expect(out).toContain('  spend      $62.85 total · $31.4/task avg')
    expect(out).not.toContain('pace')
    expect(out).not.toContain('eta')
  })

  it('never prints $0.00 for a run whose rows recorded a zero cost (a Codex run)', async () => {
    const zeroCost = [
      metricsRow({ issue_number: 29, run_id: RUN_ID, ts: 1, duration_ms: 97 * MIN, total_cost_usd: 0 }),
      metricsRow({ issue_number: 30, run_id: RUN_ID, ts: 2, duration_ms: 71 * MIN, total_cost_usd: null }),
    ].join('\n')
    const d = deps({ readFile: (p) => (isMetrics(p) ? zeroCost : '') })
    await statusCommand(d)
    const out = d.stdout.output()
    expect(out).toContain('  spend      unknown')
    expect(out).not.toContain('$0.00')
    expect(out).not.toContain('$0 ')
    // The pace is a separate measurement and is still reported.
    expect(out).toContain('  pace       ~84 min/task')
  })

  it('never lets another run’s history become this run’s spend, end to end', async () => {
    const otherRun = [
      metricsRow({ issue_number: 90, run_id: 'run-old', ts: 1, duration_ms: 40 * MIN, total_cost_usd: 500 }),
      metricsRow({ issue_number: 91, run_id: 'run-old', ts: 2, duration_ms: 80 * MIN, total_cost_usd: 500 }),
    ].join('\n')
    const d = deps({ readFile: (p) => (isMetrics(p) ? otherRun : '') })
    await statusCommand(d)
    const out = d.stdout.output()
    expect(out).toContain('  spend      unknown') // no cost recorded by THIS run
    expect(out).not.toContain('1000')
    expect(out).toContain('  pace       ~60 min/task') // ...but the all-time pace stands
  })

  it('keeps the three lines between the queue and the attach block, in that order', async () => {
    // The block's POSITION is part of the contract the dev's line-count assertion
    // only half covers: counted facts first, then what they imply.
    const d = deps({ readFile: (p) => (isMetrics(p) ? METRICS : '') })
    await statusCommand(d)
    const lines = d.stdout.lines()
    expect(lines.map((l) => l.trim().split(/\s{2,}/)[0])).toEqual([
      expect.stringContaining('▸ ralph'),
      'in flight',
      'queue',
      'pace',
      'eta',
      'spend',
      '',
      'attach',
      'kill',
    ])
  })

  it('re-exports the very same time formatters progress.js owns', () => {
    // #55's callers import these from status.js; #57 moved the implementations
    // into progress.js. A second copy would drift.
    expect(formatElapsed).toBe(progressFormatElapsed)
    expect(formatClock).toBe(progressFormatClock)
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

  // Nine since #57 added the pace/ETA/spend block: heading, in flight, queue, pace,
  // eta, spend, blank, then the two-line tmux pair. #59 took the interrupted mode out
  // of this shape entirely — it renders the report card instead of a live view whose
  // pace and ETA describe a run that will never take another task.
  it('renders nine lines in the live view and a card, with no tmux advice, when interrupted', () => {
    const record = running()
    expect(renderStatus({ mode: 'running', record, session: SESSION, queue: 6, now: NOW }).length).toBe(9)
    const interrupted = renderStatus({
      mode: 'interrupted',
      record,
      session: SESSION,
      queue: 6,
      now: NOW,
    })
    // Nine here too, and for a different reason: the interrupted card is the seven-line
    // card plus the run's start and the task it died on (the dev's #59 review fix). The
    // shape is pinned per mode in lib/post-mortem.qa.test.js; what this test is about is
    // that the interrupted mode is not the live view and offers none of its advice.
    expect(interrupted.length).toBe(9)
    expect(interrupted[1]).toMatch(/^ {2}outcome {4}/)
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

// #59 QA — the morning-after card, driven END TO END through `statusCommand` rather
// than through the pure module. The arithmetic and the rendering are attacked in
// lib/post-mortem.qa.test.js; three things are only reachable from out here:
//
//   1. WHAT THE SHELL FEEDS THE CARD. #59 changed the shell's read plan — idle and
//      interrupted now count the queue and read issues.jsonl where they previously
//      read nothing, and never-run still reads nothing at all. Each of those is a
//      network call or a filesystem read on a command a user may drive off a timer,
//      so each is asserted by counting, not by reading the source.
//   2. THAT THE SHELL PRINTS THE MODULE'S CARD AND NOT A SECOND ONE. Asserted as an
//      identity against `renderPostMortem(buildPostMortem(...))` over the same
//      inputs, so a number formatted in the shell could not drift from the module.
//   3. WHAT THE CARD REPLACED. Interrupted used to render the live view; the card
//      drops two readings that view had. Pinned as characterisation, because a
//      reader who used to get them will notice.
describe('statusCommand — the morning-after card, end to end (#59 QA)', () => {
  const MIN = 60000
  const RUN_ID = 'run-live'
  const metricsRow = (row) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(row)
  const isMetrics = (p) => String(p).endsWith('issues.jsonl')
  const NIGHT = [
    metricsRow({ issue_number: 29, run_id: RUN_ID, ts: 1, duration_ms: 97 * MIN, total_cost_usd: 34.1, verdict: 'pass' }),
    metricsRow({ issue_number: 30, run_id: RUN_ID, ts: 2, duration_ms: 71 * MIN, total_cost_usd: 28.75, verdict: 'fail' }),
  ].join('\n')

  // A finished record, as endRun writes it — `current` KEPT, which is the field the
  // live view would have rendered as "still working on #031".
  const finished = (overrides = {}) =>
    running({ status: 'partial', finished_at: new Date(2026, 7, 25, 18, 2, 0).toISOString(), ok: 7, failed: 1, ...overrides })

  const cardDeps = (overrides = {}) =>
    deps({
      readRunState: () => finished(),
      readFile: (p) => (isMetrics(p) ? NIGHT : ''),
      ...overrides,
    })

  it('prints the module’s card verbatim — the shell formats no number of its own', () => {
    // The identity that makes the pure module's whole test file load-bearing for the
    // terminal: if the shell ever computed a segment itself, the two would drift and
    // only this assertion would see it.
    return (async () => {
      for (const [label, record] of Object.entries({ idle: finished(), interrupted: running() })) {
        const d = cardDeps({
          readRunState: () => record,
          exec: makeExec({ tmuxResult: { exitCode: label === 'idle' ? 0 : 1 } }),
        })
        const result = await statusCommand(d)
        expect(result.mode, label).toBe(label)
        expect(d.stdout.lines(), label).toEqual(
          renderPostMortem(buildPostMortem({ metricsText: NIGHT, record, queue: 6, now: NOW })),
        )
      }
    })()
  })

  it('reports last night’s outcome, spend and wall clock off one record and one file', async () => {
    const d = cardDeps()
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.stdout.lines()).toEqual([
      `▸ ralph — idle · run ${RUN_ID} (finished 18:02, 1h30m ago)`,
      '  outcome    7 ok · 1 failed  — #030',
      '  spend      $62.85 total · $31.4/task avg',
      '  ran for    1h42m',
      '  queue      6 waiting',
      '',
      '  start      ralph start',
    ])
  })

  it('reads issues.jsonl exactly once and counts the queue exactly once, per mode', async () => {
    // #59 added both costs to two modes that used to pay nothing. `--json` or not,
    // a user with this on a prompt timer pays for one gh call and one read.
    for (const [label, record] of Object.entries({ idle: finished(), interrupted: running() })) {
      const d = cardDeps({
        readRunState: () => record,
        exec: makeExec({ tmuxResult: { exitCode: label === 'idle' ? 0 : 1 } }),
      })
      await statusCommand(d)
      expect(d.exec.of('gh').length, label).toBe(1)
      expect(d.exec.of('tmux').length, label).toBe(1)
    }
  })

  it('prints the never-run pointer as ONE line, and reads nothing to print it', async () => {
    // The dev's test pins the absence of the reads; this pins the LINE, because the
    // pointer is the only output in the command that is not a labelled block and a
    // future refactor that routed it through the card would be silent otherwise.
    const seen = []
    const d = deps({
      readRunState: () => null,
      readFile: (p) => {
        seen.push(String(p))
        return ''
      },
    })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('never-run')
    expect(d.stdout.lines()).toEqual([
      '▸ ralph — never-run · no run recorded yet (start one with `ralph start`)',
    ])
    expect(seen).toEqual([])
    expect(d.exec.of('gh').length).toBe(0)
    expect(d.folderCalls).toEqual([])
    // None of the card's labels: a repo with no record has no outcome, no spend and
    // no queue worth counting, so `unknown` five times would be noise.
    for (const label of ['outcome', 'spend', 'ran for', 'queue']) {
      expect(d.stdout.output(), label).not.toContain(label)
    }
  })

  it('keeps the in-flight task and the start time the interrupted live view showed', async () => {
    // This began as CHARACTERISATION of what the card replaced: before #59 an
    // interrupted run rendered the live view, whose `(started 16:20, 3h12m ago)` and
    // `in flight #031 (40min)` told a reader how long ago the run began and which task
    // it died on — and the first cut of the card dropped both, leaving no way to tell a
    // run killed five minutes ago from one killed last week.
    //
    // REWRITTEN by the dev as the positive assertion, which is the #59 review's fix:
    // both are facts on the record, so the interrupted card carries them in its own
    // label column. The properties the original was protecting are still asserted —
    // nothing is substituted for the finish or the wall clock, and the task is reported
    // as the LAST one rather than as one in flight.
    const d = cardDeps({ readRunState: () => running(), exec: makeExec({ tmuxResult: { exitCode: 1 } }) })
    const result = await statusCommand(d)
    expect(result.mode).toBe('interrupted')
    const out = d.stdout.output()
    expect(out).toContain('(finished unknown)')
    expect(out).toContain('  ran for    unknown')
    // The two readings the record carries, back on the card and labelled for what they
    // are: an age measured from the START, and the last task rather than a live one.
    expect(out).toContain('  started    16:20, 3h12m ago')
    expect(out).toContain('  last task  #031')
    expect(out).not.toContain('in flight')
    // ...while what it DID finish before the kill is reported from the events.
    expect(out).toContain('  outcome    1 ok · 1 failed  — #030')
  })

  const hostile = {
    'a terminal record with counts written as strings': finished({ ok: '7', failed: '1' }),
    'a terminal record with no counts at all': finished({ ok: null, failed: null }),
    'a terminal record with a recorded zero on both counts': finished({ ok: 0, failed: 0 }),
    'a terminal record with no finish': finished({ finished_at: null }),
    'a terminal record with an unparseable finish': finished({ finished_at: 'this morning' }),
    'a terminal record whose finish precedes its start': finished({
      finished_at: new Date(2026, 7, 25, 15, 0, 0).toISOString(),
    }),
    'a terminal record whose finish is in the future': finished({
      finished_at: new Date(NOW + 5 * 3600000).toISOString(),
    }),
    'a terminal record with no run id': finished({ run_id: null }),
    'a terminal record with a numeric run id': finished({ run_id: 20260826 }),
    'a status nobody defined': finished({ status: 'weird-new-status' }),
    'an empty object': {},
    'an array': [],
    'a bare string': 'idle',
    'a number': 42,
  }

  const metricsShapes = {
    'a blank file': '',
    'untagged noise only': 'npm WARN deprecated foo@1.0.0\n',
    'a truncated last line': `${NIGHT}\nRALPH_ISSUE_EVENT {"issue_number":31,"run_id":"${RUN_ID}"`,
    'a JSON array payload': 'RALPH_ISSUE_EVENT []\n' + NIGHT,
    'two costs that overflow their own sum': [
      metricsRow({ issue_number: 29, run_id: RUN_ID, total_cost_usd: 1e308, verdict: 'pass' }),
      metricsRow({ issue_number: 30, run_id: RUN_ID, total_cost_usd: 1e308, verdict: 'pass' }),
    ].join('\n'),
    'rows belonging to another run entirely': [
      metricsRow({ issue_number: 90, run_id: 'run-old', total_cost_usd: 500, verdict: 'fail' }),
    ].join('\n'),
    'an unnameable failed task': metricsRow({ issue_number: 'x', run_id: RUN_ID, verdict: 'fail' }),
  }

  for (const [recordLabel, record] of Object.entries(hostile)) {
    for (const [metricsLabel, text] of Object.entries(metricsShapes)) {
      const label = `${recordLabel} + ${metricsLabel}`
      it(`exits 0 with a seven-line card for ${label}`, async () => {
        const d = deps({
          readRunState: () => record,
          readFile: (p) => (isMetrics(p) ? text : ''),
        })
        const result = await statusCommand(d)
        const out = d.stdout.output()
        expect(result.exitCode, label).toBe(0)
        expect(result.mode, label).toBe('idle')
        expect(d.stdout.lines().length, label).toBe(7)
        for (const forbidden of ['NaN', 'Infinity', 'undefined', 'null', 'Invalid Date', '--:--', 'Error']) {
          expect(out, `${label}: printed "${forbidden}"`).not.toContain(forbidden)
        }
        expect(out, label).not.toMatch(/-\d+min|-\d+h\d\dm|\$-/)
        expect(out, label).not.toMatch(/—\s*$/m)
        expect(out.endsWith('\n'), label).toBe(true)
      })
    }
  }

  it('says unknown, never 0, for counts a bash-written record spelled as strings', async () => {
    // run-state.json is written by the loop, so `"ok": "7"` is a real shape — and a
    // string is not a measurement this view can add up or compare.
    const d = cardDeps({ readRunState: () => finished({ ok: '7', failed: '1' }) })
    await statusCommand(d)
    const out = d.stdout.output()
    // The tally of the run's own events fills in for the record it cannot read.
    expect(out).toContain('  outcome    1 ok · 1 failed  — #030')
    expect(out).not.toContain('7 ok')
  })

  it('reports a REAL drained queue as `0 waiting` on the card', async () => {
    const d = cardDeps({ exec: makeExec({ ghResult: { exitCode: 0, stdout: '0\n' } }) })
    const result = await statusCommand(d)
    expect(result.queue).toBe(0)
    expect(d.stdout.output()).toContain('  queue      0 waiting')
  })

  it('reports an unknown queue as unknown on the card, never as a drained one', async () => {
    for (const ghResult of [{ failed: true }, { exitCode: 1 }, { exitCode: 0, stdout: 'rate limited' }]) {
      const d = cardDeps({ exec: makeExec({ ghResult }) })
      const result = await statusCommand(d)
      expect(result.exitCode).toBe(0)
      expect(d.stdout.output()).toContain('  queue      unknown')
      expect(d.stdout.output()).not.toContain('waiting')
    }
  })

  it('is still read-only in both card modes: one state read, and every subprocess a read', async () => {
    for (const [label, tmuxResult] of Object.entries({ idle: { exitCode: 0 }, interrupted: { exitCode: 1 } })) {
      let stateReads = 0
      const d = cardDeps({
        readRunState: () => {
          stateReads += 1
          return label === 'idle' ? finished() : running()
        },
        exec: makeExec({ tmuxResult }),
      })
      await statusCommand(d)
      expect(stateReads, label).toBe(1)
      for (const call of d.exec.calls) {
        expect(call.key, `${label}: ${call.key}`).toMatch(/^(git rev-parse|tmux has-session|gh issue list)/)
        expect(call.options.shell, call.key).toBe(undefined)
      }
    }
  })

  it('accepts a frozen record from the shell down to the card', async () => {
    // `readRunState` hands over parsed JSON the caller may keep; a view that mutated
    // it would corrupt whatever reads it next.
    const record = Object.freeze({ ...finished(), current: Object.freeze({ number: 31 }) })
    const before = JSON.stringify(record)
    const d = cardDeps({ readRunState: () => record })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(JSON.stringify(record)).toBe(before)
  })
})

describe('renderStatus — the card modes as a pure function (#59 QA)', () => {
  it('renders the same never-run pointer whatever record it is handed', () => {
    // The pointer is a function of the MODE alone — there is nothing to report and
    // nothing was read to report it from — so no record shape can change it or break
    // it. `reconcileMode` only answers never-run for a falsy record, but the function
    // is exported and the mode is a parameter, so a caller can pair them freely.
    for (const record of [null, undefined, {}, [], 'idle', 42, running(), { status: 'running', run_id: {} }]) {
      const lines = renderStatus({ mode: 'never-run', record, session: SESSION, queue: 6, now: NOW })
      expect(lines, JSON.stringify(record) ?? 'undefined').toEqual([
        '▸ ralph — never-run · no run recorded yet (start one with `ralph start`)',
      ])
    }
  })

  it('builds both default snapshots eagerly, even in the mode that renders neither', () => {
    // CHARACTERISATION of a JS default-parameter fact with a cost attached: the
    // `progress =` and `postMortem =` defaults are evaluated before the body decides
    // the mode, so `renderStatus({ mode: 'never-run' })` computes two snapshots and
    // discards both. Harmless in production — `statusCommand` always passes both, so
    // the defaults never run there — and pinned here only so the reason a Proxy record
    // throws in never-run is on the record rather than being rediscovered.
    const reads = []
    const watched = new Proxy(
      { status: 'running', run_id: 'r' },
      {
        get(target, prop) {
          reads.push(String(prop))
          return target[prop]
        },
      },
    )
    renderStatus({ mode: 'never-run', record: watched, session: SESSION, queue: 6, now: NOW })
    expect(reads.length, 'the never-run branch is reached only after the defaults are built').toBeGreaterThan(0)
    // ...and nothing it read changed the one line it printed.
    expect(
      renderStatus({ mode: 'never-run', record: watched, session: SESSION, queue: 6, now: NOW }),
    ).toEqual(renderStatus({ mode: 'never-run', record: null, session: SESSION, queue: 6, now: NOW }))
  })

  it('routes every mode that is not the literal "running" to the card', () => {
    // The router is `mode !== 'running'`, so a mode string nobody defined lands on the
    // card rather than on a live view whose pace would describe a run that is over.
    //
    // Nine lines, not seven, for all of them (updated by the dev): the card's own mode
    // word is read off the RECORD's status, and this record says `running` with nothing
    // behind it — so every one of these renders the INTERRUPTED card, which #59's review
    // gave the run's start and the task it died on. The routing property under test is
    // unchanged: none of these reach the live view, and none of them offer tmux advice.
    for (const mode of ['idle', 'interrupted', 'IDLE', 'stopped', '', undefined, null]) {
      const lines = renderStatus({ mode, record: running(), session: SESSION, queue: 6, now: NOW })
      expect(lines.length, JSON.stringify(mode)).toBe(9)
      expect(lines[0], JSON.stringify(mode)).toContain('▸ ralph — interrupted ·')
      expect(lines[1], JSON.stringify(mode)).toMatch(/^ {2}outcome {4}/)
      expect(lines.join('\n'), JSON.stringify(mode)).not.toContain('tmux')
      expect(lines.join('\n'), JSON.stringify(mode)).not.toContain('in flight')
    }
  })

  it('prefers the shell’s snapshot over its own default, so the two surfaces cannot split', () => {
    // The default exists for direct callers only. If the shell's snapshot were ever
    // ignored, the card would silently lose the metrics the shell read for it — which
    // is exactly the outcome/spend half of the card.
    const record = running({ status: 'partial', finished_at: new Date(2026, 7, 25, 18, 2, 0).toISOString() })
    const injected = buildPostMortem({
      metricsText: 'RALPH_ISSUE_EVENT ' + JSON.stringify({ issue_number: 30, run_id: 'run-live', verdict: 'fail', total_cost_usd: 12 }),
      record,
      queue: 6,
      now: NOW,
    })
    const lines = renderStatus({ mode: 'idle', record, session: SESSION, queue: 6, now: NOW, postMortem: injected })
    expect(lines).toEqual(renderPostMortem(injected))
    expect(lines[1]).toBe('  outcome    0 ok · 1 failed  — #030')
    // The default snapshot has no metrics text, so it could not have produced that.
    const defaulted = renderStatus({ mode: 'idle', record, session: SESSION, queue: 6, now: NOW })
    expect(defaulted[1]).toBe('  outcome    unknown')
  })

  it('never emits an attach or a stop hint from either card mode', () => {
    for (const mode of ['idle', 'interrupted']) {
      const text = renderStatus({ mode, record: running(), session: SESSION, queue: 6, now: NOW }).join('\n')
      for (const forbidden of ['tmux', 'ralph stop', 'ralph cycle', 'logs']) {
        expect(text, `${mode}: ${forbidden}`).not.toContain(forbidden)
      }
    }
  })
})

// QA augmentation for #63 — the digest inside the live view. The dev's status.test.js
// pins the wiring on a well-formed history file: the line positions, the path, the
// previous-run case, three malformed cases, the one config read and the three modes that
// must not read the log at all. What is attacked here is the same wiring from the
// direction the file actually arrives from — `.ralph/digest.log` is MODEL PROSE, appended
// by an agent, editable by a human, and now printed into a terminal:
//
//   1. AC#3 AS A BYTE PROMISE, WITH THE BYTES WRITTEN DOWN. "The section is omitted and
//      every other part of the view renders unchanged" is only testable as bytes, so the
//      no-digest live view is pinned as a literal (the human-view analogue of
//      status.json.qa.test.js's IDLE_DOCUMENT_58) and every hostile history is compared
//      against it. A view that gained a stray blank line would still pass a `toContain`.
//   2. THE READ PLAN, COUNTED. `never-run` must read NOTHING — not the metrics, not
//      ralph.config.sh, which #63 newly reads, and not the history — while `idle` and
//      `interrupted` read the config (they count a queue) and must still never open the
//      log. Asserted by counting calls, because a read that is merely harmless today is
//      a syscall on a command people put in a shell prompt.
//   3. THE ATTACH PAIR IS THE POINT. Whatever a model wrote, the last two lines of the
//      view are the pair that lets a reader act on it. One of the assertions below was
//      written against a first implementation that failed it — a narrative carrying an
//      ANSI clear-screen sequence reached the terminal verbatim and took the whole view
//      with it — and the render path is now scrubbed; see the test.
const DIGEST_RUN = 'run-live' // `running().run_id` — the session name is NOT the run id

// The no-digest live view, byte for byte. Local Date fixtures, so the `16:20` is
// timezone-independent; `6 waiting` is the gh stub's answer.
const LIVE_VIEW_NO_DIGEST =
  '▸ ralph — running · run run-live (started 16:20, 3h12m ago)\n' +
  '  in flight  #031 (40min)\n' +
  '  queue      6 waiting\n' +
  '  pace       unknown\n' +
  '  eta        unknown\n' +
  '  spend      unknown\n' +
  '\n' +
  `  attach     tmux attach -t ${SESSION}\n` +
  '  kill       ralph stop\n'

const DIGEST_AT = new Date(NOW - 12 * 60000).toISOString()
const historyFor = (overrides = {}) =>
  formatHistoryEntry({
    at: DIGEST_AT,
    runId: DIGEST_RUN,
    task: '#031',
    model: 'claude-haiku-4-5',
    narrative: 'the loop is healthy',
    ...overrides,
  })

// A deps bag whose only readable file is the history.
const historyDeps = (text, overrides = {}) =>
  deps({ readFile: (p) => (String(p).endsWith('digest.log') ? text : ''), ...overrides })

const ESC_BYTE = String.fromCharCode(27)
const CONTROL_BYTES = new RegExp(`[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]`)

describe('statusCommand — a hostile digest.log cannot change the view (#63 QA)', () => {
  it('renders the documented view byte for byte when there is no digest', async () => {
    // The baseline every case below is measured against, and the thing AC#3 promises did
    // not change: six rows, one blank line, the attach pair.
    const d = deps()
    await statusCommand(d)
    expect(d.stdout.output()).toBe(LIVE_VIEW_NO_DIGEST)
  })

  const omitted = {
    'a file of only whitespace': '   \n\n\t\n',
    'a body with no heading': '  orphaned prose a human pasted\n',
    'a heading with no body (torn mid-append)': historyFor().split('\n').slice(0, 2).join('\n') + '\n',
    'a heading whose body is only whitespace': historyFor({ narrative: 'x' }).replace('  x', '     '),
    'a timestamp no clock can read': historyFor({ at: 'yesterday' }),
    'a stamp beyond the range of a Date': historyFor({ at: '+275760-09-14T00:00:00Z' }),
    'the previous run, in the legacy three-field form': `\n── ${DIGEST_AT} · run ralph-ralph-0000dead · #028 ${'─'.repeat(20)}\n  last night\n\n`,
    'a run id long enough to be truncated by the 200-char cap': historyFor({ runId: 'R'.repeat(200) }),
    'the whole file rewritten with CRLF endings': historyFor().replace(/\n/g, '\r\n'),
    'a megabyte of junk with no heading in it': 'x'.repeat(1024 * 1024),
    'a NUL-padded file': `${String.fromCharCode(0).repeat(4096)}\n`,
  }

  for (const [label, text] of Object.entries(omitted)) {
    it(`omits the section and leaves the view untouched given ${label}`, async () => {
      const d = historyDeps(text)
      const result = await statusCommand(d)
      expect(result.exitCode, label).toBe(0)
      expect(d.stdout.output(), label).toBe(LIVE_VIEW_NO_DIGEST)
    })
  }

  it('shows the digest when there IS one, so the cases above are not vacuous', async () => {
    // The control row. Without it, a wiring bug that omitted the section unconditionally
    // would make every assertion above pass.
    const d = historyDeps(historyFor())
    await statusCommand(d)
    expect(d.stdout.output()).not.toBe(LIVE_VIEW_NO_DIGEST)
    expect(d.stdout.output()).toContain('── digest (12min ago · claude-haiku-4-5)')
    expect(d.stdout.output()).toContain('\n  the loop is healthy\n')
  })

  it('keeps the attach pair reachable however much prose a model wrote', async () => {
    const narratives = {
      'two hundred lines': Array.from({ length: 200 }, (_, i) => `line ${i} of a model that would not stop`).join('\n'),
      'one 5000-character token': 'x'.repeat(5000),
      'a forged heading': `── ${DIGEST_AT} · run other · #999 · evil ${'─'.repeat(20)}\ninvented`,
      'a forged digest SECTION heading': `── digest (0min ago · evil · stale) ${'─'.repeat(20)}\nfake`,
      'a bedrock model id': 'short prose',
      'CJK': String.fromCharCode(0x65e5, 0x672c, 0x8a9e).repeat(200),
    }
    for (const [label, narrative] of Object.entries(narratives)) {
      const model = label === 'a bedrock model id' ? 'us.anthropic.claude-haiku-4-5-20251001-v1:0' : 'haiku'
      const d = historyDeps(historyFor({ narrative, model }))
      const result = await statusCommand(d)
      expect(result.exitCode, label).toBe(0)
      const lines = d.stdout.lines()
      // The two lines a reader needs are the last two, always.
      expect(lines.slice(-2), label).toEqual([`  attach     tmux attach -t ${SESSION}`, '  kill       ralph stop'])
      // ...and the block is bounded, so they are on the screen and not below it.
      expect(lines.length, `${label}: ${lines.length} lines`).toBeLessThanOrEqual(20)
      for (const forbidden of ['NaN', 'undefined', 'Invalid Date', 'null']) {
        expect(d.stdout.output(), `${label}: ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('never writes a control byte to the terminal, whatever the narrative holds', () => {
    // THE DEFECT THIS FOUND, now fixed — see lib/digest-history.qa.test.js for the
    // unit-level version and the full reasoning. End to end it read: a model that began
    // its narration with `ESC[2J ESC[H` made `ralph status` erase the reader's screen,
    // attach pair included. Every other line of this view is a number, an id or one of
    // Ralph's own words; the narrative is the first untrusted text the command has ever
    // printed, and `printable` on the render path is what makes that boundary a boundary.
    // This is the END-TO-END half: the scrub has to survive the whole command, not just
    // the renderer a unit test calls directly.
    const hostile = {
      'clear screen': `${ESC_BYTE}[2J${ESC_BYTE}[Hgone`,
      'set window title': `${ESC_BYTE}]0;pwned${String.fromCharCode(7)}`,
      'a NUL in the prose': `before${String.fromCharCode(0)}after`,
    }
    return Promise.all(
      Object.entries(hostile).map(async ([label, narrative]) => {
        const d = historyDeps(historyFor({ narrative }))
        await statusCommand(d)
        expect(d.stdout.output(), label).not.toMatch(CONTROL_BYTES)
      }),
    )
  })

  it('exits 0 with a whole view while the history read and everything else fails', async () => {
    const d = deps({
      exec: makeExec({ tmuxResult: { exitCode: 0 }, ghResult: { failed: true } }),
      exists: () => {
        throw new Error('EIO')
      },
      readFile: () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      },
    })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.stdout.lines().slice(-2)).toEqual([
      `  attach     tmux attach -t ${SESSION}`,
      '  kill       ralph stop',
    ])
    expect(d.stdout.output()).not.toContain('digest')
  })
})

describe('statusCommand — what #63 added to the read plan (#63 QA)', () => {
  // Every read is counted, because a status view is a command people put in a prompt and
  // #63 added TWO reads to it: ralph.config.sh (for the interval) and .ralph/digest.log.
  const counting = (overrides = {}) => {
    const reads = []
    const probes = []
    const d = deps({
      exists: (p) => {
        probes.push(String(p))
        return false
      },
      readFile: (p) => {
        reads.push(String(p))
        return ''
      },
      ...overrides,
    })
    d.reads = reads
    d.probes = probes
    return d
  }

  it('reads nothing at all — not even the config — when there has never been a run', async () => {
    // The strongest form of the read plan: no gh, no scan, no metrics, and NO config read,
    // which is the one #63 could most easily have leaked into this branch.
    const d = counting({ readRunState: () => null })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.reads, 'never-run opened a file').toEqual([])
    expect(d.probes, 'never-run probed for a file').toEqual([])
    expect(d.exec.of('gh')).toEqual([])
    expect(d.folderCalls).toEqual([])
  })

  it('reads the config for a run that ended, but never that run’s narration', async () => {
    // idle and interrupted count a queue, so they need TASK_SOURCE; the digest belongs to
    // the live view only, so the log must stay closed.
    for (const [why, overrides] of Object.entries({
      idle: { readRunState: () => running({ status: 'partial', finished_at: new Date(NOW - 3600000).toISOString() }) },
      interrupted: { exec: makeExec({ tmuxResult: { exitCode: 1 } }) },
    })) {
      const d = counting(overrides)
      await statusCommand(d)
      expect(d.reads.filter((p) => p.endsWith('digest.log')), why).toEqual([])
      expect(d.probes.filter((p) => p.endsWith('ralph.config.sh')).length, why).toBe(1)
    }
  })

  it('opens the config and the history once each, and only once, while running', async () => {
    const d = counting()
    await statusCommand(d)
    expect(d.probes.filter((p) => p.endsWith('ralph.config.sh'))).toHaveLength(1)
    // No ralph.config.sh here (`exists` answers false), so it is never opened — the probe
    // is the whole cost. The history has no such gate: it is read blind, exactly once.
    expect(d.reads.filter((p) => p.endsWith('ralph.config.sh'))).toEqual([])
    expect(d.reads.filter((p) => p.endsWith('digest.log'))).toEqual([digestLogPath(REPO)])
  })

  it('judges staleness against the documented default when there is no config at all', async () => {
    // `exists` answers false throughout, so the interval is unknown and the ceiling is 60
    // minutes. 61 minutes late is stale; 59 is not. Nothing about a missing config file
    // may make a six-hour-old narration read as current.
    for (const [minutes, expected] of [
      [59, false],
      [61, true],
    ]) {
      const d = historyDeps(historyFor({ at: new Date(NOW - minutes * 60000).toISOString() }))
      await statusCommand(d)
      expect(d.stdout.output().includes('· stale)'), `${minutes}min`).toBe(expected)
    }
  })
})
