import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildProgress,
  padTaskNumber,
  renderProgressLine,
  renderTaskTable,
  toJsonSnapshot,
} from './progress.js'

// QA augmentation for #56. The dev's progress.table.test.js locks the worked
// example, the four verdict markers, the `–` that is not `$0.00`, and the two
// widths it chose to measure. These tests attack the surface from the hostile side,
// where three promises meet:
//
//   1. THE GRID IS A PROMISE. The reader scans DOWN the verdict, cost and time
//      columns — that is the only reason a table beats three sentences — so every
//      row's marker has to start at the same terminal column as every other row's
//      AND as the ASCII header above them. The task column's width is DERIVED
//      arithmetic (`4 + 1 + widest title`), and derived arithmetic is where a grid
//      breaks: this file feeds it the two inputs that are not four columns wide —
//      a four-digit issue number and a title measured in something other than code
//      units — and checks the columns with an INDEPENDENT width function, so a
//      wrong entry in the module's own width table cannot agree with itself.
//   2. A TITLE IS THE ONLY ATTACKER-CONTROLLED TEXT IN THE VIEW. Somebody else
//      writes the issue, so every case below asks the same two questions of it: did
//      an escape sequence, a bidi override or a newline reach the terminal, and did
//      it forge a row or move somebody else's column. Spelled with `\u` escapes
//      throughout, deliberately — a suite about invisible characters must not
//      depend on an invisible character surviving a copy/paste.
//   3. THE LINE MUST NOT CONTRADICT ITSELF. `renderProgressLine` prints a fraction,
//      a bar and a percentage of one and the same pair of counts. Three renderings
//      of one fact is two chances to disagree, so the sweeps below compare all
//      three against each other and against the table's own row count over every
//      (completed, queue) pair a real run can reach — including the `--limit 100`
//      ceiling the queue count is capped at, which is where the bar's
//      reserved-first-cell rule and the percentage's floor rule pull opposite ways.
//
// Hermetic by construction, exactly like the sibling files: the module is pure, the
// wall-clock fixtures are LOCAL Date constructors and `now` is an injected integer.

const MIN = 60000
const RUN = 'ralph-ralph-b36ff7b1'
const OTHER_RUN = 'ralph-ralph-0badf00d'

const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime() // 40min into the live task

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

const tagged = (payload) => 'RALPH_ISSUE_EVENT ' + payload
const jsonl = (...events) => events.map((e) => tagged(JSON.stringify(e))).join('\n') + '\n'

// N recorded rows, numbered from `first`, all measured — so every fixture below
// has a pace, a spend and a full table to lose.
const runOf = (n, first = 29) =>
  n === 0
    ? ''
    : jsonl(
        ...Array.from({ length: n }, (_, i) =>
          event({ number: first + i, minutes: 60 + i, cost: 1 + i, ts: i + 1 }),
        ),
      )

const inFlightRecord = (overrides = {}) => ({
  run_id: RUN,
  queue_at_start: 8,
  current: { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 1 },
  ...overrides,
})

const build = (overrides = {}) =>
  buildProgress({
    metricsText: runOf(2),
    record: inFlightRecord(),
    queue: 6,
    now: NOW,
    ...overrides,
  })

// A label that survives an input `String()` refuses to coerce (a null-prototype
// object, a Symbol): every loop below reports which case failed.
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
// shared the implementation's width list would agree with it on exactly the glyphs
// it gets wrong. Covers every code point the fixtures in this file use — the four
// verdict markers, U+1F680, U+1F44D, CJK, Hangul, the fullwidth forms — and treats
// combining marks, variation selectors and format characters as zero, which is what
// a terminal does with them.
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
    const cp = ch.codePointAt(0)
    width += WIDE.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1
  }
  return width
}

const MARKER = /[✅❌❔\u{1F504}]/u

// Which terminal column each rendered line's verdict cell begins in — the property
// every table in this file is checked against: one answer for the header and every
// row under it. Anchored on the LAST marker in the line so a title that happens to
// contain a marker glyph (an issue titled with a tick, entirely legal) cannot make
// the measurement read the wrong cell.
const verdictColumn = (line) => {
  const matches = [...line.matchAll(new RegExp(MARKER, 'gu'))]
  const at = matches.length > 0 ? matches.at(-1).index : line.lastIndexOf('verdict')
  return columns(line.slice(0, at))
}
const verdictColumns = (lines) => lines.map(verdictColumn)
const aligned = (lines) => new Set(verdictColumns(lines)).size === 1

// Where the money starts, for the same reason: the verdict cells are claimed to be
// identical in width BY CONSTRUCTION, and this is the column that proves it.
const costColumn = (line) => columns(line.slice(0, line.lastIndexOf('$') === -1 ? 0 : line.lastIndexOf('$')))

// ===========================================================================
// THE GRID, against inputs that are not four columns wide.
// ===========================================================================

describe('renderTaskTable — the task column is derived from the TITLES, and a task number is not always four columns (#56 QA)', () => {
  // The width is `TASK_COLUMN_MIN + 1 + widest title`, and TASK_COLUMN_MIN is 4 —
  // the width of `#031`. It is the width of `#1234` that breaks it, and a
  // four-digit issue number is not an exotic input: it is what every repo older
  // than a year has, and `padTaskNumber` promises never to truncate one. ASCII
  // titles throughout these three tests, deliberately, so a column index IS a
  // terminal column and no width model is involved in the reading.
  it('keeps the ASCII header over the rows when the run’s issue numbers are four digits', () => {
    const lines = renderTaskTable(
      build({ metricsText: runOf(2, 1234), record: inFlightRecord({ current: null }), titles: {} }),
    )
    // `  task  ` reserves four columns for a cell that draws five, so the header's
    // `verdict` sits one column left of every marker below it.
    expect(new Set(verdictColumns(lines)).size, lines.join('\n')).toBe(1)
  })

  it('keeps every row’s verdict in one column when a four-digit number carries the widest title', () => {
    // The widest title sets the width, and the row carrying it is the row whose
    // number pushes its cell one column past that width — so the one row the
    // column was measured FOR is the one row that does not fit in it.
    const lines = renderTaskTable(
      build({
        metricsText: runOf(2, 1234),
        record: inFlightRecord({ current: null }),
        titles: { 1234: 'sidebar', 1235: 'a longer title' },
      }),
    )
    expect(aligned(lines.slice(1)), lines.join('\n')).toBe(true)
  })

  it('keeps a run that spans three- and four-digit issue numbers rectangular', () => {
    // The realistic shape of the hazard: a repo whose queue crossed #1000 mid-run,
    // so the same table carries `#029` and `#1235`. Every title is deliberately the
    // SAME width here — with titles of differing widths the extra digit can be
    // swallowed by another row's padding, and a grid that is rectangular only when
    // the titles happen to differ by one column is not rectangular.
    const lines = renderTaskTable(
      build({
        metricsText: jsonl(
          event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
          event({ number: 1235, minutes: 71, cost: 28.75, ts: 2 }),
        ),
        titles: { 29: 'sidebar', 1235: 'persist', 31: 'rowcomp' },
      }),
    )
    expect(aligned(lines), lines.join('\n')).toBe(true)
  })
})

describe('renderTaskTable — the grid survives a title measured in something other than code units (#56 QA)', () => {
  // Every title here is one a GitHub issue can carry, and each one breaks a
  // different naive width model: CJK is one code unit and two columns, an emoji is
  // two units and two columns, a combining mark is a unit and no columns, a
  // fullwidth digit looks like ASCII and is not. The sibling row is deliberately
  // short ASCII, so any drift shows up as two different verdict columns.
  const titleCases = {
    'a CJK title (one unit, two columns per character)': '日本語のタイトル',
    'an emoji at the front of the title': '\u{1F680} ship it',
    'a Hangul title': '한국어 제목',
    'a fullwidth-digit title that looks like ASCII': '１２３ wide digits',
    'decomposed combining marks (e + U+0301, as macOS writes it)': 'école café',
    'right-to-left text': 'שלום עולם',
    'a bidi override that would reorder the rest of the line': 'safe‮gnorw‬',
    'a right-to-left isolate': 'safe⁧gnorw⁩',
    'a zero-width space inside a word': 'a​b split',
    'a zero-width joiner between two emoji': '\u{1F469}‍\u{1F4BB} dev',
    'a skin-tone modifier': '\u{1F44D}\u{1F3FD} ok',
    'a variation selector that asks for emoji presentation': '❤️ love',
    'a soft hyphen inside a word': 'soft­hyphen',
    'a non-breaking space between words': 'nbsp here',
    'a lone surrogate from a truncated write': 'bad\uD800end',
    'a private-use code point of unknown width': 'puahere',
    'a tab that would misalign the row': 'tab\there',
    'a bell that would make the row audible': 'bellhere',
    'a raw CSI sequence': '[31mred[0m thing',
    'a raw OSC window-title sequence': ']0;pwnedtitle',
    'an unterminated CSI sequence': '[38;5;213',
    'a title exactly at the 24-column cap': 'x'.repeat(24),
    'a title one column over the cap': 'x'.repeat(25),
    'twelve CJK characters — exactly 24 columns': '一'.repeat(12),
    'thirteen CJK characters — one glyph over the cap': '一'.repeat(13),
    'a title that is nothing but emoji': '\u{1F680}'.repeat(20),
    'a title that is only whitespace': '   ',
    'a title that is a number': 42,
    'a title that is null': null,
  }

  for (const [label, title] of Object.entries(titleCases)) {
    it(`lines the columns up with ${label}`, () => {
      const lines = renderTaskTable(build({ titles: { 29: title, 30: 'short' } }))
      expect(aligned(lines), lines.join('\n')).toBe(true)
      // ...and the money too, which is the claim the emoji markers rest on.
      expect(new Set(lines.slice(1, 3).map(costColumn)).size, lines.join('\n')).toBe(1)
    })
  }

  it('emits no control character, no escape and no bidi override to the terminal', () => {
    // The whole point of sanitizing in the pure module: whatever the title was,
    // what reaches stdout is printable text on one line. Checked per LINE, since
    // the newline between them is the one control character that belongs there.
    for (const [label, title] of Object.entries(titleCases)) {
      for (const line of renderTaskTable(build({ titles: { 29: title, 30: 'short' } }))) {
        expect(line, label).not.toMatch(/[\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u)
        // Cf is the nastier half — U+202E reorders the rest of the LINE, so an
        // issue title could rewrite the verdict beside it.
        expect(line, label).not.toMatch(/[​-‏‪-‮⁦-⁩­]/u)
        expect(line, label).not.toContain('')
      }
    }
  })

  it('cannot be made to forge a row, however the title is spelled', () => {
    // A newline in a title would split one row into two, and the second half is
    // attacker-written text in the shape of a verdict. The row COUNT is therefore
    // the assertion: header plus exactly three tasks, whatever the title says.
    const forgeries = [
      'a\n  #999 forged   ✅ pass     $0.01     1min',
      'a\r\n  #999 forged',
      'a   #999 forged',
      'a  #999 forged',
      'a  #999 forged',
    ]
    for (const title of forgeries) {
      const lines = renderTaskTable(build({ titles: { 29: title, 30: 'short' } }))
      expect(lines, JSON.stringify(title)).toHaveLength(4)
      expect(aligned(lines), JSON.stringify(title)).toBe(true)
    }
  })

  it('renders a run of 100 differently-shaped titles without one of them moving another’s column', () => {
    // The property under load rather than per-case: one table, a hundred rows, a
    // hundred title shapes, one verdict column.
    const alphabet = ['a', '一', '\u{1F680}', 'é', '１', 'א', 'x​']
    const titles = {}
    for (let i = 0; i < 100; i++) {
      titles[100 + i] = alphabet[i % alphabet.length].repeat((i % 30) + 1)
    }
    const lines = renderTaskTable(
      build({ metricsText: runOf(100, 100), record: inFlightRecord({ current: null }), titles }),
    )
    expect(lines).toHaveLength(101)
    expect(aligned(lines), lines.slice(0, 6).join('\n')).toBe(true)
  })
})

// ===========================================================================
// THE LINE, against itself.
// ===========================================================================

describe('renderProgressLine — the fraction, the bar and the percentage are one fact rendered three times (#56 QA)', () => {
  // Every (completed, queue) pair a real run can reach. The queue count is capped
  // at `--limit 100` by lib/commands/status.js, so 0..100 is the whole range of
  // denominators, and 0..8 completed covers a run's first day.
  const reachable = []
  for (const done of [0, 1, 2, 3, 8]) {
    for (const queue of [0, 1, 2, 5, 8, 60, 100]) {
      for (const current of [true, false]) {
        reachable.push({ done, queue, current })
      }
    }
  }

  const snapshotOf = ({ done, queue, current }) =>
    build({
      metricsText: runOf(done),
      record: inFlightRecord(current ? {} : { current: null }),
      queue,
    })
  const lineOf = (knobs) => renderProgressLine(snapshotOf(knobs))

  it('never prints a percentage that disagrees with the fraction beside it', () => {
    for (const knobs of reachable) {
      const line = lineOf(knobs)
      const fraction = line.match(/(\d+)\/(\d+) done/)
      const percent = line.match(/(\d+)%/)
      if (!fraction || !percent) continue
      const [, done, total] = fraction.map(Number)
      expect(Number(percent[1]), `${JSON.stringify(knobs)} → ${line}`).toBe(
        Math.floor((done / total) * 100),
      )
    }
  })

  it('never prints 0% while the bar says a task is finished', () => {
    // The two halves of the line are shaped by opposite rules — the bar RESERVES
    // its first cell so a measured task is never erased, the percentage FLOORS —
    // and at the queue count's own `--limit 100` ceiling they meet and contradict
    // each other: one finished task of 102 draws a filled cell beside `0%`.
    // Erasing a measurement is the mistake the reserved cell exists to prevent;
    // doing it in the number the reader actually reads is the same mistake.
    for (const knobs of reachable) {
      const line = lineOf(knobs)
      const percent = line.match(/(\d+)%/)
      if (!percent) continue
      const filled = (line.match(/█/g) ?? []).length
      if (filled > 0) {
        expect(Number(percent[1]), `${JSON.stringify(knobs)} → ${line}`).toBeGreaterThan(0)
      }
    }
  })

  it('never claims 100% or a full bar while a task is still in flight', () => {
    for (const knobs of reachable.filter((k) => k.current)) {
      const line = lineOf(knobs)
      expect(line, JSON.stringify(knobs)).not.toContain('100%')
      expect(line, JSON.stringify(knobs)).not.toContain('█'.repeat(8))
    }
  })

  it('counts exactly the rows the table beside it draws, in every reachable case', () => {
    for (const knobs of reachable) {
      const snapshot = snapshotOf(knobs)
      const line = renderProgressLine(snapshot)
      const table = renderTaskTable(snapshot)
      const closedRows = snapshot.taskRows.filter((taskRow) => !taskRow.inFlight).length
      expect(line, JSON.stringify(knobs)).toContain(`${closedRows}/`)
      // Header plus every row, or nothing at all — never a header over no rows.
      expect(table.length, JSON.stringify(knobs)).toBe(
        snapshot.taskRows.length === 0 ? 0 : snapshot.taskRows.length + 1,
      )
      // And the two surfaces agree about whether anything is in flight.
      const liveRows = snapshot.taskRows.filter((taskRow) => taskRow.inFlight).length
      expect(line.includes('nothing in flight'), JSON.stringify(knobs)).toBe(liveRows === 0)
    }
  })

  it('keeps the denominator strictly above the numerator while a task is in flight', () => {
    // The invariant that makes `100%` beside a live row unreachable through
    // buildProgress in the first place: the live denominator always owes the task
    // in flight a place of its own.
    for (const knobs of reachable.filter((k) => k.current)) {
      const snapshot = snapshotOf(knobs)
      expect(snapshot.total, JSON.stringify(knobs)).toBeGreaterThan(snapshot.completed)
    }
  })

  it('recomputes the denominator from the queue it was handed on every call', () => {
    // The AC's live-denominator rule, stated as a difference: the same history and
    // the same record, three queue depths, three denominators — nothing cached.
    const history = runOf(2)
    const denominators = [0, 6, 100].map(
      (queue) => renderProgressLine(build({ metricsText: history, queue })).match(/\d+\/(\d+)/)[1],
    )
    expect(denominators).toEqual(['3', '9', '103'])
  })
})

// ===========================================================================
// THE UNTRUSTED FILE: every numeric leaf is null or finite, and no cell lies.
// ===========================================================================

describe('renderTaskTable — a corrupt issues.jsonl reaches the terminal as `–`, never as a number nobody can read (#56 QA)', () => {
  // issues.jsonl is append-only text written by a process that can be killed
  // mid-write, so every one of these is a line the file can actually hold. The
  // assertion is the same for all of them: the row renders, the numeric snapshot
  // leaves are null-or-finite, and nothing in the output is `NaN`, `Infinity`,
  // `undefined`, exponent notation or a `$0.00` standing in for a missing cost.
  const corruptions = {
    'a duration of 1e300, where minutes still fit a double': { duration_ms: 1e300 },
    'a duration at 1e21, where String flips to exponent notation': { duration_ms: 1e21 },
    'a duration that overflowed the writer to Infinity': { duration_ms: Infinity },
    'a negative duration': { duration_ms: -5 },
    'a negative zero duration': { duration_ms: -0 },
    'a duration that is a string': { duration_ms: '97000' },
    'a duration that is true': { duration_ms: true },
    'a duration that is an array': { duration_ms: [97000] },
    'a duration that is an object': { duration_ms: { ms: 97000 } },
    'a cost of 1e21, the toFixed cliff': { total_cost_usd: 1e21 },
    'a cost of 1e300': { total_cost_usd: 1e300 },
    'a cost that is a string': { total_cost_usd: '34.10' },
    'a negative cost': { total_cost_usd: -12.5 },
    'a negative zero cost': { total_cost_usd: -0 },
    'a cost that is an object': { total_cost_usd: {} },
    'a task number of 1e21': { issue_number: 1e21 },
    'a fractional task number': { issue_number: 31.5 },
    'a task number that is a string': { issue_number: '31' },
    'no numeric fields at all': { issue_number: undefined, duration_ms: undefined },
  }

  for (const [label, overrides] of Object.entries(corruptions)) {
    it(`renders a readable row for ${label}`, () => {
      const snapshot = build({
        metricsText: jsonl(event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }), {
          issue_number: 30,
          run_id: RUN,
          ts: 2,
          verdict: 'pass',
          ...overrides,
        }),
        titles: {},
      })
      const text = [renderProgressLine(snapshot), ...renderTaskTable(snapshot)].join('\n')
      expect(text, label).not.toMatch(/NaN|Infinity|undefined|null/)
      expect(text, label).not.toMatch(/e[+-]\d/)
      // `$0.00` may never stand in for a cost nobody recorded.
      expect(text, label).not.toContain('$0.00')
      for (const taskRow of snapshot.taskRows) {
        for (const field of ['number', 'costUsd', 'durationMs']) {
          const value = taskRow[field]
          expect(value == null || Number.isFinite(value), `${label} → ${field} = ${value}`).toBe(true)
        }
      }
      // The row the corruption is on is still THERE — degraded, not dropped.
      expect(renderTaskTable(snapshot).length, label).toBe(4)
    })
  }

  it('reads a number too large for JSON to hold as no number at all', () => {
    // `1e400` parses to Infinity, which is the shape an overflowed writer leaves.
    const snapshot = build({
      metricsText: tagged(
        `{"issue_number":30,"run_id":"${RUN}","duration_ms":1e400,"total_cost_usd":1e400,"verdict":"pass"}`,
      ),
      titles: {},
    })
    expect(snapshot.taskRows[0]).toMatchObject({ costUsd: null, durationMs: null })
    expect(renderTaskTable(snapshot)[1]).toContain('–')
  })

  it('never throws over a row set larger than a spread can carry', () => {
    // `renderTaskTable` measures its one variable column with
    // `Math.max(0, ...rows.map(...))`, and a spread is bounded by the call stack —
    // so a long-lived run's own history is enough to turn a read-only view into a
    // RangeError. The same count arrives through `buildProgress` from a metrics
    // file of about 11 MB, which is a size issues.jsonl reaches by appending.
    const rows = Array.from({ length: 200000 }, (_, i) => ({
      number: i + 1,
      title: 'x',
      verdict: 'pass',
      costUsd: 1,
      durationMs: MIN,
      inFlight: false,
    }))
    expect(() => renderTaskTable({ taskRows: rows })).not.toThrow()
  })

  it('holds every numeric snapshot leaf to null-or-finite across a matrix of wrecked files', () => {
    const wrecked = {
      'a JSON array where an object belongs': tagged('[1,2,3]'),
      'a JSON scalar': tagged('42'),
      'a JSON null': tagged('null'),
      'a JSON string': tagged('"pass"'),
      'a line truncated mid-write': tagged(`{"issue_number":30,"run_id":"${RUN}"`),
      'CRLF line endings': jsonl(event({ number: 29, minutes: 97, ts: 1 })).replace(/\n/g, '\r\n'),
      'a __proto__ key': tagged(`{"__proto__":{"pwned":1},"issue_number":29,"run_id":"${RUN}"}`),
      'a 2 MiB line of noise before the rows': 'x'.repeat(2 * 1024 * 1024) + '\n' + runOf(2),
      'the tag with nothing after it': 'RALPH_ISSUE_EVENT ',
      'the tag twice on one line': tagged(tagged(JSON.stringify(event({ number: 29, ts: 1 })))),
      'no text at all': '',
      'text that is not a string': 42,
    }
    for (const [label, metricsText] of Object.entries(wrecked)) {
      let snapshot
      expect(() => {
        snapshot = build({ metricsText })
      }, label).not.toThrow()
      for (const field of ['completed', 'inFlight', 'remaining', 'total']) {
        const value = snapshot[field]
        expect(value == null || Number.isFinite(value), `${label} → ${field} = ${value}`).toBe(true)
      }
      const text = [renderProgressLine(snapshot), ...renderTaskTable(snapshot)].join('\n')
      expect(text, label).not.toMatch(/NaN|Infinity|undefined/)
      expect({}.pwned, label).toBeUndefined()
    }
  })

  it('renders a task number the file recorded as negative without inventing a digit', () => {
    // Pre-existing #55 behaviour, pinned here because the table is the surface that
    // shows the most of it: a negative number is absurd, and reads as absurd.
    const snapshot = build({
      metricsText: jsonl(event({ number: -5, minutes: 97, cost: 1, ts: 1 })),
      record: inFlightRecord({ current: null }),
      titles: {},
    })
    const text = renderTaskTable(snapshot).join('\n')
    expect(text).not.toMatch(/NaN|undefined/)
    expect(padTaskNumber(-5)).not.toMatch(/NaN|undefined/)
  })
})

describe('renderTaskTable — cost is `–` when nobody measured it, and legible when somebody did (#56 QA)', () => {
  const costOf = (total_cost_usd) => {
    const snapshot = build({
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
    })
    return renderTaskTable(snapshot)[1].trim().split(/\s{2,}/)[2]
  }

  it('renders every unrecorded cost as `–`, and never as a zero that reads as free', () => {
    for (const missing of [undefined, null, 0, -0, -12.5, 'free', {}, [], true, NaN, Infinity]) {
      expect(costOf(missing), describeInput(missing)).toBe('–')
    }
  })

  it('renders a recorded cost under a cent as `<$0.01`, distinguishable from unrecorded', () => {
    // The one reading that must not collapse into `–`: a task that really did cost
    // something, just less than the grid can show.
    expect(costOf(0.0000001)).toBe('<$0.01')
    expect(costOf(0.004)).toBe('<$0.01')
    expect(costOf(0.01)).toBe('$0.01')
  })

  it('renders a recorded duration of zero as `–` too, so a row never claims an instant task', () => {
    const snapshot = build({
      metricsText: jsonl(event({ number: 29, minutes: 0, cost: 34.1, ts: 1 })),
      record: inFlightRecord({ current: null }),
      titles: {},
    })
    expect(renderTaskTable(snapshot)[1]).toBe('  #029  ✅ pass     $34.10    –')
  })
})

// ===========================================================================
// VERDICTS: a closed set, all four distinguishable, none wearing another's marker.
// ===========================================================================

describe('renderTaskTable — every verdict is distinguishable and none borrows another’s marker (#56 QA)', () => {
  const rowFor = (verdict) => {
    const snapshot = build({
      metricsText: jsonl({ issue_number: 29, run_id: RUN, ts: 1, duration_ms: 97 * MIN, verdict }),
      record: inFlightRecord({ current: null }),
      titles: {},
    })
    return renderTaskTable(snapshot)[1]
  }
  const cellFor = (verdict) => rowFor(verdict).trim().split(/\s{2,}/)[1]

  it('marks the three verdicts the writer emits, and the task in flight, with four distinct cells', () => {
    const cells = ['pass', 'fail', 'unknown'].map(cellFor)
    const live = renderTaskTable(build({ metricsText: '', titles: {} }))[1].trim().split(/\s{2,}/)[1]
    const all = [...cells, live]
    expect(new Set(all).size).toBe(4)
    // No marker may appear in two different cells: the glyph alone has to answer
    // the question, because that is what a reader scans for.
    const markers = all.map((cell) => cell.match(MARKER)[0])
    expect(new Set(markers).size).toBe(4)
    // ...and each cell's word matches its own marker rather than a neighbour's.
    expect(all.map((cell) => cell.replace(MARKER, '').trim())).toEqual([
      'pass',
      'fail',
      'unknown',
      'live',
    ])
  })

  it('reads a verdict the writer never emits as unknown, whatever its shape', () => {
    for (const verdict of [
      'partial',
      'PASS',
      'passed',
      ' pass',
      'pass ',
      '',
      null,
      0,
      false,
      [],
      {},
      '__proto__',
      'constructor',
      'toString',
      'x'.repeat(4000),
    ]) {
      expect(cellFor(verdict), describeInput(verdict)).toBe('❔ unknown')
    }
  })

  it('renders a verdict that is not a string as unknown rather than throwing', () => {
    // Not reachable through `buildProgress`, which coerces a non-string verdict to
    // null — but `renderTaskTable` is exported, its three other cells are each
    // written to survive a value of the wrong type, and the module says so in
    // prose. A row whose verdict STRINGIFIES to one of the three known words takes
    // the marker lookup and then asks the value itself for `padEnd`.
    for (const verdict of [['pass'], ['fail'], ['unknown'], { toString: () => 'pass' }]) {
      expect(
        () => renderTaskTable({ taskRows: [{ number: 29, verdict, costUsd: 1, durationMs: MIN }] }),
        describeInput(verdict),
      ).not.toThrow()
    }
  })

  it('keeps the money in one column for every verdict, so the cells really are the same width', () => {
    // The emoji decision's whole claim: `marker + ' ' + word.padEnd(7)` is
    // identical in width for all four verdicts BY CONSTRUCTION. Measured where it
    // matters — where the next column starts.
    const rows = ['pass', 'fail', 'unknown', 'partial', null].map(rowFor)
    expect(new Set(rows.map(costColumn)).size, rows.join('\n')).toBe(1)
  })
})

// ===========================================================================
// SCOPING: only this run's rows, and an unnamed run claims nothing.
// ===========================================================================

describe('buildProgress — the table is scoped to the run, and an unnamed run claims nothing (#56 QA)', () => {
  const rowsFor = ({ metricsText, record }) =>
    buildProgress({ metricsText, record, queue: 6, now: NOW }).taskRows.map((r) => r.number)

  it('matches a numeric run_id against the record’s string one, and the reverse', () => {
    // The module compares `String(event.run_id) === String(runId)` on purpose: the
    // writer and the record are two processes, and one of them writing `1` where
    // the other wrote `"1"` must not silently empty the table.
    expect(
      rowsFor({
        metricsText: jsonl(event({ number: 29, run: 1, ts: 1 })),
        record: { run_id: '1', current: null },
      }),
    ).toEqual([29])
    expect(
      rowsFor({
        metricsText: jsonl(event({ number: 29, run: '1', ts: 1 })),
        record: { run_id: 1, current: null },
      }),
    ).toEqual([29])
  })

  it('claims no row for an event with no run_id, a null one, or one the record does not name', () => {
    for (const run of [null, undefined, '', 0, false, OTHER_RUN, 'RALPH-RALPH-B36FF7B1']) {
      expect(
        rowsFor({
          metricsText: jsonl({ issue_number: 29, run_id: run, ts: 1, verdict: 'pass' }),
          record: inFlightRecord({ current: null }),
        }),
        describeInput(run),
      ).toEqual([])
    }
  })

  it('claims nothing at all for a record that cannot name its own run', () => {
    // An unnamed run matches NO history — and still rows the task it says it is
    // working on, which is the record's own fact rather than the file's.
    for (const runId of [null, undefined, '', 0, false]) {
      expect(
        rowsFor({ metricsText: runOf(3), record: inFlightRecord({ run_id: runId }) }),
        describeInput(runId),
      ).toEqual([31])
      expect(
        rowsFor({ metricsText: runOf(3), record: { run_id: runId, current: null } }),
        describeInput(runId),
      ).toEqual([])
    }
  })

  it('interleaves nothing from another run, however the file interleaves them', () => {
    const metricsText = jsonl(
      event({ number: 90, run: OTHER_RUN, minutes: 5, cost: 900, ts: 1 }),
      event({ number: 29, minutes: 97, cost: 34.1, ts: 2 }),
      event({ number: 91, run: OTHER_RUN, minutes: 5, cost: 900, ts: 3 }),
      event({ number: 30, minutes: 71, cost: 28.75, ts: 4 }),
      event({ number: 92, run: OTHER_RUN, minutes: 5, cost: 900, ts: 5 }),
    )
    const snapshot = buildProgress({ metricsText, record: inFlightRecord(), queue: 6, now: NOW })
    expect(snapshot.taskRows.map((r) => r.number)).toEqual([29, 30, 31])
    const text = renderTaskTable(snapshot).join('\n')
    expect(text).not.toContain('#090')
    expect(text).not.toContain('$900')
    // ...and the fraction counts the same two rows, not the file's five.
    expect(renderProgressLine(snapshot)).toContain('2/9 done')
  })
})

// ===========================================================================
// TITLES ARE AN INPUT: whatever the shell hands over, the table renders numbers.
// ===========================================================================

describe('buildProgress — the titles map is a courtesy, never a requirement (#56 QA)', () => {
  const titleOf = (titles) => build({ titles }).taskRows[0].title

  it('resolves a plain object keyed by strings, which is what JSON.parse hands over', () => {
    // lib/commands/status.js builds `titles[issue.number]`, and a map round-tripped
    // through JSON has string keys either way.
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
      let rows
      expect(() => {
        rows = build({ titles }).taskRows
      }, describeInput(titles)).not.toThrow()
      expect(
        rows.map((r) => r.title),
        describeInput(titles),
      ).toEqual([null, null, null])
    }
  })

  it('never lets a title become the empty string, which would silently widen the column', () => {
    for (const title of ['', ' ', '   ', '\n\n', '\t', ' ', '​', '‮‬']) {
      expect(titleOf({ 29: title }), JSON.stringify(title)).toBe(null)
    }
  })

  it('truncates at 24 COLUMNS rather than 24 characters, and marks the cut', () => {
    // A wide-character title has to be cut by what the terminal draws, or a CJK
    // title would take 48 columns of a 24-column cell.
    const cjk = titleOf({ 29: '一'.repeat(40) })
    expect(columns(cjk)).toBeLessThanOrEqual(24)
    expect(cjk.endsWith('…')).toBe(true)
    const ascii = titleOf({ 29: 'x'.repeat(400) })
    expect(columns(ascii)).toBeLessThanOrEqual(24)
    expect(ascii.endsWith('…')).toBe(true)
    // A title at the cap keeps every column and gains no ellipsis.
    expect(titleOf({ 29: 'x'.repeat(24) })).toBe('x'.repeat(24))
    expect(columns(titleOf({ 29: '一'.repeat(12) }))).toBe(24)
  })

  it('stays inside the column when the first visible glyph is a thousand characters away', () => {
    // The raw cap under attack: a title that spends 5000 combining marks before its
    // first letter. Mn is deliberately KEPT by the sanitizer (stripping it would
    // break `café`), so the guard that has to hold is the column cap.
    const title = '́'.repeat(5000) + 'real title'
    expect(columns(String(titleOf({ 29: title })))).toBeLessThanOrEqual(24)
    const lines = renderTaskTable(build({ titles: { 29: title, 30: 'short' } }))
    expect(aligned(lines), lines.join('\n')).toBe(true)
  })

  it('mutates neither the titles map nor the record it was handed', () => {
    const titles = { 29: 'sidebar', 30: 'persist' }
    const record = inFlightRecord()
    const before = [JSON.stringify(titles), JSON.stringify(record)]
    buildProgress({ metricsText: runOf(2), record, queue: 6, now: NOW, titles })
    expect([JSON.stringify(titles), JSON.stringify(record)]).toEqual(before)
  })
})

// ===========================================================================
// THE EMPTY RUN, and the JSON document that must not have noticed any of this.
// ===========================================================================

describe('renderTaskTable / renderProgressLine — a run with nothing to show (#56 QA)', () => {
  it('renders the header and the in-flight row alone, with no cost or verdict invented', () => {
    const snapshot = build({ metricsText: '', titles: { 31: 'row comp' } })
    const lines = renderTaskTable(snapshot)
    expect(lines).toHaveLength(2)
    expect(aligned(lines)).toBe(true)
    expect(lines[1]).not.toContain('$0.00')
    expect(lines[1]).toContain('–')
    expect(renderProgressLine(snapshot)).toContain('0/7 done')
  })

  it('renders no table at all — not even a header — for a run between tasks', () => {
    for (const current of [null, undefined, 0, '', false]) {
      const snapshot = build({ metricsText: '', record: inFlightRecord({ current }) })
      expect(renderTaskTable(snapshot), describeInput(current)).toEqual([])
      expect(renderProgressLine(snapshot), describeInput(current)).toContain('nothing in flight')
    }
  })

  it('renders a table for a run between tasks that HAS a history', () => {
    // The other half of the empty case: nothing in flight, but two closed rows —
    // the table stands, and the progress line names no task.
    const snapshot = build({ metricsText: runOf(2), record: inFlightRecord({ current: null }) })
    const lines = renderTaskTable(snapshot)
    expect(lines).toHaveLength(3)
    expect(lines.join('\n')).not.toContain('live')
    expect(renderProgressLine(snapshot)).toContain('nothing in flight')
  })
})

describe('toJsonSnapshot — #56 changed the snapshot, and the document must not have noticed (#56 QA)', () => {
  const doc = (overrides = {}) =>
    toJsonSnapshot(build(overrides), { mode: 'running', record: inFlightRecord() })

  it('publishes no taskRows and no title, in any mode, with any titles map', () => {
    for (const titles of [undefined, {}, { 29: 'sidebar', 30: 'persist', 31: 'row comp' }]) {
      const text = JSON.stringify(doc({ titles }))
      expect(text, describeInput(titles)).not.toContain('taskRows')
      expect(text, describeInput(titles)).not.toContain('title')
      expect(text, describeInput(titles)).not.toContain('sidebar')
    }
  })

  it('is byte-identical whether the shell looked titles up or not', () => {
    // The reason `ralph status --json` may skip the `gh` call for titles at all: a
    // consumer diffing two documents must not see prose appear in one of them.
    const withTitles = JSON.stringify(doc({ titles: { 29: 'sidebar', 30: 'persist', 31: 'x' } }))
    expect(withTitles).toBe(JSON.stringify(doc({ titles: undefined })))
    expect(withTitles).toBe(JSON.stringify(doc({ titles: new Map([[29, 'sidebar']]) })))
  })

  it('keeps its top-level shape exactly as #58 published it', () => {
    expect(Object.keys(doc())).toEqual(['mode', 'run_id', 'progress', 'tasks', 'pace', 'eta', 'spend'])
  })
})

// ===========================================================================
// PURITY, for the new surfaces specifically.
// ===========================================================================

describe('progress.js — the table surfaces are as pure as the rest of it (#56 QA)', () => {
  const SOURCE = readFileSync(new URL('./progress.js', import.meta.url), 'utf8')
  const CODE = SOURCE.split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line.replace(/\s\/\/.*$/, '')))
    .join('\n')

  it('added no import, no clock, no filesystem and no locale to the module', () => {
    // The #57 sweep in progress.qa.test.js scans this same source, so the new code
    // is already inside it; this restates the ones #56's code could plausibly have
    // reached for — a width table is exactly where `Intl` or `toLocaleString`
    // creeps in, and either would make the grid depend on the reader's locale.
    for (const forbidden of [
      /^\s*import\s/m,
      /require\(/,
      /Date\.now/,
      /\bnew Date\(\s*\)/,
      /\bfs\./,
      /\bfetch\(/,
      /process\./,
      /\bIntl\b/,
      /toLocaleString|toLocaleDateString|localeCompare/,
      /Math\.random/,
    ]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('renders the table and the line with Date.now stubbed to throw', () => {
    const real = Date.now
    try {
      Date.now = () => {
        throw new Error('progress.js reached for the ambient clock')
      }
      const snapshot = build({ titles: { 29: 'sidebar', 30: 'persist', 31: 'row comp' } })
      expect(renderProgressLine(snapshot)).toContain('2/9 done')
      expect(renderTaskTable(snapshot)).toHaveLength(4)
      expect(padTaskNumber(31)).toBe('031')
    } finally {
      Date.now = real
    }
  })

  it('is deterministic across repeated renders of one snapshot', () => {
    const snapshot = build({ titles: { 29: 'sidebar', 30: 'persist', 31: 'row comp' } })
    const before = JSON.stringify(snapshot)
    for (let i = 0; i < 3; i++) {
      expect(renderTaskTable(snapshot)).toEqual(renderTaskTable(snapshot))
      expect(renderProgressLine(snapshot)).toBe(renderProgressLine(snapshot))
    }
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('survives a snapshot whose taskRows are not rows at all', () => {
    // Both renderers take a snapshot from a caller, and a read-only view must not
    // be the thing that breaks on one.
    for (const taskRows of [null, undefined, 'rows', 42, {}, [null], [undefined], [42], [[]], [{}]]) {
      expect(() => renderTaskTable({ taskRows }), describeInput(taskRows)).not.toThrow()
      expect(
        () => renderProgressLine({ completed: 1, total: 3, taskRows }),
        describeInput(taskRows),
      ).not.toThrow()
    }
  })

  it('accepts a frozen record and a frozen titles map — a status view owns none of what it reads', () => {
    const record = Object.freeze({
      ...inFlightRecord(),
      current: Object.freeze({ number: 31, started_at: TASK_STARTED.toISOString() }),
    })
    const titles = Object.freeze({ 29: 'sidebar', 31: 'row comp' })
    expect(() =>
      renderTaskTable(buildProgress({ metricsText: runOf(2), record, queue: 6, now: NOW, titles })),
    ).not.toThrow()
  })
})
