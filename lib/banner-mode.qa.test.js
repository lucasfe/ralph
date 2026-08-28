// #74 QA — the mode resolver, attacked from outside its own table.
//
// banner-mode.test.js proves the intended matrix: the three words, a handful of widths, the
// four capability combinations, and a cap-downward block over eleven values. This file takes
// the same one function to the places a TABLE cannot go, along the four seams a pure policy
// module actually breaks on:
//
//   * CRITERION 6 AS AN INVARIANT RATHER THAN A ROW. "No value turns the sprite on" is a
//     statement about EVERY value, so it is asserted over a generated cross-product — every
//     shape a knob can arrive in, in both positions and in both at once, against every way a
//     terminal can be incapable. A table with eleven values in it passes the day a twelfth
//     spelling starts authorising escape sequences into a launchd log; a sweep does not. And
//     the sweep is crossed against the RENDERER's own gate, so "the resolver said sprite" and
//     "sprite-banner.js would draw one" are pinned as the same answer rather than as two
//     answers that happen to agree.
//   * PRECEDENCE, EXHAUSTIVELY. Two sources, and each can be absent, null, empty,
//     whitespace-only, valid, valid-but-oddly-cased, quote-wrapped or a typo. This module's
//     rule is not "the environment wins" — it is "the environment wins WHEN IT SAID
//     SOMETHING", and the interesting rows are the ones where one side is a non-answer. Both
//     halves are then re-asserted as properties: a blank override changes nothing, and a
//     stated one makes the config unreadable — including its typos, which is the one
//     consequence of this precedence a user can be surprised by.
//   * THE WIDTH, at the one rung of #72's ladder this module reads, and in every shape a
//     caller can produce. `stdout.columns` is `undefined` on a pipe, `0` on some CI runners
//     and a float on nothing at all. The boundary is pinned as literals — 25/26 for the
//     sprite — and everything else against `bannerLayout`, which is the one owner of that
//     number.
//   * HOSTILE VALUES, because both inputs come from outside the process: one from a file a
//     user edits by hand, one from an ambient environment. A resolver that coerced would run
//     a `toString` off a config file; a resolver that threw would cost a launch. Neither may
//     happen for any shape, so `toString`, `valueOf` and `Symbol.toPrimitive` are call-COUNTED
//     rather than assumed unread, and a Proxy that throws on every trap is passed in as a
//     value to prove no property of it is ever touched.
//
// ...plus the claim that took the place of the one an earlier draft of #74 needed a whole
// block for. That draft resolved the box's FRAME here as well and handed it down to
// `composeBanner` as a capability, which made two owners of a decision that already had one —
// and the second could only ever agree with the first, since both read the same width. So the
// frame is not in this resolver's answer at all, and what is asserted instead is a NEGATIVE:
// over every width, the only thing this module says about the identity box is WHETHER it
// prints. What it LOOKS like is `bannerLayout`'s answer inside the composer, reached from the
// same column count `ralph start` has always passed it.
//
// Nothing here reads an environment, a clock, a stream or a file (#41). The warning's wording
// is spelled out rather than imported, so an expectation in this file cannot agree with a typo
// in the implementation's own template.

import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import {
  BANNER_MODES,
  DEFAULT_BANNER_MODE,
  resolveBannerMode as resolve,
} from './banner-mode.js'
import { SPRITE_MIN_WIDTH, bannerLayout } from './banner-compose.js'
import { renderSplashFrames, renderStaticBanner } from './sprite-banner.js'

const ESC = '\u001B'

// The one context in which a sprite is allowed at all: a colour-capable terminal, wide
// enough. Everything in this file that expects to SEE a sprite starts from here.
const CAPABLE = { isTTY: true, color: true, width: 80 }

// Every shape a RALPH_BANNER value can arrive in, named rather than interpolated so a failure
// names the case instead of printing a hundred thousand characters or throwing on a Symbol.
//
// The list is deliberately three lists in one: the spellings a user might reasonably type,
// the spellings a shell or an editor produces by accident (a trailing newline out of
// `$(cat …)`, a BOM out of an editor, a value the config grammar left its quotes on), and the
// shapes only a programming mistake produces. All three go through the same sweep, because
// the sprite invariant below is not allowed to care which is which.
const VALUES = [
  ['unset', undefined],
  ['null', null],
  ['empty', ''],
  ['one space', ' '],
  ['a tab', '\t'],
  ['a newline', '\n'],
  ['mixed blanks', ' \t\n\r '],
  ['a non-breaking space', '\u00A0'],
  ['full', 'full'],
  ['FULL', 'FULL'],
  ['Full', 'Full'],
  ['padded full', '  full  '],
  ['full with a trailing newline', 'full\n'],
  ['full wrapped in non-breaking spaces', '\u00A0full\u00A0'],
  ['BOM-prefixed full', '\uFEFFfull'],
  ['static', 'static'],
  ['STATIC', 'STATIC'],
  ['padded static', ' Static '],
  ['off', 'off'],
  ['OFF', 'OFF'],
  ['padded off', ' off '],
  ['a typo', 'blinky'],
  ['true', 'true'],
  ['false', 'false'],
  ['1', '1'],
  ['0', '0'],
  ['none', 'none'],
  ['no', 'no'],
  ['two modes', 'full static'],
  ['a split word', 'fu ll'],
  ['double-quoted off', '"off"'],
  ['single-quoted off', "'off'"],
  ['quotes alone', '""'],
  ['a comment glued to off', 'off#quiet'],
  ['a leading hash', '#off'],
  ['off with a NUL in it', 'off\u0000'],
  ['off with an ANSI escape in it', `${ESC}[31moff`],
  ['a value with a second line', 'nope\n❌ Ralph exploded'],
  ['a printf token', '%s'],
  ['a shell expansion', '${HOME}'],
  ['a command substitution', '`whoami`'],
  ['a number', 42],
  ['zero', 0],
  ['a negative number', -1],
  ['a float', 1.5],
  ['NaN', Number.NaN],
  ['true (boolean)', true],
  ['false (boolean)', false],
  ['a bigint', 10n],
  ['an object', {}],
  ['an array', []],
  ['an array holding off', ['off']],
  ['a function returning off', () => 'off'],
  ['a symbol', Symbol('off')],
  ['a boxed string', new String('off')],
  ['a boxed boolean', new Boolean(true)],
  ['a Date', new Date(0)],
  ['a RegExp', /off/],
  ['a Map', new Map([['mode', 'off']])],
  ['a null-prototype object', Object.create(null)],
  ['a frozen object', Object.freeze({ mode: 'off' })],
]

/** The widths the sprite rung splits on, plus the two the frame rung does — the frame is not
 * this module's decision, and the widths either side of it are here to prove that. */
const WIDTHS = [
  undefined,
  null,
  0,
  -0,
  -1,
  -80,
  0.5,
  1,
  1.5,
  2,
  24,
  25,
  25.9,
  26,
  27,
  42,
  43,
  43.9,
  44,
  44.5,
  45,
  59,
  60,
  61,
  80,
  200,
  1e6,
  Number.MAX_SAFE_INTEGER,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  '80',
  '',
  {},
  [],
  true,
  false,
  () => 60,
]

// Every way a terminal can refuse a sprite. The first four are the real ones — a pipe, a
// launchd log, NO_COLOR, a 20-column pane — and the rest are the caller bugs the resolver's
// `=== true` exists for: a bag carrying `isTTY: 1` or `color: 'always'` must not be read as
// consent to write escape sequences somewhere they will be read as text (#67).
const INCAPABLE = [
  ['a pipe', { isTTY: false, color: false }],
  ['nothing stated at all', {}],
  ['a TTY with no colour', { isTTY: true, color: false }],
  ['colour without a TTY', { isTTY: false, color: true }],
  ['isTTY: 1', { isTTY: 1, color: true }],
  ["isTTY: 'yes'", { isTTY: 'yes', color: true }],
  ['isTTY: an object', { isTTY: {}, color: true }],
  ['color: 1', { isTTY: true, color: 1 }],
  ["color: 'always'", { isTTY: true, color: 'always' }],
  ['both boxed booleans', { isTTY: new Boolean(true), color: new Boolean(true) }],
  ['one column under the rung', { isTTY: true, color: true, width: SPRITE_MIN_WIDTH - 1 }],
  ['one column', { isTTY: true, color: true, width: 1 }],
]

describe('QA resolveBannerMode — criterion 6 as an invariant, not a table row (#74)', () => {
  it('lets no value, in either position, turn the sprite on where the terminal cannot hold one', () => {
    // THE CLAIM THE ISSUE TURNS ON, swept rather than sampled. The failure this prevents is a
    // future spelling — `RALPH_BANNER=force`, `always`, `yes` — that a reviewer adds to the
    // registry as "an escape hatch" and that then paints 26 columns of truecolor into a
    // launchd log, a CI transcript or a `| tee`. There is no hatch: the only way to a sprite
    // is both capabilities passed as `true` by the CALLER, which is what sprite-banner.js
    // documents and what INCAPABLE excludes.
    let checked = 0
    for (const [valueName, value] of VALUES) {
      for (const [contextName, context] of INCAPABLE) {
        // Both positions, and both at once: the environment override, the committed config,
        // and a repo whose file and shell agree.
        for (const bag of [{ override: value }, { configured: value }, { configured: value, override: value }]) {
          const where = `${valueName} / ${contextName} / ${Object.keys(bag).join('+')}`
          const result = resolve({ ...context, ...bag })
          expect(result.sprite, where).toBe(false)
          expect(result.mode, where).toBe('off')
          checked += 1
        }
      }
    }
    // The anti-vacuity pin: a typo in the loops above that skipped the body would leave every
    // assertion unmade and this test green.
    expect(checked).toBe(VALUES.length * INCAPABLE.length * 3)
    expect(checked).toBeGreaterThan(1500)
  })

  it('answers the sprite question exactly as the renderer that draws it would', () => {
    // The invariant behind criterion 6, and the one a static read of either module cannot
    // make: this resolver and lib/sprite-banner.js's own gate ask the SAME ladder, so a
    // resolver authorising a sprite the renderer refuses would hand `ralph start` a `static`
    // mode with no frames in it — a run that hid a cursor, slept for a beat and drew nothing.
    // Asserted as an equality against the renderer's OUTPUT, at every width, over the
    // capability bags a real run can produce: `ralph start` derives `stdoutIsTTY` with
    // `Boolean(...)` and `color` from `colorEnabled`, so both arrive as honest booleans.
    for (const requested of ['full', 'static']) {
      for (const width of WIDTHS) {
        for (const isTTY of [true, false]) {
          for (const color of [true, false]) {
            const capabilities = { isTTY, color, width }
            const where = `${requested} @ ${String(width)} / isTTY:${isTTY} color:${color}`
            const result = resolve({ configured: requested, ...capabilities })
            expect(result.sprite, where).toBe(renderSplashFrames(capabilities).length > 0)
            // ...and the still the `static` mode is made of, from the same gate.
            expect(result.sprite, where).toBe(renderStaticBanner(capabilities).length > 0)
          }
        }
      }
    }
  })

  it('is never LOOSER than that renderer, for any capability bag a caller can assemble', () => {
    // ...and the same claim in the only direction that can hurt, taken to the bags a caller
    // bug produces. The two gates read their capabilities DIFFERENTLY on purpose: the renderer
    // asks `!isTTY || !color` (truthiness) and this resolver asks `=== true` (#67), so a bag
    // carrying `isTTY: 1` is a sprite to the renderer and no sprite to the resolver.
    //
    // That asymmetry is SAFE and this test is what keeps it that way, because only one
    // direction is a bug: the resolver gates the call, so a resolver that is stricter merely
    // draws nothing, while a resolver that were LOOSER would promise `ralph start` a `static`
    // mode whose frame list came back empty — one 200ms nap, a hidden cursor and no picture.
    // Implication rather than equality, therefore, plus the specific divergence pinned below so
    // it reads as a decision rather than as a hole.
    for (const [contextName, context] of [['capable', CAPABLE], ...INCAPABLE]) {
      for (const width of WIDTHS) {
        const capabilities = { ...context, width }
        const where = `${contextName} @ ${String(width)}`
        if (resolve({ configured: 'full', ...capabilities }).sprite) {
          expect(renderSplashFrames(capabilities).length, where).toBeGreaterThan(0)
          expect(renderStaticBanner(capabilities).length, where).toBeGreaterThan(0)
        }
      }
    }

    // The divergence itself, so a future reader knows it was measured: a truthy-but-not-`true`
    // capability draws in the renderer and stays silent in the resolver. Unreachable from the
    // CLI — `stdoutIsTTY` is a `Boolean(...)` and `color` comes from `colorEnabled` — and the
    // strictness is the side to be on for the one seam where it is reachable, a caller
    // assembling the bag by hand (#75/#76).
    const sloppy = { isTTY: 1, color: 'always', width: 80 }
    expect(renderSplashFrames(sloppy).length).toBeGreaterThan(0)
    expect(resolve({ configured: 'full', ...sloppy })).toMatchObject({ sprite: false, mode: 'off' })
  })

  it('never separates the mode from the sprite: one is the other, in both directions', () => {
    // `mode` is what a caller spends on `cycles` and `sprite` is what it spends on frames, so
    // the two disagreeing is a run that asks for one animation cycle of an empty frame list —
    // or, worse, five cycles of frames it was told not to draw.
    for (const [valueName, value] of VALUES) {
      for (const [contextName, context] of [['capable', CAPABLE], ...INCAPABLE]) {
        for (const width of [undefined, 25, 26, 43, 44, 60]) {
          const where = `${valueName} / ${contextName} @ ${String(width)}`
          const result = resolve({ configured: value, ...context, width })
          expect(result.sprite, where).toBe(result.mode !== 'off')
        }
      }
    }
  })

  it('caps a mode to off and never sideways — no width degrades full into static', () => {
    // The plausible future bug this forbids: a "graceful degradation" that answers `static`
    // for a narrow or slow terminal instead of `off`. It would be silent — the picture would
    // still be right — and it would change what `ralph start` passes as `cycles`, making the
    // animation vanish on machines nobody tested. A capped mode is `off`; a mode that is not
    // `off` is the word the user actually typed.
    const requestedFor = { full: 'full', static: 'static', off: 'off', blinky: 'full', '': 'full' }
    for (const [typed, word] of Object.entries(requestedFor)) {
      for (const [contextName, context] of [['capable', CAPABLE], ...INCAPABLE]) {
        for (const width of WIDTHS) {
          const where = `${typed} / ${contextName} @ ${String(width)}`
          const result = resolve({ configured: typed, ...context, width })
          expect([word, 'off'], where).toContain(result.mode)
          if (word === 'off') expect(result.mode, where).toBe('off')
        }
      }
    }
  })

  it('lets no capability clear the box and no capability set it — only the user decides', () => {
    // The distinction the issue turns on, stated as the complement of the sweep above: the
    // terminal caps the SPRITE and has no vote on the FACTS. A pipe is not a request to be
    // told nothing; `RALPH_BANNER=off` is. The failure this prevents is a refactor that folds
    // `box` into the same expression as `sprite` — after which a launchd log, which is exactly
    // where "which version, which directory" gets asked, silently loses its first three lines.
    for (const [valueName, value] of VALUES) {
      const explicitlyOff = typeof value === 'string' && value.trim().toLowerCase() === 'off'
      for (const [contextName, context] of [['capable', CAPABLE], ...INCAPABLE]) {
        for (const width of [undefined, 0, 1, 25, 26, 43, 44, 60, 200]) {
          const where = `${valueName} / ${contextName} @ ${String(width)}`
          expect(resolve({ configured: value, ...context, width }).box, where).toBe(!explicitlyOff)
        }
      }
    }
  })
})

describe('QA resolveBannerMode — precedence, exhaustively (#74)', () => {
  // The observable answer, compressed to something a table row can hold: which word won, and
  // whether it cost a warning. Resolved on a capable terminal so `mode` is the requested word
  // rather than the cap.
  const outcomeOf = (bag) => {
    const result = resolve({ ...CAPABLE, ...bag })
    return { mode: result.mode, box: result.box, warned: result.warning !== null }
  }

  // Each row: the environment, the config, and the word that must win. Written as LITERALS
  // rather than computed from the rule, because a table that restates the implementation's
  // formula is a tautology — the point of these rows is that a human read them and agreed.
  const ROWS = [
    // Neither source says anything: the default, silently. Eight spellings of "no opinion",
    // because a `RALPH_BANNER=` in a shell script and a `RALPH_BANNER=""` in the config both
    // arrive as the empty string and neither is a choice.
    [undefined, undefined, 'full', false],
    [null, null, 'full', false],
    ['', '', 'full', false],
    ['   ', '\t\n ', 'full', false],
    ['\u00A0', '', 'full', false],
    // Only the config speaks.
    [undefined, 'off', 'off', false],
    [null, 'off', 'off', false],
    ['', 'off', 'off', false],
    ['   ', 'off', 'off', false],
    ['\n', 'static', 'static', false],
    // Only the environment speaks.
    ['off', undefined, 'off', false],
    ['off', null, 'off', false],
    ['off', '', 'off', false],
    ['static', '   ', 'static', false],
    // Both speak: the environment is the invocation and it wins.
    ['off', 'full', 'off', false],
    ['full', 'off', 'full', false],
    ['static', 'off', 'static', false],
    ['off', 'static', 'off', false],
    ['OFF', 'full', 'off', false],
    [' off ', 'FULL', 'off', false],
    ['off\n', 'full', 'off', false],
    // A TYPO IN THE CONFIG IS INVISIBLE WHEN THE ENVIRONMENT OVERRIDES IT. The consequence of
    // env-over-config a user can actually be surprised by: `RALPH_BANNER=off ralph start` in a
    // repo whose committed line says `blinky` prints no warning at all, because the resolver
    // never had to read that line. Pinned deliberately — the alternative is warning about a
    // value that had no effect on this run.
    ['off', 'blinky', 'off', false],
    ['full', 'blonky', 'full', false],
    // ...and the mirror, which is the one that costs something: a typo in the ENVIRONMENT
    // masks a perfectly good committed value, because the override said SOMETHING and this
    // resolver does not fall back through a bad value to a good one. One warning, and the
    // default rather than the config's `off`.
    ['blinky', 'off', 'full', true],
    ['blinky', 'static', 'full', true],
    ['blinky', 'blonky', 'full', true],
    // A blank environment is not "something", so the config's typo is the one that warns.
    ['', 'blinky', 'full', true],
    ['   ', 'blinky', 'full', true],
    [undefined, 'blinky', 'full', true],
    // Quotes the grammar did not strip, or a shell single-quoted twice: a value, and a wrong
    // one. `RALPH_BANNER='"off"' ralph start` earns a warning rather than silently working.
    ['"off"', 'full', 'full', true],
    ["'off'", 'full', 'full', true],
    ['""', 'off', 'full', true],
    // An explicit `off` in both places is still one `off`.
    ['off', 'off', 'off', false],
  ]

  for (const [override, configured, expected, warned] of ROWS) {
    const where = `${JSON.stringify(override)} over ${JSON.stringify(configured)}`
    it(`resolves ${where} to ${expected}${warned ? ' with a warning' : ''}`, () => {
      expect(outcomeOf({ override, configured })).toEqual({
        mode: expected,
        box: expected !== 'off',
        warned,
      })
    })
  }

  it('treats every blank override as no override at all, whatever the config says', () => {
    // The property behind the rows above: a blank is not a choice, so the answer must be
    // BYTE-IDENTICAL to the answer with no override in the bag — warning included. The failure
    // this prevents is a `??`-style guard (`override ?? configured`) replacing the current
    // "stated" test, after which `RALPH_BANNER= ralph start` would silence a repo's committed
    // `static` and mean "default" instead of "no opinion".
    for (const blank of [undefined, null, '', ' ', '\t', '\n', ' \t\n\r ', '\u00A0', '\uFEFF']) {
      for (const configured of [undefined, '', 'off', 'static', 'full', 'blinky', 42]) {
        const where = `${JSON.stringify(blank)} / ${JSON.stringify(configured)}`
        expect(resolve({ ...CAPABLE, override: blank, configured }), where).toEqual(
          resolve({ ...CAPABLE, configured }),
        )
      }
    }
  })

  it('makes the config unreadable once the environment states anything at all', () => {
    // The other half, and the sharper one: a stated override — valid or not — must produce the
    // same answer for EVERY config value, including the shapes that would otherwise warn. A
    // regression that fell back through a bad override to a good config would make
    // `RALPH_BANNER=oops ralph start` behave differently in two repos, which is the one thing
    // an invocation-scoped knob may not do.
    for (const override of ['off', 'full', 'static', 'OFF', ' off ', 'blinky', '""', 42, {}, false]) {
      const answers = [undefined, null, '', '   ', 'off', 'static', 'full', 'blinky', 42, {}].map(
        (configured) => resolve({ ...CAPABLE, override, configured }),
      )
      for (const answer of answers) {
        expect(answer, JSON.stringify(String(override))).toEqual(answers[0])
      }
    }
  })

  it('never lets a non-string in one source be read as the other source’s value', () => {
    // The subtle half of "stated": a non-string is STATED and unusable, not absent. So a
    // caller bug in the environment position — a bag holding a number, an object or a boolean
    // — masks the config rather than deferring to it, and says so on stderr. Documented in
    // banner-mode.js and pinned here because it is the one row of the precedence table that
    // reads backwards: `false` is not "no override".
    for (const override of [0, false, {}, [], Symbol('off'), 10n, new String('off')]) {
      const result = resolve({ ...CAPABLE, override, configured: 'off' })
      expect(result.mode, typeof override).toBe('full')
      expect(result.warning, typeof override).toBe(
        `RALPH_BANNER=<a ${typeof override}> unrecognized; falling back to 'full'. Valid: full, static, off.`,
      )
    }
  })
})

describe('QA resolveBannerMode — the width, at its one rung and in every wrong shape (#74)', () => {
  it('draws the sprite at twenty-six columns and not at twenty-five', () => {
    // #72's sprite rung, spelled out as literals rather than derived, because this is the
    // boundary a reader wants to be able to check by eye. 25 is one column short of the
    // sprite's own 26 cells; 26 fits exactly.
    expect(resolve({ ...CAPABLE, width: 25 }).sprite).toBe(false)
    expect(resolve({ ...CAPABLE, width: 25 }).mode).toBe('off')
    expect(resolve({ ...CAPABLE, width: 26 }).sprite).toBe(true)
    expect(resolve({ ...CAPABLE, width: 26 }).mode).toBe('full')
    expect(resolve({ ...CAPABLE, width: 27 }).sprite).toBe(true)
    // ...and the box is still printed on the narrow side of it. A 25-column terminal gets the
    // facts; only the user can take those away. Whether they arrive framed is the composer's
    // answer at that width, not this module's.
    expect(resolve({ ...CAPABLE, width: 25 }).box).toBe(true)
    // The rung is the ladder's, not this module's: a change to SPRITE_MIN_WIDTH must move the
    // boundary, and the two lines above are what would then fail loudly rather than silently.
    expect(SPRITE_MIN_WIDTH).toBe(26)
  })

  it('answers identically on both sides of the frame rung, which is not its rung', () => {
    // What this test used to assert was the resolver's own answer about the frame, and that
    // answer is gone: #72's 44-column rung belongs to `composeBanner`, which reads the same
    // width, so a second copy of it here could only agree by assertion. The claim that
    // replaces it is the negative — 43, 44 and 45 resolve to the SAME three decisions — and it
    // is what would fail if a refactor moved the frame rung back up into this module.
    const at = (width) => resolve({ ...CAPABLE, width })
    expect(at(43)).toEqual(at(44))
    expect(at(44)).toEqual(at(45))
    // ...and a sprite is drawn on both sides of it: the two rungs are independent, so a
    // 43-column terminal gets a sprite over a bare box.
    expect(at(43).sprite).toBe(true)
  })

  it('floors a fractional width rather than rounding it', () => {
    // The shapes only a lying stream produces, pinned because they straddle the boundary: 25.9
    // is 25 columns of terminal, not 26, and a sprite drawn there would wrap.
    expect(resolve({ ...CAPABLE, width: 25.9 }).sprite).toBe(false)
    expect(resolve({ ...CAPABLE, width: 26.5 }).sprite).toBe(true)
    // ...and the discontinuity that surprises: a fraction UNDER one column floors to zero,
    // which the ladder reads as "no width stated" and answers with its 60-column default —
    // while 1.5 floors to a real, honest, useless single column.
    expect(resolve({ ...CAPABLE, width: 0.5 })).toMatchObject({ sprite: true })
    expect(resolve({ ...CAPABLE, width: 1.5 })).toMatchObject({ sprite: false })
  })

  it('reads every width a stream can lie with as the ladder reads it, and never throws', () => {
    // A pipe reports `undefined`, some CI runners report `0`, and the rest of this list is what
    // a careless or hostile bag can hold. None of it may throw, and none of it may disagree
    // with `bannerLayout` — which is the one owner of the rung, and the reason 26 appears
    // nowhere in banner-mode.js.
    for (const width of WIDTHS) {
      const where = String(width)
      const layout = bannerLayout(width)
      expect(resolve({ ...CAPABLE, width }).sprite, where).toBe(layout.sprite)
      // ...and a width has no vote on the answer that is the user's alone.
      expect(resolve({ configured: 'off', ...CAPABLE, width }), where).toMatchObject({
        box: false,
        mode: 'off',
      })
    }
  })

  it('is not talked into a sprite by a very large width on a stream that is not a terminal', () => {
    // The one combination a "wider is better" refactor would get wrong: a huge column count
    // says nothing about whether escapes are welcome.
    for (const width of [200, 1e6, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) {
      expect(resolve({ configured: 'full', width }).sprite, String(width)).toBe(false)
      expect(resolve({ configured: 'full', isTTY: true, color: false, width }).sprite, String(width)).toBe(false)
    }
  })
})

describe('QA resolveBannerMode — hostile values (#74)', () => {
  it('never runs a toString, a valueOf or a Symbol.toPrimitive it was handed', () => {
    // Both inputs come from outside the process: one from a file a user edits by hand, one
    // from an ambient environment. `String(value)` on either would be this module executing
    // code it read off disk — the same argument banner-compose.js's `textOr` makes for
    // refusing rather than converting. Counted rather than assumed, in both positions, because
    // the coercion a future refactor adds would be a one-character change (`${raw}`) with no
    // visible effect on any happy path.
    const calls = []
    const bait = () => ({
      toString() {
        calls.push('toString')
        return 'full'
      },
      valueOf() {
        calls.push('valueOf')
        return 'full'
      },
      [Symbol.toPrimitive]() {
        calls.push('toPrimitive')
        return 'full'
      },
    })
    for (const bag of [{ configured: bait() }, { override: bait() }, { configured: bait(), override: bait() }]) {
      const result = resolve({ ...CAPABLE, ...bag })
      expect(result.mode).toBe('full')
      expect(result.warning).toContain('<a object>')
      // ...and it is the DEFAULT full, not the bait's `full`: the warning proves the value was
      // refused rather than converted into the very word it was pretending to be.
      expect(result.warning).not.toContain("'full'unrecognized")
    }
    expect(calls).toEqual([])
  })

  it('survives a value whose every property access throws', () => {
    // The strongest form of the claim above: a Proxy that throws on every trap. `typeof` is
    // the only thing this module may do with a non-string, and `typeof` triggers no trap — so
    // a resolver that so much as looked at `.length`, `.trim` or `.toLowerCase` before
    // checking the type would abort a launch here rather than print a warning.
    const hostile = new Proxy(
      {},
      {
        get: (_t, property) => {
          throw new Error(`read ${String(property)}`)
        },
        has: () => {
          throw new Error('has')
        },
        ownKeys: () => {
          throw new Error('ownKeys')
        },
        getPrototypeOf: () => {
          throw new Error('getPrototypeOf')
        },
      },
    )
    for (const bag of [{ configured: hostile }, { override: hostile }]) {
      const result = resolve({ ...CAPABLE, ...bag })
      expect(result).toEqual({
        mode: 'full',
        sprite: true,
        box: true,
        warning:
          "RALPH_BANNER=<a object> unrecognized; falling back to 'full'. Valid: full, static, off.",
      })
    }
  })

  it('names a non-string by its type and interpolates nothing of it', () => {
    // The warning goes to a terminal, and its whole job is showing the user what they typed.
    // For a non-string there is nothing safe to show, so it says the type — and must not leak
    // `[object Object]`, a stringified array, a class name or a Symbol description, all of
    // which would mean a coercion happened somewhere.
    const cases = [
      [42, 'number'],
      [0, 'number'],
      [true, 'boolean'],
      [false, 'boolean'],
      [{}, 'object'],
      [[], 'object'],
      [['off'], 'object'],
      [new Date(0), 'object'],
      [/off/, 'object'],
      [Object.create(null), 'object'],
      [new String('off'), 'object'],
      [10n, 'bigint'],
      [Symbol('secret'), 'symbol'],
      [() => 'off', 'function'],
      [class Off {}, 'function'],
    ]
    for (const [value, type] of cases) {
      const { warning, mode } = resolve({ ...CAPABLE, configured: value })
      expect(warning, type).toBe(
        `RALPH_BANNER=<a ${type}> unrecognized; falling back to 'full'. Valid: full, static, off.`,
      )
      expect(warning, type).not.toContain('[object')
      expect(warning, type).not.toContain('secret')
      expect(mode, type).toBe('full')
    }
  })

  it('echoes a string value as written, and adds nothing to it', () => {
    // The other half: a string IS shown, untrimmed and in its original case, because a user
    // who typed `Full ` and got a warning about `full` would go looking for a different bug.
    for (const value of ['blinky', 'Blinky', ' blinky ', 'blinky\t', 'BLINKY', 'off off', '"off"']) {
      expect(resolve({ ...CAPABLE, configured: value }).warning, JSON.stringify(value)).toBe(
        `RALPH_BANNER='${value}' unrecognized; falling back to 'full'. Valid: full, static, off.`,
      )
    }
  })

  it('returns a value with a newline in it UNCOLLAPSED, which is the caller’s job', () => {
    // A seam worth pinning from both ends. This module returns a warning as DATA, so the
    // newline a config file can put inside a quoted value survives into it — and `ralph start`
    // is what runs it through `oneLine` (#62) before it reaches stderr. Asserting the raw form
    // here is what makes the wiring test's assertion mean something: if this module started
    // collapsing, the two tests would still pass and the collapse would be happening twice; if
    // the CALLER stopped, the wiring test fails alone and points at the right file.
    const { warning } = resolve({ ...CAPABLE, override: 'nope\n❌ Ralph exploded' })
    expect(warning).toContain('\n')
    expect(warning.split('\n')).toHaveLength(2)
    expect(warning.startsWith("RALPH_BANNER='nope\n")).toBe(true)
  })

  it('formats nothing: a printf token, a shell expansion and an escape survive verbatim', () => {
    // The value reaches a terminal, and three families of it would be dangerous if anything in
    // the chain interpreted them. Nothing here does — the warning is built with template
    // interpolation of one already-a-string value — and this is the test that fails if someone
    // reaches for `util.format` or a `%s`-style logger.
    for (const value of ['%s%s%n', '${HOME}', '`whoami`', '$(rm -rf /)', `${ESC}[31mred`]) {
      const { warning } = resolve({ ...CAPABLE, configured: value })
      expect(warning, value).toContain(`RALPH_BANNER='${value}' unrecognized`)
    }
    // The ESCAPE case, pinned as CURRENT BEHAVIOUR rather than as an endorsement: the raw
    // value reaches this module's warning, because this module is PURE and hands a string to a
    // caller rather than to a terminal. It is no longer the same trade `resolveAgent` makes —
    // #108 moved that one's echo through `oneLineEcho` at the source, since its two callers
    // (`ralph doctor`, `ralph init`) print it as-is — while THIS warning's only printer,
    // `ralph start`, already put it through `oneLine`, which since the same issue replaces an
    // ANSI sequence with U+FFFD. So the containment is a caller's here and stays asserted
    // through the real command in lib/commands/start.banner-mode.qa.test.js. If a SECOND caller
    // ever prints this warning, that is the moment to move the guarantee down here too.
    expect(resolve({ ...CAPABLE, configured: `${ESC}[31moff` }).warning).toContain(ESC)
  })

  it('holds a hundred-thousand-character value without truncating, growing or throwing', () => {
    // A config line is as long as a user's editor will let it be. This module has no length
    // limit and needs none — it is the caller's `oneLine` that caps a diagnostic at 200
    // characters — but it must not throw, must not go quadratic, and must not silently accept
    // a value because it was long enough to look like something.
    const huge = 'x'.repeat(100_000)
    const result = resolve({ ...CAPABLE, configured: huge })
    expect(result.mode).toBe('full')
    expect(result.warning.length).toBeGreaterThan(100_000)
    expect(result.warning.startsWith(`RALPH_BANNER='${huge.slice(0, 10)}`)).toBe(true)
    // ...and a long value that IS a mode, padded to the same length by whitespace, still works:
    // trimming happens before the registry lookup, not after a length check.
    expect(resolve({ ...CAPABLE, configured: `${' '.repeat(100_000)}off` }).mode).toBe('off')
    expect(resolve({ ...CAPABLE, configured: `${' '.repeat(100_000)}off` }).warning).toBe(null)
  })

  it('reads a NUL, a BOM and a non-breaking space the way a shell would leave them', () => {
    // Three characters a value can pick up on the way in without a user seeing them. The BOM
    // and the NBSP are whitespace to `trim`, so a value an editor prefixed with a byte-order
    // mark still resolves — while a NUL is not whitespace and makes the value a typo, which is
    // the right answer: it is not `off`, and a silent `full` would leave a user unable to see
    // why their file does nothing.
    expect(resolve({ ...CAPABLE, configured: '\uFEFFoff' }).mode).toBe('off')
    expect(resolve({ ...CAPABLE, configured: '\u00A0off\u00A0' }).mode).toBe('off')
    expect(resolve({ ...CAPABLE, configured: '\u2003off ' }).mode).toBe('off')
    expect(resolve({ ...CAPABLE, configured: 'off\u0000' })).toMatchObject({ mode: 'full' })
    expect(resolve({ ...CAPABLE, configured: 'off\u0000' }).warning).toContain('unrecognized')
  })
})

describe('QA resolveBannerMode — totality and shape (#74)', () => {
  it('never throws, for any value in any position at any width in any capability', () => {
    // The claim the docblock makes — "never throws: a knob read off a committed file and an
    // ambient environment must cost a picture at worst, never a run" — swept rather than
    // sampled. Every throw here is a `ralph start` that dies before its first preflight line
    // because of a decoration setting.
    let calls = 0
    for (const [valueName, value] of VALUES) {
      for (const width of [undefined, 0, 1, 26, 44, 60, Number.NaN, '80', {}]) {
        for (const [contextName, context] of [['capable', CAPABLE], ...INCAPABLE.slice(0, 6)]) {
          const where = `${valueName} / ${contextName} @ ${String(width)}`
          expect(() => resolve({ configured: value, override: value, ...context, width }), where).not.toThrow()
          calls += 1
        }
      }
    }
    expect(calls).toBe(VALUES.length * 9 * 7)
  })

  it('answers with exactly four keys, and the same four for every input', () => {
    // A caller destructures this object. A missing key would read as `undefined` — which
    // `playBannerSplash` treats as five cycles and `if (banner.box)` treats as "print nothing"
    // — so a shape that varied by input would degrade silently rather than fail.
    const shape = ['mode', 'sprite', 'box', 'warning']
    for (const [valueName, value] of VALUES) {
      expect(Object.keys(resolve({ configured: value, ...CAPABLE })).sort(), valueName).toEqual(
        [...shape].sort(),
      )
    }
    expect(Object.keys(resolve())).toEqual(shape)
  })

  it('works with no argument, an empty bag, a frozen bag and a null-prototype bag', () => {
    // Four shapes a caller can hand a defaulted destructure. The `undefined` case is what a
    // future `ralph doctor` or `ralph status` will do before it has a config to read (#75/#76),
    // and it must be the piped default rather than a throw: the facts, no sprite.
    const expected = { mode: 'off', sprite: false, box: true, warning: null }
    expect(resolve()).toEqual(expected)
    expect(resolve(undefined)).toEqual(expected)
    expect(resolve({})).toEqual(expected)
    expect(resolve(Object.freeze({}))).toEqual(expected)
    expect(resolve(Object.assign(Object.create(null), { configured: 'off' }))).toMatchObject({
      box: false,
    })
  })

  it('is a function of its arguments alone, and mutates neither them nor the registry', () => {
    // Purity as a demonstration rather than a static read: the same bag twice, a fresh object
    // each time, and the exported registry unchanged after every hostile value in this file has
    // been through it. `BANNER_MODES` is a mutable array that the template, the warning and
    // three test files all read — a resolver that sorted or pushed to it would rewrite the
    // vocabulary of the whole feature.
    const bag = { configured: 'static', override: undefined, isTTY: true, color: true, width: 60 }
    const first = resolve(bag)
    const second = resolve(bag)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(bag).toEqual({ configured: 'static', override: undefined, isTTY: true, color: true, width: 60 })
    first.mode = 'CLOBBERED'
    expect(resolve(bag).mode).toBe('static')
    expect(BANNER_MODES).toEqual(['full', 'static', 'off'])
    expect(DEFAULT_BANNER_MODE).toBe('full')
  })

  it('resolves with Date, Math.random and process trip-wired', () => {
    // The other half of banner-mode.test.js's static read: this module MAY not mention
    // `process`, but it imports one that transitively can, and a static read of one file cannot
    // see that. The whole policy has to be reachable with the ambient world booby-trapped.
    const realDate = globalThis.Date
    const realRandom = Math.random
    const realProcess = globalThis.process
    const tripwire = (name) => () => {
      throw new Error(`banner-mode touched ${name}`)
    }
    let result
    try {
      globalThis.Date = tripwire('Date')
      Math.random = tripwire('Math.random')
      globalThis.process = new Proxy(
        {},
        {
          get(_target, property) {
            throw new Error(`banner-mode read process.${String(property)}`)
          },
        },
      )
      result = resolve({ configured: 'static', isTTY: true, color: true, width: 60 })
    } finally {
      globalThis.Date = realDate
      Math.random = realRandom
      globalThis.process = realProcess
    }
    expect(result).toEqual({
      mode: 'static',
      sprite: true,
      box: true,
      warning: null,
    })
  })

  it('imports one module, and it is the ladder', () => {
    // banner-mode.test.js greps for the absence of fs, env and clock. This asserts the
    // positive: the import list is exactly the one rule this module is allowed to depend on.
    // A second entry here is either a duplicated threshold or an impurity.
    const code = codeWithoutComments(new URL('./banner-mode.js', import.meta.url))
    expect([...code.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1])).toEqual([
      './banner-compose.js',
    ])
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/\brequire\s*\(/)
    // ...and neither rung is written down twice: the numbers live in banner-compose.js.
    expect(code).not.toMatch(/\b26\b/)
    expect(code).not.toMatch(/\b44\b/)
  })

  it('keeps the registry a usable vocabulary: three lowercase words, no duplicates', () => {
    // The list is printed in a warning, read by the template's spec and iterated by three test
    // files. A duplicate would print twice; an upper-case entry would be unreachable, since a
    // stated value is lowercased before the lookup.
    expect(BANNER_MODES).toHaveLength(3)
    expect(new Set(BANNER_MODES).size).toBe(3)
    expect(BANNER_MODES).toContain(DEFAULT_BANNER_MODE)
    for (const mode of BANNER_MODES) {
      expect(mode).toBe(mode.toLowerCase())
      expect(mode).toBe(mode.trim())
      // Every registered word must be REACHABLE: it resolves to itself, in every case and with
      // any padding, from either source, and never warns.
      for (const spelling of [mode, mode.toUpperCase(), `  ${mode}  `, `${mode}\n`]) {
        expect(resolve({ ...CAPABLE, configured: spelling }).warning, spelling).toBe(null)
        expect(resolve({ ...CAPABLE, override: spelling }).warning, spelling).toBe(null)
        expect(resolve({ ...CAPABLE, configured: spelling }).mode, spelling).toBe(mode)
      }
    }
  })
})
