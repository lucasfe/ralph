// #122 — the spec for the identity box's ROWS, with the terminal taken out of it.
//
// lib/banner-compose.js's four specs have always had to say two things at once: which fact
// becomes which sentence, and how that sentence survives a 30-column terminal. Every case in
// them therefore carries a width, a frame and a clip it does not care about — `rowOf(lines,
// 'agent')` is a string sliced out of `│ agent   claude … │`, so a spec about the WORDING is
// read through the box's borders and asserted against a padded line.
//
// This file is the other half, and the whole reason #122 cut the seam where it did:
// `bannerRows(facts)` is facts in, ROWS out — `{ label, value, paint }` records, in the order
// the box draws them — with no width argument to pass, no frame to strip and no escape to
// balance. So the sentence a fact earns is asserted as the sentence itself, and the module
// under test contains not one column count (which is a structural claim, made at the bottom).
//
// TABLE-DRIVEN where the input is a matrix — the agent row's four answers, the cached row's
// four states, the window's abbreviation rule — because those are the places a new case has to
// be cheap to add. The ORDER of the list is asserted once, as a literal, since it is the one
// property no per-row case can see: a builder that stopped being called, or that moved above
// the one it used to sit under, is a box a reader would notice and a per-row assertion would
// not.
//
// PURE, hermetic and string-literal only, the way every other banner spec is (#41): no clock,
// no `.ralph` directory, no `~/.config/ralph`, and no previous run anywhere in the file.

import { describe, expect, it } from 'vitest'
import { codeWithoutComments, functionBody } from '../test/helpers/source-code.js'
import { COLOR_OFF, UNKNOWN, bannerRows, textOr } from './banner-rows.js'
// The gutter, which is the frame half's number: the MODULE under test may not name it (the
// sweep at the bottom of this file forbids the string), but the spec that checks its labels fit
// may — and importing it is what makes "every label fits" one decision instead of a literal.
import { LABEL_WIDTH } from './banner-compose.js'
// #122's drift guard, inherited from banner-compose.test.js's: the provenance tags are
// lib/banner-model.js's vocabulary and this module's wording is keyed on them, but this module
// may not IMPORT them — its purity block below pins its import list at one, for the reason
// written in the module itself. So the two are held together here instead, by a spec that
// enumerates the resolver's tags and demands a distinct sentence for each.
import { MODEL_PROVENANCE } from './banner-model.js'

// The two codes picocolors emits for `yellow` and for `green`. Spelled out rather than
// imported for the reason the module spells them out: picocolors decides colour ONCE AT IMPORT
// from the real `process.env`, so importing it into a hermetic spec would make these bytes a
// fact about the developer's shell.
const YELLOW = '\u001B[33m'
const GREEN = '\u001B[32m'

const VERSION = '0.22.0'

/** Every fact the box knows, so every row it can draw is in the list at once. */
const ALL_FACTS = Object.freeze({
  version: VERSION,
  latestVersion: '9.9.9',
  cwd: '/repo',
  os: 'mac',
  agent: 'claude',
  model: 'claude-opus-5',
  provenance: 'last-run',
  contextWindow: 1_000_000,
  source: 'github',
  repo: 'lucasfe/ralph',
  cachedLatest: '9.9.9',
  whatsNew: ['one', 'two', 'three', 'four'],
})

const labelsOf = (rows) => rows.map((row) => row.label)
const rowFor = (rows, label) => rows.find((row) => row.label === label)
const valueOf = (rows, label) => rowFor(rows, label)?.value

describe('bannerRows — the list, and the order a reader reads it in (#122)', () => {
  it('draws every fact it was given, in the order the box has always drawn them', () => {
    // The one property no per-row case can see. Asserted as a LITERAL rather than as a set,
    // because "which row sits under which" is the whole of what this list decides — the
    // builders below only decide what each one says.
    expect(labelsOf(bannerRows(ALL_FACTS))).toEqual([
      // What must be acted on...
      'update',
      // ...then which machine and which agent...
      'os',
      'agent',
      'context',
      'cached',
      // ...then where...
      'cwd',
      'source',
      'repo',
      // ...and last, what changed: the section that GROWS, so the rows above it stay at a
      // fixed place on the screen from run to run. Its continuation rows carry no label.
      'new',
      '',
      '',
      'more',
    ])
  })

  it('draws a row for nothing it was not given, except the one row the box always has', () => {
    // ABSENT MEANS NO ROW for every optional fact — a caller that passed no `os` is not a
    // caller whose platform is unknown, it is one that never asked. `cwd` is the exception and
    // it is deliberate: the box's whole job is to say which Ralph and WHERE, so the row is
    // always in the list and the frame half's gate turns a missing value into `unknown`.
    expect(labelsOf(bannerRows({}))).toEqual(['cwd'])
    // RAW, and this is the seam's contract rather than an oversight: `bannerRows` pushes the
    // fact it was handed and lib/banner-compose.js's `rowLine` is the funnel every value goes
    // through. A builder that CONCATENATES has to gate on the way in (see the agent row and
    // the bullets below); one that passes a scalar straight through does not.
    expect(rowFor(bannerRows({}), 'cwd')).toEqual({ label: 'cwd', value: undefined })
    expect(valueOf(bannerRows({ cwd: '/repo' }), 'cwd')).toBe('/repo')
  })

  it('is a function of its argument alone, and hands back a fresh list every time', () => {
    const first = bannerRows(ALL_FACTS)
    const second = bannerRows(ALL_FACTS)
    expect(first).toEqual(second)
    // A FRESH array and fresh records: three commands compose boxes out of this list and one
    // of them may keep or splice it.
    expect(first).not.toBe(second)
    first[0].value = 'CLOBBERED'
    expect(bannerRows(ALL_FACTS)[0].value).not.toBe('CLOBBERED')
  })

  it('survives being handed nothing at all, and never throws for a fact it cannot use', () => {
    // Total in the same way the composer is: a banner is never worth losing a run over, and
    // this module is one call above `ralph start`'s first preflight line.
    for (const facts of [undefined, null, {}, 'nope', 42, [], new Map()]) {
      expect(() => bannerRows(facts)).not.toThrow()
    }
  })
})

describe('bannerRows — the update hint (#68)', () => {
  it('names the newer version and the verb that acts on it, in yellow', () => {
    const rows = bannerRows({ version: VERSION, latestVersion: '9.9.9' })
    expect(valueOf(rows, 'update')).toBe('9.9.9 available — run `ralph update`')
    expect(rowFor(rows, 'update').paint).toBe(YELLOW)
  })

  it('says nothing when there is nothing to act on', () => {
    // Both halves of the comparison have to be a version, and an equal or older cached one is
    // not news — the same condition `resolveUpdateDecision` puts the step-2.5 notice behind,
    // asked of the same two functions so the box and the notice cannot disagree.
    for (const [latest, installed] of [
      ['0.22.0', VERSION],
      ['0.21.0', VERSION],
      [null, VERSION],
      ['banana', VERSION],
      ['v9.9.9', VERSION],
      ['9.9.9', UNKNOWN],
      ['9.9.9', undefined],
      [9, VERSION],
    ]) {
      const rows = bannerRows({ version: installed, latestVersion: latest })
      expect(labelsOf(rows), `${latest} over ${installed}`).not.toContain('update')
    }
  })
})

describe('bannerRows — the agent sentence, and its four answers (#69)', () => {
  const cases = [
    // No agent at all is the `factRows` gate again: a caller that never asked has no answer.
    [{}, undefined],
    // A tag the vocabulary does not know claims NOTHING about a model — the conservative
    // direction, and the reason it is decided before anything else about the model. It is also
    // `ralph doctor`'s row, unchanged since #75: that command passes an agent and no
    // provenance, and gets the bare word.
    [{ agent: 'claude' }, 'claude'],
    [{ agent: 'claude', provenance: 'guessed', model: 'claude-opus-5' }, 'claude'],
    // A tag the vocabulary knows, with no model to name.
    [{ agent: 'claude', provenance: 'unknown' }, 'claude — model resolves at first run'],
    [{ agent: 'claude', provenance: 'unknown', model: 'claude-opus-5' }, 'claude — model resolves at first run'],
    // ...and a `last-run` tag with no model, which the resolver never produces and which is
    // cheap to make unreachable anyway: `claude — (last run)` states nothing while looking
    // like it states something.
    [{ agent: 'claude', provenance: 'last-run' }, 'claude — model resolves at first run'],
    // The sentence the whole feature was asked for.
    [{ agent: 'claude', provenance: 'last-run', model: 'claude-opus-5' }, 'claude — claude-opus-5 (last run)'],
    [{ agent: 'codex', provenance: 'configured', model: 'gpt-5-codex' }, 'codex — gpt-5-codex (configured)'],
  ]

  for (const [facts, expected] of cases) {
    it(`says ${JSON.stringify(expected)} for ${JSON.stringify(facts)}`, () => {
      expect(valueOf(bannerRows(facts), 'agent')).toBe(expected)
    })
  }

  it('has a distinct sentence for every provenance the resolver can answer', () => {
    // The drift guard #69 put in banner-compose.test.js, moved to the module that now holds the
    // wording. A fourth tag added to lib/banner-model.js with no sentence here would otherwise
    // fall through to the bare row — evidence of a new kind, silently reported as none.
    const said = new Set()
    for (const provenance of Object.values(MODEL_PROVENANCE)) {
      const value = valueOf(bannerRows({ agent: 'claude', provenance, model: 'claude-opus-5' }), 'agent')
      expect(value, provenance).not.toBe('claude')
      said.add(value)
    }
    expect(said.size).toBe(Object.values(MODEL_PROVENANCE).length)
  })

  it('gates the three facts before it concatenates them', () => {
    // The row is BUILT from three facts, two of which come out of a shell config and an
    // ambient environment, so `${agent} — ${model}` on an ungated value is precisely the
    // coercion the row gate exists to prevent — a hostile object's `toString` would run before
    // the frame half ever saw it.
    const hostile = {
      toString() {
        throw new Error('coerced')
      },
    }
    expect(() => bannerRows({ agent: hostile, provenance: 'last-run', model: hostile })).not.toThrow()
    expect(labelsOf(bannerRows({ agent: hostile }))).not.toContain('agent')
    expect(valueOf(bannerRows({ agent: 'claude', provenance: 'last-run', model: hostile }), 'agent')).toBe(
      'claude — model resolves at first run',
    )
    // ...and a control byte in one is replaced rather than obeyed, one code point for one.
    expect(
      valueOf(bannerRows({ agent: 'claude', provenance: 'last-run', model: 'claude\u001B[31m-opus' }), 'agent'),
    ).toBe('claude — claude�[31m-opus (last run)')
  })
})

describe('bannerRows — the context window, the box’s one numeric fact (#69)', () => {
  const cases = [
    [1_000_000, '1M tokens'],
    [2_000_000, '2M tokens'],
    [200_000, '200k tokens'],
    [1_500, '1500 tokens'],
    [1, '1 tokens'],
    // ABBREVIATED ONLY WHEN EXACT: an odd override prints as itself rather than rounding to a
    // friendlier lie a reader cannot match against the value they set.
    [1_000_001, '1000001 tokens'],
    // Floored first, then abbreviated: a fractional token count is not a thing, and `1.5M
    // tokens` would be a number this box invented. The floor is what the abbreviation rule is
    // then applied to, which is why this one reads `1500k` and not `1500000`.
    [1_500_000.7, '1500k tokens'],
  ]
  for (const [contextWindow, expected] of cases) {
    it(`says ${expected} for ${contextWindow}`, () => {
      expect(valueOf(bannerRows({ contextWindow }), 'context')).toBe(expected)
    })
  }

  it('draws no row for a window it cannot state exactly', () => {
    // A number is not a string, so `textOr` is the wrong gate for it and coercing one to check
    // it would run a hostile `valueOf`. The refusals: not a number at all, a window that
    // FLOORS to zero (0.5 is positive before the floor and `0 % 1e6 === 0`, which is how
    // `context  0M tokens` was once invented by this arithmetic), and a count JS cannot hold.
    for (const contextWindow of [
      undefined,
      null,
      0,
      0.5,
      -1,
      -1_000_000,
      '1000000',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
      1e30,
      { valueOf: () => 1_000_000 },
    ]) {
      expect(labelsOf(bannerRows({ contextWindow })), String(contextWindow)).not.toContain('context')
    }
  })
})

describe('bannerRows — the cached-version verdict (#27/#75)', () => {
  it('draws nothing at all for a caller that never consulted the cache', () => {
    // FOUR states, counting this one: an ABSENT `cachedLatest` is every caller but `ralph
    // doctor`, and it earns no row. That is why it is a separate fact from `latestVersion`
    // rather than a second reading of it.
    expect(labelsOf(bannerRows({ version: VERSION }))).not.toContain('cached')
  })

  it('names the question that went unanswered when the cache held nothing usable', () => {
    for (const cachedLatest of [null, '', ' ', 'banana', 'v1.0.0', 9, '2.0.0\u001B[31m']) {
      expect(valueOf(bannerRows({ version: VERSION, cachedLatest }), 'cached'), String(cachedLatest)).toBe(
        'unknown (no update check cached yet)',
      )
    }
  })

  it('says up to date in green, and names a newer one in yellow', () => {
    const current = bannerRows({ version: VERSION, cachedLatest: VERSION })
    expect(valueOf(current, 'cached')).toBe('0.22.0 — up to date')
    expect(rowFor(current, 'cached').paint).toBe(GREEN)

    const behind = bannerRows({ version: VERSION, cachedLatest: '9.9.9' })
    expect(valueOf(behind, 'cached')).toBe('9.9.9 available — run `ralph update`')
    expect(rowFor(behind, 'cached').paint).toBe(YELLOW)
  })

  it('states the cached number and claims nothing when the installed version is unusable', () => {
    // Two facts and no verdict, deliberately — and unpainted, because there is no verdict to
    // colour. #27 shipped that same trade for the same reason.
    const rows = bannerRows({ version: UNKNOWN, cachedLatest: '9.9.9' })
    expect(valueOf(rows, 'cached')).toBe('9.9.9')
    expect(rowFor(rows, 'cached').paint).toBeUndefined()
  })

  it('says the newer sentence the same way the update row says it', () => {
    // ONE SENTENCE FOR "THERE IS A NEWER ONE": two rows in this box say it, and they say it
    // out of the same builder because the alternative is a box that phrases one fact two ways
    // in one screenful.
    const rows = bannerRows({ version: VERSION, latestVersion: '9.9.9', cachedLatest: '9.9.9' })
    expect(valueOf(rows, 'update')).toBe(valueOf(rows, 'cached'))
  })
})

describe('bannerRows — the plain single-fact rows (#75/#69/#76)', () => {
  it('draws each one only when the caller passed the fact behind it', () => {
    for (const [label, value] of [
      ['os', 'mac'],
      ['source', 'github'],
      ['repo', 'lucasfe/ralph'],
    ]) {
      expect(valueOf(bannerRows({ [label]: value }), label)).toBe(value)
      expect(labelsOf(bannerRows({}))).not.toContain(label)
      // A blank, a non-string and a hostile bag are all "never asked" rather than `unknown`:
      // `os      unknown` in a pasted bug report would send a reader hunting a platform
      // detection bug that does not exist.
      for (const absent of [null, '', '   ', 7, { toString: () => value }]) {
        expect(labelsOf(bannerRows({ [label]: absent })), `${label}=${String(absent)}`).not.toContain(label)
      }
    }
  })

  it('replaces a control byte in one rather than obeying it', () => {
    // `repo` comes out of GH_REPO — a variable an ambient environment or a committed
    // ralph.config.sh may set — and a `.git/config` nobody reads as bytes.
    expect(valueOf(bannerRows({ repo: 'owner/na\nme' }), 'repo')).toBe('owner/na�me')
    expect(valueOf(bannerRows({ source: 'git\u0000hub' }), 'source')).toBe('git�hub')
  })
})

describe('bannerRows — what’s new, from the shipped changelog (#70)', () => {
  it('labels the first bullet, hangs the rest under it, and points at the command', () => {
    const rows = bannerRows({ whatsNew: ['one', 'two'] })
    expect(rows).toEqual([
      { label: 'cwd', value: undefined },
      { label: 'new', value: '• one' },
      { label: '', value: '• two' },
      { label: 'more', value: 'run `ralph changelog` for the rest' },
    ])
  })

  it('shows three bullets and no more, counted on what survived the gate', () => {
    const rows = bannerRows({ whatsNew: ['', null, 'one', 'two', 'three', 'four'] })
    expect(rows.filter((row) => row.value?.startsWith('•')).map((row) => row.value)).toEqual([
      '• one',
      '• two',
      '• three',
    ])
  })

  it('drops the whole section rather than teasing a command with nothing behind it', () => {
    // Not a heading, not a placeholder bullet, not a pointer at `ralph changelog` with an empty
    // release behind it — which is what makes "a pruned install just starts" a property of this
    // module rather than a condition every caller has to remember.
    for (const whatsNew of [undefined, null, [], ['', '  ', null, 7], 'one', new Set(['one'])]) {
      const labels = labelsOf(bannerRows({ whatsNew }))
      expect(labels, JSON.stringify(whatsNew)).not.toContain('new')
      expect(labels, JSON.stringify(whatsNew)).not.toContain('more')
    }
  })

  it('gates each bullet before it prefixes it', () => {
    // A bullet is the least trusted text in this box: committed markdown, which nobody reads as
    // bytes, shipped inside the package and rendered above every preflight line. It is also
    // PREFIXED, so something has to concatenate — which is why the gate is here and not at the
    // frame half's door.
    const hostile = {
      toString() {
        throw new Error('coerced')
      },
    }
    expect(() => bannerRows({ whatsNew: [hostile] })).not.toThrow()
    expect(labelsOf(bannerRows({ whatsNew: [hostile] }))).not.toContain('new')
    expect(valueOf(bannerRows({ whatsNew: ['a\u001B[31mb'] }), 'new')).toBe('• a�[31mb')
  })
})

describe('bannerRows — the fact gate it lends the frame half', () => {
  it('answers the fallback for everything that is not usable text', () => {
    // `textOr` is exported because lib/banner-compose.js's `titleLine` and `rowLine` gate with
    // it: one owner for "what counts as a fact", on both sides of the seam.
    for (const value of [undefined, null, '', '   ', '\n', 42, [], { toString: () => 'x' }]) {
      expect(textOr(value, UNKNOWN), String(value)).toBe(UNKNOWN)
    }
    expect(textOr(' 0.22.0 ', UNKNOWN)).toBe('0.22.0')
  })

  it('replaces every control byte with one visible code point, and no more than one', () => {
    // Trim first, replace second: `'\n'` alone is a fact that was never given, while a newline
    // BETWEEN two path segments is a fact containing something unprintable and must survive as
    // such. REPLACED rather than stripped, because `/a\nb` stripped reads as `/ab` — a
    // directory that does not exist, so the box would be lying about where it is running.
    expect(textOr('/a\nb', UNKNOWN)).toBe('/a�b')
    expect(textOr('/a\rb', UNKNOWN)).toBe('/a�b')
    expect(textOr('/a\u001Bb', UNKNOWN)).toBe('/a�b')
    expect(textOr('/a\u0000b', UNKNOWN)).toBe('/a�b')
    expect(textOr('/a\u009Bb', UNKNOWN)).toBe('/a�b')
    expect(textOr('/a\u007Fb', UNKNOWN)).toBe('/a�b')
    // ...and NOT the bidi controls, deliberately: those reorder text a terminal is otherwise
    // printing normally, and replacing them would mangle a legitimate path containing a ZWJ
    // emoji sequence.
    expect(textOr('/a\u202Eb', UNKNOWN)).toBe('/a\u202Eb')
  })

  it('lends the reset the frame half closes a painted span with', () => {
    // The palette has one owner: a row names its own colour (`paint`), and the one reset both
    // colours share travels with them rather than being spelled a second time in `render`.
    expect(COLOR_OFF).toBe('\u001B[39m')
    for (const paint of [YELLOW, GREEN]) expect(paint).not.toBe(COLOR_OFF)
  })
})

describe('banner-rows — the seam is where it says it is', () => {
  const code = () => codeWithoutComments(new URL('./banner-rows.js', import.meta.url))

  it('reads no clock, no environment and no filesystem', () => {
    // Same method and the same reason as lib/banner-compose.test.js's own purity block: the
    // ABSENCE of a capability cannot be shown by exercising happy paths, and this module is
    // half of what used to be asserted pure as one file.
    const source = code()
    expect(source).not.toMatch(/\bprocess\b/)
    expect(source).not.toMatch(/\bDate\b/)
    expect(source).not.toMatch(/Math\s*\.\s*random/)
    expect(source).not.toMatch(/\brequire\s*\(/)
    expect(source).not.toMatch(/\bimport\s*\(/)
    expect(source).not.toMatch(/\bglobalThis\b/)
    expect(source).not.toMatch(/node:(fs|os|path|child_process|tty)/)
    expect(source).not.toMatch(/readFileSync|writeFileSync|homedir/)
    // ...and picocolors specifically, which is the import a contributor would most reasonably
    // reach for now that the palette lives here. It decides colour ONCE AT IMPORT from the real
    // process.env, so importing it would hand this module an ambient capability behind the
    // injected capability bag's back.
    expect(source).not.toMatch(/picocolors/)
    // Its ONE import is the semver rule the update machinery already owns (#21/#24) — it came
    // across the seam with the two rows that ask it, which is what keeps the box, the box's own
    // hint and `ralph start`'s step-2.5 notice unable to disagree about what "newer" means.
    // Both spellings are checked, because the `^import … from` form cannot see a wrapped or
    // double-quoted one and the whole value of the claim is that it fails on a new edge.
    expect([...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1])).toEqual([
      './update-check.js',
    ])
  })

  it('holds no width arithmetic at all, which is the whole reason it is a file', () => {
    // #122's claim, as a property of the source rather than of a rendered line: the rows half
    // is pure text. A `padEnd`, a `clip` or a column count here would mean a row was measured
    // twice — once against a gutter it invented and once against the frame's — and the frame is
    // the only half that knows how wide the terminal is.
    const source = code()
    for (const needle of [
      'BANNER_WIDTH',
      'BOX_MIN_WIDTH',
      'SPRITE_MIN_WIDTH',
      'LABEL_WIDTH',
      'padEnd',
      'padStart',
      'visibleWidth',
      'clip(',
      'boxWidth',
      'columns',
    ]) {
      expect(source, needle).not.toContain(needle)
    }
    // ...and neither of the box's own rungs is written down here.
    expect(source).not.toMatch(/\b26\b/)
    expect(source).not.toMatch(/\b44\b/)
    expect(source).not.toMatch(/\b60\b/)
  })

  it('keeps the gate inside the builder that concatenates', () => {
    // The rule the frame half's `rowLine` states for scalars, restated on this side of the
    // seam for the three builders that BUILD a sentence: a gate in the builder is a rule the
    // next row inherits, one at the push site is a convention it has to be told about.
    // The slicer is shared (test/helpers/source-code.js) because a private copy of it got the
    // end of a body wrong: it stopped at the next `\nfunction ` only, so a slice beginning at
    // the last non-exported builder ran past every `export function` to end of file and the
    // gate below could be satisfied by `textOr`'s own definition.
    const source = code()
    const bodyOf = (name) => functionBody(source, name)
    expect(bodyOf('factRows')).toMatch(/textOr\(/)
    expect(bodyOf('agentRows')).toMatch(/textOr\(/)
    expect(bodyOf('whatsNewRows')).toMatch(/textOr\(/)
    expect(bodyOf('updateCheckRows')).toMatch(/textOr\(/)
    expect(bodyOf('newerVersion')).toMatch(/textOr\(/)
    // The window is the box's one NUMERIC fact, so `textOr` is the wrong gate for it: a number
    // is not a string and coercing one would run a hostile `valueOf`. It gets a gate of its
    // own, in the builder, on the same rule.
    expect(bodyOf('contextRows')).toMatch(/windowTokens\(/)
    expect(bodyOf('windowTokens')).toMatch(/typeof \w+ !== 'number'/)
    // ...and the assembler hands over raw facts, exactly as `composeBanner` used to: the
    // builders are the only place the funnel can be.
    expect(bodyOf('bannerRows')).not.toMatch(/textOr\(/)
    expect(bodyOf('bannerRows')).not.toMatch(/windowTokens\(/)
  })

  it('leaves room for the value: every label fits the frame half’s gutter', () => {
    // `padEnd` does not grow: a nine-character label would print `platformmac` with no space at
    // all. The number is the FRAME half's and the MODULE still may not name it (the sweep above
    // forbids the string) — but this spec may import it, and does, so a gutter of nine is one
    // edit rather than a literal `7` here that nothing connects to it. The claim is made against
    // the labels the module actually draws, so a future row cannot collide silently.
    for (const { label } of bannerRows(ALL_FACTS)) {
      expect(String(label).length, label).toBeLessThanOrEqual(LABEL_WIDTH - 1)
    }
  })
})
