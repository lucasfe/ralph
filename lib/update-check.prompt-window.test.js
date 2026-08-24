import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { readVersionCache, versionCachePath } from './version-cache.js'
import {
  recordPromptShown,
  resolveUpdateDecision,
  UPDATE_CHECK_INTERVAL_MS,
} from './update-check.js'

// #26: the SECOND weekly window. #24's last_check_at gates the network call;
// last_prompted_at gates the prompt, independently, off the same interval. This
// file owns the two halves that make that work:
//   - resolveUpdateDecision.shouldPrompt — isNewer AND the prompt window open,
//     computed from the CACHED latest_version whether or not a query happened;
//   - recordPromptShown — the stamp, written by the caller at the moment a
//     prompt is actually SHOWN, never by resolveUpdateDecision itself.
//
// Why the stamp is a separate seam: resolveUpdateDecision runs on every `ralph
// start`, including the headless ones (cron, launchd, CI) where no prompt is
// ever displayed. A stamp written there would burn the window on a run that
// never asked a human, suppressing the next INTERACTIVE run's prompt for a week.

const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')
const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()

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

const offline = async () => ({ exitCode: 1, stdout: '', stderr: 'offline', timedOut: false })

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

describe('resolveUpdateDecision — shouldPrompt is the 7-day PROMPT window', () => {
  it('prompts when the change is newer and nothing has been prompted yet', async () => {
    const result = await resolveUpdateDecision(base({ exec: makeExec(), fs: new Volume() }))
    expect(result.isNewer).toBe(true)
    expect(result.shouldPrompt).toBe(true)
  })

  it('does NOT prompt inside the window, even though the notice is still due', async () => {
    const result = await resolveUpdateDecision(
      base({
        exec: makeExec(),
        fs: seeded({
          last_check_at: iso(T0 - 30 * DAY),
          last_prompted_at: iso(T0 - 3 * DAY),
          latest_version: '0.2.0',
        }),
      }),
    )
    expect(result.isNewer).toBe(true)
    expect(result.shouldPrompt).toBe(false)
  })

  it('prompts again once the window has elapsed, for the SAME still-newer version', async () => {
    const result = await resolveUpdateDecision(
      base({
        exec: makeExec(),
        fs: seeded({
          last_check_at: iso(T0 - 30 * DAY),
          last_prompted_at: iso(T0 - 8 * DAY),
          latest_version: '0.2.0',
        }),
      }),
    )
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.shouldPrompt).toBe(true)
  })

  it('treats exactly 7 days as elapsed and one ms under as still throttled', async () => {
    const at = (delta) =>
      resolveUpdateDecision(
        base({
          exec: makeExec(),
          fs: seeded({
            last_check_at: iso(T0 - 30 * DAY),
            last_prompted_at: iso(T0 - UPDATE_CHECK_INTERVAL_MS + delta),
            latest_version: '0.2.0',
          }),
        }),
      )
    expect((await at(0)).shouldPrompt).toBe(true)
    expect((await at(1)).shouldPrompt).toBe(false)
  })

  it('treats a last_prompted_at in the FUTURE as prompt due (clock skew)', async () => {
    const result = await resolveUpdateDecision(
      base({
        exec: makeExec(),
        fs: seeded({
          last_check_at: iso(T0 - 30 * DAY),
          last_prompted_at: iso(T0 + 90 * DAY),
          latest_version: '0.2.0',
        }),
      }),
    )
    expect(result.shouldPrompt).toBe(true)
  })

  it('treats an unparseable or non-string last_prompted_at as prompt due', async () => {
    for (const bad of ['not-a-date', '', '   ', 'last tuesday', 12345, { iso: 'x' }, null]) {
      const result = await resolveUpdateDecision(
        base({
          exec: makeExec(),
          fs: seeded({
            last_check_at: iso(T0 - 30 * DAY),
            last_prompted_at: bad,
            latest_version: '0.2.0',
          }),
        }),
      )
      expect(result.shouldPrompt).toBe(true)
    }
  })

  it('never prompts when the version is not newer, however open the window', async () => {
    for (const [currentVersion, latest] of [
      ['0.2.0', '0.2.0'],
      ['0.3.0', '0.2.0'],
      ['unknown', '0.2.0'],
    ]) {
      const result = await resolveUpdateDecision(
        base({ currentVersion, exec: makeExec(okOut(latest)), fs: new Volume() }),
      )
      expect(result.isNewer).toBe(false)
      expect(result.shouldPrompt).toBe(false)
    }
  })

  it('never prompts when there is no version to offer at all', async () => {
    const result = await resolveUpdateDecision(base({ exec: makeExec(offline), fs: new Volume() }))
    expect(result.latestVersion).toBeNull()
    expect(result.shouldPrompt).toBe(false)
  })

  it('never prompts on the RALPH_NO_UPDATE_CHECK opt-out path', async () => {
    const result = await resolveUpdateDecision(
      base({
        exec: makeExec(),
        fs: seeded({ last_check_at: null, last_prompted_at: null, latest_version: '9.9.9' }),
        processEnv: { RALPH_NO_UPDATE_CHECK: '1' },
      }),
    )
    expect(result.source).toBe('disabled')
    expect(result.shouldPrompt).toBe(false)
  })

  it('resolving a decision NEVER stamps last_prompted_at itself (a headless run must not burn the window)', async () => {
    const vol = new Volume()
    const result = await resolveUpdateDecision(base({ exec: makeExec(), fs: vol }))
    expect(result.shouldPrompt).toBe(true)
    expect(result.updatedCache.last_prompted_at).toBeNull()
    expect(readVersionCache({ fs: vol, home: HOME, processEnv: {} }).last_prompted_at).toBeNull()
    // ...so the next run still has an open prompt window.
    const second = await resolveUpdateDecision(
      base({ exec: makeExec(), fs: vol, now: () => T0 + DAY }),
    )
    expect(second.source).toBe('cache')
    expect(second.shouldPrompt).toBe(true)
  })
})

describe('resolveUpdateDecision — the two windows are independent', () => {
  it('makes a network call WITHOUT prompting (check due, prompt throttled)', async () => {
    const exec = makeExec()
    const vol = seeded({
      last_check_at: iso(T0 - 8 * DAY),
      last_prompted_at: iso(T0 - DAY),
      latest_version: '0.1.5',
    })
    const result = await resolveUpdateDecision(base({ exec, fs: vol }))
    expect(exec.calls).toHaveLength(1)
    expect(result.source).toBe('network')
    expect(result.isNewer).toBe(true)
    expect(result.shouldPrompt).toBe(false)
    expect(readVersionCache({ fs: vol, home: HOME, processEnv: {} })).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0 - DAY),
      latest_version: '0.2.0',
    })
  })

  it('prompts WITHOUT making a network call (check throttled, prompt due) — served from cache', async () => {
    const exec = makeExec()
    const result = await resolveUpdateDecision(
      base({
        exec,
        fs: seeded({
          last_check_at: iso(T0 - DAY),
          last_prompted_at: null,
          latest_version: '0.2.0',
        }),
      }),
    )
    expect(exec.calls).toHaveLength(0)
    expect(result.source).toBe('cache')
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.shouldPrompt).toBe(true)
  })

  it('prompts from the cached version when the fresh query FAILS (offline)', async () => {
    const exec = makeExec(offline)
    const result = await resolveUpdateDecision(
      base({
        exec,
        fs: seeded({
          last_check_at: iso(T0 - 30 * DAY),
          last_prompted_at: null,
          latest_version: '0.2.0',
        }),
      }),
    )
    expect(exec.calls).toHaveLength(1)
    expect(result.source).toBe('network')
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.shouldPrompt).toBe(true)
  })

  it('stays silent offline when the cache holds nothing useful', async () => {
    for (const cache of [
      { last_check_at: iso(T0 - 30 * DAY), last_prompted_at: null, latest_version: null },
      { last_check_at: iso(T0 - DAY), last_prompted_at: null, latest_version: null },
      { last_check_at: iso(T0 - DAY), last_prompted_at: null, latest_version: '0.1.0' },
    ]) {
      const result = await resolveUpdateDecision(base({ exec: makeExec(offline), fs: seeded(cache) }))
      expect(result.isNewer).toBe(false)
      expect(result.shouldPrompt).toBe(false)
    }
  })
})

describe('recordPromptShown', () => {
  it('stamps last_prompted_at at `now` and preserves last_check_at and latest_version', () => {
    const vol = seeded({
      last_check_at: iso(T0 - 2 * DAY),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
    const written = recordPromptShown({ fs: vol, home: HOME, processEnv: {}, now: () => T0 })
    expect(written).toEqual({
      last_check_at: iso(T0 - 2 * DAY),
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
    expect(readVersionCache({ fs: vol, home: HOME, processEnv: {} })).toEqual(written)
  })

  it('creates the cache when there is none, stamping only the prompt field', () => {
    const vol = new Volume()
    recordPromptShown({ fs: vol, home: HOME, processEnv: {}, now: () => T0 })
    expect(readVersionCache({ fs: vol, home: HOME, processEnv: {} })).toEqual({
      last_check_at: null,
      last_prompted_at: iso(T0),
      latest_version: null,
    })
  })

  it('re-stamps an older prompt window rather than leaving it', () => {
    const vol = seeded({
      last_check_at: iso(T0 - 8 * DAY),
      last_prompted_at: iso(T0 - 8 * DAY),
      latest_version: '0.2.0',
    })
    recordPromptShown({ fs: vol, home: HOME, processEnv: {}, now: () => T0 })
    expect(readVersionCache({ fs: vol, home: HOME, processEnv: {} }).last_prompted_at).toBe(iso(T0))
  })

  it('writes ONLY the three known fields — a hand-added declined_version is dropped', () => {
    const vol = seeded({
      last_check_at: iso(T0 - DAY),
      last_prompted_at: null,
      latest_version: '0.2.0',
      declined_version: '0.2.0',
    })
    recordPromptShown({ fs: vol, home: HOME, processEnv: {}, now: () => T0 })
    const raw = JSON.parse(vol.readFileSync(CACHE_PATH, 'utf8').toString())
    expect(Object.keys(raw).sort()).toEqual([
      'last_check_at',
      'last_prompted_at',
      'latest_version',
    ])
    expect(raw.declined_version).toBeUndefined()
  })

  it('honours $XDG_CONFIG_HOME, the same as every other cache write', () => {
    const vol = new Volume()
    const processEnv = { XDG_CONFIG_HOME: '/xdg' }
    recordPromptShown({ fs: vol, home: HOME, processEnv, now: () => T0 })
    expect(vol.existsSync(versionCachePath({ processEnv, home: HOME }))).toBe(true)
    expect(vol.existsSync(CACHE_PATH)).toBe(false)
  })

  it('closes the window: a decision resolved after the stamp does not prompt again', async () => {
    const vol = new Volume()
    const first = await resolveUpdateDecision(base({ exec: makeExec(), fs: vol }))
    expect(first.shouldPrompt).toBe(true)
    recordPromptShown({ fs: vol, home: HOME, processEnv: {}, now: () => T0 })
    const second = await resolveUpdateDecision(
      base({ exec: makeExec(), fs: vol, now: () => T0 + 6 * DAY }),
    )
    expect(second.isNewer).toBe(true)
    expect(second.shouldPrompt).toBe(false)
    const third = await resolveUpdateDecision(
      base({ exec: makeExec(), fs: vol, now: () => T0 + 8 * DAY }),
    )
    expect(third.shouldPrompt).toBe(true)
  })

  it('never throws when the cache cannot be written, and reports the failure as null', () => {
    const fs = {
      readFileSync: () => {
        const e = new Error('ENOENT')
        e.code = 'ENOENT'
        throw e
      },
      mkdirSync: () => {
        const e = new Error('EROFS: read-only file system')
        e.code = 'EROFS'
        throw e
      },
      writeFileSync: () => {
        throw new Error('should not get here')
      },
    }
    expect(recordPromptShown({ fs, home: HOME, processEnv: {}, now: () => T0 })).toBeNull()
  })

  it('never throws on a corrupt cache — it is replaced by a well-formed stamped one', () => {
    const vol = Volume.fromJSON({ [CACHE_PATH]: '{ mangled' }, '/')
    recordPromptShown({ fs: vol, home: HOME, processEnv: {}, now: () => T0 })
    expect(readVersionCache({ fs: vol, home: HOME, processEnv: {} })).toEqual({
      last_check_at: null,
      last_prompted_at: iso(T0),
      latest_version: null,
    })
  })

  it('never throws on a hostile home / env bag / fs', () => {
    // Same boundary rule as resolveUpdateDecision: versionCachePath() runs before
    // any try block inside version-cache.js, so a non-string home or a truthy
    // non-string XDG_CONFIG_HOME throws a TypeError out of join()/trim().
    for (const args of [
      { fs: new Volume(), home: null, processEnv: {} },
      { fs: new Volume(), home: 42, processEnv: {} },
      { fs: new Volume(), home: HOME, processEnv: { XDG_CONFIG_HOME: 7 } },
      { fs: new Volume(), home: HOME, processEnv: null },
      { fs: {}, home: HOME, processEnv: {} },
      { fs: null, home: HOME, processEnv: {} },
      // Never a defaulted fs/home in this suite: that would resolve the REAL
      // ~/.config/ralph and write to the developer's machine.
      { fs: new Volume(), home: HOME, processEnv: { XDG_CONFIG_HOME: '' } },
      {
        fs: {
          readFileSync: () => '{}',
          mkdirSync: () => {
            throw new Error('boom')
          },
          writeFileSync: () => undefined,
        },
        home: HOME,
        processEnv: {},
      },
    ]) {
      expect(() => recordPromptShown(args)).not.toThrow()
    }
  })

  it('falls back to the real clock for a `now` that is not a usable function', () => {
    for (const now of [
      undefined,
      T0,
      () => NaN,
      () => 'nope',
      () => 8.64e15 + 1,
      () => {
        throw new Error('x')
      },
    ]) {
      const vol = new Volume()
      const before = Date.now()
      recordPromptShown({ fs: vol, home: HOME, processEnv: {}, now })
      const stamped = Date.parse(
        readVersionCache({ fs: vol, home: HOME, processEnv: {} }).last_prompted_at,
      )
      expect(stamped).not.toBeNaN()
      expect(stamped).toBeGreaterThanOrEqual(before)
      expect(stamped).toBeLessThanOrEqual(Date.now())
    }
  })
})
