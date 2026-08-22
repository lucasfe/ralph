import { describe, it, expect } from 'vitest'
import { fetchLatestVersion } from './update-check.js'

// #21: `fetchLatestVersion` is the registry query extracted out of
// `checkForUpdate` so `ralph update` can ask "what is the latest version?"
// without the state/dedupe policy. Kept in a separate file so
// `update-check.test.js` (which pins existing `checkForUpdate` behavior)
// stays untouched.

function makeExec(handler) {
  const calls = []
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return handler({ cmd, args, opts })
  }
  exec.calls = calls
  return exec
}

const okOut = (stdout) => async () => ({
  exitCode: 0,
  stdout,
  stderr: '',
  timedOut: false,
})

describe('fetchLatestVersion', () => {
  it('returns the published version from `npm view`', async () => {
    const exec = makeExec(okOut('0.16.0\n'))
    expect(await fetchLatestVersion(exec)).toBe('0.16.0')
  })

  it('queries npm with exact argv, a 5s timeout, and reject: false', async () => {
    const exec = makeExec(okOut('0.16.0'))
    await fetchLatestVersion(exec)
    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0]).toMatchObject({
      cmd: 'npm',
      args: ['view', '@lucasfe/ralph', 'version'],
    })
    expect(exec.calls[0].opts).toMatchObject({ timeout: 5000, reject: false })
  })

  it('honors a caller-supplied timeout', async () => {
    const exec = makeExec(okOut('0.16.0'))
    await fetchLatestVersion(exec, 1234)
    expect(exec.calls[0].opts).toMatchObject({ timeout: 1234 })
  })

  it('returns null when npm view exits non-zero', async () => {
    const exec = makeExec(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'network down',
    }))
    expect(await fetchLatestVersion(exec)).toBeNull()
  })

  it('returns null when npm view times out (resolved with timedOut)', async () => {
    const exec = makeExec(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'timeout',
      timedOut: true,
    }))
    expect(await fetchLatestVersion(exec)).toBeNull()
  })

  it('returns null when exec rejects (timeout / ENOENT)', async () => {
    const exec = makeExec(async () => {
      const e = new Error('spawn npm ENOENT')
      e.code = 'ENOENT'
      throw e
    })
    expect(await fetchLatestVersion(exec)).toBeNull()
  })

  it('returns null when the output is not valid semver', async () => {
    const exec = makeExec(okOut('garbage-output\n'))
    expect(await fetchLatestVersion(exec)).toBeNull()
  })

  it('returns null when no exec is provided', async () => {
    expect(await fetchLatestVersion()).toBeNull()
  })
})
