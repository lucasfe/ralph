// #73 QA — the splash as a thing `ralph start` now AWAITS, on every one of its ways out.
//
// start.banner.qa.test.js already subtracts a TTY run from a piped one on all twelve paths
// and proves the sprite's bytes are a prefix and nothing else. That is the picture. This
// file is about the four things the picture cannot show, each of which is an acceptance
// criterion of #73 rather than of #67:
//
//   1. SUPPRESSED MEANS SUPPRESSED IN TIME, not only in bytes. Criterion 6 says nothing is
//      written when the sprite is not rendered, and a byte assertion passes for a run that
//      wrote nothing and still napped for a second before printing it. `ralph start` is
//      what a launchd job and a CI step run; a second of sleep per invocation that no log
//      could ever show is the worst kind of regression, so the naps are COUNTED on every
//      suppressed run, and so are the signal registrations — a piped start that attached a
//      SIGINT handler would change how Ctrl-C behaves for a run with no animation in it.
//   2. THE EXIT CODE, WITH THE SPLASH SABOTAGED. Criterion 8 says the codes are unchanged
//      including on an interrupt. `startCommand` has twelve answers — three launches, two
//      early returns and six aborts — and #73 adds an `await` in front of all of them.
//      Every path is therefore run four times: with a working splash, with a timer that
//      throws, with a stdout that refuses the animation, and with Ctrl-C landing between two
//      frames. The command's answer has to be the same object every time.
//   3. WHAT THE TERMINAL IS LEFT HOLDING. Criterion 3 says the final write is a frame with
//      no cursor movement after it. Asserted here over the WHOLE run rather than over the
//      splash — two DECTCEM toggles and four cursor-ups in the entire output, none of them
//      after the settled frame — because the bug this ordering exists to prevent is a
//      control byte glued to the front of the box's `╭─`, and only a run that prints the box
//      can show that.
//   4. EXCLUSIVITY, TRANSITIVELY. Criterion 7 is asserted upstream by reading
//      lib/commands/*.js for the player's name. That catches a direct import into a sibling
//      command and passes for an INDIRECT one — a helper the player got pulled into, or a
//      re-export — so it is redone here as a walk of the whole package's import graph.
//
// HERMETIC (#41): the splash's two impure capabilities are injected on every run below, and
// this file's default `signals` is a RECORDER rather than the real `process`, because a
// hundred runs against the honest default would register and remove a hundred SIGINT
// handlers on the vitest worker — and any one of them that leaked would arm the worker to
// die on the next Ctrl-C. No test here sends a real signal or waits on a real clock.
//
// THE ONE THING THIS FILE CANNOT ASSERT, stated so it is not mistaken for covered: the exit
// code 130. That number is Node's, produced by re-raising SIGINT at a default disposition
// this suite may not restore inside its own worker. What is asserted instead is the whole of
// what `startCommand` contributes to it — the handler stands down, hands the signal back
// through the source it was given, and the command's own answer is unchanged — plus, in the
// player's own QA file, that nothing else in the package is listening.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { StartAbort, startCommand } from './start.js'
import { renderSplashFrames, renderStaticBanner } from '../sprite-banner.js'
import { playSplash } from '../sprite-player.js'
// #72's ladder, imported so "boxed at this width" is asked of the rule rather than restated
// as a `>= 44` this file would then have to keep in step with it.
import { bannerLayout } from '../banner-compose.js'

const ESC = '\u001B'
// The sprite's 24-bit signature and the animation's cursor control, kept apart on purpose:
// picocolors decides colour from the real environment at import and paints the update notice
// on any machine with CI set, so a run's basic-16 escapes are not the banner's doing. These
// two are — nothing else in `ralph start` emits truecolor or DECTCEM.
const SPRITE_FG = `${ESC}[38;2;`
const SPRITE_BG = `${ESC}[48;2;`
const HIDE = `${ESC}[?25l`
const SHOW = `${ESC}[?25h`
const CURSOR_UP = new RegExp(`${ESC}\\[(\\d+)A`, 'g')

/** No trace of the animation: no cell, no glyph, and no cursor touched either. */
function expectNoSplash(output) {
  expect(output).not.toContain(SPRITE_FG)
  expect(output).not.toContain(SPRITE_BG)
  expect(output).not.toMatch(/[▀▄]/)
  expect(output).not.toContain(`${ESC}[?25`)
  expect(output).not.toMatch(new RegExp(`${ESC}\\[\\d+A`))
}

const REPO = '/repo'
const HOME = '/home/me'

// The still, and the splash's bytes and naps — all three DERIVED by driving the same player
// with the same frames the command hands it, never restated here. A second copy of the
// sequence would be a second opinion about what the splash is; what this file asserts is
// what the COMMAND does with it.
const BANNER = renderStaticBanner({ isTTY: true, color: true })
const { chunks: SPLASH, naps: SPLASH_NAPS } = await recordSplash()

async function recordSplash() {
  const chunks = []
  const naps = []
  await playSplash({
    frames: renderSplashFrames({ isTTY: true, color: true }),
    stream: { write: (chunk) => chunks.push(chunk) },
    sleep: async (ms) => naps.push(ms),
    // No signal source at all: this is a module-level await in a vitest worker, and the
    // player's honest default would register on the worker's own process.
    signals: null,
  })
  return { chunks, naps }
}

const SPLASH_BLOCK = SPLASH.join('')

// One bag, every path reachable from its options — the same twelve-way surface
// start.banner.qa.test.js drives, with the splash's two seams turned into RECORDERS so a
// run's naps and signal traffic are as assertable as its bytes.
function deps({
  isTTY,
  queue = 3,
  sessionExists = false,
  config = 'TASK_SOURCE=folder\n',
  files = ['ralph.config.sh'],
  hasCommand = () => true,
  peekLock = () => null,
  ghAuthOk = true,
  mcpOk = true,
  tmuxLaunchOk = true,
  update = async () => NO_UPDATE,
  runUpdate,
  orphans = '',
  ghQueue = '3',
  refuseSplash = false,
  ...overrides
} = {}) {
  const naps = []
  const ops = []
  const stdout = makeStream({ isTTY, refuseSplash })
  const stderr = makeStream({})
  const handlers = []
  // A signal source that records rather than acts: `on`/`off` really register and remove so
  // a leak is visible, and `kill` is what the player's default `raise` finds — so a
  // re-raised SIGINT lands in this array instead of in the vitest worker.
  const signals = {
    pid: 4242,
    ops,
    handlers,
    on: (name, fn) => {
      ops.push(`on ${name}`)
      handlers.push({ name, fn })
    },
    off: (name, fn) => {
      ops.push(`off ${name}`)
      const index = handlers.findIndex((entry) => entry.fn === fn)
      if (index >= 0) handlers.splice(index, 1)
    },
    kill: (pid, name) => ops.push(`kill ${pid} ${name}`),
    interrupt: () => {
      for (const entry of [...handlers]) if (entry.name === 'SIGINT') entry.fn('SIGINT')
    },
  }
  const exec = async (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: sessionExists ? 0 : 1, stdout: '', stderr: '' }
    }
    if (cmd === 'tmux' && args[0] === 'new') {
      return tmuxLaunchOk
        ? { exitCode: 0, stdout: '', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'no server running\n' }
    }
    if (cmd === 'gh' && args[0] === 'auth') {
      return { exitCode: ghAuthOk ? 0 : 1, stdout: '', stderr: '' }
    }
    if (cmd === 'jq' && args[0] === '-e') return { exitCode: mcpOk ? 0 : 1, stdout: '', stderr: '' }
    if (cmd === 'jq') return { exitCode: 0, stdout: 'ctx, gh\n', stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue' && args.includes('in-progress')) {
      return { exitCode: 0, stdout: orphans, stderr: '' }
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return { exitCode: 0, stdout: ghQueue, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return {
    cwd: REPO,
    stdout,
    stderr,
    naps,
    signals,
    exec,
    exists: (p) => files.some((f) => String(p).endsWith(f)),
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? config : ''),
    loadEnv: () => ({}),
    hasCommand,
    ask: async () => false,
    currentVersion: '1.2.3',
    update,
    runUpdate,
    recordPrompt: () => {},
    // Pinned empty for the reason every other start spec pins them: a developer's real
    // cached update or this week's release notes would otherwise add rows to the box and put
    // a diff into every comparison below that has nothing to do with #73 (#41).
    readCache: () => ({ latest_version: null }),
    readChangelog: () => [],
    // The splash's clock, recording rather than waiting. Every suppression case below
    // asserts this array is EMPTY, which is the half of criterion 6 no byte can show.
    sleep: async (ms) => {
      naps.push(ms)
    },
    sendWa: async () => ({ ok: true }),
    peekLock,
    folderQueueCount: async () => queue,
    now: () => 1_700_000_000_000,
    home: HOME,
    processEnv: {},
    ralphBinary: '/usr/local/bin/ralph',
    ...overrides,
  }
}

/** Every byte only the animation writes: DECTCEM, a cursor-up, or a truecolor cell. */
const isSplashByte = (chunk) =>
  chunk.includes(`${ESC}[?25`) ||
  new RegExp(`${ESC}\\[\\d+A`).test(chunk) ||
  chunk.includes(SPRITE_FG)

/**
 * A stream that records, and can refuse the animation while accepting everything else.
 *
 * REFUSAL BY CONTENT rather than by position, which took one wrong turn to learn: a stream
 * that rejects its first N writes rejects a NUMBER OF ATTEMPTS, and the splash's attempt
 * count is not its chunk count — the first rejection aborts the loop, so the eleven-write
 * sequence only ever tries twice (the hide, then the restore from the `finally`). Counting
 * would therefore either stop short and let a real preflight line be lost, or overshoot and
 * take the box down with it. Refusing the escapes says what is meant: a terminal the picture
 * cannot reach and the words can, which is the claim under test.
 */
function makeStream({ isTTY, refuseSplash = false }) {
  const chunks = []
  const attempts = []
  const stream = {
    write: (s) => {
      attempts.push(s)
      if (refuseSplash && isSplashByte(s)) throw new Error('EPIPE')
      chunks.push(s)
      return true
    },
    chunks,
    attempts,
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
  if (isTTY !== undefined) stream.isTTY = isTTY
  return stream
}

/**
 * Everything the run SAID, with whatever the splash managed to draw taken off the front.
 *
 * Found by the box's top rule rather than by an index, because that is the first thing
 * `startCommand` writes after the animation on every path — and the runs compared below are
 * runs whose splashes ended at different points, so a fixed slice would be comparing
 * different things on each side.
 */
const bodyOf = (d) => {
  const first = d.stdout.chunks.findIndex((chunk) => chunk.startsWith('╭─ ralph'))
  expect(first, 'every path prints the box, so the body always starts there').toBeGreaterThan(-1)
  return d.stdout.chunks.slice(first)
}

const NO_UPDATE = {
  latestVersion: null,
  isNewer: false,
  shouldPrompt: false,
  source: 'disabled',
  updatedCache: null,
}

const NEWER_AND_ASKABLE = {
  latestVersion: '9.9.9',
  isNewer: true,
  shouldPrompt: true,
  source: 'registry',
  updatedCache: null,
}

/** Run the command and describe how it left, in a shape two runs can be compared on. */
async function outcomeOf(d) {
  try {
    return { returned: await startCommand(d) }
  } catch (error) {
    return {
      abort: error instanceof StartAbort,
      name: error.constructor.name,
      message: error.message,
      exitCode: error.exitCode,
    }
  }
}

// The twelve ways out of `startCommand`: three launches, two early returns, six aborts.
const PATHS = {
  'folder launch': {},
  'folder launch with a digest window': {
    config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\n',
  },
  'github launch with orphans and an .mcp.json': {
    config: '',
    files: ['ralph.config.sh', '.mcp.json'],
    orphans: '  #12 first\n  #34 second',
    ghQueue: '7',
  },
  'empty queue early return': { queue: 0 },
  'tmux session already exists': { sessionExists: true },
  'cycle lock held': {
    peekLock: () => ({ alive: true, holder: { pid: 4242, startedAt: '2023-11-14T00:00:00Z' } }),
  },
  'missing critical dependency': { hasCommand: (name) => name !== 'gh' },
  'gh not authenticated': { config: '', ghAuthOk: false },
  'invalid .mcp.json': { files: ['ralph.config.sh', '.mcp.json'], mcpOk: false },
  'tmux launch failed': { tmuxLaunchOk: false },
  'update installed early return': {
    update: async () => NEWER_AND_ASKABLE,
    runUpdate: async () => ({ updated: true, to: '9.9.9' }),
    stdin: { isTTY: true },
    ask: async () => true,
  },
  'update accepted but not installed': {
    update: async () => NEWER_AND_ASKABLE,
    runUpdate: async () => ({ updated: false, to: '9.9.9' }),
    stdin: { isTTY: true },
    ask: async () => true,
  },
}

describe('QA startCommand splash — a suppressed splash costs no bytes AND no time (#73)', () => {
  // Every reason the sprite can be silenced, asserted in THREE currencies rather than one.
  // The byte half is covered upstream; the two here are not, and both are regressions a
  // reader of a log could never notice.
  const SUPPRESSED = {
    'a piped stdout': {},
    'a stdout the caller declares is not a terminal': { isTTY: true, stdoutIsTTY: false },
    'an explicit color: false on a clean TTY': { isTTY: true, color: false },
    'NO_COLOR set to 1': { isTTY: true, processEnv: { NO_COLOR: '1' } },
    'NO_COLOR set to the empty string': { isTTY: true, processEnv: { NO_COLOR: '' } },
    'NO_COLOR set to 0': { isTTY: true, processEnv: { NO_COLOR: '0' } },
    'NO_COLOR set to false': { isTTY: true, processEnv: { NO_COLOR: 'false' } },
    'a terminal one column too narrow': { isTTY: true, columns: 25 },
    'a single-column terminal': { isTTY: true, columns: 1 },
  }

  for (const [name, options] of Object.entries(SUPPRESSED)) {
    it(`writes nothing, waits for nothing and listens for nothing with ${name}`, async () => {
      const d = deps(options)
      await outcomeOf(d)
      // The byte half, restated cheaply so a failure here reads as one finding rather than
      // as three files disagreeing.
      expectNoSplash(d.stdout.output())
      expectNoSplash(d.stderr.output())
      // THE NAP HALF, which is what this block exists for. `playSplash` returns before its
      // first `await` when the frame list is empty, so a suppressed run must not have asked
      // the clock once. A splash that napped for a second and then drew nothing would
      // satisfy every byte assertion in this package while adding a second to every launchd
      // invocation and every CI step that runs `ralph start`.
      expect(d.naps, 'a suppressed splash must not sleep').toEqual([])
      // ...and the LISTENER half. Registering a SIGINT handler for an animation that never
      // happened would change what Ctrl-C does during a piped start — the handler stands
      // down and re-raises, which is right during a splash and is a detour on a run that
      // has no cursor hidden and nothing to restore.
      expect(d.signals.ops, 'a suppressed splash must not listen').toEqual([])
      expect(d.signals.handlers).toEqual([])
    })
  }

  it('draws, naps five times and listens exactly once where the sprite is allowed', async () => {
    // THE ANTI-VACUITY PIN for the block above, and criterion 1's "about one second" as a
    // number. Nine suppression cases asserting emptiness are worth nothing unless the
    // permitted case is non-empty in the same three currencies — a gate stuck shut would
    // make every one of them pass.
    const d = deps({ isTTY: true })
    expect(await startCommand(d)).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(d.stdout.chunks.slice(0, SPLASH.length)).toEqual(SPLASH)
    expect(d.naps).toEqual(SPLASH_NAPS)
    expect(d.naps).toHaveLength(5)
    // The whole splash, summed: five frames at the asset's own hold time. Bounded rather
    // than pinned to the millisecond so a re-timed asset is a decision and not a broken
    // test, and bounded on BOTH sides because a splash nobody can see is as wrong as one
    // that delays a start.
    const total = d.naps.reduce((sum, ms) => sum + ms, 0)
    expect(total).toBeGreaterThanOrEqual(400)
    expect(total).toBeLessThanOrEqual(1_500)
    // One registration, one removal, and no signal raised on a run that finished: a handler
    // still attached when `ralph start` returns would outlive its animation by the hours the
    // loop then runs for, suppressing Node's own Ctrl-C for all of it.
    expect(d.signals.ops).toEqual(['on SIGINT', 'off SIGINT'])
    expect(d.signals.handlers).toEqual([])
  })

  it('leaves the naps and the listener behind at every width, following the same rung', async () => {
    // The width ladder in the currency the ladder's own tests do not use. 26 is the sprite's
    // cell width, so it is the last width that animates; every value below it must be as
    // quiet in time as it is in bytes, and the unresolvable counts a real pipe reports —
    // `undefined`, and the `0` some CI runners give — fall through to the 60-column default
    // and therefore DO animate.
    for (const columns of [200, 60, 44, 27, 26, undefined, 0]) {
      const d = deps({ isTTY: true, columns })
      await startCommand(d)
      expect(d.naps, `columns ${columns}`).toEqual(SPLASH_NAPS)
      expect(d.signals.ops, `columns ${columns}`).toEqual(['on SIGINT', 'off SIGINT'])
    }
    for (const columns of [25, 20, 12, 1]) {
      const d = deps({ isTTY: true, columns })
      await startCommand(d)
      expect(d.naps, `columns ${columns}`).toEqual([])
      expect(d.signals.ops, `columns ${columns}`).toEqual([])
    }
  })
})

describe('QA startCommand splash — the exit code, with the splash sabotaged (#73)', () => {
  // Criterion 8 on the whole surface. `startCommand`'s answer — a returned shape or a
  // `StartAbort` with a code — is what `bin/ralph.js` turns into a process exit, and #73 put
  // an `await` in front of every one of them. Each path below is run against a working
  // splash and then against three broken ones; the answer has to be the same object, and the
  // run's body has to be the same chunks, every time.
  for (const [name, options] of Object.entries(PATHS)) {
    it(`answers the ${name} path identically however the splash fails`, async () => {
      const clean = deps({ ...options, isTTY: true })
      const cleanOutcome = await outcomeOf(clean)
      const body = bodyOf(clean)
      expect(clean.stdout.chunks.slice(0, SPLASH.length), 'the clean run animates').toEqual(SPLASH)

      // A TIMER THAT THROWS. The likeliest real failure of the three — a caller's injected
      // `sleep`, or a `setTimeout` in a process being torn down — and the one the wrapper in
      // start.js was written for.
      const brokenClock = deps({
        ...options,
        isTTY: true,
        sleep: async () => {
          throw new Error('timer exploded')
        },
      })
      expect(await outcomeOf(brokenClock), 'broken clock').toEqual(cleanOutcome)
      expect(brokenClock.stderr.output()).toBe(clean.stderr.output())
      // The animation stopped where the clock did — one frame in, with the cursor put back —
      // and everything the run had to SAY is unchanged, which is the whole of what "costs the
      // picture, never the run" means.
      expect(bodyOf(brokenClock), 'broken clock body').toEqual(body)
      expect(brokenClock.stdout.chunks.slice(0, 3)).toEqual([SPLASH[0], SPLASH[1], SHOW])

      // A STDOUT THAT REFUSES THE ANIMATION and takes the words: the same terminal the run
      // then prints its box and its preflight to, so not one of those lines may be lost to a
      // picture that failed.
      const deadStream = deps({ ...options, isTTY: true, refuseSplash: true })
      expect(await outcomeOf(deadStream), 'dead stream').toEqual(cleanOutcome)
      expect(deadStream.stderr.output()).toBe(clean.stderr.output())
      expect(deadStream.stdout.chunks, 'dead stream body').toEqual(body)
      expectNoSplash(deadStream.stdout.output())

      // CTRL-C BETWEEN TWO FRAMES. The signal lands in the second nap, so the handler runs
      // mid-animation: it restores the cursor, removes itself and hands SIGINT back through
      // the source it was given. In production Node's default disposition then terminates
      // the process; here the source is a recorder, so the run continues — which is exactly
      // the invariant worth pinning, that `startCommand` contributes NOTHING of its own to
      // the exit code on an interrupt.
      const interrupted = deps({ ...options, isTTY: true })
      interrupted.sleep = async (ms) => {
        interrupted.naps.push(ms)
        if (interrupted.naps.length === 2) interrupted.signals.interrupt()
      }
      expect(await outcomeOf(interrupted), 'interrupted').toEqual(cleanOutcome)
      expect(interrupted.stderr.output()).toBe(clean.stderr.output())
      expect(bodyOf(interrupted), 'interrupted body').toEqual(body)
      // The cursor came back exactly once, the listener came off, and the signal was
      // re-raised through the injected source rather than at the real process.
      expect(interrupted.stdout.chunks.filter((chunk) => chunk === SHOW)).toHaveLength(1)
      expect(interrupted.signals.handlers).toEqual([])
      expect(interrupted.signals.ops).toEqual(['on SIGINT', 'off SIGINT', 'kill 4242 SIGINT'])
    })
  }

  it('never turns a good start into a crash, for any shape the splash seams take', async () => {
    // The seams as a caller can actually get them wrong — `sleep: null` from a bag that
    // spelled the key and forgot the value, a signal source whose halves throw — against the
    // path with something to lose. A `ralph start` that reported a failure because its
    // decoration could not be drawn would be the worst outcome of this issue, and it is one
    // line of `catch` away at all times.
    const hostile = {
      'a null sleep': { sleep: null },
      'a sleep that is not a function': { sleep: 'soon' },
      'a signal source that refuses listeners': {
        signals: {
          on: () => {
            throw new Error('too many listeners')
          },
          off: () => {},
        },
      },
      'a signal source that refuses to forget': {
        signals: {
          on: () => {},
          off: () => {
            throw new Error('cannot unlisten')
          },
        },
      },
      'a signal source with no methods at all': { signals: {} },
      'a stdout that refuses every splash write': { refuseSplash: true },
    }
    for (const [name, options] of Object.entries(hostile)) {
      const d = deps({ isTTY: true, ...options })
      expect(await outcomeOf(d), name).toEqual({
        returned: { exitCode: 0, started: true, count: 3 },
      })
      expect(d.stderr.output(), name).toBe('')
      // ...and the run still SAID everything it had to say: the box is the first thing after
      // whatever the splash managed, so its presence is how "the body survived" reads.
      expect(d.stdout.output(), name).toContain('╭─ ralph 1.2.3')
    }
  })

  it('reports a preflight failure with the same code even when the splash is dying', async () => {
    // The crossing the block above cannot make: a splash failing DURING a run that was going
    // to abort anyway. Two failures in one run is where a swallowed error most easily
    // swallows the wrong one — a `catch` one line too wide, and the tmux abort becomes an
    // exit 0 with a mysterious log.
    for (const name of ['tmux session already exists', 'cycle lock held', 'tmux launch failed']) {
      const d = deps({
        ...PATHS[name],
        isTTY: true,
        sleep: async () => {
          throw new Error('timer exploded')
        },
      })
      const outcome = await outcomeOf(d)
      expect(outcome.abort, name).toBe(true)
      expect(outcome.exitCode, name).toBe(1)
      expect(outcome.name, name).toBe('StartAbort')
      expect(d.stderr.output(), name).not.toBe('')
    }
  })
})

describe('QA startCommand splash — what the terminal is left holding (#73)', () => {
  it('ends the animation on a frame, with no cursor control anywhere after it', async () => {
    // Criterion 3, over the WHOLE run rather than over the splash. The player's own spec pins
    // the restore before the last frame; what only a run can show is that nothing AFTER that
    // frame touches the cursor either — the box, the preflight lines and the summary are all
    // written to a terminal whose cursor is visible and wherever the sprite left it.
    const d = deps({ isTTY: true })
    await startCommand(d)
    const output = d.stdout.output()

    // Exactly two toggles in the entire run, in this order: hide, then show. A third would
    // mean the `finally` wrote one too, and a missing show is an invisible cursor in the
    // user's shell for as long as the loop runs.
    expect(output.match(new RegExp(`${ESC}\\[\\?25[hl]`, 'g'))).toEqual([HIDE, SHOW])
    // Four moves for five frames, each over the RENDERED height — seventeen text rows for
    // thirty-four pixel rows, because a half-block glyph is two pixels tall. A move of 34
    // would walk the cursor a screen and a half up through the user's scrollback on every
    // frame.
    const moves = [...output.matchAll(CURSOR_UP)].map((match) => Number(match[1]))
    expect(moves).toEqual([17, 17, 17, 17])
    expect(BANNER).toHaveLength(17)

    // ...and everything after the restore is plain output: no toggle, no move, so the run's
    // body cannot be redrawn over or scrolled into by the animation that preceded it.
    const tail = output.slice(output.lastIndexOf(SHOW) + SHOW.length)
    expect(tail).not.toContain(`${ESC}[?25`)
    expect(tail).not.toMatch(new RegExp(`${ESC}\\[\\d+A`))
    expect(tail).toContain('╭─ ralph 1.2.3')
  })

  it('separates the settled frame from the box by a newline and nothing else', async () => {
    // THE BUG THE RESTORE-BEFORE-THE-LAST-FRAME ORDERING EXISTS TO PREVENT, stated where it
    // would actually show: a control byte written after the final frame would land
    // immediately in front of the box's first character, and a terminal would render its
    // top-left corner with an escape sequence hanging off it. The ordering is what keeps the
    // byte before that character a newline on every run.
    //
    // The FIRST LINE OF THE BOX is the marker, and it is not always a corner: #72's ladder
    // unboxes below 44 columns, so the widths that animate span two spellings — `╭─ ralph`
    // where there is room to draw a rule and a bare `ralph 1.2.3` where there is not. Asking
    // `bannerLayout` which one to expect is what keeps this test on the ladder's side of the
    // rule rather than holding a 44 of its own.
    //
    // #161 REPLACED 200 WITH 71 for the same kind of reason, one rung further up: this is a
    // claim about the box printing BENEATH the settled frame — the newline in front of its
    // first character, and the still's last row directly above it — and from 72 columns the
    // box is not beneath the frame at all, it is inside it, two spaces to the right of the
    // picture. Every width here is therefore a width that still stacks. The beside
    // arrangement has no "byte before the corner" to protect: what precedes it is the sprite's
    // own painted row, on the same line, which start.banner-beside.test.js pins byte for byte.
    for (const columns of [undefined, 71, 60, 44, 43, 30, 26]) {
      const d = deps({ isTTY: true, columns })
      await startCommand(d)
      const output = d.stdout.output()
      const label = `columns ${columns}`
      const marker = bannerLayout(columns).boxed ? '╭─ ralph 1.2.3' : 'ralph 1.2.3'
      const start = output.indexOf(marker)
      expect(start, label).toBeGreaterThan(0)
      expect(output[start - 1], label).toBe('\n')
      // ...and no control byte anywhere in the run of bytes leading up to that newline. This
      // is the assertion, rather than the newline on its own: `ESC[?25h\n╭─` would satisfy the
      // check above and is exactly the ordering bug the design exists to prevent. Forty bytes
      // is more than any single escape sequence and less than the sprite row above, so it is
      // the window where a stray one could hide.
      const approach = output.slice(Math.max(0, start - 41), start - 1)
      expect(approach, label).not.toContain(`${ESC}[?25`)
      expect(approach, label).not.toMatch(new RegExp(`${ESC}\\[\\d+A`))
      // ...and the row directly above it is the last row of the still, not a blank the
      // animation left behind — which is what makes "the box prints BENEATH the settled
      // frame" a fact about adjacency rather than about ordering alone.
      const lines = d.stdout.lines()
      const markerLine = lines.findIndex((line) => line.startsWith(marker))
      expect(lines[markerLine - 1], label).toBe(BANNER.at(-1))
    }
  })

  it('keeps the splash on stdout, never on the stream a script reads errors from', async () => {
    // Every aborting path writes to stderr, and #73 gave the command a second writer. A
    // frame, a nap-driven redraw or a stray restore on stderr would corrupt exactly the
    // output an operator greps after a failed start.
    for (const name of Object.keys(PATHS)) {
      const d = deps({ ...PATHS[name], isTTY: true })
      await outcomeOf(d)
      expectNoSplash(d.stderr.output())
    }
  })

  it('writes each frame as one chunk, so no terminal can paint half of one', async () => {
    // Seventeen rows in one `write` rather than seventeen writes: a redraw that reaches the
    // terminal in pieces is a frame the user sees half-updated, which for an animation drawn
    // IN PLACE is a tear across the middle of the sprite. Asserted as "one chunk per frame,
    // each ending on a newline" — the newline is what keeps the sprite's bottom row off the
    // box's top rule.
    const d = deps({ isTTY: true })
    await startCommand(d)
    const frames = d.stdout.chunks.slice(0, SPLASH.length).filter((chunk) => chunk.includes('\n'))
    expect(frames).toHaveLength(5)
    for (const frame of frames) {
      expect(frame.split('\n')).toHaveLength(BANNER.length + 1)
      expect(frame.endsWith('\n')).toBe(true)
    }
  })
})

describe('QA startCommand splash — exclusivity, transitively (#73)', () => {
  // Criterion 7 redone as a reachability question. The upstream spec reads every module in
  // lib/commands/ for the player's name and expects only start.js — which is the right claim
  // and the wrong scope: it passes for a player imported into lib/banner-compose.js, into
  // lib/sprite-banner.js, or re-exported through any helper the other commands already use.
  // Any of those would give `ralph status` an animation nobody asked for, and would do it
  // without a single command file mentioning the module.
  //
  // A STATIC WALK rather than eleven command runs: it needs no dependency bag per command,
  // it cannot be satisfied vacuously by a command whose test bag happened to suppress the
  // sprite, and it fails on the day an import is ADDED rather than on the day someone
  // notices the output changed.

  const ROOT = fileURLToPath(new URL('../../', import.meta.url))
  // Relative specifiers only: a bare `picocolors` is not a path into this package, and
  // matching `from`/`import` covers the static form, the side-effect form and `await
  // import(...)` alike.
  const SPECIFIER = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g

  function sourceFiles(dir, found = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) sourceFiles(path, found)
      else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) found.push(path)
    }
    return found
  }

  const files = [...sourceFiles(`${ROOT}lib`), ...sourceFiles(`${ROOT}bin`)]
  const graph = new Map(
    files.map((file) => [
      file,
      new Set(
        [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map(
          (match) => fileURLToPath(new URL(match[1], `file://${file}`)),
        ),
      ),
    ]),
  )
  const PLAYER = `${ROOT}lib/sprite-player.js`

  const reaches = (start) => {
    const seen = new Set()
    const queue = [...(graph.get(start) ?? [])]
    while (queue.length > 0) {
      const next = queue.pop()
      if (seen.has(next)) continue
      seen.add(next)
      for (const edge of graph.get(next) ?? []) queue.push(edge)
    }
    return seen.has(PLAYER)
  }

  it('is reachable from `ralph start` and from nothing else in the package', () => {
    const reaching = files.filter(reaches).map((file) => file.slice(ROOT.length))
    expect(reaching.sort()).toEqual(['bin/ralph.js', 'lib/commands/start.js'])
  })

  it('walks a graph that is actually complete — every relative import resolves', () => {
    // THE ANTI-VACUITY PIN, and the one this block genuinely needs: a specifier pattern that
    // matched nothing, or a resolver that produced paths no scanned file has, would make the
    // walk above find nothing and pass. Two facts make it real — the graph covers the whole
    // package, and every edge in it lands on a file the walk knows about, so there is no
    // module whose imports were silently invisible.
    expect(files.length).toBeGreaterThan(40)
    expect(graph.get(PLAYER)).toBeDefined()
    const dangling = [...graph.values()]
      .flatMap((edges) => [...edges])
      .filter((edge) => !graph.has(edge))
    expect(dangling).toEqual([])
    // ...and the commands that must NOT reach it are in the scanned set, so their absence
    // from the list above is a fact about them rather than about the scan.
    for (const command of ['cycle.js', 'status.js', 'doctor.js', 'changelog.js', 'update.js']) {
      expect(files, command).toContain(`${ROOT}lib/commands/${command}`)
    }
  })

  it('leaves the still available to the caller that will want it, unanimated', () => {
    // `renderStaticBanner` has no caller since #73 and is what #74's `RALPH_BANNER=static`
    // may use. Pinned so the walk above cannot be satisfied one day by DELETING the still —
    // the frame the splash settles on is asserted against it in three files, which is what
    // makes "the animation ends on the unanimated banner" a comparison rather than a claim.
    // A `cycles` of 1 through the player would emit the same bytes, hide and restore
    // included — which is to say neither, since `playSplash` only hides a cursor it is going
    // to redraw over. What the still has that the player does not is purity: no stream, no
    // sleep, no signal source, so it can be the thing the other one is measured against.
    expect(BANNER).toHaveLength(17)
    expect(SPLASH_BLOCK.endsWith(`${BANNER.join('\n')}\n`)).toBe(true)
    expect(SPLASH_BLOCK.startsWith(HIDE)).toBe(true)
    expect(renderStaticBanner({ isTTY: true, color: true }).join('\n')).not.toContain(`${ESC}[?25`)
  })
})
