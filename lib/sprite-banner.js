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
 * @param {object} [options]
 * @param {boolean} [options.isTTY] whether stdout is a terminal
 * @param {boolean} [options.color] whether ANSI colour may be emitted
 * @returns {string[]} the rendered frame, or [] when either capability is missing
 */
export function renderStaticBanner({ isTTY = false, color = false } = {}) {
  if (!isTTY || !color) return []
  return renderSprite({ palette, rows: frames[STATIC_FRAME_INDEX].rows })
}
