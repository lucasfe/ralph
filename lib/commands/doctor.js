// #201: the two probes the `channel` row needs, and the ONLY reason this file may import
// `node:fs` at all — `node:fs` is already in the bare-specifier set doctor's import-graph spec
// allows (the config read and the version cache both reach it), so the row costs the graph
// nothing. They are the DEFAULT for an injectable option rather than a call site: see
// `installFs` below.
import { existsSync, lstatSync } from 'node:fs'
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
import { parseConfigSource, readConfigText } from '../read-config-source.js'
import { parseConfigVar } from '../parse-config-var.js'
// #125: the Jira auth probe, and it is on this graph on PURPOSE while the thing
// that runs a subprocess is not. lib/jira-auth.js imports nothing at all — the
// process runner reaches it as an argument, from bin/ralph.js, so the constraint
// the import note above spends a paragraph on survives a row whose whole content
// is the result of running a command. See the `exec` option below for the seam.
import { probeJiraAuth as realProbeJiraAuth } from '../jira-auth.js'
// #201: which channel this copy of Ralph was installed from, for the box's `channel` row.
//
// lib/install-markers.js is the PURE half of install-layout recognition, and it exists because
// of the import note above rather than in spite of it: the module that decides how an install
// is UPDATED (lib/install-target.js) has to spawn `npm root -g` to recognize a plain global
// npm install, so it imports a process runner and is permanently off this graph. #201 cut the
// part that only matches path segments out of it, so the diagnostic can answer "how was this
// installed?" at the cost of one `exists` and one `lstat`, and no subprocess at all. The two are
// deliberately NOT the same call: `existsSync` follows symlinks, which is what lets a `npm link`ed
// root find the checkout's `.git` and is why a checkout outranks a symlink (the reason is written
// out at install-markers.js:259). The wording lives over there, on the same table row as the
// marker that earned it — this file decides only that the row is drawn and with which seams.
import { describeInstallChannel } from '../install-markers.js'

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
  // #125: the Jira auth question, as two seams — and the asymmetry between them is
  // the whole design.
  //
  // `probeJiraAuth` is defaulted, because it is a pure decision (run one command,
  // read one exit code) that a test wants to stub. `exec` is NOT: it has no
  // default here, deliberately, because a default would mean importing a process
  // spawner into this file, and the import note at the top of this module explains
  // at length why that must stay impossible. bin/ralph.js passes the real one, so
  // a user running `ralph doctor` gets a real answer; a caller that passes none
  // gets a row that says the question went UNASKED rather than a fabricated
  // failure or a crash. Doctor is the command people run when things are already
  // broken — "I could not check" is a legitimate diagnostic finding, and the one
  // thing it must never do is invent a verdict.
  //
  // Read only when the resolved source is jira, so no other run's output moves.
  //
  // #134: `ralph cycle`'s preflight now defaults the SAME import on the SAME convention,
  // and that sharing is a guarantee rather than a coincidence — a diagnostic printing
  // `✓ jira auth` on a machine where the cycle refuses to start is worse than no row at
  // all. If this ever stops being lib/jira-auth.js's probeJiraAuth, change both.
  probeJiraAuth = realProbeJiraAuth,
  exec,
  // #201: the install directory whose channel the `channel` row reports, and its two link
  // probes — the same asymmetry as `probeJiraAuth`/`exec` directly above, for the same reason
  // and by that precedent.
  //
  // `ralphHome` is NOT DEFAULTED, deliberately. The default would be `RALPH_HOME` out of
  // lib/paths.js, which reaches `node:url` — a bare specifier the import-graph spec this
  // module's header describes does not allow, so defaulting it would break the guarantee to
  // draw one row. bin/ralph.js passes the real one, exactly as it passes `exec`, so a user
  // running `ralph doctor` gets a real answer; a caller that passes none gets NO ROW rather
  // than a fabricated channel. That silence is the honest reading: an absent argument means
  // nobody asked, and this row's whole value on a bug report is that a reader can trust it.
  //
  // `installFs` IS defaulted, because `node:fs` is already on this graph and two `lstat`-shaped
  // reads of one directory are the row's entire cost. Injectable because it is impure (#41),
  // and because the linked layouts are the only ones a test cannot express as a path literal.
  // Any value it cannot use answers "not a link", which is the same answer a plain directory
  // gets — the caller that would be harmed by that default is lib/install-target.js, which is
  // about to overwrite the directory, and it supplies its own real filesystem instead.
  ralphHome,
  installFs = { existsSync, lstatSync },
} = {}) {
  const out = (m) => stdout.write(m + '\n')
  const err = (m) => stderr.write(m + '\n')

  // #554: validate the SELECTED agent's CLI, not always claude's, and report
  // which agent it validated. RALPH_AGENT unset => claude (behavior unchanged
  // for existing users).
  const { agent, warning } = resolveAgent(env)
  // ralph.config.sh AS TEXT, read once here and asked two questions — the task
  // source on the next line and RALPH_BANNER at the box below. One read, because
  // read-config-source.js states the rule for every caller that wants two settings
  // out of this file: parsing the same text twice is how two questions about one
  // config start answering differently. Inert by construction — `readConfigText`
  // runs no shell, writes nothing and answers '' for a file that is missing or
  // unreadable rather than throwing — so the worst a hostile config can cost this
  // command is a picture and a default. The full argument for doctor reading this
  // file at all is at the `exists`/`readFile` options above.
  const configText = readConfigText(configPathFor(cwd), { exists, readFile })
  // #565: gate gh on the resolved task source (folder mode does not need gh).
  //
  // #125: CONFIG FIRST, environment second — the same
  // `parseConfigSource(configText) || env` shape status.js and cycle.js spell, and
  // for the reason #120 settled for GH_REPO: `ralph init --source jira` WRITES this
  // knob into ralph.config.sh and never exports it, and templates/ralph.sh sources
  // that file with `set -a`, so the file is where the loop's answer comes from.
  // Reading only the environment made every user who configured the source the way
  // init writes it invisible to this command: no acli row, no auth row, a gh row
  // they do not need — a knob answering differently in `ralph doctor` than in
  // `ralph start`, which is precisely what the config-read note refuses to allow for
  // RALPH_BANNER two paragraphs down.
  //
  // #149 REOPENED EXACTLY THAT GAP FOR ONE SPELLING, and this line is knowingly on the old side
  // of it. That slice moved `ralph start` onto a PRESENCE test — the file decides for a name the
  // file ASSIGNS, blank included, because `set -a` exports a blank OVER an inherited value — while
  // this `||` still reaches past a blanked `TASK_SOURCE=""` into the environment. So a config that
  // blanks the knob while a shell exports `jira` gets a jira report here and a github launch
  // there. Left alone deliberately: #149's criteria are about the identity box and the preflight
  // `ralph start` spends its own binding on, and moving three more commands onto a different
  // precedence is three more behaviour changes.
  //
  // THE FOLLOW-UP, written out rather than pointed at, because it has no issue number yet and a
  // reader who finds this divergence should not have to reconstruct it. Three sites hold the old
  // `||`: this one, on the `resolveSource` call immediately below, plus status.js:384 and
  // cycle.js:194 — all three spelled
  // `parseConfigSource(configText) || <environment>.TASK_SOURCE`. Closing it means replacing each
  // with the presence test `ralph start` now uses, which is
  // `configAssignsVar(configText, 'TASK_SOURCE') ? parseConfigVar(configText, 'TASK_SOURCE') :
  // <environment>.TASK_SOURCE` — the shape at start.js's `sourcedValue`. They move TOGETHER for the
  // reason the paragraph above gives: a knob that answers one way in `ralph doctor` and another in
  // `ralph status` is the same defect one command over. The one behaviour that changes for each is
  // the one #149 changed for `ralph start`: a config line that blanks the knob stops falling through
  // to the environment and starts meaning github, which is what `set -a` really does.
  const source = resolveSource({
    TASK_SOURCE: parseConfigSource(configText) || env?.TASK_SOURCE,
  })
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
  // The one new impure act, in the two steps `ralph start` already spells it in (#74): read
  // ralph.config.sh as TEXT, then ask that text a question. The read itself is HOISTED to the
  // top of this function (#125, where its own note lives) because the task source asks the same
  // text the same way; what is spent here is the second question. Same reader, same file, same
  // precedence as `ralph start`, which is what makes RALPH_BANNER one knob rather than two that
  // happen to share a name.
  //
  // NO `isTTY` IS PASSED, and the omission is the point: without it the resolver can only ever
  // answer `sprite: false`, so no arrangement of this command's arguments authorises a pixel —
  // structural rather than a matter of discipline. `box` is the one field read of the four
  // returned, and it does not depend on TTY-ness by design (see banner-mode.js: the terminal
  // caps the SPRITE, never the FACTS — a piped `ralph doctor` is precisely a paste into a bug
  // report), while `mode` and `sprite` are questions about an animation doctor cannot draw.
  //
  // AND THE `warning` IS DELIBERATELY LEFT UNPRINTED. `ralph start` complains about a mistyped
  // RALPH_BANNER; doctor does not, and since #108 that is PURELY an editorial choice rather than
  // anything about the import graph: the extraction that #75 declined to smuggle in has now
  // happened (lib/one-line.js, which imports nothing), so wording it safely is available to this
  // command and no longer implies the exec dependency it is built on not having. The judgement
  // that stands on its own is the one that was always the better half of the argument: a typo in
  // a COSMETIC knob is not worth a line in a diagnostic. A user who misspells RALPH_BANNER gets
  // the default box, silently, and `ralph start` — the command the knob is actually about — tells
  // them. Adding the line here would also put the string `RALPH_BANNER` in the report, which
  // lib/commands/doctor.identity-box.qa.test.js pins as absent.
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
        // #201: ...and WHICH CHANNEL that cached answer was about. The row sits directly under
        // `cached` (lib/banner-rows.js decides where), because npm and the Homebrew tap hold
        // different versions on purpose (#196) and a version verdict a reader cannot attribute
        // to a channel is a verdict they cannot act on. Absent when the caller passed no
        // install directory, which draws no row at all.
        channel: installChannel(ralphHome, installFs),
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

  // #125: JIRA AUTH, and only under TASK_SOURCE=jira.
  //
  // `acli` on PATH is a dependency and gets a row above from checkDeps; `acli`
  // LOGGED IN is not, and this is it. It sits with the dependency rows because
  // that is where a reader looks for "what is missing", and it borrows their
  // visual grammar exactly — a green ✓, or a yellow ! with an indented
  // second line naming the command that fixes it, the same shape as `install:`.
  //
  // YELLOW AND NEVER RED, in both failing states, because this row DOES NOT MOVE
  // THE EXIT CODE. `✗ name (required)` means "doctor exited 1 because of this" in
  // every other line of this report, and borrowing it for something that exits 0
  // would make the report's own vocabulary lie. Auth is REPORTED, not enforced —
  // the same treatment doctor already gives agent CLI health, and for the same
  // reason: an expired token must not start failing every wrapper and CI step
  // that gates on `ralph doctor`, and the loop's own preflight (lib/commands/
  // cycle.js) is where authentication actually blocks work.
  //
  // Printed ABOVE the missing-critical early return below, so the run where the
  // setup is broken is not the run that loses the row.
  //
  // THREE STATES, resolved by jiraAuthState below and never by this render: the
  // answer arrives as 'ok' | 'no' | 'unknown' precisely so that no arrangement of
  // this command's arguments can turn the auth question into an exception thrown
  // out of a diagnostic. See that function for the guard and its argument.
  if (source === 'jira') {
    const auth = await jiraAuthState({ probe: probeJiraAuth, exec })
    if (auth === 'ok') {
      out(`  ${pc.green('✓')} jira auth`)
    } else if (auth === 'no') {
      out(`  ${pc.yellow('!')} jira auth (not authenticated)`)
      out(`      login: acli jira auth login`)
    } else {
      out(`  ${pc.yellow('!')} jira auth (not verified)`)
      out(`      check: acli jira auth status`)
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

// #125: the Jira auth question, as one of THREE states and never as a throw —
// 'ok' (the probe said yes), 'no' (the probe said no), 'unknown' (nobody could
// ask). Total for every value of both seams, on exactly the argument
// cachedLatestVersion above makes for `readCache`: `probe` and `exec` are a
// CALLER'S values, this is an exported command, and a diagnostic that crashed
// over its own arguments would fail in the one situation it exists for. Getting
// the row wrong costs a line; throwing costs the whole report AND the exit code
// the dependency check already computed.
//
// A BROKEN PROBE IS 'unknown' RATHER THAN 'no', and that is the deliberate half of
// this function. A probe that threw, rejected or was never callable did not reach
// a verdict — it is the same epistemic state as having no `exec` at all, and the
// row's job is to say "I could not check" and how to check by hand. Answering 'no'
// would put a failure in the report that nothing observed, which for a command
// people paste into bug reports is the more expensive mistake.
async function jiraAuthState({ probe, exec }) {
  // NOTHING CALLABLE TO RUN ACLI WITH => the question cannot be put at all, which
  // is 'unknown' by the paragraph above. `typeof` rather than truthiness,
  // deliberately: a caller that passed `42`, `{}` or the string 'acli' for this seam
  // is as unable to run a subprocess as one that passed nothing, and rendering that
  // as "not authenticated" would report a login failure nobody observed — the exact
  // fabrication this function's stated rule forbids. See doctorCommand's own note on
  // why the seam is undefaulted in the first place.
  if (typeof exec !== 'function') return 'unknown'
  try {
    // The call AND the `ok` read both sit inside the guard, for cachedLatestVersion's
    // reason: the property access is the caller's code too. Production always gets
    // lib/jira-auth.js's fresh `{ ok, reason }` literal, but an injected probe is
    // bound by no such guarantee and an `ok` getter that throws must degrade like
    // any other failure.
    const auth = await probe({ exec })
    if (auth?.ok) return 'ok'
    // Truthiness on `ok`, deliberately not `=== true`: doctor believes a probe that
    // answered affirmatively rather than second-guessing its shape, and
    // doctor.jira-auth.qa.test.js pins which side of that line this is on. An
    // answer object with no usable `ok` is still an ANSWER — the probe ran and
    // declined to confirm — so it is 'no'; nothing at all is 'unknown'.
    return auth ? 'no' : 'unknown'
  } catch {
    return 'unknown'
  }
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

// #201: the install channel as a FACT the box can gate on — the wording, or nothing.
//
// GATED ON `typeof`, the same shape `configPathFor` uses one function up and for the same
// reason: `ralphHome` reaches this from a caller's bag, and a non-string is not a path that
// went unread, it is a caller that never asked. Deciding it here rather than with a `try` is
// what makes it safe without a guard a reader has to take on trust — a bag whose `toString`
// throws is never asked for one, so there is no failure to swallow. It also keeps the one
// genuinely dangerous coercion out: `String(0)` is `'0'`, which resolves against the process's
// cwd, and a diagnostic that described some directory the install has nothing to do with would
// be worse than one that said nothing.
//
// The blank cases are gated on the far side, by the pure module, which answers null for them —
// and lib/banner-rows.js's `factRows` draws no row for either answer. Two gates on one fact,
// left in place deliberately, exactly as that file's own note argues: the builder that makes a
// row owns that row's sanitisation, and this one owns the coercion it refuses to perform.
function installChannel(ralphHome, fs) {
  return typeof ralphHome === 'string' ? describeInstallChannel({ ralphHome, fs }) : null
}

export { DoctorAbort }
