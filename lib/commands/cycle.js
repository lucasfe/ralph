import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { execa } from 'execa'
import { loadEnvFile } from '../utils/env.js'
import { createCredentialResolver } from '../utils/global-config.js'
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
import { resolveUpdateDecision } from '../update-check.js'
import { runUpdateGate } from '../update-gate.js'
import { resolveAgent } from '../agent-registry.js'
import { probeAgentAuth } from '../agent-auth.js'
import { readConfigAgent } from '../read-config-agent.js'
import { readConfigSource } from '../read-config-source.js'
import { resolveSource } from '../task-source.js'
import { queueCount as folderQueueCountLib } from '../folder-queue.js'

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
  folderQueueCount = defaultFolderQueueCount,
  now = Date.now,
  claudeCredentialsPath = resolve(homedir(), '.claude', '.credentials.json'),
  processEnv = process.env,
  home = homedir(),
  // #51: what is installed, for the update gate below. 'unknown' is not a semver,
  // so a caller that forgets it gets a silent gate, not a bogus comparison.
  currentVersion = 'unknown',
  update = resolveUpdateDecision,
  // #51: injected (memfs) in tests so no cycle touches the real ~/.config/ralph.
  cacheFs,
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
  const resolveCred = createCredentialResolver({ repoEnv: env, processEnv, home, loadEnv })
  const callmebotKey = resolveCred('CALLMEBOT_KEY') ?? ''
  const whatsappPhone = resolveCred('WHATSAPP_PHONE') ?? ''
  const healthcheckUrl = resolveCred('HEALTHCHECK_URL') ?? ''
  const repoSlug = await resolveRepoSlug(exec, root)

  const notify = async (message) => {
    if (!callmebotKey || !whatsappPhone) return
    try {
      await sendWa({ phone: whatsappPhone, apiKey: callmebotKey, message })
    } catch {
      // best-effort: notification failures must never abort the cycle
    }
  }

  // #565: resolve the task source from ralph.config.sh (folder mode does not
  // need gh auth, and draws the queue from the local .ralph/tasks tree). The
  // github path (default) is unchanged.
  const configPath = resolve(root, 'ralph.config.sh')
  const configSourceRaw = readConfigSource(configPath, { exists, readFile })
  const source = resolveSource({ TASK_SOURCE: configSourceRaw || processEnv.TASK_SOURCE })

  const preflight = await runPreflight({
    exec,
    exists,
    readFile,
    root,
    claudeCredentialsPath,
    processEnv,
    source,
  })
  if (!preflight.ok) {
    err(`❌ ralph cycle: preflight failed (${preflight.reason}).`)
    await notify(`🔴 ralph cycle aborted in ${repoSlug}: ${preflight.reason}`)
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
    out(`ℹ️  ralph cycle: another instance is already running (PID ${lockResult.holder?.pid}). Skipping.`)
    await notify(
      `⏭ ralph cycle skipped in ${repoSlug}: instance running for ${ageMin}min (PID ${lockResult.holder?.pid})`,
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
    // #51: #24's update notice for `ralph cycle`, through the same policy object
    // `ralph start`'s step 2.5 drives (../update-gate.js, #50). Its weekly window is
    // global, so six cycles a day cost at most one registry query a week — the same
    // budget `start` draws from, and the same cache `doctor` reads without querying.
    //
    // INSIDE THE LOCK: holding it is this command's guarantee that no other Ralph is
    // draining — the ground an accepted install will need once the interactive slice
    // lands, since a gate before acquireLock would let a hand-run `ralph cycle`
    // install over a live scheduled drain. `start` buys the same safety before its
    // own gate, from other guards.
    //
    // BEFORE THE ORPHAN SWEEP, which puts it before the queue-empty early return: a
    // notice behind that return is one an empty-queue run never sees, the mistake #24
    // corrected in `start`. AFTER runPreflight, whose abort needs no advice on top.
    //
    // `isTTY: false`, pinned and not a parameter: this slice is notice-only and
    // launchd attaches no terminal. The interactive slice adds the question.
    //
    // The verdict is dropped on purpose: none of it enters the RALPH_CYCLE_EVENT
    // payload or goes over WhatsApp — parity with `start`'s stdout-only notice, and
    // stdout is what launchd captures in logs/ralph-cycle.out.log.
    await runUpdateGate({
      currentVersion,
      exec,
      now,
      processEnv,
      home,
      cacheFs,
      stdout,
      stderr,
      isTTY: false,
      update,
    })

    const orphans = await safeFindOrphans(findOrphans, exec, root)
    const cleared = await safeCleanupOrphans(cleanupOrphans, exec, orphans)
    if (cleared.length > 0) {
      const list = cleared.map((n) => `#${n}`).join(' ')
      out(`🧹 ralph cycle: cleaned ${cleared.length} orphan(s): ${list}`)
      await notify(`🧹 ralph cycle: cleaned ${cleared.length} orphans in ${repoSlug}: ${list}`)
    }

    const queueCount =
      source === 'folder'
        ? await getFolderQueueCount(folderQueueCount, root)
        : await getQueueCount(exec, root)
    if (queueCount === 0) {
      out('ℹ️  ralph cycle: queue empty, exiting.')
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

    out(`🟢 ralph cycle: ${queueCount} issue(s) in the queue in ${repoSlug}.`)
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
      `Ralph finished: ${okCount} ok, ${failedCount} failed, ${durationMin}min. ` +
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

async function runPreflight({ exec, exists, readFile, root, claudeCredentialsPath, processEnv = {}, source = 'github' }) {
  // #565: gh auth is only required for the github task source. In folder mode
  // the loop never touches gh, so a missing/broken gh must not block the cycle.
  if (source === 'github') {
    const ghAuth = await exec('gh', ['auth', 'status'], { cwd: root, reject: false })
    if (!ghAuth || ghAuth.exitCode !== 0) {
      return { ok: false, reason: 'gh not authenticated' }
    }
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

// #565: default folder-queue counter — counts .md tasks in .ralph/tasks/afk/
// todo via the folder-queue library. Injectable in tests via folderQueueCount.
function defaultFolderQueueCount({ root }) {
  return folderQueueCountLib(resolve(root, '.ralph', 'tasks'))
}

async function getFolderQueueCount(folderQueueCount, root) {
  try {
    const n = await folderQueueCount({ root })
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
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
