// #70 — the spec for the changelog READER: where the file is, and what happens when it
// is not there.
//
// Two claims, and they are the whole reason this seam exists apart from the parser:
//
//   1. THE PATH IS RESOLVED AGAINST THE INSTALLED MODULE, never against the working
//      directory. `ralph start` runs in the user's repo, and that repo has a CHANGELOG.md
//      of its own — a reader that resolved `./CHANGELOG.md` from the cwd would put SOMEONE
//      ELSE'S release notes in Ralph's banner, on the machines where it worked at all.
//      A globally installed Ralph has to find its own file, so the path comes from
//      RALPH_HOME (lib/paths.js), which is derived from `import.meta.url`.
//   2. EVERY FAILURE IS NO ENTRIES, and never a throw. A missing file (a pruned install,
//      an `--omit` flag, a tarball built without it), an unreadable one, a directory
//      where the file should be, and content nothing can be made of: all of it costs the
//      banner a section and nothing else. `ralph start` still starts.
//
// The fs is INJECTED for every case but the last one, so no test here can be steered by
// the state of the developer's checkout (#41). The one test that does read the real file
// is the one whose whole point is that the shipped file is readable and parses.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Volume } from 'memfs'
import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { changelogPath, readChangelogEntries } from './changelog-file.js'
import { RALPH_HOME } from './paths.js'

const SAMPLE = readFileSync(new URL('./__fixtures__/changelog-sample.md', import.meta.url), 'utf8')

/** A memfs volume holding `text` at the path the reader resolves on its own. */
const volumeWith = (text) => Volume.fromJSON({ [changelogPath()]: text }, '/')

describe('changelogPath — the installed module’s own file (#70)', () => {
  it('is CHANGELOG.md at the package root', () => {
    expect(changelogPath()).toBe(join(RALPH_HOME, 'CHANGELOG.md'))
    expect(readFileSync(changelogPath(), 'utf8')).toContain('# Changelog')
  })

  it('reads no working directory to get there', () => {
    // Asserted in the source, because the ABSENCE of a capability cannot be shown by
    // exercising happy paths — the suite runs with the package root AS the cwd, so a
    // `process.cwd()` here would pass every behavioural test in this file and fail on
    // every user's machine. Same method as lib/banner-compose.test.js's purity block.
    const code = codeWithoutComments(new URL('./changelog-file.js', import.meta.url))
    expect(code).not.toMatch(/process\s*\.\s*cwd/)
    expect(code).not.toMatch(/\bcwd\b/)
    expect(code).toMatch(/RALPH_HOME/)
  })

  it('is in the published tarball', () => {
    // The banner's section is only free of a network call because the file is already
    // on disk next to lib/. If CHANGELOG.md ever left package.json's `files`, every
    // installed Ralph would silently lose the section while the suite stayed green.
    const manifest = JSON.parse(readFileSync(join(RALPH_HOME, 'package.json'), 'utf8'))
    expect(manifest.files).toContain('CHANGELOG.md')
  })
})

describe('readChangelogEntries — the file, parsed (#70)', () => {
  it('parses the file it finds at its own path, through the injected fs', () => {
    const entries = readChangelogEntries({ fs: volumeWith(SAMPLE) })
    expect(entries.map((entry) => entry.version)).toEqual([
      '0.22.0',
      '0.21.0',
      '0.19.1',
      '0.8.0',
      '0.1.0',
    ])
  })

  it('asks the fs for exactly one file, once, and it is the resolved path', () => {
    const asked = []
    const entries = readChangelogEntries({
      fs: {
        readFileSync: (path, encoding) => {
          asked.push({ path, encoding })
          return SAMPLE
        },
      },
    })
    expect(asked).toEqual([{ path: changelogPath(), encoding: 'utf8' }])
    expect(entries).toHaveLength(5)
  })

  it('honours an explicit path, for a caller that knows better', () => {
    const path = '/elsewhere/CHANGELOG.md'
    const fs = Volume.fromJSON({ [path]: SAMPLE }, '/')
    expect(readChangelogEntries({ fs, path })[0].version).toBe('0.22.0')
  })

  it('decodes a Buffer, for an fs that ignores the encoding argument', () => {
    const fs = { readFileSync: () => Buffer.from(SAMPLE, 'utf8') }
    expect(readChangelogEntries({ fs })[0].version).toBe('0.22.0')
  })
})

describe('readChangelogEntries — every failure is no entries (#70)', () => {
  it('returns no entries when the file is not there', () => {
    // A pruned install. The section disappears; the run does not.
    expect(readChangelogEntries({ fs: new Volume() })).toEqual([])
  })

  it('returns no entries when the read throws, whatever it throws', () => {
    for (const boom of [
      new Error('EACCES: permission denied'),
      Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' }),
      new TypeError('The "path" argument must be of type string.'),
      'a string nobody should throw',
    ]) {
      const fs = {
        readFileSync: () => {
          throw boom
        },
      }
      expect(readChangelogEntries({ fs }), String(boom)).toEqual([])
    }
  })

  it('returns no entries for an fs that is not one at all', () => {
    // The seam is a parameter, so a caller can hand over anything — a bag with no
    // `readFileSync`, a null, a number. None of it may reach the banner as a throw.
    for (const fs of [{}, null, 42, { readFileSync: 'nope' }]) {
      expect(readChangelogEntries({ fs }), JSON.stringify(fs)).toEqual([])
    }
  })

  it('returns no entries for content nothing can be made of', () => {
    for (const text of ['', '   ', '\n\n\n', 'not a changelog at all', '## Contributing\n', 0, null, {}]) {
      expect(readChangelogEntries({ fs: { readFileSync: () => text } }), JSON.stringify(text)).toEqual(
        [],
      )
    }
  })

  it('never throws for any of it', () => {
    // Stated once as its own claim: the caller is `ralph start`'s first paint, and it
    // has no catch of its own to spare for a banner.
    for (const fs of [new Volume(), {}, null, { readFileSync: () => ({}) }]) {
      expect(() => readChangelogEntries({ fs })).not.toThrow()
    }
    expect(() => readChangelogEntries()).not.toThrow()
  })
})

describe('readChangelogEntries — the file this package actually ships (#70)', () => {
  it('reads and parses the real CHANGELOG.md with no injection at all', () => {
    // The DEFAULT wiring, so the fs cannot be plumbed to nothing — and the one place
    // the real file is the subject. Loose on purpose: a release adds an entry every
    // week, so this asserts the SHAPE (a newest entry, with a version and bullets),
    // never the contents.
    const entries = readChangelogEntries()
    expect(entries.length).toBeGreaterThan(1)
    expect(entries[0].version).toMatch(/^\d+\.\d+\.\d+/)
    expect(entries[0].sections.flatMap((section) => section.bullets).length).toBeGreaterThan(0)
  })
})
