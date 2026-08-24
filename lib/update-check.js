import {
  EMPTY_VERSION_CACHE,
  readVersionCache,
  writeVersionCache,
} from './version-cache.js'

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export const PACKAGE_NAME = '@lucasfe/ralph'

export function isValidSemver(s) {
  return typeof s === 'string' && SEMVER_RE.test(s.trim())
}

export function compareSemver(a, b) {
  const parse = (v) => {
    const noBuild = v.split('+')[0]
    const dashIdx = noBuild.indexOf('-')
    const main = dashIdx === -1 ? noBuild : noBuild.slice(0, dashIdx)
    const pre = dashIdx === -1 ? '' : noBuild.slice(dashIdx + 1)
    return { parts: main.split('.').map((n) => Number(n)), pre }
  }
  const A = parse(a)
  const B = parse(b)
  for (let i = 0; i < 3; i++) {
    const x = A.parts[i] ?? 0
    const y = B.parts[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  if (A.pre === B.pre) return 0
  if (A.pre === '') return 1
  if (B.pre === '') return -1
  return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0
}

// #21: the registry query on its own — "what is the latest published version?"
// with no state, no dedupe, no comparison. Any failure (non-zero exit, timeout,
// missing npm, non-semver output) resolves to null, never throws.
export async function fetchLatestVersion(exec, timeoutMs = 5000) {
  if (typeof exec !== 'function') return null
  let result
  try {
    result = await exec('npm', ['view', PACKAGE_NAME, 'version'], {
      timeout: timeoutMs,
      reject: false,
    })
  } catch {
    return null
  }
  if (!result || result.exitCode !== 0 || result.timedOut) return null
  const fetched = (result.stdout || '').trim()
  return isValidSemver(fetched) ? fetched : null
}

// #24: one check a week, globally. Anything shorter turns a courtesy notice into
// a per-run registry query for every repo a user runs Ralph in.
export const UPDATE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

// #24: the opt-out. Any value other than the explicit negatives disables the
// check, so `RALPH_NO_UPDATE_CHECK=yes` behaves the way a user expects while
// `=0` still leaves it on. String() rather than a bare .trim(): process.env only
// ever yields strings, but an injected bag is not bound by that, and a TypeError
// here would abort the whole preflight.
export function isUpdateCheckDisabled(processEnv = process.env) {
  const raw = String(processEnv?.RALPH_NO_UPDATE_CHECK ?? '')
    .trim()
    .toLowerCase()
  if (!raw) return false
  return raw !== '0' && raw !== 'false'
}

// #24: the whole update-notice policy in one place — the opt-out, the weekly
// network throttle read from the global cache, the semver comparison, and the
// cache write. Callers get a decision and print it; they own no policy.
//
// `now` is a function returning epoch ms — the same contract as startCommand's
// `now`, so it can be passed straight through. Anything else falls back to the
// real clock rather than escaping.
//
// Returns:
//   latestVersion — the newest published version we know of, or null.
//   isNewer       — latestVersion is a valid semver strictly above currentVersion.
//   shouldPrompt  — #26: isNewer AND the PROMPT window (last_prompted_at) being
//                   open. Independent of the network window, so it is equally
//                   true on the throttled 'cache' path and on a 'network' run
//                   whose query failed but whose cached version is still newer —
//                   a flaky network must not hide a known update. False on the
//                   opt-out path, which reads no cache at all. Note this says
//                   "a prompt is DUE", not "a prompt happened": the caller that
//                   actually shows one records it with recordPromptShown.
//   source        — how this run resolved: 'disabled' (opt-out), 'cache' (inside
//                   the weekly window, no registry query), or 'network' (the
//                   registry WAS queried this run, successfully or not).
//   updatedCache  — what the cache holds as of this run, or null on the opt-out
//                   path where nothing was touched. Informational only: the write
//                   has already happened (or already failed and been dropped), so
//                   there is nothing here for a caller to act on.
//
// Never throws. Every boundary that can fail — the clock callback, the env bag,
// the cache read, the registry query, the cache write — is guarded HERE rather
// than relying on the far side happening to be total, because `ralph start` has
// no try/catch around this call and an escape would abort the run with a stack
// trace over what is only advice.
export async function resolveUpdateDecision({
  currentVersion = 'unknown',
  now = Date.now,
  exec,
  processEnv = process.env,
  fs,
  home,
  timeoutMs = 5000,
} = {}) {
  // A null env bag would reach join() through versionCachePath, so normalize it
  // once here instead of leaving each consumer to defend itself differently.
  const env = processEnv ?? {}

  // The opt-out short-circuits before ANY network call, cache read, or output.
  if (isUpdateCheckDisabled(env)) {
    return buildDecision({
      latestVersion: null,
      currentVersion,
      source: 'disabled',
      updatedCache: null,
    })
  }

  // An undefined fs/home falls through to version-cache's own defaults (the
  // real fs, the real home) — one source of truth for those.
  const cacheArgs = { fs, processEnv: env, home }
  let cache
  try {
    cache = readVersionCache(cacheArgs)
  } catch {
    // Load-bearing — do NOT delete this as redundant. readVersionCache is total
    // for file-level failures, but its `path` default parameter computes
    // versionCachePath() before its own try blocks, so a non-string `home` or a
    // truthy non-string XDG_CONFIG_HOME throws a TypeError straight out of it.
    // Both reach us from a caller, so this catch is what actually makes the
    // never-throws promise above hold at the BOUNDARY.
    cache = { ...EMPTY_VERSION_CACHE }
  }
  const nowMs = epochMs(now)

  // #26: the two windows are read here, from the same cache, and never gate each
  // other — a run can query the registry without prompting (check due, prompt
  // throttled) and prompt without querying (prompt due, check throttled).
  const checkThrottled = !windowDue(cache.last_check_at, nowMs)
  const promptDue = windowDue(cache.last_prompted_at, nowMs)
  if (checkThrottled) {
    // Throttled: the prompt is still served, from the CACHED latest_version.
    return buildDecision({
      latestVersion: cache.latest_version,
      currentVersion,
      source: 'cache',
      updatedCache: cache,
      promptDue,
    })
  }

  const fetched = await fetchLatestVersion(exec, timeoutMs)
  // last_check_at is stamped even when the query failed: the throttle's job is
  // "at most one registry query a week", and a broken network is exactly when
  // retrying on every `ralph start` is most useless. The previously known
  // latest_version survives, so a pending notice is not lost to one flaky night.
  // #26: last_prompted_at is carried through untouched — resolving a decision
  // never stamps it, only showing a prompt does (see recordPromptShown).
  const updatedCache = {
    ...cache,
    last_check_at: new Date(nowMs).toISOString(),
    latest_version: fetched ?? cache.latest_version,
  }
  try {
    writeVersionCache({ cache: updatedCache, ...cacheArgs })
  } catch {
    // Best-effort: an unwritable ~/.config must not break `ralph start`.
  }
  return buildDecision({
    latestVersion: updatedCache.latest_version,
    currentVersion,
    source: 'network',
    updatedCache,
    promptDue,
  })
}

// #26: records that a prompt was SHOWN, stamping last_prompted_at so the next 7
// days of `ralph start` runs — in this repo or any other, since the cache is
// global — get #24's notice without the question.
//
// It is the CALLER's call and not part of resolveUpdateDecision on purpose:
// resolveUpdateDecision runs on every `ralph start`, including the headless ones
// (cron, launchd, CI) where no question is ever displayed. Stamping there would
// burn the window on a run that never asked a human, suppressing the next
// INTERACTIVE run's prompt for a week.
//
// The cache is re-read rather than taking the decision's updatedCache: that is
// what makes the write preserve whatever last_check_at and latest_version are on
// disk now, and it leaves this seam usable (and testable) on its own. There is no
// declined_version and never will be — normalizeCache writes the fixed
// three-field shape, and a declined release is re-offered at the next window
// rather than being forgotten forever.
//
// Best-effort and total: an unwritable ~/.config, a corrupt cache, a hostile
// home/env bag and a broken clock all end in a null return, never a throw.
// Returns the cache it stamped, or null if nothing could be persisted.
export function recordPromptShown({
  now = Date.now,
  fs,
  processEnv = process.env,
  home,
} = {}) {
  const cacheArgs = { fs, processEnv: processEnv ?? {}, home }
  let cache
  try {
    cache = readVersionCache(cacheArgs)
  } catch {
    // Same boundary as resolveUpdateDecision: readVersionCache computes
    // versionCachePath() in a default parameter, ahead of its own try blocks, so
    // a non-string `home` or a truthy non-string XDG_CONFIG_HOME escapes it.
    cache = { ...EMPTY_VERSION_CACHE }
  }
  const stamped = { ...cache, last_prompted_at: new Date(epochMs(now)).toISOString() }
  try {
    writeVersionCache({ cache: stamped, ...cacheArgs })
  } catch {
    return null
  }
  return stamped
}

function buildDecision({
  latestVersion,
  currentVersion,
  source,
  updatedCache,
  promptDue = false,
}) {
  const isNewer =
    isValidSemver(latestVersion) &&
    isValidSemver(currentVersion) &&
    compareSemver(latestVersion.trim(), currentVersion.trim()) > 0
  return {
    latestVersion: latestVersion ?? null,
    isNewer,
    // #26: nothing to offer means nothing to ask, whatever the window says. The
    // `promptDue` default of false is what keeps the opt-out path — which reads
    // no cache, so it knows nothing about the prompt window — from prompting.
    shouldPrompt: isNewer && promptDue,
    source,
    updatedCache,
  }
}

// #24/#26: both weekly windows are read the same way, off the same interval, so
// they share one reader. "Due" means the window is open: a stamp that is missing,
// unparseable, or in the FUTURE (clock skew, or a clock since corrected) is due —
// never a window that silently never expires.
function windowDue(stamp, nowMs) {
  const stampedMs = Date.parse(stamp ?? '')
  const inside =
    Number.isFinite(stampedMs) &&
    stampedMs <= nowMs &&
    nowMs - stampedMs < UPDATE_CHECK_INTERVAL_MS
  return !inside
}

// #24: the largest epoch ms the Date type can represent; beyond it toISOString()
// throws a RangeError.
const MAX_EPOCH_MS = 8.64e15

// #24: `now` is a function returning epoch ms. Everything else — a non-function,
// a callback that throws, a non-finite result, a finite result outside the range
// Date can represent — falls back to the real clock. A wrong clock costs at most
// one extra registry query, or (#26) one extra prompt; an escape would abort
// `ralph start`.
function epochMs(now) {
  let value
  try {
    value = typeof now === 'function' ? now() : NaN
  } catch {
    value = NaN
  }
  const usable = Number.isFinite(value) && Math.abs(value) <= MAX_EPOCH_MS
  return usable ? value : Date.now()
}
