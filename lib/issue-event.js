// PURE per-issue event builder. NO I/O, NO Date.now, NO process access — every
// input (including the timestamp) is injected so this is trivially testable and
// deterministic. Given the raw agent stream, the per-issue stderr log, and the
// issue's label/state, it returns the normalized event object that the metrics
// writer appends to .ralph/metrics/issues.jsonl.
//
// Stream PARSING is delegated to agent-stream.js (#554), so this module holds
// no agent-specific parsing. It selects the parser by the injected `agent`
// (default 'claude'), adds an `agent` field to the event, and — for agents
// whose stream carries no model id (Codex) — records the injected configured
// model and the loop's wall-clock duration instead. Every existing Claude
// field name (including `claude_exit_code`) is preserved byte-for-byte.

import { parseAgentStream, lastMessageStart, normalizeUsage } from './agent-stream.js'

// Re-export the Claude parsing helpers so existing importers (and tests) that
// referenced them from issue-event.js keep working unchanged.
export { lastMessageStart, normalizeUsage }

// Case-insensitive signal regex for auth / credit / rate-limit failures.
const ERROR_SIGNAL = /auth|credit|rate.?limit/i

// Model-id-prefix → context-window map. Anthropic defaults: opus/sonnet/fable =
// 1M, haiku = 200k. OpenAI/Codex families (#554): gpt-5 / gpt-4.1 / o3 / o4 /
// codex resolve to 400k — the window Codex reports for its current models; the
// legacy gpt-4o family is 128k. An unknown model resolves to null (we'd rather
// emit no pct than a wrong one). DEFAULT documented in templates/ralph.config.sh.
const CONTEXT_WINDOW_DEFAULT = 1_000_000
const CONTEXT_WINDOW_HAIKU = 200_000
const CONTEXT_WINDOW_OPENAI = 400_000
const CONTEXT_WINDOW_GPT4O = 128_000

// Resolve the context window for a model id. Resolution order:
//   1. explicit numeric `override` (finite, > 0) — wins over everything.
//   2. model-id-prefix map (Anthropic + OpenAI families).
//   3. null (unknown model, no override).
// A non-numeric / empty / <= 0 / non-finite override is IGNORED (falls to map).
export function resolveContextWindow(model, override) {
  const n = Number(override)
  if (Number.isFinite(n) && n > 0) return n
  const id = typeof model === 'string' ? model.toLowerCase() : ''
  if (!id) return null
  // Anthropic families.
  if (id.includes('opus') || id.includes('sonnet') || id.includes('fable')) {
    return CONTEXT_WINDOW_DEFAULT
  }
  if (id.includes('haiku')) return CONTEXT_WINDOW_HAIKU
  // OpenAI / Codex families. gpt-4o (legacy, 128k) is checked BEFORE the
  // generic gpt-* rule so it isn't swallowed by the 400k default.
  if (id.includes('gpt-4o') || id.includes('gpt4o')) return CONTEXT_WINDOW_GPT4O
  if (
    id.includes('gpt-5') ||
    id.includes('gpt-4.1') ||
    id.includes('gpt-4') ||
    id.includes('codex') ||
    /\bo[34]\b/.test(id) ||
    id.startsWith('o3') ||
    id.startsWith('o4')
  ) {
    return CONTEXT_WINDOW_OPENAI
  }
  return null
}

// Combined: extract the end-of-job context occupancy from the raw stream and
// resolve it against the model's window. The statusline value = the INPUT side
// of the MOST RECENT model request. For Claude this comes from the last
// message_start; the model is read from the stream. For agents whose stream has
// no model id (Codex), the caller supplies `modelOverride`. Returns:
//   context_end_tokens — number (0 if no usage)
//   context_end_pct     — tokens/window rounded to 6 dp, or null if window
//                          unknown or tokens unavailable
//   model               — resolved model id string, or null
//   context_window      — the resolved window in tokens, or null when unknown
// Degrades to safe defaults on any malformed input; never throws.
export function computeContextEnd(
  rawStreamJson,
  windowOverride,
  { agent = 'claude', modelOverride = null } = {},
) {
  const parsed = parseAgentStream(rawStreamJson, agent)
  const model = parsed.model ?? (modelOverride || null)
  const tokens = parsed.context_end_tokens

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
    context_window: window,
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
    // #554: which agent produced this stream, the configured model id for
    // agents whose stream carries none (Codex), and a wall-clock duration the
    // loop measures for those same agents. All default so the Claude path is
    // byte-identical to before.
    agent = 'claude',
    model: modelOverride = null,
    durationMs = null,
  } = input || {}

  const parsed = parseAgentStream(rawStreamJson, agent)
  const context = computeContextEnd(rawStreamJson, contextWindowOverride, {
    agent,
    modelOverride,
  })

  // Duration: prefer the stream's own value when it reports one; otherwise fall
  // back to the injected wall-clock (Codex self-reports no duration).
  const streamDuration = parsed.duration_ms
  const resolvedDuration =
    streamDuration > 0
      ? streamDuration
      : Number.isFinite(Number(durationMs)) && Number(durationMs) > 0
        ? Number(durationMs)
        : streamDuration

  return {
    issue_number: issueNumber,
    run_id: runId,
    ts,
    // Which agent resolved this issue (the RESOLVED agent, so a fallback is
    // auditable). Additive field; the rest of the schema shape is unchanged.
    agent,
    subtype: parsed.subtype,
    total_cost_usd: parsed.total_cost_usd,
    num_turns: parsed.num_turns,
    duration_ms: resolvedDuration,
    usage: parsed.usage,
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
    context_window: context.context_window,
  }
}
