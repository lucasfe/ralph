// Sprite renderer (#66) — palette + index grid → coloured terminal rows.
//
// This is the half of the sprite pipeline that SHIPS. It knows nothing about
// Ralph, banners, animation or terminals: it takes data and returns strings.
//
// PURE, with no exceptions: no imports at all, no fs, no clock, no environment,
// no randomness. That is asserted by a static read of this file in
// sprite-render.test.js, because absence of a capability is not something a unit
// test can demonstrate by exercising happy paths. Anything that needs to know
// whether colour is supported, how wide the terminal is, or what time it is
// belongs in the caller.
//
// HOW TWO PIXEL ROWS BECOME ONE TEXT ROW
// A terminal cell is about twice as tall as it is wide, so a half-block glyph
// with one colour in its foreground and another in its background renders as two
// square pixels stacked. Rows are therefore consumed in pairs, and N pixel rows
// produce ceil(N/2) text rows — a trailing odd row pairs against transparency.
//
// WHY THERE ARE TWO GLYPHS, not one
// The obvious implementation uses U+2580 (upper half block) for every cell and
// paints the bottom pixel as the background. That is right for two opaque pixels
// and WRONG when the top pixel is transparent: with only a background set, the
// upper half of the glyph is drawn in the terminal's default FOREGROUND colour,
// i.e. visible ink exactly where the sprite must show the terminal through. So a
// cell whose top half is transparent uses U+2584 (lower half block) with the
// bottom pixel as the FOREGROUND instead, leaving the upper half unpainted.
//
// WHY THE RESETS
// Three of the four cell shapes begin with a reset. Setting a foreground alone
// leaves the previous cell's BACKGROUND in effect, which bleeds a coloured block
// into a pixel that should be transparent. The both-opaque shape needs no reset
// because it sets both attributes itself, and every row ends with one so the
// sprite cannot colour the rest of the line.

/** U+2580, the top half of a cell — used when the top pixel is opaque. */
export const UPPER_HALF_BLOCK = '▀'

/** U+2584, the bottom half of a cell — used when only the bottom pixel is opaque. */
export const LOWER_HALF_BLOCK = '▄'

/** The character an index row uses for a transparent pixel. */
export const TRANSPARENT_CELL = '.'

/**
 * One character per pixel, base36, lowercase only: the encoding has exactly one
 * spelling per index so a generated grid is comparable byte for byte. 36 colours
 * is far more than a half-block sprite can use legibly.
 *
 * Exported because the generator has to encode with the same alphabet this
 * decodes with, and two copies of an alphabet are two chances to drift.
 */
export const PALETTE_INDEX_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz'

const ESC = '\u001B'
const RESET = `${ESC}[0m`

function foreground(color) {
  return `${ESC}[38;2;${color[0]};${color[1]};${color[2]}m`
}

function background(color) {
  return `${ESC}[48;2;${color[0]};${color[1]};${color[2]}m`
}

function describeValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}

function validatePalette(palette) {
  if (!Array.isArray(palette)) {
    throw new TypeError(
      `renderSprite: palette must be an array of [r, g, b] triples (got ${describeValue(palette)})`,
    )
  }
  // Indexed loops, NOT forEach: forEach skips HOLES, so a sparse palette
  // (`new Array(2)`, or the `delete`d slot a caller leaves behind assigning by
  // index) walks straight past validation and reaches `color[0]` inside the
  // escape-sequence builder as `undefined[0]`. A hole must be named exactly as a
  // dense `undefined` is — it is the same defect for whoever built the palette.
  for (let index = 0; index < palette.length; index += 1) {
    const entry = palette[index]
    if (!Array.isArray(entry) || entry.length !== 3) {
      throw new TypeError(
        `renderSprite: palette entry ${index} must be an [r, g, b] triple (got ${describeValue(entry)}` +
          `${Array.isArray(entry) ? ` of length ${entry.length}` : ''})`,
      )
    }
    for (let channelIndex = 0; channelIndex < entry.length; channelIndex += 1) {
      const channel = entry[channelIndex]
      if (typeof channel !== 'number') {
        throw new TypeError(
          `renderSprite: palette entry ${index} channel ${channelIndex} must be a number ` +
            `(got ${describeValue(channel)})`,
        )
      }
      if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
        throw new RangeError(
          `renderSprite: palette entry ${index} channel ${channelIndex} must be an integer in ` +
            `0..255 (got ${channel})`,
        )
      }
    }
  }
}

function validateRows(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError(
      `renderSprite: rows must be an array of index strings (got ${describeValue(rows)})`,
    )
  }
  // Indexed, for the same reason as validatePalette: forEach would skip a hole
  // and leave `rows[y].length` to throw an anonymous TypeError from the render
  // loop instead of naming the missing row here. Row 0 being a hole is caught by
  // the string check on the FIRST iteration, so the rows[0].length comparison
  // below is only ever reached once row 0 is known to be a string.
  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y]
    if (typeof row !== 'string') {
      throw new TypeError(`renderSprite: row ${y} must be a string (got ${describeValue(row)})`)
    }
    if (row.length !== rows[0].length) {
      throw new RangeError(
        `renderSprite: row ${y} is ${row.length} character(s) wide but row 0 is ` +
          `${rows[0].length} — the grid must be rectangular`,
      )
    }
  }
}

/**
 * The palette index at one position, or -1 for a transparent pixel. Errors name
 * the row and column, since a grid is thousands of characters and "invalid
 * character" on its own is unactionable.
 */
function indexAt(row, y, x, palette) {
  const character = row[x]
  if (character === TRANSPARENT_CELL) return -1
  const index = PALETTE_INDEX_CHARS.indexOf(character)
  if (index < 0) {
    throw new RangeError(
      `renderSprite: row ${y} column ${x} holds ${JSON.stringify(character)}, which is neither a ` +
        `lowercase base36 palette index nor ${JSON.stringify(TRANSPARENT_CELL)}`,
    )
  }
  if (index >= palette.length) {
    throw new RangeError(
      `renderSprite: row ${y} column ${x} refers to palette index ${index}, but the palette holds ` +
        `${palette.length} colour(s)`,
    )
  }
  return index
}

/** One cell, from the two pixel indices stacked in it. -1 means transparent. */
function cell(palette, topIndex, bottomIndex) {
  if (topIndex >= 0 && bottomIndex >= 0) {
    return `${foreground(palette[topIndex])}${background(palette[bottomIndex])}${UPPER_HALF_BLOCK}`
  }
  if (topIndex >= 0) return `${RESET}${foreground(palette[topIndex])}${UPPER_HALF_BLOCK}`
  if (bottomIndex >= 0) return `${RESET}${foreground(palette[bottomIndex])}${LOWER_HALF_BLOCK}`
  return `${RESET} `
}

/**
 * Renders an index grid as coloured terminal rows.
 *
 * @param {object} sprite
 * @param {number[][]} sprite.palette RGB triples, 0..255 per channel
 * @param {string[]} sprite.rows one string per pixel row; each character is a
 *   lowercase base36 palette index, or '.' for a transparent pixel
 * @returns {string[]} ceil(rows.length / 2) strings, each ending in a reset
 */
export function renderSprite(sprite) {
  if (sprite === null || typeof sprite !== 'object') {
    throw new TypeError(
      `renderSprite: expected an object with { palette, rows } (got ${describeValue(sprite)})`,
    )
  }
  const { palette, rows } = sprite
  validatePalette(palette)
  validateRows(rows)
  if (rows.length === 0) return []

  const lines = []
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y]
    // The last row of an odd-height grid has no partner, and pairing it against
    // transparency is exactly what an extra row of dots would have done.
    const bottom = y + 1 < rows.length ? rows[y + 1] : null
    let line = ''
    for (let x = 0; x < top.length; x += 1) {
      const topIndex = indexAt(top, y, x, palette)
      const bottomIndex = bottom === null ? -1 : indexAt(bottom, y + 1, x, palette)
      line += cell(palette, topIndex, bottomIndex)
    }
    lines.push(`${line}${RESET}`)
  }
  return lines
}
