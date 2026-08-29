import { describe, it, expect, vi } from 'vitest'
import { probeJiraAuth } from './jira-auth.js'

// #125 — the Jira auth probe, modelled on lib/agent-auth.test.js's codex arm and
// asserted the same way, because the contract is the same contract: the EXIT CODE
// decides and the output text never does. No test here runs a real `acli`; `exec`
// is an injected seam, which is the whole reason this module exists separately
// from lib/commands/doctor.js (that file's import graph is pinned closed).

describe('probeJiraAuth — exit code only', () => {
  it('ok when `acli jira auth status` exits zero', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'Logged in', stderr: '' }))
    const r = await probeJiraAuth({ exec })
    expect(r).toEqual({ ok: true, reason: null })
    expect(exec).toHaveBeenCalledWith(
      'acli',
      ['jira', 'auth', 'status'],
      expect.objectContaining({ reject: false }),
    )
  })

  it('exit 0 with alarming output is STILL ok — the text is never parsed', async () => {
    // The same argument agent-auth.js makes for `codex login status`: a build that
    // prints something scary and exits zero is authenticated, and a probe that
    // grepped the text would report a failure nobody has.
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'error: not authenticated',
      stderr: 'no active session\nlogin required',
    }))
    expect(await probeJiraAuth({ exec })).toEqual({ ok: true, reason: null })
  })

  it('fails on a non-zero exit whatever the text says', async () => {
    const exec = vi.fn(async () => ({ exitCode: 1, stdout: 'Logged in as me', stderr: '' }))
    const r = await probeJiraAuth({ exec })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('jira not authenticated')
  })

  it('fails safe when exec throws (acli absent, spawn error)', async () => {
    const exec = vi.fn(async () => {
      throw new Error('ENOENT: acli not found')
    })
    const r = await probeJiraAuth({ exec })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('jira not authenticated')
  })

  it('fails safe on a rejected promise, and never propagates', async () => {
    const exec = vi.fn(() => Promise.reject(new Error('boom')))
    expect((await probeJiraAuth({ exec })).ok).toBe(false)
  })

  it('fails safe when exec resolves to nothing (no crash on r.exitCode)', async () => {
    expect((await probeJiraAuth({ exec: vi.fn(async () => undefined) })).ok).toBe(false)
    expect((await probeJiraAuth({ exec: vi.fn(async () => null) })).ok).toBe(false)
  })

  it('a result MISSING exitCode is not success (undefined !== 0)', async () => {
    const exec = vi.fn(async () => ({ stdout: 'Logged in', stderr: '' }))
    expect((await probeJiraAuth({ exec })).ok).toBe(false)
  })

  it('a STRING "0" exitCode is not success (strict === 0)', async () => {
    const exec = vi.fn(async () => ({ exitCode: '0', stdout: '', stderr: '' }))
    expect((await probeJiraAuth({ exec })).ok).toBe(false)
  })

  it('a missing exec means not authenticated rather than a throw', async () => {
    // The seam has no default ON PURPOSE — this module imports no process spawner,
    // so a caller that supplies none cannot verify anything. Answering ok:false is
    // the safe reading; `ralph doctor` distinguishes "cannot verify" from "not
    // authenticated" itself, by checking for the seam before it probes.
    expect(await probeJiraAuth({})).toEqual({ ok: false, reason: 'jira not authenticated' })
    expect(await probeJiraAuth()).toEqual({ ok: false, reason: 'jira not authenticated' })
    expect((await probeJiraAuth({ exec: 'not a function' })).ok).toBe(false)
  })
})
