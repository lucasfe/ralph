import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { execa } from 'execa'
import { loadEnvFile } from '../utils/env.js'
import { sendWhatsappMessage } from '../utils/whatsapp.js'
import { aggregateCycleCounts, metricsPath } from '../issue-metrics.js'
import { buildRunId } from '../run-id.js'
import {
  acquireLock as defaultAcquireLock,
  releaseLock as defaultReleaseLock,
  sessionNameFor,
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
import { resolveAgent } from '../agent-registry.js'
import { probeAgentAuth } from '../agent-auth.js'
import { readConfigAgent } from '../read-config-agent.js'

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
  readFile = realReadFileSync,
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

  const tmux = await exec('tmux', ['has-session', '-t', sessionNameFor(root)], { reject: false })
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
    readFile,
    root,
    claudeCredentialsPath,
    processEnv,
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
    const runId = buildRunId(sessionNameFor(root), Math.floor(start / 1000))
    await runQueueOnce({ exec, root, stdout, stderr, runId })

    // Read the REAL per-issue events that `--once` appended to issues.jsonl and
    // aggregate them. The bash loop's stdio is inherited (not captured), so the
    // metrics file — not runQueueOnce's return — is the source of truth (#532).
    const metricsText = safeReadMetrics(readFile, metricsPath(root))
    const counts = aggregateCycleCounts(metricsText, start)
    const okCount = counts.ok
    const failedCount = counts.failed
    const processed = counts.processed
    const durationMin = Math.max(0, Math.round((now() - start) / 60000))
    const status = failedCount === 0 ? 'success' : okCount > 0 ? 'partial' : 'failed'
    const okList = counts.okIssues.length > 0 ? counts.okIssues.map((n) => `#${n}`).join(' ') : '-'
    const failList =
      counts.failedIssues.length > 0 ? counts.failedIssues.map((n) => `#${n}`).join(' ') : '-'
    const summary =
      `Ralph finalizado: ${okCount} ok, ${failedCount} falharam, ${durationMin}min. ` +
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
      ok: okCount,
      failed: failedCount,
      durationMin,
      processed,
      run_id: runId,
    })

    return {
      exitCode: 0,
      status,
      processed,
      skipped: false,
      successes: counts.okIssues,
      failures: counts.failedIssues,
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

async function runPreflight({ exec, exists, readFile, root, claudeCredentialsPath, processEnv = {} }) {
  const ghAuth = await exec('gh', ['auth', 'status'], { cwd: root, reject: false })
  if (!ghAuth || ghAuth.exitCode !== 0) {
    return { ok: false, reason: 'gh not authenticated' }
  }

  const configPath = resolve(root, 'ralph.config.sh')
  if (!exists(configPath)) {
    return { ok: false, reason: 'ralph.config.sh missing' }
  }

  // #554: resolve the agent from ralph.config.sh (falling back through the
  // registry, with the process env as a secondary source), then run that
  // agent's auth probe instead of an inline Claude-credentials check. A
  // Codex-only machine is no longer blocked by a file it will never have.
  const configAgentRaw = readConfigAgent(configPath, { exists, readFile })
  const { agent } = resolveAgent({
    RALPH_AGENT: configAgentRaw || processEnv.RALPH_AGENT,
  })
  const auth = await probeAgentAuth({ agent, exec, exists, claudeCredentialsPath })
  if (!auth.ok) {
    return { ok: false, reason: auth.reason }
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

// Read the metrics file, degrading to '' on any error (missing file, etc.) so
// a blind cycle never crashes — it just reports zeros.
function safeReadMetrics(readFile, path) {
  try {
    return readFile(path, 'utf8') || ''
  } catch {
    return ''
  }
}

async function defaultRunQueueOnce({ exec, root, stdout, stderr, runId }) {
  const ralphTemplate = templatePath('ralph.sh')
  const result = await exec('bash', [ralphTemplate, '--once'], {
    cwd: root,
    env: { ...process.env, RALPH_ONCE: '1', RALPH_RUN_ID: runId },
    reject: false,
    stdio: 'inherit',
  })
  if (!result || result.exitCode !== 0) {
    return { successes: [], failures: [] }
  }
  return { successes: [], failures: [] }
}

export { CycleAbort }
