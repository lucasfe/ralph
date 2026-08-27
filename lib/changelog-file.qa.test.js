// #70 QA — adversarial specs for the changelog READER, the one impure half of this
// feature.
//
// changelog-file.test.js proves the two claims the module is for: the path comes from
// the installed module and every failure is no entries. This file attacks the same two
// from outside the shapes a well-behaved caller produces, because BOTH of its inputs
// are injected seams that a caller controls:
//
//   * THE fs, which is a parameter. `readChangelogEntries({ fs })` is called by
//     `ralph start` with whatever `changelogFs` happens to be, which on the default
//     path is `undefined` and in a test is memfs. So an fs that is not one, an fs whose
//     `readFileSync` is a string, and an fs that answers with a Buffer, a number or
//     nothing at all are all reachable — and none of them may reach the banner as a
//     throw, because the caller is the FIRST thing `ralph start` prints and has no
//     catch of its own to spare for release notes.
//   * WHAT IT ANSWERS WITH, which must be a plain array — synchronously. `ralph start`
//     does not await this seam (the box is printed above every other side effect, so
//     awaiting a file read would reorder the whole command's output), so a reader that
//     became `async` would silently drop the section on every run. That invariant has
//     no other home: it is a property of THIS module that the CALLER depends on.
//
// Plus the one claim about `changelogPath()` that a static grep cannot make. The dev's
// spec greps the source for `process.cwd` — necessary, because the suite runs with the
// package root AS the cwd, so a cwd-relative read passes every behavioural test here
// and fails on every user's machine. This file DEMONSTRATES it instead: a child node
// process, started in a throwaway directory that holds a decoy CHANGELOG.md of its own,
// has to resolve and read Ralph's file rather than the decoy.
//
// Hermetic: every case but the two that are explicitly about the shipped file uses an
// injected fs or memfs, so nothing here can be steered by the developer's checkout (#41).

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Volume } from 'memfs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { BANNER_WIDTH, composeBanner } from './banner-compose.js'
import { changelogPath, readChangelogEntries } from './changelog-file.js'
import { latestBullets } from './changelog.js'
import { RALPH_HOME } from './paths.js'

const ESC = '\u001B'
const LF = '\n'
const CR = '\r'
// U+009B, the single-byte C1 CSI introducer: the same escape attack without an ESC.
const C1_CSI = '\u009B'
const BOM = '\uFEFF'

const SAMPLE = readFileSync(new URL('./__fixtures__/changelog-sample.md', import.meta.url), 'utf8')
const SGR = /\u001B\[[0-9;]*m/g
const visibleWidth = (line) => [...line.replace(SGR, '')].length

/** An fs that answers every read with `value`, whatever it is. */
const answering = (value) => ({ readFileSync: () => value })
/** An fs that throws `boom` on every read. */
const throwing = (boom) => ({
  readFileSync: () => {
    throw boom
  },
})

describe('QA readChangelogEntries — an fs that is not one', () => {
  // The seam is a parameter with a default, so every one of these is one keystroke away
  // in a caller: `{ fs: someBag }`, `{ fs: fsPromises }`, a typo'd property name. The
  // contract is that all of it costs the SECTION and never the run.
  const NOT_AN_FS = {
    'an empty bag': {},
    'a prototypeless bag': Object.create(null),
    null: null,
    'a number': 42,
    'a string': 'fs',
    'an array': [],
    'a boolean': true,
    'a function': () => SAMPLE,
    'a bag whose readFileSync is a string': { readFileSync: 'nope' },
    'a bag whose readFileSync is null': { readFileSync: null },
    'a bag whose readFileSync is an object': { readFileSync: {} },
    'a bag with the wrong spelling': { readfilesync: () => SAMPLE },
    'the promises API by mistake': { readFile: async () => SAMPLE },
    'a bag whose readFileSync getter throws': {
      get readFileSync() {
        throw new Error('a hostile fs bag')
      },
    },
    'a class that must be newed': { readFileSync: class Nope {} },
  }

  for (const [name, fs] of Object.entries(NOT_AN_FS)) {
    it(`reports no entries for ${name}`, () => {
      expect(() => readChangelogEntries({ fs })).not.toThrow()
      expect(readChangelogEntries({ fs })).toEqual([])
    })
  }

  it('reports no entries however the read fails', () => {
    // The field failures are the first four; the rest are what a stub, a native
    // binding or a mocking library throws when it is unhappy. A bare `catch` catches
    // all of them, and this is the sweep that says so — including the values a `catch
    // (e) { if (e.code === …) }` refactor would start crashing on.
    const BOOMS = [
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' }),
      Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }),
      new TypeError('The "path" argument must be of type string'),
      new RangeError('Invalid string length'),
      'a string nobody should throw',
      42,
      null,
      undefined,
      Symbol('boom'),
      { code: 'ENOENT' },
      // A rejection value whose own `message` explodes when read: nothing in the catch
      // may touch it, which a `catch (e) { log(e.message) }` would.
      {
        get message() {
          throw new Error('even the message is hostile')
        },
      },
    ]
    for (const boom of BOOMS) {
      const why = typeof boom === 'symbol' ? 'Symbol' : JSON.stringify(String(boom))
      expect(() => readChangelogEntries({ fs: throwing(boom) }), why).not.toThrow()
      expect(readChangelogEntries({ fs: throwing(boom) }), why).toEqual([])
    }
  })

  it('reports no entries for a path that is not one', () => {
    // `path` is the second injected seam. memfs answers a null, a number or an empty
    // string with a throw, which is exactly the failure the module swallows.
    const fs = Volume.fromJSON({ [changelogPath()]: SAMPLE }, '/')
    for (const path of [null, 42, '', {}, [], true, '/nowhere/CHANGELOG.md']) {
      expect(readChangelogEntries({ fs, path }), JSON.stringify(path)).toEqual([])
    }
    // ...and `undefined` is not a path that is not one: it is an ABSENT path, so the
    // default applies and the module's own file is read. The distinction matters
    // because `{ path: options.path }` on an options bag without one is common.
    expect(readChangelogEntries({ fs, path: undefined })).toHaveLength(5)
  })
})

describe('QA readChangelogEntries — whatever the fs answers with', () => {
  it('decodes the two answers a real fs gives', () => {
    // A string when the encoding argument was honoured, a Buffer when it was not. Both
    // have to work, because an fs is free to ignore the argument — memfs does honour
    // it, a native binding with a patched prototype might not.
    expect(readChangelogEntries({ fs: answering(SAMPLE) })[0].version).toBe('0.22.0')
    expect(readChangelogEntries({ fs: answering(Buffer.from(SAMPLE, 'utf8')) })[0].version).toBe(
      '0.22.0',
    )
  })

  it('reports no entries for an answer nothing can be made of', () => {
    // `?? ''` and the parser's own non-string refusal, swept. None of it throws and
    // none of it invents an entry — which is what makes "a pruned install just starts"
    // true rather than aspirational.
    const ANSWERS = [
      ['nothing', undefined],
      ['null', null],
      ['an empty string', ''],
      ['whitespace', `   ${LF}\t${LF}`],
      ['a byte-order mark alone', BOM],
      ['a number', 42],
      ['zero', 0],
      ['NaN', Number.NaN],
      ['a boolean', false],
      ['an empty object', {}],
      ['an array', []],
      ['a Symbol', Symbol('nope')],
      ['a prose file', `# Changelog${LF}${LF}All notable changes.${LF}`],
      ['a Contributing section only', `## Contributing${LF}${LF}* send a PR${LF}`],
      ['an empty Buffer', Buffer.alloc(0)],
      ['a binary Buffer', Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])],
      ['a Uint8Array', new TextEncoder().encode(SAMPLE)],
      // No `toString` at all: the coercion throws, and the module's one catch is what
      // turns that into no entries rather than into a dead `ralph start`.
      ['a prototypeless object', Object.create(null)],
      [
        'an object whose toString throws',
        {
          toString() {
            throw new Error('hostile fs answer')
          },
        },
      ],
    ]
    for (const [name, value] of ANSWERS) {
      expect(() => readChangelogEntries({ fs: answering(value) }), name).not.toThrow()
      expect(readChangelogEntries({ fs: answering(value) }), name).toEqual([])
    }
  })

  it('decodes a Buffer whose bytes are a real changelog with Windows line endings', () => {
    // The two accidents stacked: a checkout under `core.autocrlf` read by an fs that
    // ignored the encoding. A `\r` surviving to a bullet would reach the terminal as a
    // carriage return, which redraws the row over the box's own frame.
    const crlf = Buffer.from(SAMPLE.replaceAll(LF, `${CR}${LF}`), 'utf8')
    const entries = readChangelogEntries({ fs: answering(crlf) })
    expect(entries.map((entry) => entry.version)).toEqual([
      '0.22.0',
      '0.21.0',
      '0.19.1',
      '0.8.0',
      '0.1.0',
    ])
    for (const bullet of latestBullets(entries)) expect(bullet).not.toMatch(/[\n\r]/)
  })

  it('takes an fs at its word, `toString` and all', () => {
    // DELIBERATE, and the reason it is safe to say so out loud: the `.toString()` in
    // this module exists to decode a Buffer, so an fs that answers with an object
    // gets that object's `toString` called. That is a coercion — the very thing
    // lib/banner-compose.js refuses for a FACT — and the asymmetry is the point. A
    // fact arrives from a file and is untrusted text; an `fs` is injected
    // INFRASTRUCTURE, on the same footing as the `readFileSync` this module would
    // otherwise import, and a caller who hands over a hostile fs has already lost.
    // Pinned so a future author does not "fix" it and break Buffer support.
    const entries = readChangelogEntries({
      fs: answering({
        toString: () => `## [7.7.7] (2026-07-07)${LF}${LF}### Features${LF}${LF}* from a toString${LF}`,
      }),
    })
    expect(entries[0]).toMatchObject({ version: '7.7.7', date: '2026-07-07' })
    expect(latestBullets(entries)).toEqual(['from a toString'])
  })

  it('answers synchronously with a plain array, never a thenable', () => {
    // THE INVARIANT THE CALLER DEPENDS ON, and it lives here because it is a property
    // of this module that nothing else can assert. `ralph start` prints the box above
    // every other side effect and therefore does NOT await this seam: it calls
    // `latestBullets(readChangelog({ fs }))` and hands the result to composeBanner in
    // the same tick. So an `async` added to this function would not merely slow the
    // read down — the section would silently vanish on every run (a Promise is not an
    // array), and a read that then REJECTED would leave an unhandled rejection behind,
    // which Node terminates the process over. This test is the tripwire for that
    // change; it fails the moment the reader stops being synchronous.
    for (const fs of [answering(SAMPLE), answering(null), throwing(new Error('boom')), {}]) {
      const entries = readChangelogEntries({ fs })
      expect(Array.isArray(entries)).toBe(true)
      expect(entries).not.toHaveProperty('then')
      expect(entries).not.toBeInstanceOf(Promise)
    }
  })

  it('never memoizes: a second call sees what the file says now', () => {
    // No cache, deliberately — this is a local read of a file inside the package, and
    // the module has no state to grow (see start.js's "NOTHING IS STAMPED"). A memo
    // here would make `ralph start` report the release notes of whatever version was
    // installed when the process first read them, which is exactly wrong after an
    // `npm i -g` in the same shell session.
    let answer = `## [1.0.0] (2026-01-01)${LF}${LF}### F${LF}${LF}* first${LF}`
    const fs = { readFileSync: () => answer }
    expect(latestBullets(readChangelogEntries({ fs }))).toEqual(['first'])
    answer = `## [2.0.0] (2026-02-02)${LF}${LF}### F${LF}${LF}* second${LF}`
    expect(latestBullets(readChangelogEntries({ fs }))).toEqual(['second'])
  })
})

describe('QA readChangelogEntries — a real filesystem that is not cooperating', () => {
  it('reports no entries for a zero-byte file', () => {
    // A tarball built with the file truncated, or an interrupted write. memfs rather
    // than an injected stub, so the real `readFileSync` contract is what is exercised.
    expect(readChangelogEntries({ fs: Volume.fromJSON({ [changelogPath()]: '' }, '/') })).toEqual([])
  })

  it('reports no entries when a DIRECTORY is where the file should be', () => {
    // An unpack that created the path as a folder, or a mount. The real `readFileSync`
    // throws EISDIR here, which is the failure the module's one catch is mostly for.
    const fs = new Volume()
    fs.mkdirSync(changelogPath(), { recursive: true })
    expect(readChangelogEntries({ fs })).toEqual([])
  })

  it('reports no entries for a file that is only a byte-order mark', () => {
    expect(readChangelogEntries({ fs: Volume.fromJSON({ [changelogPath()]: BOM }, '/') })).toEqual([])
  })

  it('reports no entries for a dangling symlink', () => {
    // What a pruned or partially-restored install can leave behind. ENOENT through a
    // link is the same non-event as ENOENT without one.
    const fs = new Volume()
    fs.mkdirSync(RALPH_HOME, { recursive: true })
    fs.symlinkSync('/nowhere/CHANGELOG.md', changelogPath())
    expect(readChangelogEntries({ fs })).toEqual([])
  })

  it('reads exactly one path, exactly once, and writes nothing', () => {
    // The banner is printed before the first preflight line, so the read has to be
    // ONE stat-free read of ONE file — not an `existsSync` probe followed by a read,
    // and certainly not a write. The recording fs answers everything, so a second
    // read of a second path would show up here rather than passing silently.
    const calls = []
    const volume = Volume.fromJSON({ [changelogPath()]: SAMPLE }, '/')
    const recording = new Proxy(volume, {
      get(target, property) {
        const value = target[property]
        if (typeof value !== 'function') return value
        return (...args) => {
          calls.push({ method: property, args })
          return value.apply(target, args)
        }
      },
    })
    expect(readChangelogEntries({ fs: recording })).toHaveLength(5)
    expect(calls).toEqual([{ method: 'readFileSync', args: [changelogPath(), 'utf8'] }])
    // ...and the volume is byte-identical afterwards: no state, no stamp, no cache file.
    expect(volume.toJSON()).toEqual({ [changelogPath()]: SAMPLE })
  })

  it('honours an explicit path without ever consulting its own', () => {
    // `ralph changelog` (#71) may want to read a file a user named. The default path
    // must not be read as well — a fallback here would make the command's output
    // depend on whether the installed package happens to have its own file.
    const elsewhere = '/somewhere/else/CHANGELOG.md'
    const asked = []
    const fs = {
      readFileSync: (path) => {
        asked.push(path)
        return SAMPLE
      },
    }
    expect(readChangelogEntries({ fs, path: elsewhere })[0].version).toBe('0.22.0')
    expect(asked).toEqual([elsewhere])
  })
})

describe('QA changelogPath — resolved against the installed module, demonstrated', () => {
  let sandbox

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'ralph-changelog-qa-'))
  })

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true })
  })

  it('is the same absolute path however many times it is asked', () => {
    const path = changelogPath()
    expect(isAbsolute(path)).toBe(true)
    expect(path).toBe(join(RALPH_HOME, 'CHANGELOG.md'))
    expect(path).toBe(changelogPath())
    expect(path).not.toContain('..')
    expect(path.trim()).toBe(path)
  })

  it('ignores a decoy CHANGELOG.md in the working directory, in a real child process', () => {
    // THE CLAIM A GREP CANNOT MAKE. This suite runs with the package root as its cwd,
    // so `join(cwd, 'CHANGELOG.md')` would pass every other spec in this file and fail
    // on every user's machine — `ralph start` runs inside the USER's repo, and that
    // repo has release notes of its own. So: a child node process, started in a
    // throwaway directory that holds a decoy, importing the module by absolute URL.
    // It has to resolve Ralph's own path and read Ralph's own file.
    const decoy = join(sandbox, 'CHANGELOG.md')
    writeFileSync(
      decoy,
      `## [99.99.99] (2099-12-31)${LF}${LF}### Features${LF}${LF}* somebody else's release${LF}`,
    )
    mkdirSync(join(sandbox, 'node_modules'), { recursive: true })
    const moduleUrl = new URL('./changelog-file.js', import.meta.url).href
    const script = [
      `import { changelogPath, readChangelogEntries } from ${JSON.stringify(moduleUrl)}`,
      'const entries = readChangelogEntries()',
      'process.stdout.write(JSON.stringify({',
      '  path: changelogPath(),',
      '  cwd: process.cwd(),',
      '  versions: entries.map((entry) => entry.version),',
      '}))',
    ].join('\n')
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: sandbox,
      encoding: 'utf8',
      timeout: 30000,
    })
    expect(child.stderr, child.stderr).toBe('')
    expect(child.status).toBe(0)
    const answer = JSON.parse(child.stdout)
    // The child really was somewhere else (realpath, because /tmp is a symlink on
    // macOS and `process.cwd()` reports the resolved form).
    expect(answer.cwd).toBe(realpathSync(sandbox))
    expect(answer.path).toBe(changelogPath())
    // ...and it read Ralph's file, not the decoy sitting next to it.
    expect(answer.versions.length).toBeGreaterThan(1)
    expect(answer.versions).not.toContain('99.99.99')
    expect(child.stdout).not.toContain("somebody else's release")
  })

  it('names no capability it does not need, by source', () => {
    // The impure half is allowed an fs and a path — and nothing else. A `process.env`
    // read here would make the banner a function of the invoking shell (#41); a
    // `child_process` or a `fetch` would put a round trip in front of the first paint,
    // which is the whole thing this design avoids by shipping the file in the tarball.
    const code = codeWithoutComments(new URL('./changelog-file.js', import.meta.url))
    expect([...code.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1])).toEqual([
      'node:fs',
      'node:path',
      './paths.js',
      './changelog.js',
    ])
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/child_process|execa|spawn/)
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/process\s*\.\s*env/)
    expect(code).not.toMatch(/\bhomedir\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/writeFileSync|mkdirSync|rmSync|appendFileSync/)
    // One read, and it is a SYNC one: the caller prints the box in the same tick.
    expect(code).not.toMatch(/\bawait\b/)
    expect(code).not.toMatch(/\basync\b/)
  })
})

describe('QA readChangelogEntries — the file this package actually ships', () => {
  // Two specs, both PROPERTIES rather than values: the real file gains an entry on
  // every release, so anything pinned to its contents would go red on a version bump
  // that changed no code — and a spec that fails for the wrong reason gets weakened.

  it('parses into well-formed entries whose newest one has usable bullets', () => {
    const entries = readChangelogEntries()
    expect(entries.length).toBeGreaterThan(1)
    for (const entry of entries) {
      expect(entry.version, entry.version).toMatch(/^v?\d/)
      expect(entry.date === null || /^\d{4}-\d{2}-\d{2}$/.test(entry.date), entry.version).toBe(true)
      for (const section of entry.sections) {
        expect(section.bullets.length, `${entry.version} / ${section.heading}`).toBeGreaterThan(0)
        for (const bullet of section.bullets) {
          // Every property the box depends on, over every bullet the shipped file
          // contains: one line, trimmed, no URL left in it, no frame-redrawing byte.
          expect(bullet, bullet).toBe(bullet.trim())
          expect(bullet, bullet).not.toMatch(/[\n\r]/)
          expect(bullet, bullet).not.toContain('https://')
          expect(bullet, bullet).not.toContain(ESC)
          expect(bullet, bullet).not.toContain(C1_CSI)
        }
      }
    }
    expect(latestBullets(entries).length).toBeGreaterThan(0)
  })

  it('composes into a box that holds its width and paints nothing, at every width', () => {
    // The end-to-end claim, from the shipped bytes to the terminal: whatever this
    // week's release notes say, the box they produce is still a box. Asserted here
    // rather than in banner-compose's own specs because this is the one place the REAL
    // file is the input — a release whose bullet was 400 characters of Chinese would
    // break the guarantee here first.
    const whatsNew = latestBullets(readChangelogEntries())
    for (const width of [200, 80, 60, 44, 26, 12, 5, 1, undefined]) {
      for (const color of [false, true]) {
        const lines = composeBanner({
          facts: { version: '0.22.0', cwd: '/repo', whatsNew },
          width,
          capabilities: { color },
        })
        const why = `width ${width} color ${color}`
        expect(lines.length, why).toBeGreaterThan(0)
        const ceiling = Math.min(width ?? BANNER_WIDTH, BANNER_WIDTH)
        for (const line of lines) {
          expect(visibleWidth(line), `${why}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(ceiling)
          expect(line, why).not.toMatch(/[\n\r]/)
        }
        // Nothing in the section is advice, so nothing in it is painted — and with
        // colour off there is not one escape byte anywhere, which is what makes this
        // box safe to print into a launchd log on every run.
        if (!color) expect(lines.join(''), why).not.toContain(ESC)
      }
    }
  })
})
