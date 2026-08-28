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

import { readFileSync, readdirSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { StartAbort, startCommand } from './start.js'
import { renderSplashFrames, renderStaticBanner } from '../sprite-banner.js'
import { SPLASH_FRAME_COUNT, playSplash } from '../sprite-player.js'
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

// #73 — the bytes the command now writes where it used to write BANNER once: five frames
// redrawn in place, the cursor hidden for it, and the same seventeen rows left on the
// screen at the end.
//
// Produced by RUNNING the player against a recorder rather than by re-deriving the
// sequence here. A second copy of "hide, frame, up, frame, ..." in a wiring spec would be
// a second opinion about what the splash IS, and this file's claim is not the sequence —
// that is pinned byte by byte, against spelled-out escapes, in lib/sprite-player.test.js
// — but that `ralph start` drives that player, first, with the run's own capabilities.
const SPLASH = await splashChunks()

async function splashChunks() {
  const chunks = []
  await playSplash({
    frames: renderSplashFrames({ isTTY: true, color: true }),
    stream: { write: (chunk) => chunks.push(chunk) },
    sleep: async () => {},
    signals: null,
  })
  return chunks
}

const SPLASH_BLOCK = SPLASH.join('')

// How many LINES of stdout the splash occupies, counted from its bytes so no arithmetic
// in this file can drift from the player's: five frames of seventeen rows, with the
// cursor-control escapes riding on the front of the line that follows them.
const SPLASH_LINES = SPLASH_BLOCK.split('\n').length - 1

// Cursor control is written INTO the line it precedes, so the settled frame has to be
// read with those bytes stripped — the frame itself must still be #67's, unchanged.
const CURSOR_CONTROL = /^(?:\u001B\[(?:\d+A|\?25[hl]))+/
const settledFrame = (d) =>
  d.stdout
    .lines()
    .slice(SPLASH_LINES - BANNER.length, SPLASH_LINES)
    .map((line) => line.replace(CURSOR_CONTROL, ''))

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
    // The first event that is neither a stdout write nor the read of ralph.config.sh. #74
    // moved that read above the banner, because the file is where RALPH_BANNER is written and
    // the mode has to be known before anything is drawn — and a read that runs no shell,
    // writes nothing and prints nothing is not something that happened TO the user. So
    // "nothing happened before the banner" is still the claim; this is the index it is made at.
    firstEffect: () =>
      events.findIndex(
        (event) =>
          event.kind !== 'write' &&
          !(event.kind === 'readFile' && event.detail.endsWith('ralph.config.sh')),
      ),
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
    // #70: and the box's what's-new section is read from the changelog that ships inside
    // the package, so the same injection applies for the same reason — the real reader
    // would put whatever this repo's CHANGELOG.md says TODAY into every exact-output
    // assertion in this file, and the next release would then break them all (#41). The
    // section's own wiring is asserted in start.whats-new.test.js.
    readChangelog: () => [],
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    folderQueueCount: async () => queue,
    home: HOME,
    processEnv: {},
    // #73: the splash's two impure capabilities, neutralised for every test in this file
    // that does not have them as its subject. The default sleep is a real 200ms timer, so
    // a TTY run here would otherwise cost a second of wall clock EACH — thirty of them —
    // and the default signal source is the real process, so thirty runs would register
    // and remove thirty SIGINT listeners in the vitest worker. Both defaults are asserted
    // once, deliberately, in the #73 block below.
    sleep: async () => {},
    signals: null,
    ...overrides,
  }
}

// The command's output with the banner sliced off the front, so a suppressed run
// can be compared against an enabled one line for line. Since #73 that is the whole
// SPLASH — five frames — and not one.
const withoutBanner = (output) => output.split('\n').slice(SPLASH_LINES).join('\n')

describe('startCommand — the sprite banner (#67)', () => {
  it('plays the splash and settles on the static frame, on a colour-capable TTY', async () => {
    const d = deps({ isTTY: true })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    // #73: the animation is the first thing on the stream, byte for byte...
    expect(d.stdout.output().startsWith(SPLASH_BLOCK)).toBe(true)
    // ...and it is five frames of seventeen rows in eleven writes — one hide, five
    // frames, four moves back up, one restore. Spelled out rather than derived, because
    // constants computed from the code under test agree with a bug in it.
    expect(BANNER).toHaveLength(17)
    expect(SPLASH).toHaveLength(11)
    expect(SPLASH_FRAME_COUNT).toBe(5)
    expect(SPLASH_LINES).toBe(BANNER.length * SPLASH_FRAME_COUNT)
    // ...and what the terminal is LEFT holding is #67's frame, unchanged.
    expect(settledFrame(d)).toEqual(BANNER)
  })

  it('writes it above every side effect, below only the config read it now needs (#74)', async () => {
    const d = deps({ isTTY: true })
    await startCommand(d)
    // #74 put exactly ONE thing above the banner, and this is where it is pinned: the read
    // of ralph.config.sh, because RALPH_BANNER is written in that file and the splash
    // cannot be drawn before its own mode is known. That read is inert — no shell, no
    // write, no output — so what a user SEES is unchanged: the splash's eleven writes and
    // the box's three lines are still the first thing on the stream, and everything this
    // command DOES to the machine still happens after all of them.
    expect(d.timeline.events[0]).toEqual({
      kind: 'readFile',
      detail: `${REPO}/ralph.config.sh`,
    })
    expect(d.timeline.firstEffect()).toBe(1 + SPLASH.length + BOX.length)
    expect(d.timeline.writes().slice(0, SPLASH.length)).toEqual(
      SPLASH.map((chunk) => chunk.replace(/\n$/, '')),
    )
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
    expect(d.stdout.output().startsWith(SPLASH_BLOCK)).toBe(true)
    expect(settledFrame(d)).toEqual(BANNER)
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
    //
    // #73 changes the subtrahend and not the claim: what is prepended is the SPLASH —
    // five frames and the cursor control that redraws them in place — and the last thing
    // in it is a plain newline-terminated frame, which is why the piped run's first line
    // still starts at column zero with no escape glued to its front.
    const piped = deps()
    const tty = deps({ isTTY: true })
    await startCommand(piped)
    await startCommand(tty)
    expect(withoutBanner(tty.stdout.output())).toBe(piped.stdout.output())
    expect(tty.stdout.output()).toBe(`${SPLASH_BLOCK}${piped.stdout.output()}`)
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
    expect(forcedOn.stdout.output().startsWith(SPLASH_BLOCK)).toBe(true)
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
    expect(d.stdout.output().startsWith(SPLASH_BLOCK)).toBe(true)
    expect(settledFrame(d)).toEqual(BANNER)
    expect(d.stdout.output()).toContain('ℹ️  No issues in the queue. Nothing to do.')
  })
})

describe('startCommand — the splash animation (#73)', () => {
  it('drives the player with the injected sleep, for the second the PRD advertises', async () => {
    // The delays come from the ASSET (lib/sprite-data.js says 200ms per frame) and the
    // count from the player, so the wiring claim is that the command hands over the sleep
    // it was given and nothing here decides the timing. Five naps of 200 is the advertised
    // one second — and the reason a start cannot be held longer is upstream of this file:
    // the sequence is an array built before the first byte, not a loop against a clock.
    const naps = []
    const d = deps({ isTTY: true, sleep: async (ms) => naps.push(ms) })
    await startCommand(d)
    expect(naps).toEqual([200, 200, 200, 200, 200])
    expect(naps.reduce((total, ms) => total + ms, 0)).toBe(1000)
  })

  it('animates nothing, and hides no cursor, wherever the sprite is suppressed', async () => {
    // Criterion 6, at the only level where it is worth stating: a suppressed sprite is
    // not a faster animation, it is NO animation — no hide, no restore, no move, and no
    // sleep at all, so a piped `ralph start` is not one millisecond slower than it was.
    for (const options of [
      { label: 'a pipe', overrides: {} },
      { label: 'NO_COLOR', overrides: { isTTY: true, processEnv: { NO_COLOR: '1' } } },
      { label: 'an explicit color:false', overrides: { isTTY: true, color: false } },
      { label: 'a 20-column terminal', overrides: { isTTY: true, columns: 20 } },
    ]) {
      const naps = []
      const d = deps({ ...options.overrides, sleep: async (ms) => naps.push(ms) })
      await startCommand(d)
      expect(d.stdout.output(), options.label).not.toContain(`${ESC}[?25`)
      expect(d.stdout.output(), options.label).not.toMatch(/\u001B\[\d+A/)
      expect(naps, options.label).toEqual([])
    }
  })

  it('registers its interrupt handler on the real process when no source is injected', async () => {
    // The DEFAULT wiring, so `signals` cannot be plumbed to nothing: the handler exists
    // to put the cursor back if the user hits Ctrl-C mid-animation, and a default of
    // `null` would make that unreachable in production while every test still passed.
    // Observed from INSIDE the splash, through the injected sleep, because by the time
    // the command returns the listener is — and must be — gone again.
    const before = process.listenerCount('SIGINT')
    const during = []
    const d = deps({
      isTTY: true,
      signals: undefined,
      sleep: async () => during.push(process.listenerCount('SIGINT')),
    })
    await startCommand(d)
    expect(during[0]).toBe(before + 1)
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('forwards an injected signal source, leaving the real process alone', async () => {
    const registered = []
    const signals = {
      pid: 1234,
      on: (name) => registered.push(`on ${name}`),
      off: (name) => registered.push(`off ${name}`),
    }
    const before = process.listenerCount('SIGINT')
    const d = deps({ isTTY: true, signals })
    await startCommand(d)
    expect(registered).toEqual(['on SIGINT', 'off SIGINT'])
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('costs the animation and never the run when the splash throws', async () => {
    // Same rule as the cache read and the changelog read: a banner is never worth losing
    // a run over. A sleep or a stream that throws mid-splash costs the picture, and the
    // exit code, the box and stderr are exactly what they would have been.
    const d = deps({
      isTTY: true,
      sleep: async () => {
        throw new Error('timer exploded')
      },
    })
    expect(await startCommand(d)).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(d.stderr.output()).toBe('')
    expect(d.stdout.output()).toContain(BOX[0])
  })

  it('is exclusive to `ralph start` — no other command plays anything', async () => {
    // Criterion 7, as absence: `ralph status`, `ralph update`, `ralph changelog` and the
    // rest write their output and exit, and the way to keep it that way is to notice the
    // day one of them imports the player rather than to assert on each of their outputs
    // one at a time.
    const dir = new URL('.', import.meta.url)
    const modules = readdirSync(dir).filter(
      (name) => name.endsWith('.js') && !name.includes('.test.'),
    )
    const players = modules.filter((name) =>
      readFileSync(new URL(name, dir), 'utf8').includes('sprite-player'),
    )
    expect(players).toEqual(['start.js'])
    expect(modules.length).toBeGreaterThan(1)
  })
})

describe('startCommand — the identity box (#68)', () => {
  // The box wherever it happens to be, found by its own frame rather than by an
  // index: nothing else this command prints draws a rounded corner, and a finder
  // rather than a slice is what lets the same helper serve a TTY run (box under the
  // splash's eighty-five rows) and a piped one (box first).
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
    // Positional, not just present: the splash's frames, then the box, then the
    // preflight — and no blank line inserted anywhere in between.
    //
    // #73 makes this the load-bearing assertion for "the final write is a frame": the box
    // starts on the line straight after the splash's last row, so the restore and the last
    // cursor move both happened BEFORE that row rather than between it and the box top.
    // A restore written after the settled frame would land inside `╭─ ralph`.
    expect(d.stdout.lines().slice(SPLASH_LINES, SPLASH_LINES + BOX.length)).toEqual(BOX)
    expect(d.stdout.output().startsWith(`${SPLASH_BLOCK}${BOX.join('\n')}\n`)).toBe(true)
    // ...and written before the first thing this command DOES — the tmux uniqueness check.
    // A box printed after the preflight would still pass the slice above on a successful
    // run. The leading 1 is #74's inert config read, which is the only event above the
    // banner; see the sprite's ordering test for why it does not count as something
    // happening.
    expect(d.timeline.firstEffect()).toBe(1 + SPLASH.length + BOX.length)
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
    // 50 columns rather than 40, since #72: the claim here is that the WIDTH comes from
    // the stream, and `boxOf` finds the box by its frame — which under 44 columns is
    // deliberately no longer drawn. 50 is narrower than the target and still boxed, so
    // it exercises the same seam without asserting the frame's existence twice.
    const narrow = deps({ isTTY: true })
    narrow.stdout.columns = 50
    await startCommand(narrow)
    expect(boxOf(narrow)).toEqual(boxFor({ width: 50, color: true }))
    for (const line of boxOf(narrow)) expect([...line].length).toBeLessThanOrEqual(50)

    // An explicit option beats the stream, on the same convention as `stdoutIsTTY` — and
    // at 30 columns what it beats it with is #72's BARE form, so it is taken by POSITION
    // rather than through the frame-hunting helper. A piped run, so the box is line 0.
    const explicit = deps({ columns: 30 })
    await startCommand(explicit)
    const bare = boxFor({ width: 30 })
    expect(bare.join('\n')).not.toMatch(/[╭╮╰╯│─]/)
    expect(explicit.stdout.lines().slice(0, bare.length)).toEqual(bare)

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
    expect(d.stdout.lines().slice(SPLASH_LINES, SPLASH_LINES + BOX.length)).toEqual(BOX)
    expect(d.timeline.firstEffect()).toBe(1 + SPLASH.length + BOX.length)
  })

  it('still prints the box on the empty-queue early return', async () => {
    const d = deps({ queue: 0 })
    await startCommand(d)
    expect(boxOf(d)).toEqual(BOX)
    expect(d.stdout.output()).toContain('ℹ️  No issues in the queue. Nothing to do.')
  })

  it('degrades with the terminal, and decides nothing itself (#72)', async () => {
    // #72's wiring, which is one argument long: the command forwards the column count it
    // already resolved and holds no gate of its own. Three widths, one per rung of the
    // ladder, asserted against the same pure functions the command calls — the ladder
    // itself is lib/banner-compose.test.js's business.
    //
    // 20 columns: no sprite at all (26 cells cannot fit), and the facts bare.
    const tiny = deps({ isTTY: true, columns: 20 })
    await startCommand(tiny)
    expect(tiny.stdout.output()).not.toMatch(/[▀▄]/)
    expect(tiny.stdout.output()).not.toContain(`${ESC}[38;2;`)
    const bare = boxFor({ width: 20, color: true })
    expect(tiny.stdout.lines().slice(0, bare.length)).toEqual(bare)
    // ...and the facts are STILL THERE, which is the half a narrow terminal must not
    // lose: which Ralph, and where it is running.
    expect(bare[0]).toBe(`ralph ${VERSION}`)
    expect(bare.some((line) => line.includes(REPO))).toBe(true)
    for (const line of bare) expect([...line].length).toBeLessThanOrEqual(20)

    // 30 columns: the sprite fits, the box does not. #73: the splash is the same bytes at
    // every width the sprite survives — the ladder's rung is a yes/no about drawing at
    // all, never a smaller frame — so the same block is expected at 30 as at 60.
    const narrow = deps({ isTTY: true, columns: 30 })
    await startCommand(narrow)
    const narrowBox = boxFor({ width: 30, color: true })
    expect(narrow.stdout.output().startsWith(SPLASH_BLOCK)).toBe(true)
    expect(
      narrow.stdout.lines().slice(SPLASH_LINES, SPLASH_LINES + narrowBox.length),
    ).toEqual(narrowBox)
    expect(narrowBox.join('\n')).not.toMatch(/[╭╮╰╯│─]/)

    // 60 columns: byte-for-byte what this command printed before #72.
    const wide = deps({ isTTY: true, columns: 60 })
    await startCommand(wide)
    expect(wide.stdout.output().startsWith(SPLASH_BLOCK)).toBe(true)
    expect(settledFrame(wide)).toEqual(BANNER)
    expect(wide.stdout.lines().slice(SPLASH_LINES, SPLASH_LINES + BOX.length)).toEqual(BOX)
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
