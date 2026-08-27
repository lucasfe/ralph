// #67 QA — adversarial specs for the GATE, on the assumption that its two inputs
// will eventually arrive in a shape nobody designed for.
//
// sprite-banner.test.js proves the intended matrix: a TTY with a clean bag draws, a
// pipe does not, and `NO_COLOR` suppresses whatever it holds. This file attacks the
// same two functions from outside that matrix:
//
//   * the PREDICATE. `'NO_COLOR' in env && env.NO_COLOR !== undefined` is three
//     decisions stacked in one line — presence over truthiness, `in` over
//     `Object.hasOwn`, and one carve-out for an explicitly-undefined value. Each is
//     pinned separately here, including the direction each fails in, so a future
//     edit to that line cannot quietly flip a user who asked for silence.
//   * the FRAME. It is handed to `out()` seventeen times inside `ralph start`, so it
//     has to be a fresh array of newline-free, reset-terminated strings on every
//     call, and it must not have edited the data module it read.
//   * PURITY, demonstrated rather than read. sprite-banner.test.js greps the source
//     for `process`; this file booby-traps the globals and calls the functions, and
//     extends the static read to the two modules it imports — a gate that is pure
//     while its dependencies are not is not a pure gate.
//
// Escape sequences and glyphs are spelled out rather than imported, so an
// expectation here cannot agree with a typo in the implementation's own constants.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { colorEnabled, renderStaticBanner, STATIC_FRAME_INDEX } from './sprite-banner.js'
import { frames, palette } from './sprite-data.js'
import { renderSprite } from './sprite-render.js'

const ESC = '\u001B'
const RESET = `${ESC}[0m`
const UPPER = '▀'
const LOWER = '▄'
const SGR = /\u001B\[[0-9;]*m/g

const enabled = () => renderStaticBanner({ isTTY: true, color: true })

describe('QA colorEnabled — presence, not truthiness, and every spelling of it', () => {
  it('suppresses on every present value a shell can actually export', () => {
    // The convention (no-color.org) is "when present, regardless of its value", and
    // these are the values a truthiness test gets wrong: the empty string a bare
    // `export NO_COLOR=` produces, the '0'/'false' a user writes when they think the
    // variable is a boolean, and a lone newline from a `$(cmd)` that returned nothing.
    for (const value of ['1', '0', '-1', '', ' ', '\n', 'false', 'FALSE', 'no', 'off', 'null']) {
      expect(colorEnabled({ env: { NO_COLOR: value }, isTTY: true }), JSON.stringify(value)).toBe(
        false,
      )
    }
  })

  it('suppresses on a null value, which is not the undefined carve-out', () => {
    // `null` reaches the predicate from a JSON-parsed bag or a `?? null` normalizer,
    // and it is a PRESENT key — only `undefined` is excused below.
    expect(colorEnabled({ env: { NO_COLOR: null }, isTTY: true })).toBe(false)
  })

  it('treats a present-but-undefined value as unset — the one documented hole', () => {
    // Pinned here as INTENT, not as an accident: the carve-out exists so a caller
    // forwarding one variable (`{ NO_COLOR: env.NO_COLOR }`) does not accidentally
    // suppress. The cost is that `{ NO_COLOR: undefined }` draws the sprite, so a
    // caller that means "off" must omit the key or pass a real value. A genuine
    // `process.env` cannot reach this state — see the proxy spec below, where an
    // assignment of `undefined` stringifies to 'undefined' and suppresses.
    expect(colorEnabled({ env: { NO_COLOR: undefined }, isTTY: true })).toBe(true)
  })

  it('honors a NO_COLOR inherited from a prototype — `in`, not Object.hasOwn', () => {
    // The safe direction, and worth pinning because the two spellings disagree here:
    // `Object.hasOwn` would draw the sprite for a caller whose env bag is layered
    // over a parent (`Object.create(defaults)`), i.e. a caller who asked for silence
    // and got a screenful of coloured cells.
    expect(colorEnabled({ env: Object.create({ NO_COLOR: '1' }), isTTY: true })).toBe(false)
    // ...and an inherited key is the only thing that counts: a bag with no NO_COLOR
    // anywhere in its chain still draws.
    expect(colorEnabled({ env: Object.create({ TERM: 'xterm' }), isTTY: true })).toBe(true)
  })

  it('reads a prototypeless bag, which is what a parsed .env most naturally is', () => {
    const bare = Object.create(null)
    expect(colorEnabled({ env: bare, isTTY: true })).toBe(true)
    bare.NO_COLOR = '1'
    expect(colorEnabled({ env: bare, isTTY: true })).toBe(false)
  })

  it('works over the real process.env proxy, whose setter stringifies', () => {
    // `process.env` is not a plain object: assignment coerces to a string and
    // `delete` removes the key. So both spellings a user reaches for land on the
    // suppressing side, INCLUDING the one that looks like the carve-out above —
    // `process.env.NO_COLOR = undefined` stores the four letters 'undefined'.
    //
    // Mutating process.env inside a test is the documented opt-in (#41): the harness
    // snapshots before each test and restores after, so this does not leak.
    expect(process.env.NO_COLOR, 'the harness must neutralize an ambient NO_COLOR').toBe(undefined)
    expect(colorEnabled({ env: process.env, isTTY: true })).toBe(true)

    process.env.NO_COLOR = ''
    expect('NO_COLOR' in process.env).toBe(true)
    expect(colorEnabled({ env: process.env, isTTY: true })).toBe(false)

    process.env.NO_COLOR = undefined
    expect(process.env.NO_COLOR).toBe('undefined')
    expect(colorEnabled({ env: process.env, isTTY: true })).toBe(false)

    delete process.env.NO_COLOR
    expect(colorEnabled({ env: process.env, isTTY: true })).toBe(true)
  })

  it('never consults any other colour convention', () => {
    // The deliberate omissions (see the module header): TERM, FORCE_COLOR, CLICOLOR*,
    // CI. Pinned so that adding one is a decision somebody makes on purpose rather
    // than a drive-by that changes what a CI transcript contains. The near-miss
    // spellings are here too: only the exact name suppresses.
    const bags = [
      { TERM: 'dumb' },
      { TERM: '' },
      { FORCE_COLOR: '0' },
      { CLICOLOR: '0' },
      { CLICOLOR_FORCE: '1' },
      { CI: 'true' },
      { COLORTERM: '' },
      { NOCOLOR: '1' },
      { no_color: '1' },
      { NO_COLOUR: '1' },
    ]
    for (const env of bags) {
      expect(colorEnabled({ env, isTTY: true }), JSON.stringify(env)).toBe(true)
      expect(colorEnabled({ env, isTTY: false }), JSON.stringify(env)).toBe(false)
    }
  })

  it('fails closed on every nullish or falsy TTY answer, and coerces a truthy one', () => {
    // The first gate is `!isTTY`, so a caller that resolved the capability to
    // something other than a boolean still gets a defined answer: anything falsy is
    // silence.
    for (const isTTY of [undefined, null, false, 0, '', Number.NaN]) {
      expect(colorEnabled({ env: {}, isTTY }), String(isTTY)).toBe(false)
    }
    for (const isTTY of [true, 1, 'yes']) {
      expect(colorEnabled({ env: {}, isTTY }), String(isTTY)).toBe(true)
    }
  })

  it('checks the TTY before the bag, so a suppressed pipe needs no environment', () => {
    expect(colorEnabled({ isTTY: false })).toBe(false)
    expect(colorEnabled({ env: { NO_COLOR: '1' }, isTTY: false })).toBe(false)
  })
})

describe('QA renderStaticBanner — the frame handed to out(), seventeen times', () => {
  it('points STATIC_FRAME_INDEX at a frame the committed asset actually has', () => {
    // `frames[STATIC_FRAME_INDEX].rows` is dereferenced with no guard, on the first
    // line `ralph start` writes — an index past the end would be a TypeError before
    // any preflight rather than a missing banner.
    expect(Number.isInteger(STATIC_FRAME_INDEX)).toBe(true)
    expect(STATIC_FRAME_INDEX).toBeGreaterThanOrEqual(0)
    expect(STATIC_FRAME_INDEX).toBeLessThan(frames.length)
    expect(Array.isArray(frames[STATIC_FRAME_INDEX]?.rows)).toBe(true)
  })

  it('renders the still frame and NOT the other one', () => {
    // sprite-banner.test.js compares the output against frames[0]; that assertion
    // also passes if every frame renders identically, which would make "frame 0 is
    // the poster frame" unfalsifiable. The frames differ, so this is the half with
    // teeth.
    const other = frames.findIndex((_frame, index) => index !== STATIC_FRAME_INDEX)
    expect(other, 'the asset needs a second frame for this to mean anything').toBeGreaterThan(-1)
    expect(frames[other].rows).not.toEqual(frames[STATIC_FRAME_INDEX].rows)
    expect(enabled()).not.toEqual(renderSprite({ palette, rows: frames[other].rows }))
  })

  it('emits ceil(rows/2) lines — the 17 is derived, not a coincidence', () => {
    // The layout contract #68 draws a box around is "26 columns by 17 rows", and 17
    // is ceil(34/2) because two pixel rows share one text cell. Asserted as the
    // RELATION, so a future asset cannot satisfy the literal by accident.
    const rows = frames[STATIC_FRAME_INDEX].rows.length
    expect(enabled()).toHaveLength(Math.ceil(rows / 2))
    expect(rows % 2, 'an odd-height asset would render a half-height last row').toBe(0)
  })

  it('ends every line in exactly one reset and puts no newline inside one', () => {
    // Each line is written through `out()`, which appends the newline itself. A line
    // carrying its own newline would double-space the banner; a line not ending in a
    // reset would paint the rest of that terminal row.
    for (const line of enabled()) {
      expect(line.endsWith(RESET)).toBe(true)
      expect(line).not.toMatch(/[\n\r\t]/)
      expect(line.slice(0, -RESET.length).endsWith(RESET)).toBe(false)
    }
  })

  it('emits nothing but SGR sequences, half blocks and spaces', () => {
    for (const line of enabled()) {
      const cells = line.replace(SGR, '')
      expect([...cells].every((c) => c === UPPER || c === LOWER || c === ' ')).toBe(true)
      expect(cells).toHaveLength(26)
    }
  })

  it('is a function of its arguments alone: two calls, identical bytes', () => {
    expect(enabled().join('\u0000')).toBe(enabled().join('\u0000'))
  })

  it('hands back a fresh array the caller may keep, and never the data module', () => {
    // `ralph start` iterates the result, but a future caller may sort or splice it.
    // If the array were shared with lib/sprite-data.js, the second render in a
    // process would be corrupt.
    const first = enabled()
    first[0] = 'CLOBBERED'
    first.length = 1
    expect(enabled()).toHaveLength(17)
    expect(enabled()[0]).not.toBe('CLOBBERED')
  })

  it('does not mutate the palette or the frames it read', () => {
    const paletteBefore = structuredClone(palette)
    const framesBefore = structuredClone(frames)
    enabled()
    expect(palette).toEqual(paletteBefore)
    expect(frames).toEqual(framesBefore)
  })

  it('draws for truthy non-boolean capabilities and stays silent for falsy ones', () => {
    // The gate is `!isTTY || !color`, so a caller that resolved its capabilities to
    // 1/0 or a string gets the obvious answer rather than an exception.
    expect(renderStaticBanner({ isTTY: 1, color: 'yes' })).toHaveLength(17)
    for (const gate of [
      { isTTY: 0, color: true },
      { isTTY: true, color: 0 },
      { isTTY: true, color: null },
      { isTTY: null, color: null },
      { isTTY: '', color: '' },
    ]) {
      expect(renderStaticBanner(gate), JSON.stringify(gate)).toEqual([])
    }
  })

  it('returns an array with no bytes in it at all when suppressed', () => {
    // Not just "no escape": no empty string either. `out('')` would put a blank line
    // in a log file, which is a change to output that is supposed to be identical.
    for (const gate of [{ isTTY: false, color: true }, { isTTY: true, color: false }, undefined]) {
      const lines = renderStaticBanner(gate)
      expect(Array.isArray(lines)).toBe(true)
      expect(lines).toHaveLength(0)
      expect(lines.join('')).toBe('')
      expect(lines.join('')).not.toContain(ESC)
    }
  })
})

describe('QA sprite-banner — purity, demonstrated and transitive', () => {
  it('answers both questions with Date, Math.random and process trip-wired', () => {
    // The other half of sprite-banner.test.js's static read: the source may not
    // MENTION process, but a module it imports could, and a static read of one file
    // cannot see that. Every global the chain could reach throws for the duration of
    // one synchronous pair of calls, restored in `finally`.
    const realDate = globalThis.Date
    const realRandom = Math.random
    const realProcess = globalThis.process
    const tripwire = (name) => () => {
      throw new Error(`sprite-banner touched ${name}`)
    }
    let allowed
    let lines
    try {
      globalThis.Date = tripwire('Date')
      Math.random = tripwire('Math.random')
      globalThis.process = new Proxy(
        {},
        {
          get(_target, property) {
            throw new Error(`sprite-banner read process.${String(property)}`)
          },
        },
      )
      allowed = colorEnabled({ env: { TERM: 'xterm' }, isTTY: true })
      lines = renderStaticBanner({ isTTY: true, color: allowed })
    } finally {
      globalThis.Date = realDate
      Math.random = realRandom
      globalThis.process = realProcess
    }
    expect(allowed).toBe(true)
    expect(lines).toHaveLength(17)
  })

  it('ignores an ambient NO_COLOR entirely — the bag is the only source', () => {
    // #41 in one assertion: with the variable exported in the process, an injected
    // clean bag still draws. If the module ever read `process.env` itself, every
    // colour-gated spec in the suite would answer to the developer's shell.
    process.env.NO_COLOR = '1'
    expect(colorEnabled({ env: {}, isTTY: true })).toBe(true)
    expect(renderStaticBanner({ isTTY: true, color: true })).toHaveLength(17)
  })

  it('imports nothing that reads a clock, an environment or a filesystem', () => {
    // The static read, extended one hop: sprite-render.js is checked by its own
    // spec, and sprite-data.js is GENERATED — the file most likely to grow an import
    // nobody reviewed, and the one `ralph start` evaluates first.
    for (const name of ['sprite-data.js', 'sprite-render.js']) {
      const code = codeWithoutComments(new URL(`./${name}`, import.meta.url))
      expect(code, name).not.toMatch(/\bprocess\b/)
      expect(code, name).not.toMatch(/\bDate\b/)
      expect(code, name).not.toMatch(/Math\s*\.\s*random/)
      expect(code, name).not.toMatch(/\brequire\s*\(/)
      expect(code, name).not.toMatch(/\bimport\s*\(/)
      expect(code, name).not.toMatch(/node:(fs|os|path|child_process|tty)/)
    }
    // The data module is a literal, so it imports nothing at all.
    expect(readFileSync(new URL('./sprite-data.js', import.meta.url), 'utf8')).not.toMatch(
      /^import\s/m,
    )
  })
})
