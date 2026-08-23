import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { readVersionCache, versionCachePath } from './version-cache.js'
import { finalizeState, FinalizeStateError } from './finalize-state.js'
import { NPM_GLOBAL_UPDATE_ARGV } from './install-target.js'
import * as updateCheckModule from './update-check.js'
import {
  resolveUpdateDecision,
  UPDATE_CHECK_INTERVAL_MS,
  isUpdateCheckDisabled,
} from './update-check.js'

// #24 QA augmentation — the policy half. The dev's update-check.decision.test.js
// proves the happy path of each rule (opt-out, 7-day throttle, one boundary
// pair, the semver comparison, the silent failure paths). This file attacks:
//   - the throttle boundary as a full matrix, plus zero-age, epoch-0, future and
//     far-past stamps, always asserting the SPAWN COUNT (the only thing that
//     actually protects the registry) and the WRITE COUNT;
//   - clock abuse through the `now` contract;
//   - registry output that is hostile rather than merely absent;
//   - the opt-out spelling surface, proven with a recording fs (zero ops);
//   - cache-write failures at every step;
//   - the #24 deletions/regressions (checkForUpdate gone, PACKAGE_NAME consumers
//     intact, last_seen_release still required by finalizeState).

const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')
const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const WEEK = UPDATE_CHECK_INTERVAL_MS

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

function spyFs(v) {
  const ops = []
  return {
    ops,
    readFileSync: (...a) => {
      ops.push({ op: 'read', path: String(a[0]) })
      return v.readFileSync(...a)
    },
    writeFileSync: (...a) => {
      ops.push({ op: 'write', path: String(a[0]) })
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

describe('QA throttle boundary — the spawn count is the contract (#24)', () => {
  // age = how long ago last_check_at was, relative to `now`. Negative = future.
  const cases = [
    ['one ms past the window', WEEK + 1, 'network'],
    ['a full day past the window', WEEK + DAY, 'network'],
    ['exactly one week', WEEK, 'network'],
    ['one ms inside the window', WEEK - 1, 'cache'],
    ['a minute old', 60_000, 'cache'],
    ['one ms old', 1, 'cache'],
    ['stamped at this very instant', 0, 'cache'],
    ['one ms in the future', -1, 'network'],
    ['a day in the future', -DAY, 'network'],
    ['a year in the future', -365 * DAY, 'network'],
    ['a year in the past', 365 * DAY, 'network'],
  ]

  for (const [label, age, expected] of cases) {
    it(`${label} → ${expected} (${expected === 'network' ? 1 : 0} npm view)`, async () => {
      const v = seeded({
        last_check_at: new Date(T0 - age).toISOString(),
        last_prompted_at: null,
        latest_version: '0.2.0',
      })
      const fs = spyFs(v)
      const exec = makeExec()
      const result = await resolveUpdateDecision(base({ exec, fs }))
      expect(result.source).toBe(expected)
      expect(exec.calls).toHaveLength(expected === 'network' ? 1 : 0)
      expect(fs.ops.filter((o) => o.op === 'write')).toHaveLength(
        expected === 'network' ? 1 : 0,
      )
      // The notice fires either way — from the cache inside the window.
      expect(result.latestVersion).toBe('0.2.0')
      expect(result.isNewer).toBe(true)
    })
  }

  it('an epoch-0 stamp is treated as long overdue', async () => {
    const exec = makeExec()
    const result = await resolveUpdateDecision(
      base({
        exec,
        fs: seeded({ last_check_at: new Date(0).toISOString(), latest_version: '0.2.0' }),
      }),
    )
    expect(exec.calls).toHaveLength(1)
    expect(result.source).toBe('network')
  })

  it('a future stamp is rewound to now, so the next run is throttled again', async () => {
    const v = seeded({
      last_check_at: new Date(T0 + 30 * DAY).toISOString(),
      latest_version: '0.0.1',
    })
    const exec = makeExec()
    const first = await resolveUpdateDecision(base({ exec, fs: v }))
    expect(first.updatedCache.last_check_at).toBe(new Date(T0).toISOString())
    const second = await resolveUpdateDecision(base({ exec, fs: v, now: () => T0 + DAY }))
    expect(second.source).toBe('cache')
    expect(exec.calls).toHaveLength(1)
  })

  it('reads exactly once and writes nothing on the throttled path', async () => {
    const fs = spyFs(seeded({ last_check_at: new Date(T0 - DAY).toISOString(), latest_version: '0.2.0' }))
    await resolveUpdateDecision(base({ exec: makeExec(), fs }))
    expect(fs.ops.filter((o) => o.op === 'read')).toHaveLength(1)
    expect(fs.ops.filter((o) => o.op === 'write')).toHaveLength(0)
    expect(fs.ops.filter((o) => o.op === 'mkdir')).toHaveLength(0)
  })

  it('stays silent inside the window even when the last check learned nothing', async () => {
    // A failed check stamps the window with no latest_version. The follow-up runs
    // inside that week must not re-query and must not invent a notice.
    const fs = spyFs(seeded({ last_check_at: new Date(T0 - 2 * DAY).toISOString(), latest_version: null }))
    const exec = makeExec()
    const result = await resolveUpdateDecision(base({ exec, fs }))
    expect(exec.calls).toHaveLength(0)
    expect(result.source).toBe('cache')
    expect(result.latestVersion).toBeNull()
    expect(result.isNewer).toBe(false)
    expect(fs.ops.some((o) => o.op === 'write')).toBe(false)
  })

  it('normalizes a padded cached version on the throttled path', async () => {
    const result = await resolveUpdateDecision(
      base({
        exec: makeExec(),
        fs: seeded({ last_check_at: new Date(T0 - DAY).toISOString(), latest_version: '  0.2.0 \n' }),
      }),
    )
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.isNewer).toBe(true)
    expect(result.updatedCache.latest_version).toBe('0.2.0')
  })

  it('ten runs in the same millisecond make exactly one npm view', async () => {
    const v = new Volume()
    const exec = makeExec()
    for (let i = 0; i < 10; i++) {
      await resolveUpdateDecision(base({ exec, fs: v }))
    }
    expect(exec.calls).toHaveLength(1)
  })

  it('one query per week across a three-week span, each stamp exact', async () => {
    const v = new Volume()
    const exec = makeExec()
    const stamps = []
    for (const t of [T0, T0 + 3 * DAY, T0 + WEEK, T0 + WEEK + DAY, T0 + 2 * WEEK]) {
      const r = await resolveUpdateDecision(base({ exec, fs: v, now: () => t }))
      stamps.push([r.source, r.updatedCache.last_check_at])
    }
    expect(exec.calls).toHaveLength(3)
    expect(stamps.map(([source]) => source)).toEqual([
      'network',
      'cache',
      'network',
      'cache',
      'network',
    ])
    expect(readVersionCache({ fs: v, home: HOME, processEnv: {} }).last_check_at).toBe(
      new Date(T0 + 2 * WEEK).toISOString(),
    )
  })

  it('concurrent runs cannot corrupt the cache, and the window is intact afterwards', async () => {
    const v = new Volume()
    const exec = makeExec()
    await Promise.all([
      resolveUpdateDecision(base({ exec, fs: v })),
      resolveUpdateDecision(base({ exec, fs: v })),
      resolveUpdateDecision(base({ exec, fs: v })),
    ])
    expect(readVersionCache({ fs: v, home: HOME, processEnv: {} })).toEqual({
      last_check_at: new Date(T0).toISOString(),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
    const after = await resolveUpdateDecision(base({ exec, fs: v, now: () => T0 + DAY }))
    expect(after.source).toBe('cache')
  })

  it('an unparseable-but-non-empty stamp is check due, and gets replaced by a real one', async () => {
    for (const bad of ['0.17.0', 'null', '1787356800000', 'Aug 32 2026', '2026-13-01T00:00:00Z']) {
      const v = seeded({ last_check_at: bad, latest_version: '0.2.0' })
      const exec = makeExec()
      const result = await resolveUpdateDecision(base({ exec, fs: v }))
      expect(exec.calls).toHaveLength(1)
      expect(result.source).toBe('network')
      expect(result.updatedCache.last_check_at).toBe(new Date(T0).toISOString())
    }
  })

  it('a lenient-Date stamp in the past still throttles nothing it should not', async () => {
    // Date.parse('42') is year 2042 in V8 — a FUTURE date relative to T0, so the
    // future-skew rule applies and the check is due. Pinned so a future rewrite
    // of the parse cannot silently create a window that never expires.
    const exec = makeExec()
    const result = await resolveUpdateDecision(
      base({ exec, fs: seeded({ last_check_at: '42', latest_version: '0.2.0' }) }),
    )
    expect(Date.parse('42')).toBeGreaterThan(T0)
    expect(result.source).toBe('network')
    expect(exec.calls).toHaveLength(1)
  })
})

describe('QA clock abuse through the `now` contract (#24)', () => {
  // #24: the contract is function-only — every row is a callback.
  const usable = [
    ['a function returning epoch ms', () => T0, new Date(T0).toISOString()],
    ['epoch 0', () => 0, new Date(0).toISOString()],
    ['a negative epoch (pre-1970 clock)', () => -1, new Date(-1).toISOString()],
    ['the maximum representable date', () => 8.64e15, new Date(8.64e15).toISOString()],
  ]

  for (const [label, now, expectedStamp] of usable) {
    it(`stamps from ${label}`, async () => {
      const result = await resolveUpdateDecision(base({ now, exec: makeExec(), fs: new Volume() }))
      expect(result.updatedCache.last_check_at).toBe(expectedStamp)
    })
  }

  const unusable = [
    ['NaN', () => NaN],
    ['Infinity', () => Infinity],
    ['-Infinity', () => -Infinity],
    ['a numeric string', () => String(T0)],
    ['a date string', () => '2026-08-22T12:00:00.000Z'],
    ['null', () => null],
    ['undefined', () => undefined],
    ['a Date object', () => new Date(T0)],
    ['an object', () => ({ ms: T0 })],
    ['an array', () => [T0]],
    ['a boolean', () => true],
    ['a bigint-ish string', () => '1e21'],
    ['one ms past the representable Date range', () => 8.64e15 + 1],
    ['a callback that throws', () => {
      throw new Error('clock unavailable')
    }],
  ]

  for (const [label, now] of unusable) {
    it(`falls back to the real clock for ${label} without throwing`, async () => {
      const v = new Volume()
      const result = await resolveUpdateDecision(base({ now, exec: makeExec(), fs: v }))
      expect(result.source).toBe('network')
      const stamp = result.updatedCache.last_check_at
      expect(typeof stamp).toBe('string')
      expect(Number.isNaN(Date.parse(stamp))).toBe(false)
      // The persisted stamp is the same one the decision reported.
      expect(readVersionCache({ fs: v, home: HOME, processEnv: {} }).last_check_at).toBe(stamp)
    })
  }

  it('a `now` that is a plain number is IGNORED — the contract is a function', async () => {
    const before = Date.now()
    const result = await resolveUpdateDecision(
      base({ now: T0 + 5, exec: makeExec(), fs: new Volume() }),
    )
    const stamped = Date.parse(result.updatedCache.last_check_at)
    expect(stamped).not.toBe(T0 + 5)
    expect(stamped).toBeGreaterThanOrEqual(before)
  })
})

describe('QA registry hostility — output that is wrong, not merely absent (#24)', () => {
  const hostile = [
    ['the word latest', 'latest'],
    ['a two-part version', '1.2'],
    ['a v-prefixed version', 'v0.2.0'],
    ['a version range', '^0.2.0'],
    ['a 404 HTML page', '<!doctype html><html>404 Not Found</html>'],
    ['a registry JSON error blob', '{"error":"Not found"}'],
    ['an npm error line', 'npm ERR! code E404'],
    ['npm noise then a version', 'npm warn config foo\n0.2.0'],
    ['two versions', '0.2.0 0.3.0'],
    ['an ANSI-coloured version', '[32m0.2.0[39m'],
    ['a quoted version', '"0.2.0"'],
    ['a tab-separated table row', 'ralph\t0.2.0'],
    ['only whitespace', '   \n\t '],
    ['a NUL byte', '\0'],
    ['a megabyte of digits', '1'.repeat(1024 * 1024)],
  ]

  for (const [label, stdout] of hostile) {
    it(`reports no version for ${label} — and never throws`, async () => {
      const v = new Volume()
      const result = await resolveUpdateDecision(base({ exec: makeExec(okOut(stdout)), fs: v }))
      expect(result.latestVersion).toBeNull()
      expect(result.isNewer).toBe(false)
      expect(result.source).toBe('network')
      // The window is still stamped so the bad registry is not hammered.
      expect(readVersionCache({ fs: v, home: HOME, processEnv: {} }).last_check_at).toBe(
        new Date(T0).toISOString(),
      )
    })
  }

  const brokenExec = [
    ['resolves null', async () => null],
    ['resolves a string', async () => '0.2.0'],
    ['resolves an empty object', async () => ({})],
    ['exits -1', async () => ({ exitCode: -1, stdout: '0.2.0' })],
    ['exits 0 but timedOut', async () => ({ exitCode: 0, stdout: '0.2.0', timedOut: true })],
    ['exits 0 with stdout undefined', async () => ({ exitCode: 0 })],
    [
      'rejects with an Error',
      async () => {
        throw new Error('boom')
      },
    ],
    [
      'rejects with a bare string',
      async () => {
        throw 'boom'
      },
    ],
    [
      'rejects with undefined',
      async () => {
        throw undefined
      },
    ],
  ]

  for (const [label, handler] of brokenExec) {
    it(`survives an exec that ${label}`, async () => {
      const result = await resolveUpdateDecision(base({ exec: makeExec(handler), fs: new Volume() }))
      expect(result.latestVersion).toBeNull()
      expect(result.isNewer).toBe(false)
      expect(result.shouldPrompt).toBe(false)
    })
  }

  it('never spawns and never throws for a non-callable exec', async () => {
    for (const exec of [undefined, null, 42, 'npm', {}, []]) {
      const result = await resolveUpdateDecision(base({ exec, fs: new Volume() }))
      expect(result.latestVersion).toBeNull()
      expect(result.isNewer).toBe(false)
    }
  })

  it('awaits the registry query rather than firing and forgetting', async () => {
    let settled = false
    const exec = async () => {
      await new Promise((r) => setTimeout(r, 5))
      settled = true
      return { exitCode: 0, stdout: '0.2.0', stderr: '', timedOut: false }
    }
    const result = await resolveUpdateDecision(base({ exec, fs: new Volume() }))
    expect(settled).toBe(true)
    expect(result.latestVersion).toBe('0.2.0')
  })

  it('forwards timeoutMs verbatim, including 0 and a large value', async () => {
    for (const timeoutMs of [0, 1, 250, 60_000]) {
      const exec = makeExec()
      await resolveUpdateDecision(base({ exec, fs: new Volume(), timeoutMs }))
      expect(exec.calls[0].opts).toEqual({ timeout: timeoutMs, reject: false })
    }
  })

  it('always passes reject:false so execa never throws on a non-zero exit', async () => {
    const exec = makeExec()
    await resolveUpdateDecision(base({ exec, fs: new Volume() }))
    expect(exec.calls[0].opts.reject).toBe(false)
    expect(exec.calls[0].cmd).toBe('npm')
    expect(exec.calls[0].args).toEqual(['view', '@lucasfe/ralph', 'version'])
  })
})

describe('QA semver decision matrix (#24)', () => {
  const pairs = [
    ['0.1.0', '0.2.0', true],
    ['0.9.9', '0.10.0', true, 'numeric, not lexical, minor compare'],
    ['0.9.9', '0.9.10', true, 'numeric patch compare'],
    ['1.0.0', '0.999.999', false],
    ['0.16.0', '0.16.0', false],
    ['0.16.1', '0.16.0', false],
    ['10.0.0', '9.99.99', false],
    ['9.0.0', '10.0.0', true],
    ['0.16.0-rc.1', '0.16.0', true, 'release beats its own prerelease'],
    ['0.16.0', '0.16.0-rc.1', false, 'a prerelease is not an upgrade'],
    ['0.16.0', '0.16.1+build.9', true, 'build metadata is ignored'],
    ['0.16.0+build.1', '0.16.0', false],
    ['0.16.0', '0.16.0+build.1', false, 'build metadata alone is not newer'],
  ]

  for (const [current, latest, expected, note] of pairs) {
    it(`${current} → ${latest} isNewer=${expected}${note ? ` (${note})` : ''}`, async () => {
      const result = await resolveUpdateDecision(
        base({ currentVersion: current, exec: makeExec(okOut(latest)), fs: new Volume() }),
      )
      expect(result.latestVersion).toBe(latest)
      expect(result.isNewer).toBe(expected)
    })
  }

  it('applies the same comparison on the cached path as on the network path', async () => {
    const cached = await resolveUpdateDecision(
      base({
        currentVersion: '0.10.0',
        exec: makeExec(),
        fs: seeded({ last_check_at: new Date(T0 - DAY).toISOString(), latest_version: '0.9.9' }),
      }),
    )
    expect(cached.source).toBe('cache')
    expect(cached.isNewer).toBe(false)
  })

  it('refuses to compare a non-semver currentVersion instead of guessing', async () => {
    for (const current of ['v0.1.0', '0.1', 'dev', '0.1.0.1', ' ', {}, [], NaN, true]) {
      const result = await resolveUpdateDecision(
        base({ currentVersion: current, exec: makeExec(), fs: new Volume() }),
      )
      expect(result.isNewer).toBe(false)
    }
  })

  it('compares numeric prerelease identifiers lexically (documented #21 deviation)', async () => {
    // Strict semver orders alpha.10 ABOVE alpha.2; compareSemver compares the
    // prerelease tail as a string, so alpha.10 sorts LOWER. Pinned rather than
    // fixed: this package publishes plain releases, and the failure mode is a
    // MISSED notice (fail-closed), never a false one. If prereleases are ever
    // published, this is the line that has to change.
    const result = await resolveUpdateDecision(
      base({
        currentVersion: '1.0.0-alpha.2',
        exec: makeExec(okOut('1.0.0-alpha.10')),
        fs: new Volume(),
      }),
    )
    expect(result.latestVersion).toBe('1.0.0-alpha.10')
    expect(result.isNewer).toBe(false)
  })

  it('never sets shouldPrompt, whatever the versions say (#25/#26 own that)', async () => {
    for (const [current, latest] of [
      ['0.1.0', '9.9.9'],
      ['9.9.9', '0.1.0'],
      ['0.1.0', '0.1.0'],
    ]) {
      const result = await resolveUpdateDecision(
        base({ currentVersion: current, exec: makeExec(okOut(latest)), fs: new Volume() }),
      )
      expect(result.shouldPrompt).toBe(false)
    }
  })

  it('returns the full decision shape on every path', async () => {
    const keys = ['isNewer', 'latestVersion', 'shouldPrompt', 'source', 'updatedCache']
    const network = await resolveUpdateDecision(base({ exec: makeExec(), fs: new Volume() }))
    const cached = await resolveUpdateDecision(
      base({
        exec: makeExec(),
        fs: seeded({ last_check_at: new Date(T0).toISOString(), latest_version: '0.2.0' }),
      }),
    )
    const disabled = await resolveUpdateDecision(
      base({ exec: makeExec(), fs: new Volume(), processEnv: { RALPH_NO_UPDATE_CHECK: '1' } }),
    )
    for (const decision of [network, cached, disabled]) {
      expect(Object.keys(decision).sort()).toEqual(keys)
    }
    expect(disabled.updatedCache).toBeNull()
  })
})

describe('QA RALPH_NO_UPDATE_CHECK spelling surface (#24)', () => {
  const disabling = ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', ' 1 ', '  true  ', 'no', 'off', 'disabled', '2', '-1', 'anything']
  const enabling = ['0', 'false', 'FALSE', 'False', ' 0 ', ' false ', '', '   ', '\t\n']

  for (const value of disabling) {
    it(`"${value}" disables: zero spawns, zero fs ops, zero output data`, async () => {
      const fs = spyFs(seeded({ last_check_at: null, latest_version: '9.9.9' }))
      const exec = makeExec()
      const result = await resolveUpdateDecision(
        base({ exec, fs, processEnv: { RALPH_NO_UPDATE_CHECK: value } }),
      )
      expect(exec.calls).toHaveLength(0)
      expect(fs.ops).toHaveLength(0)
      expect(result).toEqual({
        latestVersion: null,
        isNewer: false,
        shouldPrompt: false,
        source: 'disabled',
        updatedCache: null,
      })
      expect(isUpdateCheckDisabled({ RALPH_NO_UPDATE_CHECK: value })).toBe(true)
    })
  }

  for (const value of enabling) {
    it(`"${value}" leaves the check ON (one spawn)`, async () => {
      const exec = makeExec()
      const result = await resolveUpdateDecision(
        base({ exec, fs: new Volume(), processEnv: { RALPH_NO_UPDATE_CHECK: value } }),
      )
      expect(exec.calls).toHaveLength(1)
      expect(result.source).toBe('network')
      expect(isUpdateCheckDisabled({ RALPH_NO_UPDATE_CHECK: value })).toBe(false)
    })
  }

  it('the opt-out wins over a newer cached version, a live registry and a broken fs', async () => {
    const explodingFs = {
      readFileSync: () => {
        throw new Error('fs must not be consulted')
      },
      mkdirSync: () => {
        throw new Error('fs must not be consulted')
      },
      writeFileSync: () => {
        throw new Error('fs must not be consulted')
      },
    }
    const exec = makeExec(okOut('9.9.9'))
    const result = await resolveUpdateDecision(
      base({ exec, fs: explodingFs, processEnv: { RALPH_NO_UPDATE_CHECK: '1' } }),
    )
    expect(result.source).toBe('disabled')
    expect(result.isNewer).toBe(false)
    expect(exec.calls).toHaveLength(0)
  })

  it('ignores unrelated env vars with similar names', async () => {
    const exec = makeExec()
    const result = await resolveUpdateDecision(
      base({
        exec,
        fs: new Volume(),
        processEnv: {
          RALPH_NO_UPDATE: '1',
          NO_UPDATE_CHECK: '1',
          RALPH_NO_UPDATE_CHECKS: '1',
          ralph_no_update_check: '1',
        },
      }),
    )
    expect(result.source).toBe('network')
    expect(exec.calls).toHaveLength(1)
  })
})

describe('QA cache-write failures never lose the decision (#24)', () => {
  const failures = [
    [
      'mkdirSync throws EACCES',
      {
        readFileSync: () => {
          const e = new Error('ENOENT')
          e.code = 'ENOENT'
          throw e
        },
        mkdirSync: () => {
          const e = new Error('EACCES')
          e.code = 'EACCES'
          throw e
        },
        writeFileSync: () => undefined,
      },
    ],
    [
      'writeFileSync throws ENOSPC',
      {
        readFileSync: () => {
          const e = new Error('ENOENT')
          e.code = 'ENOENT'
          throw e
        },
        mkdirSync: () => undefined,
        writeFileSync: () => {
          const e = new Error('ENOSPC')
          e.code = 'ENOSPC'
          throw e
        },
      },
    ],
    [
      'writeFileSync throws a bare string',
      {
        readFileSync: () => {
          const e = new Error('ENOENT')
          e.code = 'ENOENT'
          throw e
        },
        mkdirSync: () => undefined,
        writeFileSync: () => {
          throw 'nope'
        },
      },
    ],
    ['the fs has no write methods at all', { readFileSync: () => '{}' }],
  ]

  for (const [label, fs] of failures) {
    it(`still reports the pending update when ${label}`, async () => {
      const result = await resolveUpdateDecision(base({ exec: makeExec(), fs }))
      expect(result.latestVersion).toBe('0.2.0')
      expect(result.isNewer).toBe(true)
      expect(result.source).toBe('network')
      // updatedCache reports what the run resolved even though the write was
      // dropped. Nothing to retry — the attempt already happened.
      expect(result.updatedCache.last_check_at).toBe(new Date(T0).toISOString())
    })
  }
})

describe('QA #24 deletions and cross-module regressions', () => {
  it('checkForUpdate is gone from the module surface', () => {
    expect(updateCheckModule.checkForUpdate).toBeUndefined()
    // arrayContaining, not exact equality: #25/#26 will add exports to this
    // module, and that is not a behavioral regression.
    expect(Object.keys(updateCheckModule)).toEqual(
      expect.arrayContaining([
        'PACKAGE_NAME',
        'UPDATE_CHECK_INTERVAL_MS',
        'compareSemver',
        'fetchLatestVersion',
        'isUpdateCheckDisabled',
        'isValidSemver',
        'resolveUpdateDecision',
      ]),
    )
  })

  it('PACKAGE_NAME still feeds install-target (ralph update, #21/#22)', () => {
    expect(NPM_GLOBAL_UPDATE_ARGV).toEqual(['npm', 'install', '-g', '@lucasfe/ralph@latest'])
  })

  it('finalizeState still REQUIRES last_seen_release even though #24 stopped reading it', () => {
    const PROJECT = '/project'
    const state = {
      validated_at: '2026-08-22T00:00:00.000Z',
      detected_stack: 'npm',
      notes: '',
    }
    const withoutField = Volume.fromJSON(
      {
        [`${PROJECT}/ralph.config.sh`]: 'X=1\n',
        [`${PROJECT}/.ralph/state.json`]: JSON.stringify(state),
      },
      '/',
    )
    expect(() => finalizeState({ projectRoot: PROJECT, fs: withoutField, env: {} })).toThrow(
      /last_seen_release/,
    )
    const withField = Volume.fromJSON(
      {
        [`${PROJECT}/ralph.config.sh`]: 'X=1\n',
        [`${PROJECT}/.ralph/state.json`]: JSON.stringify({ ...state, last_seen_release: 'v0.16.0' }),
      },
      '/',
    )
    const next = finalizeState({ projectRoot: PROJECT, fs: withField, env: {} })
    expect(next.last_seen_release).toBe('v0.16.0')
  })
})

describe('QA the never-throws claim holds for hostile injection too (#24)', () => {
  // resolveUpdateDecision documents itself as never throwing, and its call site
  // (start.js step 2.5) has no try/catch, so anything that escapes would abort
  // `ralph start` with a raw stack trace over what is only advice. The claim is
  // enforced at the boundary — a bad clock, a bad env bag, and a failed cache
  // read or write are each guarded inside the function — so these inputs, which
  // an in-process caller (#25/#26 threading its own hooks) could pass
  // deliberately, degrade instead of escaping.
  it('a non-string RALPH_NO_UPDATE_CHECK degrades instead of throwing', async () => {
    // A number is truthy-but-not-'0'/'false', so it reads as an opt-out rather
    // than crashing on .trim().
    for (const value of [1, true, {}, ['1']]) {
      const exec = makeExec()
      const result = await resolveUpdateDecision(
        base({ exec, fs: new Volume(), processEnv: { RALPH_NO_UPDATE_CHECK: value } }),
      )
      expect(result.source).toBe('disabled')
      expect(exec.calls).toHaveLength(0)
    }
  })

  it('a numeric 0 / false-ish RALPH_NO_UPDATE_CHECK still runs the check', async () => {
    for (const value of [0, false]) {
      const exec = makeExec()
      const result = await resolveUpdateDecision(
        base({ exec, fs: new Volume(), processEnv: { RALPH_NO_UPDATE_CHECK: value } }),
      )
      expect(result.source).toBe('network')
      expect(exec.calls).toHaveLength(1)
    }
  })

  it('a null or undefined processEnv resolves the cache under the injected home', async () => {
    // A null bag used to reach join() through versionCachePath → globalConfigPath.
    //
    // The read-back passes the SAME bag it was written with rather than a
    // hardcoded `{}`. `undefined` is not a no-op here: it falls through to
    // resolveUpdateDecision's own `processEnv = process.env` default, so the
    // write honors an ambient XDG_CONFIG_HOME if the machine sets one. Asserting
    // against a fixed ~/.config path made this test pass on a machine without
    // that var and fail on CI, which sets it. Round-tripping through the same
    // bag pins the invariant we actually care about — a hostile bag still lands
    // somewhere the reader agrees on — and is hermetic either way.
    for (const processEnv of [null, undefined]) {
      const vol = new Volume()
      const result = await resolveUpdateDecision({
        currentVersion: '0.1.0',
        now: () => T0,
        exec: makeExec(),
        fs: vol,
        home: HOME,
        processEnv,
      })
      expect(result.source).toBe('network')
      expect(result.isNewer).toBe(true)
      expect(readVersionCache({ fs: vol, home: HOME, processEnv }).latest_version).toBe('0.2.0')
    }
  })

  // #24: the null bag must resolve under the INJECTED home specifically, which
  // the round-trip above cannot show on its own. Pinned with an explicit empty
  // bag so no ambient XDG_CONFIG_HOME can reach the path resolution.
  it('a null processEnv resolves the cache under the injected home, not the ambient env', async () => {
    const vol = new Volume()
    const result = await resolveUpdateDecision({
      currentVersion: '0.1.0',
      now: () => T0,
      exec: makeExec(),
      fs: vol,
      home: HOME,
      processEnv: null,
    })
    expect(result.source).toBe('network')
    expect(vol.existsSync(versionCachePath({ processEnv: {}, home: HOME }))).toBe(true)
    expect(readVersionCache({ fs: vol, home: HOME, processEnv: {} }).latest_version).toBe('0.2.0')
  })

  it('a cache read that throws is swallowed and treated as an empty cache', async () => {
    // The default reader is total; this proves the guard is at the boundary and
    // not merely inherited from the far side behaving.
    const fs = {
      readFileSync: () => {
        throw new Error('exploding reader')
      },
      mkdirSync: () => undefined,
      writeFileSync: () => undefined,
    }
    const exec = makeExec()
    const result = await resolveUpdateDecision(base({ exec, fs }))
    expect(exec.calls).toHaveLength(1)
    expect(result.source).toBe('network')
    expect(result.updatedCache).toEqual({
      last_check_at: new Date(T0).toISOString(),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
  })

  it('a non-string home degrades instead of throwing out of path resolution', async () => {
    // The one input that reaches resolveUpdateDecision's OWN read guard: a
    // non-string home makes path.join throw while versionCachePath is being
    // evaluated as readVersionCache's default parameter — outside that
    // function's internal try/catch. Both the read and the write fail, and the
    // run still resolves to advice rather than aborting `ralph start`.
    const exec = makeExec()
    const result = await resolveUpdateDecision(base({ exec, fs: new Volume(), home: 42 }))
    expect(result.source).toBe('network')
    expect(result.isNewer).toBe(true)
    expect(result.updatedCache).toEqual({
      last_check_at: new Date(T0).toISOString(),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
  })

  it('the guard chain is exception-free for every input a real caller can produce', async () => {
    // Same shape as production: real Date.now, string-valued env, default hooks.
    const result = await resolveUpdateDecision({
      currentVersion: '0.1.0',
      now: Date.now,
      exec: makeExec(),
      processEnv: { PATH: '/usr/bin', RALPH_NO_UPDATE_CHECK: '' },
      fs: new Volume(),
      home: HOME,
    })
    expect(result.source).toBe('network')
    expect(result.isNewer).toBe(true)
  })
})
