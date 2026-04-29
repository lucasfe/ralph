import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { createHash } from 'node:crypto'
import { acquireLock, lockPathFor, peekLock, releaseLock } from './lock.js'

const REPO = '/Users/me/repos/agenthub'

function vol(initial = {}) {
  const v = Volume.fromJSON(initial, '/')
  v.mkdirSync('/tmp', { recursive: true })
  return v
}

function expectedLockPath(repoPath, tmpDir = '/tmp') {
  const slug = createHash('sha256').update(repoPath).digest('hex').slice(0, 8)
  return `${tmpDir}/ralph-cycle-${slug}.lock`
}

const aliveKill = () => () => {}
const deadKill = () => () => {
  const err = new Error('No such process')
  err.code = 'ESRCH'
  throw err
}
const permKill = () => () => {
  const err = new Error('Operation not permitted')
  err.code = 'EPERM'
  throw err
}

describe('lockPathFor', () => {
  it('returns /tmp/ralph-cycle-<sha8>.lock derived from the repo path', () => {
    expect(lockPathFor(REPO)).toBe(expectedLockPath(REPO))
  })

  it('produces an 8-char hex slug', () => {
    const path = lockPathFor(REPO)
    const match = path.match(/ralph-cycle-([0-9a-f]+)\.lock$/)
    expect(match).not.toBeNull()
    expect(match[1]).toHaveLength(8)
  })

  it('is deterministic for the same repo path', () => {
    expect(lockPathFor(REPO)).toBe(lockPathFor(REPO))
  })

  it('differs for different repo paths', () => {
    expect(lockPathFor('/a')).not.toBe(lockPathFor('/b'))
  })

  it('honors a custom tmp directory', () => {
    expect(lockPathFor(REPO, '/var/tmp')).toBe(expectedLockPath(REPO, '/var/tmp'))
  })
})

describe('acquireLock', () => {
  it('writes a fresh lockfile and returns acquired:true when no lock exists', () => {
    const v = vol()
    const startedAt = new Date('2026-04-29T00:00:00Z')
    const result = acquireLock(REPO, {
      pid: 4242,
      startedAt,
      fsImpl: v,
      processKill: aliveKill(),
      now: () => startedAt.getTime(),
    })
    expect(result).toEqual({
      acquired: true,
      holder: { pid: 4242, startedAt: startedAt.toISOString(), repoPath: REPO },
    })
    const written = JSON.parse(
      v.readFileSync(expectedLockPath(REPO), 'utf8').toString(),
    )
    expect(written).toEqual({
      pid: 4242,
      startedAt: startedAt.toISOString(),
      repoPath: REPO,
    })
  })

  it('returns acquired:false with the existing holder when the lock is alive and fresh', () => {
    const startedAt = '2026-04-29T00:00:00.000Z'
    const existing = { pid: 1234, startedAt, repoPath: REPO }
    const v = vol({
      [expectedLockPath(REPO)]: JSON.stringify(existing),
    })
    const result = acquireLock(REPO, {
      pid: 4242,
      fsImpl: v,
      processKill: aliveKill(),
      now: () => Date.parse(startedAt) + 60_000,
    })
    expect(result).toEqual({ acquired: false, holder: existing })
    const stillThere = JSON.parse(
      v.readFileSync(expectedLockPath(REPO), 'utf8').toString(),
    )
    expect(stillThere).toEqual(existing)
  })

  it('overwrites the lockfile when the existing holder PID is dead (ESRCH)', () => {
    const startedAt = '2026-04-29T00:00:00.000Z'
    const v = vol({
      [expectedLockPath(REPO)]: JSON.stringify({
        pid: 1234,
        startedAt,
        repoPath: REPO,
      }),
    })
    const newStartedAt = new Date('2026-04-29T01:00:00Z')
    const result = acquireLock(REPO, {
      pid: 4242,
      startedAt: newStartedAt,
      fsImpl: v,
      processKill: deadKill(),
      now: () => newStartedAt.getTime(),
    })
    expect(result.acquired).toBe(true)
    expect(result.holder).toEqual({
      pid: 4242,
      startedAt: newStartedAt.toISOString(),
      repoPath: REPO,
    })
    const written = JSON.parse(
      v.readFileSync(expectedLockPath(REPO), 'utf8').toString(),
    )
    expect(written.pid).toBe(4242)
  })

  it('overwrites the lockfile when the existing lock is older than the default 6h threshold', () => {
    const startedAt = '2026-04-29T00:00:00.000Z'
    const v = vol({
      [expectedLockPath(REPO)]: JSON.stringify({
        pid: 1234,
        startedAt,
        repoPath: REPO,
      }),
    })
    const sevenHoursLaterMs = Date.parse(startedAt) + 7 * 60 * 60 * 1000
    const result = acquireLock(REPO, {
      pid: 4242,
      startedAt: new Date(sevenHoursLaterMs),
      fsImpl: v,
      processKill: aliveKill(),
      now: () => sevenHoursLaterMs,
    })
    expect(result.acquired).toBe(true)
    expect(result.holder.pid).toBe(4242)
  })

  it('honors a custom staleAfterMs threshold', () => {
    const startedAt = '2026-04-29T00:00:00.000Z'
    const v = vol({
      [expectedLockPath(REPO)]: JSON.stringify({
        pid: 1234,
        startedAt,
        repoPath: REPO,
      }),
    })
    const twoMinutesLaterMs = Date.parse(startedAt) + 2 * 60 * 1000
    const result = acquireLock(REPO, {
      pid: 4242,
      startedAt: new Date(twoMinutesLaterMs),
      fsImpl: v,
      processKill: aliveKill(),
      now: () => twoMinutesLaterMs,
      staleAfterMs: 60 * 1000,
    })
    expect(result.acquired).toBe(true)
    expect(result.holder.pid).toBe(4242)
  })

  it('treats EPERM from process.kill as alive (process exists, signal denied)', () => {
    const startedAt = '2026-04-29T00:00:00.000Z'
    const existing = { pid: 1, startedAt, repoPath: REPO }
    const v = vol({
      [expectedLockPath(REPO)]: JSON.stringify(existing),
    })
    const result = acquireLock(REPO, {
      pid: 4242,
      fsImpl: v,
      processKill: permKill(),
      now: () => Date.parse(startedAt) + 60_000,
    })
    expect(result).toEqual({ acquired: false, holder: existing })
  })

  it('treats a corrupt lockfile as stale and acquires the lock', () => {
    const v = vol({
      [expectedLockPath(REPO)]: 'not json {{',
    })
    const startedAt = new Date('2026-04-29T00:00:00Z')
    const result = acquireLock(REPO, {
      pid: 4242,
      startedAt,
      fsImpl: v,
      processKill: aliveKill(),
      now: () => startedAt.getTime(),
    })
    expect(result.acquired).toBe(true)
    expect(result.holder.pid).toBe(4242)
  })
})

describe('releaseLock', () => {
  it('removes the lockfile when present', () => {
    const v = vol({
      [expectedLockPath(REPO)]: JSON.stringify({ pid: 1234 }),
    })
    releaseLock(REPO, { fsImpl: v })
    expect(v.existsSync(expectedLockPath(REPO))).toBe(false)
  })

  it('is a no-op when the lockfile is missing', () => {
    const v = vol()
    expect(() => releaseLock(REPO, { fsImpl: v })).not.toThrow()
    expect(v.existsSync(expectedLockPath(REPO))).toBe(false)
  })
})

describe('peekLock', () => {
  it('returns null when the lockfile is missing', () => {
    expect(peekLock(REPO, { fsImpl: vol() })).toBeNull()
  })

  it('returns { holder, alive: true } when the holder PID is alive', () => {
    const startedAt = '2026-04-29T00:00:00.000Z'
    const holder = { pid: 1234, startedAt, repoPath: REPO }
    const v = vol({
      [expectedLockPath(REPO)]: JSON.stringify(holder),
    })
    expect(peekLock(REPO, { fsImpl: v, processKill: aliveKill() })).toEqual({
      holder,
      alive: true,
    })
  })

  it('returns { holder, alive: false } when the holder PID is dead', () => {
    const startedAt = '2026-04-29T00:00:00.000Z'
    const holder = { pid: 1234, startedAt, repoPath: REPO }
    const v = vol({
      [expectedLockPath(REPO)]: JSON.stringify(holder),
    })
    expect(peekLock(REPO, { fsImpl: v, processKill: deadKill() })).toEqual({
      holder,
      alive: false,
    })
  })

  it('returns null when the lockfile is corrupt JSON', () => {
    const v = vol({
      [expectedLockPath(REPO)]: 'not json',
    })
    expect(peekLock(REPO, { fsImpl: v, processKill: aliveKill() })).toBeNull()
  })
})
