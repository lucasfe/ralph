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

describe('agentSpec — per-agent knowledge', () => {
  it('returns the claude spec', () => {
    expect(agentSpec('claude')).toEqual({
      cli: 'claude',
      orchestratorTemplate: 'prompt-team.md',
      dependency: 'claude',
      authProbe: 'credentials-file',
    })
  })

  it('returns the codex spec', () => {
    expect(agentSpec('codex')).toEqual({
      cli: 'codex',
      orchestratorTemplate: 'prompt-team-codex.md',
      dependency: 'codex',
      authProbe: 'login-status',
    })
  })

  it('throws on an unknown agent', () => {
    expect(() => agentSpec('gpt')).toThrow()
    expect(() => agentSpec()).toThrow()
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
