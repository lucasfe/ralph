import { describe, it, expect } from 'vitest'
import { buildAgentInvocation, emitShellAssignments } from './agent-invocation.js'
import { agentSpec } from './agent-registry.js'

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

describe('buildAgentInvocation — args derive from the registry spec.argv (#555)', () => {
  it('claude argv is byte-for-byte the exact 6-flag stream-json array', () => {
    // The Claude pipeline MUST stay unchanged: prove the argv equals the exact
    // static template (sourced from spec.argv, not a local const).
    expect(buildAgentInvocation({}).args).toEqual([
      '-p',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ])
    expect(buildAgentInvocation({}).args).toEqual(agentSpec('claude').argv)
  })

  it('codex argv starts with the spec.argv static base, then composes model/stdin', () => {
    const base = agentSpec('codex').argv
    const inv = buildAgentInvocation({ RALPH_AGENT: 'codex' })
    // The static base is a prefix of the composed argv.
    expect(inv.args.slice(0, base.length)).toEqual(base)
  })
})

// ---------------------------------------------------------------------------
// #562 — the config-validation pass runs through the CONFIGURED agent, not
// unconditionally Claude. In ralph.sh the validation call reuses
// run_agent_stream, which invokes $RALPH_AGENT_CLI with $RALPH_AGENT_ARGS —
// both resolved here. So agent selection for the validation pass IS
// buildAgentInvocation(env). These tests pin that contract for both agents.
// ---------------------------------------------------------------------------
describe('validation-pass agent selection — runs through the configured agent (#562)', () => {
  it('selects the claude CLI + argv for the validation pass by default', () => {
    const inv = buildAgentInvocation({})
    expect(inv.cli).toBe('claude')
    expect(inv.args).toEqual(agentSpec('claude').argv)
  })

  it('selects the codex CLI for the validation pass when RALPH_AGENT=codex', () => {
    const inv = buildAgentInvocation({ RALPH_AGENT: 'codex' })
    expect(inv.cli).toBe('codex')
    // Codex reads the validation prompt from stdin, exactly like the loop prompt.
    expect(inv.args).toContain('-')
    expect(inv.args.slice(0, agentSpec('codex').argv.length)).toEqual(agentSpec('codex').argv)
  })

  it('the emitted RALPH_AGENT_CLI (used by the validation stream) tracks the agent', () => {
    expect(emitShellAssignments(buildAgentInvocation({}))).toContain("RALPH_AGENT_CLI='claude'")
    expect(emitShellAssignments(buildAgentInvocation({ RALPH_AGENT: 'codex' }))).toContain(
      "RALPH_AGENT_CLI='codex'",
    )
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

  it('emits RALPH_AGENT_STREAM_FILTER single-quoted from the spec (AC#6)', () => {
    const sh = emitShellAssignments(buildAgentInvocation({ RALPH_AGENT: 'codex' }))
    expect(sh).toContain('RALPH_AGENT_STREAM_FILTER=')
    // The value is the codex jq program, single-quoted.
    expect(sh).toContain(`RALPH_AGENT_STREAM_FILTER='${agentSpec('codex').streamFilter}'`)
  })

  it('emits the claude stream filter unchanged for the default agent (AC#6)', () => {
    const sh = emitShellAssignments(buildAgentInvocation({}))
    expect(sh).toContain(`RALPH_AGENT_STREAM_FILTER='${agentSpec('claude').streamFilter}'`)
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

// ---------------------------------------------------------------------------
// QA augmentation (#555)
// ---------------------------------------------------------------------------

// Reimplement the POSIX single-quote rule independently so the assertions below
// don't just re-derive the production shQuote — they encode the RULE the shell
// actually obeys: wrap in single quotes, and every embedded ' becomes '\''.
function posixSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

// Extract the RALPH_AGENT_STREAM_FILTER=... value line from the emitted block.
// The filter is multi-line, so the value runs to the end of the block (it is
// the LAST assignment emitted). Everything after the `=` is the quoted value.
function extractStreamFilterValue(sh) {
  const marker = '\nRALPH_AGENT_STREAM_FILTER='
  const idx = sh.indexOf(marker)
  if (idx === -1) throw new Error('no RALPH_AGENT_STREAM_FILTER assignment found')
  return sh.slice(idx + marker.length)
}

describe('QA: emitShellAssignments — streamFilter is shell-inert (AC#6)', () => {
  it('emits the FOUR eval-able assignment lines in the documented order', () => {
    const sh = emitShellAssignments(buildAgentInvocation({ RALPH_AGENT: 'codex' }))
    const lines = sh.split('\n')
    // Anchored on the first assignment rather than on index 0: any agent env
    // exports are emitted AHEAD of the block (codex has none, so here it is 0).
    const base = lines.findIndex((l) => l.startsWith('RALPH_RESOLVED_AGENT='))
    expect(base).toBe(0)
    expect(lines[base]).toMatch(/^RALPH_RESOLVED_AGENT=/)
    expect(lines[base + 1]).toMatch(/^RALPH_AGENT_CLI=/)
    expect(lines[base + 2]).toMatch(/^RALPH_AGENT_ARGS=\(/)
    // The stream filter is multi-line, so it is the LAST assignment; its own
    // first line begins the assignment, remaining lines are the filter body.
    const filterStart = lines.findIndex((l) => l.startsWith('RALPH_AGENT_STREAM_FILTER='))
    expect(filterStart).toBe(base + 3)
  })

  it('keeps the same four-assignment order for claude, after its env exports', () => {
    const sh = emitShellAssignments(buildAgentInvocation({}))
    const lines = sh.split('\n')
    const base = lines.findIndex((l) => l.startsWith('RALPH_RESOLVED_AGENT='))
    // Claude DOES carry env, so the block no longer starts at line 0 — and every
    // line before it must be an export, never a stray blank or comment.
    expect(base).toBeGreaterThan(0)
    for (const line of lines.slice(0, base)) expect(line).toMatch(/^export [A-Z0-9_]+='/)
    expect(lines[base + 1]).toMatch(/^RALPH_AGENT_CLI=/)
    expect(lines[base + 2]).toMatch(/^RALPH_AGENT_ARGS=\(/)
    expect(lines.findIndex((l) => l.startsWith('RALPH_AGENT_STREAM_FILTER='))).toBe(base + 3)
  })

  it('wraps the multi-line jq filter in a SINGLE pair of single quotes', () => {
    // Everything inside single quotes is literal to bash: newlines, ", |, //,
    // $ and the ↳/✗ glyphs are all inert. Prove the value opens and closes with
    // a single quote and contains no unescaped interior single quote.
    for (const agent of ['claude', 'codex']) {
      const sh = emitShellAssignments(buildAgentInvocation({ RALPH_AGENT: agent }))
      const value = extractStreamFilterValue(sh)
      expect(value.startsWith("'")).toBe(true)
      expect(value.endsWith("'")).toBe(true)
      // Neither production filter contains a single quote, so after stripping
      // the outer quotes there must be zero single quotes left in the body.
      const body = value.slice(1, -1)
      expect(body).not.toContain("'")
    }
  })

  it('preserves the codex filter byte-for-byte (special chars $ " | // ✗ newline)', () => {
    const filter = agentSpec('codex').streamFilter
    // Precondition: this filter really does carry the hostile characters.
    expect(filter).toContain('\n')
    expect(filter).toContain('"')
    expect(filter).toContain('$') // e.g. "  $ " command prefix
    expect(filter).toContain('✗')
    expect(filter).toContain('//')

    const sh = emitShellAssignments(buildAgentInvocation({ RALPH_AGENT: 'codex' }))
    const value = extractStreamFilterValue(sh)
    // The emitted value equals the POSIX-quoted original exactly. Since the
    // filter has no single quote, this is the original wrapped in '...'; the
    // substring between the outer quotes is byte-for-byte the filter.
    expect(value).toBe(posixSingleQuote(filter))
    expect(value.slice(1, -1)).toBe(filter)
  })

  it('preserves the claude filter byte-for-byte (special chars ⏺ " | // newline)', () => {
    const filter = agentSpec('claude').streamFilter
    expect(filter).toContain('\n')
    expect(filter).toContain('⏺')
    const sh = emitShellAssignments(buildAgentInvocation({}))
    const value = extractStreamFilterValue(sh)
    expect(value).toBe(posixSingleQuote(filter))
    expect(value.slice(1, -1)).toBe(filter)
  })

  it('POSIX-escapes a single quote inside a filter (\' -> \'\\\'\') without breaking the wrap', () => {
    // The production filters have no single quote, but the emitter MUST handle
    // one correctly if a future filter contains it — otherwise the eval breaks.
    const hostile = `fromjson? // empty | "it's a ↳ $x" | "==> result:"`
    const sh = emitShellAssignments({
      agent: 'codex',
      cli: 'codex',
      args: [],
      streamFilter: hostile,
    })
    const value = extractStreamFilterValue(sh)
    // The whole value is the POSIX-quoted hostile string...
    expect(value).toBe(posixSingleQuote(hostile))
    // ...and it literally contains the '\'' escape sequence for the apostrophe.
    expect(value).toContain(`'\\''`)
  })

  it('emits RALPH_AGENT_STREAM_FILTER even when streamFilter is missing (empty single-quoted)', () => {
    const sh = emitShellAssignments({ agent: 'claude', cli: 'claude', args: [] })
    expect(sh).toContain("RALPH_AGENT_STREAM_FILTER=''")
  })
})

describe('QA: buildAgentInvocation — spec/invocation round-trip consistency (#555)', () => {
  it('claude streamFilter round-trips through buildAgentInvocation', () => {
    expect(buildAgentInvocation({}).streamFilter).toBe(agentSpec('claude').streamFilter)
  })

  it('codex streamFilter round-trips through buildAgentInvocation', () => {
    expect(buildAgentInvocation({ RALPH_AGENT: 'codex' }).streamFilter).toBe(
      agentSpec('codex').streamFilter,
    )
  })

  it('a fallen-back agent uses the CLAUDE streamFilter (resolved==fallback)', () => {
    expect(buildAgentInvocation({ RALPH_AGENT: 'gpt-9000' }).streamFilter).toBe(
      agentSpec('claude').streamFilter,
    )
  })

  it('claude args equal spec.argv byte-for-byte (no env-dependent tail)', () => {
    expect(buildAgentInvocation({}).args).toEqual(agentSpec('claude').argv)
  })

  it('codex args START WITH spec.argv, then append the env-dependent tail', () => {
    const base = agentSpec('codex').argv
    const inv = buildAgentInvocation({ RALPH_AGENT: 'codex', RALPH_CODEX_MODEL: 'gpt-5-codex' })
    expect(inv.args.slice(0, base.length)).toEqual(base)
    // Tail is exactly the composed model pair plus the stdin marker.
    expect(inv.args.slice(base.length)).toEqual(['-m', 'gpt-5-codex', '-'])
  })
})

describe('QA: buildAgentInvocation — codex model composition edge cases (#555)', () => {
  it('trims surrounding whitespace from RALPH_CODEX_MODEL before passing it', () => {
    const inv = buildAgentInvocation({
      RALPH_AGENT: 'codex',
      RALPH_CODEX_MODEL: '  gpt-5-codex  ',
    })
    const i = inv.args.indexOf('-m')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(inv.args[i + 1]).toBe('gpt-5-codex')
  })

  it('places the -m <model> pair BEFORE the trailing "-" stdin marker', () => {
    const inv = buildAgentInvocation({
      RALPH_AGENT: 'codex',
      RALPH_CODEX_MODEL: 'gpt-5-codex',
    })
    const mIdx = inv.args.indexOf('-m')
    const stdinIdx = inv.args.lastIndexOf('-')
    expect(mIdx).toBeGreaterThanOrEqual(0)
    expect(stdinIdx).toBeGreaterThan(mIdx + 1) // model value sits between them
    // The stdin marker is the very last arg.
    expect(inv.args[inv.args.length - 1]).toBe('-')
  })

  it('with no model, the trailing "-" stdin marker is still the last arg (no -m)', () => {
    const inv = buildAgentInvocation({ RALPH_AGENT: 'codex' })
    expect(inv.args).not.toContain('-m')
    expect(inv.args[inv.args.length - 1]).toBe('-')
  })

  it('a whitespace-only model is treated as unset (no -m, stdin marker present)', () => {
    const inv = buildAgentInvocation({ RALPH_AGENT: 'codex', RALPH_CODEX_MODEL: '\t \n' })
    expect(inv.args).not.toContain('-m')
    expect(inv.args[inv.args.length - 1]).toBe('-')
  })

  it('does NOT compose a model or stdin marker for claude', () => {
    const inv = buildAgentInvocation({ RALPH_CODEX_MODEL: 'gpt-5-codex' })
    expect(inv.agent).toBe('claude')
    expect(inv.args).not.toContain('-m')
    expect(inv.args).not.toContain('-')
  })
})

// ---------------------------------------------------------------------------
// Agent environment — the background-wait ceiling crosses the bash bridge
// ---------------------------------------------------------------------------

describe('buildAgentInvocation — agentEnv carries the agent env as DEFAULTS', () => {
  it('claude gets the raised background-wait ceiling', () => {
    const inv = buildAgentInvocation({})
    expect(inv.agentEnv.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe('1800000')
  })

  it('an operator value already in the env WINS and is not re-emitted', () => {
    // The point of a default: setting it in ralph.config.sh must be respected,
    // including a deliberate 0 ("wait forever") that the registry would not pick.
    const inv = buildAgentInvocation({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' })
    expect(inv.agentEnv).toEqual({})
    expect(emitShellAssignments(inv)).not.toContain('CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS')
  })

  it('a blank or whitespace-only existing value is treated as unset', () => {
    // An empty string reaching a CLI that wants a number is nobody's choice.
    for (const blank of ['', '   ', '\t\n']) {
      const inv = buildAgentInvocation({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: blank })
      expect(inv.agentEnv.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe('1800000')
    }
  })

  it('codex carries no agent env', () => {
    const inv = buildAgentInvocation({ RALPH_AGENT: 'codex' })
    expect(inv.agentEnv).toEqual({})
    expect(emitShellAssignments(inv)).not.toContain('export ')
  })

  it('a fallen-back agent gets the CLAUDE env (resolved, not requested)', () => {
    const inv = buildAgentInvocation({ RALPH_AGENT: 'gpt' })
    expect(inv.agent).toBe('claude')
    expect(inv.agentEnv.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe('1800000')
  })
})

describe('emitShellAssignments — agent env as eval-able exports', () => {
  it('emits each variable as a single-quoted export', () => {
    const sh = emitShellAssignments(buildAgentInvocation({}))
    expect(sh).toContain("export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS='1800000'")
  })

  it('emits the exports BEFORE the assignments, so the multi-line filter stays last', () => {
    // Not cosmetic: extracting the filter means taking everything after its `=`,
    // so an export emitted after it would be absorbed into the quoted jq program
    // and never eval'd as a statement of its own.
    const sh = emitShellAssignments(buildAgentInvocation({}))
    expect(sh.indexOf('export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=')).toBeLessThan(
      sh.indexOf('RALPH_AGENT_STREAM_FILTER='),
    )
    expect(extractStreamFilterValue(sh)).not.toContain('export ')
  })

  it('tolerates a missing agentEnv (hand-built invocation objects)', () => {
    const sh = emitShellAssignments({ agent: 'claude', cli: 'claude', args: [] })
    expect(sh).not.toContain('export ')
    expect(sh.split('\n')[0]).toMatch(/^RALPH_RESOLVED_AGENT=/)
  })

  it('POSIX-escapes a single quote in an env value', () => {
    const sh = emitShellAssignments({
      agent: 'claude',
      cli: 'claude',
      args: [],
      agentEnv: { WEIRD: "it's" },
    })
    expect(sh).toContain(`export WEIRD='it'\\''s'`)
  })
})
