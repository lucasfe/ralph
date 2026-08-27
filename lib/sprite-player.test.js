// #73 — the splash player, pinned as a byte sequence.
//
// lib/sprite-render.js turns data into strings and lib/sprite-banner.js decides whether
// we may draw at all; both are PURE, asserted by a static read of their own sources.
// Somebody still has to write to a terminal and wait, and this is the module that does.
// The whole point of that split is that the waiting and the writing arrive as
// ARGUMENTS — an injected `sleep` and an injected `stream` — so the animation is a data
// structure this file compares byte for byte, in microseconds, with no timer and no
// terminal anywhere near it.
//
// ESCAPES ARE SPELLED OUT HERE and never imported from the module under test, the same
// rule sprite-banner.qa.test.js states for the same reason: an expectation built out of
// the implementation's own constants agrees with a typo in them.
//
// FRAMES ARE FAKE HERE. `a0/a1/a2` beats seventeen rows of coloured half blocks for
// almost every claim below, because the sequence, the cursor arithmetic and the
// interleaving treat a frame as an OPAQUE BLOCK OF LINES — and a spec that pinned the
// placeholder art would have to be rewritten the day real art lands. The three tests
// that use the committed sprite are the three whose claim is about the committed sprite:
// that the move is its RENDERED height, that the splash settles on exactly the still #67
// prints, and that one frame of it is byte-for-byte what #67 shipped.

import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { renderSplashFrames, renderStaticBanner } from './sprite-banner.js'
import { spriteHeight } from './sprite-data.js'
import {
  SPLASH_FRAME_COUNT,
  SPLASH_MAX_FRAMES,
  playSplash,
  splashSequence,
} from './sprite-player.js'

const HIDE = '\u001B[?25l'
const SHOW = '\u001B[?25h'
const up = (rows) => `\u001B[${rows}A`
const CURSOR_UP = /^\u001B\[\d+A$/

/** A frame of `rows` opaque lines, named so a recorded chunk says which frame it is. */
const frameOf = (name, rows = 3, delayMs = 200) => ({
  lines: Array.from({ length: rows }, (_, index) => `${name}${index}`),
  delayMs,
})

/** The bytes one frame is written as: its lines, each newline-terminated. */
const blockOf = (frame) => frame.lines.map((line) => `${line}\n`).join('')

const A = frameOf('a')
const B = frameOf('b')

// A stream that remembers instead of painting, and a sleep that remembers instead of
// waiting. `signals: null` is the harness default so no test registers a handler on the
// real process unless its subject is the handler — see the interrupt block below.
function harness({ frames = [A, B], ...options } = {}) {
  const chunks = []
  const naps = []
  const stream = {
    write: (chunk) => {
      chunks.push(chunk)
      return true
    },
  }
  // Every nap records HOW MANY chunks had been written when it started, which is how the
  // interleaving is asserted without a clock: a frame written while a sleep was
  // outstanding would show up as two naps with the same count.
  const sleep = async (ms) => {
    naps.push({ ms, written: chunks.length })
  }
  return {
    chunks,
    naps,
    stream,
    sleep,
    delays: () => naps.map((nap) => nap.ms),
    output: () => chunks.join(''),
    play: (extra = {}) =>
      playSplash({ frames, stream, sleep, signals: null, ...options, ...extra }),
  }
}

describe('playSplash — the sequence, byte for byte', () => {
  it('writes hide, five frames, four cursor-ups and one restore, in this exact order', async () => {
    // The headline claim of the issue, and the reason the stream is injected at all.
    // Read it as the shape rather than as eleven strings: the loop body is uniform —
    // write a frame, sleep, move back up — and the only thing dropped on the last pass
    // is the CURSOR MOVEMENT, which is what leaves the terminal holding a still.
    const h = harness()
    await h.play()
    expect(h.chunks).toEqual([
      HIDE,
      blockOf(A),
      up(3),
      blockOf(B),
      up(3),
      blockOf(A),
      up(3),
      blockOf(B),
      up(3),
      // The restore comes BEFORE the frame it settles on, deliberately: the last frame
      // is a plain append and the next thing anybody writes (#68's box) must start at
      // column zero with no control byte glued to it.
      SHOW,
      blockOf(A),
    ])
  })

  it('sleeps once per frame, for that frame’s own delay, after writing it', async () => {
    const h = harness({ frames: [frameOf('a', 3, 200), frameOf('b', 3, 120)] })
    await h.play()
    // Five naps for five frames — including the last one, which is the settle beat the
    // advertised one-second splash is made of (5 x 200ms). The delays come from the
    // FRAMES, so a regenerated sprite with different timings animates at those.
    expect(h.delays()).toEqual([200, 120, 200, 120, 200])
    // ...and each nap started right after the write it belongs to: hide+frame, then two
    // chunks per pass, then the restore before the final frame.
    expect(h.naps.map((nap) => nap.written)).toEqual([2, 4, 6, 8, 11])
  })

  it('falls back to a usable delay for a frame that names none', async () => {
    // A frame is data, and a hand-built or regenerated one may carry no `delayMs` at
    // all. A splash that slept `undefined` would resolve on the next tick and flicker
    // through five frames in a millisecond.
    for (const delayMs of [undefined, null, 'fast', Number.NaN, -1, Infinity, {}]) {
      const h = harness({ frames: [{ lines: ['a0'], delayMs }] })
      await h.play()
      expect(new Set(h.delays()), JSON.stringify(delayMs) ?? String(delayMs)).toEqual(
        new Set([200]),
      )
    }
    // Zero IS a usable delay — a caller asking for no pause gets none.
    const instant = harness({ frames: [{ lines: ['a0'], delayMs: 0 }] })
    await instant.play()
    expect(instant.delays()).toEqual([0, 0, 0, 0, 0])
  })

  it('moves up by the height of the frame it just wrote, never by a constant', async () => {
    for (const rows of [1, 2, 17, 40]) {
      const h = harness({ frames: [frameOf('a', rows), frameOf('b', rows)] })
      await h.play()
      expect(h.chunks.filter((chunk) => CURSOR_UP.test(chunk)), String(rows)).toEqual(
        Array.from({ length: 4 }, () => up(rows)),
      )
    }

    // ...and frames of DIFFERENT heights each move by their own, which is the property
    // that keeps a regenerated asset from tearing: the move undoes the write before it,
    // so it cannot be a number this module knows.
    const short = frameOf('a', 2)
    const tall = frameOf('b', 5)
    const mixed = harness({ frames: [short, tall] })
    await mixed.play()
    expect(mixed.chunks).toEqual([
      HIDE,
      blockOf(short),
      up(2),
      blockOf(tall),
      up(5),
      blockOf(short),
      up(2),
      blockOf(tall),
      up(5),
      SHOW,
      blockOf(short),
    ])
  })

  it('moves over the rows it WROTE, not the lines it was handed', async () => {
    // The move is counted off the chunk that went out, so it undoes what the terminal
    // received rather than what the caller's array happened to be shaped like. Nothing in
    // Ralph renders a line with a newline inside it — the point is that it could not
    // desync the animation if it did, because there is only one place the height can come
    // from and it is the bytes.
    const folded = { lines: ['one', 'two\nthree'], delayMs: 1 }
    const h = harness({ frames: [folded, B] })
    await h.play()
    expect(h.chunks[1]).toBe('one\ntwo\nthree\n')
    expect(h.chunks[2]).toBe(up(3))
    expect(h.chunks[2]).not.toBe(up(folded.lines.length))
  })

  it('ends on a written frame, with nothing at all after it', async () => {
    // "Scrollback shows exactly one sprite": the terminal is left holding the last frame
    // and the cursor sits on the line under it, so the box lands where the animation
    // stopped and a scroll back through the log finds one still — not five.
    const h = harness()
    await h.play()
    expect(h.chunks.at(-1)).toBe(blockOf(A))
    const settled = h.output().lastIndexOf(blockOf(A))
    expect(h.output().slice(settled)).toBe(blockOf(A))
    // Exactly four moves for five frames, and none of them after the last one.
    expect(h.chunks.filter((chunk) => CURSOR_UP.test(chunk))).toHaveLength(4)
  })

  it('hides the cursor for the redraws and restores it before the frame it settles on', async () => {
    const h = harness()
    await h.play()
    const out = h.output()
    expect(out.startsWith(HIDE)).toBe(true)
    // Exactly one of each: a splash that hid twice would leave the cursor hidden for the
    // rest of the run if only one restore ever landed.
    expect(out.split(HIDE)).toHaveLength(2)
    expect(out.split(SHOW)).toHaveLength(2)
    // The restore sits between the last move and the last frame.
    expect(out.indexOf(SHOW)).toBeGreaterThan(out.lastIndexOf(up(3)))
    expect(out.indexOf(SHOW)).toBeLessThan(out.lastIndexOf(blockOf(A)))
  })

  it('writes no cursor control at all for a single frame', async () => {
    // Nothing is redrawn in place, so there is nothing to hide the cursor for. The
    // degenerate splash is exactly one frame appended to the terminal — which is also
    // what makes it byte-for-byte #67's static banner (see the block below).
    const h = harness({ cycles: 1 })
    await h.play()
    expect(h.chunks).toEqual([blockOf(A)])
    expect(h.output()).not.toContain('\u001B')
    expect(h.delays()).toEqual([200])
  })
})

describe('playSplash — bounded by construction', () => {
  it('plays exactly as many frames as the cycle count asks for', async () => {
    for (const cycles of [1, 2, 3, 5, 8]) {
      const h = harness({ cycles })
      await h.play()
      expect(h.delays(), String(cycles)).toHaveLength(cycles)
      expect(splashSequence([A, B], cycles), String(cycles)).toHaveLength(cycles)
    }
    expect(SPLASH_FRAME_COUNT).toBe(5)
  })

  it('refuses every cycle count that is not a whole number of frames', async () => {
    // The one criterion that is about the ABSENCE of a hang: the duration is a fixed
    // frame count decided before the first write, so the values that would turn a loop
    // into a screensaver — Infinity above all — are not counts at all and fall back to
    // the default rather than throwing or spinning.
    for (const cycles of [Infinity, -Infinity, Number.NaN, -1, 2.5, '5', null, true, {}, 1e21]) {
      expect(splashSequence([A, B], cycles), String(cycles)).toHaveLength(SPLASH_FRAME_COUNT)
    }
    // ...and an omitted one is the default, which is what `ralph start` runs on.
    expect(splashSequence([A, B])).toHaveLength(SPLASH_FRAME_COUNT)
  })

  it('refuses a count no terminal session could sit through, before allocating it', async () => {
    // The sharper half of "bounded by construction", and a real defect until QA said so: a
    // FIXED ARRAY is a shape, and an array whose length the CALLER chooses is bounded by
    // nothing. `Number.MAX_SAFE_INTEGER` is a safe integer, so it satisfied every guard
    // the count had, and the splash it asked for was nine quadrillion frames pushed
    // synchronously before the first byte went out — a hung `ralph start` with an empty
    // terminal. That these three assertions return at all is the assertion: the count is
    // refused BEFORE the array exists.
    for (const cycles of [SPLASH_MAX_FRAMES + 1, 1e6, Number.MAX_SAFE_INTEGER]) {
      expect(splashSequence([A, B], cycles), String(cycles)).toHaveLength(SPLASH_FRAME_COUNT)
    }
    // The ceiling itself is honoured, so this is a limit and not a suspicion of large
    // numbers — and it sits far above anything a banner mode will ever ask for (#74).
    expect(splashSequence([A, B], SPLASH_MAX_FRAMES)).toHaveLength(SPLASH_MAX_FRAMES)
    expect(SPLASH_MAX_FRAMES).toBeGreaterThan(SPLASH_FRAME_COUNT)
  })

  it('settles on the first frame it was given, whatever the count divides into', () => {
    // Five frames over two lands on frame 0 by parity; three frames would land on frame
    // 1 — a mid-blink — so the still is placed LAST by construction instead. That is the
    // difference between a property and a coincidence, and it is what makes the splash
    // safe to regenerate the art under.
    const [a, b, c] = [frameOf('a'), frameOf('b'), frameOf('c')]
    for (const cycles of [1, 2, 3, 4, 5, 6, 7]) {
      expect(splashSequence([a, b], cycles).at(-1), `two frames, ${cycles}`).toBe(a)
      expect(splashSequence([a, b, c], cycles).at(-1), `three frames, ${cycles}`).toBe(a)
    }
    // The default over the committed asset: a, b, a, b, a.
    expect(splashSequence([a, b], SPLASH_FRAME_COUNT)).toEqual([a, b, a, b, a])
  })

  it('writes nothing, and sleeps not at all, when there is no frame to draw', async () => {
    // The gate lives in lib/sprite-banner.js and answers `[]` on a pipe, under NO_COLOR
    // and below twenty-six columns. This is where that becomes silence: not a lone
    // reset, not a hidden cursor, not one byte in a log file.
    // Passed through `play` rather than to the harness, so that `undefined` reaches the
    // player as `undefined` instead of tripping the harness's own default.
    for (const frames of [[], undefined, null, 'nope', 7, [{}], [{ lines: [] }], [{ lines: 'no' }]]) {
      const h = harness()
      await h.play({ frames })
      expect(h.chunks, JSON.stringify(frames) ?? String(frames)).toEqual([])
      expect(h.naps, JSON.stringify(frames) ?? String(frames)).toEqual([])
    }

    // ...and a cycle count of zero, which is a caller asking for silence in so many words.
    const zero = harness({ cycles: 0 })
    await zero.play()
    expect(zero.chunks).toEqual([])
    expect(zero.naps).toEqual([])
  })

  it('skips the frames it cannot draw and animates the ones it can', async () => {
    // Half a usable asset is still an asset. A frame with no lines cannot be written and
    // must not be counted either — moving up by zero rows is `ESC[0A`, which most
    // terminals read as one row, so a blank frame in the sequence would walk the cursor
    // up through the scrollback one line at a time.
    const h = harness({ frames: [A, { lines: [] }, B] })
    await h.play()
    expect(h.chunks).toEqual([
      HIDE,
      blockOf(A),
      up(3),
      blockOf(B),
      up(3),
      blockOf(A),
      up(3),
      blockOf(B),
      up(3),
      SHOW,
      blockOf(A),
    ])
  })

  it('drops a frame whose lines are not all there, rather than drawing it torn', async () => {
    // A hole is not a shorter frame. `map` SKIPS holes, so three slots wrote two rows and
    // then asked the terminal to walk up three — one line of the previous run's output
    // eaten per redraw. Drawing sixteen of Ralph's seventeen rows would be the torn art
    // #72 refuses anyway, so the frame is refused whole, exactly as `{ lines: [] }` is.
    // The holes are BUILT rather than written as `[a, , b]`, so nothing here depends on
    // how a reader (or a formatter) treats an elided element.
    const holed = () => {
      const lines = ['top', 'middle', 'bottom']
      delete lines[1]
      return { lines, delayMs: 1 }
    }
    const h = harness({ frames: [holed(), B] })
    await h.play()
    // Only B survives the filter, so the splash is five B's — with no empty chunk and no
    // move that outruns its write anywhere in it.
    expect(h.chunks).toEqual([
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

    // ...and a frame that is nothing but holes is silence, not a naked cursor move: the
    // sparse array a caller gets from `new Array(n)` is the likeliest way to reach here.
    const empty = harness()
    await empty.play({ frames: [{ lines: new Array(Math.ceil(spriteHeight / 2)) }] })
    expect(empty.chunks).toEqual([])
    expect(empty.naps).toEqual([])
  })

  it('writes nothing when there is no stream to write to', async () => {
    // Total, like every other banner path: a caller that forgot the stream gets silence
    // rather than a TypeError on the first line of a run.
    for (const stream of [undefined, null, {}, { write: 'not a function' }]) {
      const naps = []
      await expect(
        playSplash({
          frames: [A, B],
          stream,
          sleep: async (ms) => naps.push(ms),
          signals: null,
        }),
      ).resolves.toBeUndefined()
      expect(naps, JSON.stringify(stream) ?? String(stream)).toEqual([])
    }
  })

  it('holds no loop a clock could keep alive, and writes to no stream of its own', () => {
    // Absence, demonstrated the way the pure modules demonstrate theirs (a static read),
    // because "it cannot hang a start" is not a claim a happy path can make. No `while`,
    // no clock arithmetic, no interval — the bound is the length of an array built
    // before the first byte goes out.
    const code = codeWithoutComments(new URL('./sprite-player.js', import.meta.url))
    expect(code).not.toMatch(/\bwhile\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/setInterval/)
    expect(code).not.toMatch(/\bfor\s*\(\s*;/)
    // The ONE ambient thing this module may touch is the signal source's default, and it
    // is a default rather than a read: everything else — the stream, the sleep, the
    // re-raise — arrives as an argument (#41).
    expect(code.match(/\bprocess\b/g) ?? []).toHaveLength(1)
    expect(code).not.toMatch(/process\s*\.\s*(stdout|stderr|env)/)
  })
})

describe('playSplash — the committed sprite', () => {
  const real = () => renderSplashFrames({ isTTY: true, color: true })

  it('moves by the sprite’s RENDERED height, not its pixel height', async () => {
    // Two pixel rows per text row (lib/sprite-render.js), so a 34-pixel sprite is 17
    // lines and 34 is the number that would walk the cursor into the scrollback.
    const rendered = Math.ceil(spriteHeight / 2)
    expect(rendered).toBe(17)
    const h = harness({ frames: real() })
    await h.play()
    expect(h.chunks.filter((chunk) => CURSOR_UP.test(chunk))).toEqual(
      Array.from({ length: 4 }, () => up(rendered)),
    )
    expect(h.output()).not.toContain(up(spriteHeight))
  })

  it('settles on the still frame the static banner prints', async () => {
    // The property worth having: whatever the animation did, what is LEFT on the screen
    // is the same seventeen rows a suppressed-animation run would have printed — so #74
    // switching the splash off changes the motion and not the picture.
    const h = harness({ frames: real() })
    await h.play()
    const still = renderStaticBanner({ isTTY: true, color: true })
    expect(h.chunks.at(-1)).toBe(still.map((line) => `${line}\n`).join(''))
  })

  it('draws one cycle as exactly the bytes #67 shipped', async () => {
    // The compatibility statement, and #74's static mode in advance: one frame, no
    // cursor control, and the same byte stream seventeen `out()` calls produced.
    const h = harness({ frames: real(), cycles: 1 })
    await h.play()
    expect(h.output()).toBe(
      renderStaticBanner({ isTTY: true, color: true })
        .map((line) => `${line}\n`)
        .join(''),
    )
  })

  it('sleeps for real when no sleep is injected, which is what a start runs on', async () => {
    // The DEFAULT wiring, so `sleep` cannot be plumbed to nothing: two frames of 5ms
    // rather than five of 200, because the claim is that the default is a TIMER and not
    // that a suite may take a second to say so.
    const chunks = []
    const started = process.hrtime.bigint()
    await playSplash({
      frames: [frameOf('a', 1, 5), frameOf('b', 1, 5)],
      cycles: 2,
      stream: { write: (chunk) => chunks.push(chunk) },
      signals: null,
    })
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    expect(elapsedMs).toBeGreaterThanOrEqual(5)
    // Two frames animated is five writes: hide, frame, up, restore, frame.
    expect(chunks).toHaveLength(5)
  })
})

describe('playSplash — the interrupt', () => {
  // A signal source that records rather than signals. `kill` is what the default
  // re-raise reaches for, so a fake source without one neuters the re-raise by
  // construction — which is precisely why the re-raise is derived from the source
  // instead of being a second injection nobody remembers to stub.
  function fakeSignals({ pid = 4242, kill = true } = {}) {
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
      off: (name, fn) => {
        ops.push(`off ${name}`)
        const index = listeners.findIndex((listener) => listener.fn === fn)
        if (index >= 0) listeners.splice(index, 1)
      },
      interrupt: () => listeners.filter((l) => l.name === 'SIGINT').forEach((l) => l.fn('SIGINT')),
    }
    if (kill) source.kill = (target, signal) => ops.push(`kill ${target} ${signal}`)
    return source
  }

  it('registers exactly one SIGINT listener and takes it away again', async () => {
    // A leaked handler on a long-running `ralph start` is its own bug: the loop lives in
    // tmux for hours after the splash, and a stale listener would suppress Node's own
    // SIGINT disposition for all of it.
    const signals = fakeSignals()
    const h = harness({ signals })
    await h.play()
    expect(signals.ops).toEqual(['on SIGINT', 'off SIGINT'])
    expect(signals.listeners).toEqual([])
  })

  it('stands down before the last frame, so the rest of the run is Node’s again', async () => {
    // The listener exists to restore the cursor. Once it has been restored there is
    // nothing left to clean up, so the handler leaves rather than lingering over the
    // final frame and its settle beat.
    const signals = fakeSignals()
    const h = harness({ signals })
    await h.play()
    // Second to last, with the settled frame after it — stated as a position from the END
    // rather than as an index, because what matters is what the restore is next to.
    expect(h.chunks.at(-2)).toBe(SHOW)
    expect(h.chunks.at(-1)).toBe(blockOf(A))
    expect(signals.ops).toEqual(['on SIGINT', 'off SIGINT'])
  })

  it('restores the cursor, stands down and re-raises when SIGINT lands mid-splash', async () => {
    // Ctrl-C during the first nap. Three things have to happen in this order: the cursor
    // comes back while the process is still alive to accept the escape, the listener is
    // removed so Node's DEFAULT disposition applies again, and only then is the signal
    // re-raised — which is what keeps `ralph start`'s exit code the 130 it always was.
    // A handler that stayed registered would swallow the Ctrl-C and leave the run going.
    const signals = fakeSignals()
    const h = harness({ signals })
    const chunks = h.chunks
    await playSplash({
      frames: [A, B],
      stream: h.stream,
      signals,
      sleep: async () => {
        if (chunks.length === 2) signals.interrupt()
      },
    })
    expect(chunks[2]).toBe(SHOW)
    expect(signals.ops).toEqual(['on SIGINT', 'off SIGINT', `kill ${signals.pid} SIGINT`])
  })

  it('re-raises on the source it registered on, and lets an explicit raise win', async () => {
    // Derived from the resolved `signals`, on the same left-to-right convention
    // `startCommand` resolves `color` from `stdoutIsTTY`: the real process gets
    // `process.kill(process.pid, 'SIGINT')` — Node's own disposition, exit 130 — while a
    // test's fake source gets a no-op it cannot be killed by.
    const quiet = fakeSignals({ kill: false })
    const h = harness({ signals: quiet })
    await playSplash({
      frames: [A, B],
      stream: h.stream,
      signals: quiet,
      sleep: async () => quiet.interrupt(),
    })
    expect(quiet.ops).toEqual(['on SIGINT', 'off SIGINT'])
    expect(h.chunks).toContain(SHOW)

    const raised = []
    const signals = fakeSignals()
    await playSplash({
      frames: [A, B],
      // The bytes are the block above's business; this half is only about who gets called.
      stream: { write: () => true },
      signals,
      raise: (signal) => raised.push(signal),
      sleep: async () => signals.interrupt(),
    })
    expect(raised).toEqual(['SIGINT'])
    expect(signals.ops.filter((op) => op.startsWith('kill'))).toEqual([])
  })

  it('arms nothing on a source it could never disarm', async () => {
    // The companion to the balance test above, and the reason `listen` is read THROUGH
    // `unlisten`: a source with `on` and no `off` is one this module could never take its
    // handler off again, and `ralph start` runs for hours after its banner with that handler
    // suppressing Node's SIGINT disposition the whole time. So it does not register one.
    // Nothing is given up — with no handler in the way, a Ctrl-C during the splash reaches
    // Node's default disposition and exits 130, which is what the re-raise exists to arrange.
    const armed = []
    const h = harness({ signals: { pid: 1, on: (name, fn) => armed.push({ name, fn }) } })
    await h.play()
    expect(armed).toEqual([])
    expect(h.chunks.at(-1)).toBe(blockOf(A))
    expect(h.chunks.filter((chunk) => chunk === SHOW)).toHaveLength(1)
  })

  it('draws, and restores, with no signal source at all', async () => {
    // A caller with nothing to listen on still gets the animation and still gets its
    // cursor back — the restore is in the normal path and in a `finally`, never only in
    // the handler.
    for (const signals of [null, undefined, {}, { on: 'not a function' }]) {
      const h = harness({ signals })
      await h.play()
      expect(h.chunks.at(-1), String(signals)).toBe(blockOf(A))
      expect(h.chunks, String(signals)).toContain(SHOW)
    }
  })

  it('restores the cursor when a write throws, and does not swallow the failure', async () => {
    // `try`/`finally`, not `try`/`catch`: a stream that died mid-animation is the
    // caller's problem to report, but a hidden cursor is nobody's and would outlive the
    // process that hid it.
    const attempts = []
    const signals = fakeSignals()
    const stream = {
      write: (chunk) => {
        attempts.push(chunk)
        if (attempts.length === 3) throw new Error('EPIPE')
        return true
      },
    }
    await expect(
      playSplash({ frames: [A, B], stream, sleep: async () => {}, signals }),
    ).rejects.toThrow('EPIPE')
    expect(attempts).toEqual([HIDE, blockOf(A), up(3), SHOW])
    expect(signals.listeners).toEqual([])
  })

  it('restores the cursor when the sleep throws', async () => {
    const h = harness()
    await expect(
      h.play({
        sleep: async () => {
          throw new Error('clock stopped')
        },
      }),
    ).rejects.toThrow('clock stopped')
    expect(h.chunks).toEqual([HIDE, blockOf(A), SHOW])
  })
})
