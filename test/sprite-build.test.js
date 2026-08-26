// #66 — the sprite build pipeline's spec: composite → classify transparency →
// bounding box → downsample → quantize → index rows.
//
// Every expectation below is hand-reasoned on a fixture small enough to write
// out in a comment. That is not just taste: the pipeline's job is to throw away
// 99% of its input, so an expectation copied from the implementation's own output
// would lock in whatever it happens to do rather than what it should do.
//
// The rule the issue is emphatic about, and the reason this file has a whole
// describe block for it: the source GIF DECLARES a transparency index (127) and
// then never uses it, painting its background as opaque near-black instead.
// Keying on the declared index yields a bounding box of the entire canvas. So
// transparency here is "channel sum <= NEAR_BLACK_MAX, OR the frame's declared
// index" — and the specs pin both halves of that union.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeGif } from '../scripts/lib/gif-decode.js'
import {
  boundingBox,
  buildSprite,
  canvasPixel,
  compositeFrames,
  downsample,
  quantizePalette,
  DEFAULT_COLOR_COUNT,
  DEFAULT_GRID,
  NEAR_BLACK_MAX,
} from '../scripts/lib/sprite-build.js'
import { emitSpriteModule } from '../scripts/lib/emit-sprite-module.js'
import { buildGif } from './helpers/gif-fixture.js'

// Palette shared by most fixtures. Index 0 is near-black BACKGROUND (channel sum
// 24, exactly on the limit); index 3 is a bright colour the fixtures nominate as
// the "declared" transparency index in one test, to prove the union.
const BACKGROUND = [8, 8, 8] // sum 24 — transparent by the near-black rule
const BARELY_OPAQUE = [9, 8, 8] // sum 25 — one over the limit, so it is ink
const RED = [200, 50, 25]
const GREEN = [10, 200, 30]
const BLUE = [0, 0, 220]
const PALETTE = [BACKGROUND, RED, GREEN, BLUE, BARELY_OPAQUE]

/**
 * A composited canvas as one string per row — '.' for transparent, otherwise the
 * position of the pixel colour in `legend`. Makes a disposal or offset assertion
 * a picture instead of a pile of coordinates.
 */
function mapCanvas(canvas, legend) {
  const rows = []
  for (let y = 0; y < canvas.height; y += 1) {
    let row = ''
    for (let x = 0; x < canvas.width; x += 1) {
      const pixel = canvasPixel(canvas, x, y)
      if (pixel === null) {
        row += '.'
        continue
      }
      const at = legend.findIndex((c) => c[0] === pixel[0] && c[1] === pixel[1] && c[2] === pixel[2])
      row += at < 0 ? '?' : String(at)
    }
    rows.push(row)
  }
  return rows
}

function gif(spec) {
  return decodeGif(buildGif({ palette: PALETTE, ...spec }))
}

describe('transparency: near-black wins over the declared index', () => {
  // A 6x6 canvas painted entirely in near-black background except a 2x2 block of
  // RED at (2,2). The frame DECLARES index 3 (BLUE) transparent — a decoy, since
  // no pixel uses it, exactly like the source GIF's index 127.
  const indices = []
  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 6; x += 1) {
      indices.push(x >= 2 && x <= 3 && y >= 2 && y <= 3 ? 1 : 0)
    }
  }
  // Built per test, not once per describe: a fixture assembled while the suite is
  // being COLLECTED turns any decode failure into "0 tests in this file" instead
  // of a named failing spec.
  const decoy = () =>
    gif({
      width: 6,
      height: 6,
      frames: [{ width: 6, height: 6, indices, transparentIndex: 3 }],
    })

  it('bounds the ink, not the canvas, when the background is opaque near-black', () => {
    const box = boundingBox(compositeFrames(decoy()))
    expect(box).toEqual({ left: 2, top: 2, width: 2, height: 2 })
  })

  it('would bound the whole canvas if only the declared index were trusted', () => {
    // nearBlackMax below zero disables the rule, which is what "trust the
    // transparency index" amounts to. This is the failure the issue describes,
    // reproduced on purpose so the previous test is known to be load-bearing.
    const box = boundingBox(compositeFrames(decoy(), { nearBlackMax: -1 }))
    expect(box).toEqual({ left: 0, top: 0, width: 6, height: 6 })
  })

  it('treats a channel sum equal to the limit as transparent and one over as ink', () => {
    // Three pixels: BACKGROUND (8+8+8 = 24, the limit), BARELY_OPAQUE
    // (9+8+8 = 25) and BACKGROUND again. Only the middle one is ink.
    expect(NEAR_BLACK_MAX).toBe(24)
    const edge = gif({ width: 3, height: 1, frames: [{ width: 3, height: 1, indices: [0, 4, 0] }] })
    expect(boundingBox(compositeFrames(edge))).toEqual({ left: 1, top: 0, width: 1, height: 1 })
  })

  it('still honours the declared transparency index when it IS used', () => {
    // The rule is a union, not a replacement: GREEN is nowhere near black, but
    // index 2 is declared transparent, so only the BARELY_OPAQUE pixel is ink.
    const declared = gif({
      width: 3,
      height: 1,
      frames: [{ width: 3, height: 1, indices: [2, 4, 2], transparentIndex: 2 }],
    })
    expect(boundingBox(compositeFrames(declared))).toEqual({
      left: 1,
      top: 0,
      width: 1,
      height: 1,
    })
  })

  it('refuses to build from a frame set with no ink at all', () => {
    const blank = gif({
      width: 2,
      height: 2,
      frames: [{ width: 2, height: 2, indices: [0, 0, 0, 0] }],
    })
    expect(() => boundingBox(compositeFrames(blank))).toThrow(/opaque|empty/i)
  })
})

describe('compositing: offsets and disposal methods', () => {
  it('draws a frame at its own offset and leaves the rest transparent', () => {
    // One 2x2 frame of RED at (1,1) on a 5x5 screen.
    const offset = gif({
      width: 5,
      height: 5,
      frames: [{ width: 2, height: 2, left: 1, top: 1, indices: [1, 1, 1, 1] }],
    })
    expect(mapCanvas(compositeFrames(offset)[0], [RED])).toEqual([
      '.....',
      '.00..',
      '.00..',
      '.....',
      '.....',
    ])
  })

  // Two frames on a 4x2 screen:
  //   frame 0 covers the whole screen: RED at (0,0), near-black elsewhere.
  //   frame 1 is a single GREEN pixel at (2,0).
  // Disposal decides what frame 1 is drawn ON TOP OF, which is the only thing
  // that separates the two cases below.
  const twoFrames = (disposal) =>
    gif({
      width: 4,
      height: 2,
      frames: [
        { width: 4, height: 2, indices: [1, 0, 0, 0, 0, 0, 0, 0], disposal },
        { width: 1, height: 1, left: 2, top: 0, indices: [2] },
      ],
    })

  it('keeps the previous canvas under a later frame with disposal 1', () => {
    const canvases = compositeFrames(twoFrames(1))
    expect(mapCanvas(canvases[0], [RED, GREEN])).toEqual(['0...', '....'])
    expect(mapCanvas(canvases[1], [RED, GREEN])).toEqual(['0.1.', '....'])
  })

  it('clears the previous frame rectangle with disposal 2', () => {
    const canvases = compositeFrames(twoFrames(2))
    // Frame 0 renders identically — disposal only affects what comes after.
    expect(mapCanvas(canvases[0], [RED, GREEN])).toEqual(['0...', '....'])
    // Frame 0's rectangle was the whole screen, so RED is gone by frame 1.
    expect(mapCanvas(canvases[1], [RED, GREEN])).toEqual(['..1.', '....'])
  })

  it('rewinds to the pre-frame canvas with disposal 3', () => {
    // frame 0: RED at (0,0), disposal 1 (leave it).
    // frame 1: GREEN at (1,0), disposal 3 (restore what was there before me).
    // frame 2: BLUE at (2,0) — so it must see RED but NOT GREEN.
    const rewind = gif({
      width: 3,
      height: 1,
      frames: [
        { width: 3, height: 1, indices: [1, 0, 0], disposal: 1 },
        { width: 1, height: 1, left: 1, top: 0, indices: [2], disposal: 3 },
        { width: 1, height: 1, left: 2, top: 0, indices: [3], disposal: 0 },
      ],
    })
    const canvases = compositeFrames(rewind)
    expect(mapCanvas(canvases[0], [RED, GREEN, BLUE])).toEqual(['0..'])
    expect(mapCanvas(canvases[1], [RED, GREEN, BLUE])).toEqual(['01.'])
    expect(mapCanvas(canvases[2], [RED, GREEN, BLUE])).toEqual(['0.2'])
  })

  it('takes the bounding box across ALL frames, not just the first', () => {
    // frame 0 inks only (0,0); frame 1 only (3,1). The union spans both.
    const spread = gif({
      width: 4,
      height: 2,
      frames: [
        { width: 4, height: 2, indices: [1, 0, 0, 0, 0, 0, 0, 0], disposal: 2 },
        { width: 1, height: 1, left: 3, top: 1, indices: [2] },
      ],
    })
    expect(boundingBox(compositeFrames(spread))).toEqual({
      left: 0,
      top: 0,
      width: 4,
      height: 2,
    })
  })
})

describe('downsampling: averages of the opaque samples only', () => {
  // A 4x4 canvas of four uniform 2x2 quadrants, downsampled to a 2x2 grid, so
  // each cell covers exactly one quadrant.
  const quadrants = () => {
    const indices = []
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const quadrant = (y < 2 ? 0 : 2) + (x < 2 ? 0 : 1)
        indices.push([1, 2, 3, 4][quadrant])
      }
    }
    return gif({ width: 4, height: 4, frames: [{ width: 4, height: 4, indices }] })
  }

  it('maps each grid cell onto its own block of source pixels', () => {
    const canvas = compositeFrames(quadrants())[0]
    const grid = downsample(canvas, { left: 0, top: 0, width: 4, height: 4 }, { width: 2, height: 2 })
    expect(grid).toEqual({
      width: 2,
      height: 2,
      cells: [RED, GREEN, BLUE, BARELY_OPAQUE],
    })
  })

  it('averages only the opaque samples in a cell', () => {
    // A 2x1 grid over a 4x1 canvas. Left cell: BARELY_OPAQUE [9,8,8] and
    // BACKGROUND (transparent) → the average is BARELY_OPAQUE alone, NOT
    // [(9+8)/2, 8, 8]. Right cell: RED and GREEN → [(200+10)/2, (50+200)/2,
    // (25+30)/2] = [105, 125, 27.5] → 28 after rounding half up.
    const mixed = gif({ width: 4, height: 1, frames: [{ width: 4, height: 1, indices: [4, 0, 1, 2] }] })
    const canvas = compositeFrames(mixed)[0]
    const grid = downsample(canvas, { left: 0, top: 0, width: 4, height: 1 }, { width: 2, height: 1 })
    expect(grid.cells).toEqual([BARELY_OPAQUE, [105, 125, 28]])
  })

  it('marks a cell transparent when no opaque sample falls in it', () => {
    // 4x1 canvas: ink on the left half only, so the right cell has no samples.
    const half = gif({ width: 4, height: 1, frames: [{ width: 4, height: 1, indices: [1, 1, 0, 0] }] })
    const canvas = compositeFrames(half)[0]
    const grid = downsample(canvas, { left: 0, top: 0, width: 4, height: 1 }, { width: 2, height: 1 })
    expect(grid.cells).toEqual([RED, null])
  })

  it('samples only inside the bounding box', () => {
    // The box excludes column 0, so the RED there must not reach any cell.
    const bordered = gif({
      width: 3,
      height: 1,
      frames: [{ width: 3, height: 1, indices: [1, 2, 2] }],
    })
    const canvas = compositeFrames(bordered)[0]
    const grid = downsample(canvas, { left: 1, top: 0, width: 2, height: 1 }, { width: 1, height: 1 })
    expect(grid.cells).toEqual([GREEN])
  })
})

describe('quantizing to one shared palette', () => {
  it('returns the exact colours when they already fit the budget', () => {
    // Four colours into a budget of four: k-means would only blur them, so the
    // pipeline must pass them through — sorted by channel sum, then r, g, b.
    // Channel sums: BARELY_OPAQUE 25, BLUE 220, GREEN 240, RED 275.
    const palette = quantizePalette([GREEN, RED, BLUE, BARELY_OPAQUE], 4)
    expect(palette).toEqual([BARELY_OPAQUE, BLUE, GREEN, RED])
  })

  it('clusters two obvious groups into their means', () => {
    // Colours: [0,0,200] [200,0,0] [0,0,210] [210,0,0] (channel sums 200, 200,
    // 210, 210). Sorted deterministically that is
    //   0: [0,0,200]  1: [200,0,0]  2: [0,0,210]  3: [210,0,0]
    // Farthest-point seeding takes the first as seed A, then the colour with the
    // largest squared distance from it — [210,0,0] at 210^2 + 200^2 = 84100,
    // beating [200,0,0] at 80000. The two clusters are then the blues and the
    // reds, whose means are [0,0,205] and [205,0,0]; both sum to 205, so the
    // sort falls through to r and puts the blue first.
    const palette = quantizePalette(
      [
        [200, 0, 0],
        [210, 0, 0],
        [0, 0, 200],
        [0, 0, 210],
      ],
      2,
    )
    expect(palette).toEqual([
      [0, 0, 205],
      [205, 0, 0],
    ])
  })

  it('never returns more colours than the budget', () => {
    const many = []
    for (let i = 0; i < 40; i += 1) many.push([i * 6, 255 - i * 6, (i * 11) % 256])
    expect(quantizePalette(many, 5).length).toBeLessThanOrEqual(5)
    expect(quantizePalette(many, 5).length).toBeGreaterThan(1)
  })

  it('is order-independent: the same colours in another order give one palette', () => {
    const colors = [GREEN, RED, BLUE, BARELY_OPAQUE, [120, 130, 140], [11, 250, 33]]
    const reversed = [...colors].reverse()
    expect(quantizePalette(reversed, 3)).toEqual(quantizePalette(colors, 3))
  })
})

describe('buildSprite: the whole pipeline', () => {
  // Two full-screen 2x2 frames — the first all RED, the second all BLUE — with
  // a colour budget of two. The frames share ONE palette, so RED and BLUE both
  // survive and each frame points at a different entry. A per-frame palette
  // would give each frame a one-colour palette and both would say index 0,
  // which is the hue flicker the issue warns about.
  const twoColorSprite = () =>
    buildSprite(
      gif({
        width: 2,
        height: 2,
        frames: [
          { width: 2, height: 2, indices: [1, 1, 1, 1], delayCs: 20, disposal: 1 },
          { width: 2, height: 2, indices: [3, 3, 3, 3], delayCs: 20, disposal: 1 },
        ],
      }),
      { grid: { width: 2, height: 2 }, colorCount: 2 },
    )

  it('emits one palette shared by every frame', () => {
    const sprite = twoColorSprite()
    // RED sums to 275, BLUE to 220, so BLUE sorts first and is index 0.
    expect(sprite.palette).toEqual([BLUE, RED])
    expect(sprite.frames.map((f) => f.rows)).toEqual([
      ['11', '11'],
      ['00', '00'],
    ])
  })

  it('carries each frame delay through in milliseconds', () => {
    expect(twoColorSprite().frames.map((f) => f.delayMs)).toEqual([200, 200])
  })

  it('stretches a box narrower than the grid instead of dividing by zero', () => {
    // A 3x1 screen inked only in the middle, so the bounding box is one pixel
    // wide while the grid asks for three columns. Every cell then samples that
    // same pixel — the alternative is an empty source range per cell and a
    // sprite of dots.
    const sprite = buildSprite(
      gif({ width: 3, height: 1, frames: [{ width: 3, height: 1, indices: [0, 1, 0] }] }),
      { grid: { width: 3, height: 1 }, colorCount: 1 },
    )
    expect(sprite.frames[0].rows).toEqual(['000'])
    expect(sprite.palette).toEqual([RED])
  })

  it('leaves a dot where a cell has no ink', () => {
    // Ink on the two diagonal corners of a 2x2 screen: that keeps the bounding
    // box at the full 2x2 (so the grid maps one cell per pixel) while leaving
    // the other two cells with no opaque sample at all.
    const sprite = buildSprite(
      gif({
        width: 2,
        height: 2,
        frames: [{ width: 2, height: 2, indices: [1, 0, 0, 1] }],
      }),
      { grid: { width: 2, height: 2 }, colorCount: 1 },
    )
    expect(sprite.frames[0].rows).toEqual(['0.', '.0'])
  })

  it('defaults to the measured 26x34 grid and a 12-colour budget', () => {
    // The issue's measured facts: the source's 303x394 bounding box downsamples
    // to 26x34 within 0.2% of its aspect ratio, and ~12 colours is what keeps
    // the two frames from flickering. Those numbers are the DEFAULTS so the
    // generator needs no flags to reproduce the shipped sprite.
    expect(DEFAULT_GRID).toEqual({ width: 26, height: 34 })
    expect(DEFAULT_COLOR_COUNT).toBe(12)

    const indices = []
    for (let y = 0; y < 68; y += 1) {
      for (let x = 0; x < 52; x += 1) indices.push(1 + ((x + y) % 4))
    }
    const sprite = buildSprite(
      gif({ width: 52, height: 68, frames: [{ width: 52, height: 68, indices }] }),
    )
    expect(sprite.width).toBe(26)
    expect(sprite.height).toBe(34)
    expect(sprite.frames[0].rows).toHaveLength(34)
    expect(new Set(sprite.frames[0].rows.map((r) => r.length))).toEqual(new Set([26]))
    expect(sprite.palette.length).toBeLessThanOrEqual(12)
  })

  it('reports the bounding box it cropped to', () => {
    const sprite = buildSprite(
      gif({
        width: 6,
        height: 6,
        frames: [{ width: 2, height: 2, left: 3, top: 1, indices: [1, 1, 1, 1] }],
      }),
      { grid: { width: 2, height: 2 }, colorCount: 1 },
    )
    expect(sprite.box).toEqual({ left: 3, top: 1, width: 2, height: 2 })
    expect(sprite.source).toEqual({ width: 6, height: 6 })
  })
})

describe('determinism (the generator must be re-runnable byte for byte)', () => {
  // A fixture with enough colours to make the quantizer do real work, since a
  // k-means seeded from a hash or a Math.random() is exactly where a second run
  // would diverge.
  const bytes = (() => {
    const indices = []
    for (let y = 0; y < 24; y += 1) {
      for (let x = 0; x < 24; x += 1) indices.push((x * 5 + y * 3) % 5)
    }
    return buildGif({
      width: 24,
      height: 24,
      palette: [BACKGROUND, RED, GREEN, BLUE, BARELY_OPAQUE, [120, 130, 140], [250, 240, 10], [40, 60, 80]],
      frames: [
        { width: 24, height: 24, indices, delayCs: 20, disposal: 1 },
        { width: 24, height: 24, indices: indices.map((i) => (i + 2) % 5), delayCs: 20, disposal: 1 },
      ],
    })
  })()

  it('produces identical module text on two independent runs', () => {
    const once = emitSpriteModule(buildSprite(decodeGif(bytes), { colorCount: 4 }))
    const twice = emitSpriteModule(buildSprite(decodeGif(bytes), { colorCount: 4 }))
    expect(twice).toBe(once)
    // Guard against a vacuous pass: the module must actually contain a sprite.
    expect(once).toMatch(/export const palette/)
  })

  it('reads no clock and no randomness anywhere in the generator', () => {
    // A static check, because the two-runs test above can only catch a source of
    // nondeterminism that happens to differ within one millisecond.
    const scriptsDir = fileURLToPath(new URL('../scripts/', import.meta.url))
    for (const file of [
      'generate-sprite.js',
      'lib/gif-decode.js',
      'lib/sprite-build.js',
      'lib/emit-sprite-module.js',
    ]) {
      const source = readFileSync(scriptsDir + file, 'utf8')
      const code = source.replace(/^\s*\/\/.*$/gm, '')
      expect(code, `${file} must not use Math.random()`).not.toMatch(/Math\s*\.\s*random/)
      expect(code, `${file} must not read a clock`).not.toMatch(/\bDate\b|hrtime|performance\.now/)
    }
  })
})
