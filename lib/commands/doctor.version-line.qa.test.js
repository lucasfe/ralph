import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import pc from 'picocolors'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctorCommand } from './doctor.js'

// #27 QA augmentation. The dev's doctor.version-line.test.js proves the four
// rendered states and that the exit code survives a newer cached version. These
// suites attack the corners a `toMatch(/unknown/i)`-shaped assertion cannot see,
// and pin the three invariants the issue actually promises:
//
//   1. WORDING is exact, in every state — a loose /unknown/i match would still
//      pass if the installed version silently vanished from the line.
//   2. STALENESS IS INERT — the returned object, stderr, and the whole dependency
//      report must be byte-identical across every cache state, INCLUDING on the
//      missing-critical-dep path (exit 1 for the dep, never for a release).
//   3. NO NETWORK, READ-ONLY — asserted by construction (a walk of doctor.js's
//      transitive import graph, which must not reach execa/child_process/http)
//      and by an fs spy that must see exactly one read and zero writes.
//
// Plus the hostile inputs that reach the new seams from a caller: prerelease and
// build-metadata versions on both sides, non-string currentVersion, every shape a
// hand-edited cache file can take, a hostile `readCache`, and hostile home/env
// values (the documented TypeError path out of versionCachePath).
//
// Every run injects BOTH cacheFs and home, so no test here can touch the real
// ~/.config/ralph/update-check.json.

// Strip ANSI color codes so assertions on the rendered line hold whether or not
// picocolors emits color — it DOES when CI=true, which is how CI runs the suite.
// The ESC byte is built with fromCharCode rather than embedded literally: the
// sequence is ESC + '[33m', and a pattern that drops only the '[33m' tail leaves
// a stray ESC that breaks the exact-match and startsWith assertions below.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = (s) => s.replace(ANSI_RE, '')

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => stripAnsi(chunks.join('')),
    raw: () => chunks.join(''),
  }
}

// A stream whose write() reports backpressure on every call — doctor must not
// care about the return value.
function makeFullStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return false
    },
    output: () => stripAnsi(chunks.join('')),
  }
}

const allPresent = () => true
const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')
const ENV_PATH = join(HOME, '.config', 'ralph', '.env')

const HINT = 'run npm i -g @lucasfe/ralph'

function vol(seed = {}) {
  return Volume.fromJSON(seed, '/')
}

// A cache as writeVersionCache would leave it; `extra` overrides/adds raw fields
// so a test can mangle last_check_at without touching latest_version.
function warmCache(latestVersion, extra = {}, path = CACHE_PATH) {
  return vol({
    [path]: JSON.stringify({
      last_check_at: '2026-08-20T00:00:00.000Z',
      last_prompted_at: null,
      latest_version: latestVersion,
      ...extra,
    }),
  })
}

function rawCache(raw, path = CACHE_PATH) {
  return vol({ [path]: raw })
}

// Records every fs op so "reads once, writes never" is proven at the call level.
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

async function runDoctor({
  cacheFs = new Volume(),
  home = HOME,
  currentVersion = '0.17.0',
  hasCommand = allPresent,
  env = {},
  stdout = makeStream(),
  extra = {},
} = {}) {
  const stderr = makeStream()
  const result = await doctorCommand({
    stdout,
    stderr,
    hasCommand,
    platform: 'mac',
    env,
    currentVersion,
    cacheFs,
    home,
    ...extra,
  })
  return { result, out: stdout.output(), err: stderr.output(), stdout, stderr }
}

const versionLines = (out) => out.split('\n').filter((l) => l.startsWith('version: '))
const versionLine = (out) => versionLines(out)[0]
const withoutVersionLine = (out) =>
  out
    .split('\n')
    .filter((l) => !l.startsWith('version: '))
    .join('\n')

const UNKNOWN_LATEST = (installed = '0.17.0') =>
  `version: ${installed} — cached latest: unknown (no update check cached yet)`

describe('QA #27 doctor version line — exact wording in every state', () => {
  it('renders the newer-version line verbatim, hint included', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.18.0'), currentVersion: '0.17.0' })
    expect(versionLine(out)).toBe(
      `version: 0.17.0 — cached latest: 0.18.0 — update available (${HINT})`,
    )
  })

  it('renders the up-to-date line verbatim when the cache equals the install', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.17.0') })
    expect(versionLine(out)).toBe('version: 0.17.0 — cached latest: 0.17.0 — up to date')
  })

  it('renders the up-to-date line verbatim when the cache is BEHIND the install', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.16.0') })
    expect(versionLine(out)).toBe('version: 0.17.0 — cached latest: 0.16.0 — up to date')
  })

  it('renders the unknown-latest line verbatim, still naming the installed version', async () => {
    // The whole point of the fallback: a missing answer for "latest", never a
    // missing answer for "what am I running".
    const { out } = await runDoctor({ cacheFs: new Volume() })
    expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
  })

  it('renders both values and NO verdict when the install is not comparable', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.18.0'), currentVersion: 'unknown' })
    expect(versionLine(out)).toBe('version: unknown — cached latest: 0.18.0')
    expect(out).not.toContain('no update check cached yet')
  })

  it('prints the version line exactly once, on stdout, and never on stderr', async () => {
    const { out, err } = await runDoctor({ cacheFs: warmCache('0.18.0') })
    expect(versionLines(out)).toHaveLength(1)
    expect(err).toBe('')
  })

  it('prints the version line ABOVE the dependency report so the early return cannot skip it', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.18.0') })
    const lines = out.split('\n')
    const versionIdx = lines.findIndex((l) => l.startsWith('version: '))
    const headerIdx = lines.findIndex((l) => l.startsWith('Ralph doctor'))
    const firstDepIdx = lines.findIndex((l) => /^\s+[✓✗!]\s/.test(l))
    expect(headerIdx).toBe(0)
    expect(versionIdx).toBe(1)
    expect(firstDepIdx).toBeGreaterThan(versionIdx)
  })

  it('keeps the version line beneath the agent-fallback warning, not above it', async () => {
    const { out } = await runDoctor({
      cacheFs: warmCache('0.18.0'),
      env: { RALPH_AGENT: 'gpt5' },
    })
    const lines = out.split('\n')
    const warnIdx = lines.findIndex((l) => l.includes('unrecognized'))
    const versionIdx = lines.findIndex((l) => l.startsWith('version: '))
    expect(warnIdx).toBe(1)
    expect(versionIdx).toBe(2)
  })

  // Skipped rather than silently no-op'd when color is off (local vitest), so a
  // run that asserts nothing reports as skipped instead of a false green.
  it.skipIf(!pc.isColorSupported)(
    'colors the verdict — yellow for an available update, green for up to date, plain for unknown',
    async () => {
      const behind = await runDoctor({ cacheFs: warmCache('0.18.0'), stdout: makeStream() })
      const current = await runDoctor({ cacheFs: warmCache('0.17.0'), stdout: makeStream() })
      const cold = await runDoctor({ cacheFs: new Volume(), stdout: makeStream() })
      const rawLine = (s) => s.raw().split('\n').find((l) => l.includes('cached latest'))
      expect(rawLine(behind.stdout)).toBe(
        pc.yellow(`version: 0.17.0 — cached latest: 0.18.0 — update available (${HINT})`),
      )
      expect(rawLine(current.stdout)).toBe(
        pc.green('version: 0.17.0 — cached latest: 0.17.0 — up to date'),
      )
      // No verdict => no color to carry.
      expect(rawLine(cold.stdout)).toBe(UNKNOWN_LATEST('0.17.0'))
    },
  )
})

describe('QA #27 doctor version line — prerelease, build metadata, every comparison rung', () => {
  // [installed, cached, expected verdict]
  const cases = [
    // Every rung of the version tuple.
    ['0.17.0', '0.17.1', 'update available', 'patch bump'],
    ['0.17.0', '0.18.0', 'update available', 'minor bump'],
    ['0.17.0', '1.0.0', 'update available', 'major bump'],
    ['0.17.1', '0.17.0', 'up to date', 'patch behind'],
    ['1.0.0', '0.17.0', 'up to date', 'major behind'],
    ['0.17.0', '0.17.0', 'up to date', 'identical'],
    // Prerelease on the CACHED side.
    ['0.17.0', '0.18.0-beta.1', 'update available', 'a newer minor prerelease is still newer'],
    ['0.17.0', '0.17.0-beta.1', 'up to date', 'a prerelease of the installed release is older'],
    ['0.18.0', '0.18.0-beta.1', 'up to date', 'release beats its own prerelease'],
    // Prerelease on the INSTALLED side.
    ['0.18.0-beta.1', '0.18.0', 'update available', 'the release supersedes the beta'],
    ['0.18.0-beta.1', '0.18.0-beta.1', 'up to date', 'identical prereleases'],
    ['0.18.0-beta.1', '0.18.0-beta.2', 'update available', 'later beta of the same release'],
    ['0.18.0-beta.2', '0.18.0-beta.1', 'up to date', 'earlier beta is not an update'],
    ['0.18.0-rc.1', '0.19.0-alpha.1', 'update available', 'higher minor wins over tag name'],
    // Build metadata is not part of precedence.
    ['0.17.0+build.5', '0.17.0', 'up to date', 'build metadata on the install only'],
    ['0.17.0', '0.17.0+build.5', 'up to date', 'build metadata on the cache only'],
    ['0.17.0+build.5', '0.17.0+build.9', 'up to date', 'differing build metadata alone'],
    ['0.17.0+build.5', '0.18.0+build.1', 'update available', 'real bump with build metadata'],
    ['0.18.0-beta.1+b.5', '0.18.0-beta.1+b.9', 'up to date', 'prerelease plus build metadata'],
  ]

  for (const [installed, cached, verdict, label] of cases) {
    it(`${installed} vs cached ${cached} => ${verdict} (${label})`, async () => {
      const { out, result } = await runDoctor({
        cacheFs: warmCache(cached),
        currentVersion: installed,
      })
      expect(versionLine(out)).toBe(
        verdict === 'update available'
          ? `version: ${installed} — cached latest: ${cached} — update available (${HINT})`
          : `version: ${installed} — cached latest: ${cached} — up to date`,
      )
      // Staleness is never an error, whichever way the comparison went.
      expect(result.exitCode).toBe(0)
    })
  }

  it('echoes the cached version verbatim, build metadata and all', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.18.0-beta.1+sha.abc123') })
    expect(out).toContain('cached latest: 0.18.0-beta.1+sha.abc123')
  })

  it('documents the shared comparator quirk: prerelease tags compare LEXICALLY, not numerically', async () => {
    // compareSemver (update-check.js, #21) orders prerelease tags by string
    // compare, so 'beta.10' sorts BELOW 'beta.2'. Pinned here because the #27
    // line is the first place a user can see it. Pre-existing, not introduced by
    // #27 — a real semver ordering would say "update available" for both.
    const behind = await runDoctor({
      cacheFs: warmCache('0.18.0-beta.10'),
      currentVersion: '0.18.0-beta.2',
    })
    expect(versionLine(behind.out)).toContain('up to date')
    const ahead = await runDoctor({
      cacheFs: warmCache('0.18.0-beta.9'),
      currentVersion: '0.18.0-beta.10',
    })
    expect(versionLine(ahead.out)).toContain('update available')
  })

  it('a shorter version tuple is padded with zeros rather than rejected', async () => {
    // '0.18' is not valid semver per isValidSemver, so it must NOT be compared.
    const { out } = await runDoctor({ cacheFs: warmCache('0.18'), currentVersion: '0.17.0' })
    expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
  })

  it('a leading-v tag is not treated as a version on either side', async () => {
    const cached = await runDoctor({ cacheFs: warmCache('v0.18.0') })
    expect(versionLine(cached.out)).toBe(UNKNOWN_LATEST('0.17.0'))
    const installed = await runDoctor({
      cacheFs: warmCache('0.18.0'),
      currentVersion: 'v0.17.0',
    })
    expect(versionLine(installed.out)).toBe('version: v0.17.0 — cached latest: 0.18.0')
  })

  it('tolerates absurd but well-formed version numbers without a verdict flip', async () => {
    const { out } = await runDoctor({
      cacheFs: warmCache('99999999999999999999.0.0'),
      currentVersion: '0.17.0',
    })
    expect(versionLine(out)).toContain('update available')
  })
})

describe('QA #27 doctor version line — hostile currentVersion from the caller', () => {
  it('trims a whitespace-padded currentVersion in BOTH the label and the comparison', async () => {
    for (const padded of [' 0.17.0 ', '\t0.17.0\n', '\n  0.17.0  \t']) {
      const { out } = await runDoctor({ cacheFs: warmCache('0.18.0'), currentVersion: padded })
      expect(versionLine(out)).toBe(
        `version: 0.17.0 — cached latest: 0.18.0 — update available (${HINT})`,
      )
    }
  })

  it('a padded version equal to the cached one is up to date, not an update', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.17.0'), currentVersion: '  0.17.0  ' })
    expect(versionLine(out)).toBe('version: 0.17.0 — cached latest: 0.17.0 — up to date')
  })

  it('an empty or whitespace-only currentVersion degrades to the unknown label', async () => {
    for (const blank of ['', '   ', '\t\n ']) {
      const { out, result } = await runDoctor({
        cacheFs: warmCache('0.18.0'),
        currentVersion: blank,
      })
      expect(versionLine(out)).toBe('version: unknown — cached latest: 0.18.0')
      expect(result.exitCode).toBe(0)
    }
  })

  it('never coerces a non-string currentVersion into the output', async () => {
    // A caller that hands over garbage gets "unknown", not `version: 42` and not
    // `version: [object Object]` — and never a fabricated comparison.
    const hostile = [null, 42, 0, {}, [], true, false, Symbol('0.17.0'), () => '0.17.0']
    for (const currentVersion of hostile) {
      const { out, result } = await runDoctor({
        cacheFs: warmCache('0.18.0'),
        currentVersion,
      })
      expect(versionLine(out)).toBe('version: unknown — cached latest: 0.18.0')
      expect(out).not.toMatch(/update available|up to date/)
      expect(result.exitCode).toBe(0)
    }
  })

  it('does not honor a toString()/valueOf() shim on currentVersion', async () => {
    const { out } = await runDoctor({
      cacheFs: warmCache('0.18.0'),
      currentVersion: { toString: () => '0.17.0', valueOf: () => '0.17.0' },
    })
    expect(versionLine(out)).toBe('version: unknown — cached latest: 0.18.0')
  })

  it('does not honor a boxed String either (typeof is object)', async () => {
    const { out } = await runDoctor({
      cacheFs: warmCache('0.18.0'),
      // eslint-disable-next-line no-new-wrappers
      currentVersion: new String('0.17.0'),
    })
    expect(versionLine(out)).toBe('version: unknown — cached latest: 0.18.0')
  })

  it('an uncomparable install with an unknown latest still yields one honest line', async () => {
    const { out } = await runDoctor({ cacheFs: new Volume(), currentVersion: null })
    expect(versionLine(out)).toBe(UNKNOWN_LATEST('unknown'))
  })
})

describe('QA #27 doctor version line — every shape a cache FILE can take', () => {
  const unknownRaws = [
    ['an empty file', ''],
    ['whitespace only', '  \n\t '],
    ['a JSON null', 'null'],
    ['a JSON true', 'true'],
    ['a bare JSON number', '42'],
    ['a bare JSON string that looks like a version', '"0.18.0"'],
    ['a JSON array of cache objects', '[{"latest_version":"0.18.0"}]'],
    ['an empty JSON array', '[]'],
    ['truncated JSON', '{"latest_version":"0.18.0"'],
    ['JSON with trailing garbage', '{"latest_version":"0.18.0"} oops'],
    ['a BOM-prefixed object', '﻿{"latest_version":"0.18.0"}'],
    ['single-quoted pseudo-JSON', "{'latest_version':'0.18.0'}"],
    ['an HTML error page', '<!doctype html><html><body>502</body></html>'],
    ['a NUL byte', '\0'],
    ['a numeric latest_version', '{"latest_version":0.18}'],
    ['an array latest_version', '{"latest_version":["0.18.0"]}'],
    ['an object latest_version', '{"latest_version":{"v":"0.18.0"}}'],
    ['a null latest_version', '{"latest_version":null}'],
    ['a boolean latest_version', '{"latest_version":true}'],
    ['an empty-string latest_version', '{"latest_version":""}'],
    ['a whitespace-only latest_version', '{"latest_version":"   "}'],
    ['a non-version latest_version', '{"latest_version":"banana"}'],
    ['a latest_version with an inner space', '{"latest_version":"0.18. 0"}'],
    ['a range expression', '{"latest_version":"^0.18.0"}'],
    ['a dist-tag', '{"latest_version":"latest"}'],
    ['no latest_version key at all', '{"last_check_at":"2026-08-20T00:00:00.000Z"}'],
  ]

  for (const [label, raw] of unknownRaws) {
    it(`degrades to the unknown line for ${label}`, async () => {
      const { out, result } = await runDoctor({ cacheFs: rawCache(raw) })
      expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
      expect(out).not.toMatch(/update available|up to date/)
      expect(result.exitCode).toBe(0)
    })
  }

  it('trims a whitespace-padded latest_version instead of rejecting it', async () => {
    const { out } = await runDoctor({ cacheFs: rawCache('{"latest_version":"  0.18.0\\n"}') })
    expect(versionLine(out)).toBe(
      `version: 0.17.0 — cached latest: 0.18.0 — update available (${HINT})`,
    )
  })

  it('takes the LAST duplicated latest_version key (pins JSON.parse semantics)', async () => {
    const { out } = await runDoctor({
      cacheFs: rawCache('{"latest_version":"9.9.9","latest_version":"0.16.0"}'),
    })
    expect(versionLine(out)).toBe('version: 0.17.0 — cached latest: 0.16.0 — up to date')
  })

  it('ignores unknown keys and cannot be prototype-polluted by a hand-edited cache', async () => {
    const raw =
      '{"latest_version":"0.18.0","CALLMEBOT_KEY":"leaked",' +
      '"__proto__":{"polluted":true},"exitCode":1}'
    const { out, result } = await runDoctor({ cacheFs: rawCache(raw) })
    expect(versionLine(out)).toContain('cached latest: 0.18.0')
    expect(out).not.toContain('leaked')
    expect(result.exitCode).toBe(0)
    expect({}.polluted).toBeUndefined()
  })

  it('survives a multi-megabyte latest_version value', async () => {
    const { out, result } = await runDoctor({
      cacheFs: rawCache(JSON.stringify({ latest_version: '0'.repeat(2_000_000) })),
    })
    expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
    expect(result.exitCode).toBe(0)
  })

  it('survives a bloated cache file and still finds the real field', async () => {
    const junk = {}
    for (let i = 0; i < 5000; i++) junk[`k${i}`] = 'x'.repeat(50)
    junk.latest_version = '0.18.0'
    const { out } = await runDoctor({ cacheFs: rawCache(JSON.stringify(junk)) })
    expect(versionLine(out)).toContain('cached latest: 0.18.0')
  })

  it('survives deeply nested JSON (arrays and objects) without crashing', async () => {
    const depth = 5000
    const nestedArrays = '['.repeat(depth) + ']'.repeat(depth)
    const nestedObjects = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth)
    for (const raw of [nestedArrays, nestedObjects]) {
      const { out, result } = await runDoctor({ cacheFs: rawCache(raw) })
      expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
      expect(result.exitCode).toBe(0)
    }
  })

  it('reads the cache from an XDG_CONFIG_HOME base, proving env reaches the cache read', async () => {
    const xdgPath = join('/xdg', 'ralph', 'update-check.json')
    const { out } = await runDoctor({
      cacheFs: warmCache('0.18.0', {}, xdgPath),
      env: { XDG_CONFIG_HOME: '/xdg' },
    })
    expect(versionLine(out)).toContain('cached latest: 0.18.0')
  })

  it('a cache under ~/.config is NOT read when XDG_CONFIG_HOME points elsewhere', async () => {
    const { out } = await runDoctor({
      cacheFs: warmCache('0.18.0'),
      env: { XDG_CONFIG_HOME: '/xdg' },
    })
    expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
  })
})

describe('QA #27 doctor reads NO throttle bookkeeping', () => {
  // doctor reports what the last check left behind. The weekly window and the
  // prompt throttle belong to `ralph start`; doctor must not apply either, or a
  // user whose cache is eight days old would be told "unknown" for no reason.
  const stamps = [
    ['missing entirely', {}],
    ['null', { last_check_at: null }],
    ['an empty string', { last_check_at: '' }],
    ['unparseable garbage', { last_check_at: 'not-a-date' }],
    ['a number', { last_check_at: 1755648000000 }],
    ['an object', { last_check_at: { at: 'now' } }],
    ['ten years stale', { last_check_at: '2016-01-01T00:00:00.000Z' }],
    ['far in the future', { last_check_at: '2099-01-01T00:00:00.000Z' }],
    ['well outside the weekly window', { last_check_at: '2026-01-01T00:00:00.000Z' }],
  ]

  for (const [label, extra] of stamps) {
    it(`still reports the cached latest when last_check_at is ${label}`, async () => {
      const cacheFs = rawCache(JSON.stringify({ latest_version: '0.18.0', ...extra }))
      const { out, result } = await runDoctor({ cacheFs })
      expect(versionLine(out)).toBe(
        `version: 0.17.0 — cached latest: 0.18.0 — update available (${HINT})`,
      )
      expect(result.exitCode).toBe(0)
    })
  }

  it('ignores last_prompted_at entirely, however mangled', async () => {
    const cacheFs = rawCache(
      JSON.stringify({ latest_version: '0.18.0', last_prompted_at: { nope: true } }),
    )
    const { out } = await runDoctor({ cacheFs })
    expect(versionLine(out)).toContain('update available')
  })

  it('reports the cached latest even when the update check is opted OUT', async () => {
    // RALPH_NO_UPDATE_CHECK disables CHECKING, not reporting: doctor makes no
    // network call either way, so suppressing the line would only hide a fact the
    // user already has on disk.
    for (const value of ['1', 'true', 'yes', 'off']) {
      const { out } = await runDoctor({
        cacheFs: warmCache('0.18.0'),
        env: { RALPH_NO_UPDATE_CHECK: value },
      })
      expect(versionLine(out)).toContain('cached latest: 0.18.0')
    }
  })
})

describe('QA #27 doctor version line — hostile readCache seam', () => {
  const thrown = [
    ['a bare string', 'boom'],
    ['undefined', undefined],
    ['null', null],
    ['a plain object', { code: 'EACCES' }],
    ['a number', 42],
    ['a TypeError', new TypeError('path must be a string')],
    ['a RangeError', new RangeError('nope')],
  ]

  for (const [label, value] of thrown) {
    it(`degrades to unknown when readCache throws ${label}`, async () => {
      const { out, result } = await runDoctor({
        extra: {
          readCache: () => {
            throw value
          },
        },
      })
      expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
      expect(result.exitCode).toBe(0)
    })
  }

  const returned = [
    ['null', null, UNKNOWN_LATEST('0.17.0')],
    ['undefined', undefined, UNKNOWN_LATEST('0.17.0')],
    ['a string', '0.18.0', UNKNOWN_LATEST('0.17.0')],
    ['a number', 42, UNKNOWN_LATEST('0.17.0')],
    ['true', true, UNKNOWN_LATEST('0.17.0')],
    ['an empty object', {}, UNKNOWN_LATEST('0.17.0')],
    ['an array', [], UNKNOWN_LATEST('0.17.0')],
    ['an array holding a cache', [{ latest_version: '0.18.0' }], UNKNOWN_LATEST('0.17.0')],
    [
      'a frozen cache object',
      Object.freeze({ last_check_at: null, last_prompted_at: null, latest_version: '0.18.0' }),
      `version: 0.17.0 — cached latest: 0.18.0 — update available (${HINT})`,
    ],
    [
      'a null-prototype cache object',
      Object.assign(Object.create(null), { latest_version: '0.18.0' }),
      `version: 0.17.0 — cached latest: 0.18.0 — update available (${HINT})`,
    ],
  ]

  for (const [label, value, expected] of returned) {
    it(`handles readCache returning ${label}`, async () => {
      const { out, result } = await runDoctor({ extra: { readCache: () => value } })
      expect(versionLine(out)).toBe(expected)
      expect(result.exitCode).toBe(0)
    })
  }

  it('reads an inherited latest_version — a prototype read is still a read', async () => {
    const proto = { latest_version: '9.9.9' }
    const { out } = await runDoctor({ extra: { readCache: () => Object.create(proto) } })
    // Pins what the implementation does today: a plain property read resolves up
    // the prototype chain, and the inherited value is used. It must not crash.
    expect(versionLine(out)).toContain('cached latest: 9.9.9')
  })

  it('degrades to unknown when the latest_version GETTER throws', async () => {
    // The cache object crosses a seam, so `latest_version` may be a throwing
    // getter rather than a plain field. It must be read INSIDE the same guard as
    // the readCache call: a diagnostic never crashes over its own cache.
    const cache = {
      get latest_version() {
        throw new Error('hostile getter')
      },
    }
    const { out, result } = await runDoctor({ extra: { readCache: () => cache } })
    expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
    expect(result.exitCode).toBe(0)
  })

  it('degrades to unknown when readCache returns a Proxy that throws on every get', async () => {
    const cache = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile proxy')
        },
      },
    )
    const { out, result } = await runDoctor({ extra: { readCache: () => cache } })
    expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
    expect(result.exitCode).toBe(0)
  })

  it('reads latest_version EXACTLY once, so a type-changing getter cannot become a TypeError', async () => {
    // The direct probe for the single-read property: cachedLatestVersion must land
    // the value in one local rather than re-reading it for the .trim(). A getter
    // that answers '0.18.0' first and 42 afterwards distinguishes all three
    // possible implementations — one read renders the update, two reads throw
    // (`.trim is not a function`), and a blanket `return null` would render the
    // unknown line instead.
    let reads = 0
    const cache = {
      get latest_version() {
        reads += 1
        return reads === 1 ? '0.18.0' : 42
      },
    }
    const { out, result } = await runDoctor({ extra: { readCache: () => cache } })
    expect(reads).toBe(1)
    expect(versionLine(out)).toBe(
      `version: 0.17.0 — cached latest: 0.18.0 — update available (${HINT})`,
    )
    expect(result.exitCode).toBe(0)
  })

  it('calls readCache exactly once per run, with the injected fs/home/env', async () => {
    const calls = []
    const env = { RALPH_AGENT: 'codex' }
    const cacheFs = new Volume()
    await runDoctor({
      cacheFs,
      env,
      extra: {
        readCache: (args) => {
          calls.push(args)
          return { latest_version: '0.18.0' }
        },
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].fs).toBe(cacheFs)
    expect(calls[0].home).toBe(HOME)
    expect(calls[0].processEnv).toBe(env)
  })

  it('a non-function readCache degrades instead of crashing', async () => {
    for (const readCache of [null, 'nope', 42, {}]) {
      const { out, result } = await runDoctor({ extra: { readCache } })
      expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
      expect(result.exitCode).toBe(0)
    }
  })
})

describe('QA #27 doctor version line — hostile home and env (the documented TypeError path)', () => {
  const homes = [
    ['null', null],
    ['a plain object', {}],
    ['a number', 42],
    ['an array', []],
    ['true', true],
    ['a function', () => '/home/me'],
    ['a symbol', Symbol('/home/me')],
  ]

  for (const [label, home] of homes) {
    it(`degrades to unknown for a ${label} home`, async () => {
      const { out, result } = await runDoctor({ cacheFs: warmCache('0.18.0'), home })
      expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
      expect(result.exitCode).toBe(0)
    })
  }

  it('an empty-string home resolves to a relative path and simply finds nothing', async () => {
    const { out, result } = await runDoctor({ cacheFs: warmCache('0.18.0'), home: '' })
    expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
    expect(result.exitCode).toBe(0)
  })

  const envs = [
    ['null', null],
    ['a truthy number XDG_CONFIG_HOME', { XDG_CONFIG_HOME: 42 }],
    ['an object XDG_CONFIG_HOME', { XDG_CONFIG_HOME: {} }],
    ['a boolean XDG_CONFIG_HOME', { XDG_CONFIG_HOME: true }],
    ['an array XDG_CONFIG_HOME', { XDG_CONFIG_HOME: ['/xdg'] }],
    ['an XDG_CONFIG_HOME whose trim() throws', { XDG_CONFIG_HOME: { trim: () => { throw new Error('boom') } } }],
  ]

  for (const [label, env] of envs) {
    it(`never crashes with ${label} in the env bag`, async () => {
      const { out, result } = await runDoctor({ cacheFs: warmCache('0.18.0'), env })
      expect(result.exitCode).toBe(0)
      // A null bag normalizes to {} and still resolves ~/.config; the non-string
      // values throw out of versionCachePath and degrade to unknown.
      expect(versionLines(out)).toHaveLength(1)
      expect(out).toContain('version: 0.17.0')
    })
  }

  it('a null env bag still resolves the default ~/.config cache path', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.18.0'), env: null })
    expect(versionLine(out)).toBe(
      `version: 0.17.0 — cached latest: 0.18.0 — update available (${HINT})`,
    )
  })

  it('a non-string XDG_CONFIG_HOME degrades the version line WITHOUT disturbing the rest of doctor', async () => {
    const { out, result } = await runDoctor({
      cacheFs: warmCache('0.18.0'),
      env: { XDG_CONFIG_HOME: 42, RALPH_AGENT: 'codex', TASK_SOURCE: 'folder' },
    })
    expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
    // The agent and source resolvers read the SAME bag and are unaffected.
    expect(out).toContain('agent: codex')
    expect(out).toContain('✓ codex')
    expect(out).not.toContain('gh')
    expect(result.exitCode).toBe(0)
  })

  it('an env Proxy hostile only on XDG_CONFIG_HOME degrades the version line', async () => {
    const env = new Proxy(
      { RALPH_AGENT: 'claude' },
      {
        get(target, key) {
          if (key === 'XDG_CONFIG_HOME') throw new Error('hostile env bag')
          return target[key]
        },
      },
    )
    const { out, result } = await runDoctor({ cacheFs: warmCache('0.18.0'), env })
    expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
    expect(result.exitCode).toBe(0)
  })

  it('an env bag hostile on EVERY get fails in the agent resolver, not in the #27 cache read', async () => {
    // Documents where the remaining gap is: resolveAgent/resolveSource read the
    // bag at doctor.js:39-41, before the version line is rendered, and neither is
    // guarded. That is pre-existing env handling, untouched by #27 — recorded so a
    // future hardening pass knows the version line is not the weak link.
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile env bag')
        },
      },
    )
    await expect(runDoctor({ cacheFs: warmCache('0.18.0'), env })).rejects.toThrow(
      'hostile env bag',
    )
  })
})

describe('QA #27 doctor version line — hostile cache fs', () => {
  for (const code of ['EACCES', 'EPERM', 'EISDIR', 'ELOOP', 'EMFILE', 'ENOTDIR', 'EIO', 'ENOENT']) {
    it(`degrades to unknown when readFileSync throws ${code}`, async () => {
      const { out, result } = await runDoctor({ cacheFs: throwingRead(code) })
      expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
      expect(result.exitCode).toBe(0)
    })
  }

  it('degrades to unknown when readFileSync throws a non-Error', async () => {
    const hostile = [
      { readFileSync: () => { throw 'a bare string' } },
      { readFileSync: () => { throw undefined } },
      { readFileSync: () => { throw { code: 'EACCES' } } },
    ]
    for (const cacheFs of hostile) {
      const { out, result } = await runDoctor({ cacheFs })
      expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
      expect(result.exitCode).toBe(0)
    }
  })

  it('degrades to unknown for a missing/odd fs implementation', async () => {
    const hostile = [null, {}, { readFileSync: 'not a function' }, { readFileSync: () => undefined }, { readFileSync: () => 42 }]
    for (const cacheFs of hostile) {
      const { out, result } = await runDoctor({ cacheFs })
      expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
      expect(result.exitCode).toBe(0)
    }
  })

  it('accepts a Buffer from readFileSync (the real fs contract)', async () => {
    const cacheFs = {
      readFileSync: () => Buffer.from(JSON.stringify({ latest_version: '0.18.0' }), 'utf8'),
    }
    const { out } = await runDoctor({ cacheFs })
    expect(versionLine(out)).toContain('cached latest: 0.18.0')
  })

  it('degrades to unknown when a DIRECTORY sits where the cache file should be', async () => {
    const v = new Volume()
    v.mkdirSync(CACHE_PATH, { recursive: true })
    const { out, result } = await runDoctor({ cacheFs: v })
    expect(versionLine(out)).toBe(UNKNOWN_LATEST('0.17.0'))
    expect(result.exitCode).toBe(0)
  })

  it('tolerates a stdout whose write() reports backpressure', async () => {
    const stdout = makeFullStream()
    const { result } = await runDoctor({ cacheFs: warmCache('0.18.0'), stdout })
    expect(result.exitCode).toBe(0)
    expect(versionLine(stdout.output())).toContain('update available')
  })
})

describe('QA #27 doctor is READ-ONLY — one read, zero writes, .env never opened', () => {
  const states = () => [
    ['cold', new Volume()],
    ['warm and behind', warmCache('9.9.9')],
    ['warm and current', warmCache('0.17.0')],
    ['corrupt', rawCache('{ not json')],
    ['non-semver', warmCache('banana')],
    ['a directory at the cache path', (() => {
      const v = new Volume()
      v.mkdirSync(CACHE_PATH, { recursive: true })
      return v
    })()],
  ]

  for (const [label, v] of states()) {
    it(`writes nothing and mkdirs nothing — ${label} cache`, async () => {
      const cacheFs = spyFs(v)
      const { result } = await runDoctor({ cacheFs })
      expect(cacheFs.ops.filter((o) => o.op !== 'read')).toEqual([])
      expect(result.exitCode).toBe(0)
    })
  }

  it('reads the cache path EXACTLY once and nothing else', async () => {
    const cacheFs = spyFs(warmCache('0.18.0'))
    await runDoctor({ cacheFs })
    expect(cacheFs.ops).toEqual([{ op: 'read', path: CACHE_PATH }])
  })

  it('writes nothing even on the missing-critical-dep path', async () => {
    const cacheFs = spyFs(warmCache('9.9.9'))
    const { result } = await runDoctor({ cacheFs, hasCommand: (c) => c !== 'tmux' })
    expect(result.exitCode).toBe(1)
    expect(cacheFs.ops).toEqual([{ op: 'read', path: CACHE_PATH }])
  })

  it('never opens the sibling ralph/.env credential file, and leaves it byte-identical', async () => {
    const CREDS = '# ralph creds\nCALLMEBOT_KEY=secret\nWHATSAPP_PHONE=+15550001111\n'
    const v = vol({
      [ENV_PATH]: CREDS,
      [CACHE_PATH]: JSON.stringify({ latest_version: '0.18.0' }),
    })
    const before = Object.keys(v.toJSON()).sort()
    const cacheFs = spyFs(v)
    const { out } = await runDoctor({ cacheFs })
    expect(cacheFs.ops.some((o) => o.path === ENV_PATH)).toBe(false)
    expect(v.readFileSync(ENV_PATH, 'utf8').toString()).toBe(CREDS)
    expect(Object.keys(v.toJSON()).sort()).toEqual(before)
    // And no credential value can leak into the diagnostic output.
    expect(out).not.toContain('secret')
    expect(out).not.toContain('CALLMEBOT_KEY')
    expect(out).not.toContain('+15550001111')
  })

  it('never opens the .env under an XDG base either', async () => {
    const xdgEnv = join('/xdg', 'ralph', '.env')
    const xdgCache = join('/xdg', 'ralph', 'update-check.json')
    const v = vol({ [xdgEnv]: 'CALLMEBOT_KEY=secret\n', [xdgCache]: '{"latest_version":"0.18.0"}' })
    const cacheFs = spyFs(v)
    await runDoctor({ cacheFs, env: { XDG_CONFIG_HOME: '/xdg' } })
    expect(cacheFs.ops).toEqual([{ op: 'read', path: xdgCache }])
  })

  it('creates no directories on a cold start (no ~/.config/ralph side effect)', async () => {
    const v = new Volume()
    await runDoctor({ cacheFs: v })
    expect(v.toJSON()).toEqual({})
  })
})

describe('QA #27 doctor takes NO network dependency — asserted on the import graph', () => {
  const DOCTOR = fileURLToPath(new URL('./doctor.js', import.meta.url))

  function specifiersOf(src) {
    const out = []
    const patterns = [
      /\bfrom\s*['"]([^'"]+)['"]/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /^\s*import\s+['"]([^'"]+)['"]/gm,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ]
    for (const re of patterns) {
      let m
      while ((m = re.exec(src)) !== null) out.push(m[1])
    }
    return out
  }

  // Walk the STATIC import graph from doctor.js, following relative specifiers.
  function importGraph(entry) {
    const files = new Map()
    const bare = new Set()
    const stack = [entry]
    while (stack.length > 0) {
      const file = stack.pop()
      if (files.has(file)) continue
      const src = readFileSync(file, 'utf8')
      files.set(file, src)
      for (const spec of specifiersOf(src)) {
        if (spec.startsWith('.')) stack.push(resolve(dirname(file), spec))
        else bare.add(spec)
      }
    }
    return { files, bare }
  }

  const graph = importGraph(DOCTOR)
  const rel = (f) => f.slice(f.indexOf('/lib/') + 1)

  it('the walker actually reached the #27 modules (guards against a vacuous pass)', () => {
    const names = [...graph.files.keys()].map(rel)
    expect(names).toContain('lib/commands/doctor.js')
    expect(names).toContain('lib/update-check.js')
    expect(names).toContain('lib/version-cache.js')
    expect(names).toContain('lib/utils/global-config.js')
    expect(graph.files.size).toBeGreaterThan(5)
  })

  it('pulls in exactly one third-party package and only filesystem builtins', () => {
    expect([...graph.bare].sort()).toEqual(['node:fs', 'node:os', 'node:path', 'picocolors'])
  })

  it('reaches nothing that can shell out or open a socket', () => {
    const forbidden = [
      'execa',
      'node:child_process',
      'child_process',
      'node:http',
      'http',
      'node:https',
      'https',
      'node:net',
      'net',
      'node:tls',
      'tls',
      'node:dns',
      'dns',
      'node:dgram',
      'node:worker_threads',
      'node:cluster',
      'undici',
      'node-fetch',
      'axios',
    ]
    for (const spec of forbidden) expect([...graph.bare]).not.toContain(spec)
  })

  it('does not reach install-target.js — the reason PACKAGE_NAME comes from update-check.js', () => {
    // install-target.js exports PACKAGE_NAME too, but imports execa: sourcing the
    // constant from there would have given doctor a transitive exec dependency.
    const names = [...graph.files.keys()].map(rel)
    expect(names).not.toContain('lib/install-target.js')
    expect(names.some((n) => n.includes('update.js'))).toBe(false)
  })

  it('no source file in the graph calls fetch, execa, or spawns a process', () => {
    const banned = [
      [/\bfetch\s*\(/, 'fetch('],
      [/\bexeca\b/, 'execa'],
      [/child_process/, 'child_process'],
      [/\bspawn(Sync)?\s*\(/, 'spawn('],
      [/\bexecSync\s*\(/, 'execSync('],
      [/XMLHttpRequest/, 'XMLHttpRequest'],
      [/new\s+WebSocket/, 'WebSocket'],
      [/\bhttps?\.request\b/, 'http.request'],
    ]
    for (const [file, src] of graph.files) {
      for (const [re, label] of banned) {
        expect(re.test(src), `${rel(file)} must not reference ${label}`).toBe(false)
      }
    }
  })

  it('an injected exec/fetch seam is simply not part of doctor\'s contract', async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = () => {
      fetchCalls += 1
      throw new Error('doctor must not hit the network')
    }
    try {
      const { result, out } = await runDoctor({
        cacheFs: warmCache('0.18.0'),
        extra: {
          exec: () => {
            throw new Error('doctor must not shell out')
          },
          fetchLatest: () => {
            throw new Error('doctor must not check')
          },
        },
      })
      expect(result.exitCode).toBe(0)
      expect(versionLine(out)).toContain('update available')
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(fetchCalls).toBe(0)
  })

  it('runs synchronously fast enough to be offline-safe (no hidden await on I/O)', async () => {
    const started = Date.now()
    await runDoctor({ cacheFs: warmCache('0.18.0') })
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('QA #27 staleness is inert — identical result and identical report across cache states', () => {
  // Every cache state a real machine can be in, plus the two argument-level
  // failures (unreadable fs, uncomputable path) that degrade to "unknown".
  const cacheStates = () => [
    ['cold', { cacheFs: new Volume() }],
    ['current', { cacheFs: warmCache('0.17.0') }],
    ['behind', { cacheFs: warmCache('9.9.9') }],
    ['way behind', { cacheFs: warmCache('1.0.0') }],
    ['ahead of the registry', { cacheFs: warmCache('0.16.0') }],
    ['prerelease ahead', { cacheFs: warmCache('0.18.0-beta.1') }],
    ['non-semver', { cacheFs: warmCache('banana') }],
    ['corrupt', { cacheFs: rawCache('{ truncated') }],
    ['unreadable', { cacheFs: throwingRead('EACCES') }],
    ['uncomputable path (null home)', { cacheFs: warmCache('9.9.9'), home: null }],
    ['hostile env bag', { cacheFs: warmCache('9.9.9'), env: { XDG_CONFIG_HOME: 42 } }],
  ]

  it('returns a DEEP-EQUAL object for every cache state (all deps present)', async () => {
    let baseline
    for (const [label, opts] of cacheStates()) {
      const { result } = await runDoctor(opts)
      if (!baseline) baseline = result
      expect(result, `cache state: ${label}`).toEqual(baseline)
      expect(result.exitCode).toBe(0)
    }
    expect(Object.keys(baseline).sort()).toEqual([
      'exitCode',
      'missingCritical',
      'missingNonCritical',
      'platform',
    ])
  })

  it('returns a DEEP-EQUAL object for every cache state on the MISSING-CRITICAL path', async () => {
    // Exit 1 for the missing dep, and only ever for the missing dep. A release
    // landing must not change one byte of what a wrapper sees here.
    let baseline
    for (const [label, opts] of cacheStates()) {
      const { result } = await runDoctor({ ...opts, hasCommand: (c) => c !== 'git' })
      if (!baseline) baseline = result
      expect(result, `cache state: ${label}`).toEqual(baseline)
      expect(result.exitCode).toBe(1)
      expect(result.missingCritical.map((r) => r.name)).toEqual(['git'])
    }
  })

  it('emits a byte-identical dependency report for every cache state', async () => {
    // The version line is the ONLY difference the cache can make to stdout.
    let baseline
    for (const [label, opts] of cacheStates()) {
      const { out } = await runDoctor(opts)
      const report = withoutVersionLine(out)
      if (baseline === undefined) baseline = report
      expect(report, `cache state: ${label}`).toBe(baseline)
    }
  })

  it('emits byte-identical STDERR for every cache state, present or missing deps', async () => {
    for (const hasCommand of [allPresent, (c) => c !== 'git']) {
      let baseline
      for (const [label, opts] of cacheStates()) {
        const { err } = await runDoctor({ ...opts, hasCommand })
        if (baseline === undefined) baseline = err
        expect(err, `cache state: ${label}`).toBe(baseline)
      }
      // Staleness never reaches stderr at all.
      expect(baseline).not.toMatch(/cached latest|update available|up to date/)
    }
  })

  it('a missing OPTIONAL dep still ends in the optional summary, whatever the cache says', async () => {
    for (const [, opts] of cacheStates()) {
      const { out, result } = await runDoctor({ ...opts, hasCommand: (c) => c !== 'jq' })
      expect(result.exitCode).toBe(0)
      expect(withoutVersionLine(out)).toContain('Optional deps missing: jq')
    }
  })

  it('the version line never leaks into the dependency verdict wording', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('9.9.9') })
    expect(out).toContain('All deps present.')
    expect(withoutVersionLine(out)).not.toMatch(/cached latest/)
  })
})
