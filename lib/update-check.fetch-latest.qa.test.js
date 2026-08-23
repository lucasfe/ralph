import { describe, it, expect } from 'vitest'
import { fetchLatestVersion, PACKAGE_NAME } from './update-check.js'

// QA augmentation for #21. `fetchLatestVersion` is the registry query on its
// own; #24 retired the `checkForUpdate` wrapper that used to delegate to it (the
// weekly policy now lives in resolveUpdateDecision, covered by
// update-check.decision.test.js). What remains here is the part that outlived
// the wrapper: the helper must never hand a caller a value that only LOOKS like
// a version, and must never throw or spawn when it cannot query.

function makeExec(handler) {
  const calls = []
  const exec = async (cmd, args, opts) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, opts })
    return handler({ cmd, args, opts })
  }
  exec.calls = calls
  return exec
}

const okOut = (stdout) => async () => ({ exitCode: 0, stdout, stderr: '', timedOut: false })

describe('fetchLatestVersion — output sanitizing (#21 QA)', () => {
  it('strips CR/LF/space padding and returns the bare version', async () => {
    expect(await fetchLatestVersion(makeExec(okOut('  0.16.0 \r\n')))).toBe('0.16.0')
  })

  it('accepts a prerelease and build metadata verbatim', async () => {
    expect(await fetchLatestVersion(makeExec(okOut('1.0.0-rc.1\n')))).toBe('1.0.0-rc.1')
    expect(await fetchLatestVersion(makeExec(okOut('1.0.0+build.5\n')))).toBe('1.0.0+build.5')
  })

  it('rejects a v-prefixed version rather than half-parsing it', async () => {
    expect(await fetchLatestVersion(makeExec(okOut('v0.16.0\n')))).toBeNull()
  })

  it('rejects multi-line output (npm noise plus a version)', async () => {
    expect(await fetchLatestVersion(makeExec(okOut('npm WARN oops\n0.16.0\n')))).toBeNull()
    expect(await fetchLatestVersion(makeExec(okOut('0.16.0\n0.17.0\n')))).toBeNull()
  })

  it('rejects a partial version', async () => {
    expect(await fetchLatestVersion(makeExec(okOut('0.16\n')))).toBeNull()
  })

  it('returns null when the result object is missing or malformed', async () => {
    for (const value of [undefined, null, {}, { exitCode: null, stdout: '0.16.0' }]) {
      expect(await fetchLatestVersion(makeExec(async () => value))).toBeNull()
    }
  })

  it('returns null when exitCode is 0 but stdout is missing', async () => {
    expect(await fetchLatestVersion(makeExec(async () => ({ exitCode: 0 })))).toBeNull()
  })

  it('returns null when timedOut is set even with exitCode 0', async () => {
    const exec = makeExec(async () => ({ exitCode: 0, stdout: '0.16.0', timedOut: true }))
    expect(await fetchLatestVersion(exec)).toBeNull()
  })

  it('never throws when exec rejects with a non-Error value', async () => {
    const exec = makeExec(async () => {
      throw 'npm exploded'
    })
    expect(await fetchLatestVersion(exec)).toBeNull()
  })

  it('does not spawn anything when exec is not callable', async () => {
    for (const value of [null, {}, 'npm', 42]) {
      expect(await fetchLatestVersion(value)).toBeNull()
    }
  })

  it('queries the package name exported for reuse by install-target/update', async () => {
    const exec = makeExec(okOut('0.16.0'))
    await fetchLatestVersion(exec)
    expect(PACKAGE_NAME).toBe('@lucasfe/ralph')
    expect(exec.calls[0].args).toEqual(['view', PACKAGE_NAME, 'version'])
  })
})
