// #67 — the banner DECISION: may we draw, and what exactly do we print.
//
// lib/sprite-render.js turns data into strings and lib/sprite-data.js is the data.
// Neither knows whether printing is a good idea. This module is that judgement, and
// it is a separate file so that `ralph start` holds no gate at all: it resolves two
// capabilities, hands them over and writes whatever comes back — no branch to get
// wrong, nothing to stub — while the gate itself is asserted here against plain
// values, an env bag and two booleans.
//
// PURE, and asserted so by a static read in sprite-banner.test.js: no process, no
// clock, no fs. Both capabilities arrive as arguments (#41), because a module that
// read `process.env.NO_COLOR` itself would turn every test that injects an
// environment into a test of the developer's shell.
//
// ONE IMPORT THAT IS A RULE rather than a helper (#72): `bannerLayout` owns the whole
// degradation ladder — unbox under 44 columns, no sprite under 26 — and this module asks
// it instead of holding a 26 of its own. Two copies of a threshold are two thresholds the
// day one moves, and the failure would be silent: a sprite still drawn at 25 columns
// while the box below it had already unboxed. There is no cycle — banner-compose.js knows
// nothing about pixels, which is exactly why the number it states is a WIDTH and not a
// sprite.
import { bannerLayout } from './banner-compose.js'
import { frames, palette } from './sprite-data.js'
import { renderSprite } from './sprite-render.js'

/**
 * Frame 0 is the still. A GIF's first frame is its poster frame — the one drawn
 * before any timer fires and the one the artist composed to stand alone — so an
 * unanimated banner showing anything else would be showing a mid-blink. #73 animates
 * the whole sequence starting from this same frame.
 */
export const STATIC_FRAME_INDEX = 0

/**
 * Whether 24-bit ANSI may be written at all.
 *
 * Two gates, and both must pass:
 *
 * NOT A TTY. A pipe, a file, a launchd log, a CI transcript: escape sequences are
 * garbage there and the sprite is pure decoration, so it never wins that trade. This
 * is the criterion that keeps `ralph start | tee` byte-for-byte what it always was.
 *
 * NO_COLOR. The cross-tool opt-out (no-color.org). Honored on PRESENCE, not
 * truthiness — `NO_COLOR=` and `NO_COLOR=0` and `NO_COLOR=false` all suppress. That
 * is what the convention says ("when present, regardless of its value"), and it
 * deliberately differs from picocolors, which this package also depends on and which
 * tests `!!env.NO_COLOR`. The divergence is the safer direction for us: picocolors
 * degrades to plain words, whereas this sprite is nothing BUT colour — with the
 * escapes stripped it is a screenful of blank cells. A user who exported the variable
 * at all gets silence.
 *
 * DELIBERATELY NOT CONSULTED: TERM. `TERM=dumb` would be a reasonable third gate,
 * but reading it would widen the ambient environment surface the hermetic harness
 * has to control (#41) to a toolchain variable vitest's own reporter reads, and a
 * terminal that cannot render U+2580 also cannot render the box #68 draws around it
 * — degrading gracefully there is that issue's story, not this one's.
 *
 * ALSO NOT CONSULTED: FORCE_COLOR. No environment variable turns the sprite ON; the
 * only hatch is programmatic, and it takes BOTH `stdoutIsTTY: true` and `color: true`.
 *
 * Fails closed on a missing argument list: `colorEnabled()` is `false`, because a
 * caller that forgot to resolve the capability should get silence rather than a
 * screenful of escape codes. That is the only claim here — it is not null-safety:
 * `{ env: null }` throws on the `in` below, deliberately unguarded, since a caller
 * whose env bag can be null has a problem twenty lines earlier.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] the environment to read,
 *   passed in rather than looked up
 * @param {boolean} [options.isTTY] whether the STDOUT being written to is a terminal
 * @returns {boolean}
 */
export function colorEnabled({ env = {}, isTTY = false } = {}) {
  if (!isTTY) return false
  // `in`, not a truthiness or `!== undefined` check: an explicit `NO_COLOR=` reaches
  // us as the empty string, which is the spelling a shell script exports most easily
  // and the one every truthiness test gets wrong.
  if ('NO_COLOR' in env && env.NO_COLOR !== undefined) return false
  return true
}

/**
 * The banner as terminal lines, or nothing at all.
 *
 * Returns an array so the caller writes it with the same `out()` helper it uses for
 * every other line, and so "suppressed" is the empty array rather than an empty
 * string — a caller cannot accidentally emit a blank line, a lone reset, or a single
 * byte of anything when the gate is shut. That is criterion 5 of #67: with colour
 * off, `ralph start`'s output is unchanged down to the byte.
 *
 * Two capabilities, and BOTH must hold. Belt: never emit escapes to a stream the
 * caller says isn't a terminal. From `ralph start` the `isTTY` arm can never fire
 * (its `color` already folds in `stdoutIsTTY`); it is for the next caller, whose
 * colour policy may well say yes on a CI run with stdout redirected to a file.
 *
 * ...and a THIRD reason to stay silent, which is #72's: a terminal narrower than the
 * sprite. The frame is 26 cells wide, and on every terminal too narrow to hold both blocks
 * side by side (#161's rung, at 72 columns) the two are STACKED — each with the whole width
 * to itself — which makes the sprite the narrow element of the banner and means the box
 * unboxes long before this rung is reached. Below 26 the sprite is dropped WHOLE rather than
 * clipped, because a clipped sprite is not a smaller sprite — it is half a face with a torn
 * edge, on every row.
 *
 * The width is a reason to stay silent and never a reason to speak: it is asked last, so
 * no column count can talk a piped stream or a NO_COLOR run into a screenful of escapes.
 *
 * SINCE #73, NO COMMAND CALLS THIS — `ralph start` plays the splash instead — and it stays
 * anyway, because what earns it is not a call site. It is the ORACLE for the still: three
 * specs compare the frame the animation settles on against this function's output, so "the
 * splash ends on the frame an unanimated banner would have drawn" is a comparison between
 * two functions instead of a claim about one. What those comparisons pin is the pair of
 * facts a regenerated asset could quietly break — the frame INDEX the still is taken from,
 * and the rotation in `splashSequence` that puts that frame last.
 *
 * It is also the only answer available to a caller with no stream: this is a pure
 * `string[]`, where `playSplash` needs somewhere to write, something to sleep with and a
 * signal source to be interrupt-safe on. #74's `RALPH_BANNER=static` could have been either
 * and got the same bytes; it went through the player, with a `cycles` of 1 that writes
 * exactly these rows and nothing else — no hide and no restore, because the player only
 * hides a cursor it is going to redraw over. So that mode was a choice about plumbing rather
 * than about output, and neither way round it would have deleted this.
 *
 * @param {object} [options]
 * @param {boolean} [options.isTTY] whether stdout is a terminal
 * @param {boolean} [options.color] whether ANSI colour may be emitted
 * @param {number} [options.width] the terminal's column count, as the caller found it.
 *   ABSENT MEANS ROOM ENOUGH: an omitted width — or a `stdout.columns` of `undefined` on
 *   a pipe, or the `0` some CI runners report — falls through `bannerLayout` to the
 *   60-column default, so a caller that knows nothing about the terminal's width draws
 *   exactly what it drew before this parameter existed.
 * @returns {string[]} the rendered frame, or [] when a capability is missing or the
 *   terminal is too narrow to hold it
 */
export function renderStaticBanner({ isTTY = false, color = false, width } = {}) {
  if (!mayDrawSprite({ isTTY, color, width })) return []
  return renderSprite({ palette, rows: frames[STATIC_FRAME_INDEX].rows })
}

/**
 * Every frame of the sprite, rendered and timed — the splash's INPUT (#73).
 *
 * The animation itself lives in lib/sprite-player.js, which is the one module here that
 * touches a stream and a clock. This function is the part of it that can stay pure: what
 * to draw, in which order, and how long to hold each frame. The player receives a plain
 * array and needs to know nothing about pixels, palettes or capabilities.
 *
 * ORDERED FROM `STATIC_FRAME_INDEX`, not from the asset's index 0. The two are the same
 * number today, and stating the rotation anyway is what makes "the splash opens and
 * settles on the frame an unanimated banner shows" a property of this module rather than a
 * coincidence between two constants — a regenerated asset that moved the poster frame
 * would otherwise start the animation mid-blink.
 *
 * THE SAME GATE AS `renderStaticBanner`, asked through the same helper. Two copies would
 * be two answers the day one of them changed, and the failure mode is ugly and specific: a
 * run where the still was suppressed but the animation was not would write five frames of
 * 24-bit escapes into a piped log.
 *
 * NO CYCLE COUNT, no repetition and no notion of "one second" — this returns the asset,
 * once. How many frames get played is the player's `cycles`, because that is the one thing
 * #74's `full` and `static` modes vary — `static` asks for a single cycle, `full` takes the
 * player's five-frame default — and it is not a fact about the art.
 *
 * @param {object} [options]
 * @param {boolean} [options.isTTY] whether stdout is a terminal
 * @param {boolean} [options.color] whether ANSI colour may be emitted
 * @param {number} [options.width] the terminal's column count; absent means room enough
 * @returns {{lines: string[], delayMs: number}[]} one entry per frame, poster frame first,
 *   or [] when a capability is missing or the terminal is too narrow to hold the sprite
 */
export function renderSplashFrames({ isTTY = false, color = false, width } = {}) {
  if (!mayDrawSprite({ isTTY, color, width })) return []
  return frames.map((_, offset) => {
    const frame = frames[(STATIC_FRAME_INDEX + offset) % frames.length]
    return { lines: renderSprite({ palette, rows: frame.rows }), delayMs: frame.delayMs }
  })
}

/**
 * May the sprite be drawn at all: the whole gate, in one place, for both entry points.
 *
 * Two capabilities and a width, in that order — see `renderStaticBanner` above for why
 * each of them is a reason to stay silent and why the width is asked last.
 */
function mayDrawSprite({ isTTY, color, width }) {
  if (!isTTY || !color) return false
  return bannerLayout(width).sprite
}
