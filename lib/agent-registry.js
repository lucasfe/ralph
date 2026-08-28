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
//     template, jq output-stream filter program, the environment the loop must
//     set before invoking that CLI, and the one-shot DIGEST invocation spec).

// The ONE import this file is allowed, and it is allowed because lib/one-line.js imports
// nothing itself (#108). That matters more here than almost anywhere: this module is on the
// import graph of every command, including `ralph doctor`, whose graph is pinned to four bare
// specifiers by a test that walks it. A dependency added here is a dependency added to all of
// them, so the next one needs the same argument.
import { oneLineEcho } from './one-line.js'

const DEFAULT_AGENT = 'claude'
export const VALID_AGENTS = ['claude', 'codex']

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

// The jq output-stream filter each agent's pretty-printer uses (lifted out of
// templates/ralph.sh). Both are cosmetic; the authoritative metrics parse
// happens in Node (capture-issue-event.js via parseAgentStream), never here.
// Claude: render each assistant content block — `text` stays as flush-left
// prose; `tool_use` renders as an indented single-line `  ⏺ ToolName(hint)`,
// where hint is the first of command/file_path/path/pattern/description,
// whitespace-collapsed and truncated to ~60 chars (no parens when absent). The
// old contentless `↳ tool_result` flood (#15) is dropped entirely. The gsub
// regexes use the POSIX `[[:space:]]` class (not `\s`) so no backslash escaping
// is needed: jq 1.7+ rejects `\s` inside a string literal, and a JS template
// literal would otherwise collapse `\\s` to `\s` and break compilation.
// The `result` line reconciles the event's TWO outcome fields, which disagree on
// a hard failure — the real auth-failure payload is
// {"subtype":"success","is_error":true,"num_turns":1} (#39). `is_error` is
// authoritative and `.subtype` only NAMES the outcome, so a flagged result never
// renders as a success: it keeps its own subtype when that already names the
// error, and falls back to `error` when the subtype contradicts the flag or names
// nothing at all (the unflagged fallback stays the cosmetic `ok`). `$named` is
// forced to a single-line string first — `jq -r` prints raw, so a subtype
// carrying a newline would otherwise split one event across two log lines and
// leave a bare `==> result: success` as the first of them.
const CLAUDE_STREAM_FILTER = `fromjson? // empty
  | if .type == "assistant" then
      (.message.content[]?
        | if .type == "text" then (.text // empty)
          elif .type == "tool_use" then
            (((.input // {}) | .command // .file_path // .path // .pattern // .description // "")
              | tostring | gsub("^[[:space:]]+|[[:space:]]+$"; "") | gsub("[[:space:]]+"; " ")) as $hint
            | if ($hint | length) == 0 then "  ⏺ " + .name
              else "  ⏺ " + .name + "(" + (if ($hint | length) > 60 then (($hint | .[0:59]) + "…") else $hint end) + ")"
              end
          else empty end)
    elif .type == "result" then
      (((.subtype // "") | tostring | gsub("[[:space:]]+"; " ")) as $named
        | (.is_error == true) as $failed
        | (if $failed then "error" else "ok" end) as $fallback
        | (if $named == "" or ($failed and $named == "success") then $fallback else $named end) as $outcome
        | "==> result: " + $outcome)
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

// The environment each agent CLI is invoked with — DEFAULTS, not overrides: a
// value already set in the loop's env wins (see agent-invocation.js), so an
// operator can retune from ralph.config.sh without editing the registry.
//
// Claude runs subagents as BACKGROUND tasks. At the end of a `-p` turn it waits
// for any still-running one only up to this ceiling and then TERMINATES the
// session, taking the orphan's report, the commit and the PR with it — the
// invocation is recorded as a success that changed zero files, and the issue is
// left open holding `claude-working`, which excludes it from the queue. The
// 10-minute default did exactly that to three issues in one overnight run; 30
// minutes gives a slow specialist room to land.
//
// Deliberately NOT unbounded: the CLI treats 0 as "wait forever", and one wedged
// subagent would then stall the entire unattended queue rather than costing a
// single issue. The real fix is the orchestrator not finishing with a dispatch in
// flight ("Dispatch discipline" in templates/prompt-team.md) — this is only the
// backstop for when it does.
const CLAUDE_ENV = { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '1800000' }
// Codex owns its own turn end and exposes no equivalent knob.
const CODEX_ENV = {}

// The DIGEST invocation (#61) — ONE turn of narration on a cheap model, with no
// tools. Kept here for the same reason the loop's argv is: it is the only file
// allowed to know how an agent CLI spells its flags, so lib/digest.js dispatches on
// these fields (`output` especially) rather than on the agent's name.
//
// Five things the engine cannot know, per agent:
//   argv       — the static flags for a one-shot, no-tool, text completion. No
//                model here: the default below is overridable, and baking it in
//                would give the builder two places to disagree about it.
//   modelFlag  — how THIS cli names its model flag (`--model` vs `-m`).
//   model      — the CHEAP default. A digest is an accessory that may run every few
//                minutes all night, so the model is chosen for price, not for depth.
//   stdinArgv  — trailing argv that makes the cli read the prompt from stdin. The
//                prompt carries whole files, so it is never passed as an argument.
//   output     — how to get prose out of stdout (see extractNarrative).
//
// CLAUDE takes `--tools ""`, which its own help documents as disabling ALL tools —
// that is what makes "the model cannot act" structural rather than a promise — and
// prints plain prose under `--output-format text`, so there is nothing to parse.
// `haiku` (the alias, not a pinned id) is the cheap default because the alias keeps
// resolving across CLI releases.
//
// CODEX has no no-tool flag, so the bound is its sandbox: `--sandbox read-only`
// with approvals off, which cannot write and cannot stop to ask. Its stdout is
// JSONL, so the prose is extracted from the last agent message.
// `--skip-git-repo-check` is included so a digest never dies over a cwd that is not
// a repo — a read-only accessory has no business caring. `gpt-5-mini` is the cheap
// default; a wrong id here is tolerable, since a failing digest is silent and
// RALPH_DIGEST_MODEL overrides it.
const CLAUDE_DIGEST = {
  argv: ['-p', '--tools', '', '--output-format', 'text'],
  modelFlag: '--model',
  model: 'haiku',
  stdinArgv: [],
  output: 'text',
}
const CODEX_DIGEST = {
  argv: [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="never"',
    '--skip-git-repo-check',
  ],
  modelFlag: '-m',
  model: 'gpt-5-mini',
  stdinArgv: ['-'],
  output: 'jsonl-agent-message',
}

const SPECS = {
  claude: {
    cli: 'claude',
    orchestratorTemplate: 'prompt-team.md',
    dependency: 'claude',
    authProbe: 'credentials-file',
    argv: CLAUDE_ARGV,
    streamFilter: CLAUDE_STREAM_FILTER,
    env: CLAUDE_ENV,
    digest: CLAUDE_DIGEST,
  },
  codex: {
    cli: 'codex',
    orchestratorTemplate: 'prompt-team-codex.md',
    dependency: 'codex',
    authProbe: 'login-status',
    argv: CODEX_ARGV,
    streamFilter: CODEX_STREAM_FILTER,
    env: CODEX_ENV,
    digest: CODEX_DIGEST,
  },
}

// Resolve RALPH_AGENT into { agent, fellBack, warning }. Unset/empty/whitespace
// => claude (no fallback). A recognized value (case-insensitive, trimmed) =>
// that agent. Anything else => claude with fellBack:true and a warning that
// echoes the value back UNTRIMMED and IN ITS ORIGINAL CASE so the typo is
// visible. Since #108 that echo is also SANITISED, which is the one thing it is
// not a verbatim copy of the input: every control character becomes U+FFFD and
// the echo is capped at 200 code points, so the warning is exactly ONE line
// whatever was set. Padding, case and spelling are untouched.
//
// #108: the echo is SANITISED, not normalised, and it is done HERE rather than at
// the two call sites that print it (`ralph doctor`, `ralph init`). The defect was
// that a RALPH_AGENT containing a newline made ONE write emit TWO lines, the
// second composed by nobody — under `ralph doctor` it reads as a row of the
// identity box (#75), which is exactly the kind of line a pasted bug report is
// trusted on. Fixing it at the source means every present and future caller
// inherits the guarantee instead of each one remembering it, and it is the same
// argument lib/banner-mode.js's warning already answers to.
//
// SANITISED, NOT NORMALISED, because the sentence's job is to show the user what
// they typed: `oneLineEcho` replaces only what can end a line or drive a terminal,
// one code point for one, and leaves the padding and the case alone. `oneLine`
// would trim and collapse, and a user who typed three trailing spaces would then
// be shown a value they did not set.
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
    warning: `RALPH_AGENT='${oneLineEcho(raw)}' unrecognized; falling back to '${DEFAULT_AGENT}'. Valid: ${VALID_AGENTS.join(', ')}.`,
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
  // Copy the argv array and the env bag too so a caller mutating either can't
  // corrupt the registry for every later caller in the same process — and the
  // nested digest block with ITS two arrays (#61), which a top-level spread would
  // otherwise hand out by reference.
  return {
    ...spec,
    argv: [...spec.argv],
    env: { ...spec.env },
    digest: {
      ...spec.digest,
      argv: [...spec.digest.argv],
      stdinArgv: [...spec.digest.stdinArgv],
    },
  }
}
