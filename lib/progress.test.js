import { describe, it, expect } from 'vitest'
import { buildProgress, renderProgress } from './progress.js'

const MIN = 60000
const RUN = 'ralph-ralph-b36ff7b1'
const OTHER_RUN = 'ralph-ralph-0badf00d'

// Local Date constructors on purpose, exactly like status.test.js: the rendered
// finish time is a wall-clock reading, so a UTC ISO fixture would make these
// expectations timezone-dependent and the suite red outside UTC.
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime() // 40min into #031

// One recorded iteration, shaped like lib/issue-event.js builds them. `minutes:
// null` and `cost: null` are the real Codex/failed-parse shapes, not padding.
const event = ({ number = 1, run = RUN, minutes = null, cost = null, verdict = 'pass', ts = 1 } = {}) => ({
  issue_number: number,
  run_id: run,
  ts,
  duration_ms: minutes == null ? null : minutes * MIN,
  total_cost_usd: cost,
  verdict,
})

const jsonl = (...events) =>
  events.map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e)).join('\n') + '\n'

// The issue's worked example: #029 97min, #030 71min, #031 in flight 40min,
// 6 waiting. Pace mean(97, 71) = 84; ETA (84 − 40) + 6 × 84 = 548min.
const WORKED_EXAMPLE = jsonl(
  event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
  event({ number: 30, minutes: 71, cost: 28.75, ts: 2 }),
)

const inFlightRecord = (overrides = {}) => ({
  run_id: RUN,
  queue_at_start: 8,
  current: { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 1 },
  ...overrides,
})

const worked = (overrides = {}) =>
  buildProgress({
    metricsText: WORKED_EXAMPLE,
    record: inFlightRecord(),
    queue: 6,
    now: NOW,
    ...overrides,
  })

describe('buildProgress — pace, from the last three tasks of THIS run (#57)', () => {
  it('averages the last three completed tasks in the run, not the whole run', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 1, minutes: 120, ts: 1 }),
        event({ number: 2, minutes: 90, ts: 2 }),
        event({ number: 3, minutes: 60, ts: 3 }),
        event({ number: 4, minutes: 30, ts: 4 }),
      ),
      record: inFlightRecord(),
      queue: 0,
      now: NOW,
    })
    expect(snapshot.paceBasis).toBe('last3-in-run')
    expect(snapshot.samples).toBe(3)
    expect(snapshot.paceMs).toBe(60 * MIN) // mean(90, 60, 30), the 120 dropped
    expect(snapshot.paceMinMs).toBe(30 * MIN)
    expect(snapshot.paceMaxMs).toBe(90 * MIN)
  })

  it('uses TWO in-run samples rather than the all-time mean (the fallback boundary)', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 90, run: OTHER_RUN, minutes: 10, ts: 1 }),
        event({ number: 29, minutes: 97, ts: 2 }),
        event({ number: 30, minutes: 71, ts: 3 }),
      ),
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    expect(snapshot.paceBasis).toBe('last3-in-run')
    expect(snapshot.samples).toBe(2)
    expect(snapshot.paceMs).toBe(84 * MIN)
  })

  it('falls back to the all-time mean with exactly ONE in-run sample', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 90, run: OTHER_RUN, minutes: 30, ts: 1 }),
        event({ number: 91, run: OTHER_RUN, minutes: 60, ts: 2 }),
        event({ number: 29, minutes: 90, ts: 3 }),
      ),
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    expect(snapshot.paceBasis).toBe('all-time')
    expect(snapshot.samples).toBe(3) // the full history, this run's row included
    expect(snapshot.paceMs).toBe(60 * MIN)
    expect(snapshot.paceMinMs).toBe(30 * MIN)
    expect(snapshot.paceMaxMs).toBe(90 * MIN)
  })

  it('falls back to the all-time mean with NO in-run samples at all', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 90, run: OTHER_RUN, minutes: 40, ts: 1 }),
        event({ number: 91, run: OTHER_RUN, minutes: 80, ts: 2 }),
      ),
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    expect(snapshot.paceBasis).toBe('all-time')
    expect(snapshot.paceMs).toBe(60 * MIN)
  })

  it('reports an unknown pace — never a zero — when no row records a duration', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 29, minutes: null, ts: 1 }),
        event({ number: 30, minutes: null, ts: 2 }),
      ),
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    expect(snapshot.paceBasis).toBe('unknown')
    expect(snapshot.paceMs).toBe(null)
    expect(snapshot.samples).toBe(0)
    expect(snapshot.etaMs).toBe(null)
    expect(snapshot.finishAt).toBe(null)
    expect(snapshot.spreadMs).toBe(null)
  })

  it('reports an unknown pace for an empty, missing or history-free metrics file', () => {
    for (const metricsText of ['', null, undefined, '\n\n']) {
      const snapshot = buildProgress({ metricsText, record: inFlightRecord(), queue: 6, now: NOW })
      expect(snapshot.paceBasis).toBe('unknown')
      expect(snapshot.paceMs).toBe(null)
      expect(snapshot.completed).toBe(0)
    }
  })

  it('ignores zero and non-finite durations as samples', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 27, minutes: 0, ts: 1 }),
        { issue_number: 28, run_id: RUN, ts: 2, duration_ms: 'nope' },
        { issue_number: 29, run_id: RUN, ts: 3 }, // no duration field at all
        event({ number: 30, minutes: 84, ts: 4 }),
      ),
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    // One usable sample in the run → the all-time fallback, over that same row.
    expect(snapshot.samples).toBe(1)
    expect(snapshot.paceBasis).toBe('all-time')
    expect(snapshot.paceMs).toBe(84 * MIN)
    // ...but every row is still a task this run completed.
    expect(snapshot.completed).toBe(4)
  })

  it('skips blank, untagged, malformed and truncated lines without ever throwing', () => {
    const metricsText = [
      '',
      'just some stdout from the loop',
      'RALPH_ISSUE_EVENT {not valid json',
      'noise RALPH_ISSUE_EVENT ',
      'RALPH_ISSUE_EVENT 42',
      'RALPH_ISSUE_EVENT null',
      '   ',
      'RALPH_ISSUE_EVENT ' + JSON.stringify(event({ number: 29, minutes: 97, ts: 1 })),
      'RALPH_ISSUE_EVENT ' + JSON.stringify(event({ number: 30, minutes: 71, ts: 2 })),
      'RALPH_ISSUE_EVENT {"issue_number":31,"run_id":"' + RUN + '"', // truncated mid-write
    ].join('\n')
    let snapshot
    expect(() => {
      snapshot = buildProgress({ metricsText, record: inFlightRecord(), queue: 6, now: NOW })
    }).not.toThrow()
    expect(snapshot.completed).toBe(2)
    expect(snapshot.paceMs).toBe(84 * MIN)
  })
})

describe('buildProgress — run-id scoping (#57)', () => {
  it('counts only this run’s rows as completed, however long the history is', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 90, run: OTHER_RUN, minutes: 10, ts: 1 }),
        event({ number: 91, run: OTHER_RUN, minutes: 10, ts: 2 }),
        event({ number: 29, minutes: 97, ts: 3 }),
        event({ number: 30, minutes: 71, ts: 4 }),
      ),
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    expect(snapshot.completed).toBe(2)
    expect(snapshot.total).toBe(9)
  })

  it('counts a FAILED task as completed — it has left the queue either way', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 29, minutes: 97, verdict: 'pass', ts: 1 }),
        event({ number: 30, minutes: 71, verdict: 'fail', ts: 2 }),
      ),
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    expect(snapshot.completed).toBe(2)
    expect(snapshot.paceMs).toBe(84 * MIN)
  })

  it('has no in-run rows at all when the record carries no run id', () => {
    const snapshot = buildProgress({
      metricsText: WORKED_EXAMPLE,
      record: inFlightRecord({ run_id: null }),
      queue: 6,
      now: NOW,
    })
    expect(snapshot.completed).toBe(0)
    expect(snapshot.paceBasis).toBe('all-time')
    expect(snapshot.spendUsd).toBe(null)
  })
})

describe('buildProgress — the LIVE denominator (#57)', () => {
  it('is completed-in-run + in-flight + the live queue depth', () => {
    const snapshot = worked()
    expect(snapshot.completed).toBe(2)
    expect(snapshot.inFlight).toBe(1)
    expect(snapshot.remaining).toBe(6)
    expect(snapshot.total).toBe(9)
  })

  it('never freezes on queue_at_start', () => {
    const snapshot = worked({ record: inFlightRecord({ queue_at_start: 99 }) })
    expect(snapshot.total).toBe(9)
    expect(snapshot.remaining).toBe(6)
  })

  it('is unknown — not zero — when the live queue count failed', () => {
    const snapshot = worked({ queue: null })
    expect(snapshot.remaining).toBe(null)
    expect(snapshot.total).toBe(null)
    expect(snapshot.etaMs).toBe(null)
    expect(snapshot.projectedUsd).toBe(null)
    // The pace and the recorded spend are still known facts.
    expect(snapshot.paceMs).toBe(84 * MIN)
    expect(snapshot.spendUsd).toBeCloseTo(62.85, 5)
  })

  it('counts no in-flight task when the run has not begun one', () => {
    const snapshot = worked({ record: inFlightRecord({ current: null }) })
    expect(snapshot.inFlight).toBe(0)
    expect(snapshot.total).toBe(8)
  })
})

describe('buildProgress — ETA (#57)', () => {
  it('is (pace − in-flight elapsed) + remaining × pace, with a wall-clock finish', () => {
    const snapshot = worked()
    expect(snapshot.etaMs).toBe(548 * MIN) // (84 − 40) + 6 × 84
    expect(snapshot.finishAt).toBe(NOW + 548 * MIN)
    // The spread comes from the observed 71–97min range: ±13min per task, over
    // the 7 tasks still ahead (the one in flight plus the 6 waiting).
    expect(snapshot.spreadMs).toBe(91 * MIN)
  })

  it('floors the in-flight remainder at zero when the task has already overrun', () => {
    const snapshot = worked({ now: TASK_STARTED.getTime() + 200 * MIN })
    // 200min in on an 84min pace: the overrun must not push the estimate up, and
    // must never go negative.
    expect(snapshot.etaMs).toBe(6 * 84 * MIN)
  })

  it('counts only the in-flight task when nothing is left in the queue', () => {
    const snapshot = worked({ queue: 0 })
    expect(snapshot.remaining).toBe(0)
    expect(snapshot.total).toBe(3)
    expect(snapshot.etaMs).toBe(44 * MIN) // 84 − 40
  })

  it('is zero, not negative, with an empty queue and an overrunning task', () => {
    const snapshot = worked({ queue: 0, now: TASK_STARTED.getTime() + 200 * MIN })
    expect(snapshot.etaMs).toBe(0)
    expect(snapshot.finishAt).toBe(TASK_STARTED.getTime() + 200 * MIN)
  })

  it('omits the in-flight remainder when no task is in flight', () => {
    const snapshot = worked({ record: inFlightRecord({ current: null }) })
    expect(snapshot.etaMs).toBe(6 * 84 * MIN)
  })

  it('treats an unparseable in-flight start as no elapsed time rather than NaN', () => {
    const snapshot = worked({
      record: inFlightRecord({ current: { number: 31, started_at: 'not a date' } }),
    })
    expect(snapshot.inFlight).toBe(1)
    expect(snapshot.etaMs).toBe(7 * 84 * MIN)
  })
})

describe('buildProgress — spend (#57)', () => {
  it('sums this run’s recorded cost and projects the rest at the observed rate', () => {
    const snapshot = worked()
    expect(snapshot.spendUsd).toBeCloseTo(62.85, 5)
    expect(snapshot.costPerTaskUsd).toBeCloseTo(31.425, 5)
    expect(snapshot.projectedUsd).toBeCloseTo(251.4, 5) // 62.85 + 6 × 31.425
  })

  it('is unknown — never $0 — when no row records a cost (a Codex run)', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 29, minutes: 97, cost: 0, ts: 1 }),
        event({ number: 30, minutes: 71, cost: null, ts: 2 }),
      ),
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    expect(snapshot.spendUsd).toBe(null)
    expect(snapshot.costPerTaskUsd).toBe(null)
    expect(snapshot.projectedUsd).toBe(null)
    // The duration side is unaffected: a costless run still has a pace and an ETA.
    expect(snapshot.paceMs).toBe(84 * MIN)
    expect(snapshot.etaMs).toBe(548 * MIN)
  })

  it('rates only the rows that recorded a cost, not every completed task', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 28, minutes: 84, cost: null, ts: 1 }),
        event({ number: 29, minutes: 97, cost: 34.1, ts: 2 }),
        event({ number: 30, minutes: 71, cost: 28.75, ts: 3 }),
      ),
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    expect(snapshot.completed).toBe(3)
    expect(snapshot.spendUsd).toBeCloseTo(62.85, 5)
    expect(snapshot.costPerTaskUsd).toBeCloseTo(31.425, 5)
  })

  it('never counts another run’s spend as this run’s', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 90, run: OTHER_RUN, minutes: 10, cost: 500, ts: 1 }),
        event({ number: 29, minutes: 97, cost: 34.1, ts: 2 }),
        event({ number: 30, minutes: 71, cost: 28.75, ts: 3 }),
      ),
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    expect(snapshot.spendUsd).toBeCloseTo(62.85, 5)
  })
})

describe('renderProgress — the pace / eta / spend lines (#57)', () => {
  it('renders the issue’s worked example, in the label column of the live view', () => {
    expect(renderProgress(worked())).toEqual([
      '  pace       ~84 min/task · $31.4/task',
      '  eta        ~9h08m left → ~04:40  (±1h30m)',
      '  spend      $62.85 so far · ~$250 projected',
    ])
  })

  it('renders a finish time that crosses midnight as tomorrow’s wall clock', () => {
    const lateNight = new Date(2026, 7, 25, 23, 50, 0).getTime()
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 29, minutes: 30, ts: 1 }),
        event({ number: 30, minutes: 30, ts: 2 }),
      ),
      record: inFlightRecord({ current: null }),
      queue: 1,
      now: lateNight,
    })
    expect(snapshot.etaMs).toBe(30 * MIN)
    expect(renderProgress(snapshot)[1]).toBe('  eta        ~30min left → ~00:20')
  })

  it('says unknown — not zero — for every line when there is no history', () => {
    const snapshot = buildProgress({ metricsText: '', record: inFlightRecord(), queue: 6, now: NOW })
    expect(renderProgress(snapshot)).toEqual([
      '  pace       unknown',
      '  eta        unknown',
      '  spend      unknown',
    ])
  })

  it('omits the ± when a single sample shows no observed spread', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(event({ number: 29, minutes: 84, ts: 1 })),
      record: inFlightRecord({ current: null }),
      queue: 1,
      now: NOW,
    })
    const line = renderProgress(snapshot)[1]
    expect(line).toContain('~1h24m left')
    expect(line).not.toContain('±')
  })

  it('reports the recorded spend with no projection when the queue count failed', () => {
    const lines = renderProgress(worked({ queue: null }))
    expect(lines[0]).toBe('  pace       ~84 min/task · $31.4/task')
    expect(lines[1]).toBe('  eta        unknown')
    expect(lines[2]).toBe('  spend      $62.85 so far')
  })

  it('drops the cost rate from the pace line when no row recorded a cost', () => {
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 29, minutes: 97, ts: 1 }),
        event({ number: 30, minutes: 71, ts: 2 }),
      ),
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    const lines = renderProgress(snapshot)
    expect(lines[0]).toBe('  pace       ~84 min/task')
    expect(lines[2]).toBe('  spend      unknown')
  })

  it('rounds a projection to a precision two samples can support', () => {
    // $250, not $251.40: a projection built on a two-task mean has no business
    // claiming dollars and cents.
    expect(renderProgress(worked())[2]).toContain('~$250 projected')
  })

  it('never projects a total below the money already recorded', () => {
    // One task, one cent, one still waiting: the grid would round the $0.02
    // projection down to `$0.0` — under the cent already spent. A total lower than
    // the spend it contains is arithmetically impossible, so the exact figure wins
    // over the tidy one.
    const snapshot = buildProgress({
      metricsText: jsonl(event({ number: 29, minutes: 1, cost: 0.01, ts: 1 })),
      record: inFlightRecord({ current: null }),
      queue: 1,
      now: NOW,
    })
    expect(snapshot.projectedUsd).toBeCloseTo(0.02, 5)
    expect(renderProgress(snapshot)[2]).toBe('  spend      $0.01 so far · ~$0.02 projected')
  })

  it('reports the exact total, not a rounded-down one, once the queue is empty', () => {
    // Nothing left to project, so the projection IS the spend — and rounding
    // $104.99 to the nearest ten would report `~$100`, five dollars under money
    // that is already gone.
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 29, minutes: 97, cost: 52.5, ts: 1 }),
        event({ number: 30, minutes: 71, cost: 52.49, ts: 2 }),
      ),
      record: inFlightRecord({ current: null }),
      queue: 0,
      now: NOW,
    })
    expect(snapshot.remaining).toBe(0)
    expect(renderProgress(snapshot)[2]).toBe('  spend      $104.99 so far · ~$104.99 projected')
  })
})
