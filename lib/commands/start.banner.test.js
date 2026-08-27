// #67 — the sprite, wired into `ralph start` as its FIRST output.
//
// Two claims, and the second one is the load-bearing half:
//
//   1. On a colour-capable TTY the command writes one static frame before it does
//      anything else — above the tmux uniqueness check, above the config read,
//      above every preflight line. "First" is asserted as an ORDER against the
//      other side effects, not just as a prefix of stdout, because a banner printed
//      after the tmux guard would still be the first line of a successful run and
//      the last thing a reader sees on a failed one.
//   2. Everywhere else — a pipe, a file, a CI log, NO_COLOR — `ralph start` is
//      byte-for-byte the command it was before this issue. That is asserted by
//      running the SAME deps twice and subtracting: the TTY run must equal the
//      banner plus the non-TTY run, with nothing else moved, added or reworded.
//
// Both capabilities are INJECTED (#41). The suite therefore says nothing about the
// terminal it happens to run in: `stdoutIsTTY` is a boolean here and NO_COLOR is a
// key in an injected bag, never a variable in the developer's shell.
//
// #68 ADDS A SECOND HALF to the banner, and reading claim 2 precisely is what decides
// its shape: what must stay byte-for-byte identical everywhere is the SPRITE. The
// identity box below it is TEXT — a version, a working directory, an update hint — and
// the PRD is explicit that a run without colour or without a TTY still gets "the facts
// alone". So the box prints on a pipe, into a launchd log and under NO_COLOR exactly as
// it does on a terminal; what a piped run gains is the lines that say which Ralph, in
// which directory, produced the log, and what it keeps is the promise that matters
// there — with colour off the box contains not one escape byte.
//
//   3. THE BOX IS UNDER THE SPRITE AND ABOVE EVERYTHING ELSE, on every way out,
//      including the aborting ones — where it is the only context the failure has —
//      and its update hint comes from the CACHE, never from a network call.

import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { StartAbort, startCommand } from './start.js'
import { renderStaticBanner } from '../sprite-banner.js'
import { composeBanner } from '../banner-compose.js'
import { EMPTY_VERSION_CACHE, versionCachePath } from '../version-cache.js'
import { sessionNameFor } from '../lock.js'

const ESC = '\u001B'
const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'
const SESSION = sessionNameFor(REPO)

// The 17 rows a colour-capable terminal must receive, from the same pure function
// the command calls — the pixels themselves are lib/sprite-banner.test.js's
// business, and duplicating them here would pin the placeholder art into a wiring
// spec.
const BANNER = renderStaticBanner({ isTTY: true, color: true })

// ...and the box, from the same pure function for the same reason: its layout, its
// truncation and its 60-column target are lib/banner-compose.test.js's business.
const boxFor = ({
  version = VERSION,
  latestVersion = null,
  cwd = REPO,
  color = false,
  width,
} = {}) => composeBanner({ facts: { version, latestVersion, cwd }, width, capabilities: { color } })

// The box every run in this file prints unless it asks for another: this version, this
// repo, an empty cache, no colour.
const BOX = boxFor()

const stripAnsi = (text) => text.replaceAll(/\u001B\[\d+m/g, '')

// Every side effect the command has, in the order it has them: stdout writes, the
// config read, and each exec. One array, so "the banner came first" is a statement
// about the whole run rather than about one stream.
function makeTimeline() {
  const events = []
  return {
    events,
    record: (kind, detail = '') => events.push({ kind, detail }),
    firstOther: () => events.findIndex((event) => event.kind !== 'write'),
    writes: () => events.filter((event) => event.kind === 'write').map((event) => event.detail),
  }
}

function makeStream(timeline, { isTTY, kind = 'write' } = {}) {
  const chunks = []
  const stream = {
    write: (s) => {
      chunks.push(s)
      timeline?.record(kind, s.replace(/\n$/, ''))
      return true
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
  // Only ever SET when a test asks for it: `Boolean(undefined)` is what a piped
  // stdout answers, and that is the default every other start spec runs under.
  if (isTTY !== undefined) stream.isTTY = isTTY
  return stream
}

// Driven through the folder source so the queue depth is a dependency rather than a
// `gh` stub — the banner is source-independent.
const deps = ({
  isTTY,
  queue = 3,
  sessionExists = false,
  config = 'TASK_SOURCE=folder\n',
  timeline = makeTimeline(),
  ...overrides
} = {}) => {
  const stdout = makeStream(timeline, { isTTY })
  const stderr = makeStream(timeline, { kind: 'stderr' })
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, options })
    timeline.record('exec', key)
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: sessionExists ? 0 : 1, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return {
    cwd: REPO,
    stdout,
    stderr,
    timeline,
    exec,
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => {
      timeline.record('readFile', String(p))
      return String(p).endsWith('ralph.config.sh') ? config : ''
    },
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
    // #68: the box's update hint is read from the global update-check cache, so the
    // read is injected here on the same convention as `cacheFs` — a developer whose
    // real ~/.config/ralph happens to hold a newer version would otherwise see an
    // extra row appear in every exact-output assertion in this file, on their machine
    // and nowhere else (#41).
    readCache: () => ({ ...EMPTY_VERSION_CACHE }),
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    folderQueueCount: async () => queue,
    home: HOME,
    processEnv: {},
    ...overrides,
  }
}

// The command's output with the banner sliced off the front, so a suppressed run
// can be compared against an enabled one line for line.
const withoutBanner = (output) => output.split('\n').slice(BANNER.length).join('\n')

describe('startCommand — the sprite banner (#67)', () => {
  it('writes the static frame as the first 17 lines on a colour-capable TTY', async () => {
    const d = deps({ isTTY: true })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(d.stdout.lines().slice(0, BANNER.length)).toEqual(BANNER)
    expect(BANNER).toHaveLength(17)
  })

  it('writes it before the config read and before the tmux uniqueness check', async () => {
    const d = deps({ isTTY: true })
    await startCommand(d)
    // The first thing that is not a stdout write is the whole banner in: seventeen
    // sprite rows and the box under them, then the preflight the command always did.
    const banner = BANNER.length + BOX.length
    expect(d.timeline.firstOther()).toBe(banner)
    expect(d.timeline.writes().slice(0, BANNER.length)).toEqual(BANNER)
    const first = d.timeline.events[banner]
    expect(first.kind).toBe('readFile')
    const firstExec = d.timeline.events.find((event) => event.kind === 'exec')
    expect(firstExec.detail).toBe(`tmux has-session -t ${SESSION}`)
  })

  it('writes it above the tmux-session-taken error, and still exits 1', async () => {
    // The abort path matters most: this is the run where the banner is the ONLY
    // thing above the failure, so it must not have been skipped by an early return.
    const d = deps({ isTTY: true, sessionExists: true })
    await expect(startCommand(d)).rejects.toThrow(StartAbort)
    await expect(startCommand(deps({ isTTY: true, sessionExists: true }))).rejects.toMatchObject({
      exitCode: 1,
    })
    expect(d.stdout.lines().slice(0, BANNER.length)).toEqual(BANNER)
    expect(d.stderr.output()).toContain(`❌ tmux session '${SESSION}' already exists.`)
  })

  it('sends the banner to stdout only — stderr is untouched by it', async () => {
    const d = deps({ isTTY: true })
    await startCommand(d)
    expect(d.stderr.output()).toBe('')
  })

  it('writes no sprite, and no escape sequence at all, when stdout is not a TTY', async () => {
    // Not "writes nothing": #68's box is text and prints here too (see the block
    // below). What a pipe must never receive is a 24-bit escape or a half-block
    // glyph — the sprite is decoration and never wins that trade.
    const d = deps()
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(d.stdout.output()).not.toContain(ESC)
    expect(d.stdout.output()).not.toContain('▀')
    expect(d.stdout.output()).not.toContain('▄')
  })

  it('leaves the existing output byte-for-byte unchanged when suppressed', async () => {
    // The subtraction: one run with the banner, one without, identical deps. The
    // enabled run must be the suppressed run with 17 rows prepended and nothing
    // else different — no blank line, no reordering, no reworded label.
    //
    // Still exactly 17, after #68: the box is in BOTH runs and identical in both, so
    // it cancels out of the subtraction. That is the assertion which proves the box
    // did not quietly become TTY-only, and the reason this test needed no change.
    const piped = deps()
    const tty = deps({ isTTY: true })
    await startCommand(piped)
    await startCommand(tty)
    expect(withoutBanner(tty.stdout.output())).toBe(piped.stdout.output())
    expect(tty.stdout.output()).toBe(`${BANNER.join('\n')}\n${piped.stdout.output()}`)
    expect(tty.stderr.output()).toBe(piped.stderr.output())
  })

  it('honors NO_COLOR from the injected environment, whatever its value', async () => {
    for (const value of ['1', 'false', '']) {
      const d = deps({ isTTY: true, processEnv: { NO_COLOR: value } })
      const plain = deps()
      await startCommand(d)
      await startCommand(plain)
      expect(d.stdout.output(), JSON.stringify(value)).toBe(plain.stdout.output())
      expect(d.stdout.output()).not.toContain(ESC)
    }
  })

  it('takes the capabilities as injected options, not from the ambient terminal', async () => {
    // Explicit beats derived, in BOTH directions: a TTY stdout with the option off
    // prints nothing, and a piped stdout with both options on prints the frame. No
    // assertion in this file can therefore be changed by the terminal it runs in.
    const forcedOff = deps({ isTTY: true, stdoutIsTTY: false })
    await startCommand(forcedOff)
    expect(forcedOff.stdout.output()).not.toContain(ESC)

    const forcedOn = deps({ stdoutIsTTY: true, color: true })
    await startCommand(forcedOn)
    expect(forcedOn.stdout.lines().slice(0, BANNER.length)).toEqual(BANNER)
  })

  it('does not reuse the stdin-facing isTTY option', async () => {
    // #25's `isTTY` is about STDIN and gates the update prompt's readline. A run
    // that is interactive on stdin but piped on stdout must print no sprite.
    const d = deps({ isTTY: undefined, stdin: { isTTY: true } })
    await startCommand(d)
    expect(d.stdout.output()).not.toContain(ESC)
  })

  it('changes no exit code, banner or not', async () => {
    for (const isTTY of [undefined, true]) {
      expect(await startCommand(deps({ isTTY, queue: 3 }))).toEqual({
        exitCode: 0,
        started: true,
        count: 3,
      })
      expect(await startCommand(deps({ isTTY, queue: 0 }))).toEqual({
        exitCode: 0,
        started: false,
      })
      await expect(startCommand(deps({ isTTY, sessionExists: true }))).rejects.toMatchObject({
        exitCode: 1,
      })
    }
  })

  it('still prints the frame on the empty-queue early return', async () => {
    // The queue is checked long after the banner is written, so this is a
    // regression guard for a future edit that moves the banner down.
    const d = deps({ isTTY: true, queue: 0 })
    await startCommand(d)
    expect(d.stdout.lines().slice(0, BANNER.length)).toEqual(BANNER)
    expect(d.stdout.output()).toContain('ℹ️  No issues in the queue. Nothing to do.')
  })
})

describe('startCommand — the identity box (#68)', () => {
  // The box wherever it happens to be, found by its own frame rather than by an
  // index: nothing else this command prints draws a rounded corner, and a finder
  // rather than a slice is what lets the same helper serve a TTY run (box under
  // seventeen sprite rows) and a piped one (box first).
  const boxOf = (d) => {
    const lines = d.stdout.lines()
    const top = lines.findIndex((line) => line.startsWith('╭'))
    const bottom = lines.findIndex((line) => line.startsWith('╰'))
    return top === -1 || bottom < top ? [] : lines.slice(top, bottom + 1)
  }

  const rowOf = (d, label) => boxOf(d).find((line) => stripAnsi(line).includes(`│ ${label}`))

  it('writes the box under the sprite, above every preflight side effect', async () => {
    const d = deps({ isTTY: true })
    await startCommand(d)
    // Positional, not just present: seventeen sprite rows, then the box, then the
    // preflight — and no blank line inserted anywhere in between.
    expect(d.stdout.lines().slice(BANNER.length, BANNER.length + BOX.length)).toEqual(BOX)
    expect(d.stdout.output().startsWith(`${[...BANNER, ...BOX].join('\n')}\n`)).toBe(true)
    // ...and written before the first thing that is not a stdout write, which is the
    // config read. A box printed after the preflight would still pass the slice above
    // on a successful run.
    expect(d.timeline.firstOther()).toBe(BANNER.length + BOX.length)
  })

  it('writes the box on a pipe, where the sprite is suppressed', async () => {
    // The decision this issue turns on. A launchd log, a CI job, `ralph start | tee`:
    // the sprite is noise there and the FACTS are the whole reason to read the log at
    // all, so the box prints — in plain text, with not one escape byte.
    const d = deps()
    await startCommand(d)
    expect(d.stdout.lines().slice(0, BOX.length)).toEqual(BOX)
    expect(d.stdout.output()).not.toContain(ESC)
  })

  it('writes the box under NO_COLOR, and under an explicit color:false', async () => {
    // Same argument as the pipe: NO_COLOR is a request about ANSI, not a request to
    // be told nothing about the run.
    for (const options of [
      { isTTY: true, processEnv: { NO_COLOR: '1' } },
      { isTTY: true, color: false },
      { stdoutIsTTY: false },
    ]) {
      const d = deps(options)
      await startCommand(d)
      expect(boxOf(d), JSON.stringify(options)).toEqual(BOX)
      expect(d.stdout.output()).not.toContain(ESC)
    }
  })

  it('titles the box with the version it was handed, and says unknown without one', async () => {
    const known = deps({ currentVersion: '9.8.7' })
    await startCommand(known)
    expect(boxOf(known)[0]).toContain('ralph 9.8.7')

    // `currentVersion` defaults to 'unknown' in the signature — a package.json
    // bin/ralph.js could not read. The box names what is missing rather than
    // inventing a plausible number.
    const unknown = deps({ currentVersion: undefined })
    await startCommand(unknown)
    expect(boxOf(unknown)[0]).toContain('ralph unknown')
  })

  it('shows the working directory the run was given', async () => {
    const d = deps({ cwd: '/Users/me/projects/other' })
    await startCommand(d)
    expect(rowOf(d, 'cwd')).toContain('/Users/me/projects/other')
  })

  it('names a newer cached version and points at `ralph update`', async () => {
    const d = deps({ readCache: () => ({ ...EMPTY_VERSION_CACHE, latest_version: '9.9.9' }) })
    await startCommand(d)
    const row = rowOf(d, 'update')
    expect(row).toContain('9.9.9')
    expect(row).toContain('ralph update')
    // The hint is a row IN the box, not a line above or below it.
    expect(boxOf(d)).toEqual(boxFor({ latestVersion: '9.9.9' }))
  })

  it('shows no hint for a cache that holds nothing newer, or nothing usable', async () => {
    // The three "no hint" criteria plus the shapes a hand-edited or hostile cache
    // file can take. None may add a row, and none may cost the run.
    const CACHES = [
      ['an empty cache', { ...EMPTY_VERSION_CACHE }],
      ['no latest_version field', { last_check_at: null }],
      ['the installed version', { latest_version: VERSION }],
      ['an older version', { latest_version: '1.2.2' }],
      ['an older major', { latest_version: '0.9.9' }],
      ['a garbage version', { latest_version: 'banana' }],
      ['a numeric version', { latest_version: 42 }],
      ['a null cache', null],
      ['an array', []],
      ['a string', 'nope'],
    ]
    for (const [name, cache] of CACHES) {
      const d = deps({ readCache: () => cache })
      await startCommand(d)
      expect(boxOf(d), name).toEqual(BOX)
      expect(d.stdout.output(), name).not.toContain('ralph update')
    }
  })

  it('reads the cache once, through the seam, with the run’s fs, env and home', async () => {
    const cacheFs = { readFileSync: () => '{}' }
    const processEnv = { XDG_CONFIG_HOME: '/xdg' }
    const seen = []
    const d = deps({
      cacheFs,
      processEnv,
      home: '/home/other',
      readCache: (args) => {
        seen.push(args)
        return { ...EMPTY_VERSION_CACHE }
      },
    })
    await startCommand(d)
    // Once per run, not once per line, and with the run's OWN capabilities: a cache
    // read that reached the ambient process.env or the real homedir would make this
    // command's output depend on the machine it ran on (#41).
    expect(seen).toHaveLength(1)
    expect(seen[0].fs).toBe(cacheFs)
    expect(seen[0].processEnv).toBe(processEnv)
    expect(seen[0].home).toBe('/home/other')
  })

  it('reads a real cache file through the injected fs, with no seam override', async () => {
    // The seam above is what the other tests steer; this is the DEFAULT wiring, so
    // `readCache` cannot be plumbed to nothing. memfs stands in for ~/.config/ralph.
    const path = versionCachePath({ processEnv: {}, home: HOME })
    const cacheFs = Volume.fromJSON({ [path]: JSON.stringify({ latest_version: '7.0.0' }) }, '/')
    const d = deps({ cacheFs, readCache: undefined })
    await startCommand(d)
    expect(rowOf(d, 'update')).toContain('7.0.0')
  })

  it('asks no network for the hint — the cache is the only source', async () => {
    // `update` is the machinery that may reach the registry (#24), and it is told
    // there is nothing: source `disabled`, latestVersion null. The hint still appears,
    // which is only possible if it came from the cache. And no `npm view` was spawned.
    const d = deps({ readCache: () => ({ latest_version: '9.9.9' }) })
    await startCommand(d)
    expect(rowOf(d, 'update')).toContain('9.9.9')
    expect(d.exec.calls.map((call) => call.cmd)).not.toContain('npm')
  })

  it('reads no cache and offers no hint when the user opted out of update checks', async () => {
    // #24's opt-out is what a user sets to stop being told about updates, and the box
    // is exactly that being told. Its own docs say the opt-out path "reads no cache at
    // all", and two QA suites pin that as zero operations on the cache fs — so the box
    // must not be the thing that starts touching it. Same rule as `isUpdateCheckDisabled`
    // rather than a second reading of the variable: any value but the negatives.
    for (const value of ['1', 'true', 'TRUE', 'yes', ' 1 ']) {
      const seen = []
      const d = deps({
        processEnv: { RALPH_NO_UPDATE_CHECK: value },
        readCache: () => {
          seen.push(value)
          return { latest_version: '9.9.9' }
        },
      })
      await startCommand(d)
      expect(seen, JSON.stringify(value)).toEqual([])
      expect(boxOf(d), JSON.stringify(value)).toEqual(BOX)
    }

    // ...and the negatives leave the check — and so the hint — switched on.
    for (const value of ['0', 'false', '']) {
      const d = deps({
        processEnv: { RALPH_NO_UPDATE_CHECK: value },
        readCache: () => ({ latest_version: '9.9.9' }),
      })
      await startCommand(d)
      expect(rowOf(d, 'update'), JSON.stringify(value)).toContain('9.9.9')
    }
  })

  it('costs a hint and never the run when the cache read throws', async () => {
    // readVersionCache is total for a bad FILE but not for a bad ARGUMENT — a
    // non-string home or a truthy non-string XDG_CONFIG_HOME throws a TypeError out
    // of join() before its try blocks. A banner is never worth losing a run over.
    const d = deps({
      readCache: () => {
        throw new TypeError('The "path" argument must be of type string.')
      },
    })
    expect(await startCommand(d)).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(boxOf(d)).toEqual(BOX)
    expect(d.stderr.output()).toBe('')
  })

  it('paints the hint on a colour-capable TTY, and nothing else in the box', async () => {
    const tty = deps({ isTTY: true, readCache: () => ({ latest_version: '9.9.9' }) })
    await startCommand(tty)
    expect(boxOf(tty)).toEqual(boxFor({ latestVersion: '9.9.9', color: true }))
    // Every other line of the box is plain, and the colour changes no visible column.
    const painted = boxOf(tty)
    expect(painted.filter((line) => line.includes(ESC))).toHaveLength(1)
    expect(painted.map(stripAnsi)).toEqual(boxFor({ latestVersion: '9.9.9' }))
  })

  it('takes its width from the stream, and the default when it has none', async () => {
    const narrow = deps({ isTTY: true })
    narrow.stdout.columns = 40
    await startCommand(narrow)
    expect(boxOf(narrow)).toEqual(boxFor({ width: 40 }))
    for (const line of boxOf(narrow)) expect([...line].length).toBeLessThanOrEqual(40)

    // An explicit option beats the stream, on the same convention as `stdoutIsTTY`...
    const explicit = deps({ columns: 30 })
    await startCommand(explicit)
    expect(boxOf(explicit)).toEqual(boxFor({ width: 30 }))

    // ...and a piped stream has no `columns` at all, which is the default's case.
    const piped = deps()
    await startCommand(piped)
    expect(boxOf(piped)).toEqual(BOX)
  })

  it('still prints the box above the tmux-session-taken error', async () => {
    // The run where the box is the only context the failure has: which Ralph, which
    // directory. A box printed after the guard would be missing from exactly here.
    const d = deps({ isTTY: true, sessionExists: true })
    await expect(startCommand(d)).rejects.toThrow(StartAbort)
    expect(d.stdout.lines().slice(BANNER.length, BANNER.length + BOX.length)).toEqual(BOX)
    expect(d.timeline.firstOther()).toBe(BANNER.length + BOX.length)
  })

  it('still prints the box on the empty-queue early return', async () => {
    const d = deps({ queue: 0 })
    await startCommand(d)
    expect(boxOf(d)).toEqual(BOX)
    expect(d.stdout.output()).toContain('ℹ️  No issues in the queue. Nothing to do.')
  })

  it('creates no cache file and writes nothing while composing the box', async () => {
    // The box READS the cache. #24 owns writing it, and a banner must not warm,
    // stamp or create anything — a `ralph start` in a fresh container that only
    // aborts on the tmux guard must leave ~/.config/ralph exactly as it found it.
    const cacheFs = new Volume()
    const d = deps({ cacheFs, readCache: undefined, sessionExists: true })
    await expect(startCommand(d)).rejects.toThrow(StartAbort)
    expect(cacheFs.toJSON()).toEqual({})
  })
})
