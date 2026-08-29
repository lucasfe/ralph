// #71 QA — adversarial specs for `ralph changelog`, the command a reader reaches for when
// the banner's three-bullet box was not enough.
//
// changelog.test.js proves the four claims the slice is for: the newest few by default,
// every one under `--all`, a failure that names the path, and no network. This file attacks
// the same command from the five directions a COMMAND has that a pure module does not —
// and each of them is a place where the dev's spec asserts a property at one point where
// the implementation has a boundary, a table, or a seam a caller controls:
//
//   1. THE COUNT IS A SLICE, and a slice has edges. `releases.slice(0, 3)` and the
//      `shown < total` pointer are two conditions over the same number, so the interesting
//      inputs are 1, 2, 3 and 4 releases — not the fixture's 5. Three is where the pointer
//      must vanish and the count line must stop saying "newest of"; four is where both must
//      appear; one is where the English must become singular. The dev's spec pins 1 and 5.
//   2. THE FAILURE CONTRACT IS A TABLE, not three sentences. Three branches × `--all` on
//      and off, and every cell owes a reader the same six things: exit non-zero, name the
//      path, say why on one bounded line, leave stdout COMPLETELY empty, carry no stack
//      trace, and be distinguishable from the other two. Asserted as a table so a fourth
//      branch added later cannot quietly skip one of the six.
//   3. THE SEAMS ARE PARAMETERS, so what arrives at `fs.readFileSync`, `parse` and
//      `stdout.write` is whatever a caller passed. All three are one keystroke from being
//      wrong, and the command's own docstring promises the first two cost an exit code
//      rather than a stack trace. This file sweeps the shapes, INCLUDING the ones the
//      neighbouring lib/changelog-file.qa.test.js pins for the same fs seam — a hostile
//      `message` getter among them, because that file's rule is that nothing in a catch may
//      touch a rejection value it did not vet, and this command's catch prints the cause.
//   4. THE BYTES ARE COMMITTED MARKDOWN. CHANGELOG.md is written by release-please and
//      reviewed by nobody as bytes, so the file itself is untrusted input to a renderer
//      that writes straight to a terminal. The dev's spec proves one ESC is neutralised;
//      this one drives a C1 introducer, a NUL, a DEL, a NEL, U+2028/U+2029, a bidi
//      override, a lone surrogate, tabs, CRLF, classic-Mac CR and a 50,000-character
//      bullet through it, and asserts the invariant a reader actually depends on: every
//      line the command writes has one of four shapes, so nothing in the file can forge
//      the structure the listing's meaning rests on.
//   5. IT IS A CLI, and the AC that no injected fs can prove is "works outside a Ralph
//      project". The dev's end-to-end spawn reads the real shipped file from a temp
//      directory, which cannot fail and therefore cannot prove the exit code, and cannot
//      distinguish "read the install's file" from "read the file that happened to be
//      absent from the cwd". So the block at the bottom builds a FAKE INSTALL — this
//      package's bin/ and lib/ copied into a temp directory, which is what makes
//      RALPH_HOME land there — and runs the real binary against it: with a decoy
//      CHANGELOG.md, a ralph.config.sh and a .ralph/ in the working directory, with the
//      file missing, with prose in its place, with a directory in its place, with a
//      hostile environment, and with colour forced on.
//
// Hermetic: every in-process case injects the fs, the parser and both streams, and every
// child process runs against a temp install with an explicit env, so nothing here reads the
// developer's checkout, shell or terminal (#41).

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Volume } from 'memfs'
import pc from 'picocolors'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { changelogPath } from '../changelog-file.js'
// Imported, not injected, because that is exactly how the command gets it: the bound on what
// a failure may say is a module boundary, so "the cause is printable" is a claim about the
// real function and cannot be asserted through the command's seams.
import { failureCause } from '../install-failure.js'
import { changelogCommand } from './changelog.js'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const SOURCE = fileURLToPath(new URL('./changelog.js', import.meta.url))
const SAMPLE = readFileSync(new URL('../__fixtures__/changelog-sample.md', import.meta.url), 'utf8')

const ESC = '\u001B'
const NUL = '\u0000'
const DEL = '\u007F'
// U+009B, the one-byte C1 CSI introducer: the same escape attack without an ESC in front of
// it, and the one a `.replace(/\u001B/g, '')` sanitiser would let straight through.
const C1_CSI = '\u009B'
const NEL = '\u0085'
const VT = '\u000B'
const LS = '\u2028'
const PS = '\u2029'
const RLO = '\u202E'
const PDF = '\u202C'
const CR = '\r'
const BEL = '\u0007'
const PLACEHOLDER = '\uFFFD'

// THE RENDERER'S OWN COLOUR, and the only escape any assertion in this file tolerates.
//
// This is the lesson of 5d2de88 ("scope the banner's no-escape assertions to the sprite, not
// all ANSI"), relearned one file later at CI's expense: "no ESC anywhere" is not a claim a
// `pc`-colouring command can keep. `failed()` wraps every headline in `pc.red`, which is the
// repo's convention (update.js, doctor.js) and is correct — and picocolors decides ONCE AT
// IMPORT from the real environment, where `!!env.CI` alone is enough (picocolors.js:4). So the
// same stderr is plain on a laptop and coloured on GitHub Actions, which makes a blanket
// `not.toContain(ESC)` two different assertions: a vacuous one here and a false one there. It
// passed locally for a whole review cycle and went red the moment it ran on CI.
//
// The discriminator mirrors 5d2de88's use of truecolor to fingerprint the sprite, inverted:
// there the renderer's escapes were the illegitimate ones, here they are the only legitimate
// ones. Every sequence picocolors can emit is a SINGLE-parameter SGR — red is `[31m` and
// `[39m`, 48 of them in all, and not one contains a semicolon — so removing `[<digits>m`
// removes all of the colour and none of an attack. An erase-screen `[2J`, a truecolor
// `[38;2;r;g;bm`, an `]0;title` + BEL window retitle, a `[6n` that makes the terminal type its
// reply into the shell, and a bare C1 introducer all survive it and still fail the assertion.
// That is what keeps this sharp rather than merely green.
const COLOUR = /\u001B\[[0-9]{1,3}m/g

// Which way picocolors resolved in THIS process, and the exact bytes it uses when it is on.
// Derived at runtime rather than assumed, so every assertion below states the SAME property on
// a laptop and on CI instead of a different one on each.
const [RED_OPEN, RED_CLOSE] = pc.red(' ').split(' ')
const COLOUR_ON = RED_OPEN !== ''

/**
 * Assert that the only escapes in `raw` are the renderer's own colour, and return `raw` with
 * that colour removed, so a caller can go on to compare TEXT across colour modes.
 *
 * Every other control byte is a defect whatever contributed it — the changelog's bytes, a
 * thrown value's message, or the install path.
 */
function expectOnlyRenderersColour(raw, why) {
  const bare = raw.replace(COLOUR, '')
  for (const byte of [ESC, C1_CSI, NUL, DEL, CR, NEL, VT, LS, PS]) {
    expect(bare, `${why}: ${JSON.stringify(byte)} reached the terminal`).not.toContain(byte)
  }
  return bare
}

// Colour is not text, so it comes off before any assertion about WORDS — and ONLY the
// renderer's own colour does, for the reason spelled out at COLOUR above: a broader strip
// would silently swallow an escape the changelog contributed and then call the result clean.
const strip = (text) => text.replace(COLOUR, '')

/** A stream that records, and can be told to start failing after `failAfter` writes. */
function makeStream({ failAfter = Number.POSITIVE_INFINITY } = {}) {
  const chunks = []
  return {
    write: (chunk) => {
      if (chunks.length >= failAfter) throw new Error('EPIPE: broken pipe')
      chunks.push(chunk)
      return true
    },
    chunks,
    output: () => strip(chunks.join('')),
    lines: () => strip(chunks.join('')).split('\n').slice(0, -1),
  }
}

const volumeWith = (text) => Volume.fromJSON({ [changelogPath()]: text }, '/')
const answering = (value) => ({ readFileSync: () => value })
const throwing = (boom) => ({
  readFileSync: () => {
    throw boom
  },
})

const deps = (overrides = {}) => ({
  stdout: makeStream(),
  stderr: makeStream(),
  fs: volumeWith(SAMPLE),
  ...overrides,
})

const run = async (overrides = {}) => {
  const d = deps(overrides)
  const result = await changelogCommand(d)
  return { d, result, out: d.stdout.output(), err: d.stderr.output() }
}

// A changelog holding exactly `count` releases, newest first, each with one section and
// `bullets` bullets. Generated rather than fixtured because the whole point of the block
// below is the COUNT — a fixture would have to be edited to move a boundary, and a boundary
// nobody can move is a boundary nobody tests.
const changelogOf = (count, bullets = 1) =>
  Array.from({ length: count }, (_, index) => {
    const major = count - index
    return [
      `## [${major}.0.0](https://example.test/v${major}.0.0) (2026-01-0${(index % 9) + 1})`,
      '',
      '### Features',
      '',
      ...Array.from({ length: bullets }, (_, n) => `* bullet ${n + 1} of ${major}.0.0`),
      '',
    ].join('\n')
  }).join('\n')

// The shape of every line a listing may contain. This is the listing's grammar, and it is
// what makes the output greppable: a reader who pipes this into `grep '^  '` is asking for
// section headings, and one who reads column zero is reading version numbers.
const shapeOf = (line) => {
  if (line === '') return 'blank'
  if (/^ {4}• \S/.test(line)) return 'bullet'
  if (/^ {2}\S/.test(line)) return 'heading'
  if (/^\S/.test(line)) return 'column-zero'
  return `unknown:${JSON.stringify(line)}`
}

describe('QA changelogCommand — the count, at every edge of the slice', () => {
  // The table the dev's spec has two rows of. `DEFAULT_ENTRIES` is 3, so 3 is where the
  // pointer must disappear and the count line must drop "newest of", and 4 is where both
  // must appear — an off-by-one in either direction is invisible at 1 and at 5.
  const CASES = [
    { total: 1, shown: 1, count: 'Ralph changelog — 1 release', pointer: false },
    { total: 2, shown: 2, count: 'Ralph changelog — 2 releases', pointer: false },
    { total: 3, shown: 3, count: 'Ralph changelog — 3 releases', pointer: false },
    { total: 4, shown: 3, count: 'Ralph changelog — the 3 newest of 4 releases', pointer: true },
    { total: 9, shown: 3, count: 'Ralph changelog — the 3 newest of 9 releases', pointer: true },
  ]

  it('shows the newest three and points at --all only when there is a rest', async () => {
    for (const { total, shown, count, pointer } of CASES) {
      const { d, result, out } = await run({ fs: volumeWith(changelogOf(total)) })
      const why = `${total} releases`
      expect(result, why).toMatchObject({ exitCode: 0, shown, total })
      // The count line is FIRST and appears once: it is the only thing that tells a reader
      // whether they are looking at a truncated view, so it cannot drift below the listing
      // or be printed twice by a future "and N older releases" line.
      expect(d.stdout.lines()[0], why).toBe(count)
      expect(out.split(count), why).toHaveLength(2)
      expect(out.includes('run `ralph changelog --all` for every release'), why).toBe(pointer)
      // A dead pointer is the failure #70 refused to leave behind, one level down: no
      // mention of the flag at all when it would show nothing new.
      if (!pointer) expect(out, why).not.toContain('--all')
      // ...and the releases the slice held back are absent ENTIRELY — not merely unlisted.
      // `1.0.0` is the oldest in every generated file, so at total > 3 it must be gone.
      if (shown < total) expect(out, why).not.toContain('1.0.0')
    }
  })

  it('says "1 release" and never "1 releases"', async () => {
    // A pruned changelog (a fork's first release, a tarball with one entry) is the first
    // thing a new user of `ralph changelog` sees, and `1 releases` is the kind of line that
    // makes a tool look unfinished. The plural of the TOTAL is what the line reads from, so
    // this is also the guard for "the 3 newest of 1 releases" never being reachable.
    const { out } = await run({ fs: volumeWith(changelogOf(1)) })
    expect(out).toContain('Ralph changelog — 1 release\n')
    expect(out).not.toMatch(/\b1 releases\b/)
  })

  it('prints every release under --all at every one of those counts, with no pointer', async () => {
    for (const { total } of CASES) {
      const { result, out } = await run({ fs: volumeWith(changelogOf(total)), all: true })
      const why = `${total} releases`
      expect(result, why).toMatchObject({ exitCode: 0, shown: total, total })
      expect(out, why).toContain(`Ralph changelog — ${total} release${total === 1 ? '' : 's'}`)
      // Every version in the file, oldest included — `--all` is the view with no edge.
      for (let major = 1; major <= total; major += 1) expect(out, `${why}: ${major}`).toContain(`${major}.0.0`)
      expect(out, why).not.toContain('--all')
    }
  })

  it('lays out three releases exactly, blank lines and all', async () => {
    // The dev's spec pins the shape of ONE entry, which is the one arrangement where the
    // separator between entries cannot be seen. This is the multi-entry layout: a blank
    // BEFORE each entry but the first, so the listing never ends in one — a trailing blank
    // is a wasted row in a pager and a spurious line in a pipe.
    const { d } = await run({ fs: volumeWith(changelogOf(4)) })
    expect(d.stdout.lines()).toEqual([
      'Ralph changelog — the 3 newest of 4 releases',
      'run `ralph changelog --all` for every release',
      '',
      '4.0.0 — 2026-01-01',
      '  Features',
      '    • bullet 1 of 4.0.0',
      '',
      '3.0.0 — 2026-01-02',
      '  Features',
      '    • bullet 1 of 3.0.0',
      '',
      '2.0.0 — 2026-01-03',
      '  Features',
      '    • bullet 1 of 2.0.0',
    ])
  })

  it('never ends in a blank line and never prints two in a row', async () => {
    // Asserted over the whole table rather than at one count, because the blank belongs to
    // the entry that follows it: an entry that rendered no lines at all (a release with no
    // sections, at the end of the file) is exactly how a trailing blank appears.
    for (const total of [1, 2, 3, 4, 7]) {
      for (const all of [false, true]) {
        const { d, out } = await run({ fs: volumeWith(changelogOf(total)), all })
        const why = `${total} releases, --all ${all}`
        expect(out.endsWith('\n'), why).toBe(true)
        expect(out, why).not.toMatch(/\n\n$/)
        const lines = d.stdout.lines()
        for (const [index, line] of lines.entries()) {
          if (line === '') expect(lines[index + 1], `${why} at ${index}`).not.toBe('')
        }
      }
    }
  })

  it('clips releases, never bullets — the newest entry arrives whole however long it is', async () => {
    // The pointer in the box says "run `ralph changelog` for the rest", so the default view
    // is the one place a bullet exists in full. Forty bullets across four sections, because
    // the box shows three of one section: a renderer that clipped per section, or that
    // stopped at the first section, would satisfy the dev's five-bullet spec.
    const sections = ['Features', 'Bug Fixes', 'Miscellaneous Chores', '⚠ BREAKING CHANGES']
    const text = [
      '## [2.0.0](https://example.test/v2.0.0) (2026-03-03)',
      '',
      ...sections.flatMap((heading) => [
        `### ${heading}`,
        '',
        ...Array.from({ length: 10 }, (_, n) => `* ${heading} bullet ${n + 1}`),
        '',
      ]),
    ].join('\n')
    const { d, out } = await run({ fs: volumeWith(text) })
    for (const heading of sections) {
      expect(out, heading).toContain(`  ${heading}`)
      for (let n = 1; n <= 10; n += 1) expect(out, `${heading} ${n}`).toContain(`${heading} bullet ${n}`)
    }
    expect(d.stdout.lines().filter((line) => shapeOf(line) === 'bullet')).toHaveLength(40)
    expect(out).not.toContain('…')
  })

  it('shows the older entries whole too, not just the newest', async () => {
    // The slice is over releases; each release that survives it is printed in full. A
    // reader catching up over three releases needs the third one's bullets as much as the
    // first one's, and "the newest whole, the rest summarised" is a shape nothing asked for.
    const { d } = await run({ fs: volumeWith(changelogOf(3, 6)) })
    for (const major of [3, 2, 1]) {
      for (let n = 1; n <= 6; n += 1) {
        expect(d.stdout.output(), `${major}.0.0 bullet ${n}`).toContain(`bullet ${n} of ${major}.0.0`)
      }
    }
    expect(d.stdout.lines().filter((line) => shapeOf(line) === 'bullet')).toHaveLength(18)
  })

  it('holds its count on a changelog with four thousand releases', async () => {
    // A file this size is what a long-lived package's changelog becomes, and it is the one
    // input where a per-entry cost that is fine at five becomes a hang. Both views: the
    // default must still read three (so the slice happens before any rendering), and
    // `--all` must produce a line per bullet without a pager, a cache or a truncation.
    const text = changelogOf(4000)
    const brief = await run({ fs: volumeWith(text) })
    expect(brief.result).toMatchObject({ exitCode: 0, shown: 3, total: 4000 })
    expect(brief.d.stdout.lines()[0]).toBe('Ralph changelog — the 3 newest of 4000 releases')
    expect(brief.d.stdout.chunks).toHaveLength(3 + 3 * 4 - 1)

    const every = await run({ fs: volumeWith(text), all: true })
    expect(every.result).toMatchObject({ exitCode: 0, shown: 4000, total: 4000 })
    expect(every.d.stdout.lines()[0]).toBe('Ralph changelog — 4000 releases')
    expect(every.d.stdout.lines().filter((line) => shapeOf(line) === 'bullet')).toHaveLength(4000)
    expect(every.out).toContain('bullet 1 of 1.0.0')
  })

  it('counts release headings only — prose sections are not releases', async () => {
    // `## Contributing`, `## Unreleased` and a Keep-a-Changelog link block are all `## `
    // headings that name no version. The count line is a claim about RELEASES, so a file
    // like this must read as one release and not as four — and the prose's bullets must not
    // be attributed to the release below them.
    const text = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '* a thing that has not shipped',
      '',
      '## [1.0.0](https://example.test/v1.0.0) (2026-01-01)',
      '',
      '### Features',
      '',
      '* the only real bullet',
      '',
      '## Contributing',
      '',
      '* be kind',
      '',
    ].join('\n')
    const { result, out } = await run({ fs: volumeWith(text) })
    expect(result).toMatchObject({ exitCode: 0, shown: 1, total: 1 })
    expect(out).toContain('Ralph changelog — 1 release')
    expect(out).toContain('the only real bullet')
    expect(out).not.toContain('has not shipped')
    expect(out).not.toContain('be kind')
    expect(out).not.toContain('Unreleased')
  })
})

describe('QA changelogCommand — the failure contract, as a table', () => {
  // The three branches, each with the input that reaches it and the wording that must
  // distinguish it. Every cell is asserted against the SAME six promises below, so a fourth
  // branch cannot be added with only five of them.
  const BRANCHES = {
    'the file is missing': { overrides: { fs: new Volume() }, says: /could not read/i },
    'a directory is in its place': {
      overrides: () => {
        const fs = new Volume()
        fs.mkdirSync(changelogPath(), { recursive: true })
        return { fs }
      },
      says: /could not read/i,
    },
    'the read throws': { overrides: { fs: throwing(new Error('EACCES: permission denied')) }, says: /could not read/i },
    'the fs is not one': { overrides: { fs: {} }, says: /could not read/i },
    'the parser gives up': {
      overrides: {
        parse: () => {
          throw new Error('the grammar gave up')
        },
      },
      says: /could not make sense/i,
    },
    'the parser answers with nothing usable': { overrides: { parse: () => null }, says: /no releases/i },
    'the file is empty': { overrides: { fs: volumeWith('') }, says: /no releases/i },
    'the file is prose': { overrides: { fs: volumeWith('# Changelog\n\nAll notable changes.\n') }, says: /no releases/i },
    'the file is binary noise': { overrides: { fs: volumeWith(`${NUL}${DEL}${ESC}${C1_CSI}`) }, says: /no releases/i },
    'the file has classic-Mac line endings': {
      // `.` in a JavaScript regex does not match a CR, so a file whose every line ends in
      // one alone parses as nothing. That is honest — the file really holds no heading this
      // grammar can read — and the point of the case is that it FAILS rather than printing
      // one enormous line, and that no CR reaches the terminal on the way out.
      overrides: { fs: volumeWith(`## [1.0.0](u) (2026-01-01)${CR}* a bullet${CR}`) },
      says: /no releases/i,
    },
  }

  it('exits non-zero, names the path, says why once, and prints nothing to stdout', async () => {
    for (const [name, branch] of Object.entries(BRANCHES)) {
      for (const all of [false, true]) {
        const overrides = typeof branch.overrides === 'function' ? branch.overrides() : branch.overrides
        const { d, result, out, err } = await run({ ...overrides, all })
        const why = `${name} (--all ${all})`
        // 1. non-zero, and the contract's own numbers are zeroed.
        expect(result, why).toMatchObject({ exitCode: 1, shown: 0, total: 0 })
        // 2. it names what could not be read, by absolute path.
        expect(err, why).toContain(changelogPath())
        // 3. it says which of the three things went wrong.
        expect(err, why).toMatch(branch.says)
        // 4. stdout is COMPLETELY empty — a reader piping this into a pager gets an empty
        //    document rather than a header with no listing under it.
        expect(out, why).toBe('')
        // 5. no stack trace, in any of its tells: a frame, an internal module, a file:// URL,
        //    a `path:line:column`, or an `Error:` prefix carrying a class name through.
        expect(err, why).not.toMatch(/^\s+at\s/m)
        expect(err, why).not.toContain('node:internal')
        expect(err, why).not.toContain('file://')
        expect(err, why).not.toMatch(/\.js:\d+:\d+/)
        expect(err, why).not.toMatch(/\b(?:Type|Range|Reference|Syntax)?Error:/)
        // 6. one whole line per write, and a bounded number of them.
        expect(d.stderr.chunks.length, why).toBeLessThanOrEqual(4)
        for (const chunk of d.stderr.chunks) {
          expect(chunk.endsWith('\n'), why).toBe(true)
          expect(chunk.slice(0, -1), why).not.toContain('\n')
        }
        // 7. ...and not one byte the FILE contributed can drive the terminal from here.
        //    Scoped to FOREIGN escapes rather than all of them, because the headline is
        //    legitimately `pc.red` — see COLOUR. Non-vacuous in either colour mode: the
        //    binary-noise row above puts an ESC, a NUL, a DEL and a C1 introducer in the
        //    changelog, and the only thing this failure may borrow from that file is its
        //    LENGTH. The detector's own sharpness is pinned by the test below.
        const bare = expectOnlyRenderersColour(d.stderr.chunks.join(''), why)
        // 8. The colour convention itself, in whichever direction THIS process resolved, so
        //    that the run which is not CI still checks something: the headline is wrapped, the
        //    hint never is, and colour is a wrapper around the text rather than part of it.
        expect(d.stderr.chunks[0].startsWith(RED_OPEN), `${why}: headline opens in red`).toBe(true)
        expect(d.stderr.chunks[0].endsWith(`${RED_CLOSE}\n`), `${why}: headline closes`).toBe(true)
        expect(d.stderr.chunks[1], `${why}: the hint is not coloured`).not.toContain(ESC)
        expect(bare, why).toContain(changelogPath())
      }
    }
  })

  it('would catch an escape smuggled past the renderer’s own colour', async () => {
    // THE NEGATIVE CONTROL, and the reason this file has one at all: the assertion above used
    // to forbid ESC outright, which on a laptop is a test that cannot fail — picocolors is off
    // without a TTY, so there was never an escape to find — and on CI is a test that cannot
    // pass. An assertion nobody has watched fail is not evidence, so the detector is pointed
    // here at the outputs a broken renderer would produce and must reject every one.
    //
    // The strings are built from RED_OPEN/RED_CLOSE, so this runs the SAME way in both colour
    // modes: with colour on, the detector has real SGR to see past; with it off, the hostile
    // sequence is all there is. Either way the answer must be "reject".
    const headline = `${RED_OPEN}❌ Could not read Ralph's changelog at ${changelogPath()}.${RED_CLOSE}\n`
    expect(() => expectOnlyRenderersColour(headline, 'the real thing')).not.toThrow()
    // When colour is on there is genuinely an SGR sequence for the detector to see past, so
    // the rejections below are not just "any ESC at all" in disguise.
    expect(headline.includes(ESC), 'the control carries real colour when picocolors is on').toBe(COLOUR_ON)
    const SMUGGLED = {
      'an erase-screen': `${ESC}[2J`,
      'a truecolor sequence, which a `[0-9;]*m` strip would have swallowed': `${ESC}[38;2;255;0;0m`,
      'a window retitle': `${ESC}]0;owned${BEL}`,
      'a cursor-position report, which makes the terminal type into the shell': `${ESC}[6n`,
      'a bare C1 introducer': `${C1_CSI}31m`,
      'a NUL': NUL,
      'a DEL': DEL,
      'a carriage return that would overwrite the line': CR,
      'a NEL': NEL,
      'a U+2028 line separator': LS,
    }
    for (const [name, smuggled] of Object.entries(SMUGGLED)) {
      expect(
        () => expectOnlyRenderersColour(headline.replace('❌', `❌${smuggled}`), name),
        `${name} slipped past the detector`,
      ).toThrow()
    }
  })

  it('wraps the failure in colour rather than mixing colour into it', async () => {
    // The ROOT CAUSE, stated as a property instead of as a byte. The assertion that broke CI
    // was only the symptom; the disease was that this file's outcome depended on a decision
    // picocolors makes ONCE, at import, from an environment no injected bag can reach —
    // `!!env.CI` alone flips it (picocolors.js:4). The cure is to assert something whose truth
    // value does not move with that decision:
    //
    //     the headline is exactly `pc.red(<plain text>)`, and the plain text is colour-free.
    //
    // Reconstructed through `pc` at runtime, so it reads as one claim in both modes: with
    // colour on it pins the open/close bytes and their position; with colour off `pc.red` is
    // the identity and it pins that nothing coloured itself anyway. It cannot be satisfied by
    // turning colour off, cannot be satisfied by deleting the check, and it fails the moment
    // colour ends up INSIDE the text — mid-path, say, or around the interpolated cause.
    for (const all of [false, true]) {
      const { d, result } = await run({ fs: new Volume(), all })
      expect(result, `--all ${all}`).toMatchObject({ exitCode: 1 })
      const [headline, hint] = d.stderr.chunks
      const plain = strip(headline).slice(0, -1)
      expect(headline, 'colour is a pure wrapper around the headline').toBe(`${pc.red(plain)}\n`)
      expect(plain, 'the text under the colour is colour-free').not.toContain(ESC)
      // The hint is a second write and takes no colour at all, in either mode.
      expect(hint).toBe(strip(hint))
      expect(hint).not.toContain(ESC)
      // And the text itself is the same sentence either way — the part a reader pastes into
      // an issue does not depend on whether their terminal was a TTY.
      expect(plain).toContain(changelogPath())
      expect(plain).toMatch(/could not read/i)
    }
  })

  it('says three different things, so a reader repairs the right problem', async () => {
    // The three failures are three repairs: reinstall, report a bug, and "this file really
    // is empty". Pairwise distinct FIRST LINES, not merely distinct blobs — the first line
    // is what a reader acts on and what a maintainer gets pasted into an issue.
    const headlines = new Map()
    for (const [name, expected] of [
      ['unreadable', { fs: new Volume() }],
      ['unparseable', { parse: () => { throw new Error('boom') } }],
      ['no releases', { fs: volumeWith('# Changelog\n') }],
    ]) {
      const { d } = await run(expected)
      headlines.set(name, d.stderr.lines()[0])
    }
    expect(new Set(headlines.values()).size).toBe(3)
    expect(headlines.get('no releases')).not.toMatch(/could not read/i)
    expect(headlines.get('no releases')).not.toMatch(/could not make sense/i)
    expect(headlines.get('unparseable')).not.toMatch(/could not read/i)
    // Each headline is a sentence about the changelog, and each carries the path: a reader
    // with a global install and a linked dev checkout has two of these files.
    for (const headline of headlines.values()) {
      expect(headline).toContain(changelogPath())
      expect(headline.length).toBeLessThan(400)
    }
  })

  it('counts the file’s characters in the singular when there is one', async () => {
    // The "no releases" hint tells a reader how long the file it just refused actually is,
    // which is the number that distinguishes a truncated write from a file of prose. A
    // one-byte file is precisely the truncated-write case, so 1 is the value this number
    // takes most often — and `1 characters long` was the wording it got. Asserted at 0, 1 and
    // 2 because a plural helper is a three-case function and only the middle case is
    // interesting: 0 and 2 must stay plural, or the fix traded one wrong sentence for two.
    for (const [text, expected] of [
      ['', 'It is readable and 0 characters long'],
      ['x', 'It is readable and 1 character long'],
      ['xy', 'It is readable and 2 characters long'],
    ]) {
      const { result, err } = await run({ fs: volumeWith(text) })
      expect(result.exitCode, JSON.stringify(text)).toBe(1)
      expect(err, JSON.stringify(text)).toContain(
        `${expected}, but nothing in it parses as a \`## <version>\` release heading.`,
      )
    }
    // And the noun the same helper now serves twice cannot have been crossed over: the
    // character count must never borrow the release wording, or vice versa.
    const { err } = await run({ fs: volumeWith('x') })
    expect(err).not.toMatch(/character releases?|releases? long/)
  })

  it('bounds what a hostile failure can say, however much it says', async () => {
    // A read failure's message is not Ralph's text: it comes from an fs, and a stub, a fuse
    // mount or a mocking library can make it a megabyte or a hundred lines. `failureCause`
    // is the bound, and this is the assertion that the bound is what the command actually
    // uses — an interpolated `.message` would put the whole thing on the terminal.
    const flood = new Error(`${'E'.repeat(500_000)}\n${'more\n'.repeat(5000)}`)
    const { d, result, err } = await run({ fs: throwing(flood) })
    expect(result.exitCode).toBe(1)
    expect(err.length).toBeLessThan(700)
    expect(d.stderr.chunks).toHaveLength(2)
    // The clip is VISIBLE: a truncated tail that reads as complete is worse than a long one.
    expect(err).toContain('…')
  })

  it('does not claim success when the listing could not be written', async () => {
    // `stdout` is the third injected seam, and the one with no fallback: a stream that
    // cannot be written to leaves nowhere to report that it could not be written to. So the
    // assertion is not "it never throws" — it is the weaker thing a caller can actually
    // rely on, that a run which printed nothing (or half a listing) never comes back
    // reporting three releases shown and an exit code of 0.
    for (const failAfter of [0, 1, 4]) {
      const stdout = makeStream({ failAfter })
      const outcome = await changelogCommand(deps({ stdout })).then(
        (result) => result,
        (error) => ({ threw: error }),
      )
      const why = `failing after ${failAfter} writes`
      expect('threw' in outcome || outcome.exitCode !== 0, why).toBe(true)
      expect(stdout.chunks.length, why).toBe(failAfter)
    }
  })
})

describe('QA changelogCommand — the seams, abused', () => {
  it('reports a read failure whatever the throw carries', async () => {
    // The sweep lib/changelog-file.qa.test.js runs over the same seam, widened: a read can
    // reject with anything, and a `catch` that reads a property off it is making an
    // assumption about a value it did not create. The errno bags are what a real fs throws;
    // the primitives and the Symbol are what a stub, a shim or a mocking library throws.
    // (The two shapes whose ACCESSORS throw are the test below, because they are red.)
    const BOOMS = {
      ENOENT: Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
      EACCES: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      EMFILE: Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }),
      'a TypeError': new TypeError('The "path" argument must be of type string'),
      'a RangeError': new RangeError('Invalid string length'),
      'a string': 'a string nobody should throw',
      'a number': 42,
      null: null,
      undefined: undefined,
      'a Symbol': Symbol('boom'),
      'a bare code bag': { code: 'ENOENT' },
      'a bag with a message': { message: 'something went wrong' },
      'an execa-shaped failure': { shortMessage: 'Command failed with ENOENT', message: 'the long version' },
    }
    for (const [name, boom] of Object.entries(BOOMS)) {
      const outcome = await changelogCommand(deps({ fs: throwing(boom) })).then(
        (result) => result,
        (error) => ({ threw: error }),
      )
      expect(outcome.threw, `${name} escaped as a throw`).toBeUndefined()
      expect(outcome.exitCode, name).toBe(1)
    }
  })

  it('reports the failure even when the thrown value itself fights back', async () => {
    // The shapes the sweep above cannot hold, because reading a property off them is what
    // detonates them. This is not academic — it is the exact rule
    // lib/changelog-file.qa.test.js states for the sibling reader of this very file: nothing
    // in a catch may touch a value it did not vet, "which a `catch (e) { log(e.message) }`
    // would". This command's catch DOES touch it, because naming the cause is half of what
    // the failure is for, so the vetting has to be here.
    //
    // Real sources: a mocking library's Proxy-based fs double (an autospy, proxyquire, memfs
    // behind a Proxy), a revoked Proxy from a torn-down module, a shim whose getter formats
    // its message lazily and fails doing it. Every one of them turns one sentence into Node's
    // unhandled-rejection report — a stack trace, the one thing the docstring rules out.
    //
    // The table is deliberately WIDER than the one bug that was reported, because a guard is
    // only worth what its narrowest case is: `failureCause` reaches its answer in two steps,
    // a property READ (`.shortMessage`, then `.message`) and a `String()` COERCION of what
    // came back, and a guard around only the first would leave the second open. So the table
    // attacks both, plus the read of a THROWN value by whatever catches it.
    const nested = {
      get message() {
        // A throw whose own value is hostile: whatever catches this must not read it either.
        throw {
          get message() {
            throw new Error('turtles all the way down')
          },
        }
      },
    }
    const revocable = Proxy.revocable({ message: 'gone' }, {})
    revocable.revoke()
    const HOSTILE = {
      'a value whose message getter throws': {
        get message() {
          throw new Error('even the message is hostile')
        },
        get shortMessage() {
          throw new Error('and so is this one')
        },
      },
      // The half-fix detector: `shortMessage` is read FIRST, so this one detonates on a value
      // that would have answered the second read perfectly well.
      'a value whose shortMessage throws but whose message does not': {
        get shortMessage() {
          throw new Error('the short one is hostile')
        },
        message: 'the long one is fine',
      },
      'a Proxy that throws on every read': new Proxy(
        {},
        {
          get() {
            throw new Error('the rejection value itself is hostile')
          },
        },
      ),
      'a Proxy that throws from every trap': new Proxy(
        {},
        {
          get() {
            throw new Error('get')
          },
          has() {
            throw new Error('has')
          },
          getPrototypeOf() {
            throw new Error('getPrototypeOf')
          },
          getOwnPropertyDescriptor() {
            throw new Error('getOwnPropertyDescriptor')
          },
          ownKeys() {
            throw new Error('ownKeys')
          },
        },
      ),
      // A module torn down mid-run: every operation on the handle is a TypeError now.
      'a revoked Proxy': revocable.proxy,
      // Step two of `failureCause`: the property READ succeeds and the COERCION throws.
      'a message whose toString throws': {
        message: {
          toString() {
            throw new Error('not stringifiable')
          },
        },
      },
      'a message whose Symbol.toPrimitive throws': {
        message: {
          [Symbol.toPrimitive]() {
            throw new Error('not coercible')
          },
        },
      },
      // Both steps at once, on a value that also looks like a real Error to `instanceof`.
      'a real Error with a hostile shortMessage bolted on': Object.defineProperty(
        new Error('the real message'),
        'shortMessage',
        {
          get() {
            throw new Error('the bolted-on one is hostile')
          },
        },
      ),
      // A getter that throws a primitive, so a `catch (e) { e.message }` gets undefined
      // rather than an error — the shape that produces `(undefined)` on a terminal.
      'a getter that throws a Symbol': {
        get shortMessage() {
          throw Symbol('hostile')
        },
      },
      'a getter whose throw is itself hostile': nested,
      // Inherited hostility: the own-property check passes, the prototype's getter detonates.
      'a hostile getter on the prototype': Object.create({
        get message() {
          throw new Error('inherited hostility')
        },
      }),
    }
    // BOTH catches, because the fix is per-catch: the read's and the parser's. A guard applied
    // to one of them is the natural half-fix, and `ralph changelog` promises the same sentence
    // either way.
    const SEAMS = {
      'the read': (boom) => ({ fs: throwing(boom) }),
      'the parser': (boom) => ({
        parse: () => {
          throw boom
        },
      }),
    }
    for (const [seam, wire] of Object.entries(SEAMS)) {
      for (const [name, boom] of Object.entries(HOSTILE)) {
        const why = `${name}, thrown from ${seam}`
        const d = deps(wire(boom))
        const outcome = await changelogCommand(d).then(
          (result) => result,
          (error) => ({ threw: error }),
        )
        expect(outcome.threw, `${why}: escaped as a throw`).toBeUndefined()
        expect(outcome.exitCode, why).toBe(1)
        // Losing the cause is allowed — a cause nobody can read is no cause. Losing the
        // HEADLINE is not: the path and the repair are the part a reader acts on, and they
        // never depended on the thrown value in the first place.
        const err = d.stderr.output()
        expect(err, why).toContain(changelogPath())
        expect(d.stderr.chunks, why).toHaveLength(2)
        expect(d.stdout.chunks, why).toHaveLength(0)
        // No stack trace, and no empty parenthetical either: `Could not read … ()` is what a
        // guard that returns a falsy-but-present cause looks like from the outside.
        expect(err, why).not.toMatch(/^\s+at\s/m)
        expect(err, why).not.toMatch(/node:internal/)
        expect(err, why).not.toMatch(/\(\)/)
        // And nothing half-coerced leaked into the sentence.
        expect(err, why).not.toMatch(/\(undefined\)|\(null\)|\[object |NaN/)
      }
    }
  })

  it('is handed a cause it can print, or none at all', async () => {
    // The guard makes an unreadable cause SAFE; this pins that a readable one is still
    // PRINTABLE. `failureCause` is imported, not injected, so no spec here can hand the
    // command a bound that misbehaves — which means the assumption "whatever comes back can
    // be interpolated into a sentence" has to be checked against the real function, over the
    // same hostile values, or it is just an assumption. Either answer is fine: a string the
    // command prints, or a throw the guard swallows. A non-string is not, because `failed`
    // interpolates it and `[object Object]` is the result.
    const VALUES = [
      new Error('plain'),
      Object.assign(new Error('errno'), { code: 'ENOENT' }),
      { shortMessage: 'execa shaped' },
      { message: 'bag' },
      { message: 42 },
      { message: null },
      { shortMessage: '' },
      { message: `${'x'.repeat(50_000)}\nsecond line` },
      'a string',
      42,
      null,
      undefined,
      Symbol('sym'),
      [],
      new Proxy({}, { get: () => 'everything is this' }),
    ]
    for (const value of VALUES) {
      let answer
      try {
        answer = failureCause(value)
      } catch {
        continue // a throw is the guard's business, and the test above owns that
      }
      const why = String(typeof value === 'symbol' ? 'Symbol' : JSON.stringify(value) ?? value)
      expect(typeof answer, why).toBe('string')
      expect(answer, why).not.toContain('\n')
      expect(answer.length, why).toBeLessThanOrEqual(201)
    }
  })

  it('reports a read failure for anything that is not an fs', async () => {
    // The seam is a parameter with a default, so every one of these is one keystroke away
    // in a caller: `{ fs: fsPromises }`, a typo'd property, a bag that is a function.
    const NOT_AN_FS = {
      'an empty bag': {},
      'a prototypeless bag': Object.create(null),
      null: null,
      'a number': 42,
      'a string': 'fs',
      'an array': [],
      'a function': () => SAMPLE,
      'a class': class Nope {},
      'readFileSync as a string': { readFileSync: 'nope' },
      'readFileSync as an object': { readFileSync: {} },
      'the wrong spelling': { readfilesync: () => SAMPLE },
      'the promises API by mistake': { readFile: async () => SAMPLE },
      'a getter that throws': {
        get readFileSync() {
          throw new Error('a hostile fs bag')
        },
      },
    }
    for (const [name, fs] of Object.entries(NOT_AN_FS)) {
      const { result, out, err } = await run({ fs })
      expect(result, name).toMatchObject({ exitCode: 1, shown: 0, total: 0 })
      expect(err, name).toMatch(/could not read/i)
      expect(err, name).toContain(changelogPath())
      expect(out, name).toBe('')
    }
  })

  it('decodes the answers a real fs can give, and refuses the rest without crashing', async () => {
    // A string when the encoding argument was honoured, a Buffer when it was not — both are
    // real, so both must LIST. Everything else must fail cleanly, and none of it may put the
    // word `undefined` on a user's terminal, which is what an unguarded interpolation of a
    // non-string answer looks like.
    for (const value of [SAMPLE, Buffer.from(SAMPLE, 'utf8')]) {
      const { result, out } = await run({ fs: answering(value) })
      expect(result).toMatchObject({ exitCode: 0, shown: 3, total: 5 })
      expect(out).toContain('0.22.0 — 2026-08-27')
    }
    const REFUSED = {
      nothing: undefined,
      null: null,
      'an empty string': '',
      whitespace: '   \n\t\n',
      'a byte-order mark': '\uFEFF',
      'a number': 42,
      NaN: Number.NaN,
      'an empty object': {},
      'an empty Buffer': Buffer.alloc(0),
      'a binary Buffer': Buffer.from([0x00, 0x01, 0xff]),
      // A Uint8Array's `toString` is a comma-joined list of bytes, so the "changelog" that
      // arrives is `35,32,67,…`. Nothing in it parses, which is the right answer — the
      // wrong one is a listing of numbers.
      'a Uint8Array': new TextEncoder().encode(SAMPLE),
      'a prototypeless object': Object.create(null),
      'an object whose toString throws': {
        toString() {
          throw new Error('hostile fs answer')
        },
      },
      // `.toString()` guarantees a call, not a string. This is the shape that slips through a
      // `?.toString() ?? ''` coercion still not a string, which leaves `text.length`
      // `undefined` and prints "readable and undefined characters long" — the assertion below
      // was written for exactly that and only covers it with this row in the table.
      'an object whose toString returns a number': { toString: () => 42 },
    }
    for (const [name, value] of Object.entries(REFUSED)) {
      const { result, out, err } = await run({ fs: answering(value) })
      expect(result, name).toMatchObject({ exitCode: 1, shown: 0, total: 0 })
      expect(out, name).toBe('')
      expect(err, name).toContain(changelogPath())
      expect(err, name).not.toContain('undefined')
      expect(err, name).not.toMatch(/^\s+at\s/m)
    }
  })

  it('hands the parser the file’s bytes verbatim, decoded and otherwise untouched', async () => {
    // The grammar is next door and owns CRLF, BOMs and continuation lines. So the command
    // must not pre-trim, pre-split or normalise what it read — a `text.trim()` here would
    // silently change what `parseChangelog` sees and make the two halves of the feature
    // disagree about the same file. One call, one argument, the decoded text.
    const raw = `\uFEFF## [1.0.0] (2026-01-01)${CR}\n${CR}\n* a bullet${CR}\n`
    for (const value of [raw, Buffer.from(raw, 'utf8')]) {
      const seen = []
      await run({ fs: answering(value), parse: (...args) => (seen.push(args), []) })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toEqual([raw])
    }
  })

  it('survives every shape a parser can answer with', async () => {
    // `parse` is a seam whose contract ("total, never throws") is a promise made in another
    // file. These are the ways that promise can be broken, and the command's job is to cost
    // an exit code rather than a stack trace — including for an `async` parser, whose
    // Promise is not an array and must therefore read as no releases rather than as one.
    const LISTS = {
      'an array of nulls': [null, null],
      'an array of strings': ['1.0.0', '2.0.0'],
      'an array of numbers': [1, 2],
      'sections as a string': [{ version: '1.0.0', sections: 'Features' }],
      'bullets as a string': [{ version: '1.0.0', sections: [{ heading: 'F', bullets: 'abc' }] }],
      'bullets of junk': [{ version: '1.0.0', sections: [{ heading: 'F', bullets: [{}, null, 7, '  ', 'ok'] }] }],
      'a heading of null': [{ version: '1.0.0', sections: [{ heading: null, bullets: ['a'] }] }],
      'a version of null': [{ version: null, date: '2026-01-01', sections: [] }],
      'a frozen graph': Object.freeze([
        Object.freeze({
          version: '1.0.0',
          date: '2026-01-01',
          sections: Object.freeze([Object.freeze({ heading: 'F', bullets: Object.freeze(['a']) })]),
        }),
      ]),
    }
    for (const [name, entries] of Object.entries(LISTS)) {
      const { result, out, err } = await run({ parse: () => entries })
      expect(result, name).toMatchObject({ exitCode: 0, total: entries.length })
      expect(err, name).toBe('')
      // Whatever it could not read is NAMED rather than invented — the same word
      // lib/banner-rows.js uses for a fact it does not have.
      for (const line of out.split('\n')) expect(shapeOf(line || ''), `${name}: ${line}`).not.toMatch(/^unknown:/)
    }
    expect((await run({ parse: () => [null] })).out).toContain('unknown')

    const NOT_A_LIST = {
      null: null,
      undefined: undefined,
      'a string': 'nope',
      'a number': 42,
      'an object': { version: '1.0.0' },
      'a Set': new Set([{ version: '1.0.0', sections: [] }]),
      'a Map': new Map(),
      'a promise (an async parser)': Promise.resolve([{ version: '1.0.0', sections: [] }]),
    }
    for (const [name, entries] of Object.entries(NOT_A_LIST)) {
      const { result, out, err } = await run({ parse: () => entries })
      expect(result, name).toMatchObject({ exitCode: 1, shown: 0, total: 0 })
      expect(out, name).toBe('')
      expect(err, name).toMatch(/no releases/i)
    }

    for (const boom of ['a string nobody should throw', undefined, null, 42, new Error('the grammar gave up')]) {
      const { result, out, err } = await run({
        parse: () => {
          throw boom
        },
      })
      expect(result, String(boom)).toMatchObject({ exitCode: 1, shown: 0, total: 0 })
      expect(out, String(boom)).toBe('')
      expect(err, String(boom)).toMatch(/could not make sense/i)
    }

    for (const parse of [null, 42, 'parseChangelog', {}]) {
      const { result, err } = await run({ parse })
      expect(result, JSON.stringify(parse)).toMatchObject({ exitCode: 1 })
      expect(err, JSON.stringify(parse)).toMatch(/could not make sense/i)
    }
  })

  it('asks the filesystem for one path, once, on every path through the command', async () => {
    // Not just on the happy one. A failure that probed with an `existsSync` first, or that
    // retried the read to build its message, would double the cost of the one thing this
    // command touches — and on the failure most likely to be slow (a stale network mount)
    // that is where a user waits twice. Every fs verb is recorded, so a write shows up too.
    for (const [name, text] of [
      ['a listing', SAMPLE],
      ['a file with no releases', '# Changelog\n'],
    ]) {
      for (const all of [false, true]) {
        const calls = []
        const volume = volumeWith(text)
        const recording = new Proxy(volume, {
          get(target, property) {
            const value = target[property]
            if (typeof value !== 'function') return value
            return (...args) => {
              calls.push({ method: String(property), args })
              return value.apply(target, args)
            }
          },
        })
        await run({ fs: recording, all })
        expect(calls, `${name} (--all ${all})`).toEqual([
          { method: 'readFileSync', args: [changelogPath(), 'utf8'] },
        ])
        expect(volume.toJSON(), `${name} (--all ${all})`).toEqual({ [changelogPath()]: text })
      }
    }
  })

  it('reads the path it was handed and never falls back to its own', async () => {
    // `path` is a seam too, and a fallback here would make the output depend on whether the
    // installed package happens to have a file of its own — the one thing a caller who
    // named a path is asking it not to do.
    const asked = []
    const fs = {
      readFileSync: (path) => {
        asked.push(path)
        if (path === '/elsewhere/CHANGELOG.md') return changelogOf(2)
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      },
    }
    const ok = await run({ fs, path: '/elsewhere/CHANGELOG.md' })
    expect(ok.result).toMatchObject({ exitCode: 0, total: 2 })
    expect(asked).toEqual(['/elsewhere/CHANGELOG.md'])
    // ...and a path that cannot be read is reported AS THE PATH GIVEN, so a reader who
    // pointed the command somewhere is told about that somewhere.
    const bad = await run({ fs, path: '/elsewhere/missing.md' })
    expect(bad.result.exitCode).toBe(1)
    expect(bad.err).toContain('/elsewhere/missing.md')
    expect(bad.err).not.toContain(changelogPath())
  })
})

describe('QA changelogCommand — bytes committed to CHANGELOG.md cannot drive the terminal', () => {
  // release-please writes this file and nobody reviews it as bytes, so it is untrusted input
  // to a renderer that writes straight to a terminal. Everything below is a real accident or
  // a real attack: a hand-edited entry with an escape in it, a generator that emitted a C1,
  // a copy-paste out of a PDF carrying U+2028, a bidi override in a contributor's name.
  const hostileFile = [
    '## [1.0.0](https://example.test/v1.0.0) (2026-01-01)',
    '',
    `### Fea${ESC}[2Jtures`,
    '',
    `* an escape ${ESC}[31m of its own ${ESC}[0m and a C1 ${C1_CSI}31m introducer`,
    `* a NUL ${NUL} a DEL ${DEL} a NEL ${NEL} and a vertical tab ${VT} in one bullet`,
    `* a line separator ${LS} and a paragraph separator ${PS} mid-sentence`,
    `* an override ${RLO}gpj.exe${PDF} in a filename`,
    '* a lone surrogate \uD800 with nothing after it',
    '* tabs\tbetween\twords   and   runs   of   spaces',
    `* ${'x'.repeat(50_000)}`,
    '* ',
    '',
  ].join('\n')

  it('emits no escape, no C1 and no control character of any kind', async () => {
    // Asserted on the RAW chunks: an ANSI-stripping helper would answer this question for
    // the code. A single C1 CSI is enough to move the cursor on xterm, and the sanitiser
    // that only knows ESC is the one this catches.
    //
    // ESC-wide here, unlike on stderr, and not by accident: `out()` never calls `pc`, so the
    // listing carries no legitimate escape in ANY colour mode — which the FORCE_COLOR=3 child
    // process at the bottom of this file confirms against the real binary. And non-vacuous by
    // construction, since the INPUT really does carry every one of these bytes, making a clean
    // output a fact about the renderer rather than about the fixture:
    expect(() => expectOnlyRenderersColour(hostileFile, 'the fixture itself')).toThrow()
    const { d, result } = await run({ fs: volumeWith(hostileFile) })
    expect(result).toMatchObject({ exitCode: 0, shown: 1, total: 1 })
    const raw = d.stdout.chunks.join('')
    for (const byte of [ESC, C1_CSI, NUL, DEL, NEL, VT, CR, LS, PS]) {
      expect(raw, JSON.stringify(byte)).not.toContain(byte)
    }
    expect(raw).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/)
    // Replaced, not dropped: the words survive so a mangled line still reads, and the
    // placeholder says "there is a character here you cannot see".
    expect(d.stdout.output()).toContain(PLACEHOLDER)
    expect(d.stdout.output()).toContain('of its own')
    expect(d.stdout.output()).toContain('introducer')
    expect(d.stdout.output()).toContain('in a filename')
  })

  it('writes one whole line per write, whatever the file put inside a bullet', async () => {
    // "One whole line per write" is what makes the listing safe to pipe, and U+2028 is the
    // character that breaks it in the one place a reader would never look: it is a line
    // terminator to a JavaScript regex and to some terminals, and invisible in a diff.
    const { d } = await run({ fs: volumeWith(hostileFile) })
    expect(d.stdout.chunks.length).toBeGreaterThan(1)
    for (const chunk of d.stdout.chunks) {
      expect(chunk.endsWith('\n')).toBe(true)
      expect(chunk.slice(0, -1)).not.toMatch(/[\n\r\u2028\u2029\u0085]/)
    }
  })

  it('cannot forge the structure the listing’s meaning rests on', async () => {
    // The listing has no colour and no frame, so its structure IS its indentation: column
    // zero is a release, two spaces is a section, four and a bullet glyph is a bullet. A
    // bullet that drew its own version line, or a heading that escaped its indentation,
    // would put words in the file's mouth about which release they belong to. Every line is
    // one of four shapes, and the count of column-zero lines is the count of releases shown
    // plus the header — a number this test derives rather than trusts.
    const text = [
      '## [2.0.0](https://example.test/v2.0.0) (2026-02-02)',
      '',
      '### Features',
      '',
      '* 9.9.9 — 2026-09-09',
      '*   Bug Fixes',
      '* Ralph changelog — 99 releases',
      '* run `ralph changelog --all` for every release',
      '',
      changelogOf(2),
    ].join('\n')
    const { d, result } = await run({ fs: volumeWith(text) })
    expect(result).toMatchObject({ exitCode: 0, shown: 3, total: 3 })
    const lines = d.stdout.lines()
    const shapes = lines.map(shapeOf)
    expect([...new Set(shapes)].sort()).toEqual(['blank', 'bullet', 'column-zero', 'heading'])
    // One header line plus one version line per release shown, and nothing else at column
    // zero: the forged version, the forged heading and the forged header are all bullets.
    expect(shapes.filter((shape) => shape === 'column-zero')).toHaveLength(1 + 3)
    expect(lines.filter((line) => line === 'Ralph changelog — 99 releases')).toEqual([])
    expect(lines.filter((line) => line === '  Bug Fixes')).toEqual([])
    expect(d.stdout.output()).toContain('    • 9.9.9 — 2026-09-09')
    expect(d.stdout.output()).toContain('    • Ralph changelog — 99 releases')
  })

  it('prints a fifty-thousand-character bullet whole, on one line', async () => {
    // The box clips to 60 columns and points here, so this is the one place the bullet
    // exists in full. It wraps in the terminal, which is the honest answer for text a
    // reader came to read — and it is still ONE write, so a pipe sees one line.
    const bullet = `start${'y'.repeat(50_000)}end`
    const { d } = await run({ fs: volumeWith(`## [1.0.0](u) (2026-01-01)\n\n* ${bullet}\n`) })
    const line = d.stdout.lines().find((l) => l.includes('start'))
    expect(line).toBe(`    • ${bullet}`)
    expect(d.stdout.chunks.filter((chunk) => chunk.includes('start'))).toHaveLength(1)
    expect(d.stdout.output()).not.toContain('…')
  })

  it('leaves bidi controls in the text, deliberately, and says so here', async () => {
    // The DOCUMENTED exception, and it is the same one lib/banner-rows.js argues for: a
    // bidi override reorders text a terminal is otherwise printing normally, which is the
    // class of problem a ZWJ emoji sequence also belongs to — and replacing them would
    // mangle a legitimate bullet in Arabic or Hebrew to defend against a rewritten one.
    // Pinned so this reads as a decision rather than as an oversight, and so a future
    // author who changes it changes it on purpose.
    const { d } = await run({ fs: volumeWith(`## [1.0.0](u) (2026-01-01)\n\n* ${RLO}txet${PDF} here\n`) })
    expect(d.stdout.output()).toContain(RLO)
    // What it may NOT do is escape its line: the override is inside a bullet row, four
    // spaces in, and the line count is unchanged by it.
    expect(d.stdout.lines().filter((line) => line.includes(RLO)).map(shapeOf)).toEqual(['bullet'])
  })

  it('collapses whitespace so a wrapped bullet stays one line', async () => {
    // A continuation line is how a long bullet is spelled in this file (the 0.8.0 entry runs
    // to three), and it arrives with its indentation folded in. The renderer's collapse is
    // what keeps the joined text one line and one space wide, whatever the file's wrapping.
    const text = [
      '## [1.0.0](u) (2026-01-01)',
      '',
      '### Features',
      '',
      '* **A breaking change** that runs',
      '  over three lines in the file',
      '\tand is indented with a tab on the last one',
      '',
    ].join('\n')
    const { d } = await run({ fs: volumeWith(text) })
    const bullets = d.stdout.lines().filter((line) => shapeOf(line) === 'bullet')
    expect(bullets).toEqual([
      '    • **A breaking change** that runs over three lines in the file and is indented with a tab on the last one',
    ])
  })

  it('survives a changelog checked out with Windows line endings', async () => {
    // `core.autocrlf` on a Windows checkout, or a tarball repacked by a tool that rewrote
    // the file. A CR reaching a terminal redraws the line that was just printed.
    const { d, result } = await run({ fs: volumeWith(SAMPLE.replaceAll('\n', `${CR}\n`)) })
    expect(result).toMatchObject({ exitCode: 0, shown: 3, total: 5 })
    expect(d.stdout.chunks.join('')).not.toContain(CR)
    expect(d.stdout.lines()).toContain('0.22.0 — 2026-08-27')
  })

  it('prints no URL, because the grammar flattened them', async () => {
    // Every heading and bullet in the real file carries two or three GitHub links. The
    // parser flattens them to their labels (`#63`, `a6c37ba`) and this command renders from
    // that same text — which is what keeps the box and the listing saying the same thing,
    // and what keeps a release note readable rather than being three quarters URL.
    const { out } = await run({ all: true })
    expect(out).not.toContain('https://')
    expect(out).toContain('(#63)')
    expect(out).toContain('0.22.0 — 2026-08-27')
  })
})

describe('QA changelogCommand — pure, idempotent, and free of the environment', () => {
  it('prints byte-identical output twice, and again after the count changed', async () => {
    // No cache, no memo, no "since you last looked" state: the file inside the install is
    // the whole answer, so two runs in one process are the same run. The third read is the
    // one that matters — a memo on the module would make the second `ralph changelog` in a
    // shell session report the release notes of the version that was installed when the
    // first one ran, which is exactly wrong right after an `npm i -g`.
    let text = changelogOf(2)
    const fs = { readFileSync: () => text }
    const first = await run({ fs })
    const second = await run({ fs })
    expect(second.out).toBe(first.out)
    expect(second.result).toEqual(first.result)
    text = changelogOf(5)
    const third = await run({ fs })
    expect(third.result).toMatchObject({ shown: 3, total: 5 })
    expect(third.out).not.toBe(first.out)
  })

  it('mutates neither the options it was handed nor the entries it was given', async () => {
    // The options bag is a caller's object — `ralph start` and #75's reuse of this listing
    // would both pass one they keep — and the entries are the parser's output, which a
    // caller may hold to render twice. A `entries.reverse()` or `options.all = true` here
    // would be invisible to every assertion about stdout.
    const entries = [
      { version: '2.0.0', date: '2026-02-02', sections: [{ heading: 'Features', bullets: ['a', 'b'] }] },
      { version: '1.0.0', date: null, sections: [] },
    ]
    const snapshot = structuredClone(entries)
    const options = deps({ parse: () => entries, all: false })
    const keys = Object.keys(options).join(',')
    await changelogCommand(options)
    expect(entries).toEqual(snapshot)
    expect(options.all).toBe(false)
    expect(Object.keys(options).join(',')).toBe(keys)
  })

  it('reaches no network, spawns nothing, and reads no clock', async () => {
    // The design's whole justification: CHANGELOG.md is in package.json's `files`, so the
    // answer is already on disk and the command is instant and offline. A tripwire rather
    // than an output check, because a `fetch` that failed fast would leave the listing
    // identical and the command dependent on a network it claims not to need.
    const realFetch = globalThis.fetch
    const reached = []
    globalThis.fetch = (...args) => {
      reached.push(args)
      throw new Error('the changelog must not reach the network')
    }
    try {
      const { result } = await run({ all: true })
      expect(result).toMatchObject({ exitCode: 0, shown: 5, total: 5 })
      expect(reached).toEqual([])
      // ...and the failure path is the one a "let me check the releases API instead"
      // fallback would most plausibly be added to.
      const failed = await run({ fs: new Volume() })
      expect(failed.result.exitCode).toBe(1)
      expect(reached).toEqual([])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('names no capability it does not need, across its whole import graph', async () => {
    // The dev's spec greps this one file. That is the file a `fetch` would be added to, but
    // it is not the only file this command's behaviour comes out of: the path resolver, the
    // grammar and the failure-wording module are all in the same answer, and a network call
    // or a cwd read in any of them is a network call or a cwd read in `ralph changelog`.
    // So the graph is walked, and the bare imports are an ALLOWLIST — a new dependency in
    // any of the five files has to be added here on purpose.
    const seen = new Map()
    const bare = new Set()
    const walk = (file) => {
      if (seen.has(file)) return
      const code = codeWithoutComments(file)
      seen.set(file, code)
      for (const [, spec] of code.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
        if (spec.startsWith('.')) walk(resolve(dirname(file), spec))
        else bare.add(spec)
      }
    }
    walk(SOURCE)
    expect([...seen.keys()].map((file) => file.slice(REPO.length)).sort()).toEqual([
      'lib/changelog-file.js',
      'lib/changelog.js',
      'lib/commands/changelog.js',
      'lib/install-failure.js',
      'lib/paths.js',
    ])
    expect([...bare].sort()).toEqual(['node:fs', 'node:path', 'node:url', 'picocolors'])
    // TWO SETS, and the difference is the point. GRAPH-WIDE is only what an AC of THIS command
    // depends on inside a file it does not own: the network and spawn verbs (offline is a
    // promise about the whole answer, so a `fetch` two modules down breaks it here) and
    // `process.cwd` (the "never the cwd's changelog" AC holds because lib/paths.js resolves
    // RALPH_HOME from its own `import.meta.url` — a cwd read THERE is the one way that AC
    // fails without this file changing a line).
    //
    // ENTRY-ONLY is everything else. A clock, a random, an env read and the fs write verbs are
    // constraints on how this command answers, not on the shared modules it borrows:
    // lib/paths.js belongs to every command, and a `RALPH_HOME` env override in it is a
    // legitimate change that must not fail as `changelog.qa.test.js` telling a maintainer that
    // "lib/paths.js reaches for /process\s*\.\s*env/" — a red test two modules from the edit,
    // in a file about a command that never asked for the constraint. Same split as
    // doctor.version-line.qa.test.js's graph audit, which walks the whole graph for
    // spawn/socket capability and checks nothing else across it. Widen this only for a
    // pattern that can break an AC from inside a file listed above.
    const GRAPH_WIDE = [
      /\bfetch\s*\(/,
      /node:https?/,
      /node:net\b/,
      /node:dgram\b/,
      /child_process/,
      /\bexeca\b/,
      /XMLHttpRequest/,
      /process\s*\.\s*cwd/,
    ]
    const ENTRY_ONLY = [
      /process\s*\.\s*env/,
      /\bhomedir\b/,
      /\bnew Date\b/,
      /Math\s*\.\s*random/,
      /writeFileSync|appendFileSync|mkdirSync|rmSync/,
    ]
    for (const [file, code] of seen) {
      const why = file.slice(REPO.length)
      for (const forbidden of file === SOURCE ? [...GRAPH_WIDE, ...ENTRY_ONLY] : GRAPH_WIDE) {
        expect(code, `${why} reaches for ${forbidden}`).not.toMatch(forbidden)
      }
    }
    // The entry file is in the walk under the same key the split keys off, so ENTRY_ONLY
    // cannot silently stop being checked at all.
    expect([...seen.keys()]).toContain(SOURCE)
  })
})

describe('QA ralph changelog — the real binary, against an install it does not own', () => {
  // THE AC NO INJECTED fs CAN PROVE. The dev's end-to-end spawn reads this checkout's own
  // CHANGELOG.md from a temp cwd, which cannot fail — so it cannot show the exit code, and
  // it cannot tell "read the install's file" apart from "found nothing in the cwd either".
  //
  // A FAKE INSTALL can. `RALPH_HOME` is resolved from lib/paths.js's own `import.meta.url`,
  // so a copy of bin/ and lib/ in a temp directory IS a Ralph install whose changelog this
  // test controls: it can be missing, be prose, be a directory, or hold five releases
  // nobody else's file has. node_modules is a symlink to this checkout's, so the copy costs
  // ~25ms and no install.
  let install
  let cwd
  const FIVE = changelogOf(5)

  const ralph = (args, { env = {}, dir = cwd } = {}) =>
    spawnSync(process.execPath, [join(install, 'bin', 'ralph.js'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    })

  const treeOf = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('node_modules'))
      .map((entry) => join(entry.parentPath ?? entry.path, entry.name).slice(dir.length))
      .sort()

  beforeAll(() => {
    install = realpathSync(mkdtempSync(join(tmpdir(), 'ralph-changelog-install-')))
    for (const entry of ['bin', 'lib', 'package.json']) {
      cpSync(join(REPO, entry), join(install, entry), {
        recursive: true,
        // The specs are not part of an install, and leaving them out keeps the copy at
        // ~650KB — small enough that this block costs one `cp` and no npm.
        filter: (src) => !src.endsWith('.test.js'),
      })
    }
    symlinkSync(join(REPO, 'node_modules'), join(install, 'node_modules'))

    // A working directory that is a Ralph project with release notes of its OWN. This is
    // the arrangement a global install actually runs in, and the decoy is the failure a
    // `join(process.cwd(), 'CHANGELOG.md')` would produce: somebody else's changelog.
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ralph-changelog-cwd-')))
    writeFileSync(join(cwd, 'CHANGELOG.md'), changelogOf(1).replace(/1\.0\.0/g, '99.99.99'))
    writeFileSync(join(cwd, 'ralph.config.sh'), 'TASK_SOURCE=folder\n')
    mkdirSync(join(cwd, '.ralph'), { recursive: true })
  })

  afterAll(() => {
    for (const dir of [install, cwd]) if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('prints the install’s releases from a project that has a changelog of its own', () => {
    writeFileSync(join(install, 'CHANGELOG.md'), FIVE)
    const result = ralph(['changelog'])
    expect(result.stderr, result.stderr).toBe('')
    expect(result.status).toBe(0)
    // The whole listing, byte for byte, end to end: resolution, read, parse, render, exit.
    expect(result.stdout).toBe(
      [
        'Ralph changelog — the 3 newest of 5 releases',
        'run `ralph changelog --all` for every release',
        '',
        '5.0.0 — 2026-01-01',
        '  Features',
        '    • bullet 1 of 5.0.0',
        '',
        '4.0.0 — 2026-01-02',
        '  Features',
        '    • bullet 1 of 4.0.0',
        '',
        '3.0.0 — 2026-01-03',
        '  Features',
        '    • bullet 1 of 3.0.0',
        '',
      ].join('\n'),
    )
    // Not the decoy sitting in the working directory, and not a word from it.
    expect(result.stdout).not.toContain('99.99.99')
    // `--all` reaches the oldest entry, and only `--all` does.
    const every = ralph(['changelog', '--all'])
    expect(every.status).toBe(0)
    expect(every.stdout).toContain('1.0.0 — 2026-01-05')
    expect(every.stdout).toContain('Ralph changelog — 5 releases')
    expect(every.stdout).not.toContain('--all')
    expect(every.stdout).not.toContain('99.99.99')
  })

  it('prints the same bytes on a second run and writes nothing anywhere', () => {
    // Idempotent through the real binary, and stateless: no cache file, no "last seen
    // release" stamp in the install, in the project, or in the sandbox HOME. A stamp is the
    // one thing that would make the second run of this command differ from the first.
    writeFileSync(join(install, 'CHANGELOG.md'), FIVE)
    const before = { install: treeOf(install), cwd: treeOf(cwd) }
    const first = ralph(['changelog'])
    const second = ralph(['changelog'])
    expect(first.status).toBe(0)
    expect(second.stdout).toBe(first.stdout)
    expect(treeOf(install)).toEqual(before.install)
    expect(treeOf(cwd)).toEqual(before.cwd)
  })

  it('ignores the environment it was invoked from', () => {
    // #41, at the seams a shell can move: the path comes from the module's own location, so
    // a RALPH_HOME, an XDG_CONFIG_HOME or a COLUMNS in the environment cannot change one
    // byte of this listing — and NO_COLOR cannot either, because there is no colour in it.
    writeFileSync(join(install, 'CHANGELOG.md'), FIVE)
    const plain = ralph(['changelog'])
    const hostile = ralph(['changelog'], {
      env: {
        RALPH_HOME: '/nowhere',
        RALPH_CHANGELOG: '/nowhere/CHANGELOG.md',
        XDG_CONFIG_HOME: join(cwd, 'xdg'),
        TASK_SOURCE: 'github',
        COLUMNS: '20',
        NO_COLOR: '1',
        TERM: 'dumb',
      },
    })
    expect(hostile.status).toBe(0)
    expect(hostile.stdout).toBe(plain.stdout)
  })

  it('paints nothing on stdout even with colour forced on', () => {
    // The in-process specs run with picocolors disabled (no TTY), so "not one escape byte"
    // is answered there by the environment rather than by the code. This is the run where
    // colour is ON: a listing is read in a pager, piped into `grep` and pasted into an
    // issue, and the repo's palette is a STATUS vocabulary that a list of releases has no
    // business borrowing.
    writeFileSync(join(install, 'CHANGELOG.md'), FIVE)
    const result = ralph(['changelog', '--all'], { env: { FORCE_COLOR: '3', TERM: 'xterm-256color' } })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain(ESC)
    expect(result.stdout).not.toContain(C1_CSI)
  })

  it('fails with the same words in colour and out of it', () => {
    // THE CROSS-MODE PROOF, and the only place it can honestly be made. picocolors resolves
    // once, at import, from the real environment (`!!env.CI` is enough — picocolors.js:4), so
    // an in-process spec cannot visit both modes: `vi.resetModules()` does not reach an
    // externalised CJS dependency's require cache, and a spec that thinks it rebuilt
    // picocolors when it did not is worse than one that never tried. A child process re-makes
    // the decision for real, and `ralph()` passes an explicit env, so each mode here is
    // commanded rather than inherited — on a laptop and on Actions alike.
    //
    // This is the assertion the ESC-wide version was reaching for: the failure a reader pastes
    // into an issue is the same sentence in both modes, and colour is the only difference.
    rmSync(join(install, 'CHANGELOG.md'), { force: true })
    const lit = ralph(['changelog'], { env: { FORCE_COLOR: '3', TERM: 'xterm-256color' } })
    const dark = ralph(['changelog'], { env: { NO_COLOR: '1' } })
    for (const [mode, result] of [
      ['colour on', lit],
      ['colour off', dark],
    ]) {
      expect(result.status, mode).toBe(1)
      expect(result.stdout, mode).toBe('')
      expectOnlyRenderersColour(result.stderr, mode)
    }
    // Colour really was on in one and off in the other — without this the comparison below
    // could be a string against itself, which is exactly how the original bug hid.
    expect(lit.stderr).toContain(ESC)
    expect(dark.stderr).not.toContain(ESC)
    // ...and stripping it leaves the same bytes.
    expect(strip(lit.stderr)).toBe(dark.stderr)
    expect(dark.stderr).toContain(join(install, 'CHANGELOG.md'))
    expect(dark.stderr).toMatch(/could not read/i)
    writeFileSync(join(install, 'CHANGELOG.md'), FIVE)
  })

  it('exits 1 with a named message and no stack trace for every unreadable install', () => {
    // The failure AC, end to end, through the exit code the CLI actually returns — which no
    // injected fs can reach, because `process.exit` lives in bin/ralph.js. Three installs:
    // pruned, prose in place of the file, and a directory where the file should be.
    const changelog = join(install, 'CHANGELOG.md')
    const CASES = {
      'a pruned install': { prepare: () => rmSync(changelog, { force: true }), says: /could not read/i },
      'prose in its place': { prepare: () => writeFileSync(changelog, '# Changelog\n\nAll notable changes.\n'), says: /no releases/i },
      'a truncated write': { prepare: () => writeFileSync(changelog, ''), says: /no releases/i },
      'a directory in its place': {
        prepare: () => {
          rmSync(changelog, { recursive: true, force: true })
          mkdirSync(changelog, { recursive: true })
        },
        says: /could not read/i,
      },
    }
    for (const [name, { prepare, says }] of Object.entries(CASES)) {
      rmSync(changelog, { recursive: true, force: true })
      prepare()
      for (const args of [['changelog'], ['changelog', '--all']]) {
        const result = ralph(args)
        const why = `${name} (${args.join(' ')})`
        expect(result.status, why).toBe(1)
        expect(result.stdout, why).toBe('')
        expect(result.stderr, why).toMatch(says)
        expect(result.stderr, why).toContain(join(install, 'CHANGELOG.md'))
        // Never a stack trace, and never Node's own unhandled-rejection report — which is
        // what a failure that threw instead of returning an exit code would look like.
        expect(result.stderr, why).not.toMatch(/^\s+at\s/m)
        expect(result.stderr, why).not.toContain('node:internal')
        expect(result.stderr, why).not.toContain('file://')
        expect(result.stderr, why).not.toContain('UnhandledPromiseRejection')
        expect(result.stderr, why).not.toMatch(/\.js:\d+:\d+/)
        expect(result.stderr.split('\n').filter(Boolean).length, why).toBeLessThanOrEqual(3)
      }
    }
    rmSync(changelog, { recursive: true, force: true })
    writeFileSync(changelog, FIVE)
  })

  it('refuses an unknown flag without printing a listing or a stack trace', () => {
    // A typo (`--al`, `-a`, `--everything`) must not silently print the default view as if
    // the flag had been understood, and must not answer a typo with a stack trace.
    writeFileSync(join(install, 'CHANGELOG.md'), FIVE)
    for (const flag of ['--al', '-a', '--everything', '--all-releases']) {
      const result = ralph(['changelog', flag])
      expect(result.status, flag).not.toBe(0)
      expect(result.stdout, flag).toBe('')
      expect(result.stderr, flag).toMatch(/unknown option/i)
      expect(result.stderr, flag).not.toMatch(/^\s+at\s/m)
    }
  })

  it('appears in the help of an install nobody configured, with --all and no network claim', () => {
    // Both help screens from the fake install, in a project directory that is not this
    // checkout: `--help` must not depend on the changelog being readable at all, which is
    // what a reader who cannot run the command needs.
    rmSync(join(install, 'CHANGELOG.md'), { recursive: true, force: true })
    const top = ralph(['--help'])
    expect(top.status).toBe(0)
    expect(top.stdout).toMatch(/^\s*changelog\b/m)
    const own = ralph(['changelog', '--help'])
    expect(own.status).toBe(0)
    expect(own.stdout).toMatch(/--all/)
    expect(own.stdout).toMatch(/no network/i)
    writeFileSync(join(install, 'CHANGELOG.md'), FIVE)
  })
})
