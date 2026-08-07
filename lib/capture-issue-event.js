// Best-effort per-issue event capture entrypoint (CLI), invoked by the bash loop
// (templates/ralph.sh) AFTER it has computed the issue's label/state. Most inputs
// are handed in via env vars; the ONE exception is the PR diff stats, which this
// entrypoint fetches with a single best-effort `gh` call (the issue branch is
// merged+deleted before the iteration returns, so only the PR retains the diff —
// see pr-diff-stats.js). That fetch degrades to zeros on any failure. This is a
// TELEMETRY sidecar: any failure (parser crash, missing file, unwritable dir,
// failed gh call) MUST exit 0 and never abort or alter the loop.
//
// Env-var contract (all read from `env`, default to process.env when invoked as
// a script):
//   PROJECT_ROOT          - repo root; where .ralph/metrics/issues.jsonl lives
//   RALPH_ISSUE_NUMBER    - issue number (integer string)
//   RALPH_RUN_ID          - run id (`<session>-<start-epoch>`)
//   RALPH_CLAUDE_EXIT     - claude's exit code (integer string)
//   RALPH_ISSUE_LABELS    - comma-joined issue labels (e.g. "bug,pending-merge")
//   RALPH_ISSUE_STATE     - issue state ('OPEN' | 'CLOSED')
//   RALPH_DEV_BRANCH      - dev branch name (recorded for future diff slices)
//   RALPH_RAW_JSONL_PATH  - path to the tee'd raw claude stream-json (.jsonl)
//   RALPH_STDERR_LOG_PATH - path to the per-issue stderr log
//   RALPH_CONTEXT_WINDOW  - optional numeric override for the model's context
//                           window (tokens); ignored if non-numeric/<=0. When
//                           absent, the window is resolved from the model id
//                           (opus/sonnet/fable=1M, haiku=200k) — see issue-event.js.
//   RALPH_AGENT           - selected agent ('claude' default | 'codex'); the
//                           RESOLVED agent is recorded (fallback is auditable).
//   RALPH_CODEX_MODEL     - configured Codex model id; recorded as the event
//                           model for Codex (null when unset — never guessed).
//   RALPH_DURATION_MS     - loop-measured wall-clock duration (ms); used when
//                           the stream self-reports none (Codex).
//   TASK_SOURCE           - task source ('github' default | 'folder'). In folder
//                           mode the event's number comes from RALPH_TASK_ID, the
//                           verdict from RALPH_TASK_OUTCOME, and NO gh PR diff is
//                           fetched (folder mode opens no PRs).
//   RALPH_TASK_ID         - folder-mode task id (numeric); recorded as the event
//                           issue_number when TASK_SOURCE=folder.
//   RALPH_TASK_OUTCOME    - folder-mode terminal directory ('done'|'failed'|...);
//                           done => pass, failed => fail, else unknown.
//
// On success appends one `RALPH_ISSUE_EVENT <json>` line via appendIssueEvent.

import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { buildIssueEvent } from './issue-event.js'
import { appendIssueEvent } from './issue-metrics.js'
import { fetchPrDiffStats as realFetchPrDiffStats } from './pr-diff-stats.js'
import { resolveAgent } from './agent-registry.js'
import { resolveSource } from './task-source.js'

// #565: map a folder task's terminal directory (RALPH_TASK_OUTCOME) to a
// verdict. `done` => pass, `failed` => fail; anything else (in-progress, todo,
// unset) => unknown. Returned as the verdictOverride into buildIssueEvent.
function verdictFromOutcome(outcome) {
  const o = (outcome || '').trim().toLowerCase()
  if (o === 'done') return 'pass'
  if (o === 'failed') return 'fail'
  return 'unknown'
}

function readFileSafe(path) {
  if (!path || !existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8').toString()
  } catch {
    return ''
  }
}

function parseLabels(joined) {
  if (!joined) return []
  return joined
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Best-effort: wrap EVERYTHING; on any error write a short diagnostic and return
// without throwing. The caller (script guard) exits 0 regardless.
export function captureIssueEvent({
  env = {},
  now = Date.now,
  log = console.error,
  fetchDiffStats = realFetchPrDiffStats,
} = {}) {
  try {
    const projectRoot = env.PROJECT_ROOT || process.cwd()
    const rawStreamJson = readFileSafe(env.RALPH_RAW_JSONL_PATH)
    const stderrLog = readFileSafe(env.RALPH_STDERR_LOG_PATH)

    // #565: in folder mode the "issue number" is the numeric task id
    // (RALPH_TASK_ID) and the verdict comes from the terminal task directory
    // (RALPH_TASK_OUTCOME) rather than issue labels/state. github mode reads
    // RALPH_ISSUE_NUMBER exactly as before.
    const source = resolveSource(env)
    const numberEnv = source === 'folder' ? env.RALPH_TASK_ID : env.RALPH_ISSUE_NUMBER
    const issueNumber = Number.parseInt(numberEnv, 10)
    const claudeExitCode = Number.parseInt(env.RALPH_CLAUDE_EXIT, 10)
    const resolvedIssueNumber = Number.isNaN(issueNumber) ? null : issueNumber
    const verdictOverride =
      source === 'folder' ? verdictFromOutcome(env.RALPH_TASK_OUTCOME) : null

    // Optional context-window override; null unless a finite positive number.
    const cw = Number(env.RALPH_CONTEXT_WINDOW)
    const contextWindowOverride = Number.isFinite(cw) && cw > 0 ? cw : null

    // #554: resolve the RESOLVED agent (a fallback is recorded as-run, so a
    // RALPH_AGENT typo is auditable), the configured Codex model (null when
    // unset — never guessed), and the loop's wall-clock duration (Codex
    // self-reports none). The Claude path is unaffected: RALPH_AGENT unset =>
    // claude, model override ignored (its stream carries the real model).
    const { agent } = resolveAgent(env)
    const configuredModel = (env.RALPH_CODEX_MODEL || '').trim() || null
    const dm = Number(env.RALPH_DURATION_MS)
    const durationMs = Number.isFinite(dm) && dm > 0 ? dm : null

    // Best-effort: never lets a slow/failed gh call abort the loop. The real
    // fetcher already degrades to zeros internally; this guard also covers an
    // injected fetcher that throws so the event is still written. #565: folder
    // mode opens no PRs, so there is nothing to diff — skip the gh call entirely
    // and record zeros.
    let diff = { additions: 0, deletions: 0, changedFiles: 0 }
    if (source !== 'folder') {
      try {
        diff = fetchDiffStats(resolvedIssueNumber) || diff
      } catch (e) {
        log(`capture-issue-event: diff stats unavailable (${e && e.message ? e.message : e})`)
      }
    }

    const event = buildIssueEvent({
      rawStreamJson,
      stderrLog,
      issueNumber: resolvedIssueNumber,
      runId: env.RALPH_RUN_ID || '',
      claudeExitCode: Number.isNaN(claudeExitCode) ? null : claudeExitCode,
      labels: parseLabels(env.RALPH_ISSUE_LABELS),
      state: env.RALPH_ISSUE_STATE || '',
      ts: now(),
      files: diff.changedFiles,
      insertions: diff.additions,
      deletions: diff.deletions,
      contextWindowOverride,
      agent,
      model: configuredModel,
      durationMs,
      verdictOverride,
    })

    appendIssueEvent(projectRoot, event)
  } catch (e) {
    // Telemetry must never break the loop.
    log(`capture-issue-event: skipped (${e && e.message ? e.message : e})`)
  }
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  captureIssueEvent({ env: process.env })
  process.exit(0)
}
