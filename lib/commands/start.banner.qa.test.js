// #67 QA — the banner as a change to a command that has NINE ways out.
//
// start.banner.test.js proves the two headline claims on the happy path and on one
// abort. This file is the same two claims taken to every exit `startCommand` has,
// because "byte-for-byte unchanged" is a statement about the whole surface and the
// interesting runs are the ones that fail:
//
//   1. EVERY PATH, TWICE. Each of the twelve outcomes below — three flavours of
//      success, two early returns and six aborts — is run once with a piped stdout
//      and once with a TTY stdout, from the same dependency bag. The TTY run must be
//      the piped run with the SPLASH prepended and NOTHING else different: same
//      stderr, byte for byte, same exit code, same returned shape, same StartAbort
//      message. A banner that slipped below a guard, a line that moved, or an abort
//      that changed its status shows up as a diff on one row of that table.
//   2. THE PRE-#67 BYTES, SPELLED OUT. Two paths additionally pin their suppressed
//      output as a LITERAL, captured by running this same bag against a pre-#67
//      checkout of lib/commands/start.js. Subtracting one run from another proves
//      the two agree with each other; only a literal proves they agree with what
//      shipped.
//
// #68 leaves both claims intact and sharpens the first one. The banner now has two
// halves with different rules: the SPRITE is TTY-and-colour gated, so it is what the
// subtraction removes; the identity BOX is text and prints on every run, so it appears
// on both sides and cancels. That is why the twelve rows below needed no new
// expectations — only the two literals grew by three lines, and the ordering index by three
// events, because the box is written above the preflight too.
//
// #73 turns the sprite into a one-second splash and changes NEITHER claim, because both
// were written against the sprite's bytes rather than against its height. What changes is
// the constant they are written against: a TTY run now opens with eleven writes — hide the
// cursor, five frames, four moves back up, restore — instead of seventeen `out()` calls,
// and the still it settles on is the frame this file already had. So `BANNER_BLOCK` becomes
// `SPLASH_BLOCK`, DERIVED BY RUNNING THE PLAYER rather than restated here, and the twelve
// rows below subtract the same way they always did. Three properties are new and are what
// the width and abort blocks now pin: the splash occupies `SPLASH_LINES` lines of stdout
// rather than seventeen, the settled frame has to be read with the cursor-control bytes
// that ride on the front of a redrawn line stripped off, and a suppressed sprite means a
// suppressed splash — `expectNoSprite` therefore rejects DECTCEM too, since a run that
// hid the cursor and drew nothing would be the worst of both.
//
// The player's sleep and its signal source are INJECTED by the bag below (#41), for the
// usual reason and for one this file feels more sharply than any other: ninety-six tests
// that each waited a real second on the real timer would add three minutes to the suite,
// and a default that reached `process.on('SIGINT')` would leave a listener behind in the
// vitest worker on every one of them.
//
// And the third thing this file exists for: the two capabilities are INDEPENDENT
// seams. `isTTY` is stdin and gates a blocking readline; `stdoutIsTTY` is stdout and
// gates escape sequences. A run can have either without the other, so both crossed
// combinations are exercised against a real prompt decision — one asks and draws
// nothing, the other draws and never asks.

import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { StartAbort, startCommand } from './start.js'
import { renderSplashFrames, renderStaticBanner } from '../sprite-banner.js'
// #73: the player, imported so the bytes a TTY run must produce are produced BY IT rather
// than spelled out a second time here — see SPLASH below.
import { playSplash } from '../sprite-player.js'
// #72: the ladder itself, so "boxed at this width" is asked of the rule rather than
// restated as a `>= 44` this file would then have to keep in step with it.
import { bannerLayout } from '../banner-compose.js'
// #68: the box's two collaborators, imported so this file's expectations are derived
// from the RULES the command obeys rather than from a second reading of them — the
// opt-out predicate #24 owns, and the XDG cache path #24 writes.
import { isUpdateCheckDisabled } from '../update-check.js'
import { versionCachePath } from '../version-cache.js'
import { sessionNameFor } from '../lock.js'

const ESC = '\u001B'
// The sprite's own signature — the only escape a `pc`-colouring path may claim is absent.
//
// "No ANSI anywhere in stdout" is NOT a claim `ralph start` can keep, and asserting it
// is why this file passed locally and failed on CI. `pc.yellow` colours the
// update-available notice, and picocolors decides ONCE AT IMPORT from the real
// `process.env` — which no injected bag can reach — turning colour on whenever `CI` is
// set. Those lines are therefore plain on a developer's piped run and coloured on
// GitHub Actions, through no fault of the banner.
//
// 24-bit truecolor is the discriminator: lib/sprite-render.js emits `38;2;`/`48;2;`
// per cell, and picocolors only ever emits the basic 16-colour codes (`[33m`, `[0m`).
// So these match the sprite and nothing else, on either machine. Byte-identity
// (`tty === SPLASH_BLOCK + piped`) remains the real guarantee; this is the belt.
const SPRITE_FG = `${ESC}[38;2;`
const SPRITE_BG = `${ESC}[48;2;`
// #73: and the splash's own signature, which is not colour at all. DECTCEM is the pair of
// sequences that hide and show the cursor, and nothing else in `ralph start` writes them,
// so their absence is how "no animation happened" is asserted on a piped run — a stronger
// claim than "no sprite", and the one that catches the specific bug worth catching here: a
// player that hid the cursor before discovering it had no frames to draw would leave a
// launchd log with an invisible cursor and no picture to show for it.
const CURSOR_TOGGLE = `${ESC}[?25`

/** Assert an output carries no trace of the sprite, whatever else coloured itself. */
function expectNoSprite(output) {
  expect(output).not.toContain(SPRITE_FG)
  expect(output).not.toContain(SPRITE_BG)
  expect(output).not.toMatch(/[▀▄]/)
  expect(output).not.toContain(CURSOR_TOGGLE)
}

const REPO = '/repo'
const HOME = '/home/me'
const SESSION = sessionNameFor(REPO)
// #68: where the box reads its update hint from, resolved the way #24 resolves it so a
// path change cannot make these assertions pass against the wrong file.
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })

// The seventeen rows, from the pure function the command itself calls: the pixels are
// lib/sprite-banner.qa.test.js's business.
//
// #73 leaves this constant meaning exactly what it meant — the still a `ralph start` ends
// up holding — and takes away its monopoly on the bytes: it is now the LAST frame of the
// splash rather than the whole of it. `renderStaticBanner` is still what states it, which
// is the point: "the animation settles on the frame an unanimated banner would have drawn"
// stays a claim this file can make by comparison rather than by eye.
const BANNER = renderStaticBanner({ isTTY: true, color: true })

// #73 — the bytes a TTY run now opens with, PRODUCED BY THE PLAYER rather than spelled out.
//
// Eleven writes: hide the cursor, five frames, four moves back up, and the restore that
// lands before the final frame so no control byte is glued to the box's top rule. This file
// asserts what `ralph start` DOES; which eleven writes those are, escape by spelled-out
// escape, is lib/sprite-player.test.js's business, and a second copy of the sequence here
// would be a second opinion about what the splash is. The bag below drives the same player
// with the same frames, so a change to either shows up as a diff on the subtraction rather
// than as a re-recorded expectation.
const SPLASH = await splashChunks()

async function splashChunks() {
  const chunks = []
  await playSplash({
    frames: renderSplashFrames({ isTTY: true, color: true }),
    stream: { write: (chunk) => chunks.push(chunk) },
    sleep: async () => {},
    // No signal source at all: this is a module-level await in a vitest worker, and the
    // real `process` default would register — and remove — a SIGINT listener in it.
    signals: null,
  })
  return chunks
}

const SPLASH_BLOCK = SPLASH.join('')

// How many LINES of stdout the splash occupies. Counted from its own bytes, because five
// frames of seventeen rows is arithmetic this file would otherwise have to keep in step
// with both the asset and the frame count — and the cursor-control escapes ride on the
// front of the line that follows them rather than occupying one of their own.
const SPLASH_LINES = SPLASH_BLOCK.split('\n').length - 1

// The escapes that redraw rather than colour: a cursor-up, a hide, a show, in any run of
// them. Anchored at the start because that is the only place they can appear — the player
// writes them between frames, and a frame ends with a newline.
const CURSOR_CONTROL = new RegExp(`^(?:${ESC}\\[(?:\\d+A|\\?25[hl]))+`)

/** The splash's lines as the sprite drew them, with the redraw bytes taken off the front. */
const splashLines = (d) =>
  d.stdout
    .lines()
    .slice(0, SPLASH_LINES)
    .map((line) => line.replace(CURSOR_CONTROL, ''))

/** The still the run settled on: the last frame of the splash, ready to compare to BANNER. */
const settledFrame = (d) => splashLines(d).slice(-BANNER.length)

// #68's identity box, SPELLED OUT rather than composed — the one file where that is the
// right call, because this is the file whose job is the command's actual bytes. This bag's
// `currentVersion` and its `cwd`, and no update row, since every run below reads an empty
// cache (see `readCache` in deps). The streams carry no `columns`, so the box is drawn at
// its 60-column default.
//
// #69 added the AGENT and SOURCE rows, and both are the same on every path below. The agent
// row is the no-history sentence because `readFile` here answers '' for every path but the
// config, so there is no metrics log for a model to have come from — and the row says the
// model resolves at first run rather than naming one, which is the whole provenance rule
// seen from the outside. The source row says `folder` because that is what deps' config
// says. There is no CONTEXT row (no model, no window) and no REPO row (folder mode never
// looks for one), and both of those absences are rows this file would otherwise pin.
//
// It is NOT part of SPLASH_BLOCK, and that is the point of the subtraction below: the
// sprite is what a piped run loses, the box is what both runs keep.
const BOX_TOP = `╭─ ralph 1.2.3 ${'─'.repeat(44)}╮`
const AGENT_ROW = `│ agent   claude — model resolves at first run${' '.repeat(12)} │`
const CWD_ROW = `│ cwd     /repo${' '.repeat(43)} │`
const SOURCE_ROW = `│ source  folder${' '.repeat(42)} │`
const BOX_BOTTOM = `╰${'─'.repeat(58)}╯`
const BOX = [BOX_TOP, AGENT_ROW, CWD_ROW, SOURCE_ROW, BOX_BOTTOM]
const BOX_BLOCK = `${BOX.join('\n')}\n`

// ...and the same box for the paths below that hand `config: ''`, where the source falls back
// to github. Only the one row differs, and it still has no REPO row under it: this bag's
// `readFile` answers '' for `.git/config` as well, which is a checkout whose remote is not
// cheaply knowable — so the row drops rather than reading `unknown`.
const BOX_GITHUB = [BOX_TOP, AGENT_ROW, CWD_ROW, `│ source  github${' '.repeat(42)} │`, BOX_BOTTOM]
// Which of the two a path gets, decided by the one option that decides it. A function rather
// than a second literal per path, because the twelve paths below vary on tmux, gh, locks and
// queues and none of that touches the box.
const boxFor = (options = {}) => (options.config === '' ? BOX_GITHUB : BOX)

// The three files the banner itself is made of, by the tail of their paths. Every one of
// them is read BEFORE the first byte is drawn, and `firstEffect` below excuses all three
// for the same reason: a read is not something that HAPPENED to the run.
const BANNER_INPUTS = ['ralph.config.sh', '/.ralph/metrics/issues.jsonl', '/.git/config']

// Every side effect in the order it happens — the writes plus the config read plus
// each exec — so "the banner came first" is a statement about the run and not about
// one stream.
function makeTimeline() {
  const events = []
  return {
    events,
    record: (kind, detail = '') => events.push({ kind, detail }),
    // The first event that is neither a stdout write nor one of the reads the banner is
    // made of, counted with those reads DROPPED rather than counted. #74 moved the config
    // read above the banner — the file is where RALPH_BANNER is written, so the mode has to
    // be known before anything is drawn — and #69 added two more of exactly that kind: the
    // metrics log its model row is resolved from, and (in github mode) `.git/config` for its
    // repo row. All three run no shell, write nothing and print nothing, so excusing them
    // keeps "nothing HAPPENED before the banner" the claim these twelve paths make rather
    // than weakening it.
    //
    // Dropped rather than excused in place, which is the difference between the index below
    // meaning "the banner's height" and meaning "the banner's height plus however many files
    // it happened to read on this path" — and that second number differs between the folder
    // and github paths, which would make every assertion here a function of the source. What
    // would still fail this: an exec, a write to stderr, a lock peek, or a read of any OTHER
    // file, all of them at the index the banner's own lines end.
    firstEffect: () =>
      events
        .filter(
          (event) =>
            !(
              event.kind === 'readFile' &&
              BANNER_INPUTS.some((tail) => event.detail.endsWith(tail))
            ),
        )
        .findIndex((event) => event.kind !== 'write'),
  }
}

function makeStream(timeline, { isTTY, kind = 'write' } = {}) {
  const chunks = []
  const stream = {
    write: (s) => {
      chunks.push(s)
      timeline?.record(kind, s)
      return true
    },
    chunks,
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
  // Only ever SET when a test asks for it: `Boolean(undefined)` is what a piped
  // stdout answers, and that is what every other start spec runs under.
  if (isTTY !== undefined) stream.isTTY = isTTY
  return stream
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

// One bag, every path reachable from its options. `now` and `ralphBinary` are pinned
// so the two runs of a pair cannot differ on a clock or on how the process was
// spawned rather than on the banner.
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
  ...overrides
} = {}) {
  const timeline = makeTimeline()
  const stdout = makeStream(timeline, { isTTY })
  const stderr = makeStream(timeline, { kind: 'stderr' })
  const asked = []
  const exec = async (cmd, args) => {
    timeline.record('exec', `${cmd} ${args.join(' ')}`)
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
  const ask = async (question) => {
    asked.push(question)
    return false
  }
  ask.asked = asked
  return {
    cwd: REPO,
    stdout,
    stderr,
    timeline,
    exec,
    exists: (p) => files.some((f) => String(p).endsWith(f)),
    readFile: (p) => {
      timeline.record('readFile', String(p))
      return String(p).endsWith('ralph.config.sh') ? config : ''
    },
    loadEnv: () => ({}),
    hasCommand,
    ask,
    currentVersion: '1.2.3',
    update,
    runUpdate,
    // #26's stamp writes through the global cache; injected away so no run here
    // touches a real (or sandboxed) file.
    recordPrompt: () => {},
    // #68: and the box's READ of that same cache, injected for the same reason — plus
    // one this file cares about especially. The twelve paths below compare bytes; a
    // developer whose real cache happens to hold a newer version would otherwise get a
    // fourth row in the box and a diff that has nothing to do with the code (#41).
    readCache: () => ({ latest_version: null }),
    // #70: the box's what's-new section reads the changelog shipped inside the package.
    // Injected to empty for the same reason as the cache above: the twelve paths below
    // compare bytes, and the real reader would put this week's release notes — three rows
    // of them — into every one of those diffs, then change them again at the next release
    // (#41). What the section itself renders is start.whats-new.test.js's business.
    readChangelog: () => [],
    // #73: the splash's two impure inputs, injected for the reason every other seam here
    // is — and this pair has teeth. A real `sleep` would cost every TTY run below a full
    // second of wall clock, which across this file's paths and widths is minutes; the real
    // `signals` would attach a SIGINT handler to the vitest worker on each of them, and a
    // handler that outlived its animation would be a listener leak the suite could not see.
    // The frames are NOT injected: which bytes the animation is made of is what the twelve
    // subtractions below are about, so that half stays the command's own decision.
    sleep: async () => {},
    signals: null,
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

// Run the command and describe how it left, in a shape two runs can be compared on.
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

// The twelve ways out of `startCommand`, each named by what it is: a preflight abort,
// an early return or a launch.
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

describe('QA startCommand banner — every exit path, piped and on a TTY (#67)', () => {
  for (const [name, options] of Object.entries(PATHS)) {
    it(`leaves the ${name} path byte-identical, banner aside`, async () => {
      const piped = deps(options)
      const tty = deps({ ...options, isTTY: true })
      const pipedOutcome = await outcomeOf(piped)
      const ttyOutcome = await outcomeOf(tty)

      // The subtraction, on this path: the TTY run is the piped run with the whole
      // splash in front of it and not one byte else moved. #73 makes that prefix eleven
      // writes rather than seventeen, and this line is the reason the change needed no
      // new expectations here — what it compares is bytes, and it never knew the height.
      expect(tty.stdout.output()).toBe(SPLASH_BLOCK + piped.stdout.output())
      expect(tty.stderr.output()).toBe(piped.stderr.output())
      // ...and the piped run carries no trace of the sprite at all: no truecolor
      // escape, no glyph, not even a blank line, which is what an `out('')` would have
      // left. Sprite-specific rather than ESC-wide because some of these paths print a
      // `pc`-coloured notice whose colour is ambient — see SPRITE_FG above.
      expectNoSprite(piped.stdout.output())
      expect(piped.stdout.output()).not.toMatch(/^\n/)
      // The banner is on stdout, never on the stream a script reads errors from.
      expectNoSprite(tty.stderr.output())

      // Exit code, returned shape and abort identity are the command's answer about
      // the run, and the banner is not allowed an opinion on any of them.
      expect(ttyOutcome).toEqual(pipedOutcome)
    })
  }

  it('subtracts a splash that is actually there — eleven writes, five frames, one still', () => {
    // THE ANTI-VACUITY PIN, and the one place in this file where the numbers are spelled
    // out. Every assertion above and below is written against SPLASH_BLOCK, which is
    // DERIVED — so a gate that started returning no frames at all would make the prefix
    // empty, the twelve subtractions trivially true, and this file silent about a `ralph
    // start` that had stopped drawing anything. These four numbers cannot be derived from
    // the same source they are checking: eleven writes, five of which are frames, seventeen
    // rows each, eighty-five lines of stdout, settling on the still #67 shipped.
    expect(SPLASH).toHaveLength(11)
    expect(SPLASH.filter((chunk) => chunk.endsWith('\n'))).toHaveLength(5)
    expect(BANNER).toHaveLength(17)
    expect(SPLASH_LINES).toBe(85)
    expect(SPLASH_BLOCK.endsWith(`${BANNER.join('\n')}\n`)).toBe(true)
  })

  it('puts the frame above the error on every aborting path', async () => {
    // The runs where the banner is the ONLY thing above the failure. A banner printed
    // after any guard would be missing from exactly these.
    const aborts = [
      'tmux session already exists',
      'cycle lock held',
      'missing critical dependency',
      'gh not authenticated',
      'invalid .mcp.json',
      'tmux launch failed',
    ]
    for (const name of aborts) {
      const d = deps({ ...PATHS[name], isTTY: true })
      const outcome = await outcomeOf(d)
      expect(outcome.abort, name).toBe(true)
      expect(outcome.exitCode, name).toBe(1)
      // #73: the frame the run SETTLED on, which is the one a reader of a failed start
      // actually sees — the four frames above it were redrawn over. Still #67's bytes.
      expect(settledFrame(d), name).toEqual(BANNER)
      const box = boxFor(PATHS[name])
      expect(d.stdout.lines().slice(SPLASH_LINES, SPLASH_LINES + box.length), name).toEqual(box)
      expect(d.stderr.output(), name).not.toBe('')
      // Written before the guard that aborted, not merely present: every write the banner
      // makes — the splash's frames and the box's rows — lands before the first thing this
      // command DOES. Counted in WRITES rather than lines since #73, because a frame is now
      // one write of seventeen rows, and with the banner's own file reads dropped since #69
      // (see `firstEffect`), so this number is the banner's HEIGHT and nothing else.
      expect(d.timeline.firstEffect(), name).toBe(SPLASH.length + box.length)
    }
  })

  it('writes one chunk per frame and one line per box row, each ending in a newline', async () => {
    // Was "one line per row, each with its own trailing newline": seventeen `out()` calls,
    // no joined blob, no chunk that forgot the last newline and glued the sprite's bottom
    // row to the first preflight line. #73 INVERTS the first half and keeps the second. A
    // redraw must reach the terminal as ONE write — seventeen separate writes are seventeen
    // chances for the terminal to paint a half-updated frame — so the sprite leaves `out()`
    // altogether, while the newline worry is unchanged and now applies to the frame.
    const d = deps({ isTTY: true })
    await startCommand(d)
    expect(d.stdout.chunks.slice(0, SPLASH.length)).toEqual(SPLASH)

    // The five frames, told from the four cursor moves and the two toggles by the newline
    // no control sequence has: each carries all seventeen rows and ends on one.
    const frames = d.stdout.chunks.slice(0, SPLASH.length).filter((chunk) => chunk.endsWith('\n'))
    expect(frames).toHaveLength(5)
    for (const frame of frames) expect(frame.split('\n')).toHaveLength(BANNER.length + 1)

    // ...and the box below it is still text through `out()`, one line at a time — which is
    // what keeps its bottom rule off the first preflight line.
    expect(d.stdout.chunks.slice(SPLASH.length, SPLASH.length + BOX.length)).toEqual(
      BOX.map((line) => `${line}\n`),
    )
  })
})

describe('QA startCommand banner — the pre-#67 bytes, spelled out (#67)', () => {
  // Captured by running this file's dependency bag against lib/commands/start.js as
  // of the commit before #67. Subtracting a TTY run from a piped run proves the two
  // agree; these literals are what proves the piped run agrees with what SHIPPED.
  //
  // #68 PREPENDS BOX_BLOCK to both, and the literals below are untouched — deliberately
  // so. The box is the one thing this issue adds to a piped run, and keeping the
  // pre-banner bytes spelled out separately is what makes that readable as "three lines
  // added, nothing else changed" rather than as a re-recorded expectation.
  //
  // #73 touches neither literal either, and that is the whole of what it has to prove
  // here: the splash is a TTY-only prefix, so the piped bytes below are STILL the pre-#67
  // ones plus #68's box — not one frame, not one cursor move, not one DECTCEM toggle
  // reaches a log file — and the TTY run grows only by swapping one prefix for a longer one.
  // #169 IS THE FIRST ISSUE TO EDIT EITHER LITERAL, and it edits the launch bytes only:
  // the hint block names `ralph live` (../commands/live.js) with the tmux command on the
  // continuation line under it. The claim above survives the edit intact, because it was
  // never about these particular characters — it is that a piped run's bytes are the
  // launch's and the box's and NOTHING the splash writes. Which is why the literal is
  // re-spelled here rather than captured from a run: a captured expectation would agree
  // with any output at all.
  it('reproduces the launch output exactly, and prepends only the banner to it', async () => {
    const expected =
      'ℹ️  CALLMEBOT_KEY/WHATSAPP_PHONE missing; WhatsApp notifications will be skipped.\n' +
      '✅ Ralph started in background. 3 issues in the queue.\n' +
      '   Progress:       ralph status\n' +
      '   Watch live:     ralph live\n' +
      `                   tmux attach -t ${SESSION}\n` +
      '   Detach:         inside the session, Ctrl+B then D\n' +
      '   List:           tmux ls\n' +
      `   Kill:           tmux kill-session -t ${SESSION}\n` +
      '   Logs:           logs/ralph-issue-*.log\n'

    const piped = deps()
    expect(await outcomeOf(piped)).toEqual({ returned: { exitCode: 0, started: true, count: 3 } })
    expect(piped.stdout.output()).toBe(BOX_BLOCK + expected)
    expect(piped.stderr.output()).toBe('')

    const tty = deps({ isTTY: true })
    await startCommand(tty)
    expect(tty.stdout.output()).toBe(SPLASH_BLOCK + BOX_BLOCK + expected)
  })

  it('reproduces the tmux-taken abort exactly, on both streams', async () => {
    const expectedOut =
      '   Watch:  ralph live\n' +
      `           tmux attach -t ${SESSION}\n` +
      `   Kill:   tmux kill-session -t ${SESSION}\n`
    const expectedErr = `❌ tmux session '${SESSION}' already exists.\n`

    const piped = deps({ sessionExists: true })
    expect(await outcomeOf(piped)).toEqual({
      abort: true,
      name: 'StartAbort',
      message: 'tmux session already exists',
      exitCode: 1,
    })
    expect(piped.stdout.output()).toBe(BOX_BLOCK + expectedOut)
    expect(piped.stderr.output()).toBe(expectedErr)

    const tty = deps({ sessionExists: true, isTTY: true })
    await expect(startCommand(tty)).rejects.toThrow(StartAbort)
    expect(tty.stdout.output()).toBe(SPLASH_BLOCK + BOX_BLOCK + expectedOut)
    expect(tty.stderr.output()).toBe(expectedErr)
  })
})

describe('QA startCommand banner — stdout capability is not stdin capability (#67)', () => {
  it('asks the update question over a stdin TTY while writing no sprite to a piped stdout', async () => {
    // The launchd/CI shape inverted: interactive on stdin, redirected on stdout. The
    // prompt must still happen — it is gated on #25's `isTTY` — and not one escape
    // byte may reach the log file.
    const d = deps({
      stdin: { isTTY: true },
      update: async () => NEWER_AND_ASKABLE,
    })
    await outcomeOf(d)
    expect(d.ask.asked).toEqual(['Update now? [y/N]: '])
    // Sprite-specific: this path prints the `pc.yellow` update notice, whose colour is
    // decided by the ambient environment and is not the banner's doing.
    expectNoSprite(d.stdout.output())
    expect(d.stdout.output()).toContain('New version available: 9.9.9')
  })

  it('draws the sprite on a stdout TTY while never asking over a piped stdin', async () => {
    // The other half: a terminal a user is watching, with stdin coming from a file or
    // a heredoc. `confirm` would never resolve there, so the question must not be put
    // — and the sprite must be, because stdout is a terminal.
    const d = deps({
      isTTY: true,
      stdin: { isTTY: false },
      update: async () => NEWER_AND_ASKABLE,
    })
    await outcomeOf(d)
    expect(d.ask.asked).toEqual([])
    expect(settledFrame(d)).toEqual(BANNER)
    expect(d.stdout.output()).toContain('New version available: 9.9.9')
  })

  it('never lets the stdin option decide the sprite, in either direction', async () => {
    // #25's `isTTY` is an explicit option too, so the crossed pair is worth pinning
    // as options rather than only as streams.
    const stdinOnly = deps({ isTTY: undefined, stdin: { isTTY: true } })
    await startCommand(stdinOnly)
    expect(stdinOnly.stdout.output()).not.toContain(ESC)

    const stdoutOnly = deps({ isTTY: true })
    await startCommand(stdoutOnly)
    expect(settledFrame(stdoutOnly)).toEqual(BANNER)
  })
})

describe('QA startCommand banner — the two capability options, resolved (#67)', () => {
  // #73: "the banner was shown" is still a prefix check and is still about the sprite's
  // bytes — it is the WHOLE splash that has to be there now, hide and moves and all, so a
  // capability that resolved to a single static frame would fail this rather than pass it.
  const bannerShown = (d) => d.stdout.output().startsWith(SPLASH_BLOCK)

  it('lets an explicit color:true beat a NO_COLOR in the injected environment', async () => {
    // The escape hatch the module header claims exists instead of FORCE_COLOR: a
    // caller that has already decided is not overruled by the bag.
    const d = deps({ isTTY: true, processEnv: { NO_COLOR: '1' }, color: true })
    await startCommand(d)
    expect(bannerShown(d)).toBe(true)
  })

  it('lets an explicit color:false silence a clean TTY', async () => {
    const d = deps({ isTTY: true, color: false })
    await startCommand(d)
    expect(d.stdout.output()).not.toContain(ESC)
  })

  it('resolves an omitted color through colorEnabled, using the stdoutIsTTY it was given', async () => {
    // `stdoutIsTTY` is declared before `color` in the signature, so an explicitly
    // passed one is what the default expression sees. Proved on a PIPED stream, where
    // nothing but the option could have turned the sprite on.
    const forced = deps({ stdoutIsTTY: true })
    await startCommand(forced)
    expect(bannerShown(forced)).toBe(true)

    const suppressed = deps({ stdoutIsTTY: true, processEnv: { NO_COLOR: '' } })
    await startCommand(suppressed)
    expect(suppressed.stdout.output()).not.toContain(ESC)

    // ...including a NO_COLOR the bag inherits rather than owns.
    const inherited = deps({ stdoutIsTTY: true, processEnv: Object.create({ NO_COLOR: '1' }) })
    await startCommand(inherited)
    expect(inherited.stdout.output()).not.toContain(ESC)
  })

  it('falls back to the stream when stdoutIsTTY is passed as undefined', async () => {
    // A caller forwarding an optional value (`{ stdoutIsTTY: options.stdoutIsTTY }`)
    // must get the derivation, not silence: that is what a destructuring default is
    // for, and it is the difference between a forwarded bag and a decision.
    const d = deps({ isTTY: true, stdoutIsTTY: undefined })
    await startCommand(d)
    expect(bannerShown(d)).toBe(true)
  })

  it('reads the injected bag and not the ambient one', async () => {
    // #41: with NO_COLOR exported in the process, an injected clean bag still draws.
    // Mutating process.env here is the documented opt-in — the harness restores it.
    process.env.NO_COLOR = '1'
    const injected = deps({ isTTY: true, processEnv: {} })
    await startCommand(injected)
    expect(bannerShown(injected)).toBe(true)
  })

  it('honors the ambient bag when the caller supplies none, which is what the CLI does', async () => {
    // `bin/ralph.js` calls `startCommand({ currentVersion })` and nothing else, so
    // `processEnv` defaults to `process.env` — the only path on which a real user's
    // exported NO_COLOR reaches the gate. Asserted in both directions so this is a
    // statement about the variable and not about the sandbox.
    const clean = deps({ isTTY: true, processEnv: undefined })
    await startCommand(clean)
    expect(bannerShown(clean)).toBe(true)

    process.env.NO_COLOR = '1'
    const ambient = deps({ isTTY: true, processEnv: undefined })
    await startCommand(ambient)
    expect(ambient.stdout.output()).not.toContain(ESC)
  })
})

// ---------------------------------------------------------------------------
// #68 QA — the identity BOX as a change to the same twelve-way command.
//
// start.banner.test.js proves the box's happy paths and #68's own additions above
// prove the TTY runs of every exit. What is left is the half of the claim the sprite
// never had to make, because the sprite is allowed to be absent:
//
//   1. THE PIPED RUNS. The box is the FIRST LINE of a launchd log, a `| tee`, a CI
//      transcript — on every one of the twelve ways out, including the six aborts,
//      where it is the only context the error has. The TTY assertions above cannot
//      see this: they slice past the splash, so a box that had quietly become
//      TTY-gated would still pass them on the subtraction alone.
//   2. THE CACHE IS READ AND NOTHING ELSE. The box is printed before the first
//      preflight line of every run, so what it must NOT do is measurable: no write,
//      no mkdir, no `npm view`, no second read. The opt-out path must not even read.
//   3. THE SEAM SURVIVES ITS OWN ABUSE. `readCache` is an injected function, and a
//      caller (or a future refactor) can hand back anything. A banner is never worth
//      losing a run over, so every shape costs a HINT and never the run.
// ---------------------------------------------------------------------------

// The box with an update row, spelled out for the same reason BOX is: this file's job
// is the command's actual bytes. Twelve trailing spaces because the value is
// `9.9.9 available — run \`ralph update\`` — 36 columns after the eight-column label
// gutter, inside a 56-column content field.
const BOX_WITH_HINT = [
  BOX_TOP,
  `│ update  9.9.9 available — run \`ralph update\`${' '.repeat(12)} │`,
  AGENT_ROW,
  CWD_ROW,
  SOURCE_ROW,
  BOX_BOTTOM,
]

/** The box wherever it is, found by its own frame — nothing else here draws corners. */
const boxOf = (d) => {
  const lines = d.stdout.lines()
  const top = lines.findIndex((line) => line.startsWith('╭'))
  const bottom = lines.findIndex((line) => line.startsWith('╰'))
  return top === -1 || bottom < top ? [] : lines.slice(top, bottom + 1)
}

const rowOf = (d, label) => boxOf(d).find((line) => line.includes(`│ ${label}`))

const execDetails = (d) => d.timeline.events.filter((e) => e.kind === 'exec').map((e) => e.detail)

// A cache fs that records rather than acts. Every method version-cache.js can reach is
// present — a bag missing one would fail as a TypeError and look like the guard working
// — and the read reports "no such file", which is what a fresh container has.
function recordingCacheFs(ops) {
  return {
    readFileSync: (path) => {
      ops.push(`readFileSync ${path}`)
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    },
    writeFileSync: (path) => ops.push(`writeFileSync ${path}`),
    mkdirSync: (path) => ops.push(`mkdirSync ${path}`),
    existsSync: (path) => {
      ops.push(`existsSync ${path}`)
      return false
    },
  }
}

describe('QA startCommand identity box — the first line of every piped run (#68)', () => {
  for (const [name, options] of Object.entries(PATHS)) {
    it(`opens the ${name} path with the box, above every other side effect`, async () => {
      // Piped, which is the case the sprite does not cover: with no splash in front of it
      // the box is the first lines of stdout, and the first thing this command DOES is the
      // event right after them. Both halves matter — the slice proves it is there and in one
      // piece, `firstEffect` proves nothing happened before it, and the count proves the
      // suppressed splash cost this run no write of its own (not a hide, not a lone reset).
      const d = deps(options)
      const box = boxFor(options)
      await outcomeOf(d)
      expect(d.stdout.lines().slice(0, box.length), name).toEqual(box)
      expect(d.timeline.events[0], name).toEqual({ kind: 'readFile', detail: `${REPO}/ralph.config.sh` })
      expect(d.timeline.firstEffect(), name).toBe(box.length)
      // One `out()` per line, each with its own newline: a chunk that forgot the last
      // one would glue the box's bottom rule to the first preflight line.
      expect(d.stdout.chunks.slice(0, box.length), name).toEqual(box.map((line) => `${line}\n`))
      // ...and the box is text, so a piped run gets it with no escape byte at all.
      for (const line of box) expect(line, name).not.toContain(ESC)
    })
  }

  it('keeps the box on stdout, never on the stream a script reads errors from', async () => {
    // The six aborts all write to stderr; the box is context for a human reading the
    // log, and a script parsing stderr must not have to skip a frame to find the error.
    for (const name of ['tmux session already exists', 'cycle lock held', 'tmux launch failed']) {
      const d = deps(PATHS[name])
      await outcomeOf(d)
      expect(d.stderr.output(), name).not.toContain('╭')
      expect(d.stderr.output(), name).not.toContain('│')
      const box = boxFor(PATHS[name])
      expect(d.stdout.lines().slice(0, box.length), name).toEqual(box)
    }
  })

  it('shows the box first even when the sprite is suppressed by NO_COLOR on a TTY', async () => {
    // A terminal whose user asked for no colour is still a terminal, and the facts are
    // not colour. The sprite goes; the box is line 0.
    for (const options of [
      { isTTY: true, processEnv: { NO_COLOR: '1' } },
      { isTTY: true, processEnv: { NO_COLOR: '' } },
      { isTTY: true, color: false },
      { stdoutIsTTY: false, isTTY: true },
    ]) {
      const d = deps(options)
      await startCommand(d)
      expect(d.stdout.lines().slice(0, BOX.length), JSON.stringify(options)).toEqual(BOX)
      expectNoSprite(d.stdout.output())
    }
  })
})

describe('QA startCommand identity box — the cache is read, and nothing else (#68)', () => {
  it('performs exactly one read and no write on the cache fs, on a launch', async () => {
    // The box READS. #24 owns writing, and it is injected away here (`update` returns a
    // decision, `recordPrompt` is a no-op), so every operation this bag sees is the
    // banner's. One read, no mkdir, no write — a `ralph start` must not create
    // ~/.config/ralph just to print a version.
    const ops = []
    const d = deps({ cacheFs: recordingCacheFs(ops), readCache: undefined })
    expect(await outcomeOf(d)).toEqual({ returned: { exitCode: 0, started: true, count: 3 } })
    expect(ops).toEqual([`readFileSync ${CACHE_PATH}`])
  })

  it('performs no write on any of the twelve ways out', async () => {
    // Including the aborts, which are the runs that exit before #24's step 2.5 — so a
    // write appearing here could only be the banner's.
    for (const [name, options] of Object.entries(PATHS)) {
      const ops = []
      const d = deps({ ...options, cacheFs: recordingCacheFs(ops), readCache: undefined })
      await outcomeOf(d)
      expect(ops.filter((op) => !op.startsWith('readFileSync')), name).toEqual([])
      expect(ops.length, name).toBeLessThanOrEqual(1)
    }
  })

  it('creates no cache file in a fresh container, on a launch and on an abort', async () => {
    // memfs rather than a recorder, so this is a claim about the RESULT: the directory
    // ~/.config/ralph does not come into existence because a banner was printed.
    for (const options of [{}, { sessionExists: true }, { queue: 0 }]) {
      const cacheFs = new Volume()
      const d = deps({ ...options, cacheFs, readCache: undefined })
      await outcomeOf(d)
      expect(cacheFs.toJSON(), JSON.stringify(options)).toEqual({})
    }
  })

  it('asks the registry nothing — no `npm view` on any path', async () => {
    // #21's fetch is `npm view @lucasfe/ralph version`, and #24 gates it behind a
    // weekly throttle. The banner is printed before all of that and must never be the
    // thing that adds a network round trip to `ralph start`'s first paint.
    for (const [name, options] of Object.entries(PATHS)) {
      const d = deps(options)
      await outcomeOf(d)
      for (const detail of execDetails(d)) {
        expect(detail, name).not.toContain('npm')
        expect(detail, name).not.toContain('view')
      }
    }
  })

  it('reads the cache through the seam once, with the run’s own fs, env and home', async () => {
    // #41: the box's one impure input, and it must arrive from the injected bag rather
    // than from the ambient process. Asserted as identity, not as equality.
    const cacheFs = recordingCacheFs([])
    const processEnv = { XDG_CONFIG_HOME: '/xdg' }
    const seen = []
    const d = deps({
      cacheFs,
      processEnv,
      home: '/home/elsewhere',
      readCache: (args) => {
        seen.push(args)
        return { latest_version: null }
      },
    })
    await startCommand(d)
    expect(seen).toHaveLength(1)
    expect(seen[0].fs).toBe(cacheFs)
    expect(seen[0].processEnv).toBe(processEnv)
    expect(seen[0].home).toBe('/home/elsewhere')
  })

  it('reads the real cache file through the injected fs when no seam is given', async () => {
    // The DEFAULT wiring, so `readCache` cannot be plumbed to nothing: memfs stands in
    // for ~/.config/ralph and the hint proves the file was actually read.
    const cacheFs = Volume.fromJSON({ [CACHE_PATH]: JSON.stringify({ latest_version: '9.9.9' }) }, '/')
    const d = deps({ cacheFs, readCache: undefined })
    await startCommand(d)
    expect(boxOf(d)).toEqual(BOX_WITH_HINT)
  })

  it('honors an XDG_CONFIG_HOME the run was given rather than the home dir', async () => {
    // The cache path is XDG-resolved (#24), and the box must read the same file the
    // update check writes — otherwise a user with XDG set gets a hint that never
    // updates, or none at all.
    const processEnv = { XDG_CONFIG_HOME: '/xdg' }
    const path = versionCachePath({ processEnv, home: HOME })
    const cacheFs = Volume.fromJSON({ [path]: JSON.stringify({ latest_version: '9.9.9' }) }, '/')
    const d = deps({ cacheFs, processEnv, readCache: undefined })
    await startCommand(d)
    expect(rowOf(d, 'update')).toContain('9.9.9')
  })
})

describe('QA startCommand identity box — the opt-out gates the hint and the read (#68)', () => {
  // Every spelling of #24's opt-out, and the ONE rule that decides: whatever
  // `isUpdateCheckDisabled` says of the bag is what the hint must do. Computed from
  // that function rather than restated as a literal, because a second reading of the
  // variable is exactly how the box and the notice would come to disagree about
  // whether a user asked to stop being told about updates.
  const SPELLINGS = ['1', '0', 'true', 'false', 'TRUE', 'FALSE', 'yes', 'no', 'off', 'on', ' 1 ', ' 0 ', '', '   ', '\t', '00', '2', '-1', 'null']

  for (const value of SPELLINGS) {
    it(`agrees with isUpdateCheckDisabled for ${JSON.stringify(value)}`, async () => {
      const processEnv = { RALPH_NO_UPDATE_CHECK: value }
      const disabled = isUpdateCheckDisabled(processEnv)
      const seen = []
      const d = deps({
        processEnv,
        readCache: () => {
          seen.push(value)
          return { latest_version: '9.9.9' }
        },
      })
      await startCommand(d)
      expect(Boolean(rowOf(d, 'update')), `disabled=${disabled}`).toBe(!disabled)
      // ...and on the disabled path the cache is not read AT ALL. update-check.js
      // promises that path "reads no cache", two QA suites pin it as zero operations on
      // the injected fs, and the box must not be what starts touching it.
      expect(seen, `disabled=${disabled}`).toEqual(disabled ? [] : [value])
    })
  }

  it('reads the opt-out from a non-string and an inherited value, like the check does', async () => {
    // An injected bag is not `process.env` and is not bound to strings; an inherited
    // key is how a caller layers a bag over defaults. Both go through String() in
    // isUpdateCheckDisabled, so both must gate the hint the same way.
    for (const processEnv of [
      { RALPH_NO_UPDATE_CHECK: 1 },
      { RALPH_NO_UPDATE_CHECK: true },
      { RALPH_NO_UPDATE_CHECK: 0 },
      { RALPH_NO_UPDATE_CHECK: false },
      { RALPH_NO_UPDATE_CHECK: null },
      { RALPH_NO_UPDATE_CHECK: undefined },
      Object.create({ RALPH_NO_UPDATE_CHECK: '1' }),
    ]) {
      const d = deps({ processEnv, readCache: () => ({ latest_version: '9.9.9' }) })
      await startCommand(d)
      const context = JSON.stringify(processEnv)
      expect(Boolean(rowOf(d, 'update')), context).toBe(!isUpdateCheckDisabled(processEnv))
    }
  })

  it('touches no cache file on the opt-out path, with the default wiring', async () => {
    // Not just "the seam was not called": with no seam injected at all, the fs the run
    // was given must see nothing — no read, no mkdir, no write.
    const ops = []
    const d = deps({
      processEnv: { RALPH_NO_UPDATE_CHECK: '1' },
      cacheFs: recordingCacheFs(ops),
      readCache: undefined,
    })
    await startCommand(d)
    expect(ops).toEqual([])
    expect(boxOf(d)).toEqual(BOX)
  })

  it('still prints the box itself when update checks are off', async () => {
    // The opt-out is about the NAG, not about the facts: which version and which
    // directory are still the reasons this box exists.
    const d = deps({ processEnv: { RALPH_NO_UPDATE_CHECK: '1' }, isTTY: true })
    await startCommand(d)
    expect(d.stdout.lines().slice(SPLASH_LINES, SPLASH_LINES + BOX.length)).toEqual(BOX)
  })
})

describe('QA startCommand identity box — the readCache seam, abused (#68)', () => {
  // Everything the seam can hand back that is not a cache. Each costs the HINT and
  // nothing else: same box, same exit code, nothing on stderr.
  const RETURNS = [
    ['null', () => null],
    ['undefined', () => undefined],
    ['an empty object', () => ({})],
    ['a numeric latest_version', () => ({ latest_version: 42 })],
    ['a null latest_version', () => ({ latest_version: null })],
    ['a blank latest_version', () => ({ latest_version: '   ' })],
    ['a non-semver latest_version', () => ({ latest_version: 'banana' })],
    ['an array', () => []],
    ['a string', () => 'nope'],
    ['a number', () => 7],
    ['a promise', () => Promise.resolve({ latest_version: '9.9.9' })],
    ['a throwing latest_version getter', () => ({ get latest_version() { throw new Error('boom') } })],
    ['a throwing read', () => { throw new TypeError('The "path" argument must be of type string.') }],
    ['a null prototype cache', () => Object.assign(Object.create(null), { latest_version: null })],
  ]

  for (const [name, readCache] of RETURNS) {
    it(`costs a hint and never the run for ${name}`, async () => {
      const d = deps({ readCache })
      expect(await outcomeOf(d), name).toEqual({
        returned: { exitCode: 0, started: true, count: 3 },
      })
      expect(boxOf(d), name).toEqual(BOX)
      expect(d.stderr.output(), name).toBe('')
    })
  }

  it('does not await a promised cache into a hint, and does not warn about it', async () => {
    // A `readCache` that returns a promise is a refactor accident (`async` added to a
    // sync seam). The banner is printed synchronously before the first preflight line,
    // so there is nothing to await it with — what matters is that the run is unharmed
    // and the box says nothing it cannot prove.
    const d = deps({ readCache: async () => ({ latest_version: '9.9.9' }) })
    await startCommand(d)
    expect(boxOf(d)).toEqual(BOX)
    expect(d.stdout.output()).not.toContain('ralph update')
  })

  it('trusts a seam’s value no further than a semver, on the hint', async () => {
    // An injected seam has not necessarily been through normalizeCache, so the string
    // check in the command is not redundant with version-cache.js's. A padded value is
    // still a version; a v-prefixed one is not.
    const padded = deps({ readCache: () => ({ latest_version: ' 9.9.9 ' }) })
    await startCommand(padded)
    expect(boxOf(padded)).toEqual(BOX_WITH_HINT)

    for (const latest of ['v9.9.9', '9.9', 'latest', '9.9.9.9']) {
      const d = deps({ readCache: () => ({ latest_version: latest }) })
      await startCommand(d)
      expect(boxOf(d), latest).toEqual(BOX)
    }
  })

  it('offers no hint for a cached version that is not newer than the installed one', async () => {
    for (const latest of ['1.2.3', '1.2.2', '0.9.9', '1.2.3-rc.1']) {
      const d = deps({ readCache: () => ({ latest_version: latest }) })
      await startCommand(d)
      expect(boxOf(d), latest).toEqual(BOX)
    }
  })
})

describe('QA startCommand identity box — the width comes from the stream (#68, #72)', () => {
  const widthsOf = (d) => boxOf(d).map((line) => [...line].length)

  it('takes the terminal’s columns, and the 60-column default from a stream without any', async () => {
    // Only the widths a frame fits in (#72). 40, 30 and 26 used to be here and are not a
    // deleted case: below 44 there is no box whose four sides can share one width, so the
    // claim MOVES to the test below rather than relaxing here — and 44 and 59, the rungs
    // either side of the drop, are new.
    //
    // #161 REPLACED 200 WITH 71, one column under its rung, and the cap is still what the
    // last two rows are about: 61 and 71 both draw a 60-column box, which is the claim 200
    // was here for. From 72 up the box is laid out at what the SPRITE leaves — `besideWidth`,
    // capped at the same 60 — and `boxOf` cannot find it with `startsWith('╭')` because its
    // lines begin with the picture. That arrangement's widths are pinned in
    // banner-compose.test.js and its bytes in start.banner-beside.test.js.
    for (const [columns, expected] of [
      [44, 44],
      [50, 50],
      [59, 59],
      [61, 60],
      [71, 60],
    ]) {
      const d = deps({ isTTY: true })
      d.stdout.columns = columns
      await startCommand(d)
      expect(new Set(widthsOf(d)), String(columns)).toEqual(new Set([expected]))
    }
  })

  it('prints the same facts bare, at every width too narrow to hold a frame', async () => {
    // The other half of the width claim, spelled out to the byte like BOX above it: the
    // SAME facts in the same order, unadorned, each clipped to the columns the stream
    // reported and padded to nothing. Piped, so line 0 is the title at every width here
    // — including the ones below 26, where the sprite is gone too.
    //
    // #69's agent row is the interesting one at these widths, because it is a SENTENCE
    // rather than a word: 44 columns of it, so it is the first row to lose its tail and it
    // loses it at every rung below the frame. That is the intended trade and worth pinning
    // — the alternative is a row that wraps, and a wrapped row tears the box a rung up.
    for (const [columns, expected] of [
      [43, ['ralph 1.2.3', 'agent   claude — model resolves at first r…', 'cwd     /repo', 'source  folder']],
      [30, ['ralph 1.2.3', 'agent   claude — model resolv…', 'cwd     /repo', 'source  folder']],
      [26, ['ralph 1.2.3', 'agent   claude — model re…', 'cwd     /repo', 'source  folder']],
      [12, ['ralph 1.2.3', 'agent   cla…', 'cwd     /re…', 'source  fol…']],
      [5, ['ralp…', 'agen…', 'cwd …', 'sour…']],
      [1, ['…', '…', '…', '…']],
    ]) {
      const d = deps()
      d.stdout.columns = columns
      await startCommand(d)
      expect(d.stdout.lines().slice(0, expected.length), String(columns)).toEqual(expected)
      // ...and no frame glyph survived anywhere in the run: not a half-drawn corner, not
      // a lone side. These facts contain none of their own, so this is the command's.
      expect(d.stdout.output(), String(columns)).not.toMatch(/[╭╮╰╯│─]/)
    }
  })

  it('falls back to the default for every column count a stream can lie with', async () => {
    // `stdout.columns` is 0 on some CI runners, undefined on a pipe, and there is no
    // rule that says a stream cannot report nonsense. None of it may produce a
    // one-column box or lose the run.
    for (const columns of [0, -1, Number.NaN, '80', null, {}, 0.5]) {
      const d = deps({ isTTY: true })
      d.stdout.columns = columns
      await startCommand(d)
      expect(boxOf(d), JSON.stringify(columns)).toEqual(BOX)
    }
  })

  it('lets an explicit columns option beat what the stream reports', async () => {
    // Same convention as `stdoutIsTTY` and `color`: a caller that has already decided
    // is not overruled by the stream.
    const boxed = deps({ isTTY: true, columns: 50 })
    boxed.stdout.columns = 200
    await startCommand(boxed)
    expect(new Set(widthsOf(boxed))).toEqual(new Set([50]))

    // ...and it wins the LADDER RUNG too, not merely the drawn width (#72): 30 unboxes,
    // however roomy the stream claims to be. Was a single 30-column box before the ladder
    // existed; the same option, the same precedence, one rung further down.
    const bare = deps({ isTTY: true, columns: 30 })
    bare.stdout.columns = 200
    await startCommand(bare)
    expect(boxOf(bare)).toEqual([])
    expect(bare.stdout.lines().slice(SPLASH_LINES, SPLASH_LINES + 3)).toEqual([
      'ralph 1.2.3',
      'agent   claude — model resolv…',
      'cwd     /repo',
    ])
  })

  it('never lets a narrow terminal spill the box past the columns it reported', async () => {
    // The guarantee a wrapping terminal makes visible: one line wider than the
    // terminal is two lines on screen, and the box would look torn in exactly the
    // window a user shrank to read it.
    //
    // Piped, and by INDEX rather than through boxOf: below 44 columns there is no frame
    // at all (#72), and below three the glyphs would be clipped away in any case, so a
    // finder that looks for `╭` finds nothing — and "the first lines of stdout are the
    // banner" is the claim that still holds there.
    //
    // The HEIGHT is derived rather than pinned, because the bottom rule is a piece of the
    // frame and leaves with it: four lines boxed (rule, hint, cwd, rule), three bare. This
    // run's cache holds a newer version, which is what puts the hint row there at all.
    for (const columns of [59, 44, 27, 26, 12, 5, 2, 1]) {
      const d = deps({ columns, readCache: () => ({ latest_version: '9.9.9' }) })
      await startCommand(d)
      const height = bannerLayout(columns).boxed ? BOX_WITH_HINT.length : BOX_WITH_HINT.length - 1
      const box = d.stdout.lines().slice(0, height)
      expect(box, String(columns)).toHaveLength(height)
      for (const line of box) {
        const visible = [...line.replaceAll(/\u001B\[\d+m/g, '')].length
        expect(visible, `${columns}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns)
        // ...and each of them still says something: a banner that degraded into blank
        // rows would pass a width claim on the emptiness alone.
        expect(line.trim(), `${columns}: ${JSON.stringify(line)}`).not.toBe('')
      }
    }
  })
})

describe('QA startCommand banner — the sprite rung, through the real command (#72)', () => {
  // The width reaches TWO functions from one variable, and the box's half of that is the
  // block above. This is the sprite's half, which nothing else in this file asserts: the
  // rung either side of 26 through `startCommand` itself, the runs where an unusable column
  // count must leave the sprite exactly as it was before #72 existed, and the claim that
  // holds the whole ladder together at the command level — that shrinking the terminal
  // changes the banner and NOTHING ELSE about the run.
  //
  // Absence is asserted with `expectNoSprite`, never as "no escape anywhere": picocolors
  // decides from the real `process.env` at import and colours the update notice on any
  // machine with CI set, so truecolor and the two half-block glyphs are the only
  // discriminators that mean the same thing here and on a CI runner.

  // Built from the file's own ESC rather than written out, so no literal control byte lives
  // in this source: the sprite's cells are what a width claim is about, and its truecolor
  // sequences carry semicolons that `\d+` would not match.
  const SPRITE_SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

  /**
   * How many lines of banner a run at this width owes, sprite and box together.
   *
   * #73: the sprite's contribution is the SPLASH's line count, not one frame's — five
   * frames all reach stdout, and the four that were redrawn over are still lines a reader
   * of `d.stdout.lines()` has to skip to find the run's body.
   *
   * #161: and where the box sits BESIDE the sprite it costs no lines of its own — it is
   * inside those same rows, to the right of the picture. Which is the whole shape of that
   * issue read as a height: a wide terminal's banner got SEVEN ROWS SHORTER without losing
   * a fact. Every run in this block is a TTY with a sprite, so `beside` alone decides it.
   */
  const bannerHeight = (columns, boxHeight = BOX.length) => {
    const layout = bannerLayout(columns)
    const sprite = layout.sprite ? SPLASH_LINES : 0
    if (layout.sprite && layout.beside) return sprite
    return sprite + (layout.boxed ? boxHeight : boxHeight - 1)
  }

  it('draws the sprite at twenty-six columns and not at twenty-five', async () => {
    // The rung, through the command rather than through the pure function — because the
    // command is where the column count could be dropped, rounded, or read off the wrong
    // stream, and every one of those mistakes leaves both pure functions correct. 26 is the
    // sprite's own cell width, so it is the last width that draws and 25 the first that does
    // not; both runs are otherwise the same bag.
    const fits = deps({ isTTY: true, columns: 26 })
    await startCommand(fits)
    expect(settledFrame(fits)).toEqual(BANNER)
    expect(fits.stdout.lines().slice(SPLASH_LINES, SPLASH_LINES + 3)).toEqual([
      'ralph 1.2.3',
      'agent   claude — model re…',
      'cwd     /repo',
    ])

    const tooNarrow = deps({ isTTY: true, columns: 25 })
    await startCommand(tooNarrow)
    expectNoSprite(tooNarrow.stdout.output())
    // ...and the facts take the sprite's place rather than the blank rows a dropped banner
    // would leave behind: line 0 of the run is the title. One column narrower takes one more
    // character off #69's agent sentence and nothing else, which is the clip doing its job at
    // a rung where there is no frame left to tear.
    expect(tooNarrow.stdout.lines().slice(0, 3)).toEqual([
      'ralph 1.2.3',
      'agent   claude — model r…',
      'cwd     /repo',
    ])
  })

  it('never lets the sprite spill past the columns the stream reported', async () => {
    // The same guarantee the box keeps, asked of the half that cannot be clipped: the sprite
    // is 26 cells and is dropped whole below that, so at 26 it fits exactly and at no width
    // may one of its rows be wider than the terminal.
    //
    // #73 widens this from one frame to ALL EIGHTY-FIVE ROWS of the splash, which is the
    // sharper version of the same claim: a frame one column too wide wraps, and a wrapped
    // frame is one line taller than the cursor-up that follows it — so the animation would
    // walk UP the terminal, eating a row of scrollback per frame. The cursor-control bytes
    // come off first, since they are what `splashLines` exists for and they occupy no cell.
    //
    // #161 CAPS THE WIDTHS HERE AT 71, and it is a narrowing of the case rather than of the
    // claim: from 72 columns up the rows are the sprite WITH THE BOX GLUED ON, so `BANNER` is
    // no longer what a row equals and the cell count is legitimately wider than the picture.
    // That arrangement's own version of both assertions — the frames byte for byte, and every
    // row inside the terminal — is start.banner-beside.test.js's.
    for (const columns of [26, 27, 43, 60, 71]) {
      const d = deps({ isTTY: true, columns })
      await startCommand(d)
      const sprite = splashLines(d)
      expect(sprite, String(columns)).toHaveLength(SPLASH_LINES)
      expect(sprite.slice(-BANNER.length), String(columns)).toEqual(BANNER)
      for (const line of sprite) {
        const cells = [...line.replaceAll(SPRITE_SGR, '')].length
        expect(cells, `${columns}: ${cells} cells`).toBeLessThanOrEqual(columns)
      }
    }
  })

  it('still draws the sprite for every column count a stream can lie with', async () => {
    // The compatibility claim, and the direction the block above this one does not cover: it
    // pins the BOX at its 60-column default for these same values, which would also pass on
    // a run that had quietly stopped drawing the sprite. `stdout.columns` is `undefined` on
    // a pipe and `0` on some CI runners, so this is the ordinary case for a great many real
    // terminals — a width nobody could resolve has to leave #67's banner exactly as it was.
    for (const columns of [undefined, 0, -1, -80, Number.NaN, '80', null, {}, 0.5, Infinity]) {
      const d = deps({ isTTY: true, columns })
      await startCommand(d)
      const label = JSON.stringify(columns) ?? String(columns)
      expect(settledFrame(d), label).toEqual(BANNER)
      expect(d.stdout.lines().slice(SPLASH_LINES, SPLASH_LINES + BOX.length), label).toEqual(BOX)
    }
  })

  it('loses not one line of the run to a narrow terminal', async () => {
    // THE POINT OF THE WHOLE ISSUE, at the command level: the width may change the banner and
    // may change nothing else. Every preflight line, every notice, every byte after the
    // banner is compared against a 60-column run — so a `columns` that leaked into a later
    // line, a guard that moved, or a row of preflight swallowed by the banner's own loop
    // shows up as a diff, at whichever width it happens on.
    //
    // The banner's HEIGHT is derived from the ladder rather than pinned, because that is the
    // one thing the width is allowed to change: the splash's eighty-five rows at 26 and
    // above, and a bottom rule only where the frame was drawn.
    const reference = deps({ isTTY: true, columns: 60 })
    await startCommand(reference)
    const tail = reference.stdout.lines().slice(bannerHeight(60))
    expect(tail.length, 'the run needs a body for this to mean anything').toBeGreaterThan(3)

    for (const columns of [200, 61, 59, 44, 43, 30, 27, 26, 25, 12, 5, 1, 0, undefined]) {
      const d = deps({ isTTY: true, columns })
      await startCommand(d)
      const label = JSON.stringify(columns) ?? String(columns)
      expect(d.stdout.lines().slice(bannerHeight(columns)), label).toEqual(tail)
      // ...and stderr was never part of the banner, so it must be untouched at every width.
      expect(d.stderr.output(), label).toBe(reference.stderr.output())
    }
  })

  it('lets no width talk a pipe or a NO_COLOR run into a sprite', async () => {
    // The width is a third reason to stay silent and never a reason to speak. A wide terminal
    // is the value most likely to look like permission — and the box, which is facts rather
    // than decoration, must still print in both cases, which is what distinguishes
    // "suppressed the sprite" from "lost the banner".
    for (const columns of [200, 60, 44, 26]) {
      const piped = deps({ columns })
      await startCommand(piped)
      expectNoSprite(piped.stdout.output())
      expect(piped.stdout.lines()[0], String(columns)).toContain('ralph')

      const suppressed = deps({ isTTY: true, columns, processEnv: { NO_COLOR: '1' } })
      await startCommand(suppressed)
      expectNoSprite(suppressed.stdout.output())
      expect(suppressed.stdout.lines()[0], String(columns)).toContain('ralph')
    }
  })

  it('asks the stream it was handed and never the terminal it is running in', async () => {
    // #41 at the command level, and the reason every width here is injected: the real
    // `process.stdout.columns` is whatever window this suite happens to run in, so a command
    // that consulted it would make these expectations pass in a maximised terminal and fail
    // in a split pane. The stream reports 30 — narrow enough to unbox, wide enough to draw —
    // and that is what the banner must follow.
    const d = deps({ isTTY: true })
    d.stdout.columns = 30
    await startCommand(d)
    expect(settledFrame(d)).toEqual(BANNER)
    expect(d.stdout.lines().slice(SPLASH_LINES, SPLASH_LINES + 3)).toEqual([
      'ralph 1.2.3',
      'agent   claude — model resolv…',
      'cwd     /repo',
    ])
    expect(boxOf(d)).toEqual([])
  })
})
