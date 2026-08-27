// #67 — the spec for the COMMITTED asset, not for the generator that made it.
//
// lib/sprite-data.js is generated (see scripts/generate-sprite.js) and generated
// files are exactly the ones nobody proofreads. So this file asserts the two
// properties the rest of the banner takes for granted:
//
//   * ITS SHAPE. 26 cells wide, 34 pixel rows tall — i.e. 17 text rows once
//     lib/sprite-render.js pairs the rows into half-block glyphs. Those numbers are
//     a layout contract with #68's box, so they are pinned here as literals rather
//     than derived from the file's own exports (an assertion that reads
//     `spriteWidth` and then compares it to `spriteWidth` proves nothing).
//   * ITS INTEGRITY. Every character of every row resolves to a palette entry.
//     A row referring to index 11 of a 10-colour palette is a file the renderer
//     throws on, and it would throw inside `ralph start` — before any preflight,
//     on the very first line of output.
//
// Deliberately NOT asserted: which colours are in the palette or what the figure
// looks like. The art is a placeholder pending the real GIF (see
// scripts/placeholder-sprite-source.js), and pinning pixels would turn swapping it
// into a test-editing exercise.

import { describe, expect, it } from 'vitest'
import { frames, palette, spriteHeight, spriteWidth } from './sprite-data.js'
import {
  LOWER_HALF_BLOCK,
  PALETTE_INDEX_CHARS,
  TRANSPARENT_CELL,
  UPPER_HALF_BLOCK,
  renderSprite,
} from './sprite-render.js'

// One cell of a rendered line is exactly one of these three glyphs, whatever
// escape sequences surround it — so counting them counts columns.
const CELL_GLYPHS = new Set([UPPER_HALF_BLOCK, LOWER_HALF_BLOCK, ' '])

function cellCount(line) {
  return [...line].filter((character) => CELL_GLYPHS.has(character)).length
}

describe('lib/sprite-data.js — the committed asset', () => {
  it('is 26 cells wide and 34 pixel rows tall', () => {
    expect(spriteWidth).toBe(26)
    expect(spriteHeight).toBe(34)
  })

  it('holds every row at the declared size, in every frame', () => {
    expect(frames.length).toBeGreaterThanOrEqual(1)
    frames.forEach((frame, index) => {
      expect(frame.rows, `frame ${index}`).toHaveLength(34)
      frame.rows.forEach((row, y) => {
        expect(row, `frame ${index} row ${y}`).toHaveLength(26)
      })
    })
  })

  it('resolves every index in every frame to a palette entry', () => {
    expect(palette.length).toBeGreaterThan(0)
    expect(palette.length).toBeLessThanOrEqual(PALETTE_INDEX_CHARS.length)

    // Collected rather than asserted per character: a bad row should name every
    // offender at once, because a mis-sized palette breaks thousands of cells and
    // one "expected 0 to be 1" tells the reader nothing about which.
    const unresolved = []
    frames.forEach((frame, index) => {
      frame.rows.forEach((row, y) => {
        for (let x = 0; x < row.length; x += 1) {
          const character = row[x]
          if (character === TRANSPARENT_CELL) continue
          const paletteIndex = PALETTE_INDEX_CHARS.indexOf(character)
          if (paletteIndex >= 0 && paletteIndex < palette.length) continue
          unresolved.push(`frame ${index} row ${y} column ${x}: ${JSON.stringify(character)}`)
        }
      })
    })
    expect(unresolved).toEqual([])
  })

  it('declares a palette of RGB triples', () => {
    for (const [index, entry] of palette.entries()) {
      expect(entry, `entry ${index}`).toHaveLength(3)
      for (const channel of entry) {
        expect(Number.isInteger(channel)).toBe(true)
        expect(channel).toBeGreaterThanOrEqual(0)
        expect(channel).toBeLessThanOrEqual(255)
      }
    }
  })

  // The per-frame delay contract lives in sprite-data.qa.test.js ("a positive
  // whole-millisecond delay"), and only there. This file used to assert a weaker
  // version of the same thing — finite and non-negative — which meant a regenerated
  // asset with `delayMs: 0` would have made one spec green and the other red, leaving
  // a maintainer to guess which one was the rule. One statement of it, the strict one.

  it('renders through the shipped renderer as 17 text rows of 26 cells', () => {
    for (const [index, frame] of frames.entries()) {
      const lines = renderSprite({ palette, rows: frame.rows })
      expect(lines, `frame ${index}`).toHaveLength(17)
      for (const line of lines) expect(cellCount(line)).toBe(26)
    }
  })
})
