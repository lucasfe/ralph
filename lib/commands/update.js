import { execa } from 'execa'
import pc from 'picocolors'
import { classifyInstall, NPM_GLOBAL_UPDATE_LABEL } from '../install-target.js'
import { compareSemver, fetchLatestVersion, isValidSemver } from '../update-check.js'

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
// — the registry answer, or the local version when already current, or null when
// the registry could not be reached. It is NOT "the version now installed": on a
// refusal or a failed install, `to` still names the newer version. Consumers
// (#24) must gate on `updated`, never on `to`.
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

  // 1. What is out there? A failed query is reported and stops here — never a
  //    blind install of a version we could not confirm exists.
  const latest = await fetchLatest(exec, timeoutMs)
  if (!latest) {
    err(pc.red('❌ Could not read the latest published version (npm registry unreachable?).'))
    out(`   Try again later, or update by hand: ${NPM_GLOBAL_UPDATE_LABEL}`)
    return { exitCode: 1, updated: false, from: currentVersion, to: null }
  }

  // 2. Nothing to do? --force still reinstalls, to repair a broken install.
  //    A currentVersion that isn't semver (e.g. 'unknown') can't be compared, so
  //    it counts as "behind" rather than silently short-circuiting.
  const alreadyLatest =
    isValidSemver(currentVersion) && compareSemver(latest, currentVersion) <= 0
  if (alreadyLatest && !force) {
    out(pc.green(`✅ Ralph is already up to date (${currentVersion}).`))
    return { exitCode: 0, updated: false, from: currentVersion, to: currentVersion }
  }

  // 3. Can we update this copy at all? The classification answers that with an
  //    argv to run, or nothing — so no kind allowlist here: a kind added in #22
  //    that carries an argv works without touching this file.
  const target = await classify({ ralphHome, exec })

  // A classification that recognized the layout and knows there is nothing to
  // install carries `advice` (#22: an npx run, a linked dev checkout). Nothing
  // failed, so that exits 0 — still no kind allowlist here, only the presence of
  // the field. Checked BEFORE the argv, so "never install over a linked checkout"
  // holds even for a classification that carries both.
  if (target.advice) {
    out('ℹ️  Nothing for Ralph to update here.')
    if (target.reason) out(`   ${target.reason}`)
    out(`   ${target.advice}`)
    return { exitCode: 0, updated: false, from: currentVersion, to: latest }
  }
  if (!target.argv?.length) {
    err(pc.red('❌ Could not tell how this copy of Ralph was installed, so it will not guess.'))
    if (target.reason) out(`   ${target.reason}`)
    out(`   Update by hand: ${NPM_GLOBAL_UPDATE_LABEL}`)
    return { exitCode: 1, updated: false, from: currentVersion, to: latest }
  }

  const isReinstall = force && alreadyLatest
  out(
    isReinstall
      ? pc.yellow(`Reinstalling Ralph ${currentVersion} (--force)…`)
      : `Updating Ralph ${currentVersion} → ${latest}…`,
  )

  const [cmd, ...args] = target.argv
  let result
  try {
    result = await exec(cmd, args, { reject: false })
  } catch (e) {
    err(pc.red(`❌ Update failed: could not run \`${target.label}\` (${e.message}).`))
    return { exitCode: 1, updated: false, from: currentVersion, to: latest }
  }
  const exitCode = result?.exitCode ?? 1
  if (exitCode !== 0) {
    // Richer diagnostics (stderr tail, permission hints) land in #23.
    err(pc.red(`❌ Update failed: \`${target.label}\` exited ${exitCode}.`))
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
