import { resolve } from 'node:path'
import pc from 'picocolors'
import { checkDeps, commandExists } from '../deps.js'
import { detectPlatform } from '../platform.js'
import { resolveAgent } from '../agent-registry.js'
import { resolveSource } from '../task-source.js'
import { isValidSemver } from '../update-check.js'
import { readVersionCache } from '../version-cache.js'
// #75: the identity box, and the two modules that decide it. `composeBanner` is the box
// itself — the same one `ralph start` has drawn since #68 — and `resolveBannerMode` is the
// single owner of what RALPH_BANNER means. Doctor holds neither decision: it resolves facts
// and forwards a width, exactly as `ralph start` does.
//
// NO SPRITE, NO ANIMATION, AT ANY SETTING — and this import list is where that is decided,
// which is why the argument is written here once and cross-referenced from below rather than
// restated beside every line it constrains.
//
// It is the ABSENCE of an import rather than a branch: the pixels live in lib/sprite-banner.js
// and in the splash player beside it, and this file reaches NEITHER — not even for the
// `colorEnabled` helper `ralph start` uses, because one boolean is not worth putting an
// animation one edit away from a command people pipe into a bug report. `pc.isColorSupported`
// is the same question asked of a module doctor already imports for every ✓ and ✗ it prints.
// `ralph start`'s splash is a curtain going up on a long-running loop; doctor is a diagnostic
// that is frequently piped, and a command whose output people quote has no business moving the
// cursor. doctor.version-line.qa.test.js walks this file's whole import graph and pins the
// bare-specifier set, so a future import that dragged in a sprite, execa or a socket fails
// there rather than in the field.
import { composeBanner } from '../banner-compose.js'
import { resolveBannerMode } from '../banner-mode.js'
import { readConfigText } from '../read-config-source.js'
import { parseConfigVar } from '../parse-config-var.js'

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
  // #75: where the run is happening, and where ralph.config.sh is looked for. Injected
  // rather than read at the point of use for the reason #41 states once for the whole
  // package: a command that called `process.cwd()` inside itself would print the suite's
  // directory in every test, and the box's `cwd` row is a fact worth asserting.
  cwd = process.cwd(),
  // #75: the config read, as two seams. Doctor's ONE new impure act is a text read of
  // ralph.config.sh — no shell, no source, no write — because RALPH_BANNER is a setting
  // people put in that file and a knob that answered differently in `ralph doctor` than in
  // `ralph start` would be a knob nobody could trust. `readConfigText` never throws, so a
  // config nobody can read costs a picture at worst.
  exists,
  readFile,
  // #75: whether ANSI may be emitted. `pc.isColorSupported` is picocolors' own answer, out
  // of a module this file already imports for every ✓ and ✗ it prints — deliberately NOT
  // sprite-banner.js's `colorEnabled`, see the import note above. Injectable because it is
  // impure: picocolors decides it once at import from the real environment, which is exactly
  // the ambient capability the tests need to be able to pin.
  color = pc.isColorSupported,
  // #75: the terminal's width, for #72's degradation ladder — a terminal reports its
  // columns, a pipe reports `undefined`, and `bannerLayout` reads both. Resolved from the
  // stream doctor was handed rather than from `process.stdout`, so a piped or captured run
  // is measured on the stream it is actually writing to.
  columns = stdout?.columns,
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

  // #75: THE IDENTITY BOX, and it replaces two lines rather than joining them.
  //
  // What used to print here was `Ralph doctor — platform: mac — agent: claude` and, under it,
  // #27's `version: 0.17.0 — cached latest: 0.18.0 — up to date`. Every fact in both of those
  // is now a row in the box and NEITHER LINE SURVIVES, which is the whole point of the slice:
  // doctor is the command people paste into a bug report, and a paste is worth more when one
  // block carries which Ralph, which platform, which agent, how stale it is and where it ran
  // than when the same facts are spread over two sentences and a heading.
  //
  // THE FACTS, and the two the box has never been given before. `os` and `agent` are exactly
  // what the old header carried, `cwd` is the fact `ralph start`'s box has carried since #68,
  // and `cachedLatest` is #27's verdict — see its own note below for why it is a fact of its
  // own rather than the `latestVersion` `ralph start` passes.
  //
  // STILL FIRST, and still above the missing-critical early return further down. That was
  // #27's argument for putting the version line here and it applies with more force to a box:
  // a broken setup is exactly the run where "which version, which agent" is the question being
  // asked, and a header printed after the guard would be missing from the one run that needed
  // it. It remains additive OUTPUT ONLY — nothing below reads it, and the exit code this
  // function returns must never move because a new version shipped, or every wrapper and CI
  // step gating on `ralph doctor` starts failing on release day.
  //
  // ...and a box only, never a sprite and never an animation — see the import note at the top
  // of this file, which is where that is enforced and argued.
  //
  // The one new impure act first, in the two steps `ralph start` already spells it in (#74):
  // read ralph.config.sh as TEXT, then ask that text one question. Inert by construction —
  // `readConfigText` runs no shell, writes nothing and answers '' for a file that is missing
  // or unreadable rather than throwing — so the worst a hostile config can cost this command
  // is a picture. Same reader, same file, same precedence as `ralph start`, which is what
  // makes RALPH_BANNER one knob rather than two that happen to share a name.
  const configText = readConfigText(configPathFor(cwd), { exists, readFile })
  // NO `isTTY` IS PASSED, and the omission is the point: without it the resolver can only ever
  // answer `sprite: false`, so no arrangement of this command's arguments authorises a pixel —
  // structural rather than a matter of discipline. `box` is the one field read of the four
  // returned, and it does not depend on TTY-ness by design (see banner-mode.js: the terminal
  // caps the SPRITE, never the FACTS — a piped `ralph doctor` is precisely a paste into a bug
  // report), while `mode` and `sprite` are questions about an animation doctor cannot draw.
  //
  // AND THE `warning` IS DELIBERATELY LEFT UNPRINTED. `ralph start` complains about a mistyped
  // RALPH_BANNER; doctor does not, and that is a choice rather than an impossibility: wording it
  // safely means `oneLine`, which is a seven-line pure function that happens to live in
  // lib/digest.js — a module that imports execa — so printing it means either an exec dependency
  // this command is built on not having, or extracting `oneLine` into a module of its own, which
  // is a refactor #75 declined to smuggle in. A typo therefore costs a user nothing here: they
  // get the default box, silently, and `ralph start` tells them.
  const banner = resolveBannerMode({
    configured: parseConfigVar(configText, 'RALPH_BANNER'),
    override: env?.RALPH_BANNER,
    color,
    width: columns,
  })
  if (banner.box) {
    for (const line of composeBanner({
      facts: {
        version: currentVersion,
        os: platform,
        agent,
        // #27's verdict, moved WHOLE: "am I current?", answered from the cache #24 writes and
        // NOTHING else — no registry query, no socket, no exec, no cache write. This is the
        // command people reach for when things are already broken and possibly offline.
        //
        // `cachedLatest` rather than `latestVersion`, and the difference is the whole reason
        // `ralph start`'s box is unchanged by this slice. `latestVersion` asks the box for
        // ADVICE and only produces a row when there is something to act on; `cachedLatest`
        // asks it for a READING of the cache and always produces one, including the
        // "nobody has checked yet" state that a diagnostic must not swallow. Doctor passes
        // this one and never that one, so `ralph start` cannot grow a row and doctor cannot
        // lose a verdict.
        cachedLatest: cachedLatestVersion({ readCache, fs: cacheFs, processEnv: env, home }),
        cwd,
      },
      width: columns,
      capabilities: { color },
    })) {
      out(line)
    }
  }
  // The agent fallback warning, UNDER the box it annotates and on stdout, which is where
  // doctor has always put it: this command's whole output is a report, and a warning about
  // the very agent the box names belongs in the paste rather than on a stream a user
  // redirecting to a file would lose. It survives `RALPH_BANNER=off` — the knob silences a
  // picture, never a diagnostic.
  if (warning) out(pc.yellow(`  ! ${warning}`))
  // The blank line between the identity block and the dependency report, and it is printed
  // only when there is something above it to separate. `RALPH_BANNER=off` therefore means
  // exactly what it means in `ralph start`: not one byte between the command line and the
  // first line of the report, rather than an orphan blank where the box used to be.
  if (banner.box || warning) out('')

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

// #75: where ralph.config.sh is, or nothing at all.
//
// `resolve` THROWS on a non-string, and `cwd` reaches this function from a caller's bag —
// bin/ralph.js passes `process.cwd()`, but this is an exported API and #41's whole argument is
// that every impure default is also an injectable option. A `TypeError` out of a path join is
// not a failure mode `ralph doctor` may have: the command exists to be run when things are
// already broken. `readConfigText` reads '' for a falsy path, so "no usable cwd" and "no
// config file" arrive at the same place by the same route.
function configPathFor(cwd) {
  return typeof cwd === 'string' && cwd.length ? resolve(cwd, 'ralph.config.sh') : ''
}

export { DoctorAbort }
