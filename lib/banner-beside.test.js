// #161 — the HORIZONTAL JOIN, as a table of shapes.
//
// The sprite is 26 cells wide and 17 rows tall; the identity box is about seven rows. Until
// this issue the two were stacked, so a 120-column terminal drew a 26-column picture and
// then left ninety-odd columns of nothing to the right of it for seventeen rows. #161 glues
// the box into that empty space, and this file is the spec for the one function that does
// the gluing.
//
// WHY THE WIDTH IS AN ARGUMENT AND NOT A MEASUREMENT, which is the claim most of this file
// exists to make: a sprite line is 24-bit ANSI. lib/sprite-render.js writes a reset, a
// foreground and a half-block per cell, so a 26-cell row is well over two hundred code
// points, and `line.length` — or `[...line].length`, or any other honest count of what is
// in the string — is not where the box's first column goes. The visible width is a fixed
// property of the ART, so the caller states it and this module trusts it. Every case below
// is therefore written with sprite lines that are DELIBERATELY not their stated width: the
// assertions can only pass if the offset came from the argument.
//
// PURE, and asserted so at the bottom by a static read, on the same argument the rest of
// the banner's modules make (#41): no process, no clock, no fs — and, unlike every other
// module in this feature, NOT ONE ESCAPE BYTE OF ITS OWN. What it emits between the two
// blocks is spaces. A module that wrote an escape here would be a second place the banner
// could corrupt a line, and the whole point of the split is that the painting is finished
// before the join begins.
//
// The gap and the widths are spelled out as literals here rather than imported, on the rule
// this directory's specs already follow: an expectation built from the implementation's own
// constant is satisfied by a typo in that constant. `BESIDE_GAP` is imported in exactly one
// test, and its only job there is to say that the DEFAULT is that constant.

import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { BESIDE_MAX_COLUMNS, joinBeside } from './banner-beside.js'
import { BESIDE_GAP } from './banner-compose.js'

// Built from its code point rather than embedded, which is this repo's rule for the byte
// (#107, and see test/source-control-bytes.test.js): a raw ESC in a tracked file recolours
// the terminal of anybody who `cat`s it.
const ESC = String.fromCharCode(27)

// Stand-ins for the two blocks, and neither of them is as wide as it claims. `L0` is two
// characters long and stands for a 26-cell sprite row, which is what makes every offset
// assertion below a statement about the ARGUMENT rather than about the string.
const SPRITE = ['L0', 'L1', 'L2', 'L3']
const BOX = ['B0', 'B1']
const WIDTH = 26
const GAP = 2
// Where the box's first column lands: the sprite's stated cells plus the air.
const INDENT = ' '.repeat(WIDTH + GAP)

const join = (options) => joinBeside({ spriteWidth: WIDTH, ...options })

describe('joinBeside — the box beside the sprite (#161)', () => {
  it('puts box line 0 on the same line as sprite line 0', () => {
    // TOP-ALIGNED, which is the whole arrangement the issue asks for: the reader's eye
    // finds `╭─ ralph` at the top right of the picture rather than under its feet.
    const lines = join({ spriteLines: SPRITE, boxLines: BOX })
    expect(lines[0]).toBe('L0  B0')
    expect(lines[1]).toBe('L1  B1')
  })

  it('emits the sprite’s remaining rows unchanged, with no trailing padding', () => {
    // THE NORMAL CASE: seven box rows against seventeen sprite rows. The ten rows the box
    // does not reach must be the sprite's own strings, byte for byte — not padded out to
    // the joined width, because trailing spaces are noise in a log file and the sprite has
    // no right border to reach. `toBe` on the identical string is the assertion, so a
    // `padEnd` anywhere in the implementation fails here.
    const lines = join({ spriteLines: SPRITE, boxLines: BOX })
    expect(lines).toHaveLength(4)
    expect(lines[2]).toBe('L2')
    expect(lines[3]).toBe('L3')
    for (const line of lines) expect(line).toBe(line.trimEnd())
  })

  it('indents a box taller than the sprite into the same column', () => {
    // The surplus rows still print — they are FACTS, and a box that lost its bottom rule
    // to a short sprite would be a box with three sides. They sit in the column the rows
    // above them started in, so the box reads as one block rather than as a paragraph
    // that steps left halfway down.
    const lines = join({ spriteLines: ['L0'], boxLines: ['B0', 'B1', 'B2'] })
    expect(lines).toEqual(['L0  B0', `${INDENT}B1`, `${INDENT}B2`])
  })

  it('returns the sprite alone when there is no box', () => {
    // `RALPH_BANNER=off` prints no box at all, and a caller that hands over an empty list
    // must get the animation it would have got before this issue existed — the same
    // strings, not the same strings plus two spaces.
    const lines = join({ spriteLines: SPRITE, boxLines: [] })
    expect(lines).toEqual(SPRITE)
  })

  it('spends exactly the stated columns on air, and never measures the escapes', () => {
    // THE CLAIM THIS MODULE'S SIGNATURE EXISTS FOR. The left block here is a real
    // truecolor row in lib/sprite-render.js's own shape: two visible cells carried by
    // dozens of code points of escape. A join that counted the string would put the box
    // far off the right of the screen; one that counted CELLS but measured them itself
    // would have to strip the escapes first, which is the job this module refuses to do.
    // The count is asserted below rather than asserted in this sentence.
    const escaped = `${ESC}[0m${ESC}[38;2;255;0;0m▀${ESC}[0m${ESC}[38;2;0;255;0m▀${ESC}[0m`
    const lines = join({ spriteLines: [escaped], boxLines: ['B0'], spriteWidth: 2 })
    expect(lines[0]).toBe(`${escaped}  B0`)
    // ...and the offset is the stated width and the gap, counted in code points off the
    // START of the line — measured here with the escapes taken out, which is the only
    // ruler under which the claim means anything.
    const visible = [...lines[0].replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')]
    expect(visible.join('')).toBe('▀▀  B0')
    expect(visible.indexOf('B')).toBe(2 + GAP)
    // ...and the string really is mostly escape, which is what makes the paragraph above
    // a statement about this case rather than about an imagined one.
    expect([...escaped].length).toBeGreaterThan(40)
  })

  it('counts the sprite’s width in code points, not UTF-16 units', () => {
    // The same rule lib/banner-compose.js's `visibleWidth` states: a surrogate pair is one
    // column. It is asserted through the INDENT rather than through a measurement, because
    // this module never measures — what has to be true is that the number a caller states
    // in code points is the number of columns of air a surplus row gets.
    const lines = join({ spriteLines: ['🦆'], boxLines: ['B0', 'B1'], spriteWidth: 1 })
    expect([...'🦆']).toHaveLength(1)
    expect('🦆'.length).toBe(2)
    expect(lines).toEqual(['🦆  B0', `${' '.repeat(1 + GAP)}B1`])
  })

  it('defaults the gap to BESIDE_GAP, and honours a gap it is given', () => {
    // The gap is the ladder's number too — `bannerLayout` subtracts it to decide whether
    // there is room for a box beside the sprite at all — so it is stated once, in the half
    // that owns columns, and this module's default IS that constant rather than a second
    // copy of it. Asserted as an equality between the default and an explicit pass, so the
    // test cannot pass by agreeing with a typo about what the number is.
    expect(BESIDE_GAP).toBe(2)
    expect(join({ spriteLines: ['L0'], boxLines: ['B0'] })).toEqual([`L0${' '.repeat(BESIDE_GAP)}B0`])
    expect(join({ spriteLines: ['L0'], boxLines: ['B0'], gap: 5 })).toEqual(['L0     B0'])
    expect(join({ spriteLines: ['L0'], boxLines: ['B0'], gap: 0 })).toEqual(['L0B0'])
  })

  it('never throws for a width, a gap or a list a caller can get wrong', () => {
    // TOTAL, on the rule the whole banner is built on: a picture is never worth losing a
    // run over. A negative width would reach `' '.repeat(-1)` and throw a RangeError, and
    // this function runs before the first preflight line of `ralph start`.
    for (const spriteWidth of [undefined, null, -1, 0.5, Number.NaN, Infinity, '26', {}]) {
      expect(() => joinBeside({ spriteLines: ['L0'], boxLines: ['B0'], spriteWidth })).not.toThrow()
    }
    for (const gap of [undefined, null, -1, 0.5, Number.NaN, Infinity, '2', {}]) {
      expect(() => join({ spriteLines: ['L0'], boxLines: ['B0'], gap })).not.toThrow()
    }
    for (const lists of [{}, { spriteLines: null }, { boxLines: 'nope' }, { spriteLines: 7 }]) {
      expect(() => joinBeside(lists)).not.toThrow()
    }
    expect(joinBeside()).toEqual([])
  })

  it('refuses a width or a gap above BESIDE_MAX_COLUMNS instead of allocating it', () => {
    // A SIZE AND NOT ONLY A SHAPE, which is the second half of the paragraph above and the
    // half the eight values in it cannot show: every one of them is the WRONG KIND of
    // number, and a column count can also be the right kind and still be impossible.
    // `' '.repeat(1e9)` is a RangeError of its own — V8 will not make a string that long —
    // so a caller stating a billion columns would have thrown from inside a picture on the
    // very guard that exists to stop that. Same shape as `SPLASH_MAX_FRAMES` in
    // lib/sprite-player.js, and the same recovery: over the line is a mistake, and a
    // mistake falls back rather than throwing or clamping.
    expect(BESIDE_MAX_COLUMNS).toBe(1000)
    for (const huge of [1e9, 2 ** 29, 2 ** 31, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
      expect(() => join({ spriteLines: ['L0'], boxLines: ['B0'], gap: huge })).not.toThrow()
      expect(() =>
        joinBeside({ spriteLines: ['L0'], boxLines: ['B0'], spriteWidth: huge }),
      ).not.toThrow()
    }
    // ...and the recovery is the ordinary one, read off a surplus row — the only row whose
    // left edge is made of the stated width and the gap. A width it will not spend is worth
    // no columns; a gap it will not spend is worth the ladder's two.
    const surplus = (options) =>
      joinBeside({ spriteLines: ['L0'], boxLines: ['B0', 'B1'], ...options })[1]
    expect(surplus({ spriteWidth: 1e9 })).toBe(`${' '.repeat(BESIDE_GAP)}B1`)
    expect(surplus({ spriteWidth: 4, gap: 1e9 })).toBe(`${' '.repeat(4 + BESIDE_GAP)}B1`)
    // The line itself is where a real number stops and a mistake starts, so both sides of
    // it are pinned: the ceiling is spendable, one column past it is not.
    expect(surplus({ spriteWidth: BESIDE_MAX_COLUMNS, gap: 0 })).toBe(
      ' '.repeat(BESIDE_MAX_COLUMNS) + 'B1',
    )
    expect(surplus({ spriteWidth: BESIDE_MAX_COLUMNS + 1, gap: 0 })).toBe('B1')
  })
})

describe('banner-beside — purity', () => {
  const code = () => codeWithoutComments(new URL('./banner-beside.js', import.meta.url))

  it('reads no clock, no environment and no filesystem', () => {
    // Same method and the same reason as lib/banner-compose.js's own purity spec: the
    // ABSENCE of a capability cannot be shown by exercising happy paths.
    const source = code()
    expect(source).not.toMatch(/\bprocess\b/)
    expect(source).not.toMatch(/\bDate\b/)
    expect(source).not.toMatch(/Math\s*\.\s*random/)
    expect(source).not.toMatch(/\brequire\s*\(/)
    expect(source).not.toMatch(/node:(fs|os|path|child_process|tty)/)
    expect(source).not.toMatch(/picocolors/)
    // ONE import, and it is a RULE rather than a helper — the gap the ladder subtracts,
    // borrowed from the half that owns columns so the two cannot disagree about it. The
    // edge runs one way: lib/banner-compose.js knows nothing about this file.
    expect([...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1])).toEqual([
      './banner-compose.js',
    ])
  })

  it('writes not one escape byte of its own', () => {
    // The one property that distinguishes this module from every other one in the banner:
    // it JOINS painted lines and paints nothing. An `ESC` here would be a second place a
    // terminal line could be corrupted, downstream of the clip that made the first one
    // safe (see `render` in lib/banner-compose.js, which is where that ordering lives).
    const source = code()
    expect(source).not.toContain(ESC)
    expect(source).not.toMatch(/u001B|x1[bB]|\\033|\\e\[/)
  })
})
