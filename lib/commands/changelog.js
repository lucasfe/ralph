// #71 — `ralph changelog`: the command the banner's `more` row promises.
//
// #70 put three bullets of the newest release in the identity box and then wrote "run
// `ralph changelog` for the rest". This is the rest, and that sentence is the spec: the
// DEFAULT view prints the newest release WHOLE — undoing the box's three-bullet clip is the
// entire reason a reader typed this — plus the couple of releases behind it, and `--all`
// prints every one.
//
// IT OWNS NEITHER THE PATH NOR THE GRAMMAR. `changelogPath()` (lib/changelog-file.js) says
// where the file is and `parseChangelog` (lib/changelog.js) says what it means, so the box
// and this command cannot come to disagree about what release 0.22.0 contained — which is
// the whole point of those two modules existing apart from their callers.
//
// WHY IT READS THE FILE ITSELF instead of calling `readChangelogEntries`. That reader
// answers `[]` for a missing file, an unreadable one AND a file that parses to nothing,
// deliberately and permanently: its caller is `ralph start`'s first paint, which must never
// abort over release notes. A user who TYPED a command about the changelog is owed the
// opposite — the failure, named, with the path in it and a non-zero exit — and those three
// cases are two different repairs. So the read is done here, once, guarded, through an
// injected fs, and the two failures get two messages.
//
// NO NETWORK, and not by policy: CHANGELOG.md is in package.json's `files`, so it is
// already on disk beside lib/. That is what makes this command answerable offline, instantly
// and from any directory — a releases API call is the thing it must not become.
//
// FROM ANY DIRECTORY. No `ralph.config.sh`, no `.ralph/`, no git repo and no working
// directory is read: `changelogPath()` resolves against RALPH_HOME, so a globally installed
// Ralph standing in a project with a CHANGELOG.md of its own still prints RALPH'S releases.

import { readFileSync as realReadFileSync } from 'node:fs'
import pc from 'picocolors'
import { changelogPath } from '../changelog-file.js'
import { parseChangelog } from '../changelog.js'
import { failureCause } from '../install-failure.js'

// HOW MANY RELEASES THE DEFAULT VIEW SHOWS. Three, for the same reason the box shows three
// bullets: enough to cover "what have I missed since I last updated" on a project that
// releases weekly, few enough that the answer fits a screen without a pager. It is a count
// of RELEASES, not of bullets — the newest entry is never clipped, whatever it holds.
const DEFAULT_ENTRIES = 3
// The bullet marker. Deliberately a SECOND copy of the box's glyph (#70) rather than an
// import: that one is a prefix inside a width-accounted row, this one is a list marker in
// free-flowing output, and the two are only equal by coincidence of taste.
const BULLET_GLYPH = '•'
// How the default view says there is more. Worded like the banner's own pointer ("run
// `ralph changelog` for the rest") because it is the same kind of sentence one step down.
const ALL_POINTER = 'run `ralph changelog --all` for every release'
// What an entry with no version reads as. `parseChangelog` cannot produce one — a heading
// with no version is not a release to it — so this only fires for an injected parser, and
// the answer is the word lib/banner-rows.js and lib/progress.js already use: name what is
// missing rather than invent it.
const UNKNOWN = 'unknown'

// Anything a terminal would read as an instruction rather than as text. The parser hands
// bullets over verbatim on purpose ("gating a fact belongs to the builder that prints it"),
// and this is that builder: a changelog carrying an escape sequence — a hand-edited entry, a
// generator gone wrong — must not be able to repaint the screen of somebody who asked to
// READ it. Replaced, not dropped, so a mangled line still reads as one character per
// character. Same rule as banner-rows.js's CONTROL, kept separately because that copy
// exists to keep the box's width accounting exact and this one has no width to keep.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/gu
const PLACEHOLDER = '\uFFFD'

// Declared with no throw site, like status's StatusAbort and digest's DigestAbort: every
// failure this command has is a RETURN — two lines on stderr and a non-zero `exitCode` — so
// there is nothing left for it to throw. Kept so the command block in bin/ralph.js has the
// same catch-its-own-Abort shape as every other block there, and so a failure that CAN only
// be signalled mid-listing has somewhere to say so rather than arriving as a bare Error.
class ChangelogAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

/**
 * Print recent Ralph releases, read from the changelog that ships inside the install.
 *
 * @param {object} [options]
 * @param {boolean} [options.all] print every release instead of the newest few
 * @param {object} [options.fs] fs impl, injected in tests (memfs) so no spec reads the real
 *   file unless that is the thing it means to assert
 * @param {string} [options.path] the file to read. Defaults to this package's own
 * @param {Function} [options.parse] the changelog grammar. A seam for one purpose: to pin
 *   that a parser which broke its own "never throws" promise costs an exit code and not a
 *   stack trace
 * @param {{write: Function}} [options.stdout] the listing goes here, one whole line per write
 * @param {{write: Function}} [options.stderr] failures go here, and ONLY here — a reader
 *   piping this into a pager gets an empty document rather than half a listing
 * @returns {Promise<{exitCode: number, shown: number, total: number}>} `shown` is how many
 *   releases were printed, `total` how many the file holds. Both 0 on a failure.
 */
export async function changelogCommand({
  all = false,
  fs = defaultFs,
  path = changelogPath(),
  parse = parseChangelog,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const out = (m) => stdout.write(m + '\n')
  const err = (m) => stderr.write(m + '\n')
  // Every failure below reports the SAME two things: what could not be read, named by its
  // absolute path, and why, on one line. The "why" goes through `safeCause` — the bound
  // (`failureCause`, #23) plus the vetting (below) — so the promise "never a stack trace"
  // rests on a function whose bound is pinned by its own spec rather than on a `.message`
  // read here, and on a read that cannot be turned into a throw by the value it reads.
  const failed = (headline, cause, hint) => {
    err(pc.red(`❌ ${headline}${cause ? ` (${cause})` : ''}.`))
    err(`   ${hint}`)
    return { exitCode: 1, shown: 0, total: 0 }
  }

  let text
  try {
    // `.toString()` because an fs is free to ignore the encoding argument and answer with a
    // Buffer, and the `typeof` because `.toString()` guarantees a CALL, not a string: an fs
    // whose answer converts to a number leaves a `text` with no `.length`, and the
    // no-releases hint below then prints "undefined characters long" — the exact shape of
    // garbage this command's failure contract exists to keep off a terminal. A `String()`
    // wrap would also produce a string, but it would INVENT one for an answer that was never
    // text and then report a character count for it; a value whose own text conversion does
    // not produce text is not a changelog, and no bytes is the honest reading of it.
    const answer = fs.readFileSync(path, 'utf8')?.toString()
    text = typeof answer === 'string' ? answer : ''
  } catch (e) {
    // The failure that actually happens in the field: a pruned install, an `--omit` flag, a
    // tarball built without the file, a directory where it should be, a mode nobody can
    // read. Also where an `fs` that is not one at all lands, since the seam is a parameter.
    return failed(
      `Could not read Ralph's changelog at ${path}`,
      safeCause(e),
      'It ships inside the installed package, so a pruned install or a tarball built without it has none — reinstalling Ralph restores it.',
    )
  }

  let entries
  try {
    entries = parse(text)
  } catch (e) {
    // INSURANCE, not the guarantee. `parseChangelog` is total by contract and that contract
    // is pinned in changelog.test.js — but "total" is a promise made in another file, and
    // the cost of it being wrong here is a stack trace on a user's terminal instead of a
    // sentence. Kept apart from the read's catch so neither failure can be reported with
    // the other's wording: this one had the bytes and could not make sense of them.
    return failed(
      `Could not make sense of Ralph's changelog at ${path}`,
      safeCause(e),
      'The file was read but its release headings could not be parsed. Please report this with the file attached.',
    )
  }

  // No releases is a FAILURE here, and it is the one place this command and the banner
  // deliberately part company: the box drops a section nobody asked for, while a user who
  // typed `ralph changelog` asked a question that now has no answer. Non-zero, named, and
  // worded so it cannot be mistaken for the unreadable case above — the repairs differ.
  const releases = Array.isArray(entries) ? entries : []
  if (releases.length === 0) {
    return failed(
      `Ralph's changelog at ${path} contains no releases`,
      null,
      `It is readable and ${count(text.length, 'character')} long, but nothing in it parses as a \`## <version>\` release heading.`,
    )
  }

  const shown = all ? releases : releases.slice(0, DEFAULT_ENTRIES)
  // Whether anything is being held back, decided ONCE. The header and the pointer are two
  // statements of the same fact, and two copies of the comparison is how they would come to
  // disagree — a "the 3 newest of 3" over a listing with no `--all` line under it, or worse.
  const truncated = shown.length < releases.length
  out(countLine(shown.length, releases.length, truncated))
  // Only when there IS a rest. A pointer to `--all` under a listing that already showed
  // everything is the dead end #70 refused to leave behind, one level down.
  if (truncated) out(ALL_POINTER)
  out('')

  shown.forEach((entry, index) => {
    // The blank goes BEFORE each entry but the first, so the listing never ends in one: a
    // trailing blank line is noise in a pipe and a wasted row in a pager.
    if (index > 0) out('')
    for (const line of entryLines(entry)) out(line)
  })

  return { exitCode: 0, shown: shown.length, total: releases.length }
}

// What a failure SAID, bounded AND vetted — two different jobs, and only the first of them
// belongs to another file. `failureCause` (#23) is the BOUND: first line only, clipped with a
// visible `…`, never a stack, and pinned by its own spec so this file does not restate it.
// The VETTING is the caller's, because the caller is what holds a value nobody has checked:
// `failureCause` reaches the text by READING `.shortMessage` and `.message`, and a rejection
// value is free to fight back. A Proxy-based fs double (a mocking library's autospy, memfs
// behind a Proxy), a revoked Proxy from a torn-down module, a shim whose getter formats its
// message lazily and fails doing it: every one of them throws from the property read itself,
// inside a `catch` where there is nothing left to catch it. bin/ralph.js then rethrows
// anything that is not a ChangelogAbort and the reader gets Node's unhandled-rejection
// report — a stack trace, the one thing this command promises never to print, in place of one
// sentence. Guarding at the read is the same rule lib/changelog-file.qa.test.js states for
// the sibling reader of this very file: nothing in a catch may touch a value it did not vet.
//
// A cause nobody can read is simply no cause — the headline still names the path and the hint
// still names the repair, which is the part a reader acts on, and `failed` already leaves its
// parenthetical off for an empty one.
const safeCause = (failure) => {
  try {
    return failureCause(failure)
  } catch {
    return ''
  }
}

// "Ralph changelog — the 3 newest of 12 releases", or the whole count when nothing is held
// back. Stated as a count rather than left implicit because the listing itself gives a reader
// no way to tell a truncated view from a complete one. `truncated` is passed in rather than
// re-derived: its caller already had to know, and one of the two answers has to be the fact.
function countLine(shown, total, truncated) {
  if (truncated) return `Ralph changelog — the ${shown} newest of ${count(total, 'release')}`
  return `Ralph changelog — ${count(total, 'release')}`
}

// A number and its noun, agreeing. Takes the noun rather than hard-coding "release" because
// the failure wording counts CHARACTERS ("it is readable and 1 character long" — the
// truncated-write case, and the one place the number is most often 1), and a helper that only
// knew about releases is how that line came to read `1 characters long`. A pruned changelog
// with one entry in it is the first thing a new reader of this command sees, and `1 releases`
// is the kind of line that makes a tool look unfinished.
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`

// One release, as terminal lines: its version and date, then its sections in file order with
// their bullets under them. Structure comes from INDENTATION and not from colour — the
// repo's palette (red / yellow / green) is a status vocabulary and a list of releases carries
// no status, and a listing that emits no escape bytes is one a reader can pipe into `grep`,
// a pager or an issue comment and get back what they saw.
function entryLines(entry) {
  const version = textOf(entry?.version) || UNKNOWN
  const date = textOf(entry?.date)
  // `date: null` is a real answer from the parser (`## [0.1.0] - Unreleased` has no day), so
  // the separator belongs to the date and not to the line: a version followed by a dangling
  // `—` reads as a value that failed to load.
  const lines = [date ? `${version} — ${date}` : version]
  for (const section of listOf(entry?.sections)) {
    // `heading: ''` is also a real answer — a hand-written entry whose bullets sit under no
    // `###` at all. Its bullets are still the release's content, so they are printed; a line
    // of nothing but indentation above them would be a heading that was never there.
    const heading = textOf(section?.heading)
    if (heading) lines.push(`  ${heading}`)
    for (const bullet of listOf(section?.bullets)) {
      const text = textOf(bullet)
      // Whole, never clipped: the box clips to its 60 columns and points here for the rest,
      // so this is the one place the bullet exists in full. A long one wraps in the
      // terminal, which is the honest answer for text a reader came to read.
      if (text) lines.push(`    ${BULLET_GLYPH} ${text}`)
    }
  }
  return lines
}

// A value from the parser, as text safe to hand to a `write`. The whitespace collapse keeps
// "one whole line per write" a property of this file rather than of the parser's
// `cleanBullet` — the `parse` seam means a string here need not have been through it.
function textOf(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').replace(CONTROL, PLACEHOLDER).trim()
}

// Iterated shapes, guarded. `?? []` would let a string be walked one character at a time,
// and everything below this point may have come from an injected parser.
const listOf = (value) => (Array.isArray(value) ? value : [])

const defaultFs = { readFileSync: realReadFileSync }

export { ChangelogAbort }
