import { describe, it, expect } from 'vitest'
import { buildAgentInvocation, emitShellAssignments } from './agent-invocation.js'

describe('buildAgentInvocation — resolve the agent CLI + argv (#554)', () => {
  it('defaults to claude with the stream-json argv unchanged', () => {
    const inv = buildAgentInvocation({})
    expect(inv.agent).toBe('claude')
    expect(inv.cli).toBe('claude')
    expect(inv.args).toEqual([
      '-p',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ])
  })

  it('builds the codex exec argv when RALPH_AGENT=codex', () => {
    const inv = buildAgentInvocation({ RALPH_AGENT: 'codex' })
    expect(inv.agent).toBe('codex')
    expect(inv.cli).toBe('codex')
    // Non-interactive JSONL, workspace-write sandbox with network, no approvals,
    // prompt read from stdin (`-`).
    expect(inv.args).toContain('exec')
    expect(inv.args).toContain('--json')
    expect(inv.args).toContain('--sandbox')
    expect(inv.args).toContain('workspace-write')
    expect(inv.args).toContain('-')
    // Autonomy: approvals off, network on.
    expect(inv.args.join(' ')).toContain('approval_policy="never"')
    expect(inv.args.join(' ')).toContain('sandbox_workspace_write.network_access=true')
  })

  it('omits -m when RALPH_CODEX_MODEL is unset/blank', () => {
    expect(buildAgentInvocation({ RALPH_AGENT: 'codex' }).args).not.toContain('-m')
    expect(
      buildAgentInvocation({ RALPH_AGENT: 'codex', RALPH_CODEX_MODEL: '   ' }).args,
    ).not.toContain('-m')
  })

  it('passes -m <model> when RALPH_CODEX_MODEL is set', () => {
    const inv = buildAgentInvocation({ RALPH_AGENT: 'codex', RALPH_CODEX_MODEL: 'gpt-5-codex' })
    const i = inv.args.indexOf('-m')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(inv.args[i + 1]).toBe('gpt-5-codex')
  })

  it('falls back to claude on an unrecognized RALPH_AGENT', () => {
    const inv = buildAgentInvocation({ RALPH_AGENT: 'codx' })
    expect(inv.agent).toBe('claude')
    expect(inv.cli).toBe('claude')
  })
})

describe('emitShellAssignments — eval-able bash', () => {
  it('emits RALPH_RESOLVED_AGENT, RALPH_AGENT_CLI and a quoted arg array', () => {
    const sh = emitShellAssignments(buildAgentInvocation({ RALPH_AGENT: 'codex' }))
    expect(sh).toContain("RALPH_RESOLVED_AGENT='codex'")
    expect(sh).toContain("RALPH_AGENT_CLI='codex'")
    expect(sh).toMatch(/RALPH_AGENT_ARGS=\(/)
    // Every element is single-quoted so shell metacharacters are inert.
    expect(sh).toContain("'--json'")
    expect(sh).toContain(`'approval_policy="never"'`)
  })

  it('safely single-quotes a value containing a single quote', () => {
    const sh = emitShellAssignments({
      agent: 'codex',
      cli: 'codex',
      args: ["it's"],
    })
    // Standard POSIX single-quote escaping: ' -> '\''
    expect(sh).toContain(`'it'\\''s'`)
  })
})
