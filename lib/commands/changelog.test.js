// #71 — the spec for `ralph changelog`: the command the banner's `more` row promises.
//
// The box (#70) shows three bullets of the newest release and then says "run `ralph
// changelog` for the rest". This is the rest. What the tests below pin is what makes that
// pointer honest and what makes the command safe to reach for from anywhere:
//
//   1. THE NEWEST FEW BY DEFAULT, EVERY ONE UNDER `--all`. The default view is not a
//      shorter version of the box: it prints the newest entry WHOLE (the box's three-bullet
//      clip is exactly what a reader came here to undo), plus the two releases behind it.
//   2. IT WORKS OUTSIDE A RALPH PROJECT. No `ralph.config.sh`, no `.ralph/`, no git repo,
//      and no working directory at all — the file comes from the INSTALLED package, so the
//      injected fs is asked for exactly one path and it is `changelogPath()`.
//   3. A FILE IT CANNOT READ EXITS NON-ZERO AND SAYS SO, naming the path and the reason on
//      one bounded line. This is where this command deliberately DIVERGES from
//      lib/changelog-file.js, whose every failure is `[]` because its caller is the banner:
//      a user who typed a command about the changelog is owed the failure, not silence.
//   4. NO NETWORK, EVER. The file ships in the tarball; a releases API call is the thing
//      this command must not become.
//
// The fs is INJECTED everywhere but the one end-to-end spawn at the bottom, whose whole
// point is that a real `ralph changelog` in a directory that is no Ralph project prints the
// real shipped file. Every crafted changelog is a STRING LITERAL rather than a fixture, for
// the reason lib/changelog.js gives: the shapes that matter here (a release with no date, a
// bullet with no section, a release with nothing under it) are three lines of text each.

import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { Volume } from 'memfs'
import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { changelogPath } from '../changelog-file.js'
import { changelogCommand, ChangelogAbort } from './changelog.js'

const BIN = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))
const SOURCE = new URL('./changelog.js', import.meta.url)

// The five-release sample the #70 specs read, so the two halves of the changelog feature
// are asserted against the same file rather than against two authors' idea of one.
const SAMPLE = readFileSync(new URL('../__fixtures__/changelog-sample.md', import.meta.url), 'utf8')
const SAMPLE_VERSIONS = ['0.22.0', '0.21.0', '0.19.1', '0.8.0', '0.1.0']

// A newest release with MORE bullets than the box shows. The sample's newest has two, so it
// cannot fail the "prints the rest" claim the banner's pointer makes; this can.
const FIVE_BULLETS = [
  '# Changelog',
  '',
  '## [2.0.0](https://example.test/compare/v1.9.0...v2.0.0) (2026-03-03)',
  '',
  '### Features',
  '',
  '* first bullet',
  '* second bullet',
  '* third bullet',
  '* fourth bullet',
  '* fifth bullet',
  '',
].join('\n')

const ONE_ENTRY = [
  '## [2.0.0](https://example.test/compare/v1.9.0...v2.0.0) (2026-03-03)',
  '',
  '### Features',
  '',
  '* a feature',
  '',
  '### Bug Fixes',
  '',
  '* a fix',
  '',
].join('\n')

// `## [0.1.0] - Unreleased` — a heading with no parenthesised day. The parser answers
// `date: null` and the renderer must not print the separator that would have joined it.
const NO_DATE = ['## [0.1.0] - Unreleased', '', '### Added', '', '- the CLI', ''].join('\n')

// A bullet with no `###` above it. The parser files it under `heading: ''`, which must not
// reach the terminal as a line of indentation.
const NO_SECTION = [
  '## [1.0.0](https://example.test/v1.0.0) (2026-01-01)',
  '',
  '* a bullet with no section above it',
  '',
].join('\n')

// A release with nothing under it at all. `parseChangelog` keeps it (a release that says
// nothing is still a release), so this command has to have an answer for it.
const NO_SECTIONS = ['## [3.0.0](https://example.test/v3.0.0) (2026-04-04)', ''].join('\n')

const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    chunks,
    output: () => strip(chunks.join('')),
    lines: () => strip(chunks.join('')).split('\n').slice(0, -1),
  }
}

/** A memfs volume holding `text` at the path the command resolves on its own. */
const volumeWith = (text) => Volume.fromJSON({ [changelogPath()]: text }, '/')

const deps = (overrides = {}) => ({
  stdout: makeStream(),
  stderr: makeStream(),
  fs: volumeWith(SAMPLE),
  ...overrides,
})

// An fs that records every path it is asked for, so "one local read and nothing else" is
// asserted rather than assumed.
function recordingFs(text) {
  const asked = []
  return {
    asked,
    readFileSync: (path, encoding) => {
      asked.push({ path, encoding })
      return text
    },
  }
}

const throwingFs = (boom) => ({
  readFileSync: () => {
    throw boom
  },
})

describe('changelogCommand — the default view (#71)', () => {
  it('prints the newest entries with their versions, dates and bullets', async () => {
    const d = deps()
    const result = await changelogCommand(d)
    expect(result.exitCode).toBe(0)
    const out = d.stdout.output()
    expect(d.stdout.lines()).toContain('0.22.0 — 2026-08-27')
    expect(out).toContain('a digest section in `ralph status`')
    expect(out).toContain('Features')
  })

  it('shows the three newest releases and stops there', async () => {
    const d = deps()
    const result = await changelogCommand(d)
    expect(result).toMatchObject({ exitCode: 0, shown: 3, total: 5 })
    const out = d.stdout.output()
    for (const version of SAMPLE_VERSIONS.slice(0, 3)) expect(out).toContain(version)
    for (const version of SAMPLE_VERSIONS.slice(3)) expect(out).not.toContain(version)
  })

  it('shows every bullet of the newest entry — the rest the banner points at', async () => {
    // The whole reason this command exists. The box clips the newest release to three
    // bullets and says "run `ralph changelog` for the rest"; a default view that clipped
    // too would make that a dead end.
    const d = deps({ fs: volumeWith(FIVE_BULLETS) })
    await changelogCommand(d)
    const out = d.stdout.output()
    for (const bullet of ['first', 'second', 'third', 'fourth', 'fifth']) {
      expect(out, `the newest entry lost its ${bullet} bullet`).toContain(`${bullet} bullet`)
    }
  })

  it('renders an entry as its version line, its headings and its bullets', async () => {
    // The one place the exact shape is pinned, so the assertions elsewhere can read
    // `toContain` without the layout going unspecified.
    const d = deps({ fs: volumeWith(ONE_ENTRY) })
    await changelogCommand(d)
    expect(d.stdout.lines()).toEqual([
      'Ralph changelog — 1 release',
      '',
      '2.0.0 — 2026-03-03',
      '  Features',
      '    • a feature',
      '  Bug Fixes',
      '    • a fix',
    ])
  })

  it('keeps the sections and bullets in the order the file lists them', async () => {
    const d = deps()
    await changelogCommand(d)
    const out = d.stdout.output()
    const at = (needle) => out.indexOf(needle)
    expect(at('0.22.0')).toBeLessThan(at('0.21.0'))
    expect(at('0.21.0')).toBeLessThan(at('0.19.1'))
    // 0.21.0 lists Features above Bug Fixes, and each bullet under its own heading.
    expect(at('GIF-to-sprite')).toBeLessThan(at('Bug Fixes'))
    expect(at('Bug Fixes')).toBeLessThan(at('never finish a turn'))
  })

  it('prints the whole bullet, never clipped — the box is what clips', async () => {
    const bullet = `x${'y'.repeat(300)}z`
    const d = deps({
      fs: volumeWith(['## [1.0.0](u) (2026-01-01)', '', `* ${bullet}`, ''].join('\n')),
    })
    await changelogCommand(d)
    expect(d.stdout.output()).toContain(bullet)
    expect(d.stdout.output()).not.toContain('…')
  })

  it('exits 0 and writes nothing to stderr', async () => {
    const d = deps()
    const result = await changelogCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.stderr.output()).toBe('')
  })

  it('writes one whole line per write', async () => {
    const d = deps()
    await changelogCommand(d)
    expect(d.stdout.chunks.length).toBeGreaterThan(1)
    for (const chunk of d.stdout.chunks) {
      expect(chunk.endsWith('\n')).toBe(true)
      expect(chunk.slice(0, -1)).not.toContain('\n')
    }
  })

  it('emits not one escape byte in the listing itself', async () => {
    // A release listing is read in a pager, piped into `grep`, pasted into an issue. The
    // repo's palette (red / yellow / green) is a STATUS vocabulary and a list of releases
    // carries no status, so the structure here is indentation. Failures still paint red.
    const d = deps()
    await changelogCommand(d)
    expect(d.stdout.chunks.join('')).not.toContain('\u001b')
  })

  it('says how many of how many it is showing, and how to see the rest', async () => {
    const d = deps()
    await changelogCommand(d)
    const out = d.stdout.output()
    expect(out).toContain('3')
    expect(out).toContain('5')
    expect(out).toContain('ralph changelog --all')
  })
})

describe('changelogCommand — `--all` (#71)', () => {
  it('prints every entry in the file', async () => {
    const d = deps({ all: true })
    const result = await changelogCommand(d)
    expect(result).toMatchObject({ exitCode: 0, shown: 5, total: 5 })
    for (const version of SAMPLE_VERSIONS) expect(d.stdout.output()).toContain(version)
  })

  it('points at nothing, because there is no rest', async () => {
    const d = deps({ all: true })
    await changelogCommand(d)
    expect(d.stdout.output()).not.toContain('--all')
  })

  it('does not point at --all when the file is shorter than the default anyway', async () => {
    const d = deps({ fs: volumeWith(ONE_ENTRY) })
    await changelogCommand(d)
    expect(d.stdout.output()).not.toContain('--all')
  })
})

describe('changelogCommand — it works outside a Ralph project (#71)', () => {
  it('asks the fs for exactly one file, once, and it is the installed package’s own', async () => {
    for (const all of [false, true]) {
      const fs = recordingFs(SAMPLE)
      const result = await changelogCommand(deps({ fs, all }))
      expect(result.exitCode, `--all: ${all}`).toBe(0)
      expect(fs.asked).toEqual([{ path: changelogPath(), encoding: 'utf8' }])
    }
  })

  it('runs against a filesystem holding nothing but that file', async () => {
    // No ralph.config.sh, no .ralph/, no git repo, no cwd — a global install standing in
    // somebody's home directory. memfs throws ENOENT for anything else, so a config probe
    // added to this command later fails here rather than on a user's machine.
    const d = deps({ fs: volumeWith(SAMPLE) })
    const result = await changelogCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.stderr.output()).toBe('')
  })

  it('honours an explicit path, and then reads no other', async () => {
    const path = '/elsewhere/CHANGELOG.md'
    const fs = recordingFs(ONE_ENTRY)
    const result = await changelogCommand(deps({ fs, path }))
    expect(result.exitCode).toBe(0)
    expect(fs.asked.map((call) => call.path)).toEqual([path])
  })

  it('reads no working directory to get there', async () => {
    // Asserted in the source, because the suite's own cwd is the package root: a
    // `join(process.cwd(), 'CHANGELOG.md')` would pass every behavioural test in this file
    // and show a user their OWN project's release notes. Same method as
    // lib/changelog-file.test.js.
    const code = codeWithoutComments(SOURCE)
    expect(code).not.toMatch(/process\s*\.\s*cwd/)
    expect(code).not.toMatch(/\bcwd\b/)
    expect(code).toMatch(/changelogPath/)
  })
})

describe('changelogCommand — a file it cannot read (#71)', () => {
  it('exits non-zero and names the path when the file is not there', async () => {
    const d = deps({ fs: new Volume() })
    const result = await changelogCommand(d)
    expect(result.exitCode).not.toBe(0)
    expect(d.stderr.output()).toContain(changelogPath())
    expect(d.stderr.output()).toMatch(/could not read/i)
    // Nothing half-printed on stdout: a caller piping this into a pager gets the failure
    // on the stream failures belong on, and an empty document on the other.
    expect(d.stdout.output()).toBe('')
  })

  it('names the underlying reason, on one bounded line, with no stack trace', async () => {
    const boom = new Error(
      `EACCES: permission denied, open '${changelogPath()}'`,
    )
    const d = deps({ fs: throwingFs(boom) })
    const result = await changelogCommand(d)
    expect(result.exitCode).not.toBe(0)
    const out = d.stderr.output()
    expect(out).toContain('EACCES')
    // A stack trace is what "never a stack trace" means: no `    at …` frames, no internal
    // module paths, and no `Error:` prefix carried through from a raw throw.
    expect(out).not.toMatch(/^\s+at\s/m)
    expect(out).not.toContain('node:internal')
    expect(out).not.toContain(boom.stack.split('\n')[1].trim())
    expect(out.length).toBeLessThan(600)
    for (const chunk of d.stderr.chunks) {
      expect(chunk.slice(0, -1)).not.toContain('\n')
    }
  })

  it('reports whatever the read throws, including things nobody should throw', async () => {
    for (const boom of [
      Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' }),
      new TypeError('The "path" argument must be of type string.'),
      'a string nobody should throw',
      null,
    ]) {
      const d = deps({ fs: throwingFs(boom) })
      const result = await changelogCommand(d)
      expect(result.exitCode, String(boom)).not.toBe(0)
      expect(d.stderr.output(), String(boom)).toContain(changelogPath())
    }
  })

  it('reports an fs that is not one at all', async () => {
    for (const fs of [{}, null, 42, { readFileSync: 'nope' }]) {
      const d = deps({ fs })
      const result = await changelogCommand(d)
      expect(result.exitCode, JSON.stringify(fs)).not.toBe(0)
      expect(d.stderr.output(), JSON.stringify(fs)).toMatch(/could not read/i)
    }
  })

  it('reports a parse that throws instead of crashing the command', async () => {
    // `parseChangelog` is total by contract, and that contract is pinned next door — this
    // is the seam that keeps a broken promise costing an exit code rather than a stack
    // trace, the same insurance lib/changelog-file.js buys with its single catch.
    const d = deps({
      parse: () => {
        throw new Error('the grammar gave up')
      },
    })
    const result = await changelogCommand(d)
    expect(result.exitCode).not.toBe(0)
    expect(d.stderr.output()).toContain(changelogPath())
    expect(d.stderr.output()).not.toMatch(/^\s+at\s/m)
  })

  it('never throws, whatever it is handed', async () => {
    for (const overrides of [
      { fs: new Volume() },
      { fs: {} },
      { fs: null },
      { fs: { readFileSync: () => ({}) } },
      { parse: () => null },
      { parse: 'not a function' },
    ]) {
      await expect(changelogCommand(deps(overrides))).resolves.toBeTruthy()
    }
  })
})

describe('changelogCommand — a file with no releases in it (#71)', () => {
  const emptyish = ['', '   ', '\n\n\n', 'not a changelog at all', '## Contributing\n- be kind\n']

  it('exits non-zero, names the file and says it holds no releases', async () => {
    for (const text of emptyish) {
      const d = deps({ fs: volumeWith(text) })
      const result = await changelogCommand(d)
      expect(result, JSON.stringify(text)).toMatchObject({ exitCode: 1, shown: 0, total: 0 })
      const out = d.stderr.output()
      expect(out, JSON.stringify(text)).toContain(changelogPath())
      expect(out, JSON.stringify(text)).toMatch(/no releases/i)
      expect(d.stdout.output(), JSON.stringify(text)).toBe('')
    }
  })

  it('says something different than it says for a file it could not read', async () => {
    // The two failures are two different repairs: one is a pruned or unreadable install,
    // the other is a file that is there and says nothing. A single message for both would
    // send a user looking for the wrong problem.
    const unreadable = deps({ fs: new Volume() })
    await changelogCommand(unreadable)
    const noReleases = deps({ fs: volumeWith('# Changelog\n') })
    await changelogCommand(noReleases)
    expect(unreadable.stderr.output()).not.toBe(noReleases.stderr.output())
    expect(noReleases.stderr.output()).not.toMatch(/could not read/i)
  })

  it('prints a release that has no sections at all rather than calling the file empty', async () => {
    const d = deps({ fs: volumeWith(NO_SECTIONS) })
    const result = await changelogCommand(d)
    expect(result).toMatchObject({ exitCode: 0, shown: 1, total: 1 })
    expect(d.stdout.lines()).toContain('3.0.0 — 2026-04-04')
  })
})

describe('changelogCommand — the shapes the parser can hand it (#71)', () => {
  it('prints no separator for a release with no date', async () => {
    const d = deps({ fs: volumeWith(NO_DATE) })
    await changelogCommand(d)
    const lines = d.stdout.lines()
    expect(lines).toContain('0.1.0')
    for (const line of lines) expect(line).not.toMatch(/[—-]\s*$/)
  })

  it('prints no empty heading line for a bullet with no section', async () => {
    const d = deps({ fs: volumeWith(NO_SECTION) })
    await changelogCommand(d)
    const lines = d.stdout.lines()
    expect(d.stdout.output()).toContain('a bullet with no section above it')
    // A blank separator is a blank line; a line of nothing but indentation is a heading
    // that was never there.
    for (const line of lines) expect(line === '' || line.trim() !== '').toBe(true)
  })

  it('never lets the file’s own bytes drive the terminal', async () => {
    // `parseChangelog` hands text over verbatim and says so — sanitising for display is the
    // renderer's job. This is the renderer, and a changelog carrying an escape sequence (a
    // hand-edited entry, a generator gone wrong) must not repaint the screen of somebody who
    // asked to READ it. Asserted on the RAW chunks, because the ANSI strip above would
    // otherwise answer this question for the code.
    const hostile = [
      '## [1.0.0](u) (2026-01-01)',
      '',
      '### Fea\u001b[2Jtures',
      '',
      '* a bullet with \u001b[31mcolour\u001b[0m of its own',
      '',
    ].join('\n')
    const d = deps({ fs: volumeWith(hostile) })
    const result = await changelogCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.stdout.chunks.join('')).not.toContain('\u001b')
    // Replaced rather than dropped: the words survive, the instruction does not.
    expect(d.stdout.output()).toContain('a bullet with')
    expect(d.stdout.output()).toContain('colour')
  })
})

describe('changelogCommand — no network, by construction (#71)', () => {
  it('reaches for no socket, no subprocess and no registry', async () => {
    // The file ships inside the package (package.json `files`), which is what makes this
    // command answerable offline and instantly. A releases API call is the thing it must
    // not become — and the absence of a capability cannot be shown by exercising happy
    // paths, so it is asserted in the source with the prose stripped out.
    const code = codeWithoutComments(SOURCE)
    for (const forbidden of [
      /\bfetch\s*\(/,
      /node:https?/,
      /node:net\b/,
      /node:dgram\b/,
      /child_process/,
      /\bexeca\b/,
      /XMLHttpRequest/,
      /update-check/,
    ]) {
      expect(code, `the command reaches for ${forbidden}`).not.toMatch(forbidden)
    }
  })
})

describe('ChangelogAbort', () => {
  it('is an Error carrying an exit code, defaulting to 1', () => {
    const abort = new ChangelogAbort('nope')
    expect(abort).toBeInstanceOf(Error)
    expect(abort.message).toBe('nope')
    expect(abort.exitCode).toBe(1)
    expect(new ChangelogAbort('nope', 7).exitCode).toBe(7)
  })
})

describe('ralph changelog — CLI registration (#71)', () => {
  it('appears in `ralph --help`', async () => {
    const result = await execa('node', [BIN, '--help'], { reject: false })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^\s*changelog\b/m)
  })

  it('accepts --all', async () => {
    const result = await execa('node', [BIN, 'changelog', '--help'], { reject: false })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/--all/)
  })

  it('prints the real shipped changelog from a directory that is no Ralph project', async () => {
    // The one end-to-end read, and the AC that no injected fs can prove: a global install
    // invoked in a temp directory with no ralph.config.sh, no .ralph/ and no git repo.
    // Loose about the contents — a release lands every week — and strict about the shape.
    const result = await execa('node', [BIN, 'changelog'], { cwd: tmpdir(), reject: false })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/m)
    expect(result.stdout).toContain('•')
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toMatch(/^\s+at\s/m)
  })

  it('prints every release under --all, and more of them than the default', async () => {
    const [some, every] = await Promise.all([
      execa('node', [BIN, 'changelog'], { cwd: tmpdir(), reject: false }),
      execa('node', [BIN, 'changelog', '--all'], { cwd: tmpdir(), reject: false }),
    ])
    expect(every.exitCode).toBe(0)
    expect(every.stdout.length).toBeGreaterThan(some.stdout.length)
  })
})
