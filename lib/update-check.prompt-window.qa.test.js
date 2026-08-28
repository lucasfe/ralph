import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Volume } from 'memfs'
import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_VERSION_CACHE, readVersionCache, versionCachePath } from './version-cache.js'
import { doctorCommand } from './commands/doctor.js'
import {
  recordPromptShown,
  resolveUpdateDecision,
  UPDATE_CHECK_INTERVAL_MS,
} from './update-check.js'

// #26 QA augmentation — the prompt-window half of update-check.js. The dev's
// lib/update-check.prompt-window.test.js proves the acceptance criteria
// (shouldPrompt is the window, the two windows are independent, recordPromptShown
// stamps only last_prompted_at, and every hostile input ends in null rather than a
// throw). This file attacks what is left:
//   - the window BOUNDARY as a full matrix, asserted on the network path AND the
//     throttled cache path, and cross-checked against the CHECK window so the two
//     cannot silently drift apart (same reader today — a refactor could split them);
//   - last_prompted_at values that are malformed in every way a hand-edit or a
//     foreign writer can produce: wrong types, blank, non-ISO, leniently-parsed,
//     expanded-year, and a whole cache file that is an array / string / null /
//     number;
//   - declined_version: dropped on write, never resurrected across runs, and
//     unable to suppress a re-offer once the window rolls over;
//   - recordPromptShown called with garbage — a clock that returns Infinity or
//     throws, an fs that fails after a partial write, an fs missing methods, a null
//     env bag, a non-string home — always asserting what landed on disk, not just
//     "did not throw";
//   - the write contract: the fixed three-field shape, and idempotence when the
//     same instant is stamped twice (the only byte-level assertion left here, and
//     it compares two outputs of the serializer rather than hardcoding its
//     format — that format is version-cache.qa.test.js's to pin);
//   - the two windows CROSSING: a stamp taken after a network refresh must not
//     resurrect the pre-refresh latest_version, and a refresh taken after a stamp
//     must carry the stamp through.
//
// Hermeticity: every call passes BOTH `fs` (a memfs Volume or a fake) and, except
// in the one test whose subject is the `home` default (which still injects a memfs
// fs), `home`. recordPromptShown is NEVER called with a defaulted fs — that would
// write to the developer's real ~/.config/ralph. The beforeAll/afterAll pair below
// is the tripwire that proves it.

const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')
const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const WEEK = UPDATE_CHECK_INTERVAL_MS
const iso = (ms) => new Date(ms).toISOString()

// The REAL cache path this machine would use. Nothing here may touch it.
const REAL_CACHE_PATH = versionCachePath()
const realCacheSnapshot = () =>
  realExistsSync(REAL_CACHE_PATH) ? realReadFileSync(REAL_CACHE_PATH, 'utf8') : null

let realBefore
beforeAll(() => {
  realBefore = realCacheSnapshot()
})
afterAll(() => {
  expect(realCacheSnapshot()).toBe(realBefore)
})

function makeExec(handler = okOut('0.2.0')) {
  const calls = []
  const exec = async (cmd, args, opts) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, opts })
    return handler({ cmd, args, opts })
  }
  exec.calls = calls
  return exec
}

const okOut = (stdout) => async () => ({ exitCode: 0, stdout, stderr: '', timedOut: false })

const seeded = (cache) => Volume.fromJSON({ [CACHE_PATH]: JSON.stringify(cache) }, '/')
const seededRaw = (raw) => Volume.fromJSON({ [CACHE_PATH]: raw }, '/')

function spyFs(v) {
  const ops = []
  return {
    ops,
    writes: () => ops.filter((o) => o.op === 'write'),
    readFileSync: (...a) => {
      ops.push({ op: 'read', path: String(a[0]) })
      return v.readFileSync(...a)
    },
    writeFileSync: (...a) => {
      ops.push({ op: 'write', path: String(a[0]), data: String(a[1]) })
      return v.writeFileSync(...a)
    },
    mkdirSync: (...a) => {
      ops.push({ op: 'mkdir', path: String(a[0]) })
      return v.mkdirSync(...a)
    },
    statSync: (...a) => v.statSync(...a),
    existsSync: (...a) => v.existsSync(...a),
  }
}

const base = (overrides = {}) => ({
  currentVersion: '0.1.0',
  now: () => T0,
  home: HOME,
  processEnv: {},
  ...overrides,
})

const cacheOf = (fs) => readVersionCache({ fs, home: HOME, processEnv: {} })
const stamp = (fs, nowMs = T0) =>
  recordPromptShown({ fs, home: HOME, processEnv: {}, now: () => nowMs })
const rawOf = (fs) => fs.readFileSync(CACHE_PATH, 'utf8').toString()

describe('QA #26 the prompt window boundary is the same boundary on every path', () => {
  // age = how long ago the stamp was, relative to `now`. Negative = the future.
  const cases = [
    ['one ms past the window', WEEK + 1, true],
    ['a full day past the window', WEEK + DAY, true],
    ['exactly one week', WEEK, true],
    ['one ms inside the window', WEEK - 1, false],
    ['a minute old', 60_000, false],
    ['one ms old', 1, false],
    ['stamped at this very instant (now === stamped)', 0, false],
    ['one ms in the future', -1, true],
    ['a day in the future', -DAY, true],
    ['a year in the future', -365 * DAY, true],
    ['a year in the past', 365 * DAY, true],
    ['epoch 0', T0, true],
  ]

  for (const [label, age, due] of cases) {
    it(`${label} → shouldPrompt ${due}, identically on the network and the cache path`, async () => {
      // Network path: the check window is wide open, so a registry query happens
      // and cannot be what decides the question.
      const network = await resolveUpdateDecision(
        base({
          exec: makeExec(),
          fs: seeded({
            last_check_at: iso(T0 - 30 * DAY),
            last_prompted_at: iso(T0 - age),
            latest_version: '0.1.5',
          }),
        }),
      )
      // Cache path: the check window is shut, so the version is served from the
      // cache — the prompt window's verdict must be exactly the same.
      const cached = await resolveUpdateDecision(
        base({
          exec: makeExec(),
          fs: seeded({
            last_check_at: iso(T0 - DAY),
            last_prompted_at: iso(T0 - age),
            latest_version: '0.2.0',
          }),
        }),
      )
      expect(network.source).toBe('network')
      expect(cached.source).toBe('cache')
      expect(network.isNewer).toBe(true)
      expect(cached.isNewer).toBe(true)
      expect({ label, network: network.shouldPrompt, cached: cached.shouldPrompt }).toEqual({
        label,
        network: due,
        cached: due,
      })
    })
  }

  it('the CHECK window and the PROMPT window agree on every one of those values', async () => {
    // They share one reader today. If a refactor splits them, the two windows must
    // still open and close on the same boundary — #26 specifies one interval, used
    // twice, not two interval semantics.
    for (const [label, age, due] of cases) {
      const checkOnly = await resolveUpdateDecision(
        base({
          exec: makeExec(),
          fs: seeded({
            last_check_at: iso(T0 - age),
            last_prompted_at: null,
            latest_version: '0.2.0',
          }),
        }),
      )
      const promptOnly = await resolveUpdateDecision(
        base({
          exec: makeExec(),
          fs: seeded({
            last_check_at: iso(T0 - 30 * DAY),
            last_prompted_at: iso(T0 - age),
            latest_version: '0.2.0',
          }),
        }),
      )
      expect({ label, checkDue: checkOnly.source === 'network' }).toEqual({ label, checkDue: due })
      expect({ label, promptDue: promptOnly.shouldPrompt }).toEqual({ label, promptDue: due })
    }
  })

  it('re-offers at exactly one week after the stamp it wrote itself (round trip)', async () => {
    const vol = new Volume()
    expect((await resolveUpdateDecision(base({ exec: makeExec(), fs: vol }))).shouldPrompt).toBe(true)
    stamp(vol, T0)
    const oneMsShort = await resolveUpdateDecision(
      base({ exec: makeExec(), fs: vol, now: () => T0 + WEEK - 1 }),
    )
    const exactly = await resolveUpdateDecision(
      base({ exec: makeExec(), fs: vol, now: () => T0 + WEEK }),
    )
    expect(oneMsShort.shouldPrompt).toBe(false)
    expect(exactly.shouldPrompt).toBe(true)
  })
})

describe('QA #26 a malformed last_prompted_at always means "prompt due"', () => {
  // Every one of these must open the window rather than closing it forever: an
  // unreadable stamp is indistinguishable from no stamp, and #26's rule is that a
  // deferred release is re-offered, never permanently forgotten.
  const bad = [
    ['a number', 12345],
    ['zero', 0],
    ['a negative number', -1],
    ['epoch ms of a moment inside the window', T0 - DAY],
    ['true', true],
    ['false', false],
    ['an object', { at: '2026-08-22T12:00:00.000Z' }],
    ['an array', ['2026-08-22T12:00:00.000Z']],
    ['an empty array', []],
    ['an empty string', ''],
    ['spaces', '   '],
    ['a tab and a newline', '\t\n'],
    ['null', null],
    ['undefined (key absent)', undefined],
    ['a non-ISO word', 'not-a-date'],
    ['prose', 'tomorrow'],
    ['an impossible ISO date', '2026-13-45'],
    ['an impossible month', '2026-99-01T00:00:00.000Z'],
    ['the literal "null"', 'null'],
    ['the literal "NaN"', 'NaN'],
    ['an unpadded expanded year', '275760-09-13'],
    ['the maximum representable instant', '+275760-09-13T00:00:00.000Z'],
    ['the minimum representable instant', '-271821-04-20T00:00:00.000Z'],
    ['year zero', '0000-01-01T00:00:00.000Z'],
  ]

  for (const [label, value] of bad) {
    it(`${label} → prompt due`, async () => {
      const result = await resolveUpdateDecision(
        base({
          exec: makeExec(),
          fs: seeded({
            last_check_at: iso(T0 - DAY),
            last_prompted_at: value,
            latest_version: '0.2.0',
          }),
        }),
      )
      expect({ label, shouldPrompt: result.shouldPrompt }).toEqual({ label, shouldPrompt: true })
    })
  }

  it('accepts the date formats Date.parse accepts, without an ISO regex of its own', async () => {
    // The reader is Date.parse, so anything it understands throttles. The two
    // timezone-less forms are parsed as LOCAL time, which can shift the instant by
    // up to ±14h — three days ago stays inside a seven-day window in every zone,
    // and a month ahead stays in the future in every zone, so these are stable
    // wherever `npm test` runs.
    const throttled = [
      '2026-08-19T12:00:00.000Z',
      '2026-08-19T12:00:00',
      '2026-08-19',
      'Wed, 19 Aug 2026 12:00:00 GMT',
      '2026-08-19T14:00:00+02:00',
      '  2026-08-19T12:00:00.000Z  ',
    ]
    for (const value of throttled) {
      const result = await resolveUpdateDecision(
        base({
          exec: makeExec(),
          fs: seeded({
            last_check_at: iso(T0 - DAY),
            last_prompted_at: value,
            latest_version: '0.2.0',
          }),
        }),
      )
      expect({ value, shouldPrompt: result.shouldPrompt }).toEqual({ value, shouldPrompt: false })
    }
    // ...and a leniently-parsed stamp in the FUTURE is still due, not a window
    // that outlives every clock correction.
    const future = await resolveUpdateDecision(
      base({
        exec: makeExec(),
        fs: seeded({
          last_check_at: iso(T0 - DAY),
          last_prompted_at: '2026-09-22T12:00:00',
          latest_version: '0.2.0',
        }),
      }),
    )
    expect(future.shouldPrompt).toBe(true)
  })
})

describe('QA #26 a cache file that is not an object at all', () => {
  const hostile = [
    ['an empty file', ''],
    ['whitespace', '   \n'],
    ['truncated JSON', '{ "last_prompted_at": '],
    ['mangled JSON', '{ mangled'],
    ['a JSON array', '[]'],
    ['a JSON array holding a fresh stamp', `[{"last_prompted_at":"${iso(T0)}"}]`],
    ['a JSON string', '"2026-08-22T12:00:00.000Z"'],
    ['JSON null', 'null'],
    ['a JSON number', '42'],
    ['a JSON boolean', 'true'],
    ['a JSON object nested one level deep', `{"cache":{"last_prompted_at":"${iso(T0)}"}}`],
  ]

  for (const [label, raw] of hostile) {
    it(`${label} → both windows due, and the run repairs the file`, async () => {
      const vol = seededRaw(raw)
      const exec = makeExec()
      const result = await resolveUpdateDecision(base({ exec, fs: vol }))
      expect({ label, calls: exec.calls.length }).toEqual({ label, calls: 1 })
      expect({ label, shouldPrompt: result.shouldPrompt }).toEqual({ label, shouldPrompt: true })
      expect(stamp(vol, T0)).not.toBeNull()
      expect(cacheOf(vol)).toEqual({
        last_check_at: iso(T0),
        last_prompted_at: iso(T0),
        latest_version: '0.2.0',
      })
    })
  }
})

describe('QA #26 there is no declined_version, anywhere', () => {
  it('is dropped by the DECISION write, not only by the stamp', async () => {
    const vol = seeded({
      last_check_at: iso(T0 - 30 * DAY),
      last_prompted_at: null,
      latest_version: '0.1.5',
      declined_version: '0.2.0',
      declinedVersion: '0.2.0',
      snoozed_until: iso(T0 + 30 * DAY),
    })
    await resolveUpdateDecision(base({ exec: makeExec(), fs: vol }))
    const raw = rawOf(vol)
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'last_check_at',
      'last_prompted_at',
      'latest_version',
    ])
    expect(raw).not.toMatch(/declined/i)
    expect(raw).not.toMatch(/snooz/i)
  })

  it('cannot be resurrected by a later stamp, decision, or re-read', async () => {
    const vol = seeded({
      last_check_at: iso(T0 - 30 * DAY),
      last_prompted_at: null,
      latest_version: '0.2.0',
      declined_version: '0.2.0',
    })
    await resolveUpdateDecision(base({ exec: makeExec(), fs: vol }))
    stamp(vol, T0)
    await resolveUpdateDecision(base({ exec: makeExec(), fs: vol, now: () => T0 + 8 * DAY }))
    stamp(vol, T0 + 8 * DAY)
    expect(rawOf(vol)).not.toMatch(/declined/i)
    expect(readVersionCache({ fs: vol, home: HOME, processEnv: {} })).toEqual({
      last_check_at: iso(T0 + 8 * DAY),
      last_prompted_at: iso(T0 + 8 * DAY),
      latest_version: '0.2.0',
    })
  })

  it('a declined_version on disk cannot suppress the re-offer after the window rolls over', async () => {
    // The failure mode the field is banned to prevent: a run that declines 0.2.0
    // and then never hears about it again. The window — and only the window —
    // decides.
    const vol = seeded({
      last_check_at: iso(T0 - DAY),
      last_prompted_at: iso(T0 - 8 * DAY),
      latest_version: '0.2.0',
      declined_version: '0.2.0',
    })
    const result = await resolveUpdateDecision(base({ exec: makeExec(), fs: vol }))
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.shouldPrompt).toBe(true)
  })

  it('the empty cache shape has exactly the three #26 fields', () => {
    expect(Object.keys(EMPTY_VERSION_CACHE).sort()).toEqual([
      'last_check_at',
      'last_prompted_at',
      'latest_version',
    ])
  })
})

describe('QA #26 recordPromptShown with a broken clock', () => {
  it('falls back to the real clock for Infinity, -Infinity, a string, an object and a thrower', () => {
    for (const now of [
      () => Infinity,
      () => -Infinity,
      () => NaN,
      () => '2026-08-22T12:00:00.000Z',
      () => ({ valueOf: () => T0 }),
      () => null,
      () => undefined,
      () => [],
      () => {
        throw new TypeError('clock exploded')
      },
      null,
      42,
      'now',
      {},
    ]) {
      const vol = new Volume()
      const before = Date.now()
      const written = recordPromptShown({ fs: vol, home: HOME, processEnv: {}, now })
      const stampedMs = Date.parse(written.last_prompted_at)
      expect(Number.isFinite(stampedMs)).toBe(true)
      expect(stampedMs).toBeGreaterThanOrEqual(before)
      expect(stampedMs).toBeLessThanOrEqual(Date.now())
      expect(cacheOf(vol).last_prompted_at).toBe(written.last_prompted_at)
    }
  })

  it('accepts the extreme instants Date can represent, and treats them as due next run', async () => {
    for (const nowMs of [8.64e15, -8.64e15, 0]) {
      const vol = new Volume()
      const written = recordPromptShown({
        fs: vol,
        home: HOME,
        processEnv: {},
        now: () => nowMs,
      })
      expect(written.last_prompted_at).toBe(iso(nowMs))
      // A stamp at the far edge of time is either in the future or ancient, so the
      // next run is due — never a window that cannot expire.
      const next = await resolveUpdateDecision(base({ exec: makeExec(), fs: vol }))
      expect({ nowMs, shouldPrompt: next.shouldPrompt }).toEqual({ nowMs, shouldPrompt: true })
    }
  })

  it('a clock one ms beyond the representable range degrades to the real clock, not a RangeError', () => {
    const vol = new Volume()
    expect(() =>
      recordPromptShown({ fs: vol, home: HOME, processEnv: {}, now: () => 8.64e15 + 1 }),
    ).not.toThrow()
    expect(Date.parse(cacheOf(vol).last_prompted_at)).not.toBeNaN()
  })
})

describe('QA #26 recordPromptShown with a broken fs', () => {
  const enoent = () => {
    const e = new Error('ENOENT')
    e.code = 'ENOENT'
    throw e
  }

  it('returns null when writeFileSync throws after mkdir succeeded', () => {
    const attempts = []
    const fs = {
      readFileSync: enoent,
      mkdirSync: (p) => attempts.push(`mkdir:${p}`),
      writeFileSync: (p) => {
        attempts.push(`write:${p}`)
        const e = new Error('ENOSPC: no space left on device')
        e.code = 'ENOSPC'
        throw e
      },
    }
    expect(stamp(fs, T0)).toBeNull()
    expect(attempts).toEqual([`mkdir:${join(HOME, '.config', 'ralph')}`, `write:${CACHE_PATH}`])
  })

  it('returns null when a partial write leaves the file corrupt, and the next read recovers', () => {
    const vol = new Volume()
    const fs = {
      readFileSync: (...a) => vol.readFileSync(...a),
      mkdirSync: (...a) => vol.mkdirSync(...a),
      writeFileSync: (p, data) => {
        // Half the bytes land, then the device gives up.
        vol.writeFileSync(p, String(data).slice(0, 20))
        throw new Error('EIO: i/o error')
      },
    }
    expect(stamp(fs, T0)).toBeNull()
    expect(cacheOf(vol)).toEqual({ ...EMPTY_VERSION_CACHE })
    // ...and a later healthy write repairs it rather than compounding the damage.
    expect(stamp(vol, T0 + DAY)).not.toBeNull()
    expect(cacheOf(vol).last_prompted_at).toBe(iso(T0 + DAY))
  })

  it('returns null when mkdirSync throws, without attempting a write', () => {
    const attempts = []
    const fs = {
      readFileSync: () => '{}',
      mkdirSync: () => {
        const e = new Error('EROFS: read-only file system')
        e.code = 'EROFS'
        throw e
      },
      writeFileSync: (p) => attempts.push(p),
    }
    expect(stamp(fs, T0)).toBeNull()
    expect(attempts).toEqual([])
  })

  it('returns null for an fs missing the methods it needs', () => {
    for (const fs of [
      {},
      null,
      42,
      'fs',
      () => undefined,
      { readFileSync: () => '{}' },
      { mkdirSync: () => undefined },
      { readFileSync: () => '{}', mkdirSync: () => undefined },
      { readFileSync: () => '{}', writeFileSync: () => undefined },
      Object.create(null),
    ]) {
      let result
      expect(() => {
        result = stamp(fs, T0)
      }).not.toThrow()
      expect(result).toBeNull()
    }
  })

  it('returns null and writes NOTHING for a non-string home', () => {
    for (const home of [null, 42, {}, [], true, Symbol.iterator]) {
      const vol = new Volume()
      let result
      expect(() => {
        result = recordPromptShown({ fs: vol, home, processEnv: {}, now: () => T0 })
      }).not.toThrow()
      expect(result).toBeNull()
      expect(vol.toJSON()).toEqual({})
    }
  })

  it('returns null and writes NOTHING for a truthy non-string XDG_CONFIG_HOME', () => {
    for (const XDG_CONFIG_HOME of [7, {}, [], true]) {
      const vol = new Volume()
      expect(
        recordPromptShown({ fs: vol, home: HOME, processEnv: { XDG_CONFIG_HOME }, now: () => T0 }),
      ).toBeNull()
      expect(vol.toJSON()).toEqual({})
    }
  })

  it('resolves the cache under the injected home for a null or blank-XDG env bag', () => {
    for (const processEnv of [null, {}, { XDG_CONFIG_HOME: '' }, { XDG_CONFIG_HOME: '  ' }]) {
      const vol = new Volume()
      expect(recordPromptShown({ fs: vol, home: HOME, processEnv, now: () => T0 })).toEqual({
        ...EMPTY_VERSION_CACHE,
        last_prompted_at: iso(T0),
      })
      expect(vol.existsSync(CACHE_PATH)).toBe(true)
    }
  })

  it('falls back to the AMBIENT env bag when processEnv is omitted, still through the injected fs', () => {
    // `processEnv` omitted means process.env, which may or may not set
    // XDG_CONFIG_HOME on the machine running the suite — so the expected path is
    // derived the same way rather than hardcoded.
    const vol = new Volume()
    expect(recordPromptShown({ fs: vol, home: HOME, now: () => T0 }).last_prompted_at).toBe(iso(T0))
    expect(vol.existsSync(versionCachePath({ processEnv: process.env, home: HOME }))).toBe(true)
  })

  it('honours a string XDG_CONFIG_HOME and writes nowhere else', () => {
    const vol = new Volume()
    const processEnv = { XDG_CONFIG_HOME: '/xdg/config' }
    stamp(vol, T0)
    recordPromptShown({ fs: vol, home: HOME, processEnv, now: () => T0 + DAY })
    expect(Object.keys(vol.toJSON()).sort()).toEqual(
      [CACHE_PATH, versionCachePath({ processEnv, home: HOME })].sort(),
    )
  })

  it('resolves the DEFAULT home through the INJECTED fs, so no real file is touched', () => {
    // The one test that exercises the `home` default. `fs` is still a memfs
    // Volume, so the resolved real-looking path is created inside the volume and
    // never on disk — the afterAll tripwire above proves it.
    const vol = new Volume()
    const written = recordPromptShown({ fs: vol, now: () => T0 })
    expect(written.last_prompted_at).toBe(iso(T0))
    expect(vol.existsSync(REAL_CACHE_PATH)).toBe(true)
  })
})

describe('QA #26 the write is the fixed three-field shape', () => {
  it('carries last_check_at and latest_version through, and adds only the stamp', () => {
    // Fields, not bytes: the SERIALIZER's contract (2-space indent, key order, one
    // trailing newline) belongs to writeVersionCache and is asserted in
    // version-cache.qa.test.js. Pinning it here would send a maintainer who
    // changed the serializer to the wrong module.
    const vol = seeded({
      last_check_at: iso(T0 - 2 * DAY),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
    stamp(vol, T0)
    expect(JSON.parse(rawOf(vol))).toEqual({
      last_check_at: iso(T0 - 2 * DAY),
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
  })

  it('stamping the same instant twice is byte-identical (idempotent)', () => {
    const vol = seeded({
      last_check_at: iso(T0 - 2 * DAY),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
    stamp(vol, T0)
    const first = rawOf(vol)
    const returned = stamp(vol, T0)
    expect(rawOf(vol)).toBe(first)
    expect(returned).toEqual(JSON.parse(first))
  })

  it('stamping again later changes ONLY last_prompted_at', () => {
    const vol = seeded({
      last_check_at: iso(T0 - 2 * DAY),
      last_prompted_at: iso(T0 - 9 * DAY),
      latest_version: '0.2.0',
    })
    const before = JSON.parse(rawOf(vol))
    stamp(vol, T0)
    const afterFirst = JSON.parse(rawOf(vol))
    stamp(vol, T0 + DAY)
    const afterSecond = JSON.parse(rawOf(vol))
    expect(afterFirst).toEqual({ ...before, last_prompted_at: iso(T0) })
    expect(afterSecond).toEqual({ ...before, last_prompted_at: iso(T0 + DAY) })
  })

  it('the returned object always equals what a fresh read sees', () => {
    for (const seed of [
      { last_check_at: iso(T0 - DAY), last_prompted_at: iso(T0 - DAY), latest_version: '0.2.0' },
      { last_check_at: null, last_prompted_at: null, latest_version: null },
      { last_check_at: '  ', last_prompted_at: 5, latest_version: '  0.2.0  ' },
    ]) {
      const vol = seeded(seed)
      expect(stamp(vol, T0)).toEqual(cacheOf(vol))
    }
  })

  it('writes exactly once per call, always to the cache path', () => {
    const fs = spyFs(new Volume())
    stamp(fs, T0)
    stamp(fs, T0 + DAY)
    expect(fs.writes().map((o) => o.path)).toEqual([CACHE_PATH, CACHE_PATH])
    expect(fs.ops.filter((o) => o.op === 'mkdir').map((o) => o.path)).toEqual([
      join(HOME, '.config', 'ralph'),
      join(HOME, '.config', 'ralph'),
    ])
  })
})

describe('QA #26 the two windows crossing over one file', () => {
  it('a stamp taken AFTER a network refresh cannot resurrect the pre-refresh values', async () => {
    // The ordering start.js uses: the decision writes first, then the stamp
    // re-reads. If recordPromptShown snapshotted the cache before the refresh, the
    // stale latest_version and last_check_at would come back — re-opening the
    // check window a week early and re-offering a version nobody publishes.
    const vol = seeded({
      last_check_at: iso(T0 - 30 * DAY),
      last_prompted_at: iso(T0 - 30 * DAY),
      latest_version: '0.1.5',
    })
    const decision = await resolveUpdateDecision(base({ exec: makeExec(okOut('0.3.0')), fs: vol }))
    expect(decision.source).toBe('network')
    expect(decision.shouldPrompt).toBe(true)
    stamp(vol, T0)
    expect(cacheOf(vol)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0),
      latest_version: '0.3.0',
    })
  })

  it('a network refresh taken AFTER a stamp carries the stamp through untouched', async () => {
    const vol = seeded({
      last_check_at: iso(T0 - 30 * DAY),
      last_prompted_at: iso(T0 - 30 * DAY),
      latest_version: '0.1.5',
    })
    stamp(vol, T0)
    const decision = await resolveUpdateDecision(
      base({ exec: makeExec(okOut('0.3.0')), fs: vol, now: () => T0 + 1000 }),
    )
    expect(decision.source).toBe('network')
    expect(decision.shouldPrompt).toBe(false)
    expect(cacheOf(vol)).toEqual({
      last_check_at: iso(T0 + 1000),
      last_prompted_at: iso(T0),
      latest_version: '0.3.0',
    })
  })

  it('fresh check + ancient prompt: no spawn, prompt due, and the check stamp survives the stamp', async () => {
    const checkedAt = iso(T0 - DAY)
    const vol = seeded({
      last_check_at: checkedAt,
      last_prompted_at: iso(T0 - 30 * DAY),
      latest_version: '0.2.0',
    })
    const exec = makeExec()
    const decision = await resolveUpdateDecision(base({ exec, fs: vol }))
    expect(exec.calls).toHaveLength(0)
    expect(decision.shouldPrompt).toBe(true)
    stamp(vol, T0)
    expect(cacheOf(vol)).toEqual({
      last_check_at: checkedAt,
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
  })

  it('ancient check + fresh prompt: one spawn, no prompt, and the prompt stamp is byte-exact', async () => {
    const promptedAt = iso(T0 - 2 * DAY)
    const vol = seeded({
      last_check_at: iso(T0 - 30 * DAY),
      last_prompted_at: promptedAt,
      latest_version: '0.1.5',
    })
    const exec = makeExec()
    const decision = await resolveUpdateDecision(base({ exec, fs: vol }))
    expect(exec.calls).toHaveLength(1)
    expect(decision.isNewer).toBe(true)
    expect(decision.shouldPrompt).toBe(false)
    expect(JSON.parse(rawOf(vol)).last_prompted_at).toBe(promptedAt)
  })

  it('both windows stamped over one cache costs exactly two writes', async () => {
    const fs = spyFs(new Volume())
    await resolveUpdateDecision(base({ exec: makeExec(), fs }))
    stamp(fs, T0)
    const writes = fs.writes()
    expect(writes.map((o) => o.path)).toEqual([CACHE_PATH, CACHE_PATH])
    // The second write contains the first's values — proof the re-read, not a
    // snapshot, is what the stamp builds on.
    expect(JSON.parse(writes[1].data)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
  })

  it('a decision resolved from a cache that a concurrent stamp has already closed does not prompt', async () => {
    // Interleaving: the stamp lands between two decisions on the same file. The
    // second decision must see it, because both windows live in that one file.
    const vol = new Volume()
    const first = await resolveUpdateDecision(base({ exec: makeExec(), fs: vol }))
    expect(first.shouldPrompt).toBe(true)
    stamp(vol, T0)
    const second = await resolveUpdateDecision(base({ exec: makeExec(), fs: vol, now: () => T0 }))
    expect(second.source).toBe('cache')
    expect(second.shouldPrompt).toBe(false)
    // ...and the check window is likewise closed, so nothing was re-queried.
    expect(second.latestVersion).toBe('0.2.0')
  })

  it('a run that only READS the cache cannot move either window', async () => {
    // #27's `ralph doctor` version line shares this one file. It is documented as
    // read-only; if it ever gained a write that rebuilt the cache from its own two
    // fields, normalizeCache would null last_prompted_at and every `ralph doctor`
    // would silently re-open the prompt window.
    const promptedAt = iso(T0 - DAY)
    const vol = seeded({
      last_check_at: iso(T0 - DAY),
      last_prompted_at: promptedAt,
      latest_version: '0.2.0',
    })
    const fs = spyFs(vol)
    const lines = []
    const sink = { write: (s) => lines.push(String(s)) }
    const result = await doctorCommand({
      stdout: sink,
      stderr: sink,
      hasCommand: () => true,
      env: {},
      currentVersion: '0.1.0',
      cacheFs: fs,
      home: HOME,
      // #75: doctor reads ralph.config.sh for RALPH_BANNER. Stubbed away here so this test
      // stays about the CACHE file — and so a developer with a config in their checkout
      // cannot change what it asserts.
      cwd: '/repo',
      exists: () => false,
    })
    expect(result.exitCode).toBe(0)
    // #75 folded the version line into the identity box; the verdict it carries is the same
    // reading of the same cache, worded as the box words it.
    expect(lines.join('')).toContain('0.2.0 available')
    expect(fs.writes()).toHaveLength(0)
    expect(cacheOf(vol).last_prompted_at).toBe(promptedAt)
    // ...and the window it left alone is still closed for the next decision.
    const next = await resolveUpdateDecision(base({ exec: makeExec(), fs: vol }))
    expect(next.shouldPrompt).toBe(false)
  })

  it('ten stamps in the same millisecond leave one valid file and one closed window', async () => {
    const vol = new Volume()
    for (let i = 0; i < 10; i++) stamp(vol, T0)
    expect(JSON.parse(rawOf(vol))).toEqual({
      last_check_at: null,
      last_prompted_at: iso(T0),
      latest_version: null,
    })
    const next = await resolveUpdateDecision(base({ exec: makeExec(), fs: vol }))
    expect(next.shouldPrompt).toBe(false)
  })
})
