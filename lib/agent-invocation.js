// Resolve which coding-agent CLI the bash loop should invoke and with what
// argv, then emit that as eval-able shell (#554). This is the single bridge
// between the JS agent registry and templates/ralph.sh: the bash loop runs
// `eval "$(node lib/agent-invocation.js)"` to learn the CLI name + argument
// array without duplicating any agent knowledge in bash.
//
// The Claude argv is byte-for-byte the same flags the loop has always used, so
// the Claude pipeline is unchanged. The Codex argv runs `codex exec` in
// non-interactive JSONL mode (`--json`), reading the prompt from stdin (`-`),
// with a workspace-write sandbox that keeps network access (so it can push /
// call gh) and approvals disabled for full autonomy — the loop is unattended.
//
// It also carries the agent's required ENVIRONMENT across the same bridge, as
// `export` lines the loop evals — currently Claude's background-wait ceiling,
// which decides whether an orphaned subagent kills the invocation (see the
// registry for why). These are DEFAULTS: a variable already set in the loop's
// env is left alone, so ralph.config.sh keeps the last word.
//
// Pure and injectable: `buildAgentInvocation(env)` takes an env object and
// returns `{agent, cli, args, streamFilter, agentEnv, warning}`;
// `emitShellAssignments(inv)` renders bash. When run as a script it reads
// process.env, prints the assignments to stdout and the warning — if there is
// one — to STDERR.
//
// #118: that split is load-bearing. STDOUT IS A SHELL PROGRAM, so the one thing
// this module may never do is put a sentence in it; but a loop that fell back to
// claude because RALPH_AGENT was mistyped used to say so nowhere at all, and the
// user found out from the next morning's telemetry. So the fallback travels out
// of the pure function as DATA (`warning`, already exactly one line — the
// registry sanitises its own echo, #108) and only the script block below turns it
// into bytes, on the other stream. `emitShellAssignments` names the fields it
// renders, so the new one cannot leak into the eval'd program.

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { resolveAgent, agentSpec } from './agent-registry.js'

export function buildAgentInvocation(env = {}) {
  const { agent, warning } = resolveAgent(env)
  const spec = agentSpec(agent)

  // The STATIC argv base comes from the registry spec (single source of truth).
  // For claude that's byte-for-byte the flags the loop has always used, so the
  // Claude pipeline is unchanged.
  const args = [...spec.argv]

  if (agent === 'codex') {
    // Compose the env-dependent parts on top of the static base.
    const model = (env.RALPH_CODEX_MODEL || '').trim()
    if (model) {
      args.push('-m', model)
    }
    // Prompt is piped on stdin; `-` makes Codex read it from there.
    args.push('-')
  }

  return {
    agent,
    cli: spec.cli,
    args,
    streamFilter: spec.streamFilter,
    agentEnv: resolveAgentEnv(spec.env, env),
    // #118: carried, never printed. Every other field here describes the
    // invocation; this one describes how the env got there, which is why it is
    // the only one `emitShellAssignments` ignores.
    warning,
  }
}

// The spec's env is a set of DEFAULTS. Any variable the loop already has — from
// ralph.config.sh, ~/.config/ralph/.env, or the ambient shell — is left alone and
// omitted from the result, so emitting these can never override an operator's
// deliberate choice. A present-but-blank value counts as unset: an empty string
// reaching a CLI expecting a number is not a choice anyone made on purpose.
function resolveAgentEnv(specEnv, env) {
  const resolved = {}
  for (const [key, value] of Object.entries(specEnv ?? {})) {
    const existing = env?.[key]
    if (existing == null || String(existing).trim() === '') resolved[key] = value
  }
  return resolved
}

// POSIX single-quote escaping: wrap in single quotes, and turn any embedded
// single quote into '\'' so the result is always safe to eval in bash.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

export function emitShellAssignments({ agent, cli, args, streamFilter, agentEnv }) {
  const quotedArgs = args.map(shQuote).join(' ')
  // The exports come FIRST, and that ordering is load-bearing: the stream filter
  // is a multi-line jq program, so its assignment must remain the LAST thing in
  // the block. Anything emitted after it would be swallowed into the filter's
  // quoted value instead of being eval'd as its own statement.
  const exports = Object.entries(agentEnv ?? {}).map(
    ([key, value]) => `export ${key}=${shQuote(value)}`,
  )
  return [
    ...exports,
    `RALPH_RESOLVED_AGENT=${shQuote(agent)}`,
    `RALPH_AGENT_CLI=${shQuote(cli)}`,
    `RALPH_AGENT_ARGS=(${quotedArgs})`,
    `RALPH_AGENT_STREAM_FILTER=${shQuote(streamFilter ?? '')}`,
  ].join('\n')
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  const inv = buildAgentInvocation(process.env)
  // #118: the typo, on STDERR, before the program — and it is the same sentence
  // `ralph doctor`, `ralph init` and `ralph start` print, with the same prefix,
  // because it is the same fallback. Written FIRST so a reader watching one
  // merged terminal sees the diagnostic above the thing it is about, and written
  // through `process.stderr` rather than `console.error` so nothing formats it.
  //
  // One line, always: the registry capped and sanitised the echo at the source
  // (#108), so there is nothing here that a hostile RALPH_AGENT could turn into
  // two lines — which matters more on this stream than on any other, since a
  // caller that has redirected it is reading it as a resolution failure.
  //
  // NOT on stdout, for the reason the header gives: templates/ralph.sh evals that
  // stream. What that function does with THIS one — and why it must keep doing it —
  // is written above `resolve_agent_invocation()` in templates/ralph.sh.
  if (inv.warning) process.stderr.write(`⚠️  ${inv.warning}\n`)
  process.stdout.write(emitShellAssignments(inv) + '\n')
}
