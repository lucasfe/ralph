import pc from 'picocolors'
import { checkDeps, commandExists } from '../deps.js'
import { detectPlatform } from '../platform.js'
import { resolveAgent } from '../agent-registry.js'
import { resolveSource } from '../task-source.js'
import { compareSemver, isValidSemver, PACKAGE_NAME } from '../update-check.js'
import { readVersionCache } from '../version-cache.js'

class DoctorAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export async function doctorCommand({
  stdout = process.stdout,
  stderr = process.stderr,
  hasCommand = commandExists,
  platform = detectPlatform(),
  env = process.env,
  // #27: the installed version, threaded from package.json by bin/ralph.js. The
  // same 'unknown' fallback the other commands use — a caller that cannot say
  // gets a line that claims nothing rather than a fabricated comparison.
  currentVersion = 'unknown',
  // #27: fs impl + home for the GLOBAL update-check cache — injected (memfs) in
  // tests so no run touches the real ~/.config/ralph. Undefined falls through to
  // version-cache's own defaults (the real fs, the real home).
  cacheFs,
  home,
  readCache = readVersionCache,
} = {}) {
  const out = (m) => stdout.write(m + '\n')
  const err = (m) => stderr.write(m + '\n')

  // #554: validate the SELECTED agent's CLI, not always claude's, and report
  // which agent it validated. RALPH_AGENT unset => claude (behavior unchanged
  // for existing users).
  const { agent, warning } = resolveAgent(env)
  // #565: gate gh on the resolved task source (folder mode does not need gh).
  const source = resolveSource(env)
  const results = checkDeps({ hasCommand, agent, source })
  const missingCritical = results.filter((r) => !r.present && r.critical)
  const missingNonCritical = results.filter((r) => !r.present && !r.critical)

  out(`Ralph doctor — platform: ${platform} — agent: ${agent}`)
  if (warning) out(pc.yellow(`  ! ${warning}`))
  // #27: "am I current?", answered from the cache #24 writes and NOTHING else —
  // doctor takes no exec dependency and opens no socket. This is the command
  // people reach for when things are already broken, possibly offline, so it has
  // to stay fast and must not acquire a network dependency.
  //
  // Printed HERE, above the dep report, so it survives the missing-critical early
  // return below: a broken setup is exactly when "what version is this?" matters.
  // It is additive OUTPUT only — nothing below reads it, and the exitCode this
  // function returns must never move because a new version shipped, or every
  // wrapper and CI step gating on `ralph doctor` starts failing on release day.
  out(
    renderVersionLine({
      currentVersion,
      latestVersion: cachedLatestVersion({ readCache, fs: cacheFs, processEnv: env, home }),
    }),
  )
  out('')

  for (const r of results) {
    if (r.present) {
      out(`  ${pc.green('✓')} ${r.name}`)
    } else if (r.critical) {
      out(`  ${pc.red('✗')} ${r.name} (required)`)
      out(`      install: ${installFor(r, platform)}`)
    } else {
      out(`  ${pc.yellow('!')} ${r.name} (optional)`)
      out(`      install: ${installFor(r, platform)}`)
    }
  }

  out('')
  if (missingCritical.length > 0) {
    err(
      pc.red(
        `Missing ${missingCritical.length} required dep(s): ${missingCritical
          .map((r) => r.name)
          .join(', ')}`,
      ),
    )
    return { exitCode: 1, missingCritical, missingNonCritical, platform }
  }

  if (missingNonCritical.length > 0) {
    out(
      pc.yellow(
        `Optional deps missing: ${missingNonCritical.map((r) => r.name).join(', ')}`,
      ),
    )
  } else {
    out(pc.green('All deps present.'))
  }
  return { exitCode: 0, missingCritical, missingNonCritical, platform }
}

export function assertCriticalDeps({
  hasCommand = commandExists,
  platform = detectPlatform(),
  env = process.env,
} = {}) {
  const { agent } = resolveAgent(env)
  const source = resolveSource(env)
  const results = checkDeps({ hasCommand, agent, source })
  const missingCritical = results.filter((r) => !r.present && r.critical)
  if (missingCritical.length === 0) return { ok: true, missingCritical: [] }
  const formatted = missingCritical
    .map((r) => `❌ '${r.name}' not found in PATH (install: ${installFor(r, platform)})`)
    .join('\n')
  return { ok: false, missingCritical, message: formatted }
}

function installFor(dep, platform) {
  return dep.install[platform] || dep.install.linux
}

// #27: the last-known latest version, read from the global update-check cache.
// No registry query, no cache WRITE, no throttle bookkeeping — the weekly check
// belongs to `ralph start`, and doctor only reports what it left behind. That is
// also why the opt-out (RALPH_NO_UPDATE_CHECK) is NOT consulted here: it disables
// checking, and an opted-out user simply has an empty cache, which renders as
// "unknown" on its own.
function cachedLatestVersion({ readCache, fs, processEnv, home }) {
  let latest
  try {
    // The call AND the property read both sit inside the guard, so `latest_version`
    // is read exactly once into a local. The load-bearing reason is the TypeError
    // described in the catch below, which the call itself can throw. The secondary
    // one is the `readCache` seam: production always gets normalizeCache's fresh
    // literal, whose latest_version is string|null, but a TEST-injected reader is
    // bound by no such guarantee — reading the property twice out here would let a
    // stub answer isValidSemver and .trim() differently.
    latest = readCache({ fs, processEnv, home })?.latest_version
  } catch {
    // Load-bearing — do NOT delete this as redundant, for the same reason as the
    // guard in update-check.js: readVersionCache is total for FILE-level failures,
    // but its `path` default parameter computes versionCachePath() BEFORE its own
    // try blocks, so a non-string `home` or a truthy non-string XDG_CONFIG_HOME
    // throws a TypeError straight out of it. A cache doctor cannot read is a
    // missing answer, never a crashed diagnostic.
    return null
  }
  // A hand-edited latest_version survives normalization as long as it is a
  // non-blank string ("banana"), so validate before believing it.
  return isValidSemver(latest) ? latest.trim() : null
}

const UPDATE_HINT = `run npm i -g ${PACKAGE_NAME}`

// #27: one line, and the installed version leads in every state — that is the
// fact a user always wants. "cached latest" is the wording on purpose: doctor
// reports what the last check found, it does not check.
function renderVersionLine({ currentVersion, latestVersion }) {
  const installed = versionLabel(currentVersion)
  const prefix = `version: ${installed}`
  if (!latestVersion) {
    return `${prefix} — cached latest: unknown (no update check cached yet)`
  }
  // An installed version that is not semver ('unknown', 42, an odd dev build)
  // cannot be compared: state both values and claim neither verdict. Both checks
  // below read `installed` — the already-normalized string — and never the raw
  // currentVersion, so nothing here depends on the order of these two ifs or on a
  // hostile currentVersion having been filtered out upstream.
  if (!isValidSemver(installed)) return `${prefix} — cached latest: ${latestVersion}`
  const behind = compareSemver(latestVersion, installed) > 0
  return behind
    ? pc.yellow(`${prefix} — cached latest: ${latestVersion} — update available (${UPDATE_HINT})`)
    : pc.green(`${prefix} — cached latest: ${latestVersion} — up to date`)
}

function versionLabel(version) {
  const trimmed = typeof version === 'string' ? version.trim() : ''
  return trimmed.length ? trimmed : 'unknown'
}

export { DoctorAbort }
