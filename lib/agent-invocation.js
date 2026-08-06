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
// Pure and injectable: `buildAgentInvocation(env)` takes an env object and
// returns `{agent, cli, args, streamFilter}`; `emitShellAssignments(inv)`
// renders bash. When run as a script it reads process.env and prints the
// assignments to stdout.

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { resolveAgent, agentSpec } from './agent-registry.js'

export function buildAgentInvocation(env = {}) {
  const { agent } = resolveAgent(env)
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

  return { agent, cli: spec.cli, args, streamFilter: spec.streamFilter }
}

// POSIX single-quote escaping: wrap in single quotes, and turn any embedded
// single quote into '\'' so the result is always safe to eval in bash.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

export function emitShellAssignments({ agent, cli, args, streamFilter }) {
  const quotedArgs = args.map(shQuote).join(' ')
  return [
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
  process.stdout.write(emitShellAssignments(inv) + '\n')
}
