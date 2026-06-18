// PURE per-issue event builder. NO I/O, NO Date.now, NO process access — every
// input (including the timestamp) is injected so this is trivially testable and
// deterministic. Given the raw claude stream-json, the per-issue stderr log, and
// the issue's label/state, it returns the normalized event object that the
// metrics writer appends to .ralph/metrics/issues.jsonl.

// Case-insensitive signal regex for auth / credit / rate-limit failures.
const ERROR_SIGNAL = /auth|credit|rate.?limit/i

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

// Find the LAST parseable `.type === 'result'` line in the newline-delimited
// stream-json. Skips blank / garbage / non-JSON lines gracefully. Never throws.
function lastResultLine(rawStreamJson) {
  if (!rawStreamJson) return null
  let found = null
  for (const line of rawStreamJson.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (obj && obj.type === 'result') found = obj
  }
  return found
}

function normalizeUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {}
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  }
}

function countErrorSignals(stderrLog) {
  if (!stderrLog) return 0
  let n = 0
  for (const line of stderrLog.split('\n')) {
    if (ERROR_SIGNAL.test(line)) n++
  }
  return n
}

// Verdict precedence: claude-failed label => fail wins (even if CLOSED/OPEN);
// else CLOSED state OR pending-merge label => pass; else unknown.
function computeVerdict(labels, state) {
  const ls = Array.isArray(labels) ? labels : []
  if (ls.includes('claude-failed')) return 'fail'
  if (state === 'CLOSED' || ls.includes('pending-merge')) return 'pass'
  return 'unknown'
}

export function buildIssueEvent(input) {
  const {
    rawStreamJson = '',
    stderrLog = '',
    issueNumber,
    runId,
    claudeExitCode,
    labels = [],
    state,
    ts,
  } = input || {}

  const result = lastResultLine(rawStreamJson)

  return {
    issue_number: issueNumber,
    run_id: runId,
    ts,
    subtype: result ? (result.subtype ?? null) : null,
    total_cost_usd: result ? (result.total_cost_usd ?? 0) : 0,
    num_turns: result ? (result.num_turns ?? 0) : 0,
    duration_ms: result ? (result.duration_ms ?? 0) : 0,
    usage: result ? normalizeUsage(result.usage) : { ...ZERO_USAGE },
    claude_exit_code: claudeExitCode,
    stderr_error_signals: countErrorSignals(stderrLog),
    verdict: computeVerdict(labels, state),
    // diff fields — placeholders for this slice (#529).
    files: 0,
    insertions: 0,
    deletions: 0,
  }
}
