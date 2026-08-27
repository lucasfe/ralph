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

describe('renderStaticBanner — the width rung of the ladder (#72)', () => {
  // The sprite is the NARROW element of the banner: it sits above the box rather than
  // beside it, so 26 columns is its own cell width and the box's 60 is a target. That is
  // why the box unboxes first and the sprite is dropped last — and why the rung lives in
  // lib/banner-compose.js, where `bannerLayout` is the whole ladder. This module asks it;
  // it does not hold a 26 of its own, because two copies of a number are two numbers.
  it('draws the frame at 26 columns and wider', () => {
    for (const width of [26, 27, 30, 44, 60, 200, 1e6]) {
      expect(renderStaticBanner({ isTTY: true, color: true, width }), String(width)).toHaveLength(17)
    }
  })

  it('draws nothing at all below 26 columns, not even an escape', () => {
    // A clipped sprite is not a smaller sprite: the 26 cells are one face, and cutting
    // six of them off every row is half a Ralph with a torn edge. So it is dropped whole
    // — and dropped means not one byte, for the same reason the suppressed cases above
    // do: a lone reset is still bytes in a log file.
    for (const width of [25, 20, 12, 5, 2, 1]) {
      const lines = renderStaticBanner({ isTTY: true, color: true, width })
      expect(lines, String(width)).toEqual([])
      expect(lines.join(''), String(width)).not.toContain(ESC)
    }
  })

  it('treats an omitted or unusable width as room enough', () => {
    // The compatibility half, and the reason it is stated: every caller before #72 —
    // and every test above — calls this with no width at all, and `stdout.columns` is
    // `undefined` on a pipe and `0` on some CI runners. All of it falls through to the
    // ladder's documented 60-column default, so an absent width draws exactly what it
    // drew before this issue rather than nothing.
    for (const width of [undefined, null, 0, -1, -80, 0.5, Number.NaN, Infinity, '80', {}, true]) {
      expect(
        renderStaticBanner({ isTTY: true, color: true, width }),
        JSON.stringify(width) ?? String(width),
      ).toEqual(renderStaticBanner({ isTTY: true, color: true }))
    }
    expect(renderStaticBanner({ isTTY: true, color: true, width: undefined })).toHaveLength(17)
  })

  it('keeps both capability gates ahead of the width', () => {
    // The width is a third reason to stay silent, never a reason to speak: a wide
    // terminal does not talk a piped stream or a NO_COLOR run into a sprite.
    for (const width of [200, 60, 44, 26, 25, 1]) {
      expect(renderStaticBanner({ isTTY: false, color: true, width }), String(width)).toEqual([])
      expect(renderStaticBanner({ isTTY: true, color: false, width }), String(width)).toEqual([])
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
    // Its imports are the two sibling modules it composes, plus (#72) the module that
    // owns the degradation ladder. That third one is a RULE rather than a helper, on the
    // same argument banner-compose.js makes for importing update-check.js: the width at
    // which the sprite may be drawn is one decision, and a second copy of 26 here is how
    // the sprite and the box come to disagree about which terminal they are on.
    expect([...code.matchAll(/^import .* from '(.*)'$/gm)].map((m) => m[1]).sort()).toEqual([
      './banner-compose.js',
      './sprite-data.js',
      './sprite-render.js',
    ])
  })
})
