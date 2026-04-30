import { describe, it, expect } from 'vitest'
import {
  parseInterval,
  scheduleInstallCommand,
  schedulePauseCommand,
  scheduleResumeCommand,
  scheduleStatusCommand,
  scheduleRemoveCommand,
} from './schedule.js'

const HOME = '/Users/me'
const REPO = '/Users/me/repos/agenthub'
const SLUG = 'agenthub'
const LABEL = `com.lucasfe.ralph.cycle.${SLUG}`
const PLIST_PATH = `${HOME}/Library/LaunchAgents/${LABEL}.plist`

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

function makeExec(handlers = {}) {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, options })
    if (Object.prototype.hasOwnProperty.call(handlers, key)) {
      const v = handlers[key]
      return typeof v === 'function' ? v({ cmd, args, options }) : v
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

const baseHandlers = () => ({
  'git rev-parse --show-toplevel': { exitCode: 0, stdout: `${REPO}\n`, stderr: '' },
})

const baseDeps = (overrides = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec: makeExec(baseHandlers()),
    exists: () => true,
    home: HOME,
    platform: 'mac',
    ralphBinary: '/usr/local/bin/ralph',
    ...overrides,
  }
}

describe('parseInterval', () => {
  it('returns the default when input is undefined', () => {
    expect(parseInterval(undefined)).toBe(14400)
    expect(parseInterval(null)).toBe(14400)
  })

  it('parses bare integer as seconds', () => {
    expect(parseInterval('60')).toBe(60)
    expect(parseInterval('3600')).toBe(3600)
  })

  it('parses 30m as 1800 seconds', () => {
    expect(parseInterval('30m')).toBe(1800)
  })

  it('parses 2h as 7200 seconds', () => {
    expect(parseInterval('2h')).toBe(7200)
  })

  it('parses 4h as 14400 seconds', () => {
    expect(parseInterval('4h')).toBe(14400)
  })

  it('parses 1d as 86400 seconds', () => {
    expect(parseInterval('1d')).toBe(86400)
  })

  it('throws on invalid input', () => {
    expect(() => parseInterval('not-a-duration')).toThrow()
    expect(() => parseInterval('4y')).toThrow()
  })
})

describe('scheduleInstallCommand — pre-flight', () => {
  it('aborts when ralph.config.sh is missing', async () => {
    let installCalled = false
    const deps = baseDeps({
      exists: (p) => !p.endsWith('ralph.config.sh'),
      installAgent: async () => {
        installCalled = true
        return { plistPath: PLIST_PATH, label: LABEL, loadResult: { exitCode: 0 } }
      },
    })
    await expect(scheduleInstallCommand(deps)).rejects.toMatchObject({
      exitCode: 1,
    })
    expect(installCalled).toBe(false)
    expect(deps.stderr.output()).toMatch(/ralph\.config\.sh/)
    expect(deps.stderr.output()).toMatch(/ralph init/i)
  })

  it('warns but proceeds when .env.local is missing', async () => {
    let installCalled = false
    const deps = baseDeps({
      exists: (p) => !p.endsWith('.env.local') && !p.endsWith('.plist'),
      installAgent: async () => {
        installCalled = true
        return { plistPath: PLIST_PATH, label: LABEL, loadResult: { exitCode: 0 } }
      },
    })
    const result = await scheduleInstallCommand(deps)
    expect(installCalled).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(deps.stdout.output()).toMatch(/\.env\.local/)
  })

  it('aborts on non-mac platforms', async () => {
    const deps = baseDeps({ platform: 'linux' })
    await expect(scheduleInstallCommand(deps)).rejects.toMatchObject({
      exitCode: 1,
    })
    expect(deps.stderr.output()).toMatch(/macos|mac/i)
  })
})

describe('scheduleInstallCommand — existing plist', () => {
  it('aborts when a plist with the same slug already exists and --force is not set', async () => {
    let installCalled = false
    const deps = baseDeps({
      exists: () => true, // plist exists
      installAgent: async () => {
        installCalled = true
        return { plistPath: PLIST_PATH, label: LABEL, loadResult: { exitCode: 0 } }
      },
    })
    await expect(scheduleInstallCommand(deps)).rejects.toMatchObject({
      exitCode: 1,
    })
    expect(installCalled).toBe(false)
    expect(deps.stderr.output()).toMatch(/--force/)
  })

  it('proceeds when --force is set even if plist exists', async () => {
    let removeCalled = false
    let installCalled = false
    const deps = baseDeps({
      exists: () => true,
      force: true,
      removeAgent: async () => {
        removeCalled = true
        return { plistPath: PLIST_PATH, removed: true, unloadResult: { exitCode: 0 } }
      },
      installAgent: async () => {
        installCalled = true
        return { plistPath: PLIST_PATH, label: LABEL, loadResult: { exitCode: 0 } }
      },
    })
    const result = await scheduleInstallCommand(deps)
    expect(removeCalled).toBe(true)
    expect(installCalled).toBe(true)
    expect(result.exitCode).toBe(0)
  })
})

describe('scheduleInstallCommand — happy path', () => {
  it('computes slug from repo basename and installs the launchd agent', async () => {
    let installArgs = null
    const deps = baseDeps({
      exists: (p) => !p.endsWith('.plist'), // no existing plist
      installAgent: async (args) => {
        installArgs = args
        return { plistPath: PLIST_PATH, label: LABEL, loadResult: { exitCode: 0 } }
      },
    })
    const result = await scheduleInstallCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.slug).toBe(SLUG)
    expect(installArgs.slug).toBe(SLUG)
    expect(installArgs.workingDirectory).toBe(REPO)
    expect(installArgs.command).toBe('/usr/local/bin/ralph')
    expect(installArgs.args).toEqual(['cycle'])
    expect(installArgs.intervalSeconds).toBe(14400)
    expect(installArgs.logDir).toBe(`${REPO}/logs`)
  })

  it('honors a custom --interval flag', async () => {
    let installArgs = null
    const deps = baseDeps({
      exists: (p) => !p.endsWith('.plist'),
      interval: '30m',
      installAgent: async (args) => {
        installArgs = args
        return { plistPath: PLIST_PATH, label: LABEL, loadResult: { exitCode: 0 } }
      },
    })
    await scheduleInstallCommand(deps)
    expect(installArgs.intervalSeconds).toBe(1800)
  })

  it('prints a success summary on stdout', async () => {
    const deps = baseDeps({
      exists: (p) => !p.endsWith('.plist'),
      installAgent: async () => ({
        plistPath: PLIST_PATH,
        label: LABEL,
        loadResult: { exitCode: 0 },
      }),
    })
    await scheduleInstallCommand(deps)
    const output = deps.stdout.output()
    expect(output).toMatch(/installed|✅/i)
    expect(output).toContain(LABEL)
  })
})

describe('scheduleRemoveCommand', () => {
  it('removes the launchd agent matching the current repo slug', async () => {
    let removeArgs = null
    const deps = baseDeps({
      exists: () => true,
      removeAgent: async (args) => {
        removeArgs = args
        return { plistPath: PLIST_PATH, removed: true, unloadResult: { exitCode: 0 } }
      },
    })
    const result = await scheduleRemoveCommand(deps)
    expect(removeArgs.slug).toBe(SLUG)
    expect(result.exitCode).toBe(0)
    expect(result.removed).toBe(true)
  })

  it('exits 0 with an informational message when no plist is installed', async () => {
    let removeCalled = false
    const deps = baseDeps({
      exists: () => false, // plist missing
      removeAgent: async () => {
        removeCalled = true
        return { plistPath: PLIST_PATH, removed: false, unloadResult: null }
      },
    })
    const result = await scheduleRemoveCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.removed).toBe(false)
    expect(removeCalled).toBe(false)
    expect(deps.stdout.output()).toMatch(/no launchd agent|nothing/i)
  })

  it('aborts on non-mac platforms', async () => {
    const deps = baseDeps({ platform: 'wsl' })
    await expect(scheduleRemoveCommand(deps)).rejects.toMatchObject({
      exitCode: 1,
    })
  })
})

describe('schedulePauseCommand', () => {
  it('runs `launchctl unload -w` and keeps the plist file', async () => {
    let pauseArgs = null
    const deps = baseDeps({
      exists: () => true,
      pauseAgent: async (args) => {
        pauseArgs = args
        return {
          plistPath: PLIST_PATH,
          paused: true,
          unloadResult: { exitCode: 0 },
        }
      },
    })
    const result = await schedulePauseCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.paused).toBe(true)
    expect(pauseArgs.slug).toBe(SLUG)
    expect(deps.stdout.output()).toMatch(/paused|⏸/i)
    expect(deps.stdout.output()).toContain(LABEL)
  })

  it('aborts when no plist is installed for the current repo', async () => {
    let pauseCalled = false
    const deps = baseDeps({
      exists: () => false,
      pauseAgent: async () => {
        pauseCalled = true
        return {
          plistPath: PLIST_PATH,
          paused: false,
          unloadResult: null,
        }
      },
    })
    await expect(schedulePauseCommand(deps)).rejects.toMatchObject({
      exitCode: 1,
    })
    expect(pauseCalled).toBe(false)
    expect(deps.stderr.output()).toMatch(/not installed|no launchd|run.*ralph schedule install/i)
  })

  it('aborts on non-mac platforms', async () => {
    const deps = baseDeps({ platform: 'linux' })
    await expect(schedulePauseCommand(deps)).rejects.toMatchObject({
      exitCode: 1,
    })
  })
})

describe('scheduleResumeCommand', () => {
  it('runs `launchctl load -w` against the existing plist', async () => {
    let resumeArgs = null
    const deps = baseDeps({
      exists: () => true,
      resumeAgent: async (args) => {
        resumeArgs = args
        return {
          plistPath: PLIST_PATH,
          resumed: true,
          loadResult: { exitCode: 0 },
        }
      },
    })
    const result = await scheduleResumeCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.resumed).toBe(true)
    expect(resumeArgs.slug).toBe(SLUG)
    expect(deps.stdout.output()).toMatch(/resumed|▶|active/i)
    expect(deps.stdout.output()).toContain(LABEL)
  })

  it('aborts when no plist is installed for the current repo', async () => {
    const deps = baseDeps({
      exists: () => false,
      resumeAgent: async () => ({
        plistPath: PLIST_PATH,
        resumed: false,
        loadResult: null,
      }),
    })
    await expect(scheduleResumeCommand(deps)).rejects.toMatchObject({
      exitCode: 1,
    })
    expect(deps.stderr.output()).toMatch(/not installed|no launchd|run.*ralph schedule install/i)
  })

  it('aborts on non-mac platforms', async () => {
    const deps = baseDeps({ platform: 'linux' })
    await expect(scheduleResumeCommand(deps)).rejects.toMatchObject({
      exitCode: 1,
    })
  })
})

describe('scheduleStatusCommand', () => {
  const ACTIVE = {
    loaded: true,
    lastExitCode: 0,
    nextRun: { intervalSeconds: 14400 },
  }
  const NOT_LOADED = { loaded: false, lastExitCode: null, nextRun: null }

  function makeAgentEntry(overrides = {}) {
    return {
      slug: SLUG,
      label: LABEL,
      plistPath: PLIST_PATH,
      workingDirectory: REPO,
      intervalSeconds: 14400,
      ...overrides,
    }
  }

  it('prints "no agents installed" when no plists exist', async () => {
    const deps = baseDeps({
      listAgents: () => [],
      getStatus: async () => NOT_LOADED,
      peekLock: () => null,
    })
    const result = await scheduleStatusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.agents).toEqual([])
    expect(deps.stdout.output()).toMatch(/no.*agent|nothing.*installed/i)
  })

  it('shows active state when launchd reports loaded', async () => {
    const deps = baseDeps({
      listAgents: () => [makeAgentEntry()],
      getStatus: async () => ACTIVE,
      peekLock: () => null,
    })
    const result = await scheduleStatusCommand(deps)
    const out = deps.stdout.output()
    expect(result.exitCode).toBe(0)
    expect(out).toContain(LABEL)
    expect(out).toContain(REPO)
    expect(out).toMatch(/state[:\s]+active/i)
    expect(out).toMatch(/14400|4h/)
  })

  it('shows paused state when plist exists but launchd reports not-loaded', async () => {
    const deps = baseDeps({
      listAgents: () => [makeAgentEntry()],
      getStatus: async () => NOT_LOADED,
      peekLock: () => null,
    })
    await scheduleStatusCommand(deps)
    expect(deps.stdout.output()).toMatch(/state[:\s]+paused/i)
  })

  it('lists all repos when called without --here', async () => {
    const a = makeAgentEntry({
      slug: 'aaa',
      label: 'com.lucasfe.ralph.cycle.aaa',
      plistPath: `${HOME}/Library/LaunchAgents/com.lucasfe.ralph.cycle.aaa.plist`,
      workingDirectory: '/Users/me/repos/aaa',
    })
    const b = makeAgentEntry({
      slug: 'bbb',
      label: 'com.lucasfe.ralph.cycle.bbb',
      plistPath: `${HOME}/Library/LaunchAgents/com.lucasfe.ralph.cycle.bbb.plist`,
      workingDirectory: '/Users/me/repos/bbb',
    })
    const deps = baseDeps({
      listAgents: () => [a, b],
      getStatus: async () => ACTIVE,
      peekLock: () => null,
    })
    const result = await scheduleStatusCommand(deps)
    expect(result.agents).toHaveLength(2)
    const out = deps.stdout.output()
    expect(out).toContain('com.lucasfe.ralph.cycle.aaa')
    expect(out).toContain('com.lucasfe.ralph.cycle.bbb')
  })

  it('with --here shows only the current repo entry', async () => {
    const a = makeAgentEntry({
      slug: 'aaa',
      label: 'com.lucasfe.ralph.cycle.aaa',
      plistPath: `${HOME}/Library/LaunchAgents/com.lucasfe.ralph.cycle.aaa.plist`,
      workingDirectory: '/Users/me/repos/aaa',
    })
    const here = makeAgentEntry()
    const deps = baseDeps({
      here: true,
      listAgents: () => [a, here],
      getStatus: async () => ACTIVE,
      peekLock: () => null,
    })
    const result = await scheduleStatusCommand(deps)
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].slug).toBe(SLUG)
    const out = deps.stdout.output()
    expect(out).toContain(LABEL)
    expect(out).not.toContain('com.lucasfe.ralph.cycle.aaa')
  })

  it('with --here reports "not installed" when the current repo has no plist', async () => {
    const deps = baseDeps({
      here: true,
      listAgents: () => [],
      getStatus: async () => NOT_LOADED,
      peekLock: () => null,
    })
    const result = await scheduleStatusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.agents).toEqual([])
    expect(deps.stdout.output()).toMatch(/not installed/i)
    expect(deps.stdout.output()).toContain(SLUG)
  })

  it('shows active lock holder PID and age when peekLock returns a holder', async () => {
    const fixedNow = Date.parse('2026-04-29T10:05:00Z')
    const startedAt = '2026-04-29T10:00:00Z'
    const deps = baseDeps({
      listAgents: () => [makeAgentEntry()],
      getStatus: async () => ACTIVE,
      peekLock: () => ({
        holder: { pid: 4242, startedAt, repoPath: REPO },
        alive: true,
      }),
      now: () => fixedNow,
    })
    await scheduleStatusCommand(deps)
    const out = deps.stdout.output()
    expect(out).toMatch(/lock/i)
    expect(out).toContain('4242')
    expect(out).toMatch(/5\s*min/i)
  })
})

describe('scheduleRemoveCommand --all', () => {
  function entry(slug) {
    return {
      slug,
      label: `com.lucasfe.ralph.cycle.${slug}`,
      plistPath: `${HOME}/Library/LaunchAgents/com.lucasfe.ralph.cycle.${slug}.plist`,
      workingDirectory: `/Users/me/repos/${slug}`,
      intervalSeconds: 14400,
    }
  }

  it('removes every installed plist after confirmation', async () => {
    const removed = []
    const deps = baseDeps({
      all: true,
      listAgents: () => [entry('aaa'), entry('bbb')],
      confirm: async () => true,
      removeAgent: async ({ slug }) => {
        removed.push(slug)
        return {
          plistPath: `${HOME}/Library/LaunchAgents/com.lucasfe.ralph.cycle.${slug}.plist`,
          removed: true,
          unloadResult: { exitCode: 0 },
        }
      },
    })
    const result = await scheduleRemoveCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(removed.sort()).toEqual(['aaa', 'bbb'])
    expect(deps.stdout.output()).toMatch(/removed|✅/i)
  })

  it('aborts without removing anything when the user declines confirmation', async () => {
    let removeCalled = false
    const deps = baseDeps({
      all: true,
      listAgents: () => [entry('aaa')],
      confirm: async () => false,
      removeAgent: async () => {
        removeCalled = true
        return {
          plistPath: PLIST_PATH,
          removed: true,
          unloadResult: { exitCode: 0 },
        }
      },
    })
    const result = await scheduleRemoveCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.removed).toEqual([])
    expect(removeCalled).toBe(false)
    expect(deps.stdout.output()).toMatch(/abort|cancel|nothing/i)
  })

  it('exits 0 with an informational message when no plists are installed', async () => {
    let removeCalled = false
    const deps = baseDeps({
      all: true,
      listAgents: () => [],
      confirm: async () => true,
      removeAgent: async () => {
        removeCalled = true
        return { plistPath: PLIST_PATH, removed: true, unloadResult: null }
      },
    })
    const result = await scheduleRemoveCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(removeCalled).toBe(false)
    expect(deps.stdout.output()).toMatch(/no.*agent|nothing/i)
  })
})
