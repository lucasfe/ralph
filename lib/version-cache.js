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
export const EMPTY_VERSION_CACHE = Object.freeze({
  last_check_at: null,
  last_prompted_at: null,
  latest_version: null,
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

// #24: writes the fixed three-field shape (unknown keys are dropped) and
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
  }
}

const defaultFs = {
  mkdirSync: realMkdirSync,
  readFileSync: realReadFileSync,
  writeFileSync: realWriteFileSync,
}
