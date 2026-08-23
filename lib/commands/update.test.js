import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { Volume } from 'memfs'
import { updateCommand, UpdateAbort } from './update.js'
import { classifyInstall } from '../install-target.js'

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

describe('updateCommand — deliberate refusals exit 0 (#22)', () => {
  // A classification that recognized the layout and knows there is nothing to
  // install carries `advice`. Nothing failed, so the exit code is 0 — unlike
  // `unknown`, which has no advice and keeps its exit 1.
  const refusal = (kind, advice) => async () => ({
    kind,
    argv: null,
    label: null,
    reason: `${kind} layout`,
    advice,
  })

  it('exits 0 and installs nothing for a linked dev checkout', async () => {
    const deps = baseDeps({
      classify: refusal('linked', 'Run `git pull` in that checkout to update it.'),
    })
    const result = await updateCommand(deps)
    expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
    expect(installCalls(deps.exec)).toHaveLength(0)
    expect(deps.stdout.output()).toContain('git pull')
  })

  it('never suggests `npm install -g` against a linked checkout', async () => {
    const deps = baseDeps({
      classify: refusal('linked', 'Run `git pull` in that checkout to update it.'),
    })
    await updateCommand(deps)
    const output = deps.stdout.output() + deps.stderr.output()
    expect(output).not.toContain('npm install -g')
  })

  it('exits 0 for an npx invocation and says there is nothing to update', async () => {
    const deps = baseDeps({
      classify: refusal('npx', 'npx always fetches the latest published version.'),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(false)
    expect(installCalls(deps.exec)).toHaveLength(0)
    expect(deps.stdout.output()).toMatch(/npx/)
  })

  it('reports a refusal on stdout only — nothing failed', async () => {
    const deps = baseDeps({ classify: refusal('npx', 'npx always fetches the latest.') })
    await updateCommand(deps)
    expect(deps.stderr.output()).toBe('')
    expect(deps.stdout.output()).toContain('npx layout')
  })

  it('exits 0 through the real classification for an npx cache path', async () => {
    const deps = baseDeps({
      ralphHome: '/Users/me/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph',
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(false)
    expect(installCalls(deps.exec)).toHaveLength(0)
  })

  it('never installs over a linked checkout, whatever store it is linked into', async () => {
    // End-to-end through the real classification: the update command must not
    // spawn anything for a dev checkout, no matter which layout it sits in.
    const checkouts = [
      GLOBAL_RALPH,
      '/Users/me/repos/ralph',
      '/Users/me/Library/pnpm/global/5/node_modules/@lucasfe/ralph',
      '/Users/me/.config/yarn/global/node_modules/@lucasfe/ralph',
      '/Users/me/.bun/install/global/node_modules/@lucasfe/ralph',
    ]
    for (const home of checkouts) {
      const vol = Volume.fromJSON({ [`${home}/.git/HEAD`]: 'ref: refs/heads/main\n' })
      const deps = baseDeps({
        ralphHome: home,
        classify: (opts) => classifyInstall({ ...opts, fs: vol }),
      })
      const result = await updateCommand(deps)
      expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
      expect(deps.exec.calls.filter((c) => c.args.includes('install'))).toHaveLength(0)
      expect(deps.stdout.output()).toContain('git pull')
    }
  })

  it('refuses a classification carrying advice even when it also carries an argv', async () => {
    // Defense in depth: "never install over a linked checkout" must not rest on
    // classifyInstall never setting both fields. Still data, never kind names.
    const deps = baseDeps({
      classify: async () => ({
        kind: 'linked',
        argv: ['npm', 'install', '-g', '@lucasfe/ralph@latest'],
        label: 'npm install -g @lucasfe/ralph@latest',
        reason: 'linked layout',
        advice: 'Run `git pull` in that checkout to update it.',
      }),
    })
    const result = await updateCommand(deps)
    expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
    expect(installCalls(deps.exec)).toHaveLength(0)
  })

  it('still exits 1 for a layout it merely failed to recognize (no advice)', async () => {
    const deps = baseDeps({
      classify: async () => ({
        kind: 'unknown',
        argv: null,
        label: null,
        reason: 'r',
        advice: null,
      }),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(deps.stderr.output()).toMatch(/could not tell how this copy/i)
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
