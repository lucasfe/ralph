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
