import { describe, it, expect } from 'vitest'
import { checkForUpdate, fetchLatestVersion, PACKAGE_NAME } from './update-check.js'

// QA augmentation for #21. `fetchLatestVersion` was extracted OUT of
// `checkForUpdate`, which now delegates to it. update-check.test.js must stay
// unmodified, so the seam is probed here: every path where the old inline code
// short-circuited must still short-circuit identically (same result, same state
// object, same number of spawns), and the extracted helper must never hand a
// caller a value that only LOOKS like a version.

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

describe('checkForUpdate — delegation seam preserved (#21 QA)', () => {
  it('makes exactly one registry query per call after the extraction', async () => {
    const exec = makeExec(okOut('0.2.0'))
    await checkForUpdate('0.1.0', { last_seen_release: '' }, { exec })
    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0].key).toBe('npm view @lucasfe/ralph version')
  })

  it('forwards a caller-supplied timeoutMs through to the npm call', async () => {
    const exec = makeExec(okOut('0.2.0'))
    await checkForUpdate('0.1.0', {}, { exec, timeoutMs: 77 })
    expect(exec.calls[0].opts).toMatchObject({ timeout: 77, reject: false })
  })

  it('an invalid currentVersion with a successful fetch reports nothing AND records nothing', async () => {
    // The old inline code returned before touching last_seen_release; a drifted
    // extraction that recorded the release here would silently swallow the very
    // next (valid) notification.
    const exec = makeExec(okOut('0.2.0'))
    const state = { last_seen_release: '', validated_at: 'x' }
    const result = await checkForUpdate('not-a-version', state, { exec })
    expect(result.newVersion).toBeNull()
    expect(result.updatedState).toEqual({ last_seen_release: '', validated_at: 'x' })
    expect(state).toEqual({ last_seen_release: '', validated_at: 'x' })
  })

  const badCurrent = [
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['the literal "unknown"', 'unknown'],
    ['a number', 1],
  ]

  for (const [label, value] of badCurrent) {
    it(`returns null with the state untouched when currentVersion is ${label}`, async () => {
      const exec = makeExec(okOut('0.2.0'))
      const result = await checkForUpdate(value, { last_seen_release: 'seen' }, { exec })
      expect(result.newVersion).toBeNull()
      expect(result.updatedState).toEqual({ last_seen_release: 'seen' })
    })
  }

  it('a non-callable exec still short-circuits without throwing, state identity intact', async () => {
    const state = { last_seen_release: '0.1.0', other: true }
    for (const value of [null, {}, 'npm']) {
      const result = await checkForUpdate('0.1.0', state, { exec: value })
      expect(result.newVersion).toBeNull()
      expect(result.updatedState).toBe(state)
    }
  })

  it('never mutates the caller state object when it does report a new version', async () => {
    const exec = makeExec(okOut('0.2.0'))
    const state = { last_seen_release: '' }
    const result = await checkForUpdate('0.1.0', state, { exec })
    expect(result.newVersion).toBe('0.2.0')
    expect(state).toEqual({ last_seen_release: '' })
    expect(result.updatedState).not.toBe(state)
  })

  it('tolerates a null state and still reports the new version', async () => {
    const exec = makeExec(okOut('0.2.0'))
    const result = await checkForUpdate('0.1.0', null, { exec })
    expect(result.newVersion).toBe('0.2.0')
    expect(result.updatedState).toEqual({ last_seen_release: '0.2.0' })
  })

  it('a whitespace-padded currentVersion is still compared numerically', async () => {
    const exec = makeExec(okOut('0.2.0'))
    expect((await checkForUpdate(' 0.1.0 ', {}, { exec })).newVersion).toBe('0.2.0')
    const exec2 = makeExec(okOut('0.2.0'))
    expect((await checkForUpdate(' 0.2.0 ', {}, { exec: exec2 })).newVersion).toBeNull()
  })
})
