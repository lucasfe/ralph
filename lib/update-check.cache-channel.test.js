import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { cachedVersionFor, readVersionCache, writeVersionCache } from './version-cache.js'
import { classifyInstall } from './install-target.js'
import { VERSION_CHANNEL, versionChannelFor } from './install-markers.js'
import {
  NPM_VERSION_QUERY,
  recordPromptShown,
  resolveUpdateDecision,
} from './update-check.js'

// #215: the WRITE side of a channel-keyed cache, and the join that keeps the two sides
// spelling the same channel.
//
// lib/version-cache.channel.test.js owns the file's shape. This file owns the two questions
// the running command has to answer:
//
//   1. WHICH CHANNEL DID THIS NUMBER COME FROM? The writer knows, because it just spawned the
//      query: the id travels on the query descriptor lib/install-target.js attaches to every
//      classification (#199), so `resolveUpdateDecision` files the answer under the channel it
//      actually asked and never under a channel it guessed.
//   2. WHICH CHANNEL AM I? The reader has no descriptor — `ralph doctor` is architecturally
//      forbidden from importing lib/install-target.js at all — so it derives the id from its
//      own install path, through lib/install-markers.js. The two derivations MUST agree, which
//      is the join pinned at the bottom of this file over every layout `classifyInstall` can
//      return.
//
// Hermetic (#41): every run injects `exec`, a memfs volume, a fake home and an empty env bag,
// so nothing here queries a registry, a tap, or this machine's cache.

const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')
const T0 = Date.parse('2026-09-13T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()

const NPM_VIEW = 'npm view @lucasfe/ralph version'
const BREW_INFO = 'brew info --json=v2 ralph'

const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'
const GLOBAL_RALPH = '/usr/local/lib/node_modules/@lucasfe/ralph'
const PNPM_RALPH = '/Users/me/Library/pnpm/global/5/node_modules/@lucasfe/ralph'
const YARN_RALPH = '/Users/me/.config/yarn/global/node_modules/@lucasfe/ralph'
const BUN_RALPH = '/Users/me/.bun/install/global/node_modules/@lucasfe/ralph'
const NPX_RALPH = '/Users/me/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph'
const CHECKOUT = '/Users/me/repos/ralph'

/** The two link probes, answering "a plain directory" unless a test says otherwise. */
const plainDirectory = () => ({
  existsSync: () => false,
  lstatSync: () => ({ isSymbolicLink: () => false }),
})
const withGitEntry = (root) => ({
  existsSync: (p) => String(p) === join(root, '.git'),
  lstatSync: () => ({ isSymbolicLink: () => false }),
})

// A classification, read off the real table rather than retyped: a hand-written twin would let
// this file and lib/install-target.js drift apart, and every path below is decided from its
// segments plus two injected probes, so no exec and no real filesystem is involved.
const classify = (ralphHome, fs = plainDirectory()) =>
  classifyInstall({ ralphHome, exec: null, fs })

const sourceFor = async (ralphHome, fs) => (await classify(ralphHome, fs)).latest

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
const openWindows = () => Volume.fromJSON({}, '/')
const onDisk = (fs) => readVersionCache({ fs, home: HOME, processEnv: {} })

const base = (overrides = {}) => ({
  currentVersion: '0.25.4',
  now: () => T0,
  home: HOME,
  processEnv: {},
  fs: openWindows(),
  ...overrides,
})

describe('resolveUpdateDecision — the number is filed under the channel that answered (#215)', () => {
  it('stamps the npm channel when no channel was named at all', async () => {
    // Naming nothing is naming npm: `latestSource` defaults to NPM_VERSION_QUERY, so the query
    // this run spawns is npm's (asserted through the exec key) and npm is the channel that
    // ANSWERED. The stamp is a fact about that spawn rather than a default applied to a
    // stranger's number — and it is the same id `fetchLatestVersion` would have substituted for
    // a descriptor it could not use, which is why the write side needs no second rule.
    const fs = openWindows()
    const exec = makeExec({ [NPM_VIEW]: semver('0.23.0') })
    await resolveUpdateDecision(base({ exec, fs }))
    expect(exec.keys()).toEqual([NPM_VIEW])
    expect(onDisk(fs)).toMatchObject({
      latest_version: '0.23.0',
      latest_version_channel: NPM_VERSION_QUERY.channel,
    })
  })

  it('stamps the Homebrew channel for a Cellar copy', async () => {
    const fs = openWindows()
    const exec = makeExec({ [BREW_INFO]: brewJson('0.27.0') })
    await resolveUpdateDecision(base({ exec, fs, latestSource: await sourceFor(BREW_RALPH) }))
    expect(exec.keys()).toEqual([BREW_INFO])
    expect(onDisk(fs)).toMatchObject({
      latest_version: '0.27.0',
      latest_version_channel: VERSION_CHANNEL.BREW,
    })
  })

  it('leaves a number it could not attribute unattributed, never as npm’s', async () => {
    // A descriptor with a runnable argv and no channel id reaches this only from a stub or a
    // hostile caller — every classification lib/install-target.js returns carries one — and
    // filing its answer under npm would be the #215 bug with a different author.
    const fs = openWindows()
    const exec = makeExec({ 'ralph-latest ': semver('9.9.9') })
    const decision = await resolveUpdateDecision(
      base({ exec, fs, latestSource: { argv: ['ralph-latest'], format: 'semver-line' } }),
    )
    // The run that resolved it still reports it — it came from the channel this run asked.
    expect(decision.latestVersion).toBe('9.9.9')
    expect(onDisk(fs)).toMatchObject({ latest_version: '9.9.9', latest_version_channel: null })
    // ...and no later run can pick it up.
    expect(cachedVersionFor(onDisk(fs), NPM_VERSION_QUERY.channel)).toBeNull()
  })

  it('does not resurrect ANOTHER channel’s number when its own query fails', async () => {
    // #24's rule is that a flaky night must not lose a pending notice. It says nothing about
    // borrowing the other copy's answer: a failed brew query leaves npm's number where it is,
    // and reports nothing.
    const fs = seeded({
      last_check_at: iso(T0 - 30 * DAY),
      last_prompted_at: null,
      latest_version: '0.23.0',
      latest_version_channel: NPM_VERSION_QUERY.channel,
    })
    const exec = makeExec({ [BREW_INFO]: { exitCode: 1, stdout: '', stderr: 'Error: No formula' } })
    const decision = await resolveUpdateDecision(
      base({ exec, fs, latestSource: await sourceFor(BREW_RALPH) }),
    )
    expect(decision).toMatchObject({ latestVersion: null, isNewer: false, source: 'network' })
    // The other channel's pair survives untouched — it is that channel's own valid answer.
    expect(onDisk(fs)).toMatchObject({
      latest_version: '0.23.0',
      latest_version_channel: NPM_VERSION_QUERY.channel,
      last_check_at: iso(T0),
    })
  })
})

describe('resolveUpdateDecision — the throttled read is channel-keyed (#215)', () => {
  // The window that made the bug: inside it nothing is queried, so every copy is serving
  // whatever the last copy to run wrote.
  const throttledWith = (extra) =>
    seeded({ last_check_at: iso(T0 - DAY), last_prompted_at: null, ...extra })

  it('serves the cached number to the channel that wrote it', async () => {
    const exec = makeExec()
    const decision = await resolveUpdateDecision(
      base({
        exec,
        fs: throttledWith({ latest_version: '0.27.0', latest_version_channel: VERSION_CHANNEL.BREW }),
        latestSource: await sourceFor(BREW_RALPH),
      }),
    )
    expect(exec.calls).toHaveLength(0)
    expect(decision).toMatchObject({ latestVersion: '0.27.0', isNewer: true, source: 'cache' })
  })

  it('serves NOTHING to a copy from another channel — the nag that promised 0.27.0', async () => {
    // The harmful direction, end to end: the brew copy wrote 0.27.0 from the tap, and the npm
    // copy at 0.25.4 must not offer it. `npm i -g @lucasfe/ralph@latest` would install 0.23.0.
    const exec = makeExec()
    const decision = await resolveUpdateDecision(
      base({
        exec,
        fs: throttledWith({ latest_version: '0.27.0', latest_version_channel: VERSION_CHANNEL.BREW }),
      }),
    )
    expect(exec.calls).toHaveLength(0)
    expect(decision).toMatchObject({
      latestVersion: null,
      isNewer: false,
      shouldPrompt: false,
      source: 'cache',
    })
  })

  it('serves nothing off a LEGACY file, to either copy', async () => {
    // The file as observed on 2026-09-13. Neither copy may treat it as its own.
    const legacy = () => throttledWith({ latest_version: '0.23.0' })
    const npm = await resolveUpdateDecision(base({ exec: makeExec(), fs: legacy() }))
    const brew = await resolveUpdateDecision(
      base({ exec: makeExec(), fs: legacy(), latestSource: await sourceFor(BREW_RALPH) }),
    )
    expect(npm).toMatchObject({ latestVersion: null, source: 'cache' })
    expect(brew).toMatchObject({ latestVersion: null, source: 'cache' })
  })

  it('resolves the caller’s channel on the throttled path, and still spawns nothing', async () => {
    // #200 kept the throttled path from resolving the channel at all, on the argument that a
    // run which asks nothing needs no channel. #215 is that argument's counterexample: the
    // throttled path SERVES a version, and a version cannot be served without naming the
    // channel it belongs to. What the path still costs is what mattered — NO SUBPROCESS.
    const calls = []
    const source = await sourceFor(BREW_RALPH)
    const latestSource = async () => {
      calls.push('resolve')
      return source
    }
    const exec = makeExec()
    await resolveUpdateDecision(
      base({
        exec,
        fs: throttledWith({ latest_version: '0.27.0', latest_version_channel: VERSION_CHANNEL.BREW }),
        latestSource,
      }),
    )
    expect(calls).toEqual(['resolve'])
    expect(exec.calls).toHaveLength(0)
  })

  it('reads npm’s number for a caller that named no channel, and nothing for one that FAILED to', async () => {
    // THE TWO MEANINGS OF "no source", kept apart on purpose, because collapsing them is what
    // #215's QA found: `latestSource` defaults to NPM_VERSION_QUERY, so a caller that never
    // mentions a channel is a caller NAMING npm — the module's documented default since #199 —
    // while a caller whose channel lookup THREW or answered nothing has named nothing it can
    // stand behind, and gets nothing. One is an API default about which query to spawn; the
    // other would be a guess about which COPY is running, on the one machine where the guess is
    // wrong (a Homebrew install whose classification failed, reading npm's number).
    //
    // Same file for every row, so the only variable is how the caller referred to itself.
    const npmStamped = () =>
      throttledWith({ latest_version: '0.30.0', latest_version_channel: NPM_VERSION_QUERY.channel })
    const omitted = await resolveUpdateDecision(base({ exec: makeExec(), fs: npmStamped() }))
    expect(omitted).toMatchObject({ latestVersion: '0.30.0', isNewer: true, source: 'cache' })

    const failed = [
      ['a thunk that throws', () => { throw new Error('classify blew up') }],
      ['a thunk that rejects', async () => { throw new Error('classify rejected') }],
      ['a thunk answering undefined', async () => undefined],
      ['a thunk answering null', async () => null],
      ['a descriptor with no runnable argv', async () => ({ argv: [], channel: 'brew' })],
    ]
    for (const [label, latestSource] of failed) {
      const decision = await resolveUpdateDecision(
        base({ exec: makeExec(), fs: npmStamped(), latestSource }),
      )
      expect({ label, ...decision }, label).toMatchObject({
        label,
        latestVersion: null,
        isNewer: false,
        source: 'cache',
      })
    }
  })

  it('still resolves nothing at all on the opted-out path', async () => {
    const calls = []
    const latestSource = async () => {
      calls.push('resolve')
      return undefined
    }
    const exec = makeExec()
    const decision = await resolveUpdateDecision(
      base({ exec, latestSource, processEnv: { RALPH_NO_UPDATE_CHECK: '1' } }),
    )
    expect(calls).toEqual([])
    expect(exec.calls).toHaveLength(0)
    expect(decision.source).toBe('disabled')
  })
})

describe('recordPromptShown — the stamp never disturbs the attribution (#215)', () => {
  it('carries the version AND its channel through untouched', () => {
    const fs = seeded({
      last_check_at: iso(T0 - DAY),
      last_prompted_at: null,
      latest_version: '0.27.0',
      latest_version_channel: VERSION_CHANNEL.BREW,
    })
    const stamped = recordPromptShown({ now: () => T0, fs, home: HOME, processEnv: {} })
    expect(stamped).toMatchObject({
      last_check_at: iso(T0 - DAY),
      last_prompted_at: iso(T0),
      latest_version: '0.27.0',
      latest_version_channel: VERSION_CHANNEL.BREW,
    })
    expect(cachedVersionFor(onDisk(fs), VERSION_CHANNEL.BREW)).toBe('0.27.0')
    expect(cachedVersionFor(onDisk(fs), NPM_VERSION_QUERY.channel)).toBeNull()
  })
})

describe('the join: the channel a query is filed under is the channel a reader derives (#215)', () => {
  // THE DUPLICATION THIS PINS. The id travels on the query descriptor (lib/install-target.js
  // builds it, from the marker row's own `versionChannel`) and it is DERIVED from a path by
  // lib/install-markers.js, because the reader that needs it most — `ralph doctor` — may not
  // import the module that builds descriptors. Two derivations of one fact, so they are joined
  // from the outside here, over every layout `classifyInstall` can return: a row that acquired
  // a channel its reader does not derive would be the #215 bug with a fresh cause.
  const LAYOUTS = [
    ['a Homebrew Cellar', BREW_RALPH, plainDirectory(), VERSION_CHANNEL.BREW],
    ['a global npm root', GLOBAL_RALPH, plainDirectory(), VERSION_CHANNEL.NPM],
    ['a pnpm global store', PNPM_RALPH, plainDirectory(), VERSION_CHANNEL.NPM],
    ['a yarn global store', YARN_RALPH, plainDirectory(), VERSION_CHANNEL.NPM],
    ['a bun global store', BUN_RALPH, plainDirectory(), VERSION_CHANNEL.NPM],
    ['an npx cache', NPX_RALPH, plainDirectory(), VERSION_CHANNEL.NPM],
    ['a dev checkout', CHECKOUT, withGitEntry(CHECKOUT), VERSION_CHANNEL.NPM],
  ]

  for (const [label, ralphHome, fs, expected] of LAYOUTS) {
    it(`agrees on ${label}`, async () => {
      const target = await classify(ralphHome, fs)
      expect(target.latest.channel, 'the descriptor the query is filed under').toBe(expected)
      // The writer needs the probes to tell a checkout from an install; the reader does not,
      // because the only path a probe could re-attribute is a Cellar that is also a symlink to a
      // working tree. So the reader is handed the PATH ALONE and still lands on the writer's
      // answer for every layout there is.
      expect(versionChannelFor({ ralphHome }), 'the id the reader derives').toBe(expected)
    })
  }

  it('answers npm for every layout that installs FROM npm, which is all but one', async () => {
    // The partition is coarser than the store: pnpm, yarn and bun each have a directory of
    // their own and a `<manager> add -g` of their own, but all three install the npm tarball,
    // so all three read and write the same channel's number. Only the tap is its own channel.
    for (const [, ralphHome, fs, expected] of LAYOUTS) {
      const target = await classify(ralphHome, fs)
      expect(target.latest === NPM_VERSION_QUERY, ralphHome).toBe(expected === VERSION_CHANNEL.NPM)
    }
  })

  it('derives npm for a path nothing recognizes, and for no path at all', () => {
    // The read side has no `unknown` to answer with: a copy that cannot place itself still has
    // to read a cache, and npm is where every layout but the tap installs from. It is the same
    // guess `classifyInstall` makes for an unrecognized layout (`latest: NPM_VERSION_QUERY`),
    // which is what keeps the two sides joined even here.
    for (const ralphHome of ['/opt/somewhere/else', '', '   ', null, undefined, 42, {}]) {
      expect(versionChannelFor({ ralphHome }), JSON.stringify(ralphHome)).toBe(VERSION_CHANNEL.NPM)
    }
  })

  it('answers npm for a hostile ralphHome instead of coercing it or throwing', () => {
    // The `typeof` gate inside the function, from the outside. Two of these are the reason it is
    // a gate and not a `String()`: a bag whose `toString` throws would otherwise take
    // `ralph doctor` down from inside a version comparison, and `0` would coerce to '0' and
    // resolve against the PROCESS CWD — placing this install by whatever directory the user
    // happened to run from. Every one of them is a caller that named no path, so every one of
    // them reads npm's number and no other channel's.
    const hostile = [
      new String(BREW_RALPH),
      Buffer.from(BREW_RALPH),
      () => BREW_RALPH,
      0,
      { toString() { throw new Error('hostile ralphHome') } },
      new Proxy({}, { get() { throw new Error('hostile') } }),
      Object.create(null),
      Symbol('ralph'),
    ]
    for (const ralphHome of hostile) {
      expect(() => versionChannelFor({ ralphHome })).not.toThrow()
      expect(versionChannelFor({ ralphHome })).toBe(VERSION_CHANNEL.NPM)
    }
  })

  it('spells the two channel ids once, and they are what NPM_VERSION_QUERY carries', () => {
    expect(NPM_VERSION_QUERY.channel).toBe(VERSION_CHANNEL.NPM)
    expect(Object.values(VERSION_CHANNEL)).toEqual([VERSION_CHANNEL.NPM, VERSION_CHANNEL.BREW])
    expect(VERSION_CHANNEL.NPM).not.toBe(VERSION_CHANNEL.BREW)
  })

  it('takes no filesystem probe at all — a passed fs is never touched', () => {
    // Not "is total for a hostile fs", which would be true of a function that probed carefully.
    // The claim is stronger and is a claim about COST: `ralph doctor` pays for two probes on this
    // path already (its `channel` row), and `ralph start` draws its box before the first
    // preflight line, so the reader's id is derived from segments and nothing else. A seam that
    // throws on every property access proves the difference — a function that probed at all would
    // have to touch it to find that out.
    const hostileFs = new Proxy(
      {},
      {
        get() {
          throw new Error('the reader must not probe the filesystem')
        },
      },
    )
    expect(versionChannelFor({ ralphHome: BREW_RALPH, fs: hostileFs })).toBe(VERSION_CHANNEL.BREW)
    expect(versionChannelFor({ ralphHome: CHECKOUT, fs: hostileFs })).toBe(VERSION_CHANNEL.NPM)
    expect(versionChannelFor()).toBe(VERSION_CHANNEL.NPM)
  })
})

describe('a cache written by an older Ralph, and one read by one (#215)', () => {
  it('is read without crashing, and the next check re-attributes it', async () => {
    const fs = seeded({
      last_check_at: iso(T0 - 30 * DAY),
      last_prompted_at: null,
      latest_version: '0.23.0',
    })
    const exec = makeExec({ [BREW_INFO]: brewJson('0.27.0') })
    const decision = await resolveUpdateDecision(
      base({ exec, fs, latestSource: await sourceFor(BREW_RALPH) }),
    )
    expect(decision).toMatchObject({ latestVersion: '0.27.0', source: 'network' })
    expect(onDisk(fs)).toMatchObject({
      latest_version: '0.27.0',
      latest_version_channel: VERSION_CHANNEL.BREW,
    })
  })

  it('is left readable BY an older Ralph, without handing it a foreign number', () => {
    // A downgrade is the mirror image of the case above: a pre-#215 copy reads `latest_version`
    // with no idea a stamp exists. It therefore sees the last writer's number whatever we do —
    // which is why nothing here writes a COMPATIBILITY MIRROR of that field. The one thing this
    // change can promise the old copy is that the field it reads is still a bare, valid version
    // string, so its own semver check governs rather than a parse error.
    const fs = openWindows()
    writeVersionCache({
      cache: { latest_version: '0.27.0', latest_version_channel: VERSION_CHANNEL.BREW },
      fs,
      home: HOME,
      processEnv: {},
    })
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
    expect(typeof raw.latest_version).toBe('string')
    expect(raw.latest_version).toBe('0.27.0')
  })
})
