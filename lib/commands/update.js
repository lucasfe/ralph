import { execa } from 'execa'
import pc from 'picocolors'
import { failureCause, installFailureDetails } from '../install-failure.js'
import { classifyInstall, NPM_GLOBAL_UPDATE_LABEL } from '../install-target.js'
import {
  compareSemver,
  fetchLatestVersion,
  isValidSemver,
  NPM_VERSION_QUERY,
} from '../update-check.js'

class UpdateAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

// #21: a global operation — no git repo, no initialized Ralph project, no cwd.
// Every dependency is injected so `ralph start` can reuse it later (#24/#25).
//
// Returns {exitCode, updated, from, to}. `to` is "the version that is out there"
// — the answer from the channel this copy was installed from (#199: the registry for
// every layout but Homebrew, which answers from its tap), or the local version when
// already current, or null when that channel could not be read. It is NOT "the version
// now installed": on a refusal or a failed install, `to` still names the newer
// version. Consumers (#24) must gate on `updated`, never on `to`.
export async function updateCommand({
  force = false,
  currentVersion = 'unknown',
  ralphHome, // classifyInstall owns the RALPH_HOME default
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
  fetchLatest = fetchLatestVersion,
  classify = classifyInstall,
  timeoutMs = 5000,
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')
  const err = (msg) => stderr.write(msg + '\n')

  // 1. Where did this copy come from? #199: the classification answers two
  //    questions — how an update would run, and which channel to ask what the
  //    latest version is — so it has to come before the query rather than after
  //    it. Still no kind allowlist: a kind added later that carries an argv and a
  //    version query works without touching this file.
  const target = await classify({ ralphHome, exec })

  // The command a user can always run by hand. Every classification without an
  // argv has a null label too, so those keep printing the npm global install
  // exactly as they did before #199; a store row names its own manager, because
  // `npm install -g` into a pnpm/yarn/bun/brew layout would create a second
  // install rather than update this one.
  const byHand = target.label || NPM_GLOBAL_UPDATE_LABEL

  // 2. What is out there, in THAT channel? A failed query is reported and stops
  //    here — never a blind install of a version we could not confirm exists.
  //    #199: the failure names the channel it actually asked, so a Homebrew user
  //    is not told the npm registry is unreachable. A classification that carries
  //    no query at all (a caller's stub) means npm, as it does in fetchLatest.
  const latest = await fetchLatest(exec, timeoutMs, target.latest)
  if (!latest) {
    const unreachable = target.latest?.unreachable ?? NPM_VERSION_QUERY.unreachable
    err(pc.red(`❌ Could not read the latest published version (${unreachable}).`))
    out(`   Try again later, or update by hand: ${byHand}`)
    return { exitCode: 1, updated: false, from: currentVersion, to: null }
  }

  // 3. Nothing to do? --force still reinstalls, to repair a broken install.
  //    A currentVersion that isn't semver (e.g. 'unknown') can't be compared, so
  //    it counts as "behind" rather than silently short-circuiting.
  const alreadyLatest =
    isValidSemver(currentVersion) && compareSemver(latest, currentVersion) <= 0
  if (alreadyLatest && !force) {
    out(pc.green(`✅ Ralph is already up to date (${currentVersion}).`))
    return { exitCode: 0, updated: false, from: currentVersion, to: currentVersion }
  }

  // 4. Can we update this copy at all? A classification that recognized the layout
  //    and knows there is nothing to install carries `advice` (#22: an npx run, a
  //    linked dev checkout). Nothing failed, so that exits 0 — still no kind
  //    allowlist here, only the presence of the field. Checked BEFORE the argv, so
  //    "never install over a linked checkout" holds even for a classification that
  //    carries both.
  if (target.advice) {
    out('ℹ️  Nothing for Ralph to update here.')
    if (target.reason) out(`   ${target.reason}`)
    out(`   ${target.advice}`)
    return { exitCode: 0, updated: false, from: currentVersion, to: latest }
  }
  if (!target.argv?.length) {
    err(pc.red('❌ Could not tell how this copy of Ralph was installed, so it will not guess.'))
    if (target.reason) out(`   ${target.reason}`)
    out(`   Update by hand: ${byHand}`)
    return { exitCode: 1, updated: false, from: currentVersion, to: latest }
  }

  const isReinstall = force && alreadyLatest
  out(
    isReinstall
      ? pc.yellow(`Reinstalling Ralph ${currentVersion} (--force)…`)
      : `Updating Ralph ${currentVersion} → ${latest}…`,
  )

  // #23: the headline alone is opaque — a bounded tail of what the manager said,
  // plus the fix for a root-owned global prefix, comes from install-failure.js.
  // Both failure shapes (a non-zero exit, and a command that never ran) report
  // the same way, so neither can silently lose its diagnostics.
  const reportFailure = (headline, failure) => {
    err(pc.red(headline))
    for (const line of installFailureDetails(failure, target)) err(line)
  }

  const [cmd, ...args] = target.argv
  let result
  try {
    result = await exec(cmd, args, { reject: false })
  } catch (e) {
    // #23: never `e.message` raw. It is neither one line nor bounded — execa's
    // ExecaError puts the whole subprocess output in it — so a raw headline would
    // break the one-write-per-line contract AND flood past the tail's bound.
    // `reject: false` also means execa RESOLVES a command it could not spawn, so
    // what lands here is a misused option, not a missing npm; the cause is still
    // named, bounded, and the rest goes through the details below.
    const cause = failureCause(e)
    reportFailure(
      `❌ Update failed: could not run \`${target.label}\`${cause ? ` (${cause})` : ''}.`,
      e,
    )
    return { exitCode: 1, updated: false, from: currentVersion, to: latest }
  }
  const exitCode = result?.exitCode ?? 1
  if (exitCode !== 0) {
    reportFailure(`❌ Update failed: \`${target.label}\` exited ${exitCode}.`, result)
    return { exitCode, updated: false, from: currentVersion, to: latest }
  }

  out(
    isReinstall
      ? pc.green(`✅ Reinstalled Ralph ${latest}.`)
      : pc.green(`✅ Updated Ralph ${currentVersion} → ${latest}.`),
  )
  return { exitCode: 0, updated: true, from: currentVersion, to: latest }
}

export { UpdateAbort }
