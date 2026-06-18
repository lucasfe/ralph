// Best-effort per-issue event capture entrypoint (CLI), invoked by the bash loop
// (templates/ralph.sh) AFTER it has computed the issue's label/state. It does
// NOT re-fetch anything from gh — every input is handed in via env vars. This is
// a TELEMETRY sidecar: any failure (parser crash, missing file, unwritable dir)
// MUST exit 0 and never abort or alter the loop.
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
//
// On success appends one `RALPH_ISSUE_EVENT <json>` line via appendIssueEvent.

import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { buildIssueEvent } from './issue-event.js'
import { appendIssueEvent } from './issue-metrics.js'

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
export function captureIssueEvent({ env = {}, now = Date.now, log = console.error } = {}) {
  try {
    const projectRoot = env.PROJECT_ROOT || process.cwd()
    const rawStreamJson = readFileSafe(env.RALPH_RAW_JSONL_PATH)
    const stderrLog = readFileSafe(env.RALPH_STDERR_LOG_PATH)

    const issueNumber = Number.parseInt(env.RALPH_ISSUE_NUMBER, 10)
    const claudeExitCode = Number.parseInt(env.RALPH_CLAUDE_EXIT, 10)

    const event = buildIssueEvent({
      rawStreamJson,
      stderrLog,
      issueNumber: Number.isNaN(issueNumber) ? null : issueNumber,
      runId: env.RALPH_RUN_ID || '',
      claudeExitCode: Number.isNaN(claudeExitCode) ? null : claudeExitCode,
      labels: parseLabels(env.RALPH_ISSUE_LABELS),
      state: env.RALPH_ISSUE_STATE || '',
      ts: now(),
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
