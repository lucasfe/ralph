import { describe, it, expect } from 'vitest'
import { cycleCommand } from './cycle.js'

const REPO = '/repo'
const REPO_SLUG = 'lucasfe/agenthub'

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

function makeWa() {
  const messages = []
  const sendWa = async ({ message }) => {
    messages.push(message)
    return { ok: true }
  }
  sendWa.messages = messages
  return sendWa
}

function makePing() {
  const calls = []
  const fn = async (opts) => {
    calls.push(opts)
    return { ok: true }
  }
  fn.calls = calls
  return fn
}

const baseHandlers = () => ({
  'git rev-parse --show-toplevel': { exitCode: 0, stdout: `${REPO}\n`, stderr: '' },
  'tmux has-session -t ralph': { exitCode: 1, stdout: '', stderr: '' },
  'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
  'gh repo view --json nameWithOwner -q .nameWithOwner': {
    exitCode: 0,
    stdout: `${REPO_SLUG}\n`,
    stderr: '',
  },
})

const baseDeps = (overrides = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const sendWa = makeWa()
  const pingSuccess = makePing()
  const pingFail = makePing()
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec: makeExec(baseHandlers()),
    exists: () => true,
    loadEnv: () => ({
      CALLMEBOT_KEY: 'k',
      WHATSAPP_PHONE: '+1',
      HEALTHCHECK_URL: 'https://hc-ping.com/x',
    }),
    acquireLock: () => ({ acquired: true, holder: { pid: 1, startedAt: '2026-04-29T00:00:00.000Z', repoPath: REPO } }),
    releaseLock: () => {},
    findOrphans: async () => [],
    cleanupOrphans: async () => [],
    sendWa,
    pingSuccess,
    pingFail,
    runQueueOnce: async () => ({ successes: [], failures: [] }),
    now: () => Date.parse('2026-04-29T00:30:00.000Z'),
    ...overrides,
  }
}

describe('cycleCommand — tmux active', () => {
  it('exits 0 silently when ralph tmux session is already running', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      'tmux has-session -t ralph': { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await cycleCommand(deps)
    expect(result).toEqual({
      exitCode: 0,
      status: 'tmux-active',
      processed: 0,
      skipped: true,
    })
    expect(deps.sendWa.messages).toEqual([])
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh auth status'))).toBe(false)
  })
})

describe('cycleCommand — preflight failure', () => {
  it('returns preflight-failed and notifies WhatsApp when gh auth is broken', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh auth status': { exitCode: 1, stdout: '', stderr: 'not authenticated' },
    })
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(result.status).toBe('preflight-failed')
    expect(deps.sendWa.messages.length).toBeGreaterThan(0)
    expect(deps.sendWa.messages[0]).toMatch(/abort/i)
  })

  it('returns preflight-failed when ralph.config.sh is missing', async () => {
    const deps = baseDeps()
    deps.exists = (path) => !path.endsWith('ralph.config.sh')
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(result.status).toBe('preflight-failed')
    expect(result.reason).toMatch(/ralph\.config\.sh/)
  })

  it('returns preflight-failed when .ralph/state.json is missing', async () => {
    const deps = baseDeps()
    deps.exists = (path) => !path.endsWith('state.json')
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(result.status).toBe('preflight-failed')
    expect(result.reason).toMatch(/state\.json/)
  })

  it('returns preflight-failed when claude credentials file is missing', async () => {
    const deps = baseDeps()
    deps.exists = (path) => !path.includes('.claude')
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(result.status).toBe('preflight-failed')
    expect(result.reason).toMatch(/claude/i)
  })
})

describe('cycleCommand — lock held', () => {
  it('returns lock-held and notifies skipped when another instance holds the lock', async () => {
    const deps = baseDeps({
      acquireLock: () => ({
        acquired: false,
        holder: {
          pid: 9999,
          startedAt: '2026-04-29T00:00:00.000Z',
          repoPath: REPO,
        },
      }),
    })
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('lock-held')
    expect(result.skipped).toBe(true)
    expect(deps.sendWa.messages.length).toBe(1)
    expect(deps.sendWa.messages[0]).toMatch(/skip/i)
  })

  it('does not call runQueueOnce when lock is held', async () => {
    let queueCalled = false
    const deps = baseDeps({
      acquireLock: () => ({
        acquired: false,
        holder: { pid: 9999, startedAt: '2026-04-29T00:00:00.000Z', repoPath: REPO },
      }),
      runQueueOnce: async () => {
        queueCalled = true
        return { successes: [], failures: [] }
      },
    })
    await cycleCommand(deps)
    expect(queueCalled).toBe(false)
  })
})

describe('cycleCommand — orphans cleared', () => {
  it('runs cleanupOrphans and notifies aggregated when orphans existed', async () => {
    const deps = baseDeps({
      findOrphans: async () => [
        { number: 12, title: 'a', updatedAt: '2026-04-28T00:00:00Z' },
        { number: 34, title: 'b', updatedAt: '2026-04-28T01:00:00Z' },
      ],
      cleanupOrphans: async () => [12, 34],
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    const orphanMsg = deps.sendWa.messages.find((m) => /orphan|limpou|cleared/i.test(m))
    expect(orphanMsg).toBeDefined()
    expect(orphanMsg).toMatch(/12/)
    expect(orphanMsg).toMatch(/34/)
  })

  it('does not notify orphan summary when no orphans were cleared', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    expect(deps.sendWa.messages.find((m) => /orphan|limpou|cleared/i.test(m))).toBeUndefined()
  })
})

describe('cycleCommand — queue empty', () => {
  it('exits 0 silently and releases the lock when queue has 0 issues', async () => {
    let released = false
    const deps = baseDeps({ releaseLock: () => { released = true } })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result).toMatchObject({
      exitCode: 0,
      status: 'queue-empty',
      processed: 0,
      skipped: true,
    })
    expect(deps.sendWa.messages).toEqual([])
    expect(released).toBe(true)
  })
})

describe('cycleCommand — success path', () => {
  it('sends start + end WhatsApp, runs queue, pings success, releases lock', async () => {
    let released = false
    const deps = baseDeps({
      releaseLock: () => { released = true },
      runQueueOnce: async () => ({ successes: [101, 102], failures: [] }),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '2',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('success')
    expect(result.processed).toBe(2)
    expect(deps.sendWa.messages.length).toBe(2)
    expect(deps.sendWa.messages[0]).toMatch(/cycle started/i)
    expect(deps.sendWa.messages[0]).toMatch(/2 issues/)
    expect(deps.sendWa.messages[0]).toMatch(REPO_SLUG)
    expect(deps.sendWa.messages[1]).toMatch(/finalizado|finished|done/i)
    expect(deps.sendWa.messages[1]).toMatch(/2 ok/i)
    expect(deps.pingSuccess.calls.length).toBe(1)
    expect(deps.pingFail.calls.length).toBe(0)
    expect(released).toBe(true)
  })

  it('reports partial status when some issues failed', async () => {
    const deps = baseDeps({
      runQueueOnce: async () => ({ successes: [101], failures: [102] }),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '2',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('partial')
    expect(deps.pingSuccess.calls.length).toBe(1)
    expect(deps.pingFail.calls.length).toBe(0)
  })

  it('reports failed status and pings fail when every issue failed', async () => {
    const deps = baseDeps({
      runQueueOnce: async () => ({ successes: [], failures: [101] }),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('failed')
    expect(deps.pingSuccess.calls.length).toBe(0)
    expect(deps.pingFail.calls.length).toBe(1)
  })
})

describe('cycleCommand — best-effort failures never abort the cycle', () => {
  it('still returns success when WhatsApp send throws', async () => {
    const deps = baseDeps({
      sendWa: async () => {
        throw new Error('callmebot down')
      },
      runQueueOnce: async () => ({ successes: [101], failures: [] }),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('success')
  })

  it('still returns success when pingSuccess throws', async () => {
    const deps = baseDeps({
      pingSuccess: async () => {
        throw new Error('hc down')
      },
      runQueueOnce: async () => ({ successes: [101], failures: [] }),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('success')
  })

  it('still releases the lock when runQueueOnce throws', async () => {
    let released = false
    const deps = baseDeps({
      releaseLock: () => { released = true },
      runQueueOnce: async () => {
        throw new Error('queue blew up')
      },
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    await expect(cycleCommand(deps)).rejects.toThrow(/queue blew up/)
    expect(released).toBe(true)
  })

  it('skips healthcheck silently when HEALTHCHECK_URL is missing', async () => {
    const deps = baseDeps({
      loadEnv: () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' }),
      runQueueOnce: async () => ({ successes: [101], failures: [] }),
      processEnv: {},
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('success')
    expect(deps.pingSuccess.calls.length).toBe(0)
    expect(deps.pingFail.calls.length).toBe(0)
  })

  it('skips WhatsApp silently when CALLMEBOT_KEY/WHATSAPP_PHONE are missing', async () => {
    const deps = baseDeps({
      loadEnv: () => ({}),
      runQueueOnce: async () => ({ successes: [101], failures: [] }),
      processEnv: {},
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('success')
    expect(deps.sendWa.messages).toEqual([])
  })
})

describe('cycleCommand — RALPH_CYCLE_EVENT log line', () => {
  function readEvent(stdout) {
    const text = stdout.output()
    const idx = text.indexOf('RALPH_CYCLE_EVENT ')
    if (idx === -1) return null
    const lineEnd = text.indexOf('\n', idx)
    const line = text.slice(idx, lineEnd === -1 ? text.length : lineEnd)
    const jsonPart = line.slice('RALPH_CYCLE_EVENT '.length).trim()
    return JSON.parse(jsonPart)
  }

  it('emits status=success with ts/ok/failed/durationMin/processed on the success path', async () => {
    const deps = baseDeps({
      runQueueOnce: async () => ({ successes: [101, 102], failures: [] }),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '2',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    expect(event.status).toBe('success')
    expect(event.ok).toBe(2)
    expect(event.failed).toBe(0)
    expect(event.processed).toBe(2)
    expect(typeof event.ts).toBe('string')
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('emits status=tmux-active when tmux session is already running', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      'tmux has-session -t ralph': { exitCode: 0, stdout: '', stderr: '' },
    })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    expect(event.status).toBe('tmux-active')
  })

  it('emits status=lock-held when another instance holds the lock', async () => {
    const deps = baseDeps({
      acquireLock: () => ({
        acquired: false,
        holder: { pid: 9999, startedAt: '2026-04-29T00:00:00.000Z', repoPath: REPO },
      }),
    })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    expect(event.status).toBe('lock-held')
    expect(event.holderPid).toBe(9999)
  })

  it('emits status=preflight-failed when preflight rejects', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh auth status': { exitCode: 1, stdout: '', stderr: 'not authenticated' },
    })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    expect(event.status).toBe('preflight-failed')
  })

  it('emits status=queue-empty when no issues are queued', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    expect(event.status).toBe('queue-empty')
  })

  it('emits status=failed when every issue failed', async () => {
    const deps = baseDeps({
      runQueueOnce: async () => ({ successes: [], failures: [101] }),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    expect(event.status).toBe('failed')
    expect(event.ok).toBe(0)
    expect(event.failed).toBe(1)
  })
})
