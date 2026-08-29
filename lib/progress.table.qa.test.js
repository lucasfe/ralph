import { describe, expect, it } from 'vitest'
import { buildProgress, renderProgressLine, renderTaskTable } from './progress.js'
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
