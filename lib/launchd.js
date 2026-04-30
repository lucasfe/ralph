import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  readdirSync as realReaddirSync,
  readFileSync as realReadFileSync,
  unlinkSync as realUnlinkSync,
  writeFileSync as realWriteFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { execa } from 'execa'

export const LABEL_PREFIX = 'com.lucasfe.ralph.cycle'
export const LABEL_PREFIX_HEARTBEAT = 'com.lucasfe.ralph.heartbeat'
export const DEFAULT_PATH =
  '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
export const KINDS = ['cycle', 'heartbeat']

const KIND_CONFIG = {
  cycle: {
    prefix: LABEL_PREFIX,
    logBase: 'ralph-cycle',
  },
  heartbeat: {
    prefix: LABEL_PREFIX_HEARTBEAT,
    logBase: 'ralph-heartbeat',
  },
}

function configFor(kind = 'cycle') {
  const cfg = KIND_CONFIG[kind]
  if (!cfg) throw new Error(`unknown launchd kind: ${kind}`)
  return cfg
}

export function labelFor(slug, kind = 'cycle') {
  return `${configFor(kind).prefix}.${slug}`
}

export function plistPathFor(slug, home = homedir(), kind = 'cycle') {
  return join(home, 'Library', 'LaunchAgents', `${labelFor(slug, kind)}.plist`)
}

export function buildPlist({
  slug,
  command,
  args = [],
  intervalSeconds,
  startCalendarInterval,
  workingDirectory,
  logDir,
  environment,
  kind = 'cycle',
}) {
  const cfg = configFor(kind)
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
  const stdoutPath = join(logDir, `${cfg.logBase}.out.log`)
  const stderrPath = join(logDir, `${cfg.logBase}.err.log`)
  const scheduleXml = renderSchedule({ intervalSeconds, startCalendarInterval })
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(labelFor(slug, kind))}</string>
    <key>ProgramArguments</key>
    <array>
${programArgsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(workingDirectory)}</string>
${scheduleXml}
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

function renderSchedule({ intervalSeconds, startCalendarInterval }) {
  if (startCalendarInterval) {
    const hour = Number(startCalendarInterval.hour)
    const minute = Number(startCalendarInterval.minute)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      throw new Error(
        `invalid startCalendarInterval: ${JSON.stringify(startCalendarInterval)}`,
      )
    }
    return [
      '    <key>StartCalendarInterval</key>',
      '    <dict>',
      `        <key>Hour</key>`,
      `        <integer>${hour}</integer>`,
      `        <key>Minute</key>`,
      `        <integer>${minute}</integer>`,
      '    </dict>',
    ].join('\n')
  }
  return [
    '    <key>StartInterval</key>',
    `    <integer>${Number(intervalSeconds)}</integer>`,
  ].join('\n')
}

export async function installAgent({
  slug,
  command,
  args = [],
  intervalSeconds,
  startCalendarInterval,
  workingDirectory,
  logDir,
  environment,
  kind = 'cycle',
  home = homedir(),
  fsImpl,
  exec = execa,
}) {
  const fs = wrapFs(fsImpl)
  const path = plistPathFor(slug, home, kind)
  const body = buildPlist({
    slug,
    command,
    args,
    intervalSeconds,
    startCalendarInterval,
    workingDirectory,
    logDir,
    environment,
    kind,
  })
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, body)
  const loadResult = await loadAgent({ plistPath: path, exec })
  return { plistPath: path, label: labelFor(slug, kind), kind, loadResult }
}

export async function removeAgent({
  slug,
  kind = 'cycle',
  home = homedir(),
  fsImpl,
  exec = execa,
}) {
  const fs = wrapFs(fsImpl)
  const path = plistPathFor(slug, home, kind)
  if (!fs.existsSync(path)) {
    return { plistPath: path, kind, removed: false, unloadResult: null }
  }
  const unloadResult = await unloadAgent({ plistPath: path, exec })
  fs.unlinkSync(path)
  return { plistPath: path, kind, removed: true, unloadResult }
}

export async function loadAgent({ plistPath, exec = execa }) {
  return await exec('launchctl', ['load', '-w', plistPath], { reject: false })
}

export async function unloadAgent({ plistPath, exec = execa }) {
  return await exec('launchctl', ['unload', '-w', plistPath], { reject: false })
}

export async function pauseAgent({
  slug,
  kind = 'cycle',
  home = homedir(),
  fsImpl,
  exec = execa,
}) {
  const fs = wrapFs(fsImpl)
  const path = plistPathFor(slug, home, kind)
  if (!fs.existsSync(path)) {
    return { plistPath: path, kind, paused: false, unloadResult: null }
  }
  const unloadResult = await unloadAgent({ plistPath: path, exec })
  return { plistPath: path, kind, paused: true, unloadResult }
}

export async function resumeAgent({
  slug,
  kind = 'cycle',
  home = homedir(),
  fsImpl,
  exec = execa,
}) {
  const fs = wrapFs(fsImpl)
  const path = plistPathFor(slug, home, kind)
  if (!fs.existsSync(path)) {
    return { plistPath: path, kind, resumed: false, loadResult: null }
  }
  const loadResult = await loadAgent({ plistPath: path, exec })
  return { plistPath: path, kind, resumed: true, loadResult }
}

export function listInstalledAgents({ home = homedir(), fsImpl } = {}) {
  const fs = wrapFs(fsImpl)
  const dir = join(home, 'Library', 'LaunchAgents')
  if (!fs.existsSync(dir)) return []
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const matches = []
  for (const name of entries || []) {
    if (typeof name !== 'string' || !name.endsWith('.plist')) continue
    const kind = matchKind(name)
    if (!kind) continue
    matches.push({ name, kind })
  }
  return matches
    .map(({ name, kind }) => {
      const cfg = configFor(kind)
      const plistPath = join(dir, name)
      const label = name.replace(/\.plist$/, '')
      const slug = label.slice(cfg.prefix.length + 1)
      let content = ''
      try {
        content = fs.readFileSync(plistPath, 'utf8').toString()
      } catch {
        content = ''
      }
      const meta = parsePlistMetadata(content)
      return {
        slug,
        label,
        plistPath,
        kind,
        workingDirectory: meta.workingDirectory,
        intervalSeconds: meta.intervalSeconds,
        startCalendarInterval: meta.startCalendarInterval,
      }
    })
    .sort((a, b) => {
      if (a.slug !== b.slug) return a.slug.localeCompare(b.slug)
      return a.kind.localeCompare(b.kind)
    })
}

function matchKind(plistName) {
  for (const kind of KINDS) {
    const prefix = `${configFor(kind).prefix}.`
    if (plistName.startsWith(prefix)) return kind
  }
  return null
}

export function parsePlistMetadata(xml) {
  if (!xml || typeof xml !== 'string') {
    return {
      workingDirectory: null,
      intervalSeconds: null,
      startCalendarInterval: null,
    }
  }
  return {
    workingDirectory: matchKeyString(xml, 'WorkingDirectory'),
    intervalSeconds: matchKeyInteger(xml, 'StartInterval'),
    startCalendarInterval: matchStartCalendarInterval(xml),
  }
}

function matchKeyString(xml, key) {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`)
  const m = xml.match(re)
  return m ? unescapeXml(m[1]) : null
}

function matchKeyInteger(xml, key) {
  const re = new RegExp(`<key>${key}</key>\\s*<integer>(-?\\d+)</integer>`)
  const m = xml.match(re)
  return m ? Number.parseInt(m[1], 10) : null
}

function matchStartCalendarInterval(xml) {
  const blockRe = /<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/
  const m = xml.match(blockRe)
  if (!m) return null
  const inner = m[1]
  const hourMatch = inner.match(/<key>Hour<\/key>\s*<integer>(-?\d+)<\/integer>/)
  const minuteMatch = inner.match(
    /<key>Minute<\/key>\s*<integer>(-?\d+)<\/integer>/,
  )
  if (!hourMatch || !minuteMatch) return null
  return {
    hour: Number.parseInt(hourMatch[1], 10),
    minute: Number.parseInt(minuteMatch[1], 10),
  }
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

export async function getAgentStatus({
  slug,
  kind = 'cycle',
  exec = execa,
  uid = currentUid(),
}) {
  const label = labelFor(slug, kind)
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
      readdirSync: realReaddirSync,
      readFileSync: realReadFileSync,
    }
  }
  return {
    existsSync: fsImpl.existsSync.bind(fsImpl),
    writeFileSync: fsImpl.writeFileSync.bind(fsImpl),
    unlinkSync: fsImpl.unlinkSync.bind(fsImpl),
    mkdirSync: fsImpl.mkdirSync.bind(fsImpl),
    readdirSync: fsImpl.readdirSync
      ? fsImpl.readdirSync.bind(fsImpl)
      : realReaddirSync,
    readFileSync: fsImpl.readFileSync
      ? fsImpl.readFileSync.bind(fsImpl)
      : realReadFileSync,
  }
}
