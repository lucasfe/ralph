// #75 QA — adversarial specs for the THREE FACTS the identity box grew for `ralph doctor`
// (`os`, `agent`, `cachedLatest`) and for the paint mechanism they arrived with.
//
// banner-compose.test.js proves the intended matrix: the two diagnostic rows, #27's four
// verdicts, one literal box at 60 columns and one bare form at 30. This file attacks the
// same two builders from outside that matrix, along the four seams that are actually new:
//
//   * THE FACTS THEMSELVES, which are the least trustworthy this box has ever been handed.
//     `agent` is read off RALPH_AGENT — an ambient environment variable — `os` off a
//     platform detector a caller may stub with anything, and `cachedLatest` out of a JSON
//     file a user is free to hand-edit. Every one of them can carry an LF, a CR, a bare ESC
//     or a U+009B single-byte CSI introducer, and any of those in an ungated row would forge
//     a line outside the width guarantee or leak a sequence into a run that promised none.
//     Asserted as claims about the RETURNED ARRAY, because "a line" is the unit the caller
//     writes with `out()`.
//   * THE PAINT PATH, which is #75's real structural change: `paint` stopped being `true`
//     and became an ANSI OPENER that `render` spends through a new `ink` field. That turns
//     "a balanced pair or nothing at all" from a property of one constant into a property of
//     a value threaded through two functions, so it is asserted at every width — including
//     the widths where the clip eats the painted span entirely (no escapes at all), the one
//     where exactly one column of it survives, and the boundary between them.
//   * THE SPAN'S EXTENT. Colour on a value is a diagnostic a reader skims; colour on a frame
//     glyph or in the label gutter is a rendering bug. The offsets are computed from
//     `frame.indent` and a padded label, so they are asserted by reading the painted span
//     back out of the line and pinning what sits on either side of it.
//   * THE WIDTH LADDER (#72) CROSSED WITH THE NEW ROWS, which is where a row added after the
//     ladder shipped would break it: the bare form must carry every diagnostic row, the row
//     COUNT must not depend on the width, and no width may leave a frame glyph unbalanced.
//
// Escapes, glyphs and labels are spelled out rather than imported, so an expectation here
// cannot agree with a typo in the implementation's own constants. Nothing in this file reads
// an ambient environment, a clock or a real file (#41).

import { describe, expect, it } from 'vitest'
import { BANNER_WIDTH, BOX_MIN_WIDTH, composeBanner } from './banner-compose.js'

const ESC = '\u001B'
const YELLOW = `${ESC}[33m`
const GREEN = `${ESC}[32m`
const COLOR_OFF = `${ESC}[39m`
// Every SGR sequence, not just the three above: an assertion that only knows the codes the
// implementation currently emits cannot catch it emitting a fourth one.
const SGR = /\u001B\[[0-9;]*m/g
const PLACEHOLDER = '\uFFFD'
const LABEL_WIDTH = 8

const stripAnsi = (line) => line.replace(SGR, '')
/** Code points, which is the measure the module pads, clips and promises in. */
const visibleWidth = (line) => [...stripAnsi(line)].length

const VERSION = '0.22.0'
const CWD = '/repo'

// The fact bag `ralph doctor` passes, and the shape every table below varies. Four rows in a
// fixed order — os, agent, cached, cwd — which is what makes the index readers underneath it
// safe at widths where the label gutter itself has been clipped away.
const DOCTOR = { version: VERSION, os: 'mac', agent: 'claude', cachedLatest: VERSION, cwd: CWD }
const OS_ROW = 1
const AGENT_ROW = 2
const CACHED_ROW = 3
const CWD_ROW = 4

const compose = (facts = {}, options = {}) =>
  composeBanner({ facts: { version: VERSION, cwd: CWD, ...facts }, ...options })

/** A row by its label, in either line form — or undefined when no such row was drawn. */
const rowFor = (lines, label) =>
  lines.find((line) => {
    const text = stripAnsi(line)
    return (
      text.startsWith(`│ ${label.padEnd(LABEL_WIDTH)}`) ||
      text.startsWith(label.padEnd(LABEL_WIDTH))
    )
  })

/** A row's value — frame, gutter and right-hand padding removed. */
const valueOf = (lines, label) => {
  const row = rowFor(lines, label)
  if (row === undefined) return undefined
  const text = stripAnsi(row)
  const boxed = text.startsWith('│ ')
  const inner = boxed ? text.slice(2, -2) : text
  return inner.slice(LABEL_WIDTH).trimEnd()
}

/**
 * Every label the box actually drew, in order — the row SET, as data.
 *
 * A row is identified by the SHAPE of its first eight columns: a lowercase word and then
 * nothing but padding. That is deliberately narrower than "starts with a letter", because the
 * bare form's title line starts with `ralph ` and would otherwise be counted as a row named
 * `ralph 0.`.
 */
const labelsOf = (lines) =>
  lines
    .map((line) => stripAnsi(line))
    .map((text) => (text.startsWith('│ ') ? text.slice(2) : text).slice(0, LABEL_WIDTH))
    .filter((gutter) => /^[a-z]+ +$/.test(gutter))
    .map((gutter) => gutter.trim())

/**
 * The painted span of a line, read back out — `{ before, code, span, after }`, or undefined
 * when the line carries no colour at all.
 *
 * Deliberately anchored and greedy about what is NOT an escape: the pattern only matches a
 * line whose ESC bytes are exactly one complete opener and one complete reset, so a half
 * sequence, a lone reset or a second pair fails to parse rather than being silently read as
 * the first pair. `before`/`after` are what the paint must never have touched.
 */
const PAINT =
  /^(?<before>[^\u001B]*)\u001B\[(?<code>\d+)m(?<span>[^\u001B]*)\u001B\[39m(?<after>[^\u001B]*)$/u
const paintOf = (line) => {
  if (!line.includes(ESC)) return undefined
  const match = PAINT.exec(line)
  expect(match, `unparseable escapes in ${JSON.stringify(line)}`).not.toBeNull()
  return match.groups
}

/**
 * The escape-integrity invariant, generalised for #75's second colour.
 *
 * Every ESC byte must belong to a complete SGR sequence; the sequences must be exactly one
 * opener followed by the one reset both colours share; and the opener must be one of the two
 * colours this box claims to paint with. That rules out a truncated `[3`, a lone `[39m`, an
 * opener whose closer the clip cut off, and a colour nobody designed.
 */
function expectEscapesSound(line, context) {
  const sequences = line.match(SGR) ?? []
  expect([...line].filter((glyph) => glyph === ESC), context).toHaveLength(sequences.length)
  if (sequences.length === 0) return
  expect(sequences.length, context).toBe(2)
  expect([YELLOW, GREEN], context).toContain(sequences[0])
  expect(sequences[1], context).toBe(COLOR_OFF)
  expect(line.indexOf(sequences[0]), context).toBeLessThan(line.indexOf(COLOR_OFF))
}

// The widths the layout branches on: the target, both rungs of #72's ladder, and the
// degenerate ones where a row has no room for its own label but still may not throw.
const USABLE_WIDTHS = [200, 80, 61, 60, 59, 45, 44, 43, 30, 27, 26, 25, 15, 12, 10, 9, 8, 5, 3, 1]

describe('QA #75 identity rows — the facts are text this box did not write', () => {
  // One entry per way a terminal can be instructed by something that is supposed to be a
  // fact. LF and CR END A LINE — a returned string containing either is two terminal rows,
  // the second composed by nobody and covered by no width guarantee. ESC opens a sequence;
  // U+009B is the same attack with no ESC to grep for; U+0085 is C1's own line break; U+007F
  // is DEL. All of them are one code point in and one code point out, so the width
  // accounting stays exact.
  const CONTROLS = [
    ['LF', '\n'],
    ['CR', '\r'],
    ['ESC', '\u001B'],
    ['C1 CSI (U+009B)', '\u009B'],
    ['NEL (U+0085)', '\u0085'],
    ['DEL (U+007F)', '\u007F'],
    ['NUL', '\u0000'],
    ['TAB', '\t'],
    ['VT', '\u000B'],
    ['FF', '\u000C'],
    ['BEL', '\u0007'],
    ['SO', '\u000E'],
  ]

  for (const [label, control] of CONTROLS) {
    it(`replaces a ${label} in os, agent and cachedLatest rather than obeying it`, () => {
      // Embedded BETWEEN two segments, not leading or trailing: a fact that is nothing but a
      // control character trims to blank and reads as a fact nobody gave us, which is a
      // different case (below). This one is a real value with something unprintable in it,
      // and it has to survive as such — replaced, never stripped, or the box would be
      // reporting a platform and an agent that are not the ones it was handed.
      const poison = `a${control}b`
      const lines = compose(
        // The smuggled version is embedded for the same reason, and for one more: a TRAILING
        // whitespace control is removed by `trim()` before the gate ever sees it, so
        // `2.0.0<TAB>` is the string `2.0.0` and earns an honest verdict (pinned separately
        // below). Embedded is the case where a control byte survives into the value.
        { ...DOCTOR, os: poison, agent: poison, cachedLatest: `2.0${control}0.0` },
        { capabilities: { color: true } },
      )
      // The claim about the RETURN VALUE: five rows and a frame, and not one of them is two
      // terminal lines pretending to be one.
      expect(lines).toHaveLength(6)
      for (const line of lines) {
        expect(line, line).not.toMatch(/[\n\r]/)
        expect(stripAnsi(line), line).not.toContain(ESC)
        expect(stripAnsi(line), line).not.toContain('\u009B')
        expect(visibleWidth(line)).toBe(BANNER_WIDTH)
      }
      expect(valueOf(lines, 'os')).toBe(`a${PLACEHOLDER}b`)
      expect(valueOf(lines, 'agent')).toBe(`a${PLACEHOLDER}b`)
      // ...and a cached version hiding a control byte is still not semver after the
      // replacement, so it earns no verdict and no colour — the box cannot be made to
      // announce a version the registry never published.
      expect(valueOf(lines, 'cached')).toBe('unknown (no update check cached yet)')
      expect(rowFor(lines, 'cached')).not.toContain(ESC)
    })
  }

  it('trims a control character off the ends of a cached version before judging it', () => {
    // The other half of the case above, and the reason the gate trims BEFORE it replaces: a
    // cache file written with a trailing newline holds the version it says it holds. Replacing
    // first would leave `0.22.0\uFFFD`, fail the semver test and cost every such user their
    // verdict — so the whitespace family must trim away and the rest must not.
    for (const [label, control] of [
      ['LF', '\n'],
      ['CR', '\r'],
      ['CRLF', '\r\n'],
      ['TAB', '\t'],
      ['VT', '\u000B'],
      ['FF', '\u000C'],
      ['a space', ' '],
    ]) {
      const lines = compose(
        { ...DOCTOR, cachedLatest: `${control}9.9.9${control}` },
        { capabilities: { color: true } },
      )
      expect(valueOf(lines, 'cached'), label).toBe('9.9.9 available — run `ralph update`')
      expectEscapesSound(rowFor(lines, 'cached'), label)
    }
    // ...and the C1/C0 characters that `trim()` does NOT recognise are still gated, so the
    // same shape with a NEL or a bare ESC on the end claims no verdict at all.
    for (const [label, control] of [
      ['NEL', '\u0085'],
      ['ESC', '\u001B'],
      ['NUL', '\u0000'],
      ['DEL', '\u007F'],
    ]) {
      const lines = compose(
        { ...DOCTOR, cachedLatest: `9.9.9${control}` },
        { capabilities: { color: true } },
      )
      expect(valueOf(lines, 'cached'), label).toBe('unknown (no update check cached yet)')
      expect(rowFor(lines, 'cached'), label).not.toContain(ESC)
    }
  })

  it('cannot be made to forge an extra row, however many control characters a fact holds', () => {
    // The whole point of the array-level guarantee: a caller writes one `out()` per element,
    // so the only way to get an unframed line onto the screen is to make this array longer
    // or to smuggle a break into an element. Neither is available.
    const forged = '\n│ agent   pwned\r\n│ cwd     /tmp/evil\n'
    for (const key of ['os', 'agent', 'cachedLatest', 'cwd', 'version']) {
      const lines = compose({ ...DOCTOR, [key]: `mac${forged}` })
      expect(lines, key).toHaveLength(6)
      expect(lines.join('\n').split('\n'), key).toHaveLength(6)
      expect(valueOf(lines, 'agent'), key).not.toBe('pwned')
      expect(valueOf(lines, 'cwd'), key).not.toBe('/tmp/evil')
    }
  })

  it('counts a replaced control character as exactly one column', () => {
    // One code point in, one out, so `clip` and the right border stay exact without a second
    // pass. A fact of ten controls is a fact of ten placeholders, not one and not twenty.
    const lines = compose({ ...DOCTOR, os: '\u0001'.repeat(10) })
    expect(valueOf(lines, 'os')).toBe(PLACEHOLDER.repeat(10))
    for (const line of lines) expect(visibleWidth(line)).toBe(BANNER_WIDTH)
  })

  it('drops the row for every fact that is blank once trimmed, controls included', () => {
    // A fact that is nothing but whitespace or a line break was never given: no row at all,
    // rather than a row saying `unknown` about a question the caller never asked. This is
    // also the mechanism that keeps `ralph start`'s banner byte-identical, so it is worth
    // pinning against the whole family rather than against `undefined` alone.
    for (const blank of ['', ' ', '   ', '\t', '\n', '\r\n', ' \n\t ', '\u2028', '\u2029']) {
      const lines = compose({ os: blank, agent: blank })
      expect(rowFor(lines, 'os'), JSON.stringify(blank)).toBeUndefined()
      expect(rowFor(lines, 'agent'), JSON.stringify(blank)).toBeUndefined()
      expect(labelsOf(lines), JSON.stringify(blank)).toEqual(['cwd'])
    }
  })

  it('reads a blank cachedLatest as “asked, no answer” rather than as never asked', () => {
    // The distinction the third state exists for. A cache file holding `""` or `"  "` is a
    // cache that was consulted and had nothing usable in it — doctor must not fall silent
    // about that, because silence reads as "nobody has checked", which is the sentence the
    // ABSENT state owns.
    for (const blank of ['', '   ', '\n', '\u2028']) {
      expect(valueOf(compose({ cachedLatest: blank }), 'cached'), JSON.stringify(blank)).toBe(
        'unknown (no update check cached yet)',
      )
    }
    expect(rowFor(compose({}), 'cached')).toBeUndefined()
  })

  it('never runs a fact’s toString, valueOf or Symbol.toPrimitive', () => {
    // `os` and `agent` come out of an environment and a detector; `cachedLatest` out of a
    // JSON file that a foreign writer may have left an object in. A `String(value)` anywhere
    // on these paths would hand a hostile bag arbitrary execution inside a banner.
    let ran = 0
    const trap = {
      toString() {
        ran += 1
        return 'PWNED'
      },
      valueOf() {
        ran += 1
        return 'PWNED'
      },
      [Symbol.toPrimitive]() {
        ran += 1
        return 'PWNED'
      },
    }
    for (const key of ['os', 'agent', 'cachedLatest']) {
      const lines = compose({ ...DOCTOR, [key]: trap }, { capabilities: { color: true } })
      expect(ran, key).toBe(0)
      expect(lines.join('\n'), key).not.toContain('PWNED')
    }
    // ...and the same bag as a getter that would fire on the property READ is out of scope
    // for this module (the caller owns its own bag), but the trap above must not fire even
    // when three rows are competing to read it.
    expect(ran).toBe(0)
  })

  const NON_STRINGS = [
    ['null', null],
    ['a number', 42],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['true', true],
    ['false', false],
    ['an object', {}],
    ['an array', []],
    ['an array of versions', ['0.22.0']],
    ['a function', () => '0.22.0'],
    // eslint-disable-next-line no-new-wrappers
    ['a boxed String', new String('0.22.0')],
    ['a Symbol', Symbol('0.22.0')],
    ['a BigInt', 22n],
    ['a Date', new Date(0)],
  ]

  for (const [label, value] of NON_STRINGS) {
    it(`refuses ${label} in os and agent — no row, never a coercion`, () => {
      const lines = compose({ ...DOCTOR, os: value, agent: value })
      expect(rowFor(lines, 'os')).toBeUndefined()
      expect(rowFor(lines, 'agent')).toBeUndefined()
      expect(labelsOf(lines)).toEqual(['cached', 'cwd'])
      expect(lines.join('\n')).not.toContain('[object')
      for (const line of lines) expect(visibleWidth(line)).toBe(BANNER_WIDTH)
    })

    it(`refuses ${label} in cachedLatest — the row says so, and claims no verdict`, () => {
      // A non-string is not a cached answer, and a non-string that LOOKS like one (a boxed
      // String, an array of one version) least of all: the row states that the question went
      // unanswered rather than printing `0.22.0` out of a shape the registry never wrote.
      const lines = compose({ ...DOCTOR, cachedLatest: value }, { capabilities: { color: true } })
      expect(valueOf(lines, 'cached')).toBe('unknown (no update check cached yet)')
      expect(rowFor(lines, 'cached')).not.toContain(ESC)
      expect(lines.join('\n')).not.toMatch(/available|up to date/)
    })
  }

  it('draws the rows in the table’s order, never the fact bag’s', () => {
    // What the box looks like is a decision this module owns; a shape that varied with the
    // caller's key insertion order would make it the caller's.
    const shuffled = { cwd: CWD, cachedLatest: '9.9.9', agent: 'codex', os: 'linux', version: VERSION }
    expect(labelsOf(compose(shuffled))).toEqual(['os', 'agent', 'cached', 'cwd'])
    expect(labelsOf(compose(DOCTOR))).toEqual(['os', 'agent', 'cached', 'cwd'])
  })

  it('reads an inherited fact — a prototype read is still a read', () => {
    // Pins what the implementation does today: `facts?.[from]` resolves up the chain, so a
    // caller handing over an object created from a prototype gets rows for what it inherits.
    // It must not crash and it must not silently drop the row.
    // `composeBanner` directly rather than through the helper: a spread copies own
    // properties only, so going through `compose` would flatten the chain and test nothing.
    const lines = composeBanner({
      facts: Object.assign(Object.create({ os: 'linux', agent: 'codex', cachedLatest: '9.9.9' }), {
        version: VERSION,
        cwd: CWD,
      }),
    })
    expect(labelsOf(lines)).toEqual(['os', 'agent', 'cached', 'cwd'])
    expect(valueOf(lines, 'os')).toBe('linux')
  })

  it('documents the gap: U+2028 in a new fact is not replaced', () => {
    // NOT a defect, and pinned so that it stays a decision. The gate replaces C0 and C1
    // controls, which is what a TERMINAL obeys; U+2028 and U+2029 are line breaks only to a
    // JavaScript or JSON parser, and a terminal renders them as one harmless glyph. So the
    // box keeps them — and this test exists so that the day the box's output starts being
    // parsed rather than printed, the reader of these facts knows the separator survives.
    const LINE_SEP = String.fromCharCode(0x2028)
    const lines = compose({ ...DOCTOR, os: `a${LINE_SEP}b`, agent: `c${LINE_SEP}d` })
    expect(valueOf(lines, 'os')).toBe(`a${LINE_SEP}b`)
    expect(valueOf(lines, 'agent')).toBe(`c${LINE_SEP}d`)
    // The guarantees that DO hold regardless: one array element per row, and the width
    // accounting is exact because the separator is one code point wide either way.
    expect(lines).toHaveLength(6)
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(BANNER_WIDTH)
      expect(line).not.toMatch(/[\n\r]/)
    }
  })

  it('survives a multi-megabyte fact without losing the width guarantee', () => {
    const lines = compose({ ...DOCTOR, os: 'x'.repeat(2_000_000), cachedLatest: '9'.repeat(2_000_000) })
    for (const line of lines) expect(visibleWidth(line)).toBe(BANNER_WIDTH)
    expect(valueOf(lines, 'cached')).toBe('unknown (no update check cached yet)')
  })

  it('does not mutate the fact bag it was handed', () => {
    const facts = { ...DOCTOR }
    const before = JSON.stringify(facts)
    compose(facts, { capabilities: { color: true } })
    expect(JSON.stringify(facts)).toBe(before)
  })

  it('is a function of its arguments alone: two calls, identical bytes', () => {
    const args = { facts: { ...DOCTOR, cachedLatest: '9.9.9' }, width: 60, capabilities: { color: true } }
    expect(composeBanner(args)).toEqual(composeBanner(args))
  })
})

describe('QA #75 identity rows — the paint path, at every width', () => {
  // The three verdict states, and the colour each one owns. `null` is the state with no
  // verdict to colour, which is the one that must emit nothing at all rather than an empty
  // open/close pair.
  const VERDICTS = [
    ['an available update', '9.9.9', YELLOW],
    ['up to date', VERSION, GREEN],
    ['no cached answer', null, undefined],
  ]

  for (const [label, cachedLatest, ink] of VERDICTS) {
    it(`emits a sound pair or nothing at all for ${label}, at every usable width`, () => {
      for (const width of USABLE_WIDTHS) {
        const lines = compose({ ...DOCTOR, cachedLatest }, { width, capabilities: { color: true } })
        for (const line of lines) {
          expectEscapesSound(line, `${label} @ ${width}: ${JSON.stringify(line)}`)
          expect(visibleWidth(line), `${label} @ ${width}`).toBeLessThanOrEqual(width)
        }
        // Only ever the verdict row, and only ever in the colour that verdict owns.
        const painted = lines.filter((line) => line.includes(ESC))
        if (ink === undefined) expect(painted, `${label} @ ${width}`).toEqual([])
        else {
          expect(painted.length, `${label} @ ${width}`).toBeLessThanOrEqual(1)
          for (const line of painted) expect(line, `${label} @ ${width}`).toContain(ink)
        }
      }
    })

    it(`emits not one escape byte for ${label} when colour is off, at every usable width`, () => {
      for (const width of USABLE_WIDTHS) {
        for (const capabilities of [{ color: false }, {}, { color: 'yes' }, { color: 1 }, { color: null }]) {
          const lines = compose({ ...DOCTOR, cachedLatest }, { width, capabilities })
          expect(lines.join(''), `${label} @ ${width} / ${JSON.stringify(capabilities)}`).not.toContain(ESC)
        }
      }
    })
  }

  it('changes not one visible column by being painted, at every usable width', () => {
    for (const cachedLatest of ['9.9.9', VERSION, null, 'banana']) {
      for (const width of USABLE_WIDTHS) {
        const facts = { ...DOCTOR, cachedLatest }
        const plain = compose(facts, { width })
        const painted = compose(facts, { width, capabilities: { color: true } })
        expect(painted.map(stripAnsi), `${cachedLatest} @ ${width}`).toEqual(plain)
      }
    }
  })

  it('paints the value and never the frame or the label gutter', () => {
    // The offsets are computed from `frame.indent` and a padded label, so this is the
    // assertion that catches an off-by-two: the text before the opener must be exactly the
    // frame's two columns plus the eight-column gutter, and everything after the reset must
    // be padding and the right border — never a coloured `│`.
    for (const [cachedLatest, ink] of [
      ['9.9.9', YELLOW],
      [VERSION, GREEN],
    ]) {
      for (const width of [200, 61, 60, 59, 45, BOX_MIN_WIDTH]) {
        const lines = compose({ ...DOCTOR, cachedLatest }, { width, capabilities: { color: true } })
        const paint = paintOf(lines[CACHED_ROW])
        const context = `${cachedLatest} @ ${width}`
        expect(paint.before, context).toBe(`│ ${'cached'.padEnd(LABEL_WIDTH)}`)
        expect(`${ESC}[${paint.code}m`, context).toBe(ink)
        expect(paint.span, context).not.toContain('│')
        expect(paint.after, context).toMatch(/^ *│$/)
        // And the four sides still line up.
        expect(visibleWidth(lines[CACHED_ROW]), context).toBe(Math.min(width, BANNER_WIDTH))
      }
    }
  })

  it('paints the value and nothing else in the bare form too', () => {
    // The bare form moves the content two columns left, which is exactly the arithmetic a
    // second builder would have got wrong: nothing precedes the gutter and nothing follows
    // the value, so the span must begin at column eight and run to the end of the line.
    for (const width of [43, 30, 26, 25, 15, 12]) {
      const lines = compose({ ...DOCTOR, cachedLatest: '9.9.9' }, { width, capabilities: { color: true } })
      const paint = paintOf(lines[CACHED_ROW])
      expect(paint.before, `@ ${width}`).toBe('cached'.padEnd(LABEL_WIDTH))
      expect(paint.after, `@ ${width}`).toBe('')
      expect(`${ESC}[${paint.code}m`, `@ ${width}`).toBe(YELLOW)
    }
  })

  it('emits nothing at all when the clip ate the whole painted span', () => {
    // A width narrow enough that the label gutter itself is truncated leaves no value to
    // colour. An empty `[33m[39m` pair would still be bytes in a log file and still a lone
    // reset for a terminal to misread, so the answer is no escapes whatsoever.
    for (const width of [8, 7, 5, 3, 2, 1]) {
      const lines = compose({ ...DOCTOR, cachedLatest: '9.9.9' }, { width, capabilities: { color: true } })
      expect(lines.join(''), `@ ${width}`).not.toContain(ESC)
      expect(lines, `@ ${width}`).toHaveLength(5)
    }
  })

  it('pins the exact boundary: 8 columns paints nothing, 9 paints one column', () => {
    // The gutter is eight columns wide, so column nine is the first that can belong to a
    // value — and a one-column span is the narrowest thing `render` can be asked to wrap.
    // It must still be a complete, balanced pair around exactly that column.
    const at = (width) =>
      compose({ ...DOCTOR, cachedLatest: VERSION }, { width, capabilities: { color: true } })[
        CACHED_ROW
      ]
    expect(at(8)).not.toContain(ESC)
    expect(at(9)).toBe(`${'cached'.padEnd(LABEL_WIDTH)}${GREEN}…${COLOR_OFF}`)
    expectEscapesSound(at(9), 'one-column span')
    expect(visibleWidth(at(9))).toBe(9)
  })

  it('never paints a row that has no verdict, at any width or colour', () => {
    for (const cachedLatest of [null, '', 'banana', 'v1.0.0', '1.0', 42, {}]) {
      for (const width of USABLE_WIDTHS) {
        const lines = compose({ ...DOCTOR, cachedLatest }, { width, capabilities: { color: true } })
        expect(lines.join(''), `${String(cachedLatest)} @ ${width}`).not.toContain(ESC)
      }
    }
  })

  it('paints the verdict, never the diagnostic rows beside it', () => {
    // `os`, `agent` and `cwd` are facts, not advice, and a box where four rows are coloured
    // is a box a reader cannot skim. Asserted with a painted verdict present, so the test
    // fails on a paint that leaked rather than on one that never happened.
    const lines = compose({ ...DOCTOR, cachedLatest: '9.9.9' }, { capabilities: { color: true } })
    expect(lines.filter((line) => line.includes(ESC))).toHaveLength(1)
    for (const index of [0, OS_ROW, AGENT_ROW, CWD_ROW, 5]) {
      expect(lines[index], String(index)).not.toContain(ESC)
    }
  })

  it('keeps the two colours apart: green is only ever “up to date”', () => {
    // The colour is the ROW's, and the row decides it from a semver comparison — never from
    // the label or from whether the value happens to contain the word "available". A cached
    // version that is a valid semver and is NOT newer is the only green in the box.
    // No default parameter for `version`: half of what this test is checking is what happens
    // when the installed version is `undefined`, and a default would quietly substitute a
    // usable one for exactly that case.
    const inkFor = (cachedLatest, version) => {
      const line = compose({ ...DOCTOR, version, cachedLatest }, { capabilities: { color: true } })[
        CACHED_ROW
      ]
      const paint = paintOf(line)
      return paint === undefined ? undefined : `${ESC}[${paint.code}m`
    }
    expect(inkFor('9.9.9', VERSION)).toBe(YELLOW)
    expect(inkFor('0.23.0-beta.1', VERSION)).toBe(YELLOW)
    expect(inkFor(VERSION, VERSION)).toBe(GREEN)
    expect(inkFor('0.21.0', VERSION)).toBe(GREEN)
    expect(inkFor('0.22.0+build.9', VERSION)).toBe(GREEN)
    // An installed version nobody can compare is two facts and NO verdict, so there is
    // nothing to colour even though the cached number is perfectly good semver — and the row
    // still has to state the number rather than swallow it.
    for (const version of ['unknown', undefined, 42, '', 'v0.22.0', null, {}]) {
      expect(inkFor('9.9.9', version), String(version)).toBeUndefined()
      expect(
        valueOf(compose({ ...DOCTOR, version, cachedLatest: '9.9.9' }), 'cached'),
        String(version),
      ).toBe('9.9.9')
    }
  })
})

describe('QA #75 identity rows — #72’s ladder, crossed with the new rows', () => {
  // Every width a caller can produce that is NOT a width: `stdout.columns` is undefined on a
  // pipe and 0 on some CI runners, and the rest is what a careless bag can hold. All of them
  // must draw the 60-column box with every diagnostic row in it.
  const UNUSABLE_WIDTHS = [
    undefined,
    null,
    0,
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
    () => 60,
  ]

  it('carries every diagnostic row at every usable width, frame or no frame', () => {
    // #72's ladder is about ink, never about facts: narrowing a terminal hands the frame's
    // four columns back to the values, and it may not cost a row. The row COUNT is therefore
    // width-invariant — six lines framed, five bare — which is the assertion a row added
    // after the ladder shipped would break.
    for (const width of USABLE_WIDTHS) {
      const lines = compose({ ...DOCTOR, cachedLatest: '9.9.9' }, { width })
      const boxed = width >= BOX_MIN_WIDTH
      expect(lines, `@ ${width}`).toHaveLength(boxed ? 6 : 5)
      expect(lines.some((line) => /[╭╰│╮╯]/.test(line)), `@ ${width}`).toBe(boxed)
      for (const line of lines) expect(visibleWidth(line), `@ ${width}`).toBeLessThanOrEqual(width)
      // The labels survive intact for as long as the gutter itself fits, which is the
      // narrowest width at which a row is still readable as a row.
      if (width >= 9) expect(labelsOf(lines), `@ ${width}`).toEqual(['os', 'agent', 'cached', 'cwd'])
    }
  })

  it('falls back to the 60-column box, rows and all, for every value that is not a width', () => {
    const expected = compose({ ...DOCTOR, cachedLatest: '9.9.9' }, { width: BANNER_WIDTH })
    for (const width of UNUSABLE_WIDTHS) {
      expect(compose({ ...DOCTOR, cachedLatest: '9.9.9' }, { width }), String(width)).toEqual(expected)
    }
  })

  it('closes every frame glyph it opens, at every width a frame is drawn at', () => {
    // A row whose right border went missing is the first symptom of a value that escaped the
    // gutter arithmetic, and the new rows are the ones with the longest values in the box.
    for (const width of USABLE_WIDTHS.filter((w) => w >= BOX_MIN_WIDTH)) {
      const lines = compose(
        { ...DOCTOR, os: 'x'.repeat(80), agent: 'y'.repeat(80), cachedLatest: '9.9.9', cwd: '/'.repeat(80) },
        { width, capabilities: { color: true } },
      )
      const boxWidth = Math.min(width, BANNER_WIDTH)
      expect(visibleWidth(lines[0])).toBe(boxWidth)
      expect(stripAnsi(lines[0]).startsWith('╭')).toBe(true)
      expect(stripAnsi(lines[0]).endsWith('╮')).toBe(true)
      expect(stripAnsi(lines.at(-1))).toBe(`╰${'─'.repeat(boxWidth - 2)}╯`)
      for (const line of lines.slice(1, -1)) {
        const text = stripAnsi(line)
        expect([...text].filter((glyph) => glyph === '│'), text).toHaveLength(2)
        expect(text.startsWith('│ '), text).toBe(true)
        expect(text.endsWith(' │'), text).toBe(true)
        expect(visibleWidth(line), text).toBe(boxWidth)
      }
    }
  })

  it('never leaves a frame glyph in the bare form, however long a diagnostic value is', () => {
    for (const width of USABLE_WIDTHS.filter((w) => w < BOX_MIN_WIDTH)) {
      const lines = compose(
        { ...DOCTOR, os: 'x'.repeat(80), agent: 'y'.repeat(80), cachedLatest: '9.9.9' },
        { width, capabilities: { color: true } },
      )
      for (const line of lines) {
        expect(stripAnsi(line), `@ ${width}`).not.toMatch(/[╭╰╮╯│]/)
        // No trailing padding either: a bare line has no border to reach, and trailing
        // spaces are noise in the log file this form exists for.
        expect(stripAnsi(line), `@ ${width}`).toBe(stripAnsi(line).trimEnd())
        expect(visibleWidth(line), `@ ${width}`).toBeLessThanOrEqual(width)
      }
    }
  })

  it('holds the 60-column cap on a very wide terminal, rows included', () => {
    for (const width of [200, 500, 10_000]) {
      const lines = compose({ ...DOCTOR, cachedLatest: '9.9.9' }, { width })
      for (const line of lines) expect(visibleWidth(line), `@ ${width}`).toBe(BANNER_WIDTH)
    }
  })

  it('degrades the same way whether or not the verdict is painted', () => {
    // The clip runs before the paint, and this is the property that ordering exists for: a
    // painted box and a plain one differ in escape bytes and in nothing else, at the two
    // widths either side of the ladder's rung.
    for (const width of [45, 44, 43, 42]) {
      const facts = { ...DOCTOR, cachedLatest: '9.9.9' }
      expect(
        compose(facts, { width, capabilities: { color: true } }).map(stripAnsi),
        `@ ${width}`,
      ).toEqual(compose(facts, { width }))
    }
  })
})
