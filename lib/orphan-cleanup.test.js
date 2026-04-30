import { describe, it, expect } from 'vitest'
import { cleanupOrphans, findOrphans } from './orphan-cleanup.js'

const REPO = '/Users/me/repos/agenthub'

function makeExec(handlers = {}) {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, options })
    if (handlers[key]) {
      const v = handlers[key]
      return typeof v === 'function' ? v({ cmd, args, options }) : v
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

function makeLog() {
  const messages = []
  const log = (...args) => {
    messages.push(args.join(' '))
  }
  log.messages = messages
  return log
}

describe('findOrphans', () => {
  it('returns [] when gh returns an empty array', async () => {
    const exec = makeExec({
      'gh issue list --state open --label claude-working --json number,title,updatedAt': {
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
    })
    const result = await findOrphans({ exec, repoPath: REPO })
    expect(result).toEqual([])
  })

  it('returns the slim shape for each orphan when gh returns issues', async () => {
    const stdout = JSON.stringify([
      { number: 12, title: 'first', updatedAt: '2026-04-29T00:00:00Z' },
      { number: 34, title: 'second', updatedAt: '2026-04-29T01:00:00Z' },
    ])
    const exec = makeExec({
      'gh issue list --state open --label claude-working --json number,title,updatedAt': {
        exitCode: 0,
        stdout,
        stderr: '',
      },
    })
    const result = await findOrphans({ exec, repoPath: REPO })
    expect(result).toEqual([
      { number: 12, title: 'first', updatedAt: '2026-04-29T00:00:00Z' },
      { number: 34, title: 'second', updatedAt: '2026-04-29T01:00:00Z' },
    ])
  })

  it('runs gh in the supplied repoPath', async () => {
    const exec = makeExec({
      'gh issue list --state open --label claude-working --json number,title,updatedAt': {
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
    })
    await findOrphans({ exec, repoPath: REPO })
    const ghCall = exec.calls.find((c) => c.cmd === 'gh')
    expect(ghCall).toBeDefined()
    expect(ghCall.options.cwd).toBe(REPO)
  })

  it('returns [] when gh exits non-zero', async () => {
    const log = makeLog()
    const exec = makeExec({
      'gh issue list --state open --label claude-working --json number,title,updatedAt': {
        exitCode: 1,
        stdout: '',
        stderr: 'gh: not authenticated',
      },
    })
    const result = await findOrphans({ exec, repoPath: REPO, log })
    expect(result).toEqual([])
    expect(log.messages.join('\n')).toMatch(/not authenticated|gh|orphan/i)
  })

  it('returns [] when gh stdout is invalid JSON', async () => {
    const log = makeLog()
    const exec = makeExec({
      'gh issue list --state open --label claude-working --json number,title,updatedAt': {
        exitCode: 0,
        stdout: 'not json {{',
        stderr: '',
      },
    })
    const result = await findOrphans({ exec, repoPath: REPO, log })
    expect(result).toEqual([])
  })

  it('returns [] when exec throws', async () => {
    const log = makeLog()
    const exec = async () => {
      throw new Error('boom')
    }
    const result = await findOrphans({ exec, repoPath: REPO, log })
    expect(result).toEqual([])
    expect(log.messages.join('\n')).toMatch(/boom/)
  })
})

describe('cleanupOrphans', () => {
  it('is a no-op when orphans is empty (returns [])', async () => {
    const exec = makeExec()
    const result = await cleanupOrphans({ exec, orphans: [] })
    expect(result).toEqual([])
    expect(exec.calls).toEqual([])
  })

  it('is a no-op when orphans is missing/undefined', async () => {
    const exec = makeExec()
    const result = await cleanupOrphans({ exec })
    expect(result).toEqual([])
    expect(exec.calls).toEqual([])
  })

  it('removes the claude-working label from each orphan and returns the cleared numbers', async () => {
    const exec = makeExec({
      'gh issue edit 12 --remove-label claude-working': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue edit 34 --remove-label claude-working': { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await cleanupOrphans({
      exec,
      orphans: [
        { number: 12, title: 'first' },
        { number: 34, title: 'second' },
      ],
    })
    expect(result).toEqual([12, 34])
    expect(exec.calls.map((c) => c.key)).toEqual([
      'gh issue edit 12 --remove-label claude-working',
      'gh issue edit 34 --remove-label claude-working',
    ])
  })

  it('swallows gh errors (non-zero exit) and continues with the remaining orphans', async () => {
    const log = makeLog()
    const exec = makeExec({
      'gh issue edit 12 --remove-label claude-working': {
        exitCode: 1,
        stdout: '',
        stderr: 'label not found',
      },
      'gh issue edit 34 --remove-label claude-working': { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await cleanupOrphans({
      exec,
      orphans: [
        { number: 12, title: 'first' },
        { number: 34, title: 'second' },
      ],
      log,
    })
    expect(result).toEqual([34])
    expect(log.messages.join('\n')).toMatch(/12/)
  })

  it('swallows thrown errors from exec and continues with the remaining orphans', async () => {
    const log = makeLog()
    let calls = 0
    const exec = async (cmd, args) => {
      calls++
      if (args.includes('12')) throw new Error('exec blew up')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const result = await cleanupOrphans({
      exec,
      orphans: [
        { number: 12, title: 'first' },
        { number: 34, title: 'second' },
      ],
      log,
    })
    expect(result).toEqual([34])
    expect(calls).toBe(2)
    expect(log.messages.join('\n')).toMatch(/exec blew up/)
  })

  it('is idempotent — calling twice on already-cleared issues still returns the cleared numbers', async () => {
    const exec = makeExec({
      'gh issue edit 12 --remove-label claude-working': { exitCode: 0, stdout: '', stderr: '' },
    })
    const orphans = [{ number: 12, title: 'first' }]
    const first = await cleanupOrphans({ exec, orphans })
    const second = await cleanupOrphans({ exec, orphans })
    expect(first).toEqual([12])
    expect(second).toEqual([12])
  })
})
