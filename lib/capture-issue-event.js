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
//   TASK_SOURCE           - task source ('github' default | 'folder' | 'jira'). Only
//                           github does its bookkeeping on GitHub, so only github
//                           reads a verdict off issue labels/state and only github
//                           fetches a PR diff (see worksThroughGitHub in
//                           task-source.js). The other two name their work item with
//                           an env var of their own and report their own outcome.
//   RALPH_TASK_ID         - folder-mode task id (numeric); recorded as the event
//                           issue_number when TASK_SOURCE=folder.
//   RALPH_TASK_KEY        - jira-mode work item key ('FOO-123'); recorded verbatim as
//                           the event's `task_key` and the source of its NUMERIC
//                           issue_number, derived as 123 (see jira-key.js). A key no
//                           number can be read out of records the key with a null
//                           number rather than refusing the event.
//   RALPH_TASK_OUTCOME    - the terminal state the LOOP read back for folder and jira
//                           mode — a directory ('done'|'failed'|...) there, a board
//                           label here; done => pass, failed => fail, else unknown.
//
// On success appends one `RALPH_ISSUE_EVENT <json>` line via appendIssueEvent.

import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { buildIssueEvent } from './issue-event.js'
import { appendIssueEvent } from './issue-metrics.js'
import { fetchPrDiffStats as realFetchPrDiffStats } from './pr-diff-stats.js'
import { resolveAgent } from './agent-registry.js'
import { resolveSource, worksThroughGitHub } from './task-source.js'
import { numberFromKey, usableJiraKey } from './jira-key.js'

// #565: map the terminal state the loop read back (RALPH_TASK_OUTCOME) to a
// verdict. `done` => pass, `failed` => fail; anything else (in-progress, todo,
// unset) => unknown. Returned as the verdictOverride into buildIssueEvent.
//
// ONE MAPPING FOR BOTH NON-GITHUB SOURCES since #131, and the two really are the same
// question asked of different storage: folder mode reads the DIRECTORY a task ended in and
// jira mode reads the LABEL the board carries, and both hand this the word `done` or
// `failed` (templates/ralph.sh normalizes each to one of those two before it exports it).
// A second copy for jira would be two spellings of one rule, free to drift.
function verdictFromOutcome(outcome) {
  const o = (outcome || '').trim().toLowerCase()
  if (o === 'done') return 'pass'
  if (o === 'failed') return 'fail'
  return 'unknown'
}

// The NUMBER this event is filed under, per source. Three modules read `issue_number` back
// out of issues.jsonl, and all three read it as a finite number or null: the task table and
// progress line (`buildTaskRows`, lib/progress.js), the report card's counts and failed list
// (`tallyVerdicts`, lib/post-mortem.js) and the cycle counts (`aggregateCycleCounts`,
// lib/issue-metrics.js). So each source has to produce one, and null
// is the shared "unknown" rather than a NaN that would reach the JSON as null anyway and reach
// a reader as arithmetic.
//
// JIRA DERIVES ITS NUMBER FROM THE KEY (`FOO-123` → 123) instead of being handed one,
// because the key is the only identity Jira has; lib/jira-key.js carries the full argument,
// including the accepted collision (`FOO-1` and `BAR-1` both yield 1, tolerable because a
// JQL is normally scoped to one project). The KEY itself is recorded beside it, so nothing
// downstream has to reverse this derivation.
function resolveTaskNumber(source, env) {
  if (source === 'jira') return numberFromKey(env.RALPH_TASK_KEY)
  const parsed = Number.parseInt(source === 'folder' ? env.RALPH_TASK_ID : env.RALPH_ISSUE_NUMBER, 10)
  return Number.isNaN(parsed) ? null : parsed
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

    // WHICH WORK ITEM THIS EVENT IS ABOUT, and how its outcome was decided. github reads
    // RALPH_ISSUE_NUMBER and a verdict off the issue's labels/state exactly as it always
    // has; folder (#565) reads the numeric task id and the terminal directory; jira (#131)
    // reads the ticket KEY, records it as `task_key`, and derives the number from it.
    const source = resolveSource(env)
    const resolvedIssueNumber = resolveTaskNumber(source, env)
    // Recorded ONLY under jira, so a stale RALPH_TASK_KEY exported by an earlier iteration
    // cannot put a Jira key on a github or folder event — the source decides the identity,
    // not whichever env vars happen to be set. `usableJiraKey` and not `normalizeJiraKey`:
    // Jira names its own tickets, and a key this repo's grammar refuses is still the ticket
    // the run just worked (lib/jira-key.js).
    const taskKey = source === 'jira' ? usableJiraKey(env.RALPH_TASK_KEY) : null
    const claudeExitCode = Number.parseInt(env.RALPH_CLAUDE_EXIT, 10)
    const verdictOverride = worksThroughGitHub(source)
      ? null
      : verdictFromOutcome(env.RALPH_TASK_OUTCOME)

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
    // injected fetcher that throws so the event is still written.
    //
    // ONLY A SOURCE THAT OPENS PULL REQUESTS IS ASKED FOR A DIFF. folder mode (#565) and
    // jira mode (#131) commit straight to DEV_BRANCH — no branch, no PR, nothing for
    // `gh pr list` to find — so the call is SKIPPED rather than allowed to fail its way to
    // the same zeros: a run on a machine with no `gh` at all still writes a complete event,
    // and it writes it without paying for a subprocess that can only answer nothing.
    let diff = { additions: 0, deletions: 0, changedFiles: 0 }
    if (worksThroughGitHub(source)) {
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
      taskKey,
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
