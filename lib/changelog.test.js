// #70 — the spec for the changelog PARSER, written against the file this package
// actually ships.
//
// The parser is text in, data out (see lib/changelog.js), so every case here is a
// string: no fs, no path, no clock, and nothing that depends on the machine the suite
// runs on (#41). The one file it reads is a FIXTURE, `__fixtures__/changelog-sample.md`
// — a trimmed copy of the shapes release-please has actually written into this repo's
// CHANGELOG.md, kept next to the spec so a release cannot silently rewrite the
// assertions below. That directory is excluded from both `.npmignore` and package.json's
// `files`, so the fixture never reaches a user's node_modules.
//
// WHY A FIXTURE AND NOT THE REAL FILE: CHANGELOG.md gains an entry on every release, so
// a spec pinned to it would go red on a version bump that changed no code — and a spec
// that fails for the wrong reason is a spec that gets weakened. What the real file is
// asserted for lives in changelog-file.test.js, which is the seam that reads it: that
// the shipped file parses into entries at all.
//
// THE SHAPES THAT MATTER, all present in the fixture because all of them are present in
// this project's changelog: `### Features`, `### Bug Fixes`, `### Miscellaneous Chores`,
// the free-prose `### Notes` section 0.19.1 carries, a `### ⚠ BREAKING CHANGES` bullet
// wrapped across three lines, a hand-written `## [0.1.0] - Unreleased` entry with `-`
// bullets, and bullets whose tails are nested markdown links to issues and commits.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { latestBullets, parseChangelog } from './changelog.js'

const fixture = (name) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')

const SAMPLE = fixture('changelog-sample.md')
const EMPTY = fixture('changelog-empty.md')
const NO_RELEASES = fixture('changelog-no-releases.md')

const versions = (text) => parseChangelog(text).map((entry) => entry.version)
const entryFor = (text, version) => parseChangelog(text).find((e) => e.version === version)
const sectionFor = (text, version, heading) =>
  entryFor(text, version).sections.find((section) => section.heading === heading)

describe('parseChangelog — the release entries (#70)', () => {
  it('returns one entry per release, newest first, in the order the file lists them', () => {
    // Document order, NOT a semver sort. release-please prepends, so the file is
    // already newest-first, and re-deriving the order here would be a second opinion
    // about what "newest" means — the same trap lib/banner-compose.js avoids by
    // borrowing update-check.js's comparison rather than writing its own. A file a
    // human has reordered is reported as it reads, which is the honest answer.
    expect(versions(SAMPLE)).toEqual(['0.22.0', '0.21.0', '0.19.1', '0.8.0', '0.1.0'])
  })

  it('reads the version out of the linked heading and the date out of its tail', () => {
    // `## [0.22.0](https://…/compare/v0.21.0...v0.22.0) (2026-08-27)` — the version is
    // the bracketed label, never the compare URL that follows it, and the date is the
    // parenthesised ISO day at the end of the line.
    expect(entryFor(SAMPLE, '0.22.0')).toMatchObject({ version: '0.22.0', date: '2026-08-27' })
    expect(entryFor(SAMPLE, '0.21.0').date).toBe('2026-08-26')
    expect(entryFor(SAMPLE, '0.19.1').date).toBe('2026-08-25')
  })

  it('reports a null date for an entry that carries none', () => {
    // `## [0.1.0] - Unreleased`: a version with no day. Null rather than a guess and
    // rather than today — the parser has no clock and the file has no answer.
    expect(entryFor(SAMPLE, '0.1.0').date).toBeNull()
  })

  it('never turns the file’s leading prose into an entry', () => {
    // The title, the "All notable changes…" line and the Keep-a-Changelog links all
    // sit above the first release. They are not `## ` headings, and the two that are
    // `[label](url)` links must not be mistaken for a version.
    const first = parseChangelog(SAMPLE)[0]
    expect(first.version).toBe('0.22.0')
    expect(JSON.stringify(parseChangelog(SAMPLE))).not.toContain('keepachangelog')
  })

  it('groups bullets under the `###` heading above them, in file order', () => {
    expect(entryFor(SAMPLE, '0.21.0').sections.map((s) => s.heading)).toEqual([
      'Features',
      'Bug Fixes',
    ])
    expect(entryFor(SAMPLE, '0.19.1').sections.map((s) => s.heading)).toEqual([
      'Miscellaneous Chores',
      'Notes',
    ])
    expect(entryFor(SAMPLE, '0.8.0').sections.map((s) => s.heading)).toEqual([
      '⚠ BREAKING CHANGES',
      'Features',
    ])
    expect(entryFor(SAMPLE, '0.1.0').sections.map((s) => s.heading)).toEqual([
      'Added',
      'Supported platforms',
    ])
  })

  it('flattens the nested issue and commit links a release-please bullet ends in', () => {
    // `([#63](https://…/issues/63))` becomes `(#63)`: the LABEL survives, the URL does
    // not. A banner row is 48 columns wide, and one of these URLs is longer than that
    // on its own — a bullet that kept them would truncate to a fragment of a link
    // instead of to the sentence a reader came for.
    expect(sectionFor(SAMPLE, '0.22.0', 'Features').bullets).toEqual([
      '`ralph digest --loop` + a digest window in the tmux session (#62) (#95) (a2f9464)',
      'a digest section in `ralph status` (#63) (#96) (a6c37ba)',
    ])
    expect(JSON.stringify(parseChangelog(SAMPLE))).not.toContain('https://')
  })

  it('keeps the prose of a `Notes` section, links and all', () => {
    // 0.19.1's Notes is a paragraph in a single bullet, not a one-line summary — the
    // shape a release cut for the tag alone takes in this project. It parses as one
    // bullet whose inline links have been flattened like any other.
    const notes = sectionFor(SAMPLE, '0.19.1', 'Notes').bullets
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('**No change to the published package**')
    expect(notes[0]).toContain('(#41) (#47)')
    expect(notes[0]).toMatch(/Released for the tag and changelog record only\.$/)
  })

  it('parses a chores-only release', () => {
    // The other half of 0.19.1: a `Miscellaneous Chores` section whose only bullet is
    // the release commit, with a bare commit link and no issue reference.
    expect(sectionFor(SAMPLE, '0.19.1', 'Miscellaneous Chores').bullets).toEqual([
      'release 0.19.1 (28fabbe)',
    ])
  })

  it('joins a bullet wrapped across several lines into one line', () => {
    // The `⚠ BREAKING CHANGES` shape: a bullet continued on indented lines below it.
    // Joined with a single space, because the consumer is a one-row-per-bullet box and
    // a newline in a returned bullet is a line no width guarantee covers.
    const [breaking] = sectionFor(SAMPLE, '0.8.0', '⚠ BREAKING CHANGES').bullets
    expect(breaking).toBe(
      '**Ralph solo mode is permanently retired.** Team mode is now the only mode of ' +
        'operation — there is no activation flag to opt in or out. Every issue is resolved ' +
        'by the orchestrated team of specialists. (#462)',
    )
    for (const entry of parseChangelog(SAMPLE)) {
      for (const section of entry.sections) {
        for (const bullet of section.bullets) expect(bullet).not.toMatch(/[\n\r]/)
      }
    }
  })

  it('reads `-` bullets as well as `*` ones', () => {
    // The hand-written 0.1.0 entry uses dashes and wraps every item. Both bullet
    // markers Keep a Changelog and release-please use have to count, or the oldest
    // entry in this project's own file would read as an empty release.
    expect(sectionFor(SAMPLE, '0.1.0', 'Added').bullets).toEqual([
      '`ralph` CLI binary with `init`, `start`, `stop`, `doctor` subcommands, plus ' +
        '`--version` and `--help` autogenerated by `commander`. (slice #1)',
    ])
    expect(sectionFor(SAMPLE, '0.1.0', 'Supported platforms').bullets).toEqual([
      'Node ≥18 (ESM, no build step)',
    ])
  })

  it('ignores the link definitions and the loose prose between sections', () => {
    // `[prd]: https://…` and `[0.1.0]: https://…` are markdown plumbing at column
    // zero, and 0.1.0's three-line summary is prose that belongs to no bullet. None of
    // it may arrive as a bullet, because a box row that said `[prd]: https://…` would
    // be reporting the file's syntax as a feature.
    const bullets = parseChangelog(SAMPLE).flatMap((e) => e.sections.flatMap((s) => s.bullets))
    for (const bullet of bullets) expect(bullet).not.toMatch(/^\[/)
    expect(bullets.join('\n')).not.toContain('First public release')
  })
})

describe('parseChangelog — nothing to report (#70)', () => {
  it('returns no entries for an empty file', () => {
    expect(EMPTY).toBe('')
    expect(parseChangelog(EMPTY)).toEqual([])
  })

  it('returns no entries for a file with no releases in it', () => {
    // Prose, a `## Contributing` heading and a stray bullet. A `## ` heading that does
    // not name a version is not a release, so nothing here is an entry — the
    // alternative is a banner announcing `ralph unknown` news under a section title.
    expect(NO_RELEASES).toContain('## Contributing')
    expect(parseChangelog(NO_RELEASES)).toEqual([])
  })

  it('is total for anything that is not text', () => {
    // The reader hands over whatever `fs.readFileSync` returned, and a caller may hand
    // over anything at all. None of it throws and none of it invents an entry.
    for (const input of [undefined, null, '', '   ', 42, {}, [], true, Buffer.from('x')]) {
      expect(parseChangelog(input), JSON.stringify(input)).toEqual([])
    }
  })

  it('parses a file with CRLF line endings', () => {
    // A changelog edited on Windows, or checked out with `core.autocrlf`. A stray `\r`
    // at the end of every line would otherwise ride along inside each bullet and reach
    // the banner as a carriage return, which redraws over the box's own frame.
    const crlf = parseChangelog(SAMPLE.replaceAll('\n', '\r\n'))
    expect(crlf).toEqual(parseChangelog(SAMPLE))
  })
})

describe('latestBullets — what the banner shows (#70)', () => {
  it('returns the newest entry’s bullets, section by section, in order', () => {
    // Flat, because the box has one row per bullet and no room for the taxonomy. The
    // ORDER is the file's: sections top to bottom, bullets within them.
    expect(latestBullets(parseChangelog(SAMPLE))).toEqual([
      '`ralph digest --loop` + a digest window in the tmux session (#62) (#95) (a2f9464)',
      'a digest section in `ralph status` (#63) (#96) (a6c37ba)',
    ])
  })

  it('crosses the sections of one entry but never the next entry’s', () => {
    // 0.21.0 is newest here, and it has a bullet under each of two headings. What must
    // not happen is 0.19.1's chore bullet joining them: "what's new" is one release.
    const entries = parseChangelog(SAMPLE).slice(1)
    expect(latestBullets(entries)).toEqual([
      'GIF-to-sprite generator and pure half-block renderer (#66) (#87) (6d1834b)',
      'never finish a turn with a subagent in flight (#88) (#89) (c18ea21)',
    ])
  })

  it('returns nothing for an entry with no bullets, and for no entries at all', () => {
    // The banner drops its whole section on an empty answer (see banner-compose), so
    // this is the only signal it needs — never a placeholder bullet.
    expect(latestBullets(parseChangelog('## [1.0.0] (2026-01-01)\n\n### Features\n'))).toEqual([])
    expect(latestBullets([])).toEqual([])
  })

  it('is total for a shape that never came out of the parser', () => {
    // `readChangelog` is an injected seam in `ralph start`, so what reaches here is not
    // guaranteed to have been through parseChangelog — a stub returning a promise (an
    // `async` added to the reader) is the likeliest accident.
    for (const input of [undefined, null, 'nope', 42, {}, Promise.resolve([]), [null], [{}], [{ sections: 'x' }], [{ sections: [null, { bullets: 'x' }] }]]) {
      expect(latestBullets(input), JSON.stringify(input)).toEqual([])
    }
  })
})
