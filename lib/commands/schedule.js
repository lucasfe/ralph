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

const DEFAULT_INTERVAL_SECONDS = 4 * 3600

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
  const plistPath = plistPathFor(slug, home)

  if (!exists(resolve(root, 'ralph.config.sh'))) {
    err('❌ ralph.config.sh missing — run `ralph init` first.')
    throw new ScheduleAbort('ralph init not run', 1)
  }
  if (!exists(resolve(root, '.env.local'))) {
    out(
      'ℹ️  .env.local not found — WhatsApp/healthcheck notifications will be skipped at runtime.',
    )
  }

  if (exists(plistPath) && !force) {
    err(
      `❌ ${plistPath} already exists. Pass --force to overwrite, or run 'ralph schedule remove' first.`,
    )
    throw new ScheduleAbort('plist already exists', 1)
  }
  if (exists(plistPath) && force) {
    await removeAgent({ slug, home, exec })
  }

  const intervalSeconds = parseInterval(interval)
  const logDir = join(root, 'logs')
  const result = await installAgent({
    slug,
    command: ralphBinary,
    args: ['cycle'],
    intervalSeconds,
    workingDirectory: root,
    logDir,
    environment: { PATH: process.env.PATH || '' },
    home,
    exec,
  })

  out(`✅ Installed launchd agent: ${result.label}`)
  out(`   plist:    ${result.plistPath}`)
  out(`   interval: ${intervalSeconds}s`)
  out(`   logs:     ${logDir}/ralph-cycle.{out,err}.log`)

  return {
    exitCode: 0,
    slug,
    intervalSeconds,
    plistPath: result.plistPath,
    label: result.label,
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
      const r = await removeAgent({ slug: a.slug, home, exec })
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
  const plistPath = plistPathFor(slug, home)

  if (!exists(plistPath)) {
    out(`ℹ️  No launchd agent installed for ${slug}. Nothing to do.`)
    return { exitCode: 0, removed: false, slug, plistPath }
  }

  const result = await removeAgent({ slug, home, exec })
  out(`✅ Removed launchd agent: ${result.plistPath}`)
  return {
    exitCode: 0,
    removed: result.removed,
    slug,
    plistPath: result.plistPath,
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
  const plistPath = plistPathFor(slug, home)

  if (!exists(plistPath)) {
    err(
      `❌ No launchd agent installed for ${slug}. Run 'ralph schedule install' first.`,
    )
    throw new ScheduleAbort('plist not installed', 1)
  }

  const result = await pauseAgent({ slug, home, exec })
  const label = `com.lucasfe.ralph.cycle.${slug}`
  out(`⏸  Paused launchd agent: ${label}`)
  return {
    exitCode: 0,
    paused: result.paused,
    slug,
    plistPath: result.plistPath,
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
  const plistPath = plistPathFor(slug, home)

  if (!exists(plistPath)) {
    err(
      `❌ No launchd agent installed for ${slug}. Run 'ralph schedule install' first.`,
    )
    throw new ScheduleAbort('plist not installed', 1)
  }

  const result = await resumeAgent({ slug, home, exec })
  const label = `com.lucasfe.ralph.cycle.${slug}`
  out(`▶️  Resumed launchd agent: ${label} (active)`)
  return {
    exitCode: 0,
    resumed: result.resumed,
    slug,
    plistPath: result.plistPath,
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
    const status = await getStatus({ slug: agent.slug, exec })
    const state = status?.loaded ? 'active' : 'paused'
    const lock = agent.workingDirectory
      ? safePeekLock(peekLock, agent.workingDirectory)
      : null
    reports.push({ ...agent, state, status, lock })
    printAgentReport(out, { agent, state, status, lock, now })
  }

  return { exitCode: 0, agents: reports }
}

function printAgentReport(out, { agent, state, status, lock, now }) {
  out('')
  out(`▸ ${agent.slug}`)
  out(`  label:    ${agent.label}`)
  out(`  cwd:      ${agent.workingDirectory ?? '?'}`)
  out(`  state:    ${state}`)
  const intervalLine = formatInterval(agent.intervalSeconds)
  out(`  interval: ${intervalLine}`)
  if (state === 'active') {
    const nextSecs = status?.nextRun?.intervalSeconds ?? agent.intervalSeconds
    if (nextSecs != null) {
      out(`  next run: in up to ${formatInterval(nextSecs)}`)
    }
  }
  if (status?.lastExitCode != null) {
    const flag = status.lastExitCode === 0 ? 'success' : 'failure'
    out(`  last run: exit ${status.lastExitCode} (${flag})`)
  }
  if (lock?.holder) {
    const ageMin = ageInMinutes(now(), lock.holder.startedAt)
    const liveTag = lock.alive ? 'alive' : 'stale'
    out(`  lock:     PID ${lock.holder.pid} (${liveTag}, ${ageMin}min ago)`)
  } else {
    out(`  lock:     none`)
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
