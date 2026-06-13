import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { createHash } from 'node:crypto'
import {
  acquireLock,
  lockPathFor,
  peekLock,
  releaseLock,
  sessionNameFor,
} from './lock.js'

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

describe('sessionNameFor', () => {
  it('returns ralph-<sanitized-basename>-<sha8> for the repo path', () => {
    const slug = createHash('sha256').update(REPO).digest('hex').slice(0, 8)
    expect(sessionNameFor(REPO)).toBe(`ralph-agenthub-${slug}`)
  })

  it('shares the 8-char slug with the lock file path', () => {
    const slug = createHash('sha256').update(REPO).digest('hex').slice(0, 8)
    expect(sessionNameFor(REPO)).toContain(slug)
    expect(lockPathFor(REPO)).toContain(slug)
  })

  it('includes the repo basename', () => {
    expect(sessionNameFor('/Users/me/repos/my-project')).toContain('my-project')
  })

  it('sanitizes characters outside [A-Za-z0-9_-] (including . and :)', () => {
    const name = sessionNameFor('/Users/me/repos/my.cool:repo')
    expect(name).toContain('my-cool-repo')
    expect(name).toMatch(/^ralph-[A-Za-z0-9_-]+$/)
  })

  it('resolves the basename even with a trailing slash', () => {
    const slug = createHash('sha256').update('/Users/me/repos/agenthub/').digest('hex').slice(0, 8)
    expect(sessionNameFor('/Users/me/repos/agenthub/')).toBe(`ralph-agenthub-${slug}`)
  })

  it('is deterministic for the same repo path', () => {
    expect(sessionNameFor(REPO)).toBe(sessionNameFor(REPO))
  })

  it('differs for different repo paths', () => {
    expect(sessionNameFor('/a/foo')).not.toBe(sessionNameFor('/b/foo'))
  })

  // --- QA adversarial / edge-case augmentation ---

  const TMUX_VALID = /^ralph-[A-Za-z0-9_-]+-[0-9a-f]{8}$/

  it('collapses nothing but still resolves basename across consecutive mid-path slashes', () => {
    const p = '/Users/me//repos///agenthub'
    const slug = createHash('sha256').update(p).digest('hex').slice(0, 8)
    // split('/') yields ['', 'Users', 'me', '', 'repos', '', '', 'agenthub']
    // .pop() => 'agenthub'
    expect(sessionNameFor(p)).toBe(`ralph-agenthub-${slug}`)
    expect(sessionNameFor(p)).toMatch(TMUX_VALID)
  })

  it('handles a bare directory name with no slash', () => {
    const slug = createHash('sha256').update('agenthub').digest('hex').slice(0, 8)
    expect(sessionNameFor('agenthub')).toBe(`ralph-agenthub-${slug}`)
    expect(sessionNameFor('agenthub')).toMatch(TMUX_VALID)
  })

  it('produces a tmux-valid name even when the basename is entirely illegal chars', () => {
    const p = '/repos/@#$'
    const slug = createHash('sha256').update(p).digest('hex').slice(0, 8)
    const name = sessionNameFor(p)
    // '@#$' (3 illegal chars) -> '---', so name is 'ralph-' + '---' + '-' + slug
    expect(name).toBe(`ralph-----${slug}`)
    expect(name).toMatch(TMUX_VALID)
    // tmux forbids only '.' and ':' in session names; hyphens are fine.
    expect(name).not.toContain('.')
    expect(name).not.toContain(':')
  })

  it('replaces spaces, dots, colons and unicode with hyphens (full result tmux-safe)', () => {
    const name = sessionNameFor('/Users/me/repos/my repo.v2:café')
    // 'my repo.v2:café' -> 'my-repo-v2-caf-' (é replaced)
    expect(name).toMatch(/^ralph-[A-Za-z0-9_-]+$/)
    expect(name).toMatch(TMUX_VALID)
    expect(name).not.toContain('.')
    expect(name).not.toContain(':')
    expect(name).not.toContain(' ')
    expect(name).not.toContain('é')
  })

  it('preserves underscores and hyphens (already-legal tmux chars)', () => {
    const slug = createHash('sha256').update('/x/my_cool-repo').digest('hex').slice(0, 8)
    expect(sessionNameFor('/x/my_cool-repo')).toBe(`ralph-my_cool-repo-${slug}`)
  })

  it('embeds the exact same 8-hex slug as lockPathFor for several distinct paths', () => {
    for (const p of ['/a/foo', '/very/deep/nested/proj', 'bare', '/with space/dir', REPO]) {
      const sessSlug = sessionNameFor(p).match(/-([0-9a-f]{8})$/)
      const lockSlug = lockPathFor(p).match(/ralph-cycle-([0-9a-f]{8})\.lock$/)
      expect(sessSlug).not.toBeNull()
      expect(lockSlug).not.toBeNull()
      expect(sessSlug[1]).toBe(lockSlug[1])
    }
  })

  it('produces DIFFERENT session names for two paths sharing the same basename', () => {
    // The whole point of the slug: same basename, different full path => no collision.
    const a = sessionNameFor('/a/agenthub')
    const b = sessionNameFor('/b/agenthub')
    expect(a).not.toBe(b)
    // Sanitized basename portion is identical; only the slug differs.
    expect(a).toContain('ralph-agenthub-')
    expect(b).toContain('ralph-agenthub-')
  })

  it('handles a root-ish empty-basename path without throwing and stays tmux-valid', () => {
    // '/' -> trailing slash stripped to '' -> basename '' -> 'ralph--<slug>'.
    // The basename segment is EMPTY, so the strict TMUX_VALID regex (which
    // requires +) does not match. That is fine: tmux only forbids '.' and ':'
    // in session names; an empty segment yielding a double-hyphen is still a
    // legal tmux session name. So we assert tmux-legality, not the strict shape.
    const slug = createHash('sha256').update('/').digest('hex').slice(0, 8)
    const name = sessionNameFor('/')
    expect(name).toBe(`ralph--${slug}`)
    expect(name).not.toContain('.')
    expect(name).not.toContain(':')
    expect(name).not.toContain(' ')
    // Composed only of legal tmux session-name chars:
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/)
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
