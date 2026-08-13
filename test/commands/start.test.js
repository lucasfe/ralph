import { describe, it, expect } from 'vitest'
import { startCommand, StartAbort } from '../../lib/commands/start.js'
import { templatePath } from '../../lib/paths.js'
import { sessionNameFor } from '../../lib/lock.js'

const RALPH_TEMPLATE = templatePath('ralph.sh')

// Per-project session name used across the suite. startCommand derives the
// session name from cwd via sessionNameFor; tests default to cwd '/repo'.
const SESSION = sessionNameFor('/repo')

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

function makeExec(handlers) {
  const calls = []
  const exec = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    if (handlers[key]) {
      const v = handlers[key]
      return typeof v === 'function' ? v() : v
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

const baseDeps = () => ({
  cwd: '/repo',
  stdout: makeStream(),
  stderr: makeStream(),
  stdin: process.stdin,
  exists: () => false,
  loadEnv: () => ({}),
  hasCommand: () => true,
  ask: async () => false,
})

describe('startCommand', () => {
  it('aborts when this project tmux session already exists', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
    expect(deps.stderr.output()).toContain(`tmux session '${SESSION}' already exists.`)
    // The error hint prints the per-project attach / kill commands.
    expect(deps.stdout.output()).toContain(`tmux attach -t ${SESSION}`)
    expect(deps.stdout.output()).toContain(`tmux kill-session -t ${SESSION}`)
  })

  it('uses the per-project derived session name, not the literal "ralph"', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
    // The uniqueness check targets the derived name and never the literal "ralph".
    expect(deps.exec.calls).toContain(`tmux has-session -t ${SESSION}`)
    expect(deps.exec.calls.some((c) => c === 'tmux has-session -t ralph')).toBe(false)
  })

  it('is not blocked when only another project’s session exists', async () => {
    const deps = baseDeps()
    // Another project's session ("ralph-other-...") is present; ours is not.
    // has-session for OUR derived name returns non-zero, so start proceeds past
    // the uniqueness check even though some other session exists.
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      [`tmux has-session -t ${sessionNameFor('/other-project')}`]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '0', stderr: '' },
    })
    const result = await startCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stderr.output()).not.toContain('already exists')
  })

  it('aborts when a critical command is missing', async () => {
    const deps = baseDeps()
    deps.hasCommand = (cmd) => cmd !== 'git'
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
    })
    await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
    expect(deps.stderr.output()).toContain("❌ 'git' not found in PATH")
  })

  it('warns but does not abort when a non-critical command is missing', async () => {
    const deps = baseDeps()
    deps.hasCommand = (cmd) => cmd !== 'jq'
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '0', stderr: '' },
    })
    const result = await startCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stdout.output()).toContain("⚠️  'jq' not found (optional)")
  })

  it('aborts when gh auth status fails', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 1, stdout: '', stderr: '' },
    })
    await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
    expect(deps.stderr.output()).toContain('gh not authenticated')
  })

  it('aborts when .mcp.json is invalid', async () => {
    const deps = baseDeps()
    deps.exists = (p) => p.endsWith('.mcp.json')
    const workSession = sessionNameFor('/work')
    deps.exec = makeExec({
      [`tmux has-session -t ${workSession}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'jq -e . /work/.mcp.json': { exitCode: 1, stdout: '', stderr: '' },
    })
    await expect(startCommand({ ...deps, cwd: '/work' })).rejects.toBeInstanceOf(StartAbort)
    expect(deps.stderr.output()).toContain('.mcp.json has invalid JSON')
  })

  it('exits 0 without launching when queue is empty', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '0', stderr: '' },
    })
    const result = await startCommand(deps)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(deps.stdout.output()).toContain('No issues in the queue')
    expect(deps.exec.calls.some((c) => c.startsWith(`tmux new -d -s ${SESSION}`))).toBe(false)
  })

  it('launches tmux when queue has issues, with the derived name and RALPH_TMUX_SESSION injected', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '3', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    const result = await startCommand({ ...deps, cwd })
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(deps.stdout.output()).toContain('Ralph started in background. 3 issues in the queue.')
    // The launch targets the derived name and injects RALPH_TMUX_SESSION into the loop env.
    expect(deps.exec.calls).toContain(launchKey)
    // Success message prints the per-project attach / kill commands.
    expect(deps.stdout.output()).toContain(`tmux attach -t ${SESSION}`)
    expect(deps.stdout.output()).toContain(`tmux kill-session -t ${SESSION}`)
  })

  it('injects RALPH_TMUX_SESSION matching the cwd-derived name for a different project', async () => {
    const deps = baseDeps()
    const cwd = '/other-project'
    const session = sessionNameFor(cwd)
    const launchKey = `tmux new -d -s ${session} cd '${cwd}' && RALPH_TMUX_SESSION='${session}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${session}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      [launchKey]: { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await startCommand({ ...deps, cwd })
    expect(result.started).toBe(true)
    expect(deps.exec.calls).toContain(launchKey)
    expect(session).not.toBe(SESSION)
  })

  it('warns about orphan claude-working labels and never removes them automatically', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '  #42 stuck\n  #43 also stuck',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '0', stderr: '' },
    })
    await startCommand(deps)
    expect(deps.stdout.output()).toContain("⚠️  Issues with the 'claude-working' label")
    expect(deps.stdout.output()).toContain('Keeping labels')
    expect(deps.stdout.output()).toContain('gh issue edit <n> --remove-label claude-working')
    expect(deps.exec.calls.some((c) => c.includes('--remove-label'))).toBe(false)
  })

  it('prints update warning and persists last_seen_release when newer version is available', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    const writes = []
    deps.currentVersion = '0.1.0'
    deps.readSt = () => ({ last_seen_release: '', detected_stack: 'npm' })
    deps.writeSt = (root, obj) => writes.push({ root, obj })
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      'npm view @lucasfe/ralph version': { exitCode: 0, stdout: '0.2.0\n', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    await startCommand({ ...deps, cwd })
    expect(deps.stdout.output()).toContain('New version available: 0.2.0')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({
      root: cwd,
      obj: { last_seen_release: '0.2.0', detected_stack: 'npm' },
    })
  })

  it('skips update check entirely when state.json is missing', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    const writes = []
    deps.currentVersion = '0.1.0'
    deps.readSt = () => null
    deps.writeSt = (root, obj) => writes.push({ root, obj })
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    await startCommand({ ...deps, cwd })
    expect(writes).toHaveLength(0)
    expect(deps.exec.calls.some((c) => c.startsWith('npm view'))).toBe(false)
  })

  it('sends WhatsApp startup notification with default message when credentials are present', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    deps.exists = (p) => p.endsWith('.env.local')
    deps.loadEnv = () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' })
    const waCalls = []
    deps.sendWa = async (args) => {
      waCalls.push(args)
      return { ok: true }
    }
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '2', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    await startCommand({ ...deps, cwd })
    expect(waCalls).toHaveLength(1)
    expect(waCalls[0]).toEqual({
      phone: '+1',
      apiKey: 'k',
      message: '🟢 Ralph started and is active.',
    })
    expect(deps.stdout.output()).toContain('Startup WhatsApp notification sent.')
  })

  it('uses RALPH_STARTUP_MESSAGE override from .env.local when provided', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    deps.exists = (p) => p.endsWith('.env.local')
    deps.loadEnv = () => ({
      CALLMEBOT_KEY: 'k',
      WHATSAPP_PHONE: '+1',
      RALPH_STARTUP_MESSAGE: 'custom hello',
    })
    const waCalls = []
    deps.sendWa = async (args) => {
      waCalls.push(args)
      return { ok: true }
    }
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    await startCommand({ ...deps, cwd })
    expect(waCalls[0].message).toBe('custom hello')
  })

  it('skips WhatsApp startup notification when credentials are missing', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    let waCalled = false
    deps.sendWa = async () => {
      waCalled = true
      return { ok: true }
    }
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    const savedKey = process.env.CALLMEBOT_KEY
    const savedPhone = process.env.WHATSAPP_PHONE
    delete process.env.CALLMEBOT_KEY
    delete process.env.WHATSAPP_PHONE
    try {
      await startCommand({ ...deps, cwd })
    } finally {
      if (savedKey !== undefined) process.env.CALLMEBOT_KEY = savedKey
      if (savedPhone !== undefined) process.env.WHATSAPP_PHONE = savedPhone
    }
    expect(waCalled).toBe(false)
    expect(deps.stdout.output()).toContain('WhatsApp notifications will be skipped')
  })

  it('logs a warning but does not abort when WhatsApp startup notification fails', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    deps.exists = (p) => p.endsWith('.env.local')
    deps.loadEnv = () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' })
    deps.sendWa = async () => ({ ok: false, reason: 'http_500' })
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    const result = await startCommand({ ...deps, cwd })
    expect(result.started).toBe(true)
    expect(deps.stdout.output()).toContain('Startup WhatsApp notification failed: http_500')
  })

  it('does not print warning or write state when remote version is not newer', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    const writes = []
    deps.currentVersion = '0.2.0'
    deps.readSt = () => ({ last_seen_release: '' })
    deps.writeSt = (root, obj) => writes.push({ root, obj })
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      'npm view @lucasfe/ralph version': { exitCode: 0, stdout: '0.1.0\n', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    await startCommand({ ...deps, cwd })
    expect(deps.stdout.output()).not.toContain('New version available')
    expect(writes).toHaveLength(0)
  })

  describe('cycle-lock coexistence', () => {
    it('aborts when an alive cycle lock is held', async () => {
      const deps = baseDeps()
      const cwd = '/repo'
      const peekCalls = []
      deps.peekLock = (repoPath) => {
        peekCalls.push(repoPath)
        return {
          holder: {
            pid: 9999,
            startedAt: '2026-04-29T00:00:00.000Z',
            repoPath: cwd,
          },
          alive: true,
        }
      }
      deps.now = () => Date.parse('2026-04-29T02:00:00.000Z')
      deps.exec = makeExec({
        [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      })
      await expect(startCommand({ ...deps, cwd })).rejects.toBeInstanceOf(StartAbort)
      expect(peekCalls).toHaveLength(1)
      expect(peekCalls[0]).toBe(cwd)
      const errOut = deps.stderr.output()
      expect(errOut).toContain('⏸️ Cycle in progress')
      expect(errOut).toContain('PID 9999')
      expect(errOut).toContain('2h')
      expect(errOut).toContain('ralph schedule pause')
      expect(deps.exec.calls.some((c) => c.startsWith('gh auth status'))).toBe(false)
      expect(deps.exec.calls.some((c) => c.startsWith(`tmux new -d -s ${SESSION}`))).toBe(false)
    })

    it('proceeds when the cycle lock holder is stale (alive=false)', async () => {
      const deps = baseDeps()
      const cwd = '/repo'
      deps.peekLock = () => ({
        holder: {
          pid: 4242,
          startedAt: '2025-01-01T00:00:00.000Z',
          repoPath: cwd,
        },
        alive: false,
      })
      deps.exec = makeExec({
        [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
        'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
        'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '0', stderr: '' },
      })
      const result = await startCommand({ ...deps, cwd })
      expect(result.exitCode).toBe(0)
      expect(deps.stderr.output()).not.toContain('Cycle in progress')
    })

    it('proceeds normally when no cycle lock is held', async () => {
      const deps = baseDeps()
      const cwd = '/repo'
      deps.peekLock = () => null
      deps.exec = makeExec({
        [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
        'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
        'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '0', stderr: '' },
      })
      const result = await startCommand({ ...deps, cwd })
      expect(result.exitCode).toBe(0)
      expect(deps.stderr.output()).not.toContain('Cycle in progress')
    })

    it('uses peekLock (read-only) and never acquires the lock', async () => {
      const deps = baseDeps()
      const cwd = '/repo'
      let acquireCalled = false
      deps.peekLock = () => null
      deps.acquireLock = () => {
        acquireCalled = true
        return { acquired: true, holder: { pid: 1, startedAt: '', repoPath: cwd } }
      }
      deps.exec = makeExec({
        [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
        'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
        'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '0', stderr: '' },
      })
      await startCommand({ ...deps, cwd })
      expect(acquireCalled).toBe(false)
    })

    it('does not send a WhatsApp notification on the alive-lock abort path', async () => {
      const deps = baseDeps()
      const cwd = '/repo'
      let waCalled = false
      deps.exists = (p) => p.endsWith('.env.local')
      deps.loadEnv = () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' })
      deps.sendWa = async () => {
        waCalled = true
        return { ok: true }
      }
      deps.peekLock = () => ({
        holder: {
          pid: 1234,
          startedAt: '2026-04-29T00:00:00.000Z',
          repoPath: cwd,
        },
        alive: true,
      })
      deps.now = () => Date.parse('2026-04-29T01:00:00.000Z')
      deps.exec = makeExec({
        [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      })
      await expect(startCommand({ ...deps, cwd })).rejects.toBeInstanceOf(StartAbort)
      expect(waCalled).toBe(false)
    })
  })
})
