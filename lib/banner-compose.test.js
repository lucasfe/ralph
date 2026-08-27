// #68 — the spec for the banner's COMPOSITION, kept away from the terminal.
//
// The box is the half of the banner that carries facts rather than pixels, so this
// file asserts it the way the facts arrive: as plain values. A version, a cached
// version, a working directory, a column count and a capability bag — never a real
// terminal, never a real clock, never `~/.config/ralph`. That is what makes every
// width and every capability combination testable at all (#41), and it is why the
// module under test resolves nothing itself.
//
// TABLE-DRIVEN, and deliberately so: the interesting inputs here are a MATRIX (four
// shapes of cached version × several widths × colour on/off), and every row of it
// carries the same two invariants — no line may exceed the width it was given, and a
// colour-less render may not contain one escape byte. Both are asserted through the
// shared helpers below rather than restated per case, so a new row cannot forget one.

import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import {
  BANNER_WIDTH,
  BOX_MIN_WIDTH,
  SPRITE_MIN_WIDTH,
  bannerLayout,
  composeBanner,
} from './banner-compose.js'
// #72's drift guard, and the only reason this file reads the pixels: `SPRITE_MIN_WIDTH`
// is the sprite's own cell width, stated in a module that must not import it (see the
// constant's own note), so the two are held together here instead.
import { spriteWidth } from './sprite-data.js'

const ESC = '\u001B'
// The two codes picocolors emits for `yellow` — see the note on YELLOW in
// lib/banner-compose.js for why they are spelled out there rather than imported.
const YELLOW = '\u001B[33m'
const YELLOW_OFF = '\u001B[39m'

const VERSION = '0.22.0'
const CWD = '/repo'

/** Visible width, in code points — the same measure the module pads and clips with. */
const visibleWidth = (line) => [...stripAnsi(line)].length
const stripAnsi = (line) => line.replaceAll(/\u001B\[\d+m/g, '')

/** The invariant every case shares: nothing wider than the width that was asked for. */
function expectWithin(lines, width) {
  for (const line of lines) expect(visibleWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(width)
}

const compose = (facts = {}, options = {}) =>
  composeBanner({ facts: { version: VERSION, cwd: CWD, ...facts }, ...options })

/** The line carrying a label, or undefined — the box's rows are `label value` pairs. */
const rowFor = (lines, label) => lines.find((line) => stripAnsi(line).includes(`│ ${label}`))

describe('composeBanner — the identity box, byte for byte (#68)', () => {
  it('draws the version in the title, the update hint and the cwd, at 60 columns', async () => {
    // The one literal pin in this file: four lines, spelled out, so a layout change
    // has to be a deliberate edit here rather than something a helper absorbs.
    expect(
      composeBanner({
        facts: { version: '0.22.0', latestVersion: '1.0.0', cwd: '/repo' },
        width: 60,
      }),
    ).toEqual([
      `╭─ ralph 0.22.0 ${'─'.repeat(43)}╮`,
      `│ update  1.0.0 available — run \`ralph update\`${' '.repeat(12)} │`,
      `│ cwd     /repo${' '.repeat(43)} │`,
      `╰${'─'.repeat(58)}╯`,
    ])
  })

  it('titles the box with the installed version and nothing else', () => {
    for (const version of ['0.22.0', '1.10.3', '2.0.0-rc.1']) {
      const lines = compose({ version })
      expect(lines[0]).toContain(`ralph ${version}`)
      expectWithin(lines, BANNER_WIDTH)
    }
  })

  it('says `unknown` rather than inventing a version it was not given', () => {
    // `ralph start`'s own default for a package.json it could not read, so the box
    // spells it the same way the "did not complete" line does.
    for (const version of [undefined, null, '', '   ', 42, {}]) {
      expect(compose({ version })[0], JSON.stringify(version)).toContain('ralph unknown')
    }
  })

  it('shows the working directory', () => {
    expect(rowFor(compose({ cwd: '/Users/me/projects/ralph' }), 'cwd')).toContain(
      '/Users/me/projects/ralph',
    )
  })

  it('says `unknown` for a working directory it was not given', () => {
    for (const cwd of [undefined, null, '', 7, {}]) {
      expect(rowFor(compose({ cwd }), 'cwd'), JSON.stringify(cwd)).toContain('unknown')
    }
  })

  it('never returns an empty box — the facts are the point of it', () => {
    expect(composeBanner().length).toBeGreaterThan(0)
    expect(composeBanner({})).toEqual(composeBanner())
  })

  it('adds no blank line of its own, at either end', () => {
    // The caller concatenates this with the sprite above it and the preflight below,
    // so spacing is the caller's to own — and a blank line is bytes in a log file.
    const lines = compose({ latestVersion: '9.9.9' })
    for (const line of lines) expect(line.trim()).not.toBe('')
  })
})

describe('composeBanner — the update hint, from the cached version alone (#68)', () => {
  // The table the issue's three hint criteria are written against. `hint` is the
  // version the box must name, or null for "no hint at all".
  const CASES = [
    ['a newer patch', { version: '0.22.0', latestVersion: '0.22.1' }, '0.22.1'],
    ['a newer minor', { version: '0.22.0', latestVersion: '0.23.0' }, '0.23.0'],
    ['a newer major', { version: '0.22.0', latestVersion: '1.0.0' }, '1.0.0'],
    ['a release over a prerelease', { version: '1.0.0-rc.1', latestVersion: '1.0.0' }, '1.0.0'],
    ['the same version', { version: '0.22.0', latestVersion: '0.22.0' }, null],
    ['an older version', { version: '0.22.0', latestVersion: '0.21.9' }, null],
    ['an older major', { version: '2.0.0', latestVersion: '1.99.99' }, null],
    ['a prerelease of what is installed', { version: '1.0.0', latestVersion: '1.0.0-rc.2' }, null],
    ['no cached version', { version: '0.22.0', latestVersion: null }, null],
    ['an absent cached version', { version: '0.22.0' }, null],
    ['a blank cached version', { version: '0.22.0', latestVersion: '   ' }, null],
    ['a garbage cached version', { version: '0.22.0', latestVersion: 'banana' }, null],
    ['a partial cached version', { version: '0.22.0', latestVersion: '1.0' }, null],
    ['a v-prefixed cached version', { version: '0.22.0', latestVersion: 'v1.0.0' }, null],
    ['a numeric cached version', { version: '0.22.0', latestVersion: 99 }, null],
    ['an object cached version', { version: '0.22.0', latestVersion: {} }, null],
    // An unknowable installed version is not a comparison — the same rule
    // `resolveUpdateDecision` applies before it offers the step-2.5 notice.
    ['an unknown installed version', { version: 'unknown', latestVersion: '9.9.9' }, null],
    ['a whitespace-padded pair', { version: ' 1.0.0 ', latestVersion: ' 1.0.1 ' }, '1.0.1'],
  ]

  for (const [name, facts, hint] of CASES) {
    it(`${hint ? 'points at `ralph update`' : 'stays silent'} for ${name}`, () => {
      const lines = compose(facts)
      const row = rowFor(lines, 'update')
      if (hint) {
        expect(row).toContain(hint)
        expect(row).toContain('ralph update')
      } else {
        expect(row).toBeUndefined()
        expect(lines.join('\n')).not.toContain('ralph update')
      }
      // The rest of the box is unmoved either way: a hint is a line, not a layout.
      expect(rowFor(lines, 'cwd')).toContain(CWD)
      expectWithin(lines, BANNER_WIDTH)
    })
  }

  it('drops only the hint line when there is nothing to offer', () => {
    const withHint = compose({ latestVersion: '9.9.9' })
    const without = compose({ latestVersion: null })
    expect(withHint).toHaveLength(without.length + 1)
    expect(without).toEqual(withHint.filter((line) => !line.includes('ralph update')))
  })
})

describe('composeBanner — width (#68)', () => {
  it('defaults to the 60-column target', () => {
    expect(BANNER_WIDTH).toBe(60)
    for (const line of compose({ latestVersion: '9.9.9' })) expect(visibleWidth(line)).toBe(60)
  })

  it('falls back to the target for a width that is absent or nonsense', () => {
    // A caller forwarding `stdout.columns` hands us `undefined` on a pipe, and a
    // hostile bag can hand us anything at all. None of it may throw, and none of it
    // may silently produce a one-column box.
    for (const width of [undefined, null, 0, -1, -80, NaN, Infinity, -Infinity, '80', {}, [], true]) {
      const lines = composeBanner({ facts: { version: VERSION, cwd: CWD }, width })
      expect(lines, JSON.stringify(width)).toEqual(compose())
      expectWithin(lines, BANNER_WIDTH)
    }
  })

  it('does not stretch past the target on a wide terminal', () => {
    // 60 columns is the box's design width, not a minimum: a 200-column terminal
    // gets the same box rather than a 200-wide rule the eye cannot follow.
    for (const width of [61, 80, 120, 200, 1e6]) {
      for (const line of compose({ latestVersion: '9.9.9' }, { width })) {
        expect(visibleWidth(line), String(width)).toBe(60)
      }
    }
  })

  it('never exceeds a narrower width, down to a single column', () => {
    // The DEGRADATION LADDER is #72's story — unboxing under 44 columns, dropping the
    // sprite under 26. The guarantee here is only the one this issue asks for: no
    // line wider than the width it was handed, and no throw, at any width.
    for (const width of [59, 50, 44, 40, 26, 20, 12, 8, 5, 2, 1]) {
      const lines = compose({ latestVersion: '9.9.9', cwd: '/a/very/long/path/indeed' }, { width })
      expect(lines.length, String(width)).toBeGreaterThan(0)
      expectWithin(lines, width)
    }
  })

  it('truncates a long value rather than tearing the box', () => {
    const cwd = `/Users/someone/repos/${'deep/'.repeat(20)}ralph`
    const lines = compose({ cwd })
    expectWithin(lines, BANNER_WIDTH)
    const row = rowFor(lines, 'cwd')
    expect(row).toContain('/Users/someone/repos/deep/')
    expect(row).toContain('…')
    expect(row).not.toContain(cwd)
  })

  it('floors a fractional width instead of half-drawing a column', () => {
    expect(compose({}, { width: 60.9 })).toEqual(compose({}, { width: 60 }))
  })
})

describe('composeBanner — the degradation ladder, by width alone (#72)', () => {
  // THE LADDER AS A TABLE, because that is what it is: two rungs, three outcomes, and
  // every width below is a boundary or the column either side of one. Spelled out in
  // FULL — `form`, `drawn` and `sprite` — rather than derived, so the expectations below
  // are the issue's acceptance criteria read off a table and not the implementation's own
  // `Math.min` and `>=` restated in a second file.
  //
  //   `form`   what the box does at that width: framed, or bare rows with no border.
  //   `drawn`  the width the rows are laid out at, which is every line's width EXACTLY in
  //            the boxed form — a bare line is as wide as its content, so all that can be
  //            claimed of it is a ceiling.
  //   `sprite` whether the seventeen rows above the box may be drawn at all.
  //
  // Why the box gives way FIRST, at the wider of the two rungs: the sprite sits above
  // the box rather than beside it, so the sprite is the narrow element (26 columns) and
  // the box is the wide one (a 60-column target). The frame is the cheapest thing to
  // drop — four columns of `│ ` and ` │` handed back to the fact — and the sprite is the
  // last, because half a Ralph is not a smaller Ralph.
  const LADDER = [
    [200, 'boxed', 60, true],
    [80, 'boxed', 60, true],
    [60, 'boxed', 60, true],
    [59, 'boxed', 59, true],
    [50, 'boxed', 50, true],
    [44, 'boxed', 44, true],
    [43, 'bare', 43, true],
    [30, 'bare', 30, true],
    [26, 'bare', 26, true],
    [25, 'bare', 25, false],
    [12, 'bare', 12, false],
    [5, 'bare', 5, false],
    [1, 'bare', 1, false],
  ]

  // The frame glyphs, spelled out as code points on purpose. The update hint contains an
  // EM DASH (U+2014) and the box's rule is U+2500: they are a pixel apart on screen and
  // nothing apart in a regex written from a copy-paste, and confusing them would make
  // the "no frame" claim below pass on a line that still had a border.
  const FRAME = /[╭╮╰╯│─]/

  // The label gutter, which the module keeps private and this file can only observe:
  // eight columns, so `content.slice(0, 8)` is the label and the rest is the fact. The
  // literal pins at the top of this file spell the same eight out as spaces.
  const GUTTER = 8

  /** The bare form's label→value pairs: no frame to strip, the line IS the content. */
  const barePairs = (lines) =>
    lines.slice(1).map((line) => {
      const content = stripAnsi(line)
      return [content.slice(0, GUTTER).trim(), content.slice(GUTTER)]
    })

  /** The boxed form's, with `│ `, ` │` and the padding that lines the border up taken off. */
  const boxedPairs = (lines) =>
    lines.slice(1, -1).map((line) => {
      const content = stripAnsi(line).slice(2, -2)
      return [content.slice(0, GUTTER).trim(), content.slice(GUTTER).trimEnd()]
    })

  const FACTS = {
    version: '0.22.0',
    latestVersion: '9.9.9',
    cwd: '/repo/deep',
    whatsNew: ['one', 'two', 'three'],
  }

  it('reports one decision per width, and it is only ever about the width', () => {
    for (const [width, form, drawn, sprite] of LADDER) {
      expect(bannerLayout(width), String(width)).toEqual({
        width,
        boxWidth: drawn,
        boxed: form === 'boxed',
        sprite,
      })
    }
    // ...and the two rungs are where the issue put them, named rather than inlined so a
    // caller (lib/sprite-banner.js) can ask the same question without re-deriving it.
    expect(BOX_MIN_WIDTH).toBe(44)
    expect(SPRITE_MIN_WIDTH).toBe(26)
  })

  it('keeps the box, at the drawn width, at 44 columns and above', () => {
    for (const [width, form, drawn] of LADDER.filter(([, f]) => f === 'boxed')) {
      const lines = compose(FACTS, { width })
      const why = `width ${width} (${form})`
      expect(lines.length, why).toBeGreaterThan(0)
      // A box is a box: every line exactly as wide as every other, and the corners
      // where the eye expects them.
      expect(new Set(lines.map(visibleWidth)), why).toEqual(new Set([drawn]))
      expect(lines[0][0], why).toBe('╭')
      expect(lines.at(-1)[0], why).toBe('╰')
    }
  })

  it('drops the frame below 44 columns and prints the rows bare', () => {
    for (const [width, form] of LADDER.filter(([, f]) => f === 'bare')) {
      const lines = compose(FACTS, { width })
      const why = `width ${width} (${form})`
      expect(lines.length, why).toBeGreaterThan(0)
      for (const line of lines) {
        const context = `${why}: ${JSON.stringify(line)}`
        // No frame anywhere — not a corner, not a side, not a rule. Which also means
        // there is no bottom rule line: a rule with nothing above it to close is an
        // orphan, and the whole point of unboxing is the columns it hands back.
        expect(line, context).not.toMatch(FRAME)
        expect(visibleWidth(line), context).toBeLessThanOrEqual(width)
        // Never blank, and never padded: trailing spaces are noise in a log file, and a
        // line that trims to nothing is a line the caller should not have been given.
        expect(line.trim(), context).not.toBe('')
        expect(line, context).toBe(line.trimEnd())
      }
    }
  })

  it('says the same things unboxed as it does boxed, only unadorned', () => {
    // THE PARITY CLAIM, asserted where it can be exact: a bare form at W has the same
    // room for content as a boxed form at W+4, because the frame is exactly those four
    // columns. So every label, every value and every clip must agree glyph for glyph —
    // and the only differences left are the frame itself and the bottom rule.
    for (const width of [43, 42, 41, 40]) {
      const bare = compose(FACTS, { width })
      const boxed = compose(FACTS, { width: width + 4 })
      const why = `bare ${width} vs boxed ${width + 4}`
      expect(barePairs(bare), why).toEqual(boxedPairs(boxed))
      // The title is the same sentence with the rule taken off it, and #70's pointer
      // survives the unboxing — the section is information, not decoration.
      expect(bare[0], why).toBe(`ralph ${FACTS.version}`)
      expect(boxed[0], why).toContain(`ralph ${FACTS.version}`)
      expect(bare.length, why).toBe(boxed.length - 1)
    }
  })

  it('carries every row the box carries, down to the narrowest sprite width', () => {
    // The same claim where it cannot be exact — a 26-column value is clipped harder than
    // a 48-column one — so it is made as a claim about the ROWS: the same labels in the
    // same order, and each value the 60-column value cut short rather than a different
    // sentence. #70's three bullets and its pointer are in the list, because a section
    // that quietly vanished under 44 columns would satisfy every width assertion above.
    const full = boxedPairs(compose(FACTS, { width: BANNER_WIDTH }))
    expect(full.map(([label]) => label)).toEqual(['update', 'cwd', 'new', '', '', 'more'])
    for (const width of [43, 40, 30, 26]) {
      const pairs = barePairs(compose(FACTS, { width }))
      const why = `width ${width}`
      expect(
        pairs.map(([label]) => label),
        why,
      ).toEqual(full.map(([label]) => label))
      for (const [index, [, value]] of pairs.entries()) {
        // An ellipsis marks a clip and replaces the column it cut, so what is left of a
        // clipped value is a prefix of the full one.
        const shown = value.endsWith('…') ? value.slice(0, -1) : value
        expect(full[index][1], `${why} row ${index}`).toContain(shown)
      }
    }
  })

  it('lets the sprite be drawn at 26 columns and never below', () => {
    // The sprite's rung, decided HERE so that lib/sprite-banner.js holds no width of its
    // own — the ladder is one object and one file, or it is two that drift.
    for (const width of [26, 27, 30, 44, 60, 200, 1e6]) {
      expect(bannerLayout(width).sprite, String(width)).toBe(true)
    }
    for (const width of [25, 20, 12, 5, 2, 1]) {
      expect(bannerLayout(width).sprite, String(width)).toBe(false)
    }
  })

  it('is exactly as wide as the sprite it gates, or the art has been redrawn', () => {
    // THE DRIFT GUARD. `SPRITE_MIN_WIDTH` is the sprite's own cell width, and this module
    // states it rather than importing it — it documents that it knows nothing about
    // pixels, and a `spriteWidth` import here would be the first line of it that did. So
    // the two are held together by this assertion instead: redraw the art wider and the
    // suite says so, rather than the banner tearing on a 26-column terminal.
    expect(spriteWidth).toBe(SPRITE_MIN_WIDTH)
  })

  it('falls back to the full box for an absent or nonsensical column count', () => {
    // The DOCUMENTED DEFAULT, on the exact shapes a caller can produce: `stdout.columns`
    // is `undefined` on a pipe and `0` on some CI runners, and a hostile bag can hold
    // anything. Total, never a throw — a banner is not worth losing a run over — and the
    // fallback is the full 60-column box with the sprite allowed, because a launchd log
    // that started degrading would be a change to every transcript ever written.
    const unusable = [undefined, null, 0, -1, -80, 0.5, Number.NaN, Infinity, -Infinity]
    for (const width of [...unusable, '80', {}, [], true]) {
      expect(bannerLayout(width), JSON.stringify(width) ?? String(width)).toEqual({
        width: BANNER_WIDTH,
        boxWidth: BANNER_WIDTH,
        boxed: true,
        sprite: true,
      })
    }
    expect(() => bannerLayout()).not.toThrow()
    expect(bannerLayout()).toEqual(bannerLayout(BANNER_WIDTH))
  })

  it('holds every line inside the width with a hostile slug, path and bullet', () => {
    // The width criterion against the three facts that actually overflow in the field: a
    // repository slug nobody would choose, a working directory twenty levels deep, and a
    // release-please bullet, all at once, at every rung — plus colour, so the escapes are
    // in play at the widths where the clip lands inside the painted range.
    const facts = {
      version: '1.0.0-alpha.20260101.build.1234+sha.abcdef0123456789',
      latestVersion: '9.9.9',
      cwd: `/Users/someone/repos/${'deep/'.repeat(20)}ralph`,
      whatsNew: [
        `a release note that ${'goes on and on '.repeat(20)}forever`,
        'lucasfe/a-repository-slug-nobody-would-ever-choose-to-type-twice',
      ],
    }
    for (const [width] of LADDER) {
      for (const capabilities of [{ color: false }, { color: true }]) {
        const lines = composeBanner({ facts, width, capabilities })
        const why = `width ${width} color ${capabilities.color}`
        expect(lines.length, why).toBeGreaterThan(0)
        for (const line of lines) {
          expect(visibleWidth(line), `${why}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width)
          expect(line.trim(), why).not.toBe('')
        }
      }
    }
  })

  it('paints the hint bare, with the offsets the missing frame leaves behind', () => {
    // The paint follows the form: with no `│ ` in front of the gutter the value starts
    // two columns earlier, and an offset left at the boxed value would colour the label.
    const lines = compose({ latestVersion: '9.9.9' }, { width: 43, capabilities: { color: true } })
    const row = lines.find((line) => stripAnsi(line).startsWith('update'))
    expect(row).toContain(`${YELLOW}9.9.9 available`)
    expect(row).toContain(YELLOW_OFF)
    expect(stripAnsi(row).slice(0, 8)).toBe('update  ')
    // ...and nothing else in the bare form is painted, exactly as in the box.
    for (const other of lines.filter((line) => line !== row)) expect(other).not.toContain(ESC)
  })
})

describe('composeBanner — capabilities (#68)', () => {
  it('emits not one escape byte when colour is off', () => {
    for (const capabilities of [undefined, {}, { color: false }, { color: null }]) {
      const lines = compose({ latestVersion: '9.9.9' }, { capabilities })
      expect(lines.join('\n'), JSON.stringify(capabilities)).not.toContain(ESC)
    }
  })

  it('paints the update hint, and only the hint, when colour is allowed', () => {
    const lines = compose({ latestVersion: '9.9.9' }, { capabilities: { color: true } })
    const row = rowFor(lines, 'update')
    expect(row).toContain(`${YELLOW}9.9.9 available — run \`ralph update\`${YELLOW_OFF}`)
    for (const other of lines.filter((line) => line !== row)) expect(other).not.toContain(ESC)
  })

  it('emits no escape at all when colour is allowed but there is no hint', () => {
    expect(compose({ latestVersion: null }, { capabilities: { color: true } }).join('\n')).not.toContain(
      ESC,
    )
  })

  it('changes not one visible column by being coloured', () => {
    // The escapes are invisible, so the two renders must agree on every glyph and
    // every space — which is also what keeps the width guarantee true in colour.
    for (const width of [60, 44, 30, 12]) {
      const facts = { latestVersion: '9.9.9', cwd: '/some/where/deep' }
      const plain = compose(facts, { width })
      const painted = compose(facts, { width, capabilities: { color: true } })
      expect(painted.map(stripAnsi), String(width)).toEqual(plain)
      expectWithin(painted, width)
    }
  })
})

describe('composeBanner — the row gate', () => {
  // A facts bag that answers EVERY key with the same value, so not one assertion below
  // names a fact. That is the whole point of this block: `version` and `cwd` are this
  // slice's only facts, #69 adds five more rows and #70 adds bullets, and a test that
  // said `cwd` would go on passing while a new row went through ungated. Whatever key a
  // row reads, on this bag it reads this.
  const everyFactIs = (value) => new Proxy({}, { get: () => value })

  // A code point a terminal obeys instead of printing: C0, DEL and the C1 block. Written
  // as a scan rather than a regex so the check names the ranges it means.
  const hasControl = (line) =>
    [...line].some((glyph) => {
      const code = glyph.codePointAt(0)
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    })

  const LF = String.fromCharCode(10)
  const CR = String.fromCharCode(13)

  it('replaces a control character in whatever row a fact reaches', () => {
    for (const hostile of [`/a${LF}b`, `/a${CR}b`, `/a${ESC}[31mb`, `${'x'.repeat(46)}${ESC}[31m`]) {
      const lines = composeBanner({ facts: everyFactIs(hostile), width: 60 })
      const why = JSON.stringify(hostile)
      for (const line of lines) {
        expect(hasControl(line), why).toBe(false)
        // Still ONE box: every line framed, and every line the same width as the rest —
        // which is the damage a smuggled newline actually does, since the row it forges
        // is a line this module never composed and no guarantee covers.
        expect(line[0], why).toMatch(/[╭│╰]/)
        expect(visibleWidth(line), why).toBe(60)
      }
    }
  })

  it('coerces nothing on the way into a row, whatever key the value came from', () => {
    // `gutter + value` would run a hostile `toString` on a value that arrived from a
    // JSON cache or a shell config. Asserted by TRIPWIRE rather than by the output,
    // because an object whose toString returned a plausible path would make an
    // output-only check pass with the trap already fired.
    const tripped = []
    const trap = {
      toString() {
        tripped.push('toString')
        return 'INJECTED'
      },
      valueOf() {
        tripped.push('valueOf')
        return 'INJECTED'
      },
      [Symbol.toPrimitive]() {
        tripped.push('toPrimitive')
        return 'INJECTED'
      },
    }
    const lines = composeBanner({
      facts: everyFactIs(trap),
      width: 60,
      capabilities: { color: true },
    })
    expect(tripped).toEqual([])
    expect(lines.join('\n')).not.toContain('INJECTED')
    expect(lines.join('\n')).not.toContain(ESC)
    // ...and the box says what it does not have rather than going quiet about it.
    expect(rowFor(lines, 'cwd')).toContain('unknown')
    expect(lines[0]).toContain('ralph unknown')
  })

  it('keeps the gate inside the line builders, not at the call sites', () => {
    // The two cases above cannot see the difference between a gate in `rowLine` and a
    // sanitised value pushed into the rows array — today's only row-fed fact is `cwd`,
    // and either arrangement cleans it. What separates them is whether the NEXT row is
    // covered, so it is asserted where the difference actually lives: in the source.
    // A gate in the builder is a rule #69 inherits; one at the push site is a
    // convention #69 has to be told about.
    const code = codeWithoutComments(new URL('./banner-compose.js', import.meta.url))
    const bodyOf = (name) => {
      const start = code.indexOf(`function ${name}(`)
      expect(start, name).toBeGreaterThan(-1)
      const end = code.indexOf('\nfunction ', start + 1)
      return code.slice(start, end === -1 ? undefined : end)
    }

    expect(bodyOf('rowLine')).toMatch(/textOr\(value/)
    expect(bodyOf('titleLine')).toMatch(/textOr\(version/)
    // ...and the composer hands over raw facts, so the builders are the only place the
    // funnel can be. `newerVersion` gates its own two arguments the same way.
    expect(bodyOf('composeBanner')).not.toMatch(/textOr\(/)
    expect(bodyOf('newerVersion')).toMatch(/textOr\(/)
    // #70's bullets are the first fact to arrive as a LIST, and the row it is turned
    // into is built before `rowLine` ever sees it — a bullet is prefixed, so something
    // has to concatenate. That builder gates each bullet on the way in, which is what
    // keeps `'• ' + bullet` from being the one place in this module that coerces.
    expect(bodyOf('whatsNewRows')).toMatch(/textOr\(/)
  })
})

describe('composeBanner — what’s new, from the shipped changelog (#70)', () => {
  // The bullets arrive as `facts.whatsNew`, a flat list of strings the caller has
  // already read out of the file (lib/changelog-file.js) and reduced to the newest
  // entry's (lib/changelog.js). This module is told nothing about versions, dates or
  // section headings: LINES, not parameters — the rule the header states — so the
  // section is rows in the same list `update` and `cwd` are rows in.
  // Spelled as char codes rather than as escapes, so the literal a linter or an editor
  // might normalize away cannot quietly weaken the gate case below.
  const LF = String.fromCharCode(10)
  const CR = String.fromCharCode(13)

  const BULLETS = [
    '`ralph digest --loop` + a digest window in the tmux session (#62)',
    'a digest section in `ralph status` (#63)',
    'commit the sprite asset and show it statically in `ralph start` (#67)',
    'a fourth bullet nobody sees',
    'a fifth bullet nobody sees either',
  ]

  /** The rows the section is made of, in the order they are drawn. */
  const sectionOf = (lines) => {
    const first = lines.findIndex((line) => stripAnsi(line).includes('│ new'))
    return first === -1 ? [] : lines.slice(first, lines.length - 1)
  }

  it('draws the newest entry’s bullets and the pointer, at 60 columns', () => {
    // The second literal pin in this file, for the same reason as the first: the
    // section's shape is a decision, and a helper that composed it here would absorb
    // a change to it silently. `new` labels the first bullet and the rest hang under
    // it — a reader needs the words, not the label repeated three times.
    expect(
      composeBanner({ facts: { version: '0.22.0', cwd: '/repo', whatsNew: ['one', 'two'] }, width: 60 }),
    ).toEqual([
      `╭─ ralph 0.22.0 ${'─'.repeat(43)}╮`,
      `│ cwd     /repo${' '.repeat(43)} │`,
      `│ new     • one${' '.repeat(43)} │`,
      `│         • two${' '.repeat(43)} │`,
      `│ more    run \`ralph changelog\` for the rest${' '.repeat(14)} │`,
      `╰${'─'.repeat(58)}╯`,
    ])
  })

  it('shows the first three bullets and no more', () => {
    // Three is the PRD's number: enough to say what a release was about, few enough
    // that the box stays a box. The rest are not truncated away, they are simply not
    // shown — which is what the pointer below them is for.
    const lines = compose({ whatsNew: BULLETS })
    const section = sectionOf(lines)
    expect(section).toHaveLength(4)
    for (const bullet of BULLETS.slice(0, 3)) expect(section.join('\n')).toContain(bullet.slice(0, 20))
    expect(lines.join('\n')).not.toContain('nobody sees')
    expectWithin(lines, BANNER_WIDTH)
  })

  it('points at `ralph changelog` for the rest', () => {
    // The section is a teaser, and a teaser with no verb is a dead end. `ralph
    // changelog` is #71's command; the pointer is this issue's, because a reader who
    // wants the fourth bullet needs to be told where it is on the day this ships.
    const row = rowFor(compose({ whatsNew: BULLETS }), 'more')
    expect(row).toContain('ralph changelog')
  })

  it('adds only lines — the rows above it are untouched', () => {
    // The invariant the header's "later slices add LINES, not parameters" is about:
    // three bullets and a pointer are four more rows, and the update hint and the cwd
    // are byte-identical either way.
    const facts = { latestVersion: '9.9.9', whatsNew: BULLETS }
    const withSection = compose(facts)
    const without = compose({ ...facts, whatsNew: [] })
    expect(withSection).toHaveLength(without.length + 4)
    expect(rowFor(withSection, 'update')).toBe(rowFor(without, 'update'))
    expect(rowFor(withSection, 'cwd')).toBe(rowFor(without, 'cwd'))
    expect(withSection[0]).toBe(without[0])
    expect(withSection.at(-1)).toBe(without.at(-1))
  })

  it('truncates a long bullet rather than tearing the box, at every width', () => {
    // A release-please bullet is routinely longer than the box is wide — the value
    // column is 48 columns at the 60-wide default. Same clip, same ellipsis, same
    // guarantee as the cwd row: the frame closes where every other row's does.
    const long = `a very long release note that ${'goes on and on '.repeat(20)}forever`
    for (const width of [60, 50, 44, 30, 20, 12, 5, 1]) {
      const lines = compose({ whatsNew: [long] }, { width })
      expectWithin(lines, width)
      expect(lines.length, String(width)).toBeGreaterThan(0)
    }
    const row = rowFor(compose({ whatsNew: [long] }), 'new')
    expect(row).toContain('a very long release note')
    expect(row).toContain('…')
    expect(row).not.toContain(long)
  })

  it('drops the whole section when there is nothing to show', () => {
    // A pruned install, an unparseable file, a release whose newest entry has no
    // bullets: all of it arrives here as nothing, and NOTHING is what it draws — no
    // heading, no empty bullet, no pointer to a command with nothing behind it. The
    // box is byte-identical to the one this slice never touched.
    const baseline = compose()
    for (const whatsNew of [
      undefined,
      null,
      [],
      '',
      'a string is not a list of bullets',
      42,
      {},
      ['', '   ', '\n'],
      [null, undefined, 7, {}, []],
      new Set(['a set is not an array']),
    ]) {
      const lines = compose({ whatsNew })
      const why = JSON.stringify(whatsNew) ?? String(whatsNew)
      expect(lines, why).toEqual(baseline)
      expect(lines.join('\n'), why).not.toContain('ralph changelog')
      expect(rowFor(lines, 'new'), why).toBeUndefined()
      expect(rowFor(lines, 'more'), why).toBeUndefined()
    }
  })

  it('shows the bullets it can use and skips the ones it cannot', () => {
    // A list is not all-or-nothing: three usable bullets past a blank and a null are
    // still three bullets, and dropping the section over one bad element would lose a
    // release's news to a stray comma in the file.
    const lines = compose({ whatsNew: ['', 'first', null, 'second', 42, '   ', 'third', 'fourth'] })
    const section = sectionOf(lines)
    expect(section).toHaveLength(4)
    expect(section[0]).toContain('• first')
    expect(section[1]).toContain('• second')
    expect(section[2]).toContain('• third')
    expect(lines.join('\n')).not.toContain('fourth')
  })

  it('emits not one escape byte for the section, colour or no colour', () => {
    // The section is FACTS, and only the update hint is advice — so nothing here is
    // painted, in either mode. With colour on, the hint stays the only painted line.
    for (const capabilities of [undefined, { color: false }, { color: true }]) {
      const lines = compose({ whatsNew: BULLETS }, { capabilities })
      const why = JSON.stringify(capabilities)
      for (const line of sectionOf(lines)) expect(line, why).not.toContain(ESC)
    }
    const painted = compose({ latestVersion: '9.9.9', whatsNew: BULLETS }, { capabilities: { color: true } })
    expect(painted.filter((line) => line.includes(ESC))).toEqual([rowFor(painted, 'update')])
    expect(compose({ whatsNew: BULLETS }, { capabilities: { color: true } }).join('\n')).not.toContain(
      ESC,
    )
  })

  it('passes a bullet through the same row gate every other fact goes through', () => {
    // A bullet is text out of a FILE — the least trusted input this module takes, since
    // a changelog is committed markdown that nobody reads as bytes. A `\n` in one would
    // forge an unframed line outside the width guarantee; an ESC would leak a sequence
    // into a run that promised none.
    const hostile = [`a bullet${LF}with a newline`, `a bullet${CR}with a return`, `a bullet${ESC}[31m`]
    const lines = composeBanner({ facts: { version: VERSION, cwd: CWD, whatsNew: hostile }, width: 60 })
    for (const line of lines) {
      expect(line).not.toContain(ESC)
      expect(line).not.toContain(LF)
      expect(line).not.toContain(CR)
      expect(line[0]).toMatch(/[╭│╰]/)
      expect(visibleWidth(line)).toBe(60)
    }
    expect(sectionOf(lines)).toHaveLength(4)
  })

  it('coerces nothing on the way out of the list', () => {
    // The prefix means something concatenates, and `'• ' + value` on a hostile object
    // runs its `toString`. Asserted by tripwire for the same reason the row gate's own
    // case is: an object whose toString returned a plausible sentence would make an
    // output-only check pass with the trap already fired.
    const tripped = []
    const trap = {
      toString() {
        tripped.push('toString')
        return 'INJECTED'
      },
      valueOf() {
        tripped.push('valueOf')
        return 'INJECTED'
      },
      [Symbol.toPrimitive]() {
        tripped.push('toPrimitive')
        return 'INJECTED'
      },
    }
    const lines = composeBanner({
      facts: { version: VERSION, cwd: CWD, whatsNew: [trap, 'a real bullet'] },
      width: 60,
      capabilities: { color: true },
    })
    expect(tripped).toEqual([])
    expect(lines.join('\n')).not.toContain('INJECTED')
    expect(lines.join('\n')).not.toContain(ESC)
    // ...and the usable bullet is still shown: one hostile element is not a reason to
    // go quiet about the release.
    expect(rowFor(lines, 'new')).toContain('• a real bullet')
  })
})

describe('banner-compose — purity', () => {
  it('reads no clock, no environment and no filesystem', () => {
    // Same method and the same reason as lib/sprite-banner.test.js: the ABSENCE of a
    // capability cannot be shown by exercising happy paths. A module that read
    // `process.env.COLUMNS` or the version cache itself would make every test above a
    // test of the machine it ran on.
    const code = codeWithoutComments(new URL('./banner-compose.js', import.meta.url))

    expect(code).not.toMatch(/\bprocess\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/node:(fs|os|path|child_process|tty)/)
    // Its ONE import is the semver rule the update machinery already owns (#21/#24):
    // the newer-than question is answered by the same two functions that decide
    // whether to print the step-2.5 notice, so the box and the notice can never
    // disagree about what "newer" means.
    expect([...code.matchAll(/^import .* from '(.*)'$/gm)].map((m) => m[1]).sort()).toEqual([
      './update-check.js',
    ])
  })
})
