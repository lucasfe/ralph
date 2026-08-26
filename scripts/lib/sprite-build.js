// #66 — the pure pipeline from decoded GIF frames to sprite data:
//
//   composite (honouring disposal) → classify transparency → bounding box
//   → downsample to the target grid → quantize to ONE shared palette
//   → one index-row string per pixel row
//
// TRANSPARENCY IS NOT WHAT THE FILE SAYS IT IS, and that is the whole reason
// this module has an opinion. The source GIF declares transparency index 127 and
// then never uses it: the background is painted as OPAQUE near-black pixels. Key
// on the declared index and the bounding box is the entire 309x396 canvas, the
// crop is meaningless, and a third of the palette is spent on shades of almost-
// black that the terminal renders as invisible smudge. So a pixel counts as
// transparent when its channel sum is <= NEAR_BLACK_MAX **or** its index is the
// frame's declared transparency index — a union, because a GIF that uses its
// declared index honestly must still work.
//
// DETERMINISM IS A REQUIREMENT, NOT A NICETY (criterion 3: two runs, identical
// bytes). Everything below therefore avoids the three usual leaks:
//   * no clock and no randomness anywhere — the k-means seeds are chosen by
//     farthest-point from a deterministically sorted list;
//   * no reliance on object-key or Map iteration order: colours are collected
//     into a Map for de-duplication and then EXPLICITLY sorted;
//   * every tie is broken by the lowest index, and the final palette is sorted
//     by (channel sum, r, g, b) before indices are assigned.
//
// PURE: no fs, no clock, no environment. scripts/generate-sprite.js is the I/O
// shell that reads the GIF and writes the module.

// The row encoding is a contract with the SHIPPED renderer, so it is imported
// from there rather than restated here: a second copy of the alphabet is a second
// chance for the generator and the renderer to disagree about what 'a' means.
import { PALETTE_INDEX_CHARS, TRANSPARENT_CELL } from '../../lib/sprite-render.js'

/**
 * A pixel whose channels sum to this or less is treated as transparent. 24 is
 * the measured cut for the source asset: it separates the near-black background
 * from the darkest ink and yields the correct 303x394 bounding box at (4, 2).
 */
export const NEAR_BLACK_MAX = 24

/**
 * The measured target grid. The source's 303x394 bounding box has a native
 * 5.5 px cell (55x72 source pixels); 26x34 half-block cells preserve that aspect
 * ratio to within 0.2%.
 */
export const DEFAULT_GRID = { width: 26, height: 34 }

/**
 * ~12 colours is what keeps the two frames from flickering in hue while still
 * reading as Ralph. It is also comfortably inside the 36 single-character
 * indices the row encoding allows.
 */
export const DEFAULT_COLOR_COUNT = 12

// Lloyd's algorithm converges on a handful of colours long before this; the cap
// exists so a pathological input cannot spin, and so that a rerun performs the
// same number of iterations as the last one.
const KMEANS_MAX_ITERATIONS = 32

// GIF disposal methods. 0 and 1 both mean "leave what you drew"; only 2 and 3
// change the canvas the next frame starts from.
const DISPOSAL_RESTORE_TO_BACKGROUND = 2
const DISPOSAL_RESTORE_TO_PREVIOUS = 3

function createCanvas(width, height) {
  return {
    width,
    height,
    rgb: new Uint8Array(width * height * 3),
    // A separate mask rather than an alpha channel: transparency here is a
    // classification, not a blend, and "no opaque sample" has to stay
    // distinguishable from "opaque black".
    opaque: new Uint8Array(width * height),
  }
}

function copyCanvas(canvas) {
  return {
    width: canvas.width,
    height: canvas.height,
    rgb: canvas.rgb.slice(),
    opaque: canvas.opaque.slice(),
  }
}

/**
 * The colour at (x, y), or `null` when that pixel is transparent or off-canvas.
 *
 * @param {object} canvas
 * @param {number} x
 * @param {number} y
 * @returns {number[]|null} `[r, g, b]`
 */
export function canvasPixel(canvas, x, y) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null
  const at = y * canvas.width + x
  if (!canvas.opaque[at]) return null
  return [canvas.rgb[at * 3], canvas.rgb[at * 3 + 1], canvas.rgb[at * 3 + 2]]
}

function isNearBlack(color, nearBlackMax) {
  return color[0] + color[1] + color[2] <= nearBlackMax
}

function clearRect(canvas, rect) {
  for (let y = rect.top; y < rect.top + rect.height; y += 1) {
    if (y < 0 || y >= canvas.height) continue
    for (let x = rect.left; x < rect.left + rect.width; x += 1) {
      if (x < 0 || x >= canvas.width) continue
      canvas.opaque[y * canvas.width + x] = 0
    }
  }
}

/**
 * Paints one frame onto the running canvas. A source pixel that classifies as
 * transparent is SKIPPED, exactly as a declared-transparent pixel would be —
 * that is what makes the near-black rule behave like a second transparency
 * index instead of a post-process, and it is why what shows through is the
 * previous frame rather than a hole.
 */
function drawFrame(canvas, frame, nearBlackMax) {
  for (let y = 0; y < frame.height; y += 1) {
    const canvasY = frame.top + y
    if (canvasY < 0 || canvasY >= canvas.height) continue
    for (let x = 0; x < frame.width; x += 1) {
      const canvasX = frame.left + x
      if (canvasX < 0 || canvasX >= canvas.width) continue

      const index = frame.indices[y * frame.width + x]
      if (index === frame.transparentIndex) continue
      const color = frame.palette[index]
      if (!color) {
        throw new Error(
          `sprite-build: pixel index ${index} is outside the frame's ` +
            `${frame.palette.length}-colour table`,
        )
      }
      if (isNearBlack(color, nearBlackMax)) continue

      const at = canvasY * canvas.width + canvasX
      canvas.rgb[at * 3] = color[0]
      canvas.rgb[at * 3 + 1] = color[1]
      canvas.rgb[at * 3 + 2] = color[2]
      canvas.opaque[at] = 1
    }
  }
}

/**
 * Composites every frame onto a full-size canvas, honouring disposal methods,
 * and returns one finished canvas per frame.
 *
 * @param {object} gif output of decodeGif()
 * @param {{ nearBlackMax?: number }} [options] `nearBlackMax` below 0 disables
 *   the near-black rule, which is only useful for showing what the declared
 *   transparency index alone would produce
 * @returns {object[]} one canvas per frame
 */
export function compositeFrames(gif, { nearBlackMax = NEAR_BLACK_MAX } = {}) {
  const canvas = createCanvas(gif.width, gif.height)
  const snapshots = []
  for (const frame of gif.frames) {
    const saved = frame.disposal === DISPOSAL_RESTORE_TO_PREVIOUS ? copyCanvas(canvas) : null
    drawFrame(canvas, frame, nearBlackMax)
    // Snapshot BEFORE disposing: disposal describes what the NEXT frame starts
    // from, never what this one looks like.
    snapshots.push(copyCanvas(canvas))
    if (frame.disposal === DISPOSAL_RESTORE_TO_BACKGROUND) clearRect(canvas, frame)
    else if (frame.disposal === DISPOSAL_RESTORE_TO_PREVIOUS && saved) {
      canvas.rgb.set(saved.rgb)
      canvas.opaque.set(saved.opaque)
    }
  }
  return snapshots
}

/**
 * The tightest rectangle containing every opaque pixel of every frame. Taken
 * across ALL frames on purpose: cropping each frame to its own ink would make
 * the sprite jump around between frames.
 *
 * @param {object[]} canvases
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
export function boundingBox(canvases) {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const canvas of canvases) {
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (!canvas.opaque[y * canvas.width + x]) continue
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  if (minX > maxX) {
    throw new Error(
      'sprite-build: no opaque pixels in any frame — every pixel classified as transparent, ' +
        'so there is nothing to crop to (is nearBlackMax too high?)',
    )
  }
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * The source pixel range a single grid cell covers. Proportional rather than
 * fixed-size, so a bounding box that does not divide evenly by the grid spreads
 * the remainder instead of dropping a strip off the right/bottom edge.
 *
 * When the grid is FINER than the source the proportional range comes out empty;
 * one pixel is taken instead, which is nearest-neighbour behaviour and keeps the
 * cell from rendering as a hole.
 */
function sourceRange(cell, cellCount, origin, span) {
  const start = origin + Math.floor((cell * span) / cellCount)
  const end = origin + Math.floor(((cell + 1) * span) / cellCount)
  return [start, Math.max(end, start + 1)]
}

/**
 * Averages ONLY the opaque samples in the range. A cell with no opaque sample at
 * all is transparent — averaging in the transparent ones instead would drag every
 * edge cell toward black and give the sprite a permanent dark halo.
 */
function averageOpaque(canvas, x0, x1, y0, y1) {
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const pixel = canvasPixel(canvas, x, y)
      if (pixel === null) continue
      r += pixel[0]
      g += pixel[1]
      b += pixel[2]
      count += 1
    }
  }
  if (count === 0) return null
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)]
}

/**
 * Reduces the bounding box of one canvas to a grid of cell colours.
 *
 * @param {object} canvas
 * @param {{ left: number, top: number, width: number, height: number }} box
 * @param {{ width: number, height: number }} grid
 * @returns {{ width: number, height: number, cells: (number[]|null)[] }} cells
 *   are row-major, `null` where nothing opaque fell in the cell
 */
export function downsample(canvas, box, grid) {
  if (grid.width < 1 || grid.height < 1) {
    throw new RangeError(`sprite-build: grid must be at least 1x1 (got ${grid.width}x${grid.height})`)
  }
  const cells = []
  for (let cy = 0; cy < grid.height; cy += 1) {
    const [y0, y1] = sourceRange(cy, grid.height, box.top, box.height)
    for (let cx = 0; cx < grid.width; cx += 1) {
      const [x0, x1] = sourceRange(cx, grid.width, box.left, box.width)
      cells.push(averageOpaque(canvas, x0, x1, y0, y1))
    }
  }
  return { width: grid.width, height: grid.height, cells }
}

function colorKey(color) {
  return (color[0] << 16) | (color[1] << 8) | color[2]
}

function squaredDistance(a, b) {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return dr * dr + dg * dg + db * db
}

// Total ordering used everywhere a colour list must be stable: channel sum first
// (so the palette reads dark → light), then r, g, b to break exact ties.
function compareColors(a, b) {
  const sumA = a[0] + a[1] + a[2]
  const sumB = b[0] + b[1] + b[2]
  if (sumA !== sumB) return sumA - sumB
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] - b[1]
  return a[2] - b[2]
}

/**
 * De-duplicates into `{ color, weight }` and sorts. The sort is what makes the
 * rest of the quantizer deterministic: a Map preserves insertion order, and
 * insertion order depends on which frame happened to be scanned first.
 */
function weightedColors(colors) {
  const counts = new Map()
  for (const color of colors) {
    const key = colorKey(color)
    const found = counts.get(key)
    if (found) found.weight += 1
    else counts.set(key, { color: [color[0], color[1], color[2]], weight: 1 })
  }
  return [...counts.values()].sort((a, b) => compareColors(a.color, b.color))
}

/**
 * Farthest-point seeding: start from the first colour in the sorted list, then
 * repeatedly take the colour furthest from everything chosen so far. Ties go to
 * the lowest index. This replaces k-means++'s random seeding — same spread-out
 * effect, no randomness to seed and no run-to-run drift.
 */
function farthestPointSeeds(weighted, colorCount) {
  const seeds = [weighted[0].color]
  const nearest = weighted.map((entry) => squaredDistance(entry.color, seeds[0]))

  while (seeds.length < colorCount) {
    let pick = -1
    let far = 0
    for (let i = 0; i < weighted.length; i += 1) {
      // Strictly greater, so the earliest colour wins a tie.
      if (nearest[i] > far) {
        far = nearest[i]
        pick = i
      }
    }
    // Every remaining colour is already a seed: asking for more would duplicate.
    if (pick < 0) break
    seeds.push(weighted[pick].color)
    for (let i = 0; i < weighted.length; i += 1) {
      nearest[i] = Math.min(nearest[i], squaredDistance(weighted[i].color, seeds[seeds.length - 1]))
    }
  }
  return seeds
}

function nearestCentroid(centroids, color) {
  let best = 0
  let bestDistance = squaredDistance(centroids[0], color)
  for (let k = 1; k < centroids.length; k += 1) {
    const distance = squaredDistance(centroids[k], color)
    // Strictly less, so the lowest centroid index wins a tie.
    if (distance < bestDistance) {
      bestDistance = distance
      best = k
    }
  }
  return best
}

function clusterMean(weighted, assignment, cluster) {
  let r = 0
  let g = 0
  let b = 0
  let total = 0
  for (let i = 0; i < weighted.length; i += 1) {
    if (assignment[i] !== cluster) continue
    const { color, weight } = weighted[i]
    r += color[0] * weight
    g += color[1] * weight
    b += color[2] * weight
    total += weight
  }
  if (total === 0) return null
  return [Math.round(r / total), Math.round(g / total), Math.round(b / total)]
}

function refineCentroids(weighted, seeds) {
  let centroids = seeds.map((color) => [...color])
  const assignment = new Int32Array(weighted.length).fill(-1)

  for (let iteration = 0; iteration < KMEANS_MAX_ITERATIONS; iteration += 1) {
    let moved = false
    for (let i = 0; i < weighted.length; i += 1) {
      const cluster = nearestCentroid(centroids, weighted[i].color)
      if (assignment[i] !== cluster) {
        assignment[i] = cluster
        moved = true
      }
    }
    if (!moved) break
    // An empty cluster keeps its previous centroid rather than being reseeded:
    // reseeding is where a quantizer usually reaches for a random colour.
    centroids = centroids.map((centroid, k) => clusterMean(weighted, assignment, k) ?? centroid)
  }

  // Drop centroids nothing was assigned to — an unused palette slot is a wasted
  // one, and the caller asked for at most `colorCount` colours, not exactly.
  return centroids.filter((_, k) => assignment.includes(k))
}

/**
 * One flat palette for every frame, via k-means with farthest-point seeding.
 *
 * @param {number[][]} colors every opaque cell colour, from all frames
 * @param {number} [colorCount] upper bound on palette size
 * @returns {number[][]} sorted by (channel sum, r, g, b)
 */
export function quantizePalette(colors, colorCount = DEFAULT_COLOR_COUNT) {
  if (colorCount < 1) {
    throw new RangeError(`sprite-build: colorCount must be at least 1 (got ${colorCount})`)
  }
  const weighted = weightedColors(colors)
  if (weighted.length === 0) {
    throw new Error('sprite-build: no opaque cells to build a palette from')
  }
  // Already inside the budget: clustering could only blur colours the sprite can
  // afford to keep exactly.
  if (weighted.length <= colorCount) return weighted.map((entry) => entry.color)

  const centroids = refineCentroids(weighted, farthestPointSeeds(weighted, colorCount))
  // Rounding two centroids can land them on the same colour; de-duplicate so the
  // palette holds no two identical entries.
  const unique = new Map()
  for (const centroid of centroids) unique.set(colorKey(centroid), centroid)
  return [...unique.values()].sort(compareColors)
}

function encodeRows(grid, palette) {
  const rows = []
  for (let y = 0; y < grid.height; y += 1) {
    let row = ''
    for (let x = 0; x < grid.width; x += 1) {
      const cell = grid.cells[y * grid.width + x]
      row += cell === null ? TRANSPARENT_CELL : PALETTE_INDEX_CHARS[nearestCentroid(palette, cell)]
    }
    rows.push(row)
  }
  return rows
}

/**
 * The whole pipeline: decoded GIF in, sprite data out.
 *
 * @param {object} gif output of decodeGif()
 * @param {object} [options]
 * @param {{ width: number, height: number }} [options.grid]
 * @param {number} [options.colorCount]
 * @param {number} [options.nearBlackMax]
 * @returns {{ width: number, height: number, box: object, source: object,
 *   palette: number[][], frames: { delayMs: number, rows: string[] }[] }}
 */
export function buildSprite(gif, options = {}) {
  const {
    grid = DEFAULT_GRID,
    colorCount = DEFAULT_COLOR_COUNT,
    nearBlackMax = NEAR_BLACK_MAX,
  } = options

  const canvases = compositeFrames(gif, { nearBlackMax })
  const box = boundingBox(canvases)
  const grids = canvases.map((canvas) => downsample(canvas, box, grid))

  const opaqueCells = []
  for (const downsampled of grids) {
    for (const cell of downsampled.cells) {
      if (cell !== null) opaqueCells.push(cell)
    }
  }
  const palette = quantizePalette(opaqueCells, colorCount)
  if (palette.length > PALETTE_INDEX_CHARS.length) {
    throw new RangeError(
      `sprite-build: a palette of ${palette.length} colours cannot be encoded one character ` +
        `per pixel (the limit is ${PALETTE_INDEX_CHARS.length})`,
    )
  }

  return {
    width: grid.width,
    height: grid.height,
    box,
    source: { width: gif.width, height: gif.height },
    palette,
    frames: grids.map((downsampled, index) => ({
      delayMs: gif.frames[index].delayMs,
      rows: encodeRows(downsampled, palette),
    })),
  }
}
