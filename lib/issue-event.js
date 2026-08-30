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
// #139: the two labels the GitHub outcome precedence below reads, taken from lib/labels.js.
// The loop STAMPS them (templates/ralph.sh) and this module INTERPRETS them, so a spelling
// that drifted between the two would silently downgrade every recorded verdict to `unknown` —
// a metrics log that says nothing failed and nothing passed. Imports nothing itself, so this
// module stays as cheap to load as it was.
import { FAILED_LABEL, PENDING_MERGE_LABEL } from './labels.js'

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

// Verdict precedence: an explicit `override` wins over everything when it's a non-empty
// string; else the github precedence applies — failed label => fail (even if
// CLOSED/OPEN); else CLOSED state OR pending-merge label => pass; else unknown.
//
// BOTH NON-GITHUB SOURCES SUPPLY THAT OVERRIDE: folder mode's terminal task directory
// (#565) and, since #131, the label the Jira board carries. One mapping produces it for
// the two of them (`verdictFromOutcome`, capture-issue-event.js), so `labels` and `state`
// are the GITHUB arm's inputs and nothing else — the loop passes neither under the other
// two, and the override would win over them if it did.
function computeVerdict(labels, state, override) {
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const ls = Array.isArray(labels) ? labels : []
  if (ls.includes(FAILED_LABEL)) return 'fail'
  if (state === 'CLOSED' || ls.includes(PENDING_MERGE_LABEL)) return 'pass'
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
    // The verdict a source that does its own bookkeeping read back (done|failed): the
    // terminal task directory under folder (#565), the ticket's own label under jira
    // (#131). When a non-empty string it overrides the label/state precedence above.
    verdictOverride = null,
    // #131: the Jira key this event is about (`FOO-123`). Optional, and the field is
    // OMITTED rather than null-padded when there is none — see below.
    taskKey = null,
  } = input || {}

  // Trimmed, and only a non-empty string counts — the same posture `computeVerdict` takes
  // to its own override. This is a RECORDER and not a validator: lib/jira-key.js decides
  // what a usable key is, and it deliberately passes an unrecognised one through, so a key
  // this function has never seen is still the ticket the run worked.
  const key = typeof taskKey === 'string' && taskKey.trim() !== '' ? taskKey.trim() : null

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
    // #131: the ticket key, beside the number DERIVED from it (`FOO-123` → 123), and
    // SPREAD IN rather than assigned so the key is absent from the object when there is
    // none. `issue_number` stays the numeric field every consumer already reads — see
    // lib/jira-key.js for why a number at all — and this is the spelling a human
    // recognises on the board. Absent and not `null`, because the two say different
    // things: a github or folder event has no such concept, and `Object.keys` on it is
    // byte-for-byte the set it has always been rather than a shape that grew a hole.
    ...(key === null ? {} : { task_key: key }),
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
    verdict: computeVerdict(labels, state, verdictOverride),
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
