import { describe, it, expect } from 'vitest'
import { startCommand, StartAbort } from '../../lib/commands/start.js'
import { templatePath } from '../../lib/paths.js'

const RALPH_TEMPLATE = templatePath('ralph.sh')

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
  stdout: makeStream(),
  stderr: makeStream(),
  stdin: process.stdin,
  exists: () => false,
  loadEnv: () => ({}),
  hasCommand: () => true,
  ask: async () => false,
})

describe('startCommand', () => {
  it('aborts when tmux ralph session already exists', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 0, stdout: '', stderr: '' },
    })
    await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
    expect(deps.stderr.output()).toContain("Sessão tmux 'ralph' já existe.")
  })

  it('aborts when a critical command is missing', async () => {
    const deps = baseDeps()
    deps.hasCommand = (cmd) => cmd !== 'git'
    deps.exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 1, stdout: '', stderr: '' },
    })
    await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
    expect(deps.stderr.output()).toContain("❌ 'git' não encontrado no PATH")
  })

  it('warns but does not abort when a non-critical command is missing', async () => {
    const deps = baseDeps()
    deps.hasCommand = (cmd) => cmd !== 'jq'
    deps.exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '0', stderr: '' },
    })
    const result = await startCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stdout.output()).toContain("⚠️  'jq' não encontrado (opcional)")
  })

  it('aborts when gh auth status fails', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 1, stdout: '', stderr: '' },
    })
    await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
    expect(deps.stderr.output()).toContain('gh não autenticado')
  })

  it('aborts when .mcp.json is invalid', async () => {
    const deps = baseDeps()
    deps.exists = (p) => p.endsWith('.mcp.json')
    deps.exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'jq -e . /work/.mcp.json': { exitCode: 1, stdout: '', stderr: '' },
    })
    await expect(startCommand({ ...deps, cwd: '/work' })).rejects.toBeInstanceOf(StartAbort)
    expect(deps.stderr.output()).toContain('.mcp.json com JSON inválido')
  })

  it('exits 0 without launching when queue is empty', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '0', stderr: '' },
    })
    const result = await startCommand(deps)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(deps.stdout.output()).toContain('Nenhuma issue na fila')
    expect(deps.exec.calls.some((c) => c.startsWith('tmux new -d -s ralph'))).toBe(false)
  })

  it('launches tmux when queue has issues', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    deps.exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '3', stderr: '' },
      [`tmux new -d -s ralph cd '${cwd}' && bash '${RALPH_TEMPLATE}'`]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    const result = await startCommand({ ...deps, cwd })
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(deps.stdout.output()).toContain('Ralph iniciado em background. 3 issues na fila.')
  })

  it('warns about orphan claude-working labels and never removes them automatically', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '  #42 stuck\n  #43 also stuck',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '0', stderr: '' },
    })
    await startCommand(deps)
    expect(deps.stdout.output()).toContain("⚠️  Issues com label 'claude-working'")
    expect(deps.stdout.output()).toContain('Mantendo labels')
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
    deps.exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      'npm view @lucasfe/ralph version': { exitCode: 0, stdout: '0.2.0\n', stderr: '' },
      [`tmux new -d -s ralph cd '${cwd}' && bash '${RALPH_TEMPLATE}'`]: {
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
    deps.exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      [`tmux new -d -s ralph cd '${cwd}' && bash '${RALPH_TEMPLATE}'`]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    await startCommand({ ...deps, cwd })
    expect(writes).toHaveLength(0)
    expect(deps.exec.calls.some((c) => c.startsWith('npm view'))).toBe(false)
  })

  it('does not print warning or write state when remote version is not newer', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    const writes = []
    deps.currentVersion = '0.2.0'
    deps.readSt = () => ({ last_seen_release: '' })
    deps.writeSt = (root, obj) => writes.push({ root, obj })
    deps.exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label claude-working --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      'npm view @lucasfe/ralph version': { exitCode: 0, stdout: '0.1.0\n', stderr: '' },
      [`tmux new -d -s ralph cd '${cwd}' && bash '${RALPH_TEMPLATE}'`]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    await startCommand({ ...deps, cwd })
    expect(deps.stdout.output()).not.toContain('New version available')
    expect(writes).toHaveLength(0)
  })

})
