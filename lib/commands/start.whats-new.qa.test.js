// #70 QA — adversarial specs for the WIRING: what `ralph start` does when the changelog
// half of its banner misbehaves.
//
// start.whats-new.test.js proves the three intended claims (the facts are resolved here,
// it costs the run nothing, it is on every start). This file attacks the same wiring from
// the two directions a command has that a pure module does not:
//
//   * THE SEAM ITSELF. `readChangelog` is an injected option with a default, so what
//     arrives at `whatsNewBullets` is whatever a caller passed — and #71's `ralph
//     changelog`, #75/#76's reuse of this box and any future test rig are all callers.
//     start.js's own comment says a reader that throws, one that answers with a promise
//     and one that answers with a hand-built entry "must all cost the SECTION and never
//     the run". That is a claim about a `try/catch` and one `Array.isArray`, so this file
//     sweeps every shape a function-shaped option can take — including not being a
//     function — and asserts something stronger than "it started": that the ENTIRE
//     stdout is byte-identical to the run where there was no changelog at all. A banner
//     that swallowed the failure but shifted one preflight line would still be a
//     regression in the only output a user ever sees.
//   * THE BYTES IN THE FILE. Everything above the tmux guard is printed from text that
//     came out of CHANGELOG.md — committed markdown, which nobody reads as bytes, in a
//     file whose diff nobody reviews closely at release time (release-please writes it).
//     So this file drives the DEFAULT reader over a memfs changelog whose bullets carry
//     an ESC, a one-byte C1 CSI, a NUL, a DEL, a forged box row and 400 columns of text,
//     and asserts the two invariants at the level a user experiences them: nothing wider
//     than the terminal said, and not one escape byte in a run that promised none.
//
// Every seam is injected — the reader, the fs under it, the cache fs, the environment,
// the width and the colour policy — so nothing here reads the developer's checkout, a
// real `~/.config/ralph`, the ambient `process.env` or a real terminal (#41).

import { readFileSync } from 'node:fs'
import { Volume } from 'memfs'
import { describe, expect, it } from 'vitest'
import { StartAbort, startCommand } from './start.js'
import { changelogPath } from '../changelog-file.js'
import { latestBullets, parseChangelog } from '../changelog.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'

const ESC = '\u001B'
const NUL = '\u0000'
const DEL = '\u007F'
const C1_CSI = '\u009B'
const NEL = '\u0085'
const CR = '\r'
const PLACEHOLDER = '�'
const SGR = /\u001B\[[0-9;]*m/g

const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'
const BANNER_WIDTH = 60
const POINTER = 'run `ralph changelog` for the rest'

const SAMPLE = readFileSync(new URL('../__fixtures__/changelog-sample.md', import.meta.url), 'utf8')
const ENTRIES = parseChangelog(SAMPLE)
const BULLETS = latestBullets(ENTRIES)
// One row per bullet the fixture's newest entry has, plus the pointer's own row. Derived
// rather than written down, so a fixture that grows a bullet does not turn every count in
// this file into a puzzle — the CAP itself is banner-compose.whats-new.qa.test.js's claim.
const SAMPLE_SECTION_ROWS = Math.min(BULLETS.length, 3) + 1

const stripAnsi = (text) => text.replace(SGR, '')
const visibleWidth = (line) => [...stripAnsi(line)].length

function makeStream(extras = {}) {
  const chunks = []
  return {
    write: (chunk) => {
      chunks.push(chunk)
      return true
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
    ...extras,
  }
}

// The same folder-source rig every other start spec uses: no gh, no tmux, no network, and
// a stdout that is a pipe unless a case says otherwise.
const deps = ({ queue = 3, sessionExists = false, stdout = makeStream(), ...overrides } = {}) => {
  const stderr = makeStream()
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec: async (cmd, args) => {
      if (cmd === 'tmux' && args[0] === 'has-session') {
        return { exitCode: sessionExists ? 0 : 1, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
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
    readChangelog: () => ENTRIES,
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    folderQueueCount: async () => queue,
    home: HOME,
    processEnv: {},
    ...overrides,
  }
}

/** The box, found by its own frame — it is first on a pipe and under the sprite on a TTY. */
const boxOf = (d) => {
  const lines = d.stdout.lines()
  const top = lines.findIndex((line) => stripAnsi(line).startsWith('╭'))
  const bottom = lines.findIndex((line) => stripAnsi(line).startsWith('╰'))
  return top === -1 || bottom < top ? [] : lines.slice(top, bottom + 1)
}

/** The rows the section is made of: the `new` row through the `more` row. */
const sectionOf = (d) => {
  const box = boxOf(d)
  const first = box.findIndex((line) => stripAnsi(line).startsWith('│ new'))
  const last = box.findIndex((line) => stripAnsi(line).startsWith('│ more'))
  return first === -1 || last < first ? [] : box.slice(first, last + 1)
}

/** The label column of every row in the box, which is the box's structure in one list. */
const labelsOf = (d) =>
  boxOf(d)
    .slice(1, -1)
    .map((line) => stripAnsi(line).slice(2, 10).trim())

const run = async (overrides) => {
  const d = deps(overrides)
  const result = await startCommand(d)
  return { d, result, stdout: d.stdout.output(), stderr: d.stderr.output() }
}

describe('QA startCommand — a reader that misbehaves costs the section, and nothing else', () => {
  // Every shape a function-shaped injected option can arrive in, including the shapes
  // that are not functions. start.js's `whatsNewBullets` is a two-line `try/catch` and
  // this is the sweep that says the catch covers the CALL as well as the answer: an
  // option plumbed to `null` by a caller who meant to disable the section throws a
  // TypeError on invocation, which must land in the same place a read error does.
  const HOSTILE_READERS = {
    'no entries': () => [],
    null: () => null,
    undefined: () => undefined,
    'a string': () => 'nope',
    'a number': () => 42,
    'a bag': () => ({}),
    'a Set of entries': () => new Set([{ sections: [{ bullets: ['x'] }] }]),
    'an array of junk': () => [1, 'x', null, undefined, true],
    'an entry whose sections are a string': () => [{ version: '1.0.0', sections: 'Features' }],
    'an entry with no sections': () => [{ version: '1.0.0', date: null, sections: [] }],
    'an entry whose bullets are unusable': () => [
      { version: '1.0.0', date: null, sections: [{ heading: 'F', bullets: [{}, null, 7, '  '] }] },
    ],
    'an entry that is a Proxy answering everything with nothing': () => [
      new Proxy({}, { get: () => undefined }),
    ],
    'a thrown Error': () => {
      throw new Error('EACCES: permission denied')
    },
    'a thrown string': () => {
      throw 'a string nobody should throw'
    },
    'a thrown null': () => {
      throw null
    },
    'a resolved promise': async () => ENTRIES,
    'a thenable that never settles': () => ({ then: () => {} }),
    'a generator function': function* () {
      yield ENTRIES
    },
    'not a function at all': null,
    'a number instead of a function': 42,
    'a bag instead of a function': {},
    'a Proxy that throws when called': new Proxy(() => [], {
      apply: () => {
        throw new Error('the reader itself is hostile')
      },
    }),
  }

  it('starts the run and prints a byte-identical stdout for every one of them', async () => {
    // THE STRONG FORM of "it costs the section and never the run". `boxOf` alone would
    // pass for a run that lost the section AND a preflight line, or that printed a
    // warning to stderr about a changelog nobody asked about — so the comparison is the
    // WHOLE stream against the run where the file was simply empty, plus an empty stderr
    // and the same return value.
    const baseline = await run({ readChangelog: () => [] })
    expect(baseline.result).toEqual({ exitCode: 0, started: true, count: 3 })
    for (const [name, readChangelog] of Object.entries(HOSTILE_READERS)) {
      const { result, stdout, stderr } = await run({ readChangelog })
      expect(result, name).toEqual({ exitCode: 0, started: true, count: 3 })
      expect(stdout, name).toBe(baseline.stdout)
      expect(stderr, name).toBe('')
      expect(stdout, name).not.toContain('ralph changelog')
      expect(stdout, name).not.toContain('CHANGELOG')
    }
  })

  it('says nothing about the failure — a banner is not a diagnostic', async () => {
    // Deliberate, and the opposite of what a first instinct suggests: no warning line, no
    // "could not read CHANGELOG.md", not even at the bottom. The section is a courtesy,
    // the user did not ask for it, and a run that complains about its own release notes
    // has turned a missing courtesy into noise on every start of a pruned install.
    const { stdout, stderr } = await run({
      readChangelog: () => {
        throw new Error('ENOENT: no such file or directory')
      },
    })
    for (const word of ['ENOENT', 'changelog', 'Changelog', 'release notes', 'could not']) {
      expect(stdout, word).not.toContain(word)
      expect(stderr, word).not.toContain(word)
    }
  })

  it('calls the reader exactly once, even when the call fails', async () => {
    // No retry, and no second read for a second row: one call per run, whatever it
    // answers. A retry would double the cost of the one thing on this path that touches
    // a disk, on the failure that is most likely to be slow (a stale network mount).
    for (const answer of [() => ENTRIES, () => null]) {
      const calls = []
      await run({
        readChangelog: (args) => {
          calls.push(args)
          return answer()
        },
      })
      expect(calls).toHaveLength(1)
    }
    const calls = []
    await run({
      readChangelog: (args) => {
        calls.push(args)
        throw new Error('boom')
      },
    })
    expect(calls).toHaveLength(1)
  })

  it('adds only lines — one per bullet, plus the pointer — and moves nothing else', async () => {
    // The mirror of the sweep above: with a real changelog the section is a row per
    // bullet and a row for the pointer, and the rest of the stream is the same stream.
    // Spliced out by INDEX rather than filtered by content, so a section row that
    // happened to duplicate a line from elsewhere in the output could not make this pass.
    //
    // The count is DERIVED from the fixture (whose newest entry has two bullets) rather
    // than written as a number, so this stays a claim about the wiring rather than a
    // second copy of the cap — which lib/banner-compose.whats-new.qa.test.js owns.
    const rows = SAMPLE_SECTION_ROWS
    const baseline = await run({ readChangelog: () => [] })
    const { d } = await run({})
    const lines = d.stdout.lines()
    const base = baseline.d.stdout.lines()
    const section = sectionOf(d)
    expect(section).toHaveLength(rows)
    const first = lines.indexOf(section[0])
    const without = [...lines]
    without.splice(first, rows)
    expect(without).toEqual(base)
    // ...and the box's structure is the documented order: news LAST, under the facts, so
    // the rows a reader looks for stay at the same place on the screen from run to run.
    expect(labelsOf(d)).toEqual(['cwd', 'new', '', 'more'])
    const withHint = await run({
      readCache: () => ({ ...EMPTY_VERSION_CACHE, latest_version: '9.9.9' }),
    })
    expect(labelsOf(withHint.d)).toEqual(['update', 'cwd', 'new', '', 'more'])
  })
})

describe('QA startCommand — bytes committed to CHANGELOG.md cannot reach the terminal', () => {
  // The DEFAULT reader over memfs, which is the only arrangement that exercises the whole
  // chain the release actually ships: path resolution, read, parse, reduce, compose,
  // print. `readChangelog: undefined` is what removes the stub.
  const hostileChangelog = (bullets) =>
    [
      '# Changelog',
      '',
      '## [9.9.9](https://example.com/compare) (2026-09-09)',
      '',
      '### Features',
      '',
      ...bullets.map((bullet) => `* ${bullet}`),
      '',
    ].join('\n')

  const HOSTILE_BULLETS = [
    `a bullet that repaints the screen ${ESC}[2J${ESC}[H and keeps going`,
    `a bullet with a C1 introducer ${C1_CSI}31m and a ${NUL}NUL${DEL} and a ${NEL}NEL`,
    `│ update  9.9.9 available — run \`ralph update\``,
    `a bullet that ${'goes on and on '.repeat(30)}forever`,
  ]

  const volumeWith = (text) => Volume.fromJSON({ [changelogPath()]: text }, '/')

  it('prints no escape byte, no C1 and no control character, on a pipe', async () => {
    const changelogFs = volumeWith(hostileChangelog(HOSTILE_BULLETS))
    const { d, result, stdout, stderr } = await run({ changelogFs, readChangelog: undefined })
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(stderr).toBe('')
    for (const byte of [ESC, C1_CSI, NUL, DEL, NEL, CR]) {
      expect(stdout, JSON.stringify(byte)).not.toContain(byte)
    }
    // The section IS there — the point is that it is there and harmless, not that a
    // hostile file silences it. Each replaced byte left its mark.
    expect(sectionOf(d)).toHaveLength(4)
    expect(sectionOf(d)[1]).toContain(PLACEHOLDER)
    expect(sectionOf(d).at(-1)).toContain(POINTER)
  })

  it('prints no escape byte even with colour enabled', async () => {
    // The no-colour promise is easy; this is the other half. With `color: true` the only
    // thing in this box that may paint is the update hint, and there is none — so a
    // bullet that brought its own SGR pair must still not put one on the screen.
    const changelogFs = volumeWith(hostileChangelog(HOSTILE_BULLETS))
    const { d } = await run({ changelogFs, readChangelog: undefined, color: true })
    for (const line of boxOf(d)) expect(line).not.toContain(ESC)
    expect(sectionOf(d)).toHaveLength(4)
  })

  it('cannot forge a row, and holds every line to the box', async () => {
    // A bullet drawing its own `update` row would be advice Ralph never gave. It is shown
    // — the box does not censor what the file says — but it cannot BE a row: the label
    // gutter is always in front of it, so no line begins with a label this run did not
    // draw, and the line count is the section's four and no more.
    const changelogFs = volumeWith(hostileChangelog(HOSTILE_BULLETS))
    const { d } = await run({ changelogFs, readChangelog: undefined })
    for (const line of boxOf(d)) {
      expect(visibleWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(BANNER_WIDTH)
      expect(stripAnsi(line)[0], JSON.stringify(line)).toMatch(/[╭│╰]/)
    }
    expect(boxOf(d).filter((line) => stripAnsi(line).startsWith('│ update'))).toEqual([])
    expect(labelsOf(d)).toEqual(['cwd', 'new', '', '', 'more'])
  })

  it('survives a changelog checked out with Windows line endings', async () => {
    // `core.autocrlf` on a Windows checkout, or a tarball repacked by a tool that
    // rewrote the file. A CR reaching the terminal redraws the row over the box's frame.
    const changelogFs = volumeWith(SAMPLE.replaceAll('\n', `${CR}\n`))
    const { d, stdout } = await run({ changelogFs, readChangelog: undefined })
    expect(stdout).not.toContain(CR)
    expect(sectionOf(d)).toHaveLength(SAMPLE_SECTION_ROWS)
    expect(sectionOf(d)[0]).toContain(BULLETS[0].slice(0, 20))
  })

  it('keeps the box above the abort, hostile file and all', async () => {
    // The aborting run is the one where this box is the only context the error has, so a
    // changelog that cannot be printed safely must not be the thing that moves the box
    // below the failure — or that replaces the failure with its own.
    const changelogFs = volumeWith(hostileChangelog(HOSTILE_BULLETS))
    const d = deps({ changelogFs, readChangelog: undefined, sessionExists: true })
    await expect(startCommand(d)).rejects.toThrow(StartAbort)
    expect(d.stdout.lines()[0]).toMatch(/^╭/)
    expect(sectionOf(d)).toHaveLength(4)
    expect(d.stderr.output()).toContain('already exists')
    expect(d.stderr.output()).not.toContain(ESC)
  })

  it('drops the section for a file that is not a changelog, and starts', async () => {
    // The pruned install, the truncated tarball, the directory where the file should be,
    // and the file that is prose. All of it reaches this command as no bullets, and the
    // command's own output is the run where the section was never added.
    const baseline = await run({ readChangelog: () => [] })
    const empty = new Volume()
    const asDirectory = new Volume()
    asDirectory.mkdirSync(changelogPath(), { recursive: true })
    const volumes = {
      'no file': empty,
      'a directory': asDirectory,
      'a zero-byte file': volumeWith(''),
      'prose only': volumeWith('# Changelog\n\nAll notable changes.\n'),
      'a byte-order mark': volumeWith('\uFEFF'),
      'binary noise': volumeWith(`${NUL}${DEL}${ESC}${C1_CSI}`),
      'the user’s own repo, at the wrong path': Volume.fromJSON(
        { '/repo/CHANGELOG.md': hostileChangelog(['not ralph’s release notes']) },
        '/',
      ),
    }
    for (const [name, changelogFs] of Object.entries(volumes)) {
      const { result, stdout, stderr } = await run({ changelogFs, readChangelog: undefined })
      expect(result, name).toEqual({ exitCode: 0, started: true, count: 3 })
      expect(stdout, name).toBe(baseline.stdout)
      expect(stderr, name).toBe('')
      expect(stdout, name).not.toContain('not ralph')
    }
  })
})

describe('QA startCommand — the width the terminal reported, and nothing else', () => {
  it('holds the box to the stream’s columns, in every shape a stream reports them', async () => {
    // `columns` is read off the RESOLVED stdout, so this is the one width seam a user's
    // terminal actually moves. A pipe reports `undefined`, some CI runners report `0`,
    // and a stream can report a string or a float; all of it must draw a box, and the
    // section — the widest content in it — must fit whatever came out.
    const changelogFs = Volume.fromJSON({ [changelogPath()]: SAMPLE }, '/')
    for (const columns of [200, 80, 60, 44, 30, 26, 12, 5, 1, 0, undefined, Number.NaN, '80', 44.7]) {
      const stdout = makeStream({ columns })
      const d = deps({ stdout, changelogFs, readChangelog: undefined })
      const result = await startCommand(d)
      const why = `columns ${String(columns)}`
      expect(result, why).toEqual({ exitCode: 0, started: true, count: 3 })
      const ceiling = typeof columns === 'number' && columns >= 1 ? Math.min(columns, 60) : 60
      // Taken by POSITION rather than by frame glyph: on a pipe the box is the first
      // thing written (the sprite draws nothing), and at one or two columns there is no
      // `╭` left to search for — the corner itself has been clipped to an ellipsis. A
      // frame-hunting helper would return an empty list at exactly those widths and every
      // assertion under it would pass by checking nothing.
      const box = d.stdout.lines().slice(0, 3 + SAMPLE_SECTION_ROWS)
      expect(box, why).toHaveLength(3 + SAMPLE_SECTION_ROWS)
      for (const line of box) {
        expect(visibleWidth(line), `${why}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(ceiling)
        expect(line, why).not.toContain('\n')
      }
      // The section is drawn at every width — clipped, never dropped, because a narrow
      // terminal is not a reason to withhold what changed. Counted against the same run
      // without a changelog, at the same columns, so this is a claim about the SECTION's
      // lines rather than about the box's total.
      const bare = makeStream({ columns })
      await startCommand(deps({ stdout: bare, changelogFs, readChangelog: () => [] }))
      expect(d.stdout.lines().length, why).toBe(bare.lines().length + SAMPLE_SECTION_ROWS)
    }
  })

  it('ignores a COLUMNS in the environment', async () => {
    // #41, at the one seam where an ambient value is most tempting: the width comes from
    // the stream, so a `COLUMNS` in the injected env — or in the developer's shell —
    // cannot change a single line of this box.
    const changelogFs = Volume.fromJSON({ [changelogPath()]: SAMPLE }, '/')
    const plain = await run({ changelogFs, readChangelog: undefined })
    const withEnv = await run({
      changelogFs,
      readChangelog: undefined,
      processEnv: { COLUMNS: '20', LINES: '4', RALPH_HOME: '/tmp/nowhere', TERM: 'dumb' },
    })
    expect(boxOf(withEnv.d)).toEqual(boxOf(plain.d))
  })
})

describe('QA startCommand — what the section costs the run', () => {
  it('reads one file once per run, writes nothing, and stamps nothing', async () => {
    // The claim start.js states as NOTHING IS STAMPED, asserted by accounting rather than
    // by comparing output: every fs call the reader makes is recorded, so a second read,
    // an `existsSync` probe or a "last seen release" write shows up here. Three runs,
    // because a stamp written on the first would only change the second or third.
    const cacheFs = new Volume()
    const volume = Volume.fromJSON({ [changelogPath()]: SAMPLE }, '/')
    const calls = []
    const changelogFs = new Proxy(volume, {
      get(target, property) {
        const value = target[property]
        if (typeof value !== 'function') return value
        return (...args) => {
          calls.push({ method: String(property), path: String(args[0]) })
          return value.apply(target, args)
        }
      },
    })
    const outputs = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { d } = await run({ cacheFs, changelogFs, readCache: undefined, readChangelog: undefined })
      outputs.push(d.stdout.output())
      expect(sectionOf(d)).toHaveLength(SAMPLE_SECTION_ROWS)
    }
    // One read per run, of one path, and no other fs verb at all.
    expect(calls).toEqual(
      Array.from({ length: 3 }, () => ({ method: 'readFileSync', path: changelogPath() })),
    )
    // Byte-identical every time: no "seen" state, no throttle, no first-run difference.
    expect(new Set(outputs).size).toBe(1)
    // Nothing written anywhere — not to the changelog volume, not to the update cache the
    // box also reads (which is the volume a "last shown release" would most plausibly
    // land in, since it is the state file this command already has).
    expect(volume.toJSON()).toEqual({ [changelogPath()]: SAMPLE })
    expect(cacheFs.toJSON()).toEqual({})
  })

  it('reaches no network and spawns nothing to get the bullets', async () => {
    // The design's whole justification: the file is in the tarball, so the section is
    // free. A `fetch` tripwire rather than an output check, because a network call that
    // happened to fail fast would leave the output identical and the first paint slower.
    const realFetch = globalThis.fetch
    const reached = []
    globalThis.fetch = (...args) => {
      reached.push(args)
      throw new Error('the banner must not reach the network')
    }
    try {
      const spawned = []
      const changelogFs = Volume.fromJSON({ [changelogPath()]: SAMPLE }, '/')
      const d = deps({
        changelogFs,
        readChangelog: undefined,
        exec: async (cmd, args) => {
          spawned.push(cmd)
          if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      })
      await startCommand(d)
      expect(reached).toEqual([])
      // Every process this run started, by name: the tmux session and nothing else. An
      // allowlist rather than a denylist, so a future `npm view` or `gh release list`
      // fails here instead of being spelled differently than the check.
      expect([...new Set(spawned)]).toEqual(['tmux'])
      expect(sectionOf(d)).toHaveLength(SAMPLE_SECTION_ROWS)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('shows one release’s news, never the file’s', async () => {
    // "What's new" is one release. The fixture's older entries are in the same file and
    // must not appear — a reader who sees four releases' bullets cannot tell which ones
    // they just installed, which is the only question the section answers.
    const changelogFs = Volume.fromJSON({ [changelogPath()]: SAMPLE }, '/')
    const { stdout } = await run({ changelogFs, readChangelog: undefined })
    for (const bullet of BULLETS) expect(stdout).toContain(bullet.slice(0, 30))
    for (const stale of [
      'GIF-to-sprite generator',
      'never finish a turn with a subagent',
      'release 0.19.1',
      'dev → main rollforward',
      'ralph` CLI binary',
    ]) {
      expect(stdout, stale).not.toContain(stale)
    }
  })
})
