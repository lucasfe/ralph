import { describe, it, expect } from 'vitest'
import { assertCriticalDeps } from './doctor.js'

// #6 QA augmentation — assertCriticalDeps formats each missing critical dep as a
// translated line. The dev's doctor.test.js checks the single-dep tmux case on
// mac; these probe (a) MULTIPLE missing deps each get an independent English
// line with its own interpolated name + install command, and (b) the platform
// value drives the interpolated install hint (non-mac fallback branch).

describe('QA doctor.assertCriticalDeps — English formatting + interpolation (#6)', () => {
  it('formats several missing critical deps, one English line each, names + installs interpolated', () => {
    // git and tmux absent; everything else present. (jq/curl are non-critical.)
    const present = new Set(['gh', 'claude', 'node', 'npm', 'jq', 'curl'])
    const result = assertCriticalDeps({
      hasCommand: (name) => present.has(name),
      platform: 'mac',
      env: {},
    })
    expect(result.ok).toBe(false)
    const lines = result.message.split('\n')
    // One line per missing critical dep (git, tmux).
    expect(lines).toHaveLength(2)
    expect(result.message).toContain("❌ 'git' not found in PATH (install: brew install git)")
    expect(result.message).toContain("❌ 'tmux' not found in PATH (install: brew install tmux)")
    expect(result.message).not.toMatch(/não encontrado|instalar/)
  })

  it('interpolates the platform-specific install hint (linux)', () => {
    const present = new Set(['gh', 'claude', 'node', 'npm', 'jq', 'curl'])
    const result = assertCriticalDeps({
      hasCommand: (name) => present.has(name),
      platform: 'linux',
      env: {},
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("❌ 'git' not found in PATH (install: apt install git)")
    expect(result.message).toContain("❌ 'tmux' not found in PATH (install: apt install tmux)")
  })

  it('an unknown platform falls back to the linux install hint (still English)', () => {
    const present = new Set(['gh', 'claude', 'node', 'npm', 'jq', 'curl'])
    const result = assertCriticalDeps({
      hasCommand: (name) => present.has(name),
      platform: 'freebsd',
      env: {},
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("❌ 'git' not found in PATH (install: apt install git)")
  })
})

// ---------------------------------------------------------------------------
// QA augmentation for #125 — the same formatter, asked about the jira source.
//
// The dev's doctor.test.js proves the single-missing-acli line on mac and the
// shared linux/wsl hint. This block adds the two things that file cannot see from
// one dep: that MULTIPLE missing deps still get one independent line each in jira
// mode (the acli hint is by far the longest in the table, and it contains `&&` and
// a URL — the two things most likely to be mangled by a join), and that the
// platform fallback applies to the new entry like any other.
//
// `hasCommand` is injected in every call, so nothing here looks for a real acli.
// ---------------------------------------------------------------------------
describe('QA doctor.assertCriticalDeps — the jira source (#125)', () => {
  const JIRA = { TASK_SOURCE: 'jira' }
  const missing = (...absent) => (name) => !absent.includes(name)

  it('formats git AND acli as two independent lines, each with its own hint', () => {
    const result = assertCriticalDeps({
      hasCommand: missing('git', 'acli'),
      platform: 'mac',
      env: JIRA,
    })
    expect(result.ok).toBe(false)
    const lines = result.message.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe("❌ 'git' not found in PATH (install: brew install git)")
    expect(lines[1]).toBe(
      "❌ 'acli' not found in PATH (install: brew tap atlassian/acli && brew install acli)",
    )
  })

  it('carries the long linux hint whole — URL, chmod and install all on one line', () => {
    const result = assertCriticalDeps({
      hasCommand: missing('acli'),
      platform: 'linux',
      env: JIRA,
    })
    const lines = result.message.split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('https://acli.atlassian.com/linux/latest/acli_linux_amd64/acli')
    expect(lines[0]).toContain('chmod +x acli')
    expect(lines[0]).toContain('/usr/local/bin/acli')
    expect(lines[0].endsWith(')')).toBe(true)
  })

  it('an unknown platform falls back to acli\'s linux hint', () => {
    // `installFor` is `dep.install[platform] || dep.install.linux`. Note that an
    // OMITTED platform is not an unknown one — it takes the parameter default and
    // detects the host — so it is deliberately absent from this list.
    const linux = assertCriticalDeps({ hasCommand: missing('acli'), platform: 'linux', env: JIRA })
    for (const platform of ['freebsd', 'win32', 'sunos', '', null]) {
      const result = assertCriticalDeps({ hasCommand: missing('acli'), platform, env: JIRA })
      expect(result.message, String(platform)).toBe(linux.message)
    }
  })

  it('never mentions gh in jira mode, even on a machine with no gh at all', () => {
    // The whole point of gating gh in the first place, restated for the new mode: a
    // jira user must never be told to install a GitHub CLI, and the absence of gh
    // must not make the run look worse than it is.
    const result = assertCriticalDeps({
      hasCommand: missing('gh', 'acli'),
      platform: 'mac',
      env: JIRA,
    })
    expect(result.ok).toBe(false)
    expect(result.message.split('\n')).toHaveLength(1)
    expect(result.message).not.toMatch(/\bgh\b/)
    expect(result.message).not.toContain('brew install gh')
  })

  it('a fully-provisioned jira machine returns ok with no message at all', () => {
    // The shape callers branch on: `ok: true` carries an empty list and NO message
    // field, so a consumer printing `result.message` on the happy path prints
    // nothing rather than "undefined".
    const result = assertCriticalDeps({ hasCommand: () => true, platform: 'mac', env: JIRA })
    expect(result).toEqual({ ok: true, missingCritical: [] })
    expect('message' in result).toBe(false)
  })

  it('an uppercase TASK_SOURCE still gates on acli — the resolver runs first', () => {
    const result = assertCriticalDeps({
      hasCommand: missing('acli'),
      platform: 'mac',
      env: { TASK_SOURCE: '  JIRA  ' },
    })
    expect(result.ok).toBe(false)
    expect(result.missingCritical.map((r) => r.name)).toEqual(['acli'])
  })
})
