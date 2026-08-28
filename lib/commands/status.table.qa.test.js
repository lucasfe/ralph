import { describe, expect, it } from 'vitest'
import { statusCommand } from './status.js'

// #56's ADVERSARIAL SWEEP over the SHELL half. lib/commands/status.table.test.js owns
// the placement of the table and the thirty-odd shapes a `gh` answer can arrive in;
// this file only asks what that suite does not, and all of it is about the READ PLAN
// rather than the rendering:
//
//   1. A COURTESY THAT THROWS IS NOT A COURTESY. `readIssueTitles` states its contract
//      flatly — "EVERY FAILURE IS `{}`", "never rejecting: a failed courtesy must
//      degrade, not throw". The sibling suite proves that for every failure execa
//      RESOLVES with, which is every failure execa produces under `{ reject: false }`.
//      The one shape left is an `exec` that REJECTS, and the deps bag is an injection
//      point: a caller can hand this command any `exec` at all, and the contract above
//      is written about the function rather than about execa's option.
//   2. AN UNMEASURED MODE MUST STILL COST NOTHING. #56 moved the config/environment
//      read for the task source OUT of `countQueue` and up into `collectStatus`, where
//      it now runs in all four modes rather than only the two that count a queue. That
//      is a read plan change, so the plan is pinned here as a whole transcript: which
//      processes ran, in which order, and which files were opened.
//   3. THE SOURCE HAS TWO ANSWERS AND ONE WINNER. `ralph.config.sh` outranks the
//      environment, and after #56 that precedence decides not just the queue count but
//      whether the title lookup happens at all — so a repo whose config says github
//      must not be talked out of it by a stray TASK_SOURCE in the environment.
//
// Hermetic and injected throughout, exactly like the sibling suite: local Date
// constructors, an injected `now`, an injected `processEnv`, no filesystem.

const REPO = '/repo'
const SESSION = 'ralph-repo-live'
const MIN = 60000
const RUN = 'run-live'

const RUN_STARTED = new Date(2026, 7, 25, 16, 20, 0)
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime()

const running = (overrides = {}) => ({
  schema: 1,
  run_id: RUN,
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

const METRICS =
  [
    { issue_number: 29, run_id: RUN, ts: 1, duration_ms: 97 * MIN, total_cost_usd: 34.45, verdict: 'pass' },
    { issue_number: 30, run_id: RUN, ts: 2, duration_ms: 71 * MIN, total_cost_usd: 28.4, verdict: 'pass' },
  ]
    .map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e))
    .join('\n') + '\n'

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return false
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
}

// The titles call is the `--state all` one and the queue count is the `--search` one:
// a double that answered both alike could not tell a broken lookup from a broken count.
const isTitlesCall = (call) => call.cmd === 'gh' && call.args.includes('--state')
const isQueueCall = (call) => call.cmd === 'gh' && call.args.includes('--search')

function makeExec({ titlesRejects = false, queueRejects = false, tmuxExit = 0 } = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    const call = { cmd, args, options }
    calls.push(call)
    if (cmd === 'tmux') return { exitCode: tmuxExit }
    if (isTitlesCall(call)) {
      if (titlesRejects) throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
      return { exitCode: 0, stdout: JSON.stringify([{ number: 29, title: 'sidebar' }]) }
    }
    if (isQueueCall(call)) {
      if (queueRejects) throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
      return { exitCode: 0, stdout: '6' }
    }
    return { exitCode: 0, stdout: '' }
  }
  exec.calls = calls
  exec.titles = () => calls.filter(isTitlesCall)
  exec.queue = () => calls.filter(isQueueCall)
  exec.gh = () => calls.filter((c) => c.cmd === 'gh')
  // `cmd` plus the first two arguments: enough to tell the four calls apart, and
  // deliberately not the whole argv — the sibling suite pins the titles call's argv
  // exactly, and repeating it here would make one change fail in two files.
  exec.transcript = () => calls.map((c) => [c.cmd, ...c.args.slice(0, 2)].join(' '))
  return exec
}

const readByPath = (paths) => (path) => {
  paths.push(String(path))
  return String(path).endsWith('issues.jsonl') ? METRICS : ''
}

const deps = (overrides = {}) => {
  const paths = []
  return {
    cwd: REPO,
    stdout: makeStream(),
    exec: makeExec(),
    exists: () => false,
    readFile: readByPath(paths),
    readRunState: () => running(),
    peekLock: () => null,
    folderQueueCount: async () => 6,
    now: () => NOW,
    // RALPH_BANNER off for the sibling suite's reason (#76): every expectation here is
    // about the report, and the identity box would put three lines of frame above it.
    processEnv: { RALPH_BANNER: 'off' },
    ...overrides,
    paths,
  }
}

const run = async (overrides = {}) => {
  const d = deps(overrides)
  const result = await statusCommand(d)
  return { result, stdout: d.stdout, exec: d.exec, lines: d.stdout.lines(), paths: d.paths }
}

const headerIndex = (lines) => lines.findIndex((line) => /^\s+task\s+verdict\s+cost\s+time$/.test(line))

describe('statusCommand — a title lookup that REJECTS is still only a courtesy (#56)', () => {
  it('exits 0 with a table of numbers when the titles call rejects instead of resolving', async () => {
    // The stated contract is about the FUNCTION, not about execa's option: every failure
    // is `{}`. `{ reject: false }` is a request made of one particular `exec`, and the
    // one in the deps bag is injected — a wrapper that retries, a mock, or an execa
    // major that changed its mind about spawn errors all reach this line. The cost of
    // being wrong is the whole read-only view, which is the one command a person runs
    // when something is already going wrong.
    const { result, lines } = await run({ exec: makeExec({ titlesRejects: true }) })
    expect(result.exitCode).toBe(0)
    const header = headerIndex(lines)
    expect(header, lines.join('\n')).toBeGreaterThan(0)
    for (const number of ['#029', '#030', '#031']) {
      expect(
        lines.some((line) => line.includes(number)),
        number,
      ).toBe(true)
    }
    // The numbers either side of the table are facts, and they survive too.
    expect(lines.some((line) => line.includes('2/9 done'))).toBe(true)
    expect(lines.some((line) => line.includes('6 waiting'))).toBe(true)
  })

  it('never reaches that rejection under --json, where the lookup is not made at all', async () => {
    // The gate should make the rejection unreachable under `--json`, and this is the
    // assertion that keeps it that way rather than assuming it.
    const { result, stdout, exec } = await run({ json: true, exec: makeExec({ titlesRejects: true }) })
    expect(result.exitCode).toBe(0)
    expect(exec.titles()).toHaveLength(0)
    expect(() => JSON.parse(stdout.output())).not.toThrow()
  })
})

describe('statusCommand — the read plan #56 changed, pinned as a whole transcript (#56)', () => {
  it('runs exactly four processes for a live run, with the courtesy last', async () => {
    // The order is the design: the git root, the liveness probe, the queue count the
    // view cannot do without, and only then the titles nobody needs. A lookup that
    // moved ahead of the count would put a courtesy in front of a fact.
    const { exec } = await run()
    expect(exec.transcript()).toEqual([
      'git rev-parse --show-toplevel',
      'tmux has-session -t',
      'gh issue list',
      'gh issue list',
    ])
    expect(exec.gh()).toHaveLength(2)
    expect(isQueueCall(exec.gh()[0])).toBe(true)
    expect(isTitlesCall(exec.gh()[1])).toBe(true)
  })

  it('still costs nothing at all in a repo that has never run', async () => {
    // #56 moved the source resolution out of `countQueue` and up in front of all four
    // modes. The greeting must still be free: no process beyond the two it always ran,
    // no metrics file opened, and no folder walk.
    let folderWalks = 0
    const { result, exec, paths } = await run({
      readRunState: () => null,
      folderQueueCount: async () => {
        folderWalks += 1
        return 6
      },
    })
    expect(result.exitCode).toBe(0)
    expect(exec.transcript()).toEqual(['git rev-parse --show-toplevel', 'tmux has-session -t'])
    expect(exec.gh()).toHaveLength(0)
    expect(paths.filter((p) => p.endsWith('issues.jsonl'))).toEqual([])
    expect(folderWalks).toBe(0)
  })

  it('survives a deps bag whose processEnv is null, in every mode', async () => {
    // A null is not an absent value: the default in the destructuring only fires for
    // `undefined`, so `processEnv: null` reaches the new unconditional
    // `processEnv.TASK_SOURCE` read. The sibling read for the identity box is spelled
    // `processEnv?.RALPH_BANNER` in the same file, which is the convention this one is
    // measured against — and before #56 the read sat behind the `measured` gate, so
    // three of the four modes never performed it at all.
    const modes = {
      running: {},
      'never-run': { readRunState: () => null },
      idle: {
        readRunState: () => running({ status: 'completed', finished_at: RUN_STARTED.toISOString() }),
      },
      // The session is gone and no lock explains it: #59's `interrupted`.
      interrupted: { exec: makeExec({ tmuxExit: 1 }) },
    }
    for (const [mode, overrides] of Object.entries(modes)) {
      const bag = deps({ processEnv: null, ...overrides })
      await expect(statusCommand(bag), mode).resolves.toMatchObject({ exitCode: 0 })
    }
  })
})

describe('statusCommand — the config file outranks the environment about the source (#56)', () => {
  it('keeps the lookup for a config that says github, whatever the environment says', async () => {
    const { result, exec } = await run({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE="github"\n' : METRICS),
      processEnv: { RALPH_BANNER: 'off', TASK_SOURCE: 'folder' },
    })
    expect(result.exitCode).toBe(0)
    expect(exec.titles()).toHaveLength(1)
    expect(exec.queue()).toHaveLength(1)
  })

  it('skips it for a config that says folder, whatever the environment says', async () => {
    const { result, exec } = await run({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE="folder"\n' : METRICS),
      processEnv: { RALPH_BANNER: 'off', TASK_SOURCE: 'github' },
    })
    expect(result.exitCode).toBe(0)
    expect(exec.gh()).toHaveLength(0)
  })

  it('asks the config and the environment once each, however many surfaces need the answer', async () => {
    // The source now answers two questions — how deep the queue is and whether to buy
    // titles — and the module's own note says parsing the same text twice is how two
    // questions about one config start answering differently.
    const seen = []
    const { result } = await run({
      exists: (p) => {
        seen.push(String(p))
        return String(p).endsWith('ralph.config.sh')
      },
      readFile: (p) => {
        seen.push(String(p))
        return String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE="github"\n' : METRICS
      },
    })
    expect(result.exitCode).toBe(0)
    expect(seen.filter((p) => p.endsWith('ralph.config.sh'))).toHaveLength(2)
  })
})
