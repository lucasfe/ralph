import { describe, it, expect } from 'vitest'
import { formatClock, formatElapsed, reconcileMode, renderStatus, statusCommand } from './status.js'
import {
  formatClock as progressFormatClock,
  formatElapsed as progressFormatElapsed,
} from '../progress.js'
import { metricsPath } from '../issue-metrics.js'
import { composeJiraJql } from '../jira-jql.js'
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
    // RALPH_BANNER=off, so every expectation in this file is a statement about the REPORT
    // and nothing else (#76). The identity box prints above it by default, and the
    // byte-exact views below (LIVE_VIEW_NO_DIGEST and friends) would otherwise all be three
    // lines of frame plus a blank out of date — for a picture whose own behaviour they
    // assert nothing about. The box's suite is status.identity-box.test.js, which covers the
    // default-on path and pins the report under the box as byte-identical to what this knob
    // produces here. The two tests below that override `processEnv` for TASK_SOURCE lose the
    // knob and get the box; both assert a queue count and a `gh` call count, which the box
    // cannot touch, so neither is weakened to accommodate it.
    processEnv: { RALPH_BANNER: 'off' },
    ...overrides,
  }
  base.folderCalls = folderCalls
  return base
}

// Which QUESTION a gh call asked, not just that one was made. #56 gave the live view a
// second gh call — the issue titles the task table labels its rows with — so `of('gh')`
// alone no longer identifies the queue count. Each is recognised by the flag only it
// carries: `--search` for the count, `--state` for the titles.
const queueCountsOf = (d) => d.exec.of('gh').filter((c) => c.args.includes('--search')).length

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

  it('only ever probes tmux once, and asks gh for the count and the titles once each', async () => {
    // Every one of these is a network/subprocess cost on a command a user may run in a
    // loop, so the count is asserted rather than the mere presence of a call.
    //
    // TWO gh calls since #56, and they are named here rather than left as a number: the
    // queue count (`--search`) and the issue titles the task table labels its rows with
    // (`--state all`). A third — or the same one twice, which is how a re-read creeps in
    // when a second renderer wants the same fact — reads as a count mismatch.
    const d = deps()
    await statusCommand(d)
    expect(d.exec.of('tmux').length).toBe(1)
    const gh = d.exec.of('gh')
    expect(gh.length).toBe(2)
    expect(queueCountsOf(d)).toBe(1)
    expect(gh.filter((c) => c.args.includes('--state')).length).toBe(1)
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
    // The COUNT call, by the flag only it carries: since #56 a github-mode live view also
    // asks gh for the issue titles, and a bare call count would no longer say which
    // question was asked. What this test is about is that the source resolved to github,
    // and the count is the call that proves it.
    expect(queueCountsOf(d)).toBe(1)
    expect(d.folderCalls).toEqual([])
  })

  it('falls back to github for an unrecognised source, rather than skipping the count', async () => {
    const d = deps({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: () => 'TASK_SOURCE="folders"\n',
    })
    const result = await statusCommand(d)
    expect(result.queue).toBe(6)
    expect(queueCountsOf(d)).toBe(1)
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

  it('says "nothing in flight" rather than inventing a task when current is falsy but present', async () => {
    for (const current of [null, undefined, 0, '', false]) {
      const d = deps({ readRunState: () => running({ current }) })
      await statusCommand(d)
      const out = d.stdout.output()
      const why = `current=${JSON.stringify(current)}`
      // #56's wording. Every one of these values is a record saying "no task", so none of
      // them may be counted into the denominator either: 6 waiting is 6, not 7.
      expect(out, why).toContain('  progress   0/6 done · nothing in flight')
      // ...and no row invented for it, which a `0` or an `''` read as a task would be.
      expect(out, why).not.toContain('🔄 live')
    }
  })

  it('degrades the task line to "#? (unknown)" instead of dropping it', async () => {
    const d = deps({ readRunState: () => running({ current: 'issue 31' }) })
    await statusCommand(d)
    const out = d.stdout.output()
    // A truthy `current` IS a task in flight — the loop is working on something — so it is
    // still counted and still rowed. What degrades is everything the record failed to say:
    // no number, so `#?`, and no start, so no elapsed anywhere. The row's time column is a
    // dash rather than `~0min`, which would claim the task had just begun.
    expect(out).toContain('  progress   0/7 done · #? in flight (unknown)')
    expect(out).toContain('  #?    🔄 live     –         –')
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
    //
    // #56 put the task table between the progress line and the queue, and the whole
    // top-to-bottom reading is spelled out again rather than trimmed to the three lines
    // this test is named for: the ORDER is the property, and the only way a new block can
    // be inserted in the wrong place — above the queue it is derived from, or between the
    // derived lines — is if a list like this one does not have to be updated to allow it.
    const d = deps({ readFile: (p) => (isMetrics(p) ? METRICS : '') })
    await statusCommand(d)
    const lines = d.stdout.lines()
    expect(lines.map((l) => l.trim().split(/\s{2,}/)[0])).toEqual([
      expect.stringContaining('▸ ralph'),
      'progress',
      '',
      'task',
      '#029',
      '#030',
      '#031',
      '',
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

  // Thirteen since #56 added the task table: heading, progress, blank, the table's header
  // and its one row for the task in flight, blank, queue, pace, eta, spend, blank, then
  // the two-line tmux pair. (#57's block put it at nine; #56's four are the table and the
  // blank lines that fence it.) #59 took the interrupted mode out of this shape entirely —
  // it renders the report card instead of a live view whose pace and ETA describe a run
  // that will never take another task.
  it('renders thirteen lines in the live view and a card, with no tmux advice, when interrupted', () => {
    const record = running()
    expect(renderStatus({ mode: 'running', record, session: SESSION, queue: 6, now: NOW }).length).toBe(13)
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
  '  progress   0/7 done · #031 in flight (40min)  [────────] 0%\n' +
  '\n' +
  // The table with nothing measured behind it: the fake gh answers the queue query with
  // `6` and the title query with the same `6`, which is not a list of issues, so the rows
  // are numbered and unlabelled. One row, for the task in flight, and every column it has
  // no reading for is a dash.
  '  task  verdict     cost      time\n' +
  '  #031  🔄 live     –         ~40min\n' +
  '\n' +
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

// THE VIEW'S HEIGHT, derived rather than measured, because both of its variable blocks
// are now capped and the sum of the caps is a number this suite can hold the command to:
//
//   1  heading                                     1  queue
//   1  progress                                    3  pace, eta, spend
//   1  blank                                       1  blank
//  11  the table: header, the `… N earlier` line,   1  the digest heading
//      eight closed rows, the one in flight         9  its body, MAX_BODY_LINES + the marker
//   1  blank                                       1  blank
//                                                  2  attach, kill
//
// Thirty-three, and ATTAINED — the sixty-task case below hits it exactly, which is what
// makes it a bound rather than a generous guess. A view that grew a line anywhere, or a
// cap that stopped holding, moves this number.
const MAX_VIEW_LINES = 33

// A run that has closed sixty tasks. `renderTaskTable`'s cap is the reason this is a
// fixture and not a hazard: sixty rows is the scale lib/progress.js's own bar comment
// reasons about, and one line per task would put the pair below it out of reach.
const SIXTY_CLOSED =
  Array.from(
    { length: 60 },
    (_, i) =>
      'RALPH_ISSUE_EVENT ' +
      JSON.stringify({
        issue_number: 100 + i,
        run_id: DIGEST_RUN,
        ts: i + 1,
        duration_ms: 60 * 60000,
        total_cost_usd: 12.5,
        verdict: 'pass',
      }),
  ).join('\n') + '\n'

describe('statusCommand — a hostile digest.log cannot change the view (#63 QA)', () => {
  it('renders the documented view byte for byte when there is no digest', async () => {
    // The baseline every case below is measured against, and the thing AC#3 promises did
    // not change: the progress line, #56's table, five rows, one blank line, the attach
    // pair.
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
      // ...and the whole view is bounded, so they are on the screen and not below it. This
      // half varies the DIGEST against a one-row table; the sixty-task case below varies
      // the RUN. MAX_VIEW_LINES is the same bound for both because both blocks are capped —
      // see its derivation above.
      expect(lines.length, `${label}: ${lines.length} lines`).toBeLessThanOrEqual(MAX_VIEW_LINES)
      for (const forbidden of ['NaN', 'undefined', 'Invalid Date', 'null']) {
        expect(d.stdout.output(), `${label}: ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('keeps the attach pair reachable however many tasks the run has closed', async () => {
    // The other half of the bound, and the one #56 could have broken: the digest is not the
    // only variable-height block in this view any more. One line per closed task made the
    // view O(tasks done), so a run that worked through sixty issues — with a model that
    // also would not stop narrating — would have pushed the queue count, the pace, the
    // ETA, the spend, the digest and the pair itself below the fold.
    const d = deps({
      readFile: (p) =>
        String(p).endsWith('digest.log')
          ? historyFor({ narrative: Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') })
          : String(p).endsWith('issues.jsonl')
            ? SIXTY_CLOSED
            : '',
    })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    const lines = d.stdout.lines()
    expect(lines.slice(-2)).toEqual([`  attach     tmux attach -t ${SESSION}`, '  kill       ralph stop'])
    // Exactly the bound, not merely under it: this is the case that attains it.
    expect(lines.length, lines.join('\n')).toBe(MAX_VIEW_LINES)
    // The elision is a DISPLAY decision, so the counted line above the table still counts
    // every task — 60 done of 60 + 1 in flight + the 6 the gh stub reports waiting.
    expect(lines[1]).toContain('60/67 done')
    // ...and the reader is told what is not on the screen, and where it is.
    expect(lines).toContain('  … 52 earlier tasks in .ralph/metrics/issues.jsonl')
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

// ---------------------------------------------------------------------------
// QA augmentation for #126 — TASK_SOURCE=jira, where the queue depth now comes from
// `acli` instead of `gh issue list`.
//
// The dev's status.test.js proves the arm works: the seam is called with the user's clause,
// the number reaches both views, an unconfigured JIRA_JQL renders `unknown`. What is left is
// this file's own thesis, applied to a third source:
//
//   AN UNKNOWN QUEUE IS NOT AN EMPTY QUEUE. Both existing arms honour that — a broken `gh`
//   and a throwing folder scan each render `unknown` — and the first suite below asks the
//   jira arm the same question through the DEFAULT seam, which is the one users get.
//
//   ONE READ, FOUR QUESTIONS. `JIRA_JQL` is the fourth thing asked of one ralph.config.sh
//   read, and it is asked with a grammar (parse-config-var.js) that a JQL exercises harder
//   than any knob before it: a value with quotes inside quotes, with a `#`, with an inline
//   comment. Those go through the real caller here rather than through the parser's own
//   suite, because the interesting question is what reaches acli.
//
//   CONFIG-ONLY, WITH NO ENV FALLBACK, deliberately unlike TASK_SOURCE beside it. Both
//   halves of that asymmetry are pinned.
//
// Hermetic: no test here reaches a real acli — `exec` is the same injected seam every other
// spawn in this file goes through, and the suites that leave `jiraQueueCount` at its default
// still only reach acli through that seam.
// ---------------------------------------------------------------------------

const JIRA_JQL = 'project = RALPH AND statusCategory != Done'
const jiraConfigText = (jql) => `TASK_SOURCE="jira"${String.fromCharCode(0x0a)}JIRA_JQL="${jql}"${String.fromCharCode(0x0a)}`

// tmux/gh answer as they do everywhere else in this file; `acli` is the new one, and it is
// returned verbatim so a test can hand over an execa-shaped failure or RESOLVES_UNDEFINED.
function makeJiraExec({ acliResult = { exitCode: 0, stdout: '4' }, tmuxResult = { exitCode: 0 } } = {}) {
  const calls = []
  const unwrap = (r) => (r === RESOLVES_UNDEFINED ? undefined : r)
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux') return unwrap(tmuxResult)
    if (cmd === 'gh') return { exitCode: 0, stdout: '6' }
    if (cmd === 'acli') return unwrap(acliResult)
    return { exitCode: 0, stdout: '' }
  }
  exec.calls = calls
  exec.of = (cmd) => calls.filter((c) => c.cmd === cmd)
  return exec
}

// TASK_SOURCE=jira with a JIRA_JQL beside it, the documented way to select the source. The
// config TEXT is the seam under test, so it is written as config lines rather than injected
// as a parsed value.
const jiraConfig = (overrides = {}) =>
  deps({
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? jiraConfigText(JIRA_JQL) : ''),
    exec: makeJiraExec(),
    ...overrides,
  })

// The config text spelled out by the caller, for the grammar cases.
const jiraConfigOf = (text, overrides = {}) =>
  deps({
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? text : ''),
    exec: makeJiraExec(),
    ...overrides,
  })

// What reached acli as the --jql argument, or undefined when nothing did.
const jqlSentBy = (d) => {
  const call = d.exec.of('acli')[0]
  return call && call.args[call.args.indexOf('--jql') + 1]
}

describe('statusCommand — a failed JIRA count is UNKNOWN, never 0 (#126 QA)', () => {
  // The same question the gh and folder arms answer, asked of the jira arm through the
  // DEFAULT jiraQueueCount seam — the one a user actually gets. Every shape below is a count
  // NOBODY TOOK: a binary that is not installed, a session that is logged out, a flag acli
  // does not know, an answer nothing can be read out of. Rendering any of them as `0 waiting`
  // tells the reader the Jira board is empty and the run is nearly done.
  //
  // Three sources say this must be `unknown` rather than 0:
  //   - status.js's own comment on the jira arm of `countQueue`, which says an unavailable
  //     count degrades to null,
  //   - templates/ralph.config.sh's JIRA_JQL prose, which promises a bad query shows up "as
  //     \"unknown\" in `ralph status`",
  //   - the two arms already shipped, whose degradation tables are directly above.
  //
  // One test rather than a table, because it is one defect: `defaultJiraQueueCount` maps only
  // an unconfigured JIRA_JQL to null and lets jira-queue.js's honest-zero contract answer for
  // everything else, so every failure below arrives as the number 0.
  it('renders "unknown" and exits 0 for every way acli can fail to produce a count', async () => {
    const acliFailures = {
      'acli is not installed (execa ENOENT shape: no exitCode)': { failed: true },
      'the session is not authenticated': {
        exitCode: 2,
        stdout: '',
        stderr: 'You are not logged in. Run `acli jira auth login`.',
      },
      // Defensive rather than reachable, and noted so it does not read as "timeouts are
      // handled": nothing passes a `timeout` option to the spawner, so execa cannot produce
      // this shape today. The genuine wart is the opposite one — a wedged `acli` hangs this
      // command for as long as it likes, with no deadline anywhere.
      'the search timed out': { timedOut: true, failed: true, stdout: '' },
      'acli answered with nothing at all': RESOLVES_UNDEFINED,
      'acli exited 0 with empty stdout': { exitCode: 0, stdout: '' },
      'acli exited 0 with only whitespace': { exitCode: 0, stdout: '  ' },
      'acli rejected the flag': { exitCode: 0, stdout: 'unknown flag: --count' },
    }

    for (const [label, acliResult] of Object.entries(acliFailures)) {
      const d = jiraConfig({ exec: makeJiraExec({ acliResult }) })
      const result = await statusCommand(d)
      expect(result.exitCode, label).toBe(0)
      expect(result.queue, label).toBe(null)
      expect(d.stdout.output(), label).toContain('  queue      unknown')
      expect(d.stdout.output(), label).not.toContain('waiting')
    }
  })

  it('still renders a REAL empty Jira queue as "0 waiting"', async () => {
    // The other half of the pair above, and the reason "unknown" cannot simply be "0 mapped
    // to null": acli reporting zero matches IS an answer, and it must keep reading as one.
    const d = jiraConfig({ exec: makeJiraExec({ acliResult: { exitCode: 0, stdout: '0' + String.fromCharCode(0x0a) } }) })
    const result = await statusCommand(d)
    expect(result.queue).toBe(0)
    expect(d.stdout.output()).toContain('  queue      0 waiting')
  })

  const seamFailures = {
    'the seam rejects': async () => {
      throw new Error('acli exploded')
    },
    'the seam throws synchronously': () => {
      throw new Error('boom')
    },
    'the seam answers with a string': async () => '4',
    'the seam answers with NaN': async () => NaN,
    'the seam answers with Infinity': async () => Infinity,
    'the seam answers with null': async () => null,
    'the seam answers with undefined': async () => undefined,
    'the seam answers with an object': async () => ({ count: 4 }),
  }

  for (const [label, jiraQueueCount] of Object.entries(seamFailures)) {
    it(`renders "unknown" and exits 0 when ${label}`, async () => {
      const d = jiraConfig({ jiraQueueCount })
      const result = await statusCommand(d)
      expect(result.exitCode).toBe(0)
      expect(result.queue).toBe(null)
      expect(d.stdout.output()).toContain('  queue      unknown')
    })
  }
})

describe('statusCommand — jira mode NEVER reads GitHub, for titles or for the count (#132 QA)', () => {
  it('makes no gh call at all, and exactly one acli call, while running', async () => {
    // This test used to pin the OPPOSITE and say so: the titles gate was `source !== 'folder'`,
    // so a jira `ralph status` paid for one `gh issue list` whose titles nothing could use, and
    // the comment here named the follow-up that would remove it. #132 is that follow-up — the
    // gate is now a switch on the source, and jira's arm resolves summaries through acli.
    //
    // Zero gh calls is therefore the whole assertion, and it is stronger than the old one: it
    // holds for the ISSUE-LIST call and for any other reason a jira run might have reached for
    // `gh`, in a mode where the repo may not even have a GitHub remote.
    const d = jiraConfig()
    await statusCommand(d)
    expect(queueCountsOf(d)).toBe(0)
    expect(d.exec.of('gh')).toEqual([])
    // One acli call, not two: this fixture's log has no keyed event and its record names its
    // task by number, so there is no key to ask a summary for and #132's lookup spawns nothing.
    // The one call is the queue count.
    expect(d.exec.of('acli')).toHaveLength(1)
    expect(d.exec.of('acli')[0].args).toContain('--count')
    expect(d.folderCalls).toEqual([])
  })

  it('asks acli once, with the composed query as one argument and reject:false', async () => {
    const d = jiraConfig()
    await statusCommand(d)
    const call = d.exec.of('acli')[0]
    expect(call.args).toEqual([
      'jira',
      'workitem',
      'search',
      '--jql',
      composeJiraJql(JIRA_JQL).jql,
      '--count',
    ])
    expect(call.options).toEqual({ reject: false })
  })

  it('makes no gh call at all in --json mode, and still counts through acli', async () => {
    // `--json` skips the titles lookup by design, which leaves acli as the only spawn a jira
    // document costs. The queue count is not skipped: `measured` is true for json.
    const d = jiraConfig({ json: true })
    await statusCommand(d)
    expect(d.exec.of('gh')).toEqual([])
    expect(d.exec.of('acli')).toHaveLength(1)
    expect(JSON.parse(d.stdout.output()).progress.remaining).toBe(4)
  })

  it('counts NOTHING — no config read, no acli, no seam call — for never-run', async () => {
    // The one mode that still pays for nothing, asserted for the new source: a repo with no
    // record has no run to report on, so the config is not even probed for.
    const seamCalls = []
    const probes = []
    const d = jiraConfig({
      readRunState: () => null,
      exists: (p) => {
        probes.push(String(p))
        return String(p).endsWith('ralph.config.sh')
      },
      jiraQueueCount: async (args) => {
        seamCalls.push(args)
        return 4
      },
    })
    const result = await statusCommand(d)
    expect(result.mode).toBe('never-run')
    expect(probes).toEqual([])
    expect(seamCalls).toEqual([])
    expect(d.exec.of('acli')).toEqual([])
  })

  it('opens ralph.config.sh exactly once for the four questions asked of it', async () => {
    // TASK_SOURCE, JIRA_JQL, the digest interval and RALPH_BANNER all come out of ONE read.
    // A second read is how two answers start to differ — a config rewritten between them
    // would hand back a source and a query that disagree.
    const reads = []
    const d = jiraConfig({
      readFile: (p) => {
        reads.push(String(p))
        return String(p).endsWith('ralph.config.sh') ? jiraConfigText(JIRA_JQL) : ''
      },
    })
    await statusCommand(d)
    expect(reads.filter((p) => p.endsWith('ralph.config.sh'))).toHaveLength(1)
  })
})

describe('statusCommand — one count, two views, in jira mode (#126 QA)', () => {
  // The number is taken once and rendered twice. A seam that answers a DIFFERENT value on
  // each call is the only way to prove that from the outside: if either view took its own
  // count, one of the two numbers below would be 99.
  const counter = () => {
    const answers = [3, 99, 99]
    let i = 0
    const seam = async () => answers[Math.min(i++, answers.length - 1)]
    seam.calls = () => i
    return seam
  }

  it('renders the human queue line and the progress denominator from ONE count', async () => {
    const jiraQueueCount = counter()
    const d = jiraConfig({ jiraQueueCount })
    const result = await statusCommand(d)
    expect(jiraQueueCount.calls()).toBe(1)
    expect(result.queue).toBe(3)
    expect(d.stdout.output()).toContain('  queue      3 waiting')
    // The denominator is built from the same snapshot: 0 done, 1 in flight, 3 waiting.
    expect(d.stdout.output()).toContain('0/4 done')
    expect(d.stdout.output()).not.toContain('99')
  })

  it('publishes that same count in --json, having asked for it once', async () => {
    const jiraQueueCount = counter()
    const d = jiraConfig({ json: true, jiraQueueCount })
    await statusCommand(d)
    const doc = JSON.parse(d.stdout.output())
    expect(jiraQueueCount.calls()).toBe(1)
    expect(doc.progress.remaining).toBe(3)
    expect(doc.progress.total).toBe(4)
  })
})

describe('statusCommand — where JIRA_JQL comes from, and where it does not (#126 QA)', () => {
  const LF_ = String.fromCharCode(0x0a)

  it('IGNORES a JIRA_JQL in the environment — the query is a property of the repo', async () => {
    // Deliberately unlike TASK_SOURCE beside it. Init writes the JIRA_JQL assignment on
    // every path (empty for a github/folder init) and the loop sources that file with
    // `set -a`, so every child of a run has whatever it holds exported, empty included: an
    // env fallback would read as "unconfigured" in this process and "configured" in the
    // next one. Nothing is spawned, and the row says unknown.
    const d = jiraConfigOf(`TASK_SOURCE="jira"${LF_}`, {
      processEnv: { RALPH_BANNER: 'off', JIRA_JQL: 'project = FROMENV' },
    })
    const result = await statusCommand(d)
    expect(result.queue).toBe(null)
    expect(d.stdout.output()).toContain('  queue      unknown')
    expect(d.exec.of('acli')).toEqual([])
  })

  it('lets the config file decide when the environment names a different query', async () => {
    const d = jiraConfigOf(jiraConfigText('project = FROMFILE'), {
      processEnv: { RALPH_BANNER: 'off', JIRA_JQL: 'project = FROMENV' },
    })
    await statusCommand(d)
    expect(jqlSentBy(d)).toBe(composeJiraJql('project = FROMFILE').jql)
  })

  it('takes the source from the environment while the query stays config-only', async () => {
    // Both halves of the asymmetry in one run: TASK_SOURCE falls back to the environment (the
    // config assigns it nothing), JIRA_JQL does not, so the source resolves to jira and the
    // query resolves to '' — a source with no query, which is exactly "unknown".
    const d = jiraConfigOf(`RALPH_AGENT="claude"${LF_}`, {
      processEnv: { RALPH_BANNER: 'off', TASK_SOURCE: 'jira' },
    })
    const result = await statusCommand(d)
    expect(result.queue).toBe(null)
    expect(d.exec.of('acli')).toEqual([])
    expect(queueCountsOf(d)).toBe(0)
  })

  it('renders unknown and spawns nothing when there is no config file at all', async () => {
    const d = deps({
      exists: () => false,
      readFile: () => '',
      exec: makeJiraExec(),
      processEnv: { RALPH_BANNER: 'off', TASK_SOURCE: 'jira', JIRA_JQL: 'project = FROMENV' },
    })
    const result = await statusCommand(d)
    expect(result.queue).toBe(null)
    expect(d.exec.of('acli')).toEqual([])
  })

  const grammar = {
    'a commented-out assignment': [`TASK_SOURCE="jira"${LF_}# JIRA_JQL="project = R"${LF_}`, null],
    'a whitespace-only value': [`TASK_SOURCE="jira"${LF_}JIRA_JQL="   "${LF_}`, null],
    'the empty value a github/folder init writes': [
      `TASK_SOURCE="jira"${LF_}JIRA_JQL=""${LF_}`,
      null,
    ],
    'a bare assignment with no value': [`TASK_SOURCE="jira"${LF_}JIRA_JQL=${LF_}`, null],
    'a value commented out with a leading hash': [`TASK_SOURCE="jira"${LF_}JIRA_JQL=#off${LF_}`, null],
    'a similarly named knob and nothing else': [
      `TASK_SOURCE="jira"${LF_}JIRA_JQLX="project = R"${LF_}`,
      null,
    ],
  }

  for (const [label, [text]] of Object.entries(grammar)) {
    it(`renders unknown and spawns nothing for ${label}`, async () => {
      const d = jiraConfigOf(text)
      const result = await statusCommand(d)
      expect(result.queue).toBe(null)
      expect(d.stdout.output()).toContain('  queue      unknown')
      expect(d.exec.of('acli')).toEqual([])
    })
  }

  const reaching = {
    'an inline comment after the closing quote': [
      `TASK_SOURCE="jira"${LF_}JIRA_JQL="project = R" # my board${LF_}`,
      'project = R',
    ],
    'a single-quoted value': [
      `TASK_SOURCE="jira"${LF_}JIRA_JQL='project = R AND assignee = currentUser()'${LF_}`,
      'project = R AND assignee = currentUser()',
    ],
    'a JQL string literal quoted the other way round': [
      `TASK_SOURCE="jira"${LF_}JIRA_JQL="summary ~ 'order by' AND project = R"${LF_}`,
      `summary ~ 'order by' AND project = R`,
    ],
    'an export prefix': [`TASK_SOURCE="jira"${LF_}export JIRA_JQL="project = R"${LF_}`, 'project = R'],
    'the LAST of two assignments, as bash would read it': [
      `TASK_SOURCE="jira"${LF_}JIRA_JQL="project = A"${LF_}JIRA_JQL="project = B"${LF_}`,
      'project = B',
    ],
    'a user ORDER BY, relocated on the way out': [
      `TASK_SOURCE="jira"${LF_}JIRA_JQL="project = R ORDER BY priority DESC"${LF_}`,
      'project = R ORDER BY priority DESC',
    ],
  }

  for (const [label, [text, expected]] of Object.entries(reaching)) {
    it(`sends the composed query to acli for ${label}`, async () => {
      const d = jiraConfigOf(text)
      await statusCommand(d)
      expect(jqlSentBy(d)).toBe(composeJiraJql(expected).jql)
    })
  }

  it('TRUNCATES a value whose JQL literal is double-quoted and followed by a hash', async () => {
    // A pinned wart, and the sharpest edge this feature has: parse-config-var.js closes a
    // quoted value at the FIRST quote whose tail is a comment, and it does not model a
    // backslash escape — so `JIRA_JQL="summary ~ \"#123\""` reads as `summary ~ \` and Jira is
    // sent a truncated query. The parser's own header argues this divergence is harmless
    // because no knob read through it accepts a `#`; JIRA_JQL is the first one that does. Use
    // single quotes inside the value (the case above) until that is addressed.
    const BS = String.fromCharCode(0x5c)
    const d = jiraConfigOf(
      `TASK_SOURCE="jira"${LF_}JIRA_JQL="summary ~ ${BS}"#123${BS}""${LF_}`,
    )
    await statusCommand(d)
    expect(jqlSentBy(d)).toBe(composeJiraJql(`summary ~ ${BS}`).jql)
    expect(jqlSentBy(d)).not.toContain('123')
  })

  it('resolves an uppercase TASK_SOURCE to the jira arm', async () => {
    const d = jiraConfigOf(`TASK_SOURCE="JIRA"${LF_}JIRA_JQL="${JIRA_JQL}"${LF_}`)
    const result = await statusCommand(d)
    expect(result.queue).toBe(4)
    expect(queueCountsOf(d)).toBe(0)
    expect(d.exec.of('acli')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// QA augmentation for #132 — THE DEFAULT TITLE RESOLVER, WHICH NOTHING ELSE DRIVES.
//
// `collectStatus` grew a `jiraTitles` dependency, and every test in the dev's
// lib/commands/status.table.test.js INJECTS it — which is the right way to test a table but
// leaves the production wiring uncovered: `defaultJiraTitles` → `titlesFor` → `acliTitlesArgv`
// → the injected `exec`. Nothing anywhere asserts that a `ralph status` in a jira repo, run
// with the deps a user actually gets, spawns the acli search at all. A default resolver wired
// to the wrong function, handed the wrong spawner, or gated behind the wrong source would leave
// the dev's suite entirely green and every real jira table blank.
//
// So the suite below deletes `jiraTitles` from the bag and drives the real chain, asserting the
// two things only an end-to-end can see:
//
//   THE ACLI CALLS AS A SET. A live jira status makes exactly TWO: the queue count and one
//   `key IN (…)` search for every key the table draws. Not three (a re-read), not one (a table
//   with no titles), and never a `gh` call — the source gate is `=== 'github'` now, and a
//   github-shaped fallback in a jira repo is a network call for issue numbers that name
//   nothing.
//
//   THE GATE, FROM THE OUTSIDE. A title is only worth paying for on a view that draws a table,
//   so `--json` and a non-`running` mode must both spawn nothing — and here that is asserted of
//   the REAL resolver, so a gate that let a jira run through would show up as a spawn.
//
// Hermetic: `exec` is the same injected seam every other spawn in this file goes through. The
// acli double below answers the two questions apart, by the flag only one of them carries.
// ---------------------------------------------------------------------------

const TITLE_LF = String.fromCharCode(0x0a)
const jiraEvent = (number, key, { minutes = 60, cost = 1, verdict = 'pass', ts = 1 } = {}) =>
  'RALPH_ISSUE_EVENT ' +
  JSON.stringify({
    issue_number: number,
    run_id: 'run-live',
    ts,
    duration_ms: minutes * 60000,
    total_cost_usd: cost,
    verdict,
    task_key: key,
  })

const JIRA_LOG = [jiraEvent(41, 'FOO-41', { ts: 1 }), jiraEvent(42, 'FOO-42', { ts: 2 })].join(TITLE_LF) + TITLE_LF

// tmux and gh as everywhere else; acli answers the COUNT and the TITLE SEARCH separately, told
// apart by `--count`, which only the count carries. `titleSearch` is returned verbatim so a test
// can hand over an execa-shaped failure.
function makeTitleExec({
  titleSearch = { exitCode: 0, stdout: '[]' },
  count = { exitCode: 0, stdout: '4' },
  tmuxResult = { exitCode: 0 },
} = {}) {
  const calls = []
  const unwrap = (r) => (r === RESOLVES_UNDEFINED ? undefined : r)
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux') return unwrap(tmuxResult)
    if (cmd === 'gh') return { exitCode: 0, stdout: '6' }
    if (cmd === 'acli') return args.includes('--count') ? unwrap(count) : unwrap(titleSearch)
    return { exitCode: 0, stdout: '' }
  }
  exec.calls = calls
  exec.of = (cmd) => calls.filter((c) => c.cmd === cmd)
  // The title search alone, which is the call this suite is about.
  exec.searches = () => calls.filter((c) => c.cmd === 'acli' && !c.args.includes('--count'))
  return exec
}

// A jira repo with a jira run in flight, and NO `jiraTitles` in the bag — so `collectStatus`
// falls through to its own default, which is the whole point of this suite.
const jiraLive = ({ log = JIRA_LOG, key = 'FOO-43', ...overrides } = {}) =>
  deps({
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) =>
      String(p).endsWith('ralph.config.sh')
        ? jiraConfigText(JIRA_JQL)
        : String(p).endsWith('issues.jsonl')
          ? log
          : '',
    readRunState: () =>
      running({
        source: 'jira',
        current: { number: 43, task_key: key, started_at: TASK_STARTED.toISOString(), iteration: 3 },
      }),
    exec: makeTitleExec(),
    ...overrides,
  })

const board = (...items) => ({
  exitCode: 0,
  stdout: JSON.stringify(items.map(([key, summary]) => ({ key, fields: { summary } }))),
})

describe('statusCommand — the DEFAULT jira title resolver, end to end (#132 QA)', () => {
  it('spawns ONE acli search for every key the table draws, and no gh at all', async () => {
    // The wiring nothing else drives: no `jiraTitles` injected, so this is
    // `defaultJiraTitles` → `titlesFor` → `acliTitlesArgv` → this `exec`. The argv is asserted
    // whole because it is the interface — the JQL is one element, the keys are inside it in
    // Jira's own case and asked order, `--limit` matches how many are named, and `--fields`
    // asks for nothing but the two the table renders.
    const d = jiraLive({
      exec: makeTitleExec({
        titleSearch: board(
          ['FOO-41', 'the sidebar ticket'],
          ['FOO-42', 'the persistence ticket'],
          ['FOO-43', 'the row component'],
        ),
      }),
    })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.exec.of('gh')).toEqual([])
    const searches = d.exec.searches()
    expect(searches).toHaveLength(1)
    expect(searches[0].args).toEqual([
      'jira',
      'workitem',
      'search',
      '--jql',
      'key IN (FOO-41, FOO-42, FOO-43)',
      '--limit',
      '3',
      '--json',
      '--fields',
      'key,summary',
    ])
    // Never through a shell: the JQL carries parentheses and commas.
    expect(searches[0].options.shell).toBe(undefined)
    // ...and the summaries reached the screen, which is what proves the map came back keyed the
    // way the rows ask.
    const out = d.stdout.output()
    expect(out).toContain('FOO-41 the sidebar ticket')
    expect(out).toContain('FOO-42 the persistence ticket')
    expect(out).toContain('FOO-43 the row component')
  })

  it('makes exactly TWO acli calls for a live jira status — the count and the titles', async () => {
    // Both are a subprocess on a command a user may run in a loop, so the count is asserted
    // rather than the presence of a call. A third would be a re-read; a second search would be
    // one renderer asking again for what another already has.
    const d = jiraLive({ exec: makeTitleExec({ titleSearch: board(['FOO-43', 'live']) }) })
    await statusCommand(d)
    expect(d.exec.of('acli')).toHaveLength(2)
    expect(d.exec.of('acli').filter((c) => c.args.includes('--count'))).toHaveLength(1)
    expect(d.exec.of('tmux')).toHaveLength(1)
  })

  it('shows the keys with no summaries when the real resolver cannot reach the board', async () => {
    // The degradation through the DEFAULT chain rather than through an injected stub: acli
    // missing, logged out, crashing, answering prose, answering nothing. Every one still exits
    // 0 with a table of keys, and every one still ASKED — the search is what separates
    // "unauthenticated" from "never wired up".
    const failures = {
      'acli is not installed (execa ENOENT shape)': { failed: true },
      'the acli session is logged out': { exitCode: 1, stdout: '', stderr: 'Unauthorized' },
      'the search timed out': { timedOut: true, failed: true, stdout: '' },
      'acli answered with nothing at all': RESOLVES_UNDEFINED,
      'acli exited 0 with no stdout property': { exitCode: 0 },
      'acli printed prose instead of JSON': { exitCode: 0, stdout: 'No work items found' },
      'acli printed an empty list': { exitCode: 0, stdout: '[]' },
      'acli answered about tickets nobody asked for': {
        exitCode: 0,
        stdout: '[{"key":"BAR-9","fields":{"summary":"another project"}}]',
      },
    }
    for (const [what, titleSearch] of Object.entries(failures)) {
      const d = jiraLive({ exec: makeTitleExec({ titleSearch }) })
      const result = await statusCommand(d)
      expect(result.exitCode, what).toBe(0)
      expect(d.exec.searches().length, what).toBe(1)
      const out = d.stdout.output()
      expect(out, what).toContain('FOO-41')
      expect(out, what).toContain('FOO-43')
      expect(out, what).not.toContain('another project')
      // A courtesy that failed prints no complaint: the table is the whole report.
      expect(out, what).not.toContain('Unauthorized')
    }
  })

  it('spawns no search at all when the run is not running', async () => {
    // The gate `mode === 'running'` asserted against the REAL resolver: an interrupted run
    // renders a post-mortem card and no table, so a title is a subprocess for nothing. tmux says
    // there is no session, which is the only thing that decides this.
    const d = jiraLive({ exec: makeTitleExec({ tmuxResult: { failed: true } }) })
    const result = await statusCommand(d)
    expect(result.mode).toBe('interrupted')
    expect(d.exec.searches()).toEqual([])
    // ...and the count was still taken, so this is a gate on TITLES and not on the whole arm.
    expect(d.exec.of('acli').filter((c) => c.args.includes('--count'))).toHaveLength(1)
  })

  it('spawns no search under --json, and publishes the key instead of a summary', async () => {
    // The `!json` half of the same gate, through the real chain. `--json` is the surface a
    // script polls, so the call it does not make is the whole saving — and the document names
    // the ticket anyway, which is what #132 added it for.
    const d = jiraLive({ json: true, exec: makeTitleExec({ titleSearch: board(['FOO-43', 'live']) }) })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.exec.searches()).toEqual([])
    expect(d.exec.of('gh')).toEqual([])
    const doc = JSON.parse(d.stdout.output())
    expect(doc.tasks.current.task_key).toBe('FOO-43')
  })

  it('spawns no search when the recorded run names no ticket at all', async () => {
    // A jira repo whose events predate #131: rows exist, none carries a key, so `taskKeysFor`
    // answers `[]` and `readTaskTitles` returns before building a query. Asserted through the
    // real resolver because the early return is what stops `titlesFor` spawning for an empty
    // `key IN ()`.
    const d = jiraLive({
      log: [
        'RALPH_ISSUE_EVENT ' +
          JSON.stringify({
            issue_number: 41,
            run_id: 'run-live',
            ts: 1,
            duration_ms: 60000,
            total_cost_usd: 1,
            verdict: 'pass',
          }),
      ].join(TITLE_LF) + TITLE_LF,
      key: null,
    })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.exec.searches()).toEqual([])
    expect(d.stdout.output()).toContain('#041')
  })

  it('never reaches the jira resolver from a folder repo, whatever its log says', async () => {
    // The `source !== 'jira'` arm, asserted with a log FULL of keys so that the only thing
    // stopping the query is the source. A folder run costs neither lookup — no acli search and
    // no `gh issue list`.
    const d = deps({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: (p) =>
        String(p).endsWith('ralph.config.sh')
          ? 'TASK_SOURCE="folder"' + TITLE_LF
          : String(p).endsWith('issues.jsonl')
            ? JIRA_LOG
            : '',
      readRunState: () =>
        running({
          source: 'folder',
          current: { number: 43, task_key: 'FOO-43', started_at: TASK_STARTED.toISOString(), iteration: 3 },
        }),
      exec: makeTitleExec(),
    })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.exec.of('acli')).toEqual([])
    expect(d.exec.of('gh')).toEqual([])
    // The row is still NAMED — by its key, which the log carries and no lookup is needed for.
    expect(d.stdout.output()).toContain('FOO-41')
  })

  it('cannot be made to grow a LINE through a summary the board printed', async () => {
    // The summary arrives from acli over a network and reaches a terminal, so it is untrusted
    // exactly as a GitHub issue title is — and this is that hazard through the DEFAULT chain,
    // where the bytes really travel from a spawner's stdout into the render.
    //
    // Measured: `cleanTitle` folds the newline to a space, drops the escape, collapses the run
    // of spaces and truncates, so the forgery lands INSIDE the in-flight row's title cell as
    // `ok FOO-99 a forged row …` — one line, one row, no control bytes. The assertion is
    // therefore on the LINE COUNT and on the bytes rather than on the substring: `FOO-99` as
    // text in a title cell is a ticket somebody named in a summary, which is allowed, while
    // `FOO-99` at the start of its own line would be a row the log never recorded.
    const ESC_ = String.fromCharCode(0x1b)
    const forged =
      'ok' +
      TITLE_LF +
      '  FOO-99 a forged row      ' +
      String.fromCodePoint(0x2705) +
      ' pass' +
      ESC_ +
      '[31m'
    const clean = jiraLive({ exec: makeTitleExec({ titleSearch: board(['FOO-43', 'ok']) }) })
    await statusCommand(clean)
    const d = jiraLive({ exec: makeTitleExec({ titleSearch: board(['FOO-43', forged]) }) })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    // Exactly as many lines as the same view rendered with a harmless summary.
    expect(d.stdout.lines()).toHaveLength(clean.stdout.lines().length)
    // No line NAMES the forged ticket — the task column is the first thing on a row.
    for (const line of d.stdout.lines()) expect(line.trimStart().startsWith('FOO-99'), line).toBe(false)
    // ...and nothing a terminal obeys reached it.
    expect(d.stdout.output()).not.toContain(ESC_)
    expect(d.stdout.output()).toContain('FOO-43 ok')
  })

  it('titles every row of a log that spells one ticket two ways', async () => {
    // THE SAME DEFECT AS `titlesFor`'s, AT THE LEVEL A READER SEES IT. issues.jsonl is
    // append-only and nothing normalizes `task_key` on the way in, so one file can name one
    // ticket `foo-41` and `FOO-41`; both are drawn, because `numberText` prints the recorded key
    // verbatim. `titlesFor` asked acli ONE right question, `key IN (FOO-41, FOO-43)`, and that
    // part was never in doubt.
    //
    // MEASURED BEFORE THE FIX: the answer was keyed by the FIRST spelling only, so the second
    // row rendered blank beside a row that proved the summary had been fetched —
    //
    //     task                       verdict     cost      time
    //     foo-41 one ticket, twice   ✅ pass     $1.00     60min
    //     FOO-41                     ✅ pass     $1.00     60min
    //     FOO-43 the row component   🔄 live     –         ~40min
    //
    // — with the middle cell empty. `titlesFor` now keys its map by EVERY spelling that
    // normalized to the answered key, because those keys are the handles the rows look up by, so
    // both rows carry the summary. The two assertions at the foot of this test are what measure
    // that end to end, through the DEFAULT resolver rather than a stub.
    const d = jiraLive({
      log: [jiraEvent(41, 'foo-41', { ts: 1 }), jiraEvent(41, 'FOO-41', { ts: 2 })].join(TITLE_LF) + TITLE_LF,
      exec: makeTitleExec({
        titleSearch: board(['FOO-41', 'one ticket, twice'], ['FOO-43', 'the row component']),
      }),
    })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    // The QUESTION is right and stays asserted: one call, one mention of the ticket.
    expect(d.exec.searches()).toHaveLength(1)
    expect(d.exec.searches()[0].args).toContain('key IN (FOO-41, FOO-43)')
    // It was the ANSWER that left a row blank. Both spellings name the same ticket, and a
    // reader looking at two rows of one board expects two titles.
    const lines = d.stdout.lines()
    const rows = lines.filter((line) => line.includes('FOO-41') || line.includes('foo-41'))
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row, row).toContain('one ticket, twice')
  })
})
