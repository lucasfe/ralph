// #73 QA — the splash player attacked from outside the shapes it was designed for.
//
// sprite-player.test.js pins the intended sequence byte for byte: eleven writes, five
// frames, four moves, one restore before the last frame. That spec is written against
// well-formed input — dense frames, a stream that accepts every chunk, a signal source
// with both halves of an EventEmitter. This file is the same module with each of those
// assumptions taken away one at a time, because `playSplash` sits on FOUR injected seams
// (`frames`, `stream`, `sleep`, `signals`) and #74 is the issue that will start sending
// things down them that `renderSplashFrames` did not build.
//
// What is attacked, and why each is worth a test rather than a comment:
//
//   * THE CURSOR ARITHMETIC AGAINST THE BYTES. The move up is `frame.lines.length`; the
//     bytes are `frame.lines.map(...).join('')`. Those two disagree the moment the array
//     is SPARSE, because `map` skips holes where `length` counts them — and the failure
//     mode is the exact one `cursorUp`'s zero-guard was written to prevent, a cursor
//     walking up through the user's scrollback. lib/sprite-render.js refuses sparse input
//     with indexed loops for precisely this reason and says so in a comment; this file
//     asks whether the player learned the same lesson one seam further down.
//   * THE MAGNITUDE OF THE BOUND, not only its shape. "Bounded by construction" is this
//     module's headline claim. A fixed array is the right SHAPE for it, and a fixed array
//     whose length the caller chooses is not yet a bound — so the interesting count is not
//     `Infinity`, which is refused, but a large safe integer, which is not.
//   * THE STREAM AT EVERY POSITION. A write that throws is pinned upstream once, at chunk
//     three. There are eleven chunks and three of them are special (the hide, the restore,
//     the settled frame), so for this claim the sweep is the test and a sample is not.
//   * THE SIGNAL SOURCE HALF-BUILT. `on` without `off`, an `off` that throws, an `on` that
//     throws, SIGINT twice, SIGINT from inside a write, and one source reused across
//     twenty-five splashes. The leaked listener is the one bug here with a real production
//     cost: `ralph start` runs for hours after its banner, and a handler of ours still
//     registered would suppress Node's own SIGINT disposition for all of it.
//   * THE ABSENCE OF A HEIGHT GATE, stated as a fact rather than assumed. The player is
//     handed no terminal height and asks for none, so the frame's own row count is the only
//     number in the arithmetic — worth pinning, because an edit that reached for
//     `stream.rows` would be a second gate disagreeing with the one in lib/sprite-banner.js
//     that the whole feature is built around.
//
// ESCAPES ARE SPELLED OUT, never imported from the module under test — the rule
// sprite-banner.qa.test.js states, for the reason it states: an expectation built out of
// the implementation's own constants agrees with a typo in them.
//
// HERMETIC (#41): every stream, sleep and signal source below is a recorder. No test here
// registers a handler on the real `process` and none of them sleeps. The two claims about
// the DEFAULT wiring — a real timer, the real process — are upstream in
// sprite-player.test.js deliberately, so this file can be read as a table of hostile
// inputs with no ambient risk in it at all.

import { describe, expect, it, vi } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import {
  SPLASH_FRAME_COUNT,
  SPLASH_MAX_FRAMES,
  cursorUp,
  playSplash,
  splashSequence,
} from './sprite-player.js'

const HIDE = '\u001B[?25l'
const SHOW = '\u001B[?25h'
const up = (rows) => `\u001B[${rows}A`
const CURSOR_UP = /^\u001B\[(\d+)A$/

/** A frame of `rows` opaque lines, named so a recorded chunk says which frame it is. */
const frameOf = (name, rows = 3, delayMs = 200) => ({
  lines: Array.from({ length: rows }, (_, index) => `${name}${index}`),
  delayMs,
})

/** The bytes one frame is written as: its lines, each newline-terminated. */
const blockOf = (frame) => frame.lines.map((line) => `${line}\n`).join('')

const A = frameOf('a')
const B = frameOf('b')

/**
 * A `lines` array with a HOLE in it, built rather than written as a sparse literal.
 *
 * `['a0', , 'a2']` says the same thing and reads like a typo, which is the one way a
 * reader could dismiss the block below. `undefined` at the index would be a different
 * defect — a dense value `isDrawable` and `map` both see — so the hole has to be real.
 */
function linesWithHole(holeIndex, rows = 3) {
  const lines = new Array(rows)
  for (let index = 0; index < rows; index += 1) {
    if (index !== holeIndex) lines[index] = `a${index}`
  }
  return lines
}

// A stream and a sleep that remember instead of acting. `signals: null` unless a test's
// subject IS the signal source, so nothing here can reach the real process.
function harness({ frames = [A, B], ...options } = {}) {
  const chunks = []
  const naps = []
  const stream = {
    write: (chunk) => {
      chunks.push(chunk)
      return true
    },
  }
  const sleep = async (...args) => {
    naps.push(args)
  }
  return {
    chunks,
    naps,
    stream,
    output: () => chunks.join(''),
    moves: () => chunks.filter((chunk) => CURSOR_UP.test(chunk)),
    play: (extra = {}) =>
      playSplash({ frames, stream, sleep, signals: null, ...options, ...extra }),
  }
}

/**
 * How many rows a chunk actually put on the terminal.
 *
 * Counted in NEWLINES rather than taken from `lines.length`, which is the whole point of
 * the sparse-frame block below: the cursor has to come back up over the rows the TERMINAL
 * received, and what the terminal received was newlines.
 */
const rowsWritten = (chunk) => (chunk.match(/\n/g) ?? []).length

/**
 * Every (frame, move that undoes it) pair in a recording, as `{wrote, moved}`.
 *
 * Read off the recorded chunks rather than off the input frames, so it describes what the
 * terminal would have done and not what the caller intended.
 */
function redraws(chunks) {
  const pairs = []
  for (const [index, chunk] of chunks.entries()) {
    if (CURSOR_UP.test(chunk) || chunk === HIDE || chunk === SHOW) continue
    const move = CURSOR_UP.exec(chunks[index + 1] ?? '')
    if (!move) continue
    pairs.push({ wrote: rowsWritten(chunk), moved: Number(move[1]) })
  }
  return pairs
}

describe('QA playSplash — the frame list at its edges', () => {
  it('moves the cursor up only over rows it actually wrote, even for a sparse frame', async () => {
    // THE DEFECT THIS BLOCK EXISTS FOR. `cursorUp` guards a ZERO-row move because `ESC[0A`
    // is one row on most terminals — but the guard is fed `frame.lines.length`, while the
    // bytes come from `lines.map(...).join('')`, and `map` SKIPS HOLES where `length`
    // counts them. A sparse `lines` array therefore writes fewer rows than it claims, and
    // the move overshoots by exactly the number of holes, on every redraw, four times a
    // splash.
    //
    // Three shapes, each of which a caller produces without meaning to. `new Array(3)` is
    // what a generator that pre-allocated its rows and then failed halfway leaves behind;
    // the other two are what assigning rows by index with one index missed leaves behind.
    // The all-holes case is the sharp one: it writes an EMPTY chunk and then asks the
    // terminal to go up three rows, which walks the cursor into the scrollback of whatever
    // ran before `ralph start` — and the next frame is drawn over the user's shell history,
    // which is precisely the harm the zero-guard was added to prevent.
    //
    // Not reachable from `ralph start` today: `renderSprite` returns dense arrays. That is
    // not the standard this module set for itself — lib/sprite-render.js validates with
    // indexed loops SPECIFICALLY so a hole is named rather than walked past — and `frames`
    // is an injected seam, which is the thing #74 is about to start feeding.
    for (const lines of [new Array(3), linesWithHole(1), linesWithHole(2)]) {
      const h = harness({ frames: [{ lines, delayMs: 1 }, B] })
      await h.play()
      const label = `${lines.length} slots, ${rowsWritten(blockOf({ lines }))} rows written`
      // Nothing empty is ever handed to the stream: a chunk with no newline in it is a
      // redraw that drew nothing, and no cursor move can undo it.
      expect(h.chunks.filter((chunk) => chunk === ''), label).toEqual([])
      for (const { wrote, moved } of redraws(h.chunks)) {
        expect(moved, label).toBe(wrote)
      }

      // ...AND THE REPAIR THAT SHIPPED, pinned separately so this test cannot go on passing
      // for a reason nobody decided. The invariant above admits two fixes — count the rows
      // off the chunk, which makes the move right for a mutilated picture too, or refuse the
      // frame — and the one chosen was refusal: a 17-row Ralph drawn as 16 rows is not a
      // smaller Ralph. So the holed frame contributes NOTHING, and what plays is the
      // single-frame splash of the frame that survived. Spelled out rather than derived,
      // because "dropped" and "drawn short with a correct move" differ only in the bytes.
      expect(h.chunks, label).toEqual([
        HIDE,
        blockOf(B),
        up(3),
        blockOf(B),
        up(3),
        blockOf(B),
        up(3),
        blockOf(B),
        up(3),
        SHOW,
        blockOf(B),
      ])
    }
  })

  it('counts the move off the bytes, for a line that arrives with a newline inside it', async () => {
    // THE OTHER DIRECTION OF THE SAME DESYNC, and the case neither spec covered before the
    // repair: a `lines` entry containing its own newline writes MORE rows than
    // `frame.lines.length` counts, so a move taken from the array undershoots. The sparse
    // frame walked the cursor up into the previous run's scrollback; this one leaves a row
    // behind on every redraw, so the sprite creeps DOWN the terminal and the scrollback ends
    // up holding the smear the animation was supposed to draw over.
    //
    // It is the reason the fix has two layers rather than one: `isDrawable` cannot see this
    // — every slot is present and every value is a string — so refusing holes does not
    // address it, and only counting newlines in the chunk that actually went out does. Two
    // lines, three rows, a move of three.
    const nested = { lines: ['a\nb', 'c'], delayMs: 1 }
    const h = harness({ frames: [nested, B] })
    await h.play()
    expect(h.chunks[1]).toBe('a\nb\nc\n')
    expect(h.chunks[2]).toBe(up(3))
    expect(nested.lines).toHaveLength(2)
    for (const { wrote, moved } of redraws(h.chunks)) expect(moved).toBe(wrote)
  })

  it('never writes an empty chunk nor moves further than it wrote, for any line value', async () => {
    // The invariant swept rather than argued, over every shape a `lines` entry can take that
    // is not a plain row: an empty string, a string that is only a newline, several newlines
    // in a row, a carriage return, and the non-strings a hand-built or regenerated asset can
    // leak (`null`, `undefined`, an object, a zero). None of these is reachable from
    // `renderSprite`; all of them are reachable through the `frames` seam #74 will feed.
    //
    // TWO PROPERTIES, and both are about the terminal above the sprite rather than about the
    // sprite: a chunk with no newline in it is a redraw that drew nothing and no move can
    // undo it, and a move that does not match the rows written is scrollback destroyed at a
    // rate of one row per redraw.
    const values = [
      [''],
      ['', ' '],
      ['a\nb\nc'],
      ['a\n\n\nb'],
      ['\n'],
      ['x\r'],
      [null],
      [undefined],
      [{}],
      [0],
      ['a', 'b\nc', 'd'],
    ]
    for (const lines of values) {
      const h = harness({ frames: [{ lines, delayMs: 1 }, B] })
      await h.play()
      const label = JSON.stringify(lines)
      expect(h.chunks.filter((chunk) => chunk === ''), label).toEqual([])
      const pairs = redraws(h.chunks)
      expect(pairs.length, `${label}: something has to have been redrawn`).toBeGreaterThan(0)
      for (const { wrote, moved } of pairs) {
        expect(moved, label).toBe(wrote)
        expect(wrote, label).toBeGreaterThan(0)
      }
    }
  })

  it('animates a frames array with a hole in it exactly as it animates a shorter one', async () => {
    // The hole in the OUTER array, which is the benign half: `filter` skips holes and
    // `isDrawable` rejects a dense `undefined`, so the two spellings agree. Worth pinning as
    // an IDENTITY rather than trusting, because holes-versus-`undefined` is the distinction
    // lib/sprite-render.js found its own bug in.
    const holey = new Array(3)
    holey[0] = A
    holey[2] = B
    const withHole = harness({ frames: holey })
    const withUndefined = harness({ frames: [A, undefined, B] })
    const withNeither = harness({ frames: [A, B] })
    await withHole.play()
    await withUndefined.play()
    await withNeither.play()
    expect(withHole.chunks).toEqual(withNeither.chunks)
    expect(withUndefined.chunks).toEqual(withNeither.chunks)

    // ...and an array that is nothing BUT holes is the empty list, which is silence: no
    // frames, no sleep, not one byte.
    const allHoles = harness({ frames: new Array(2) })
    await allHoles.play()
    expect(allHoles.chunks).toEqual([])
    expect(allHoles.naps).toEqual([])
  })

  it('plays a single-frame asset as a full splash that settles on that frame', async () => {
    // A regenerated one-frame asset is a still redrawn over itself five times: no visible
    // motion, but the cursor bookkeeping still has to balance, because the moves are what
    // decide whether the scrollback holds one sprite or five. This is the degenerate case of
    // the property `splashSequence` states — the last slot is the poster frame — and the one
    // where settling on frame 0 is true for a boring reason while the eleven writes are not.
    const h = harness({ frames: [A] })
    await h.play()
    expect(h.chunks).toEqual([
      HIDE,
      blockOf(A),
      up(3),
      blockOf(A),
      up(3),
      blockOf(A),
      up(3),
      blockOf(A),
      up(3),
      SHOW,
      blockOf(A),
    ])
  })

  it('asks the frame how tall it is and the stream nothing at all', async () => {
    // "It knows no height" as a behaviour rather than as a comment: a frame taller than any
    // terminal is moved back over in full, with no clamp. The TRIPWIRE is the half that
    // matters — an edit reaching for `stream.rows` to clamp that move would be a second gate
    // disagreeing with lib/sprite-banner.js's, and it would read a property off an object
    // the caller supplied on the first line of a run.
    const read = []
    const chunks = []
    const stream = new Proxy(
      { write: (chunk) => chunks.push(chunk) },
      {
        get(target, property) {
          if (property !== 'write') read.push(String(property))
          return target[property]
        },
      },
    )
    await playSplash({
      frames: [frameOf('tall', 500, 1), frameOf('other', 500, 1)],
      stream,
      sleep: async () => {},
      signals: null,
    })
    expect(chunks.filter((chunk) => CURSOR_UP.test(chunk))).toEqual(Array(4).fill(up(500)))
    // Nothing but `write` was ever looked up: not rows, not columns, not isTTY.
    expect(read).toEqual([])
  })

  it('treats a frame as an opaque block, however ragged its lines are', async () => {
    // Lines of wildly different widths, one empty, one carrying its own escape: the player
    // joins and counts and clips nothing. Deliberate — the width rung belongs to
    // lib/banner-compose.js and the pixels to lib/sprite-render.js — so what is pinned here
    // is that the module in the middle develops no opinion of its own about either.
    const ragged = {
      lines: ['', 'x'.repeat(200), `\u001B[31mred\u001B[0m`, ' '],
      delayMs: 1,
    }
    const h = harness({ frames: [ragged, B] })
    await h.play()
    expect(h.chunks[1]).toBe(`\n${'x'.repeat(200)}\n\u001B[31mred\u001B[0m\n \n`)
    expect(h.chunks[2]).toBe(up(4))
    expect(h.chunks.at(-1)).toBe(blockOf(ragged))
  })
})

describe('QA playSplash — the bound, in magnitude and not only in shape', () => {
  it('refuses a frame count no terminal session could ever play', () => {
    // "THE BOUND IS STRUCTURAL... the splash must never be able to hang a start" is this
    // module's central claim, and a fixed array is the right SHAPE for it. It is not yet a
    // BOUND: `frameCount` admits EVERY safe integer, so the array's length is whatever the
    // caller said. One million frames at the asset's 200ms is fifty-five hours, and all
    // million slots are built before the first byte goes out.
    //
    // The value that makes this a hang rather than a long splash is
    // `Number.MAX_SAFE_INTEGER` — a safe integer, therefore honoured, therefore a
    // nine-quadrillion-element array that never finishes being built. IT IS DELIBERATELY
    // NOT THE VALUE ASSERTED ON: evaluating it here would wedge this worker in a
    // synchronous loop no test timeout can interrupt, which is the defect demonstrating
    // itself at the cost of the suite. One million is small enough to survive and large
    // enough to prove there is no cap at all.
    //
    // Asserted as an upper bound rather than as the default, so either repair satisfies it:
    // fall back to the default the way `Infinity` does, or clamp to a playable maximum.
    expect(splashSequence([A, B], 1_000_000).length).toBeLessThanOrEqual(1_000)
  })

  it('holds the ceiling at the value it exports, and on both sides of it', () => {
    // The repair, pinned against the CONSTANT rather than against 300 — a number written here
    // twice is a number that can disagree with itself — and pinned on both sides, because a
    // ceiling checked with the wrong comparison is off by one in silence. The last accepted
    // count builds exactly that many frames; the first refused one becomes the shipped five,
    // which is the recovery chosen for consistency with how `Infinity` and `NaN` already
    // resolve. A clamp would answer a caller's mistake with a minute of animation.
    expect(SPLASH_MAX_FRAMES).toBeGreaterThan(SPLASH_FRAME_COUNT)
    expect(splashSequence([A, B], SPLASH_MAX_FRAMES - 1).length).toBe(SPLASH_MAX_FRAMES - 1)
    expect(splashSequence([A, B], SPLASH_MAX_FRAMES).length).toBe(SPLASH_MAX_FRAMES)
    expect(splashSequence([A, B], SPLASH_MAX_FRAMES + 1).length).toBe(SPLASH_FRAME_COUNT)

    // ...and the ceiling is not bypassable by spelling the count differently. Every one of
    // these passed at least one of the guards `frameCount` had before the repair: the two
    // integers at and past the safe boundary are the hang itself, `1e21` is a float that
    // looks like a count, `'300'` is a value at the limit in the wrong type, and the negative
    // is the direction the `>= 0` check already owned. All must return promptly and small.
    for (const cycles of [1e6, Number.MAX_SAFE_INTEGER, 2 ** 53, 1e21, '300', 300.5, -300]) {
      expect(splashSequence([A, B], cycles).length, String(cycles)).toBe(SPLASH_FRAME_COUNT)
    }
  })

  it('plays a splash at the ceiling that still settles on the poster frame', () => {
    // The largest permitted animation is still an animation and not a special case: the
    // frames-equal-moves-plus-one invariant and the settle-on-the-poster-frame property have
    // to survive at the boundary too, since the boundary is the one count no asset and no
    // caller in this repo will ever exercise. Asserted on the SEQUENCE rather than by playing
    // it, so the assertion costs no writes: three hundred frames through the recorder would
    // be six hundred chunks of nothing anybody reads.
    const sequence = splashSequence([A, B], SPLASH_MAX_FRAMES)
    expect(sequence).toHaveLength(SPLASH_MAX_FRAMES)
    expect(sequence.at(-1)).toBe(A)
    expect(new Set(sequence).size).toBe(2)
  })

  it('honours zero as silence, one as a still and two as the shortest animation', async () => {
    // The three counts either side of the interesting boundary, since `animated` is
    // `sequence.length > 1` and that is what decides whether ANY cursor control is written.
    // Zero must not be read as absent (it is a caller asking for silence in so many words,
    // which is what `frameCount`'s `>= 0` makes it); one must not acquire a hide it has
    // nothing to hide from; two is the first count that redraws anything.
    const silent = harness({ cycles: 0 })
    await silent.play()
    expect(silent.chunks).toEqual([])
    expect(silent.naps).toEqual([])

    const still = harness({ cycles: 1 })
    await still.play()
    expect(still.chunks).toEqual([blockOf(A)])
    expect(still.output()).not.toContain('\u001B')

    const shortest = harness({ cycles: 2 })
    await shortest.play()
    // The off-by-one the dev's own review caught, pinned from the other side: two frames is
    // FIVE writes and not four, and the second of them is the POSTER frame rather than
    // frame B — the sequence ends on the still by construction at every count.
    expect(shortest.chunks).toEqual([HIDE, blockOf(A), up(3), SHOW, blockOf(A)])
  })

  it('never writes more frames than moves plus one, at any count', async () => {
    // The invariant behind "scrollback shows exactly one sprite", swept rather than
    // sampled: every frame but the last is undone by a move, and the last never is. A fifth
    // move at the default — or a missing one at some count nobody looked at — leaves the
    // terminal holding either a half-erased sprite or a column of them.
    for (const cycles of [1, 2, 3, 4, 5, 6, 7, 11, 40]) {
      const h = harness({ cycles })
      await h.play()
      const frames = h.chunks.filter((chunk) => chunk.endsWith('\n'))
      expect(frames, String(cycles)).toHaveLength(cycles)
      expect(h.moves(), String(cycles)).toHaveLength(cycles - 1)
      expect(h.chunks.at(-1), String(cycles)).toBe(blockOf(A))
    }
  })

  it('schedules no timer of its own when the sleep is injected', async () => {
    // The static read upstream proves the SOURCE names no interval. This proves the RUN
    // schedules nothing: with vitest holding the timers, a fully-injected splash must leave
    // the queue empty — so there is no `setTimeout` hiding behind a helper, and no handle
    // left pending that could hold a process open past its last frame.
    vi.useFakeTimers()
    try {
      const h = harness()
      await h.play()
      expect(h.chunks).toHaveLength(11)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('decides the sequence with no clock, no interval and no process', () => {
    // Purity DEMONSTRATED for the two synchronous exports, the way sprite-banner.qa.test.js
    // demonstrates its own: every ambient capability the arithmetic could reach throws for
    // the duration of one call. Kept to the synchronous half on purpose — trapping
    // `process` across an `await` traps Node's own machinery too, which would be a test
    // failing at its harness rather than at its subject.
    const realDate = globalThis.Date
    const realProcess = globalThis.process
    const realInterval = globalThis.setInterval
    const tripwire = (name) => () => {
      throw new Error(`sprite-player touched ${name}`)
    }
    let sequence
    let move
    try {
      globalThis.Date = tripwire('Date')
      globalThis.setInterval = tripwire('setInterval')
      globalThis.process = new Proxy(
        {},
        {
          get(_target, property) {
            throw new Error(`sprite-player read process.${String(property)}`)
          },
        },
      )
      sequence = splashSequence([A, B])
      move = cursorUp(17)
    } finally {
      globalThis.Date = realDate
      globalThis.setInterval = realInterval
      globalThis.process = realProcess
    }
    expect(sequence).toEqual([A, B, A, B, A])
    expect(move).toBe(up(17))
    expect(SPLASH_FRAME_COUNT).toBe(5)
  })
})

describe('QA playSplash — the stream, abused at every position', () => {
  it('is unmoved by a stream that reports backpressure or answers with nothing', async () => {
    // `write` returns false when the kernel buffer is full, which on a real terminal is
    // exactly what seventeen rows of truecolor provoke. The player must neither wait for
    // `drain` nor read it as a failure: a splash that stalled on backpressure would be a
    // start that hung on a slow pipe, which is the one thing this module promises cannot
    // happen.
    for (const answer of [false, undefined, null, 0, '']) {
      const chunks = []
      const naps = []
      const label = JSON.stringify(answer) ?? String(answer)
      await expect(
        playSplash({
          frames: [A, B],
          stream: {
            write: (chunk) => {
              chunks.push(chunk)
              return answer
            },
          },
          sleep: async (ms) => naps.push(ms),
          signals: null,
        }),
        label,
      ).resolves.toBeUndefined()
      expect(chunks, label).toHaveLength(11)
      expect(naps, label).toEqual([200, 200, 200, 200, 200])
    }
  })

  it('restores the cursor exactly once wherever in the eleven writes the stream dies', async () => {
    // Pinned upstream at chunk three. There are eleven, and three of them are not frames:
    // the hide (nothing to restore yet), the restore itself (the `finally` must not write a
    // second one), and the settled frame (`standing` is already false, so the `finally` must
    // stay quiet). A sample cannot cover a sequence whose special cases are positional.
    for (let failAt = 1; failAt <= 11; failAt += 1) {
      const attempts = []
      const ops = []
      const signals = {
        pid: 7,
        on: (name) => ops.push(`on ${name}`),
        off: (name) => ops.push(`off ${name}`),
      }
      const stream = {
        write: (chunk) => {
          attempts.push(chunk)
          if (attempts.length === failAt) throw new Error(`EPIPE at ${failAt}`)
          return true
        },
      }
      const settled = await playSplash({
        frames: [A, B],
        stream,
        sleep: async () => {},
        signals,
      }).then(
        () => 'resolved',
        (error) => error.message,
      )
      const label = `write ${failAt} of 11`
      // The cursor is always ATTEMPTED back, whether or not the stream takes it: a hidden
      // cursor outlives the process that hid it and leaves the user typing into an
      // invisible shell.
      expect(attempts, label).toContain(SHOW)
      // ...and never twice. The shape a happy-path spec cannot see is a `finally` writing a
      // second `ESC[?25h` AFTER the settled frame, which is the byte the module header
      // forbids gluing onto the box's corner.
      expect(attempts.filter((chunk) => chunk === SHOW), label).toHaveLength(1)
      // The listener comes off on all eleven failures, not just on the tidy ones.
      expect(ops, label).toEqual(['on SIGINT', 'off SIGINT'])
      // A failure at the restore itself is SWALLOWED — the stream is already gone and the
      // listener still has to come off — so that one splash completes; every other position
      // is the caller's news to report.
      expect(settled, label).toBe(failAt === 10 ? 'resolved' : `EPIPE at ${failAt}`)
    }
  })

  it('settles rather than hangs when the sleep is not a sleep, cursor already back', async () => {
    // `sleep` is the one seam resolved by a destructuring default rather than by the
    // `methodOf` duck-type the stream and the signal source get, so a caller passing `null`
    // — or a half-built bag whose timer is a string — reaches a call on a non-function. What
    // matters is not which error: it is that the promise SETTLES, that the cursor is back
    // and that the listener is gone, because `ralph start` wraps this call in a catch and
    // the picture is the only thing allowed to be lost.
    for (const sleep of [null, 'not a function', 42, {}]) {
      const h = harness()
      await expect(h.play({ sleep }), String(sleep)).rejects.toThrow(TypeError)
      expect(h.chunks, String(sleep)).toEqual([HIDE, blockOf(A), SHOW])
    }
  })

  it('awaits a sleep that answers synchronously, and hands it one argument only', async () => {
    // A `sleep` that returns a plain value rather than a promise is what a caller writes
    // when they mean "no delay at all" (`sleep: () => {}`), and `await` on a non-promise is
    // legal — so the splash must still come out in order rather than interleaved. And
    // exactly one argument goes in: a second would let a caller build a `sleep` whose
    // behaviour depended on a parameter this module never promised.
    const slow = frameOf('a', 2, 40)
    const quick = frameOf('b', 2, 60)
    const args = []
    const chunks = []
    await playSplash({
      frames: [slow, quick],
      stream: { write: (chunk) => chunks.push(chunk) },
      sleep: (...received) => args.push(received),
      signals: null,
    })
    expect(args).toEqual([[40], [60], [40], [60], [40]])
    expect(chunks).toEqual([
      HIDE,
      blockOf(slow),
      up(2),
      blockOf(quick),
      up(2),
      blockOf(slow),
      up(2),
      blockOf(quick),
      up(2),
      SHOW,
      blockOf(slow),
    ])
  })

  it('lets nothing else own the stream between a frame and the move that undoes it', async () => {
    // The interleaving hazard, written down so it cannot be discovered by surprise: the
    // cursor arithmetic assumes the player is the ONLY writer between a frame and its move.
    // A line from anybody else during the nap is a row the move does not account for, so
    // the animation walks up the terminal by one row per interloper.
    //
    // Nothing in `ralph start` writes concurrently — the splash is awaited before the box
    // and before every preflight line — so this is a property of the CALLER, which is why
    // the assertion describes the shape of the damage rather than a defence against it. If a
    // later slice ever prints from a timer, this is the test that says what it costs.
    const chunks = []
    const stream = { write: (chunk) => chunks.push(chunk) }
    await playSplash({
      frames: [A, B],
      stream,
      signals: null,
      sleep: async () => stream.write('an unrelated line\n'),
    })
    expect(chunks.filter((chunk) => CURSOR_UP.test(chunk))).toEqual(Array(4).fill(up(3)))
    const rows = chunks.reduce((total, chunk) => total + rowsWritten(chunk), 0)
    const moved = chunks
      .filter((chunk) => CURSOR_UP.test(chunk))
      .reduce((total, chunk) => total + Number(CURSOR_UP.exec(chunk)[1]), 0)
    // Three rows of settled sprite is what a clean splash leaves behind. Five interlopers
    // are five rows the moves never undid, so the terminal is left five rows lower than the
    // animation believes it is.
    expect(rows - moved).toBe(3 + 5)
  })
})

describe('QA playSplash — the signal source, half-built and used twice', () => {
  /** A source that records. `off` really removes; `kill` is what the default raise finds. */
  function fakeSignals({ pid = 4242, off = true, kill = true } = {}) {
    const ops = []
    const listeners = []
    const source = {
      pid,
      ops,
      listeners,
      on: (name, fn) => {
        ops.push(`on ${name}`)
        listeners.push({ name, fn })
      },
      interrupt: () => {
        for (const listener of [...listeners]) {
          if (listener.name === 'SIGINT') listener.fn('SIGINT')
        }
      },
    }
    if (off) {
      source.off = (name, fn) => {
        ops.push(`off ${name}`)
        const index = listeners.findIndex((listener) => listener.fn === fn)
        if (index >= 0) listeners.splice(index, 1)
      }
    }
    if (kill) source.kill = (target, signal) => ops.push(`kill ${target} ${signal}`)
    return source
  }

  it('leaks not one listener across twenty-five consecutive splashes', async () => {
    // The bug with a genuine production cost, asserted as an ACCUMULATION rather than once:
    // a handler that came off on most paths but not all would pass a single-run check and
    // still leave `ralph start` — which then runs for hours — holding a listener that
    // suppresses Node's own SIGINT disposition. Twenty-five runs on ONE source, with three
    // of the four endings mixed in (a throwing sleep, an interrupt, a static single frame),
    // and the balance has to be exactly zero after every one of them.
    const signals = fakeSignals()
    let statics = 0
    for (let run = 0; run < 25; run += 1) {
      const h = harness({ signals })
      if (run % 8 === 3) {
        await expect(
          h.play({
            sleep: async () => {
              throw new Error('clock stopped')
            },
          }),
        ).rejects.toThrow('clock stopped')
      } else if (run % 8 === 5) {
        await h.play({ sleep: async () => signals.interrupt() })
      } else if (run % 8 === 7) {
        statics += 1
        await h.play({ cycles: 1 })
      } else {
        await h.play()
      }
      expect(signals.listeners, `after run ${run}`).toEqual([])
    }
    // Registered and removed once per ANIMATED run, and never for the static ones: a
    // `cycles: 1` splash has no cursor to put back, so it has nothing to listen for either.
    expect(signals.ops.filter((op) => op === 'on SIGINT')).toHaveLength(25 - statics)
    expect(signals.ops.filter((op) => op === 'off SIGINT')).toHaveLength(25 - statics)
  })

  it('restores once however many times SIGINT lands, and arms nothing it cannot disarm', async () => {
    // Two facts that used to be one, because the second half of this test pinned a leak as
    // unavoidable and it was not.
    //
    // The bookkeeping first, unchanged: the cursor comes back EXACTLY ONCE however often the
    // handler fires, because `standing` is the guard rather than the listener's absence — a
    // second `ESC[?25h` mid-splash is a visible cursor parked on top of the art for the rest
    // of it. The handlers are kept by the test after `off` has removed them, so the second
    // volley reaches a handler the module believes it has already retired.
    const raised = []
    const chunks = []
    const handlers = []
    const listeners = []
    const signals = {
      pid: 9,
      on: (_name, fn) => {
        handlers.push(fn)
        listeners.push(fn)
      },
      off: (_name, fn) => {
        const index = listeners.indexOf(fn)
        if (index >= 0) listeners.splice(index, 1)
      },
    }
    await playSplash({
      frames: [A, B],
      stream: { write: (chunk) => chunks.push(chunk) },
      signals,
      raise: (signal) => raised.push(signal),
      sleep: async () => {
        if (chunks.length !== 2) return
        for (const fn of [...handlers, ...handlers]) fn('SIGINT')
      },
    })
    expect(chunks.filter((chunk) => chunk === SHOW)).toHaveLength(1)
    // Both interrupts are handed back, which is the safe direction: the first re-raise is
    // what terminates a real process, and a second one arriving at Node's own disposition
    // does the same thing again rather than nothing.
    expect(raised).toEqual(['SIGINT', 'SIGINT'])
    expect(listeners).toEqual([])

    // And the half that changed, which is about the REAL process and not about a fake. A
    // source offering `on` and no `off` is a source nothing could ever take the handler off
    // again, so the module no longer puts one there: `listen` is read THROUGH `unlisten`. The
    // leak this used to pin as unavoidable was the one with a genuine production cost —
    // `ralph start` runs for hours after its banner, and a stale SIGINT listener suppresses
    // Node's own disposition for all of them. Nothing is given up by refusing: with no
    // handler in the way a Ctrl-C during that splash is Node's business and exits 130 on its
    // own, which is the same answer the re-raise exists to produce.
    const orphan = []
    const solo = harness({ signals: { pid: 9, on: (_name, fn) => orphan.push(fn) } })
    await solo.play()
    expect(orphan).toEqual([])
    expect(solo.chunks).toHaveLength(11)
    expect(solo.chunks.filter((chunk) => chunk === SHOW)).toHaveLength(1)
  })

  it('re-raises when Ctrl-C lands and never on a splash that finished', async () => {
    // The re-raise is what keeps `ralph start`'s exit code the 130 it always was: the
    // handler stands down and hands the signal back to Node. Two claims worth separating —
    // it happens when the interrupt lands, and it does NOT happen otherwise, because a raise
    // on the normal path would kill a perfectly good run at the end of its own banner.
    const quiet = fakeSignals()
    const finished = harness({ signals: quiet })
    await finished.play()
    expect(quiet.ops.filter((op) => op.startsWith('kill'))).toEqual([])

    const interrupted = fakeSignals()
    const stopped = harness({ signals: interrupted })
    await stopped.play({ sleep: async () => interrupted.interrupt() })
    // One kill for the one interrupt: the handler is gone by the second nap, so the four
    // naps after it reach nothing at all.
    expect(interrupted.ops.filter((op) => op.startsWith('kill'))).toEqual([
      `kill ${interrupted.pid} SIGINT`,
    ])
  })

  it('takes an interrupt raised from inside a write, mid-frame', async () => {
    // Ctrl-C between two frames is the case upstream pins. This is the other one: the signal
    // arriving while the process is INSIDE `write`, which is where a real terminal spends
    // most of a splash — seventeen rows of truecolor is several kilobytes per frame. The
    // handler then runs RE-ENTRANTLY, so the restore is written in the middle of the frame
    // that provoked it. What must hold is the invariant rather than the position: one
    // restore, no second one from the loop or the `finally`, and the listener gone.
    const signals = fakeSignals()
    const chunks = []
    let armed = false
    const stream = {
      write: (chunk) => {
        chunks.push(chunk)
        if (!armed) return
        armed = false
        signals.interrupt()
      },
    }
    await playSplash({
      frames: [A, B],
      stream,
      signals,
      sleep: async () => {
        armed = chunks.length === 2
      },
    })
    expect(chunks.filter((chunk) => chunk === SHOW)).toHaveLength(1)
    expect(signals.listeners).toEqual([])
    expect(signals.ops).toEqual(['on SIGINT', 'off SIGINT', `kill ${signals.pid} SIGINT`])
  })

  it('writes nothing at all when the source refuses to be listened to', async () => {
    // CHARACTERISATION of an edge that is now CLOSED, kept because the closure is one line
    // and one line is exactly what a later edit undoes by accident.
    //
    // What it used to do: `standing` was initialised to `animated`, i.e. before the hide had
    // been attempted, so a source whose `on` threw took the splash down through the `finally`
    // and the ONE byte that ever reached the stream was a restore for a cursor that had never
    // been hidden. Harmless on a terminal — DECTCEM on is idempotent — and not harmless to
    // the claim the module header makes about its last byte: in `ralph start` that `ESC[?25h`
    // would land immediately in front of `╭─ ralph`, which is the exact gluing the
    // restore-before-the-last-frame ordering exists to prevent.
    //
    // What closed it: `standing` starts false and is set BETWEEN the arming and the hide, so
    // it means "there is something to put back" and nothing else. The ordering is not
    // arbitrary — arming stays first, which is what keeps the sweep above green when the HIDE
    // is the write that dies (listener off, restore attempted, because bytes may have reached
    // the wire before the throw). An `on` that throws now leaves no listener, no hide and
    // nothing to restore, so the correct output is no output.
    const chunks = []
    await expect(
      playSplash({
        frames: [A, B],
        stream: { write: (chunk) => chunks.push(chunk) },
        sleep: async () => {},
        signals: {
          on: () => {
            throw new Error('too many listeners')
          },
          off: () => {},
        },
      }),
    ).rejects.toThrow('too many listeners')
    expect(chunks).toEqual([])
  })

  it('settles anyway when the source refuses to be forgotten', async () => {
    // CHARACTERISATION of the same edge from the other side, and of a bug that turned out to
    // be worse than "the picture is wrong" once it was chased down the SIGNAL path.
    //
    // What it used to do: the `write(SHOW_CURSOR)` in `standDown` was wrapped in a `try` and
    // the `unlisten` call one line below it was not, so an `off` that threw propagated out of
    // the stand-down that runs BEFORE the last frame and the frame the animation was going to
    // settle on was never written. The splash ended on a bare restore and `ralph start` drew
    // the box over the top rows of a mid-blink frame.
    //
    // Why that was not merely cosmetic, which is the whole reason this is a repair and not a
    // pin: `standDown` is ALSO the first thing the SIGINT handler does, and a handler invoked
    // by Node's signal dispatch has no caller on the awaited stack — so the wrapper in
    // start.js cannot see the throw. Reproduced in a spawned child: it surfaced as an
    // UNCAUGHT EXCEPTION and the process exited 1, where criterion 8 promises the 130 a
    // Ctrl-C has always produced. The next test drives that path directly.
    //
    // What closed it: each cleanup gets its own `try`, because they are independent and
    // because neither `standDown` nor `onInterrupt` has a caller that can catch on every path
    // it runs on. Refusing to forget the listener now costs the listener and nothing else —
    // the splash plays out whole.
    const chunks = []
    await expect(
      playSplash({
        frames: [A, B],
        stream: { write: (chunk) => chunks.push(chunk) },
        sleep: async () => {},
        signals: {
          on: () => {},
          off: () => {
            throw new Error('cannot unlisten')
          },
        },
      }),
    ).resolves.toBeUndefined()
    expect(chunks).toHaveLength(11)
    expect(chunks.at(-1)).toBe(blockOf(A))
    expect(chunks.filter((chunk) => chunk.endsWith('\n'))).toHaveLength(5)
    expect(chunks.filter((chunk) => chunk === SHOW)).toHaveLength(1)
  })

  it('settles when the source that refuses to be forgotten also fires the interrupt', async () => {
    // The path the repair above actually exists for, driven end to end: an `off` that throws
    // AND a Ctrl-C, which is the combination where the failure had no caller above it.
    //
    // In production the handler runs from Node's signal dispatch and a throw out of it is an
    // uncaught exception — a `ralph start` that exits 1 over its own banner. A suite may not
    // send itself a real SIGINT (#41), so the hermetic proxy is to invoke the handler
    // SYNCHRONOUSLY from inside the injected sleep: the throw then travels up through
    // `playSplash`'s own frame and arrives as a rejection, which is the same defect wearing a
    // shape a test can hold. Before the repair this rejected with 'cannot unlisten'.
    const signals = fakeSignals()
    signals.off = () => {
      throw new Error('cannot unlisten')
    }
    const chunks = []
    let fired = false
    await expect(
      playSplash({
        frames: [A, B],
        stream: { write: (chunk) => chunks.push(chunk) },
        signals,
        sleep: async () => {
          if (fired) return
          fired = true
          signals.interrupt()
        },
      }),
    ).resolves.toBeUndefined()
    // The cursor comes back once, the re-raise still happens, and the splash still ends on
    // the frame it meant to settle on — everything except the listener, which this source
    // would not take back.
    expect(chunks.filter((chunk) => chunk === SHOW)).toHaveLength(1)
    expect(chunks.at(-1)).toBe(blockOf(A))
    expect(signals.ops.filter((op) => op.startsWith('kill'))).toEqual([
      `kill ${signals.pid} SIGINT`,
    ])
    expect(signals.listeners).toHaveLength(1)
  })

  it('re-raises into a kill that throws without taking the run down with it', async () => {
    // The same argument one seam further along: `raise` is called from the handler too, so a
    // `process.kill` that throws — an unknown signal, a pid that has gone — is the same
    // uncatchable crash as the `off` above, and an injected `raise` may throw for any reason
    // at all. Swallowed rather than propagated, and the stand-down before it is what makes
    // that safe: our listener is already off, so the NEXT Ctrl-C meets Node's own disposition
    // instead of being eaten by a handler that has given up.
    const signals = fakeSignals()
    signals.kill = () => {
      throw new Error('ESRCH')
    }
    const chunks = []
    let fired = false
    await expect(
      playSplash({
        frames: [A, B],
        stream: { write: (chunk) => chunks.push(chunk) },
        signals,
        sleep: async () => {
          if (fired) return
          fired = true
          signals.interrupt()
        },
      }),
    ).resolves.toBeUndefined()
    expect(chunks.filter((chunk) => chunk === SHOW)).toHaveLength(1)
    expect(chunks.at(-1)).toBe(blockOf(A))
    expect(signals.listeners).toEqual([])
  })

  it('draws and restores for every half-built source a caller can assemble', async () => {
    // `methodOf` duck-types each method SEPARATELY — the general repair the dev's own review
    // arrived at after `{ on: 'not a function' }` threw a TypeError — so every partial
    // combination has to degrade rather than throw. The animation and the restore are never
    // what is lost; only the interrupt handling is, which is the capability that was missing.
    for (const signals of [
      { on: () => {} },
      { off: () => {} },
      { on: 'nope', off: 'nope' },
      { on: null, off: null },
      { pid: 1 },
      { kill: () => {} },
      Object.create({ on: () => {}, off: () => {} }),
      new Proxy({}, { get: () => undefined }),
    ]) {
      const h = harness({ signals })
      const label = JSON.stringify(Object.keys(signals))
      await expect(h.play(), label).resolves.toBeUndefined()
      expect(h.chunks, label).toHaveLength(11)
      expect(h.chunks.at(-1), label).toBe(blockOf(A))
      expect(h.chunks.filter((chunk) => chunk === SHOW), label).toHaveLength(1)
    }
  })

  it('is the only thing in the package that listens for a signal', () => {
    // Criterion 8, as the fact that makes the re-raise WORK. The handler hands SIGINT back
    // to Node's default disposition — terminate, exit 130 — and that only holds if nothing
    // else in this package is listening at the same time: a second listener anywhere would
    // keep the disposition suppressed and turn the re-raise into a no-op, leaving
    // `ralph start` running after a Ctrl-C and exiting 0.
    //
    // A static read, because the alternative — sending a real SIGINT to a real process — is
    // not something a suite may do to its own worker (#41).
    for (const root of ['./sprite-player.js', './commands/start.js', '../bin/ralph.js']) {
      const code = codeWithoutComments(new URL(root, import.meta.url))
      expect([...code.matchAll(/\.\s*(?:on|once|addListener)\s*\(\s*['"`]SIG/g)], root).toEqual([])
    }
    // ...and the player names the signal exactly once, as a constant, so there is one
    // spelling of it to register with and to remove by.
    const player = codeWithoutComments(new URL('./sprite-player.js', import.meta.url))
    expect(player.match(/'SIGINT'/g)).toHaveLength(1)
    expect(player).not.toMatch(/process\s*\.\s*exit/)
  })
})
