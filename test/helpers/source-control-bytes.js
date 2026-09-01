// #107 support — the primitives the control-byte guards are built from: the byte class
// itself, the set of files in scope, and the offender report.
//
// WHY THIS IS A MODULE AND NOT TWO COPIES
// test/source-control-bytes.test.js (the guard) asserts the repo is clean; every one of
// its assertions is of the shape "the offender list is empty", which is also what you get
// from a detector that never fires. test/source-control-bytes.qa.test.js is the file that
// plants offenders and demands they be found. Both therefore need the SAME detector — a
// re-implementation on the QA side would prove only that the copy works. Same problem
// test/helpers/env-surface.js and doc-guard.js solve, same fix: one definition, imported
// by both, so drift is impossible by construction.
//
// WHAT THE BYTES COST, which is why there are three sets and not one:
//   * U+0000 (NUL) makes `file` classify the source as `data`, and the code-search tools
//     built on that verdict — grep, rg, git grep — then skip the file, or count it without
//     showing a line. readFileSync does not care, so a suite stays green while a whole test
//     file quietly leaves the searchable repo.
//   * U+001B (ESC) stays searchable but is a live escape sequence: cat or less a file
//     carrying one and the terminal takes the colour from that line on.
//   * The rest of the class costs one or the other. A stray U+0001 and a stray U+001A were
//     each keeping a .js file on `data` when this was written, and U+0007 rings the bell.
//
// Nothing in here contains a raw control byte. Every one is built from its code point, the
// convention lib/commands/doctor.identity-box.test.js documents — and the guard scans this
// file too, so a lapse fails rather than spreading.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { RALPH_HOME } from '../../lib/paths.js'

// TAB, LF and CR are ordinary text and are excluded. Everything else in the C0 block, plus
// DEL, is a byte with no business in source: `file` reads most of them as evidence the file
// is binary, and a terminal reads several of them as commands.
export const TEXT_CONTROL_CODES = new Set([0x09, 0x0a, 0x0d])
const C0_CODES = Array.from({ length: 0x20 }, (_, code) => code)
export const CONTROL_CODES = C0_CODES.concat(0x7f).filter(
  (code) => !TEXT_CONTROL_CODES.has(code),
)

export const NUL_CODE = 0x00
export const ESC_CODE = 0x1b
// The remainder, so each of the guard's three assertions owns a disjoint set and a failure
// says WHICH property broke rather than just "a byte".
export const OTHER_CONTROL_CODES = CONTROL_CODES.filter(
  (code) => code !== NUL_CODE && code !== ESC_CODE,
)

// 27 → '001B'. A report has to NAME the byte rather than print it: printing it would move
// the problem into the test output, where the byte is invisible again.
const hex = (code) => code.toString(16).toUpperCase().padStart(4, '0')
const codePointName = (code) => `U+${hex(code)}`

/**
 * Every file git tracks under `cwd`, as absolute paths.
 *
 * WHY TRACKING AND NOT A DIRECTORY WALK. The property under guard is criterion 1's own
 * wording — "no file tracked by git contains a raw U+0000 byte" — and a walk of the working
 * tree answers a different question. It sweeps in whatever happens to be sitting there: a
 * `.env.local` the README tells you to create, a `coverage/` directory after one
 * `--coverage` run, a `.DS_Store` that Finder writes by opening the folder. Each of those
 * either goes red for a byte nobody authored or has to be bought off with another entry in
 * a hardcoded skip list — and a list is what needs maintaining, gets stale, and then lies
 * in a comment about being "everything git ignores". Tracking is the RULE the list was
 * approximating: authored files are tracked, generated and vendored ones are not, and
 * `.git/` needs no skip at all because nothing inside it is tracked either.
 *
 * THE COST, stated because the next reader will wonder: a brand-new source file that has
 * not been `git add`ed yet is out of scope, and stays out until it is staged. That is the
 * correct reading of the criterion — an unstaged file is not in the repo — and it is a
 * narrow window, since the file is swept the moment it can be pushed.
 *
 * FAIL CLOSED. Missing git, a cwd that is not a repository, a non-zero exit, or an empty
 * list all throw. A guard that quietly scans nothing is precisely the silent-blind-spot
 * failure mode #107 exists to prevent, so "no offenders" must never be reachable by
 * accident.
 *
 * @param {{cwd?: string}} [options] `cwd` — the tree to enumerate, default RALPH_HOME.
 * @returns {string[]} absolute paths, one per tracked file.
 */
export function trackedFiles({ cwd = RALPH_HOME } = {}) {
  // `-z` because the alternative is git QUOTING any path with a special character in it,
  // which would then have to be unquoted by hand. The delicious part: the separator is the
  // NUL byte this module exists to forbid in source — so it is built from its code point
  // here, under its own rule, rather than typed.
  const SEPARATOR = String.fromCharCode(NUL_CODE)
  let stdout
  try {
    stdout = execFileSync('git', ['ls-files', '-z'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      // No stdin, and stderr captured onto the error rather than leaked into the run.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new Error(
      `Could not list the files git tracks in ${cwd}: ${error.code ?? `exit ${error.status}`}. ` +
        `${String(error.stderr ?? '').trim()}\n` +
        'This guard cannot fall back to scanning nothing — an empty file list would make ' +
        'every control-byte assertion pass vacuously, which is the exact blind spot #107 ' +
        'is about. Fix the repository or the git installation.',
      { cause: error },
    )
  }
  // Without `--full-name` git prints paths relative to `cwd`, so joining onto `cwd` is
  // right whether or not `cwd` happens to be the repository root.
  const paths = stdout.split(SEPARATOR).filter((entry) => entry !== '')
  if (paths.length === 0) {
    throw new Error(
      `git tracks no files in ${cwd}. Refusing to report a clean sweep over an empty list.`,
    )
  }
  return paths.map((path) => join(cwd, path))
}

/**
 * The tracked files git has been TOLD are binary, as a Set of absolute paths.
 *
 * WHY A DECLARATION AND NOT A SNIFF. git will happily answer this from content — `ls-files
 * --eol` prints `w/-text`, `grep -I` skips the file — and that answer is reached by looking
 * for a NUL in the first 8000 bytes. Which is the byte this module exists to forbid. Sniffing
 * would therefore hand every file a vote on its own membership: a .js that acquired a NUL near
 * the top would be reclassified as binary, drop out of the sweep, and take its own offence with
 * it. That is not a hypothetical trade-off, it is exactly the silent blind spot #107 was filed
 * about, arrived at from the other side.
 *
 * `.gitattributes` cannot do that quietly. A kind leaves the sweep only when someone writes a
 * line naming it, in a file a reviewer reads, and the QA guard fails if that line ever covers a
 * source extension — so the escape hatch stays an asset hatch.
 *
 * FAIL CLOSED, on the same reasoning as `trackedFiles()`: a check-attr that errors must not be
 * read as "nothing is binary", because that direction is the safe-looking one (it puts MORE
 * files in the sweep) right up until the inverse filter is what a caller wanted.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] the repository, default RALPH_HOME.
 * @param {string[]} [options.files] absolute paths to ask about, default every tracked file.
 * @returns {Set<string>} absolute paths whose `binary` attribute is `set`.
 */
export function declaredBinaryFiles({ cwd = RALPH_HOME, files } = {}) {
  const subjects = files ?? trackedFiles({ cwd })
  if (subjects.length === 0) return new Set()
  // Same NUL-as-separator trick as `trackedFiles`, and for the same reason: without `-z` git
  // quotes any path with a special character and the quoting has to be undone by hand. Built
  // from its code point, under this module's own rule.
  const SEPARATOR = String.fromCharCode(NUL_CODE)
  let stdout
  try {
    stdout = execFileSync('git', ['check-attr', '-z', '--stdin', 'binary'], {
      cwd,
      input: subjects.map((file) => relative(cwd, file)).join(SEPARATOR) + SEPARATOR,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new Error(
      `Could not read the \`binary\` attribute in ${cwd}: ${error.code ?? `exit ${error.status}`}. ` +
        `${String(error.stderr ?? '').trim()}\n` +
        'This helper cannot fall back to "nothing is declared binary": the control-byte sweep ' +
        'would then read every asset as source and go red on bytes nobody authored, and an ' +
        'inverse caller would silently see no assets at all.',
      { cause: error },
    )
  }
  // `-z` prints flat NUL-terminated triples: path, attribute name, value. `set` is the only
  // value that means the declaration applies — `unspecified` and `unset` both leave the file
  // in the sweep, which is the direction that fails safe.
  const fields = stdout.split(SEPARATOR)
  const declared = new Set()
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 2] === 'set') declared.add(join(cwd, fields[index]))
  }
  return declared
}

/**
 * Every file git tracks EXCEPT the ones `.gitattributes` declares binary.
 *
 * The scope of the control-byte guards. `trackedFiles()` stays the broader primitive and keeps
 * its ten-odd other callers — a label sweep reading a PNG finds nothing and costs nothing — so
 * only the byte guards, for which an asset is a false positive rather than a waste, narrow.
 *
 * FAIL CLOSED once more: if the filter empties the list, something is wrong with the
 * declaration rather than with the repo, and a guard sweeping nothing passes vacuously.
 *
 * @param {{cwd?: string}} [options] `cwd` — the tree to enumerate, default RALPH_HOME.
 * @returns {string[]} absolute paths, one per tracked text file.
 */
export function textFiles({ cwd = RALPH_HOME } = {}) {
  const tracked = trackedFiles({ cwd })
  const binary = declaredBinaryFiles({ cwd, files: tracked })
  const text = tracked.filter((file) => !binary.has(file))
  if (text.length === 0) {
    throw new Error(
      `Every one of the ${tracked.length} files git tracks in ${cwd} is declared binary in ` +
        '.gitattributes. Refusing to report a clean sweep over an empty list.',
    )
  }
  return text
}

/**
 * Every occurrence of one of `codes` in `files`, as `path:line: Nx U+XXXX`.
 *
 * The path and line are the whole value of this over a bare count: the byte is invisible in
 * the output of every tool that would otherwise print it, so the report has to say exactly
 * where to look. It deliberately never echoes the offending line — that would move the
 * problem into the failure output, and for an ESC would recolour the reader's terminal.
 *
 * Splitting on LF is safe: LF is not in the scanned class. A CR-only file therefore reports
 * every hit at line 1 — detection is unaffected, only the coordinate degrades, and no file
 * here uses those endings.
 *
 * `base` IS AN ARGUMENT AND NOT A CONSTANT because a report's whole job is to name a
 * coordinate the reader can act on, and where the reader is standing is the caller's
 * knowledge, not this module's. The guard sweeps the repository and wants `lib/paths.js:12`,
 * so RALPH_HOME is the default. A caller sweeping a throwaway fixture tree under os.tmpdir()
 * wants `nested/deep/leaf.js:3`; with RALPH_HOME hardcoded it instead got a `../../..` prefix
 * computed from a directory it does not care about, and had to rebuild that same prefix in
 * order to strip it back off again — a wrapper, a second module-level variable to hold the
 * prefix, and a beforeAll to populate it, all to undo a decision made here.
 *
 * @param {string[]} files absolute paths to read.
 * @param {Iterable<number>} codes the code points to report.
 * @param {{base?: string}} [options] `base` — hits are named relative to it, default RALPH_HOME.
 * @returns {string[]} one entry per (file, line, code), in walk order.
 */
export function offenders(files, codes, { base = RALPH_HOME } = {}) {
  const wanted = new Set(codes)
  const hits = []
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const perCode = new Map()
        for (const char of line) {
          const code = char.codePointAt(0)
          if (wanted.has(code)) perCode.set(code, (perCode.get(code) ?? 0) + 1)
        }
        for (const [code, count] of perCode) {
          hits.push(`${relative(base, file)}:${index + 1}: ${count}x ${codePointName(code)}`)
        }
      })
  }
  return hits
}

/**
 * The remedy line, so all three failures say the same thing about how to fix them.
 *
 * `String.fromCharCode` is the idiom the repo already documents; a backslash-u escape is the
 * other legal spelling and is what most of the re-spelled fixtures use. Both are
 * byte-identical to the raw byte at runtime — in a string literal, a template literal and a
 * regex literal alike — which is what makes the convention a way out rather than a rescope.
 */
export const HOW_TO_FIX = (code) =>
  `Re-spell it as \`\\u${hex(code)}\` or \`String.fromCharCode(${code})\` — ` +
  'byte-identical at runtime, searchable on disk.'
