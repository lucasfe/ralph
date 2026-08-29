// #74 — the banner's MODE, as a table.
//
// The resolver is a pure function of five values, so this file is mostly one table: a
// configured value, an environment override, TTY-ness, colour and a column count in, and
// the three decisions plus a warning out. Written as a table rather than as prose because
// the interesting part of this knob is not any single row — it is that the rows agree with
// each other about which direction capability may push the answer.
//
// THE ONE CLAIM WORTH STATING TWICE: capability caps the mode DOWNWARD and never upward.
// No spelling of RALPH_BANNER can put a sprite on a pipe, under NO_COLOR, or on a terminal
// narrower than the sprite — and the block at the bottom asserts that over every value the
// knob accepts, including the ones it doesn't, rather than trusting the table to have
// covered them.
//
// ...and the one that is easy to get backwards: an EXPLICIT `off` suppresses the identity
// box, while a CAPPED `off` does not. A piped `ralph start` has printed the box since #68
// and must keep printing it — a launchd log is exactly where "which version, which
// directory" is the question being asked — so the resolver distinguishes what the user
// REQUESTED from what the terminal can EFFECT.
import { describe, it, expect } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { BANNER_MODES, DEFAULT_BANNER_MODE, resolveBannerMode } from './banner-mode.js'
import { SPRITE_MIN_WIDTH, bannerLayout } from './banner-compose.js'

// A colour-capable terminal wide enough for everything, and the two ways of losing that.
const TTY = { isTTY: true, color: true }
const PIPE = { isTTY: false, color: false }
const NO_COLOR = { isTTY: true, color: false }

// The three fields, so a row of the table below reads as one expectation instead of three.
const shape = (mode, sprite, box) => ({ mode, sprite, box, warning: null })

// The warning a typo earns, worded exactly as resolveAgent words its own (#559): the
// ORIGINAL value, untrimmed and in its original case, so the typo is visible.
const typoWarning = (raw) =>
  `RALPH_BANNER='${raw}' unrecognized; falling back to 'full'. Valid: full, static, off.`

describe('resolveBannerMode — the table (#74)', () => {
  const TABLE = [
    // NOTHING SET is the zero-regression row: a colour-capable terminal animates, exactly
    // as it has since #73.
    ['unset, on a terminal', {}, TTY, 80, shape('full', true, true)],
    ['unset, on a pipe', {}, PIPE, 80, shape('off', false, true)],
    ['an empty configured value', { configured: '' }, TTY, 80, shape('full', true, true)],
    ['a whitespace configured value', { configured: '   ' }, TTY, 80, shape('full', true, true)],

    // FULL, and the three capabilities that cap it.
    ['full on a terminal', { configured: 'full' }, TTY, 80, shape('full', true, true)],
    ['full on a pipe', { configured: 'full' }, PIPE, 80, shape('off', false, true)],
    ['full under NO_COLOR', { configured: 'full' }, NO_COLOR, 80, shape('off', false, true)],
    ['full at 30 columns', { configured: 'full' }, TTY, 30, shape('full', true, true)],
    ['full at 20 columns', { configured: 'full' }, TTY, 20, shape('off', false, true)],

    // STATIC draws the same picture and plays none of it.
    ['static on a terminal', { configured: 'static' }, TTY, 80, shape('static', true, true)],
    ['static on a pipe', { configured: 'static' }, PIPE, 80, shape('off', false, true)],
    ['static at 30 columns', { configured: 'static' }, TTY, 30, shape('static', true, true)],
    ['static at 20 columns', { configured: 'static' }, TTY, 20, shape('off', false, true)],

    // OFF is the only value that takes the BOX away, because it is the only one where the
    // user asked for nothing rather than the terminal being unable to show something.
    ['off on a terminal', { configured: 'off' }, TTY, 80, shape('off', false, false)],
    ['off on a pipe', { configured: 'off' }, PIPE, 80, shape('off', false, false)],
    ['off at 20 columns', { configured: 'off' }, TTY, 20, shape('off', false, false)],

    // CASE AND WHITESPACE, on all three values.
    ['FULL', { configured: 'FULL' }, TTY, 80, shape('full', true, true)],
    ['  Static  ', { configured: '  Static  ' }, TTY, 80, shape('static', true, true)],
    ['\tOFF\n', { configured: '\tOFF\n' }, TTY, 80, shape('off', false, false)],

    // PRECEDENCE: the environment wins, the config is second, the default is last — and an
    // unset or blank override is not a choice, it defers.
    [
      'an override over a configured value',
      { configured: 'full', override: 'off' },
      TTY,
      80,
      shape('off', false, false),
    ],
    [
      'an override that turns the banner back on',
      { configured: 'off', override: 'full' },
      TTY,
      80,
      shape('full', true, true),
    ],
    [
      'an override of static over a configured full',
      { configured: 'full', override: 'static' },
      TTY,
      80,
      shape('static', true, true),
    ],
    [
      'an empty override, which defers to the config',
      { configured: 'static', override: '' },
      TTY,
      80,
      shape('static', true, true),
    ],
    [
      'a whitespace override, which defers to the config',
      { configured: 'static', override: '  ' },
      TTY,
      80,
      shape('static', true, true),
    ],
    [
      'an undefined override, which defers to the config',
      { configured: 'off', override: undefined },
      TTY,
      80,
      shape('off', false, false),
    ],

    // A TYPO IS NOT AN ABORT: full, plus one line for the user to act on.
    [
      'an unrecognized configured value',
      { configured: 'blinky' },
      TTY,
      80,
      { ...shape('full', true, true), warning: typoWarning('blinky') },
    ],
    [
      'an unrecognized override, which still beats a usable config',
      { configured: 'off', override: 'FULLL' },
      TTY,
      80,
      { ...shape('full', true, true), warning: typoWarning('FULLL') },
    ],
    [
      'an unrecognized value on a pipe — capped, and still warned about',
      { configured: 'nonsense' },
      PIPE,
      80,
      { ...shape('off', false, true), warning: typoWarning('nonsense') },
    ],
  ]

  for (const [name, values, capabilities, width, expected] of TABLE) {
    it(`resolves ${name}`, () => {
      expect(resolveBannerMode({ ...values, ...capabilities, width })).toEqual(expected)
    })
  }

  it('resolves the empty call, and the no-argument call, to the plain box', () => {
    // A caller that resolved nothing gets what a pipe gets: the facts, no decoration. Fails
    // CLOSED on the sprite, which is the same direction colorEnabled() fails in (#67) — a
    // caller who forgot to resolve a capability must not be handed a screenful of escapes.
    const plain = shape('off', false, true)
    expect(resolveBannerMode()).toEqual(plain)
    expect(resolveBannerMode({})).toEqual(plain)
  })
})

describe('resolveBannerMode — capability caps downward only (#74, criterion 6)', () => {
  // Every value the knob accepts, plus the ones it doesn't, against every way of not being
  // a terminal. Stated over the whole set rather than as three rows of the table, because
  // the claim is about what NO input can do.
  const VALUES = [
    undefined,
    '',
    '   ',
    'full',
    'FULL',
    ' full ',
    'static',
    'off',
    'blinky',
    'true',
    '1',
  ]
  const INCAPABLE = [
    ['a pipe', { isTTY: false, color: false }],
    ['a TTY with no colour', { isTTY: true, color: false }],
    ['colour claimed on a non-TTY', { isTTY: false, color: true }],
    ['a terminal narrower than the sprite', { isTTY: true, color: true, width: SPRITE_MIN_WIDTH - 1 }],
    ['a one-column terminal', { isTTY: true, color: true, width: 1 }],
  ]

  for (const [where, capabilities] of INCAPABLE) {
    it(`draws no sprite on ${where}, whatever RALPH_BANNER says`, () => {
      for (const value of VALUES) {
        const label = `${where} / ${JSON.stringify(value)}`
        // From the config...
        const fromConfig = resolveBannerMode({ configured: value, ...capabilities })
        expect(fromConfig.sprite, label).toBe(false)
        expect(fromConfig.mode, label).toBe('off')
        // ...and from the environment, which wins the precedence and still loses to this.
        const fromEnv = resolveBannerMode({ override: value, ...capabilities })
        expect(fromEnv.sprite, label).toBe(false)
        expect(fromEnv.mode, label).toBe('off')
      }
    })
  }

  it('keeps the facts on every capped run — only an explicit off takes the box away', () => {
    // The distinction the whole issue turns on. A pipe is not a request to be told nothing.
    for (const [where, capabilities] of INCAPABLE) {
      for (const value of VALUES.filter((v) => String(v).trim().toLowerCase() !== 'off')) {
        const label = `${where} / ${JSON.stringify(value)}`
        expect(resolveBannerMode({ configured: value, ...capabilities }).box, label).toBe(true)
      }
      expect(resolveBannerMode({ configured: 'off', ...capabilities }).box, where).toBe(false)
    }
  })

  it('never reports a mode the sprite gate would refuse', () => {
    // `mode` is the EFFECTIVE mode, which is what makes it safe for a caller to read it as
    // "how many frames": anything but `off` implies the sprite may be drawn, so a caller
    // asking for one frame is never asking for one frame of nothing.
    for (const isTTY of [true, false]) {
      for (const color of [true, false]) {
        for (const width of [undefined, 0, 1, 20, 25, 26, 30, 44, 60, 200]) {
          for (const configured of BANNER_MODES) {
            const resolved = resolveBannerMode({ configured, isTTY, color, width })
            const label = `${configured} / ${isTTY} / ${color} / ${width}`
            expect(resolved.mode === 'off' || resolved.sprite, label).toBe(true)
            expect(resolved.sprite, label).toBe(isTTY && color && bannerLayout(width).sprite && configured !== 'off')
          }
        }
      }
    }
  })
})

describe('resolveBannerMode — the registry (#74)', () => {
  it('exposes the three modes and the default', () => {
    expect(BANNER_MODES).toEqual(['full', 'static', 'off'])
    expect(DEFAULT_BANNER_MODE).toBe('full')
  })

  it('accepts nothing but the three, and warns about everything else', () => {
    // The registry and the resolver cannot drift: every member resolves to itself as the
    // REQUESTED mode (read here off the box, which no capability touches), and a value
    // outside it warns.
    for (const mode of BANNER_MODES) {
      const resolved = resolveBannerMode({ configured: mode, isTTY: true, color: true, width: 80 })
      expect(resolved.warning, mode).toBe(null)
      expect(resolved.mode, mode).toBe(mode)
    }
    for (const value of ['fu ll', 'none', 'true', 'FALSE', '0', '1', 'no', 'static-ish', '-']) {
      expect(resolveBannerMode({ configured: value }).warning, value).toBe(typoWarning(value))
    }
  })

  it('never throws, whatever it is handed', () => {
    // The knob is read off a committed file and an ambient environment, so the shapes below
    // are all reachable, and a banner is never worth losing a run over.
    const HOSTILE = [
      42,
      0,
      true,
      false,
      null,
      {},
      [],
      ['full'],
      Symbol.iterator,
      () => 'full',
      { toString: () => 'off' },
    ]
    for (const value of HOSTILE) {
      const label = String(typeof value)
      expect(() => resolveBannerMode({ configured: value, isTTY: true, color: true })).not.toThrow()
      expect(() => resolveBannerMode({ override: value, isTTY: true, color: true })).not.toThrow()
      // ...and nothing unusable is read as a mode: the run gets the default and a warning.
      const resolved = resolveBannerMode({ configured: value, isTTY: true, color: true, width: 80 })
      expect(BANNER_MODES, label).toContain(resolved.mode)
    }
  })

  it('coerces no value it was given — a hostile toString is never called', () => {
    // The same rule banner-rows.js states for its facts: `String(value)` on a hostile
    // object runs its `toString`, and this value comes out of ralph.config.sh and the
    // ambient environment. A non-string is refused, not converted.
    let called = 0
    const hostile = {
      toString() {
        called += 1
        return 'off'
      },
    }
    const resolved = resolveBannerMode({ configured: hostile, isTTY: true, color: true, width: 80 })
    expect(called).toBe(0)
    expect(resolved.mode).toBe('full')
    expect(resolved.box).toBe(true)
  })

  it('takes width, TTY-ness and colour as booleans, never as truthiness', () => {
    // `isTTY: 'yes'` is a caller bug, and the safe reading of a bug is silence — the same
    // direction colorEnabled() fails in. Nothing but `true` turns the sprite on.
    for (const truthy of ['yes', 1, {}, [], 'false']) {
      const label = JSON.stringify(truthy)
      expect(resolveBannerMode({ configured: 'full', isTTY: truthy, color: true }).sprite, label).toBe(false)
      expect(resolveBannerMode({ configured: 'full', isTTY: true, color: truthy }).sprite, label).toBe(false)
    }
  })
})

describe('banner-mode — purity', () => {
  it('reads no clock, no environment and no filesystem', () => {
    // Same method and the same reason as lib/sprite-banner.test.js and
    // lib/banner-compose.test.js: the ABSENCE of a capability cannot be shown by exercising
    // happy paths. This module is the one place the whole policy lives, so a `process.env`
    // read here would make every table row above a test of the shell the suite ran in (#41)
    // — and would quietly give the knob a second, undocumented source.
    const code = codeWithoutComments(new URL('./banner-mode.js', import.meta.url))

    expect(code).not.toMatch(/\bprocess\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/node:(fs|os|path|child_process|tty)/)
    // Its ONE import is the degradation ladder (#72), for the reason sprite-banner.js
    // imports it: the width at which the sprite may be drawn is one decision, and a second
    // copy of 26 here is how the halves of the banner come to disagree about which terminal
    // they are on. The frame under 44 columns is NOT asked about — that answer belongs to
    // composeBanner, which is handed the same width.
    expect([...code.matchAll(/^import .* from '(.*)'$/gm)].map((m) => m[1]).sort()).toEqual([
      './banner-compose.js',
    ])
    // ...and it writes nothing. The warning is RETURNED, so the caller owns the stream —
    // which is what keeps this table a comparison of values rather than of captured output.
    expect(code).not.toMatch(/console\s*\./)
    expect(code).not.toMatch(/\bwrite\s*\(/)
  })
})
