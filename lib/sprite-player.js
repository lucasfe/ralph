// #73 — the splash: one second of animation, and the ONE impure piece of the banner.
//
// Everything else in this half of the codebase is a pure function. lib/sprite-data.js is
// data, lib/sprite-render.js turns it into strings, lib/sprite-banner.js decides whether
// we may draw at all — and each of those three has a static read in its own spec proving
// it touches no clock, no environment and no stream. Somebody still has to write bytes to
// a terminal and wait between them, and this is that somebody, alone in its own module so
// the impurity has a name and a boundary.
//
// IMPURE ONLY THROUGH ITS ARGUMENTS. The stream, the sleep, the signal source and the
// re-raise all arrive as options (#41). That is not ceremony: it is what makes a
// one-second animation a data structure a test compares byte for byte in microseconds,
// with no timer, no terminal and no listener on the real process. The suite for this file
// runs in single-digit milliseconds and asserts the exact eleven writes a `ralph start`
// makes.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//
//   - It does not decide whether to animate. That is the gate in sprite-banner.js, which
//     answers with an empty frame list on a pipe, under NO_COLOR and below 26 columns —
//     and an empty frame list here means not one byte written, not even a lone reset. One
//     gate, asked once, so a suppressed sprite and a suppressed splash cannot disagree.
//   - It does not read RALPH_BANNER, and it holds no notion of a `full`/`static`/`off`
//     mode. That is #74. What this module offers that issue is `cycles`: a count of 1 is
//     already, byte for byte, the unanimated banner #67 shipped — no hide, no restore, no
//     cursor movement at all — so the mode resolver has nothing to add here but a number.
//   - It does not clear the screen, use an alternate buffer, or move the cursor anywhere
//     but straight back up over its own output. `ralph start` prints a log, and a log that
//     wipes the terminal it started in has stolen the user's scrollback.
//   - It knows no height. Every cursor move is counted off the CHUNK JUST WRITTEN, so
//     regenerating the sprite at a different size cannot desync the animation from the
//     art. A hardcoded 17 here would be the bug that walks the cursor up through the
//     preflight output of the previous run — and so, as QA showed, is any height taken
//     from something other than the bytes that actually reached the stream.
//
// THE BOUND IS STRUCTURAL, which is the criterion this module exists to satisfy: the
// splash must never be able to hang a start. There is no `while`, no `Date.now()`
// comparison and no interval — `splashSequence` builds a FIXED ARRAY before the first
// byte goes out, and the loop is a `for...of` over it. sprite-player.test.js asserts that
// absence with a static read, because a happy path cannot demonstrate it.
//
// A FIXED ARRAY IS A SHAPE AND NOT YET A BOUND, which is the sharper half and was a real
// defect until QA said so: an array whose length the CALLER chooses is bounded by nothing.
// `Infinity` was refused and `Number.MAX_SAFE_INTEGER` was not, and it is a safe integer —
// so the honest answer to "can this hang a start" was a nine-quadrillion-element array
// built in a synchronous loop before the first byte. `SPLASH_MAX_FRAMES` is the missing
// magnitude, and the recovery is a FALLBACK TO THE DEFAULT rather than a clamp: every
// other unusable count (`Infinity`, `NaN`, `2.5`, `'5'`, a negative) already resolves to
// the five frames Ralph ships with, and a caller asking for a million has made a mistake
// rather than a choice. Clamping would answer that mistake with a minute of animation
// nobody wants; the fallback answers it with the banner. #74 is the caller this matters
// for — its mode resolver will derive `cycles` from a user-supplied RALPH_BANNER, and a
// typo in an environment variable must cost a splash length, never a start.
//
// THE SHAPE OF THE SEQUENCE, and why the last write is a frame:
//
//     hide, F0, up17, F1, up17, F2, up17, F3, up17, show, F4
//
// Five frames, five sleeps (5 x 200ms — the second the PRD advertises, with the last nap
// the beat the sprite holds alone before the identity box lands under it), and four moves
// back up. The trailing move is the one thing the uniform loop body drops: it is what
// would erase the animation's own result. Ending on a WRITTEN frame with the cursor parked
// on the line below it is what leaves the terminal holding a still image that scrolls back
// as exactly one sprite instead of five.
//
// THE RESTORE COMES BEFORE THE LAST FRAME, not after it, and that ordering is load-bearing
// in two ways. The plain one: nothing is redrawn after it, so the cursor has nothing left
// to hide from. The sharp one: bytes written after the settled frame are glued to the
// front of whatever the caller prints next, which in `ralph start` is `╭─ ralph 1.2.3` —
// #68's box top rule. A `\u001B[?25h` there would break every assertion that finds the box
// by its corner glyph, and would put an escape sequence inside a line #68 promises is
// plain. So the last thing this module writes is art — with one exception, and exactly
// one: when the HIDE is the write that dies, the restore is attempted anyway (bytes may
// have reached the wire before the throw), so the only byte such a splash emits is that
// lone restore, in front of whatever prints next, from an animation that never drew a
// frame at all. A deliberate trade rather than an oversight: a hidden cursor outlives the
// process that hid it, and a stream that has already thrown once was never a stream the
// corner rule was safe on. What is invariant, and what #68's box top actually depends on,
// is the narrower claim: nothing follows a frame that WAS drawn. `SHOW_CURSOR` below
// carries the counts for both paths.

/**
 * How many frames a `ralph start` splash plays. Five at the asset's 200ms is the one
 * second the PRD asks for, and it is a COUNT rather than a duration on purpose: a
 * duration would have to be checked against a clock, and a clock is a thing that can
 * fail to advance. Five writes are five writes on any machine.
 */
export const SPLASH_FRAME_COUNT = 5

/**
 * The delay a frame that names none is played at. lib/sprite-data.js gives every frame
 * its own `delayMs`, so this is the fallback for a hand-built or regenerated asset —
 * sleeping `undefined` resolves on the next tick and would flicker the whole splash past
 * in a millisecond.
 */
const SPLASH_FRAME_DELAY_MS = 200

/**
 * The most frames one splash may play. Three hundred at the asset's 200ms is a minute —
 * absurd for a splash, and deliberately so: this is not a taste limit, it is the line past
 * which a count stops being a splash at all and starts being a way to stall a `ralph start`.
 * A caller wanting a longer animation than this has a bug, not a preference.
 *
 * Exported so #74's mode resolver can say no in its own words, with the same number, rather
 * than discovering the limit by watching a count silently become five.
 *
 * WHY A CEILING AND NOT A CLAMP: see the module header. Over the line is a mistake, and the
 * recovery from a mistake is the default splash.
 */
export const SPLASH_MAX_FRAMES = 300

/**
 * DECTCEM off: hide the cursor. Written once, and only when something is redrawn.
 *
 * This one and the three around it are MODULE CONSTANTS rather than exports: no spec
 * imports them, and none should. The suites spell every escape out by hand, on the rule
 * sprite-banner.qa.test.js states — an expectation built from the implementation's own
 * constant agrees with a typo in that constant. Exporting them would offer a test the one
 * shortcut that makes it stop being a test.
 */
const HIDE_CURSOR = '\u001B[?25l'

/**
 * DECTCEM on: show the cursor. Written once when the splash ANIMATES, and never after the
 * frame it settles on.
 *
 * Both qualifiers are load-bearing, and the shorter claim they replace ("exactly once, and
 * never last") was false at both ends. A splash of one frame hides nothing, so it restores
 * nothing and writes this ZERO times — that is what makes `cycles: 1` byte-identical to the
 * unanimated banner #67 shipped. And when the HIDE is the write that fails, the restore is
 * still attempted — a `write` may put bytes on the wire before it throws, and a cursor left
 * hidden outlives the process that hid it — so on that path this is the last byte of a
 * splash that never drew a frame at all. What is invariant is the thing the box depends on:
 * nothing follows the frame the animation settles on. Anybody rearranging the `standDown`
 * call sites should read the counts off those facts rather than off a promise of exactness.
 */
const SHOW_CURSOR = '\u001B[?25h'

/** The one signal this module cares about: Ctrl-C, mid-animation, cursor still hidden. */
const INTERRUPT_SIGNAL = 'SIGINT'

/**
 * CUU — move the cursor up `rows` lines, or nothing at all.
 *
 * Guarded rather than trusting, because `ESC[0A` is not "move up nothing": most
 * terminals read a zero parameter as one, so a zero-height frame in the sequence would
 * walk the cursor up through the scrollback a line at a time. A move that cannot be
 * expressed is not made, and the frame it belonged to is simply appended.
 *
 * @param {number} rows how many lines to go back up — the height of the frame just written
 * @returns {string} the escape sequence, or '' when there is no sane move to make
 */
export function cursorUp(rows) {
  return Number.isSafeInteger(rows) && rows > 0 ? `\u001B[${rows}A` : ''
}

/**
 * The frames to play, in order, as a finite array.
 *
 * This is where the duration is decided and where it stops being able to surprise
 * anybody: the length of the returned array IS the length of the animation.
 *
 * IT ENDS ON THE FIRST FRAME IT WAS GIVEN — by construction, not by arithmetic. Five
 * frames over the committed two-frame asset happens to land on frame 0 by parity, but a
 * regenerated three-frame asset would land on frame 1, a mid-blink, and the property that
 * "the splash settles on the still an unanimated banner prints" would quietly become
 * false. So the last slot is the poster frame, always. When the count does not divide
 * cleanly the cost is that the poster frame is held for one extra beat at the end — an
 * invisible stutter in an animation that is about to stop, against a visibly wrong final
 * still.
 *
 * A COUNT THAT IS NOT A WHOLE NUMBER OF FRAMES IS NOT A COUNT: `Infinity`, `NaN`, `2.5`,
 * `'5'`, a negative, a number past `Number.MAX_SAFE_INTEGER` — and, since QA, anything
 * above `SPLASH_MAX_FRAMES` — all fall back to the default rather than throwing or
 * spinning. Zero is honoured: a caller asking for no frames is asking for silence.
 *
 * THE CEILING IS CHECKED HERE, BEFORE THE ARRAY IS BUILT, which is the only place it means
 * anything. `Number.MAX_SAFE_INTEGER` is a safe integer, so it passed every guard this
 * function had and became a nine-quadrillion-element push loop — the one way left for a
 * splash to hang a start, and it hung it before writing a byte. Refusing the count costs a
 * comparison; allocating first and trimming later costs the machine.
 *
 * UNDRAWABLE FRAMES ARE DROPPED, not counted: half a usable asset still animates, and a
 * frame with no lines would otherwise contribute a zero-row cursor move (see `cursorUp`).
 *
 * @param {{lines: string[], delayMs?: number}[]} frames rendered frames, poster frame first
 * @param {number} [cycles] how many frames to play in total
 * @returns {{lines: string[], delayMs?: number}[]} the exact sequence, possibly empty
 */
export function splashSequence(frames, cycles = SPLASH_FRAME_COUNT) {
  const drawable = (Array.isArray(frames) ? frames : []).filter(isDrawable)
  const count = frameCount(cycles)
  if (drawable.length === 0 || count === 0) return []

  const sequence = []
  for (let index = 0; index < count - 1; index += 1) {
    sequence.push(drawable[index % drawable.length])
  }
  sequence.push(drawable[0])
  return sequence
}

/**
 * Play the splash on a stream, and leave it holding the final frame.
 *
 * Resolves when the animation has settled. Rejects only if the stream or the sleep it was
 * given throws — and even then the cursor is restored on the way out, because a hidden
 * cursor outlives the process that hid it and the user is left typing into an invisible
 * shell. That is a `finally`, not a `catch`: a stream that died mid-animation is the
 * caller's news to report.
 *
 * TOTAL FOR EVERYTHING ELSE. No frames, no stream, a stream that cannot be written to, a
 * cycle count of nonsense: silence, and a resolved promise. This is the first thing
 * `ralph start` does, and a banner is never worth losing a run over.
 *
 * THE INTERRUPT is the subtle half. Registering a SIGINT listener SUPPRESSES Node's
 * default disposition — the process no longer dies on Ctrl-C — so a handler that only
 * restored the cursor would turn `^C` during the splash into a `ralph start` that carried
 * on running and exited 0. The handler therefore stands down first (restore the cursor,
 * remove itself) and only then re-raises the signal, so what handles the second one is
 * Node's own disposition: terminate, exit 130, exactly as before this issue existed.
 *
 * THE RE-RAISE IS DERIVED FROM THE SIGNAL SOURCE rather than injected separately, on the
 * same left-to-right convention `startCommand` uses to resolve `color` from `stdoutIsTTY`.
 * On the real `process` that is `process.kill(process.pid, 'SIGINT')`, the canonical way
 * to ask for the default behaviour. In a test it is whatever the fake source offers,
 * which is usually nothing — so a fake source cannot kill the vitest worker, and nobody
 * has to remember to stub a second option to make that true. A caller that wants a
 * different mechanism passes `raise` explicitly.
 *
 * @param {object} [options]
 * @param {{lines: string[], delayMs?: number}[]} [options.frames] rendered frames from
 *   lib/sprite-banner.js — an empty list means the sprite is suppressed, and means silence
 * @param {number} [options.cycles] how many frames to play, default SPLASH_FRAME_COUNT
 * @param {{write: (chunk: string) => unknown}} [options.stream] where to draw
 * @param {(ms: number) => Promise<void>} [options.sleep] how to wait between frames
 * @param {{on?: Function, off?: Function, kill?: Function, pid?: number}} [options.signals]
 *   the signal source to listen on, defaulting to the real process. `on` is used only when
 *   `off` is there too — a listener that could not be removed would outlive the splash by
 *   the several hours a `ralph start` runs for
 * @param {(signal: string) => unknown} [options.raise] how to re-raise after standing down
 * @returns {Promise<void>}
 */
export async function playSplash({
  frames,
  cycles = SPLASH_FRAME_COUNT,
  stream,
  sleep = wait,
  signals = process,
  raise = (signal) => methodOf(signals, 'kill')?.(signals?.pid, signal),
} = {}) {
  const write = methodOf(stream, 'write')
  const unlisten = methodOf(signals, 'off')
  // ARM NOTHING WE CANNOT DISARM. A source with `on` and no `off` is a source this module
  // would register on for the life of the process — and `ralph start` runs for hours after
  // its banner with Node's SIGINT disposition suppressed the whole time, which is the exact
  // failure the listener-balance specs exist to catch. Reading `off` FIRST and making
  // `listen` depend on it says that in one line, where three guards at the call sites would
  // have said it three times and left the fourth path to be discovered later.
  const listen = unlisten && methodOf(signals, 'on')
  const sequence = splashSequence(frames, cycles)
  if (!write || sequence.length === 0) return

  // A single frame redraws nothing, so there is no cursor to hide and nothing to put
  // back — which is exactly what makes `cycles: 1` byte-identical to #67's static banner,
  // and what #74 will want for its `static` mode.
  const animated = sequence.length > 1
  // FALSE UNTIL THE HIDE IS ACTUALLY ATTEMPTED. Initialising this to `animated` meant a
  // source whose `on` threw took the splash down through the `finally` and wrote a restore
  // for a cursor that had never been hidden — one stray `ESC[?25h` glued to the front of
  // #68's box top rule, which is the one byte the module header forbids there. `standing`
  // now means "there is something to put back", and nothing sets it before there is.
  let standing = false

  // Restore the cursor and hand SIGINT back to Node, exactly once. Called three times on
  // purpose: before the final frame (the normal path), from the handler (Ctrl-C), and
  // from the `finally` (a throwing stream or sleep). Once the cursor is visible there is
  // nothing left for the listener to do, so it goes at the same moment — the rest of a
  // `ralph start`, which is measured in hours, runs with Node's own disposition and no
  // handler of ours in the way.
  //
  // BOTH CLEANUPS ARE BEST-EFFORT, AND SEPARATELY SO. Each gets its own `try` because they
  // are independent — a dead stream must not keep the listener on, and a source that refuses
  // to forget us must not cost the frame we were about to settle on — and because THIS
  // FUNCTION HAS NO CALLER ON EVERY PATH IT RUNS ON. Two of its three call sites are inside
  // `playSplash`'s own promise, where a throw becomes a rejection that `playBannerSplash`
  // catches; the third is Node's signal dispatch, which has nothing above it. A throw from
  // there is an UNCAUGHT EXCEPTION: QA reproduced it in a child process and the run exited 1
  // instead of the 130 acceptance criterion 8 promises. The asymmetry used to point exactly
  // the wrong way — the write was guarded and the `unlisten` next to it was not.
  const standDown = () => {
    if (!standing) return
    standing = false
    try {
      write(SHOW_CURSOR)
    } catch {
      // The stream is already gone; the listener still has to come off.
    }
    try {
      unlisten?.(INTERRUPT_SIGNAL, onInterrupt)
    } catch {
      // The source will not forget us; the splash still has a frame to settle on.
    }
  }

  function onInterrupt() {
    standDown()
    try {
      raise(INTERRUPT_SIGNAL)
    } catch {
      // Nothing useful is left to do, and this is the one frame with no caller above it, so
      // the alternative to swallowing is an uncaught exception exiting 1 in place of 130.
      // `process.kill` throws on an unknown signal or a pid that has gone; an injected
      // `raise` may throw for any reason at all. What survives either way is the stand-down
      // above: our handler is off, so the NEXT Ctrl-C meets Node's own disposition.
    }
  }

  try {
    if (animated) {
      // Arm, mark, hide — and in that order, which is the only one that gets both failures
      // right. Arming first is what lets a splash whose HIDE fails still take the listener
      // off and still attempt the restore (bytes may have reached the wire before the throw).
      // Marking before the hide rather than after is what closes the leak the naive fix
      // opens: `standDown` no-ops while `standing` is false, so a listener armed before the
      // mark would survive a failing hide and outlive the whole run. Nothing between these
      // three statements awaits, so no signal can arrive in the middle of them.
      listen?.(INTERRUPT_SIGNAL, onInterrupt)
      standing = true
      write(HIDE_CURSOR)
    }
    for (const [index, frame] of sequence.entries()) {
      const last = index === sequence.length - 1
      // Before the last frame, never after it: see the module header.
      if (last) standDown()
      // One write per frame, not one per row: seventeen rows reaching the terminal as a
      // single chunk is what keeps a redraw from being visibly torn, and it is what makes
      // the whole animation eleven assertable writes instead of eighty-five.
      const block = frame.lines.map((line) => `${line}\n`).join('')
      write(block)
      await sleep(delayOf(frame))
      if (last) continue
      // The move is counted off the BYTES THAT WENT OUT, not off `frame.lines.length`. For
      // every frame this module will accept the two numbers are equal — `isDrawable` sees
      // to that — and deriving it from the chunk is what makes them equal by construction
      // rather than by argument, for a line that arrives with a newline inside it as much
      // as for a frame with holes in it. A cursor move that does not undo precisely what
      // was drawn is the one failure mode that damages the terminal above the sprite.
      const move = cursorUp(rowsIn(block))
      if (move) write(move)
    }
  } finally {
    standDown()
  }
}

/**
 * The default sleep: a real timer, and the only reason this module is impure by default.
 *
 * The global `setTimeout` rather than `node:timers/promises`, because the import would be
 * a node: builtin in a module whose spec asserts which ones it may name, and this needs
 * nothing that version offers.
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One method off an injected capability, bound, or null.
 *
 * Duck-typed on the single method being used rather than on a shape: the callers are
 * `process` and `process.stdout` in production and hand-rolled recorders in tests, and
 * demanding more of the interface than is used would only make a test harder to write.
 *
 * `typeof === 'function'` rather than `?.()`, because optional call syntax guards null and
 * undefined but not a string — and every one of these capabilities may plausibly arrive
 * half-built from a caller assembling a fake. A missing capability is a capability this
 * module does without: no stream means silence, no `on` means no interrupt handler and an
 * animation that still puts the cursor back.
 */
function methodOf(source, name) {
  return typeof source?.[name] === 'function' ? source[name].bind(source) : null
}

/**
 * A frame is drawable when it has at least one line and every line is really there.
 *
 * HOLES DISQUALIFY A FRAME, which is the half QA had to find. `map` SKIPS a hole, so a
 * sparse `lines` writes fewer rows than it has slots: `new Array(17)` wrote the empty
 * string and then asked the terminal to walk up seventeen lines it had never printed,
 * straight through the previous run's output. Even one hole in a real sprite is the torn
 * art #72 refuses — a 17-row Ralph drawn as 16 rows is not a smaller Ralph, it is a
 * mangled one — so the frame is not drawn at all rather than drawn wrong.
 *
 * Indexed, with `in` rather than a value test, for exactly the reason validatePalette and
 * validateRows in lib/sprite-render.js are indexed: a hole and a dense `undefined` are the
 * same defect for whoever built the frame, and `forEach`/`some` would only see the second.
 *
 * IT SKIPS WHERE sprite-render.js THROWS. That module is called with an asset and a broken
 * asset is a build failure worth hearing about; this module is the first thing a `ralph
 * start` does, and a banner is never worth losing a run over. Dropping the frame is also
 * what makes the rest of the loop honest: every frame that reaches the stream now writes
 * exactly `lines.length` rows, so there is no such thing as an empty chunk to move over.
 *
 * REJECTED AS THE SOLE FIX: counting the rows off the joined block and moving over those.
 * It corrects the cursor while still putting a mutilated sprite on the user's terminal. The
 * loop does count the rows off the block (see `rowsIn`), and the two checks are not the same
 * check twice: they cover DISJOINT inputs. `rowsIn` catches what this function cannot see at
 * all — a dense line with a newline inside it, which is a row count no inspection of the
 * array can predict — and this one catches what `rowsIn` would happily draw, a frame missing
 * a row of the picture. Cursor correctness and art quality, one guard each.
 */
function isDrawable(frame) {
  const lines = frame?.lines
  if (!Array.isArray(lines) || lines.length === 0) return false
  for (let index = 0; index < lines.length; index += 1) {
    if (!(index in lines)) return false
  }
  return true
}

/**
 * How many rows a chunk put on the terminal: one per newline, and nothing else counts.
 *
 * A COMPLETED row is what the cursor can come back over, which is why this counts
 * terminators rather than pieces: `split` on a chunk ending in a newline yields a trailing
 * empty piece, and the `- 1` that removes it is doing the same arithmetic less obviously. A
 * chunk that ends WITHOUT one (which `playSplash` cannot produce, but a future caller
 * might) then reads as the rows it finished, and the unterminated tail is correctly not one.
 */
function rowsIn(chunk) {
  return chunk.split('\n').length - 1
}

/** How long to hold a frame, with the asset's own answer preferred over the default. */
function delayOf(frame) {
  const delay = frame?.delayMs
  return typeof delay === 'number' && Number.isFinite(delay) && delay >= 0
    ? delay
    : SPLASH_FRAME_DELAY_MS
}

/**
 * How many frames to play: a whole number of them, none of them, or the default.
 *
 * Both ends are refused, and refused the same way. A safe integer is a shape and not a
 * size — `Number.MAX_SAFE_INTEGER` satisfied every check this function used to make — so
 * the ceiling is as much part of "is this a count" as integrality is.
 */
function frameCount(cycles) {
  return Number.isSafeInteger(cycles) && cycles >= 0 && cycles <= SPLASH_MAX_FRAMES
    ? cycles
    : SPLASH_FRAME_COUNT
}
