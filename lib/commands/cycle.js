import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { execa } from 'execa'
import pc from 'picocolors'
import { loadEnvFile } from '../utils/env.js'
import { createCredentialResolver } from '../utils/global-config.js'
import { confirm } from '../utils/prompt.js'
import { sendWhatsappMessage } from '../utils/whatsapp.js'
import { aggregateCycleCounts, metricsPath, safeReadText } from '../issue-metrics.js'
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
import { recordPromptShown, resolveUpdateDecision } from '../update-check.js'
import { runUpdateGate } from '../update-gate.js'
import { updateCommand } from './update.js'
import { resolveAgent } from '../agent-registry.js'
import { probeAgentAuth } from '../agent-auth.js'
import { readConfigAgent } from '../read-config-agent.js'
import { parseConfigSource, readConfigText } from '../read-config-source.js'
import { parseConfigVar } from '../parse-config-var.js'
import { resolveSource } from '../task-source.js'
import { queueCount as folderQueueCountLib } from '../folder-queue.js'
import { queueCount as jiraQueueCountLib } from '../jira-queue.js'

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
  stdin = process.stdin,
  // #52: TTY-gated, derived from the RESOLVED `stdin` above exactly as ./start.js:48
  // does and for the reasons given there. What is at stake HERE: this is the command
  // launchd drives, and `confirm` never resolves on an input that ends without a
  // line — so a scheduled tick handed a readline hangs forever WITH THE CYCLE LOCK
  // HELD, which stops the schedule for good rather than losing one run.
  isTTY = Boolean(stdin?.isTTY),
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
  jiraQueueCount = defaultJiraQueueCount,
  now = Date.now,
  claudeCredentialsPath = resolve(homedir(), '.claude', '.credentials.json'),
  processEnv = process.env,
  home = homedir(),
  // #51: what is installed, for the update gate below. 'unknown' is not a semver,
  // so a caller that forgets it gets a silent gate, not a bogus comparison.
  currentVersion = 'unknown',
  update = resolveUpdateDecision,
  // #52: the remaining update-gate seams, defaulted to the same functions
  // `ralph start` names in its own signature so both commands drive one policy.
  // `recordPrompt` is injected rather than reached through the gate so its CALL is
  // observable and orderable in tests — several of them assert it runs before the
  // answer is awaited. `runUpdate` is the `ralph update` machinery from #21,
  // injected so no test ever shells out to npm.
  ask = confirm,
  recordPrompt = recordPromptShown,
  runUpdate = updateCommand,
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
  //
  // #126 made this file's config read ONE READ ANSWERING TWO QUESTIONS — the source, and
  // the JIRA_JQL that counts the jira queue — which is why it is now `readConfigText` plus
  // two parses rather than the read-and-parse one-liner it used to call. Reading the file
  // twice would let a config rewritten in between hand back a source and a query that
  // disagree; the shared helper explains the rule at length, and records that this file
  // growing its second question is what left that one-liner with no callers at all.
  //
  // JIRA_JQL is read from the CONFIG ONLY, with no `processEnv` fallback beside it unlike
  // TASK_SOURCE: an eligibility query is a property of the repo, and the template ships the
  // assignment empty, so `set -a` puts that empty value in the environment of every child
  // the loop spawns — an env fallback would then read as "unconfigured" in this process and
  // "configured" in the next one.
  const configPath = resolve(root, 'ralph.config.sh')
  const configText = readConfigText(configPath, { exists, readFile })
  const source = resolveSource({
    TASK_SOURCE: parseConfigSource(configText) || processEnv.TASK_SOURCE,
  })
  const jiraJql = parseConfigVar(configText, 'JIRA_JQL')

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
    // #51/#52: #24's update notice, #25's TTY-gated question and #26's weekly prompt
    // window for `ralph cycle`, through the same policy object `ralph start`'s step
    // 2.5 drives (../update-gate.js, #50) — which is also where every "why" about the
    // policy itself lives. Its two windows are global, so six cycles a day cost at
    // most one registry query and one question a week, out of the same budget
    // `start` draws from and against the same cache `doctor` reads without querying.
    //
    // This site owns two things only: WHERE the gate runs, and what an accepted
    // install means for a drain.
    //
    // INSIDE THE LOCK: holding it is this command's guarantee that no other Ralph is
    // draining — the ground an accepted install needs, since a gate before
    // acquireLock would let a hand-run `ralph cycle` install over a live scheduled
    // drain. `start` buys the same safety before its own gate, from other guards.
    // The accepted cost is the mirror image: the prompt BLOCKS while the lock is
    // held, so a scheduled tick arriving mid-question reports `lock-held` and skips.
    // That is only reachable on a manual TTY run, and skipping is the right answer
    // for a tick that arrives while a human is mid-decision.
    //
    // BEFORE THE ORPHAN SWEEP, which puts it before the queue-empty early return: a
    // notice behind that return is one an empty-queue run never sees, the mistake #24
    // corrected in `start`. AFTER runPreflight, whose abort needs no advice on top.
    //
    // Nothing about the update reaches WhatsApp, and the only thing it adds to the
    // RALPH_CYCLE_EVENT stream is the `updated` status below — parity with `start`'s
    // stdout-only notice, and stdout is what launchd captures in
    // logs/ralph-cycle.out.log.
    //
    // Unwrapped for the reasons at ./start.js:151-156, plus one that is only true
    // here: the escape they describe — a broken `ask` aborting with its raw error —
    // happens inside the lock, and the `finally` below keeps it from leaking the file.
    const updateGate = await runUpdateGate({
      currentVersion,
      exec,
      now,
      processEnv,
      home,
      cacheFs,
      stdout,
      stderr,
      stdin,
      isTTY,
      update,
      recordPrompt,
      runUpdate,
      ask,
    })
    if (updateGate.installed) {
      // #52: STOP, without draining. `ralph start` refuses to launch its loop after
      // an update (./start.js:173) because THIS process holds pre-update module
      // state and `templatePath('ralph.sh')` resolves against the OLD install; the
      // cycle has the identical hazard, since defaultRunQueueOnce shells out to
      // exactly that template — from the install that was just replaced. Exiting is
      // the only way to guarantee no issue is processed by a mixture of two
      // versions. Nothing is lost: the user re-runs `ralph cycle`, and the next
      // scheduled tick picks the new version up on its own.
      //
      // The event is emitted so the run is not invisible to the daily rollup, with
      // zeroed counters because nothing was attempted — and with a status
      // lib/heartbeat.js classifies as an ABORT, so it cannot be averaged in as a
      // zero-minute cycle. `skipped: true`, on the same reading as tmux-active and
      // lock-held: the queue was not drained this tick.
      out(pc.green(`✅ Updated to ${updateGate.installedVersion} — run \`ralph cycle\` again.`))
      emitEvent({ status: 'updated', ok: 0, failed: 0, durationMin: 0, processed: 0 })
      return { exitCode: 0, status: 'updated', processed: 0, skipped: true }
    } else if (updateGate.accepted) {
      // Accepted but not updated — a failed install, or nothing to update (npx, a
      // linked dev checkout). This cycle still drains, on the current version: an
      // update is never worth losing a scheduled run over. Neutral line and `else if`
      // as ./start.js:181-191, and the gate is `installed` NEVER `to` — updateCommand
      // sets `to` even when the install failed or was refused.
      out(`⚠️  Update did not complete — continuing this cycle on ${currentVersion}.`)
    }

    const orphans = await safeFindOrphans(findOrphans, exec, root)
    const cleared = await safeCleanupOrphans(cleanupOrphans, exec, orphans)
    if (cleared.length > 0) {
      const list = cleared.map((n) => `#${n}`).join(' ')
      out(`🧹 ralph cycle: cleaned ${cleared.length} orphan(s): ${list}`)
      await notify(`🧹 ralph cycle: cleaned ${cleared.length} orphans in ${repoSlug}: ${list}`)
    }

    // WHERE THE DEPTH COMES FROM, per source: github asks `gh issue list`, folder counts
    // .ralph/tasks, jira runs the configured JQL through acli (#126). Since #127 the jira
    // arm counts the very queue the loop drains — the same composed query selects the
    // ticket — so this decision to start is about the right board. Why the gh gate above it
    // outlived that is recorded once, at `runPreflight`; why an unprovable count reads as 0
    // here and as `unknown` in `ralph status` is recorded once, in jira-queue.js.
    const queueCount =
      source === 'folder'
        ? await getFolderQueueCount(folderQueueCount, root)
        : source === 'jira'
          ? await getJiraQueueCount(jiraQueueCount, jiraJql, exec, root)
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
    const metricsText = safeReadText(readFile, metricsPath(root))
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
  //
  // #125: SPELLED AS THE RULE, `!== 'folder'`, rather than as the case
  // `=== 'github'` — and the difference is not style, it is the difference between
  // a gate that survives a new TASK_SOURCE value and one that quietly opens for it.
  // FOLDER MODE IS THE THING THAT OPTED OUT of gh; every other value of this knob
  // lands its work as a GitHub PR. So `jira` — registered by #125 — was a github run
  // for as long as it resolved no ticket, and needed github's preflight.
  //
  // #126 KEPT THIS AS IT IS, ON PURPOSE: that slice moved only the queue COUNT onto
  // acli. #127 THEN LANDED TICKET SELECTION — the loop picks a Jira ticket, claims it
  // with the `in-progress` label, and runs NO gh command in the iteration — and left
  // this gate standing anyway, which is a debt rather than a rule. Stated plainly so
  // nobody has to re-derive it: under `jira` this check now fails a run that would
  // have worked, and the reason it is still here is that `ralph start`'s equivalent
  // gate sits in front of three more GitHub steps (labels, the orphan sweep, and a
  // launch decision taken from GitHub's queue) that #127 did not move either. The two
  // commands share one story, so they get one follow-up; loosening this half alone
  // would leave `ralph start` refusing the same repo for a different reason.
  //
  // And what it no longer protects under `jira`: the silent failure reasoned about
  // just below is a GitHub count read as zero, and #126 moved that count onto acli, so
  // an unauthenticated gh cannot produce it for this source however this gate reads.
  //
  // The failure this avoids is silent, which is why it is worth a paragraph: with
  // the gate spelled the other way an unauthenticated `gh` sailed through here,
  // `getQueueCount` read empty stdout as NaN, NaN became a queue of ZERO, and every
  // cycle exited 0 announcing "queue empty" forever instead of naming the cause
  // once. `ralph start`'s equivalent gate already asks the question this way.
  if (source !== 'folder') {
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

// #126: default jira-queue counter — runs the configured JIRA_JQL through acli, with the
// spawner this command already holds. Injectable in tests via jiraQueueCount, so no test
// here can reach a real acli.
//
// This is the NUMBER-shaped reading of the probe, in which every failure is 0; `ralph status`
// injects a default that reads the same probe's discriminated form and renders a failure as
// `unknown`. Both live in jira-queue.js, which explains the split at length.
function defaultJiraQueueCount({ jql, exec }) {
  return jiraQueueCountLib(jql, { exec })
}

// ...and the same never-throws wrapper the folder arm gets, for the same reason: a count that
// cannot be taken means "nothing provable to do", so the cycle exits 0 saying the queue is
// empty and the next tick tries again.
//
// `cwd`, not `root`, for the third key: `ralph status` has a seam of its own with the same
// shape, taking the same option bag, so the two call sites have to name the repo root
// identically or a future default that wants it would silently read `undefined` in one of
// them. `cwd` is the spelling both files already use for a spawn's working directory.
async function getJiraQueueCount(jiraQueueCount, jql, exec, root) {
  try {
    const n = await jiraQueueCount({ jql, exec, cwd: root })
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
