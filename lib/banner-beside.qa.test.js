// #161 QA — adversarial specs for the HORIZONTAL JOIN.
//
// banner-beside.test.js proves the intended slice: box line 0 lands on sprite line 0, the
// sprite's remaining rows come out byte for byte, a surplus box row is indented into the same
// column, and the gap defaults to the ladder's own constant. This file attacks the four things
// that slice cannot show, each of which is a promise the module's own header makes:
//
//   1. TOTALITY, AS A SIZE AND NOT ONLY AS A SHAPE. The header says a nonsensical width or a
//      hostile gap must cost a worse-looking banner and never the run, and names `repeat(-1)`
//      as the hazard it is guarding. `columns` refuses a negative, a fraction and a non-number
//      — and accepts every large finite integer, which is the identical defect one order of
//      magnitude up: `' '.repeat(1e9)` is a RangeError, and this module builds its indent
//      EAGERLY, before it knows whether any row will spend it. That is exactly the shape QA
//      found in lib/sprite-player.js's `frameCount`, where `Number.MAX_SAFE_INTEGER` satisfied
//      every guard the function had (see SPLASH_MAX_FRAMES): a safe integer is a shape, not a
//      size. Swept here across the whole number line rather than tabulated at eight values.
//   2. THE LISTS, INCLUDING THE ONES WITH HOLES IN THEM. lib/sprite-player.js REFUSES a frame
//      whose `lines` is sparse — `map` skips a hole, so a sparse frame writes fewer rows than
//      it has slots and then asks the terminal to walk up rows it never printed, straight
//      through the previous run's output. This module is now upstream of that guard, so what
//      matters is that it cannot MANUFACTURE a hole; that it also fills one in, and what that
//      costs, is asserted rather than assumed at the bottom of this file.
//   3. WHAT THE STATED WIDTH DOES AND DOES NOT BUY. The signature's whole argument is that the
//      offset is arithmetic on the caller's number and never a measurement of the string. The
//      other half of that trade is never written down: a stated width that DISAGREES with the
//      art produces a ragged right column, and this module cannot tell. Pinned here, both ways.
//   4. THE BYTES. Not one escape of its own is a static claim in the sibling spec; what this
//      file adds is the dynamic one — the output's escape count is the inputs', exactly, and a
//      colour span cannot cross the gap into the box's text. That last one is NOT this module's
//      doing and the test says so: it rests on lib/sprite-render.js ending every row in a full
//      reset, and the converse case proves the dependency is real rather than decorative.
//
// AND THE SEAM WITH THE PLAYER, at the bottom, because #161 is the first issue that puts
// SOMETHING OTHER THAN THE SPRITE inside an animated frame. Every cursor move `playSplash`
// makes is counted off the chunk it just wrote, so a frame that grew taller by this join must
// redraw as exactly correctly as a bare one — the property is claimed in that module's header
// and this is the first caller that can make the two numbers differ.
//
// PURE AND HERMETIC (#41): the subject is a pure function, the one impure collaborator
// (`playSplash`) is driven with an injected stream, an injected sleep and NO signal source, and
// every width, gap and column count below is a literal rather than a terminal's answer.

import { describe, expect, it } from 'vitest'
import { joinBeside } from './banner-beside.js'
import { BESIDE_GAP, bannerLayout, composeBanner } from './banner-compose.js'
import { renderSplashFrames } from './sprite-banner.js'
import { playSplash } from './sprite-player.js'
import { spriteWidth } from './sprite-data.js'

// Built from its code point rather than embedded, which is this repo's rule for the byte (#107,
// and see test/source-control-bytes.test.js): a raw ESC in a tracked file recolours the terminal
// of anybody who `cat`s it.
const ESC = String.fromCharCode(27)
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const RESET = `${ESC}[0m`
const YELLOW = `${ESC}[33m`
const GREEN = `${ESC}[32m`
const COLOR_OFF = `${ESC}[39m`
const CURSOR_UP = new RegExp(`${ESC}\\[(\\d+)A`)
const IS_CURSOR_UP = new RegExp(`^${ESC}\\[(\\d+)A$`)
const HIDE = `${ESC}[?25l`
const SHOW = `${ESC}[?25h`

const WIDTH = 26
const GAP = 2

const visible = (line) => [...line.replace(SGR, '')]
/** How many rows a chunk actually put on the terminal — `playSplash`'s own arithmetic. */
const rowsIn = (chunk) => chunk.split('\n').length - 1

describe('QA joinBeside — a width and a gap are sizes, not only shapes (#161)', () => {
  // THE TABLE THIS SWEEP REPLACES is the sibling spec's eight-value list, and the eight values
  // are all SMALL: `undefined`, `null`, `-1`, `0.5`, `NaN`, `Infinity`, `'26'` and `{}`. Every
  // one of them is refused by `columns` and falls back, which is the shape claim. None of them
  // is a large finite integer, and a large finite integer is precisely what `columns` lets
  // through: `typeof number && isFinite && >= 0` is true of `1e9`, `2 ** 31` and
  // `Number.MAX_SAFE_INTEGER`, and each of those reaches `' '.repeat(...)` past V8's maximum
  // string length. The module header names `repeat(-1)` as the hazard totality exists to close;
  // this is the same hazard from the other end, and it is the hazard lib/sprite-player.js
  // already had to grow a `SPLASH_MAX_FRAMES` for.
  const HUGE = [
    2 ** 29,
    2 ** 31,
    1e9,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_VALUE,
    1e21,
    2 ** 53 - 2,
  ]

  it('never throws for any width or gap a caller can arrive with', () => {
    // TOTAL, and total is the whole reason this module is allowed to run before the first
    // preflight line of `ralph start`. A width that came out of a subtraction, a config file, a
    // regenerated asset's metadata or a caller's own arithmetic is a number this function has
    // promised to survive — and "survive" cannot mean "for numbers under half a billion".
    //
    // THE FAILURE IS NOT SHAPE-DEPENDENT, which is the second half of the claim and the reason
    // the box below is SHORTER than the sprite: no row of this call needs an indent at all, so
    // a lazily-built one would never be allocated. The indent is built eagerly, above the loop,
    // so the cost and the throw are paid by every call that states a width — including the
    // overwhelmingly common one where the box fits inside the picture's own height.
    for (const spriteWidth of HUGE) {
      expect(() =>
        joinBeside({ spriteLines: ['L0', 'L1', 'L2'], boxLines: ['B0'], spriteWidth }),
      ).not.toThrow()
    }
    for (const gap of HUGE) {
      expect(() =>
        joinBeside({ spriteLines: ['L0', 'L1', 'L2'], boxLines: ['B0'], spriteWidth: WIDTH, gap }),
      ).not.toThrow()
    }
    // ...and with nothing to join at all, where there is not even a row to put an indent on.
    for (const spriteWidth of HUGE) {
      expect(() => joinBeside({ spriteWidth })).not.toThrow()
    }
  })

  it('falls back to a usable count for every width and gap it cannot spend', () => {
    // The recovery, read off a SURPLUS row — the only row whose left edge is the stated width
    // plus the gap, and therefore the only place the fallback is observable. A width it cannot
    // use is worth no columns; a gap it cannot use is worth the ladder's own two.
    const surplus = (options) =>
      joinBeside({ spriteLines: ['L0'], boxLines: ['B0', 'B1'], ...options })[1]
    for (const spriteWidth of [undefined, null, -1, -0.5, Number.NaN, Infinity, -Infinity, '26', {}, []]) {
      expect(surplus({ spriteWidth }), String(spriteWidth)).toBe(`${' '.repeat(BESIDE_GAP)}B1`)
    }
    for (const gap of [undefined, null, -1, Number.NaN, Infinity, -Infinity, '2', {}, []]) {
      expect(surplus({ spriteWidth: 4, gap }), String(gap)).toBe(`${' '.repeat(4 + BESIDE_GAP)}B1`)
    }
    // Zero is HONOURED at both ends and is not a fallback — a caller asking for no air is
    // asking for no air, and a caller stating a sprite of no width has stated one.
    expect(surplus({ spriteWidth: 0, gap: 0 })).toBe('B1')
    // ...and a fraction is floored rather than refused, so half a column is no column.
    expect(surplus({ spriteWidth: 4.9, gap: 2.9 })).toBe(`${' '.repeat(6)}B1`)
    expect(surplus({ spriteWidth: -0 })).toBe(`${' '.repeat(BESIDE_GAP)}B1`)
  })
})

describe('QA joinBeside — the lists, holes included (#161)', () => {
  it('returns an empty block when both sides are empty, and never a hole in any block', () => {
    expect(joinBeside({ spriteLines: [], boxLines: [], spriteWidth: WIDTH })).toEqual([])
    // A DENSE ARRAY IS THE OUTPUT CONTRACT, because the consumer is lib/sprite-player.js and a
    // hole there is a frame it refuses to draw at all (see `isDrawable`). Asserted as the three
    // things "dense" means, not as `toEqual` — `toEqual` treats a hole and an `undefined` as
    // equal and would pass for exactly the array this test exists to forbid.
    const cases = [
      { spriteLines: new Array(3), boxLines: ['B0'] },
      { spriteLines: ['L0'], boxLines: new Array(3) },
      { spriteLines: new Array(4), boxLines: new Array(4) },
      // A sparse list with content past the hole, which is what a caller assembling by index
      // leaves behind: slots 0 and 2 set, slot 1 never written.
      { spriteLines: Object.assign(new Array(3), { 0: 'L0', 2: 'L2' }), boxLines: ['B0'] },
    ]
    for (const options of cases) {
      const lines = joinBeside({ ...options, spriteWidth: 4 })
      expect(Object.keys(lines)).toHaveLength(lines.length)
      for (let index = 0; index < lines.length; index += 1) {
        expect(index in lines, `${JSON.stringify(options.spriteLines)} @ ${index}`).toBe(true)
        expect(typeof lines[index]).toBe('string')
      }
    }
  })

  it('spells a hole as blank columns, which fills in art the player would have refused', () => {
    // WHAT THE DENSIFYING COSTS, said out loud rather than left as a happy consequence. A hole
    // in `spriteLines` reaches this module as `undefined` and leaves it as `''`, so a frame that
    // lib/sprite-player.js would have DROPPED WHOLE — its `isDrawable` refuses any sparse
    // `lines`, on #72's rule that a 17-row Ralph drawn as 16 rows is not a smaller Ralph but a
    // mangled one — arrives at the player dense, drawable, and missing a row of picture.
    //
    // UNREACHABLE FROM THE SHIPPED RENDERER: lib/sprite-render.js pushes one string per row and
    // cannot produce a hole, so no `ralph start` takes this path. It is pinned because the guard
    // it bypasses was itself a QA finding, and a regenerated or hand-built asset is exactly the
    // caller that guard was left in place for.
    const lines = joinBeside({
      spriteLines: Object.assign(new Array(3), { 0: 'L0', 2: 'L2' }),
      boxLines: ['B0'],
      spriteWidth: 2,
    })
    expect(lines).toEqual(['L0  B0', '', 'L2'])
    // The row COUNT survives, which is the half that matters for the terminal: the join emits
    // one line per slot, so whatever the player writes it can still move back over. The seam
    // describe at the bottom of this file drives that through the real player.
    expect(lines).toHaveLength(3)
  })

  it('refuses a non-string member rather than coercing it, and never runs its toString', () => {
    // The box's text comes out of a JSON cache, a committed changelog and a caller's argv by the
    // time it reaches lib/banner-compose.js, and this module sits downstream of all of it. A
    // `String(value)` here would run a hostile object's `toString` — the exact coercion
    // `textOr` and `whatsNewRows` exist to prevent one layer up — so the refusal is asserted
    // through a COUNTER rather than through the output, which a lucky `toString` would satisfy.
    let calls = 0
    const hostile = {
      toString() {
        calls += 1
        return 'FORGED'
      },
    }
    const lines = joinBeside({
      spriteLines: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'],
      boxLines: [hostile, 7, null, undefined, Symbol('s'), ['B0'], { valueOf: () => 'X' }],
      spriteWidth: 2,
    })
    expect(calls).toBe(0)
    // Every one of those rows is the sprite's own line and nothing appended — a member that is
    // not a string is a row with no box on it, which is the same answer an absent row gets.
    expect(lines.slice(0, 6)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'])
    expect(lines[6]).toBe('')
    expect(JSON.stringify(lines)).not.toContain('FORGED')
    // ...and a Symbol is the one member that makes the claim load-bearing rather than tidy:
    // `String(Symbol())` is fine but `'' + Symbol()` throws a TypeError, so a concatenating
    // implementation would have lost the run here rather than a row.
    expect(() =>
      joinBeside({ spriteLines: [], boxLines: [Symbol('boom')], spriteWidth: 2 }),
    ).not.toThrow()
  })

  it('takes a list from an array and from nothing else', () => {
    // `Array.isArray` and not duck-typing, which is the same choice lib/banner-rows.js makes
    // about `whatsNew`: a Set of strings, a string, an `arguments` object and a hand-rolled
    // array-like are all shapes a caller can plausibly arrive with, and none of them is a block
    // of lines this module has agreed to read. The answer is "no block", never a throw.
    const notLists = [
      new Set(['B0']),
      'B0',
      { 0: 'B0', length: 1 },
      (function () {
        // eslint-disable-next-line prefer-rest-params
        return arguments
      })('B0'),
      new Map(),
      7,
      true,
      null,
    ]
    for (const boxLines of notLists) {
      expect(joinBeside({ spriteLines: ['L0'], boxLines, spriteWidth: 2 }), String(boxLines)).toEqual([
        'L0',
      ])
    }
    for (const spriteLines of notLists) {
      expect(
        joinBeside({ spriteLines, boxLines: ['B0'], spriteWidth: 2 }),
        String(spriteLines),
      ).toEqual(['    B0'])
    }
    // A subclass of Array IS an array, and is read as one — the check is about the shape being
    // indexable and length-bearing, not about the constructor.
    class Lines extends Array {}
    expect(joinBeside({ spriteLines: Lines.from(['L0']), boxLines: ['B0'], spriteWidth: 2 })).toEqual(
      ['L0  B0'],
    )
  })

  it('mutates neither block and hands back a fresh array every time', () => {
    // The caller is `ralph start`, which composes ONE box and glues it onto FIVE frames, so a
    // join that wrote through to its inputs would corrupt frame 2 with frame 1's join. Frozen
    // inputs say it in the form that fails loudly rather than silently.
    const spriteLines = Object.freeze(['L0', 'L1'])
    const boxLines = Object.freeze(['B0'])
    const first = joinBeside({ spriteLines, boxLines, spriteWidth: 2 })
    const second = joinBeside({ spriteLines, boxLines, spriteWidth: 2 })
    expect(first).toEqual(['L0  B0', 'L1'])
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    expect(spriteLines).toEqual(['L0', 'L1'])
    expect(boxLines).toEqual(['B0'])
    // ...and the same box glued onto three different frames five times over, which is the
    // command's real shape: every result independent of every other.
    const frames = [['a0', 'a1'], ['b0', 'b1'], ['c0', 'c1']]
    const joined = frames.map((lines) => joinBeside({ spriteLines: lines, boxLines, spriteWidth: 2 }))
    expect(joined).toEqual([['a0  B0', 'a1'], ['b0  B0', 'b1'], ['c0  B0', 'c1']])
  })
})

describe('QA joinBeside — a stated width is not a measured one (#161)', () => {
  it('offsets a surplus row by the stated width even when the art disagrees with it', () => {
    // THE TRADE THE SIGNATURE MAKES, and the half of it the module's header does not write
    // down. Stating the width is what lets a 200-code-point escape-laden row carry two visible
    // cells; the cost is that a WRONG number cannot be detected here at all. A row the box
    // reaches is a plain concatenation — the box starts wherever the sprite's string ended —
    // while a surplus row is placed by arithmetic, so the two disagree by exactly the error in
    // the caller's number and the right-hand column goes ragged.
    //
    // Asserted in both directions, because the two failures look nothing alike: understating
    // pushes the joined rows RIGHT of the indented ones, overstating pushes them LEFT.
    const understated = joinBeside({
      spriteLines: ['A'.repeat(40)],
      boxLines: ['B0', 'B1'],
      spriteWidth: WIDTH,
    })
    expect(visible(understated[0]).indexOf('B')).toBe(40 + GAP)
    expect(visible(understated[1]).indexOf('B')).toBe(WIDTH + GAP)
    expect(visible(understated[0]).indexOf('B')).not.toBe(visible(understated[1]).indexOf('B'))

    const overstated = joinBeside({ spriteLines: ['XY'], boxLines: ['B0', 'B1'], spriteWidth: WIDTH })
    expect(visible(overstated[0]).indexOf('B')).toBe(2 + GAP)
    expect(visible(overstated[1]).indexOf('B')).toBe(WIDTH + GAP)

    // ...and with the number the command actually passes, against the art it actually draws,
    // the two agree — which is the only reason the ragged case above is a caller's bug rather
    // than this module's. `spriteWidth` is imported from the ASSET, and every rendered row
    // carries exactly that many visible cells.
    const frame = renderSplashFrames({ isTTY: true, color: true, width: 120 })[0]
    for (const row of frame.lines) expect(visible(row)).toHaveLength(spriteWidth)
  })

  it('does not clip a box line, however far past the terminal it reaches', () => {
    // WHOSE JOB THE WIDTH GUARANTEE IS, pinned so a future reader does not look for it here.
    // This module concatenates; the promise that a joined line fits the terminal is
    // `besideWidth`'s — the leftover columns, capped — spent by lib/banner-compose.js's own
    // clip before these strings exist. A box handed here at the wrong width overhangs, and that
    // is the composer's defect and not the join's.
    const wide = joinBeside({ spriteLines: ['L0'], boxLines: ['X'.repeat(200)], spriteWidth: WIDTH })
    expect(visible(wide[0])).toHaveLength(2 + GAP + 200)
    // ...and the arrangement the command really builds keeps that promise at the rung, where
    // there is the least room to spare: 26 cells of sprite, two of air and a 44-column box is
    // exactly 72 columns and not one more.
    const layout = bannerLayout(72)
    const box = composeBanner({
      facts: { version: '1.2.3', cwd: '/'.padEnd(400, 'deep/'), latestVersion: '9.9.9' },
      width: layout.besideWidth,
      capabilities: { color: true },
    })
    const joined = joinBeside({
      spriteLines: renderSplashFrames({ isTTY: true, color: true, width: 72 })[0].lines,
      boxLines: box,
      spriteWidth,
    })
    for (const line of joined) expect(visible(line).length).toBeLessThanOrEqual(72)
  })
})

describe('QA joinBeside — code points are the ruler, not display cells (#161)', () => {
  // The repo's stated unit, from lib/banner-compose.js's `visibleWidth`: `[...s].length`, so a
  // surrogate pair is ONE column and an East Asian glyph is one column. That is deliberately not
  // a display-width function — modelling cells needs a character-width table this package will
  // not carry for a banner — and the guarantee every test in this directory measures is
  // therefore stated in code points. This block asserts THAT guarantee and, at the end, states
  // the limitation it leaves behind rather than pretending the two rulers agree.
  const COMBINING_ACUTE = String.fromCodePoint(0x0301)
  const MULTIBYTE = [
    ['an emoji', String.fromCodePoint(0x1f986)],
    ['a CJK pair', String.fromCodePoint(0x4f60, 0x597d)],
    ['an astral supplementary plane glyph', String.fromCodePoint(0x2a6b2)],
    ['a base plus a combining mark', `e${COMBINING_ACUTE}`],
    ['a ZWJ sequence', String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)],
    ['a flag', String.fromCodePoint(0x1f1e7, 0x1f1f7)],
  ]

  for (const [label, text] of MULTIBYTE) {
    it(`joins ${label} in the box without shifting anything by a UTF-16 unit`, () => {
      const boxLines = [`B ${text}`, `C ${text}`]
      const lines = joinBeside({ spriteLines: ['L0'], boxLines, spriteWidth: WIDTH })
      // Row 0: the sprite's string, the air, the box's string — byte for byte, so no
      // normalisation, no re-encoding and no splitting of a pair has happened in transit.
      expect(lines[0]).toBe(`L0${' '.repeat(GAP)}${boxLines[0]}`)
      // Row 1: the surplus row, indented by the STATED width in code points. `''.length` on
      // this text is larger than `[...text].length` for every case above except the combining
      // mark, so an implementation that padded to UTF-16 units would land in a different column.
      expect(lines[1]).toBe(`${' '.repeat(WIDTH + GAP)}${boxLines[1]}`)
      expect(visible(lines[1]).indexOf('C')).toBe(WIDTH + GAP)
      // ...and the code-point width of the joined row is the stated width, the gap and the
      // box's own code points. Which is the guarantee, and the whole of it.
      expect(visible(lines[1])).toHaveLength(WIDTH + GAP + [...boxLines[1]].length)
    })
  }

  it('leaves a wide glyph looking wider than it counts, and that is the stated limitation', () => {
    // SAID PLAINLY BECAUSE IT IS TRUE AND BECAUSE #161 GAVE IT A NEW CONSEQUENCE. A CJK
    // ideograph occupies two terminal cells and counts as one code point here, so a box whose
    // `cwd` is Japanese passes every width assertion in this directory and still overhangs the
    // right edge of a real terminal. That was cosmetic while the box printed BELOW the sprite:
    // a wrapped last line of a stacked box is an ugly banner and nothing else. Inside an
    // animated frame it is arithmetic — lib/sprite-player.js counts the rows it wrote and moves
    // the cursor up that many, and a line the terminal wrapped onto two physical rows is one
    // row the move does not undo.
    //
    // Measured against a HAND-MADE ruler (the six ranges below, not a Unicode table) so the
    // claim is about characters this test chose rather than about a dependency's answer.
    const isWide = (point) =>
      (point >= 0x1100 && point <= 0x115f) ||
      (point >= 0x2e80 && point <= 0xa4cf) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xff00 && point <= 0xff60) ||
      point >= 0x1f300
    const cells = (line) =>
      visible(line).reduce((total, glyph) => total + (isWide(glyph.codePointAt(0)) ? 2 : 1), 0)

    const layout = bannerLayout(72)
    const boxLines = composeBanner({
      facts: { version: '1.2.3', cwd: String.fromCodePoint(0x4f60, 0x597d).repeat(18) },
      width: layout.besideWidth,
      capabilities: { color: false },
    })
    const joined = joinBeside({ spriteLines: ['L0'], boxLines, spriteWidth })
    // The guarantee holds: every line is inside 72 columns counted the way this package counts.
    for (const line of joined) expect(visible(line).length).toBeLessThanOrEqual(72)
    // The limitation holds too: at least one of them needs more than 72 CELLS to draw.
    expect(Math.max(...joined.map(cells))).toBeGreaterThan(72)
  })
})

describe('QA joinBeside — the bytes it adds and the spans it must not open (#161)', () => {
  it('adds no escape byte, and removes none, for any input', () => {
    // The sibling spec reads the SOURCE for an ESC. This is the dynamic half: the output's
    // escape sequences are the inputs' escape sequences, in the same order, with nothing
    // invented between the blocks. What goes between them is spaces, which is what makes the
    // clip in lib/banner-compose.js the last place a line can be corrupted.
    const painted = `${RESET}${ESC}[38;2;1;2;3m▀${RESET}`
    const cases = [
      { spriteLines: ['L0', 'L1'], boxLines: ['B0'] },
      { spriteLines: [painted, painted], boxLines: ['B0', 'B1', 'B2'] },
      { spriteLines: [painted], boxLines: [`${YELLOW}hint${COLOR_OFF}`] },
      { spriteLines: [], boxLines: [`${GREEN}up to date${COLOR_OFF}`] },
    ]
    for (const options of cases) {
      const lines = joinBeside({ ...options, spriteWidth: 1 })
      const inputs = [...(options.spriteLines ?? []), ...(options.boxLines ?? [])].join('')
      const output = lines.join('')
      expect(output.match(SGR) ?? []).toEqual(inputs.match(SGR) ?? [])
      expect([...output].filter((glyph) => glyph === ESC)).toHaveLength(
        [...inputs].filter((glyph) => glyph === ESC).length,
      )
    }
    // A plain run stays plain: no NO_COLOR, no-TTY invocation can gain a byte here, because
    // there is no byte here to gain.
    const plain = joinBeside({
      spriteLines: ['aaa', 'bbb'],
      boxLines: ['ccc', 'ddd', 'eee'],
      spriteWidth: 3,
    })
    expect(plain.join('\n')).not.toContain(ESC)
  })

  it('never lets the sprite’s colour reach the air or the box — because the art closes it', () => {
    // THE DEPENDENCY, NAMED. Every row lib/sprite-render.js emits ends in a FULL reset, so the
    // two spaces of air and the box's text after them are drawn in the terminal's own colours.
    // That is not this module's guarantee and it must not be mistaken for one: the join appends,
    // so whatever span the left block left open is open across the gap.
    const frame = renderSplashFrames({ isTTY: true, color: true, width: 120 })[0]
    for (const row of frame.lines) expect(row.endsWith(RESET)).toBe(true)
    const boxLines = composeBanner({
      facts: { version: '1.2.3', cwd: '/repo' },
      width: bannerLayout(120).besideWidth,
      capabilities: { color: true },
    })
    for (const line of joinBeside({ spriteLines: frame.lines, boxLines, spriteWidth })) {
      const sequences = line.match(SGR)
      if (!sequences) continue
      // The last thing said before the box's first character is a reset, on every row the box
      // reaches: found by cutting the line at the gap the join inserted.
      const gapAt = line.indexOf(`${RESET}${' '.repeat(BESIDE_GAP)}`)
      if (gapAt < 0) continue
      expect(line.slice(gapAt, gapAt + RESET.length)).toBe(RESET)
    }
    // ...and the converse, which is what makes the paragraph above a dependency rather than a
    // decoration: a left block that does NOT close its span paints the air and the box too.
    const leaky = joinBeside({
      spriteLines: [`${ESC}[41m##`],
      boxLines: ['B0'],
      spriteWidth: 2,
    })
    expect(leaky[0]).toBe(`${ESC}[41m##  B0`)
    expect(leaky[0].lastIndexOf(`${ESC}[41m`)).toBeLessThan(leaky[0].indexOf('B0'))
    expect(leaky[0]).not.toContain(RESET)
  })

  it('keeps the box’s own painted rows to exactly one span each, opened and closed', () => {
    // The box has two painted rows — #75's yellow update hint and its green verdict — and they
    // are the only colour in it. A joined line must carry exactly one opener and exactly one
    // COLOR_OFF for the row it came from, in that order, however the row was glued in: a second
    // reset would be bytes in a log file and a missing one would repaint the rest of the line,
    // which on a joined row is the sprite's neighbourhood rather than the end of the banner.
    const boxLines = composeBanner({
      facts: {
        version: '1.2.3',
        latestVersion: '9.9.9',
        // `cachedLatest` is the verdict row's fact and the one green thing in the box; only
        // `ralph doctor` passes it today, which is exactly why the green case is asserted HERE
        // rather than left to a command that cannot draw it.
        cachedLatest: '1.2.3',
        cwd: '/repo',
      },
      width: bannerLayout(120).besideWidth,
      capabilities: { color: true },
    })
    const yellow = boxLines.filter((line) => line.includes(YELLOW))
    const green = boxLines.filter((line) => line.includes(GREEN))
    expect(yellow).toHaveLength(1)
    expect(green).toHaveLength(1)

    const frame = renderSplashFrames({ isTTY: true, color: true, width: 120 })[0]
    const joined = joinBeside({ spriteLines: frame.lines, boxLines, spriteWidth })
    for (const ink of [YELLOW, GREEN]) {
      const line = joined.find((candidate) => candidate.includes(ink))
      expect(line, ink.replace(ESC, 'ESC')).toBeDefined()
      expect(line.split(ink)).toHaveLength(2)
      expect(line.split(COLOR_OFF)).toHaveLength(2)
      expect(line.indexOf(ink)).toBeLessThan(line.indexOf(COLOR_OFF))
      // ...and the span closes before the line does, so nothing after it is painted.
      expect(line.slice(line.indexOf(COLOR_OFF) + COLOR_OFF.length)).not.toContain(ink)
    }
    // The two spans never land on one line, which is what keeps the count above readable as a
    // per-row claim rather than as a per-line one.
    expect(joined.filter((line) => line.includes(YELLOW) && line.includes(GREEN))).toHaveLength(0)
  })
})

describe('QA joinBeside × playSplash — the cursor comes back exactly as far as it went (#161)', () => {
  /** Play a list of frames on a recorder, with no clock and no signal source. */
  async function play(frames, cycles) {
    const chunks = []
    await playSplash({
      frames,
      cycles,
      stream: { write: (chunk) => chunks.push(chunk) },
      sleep: async () => {},
      signals: null,
    })
    return chunks
  }

  /** Every cursor-up in a transcript, paired with the rows the chunk before it wrote. */
  const moves = (chunks) =>
    chunks
      .map((chunk, index) => [chunk, chunks[index - 1]])
      .filter(([chunk]) => IS_CURSOR_UP.test(chunk))
      .map(([chunk, previous]) => [Number(IS_CURSOR_UP.exec(chunk)[1]), rowsIn(previous ?? '')])

  it('moves up the joined frame’s height when the box is taller than the picture', async () => {
    // THE CASE #161 MAKES POSSIBLE FOR THE FIRST TIME. Before this issue a frame's height was
    // the sprite's height, so "the move undoes the frame" and "the move is 17" were the same
    // sentence. A joined frame is as tall as the TALLER block, so a box with more rows than the
    // picture makes those two sentences different numbers — and lib/sprite-player.js's header
    // claims the right one, counted off the chunk it wrote rather than off `lines.length`.
    //
    // NOT REACHABLE FROM `ralph start` TODAY, and the number is worth stating rather than
    // implying: the sprite is 17 rows and the fullest box lib/banner-compose.js can draw is 12
    // (title, update, agent, model, context, cwd, source, repo, three bullets, pointer, rule).
    // Which is exactly why it is proven here — the guarantee is the player's, the caller that
    // can break it is this join, and nothing in the command's own suite exercises the pairing.
    const spriteLines = ['S0', 'S1', 'S2']
    const boxLines = Array.from({ length: 9 }, (_, index) => `B${index}`)
    const lines = joinBeside({ spriteLines, boxLines, spriteWidth: 2 })
    expect(lines).toHaveLength(9)
    const pairs = moves(await play([{ lines, delayMs: 0 }], 4))
    expect(pairs).toHaveLength(3)
    for (const [move, rows] of pairs) {
      expect(move).toBe(9)
      expect(move).toBe(rows)
    }
  })

  it('counts a newline inside a box line as the row it printed', async () => {
    // The other way a joined frame's height stops being its slot count, and the one
    // lib/sprite-player.js's `rowsIn` was written for: a line with a newline in it. The box
    // cannot produce one — `textOr` replaces control bytes on the way into every row — so this
    // is the guard behind that guard, and the join is what would deliver such a line to the
    // player if a row ever escaped the gate.
    const lines = joinBeside({
      spriteLines: ['S0', 'S1'],
      boxLines: [`B0${'\n'}B0b`, 'B1'],
      spriteWidth: 2,
    })
    expect(lines).toEqual([`S0  B0${'\n'}B0b`, 'S1  B1'])
    const pairs = moves(await play([{ lines, delayMs: 0 }], 3))
    expect(pairs).toHaveLength(2)
    // Three physical rows for two array slots, and the move is three — so the cursor lands
    // where the frame started rather than one row inside it.
    for (const [move, rows] of pairs) {
      expect(rows).toBe(3)
      expect(move).toBe(3)
    }
  })

  it('draws a re-densified frame the player would have dropped, and still moves correctly', async () => {
    // The two halves of the laundering, together. The frame the player is handed is dense, so
    // `isDrawable` accepts it and the picture is drawn with a blank row where the hole was —
    // the art is mangled. The cursor is NOT: the move is counted off the bytes, so the terminal
    // above the sprite is untouched, which is the failure that guard was really protecting.
    const holed = Object.assign(new Array(4), { 0: 'S0', 3: 'S3' })
    // Bare, the frame is refused outright — nothing at all is written.
    expect(await play([{ lines: holed, delayMs: 0 }], 3)).toEqual([])
    const lines = joinBeside({ spriteLines: holed, boxLines: ['B0', 'B1'], spriteWidth: 2 })
    expect(lines).toEqual(['S0  B0', '    B1', '', 'S3'])
    const chunks = await play([{ lines, delayMs: 0 }], 3)
    expect(chunks.length).toBeGreaterThan(0)
    const pairs = moves(chunks)
    expect(pairs).toHaveLength(2)
    for (const [move, rows] of pairs) {
      expect(move).toBe(4)
      expect(move).toBe(rows)
    }
  })

  it('settles on a joined frame with no control byte after it', async () => {
    // #73's ordering claim, restated for a frame that now carries FACTS. The last write must be
    // art, because whatever follows it is glued to the front of the run's next line — and in
    // the beside arrangement the box's own top rule is inside that art, so a stray `ESC[?25h`
    // would land in the middle of the banner rather than in front of it.
    const frame = renderSplashFrames({ isTTY: true, color: true, width: 120 })[0]
    const boxLines = composeBanner({
      facts: { version: '1.2.3', cwd: '/repo' },
      width: bannerLayout(120).besideWidth,
      capabilities: { color: true },
    })
    const lines = joinBeside({ spriteLines: frame.lines, boxLines, spriteWidth })
    const chunks = await play([{ ...frame, lines }], 5)
    const last = chunks[chunks.length - 1]
    expect(last).toBe(`${lines.join('\n')}\n`)
    expect(last).not.toContain(HIDE)
    expect(last).not.toContain(SHOW)
    expect(last).not.toMatch(CURSOR_UP)
    // The restore is before the settled frame, once, and the hide is once — the counts the
    // player's own header carries, re-read here through a joined frame.
    expect(chunks.filter((chunk) => chunk === HIDE)).toHaveLength(1)
    expect(chunks.filter((chunk) => chunk === SHOW)).toHaveLength(1)
    expect(chunks.indexOf(SHOW)).toBeLessThan(chunks.length - 1)
  })
})
