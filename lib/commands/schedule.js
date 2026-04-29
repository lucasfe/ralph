import { existsSync as realExistsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { execa } from 'execa'
import { detectPlatform } from '../platform.js'
import {
  installAgent as defaultInstallAgent,
  removeAgent as defaultRemoveAgent,
  plistPathFor,
} from '../launchd.js'

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
