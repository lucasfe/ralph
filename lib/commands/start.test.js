import { describe, it, expect } from 'vitest'
import { startCommand } from './start.js'
import { globalConfigPath } from '../utils/global-config.js'

const REPO = '/repo'
const HOME = '/home/me'

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
  const sendWa = async (args) => {
    messages.push(args)
    return { ok: true }
  }
  sendWa.messages = messages
  return sendWa
}

const GLOBAL_PATH = globalConfigPath({ processEnv: {}, home: HOME })

// The tmux guard must NOT find an existing session; the queue is empty so start
// returns early after the env read site (which is what these tests exercise).
const baseHandlers = () => ({
  'tmux has-session -t': { exitCode: 1, stdout: '', stderr: '' },
})

const baseDeps = (overrides = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const sendWa = makeWa()
  const exec = makeExec()
  // tmux has-session uses a per-project session name, so match by prefix below.
  const wrapped = async (cmd, args, options = {}) => {
    if (cmd === 'tmux' && args[0] === 'has-session') {
      exec.calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    if (cmd === 'gh' && args.join(' ') === 'auth status') {
      exec.calls.push({ key: 'gh auth status', cmd, args, options })
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      exec.calls.push({ key: 'gh issue list', cmd, args, options })
      // queue empty → returns early right after startup notification would be
      return { exitCode: 0, stdout: '0', stderr: '' }
    }
    return exec(cmd, args, options)
  }
  wrapped.calls = exec.calls
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec: wrapped,
    exists: () => false,
    loadEnv: () => ({}),
    hasCommand: () => true,
    ask: async () => true,
    update: async (_v, s) => ({ newVersion: null, updatedState: s }),
    readSt: () => null,
    writeSt: () => {},
    sendWa,
    peekLock: () => null,
    home: HOME,
    processEnv: {},
    ...overrides,
  }
}

describe('startCommand — global config read site (#3)', () => {
  it('does NOT warn about missing creds when the global file supplies them', async () => {
    const deps = baseDeps({
      exists: () => false, // no repo .env.local
      loadEnv: (path) =>
        path === GLOBAL_PATH
          ? { CALLMEBOT_KEY: 'global-key', WHATSAPP_PHONE: 'global-phone' }
          : {},
      processEnv: {},
    })
    const result = await startCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stdout.output()).not.toMatch(/notifications will be skipped/)
  })

  it('warns about missing creds when neither repo, process.env, nor global supply them', async () => {
    const deps = baseDeps({
      exists: () => false,
      loadEnv: () => ({}),
      processEnv: {},
    })
    await startCommand(deps)
    expect(deps.stdout.output()).toMatch(/notifications will be skipped/)
  })

  it('repo .env.local overrides the global file', async () => {
    const deps = baseDeps({
      exists: () => true, // repo .env.local present
      loadEnv: (path) =>
        path === GLOBAL_PATH
          ? { CALLMEBOT_KEY: 'global-key', WHATSAPP_PHONE: 'global-phone' }
          : { CALLMEBOT_KEY: 'repo-key', WHATSAPP_PHONE: 'repo-phone' },
      processEnv: {},
    })
    await startCommand(deps)
    // repo creds are present → no warning
    expect(deps.stdout.output()).not.toMatch(/notifications will be skipped/)
  })
})

// #565: `ralph start` must be folder-aware like `ralph cycle`. In folder mode
// the preflight never touches gh (no auth check, no label creation, no orphan
// sweep) and the queue count comes from the local .ralph/tasks tree instead of
// `gh issue list`. Behaviour is otherwise identical — only the pickup source
// differs; the launched loop (templates/ralph.sh) dispatches both. The github
// path (default) is unchanged — all the tests above still drive it through gh.
describe('startCommand — folder task source (#565)', () => {
  // exists() true only for ralph.config.sh so readConfigSource reads it; other
  // paths (.env.local, .mcp.json) stay absent to keep the run minimal.
  const folderDeps = (overrides = {}) =>
    baseDeps({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: (p) =>
        String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : '',
      folderQueueCount: async () => 1,
      ...overrides,
    })

  it('does NOT run gh auth status in folder mode', async () => {
    const deps = folderDeps()
    await startCommand(deps)
    expect(deps.exec.calls.some((c) => c.key === 'gh auth status')).toBe(false)
  })

  it('a broken gh auth does NOT block start in folder mode', async () => {
    // Custom exec: no tmux session exists, but gh auth is broken. In folder mode
    // start must never call gh auth, so a failing gh must not block the launch.
    const calls = []
    const exec = async (cmd, args, options = {}) => {
      calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
      if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
      if (cmd === 'gh' && args[0] === 'auth') return { exitCode: 1, stdout: '', stderr: 'not authenticated' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    exec.calls = calls
    const deps = folderDeps({ exec })
    const result = await startCommand(deps)
    // reaches the tmux launch (queue is 1) — proof preflight let it through.
    expect(result.started).toBe(true)
    expect(calls.some((c) => c.key === 'gh auth status')).toBe(false)
  })

  it('does NOT create labels or sweep orphans via gh in folder mode', async () => {
    const deps = folderDeps()
    await startCommand(deps)
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh label create'))).toBe(false)
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh issue list'))).toBe(false)
  })

  it('counts the folder queue (not gh issue list) and launches when non-empty', async () => {
    const deps = folderDeps({ folderQueueCount: async () => 3 })
    const result = await startCommand(deps)
    expect(result.started).toBe(true)
    expect(result.count).toBe(3)
    // the tmux loop was launched
    expect(deps.exec.calls.some((c) => c.cmd === 'tmux' && c.args[0] === 'new')).toBe(true)
  })

  it('exits "nothing to do" when the folder queue is empty', async () => {
    const deps = folderDeps({ folderQueueCount: async () => 0 })
    const result = await startCommand(deps)
    expect(result.started).toBe(false)
    expect(deps.stdout.output()).toMatch(/No issues in the queue/)
    // never launched a loop
    expect(deps.exec.calls.some((c) => c.cmd === 'tmux' && c.args[0] === 'new')).toBe(false)
  })
})
