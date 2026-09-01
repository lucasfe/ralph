// #161 — the HORIZONTAL JOIN: two blocks of finished lines in, one block out.
//
// The sprite is 26 cells wide and 17 rows tall; the identity box is about seven rows of
// 60. Until this issue `ralph start` stacked them, so a 120-column terminal drew a narrow
// cartoon and left ninety columns of nothing to the right of it for seventeen rows, then
// spent seven more rows on facts that would have fitted in that emptiness. This module is
// the one function that glues the second block into the first block's right-hand margin.
//
// WHY THE WIDTH IS AN ARGUMENT AND NOT A MEASUREMENT, which is the whole reason this is a
// module and not two lines at the call site: a sprite row is 24-bit ANSI. lib/sprite-render.js
// writes a reset, a foreground and a half-block per cell, so a 26-cell row is well over two
// hundred code points and no honest count of the string is where the box's first column goes.
// The visible width is a fixed property of the ART, so the caller states it and this module
// trusts it. Nothing here strips an escape, and nothing here decides how wide the sprite is.
//
// PURE, and one degree purer than the rest of the banner: no process, no clock, no fs (#41),
// and NOT ONE ESCAPE BYTE OF ITS OWN. What it puts between the blocks is spaces. The painting
// is finished before the join begins — a module that wrote an escape here would be a second
// place a terminal line could be corrupted, downstream of the clip in lib/banner-compose.js
// that made the first one safe.
//
// TOTAL, like every other part of the banner: this runs before the first preflight line of
// `ralph start`, so a nonsensical width, a hostile gap or a list that is not a list must cost
// a worse-looking banner and never the run. A negative width alone would reach `repeat(-1)`
// and throw a RangeError from inside a picture — and so, from the other end, would a billion,
// because `' '.repeat(1e9)` is past the longest string V8 will make. A column count is
// therefore checked as a SIZE and not only as a shape: see BESIDE_MAX_COLUMNS.
//
// ONE IMPORT, and it is a RULE rather than a helper: the gap `bannerLayout` subtracts when it
// decides whether the arrangement fits at all. Borrowed from the half that owns columns so
// the two cannot disagree about where the box starts. The edge runs one way — lib/banner-compose.js
// knows nothing about this file.
import { BESIDE_GAP } from './banner-compose.js'

/**
 * The widest column count this module will lay out — for the sprite, and for the air.
 *
 * A thousand is not a taste limit: it is the line past which a number stops being a count of
 * terminal columns and starts being a mistake somebody's arithmetic made. The art is 26 cells
 * wide, the box is capped at 60 (BANNER_WIDTH), and the widest terminal anybody has ever
 * reported is a small fraction of this; a caller asking for a thousand columns of indent has a
 * bug, not an unusually large monitor.
 *
 * WHY THERE IS A LINE AT ALL, which is the part a reader is owed: the padding below is built
 * with `String.prototype.repeat`, and a string has a maximum length — around 2 ** 29 in V8, so
 * `' '.repeat(1e9)` throws a RangeError. `Number.MAX_SAFE_INTEGER` is a perfectly finite,
 * perfectly non-negative, perfectly whole number, so every guard `columns` had was satisfied by
 * a value that could only ever crash. That is the same defect `SPLASH_MAX_FRAMES` closes in
 * lib/sprite-player.js, and it is stated here the same way, in the same words: a safe integer
 * is a shape, not a size. Choosing the ceiling far below the string limit rather than at it
 * also means the recovery never depends on the engine's number.
 *
 * WHY A CEILING AND NOT A CLAMP: over the line is a mistake, and the recovery from a mistake is
 * the fallback every other unusable count gets — no columns for a width, the ladder's own two
 * for a gap. Clamping a billion to a thousand would draw a box a thousand columns off the left
 * edge of a terminal that has eighty, which is a worse picture than the one this produces.
 *
 * NOTHING IN THE CLI REACHES IT, and that is worth saying plainly rather than leaving as an
 * implication: `ralph start` states `spriteWidth` from lib/sprite-data.js — the constant 26 —
 * and never passes a gap at all, so BESIDE_GAP is what every invocation uses. This guards the
 * programmatic caller. Exported for the specs, and so such a caller can check its own number
 * against the same one rather than discovering the limit by watching an indent vanish.
 */
export const BESIDE_MAX_COLUMNS = 1000

/**
 * Glue a block of box lines onto the right-hand side of a block of sprite lines.
 *
 * Top-aligned: box line 0 goes on sprite line 0, because the reader's eye should find
 * `╭─ ralph` at the top right of the picture rather than under its feet.
 *
 * @param {object} [options]
 * @param {string[]} [options.spriteLines] the LEFT block, already rendered and already
 *   painted — typically 17 rows of escape-laden half-blocks, emitted unchanged
 * @param {string[]} [options.boxLines] the RIGHT block, already composed at a width that
 *   fits the columns the sprite leaves behind (see `besideWidth` in lib/banner-compose.js)
 * @param {number} [options.spriteWidth] the left block's VISIBLE width in cells, which is
 *   what the box is offset by. Stated, never measured — see the note above. Anything that is
 *   not a column count a terminal could have (negative, `NaN`, a string, or above
 *   BESIDE_MAX_COLUMNS) is worth no columns rather than an error
 * @param {number} [options.gap] columns of air between the blocks, defaulting to BESIDE_GAP —
 *   which is also what an unusable gap falls back to, on the same rule as the width
 * @returns {string[]} one line per row of the taller block. Rows the box does not reach are
 *   the sprite's own strings, byte for byte and with no trailing padding — trailing spaces
 *   are noise in a log file and the sprite has no right border to reach. Rows the sprite
 *   does not reach are the box, indented into the same column, so a box taller than the
 *   picture keeps all four of its sides.
 */
export function joinBeside({ spriteLines, boxLines, spriteWidth, gap } = {}) {
  const left = rows(spriteLines)
  const right = rows(boxLines)
  const air = ' '.repeat(columns(gap, BESIDE_GAP))
  // Where the box's first column is, counted from the left of the line: the sprite's own
  // cells plus the air. Only ever spent on a row the sprite does not reach — a row it DOES
  // reach has already spent those cells, which is the whole content of "stated, not
  // measured": the offset is arithmetic on the caller's number, never on the string.
  const indent = ' '.repeat(columns(spriteWidth)) + air
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
    const sprite = left[index] ?? ''
    const box = right[index] ?? ''
    // No box on this row means no air on this row: the sprite's line, byte for byte, with
    // nothing appended. That is what keeps the ten rows below a seven-row box free of the
    // ninety trailing spaces a pad-to-width join would leave in every transcript.
    if (box === '') return sprite
    // A row the sprite does not really have is spelled as blank columns rather than as a
    // short line, which is what puts a surplus box row directly under the one above it.
    return sprite === '' ? indent + box : sprite + air + box
  })
}

/** A list of strings, from whatever a caller passed: holes and non-strings become ''. */
const rows = (lines) =>
  Array.isArray(lines) ? Array.from(lines, (line) => (typeof line === 'string' ? line : '')) : []

/**
 * A column count, from whatever a caller passed: whole, never negative, never NaN, and never
 * wider than a terminal could be (BESIDE_MAX_COLUMNS).
 *
 * Zero is HONOURED and not defaulted — a caller asking for no air is asking for no air —
 * while a width that is not a usable count at all (a string from a bag, a `NaN` from
 * arithmetic on `undefined`, a negative from a subtraction that underflowed, a `1e9` from one
 * that overflowed) falls back. The ceiling is INCLUSIVE and compared before the floor, which
 * costs nothing: flooring only ever makes a number smaller.
 *
 * There is no separate finiteness check because the two comparisons already are one: `NaN` is
 * false against both, `Infinity` fails the ceiling and `-Infinity` fails the floor. A third
 * test for the same three values would read as though it caught something they do not.
 */
const columns = (value, fallback = 0) =>
  typeof value === 'number' && value >= 0 && value <= BESIDE_MAX_COLUMNS
    ? Math.floor(value)
    : fallback
