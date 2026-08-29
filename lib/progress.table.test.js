import { describe, it, expect } from 'vitest'
import {
  buildProgress,
  padTaskNumber,
  renderProgressLine,
  renderTaskTable,
  toJsonSnapshot,
} from './progress.js'

// #56 — the per-task table and the progress line, the two surfaces that make the
// live denominator legible. The counts and the scoping behind them are #57's and are
// pinned in progress.test.js; what is new here is the ROWS (one per task this run has
// touched, in file order, with the in-flight one last) and the two pure renderers
// that draw them.
//
// A separate file, per this module's slice-per-file grain (progress.test.js is #57's,
// progress.json.test.js is #58's, progress.launch.qa.test.js is #60's): the table is
// its own surface with its own vocabulary — column widths, verdict markers, the `–`
// that is not `$0.00` — and reading it interleaved with the pace/ETA/spend assertions
// would tell a reader neither story.
//
// THREE PROPERTIES ARE WHAT THIS FILE IS FOR, and every describe below belongs to
// one of them:
//
//   1. THE ROWS ARE THE NUMERATOR. The fraction on the progress line, the percentage
//      beside it and the rows in the table are one fact rendered three times, so they
//      are checked against each other rather than only against literals.
//   2. A TITLE IS THE ONLY ATTACKER-CONTROLLED TEXT IN THE VIEW. Somebody else writes
//      the GitHub issue, so the sanitizing lives in this pure module where it is unit
//      testable, and the cases below ask two questions of every shape: did an escape
//      or a control byte reach the terminal, and did it move somebody else's column.
//   3. THE GRID IS A PROMISE. A reader scans DOWN the verdict, cost and time columns —
//      that is the only reason a table beats three sentences — so the task column's
//      derived width is measured against an INDEPENDENT width function rather than
//      against the module's own.
//
// Control bytes are spelled with `String.fromCharCode`/`fromCodePoint` throughout,
// deliberately: a suite about invisible characters must not depend on an invisible
// character surviving a copy, a paste or a tool argument.
//
// Local Date constructors and an injected `now` throughout, exactly like the sibling
// files: the rendered elapsed is arithmetic, but the run's fixtures are wall-clock
// instants and a UTC ISO literal would make the suite timezone-dependent.

const MIN = 60000
const RUN = 'ralph-ralph-b36ff7b1'
const OTHER_RUN = 'ralph-ralph-0badf00d'

// How many CLOSED rows the table draws before it elides the rest. Written down here
// rather than imported from the module: a test that read the module's own constant would
// agree with whatever value the module happened to hold, and the number is the contract —
// the view's height must not grow with the run's length.
const TABLE_CAP = 8

const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime() // 40min into #031

// Bytes and code points by number, never as literals — see the note above.
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const NUL = String.fromCharCode(0)
const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const TAB = String.fromCharCode(9)
const VT = String.fromCharCode(11)
const DEL = String.fromCharCode(127)
const cp = (n) => String.fromCodePoint(n)
const LRO = cp(0x202e) // right-to-left override: reorders the rest of the line
const POP = cp(0x202c)
const ZWSP = cp(0x200b)
const ZWJ = cp(0x200d)
const VS16 = cp(0xfe0f)
const SOFT_HYPHEN = cp(0x00ad)
const NBSP = cp(0x00a0)
const LINE_SEP = cp(0x2028)
const LONE_SURROGATE = String.fromCharCode(0xd800)
const PRIVATE_USE = cp(0xe000)
const ACUTE = cp(0x0301) // combining, and DELIBERATELY kept: `café` must survive

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

// N recorded rows, numbered from `first`, all measured — so every fixture has a pace,
// a spend and a full table to lose.
const runOf = (n, first = 29) =>
  n === 0
    ? ''
    : jsonl(
        ...Array.from({ length: n }, (_, i) =>
          event({ number: first + i, minutes: 60 + i, cost: 1 + i, ts: i + 1 }),
        ),
      )

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

// A label that survives an input `String()` refuses to coerce, so every loop below
// can report which case failed.
const describeInput = (value) => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

// ---------------------------------------------------------------------------
// AN INDEPENDENT COLUMN MEASURE.
//
// Written from the Unicode East Asian Width W/F ranges and the emoji blocks rather
// than copied from lib/progress.js's own table, because an alignment assertion that
// shared the implementation's width list would agree with it on exactly the glyphs it
// gets wrong. Covers every code point the fixtures here use — the four verdict
// markers, U+1F680, CJK, Hangul, the fullwidth forms — and treats combining marks,
// variation selectors and format characters as zero, which is what a terminal does.
// ---------------------------------------------------------------------------
const WIDE = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2705, 0x2705], // the pass marker
  [0x274c, 0x274c], // the fail marker
  [0x2753, 0x2755], // the unknown marker and its neighbours
  [0x2e80, 0x303e], // CJK radicals … CJK symbols
  [0x3041, 0x33ff], // Hiragana … CJK compatibility
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // the in-flight marker, the pictographs
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u

function columns(text) {
  let width = 0
  for (const ch of String(text)) {
    if (ZERO.test(ch)) continue
    const point = ch.codePointAt(0)
    width += WIDE.some(([lo, hi]) => point >= lo && point <= hi) ? 2 : 1
  }
  return width
}

const MARKER = new RegExp(`[${cp(0x2705)}${cp(0x274c)}${cp(0x2754)}${cp(0x1f504)}]`, 'u')

// Which terminal column each rendered line's verdict cell begins in — the property
// every table here is checked against: one answer for the header and for every row
// under it. Anchored on the LAST marker in the line, so a title that happens to
// contain a marker glyph (an issue titled with a tick, entirely legal) cannot make
// the measurement read the wrong cell.
const verdictColumn = (line) => {
  const matches = [...line.matchAll(new RegExp(MARKER, 'gu'))]
  const at = matches.length > 0 ? matches.at(-1).index : line.lastIndexOf('verdict')
  return columns(line.slice(0, at))
}
const aligned = (lines) => new Set(lines.map(verdictColumn)).size === 1

// Where the money starts, for the same reason: the verdict cells are claimed to be
// identical in width BY CONSTRUCTION, and this is the column that proves it.
const costColumn = (line) =>
  columns(line.slice(0, line.lastIndexOf('$') === -1 ? 0 : line.lastIndexOf('$')))

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
    // `key` is null on every row of a github run — a task's Jira key (#127), which only
    // the jira source has. It is on the closed rows too, and deliberately: one row shape
    // for both sources beats a field that appears and disappears.
    expect(worked().tasks).toEqual([
      {
        number: 29,
        key: null,
        title: 'sidebar',
        verdict: 'pass',
        costUsd: 34.1,
        durationMs: 97 * MIN,
        inFlight: false,
      },
      {
        number: 30,
        key: null,
        title: 'persist',
        verdict: 'pass',
        costUsd: 28.75,
        durationMs: 71 * MIN,
        inFlight: false,
      },
      {
        number: 31,
        key: null,
        title: 'row comp',
        verdict: null,
        costUsd: null,
        durationMs: 40 * MIN,
        inFlight: true,
      },
    ])
  })

  it('counts the same tasks the fraction does — the rows ARE the numerator', () => {
    const snapshot = worked()
    expect(snapshot.tasks.filter((task) => !task.inFlight).length).toBe(snapshot.completed)
    expect(snapshot.tasks.filter((task) => task.inFlight).length).toBe(snapshot.inFlight)
  })

  it('never rows another run’s tasks, however the file interleaves them', () => {
    const snapshot = worked({
      metricsText: jsonl(
        event({ number: 90, run: OTHER_RUN, minutes: 10, cost: 500, ts: 1 }),
        event({ number: 29, minutes: 97, cost: 34.1, ts: 2 }),
        event({ number: 91, run: OTHER_RUN, minutes: 10, cost: 500, ts: 3 }),
      ),
    })
    expect(snapshot.tasks.map((task) => task.number)).toEqual([29, 31])
    const text = renderTaskTable(snapshot).join('\n')
    expect(text).not.toContain('#090')
    expect(text).not.toContain('$500')
  })

  it('claims no history for a record that cannot name its own run', () => {
    // An unnamed run matches NO history (belongsToRun's rule) — and still rows the
    // task it says it is working on, which is the record's own fact.
    for (const runId of [null, undefined, '', 0, false]) {
      expect(
        worked({ record: inFlightRecord({ run_id: runId }) }).tasks.map((task) => task.number),
        describeInput(runId),
      ).toEqual([31])
    }
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
    expect(snapshot.tasks.map((task) => task.number)).toEqual([29, 31])
    expect(renderTaskTable(snapshot).join('\n')).not.toMatch(/NaN|undefined/)
  })

  it('rows only the task in flight for a run that has completed nothing', () => {
    expect(worked({ metricsText: '' }).tasks).toEqual([
      {
        number: 31,
        key: null,
        title: 'row comp',
        verdict: null,
        costUsd: null,
        durationMs: 40 * MIN,
        inFlight: true,
      },
    ])
  })

  it('rows nothing for a run with no history and no task in flight', () => {
    for (const current of [null, undefined, 0, '', false]) {
      expect(
        worked({ metricsText: '', record: inFlightRecord({ current }) }).tasks,
        describeInput(current),
      ).toEqual([])
    }
  })

  it('rows no task in flight for a run the liveness gate calls over', () => {
    // #59's gate, restated for the new field: `interrupted` is a record still saying
    // `running` with no process behind it, and the row would have the table claim a
    // dead run is still working. The closed rows are facts and stay.
    const snapshot = worked({ runAlive: false })
    expect(snapshot.inFlight).toBe(0)
    expect(snapshot.tasks.map((task) => task.number)).toEqual([29, 30])
    expect(snapshot.tasks.some((task) => task.inFlight)).toBe(false)
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
    expect(snapshot.tasks.map((task) => [task.number, task.costUsd, task.durationMs])).toEqual([
      [27, null, null],
      [28, null, null],
      [29, null, null],
      [null, null, null],
    ])
  })

  it('holds every numeric cell to null-or-finite over a corrupt file', () => {
    const corruptions = [
      { duration_ms: 1e300 },
      { duration_ms: 1e21 },
      { duration_ms: -5 },
      { duration_ms: -0 },
      { duration_ms: true },
      { duration_ms: [97000] },
      { total_cost_usd: 1e21 },
      { total_cost_usd: -12.5 },
      { total_cost_usd: {} },
      { issue_number: 1e21 },
      { issue_number: '31' },
      { issue_number: undefined, duration_ms: undefined },
    ]
    for (const overrides of corruptions) {
      const label = describeInput(overrides)
      const snapshot = worked({
        metricsText: jsonl({ issue_number: 30, run_id: RUN, ts: 1, verdict: 'pass', ...overrides }),
        titles: {},
      })
      for (const task of snapshot.tasks) {
        for (const field of ['number', 'costUsd', 'durationMs']) {
          const value = task[field]
          expect(value == null || Number.isFinite(value), `${label} → ${field}=${value}`).toBe(true)
        }
      }
      // Degraded, never dropped: the row the corruption is on is still there.
      expect(snapshot.tasks, label).toHaveLength(2)
      const text = [renderProgressLine(snapshot), ...renderTaskTable(snapshot)].join('\n')
      expect(text, label).not.toMatch(/NaN|Infinity|undefined|null/)
      expect(text, label).not.toMatch(/e[+-]\d/)
      expect(text, label).not.toContain('$0.00')
    }
  })

  it('reads a magnitude too large for JSON to hold as no measurement at all', () => {
    // `1e400` parses to Infinity, which is the shape an overflowed writer leaves.
    const snapshot = worked({
      metricsText:
        'RALPH_ISSUE_EVENT ' +
        `{"issue_number":30,"run_id":"${RUN}","duration_ms":1e400,"total_cost_usd":1e400}`,
      record: inFlightRecord({ current: null }),
      titles: {},
    })
    expect(snapshot.tasks[0]).toMatchObject({ costUsd: null, durationMs: null })
    expect(renderTaskTable(snapshot)[1]).toContain('–')
  })

  it('carries the three verdicts the writer emits, and null for anything else', () => {
    const snapshot = worked({
      metricsText: jsonl(
        event({ number: 29, verdict: 'pass', ts: 1 }),
        event({ number: 30, verdict: 'fail', ts: 2 }),
        event({ number: 31, verdict: 'unknown', ts: 3 }),
        event({ number: 32, verdict: 'PASS', ts: 4 }),
        event({ number: 33, verdict: '__proto__', ts: 5 }),
        { issue_number: 34, run_id: RUN, ts: 6 },
      ),
      record: inFlightRecord({ current: null }),
    })
    expect(snapshot.tasks.map((task) => task.verdict)).toEqual([
      'pass',
      'fail',
      'unknown',
      null,
      null,
      null,
    ])
  })

  it('times the in-flight row from its own start, and says null when it cannot', () => {
    expect(worked().tasks.at(-1).durationMs).toBe(40 * MIN)
    // An unparseable start is NOT a zero elapsed on this row. The ETA deliberately
    // reads it as 0 (the task is in flight, so it is still owed a full estimate); a
    // table cell saying `0min` would claim the task started this instant.
    const unreadable = worked({
      record: inFlightRecord({ current: { number: 31, started_at: 'soon' } }),
    })
    expect(unreadable.tasks.at(-1).durationMs).toBe(null)
    // ...and a start in the future (clock skew) clamps to a real zero elapsed.
    const skewed = worked({
      record: inFlightRecord({
        current: { number: 31, started_at: new Date(NOW + 3 * MIN).toISOString() },
      }),
    })
    expect(skewed.tasks.at(-1).durationMs).toBe(0)
  })

  it('is unaffected by the queue depth — rows are recorded facts, not projections', () => {
    expect(worked().tasks).toHaveLength(3)
    expect(worked({ queue: null }).tasks).toEqual(worked().tasks)
    expect(worked({ queue: 900 }).tasks).toEqual(worked().tasks)
  })

  it('mutates neither the record nor the titles map it was handed', () => {
    const titles = { 29: 'sidebar', 30: 'persist' }
    const record = inFlightRecord()
    const before = [JSON.stringify(titles), JSON.stringify(record)]
    buildProgress({ metricsText: runOf(2), record, queue: 6, now: NOW, titles })
    expect([JSON.stringify(titles), JSON.stringify(record)]).toEqual(before)
    // ...and a frozen pair, which is what a status view is really handed.
    expect(() =>
      buildProgress({
        metricsText: runOf(2),
        record: Object.freeze({ ...record, current: Object.freeze({ ...record.current }) }),
        queue: 6,
        now: NOW,
        titles: Object.freeze({ ...titles }),
      }),
    ).not.toThrow()
  })
})

describe('buildProgress — titles are INJECTED, because no event records one (#56)', () => {
  const titleOf = (titles) => worked({ titles }).tasks[0].title

  it('resolves each row’s title from the map the shell passed in', () => {
    expect(worked().tasks.map((task) => task.title)).toEqual(['sidebar', 'persist', 'row comp'])
  })

  it('accepts a Map, and the string keys JSON.parse hands over, as readily as an object', () => {
    expect(titleOf({ 29: 'sidebar' })).toBe('sidebar')
    expect(titleOf(JSON.parse('{"29":"sidebar"}'))).toBe('sidebar')
    expect(titleOf(new Map([[29, 'sidebar']]))).toBe('sidebar')
  })

  it('renders numbers rather than refusing, for a titles map of any wrong shape', () => {
    for (const titles of [
      undefined,
      null,
      false,
      0,
      '',
      'sidebar',
      42,
      [],
      new Set(['sidebar']),
      Object.create(null),
      { get: 'not a function' },
      new Map(),
    ]) {
      let tasks
      expect(() => {
        tasks = worked({ titles }).tasks
      }, describeInput(titles)).not.toThrow()
      expect(
        tasks.map((task) => task.title),
        describeInput(titles),
      ).toEqual([null, null, null])
    }
  })

  it('falls back to a title the EVENT carries, for a writer that starts recording one', () => {
    const snapshot = worked({
      metricsText: jsonl(event({ number: 29, title: 'from the event', ts: 1 })),
      titles: {},
    })
    expect(snapshot.tasks[0].title).toBe('from the event')
  })

  it('lets the injected title win over the event’s — the shell just read GitHub', () => {
    const snapshot = worked({
      metricsText: jsonl(event({ number: 29, title: 'stale', ts: 1 })),
      titles: { 29: 'fresh' },
    })
    expect(snapshot.tasks[0].title).toBe('fresh')
  })

  it('reports a non-string title as no title rather than as its coercion', () => {
    for (const title of [42, true, {}, [], () => {}]) {
      expect(titleOf({ 29: title }), describeInput(title)).toBe(null)
    }
  })

  it('never lets a title become the empty string, which would silently widen the column', () => {
    for (const title of ['', ' ', '   ', LF + LF, TAB, NBSP, ZWSP, LRO + POP, NUL + BEL]) {
      expect(titleOf({ 29: title }), JSON.stringify(title)).toBe(null)
    }
  })

  it('strips control bytes, escape sequences and newlines from an untrusted title', () => {
    const snapshot = worked({
      titles: { 31: `fix${LF}${CR}${TAB}the ${ESC}[31mred${ESC}[0m thing${BEL}` },
      metricsText: '',
    })
    // One line, no ESC, no bell: a GitHub title is text somebody else wrote, and a
    // status view must not let it repaint the reader's terminal.
    expect(snapshot.tasks[0].title).toBe('fix the red thing')
  })

  it('truncates a title too wide for the column instead of letting it push the table', () => {
    expect(titleOf({ 29: 'refactor the entire notification subsystem end to end' })).toBe(
      'refactor the entire not…',
    )
    // A title exactly at the cap keeps every column and gains no ellipsis.
    expect(titleOf({ 29: 'x'.repeat(24) })).toBe('x'.repeat(24))
  })

  it('truncates at 24 COLUMNS rather than 24 characters, and marks the cut', () => {
    // A wide-character title has to be cut by what the terminal draws, or a CJK title
    // would take 48 columns of a 24-column cell.
    const cjk = titleOf({ 29: cp(0x4e00).repeat(40) })
    expect(columns(cjk)).toBeLessThanOrEqual(24)
    expect(cjk.endsWith('…')).toBe(true)
    expect(columns(titleOf({ 29: cp(0x4e00).repeat(12) }))).toBe(24)
    const ascii = titleOf({ 29: 'x'.repeat(400) })
    expect(columns(ascii)).toBeLessThanOrEqual(24)
    expect(ascii.endsWith('…')).toBe(true)
  })

  it('stays inside the column when the first visible glyph is thousands of marks away', () => {
    // The raw cap under attack: a title that spends 5000 combining marks before its
    // first letter. Mn is deliberately KEPT by the sanitizer (stripping it would break
    // `café`), so what has to hold is the column cap AND a cap on how many code points
    // are emitted at all — a thousand marks stacked on one cell is a picture, not text.
    const title = ACUTE.repeat(5000) + 'real title'
    const cleaned = titleOf({ 29: title })
    expect(columns(cleaned)).toBeLessThanOrEqual(24)
    expect([...cleaned].length).toBeLessThanOrEqual(64)
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
    const done = snapshot.tasks.filter((task) => !task.inFlight).length
    expect(line).toContain(`${done}/${snapshot.total} done`)
    // 2 of 9 is 22.2%, and the bar's 2 filled cells of 8 are the same fraction drawn.
    expect(line).toContain('22%')
  })

  it('says nothing is in flight rather than naming a task the record does not', () => {
    expect(renderProgressLine(worked({ record: inFlightRecord({ current: null }) }))).toBe(
      '  progress   2/8 done · nothing in flight  [██──────] 25%',
    )
  })

  it('names the in-flight task `#?` and its elapsed unknown when it cannot read them', () => {
    const snapshot = worked({ record: inFlightRecord({ current: { started_at: 'yesterday' } }) })
    expect(renderProgressLine(snapshot)).toContain('#? in flight (unknown)')
  })

  it('is 0% with an empty bar for a run that has finished nothing', () => {
    expect(renderProgressLine(worked({ metricsText: '' }))).toBe(
      '  progress   0/7 done · #031 in flight (40min)  [────────] 0%',
    )
  })

  it('drops the bar and the percentage — never fakes them — when the queue count failed', () => {
    // The denominator is the thing a bar IS a picture of, so there is no honest bar to
    // draw without one. The completed count stays: it is the table's own row count,
    // and naming which half is missing beats dropping both.
    expect(renderProgressLine(worked({ queue: null }))).toBe(
      '  progress   2/unknown done · #031 in flight (40min)',
    )
  })

  it('is a full bar at 100% only when the queue really is empty', () => {
    const snapshot = worked({ queue: 0, record: inFlightRecord({ current: null }) })
    expect(snapshot.total).toBe(2)
    expect(renderProgressLine(snapshot)).toBe(
      '  progress   2/2 done · nothing in flight  [████████] 100%',
    )
  })

  it('never rounds a nearly-finished run up to 100% or to a full bar', () => {
    // 199 of 200 is 99.5%: rounding would print `100%` beside a task still in flight,
    // and a full bar is the same lie drawn. The last cell and the last percent are
    // reserved for actually being done.
    const line = renderProgressLine({ completed: 199, inFlight: 1, remaining: 0, total: 200 })
    expect(line).toContain('99%')
    expect(line).toContain('[███████─]')
  })

  it('never rounds a run that has just started down to an empty bar OR to 0%', () => {
    // 1 of 60 is under a sixteenth of a cell, and 1 of 102 — the queue count's own
    // `--limit 100` ceiling — is under a percent. Erasing a measured task is the
    // `$0.0/task` mistake in another alphabet, and it is the same mistake whether it
    // happens in the picture or in the number the reader actually reads. So both ends
    // reserve, and they reserve together.
    const near = renderProgressLine({ completed: 1, inFlight: 1, remaining: 58, total: 60 })
    expect(near).toContain('1%')
    expect(near).toContain('[█───────]')
    const ceiling = renderProgressLine({ completed: 1, inFlight: 1, remaining: 100, total: 102 })
    expect(ceiling).toContain('1%')
    expect(ceiling).toContain('[█───────]')
  })

  it('says unknown, and invents nothing, for a snapshot with no counts at all', () => {
    expect(renderProgressLine({})).toBe('  progress   unknown')
    expect(renderProgressLine()).toBe('  progress   unknown')
  })

  it('draws no bar for a run whose denominator is a real zero', () => {
    // Nothing completed, nothing in flight, nothing waiting: 0/0 is not 0% and it is
    // not 100% either, so the bar stays away rather than picturing 0/0.
    expect(renderProgressLine({ completed: 0, inFlight: 0, remaining: 0, total: 0 })).toBe(
      '  progress   0/0 done · nothing in flight',
    )
  })

  it('recomputes the denominator from the queue it was handed on every call', () => {
    // The AC's live-denominator rule, stated as a difference: the same history and the
    // same record, three queue depths, three denominators — nothing cached.
    const denominators = [0, 6, 100].map(
      (queue) => renderProgressLine(worked({ queue })).match(/\d+\/(\d+)/)[1],
    )
    expect(denominators).toEqual(['3', '9', '103'])
  })

  it('never contradicts itself over any (completed, queue) pair a run can reach', () => {
    // The three renderings of one fact, checked against each other rather than
    // against literals. The queue count is capped at `--limit 100` by
    // lib/commands/status.js, so 0..100 is the whole range of denominators.
    for (const done of [0, 1, 2, 3, 8, 12]) {
      for (const queue of [0, 1, 2, 5, 8, 60, 100]) {
        for (const current of [true, false]) {
          const snapshot = worked({
            metricsText: runOf(done),
            record: inFlightRecord(current ? {} : { current: null }),
            queue,
          })
          const knobs = JSON.stringify({ done, queue, current })
          const line = renderProgressLine(snapshot)
          const table = renderTaskTable(snapshot)
          const closed = snapshot.tasks.filter((task) => !task.inFlight).length
          // The FRACTION counts every closed task, whether or not the table drew it: the
          // cap below is about the screen, and `12/…` must not become `8/…` because of it.
          expect(line, knobs).toContain(`${closed}/`)
          // Header, the rows on show, and — only when rows were elided — the one line
          // that says so. Or nothing at all: never a header over no rows.
          const shown = Math.min(closed, TABLE_CAP)
          const elided = closed > shown ? 1 : 0
          expect(table.length, knobs).toBe(
            snapshot.tasks.length === 0 ? 0 : 1 + elided + shown + (current ? 1 : 0),
          )
          // The two surfaces agree about whether anything is in flight...
          expect(line.includes('nothing in flight'), knobs).toBe(
            snapshot.tasks.every((task) => !task.inFlight),
          )
          // ...the denominator always owes a task in flight a place of its own...
          if (current) {
            expect(snapshot.total, knobs).toBeGreaterThan(snapshot.completed)
            expect(line, knobs).not.toContain('100%')
            expect(line, knobs).not.toContain('█'.repeat(8))
          }
          // ...and a filled cell never sits beside `0%`.
          const percent = line.match(/(\d+)%/)
          if (percent && (line.match(/█/g) ?? []).length > 0) {
            expect(Number(percent[1]), `${knobs} → ${line}`).toBeGreaterThan(0)
          }
        }
      }
    }
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
    expect(
      renderTaskTable(worked({ metricsText: '', record: inFlightRecord({ current: null }) })),
    ).toEqual([])
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

  it('keeps a cost under a cent distinguishable from a cost nobody recorded', () => {
    const costOf = (total_cost_usd) =>
      renderTaskTable(
        worked({
          metricsText: jsonl({
            issue_number: 29,
            run_id: RUN,
            ts: 1,
            duration_ms: 97 * MIN,
            total_cost_usd,
            verdict: 'pass',
          }),
          record: inFlightRecord({ current: null }),
          titles: {},
        }),
      )[1]
        .trim()
        .split(/\s{2,}/)[2]
    for (const missing of [undefined, null, 0, -0, -12.5, 'free', {}, [], true]) {
      expect(costOf(missing), describeInput(missing)).toBe('–')
    }
    // The one reading that must not collapse into `–`: a task that really did cost
    // something, just less than the grid can show.
    expect(costOf(0.0000001)).toBe('<$0.01')
    expect(costOf(0.01)).toBe('$0.01')
  })

  it('renders a missing or unmeasured duration as `–`, rather than as 0min', () => {
    const lines = renderTaskTable(
      worked({
        metricsText: jsonl(
          event({ number: 29, minutes: null, cost: 34.1, ts: 1 }),
          event({ number: 30, minutes: 0, cost: 28.75, ts: 2 }),
        ),
      }),
    )
    expect(lines[1]).toBe('  #029 sidebar   ✅ pass     $34.10    –')
    expect(lines[2]).toBe('  #030 persist   ✅ pass     $28.75    –')
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
    const cells = lines.slice(1).map((line) => line.trim().split(/\s{2,}/)[1])
    expect(cells).toEqual(['✅ pass', '❌ fail', '❔ unknown', '🔄 live'])
    // No marker may appear in two cells: the glyph alone has to answer the question,
    // because that is what a reader scans for.
    expect(new Set(cells.map((cell) => cell.match(MARKER)[0])).size).toBe(4)
  })

  it('reads a verdict nobody defined as unknown rather than printing it', () => {
    // The writer emits exactly pass/fail/unknown (lib/issue-event.js), so a row saying
    // anything else is a row this view cannot interpret — and issues.jsonl is
    // untrusted text, where a 4 KB "verdict" would take the column with it.
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

  it('keeps the money in one column for every verdict, so the cells are one width', () => {
    // The emoji decision's whole claim: `marker + ' ' + word.padEnd(7)` is identical
    // in width for all four verdicts BY CONSTRUCTION. Measured where it matters —
    // where the next column starts.
    const rows = ['pass', 'fail', 'unknown', 'partial', null].map(
      (verdict) =>
        renderTaskTable(
          worked({
            metricsText: jsonl({
              issue_number: 29,
              run_id: RUN,
              ts: 1,
              duration_ms: 97 * MIN,
              total_cost_usd: 1,
              verdict,
            }),
            record: inFlightRecord({ current: null }),
            titles: {},
          }),
        )[1],
    )
    expect(new Set(rows.map(costColumn)).size, rows.join('\n')).toBe(1)
  })

  it('renders a titleless row as its number alone, and keeps the table rectangular', () => {
    expect(renderTaskTable(worked({ titles: {} }))).toEqual([
      '  task  verdict     cost      time',
      '  #029  ✅ pass     $34.10    97min',
      '  #030  ✅ pass     $28.75    71min',
      '  #031  🔄 live     –         ~40min',
    ])
  })

  it('lets one row lack a title without moving the others’ columns', () => {
    expect(renderTaskTable(worked({ titles: { 29: 'sidebar' } }))).toEqual([
      '  task          verdict     cost      time',
      '  #029 sidebar  ✅ pass     $34.10    97min',
      '  #030          ✅ pass     $28.75    71min',
      '  #031          🔄 live     –         ~40min',
    ])
  })

  it('measures a title in terminal COLUMNS, not in code units', () => {
    // An emoji in a GitHub issue title is entirely ordinary, and it is two columns
    // wide but two code units long — while a CJK title is one unit and two columns per
    // character. A `padEnd` counts units, so either one would bend the whole grid
    // around a single title.
    //
    // Asserted as literals, and they only look ragged: the rocket and every character
    // of the CJK title take two columns each, so all four lines are 51 columns wide up
    // to the `time` column on a terminal that agrees.
    const lines = renderTaskTable(
      worked({ titles: { 29: cp(0x1f680) + ' ship it', 30: '日本語のタイトル' } }),
    )
    expect(lines).toEqual([
      '  task                   verdict     cost      time',
      '  #029 🚀 ship it        ✅ pass     $34.10    97min',
      '  #030 日本語のタイトル  ✅ pass     $28.75    71min',
      '  #031                   🔄 live     –         ~40min',
    ])
    expect(aligned(lines)).toBe(true)
  })

  it('keeps the grid rectangular for every title shape a GitHub issue can carry', () => {
    // Each of these breaks a different naive width model, and each is a title somebody
    // can really write. The sibling row is deliberately short ASCII, so any drift
    // shows up as two different verdict columns.
    const titles = {
      'a CJK title (one unit, two columns per character)': '日本語のタイトル',
      'an emoji at the front': cp(0x1f680) + ' ship it',
      'a Hangul title': '한국어 제목',
      'a fullwidth-digit title that looks like ASCII': cp(0xff11) + cp(0xff12) + ' wide',
      'decomposed combining marks, as macOS writes them': 'e' + ACUTE + 'cole cafe' + ACUTE,
      'right-to-left text': 'שלום עולם',
      'a bidi override that would reorder the line': 'safe' + LRO + 'gnorw' + POP,
      'a zero-width space inside a word': 'a' + ZWSP + 'b split',
      'a zero-width joiner between two emoji': cp(0x1f469) + ZWJ + cp(0x1f4bb) + ' dev',
      'a skin-tone modifier': cp(0x1f44d) + cp(0x1f3fd) + ' ok',
      'a variation selector asking for emoji presentation': cp(0x2764) + VS16 + ' love',
      'a soft hyphen inside a word': 'soft' + SOFT_HYPHEN + 'hyphen',
      'a non-breaking space between words': 'nbsp' + NBSP + 'here',
      'a lone surrogate from a truncated write': 'bad' + LONE_SURROGATE + 'end',
      'a private-use code point of unknown width': 'pua' + PRIVATE_USE + 'here',
      'a tab that would misalign the row': 'tab' + TAB + 'here',
      'a bell that would make the row audible': 'bell' + BEL + 'here',
      'a raw CSI sequence': ESC + '[31mred' + ESC + '[0m thing',
      'a raw OSC window-title sequence': ESC + ']0;pwned' + BEL + 'title',
      'an unterminated CSI sequence': ESC + '[38;5;213',
      'a vertical tab': 'a' + VT + 'b',
      'a DEL byte': 'a' + DEL + 'b',
      'a line separator': 'a' + LINE_SEP + 'b',
      'a title exactly at the 24-column cap': 'x'.repeat(24),
      'a title one column over the cap': 'x'.repeat(25),
      'twelve CJK characters — exactly 24 columns': cp(0x4e00).repeat(12),
      'thirteen CJK characters — one glyph over': cp(0x4e00).repeat(13),
      'a title that is nothing but emoji': cp(0x1f680).repeat(20),
      'a title that is only whitespace': '   ',
      'a title that is a number': 42,
      'a title that is null': null,
    }
    for (const [label, title] of Object.entries(titles)) {
      const lines = renderTaskTable(worked({ titles: { 29: title, 30: 'short' } }))
      expect(aligned(lines), `${label}\n${lines.join('\n')}`).toBe(true)
      // ...and the money too, which is the claim the emoji markers rest on.
      expect(new Set(lines.slice(1, 3).map(costColumn)).size, label).toBe(1)
      // Nothing a terminal would obey reaches it: no control byte, no escape, no
      // format character — Cf is the nastier half, since one override reorders the
      // rest of the LINE and could rewrite the verdict beside it.
      for (const line of lines) {
        expect(line, label).not.toMatch(/[\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Cf}]/u)
      }
    }
  })

  it('cannot be made to forge a row, however the title is spelled', () => {
    // A newline in a title would split one row into two, and the second half is
    // attacker-written text in the shape of a verdict and a cost. So the assertions are
    // the row COUNT and what each row STARTS with: header plus exactly three tasks,
    // each still opening with the number the file recorded.
    //
    // The forged text itself is allowed to survive inside the cell it was written in —
    // that is what a title IS, and truncating at the first suspicious word would be a
    // second, worse policy. What it cannot do is become a line of its own, or move the
    // verdict beside it.
    const forgeries = [
      'a' + LF + '  #999 forged   ✅ pass     $0.01     1min',
      'a' + CR + LF + '  #999 forged',
      'a' + LINE_SEP + '  #999 forged',
      'a' + NUL + '  #999 forged',
    ]
    for (const title of forgeries) {
      const label = JSON.stringify(title)
      const lines = renderTaskTable(worked({ titles: { 29: title, 30: 'short' } }))
      expect(lines, label).toHaveLength(4)
      expect(aligned(lines), label).toBe(true)
      expect(
        lines.slice(1).map((line) => line.trim().slice(0, 4)),
        label,
      ).toEqual(['#029', '#030', '#031'])
    }
  })

  it('keeps the ASCII header over rows whose issue numbers are four digits', () => {
    // `  task  ` reserving four columns for a cell that draws five would put the
    // header's `verdict` one column left of every marker below it. A four-digit issue
    // number is not exotic — it is what every repo older than a year has, and
    // `padTaskNumber` promises never to truncate one.
    for (const titles of [{}, { 1234: 'sidebar', 1235: 'a longer title' }]) {
      const lines = renderTaskTable(
        worked({
          metricsText: runOf(2, 1234),
          record: inFlightRecord({ current: null }),
          titles,
        }),
      )
      expect(aligned(lines), `${describeInput(titles)}\n${lines.join('\n')}`).toBe(true)
    }
  })

  it('keeps a run that spans three- and four-digit numbers rectangular', () => {
    // The realistic shape of the hazard: a repo whose queue crossed #1000 mid-run, so
    // the same table carries `#029` and `#1235`. Every title is deliberately the SAME
    // width — with differing widths the extra digit can be swallowed by another row's
    // padding, and a grid that is rectangular only then is not rectangular.
    const lines = renderTaskTable(
      worked({
        metricsText: jsonl(
          event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
          event({ number: 1235, minutes: 71, cost: 28.75, ts: 2 }),
        ),
        titles: { 29: 'sidebar', 1235: 'persist', 31: 'rowcomp' },
      }),
    )
    expect(aligned(lines), lines.join('\n')).toBe(true)
  })

  it('never lets an absurd task number push every other row right', () => {
    // A corrupt row's number is not truncated — money and identity are the two things
    // this view will not shorten — so it overflows its OWN row instead of widening the
    // column for everybody.
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
    expect(lines.join('\n')).not.toMatch(/e[+-]\d/)
  })

  it('renders a `#?` row for a task the file never numbered', () => {
    const lines = renderTaskTable(
      worked({
        metricsText: 'RALPH_ISSUE_EVENT {"run_id":"' + RUN + '","verdict":"pass"}\n',
        titles: {},
      }),
    )
    expect(lines[1]).toContain('#?  ')
    expect(lines.join('\n')).not.toMatch(/NaN|undefined/)
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

  it('never throws over a row set larger than a spread can carry', () => {
    // Every row is still WALKED — the rows on show have to be picked out of the whole
    // set — and `Math.max(0, ...rows)` is bounded by the call stack, so a long-lived
    // run's own history would be enough to turn a read-only view into a RangeError. The
    // same count arrives through `buildProgress` from a metrics file of about 11 MB, a
    // size issues.jsonl reaches by appending.
    const tasks = Array.from({ length: 200000 }, (_, i) => ({
      number: i + 1,
      title: 'x',
      verdict: 'pass',
      costUsd: 1,
      durationMs: MIN,
      inFlight: false,
    }))
    expect(() => renderTaskTable({ tasks })).not.toThrow()
    // ...and what comes back is ten lines, not two hundred thousand. See the bounded-height
    // describe below for the argument.
    expect(renderTaskTable({ tasks })).toHaveLength(1 + 1 + TABLE_CAP)
  })

  it('survives a snapshot whose tasks are not rows at all', () => {
    // Both renderers take a snapshot from a caller, and a read-only view must not be
    // the thing that breaks on one.
    for (const tasks of [null, undefined, 'rows', 42, {}, [null], [undefined], [42], [[]], [{}]]) {
      expect(() => renderTaskTable({ tasks }), describeInput(tasks)).not.toThrow()
      expect(
        () => renderProgressLine({ completed: 1, total: 3, tasks }),
        describeInput(tasks),
      ).not.toThrow()
    }
  })

  it('is deterministic and mutates nothing it was handed', () => {
    const snapshot = worked()
    const before = JSON.stringify(snapshot)
    expect(renderTaskTable(snapshot)).toEqual(renderTaskTable(snapshot))
    expect(renderProgressLine(snapshot)).toBe(renderProgressLine(snapshot))
    expect(JSON.stringify(snapshot)).toBe(before)
  })
})

// A fourth property, and it belongs to the VIEW rather than to the table: the block a
// reader scrolls past must not grow with the run. lib/digest-history.js already made this
// promise for the model's prose (MAX_BODY_LINES = 8, closed by `… full narration in
// .ralph/digest.log`) so that the `attach`/`kill` pair underneath stays one glance away.
// A table of one line per closed task made the whole view O(tasks done) — the run
// lib/progress.js's own bar comment reasons about, one of 102, would have pushed the queue
// count, the pace, the ETA, the spend, the digest AND that pair off the screen. The
// end-to-end half of this is in lib/commands/status.qa.test.js.
describe('renderTaskTable — bounded height, whatever the run has done (#56)', () => {
  // Numbered from 100 so the in-flight #031 is never also a closed row, and untitled so
  // the task column is numbers alone — this describe is about how many lines come back,
  // not how wide they are.
  const longRun = (closed) => worked({ metricsText: runOf(closed, 100), titles: undefined })

  it('draws the last eight closed rows, the one in flight, and a line for the rest', () => {
    const lines = renderTaskTable(longRun(60))
    expect(lines).toHaveLength(1 + 1 + TABLE_CAP + 1)
    expect(lines[0]).toContain('task')
    expect(lines[1]).toBe('  … 52 earlier tasks in .ralph/metrics/issues.jsonl')
    // The eight are the most RECENT eight — #152…#159, not #100…#107 — because a live
    // view is read for what just happened, and the file keeps the rest.
    expect(lines[2]).toContain('#152')
    expect(lines[9]).toContain('#159')
    expect(lines.join('\n')).not.toContain('#151')
    // ...and the row still running is still last, which is the one ordering the snapshot
    // documents.
    expect(lines.at(-1)).toContain('#031')
    expect(lines.at(-1)).toContain('live')
  })

  it('puts the marker where the missing rows were, not at the foot of the table', () => {
    // The rows run oldest to newest, so what was elided came BEFORE the first one shown.
    // A marker at the bottom would read as newer rows withheld — and the last row has to
    // be the one in flight.
    const lines = renderTaskTable(longRun(12))
    expect(lines[1]).toBe('  … 4 earlier tasks in .ralph/metrics/issues.jsonl')
    expect(lines.at(-1)).not.toContain('earlier')
  })

  it('says nothing about earlier tasks while every row is on show', () => {
    for (const closed of [0, 1, TABLE_CAP - 1, TABLE_CAP]) {
      const lines = renderTaskTable(longRun(closed))
      expect(lines.join('\n'), `${closed} closed`).not.toContain('earlier')
      expect(lines, `${closed} closed`).toHaveLength(1 + closed + 1)
    }
  })

  it('counts one elided row in the singular', () => {
    // A cap that reports `1 earlier tasks` is the kind of seam that makes a reader
    // distrust the numbers beside it.
    expect(renderTaskTable(longRun(TABLE_CAP + 1))[1]).toBe(
      '  … 1 earlier task in .ralph/metrics/issues.jsonl',
    )
  })

  it('caps the TABLE and not the snapshot — the rows are still the numerator', () => {
    // Why the cap lives in the renderer and not in `buildTaskRows`. `snapshot.tasks` is
    // what the progress line counts and what #58's document publishes, so eliding rows
    // there would make `60/67 done` a statement about the screen instead of the run.
    const snapshot = longRun(60)
    expect(snapshot.tasks).toHaveLength(61)
    expect(snapshot.completed).toBe(60)
    expect(renderProgressLine(snapshot)).toContain('60/67 done')
  })

  it('measures its columns over the rows ON SHOW, not over the ones it elided', () => {
    // Otherwise the widest title in the run would leave a gutter the width of text
    // nobody can read.
    const row = (number, title) => ({
      number,
      title,
      verdict: 'pass',
      costUsd: 1,
      durationMs: MIN,
      inFlight: false,
    })
    const lines = renderTaskTable({
      tasks: [
        row(1, 'a title nobody will see'),
        ...Array.from({ length: TABLE_CAP }, (_, i) => row(200 + i, 'x')),
      ],
    })
    for (const line of lines.slice(2)) expect(line, line).toMatch(/^ {2}#\d{3} x {2}\S/)
  })

  it('trails no whitespace on any line it draws, marker included', () => {
    for (const line of renderTaskTable(longRun(60))) expect(line, line).not.toMatch(/\s$/)
  })

  it('is bounded for a snapshot that claims a hundred tasks in flight', () => {
    // `buildProgress` never makes a second such row, but both renderers are public and
    // take a snapshot they did not build — so the row the cap does not count must not be
    // the way back to an unbounded table. The most recent one is drawn and the rest are
    // counted with the elided.
    const tasks = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: null,
      verdict: null,
      costUsd: null,
      durationMs: MIN,
      inFlight: true,
    }))
    const lines = renderTaskTable({ tasks })
    expect(lines).toHaveLength(1 + 1 + 1)
    expect(lines[1]).toBe('  … 99 earlier tasks in .ralph/metrics/issues.jsonl')
    expect(lines.at(-1)).toContain('#100')
  })

  it('is bounded for every run length a repo can reach', () => {
    // The property stated as one: eleven lines is the most this block ever costs, and it
    // is reached and then held.
    for (const closed of [0, 1, 8, 9, 60, 102, 1000]) {
      expect(renderTaskTable(longRun(closed)).length, `${closed} closed`).toBeLessThanOrEqual(
        1 + 1 + TABLE_CAP + 1,
      )
    }
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
    expect(padTaskNumber(-5)).not.toMatch(/NaN|undefined/)
  })
})

describe('toJsonSnapshot — #56 changed the snapshot, and the document did not notice (#56)', () => {
  const doc = (overrides = {}) =>
    toJsonSnapshot(worked(overrides), { mode: 'running', record: inFlightRecord() })

  it('publishes no rows and no title, with any titles map', () => {
    for (const titles of [undefined, {}, TITLES]) {
      const text = JSON.stringify(doc({ titles }))
      expect(text, describeInput(titles)).not.toContain('title')
      expect(text, describeInput(titles)).not.toContain('sidebar')
      expect(text, describeInput(titles)).not.toContain('verdict')
    }
  })

  it('is byte-identical whether the shell looked titles up or not', () => {
    // The reason `ralph status --json` may skip the `gh` call for titles at all: a
    // consumer diffing two documents must not see prose appear in one of them.
    const withTitles = JSON.stringify(doc({ titles: TITLES }))
    expect(withTitles).toBe(JSON.stringify(doc({ titles: undefined })))
    expect(withTitles).toBe(JSON.stringify(doc({ titles: new Map([[29, 'sidebar']]) })))
  })

  it('keeps its top-level shape exactly as #58 and #63 published it', () => {
    expect(Object.keys(doc())).toEqual([
      'mode',
      'run_id',
      'progress',
      'tasks',
      'pace',
      'eta',
      'spend',
      'digest',
    ])
  })
})

// ---------------------------------------------------------------------------
// #127 — the in-flight task can now be a JIRA TICKET, and a ticket has a NAME. Both
// surfaces in this file render `#031` from the record's numeric `number`; a jira run's
// record also carries `task_key` (`FOO-123`), and the key is what a reader recognises on
// the board. `#123` would be a number Ralph derived, pointing at nothing anybody can look
// up — and, in a repo that also has GitHub issues, pointing at the wrong thing entirely.
//
// The issue asked for this in lib/commands/status.js. It is HERE because that command
// renders no task: it assembles the snapshot and hands it to these two pure renderers,
// which are the only code in Ralph that spells an in-flight task's name.
// ---------------------------------------------------------------------------
describe('the in-flight task is named by its Jira key when it has one (#127)', () => {
  const KEY = 'FOO-123'

  const jiraRecord = (current = {}) =>
    inFlightRecord({
      current: {
        number: 123,
        task_key: KEY,
        started_at: TASK_STARTED.toISOString(),
        iteration: 1,
        ...current,
      },
    })

  const jira = (overrides = {}) => worked({ record: jiraRecord(), ...overrides })

  it('carries the key on the in-flight row, and on no closed row', () => {
    const rows = jira().tasks
    expect(rows.at(-1)).toMatchObject({ key: KEY, number: 123, inFlight: true })
    for (const row of rows.slice(0, -1)) expect(row.key ?? null).toBe(null)
  })

  it('names the ticket on the progress line, in place of the padded number', () => {
    const line = renderProgressLine(jira())
    expect(line).toBe('  progress   2/9 done · FOO-123 in flight (40min)  [██──────] 22%')
    expect(line).not.toContain('#123')
  })

  it('renders the key in the table’s task cell, with the grid still aligned', () => {
    const lines = renderTaskTable(jira())
    expect(lines.at(-1).trim().startsWith(`${KEY} `) || lines.at(-1).trim() === KEY).toBe(true)
    expect(lines.at(-1)).toContain('🔄 live')
    expect(aligned(lines), lines.join('\n')).toBe(true)
  })

  it('does NOT title a keyed row from the numeric titles map', () => {
    // The map is built from `gh issue list --json number,title`, keyed by GITHUB issue
    // number, and a jira run is not gh-free — so issue #123's title would be printed
    // beside FOO-123 as if it were the ticket's summary. It is somebody else's prose.
    const titles = { 123: 'a different repository’s issue' }
    expect(jira({ titles }).tasks.at(-1).title).toBe(null)
    expect(renderTaskTable(jira({ titles })).join('\n')).not.toContain('different repository')
    expect(renderProgressLine(jira({ titles }))).toContain(`${KEY} in flight`)
  })

  it('scrubs the key exactly as it scrubs a title — it arrives from acli through a file', () => {
    const hostile = `FOO${ESC}[31m-1${BEL}${LF}  #999 pass`
    const lines = renderTaskTable(worked({ record: jiraRecord({ task_key: hostile }) }))
    // The key is still what names the row — scrubbed, not dropped.
    expect(lines.at(-1)).toContain('FOO')
    expect(lines.at(-1)).not.toContain('#123')
    expect(lines.join('\n')).not.toContain(ESC)
    expect(lines.join('\n')).not.toContain(BEL)
    // One row for the task, not two: a forged row cannot arrive through the key either.
    expect(lines.length).toBe(4)
    expect(renderProgressLine(worked({ record: jiraRecord({ task_key: hostile }) }))).not.toContain(ESC)
  })

  it('falls back to the padded number for every shape that is not a key', () => {
    for (const task_key of [undefined, null, '', '   ', 31, {}, [], true]) {
      const snapshot = worked({ record: jiraRecord({ number: 31, task_key }) })
      expect(renderProgressLine(snapshot), describeInput(task_key)).toContain('#031 in flight')
      expect(renderTaskTable(snapshot).at(-1), describeInput(task_key)).toContain('#031')
    }
  })

  it('leaves a github run’s two surfaces exactly as #56 rendered them', () => {
    // The zero-regression assertion, stated against the fixtures the rest of this file
    // measures: a record with no `task_key` is every run that predates #127.
    expect(renderTaskTable(worked())).toEqual(TABLE)
    expect(renderProgressLine(worked())).toBe(
      '  progress   2/9 done · #031 in flight (40min)  [██──────] 22%',
    )
  })
})
