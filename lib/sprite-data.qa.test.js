// #67 QA — the committed asset, attacked as a GENERATED file that ships.
//
// sprite-data.test.js pins the two properties the banner takes for granted: the
// 26x34 shape, and that every index resolves. This file is the harder version of the
// same audit, because lib/sprite-data.js is the one file in the package that nobody
// writes and nobody proofreads, and `ralph start` evaluates it before it does
// anything else — a corrupt row is a TypeError above the first preflight line, not a
// missing picture.
//
// What is checked here that is not checked there:
//
//   * SELF-CONSISTENCY, derived instead of literal. `spriteWidth`/`spriteHeight` must
//     agree with the rows, and every frame with every other frame. The dev's spec
//     compares both to the literals 26 and 34, which is the layout contract; this one
//     compares them to each other, which is what catches a regenerated asset that
//     changed size and updated only its exports.
//   * THE PALETTE AS A BUDGET. No duplicate colours, no slot nothing refers to. Both
//     are silent waste today and a wrong picture tomorrow, since 36 slots is the hard
//     ceiling the base36 encoding imposes.
//   * WHAT A TERMINAL RECEIVES. Every rendered line ends in a reset, carries no
//     newline of its own, and contains nothing but SGR sequences and the three cell
//     glyphs — the sprite must not be able to colour the rest of the screen or
//     double-space itself when `out()` adds the newline.
//   * PROVENANCE THAT OUTLIVES THE PLACEHOLDER. test/sprite-placeholder-source.test.js
//     proves the file is generator output by regenerating it, and that spec is deleted
//     the day the real GIF lands. The weaker-but-permanent guard — the GENERATED
//     header, no imports, exactly four exports — lives here.
//
// Deliberately NOT asserted, for the same reason the dev's spec avoids it: which
// colours are in the palette, or what the figure looks like. The art is a placeholder
// (see scripts/placeholder-sprite-source.js) and pinning pixels would turn swapping it
// into a test-editing exercise.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as spriteData from './sprite-data.js'
import { frames, palette, spriteHeight, spriteWidth } from './sprite-data.js'
import { PALETTE_INDEX_CHARS, TRANSPARENT_CELL, renderSprite } from './sprite-render.js'

const ESC = '\u001B'
const RESET = `${ESC}[0m`
const UPPER = '▀'
const LOWER = '▄'
const SGR = /\u001B\[[0-9;]*m/g

const SOURCE = readFileSync(new URL('./sprite-data.js', import.meta.url), 'utf8')

describe('QA lib/sprite-data.js — the asset agrees with itself', () => {
  it('declares dimensions the rows actually have, in every frame', () => {
    expect(frames.length).toBeGreaterThan(0)
    for (const [index, frame] of frames.entries()) {
      expect(frame.rows, `frame ${index} height`).toHaveLength(spriteHeight)
      for (const [y, row] of frame.rows.entries()) {
        expect(typeof row, `frame ${index} row ${y}`).toBe('string')
        expect(row, `frame ${index} row ${y}`).toHaveLength(spriteWidth)
      }
    }
  })

  it('gives every frame the same dimensions as every other frame', () => {
    // #73 will cycle these in place. Two frames of different sizes would redraw the
    // terminal at two different heights, and the shorter one would leave the taller
    // one's bottom rows on screen.
    const shapes = frames.map((frame) => `${frame.rows.length}x${frame.rows[0].length}`)
    expect(new Set(shapes).size, shapes.join(' ')).toBe(1)
  })

  it('has an even height, so no text row is half a sprite row', () => {
    // 17 text rows is ceil(34/2). An odd-height asset still renders — the renderer
    // pairs the last row against transparency — but its bottom row would be half
    // height, and #68's box is drawn around a rectangle.
    expect(spriteHeight % 2).toBe(0)
    expect(Math.ceil(spriteHeight / 2)).toBe(17)
  })
})

describe('QA lib/sprite-data.js — the palette as a 36-slot budget', () => {
  it('holds nothing but integer RGB triples in arrays', () => {
    expect(Array.isArray(palette)).toBe(true)
    expect(palette.length).toBeGreaterThan(0)
    expect(palette.length).toBeLessThanOrEqual(PALETTE_INDEX_CHARS.length)
    for (const [index, entry] of palette.entries()) {
      // Array.isArray, not toHaveLength: a three-character STRING satisfies a length
      // check and reaches the escape-sequence builder as three characters.
      expect(Array.isArray(entry), `entry ${index}`).toBe(true)
      expect(entry, `entry ${index}`).toHaveLength(3)
      for (const [channelIndex, channel] of entry.entries()) {
        expect(typeof channel, `entry ${index} channel ${channelIndex}`).toBe('number')
        expect(Number.isInteger(channel), `entry ${index} channel ${channelIndex}`).toBe(true)
        expect(channel, `entry ${index} channel ${channelIndex}`).toBeGreaterThanOrEqual(0)
        expect(channel, `entry ${index} channel ${channelIndex}`).toBeLessThanOrEqual(255)
      }
    }
  })

  it('spends no slot twice', () => {
    // Two slots holding the same colour is a quantizer that clustered badly, and it
    // costs a slot out of 36 for nothing. It also breaks any reverse colour→index
    // map, which is how the placeholder's round-trip spec reads the asset back.
    const seen = new Map()
    const duplicates = []
    palette.forEach((entry, index) => {
      const key = entry.join(',')
      if (seen.has(key)) duplicates.push(`entries ${seen.get(key)} and ${index}: [${key}]`)
      else seen.set(key, index)
    })
    expect(duplicates).toEqual([])
  })

  it('leaves no slot that no frame refers to', () => {
    // An unused entry means the emitted palette and the emitted rows disagree about
    // what the picture needs — most likely a crop or a colour count that changed
    // without the other half being regenerated.
    const used = new Set()
    for (const frame of frames) {
      for (const row of frame.rows) {
        for (const character of row) {
          if (character !== TRANSPARENT_CELL) used.add(PALETTE_INDEX_CHARS.indexOf(character))
        }
      }
    }
    const unused = palette.map((_entry, index) => index).filter((index) => !used.has(index))
    expect(unused).toEqual([])
  })
})

describe('QA lib/sprite-data.js — rows hold only what the renderer decodes', () => {
  it('uses no character outside the lowercase base36 alphabet and the transparent cell', () => {
    // The renderer's own error names the offender, but it throws from inside
    // `ralph start`'s first line of output. An uppercase index, a space or a stray
    // quote is caught here instead.
    const legal = new Set([TRANSPARENT_CELL, ...PALETTE_INDEX_CHARS.slice(0, palette.length)])
    const offenders = []
    frames.forEach((frame, index) => {
      frame.rows.forEach((row, y) => {
        for (let x = 0; x < row.length; x += 1) {
          if (!legal.has(row[x])) {
            offenders.push(`frame ${index} row ${y} column ${x}: ${JSON.stringify(row[x])}`)
          }
        }
      })
    })
    expect(offenders).toEqual([])
  })

  it('gives every frame a positive whole-millisecond delay', () => {
    // #73 hands these to a timer. Zero is a spin and a fraction is a value setTimeout
    // truncates, so both are defects here. This is the ONLY delay assertion in the
    // suite: sprite-data.test.js deliberately holds no weaker copy of it.
    for (const [index, frame] of frames.entries()) {
      expect(Number.isInteger(frame.delayMs), `frame ${index}`).toBe(true)
      expect(frame.delayMs, `frame ${index}`).toBeGreaterThan(0)
    }
  })
})

describe('QA lib/sprite-data.js — what a terminal receives, per frame', () => {
  it('renders every frame as ceil(height/2) lines of exactly spriteWidth cells', () => {
    for (const [index, frame] of frames.entries()) {
      const lines = renderSprite({ palette, rows: frame.rows })
      expect(lines, `frame ${index}`).toHaveLength(Math.ceil(spriteHeight / 2))
      for (const [y, line] of lines.entries()) {
        const cells = line.replace(SGR, '')
        expect(cells, `frame ${index} line ${y}`).toHaveLength(spriteWidth)
        expect(
          [...cells].every((c) => c === UPPER || c === LOWER || c === ' '),
          `frame ${index} line ${y}`,
        ).toBe(true)
      }
    }
  })

  it('ends every line in a reset and puts no newline, tab or carriage return in one', () => {
    for (const [index, frame] of frames.entries()) {
      for (const [y, line] of renderSprite({ palette, rows: frame.rows }).entries()) {
        expect(line.endsWith(RESET), `frame ${index} line ${y}`).toBe(true)
        expect(line, `frame ${index} line ${y}`).not.toMatch(/[\n\r\t]/)
      }
    }
  })

  it('renders the frames differently from each other, so there is a sprite to animate', () => {
    const rendered = frames.map((frame) => renderSprite({ palette, rows: frame.rows }).join('\n'))
    expect(new Set(rendered).size).toBe(frames.length)
  })
})

describe('QA lib/sprite-data.js — provenance, after the placeholder is gone', () => {
  it('still says GENERATED, and still names the command that regenerates it', () => {
    // The byte-for-byte provenance spec in test/sprite-placeholder-source.test.js is
    // deleted with the placeholder. This is the guard that survives: whoever
    // hand-patches a row has to delete a header that tells them not to.
    expect(SOURCE.split('\n')[0]).toBe('// GENERATED FILE — do not edit by hand.')
    expect(SOURCE).toContain('scripts/generate-sprite.js')
    // The header's own dimensions are part of the file's claim about itself.
    expect(SOURCE).toContain(`${spriteWidth}x${spriteHeight} cells, ${frames.length} frame(s)`)
  })

  it('is a data module: no imports, no code, no raw escape bytes', () => {
    expect(SOURCE).not.toMatch(/^import\s/m)
    expect(SOURCE).not.toMatch(/\brequire\s*\(/)
    expect(SOURCE).not.toMatch(/\bfunction\b/)
    // The rows are index characters; a literal escape sequence in here would mean the
    // generator emitted pre-rendered colour, which is the renderer's job.
    expect(SOURCE).not.toContain(ESC)
  })

  it('exports exactly the four names the rest of the sprite code imports', () => {
    // A generated module that grew a fifth export would be a pipeline change nobody
    // reviewed; a missing one is a crash on the first line `ralph start` writes.
    expect(Object.keys(spriteData).sort()).toEqual([
      'frames',
      'palette',
      'spriteHeight',
      'spriteWidth',
    ])
  })
})
