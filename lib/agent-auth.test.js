import { describe, it, expect, vi } from 'vitest'
import { probeAgentAuth } from './agent-auth.js'

describe('probeAgentAuth — claude', () => {
  it('ok when the credentials file exists', async () => {
    const r = await probeAgentAuth({
      agent: 'claude',
      exists: (p) => p === '/home/.claude/.credentials.json',
      claudeCredentialsPath: '/home/.claude/.credentials.json',
    })
    expect(r).toEqual({ ok: true, reason: null })
  })

  it('fails with a reason when the credentials file is absent', async () => {
    const r = await probeAgentAuth({
      agent: 'claude',
      exists: () => false,
      claudeCredentialsPath: '/home/.claude/.credentials.json',
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('claude credentials missing')
  })

  it('does not shell out for claude', async () => {
    const exec = vi.fn()
    await probeAgentAuth({
      agent: 'claude',
      exists: () => true,
      exec,
      claudeCredentialsPath: '/x',
    })
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('probeAgentAuth — codex (exit code only)', () => {
  it('ok when codex login status exits zero', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'Logged in', stderr: '' }))
    const r = await probeAgentAuth({ agent: 'codex', exec })
    expect(r).toEqual({ ok: true, reason: null })
    expect(exec).toHaveBeenCalledWith('codex', ['login', 'status'], expect.objectContaining({ reject: false }))
  })

  it('treats a "login not required" message with exit 0 as success', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: 'Login is not required. Uses managed credentials.',
    }))
    const r = await probeAgentAuth({ agent: 'codex', exec })
    expect(r.ok).toBe(true)
  })

  it('fails when codex login status exits non-zero (regardless of text)', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Login is not required.',
    }))
    const r = await probeAgentAuth({ agent: 'codex', exec })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('codex not authenticated')
  })

  it('fails safe when exec throws', async () => {
    const exec = vi.fn(async () => {
      throw new Error('spawn error')
    })
    const r = await probeAgentAuth({ agent: 'codex', exec })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('codex not authenticated')
  })
})

describe('probeAgentAuth — guards', () => {
  it('throws on an unknown agent', async () => {
    await expect(probeAgentAuth({ agent: 'gpt', exec: vi.fn() })).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#554): adversarial auth-probe cases the happy path missed.
// ---------------------------------------------------------------------------

describe('QA: probeAgentAuth — codex exit-code-only contract (adversarial)', () => {
  it('exit 0 with SCARY stderr ("login not required", "error") is still ok:true', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'error: something',
      stderr: 'login not required\nerror\nnot authenticated',
    }))
    const r = await probeAgentAuth({ agent: 'codex', exec })
    expect(r).toEqual({ ok: true, reason: null })
  })

  it('exit 0 with a REASSURING stderr but a truthy non-zero code elsewhere still keys on code', async () => {
    // exitCode 2 => not authenticated regardless of friendly text.
    const exec = vi.fn(async () => ({ exitCode: 2, stdout: 'Logged in as foo', stderr: '' }))
    const r = await probeAgentAuth({ agent: 'codex', exec })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('codex not authenticated')
  })

  it('a rejected exec promise fails safe (ok:false), never propagates', async () => {
    const exec = vi.fn(async () => Promise.reject(new Error('ENOENT: codex not found')))
    const r = await probeAgentAuth({ agent: 'codex', exec })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('codex not authenticated')
  })

  it('exec resolving to undefined/null result => ok:false (no crash on r.exitCode)', async () => {
    const rUndef = await probeAgentAuth({ agent: 'codex', exec: vi.fn(async () => undefined) })
    expect(rUndef.ok).toBe(false)
    const rNull = await probeAgentAuth({ agent: 'codex', exec: vi.fn(async () => null) })
    expect(rNull.ok).toBe(false)
  })

  it('exec result MISSING exitCode entirely => ok:false (undefined !== 0)', async () => {
    const exec = vi.fn(async () => ({ stdout: 'Logged in', stderr: '' }))
    const r = await probeAgentAuth({ agent: 'codex', exec })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('codex not authenticated')
  })

  it('exitCode "0" as a STRING is NOT treated as success (strict === 0)', async () => {
    const exec = vi.fn(async () => ({ exitCode: '0', stdout: '', stderr: '' }))
    const r = await probeAgentAuth({ agent: 'codex', exec })
    // strict equality against number 0 => string '0' fails => not authenticated.
    expect(r.ok).toBe(false)
  })
})

describe('QA: probeAgentAuth — claude credentials path (adversarial)', () => {
  it('an undefined claudeCredentialsPath with a permissive exists still resolves', async () => {
    // exists(undefined) returning false must yield the missing-credentials reason.
    const r = await probeAgentAuth({
      agent: 'claude',
      exists: (p) => p === '/real/path',
      claudeCredentialsPath: undefined,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('claude credentials missing')
  })

  it('does NOT invoke exec even when one is supplied and creds are missing', async () => {
    const exec = vi.fn()
    const r = await probeAgentAuth({
      agent: 'claude',
      exists: () => false,
      exec,
      claudeCredentialsPath: '/x',
    })
    expect(exec).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
  })
})
