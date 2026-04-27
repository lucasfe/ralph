import pc from 'picocolors'
import { checkDeps, commandExists } from '../deps.js'
import { detectPlatform } from '../platform.js'

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
} = {}) {
  const out = (m) => stdout.write(m + '\n')
  const err = (m) => stderr.write(m + '\n')

  const results = checkDeps({ hasCommand })
  const missingCritical = results.filter((r) => !r.present && r.critical)
  const missingNonCritical = results.filter((r) => !r.present && !r.critical)

  out(`Ralph doctor — platform: ${platform}`)
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
} = {}) {
  const results = checkDeps({ hasCommand })
  const missingCritical = results.filter((r) => !r.present && r.critical)
  if (missingCritical.length === 0) return { ok: true, missingCritical: [] }
  const formatted = missingCritical
    .map((r) => `❌ '${r.name}' não encontrado no PATH (instalar: ${installFor(r, platform)})`)
    .join('\n')
  return { ok: false, missingCritical, message: formatted }
}

function installFor(dep, platform) {
  return dep.install[platform] || dep.install.linux
}

export { DoctorAbort }
