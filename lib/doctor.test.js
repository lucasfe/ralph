import { describe, it, expect } from 'vitest'
import { doctorCommand, assertCriticalDeps } from './commands/doctor.js'
import { REQUIRED_DEPS } from './deps.js'
import { detectPlatform } from './platform.js'
import { EMPTY_VERSION_CACHE } from './version-cache.js'

// Strip ANSI color codes so assertions on symbols (e.g. /✓ git/) hold whether
// or not picocolors emits color. In CI (CI=true / FORCE_COLOR) picocolors wraps
// `✓` in escape codes, which would otherwise break `✓ git`-style matches.
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '')

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => stripAnsi(chunks.join('')),
  }
}

const allPresent = () => true
const noneInstalled = () => false

// #27: doctor also renders a cached installed-vs-latest version line. These
// suites assert on the dependency report, so they stub the cache READER out —
// no test in this file may touch the real ~/.config/ralph/update-check.json.
// The version line's own states live in commands/doctor.version-line.test.js.
const runDoctor = (opts) => doctorCommand({ readCache: () => EMPTY_VERSION_CACHE, ...opts })

describe('doctorCommand', () => {
  it('exits 0 when all deps are present', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
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
    const result = await runDoctor({
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
    const result = await runDoctor({
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
    await runDoctor({
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
    await runDoctor({
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
    await runDoctor({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'jq',
      platform: 'wsl',
    })
    expect(stdout.output()).toContain('apt install jq')
  })

  it('lists every required dep for the selected agent in the output', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({
      stdout,
      stderr,
      hasCommand: allPresent,
      platform: 'mac',
      env: {},
    })
    // Default agent is claude: every shared dep + claude appear; codex (the
    // other agent's CLI) is NOT listed.
    for (const name of Object.keys(REQUIRED_DEPS)) {
      if (name === 'codex') {
        expect(stdout.output()).not.toContain('codex')
      } else {
        expect(stdout.output()).toContain(name)
      }
    }
  })

  it('exits 1 when both critical and non-critical are missing', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
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
    expect(result.message).toContain("❌ 'tmux' not found in PATH")
    expect(result.message).toContain('brew install tmux')
  })

  it('does not flag non-critical deps as failures', () => {
    const result = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'jq',
      platform: 'mac',
      env: {},
    })
    expect(result.ok).toBe(true)
  })
})

describe('doctor / deps — agent-aware (#554)', () => {
  it('checks claude and NOT codex when agent is claude (default)', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({ stdout, stderr, hasCommand: allPresent, platform: 'mac', env: {} })
    expect(stdout.output()).toContain('agent: claude')
    // claude present as a checked line; codex never appears.
    expect(stdout.output()).toMatch(/✓ claude/)
    expect(stdout.output()).not.toContain('codex')
  })

  it('checks codex and NOT claude when RALPH_AGENT=codex', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({
      stdout,
      stderr,
      hasCommand: allPresent,
      platform: 'mac',
      env: { RALPH_AGENT: 'codex' },
    })
    expect(stdout.output()).toContain('agent: codex')
    expect(stdout.output()).toMatch(/✓ codex/)
    expect(stdout.output()).not.toMatch(/✓ claude/)
  })

  it('a missing codex CLI is the critical failure on a codex machine (claude irrelevant)', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      // codex absent, claude also absent — only codex should count.
      hasCommand: (cmd) => cmd !== 'codex' && cmd !== 'claude',
      platform: 'mac',
      env: { RALPH_AGENT: 'codex' },
    })
    expect(result.exitCode).toBe(1)
    expect(result.missingCritical.map((r) => r.name)).toContain('codex')
    expect(result.missingCritical.map((r) => r.name)).not.toContain('claude')
  })

  it('a missing claude CLI does NOT fail doctor on a codex machine', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'claude',
      platform: 'mac',
      env: { RALPH_AGENT: 'codex' },
    })
    expect(result.exitCode).toBe(0)
  })

  it('reports the fallback warning when RALPH_AGENT is a typo, validates claude', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      hasCommand: allPresent,
      platform: 'mac',
      env: { RALPH_AGENT: 'codx' },
    })
    expect(result.exitCode).toBe(0)
    expect(stdout.output()).toContain('agent: claude')
    expect(stdout.output()).toContain('unrecognized')
  })

  it('assertCriticalDeps checks only the selected agent CLI', () => {
    // codex machine, claude missing but codex present => ok.
    const ok = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'claude',
      platform: 'mac',
      env: { RALPH_AGENT: 'codex' },
    })
    expect(ok.ok).toBe(true)
    // codex machine, codex missing => not ok, message names codex.
    const bad = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'codex',
      platform: 'mac',
      env: { RALPH_AGENT: 'codex' },
    })
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain("'codex'")
    expect(bad.message).toContain('npm install -g @openai/codex')
  })
})

describe('doctor / deps — source-aware gh gating (#565)', () => {
  it('checks gh when source is github (default)', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({ stdout, stderr, hasCommand: allPresent, platform: 'mac', env: {} })
    expect(stdout.output()).toMatch(/✓ gh/)
  })

  it('does NOT check gh when TASK_SOURCE=folder', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({
      stdout,
      stderr,
      hasCommand: allPresent,
      platform: 'mac',
      env: { TASK_SOURCE: 'folder' },
    })
    expect(stdout.output()).not.toContain('gh')
    // other shared deps still shown
    expect(stdout.output()).toMatch(/✓ git/)
  })

  it('a missing gh does NOT fail doctor in folder mode', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'gh',
      platform: 'mac',
      env: { TASK_SOURCE: 'folder' },
    })
    expect(result.exitCode).toBe(0)
  })

  it('a missing gh DOES fail doctor in github mode', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'gh',
      platform: 'mac',
      env: {},
    })
    expect(result.exitCode).toBe(1)
    expect(result.missingCritical.map((r) => r.name)).toContain('gh')
  })

  it('assertCriticalDeps ignores a missing gh in folder mode', () => {
    const ok = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'gh',
      platform: 'mac',
      env: { TASK_SOURCE: 'folder' },
    })
    expect(ok.ok).toBe(true)
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
