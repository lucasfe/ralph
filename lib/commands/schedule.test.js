import { describe, it, expect } from 'vitest'
import {
  parseHeartbeatTime,
  parseInterval,
  scheduleHeartbeatCommand,
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
  function trackInstalls() {
    const calls = []
    const installAgent = async (args) => {
      calls.push(args)
      const kind = args.kind ?? 'cycle'
      const label =
        kind === 'cycle'
          ? `com.lucasfe.ralph.cycle.${args.slug}`
          : `com.lucasfe.ralph.heartbeat.${args.slug}`
      const plistPath = `${HOME}/Library/LaunchAgents/${label}.plist`
      return { plistPath, label, kind, loadResult: { exitCode: 0 } }
    }
    installAgent.calls = calls
    return installAgent
  }

  it('computes slug from repo basename and installs both cycle and heartbeat agents', async () => {
    const installAgent = trackInstalls()
    const deps = baseDeps({
      exists: (p) => !p.endsWith('.plist'), // no existing plist
      installAgent,
    })
    const result = await scheduleInstallCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.slug).toBe(SLUG)
    expect(installAgent.calls).toHaveLength(2)
    const cycleCall = installAgent.calls.find((c) => c.kind === 'cycle')
    const heartbeatCall = installAgent.calls.find((c) => c.kind === 'heartbeat')
    expect(cycleCall).toBeDefined()
    expect(cycleCall.slug).toBe(SLUG)
    expect(cycleCall.workingDirectory).toBe(REPO)
    expect(cycleCall.command).toBe('/usr/local/bin/ralph')
    expect(cycleCall.args).toEqual(['cycle'])
    expect(cycleCall.intervalSeconds).toBe(14400)
    expect(cycleCall.logDir).toBe(`${REPO}/logs`)
    expect(heartbeatCall).toBeDefined()
    expect(heartbeatCall.args).toEqual(['schedule', 'heartbeat'])
    expect(heartbeatCall.startCalendarInterval).toEqual({ hour: 9, minute: 0 })
    expect(result.heartbeat.label).toBe(`com.lucasfe.ralph.heartbeat.${SLUG}`)
  })

  it('honors a custom --interval flag for the cycle plist', async () => {
    const installAgent = trackInstalls()
    const deps = baseDeps({
      exists: (p) => !p.endsWith('.plist'),
      interval: '30m',
      installAgent,
    })
    await scheduleInstallCommand(deps)
    const cycleCall = installAgent.calls.find((c) => c.kind === 'cycle')
    expect(cycleCall.intervalSeconds).toBe(1800)
  })

  it('honors RALPH_DAILY_SUMMARY_TIME for the heartbeat plist', async () => {
    const installAgent = trackInstalls()
    const deps = baseDeps({
      exists: (p) => !p.endsWith('.plist'),
      processEnv: { RALPH_DAILY_SUMMARY_TIME: '07:30' },
      installAgent,
    })
    await scheduleInstallCommand(deps)
    const heartbeatCall = installAgent.calls.find((c) => c.kind === 'heartbeat')
    expect(heartbeatCall.startCalendarInterval).toEqual({ hour: 7, minute: 30 })
  })

  it('prints a success summary on stdout listing both plists', async () => {
    const deps = baseDeps({
      exists: (p) => !p.endsWith('.plist'),
      installAgent: trackInstalls(),
    })
    await scheduleInstallCommand(deps)
    const output = deps.stdout.output()
    expect(output).toMatch(/installed|✅/i)
    expect(output).toContain(`com.lucasfe.ralph.cycle.${SLUG}`)
    expect(output).toContain(`com.lucasfe.ralph.heartbeat.${SLUG}`)
    expect(output).toMatch(/daily at 09:00/i)
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

describe('parseHeartbeatTime', () => {
  it('parses HH:MM into {hour, minute}', () => {
    expect(parseHeartbeatTime('09:00')).toEqual({ hour: 9, minute: 0 })
    expect(parseHeartbeatTime('23:59')).toEqual({ hour: 23, minute: 59 })
    expect(parseHeartbeatTime('7:30')).toEqual({ hour: 7, minute: 30 })
  })

  it('uses 09:00 as default when input is null/undefined', () => {
    expect(parseHeartbeatTime(undefined)).toEqual({ hour: 9, minute: 0 })
    expect(parseHeartbeatTime(null)).toEqual({ hour: 9, minute: 0 })
  })

  it('rejects invalid formats and out-of-range values', () => {
    expect(() => parseHeartbeatTime('foo')).toThrow()
    expect(() => parseHeartbeatTime('25:00')).toThrow()
    expect(() => parseHeartbeatTime('12:60')).toThrow()
    expect(() => parseHeartbeatTime('12')).toThrow()
  })
})

describe('scheduleInstallCommand — dual plist', () => {
  it('passes --force through to remove BOTH existing plists before install', async () => {
    const removeCalls = []
    const deps = baseDeps({
      exists: () => true,
      force: true,
      removeAgent: async (args) => {
        removeCalls.push(args.kind ?? 'cycle')
        return {
          plistPath: PLIST_PATH,
          kind: args.kind ?? 'cycle',
          removed: true,
          unloadResult: { exitCode: 0 },
        }
      },
      installAgent: async (args) => ({
        plistPath: `${HOME}/Library/LaunchAgents/x.plist`,
        label: 'x',
        kind: args.kind ?? 'cycle',
        loadResult: { exitCode: 0 },
      }),
    })
    await scheduleInstallCommand(deps)
    expect(removeCalls.sort()).toEqual(['cycle', 'heartbeat'])
  })
})

describe('scheduleRemoveCommand — dual plist', () => {
  it('removes both cycle and heartbeat plists when both exist', async () => {
    const removed = []
    const deps = baseDeps({
      exists: () => true,
      removeAgent: async (args) => {
        removed.push(args.kind ?? 'cycle')
        return {
          plistPath: PLIST_PATH,
          kind: args.kind ?? 'cycle',
          removed: true,
          unloadResult: { exitCode: 0 },
        }
      },
    })
    const result = await scheduleRemoveCommand(deps)
    expect(removed.sort()).toEqual(['cycle', 'heartbeat'])
    expect(result.exitCode).toBe(0)
    expect(result.cycle.removed).toBe(true)
    expect(result.heartbeat.removed).toBe(true)
  })

  it('removes only the heartbeat plist when the cycle plist is missing', async () => {
    const removed = []
    const heartbeatPath = `${HOME}/Library/LaunchAgents/com.lucasfe.ralph.heartbeat.${SLUG}.plist`
    const deps = baseDeps({
      exists: (p) => p === heartbeatPath,
      removeAgent: async (args) => {
        removed.push(args.kind ?? 'cycle')
        return {
          plistPath: heartbeatPath,
          kind: 'heartbeat',
          removed: true,
          unloadResult: { exitCode: 0 },
        }
      },
    })
    const result = await scheduleRemoveCommand(deps)
    expect(removed).toEqual(['heartbeat'])
    expect(result.cycle.removed).toBe(false)
    expect(result.heartbeat.removed).toBe(true)
  })
})

describe('schedulePauseCommand — dual plist', () => {
  it('pauses both cycle and heartbeat agents when both plists exist', async () => {
    const paused = []
    const deps = baseDeps({
      exists: () => true,
      pauseAgent: async (args) => {
        paused.push(args.kind ?? 'cycle')
        return {
          plistPath: PLIST_PATH,
          kind: args.kind ?? 'cycle',
          paused: true,
          unloadResult: { exitCode: 0 },
        }
      },
    })
    const result = await schedulePauseCommand(deps)
    expect(paused.sort()).toEqual(['cycle', 'heartbeat'])
    expect(result.cycle.paused).toBe(true)
    expect(result.heartbeat.paused).toBe(true)
  })
})

describe('scheduleResumeCommand — dual plist', () => {
  it('resumes both cycle and heartbeat agents when both plists exist', async () => {
    const resumed = []
    const deps = baseDeps({
      exists: () => true,
      resumeAgent: async (args) => {
        resumed.push(args.kind ?? 'cycle')
        return {
          plistPath: PLIST_PATH,
          kind: args.kind ?? 'cycle',
          resumed: true,
          loadResult: { exitCode: 0 },
        }
      },
    })
    const result = await scheduleResumeCommand(deps)
    expect(resumed.sort()).toEqual(['cycle', 'heartbeat'])
    expect(result.cycle.resumed).toBe(true)
    expect(result.heartbeat.resumed).toBe(true)
  })
})

describe('scheduleStatusCommand — dual plist', () => {
  it('renders both cycle and heartbeat agent blocks', async () => {
    const cycleEntry = {
      slug: SLUG,
      label: `com.lucasfe.ralph.cycle.${SLUG}`,
      plistPath: PLIST_PATH,
      kind: 'cycle',
      workingDirectory: REPO,
      intervalSeconds: 14400,
    }
    const heartbeatEntry = {
      slug: SLUG,
      label: `com.lucasfe.ralph.heartbeat.${SLUG}`,
      plistPath: `${HOME}/Library/LaunchAgents/com.lucasfe.ralph.heartbeat.${SLUG}.plist`,
      kind: 'heartbeat',
      workingDirectory: REPO,
      intervalSeconds: null,
      startCalendarInterval: { hour: 9, minute: 0 },
    }
    const deps = baseDeps({
      listAgents: () => [cycleEntry, heartbeatEntry],
      getStatus: async () => ({
        loaded: true,
        lastExitCode: 0,
        nextRun: null,
      }),
      peekLock: () => null,
    })
    const result = await scheduleStatusCommand(deps)
    expect(result.agents).toHaveLength(2)
    const out = deps.stdout.output()
    expect(out).toContain(`com.lucasfe.ralph.cycle.${SLUG}`)
    expect(out).toContain(`com.lucasfe.ralph.heartbeat.${SLUG}`)
    expect(out).toMatch(/daily at 09:00/)
  })
})

describe('scheduleHeartbeatCommand', () => {
  function makeFs(files = {}) {
    const dirs = new Set()
    for (const path of Object.keys(files)) {
      let parent = path
      while (parent.includes('/')) {
        parent = parent.slice(0, parent.lastIndexOf('/'))
        dirs.add(parent)
      }
    }
    return {
      existsSync: (p) =>
        Object.prototype.hasOwnProperty.call(files, p) || dirs.has(p),
      readFileSync: (p) => {
        if (!Object.prototype.hasOwnProperty.call(files, p)) {
          const err = new Error(`ENOENT: ${p}`)
          err.code = 'ENOENT'
          throw err
        }
        return files[p]
      },
      readdirSync: (p) => {
        const prefix = p.endsWith('/') ? p : `${p}/`
        const entries = new Set()
        for (const k of Object.keys(files)) {
          if (k.startsWith(prefix)) {
            entries.add(k.slice(prefix.length).split('/')[0])
          }
        }
        return Array.from(entries).sort()
      },
    }
  }

  function heartbeatBaseDeps(overrides = {}) {
    const stdout = makeStream()
    const stderr = makeStream()
    const sendWaCalls = []
    const sendWa = async (args) => {
      sendWaCalls.push(args)
      return { ok: true }
    }
    sendWa.calls = sendWaCalls
    return {
      cwd: REPO,
      stdout,
      stderr,
      home: HOME,
      platform: 'mac',
      processEnv: {
        CALLMEBOT_KEY: 'k',
        WHATSAPP_PHONE: '+1',
        RALPH_DAILY_SUMMARY_TIME: '09:00',
      },
      loadEnv: () => ({}),
      exists: () => true,
      exec: makeExec(baseHandlers()),
      sendWa,
      summarize: () => ({
        cycles: 6,
        totalIssues: 12,
        ok: 10,
        failed: 2,
        abortedCycles: 0,
        durations: [],
        lastCycle: null,
      }),
      format: (summary, { repoSlug, nextTick }) =>
        `📊 Ralph 24h | ${summary.cycles} cycles, ${summary.totalIssues} issues (${summary.ok} ok, ${summary.failed} fail) | ${repoSlug} | next ${nextTick}`,
      listAgents: () => [],
      clock: () => Date.parse('2026-04-29T12:00:00Z'),
      ...overrides,
    }
  }

  it('summarizes the last 24h and sends the formatted message via WhatsApp', async () => {
    const deps = heartbeatBaseDeps()
    const result = await scheduleHeartbeatCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.sendWa.calls).toHaveLength(1)
    expect(deps.sendWa.calls[0].message).toMatch(/Ralph 24h/)
    expect(deps.sendWa.calls[0].message).toMatch(/6 cycles/)
    expect(deps.sendWa.calls[0].message).toMatch(/next 09:00/)
    expect(deps.sendWa.calls[0].phone).toBe('+1')
    expect(deps.sendWa.calls[0].apiKey).toBe('k')
  })

  it('skips WhatsApp send when CALLMEBOT_KEY/WHATSAPP_PHONE are missing', async () => {
    const deps = heartbeatBaseDeps({ processEnv: { RALPH_DAILY_SUMMARY_TIME: '09:00' } })
    const result = await scheduleHeartbeatCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.sendWa.calls).toEqual([])
  })

  it('falls back to a failure message when summarize throws', async () => {
    const deps = heartbeatBaseDeps({
      summarize: () => {
        throw new Error('disk full')
      },
    })
    const result = await scheduleHeartbeatCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.message).toMatch(/❌ Ralph 24h summary failed/)
    expect(result.message).toMatch(/disk full/)
    expect(deps.sendWa.calls[0].message).toMatch(/❌/)
    expect(deps.stderr.output()).toMatch(/disk full/)
  })

  it('aborts on non-mac platforms', async () => {
    const deps = heartbeatBaseDeps({ platform: 'linux' })
    await expect(scheduleHeartbeatCommand(deps)).rejects.toMatchObject({
      exitCode: 1,
    })
  })
})
