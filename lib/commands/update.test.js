import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { updateCommand, UpdateAbort } from './update.js'

const BIN = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))

const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`
const CURRENT = '0.15.6'
const LATEST = '0.16.0'
const INSTALL_KEY = 'npm install -g @lucasfe/ralph@latest'

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

// npm view -> latest published; npm root -g -> the global node_modules that
// contains this copy of Ralph; npm install -g -> the update itself.
const baseHandlers = (overrides = {}) => ({
  'npm view @lucasfe/ralph version': { exitCode: 0, stdout: `${LATEST}\n`, stderr: '' },
  'npm root -g': { exitCode: 0, stdout: `${GLOBAL_ROOT}\n`, stderr: '' },
  [INSTALL_KEY]: { exitCode: 0, stdout: '', stderr: '' },
  ...overrides,
})

const baseDeps = (overrides = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    currentVersion: CURRENT,
    ralphHome: GLOBAL_RALPH,
    stdout,
    stderr,
    exec: makeExec(baseHandlers()),
    ...overrides,
  }
}

const installCalls = (exec) => exec.calls.filter((c) => c.key === INSTALL_KEY)

describe('updateCommand — npm-global happy path (#21)', () => {
  it('runs `npm install -g @lucasfe/ralph@latest` and exits 0 when behind', async () => {
    const deps = baseDeps()
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(true)
    expect(result.from).toBe(CURRENT)
    expect(result.to).toBe(LATEST)
    expect(installCalls(deps.exec)).toHaveLength(1)
    expect(installCalls(deps.exec)[0]).toMatchObject({
      cmd: 'npm',
      args: ['install', '-g', '@lucasfe/ralph@latest'],
    })
  })

  it('names both the version it came from and the version it moved to', async () => {
    const deps = baseDeps()
    await updateCommand(deps)
    const output = deps.stdout.output()
    expect(output).toContain(CURRENT)
    expect(output).toContain(LATEST)
    expect(output).toMatch(/updated/i)
  })

  it('queries the registry before attempting an install', async () => {
    const deps = baseDeps()
    await updateCommand(deps)
    const keys = deps.exec.calls.map((c) => c.key)
    expect(keys.indexOf('npm view @lucasfe/ralph version')).toBeLessThan(
      keys.indexOf(INSTALL_KEY),
    )
  })

  it('never inspects git or a Ralph project — it works from any directory', async () => {
    const deps = baseDeps()
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.exec.calls.every((c) => c.cmd === 'npm')).toBe(true)
  })
})

describe('updateCommand — up-to-date short-circuit and --force (#21)', () => {
  it('prints "already up to date (X)", makes no install call, and exits 0', async () => {
    const deps = baseDeps({
      exec: makeExec(
        baseHandlers({
          'npm view @lucasfe/ralph version': {
            exitCode: 0,
            stdout: `${CURRENT}\n`,
            stderr: '',
          },
        }),
      ),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(false)
    expect(deps.stdout.output()).toMatch(
      new RegExp(`already up to date \\(${CURRENT.replace(/\./g, '\\.')}\\)`, 'i'),
    )
    expect(installCalls(deps.exec)).toHaveLength(0)
  })

  it('short-circuits when the installed version is ahead of the registry', async () => {
    const deps = baseDeps({
      currentVersion: '9.9.9',
      exec: makeExec(baseHandlers()),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(false)
    expect(installCalls(deps.exec)).toHaveLength(0)
  })

  it('--force reinstalls even when already on the latest version', async () => {
    const deps = baseDeps({
      force: true,
      exec: makeExec(
        baseHandlers({
          'npm view @lucasfe/ralph version': {
            exitCode: 0,
            stdout: `${CURRENT}\n`,
            stderr: '',
          },
        }),
      ),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(true)
    expect(installCalls(deps.exec)).toHaveLength(1)
    expect(installCalls(deps.exec)[0].args).toEqual([
      'install',
      '-g',
      '@lucasfe/ralph@latest',
    ])
  })
})

describe('updateCommand — refusals and failures (#21)', () => {
  it('refuses to guess when the layout is not npm-global and prints the manual command', async () => {
    const deps = baseDeps({ ralphHome: '/Users/me/repos/ralph' })
    const result = await updateCommand(deps)
    expect(result.exitCode).not.toBe(0)
    expect(result.updated).toBe(false)
    const output = deps.stdout.output() + deps.stderr.output()
    expect(output).toContain('npm install -g @lucasfe/ralph@latest')
    expect(installCalls(deps.exec)).toHaveLength(0)
  })

  it('reports a failed registry query and makes no install attempt', async () => {
    const deps = baseDeps({
      exec: makeExec(
        baseHandlers({
          'npm view @lucasfe/ralph version': {
            exitCode: 1,
            stdout: '',
            stderr: 'network down',
          },
        }),
      ),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).not.toBe(0)
    expect(result.updated).toBe(false)
    expect(result.to).toBeNull()
    expect(deps.stderr.output()).toMatch(/latest version|registry/i)
    expect(installCalls(deps.exec)).toHaveLength(0)
    expect(deps.exec.calls.map((c) => c.key)).not.toContain('npm root -g')
  })

  it('propagates a non-zero install exit code', async () => {
    const deps = baseDeps({
      exec: makeExec(
        baseHandlers({ [INSTALL_KEY]: { exitCode: 1, stdout: '', stderr: 'EACCES' } }),
      ),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(result.updated).toBe(false)
    expect(deps.stderr.output()).toMatch(/failed/i)
  })

  it('preserves the install command exit code verbatim', async () => {
    const deps = baseDeps({
      exec: makeExec(
        baseHandlers({ [INSTALL_KEY]: { exitCode: 243, stdout: '', stderr: 'boom' } }),
      ),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(243)
  })

  it('reports a non-zero exit when the install command cannot be spawned', async () => {
    const handlers = baseHandlers()
    const exec = async (cmd, args, options) => {
      if (`${cmd} ${args.join(' ')}` === INSTALL_KEY) {
        const e = new Error('spawn npm ENOENT')
        e.code = 'ENOENT'
        throw e
      }
      return makeExec(handlers)(cmd, args, options)
    }
    const deps = baseDeps({ exec })
    const result = await updateCommand(deps)
    expect(result.exitCode).not.toBe(0)
    expect(result.updated).toBe(false)
    expect(deps.stderr.output()).toMatch(/failed/i)
  })
})

describe('UpdateAbort', () => {
  it('is an Error carrying an exit code, defaulting to 1', () => {
    const abort = new UpdateAbort('nope')
    expect(abort).toBeInstanceOf(Error)
    expect(abort.message).toBe('nope')
    expect(abort.exitCode).toBe(1)
    expect(new UpdateAbort('nope', 7).exitCode).toBe(7)
  })
})

describe('ralph update — CLI registration (#21)', () => {
  it('appears in `ralph --help`', async () => {
    const result = await execa('node', [BIN, '--help'], { reject: false })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^\s*update\b/m)
  })

  it('accepts --force', async () => {
    const result = await execa('node', [BIN, 'update', '--help'], { reject: false })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/--force/)
  })

  it('does not register an `upgrade` alias', async () => {
    const result = await execa('node', [BIN, 'upgrade'], { reject: false })
    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/unknown command/i)
  })
})
