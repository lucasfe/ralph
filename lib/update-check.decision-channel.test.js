import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { readVersionCache } from './version-cache.js'
import { classifyInstall } from './install-target.js'
import { NPM_VERSION_QUERY, resolveUpdateDecision } from './update-check.js'

// #200: the weekly check asks THE CHANNEL THIS COPY CAME FROM. #199 gave every
// classification a `latest` descriptor and threaded it through `ralph update`, but
// left the background check in `resolveUpdateDecision` on the npm default with a
// comment naming the reason: `ralph start` holds no classification, and classifying
// on that path would have added an `npm root -g` spawn to a run whose whole point is
// to cost nothing before the loop.
//
// So the seam this file pins is `latestSource`, and specifically its FUNCTION form:
// a descriptor is resolved only on the path that actually queries a channel, which is
// what lets lib/update-gate.js hand this the running install's classification without
// making the throttled and opted-out paths pay for one.
//
// What is NOT re-tested here: the throttle, the opt-out, the semver comparison and
// the cache write (lib/update-check.decision.test.js), and how each channel's output
// is parsed (lib/update-check.channel.test.js). Everything below is about WHICH argv
// gets spawned, HOW MANY times the caller's channel is resolved, and the two paths
// that must resolve it zero times.

const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')
const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()

const NPM_VIEW = 'npm view @lucasfe/ralph version'
const BREW_INFO = 'brew info --json=v2 ralph'
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'

// The Homebrew descriptor is read off a REAL classification rather than retyped: a
// hand-written twin would let the table and this file drift, and a Cellar is decided
// from its path alone, so no exec and no real filesystem is involved.
const brewSource = async () => {
  const target = await classifyInstall({
    ralphHome: BREW_RALPH,
    exec: null,
    fs: Volume.fromJSON({}),
  })
  expect(target.kind).toBe('global-brew')
  return target.latest
}

function makeExec(handlers = {}) {
  const calls = []
  const exec = async (cmd, args = [], opts = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, opts })
    if (Object.prototype.hasOwnProperty.call(handlers, key)) return handlers[key]
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
  }
  exec.calls = calls
  exec.keys = () => calls.map((c) => c.key)
  return exec
}

const semver = (v) => ({ exitCode: 0, stdout: `${v}\n`, stderr: '', timedOut: false })
const brewJson = (stable) => ({
  exitCode: 0,
  stdout: JSON.stringify({
    formulae: [{ name: 'ralph', versions: { stable, head: 'HEAD', bottle: true } }],
    casks: [],
  }),
  stderr: '',
  timedOut: false,
})

const seeded = (cache) => Volume.fromJSON({ [CACHE_PATH]: JSON.stringify(cache) }, '/')
const openWindows = () => seeded({ last_check_at: null, last_prompted_at: null, latest_version: null })
const throttled = () =>
  seeded({ last_check_at: iso(T0 - DAY), last_prompted_at: null, latest_version: '0.2.0' })

const base = (overrides = {}) => ({
  currentVersion: '0.1.0',
  now: () => T0,
  home: HOME,
  processEnv: {},
  fs: openWindows(),
  ...overrides,
})

// A recording thunk, so "resolved once" and "resolved never" are counts rather than
// inferences.
function makeSource(value) {
  const calls = []
  const source = async () => {
    calls.push(Date.now())
    return typeof value === 'function' ? value() : value
  }
  source.calls = calls
  return source
}

describe('resolveUpdateDecision — the channel comes from the caller (#200)', () => {
  it('spawns the descriptor it was handed, not the npm default', async () => {
    const exec = makeExec({ [BREW_INFO]: brewJson('0.3.0') })
    const decision = await resolveUpdateDecision(
      base({ exec, latestSource: await brewSource() }),
    )
    expect(exec.keys()).toEqual([BREW_INFO])
    expect(decision).toMatchObject({ latestVersion: '0.3.0', isNewer: true, source: 'network' })
  })

  it('bounds the channel query exactly as it bounded the npm one', async () => {
    const exec = makeExec({ [BREW_INFO]: brewJson('0.3.0') })
    await resolveUpdateDecision(base({ exec, latestSource: await brewSource() }))
    expect(exec.calls[0].key).toBe(BREW_INFO)
    expect(exec.calls[0].opts).toEqual({ timeout: 5000, reject: false })
  })

  it('spawns the npm query when no channel is named at all', async () => {
    // The pre-#200 contract, unmoved: every caller that passes nothing keeps asking
    // the registry.
    const exec = makeExec({ [NPM_VIEW]: semver('0.2.0') })
    const decision = await resolveUpdateDecision(base({ exec }))
    expect(exec.keys()).toEqual([NPM_VIEW])
    expect(decision).toMatchObject({ latestVersion: '0.2.0', source: 'network' })
  })

  it('writes the channel’s answer to the cache the notice and `doctor` read', async () => {
    const fs = openWindows()
    const exec = makeExec({ [BREW_INFO]: brewJson('0.3.0') })
    await resolveUpdateDecision(base({ exec, fs, latestSource: await brewSource() }))
    const cache = readVersionCache({ fs, home: HOME, processEnv: {} })
    expect(cache.latest_version).toBe('0.3.0')
    expect(cache.last_check_at).toBe(iso(T0))
  })
})

describe('resolveUpdateDecision — a channel resolved lazily, or not at all (#200)', () => {
  it('resolves a FUNCTION source and asks what it names', async () => {
    const exec = makeExec({ [BREW_INFO]: brewJson('0.3.0') })
    const latestSource = makeSource(await brewSource())
    const decision = await resolveUpdateDecision(base({ exec, latestSource }))
    expect(latestSource.calls).toHaveLength(1)
    expect(exec.keys()).toEqual([BREW_INFO])
    expect(decision.latestVersion).toBe('0.3.0')
  })

  it('resolves it exactly once per decision', async () => {
    const exec = makeExec({ [BREW_INFO]: brewJson('0.3.0') })
    const latestSource = makeSource(await brewSource())
    await resolveUpdateDecision(base({ exec, latestSource }))
    expect(latestSource.calls).toHaveLength(1)
  })

  it('does not resolve it on the THROTTLED path, and spawns nothing', async () => {
    // The guarantee that makes a classification affordable: inside the weekly window
    // there is no channel to ask, so the caller is never asked which one.
    const exec = makeExec()
    const latestSource = makeSource(await brewSource())
    const decision = await resolveUpdateDecision(base({ exec, fs: throttled(), latestSource }))
    expect(latestSource.calls).toHaveLength(0)
    expect(exec.calls).toHaveLength(0)
    expect(decision).toMatchObject({ latestVersion: '0.2.0', source: 'cache', isNewer: true })
  })

  it('does not resolve it on the RALPH_NO_UPDATE_CHECK path either', async () => {
    const exec = makeExec()
    const latestSource = makeSource(await brewSource())
    const decision = await resolveUpdateDecision(
      base({ exec, latestSource, processEnv: { RALPH_NO_UPDATE_CHECK: '1' } }),
    )
    expect(latestSource.calls).toHaveLength(0)
    expect(exec.calls).toHaveLength(0)
    expect(decision.source).toBe('disabled')
  })

  it('resolves it after the throttle and before the query, on one timeline', async () => {
    const timeline = []
    const exec = makeExec({ [BREW_INFO]: brewJson('0.3.0') })
    const recording = async (cmd, args, opts) => {
      timeline.push(`exec:${cmd} ${args.join(' ')}`)
      return exec(cmd, args, opts)
    }
    const source = await brewSource()
    const latestSource = () => {
      timeline.push('resolve')
      return source
    }
    await resolveUpdateDecision(base({ exec: recording, latestSource }))
    expect(timeline).toEqual(['resolve', `exec:${BREW_INFO}`])
  })
})

describe('resolveUpdateDecision — a channel it cannot use falls back to npm (#200)', () => {
  const KEYS = ['isNewer', 'latestVersion', 'shouldPrompt', 'source', 'updatedCache']

  for (const [label, latestSource] of [
    ['a thunk that throws', () => {
      throw new Error('classify exploded')
    }],
    ['a thunk that rejects', async () => Promise.reject(new Error('classify exploded'))],
    ['a thunk answering undefined', () => undefined],
    ['a thunk answering null', () => null],
    ['a thunk answering a string', () => 'npm view'],
    ['a thunk answering a descriptor with no argv', () => ({ format: 'semver-line' })],
    ['a thunk answering an empty argv', () => ({ argv: [], format: 'semver-line' })],
    ['a descriptor with no argv', { format: 'semver-line' }],
    ['a bare string', 'brew'],
    ['null', null],
  ]) {
    it(`asks npm for ${label}, and still returns a decision`, async () => {
      const exec = makeExec({ [NPM_VIEW]: semver('0.2.0') })
      const decision = await resolveUpdateDecision(base({ exec, latestSource }))
      expect(exec.keys()).toEqual([NPM_VIEW])
      expect(decision).toMatchObject({ latestVersion: '0.2.0', isNewer: true, source: 'network' })
      expect(Object.keys(decision).sort()).toEqual(KEYS)
    })
  }

  it('stamps the window even when the named channel could not be read', async () => {
    // Unchanged from #24: the throttle's job is "at most one query a week", and a
    // channel that is down is exactly when retrying every run is most useless.
    const fs = openWindows()
    const exec = makeExec({ [BREW_INFO]: { exitCode: 1, stdout: '', stderr: 'Error: No formula' } })
    const decision = await resolveUpdateDecision(base({ exec, fs, latestSource: await brewSource() }))
    expect(decision).toMatchObject({ latestVersion: null, isNewer: false, source: 'network' })
    expect(readVersionCache({ fs, home: HOME, processEnv: {} }).last_check_at).toBe(iso(T0))
  })

  it('never throws for a channel whose descriptor is hostile', async () => {
    // A classification is an injected value all the way down, so a getter can throw
    // where a value cannot. The promise this function makes is that a caller with no
    // try/catch still gets a decision.
    const hostile = {}
    Object.defineProperty(hostile, 'argv', {
      get() {
        throw new Error('hostile descriptor')
      },
    })
    const exec = makeExec({ [NPM_VIEW]: semver('0.2.0') })
    const decision = await resolveUpdateDecision(base({ exec, latestSource: () => hostile }))
    expect(Object.keys(decision).sort()).toEqual(KEYS)
    expect(decision.source).toBe('network')
  })

  it('leaves the npm descriptor frozen and shared, whatever a caller passes', async () => {
    const exec = makeExec({ [NPM_VIEW]: semver('0.2.0') })
    await resolveUpdateDecision(base({ exec, latestSource: () => undefined }))
    expect(Object.isFrozen(NPM_VERSION_QUERY)).toBe(true)
    expect(NPM_VERSION_QUERY.argv).toEqual(['npm', 'view', '@lucasfe/ralph', 'version'])
  })
})
