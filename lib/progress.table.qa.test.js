import { describe, expect, it } from 'vitest'
import {
  buildProgress,
  renderProgressLine,
  renderTaskTable,
  taskKeysFor,
  toJsonSnapshot,
} from './progress.js'
import { codeWithoutComments } from '../test/helpers/source-code.js'

// #56's ADVERSARIAL SWEEP over the pure half. lib/progress.table.test.js owns the
// feature's contract; this file only asks the questions that suite does not, and every
// one of them is a question about a promise the module makes about itself:
//
//   1. THE TITLES SEAM IS A COURTESY. `titles` arrives from a `gh` call the shell made
//      as a nicety, so the module documents that any shape degrades to no title. The
//      sibling suite proves that for wrong-SHAPED maps; this one proves it for maps
//      that MISBEHAVE — a property read that throws is not a shape, and the module's
//      own Map path is try/catch-guarded while its object path is not.
//   2. PURITY IS THE ACCEPTANCE CRITERION, NOT AN IMPLEMENTATION DETAIL. Every input is
//      passed in, so the module must reach no clock and no module at all. That is
//      checked twice, because either check alone is weak: BEHAVIOURALLY, by making the
//      ambient clock throw for the length of the three calls, and STRUCTURALLY, over
//      the source with its prose taken out (the header comment says `Date.now`, which
//      is exactly the false positive test/helpers/source-code.js exists for).
//   3. THE BAR AND THE PERCENTAGE ARE ONE FACT. Checked as INVARIANTS rather than
//      against a recomputed formula: a test that recomputes `Math.round(ratio * 8)`
//      agrees with the implementation by construction, including where the
//      implementation is wrong.
//   4. AN ESCAPE SEQUENCE IS NOT A CSI SEQUENCE. #107 and #108 were both about forged
//      terminal lines, so the sanitizer is treated as a live boundary here: the forms
//      below are the ones a `CSI` matcher misses — RIS, a charset selector, DCS/APC/PM
//      strings, the C1 one-byte forms of CSI and OSC, an OSC 8 hyperlink — and the
//      assertion is on the RENDERED BYTES, not on the cleaned title.
//   5. THE GRID IS MEASURED WITH SOMEBODY ELSE'S RULER. `columns` below is written from
//      the East Asian Width ranges rather than from lib/progress.js's own table, so an
//      alignment assertion cannot be satisfied by the padder agreeing with itself.
//
// Control bytes are spelled with `String.fromCharCode`/`String.fromCodePoint`
// throughout, and never as literals: a suite about invisible characters must not
// depend on an invisible character surviving a copy, a paste or a tool argument.

const MIN = 60000
const RUN = 'ralph-ralph-b36ff7b1'
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime()
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0) // 40min before NOW

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const cp = (n) => String.fromCodePoint(n)
const ST = ESC + String.fromCharCode(92) // string terminator: ESC backslash

const PASS = cp(0x2705)
const FAIL = cp(0x274c)
const UNKNOWN = cp(0x2754)
const LIVE = cp(0x1f504)
const FULL_CELL = cp(0x2588)
const EMPTY_CELL = cp(0x2500)

const event = ({ number = 29, run = RUN, minutes = 60, cost = 1, verdict = 'pass', ts = 1 } = {}) => ({
  issue_number: number,
  run_id: run,
  ts,
  duration_ms: minutes == null ? null : minutes * MIN,
  total_cost_usd: cost,
  verdict,
})

const jsonl = (...events) =>
  events.map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e)).join('\n') + '\n'

// Two closed rows and one in flight, so every fixture has a full grid to lose.
const TWO_CLOSED = jsonl(
  event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
  event({ number: 30, minutes: 71, cost: 28.75, ts: 2 }),
)

const record = (overrides = {}) => ({
  run_id: RUN,
  queue_at_start: 8,
  current: { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 1 },
  ...overrides,
})

const live = (overrides = {}) =>
  buildProgress({
    metricsText: TWO_CLOSED,
    record: record(),
    queue: 6,
    now: NOW,
    ...overrides,
  })

// ---------------------------------------------------------------------------
// AN INDEPENDENT COLUMN MEASURE — written from the Unicode East Asian Width W/F
// ranges and the emoji presentation blocks, deliberately NOT copied from
// lib/progress.js. Combining marks, variation selectors and format characters count
// zero, which is what a terminal draws. Regional indicators are absent on purpose:
// a terminal composes a flag PAIR into one double-wide glyph, and the divergence
// that leaves is the subject of its own case below.
// ---------------------------------------------------------------------------
const WIDE = [
  [0x1100, 0x115f],
  [0x2705, 0x2705],
  [0x274c, 0x274c],
  [0x2753, 0x2755],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u

function columns(text) {
  let width = 0
  for (const ch of String(text)) {
    if (ZERO_WIDTH.test(ch)) continue
    const point = ch.codePointAt(0)
    width += WIDE.some(([lo, hi]) => point >= lo && point <= hi) ? 2 : 1
  }
  return width
}

// Which terminal column a line's verdict cell opens in. Anchored on the LAST marker,
// so a title that carries a marker glyph of its own cannot make this read the wrong
// cell — the one thing a hostile title could do to a naive measurement.
const MARKERS = new RegExp(`[${PASS}${FAIL}${UNKNOWN}${LIVE}]`, 'gu')
const verdictColumn = (line) => {
  const found = [...line.matchAll(MARKERS)]
  const at = found.length > 0 ? found.at(-1).index : line.lastIndexOf('verdict')
  return columns(line.slice(0, at))
}
const aligned = (lines) => new Set(lines.map(verdictColumn)).size === 1

// Every category a terminal can be driven by, plus the format characters that reorder
// a line without being control bytes at all.
const NON_PRINTING = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u

const label = (value) => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

describe('buildProgress — a titles map that MISBEHAVES, not merely one of the wrong shape (#56)', () => {
  it('degrades to no title for a titles map whose read throws, rather than taking the view down', () => {
    // The module's promise about this seam, in its own words: absent, wrong-shaped or
    // half-filled, every row simply renders as its number. A read that THROWS is the
    // shape that promise is thinnest against — the Map branch wraps `.get()` in a
    // try/catch and the own-property branch reads `titles[number]` bare — and the
    // caller is a read-only status view, so there is nothing here worth an exception.
    const throwingGetter = () => {
      const map = {}
      Object.defineProperty(map, '29', {
        get() {
          throw new Error('a title lookup exploded')
        },
        enumerable: true,
        configurable: true,
      })
      return map
    }
    const secondReadThrows = () => {
      const map = { 29: 'sidebar' }
      Object.defineProperty(map, '30', {
        get() {
          throw new Error('a title lookup exploded, later')
        },
        enumerable: true,
        configurable: true,
      })
      return map
    }
    const hostile = {
      'an own property whose getter throws': throwingGetter(),
      'a getter that throws on the second row, after a first one succeeded':
        secondReadThrows(),
      'a Proxy whose get trap throws': new Proxy(
        {},
        {
          get() {
            throw new Error('proxied')
          },
        },
      ),
      'a Proxy whose ownKeys and descriptor traps throw': new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error('proxied')
          },
          has() {
            throw new Error('proxied')
          },
        },
      ),
      'a Map whose get throws': new Proxy(new Map(), {
        get: (target, key) =>
          key === 'get'
            ? () => {
                throw new Error('mapped')
              }
            : Reflect.get(target, key),
      }),
    }
    // Gathered rather than asserted one at a time, so a failure names EVERY shape that
    // takes the view down instead of stopping at the first.
    const threw = []
    const rendered = {}
    for (const [what, titles] of Object.entries(hostile)) {
      try {
        const snapshot = buildProgress({
          metricsText: TWO_CLOSED,
          record: record(),
          queue: 6,
          now: NOW,
          titles,
        })
        rendered[what] = { numbers: snapshot.tasks.map((task) => task.number), lines: renderTaskTable(snapshot) }
      } catch (error) {
        threw.push(`${what}: ${error.constructor.name}: ${error.message}`)
      }
    }
    expect(threw).toEqual([])
    for (const [what, { numbers, lines }] of Object.entries(rendered)) {
      // Degraded to numbers, and every row still there: a missing courtesy costs a
      // word, never a row.
      expect(numbers, what).toEqual([29, 30, 31])
      expect(lines.length, what).toBe(4)
      expect(aligned(lines), `${what}\n${lines.join('\n')}`).toBe(true)
    }
  })

  it('invents no title from a polluted Object.prototype, however the row is numbered', () => {
    // The realistic pollution vector is a `__proto__` key in JSON somebody else wrote,
    // and the defence is `Object.hasOwn`. Asserted from the other side here: with the
    // prototype ALREADY polluted, an empty map must still answer nothing.
    const poisoned = [29, '29', 30, 31]
    try {
      for (const key of poisoned) Object.prototype[key] = 'PWNED'
      const cases = [
        [{}, [null, null, null]],
        [Object.create(null), [null, null, null]],
        // A real own key still answers, so the guard is `hasOwn` rather than a refusal
        // to look at objects at all.
        [{ 30: 'persist' }, [null, 'persist', null]],
      ]
      for (const [titles, expected] of cases) {
        const snapshot = live({ titles })
        expect(
          snapshot.tasks.map((task) => task.title),
          label(titles),
        ).toEqual(expected)
        expect(renderTaskTable(snapshot).join('\n'), label(titles)).not.toContain('PWNED')
      }
    } finally {
      for (const key of poisoned) delete Object.prototype[key]
    }
  })

  it('adds no property to Object.prototype for a metrics line that names one', () => {
    // The other end of the same hazard: the events are `JSON.parse`d out of a file the
    // loop appends to, and one line of it is enough to try.
    const snapshot = buildProgress({
      metricsText:
        'RALPH_ISSUE_EVENT ' +
        JSON.stringify({ issue_number: 29, run_id: RUN, ts: 1, verdict: 'pass' }).replace(
          '{',
          '{"__proto__":{"pwned":1},',
        ) +
        '\n',
      record: record({ current: null }),
      queue: 2,
      now: NOW,
    })
    expect({}.pwned).toBeUndefined()
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.tasks[0]).toMatchObject({ number: 29, verdict: 'pass' })
  })
})

describe('the pure module is PURE — asserted behaviourally and structurally (#56)', () => {
  it('renders a full view with the ambient clock made unusable', () => {
    // The acceptance criterion is that every input is passed in, and `now` is one of
    // them. Proven by taking the ambient clock away for exactly the length of the
    // three calls: a module that reached for `Date.now()` would throw instead of
    // rendering, and restoring in a `finally` keeps the sabotage from escaping into
    // the runner.
    const real = Date.now
    let rendered
    try {
      Date.now = () => {
        throw new Error('lib/progress.js read the ambient clock')
      }
      const snapshot = buildProgress({
        metricsText: TWO_CLOSED,
        record: record(),
        queue: 6,
        now: NOW,
        titles: { 29: 'sidebar' },
      })
      rendered = [renderProgressLine(snapshot), ...renderTaskTable(snapshot)]
    } finally {
      Date.now = real
    }
    // ...and the same bytes the clock-having run produces, so the elapsed really did
    // come from `now` rather than from a fallback.
    const snapshot = live({ titles: { 29: 'sidebar' } })
    expect(rendered).toEqual([renderProgressLine(snapshot), ...renderTaskTable(snapshot)])
    expect(rendered[0]).toContain('40min')
  })

  it('imports one pure module and names no clock, no environment and no filesystem', () => {
    // Over the source with the PROSE TAKEN OUT: this module's header comment promises
    // "no `Date.now`, no ambient clock" in those words, which is the false positive
    // test/helpers/source-code.js exists for.
    //
    // THE IMPORT LIST WAS EMPTY UNTIL #121, and it is pinned rather than merely bounded: the
    // one edge is lib/issue-event-lines.js, the shared walk over the metrics log's lines, which
    // has no imports of its own — so the capability claim this row is really making is
    // unchanged. The far end is read in progress.qa.test.js's purity block, beside the same
    // argument; a second specifier appearing here fails this row by name.
    const code = codeWithoutComments(new URL('./progress.js', import.meta.url))
    expect([...code.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1])).toEqual([
      './issue-event-lines.js',
    ])
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/\bDate\.now\b/)
    expect(code).not.toMatch(/\bperformance\b/)
    expect(code).not.toMatch(/\bprocess\./)
    expect(code).not.toMatch(/\bMath\.random\b/)
    expect(code).not.toMatch(/node:/)
    expect(code).not.toMatch(/\bfetch\s*\(/)
    // `Date.parse` is the one Date member it may name: parsing a recorded instant is
    // arithmetic over an argument, not a reading of the present.
    expect([...new Set([...code.matchAll(/\bDate\.(\w+)/g)].map((m) => m[1]))]).toEqual(['parse'])
  })
})

describe('renderProgressLine — the bar cannot contradict the percentage beside it (#56)', () => {
  it('holds the bar, the percentage and the fraction to one story at every reachable ratio', () => {
    // INVARIANTS rather than a recomputed formula: `Math.round(ratio * 8)` written out
    // here would agree with the implementation by construction. What is asserted is
    // what a reader relies on — a bar of eight cells, an empty bar only for a run that
    // has finished nothing, a full bar only for one that has finished everything, and a
    // percentage that never rounds UP except off the deliberate 1% floor.
    for (let done = 0; done <= 12; done += 1) {
      for (const total of [1, 2, 3, 5, 8, 12, 100, 1000]) {
        const line = renderProgressLine({ completed: done, total, tasks: [] })
        const shown = line.match(/\[([^\]]*)\] (\d+)%/)
        const knobs = `${done}/${total} -> ${line}`
        expect(shown, knobs).not.toBeNull()
        const filled = [...shown[1]].filter((c) => c === FULL_CELL).length
        const empty = [...shown[1]].filter((c) => c === EMPTY_CELL).length
        const percent = Number(shown[2])
        const ratio = Math.min(1, done / total)
        // One bar of eight cells, made of nothing else.
        expect(filled + empty, knobs).toBe(8)
        expect(columns(shown[1]), knobs).toBe(8)
        // The two ends are RESERVED, and they mean each other.
        expect(filled === 0, knobs).toBe(percent === 0)
        expect(filled === 8, knobs).toBe(percent === 100)
        expect(filled === 0, knobs).toBe(ratio === 0)
        expect(filled === 8, knobs).toBe(ratio === 1)
        // Never overstated: the printed percentage is the floor of the true ratio, with
        // the single documented exception that a started run never prints 0%.
        expect(percent, knobs).toBeLessThanOrEqual(Math.max(1, Math.floor(ratio * 100)))
        expect(percent, knobs).toBeGreaterThanOrEqual(Math.floor(ratio * 100))
        // ...and the fraction above it counts the same two numbers.
        expect(line, knobs).toContain(`${done}/${total} done`)
      }
    }
  })

  it('prints a denominator too large for JSON to hold without falling back to exponent form', () => {
    // A corrupt or overflowed queue count is a number nobody will read, but `1e+300`
    // on the progress line reads as a bug in Ralph rather than in the count — the same
    // argument `padTaskNumber` makes about an absurd issue number.
    for (const queue of [1e21, 1e300, Number.MAX_VALUE]) {
      const line = renderProgressLine(live({ queue }))
      expect(line, String(queue)).not.toMatch(/e[+-]\d/)
      expect(line, String(queue)).not.toMatch(/NaN|Infinity|undefined/)
      // Still one line, and still a bar: a huge denominator is a tiny fraction, which
      // the 1% floor keeps visible.
      expect(line.split('\n'), String(queue)).toHaveLength(1)
      expect(line, String(queue)).toContain('] 1%')
    }
  })
})

describe('renderTaskTable — the escape forms a CSI matcher does not match (#56)', () => {
  // Every one of these drives a terminal WITHOUT being `ESC [ ... final`: RIS resets
  // the device, `ESC ( B` selects a charset, DCS/APC/PM open string modes that swallow
  // whatever follows, U+009B and U+009D are the one-byte C1 forms of CSI and OSC, and
  // OSC 8 turns text into a hyperlink. A title carrying any of them arrives from a
  // GitHub issue somebody else wrote.
  const forms = {
    'RIS, which resets the whole device': ESC + 'c',
    'a charset selector': ESC + '(B',
    'a DCS string': ESC + 'P1;2q' + ST,
    'an APC string': ESC + '_apc' + ST,
    'a PM string': ESC + '^pm' + ST,
    'the C1 one-byte CSI': cp(0x9b) + '31m',
    'the C1 one-byte OSC': cp(0x9d) + '0;title' + BEL,
    'an OSC 8 hyperlink around the text': ESC + ']8;;http://example' + ST + 'click' + ESC + ']8;;' + ST,
    'a CSI with two hundred parameter digits': ESC + '[' + '9'.repeat(200) + 'm',
    'a doubled escape, so stripping one leaves another': ESC + ESC + '[31m',
    'a cursor-hide sequence': ESC + '[?25l',
    'a cursor-position REPORT request, which makes the terminal type back': ESC + '[6n',
    'a bare ESC with a bracket and nothing else': ESC + '[',
    'a bare ESC with a closing bracket and nothing else': ESC + ']',
    'every C1 byte at once': Array.from({ length: 32 }, (_, i) => cp(0x80 + i)).join(''),
    'a scroll-region set followed by a clear': ESC + '[1;1r' + ESC + '[2J',
  }

  for (const [what, title] of Object.entries(forms)) {
    it(`emits no escape byte, and no extra line, for a title carrying ${what}`, () => {
      const snapshot = live({ titles: { 29: title } })
      const lines = [renderProgressLine(snapshot), ...renderTaskTable(snapshot)]
      for (const line of lines) {
        expect(line, `${what}: ${JSON.stringify(line)}`).not.toMatch(NON_PRINTING)
        // Named individually as well as by category, because these are the two bytes
        // the whole sanitizer exists for and a category test is easy to widen.
        expect(line.includes(ESC), what).toBe(false)
        expect(line.includes(cp(0x9b)), what).toBe(false)
        expect(line.includes(cp(0x9d)), what).toBe(false)
      }
      // A title cannot become a line: three rows and a header, whatever it says.
      expect(renderTaskTable(snapshot), what).toHaveLength(4)
      expect(aligned(renderTaskTable(snapshot)), `${what}\n${lines.join('\n')}`).toBe(true)
    })
  }
})

describe('renderTaskTable — the derived task column, at its documented ceiling (#56)', () => {
  const tableFor = (number) =>
    renderTaskTable(
      live({
        metricsText: jsonl(
          event({ number, minutes: 97, cost: 34.1, ts: 1 }),
          event({ number: 30, minutes: 71, cost: 28.75, ts: 2 }),
        ),
        titles: {},
      }),
    )

  it('stretches the column for a number that fits its eight-column ceiling', () => {
    // `#1234567` is exactly eight columns — the widest the column will stretch to —
    // so the whole grid moves right together and stays rectangular. The boundary is
    // asserted from both sides because a fencepost here is invisible in the happy path.
    for (const number of [999999, 1234567]) {
      const lines = tableFor(number)
      expect(lines[1], String(number)).toContain(`#${number}`)
      expect(aligned(lines), `${number}\n${lines.join('\n')}`).toBe(true)
    }
  })

  it('lets a number past the ceiling overflow its OWN line, and no other', () => {
    // One column further is a corrupt row rather than a repo's issue, and the module
    // documents the trade it makes: that row overflows itself instead of shifting every
    // other row right. The promise being pinned is the SECOND half — the header and the
    // rows either side of the corrupt one stay aligned with each other — since without
    // it the table is simply broken rather than deliberately ragged.
    const lines = tableFor(12345678)
    expect(lines[1]).toContain('#12345678')
    expect(lines.join('\n')).not.toMatch(/e[+-]\d/)
    const others = lines.filter((_, i) => i !== 1)
    expect(aligned(others), lines.join('\n')).toBe(true)
    // ...and the overflowing row overflows to the RIGHT, never eating the column that
    // holds somebody else's verdict.
    expect(verdictColumn(lines[1])).toBeGreaterThan(verdictColumn(lines[0]))
    // The number itself is never shortened: identity is one of the two things this
    // view will not truncate.
    expect(lines[1]).not.toContain(cp(0x2026))
  })

  it('keeps the other rows aligned around a regional-indicator flag title', () => {
    // A KNOWN DIVERGENCE, pinned here rather than asserted away: this view measures a
    // flag as its two regional indicators (four columns), while a terminal composes the
    // pair into one double-wide glyph. So the flag row can sit two columns off in a
    // real terminal — cosmetic, terminal-dependent, and reported rather than encoded as
    // an expectation either way. What IS asserted is that nothing else moves, no escape
    // reaches the line, and the row is still a row.
    const flag = cp(0x1f1e7) + cp(0x1f1f7)
    const lines = renderTaskTable(live({ titles: { 29: flag } }))
    expect(lines).toHaveLength(4)
    expect(lines[1]).toContain(flag)
    for (const line of lines) expect(line).not.toMatch(NON_PRINTING)
    expect(aligned(lines.filter((_, i) => i !== 1)), lines.join('\n')).toBe(true)
    expect(lines.every((line) => !/\s$/.test(line))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// #127 QA — THE IN-FLIGHT TASK NAMED BY ITS JIRA KEY. `task_key` is the first string this
// view draws that did not come from GitHub: acli printed it, bash passed it, and
// lib/run-state.js wrote it to a file verbatim (measured in lib/run-state.qa.test.js — the
// record keeps an ESC byte, a NUL and a megabyte of text). So the key is treated here exactly
// as a hostile issue title is, and the three questions are:
//
//   IS THE SANITIZER GENUINELY ON THE KEY PATH? Asserted on the RENDERED BYTES for the forms
//   a `CSI` matcher misses, the same way the title sweep above is — not by reading the source
//   and finding a `cleanTitle` call.
//
//   WHAT DOES THE KEY DO TO THE GRID? The number column stretches to NUMBER_COLUMN_MAX and no
//   further, so a key wider than that must overflow its OWN line and leave every other row
//   where it was. Measured with the independent `columns` ruler above.
//
//   AND WHAT MUST NOT CHANGE. The `--json` document is a machine contract that predates
//   #127; `tasks.current` still holds exactly the two fields it always did. Pinned so adding
//   the key there is a decision rather than an accident.
// ---------------------------------------------------------------------------

const IN_FLIGHT = { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 1 }
// A snapshot whose in-flight task carries `task_key`, with everything else held at the
// fixture's values so any difference in the rendered lines is the key's doing.
const keyed = (task_key, overrides = {}) =>
  live({ record: record({ current: { ...IN_FLIGHT, task_key } }), ...overrides })

describe('renderTaskTable — the in-flight row is named by its Jira key (#127 QA)', () => {
  it('names the row and the progress line with ONE spelling of the task', () => {
    // Both renderers go through `numberText`, so this is the assertion that they cannot
    // disagree: a reader watching the progress line and the table at once must see the same
    // ticket named the same way.
    const snapshot = keyed('FOO-9')
    const lines = renderTaskTable(snapshot)
    expect(lines).toHaveLength(4)
    expect(lines[3]).toContain('FOO-9')
    expect(renderProgressLine(snapshot)).toContain('FOO-9 in flight')
    // The derived number is a HANDLE and not a label: `#031` would name a GitHub issue in a
    // repo that has one, so it must not appear anywhere a reader looks.
    expect(lines[3]).not.toContain('#031')
    expect(renderProgressLine(snapshot)).not.toContain('#031')
    expect(aligned(lines), lines.join('\n')).toBe(true)
  })

  it('never shows a keyed row a title from the GitHub titles map', () => {
    // The collision this design exists to avoid, measured: `titles` is keyed by GITHUB issue
    // number and the record's derived number is 31, so a lookup would print issue #31's title
    // beside FOO-9 as though it were the ticket's summary. It does not.
    const snapshot = keyed('FOO-9', { titles: { 31: 'a github issue title' } })
    const lines = renderTaskTable(snapshot)
    expect(lines[3]).toContain('FOO-9')
    expect(lines.join('\n')).not.toContain('a github issue title')
    expect(renderProgressLine(snapshot)).not.toContain('a github issue title')
    // ...while the CLOSED rows, which are GitHub issues, still get theirs.
    const withClosed = live({ titles: { 29: 'sidebar', 31: 'a github issue title' } })
    expect(renderTaskTable(withClosed)[1]).toContain('sidebar')
  })

  // MEASURED: every one of these falls back to the padded number, and the interesting half is
  // the LAST row — a key that is a real string until the sanitizer is done with it.
  const fallsBack = {
    'no task_key field at all': undefined,
    'task_key null (the github and folder arms)': null,
    'an empty string': '',
    'whitespace only': '   ',
    'a number': 123,
    'an object': { key: 'FOO-1' },
    'an array': ['FOO-1'],
    'a boolean': true,
    'a key that is nothing but a CSI sequence': ESC + '[31m',
  }

  for (const [what, task_key] of Object.entries(fallsBack)) {
    it(`falls back to #031 for ${what}`, () => {
      const snapshot = keyed(task_key)
      const lines = renderTaskTable(snapshot)
      expect(lines[3], what).toContain('#031')
      expect(renderProgressLine(snapshot), what).toContain('#031 in flight')
      // No template hole and no half-name: a row is named by a key or by a number, never by
      // the empty string.
      expect(lines[3], what).not.toContain('#null')
      expect(lines[3], what).not.toContain('#NaN')
      expect(aligned(lines), `${what}\n${lines.join('\n')}`).toBe(true)
    })
  }

  it('leaves the harmless RESIDUE of an escape as the row’s name (measured boundary)', () => {
    // MEASURED, and the reason the table above stops where it does: a full CSI sequence is
    // removed whole, so `ESC [ 31 m` cleans to nothing and the row falls back to its number —
    // but `ESC c` (RIS) and `ESC ( B` are not CSI, so only the ESC byte goes and the letters
    // stay. The row is then named `c (B`, which is nonsense a human can see and NOT something
    // a terminal obeys. Pinned rather than judged: refusing to draw a key the grammar dislikes
    // would make this view disagree with the board, which is the trade `taskKeyOf` documents.
    const lines = renderTaskTable(keyed(ESC + 'c' + ESC + '(B'))
    expect(lines[3]).toContain('c (B')
    expect(lines[3].includes(ESC)).toBe(false)
    expect(lines).toHaveLength(4)
  })

  it('names a keyed task with NO number at all — the jira arm passes none', () => {
    // bash sends `''` for the number in jira mode, and lib/run-state.js derives one from the
    // key. A key past the safe-integer boundary has no derivable number, so this is the shape
    // that actually reaches the view: a name and no handle.
    const snapshot = live({
      record: record({
        current: { started_at: TASK_STARTED.toISOString(), iteration: 1, task_key: 'FOO-9007199254740992' },
      }),
    })
    const lines = renderTaskTable(snapshot)
    expect(lines[3]).toContain('FOO-90071992')
    expect(lines.join('\n')).not.toContain('#NaN')
    expect(lines.join('\n')).not.toContain('#null')
    expect(lines.join('\n')).not.toContain('#undefined')
  })
})

describe('renderTaskTable — a Jira key against the number column’s ceiling (#127 QA)', () => {
  it('stretches the column for a key that fits its eight-column ceiling', () => {
    // `FOO-1234` is exactly eight columns, the widest the column stretches to, so the whole
    // grid moves right together and stays rectangular. Both sides of the boundary, because a
    // fencepost here is invisible in the happy path.
    for (const key of ['FOO-1', 'FOO-1234']) {
      const lines = renderTaskTable(keyed(key))
      expect(lines[3], key).toContain(key)
      expect(aligned(lines), `${key}\n${lines.join('\n')}`).toBe(true)
    }
  })

  it('lets a key past the ceiling overflow its OWN line, and no other', () => {
    // Nine columns is one past NUMBER_COLUMN_MAX. The trade the module documents for a long
    // NUMBER applies to a long KEY identically: the keyed row goes ragged rather than shifting
    // every closed row right, and the key itself is never shortened to fit — identity is one
    // of the two things this view will not truncate.
    const lines = renderTaskTable(keyed('FOO-12345'))
    expect(lines[3]).toContain('FOO-12345')
    const others = lines.filter((_, i) => i !== 3)
    expect(aligned(others), lines.join('\n')).toBe(true)
    expect(verdictColumn(lines[3])).toBeGreaterThan(verdictColumn(lines[0]))
  })

  it('measures a CJK key in COLUMNS, not in code points', () => {
    // `テスト-1` is four characters and EIGHT columns, so it lands exactly on the ceiling — a
    // view that counted characters would pad it to four and every row below would be two
    // columns out. Measured with the East Asian Width ruler at the top of this file rather
    // than with lib/progress.js's own table.
    const key = cp(0x30c6) + cp(0x30b9) + cp(0x30c8) + '-1'
    expect(columns(key)).toBe(8)
    const lines = renderTaskTable(keyed(key))
    expect(lines[3]).toContain(key)
    expect(aligned(lines), lines.join('\n')).toBe(true)
  })

  it('counts combining marks as nothing, and caps how many of them it draws', () => {
    // 300 combining acutes on a five-column key. They add no columns (a terminal stacks them
    // on the preceding letter), so the grid stays aligned by this view's ruler — and the
    // sanitizer's code-point cap is what stops the LINE from carrying all 300.
    const key = 'FOO-1' + cp(0x301).repeat(300)
    const lines = renderTaskTable(keyed(key))
    expect(lines[3]).toContain('FOO-1')
    expect([...lines[3]].filter((ch) => ch === cp(0x301)).length).toBeLessThan(300)
    expect(aligned(lines), lines.join('\n')).toBe(true)
    expect(lines).toHaveLength(4)
  })

  it('bounds a megabyte key to the title width instead of drawing it', () => {
    // The record is not bounded (lib/run-state.qa.test.js measures a megabyte going to disk),
    // so the bound has to be here. Asserted as a line length rather than as an exact string:
    // the promise is that the terminal is never handed the whole thing.
    const lines = renderTaskTable(keyed('X'.repeat(1_000_000)))
    expect(lines).toHaveLength(4)
    expect(lines[3].length).toBeLessThan(200)
    expect(lines[3]).toContain(cp(0x2026))
    expect(aligned(lines.filter((_, i) => i !== 3)), lines.join('\n')).toBe(true)
  })
})

describe('renderTaskTable — a hostile Jira key cannot reach the terminal (#127 QA)', () => {
  // The same question the title sweep above asks, on the path #127 opened. Worth asking twice:
  // the key is resolved by `taskKeyOf` rather than by `resolveTitle`, so it is a SECOND call
  // site for the sanitizer and a regression in one would not show in the other.
  const forms = {
    'a colour CSI': ESC + '[31m',
    'RIS, which resets the whole device': ESC + 'c',
    'the C1 one-byte CSI': cp(0x9b) + '31m',
    'the C1 one-byte OSC': cp(0x9d) + '0;title' + BEL,
    'an OSC 8 hyperlink around the key': ESC + ']8;;http://example' + ST + 'FOO-1' + ESC + ']8;;' + ST,
    'a DCS string': ESC + 'P1;2q' + ST + 'FOO-1',
    'a NUL byte inside the key': 'FOO' + String.fromCharCode(0) + '-1',
    'a carriage return, which would redraw the line from column 0': 'FOO-1' + String.fromCharCode(13) + '#999',
    'a cursor-position report request': 'FOO-1' + ESC + '[6n',
    'a right-to-left override': cp(0x202e) + 'FOO-1',
    'a zero-width space': 'F' + cp(0x200b) + 'OO-1',
    'every C1 byte at once': Array.from({ length: 32 }, (_, i) => cp(0x80 + i)).join('') + 'FOO-1',
  }

  for (const [what, task_key] of Object.entries(forms)) {
    it(`emits no control byte for a key carrying ${what}`, () => {
      const snapshot = keyed(task_key)
      const lines = [renderProgressLine(snapshot), ...renderTaskTable(snapshot)]
      for (const line of lines) {
        expect(line, `${what}: ${JSON.stringify(line)}`).not.toMatch(NON_PRINTING)
        expect(line.includes(ESC), what).toBe(false)
        expect(line.includes(cp(0x9b)), what).toBe(false)
        expect(line.includes(cp(0x9d)), what).toBe(false)
      }
      // A key cannot become a row: four lines, whatever it says.
      expect(renderTaskTable(snapshot), what).toHaveLength(4)
    })
  }

  it('cannot forge a table row out of a key', () => {
    // The #107/#108 attack, arriving through #127's new field: a newline plus a plausible row
    // would read as a fourth task that never ran. The whole thing collapses onto one line.
    const forged = 'FOO-1' + String.fromCharCode(10) + '  #999  ' + PASS + ' pass     $0.00     1min'
    const lines = renderTaskTable(keyed(forged))
    expect(lines).toHaveLength(4)
    expect(lines.filter((line) => line.includes('#999'))).toHaveLength(1)
    expect(lines[3]).toContain('FOO-1')
    // ...and the forged verdict is inside the KEY cell, not in the verdict column, so the row
    // still reads as the live one it is.
    expect(lines[3]).toContain('live')
  })
})

describe('toJsonSnapshot — the machine contract, changed ON PURPOSE by #132 (#132 QA)', () => {
  // #127 pinned `tasks.current` at exactly `{number, started_at}` and said the third key "must
  // be a decision somebody makes on purpose rather than a field that leaks in". #132 is that
  // decision, and this block is what makes it one: the pin is not deleted, it is REWRITTEN to
  // the new contract, so a fourth key still has to come through here to exist.
  const projected = (task_key) =>
    toJsonSnapshot(keyed(task_key), {
      mode: 'run',
      record: { run_id: RUN, current: { ...IN_FLIGHT, task_key } },
    })

  it('publishes tasks.current as exactly {number, started_at, task_key}', () => {
    const document = projected('FOO-9')
    expect(Object.keys(document.tasks.current)).toEqual(['number', 'started_at', 'task_key'])
    expect(document.tasks.current.number).toBe(31)
    expect(document.tasks.current.task_key).toBe('FOO-9')
  })

  it('publishes the key VERBATIM, not the spelling the table renders', () => {
    // The table's cell is scrubbed and truncated for a terminal; a script is not a terminal, and
    // a re-spelled key resolves to no ticket. So the two surfaces disagree by design, and this
    // pins which one transcribes: `  foo-9  ` reaches the document with its own case, and only
    // the blank-and-nothing-else reading is normalized away.
    expect(projected('  foo-9  ').tasks.current.task_key).toBe('  foo-9  ')
    for (const blank of ['', '   ', null, undefined, 9, {}]) {
      expect(projected(blank).tasks.current.task_key, String(blank)).toBe(null)
    }
  })

  it('leaves a GitHub run’s document identical to the one #58 published', () => {
    // The other half of a schema change: the leaf is present-and-null for every run that has no
    // key, so a consumer of a github or folder run reads the same two facts it always did plus a
    // `null` it can ignore. `JSON.stringify` would DROP an `undefined` here, which is why the
    // projection decides the null rather than letting the record's absence decide it.
    const document = toJsonSnapshot(keyed(undefined), {
      mode: 'run',
      record: { run_id: RUN, current: { ...IN_FLIGHT } },
    })
    expect(document.tasks.current).toEqual({
      number: 31,
      started_at: document.tasks.current.started_at,
      task_key: null,
    })
    expect(JSON.stringify(document)).toContain('"task_key":null')
  })
})

// ===========================================================================
// QA augmentation for #131 — ONE LOG, TWO KINDS OF TASK.
// ===========================================================================
//
// lib/progress.table.test.js owns the keyed closed row on its own. What it does not have is
// the HYBRID log, which is the shape #131 actually makes possible: `.ralph/metrics/issues.jsonl`
// is append-only for the life of the repo, so a repo that worked GitHub issues and then
// switched `TASK_SOURCE` to `jira` has both kinds of event in one file — and since the jira
// number is DERIVED (`FOO-123` → 123, lib/jira-key.js's accepted collision), two rows in that
// file can carry the same number while naming different work.
//
// The interesting question is not the tally (`aggregateCycleCounts` owns that) but the CELL: a
// row's title comes from a map keyed by GitHub issue number, and the two rows must not be able
// to borrow each other's name.
describe('a hybrid log names each row from its OWN source (#131 QA)', () => {
  const keyed = ({ number = 123, key = 'FOO-123', ts = 2, ...rest } = {}) => ({
    ...event({ number, ts, ...rest }),
    task_key: key,
  })

  // The collision, spelled out: GitHub issue #123 was worked first, then ticket FOO-123 — one
  // number, two tasks, in one file.
  const HYBRID = jsonl(event({ number: 123, minutes: 40, cost: 2, ts: 1 }), keyed({ minutes: 50, cost: 3, ts: 2 }))
  const TITLES = { 123: 'the GitHub issue’s title' }

  const hybrid = (overrides = {}) =>
    buildProgress({ metricsText: HYBRID, record: record(), queue: 6, now: NOW, titles: TITLES, ...overrides })

  it('keeps BOTH rows: a derived number colliding with an issue number drops nothing', () => {
    const rows = hybrid().tasks.slice(0, -1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ number: 123, key: null })
    expect(rows[1]).toMatchObject({ number: 123, key: 'FOO-123' })
  })

  it('titles the github row from the map and refuses to title the ticket from it', () => {
    // The whole collision in one assertion, and the reason it stays impossible after #132 made
    // the map reachable from a keyed row: a row is looked up by WHAT NAMES IT, so the github row
    // asks for `123` and the ticket asks for `FOO-123`. This map came from
    // `gh issue list --json number,title`, which knows nothing about a board, so the ticket's
    // question has no answer here — it is not withheld, it simply does not match.
    const rows = hybrid().tasks
    expect(rows[0].title).toBe('the GitHub issue’s title')
    expect(rows[1].title).toBe(null)
  })

  it('renders the issue as #123 and the ticket as FOO-123, on their own lines', () => {
    const lines = renderTaskTable(hybrid())
    expect(lines[1]).toContain('#123')
    expect(lines[1]).toContain('the GitHub issue’s title')
    expect(lines[2]).toContain('FOO-123')
    expect(lines[2]).not.toContain('the GitHub issue’s title')
    expect(lines[2]).not.toContain('#123')
    expect(aligned(lines), lines.join('\n')).toBe(true)
  })

  it('names a keyed row whose number could not be derived at all', () => {
    // `FOO-1.5` is a ticket Ralph works and a key it can read no number out of (lib/jira-key.js
    // refuses a non-integer work item), so the row has a key and no number — and the key is what
    // saves the cell from `#???`. Seven columns, so the grid still closes: a key past
    // NUMBER_COLUMN_MAX overflows its own line by design, which the #127 block above pins.
    const lines = renderTaskTable(
      buildProgress({
        metricsText: jsonl(keyed({ number: null, key: 'FOO-1.5', minutes: 30, cost: 1, ts: 1 })),
        record: record(),
        queue: 6,
        now: NOW,
        titles: TITLES,
      }),
    )
    expect(lines[1]).toContain('FOO-1.5')
    expect(lines[1]).not.toContain('#')
    expect(aligned(lines), lines.join('\n')).toBe(true)
  })

  it('still uses the title the EVENT carries on a keyed row', () => {
    // The precedence rule, unchanged by #132: an injected title wins when the map answers, and
    // the event's own title is the fallback. This map answers `123` and the row asks `FOO-123`,
    // so the fallback is what renders. #132 resolves the Jira summary through the map rather
    // than through the log, which leaves this arm as the forward-compatible half it always was.
    const snapshot = buildProgress({
      metricsText: jsonl({ ...keyed({ ts: 1 }), title: 'the ticket’s own summary' }),
      record: record(),
      queue: 6,
      now: NOW,
      titles: TITLES,
    })
    expect(snapshot.tasks[0].title).toBe('the ticket’s own summary')
    expect(renderTaskTable(snapshot)[1]).toContain('the ticket’s own summary')
  })

  it('reads a NON-STRING task_key as no key, and titles that row from the map', () => {
    // issues.jsonl is untrusted text: `taskKeyOf` answers null for anything that is not a
    // string, so the row degrades to exactly what a pre-#131 event renders as. Pinned as the
    // degradation it is — the alternative would be a row that names nothing at all.
    for (const hostile of [123, null, { toString: () => 'FOO-1' }, ['FOO-1']]) {
      const snapshot = buildProgress({
        metricsText: jsonl({ ...event({ number: 123, ts: 1 }), task_key: hostile }),
        record: record(),
        queue: 6,
        now: NOW,
        titles: TITLES,
      })
      expect(snapshot.tasks[0].key, JSON.stringify(hostile) ?? String(hostile)).toBe(null)
      expect(snapshot.tasks[0].title, JSON.stringify(hostile) ?? String(hostile)).toBe(
        'the GitHub issue’s title',
      )
    }
  })

  it('falls back to the NUMBER when a key is nothing but bytes a terminal would obey', () => {
    // MEASURED, and not the answer this test was written expecting: `cleanTitle` returns null
    // rather than `''` for a string that scrubs away entirely (lib/progress.js — `printable ===
    // '' ? null : …`), so `taskKeyOf` reports no key at all and the row is treated as a github
    // one. It therefore prints `#123` AND borrows issue #123's injected title, which is the
    // collision this block is otherwise about — reachable only from a task_key that is pure
    // escape bytes, which lib/issue-event.js cannot write (it records the key it was handed) and
    // no board can name a project after. Pinned as the degradation it is: the row still names a
    // number the event carried, and nothing a terminal obeys reaches the screen.
    const snapshot = buildProgress({
      metricsText: jsonl(keyed({ key: ESC + '[31m' + BEL, ts: 1 })),
      record: record(),
      queue: 6,
      now: NOW,
      titles: TITLES,
    })
    expect(snapshot.tasks[0].key).toBe(null)
    expect(snapshot.tasks[0].title).toBe('the GitHub issue’s title')
    const lines = renderTaskTable(snapshot)
    expect(lines[1]).toContain('#123')
    expect(lines.join('\n')).not.toContain(ESC)
    expect(lines.join('\n')).not.toContain(BEL)
  })

  it('counts a keyed row in the fraction exactly like any other closed row', () => {
    // The rows ARE the numerator, so a jira event has to be countable — this is the reader's
    // half of `ralph status` reporting a Jira run at all, which is what #131 was for.
    const snapshot = hybrid()
    expect(snapshot.completed).toBe(2)
    expect(snapshot.inFlight).toBe(1)
    expect(renderProgressLine(snapshot)).toContain('2/')
  })
})

// ---------------------------------------------------------------------------
// QA augmentation for #132 — THE TITLES MAP IS NOW REACHED BY A STRING KEY.
//
// Before #132 a keyed row never touched `titles` at all: the map was keyed by GitHub issue
// number and a Jira row asked nothing of it. #132 makes `lookupTitle(titles, key)` the path
// every jira row takes, and the map on that path comes from `titlesFor` — which means it comes
// from acli, over a network, shaped by whatever a board answered with. The block at the top of
// this file already attacks a MISBEHAVING map on the NUMBER handle (#56); these are the same
// hazards on the STRING handle, which is a different branch of `lookupTitle` — the number path
// stringifies, the string path does not, and the `usableHandle` gate in front of the object
// branch reads them differently.
//
// AND THE MAP IS NOT THE ONLY NEW EDGE. `taskKeysFor` is the other half: it decides which keys
// `ralph status` will PAY to resolve, and if its window disagrees with the window
// `renderTaskTable` draws, the table shows a row whose title was never asked for — a blank cell
// no failure caused, which is the worst kind because nothing anywhere reports it. That
// agreement is asserted JOINTLY below rather than as a second copy of `MAX_TABLE_ROWS`.
// ---------------------------------------------------------------------------

describe('renderTaskTable — a MISBEHAVING titles map on the STRING handle (#132 QA)', () => {
  const keyedRow = (titles) =>
    buildProgress({
      metricsText: jsonl({ ...event({ number: 1, ts: 1 }), task_key: 'FOO-1' }),
      record: record(),
      queue: 6,
      now: NOW,
      titles,
    })

  it('degrades to NO TITLE for every map that misbehaves when asked by key', () => {
    // `titles` arrives from `titlesFor`, so in principle it is a plain object — but `ralph
    // status` renders inside the live tmux pane and a throw here takes the whole view down over
    // a courtesy label. `lookupTitle` is written with that in mind (a whole-body try/catch, a
    // `usableHandle` gate, `Object.hasOwn` rather than `in`), and these are the four shapes that
    // exercise each of those guards on the string branch. Measured: all four render the row
    // named and untitled, none of them throws.
    const misbehaving = {
      'an own property whose getter throws': Object.defineProperty({}, 'FOO-1', {
        get() {
          throw new Error('a getter that throws')
        },
        enumerable: true,
      }),
      'a Proxy that throws from every trap': new Proxy(
        {},
        {
          get() {
            throw new Error('get trap')
          },
          has() {
            throw new Error('has trap')
          },
          getOwnPropertyDescriptor() {
            throw new Error('gopd trap')
          },
        },
      ),
      'a Map whose get throws': Object.assign(new Map(), {
        get() {
          throw new Error('Map.get')
        },
      }),
      'a title only INHERITED, never own': Object.create({ 'FOO-1': 'an inherited title' }),
    }
    for (const [what, titles] of Object.entries(misbehaving)) {
      const snapshot = keyedRow(titles)
      expect(snapshot.tasks[0].title, what).toBe(null)
      const lines = renderTaskTable(snapshot)
      expect(lines[1], what).toContain('FOO-1')
      expect(lines[1], what).not.toContain('inherited')
      expect(aligned(lines), `${what}: ${lines.join('\n')}`).toBe(true)
    }
  })

  it('reads a real Map by key, which is the shape a future resolver may hand it', () => {
    // The Map branch is live on the string handle and `titlesFor` returns a plain object today,
    // so this is the arm nothing in production exercises. Pinned because the alternative to
    // pinning is discovering it broke on the day somebody changes the resolver's return type.
    const snapshot = keyedRow(new Map([['FOO-1', 'from a Map']]))
    expect(snapshot.tasks[0].title).toBe('from a Map')
    expect(renderTaskTable(snapshot)[1]).toContain('from a Map')
  })

  it('answers nothing for a Map keyed by something that is not the key', () => {
    // A Map whose keys are Symbols cannot be indexed by a string, and the lookup must say so
    // quietly rather than reach for `entries()`.
    expect(keyedRow(new Map([[Symbol('FOO-1'), 'never reachable']])).tasks[0].title).toBe(null)
  })
})

describe('taskKeysFor — what ralph status PAYS to resolve is what it DRAWS (#132 QA)', () => {
  // A jira run of `count` closed tickets, optionally with a tenth in flight. Every row names a
  // key, so the two windows below are comparable key-for-key.
  const runOf = (count, current) => ({
    metricsText: jsonl(
      ...Array.from({ length: count }, (_, i) => ({
        ...event({ number: i + 1, ts: i + 1 }),
        task_key: `AB-${i + 1}`,
      })),
    ),
    record: record({
      current: current
        ? { number: 99, started_at: TASK_STARTED.toISOString(), iteration: 1, task_key: 'AB-99' }
        : null,
    }),
  })

  // The keys a rendered table actually NAMES, read back off the drawn lines rather than off the
  // snapshot — because the snapshot carries every task and the table draws a window of them, and
  // it is the drawn window that a reader sees an empty title cell in. The elision row is `…` and
  // names no task, so it is dropped.
  const drawnKeys = (input) =>
    renderTaskTable(buildProgress({ ...input, queue: 6, now: NOW, titles: {} }))
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((first) => first !== cp(0x2026))

  it('asks about EXACTLY the rows the table draws, at every table size', () => {
    // THE JOINT ASSERTION, and the reason it is joint: `taskKeysFor` takes the last
    // MAX_TABLE_ROWS events and `renderTaskTable` draws the last MAX_TABLE_ROWS closed rows plus
    // the in-flight one, and those two are only the same window because the table's rows come
    // from the same run-scoped event list. Asserting the number 8 twice would not catch a change
    // to either window; asserting they AGREE would. Measured at 3, 7, 8, 9, 12 and 20 events:
    // every key the table draws is a key that was asked about, and nothing is asked needlessly.
    for (const count of [3, 7, 8, 9, 12, 20]) {
      for (const withCurrent of [true, false]) {
        const input = runOf(count, withCurrent)
        const what = `${count} events, current=${withCurrent}`
        expect(taskKeysFor(input), what).toEqual(drawnKeys(input))
      }
    }
  })

  it('never asks about a key belonging to a DIFFERENT run', () => {
    // `belongsToRun` scopes the table, and it has to scope the query too: a key from yesterday's
    // run is a ticket nobody is looking at, and a `key IN (…)` naming it is a bigger query for a
    // row that is not on screen. Measured: one key asked, one row drawn.
    const input = {
      metricsText: jsonl(
        { ...event({ number: 1, ts: 1, run: 'ralph-ralph-someone-else' }), task_key: 'AB-1' },
        { ...event({ number: 2, ts: 2 }), task_key: 'AB-2' },
      ),
      record: record({ current: null }),
    }
    expect(taskKeysFor(input)).toEqual(['AB-2'])
    expect(drawnKeys(input)).toEqual(['AB-2'])
  })

  it('asks about one ticket ONCE however many rows it has', () => {
    // A retried ticket appends a second event under the same key, and both rows are drawn. The
    // query must still name the ticket once — `titlesFor` de-duplicates too, but paying for the
    // duplicate twice over is a `--limit` that does not match the tickets it names.
    const input = {
      metricsText: jsonl(
        { ...event({ number: 1, ts: 1, verdict: 'fail' }), task_key: 'AB-1' },
        { ...event({ number: 1, ts: 2 }), task_key: 'AB-1' },
      ),
      record: record({ current: { number: 1, started_at: TASK_STARTED.toISOString(), task_key: 'AB-1' } }),
    }
    expect(taskKeysFor(input)).toEqual(['AB-1'])
    // ...and the table still draws all three rows, so this is de-duplication of the QUESTION and
    // never of the display.
    expect(drawnKeys(input)).toEqual(['AB-1', 'AB-1', 'AB-1'])
  })

  it('asks nothing at all when there is nothing to ask about', () => {
    // The `keys.length === 0` early return in `readTaskTitles` (lib/commands/status.js) is what
    // keeps a github-shaped or brand-new run from spawning acli, and it depends on this being
    // `[]` rather than a list of nulls. Called with no argument at all as well, because the
    // sidecar callers in this repo do that.
    expect(taskKeysFor()).toEqual([])
    expect(taskKeysFor({})).toEqual([])
    expect(taskKeysFor({ metricsText: null, record: null })).toEqual([])
    expect(taskKeysFor({ metricsText: 'not jsonl at all', record: record() })).toEqual([])
    // A pure-github run: rows exist, and none of them names a ticket.
    expect(taskKeysFor({ metricsText: TWO_CLOSED, record: record() })).toEqual([])
  })

  it('caps each key at the table’s title width, which is what bounds the JQL it builds', () => {
    // The bound worth measuring, because it is the one that is not written down as a constant.
    // `MAX_TITLE_KEYS` in lib/jira-queue.js caps how MANY keys one query names and not how LONG
    // the query is (measured from that side in lib/jira-queue.qa.test.js: 32 keys of 502
    // characters build a 16158-character `--jql`). What closes it is HERE: `taskKeyOf` scrubs the
    // recorded key through `cleanTitle`, which truncates to TITLE_CODE_POINT_LIMIT, so a
    // megabyte of project key in issues.jsonl reaches acli as 24 code points.
    //
    // Measured: a 1 MB key comes back as 23 `P`s and an ellipsis. It is also no longer a key the
    // grammar accepts, so `titlesFor` drops it before building a query — the truncation makes the
    // row unresolvable rather than expensive, which is the right way round for a courtesy title.
    const huge = 'P'.repeat(1000000) + '-1'
    const keys = taskKeysFor({
      metricsText: jsonl({ ...event({ number: 1, ts: 1 }), task_key: huge }),
      record: record(),
    })
    expect(keys).toHaveLength(1)
    expect([...keys[0]]).toHaveLength(24)
    expect(keys[0].endsWith(cp(0x2026))).toBe(true)
    // Nine such keys — the most a table can ask about — stay well inside anything acli minds.
    expect(keys[0].length * 9).toBeLessThan(1000)
  })

  it('asks about the in-flight ticket LAST, and only when the record names one', () => {
    // Order is the contract `titles` verb output and the `--limit` both read, and the in-flight
    // row is the last line of the table — so the query reads in the same order the screen does.
    const input = runOf(2, true)
    expect(taskKeysFor(input)).toEqual(['AB-1', 'AB-2', 'AB-99'])
    // An in-flight ticket already closed once in this run is not asked about twice.
    expect(
      taskKeysFor({
        metricsText: jsonl({ ...event({ number: 99, ts: 1 }), task_key: 'AB-99' }),
        record: record({
          current: { number: 99, started_at: TASK_STARTED.toISOString(), task_key: 'AB-99' },
        }),
      }),
    ).toEqual(['AB-99'])
  })
})

describe('renderTaskTable — two spellings of one ticket in one log (#132 QA)', () => {
  // issues.jsonl is APPEND-ONLY for the life of a repo and nothing normalizes `task_key` on the
  // way in: lib/issue-event.js records the key it was handed, `taskKeyOf` scrubs it but does not
  // upper-case it, and `usableJiraKey` only normalizes what the grammar recognises — so an event
  // whose key was typed by hand, or written by a caller that passed the board's own lowercase
  // slug, sits beside one that was not. Both are drawn, because `numberText` renders `task.key`
  // verbatim.
  const TWO_SPELLINGS = {
    metricsText: jsonl(
      { ...event({ number: 1, ts: 1 }), task_key: 'foo-1' },
      { ...event({ number: 1, ts: 2 }), task_key: 'FOO-1' },
    ),
    record: record({
      current: { number: 2, started_at: TASK_STARTED.toISOString(), iteration: 1, task_key: 'FOO-2' },
    }),
  }

  it('draws BOTH spellings as their own row, verbatim', () => {
    // The renderer's half of the story, and it is correct: the table shows a reader exactly the
    // text the log recorded, which is the only honest thing it can do with two spellings.
    expect(taskKeysFor(TWO_SPELLINGS)).toEqual(['foo-1', 'FOO-1', 'FOO-2'])
    const lines = renderTaskTable(
      buildProgress({ ...TWO_SPELLINGS, queue: 6, now: NOW, titles: {} }),
    )
    expect(lines[1]).toContain('foo-1')
    expect(lines[2]).toContain('FOO-1')
    expect(aligned(lines), lines.join('\n')).toBe(true)
  })

  it('titles each row from the map entry that NAMES it, and asks for nothing else', () => {
    // The renderer is correct here and this pins it correct: a row's handle is its own text, so
    // given a map that answers for both spellings, both rows are titled. `lookupTitle` does NOT
    // normalize — deliberately, since it has no idea the handle is a Jira key rather than a
    // folder name — so the responsibility for making one ticket's summary reachable under every
    // spelling it was ASKED about belongs to the resolver.
    //
    // THE RESOLVER DID NOT DO THAT, and the defect was measured and reddened where it lives:
    // `titlesFor` in lib/jira-queue.js keyed its answer by the FIRST spelling only, so it
    // returned `{ 'foo-1': …, 'FOO-2': … }` for these three keys and the middle row rendered
    // blank. It now keys every spelling it was asked, pinned by `lib/jira-queue.qa.test.js` >
    // "answers for EVERY spelling of a ticket the caller asked about" and, through the real
    // resolver, by `lib/commands/status.qa.test.js`. Nothing in THIS test changed when it was
    // fixed — which was the point of writing it against a hand-built map.
    const titles = { 'foo-1': 'one ticket', 'FOO-1': 'one ticket', 'FOO-2': 'two' }
    const snapshot = buildProgress({ ...TWO_SPELLINGS, queue: 6, now: NOW, titles })
    expect(snapshot.tasks.map((task) => task.title)).toEqual(['one ticket', 'one ticket', 'two'])
    const lines = renderTaskTable(snapshot)
    expect(lines[1]).toContain('foo-1 one ticket')
    expect(lines[2]).toContain('FOO-1 one ticket')
    expect(aligned(lines), lines.join('\n')).toBe(true)
  })
})
