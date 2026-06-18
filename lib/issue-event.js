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

// Find the LAST `message_start` event in the stream-json. It may appear EITHER
// as a bare `{type:'message_start',...}` line OR wrapped in a `stream_event`
// envelope (`{type:'stream_event',event:{type:'message_start',...}}`). Returns
// the UNWRAPPED message_start object (so callers always see `.message`). Skips
// blank / garbage / non-JSON lines gracefully. Never throws.
export function lastMessageStart(rawStreamJson) {
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
    if (!obj || typeof obj !== 'object') continue
    if (obj.type === 'message_start') {
      found = obj
    } else if (obj.type === 'stream_event' && obj.event?.type === 'message_start') {
      found = obj.event
    }
  }
  return found
}

// Model-id-prefix → context-window map. Defaults: opus/sonnet/fable = 1M,
// haiku = 200k. An unknown model resolves to null (we'd rather emit no pct than
// a wrong one). DEFAULT documented in templates/ralph.config.sh.
const CONTEXT_WINDOW_DEFAULT = 1_000_000
const CONTEXT_WINDOW_HAIKU = 200_000

// Resolve the context window for a model id. Resolution order:
//   1. explicit numeric `override` (finite, > 0) — wins over everything.
//   2. model-id-prefix map (opus|sonnet|fable → 1M; haiku → 200k).
//   3. null (unknown model, no override).
// A non-numeric / empty / <= 0 / non-finite override is IGNORED (falls to map).
export function resolveContextWindow(model, override) {
  const n = Number(override)
  if (Number.isFinite(n) && n > 0) return n
  const id = typeof model === 'string' ? model.toLowerCase() : ''
  if (!id) return null
  if (id.includes('opus') || id.includes('sonnet') || id.includes('fable')) {
    return CONTEXT_WINDOW_DEFAULT
  }
  if (id.includes('haiku')) return CONTEXT_WINDOW_HAIKU
  return null
}

// Combined: extract the end-of-job context occupancy from the raw stream and
// resolve it against the model's window. The statusline value = the INPUT side
// of the MOST RECENT model request = input + cache_read + cache_creation of the
// LAST message_start (NOT the cumulative result usage). Returns:
//   context_end_tokens — number (0 if no message_start / no usage)
//   context_end_pct     — tokens/window rounded to 6 dp, or null if window
//                          unknown or tokens unavailable
//   model               — model id string from the last message_start, or null
// Degrades to safe defaults on any malformed input; never throws.
export function computeContextEnd(rawStreamJson, windowOverride) {
  const ms = lastMessageStart(rawStreamJson)
  const message = ms && typeof ms.message === 'object' ? ms.message : null
  const usage = message && typeof message.usage === 'object' ? message.usage : {}
  const model = message && typeof message.model === 'string' ? message.model : null

  // Coerce each field numerically before summing: a finite numeric string
  // (e.g. "500") contributes its number, while null/undefined/NaN/Infinity/
  // garbage contribute 0. This guarantees context_end_tokens is ALWAYS a
  // finite number and never a concatenated string (e.g. "50000").
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  const tokens =
    num(usage.input_tokens) +
    num(usage.cache_read_input_tokens) +
    num(usage.cache_creation_input_tokens)

  const window = resolveContextWindow(model, windowOverride)
  // pct is a plain ratio rounded to 6 decimal places (e.g. 0.012345); 6 dp keeps
  // small occupancies meaningful against a 1M-token window. null when the window
  // is unknown (we won't emit a wrong number) or there are no tokens to report.
  const pct =
    window && tokens > 0 ? Math.round((tokens / window) * 1e6) / 1e6 : null

  return {
    context_end_tokens: tokens,
    context_end_pct: pct,
    model,
  }
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
    files = 0,
    insertions = 0,
    deletions = 0,
    contextWindowOverride = null,
  } = input || {}

  const result = lastResultLine(rawStreamJson)
  const context = computeContextEnd(rawStreamJson, contextWindowOverride)

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
    // Real PR diff stats (#530), handed in by the entrypoint; default to 0.
    files,
    insertions,
    deletions,
    // End-of-job context-window occupancy (#534): the statusline number, i.e.
    // the input side of the LAST model request, and its share of the window.
    context_end_tokens: context.context_end_tokens,
    context_end_pct: context.context_end_pct,
    model: context.model,
  }
}
