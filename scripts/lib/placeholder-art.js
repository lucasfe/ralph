// #67 — a PLACEHOLDER source GIF, synthesized from hand-drawn ASCII art.
//
// WHY THIS FILE EXISTS AT ALL
// The sprite pipeline (#66) takes a Wreck-It Ralph GIF that is deliberately not in
// this repository: it is a developer-supplied input, which is why
// scripts/generate-sprite.js takes a path instead of a constant. #67 has to commit
// lib/sprite-data.js anyway, so it needs SOME source. This module is that source —
// an original, blocky, obviously-stand-in figure, drawn here so that the committed
// asset is genuine generator output rather than a hand-written data module.
//
// IT IS A PLACEHOLDER, and swapping it is one command:
//
//     node scripts/generate-sprite.js ralph.gif
//
// That overwrites lib/sprite-data.js from the real art and makes this module
// deletable, along with three others. `node scripts/placeholder-sprite-source.js`
// prints the checklist — that is the one canonical copy of it.
//
// WHY THE ART IS DRAWN AT THE TARGET RESOLUTION AND THEN SCALED UP
// The generator downsamples a bounding box to DEFAULT_GRID (26x34) by averaging the
// source pixels that fall in each cell. Draw at 26x34 and scale each cell to a
// uniform SCALE x SCALE block and every cell's average is that block's single
// colour — so the round trip is lossless and what you read below is exactly what
// lands in lib/sprite-data.js. Any other size would hand the placeholder's
// legibility over to an averaging kernel. The MARGIN of near-black around it is not
// decoration either: it makes the generator's crop do real work, the way it does on
// the real asset (a 303x394 box inside a 309x396 canvas).
//
// WHY BOTH FRAMES SHARE ONE INK MASK
// The frames use GIF disposal method 1 ("leave what you drew"), and the pipeline
// treats near-black as transparent — so frame 1 is composited OVER frame 0 and a
// cell that goes from ink to background does not erase, it ghosts. The animation is
// therefore a RECOLOUR (blink, open mouth) and never a move.
// test/sprite-placeholder-source.test.js asserts that on the frames below, which are
// module-level literals: there is nothing a runtime check could catch that a spec
// cannot.
//
// PURE: art in, bytes out. No fs, no clock, no randomness — a rerun must produce
// the same GIF, because the committed asset's determinism depends on it.

// The GIF ENCODER comes from the test tree. That is deliberate and it is safe:
// test/helpers/gif-fixture.js exists precisely BECAUSE no GIF is committed (see its
// header), which is the same reason this file exists, and both trees are outside the
// published tarball — package.json's `files` is an allow-list of bin/, lib/,
// templates/ and two markdown files. Nothing shipped imports either tree, and
// test/sprite-placeholder-source.qa.test.js asserts both halves of that against the
// real `npm pack` manifest. Copying the encoder into scripts/ instead would leave two
// GIF writers to keep in agreement with one decoder.
import { buildGif } from '../../test/helpers/gif-fixture.js'

/** What a background (near-black, i.e. transparent) cell looks like in the art. */
export const TRANSPARENT_ART_CELL = '.'

/**
 * The background colour. Its channel sum is 24 — exactly NEAR_BLACK_MAX — so the
 * pipeline classifies it as transparent. Opaque near-black rather than a declared
 * transparency index, because that is the quirk of the real asset the near-black
 * rule was written for (see scripts/lib/sprite-build.js).
 */
export const BACKGROUND = [8, 8, 8]

/**
 * One character per colour. Insertion order is the GIF's colour-table order, so it
 * is fixed here rather than derived from an object literal's key order; the palette
 * the generator emits is re-sorted by (channel sum, r, g, b) anyway.
 *
 * Ten colours, comfortably inside DEFAULT_COLOR_COUNT (12), so the quantizer keeps
 * them exactly instead of clustering them. Every channel sum is well above 24 — an
 * ink colour at or below the cut would be read as background and punch a hole.
 */
export const LEGEND = new Map([
  ['h', [92, 58, 34]], // hair
  ['s', [235, 183, 140]], // skin
  ['k', [198, 142, 102]], // skin in shadow — nose, chin, knuckles
  ['w', [242, 242, 242]], // eye white
  ['p', [38, 38, 46]], // pupil
  ['m', [96, 44, 44]], // mouth
  ['r', [158, 60, 54]], // shirt
  ['d', [104, 38, 36]], // shirt in shadow — sleeves, hem
  ['t', [72, 78, 118]], // trousers
  ['b', [64, 48, 40]], // boots
])

/** Art cell → source pixels. See the header: this is what makes the crop lossless. */
export const SCALE = 4

/** Near-black border around the figure, in source pixels, so the crop is real. */
export const MARGIN = 4

export const ART_WIDTH = 26
export const ART_HEIGHT = 34

/** 200ms per frame, in the centiseconds a GIF graphic control extension carries. */
export const FRAME_DELAY_CS = 20

/**
 * "Leave what you drew" — the disposal method almost every animated GIF in the wild
 * uses, and the one the compositing stage's cumulative path is written for.
 */
export const FRAME_DISPOSAL = 1

/**
 * A transparency index the file DECLARES and never uses — index 15 is a padding slot
 * of the 16-entry colour table. The real asset does exactly this (declares 127, then
 * paints its background as opaque near-black), so the placeholder reproduces the
 * quirk instead of hiding it: it keeps the union rule in sprite-build.js exercised.
 */
export const DECLARED_TRANSPARENT_INDEX = 15

// A stocky figure, 26 cells wide and 34 tall: hair, face, shoulders, arms out to
// both edges with fists, shirt, trousers, boots. Ink reaches all four edges (row 0
// hair, row 33 boots, columns 0 and 25 fists) so the generator's bounding box is the
// whole grid — see the round-trip spec.
//
// Rows pair up two-at-a-time into half-block text rows, so features that should read
// as a solid block occupy an EVEN pair: the eyes are rows 6-7, the fists rows 18-19.
const FRAME_0 = [
  '.........hh..h..hh........', //  0  hair tufts
  '........hhhhhhhhhhh.......', //  1
  '.......hhhhhhhhhhhh.......', //  2
  '......hhhhhhhhhhhhhh......', //  3  fringe
  '......hhsssssssssshh......', //  4  forehead
  '......hssssssssssssh......', //  5
  '......hsswpsssspwssh......', //  6  eyes
  '......hsswpsssspwssh......', //  7
  '......hssssskksssssh......', //  8  nose
  '......hssssskksssssh......', //  9
  '.......sssmmmmmmsss.......', // 10  mouth
  '........kssssssssk........', // 11  jaw
  '..........kkkkkk..........', // 12  neck
  '.....rrrrrrrrrrrrrrrr.....', // 13  shoulders
  '....drrrrrrrrrrrrrrrrd....', // 14
  '..ddrrrrrrrrrrrrrrrrrrdd..', // 15  arms out
  '.dddrrrrrrrrrrrrrrrrrrddd.', // 16
  'dddrrrrrrrrrrrrrrrrrrrrddd', // 17  full span
  'ssskrrrrrrrrrrrrrrrrrrksss', // 18  fists
  'ssskrrrrrrrrrrrrrrrrrrksss', // 19
  'kkkdrrrrrrrrrrrrrrrrrrdkkk', // 20  knuckles
  '....drrrrrrrrrrrrrrrrd....', // 21
  '....dddddddddddddddddd....', // 22  shirt hem
  '.....tttttttttttttttt.....', // 23  trousers
  '.....tttttttttttttttt.....', // 24
  '.....ttttttt..ttttttt.....', // 25  legs
  '.....ttttttt..ttttttt.....', // 26
  '.....ttttttt..ttttttt.....', // 27
  '.....ttttttt..ttttttt.....', // 28
  '.....ttttttt..ttttttt.....', // 29
  '....bbbbbbbb..bbbbbbbb....', // 30  boots
  '....bbbbbbbb..bbbbbbbb....', // 31
  '....bbbbbbbb..bbbbbbbb....', // 32
  '....bbbbbbbb..bbbbbbbb....', // 33
]

// Frame 1: eyes shut and mouth open — a grunt. Only rows 6, 7, 10 and 11 differ, and
// every difference swaps one ink colour for another so the ink mask is untouched (see
// the header on disposal 1).
const FRAME_1 = FRAME_0.map((row, y) => {
  if (y === 6) return '......hssssssssssssh......' //  upper lid, all skin
  if (y === 7) return '......hsskksssskkssh......' //  lash line
  if (y === 11) return '........ksmmmmmmsk........' //  open mouth
  return row
})

/** The two frames of the placeholder, as legend characters. Frame 0 is the one
 * `ralph start` shows statically (#67); #73 animates the pair. */
export const ART_FRAMES = [FRAME_0, FRAME_1]

// THE ART'S INVARIANTS ARE ASSERTED IN test/sprite-placeholder-source.test.js, not
// here: a rectangular ART_WIDTH x ART_HEIGHT grid, every cell either '.' or a legend
// character, and one shared ink mask across the frames. ART_FRAMES is a module-level
// literal that no input can vary, so a runtime validator would be the same two loops
// re-run on every call with nothing new to say — and a second place to keep in step.

/** Palette index of an art character. 0 is the background, ink starts at 1. */
function paletteIndexFor(character, order) {
  return character === TRANSPARENT_ART_CELL ? 0 : order.indexOf(character) + 1
}

/**
 * The placeholder source GIF: 112x144 (the 26x34 art at SCALE, plus MARGIN on every
 * side), two frames, 200ms each, disposal 1, opaque near-black background.
 *
 * @returns {Uint8Array} GIF89a bytes, identical on every call
 */
export function placeholderGif() {
  const order = [...LEGEND.keys()]
  const palette = [BACKGROUND, ...order.map((character) => LEGEND.get(character))]
  const width = ART_WIDTH * SCALE + MARGIN * 2
  const height = ART_HEIGHT * SCALE + MARGIN * 2

  const frames = ART_FRAMES.map((rows) => {
    // Filled with the background first, so the margin is opaque near-black rather
    // than a hole — the same thing the real asset does.
    const indices = new Uint8Array(width * height)
    for (let y = 0; y < ART_HEIGHT; y += 1) {
      for (let x = 0; x < ART_WIDTH; x += 1) {
        const index = paletteIndexFor(rows[y][x], order)
        if (index === 0) continue
        for (let dy = 0; dy < SCALE; dy += 1) {
          const row = (MARGIN + y * SCALE + dy) * width
          for (let dx = 0; dx < SCALE; dx += 1) {
            indices[row + MARGIN + x * SCALE + dx] = index
          }
        }
      }
    }
    return {
      indices,
      width,
      height,
      delayCs: FRAME_DELAY_CS,
      disposal: FRAME_DISPOSAL,
      transparentIndex: DECLARED_TRANSPARENT_INDEX,
    }
  })

  return buildGif({ width, height, palette, frames })
}
