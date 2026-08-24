import { describe, it, expect } from 'vitest'
import { resolveAgent, agentSpec } from './agent-registry.js'

describe('resolveAgent — reads RALPH_AGENT from env', () => {
  it('defaults to claude when RALPH_AGENT is unset', () => {
    expect(resolveAgent({})).toEqual({
      agent: 'claude',
      fellBack: false,
      warning: null,
    })
  })

  it('defaults to claude when RALPH_AGENT is empty/whitespace', () => {
    expect(resolveAgent({ RALPH_AGENT: '' }).agent).toBe('claude')
    expect(resolveAgent({ RALPH_AGENT: '   ' }).agent).toBe('claude')
    expect(resolveAgent({ RALPH_AGENT: '' }).fellBack).toBe(false)
  })

  it('resolves an explicit claude value', () => {
    expect(resolveAgent({ RALPH_AGENT: 'claude' })).toEqual({
      agent: 'claude',
      fellBack: false,
      warning: null,
    })
  })

  it('resolves an explicit codex value', () => {
    expect(resolveAgent({ RALPH_AGENT: 'codex' })).toEqual({
      agent: 'codex',
      fellBack: false,
      warning: null,
    })
  })

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(resolveAgent({ RALPH_AGENT: '  CODEX ' }).agent).toBe('codex')
    expect(resolveAgent({ RALPH_AGENT: 'Claude' }).agent).toBe('claude')
  })

  it('falls back to claude on an unrecognized value, resolved==fallback', () => {
    const r = resolveAgent({ RALPH_AGENT: 'codx' })
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
    expect(r.warning).toBe(
      "RALPH_AGENT='codx' unrecognized; falling back to 'claude'. Valid: claude, codex.",
    )
  })

  it('preserves the ORIGINAL (untrimmed/original-case) value in the warning', () => {
    const r = resolveAgent({ RALPH_AGENT: ' GPT ' })
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
    expect(r.warning).toContain("RALPH_AGENT=' GPT '")
  })

  it('tolerates a missing/undefined env argument', () => {
    expect(resolveAgent().agent).toBe('claude')
  })
})

// The exact static argv template Claude has always used — asserted here so a
// drift in the registry is caught (the Claude pipeline must stay unchanged).
const CLAUDE_ARGV = [
  '-p',
  '--dangerously-skip-permissions',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
]

// The static base Codex argv (env-dependent `-m <model>` and the `-` stdin
// marker are composed in agent-invocation.js, NOT here).
const CODEX_ARGV = [
  'exec',
  '--json',
  '--sandbox',
  'workspace-write',
  '-c',
  'approval_policy="never"',
  '-c',
  'sandbox_workspace_write.network_access=true',
]

describe('agentSpec — per-agent knowledge', () => {
  it('returns the claude spec', () => {
    expect(agentSpec('claude')).toEqual({
      cli: 'claude',
      orchestratorTemplate: 'prompt-team.md',
      dependency: 'claude',
      authProbe: 'credentials-file',
      argv: CLAUDE_ARGV,
      streamFilter: expect.any(String),
    })
  })

  it('returns the codex spec', () => {
    expect(agentSpec('codex')).toEqual({
      cli: 'codex',
      orchestratorTemplate: 'prompt-team-codex.md',
      dependency: 'codex',
      authProbe: 'login-status',
      argv: CODEX_ARGV,
      streamFilter: expect.any(String),
    })
  })

  it('throws on an unknown agent', () => {
    expect(() => agentSpec('gpt')).toThrow()
    expect(() => agentSpec()).toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC#5 (#555): the spec is now COMPLETE — it carries the static argv template
// AND the jq output-stream filter, so bash holds no agent knowledge.
// ---------------------------------------------------------------------------

describe('agentSpec — argv static template (AC#5)', () => {
  it('claude argv is the exact 6-flag stream-json template', () => {
    expect(agentSpec('claude').argv).toEqual(CLAUDE_ARGV)
  })

  it('codex argv is the exact static base (no -m, no stdin marker)', () => {
    const argv = agentSpec('codex').argv
    expect(argv).toEqual(CODEX_ARGV)
    expect(argv).not.toContain('-m')
    expect(argv).not.toContain('-')
  })

  it('returns a fresh argv array copy each call (no shared mutation)', () => {
    const a = agentSpec('claude').argv
    a.push('HACKED')
    expect(agentSpec('claude').argv).toEqual(CLAUDE_ARGV)
  })
})

describe('agentSpec — streamFilter jq program (AC#5)', () => {
  it('claude has a non-empty jq filter string rendering stream-json events', () => {
    const f = agentSpec('claude').streamFilter
    expect(typeof f).toBe('string')
    expect(f.length).toBeGreaterThan(0)
    expect(f).toContain('fromjson? // empty')
    expect(f).toContain('.type == "assistant"')
    expect(f).toContain('==> result: ')
  })

  // #15: the claude filter surfaces tool_use as informative `⏺ ToolName(hint)`
  // lines and DROPS the old contentless `↳ tool_result` flood entirely.
  it('claude filter surfaces tool_use (not the tool_result flood) (#15)', () => {
    const f = agentSpec('claude').streamFilter
    // Renders tool_use blocks with the ⏺ glyph...
    expect(f).toContain('tool_use')
    expect(f).toContain('⏺')
    // ...and no longer emits the contentless tool_result placeholder.
    expect(f).not.toContain('tool_result')
    expect(f).not.toContain('↳')
    // The hint field precedence is present.
    expect(f).toContain('.command')
    expect(f).toContain('.file_path')
    expect(f).toContain('.pattern')
    expect(f).toContain('.description')
  })

  // #39: the claude result event's `is_error` flag outranks its `subtype`, so the
  // filter must consult it (a stream-json `result` can claim subtype "success"
  // while flagging is_error true).
  it('claude filter guards the result line with .is_error (#39)', () => {
    const f = agentSpec('claude').streamFilter
    expect(f).toContain('.is_error')
  })

  it('codex has a non-empty jq filter string rendering codex JSONL events', () => {
    const f = agentSpec('codex').streamFilter
    expect(typeof f).toBe('string')
    expect(f.length).toBeGreaterThan(0)
    expect(f).toContain('fromjson? // empty')
    expect(f).toContain('item.completed')
    expect(f).toContain('turn.completed')
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#554): adversarial RALPH_AGENT inputs + spec-throw guards.
// ---------------------------------------------------------------------------

describe('QA: resolveAgent — adversarial RALPH_AGENT values', () => {
  it('tab / newline-only whitespace is treated as unset (=> claude, no fallback)', () => {
    expect(resolveAgent({ RALPH_AGENT: '\t' })).toEqual({
      agent: 'claude',
      fellBack: false,
      warning: null,
    })
    expect(resolveAgent({ RALPH_AGENT: '\n\n' }).fellBack).toBe(false)
  })

  it('codex with tab/newline padding still resolves to codex', () => {
    expect(resolveAgent({ RALPH_AGENT: '\tcodex\n' }).agent).toBe('codex')
  })

  it('mixed-case CLAUDE / cOdEx resolve without fallback', () => {
    expect(resolveAgent({ RALPH_AGENT: 'CLAUDE' })).toEqual({
      agent: 'claude',
      fellBack: false,
      warning: null,
    })
    expect(resolveAgent({ RALPH_AGENT: 'cOdEx' }).agent).toBe('codex')
    expect(resolveAgent({ RALPH_AGENT: 'cOdEx' }).fellBack).toBe(false)
  })

  it('a numeric value falls back to claude with a warning naming it', () => {
    const r = resolveAgent({ RALPH_AGENT: '42' })
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
    expect(r.warning).toContain("RALPH_AGENT='42'")
    expect(r.warning).toContain("falling back to 'claude'")
  })

  it('a value that merely CONTAINS a valid name (substring) still falls back', () => {
    // guards against a loose includes()-style match
    const r = resolveAgent({ RALPH_AGENT: 'codex-turbo' })
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
    expect(r.warning).toContain("RALPH_AGENT='codex-turbo'")
  })

  it('the fallback warning both names the bad value AND lists valid agents', () => {
    const r = resolveAgent({ RALPH_AGENT: 'gemini' })
    expect(r.warning).toContain("RALPH_AGENT='gemini'")
    expect(r.warning).toContain('claude, codex')
  })

  it('a non-string RALPH_AGENT (number) is stringified and falls back', () => {
    const r = resolveAgent({ RALPH_AGENT: 7 })
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
  })

  it('an all-whitespace-then-typo value is trimmed before matching but echoed raw', () => {
    const r = resolveAgent({ RALPH_AGENT: '   codx   ' })
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
    expect(r.warning).toContain("RALPH_AGENT='   codx   '")
  })
})

describe('QA: agentSpec — returns an independent copy (no shared mutation)', () => {
  it('mutating a returned spec does not affect the next call', () => {
    const a = agentSpec('codex')
    a.cli = 'HACKED'
    expect(agentSpec('codex').cli).toBe('codex')
  })

  it('throws with a message naming the bad agent + valid list', () => {
    expect(() => agentSpec('gemini')).toThrow(/gemini/)
    expect(() => agentSpec('gemini')).toThrow(/claude, codex/)
  })

  it('throws (not returns undefined) for null / empty-string agent', () => {
    expect(() => agentSpec(null)).toThrow()
    expect(() => agentSpec('')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#555): registry immutability is COMPLETE, and streamFilter
// content is a real jq program (not a placeholder). The registry is the single
// source of agent knowledge, so a caller corrupting a returned value must never
// leak back into the next reader.
// ---------------------------------------------------------------------------

describe('QA: agentSpec — returned argv is fully insulated from mutation', () => {
  it('push()-ing onto the returned argv does not affect the next call', () => {
    const first = agentSpec('claude').argv
    first.push('--evil')
    expect(agentSpec('claude').argv).toEqual(CLAUDE_ARGV)
    expect(agentSpec('claude').argv).not.toContain('--evil')
  })

  it('splice()-ing the returned argv does not affect the next call', () => {
    const first = agentSpec('codex').argv
    first.splice(0, first.length) // empty it out entirely
    expect(first.length).toBe(0)
    expect(agentSpec('codex').argv).toEqual(CODEX_ARGV)
  })

  it('reverse()-ing the returned argv (in-place) does not affect the next call', () => {
    const first = agentSpec('claude').argv
    first.reverse()
    // The mutated copy is reversed...
    expect(first[0]).toBe('--include-partial-messages')
    // ...but the registry still yields the original order.
    expect(agentSpec('claude').argv).toEqual(CLAUDE_ARGV)
  })

  it('two successive calls return DISTINCT argv array instances', () => {
    expect(agentSpec('codex').argv).not.toBe(agentSpec('codex').argv)
  })
})

describe('QA: agentSpec — scalar fields are insulated by the top-level spread', () => {
  it('reassigning a returned scalar (dependency, orchestratorTemplate) is harmless', () => {
    const s = agentSpec('claude')
    s.dependency = 'HACKED'
    s.orchestratorTemplate = 'evil.md'
    s.authProbe = 'nope'
    const fresh = agentSpec('claude')
    expect(fresh.dependency).toBe('claude')
    expect(fresh.orchestratorTemplate).toBe('prompt-team.md')
    expect(fresh.authProbe).toBe('credentials-file')
  })

  it('reassigning a returned streamFilter does not corrupt the registry', () => {
    // Strings are immutable; a caller can only REASSIGN the property on their
    // own copy. Prove that reassignment cannot leak into the next reader.
    const original = agentSpec('codex').streamFilter
    const s = agentSpec('codex')
    s.streamFilter = 'evil // empty'
    expect(agentSpec('codex').streamFilter).toBe(original)
    expect(agentSpec('codex').streamFilter).not.toBe('evil // empty')
  })
})

describe('QA: agentSpec — streamFilter is a real jq program, not a placeholder', () => {
  it('both filters begin with fromjson? and expose a "==> result:" line', () => {
    for (const agent of ['claude', 'codex']) {
      const f = agentSpec(agent).streamFilter
      expect(typeof f).toBe('string')
      // A non-trivial program (guards against an accidental empty/one-token filter).
      expect(f.trim().length).toBeGreaterThan(20)
      // Must start the pipeline by parsing the JSON line safely.
      expect(f.startsWith('fromjson?')).toBe(true)
      // Must emit the sentinel the pretty-printer relies on; an empty or
      // placeholder filter would silently blank the rendered log.
      expect(f).toContain('==> result:')
    }
  })
})
