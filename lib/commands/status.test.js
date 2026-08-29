import { describe, it, expect } from 'vitest'
import {
  formatClock,
  formatElapsed,
  padTaskNumber,
  reconcileMode,
  renderStatus,
  statusCommand,
} from './status.js'
import { sessionNameFor } from '../lock.js'
import { metricsPath } from '../issue-metrics.js'
import { digestLogPath } from '../digest-file.js'
import { formatHistoryEntry } from '../digest.js'

const REPO = '/repo'
const SESSION = 'ralph-ralph-b36ff7b1'

// Fixtures are built with LOCAL Date constructors on purpose: the rendered
// `started 16:20` is a wall-clock reading, so a UTC ISO fixture would make the
// expectation timezone-dependent and the suite red outside UTC.
const RUN_STARTED = new Date(2026, 7, 25, 16, 20, 0)
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime() // 3h12m into the run, 40min into the task
const RUN_FINISHED = new Date(2026, 7, 25, 14, 2, 0)

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
}

const runningRecord = (overrides = {}) => ({
  schema: 1,
  run_id: SESSION,
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

const terminalRecord = (overrides = {}) => ({
  ...runningRecord(),
  status: 'partial',
  finished_at: RUN_FINISHED.toISOString(),
  ok: 2,
  failed: 1,
  ...overrides,
})

// exec: git rev-parse answers the repo root, tmux has-session decides session
// liveness, gh issue list answers the github queue count, acli answers the jira one.
// Every call is recorded so a test can prove folder mode never shells out to gh — and
// that jira mode counts through acli rather than through `gh issue list` (#126).
//
// gitRoot: '' is the default (exit 0, empty stdout → the command keeps its cwd);
// a string is the toplevel a nested cwd resolves to; null means "not a git repo".
function makeExec({
  sessionAlive = true,
  ghQueue = '6',
  ghExitCode = 0,
  gitRoot = '',
  acliCount = '4',
  acliExitCode = 0,
} = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'git' && args[0] === 'rev-parse') {
      return { exitCode: gitRoot === null ? 1 : 0, stdout: gitRoot ?? '', stderr: '' }
    }
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: sessionAlive ? 0 : 1, stdout: '', stderr: '' }
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return { exitCode: ghExitCode, stdout: ghQueue, stderr: '' }
    }
    if (cmd === 'acli') {
      return { exitCode: acliExitCode, stdout: acliCount, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

const baseDeps = (overrides = {}) => {
  const stdout = makeStream()
  return {
    cwd: REPO,
    stdout,
    exec: makeExec(),
    // No ralph.config.sh → the source resolves to github (the default).
    exists: () => false,
    readFile: () => '',
    readRunState: () => runningRecord(),
    folderQueueCount: async () => 6,
    // No cycle lock unless a test says otherwise — injected, like start.js does
    // it, so no unit test ever reads the machine's real lock directory.
    peekLock: () => null,
    now: () => NOW,
    // RALPH_BANNER=off, so every expectation in this file is a statement about the REPORT
    // and nothing else (#76). The identity box prints above it by default, and the exact
    // `lines()` lists below would otherwise all be three lines of frame plus a blank out of
    // date — for a picture whose own behaviour they assert nothing about. The box's own
    // suite is status.identity-box.test.js, which covers the default-on path properly and
    // pins the report under the box as byte-identical to what this knob produces here. The
    // knob is turned off here rather than in the hermetic env for the whole worker on
    // purpose: it is a fact about what THESE tests are measuring, and it should be readable
    // in the file that relies on it.
    processEnv: { RALPH_BANNER: 'off' },
    ...overrides,
  }
}

// TASK_SOURCE=folder read from ralph.config.sh, exactly as `ralph start` does.
const folderDeps = (overrides = {}) =>
  baseDeps({
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : ''),
    ...overrides,
  })

describe('statusCommand — a live run (#55)', () => {
  it('prints the mode, run id, elapsed, in-flight task, queue depth and the tmux lines', async () => {
    const deps = baseDeps()
    const result = await statusCommand(deps)
    const out = deps.stdout.output()

    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('running')
    expect(out).toContain(`▸ ralph — running · run ${SESSION} (started 16:20, 3h12m ago)`)
    // #56 folded #55's `in flight` row into the progress line and gave the task a row of
    // its own. Nothing is lost — the number and its elapsed are still both here — and the
    // denominator says what the fraction is against: 0 done, 1 in flight, 6 waiting.
    // No `titles` reach the table (the fake `gh` answers this file's queue query, not a
    // list of issues), so the rows carry numbers alone, which is the shape a repo with no
    // `gh` and the shape `--json` both get.
    expect(out).toContain('  progress   0/7 done · #031 in flight (40min)  [────────] 0%')
    expect(out).toContain('  #031  🔄 live     –         ~40min')
    expect(out).toContain('  queue      6 waiting')
    expect(out).toContain(`  attach     tmux attach -t ${SESSION}`)
    expect(out).toContain('  kill       ralph stop')
  })

  it('counts the github queue with the same search query the loop and start use', async () => {
    const deps = baseDeps()
    await statusCommand(deps)
    const ghCall = deps.exec.calls.find((c) => c.cmd === 'gh')
    expect(ghCall).toBeTruthy()
    expect(ghCall.args.join(' ')).toContain(
      'state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge',
    )
    expect(ghCall.options.reject).toBe(false)
  })

  it('probes the session RECORDED by the run, not the one a new start would create', async () => {
    const deps = baseDeps({
      readRunState: () => runningRecord({ session: 'ralph-other-deadbeef' }),
    })
    await statusCommand(deps)
    const probe = deps.exec.calls.find((c) => c.cmd === 'tmux' && c.args[0] === 'has-session')
    expect(probe.args).toEqual(['has-session', '-t', 'ralph-other-deadbeef'])
  })

  it('falls back to this repo’s session name when the record has none', async () => {
    const deps = baseDeps({ readRunState: () => runningRecord({ session: null }) })
    await statusCommand(deps)
    const probe = deps.exec.calls.find((c) => c.cmd === 'tmux' && c.args[0] === 'has-session')
    expect(probe.args).toEqual(['has-session', '-t', sessionNameFor(REPO)])
  })

  it('states there is no task yet when the run has not begun one', async () => {
    const deps = baseDeps({ readRunState: () => runningRecord({ current: null }) })
    await statusCommand(deps)
    // #56's wording for the same fact, and the denominator drops with the flight: 6
    // waiting and nothing being worked on is a queue of 6, not of 7.
    expect(deps.stdout.output()).toContain('  progress   0/6 done · nothing in flight')
    // ...and NO table, rather than a header over nothing: a run between tasks with no
    // completed ones yet has no row to print, and an empty grid fenced by two blank
    // lines would be worse than its absence.
    expect(deps.stdout.output()).not.toContain('verdict')
  })
})

// #57 — the numbers that make `ralph status` worth running before bed. The
// arithmetic itself is covered in lib/progress.test.js; these tests only prove
// the wiring: the shell reads issues.jsonl from the RUN's root, hands the text to
// the pure path, and never lets a failed read break a read-only view.
describe('statusCommand — pace, ETA and spend (#57)', () => {
  const MIN = 60000
  const metricsEvent = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)
  // The issue's worked example, scoped to the run the record names.
  const METRICS = [
    metricsEvent({ issue_number: 29, run_id: SESSION, ts: 1, duration_ms: 97 * MIN, total_cost_usd: 34.1 }),
    metricsEvent({ issue_number: 30, run_id: SESSION, ts: 2, duration_ms: 71 * MIN, total_cost_usd: 28.75 }),
  ].join('\n')

  const metricsDeps = (overrides = {}) =>
    baseDeps({
      readFile: (p) => (String(p).endsWith('issues.jsonl') ? METRICS : ''),
      ...overrides,
    })

  it('prints the pace, the ETA with its range and the spend below the queue depth', async () => {
    const deps = metricsDeps()
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    const lines = deps.stdout.lines()
    // The whole block #56 made of it, in order: the fraction over the live denominator,
    // the two finished tasks it counted and the one in flight, then the counted queue and
    // the three derived rows. `2/9` and the two `✅`-less rows are the same two events —
    // these fixtures record a duration and a cost but no verdict, so the table says
    // `unknown` rather than assuming a pass, exactly as the numbers do elsewhere.
    expect(lines.slice(1, 12)).toEqual([
      '  progress   2/9 done · #031 in flight (40min)  [██──────] 22%',
      '',
      '  task  verdict     cost      time',
      '  #029  ❔ unknown  $34.10    97min',
      '  #030  ❔ unknown  $28.75    71min',
      '  #031  🔄 live     –         ~40min',
      '',
      '  queue      6 waiting',
      '  pace       ~84 min/task · $31.4/task',
      '  eta        ~9h08m left → ~04:40  (±1h30m)',
      '  spend      $62.85 so far · ~$250 projected',
    ])
  })

  it('reads issues.jsonl from the run’s root, not the cwd', async () => {
    const read = []
    const deps = baseDeps({
      cwd: '/repo/sub/deeper',
      exec: makeExec({ gitRoot: `${REPO}\n` }),
      readFile: (p) => {
        read.push(String(p))
        return String(p).endsWith('issues.jsonl') ? METRICS : ''
      },
    })
    await statusCommand(deps)
    expect(read).toContain(metricsPath(REPO))
    expect(deps.stdout.output()).toContain('  pace       ~84 min/task · $31.4/task')
  })

  it('degrades to unknown when the metrics read throws, still exiting 0', async () => {
    const deps = metricsDeps({
      readFile: (p) => {
        if (String(p).endsWith('issues.jsonl')) throw new Error('EACCES: permission denied')
        return ''
      },
    })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    const out = deps.stdout.output()
    expect(out).toContain('  pace       unknown')
    expect(out).toContain('  eta        unknown')
    expect(out).toContain('  spend      unknown')
  })

  it('says unknown for the ETA when the queue count failed, keeping the recorded spend', async () => {
    const deps = metricsDeps({ exec: makeExec({ ghExitCode: 1, ghQueue: '' }) })
    await statusCommand(deps)
    const out = deps.stdout.output()
    expect(out).toContain('  queue      unknown')
    expect(out).toContain('  eta        unknown')
    expect(out).toContain('  spend      $62.85 so far')
  })

  it('never reads the metrics file for never-run — there is no run to report on', async () => {
    // Idle and interrupted DO read it now (#59: the report card is built from the
    // ended run's own events), so the property that survives is the one about a
    // repo that has never run ralph: it must cost nothing at all.
    const read = []
    const deps = baseDeps({
      readRunState: () => null,
      readFile: (p) => {
        read.push(String(p))
        return ''
      },
    })
    await statusCommand(deps)
    expect(read).toEqual([])
  })
})

// #63 — the run's latest digest, inside the view that already prints its numbers.
// The parse, the staleness rule and the wrapping are pinned in
// lib/digest-history.test.js; these tests only prove the WIRING: the shell reads
// .ralph/digest.log at the RUN's root, scopes it to the run in flight, renders it
// between the progress rows and the attach pair, and never lets a history file be
// the thing that breaks a read-only view.
describe('statusCommand — the run’s latest digest in the live view (#63)', () => {
  const DIGEST_AT = new Date(NOW - 12 * 60000).toISOString() // `12min ago`
  const NARRATIVE = [
    '#031 is in the TDD red phase, editing SettingsRowDescriptor.swift.',
    'Suite went 1454 → 1598 passing.',
  ].join('\n')

  // Written by the writer, never hand-typed: the reader is only worth testing
  // against bytes a digest would actually have appended.
  const history = (overrides = {}) =>
    formatHistoryEntry({
      at: DIGEST_AT,
      runId: SESSION,
      task: '#031',
      model: 'claude-haiku-4-5',
      narrative: NARRATIVE,
      ...overrides,
    })

  const digestDeps = (text = history(), overrides = {}) =>
    baseDeps({
      readFile: (p) => (String(p).endsWith('digest.log') ? text : ''),
      ...overrides,
    })

  it('prints the digest, its age and its model between the spend row and the attach pair', async () => {
    const deps = digestDeps()
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    const lines = deps.stdout.lines()
    // Anchored on the row this test NAMES rather than on a line number, because #56 put a
    // table between the heading and the queue and pushed the whole block down by four.
    // The number was only ever a proxy for "straight after the spend row"; the anchor says
    // that, and survives the next line the view grows above it.
    const spend = lines.findIndex((line) => line.startsWith('  spend '))
    expect(spend, 'the spend row the digest sits under is gone').toBeGreaterThan(-1)
    expect(lines[spend + 1]).toBe('')
    expect(lines[spend + 2]).toMatch(/^ {2}── digest \(12min ago · claude-haiku-4-5\) ─+$/)
    expect(lines.slice(spend + 3, spend + 6)).toEqual([
      '  #031 is in the TDD red phase, editing',
      '  SettingsRowDescriptor.swift.',
      '  Suite went 1454 → 1598 passing.',
    ])
    expect(lines.slice(spend + 6)).toEqual([
      '',
      `  attach     tmux attach -t ${SESSION}`,
      '  kill       ralph stop',
    ])
  })

  it('reads .ralph/digest.log at the RUN’s root, not the cwd', async () => {
    const read = []
    const deps = baseDeps({
      cwd: '/repo/sub/deeper',
      exec: makeExec({ gitRoot: `${REPO}\n` }),
      readFile: (p) => {
        read.push(String(p))
        return String(p).endsWith('digest.log') ? history() : ''
      },
    })
    await statusCommand(deps)
    expect(read).toContain(digestLogPath(REPO))
    expect(deps.stdout.output()).toContain('── digest (12min ago')
  })

  it('shows the PREVIOUS run’s digest nowhere — the view is byte-identical without it', async () => {
    const stale = digestDeps(history({ runId: 'ralph-ralph-0000dead' }))
    await statusCommand(stale)
    const none = baseDeps()
    await statusCommand(none)
    expect(stale.stdout.output()).toBe(none.stdout.output())
  })

  it('omits the section entirely for an unreadable or malformed history', async () => {
    const none = baseDeps()
    await statusCommand(none)
    const cases = {
      throws: digestDeps('', {
        readFile: (p) => {
          if (String(p).endsWith('digest.log')) throw new Error('EACCES: permission denied')
          return ''
        },
      }),
      empty: digestDeps(''),
      junk: digestDeps('half a file a human edited\nno heading anywhere\n'),
    }
    for (const [why, deps] of Object.entries(cases)) {
      const result = await statusCommand(deps)
      expect(result.exitCode, why).toBe(0)
      expect(deps.stdout.output(), why).toBe(none.stdout.output())
    }
  })

  it('marks a digest stale against the interval ralph.config.sh configures, read once', async () => {
    const reads = []
    const deps = baseDeps({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: (p) => {
        reads.push(String(p))
        if (String(p).endsWith('ralph.config.sh')) return 'RALPH_DIGEST_INTERVAL="5m"\n'
        return String(p).endsWith('digest.log') ? history() : ''
      },
    })
    await statusCommand(deps)
    // 12min old against a 5m interval: two intervals late, and said so.
    expect(deps.stdout.output()).toContain('── digest (12min ago · claude-haiku-4-5 · stale)')
    // ONE read of the config, for the two settings this command needs out of it.
    expect(reads.filter((p) => p.endsWith('ralph.config.sh'))).toHaveLength(1)
  })

  it('never reads the history for idle, interrupted or never-run', async () => {
    // A finished run's narration belongs to its report card, not to the live view,
    // and never-run must still cost nothing at all.
    for (const [why, overrides] of [
      ['idle', { readRunState: () => terminalRecord() }],
      ['interrupted', { exec: makeExec({ sessionAlive: false }) }],
      ['never-run', { readRunState: () => null }],
    ]) {
      const read = []
      const deps = baseDeps({
        readFile: (p) => {
          read.push(String(p))
          return ''
        },
        ...overrides,
      })
      await statusCommand(deps)
      expect(read.filter((p) => p.endsWith('digest.log')), why).toEqual([])
    }
  })

  it('renders from a digest view handed in as a parameter, with no I/O of its own', () => {
    // Same seam as `progress` and `postMortem`: the shell builds it, the renderer
    // is handed it, so `--json` and the terminal cannot describe different digests.
    const lines = renderStatus({
      mode: 'running',
      record: runningRecord(),
      session: SESSION,
      queue: 6,
      now: NOW,
      digest: { atMs: NOW - 12 * 60000, ageMs: 12 * 60000, model: 'haiku', task: '#031', stale: false, narrative: 'narrated' },
    })
    // Same spend anchor as the wiring test above, for the same reason.
    const spend = lines.findIndex((line) => line.startsWith('  spend '))
    expect(lines.slice(spend + 1, spend + 4)).toEqual([
      '',
      lines[spend + 2],
      '  narrated',
    ])
    expect(lines[spend + 2]).toMatch(/^ {2}── digest \(12min ago · haiku\) ─+$/)
    expect(lines.slice(spend + 4)).toEqual([
      '',
      `  attach     tmux attach -t ${SESSION}`,
      '  kill       ralph stop',
    ])
  })

  it('renders the live view unchanged when no digest is passed at all', () => {
    // 13 since #56: #55's nine, plus the table's own four (a blank, its header, the row
    // for the task in flight, a blank). The count is the point — an absent digest must
    // add NOTHING, not an empty section — so it moves whenever the view does.
    expect(renderStatus({ mode: 'running', record: runningRecord(), session: SESSION, queue: 6, now: NOW })).toHaveLength(13)
  })
})

// #59 — the morning-after view. The card's arithmetic is pinned in
// lib/post-mortem.test.js; these tests prove the WIRING: idle and interrupted now
// count the queue and read issues.jsonl at the run's root and render a report card
// from what they find, while never-run still reads nothing at all.
describe('statusCommand — the idle post-mortem and the never-run pointer (#59)', () => {
  const OVERNIGHT_STARTED = new Date(2026, 7, 25, 4, 10, 0) // 9h52m before 14:02
  const metricsEvent = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)
  // Three of the ended run's tasks, two of them not passes: #034 failed outright
  // and #041 came back indeterminate, which the loop counts as a failure too.
  const NIGHT = [
    metricsEvent({ issue_number: 34, run_id: SESSION, ts: 1, verdict: 'fail', total_cost_usd: 20 }),
    metricsEvent({ issue_number: 41, run_id: SESSION, ts: 2, verdict: 'unknown', total_cost_usd: 20 }),
    metricsEvent({ issue_number: 42, run_id: SESSION, ts: 3, verdict: 'pass', total_cost_usd: 20 }),
  ].join('\n')

  const idleRecord = (overrides = {}) =>
    terminalRecord({ started_at: OVERNIGHT_STARTED.toISOString(), ok: 7, failed: 2, ...overrides })

  const cardDeps = (overrides = {}) =>
    baseDeps({
      readRunState: () => idleRecord(),
      readFile: (p) => (String(p).endsWith('issues.jsonl') ? NIGHT : ''),
      ...overrides,
    })

  it('prints the report card: outcome, spend, wall clock, queue and a start hint', async () => {
    const deps = cardDeps()
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('idle')
    expect(deps.stdout.lines()).toEqual([
      `▸ ralph — idle · run ${SESSION} (finished 14:02, 5h30m ago)`,
      '  outcome    7 ok · 2 failed  — #034 #041',
      '  spend      $60.00 total · $20.0/task avg',
      '  ran for    9h52m',
      '  queue      6 waiting',
      '',
      '  start      ralph start',
    ])
  })

  it('counts the queue and reads issues.jsonl at the RUN’s root for an idle repo', async () => {
    const read = []
    const deps = cardDeps({
      cwd: '/repo/sub/deeper',
      exec: makeExec({ gitRoot: `${REPO}\n` }),
      readFile: (p) => {
        read.push(String(p))
        return String(p).endsWith('issues.jsonl') ? NIGHT : ''
      },
    })
    const result = await statusCommand(deps)
    expect(result.queue).toBe(6)
    expect(read).toContain(metricsPath(REPO))
    expect(deps.exec.calls.filter((c) => c.cmd === 'gh').length).toBe(1)
  })

  it('prints no failed-numbers list for a run that failed nothing', async () => {
    const clean = metricsEvent({
      issue_number: 42,
      run_id: SESSION,
      ts: 1,
      verdict: 'pass',
      total_cost_usd: 20,
    })
    const deps = cardDeps({
      readRunState: () => idleRecord({ status: 'success', ok: 7, failed: 0 }),
      readFile: (p) => (String(p).endsWith('issues.jsonl') ? clean : ''),
    })
    await statusCommand(deps)
    const outcome = deps.stdout.lines()[1]
    expect(outcome).toBe('  outcome    7 ok · 0 failed')
    // An empty `—` would read as a list the renderer forgot to fill in.
    expect(outcome).not.toContain('—')
    expect(outcome).not.toContain('#')
  })

  it('renders an interrupted run as a report card of what it completed', async () => {
    // A hard-killed run never reached endRun, so it has no counts of its own and no
    // finish: the card tallies its events and says `unknown` for the rest.
    const deps = cardDeps({
      exec: makeExec({ sessionAlive: false }),
      readRunState: () => runningRecord(),
    })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('interrupted')
    expect(deps.stdout.lines()).toEqual([
      `▸ ralph — interrupted · run ${SESSION} (finished unknown)`,
      '  outcome    1 ok · 2 failed  — #034 #041',
      '  spend      $60.00 total · $20.0/task avg',
      '  ran for    unknown',
      '  queue      6 waiting',
      // With no finish to anchor it, the start is the reading that tells a reader
      // whether this run died minutes ago or last week — and `current` survives the
      // kill, so the task it died on is on the record too.
      '  started    16:20, 3h12m ago',
      '  last task  #031',
      '',
      '  restart    ralph start',
    ])
  })

  it('renders a partially written terminal record without throwing', async () => {
    // An older format, or a record truncated by the kill that ended the run, plus a
    // metrics file this reader cannot open: every unknown reads as `unknown`.
    const deps = cardDeps({
      readRunState: () => ({ status: 'success', run_id: SESSION }),
      exec: makeExec({ ghExitCode: 1, ghQueue: '' }),
      readFile: (p) => {
        if (String(p).endsWith('issues.jsonl')) throw new Error('EACCES: permission denied')
        return ''
      },
    })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stdout.lines()).toEqual([
      `▸ ralph — idle · run ${SESSION} (finished unknown)`,
      '  outcome    unknown',
      '  spend      unknown',
      '  ran for    unknown',
      '  queue      unknown',
      '',
      '  start      ralph start',
    ])
  })

  it('points a never-run repo at `ralph start` in one line, reading nothing at all', async () => {
    const read = []
    const deps = cardDeps({
      readRunState: () => null,
      readFile: (p) => {
        read.push(String(p))
        return ''
      },
    })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('never-run')
    const lines = deps.stdout.lines()
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('ralph start')
    expect(read).toEqual([])
    expect(deps.exec.calls.some((c) => c.cmd === 'gh')).toBe(false)
  })
})

describe('statusCommand — folder task source (#55)', () => {
  it('counts the queue via the folder-queue module and never calls gh', async () => {
    const deps = folderDeps({ folderQueueCount: async () => 4 })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stdout.output()).toContain('  queue      4 waiting')
    // ZERO gh calls, still — which since #56 covers two of them. The task table's titles
    // come from `gh issue list` as well, and a folder-mode repo may not have a github
    // remote at all: numbering the rows from the metrics file is the only honest reading
    // there, and it is what makes this a property of the mode rather than of one call.
    expect(deps.exec.calls.some((c) => c.cmd === 'gh')).toBe(false)
  })

  it('renders the same live view in folder mode', async () => {
    const deps = folderDeps({
      readRunState: () => runningRecord({ source: 'folder' }),
      folderQueueCount: async () => 4,
    })
    await statusCommand(deps)
    const out = deps.stdout.output()
    expect(out).toContain(`▸ ralph — running · run ${SESSION} (started 16:20, 3h12m ago)`)
    // The folder's own count is the denominator, and the table is the same table — with
    // numbers for titles, which is all a folder task has.
    expect(out).toContain('  progress   0/5 done · #031 in flight (40min)  [────────] 0%')
    expect(out).toContain('  #031  🔄 live     –         ~40min')
  })
})

// TASK_SOURCE=jira with the eligibility query beside it, read out of the SAME
// ralph.config.sh this command already reads once (#126).
const jiraDeps = (overrides = {}) =>
  baseDeps({
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) =>
      String(p).endsWith('ralph.config.sh')
        ? 'TASK_SOURCE=jira\nJIRA_JQL="project = RALPH AND statusCategory != Done"\n'
        : '',
    ...overrides,
  })

describe('statusCommand — jira task source (#126)', () => {
  it('counts the queue through the jira seam and reports it as the live denominator', async () => {
    const asked = []
    const folderAsked = []
    const deps = jiraDeps({
      jiraQueueCount: async (args) => {
        asked.push(args)
        return 4
      },
      // Rigged to answer a DIFFERENT number, so "the folder seam is not consulted" is an
      // assertion below rather than a hope.
      folderQueueCount: async (args) => {
        folderAsked.push(args)
        return 6
      },
    })
    const result = await statusCommand(deps)
    const out = deps.stdout.output()

    expect(result.exitCode).toBe(0)
    expect(result.queue).toBe(4)
    expect(out).toContain('  queue      4 waiting')
    // The DENOMINATOR is the Jira number, not github's 6: 0 done, 1 in flight, 4 waiting.
    expect(out).toContain('  progress   0/5 done · #031 in flight (40min)  [────────] 0%')
    // The seam is handed the user's clause verbatim — composing Ralph's half is the
    // library's job, and doing it here would put the grammar in two places.
    expect(asked).toHaveLength(1)
    expect(asked[0].jql).toBe('project = RALPH AND statusCategory != Done')
    // github's queue query is NOT run: two counts would be two answers.
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh issue list --search'))).toBe(false)
    // ...and the folder seam is not consulted either: one source, one count.
    expect(folderAsked).toEqual([])
  })

  it('reaches the real jira-queue library by default, through the command’s own exec', async () => {
    // No jiraQueueCount injected: this is the wiring test for the DEFAULT seam, and the
    // only thing standing between it and a real `acli` is the injected exec — which is
    // exactly the seam every other spawn in this file goes through.
    const deps = jiraDeps({ exec: makeExec({ acliCount: '9' }) })
    await statusCommand(deps)
    expect(deps.stdout.output()).toContain('  queue      9 waiting')
    const acli = deps.exec.calls.filter((c) => c.cmd === 'acli')
    expect(acli).toHaveLength(1)
    expect(acli[0].args).toContain('--count')
    const sent = acli[0].args[acli[0].args.indexOf('--jql') + 1]
    expect(sent).toContain('project = RALPH AND statusCategory != Done')
    expect(sent).toContain('labels NOT IN (in-progress, done, failed, do-not-ralph)')
  })

  it('--json carries the same number the human line printed', async () => {
    const deps = jiraDeps({ json: true, jiraQueueCount: async () => 4 })
    await statusCommand(deps)
    const doc = JSON.parse(deps.stdout.output())
    expect(doc.progress.remaining).toBe(4)
    expect(doc.progress.total).toBe(5)
  })

  it('reports an unknown queue rather than 0 when the jira count cannot be taken', async () => {
    // This command's posture, unchanged: `null` renders as `unknown`, because "nobody
    // could look" and "nothing is waiting" are different findings (`ralph cycle` reads
    // the same failure as 0, since a cycle with no provable work has nothing to do).
    for (const jiraQueueCount of [
      async () => null,
      async () => {
        throw new Error('acli exploded')
      },
    ]) {
      const deps = jiraDeps({ jiraQueueCount })
      const result = await statusCommand(deps)
      expect(result.exitCode).toBe(0)
      expect(result.queue).toBe(null)
      expect(deps.stdout.output()).toContain('  queue      unknown')
    }
  })

  it('reports an unknown queue — not 0 waiting — when the config carries no JIRA_JQL', async () => {
    // A source with no query is "we could not look", which is the distinction this row
    // exists to make. And nothing is spawned: a bare exclusion would select every ticket
    // on the Jira site, so the composer refuses before acli is ever reached.
    const deps = baseDeps({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=jira\n' : ''),
    })
    const result = await statusCommand(deps)
    expect(result.queue).toBe(null)
    expect(deps.stdout.output()).toContain('  queue      unknown')
    expect(deps.exec.calls.some((c) => c.cmd === 'acli')).toBe(false)
  })
})

describe('statusCommand — a run whose session is gone (#55)', () => {
  it('reports interrupted, never running, when run-state says running but tmux has no session', async () => {
    // #59 changed WHAT this mode prints — the report card of what the killed run
    // managed, not the live view's in-flight task and pace, because a run that will
    // never pick up another task has no pace left to report. What did not change:
    // the mode itself, the queue depth, and that the dead attach/kill pair is
    // replaced by a restart hint.
    const deps = baseDeps({ exec: makeExec({ sessionAlive: false }) })
    const result = await statusCommand(deps)
    const out = deps.stdout.output()
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('interrupted')
    expect(out).toContain(`▸ ralph — interrupted · run ${SESSION} (finished unknown)`)
    expect(out).not.toContain('running')
    expect(out).toContain('  queue      6 waiting')
    // The attach/kill pair is dead advice with no session — point at a restart.
    expect(out).toContain('  restart    ralph start')
    expect(out).not.toContain('tmux attach')
    // The live view's own lines belong to the run in flight, not to this one.
    expect(out).not.toContain('in flight')
    expect(out).not.toContain('eta')
  })
})

// tmux is only ONE of the loop's two launchers. `ralph cycle` spawns the same
// loop with no session at all (it records the default `ralph`), so a probe that
// only asks tmux calls every scheduled run interrupted for its whole duration —
// and then advises `ralph start`, which the same CLI refuses while the cycle lock
// is held. The cycle lock is the second liveness source.
describe('statusCommand — a scheduled (ralph cycle) run is alive (#55)', () => {
  it('reports running, not interrupted, when tmux has no session but the cycle lock is alive', async () => {
    const deps = baseDeps({
      exec: makeExec({ sessionAlive: false }),
      peekLock: () => ({ holder: { pid: 4242, startedAt: RUN_STARTED.toISOString() }, alive: true }),
    })
    const result = await statusCommand(deps)
    const out = deps.stdout.output()

    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('running')
    expect(out).toContain(`▸ ralph — running · run ${SESSION} (started 16:20, 3h12m ago)`)
    expect(out).toContain('  progress   0/7 done · #031 in flight (40min)  [────────] 0%')
    // Nothing to attach to and nothing `ralph stop` could kill: a scheduled run
    // must not be advised with tmux lines, nor with the `ralph start` the lock
    // itself would refuse.
    expect(out).not.toContain('tmux attach')
    expect(out).not.toContain('ralph stop')
    expect(out).not.toContain('restart    ralph start')
    expect(out).toContain('  logs       tail -f logs/ralph-cycle.out.log')
  })

  it('still reports interrupted when the lock holder is dead (a crashed cycle)', async () => {
    const deps = baseDeps({
      exec: makeExec({ sessionAlive: false }),
      peekLock: () => ({ holder: { pid: 4242, startedAt: RUN_STARTED.toISOString() }, alive: false }),
    })
    const result = await statusCommand(deps)
    expect(result.mode).toBe('interrupted')
    expect(deps.stdout.output()).toContain('  restart    ralph start')
  })

  it('does not pay for a lock read when tmux already confirmed the session', async () => {
    let peeks = 0
    const deps = baseDeps({
      peekLock: () => {
        peeks += 1
        return null
      },
    })
    const result = await statusCommand(deps)
    expect(result.mode).toBe('running')
    expect(peeks).toBe(0)
  })

  it('survives a lock read that throws, rather than failing the whole view', async () => {
    const deps = baseDeps({
      exec: makeExec({ sessionAlive: false }),
      peekLock: () => {
        throw new Error('EACCES: permission denied, open lock')
      },
    })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('interrupted')
  })
})

// The record is written by a process anchored at the git toplevel (the loop's
// PROJECT_ROOT), and `ralph cycle` / `ralph schedule` resolve that same toplevel.
// A reader that anchors on the cwd instead reports `never-run` from any
// subdirectory while a run is live — and that false line ends in "start one with
// `ralph start`", which from a subdirectory launches a SECOND loop on the repo.
describe('statusCommand — anchors on the git toplevel, not the cwd (#55)', () => {
  const NESTED = '/repo/sub/deeper'

  const nestedDeps = (overrides = {}) => {
    const seen = []
    const deps = baseDeps({
      cwd: NESTED,
      exec: makeExec({ gitRoot: `${REPO}\n` }),
      // Only the run's own root holds the record, exactly as on disk.
      readRunState: (root) => {
        seen.push(root)
        return root === REPO ? runningRecord() : null
      },
      ...overrides,
    })
    deps.seen = seen
    return deps
  }

  it('finds the record written at the root when run from a nested directory', async () => {
    const deps = nestedDeps()
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('running')
    expect(deps.seen).toEqual([REPO])
    expect(deps.stdout.output()).not.toContain('never-run')
  })

  it('resolves the root with a read-only git probe that never rejects', async () => {
    const deps = nestedDeps()
    await statusCommand(deps)
    const probe = deps.exec.calls.find((c) => c.cmd === 'git')
    expect(probe.args).toEqual(['rev-parse', '--show-toplevel'])
    expect(probe.options.cwd).toBe(NESTED)
    expect(probe.options.reject).toBe(false)
  })

  it('peeks the cycle lock at the root, the path the cycle itself keyed it on', async () => {
    const peeked = []
    const deps = nestedDeps({
      exec: makeExec({ gitRoot: `${REPO}\n`, sessionAlive: false }),
      peekLock: (root) => {
        peeked.push(root)
        return { holder: { pid: 7 }, alive: true }
      },
    })
    const result = await statusCommand(deps)
    expect(peeked).toEqual([REPO])
    expect(result.mode).toBe('running')
  })

  it('falls back to the repo root session name from a nested cwd', async () => {
    const deps = nestedDeps({
      readRunState: (root) => (root === REPO ? runningRecord({ session: null }) : null),
    })
    await statusCommand(deps)
    const probe = deps.exec.calls.find((c) => c.cmd === 'tmux')
    expect(probe.args).toEqual(['has-session', '-t', sessionNameFor(REPO)])
  })

  it('reads ralph.config.sh and the folder queue from the root, not the cwd', async () => {
    const folderCalls = []
    const configPaths = []
    const deps = nestedDeps({
      exists: (p) => {
        configPaths.push(String(p))
        return String(p).endsWith('ralph.config.sh')
      },
      readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : ''),
      folderQueueCount: async (args) => {
        folderCalls.push(args)
        return 4
      },
    })
    await statusCommand(deps)
    expect(configPaths).toContain(`${REPO}/ralph.config.sh`)
    expect(folderCalls).toEqual([{ cwd: REPO }])
  })

  it('degrades to the cwd outside a git repo, still exiting 0 with never-run', async () => {
    const deps = baseDeps({
      cwd: '/tmp/not-a-repo',
      exec: makeExec({ gitRoot: null }),
      readRunState: () => null,
    })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('never-run')
    expect(deps.stdout.output()).toContain('no run recorded yet')
  })
})

// #55 shipped these two modes as one line each. #59 replaced the idle line with the
// report card — the one-liner named the counts and nothing else, which was the whole
// complaint — and left the never-run pointer exactly as it was, because a repo with no
// record has nothing to report and nothing to read it from. The assertions below moved
// WITH that behaviour; the properties that outlived it (one line and no gh call for
// never-run, exit 0 in all four modes) are unchanged.
describe('statusCommand — the ended modes and never-run (#55, revised by #59)', () => {
  it('renders a report card, no longer one line, for a terminal record', async () => {
    const deps = baseDeps({ readRunState: () => terminalRecord() })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('idle')
    const lines = deps.stdout.lines()
    expect(lines[0]).toContain('idle')
    expect(lines[0]).toContain(SESSION)
    // The record's own counts, with no events on disk to name the failure by number —
    // the counts survive a rotated or missing issues.jsonl, the numbers cannot.
    expect(lines).toContain('  outcome    2 ok · 1 failed')
    expect(lines.at(-1)).toBe('  start      ralph start')
  })

  it('states never-run in one line when no record exists, without touching gh', async () => {
    const deps = baseDeps({ readRunState: () => null })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('never-run')
    const lines = deps.stdout.lines()
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('never-run')
    expect(deps.exec.calls.some((c) => c.cmd === 'gh')).toBe(false)
  })

  it('says unknown, not 0, for counts a truncated record never recorded', async () => {
    // Same rule run-state.js applies to the queue depth: an absent number is
    // unknown, and "0 failed" on a record that never said so is a lie. #59 only
    // changed the word — `?` in a one-liner became `unknown` in the card's column.
    const deps = baseDeps({ readRunState: () => terminalRecord({ ok: null, failed: undefined }) })
    await statusCommand(deps)
    const lines = deps.stdout.lines()
    expect(lines).toContain('  outcome    unknown')
    expect(lines.join('\n')).not.toContain('0 ok')
  })

  it('exits 0 in all four modes', async () => {
    const cases = [
      ['running', baseDeps()],
      ['interrupted', baseDeps({ exec: makeExec({ sessionAlive: false }) })],
      ['idle', baseDeps({ readRunState: () => terminalRecord() })],
      ['never-run', baseDeps({ readRunState: () => null })],
    ]
    for (const [mode, deps] of cases) {
      const result = await statusCommand(deps)
      expect(result.exitCode, `mode ${mode} must exit 0`).toBe(0)
      expect(result.mode).toBe(mode)
    }
  })
})

describe('statusCommand — a failing queue count degrades (#55)', () => {
  it('prints an unknown queue depth when gh fails', async () => {
    const deps = baseDeps({ exec: makeExec({ ghExitCode: 1, ghQueue: '' }) })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.queue).toBe(null)
    expect(deps.stdout.output()).toContain('  queue      unknown')
  })

  it('prints an unknown queue depth when the folder count throws', async () => {
    const deps = folderDeps({
      folderQueueCount: async () => {
        throw new Error('EACCES')
      },
    })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stdout.output()).toContain('  queue      unknown')
  })

  it('prints an unknown queue depth when gh answers with junk', async () => {
    const deps = baseDeps({ exec: makeExec({ ghQueue: 'rate limited' }) })
    await statusCommand(deps)
    expect(deps.stdout.output()).toContain('  queue      unknown')
  })

  it('degrades a broken run-state read to never-run instead of failing', async () => {
    const deps = baseDeps({ readRunState: () => null })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('never-run')
  })
})

// One rule over run-state × RUN liveness — deliberately not per-launcher: the
// caller decides how a run proves it is alive (tmux session, cycle lock), and
// this function only asks whether it did.
describe('reconcileMode — run-state × run liveness, one rule (#55)', () => {
  it('running record + live run => running', () => {
    expect(reconcileMode({ record: { status: 'running' }, runAlive: true })).toBe('running')
  })

  it('running record + dead run => interrupted', () => {
    expect(reconcileMode({ record: { status: 'running' }, runAlive: false })).toBe('interrupted')
  })

  it('a terminal record => idle, whatever the liveness probe says', () => {
    for (const status of ['success', 'partial', 'failed']) {
      expect(reconcileMode({ record: { status }, runAlive: true })).toBe('idle')
      expect(reconcileMode({ record: { status }, runAlive: false })).toBe('idle')
    }
  })

  it('no record => never-run', () => {
    expect(reconcileMode({ record: null, runAlive: true })).toBe('never-run')
    expect(reconcileMode({ record: undefined, runAlive: false })).toBe('never-run')
  })

  it('a record with no status reads as idle, never as in-flight', () => {
    expect(reconcileMode({ record: {}, runAlive: true })).toBe('idle')
  })
})

describe('renderStatus / formatters — pure, injected clock (#55)', () => {
  it('renders the live view as lines, with no I/O and no ambient clock', () => {
    const lines = renderStatus({
      mode: 'running',
      record: runningRecord(),
      session: SESSION,
      queue: 6,
      now: NOW,
    })
    expect(lines).toEqual([
      `▸ ralph — running · run ${SESSION} (started 16:20, 3h12m ago)`,
      // The default snapshot is built from the record and the queue alone — no metrics
      // text — so it knows of exactly one task: the one in flight. 0 of 7 done, an empty
      // bar, and a table of one row whose every measured column is an honest dash (#56).
      '  progress   0/7 done · #031 in flight (40min)  [────────] 0%',
      '',
      '  task  verdict     cost      time',
      '  #031  🔄 live     –         ~40min',
      '',
      '  queue      6 waiting',
      // No metrics text passed → nothing observed yet, so nothing invented (#57).
      '  pace       unknown',
      '  eta        unknown',
      '  spend      unknown',
      '',
      `  attach     tmux attach -t ${SESSION}`,
      '  kill       ralph stop',
    ])
  })

  it('swaps the tmux pair for scheduled-run advice when the run is not attachable', () => {
    const lines = renderStatus({
      mode: 'running',
      record: runningRecord(),
      session: SESSION,
      queue: 6,
      attachable: false,
      now: NOW,
    })
    expect(lines.slice(0, 11)).toEqual([
      `▸ ralph — running · run ${SESSION} (started 16:20, 3h12m ago)`,
      '  progress   0/7 done · #031 in flight (40min)  [────────] 0%',
      '',
      '  task  verdict     cost      time',
      '  #031  🔄 live     –         ~40min',
      '',
      '  queue      6 waiting',
      '  pace       unknown',
      '  eta        unknown',
      '  spend      unknown',
      '',
    ])
    expect(lines.slice(11)).toEqual([
      '  scheduled  ralph cycle run — no tmux session to attach to',
      '  logs       tail -f logs/ralph-cycle.out.log',
    ])
  })

  it('formatElapsed uses h+m past the hour and minutes below it', () => {
    expect(formatElapsed(0)).toBe('0min')
    expect(formatElapsed(40 * 60000)).toBe('40min')
    expect(formatElapsed(59 * 60000)).toBe('59min')
    expect(formatElapsed(60 * 60000)).toBe('1h00m')
    expect(formatElapsed((3 * 60 + 12) * 60000)).toBe('3h12m')
  })

  it('formatElapsed degrades on unknown or skewed input instead of printing NaN', () => {
    expect(formatElapsed(NaN)).toBe('unknown')
    expect(formatElapsed(null)).toBe('unknown')
    expect(formatElapsed(-5000)).toBe('0min')
  })

  it('formatClock prints a zero-padded wall clock and degrades on garbage', () => {
    expect(formatClock(new Date(2026, 7, 25, 6, 5, 0).getTime())).toBe('06:05')
    expect(formatClock(NaN)).toBe('--:--')
    expect(formatClock(undefined)).toBe('--:--')
  })

  it('formatClock degrades on an instant outside the calendar, not to NaN:NaN', () => {
    // Reachable from one corrupt `duration_ms` line: `now + etaMs` lands past year
    // 9999, where `new Date(ms)` has no reading to give and every getter answers
    // NaN. Finite, so the guard above never saw it. Same bounds the JSON surface
    // holds its `finish_at` to.
    expect(formatClock(1e16)).toBe('--:--')
    expect(formatClock(-1e16)).toBe('--:--')
    expect(formatClock(253402300799999)).not.toContain('NaN')
  })

  it('formatElapsed spells a huge magnitude out instead of in exponent notation', () => {
    // `${1.6e294}h` is not an elapsed anybody can read, and it is what a corrupt
    // duration printed before the hour count went through fixed notation.
    expect(formatElapsed(1e300)).not.toMatch(/e[+-]\d/)
    expect(formatElapsed(1e300)).toMatch(/^\d+h\d\dm$/)
  })

  it('padTaskNumber zero-pads to three digits and never truncates', () => {
    expect(padTaskNumber(31)).toBe('031')
    expect(padTaskNumber(7)).toBe('007')
    expect(padTaskNumber(1234)).toBe('1234')
    expect(padTaskNumber(null)).toBe('?')
  })
})
