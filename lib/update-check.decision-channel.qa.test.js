import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { readVersionCache } from './version-cache.js'
import { NPM_VERSION_QUERY, VERSION_FORMAT, resolveUpdateDecision } from './update-check.js'
import { codeWithoutComments, functionBody } from '../test/helpers/source-code.js'

// #200 QA augmentation — `resolveUpdateDecision`'s `latestSource`, attacked at the seam
// between the guard that VALIDATES a channel and the code that SPAWNS one.
//
// lib/update-check.decision-channel.test.js pins which argv gets spawned, how many times
// a thunk is resolved, the two paths that resolve it zero times, and ten unusable sources
// that fall back to npm. It has one hostile descriptor: an `argv` getter that throws on
// every read. This file started there and asked the question that one cannot — what
// happens when the getter throws on a LATER read — and the answer was that it escaped:
// `resolveLatestSource` returned the caller's object BY REFERENCE, so `fetchLatestVersion`
// re-read `argv` three more times, on lines that sit outside any try of their own:
//
//     const query = Array.isArray(source?.argv) && source.argv.length ? source : NPM_VERSION_QUERY
//     const [cmd, ...args] = query.argv
//
// FIXED, by the dev, after QA filed it: the guard now reads `argv` once and hands on a
// descriptor this module owns (`{ ...named, argv: [...argv] }`), so the comment on
// `resolveLatestSource` is true and the shape it validated is the shape that gets spawned.
// The first describe below is QA's three arrangements of the defect, kept as the
// regression pins for the fixed property — one read, and an answer no later read can
// revoke — with the expectations QA's own note predicted ("after the channel is copied
// once inside the guard, this test's expectation becomes the brew query and the re-read
// disappears"). The dev who landed the fix updated those three expectations and their
// titles; no assertion was dropped, and the three attacks are unchanged in shape.
//
// The rest of the file is the channel's failure modes that the dev's happy-path fallbacks
// do not reach: a channel that answers unreadably (as opposed to one that cannot be
// named), what the cache keeps when it does, and whether a failed named channel is
// retried against npm — which it must not be, because a Homebrew user asking npm about a
// tap version is the #199 bug wearing #200's clothes.
//
// Hermeticity (#41): `exec` is injected and recording, the cache is memfs under a fake
// `home`, the clock is fixed.

const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')
const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

const NPM_VIEW = 'npm view @lucasfe/ralph version'
const BREW_INFO = 'brew info --json=v2 ralph'
const BREW_ARGV = ['brew', 'info', '--json=v2', 'ralph']
const BREW_QUERY = { argv: BREW_ARGV, format: 'brew-json-v2', unreachable: 'tap unreachable?' }

function makeExec(handlers = {}) {
  const calls = []
  const exec = async (cmd, args = [], opts = {}) => {
    const key = `${cmd} ${(args ?? []).join(' ')}`
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
const openWindows = (latest = null) =>
  seeded({ last_check_at: null, last_prompted_at: null, latest_version: latest })

const base = (overrides = {}) => ({
  currentVersion: '0.1.0',
  now: () => T0,
  home: HOME,
  processEnv: {},
  fs: openWindows(),
  ...overrides,
})

// A descriptor whose `argv` is a getter under the test's control: `answers` is consulted
// with the 1-based read index, and whatever it returns is the value that read sees. Every
// read is recorded, so a test can say WHICH read was the one that mattered.
//
// `enumerable` matters more than it looks. A non-enumerable getter is invisible to the
// `{ ...named }` spread in `resolveLatestSource`, so the reads a test counts are only the
// EXPLICIT ones; an enumerable getter — the shape a real object literal has — is read by
// the spread as well. The default is false to keep the counts above about the code's own
// reads, and the two tests that pass true are the ones about the spread.
function trackedDescriptor(answers, { enumerable = false } = {}) {
  const reads = []
  const descriptor = { format: 'brew-json-v2' }
  Object.defineProperty(descriptor, 'argv', {
    enumerable,
    get() {
      reads.push(reads.length + 1)
      return answers(reads.length)
    },
  })
  return { descriptor, reads }
}

describe('resolveUpdateDecision — the channel it validated IS the channel it spawns (#200 QA)', () => {
  it('has no LATER read for a hostile argv getter to throw on', async () => {
    // QA's original DEFECT witness, now the regression pin for the fix. The contract is
    // "never throws, and that claim has to hold on its own", and this function's caller's
    // try is documented as "a belt-and-braces second line of defence and not a licence to
    // throw". Before the fix a getter that answered twice and then threw escaped
    // `resolveUpdateDecision` entirely, because reads 3-5 happened inside
    // `fetchLatestVersion` on lines outside every try in this module.
    //
    // The guard now reads `argv` ONCE and copies it, so this getter's throwing branch is
    // never taken: the contract holds by construction rather than by containment (the
    // catch is still there for the call, and for a descriptor whose FIRST read throws —
    // the last test in this block). The read count is the measurement, and asserting it
    // exactly is what keeps this a witness: a refactor that hands the caller's object on
    // by reference again pushes it back to five and fails here.
    const { descriptor, reads } = trackedDescriptor((n) => {
      if (n >= 3) throw new Error(`hostile argv on read ${n}`)
      return BREW_ARGV
    })
    const exec = makeExec({ [BREW_INFO]: brewJson('0.2.0'), [NPM_VIEW]: semver('0.2.0') })
    await expect(
      resolveUpdateDecision(base({ exec, latestSource: () => descriptor })),
    ).resolves.toMatchObject({ source: 'network' })
    expect(reads.length).toBe(1)
    // And the channel the guard read is the one that ran — npm was reachable and unused.
    expect(exec.keys()).toEqual([BREW_INFO])
  })

  it('spawns the argv the guard validated, not what the getter answers after it', async () => {
    // The same defect from its other side: the getter answers a Homebrew channel on the
    // read the guard takes and a different array on every read after it. Before the fix
    // the guard accepted the first and `fetchLatestVersion` spawned the last — five reads
    // in total (two in the guard, three in `fetchLatestVersion`), and nothing validated
    // the value that ran. Now there is no read after the one that is kept, so the answer
    // the guard checked is the answer that is spawned.
    //
    // Never reachable from production values either way — a classification is a plain
    // object built in lib/install-target.js, and its `latest` is the frozen
    // NPM_VERSION_QUERY or a literal — so this is the never-throws class the dev's file
    // already tests in. It is pinned because it is the property, stated as behaviour.
    const { descriptor, reads } = trackedDescriptor((n) =>
      n <= 1 ? BREW_ARGV : ['not-the-channel-that-was-validated'],
    )
    const exec = makeExec()
    await resolveUpdateDecision(base({ exec, latestSource: () => descriptor }))
    expect(exec.calls.map((c) => c.cmd)).toEqual(['brew'])
    expect(reads.length).toBe(1)
  })

  it('keeps the channel it validated when the getter stops answering an array', async () => {
    // The third arrangement: Homebrew on the read that counts, `null` afterwards. Before
    // the fix `fetchLatestVersion`'s own `Array.isArray` re-read that null and quietly
    // spawned npm for a channel the caller had named Homebrew — silent, with the notice
    // above it still reading `brew upgrade`. The copy cannot be revoked, so the tap runs
    // and npm stays untouched even though it is the reachable fallback here.
    const { descriptor } = trackedDescriptor((n) => (n <= 1 ? BREW_ARGV : null))
    const exec = makeExec({ [BREW_INFO]: brewJson('0.2.0'), [NPM_VIEW]: semver('9.9.9') })
    const decision = await resolveUpdateDecision(base({ exec, latestSource: () => descriptor }))
    expect(exec.keys()).toEqual([BREW_INFO])
    expect(decision).toMatchObject({ latestVersion: '0.2.0', source: 'network' })
  })

  it('lets no read of an ENUMERABLE argv getter happen after the guard', async () => {
    // The property the three tests above pin through a read COUNT, pinned here without
    // one — because the count is exactly 1 only for a getter the `{ ...named }` spread
    // cannot see. A real descriptor is an object literal, its `argv` is enumerable, and
    // the spread reads it a second time on its way past; `reads.length` is 2 for the
    // identical code path. So a suite that only ever demanded 1 would answer "did the
    // spread see it?" as well as "did anything read it after the guard?", and only the
    // second question is the contract.
    //
    // This getter therefore permits every read the guard makes (both of them) and throws
    // on the FIRST read after it. Under the fix there is no such read: the copy is what
    // gets spawned, so the tap runs and nothing rejects. Under the by-reference version QA
    // filed against — or any refactor that hands the caller's object on again — read 3
    // lands on `fetchLatestVersion`'s unguarded line and escapes.
    //
    // It also measures the claim `resolveLatestSource`'s comment now makes about the
    // spread ("it may touch an ENUMERABLE argv getter a second time on its way past —
    // inside this same try"): inside is what makes the extra read harmless, and the next
    // test is the same read made hostile to prove the try is really around it.
    const { descriptor, reads } = trackedDescriptor(
      (n) => {
        if (n >= 3) throw new Error(`hostile argv on read ${n}`)
        return BREW_ARGV
      },
      { enumerable: true },
    )
    const exec = makeExec({ [BREW_INFO]: brewJson('0.2.0'), [NPM_VIEW]: semver('9.9.9') })
    const decision = await resolveUpdateDecision(base({ exec, latestSource: () => descriptor }))
    expect(exec.keys()).toEqual([BREW_INFO])
    expect(decision).toMatchObject({ latestVersion: '0.2.0', source: 'network' })
    expect(reads.length).toBeLessThan(3)
  })

  it('contains a throw from the spread’s read of an enumerable argv getter', async () => {
    // The second read is inside the try, so a getter that answers the guard and then
    // throws AT the spread still resolves to a decision — npm's, since no channel
    // survived. The one read that must never be reached is a read outside the guard, and
    // there is none: `exec` is asked exactly once, for npm.
    const { descriptor, reads } = trackedDescriptor(
      (n) => {
        if (n >= 2) throw new Error(`hostile argv on read ${n}`)
        return BREW_ARGV
      },
      { enumerable: true },
    )
    const exec = makeExec({ [NPM_VIEW]: semver('0.2.0') })
    const decision = await resolveUpdateDecision(base({ exec, latestSource: () => descriptor }))
    expect(exec.keys()).toEqual([NPM_VIEW])
    expect(decision).toMatchObject({ latestVersion: '0.2.0', source: 'network' })
    expect(reads.length).toBe(2)
  })

  it('never throws for a hostile descriptor passed directly, not behind a thunk', async () => {
    // `latestSource` need not be a function — the descriptor form is documented and is
    // what a caller holding a classification already would pass. Its `argv` read is
    // guarded on the same line as the thunk's, so the always-throwing getter is contained
    // here too, and the fallback is npm.
    const { descriptor } = trackedDescriptor(() => {
      throw new Error('hostile argv')
    })
    const exec = makeExec({ [NPM_VIEW]: semver('0.2.0') })
    const decision = await resolveUpdateDecision(base({ exec, latestSource: descriptor }))
    expect(exec.keys()).toEqual([NPM_VIEW])
    expect(decision).toMatchObject({ latestVersion: '0.2.0', source: 'network' })
  })
})

describe('resolveUpdateDecision — sources that are not channels (#200 QA)', () => {
  it('asks npm for a thunk that answers another thunk', async () => {
    // `latestSource` is awaited ONCE, not resolved until it stops being callable, so a
    // function answering a function is a value with no `argv` — npm, not a second call.
    const inner = () => BREW_QUERY
    const exec = makeExec({ [NPM_VIEW]: semver('0.2.0') })
    const decision = await resolveUpdateDecision(base({ exec, latestSource: () => inner }))
    expect(exec.keys()).toEqual([NPM_VIEW])
    expect(decision.latestVersion).toBe('0.2.0')
  })

  for (const [label, argv] of [
    ['numbers', [7, 8]],
    ['one empty string', ['']],
    ['a nested array', [['brew', 'info']]],
    ['null entries', [null, undefined]],
  ]) {
    it(`spawns and survives an argv of ${label}`, async () => {
      // `argv.length` is the whole test a channel has to pass, so these all reach `exec`.
      // What matters is that nothing throws and the answer is null: the real `exec`
      // (execa) rejects on a non-string command, `fetchLatestVersion` guards its call, and
      // an unparseable answer is not a version. Asserted rather than assumed because a
      // classification's argv is built from interpolated strings, and a future layout row
      // that interpolates `undefined` would land exactly here.
      const exec = makeExec()
      const decision = await resolveUpdateDecision(
        base({ exec, latestSource: { argv, format: 'semver-line' } }),
      )
      expect(exec.calls).toHaveLength(1)
      expect(exec.calls[0].cmd).toEqual(argv[0])
      expect(decision).toMatchObject({ latestVersion: null, isNewer: false, source: 'network' })
    })
  }

  it('survives an exec that rejects for the argv a channel named', async () => {
    const exec = async () => {
      throw new Error('ENOENT: brew is not on PATH')
    }
    const decision = await resolveUpdateDecision(base({ exec, latestSource: () => BREW_QUERY }))
    expect(decision).toMatchObject({ latestVersion: null, isNewer: false, source: 'network' })
  })

  it('DOCUMENTED: resolves the channel even when there is no spawner to use it', async () => {
    // `fetchLatestVersion(exec, timeoutMs, await resolveLatestSource(latestSource))` —
    // arguments evaluate left to right, so the thunk is awaited before the `typeof exec`
    // test that returns null. For the gate that means a run with no `exec` still pays for
    // a classification (a few filesystem probes; never a spawn, since the gate withholds
    // the spawner) for a query that cannot happen. Both production call sites pass an
    // `exec`, so this costs nothing today; it is pinned so the ordering is a decision
    // rather than an accident, and because the cheap-path claim in #200 is about spawns
    // and this is the one place it is not also about work.
    const source = { calls: 0, get resolved() { return this.calls } }
    const latestSource = async () => {
      source.calls += 1
      return BREW_QUERY
    }
    const decision = await resolveUpdateDecision(base({ exec: undefined, latestSource }))
    expect(source.calls).toBe(1)
    expect(decision).toMatchObject({ latestVersion: null, source: 'network' })
  })
})

describe('resolveUpdateDecision — a named channel that answers unreadably (#200 QA)', () => {
  it('does NOT retry npm when the named channel exits zero with an unreadable document', async () => {
    // The distinction #199 exists for: "I could not read the tap" must not become "let me
    // ask npm instead". A retry would compare a Homebrew install against the registry's
    // version, which is the exact wrong answer the tap lag makes visible — and it would do
    // it silently, since the notice reads the LAYOUT for its command.
    const exec = makeExec({
      [BREW_INFO]: { exitCode: 0, stdout: '{"formulae":[]}', stderr: '', timedOut: false },
      [NPM_VIEW]: semver('9.9.9'),
    })
    const decision = await resolveUpdateDecision(base({ exec, latestSource: () => BREW_QUERY }))
    expect(exec.keys()).toEqual([BREW_INFO])
    expect(decision).toMatchObject({ latestVersion: null, isNewer: false, source: 'network' })
  })

  for (const [label, stdout] of [
    ['truncated JSON', '{"formulae":[{"versions":{"stable":"0.2.0"'],
    ['a JSON array', '[]'],
    ['a JSON null', 'null'],
    ['an HTML error page', '<html><body>502</body></html>'],
    ['a formula with no stable', '{"formulae":[{"versions":{"head":"HEAD"}}],"casks":[]}'],
    ['a non-string stable', '{"formulae":[{"versions":{"stable":2}}],"casks":[]}'],
  ]) {
    it(`keeps the previously known version when the tap answers ${label}`, async () => {
      // The week is burned either way (below), so what the user sees for the next seven
      // days is whatever the cache already held — which must be the last version that WAS
      // readable, not null. Losing it would silence a pending notice for a week over one
      // bad document.
      const fs = openWindows('0.2.0')
      const exec = makeExec({ [BREW_INFO]: { exitCode: 0, stdout, stderr: '', timedOut: false } })
      const decision = await resolveUpdateDecision(
        base({ exec, fs, latestSource: () => BREW_QUERY }),
      )
      expect(decision).toMatchObject({ latestVersion: '0.2.0', isNewer: true, source: 'network' })
      const cache = readVersionCache({ fs, home: HOME, processEnv: {} })
      expect(cache).toMatchObject({ latest_version: '0.2.0', last_check_at: iso(T0) })
    })
  }

  it('burns the weekly window on a channel whose FORMAT it does not recognize', async () => {
    // A descriptor is two halves and only the argv half is validated. A layout added with
    // a format string this module has no reader for spawns fine, parses to null, and
    // stamps the window — so the failure mode of a half-added channel is a silent week,
    // not a crash and not a per-run retry. Named because the stamp is the part that hides
    // it: the next six days look identical to a healthy throttled run.
    const fs = openWindows()
    const exec = makeExec({ [BREW_INFO]: brewJson('0.2.0') })
    const decision = await resolveUpdateDecision(
      base({ exec, fs, latestSource: () => ({ argv: BREW_ARGV, format: 'brew-json-v3' }) }),
    )
    expect(exec.keys()).toEqual([BREW_INFO])
    expect(decision).toMatchObject({ latestVersion: null, source: 'network' })
    expect(readVersionCache({ fs, home: HOME, processEnv: {} }).last_check_at).toBe(iso(T0))
  })

  it('MEASURED: every declared format has a reader, so no channel can be half-added', async () => {
    // Closes the half of the test above that a behavioural pin cannot reach. The gap it
    // documents is a DECLARED format with no branch in `parseVersion`: a layout added with
    // `format: VERSION_FORMAT.SOMETHING_NEW` spawns, answers, parses to null and burns the
    // week, and nothing goes red — lib/install-target.channel.test.js asserts each layout's
    // format is a MEMBER of the enum, which a new member satisfies by existing.
    //
    // So this asserts the other direction, over the enum's own keys: for each member there
    // is a comparison against it inside `parseVersion`. Read off the source because
    // `parseVersion` is module-local — its two branches are `format === VERSION_FORMAT.X`,
    // and the sweep is the function's body alone rather than the file, so a mention in
    // `NPM_VERSION_QUERY` or in a comment cannot answer for a missing branch.
    //
    // It lives in this file rather than beside the parser because it is the same claim as
    // the test above, stated as coverage instead of as behaviour, and the two want to be
    // read together.
    const source = codeWithoutComments(new URL('./update-check.js', import.meta.url))
    const parser = functionBody(source, 'parseVersion')
    // A lower bound, not a count: a THIRD channel with a reader of its own must pass this
    // test, and only one with no reader must fail it. Asserted at all so an emptied enum
    // cannot satisfy the loop below by having nothing to iterate.
    expect(Object.keys(VERSION_FORMAT).length).toBeGreaterThan(1)
    for (const key of Object.keys(VERSION_FORMAT)) {
      expect(parser).toContain(`VERSION_FORMAT.${key}`)
    }
    // And the haystack really is the one function: it begins at the declaration, and
    // neither the module's other users of the enum nor the next function down are in it.
    expect(parser.startsWith('function parseVersion(')).toBe(true)
    expect(parser).not.toContain('NPM_VERSION_QUERY')
    expect(parser).not.toContain('brewStableVersion(stdout) {')
  })

  it('reads a semver-line channel that is not npm without going near npm', async () => {
    // The seam is a channel, not a two-way switch: a descriptor may name any command with
    // npm's output shape. Pinned so the npm fallback stays a fallback for sources with no
    // usable argv, and does not become "anything that is not brew".
    const exec = makeExec({ 'pnpm view @lucasfe/ralph version': semver('0.3.0') })
    const decision = await resolveUpdateDecision(
      base({
        exec,
        latestSource: () => ({
          argv: ['pnpm', 'view', '@lucasfe/ralph', 'version'],
          format: 'semver-line',
        }),
      }),
    )
    expect(exec.keys()).toEqual(['pnpm view @lucasfe/ralph version'])
    expect(decision).toMatchObject({ latestVersion: '0.3.0', isNewer: true })
  })

  it('leaves the shared npm descriptor untouched after a channel run', async () => {
    // The fallback is shared BY IDENTITY across the process, so a run that spawned
    // something else must not have mutated it on the way past.
    const exec = makeExec({ [BREW_INFO]: brewJson('0.2.0') })
    await resolveUpdateDecision(base({ exec, latestSource: () => BREW_QUERY }))
    expect(NPM_VERSION_QUERY.argv).toEqual(['npm', 'view', '@lucasfe/ralph', 'version'])
    expect(Object.isFrozen(NPM_VERSION_QUERY.argv)).toBe(true)
  })
})
