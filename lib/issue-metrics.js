// Append-only writer for per-issue metrics, and the never-throws text read its
// consumers share (`safeReadText`, below — a path in, the text or '' out, and no
// longer only for this file). Each completed issue iteration appends ONE
// line `RALPH_ISSUE_EVENT <json>\n` to .ralph/metrics/issues.jsonl. Never
// truncates — events accumulate across runs. Follows the injectable-fs pattern
// from state.js (wrap real fs, fall back when no fsImpl passed).

import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  appendFileSync as realAppendFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
// The log's LINE FORMAT, in the one module that owns it since #121 — the tag this file writes
// and the walk its aggregator reads back. It has no imports of its own, which is the whole
// reason it is a separate module: lib/banner-model.js and lib/progress.js read the same lines
// and are both asserted pure, so the shared parser could not live in this file's `node:fs`.
import { ISSUE_EVENT_TAG, issueEvents } from './issue-event-lines.js'

export function metricsPath(projectRoot) {
  return join(projectRoot, '.ralph', 'metrics', 'issues.jsonl')
}

// The read every consumer of that file needs, in one place: `ralph cycle` (#532),
// `ralph status` (#57) and `ralph start` (#60) all want the text and none of them
// may die for it. The file is APPEND-ONLY and written by a bash loop that can be
// killed mid-line, so "missing, unreadable or half-written" is the normal case, not
// the exceptional one — and every caller's fallback for it is the same '': a cycle
// reports zeros, a status view reports `unknown`, a launch box drops a hint.
//
// NOT METRICS-SPECIFIC, and named for that since #117: nothing below looks at the
// path. `ralph start` reads `<cwd>/.git/config` through it for the banner's repo row
// (#69) on exactly the same contract — "read this path as text, answer '' for
// missing, unreadable, half-written or Buffer-returning". It lives in this module
// because the metrics log is what first needed it, not because it knows anything
// about the log.
//
// `readFile` is a parameter rather than the real fs so the commands keep passing
// their injected one — no test here touches a real .ralph. `?.toString()` because an
// injected fs (or a real one called without an encoding) may hand back a Buffer, and
// every caller downstream parses this as a STRING.
export function safeReadText(readFile, path) {
  try {
    return readFile(path, 'utf8')?.toString() || ''
  } catch {
    return ''
  }
}

// PURE aggregator over the newline-delimited issues.jsonl text (no I/O, no
// Date.now). Keeps only events whose numeric `ts` epoch-ms is `>= since`, and
// tallies verdicts: `pass` is ok, everything else (`fail`/`unknown`) is failed —
// matching the bash loop's conservative accounting where an indeterminate issue
// counts as a failure. Events with a missing or non-finite `ts` are skipped;
// never throws.
//
// WHAT A LINE IS is no longer decided here (#121). `issueEvents` finds the tag,
// parses it and rejects anything that is not an event object, so the blank,
// untagged, bad-JSON and truncated lines this used to skip for itself are simply
// never yielded — and the box in `ralph start`, which reads the same log from the
// other end, cannot come to a different opinion about which lines count. It is a
// GENERATOR, which is exactly what this loop wants: nothing below needs the
// events themselves, and issues.jsonl grows for the life of the repo.
//
// NOR IS "NO LOG AT ALL" decided here any more. There was an early return for a
// falsy `jsonlText` above this loop, returning the same zeros the loop below
// produces from nothing; the walk answers a missing, empty or non-string log with
// no events, so the guard was a second spelling of the empty case rather than a
// different answer to it. Dropping it also closes the one hole it left: a truthy
// non-string used to reach `.split` and throw, which this function's own docblock
// promised it would not.
//
// AN EVENT WITHOUT A NUMBER STILL COUNTS, and the split between the tallies and the
// lists below is deliberate rather than incidental: `ok`/`failed` are what the cycle's
// exit code and its `N ok, N failed` are built from, so an event that happened has to be
// counted whatever it is called, while `okIssues`/`failedIssues` are a list of NAMES and a
// `null` in one of them would render as `#null`. Reachable in production since #131: a
// jira event's `issue_number` is derived from the ticket key, and a key the grammar cannot
// read a number out of (lib/jira-key.js) leaves it null. The `task_key` such an event
// carries is not read here — the aggregation is on the numeric field, exactly as it was
// before that field had a second spelling beside it, and naming those lists by key instead
// would change the documented shape of `ralph cycle`'s `successes`/`failures`.
export function aggregateCycleCounts(jsonlText, since) {
  const okIssues = []
  const failedIssues = []
  let ok = 0
  let failed = 0

  for (const event of issueEvents(jsonlText)) {
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
  // The tag comes from the shared constant rather than a literal: this used to be the fourth
  // spelling of it in the repo, and the ONE line format the readers slice off is the one the
  // writer must join onto.
  fs.appendFileSync(path, ISSUE_EVENT_TAG + JSON.stringify(event) + '\n')
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
