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
// returns `{agent, cli, args}`; `emitShellAssignments(inv)` renders bash. When
// run as a script it reads process.env and prints the assignments to stdout.

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { resolveAgent, agentSpec } from './agent-registry.js'

// Claude's stream-json flags — unchanged from the original ralph.sh pipeline.
const CLAUDE_ARGS = [
  '-p',
  '--dangerously-skip-permissions',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
]

export function buildAgentInvocation(env = {}) {
  const { agent } = resolveAgent(env)
  const spec = agentSpec(agent)

  if (agent === 'codex') {
    const model = (env.RALPH_CODEX_MODEL || '').trim()
    const args = [
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      // Full autonomy for an unattended loop: never prompt for approval, and
      // keep network access inside the workspace-write sandbox so the agent can
      // run git/gh/npm just like Claude does.
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_workspace_write.network_access=true',
    ]
    if (model) {
      args.push('-m', model)
    }
    // Prompt is piped on stdin; `-` makes Codex read it from there.
    args.push('-')
    return { agent, cli: spec.cli, args }
  }

  // Default / claude.
  return { agent, cli: spec.cli, args: [...CLAUDE_ARGS] }
}

// POSIX single-quote escaping: wrap in single quotes, and turn any embedded
// single quote into '\'' so the result is always safe to eval in bash.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

export function emitShellAssignments({ agent, cli, args }) {
  const quotedArgs = args.map(shQuote).join(' ')
  return [
    `RALPH_RESOLVED_AGENT=${shQuote(agent)}`,
    `RALPH_AGENT_CLI=${shQuote(cli)}`,
    `RALPH_AGENT_ARGS=(${quotedArgs})`,
  ].join('\n')
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  const inv = buildAgentInvocation(process.env)
  process.stdout.write(emitShellAssignments(inv) + '\n')
}
