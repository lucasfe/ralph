import { describe, it, expect } from 'vitest'
import {
  checkForUpdate,
  compareSemver,
  isValidSemver,
} from './update-check.js'

function makeExec(handler) {
  const calls = []
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return handler({ cmd, args, opts })
  }
  exec.calls = calls
  return exec
}

describe('isValidSemver', () => {
  it('accepts standard releases', () => {
    expect(isValidSemver('0.1.0')).toBe(true)
    expect(isValidSemver('1.2.3')).toBe(true)
    expect(isValidSemver('10.20.30')).toBe(true)
  })

  it('accepts pre-releases and build metadata', () => {
    expect(isValidSemver('0.1.0-alpha.0')).toBe(true)
    expect(isValidSemver('1.0.0-rc.1')).toBe(true)
    expect(isValidSemver('1.0.0+build.5')).toBe(true)
  })

  it('rejects invalid input', () => {
    expect(isValidSemver('')).toBe(false)
    expect(isValidSemver('not-a-version')).toBe(false)
    expect(isValidSemver('1.2')).toBe(false)
    expect(isValidSemver(null)).toBe(false)
    expect(isValidSemver(undefined)).toBe(false)
  })
})

describe('compareSemver', () => {
  it('orders by major/minor/patch', () => {
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1)
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1)
    expect(compareSemver('0.1.1', '0.1.0')).toBe(1)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })

  it('treats releases as greater than pre-releases', () => {
    expect(compareSemver('0.1.0', '0.1.0-alpha.0')).toBe(1)
    expect(compareSemver('0.1.0-alpha.0', '0.1.0')).toBe(-1)
  })

  it('compares pre-releases lexicographically when numeric parts equal', () => {
    expect(compareSemver('0.1.0-alpha.1', '0.1.0-alpha.0')).toBe(1)
    expect(compareSemver('0.1.0-alpha.0', '0.1.0-beta.0')).toBe(-1)
  })
})

describe('checkForUpdate', () => {
  const okOut = (stdout) => async () => ({
    exitCode: 0,
    stdout,
    stderr: '',
    timedOut: false,
  })

  it('returns the new version when remote is greater than current', async () => {
    const exec = makeExec(okOut('0.2.0\n'))
    const result = await checkForUpdate('0.1.0', { last_seen_release: '' }, { exec })
    expect(result.newVersion).toBe('0.2.0')
    expect(result.updatedState.last_seen_release).toBe('0.2.0')
    expect(exec.calls[0]).toMatchObject({
      cmd: 'npm',
      args: ['view', '@lucasfe/ralph', 'version'],
    })
    expect(exec.calls[0].opts).toMatchObject({ timeout: 5000 })
  })

  it('preserves other state fields when updating last_seen_release', async () => {
    const exec = makeExec(okOut('0.2.0'))
    const state = {
      last_seen_release: '',
      validated_at: '2026-04-27T00:00:00Z',
      detected_stack: 'npm',
      notes: 'hi',
    }
    const result = await checkForUpdate('0.1.0', state, { exec })
    expect(result.updatedState).toEqual({
      last_seen_release: '0.2.0',
      validated_at: '2026-04-27T00:00:00Z',
      detected_stack: 'npm',
      notes: 'hi',
    })
  })

  it('dedupes when last_seen_release already equals the latest', async () => {
    const exec = makeExec(okOut('0.2.0'))
    const result = await checkForUpdate(
      '0.1.0',
      { last_seen_release: '0.2.0' },
      { exec },
    )
    expect(result.newVersion).toBeNull()
    expect(result.updatedState).toEqual({ last_seen_release: '0.2.0' })
  })

  it('returns null when remote equals current version', async () => {
    const exec = makeExec(okOut('0.1.0'))
    const result = await checkForUpdate('0.1.0', { last_seen_release: '' }, { exec })
    expect(result.newVersion).toBeNull()
  })

  it('returns null when remote is older than current (rollback case)', async () => {
    const exec = makeExec(okOut('0.0.9'))
    const result = await checkForUpdate('0.1.0', { last_seen_release: '' }, { exec })
    expect(result.newVersion).toBeNull()
  })

  it('returns null on timeout (exec rejects)', async () => {
    const exec = makeExec(async () => {
      const e = new Error('Command timed out after 5000ms')
      e.timedOut = true
      throw e
    })
    const result = await checkForUpdate(
      '0.1.0',
      { last_seen_release: '' },
      { exec },
    )
    expect(result.newVersion).toBeNull()
    expect(result.updatedState).toEqual({ last_seen_release: '' })
  })

  it('returns null on timeout (exec resolves with timedOut flag)', async () => {
    const exec = makeExec(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'timeout',
      timedOut: true,
    }))
    const result = await checkForUpdate(
      '0.1.0',
      { last_seen_release: '' },
      { exec },
    )
    expect(result.newVersion).toBeNull()
  })

  it('returns null when npm is missing (ENOENT)', async () => {
    const exec = makeExec(async () => {
      const e = new Error('spawn npm ENOENT')
      e.code = 'ENOENT'
      throw e
    })
    const result = await checkForUpdate(
      '0.1.0',
      { last_seen_release: '' },
      { exec },
    )
    expect(result.newVersion).toBeNull()
  })

  it('returns null when npm view exits non-zero (network error)', async () => {
    const exec = makeExec(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'network down',
    }))
    const result = await checkForUpdate(
      '0.1.0',
      { last_seen_release: '' },
      { exec },
    )
    expect(result.newVersion).toBeNull()
  })

  it('returns null when remote output is not valid semver', async () => {
    const exec = makeExec(okOut('garbage-output\n'))
    const result = await checkForUpdate(
      '0.1.0',
      { last_seen_release: '' },
      { exec },
    )
    expect(result.newVersion).toBeNull()
  })

  it('returns null when no exec is provided', async () => {
    const result = await checkForUpdate('0.1.0', { last_seen_release: '' }, {})
    expect(result.newVersion).toBeNull()
  })

  it('tolerates state without last_seen_release', async () => {
    const exec = makeExec(okOut('0.2.0'))
    const result = await checkForUpdate('0.1.0', {}, { exec })
    expect(result.newVersion).toBe('0.2.0')
    expect(result.updatedState.last_seen_release).toBe('0.2.0')
  })
})
