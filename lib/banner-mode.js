// #74 — RALPH_BANNER: the one place the banner's whole policy is decided.
//
// The banner is four modules by now — lib/sprite-data.js is the pixels,
// lib/sprite-render.js turns them into strings, lib/sprite-banner.js decides whether they
// may be drawn at all and lib/sprite-player.js animates them — plus lib/banner-compose.js
// for the identity box under them. Each of those answers a question about a CAPABILITY.
// This module answers the only question left, and it is a question about a PREFERENCE: how
// much of that banner did the user actually ask for.
//
// ONE PURE FUNCTION, and the shape is the point. `resolveBannerMode` takes the configured
// value, the environment override, TTY-ness, colour and a column count, and returns the
// three decisions a caller needs plus the one line it may have to print. `ralph start`
// therefore holds no rung of the ladder and no reading of the knob: it forwards what it
// already resolved and obeys what comes back, exactly as it does for the sprite gate (#67).
// That is what makes this table testable against plain values instead of against a terminal.
//
// PURE, and asserted so by a static read in banner-mode.test.js: no environment, no clock,
// no fs, no stream. The warning is RETURNED rather than printed, for the same reason
// resolveAgent returns one (#559) — a module that wrote to stderr could not be tested as a
// table, and the caller is the only party that knows which stream a warning belongs on.
//
// PRECEDENCE: environment, then config, then the default. That order is DELIBERATELY the
// opposite of the `TASK_SOURCE` line in lib/commands/start.js, which reads the committed
// file first and only falls back to the environment — and the difference is what each knob
// is FOR. A task source is a property of the repository: every clone of it draws work from
// the same place, and a stray environment variable must not quietly redirect a run. A banner
// is a property of the INVOCATION: `RALPH_BANNER=off ralph start` inside a wrapper script,
// a cron entry or a CI job has to be silenceable without editing — and committing — a file
// that every other run in the repo shares.
//
// CAPABILITY CAPS DOWNWARD AND NEVER UPWARD. `full` into a pipe behaves as `off`, because
// nothing in this file can make escape sequences a good idea on a stream that is not a
// terminal. There is no value, no spelling and no combination that turns the sprite ON — the
// only hatch remains the programmatic one sprite-banner.js documents, both capabilities
// passed as `true`.
//
// ...AND THE CAP DOES NOT REACH THE FACTS, which is the one distinction worth reading twice.
// A piped `ralph start` has printed the identity box since #68 — a launchd log is exactly
// where "which version, which directory" is the question being asked — so a mode capped down
// to `off` by the terminal still prints the box. An EXPLICIT `off` is a different sentence: a
// user asking for nothing at all, and they get nothing at all. Hence two answers rather than
// one: `mode` is what the terminal can EFFECT, `box` is what the user REQUESTED.
//
// ONE IMPORT, AND IT IS A RULE rather than a helper, on exactly the argument
// lib/sprite-banner.js makes for the same import (#72): `bannerLayout` owns the whole
// degradation ladder — no sprite under 26 columns, no frame under 44 — and this module asks
// it for the rung it needs instead of keeping a 26 of its own. Two copies of a threshold are
// two thresholds the day one moves, and the failure would be silent: a mode resolver still
// authorising a sprite at 25 columns while the renderer below it had stopped drawing one.
//
// It asks for THE SPRITE RUNG ONLY, and the other one is a deliberate non-decision. Whether
// the identity box gets a frame is a pure function of the width, and composeBanner is already
// handed that width — so an answer computed here would be a second owner of a decision that
// has one, agreeing with it by assertion. `off` is the whole of this module's say over the
// box: whether it prints, never what it looks like.
import { bannerLayout } from './banner-compose.js'

/**
 * The three values RALPH_BANNER accepts, in descending order of how much they draw.
 *
 * `full` is the sprite, the one-second splash and the box; `static` is the sprite and the
 * box with no animation at all (#73's player writes byte-identical output for a single
 * frame, so this mode is a choice about plumbing rather than about pixels); `off` is
 * nothing — no sprite, no box, no blank line.
 *
 * Exported as the ONE list, so the template, the warning below and every test read the same
 * three words. Ordered rather than a Set for the same reason VALID_SOURCES is a list: the
 * order is what the warning prints, and a user reading it should see the ladder.
 */
export const BANNER_MODES = ['full', 'static', 'off']

/**
 * What an unset, blank or unusable knob means.
 *
 * `full` is the zero-regression answer: it is what `ralph start` has done since #73, so a
 * repo that never edits this file and a script that never exports this variable both keep
 * the banner they already had. It is also the recovery from a typo — see the warning below.
 */
export const DEFAULT_BANNER_MODE = 'full'

/**
 * Resolve the banner's mode, and everything that follows from it.
 *
 * @param {object} [options]
 * @param {string} [options.configured] the raw RALPH_BANNER assignment out of
 *   ralph.config.sh, as `parseConfigVar` returned it — `''` when the setting is absent
 * @param {string} [options.override] the raw RALPH_BANNER out of the environment, which
 *   WINS when it is set to something. An unset or blank override is not a choice: it defers
 *   to the config, so `RALPH_BANNER= ralph start` cannot accidentally mean anything
 * @param {boolean} [options.isTTY] whether the STDOUT being written to is a terminal
 * @param {boolean} [options.color] whether ANSI colour may be emitted (#67's `colorEnabled`)
 * @param {number} [options.width] the terminal's column count, as the caller found it —
 *   `undefined` on a pipe, `0` on some CI runners; `bannerLayout` reads both as its own
 *   60-column default
 * @returns {{mode: string, sprite: boolean, box: boolean, warning: string|null}}
 *   `mode` is the EFFECTIVE mode after the downward cap, so `'static'` or `'full'` always
 *   implies the sprite may be drawn and a caller may read it as "how many frames". `sprite`
 *   is whether to draw the sprite at all. `box` is whether to print the identity box — false
 *   only when the user REQUESTED `off`; what that box LOOKS like stays composeBanner's, which
 *   reads the same width. `warning` is null, or one line for the caller to put on stderr.
 *   Never throws: a knob read off a committed file and an ambient environment must cost a
 *   picture at worst, never a run.
 */
export function resolveBannerMode({ configured, override, isTTY = false, color = false, width } = {}) {
  const stated = statedValue(override, configured)
  const requested =
    stated?.text && BANNER_MODES.includes(stated.text) ? stated.text : DEFAULT_BANNER_MODE
  // A value was stated and it is not the mode we resolved: the user typed something we do
  // not know. One line, and the run continues on the default — the same trade resolveAgent
  // and resolveSource make, for the same reason: a typo in a banner knob is not worth an
  // aborted launch, and silence would leave a user editing a file that changes nothing.
  const warning = stated && requested !== stated.text ? unrecognized(stated.raw) : null

  // THE LADDER, for the one rung this module needs: whether the width can hold a sprite.
  const layout = bannerLayout(width)
  // The downward cap, in one expression, and the order of its terms is the order
  // sprite-banner.js's own gate asks them in: what the user wanted, then whether the stream
  // is a terminal, then whether colour is allowed, then whether the terminal is wide enough.
  // `=== true` rather than truthiness because every one of these arrives from a caller
  // assembling a bag, and `isTTY: 'no'` must not be a screenful of escapes (#67).
  const sprite = requested !== 'off' && isTTY === true && color === true && layout.sprite
  // The facts, which the terminal has no say over — only the user does.
  const box = requested !== 'off'

  return {
    // Capped, never raised: a requested mode the sprite gate would refuse becomes `off`, so
    // no caller can be handed `static` and then find it has no frames to hold still.
    mode: sprite ? requested : 'off',
    sprite,
    box,
    warning,
  }
}

/**
 * Which of the two sources actually stated something, and what it said.
 *
 * The environment is asked first and the config second — see the header for why this knob
 * runs the opposite way to TASK_SOURCE. "Stated" excludes absent, null and blank: a
 * `RALPH_BANNER=` exported by a shell script reaches us as the empty string, and reading
 * that as a mode would make the most easily-typed spelling of "no opinion" mean something.
 *
 * A NON-STRING IS STATED BUT UNUSABLE, and it is deliberately NOT coerced. `String(value)`
 * on a hostile object runs its `toString`, and this module's inputs come out of a file on
 * disk and an ambient environment — the same argument banner-compose.js's `textOr` makes for
 * refusing rather than converting. It reaches the caller as a warning about the default,
 * with `text: null` so the resolver above cannot match it against the registry.
 *
 * @returns {{raw: unknown, text: string|null}|null} the stated value and its normalized
 *   form (trimmed, lowercased), or null when neither source said anything
 */
function statedValue(override, configured) {
  for (const raw of [override, configured]) {
    if (raw == null) continue
    if (typeof raw !== 'string') return { raw, text: null }
    const text = raw.trim()
    if (text === '') continue
    return { raw, text: text.toLowerCase() }
  }
  return null
}

/**
 * The one line a typo earns, worded exactly as resolveAgent words its own (#559).
 *
 * It echoes the ORIGINAL value — untrimmed, in its original case — because the whole point
 * is that the user can see what they typed. Non-strings are named by type instead of
 * interpolated, since `${value}` would run the very `toString` `statedValue` refused to.
 *
 * NO EMOJI AND NO STREAM. The caller prefixes the `⚠️` and picks the stream, the way
 * lib/commands/init.js already does for the agent's warning — this module has no opinion on
 * whether its reader is a terminal or a log.
 */
function unrecognized(raw) {
  const shown = typeof raw === 'string' ? `'${raw}'` : `<a ${typeof raw}>`
  return `RALPH_BANNER=${shown} unrecognized; falling back to '${DEFAULT_BANNER_MODE}'. Valid: ${BANNER_MODES.join(', ')}.`
}
