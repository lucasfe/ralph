// PURE agent registry — NO I/O. This is the SINGLE place in the codebase that
// holds agent-specific knowledge (issue #554). Every downstream consumer (the
// bash loop entry point, prompt builder, dependency check, and auth probe)
// reads the agent name and its spec from here, so adding a third agent is a
// one-file change.
//
// Two responsibilities:
//   resolveAgent(env) — turn the RALPH_AGENT env var into the RESOLVED agent
//     name, whether a fallback happened, and any warning text. An unrecognized
//     value is NOT fatal: it warns and falls back to 'claude' so an unattended
//     overnight run is never aborted by a typo, and the resolved (fallen-back)
//     agent is what telemetry records so the typo stays auditable.
//   agentSpec(agent) — the per-agent spec object (CLI name, orchestrator
//     template filename, dependency name, auth-probe kind, static CLI argv
//     template, and jq output-stream filter program).

const DEFAULT_AGENT = 'claude'
const VALID_AGENTS = ['claude', 'codex']

// The STATIC argv template each agent CLI is invoked with. This is the base
// only — the env-dependent Codex `-m <model>` flag and the `-` stdin marker are
// composed on top of this in agent-invocation.js. For claude these six flags
// are the exact stream-json flags the loop has always used, so the Claude
// pipeline is byte-for-byte unchanged.
const CLAUDE_ARGV = [
  '-p',
  '--dangerously-skip-permissions',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
]
const CODEX_ARGV = [
  'exec',
  '--json',
  '--sandbox',
  'workspace-write',
  // Full autonomy for an unattended loop: never prompt for approval, and keep
  // network access inside the workspace-write sandbox so the agent can run
  // git/gh/npm just like Claude does.
  '-c',
  'approval_policy="never"',
  '-c',
  'sandbox_workspace_write.network_access=true',
]

// The jq output-stream filter each agent's pretty-printer uses (moved verbatim
// out of templates/ralph.sh — byte-for-byte the same programs, so the rendered
// log output is unchanged). Both are cosmetic; the authoritative metrics parse
// happens in Node (capture-issue-event.js via parseAgentStream), never here.
const CLAUDE_STREAM_FILTER = `fromjson? // empty
  | if .type == "assistant" then
      (.message.content[]? | select(.type=="text").text // empty)
    elif .type == "user" then
      (.message.content[]? | select(.type=="tool_result") | "  ↳ tool_result")
    elif .type == "result" then
      "==> result: " + (.subtype // "ok")
    else empty end`
const CODEX_STREAM_FILTER = `fromjson? // empty
  | if .type == "item.completed" then
      (.item
        | if (.type // "") == "agent_message" or (.type // "") == "assistant_message" then (.text // .message // empty)
          elif (.type // "") == "command_execution" then ("  $ " + (.command // ""))
          elif (.type // "") == "error" then ("  ✗ " + (.message // "error"))
          else empty end)
    elif .type == "turn.completed" then "==> result: success"
    elif .type == "turn.failed" then "==> result: error"
    elif .type == "error" then "==> result: error"
    else empty end`

const SPECS = {
  claude: {
    cli: 'claude',
    orchestratorTemplate: 'prompt-team.md',
    dependency: 'claude',
    authProbe: 'credentials-file',
    argv: CLAUDE_ARGV,
    streamFilter: CLAUDE_STREAM_FILTER,
  },
  codex: {
    cli: 'codex',
    orchestratorTemplate: 'prompt-team-codex.md',
    dependency: 'codex',
    authProbe: 'login-status',
    argv: CODEX_ARGV,
    streamFilter: CODEX_STREAM_FILTER,
  },
}

// Resolve RALPH_AGENT into { agent, fellBack, warning }. Unset/empty/whitespace
// => claude (no fallback). A recognized value (case-insensitive, trimmed) =>
// that agent. Anything else => claude with fellBack:true and a warning that
// echoes the ORIGINAL (untrimmed, original-case) value so the typo is visible.
export function resolveAgent(env = {}) {
  const raw = env?.RALPH_AGENT
  if (raw == null || String(raw).trim() === '') {
    return { agent: DEFAULT_AGENT, fellBack: false, warning: null }
  }
  const normalized = String(raw).trim().toLowerCase()
  if (VALID_AGENTS.includes(normalized)) {
    return { agent: normalized, fellBack: false, warning: null }
  }
  return {
    agent: DEFAULT_AGENT,
    fellBack: true,
    warning: `RALPH_AGENT='${raw}' unrecognized; falling back to '${DEFAULT_AGENT}'. Valid: ${VALID_AGENTS.join(', ')}.`,
  }
}

// Return the spec for a resolved agent name. Throws on an unknown agent — the
// caller is expected to pass a value that already came through resolveAgent.
export function agentSpec(agent) {
  const spec = SPECS[agent]
  if (!spec) {
    throw new Error(
      `agentSpec: unknown agent '${agent}'. Valid: ${VALID_AGENTS.join(', ')}.`,
    )
  }
  // Copy the argv array too so a caller mutating it can't corrupt the registry.
  return { ...spec, argv: [...spec.argv] }
}
