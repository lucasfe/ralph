import {
  mkdirSync as realMkdirSync,
  readFileSync as realReadFileSync,
  writeFileSync as realWriteFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { globalConfigPath } from './utils/global-config.js'

const CACHE_FILENAME = 'update-check.json'

// #24: the cache is GLOBAL, not per-project — the npm package is installed
// globally, so a user with five Ralph repos gets one check a week, not five.
//
// #215: GLOBAL ACROSS REPOS IS RIGHT; GLOBAL ACROSS CHANNELS WAS NOT, and that is the
// whole of this field. One machine can carry two copies of Ralph installed from two
// channels — the observed one had nvm/npm at 0.25.4 and Homebrew at 0.26.0 — and #196
// made those channels hold DIFFERENT versions on purpose, since the tap exists so a
// refused `npm publish` cannot stop a release from being installable. With one un-keyed
// `latest_version` field, whichever copy last ran the weekly check owned it: the brew
// copy's `ralph doctor` reported `cached 0.23.0`, npm's last accepted version and a
// number the tap cannot produce. The harmful direction is the same field read the other
// way — the brew copy resolves 0.27.0 from the tap, the npm copy reads it, compares it
// against its own 0.25.4 and nags with npm's advice (#200 correctly takes the ADVICE
// from the reading copy's layout), and `npm i -g @lucasfe/ralph@latest` then installs
// 0.23.0.
//
// A STAMP BESIDE THE VALUE, NOT A MAP KEYED BY CHANNEL, and the argument is worth
// spelling out because the map is the more obvious design.
//
// `latest_version_by_channel: { npm: '0.23.0', brew: '0.27.0' }` would let one file
// remember both answers, which sounds strictly better and is, for a fact nobody has.
// Every copy of Ralph queries exactly ONE channel — its own — so the second entry can
// only ever be another copy's leftovers, aging at that copy's cadence and re-attributed
// to nobody's benefit: the reader that could use it already has the only entry it is
// allowed to read. What the map does buy is a machine where both copies check within
// one weekly window each keeping its own number instead of overwriting the other's,
// and that is real but small — the value is advisory, both copies re-query at their
// next open window, and the throttle is per-FILE (see below), so the second copy's run
// is already the one that does not query.
//
// Against that: the map changes the SHAPE of the field every consumer since #24 reads.
// `latest_version` is a top-level normalized string in the cache literal, in
// `readVersionCache`'s normalization table, in doctor's row, in `ralph start`'s banner
// and in the test files that name it: 48 do now, 41 did when #215 measured them, before
// this slice added seven of its own; a map makes each of those a lookup that can
// answer undefined, and makes the "hand-mangled field" table this module is built on
// (a number, an object, an array, a blank) a two-level problem — a map whose VALUES are
// each garbage, plus a map that is itself a string. The stamp adds one more field of
// exactly the kind already here: a string or null, normalized by the same
// `normalizeField`, invalid in the same ways. The read rule then lives in one function
// (`cachedVersionFor`) rather than in a shape every caller has to destructure
// correctly, and a legacy file — a bare `latest_version` with no stamp — reads as
// "attributed to nobody" for free, which is the exact behaviour #215 needs from it.
//
// THE TWO WINDOWS STAY GLOBAL — one `last_check_at` and one `last_prompted_at` per machine,
// not stamped or keyed: #24 caps A MACHINE'S NETWORK and #26 A USER'S ATTENTION — one of each
// however many copies are installed — so keying them would double what they exist to cap.
// What that costs, measured: whichever copy runs first spends the window, so a machine with a
// habitual first-runner starves the other INDEFINITELY, not for the one week an earlier draft
// of this comment claimed — zero sightings of the tap's 0.27.0 across six windows, at
// lib/update-check.cache-channel.qa.test.js:767 — and an alternating order flaps the notice
// week to week (:888, the map's half of the argument above). Two rules bound it with these
// same four fields and no throttled write. Re-open the window for a foreign pair: ten
// alternating runs then cost ten queries, not one. Or stand down when the cached pair is
// already yours (:791): four queries in eight windows, not eight, on EVERY single-copy
// machine — a notice up to two weeks late. Declined on that price: #228, non-goal at :863.
export const EMPTY_VERSION_CACHE = Object.freeze({
  last_check_at: null,
  last_prompted_at: null,
  latest_version: null,
  // #215: WHICH CHANNEL produced `latest_version` — 'npm', 'brew', or null for a
  // number nobody could attribute (a file written before this field existed, or a
  // query descriptor that named no channel). Null is never a wildcard: it is served
  // to no reader at all, because the field could have been written by either channel
  // and believing it is a coin flip between a harmless answer and the exact nag this
  // field exists to prevent.
  latest_version_channel: null,
})

// #24: same XDG base resolution as the global dotenv — derived FROM it rather
// than copied, so there is one source of truth for the trim/fallback rules. It
// is a SEPARATE file in that directory on purpose: ralph/.env is a 0600
// credential store and must never be mixed with cache data.
export function versionCachePath({ processEnv = process.env, home = homedir() } = {}) {
  // An explicitly-passed null bag skips the default above and would reach join()
  // through globalConfigPath, so normalize before handing it over.
  return join(dirname(globalConfigPath({ processEnv: processEnv ?? {}, home })), CACHE_FILENAME)
}

// #24: total for every FILE-level failure — a missing file, an unreadable file,
// invalid JSON, a valid non-object, and hand-mangled field types all resolve to
// empty defaults instead of throwing. `ralph start` must never abort over its
// own cache.
//
// It is NOT total for a bad ARGUMENT, and that distinction matters: the `path`
// default parameter evaluates versionCachePath() BEFORE either try block below,
// so a non-string `home` (null, {}, 42) or a truthy non-string XDG_CONFIG_HOME
// throws a TypeError out of join()/trim() and escapes this function entirely.
// Both of those arrive from a caller, which is why resolveUpdateDecision in
// update-check.js wraps its call to this function in a try/catch — that guard is
// load-bearing, not belt-and-braces.
export function readVersionCache({
  fs = defaultFs,
  processEnv = process.env,
  home = homedir(),
  path = versionCachePath({ processEnv, home }),
} = {}) {
  let raw
  try {
    raw = fs.readFileSync(path, 'utf8').toString()
  } catch {
    return { ...EMPTY_VERSION_CACHE }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...EMPTY_VERSION_CACHE }
  }
  return normalizeCache(parsed)
}

// #24: writes the fixed field shape (unknown keys are dropped) and
// enforces 0700 on the parent dir, matching writeGlobalCreds so the directory
// posture is the same whichever of the two files lands there first. Throws on a
// real FS failure — callers that treat the cache as best-effort catch it.
export function writeVersionCache({
  cache,
  fs = defaultFs,
  processEnv = process.env,
  home = homedir(),
  path = versionCachePath({ processEnv, home }),
}) {
  const next = normalizeCache(cache)
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path, JSON.stringify(next, null, 2) + '\n')
  return path
}

// #24: only strings survive; a blank or non-string value (a hand-edited number,
// an object) becomes null so downstream Date.parse/semver checks see "absent"
// rather than something that only looks like a value.
function normalizeField(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

function normalizeCache(cache) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
    return { ...EMPTY_VERSION_CACHE }
  }
  return {
    last_check_at: normalizeField(cache.last_check_at),
    last_prompted_at: normalizeField(cache.last_prompted_at),
    latest_version: normalizeField(cache.latest_version),
    // #215: normalized by the same rule as every other field, which is what makes a
    // hand-edited `42` or `{}` read as "unattributed" rather than as a channel named
    // `[object Object]` — and, since nothing matches null, as a number served to nobody.
    latest_version_channel: normalizeField(cache.latest_version_channel),
  }
}

/**
 * The cached version a channel may READ — its own answer, or null.
 *
 * #215: the one place the "a number belongs to the channel that produced it" rule is
 * spelled, so no consumer decides it by hand. Three ways to get null, and they are
 * deliberately indistinguishable to a caller, because all three mean the same thing to
 * a reader: this copy has no cached answer of its own.
 *
 *   1. THE STAMP NAMES ANOTHER CHANNEL. The #215 bug, refused: a Homebrew copy never
 *      reads npm's number and an npm copy never reads the tap's.
 *   2. THE STAMP NAMES NOBODY. A file written before this field existed, or a query
 *      that could not be attributed. NOT treated as the reader's own: a 0.26.0 brew
 *      copy already had #199/#200 and wrote the TAP's number into that bare field, so
 *      "unstamped means mine" would be the harmful direction, live, on exactly the
 *      machines this issue was reported from.
 *   3. THE READER NAMES NO CHANNEL. A caller that cannot say which channel it came
 *      from has not earned another channel's number. Deliberately not "npm by
 *      default": npm is a guess, and the whole cost of #215 was a guess that read as a
 *      determination. A caller that wants that guess makes it explicitly — see
 *      `versionChannelFor` in lib/install-markers.js, which is where "an install path
 *      nothing recognizes reads as npm" is argued and where it belongs.
 *
 * Reads each field exactly ONCE, through `normalizeField`, so a cache that crossed a
 * seam cannot answer one type to the comparison and another to the return. It is total
 * for a missing or non-object cache; a cache with a THROWING getter is the caller's to
 * guard, exactly as it already is for a bare `cache.latest_version` read (see
 * `cachedLatestVersion` in lib/commands/doctor.js, whose try/catch covers both).
 *
 * @param {object|null|undefined} cache a cache as `readVersionCache` returns it
 * @param {string|null|undefined} channel the reading copy's channel id
 * @returns {string|null} the version this channel may report, or null
 */
export function cachedVersionFor(cache, channel) {
  const reader = normalizeField(channel)
  if (!reader) return null
  if (normalizeField(cache?.latest_version_channel) !== reader) return null
  return normalizeField(cache?.latest_version)
}

/**
 * The cache with a newly resolved version and the channel that produced it, as one pair.
 *
 * #215: the WRITE side of the rule `cachedVersionFor` reads. The pair moves together or
 * not at all — a stamp with no version beside it is a claim about a number that is not
 * there, and a version with a stale stamp is the bug itself with a longer fuse. So an
 * unusable version clears BOTH fields, and an unattributable version is written
 * UNATTRIBUTED: keeping the number costs nothing (the run that resolved it still
 * reports it) and it is then served to nobody, which is strictly better than filing it
 * under a channel that did not answer.
 *
 * Copies rather than mutates, because callers hand it EMPTY_VERSION_CACHE — a frozen
 * literal — whenever the cache could not be read.
 *
 * @param {object} cache the cache to base the next one on
 * @param {{version?: unknown, channel?: unknown}} [resolved] what a channel just answered
 * @returns {object} the next cache
 */
export function withLatestVersion(cache, { version, channel } = {}) {
  const resolved = normalizeField(version)
  return {
    ...cache,
    latest_version: resolved,
    latest_version_channel: resolved ? normalizeField(channel) : null,
  }
}

const defaultFs = {
  mkdirSync: realMkdirSync,
  readFileSync: realReadFileSync,
  writeFileSync: realWriteFileSync,
}
