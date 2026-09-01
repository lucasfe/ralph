// #161 — the box BESIDE the sprite, wired into `ralph start`.
//
// The picture is 26 columns wide and 17 rows tall. Until this issue the identity box was
// printed underneath it, so a 120-column terminal spent seventeen rows drawing a narrow
// cartoon with ninety empty columns to its right and then spent seven more rows on facts
// that would have fitted in that emptiness. #161 moves the box into it.
//
// THREE CLAIMS, and the last two are the ones that make the first one safe to ship:
//
//   1. On a wide colour TTY the box's first line is on the SAME stdout line as the sprite's
//      first line, and the box is printed ONCE — beside the picture, never again below it.
//   2. The arrangement is decided by the ladder and nothing else, at the column either side
//      of the rung: 72 columns is side by side, 71 is the stacked banner this command has
//      always drawn.
//   3. Everywhere the sprite is not drawn — a pipe, a launchd log, NO_COLOR, a narrow
//      terminal, `RALPH_BANNER=off` — the run is byte-for-byte what it was before #161. That
//      is asserted by SUBTRACTION rather than by inspection: the wide TTY run must equal the
//      joined animation plus the piped run with its box taken off the front, so a reordered
//      preflight line or a lost row cannot hide inside a "contains" assertion.
//
// The expectations are built by RUNNING the pure halves — `renderSplashFrames`, `joinBeside`,
// `composeBanner`, `playSplash` — rather than by re-deriving the bytes here. This file's
// subject is the WIRING: which function the command calls, with which width, in which order.
// What the frames look like is lib/sprite-banner.test.js's business, what the join does with
// them is lib/banner-beside.test.js's, and the sequence of cursor moves is
// lib/sprite-player.test.js's.
//
// Every capability is injected (#41), so no assertion below can be changed by the terminal
// the suite happens to run in: `isTTY` is a boolean in a bag and the column count is an
// option, never `process.stdout.columns`.

import { describe, it, expect } from 'vitest'
import { startCommand } from './start.js'
import { joinBeside } from '../banner-beside.js'
import { BESIDE_GAP, bannerLayout, composeBanner } from '../banner-compose.js'
import { spriteWidth } from '../sprite-data.js'
import { renderSplashFrames } from '../sprite-banner.js'
import { SPLASH_FRAME_COUNT, playSplash } from '../sprite-player.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'

const ESC = String.fromCharCode(27)
const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'

// The two widths this file lives between: one comfortably past the rung, one exactly on it,
// one exactly under it. Asserted against the ladder rather than assumed, so a test that
// stopped being about the case its name claims fails here instead of passing quietly.
const WIDE = 120
const RUNG = 72
const UNDER_RUNG = 71

/** Every stdout write, in order, plus the reads and execs — see `firstEffect`. */
function makeTimeline() {
  const events = []
  return {
    events,
    record: (kind, detail = '') => events.push({ kind, detail }),
    // The first event that is neither a write nor one of the three inert reads the banner is
    // made of. Same convention, and the same reasons, as start.banner.test.js: a read that
    // runs no shell and prints nothing is not something that happened TO the user, so
    // dropping those keeps this index the banner's HEIGHT in writes.
    firstEffect: () =>
      events
        .filter(
          (event) =>
            !(
              event.kind === 'readFile' &&
              ['ralph.config.sh', '/.ralph/metrics/issues.jsonl', '/.git/config'].some((tail) =>
                event.detail.endsWith(tail),
              )
            ),
        )
        .findIndex((event) => event.kind !== 'write'),
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
  // Only ever SET when a test asks for it: `Boolean(undefined)` is what a pipe answers.
  if (isTTY !== undefined) stream.isTTY = isTTY
  return stream
}

const deps = ({
  isTTY,
  queue = 3,
  config = 'TASK_SOURCE=folder\n',
  timeline = makeTimeline(),
  ...overrides
} = {}) => {
  const stdout = makeStream(timeline, { isTTY })
  const stderr = makeStream(timeline, { kind: 'stderr' })
  const exec = async (cmd, args) => {
    timeline.record('exec', `${cmd} ${args.join(' ')}`)
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
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
    // Injected for the same reason every other start spec injects them: the developer's own
    // ~/.config/ralph and the repo's CHANGELOG.md would otherwise put extra rows into every
    // exact-output assertion in this file, on their machine and nowhere else (#41).
    readCache: () => ({ ...EMPTY_VERSION_CACHE }),
    readChangelog: () => [],
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    folderQueueCount: async () => queue,
    home: HOME,
    processEnv: {},
    // The splash's two impure capabilities, neutralised: the real sleep is a 200ms timer per
    // frame and the real signal source is this process.
    sleep: async () => {},
    signals: null,
    ...overrides,
  }
}

/** The box the command composes, at the width the arrangement lays it out at. */
const boxAt = (width, { color = false } = {}) =>
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
    },
    width,
    capabilities: { color },
  })

/**
 * The writes the player makes for a list of frames — from the PLAYER, not re-derived here.
 *
 * A second copy of "hide, frame, up, frame, ..." in a wiring spec would be a second opinion
 * about what the splash is; the sequence itself is pinned byte by byte in
 * lib/sprite-player.test.js. The chunk COUNT comes back too, because the ordering claim at
 * the bottom of this file is about how many writes stand between the run's start and its
 * first real side effect.
 */
async function splashChunks(frames) {
  const chunks = []
  await playSplash({
    frames,
    stream: { write: (chunk) => chunks.push(chunk) },
    sleep: async () => {},
    signals: null,
  })
  return chunks
}

/** The animation `ralph start` must write at `columns`: the sprite, with the box glued on. */
async function besideBlock(columns) {
  const layout = bannerLayout(columns)
  const boxLines = boxAt(layout.besideWidth, { color: true })
  const frames = renderSplashFrames({ isTTY: true, color: true, width: columns }).map((frame) => ({
    ...frame,
    lines: joinBeside({ spriteLines: frame.lines, boxLines, spriteWidth }),
  }))
  const chunks = await splashChunks(frames)
  return { block: chunks.join(''), writes: chunks.length, boxLines, frames }
}

/** ...and the animation it wrote BEFORE this issue: the sprite alone, box printed after. */
const stackedBlock = async (columns) =>
  (await splashChunks(renderSplashFrames({ isTTY: true, color: true, width: columns }))).join('')

const occurrences = (haystack, needle) => haystack.split(needle).length - 1

describe('startCommand — the identity box beside the sprite (#161)', () => {
  it('starts the box on the sprite’s first line, and prints the whole animation joined', async () => {
    const { block, boxLines } = await besideBlock(WIDE)
    const d = deps({ isTTY: true, columns: WIDE })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    // The whole animation, byte for byte: five frames of joined rows, redrawn in place with
    // the cursor moves the player derives from what it wrote. Asserting the BLOCK rather
    // than the first line is what makes this a claim about the animation and not just about
    // the frame the terminal is left holding.
    expect(d.stdout.output().startsWith(block)).toBe(true)
    // ...and the arrangement, read off the settled frame in the plainest possible terms: the
    // first line is the sprite's first row, two spaces, and `╭─ ralph 1.2.3`.
    const first = d.stdout.lines()[0]
    expect(first.endsWith(`${' '.repeat(BESIDE_GAP)}${boxLines[0]}`)).toBe(true)
    expect(boxLines[0]).toContain(`ralph ${VERSION}`)
  })

  it('prints the box exactly once per frame, and never again below the sprite', async () => {
    // THE REGRESSION THIS ISSUE IS ABOUT: the box appearing in both places. Counted rather
    // than sought, because "the output contains the box" is true of the broken version too.
    // Five frames, five copies of every row of it — a sixth means the stacked print is
    // still there under the picture.
    const { block, boxLines } = await besideBlock(WIDE)
    const d = deps({ isTTY: true, columns: WIDE })
    await startCommand(d)
    const output = d.stdout.output()
    for (const line of boxLines) {
      expect(occurrences(output, line), JSON.stringify(line)).toBe(SPLASH_FRAME_COUNT)
    }
    // ...and nothing after the animation is box at all: no corner, no side, no rule.
    expect(output.slice(block.length)).not.toMatch(/[╭╮╰╯│]/)
    expect(SPLASH_FRAME_COUNT).toBe(5)
  })

  it('leaves the rows the box does not reach exactly as the sprite drew them', async () => {
    // The box is about seven rows against seventeen, so ten rows of picture have nothing to
    // their right. Those must be the sprite's own strings — not padded out to the joined
    // width, because a run's transcript should not carry ninety columns of trailing space on
    // ten lines of every start.
    const plain = await stackedBlock(WIDE)
    const spriteRows = plain.split('\n').slice(0, 17)
    const { boxLines } = await besideBlock(WIDE)
    const d = deps({ isTTY: true, columns: WIDE })
    await startCommand(d)
    const drawn = d.stdout.lines().slice(0, 17)
    expect(boxLines.length).toBeLessThan(17)
    for (const [index, row] of spriteRows.entries()) {
      if (index < boxLines.length) continue
      expect(drawn[index], `row ${index}`).toBe(row)
    }
  })

  it('sits beside at 72 columns and under at 71, and nowhere decides that itself', async () => {
    // Claim 2, at the boundary, THROUGH THE COMMAND — the ladder's own arithmetic is pinned
    // in lib/banner-compose.test.js, and what is asserted here is that `ralph start` obeys
    // it rather than holding a threshold of its own.
    expect(bannerLayout(RUNG).beside).toBe(true)
    expect(bannerLayout(UNDER_RUNG).beside).toBe(false)

    const { block, boxLines } = await besideBlock(RUNG)
    const fits = deps({ isTTY: true, columns: RUNG })
    await startCommand(fits)
    expect(fits.stdout.output().startsWith(block)).toBe(true)
    expect(fits.stdout.lines()[0].endsWith(boxLines[0])).toBe(true)

    // One column narrower there is no room for a framed box beside the picture, so the
    // banner is the one this command has always drawn: the sprite, then the box under it.
    const narrow = deps({ isTTY: true, columns: UNDER_RUNG })
    await startCommand(narrow)
    const stacked = await stackedBlock(UNDER_RUNG)
    const under = boxAt(UNDER_RUNG, { color: true })
    expect(narrow.stdout.output().startsWith(`${stacked}${under.join('\n')}\n`)).toBe(true)
    expect(narrow.stdout.lines()[0]).not.toContain('╭')
  })

  it('changes not one byte of a piped run, however wide the pipe says it is', async () => {
    // Claim 3, as a subtraction. A pipe reports no columns at all in the field, but a caller
    // CAN hand a wide count to a non-TTY stream — a `script` session, a CI runner, an
    // explicit option — and the sprite is still suppressed there, so the box must still be
    // the plain stacked block. The whole output is compared, so a preflight line that moved
    // would fail here.
    const piped = deps({ columns: WIDE })
    await startCommand(piped)
    expect(piped.stdout.output().startsWith(`${boxAt(WIDE).join('\n')}\n`)).toBe(true)
    expect(piped.stdout.output()).not.toContain(ESC)
    expect(piped.stdout.output()).not.toContain('▀')

    // ...and the wide TTY run is that same run with the joined animation in front of it and
    // its box lifted out of the body — nothing else added, moved or reworded.
    const { block } = await besideBlock(WIDE)
    const tty = deps({ isTTY: true, columns: WIDE })
    await startCommand(tty)
    const body = piped.stdout
      .output()
      .split('\n')
      .slice(boxAt(WIDE).length)
      .join('\n')
    expect(tty.stdout.output()).toBe(`${block}${body}`)
    expect(tty.stderr.output()).toBe(piped.stderr.output())
  })

  it('keeps the arrangement for RALPH_BANNER=static — one still frame, box included', async () => {
    // `static` is a choice about PLUMBING and not about pixels (#74), so it must be the same
    // picture holding for one beat rather than a different picture: one write, no cursor byte,
    // and the box in the margin exactly where the animation would have put it. Asserted on the
    // chunk rather than on the lines, because a `cycles: 1` that had picked up a cursor move
    // or split the frame per row is only visible there.
    const { frames } = await besideBlock(WIDE)
    const d = deps({
      isTTY: true,
      columns: WIDE,
      config: 'TASK_SOURCE=folder\nRALPH_BANNER=static\n',
    })
    await startCommand(d)
    expect(d.stdout.output().startsWith(`${frames[0].lines.join('\n')}\n`)).toBe(true)
    expect(d.stdout.output()).not.toContain(`${ESC}[?25`)
    expect(d.stdout.output()).not.toMatch(new RegExp(`${ESC}\\[\\d+A`))
  })

  it('prints nothing at all when the banner is off, at any width', async () => {
    // `RALPH_BANNER=off` is the one answer the mode owns outright, and a new arrangement is
    // a new way to get it wrong: a join that ran before the mode was consulted would draw
    // the box beside a sprite nobody asked for.
    for (const columns of [WIDE, RUNG, UNDER_RUNG]) {
      const off = deps({ isTTY: true, columns, config: 'TASK_SOURCE=folder\nRALPH_BANNER=off\n' })
      await startCommand(off)
      expect(off.stdout.output(), String(columns)).not.toMatch(/[╭╮╰╯│]/)
      expect(off.stdout.output(), String(columns)).not.toContain(ESC)
      expect(off.stdout.output(), String(columns)).not.toContain('▀')
    }
  })

  it('still writes the banner above everything it does to the machine', async () => {
    // #67's ordering claim, restated for the new shape: the box's facts are now gathered
    // BEFORE the first frame is drawn, and those reads are inert, so what a user sees is
    // still an animation ahead of every exec and every preflight line. The count is the
    // player's eleven writes and no more — in this arrangement the box is not written
    // separately at all, which is the same fact test two counts from the other side.
    const d = deps({ isTTY: true, columns: WIDE })
    await startCommand(d)
    const { writes } = await besideBlock(WIDE)
    expect(d.timeline.firstEffect()).toBe(writes)
    // One hide, five frames, four moves back up, one restore — and NO box write, which is
    // the same fact the second test in this file counts from the other side.
    expect(writes).toBe(11)
    expect(d.timeline.events[0]).toEqual({ kind: 'readFile', detail: `${REPO}/ralph.config.sh` })
    expect(d.timeline.events.find((event) => event.kind === 'exec').detail).toContain(
      'tmux has-session',
    )
  })
})
