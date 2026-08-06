import { describe, it, expect } from 'vitest'
import { checkDeps, REQUIRED_DEPS } from './deps.js'

// QA (#554): direct unit coverage of the agent-aware dependency set. doctor.js
// exercises this via doctorCommand, but checkDeps is the pure seam so its agent
// gating deserves its own pin.

const allPresent = () => true

function names(results) {
  return results.map((r) => r.name)
}

describe('checkDeps — agent-aware CLI selection (#554)', () => {
  it('default agent (claude) includes claude and EXCLUDES codex', () => {
    const results = checkDeps({ hasCommand: allPresent })
    expect(names(results)).toContain('claude')
    expect(names(results)).not.toContain('codex')
  })

  it('agent=codex includes codex and EXCLUDES claude', () => {
    const results = checkDeps({ hasCommand: allPresent, agent: 'codex' })
    expect(names(results)).toContain('codex')
    expect(names(results)).not.toContain('claude')
  })

  it('agent=claude includes claude and EXCLUDES codex (explicit)', () => {
    const results = checkDeps({ hasCommand: allPresent, agent: 'claude' })
    expect(names(results)).toContain('claude')
    expect(names(results)).not.toContain('codex')
  })

  it('the selected agent CLI is marked critical', () => {
    const codex = checkDeps({ hasCommand: allPresent, agent: 'codex' }).find(
      (r) => r.name === 'codex',
    )
    expect(codex.critical).toBe(true)
  })

  it('shared (non-agent) deps are ALWAYS present regardless of agent', () => {
    const shared = ['git', 'gh', 'tmux', 'node', 'npm', 'jq', 'curl']
    for (const agent of ['claude', 'codex']) {
      const got = names(checkDeps({ hasCommand: allPresent, agent }))
      for (const dep of shared) expect(got).toContain(dep)
    }
  })

  it('EXACTLY ONE agent CLI appears in the result set', () => {
    for (const agent of ['claude', 'codex']) {
      const agentClis = names(checkDeps({ hasCommand: allPresent, agent })).filter(
        (n) => n === 'claude' || n === 'codex',
      )
      expect(agentClis).toEqual([agent])
    }
  })

  it('an UNKNOWN/fallback agent name yields a set with NEITHER agent CLI (only shared)', () => {
    // checkDeps is passed the RESOLVED agent, but if a bogus name leaks through
    // it must still return a usable, shared-only set — never throw, never both.
    const results = checkDeps({ hasCommand: allPresent, agent: 'bogus' })
    expect(names(results)).not.toContain('claude')
    expect(names(results)).not.toContain('codex')
    expect(names(results)).toContain('git')
    expect(results.length).toBeGreaterThan(0)
  })

  it('present flag reflects hasCommand for each dep', () => {
    const results = checkDeps({
      hasCommand: (cmd) => cmd !== 'codex',
      agent: 'codex',
    })
    const codex = results.find((r) => r.name === 'codex')
    expect(codex.present).toBe(false)
  })

  it('REQUIRED_DEPS marks both agent CLIs with the agent flag', () => {
    expect(REQUIRED_DEPS.claude.agent).toBe(true)
    expect(REQUIRED_DEPS.codex.agent).toBe(true)
  })
})
