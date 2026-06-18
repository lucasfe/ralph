// Append-only writer for per-issue metrics. Each completed issue iteration
// appends ONE line `RALPH_ISSUE_EVENT <json>\n` to .ralph/metrics/issues.jsonl.
// Never truncates — events accumulate across runs. Follows the injectable-fs
// pattern from state.js (wrap real fs, fall back when no fsImpl passed).

import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  appendFileSync as realAppendFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export function metricsPath(projectRoot) {
  return join(projectRoot, '.ralph', 'metrics', 'issues.jsonl')
}

const ISSUE_EVENT_TAG = 'RALPH_ISSUE_EVENT '

// PURE aggregator over the newline-delimited issues.jsonl text (no I/O, no
// Date.now). Parses each `RALPH_ISSUE_EVENT <json>` line, keeps only events
// whose numeric `ts` epoch-ms is `>= since`, and tallies verdicts: `pass` is
// ok, everything else (`fail`/`unknown`) is failed — matching the bash loop's
// conservative accounting where an indeterminate issue counts as a failure.
// Malformed lines (blank, untagged, bad JSON, missing/non-finite ts) are
// skipped silently; never throws.
export function aggregateCycleCounts(jsonlText, since) {
  const okIssues = []
  const failedIssues = []
  let ok = 0
  let failed = 0

  if (!jsonlText) {
    return { ok, failed, processed: 0, okIssues, failedIssues }
  }

  for (const line of jsonlText.split('\n')) {
    const idx = line.indexOf(ISSUE_EVENT_TAG)
    if (idx === -1) continue
    let event
    try {
      event = JSON.parse(line.slice(idx + ISSUE_EVENT_TAG.length))
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    const ts = event.ts
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < since) continue

    const issueNumber = event.issue_number
    const isFinite = typeof issueNumber === 'number' && Number.isFinite(issueNumber)
    if (event.verdict === 'pass') {
      ok++
      if (isFinite) okIssues.push(issueNumber)
    } else {
      failed++
      if (isFinite) failedIssues.push(issueNumber)
    }
  }

  return { ok, failed, processed: ok + failed, okIssues, failedIssues }
}

export function appendIssueEvent(projectRoot, event, fsImpl) {
  const fs = wrap(fsImpl)
  const path = metricsPath(projectRoot)
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.appendFileSync(path, 'RALPH_ISSUE_EVENT ' + JSON.stringify(event) + '\n')
}

function wrap(fsImpl) {
  if (!fsImpl) {
    return {
      existsSync: realExistsSync,
      mkdirSync: realMkdirSync,
      appendFileSync: realAppendFileSync,
    }
  }
  return {
    existsSync: fsImpl.existsSync.bind(fsImpl),
    mkdirSync: fsImpl.mkdirSync.bind(fsImpl),
    appendFileSync: fsImpl.appendFileSync.bind(fsImpl),
  }
}
