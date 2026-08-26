// #66 — the pure renderer's spec.
//
// The acceptance criterion is specific about the method: "Renderer tests use a
// hand-written 4x4 grid whose every cell is reasoned about explicitly — no large
// snapshots." So the centrepiece below is one 4x4 grid, one comment table that
// walks all sixteen pixels, and two fully spelled-out expected lines. If a future
// change alters one escape sequence, the diff points at the cell that changed
// rather than at a wall of unreadable control codes.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderSprite, LOWER_HALF_BLOCK, UPPER_HALF_BLOCK } from './sprite-render.js'

const ESC = '\u001B'
// Spelled out here rather than imported from the module under test: an
// expectation assembled from the implementation's own constants would agree with
// a typo in them.
const RESET = `${ESC}[0m`
const RED = `${ESC}[38;2;255;0;0m`
const RED_BG = `${ESC}[48;2;255;0;0m`
const GREEN_FG = `${ESC}[38;2;0;255;0m`
const GREEN_BG = `${ESC}[48;2;0;255;0m`
const BLUE_FG = `${ESC}[38;2;0;0;255m`
const BLUE_BG = `${ESC}[48;2;0;0;255m`
const UPPER = '▀'
const LOWER = '▄'

// Palette index 0 = red, 1 = green, 2 = blue. Rows encode one pixel per
// character: base36 digit = palette index, '.' = transparent.
const PALETTE = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
]

describe('renderSprite — the hand-written 4x4 grid', () => {
  // The grid, and every one of its sixteen cells:
  //
  //        col 0        col 1        col 2        col 3
  //  row0  '0' red      '.' none     '1' green    '.' none
  //  row1  '.' none     '1' green    '2' blue     '.' none
  //  row2  '2' blue     '.' none     '.' none     '0' red
  //  row3  '0' red      '1' green    '.' none     '.' none
  //
  // Rows pair up two at a time, so this is two text rows of four cells each.
  //
  // TEXT ROW 0 (pixel rows 0 and 1):
  //   col0  top red, bottom none  -> reset, then red FOREGROUND on the upper
  //                                  half block. The reset is mandatory: without
  //                                  it the bottom half keeps whatever background
  //                                  the cell to its left left behind.
  //   col1  top none, bottom green-> reset, then green FOREGROUND on the LOWER
  //                                  half block. Deliberately not "upper block
  //                                  with a green background": that paints the
  //                                  upper half in the terminal's default
  //                                  foreground colour, i.e. visible ink exactly
  //                                  where the sprite is supposed to be see-
  //                                  through. This is why the renderer needs two
  //                                  glyphs, not one.
  //   col2  top green, bottom blue-> green foreground + blue background on the
  //                                  upper block. No reset needed: setting both
  //                                  attributes leaves nothing inherited.
  //   col3  both none             -> reset, then a plain space.
  //
  // TEXT ROW 1 (pixel rows 2 and 3):
  //   col0  top blue, bottom red  -> blue foreground + red background, upper block.
  //   col1  top none, bottom green-> reset + green foreground, lower block.
  //   col2  both none             -> reset + space.
  //   col3  top red, bottom none  -> reset + red foreground, upper block.
  //
  // Every line then ends with a reset so the sprite cannot colour the rest of
  // the terminal line.
  const rows = ['0.1.', '.12.', '2..0', '01..']

  it('renders both text rows exactly', () => {
    expect(renderSprite({ palette: PALETTE, rows })).toEqual([
      `${RESET}${RED}${UPPER}` +
        `${RESET}${GREEN_FG}${LOWER}` +
        `${GREEN_FG}${BLUE_BG}${UPPER}` +
        `${RESET} ` +
        RESET,
      `${BLUE_FG}${RED_BG}${UPPER}` +
        `${RESET}${GREEN_FG}${LOWER}` +
        `${RESET} ` +
        `${RESET}${RED}${UPPER}` +
        RESET,
    ])
  })

  it('uses U+2580 for a top-half pixel and U+2584 for a bottom-half one', () => {
    expect(UPPER_HALF_BLOCK).toBe('▀')
    expect(LOWER_HALF_BLOCK).toBe('▄')
    const [first] = renderSprite({ palette: PALETTE, rows })
    expect(first).toContain(UPPER_HALF_BLOCK)
    expect(first).toContain(LOWER_HALF_BLOCK)
  })

  it('resets before every cell that has a transparent half', () => {
    // Stated as its own property because it is the one thing a reader cannot see
    // by eye: the cell after a coloured background must not inherit it.
    const [, second] = renderSprite({ palette: PALETTE, rows })
    // ...blue-on-red block, then the transparent-top cell, which resets first.
    expect(second).toContain(`${UPPER}${RESET}${GREEN_FG}${LOWER}`)
  })

  it('never emits a background colour for a transparent bottom half', () => {
    // Any `48;2` in a line whose bottom pixel is transparent would paint the
    // background of a cell that must show the terminal through.
    const [line] = renderSprite({ palette: PALETTE, rows: ['012', '...'] })
    expect(line).not.toContain('48;2')
    expect(line).toBe(
      `${RESET}${RED}${UPPER}${RESET}${GREEN_FG}${UPPER}${RESET}${BLUE_FG}${UPPER}${RESET}`,
    )
  })

  it('emits a background colour when the bottom half is opaque', () => {
    const [line] = renderSprite({ palette: PALETTE, rows: ['1', '1'] })
    expect(line).toBe(`${GREEN_FG}${GREEN_BG}${UPPER}${RESET}`)
  })
})

describe('renderSprite — row pairing', () => {
  it('emits ceil(N/2) text rows for N pixel rows', () => {
    const grid = (n) => new Array(n).fill('00')
    for (const [pixelRows, textRows] of [
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 3],
      [34, 17],
    ]) {
      expect(renderSprite({ palette: PALETTE, rows: grid(pixelRows) })).toHaveLength(textRows)
    }
  })

  it('pairs a trailing odd row against transparency', () => {
    // Three rows: the third has no partner, so its cells render as top-only —
    // identical to what an explicit row of dots would produce.
    const odd = renderSprite({ palette: PALETTE, rows: ['00', '00', '01'] })
    const explicit = renderSprite({ palette: PALETTE, rows: ['00', '00', '01', '..'] })
    expect(odd).toEqual(explicit)
    expect(odd[1]).toBe(`${RESET}${RED}${UPPER}${RESET}${GREEN_FG}${UPPER}${RESET}`)
  })

  it('returns an empty array for an empty grid', () => {
    expect(renderSprite({ palette: PALETTE, rows: [] })).toEqual([])
  })

  it('renders a fully transparent grid as spaces, not colours', () => {
    expect(renderSprite({ palette: PALETTE, rows: ['..', '..'] })).toEqual([
      `${RESET} ${RESET} ${RESET}`,
    ])
  })
})

describe('renderSprite — the base36 index encoding', () => {
  it('reads two-digit indices as base36 letters', () => {
    // 11 colours means index 10 is 'a'. Without base36 the emitter would need a
    // separator per pixel and the hand-written grids above would be unreadable.
    const palette = []
    for (let i = 0; i < 11; i += 1) palette.push([i, i, i])
    const [line] = renderSprite({ palette, rows: ['a'] })
    expect(line).toBe(`${RESET}${ESC}[38;2;10;10;10m${UPPER}${RESET}`)
  })

  it('rejects an uppercase letter, so the encoding has exactly one spelling', () => {
    const palette = []
    for (let i = 0; i < 11; i += 1) palette.push([i, i, i])
    expect(() => renderSprite({ palette, rows: ['A'] })).toThrow(RangeError)
  })
})

describe('renderSprite — validation', () => {
  it('names the row and column of an unknown character', () => {
    expect(() => renderSprite({ palette: PALETTE, rows: ['00', '0?'] })).toThrow(
      /row 1.*column 1|column 1.*row 1/,
    )
    expect(() => renderSprite({ palette: PALETTE, rows: ['00', '0?'] })).toThrow(RangeError)
  })

  it('names the row and column of an index past the end of the palette', () => {
    // '2' is the last valid index for a 3-colour palette, so '3' is off the end.
    expect(() => renderSprite({ palette: PALETTE, rows: ['02', '30'] })).toThrow(
      /row 1.*column 0|column 0.*row 1/,
    )
    expect(() => renderSprite({ palette: PALETTE, rows: ['3'] })).toThrow(RangeError)
  })

  it('rejects a ragged grid, naming the row that does not match', () => {
    expect(() => renderSprite({ palette: PALETTE, rows: ['00', '000'] })).toThrow(/row 1/)
    expect(() => renderSprite({ palette: PALETTE, rows: ['00', '000'] })).toThrow(RangeError)
  })

  it('rejects rows that are not an array of strings', () => {
    expect(() => renderSprite({ palette: PALETTE, rows: '00' })).toThrow(TypeError)
    expect(() => renderSprite({ palette: PALETTE, rows: [['0', '0']] })).toThrow(TypeError)
    expect(() => renderSprite({ palette: PALETTE, rows: [null] })).toThrow(TypeError)
    expect(() => renderSprite({ palette: PALETTE })).toThrow(TypeError)
  })

  it('rejects a malformed palette', () => {
    expect(() => renderSprite({ palette: 'red', rows: ['0'] })).toThrow(TypeError)
    expect(() => renderSprite({ palette: [[1, 2]], rows: ['0'] })).toThrow(TypeError)
    expect(() => renderSprite({ palette: [[1, 2, 3, 4]], rows: ['0'] })).toThrow(TypeError)
    expect(() => renderSprite({ palette: ['#fff'], rows: ['0'] })).toThrow(TypeError)
    expect(() => renderSprite({ palette: [[1, 2, null]], rows: ['0'] })).toThrow(TypeError)
  })

  it('rejects a channel that is not an integer in 0..255', () => {
    expect(() => renderSprite({ palette: [[0, 0, 256]], rows: ['0'] })).toThrow(RangeError)
    expect(() => renderSprite({ palette: [[-1, 0, 0]], rows: ['0'] })).toThrow(RangeError)
    expect(() => renderSprite({ palette: [[0, 0.5, 0]], rows: ['0'] })).toThrow(RangeError)
  })

  it('rejects a call with no argument at all', () => {
    expect(() => renderSprite()).toThrow(TypeError)
  })

  it('names the offending palette entry in the message', () => {
    expect(() => renderSprite({ palette: [[0, 0, 0], [1, 2]], rows: ['0'] })).toThrow(/entry 1/)
  })
})

describe('renderSprite — purity', () => {
  it('reads no module, no clock, no environment and no filesystem', () => {
    // Criterion 5 is "no I/O, no clock, no environment access". A static read of
    // the source is the only way to assert the ABSENCE of a capability: a unit
    // test can only show that the paths it happens to exercise stay quiet.
    const source = readFileSync(new URL('./sprite-render.js', import.meta.url), 'utf8')
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')

    expect(code).not.toMatch(/^import\s/m)
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/\bprocess\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/node:(fs|os|path|child_process)/)
    // And it really is the module under test.
    expect(code).toMatch(/export function renderSprite/)
  })
})
