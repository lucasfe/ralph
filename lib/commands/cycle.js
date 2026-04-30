import { existsSync as realExistsSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { execa } from 'execa'
import { loadEnvFile } from '../utils/env.js'
import { sendWhatsappMessage } from '../utils/whatsapp.js'
import {
  acquireLock as defaultAcquireLock,
  releaseLock as defaultReleaseLock,
} from '../lock.js'
import {
  findOrphans as defaultFindOrphans,
  cleanupOrphans as defaultCleanupOrphans,
} from '../orphan-cleanup.js'
import {
  pingSuccess as defaultPingSuccess,
  pingFail as defaultPingFail,
} from '../healthcheck.js'
import { templatePath } from '../paths.js'

const TMUX_SESSION = 'ralph'
const SEARCH_QUERY =
  'state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge'
const CYCLE_EVENT_TAG = 'RALPH_CYCLE_EVENT'

class CycleAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export async function cycleCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
  exists = realExistsSync,
  loadEnv = loadEnvFile,
  acquireLock = defaultAcquireLock,
  releaseLock = defaultReleaseLock,
  findOrphans = defaultFindOrphans,
  cleanupOrphans = defaultCleanupOrphans,
  sendWa = sendWhatsappMessage,
  pingSuccess = defaultPingSuccess,
  pingFail = defaultPingFail,
  runQueueOnce = defaultRunQueueOnce,
  now = Date.now,
  claudeCredentialsPath = resolve(homedir(), '.claude', '.credentials.json'),
  processEnv = process.env,
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')
  const err = (msg) => stderr.write(msg + '\n')

  const root = await resolveRepoRoot(exec, cwd)

  const emitEvent = (event) => {
    const payload = { ts: new Date(now()).toISOString(), ...event }
    out(`${CYCLE_EVENT_TAG} ${JSON.stringify(payload)}`)
  }

  const tmux = await exec('tmux', ['has-session', '-t', TMUX_SESSION], { reject: false })
  if (tmux.exitCode === 0) {
    emitEvent({ status: 'tmux-active', ok: 0, failed: 0, durationMin: 0, processed: 0 })
    return { exitCode: 0, status: 'tmux-active', processed: 0, skipped: true }
  }

  const env = loadEnvIfExists(exists, loadEnv, resolve(root, '.env.local'))
  const callmebotKey = env.CALLMEBOT_KEY ?? processEnv.CALLMEBOT_KEY ?? ''
  const whatsappPhone = env.WHATSAPP_PHONE ?? processEnv.WHATSAPP_PHONE ?? ''
  const healthcheckUrl = env.HEALTHCHECK_URL ?? processEnv.HEALTHCHECK_URL ?? ''
  const repoSlug = await resolveRepoSlug(exec, root)

  const notify = async (message) => {
    if (!callmebotKey || !whatsappPhone) return
    try {
      await sendWa({ phone: whatsappPhone, apiKey: callmebotKey, message })
    } catch {
      // best-effort: notification failures must never abort the cycle
    }
  }

  const preflight = await runPreflight({
    exec,
    exists,
    root,
    claudeCredentialsPath,
  })
  if (!preflight.ok) {
    err(`❌ ralph cycle: pré-checagem falhou (${preflight.reason}).`)
    await notify(`🔴 ralph cycle abortado em ${repoSlug}: ${preflight.reason}`)
    emitEvent({
      status: 'preflight-failed',
      ok: 0,
      failed: 0,
      durationMin: 0,
      processed: 0,
      reason: preflight.reason,
    })
    return {
      exitCode: 1,
      status: 'preflight-failed',
      processed: 0,
      skipped: false,
      reason: preflight.reason,
    }
  }

  const lockResult = acquireLock(root)
  if (!lockResult.acquired) {
    const ageMin = ageInMinutes(now(), lockResult.holder?.startedAt)
    out(`ℹ️  ralph cycle: outra instância já está rodando (PID ${lockResult.holder?.pid}). Pulando.`)
    await notify(
      `⏭ ralph cycle skipped em ${repoSlug}: instância rodando há ${ageMin}min (PID ${lockResult.holder?.pid})`,
    )
    emitEvent({
      status: 'lock-held',
      ok: 0,
      failed: 0,
      durationMin: 0,
      processed: 0,
      holderPid: lockResult.holder?.pid ?? null,
    })
    return {
      exitCode: 0,
      status: 'lock-held',
      processed: 0,
      skipped: true,
      holder: lockResult.holder,
    }
  }

  try {
    const orphans = await safeFindOrphans(findOrphans, exec, root)
    const cleared = await safeCleanupOrphans(cleanupOrphans, exec, orphans)
    if (cleared.length > 0) {
      const list = cleared.map((n) => `#${n}`).join(' ')
      out(`🧹 ralph cycle: limpou ${cleared.length} orphan(s): ${list}`)
      await notify(`🧹 ralph cycle: limpou ${cleared.length} orphans em ${repoSlug}: ${list}`)
    }

    const queueCount = await getQueueCount(exec, root)
    if (queueCount === 0) {
      out('ℹ️  ralph cycle: fila vazia, encerrando.')
      emitEvent({
        status: 'queue-empty',
        ok: 0,
        failed: 0,
        durationMin: 0,
        processed: 0,
      })
      return {
        exitCode: 0,
        status: 'queue-empty',
        processed: 0,
        skipped: true,
      }
    }

    out(`🟢 ralph cycle: ${queueCount} issue(s) na fila em ${repoSlug}.`)
    await notify(`🟢 cycle started — ${queueCount} issues, repo ${repoSlug}`)

    const start = now()
    const result = await runQueueOnce({ exec, root, stdout, stderr })
    const successes = Array.isArray(result?.successes) ? result.successes : []
    const failures = Array.isArray(result?.failures) ? result.failures : []
    const durationMin = Math.max(0, Math.round((now() - start) / 60000))
    const status = failures.length === 0 ? 'success' : successes.length > 0 ? 'partial' : 'failed'
    const okList = successes.length > 0 ? successes.map((n) => `#${n}`).join(' ') : '-'
    const failList = failures.length > 0 ? failures.map((n) => `#${n}`).join(' ') : '-'
    const summary =
      `Ralph finalizado: ${successes.length} ok, ${failures.length} falharam, ${durationMin}min. ` +
      `OK: ${okList}| FAIL: ${failList}`
    out(summary)
    await notify(summary)

    if (healthcheckUrl) {
      try {
        if (status === 'failed') {
          await pingFail({ url: healthcheckUrl })
        } else {
          await pingSuccess({ url: healthcheckUrl })
        }
      } catch {
        // best-effort: healthcheck failures must never abort the cycle
      }
    }

    emitEvent({
      status,
      ok: successes.length,
      failed: failures.length,
      durationMin,
      processed: successes.length + failures.length,
    })

    return {
      exitCode: 0,
      status,
      processed: successes.length + failures.length,
      skipped: false,
      successes,
      failures,
      durationMin,
    }
  } finally {
    try {
      releaseLock(root)
    } catch {
      // best-effort: never let lock release crash the process
    }
  }
}

async function resolveRepoRoot(exec, cwd) {
  const result = await exec('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    reject: false,
  })
  if (!result || result.exitCode !== 0) {
    throw new CycleAbort('not inside a git repository', 1)
  }
  return (result.stdout || '').trim() || cwd
}

async function resolveRepoSlug(exec, root) {
  const result = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    cwd: root,
    reject: false,
  })
  const slug = (result?.stdout || '').trim()
  return slug || root
}

function loadEnvIfExists(exists, loadEnv, path) {
  if (!exists(path)) return {}
  try {
    return loadEnv(path) || {}
  } catch {
    return {}
  }
}

async function runPreflight({ exec, exists, root, claudeCredentialsPath }) {
  const ghAuth = await exec('gh', ['auth', 'status'], { cwd: root, reject: false })
  if (!ghAuth || ghAuth.exitCode !== 0) {
    return { ok: false, reason: 'gh not authenticated' }
  }
  if (!exists(claudeCredentialsPath)) {
    return { ok: false, reason: 'claude credentials missing' }
  }
  if (!exists(resolve(root, 'ralph.config.sh'))) {
    return { ok: false, reason: 'ralph.config.sh missing' }
  }
  if (!exists(resolve(root, '.ralph', 'state.json'))) {
    return { ok: false, reason: '.ralph/state.json missing' }
  }
  return { ok: true }
}

async function safeFindOrphans(findOrphans, exec, root) {
  try {
    const list = await findOrphans({ exec, repoPath: root })
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

async function safeCleanupOrphans(cleanupOrphans, exec, orphans) {
  try {
    const cleared = await cleanupOrphans({ exec, orphans })
    return Array.isArray(cleared) ? cleared : []
  } catch {
    return []
  }
}

async function getQueueCount(exec, root) {
  const args = [
    'issue',
    'list',
    '--search',
    SEARCH_QUERY,
    '--limit',
    '100',
    '--json',
    'number',
    '-q',
    '. | length',
  ]
  const result = await exec('gh', args, { cwd: root, reject: false })
  const raw = (result?.stdout || '').trim()
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : 0
}

function ageInMinutes(nowMs, isoStartedAt) {
  if (!isoStartedAt) return 0
  const startMs = Date.parse(isoStartedAt)
  if (!Number.isFinite(startMs)) return 0
  return Math.max(0, Math.round((nowMs - startMs) / 60000))
}

async function defaultRunQueueOnce({ exec, root, stdout, stderr }) {
  const ralphTemplate = templatePath('ralph.sh')
  const result = await exec('bash', [ralphTemplate, '--once'], {
    cwd: root,
    env: { ...process.env, RALPH_ONCE: '1' },
    reject: false,
    stdio: 'inherit',
  })
  if (!result || result.exitCode !== 0) {
    return { successes: [], failures: [] }
  }
  return { successes: [], failures: [] }
}

export { CycleAbort }
