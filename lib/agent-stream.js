// PURE agent stream parser — NO I/O, NO clock. Given a raw agent output stream
// and the agent name, it returns a NORMALIZED result the per-issue event
// builder consumes, so issue-event.js holds no agent-specific parsing (#554):
//
//   {
//     usage: { input_tokens, output_tokens,
//              cache_read_input_tokens, cache_creation_input_tokens },
//     subtype,             // 'success' | error subtype | null — RECONCILED with
//                          //   is_error, never the raw field (see reportedSubtype)
//     is_error,            // boolean: the stream flagged this run as failed
//     num_turns,           // integer
//     model,               // model id string or null
//     total_cost_usd,      // number (0 when the agent reports no price)
//     duration_ms,         // number (0 when the agent self-reports none)
//     context_end_tokens,  // input side of the LAST model request
//   }
//
// The Claude implementation is an EXACT carry-over of the logic that previously
// lived in issue-event.js (lastResultLine / lastMessageStart / normalizeUsage /
// the token sum), pinned by tests migrated from issue-event.test.js — the
// subtype reconciliation above is its one deliberate divergence since. The Codex
// implementation is added alongside; parseAgentStream dispatches on agent.
// Both degrade gracefully on blank / truncated / non-JSON input and NEVER throw.

// The two normalized subtype sentinels. Both agents speak this vocabulary:
// 'success' is the only value that means a healthy run, and 'error' is the
// generic failure name used when the stream reports no more specific one.
const SUCCESS_SUBTYPE = 'success'
const ERROR_SUBTYPE = 'error'

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

// Coerce a value numerically: a finite number (or numeric string) contributes
// its value; null/undefined/NaN/Infinity/garbage contribute 0.
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// Iterate parseable JSON objects from a newline-delimited stream, skipping
// blank / garbage / non-JSON lines. Never throws.
function* jsonLines(rawStream) {
  if (!rawStream) return
  for (const line of rawStream.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (obj && typeof obj === 'object') yield obj
  }
}

// --- Claude implementation (carry-over) -------------------------------------

// Find the LAST parseable `.type === 'result'` line.
function lastResultLine(rawStreamJson) {
  let found = null
  for (const obj of jsonLines(rawStreamJson)) {
    if (obj.type === 'result') found = obj
  }
  return found
}

// Find the LAST `message_start` event — either bare or wrapped in a
// `stream_event` envelope. Returns the UNWRAPPED object (so callers always see
// `.message`). Exported because issue-event.js re-exports it for compatibility.
export function lastMessageStart(rawStreamJson) {
  let found = null
  for (const obj of jsonLines(rawStreamJson)) {
    if (obj.type === 'message_start') {
      found = obj
    } else if (obj.type === 'stream_event' && obj.event?.type === 'message_start') {
      found = obj.event
    }
  }
  return found
}

// Normalize a claude usage object onto the four keys.
export function normalizeUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {}
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  }
}

// Did the stream FLAG this result as failed? Strictly the JSON boolean `true`,
// so an absent or false flag is a healthy run exactly as before (#39).
function isErrorResult(result) {
  return result.is_error === true
}

// The subtype to report for a result line, reconciled with its error flag. The
// `result` event carries BOTH, and on a hard failure they DISAGREE: the real
// auth-failure payload is {"subtype":"success","is_error":true,"num_turns":1}.
// `is_error` is authoritative about pass/fail; `subtype` only NAMES the outcome.
// So a flagged result never reports success — it keeps its own subtype when that
// already names the error (error_max_turns stays error_max_turns) and falls back
// to the generic ERROR_SUBTYPE when the subtype contradicts the flag or is absent.
function reportedSubtype(result) {
  const subtype = result.subtype ?? null
  if (!isErrorResult(result)) return subtype
  return subtype && subtype !== SUCCESS_SUBTYPE ? subtype : ERROR_SUBTYPE
}

function parseClaude(rawStream) {
  const result = lastResultLine(rawStream)
  const ms = lastMessageStart(rawStream)
  const message = ms && typeof ms.message === 'object' ? ms.message : null
  const usage = message && typeof message.usage === 'object' ? message.usage : {}
  const model = message && typeof message.model === 'string' ? message.model : null

  // Statusline value = input side of the MOST RECENT model request.
  const contextEndTokens =
    num(usage.input_tokens) +
    num(usage.cache_read_input_tokens) +
    num(usage.cache_creation_input_tokens)

  return {
    usage: result ? normalizeUsage(result.usage) : { ...ZERO_USAGE },
    subtype: result ? reportedSubtype(result) : null,
    is_error: result ? isErrorResult(result) : false,
    num_turns: result ? (result.num_turns ?? 0) : 0,
    model,
    total_cost_usd: result ? (result.total_cost_usd ?? 0) : 0,
    duration_ms: result ? (result.duration_ms ?? 0) : 0,
    context_end_tokens: contextEndTokens,
  }
}

// --- Codex implementation ---------------------------------------------------
// Codex's `codex exec --json` emits a newline-delimited JSON event stream.
// Observed event shapes (Codex CLI 0.146.x):
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"type":"agent_message"|"error",...}}
//   {"type":"turn.completed","usage":{
//       input_tokens, cached_input_tokens, cache_write_input_tokens,
//       output_tokens, reasoning_output_tokens}}
//   {"type":"turn.failed","error":{"message":"..."}}   (API failure)
//   {"type":"error","message":"..."}                    (transport/model error)
// The stream carries NO model id and NO cost/duration — those gaps are filled
// by the event builder from the configured model + the loop's wall clock.
// Parsing is defensive: every field may be absent.
function parseCodex(rawStream) {
  let lastUsage = null
  let completedTurns = 0
  let failed = false

  for (const obj of jsonLines(rawStream)) {
    switch (obj.type) {
      case 'turn.completed':
        completedTurns++
        if (obj.usage && typeof obj.usage === 'object') lastUsage = obj.usage
        break
      case 'turn.failed':
      case 'error':
        failed = true
        break
      case 'item.completed':
        // A completed item may itself be an error item.
        if (obj.item && obj.item.type === 'error') failed = true
        break
      default:
        break
    }
  }

  const u = lastUsage || {}
  // Reasoning tokens are genuinely billable OUTPUT and dominated output on even
  // a trivial turn in testing, so fold them into output_tokens rather than drop
  // them (the raw split remains in the per-issue .jsonl sidecar). Codex's
  // cached-input maps to cache_read; cache-write maps to cache_creation.
  const usage = {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens) + num(u.reasoning_output_tokens),
    cache_read_input_tokens: num(u.cached_input_tokens),
    cache_creation_input_tokens: num(u.cache_write_input_tokens),
  }

  // Subtype: a failure event anywhere wins; else success if any turn completed;
  // else null (nothing ran / truncated).
  let subtype = null
  if (failed) subtype = ERROR_SUBTYPE
  else if (completedTurns > 0) subtype = SUCCESS_SUBTYPE

  return {
    usage,
    subtype,
    // Codex names its failure events outright, so the flag is just the same
    // outcome in boolean form — the normalized shape is identical for both agents.
    is_error: failed,
    num_turns: completedTurns,
    model: null, // Codex's stream carries no model id.
    total_cost_usd: 0, // No price table — never fabricate a cost.
    duration_ms: 0, // Codex self-reports none; the loop injects wall-clock.
    context_end_tokens:
      usage.input_tokens +
      usage.cache_read_input_tokens +
      usage.cache_creation_input_tokens,
  }
}

const PARSERS = { claude: parseClaude, codex: parseCodex }

export function parseAgentStream(rawStream, agent) {
  const parser = PARSERS[agent]
  if (!parser) {
    throw new Error(`parseAgentStream: unknown agent '${agent}'`)
  }
  return parser(rawStream ?? '')
}
