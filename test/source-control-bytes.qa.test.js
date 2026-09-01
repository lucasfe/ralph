import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { RALPH_HOME } from '../lib/paths.js'
import { codeWithCommentsBlanked } from './helpers/source-code.js'
import {
  CONTROL_CODES,
  ESC_CODE,
  NUL_CODE,
  OTHER_CONTROL_CODES,
  declaredBinaryFiles,
  offenders,
  textFiles,
  trackedFiles,
} from './helpers/source-control-bytes.js'

// #107 QA augmentation. The dev's test/source-control-bytes.test.js asserts that the
// repo carries no raw NUL in a text file, no raw ESC in a .js file and no other raw
// C0/DEL byte in a .js file — and that the walk reaches a handful of named paths,
// scans itself, and partitions the byte class into three disjoint sets.
//
// WHAT THAT GREEN CANNOT DISTINGUISH. Every one of those assertions is of the shape
// "the offender list is empty", and an empty list is exactly what you also get from a
// detector that never fires: a matcher whose character set is wrong, a walk that
// returns nothing, a `readFileSync` whose result is dropped on the floor. The dev's
// suite proves TODAY'S REPO IS CLEAN. It does not prove the thing the issue actually
// buys — that TOMORROW'S raw byte fails the suite. #107 exists because the convention
// was written down twice and violated twice; a guard that cannot fire would leave it
// violated a third time, silently, and every test in the dev's file would still be
// green. So the first and largest section below plants offenders and demands they be
// found, by name, with the right line and the right count.
//
// THE DETECTOR IS IMPORTED, NOT COPIED. `offenders`, `trackedFiles` and the byte class live
// in test/helpers/source-control-bytes.js, which the guard imports too — so this file drives
// the exact code that runs in the guard, and a copy of the matcher here (which would prove
// only that the copy works) is impossible by construction. That module exists for this
// reason, alongside env-surface.js and doc-guard.js, which solve the same problem for the
// env surface and the docs guards.
//
// WHERE THE FIXTURES LIVE. Under os.tmpdir(), never inside RALPH_HOME: a fixture tree
// full of raw control bytes committed anywhere under the repo would make the dev's
// guard permanently red, which is the one way to guarantee it gets deleted. The temp
// root is asserted to be outside RALPH_HOME before a byte is written to it.
//
// AND THIS FILE ITSELF contains no raw control byte. Every one is built from its code
// point via `byte()`, the convention lib/commands/doctor.identity-box.test.js documents.
// The dev's guard scans this file too, and would catch a lapse here — which is the
// property working, not a coincidence worth relying on.

const GUARD_REL = 'test/source-control-bytes.test.js'
const HELPER_REL = 'test/helpers/source-control-bytes.js'
const source = (rel) => readFileSync(join(RALPH_HOME, rel), 'utf8')

// The swept-file list, read once. `textFiles()` shells out to `git ls-files` and then to `git
// check-attr`, and three of the sections below want the same answer from it; the guard computes
// its own the same way at its own module top level. Eager rather than lazy on purpose, for the
// same reason the helper throws instead of returning nothing: if git cannot answer, this file
// must die loudly at collection time rather than quietly assert things about a shorter list.
//
// `textFiles()` AND NOT `trackedFiles()`, because this file must mirror the guard's scope or it
// stops driving the code that actually runs. `trackedFiles` is still imported: the fail-closed
// and scope-depth sections below assert on the broader primitive directly, which is the level
// their claims are about.
const TRACKED = textFiles()
const TRACKED_JS = TRACKED.filter((file) => file.endsWith('.js'))

// ---------------------------------------------------------------------------
// Bytes, built rather than typed
// ---------------------------------------------------------------------------

// Only the bytes a fixture below actually feeds in are named. The rest of the class is
// reached through `byte(code)` inside the loop that walks CONTROL_CODES, which is the point:
// a per-byte constant for each of the thirty would be a second, hand-maintained copy of the
// class, and the one assertion that matters is the loop that covers all of it.
const byte = (code) => String.fromCharCode(code)
const NUL = byte(0x00)
const ESC = byte(0x1b)
const TAB = byte(0x09)
const CR = byte(0x0d)

// Deliberately a SECOND spelling of the guard's own `codePointName`, so a bug in its hex
// formatter (a missing pad, a lowercase digit) shows up as a mismatch rather than being
// reproduced identically on both sides of the assertion.
const named = (code) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`

// ---------------------------------------------------------------------------
// The fixture tree
// ---------------------------------------------------------------------------

let TMP_ROOT = ''

beforeAll(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), 'ralph-qa107-'))
})

afterAll(() => {
  if (TMP_ROOT) rmSync(TMP_ROOT, { recursive: true, force: true })
})

/** Write a fixture (string or Buffer) at `rel` under the temp root, creating parents. */
function fixture(rel, contents) {
  const full = join(TMP_ROOT, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents)
  return full
}

/**
 * A real, throwaway git repository under the temp root, with `files` written and staged.
 *
 * WHY A REPOSITORY AND NOT A PLAIN DIRECTORY. The scope rule under test IS `git ls-files`, so
 * a question about scope can only be answered by git. Handing `offenders()` a list of fixture
 * paths directly — which it accepts, and which every test in the first section above does —
 * proves the detector reads the files it is given, and says nothing whatsoever about WHICH
 * files it is given. The predecessor of the scope section below walked the filesystem and
 * skipped directories by name, so a plain tree was a fair fixture for it; it is not a fair
 * fixture for a rule expressed in git's own terms.
 *
 * Staged, not committed: `ls-files` reports the INDEX, so `git add` is the whole ceremony —
 * which also avoids needing a `user.email` on the machine running the suite.
 *
 * The global and system config are cut out with git's own documented escape hatch. A
 * developer's `core.excludesFile` (this machine has one, and it excludes a path repo-wide)
 * would otherwise get a vote on what these fixtures track, and the verdict below would depend
 * on whose laptop it ran on.
 *
 * @param {string} name subdirectory of the temp root to build the repository in.
 * @param {Record<string, string>} files relative path → contents, parents created.
 * @param {{force?: string[]}} [options] `force` — paths to `git add -f` past .gitignore.
 * @returns {string} the repository root.
 */
function repoFixture(name, files, { force = [] } = {}) {
  const root = join(TMP_ROOT, name)
  mkdirSync(root, { recursive: true })
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  git('init', '-q')
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  git('add', '-A')
  for (const path of force) git('add', '-f', path)
  return root
}

/**
 * The dev's detector over one fixture path — or over a whole list of them.
 *
 * The reporter names each hit relative to a base the CALLER picks, so a fixture hit arrives as
 * `nested/deep/leaf.js:3: 1x U+0000`: the exact string a maintainer would have to act on, and
 * the reason every assertion below is readable. That base used to be hardcoded to RALPH_HOME,
 * which meant a temp-tree hit came back with a long `../../..` prefix and this file needed a
 * module-level variable holding that same prefix, a beforeAll to compute it, and a wrapper to
 * strip it off again — three pieces of machinery to undo one decision. `offenders()` takes
 * `{ base }` now and all three are gone.
 *
 * `[].concat` is the one convenience left, because most callers below hold a single path while
 * a couple hold a tracked list.
 */
const scan = (paths, codes) => offenders([].concat(paths), codes, { base: TMP_ROOT })
const scanAll = (paths) => scan(paths, CONTROL_CODES)

describe('QA #107 — the detector fires (an empty offender list is not evidence)', () => {
  it('drives the guard’s own detector, not a copy of it', () => {
    expect(typeof offenders).toBe('function')
    expect(typeof trackedFiles).toBe('function')
    // "The same detector" is not this file's word for it: the guard is read here and must be
    // importing the identical module. Without this, a future edit could give the guard a
    // private copy and every test below would keep passing against the abandoned one.
    expect(source(GUARD_REL)).toContain("from './helpers/source-control-bytes.js'")
    expect(existsSync(join(RALPH_HOME, HELPER_REL))).toBe(true)
    // And the fixtures cannot land anywhere the guard would later scan for real.
    expect(TMP_ROOT.startsWith(RALPH_HOME)).toBe(false)
    expect(relative(RALPH_HOME, TMP_ROOT).startsWith('..')).toBe(true)
  })

  it('REFUSES to sweep a tree git cannot answer for, instead of sweeping nothing', () => {
    // This is the assertion that earns this file its title. Every assertion in the guard has
    // the shape "the offender list is empty", so the thing standing between a green suite and
    // a green suite that checked NOTHING is `trackedFiles()`' two throws: one for git failing,
    // one for git succeeding with an empty answer. Both are documented as FAIL CLOSED in the
    // helper — and until now neither had a test, which makes "fail closed" a comment rather
    // than a property. Neither branch is reachable from inside this repository (git works here
    // and tracks hundreds of files), so each needs a tree of its own, which is exactly what
    // `cwd` being injectable is for.
    //
    // Branch one: not a repository at all. Also the shape of a missing or broken git, a
    // corrupt index, and a `cwd` that no longer exists — every one of them arrives here as a
    // non-zero exit from the same call.
    const notARepo = join(TMP_ROOT, 'not-a-repo')
    mkdirSync(notARepo, { recursive: true })
    expect(() => trackedFiles({ cwd: notARepo })).toThrow(/Could not list the files git tracks/)
    // And the error carries the REASON it refuses rather than just the failure, because the
    // tempting fix on reading "git failed" is a fallback to a directory walk.
    expect(() => trackedFiles({ cwd: notARepo })).toThrow(/pass vacuously/)

    // Branch two is the nastier one: a real repository whose index is empty. git exits 0 and
    // prints nothing, so there is no error to notice — the only evidence is the length of the
    // list, and a sweep over a zero-length list reports a clean repo. A fresh `git init`
    // produces it, and so does a checkout whose index did not survive.
    const emptyRepo = repoFixture('empty-index', {})
    expect(readdirSync(emptyRepo)).toEqual(['.git'])
    expect(() => trackedFiles({ cwd: emptyRepo })).toThrow(/tracks no files/)
    expect(() => trackedFiles({ cwd: emptyRepo })).toThrow(/Refusing to report a clean sweep/)
  })

  it('finds EVERY code in the scanned class, with the right line and the right count', () => {
    // The whole class, one code at a time, rather than the three the issue happened to
    // name. A matcher that had lost a range — an off-by-one on 0x1F, a `<` for a `<=`,
    // TAB's exclusion widened by a byte — passes the dev's suite unchanged, because the
    // repo is clean either way. This is the assertion that cannot be satisfied by a
    // detector that does not work.
    const wrong = []
    for (const code of CONTROL_CODES) {
      const path = fixture(`every-code/c${code}.js`, `first line\nx${byte(code)}y\n`)
      const hits = scanAll(path)
      const want = [`every-code/c${code}.js:2: 1x ${named(code)}`]
      if (JSON.stringify(hits) !== JSON.stringify(want)) wrong.push({ code, want, got: hits })
    }
    expect(wrong, `codes the detector did not report exactly:\n${JSON.stringify(wrong, null, 2)}`)
      .toEqual([])
    // Fail-closed: an empty CONTROL_CODES would make the loop above vacuously green.
    expect(CONTROL_CODES.length).toBe(30)
  })

  it('reaches a byte buried in a nested subdirectory, which is where one would hide', () => {
    // #107's two unsearchable files were three and one levels down. The recursion that used
    // to be the guard's own is now git's — `git ls-files` lists every tracked path at every
    // depth, with no root list to forget one — so what is left to pin is that a deep path
    // survives the report intact, and that the real set is not secretly shallow.
    const path = fixture('nested/a/b/c/d/leaf.js', `one\ntwo\nthr${NUL}ee\n`)
    expect(scan(path, [NUL_CODE])).toEqual(['nested/a/b/c/d/leaf.js:3: 1x U+0000'])

    const rels = trackedFiles().map((f) => relative(RALPH_HOME, f))
    expect(Math.max(...rels.map((r) => r.split('/').length))).toBeGreaterThanOrEqual(3)
    expect(rels).toContain('lib/commands/start.launch-box.qa.test.js')
    expect(rels).toContain('test/setup/hermetic-env.js')
    expect(rels).toContain('.github/workflows/ci.yml')
  })

  it('counts repeats on one line, and says how many', () => {
    // `3x` is not decoration: it is how a maintainer knows whether they fixed all of them.
    const path = fixture('counting/three.js', `clean\n${NUL}${NUL}${NUL}\n`)
    expect(scan(path, [NUL_CODE])).toEqual(['counting/three.js:2: 3x U+0000'])
  })

  it('reports two distinct codes on one line as two findings, not one', () => {
    // The three sweeps own disjoint sets, so a line carrying both a NUL and an ESC has to
    // surface in both — collapsing them into a single "there is a byte here" would hide
    // one of the two harms the issue distinguishes.
    const path = fixture('two-codes/mixed.js', `clean\na${ESC}b${NUL}c${ESC}d\n`)
    expect(scanAll(path).sort()).toEqual([
      'two-codes/mixed.js:2: 1x U+0000',
      'two-codes/mixed.js:2: 2x U+001B',
    ])
    expect(scan(path, [NUL_CODE])).toEqual(['two-codes/mixed.js:2: 1x U+0000'])
    expect(scan(path, [ESC_CODE])).toEqual(['two-codes/mixed.js:2: 2x U+001B'])
    expect(scan(path, OTHER_CONTROL_CODES)).toEqual([])
  })

  it('names ONLY the offending line, and repeats itself once per offending line', () => {
    const one = fixture(
      'lines/one-of-ten.js',
      `${['a', 'b', 'c', 'd', 'e', `f${NUL}`, 'g', 'h', 'i', 'j'].join('\n')}\n`,
    )
    expect(scanAll(one)).toEqual(['lines/one-of-ten.js:6: 1x U+0000'])
    const several = fixture('lines/three-of-five.js', `a${NUL}\nb\nc${NUL}\nd\ne${NUL}\n`)
    expect(scanAll(several)).toEqual([
      'lines/three-of-five.js:1: 1x U+0000',
      'lines/three-of-five.js:3: 1x U+0000',
      'lines/three-of-five.js:5: 1x U+0000',
    ])
  })

  it('does NOT fire on the escaped spelling — which is the entire premise of the fix', () => {
    // If the detector matched the six characters `\u0000` as well as the byte, then #107's
    // re-spelling would have swapped one red for another and the whole change would be
    // incoherent. This is the false-positive half of the property, and it is the half that
    // says the repo's convention is actually a way OUT.
    const path = fixture(
      'escaped/spellings.js',
      [
        "const a = '\\u0000'",
        "const b = '\\u001B'",
        'const c = String.fromCharCode(27)',
        "const d = '\\x1b\\x00\\x7f'",
        'const sgr = new RegExp(`${String.fromCharCode(27)}\\\\[[0-9;]*m`)',
        '',
      ].join('\n'),
    )
    expect(scanAll(path)).toEqual([])
  })

  it('never echoes the file’s contents, and never re-emits the byte it is reporting', () => {
    // A report that printed the offending line would move the problem into the test output,
    // where the byte is invisible again — and, for an ESC, would recolour the terminal of
    // whoever is reading the failure.
    const secret = 'CONTENTS_THAT_MUST_NOT_APPEAR'
    const path = fixture('leak/report.js', `${secret}${ESC}[31m${secret}\n`)
    const hits = scanAll(path)
    expect(hits).toEqual(['leak/report.js:1: 1x U+001B'])
    const joined = hits.join('\n')
    expect(joined).not.toContain(secret)
    for (const code of CONTROL_CODES) expect(joined).not.toContain(byte(code))
  })
})

describe('QA #107 — the exclusions, and the line splitter they lean on', () => {
  it('leaves TAB, LF and CR alone, on purpose', () => {
    // The set-level version of this — that no textual code is IN the scanned class — is
    // already asserted in the guard's partition test, so what is added here is the behaviour:
    // a real file carrying all three produces no hit.
    const path = fixture('textual/ordinary.js', `a${TAB}b\r\nc\n`)
    expect(scanAll(path)).toEqual([])
  })

  it('still catches a byte wedged BETWEEN two tabs — the exclusion is per byte, not per line', () => {
    // The one way a TAB exclusion could go wrong: a line-level rather than byte-level
    // skip, i.e. "this line has legitimate whitespace, move on".
    const path = fixture('textual/near-tab.js', `header\nvalue${TAB}${NUL}${TAB}more\n`)
    expect(scanAll(path)).toEqual(['textual/near-tab.js:2: 1x U+0000'])
  })

  it('gets the line number right in a CRLF file, where every line ends in a leftover CR', () => {
    // Splitting on '\n' leaves a trailing '\r' on each line. Harmless — CR is not in the
    // scanned set — but it is the reason this is worth pinning rather than assuming.
    const path = fixture('endings/crlf.js', `one\r\ntwo\r\nthr${NUL}ee\r\nfour\r\n`)
    expect(scanAll(path)).toEqual(['endings/crlf.js:3: 1x U+0000'])
  })

  it('finds a byte on the last line of a file with no trailing newline', () => {
    const path = fixture('endings/no-eol.js', `one\ntwo\nthree${NUL}`)
    expect(scanAll(path)).toEqual(['endings/no-eol.js:3: 1x U+0000'])
  })

  it('DOCUMENTS the CR-only case: the byte is still found, the line number collapses to 1', () => {
    // A classic-Mac file has no LF at all, so `split('\n')` yields one line and every hit
    // is reported at :1 regardless of where it visually sits. DETECTION is unaffected,
    // which is the property the issue buys; only the coordinate in the report degrades.
    // Pinned rather than fixed because no file in this repo uses CR-only endings (git's
    // own tooling would fight it), and a splitter that also broke on lone CR would have to
    // decide what a CRLF file's line numbers mean. If a CR-only file ever lands here, this
    // test is the note explaining why the line number lies.
    const path = fixture('endings/cr-only.js', `one${CR}two${CR}thr${NUL}ee${CR}four`)
    expect(scanAll(path)).toEqual(['endings/cr-only.js:1: 1x U+0000'])
  })

  it('handles the degenerate files: empty, and nothing but the byte', () => {
    expect(scanAll(fixture('degenerate/empty.js', ''))).toEqual([])
    expect(scanAll(fixture('degenerate/only.js', NUL))).toEqual([
      'degenerate/only.js:1: 1x U+0000',
    ])
  })

  it('counts code POINTS correctly around astral characters and lone surrogates', () => {
    // `for (const char of line)` iterates code points and `codePointAt(0)` reads the whole
    // one, so an emoji is one iteration of a two-unit character. A `for (let i = 0; …)`
    // over `charCodeAt` would agree on the count here but would also have to survive the
    // surrogate halves; neither may be mistaken for a control byte, and neither may shift
    // the count of a real one beside it.
    expect(scanAll(fixture('unicode/astral-clean.js', 'x\u{1F600}y\n'))).toEqual([])
    expect(scanAll(fixture('unicode/surrogate-clean.js', 'x\uD800y\n'))).toEqual([])
    expect(scanAll(fixture('unicode/astral-near.js', `a\nx\u{1F600}${NUL}\u{1F600}y\n`))).toEqual([
      'unicode/astral-near.js:2: 1x U+0000',
    ])
    expect(scanAll(fixture('unicode/surrogate-near.js', `a\nx\uD800${NUL}y\n`))).toEqual([
      'unicode/surrogate-near.js:2: 1x U+0000',
    ])
  })
})

describe('QA #107 — a byte trying to hide inside a broken encoding', () => {
  // The guard reads with `readFileSync(file, 'utf8')`, so what it scans is the DECODED
  // string, not the bytes on disk. Invalid sequences decode to U+FFFD, and the question
  // that matters is whether a control byte can be swallowed into one of those replacements
  // and disappear from the scan. It cannot: 0x00 and 0x1B are both below 0x80, so neither
  // can ever be a UTF-8 continuation byte, which means each one always terminates whatever
  // broken sequence precedes it and is decoded on its own.
  const TRUNCATED = {
    'a 2-byte lead with nothing after it': [0xc2],
    'a 3-byte sequence one byte short': [0xe0, 0xa0],
    'a 4-byte sequence one byte short': [0xf0, 0x9f, 0x98],
    'a byte that is never legal UTF-8': [0xff],
    'a stray continuation byte': [0x80],
  }

  for (const [label, lead] of Object.entries(TRUNCATED)) {
    it(`still finds a raw NUL and a raw ESC directly after ${label}`, () => {
      for (const code of [0x00, 0x1b]) {
        const slug = `${label.replace(/\W+/g, '-')}-${code}`
        const path = fixture(
          `encoding/${slug}.js`,
          Buffer.from([0x61, 0x0a, ...lead, code, 0x62, 0x0a]),
        )
        expect(readFileSync(path, 'utf8')).toContain('�')
        expect(scanAll(path)).toEqual([`encoding/${slug}.js:2: 1x ${named(code)}`])
      }
    })
  }

  it('finds a NUL that follows a UTF-8 BOM', () => {
    const path = fixture('encoding/bom.js', Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a, 0x00, 0x0a]))
    expect(scanAll(path)).toEqual(['encoding/bom.js:2: 1x U+0000'])
  })

  it('DOCUMENTS the overlong-NUL boundary, and why it is not a hole in either promise', () => {
    // Modified UTF-8 spells NUL as C0 80. Node decodes that pair as two U+FFFD, so the
    // scan sees no U+0000 and reports nothing — the one input where a "NUL" survives.
    // It is out of scope on purpose, and not by luck:
    //   * grep is not deceived. The file contains no 0x00 byte, so the rule that took
    //     #107's two test files out of `grep`/`rg`/`git grep` never fires.
    //   * `file` still calls it text (measured: "Non-ISO extended-ASCII text"), so
    //     criterion 1 holds too.
    // What is left is a mojibake defect, not a searchability one, and nothing in this repo
    // has any reason to emit those bytes. Pinned so the boundary is a decision on record
    // rather than an assumption.
    const path = fixture('encoding/overlong.js', Buffer.from([0x61, 0x0a, 0xc0, 0x80, 0x62, 0x0a]))
    expect([...readFileSync(path, 'utf8')].map((c) => c.codePointAt(0))).not.toContain(0x00)
    expect(scanAll(path)).toEqual([])
    expect(readFileSync(path).includes(0x00)).toBe(false)
  })
})

describe('QA #107 — the walk on a filesystem that is not being helpful', () => {
  it('follows a symlink and scans what it points at, even outside the scanned tree', () => {
    // `readFileSync` follows, which is the upside: a byte cannot be hidden behind an
    // indirection. Handed the link, the detector reports the link's path and the target's
    // contents — the coordinate a maintainer can act on.
    const target = fixture('symlink/outside/target.js', `a${ESC}b\n`)
    mkdirSync(join(TMP_ROOT, 'symlink', 'tree'), { recursive: true })
    const link = join(TMP_ROOT, 'symlink', 'tree', 'link.js')
    symlinkSync(target, link)
    expect(scanAll(link)).toEqual(['symlink/tree/link.js:1: 1x U+001B'])
  })

  it('DOCUMENTS the downside: a dangling symlink, a vanished or an unreadable file throws', () => {
    // `readFileSync` follows, so a DANGLING link is an ENOENT out of the read — and because
    // the file list is built at the guard's module top level, that surfaces as a collection
    // error on all of its tests rather than as one clean failure. Same for a file that
    // disappears between listing and reading, and for one the process cannot open.
    //
    // NOT rewritten into a passing behaviour, and not reported as a defect: no tracked file
    // is a symlink today (asserted below), the throw is LOUD rather than silent — which is
    // the opposite of the failure mode #107 is about — and swallowing an unreadable file
    // would mean reporting a clean sweep over a file nobody read. This test is the record of
    // the trade, so the next person meets it as a decision.
    //
    // A TRACKED SUBMODULE is the same trade, and worth naming because it is the one entry git
    // reports that is not a file at all. A gitlink appears in `git ls-files` as a single path
    // whose working-tree entry is a DIRECTORY, so `readFileSync` on it raises EISDIR — again at
    // collection time, again killing every guard test with a bare errno and no sentence saying
    // why. Left as a trade rather than handled, for the same reasons plus one more: this repo
    // has no submodule and no .gitmodules, so the skip would be code written for a case that
    // cannot occur, pinned by a test that could only assert the case stays absent. If one ever
    // lands, the fix belongs in `trackedFiles()` as a filter (a gitlink is out of scope because
    // it is another repository's source, and that repository's own guard is what should be
    // reading it) and NOT as a try/catch in `offenders()`, which would also swallow the
    // unreadable-file case above and report a clean sweep over a file nobody read.
    //
    // One hazard the tracked-files rule DELETED rather than documented: a symlink cycle. The
    // old shape recursed with readdirSync, so a link pointing at its own parent grew the path
    // one segment per hop until the kernel said ELOOP. There is no recursion left — git
    // enumerates, and nothing here descends — so the case cannot arise.
    const broken = join(TMP_ROOT, 'hostile-broken')
    mkdirSync(broken, { recursive: true })
    const dangling = join(broken, 'dangling.js')
    symlinkSync(join(TMP_ROOT, 'nothing-is-here'), dangling)
    expect(() => offenders([dangling], CONTROL_CODES)).toThrow(/ENOENT/)

    const vanished = fixture('hostile-gone/gone.js', 'x\n')
    rmSync(vanished)
    expect(() => offenders([vanished], CONTROL_CODES)).toThrow(/ENOENT/)

    // Skipped where the suite may be running as root, which can read anything.
    if (process.getuid?.() !== 0) {
      const locked = fixture('hostile-perm/locked.js', 'x\n')
      chmodSync(locked, 0o000)
      try {
        expect(() => offenders([locked], CONTROL_CODES)).toThrow(/EACCES|EPERM/)
      } finally {
        chmodSync(locked, 0o644)
      }
    }
  })

  it('no TRACKED file is a symlink, which is what makes the above theoretical', () => {
    // git tracks symlinks as symlinks, so one CAN be committed — and then the read above
    // follows it. Cheaper to assert the absence than to make the detector cope.
    const links = trackedFiles()
      .filter((file) => lstatSync(file).isSymbolicLink())
      .map((file) => relative(RALPH_HOME, file))
    expect(
      links,
      'A symlink was committed. The sweep reads through it: if it dangles, every ' +
        'control-byte assertion dies with a bare ENOENT at collection time instead of ' +
        'failing cleanly. Decide before merging.',
    ).toEqual([])
  })
})

describe('QA #107 — the guard’s scope over the real repo, and whether it can shrink', () => {
  it('skips the vendored trees at ANY depth, not just at the root', () => {
    // The predecessor of this test matched a directory by its bare NAME
    // (`SKIPPED_DIRS.has(entry)`), which excluded a nested node_modules/ for the same reason
    // it excluded a root one — and silently excluded a legitimately-authored `logs/` deep in
    // the tree along with it. That second half was a real cost, documented as such, and it is
    // why the design moved: the scope rule is now "what git tracks", so depth is not a
    // special case at all (git decides per path) and the exclusion comes from a pattern in
    // .gitignore rather than from a name a test file happens to know.
    //
    // Both halves are pinned against a real repository, because neither is visible in this
    // one. ralph has no vendored tree nested under a tracked directory, and the dev's
    // UNTRACKED_TREES assertion can only speak about node_modules/ and .git/ AT THE ROOT —
    // the two a fresh checkout is guaranteed to have, which is as far as an assertion that
    // borrows the working tree is allowed to reach. What it structurally cannot distinguish is
    // whether depth is what saves it, or whether the rule is the path's shape or the tracking.
    // This test owns that question, which is why it BUILDS its .gitignore and its vendored
    // trees instead of hoping to find them.
    const root = repoFixture(
      'scope-depth',
      {
        '.gitignore': 'node_modules/\nlogs/\n',
        'pkg/node_modules/dep/index.js': `vendored${NUL}\n`,
        'pkg/logs/captured.js': `captured${NUL}\n`,
        'pkg/logs/kept.js': `authored${NUL}\n`,
        'pkg/src/real.js': `authored${NUL}\n`,
      },
      // Force-added past the `logs/` pattern. No name-based skip list can express this file:
      // its directory is spelled exactly like an excluded one and it is in scope anyway,
      // because tracking — not the path — is the rule. This is the half the old design got
      // wrong, so it is the half worth asserting.
      { force: ['pkg/logs/kept.js'] },
    )
    const tracked = trackedFiles({ cwd: root })
    expect(tracked.map((file) => relative(root, file)).sort()).toEqual([
      '.gitignore',
      'pkg/logs/kept.js',
      'pkg/src/real.js',
    ])
    // And the sweep over that list names the two authored files at their real depth. The
    // vendored ones never reach it — each one carries a NUL that would have been reported.
    expect(scan(tracked, [NUL_CODE]).sort()).toEqual([
      'scope-depth/pkg/logs/kept.js:1: 1x U+0000',
      'scope-depth/pkg/src/real.js:1: 1x U+0000',
    ])
  })

  it('needs no edit to cover a brand-new directory — the scope is a rule, not a root list', () => {
    // The sibling guard in lib/i18n-portuguese-leakage.qa.test.js scopes itself with a
    // hardcoded `ROOTS = ['lib', 'bin', 'templates']`, which is exactly the shape that lets a
    // new top-level directory arrive uncovered — and it already has: test/, scripts/, docs/
    // and .github/ all sit outside that list. #107's guard has no root list at all, and this
    // is the difference asserted rather than assumed.
    //
    // Half one, in a repository of its own: a top-level directory nobody declared, and a file
    // five levels beneath another one, are both in scope the moment they are staged. Nothing
    // anywhere was edited to make that happen — which is the whole claim.
    const root = repoFixture('newcomer', {
      'a-directory-nobody-declared/new.js': `x${NUL}\n`,
      'another/a/b/c/d/deep.js': `y${NUL}\n`,
    })
    expect(scan(trackedFiles({ cwd: root }), [NUL_CODE]).sort()).toEqual([
      'newcomer/a-directory-nobody-declared/new.js:1: 1x U+0000',
      'newcomer/another/a/b/c/d/deep.js:1: 1x U+0000',
    ])

    // Half two, in the real repo: the sweep reaches every root the i18n guard names, the four
    // it cannot, and the repository root's own files — package.json, README.md, vitest.config.js
    // — which no `ROOTS` list would have thought to include in the first place. Written as a
    // set of requirements rather than as an equality precisely because the scope is not
    // enumerable in advance: the day a ninth top-level directory lands, this needs no edit
    // either, and that is the property.
    const roots = new Set(
      TRACKED.map((file) => relative(RALPH_HOME, file)).map((r) =>
        r.includes('/') ? `${r.slice(0, r.indexOf('/'))}/` : '(repository root)',
      ),
    )
    for (const required of [
      'lib/',
      'bin/',
      'templates/',
      'test/',
      'scripts/',
      'docs/',
      '.github/',
      '(repository root)',
    ]) {
      expect(
        roots.has(required),
        `${required} is in the repo but contributed nothing to the sweep`,
      ).toBe(true)
    }
    // The contrast drawn above is a claim about ANOTHER file, so it is read rather than
    // asserted from memory. If the i18n guard ever grows a rule-based scope of its own, this
    // paragraph stops being true and should be rewritten instead of left as folklore.
    expect(
      source('lib/i18n-portuguese-leakage.qa.test.js'),
      'DELIBERATE COUPLING, and it has just done its job. The paragraph above contrasts ' +
        "#107's rule-based scope with that sibling guard's hardcoded `ROOTS` list, and the " +
        'contrast no longer holds. Widening or replacing that list is an IMPROVEMENT, not a ' +
        'regression: the response is to rewrite the paragraph above to say what the sibling ' +
        'now does and then update or delete this assertion — not to delete the paragraph and ' +
        'leave a claim about another file standing as folklore.',
    ).toContain("const ROOTS = ['lib', 'bin', 'templates']")
  })

  it('finds exactly the .js files an INDEPENDENT walk finds — the count check is too weak alone', () => {
    // The dev's sanity assertion is `toBeGreaterThan(100)`, and lib/ alone holds more than
    // twice that (asserted below). So a refactor that narrowed the scope to lib/ would keep
    // that assertion green and quietly stop scanning bin/, templates/, test/ and the repo
    // root — including the very file the guard is supposed to scan itself in. A set comparison
    // against an oracle written from scratch here is what actually pins it.
    //
    // THE ORACLE HAD TO CHANGE WITH THE DESIGN, and how it changed is the interesting part.
    // While the scope was a filesystem walk with a skip list, an independently-written
    // filesystem walk with the same skip list was a fair second opinion. The scope is now
    // `git ls-files`, so re-running `git ls-files` here would compare the design to itself and
    // prove nothing. What is written below instead is a real readdir walk of the working tree
    // — dirent types rather than statSync, as before — reconciled against git's OTHER answers
    // about the same tree:
    //   * `ls-files --others --ignored --directory` says which trees git excludes, so the walk
    //     does not have to know that node_modules/ or logs/ are special. It also picks up a
    //     developer's machine-local excludesFile, which a hardcoded list never would.
    //   * `ls-files --others` says which files are on disk but not staged. That is the one
    //     legitimate difference between "present" and "tracked", and subtracting it is what
    //     makes this an equality rather than a test that goes red the moment somebody has an
    //     unstaged scratch file.
    //   * `.git/` is skipped by name, because git reports its own directory as neither.
    // What is left has to match the guard's set exactly, in both directions.
    const SEPARATOR = String.fromCharCode(NUL_CODE)
    const gitPaths = (...args) =>
      execFileSync('git', args, { cwd: RALPH_HOME, encoding: 'utf8', maxBuffer: 1 << 26 })
        .split(SEPARATOR)
        .filter((entry) => entry !== '')
    // `--directory` collapses a wholly-excluded tree to one entry with a trailing slash, which
    // is why it is trimmed: the walk compares bare relative paths.
    const excluded = new Set(
      gitPaths('ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory').map(
        (path) => path.replace(/\/$/, ''),
      ),
    )
    const unstaged = new Set(gitPaths('ls-files', '-z', '--others', '--exclude-standard'))

    const mine = []
    const walkMine = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        const rel = relative(RALPH_HOME, full)
        if (rel === '.git' || excluded.has(rel) || unstaged.has(rel)) continue
        if (entry.isDirectory()) walkMine(full)
        else if (entry.name.endsWith('.js')) mine.push(rel)
      }
    }
    walkMine(RALPH_HOME)
    const theirs = TRACKED_JS.map((file) => relative(RALPH_HOME, file))
    expect(theirs.slice().sort()).toEqual(mine.slice().sort())
    expect(mine.length).toBeGreaterThan(200)

    // Why the threshold is decorative: lib/ on its own clears it.
    const libOnly = mine.filter((r) => r.startsWith('lib/'))
    expect(libOnly.length).toBeGreaterThan(100)

    // And the direction that stays true even if the equality above ever has to be relaxed on
    // some machine: no excluded tree contributed a single path to either side.
    for (const tree of ['node_modules', 'logs', '.git']) {
      expect(
        theirs.concat(mine).filter((r) => r === tree || r.startsWith(`${tree}/`)),
        `${tree}/ reached the .js sweep`,
      ).toEqual([])
    }
  })

  it('sweeps every tracked file except the ones .gitattributes DECLARES binary', () => {
    // THIS TEST HAS NOW BEEN RETARGETED TWICE, and the history is the argument. It began as
    // "no file kind is silently outside the sweep", when the sweep was extension-scoped — a
    // TEXT_FILE_RE plus a list of extensionless names — and froze the fact that no unlisted
    // kind existed yet. The sweep then went unscoped, reading every file git tracks, which
    // made that claim trivially true; so it was re-pointed at the cost of unscoping, namely
    // that the guard goes permanently red the day a genuine binary asset lands.
    //
    // THAT DAY CAME: three bug-report screenshots under .snap/bug-reports/. So the decision the
    // previous version demanded be made out loud has been made, and this is now the record of
    // WHICH way. The sweep is scoped again, but by DECLARATION rather than by extension or by
    // content, and the three assertions below are the three things that makes true.
    const kind = (file) => extname(file) || `(no extension: ${basename(file)})`

    // FIRST: the guard really reads the narrowed list, rather than being narrowed somewhere a
    // reader would not look. Pinned as source text because a sweep re-narrowed to a
    // `FILES.filter(...)` would still produce an empty offender list over a clean repo — no
    // assertion in the dev's file would notice, so the two lines it turns on are read instead.
    expect(source(GUARD_REL)).toContain('const FILES = textFiles()')
    expect(source(GUARD_REL)).toContain('offenders(FILES, [NUL_CODE])')

    // SECOND: the scope is a declaration, and NOT a content sniff. This is the load-bearing
    // one. git decides binary by looking for a NUL in the first 8000 bytes — precisely the byte
    // under guard — so a sniffing scope would let a .js file that acquired a NUL near the top
    // classify itself out of the sweep and carry its own offence away with it, which is #107's
    // own blind spot reached from the other side. Proven, not asserted about: a throwaway repo
    // gets a .js whose second byte is a NUL and no .gitattributes at all. git calls it binary;
    // `textFiles()` must still sweep it.
    const sniffRoot = mkdtempSync(join(TMP_ROOT, 'sniff-'))
    execFileSync('git', ['init', '-q'], { cwd: sniffRoot })
    const decoy = 'looks-like-source.js'
    writeFileSync(join(sniffRoot, decoy), `a${byte(NUL_CODE)}b = 1\n`)
    execFileSync('git', ['add', '-A'], { cwd: sniffRoot })
    const eol = execFileSync('git', ['ls-files', '--eol'], { cwd: sniffRoot, encoding: 'utf8' })
    expect(eol, 'the decoy is not a valid probe unless git itself calls it binary').toMatch(
      /w\/-text/,
    )
    expect(
      textFiles({ cwd: sniffRoot }).map((file) => relative(sniffRoot, file)),
      'a .js file with an early NUL classified ITSELF out of the sweep — the scope is sniffing ' +
        'content, and the offence it carries away is the exact byte #107 is about.',
    ).toEqual([decoy])
    expect(declaredBinaryFiles({ cwd: sniffRoot }).size).toBe(0)

    // THIRD: nothing leaves the sweep unnoticed, in either direction.
    //
    // (a) every file git considers binary is declared — so committing the next screenshot
    // without a .gitattributes line still fails, which is how "decide out loud" survives the
    // rescope. `ls-files --eol` is the oracle and a deliberately different implementation from
    // the check-attr the helper uses: git reads content, .gitattributes states intent, and the
    // two disagreeing is exactly the undeclared asset this catches. Only the `w/` (working
    // tree) column is read; `i/` reports the STAGED blob, which for a file with unstaged edits
    // answers a question about history rather than about what the sweep will read.
    const sniffedBinary = execFileSync('git', ['ls-files', '--eol'], {
      cwd: RALPH_HOME,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    })
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split('\t'))
      .filter(([columns]) => /(?:^|\s)w\/-text(?:\s|$)/.test(columns))
      .map(([, path]) => join(RALPH_HOME, path))
    const declared = declaredBinaryFiles()
    expect(
      sniffedBinary.filter((file) => !declared.has(file)).map((file) => relative(RALPH_HOME, file)),
      'A tracked file git considers BINARY is not declared `binary` in .gitattributes, so the ' +
        '#107 control-byte sweep is reading it as source and has gone red on bytes nobody ' +
        'authored. Decide out loud, as a reviewable line: either the asset does not belong in ' +
        'the repo, or its kind belongs in .gitattributes.',
    ).toEqual([])

    // (b) and the declaration may only ever cover assets. A `*.js binary` line would empty the
    // guard in one stroke while every assertion in it stayed green, so the escape hatch is
    // pinned shut against the kinds this repo's source actually uses.
    const SOURCE_KINDS = ['.js', '.md', '.json', '.sh', '.yml', '.yaml', '.example', '.txt']
    const escaped = [...declared].filter((file) => SOURCE_KINDS.includes(extname(file)))
    expect(
      escaped.map((file) => relative(RALPH_HOME, file)),
      '.gitattributes declares a SOURCE file binary, which removes it from the #107 sweep ' +
        'silently — every assertion in the guard stays green over the shorter list. An asset ' +
        'kind may leave the sweep; a source kind may not.',
    ).toEqual([])

    // FOURTH, unchanged from every earlier version: the breadth that makes the above worth
    // having. The sweep still spans every text kind the repo contains, not just JavaScript.
    const kinds = [...new Set(TRACKED.map(kind))].sort()
    expect(kinds).toContain('.js')
    expect(kinds).toContain('.md')
    expect(kinds).toContain('.json')
    expect(kinds).toContain('.sh')
    expect(kinds.length).toBeGreaterThanOrEqual(6)
    expect(kinds, 'a declared-binary kind is still reaching the sweep').not.toContain('.png')

    // And the .js sweeps are a subset of the NUL sweep, so no .js file is checked for ESC but
    // not for NUL. This is the assertion that catches the two lists drifting apart — and it is
    // no longer trivial, now that the NUL sweep is a filtered list rather than the whole one.
    const swept = new Set(TRACKED)
    expect(TRACKED_JS.filter((file) => !swept.has(file))).toEqual([])
  })

  it('carries no raw ESC or other control byte in the NON-.js tracked files either', () => {
    // Criterion 2 asks only about .js, and the guard delivers exactly that. But
    // templates/ralph.sh is shipped EXECUTABLE source with the same pager harm — cat it with
    // a raw ESC inside and the terminal takes the colour from that line on, exactly as for a
    // .js file. Extending the same sweep to the non-.js remainder costs nothing and is green
    // today, so it is asserted here rather than left as a gap for the next `.sh` edit. Not
    // counted in this comment on purpose: the number was right the day it was written and
    // wrong the next time a `.md` landed, and the floor below is deliberately loose anyway.
    //
    // "Non-.js tracked" is now the entire remainder — .md, .json, .yml, .sh, .example,
    // .gitignore, .npmignore — where this test previously had to lean on a list of extensions
    // somebody had decided to trust. Nothing is excluded to keep it green; it is green because
    // the repo tracks no binary asset, which the test above is the standing record of.
    const nonJs = TRACKED.filter((file) => !file.endsWith('.js'))
    expect(nonJs.length).toBeGreaterThan(20)
    const hits = offenders(nonJs, [ESC_CODE, ...OTHER_CONTROL_CODES])
    expect(
      hits,
      `Raw control byte in a non-.js text file. Same fix as for a .js file — spell it.\n${hits.join('\n')}`,
    ).toEqual([])
  })
})

describe('QA #107 — criterion 4: the re-spelling must not rot back', () => {
  // The guard catches a raw byte being ADDED. The mirror regression it structurally cannot
  // see is an escape being REMOVED from a pattern — and that one changes what a test means
  // rather than where it can be found, which is worse. This section is about that mirror.

  // Prose is not a pattern. A comment is free to QUOTE a broken stripper in order to
  // explain what a broken one looks like — the comment two screens down does exactly
  // that, and went red against its own sweep on the first run. Comments are therefore
  // masked before the sweep, with spaces rather than by deletion so that every line
  // number in a failure still points at the line it names.
  //
  // The masker is test/helpers/source-code.js's `codeWithCommentsBlanked`, which #107 added
  // for exactly this caller. A local copy of it here would be the same two regexes maintained
  // in two places, which is precisely the drift that module exists to make impossible.
  const jsSources = () =>
    TRACKED_JS.map((file) => [
      relative(RALPH_HOME, file),
      codeWithCommentsBlanked(readFileSync(file, 'utf8')),
    ])

  it('every SGR pattern in the repo still names the ESC byte', () => {
    // #107 re-spelled six ANSI strippers from a raw ESC to `\u001B`. Delete that escape
    // and `/\[[0-9;]*m/` is left: a pattern that strips the literal text `[31m` out of
    // UNCOLOURED output. Every assertion downstream of such a stripper flips meaning in
    // silence — `toContain('[31m BOOM')` in cycle.update-notice.qa.test.js would start
    // passing on plain text, and the `not.toContain` in start.banner.test.js would start
    // failing on a legitimate literal. Nothing else in the suite would notice.
    //
    // Built with `new RegExp` from pieces, both because that is this repo's idiom for
    // patterns about control bytes and so that this detector does not match its own source.
    const SGR_TAIL = new RegExp(
      '\\\\\\[' + // the two source characters  \[
        '(?:\\(\\?<\\w+>)?' + // an optional (named) capture group
        '(?:\\[0-9;?\\]|\\[0-9\\]|\\\\d)' + // the digit class:  [0-9;]  |  [0-9]  |  \d
        '[*+?{}0-9,]*' + // its quantifier
        '\\)?' +
        'm', // the SGR terminator
      'g',
    )
    // Any of the four legal ways to name the byte, plus a reference to a file-local `ESC`.
    const NAMES_ESC = /\\u001[bB]|\\x1[bB]|fromCharCode\(27\)|\bESC\b/

    let seen = 0
    const bare = []
    for (const [rel, src] of jsSources()) {
      src.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(SGR_TAIL)) {
          seen += 1
          if (!NAMES_ESC.test(line.slice(0, match.index))) bare.push(`${rel}:${index + 1}`)
        }
      })
    }
    expect(
      bare,
      'An SGR pattern that does not name the ESC byte. Without the ESC it matches the ' +
        'literal text `[31m` in uncoloured output, so every assertion built on it quietly ' +
        `means something else.\n${bare.join('\n')}`,
    ).toEqual([])
    // Fail-closed, in the shape test/hermetic-env.qa.test.js:46 uses: if a respelling ever
    // makes the detector above blind, this floor fails instead of the sweep passing vacuously.
    //
    // The floor sits just under the current population (37 when this was written) rather than
    // at 1, so that a PARTIAL blinding fails too — one alternation dropped from the digit
    // class, a quantifier tightened — instead of sailing through on whatever still matches.
    // The price of that tightness is that a legitimate SHRINKING of the population trips it as
    // well, and one is already sitting there waiting: ~35 files each declare their own
    // near-identical `strip`/`stripAnsi`, and deduping them into one shared helper would leave
    // two or three patterns in the whole repo. That is a fine change, so the message below has
    // to offer the reader both readings and a way to tell them apart, rather than accusing the
    // detector.
    expect(
      seen,
      'Fewer SGR patterns found than expected, which is EITHER of two things. (a) The ' +
        'detector above stopped finding the patterns it exists to check — a respelling it ' +
        'cannot parse, a regex edit — and the sweep is now passing vacuously. That is the ' +
        'failure this floor is for. (b) The repo genuinely has fewer, because the duplicated ' +
        '`strip`/`stripAnsi` helpers were deduped into one, which is an improvement. Tell them ' +
        'apart by grepping the repo for `[0-9;]*m`: if every pattern left still names the ESC ' +
        'byte, it is (b) and this floor is merely stale — lower it to fit.',
    ).toBeGreaterThanOrEqual(30)
  })

  it('start.banner.test.js’s ESC is exactly U+001B, which is what makes its one rewrite a no-op', () => {
    // The single non-mechanical hunk in #107: line ~738 went from the literal `'\u001B[38;2;'`
    // to `` `${ESC}[38;2;` ``, reusing the file's own constant. That is only equivalent while
    // ESC is that byte and nothing else, and NOTHING else in the suite would notice if the
    // constant drifted — the assertion is a `not.toContain`, so a wrong ESC makes it pass for
    // the wrong reason. Verified independently against HEAD before writing this: the rest of
    // the change is byte-for-byte the old file with its raw bytes escaped.
    const src = readFileSync(join(RALPH_HOME, 'lib/commands/start.banner.test.js'), 'utf8')
    const decl = src.match(/^const ESC = '(\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2})'$/m)
    expect(decl, 'the ESC constant is no longer a single escaped code point').not.toBe(null)
    expect(JSON.parse(`"${decl[1]}"`)).toBe(byte(0x1b))
    expect(src).toContain('.not.toContain(`${ESC}[38;2;`)')
  })

  it('the re-spelled fixtures still spell the bytes their test names promise', () => {
    // Each of these test cases is NAMED after the byte it feeds in — "binary-ish", "pure
    // junk", a non-GIF signature, an OSC title set. Silently dropping the escape while
    // keeping the name would leave an assertion that tests nothing and reads as though it
    // tests something, which is precisely the weakening criterion 4 forbids. Byte identity
    // with HEAD was verified by hand; this keeps it from drifting afterwards.
    const cases = [
      // file, the line's anchor, the code points that line must still spell
      ['lib/read-config-agent.test.js', 'parseConfigAgent(', [0x00, 0x01]],
      ['lib/commands/start.launch-box.qa.test.js', "'a config of pure junk'", [0x00, 0x00, 0x00]],
      ['test/sprite-gif-decode.test.js', 'signature:', [0x1a]],
      ['lib/banner-compose.qa.test.js', "'an OSC title set'", [0x07]],
    ]
    for (const [rel, anchor, codes] of cases) {
      const src = readFileSync(join(RALPH_HOME, rel), 'utf8')
      const line = src
        .split('\n')
        .filter((l) => l.includes(anchor) && /\\u00[0-9A-Fa-f]{2}/.test(l))
        .join('\n')
      expect(line, `${rel}: no line matching ${anchor} still spells an escaped control byte`).not.toBe('')
      const spelled = [...line.matchAll(/\\u(00[0-9A-Fa-f]{2})/g)].map((m) => parseInt(m[1], 16))
      expect(spelled, `${rel} (${anchor})`).toEqual(codes)
    }
  })
})
