import { describe, it, expect } from 'vitest'
import { startCommand } from './start.js'
import { globalConfigPath } from '../utils/global-config.js'

// #3 QA augmentation — command read-site adversarial cases. The dev's
// start.test.js proves the happy path (global supplies creds → no warning; repo
// overrides global). These probe the corners: the `??` empty-string trap at the
// read site, PARTIAL creds, and that start reads the global file at the
// XDG-derived path when XDG_CONFIG_HOME is set. Queue is forced empty so the
// command returns right after the credential read site.

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

function baseDeps(overrides = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  const sendWa = makeWa()
  const calls = []
  // Minimal exec: tmux guard finds nothing, gh auth passes, queue is empty so
  // start returns early right after the credential read site.
  const exec = async (cmd, args, options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return { exitCode: 0, stdout: '0', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec,
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

describe('QA startCommand — `??` empty-string trap at the credential read site (#3)', () => {
  it('a repo .env.local with CALLMEBOT_KEY="" WARNS even though the global file has a real key', async () => {
    // repo .env.local present with a BLANK key. `??` keeps '' (non-nullish), so
    // the global "real-key" is never consulted → creds are treated as missing.
    const deps = baseDeps({
      exists: () => true, // repo .env.local present
      loadEnv: (path) =>
        path === GLOBAL_PATH
          ? { CALLMEBOT_KEY: 'real-key', WHATSAPP_PHONE: 'real-phone' }
          : { CALLMEBOT_KEY: '', WHATSAPP_PHONE: '' },
      processEnv: {},
    })
    const result = await startCommand(deps)
    expect(result.exitCode).toBe(0)
    // The blank repo values short-circuit the fallthrough → warning fires.
    expect(deps.stdout.output()).toMatch(/ausentes/)
  })

  it('warns when only WHATSAPP_PHONE is supplied (partial creds) and CALLMEBOT_KEY is missing everywhere', async () => {
    const deps = baseDeps({
      exists: () => false,
      loadEnv: (path) =>
        path === GLOBAL_PATH ? { WHATSAPP_PHONE: '+global' } : {},
      processEnv: {},
    })
    await startCommand(deps)
    // Missing one of the pair → still warns.
    expect(deps.stdout.output()).toMatch(/ausentes/)
  })

  it('process.env CALLMEBOT_KEY="" masks a real global key (empty proc value wins over global)', async () => {
    const deps = baseDeps({
      exists: () => false, // no repo .env.local
      processEnv: { CALLMEBOT_KEY: '', WHATSAPP_PHONE: '' },
      loadEnv: (path) =>
        path === GLOBAL_PATH
          ? { CALLMEBOT_KEY: 'real', WHATSAPP_PHONE: '+real' }
          : {},
    })
    await startCommand(deps)
    expect(deps.stdout.output()).toMatch(/ausentes/)
  })
})

describe('QA startCommand — reads the global file at the XDG-derived path (#3)', () => {
  it('consults the XDG_CONFIG_HOME path (not ~/.config) and picks up creds there', async () => {
    const xdgPath = globalConfigPath({ processEnv: { XDG_CONFIG_HOME: '/xdg' }, home: HOME })
    const seen = []
    const deps = baseDeps({
      exists: () => false,
      processEnv: { XDG_CONFIG_HOME: '/xdg' },
      loadEnv: (path) => {
        seen.push(path)
        return path === xdgPath
          ? { CALLMEBOT_KEY: 'xk', WHATSAPP_PHONE: '+x' }
          : {}
      },
    })
    const result = await startCommand(deps)
    expect(result.exitCode).toBe(0)
    // start resolved creds from the XDG path → no warning.
    expect(deps.stdout.output()).not.toMatch(/ausentes/)
    // and it actually read that exact path.
    expect(seen).toContain(xdgPath)
    expect(xdgPath).not.toBe(GLOBAL_PATH)
  })
})
