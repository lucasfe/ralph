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

// The task table's titles (#56), as `gh issue list --state all --json number,title`
// answers them: the issue's worked example, so the rendered table is the one the
// issue asked for.
const TITLES_JSON = JSON.stringify([
  { number: 29, title: 'sidebar' },
  { number: 30, title: 'persist' },
  { number: 31, title: 'row comp' },
])

// exec: git rev-parse answers the repo root, tmux has-session decides session
// liveness, gh issue list answers the github queue count. Every call is recorded
// so a test can prove folder mode never shells out to gh.
//
// gitRoot: '' is the default (exit 0, empty stdout → the command keeps its cwd);
// a string is the toplevel a nested cwd resolves to; null means "not a git repo".
function makeExec({
  sessionAlive = true,
  ghQueue = '6',
  ghExitCode = 0,
  ghTitles = TITLES_JSON,
  ghTitlesExitCode = 0,
  gitRoot = '',
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
    // TWO `gh issue list` reads since #56, distinguished here rather than collapsed:
    // the queue COUNT (`--search`, answers a bare number) and the table's TITLES
    // (`--state all`, answers a JSON array). A mock that handed the count's `6` to the
    // title reader would only ever exercise the best-effort failure path.
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      if (args.includes('--state')) {
        return { exitCode: ghTitlesExitCode, stdout: ghTitles, stderr: '' }
      }
      return { exitCode: ghExitCode, stdout: ghQueue, stderr: '' }
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
    processEnv: {},
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
    // The task in flight, named on the progress line and rowed in the table (#56) —
    // the two surfaces that replaced #55's `in flight` line.
    expect(out).toContain('  progress   0/7 done · #031 in flight (40min)  [────────] 0%')
    expect(out).toContain('  #031 row comp  🔄 live     –         ~40min')
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
    const out = deps.stdout.output()
    expect(out).toContain('  progress   0/6 done · nothing in flight  [────────] 0%')
    // And no table at all (#56): a run between tasks has no row to draw, so the
    // header and its blank lines would be furniture over nothing.
    expect(out).not.toContain('verdict')
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
    metricsEvent({
      issue_number: 29,
      run_id: SESSION,
      ts: 1,
      duration_ms: 97 * MIN,
      total_cost_usd: 34.1,
      verdict: 'pass',
    }),
    metricsEvent({
      issue_number: 30,
      run_id: SESSION,
      ts: 2,
      duration_ms: 71 * MIN,
      total_cost_usd: 28.75,
      verdict: 'pass',
    }),
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
    // Anchored on the queue line rather than on a fixed offset from the heading: the
    // task table (#56) now stands between the progress line and the queue, and what
    // this test is about is that the three DERIVED lines follow the counted one, in
    // that order.
    const queueAt = lines.indexOf('  queue      6 waiting')
    expect(queueAt).toBeGreaterThan(-1)
    expect(lines.slice(queueAt, queueAt + 4)).toEqual([
      '  queue      6 waiting',
      '  pace       ~84 min/task · $31.4/task',
      '  eta        ~9h08m left → ~04:40  (±1h30m)',
      '  spend      $62.85 so far · ~$250 projected',
    ])
    // The progress line that replaced #55's `in flight` line (#56): same task, same
    // elapsed, plus the fraction of the live queue this run has closed.
    expect(lines[1]).toBe('  progress   2/9 done · #031 in flight (40min)  [██──────] 22%')
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

  it('prints the three lines for an interrupted run too', async () => {
    const deps = metricsDeps({ exec: makeExec({ sessionAlive: false }) })
    const result = await statusCommand(deps)
    expect(result.mode).toBe('interrupted')
    expect(deps.stdout.output()).toContain('  spend      $62.85 so far · ~$250 projected')
  })

  it('never reads the metrics file for idle or never-run', async () => {
    for (const readRunState of [() => terminalRecord(), () => null]) {
      const read = []
      const deps = baseDeps({
        readRunState,
        readFile: (p) => {
          read.push(String(p))
          return ''
        },
      })
      await statusCommand(deps)
      expect(read.some((p) => p.endsWith('issues.jsonl'))).toBe(false)
    }
  })
})

describe('statusCommand — folder task source (#55)', () => {
  it('counts the queue via the folder-queue module and never calls gh', async () => {
    const deps = folderDeps({ folderQueueCount: async () => 4 })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stdout.output()).toContain('  queue      4 waiting')
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
    expect(out).toContain('  progress   0/5 done · #031 in flight (40min)  [────────] 0%')
    // The table too — untitled, because a folder task's title lives inside its file
    // and lib/folder-queue.js exposes counts and paths only (#56).
    expect(out).toContain('  #031  🔄 live     –         ~40min')
  })
})

// #56 — the wiring of the task table. Its columns, its widths and its `–` are all
// covered in lib/progress.table.test.js; these tests only prove what the SHELL is
// responsible for: drawing the table under the progress line, and paying for the
// titles exactly once, in the one place they are rendered.
describe('statusCommand — the task table (#56)', () => {
  const MIN = 60000
  const metricsEvent = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)
  const METRICS = [
    metricsEvent({
      issue_number: 29,
      run_id: SESSION,
      ts: 1,
      duration_ms: 97 * MIN,
      total_cost_usd: 34.1,
      verdict: 'pass',
    }),
    metricsEvent({
      issue_number: 30,
      run_id: SESSION,
      ts: 2,
      duration_ms: 71 * MIN,
      total_cost_usd: 28.75,
      verdict: 'pass',
    }),
  ].join('\n')
  const tableDeps = (overrides = {}) =>
    baseDeps({
      readFile: (p) => (String(p).endsWith('issues.jsonl') ? METRICS : ''),
      ...overrides,
    })
  const titleCallsOf = (deps) =>
    deps.exec.calls.filter((c) => c.cmd === 'gh' && c.args.includes('--state'))

  it('draws the issue’s worked example: a row per task, titled, under the progress line', async () => {
    const deps = tableDeps()
    await statusCommand(deps)
    const lines = deps.stdout.lines()
    expect(lines.slice(1, 7)).toEqual([
      '  progress   2/9 done · #031 in flight (40min)  [██──────] 22%',
      '',
      '  task           verdict     cost      time',
      '  #029 sidebar   ✅ pass     $34.10    97min',
      '  #030 persist   ✅ pass     $28.75    71min',
      '  #031 row comp  🔄 live     –         ~40min',
    ])
    // Standing off from the queue below it, not run together with it.
    expect(lines[7]).toBe('')
    expect(lines[8]).toBe('  queue      6 waiting')
  })

  it('reads the titles once, at the run’s root, for open AND closed issues, never rejecting', async () => {
    const deps = tableDeps()
    await statusCommand(deps)
    const calls = titleCallsOf(deps)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual([
      'issue',
      'list',
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      'number,title',
    ])
    expect(calls[0].options).toEqual({ cwd: REPO, reject: false })
  })

  it('renders the numbers alone when the title read fails, still exiting 0', async () => {
    for (const execOpts of [{ ghTitlesExitCode: 1 }, { ghTitles: 'not json at all' }, { ghTitles: '' }]) {
      const deps = tableDeps({ exec: makeExec(execOpts) })
      const result = await statusCommand(deps)
      expect(result.exitCode).toBe(0)
      const lines = deps.stdout.lines()
      expect(lines.slice(3, 7), JSON.stringify(execOpts)).toEqual([
        '  task  verdict     cost      time',
        '  #029  ✅ pass     $34.10    97min',
        '  #030  ✅ pass     $28.75    71min',
        '  #031  🔄 live     –         ~40min',
      ])
      // And the numbers it could not title are still the same numbers.
      expect(lines[1]).toBe('  progress   2/9 done · #031 in flight (40min)  [██──────] 22%')
    }
  })

  it('never pays for titles where none are rendered: --json, folder mode, idle, never-run', async () => {
    const cases = [
      ['--json', tableDeps({ json: true })],
      [
        'folder',
        tableDeps({
          exists: (p) => String(p).endsWith('ralph.config.sh'),
          readFile: (p) =>
            String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : METRICS,
        }),
      ],
      ['idle', tableDeps({ readRunState: () => terminalRecord() })],
      ['never-run', tableDeps({ readRunState: () => null })],
    ]
    for (const [label, deps] of cases) {
      await statusCommand(deps)
      expect(titleCallsOf(deps), label).toHaveLength(0)
    }
  })
})

describe('statusCommand — a run whose session is gone (#55)', () => {
  it('reports interrupted, never running, when run-state says running but tmux has no session', async () => {
    const deps = baseDeps({ exec: makeExec({ sessionAlive: false }) })
    const result = await statusCommand(deps)
    const out = deps.stdout.output()
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('interrupted')
    expect(out).toContain(`▸ ralph — interrupted · run ${SESSION} (started 16:20, 3h12m ago)`)
    expect(out).not.toContain('running')
    // Still says what it was doing and how deep the queue is.
    expect(out).toContain('  progress   0/7 done · #031 in flight (40min)  [────────] 0%')
    expect(out).toContain('  #031 row comp  🔄 live     –         ~40min')
    expect(out).toContain('  queue      6 waiting')
    // The attach/kill pair is dead advice with no session — point at a restart.
    expect(out).toContain('  restart    ralph start')
    expect(out).not.toContain('tmux attach')
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

describe('statusCommand — idle and never-run (#55, one line each)', () => {
  it('states idle in one line for a terminal record', async () => {
    const deps = baseDeps({ readRunState: () => terminalRecord() })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('idle')
    const lines = deps.stdout.lines()
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('idle')
    expect(lines[0]).toContain(SESSION)
    expect(lines[0]).toContain('2 ok, 1 failed')
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

  it('says `?`, not 0, for counts a truncated record never recorded', async () => {
    // Same rule run-state.js applies to the queue depth: an absent number is
    // unknown, and "0 failed" on a record that never said so is a lie.
    const deps = baseDeps({ readRunState: () => terminalRecord({ ok: null, failed: undefined }) })
    await statusCommand(deps)
    const line = deps.stdout.lines()[0]
    expect(line).toContain('? ok, ? failed')
    expect(line).not.toContain('0 ok')
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
      // No metrics text passed → nothing closed yet, so `0/7` and an empty bar (#56).
      '  progress   0/7 done · #031 in flight (40min)  [────────] 0%',
      '',
      // One row, untitled: the default snapshot is built with no `titles` at all, and
      // the table names what it knows rather than inventing a label (#56).
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
