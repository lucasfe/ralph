import { existsSync as realExistsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { execa } from 'execa'
import { detectPlatform } from '../platform.js'
import {
  getAgentStatus as defaultGetAgentStatus,
  installAgent as defaultInstallAgent,
  listInstalledAgents as defaultListInstalledAgents,
  pauseAgent as defaultPauseAgent,
  plistPathFor,
  removeAgent as defaultRemoveAgent,
  resumeAgent as defaultResumeAgent,
} from '../launchd.js'
import { peekLock as defaultPeekLock } from '../lock.js'
import { confirm as defaultConfirm } from '../utils/prompt.js'
import { loadEnvFile as defaultLoadEnv } from '../utils/env.js'
import {
  formatSummary as defaultFormatSummary,
  summarizeLast24h as defaultSummarizeLast24h,
} from '../heartbeat.js'
import { sendWhatsappMessage as defaultSendWhatsapp } from '../utils/whatsapp.js'

const DEFAULT_INTERVAL_SECONDS = 4 * 3600
const DEFAULT_HEARTBEAT_TIME = '09:00'

class ScheduleAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export function parseInterval(input) {
  if (input == null) return DEFAULT_INTERVAL_SECONDS
  const m = String(input).trim().match(/^(\d+)\s*([smhd]?)$/i)
  if (!m) {
    throw new ScheduleAbort(
      `invalid interval: ${input} (expected e.g. 60, 30m, 2h, 1d)`,
      1,
    )
  }
  const value = Number.parseInt(m[1], 10)
  const unit = (m[2] || 's').toLowerCase()
  switch (unit) {
    case 's':
      return value
    case 'm':
      return value * 60
    case 'h':
      return value * 3600
    case 'd':
      return value * 86400
    default:
      throw new ScheduleAbort(`invalid interval unit: ${unit}`, 1)
  }
}

export function parseHeartbeatTime(input) {
  const raw = (input ?? DEFAULT_HEARTBEAT_TIME).trim()
  const m = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) {
    throw new ScheduleAbort(
      `invalid heartbeat time: ${input} (expected HH:MM, e.g. 09:00)`,
      1,
    )
  }
  const hour = Number.parseInt(m[1], 10)
  const minute = Number.parseInt(m[2], 10)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new ScheduleAbort(
      `invalid heartbeat time: ${input} (hour 0-23, minute 0-59)`,
      1,
    )
  }
  return { hour, minute }
}

function formatHeartbeatTime({ hour, minute }) {
  const hh = String(hour).padStart(2, '0')
  const mm = String(minute).padStart(2, '0')
  return `${hh}:${mm}`
}

export async function scheduleInstallCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
  exists = realExistsSync,
  home = homedir(),
  platform = detectPlatform(),
  ralphBinary = defaultRalphBinary(),
  installAgent = defaultInstallAgent,
  removeAgent = defaultRemoveAgent,
  interval,
  heartbeatTime,
  processEnv = process.env,
  force = false,
} = {}) {
  const out = (m) => stdout.write(m + '\n')
  const err = (m) => stderr.write(m + '\n')

  if (platform !== 'mac') {
    err(`❌ ralph schedule só suporta macOS (detectado: ${platform}).`)
    throw new ScheduleAbort('platform not supported', 1)
  }

  const root = await resolveRepoRoot(exec, cwd)
  const slug = basename(root)
  const cyclePlistPath = plistPathFor(slug, home, 'cycle')
  const heartbeatPlistPath = plistPathFor(slug, home, 'heartbeat')

  if (!exists(resolve(root, 'ralph.config.sh'))) {
    err('❌ ralph.config.sh missing — run `ralph init` first.')
    throw new ScheduleAbort('ralph init not run', 1)
  }
  if (!exists(resolve(root, '.env.local'))) {
    out(
      'ℹ️  .env.local not found — WhatsApp/healthcheck notifications will be skipped at runtime.',
    )
  }

  const cycleExists = exists(cyclePlistPath)
  const heartbeatExists = exists(heartbeatPlistPath)
  if ((cycleExists || heartbeatExists) && !force) {
    const which = [
      cycleExists ? cyclePlistPath : null,
      heartbeatExists ? heartbeatPlistPath : null,
    ]
      .filter(Boolean)
      .join(', ')
    err(
      `❌ ${which} already exists. Pass --force to overwrite, or run 'ralph schedule remove' first.`,
    )
    throw new ScheduleAbort('plist already exists', 1)
  }
  if (cycleExists && force) {
    await removeAgent({ slug, kind: 'cycle', home, exec })
  }
  if (heartbeatExists && force) {
    await removeAgent({ slug, kind: 'heartbeat', home, exec })
  }

  const intervalSeconds = parseInterval(interval)
  const heartbeatAt = parseHeartbeatTime(
    heartbeatTime ?? processEnv.RALPH_DAILY_SUMMARY_TIME,
  )
  const logDir = join(root, 'logs')
  const baseEnv = { PATH: processEnv.PATH || '' }

  const cycleResult = await installAgent({
    slug,
    kind: 'cycle',
    command: ralphBinary,
    args: ['cycle'],
    intervalSeconds,
    workingDirectory: root,
    logDir,
    environment: baseEnv,
    home,
    exec,
  })

  const heartbeatResult = await installAgent({
    slug,
    kind: 'heartbeat',
    command: ralphBinary,
    args: ['schedule', 'heartbeat'],
    startCalendarInterval: heartbeatAt,
    workingDirectory: root,
    logDir,
    environment: baseEnv,
    home,
    exec,
  })

  out(`✅ Installed launchd agents for ${slug}:`)
  out(`   cycle:     ${cycleResult.label}`)
  out(`     plist:    ${cycleResult.plistPath}`)
  out(`     interval: ${intervalSeconds}s`)
  out(`     logs:     ${logDir}/ralph-cycle.{out,err}.log`)
  out(`   heartbeat: ${heartbeatResult.label}`)
  out(`     plist:    ${heartbeatResult.plistPath}`)
  out(`     time:     daily at ${formatHeartbeatTime(heartbeatAt)}`)
  out(`     logs:     ${logDir}/ralph-heartbeat.{out,err}.log`)

  return {
    exitCode: 0,
    slug,
    intervalSeconds,
    heartbeatTime: formatHeartbeatTime(heartbeatAt),
    cycle: {
      plistPath: cycleResult.plistPath,
      label: cycleResult.label,
    },
    heartbeat: {
      plistPath: heartbeatResult.plistPath,
      label: heartbeatResult.label,
    },
    plistPath: cycleResult.plistPath,
    label: cycleResult.label,
  }
}

export async function scheduleRemoveCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
  exists = realExistsSync,
  home = homedir(),
  platform = detectPlatform(),
  removeAgent = defaultRemoveAgent,
  listAgents = defaultListInstalledAgents,
  confirm = defaultConfirm,
  all = false,
} = {}) {
  const out = (m) => stdout.write(m + '\n')
  const err = (m) => stderr.write(m + '\n')

  if (platform !== 'mac') {
    err(`❌ ralph schedule só suporta macOS (detectado: ${platform}).`)
    throw new ScheduleAbort('platform not supported', 1)
  }

  if (all) {
    const agents = listAgents({ home }) || []
    if (agents.length === 0) {
      out('ℹ️  No launchd agents installed. Nothing to do.')
      return { exitCode: 0, removed: [], slug: null, plistPath: null }
    }
    out(`The following launchd agents will be removed:`)
    for (const a of agents) {
      out(`  - ${a.label} (${a.workingDirectory ?? '?'})`)
    }
    const ok = await confirm('Remove all? [y/N] ')
    if (!ok) {
      out('Aborted. Nothing was removed.')
      return { exitCode: 0, removed: [], slug: null, plistPath: null }
    }
    const removedSlugs = []
    for (const a of agents) {
      const r = await removeAgent({
        slug: a.slug,
        kind: a.kind ?? 'cycle',
        home,
        exec,
      })
      if (r.removed) removedSlugs.push(a.slug)
    }
    out(`✅ Removed ${removedSlugs.length} launchd agent(s).`)
    return {
      exitCode: 0,
      removed: removedSlugs,
      slug: null,
      plistPath: null,
    }
  }

  const root = await resolveRepoRoot(exec, cwd)
  const slug = basename(root)
  const cyclePlistPath = plistPathFor(slug, home, 'cycle')
  const heartbeatPlistPath = plistPathFor(slug, home, 'heartbeat')

  const cycleExists = exists(cyclePlistPath)
  const heartbeatExists = exists(heartbeatPlistPath)

  if (!cycleExists && !heartbeatExists) {
    out(`ℹ️  No launchd agent installed for ${slug}. Nothing to do.`)
    return {
      exitCode: 0,
      removed: false,
      slug,
      plistPath: cyclePlistPath,
      cycle: { removed: false, plistPath: cyclePlistPath },
      heartbeat: { removed: false, plistPath: heartbeatPlistPath },
    }
  }

  let cycleResult = { removed: false, plistPath: cyclePlistPath }
  if (cycleExists) {
    cycleResult = await removeAgent({ slug, kind: 'cycle', home, exec })
    out(`✅ Removed launchd agent: ${cycleResult.plistPath}`)
  }

  let heartbeatResult = { removed: false, plistPath: heartbeatPlistPath }
  if (heartbeatExists) {
    heartbeatResult = await removeAgent({
      slug,
      kind: 'heartbeat',
      home,
      exec,
    })
    out(`✅ Removed launchd agent: ${heartbeatResult.plistPath}`)
  }

  return {
    exitCode: 0,
    removed: cycleResult.removed || heartbeatResult.removed,
    slug,
    plistPath: cycleResult.plistPath,
    cycle: cycleResult,
    heartbeat: heartbeatResult,
  }
}

export async function schedulePauseCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
  exists = realExistsSync,
  home = homedir(),
  platform = detectPlatform(),
  pauseAgent = defaultPauseAgent,
} = {}) {
  const out = (m) => stdout.write(m + '\n')
  const err = (m) => stderr.write(m + '\n')

  if (platform !== 'mac') {
    err(`❌ ralph schedule só suporta macOS (detectado: ${platform}).`)
    throw new ScheduleAbort('platform not supported', 1)
  }

  const root = await resolveRepoRoot(exec, cwd)
  const slug = basename(root)
  const cyclePlistPath = plistPathFor(slug, home, 'cycle')
  const heartbeatPlistPath = plistPathFor(slug, home, 'heartbeat')

  const cycleExists = exists(cyclePlistPath)
  const heartbeatExists = exists(heartbeatPlistPath)

  if (!cycleExists && !heartbeatExists) {
    err(
      `❌ No launchd agent installed for ${slug}. Run 'ralph schedule install' first.`,
    )
    throw new ScheduleAbort('plist not installed', 1)
  }

  const cycleResult = cycleExists
    ? await pauseAgent({ slug, kind: 'cycle', home, exec })
    : { paused: false, plistPath: cyclePlistPath }
  const heartbeatResult = heartbeatExists
    ? await pauseAgent({ slug, kind: 'heartbeat', home, exec })
    : { paused: false, plistPath: heartbeatPlistPath }

  if (cycleExists) {
    out(`⏸  Paused launchd agent: com.lucasfe.ralph.cycle.${slug}`)
  }
  if (heartbeatExists) {
    out(`⏸  Paused launchd agent: com.lucasfe.ralph.heartbeat.${slug}`)
  }

  return {
    exitCode: 0,
    paused: cycleResult.paused || heartbeatResult.paused,
    slug,
    plistPath: cycleResult.plistPath,
    cycle: cycleResult,
    heartbeat: heartbeatResult,
  }
}

export async function scheduleResumeCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
  exists = realExistsSync,
  home = homedir(),
  platform = detectPlatform(),
  resumeAgent = defaultResumeAgent,
} = {}) {
  const out = (m) => stdout.write(m + '\n')
  const err = (m) => stderr.write(m + '\n')

  if (platform !== 'mac') {
    err(`❌ ralph schedule só suporta macOS (detectado: ${platform}).`)
    throw new ScheduleAbort('platform not supported', 1)
  }

  const root = await resolveRepoRoot(exec, cwd)
  const slug = basename(root)
  const cyclePlistPath = plistPathFor(slug, home, 'cycle')
  const heartbeatPlistPath = plistPathFor(slug, home, 'heartbeat')

  const cycleExists = exists(cyclePlistPath)
  const heartbeatExists = exists(heartbeatPlistPath)

  if (!cycleExists && !heartbeatExists) {
    err(
      `❌ No launchd agent installed for ${slug}. Run 'ralph schedule install' first.`,
    )
    throw new ScheduleAbort('plist not installed', 1)
  }

  const cycleResult = cycleExists
    ? await resumeAgent({ slug, kind: 'cycle', home, exec })
    : { resumed: false, plistPath: cyclePlistPath }
  const heartbeatResult = heartbeatExists
    ? await resumeAgent({ slug, kind: 'heartbeat', home, exec })
    : { resumed: false, plistPath: heartbeatPlistPath }

  if (cycleExists) {
    out(`▶️  Resumed launchd agent: com.lucasfe.ralph.cycle.${slug} (active)`)
  }
  if (heartbeatExists) {
    out(
      `▶️  Resumed launchd agent: com.lucasfe.ralph.heartbeat.${slug} (active)`,
    )
  }

  return {
    exitCode: 0,
    resumed: cycleResult.resumed || heartbeatResult.resumed,
    slug,
    plistPath: cycleResult.plistPath,
    cycle: cycleResult,
    heartbeat: heartbeatResult,
  }
}

export async function scheduleStatusCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
  home = homedir(),
  platform = detectPlatform(),
  listAgents = defaultListInstalledAgents,
  getStatus = defaultGetAgentStatus,
  peekLock = defaultPeekLock,
  now = Date.now,
  here = false,
} = {}) {
  const out = (m) => stdout.write(m + '\n')
  const err = (m) => stderr.write(m + '\n')

  if (platform !== 'mac') {
    err(`❌ ralph schedule só suporta macOS (detectado: ${platform}).`)
    throw new ScheduleAbort('platform not supported', 1)
  }

  const allAgents = listAgents({ home }) || []
  let filtered = allAgents
  let currentSlug = null

  if (here) {
    const root = await resolveRepoRoot(exec, cwd)
    currentSlug = basename(root)
    filtered = allAgents.filter((a) => a.slug === currentSlug)
    if (filtered.length === 0) {
      out(`ℹ️  ${currentSlug}: not installed.`)
      out(`   Run 'ralph schedule install' inside this repo to enable cycles.`)
      return { exitCode: 0, agents: [] }
    }
  }

  if (filtered.length === 0) {
    out('ℹ️  No launchd agents installed.')
    out(`   Run 'ralph schedule install' inside a repo to schedule it.`)
    return { exitCode: 0, agents: [] }
  }

  const reports = []
  for (const agent of filtered) {
    const kind = agent.kind ?? 'cycle'
    const status = await getStatus({ slug: agent.slug, kind, exec })
    const state = status?.loaded ? 'active' : 'paused'
    const lock =
      kind === 'cycle' && agent.workingDirectory
        ? safePeekLock(peekLock, agent.workingDirectory)
        : null
    reports.push({ ...agent, kind, state, status, lock })
    printAgentReport(out, { agent: { ...agent, kind }, state, status, lock, now })
  }

  return { exitCode: 0, agents: reports }
}

export async function scheduleHeartbeatCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
  exists = realExistsSync,
  home = homedir(),
  platform = detectPlatform(),
  loadEnv = defaultLoadEnv,
  summarize = defaultSummarizeLast24h,
  format = defaultFormatSummary,
  sendWa = defaultSendWhatsapp,
  listAgents = defaultListInstalledAgents,
  clock = Date.now,
  processEnv = process.env,
} = {}) {
  const out = (m) => stdout.write(m + '\n')
  const err = (m) => stderr.write(m + '\n')

  if (platform !== 'mac') {
    err(`❌ ralph schedule só suporta macOS (detectado: ${platform}).`)
    throw new ScheduleAbort('platform not supported', 1)
  }

  const root = await resolveRepoRoot(exec, cwd)
  const slug = basename(root)
  const logDir = join(root, 'logs')
  const repoSlug = await resolveRepoSlug(exec, root, slug)
  const env = loadEnvIfExists(exists, loadEnv, resolve(root, '.env.local'))
  const callmebotKey = env.CALLMEBOT_KEY ?? processEnv.CALLMEBOT_KEY ?? ''
  const whatsappPhone = env.WHATSAPP_PHONE ?? processEnv.WHATSAPP_PHONE ?? ''
  const heartbeatTimeStr =
    env.RALPH_DAILY_SUMMARY_TIME ??
    processEnv.RALPH_DAILY_SUMMARY_TIME ??
    DEFAULT_HEARTBEAT_TIME
  const nextTick = safeFormatNextTick(heartbeatTimeStr, listAgents, slug, home)

  let message
  try {
    const summary = summarize({ logDir, clock })
    message = format(summary, { repoSlug, nextTick })
  } catch (e) {
    const reason = e?.message || String(e)
    message = `❌ Ralph 24h summary failed: ${reason}`
    err(message)
  }

  out(message)

  if (callmebotKey && whatsappPhone) {
    try {
      await sendWa({
        phone: whatsappPhone,
        apiKey: callmebotKey,
        message,
      })
    } catch (e) {
      err(`heartbeat: WhatsApp send failed: ${e?.message ?? e}`)
    }
  }

  return { exitCode: 0, slug, repoSlug, message, nextTick }
}

function safeFormatNextTick(envTime, listAgents, slug, home) {
  try {
    const parsed = parseHeartbeatTime(envTime)
    return formatHeartbeatTime(parsed)
  } catch {
    // fall through and try to read from installed plist
  }
  try {
    const agents = listAgents({ home }) || []
    const heartbeat = agents.find(
      (a) => a.slug === slug && a.kind === 'heartbeat',
    )
    if (heartbeat?.startCalendarInterval) {
      return formatHeartbeatTime(heartbeat.startCalendarInterval)
    }
  } catch {
    // ignore
  }
  return DEFAULT_HEARTBEAT_TIME
}

function loadEnvIfExists(exists, loadEnv, path) {
  if (!exists(path)) return {}
  try {
    return loadEnv(path) || {}
  } catch {
    return {}
  }
}

async function resolveRepoSlug(exec, root, fallback) {
  try {
    const result = await exec(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { cwd: root, reject: false },
    )
    const slug = (result?.stdout || '').trim()
    return slug || fallback
  } catch {
    return fallback
  }
}

function printAgentReport(out, { agent, state, status, lock, now }) {
  const kind = agent.kind ?? 'cycle'
  out('')
  out(`▸ ${agent.slug} (${kind})`)
  out(`  label:    ${agent.label}`)
  out(`  cwd:      ${agent.workingDirectory ?? '?'}`)
  out(`  state:    ${state}`)
  if (kind === 'heartbeat' && agent.startCalendarInterval) {
    out(
      `  schedule: daily at ${formatHeartbeatTime(agent.startCalendarInterval)}`,
    )
  } else {
    const intervalLine = formatInterval(agent.intervalSeconds)
    out(`  interval: ${intervalLine}`)
    if (state === 'active') {
      const nextSecs = status?.nextRun?.intervalSeconds ?? agent.intervalSeconds
      if (nextSecs != null) {
        out(`  next run: in up to ${formatInterval(nextSecs)}`)
      }
    }
  }
  if (status?.lastExitCode != null) {
    const flag = status.lastExitCode === 0 ? 'success' : 'failure'
    out(`  last run: exit ${status.lastExitCode} (${flag})`)
  }
  if (kind === 'cycle') {
    if (lock?.holder) {
      const ageMin = ageInMinutes(now(), lock.holder.startedAt)
      const liveTag = lock.alive ? 'alive' : 'stale'
      out(`  lock:     PID ${lock.holder.pid} (${liveTag}, ${ageMin}min ago)`)
    } else {
      out(`  lock:     none`)
    }
  }
}

function formatInterval(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '?'
  if (seconds % 86400 === 0) return `${seconds}s (${seconds / 86400}d)`
  if (seconds % 3600 === 0) return `${seconds}s (${seconds / 3600}h)`
  if (seconds % 60 === 0) return `${seconds}s (${seconds / 60}m)`
  return `${seconds}s`
}

function safePeekLock(peekLock, repoPath) {
  try {
    return peekLock(repoPath)
  } catch {
    return null
  }
}

function ageInMinutes(nowMs, isoStartedAt) {
  if (!isoStartedAt) return 0
  const startMs = Date.parse(isoStartedAt)
  if (!Number.isFinite(startMs)) return 0
  return Math.max(0, Math.round((nowMs - startMs) / 60000))
}

async function resolveRepoRoot(exec, cwd) {
  const result = await exec('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    reject: false,
  })
  if (!result || result.exitCode !== 0) return cwd
  return (result.stdout || '').trim() || cwd
}

function defaultRalphBinary() {
  return process.argv[1] || 'ralph'
}

export { ScheduleAbort }
