import { describe, it, expect } from 'vitest'
import {
  classifyInstall,
  NPM_GLOBAL_UPDATE_ARGV,
  NPM_GLOBAL_UPDATE_LABEL,
} from './install-target.js'
import { RALPH_HOME } from './paths.js'

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

const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`

const npmRootOk = (stdout = `${GLOBAL_ROOT}\n`) => ({
  'npm root -g': { exitCode: 0, stdout, stderr: '' },
})

describe('classifyInstall — npm-global vs unknown (#21)', () => {
  it('classifies a package under `npm root -g` as global-npm with the npm update argv', async () => {
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(result.kind).toBe('global-npm')
    expect(result.argv).toEqual(['npm', 'install', '-g', '@lucasfe/ralph@latest'])
    expect(result.reason).toContain('npm root -g')
  })

  it('derives the printable label from the argv, never the other way round', async () => {
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(result.label).toBe(result.argv.join(' '))
    expect(result.label).toBe('npm install -g @lucasfe/ralph@latest')
  })

  it('queries npm root with exact argv and never rejects', async () => {
    const exec = makeExec(npmRootOk())
    await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0]).toMatchObject({ cmd: 'npm', args: ['root', '-g'] })
    expect(exec.calls[0].options).toMatchObject({ reject: false })
  })

  it('tolerates a trailing slash and surrounding whitespace in npm root output', async () => {
    const exec = makeExec(npmRootOk(`  ${GLOBAL_ROOT}/  \n`))
    const result = await classifyInstall({ ralphHome: `${GLOBAL_RALPH}/`, exec })
    expect(result.kind).toBe('global-npm')
  })

  it('returns unknown when the package lives outside npm root -g', async () => {
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({ ralphHome: '/Users/me/repos/ralph', exec })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
    expect(result.label).toBeNull()
    expect(result.reason).toContain('/Users/me/repos/ralph')
  })

  it('does not treat a sibling directory sharing a path prefix as global-npm', async () => {
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({
      ralphHome: `${GLOBAL_ROOT}-old/@lucasfe/ralph`,
      exec,
    })
    expect(result.kind).toBe('unknown')
  })

  it('returns unknown when `npm root -g` exits non-zero', async () => {
    const exec = makeExec({
      'npm root -g': { exitCode: 1, stdout: '', stderr: 'boom' },
    })
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
    expect(result.reason).toContain('npm root -g')
  })

  it('returns unknown when npm root -g prints nothing', async () => {
    const exec = makeExec({ 'npm root -g': { exitCode: 0, stdout: '\n', stderr: '' } })
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(result.kind).toBe('unknown')
  })

  it('returns unknown when npm is missing (exec throws ENOENT)', async () => {
    const exec = async () => {
      const e = new Error('spawn npm ENOENT')
      e.code = 'ENOENT'
      throw e
    }
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  it('returns unknown when no exec is available', async () => {
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: null })
    expect(result.kind).toBe('unknown')
  })

  it('falls back to RALPH_HOME when ralphHome is omitted or null', async () => {
    const exec = makeExec(npmRootOk())
    for (const ralphHome of [undefined, null]) {
      const result = await classifyInstall({ ralphHome, exec })
      expect(result.reason).toContain(RALPH_HOME)
    }
  })

  it('exposes the npm-global argv and its printable label', () => {
    expect(NPM_GLOBAL_UPDATE_ARGV).toEqual([
      'npm',
      'install',
      '-g',
      '@lucasfe/ralph@latest',
    ])
    expect(NPM_GLOBAL_UPDATE_LABEL).toBe(NPM_GLOBAL_UPDATE_ARGV.join(' '))
  })
})
