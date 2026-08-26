import { describe, it, expect } from 'vitest'
import { buildProgress, padTaskNumber, renderProgressLine, renderTaskTable } from './progress.js'

// #56 — the per-task table and the progress line, the two surfaces that make the
// live denominator legible. The counts and the scoping behind them are #57's and
// are pinned in progress.test.js; what is new here is the ROWS (one per task this
// run has touched, in file order, with the in-flight one last) and the two pure
// renderers that draw them.
//
// A separate file, per this module's slice-per-file grain (progress.test.js is
// #57's, progress.json.test.js is #58's, progress.launch.qa.test.js is #60's):
// the table is its own surface with its own vocabulary — widths, markers, the
// `–` that is not `$0.00` — and reading it beside the pace/ETA/spend assertions
// would tell a reader neither story.
//
// Local Date constructors and an injected `now` throughout, exactly like the
// sibling files: the rendered elapsed is arithmetic, but the run's fixtures are
// wall-clock instants and a UTC ISO literal would make the suite timezone-dependent.

const MIN = 60000
const RUN = 'ralph-ralph-b36ff7b1'
const OTHER_RUN = 'ralph-ralph-0badf00d'

const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime() // 40min into #031

// One recorded iteration, shaped like lib/issue-event.js builds them.
const event = ({
  number = 1,
  run = RUN,
  minutes = null,
  cost = null,
  verdict = 'pass',
  ts = 1,
  ...rest
} = {}) => ({
  issue_number: number,
  run_id: run,
  ts,
  duration_ms: minutes == null ? null : minutes * MIN,
  total_cost_usd: cost,
  verdict,
  ...rest,
})

const jsonl = (...events) =>
  events.map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e)).join('\n') + '\n'

// The issue's worked example: #029 97min/$34.10 passed, #030 71min/$28.75 passed,
// #031 in flight for 40min, 6 still waiting. 2 of 9 done — 22%.
const WORKED_EXAMPLE = jsonl(
  event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
  event({ number: 30, minutes: 71, cost: 28.75, ts: 2 }),
)

const TITLES = { 29: 'sidebar', 30: 'persist', 31: 'row comp' }

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
    titles: TITLES,
    ...overrides,
  })

// The rendered table of the worked example, named once: most tests below vary one
// cell of it, and a column that moves two spaces should be one edit here.
const TABLE = [
  '  task           verdict     cost      time',
  '  #029 sidebar   ✅ pass     $34.10    97min',
  '  #030 persist   ✅ pass     $28.75    71min',
  '  #031 row comp  🔄 live     –         ~40min',
]

describe('buildProgress — one row per task this run has touched (#56)', () => {
  it('rows the run’s completed tasks in file order, with the in-flight one last', () => {
    expect(worked().taskRows).toEqual([
      { number: 29, title: 'sidebar', verdict: 'pass', costUsd: 34.1, durationMs: 97 * MIN, inFlight: false },
      { number: 30, title: 'persist', verdict: 'pass', costUsd: 28.75, durationMs: 71 * MIN, inFlight: false },
      { number: 31, title: 'row comp', verdict: null, costUsd: null, durationMs: 40 * MIN, inFlight: true },
    ])
  })

  it('counts the same tasks the fraction does — the rows ARE the numerator', () => {
    const snapshot = worked()
    expect(snapshot.taskRows.filter((row) => !row.inFlight).length).toBe(snapshot.completed)
    expect(snapshot.taskRows.filter((row) => row.inFlight).length).toBe(snapshot.inFlight)
  })

  it('never rows another run’s tasks, however long the history is', () => {
    const snapshot = worked({
      metricsText: jsonl(
        event({ number: 90, run: OTHER_RUN, minutes: 10, cost: 500, ts: 1 }),
        event({ number: 29, minutes: 97, cost: 34.1, ts: 2 }),
        event({ number: 91, run: OTHER_RUN, minutes: 10, cost: 500, ts: 3 }),
      ),
    })
    expect(snapshot.taskRows.map((row) => row.number)).toEqual([29, 31])
  })

  it('rows nothing at all when the record cannot name its run', () => {
    const snapshot = worked({ record: inFlightRecord({ run_id: null }) })
    // No run id matches no rows (belongsToRun's rule) — but the task in flight is
    // the RECORD's own fact and stands whatever the history says.
    expect(snapshot.taskRows.map((row) => row.number)).toEqual([31])
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
      'RALPH_ISSUE_EVENT {"issue_number":30,"run_id":"' + RUN + '"', // truncated mid-write
    ].join('\n')
    let snapshot
    expect(() => {
      snapshot = worked({ metricsText })
    }).not.toThrow()
    expect(snapshot.taskRows.map((row) => row.number)).toEqual([29, 31])
  })

  it('rows only the task in flight for a run that has completed nothing', () => {
    const snapshot = worked({ metricsText: '' })
    expect(snapshot.taskRows).toEqual([
      { number: 31, title: 'row comp', verdict: null, costUsd: null, durationMs: 40 * MIN, inFlight: true },
    ])
  })

  it('rows nothing for a run with no history and no task in flight', () => {
    expect(worked({ metricsText: '', record: inFlightRecord({ current: null }) }).taskRows).toEqual([])
  })

  it('keeps the unknown discipline on every numeric cell: null, never zero', () => {
    const snapshot = worked({
      metricsText: jsonl(
        event({ number: 27, minutes: 0, cost: 0, ts: 1 }), // recorded, but unmeasured
        event({ number: 28, minutes: null, cost: null, ts: 2 }),
        { issue_number: 29, run_id: RUN, ts: 3, duration_ms: 'nope', total_cost_usd: 'free' },
        { run_id: RUN, ts: 4 }, // not even a number
      ),
      record: inFlightRecord({ current: null }),
    })
    expect(snapshot.taskRows.map((row) => [row.number, row.costUsd, row.durationMs])).toEqual([
      [27, null, null],
      [28, null, null],
      [29, null, null],
      [null, null, null],
    ])
  })

  it('carries the verdict through verbatim, and null when the row has none', () => {
    const snapshot = worked({
      metricsText: jsonl(
        event({ number: 29, verdict: 'pass', ts: 1 }),
        event({ number: 30, verdict: 'fail', ts: 2 }),
        event({ number: 31, verdict: 'unknown', ts: 3 }),
        { issue_number: 32, run_id: RUN, ts: 4 },
      ),
      record: inFlightRecord({ current: null }),
    })
    expect(snapshot.taskRows.map((row) => row.verdict)).toEqual(['pass', 'fail', 'unknown', null])
  })

  it('times the in-flight row from its own start, and says null when it cannot', () => {
    expect(worked().taskRows.at(-1).durationMs).toBe(40 * MIN)
    // An unparseable start is NOT a zero elapsed on this row. The ETA deliberately
    // reads it as 0 (the task is in flight, so it is still owed a full estimate);
    // a table cell that said `0min` would claim the task started this instant.
    const unreadable = worked({ record: inFlightRecord({ current: { number: 31, started_at: 'soon' } }) })
    expect(unreadable.taskRows.at(-1).durationMs).toBe(null)
    // ...and a start in the future (clock skew) clamps to a real zero elapsed,
    // which is the honest reading of a task that began this instant.
    const skewed = worked({
      record: inFlightRecord({ current: { number: 31, started_at: new Date(NOW + 3 * MIN).toISOString() } }),
    })
    expect(skewed.taskRows.at(-1).durationMs).toBe(0)
  })

  it('is unaffected by the queue depth — rows are recorded facts, not projections', () => {
    expect(worked().taskRows).toHaveLength(3)
    expect(worked({ queue: null }).taskRows).toEqual(worked().taskRows)
    expect(worked({ queue: 900 }).taskRows).toEqual(worked().taskRows)
  })
})

describe('buildProgress — titles are INJECTED, because no event records one (#56)', () => {
  it('resolves each row’s title from the map the shell passed in', () => {
    expect(worked().taskRows.map((row) => row.title)).toEqual(['sidebar', 'persist', 'row comp'])
  })

  it('accepts a Map as readily as a plain object', () => {
    const snapshot = worked({ titles: new Map([[29, 'sidebar'], [31, 'row comp']]) })
    expect(snapshot.taskRows.map((row) => row.title)).toEqual(['sidebar', null, 'row comp'])
  })

  it('has no title at all when the shell could supply none', () => {
    for (const titles of [undefined, null, {}, new Map(), 'nope', 42]) {
      const snapshot = worked({ titles })
      expect(snapshot.taskRows.map((row) => row.title), String(titles)).toEqual([null, null, null])
    }
  })

  it('falls back to a title the EVENT carries, for a writer that starts recording one', () => {
    const snapshot = worked({
      metricsText: jsonl(event({ number: 29, title: 'from the event', ts: 1 })),
      titles: {},
    })
    expect(snapshot.taskRows[0].title).toBe('from the event')
  })

  it('lets the injected title win over the event’s — the shell just read GitHub', () => {
    const snapshot = worked({
      metricsText: jsonl(event({ number: 29, title: 'stale', ts: 1 })),
      titles: { 29: 'fresh' },
    })
    expect(snapshot.taskRows[0].title).toBe('fresh')
  })

  it('strips control characters, escape sequences and newlines from an untrusted title', () => {
    const snapshot = worked({
      titles: { 31: 'fix\n\r\tthe \u001B[31mred\u001B[0m thing\u0007' },
      metricsText: '',
    })
    // One line, no ESC, no bell: a GitHub title is text somebody else wrote, and a
    // status view must not let it repaint the reader's terminal.
    expect(snapshot.taskRows[0].title).toBe('fix the red thing')
  })

  it('truncates a title too wide for the column instead of letting it push the table', () => {
    const snapshot = worked({
      titles: { 31: 'refactor the entire notification subsystem end to end' },
      metricsText: '',
    })
    expect(snapshot.taskRows[0].title).toBe('refactor the entire not…')
    expect(snapshot.taskRows[0].title.length).toBeLessThanOrEqual(24)
  })

  it('reports a non-string title as no title rather than as its coercion', () => {
    for (const title of [42, true, {}, [], () => {}]) {
      const snapshot = worked({ titles: { 31: title }, metricsText: '' })
      expect(snapshot.taskRows[0].title, String(title)).toBe(null)
    }
  })

  it('reads a title that is blank once cleaned as no title', () => {
    for (const title of ['', '   ', '\n\n', '\u0000\u0007']) {
      const snapshot = worked({ titles: { 31: title }, metricsText: '' })
      expect(snapshot.taskRows[0].title, JSON.stringify(title)).toBe(null)
    }
  })
})

describe('renderProgressLine — done over the LIVE denominator (#56)', () => {
  it('renders the issue’s worked example, in the live view’s label column', () => {
    expect(renderProgressLine(worked())).toBe(
      '  progress   2/9 done · #031 in flight (40min)  [██──────] 22%',
    )
  })

  it('agrees with the table beside it: the fraction counts the rows', () => {
    const snapshot = worked()
    const line = renderProgressLine(snapshot)
    const done = snapshot.taskRows.filter((row) => !row.inFlight).length
    expect(line).toContain(`${done}/${snapshot.total} done`)
    // 2 of 9 is 22.2%, and the bar's 2 filled cells of 8 are the same fraction
    // drawn — the percentage is never computed from anything but the counts.
    expect(line).toContain('22%')
  })

  it('says nothing is in flight rather than naming a task the record does not', () => {
    const snapshot = worked({ record: inFlightRecord({ current: null }) })
    expect(renderProgressLine(snapshot)).toBe(
      '  progress   2/8 done · nothing in flight  [██──────] 25%',
    )
  })

  it('names the in-flight task as `#?` and its elapsed as unknown when it cannot read them', () => {
    const snapshot = worked({ record: inFlightRecord({ current: { started_at: 'yesterday' } }) })
    expect(renderProgressLine(snapshot)).toContain('#? in flight (unknown)')
  })

  it('is 0% with an empty bar for a run that has finished nothing', () => {
    const snapshot = worked({ metricsText: '' })
    expect(renderProgressLine(snapshot)).toBe(
      '  progress   0/7 done · #031 in flight (40min)  [────────] 0%',
    )
  })

  it('drops the bar and the percentage — never fakes them — when the queue count failed', () => {
    // The denominator is the thing a bar IS a picture of, so there is no honest bar
    // to draw without one. The completed count stays: it is the table's own row
    // count, and naming which half is missing beats dropping both.
    expect(renderProgressLine(worked({ queue: null }))).toBe(
      '  progress   2/unknown done · #031 in flight (40min)',
    )
  })

  it('is a full bar at 100% only when the queue really is empty', () => {
    const snapshot = worked({ queue: 0, record: inFlightRecord({ current: null }) })
    expect(snapshot.total).toBe(2)
    expect(renderProgressLine(snapshot)).toBe('  progress   2/2 done · nothing in flight  [████████] 100%')
  })

  it('never rounds a nearly-finished run up to 100% or to a full bar', () => {
    // 199 of 200 is 99.5%: rounding would print `100%` beside a task still in
    // flight, and a full bar is the same lie drawn. The last cell and the last
    // percent are reserved for actually being done.
    const line = renderProgressLine({ completed: 199, inFlight: 1, remaining: 0, total: 200, taskRows: [] })
    expect(line).toContain('99%')
    expect(line).toContain('[███████─]')
  })

  it('never rounds a run that has just started down to an empty bar', () => {
    // 1 of 60 is under a sixteenth of a cell. A bar that erased a measured task
    // would be the `$0.0/task` mistake in another alphabet — the same rule the
    // spend line's grid follows.
    const line = renderProgressLine({ completed: 1, inFlight: 1, remaining: 58, total: 60, taskRows: [] })
    expect(line).toContain('1%')
    expect(line).toContain('[█───────]')
  })

  it('says unknown, and invents nothing, for a snapshot with no counts at all', () => {
    expect(renderProgressLine({})).toBe('  progress   unknown')
    expect(renderProgressLine()).toBe('  progress   unknown')
  })

  it('draws no bar for a run whose denominator is a real zero', () => {
    // Nothing completed, nothing in flight, nothing waiting: 0/0 is not 0% and it
    // is not 100% either, so the bar stays away rather than picturing 0/0.
    const line = renderProgressLine({ completed: 0, inFlight: 0, remaining: 0, total: 0, taskRows: [] })
    expect(line).toBe('  progress   0/0 done · nothing in flight')
  })
})

describe('renderTaskTable — number, title, verdict, cost, time (#56)', () => {
  it('renders the issue’s worked example: a header and one line per task', () => {
    expect(renderTaskTable(worked())).toEqual(TABLE)
  })

  it('renders the header and the in-flight row for a run that has completed nothing', () => {
    expect(renderTaskTable(worked({ metricsText: '' }))).toEqual([
      '  task           verdict     cost      time',
      '  #031 row comp  🔄 live     –         ~40min',
    ])
  })

  it('is EMPTY, not a bare header, when there is no task to row', () => {
    expect(renderTaskTable(worked({ metricsText: '', record: inFlightRecord({ current: null }) }))).toEqual(
      [],
    )
    expect(renderTaskTable({})).toEqual([])
    expect(renderTaskTable()).toEqual([])
  })

  it('renders a missing cost as `–`, never as $0.00', () => {
    const lines = renderTaskTable(
      worked({
        metricsText: jsonl(
          event({ number: 29, minutes: 97, cost: null, ts: 1 }),
          event({ number: 30, minutes: 71, cost: 0, ts: 2 }),
        ),
      }),
    )
    expect(lines.join('\n')).not.toContain('$0.00')
    expect(lines[1]).toBe('  #029 sidebar   ✅ pass     –         97min')
    expect(lines[2]).toBe('  #030 persist   ✅ pass     –         71min')
  })

  it('renders a missing duration as `–` too, rather than as 0min', () => {
    const lines = renderTaskTable(
      worked({ metricsText: jsonl(event({ number: 29, minutes: null, cost: 34.1, ts: 1 })) }),
    )
    expect(lines[1]).toBe('  #029 sidebar   ✅ pass     $34.10    –')
  })

  it('marks pass, fail, unknown and the task in flight distinguishably', () => {
    const lines = renderTaskTable(
      worked({
        metricsText: jsonl(
          event({ number: 26, minutes: 97, verdict: 'pass', ts: 1 }),
          event({ number: 27, minutes: 71, verdict: 'fail', ts: 2 }),
          event({ number: 28, minutes: 71, verdict: 'unknown', ts: 3 }),
        ),
        titles: {},
      }),
    )
    const markers = lines.slice(1).map((line) => line.trim().split(/\s{2,}/)[1])
    expect(markers).toEqual(['✅ pass', '❌ fail', '❔ unknown', '🔄 live'])
    expect(new Set(markers).size).toBe(4)
  })

  it('reads a verdict nobody defined as unknown rather than printing it', () => {
    // The writer emits exactly pass/fail/unknown (lib/issue-event.js), so a row
    // saying anything else is a row this view cannot interpret — and issues.jsonl
    // is untrusted text, where a 4 KB "verdict" would take the column with it.
    const lines = renderTaskTable(
      worked({
        metricsText: jsonl(
          event({ number: 29, minutes: 97, verdict: 'PASS', ts: 1 }),
          event({ number: 30, minutes: 71, verdict: 'x'.repeat(4000), ts: 2 }),
        ),
        titles: {},
      }),
    )
    expect(lines[1]).toContain('❔ unknown')
    expect(lines[2]).toContain('❔ unknown')
    expect(lines[2].length).toBeLessThan(80)
  })

  it('renders a titleless row as its number alone, and keeps the table rectangular', () => {
    const lines = renderTaskTable(worked({ titles: {} }))
    expect(lines).toEqual([
      '  task  verdict     cost      time',
      '  #029  ✅ pass     $34.10    97min',
      '  #030  ✅ pass     $28.75    71min',
      '  #031  🔄 live     –         ~40min',
    ])
  })

  it('lets one row lack a title without moving the others’ columns', () => {
    const lines = renderTaskTable(worked({ titles: { 29: 'sidebar' } }))
    expect(lines).toEqual([
      '  task          verdict     cost      time',
      '  #029 sidebar  ✅ pass     $34.10    97min',
      '  #030          ✅ pass     $28.75    71min',
      '  #031          🔄 live     –         ~40min',
    ])
  })

  it('keeps every verdict marker in the same column, whatever the titles are', () => {
    // The property behind the padding, stated as one: the reader scans DOWN the
    // verdict column, so every row's marker has to start at the same offset.
    const lines = renderTaskTable(worked({ titles: { 29: 'sidebar', 30: 'a much longer title' } }))
    const markerAt = lines.slice(1).map((line) => line.search(/[✅❌❔🔄]/u))
    expect(new Set(markerAt).size).toBe(1)
  })

  it('measures a title in terminal COLUMNS, not in code units', () => {
    // An emoji in a GitHub issue title is entirely ordinary, and it is two columns wide
    // but two code units long — while a CJK title is one unit and two columns per
    // character. A `padEnd` counts units, so either one would bend the whole grid
    // around a single title.
    //
    // Asserted as literals, and they only look ragged: `🚀` and every character of
    // `日本語のタイトル` take two columns each, so all four lines below are 51 columns
    // wide up to the `time` column on a terminal that agrees.
    expect(renderTaskTable(worked({ titles: { 29: '🚀 ship it', 30: '日本語のタイトル' } }))).toEqual([
      '  task                   verdict     cost      time',
      '  #029 🚀 ship it        ✅ pass     $34.10    97min',
      '  #030 日本語のタイトル  ✅ pass     $28.75    71min',
      '  #031                   🔄 live     –         ~40min',
    ])
  })

  it('spells a per-task duration in minutes past the hour, on both surfaces', () => {
    // `97min`, not `formatElapsed`'s `1h37m`: the column is read DOWN, against the
    // other tasks and against the `~84 min/task` pace line, and minutes are the unit
    // that comparison happens in — the same argument the pace line makes for itself.
    // The RUN-scale spans (the heading's `3h12m ago`, the ETA's `9h08m left`) keep the
    // hour, and the two never describe the same quantity.
    const snapshot = worked({
      metricsText: jsonl(event({ number: 29, minutes: 97, cost: 34.1, ts: 1 })),
      record: inFlightRecord({
        current: { number: 31, started_at: new Date(NOW - 185 * MIN).toISOString() },
      }),
    })
    const lines = renderTaskTable(snapshot)
    expect(lines[1]).toContain('97min')
    expect(lines[2]).toContain('~185min')
    // ...and the line above the table says the same thing about the same task, rather
    // than `3h05m` two lines up from `~185min`.
    expect(renderProgressLine(snapshot)).toContain('#031 in flight (185min)')
  })

  it('never lets a wide task number push every other row right', () => {
    // A corrupt row's number is not truncated — money and identity are the two
    // things this view will not shorten — so it overflows its OWN row instead of
    // widening the column for everybody.
    const lines = renderTaskTable(
      worked({
        metricsText: jsonl(
          event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
          event({ number: 1e21, minutes: 71, cost: 28.75, ts: 2 }),
        ),
        titles: { 29: 'sidebar' },
      }),
    )
    expect(lines[1]).toBe('  #029 sidebar  ✅ pass     $34.10    97min')
    expect(lines[2]).toContain('✅ pass')
    expect(lines[2]).not.toMatch(/e\+\d/)
  })

  it('renders a `#?` row for a task the file never numbered', () => {
    const lines = renderTaskTable(
      worked({ metricsText: 'RALPH_ISSUE_EVENT {"run_id":"' + RUN + '","verdict":"pass"}\n', titles: {} }),
    )
    expect(lines[1]).toContain('#?  ')
    expect(lines.join('\n')).not.toContain('undefined')
    expect(lines.join('\n')).not.toContain('NaN')
  })

  it('prints no NaN, no Infinity and no exponent for magnitudes out of a corrupt file', () => {
    const lines = renderTaskTable(
      worked({
        metricsText: jsonl(
          event({ number: 29, minutes: 1e10, cost: 1e300, ts: 1 }),
          { issue_number: 30, run_id: RUN, duration_ms: -5, total_cost_usd: -12.5, ts: 2 },
        ),
        titles: {},
      }),
    )
    const text = lines.join('\n')
    expect(text).not.toMatch(/NaN|Infinity/)
    expect(text).not.toMatch(/e[+-]\d/)
  })

  it('is deterministic and mutates nothing it was handed', () => {
    const snapshot = worked()
    const before = JSON.stringify(snapshot)
    expect(renderTaskTable(snapshot)).toEqual(renderTaskTable(snapshot))
    expect(JSON.stringify(snapshot)).toBe(before)
  })
})

describe('padTaskNumber — one three-digit pad, shared by both surfaces (#56)', () => {
  it('zero-pads to three digits and never truncates a wider number', () => {
    expect(padTaskNumber(31)).toBe('031')
    expect(padTaskNumber(7)).toBe('007')
    expect(padTaskNumber(1234)).toBe('1234')
    expect(padTaskNumber(null)).toBe('?')
    expect(padTaskNumber('31')).toBe('?')
  })

  it('spells an absurd magnitude out rather than in exponent notation', () => {
    // The same rule `formatElapsed` follows: a corrupt row reads as absurd, not as
    // `#1e+21`, which looks like a bug in Ralph rather than in the file.
    expect(padTaskNumber(1e21)).not.toMatch(/e[+-]\d/)
  })
})
