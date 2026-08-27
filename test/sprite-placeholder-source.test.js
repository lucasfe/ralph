// #67 — the PLACEHOLDER source GIF, and the provenance of the committed asset.
//
// READ THIS FIRST: the real Wreck-It Ralph GIF is not in this repository and never
// will be (#66 made it a developer-supplied input, and it is not ours to ship). So
// lib/sprite-data.js currently holds a placeholder figure, synthesized by
// scripts/placeholder-sprite-source.js and then put through the REAL generator.
// This file is what makes that honest:
//
//   * the art itself is checked against the four things the generator needs from
//     any source GIF (a rectangular grid, ink on all four edges so the bounding box
//     is the whole figure, a near-black background, a palette inside the budget);
//   * the committed lib/sprite-data.js is compared BYTE FOR BYTE against what the
//     pipeline produces from the placeholder right now. So the asset cannot be
//     hand-edited, cannot drift from the art, and is provably generator output.
//
// THIS FILE IS DELETED WITH THE PLACEHOLDER. `node scripts/generate-sprite.js
// ralph.gif` overwrites lib/sprite-data.js and the provenance assertion below fails
// loudly, which is the point — it is the reminder. For the full list of what to
// remove, run `node scripts/placeholder-sprite-source.js`: it prints the checklist.
//
// The specs that outlive all of it are lib/sprite-data.test.js (shape and integrity of
// whatever asset is committed) and lib/sprite-banner.test.js.

import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ART_FRAMES,
  ART_HEIGHT,
  ART_WIDTH,
  BACKGROUND,
  LEGEND,
  MARGIN,
  SCALE,
  TRANSPARENT_ART_CELL,
  placeholderGif,
} from '../scripts/lib/placeholder-art.js'
import { decodeGif } from '../scripts/lib/gif-decode.js'
import { DEFAULT_COLOR_COUNT, DEFAULT_GRID, NEAR_BLACK_MAX, buildSprite } from '../scripts/lib/sprite-build.js'
import { emitSpriteModule } from '../scripts/lib/emit-sprite-module.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'scripts', 'placeholder-sprite-source.js')
const ASSET = join(REPO_ROOT, 'lib', 'sprite-data.js')

const workDirs = []

afterAll(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true })
})

function workDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-placeholder-'))
  workDirs.push(dir)
  return dir
}

const inkMask = (rows) =>
  rows.map((row) => [...row].map((cell) => (cell === TRANSPARENT_ART_CELL ? 0 : 1)).join(''))

describe('the placeholder art', () => {
  it('is a rectangular 26x34 grid in every frame', () => {
    // 26x34 is the grid the generator downsamples to (DEFAULT_GRID), and the art is
    // drawn at exactly that resolution and then scaled up — see the module header.
    expect({ width: ART_WIDTH, height: ART_HEIGHT }).toEqual(DEFAULT_GRID)
    expect(ART_FRAMES).toHaveLength(2)
    for (const [index, rows] of ART_FRAMES.entries()) {
      expect(rows, `frame ${index}`).toHaveLength(ART_HEIGHT)
      for (const [y, row] of rows.entries()) {
        expect(row, `frame ${index} row ${y}`).toHaveLength(ART_WIDTH)
      }
    }
  })

  it('draws only characters the legend knows', () => {
    const unknown = []
    for (const [index, rows] of ART_FRAMES.entries()) {
      for (const [y, row] of rows.entries()) {
        for (const cell of row) {
          if (cell === TRANSPARENT_ART_CELL || LEGEND.has(cell)) continue
          unknown.push(`frame ${index} row ${y}: ${JSON.stringify(cell)}`)
        }
      }
    }
    expect(unknown).toEqual([])
  })

  it('puts ink on all four edges, so the bounding box is the whole grid', () => {
    // Otherwise the generator's crop would shrink the figure and the committed asset
    // would no longer be a 1:1 scale-down of the art — the property that makes this
    // placeholder legible at 26 cells.
    const rows = ART_FRAMES[0]
    const ink = (cell) => cell !== TRANSPARENT_ART_CELL
    expect([...rows[0]].some(ink), 'top row').toBe(true)
    expect([...rows[ART_HEIGHT - 1]].some(ink), 'bottom row').toBe(true)
    expect(rows.some((row) => ink(row[0])), 'left column').toBe(true)
    expect(rows.some((row) => ink(row[ART_WIDTH - 1])), 'right column').toBe(true)
  })

  it('gives both frames the SAME ink mask, because disposal 1 composites', () => {
    // The frames are drawn with disposal method 1 ("leave what you drew") and the
    // near-black background classifies as transparent, so frame 1 is painted OVER
    // frame 0. A cell that is ink in frame 0 and background in frame 1 would not
    // erase — it would ghost. So the animation is only ever a RECOLOUR.
    expect(inkMask(ART_FRAMES[1])).toEqual(inkMask(ART_FRAMES[0]))
  })

  it('makes the two frames differ, so there is something to animate later', () => {
    expect(ART_FRAMES[1]).not.toEqual(ART_FRAMES[0])
  })

  it('paints a background the near-black rule reads as transparent', () => {
    expect(BACKGROUND[0] + BACKGROUND[1] + BACKGROUND[2]).toBeLessThanOrEqual(NEAR_BLACK_MAX)
  })

  it('keeps every ink colour above the near-black cut, and inside the palette budget', () => {
    // An ink colour at or below the cut would be classified as background and punch a
    // hole in the figure; more colours than the budget would make the committed
    // palette a k-means approximation of the art instead of the art.
    expect(LEGEND.size).toBeLessThanOrEqual(DEFAULT_COLOR_COUNT)
    for (const [character, color] of LEGEND) {
      expect(color, character).toHaveLength(3)
      expect(color[0] + color[1] + color[2], character).toBeGreaterThan(NEAR_BLACK_MAX)
    }
  })
})

describe('the placeholder GIF', () => {
  it('is deterministic — two calls, identical bytes', () => {
    const first = Buffer.from(placeholderGif())
    const second = Buffer.from(placeholderGif())
    expect(first.equals(second)).toBe(true)
    expect(first.subarray(0, 6).toString('ascii')).toBe('GIF89a')
  })

  it('crops to a box that downsamples to the grid with no remainder', () => {
    const sprite = buildSprite(decodeGif(placeholderGif()))
    expect(sprite.box).toEqual({
      left: MARGIN,
      top: MARGIN,
      width: ART_WIDTH * SCALE,
      height: ART_HEIGHT * SCALE,
    })
    expect(sprite.box.width % ART_WIDTH).toBe(0)
    expect(sprite.box.height % ART_HEIGHT).toBe(0)
    expect(sprite.width).toBe(ART_WIDTH)
    expect(sprite.height).toBe(ART_HEIGHT)
  })

  it('survives the round trip: every art cell comes back as itself', () => {
    // The scale-up/downsample pair must be lossless, or "placeholder art" and
    // "committed asset" are two different pictures. Checked by mapping the palette
    // back to legend characters rather than by eyeballing the rows.
    const sprite = buildSprite(decodeGif(placeholderGif()))
    const characterFor = new Map(
      [...LEGEND].map(([character, color]) => [color.join(','), character]),
    )
    const decoded = sprite.frames.map((frame) =>
      frame.rows.map((row) =>
        [...row]
          .map((cell) =>
            cell === '.'
              ? TRANSPARENT_ART_CELL
              : characterFor.get(sprite.palette[parseInt(cell, 36)].join(',')),
          )
          .join(''),
      ),
    )
    expect(decoded).toEqual(ART_FRAMES)
  })

  it('holds two 200ms frames', () => {
    const gif = decodeGif(placeholderGif())
    expect(gif.frames.map((frame) => frame.delayMs)).toEqual([200, 200])
    expect(gif.frames.map((frame) => frame.disposal)).toEqual([1, 1])
  })
})

describe('provenance: lib/sprite-data.js is generator output, not a hand edit', () => {
  it('matches what the real pipeline emits for the placeholder, byte for byte', () => {
    // The exact composition scripts/generate-sprite.js performs, with its defaults —
    // so this is the committed file's regeneration recipe, executed.
    const emitted = emitSpriteModule(buildSprite(decodeGif(placeholderGif())))
    expect(emitted).toBe(readFileSync(ASSET, 'utf8'))
  })
})

describe('scripts/placeholder-sprite-source.js — the CLI a developer runs', () => {
  it('writes a GIF where it is told and says what to do with it', () => {
    const dir = workDir()
    const out = join(dir, 'placeholder.gif')
    const result = spawnSync(process.execPath, [SCRIPT, '--out', out], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(out).subarray(0, 6).toString('ascii')).toBe('GIF89a')
    // The one-command swap has to be in front of whoever runs this, not only in a
    // comment: this script exists solely because the real art is missing.
    expect(result.stdout).toMatch(/placeholder/i)
    expect(result.stdout).toContain('scripts/generate-sprite.js')
  })

  it('produces byte-identical bytes when run twice', () => {
    const dir = workDir()
    for (const name of ['first.gif', 'second.gif']) {
      const result = spawnSync(process.execPath, [SCRIPT, '--out', join(dir, name)], {
        encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(0)
    }
    const [first, second] = ['first.gif', 'second.gif'].map((name) =>
      readFileSync(join(dir, name)),
    )
    expect(first.equals(second)).toBe(true)
  })

  it('rejects an unknown flag instead of ignoring it', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--wdith', '26'], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unknown|usage/i)
  })
})

// PACKAGING — that none of this ships — is asserted where it can be asserted properly:
// test/sprite-placeholder-source.qa.test.js asks `npm pack --dry-run --json` for the
// real manifest and then checks the import closure over it. Two weaker greps used to
// live here as well; a pattern's meaning is npm's opinion, not a regex's.
