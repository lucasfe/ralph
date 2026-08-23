import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { readVersionCache, versionCachePath } from './version-cache.js'
import {
  resolveUpdateDecision,
  UPDATE_CHECK_INTERVAL_MS,
  isUpdateCheckDisabled,
} from './update-check.js'

// #24: resolveUpdateDecision owns the whole policy — the RALPH_NO_UPDATE_CHECK
// opt-out, the 7-day network throttle read from the global cache, the semver
// comparison, and the cache write. It is the ONLY thing that decides whether a
// registry query happens, so every throttle test here is an assertion about how
// many times `npm view` was spawned.

const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')
const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function makeExec(handler = okOut('0.2.0')) {
  const calls = []
  const exec = async (cmd, args, opts) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, opts })
    return handler({ cmd, args, opts })
  }
  exec.calls = calls
  return exec
}

function okOut(stdout) {
  return async () => ({ exitCode: 0, stdout, stderr: '', timedOut: false })
}

// An fs that records every call so "no cache read" and "no cache write" are
// provable, not inferred.
function spyFs(vol) {
  const calls = []
  return {
    calls,
    readFileSync: (...a) => {
      calls.push({ op: 'read', path: a[0] })
      return vol.readFileSync(...a)
    },
    writeFileSync: (...a) => {
      calls.push({ op: 'write', path: a[0] })
      return vol.writeFileSync(...a)
    },
    mkdirSync: (...a) => {
      calls.push({ op: 'mkdir', path: a[0] })
      return vol.mkdirSync(...a)
    },
    statSync: (...a) => vol.statSync(...a),
    existsSync: (...a) => vol.existsSync(...a),
  }
}

function seeded(cache) {
  return Volume.fromJSON({ [CACHE_PATH]: JSON.stringify(cache) }, '/')
}

const base = (overrides = {}) => ({
  currentVersion: '0.1.0',
  now: () => T0,
  home: HOME,
  processEnv: {},
  ...overrides,
})

describe('UPDATE_CHECK_INTERVAL_MS', () => {
  it('is one week', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(7 * DAY)
  })
})

describe('isUpdateCheckDisabled', () => {
  it('is true for 1 and other truthy opt-out spellings', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', ' 1 ']) {
      expect(isUpdateCheckDisabled({ RALPH_NO_UPDATE_CHECK: v })).toBe(true)
    }
  })

  it('is false when unset, blank, 0 or false', () => {
    expect(isUpdateCheckDisabled({})).toBe(false)
    for (const v of ['', '   ', '0', 'false', 'FALSE']) {
      expect(isUpdateCheckDisabled({ RALPH_NO_UPDATE_CHECK: v })).toBe(false)
    }
  })

  it('tolerates a missing env bag', () => {
    expect(isUpdateCheckDisabled()).toBe(false)
  })
})

describe('resolveUpdateDecision — RALPH_NO_UPDATE_CHECK opt-out', () => {
  it('short-circuits before any network call, cache read or cache write', async () => {
    const vol = seeded({ last_check_at: null, latest_version: '9.9.9' })
    const fs = spyFs(vol)
    const exec = makeExec()
    const result = await resolveUpdateDecision(
      base({ exec, fs, processEnv: { RALPH_NO_UPDATE_CHECK: '1' } }),
    )
    expect(exec.calls).toHaveLength(0)
    expect(fs.calls).toHaveLength(0)
    expect(result).toEqual({
      latestVersion: null,
      isNewer: false,
      shouldPrompt: false,
      source: 'disabled',
      updatedCache: null,
    })
  })

  it('still checks when RALPH_NO_UPDATE_CHECK=0', async () => {
    const fs = spyFs(new Volume())
    const exec = makeExec()
    const result = await resolveUpdateDecision(
      base({ exec, fs, processEnv: { RALPH_NO_UPDATE_CHECK: '0' } }),
    )
    expect(exec.calls).toHaveLength(1)
    expect(result.source).toBe('network')
  })
})

describe('resolveUpdateDecision — 7-day network throttle', () => {
  it('queries npm and stamps last_check_at when the cache is empty', async () => {
    const vol = new Volume()
    const exec = makeExec()
    const result = await resolveUpdateDecision(base({ exec, fs: vol }))
    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0].key).toBe('npm view @lucasfe/ralph version')
    expect(exec.calls[0].opts).toMatchObject({ timeout: 5000, reject: false })
    expect(result.source).toBe('network')
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.isNewer).toBe(true)
    expect(result.updatedCache).toEqual({
      last_check_at: new Date(T0).toISOString(),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
    expect(readVersionCache({ fs: vol, home: HOME, processEnv: {} })).toEqual(
      result.updatedCache,
    )
  })

  it('reuses the cached version inside the window without touching the network', async () => {
    const vol = seeded({
      last_check_at: new Date(T0 - 3 * DAY).toISOString(),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
    const fs = spyFs(vol)
    const exec = makeExec()
    const result = await resolveUpdateDecision(base({ exec, fs }))
    expect(exec.calls).toHaveLength(0)
    expect(fs.calls.some((c) => c.op === 'write')).toBe(false)
    expect(result.source).toBe('cache')
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.isNewer).toBe(true)
    expect(result.updatedCache.last_check_at).toBe(new Date(T0 - 3 * DAY).toISOString())
  })

  it('two runs inside 7 days make exactly one npm view call', async () => {
    const vol = new Volume()
    const exec = makeExec()
    const first = await resolveUpdateDecision(base({ exec, fs: vol }))
    const second = await resolveUpdateDecision(
      base({ exec, fs: vol, now: () => T0 + 3 * DAY }),
    )
    expect(exec.calls).toHaveLength(1)
    expect(first.source).toBe('network')
    expect(second.source).toBe('cache')
    expect(second.latestVersion).toBe('0.2.0')
    expect(second.isNewer).toBe(true)
  })

  it('a run after the window elapses makes a fresh call and re-stamps last_check_at', async () => {
    const vol = new Volume()
    const exec = makeExec()
    await resolveUpdateDecision(base({ exec, fs: vol }))
    const later = T0 + 8 * DAY
    const second = await resolveUpdateDecision(base({ exec, fs: vol, now: () => later }))
    expect(exec.calls).toHaveLength(2)
    expect(second.source).toBe('network')
    expect(second.updatedCache.last_check_at).toBe(new Date(later).toISOString())
    expect(readVersionCache({ fs: vol, home: HOME, processEnv: {} }).last_check_at).toBe(
      new Date(later).toISOString(),
    )
  })

  it('treats exactly 7 days as elapsed and one ms under as still throttled', async () => {
    const at = (delta) =>
      resolveUpdateDecision(
        base({
          exec: makeExec(),
          fs: seeded({
            last_check_at: new Date(T0 - UPDATE_CHECK_INTERVAL_MS + delta).toISOString(),
            latest_version: '0.2.0',
          }),
        }),
      )
    expect((await at(0)).source).toBe('network')
    expect((await at(1)).source).toBe('cache')
  })

  it('treats a last_check_at in the future as check due (clock skew)', async () => {
    const vol = seeded({
      last_check_at: new Date(T0 + 30 * DAY).toISOString(),
      latest_version: '0.0.1',
    })
    const exec = makeExec()
    const result = await resolveUpdateDecision(base({ exec, fs: vol }))
    expect(exec.calls).toHaveLength(1)
    expect(result.source).toBe('network')
    expect(result.latestVersion).toBe('0.2.0')
  })

  it('treats an unparseable last_check_at as check due', async () => {
    for (const bad of ['not-a-date', '', 'yesterday']) {
      const exec = makeExec()
      const result = await resolveUpdateDecision(
        base({ exec, fs: seeded({ last_check_at: bad, latest_version: '0.2.0' }) }),
      )
      expect(exec.calls).toHaveLength(1)
      expect(result.source).toBe('network')
    }
  })

  it('a corrupt cache file resolves to defaults and a fresh check', async () => {
    const vol = Volume.fromJSON({ [CACHE_PATH]: '{ mangled' }, '/')
    const exec = makeExec()
    const result = await resolveUpdateDecision(base({ exec, fs: vol }))
    expect(exec.calls).toHaveLength(1)
    expect(result.source).toBe('network')
    expect(readVersionCache({ fs: vol, home: HOME, processEnv: {} }).latest_version).toBe(
      '0.2.0',
    )
  })

  it('preserves last_prompted_at across a network refresh (#26 depends on it)', async () => {
    const vol = seeded({
      last_check_at: new Date(T0 - 30 * DAY).toISOString(),
      last_prompted_at: '2026-07-01T00:00:00.000Z',
      latest_version: '0.1.5',
    })
    const result = await resolveUpdateDecision(base({ exec: makeExec(), fs: vol }))
    expect(result.updatedCache.last_prompted_at).toBe('2026-07-01T00:00:00.000Z')
    expect(readVersionCache({ fs: vol, home: HOME, processEnv: {} }).last_prompted_at).toBe(
      '2026-07-01T00:00:00.000Z',
    )
  })

  it('writes the cache under XDG_CONFIG_HOME when it is set', async () => {
    const vol = new Volume()
    const processEnv = { XDG_CONFIG_HOME: '/xdg' }
    await resolveUpdateDecision(base({ exec: makeExec(), fs: vol, processEnv }))
    const xdgPath = versionCachePath({ processEnv, home: HOME })
    expect(xdgPath).toBe(join('/xdg', 'ralph', 'update-check.json'))
    expect(vol.existsSync(xdgPath)).toBe(true)
    expect(vol.existsSync(CACHE_PATH)).toBe(false)
  })
})

describe('resolveUpdateDecision — failure paths are silent and non-blocking', () => {
  const failures = [
    ['npm view exits non-zero', async () => ({ exitCode: 1, stdout: '', stderr: 'offline' })],
    [
      'npm view times out',
      async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: true }),
    ],
    [
      'npm is missing',
      async () => {
        const e = new Error('spawn npm ENOENT')
        e.code = 'ENOENT'
        throw e
      },
    ],
    ['npm prints garbage', okOut('not-a-version\n')],
  ]

  for (const [label, handler] of failures) {
    it(`reports no version when ${label}`, async () => {
      const vol = new Volume()
      const result = await resolveUpdateDecision(
        base({ exec: makeExec(handler), fs: vol }),
      )
      expect(result.latestVersion).toBeNull()
      expect(result.isNewer).toBe(false)
      expect(result.source).toBe('network')
    })
  }

  it('a failed check still stamps the window so the registry is not hammered', async () => {
    const vol = new Volume()
    const exec = makeExec(async () => ({ exitCode: 1, stdout: '', stderr: 'offline' }))
    const result = await resolveUpdateDecision(base({ exec, fs: vol }))
    expect(result.updatedCache.last_check_at).toBe(new Date(T0).toISOString())
    const second = await resolveUpdateDecision(
      base({ exec, fs: vol, now: () => T0 + DAY }),
    )
    expect(exec.calls).toHaveLength(1)
    expect(second.source).toBe('cache')
  })

  it('keeps a previously cached version when the fresh check fails', async () => {
    const vol = seeded({
      last_check_at: new Date(T0 - 30 * DAY).toISOString(),
      latest_version: '0.2.0',
    })
    const exec = makeExec(async () => ({ exitCode: 1, stdout: '', stderr: 'offline' }))
    const result = await resolveUpdateDecision(base({ exec, fs: vol }))
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.isNewer).toBe(true)
  })

  it('never throws when the cache cannot be written', async () => {
    const fs = {
      readFileSync: () => {
        const e = new Error('missing')
        e.code = 'ENOENT'
        throw e
      },
      mkdirSync: () => {
        const e = new Error('read-only fs')
        e.code = 'EROFS'
        throw e
      },
      writeFileSync: () => {
        throw new Error('should not get here')
      },
    }
    const result = await resolveUpdateDecision(base({ exec: makeExec(), fs }))
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.isNewer).toBe(true)
    expect(result.source).toBe('network')
  })

  it('never throws when exec is not callable', async () => {
    const vol = new Volume()
    const result = await resolveUpdateDecision(base({ exec: undefined, fs: vol }))
    expect(result.latestVersion).toBeNull()
    expect(result.isNewer).toBe(false)
  })
})

describe('resolveUpdateDecision — semver comparison', () => {
  it('is not newer when the registry matches or trails the local version', async () => {
    for (const [current, latest] of [
      ['0.2.0', '0.2.0'],
      ['0.2.0', '0.1.9'],
    ]) {
      const result = await resolveUpdateDecision(
        base({ currentVersion: current, exec: makeExec(okOut(latest)), fs: new Volume() }),
      )
      expect(result.latestVersion).toBe(latest)
      expect(result.isNewer).toBe(false)
    }
  })

  it('compares a whitespace-padded currentVersion numerically', async () => {
    const newer = await resolveUpdateDecision(
      base({ currentVersion: ' 0.1.0 ', exec: makeExec(), fs: new Volume() }),
    )
    expect(newer.isNewer).toBe(true)
    const same = await resolveUpdateDecision(
      base({ currentVersion: ' 0.2.0 ', exec: makeExec(), fs: new Volume() }),
    )
    expect(same.isNewer).toBe(false)
  })

  it('never claims newer when currentVersion is not comparable', async () => {
    for (const current of [undefined, null, '', 'unknown', 1]) {
      const result = await resolveUpdateDecision(
        base({ currentVersion: current, exec: makeExec(), fs: new Volume() }),
      )
      expect(result.latestVersion).toBe('0.2.0')
      expect(result.isNewer).toBe(false)
    }
  })
})

describe('resolveUpdateDecision — contracts', () => {
  it('accepts `now` as a function returning epoch ms (startCommand contract)', async () => {
    const result = await resolveUpdateDecision(
      base({ now: () => T0, exec: makeExec(), fs: new Volume() }),
    )
    expect(result.updatedCache.last_check_at).toBe(new Date(T0).toISOString())
  })

  it('falls back to the real clock for anything that is not a usable function', async () => {
    // #24: the contract is function-only. A bare number, a callback returning
    // garbage, or a callback that throws all fall back to Date.now rather than
    // escaping — a wrong clock costs one extra registry query, an escape aborts
    // `ralph start`.
    const nows = [T0, () => 'nope', () => NaN, () => 8.64e15 + 1, () => { throw new Error('x') }]
    const beforeMs = Date.now()
    for (const now of nows) {
      const result = await resolveUpdateDecision(
        base({ now, exec: makeExec(), fs: new Volume() }),
      )
      const stampedMs = Date.parse(result.updatedCache.last_check_at)
      expect(stampedMs).not.toBeNaN()
      // Bounded on both sides by the real clock around the call, which T0 (a
      // fixed instant) cannot satisfy — so this proves the fallback, not just
      // that *something* parseable was stamped.
      expect(stampedMs).toBeGreaterThanOrEqual(beforeMs)
      expect(stampedMs).toBeLessThanOrEqual(Date.now())
    }
  })

  it('never prompts yet — the prompt lands in #25 and its throttle in #26', async () => {
    const fresh = await resolveUpdateDecision(base({ exec: makeExec(), fs: new Volume() }))
    expect(fresh.isNewer).toBe(true)
    expect(fresh.shouldPrompt).toBe(false)
    const cached = await resolveUpdateDecision(
      base({
        exec: makeExec(),
        fs: seeded({ last_check_at: new Date(T0).toISOString(), latest_version: '0.2.0' }),
      }),
    )
    expect(cached.shouldPrompt).toBe(false)
  })

  it('forwards a caller-supplied timeoutMs to the npm call', async () => {
    const exec = makeExec()
    await resolveUpdateDecision(base({ exec, fs: new Volume(), timeoutMs: 77 }))
    expect(exec.calls[0].opts).toMatchObject({ timeout: 77, reject: false })
  })

  it('never reads or writes outside the injected home', async () => {
    // Every test in this file injects home + fs; this pins that the resolved
    // paths really do live under it, so no suite run can touch a real ~/.config.
    const fs = spyFs(new Volume())
    await resolveUpdateDecision(base({ exec: makeExec(), fs }))
    expect(fs.calls.length).toBeGreaterThan(0)
    for (const call of fs.calls) {
      expect(String(call.path).startsWith(join(HOME, '.config', 'ralph'))).toBe(true)
    }
  })
})
