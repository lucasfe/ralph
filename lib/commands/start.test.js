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
