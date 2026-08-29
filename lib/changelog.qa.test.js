// #70 QA — adversarial specs for the changelog PARSER, on the assumption that
// CHANGELOG.md will eventually not be the file release-please writes today.
//
// changelog.test.js proves the intended grammar against a fixture copied out of this
// repo's own file: five entries, four section headings, a wrapped bullet, both bullet
// markers. This file attacks the same two functions from outside that grammar, along
// the seams a line-based markdown reader actually breaks on:
//
//   * WHAT IS AND IS NOT A RELEASE. The banner announces whatever `parseChangelog`
//     calls entry zero, so the cost of one wrong `## ` heading is `ralph start`
//     reporting a maintainer's note, an `[Unreleased]` placeholder or a fenced code
//     sample as this week's news. Every heading shape that is NOT a release is pinned
//     here, because the failure is silent: a wrong entry looks exactly like a right one.
//   * THE BULLET, WHICH IS A LINE. The consumer is a one-row-per-bullet box with a
//     width guarantee, so a returned bullet carrying a newline, a carriage return or a
//     U+2028 is a row nobody composed. That is asserted as a PROPERTY over every input
//     in this file rather than case by case — see `expectWellFormed`.
//   * THE LINK FLATTENER, at the shapes a regex cannot balance. `[a[b]](url)` and
//     `[x](url(y))` are markdown this module deliberately does not parse properly (see
//     INLINE_LINK's note: no balanced-paren scanner for a banner), so what matters is
//     that they degrade cosmetically and never throw, never lose the sentence and never
//     produce a bullet that is not one line.
//   * TOTALITY AND PURITY, which are the two promises the header makes. Totality is
//     swept over ~40 malformed documents; purity is both READ from the source and
//     DEMONSTRATED with the globals trip-wired, because a static grep cannot see a
//     `Date` reached through an import and a happy-path call cannot see the absence of
//     a capability.
//
// Every case is a string literal: no fs, no fixture install, no clock, nothing that
// depends on the machine the suite runs on (#41). Control characters are spelled with
// `String.fromCharCode`/`\u` escapes so that an editor or a formatter normalizing this
// file cannot quietly weaken the assertion that depends on the byte.

import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { latestBullets, parseChangelog } from './changelog.js'

const ESC = String.fromCharCode(27)
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const NUL = String.fromCharCode(0)
const DEL = String.fromCharCode(127)
// U+009B, the single-byte C1 CSI introducer — the same attack as ESC-[ without an ESC.
const C1_CSI = String.fromCharCode(0x9b)
// The two code points a JS `.` refuses to cross, which is why they get their own case
// below: they are line breaks to some renderers and invisible to this parser's regexes.
const LINE_SEP = String.fromCharCode(0x2028)
const PARA_SEP = String.fromCharCode(0x2029)
// U+FEFF, which an editor is free to write in front of the first byte of a UTF-8 file.
const BOM = String.fromCharCode(0xfeff)

/** A one-entry, one-section document wrapped around `bullet`. */
const doc = (bullet) => `## [1.0.0] (2026-01-01)${LF}${LF}### Features${LF}${LF}* ${bullet}${LF}`

const bulletsOf = (text) => latestBullets(parseChangelog(text))
const versionsOf = (text) => parseChangelog(text).map((entry) => entry.version)

/**
 * THE SHAPE CONTRACT, asserted over whatever a malformed document produced.
 *
 * Stated once and applied everywhere because the consumers are two — a 60-column box
 * today and `ralph changelog` tomorrow — and neither of them re-validates. Each clause
 * is a bug someone would otherwise have to find in a terminal:
 *
 *   * a non-string version or bullet becomes `String(value)` somewhere downstream,
 *     which is the coercion lib/banner-rows.js's row gate exists to prevent;
 *   * a bullet containing LF or CR is TWO terminal rows, the second composed by nobody
 *     and covered by no width guarantee, with CR's tail redrawing over the box frame;
 *   * an untrimmed or double-spaced bullet means `cleanBullet`'s collapse was skipped,
 *     which is how a joined continuation line smuggles its indentation into a row;
 *   * an EMPTY bullet or an empty section is a heading with nothing under it — the one
 *     thing this module promises no consumer will have to filter out twice.
 */
function expectWellFormed(entries, why) {
  expect(Array.isArray(entries), why).toBe(true)
  for (const entry of entries) {
    expect(typeof entry.version, why).toBe('string')
    expect(entry.version.length, why).toBeGreaterThan(0)
    expect(entry.date === null || /^\d{4}-\d{2}-\d{2}$/.test(entry.date), why).toBe(true)
    expect(Array.isArray(entry.sections), why).toBe(true)
    for (const section of entry.sections) {
      expect(typeof section.heading, why).toBe('string')
      expect(Array.isArray(section.bullets), why).toBe(true)
      // An empty section never reaches a consumer: the parser drops it, so the banner
      // never has to decide whether to render an empty heading.
      expect(section.bullets.length, why).toBeGreaterThan(0)
      for (const bullet of section.bullets) {
        expect(typeof bullet, why).toBe('string')
        expect(bullet.length, why).toBeGreaterThan(0)
        expect(bullet, why).toBe(bullet.trim())
        expect(bullet, why).not.toContain(LF)
        expect(bullet, why).not.toContain(CR)
        expect(bullet, why).not.toContain(LINE_SEP)
        expect(bullet, why).not.toContain(PARA_SEP)
        expect(bullet, why).not.toContain('  ')
      }
    }
  }
}

describe('QA parseChangelog — what is NOT a release', () => {
  // The banner names entry zero, so every one of these has to fail to be an entry. A
  // wrong entry is the worst kind of bug this module can have: it is silent, it looks
  // exactly like a right one, and it is printed above every preflight line.
  const NOT_RELEASES = {
    'an Unreleased placeholder': `## [Unreleased]${LF}${LF}### Features${LF}${LF}* a${LF}`,
    'a bare Unreleased heading': `## Unreleased${LF}${LF}### Features${LF}${LF}* a${LF}`,
    'a Contributing section': `## Contributing${LF}${LF}* send a PR${LF}`,
    'a Migration notes section': `## Migration notes${LF}${LF}* rename the flag${LF}`,
    'an empty bracketed label': `## [] (2026-01-01)${LF}${LF}### F${LF}${LF}* a${LF}`,
    'a heading with no space after the hashes': `##[1.0.0]${LF}${LF}### F${LF}${LF}* a${LF}`,
    'a level-one heading': `# 1.0.0${LF}${LF}### F${LF}${LF}* a${LF}`,
    'a level-four heading': `#### 1.0.0${LF}${LF}### F${LF}${LF}* a${LF}`,
    'a section heading with no entry above it': `### Features${LF}${LF}* a${LF}`,
    'a bullet with no heading at all': `* a release nobody declared${LF}`,
    'the file title and its prose': `# Changelog${LF}${LF}All notable changes are here.${LF}`,
    'a Keep a Changelog link line': `The format is based on [Keep a Changelog](https://keepachangelog.com/).${LF}`,
    'a heading whose label is a word': `## [Yanked]${LF}${LF}### F${LF}${LF}* a${LF}`,
  }

  for (const [name, text] of Object.entries(NOT_RELEASES)) {
    it(`reports no release for ${name}`, () => {
      expect(parseChangelog(text)).toEqual([])
      // ...and therefore nothing for the banner to announce, which is the claim that
      // actually matters: `ralph start` drops the section rather than printing a
      // heading over somebody's maintenance note.
      expect(bulletsOf(text)).toEqual([])
    })
  }

  it('never attributes a non-release section’s bullets to the release above it', () => {
    // The trap this guards: `## Contributing` closes 0.22.0 and then leaves the parser
    // CLOSED, so `send a PR` belongs to nobody. Attributing it to 0.22.0 would put a
    // maintainer's note in the box as this week's news — and it would be third in the
    // list, i.e. inside the three the banner shows.
    const text =
      `## [1.0.0] (2026-01-01)${LF}${LF}### Features${LF}${LF}* a real feature${LF}${LF}` +
      `## Contributing${LF}${LF}* send a PR${LF}* sign the CLA${LF}`
    expect(versionsOf(text)).toEqual(['1.0.0'])
    expect(bulletsOf(text)).toEqual(['a real feature'])
    expect(JSON.stringify(parseChangelog(text))).not.toContain('send a PR')
  })
})

describe('QA parseChangelog — the release heading, in every shape a file has one', () => {
  it('reads a version with no date and reports the date as null', () => {
    // `## [1.2.3]` with no parenthesised day — the hand-written shape. Null rather
    // than today: this module has no clock and the file has no answer.
    const [entry] = parseChangelog(`## [1.2.3]${LF}${LF}### F${LF}${LF}* a${LF}`)
    expect(entry).toMatchObject({ version: '1.2.3', date: null })
  })

  it('accepts the heading shapes release-please and a human both write', () => {
    // Linked, unlinked, `v`-prefixed, tab-separated, extra-spaced and trailing-spaced.
    // All of them are one heading with a version in it, and the version is the label
    // — never the compare URL, which contains the PREDECESSOR's number.
    const shapes = {
      [`## [0.22.0](https://github.com/o/r/compare/v0.21.0...v0.22.0) (2026-08-27)`]: [
        '0.22.0',
        '2026-08-27',
      ],
      [`## 0.22.0 (2026-08-27)`]: ['0.22.0', '2026-08-27'],
      [`## v0.22.0 (2026-08-27)`]: ['v0.22.0', '2026-08-27'],
      [`##\t[0.22.0] (2026-08-27)`]: ['0.22.0', '2026-08-27'],
      [`##   [0.22.0] (2026-08-27)   `]: ['0.22.0', '2026-08-27'],
      [`## [0.22.0] - Unreleased`]: ['0.22.0', null],
      [`## [2.0]`]: ['2.0', null],
      [`## [1.0.0.1]`]: ['1.0.0.1', null],
      [`## [1.0.0-rc.1] (2026-01-01)`]: ['1.0.0-rc.1', '2026-01-01'],
    }
    for (const [heading, [version, date]] of Object.entries(shapes)) {
      const [entry] = parseChangelog(`${heading}${LF}${LF}### F${LF}${LF}* a${LF}`)
      expect(entry, heading).toMatchObject({ version, date })
      // The compare URL carries `v0.21.0` — the version BEFORE this one. A parser that
      // read the link instead of the label would label every release with its
      // predecessor, and every assertion about "newest" would still pass.
      expect(entry.version, heading).not.toContain('0.21.0')
    }
  })

  it('reports the date the file wrote, never a corrected one', () => {
    // `2026-13-45` is not a day. It is reported verbatim, because this module has no
    // calendar and its job is to say what the file says — a silently corrected or
    // dropped date would make `ralph changelog` (#71) disagree with the file it read.
    expect(parseChangelog(`## [1.0.0] (2026-13-45)${LF}`)[0].date).toBe('2026-13-45')
    // ...and a date that is not at the END of the heading is not the release day:
    // release-please parenthesises it last, and anything after it is prose.
    expect(parseChangelog(`## [1.0.0] (2026-01-01) yanked${LF}`)[0].date).toBeNull()
  })

  it('keeps duplicate versions apart, in document order', () => {
    // A hand-edited or double-released file. The parser does not deduplicate and does
    // not sort — it has no opinion about what "newest" means (see the header) — so both
    // entries survive and the FIRST one is what the banner shows.
    const text =
      `## [1.0.0] (2026-01-01)${LF}${LF}### F${LF}${LF}* the newer one${LF}${LF}` +
      `## [1.0.0] (2025-01-01)${LF}${LF}### F${LF}${LF}* the older one${LF}`
    expect(versionsOf(text)).toEqual(['1.0.0', '1.0.0'])
    expect(bulletsOf(text)).toEqual(['the newer one'])
  })

  it('keeps a release that says nothing, and shows nothing for it', () => {
    // The split of responsibility the header states: a release with no bullets is
    // still a release (#71 lists it), and it is the BANNER that turns "no bullets"
    // into "no section". Both halves pinned together so neither can drift.
    const text = `## [1.0.0] (2026-01-01)${LF}${LF}### Features${LF}`
    expect(parseChangelog(text)).toEqual([{ version: '1.0.0', date: '2026-01-01', sections: [] }])
    expect(bulletsOf(text)).toEqual([])
  })

  it('parses a file that is one line long', () => {
    // A tarball built from a truncated file, or a first release before any section was
    // written. An entry with no sections, not a throw and not a section with no bullets.
    expect(parseChangelog('## [1.0.0] (2026-01-01)')).toEqual([
      { version: '1.0.0', date: '2026-01-01', sections: [] },
    ])
  })
})

describe('QA parseChangelog — bullets nothing can be made of', () => {
  it('drops a bullet whose content is only whitespace, and the section with it', () => {
    // `*   ` is a marker with no sentence after it. Dropped rather than pushed as '',
    // so no consumer has to filter what this module already knows — and if it was the
    // section's only bullet, the section goes too.
    expect(bulletsOf(doc('   '))).toEqual([])
    expect(bulletsOf(doc('\t'))).toEqual([])
    expect(parseChangelog(doc('   '))[0].sections).toEqual([])
    // ...but a usable bullet beside it still counts.
    const mixed = `## [1.0.0]${LF}${LF}### F${LF}${LF}*    ${LF}* a real one${LF}`
    expect(bulletsOf(mixed)).toEqual(['a real one'])
  })

  it('drops a bullet that was nothing but an empty link label', () => {
    // `* [](https://…)` flattens to '' — the whole sentence was the URL, and the URL
    // is what this module drops. Nothing is a better row than a bare `https://…`
    // that the 48-column value field would clip to a fragment.
    expect(bulletsOf(doc('[](https://example.com/x)'))).toEqual([])
    expect(bulletsOf(doc('[](x) [](y)'))).toEqual([])
  })

  it('keeps a bullet that was nothing but a link LABEL', () => {
    // The other side of the same rule: the label is what a human wrote, so a bullet
    // that is only a link is still a bullet — `* [#63](https://…/issues/63)` reads as
    // `#63`, which is thin but true.
    expect(bulletsOf(doc('[a release note](https://example.com/x)'))).toEqual(['a release note'])
    expect(bulletsOf(doc('[#63](https://example.com/issues/63)'))).toEqual(['#63'])
  })

  it('drops a bullet whose sentence a `.` cannot cross', () => {
    // U+2028 and U+2029 are the two code points a JS `.` refuses to match, so a bullet
    // containing one matches neither BULLET nor CONTINUATION and is dropped. That is
    // the SAFE direction and it is worth pinning: both are line breaks to some
    // renderers, so a parser that let them through would hand the box a value that
    // splits into two rows — exactly the defect the LF replacement downstream exists
    // to prevent, arriving by a route that replacement does not cover.
    for (const separator of [LINE_SEP, PARA_SEP]) {
      expect(bulletsOf(doc(`before${separator}after`)), JSON.stringify(separator)).toEqual([])
    }
  })
})

describe('QA parseChangelog — the link flattener, past the shapes a regex can balance', () => {
  it('flattens every well-formed link on a line and leaves no URL behind', () => {
    expect(bulletsOf(doc('[a](https://x) and [b](https://y)'))).toEqual(['a and b'])
    expect(bulletsOf(doc('[a](https://x)[b](https://y)'))).toEqual(['ab'])
    expect(bulletsOf(doc('see [prd][ref] and [also][ref2]'))).toEqual(['see prd and also'])
    expect(bulletsOf(doc('a fix ([#63](https://github.com/o/r/issues/63))'))).toEqual([
      'a fix (#63)',
    ])
    for (const bullet of bulletsOf(doc('[a](https://x) [b][ref] [c](https://z)'))) {
      expect(bullet).not.toContain('https://')
    }
  })

  it('leaves the shapes it cannot balance alone rather than mangling the sentence', () => {
    // INLINE_LINK stops at the first `)` and cannot see a `]` inside a label, both
    // stated as deliberate: a balanced scanner is not something this package carries
    // for a banner. So these degrade COSMETICALLY — a stray `)`, or a label and URL
    // left in place — and the assertion is that the words a reader came for survive
    // and the bullet is still one clean line. The box clips whatever is too long.
    const unbalanced = {
      // An unclosed `[` is not a link at all.
      '[oops (2026': '[oops (2026',
      // A `](` with no opening bracket is punctuation, not a link.
      'see ](url) here': 'see ](url) here',
      // An unclosed `(` after a well-formed label: no match, nothing replaced.
      '[label](https://x': '[label](https://x',
      // Emphasis is left alone on purpose: stripping markdown for display is the
      // renderer's job, and `**` is one word's worth of punctuation.
      '**No change to the published package** — see [#41](https://x)':
        '**No change to the published package** — see #41',
    }
    for (const [written, read] of Object.entries(unbalanced)) {
      expect(bulletsOf(doc(written)), written).toEqual([read])
    }
    // ...and every one of them is still a well-formed, single-line bullet.
    for (const written of Object.keys(unbalanced)) expectWellFormed(parseChangelog(doc(written)), written)

    // The two shapes whose EXACT output is an artifact of INLINE_LINK's character classes
    // rather than a decision anybody made: a `]` inside a label leaves the whole link in
    // place, and a `)` inside a URL ends the match early and leaves a stray `)` behind.
    // Asserted only as far as the promise goes — one clean line, and the words a reader
    // came for survive — because a better flattener would produce a BETTER answer for
    // both, and pinning today's imperfection would fail that improvement as a regression.
    for (const written of ['[a[b]](https://x) tail', '[x](https://y(z)) tail']) {
      const entries = parseChangelog(doc(written))
      expectWellFormed(entries, written)
      const bullets = bulletsOf(doc(written))
      expect(bullets, written).toHaveLength(1)
      expect(bullets[0], written).toContain('tail')
    }
  })

  it('does not blow up on a pathologically bracketed bullet', () => {
    // A nested-bracket scan is quadratic in the worst case, and a changelog is
    // attacker-adjacent in exactly one way: it is committed markdown nobody reads as
    // bytes. Bounded here by the test timeout rather than by a millisecond assertion,
    // which would be a flake on a loaded CI box — a genuine blow-up is seconds, not
    // milliseconds. (Measured: ~0.3s for 20k, ~40ms for the nested pair.)
    expect(() => parseChangelog(doc('['.repeat(20000)))).not.toThrow()
    expect(() => parseChangelog(doc('[a'.repeat(5000) + ']'.repeat(5000) + '(x)'))).not.toThrow()
    // ...and a file of five thousand ordinary bullets is linear work, not quadratic.
    const many = `## [1.0.0]${LF}${LF}### F${LF}${LF}${`* a note ([#1](https://x/1))${LF}`.repeat(5000)}`
    const [entry] = parseChangelog(many)
    expect(entry.sections[0].bullets).toHaveLength(5000)
    expect(entry.sections[0].bullets[4999]).toBe('a note (#1)')
  })
})

describe('QA parseChangelog — markers, indentation and the lines between bullets', () => {
  it('reads the two markers this project’s file uses, and not the third', () => {
    // `*` is release-please's and `-` is the hand-written 0.1.0 entry's. `+` is legal
    // markdown that no writer of THIS file has ever used, and it is deliberately not
    // read: the grammar here is the grammar of the shipped CHANGELOG.md, not of
    // CommonMark. Pinned so that "why is my `+` bullet missing" has an answer, and so
    // that adding `+` is a decision somebody makes on purpose.
    const text = `## [1.0.0]${LF}${LF}### F${LF}${LF}* star${LF}- dash${LF}+ plus${LF}`
    expect(bulletsOf(text)).toEqual(['star', 'dash'])
  })

  it('never reads a horizontal rule as a bullet', () => {
    // `---` between releases is Keep-a-Changelog plumbing, and `^[*-][ \t]+` requires
    // whitespace after the marker precisely so a rule cannot become a row in the box.
    for (const rule of ['---', '***', '___', '- - -', '* * *']) {
      const text = `## [1.0.0]${LF}${LF}### F${LF}${LF}* a real bullet${LF}${LF}${rule}${LF}`
      const bullets = bulletsOf(text)
      // The real bullet always survives, and it is always FIRST — a rule can never
      // displace the release's actual news out of the three the banner shows.
      expect(bullets[0], rule).toBe('a real bullet')
      expectWellFormed(parseChangelog(text), rule)
    }
    // The two rules written without spaces produce nothing at all, which is the
    // outcome to hold onto: the common spelling is clean.
    for (const rule of ['---', '***', '___']) {
      expect(bulletsOf(`## [1.0.0]${LF}${LF}### F${LF}${LF}* a${LF}${LF}${rule}${LF}`), rule).toEqual(
        ['a'],
      )
    }
  })

  it('folds an indented sub-bullet into the bullet above it, without its marker', () => {
    // A nested list is an indented, non-blank line under an open bullet, which is the
    // same shape as a WRAPPED bullet — and a box with one row per bullet has nowhere
    // to put a second level anyway. Joined with a single space, both for spaces and
    // for a tab, so the row stays one line.
    //
    // The child's MARKER does not come with it. Folding is a layout decision; leaking a
    // `*` into the middle of the sentence is a typo in the release notes, and a reader
    // seeing `parent * child` cannot tell it was ever a list. All three markers are
    // stripped here — including `+`, which is not read as a bullet at column zero —
    // because an indented `+ child` means a sub-item whatever this grammar does with it.
    for (const marker of ['*', '-', '+']) {
      for (const indent of ['  ', '\t']) {
        const text = `## [1.0.0]${LF}${LF}### F${LF}${LF}* parent${LF}${indent}${marker} child${LF}`
        expect(bulletsOf(text), `${JSON.stringify(indent)}${marker}`).toEqual(['parent child'])
      }
    }
    // A continuation that only LOOKS like a marker keeps its words: the strip is anchored
    // and needs whitespace after it, so a wrapped line beginning with a hyphenated word
    // or an emphasis run is never docked a character.
    expect(bulletsOf(`## [1.0.0]${LF}${LF}### F${LF}${LF}* parent${LF}  -ish child${LF}`)).toEqual([
      'parent -ish child',
    ])
    expect(bulletsOf(`## [1.0.0]${LF}${LF}### F${LF}${LF}* parent${LF}  **child**${LF}`)).toEqual([
      'parent **child**',
    ])
  })

  it('drops an indented bullet that has no bullet above it', () => {
    // Indentation is only read as a continuation while a bullet is OPEN — which is
    // what keeps the `[prd]: https://…` link definitions at column zero out of a
    // bullet, and what makes a stray indented first item disappear instead of
    // becoming one. Silent, but the safe direction: nothing is invented.
    expect(bulletsOf(`## [1.0.0]${LF}${LF}### F${LF}${LF}  * orphan${LF}`)).toEqual([])
    expect(bulletsOf(`## [1.0.0]${LF}${LF}### F${LF}${LF}\t* orphan${LF}`)).toEqual([])
  })

  it('ends a bullet at a blank line, a link definition and a paragraph', () => {
    // The three things that are NOT a continuation. Prose outside a bullet is dropped
    // — the one shape this data model cannot carry — so what must never happen is a
    // link definition or a paragraph arriving as a fourth bullet in the box.
    const text =
      `## [1.0.0]${LF}${LF}### F${LF}${LF}* first${LF}${LF}` +
      `[prd]: https://github.com/o/r/issues/13${LF}` +
      `A paragraph of entry-level prose.${LF}${LF}* second${LF}`
    expect(bulletsOf(text)).toEqual(['first', 'second'])
    expect(JSON.stringify(parseChangelog(text))).not.toContain('paragraph')
    expect(JSON.stringify(parseChangelog(text))).not.toContain('prd')
  })

  it('collapses a wrapped bullet’s indentation instead of carrying it into a row', () => {
    // The `⚠ BREAKING CHANGES` shape, taken to the tabs and double spaces a hand
    // edit leaves behind. The collapse is what makes the return value safe to put in
    // a row: one line, single-spaced, trimmed.
    const text =
      `## [1.0.0]${LF}${LF}### F${LF}${LF}* **retired.** Team mode is now${LF}` +
      `\t  the only mode  of operation${LF}    — no flag to opt in.${LF}`
    expect(bulletsOf(text)).toEqual([
      '**retired.** Team mode is now the only mode of operation — no flag to opt in.',
    ])
  })

  it('keeps an empty `###` from swallowing the next one’s bullets', () => {
    // `### Notes` with nothing under it, then `### Features` with everything. The
    // empty section is dropped and the full one keeps its own heading — a parser that
    // left the first section open would file 0.22.0's features under `Notes`.
    const text = `## [1.0.0]${LF}${LF}### Notes${LF}${LF}### Features${LF}${LF}* a${LF}`
    expect(parseChangelog(text)[0].sections).toEqual([{ heading: 'Features', bullets: ['a'] }])
  })

  it('files a bullet with no `###` above it under an empty heading', () => {
    // A hand-written entry that skipped the taxonomy. The words are what the consumer
    // wants, so the bullet counts — under `''`, which the flat `latestBullets` view
    // never shows and #71 can render as it likes. Silently dropping a release's only
    // content is the worse of the two answers.
    const text = `## [1.0.0]${LF}${LF}* loose${LF}${LF}### F${LF}${LF}* filed${LF}`
    expect(parseChangelog(text)[0].sections).toEqual([
      { heading: '', bullets: ['loose'] },
      { heading: 'F', bullets: ['filed'] },
    ])
    expect(bulletsOf(text)).toEqual(['loose', 'filed'])
  })
})

describe('QA parseChangelog — line endings, BOMs and other checkout accidents', () => {
  it('parses a file with mixed CRLF and LF endings', () => {
    // A file half-edited on Windows, or a merge of a CRLF branch into an LF one. A
    // `\r` left on the end of a line would ride inside a bullet all the way to the
    // terminal, where its tail redraws over the box's own frame.
    const text = `## [1.0.0] (2026-01-01)${CR}${LF}${CR}${LF}### F${CR}${LF}${LF}* a${LF}* b${CR}${LF}`
    expect(parseChangelog(text)).toEqual([
      { version: '1.0.0', date: '2026-01-01', sections: [{ heading: 'F', bullets: ['a', 'b'] }] },
    ])
    expectWellFormed(parseChangelog(text), 'mixed endings')
  })

  it('reports nothing for a file with only carriage returns for line endings', () => {
    // Classic Mac endings: one long line as far as `\r?\n` is concerned, so no heading
    // is at the start of a line and there is no release. Nothing, rather than one
    // entry whose version is the whole file — which is what a `\s` split would give.
    expect(parseChangelog(`## [1.0.0]${CR}### F${CR}* a${CR}`)).toEqual([])
  })

  it('parses a file that begins with a byte-order mark', () => {
    // The realistic BOM: written by an editor before the `# Changelog` title, where it
    // sits on a line that is not a heading anyway. The releases below it are unaffected.
    const text = `${BOM}# Changelog${LF}${LF}## [1.0.0] (2026-01-01)${LF}${LF}### F${LF}${LF}* a${LF}`
    expect(bulletsOf(text)).toEqual(['a'])
  })

  it('reports no release when a BOM is glued to the heading itself', () => {
    // The degenerate BOM: directly in front of `##`, so the heading no longer starts
    // the line. The entry is LOST — and the thing to hold onto is which way it fails:
    // no entry at all (the banner drops its section) rather than an entry whose
    // version is `<BOM>##`. Pinned as the safe direction, not as desirable.
    expect(parseChangelog(`${BOM}## [1.0.0] (2026-01-01)${LF}${LF}### F${LF}${LF}* a${LF}`)).toEqual(
      [],
    )
  })

  it('parses a file that is nothing but whitespace', () => {
    // ...including a file whose only content is a byte-order mark, which `\s` and
    // `String.prototype.trim` both count as whitespace.
    for (const text of ['', ' ', '   ', `${LF}${LF}${LF}`, `\t${LF} ${LF}`, BOM]) {
      expect(parseChangelog(text), JSON.stringify(text)).toEqual([])
    }
  })
})

describe('QA parseChangelog — a fenced code block is read as markup, not as code', () => {
  it('still shows the release’s own first bullets when a fence contains a heading', () => {
    // KNOWN LIMITATION, pinned by its consequence rather than by its mechanism: this
    // parser is line-based and has no fence awareness, so a column-zero `## [x]` inside
    // a fenced block reads as a release heading. What is asserted is the part that
    // reaches a user — the real entry is still entry ZERO and the banner still shows
    // its own bullets — because that is what survives the limitation. What is lost is
    // any bullet written AFTER the fence inside the same entry; release-please never
    // writes one (a fenced block would arrive indented, inside a wrapped bullet), so
    // the cost is bounded and the box is never wrong about the current release.
    const text =
      `## [1.0.0] (2026-01-01)${LF}${LF}### Features${LF}${LF}* the real note${LF}${LF}` +
      '```' +
      `${LF}## [9.9.9] (2026-02-02)${LF}` +
      '```' +
      `${LF}${LF}* a note after the fence${LF}`
    expect(parseChangelog(text)[0]).toMatchObject({ version: '1.0.0', date: '2026-01-01' })
    expect(bulletsOf(text)).toEqual(['the real note'])
    expectWellFormed(parseChangelog(text), 'fenced heading')
  })

  it('is unmoved by a fence that contains no heading', () => {
    // The shape that actually appears: a code sample indented under a bullet. It is a
    // continuation, so it folds into the bullet above it and nothing else changes.
    const text =
      `## [1.0.0] (2026-01-01)${LF}${LF}### Features${LF}${LF}* run it like this:${LF}` +
      `  \`\`\`${LF}  ralph start${LF}  \`\`\`${LF}`
    expect(bulletsOf(text)).toEqual(['run it like this: ``` ralph start ```'])
  })
})

describe('QA parseChangelog — totality, over everything that is not a changelog', () => {
  // "A changelog nothing can be made of is NO ENTRIES, never a throw" is a promise
  // about the PARSER, not just about the reader above it — `ralph start` prints this
  // banner before its first preflight line and must not abort over its own release
  // notes. Swept rather than sampled, because the value arrives from an injected fs.
  const NON_STRINGS = [
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['a number', 42],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['true', true],
    ['false', false],
    ['an empty object', {}],
    ['a prototypeless object', Object.create(null)],
    ['an array', []],
    ['an array of lines', ['## [1.0.0]', '* a']],
    ['a Buffer', Buffer.from('## [1.0.0]\n* a\n')],
    ['a Uint8Array', new TextEncoder().encode('## [1.0.0]\n')],
    ['a boxed String object', new String('## [1.0.0] (2026-01-01)\n')],
    ['a function', () => '## [1.0.0]'],
    ['a Symbol', Symbol('## [1.0.0]')],
    ['a BigInt', 10n],
    ['a Map', new Map([['## [1.0.0]', 1]])],
    ['a Set', new Set(['## [1.0.0]'])],
    ['a Date', new Date(0)],
    ['a Promise', Promise.resolve('## [1.0.0]')],
    ['a regexp', /## \[1\.0\.0\]/],
    ['an object whose toString throws', { toString: () => { throw new Error('nope') } }],
  ]

  for (const [name, input] of NON_STRINGS) {
    it(`reads ${name} as an empty changelog`, () => {
      // Never coerced, either: a `String(value)` here would run a hostile object's
      // `toString`, and the value came out of an fs this module does not control.
      expect(parseChangelog(input)).toEqual([])
      expect(latestBullets(parseChangelog(input))).toEqual([])
    })
  }

  it('never throws for a document assembled out of the wrong pieces', () => {
    const MALFORMED = [
      '#',
      '##',
      '## ',
      '###',
      '### ',
      '*',
      '* ',
      '-',
      `##${LF}##${LF}##${LF}`,
      `## [${LF}`,
      `## ]${LF}`,
      `## [1.0.0${LF}`,
      `## 1.0.0](${LF}`,
      `## [1.0.0] (${LF}`,
      `## [1.0.0])${LF}`,
      `### F${LF}* a${LF}## [1.0.0]${LF}`,
      `* a${LF}### F${LF}## [1.0.0]${LF}`,
      `## [1.0.0]${LF}## [2.0.0]${LF}## [3.0.0]${LF}`,
      `## [1.0.0]${LF}### F${LF}### G${LF}### H${LF}`,
      `## [1.0.0]${LF}  ${LF}\t${LF}* a${LF}`,
      '## [1.0.0]'.repeat(100),
      `${'#'.repeat(50)} [1.0.0]${LF}`,
      `## [1.0.0]${LF}* ${'x'.repeat(10000)}${LF}`,
      `## [${'1'.repeat(1000)}]${LF}* a${LF}`,
      doc(NUL),
      doc(DEL),
      doc(C1_CSI),
      doc(`${ESC}[31m`),
      doc('\uD800'),
      doc('\uDFFF'),
      doc('\u{10FFFF}'),
      doc('\u200D'),
      doc('\u00A0'),
    ]
    for (const text of MALFORMED) {
      const why = JSON.stringify(text).slice(0, 80)
      let entries
      expect(() => (entries = parseChangelog(text)), why).not.toThrow()
      expectWellFormed(entries, why)
      expect(() => latestBullets(entries), why).not.toThrow()
    }
  })

  it('hands a control character on to the builder that gates it, unchanged', () => {
    // DELIBERATE, and stated in cleanBullet: the parser collapses WHITESPACE and
    // nothing else. A NUL, a DEL, a C1 CSI or an ESC survives it, because gating a
    // fact for a terminal belongs to the builder that prints it
    // (lib/banner-rows.js's `textOr`) and a parser that quietly rewrote the file's
    // bytes would leave `ralph changelog` (#71) rendering something the file does not
    // say. The box's own no-escape guarantee is asserted end to end in
    // banner-compose.whats-new.qa.test.js and start.whats-new.qa.test.js.
    expect(bulletsOf(doc(`a${NUL}b`))).toEqual([`a${NUL}b`])
    expect(bulletsOf(doc(`a${DEL}b`))).toEqual([`a${DEL}b`])
    expect(bulletsOf(doc(`a${C1_CSI}[31mb`))).toEqual([`a${C1_CSI}[31mb`])
    expect(bulletsOf(doc(`a${ESC}[31mb`))).toEqual([`a${ESC}[31mb`])
    // ...while VT and FF ARE whitespace to `\s`, so they collapse like any other run.
    expect(bulletsOf(doc(`a${String.fromCharCode(11)}b`))).toEqual(['a b'])
    expect(bulletsOf(doc(`a${String.fromCharCode(12)}b`))).toEqual(['a b'])
  })
})

describe('QA latestBullets — the newest entry, and nothing of anyone else’s', () => {
  it('returns a fresh, plain array of strings the caller may keep', () => {
    // `ralph start` hands this array straight to composeBanner, and #75/#76 will hand
    // it to `ralph doctor` and `ralph status`. So it is built fresh on every call and
    // shares nothing with the entries: mutating what came back cannot rewrite the
    // parse, and a second call cannot see the first caller's edit.
    const entries = parseChangelog(`## [1.0.0]${LF}${LF}### F${LF}${LF}* a${LF}* b${LF}`)
    const first = latestBullets(entries)
    const second = latestBullets(entries)
    expect(first).toEqual(['a', 'b'])
    expect(first).not.toBe(second)
    first.push('CLOBBERED')
    first[0] = 'REWRITTEN'
    expect(latestBullets(entries)).toEqual(['a', 'b'])
    expect(entries[0].sections[0].bullets).toEqual(['a', 'b'])
    // A PLAIN array, not a thenable and not an exotic: the consumer's first act is
    // `Array.isArray`, and `for…of` on anything cleverer can throw.
    expect(Array.isArray(second)).toBe(true)
    expect(second).not.toHaveProperty('then')
    for (const bullet of second) expect(typeof bullet).toBe('string')
  })

  it('crosses every section of the newest entry and stops there', () => {
    const text =
      `## [2.0.0]${LF}${LF}### Features${LF}${LF}* f1${LF}* f2${LF}${LF}### Bug Fixes${LF}${LF}* b1${LF}${LF}` +
      `## [1.0.0]${LF}${LF}### Features${LF}${LF}* old${LF}`
    // File order across sections, and never a window across two releases: "what's
    // new" is a release, and a fourth bullet borrowed from the one below it would
    // make the box announce something a user already saw.
    expect(latestBullets(parseChangelog(text))).toEqual(['f1', 'f2', 'b1'])
    expect(latestBullets(parseChangelog(text))).not.toContain('old')
  })

  it('is total for hand-built entries that never came out of the parser', () => {
    // `readChangelog` is an injected seam in `ralph start`, so what reaches here is
    // whatever a caller returned. Each of these must cost the SECTION, never the run.
    const HAND_BUILT = [
      [{ sections: [{ bullets: ['a'] }] }],
      [{ sections: [{ bullets: [' ', 'a', null, 7, {}, [], 'b'] }] }],
      [{ sections: [null, undefined, 42, 'x', { bullets: null }, { bullets: ['c'] }] }],
      [{ sections: [] }, { sections: [{ bullets: ['not mine'] }] }],
      [{}, { sections: [{ bullets: ['not mine either'] }] }],
      [null, { sections: [{ bullets: ['nor mine'] }] }],
      [{ sections: { bullets: ['not an array'] } }],
      [{ sections: new Set([{ bullets: ['a set'] }]) }],
      Object.freeze([Object.freeze({ sections: Object.freeze([]) })]),
      [Object.create(null)],
      [{ get sections() { return [{ bullets: ['from a getter'] }] } }],
    ]
    const expected = [
      ['a'],
      ['a', 'b'],
      ['c'],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      ['from a getter'],
    ]
    HAND_BUILT.forEach((input, index) => {
      const why = `case ${index}`
      let bullets
      expect(() => (bullets = latestBullets(input)), why).not.toThrow()
      expect(bullets, why).toEqual(expected[index])
    })
  })

  it('drops a blank bullet but keeps the raw bytes of a usable one', () => {
    // The trim is a USABILITY test, not a rewrite: a bullet that is only whitespace is
    // not a bullet, and one that has content keeps every byte it had — including the
    // control characters lib/banner-rows.js is the one to replace. Trimming here
    // would make the box's guarantee a convention of this function instead.
    const raw = `  a bullet with a ${ESC} in it  `
    expect(latestBullets([{ sections: [{ bullets: ['  ', '\t', raw] }] }])).toEqual([raw])
  })
})

describe('QA changelog — purity, read and demonstrated', () => {
  it('reaches no filesystem, no clock and no environment, by source', () => {
    // The ABSENCE of a capability cannot be shown by exercising happy paths, and this
    // module's whole value is that it is text in, data out: a `readFileSync` or a
    // `new Date()` here would make `ralph changelog` (#71) and every case in
    // changelog.test.js a function of the machine the suite runs on (#41).
    const code = codeWithoutComments(new URL('./changelog.js', import.meta.url))
    // NO imports at all — the strongest form of the claim, and the one that keeps a
    // future contributor from reaching for `node:fs` "just to read the file here".
    expect([...code.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1])).toEqual([])
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/\bnode:/)
    expect(code).not.toMatch(/\bprocess\b/)
    expect(code).not.toMatch(/\bglobalThis\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/readFileSync|writeFileSync|existsSync/)
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/\bhomedir\b/)
    expect(code).not.toMatch(/\bcwd\b/)
  })

  it('parses with Date, Math.random, fetch and process trip-wired', () => {
    // The other half: demonstrated rather than read, because a static grep of ONE file
    // cannot see a capability reached through an import — and this module claims to
    // have no imports at all, which is exactly the claim a trip-wire can confirm.
    const realDate = globalThis.Date
    const realRandom = Math.random
    const realFetch = globalThis.fetch
    const realProcess = globalThis.process
    const tripwire = (name) => () => {
      throw new Error(`changelog.js touched ${name}`)
    }
    let entries
    try {
      globalThis.Date = tripwire('Date')
      Math.random = tripwire('Math.random')
      globalThis.fetch = tripwire('fetch')
      globalThis.process = new Proxy(
        {},
        {
          get(_target, property) {
            throw new Error(`changelog.js read process.${String(property)}`)
          },
        },
      )
      entries = parseChangelog(`## [1.0.0] (2026-01-01)${LF}${LF}### F${LF}${LF}* a${LF}`)
      latestBullets(entries)
    } finally {
      globalThis.Date = realDate
      Math.random = realRandom
      globalThis.fetch = realFetch
      globalThis.process = realProcess
    }
    expect(entries).toEqual([
      { version: '1.0.0', date: '2026-01-01', sections: [{ heading: 'F', bullets: ['a'] }] },
    ])
  })

  it('is a function of its argument alone: two calls, one answer, fresh objects', () => {
    // The regexes at the top of the module are module-level and shared. Any one of
    // them carrying a `g` flag would carry `lastIndex` from call to call, and the
    // symptom is this test: the second parse of the same text answering differently.
    const text =
      `## [2.0.0] (2026-02-02)${LF}${LF}### F${LF}${LF}* [a](https://x)${LF}${LF}` +
      `## [1.0.0] (2026-01-01)${LF}${LF}### F${LF}${LF}* [b][ref]${LF}`
    const first = parseChangelog(text)
    const second = parseChangelog(text)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
    // ...and ten more, in case the drift needs a warm-up.
    for (let i = 0; i < 10; i += 1) expect(parseChangelog(text)).toEqual(first)
  })
})
