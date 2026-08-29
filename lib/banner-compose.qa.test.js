// #68 QA — adversarial specs for the COMPOSITION, on the assumption that its three
// arguments will eventually arrive in a shape nobody designed for.
//
// banner-compose.test.js proves the intended matrix: four shapes of cached version, a
// handful of widths, colour on and off. This file attacks the same one function from
// outside that matrix, along the four seams a pure text-layout module actually breaks
// on:
//
//   * THE WIDTH, at every boundary the layout has a branch for (the 60-column target,
//     the 44 and 26 of #72's degradation ladder, and the degenerate 5/2/1/0) and in every
//     shape a caller can hand it. `stdout.columns` is `undefined` on a pipe, `0` on
//     some CI runners and a float on nothing at all — but this module's own guarantee
//     is stated for "a width", so every non-width is pinned too.
//   * ESCAPE INTEGRITY. The module clips and then paints, in that order, precisely so
//     no width can cut an escape sequence in half. That ordering is invisible in the
//     output of a happy path and load-bearing at width 25, so it is asserted as a
//     property at EVERY width: either a balanced `[33m…[39m` pair, or not one escape
//     byte. A half escape or a lone reset is a corrupt terminal, not a short line.
//   * THE FACTS, which are text this module did not write. `cwd` is a filesystem path
//     — POSIX permits a newline, a carriage return and an ESC in one — and `version`
//     comes out of a package.json. A fact that can carry a newline can forge a box
//     row; a fact that can carry an ESC can defeat the no-colour promise. Both are
//     asserted here as claims about the RETURN VALUE, because "a line" is the unit
//     this module's caller writes with `out()`.
//   * PURITY, demonstrated rather than read. banner-compose.test.js greps the source;
//     this file booby-traps the globals and calls the function, and then checks the
//     one claim a static read of THIS module cannot make — that the newer-than verdict
//     is the same verdict `resolveUpdateDecision` reaches (#21/#24), so the box and the
//     step-2.5 notice can never contradict each other in one screenful of output.
//
// Escapes and glyphs are spelled out rather than imported, so an expectation here
// cannot agree with a typo in the implementation's own constants. Nothing in this file
// reads an ambient environment, a clock or a real cache (#41).

import { describe, expect, it } from 'vitest'
import { Volume } from 'memfs'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { BANNER_WIDTH, bannerLayout, composeBanner } from './banner-compose.js'
import { resolveUpdateDecision } from './update-check.js'
import { versionCachePath } from './version-cache.js'

const ESC = '\u001B'
const YELLOW = `${ESC}[33m`
const YELLOW_OFF = `${ESC}[39m`
// Every SGR sequence, not just the two above: an assertion that only knows the codes
// the implementation currently emits cannot catch it emitting a different one.
const SGR = /\u001B\[[0-9;]*m/g

const VERSION = '0.22.0'
const CWD = '/repo'

const stripAnsi = (line) => line.replace(SGR, '')
/** Code points, which is the measure the module pads, clips and promises in. */
const visibleWidth = (line) => [...stripAnsi(line)].length

const compose = (facts = {}, options = {}) =>
  composeBanner({ facts: { version: VERSION, cwd: CWD, ...facts }, ...options })

const rowFor = (lines, label) => lines.find((line) => stripAnsi(line).includes(`│ ${label}`))

// The widths the layout branches on, and what each one is: the target, the two rungs
// of #72's degradation ladder (44, where the frame goes, and 26, where the sprite does),
// and the degenerate widths where a box cannot be drawn at all but still may not throw.
const USABLE_WIDTHS = [200, 80, 61, 60, 59, 45, 44, 43, 30, 27, 26, 25, 12, 8, 5, 4, 3, 2, 1]

// Every width a caller can produce that is NOT a width. `stdout.columns` is undefined
// on a pipe and 0 on some CI runners; the rest is what a hostile or careless bag can
// hold. All of them must render the 60-column box rather than throwing or collapsing.
const UNUSABLE_WIDTHS = [
  undefined,
  null,
  0,
  -0,
  -1,
  -80,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  '60',
  '',
  {},
  [],
  true,
  false,
  () => 60,
]

/**
 * The escape-integrity invariant, asserted on one line.
 *
 * Every ESC byte must begin a complete SGR sequence, the sequences must pair up as
 * one open followed by one close, and the pair must be the yellow the module claims
 * to use. That rules out the three ways a clip can corrupt a painted line: a
 * truncated `[3`, a lone `[39m` reset with nothing opened, and an opener the
 * clip cut the closer off.
 */
function expectEscapesBalanced(line, context) {
  const sequences = line.match(SGR) ?? []
  // Every ESC in the line accounted for by a COMPLETE sequence — the check that fails
  // on a half escape, where `match` finds fewer sequences than there are ESC bytes.
  expect([...line].filter((glyph) => glyph === ESC), context).toHaveLength(sequences.length)
  if (sequences.length === 0) return
  expect(sequences, context).toEqual([YELLOW, YELLOW_OFF])
  expect(line.indexOf(YELLOW), context).toBeLessThan(line.indexOf(YELLOW_OFF))
}

describe('QA composeBanner — the width, at every boundary and in every wrong shape', () => {
  it('holds every line inside the width it was given, at every usable width', async () => {
    // The issue's own composition criterion, taken to the widths #72 will degrade at
    // and to the ones where the box has no room for content at all. A long value, a
    // hint and colour are all present so that the widest possible line is the one
    // being measured.
    for (const width of USABLE_WIDTHS) {
      for (const capabilities of [{ color: false }, { color: true }]) {
        const lines = composeBanner({
          facts: {
            version: VERSION,
            latestVersion: '9.9.9',
            cwd: '/Users/someone/repos/very/deep/indeed/ralph',
          },
          width,
          capabilities,
        })
        const context = `width ${width} color ${capabilities.color}`
        expect(lines.length, context).toBeGreaterThan(0)
        for (const line of lines) {
          expect(visibleWidth(line), `${context}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
            Math.min(width, BANNER_WIDTH),
          )
        }
      }
    }
  })

  it('falls back to the 60-column box for every value that is not a width', () => {
    // Not merely "does not throw": the fallback must be the SAME box, because a
    // one-column or zero-column degradation on a pipe would change what every
    // launchd log and CI transcript contains.
    const expected = compose({ latestVersion: '9.9.9' })
    for (const width of UNUSABLE_WIDTHS) {
      const lines = compose({ latestVersion: '9.9.9' }, { width })
      expect(lines, String(width)).toEqual(expected)
      for (const line of lines) expect(visibleWidth(line), String(width)).toBe(BANNER_WIDTH)
    }
  })

  it('floors a fractional width rather than half-drawing a column', () => {
    // A float reaches here from anything that divided a terminal width; `repeat()`
    // throws on one, so the floor is load-bearing rather than tidiness.
    for (const [fractional, floored] of [
      [60.9, 60],
      [59.999, 59],
      [44.5, 44],
      [26.1, 26],
      [1.9, 1],
    ]) {
      expect(compose({ latestVersion: '9.9.9' }, { width: fractional }), String(fractional)).toEqual(
        compose({ latestVersion: '9.9.9' }, { width: floored }),
      )
    }
  })

  it('draws a box whose four sides line up, at every width it can be drawn at', () => {
    // A box is a box: with normal facts every line is exactly as wide as every other,
    // whatever the width. This is the invariant the eye actually checks, and the one a
    // per-line `<= width` assertion cannot see — three 60-wide lines and one 44-wide
    // line satisfies that and still looks torn.
    //
    // #72 GAVE "a width it can be drawn at" A NUMBER, and this test is scoped to it
    // rather than weakened: below 44 columns there is no box, so a ragged-edge claim
    // there would be a claim about a shape that is not drawn. The rest of the sweep is
    // the test below, which asserts the OTHER shape rather than asserting less about
    // this one.
    for (const width of USABLE_WIDTHS.filter((columns) => bannerLayout(columns).boxed)) {
      const lines = compose({ latestVersion: '9.9.9', cwd: '/a/deep/enough/path' }, { width })
      const widths = new Set(lines.map(visibleWidth))
      expect([...widths], `width ${width}`).toHaveLength(1)
    }
  })

  it('prints bare rows and no frame at all, at every width too narrow for one', () => {
    // The other half of the sweep (#72), and the shape a narrow terminal actually gets:
    // `key   value` lines, nothing around them, nothing under them. Four claims, because
    // between them they are what "unboxed" means — no frame glyph the eye can mistake for
    // a torn border, nothing wider than the terminal, nothing blank, and no trailing
    // padding, since a bare line has no right border to reach and trailing spaces are
    // bytes in a log file.
    //
    // The glyph set is the box's own six. It deliberately does NOT include the update
    // hint's EM DASH (U+2014), which is a different code point from the rule's U+2500 and
    // one this claim would otherwise fail on at every width.
    for (const width of USABLE_WIDTHS.filter((columns) => !bannerLayout(columns).boxed)) {
      const lines = compose({ latestVersion: '9.9.9', cwd: '/a/deep/enough/path' }, { width })
      expect(lines.length, `width ${width}`).toBeGreaterThan(0)
      for (const line of lines) {
        const context = `width ${width}: ${JSON.stringify(line)}`
        expect(stripAnsi(line), context).not.toMatch(/[╭╮╰╯│─]/)
        expect(visibleWidth(line), context).toBeLessThanOrEqual(width)
        expect(line.trim(), context).not.toBe('')
        expect(line, context).toBe(line.trimEnd())
      }
    }
  })

  it('keeps a long version inside the box on a wide terminal', () => {
    // THE OTHER SIDE of the assertion above, and the one case where the two widths in
    // play differ: the box is drawn at 60 but the line is only finally clipped at the
    // TERMINAL's width, so a title too long for the box is held to 200 rather than to
    // the frame it is supposed to close. A version this long is what a prerelease
    // build id looks like ('1.0.0-alpha.20260101.build.1234+sha.abcdef0'), and the
    // right border of the title has to stay above the right border of the rows.
    const version = '1.0.0-alpha.20260101.build.1234+sha.abcdef0123456789'
    const lines = compose({ version }, { width: 200 })
    const widths = new Set(lines.map(visibleWidth))
    expect([...widths], JSON.stringify(lines[0])).toHaveLength(1)
  })

  it('never emits a line wider than the box, whatever a fact contains', () => {
    // The width guarantee is about the RETURN VALUE, so it has to survive facts the
    // layout did not size: a path of 400 characters, a version of 100, and a hint at
    // the same time.
    const lines = composeBanner({
      facts: {
        version: 'v'.repeat(100),
        latestVersion: '9.9.9',
        cwd: `/${'segment/'.repeat(50)}`,
      },
      width: 60,
      capabilities: { color: true },
    })
    for (const line of lines) expect(visibleWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(60)
  })
})

describe('QA composeBanner — escape integrity, at every width', () => {
  it('paints a balanced pair or nothing at all, at every usable width', () => {
    // The clip-then-paint ordering, asserted as the property it exists for. At 60 the
    // hint fits and is wrapped; somewhere below it the value is cut and the paint must
    // still close; below THAT nothing of the value survives and no escape may be
    // emitted at all. All three outcomes are legal — a half escape is not.
    for (const width of USABLE_WIDTHS) {
      const lines = composeBanner({
        facts: { version: VERSION, latestVersion: '9.9.9', cwd: '/repo/deep/path' },
        width,
        capabilities: { color: true },
      })
      for (const line of lines) expectEscapesBalanced(line, `width ${width}: ${JSON.stringify(line)}`)
      // At most one painted line: the hint is the only advice in the box.
      expect(lines.filter((line) => line.includes(ESC)).length, String(width)).toBeLessThanOrEqual(1)
    }
  })

  it('never emits a lone reset when the clip ate the whole hint', () => {
    // The narrow end of the ladder, pinned separately because an empty
    // `[33m[39m` pair is still bytes in a log file and still a reset for a
    // terminal to act on. Below the width where the value's first column survives,
    // the line must be plain text.
    for (const width of [14, 12, 11, 10, 8, 5, 2, 1]) {
      const lines = composeBanner({
        facts: { version: VERSION, latestVersion: '9.9.9', cwd: CWD },
        width,
        capabilities: { color: true },
      })
      const painted = lines.filter((line) => line.includes(ESC))
      for (const line of painted) {
        // Whatever survived must be a real, non-empty painted range.
        expect(line, `width ${width}`).not.toContain(`${YELLOW}${YELLOW_OFF}`)
        expectEscapesBalanced(line, `width ${width}`)
      }
    }
  })

  it('emits not one escape byte for every colour capability that is not exactly true', () => {
    // `capabilities.color === true` is a STRICT check, and this pins the direction it
    // fails in: a caller that resolved the capability to 1, 'yes' or a truthy object
    // gets plain text rather than escapes. Failing closed is the right way round for a
    // banner whose output ends up in log files — the sprite gate coerces, this one
    // does not, and that asymmetry is deliberate.
    for (const capabilities of [
      undefined,
      {},
      { color: false },
      { color: null },
      { color: 0 },
      { color: '' },
      { color: 1 },
      { color: 'yes' },
      { color: 'true' },
      { color: {} },
      { color: [] },
      { colour: true },
      { COLOR: true },
      null,
    ]) {
      for (const width of [60, 44, 26, 5, 1]) {
        const lines = composeBanner({
          facts: { version: VERSION, latestVersion: '9.9.9', cwd: CWD },
          width,
          capabilities,
        })
        expect(lines.join('\n'), `${JSON.stringify(capabilities)} @ ${width}`).not.toContain(ESC)
      }
    }
  })

  it('paints for a colour capability inherited from a prototype', () => {
    // A layered bag (`Object.create(defaults)`) is how a caller composes capabilities,
    // and the property read is a plain one — so the inherited value counts. Pinned so
    // that a future `Object.hasOwn` does not silently stop painting.
    const lines = composeBanner({
      facts: { version: VERSION, latestVersion: '9.9.9', cwd: CWD },
      capabilities: Object.create({ color: true }),
    })
    expect(rowFor(lines, 'update')).toContain(YELLOW)
  })

  it('changes not one visible glyph by being painted, at every usable width', () => {
    // The escapes are invisible, so stripping them must return the plain render
    // exactly — which is also what keeps the width guarantee true in colour.
    for (const width of USABLE_WIDTHS) {
      const facts = { version: VERSION, latestVersion: '9.9.9', cwd: '/some/where/deep' }
      const plain = composeBanner({ facts, width, capabilities: { color: false } })
      const painted = composeBanner({ facts, width, capabilities: { color: true } })
      expect(painted.map(stripAnsi), String(width)).toEqual(plain)
    }
  })
})

describe('QA composeBanner — hostile facts', () => {
  // Everything a fact can be that is not a usable string. The module's contract is
  // that each of these reads as `unknown` (or, for a cached version, as no hint) —
  // never as a coercion, never as a throw.
  const NON_STRINGS = [
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['false', false],
    ['true', true],
    ['a number', 42],
    ['NaN', Number.NaN],
    ['an empty object', {}],
    ['an empty array', []],
    ['an array of strings', ['/a', '/b']],
    ['a blank string', '   '],
    ['a tab-only string', '\t'],
    ['a newline-only string', '\n'],
  ]

  for (const [name, value] of NON_STRINGS) {
    it(`reads ${name} as unknown in every fact, without throwing`, () => {
      const lines = composeBanner({ facts: { version: value, latestVersion: value, cwd: value } })
      expect(lines[0]).toContain('ralph unknown')
      expect(rowFor(lines, 'cwd')).toContain('unknown')
      expect(rowFor(lines, 'update')).toBeUndefined()
      for (const line of lines) expect(visibleWidth(line)).toBe(BANNER_WIDTH)
    })
  }

  it('never runs a fact’s toString or valueOf', () => {
    // `String(value)` on a hostile object is arbitrary code execution on a value that
    // arrived from a JSON cache. The refusal is asserted by TRIPWIRE rather than by
    // the output, because an object whose toString returned a plausible path would
    // make an output-only assertion pass while the trap had already fired.
    const tripped = []
    const trap = (name) => ({
      toString() {
        tripped.push(`${name}.toString`)
        return 'INJECTED'
      },
      valueOf() {
        tripped.push(`${name}.valueOf`)
        return 'INJECTED'
      },
      [Symbol.toPrimitive]() {
        tripped.push(`${name}.toPrimitive`)
        return 'INJECTED'
      },
    })
    const lines = composeBanner({
      facts: { version: trap('version'), latestVersion: trap('latest'), cwd: trap('cwd') },
      capabilities: { color: true },
    })
    expect(tripped).toEqual([])
    expect(lines.join('\n')).not.toContain('INJECTED')
    expect(lines.join('\n')).not.toContain(ESC)
  })

  it('survives a fact object that is frozen, prototypeless or an array', () => {
    // The shapes a caller's facts bag arrives in: frozen by a defensive caller,
    // `Object.create(null)` from a parsed JSON, or the wrong type entirely.
    const frozen = Object.freeze({ version: '1.0.0', latestVersion: '2.0.0', cwd: '/r' })
    expect(composeBanner({ facts: frozen })[0]).toContain('ralph 1.0.0')

    const bare = Object.assign(Object.create(null), { version: '1.0.0', cwd: '/r' })
    expect(composeBanner({ facts: bare })[0]).toContain('ralph 1.0.0')

    for (const facts of [null, [], 'nope', 42, true]) {
      const lines = composeBanner({ facts })
      expect(lines, JSON.stringify(facts)).toHaveLength(3)
      expect(lines[0], JSON.stringify(facts)).toContain('ralph unknown')
    }
  })

  it('trims a fact rather than reading it as a value of its own', () => {
    // The same rule version-cache.js normalizes the cache with, applied to what a
    // hand-edited config or a `$(cmd)` substitution leaves behind.
    expect(compose({ version: '  1.2.3\n' })[0]).toContain('ralph 1.2.3')
    expect(rowFor(compose({ cwd: ' /repo ' }), 'cwd')).toContain('/repo')
    expect(rowFor(compose({ version: '1.0.0', latestVersion: ' 2.0.0 ' }), 'update')).toContain(
      '2.0.0 available',
    )
  })

  it('never lets a fact smuggle a newline or a carriage return into a line', () => {
    // A LINE is the unit the caller writes with `out()`, which appends the newline
    // itself — so a returned string containing one is two terminal lines, and the
    // second is a line this module never composed and no width guarantee covers. A
    // POSIX path may legally contain both bytes: `mkdir $'a\nb'` is a directory, and
    // `ralph start` run from inside it hands that path straight to the box.
    //
    // Carriage return is the same defect with a worse ending: a terminal redraws the
    // row from column zero, so the text after it overwrites the box's own frame.
    for (const cwd of ['/a\n/b', '/a\r/b', '/a\r\n/b', '/tmp/x\n│ update  0.0.0 available']) {
      for (const line of compose({ cwd })) {
        expect(line, JSON.stringify(cwd)).not.toMatch(/[\n\r]/)
      }
    }
    for (const version of ['1.0.0\n╭─ forged', '1.0.0\rX']) {
      for (const line of compose({ version })) {
        expect(line, JSON.stringify(version)).not.toMatch(/[\n\r]/)
      }
    }
  })

  it('never lets a fact smuggle an escape sequence into an unpainted box', () => {
    // The no-colour promise is "not one escape byte", and it is the promise that makes
    // this box safe to print into a launchd log on every run. A fact carrying its own
    // ESC defeats it without the module ever deciding to paint — and the clip can cut
    // that ESC in half, which leaves a terminal reading the next characters as part of
    // a sequence that never ends.
    const cases = [
      ['a colour sequence', `${ESC}[31mred`],
      ['a reset', `${ESC}[0m`],
      ['a cursor move', `${ESC}[2J`],
      ['an OSC title set', `${ESC}]0;pwned\u0007`],
      ['a bare ESC at the clip boundary', `${'x'.repeat(46)}${ESC}[31m`],
    ]
    for (const [name, injected] of cases) {
      const cwd = composeBanner({ facts: { version: VERSION, cwd: injected } })
      expect(cwd.join('\n'), `cwd: ${name}`).not.toContain(ESC)
      const version = composeBanner({ facts: { version: injected, cwd: CWD } })
      expect(version.join('\n'), `version: ${name}`).not.toContain(ESC)
    }
  })

  it('keeps the code-point guarantee over wide glyphs, surrogates and combining marks', () => {
    // Display width is out of scope by design (see visibleWidth's note): an East Asian
    // glyph counts as one column here and occupies two cells in a terminal. What is
    // NOT out of scope is the guarantee actually made — code points — and the two ways
    // a naive clip breaks on these strings: half a surrogate pair, which is a
    // replacement character on screen, and a throw.
    const paths = [
      `/${'中文目录/'.repeat(20)}`,
      `/${'\u{1F600}'.repeat(60)}`,
      `/${'é'.repeat(40)}`,
      `/${'\u{1F1E7}\u{1F1F7}'.repeat(20)}`,
      `/${'\u{10FFFF}'.repeat(30)}`,
    ]
    for (const cwd of paths) {
      for (const width of [60, 44, 26, 12, 2]) {
        const lines = composeBanner({
          facts: { version: VERSION, latestVersion: '9.9.9', cwd },
          width,
          capabilities: { color: true },
        })
        for (const line of lines) {
          expect(visibleWidth(line), `${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width)
          // No lone surrogate anywhere: `[...text]` iterates code points, so a clip can
          // only produce one by measuring in UTF-16 units somewhere.
          for (const glyph of [...line]) {
            const code = glyph.codePointAt(0)
            expect(code < 0xd800 || code > 0xdfff, JSON.stringify(line)).toBe(true)
          }
          expectEscapesBalanced(line, `${JSON.stringify(cwd)} @ ${width}`)
        }
      }
    }
  })
})

describe('QA composeBanner — purity, demonstrated', () => {
  it('composes with Date, Math.random and process trip-wired', () => {
    // The other half of banner-compose.test.js's static read: this module MAY not
    // mention `process`, but it imports one that does — update-check.js defaults
    // `processEnv` to `process.env` — and a static read of one file cannot see that.
    // The two functions it actually calls have to be reachable without any of it.
    const realDate = globalThis.Date
    const realRandom = Math.random
    const realProcess = globalThis.process
    const tripwire = (name) => () => {
      throw new Error(`banner-compose touched ${name}`)
    }
    let lines
    try {
      globalThis.Date = tripwire('Date')
      Math.random = tripwire('Math.random')
      globalThis.process = new Proxy(
        {},
        {
          get(_target, property) {
            throw new Error(`banner-compose read process.${String(property)}`)
          },
        },
      )
      lines = composeBanner({
        facts: { version: '1.0.0', latestVersion: '2.0.0', cwd: '/r' },
        width: 60,
        capabilities: { color: true },
      })
    } finally {
      globalThis.Date = realDate
      Math.random = realRandom
      globalThis.process = realProcess
    }
    expect(lines).toHaveLength(4)
    expect(lines[1]).toContain('2.0.0 available')
  })

  it('is a function of its arguments alone: two calls, identical bytes', () => {
    const facts = { version: VERSION, latestVersion: '9.9.9', cwd: CWD }
    const capabilities = { color: true }
    const first = composeBanner({ facts, width: 60, capabilities })
    const second = composeBanner({ facts, width: 60, capabilities })
    expect(first).toEqual(second)
    // ...and a FRESH array each time: `ralph start` iterates it, but #75/#76 will hand
    // it to `ralph doctor` and `ralph status`, which may keep or splice it.
    expect(first).not.toBe(second)
    first[0] = 'CLOBBERED'
    expect(composeBanner({ facts, width: 60, capabilities })[0]).not.toBe('CLOBBERED')
  })

  it('does not mutate the facts or the capabilities it was handed', () => {
    const facts = { version: VERSION, latestVersion: '9.9.9', cwd: CWD }
    const capabilities = { color: true }
    const factsBefore = structuredClone(facts)
    const capabilitiesBefore = structuredClone(capabilities)
    composeBanner({ facts, width: 26, capabilities })
    expect(facts).toEqual(factsBefore)
    expect(capabilities).toEqual(capabilitiesBefore)
  })

  it('states its purity in a way a multi-line or double-quoted import cannot slip past', () => {
    // banner-compose.test.js pins the import list with `^import .* from '(.*)'$`,
    // which reads exactly the one shape this file happens to use today: single line,
    // single quotes. A wrapped import (`import {\n a,\n} from './x.js'`) or a
    // double-quoted one would be invisible to it — and the whole value of that
    // assertion is that it fails when a future slice reaches for `node:fs` or
    // picocolors. So the same claim is re-made here, from every `from` clause in the
    // file and from every dynamic import, plus the globals a pure module cannot need.
    const code = codeWithoutComments(new URL('./banner-compose.js', import.meta.url))
    const specifiers = [...code.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
    // #122: still exactly one edge, and it is the ROW half now — the semver rule went across
    // the seam with the two rows that ask it. banner-rows.qa.test.js makes the same
    // shape-proof claim about that file, and also that the edge is not a cycle.
    expect(specifiers).toEqual(['./banner-rows.js'])
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/\bglobalThis\b/)
    expect(code).not.toMatch(/\bprocess\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/\bnode:/)
    expect(code).not.toMatch(/\bhomedir\b/)
    expect(code).not.toMatch(/readFileSync|writeFileSync/)
    expect(code).not.toMatch(/\bfetch\s*\(/)
    // ...and picocolors specifically, which is the import a future contributor would
    // most reasonably reach for to paint the hint. It decides colour ONCE AT IMPORT
    // from the real process.env, so importing it would hand this module an ambient
    // capability behind the injected bag's back.
    expect(code).not.toMatch(/picocolors/)
  })
})

describe('QA composeBanner — the hint agrees with the step-2.5 notice (#21/#24/#68)', () => {
  // The one claim about this module that cannot be made from inside it: whatever
  // "newer" means, the box and `ralph start`'s update notice have to mean the same
  // thing by it, because a single run can print both. Both verdicts are computed here
  // for the same pair and required to match — the notice's through
  // `resolveUpdateDecision` itself, on its THROTTLED path (a fresh `last_check_at`, so
  // no registry query happens and `exec` is a tripwire).
  const HOME = '/home/qa'
  const T0 = Date.parse('2026-01-15T00:00:00.000Z')
  const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })

  const decisionFor = async (installed, cached) => {
    const cacheFs = Volume.fromJSON(
      {
        [CACHE_PATH]: JSON.stringify({
          last_check_at: new Date(T0).toISOString(),
          last_prompted_at: null,
          latest_version: cached,
        }),
      },
      '/',
    )
    return resolveUpdateDecision({
      currentVersion: installed,
      now: () => T0,
      exec: () => {
        throw new Error('the box must never cause a registry query')
      },
      processEnv: {},
      fs: cacheFs,
      home: HOME,
    })
  }

  const PAIRS = [
    ['0.22.0', '0.22.1'],
    ['0.22.0', '0.23.0'],
    ['0.22.0', '1.0.0'],
    ['0.22.0', '0.22.0'],
    ['0.22.0', '0.21.9'],
    ['2.0.0', '1.99.99'],
    ['1.0.0-rc.1', '1.0.0'],
    ['1.0.0', '1.0.0-rc.1'],
    ['1.0.0-rc.1', '1.0.0-rc.2'],
    ['1.0.0-rc.2', '1.0.0-rc.1'],
    ['1.0.0-rc.10', '1.0.0-rc.9'],
    ['1.0.0', '1.0.0+build.1'],
    ['1.0.0+build.1', '1.0.0'],
    ['1.0.0+build.1', '1.0.0+build.2'],
    ['0.9.9', '0.10.0'],
    ['unknown', '9.9.9'],
    ['1.0.0', 'latest'],
    ['1.0.0', 'v1.0.1'],
    ['1.0.0', '1.0'],
    ['1.0.0', '1'],
    ['1.0.0', ' 1.0.1 '],
    [' 1.0.0 ', '1.0.1'],
    ['1.0.0', '1.0.1\n'],
    ['1.0.0', ''],
    ['1.0.0', '   '],
    ['1.0.0', '1.0.1-0'],
    ['1.0.0', '01.0.1'],
    ['1.0.0', '1.0.0.1'],
  ]

  for (const [installed, cached] of PAIRS) {
    it(`agrees on installed ${JSON.stringify(installed)} vs cached ${JSON.stringify(cached)}`, async () => {
      const decision = await decisionFor(installed, cached)
      const row = rowFor(compose({ version: installed, latestVersion: cached }), 'update')
      expect(Boolean(row), `notice says isNewer=${decision.isNewer}`).toBe(decision.isNewer)
      if (decision.isNewer) {
        // ...and they name the same version, not merely the same verdict: two lines in
        // one screenful offering different numbers is the same bug wearing a hat.
        expect(row).toContain(decision.latestVersion.trim())
      }
    })
  }
})
