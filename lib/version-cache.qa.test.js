import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { basename, dirname, join } from 'node:path'
import { globalConfigPath } from './utils/global-config.js'
import { writeGlobalCreds } from './utils/global-config-writer.js'
import {
  EMPTY_VERSION_CACHE,
  readVersionCache,
  versionCachePath,
  writeVersionCache,
} from './version-cache.js'

// #24 QA augmentation — the store half. The dev's version-cache.test.js proves
// the happy path (three fields round-trip, XDG honored, missing/corrupt/mangled
// resolve to defaults). This file attacks the corners that make `ralph start`
// abort or make the cache stomp on its 0600 neighbour:
//   - hostile XDG_CONFIG_HOME / home values, asserted to resolve EXACTLY like
//     globalConfigPath (the sibling invariant is the whole reason the cache is a
//     separate file in that directory);
//   - every way a hand-edited or half-written cache file can be malformed;
//   - every way the injected fs can be hostile on read AND on write;
//   - the ralph/.env non-interference invariant in BOTH landing orders, proven
//     by recording every fs op rather than by reading the result back.

const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')
const ENV_PATH = globalConfigPath({ processEnv: {}, home: HOME })

function vol(seed = {}) {
  return Volume.fromJSON(seed, '/')
}

// Records every fs op so "never touched the .env" is proven at the call level,
// not inferred from the file contents afterwards.
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
    chmodSync: (...a) => {
      ops.push({ op: 'chmod', path: String(a[0]) })
      return v.chmodSync(...a)
    },
    statSync: (...a) => v.statSync(...a),
    existsSync: (...a) => v.existsSync(...a),
  }
}

function throwingRead(code) {
  return {
    readFileSync: () => {
      const e = new Error(code)
      e.code = code
      throw e
    },
  }
}

describe('QA versionCachePath — hostile XDG/home values resolve exactly like globalConfigPath (#24)', () => {
  // The cache is only safe to keep beside a 0600 credential store if BOTH paths
  // derive from the same base under every input. Anything that made them
  // diverge would put the cache somewhere the user never expects.
  const cases = [
    ['unset', {}],
    ['empty string', { XDG_CONFIG_HOME: '' }],
    ['whitespace only', { XDG_CONFIG_HOME: '   ' }],
    ['tabs and newlines only', { XDG_CONFIG_HOME: '\t\n ' }],
    ['absolute', { XDG_CONFIG_HOME: '/xdg' }],
    ['trailing slash', { XDG_CONFIG_HOME: '/xdg/' }],
    ['double trailing slash', { XDG_CONFIG_HOME: '/xdg//' }],
    ['padded', { XDG_CONFIG_HOME: '  /xdg  ' }],
    ['relative', { XDG_CONFIG_HOME: 'rel/cfg' }],
    ['dot', { XDG_CONFIG_HOME: '.' }],
    ['tilde (never expanded)', { XDG_CONFIG_HOME: '~/cfg' }],
    ['inner spaces', { XDG_CONFIG_HOME: '/x d g' }],
    ['nested', { XDG_CONFIG_HOME: '/a/b/c/d' }],
  ]

  for (const [label, processEnv] of cases) {
    it(`stays a same-directory sibling of the global .env — ${label}`, () => {
      const args = { processEnv, home: HOME }
      const cache = versionCachePath(args)
      const env = globalConfigPath(args)
      expect(dirname(cache)).toBe(dirname(env))
      expect(basename(cache)).toBe('update-check.json')
      expect(basename(env)).toBe('.env')
      expect(cache).not.toBe(env)
    })
  }

  it('normalizes a trailing slash to the same path as without one', () => {
    expect(versionCachePath({ processEnv: { XDG_CONFIG_HOME: '/xdg/' }, home: HOME })).toBe(
      versionCachePath({ processEnv: { XDG_CONFIG_HOME: '/xdg' }, home: HOME }),
    )
  })

  it('falls back to ~/.config for an empty or whitespace XDG_CONFIG_HOME', () => {
    for (const XDG_CONFIG_HOME of ['', '   ', '\t']) {
      expect(versionCachePath({ processEnv: { XDG_CONFIG_HOME }, home: HOME })).toBe(CACHE_PATH)
    }
  })

  it('keeps a relative XDG_CONFIG_HOME relative (no cwd resolution, same as the .env)', () => {
    const processEnv = { XDG_CONFIG_HOME: 'rel/cfg' }
    expect(versionCachePath({ processEnv, home: HOME })).toBe(
      join('rel', 'cfg', 'ralph', 'update-check.json'),
    )
  })

  it('does not expand a ~ in XDG_CONFIG_HOME (documents the shared quirk)', () => {
    const processEnv = { XDG_CONFIG_HOME: '~/cfg' }
    expect(versionCachePath({ processEnv, home: HOME })).toBe(
      join('~', 'cfg', 'ralph', 'update-check.json'),
    )
  })

  it('tolerates a home with a trailing slash', () => {
    expect(versionCachePath({ processEnv: {}, home: `${HOME}/` })).toBe(CACHE_PATH)
  })

  it('ignores XDG_CONFIG_HOME entirely when an explicit path is given', () => {
    const fs = vol({ '/tmp/explicit.json': JSON.stringify({ latest_version: '1.2.3' }) })
    const cache = readVersionCache({
      fs,
      path: '/tmp/explicit.json',
      processEnv: { XDG_CONFIG_HOME: '/xdg' },
      home: HOME,
    })
    expect(cache.latest_version).toBe('1.2.3')
  })
})

describe('QA readVersionCache — every malformed file resolves to defaults, never throws (#24)', () => {
  const raws = [
    ['whitespace only', '   \n\t '],
    ['a lone newline', '\n'],
    ['a BOM-prefixed object', '﻿{"latest_version":"0.17.0"}'],
    ['truncated JSON', '{"latest_version":"0.17.0"'],
    ['JSON with trailing garbage', '{"latest_version":"0.17.0"} oops'],
    ['two concatenated objects', '{}{}'],
    ['a JSON array of objects', '[{"latest_version":"0.17.0"}]'],
    ['a bare number', '0.17'],
    ['a bare word', 'undefined'],
    ['NaN', 'NaN'],
    ['a JS object literal (unquoted keys)', '{latest_version: "0.17.0"}'],
    ['single-quoted JSON', "{'latest_version':'0.17.0'}"],
    ['a shell fragment', 'export LATEST=0.17.0'],
    ['an HTML error page', '<!doctype html><html><body>500</body></html>'],
    ['a NUL byte', '\0'],
  ]

  for (const [label, raw] of raws) {
    it(`returns empty defaults for ${label}`, () => {
      expect(readVersionCache({ fs: vol({ [CACHE_PATH]: raw }), home: HOME, processEnv: {} })).toEqual(
        EMPTY_VERSION_CACHE,
      )
    })
  }

  it('nulls every non-string field type a hand-edit can produce', () => {
    const mangled = [
      { last_check_at: 0 },
      { last_check_at: false },
      { last_check_at: true },
      { last_check_at: null },
      { last_check_at: -1 },
      { last_check_at: 1.5e12 },
      { last_check_at: [] },
      { last_check_at: {} },
      { last_check_at: { nested: { deeper: 'x' } } },
      { latest_version: 0.17 },
      { latest_version: ['0.17.0'] },
      { latest_version: { version: '0.17.0' } },
      { last_prompted_at: 12345 },
    ]
    for (const seed of mangled) {
      const cache = readVersionCache({
        fs: vol({ [CACHE_PATH]: JSON.stringify(seed) }),
        home: HOME,
        processEnv: {},
      })
      expect(cache).toEqual(EMPTY_VERSION_CACHE)
    }
  })

  it('trims surviving string fields and nulls whitespace-only ones', () => {
    const cache = readVersionCache({
      fs: vol({
        [CACHE_PATH]: JSON.stringify({
          last_check_at: '  2026-08-15T00:00:00.000Z\n',
          last_prompted_at: '\t\n ',
          latest_version: ' 0.17.0 ',
        }),
      }),
      home: HOME,
      processEnv: {},
    })
    expect(cache).toEqual({
      last_check_at: '2026-08-15T00:00:00.000Z',
      last_prompted_at: null,
      latest_version: '0.17.0',
    })
  })

  it('drops unknown keys even when they look like something worth keeping', () => {
    // Raw JSON (not an object literal) so the "__proto__" key really is present
    // in the parsed payload — a hand-edited cache must not be able to reach the
    // returned object's prototype.
    const raw =
      '{"latest_version":"0.17.0","CALLMEBOT_KEY":"leaked",' +
      '"__proto__":{"polluted":true},"last_seen_release":"v0.16.0"}'
    const cache = readVersionCache({
      fs: vol({ [CACHE_PATH]: raw }),
      home: HOME,
      processEnv: {},
    })
    expect(cache).toEqual({
      last_check_at: null,
      last_prompted_at: null,
      latest_version: '0.17.0',
    })
    expect(Object.keys(cache).sort()).toEqual([
      'last_check_at',
      'last_prompted_at',
      'latest_version',
    ])
    expect({}.polluted).toBeUndefined()
  })

  it('takes the LAST value for a duplicated key (pins JSON.parse semantics)', () => {
    const fs = vol({
      [CACHE_PATH]: '{"latest_version":"0.1.0","latest_version":"0.17.0"}',
    })
    expect(readVersionCache({ fs, home: HOME, processEnv: {} }).latest_version).toBe('0.17.0')
  })

  it('still finds the three fields in a bloated file full of junk keys', () => {
    const junk = {}
    for (let i = 0; i < 5000; i++) junk[`k${i}`] = 'x'.repeat(50)
    junk.latest_version = '0.17.0'
    junk.last_check_at = '2026-08-15T00:00:00.000Z'
    const fs = vol({ [CACHE_PATH]: JSON.stringify(junk) })
    expect(readVersionCache({ fs, home: HOME, processEnv: {} })).toEqual({
      last_check_at: '2026-08-15T00:00:00.000Z',
      last_prompted_at: null,
      latest_version: '0.17.0',
    })
  })

  it('returns a fresh mutable object each call and never leaks the frozen default', () => {
    const fs = vol()
    const first = readVersionCache({ fs, home: HOME, processEnv: {} })
    const second = readVersionCache({ fs, home: HOME, processEnv: {} })
    expect(first).not.toBe(second)
    expect(first).not.toBe(EMPTY_VERSION_CACHE)
    first.latest_version = 'mutated'
    expect(EMPTY_VERSION_CACHE.latest_version).toBeNull()
    expect(readVersionCache({ fs, home: HOME, processEnv: {} }).latest_version).toBeNull()
    expect(Object.isFrozen(EMPTY_VERSION_CACHE)).toBe(true)
  })

  for (const code of ['EACCES', 'EPERM', 'EISDIR', 'ELOOP', 'EMFILE', 'ENOTDIR', 'EIO']) {
    it(`returns empty defaults when readFileSync throws ${code}`, () => {
      expect(readVersionCache({ fs: throwingRead(code), home: HOME, processEnv: {} })).toEqual(
        EMPTY_VERSION_CACHE,
      )
    })
  }

  it('returns empty defaults when a directory sits where the cache file should be', () => {
    const v = new Volume()
    v.mkdirSync(CACHE_PATH, { recursive: true })
    expect(readVersionCache({ fs: v, home: HOME, processEnv: {} })).toEqual(EMPTY_VERSION_CACHE)
  })

  it('returns empty defaults for a hostile fs object (missing, null, wrong types)', () => {
    const hostile = [
      {},
      null,
      { readFileSync: 'not a function' },
      { readFileSync: () => undefined },
      { readFileSync: () => 42 },
      {
        readFileSync: () => {
          throw 'a bare string, not an Error'
        },
      },
      {
        readFileSync: () => {
          throw { code: 'EACCES' }
        },
      },
    ]
    for (const fs of hostile) {
      expect(readVersionCache({ fs, home: HOME, processEnv: {} })).toEqual(EMPTY_VERSION_CACHE)
    }
  })

  it('accepts a Buffer from readFileSync (the real fs contract)', () => {
    const fs = {
      readFileSync: () => Buffer.from(JSON.stringify({ latest_version: '0.17.0' }), 'utf8'),
    }
    expect(readVersionCache({ fs, home: HOME, processEnv: {} }).latest_version).toBe('0.17.0')
  })
})

describe('QA writeVersionCache — failure surface and on-disk shape (#24)', () => {
  it('propagates a real FS failure so the caller can decide (documented contract)', () => {
    const mkdirFails = (code) => ({
      mkdirSync: () => {
        const e = new Error(code)
        e.code = code
        throw e
      },
      writeFileSync: () => {
        throw new Error('must not be reached')
      },
    })
    for (const code of ['EACCES', 'EROFS', 'ENOSPC', 'ENOTDIR']) {
      expect(() =>
        writeVersionCache({ cache: { latest_version: '0.17.0' }, fs: mkdirFails(code), home: HOME, processEnv: {} }),
      ).toThrow(code)
    }
  })

  it('propagates a write-time failure (mkdir succeeded, writeFileSync did not)', () => {
    for (const code of ['ENOSPC', 'EDQUOT', 'EACCES']) {
      const fs = {
        mkdirSync: () => undefined,
        writeFileSync: () => {
          const e = new Error(code)
          e.code = code
          throw e
        },
      }
      expect(() =>
        writeVersionCache({ cache: { latest_version: '0.17.0' }, fs, home: HOME, processEnv: {} }),
      ).toThrow(code)
    }
  })

  it('never persists unknown keys, however sensitive-looking', () => {
    const fs = vol()
    writeVersionCache({
      cache: {
        latest_version: '0.17.0',
        CALLMEBOT_KEY: 'secret',
        WHATSAPP_PHONE: '+1',
        token: 'ghp_x',
      },
      fs,
      home: HOME,
      processEnv: {},
    })
    const raw = fs.readFileSync(CACHE_PATH, 'utf8').toString()
    expect(raw).not.toContain('CALLMEBOT_KEY')
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('ghp_x')
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'last_check_at',
      'last_prompted_at',
      'latest_version',
    ])
  })

  it('writes the all-null shape for a missing or non-object cache instead of throwing', () => {
    for (const cache of [undefined, null, 'a string', 42, [], true]) {
      const fs = vol()
      expect(() => writeVersionCache({ cache, fs, home: HOME, processEnv: {} })).not.toThrow()
      expect(JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))).toEqual({
        last_check_at: null,
        last_prompted_at: null,
        latest_version: null,
      })
    }
  })

  it('writes human-editable JSON — 2-space indent, single trailing newline', () => {
    const fs = vol()
    writeVersionCache({ cache: { latest_version: '0.17.0' }, fs, home: HOME, processEnv: {} })
    const raw = fs.readFileSync(CACHE_PATH, 'utf8').toString()
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.endsWith('\n\n')).toBe(false)
    expect(raw).toContain('\n  "latest_version"')
  })

  it('overwrites rather than appends, and is byte-identical for identical input', () => {
    const fs = vol()
    const cache = { last_check_at: '2026-08-22T00:00:00.000Z', last_prompted_at: null, latest_version: '0.17.0' }
    writeVersionCache({ cache, fs, home: HOME, processEnv: {} })
    const once = fs.readFileSync(CACHE_PATH, 'utf8').toString()
    writeVersionCache({ cache, fs, home: HOME, processEnv: {} })
    const twice = fs.readFileSync(CACHE_PATH, 'utf8').toString()
    expect(twice).toBe(once)
    expect(JSON.parse(twice)).toEqual(cache)
    writeVersionCache({ cache: { ...cache, latest_version: '0.18.0' }, fs, home: HOME, processEnv: {} })
    // A single JSON document, not two appended ones.
    expect(() => JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))).not.toThrow()
    expect(readVersionCache({ fs, home: HOME, processEnv: {} }).latest_version).toBe('0.18.0')
  })

  it('does not loosen an already-0700 config dir, and does not fail on an existing dir', () => {
    const fs = vol({ [ENV_PATH]: 'CALLMEBOT_KEY=secret\n' })
    fs.chmodSync(dirname(CACHE_PATH), 0o700)
    expect(() =>
      writeVersionCache({ cache: { latest_version: '0.17.0' }, fs, home: HOME, processEnv: {} }),
    ).not.toThrow()
    expect(fs.statSync(dirname(CACHE_PATH)).mode & 0o777).toBe(0o700)
  })

  it('honors an explicit path over the XDG-derived one', () => {
    const fs = vol()
    const path = writeVersionCache({
      cache: { latest_version: '0.17.0' },
      fs,
      path: '/tmp/elsewhere/cache.json',
      home: HOME,
      processEnv: { XDG_CONFIG_HOME: '/xdg' },
    })
    expect(path).toBe('/tmp/elsewhere/cache.json')
    expect(fs.existsSync('/tmp/elsewhere/cache.json')).toBe(true)
    expect(fs.existsSync(join('/xdg', 'ralph', 'update-check.json'))).toBe(false)
  })

  it('round-trips a written cache through read unchanged, repeatedly', () => {
    const fs = vol()
    const cache = {
      last_check_at: '2026-08-22T12:00:00.000Z',
      last_prompted_at: '2026-08-20T12:00:00.000Z',
      latest_version: '0.17.0',
    }
    writeVersionCache({ cache, fs, home: HOME, processEnv: {} })
    const first = readVersionCache({ fs, home: HOME, processEnv: {} })
    writeVersionCache({ cache: first, fs, home: HOME, processEnv: {} })
    expect(readVersionCache({ fs, home: HOME, processEnv: {} })).toEqual(cache)
  })
})

describe('QA cache / global .env coexistence in the same 0700 directory (#24)', () => {
  const ENV_CONTENT = '# ralph creds\nCALLMEBOT_KEY=secret\nWHATSAPP_PHONE=+15550001111\n'

  it('touches ONLY the cache path — never reads, writes or chmods the .env', () => {
    const v = vol({ [ENV_PATH]: ENV_CONTENT })
    const fs = spyFs(v)
    writeVersionCache({ cache: { latest_version: '0.17.0' }, fs, home: HOME, processEnv: {} })
    expect(fs.ops.some((o) => o.path === ENV_PATH)).toBe(false)
    expect(fs.ops.filter((o) => o.op === 'write').map((o) => o.path)).toEqual([CACHE_PATH])
    expect(v.readFileSync(ENV_PATH, 'utf8').toString()).toBe(ENV_CONTENT)
  })

  it('adds exactly one file to the directory tree (.env untouched, nothing removed)', () => {
    const v = vol({ [ENV_PATH]: ENV_CONTENT })
    const before = Object.keys(v.toJSON()).sort()
    writeVersionCache({ cache: { latest_version: '0.17.0' }, fs: v, home: HOME, processEnv: {} })
    const after = Object.keys(v.toJSON()).sort()
    expect(after).toEqual([...before, CACHE_PATH].sort())
  })

  it('.env first, then the cache: creds keep their bytes AND their 0600 mode', () => {
    const v = new Volume()
    writeGlobalCreds({
      values: { CALLMEBOT_KEY: 'secret', WHATSAPP_PHONE: '+15550001111' },
      fs: v,
      home: HOME,
      processEnv: {},
    })
    const envBefore = v.readFileSync(ENV_PATH, 'utf8').toString()
    writeVersionCache({ cache: { latest_version: '0.17.0' }, fs: v, home: HOME, processEnv: {} })
    expect(v.readFileSync(ENV_PATH, 'utf8').toString()).toBe(envBefore)
    expect(v.statSync(ENV_PATH).mode & 0o777).toBe(0o600)
    expect(v.statSync(dirname(ENV_PATH)).mode & 0o777).toBe(0o700)
  })

  it('cache first, then .env: the credential write still lands at 0600 in a 0700 dir', () => {
    const v = new Volume()
    writeVersionCache({ cache: { latest_version: '0.17.0' }, fs: v, home: HOME, processEnv: {} })
    const cacheBefore = v.readFileSync(CACHE_PATH, 'utf8').toString()
    writeGlobalCreds({
      values: { CALLMEBOT_KEY: 'secret' },
      fs: v,
      home: HOME,
      processEnv: {},
    })
    expect(v.statSync(ENV_PATH).mode & 0o777).toBe(0o600)
    expect(v.statSync(dirname(ENV_PATH)).mode & 0o777).toBe(0o700)
    // and the credential upsert did not disturb the cache
    expect(v.readFileSync(CACHE_PATH, 'utf8').toString()).toBe(cacheBefore)
  })

  it('a corrupt cache does not stop the credential resolver from reading the .env', () => {
    const v = vol({ [ENV_PATH]: ENV_CONTENT, [CACHE_PATH]: '{ truncated' })
    expect(readVersionCache({ fs: v, home: HOME, processEnv: {} })).toEqual(EMPTY_VERSION_CACHE)
    expect(v.readFileSync(ENV_PATH, 'utf8').toString()).toBe(ENV_CONTENT)
  })

  it('both files coexist under a shared XDG_CONFIG_HOME base', () => {
    const processEnv = { XDG_CONFIG_HOME: '/xdg' }
    const v = new Volume()
    writeGlobalCreds({ values: { CALLMEBOT_KEY: 'k' }, fs: v, home: HOME, processEnv })
    writeVersionCache({ cache: { latest_version: '0.17.0' }, fs: v, home: HOME, processEnv })
    expect(Object.keys(v.toJSON()).sort()).toEqual(
      [join('/xdg', 'ralph', '.env'), join('/xdg', 'ralph', 'update-check.json')].sort(),
    )
    expect(v.existsSync(join(HOME, '.config', 'ralph'))).toBe(false)
  })
})
