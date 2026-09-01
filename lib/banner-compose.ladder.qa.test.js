// #72 QA — adversarial specs for the DEGRADATION LADDER, kept beside
// banner-compose.qa.test.js (#68's) and banner-compose.whats-new.qa.test.js (#70's)
// rather than inside either: those files attack the box that #68 designed and the list
// #70 added to it, and both were written when a narrow terminal simply got a narrower
// box. #72 replaced that with a LADDER — full box at 60, shrunken box down to 44, bare
// `key   value` rows down to 26, and no sprite at all below it — which adds two seams
// neither of those files describes.
//
//   * THE RUNGS THEMSELVES, as a total function. `bannerLayout` is now the only place
//     either threshold is read (lib/sprite-banner.js asks it rather than holding a 26),
//     so every claim the banner makes about a width is downstream of four fields. What
//     matters is not only that 44 and 26 are the numbers, but that the two rungs are
//     ORDERED and MONOTONE: the box gives way first and the sprite last, so there must be
//     no width anywhere at which the frame is drawn around rows the sprite has already
//     abandoned, and no width at which growing the terminal by one column takes something
//     away. Those are properties of the whole domain, so they are swept rather than
//     tabulated — the table pins the boundaries, the sweep pins the shape between them.
//   * THE BARE FORM, which is NEW SURFACE. The boxed form has been hardened twice over:
//     its frame is its own delimiter at both ends, its rows are padded to a known width,
//     and every hostile-fact spec in this directory was written against it. The bare form
//     has no frame to hide behind. Its `paintFrom` is 8 rather than 10, so the widths
//     where an escape sequence can be cut in half are 1–9 instead of 1–11; it pads to
//     nothing, so a trailing space is a defect rather than a border; and it is the form a
//     12-column terminal actually gets, where the whole line is label gutter. So the four
//     things a log file cannot survive are asserted at EVERY width in that range: never a
//     blank line, never a trailing space, never a newline, and never half an escape.
//
// And the claim that is the whole point of the issue, asserted last and exhaustively:
// INFORMATION PARITY. Dropping the frame must change how much ink is around the facts and
// nothing else, so for every width the bare form is required to carry the same rows, in
// the same order, each one a prefix of what the 60-column box says — including #70's
// bullets and its `more` pointer, which is exactly the section that would vanish
// unnoticed, since every width and escape assertion above passes just as happily on a
// banner that quietly stopped mentioning the release.
//
// TWO GLYPHS THAT ARE NOT THE SAME GLYPH, and the reason a regex here is written from
// code points rather than from a copy-paste: the frame's rule is U+2500 BOX DRAWINGS
// LIGHT HORIZONTAL and the update hint contains U+2014 EM DASH. They are a pixel apart on
// screen and conflating them would make every "no frame survived" claim below fail on a
// line whose only crime is naming a version.
//
// Widths, escapes and glyphs are spelled out rather than imported, so an expectation here
// cannot agree with a typo in the implementation's own constants. Nothing in this file
// reads an ambient environment, a clock or a real file (#41).

import { describe, expect, it } from 'vitest'
import {
  BANNER_WIDTH,
  BOX_MIN_WIDTH,
  SPRITE_MIN_WIDTH,
  bannerLayout,
  composeBanner,
} from './banner-compose.js'

const ESC = '\u001B'
const YELLOW = `${ESC}[33m`
const YELLOW_OFF = `${ESC}[39m`
// Every SGR sequence, not just the two above: an assertion that only knows the codes the
// implementation currently emits cannot catch it emitting a different one.
const SGR = /\u001B\[[0-9;]*m/g

// The control code points a fact can carry out of a path, a package.json or a committed
// changelog, each named for what it does to a terminal rather than for its number.
const LF = '\n'
const CR = '\r'
const NUL = '\u0000'
const DEL = '\u007F'
// U+009B: a one-byte CSI introducer, i.e. the escape attack without an ESC to grep for.
const C1_CSI = '\u009B'
// U+0085 NEL, the C1 block's own line break.
const NEL = '\u0085'
const PLACEHOLDER = '\uFFFD'

// The box's own six glyphs, as code points. NOT the em dash — see the header.
const FRAME = /[╭╮╰╯│─]/

const VERSION = '0.22.0'
const CWD = '/repo/deep/enough'
const POINTER = 'run `ralph changelog` for the rest'

// The label gutter, which the module keeps private and this file can only observe: eight
// columns, so `content.slice(0, 8)` is the label and everything after it is the fact.
const GUTTER = 8

const stripAnsi = (line) => line.replace(SGR, '')
/** Code points, which is the measure the module pads, clips and promises in. */
const visibleWidth = (line) => [...stripAnsi(line)].length

const compose = (facts = {}, options = {}) =>
  composeBanner({ facts: { version: VERSION, cwd: CWD, ...facts }, ...options })

// The facts every sweep below runs with: an update hint (the one painted row), a path
// deep enough to be clipped at every rung, and #70's section at its three-bullet cap plus
// the pointer — which together are the SEVEN rows that have to survive the unboxing.
const FACTS = {
  version: VERSION,
  latestVersion: '9.9.9',
  cwd: CWD,
  whatsNew: ['one', 'two', 'three', 'four'],
}

// Every width at which the frame is gone: the rung itself, the columns either side of the
// sprite's rung, and the degenerate ones where the whole line is label gutter.
const BARE_WIDTHS = [43, 40, 30, 27, 26, 25, 20, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]

// The widths where the bare form's `paintFrom` of 8 lands inside or past the clip, which
// is the whole interesting range for escape integrity — nine columns is where the first
// column of a painted value survives being cut.
const PAINT_BOUNDARY_WIDTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]

/**
 * The escape-integrity invariant, asserted on one line.
 *
 * Every ESC byte must begin a complete SGR sequence, the sequences must pair up as one
 * open followed by one close, and the pair must be the yellow the module claims to use.
 * That rules out the four ways a clip can corrupt a painted line: a truncated `[3`, a
 * lone `[39m` reset with nothing opened, an opener whose closer the clip removed, and an
 * empty `[33m[39m` pair — still bytes in a log file and still a reset for a terminal to
 * act on.
 */
function expectEscapesBalanced(line, context) {
  const sequences = line.match(SGR) ?? []
  // Every ESC in the line accounted for by a COMPLETE sequence — the check that fails on
  // a half escape, where `match` finds fewer sequences than there are ESC bytes.
  expect([...line].filter((glyph) => glyph === ESC), context).toHaveLength(sequences.length)
  if (sequences.length === 0) return
  expect(sequences, context).toEqual([YELLOW, YELLOW_OFF])
  expect(line.indexOf(YELLOW), context).toBeLessThan(line.indexOf(YELLOW_OFF))
  expect(line, context).not.toContain(`${YELLOW}${YELLOW_OFF}`)
}

/**
 * The four things a BARE line cannot be, whatever it was asked to say.
 *
 * Blank, because `out('')` puts an empty row in a log file and a banner that degraded
 * into whitespace would satisfy every width claim in this file on the emptiness alone.
 * Padded, because a bare line has no right border to reach and trailing spaces are noise
 * in a scrollback. Multi-line, because `out()` appends the newline itself, so a returned
 * string containing one is two terminal rows and the second is covered by no guarantee.
 * And wider than asked, which is the issue's own criterion.
 */
function expectBareLineHolds(line, width, context) {
  expect(visibleWidth(line), context).toBeLessThanOrEqual(width)
  expect(line, context).not.toBe('')
  expect(stripAnsi(line).trim(), context).not.toBe('')
  expect(line, context).toBe(line.trimEnd())
  expect(line, context).not.toContain(LF)
  expect(line, context).not.toContain(CR)
  expect(line, context).not.toContain(NEL)
  expect(line, context).not.toContain(C1_CSI)
}

/** The bare form's label→value pairs: no frame to strip, the line IS the content. */
const barePairs = (lines) =>
  lines.slice(1).map((line) => {
    const content = stripAnsi(line)
    return [content.slice(0, GUTTER).trim(), content.slice(GUTTER)]
  })

/** The boxed form's, with `│ `, ` │` and the padding that lines the border up taken off. */
const boxedPairs = (lines) =>
  lines.slice(1, -1).map((line) => {
    const content = stripAnsi(line).slice(2, -2)
    return [content.slice(0, GUTTER).trim(), content.slice(GUTTER).trimEnd()]
  })

describe('QA bannerLayout — the two rungs, at the column either side of each (#72)', () => {
  // THE BOUNDARIES, one row per width, and every width here is a rung or its neighbour.
  // Spelled out in full rather than derived, so these are the issue's acceptance criteria
  // read off a table and not the implementation's own `Math.min` and `>=` restated.
  //
  // #161 ADDED A THIRD RUNG and therefore two more columns: `beside` is whether the box may
  // sit to the RIGHT of the sprite instead of under it, and `besideWidth` the width it would
  // be laid out at there. 72 and 71 are its boundary pair — 26 cells of sprite, two of air
  // and a 44-column framed box — and the ten widths that were already here all sit under it,
  // where `besideWidth` is a leftover nobody spends and zero once the sprite has eaten the
  // terminal. Stated at every width anyway, so this table pins the whole answer.
  const BOUNDARIES = [
    [73, 60, true, true, true, 45],
    [72, 60, true, true, true, 44],
    [71, 60, true, true, false, 43],
    [61, 60, true, true, false, 33],
    [60, 60, true, true, false, 32],
    [59, 59, true, true, false, 31],
    [45, 45, true, true, false, 17],
    [44, 44, true, true, false, 16],
    [43, 43, false, true, false, 15],
    [27, 27, false, true, false, 0],
    [26, 26, false, true, false, 0],
    [25, 25, false, false, false, 0],
    [24, 24, false, false, false, 0],
  ]

  for (const [width, boxWidth, boxed, sprite, beside, besideWidth] of BOUNDARIES) {
    it(`decides ${width} columns as boxWidth ${boxWidth}, boxed ${boxed}, sprite ${sprite}, beside ${beside}`, () => {
      expect(bannerLayout(width)).toEqual({ width, boxWidth, boxed, sprite, beside, besideWidth })
    })
  }

  it('states its two rungs in the order the ladder needs them', () => {
    // The ORDER is the load-bearing part, not the numbers. Whenever the two blocks are
    // STACKED — every terminal too narrow for #161's arrangement — each of them has the whole
    // width to itself, which makes the sprite the narrow element (26 cells, its own width) and
    // the box the wide one (a 60-column target). So the frame must be the first thing to go and
    // the sprite the last — and if these two constants ever crossed, a 30-column terminal would
    // draw a 30-column frame around rows under a sprite it could not fit, which is the one
    // arrangement the ladder exists to forbid.
    expect(SPRITE_MIN_WIDTH).toBeLessThan(BOX_MIN_WIDTH)
    expect(BOX_MIN_WIDTH).toBeLessThanOrEqual(BANNER_WIDTH)
    // ...and #161's rung is above BOTH of them, which is what makes it an arrangement rather
    // than a degradation: there is no width at which the box sits beside a sprite that is not
    // drawn, or beside one without a frame of its own.
    for (let width = 1; width <= 300; width += 1) {
      const layout = bannerLayout(width)
      expect(!layout.beside || (layout.sprite && layout.boxed), `width ${width}`).toBe(true)
    }
  })

  it('never draws a frame at a width the sprite was refused, anywhere in the domain', () => {
    // The ordering above as a claim about the FUNCTION rather than about its constants: a
    // future edit could keep both numbers and still swap the comparisons. Swept over every
    // column count a terminal can report plus the fallback, because "boxed implies sprite"
    // is not a boundary property — it is true or false everywhere at once.
    for (let width = 1; width <= 300; width += 1) {
      const layout = bannerLayout(width)
      expect(layout.boxed && !layout.sprite, `width ${width}`).toBe(false)
    }
    expect(bannerLayout().boxed && !bannerLayout().sprite).toBe(false)
  })

  it('never takes something away for growing the terminal by one column', () => {
    // MONOTONE, which is the property a reader assumes without being told: widening a
    // window may add the frame back and may add the sprite back, and may never remove
    // either. An inverted comparison or a `<=`/`>=` slip on one rung shows up here as a
    // regression at exactly one width, which no boundary table would notice unless it
    // happened to hold that width.
    let boxed = false
    let sprite = false
    for (let width = 1; width <= 300; width += 1) {
      const layout = bannerLayout(width)
      expect(!(boxed && !layout.boxed), `boxed regressed at ${width}`).toBe(true)
      expect(!(sprite && !layout.sprite), `sprite regressed at ${width}`).toBe(true)
      boxed = layout.boxed
      sprite = layout.sprite
    }
  })

  it('lays the rows out inside the terminal and never past it, at every width', () => {
    // `boxWidth` is what the rows are LAID OUT at and `width` is what they are finally held
    // to, so the one relation that must never break is `boxWidth <= width`. It is also the
    // 60-column cap, which is what keeps a 200-column terminal from getting a rule nobody
    // can follow.
    for (let width = 1; width <= 300; width += 1) {
      const layout = bannerLayout(width)
      expect(layout.width, `width ${width}`).toBe(width)
      expect(layout.boxWidth, `width ${width}`).toBe(Math.min(width, BANNER_WIDTH))
      expect(layout.boxWidth, `width ${width}`).toBeLessThanOrEqual(layout.width)
    }
  })

  it('reads a width without coercing one, so a hostile bag cannot run code', () => {
    // `typeof width !== 'number'` is a REFUSAL, not a conversion, and the difference
    // matters because this argument arrives from `stdout.columns` — a property of an object
    // a caller supplied. `Number(width)` or a `>=` against a non-number would run
    // `valueOf` on whatever that object is, which is arbitrary code on the first line
    // `ralph start` writes. Asserted by TRIPWIRE rather than by the returned layout: an
    // object whose `valueOf` returned 30 would make an output-only assertion pass while the
    // trap had already fired.
    const tripped = []
    const spy = {
      valueOf() {
        tripped.push('valueOf')
        return 30
      },
      toString() {
        tripped.push('toString')
        return '30'
      },
      [Symbol.toPrimitive]() {
        tripped.push('toPrimitive')
        return 30
      },
    }
    expect(bannerLayout(spy)).toEqual(bannerLayout(BANNER_WIDTH))
    expect(compose({}, { width: spy })).toEqual(compose({}, { width: BANNER_WIDTH }))
    expect(tripped).toEqual([])
  })

  it('falls back for the number-shaped values that are not numbers', () => {
    // A bigint, a boxed Number and a Symbol are each one `typeof` away from passing for a
    // width, and two of them would throw inside `Math.floor` or a comparison. All three
    // take the documented default instead.
    for (const width of [20n, 60n, new Number(20), new Number(60), Symbol('20')]) {
      expect(() => bannerLayout(width)).not.toThrow()
      expect(bannerLayout(width), String(width.toString())).toEqual(bannerLayout(BANNER_WIDTH))
    }
  })

  it('caps a width no terminal has rather than composing one', () => {
    // The far end of the domain, and the reason it is worth a case: `boxWidth` feeds
    // `RULE.repeat()`, so a width that reached it unclamped would either throw
    // (`Invalid string length`) or allocate a rule of a million columns on the first line
    // of a run. The cap is what makes this a 60-column box on every terminal above 60.
    for (const width of [1e6, 2 ** 31, Number.MAX_SAFE_INTEGER, 1e21]) {
      expect(bannerLayout(width), String(width)).toEqual({
        width: Math.floor(width),
        boxWidth: BANNER_WIDTH,
        boxed: true,
        sprite: true,
        // #161: capped at the same target and for the same reason — a box laid out at a
        // million columns beside the sprite would reach the same `repeat` from the other side.
        beside: true,
        besideWidth: BANNER_WIDTH,
      })
      const lines = composeBanner({ facts: FACTS, width, capabilities: { color: true } })
      expect(new Set(lines.map(visibleWidth)), String(width)).toEqual(new Set([BANNER_WIDTH]))
    }
  })

  it('hands back a fresh decision each time, which a caller may keep or clobber', () => {
    // Two callers read this — the box and the sprite gate — inside one run, so a shared or
    // memoised object would let the first one's bookkeeping change the second one's answer.
    const first = bannerLayout(30)
    const second = bannerLayout(30)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    first.boxed = true
    first.boxWidth = 999
    expect(bannerLayout(30)).toEqual({
      width: 30,
      boxWidth: 30,
      boxed: false,
      sprite: true,
      beside: false,
      besideWidth: 2,
    })
  })

  it('decides with Date, Math.random and process trip-wired', () => {
    // The ladder is arithmetic on one argument, and this is the assertion that keeps it
    // that way: no clock, no environment, no `stdout.columns` read of its own. A static
    // read of banner-compose.js cannot make this claim, because the module it imports
    // (update-check.js, behind banner-rows.js) defaults `processEnv` to the real `process.env`.
    const realDate = globalThis.Date
    const realRandom = Math.random
    const realProcess = globalThis.process
    const tripwire = (name) => () => {
      throw new Error(`bannerLayout touched ${name}`)
    }
    let answers
    try {
      globalThis.Date = tripwire('Date')
      Math.random = tripwire('Math.random')
      globalThis.process = new Proxy(
        {},
        {
          get(_target, property) {
            throw new Error(`bannerLayout read process.${String(property)}`)
          },
        },
      )
      answers = [bannerLayout(60), bannerLayout(30), bannerLayout(25), bannerLayout()]
    } finally {
      globalThis.Date = realDate
      Math.random = realRandom
      globalThis.process = realProcess
    }
    expect(answers.map((layout) => [layout.boxed, layout.sprite])).toEqual([
      [true, true],
      [false, true],
      [false, false],
      [true, true],
    ])
  })
})

describe('QA composeBanner — the bare form at widths where the line is all gutter (#72)', () => {
  it('returns a line a terminal can print, at every width the frame is gone', () => {
    // The four things a bare line cannot be, swept over the whole bare range with colour
    // both off and on. Eight columns is the label gutter exactly, so at 8 and below there
    // is no room for one glyph of any fact — and the module still may not hand back a
    // blank row, an empty string or a padded one.
    for (const width of BARE_WIDTHS) {
      for (const color of [false, true]) {
        const lines = composeBanner({ facts: FACTS, width, capabilities: { color } })
        const why = `width ${width} color ${color}`
        expect(lines.length, why).toBeGreaterThan(0)
        for (const line of lines) {
          expectBareLineHolds(line, width, `${why}: ${JSON.stringify(line)}`)
        }
      }
    }
  })

  it('says “there is more here” rather than nothing, at eight columns and below', () => {
    // The degenerate end, pinned as what it actually renders: at these widths every row is
    // label gutter and the clip marker, and the marker is the whole message — a reader who
    // sees it knows the line continues past their terminal. What must NOT happen is the
    // alternative a naive clip produces: `''` for a width smaller than the label, which
    // `out()` would turn into a blank row per fact.
    for (const width of [8, 7, 6, 5, 4, 3, 2, 1]) {
      const lines = composeBanner({ facts: FACTS, width, capabilities: { color: true } })
      const why = `width ${width}`
      // Seven rows either way: the title, the hint, the cwd, three bullets and the pointer.
      expect(lines, why).toHaveLength(7)
      for (const line of lines) {
        expect(visibleWidth(line), `${why}: ${JSON.stringify(line)}`).toBe(width)
        expect(line.endsWith('…'), `${why}: ${JSON.stringify(line)}`).toBe(true)
      }
    }
  })

  it('drops the frame and only the frame, so the row count differs by exactly one', () => {
    // The bottom rule is a piece of the frame and leaves with it, so a bare banner is
    // exactly one line shorter than a boxed one — never two (a title folded away), never
    // the same (an orphan rule with no border above it to close). Swept over every width
    // rather than sampled, because the row list is built before the form is chosen and a
    // conditional that crept into a builder would show up at one width only.
    const boxedRows = composeBanner({ facts: FACTS, width: BANNER_WIDTH }).length
    for (let width = 1; width <= 70; width += 1) {
      const lines = composeBanner({ facts: FACTS, width })
      expect(lines.length, `width ${width}`).toBe(bannerLayout(width).boxed ? boxedRows : boxedRows - 1)
    }
  })

  it('leaves no glyph of the frame behind at any width below 44', () => {
    // Not a torn corner, not a lone side, not an orphan rule. Asserted with CLEAN facts
    // only, deliberately: a hostile bullet may legitimately contain a `│` (see the
    // hostile block below, and #70's QA file, which makes the same carve-out), so this
    // claim belongs to the width and not to the sanitiser.
    for (const width of BARE_WIDTHS) {
      const lines = composeBanner({ facts: FACTS, width, capabilities: { color: true } })
      for (const line of lines) {
        expect(stripAnsi(line), `width ${width}: ${JSON.stringify(line)}`).not.toMatch(FRAME)
      }
    }
    // ...and the em dash in the hint is NOT a rule, which is the assertion that proves the
    // one above is testing the frame rather than passing on a typo.
    const hinted = compose({ latestVersion: '9.9.9' }, { width: 43 })
    expect(hinted.join('\n')).toContain('—')
    expect(hinted.join('\n')).not.toContain('─')
  })
})

describe('QA composeBanner — escape integrity in the bare form (#72)', () => {
  it('paints a balanced pair or not one escape byte, at every bare width', () => {
    // The clip-then-paint ordering, asserted where the bare form moved it. `paintFrom` is
    // 8 here rather than the box's 10, so the widths at which the clip lands inside the
    // painted range are 1–9 — a range #68's QA sweep steps straight over (its narrowest
    // cases are 8, 5, 2 and 1) because at those widths the boxed form was still being
    // measured against a frame that no longer exists.
    for (const width of [...BARE_WIDTHS, ...PAINT_BOUNDARY_WIDTHS]) {
      const lines = composeBanner({ facts: FACTS, width, capabilities: { color: true } })
      for (const line of lines) {
        expectEscapesBalanced(line, `width ${width}: ${JSON.stringify(line)}`)
      }
      // At most one painted line: the hint is the only advice in the box, in either form.
      expect(lines.filter((line) => line.includes(ESC)).length, `width ${width}`).toBeLessThanOrEqual(1)
    }
  })

  it('opens no sequence until a column of the value survives the clip', () => {
    // THE EXACT RUNG, which is a consequence of the gutter and not of a constant anybody
    // wrote down: the value starts at column 8, so at eight columns and below the clip ends
    // where the paint would begin and the line must be plain text. At nine the first
    // painted column exists and the pair opens. Both directions are pinned because the
    // failure modes differ — below the rung a lone reset or an empty pair, at the rung an
    // opener whose closer was clipped off.
    for (const width of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const lines = composeBanner({ facts: FACTS, width, capabilities: { color: true } })
      expect(lines.join('\n'), `width ${width}`).not.toContain(ESC)
    }
    for (const width of [9, 10, 11, 12, 20, 30, 43]) {
      const lines = composeBanner({ facts: FACTS, width, capabilities: { color: true } })
      const painted = lines.filter((line) => line.includes(ESC))
      expect(painted, `width ${width}`).toHaveLength(1)
      expectEscapesBalanced(painted[0], `width ${width}`)
    }
  })

  it('paints the value’s own columns and never the label that introduces it', () => {
    // `frame.indent` is what makes one row builder serve both forms, and this is the claim
    // it exists for: with no `│ ` in front of the gutter the value starts two columns
    // earlier, so an offset left at the boxed value's 10 would colour the last two letters
    // of `update` yellow at every bare width. Asserted as a statement about the PREFIX,
    // which is the part an off-by-two moves.
    for (const width of [9, 10, 12, 20, 26, 30, 43]) {
      const lines = composeBanner({ facts: FACTS, width, capabilities: { color: true } })
      const row = lines.find((line) => line.includes(ESC))
      const why = `width ${width}: ${JSON.stringify(row)}`
      expect(row.slice(0, row.indexOf(YELLOW)), why).toBe(stripAnsi(row).slice(0, GUTTER))
      expect(row.slice(0, GUTTER), why).toBe('update  ')
      // ...and the sequence closes at the end of the row, since the value runs to the clip.
      expect(row.endsWith(YELLOW_OFF), why).toBe(true)
    }
  })

  it('changes not one visible glyph by being painted, at every bare width', () => {
    // The escapes are invisible, so stripping them must return the plain render exactly —
    // which is also what keeps the width guarantee true in colour, since `visibleWidth`
    // above is the only measure either form is held to.
    for (const width of [...BARE_WIDTHS, ...PAINT_BOUNDARY_WIDTHS]) {
      const plain = composeBanner({ facts: FACTS, width, capabilities: { color: false } })
      const painted = composeBanner({ facts: FACTS, width, capabilities: { color: true } })
      expect(painted.map(stripAnsi), `width ${width}`).toEqual(plain)
    }
  })
})

describe('QA composeBanner — hostile facts in the bare form (#72)', () => {
  // The bare form's inputs are the boxed form's inputs, but the boxed form has a frame at
  // both ends of every line and this one does not — so the same fact that could only ever
  // corrupt the inside of a box can now become the WHOLE line. Each case below is a fact a
  // caller can genuinely hand over: a POSIX path may contain a newline (`mkdir $'a\nb'`),
  // a version comes out of a package.json, and a bullet is committed markdown nobody reads
  // as bytes.
  const HOSTILE = [
    ['a newline in the cwd', { cwd: '/a\n/b' }],
    ['a carriage return in the cwd', { cwd: '/a\r/b' }],
    ['a CRLF in the cwd', { cwd: '/a\r\n/b' }],
    ['an ESC in the cwd', { cwd: `/a${ESC}[31m/b` }],
    ['a C1 CSI in the cwd', { cwd: `/a${C1_CSI}31m/b` }],
    ['a NEL in the cwd', { cwd: `/a${NEL}/b` }],
    ['a DEL in the cwd', { cwd: `/a${DEL}/b` }],
    ['a NUL in the cwd', { cwd: `/a${NUL}/b` }],
    ['an ESC at the clip boundary', { cwd: `${'x'.repeat(46)}${ESC}[31m` }],
    ['a newline in the version', { version: '1.0.0\n╭─ forged' }],
    ['an ESC in the version', { version: `1.0.0${ESC}[31m` }],
    ['a newline in a bullet', { whatsNew: ['one\ntwo'] }],
    ['an ESC in a bullet', { whatsNew: [`fix${ESC}[31m red`] }],
    ['a C1 CSI in a bullet', { whatsNew: [`${C1_CSI}2J wiped your screen`] }],
    ['a bullet that forges a bare row', { whatsNew: ['cwd     /somewhere/else'] }],
    ['a bullet that forges a boxed row', { whatsNew: ['│ cwd     /elsewhere │'] }],
    ['a bullet that forges a bottom rule', { whatsNew: [`╰${'─'.repeat(58)}╯`] }],
  ]

  for (const [name, extra] of HOSTILE) {
    it(`holds every guarantee with ${name}, at every bare width`, () => {
      // No "no frame glyph" claim in this loop, deliberately: two of the bullets above ARE
      // frame glyphs, and that is legitimate — a bullet is text, and text is what the row
      // says. What must hold is everything a terminal or a log file cannot recover from.
      for (const width of BARE_WIDTHS) {
        for (const color of [false, true]) {
          const lines = composeBanner({
            facts: { ...FACTS, ...extra },
            width,
            capabilities: { color },
          })
          const why = `${name} width ${width} color ${color}`
          expect(lines.length, why).toBeGreaterThan(0)
          for (const line of lines) {
            expectBareLineHolds(line, width, `${why}: ${JSON.stringify(line)}`)
            expect(line, why).not.toContain(NUL)
            expect(line, why).not.toContain(DEL)
            if (!color) expect(line, why).not.toContain(ESC)
          }
        }
      }
    })
  }

  it('replaces a control byte rather than deleting it, in the bare form too', () => {
    // The same argument lib/progress.js makes for facts in general: `/a\nb` stripped reads
    // as `/ab`, a directory that does not exist, so the banner would be lying about where
    // it is running. A placeholder says "there is a character here you cannot see", and it
    // is one code point in for one code point out, so the width accounting stays exact.
    const lines = compose({ cwd: `/a${LF}${CR}${ESC}${C1_CSI}${DEL}/b` }, { width: 43 })
    const row = lines.find((line) => line.startsWith('cwd'))
    expect(row).toBe(`cwd     /a${PLACEHOLDER.repeat(5)}/b`)
    expect(visibleWidth(row)).toBe(GUTTER + 9)
  })

  it('never runs a fact’s toString or valueOf, at any bare width', () => {
    // `'• ' + bullet` is the one concatenation in the module that happens before the row
    // gate sees a value, and the bare form reaches it through a different `frame` — so the
    // refusal is re-asserted here rather than assumed from #68's boxed case. By TRIPWIRE,
    // because an object whose `toString` returned a plausible path would make an
    // output-only assertion pass while the trap had already fired.
    const tripped = []
    const trap = (name) => ({
      toString() {
        tripped.push(`${name}.toString`)
        return 'INJECTED'
      },
      valueOf() {
        tripped.push(`${name}.valueOf`)
        return 'INJECTED'
      },
      [Symbol.toPrimitive]() {
        tripped.push(`${name}.toPrimitive`)
        return 'INJECTED'
      },
    })
    for (const width of BARE_WIDTHS) {
      const lines = composeBanner({
        facts: {
          version: trap('version'),
          latestVersion: trap('latest'),
          cwd: trap('cwd'),
          whatsNew: [trap('bullet')],
        },
        width,
        capabilities: { color: true },
      })
      expect(lines.join('\n'), `width ${width}`).not.toContain('INJECTED')
      expect(lines.join('\n'), `width ${width}`).not.toContain(ESC)
      // Every fact unusable, so the bare form is the title and one `unknown` cwd — and it
      // still says which row is which rather than collapsing to nothing.
      if (width >= 20) {
        expect(lines, `width ${width}`).toEqual([`ralph unknown`, `cwd     unknown`])
      }
    }
    expect(tripped).toEqual([])
  })

  it('keeps the code-point guarantee over wide glyphs and surrogate pairs, unboxed', () => {
    // Display width is out of scope by design (an East Asian glyph counts as one column
    // here and occupies two cells), but the guarantee actually made — code points — is not,
    // and the bare form is where a clip has the fewest columns to get it wrong in. A lone
    // surrogate is a replacement character on screen, and it is the only thing a clip can
    // produce by measuring in UTF-16 units somewhere.
    const paths = [
      `/${'中文目録/'.repeat(20)}`,
      `/${'\u{1F600}'.repeat(60)}`,
      `/${'\u{1F1E7}\u{1F1F7}'.repeat(20)}`,
      `/${'\u{10FFFF}'.repeat(30)}`,
    ]
    for (const cwd of paths) {
      for (const width of BARE_WIDTHS) {
        const lines = composeBanner({
          facts: { ...FACTS, cwd },
          width,
          capabilities: { color: true },
        })
        for (const line of lines) {
          const why = `${JSON.stringify(cwd.slice(0, 12))} @ ${width}`
          expectBareLineHolds(line, width, why)
          for (const glyph of [...line]) {
            const code = glyph.codePointAt(0)
            expect(code < 0xd800 || code > 0xdfff, `${why}: ${JSON.stringify(line)}`).toBe(true)
          }
        }
      }
    }
  })

  it('does not mutate a frozen facts bag or the bullet list inside it', () => {
    // A defensive caller freezes what it hands over, and `whatsNewRows` iterates that
    // array. A `sort`, a `splice` or a write-back would throw on a frozen array in strict
    // mode — which every module is — so this is a claim about the run surviving as much as
    // about the caller's data.
    const whatsNew = Object.freeze(['one', 'two', 'three', 'four'])
    const facts = Object.freeze({ version: VERSION, latestVersion: '9.9.9', cwd: CWD, whatsNew })
    for (const width of BARE_WIDTHS) {
      expect(() => composeBanner({ facts, width, capabilities: { color: true } })).not.toThrow()
    }
    expect(whatsNew).toEqual(['one', 'two', 'three', 'four'])
    expect(facts.cwd).toBe(CWD)
  })

  it('is a function of its arguments alone in the bare form: two calls, identical bytes', () => {
    // Determinism at the rung, and a FRESH array each time — `ralph start` iterates the
    // result, but #75/#76 will hand it to `ralph doctor` and `ralph status`, which may keep
    // or splice it.
    for (const width of BARE_WIDTHS) {
      const first = composeBanner({ facts: FACTS, width, capabilities: { color: true } })
      const second = composeBanner({ facts: FACTS, width, capabilities: { color: true } })
      expect(first, `width ${width}`).toEqual(second)
      expect(first, `width ${width}`).not.toBe(second)
      first[0] = 'CLOBBERED'
      expect(composeBanner({ facts: FACTS, width })[0], `width ${width}`).not.toBe('CLOBBERED')
    }
  })
})

describe('QA composeBanner — information parity, boxed 60 against every width (#72)', () => {
  // The claim the whole issue rests on: unboxing changes how much ink is around the facts
  // and NOTHING ELSE. Every width assertion in this file passes just as happily on a
  // banner that quietly stopped mentioning the release, so parity is asserted separately
  // and exhaustively — same rows, same order, each value a prefix of what the 60-column
  // box says.
  const FULL = boxedPairs(composeBanner({ facts: FACTS, width: BANNER_WIDTH }))
  // The 60-column box's rows with the frame taken off and the padding that reached it
  // trimmed — i.e. exactly what a bare row would have to say at a width with room for all
  // of it, title included. This is the yardstick every width below is measured against.
  const FULL_CONTENT = [
    `ralph ${VERSION}`,
    ...FULL.map(([label, value]) => `${label.padEnd(GUTTER)}${value}`),
  ]

  it('carries the same seven rows in the same order, at every bare width', () => {
    // #70's section is the part that would vanish unnoticed: three bullets whose labels are
    // `new` and then two empty ones, plus the `more` pointer. A row must never disappear
    // because the frame did. Read off the LABELS, which is where a dropped or reordered row
    // shows up regardless of how narrow the value got — so the sweep stops at nine columns,
    // the last width at which the eight-column gutter survives the clip whole.
    expect(FULL.map(([label]) => label)).toEqual(['update', 'cwd', 'new', '', '', 'more'])
    for (const width of BARE_WIDTHS.filter((width) => width > GUTTER)) {
      const pairs = barePairs(composeBanner({ facts: FACTS, width }))
      expect(
        pairs.map(([label]) => label),
        `width ${width}`,
      ).toEqual(FULL.map(([label]) => label))
    }
  })

  it('says the same words as the box, cut short and never rewritten', () => {
    // The values, as a claim about TRUNCATION rather than equality: the ellipsis marks a
    // clip and replaces the column it cut, so whatever is left of a bare row has to be a
    // PREFIX of what the 60-column box says in the same position. A different sentence at a
    // narrow width — an abbreviation, a second wording, a dropped verb, a re-ordered pair —
    // fails here, which is what makes "the same information, unadorned" a test rather than a
    // promise in a comment. And where nothing was clipped the two must match exactly, which
    // is the assertion that would catch a prefix check passing on the empty string.
    for (const width of BARE_WIDTHS) {
      const lines = composeBanner({ facts: FACTS, width })
      expect(lines.length, `width ${width}`).toBe(FULL_CONTENT.length)
      for (const [index, line] of lines.entries()) {
        const why = `width ${width} row ${index}: ${JSON.stringify(line)}`
        const clipped = line.endsWith('…')
        const shown = clipped ? line.slice(0, -1) : line
        expect(FULL_CONTENT[index].startsWith(shown), why).toBe(true)
        if (!clipped) expect(line, why).toBe(FULL_CONTENT[index])
      }
    }
  })

  it('keeps #70’s bullets and its pointer down to the last width that has room', () => {
    // The section named explicitly, because it is the one that grows and the one a reader
    // would not miss until a release went unannounced. At 43 columns every bullet still
    // fits whole; the pointer names the command that shows the rest, which is what makes
    // the three-bullet cap honest at a width where nothing else fits.
    const lines = composeBanner({ facts: FACTS, width: 43 })
    expect(lines).toContain('new     • one')
    expect(lines).toContain('        • two')
    expect(lines).toContain('        • three')
    expect(lines).toContain(`more    ${POINTER}`)
    // ...and the fourth bullet is not shown at any width, boxed or bare: it is what the
    // pointer is for.
    for (const width of [...BARE_WIDTHS, 44, 60, 200]) {
      expect(composeBanner({ facts: FACTS, width }).join('\n'), `width ${width}`).not.toContain('four')
    }
  })

  it('matches the box glyph for glyph where the four columns cancel exactly', () => {
    // The parity claim where it can be EXACT rather than a prefix: the frame costs exactly
    // four columns (`│ ` and ` │`), so a bare form at W has the same room for content as a
    // boxed form at W+4. Every label, every value and every clip must agree — which is the
    // strongest form of "the same information, unadorned" available, and it holds at every
    // width where both sides of the comparison exist.
    for (let width = BOX_MIN_WIDTH - 4; width < BOX_MIN_WIDTH; width += 1) {
      const bare = composeBanner({ facts: FACTS, width })
      const boxed = composeBanner({ facts: FACTS, width: width + 4 })
      const why = `bare ${width} vs boxed ${width + 4}`
      expect(barePairs(bare), why).toEqual(boxedPairs(boxed))
      expect(bare.length, why).toBe(boxed.length - 1)
      expect(bare[0], why).toBe(`ralph ${VERSION}`)
    }
  })

  it('loses the section rather than half of it when there is nothing to say', () => {
    // The other direction, at the rung: a pruned install with no changelog gets no heading,
    // no placeholder bullet and no pointer to a command with nothing behind it — bare
    // exactly as boxed. Two lines, and they are the two facts.
    for (const whatsNew of [undefined, [], null, 'nope', ['   ', null]]) {
      const lines = compose({ whatsNew }, { width: 30 })
      expect(lines, JSON.stringify(whatsNew) ?? 'undefined').toEqual([
        `ralph ${VERSION}`,
        `cwd     ${CWD}`,
      ])
    }
  })
})
