import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { dirname, join } from 'node:path'
import { globalConfigPath } from './utils/global-config.js'
import {
  EMPTY_VERSION_CACHE,
  readVersionCache,
  versionCachePath,
  writeVersionCache,
} from './version-cache.js'

// #24: the weekly update check is throttled from a GLOBAL cache — the npm
// package is installed globally, so a user with five Ralph repos gets one check
// a week, not five. The file lives beside the global dotenv (same XDG base
// resolution) but is a SEPARATE file: ralph/.env is a 0600 credential store and
// must never be mixed with cache data. Every read path is total — missing,
// unreadable, invalid JSON and hand-mangled all resolve to empty defaults.

const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')

function vol(seed = {}) {
  return Volume.fromJSON(seed, '/')
}

describe('versionCachePath — XDG base resolution shared with the global config', () => {
  it('defaults to ~/.config/ralph/update-check.json', () => {
    expect(versionCachePath({ processEnv: {}, home: HOME })).toBe(CACHE_PATH)
  })

  it('honors XDG_CONFIG_HOME', () => {
    expect(versionCachePath({ processEnv: { XDG_CONFIG_HOME: '/xdg' }, home: HOME })).toBe(
      join('/xdg', 'ralph', 'update-check.json'),
    )
  })

  it('trims XDG_CONFIG_HOME and ignores a blank one', () => {
    expect(
      versionCachePath({ processEnv: { XDG_CONFIG_HOME: '  /xdg  ' }, home: HOME }),
    ).toBe(join('/xdg', 'ralph', 'update-check.json'))
    expect(versionCachePath({ processEnv: { XDG_CONFIG_HOME: '   ' }, home: HOME })).toBe(
      CACHE_PATH,
    )
  })

  it('is a sibling of the global .env, never the .env itself', () => {
    const args = { processEnv: {}, home: HOME }
    expect(versionCachePath(args)).not.toBe(globalConfigPath(args))
    expect(dirname(versionCachePath(args))).toBe(dirname(globalConfigPath(args)))
  })
})

describe('readVersionCache — total, never throws', () => {
  it('returns empty defaults when the file is missing', () => {
    expect(readVersionCache({ fs: vol(), home: HOME, processEnv: {} })).toEqual(
      EMPTY_VERSION_CACHE,
    )
  })

  it('returns empty defaults when the file is unreadable', () => {
    const fs = {
      readFileSync: () => {
        const e = new Error('permission denied')
        e.code = 'EACCES'
        throw e
      },
    }
    expect(readVersionCache({ fs, home: HOME, processEnv: {} })).toEqual(
      EMPTY_VERSION_CACHE,
    )
  })

  it('returns empty defaults on invalid JSON', () => {
    const fs = vol({ [CACHE_PATH]: '{ this is not json' })
    expect(readVersionCache({ fs, home: HOME, processEnv: {} })).toEqual(
      EMPTY_VERSION_CACHE,
    )
  })

  it('returns empty defaults on an empty file', () => {
    const fs = vol({ [CACHE_PATH]: '' })
    expect(readVersionCache({ fs, home: HOME, processEnv: {} })).toEqual(
      EMPTY_VERSION_CACHE,
    )
  })

  it('returns empty defaults when the JSON is valid but not an object', () => {
    for (const raw of ['null', '42', '"str"', '[]', 'true']) {
      const fs = vol({ [CACHE_PATH]: raw })
      expect(readVersionCache({ fs, home: HOME, processEnv: {} })).toEqual(
        EMPTY_VERSION_CACHE,
      )
    }
  })

  it('reads the three cache fields back', () => {
    const fs = vol({
      [CACHE_PATH]: JSON.stringify({
        last_check_at: '2026-08-15T00:00:00.000Z',
        last_prompted_at: '2026-08-01T00:00:00.000Z',
        latest_version: '0.17.0',
      }),
    })
    expect(readVersionCache({ fs, home: HOME, processEnv: {} })).toEqual({
      last_check_at: '2026-08-15T00:00:00.000Z',
      last_prompted_at: '2026-08-01T00:00:00.000Z',
      latest_version: '0.17.0',
    })
  })

  it('nulls out hand-mangled non-string fields instead of trusting them', () => {
    const fs = vol({
      [CACHE_PATH]: JSON.stringify({
        last_check_at: 1755000000000,
        last_prompted_at: { nested: true },
        latest_version: ['0.17.0'],
      }),
    })
    expect(readVersionCache({ fs, home: HOME, processEnv: {} })).toEqual(
      EMPTY_VERSION_CACHE,
    )
  })

  it('normalizes blank strings to null', () => {
    const fs = vol({ [CACHE_PATH]: JSON.stringify({ last_check_at: '   ' }) })
    expect(readVersionCache({ fs, home: HOME, processEnv: {} }).last_check_at).toBeNull()
  })

  it('drops unknown keys so the shape stays fixed', () => {
    const fs = vol({
      [CACHE_PATH]: JSON.stringify({ latest_version: '0.17.0', bogus: 'x' }),
    })
    const cache = readVersionCache({ fs, home: HOME, processEnv: {} })
    expect(cache).toEqual({
      last_check_at: null,
      last_prompted_at: null,
      latest_version: '0.17.0',
    })
  })

  it('reads from the XDG path when XDG_CONFIG_HOME is set', () => {
    const xdgPath = join('/xdg', 'ralph', 'update-check.json')
    const fs = vol({ [xdgPath]: JSON.stringify({ latest_version: '0.17.0' }) })
    const cache = readVersionCache({
      fs,
      home: HOME,
      processEnv: { XDG_CONFIG_HOME: '/xdg' },
    })
    expect(cache.latest_version).toBe('0.17.0')
  })

  it('accepts an explicit path override', () => {
    const fs = vol({ '/tmp/c.json': JSON.stringify({ latest_version: '9.9.9' }) })
    expect(readVersionCache({ fs, path: '/tmp/c.json' }).latest_version).toBe('9.9.9')
  })
})

describe('writeVersionCache', () => {
  it('creates the file and the 0700 parent dir at the resolved path', () => {
    const fs = vol()
    const path = writeVersionCache({
      cache: {
        last_check_at: '2026-08-22T00:00:00.000Z',
        last_prompted_at: null,
        latest_version: '0.17.0',
      },
      fs,
      home: HOME,
      processEnv: {},
    })
    expect(path).toBe(CACHE_PATH)
    expect(JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))).toEqual({
      last_check_at: '2026-08-22T00:00:00.000Z',
      last_prompted_at: null,
      latest_version: '0.17.0',
    })
    expect(fs.statSync(dirname(CACHE_PATH)).mode & 0o777).toBe(0o700)
  })

  it('writes the fixed three-field shape even from a partial cache', () => {
    const fs = vol()
    writeVersionCache({ cache: { latest_version: '0.17.0' }, fs, home: HOME, processEnv: {} })
    expect(JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))).toEqual({
      last_check_at: null,
      last_prompted_at: null,
      latest_version: '0.17.0',
    })
  })

  it('round-trips through readVersionCache', () => {
    const fs = vol()
    const cache = {
      last_check_at: '2026-08-22T00:00:00.000Z',
      last_prompted_at: '2026-08-20T00:00:00.000Z',
      latest_version: '0.17.0',
    }
    writeVersionCache({ cache, fs, home: HOME, processEnv: {} })
    expect(readVersionCache({ fs, home: HOME, processEnv: {} })).toEqual(cache)
  })

  it('honors XDG_CONFIG_HOME', () => {
    const fs = vol()
    const path = writeVersionCache({
      cache: { latest_version: '0.17.0' },
      fs,
      home: HOME,
      processEnv: { XDG_CONFIG_HOME: '/xdg' },
    })
    expect(path).toBe(join('/xdg', 'ralph', 'update-check.json'))
    expect(fs.existsSync(path)).toBe(true)
  })

  it('leaves the global .env in the same directory byte-identical', () => {
    const envPath = globalConfigPath({ processEnv: {}, home: HOME })
    const envContent = '# creds\nCALLMEBOT_KEY=secret\nWHATSAPP_PHONE=+1\n'
    const fs = vol({ [envPath]: envContent })
    writeVersionCache({ cache: { latest_version: '0.17.0' }, fs, home: HOME, processEnv: {} })
    expect(fs.readFileSync(envPath, 'utf8')).toBe(envContent)
    expect(fs.readFileSync(CACHE_PATH, 'utf8')).not.toContain('CALLMEBOT_KEY')
  })
})
