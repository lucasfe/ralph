import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  unlinkSync as realUnlinkSync,
  writeFileSync as realWriteFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { execa } from 'execa'

export const LABEL_PREFIX = 'com.lucasfe.ralph.cycle'
export const DEFAULT_PATH =
  '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

export function labelFor(slug) {
  return `${LABEL_PREFIX}.${slug}`
}

export function plistPathFor(slug, home = homedir()) {
  return join(home, 'Library', 'LaunchAgents', `${labelFor(slug)}.plist`)
}

export function buildPlist({
  slug,
  command,
  args = [],
  intervalSeconds,
  workingDirectory,
  logDir,
  environment,
}) {
  const env = { PATH: DEFAULT_PATH, ...(environment || {}) }
  const programArgsXml = [command, ...args]
    .map((s) => `        <string>${escapeXml(s)}</string>`)
    .join('\n')
  const envEntries = Object.entries(env)
    .map(
      ([k, v]) =>
        `        <key>${escapeXml(k)}</key>\n        <string>${escapeXml(v)}</string>`,
    )
    .join('\n')
  const stdoutPath = join(logDir, 'ralph-cycle.out.log')
  const stderrPath = join(logDir, 'ralph-cycle.err.log')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(labelFor(slug))}</string>
    <key>ProgramArguments</key>
    <array>
${programArgsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(workingDirectory)}</string>
    <key>StartInterval</key>
    <integer>${Number(intervalSeconds)}</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
</dict>
</plist>
`
}

export async function installAgent({
  slug,
  command,
  args = [],
  intervalSeconds,
  workingDirectory,
  logDir,
  environment,
  home = homedir(),
  fsImpl,
  exec = execa,
}) {
  const fs = wrapFs(fsImpl)
  const path = plistPathFor(slug, home)
  const body = buildPlist({
    slug,
    command,
    args,
    intervalSeconds,
    workingDirectory,
    logDir,
    environment,
  })
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, body)
  const loadResult = await loadAgent({ plistPath: path, exec })
  return { plistPath: path, label: labelFor(slug), loadResult }
}

export async function removeAgent({
  slug,
  home = homedir(),
  fsImpl,
  exec = execa,
}) {
  const fs = wrapFs(fsImpl)
  const path = plistPathFor(slug, home)
  if (!fs.existsSync(path)) {
    return { plistPath: path, removed: false, unloadResult: null }
  }
  const unloadResult = await unloadAgent({ plistPath: path, exec })
  fs.unlinkSync(path)
  return { plistPath: path, removed: true, unloadResult }
}

export async function loadAgent({ plistPath, exec = execa }) {
  return await exec('launchctl', ['load', '-w', plistPath], { reject: false })
}

export async function unloadAgent({ plistPath, exec = execa }) {
  return await exec('launchctl', ['unload', '-w', plistPath], { reject: false })
}

export async function getAgentStatus({
  slug,
  exec = execa,
  uid = currentUid(),
}) {
  const label = labelFor(slug)
  const printRes = await exec('launchctl', ['print', `gui/${uid}/${label}`], {
    reject: false,
  })
  if (printRes && printRes.exitCode === 0) {
    const text = printRes.stdout || ''
    return {
      loaded: true,
      lastExitCode: parseLastExitCode(text),
      nextRun: parseNextRun(text),
    }
  }
  const listRes = await exec('launchctl', ['list', label], { reject: false })
  if (listRes && listRes.exitCode === 0) {
    return {
      loaded: true,
      lastExitCode: parseLastExitCodeFromList(listRes.stdout || ''),
      nextRun: null,
    }
  }
  return { loaded: false, lastExitCode: null, nextRun: null }
}

function parseLastExitCode(text) {
  const m = text.match(/last exit code\s*=\s*(-?\d+)/i)
  return m ? Number.parseInt(m[1], 10) : null
}

function parseNextRun(text) {
  const m = text.match(/run interval\s*=\s*(\d+)/i)
  if (!m) return null
  return { intervalSeconds: Number.parseInt(m[1], 10) }
}

function parseLastExitCodeFromList(text) {
  const m = text.match(/"LastExitStatus"\s*=\s*(-?\d+)/)
  return m ? Number.parseInt(m[1], 10) : null
}

function currentUid() {
  if (typeof process.getuid === 'function') {
    try {
      return process.getuid()
    } catch {
      // fall through
    }
  }
  return 501
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function wrapFs(fsImpl) {
  if (!fsImpl) {
    return {
      existsSync: realExistsSync,
      writeFileSync: realWriteFileSync,
      unlinkSync: realUnlinkSync,
      mkdirSync: realMkdirSync,
    }
  }
  return {
    existsSync: fsImpl.existsSync.bind(fsImpl),
    writeFileSync: fsImpl.writeFileSync.bind(fsImpl),
    unlinkSync: fsImpl.unlinkSync.bind(fsImpl),
    mkdirSync: fsImpl.mkdirSync.bind(fsImpl),
  }
}
