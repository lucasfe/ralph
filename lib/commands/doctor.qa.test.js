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
