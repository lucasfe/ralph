// #66 QA — adversarial specs for the one piece of the sprite pipeline that SHIPS.
//
// sprite-render.test.js walks a hand-written 4x4 grid and proves the happy path.
// This file attacks the same module from the outside, on the assumption that a
// published pure function will eventually be handed something nobody designed
// for: a grid assembled by a caller that skipped an index, a palette entry that
// is a hole, an index one past the end of the palette, a row with a newline in
// it. The contract this file holds the renderer to is the one its own header
// claims — errors NAME the offending row and column, and no input reaches the
// string building with a shape the validator was supposed to reject.
//
// Escape sequences are spelled out here rather than imported from the module, so
// an expectation cannot agree with a typo in the implementation's own constants.

import { describe, expect, it } from 'vitest'
import { renderSprite } from './sprite-render.js'

const ESC = '\u001B'
const RESET = `${ESC}[0m`
const UPPER = '▀'
const LOWER = '▄'
const fg = (r, g, b) => `${ESC}[38;2;${r};${g};${b}m`
const bg = (r, g, b) => `${ESC}[48;2;${r};${g};${b}m`

// Index 0 = red, 1 = green.
const PALETTE = [
  [255, 0, 0],
  [0, 255, 0],
]

// The full base36 alphabet, written out rather than imported: this file is the
// place a drift between the encoding and the renderer has to be caught.
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

describe('renderSprite — the four cell shapes, byte for byte', () => {
  // Every cell a sprite can contain is one of exactly four shapes, and each is
  // asserted on its own 1x2 grid so a regression names the shape rather than
  // pointing at a wall of control codes.
  it('emits exactly these bytes for opaque/opaque, opaque/none, none/opaque and none/none', () => {
    const cases = [
      // Both halves opaque: foreground + background on the UPPER block, and
      // deliberately NO leading reset — setting both attributes leaves nothing
      // for the previous cell to bleed through.
      [['0', '1'], `${fg(255, 0, 0)}${bg(0, 255, 0)}${UPPER}${RESET}`],
      // Top opaque, bottom transparent: reset (to drop the previous cell's
      // background), foreground, UPPER block.
      [['0', '.'], `${RESET}${fg(255, 0, 0)}${UPPER}${RESET}`],
      // Top transparent, bottom opaque: reset, foreground, LOWER block. Never
      // "upper block with a background", which would paint the top half in the
      // terminal's default ink exactly where the sprite must be see-through.
      [['.', '1'], `${RESET}${fg(0, 255, 0)}${LOWER}${RESET}`],
      // Both transparent: reset and a plain space.
      [['.', '.'], `${RESET} ${RESET}`],
    ]
    for (const [rows, expected] of cases) {
      expect(renderSprite({ palette: PALETTE, rows }), rows.join('/')).toEqual([expected])
    }
  })

  it('never sets a background for a cell whose bottom half is transparent', () => {
    // The single most damaging way to get this wrong: a background on a
    // transparent half paints a coloured block where the terminal must show
    // through. Asserted across every cell shape that has a transparent bottom.
    for (const rows of [['0', '.'], ['.', '.'], ['0'], ['.']]) {
      const [line] = renderSprite({ palette: PALETTE, rows })
      expect(line, rows.join('/')).not.toContain('48;2')
    }
  })

  it('spends one reset per line when every cell is fully opaque', () => {
    // The both-opaque shape must not emit a reset of its own: 26 columns of
    // needless resets is 260 wasted bytes per line, and it would also mean the
    // renderer is resetting between cells it does not need to.
    const [line] = renderSprite({ palette: PALETTE, rows: ['0101', '1010'] })
    expect(line.split(RESET)).toHaveLength(2)
    expect(line.endsWith(RESET)).toBe(true)
  })
})

describe('renderSprite — output that a terminal can survive', () => {
  const rows = ['01.', '.10', '0.1']

  it('ends every line with a reset so no colour bleeds into the rest of the line', () => {
    for (const line of renderSprite({ palette: PALETTE, rows })) {
      expect(line.endsWith(RESET)).toBe(true)
    }
  })

  it('emits no raw newline, carriage return or tab inside a line', () => {
    // The caller joins these with its own newlines; a line that carries one
    // would silently double-space the sprite and break the ceil(N/2) contract.
    for (const line of renderSprite({ palette: PALETTE, rows })) {
      expect(line).not.toMatch(/[\n\r\t]/)
    }
  })

  it('emits nothing but SGR sequences, half blocks and spaces', () => {
    // A stricter statement of the same property: any other control character
    // (a cursor move, an OSC string) would make the sprite unsafe to print
    // inside a boxed banner.
    for (const line of renderSprite({ palette: PALETTE, rows })) {
      expect(line).toMatch(new RegExp(`^(?:${ESC}\\[[0-9;]*m|[${UPPER}${LOWER} ])+$`))
    }
  })

  it('is a function of its arguments alone: two identical calls, identical bytes', () => {
    const once = renderSprite({ palette: PALETTE, rows })
    const twice = renderSprite({ palette: PALETTE, rows })
    expect(twice).toEqual(once)
    expect(twice.join('\n')).toBe(once.join('\n'))
  })
})

describe('renderSprite — the base36 alphabet, at both ends', () => {
  it('resolves index z (base36 35) against a 36-colour palette', () => {
    const palette = []
    for (let i = 0; i < 36; i += 1) palette.push([i * 7, 0, 255 - i * 7])
    const [line] = renderSprite({ palette, rows: ['z'] })
    expect(line).toBe(`${RESET}${fg(245, 0, 10)}${UPPER}${RESET}`)
  })

  it('renders all 36 indices in one row, in alphabet order', () => {
    const palette = []
    for (let i = 0; i < 36; i += 1) palette.push([i, i, i])
    const [line] = renderSprite({ palette, rows: [ALPHABET] })
    // One foreground per column, in ascending palette order: proof the alphabet
    // is read left to right with no gap and no off-by-one at either end.
    expect(line.match(/38;2;(\d+);/g).map((m) => Number(m.match(/;(\d+);$/)[1]))).toEqual(
      palette.map((entry) => entry[0]),
    )
  })

  it('paints a palette entry of pure black as a colour, not as transparency', () => {
    // The near-black rule belongs to the GENERATOR. If the renderer ever grew an
    // opinion about dark colours, a legitimately black pixel would turn into a
    // hole in the sprite.
    const [line] = renderSprite({ palette: [[0, 0, 0]], rows: ['0', '0'] })
    expect(line).toBe(`${fg(0, 0, 0)}${bg(0, 0, 0)}${UPPER}${RESET}`)
  })
})

describe('renderSprite — degenerate but legal grids', () => {
  it('returns an empty array for no rows, and never an array of one empty string', () => {
    expect(renderSprite({ palette: PALETTE, rows: [] })).toEqual([])
  })

  it('renders a zero-width grid as one bare reset per text row', () => {
    // A 0-wide grid is not obviously an error — it is what a 0-wide crop would
    // produce — so it must round-trip rather than throw somewhere unhelpful.
    expect(renderSprite({ palette: PALETTE, rows: [''] })).toEqual([RESET])
    expect(renderSprite({ palette: PALETTE, rows: ['', '', ''] })).toEqual([RESET, RESET])
  })

  it('accepts an empty palette when nothing in the grid refers to it', () => {
    expect(renderSprite({ palette: [], rows: ['..'] })).toEqual([`${RESET} ${RESET} ${RESET}`])
  })

  it('renders a single pixel row as one text row paired against transparency', () => {
    expect(renderSprite({ palette: PALETTE, rows: ['0'] })).toEqual([
      `${RESET}${fg(255, 0, 0)}${UPPER}${RESET}`,
    ])
  })

  it('emits ceil(N/2) rows for an odd tall grid without dropping the last row', () => {
    const rows = new Array(35).fill('0')
    const lines = renderSprite({ palette: PALETTE, rows })
    expect(lines).toHaveLength(18)
    // The 18th line holds row 34 on top and nothing underneath.
    expect(lines[17]).toBe(`${RESET}${fg(255, 0, 0)}${UPPER}${RESET}`)
  })
})

describe('renderSprite — hostile input is named, not dereferenced', () => {
  it('names the row and column of a control character in a row', () => {
    expect(() => renderSprite({ palette: PALETTE, rows: ['0\n', '00'] })).toThrow(
      /row 0.*column 1|column 1.*row 0/,
    )
    expect(() => renderSprite({ palette: PALETTE, rows: ['0\u001B', '00'] })).toThrow(RangeError)
  })

  it('names the row and column of an index inside the alphabet but past the palette', () => {
    const palette = []
    for (let i = 0; i < 12; i += 1) palette.push([i, i, i])
    // 'z' is a legal alphabet character and index 35 — one the palette has no
    // entry for. Silently rendering palette[35] would be `undefined[0]`.
    expect(() => renderSprite({ palette, rows: ['00', '0z'] })).toThrow(
      /row 1.*column 1|column 1.*row 1/,
    )
    expect(() => renderSprite({ palette, rows: ['0z'] })).toThrow(/palette holds 12/)
  })

  it('rejects an empty argument object rather than rendering nothing', () => {
    expect(() => renderSprite({})).toThrow(TypeError)
    expect(() => renderSprite(null)).toThrow(TypeError)
    expect(() => renderSprite(undefined)).toThrow(TypeError)
    expect(() => renderSprite('sprite')).toThrow(TypeError)
    expect(() => renderSprite([])).toThrow(TypeError)
  })

  it('rejects a row array that is missing an entry, naming the row', () => {
    // `new Array(3)` is a grid whose rows are HOLES, not strings — the shape a
    // caller produces with `const rows = []; rows[y] = …` and a skipped y. The
    // validator must name it exactly as it names a dense `undefined`, because
    // "Cannot read properties of undefined (reading 'length')" tells whoever
    // built the grid nothing about which row is missing.
    expect(() => renderSprite({ palette: PALETTE, rows: new Array(3) })).toThrow(
      /renderSprite: row 0/,
    )
    const holed = ['00', '00', '00']
    delete holed[1]
    expect(() => renderSprite({ palette: PALETTE, rows: holed })).toThrow(/renderSprite: row 1/)
  })

  it('rejects a palette that is missing an entry, naming the entry', () => {
    // Same hole, on the palette side: a hole passes the per-entry checks and
    // then reaches `color[0]` inside the escape-sequence builder.
    expect(() => renderSprite({ palette: new Array(2), rows: ['0'] })).toThrow(
      /renderSprite: palette entry 0/,
    )
    const holed = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
    delete holed[1]
    expect(() => renderSprite({ palette: holed, rows: ['1'] })).toThrow(
      /renderSprite: palette entry 1/,
    )
  })

  it('rejects a channel that is a numeric string, not a number', () => {
    expect(() => renderSprite({ palette: [['255', '0', '0']], rows: ['0'] })).toThrow(TypeError)
    expect(() => renderSprite({ palette: [[255, 0, NaN]], rows: ['0'] })).toThrow(RangeError)
    expect(() => renderSprite({ palette: [[255, 0, Infinity]], rows: ['0'] })).toThrow(RangeError)
  })

  it('reports the ragged row, not the first mismatch it happens to index', () => {
    expect(() => renderSprite({ palette: PALETTE, rows: ['000', '000', '00'] })).toThrow(/row 2/)
    // Shorter FIRST row: the check must be against row 0's width in both
    // directions, or a grid that grows is accepted and renders a jagged sprite.
    expect(() => renderSprite({ palette: PALETTE, rows: ['00', '000'] })).toThrow(/row 1/)
  })
})

describe('renderSprite — purity, demonstrated rather than read', () => {
  it('renders with Date, Math.random and process replaced by tripwires', () => {
    // sprite-render.test.js proves the ABSENCE of these by reading the source.
    // This is the other half: the module has no imports, so a global is the only
    // ambient state it could reach, and every global it could reach is booby
    // trapped for the duration of one synchronous call. Restored in `finally`,
    // and nothing async runs in between.
    const realDate = globalThis.Date
    const realRandom = Math.random
    const realProcess = globalThis.process
    const tripwire = (name) => () => {
      throw new Error(`renderSprite touched ${name}`)
    }
    let lines
    try {
      globalThis.Date = tripwire('Date')
      Math.random = tripwire('Math.random')
      globalThis.process = new Proxy(
        {},
        {
          get(_target, property) {
            throw new Error(`renderSprite read process.${String(property)}`)
          },
        },
      )
      lines = renderSprite({ palette: PALETTE, rows: ['01', '1.'] })
    } finally {
      globalThis.Date = realDate
      Math.random = realRandom
      globalThis.process = realProcess
    }
    expect(lines).toHaveLength(1)
    expect(lines[0].endsWith(RESET)).toBe(true)
  })

  it('does not mutate the sprite it was given', () => {
    // A renderer that sorted or normalised its input in place would corrupt the
    // caller's data module on the second frame.
    const palette = [[255, 0, 0], [0, 255, 0]]
    const rows = ['01', '1.']
    renderSprite({ palette, rows })
    expect(palette).toEqual([[255, 0, 0], [0, 255, 0]])
    expect(rows).toEqual(['01', '1.'])
  })
})
