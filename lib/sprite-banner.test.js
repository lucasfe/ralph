// #67 — the spec for the DECISION, kept away from the terminal.
//
// The banner is two questions, and only one of them is about pixels: "may we draw
// at all?" and "what exactly do we print?". Both live in lib/sprite-banner.js as
// pure functions, so this file answers them with plain values — an env bag and a
// boolean — and never consults the terminal the suite happens to run in (#41).
// That is the whole point of the split: `ralph start` gets to be a two-line call
// site, and the gate is asserted here where a TTY can be a `true` literal.

import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { colorEnabled, renderStaticBanner, STATIC_FRAME_INDEX } from './sprite-banner.js'
import { frames, palette } from './sprite-data.js'
import { LOWER_HALF_BLOCK, UPPER_HALF_BLOCK, renderSprite } from './sprite-render.js'

const ESC = '\u001B'
const CELL_GLYPHS = new Set([UPPER_HALF_BLOCK, LOWER_HALF_BLOCK, ' '])

function cellCount(line) {
  return [...line].filter((character) => CELL_GLYPHS.has(character)).length
}

describe('colorEnabled — may we emit ANSI at all', () => {
  it('says yes on a TTY with nothing in the environment against it', () => {
    expect(colorEnabled({ env: {}, isTTY: true })).toBe(true)
  })

  it('says no when stdout is not a TTY', () => {
    // A pipe, a file, a launchd log: 24-bit escape sequences are noise there, and
    // the sprite is decoration — it never wins that trade.
    expect(colorEnabled({ env: {}, isTTY: false })).toBe(false)
  })

  it('honors NO_COLOR whatever its value, including the empty string', () => {
    // Presence, not truthiness: `NO_COLOR=` is how a shell script most easily
    // exports the opt-out, and reading it as "colour is fine" would be the one
    // spelling that ignores a user who asked.
    for (const value of ['1', '0', 'true', 'false', '', ' ', 'no']) {
      expect(colorEnabled({ env: { NO_COLOR: value }, isTTY: true }), JSON.stringify(value)).toBe(
        false,
      )
    }
  })

  it('treats a present-but-undefined NO_COLOR as unset', () => {
    // The one case presence alone gets wrong. `{ NO_COLOR: env.NO_COLOR }` is how a
    // caller most naturally forwards one variable, and on an unset variable that
    // object HAS the key with an undefined value — a real process.env never does.
    // Suppressing there would mean nobody could forward the bag at all.
    expect(colorEnabled({ env: { NO_COLOR: undefined }, isTTY: true })).toBe(true)
  })

  it('ignores an environment that says nothing about colour', () => {
    expect(colorEnabled({ env: { TERM: 'xterm-256color', CI: 'true' }, isTTY: true })).toBe(true)
  })

  it('defaults to no, with no arguments at all', () => {
    // Fail closed: a caller that forgot to resolve the capability must get silence,
    // not a screenful of escape codes.
    expect(colorEnabled()).toBe(false)
    expect(colorEnabled({})).toBe(false)
  })
})

describe('renderStaticBanner — one frame, or nothing', () => {
  it('renders the static frame as 17 text rows of 26 cells', () => {
    const lines = renderStaticBanner({ isTTY: true, color: true })
    expect(lines).toHaveLength(17)
    for (const line of lines) expect(cellCount(line)).toBe(26)
  })

  it('renders frame 0 — the frame an unanimated banner shows', () => {
    expect(STATIC_FRAME_INDEX).toBe(0)
    expect(renderStaticBanner({ isTTY: true, color: true })).toEqual(
      renderSprite({ palette, rows: frames[0].rows }),
    )
  })

  it('returns an empty array when stdout is not a TTY', () => {
    expect(renderStaticBanner({ isTTY: false, color: true })).toEqual([])
  })

  it('returns an empty array when colour is suppressed', () => {
    expect(renderStaticBanner({ isTTY: true, color: false })).toEqual([])
  })

  it('returns an empty array when neither capability is there, or none was passed', () => {
    expect(renderStaticBanner({ isTTY: false, color: false })).toEqual([])
    expect(renderStaticBanner({})).toEqual([])
    expect(renderStaticBanner()).toEqual([])
  })

  it('emits no escape sequence at all in any suppressed case', () => {
    // The criterion is stronger than "no sprite": a suppressed run must not write a
    // lone reset either, because that is still bytes in a log file.
    for (const gate of [
      { isTTY: false, color: true },
      { isTTY: true, color: false },
      { isTTY: false, color: false },
    ]) {
      expect(renderStaticBanner(gate).join('')).not.toContain(ESC)
    }
  })
})

describe('sprite-banner — purity', () => {
  it('reads no clock, no environment and no filesystem', () => {
    // Same method, and the same reason, as lib/sprite-render.test.js: the ABSENCE
    // of a capability cannot be demonstrated by exercising happy paths. If this
    // module ever reads `process.env.NO_COLOR` itself, every test that injects an
    // env bag becomes a test of the developer's shell.
    const code = codeWithoutComments(new URL('./sprite-banner.js', import.meta.url))

    expect(code).not.toMatch(/\bprocess\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/node:(fs|os|path|child_process|tty)/)
    // Its only imports are the two sibling modules it composes.
    expect([...code.matchAll(/^import .* from '(.*)'$/gm)].map((m) => m[1]).sort()).toEqual([
      './sprite-data.js',
      './sprite-render.js',
    ])
  })
})
