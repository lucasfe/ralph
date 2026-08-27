// #70 — the what's-new section, wired into `ralph start`'s identity box.
//
// Three claims, and the second is the one this issue is really about:
//
//   1. THE FACTS ARE RESOLVED HERE. `startCommand` reads the changelog on the impure
//      side and hands the newest entry's bullets to `composeBanner` as one more entry in
//      the `facts` object — the seam lib/commands/start.js documents at step 0 and the
//      arrangement that keeps lib/banner-compose.js touching nothing.
//   2. IT COSTS THE RUN NOTHING. No network call (the file is inside the package), no
//      state file, no "seen" stamp, and no failure mode that reaches the user: a missing,
//      unreadable or unparseable changelog drops the section and `ralph start` starts.
//   3. IT IS ON EVERY START. There is nothing to dedupe against, deliberately — a reader
//      who updates on Monday and starts Ralph on Friday still gets told what changed.
//
// Every seam is injected (#41): the reader itself, and — one level under it — the fs the
// default reader uses, so even the test that exercises the real wiring never depends on
// the developer's checkout. The box's layout, its three-bullet cap and its truncation are
// lib/banner-compose.test.js's business; what is asserted here is the WIRING.

import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { readFileSync } from 'node:fs'
import { StartAbort, startCommand } from './start.js'
import { composeBanner } from '../banner-compose.js'
import { latestBullets, parseChangelog } from '../changelog.js'
import { changelogPath } from '../changelog-file.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'

const ESC = '\u001B'
const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'

const SAMPLE = readFileSync(new URL('../__fixtures__/changelog-sample.md', import.meta.url), 'utf8')
const ENTRIES = parseChangelog(SAMPLE)
const BULLETS = latestBullets(ENTRIES)

const stripAnsi = (text) => text.replaceAll(/\u001B\[\d+m/g, '')

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
}

// The same folder-source rig every other start spec uses: no gh, no tmux, no network.
const deps = ({ queue = 3, sessionExists = false, ...overrides } = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const exec = async (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: sessionExists ? 0 : 1, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec,
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : ''),
    loadEnv: () => ({}),
    hasCommand: () => true,
    ask: async () => true,
    currentVersion: VERSION,
    update: async () => ({
      latestVersion: null,
      isNewer: false,
      shouldPrompt: false,
      source: 'disabled',
      updatedCache: null,
    }),
    readCache: () => ({ ...EMPTY_VERSION_CACHE }),
    // #70: the changelog reader, injected on the same convention as `readCache` — the
    // real one resolves a path inside the installed package, and a test that let it do
    // so would assert against whatever this repo's CHANGELOG.md says today.
    readChangelog: () => ENTRIES,
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    folderQueueCount: async () => queue,
    home: HOME,
    processEnv: {},
    ...overrides,
  }
}

// The box wherever it is, found by its own frame — the same finder start.banner.test.js
// uses, and for the same reason: it serves a piped run (box first) and a TTY one.
const boxOf = (d) => {
  const lines = d.stdout.lines()
  const top = lines.findIndex((line) => line.startsWith('╭'))
  const bottom = lines.findIndex((line) => line.startsWith('╰'))
  return top === -1 || bottom < top ? [] : lines.slice(top, bottom + 1)
}

const rowOf = (d, label) => boxOf(d).find((line) => stripAnsi(line).includes(`│ ${label}`))

// What the box must be, composed by the same pure function the command calls.
const boxFor = (whatsNew) =>
  composeBanner({
    facts: { version: VERSION, latestVersion: null, cwd: REPO, whatsNew },
    capabilities: { color: false },
  })

describe('startCommand — what’s new in the identity box (#70)', () => {
  it('shows the newest release’s bullets and the pointer', async () => {
    const d = deps()
    expect(await startCommand(d)).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(boxOf(d)).toEqual(boxFor(BULLETS))
    expect(rowOf(d, 'new')).toContain('`ralph digest --loop`')
    expect(rowOf(d, 'more')).toContain('ralph changelog')
  })

  it('shows the newest entry only, never the one below it', async () => {
    // 0.22.0's two Features bullets, and not 0.21.0's — "what's new" is one release.
    const d = deps()
    await startCommand(d)
    expect(d.stdout.output()).toContain('a digest section in `ralph status`')
    expect(d.stdout.output()).not.toContain('GIF-to-sprite generator')
  })

  it('reads the changelog once per run, through the seam', async () => {
    const seen = []
    const d = deps({
      readChangelog: (args) => {
        seen.push(args)
        return ENTRIES
      },
    })
    await startCommand(d)
    expect(seen).toHaveLength(1)
  })

  it('hands the reader the run’s own fs', async () => {
    // One level under the seam: the fs the DEFAULT reader uses is injectable too, so a
    // test of the real wiring never reads the real file (#41).
    const seen = []
    const changelogFs = { readFileSync: () => SAMPLE }
    const d = deps({
      changelogFs,
      readChangelog: (args) => {
        seen.push(args)
        return ENTRIES
      },
    })
    await startCommand(d)
    expect(seen[0]?.fs).toBe(changelogFs)
  })

  it('reads a real file through the default reader, at the package’s own path', async () => {
    // The DEFAULT wiring, so `readChangelog` cannot be plumbed to nothing: memfs holds
    // a changelog at the path the installed module resolves — not at the cwd, which is
    // `/repo` here and holds nothing.
    const changelogFs = Volume.fromJSON({ [changelogPath()]: SAMPLE }, '/')
    const d = deps({ changelogFs, readChangelog: undefined })
    await startCommand(d)
    expect(boxOf(d)).toEqual(boxFor(BULLETS))
  })

  it('does not read the working directory’s changelog', async () => {
    // The user's repo has a CHANGELOG.md of its own, and it is not Ralph's. A reader
    // resolving from the cwd would put someone else's release notes in this box.
    const changelogFs = Volume.fromJSON(
      { '/repo/CHANGELOG.md': '## [9.9.9](https://example.com) (2026-01-01)\n\n### Features\n\n* not ralph\n' },
      '/',
    )
    const d = deps({ changelogFs, readChangelog: undefined })
    await startCommand(d)
    expect(d.stdout.output()).not.toContain('not ralph')
    expect(rowOf(d, 'new')).toBeUndefined()
  })

  it('drops the section and starts anyway when there is no changelog', async () => {
    for (const readChangelog of [
      () => [],
      () => {
        throw new Error('EACCES: permission denied')
      },
      () => null,
      () => 'nope',
      async () => ENTRIES,
      () => [{ version: '1.0.0', date: null, sections: [] }],
    ]) {
      const d = deps({ readChangelog })
      expect(await startCommand(d)).toEqual({ exitCode: 0, started: true, count: 3 })
      expect(boxOf(d)).toEqual(boxFor([]))
      expect(rowOf(d, 'new')).toBeUndefined()
      expect(d.stdout.output()).not.toContain('ralph changelog')
      expect(d.stderr.output()).toBe('')
    }
  })

  it('keeps the box first, above every other side effect', async () => {
    // The section adds rows to the box, and the box is still the first thing written —
    // a changelog read that happened after the tmux guard would be missing from
    // exactly the run where the box is the only context the error has.
    const d = deps({ sessionExists: true })
    await expect(startCommand(d)).rejects.toThrow(StartAbort)
    const box = boxFor(BULLETS)
    expect(d.stdout.lines().slice(0, box.length)).toEqual(box)
    expect(d.stderr.output()).toContain('already exists')
  })

  it('writes nothing and stamps nothing — the section is on every start', async () => {
    // No "last seen release" and no state file: this is not #24's throttled notice, it
    // is the release notes, and a user who starts Ralph twice sees them twice.
    const cacheFs = new Volume()
    const changelogFs = Volume.fromJSON({ [changelogPath()]: SAMPLE }, '/')
    const first = deps({ cacheFs, changelogFs, readCache: undefined, readChangelog: undefined })
    const second = deps({ cacheFs, changelogFs, readCache: undefined, readChangelog: undefined })
    await startCommand(first)
    await startCommand(second)
    expect(boxOf(first)).toEqual(boxOf(second))
    expect(rowOf(second, 'new')).toContain('`ralph digest --loop`')
    expect(cacheFs.toJSON()).toEqual({})
    expect(changelogFs.toJSON()).toEqual({ [changelogPath()]: SAMPLE })
  })

  it('adds no escape byte on a pipe', async () => {
    const d = deps()
    await startCommand(d)
    expect(d.stdout.output()).not.toContain(ESC)
  })

  it('spawns nothing to get the bullets', async () => {
    // The file ships inside the package, which is the whole point: no `npm view`, no
    // `gh release list`, no latency added to the first paint.
    const spawned = []
    const d = deps({
      exec: async (cmd, args) => {
        spawned.push(cmd)
        if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1 }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    await startCommand(d)
    expect(spawned).not.toContain('npm')
    expect(spawned).not.toContain('gh')
    expect(rowOf(d, 'new')).toBeTruthy()
  })
})
