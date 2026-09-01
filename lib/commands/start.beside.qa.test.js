// #161 QA — the arrangement as `ralph start` actually spends it, across the whole surface.
//
// start.banner-beside.test.js proves the intended slice: wide colour TTY glues the box on, 72
// columns does and 71 does not, a pipe is untouched, `static` keeps the arrangement, `off`
// prints nothing. Those are seven runs at three widths. This file attacks the parts of the
// change that only show up when the same decision is made ninety-six ways, and it is organised
// around the four things #161 actually put at risk:
//
//   1. THE COUNT, NOT THE PRESENCE. Before this issue the box was printed by exactly one
//      statement. Now it is printed by TWO — glued into every frame, or written under the
//      picture — and the branch that chooses is a three-term conjunction (`layout.beside &&
//      frames.length > 0 && boxLines.length > 0`) resolved separately from the `!beside` that
//      guards the other. Get either wrong and the box is drawn TWICE or ZERO times. So the
//      matrix below is driven as {four modes} × {eight column counts} × {three streams} and the
//      claim is a NUMBER at every cell — and the number the beside cells are checked against is
//      derived by driving lib/sprite-player.js with the real frame list, never a literal 5.
//   2. THE ARRANGEMENT IS NOT DECIDED HERE, so the expectation must not be either. The predicted
//      arrangement is written out longhand from the ISSUE's rules — a picture needs a TTY,
//      colour and 26 columns; the box goes beside it when 26 + 2 + 44 fit — rather than read
//      back out of `resolveBannerMode` and `bannerLayout`. An expectation built from the two
//      functions under test agrees with them by construction, including when they are wrong
//      together.
//   3. CTRL-C NOW LANDS IN THE MIDDLE OF A TALLER PICTURE. The interrupt path restores the
//      cursor and re-raises; it does NOT stop the animation, so the frames keep coming after the
//      restore has already gone out. With the box glued on, every one of those frames carries a
//      `╭─` and a `╰─`, and a run that stranded a box with a top and no bottom would be a run
//      whose scrollback ends in a broken frame. Counted at both ends.
//   4. THE BOX NOW LIVES INSIDE THE ANIMATION'S FAILURE DOMAIN. `playBannerSplash` swallows a
//      stream that dies mid-splash, and where the box was glued in there is no second print to
//      fall back on. The run must survive — that is criterion-level — and what it survives AS is
//      pinned here rather than left to be discovered in a launchd log.
//
// Plus the negative: `ralph doctor` draws its box through the same composer and must be
// byte-identical at any width. Its import graph is proven unable to reach the join in
// lib/banner-compose.beside.qa.test.js; what is asserted here is the OUTPUT, because a field
// nobody imports can still be reached through a function that does.
//
// HERMETIC (#41): every run injects the stream, the columns, the environment, the clock the
// splash sleeps on and a RECORDING signal source — no test here waits on a real timer, reads
// `process.stdout.columns`, or registers a SIGINT handler on the vitest worker.

import { describe, expect, it } from 'vitest'
import { Volume } from 'memfs'
import { StartAbort, startCommand } from './start.js'
import { doctorCommand } from './doctor.js'
import { joinBeside } from '../banner-beside.js'
import { BANNER_WIDTH, bannerLayout, composeBanner } from '../banner-compose.js'
import { renderSplashFrames } from '../sprite-banner.js'
import { playSplash } from '../sprite-player.js'
import { spriteWidth } from '../sprite-data.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'

// Built from the code point rather than embedded: a raw ESC in a tracked file recolours the
// terminal of anybody who reads it (#107, test/source-control-bytes.test.js).
const ESC = String.fromCharCode(27)
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const HIDE = `${ESC}[?25l`
const SHOW = `${ESC}[?25h`
const CURSOR_UP = new RegExp(`${ESC}\\[(\\d+)A`)
const SPRITE_FG = `${ESC}[38;2;`
const codePoints = (line) => [...line.replace(SGR, '')].length
const occurrences = (haystack, needle) => haystack.split(needle).length - 1

const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'

// The eight column counts, chosen so every branch of the ladder is represented and so the two
// values a real terminal reports when it does not know its own size are in the list: `undefined`
// from a pipe and `0` from more than one CI runner. 71/72 are the rung; 25/26 are the sprite's.
const COLUMN_COUNTS = [undefined, 0, 25, 26, 44, 71, 72, 120, 10_000]

/**
 * The predicted arrangement, written from the ISSUE'S RULES and not from the ladder.
 *
 * This is the one place in the file where a number is spelled out, and it is deliberate: an
 * expectation computed by calling `bannerLayout` and `resolveBannerMode` is satisfied by any
 * implementation those two functions agree on, including a broken one. What #161 promises, in
 * words, is: nothing at all if the banner was switched off; a picture only on a colour TTY at
 * least 26 columns wide; and the box to the RIGHT of that picture when the picture's 26 columns,
 * two of air and a box with four sides all fit. Those three sentences are the function below.
 */
const usable = (columns) =>
  typeof columns === 'number' && Number.isFinite(columns) && Math.floor(columns) >= 1
    ? Math.floor(columns)
    : 60
const arrangementFor = ({ mode, isTTY, color, columns }) => {
  if (mode === 'off') return 'silent'
  const limit = usable(columns)
  if (isTTY !== true || color !== true || limit < 26) return 'stacked'
  return limit >= 26 + 2 + 44 ? 'beside' : 'stacked'
}

/** Every write, in order, plus a switch that makes the animation's bytes unwritable. */
function makeStream({ isTTY, refuseSplash = false } = {}) {
  const chunks = []
  const attempts = []
  const stream = {
    write: (s) => {
      attempts.push(s)
      // REFUSAL BY CONTENT, not by attempt count — the same seam and the same reasoning as
      // start.splash.qa.test.js: the first rejection aborts the player's loop, so a stream that
      // counts its writes cannot express "a terminal the picture cannot reach and the words can".
      if (refuseSplash && (s.includes(`${ESC}[?25`) || CURSOR_UP.test(s) || s.includes(SPRITE_FG))) {
        throw new Error('EPIPE')
      }
      chunks.push(s)
      return true
    },
    chunks,
    attempts,
    output: () => chunks.join(''),
  }
  if (isTTY !== undefined) stream.isTTY = isTTY
  return stream
}

/** A signal source that RECORDS: `on`/`off` really register so a leak is visible. */
function makeSignals() {
  const ops = []
  const handlers = []
  return {
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
}

function deps({
  isTTY,
  columns,
  queue = 3,
  sessionExists = false,
  processEnv = {},
  refuseSplash = false,
  ...overrides
} = {}) {
  const naps = []
  const stdout = makeStream({ isTTY, refuseSplash })
  const stderr = makeStream()
  const signals = makeSignals()
  return {
    cwd: REPO,
    stdout,
    stderr,
    columns,
    naps,
    signals,
    processEnv,
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
    // Pinned for the reason every other start spec pins them: a developer's own cached update or
    // this week's release notes would add rows to the box and put a diff into every byte
    // comparison below that has nothing to do with #161 (#41).
    readCache: () => ({ ...EMPTY_VERSION_CACHE }),
    readChangelog: () => [],
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    folderQueueCount: async () => queue,
    now: () => 1_700_000_000_000,
    home: HOME,
    // The splash's clock, RECORDING rather than waiting: every suppressed cell below asserts
    // this array is empty, which is the half of "no picture" no byte assertion can show.
    sleep: async (ms) => {
      naps.push(ms)
    },
    ...overrides,
  }
}

/** The facts this harness's runs resolve to — the box, at whatever width it is laid out at. */
const boxAt = (width, { color }) =>
  composeBanner({
    facts: {
      version: VERSION,
      latestVersion: null,
      cwd: REPO,
      agent: 'claude',
      model: null,
      provenance: 'unknown',
      contextWindow: null,
      source: 'folder',
      repo: null,
      whatsNew: [],
    },
    width,
    capabilities: { color },
  })

/**
 * The bytes lib/sprite-player.js writes for a frame list — from the PLAYER, never restated.
 *
 * This is also how the OWED BOX COUNT is derived. "The box appears once per frame the player
 * writes" is a fact about the player's sequence, and the sequence is `cycles` long with the
 * poster frame repeated — so the honest way to ask how many copies are owed is to play the real
 * list and count them, which is what `boxWrites` below does. A literal 5 would be a second
 * opinion about the animation, and would keep passing on the day the count changed.
 */
async function played(frames, cycles) {
  const chunks = []
  await playSplash({
    frames,
    cycles,
    stream: { write: (chunk) => chunks.push(chunk) },
    sleep: async () => {},
    signals: null,
  })
  return chunks
}

/** The whole banner `ralph start` owes at these capabilities: the animation, then any stack. */
async function expectedBanner({ mode, isTTY, color, columns }) {
  const arrangement = arrangementFor({ mode, isTTY, color, columns })
  if (arrangement === 'silent') {
    return { arrangement, block: '', boxLines: [], boxWrites: 0, rows: [] }
  }
  const layout = bannerLayout(columns)
  const cycles = mode === 'static' ? 1 : undefined
  const bare =
    arrangement === 'stacked' && (isTTY !== true || color !== true || !layout.sprite)
      ? []
      : renderSplashFrames({ isTTY: true, color: true, width: columns })
  if (arrangement === 'stacked') {
    const boxLines = boxAt(columns, { color: Boolean(color) })
    const chunks = await played(bare, cycles)
    return {
      arrangement,
      block: `${chunks.join('')}${boxLines.map((line) => `${line}\n`).join('')}`,
      boxLines,
      boxWrites: 1,
      // The TERMINAL ROWS the banner puts on screen, as the strings they are — deliberately not
      // `block.split('\n')`, which would carry the animation's own DECTCEM and cursor bytes into
      // a width measurement and make the first row of every splash six columns too wide.
      rows: [...bare.flatMap((frame) => frame.lines), ...boxLines],
    }
  }
  const boxLines = boxAt(layout.besideWidth, { color: true })
  const frames = bare.map((frame) => ({
    ...frame,
    lines: joinBeside({ spriteLines: frame.lines, boxLines, spriteWidth }),
  }))
  const chunks = await played(frames, cycles)
  const block = chunks.join('')
  return {
    arrangement,
    block,
    boxLines,
    boxWrites: occurrences(block, boxLines[0]),
    rows: frames.flatMap((frame) => frame.lines),
    chunkCount: chunks.length,
  }
}

/** How the command left, in a shape two runs can be compared on. */
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

// The three streams a `ralph start` meets, named by what they can carry. `RALPH_BANNER` is
// driven through the ENVIRONMENT rather than the config file, because that is the override side
// of #74's inverted precedence and the side a wrapper script or CI job actually uses.
const STREAMS = {
  'a colour TTY': { isTTY: true, processEnv: {} },
  'a TTY under NO_COLOR': { isTTY: true, processEnv: { NO_COLOR: '1' } },
  'a pipe': { processEnv: {} },
}
const MODES = { unset: undefined, full: 'full', static: 'static', off: 'off' }

describe('QA the arrangement — the box is drawn exactly as many times as it is owed (#161)', () => {
  for (const [modeLabel, mode] of Object.entries(MODES)) {
    it(`draws it the owed number of times for RALPH_BANNER=${modeLabel}, at every width`, async () => {
      for (const [streamLabel, stream] of Object.entries(STREAMS)) {
        for (const columns of COLUMN_COUNTS) {
          const where = `${modeLabel} / ${streamLabel} / ${String(columns)} columns`
          const processEnv = { ...stream.processEnv, ...(mode ? { RALPH_BANNER: mode } : {}) }
          const color = stream.isTTY === true && processEnv.NO_COLOR === undefined
          const owed = await expectedBanner({
            mode: mode ?? 'full',
            isTTY: stream.isTTY,
            color,
            columns,
          })
          const d = deps({ isTTY: stream.isTTY, columns, processEnv })
          const result = await startCommand(d)
          expect(result.started, where).toBe(true)
          const output = d.stdout.output()

          // THE BYTES, as a prefix: the animation the player writes for these frames, followed
          // by the stack when there is one. Comparing the whole block rather than the first line
          // is what makes this a claim about the ARRANGEMENT — a box printed in both places, or a
          // stack printed before the picture, fails here rather than hiding inside a `contains`.
          expect(output.startsWith(owed.block), `${where}: banner block`).toBe(true)

          // ...and THE COUNT, over the whole run, which is the assertion the prefix cannot make:
          // a second copy of the box written after the preflight lines is still a second copy.
          if (owed.boxLines.length === 0) {
            expect(output, `${where}: silent`).not.toMatch(/[╭╮╰╯│]/)
            expect(output, `${where}: silent`).not.toContain(SPRITE_FG)
            expect(output, `${where}: silent`).not.toContain(`${ESC}[?25`)
          } else {
            expect(occurrences(output, owed.boxLines[0]), `${where}: top rule`).toBe(owed.boxWrites)
            // Both ends of the box, because a frame is a rectangle: a count that matched at the
            // top and not at the bottom is a box the animation cut in half.
            expect(
              occurrences(output, owed.boxLines[owed.boxLines.length - 1]),
              `${where}: bottom rule`,
            ).toBe(owed.boxWrites)
            expect(owed.boxWrites, `${where}: at least once`).toBeGreaterThan(0)
          }

          // ...and EVERY BANNER ROW INSIDE THE TERMINAL, in code points, which is the promise
          // the join makes and never checks. Measured on the block the command actually wrote.
          for (const [index, line] of owed.rows.entries()) {
            expect(codePoints(line), `${where}: row ${index}`).toBeLessThanOrEqual(
              bannerLayout(columns).width,
            )
          }
        }
      }
    })
  }

  it('spends the arrangement on exactly the cells that can hold it', async () => {
    // THE MATRIX IS ONLY WORTH RUNNING IF IT VARIES, and a predicate that answered `stacked`
    // everywhere would satisfy every assertion above. So the table is pinned: fifteen beside
    // cells, all of them a colour TTY at 72 columns or more, and nothing else anywhere.
    const seen = { silent: 0, stacked: 0, beside: 0 }
    for (const [, mode] of Object.entries(MODES)) {
      for (const [, stream] of Object.entries(STREAMS)) {
        for (const columns of COLUMN_COUNTS) {
          const color = stream.isTTY === true && stream.processEnv.NO_COLOR === undefined
          const arrangement = arrangementFor({ mode: mode ?? 'full', isTTY: stream.isTTY, color, columns })
          seen[arrangement] += 1
          if (arrangement !== 'beside') continue
          expect(stream.isTTY).toBe(true)
          expect(color).toBe(true)
          expect(usable(columns)).toBeGreaterThanOrEqual(72)
        }
      }
    }
    // Nine beside cells: three modes that are not `off`, on the one stream that can paint, at
    // the three widths at or past the rung. Everything else stacks, and every `off` cell is
    // silent whatever the stream and the width.
    const cells = Object.keys(MODES).length * Object.keys(STREAMS).length * COLUMN_COUNTS.length
    expect(cells).toBe(108)
    expect(seen).toEqual({ silent: 27, stacked: cells - 27 - 9, beside: 9 })
  })

  it('owes five copies of the box for a splash and one for a still', async () => {
    // THE COUNT IS THE MODE'S, and this is the assertion that says so out loud rather than
    // leaving it inside a byte comparison. `static` is a choice about plumbing and not about
    // pixels (#74), so it is the same arrangement held for one beat — one frame written, one
    // box in it — where `full` redraws the picture five times and therefore the box five times.
    const full = await expectedBanner({ mode: 'full', isTTY: true, color: true, columns: 120 })
    const still = await expectedBanner({ mode: 'static', isTTY: true, color: true, columns: 120 })
    expect(full.arrangement).toBe('beside')
    expect(still.arrangement).toBe('beside')
    expect(full.boxWrites).toBe(5)
    expect(still.boxWrites).toBe(1)
    // ...and the still is a prefix of nothing: it writes the frame and no cursor byte at all,
    // which is what makes `cycles: 1` byte-identical to the unanimated banner #67 shipped.
    expect(still.block).not.toContain(`${ESC}[?25`)
    expect(still.block).not.toMatch(CURSOR_UP)
    expect(full.block.startsWith(HIDE)).toBe(true)
  })

  it('costs a suppressed run no nap, no cursor byte and no signal handler, however wide', async () => {
    // Criterion 6 of #73, re-driven because #161 moved the code that decides it. A stacked run
    // resolves `frames` and composes a box for the whole terminal, and a join that had been
    // hoisted above the mode would nap five times on a pipe — a second of wall clock per
    // invocation that no log could ever show, on the command launchd and CI run.
    for (const columns of COLUMN_COUNTS) {
      for (const stream of [
        { processEnv: {} },
        { isTTY: true, processEnv: { NO_COLOR: '1' } },
        { isTTY: true, processEnv: { RALPH_BANNER: 'off' } },
      ]) {
        const where = `${JSON.stringify(stream)} / ${String(columns)}`
        const d = deps({ ...stream, columns })
        await startCommand(d)
        expect(d.naps, `${where}: naps`).toEqual([])
        expect(d.signals.ops, `${where}: signals`).toEqual([])
        expect(d.stdout.output(), where).not.toContain(`${ESC}[?25`)
        expect(d.stdout.output(), where).not.toMatch(CURSOR_UP)
      }
    }
  })

  it('answers with the same object whichever way the banner was arranged', async () => {
    // #73's criterion 8, restated for #161: a rearranged banner is a rearrangement of BYTES,
    // and the command's answer is not one of them. Three of the twelve ways out, each run at a
    // beside width and at a piped one, compared as whole objects.
    for (const [label, options] of Object.entries({
      'a folder launch': {},
      'an empty queue': { queue: 0 },
      'a session that already exists': { sessionExists: true },
    })) {
      const wide = await outcomeOf(deps({ ...options, isTTY: true, columns: 120 }))
      const piped = await outcomeOf(deps({ ...options, columns: 120 }))
      expect(wide, label).toEqual(piped)
    }
  })
})

describe('QA the arrangement — Ctrl-C in the middle of a taller picture (#161)', () => {
  /** A run whose injected clock trips the SIGINT handler after the second frame's nap. */
  const interruptedRun = ({ columns }) => {
    const d = deps({ isTTY: true, columns })
    const naps = d.naps
    d.sleep = async (ms) => {
      naps.push(ms)
      if (naps.length === 2) d.signals.interrupt()
    }
    return d
  }

  it('restores the cursor once and strands no half-drawn box', async () => {
    const owed = await expectedBanner({ mode: 'full', isTTY: true, color: true, columns: 120 })
    expect(owed.arrangement).toBe('beside')
    const d = interruptedRun({ columns: 120 })
    const result = await startCommand(d)
    const output = d.stdout.output()

    // ONE HIDE, ONE SHOW. The handler stands down and the `finally` stands down again, and
    // `standing` is what makes the second one a no-op — a restore written twice would put a
    // stray DECTCEM in front of a frame, which is the one byte the player's header forbids
    // there.
    expect(occurrences(output, HIDE)).toBe(1)
    expect(occurrences(output, SHOW)).toBe(1)

    // THE HANDLER IS OFF and the signal went back, which is what keeps `^C` meaning `^C` for
    // the hours of loop that follow the banner.
    expect(d.signals.handlers).toEqual([])
    expect(d.signals.ops).toEqual(['on SIGINT', 'off SIGINT', 'kill 4242 SIGINT'])

    // ...AND THE BOX IS WHOLE. The interrupt restores the cursor and re-raises; it does not
    // stop the loop, so every frame still lands — each carrying a top rule and a bottom rule.
    // A count that agreed at the top and not at the bottom would be a scrollback ending in a
    // box with three sides, which is exactly what a mid-animation abort could produce.
    for (const line of owed.boxLines) {
      expect(occurrences(output, line), JSON.stringify(line)).toBe(owed.boxWrites)
    }
    // ...and the whole animation is still the bytes the uninterrupted player writes, with the
    // one restore moved from before the settled frame to wherever Ctrl-C landed. Asserted by
    // removing that byte from both sides: everything else is identical.
    expect(output.startsWith(owed.block.replace(SHOW, ''))).toBe(false)
    expect(output.split(SHOW).join('').startsWith(owed.block.split(SHOW).join(''))).toBe(true)
    // The restore really did move — it is not where the settled frame would have put it.
    expect(output.indexOf(SHOW)).toBeLessThan(owed.block.indexOf(SHOW))
    expect(result.started).toBe(true)
  })

  it('leaves the terminal holding a frame, with no cursor move after it', async () => {
    // Criterion 3 of #73, and the reason it is re-driven here: the last thing the animation
    // writes is art, so the box's `╭─` is never glued to a control byte. With the box INSIDE
    // the frames there is no separate box write to inspect, so the claim is made about the
    // splash's own chunks — the last of them is a frame, and no move follows it.
    const owed = await expectedBanner({ mode: 'full', isTTY: true, color: true, columns: 120 })
    const d = interruptedRun({ columns: 120 })
    await startCommand(d)
    // Where the splash ends, counted rather than searched for: the player writes a FIXED number
    // of chunks for a given frame list, and an interrupt does not change that number — it only
    // moves the restore from before the settled frame to wherever Ctrl-C landed. Asked of the
    // player, so a boundary found by looking for the run's first word cannot drift.
    const splashChunks = d.stdout.chunks.slice(0, owed.chunkCount)
    const last = splashChunks[splashChunks.length - 1]
    expect(owed.chunkCount).toBe(11)
    expect(last, 'the final splash write is a frame').toContain('╭─ ralph')
    expect(last).not.toMatch(CURSOR_UP)
    expect(last).not.toContain(`${ESC}[?25`)
    // ...and every cursor move undoes exactly the rows written SINCE THE PREVIOUS MOVE, which is
    // the property #161 stressed by making the frames taller than the sprite. Accumulated rather
    // than read off the preceding chunk, and that distinction is the interrupt's doing: Ctrl-C
    // puts a zero-row restore byte between a frame and the move that undoes it, so a move
    // compared against "the last chunk" would be compared against `ESC[?25h` and read as 0.
    let pending = 0
    let moves = 0
    for (const [index, chunk] of splashChunks.entries()) {
      const move = CURSOR_UP.exec(chunk)
      if (!move) {
        pending += chunk.split('\n').length - 1
        continue
      }
      expect(chunk, `chunk ${index} is a bare move`).toBe(move[0])
      expect(Number(move[1]), `chunk ${index}`).toBe(pending)
      pending = 0
      moves += 1
    }
    // Four moves for five frames — the trailing one is the write that would erase the result.
    expect(moves).toBe(4)
    expect(pending).toBe(17)
  })
})

describe('QA the arrangement — a stream that dies mid-splash costs the picture only (#161)', () => {
  it('still launches, and still answers exactly as an unbroken run does', async () => {
    // `playBannerSplash` swallows the rejection, so the RUN is the claim: a terminal that stops
    // accepting the animation's escapes must not turn `ralph start | head` into a crash with no
    // exit code of its own.
    const broken = await outcomeOf(deps({ isTTY: true, columns: 120, refuseSplash: true }))
    const whole = await outcomeOf(deps({ isTTY: true, columns: 120 }))
    expect(broken).toEqual(whole)
    const d = deps({ isTTY: true, columns: 120, refuseSplash: true })
    await startCommand(d)
    // The rest of the run is intact: every word after the banner still reached the stream.
    expect(d.stdout.output()).toContain('tmux attach')
  })

  it('loses the identity box entirely, which stacking never did — pinned, not endorsed', async () => {
    // THE ONE BEHAVIOURAL REGRESSION OF #161, recorded here because it is a trade the
    // implementation makes deliberately (see `playBannerSplash`'s catch, which says so) and
    // because nothing else in the suite states its cost.
    //
    // Where the box is GLUED IN, it is written by the animation and by nothing else: `beside` is
    // resolved before the play and the `!beside` fallback is therefore false, so a stream that
    // refuses the animation's first byte loses the version, the directory, the agent and the
    // task source along with the cartoon. Before this issue the same stream printed all of them,
    // because the box was a separate write that never touched an escape.
    //
    // Asserted rather than argued: the wide TTY run keeps NO box row, and the narrow one — one
    // column under the rung, same broken stream — keeps every row.
    const wide = deps({ isTTY: true, columns: 120, refuseSplash: true })
    await startCommand(wide)
    expect(wide.stdout.output()).not.toMatch(/[╭╮╰╯]/)
    expect(wide.stdout.output()).not.toContain(VERSION)

    const narrow = deps({ isTTY: true, columns: 71, refuseSplash: true })
    await startCommand(narrow)
    for (const line of boxAt(71, { color: true })) {
      expect(narrow.stdout.output(), JSON.stringify(line)).toContain(line)
    }
  })
})

describe('QA the arrangement — ralph doctor draws the box it always drew (#161)', () => {
  const runDoctor = async ({ columns }) => {
    const stdout = makeStream()
    stdout.columns = columns
    const stderr = makeStream()
    const result = await doctorCommand({
      stdout,
      stderr,
      hasCommand: () => true,
      platform: 'mac',
      env: {},
      currentVersion: VERSION,
      cacheFs: new Volume(),
      home: HOME,
      cwd: REPO,
      color: true,
      exists: () => true,
      readFile: () => 'TASK_SOURCE=folder\n',
    })
    return { result, lines: stdout.output().split('\n') }
  }

  it('keeps its box 60 columns wide in column 0 at every width beside would have claimed', async () => {
    // The command that has no sprite must not learn the arrangement. On a 10,000-column terminal
    // `bannerLayout` now answers `beside: true` and offers a `besideWidth`, and a doctor that had
    // picked either up would print its diagnostic 28 columns in — in a paste that people put in
    // bug reports, under a picture that is not there.
    for (const columns of [120, 200, 10_000]) {
      expect(bannerLayout(columns).beside, `width ${columns}`).toBe(true)
      const { result, lines } = await runDoctor({ columns })
      expect(result.exitCode, `width ${columns}`).toBe(0)
      const box = lines.filter((line) => /^[╭│╰]/.test(line))
      expect(box.length, `width ${columns}`).toBeGreaterThan(3)
      for (const line of box) {
        expect(codePoints(line), `width ${columns}`).toBe(BANNER_WIDTH)
      }
      expect(box[0].startsWith(`╭─ ralph ${VERSION}`), `width ${columns}`).toBe(true)
      // No row of the diagnostic is indented into a margin the picture would have left.
      const indented = lines.filter((line) => line.startsWith('  ') && /[╭│╰╮╯]/.test(line))
      expect(indented, `width ${columns}`).toEqual([])
    }
    // ...and the widest terminal's box is the same box as the narrowest one past the target,
    // which is the strongest form of "the new fields are inert here".
    const wide = await runDoctor({ columns: 10_000 })
    const target = await runDoctor({ columns: 60 })
    expect(wide.lines.filter((line) => /^[╭│╰]/.test(line))).toEqual(
      target.lines.filter((line) => /^[╭│╰]/.test(line)),
    )
  })
})
