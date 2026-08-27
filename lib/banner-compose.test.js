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
import { BANNER_WIDTH, composeBanner } from './banner-compose.js'

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
