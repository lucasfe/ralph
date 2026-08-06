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
//     template filename, dependency name, auth-probe kind).

const DEFAULT_AGENT = 'claude'
const VALID_AGENTS = ['claude', 'codex']

const SPECS = {
  claude: {
    cli: 'claude',
    orchestratorTemplate: 'prompt-team.md',
    dependency: 'claude',
    authProbe: 'credentials-file',
  },
  codex: {
    cli: 'codex',
    orchestratorTemplate: 'prompt-team-codex.md',
    dependency: 'codex',
    authProbe: 'login-status',
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
  return { ...spec }
}
