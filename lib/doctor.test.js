import { describe, it, expect } from 'vitest'
import { doctorCommand, assertCriticalDeps } from './commands/doctor.js'
import { REQUIRED_DEPS } from './deps.js'
import { detectPlatform } from './platform.js'

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
  }
}

const allPresent = () => true
const noneInstalled = () => false

describe('doctorCommand', () => {
  it('exits 0 when all deps are present', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await doctorCommand({
      stdout,
      stderr,
      hasCommand: allPresent,
      platform: 'mac',
    })
    expect(result.exitCode).toBe(0)
    expect(result.missingCritical).toEqual([])
    expect(stdout.output()).toContain('All deps present')
  })

  it('exits 1 when a critical dep is missing', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await doctorCommand({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'git',
      platform: 'mac',
    })
    expect(result.exitCode).toBe(1)
    expect(result.missingCritical.map((r) => r.name)).toEqual(['git'])
    expect(stderr.output()).toContain('Missing 1 required dep')
  })

  it('exits 0 with warning when only a non-critical dep is missing', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await doctorCommand({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'jq',
      platform: 'mac',
    })
    expect(result.exitCode).toBe(0)
    expect(result.missingCritical).toEqual([])
    expect(result.missingNonCritical.map((r) => r.name)).toEqual(['jq'])
    expect(stdout.output()).toContain('Optional deps missing: jq')
  })

  it('prints the macOS install command when platform is mac', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await doctorCommand({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'jq',
      platform: 'mac',
    })
    expect(stdout.output()).toContain('brew install jq')
  })

  it('prints the linux install command when platform is linux', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await doctorCommand({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'jq',
      platform: 'linux',
    })
    expect(stdout.output()).toContain('apt install jq')
  })

  it('prints the wsl install command when platform is wsl', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await doctorCommand({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'jq',
      platform: 'wsl',
    })
    expect(stdout.output()).toContain('apt install jq')
  })

  it('lists every required dep in the output', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await doctorCommand({
      stdout,
      stderr,
      hasCommand: allPresent,
      platform: 'mac',
    })
    for (const name of Object.keys(REQUIRED_DEPS)) {
      expect(stdout.output()).toContain(name)
    }
  })

  it('exits 1 when both critical and non-critical are missing', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await doctorCommand({
      stdout,
      stderr,
      hasCommand: noneInstalled,
      platform: 'mac',
    })
    expect(result.exitCode).toBe(1)
    expect(result.missingCritical.length).toBeGreaterThan(0)
    expect(result.missingNonCritical.length).toBeGreaterThan(0)
  })
})

describe('assertCriticalDeps', () => {
  it('returns ok when all critical deps present', () => {
    const result = assertCriticalDeps({ hasCommand: allPresent, platform: 'mac' })
    expect(result.ok).toBe(true)
    expect(result.missingCritical).toEqual([])
  })

  it('returns not ok with formatted message when critical dep missing', () => {
    const result = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'tmux',
      platform: 'mac',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("❌ 'tmux' não encontrado no PATH")
    expect(result.message).toContain('brew install tmux')
  })

  it('does not flag non-critical deps as failures', () => {
    const result = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'jq',
      platform: 'mac',
    })
    expect(result.ok).toBe(true)
  })
})

describe('detectPlatform', () => {
  it('returns mac for darwin', () => {
    expect(detectPlatform({ platform: 'darwin' })).toBe('mac')
  })

  it('returns linux when /proc/version has no microsoft tag', () => {
    expect(
      detectPlatform({ platform: 'linux', readProcVersion: () => 'Linux version 5.x ...' }),
    ).toBe('linux')
  })

  it('returns wsl when /proc/version mentions Microsoft', () => {
    expect(
      detectPlatform({
        platform: 'linux',
        readProcVersion: () => 'Linux version 5.x Microsoft WSL2',
      }),
    ).toBe('wsl')
  })

  it('returns wsl when /proc/version mentions microsoft (lowercase)', () => {
    expect(
      detectPlatform({
        platform: 'linux',
        readProcVersion: () => 'linux 5.x microsoft-standard',
      }),
    ).toBe('wsl')
  })

  it('returns linux when /proc/version is unreadable', () => {
    expect(detectPlatform({ platform: 'linux', readProcVersion: () => '' })).toBe('linux')
  })
})
