// #70 — CHANGELOG.md as data. Text in, entries out, and nothing else.
//
// The banner's "what's new" section (#70) needs three bullets out of the newest release,
// and `ralph changelog` (#71) will need every entry in the file. Both read the SAME file
// — the one that ships inside the package — so the grammar of that file lives here, once,
// rather than in each command: the split lib/digest-file.js makes between the writer and
// the reader of `.ralph/digest.log`, for the same reason. A second parse in #71 is how
// the box and the command would come to disagree about what release 0.22.0 contained.
//
// PURE, and the point of it is that it stays that way: no fs, no path, no process, no
// clock. It takes a STRING because the caller that has the file (lib/changelog-file.js)
// is the one allowed to fail at reading it, and because every shape below — an empty
// file, a file with no releases, a bullet wrapped over three lines, a CRLF checkout — is
// then a string literal in a test rather than a fixture the suite has to install.
//
// TOTAL: every input, including one that is not a string at all, produces an array. A
// changelog nothing can be made of is NO ENTRIES, never a throw — `ralph start` prints
// this banner before its first preflight line and must not abort over its own release
// notes. That is a promise about the parser, not just about the reader above it.
//
// WHAT IT DOES NOT DO: it does not sort, it does not compare versions, and it does not
// decide what "newest" means. release-please prepends each release, so the file is
// already newest-first and this module reports the order it reads — a second semver
// opinion here is exactly what lib/banner-rows.js refuses to have. A file a human has
// reordered is reported as it reads, which is the honest answer rather than a clever one.

// A RELEASE HEADING. `## [0.22.0](https://…/compare/v0.21.0...v0.22.0) (2026-08-27)` is
// what release-please writes; `## [0.1.0] - Unreleased` is what the hand-written entry at
// the bottom of this project's file looks like; `## 0.22.0 (2026-08-27)` is what the same
// tool writes with links switched off. All three are one heading with a version in it.
//
// `^##[ \t]+` and not `^##`: `### Features` has a `#` where this needs a space, so the two
// levels cannot be confused, and a `#### ` sub-sub-heading falls through to neither.
const ENTRY_HEADING = /^##[ \t]+(.+)$/
// A SECTION HEADING. `### Features`, `### Bug Fixes`, `### Miscellaneous Chores`,
// `### Notes`, `### ⚠ BREAKING CHANGES` — the heading is taken verbatim, emoji and all,
// because it is the file's own word for the group and this module is not a translator.
const SECTION_HEADING = /^###[ \t]+(.+)$/
// A BULLET. Both markers, because both are in this project's file: release-please writes
// `*` and the hand-written 0.1.0 entry writes `-`. A parser that only knew `*` would read
// the oldest release in Ralph's own changelog as an empty one.
const BULLET = /^[*-][ \t]+(.+)$/
// A CONTINUATION. An indented, non-blank line directly under a bullet — how a wrapped
// bullet is spelled (`### ⚠ BREAKING CHANGES` at 0.8.0 runs to three lines). Indentation
// alone is the test, and it is only applied while a bullet is open, so the `[prd]: https…`
// link definitions at column zero can never be swept into one.
const CONTINUATION = /^[ \t]+\S/
// ...and the marker of an indented list item, stripped when that continuation turns out to
// be a NESTED BULLET rather than a wrapped line. Both fold into the bullet above them — a
// box with one row per bullet has nowhere to put a second level — and folding is right, but
// carrying the `*` into the middle of the sentence is not: `parent * child` reads as a typo
// in the release notes, and a reader has no way to know it was ever a list. Applied only to
// a line already matched as a continuation, so this can never eat a real bullet's marker.
const NESTED_MARKER = /^[*+-][ \t]+/

// The bracketed label of a heading — `[0.22.0](…)` and `[0.1.0] - Unreleased` both yield
// `0.22.0`/`0.1.0`. Deliberately NOT the URL that follows it: the compare link contains
// two more versions (`v0.21.0...v0.22.0`) and picking the wrong one would label a release
// with its predecessor.
const HEADING_LABEL = /^\[([^\]]+)\]/
// ...and the fallback for an unlinked heading: the first word.
const FIRST_WORD = /^(\S+)/
// The release DAY, as release-please parenthesises it at the end of the heading. Null when
// absent (`## [0.1.0] - Unreleased`) rather than guessed, and never today's date — this
// module has no clock and the file has no answer.
const HEADING_DATE = /\((\d{4}-\d{2}-\d{2})\)$/

// WHAT COUNTS AS A VERSION, and therefore as a release. A `## ` heading whose label does
// not begin with a digit (optionally behind a `v`) is prose — `## Contributing`,
// `## Migration notes`, `## Unreleased` — and a changelog that carries such a section
// must not report it as a release the banner then announces. Kept as loose as that on
// purpose: a full semver test here would drop `## [2.0]` or `## [1.0.0.1]` from a
// hand-written file, and the consumer only ever prints this string.
const LOOKS_LIKE_VERSION = /^v?\d/

// A markdown link, FLATTENED TO ITS LABEL. `([#63](https://github.com/…/issues/63))`
// becomes `(#63)`.
//
// The URL is dropped rather than kept, and that is a decision this module owns because
// both consumers need the same one: the banner's value column is 48 columns at the box's
// 60-wide default and one of these URLs is longer than that on its own, so a bullet that
// kept them would truncate to a fragment of a link instead of to the sentence a reader
// came for. The LABEL is what a human wrote (`#63`, `a6c37ba`, `issue #13`), so flattening
// loses no words — and #71 renders from this same text, which is what keeps the box and
// the command saying the same thing.
//
// Two forms, because this file contains both: inline `[label](url)` and reference-style
// `[label][ref]`. The inline pattern stops at the first `)`, so a URL containing a
// parenthesis leaves one behind; that is a cosmetic tail in a value that is about to be
// clipped, and the alternative is a balanced-paren scanner this package will not carry for
// a banner. Emphasis (`**bold**`) is deliberately left alone: it is one word's worth of
// punctuation, and stripping markdown for display is the renderer's job, not the parser's.
const INLINE_LINK = /\[([^\]]*)\]\([^)]*\)/g
const REFERENCE_LINK = /\[([^\]]*)\]\[[^\]]*\]/g

/**
 * CHANGELOG.md as ordered release entries.
 *
 * @param {string} text the file's contents. Anything that is not a string reads as an
 *   empty changelog, because the caller took it from an fs it does not control.
 * @returns {Array<{version: string, date: string|null, sections: Array<{heading: string,
 *   bullets: string[]}>}>} one entry per release, in the order the file lists them
 *   (release-please writes newest first). Never null, never throws.
 */
export function parseChangelog(text) {
  if (typeof text !== 'string') return []

  const entries = []
  // The three things being built, from the outside in. `entry` is null while the cursor
  // is above the first release — which is what keeps the file's title, its "All notable
  // changes…" line and its Keep-a-Changelog links out of the result — and null again
  // after a `## ` heading that names no version, so that section's bullets are ignored
  // rather than attributed to the release above it.
  let entry = null
  let section = null
  // The bullet in progress, as its lines arrive. Held as an array and joined at the end
  // so a wrapped bullet costs one string per line instead of one per continuation.
  let bullet = null

  const closeBullet = () => {
    if (!bullet) return
    const content = cleanBullet(bullet.join(' '))
    // A bullet whose whole content was punctuation or whitespace is not a bullet. Dropped
    // rather than pushed as '', so no consumer has to filter what this module knows.
    //
    // `section` is not re-checked: a bullet is only ever opened after the branch below has
    // guaranteed one (`section ??=`), so a `&& section` here would be a guard that cannot
    // fire, and a dead guard reads as if the invariant were in doubt.
    if (content) section.bullets.push(content)
    bullet = null
  }
  const closeSection = () => {
    closeBullet()
    // Taken off the cursor FIRST, so every exit below leaves the parser between sections
    // whether or not the section was kept. `entry` is guarded as well as `section` because
    // both are read from the closure and only one of them is established by this function's
    // callers: today the `if (!entry) continue` below makes a section-without-entry
    // unreachable, so this changes nothing observable — it is here so that "never throws"
    // is a property of this function rather than of the loop that happens to call it.
    const finished = section
    section = null
    // A heading with nothing under it is not something a reader can be shown, and the
    // banner's rule one level up is the same one: drop the section rather than render an
    // empty heading. So an empty section never reaches a consumer to be dropped twice.
    if (!entry || !finished?.bullets.length) return
    entry.sections.push(finished)
  }
  const closeEntry = () => {
    if (!entry) return
    closeSection()
    // Pushed even with no sections: a release that says nothing is still a release, and
    // #71 lists it. It is the BANNER that turns "no bullets" into "no section".
    entries.push(entry)
    entry = null
  }

  // `\r?\n`, because a changelog edited on Windows or checked out under `core.autocrlf`
  // is the same changelog. A `\r` left on the end of every line would otherwise ride
  // inside each bullet all the way to the terminal, where it redraws over the box's frame.
  for (const line of text.split(/\r?\n/)) {
    const entryHeading = ENTRY_HEADING.exec(line)
    if (entryHeading) {
      closeEntry()
      const heading = entryHeading[1].trim()
      const version = headingVersion(heading)
      // Not a release: stay closed. The bullets under a `## Contributing` heading belong
      // to nobody, and attributing them to the release above would put a maintainer's
      // note in the banner as this week's news.
      if (version) entry = { version, date: HEADING_DATE.exec(heading)?.[1] ?? null, sections: [] }
      continue
    }
    if (!entry) continue

    const sectionHeading = SECTION_HEADING.exec(line)
    if (sectionHeading) {
      closeSection()
      section = { heading: sectionHeading[1].trim(), bullets: [] }
      continue
    }

    const bulletMatch = BULLET.exec(line)
    if (bulletMatch) {
      closeBullet()
      // A bullet with no `###` above it — a hand-written entry that skipped the
      // taxonomy. It still counts, under an empty heading: the consumer wants the words,
      // and silently dropping a release's only content is the worse of the two answers.
      section ??= { heading: '', bullets: [] }
      bullet = [bulletMatch[1]]
      continue
    }

    // A wrapped bullet's next line — or a nested item, which folds into it without its
    // marker. `+` is stripped here although BULLET does not read it at column zero: the
    // question this branch answers is not "is this a bullet" but "what did the writer mean
    // by this indented line", and they meant a sub-item in all three spellings.
    if (bullet && CONTINUATION.test(line)) {
      bullet.push(line.trim().replace(NESTED_MARKER, ''))
      continue
    }
    // ...and anything else ends it: a blank line, a link definition at column zero, or a
    // paragraph of entry-level prose. Free prose outside a bullet is DROPPED, which is
    // the one thing this shape cannot carry — every section is a list of bullets, and
    // this project's one prose section (`### Notes` at 0.19.1) is written as a bullet.
    closeBullet()
  }
  closeEntry()

  return entries
}

/**
 * The bullets the banner shows: every bullet of the NEWEST entry, section by section.
 *
 * Flat, because the box has one row per bullet and no room for the taxonomy — a reader
 * wants to know what changed, not whether it was filed as a feature or a fix. The order
 * is the file's: sections top to bottom, bullets within them, so the box's three bullets
 * are the first three a reader of the changelog would see.
 *
 * ONE ENTRY, never a window across two: "what's new" is a release. And the CAP is not
 * here — lib/banner-rows.js decides how many rows fit, because that is a question
 * about a box.
 *
 * TOTAL for a shape that never came out of `parseChangelog`: the reader is an injected
 * seam in `ralph start`, so a stub that returns a promise (an `async` added to it) or a
 * hand-built entry with no sections must cost the section and not the run.
 *
 * @param {Array} entries entries as `parseChangelog` returns them, newest first
 * @returns {string[]} the newest entry's bullets, or none
 */
export function latestBullets(entries) {
  if (!Array.isArray(entries)) return []
  const sections = entries[0]?.sections
  if (!Array.isArray(sections)) return []
  const bullets = []
  for (const section of sections) {
    if (!Array.isArray(section?.bullets)) continue
    for (const bullet of section.bullets) {
      if (typeof bullet === 'string' && bullet.trim()) bullets.push(bullet)
    }
  }
  return bullets
}

// The version a `## ` heading names, or null when it names none. See LOOKS_LIKE_VERSION
// for why "none" is a case at all.
function headingVersion(heading) {
  const label = HEADING_LABEL.exec(heading)?.[1] ?? FIRST_WORD.exec(heading)?.[1] ?? ''
  const version = label.trim()
  return LOOKS_LIKE_VERSION.test(version) ? version : null
}

// One bullet, as one line of text. Links flattened (see INLINE_LINK), then every run of
// whitespace collapsed to a single space.
//
// The collapse is what makes the return value safe to put in a row of a box: it is where
// a bullet's joined-in tabs and the indentation of its continuation lines go, and it
// guarantees the string is ONE line. It is NOT a sanitiser — a control character other
// than whitespace survives it, deliberately, because gating a fact belongs to the builder
// that prints it (lib/banner-rows.js's `textOr`) and a parser that quietly rewrote the
// file's bytes would leave #71 rendering something the file does not say.
function cleanBullet(text) {
  return text.replace(INLINE_LINK, '$1').replace(REFERENCE_LINK, '$1').replace(/\s+/g, ' ').trim()
}
