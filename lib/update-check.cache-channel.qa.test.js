import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RALPH_HOME } from './paths.js'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { NPM_VERSION_QUERY, recordPromptShown, resolveUpdateDecision } from './update-check.js'
import { cachedVersionFor, readVersionCache, writeVersionCache } from './version-cache.js'

// QA #215 — the DECISION side of the channel stamp, attacked at the seam #215 moved.
//
// The dev's lib/update-check.cache-channel.test.js drives the two channels through
// `resolveUpdateDecision` and proves the leak is closed for the shapes production produces.
// The riskiest line in the slice is not one of those, though: it is the MOVE of the channel
// resolution ABOVE the throttle branch (lib/update-check.js:311-312), which made ONE function
// answer two different questions at once —
//
//   * on the NETWORK path, "which channel ANSWERED this query": a record of a fact, where
//     falling back to npm is exactly right because `fetchLatestVersion` substitutes
//     NPM_VERSION_QUERY for an unusable descriptor one line down;
//   * on the THROTTLED path, "which channel is this COPY": a claim about the reader, where
//     npm is a guess — and `cachedVersionFor`'s own rule 3 (lib/version-cache.js:180-185)
//     refuses to make that guess in as many words: "A caller that cannot say which channel
//     it came from has not earned another channel's number. Deliberately not 'npm by
//     default'."
//
// The first group below is the ONE input where those two readings disagree: a caller that
// TRIED to name its channel and could not. lib/update-gate.js is that caller on every run —
// its thunk is `async () => (await installTarget())?.latest`, which answers `undefined`
// whenever the classification failed or carries no usable query — and `resolveLatestSource`
// collapses that answer into the same `undefined`.
//
// THAT GROUP FOUND THE DEFECT AND IT IS NOW FIXED, so what these tests hold down has
// changed shape: the one function is three (lib/update-check.js:393-449), and the group is
// the regression fence on the split. `answeringChannelOf` keeps the npm fallback and labels
// the WRITE; `readingChannelOf` fails closed to null and gates every READ; `namedChannelOf`
// is the one spelling rule under both. Each side is pinned from both directions here, because
// either half collapsing back into the other restores the leak in one direction or breaks the
// stamp in the other, and both halves answer the SAME input (`source === undefined`).
//
// The fix also moved the "nobody asked" case OUT of `undefined` and into a parameter default
// (`latestSource = NPM_VERSION_QUERY`, :251), which is what keeps 54 pre-#215 specs green.
// That default is a second door onto the fallback, so it is pinned too — deliberate where a
// caller omits the parameter, and unreachable from anything shipped (see the group on the
// gate's wiring, and lib/update-gate.cache-channel.qa.test.js, which measures it end to end).
//
// The rest of the file is the surrounding contract: totality under every hostile argument the
// new resolution order put in front of the cache read, the write-side attribution rules, that
// `recordPromptShown` cannot launder attribution, and what two copies on one machine actually
// do to each other over several weeks.
//
// Hermetic: memfs, a fake home, an empty env bag, an injected clock, and no `exec` unless a
// case is specifically about the query. Nothing here spawns or reaches ~/.config.

const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')
const T0 = Date.parse('2026-09-14T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const CURRENT = '0.25.4'

// A cache file whose weekly CHECK window is closed — the throttled path, where a version is
// served from the file and no channel is queried.
const throttled = (over = {}) =>
  JSON.stringify({
    last_check_at: new Date(T0 - DAY).toISOString(),
    last_prompted_at: null,
    latest_version: null,
    latest_version_channel: null,
    ...over,
  })

// A cache file whose windows are both OPEN — the network path.
const open = (over = {}) =>
  JSON.stringify({
    last_check_at: new Date(T0 - 30 * DAY).toISOString(),
    last_prompted_at: null,
    latest_version: null,
    latest_version_channel: null,
    ...over,
  })

const volWith = (raw) => Volume.fromJSON(raw === null ? {} : { [CACHE_PATH]: raw }, '/')
const fileIn = (fs) => JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8').toString())

const decide = (over = {}) =>
  resolveUpdateDecision({
    currentVersion: CURRENT,
    now: () => T0,
    processEnv: {},
    home: HOME,
    ...over,
  })

// A descriptor as lib/install-target.js attaches to a Homebrew classification.
const BREW_QUERY = Object.freeze({
  argv: ['brew', 'info', '--json=v2', 'ralph'],
  format: 'brew-json-v2',
  unreachable: 'the Homebrew tap could not be read?',
  channel: 'brew',
})

// An exec that answers one version to whichever channel asks, so a stamp can be read without
// the answer's VALUE telling the two channels apart.
const execAnswering = (stdout) => {
  const calls = []
  return {
    calls,
    exec: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return { exitCode: 0, stdout }
    },
  }
}

describe('QA #215 a copy that could not identify itself must not read npm’s number', () => {
  // THE ONE INPUT WHERE THE MOVED RESOLUTION IS LOAD-BEARING. Every row is a shape
  // lib/update-gate.js's own thunk really produces: `(await installTarget())?.latest` is
  // `undefined` when `classify` threw (the gate memoizes null for the rest of the run,
  // lib/update-gate.js:126-134), when it answered null, and when the classification it
  // answered carries no usable query. On a Homebrew copy in any of those states, the cache
  // holds npm's number — and the question is whether the reader gets it.
  //
  // Every row also leaves the SAME cache file, stamped `npm`, so the only variable is how
  // the reader failed to name itself.
  const UNIDENTIFIED = [
    ['a thunk that throws synchronously', () => { throw new Error('classify blew up') }],
    ['a thunk that rejects', async () => { throw new Error('classify rejected') }],
    ['a thunk answering undefined (classification failed)', async () => undefined],
    ['a thunk answering null', async () => null],
    ['a thunk answering a classification with no query', async () => ({}.latest)],
    ['a descriptor with an empty argv', async () => ({ argv: [], channel: 'brew' })],
    ['a descriptor whose argv is not an array', async () => ({ argv: 'brew info', channel: 'brew' })],
  ]

  it('serves nothing from the cache to any caller whose channel lookup failed', () => {
    // #215's criterion 1 is absolute — "a version resolved from one channel is never
    // reported to a copy installed from a different channel" — and a copy that could not
    // say which channel it is cannot be shown to be npm's. `cachedVersionFor` already
    // refuses this exact read (rule 3), and the first cut of the slice re-granted it one
    // call earlier: a single `versionChannelOf` answered npm for `source === undefined`,
    // so the npm fallback that is a RECORD on the write path became a GUESS on the read
    // path. `readingChannelOf` (lib/update-check.js:447-449) is the fix — undefined reads
    // as null — and this table is its fence.
    //
    // Asserted as one table so a regression is one failure with every reachable shape
    // listed beside it, rather than seven copies of one defect.
    const fs = volWith(throttled({ latest_version: '0.30.0', latest_version_channel: 'npm' }))
    const served = []
    return Promise.all(
      UNIDENTIFIED.map(async ([label, latestSource]) => {
        const decision = await decide({ fs, latestSource })
        if (decision.latestVersion !== null) served.push([label, decision.latestVersion])
      }),
    ).then(() => {
      expect(served).toEqual([])
    })
  })

  it('does not report an update to a caller whose channel lookup failed', async () => {
    // The same defect stated as the USER-VISIBLE consequence, because `isNewer` is what
    // lib/update-gate.js prints a notice from. A copy that cannot identify itself and is
    // behind npm's cached number is told to update — and the command it is told to run comes
    // from its own classification, which is the mechanism the issue was reported for.
    const fs = volWith(throttled({ latest_version: '0.30.0', latest_version_channel: 'npm' }))
    const decision = await decide({ fs, latestSource: async () => undefined })
    expect(decision.isNewer).toBe(false)
  })

  it('DOES fail closed for a descriptor that names no channel — the contrast', () => {
    // The asymmetry that makes the group above a defect rather than a design choice: a
    // descriptor with a runnable argv and no `channel` is a caller that named a channel id
    // of nothing, and THAT reads as null (lib/update-check.js:394-395). A caller that named
    // nothing at all is strictly LESS informative and gets strictly MORE trust.
    const fs = volWith(throttled({ latest_version: '0.30.0', latest_version_channel: 'npm' }))
    return decide({
      fs,
      latestSource: async () => ({ argv: ['brew', 'info', '--json=v2', 'ralph'] }),
    }).then((decision) => {
      expect(decision.latestVersion).toBeNull()
      expect(decision.isNewer).toBe(false)
    })
  })

  it('reads npm’s number for a caller that named npm, so the rule is not overbroad', async () => {
    // The other side of the same coin — the fix must still SERVE a cache. Pinned here so a
    // repair aimed at the group above cannot simply make the throttled path answer null for
    // everyone, which would pass those tests and delete #24.
    const fs = volWith(throttled({ latest_version: '0.30.0', latest_version_channel: 'npm' }))
    const decision = await decide({ fs, latestSource: async () => NPM_VERSION_QUERY })
    expect(decision).toMatchObject({ latestVersion: '0.30.0', isNewer: true, source: 'cache' })
  })

  it('still STAMPS npm when the query it actually made was npm’s', async () => {
    // The write side of the same fallback, which is CORRECT and must not be broken by a fix
    // to the read side: `fetchLatestVersion` substitutes NPM_VERSION_QUERY for an unusable
    // descriptor, so npm really is the channel that answered, and recording it is a fact
    // rather than a guess. Measured through the spawned argv, not inferred.
    const fs = volWith(open())
    const { exec, calls } = execAnswering('0.31.0')
    const decision = await decide({ fs, exec, latestSource: async () => undefined })
    expect(calls[0].args).toEqual(['view', '@lucasfe/ralph', 'version'])
    expect(fileIn(fs)).toMatchObject({ latest_version: '0.31.0', latest_version_channel: 'npm' })
    expect(decision).toMatchObject({ latestVersion: '0.31.0', source: 'network' })
  })
})

describe('QA #215 the two doors onto the npm fallback, after the split', () => {
  // The fix moved "nobody asked" out of `source === undefined` and into a parameter default
  // (`latestSource = NPM_VERSION_QUERY`, lib/update-check.js:251). That is what kept 54
  // pre-#215 specs green — they call `resolveUpdateDecision` with no source and need a cached
  // number served — but it is also a SECOND way to reach the npm fallback, and the first
  // finding in this file was that reaching that fallback by accident is the bug. So both
  // doors are pinned: the default names npm on purpose, and everything else that could be
  // mistaken for it fails closed.

  it('names npm when `latestSource` is OMITTED, which is what the default is for', async () => {
    // Deliberate, documented at lib/update-check.js:432-442, and load-bearing for the suite.
    // Pinned so a later "fail closed everywhere" tidy-up cannot delete it silently: it would
    // take 54 specs with it, and none of them would say why.
    const fs = volWith(throttled({ latest_version: '0.30.0', latest_version_channel: 'npm' }))
    expect(await decide({ fs })).toMatchObject({ latestVersion: '0.30.0', source: 'cache' })
  })

  it('treats an explicitly-undefined `latestSource` as omitted — the sharp edge', async () => {
    // A characterization, not an endorsement. Destructuring defaults fire on `undefined`, so
    // `{ ...opts, latestSource: opts.channelQuery }` with nothing in `channelQuery` NAMES npm,
    // while the same undefined answered by a THUNK fails closed. Nothing shipped builds the
    // argument that way — lib/update-gate.js:164 spells the thunk inline — but the two shapes
    // one line apart deserve to be on the record rather than discovered later.
    const fs = volWith(throttled({ latest_version: '0.30.0', latest_version_channel: 'npm' }))
    expect(await decide({ fs, latestSource: undefined })).toMatchObject({ latestVersion: '0.30.0' })
    expect(await decide({ fs, latestSource: async () => undefined })).toMatchObject({
      latestVersion: null,
    })
  })

  it('is a door NOTHING SHIPPED walks through, swept over the package', () => {
    // The dev's claim for the default is that production never takes it. Measured over every
    // shipped .js in lib/ and bin/ rather than over the three files an author remembers, and
    // stated as the three facts that make it true — so a fourth call site, or a forward that
    // turns into a call, breaks this rather than quietly naming npm for a copy that could not
    // identify itself.
    const named = collectShipped(RALPH_HOME).filter(({ code }) =>
      code.includes('resolveUpdateDecision'),
    )
    const rel = (p) => p.replace(RALPH_HOME, '').replace(/^[/\\]/, '')
    expect(named.map(({ path }) => rel(path)).sort()).toEqual([
      'lib/commands/cycle.js',
      'lib/commands/start.js',
      'lib/update-check.js',
      'lib/update-gate.js',
    ])
    // Of those four, one DECLARES it and one CALLS it. The two commands only forward it as a
    // seam default — `update = resolveUpdateDecision` in their own signatures, handed to
    // runUpdateGate — so neither invokes it and neither can omit an argument to it.
    for (const { path, code } of named) {
      if (['lib/update-gate.js', 'lib/update-check.js'].includes(rel(path))) continue
      expect(/\bupdate\s*\(/.test(code), rel(path)).toBe(false)
    }
    // And the one module that DOES invoke it names `latestSource` on the same call.
    const gate = named.find(({ path }) => rel(path) === 'lib/update-gate.js').code
    expect(/await update\(\{[^{}]*latestSource\s*:/.test(gate)).toBe(true)
  })

  it('does NOT take the default for null, or any other falsy non-undefined source', async () => {
    // Only `undefined` reaches the default, so every other unusable value still travels the
    // fail-closed road. Worth pinning because `null` is what a `?.` chain hands over, and a
    // reader skimming ":251 defaults to npm" would expect these to be the same.
    const fs = volWith(throttled({ latest_version: '0.30.0', latest_version_channel: 'npm' }))
    for (const latestSource of [null, false, 0, '', NaN]) {
      expect(await decide({ fs, latestSource }), String(latestSource)).toMatchObject({
        latestVersion: null,
        source: 'cache',
      })
    }
  })
})

describe('QA #215 the split’s two answers, on one run and at their own call sites', () => {
  it('labels the write npm and serves the reader nothing, in a SINGLE run', async () => {
    // The divergence itself, in one decision rather than inferred from two tests. Window open,
    // a source that could not be resolved, and a cache already holding npm's 0.30.0:
    //
    //   * the reading answer is null, so the older npm number is served to nobody — and the
    //     number this run REPORTS is the one it just fetched, which is a fact about the query
    //     it made rather than a read of anyone's cache (lib/update-check.js:369-376);
    //   * the answering answer is npm, so 0.31.0 is filed under npm — correct, because
    //     `fetchLatestVersion` substituted NPM_VERSION_QUERY, which the spawned argv proves.
    //
    // If either half is ever collapsed into the other, exactly one of these two assertions
    // breaks, which is what makes them worth asserting together.
    const fs = volWith(open({ latest_version: '0.30.0', latest_version_channel: 'npm' }))
    const { exec, calls } = execAnswering('0.31.0')
    const decision = await decide({ fs, exec, latestSource: async () => undefined })
    expect(calls[0].args).toEqual(['view', '@lucasfe/ralph', 'version'])
    expect(decision.latestVersion).toBe('0.31.0')
    expect(fileIn(fs)).toMatchObject({ latest_version: '0.31.0', latest_version_channel: 'npm' })
  })

  it('wires each answer to ONE site, and not to the other’s', async () => {
    // The behavioural tests above cannot tell "the write is labelled npm" from "the write
    // happens to be unreachable", and a later edit could feed the READING answer into the write
    // without changing any single test's verdict — the number would then be filed
    // unattributed and served to nobody. So the answering call is pinned as a site: one
    // declaration, one call, inside the write expression. The two cache READS are pinned as
    // taking the reader's key (the throttled path AND the query-failed fallback, which is the
    // site easiest to forget); the reading call itself is deliberately NOT pinned, because
    // `readingChannelOf` computes what `cachedVersionFor` normalizes anyway, so pinning its call
    // text would only foreclose deleting a wrapper that enforces nothing.
    const code = codeWithoutComments(join(RALPH_HOME, 'lib', 'update-check.js')).replace(/\s+/g, ' ')
    // Two occurrences: the declaration and the one call.
    expect(code.match(/answeringChannelOf\(/g)).toHaveLength(2)
    expect(code).toContain('withLatestVersion(cache, { version: fetched, channel: answeringChannelOf(source) })')
    expect(code.match(/cachedVersionFor\(cache, readerChannel\)/g)).toHaveLength(2)
  })
})

describe('QA #215 the query-FAILED fallback read, which the split also feeds', () => {
  // `readingChannelOf` gates two reads, not one: the throttled path (lib/update-check.js:321)
  // and the fallback at :376, where the query ran and answered nothing. The second is easy to
  // miss — it sits on the NETWORK path, after a spawn — and it is the same read of the same
  // older run's number, so the same rule has to hold there or the leak simply moves.
  const failedQuery = async (over) =>
    decide({ exec: async () => ({ exitCode: 1, stdout: '' }), ...over })

  it('serves nothing when the query failed AND the reader could not identify itself', async () => {
    // The defect-1 shape, on the other read site. Every row is a source the gate's thunk
    // really produces, and the pair on disk is npm's.
    const served = []
    for (const [label, latestSource] of [
      ['a thunk that throws', () => { throw new Error('classify blew up') }],
      ['a thunk answering undefined', async () => undefined],
      ['a thunk answering null', async () => null],
      ['a descriptor with an empty argv', async () => ({ argv: [], channel: 'npm' })],
    ]) {
      const fs = volWith(open({ latest_version: '0.30.0', latest_version_channel: 'npm' }))
      const d = await failedQuery({ fs, latestSource })
      if (d.latestVersion !== null) served.push([label, d.latestVersion])
      // The window is spent either way, and the pair is left exactly as it was — an
      // unidentified run must not re-file another channel's number under npm's name on its
      // way past, which is the write-side half of the same rule.
      expect(fileIn(fs)).toMatchObject({
        latest_version: '0.30.0',
        latest_version_channel: 'npm',
        last_check_at: new Date(T0).toISOString(),
      })
    }
    expect(served).toEqual([])
  })

  it('still keeps #24’s promise for a reader that CAN identify itself', async () => {
    // The over-correction guard. #24's rule is that one flaky night must not hide a pending
    // notice, and that survives the fix for the reader's OWN channel: npm asks, npm's query
    // fails, npm's cached number is still reported.
    const fs = volWith(open({ latest_version: '0.30.0', latest_version_channel: 'npm' }))
    expect(
      await failedQuery({ fs, latestSource: async () => NPM_VERSION_QUERY }),
    ).toMatchObject({ latestVersion: '0.30.0', isNewer: true, source: 'network' })
  })

  it('refuses the other channel’s number on that same path', async () => {
    // And the brew copy on the same file gets silence, not npm's 0.30.0 — the reported bug,
    // reached through the failed query rather than the throttle.
    const fs = volWith(open({ latest_version: '0.30.0', latest_version_channel: 'npm' }))
    expect(await failedQuery({ fs, latestSource: async () => BREW_QUERY })).toMatchObject({
      latestVersion: null,
      isNewer: false,
    })
  })
})

describe('QA #215 the write attributes only what this run resolved', () => {
  it('files a Homebrew answer under brew, and serves it to brew alone', async () => {
    const fs = volWith(open())
    const { exec, calls } = execAnswering(
      JSON.stringify({ formulae: [{ versions: { stable: '0.27.0' } }], casks: [] }),
    )
    const decision = await decide({ fs, exec, latestSource: async () => BREW_QUERY })
    expect(calls[0].args).toEqual(['info', '--json=v2', 'ralph'])
    expect(fileIn(fs)).toMatchObject({ latest_version: '0.27.0', latest_version_channel: 'brew' })
    expect(decision.latestVersion).toBe('0.27.0')
    // The npm copy that runs next, inside the same window, reads nothing.
    const next = await decide({ fs, latestSource: async () => NPM_VERSION_QUERY })
    expect(next).toMatchObject({ latestVersion: null, isNewer: false, source: 'cache' })
  })

  it('writes an unattributable answer UNATTRIBUTED rather than under npm', async () => {
    // A descriptor with a runnable argv and no channel id. The number is kept — the run that
    // resolved it still reports it — and it is then readable by nobody, which is the only
    // honest filing for an answer whose channel was never named.
    const fs = volWith(open())
    const { exec } = execAnswering('0.31.0')
    const decision = await decide({
      fs,
      exec,
      latestSource: async () => ({ argv: ['npm', 'view', 'x', 'version'], format: 'semver-line' }),
    })
    expect(decision.latestVersion).toBe('0.31.0')
    expect(fileIn(fs)).toMatchObject({
      latest_version: '0.31.0',
      latest_version_channel: null,
    })
    for (const channel of [NPM_VERSION_QUERY, BREW_QUERY]) {
      expect((await decide({ fs, latestSource: async () => channel })).latestVersion).toBeNull()
    }
  })

  it('writes a hostile channel id as unattributed, never as `[object Object]`', async () => {
    // The descriptor is a caller's object, so `channel` can be anything. Each of these must
    // reach the file as null rather than as a stringified id some future reader matches.
    for (const channel of [42, {}, [], true, '', '   ', null]) {
      const fs = volWith(open())
      const { exec } = execAnswering('0.31.0')
      await decide({
        fs,
        exec,
        latestSource: async () => ({
          argv: ['npm', 'view', 'x', 'version'],
          format: 'semver-line',
          channel,
        }),
      })
      expect(fileIn(fs).latest_version_channel, JSON.stringify(channel)).toBeNull()
    }
  })

  it('does not re-stamp another channel’s number when this run’s query FAILS', async () => {
    // #24 keeps a previously known version through a flaky night. #215's addition is that
    // the survivor keeps its OWNER: an npm copy whose query fails must not inherit the
    // brew number sitting in the file, in the cache or in its own decision.
    const fs = volWith(open({ latest_version: '0.27.0', latest_version_channel: 'brew' }))
    const decision = await decide({
      fs,
      exec: async () => ({ exitCode: 1, stdout: '' }),
      latestSource: async () => NPM_VERSION_QUERY,
    })
    expect(decision.latestVersion).toBeNull()
    expect(decision.isNewer).toBe(false)
    expect(fileIn(fs)).toMatchObject({ latest_version: '0.27.0', latest_version_channel: 'brew' })
    // ...and the window WAS spent, which is #24's rule: a broken network is exactly when
    // retrying every run is most useless.
    expect(fileIn(fs).last_check_at).toBe(new Date(T0).toISOString())
  })

  it('replaces the pair as a unit when a second channel answers', async () => {
    // Two channels, one file, back to back with the window forced open each time. What must
    // never appear on disk is a crossed pair — one channel's number under the other's name.
    const fs = volWith(open({ latest_version: '0.23.0', latest_version_channel: 'npm' }))
    const { exec } = execAnswering(
      JSON.stringify({ formulae: [{ versions: { stable: '0.27.0' } }] }),
    )
    await decide({ fs, exec, latestSource: async () => BREW_QUERY, now: () => T0 })
    expect(fileIn(fs)).toMatchObject({ latest_version: '0.27.0', latest_version_channel: 'brew' })
    expect((await decide({ fs, latestSource: async () => NPM_VERSION_QUERY })).latestVersion)
      .toBeNull()
  })

  it('reads the descriptor’s `channel` exactly ONCE, through the copy', () => {
    // `resolveLatestSource` copies the caller's object inside its own try, so a getter can
    // neither throw on an unguarded line nor answer one channel to the check and another to
    // the stamp. Counted rather than argued: a second read is the seam a hostile descriptor
    // would use to get a brew number filed under npm.
    const reads = []
    const fs = volWith(open())
    const { exec } = execAnswering('0.31.0')
    const hostile = {
      argv: ['npm', 'view', 'x', 'version'],
      format: 'semver-line',
      get channel() {
        reads.push(reads.length)
        return reads.length > 1 ? 'npm' : 'brew'
      },
    }
    return decide({ fs, exec, latestSource: async () => hostile }).then(() => {
      expect(reads).toHaveLength(1)
      expect(fileIn(fs).latest_version_channel).toBe('brew')
    })
  })
})

describe('QA #215 resolveUpdateDecision stays TOTAL now that it resolves a channel first', () => {
  // The channel resolution moved ABOVE the throttle branch, so a hostile `latestSource` is
  // now awaited on a path that never touched it before. Every row asserts the same two
  // things: no throw, and a decision shaped like a decision.
  const shaped = (d) => {
    expect(d).toMatchObject({
      isNewer: expect.any(Boolean),
      shouldPrompt: expect.any(Boolean),
      source: expect.any(String),
    })
    expect(d.latestVersion === null || typeof d.latestVersion === 'string').toBe(true)
  }

  it('survives a hostile home on both paths', async () => {
    // `readVersionCache` computes its path in a default parameter, ahead of its own try
    // blocks, so a non-string home throws out of `join` — which is what the load-bearing
    // catch at lib/update-check.js:271-281 is for. Driven with a channel named, because the
    // resolution now happens before the throttle read and could plausibly be moved above
    // that catch by a later edit.
    for (const home of [null, 42, {}, [], () => {}]) {
      const d = await decide({ home, fs: volWith(null), latestSource: async () => BREW_QUERY })
      shaped(d)
      expect(d.latestVersion, JSON.stringify(home)).toBeNull()
    }
  })

  it('survives a broken clock while still naming a channel', async () => {
    const fs = volWith(throttled({ latest_version: '0.30.0', latest_version_channel: 'brew' }))
    for (const now of [
      () => { throw new Error('no clock') },
      () => NaN,
      () => Infinity,
      () => 8.64e15 + 1,
      () => '2026-09-14',
      42,
      null,
    ]) {
      const d = await decide({ fs, now, latestSource: async () => BREW_QUERY })
      shaped(d)
    }
  })

  it('survives an fs whose read and write both throw', async () => {
    const brokenRead = {
      readFileSync: () => { throw new Error('EIO') },
      mkdirSync: () => {},
      writeFileSync: () => {},
    }
    const brokenWrite = {
      readFileSync: () => throttled({ latest_version: '0.30.0', latest_version_channel: 'brew' }),
      mkdirSync: () => { throw new Error('EACCES') },
      writeFileSync: () => { throw new Error('EACCES') },
    }
    shaped(await decide({ fs: brokenRead, latestSource: async () => BREW_QUERY }))
    const d = await decide({ fs: brokenWrite, latestSource: async () => BREW_QUERY })
    // The read succeeded, so the throttled path still serves brew its own number even
    // though nothing could be written.
    expect(d.latestVersion).toBe('0.30.0')
  })

  it('survives a latestSource that is not a function and not a descriptor', async () => {
    const fs = volWith(throttled({ latest_version: '0.30.0', latest_version_channel: 'npm' }))
    for (const latestSource of [42, 'brew', true, [], Symbol('brew')]) {
      shaped(await decide({ fs, latestSource }))
    }
  })

  it('survives a descriptor whose every property throws', async () => {
    // A Proxy that throws on any read. `resolveLatestSource`'s try covers the argv read AND
    // the spread, which is what keeps this from escaping a function whose contract is that
    // it never throws.
    const hostile = new Proxy(
      {},
      { get: () => { throw new Error('hostile getter') } },
    )
    const fs = volWith(throttled({ latest_version: '0.30.0', latest_version_channel: 'brew' }))
    shaped(await decide({ fs, latestSource: async () => hostile }))
    shaped(await decide({ fs, latestSource: hostile }))
  })

  it('survives an env bag that is null, and reads no cache when opted out', async () => {
    shaped(await decide({ processEnv: null, fs: volWith(null), latestSource: async () => BREW_QUERY }))
    const fs = volWith(throttled({ latest_version: '0.30.0', latest_version_channel: 'brew' }))
    const off = await decide({
      fs,
      processEnv: { RALPH_NO_UPDATE_CHECK: '1' },
      latestSource: () => { throw new Error('must not be asked') },
    })
    // The opt-out returns before the channel is resolved at all, so a thunk that would
    // throw is never called — the guarantee the #215 comment at update-check.js:308-310 makes.
    expect(off).toMatchObject({ latestVersion: null, source: 'disabled', updatedCache: null })
  })
})

describe('QA #215 recordPromptShown cannot launder attribution', () => {
  const stamp = (over = {}) =>
    recordPromptShown({ now: () => T0, processEnv: {}, home: HOME, ...over })

  it('carries a foreign pair through untouched — showing a prompt re-attributes nothing', () => {
    const fs = volWith(throttled({ latest_version: '0.27.0', latest_version_channel: 'brew' }))
    const stamped = stamp({ fs })
    expect(stamped).toMatchObject({ latest_version: '0.27.0', latest_version_channel: 'brew' })
    expect(fileIn(fs)).toMatchObject({
      latest_version: '0.27.0',
      latest_version_channel: 'brew',
      last_prompted_at: new Date(T0).toISOString(),
    })
    // The one field it is allowed to change is the only field that changed.
    expect(fileIn(fs).last_check_at).toBe(new Date(T0 - DAY).toISOString())
  })

  it('clears BOTH fields when the cache could not be read, never just the stamp', () => {
    // A read failure means this run knows no pair. Writing the stamp alone would leave a
    // channel id beside a number from nowhere; writing the number alone would leave an
    // unowned number that a later unattributed write could pick up. Empty defaults do
    // neither, and the pair invariant survives a failed read.
    const disk = volWith(throttled({ latest_version: '0.27.0', latest_version_channel: 'brew' }))
    const fs = {
      readFileSync: () => { throw new Error('EIO') },
      mkdirSync: (...a) => disk.mkdirSync(...a),
      writeFileSync: (...a) => disk.writeFileSync(...a),
    }
    expect(stamp({ fs })).toMatchObject({ latest_version: null, latest_version_channel: null })
    expect(fileIn(disk)).toMatchObject({ latest_version: null, latest_version_channel: null })
  })

  it('answers null rather than throwing for a hostile home, a broken clock, a dead write', () => {
    for (const home of [null, 42, {}]) {
      // Total, and honest about it: the read throws out of `join` and is caught, then the
      // WRITE throws on the same path and answers null — "nothing could be persisted"
      // rather than a stamped cache that never reached a file.
      expect(() => stamp({ home, fs: volWith(null) }), JSON.stringify(home)).not.toThrow()
      expect(stamp({ home, fs: volWith(null) }), JSON.stringify(home)).toBeNull()
    }
    const dead = { readFileSync: () => throttled(), mkdirSync: () => {}, writeFileSync: () => { throw new Error('EACCES') } }
    expect(stamp({ fs: dead })).toBeNull()
    const fs = volWith(throttled())
    expect(stamp({ fs, now: () => { throw new Error('no clock') } })).toBeTruthy()
  })

  it('writes the four-key shape, so a stamp cannot introduce a fifth field', () => {
    const fs = volWith(throttled({ latest_version: '0.27.0', latest_version_channel: 'brew' }))
    stamp({ fs })
    expect(Object.keys(fileIn(fs))).toEqual([
      'last_check_at',
      'last_prompted_at',
      'latest_version',
      'latest_version_channel',
    ])
  })
})

describe('QA #215 two copies, one file, over several weeks', () => {
  // A machine with both copies installed, as the issue describes. Each "run" is a real
  // `resolveUpdateDecision` over one shared memfs volume, so the interleaving is the real
  // one: whichever copy runs first inside a window spends the global `last_check_at`.
  const runAs = (fs, query, stdout, nowMs) =>
    decide({
      fs,
      now: () => nowMs,
      exec: async () => ({ exitCode: 0, stdout }),
      latestSource: async () => query,
    })
  const NPM_OUT = '0.23.0'
  const BREW_OUT = JSON.stringify({ formulae: [{ versions: { stable: '0.27.0' } }] })

  it('never lets either copy read the other’s number, whichever runs first', async () => {
    for (const npmFirst of [true, false]) {
      const fs = volWith(null)
      const first = npmFirst
        ? await runAs(fs, NPM_VERSION_QUERY, NPM_OUT, T0)
        : await runAs(fs, BREW_QUERY, BREW_OUT, T0)
      const second = npmFirst
        ? await runAs(fs, BREW_QUERY, BREW_OUT, T0 + 60_000)
        : await runAs(fs, NPM_VERSION_QUERY, NPM_OUT, T0 + 60_000)
      expect(first.latestVersion).toBe(npmFirst ? '0.23.0' : '0.27.0')
      // The second copy is throttled by the global window and reads the other channel's
      // pair, so it learns nothing — correct, and the cost this slice accepted.
      expect(second).toMatchObject({ latestVersion: null, source: 'cache' })
    }
  })

  it('leaves a consistent pair after two copies race the same window', async () => {
    // Concurrent, not sequential: both runs read before either writes. One write wins the
    // file and the loser's number is gone — but the pair that lands is one channel's own,
    // never a crossed one, and each run reports the answer IT resolved.
    const fs = volWith(null)
    const [a, b] = await Promise.all([
      runAs(fs, NPM_VERSION_QUERY, NPM_OUT, T0),
      runAs(fs, BREW_QUERY, BREW_OUT, T0),
    ])
    expect(a.latestVersion).toBe('0.23.0')
    expect(b.latestVersion).toBe('0.27.0')
    const landed = fileIn(fs)
    expect([
      ['0.23.0', 'npm'],
      ['0.27.0', 'brew'],
    ]).toContainEqual([landed.latest_version, landed.latest_version_channel])
  })

  // THE STARVATION, and the three tests it takes to state it honestly.
  //
  // Round 1 of this file asserted the cost lib/version-cache.js:56-67 CLAIMED — "one week of
  // a version notice arriving late for the copy that lost the race" — and measured zero
  // sightings across six windows instead. The dev corrected the comment, which now records
  // the measured cost (starvation is indefinite for a habitual loser) and re-argues global
  // windows against it, and contested the assertion as unsatisfiable alongside the pins at
  // :647, :888 and :621.
  //
  // That contest is settled below by construction, in three parts, because the honest answer
  // needs all three: what the shipped design DOES (measured, and why no reading of the file
  // alone can do better), what a four-key alternative CAN do (measured — the argument is
  // refuted, a turn rule bounds it), and what that alternative COSTS (measured — which is
  // why the recorded decision is still defensible). The last test is left red on purpose: it
  // is the trade-off itself, which is a person's call and not a test's.
  //
  // A helper for the alternatives. `resolveUpdateDecision` is not parameterized by its
  // throttle rule, so the candidates are MODELLED — but modelled over the real
  // `readVersionCache`/`writeVersionCache`/`cachedVersionFor` and the real cache file, so
  // only the one branch under examination is a stand-in. `C0` reproduces the shipped rule and
  // is checked against the real function below, which is what makes the model's other rows
  // worth reading.
  const WEEK = 7 * DAY
  const globalDue = (cache, nowMs) => {
    const at = Date.parse(cache.last_check_at ?? '')
    return !Number.isFinite(at) || nowMs - at >= WEEK
  }
  const modelRun = (mayQuery) => (fs, channel, version, nowMs) => {
    const cache = readVersionCache({ fs, processEnv: {}, home: HOME })
    if (!mayQuery({ cache, nowMs, reader: channel })) {
      return { latestVersion: cachedVersionFor(cache, channel), source: 'cache' }
    }
    writeVersionCache({
      cache: {
        ...cache,
        latest_version: version,
        latest_version_channel: channel,
        last_check_at: new Date(nowMs).toISOString(),
      },
      fs,
      processEnv: {},
      home: HOME,
    })
    return { latestVersion: version, source: 'network' }
  }
  // C0: the shipped rule — one global window, whoever gets there first spends it.
  const C0 = modelRun(({ cache, nowMs }) => globalDue(cache, nowMs))
  // C1: re-open the window when the pair on disk belongs to another channel. The first of the
  // two alternatives lib/version-cache.js:64-66 prices.
  const C1 = modelRun(
    ({ cache, nowMs, reader }) =>
      globalDue(cache, nowMs) ||
      (Boolean(cache.latest_version) && cachedVersionFor(cache, reader) === null),
  )
  // C2: TAKE TURNS — a copy that would spend the window on a pair already its own stands
  // down for one window and lets the other channel have it. The second alternative priced
  // there, and the one that refutes the unsatisfiability argument.
  const C2 = modelRun(({ cache, nowMs, reader }) => {
    if (!globalDue(cache, nowMs)) return false
    if (cachedVersionFor(cache, reader) === null) return true
    const at = Date.parse(cache.last_check_at ?? '')
    return !Number.isFinite(at) || nowMs - at >= 2 * WEEK
  })

  // Six windows, npm always first by a minute: a machine with a deterministic loser — a daily
  // `ralph start` in a repo on the npm copy, a weekly one on the brew copy.
  const sixWindows = async (run, fs = volWith(null)) => {
    const brewSaw = []
    const brewRead = []
    for (let week = 0; week < 6; week++) {
      const windowStart = T0 + week * 8 * DAY
      await run(fs, NPM_VERSION_QUERY, NPM_OUT, windowStart)
      // Everything brew gets from disk, captured before its run — the file IS its whole
      // observable input beyond the clock and its own descriptor.
      brewRead.push(fs.readFileSync(CACHE_PATH, 'utf8').toString())
      brewSaw.push((await run(fs, BREW_QUERY, BREW_OUT, windowStart + 60_000)).latestVersion)
    }
    return { brewSaw, brewRead, file: fileIn(fs) }
  }
  const asReal = (fs, query, stdout, nowMs) => runAs(fs, query, stdout, nowMs)
  const asModel = (model) => (fs, query, stdout, nowMs) =>
    model(fs, query === NPM_VERSION_QUERY ? 'npm' : 'brew', query === NPM_VERSION_QUERY ? NPM_OUT : '0.27.0', nowMs)
  // The one field that legitimately differs between windows is the absolute epoch of
  // `last_check_at`, which in every one of these reads is "the other copy, 60 seconds ago".
  const sameShape = (raw, brewNowMs) => raw.replace(new Date(brewNowMs - 60_000).toISOString(), '<NOW-60s>')

  it('starves a habitual loser INDEFINITELY, and its input never changes — the measurement', async () => {
    // CRITERION 4's cost, measured, which is what lib/version-cache.js:59-63 now records.
    // The tap has been at 0.27.0 the whole time and the brew copy is at 0.25.4, and the brew
    // copy is never told: six windows, zero sightings, because the global `last_check_at` is
    // spent by the npm copy sixty seconds before brew runs, every time.
    const { brewSaw, brewRead } = await sixWindows(asReal)
    expect(brewSaw).toEqual([null, null, null, null, null, null])

    // AND WHY NO READING OF THE FILE CAN DO BETTER, which is the half of the dev's argument
    // that holds. Brew's input is byte-identical in all six windows once the epoch is
    // normalized, and identical again to the two-copy single-window case at :647 where the
    // same null is the CORRECT answer. So no rule that is a function of (this file, this
    // clock offset, this descriptor) can answer null there and 0.27.0 here — a four-key file
    // and no write on the throttled path leave nothing for such a rule to key on. What CAN
    // differ is what the OTHER copy writes, which is the gap the next test walks through.
    const shapes = new Set(brewRead.map((raw, week) => sameShape(raw, T0 + week * 8 * DAY + 60_000)))
    expect(shapes.size).toBe(1)
    const oneWindow = volWith(null)
    await runAs(oneWindow, NPM_VERSION_QUERY, NPM_OUT, T0)
    expect(sameShape(oneWindow.readFileSync(CACHE_PATH, 'utf8').toString(), T0 + 60_000)).toBe(
      [...shapes][0],
    )
  })

  it('could be bounded at two windows by a four-key TURN rule, at a measured price', async () => {
    // THE UNSATISFIABILITY ARGUMENT, REFUTED BY CONSTRUCTION. The claim was that informing
    // brew in any of these windows needs a fifth cache field (blocked by :621) or a write on
    // the throttled path (blocked by lib/update-gate.cache-channel.qa.test.js's untouched-file
    // pin). It needs neither. The argument holds BREW's input fixed, but brew's input is
    // written by the npm copy, and a candidate may change that too: C2 has the copy that
    // would spend the window on a pair already its own stand down for one window, so the
    // file brew reads next window carries a STALE `last_check_at` and brew takes the query.
    //
    // First: the model agrees with the real function on the shipped rule, which is what makes
    // the rest of this test evidence rather than assertion.
    expect((await sixWindows(asModel(C0))).brewSaw).toEqual([null, null, null, null, null, null])

    // C2, same six windows, same interleaving: bounded at two windows, not indefinite.
    const turns = await sixWindows(asModel(C2))
    expect(turns.brewSaw).toEqual([null, '0.27.0', null, '0.27.0', null, '0.27.0'])
    // With no fifth field and no throttled write — the two things the argument said were
    // required. The stamp #215 already added IS the turn token.
    expect(Object.keys(turns.file)).toEqual([
      'last_check_at',
      'last_prompted_at',
      'latest_version',
      'latest_version_channel',
    ])
    // And it satisfies :647 and :888 too, the two pins said to go red: the second copy inside
    // ONE window still learns nothing (C2 only ever stands DOWN, it never re-opens), and the
    // alternating machine still flaps exactly as measured.
    const oneWindow = volWith(null)
    const run2 = asModel(C2)
    expect((await run2(oneWindow, NPM_VERSION_QUERY, NPM_OUT, T0)).latestVersion).toBe('0.23.0')
    expect(await run2(oneWindow, BREW_QUERY, BREW_OUT, T0 + 60_000)).toMatchObject({
      latestVersion: null,
      source: 'cache',
    })

    // THE PRICE, which is why the recorded decision to keep global windows still stands even
    // though the argument for it was wrong. Standing down is indistinguishable from the
    // single-copy case — one copy, one machine, a run every eight days — so EVERY machine
    // with one Ralph on it queries half as often and its notice arrives up to two weeks late
    // instead of one. That is the cost lib/version-cache.js:65-66 states, measured: four
    // queries where the shipped rule makes eight, for the ~all-of-them case, to bound a
    // starvation that only exists on a two-channel machine.
    const solo = (run) => {
      const fs = volWith(null)
      const sources = []
      return (async () => {
        for (let i = 0; i < 8; i++)
          sources.push((await run(fs, 'npm', NPM_OUT, T0 + i * 8 * DAY)).source)
        return sources.filter((s) => s === 'network').length
      })()
    }
    expect(await solo(C0)).toBe(8)
    expect(await solo(C2)).toBe(4)

    // C1's price, the other alternative the comment names: ten alternating runs inside ONE
    // window cost ten queries instead of one, because each copy re-opens the window the other
    // just closed. #24's cap is "one query a week per machine"; C1 deletes it.
    const churn = async (run) => {
      const fs = volWith(null)
      let queries = 0
      for (let i = 0; i < 10; i++) {
        const r = await (i % 2
          ? run(fs, 'brew', '0.27.0', T0 + i * 1000)
          : run(fs, 'npm', NPM_OUT, T0 + i * 1000))
        if (r.source === 'network') queries++
      }
      return queries
    }
    expect(await churn(C1)).toBe(10)
    expect(await churn(C0)).toBe(1)
  })

  it('does NOT inform a starved Homebrew copy, ever — a recorded non-goal, tracked as #228', async () => {
    // A DECLINED OUTCOME, recorded as such. This test used to demand the sighting and sit red.
    // It is green now because the answer came back "we are not doing this in #215", and the
    // reason is measured two tests up: bounding the starvation costs EVERY single-copy machine
    // half its checks (four queries in eight windows instead of eight, so a notice up to two
    // weeks late), to fix a copy that only starves on a two-channel machine whose other copy
    // wins the window every time. Regressing the common case for the uncommon one is a product
    // call, not a defect, so it is filed rather than fixed.
    //
    // WHAT IS STILL TRUE AND NOT FIXED, which is why this test exists at all rather than being
    // deleted: the reported machine had npm at 0.25.4 and Homebrew at 0.26.0 with the tap
    // ahead. #215 stops the brew copy reading npm's number — criterion 1, and correct — but a
    // brew copy whose npm sibling runs first every window is now told nothing at all instead of
    // something wrong. Criterion 1 is satisfied by silence; a user waiting for 0.27.0 is not.
    //
    // THE ALTERNATIVE IS LIVE, NOT LOST: #228 carries C2 by name — stand down for one window
    // when the cached pair is already yours, using `latest_version_channel` itself as the turn
    // token — with its `[null, 0.27.0, null, 0.27.0, null, 0.27.0]` sequence, its four-key
    // shape, its zero throttled writes, and its price. Whoever revisits this starts from the
    // construction at :791 instead of re-deriving it. If this expectation ever flips, #215's
    // trade-off has been renegotiated and #228 is the place that says so.
    const { brewSaw } = await sixWindows(asReal)
    expect(brewSaw.filter((v) => v === '0.27.0')).toHaveLength(0)
  })

  it('flaps the notice week to week when the two copies alternate — measured, not asserted good', () => {
    // The other interleaving: whichever copy happens to run first each window owns the file,
    // so a copy can be told "0.27.0 is out" one week and "nothing cached" the next, with
    // nothing having changed upstream. Documented as a CHARACTERIZATION — one file can hold
    // one channel's answer, so this follows from the stamp design rather than from a bug in
    // it, and the map alternative argued down at lib/version-cache.js:28-53 is the thing
    // that would fix it.
    const fs = volWith(null)
    const seenByBrew = []
    return (async () => {
      for (let week = 0; week < 4; week++) {
        const windowStart = T0 + week * 8 * DAY
        const brewGoesFirst = week % 2 === 0
        if (brewGoesFirst) {
          seenByBrew.push((await runAs(fs, BREW_QUERY, BREW_OUT, windowStart)).latestVersion)
          await runAs(fs, NPM_VERSION_QUERY, NPM_OUT, windowStart + 60_000)
        } else {
          await runAs(fs, NPM_VERSION_QUERY, NPM_OUT, windowStart)
          seenByBrew.push(
            (await runAs(fs, BREW_QUERY, BREW_OUT, windowStart + 60_000)).latestVersion,
          )
        }
      }
      expect(seenByBrew).toEqual(['0.27.0', null, '0.27.0', null])
    })()
  })
})

describe('QA #215 the throttled decision’s updatedCache is not a second read path', () => {
  it('carries the foreign pair in-band, which nothing shipped may read', async () => {
    // The throttled path returns the cache it read as `updatedCache`, so the foreign pair is
    // still THERE — `latestVersion` is null while `updatedCache.latest_version` is another
    // channel's number. That is documented as informational (lib/update-check.js:231-234),
    // and it is safe only for as long as no consumer treats it as a version source. Both
    // halves are pinned: the trap exists, and nothing shipped walks into it.
    const fs = volWith(throttled({ latest_version: '0.27.0', latest_version_channel: 'brew' }))
    const decision = await decide({ fs, latestSource: async () => NPM_VERSION_QUERY })
    expect(decision.latestVersion).toBeNull()
    expect(decision.updatedCache).toMatchObject({
      latest_version: '0.27.0',
      latest_version_channel: 'brew',
    })
  })

  it('is read by no shipped module', () => {
    const readers = collectShipped(RALPH_HOME)
      .filter(({ code }) => /\.updatedCache|updatedCache\s*\./.test(code))
      .map(({ path }) => path.replace(RALPH_HOME, '').replace(/^[/\\]/, ''))
    expect(readers).toEqual([])
  })

  it('never exposes a version through the cache the WRITE path returns either', async () => {
    // The network path's `updatedCache` is built from `withLatestVersion`, so the same
    // question applies to it: whatever a consumer might one day read off it, the pair is
    // consistent and readable only by the channel that resolved it.
    const fs = volWith(open({ latest_version: '0.23.0', latest_version_channel: 'npm' }))
    const decision = await decide({
      fs,
      exec: async () => ({ exitCode: 0, stdout: BREW_STABLE }),
      latestSource: async () => BREW_QUERY,
    })
    const cache = decision.updatedCache
    expect(cache).toMatchObject({ latest_version: '0.27.0', latest_version_channel: 'brew' })
    expect(readVersionCache({ fs, home: HOME, processEnv: {} })).toMatchObject({
      latest_version: '0.27.0',
      latest_version_channel: 'brew',
    })
  })
})

const BREW_STABLE = JSON.stringify({ formulae: [{ versions: { stable: '0.27.0' } }], casks: [] })

describe('QA #215 the cache file a legacy copy left is never adopted', () => {
  it('serves a bare `latest_version` to neither channel, on either path', async () => {
    // Criterion 2, at the decision level and from BOTH sides. The number in the observed
    // file was npm's, but a 0.26.0 Homebrew copy wrote the TAP's number into the same bare
    // field — so "unstamped means mine" is wrong for whichever copy guesses, and the only
    // safe reading is nobody's.
    const legacy = JSON.stringify({
      last_check_at: new Date(T0 - DAY).toISOString(),
      last_prompted_at: null,
      latest_version: '0.30.0',
    })
    for (const query of [NPM_VERSION_QUERY, BREW_QUERY]) {
      const d = await decide({ fs: volWith(legacy), latestSource: async () => query })
      expect(d, query.channel ?? 'unnamed').toMatchObject({ latestVersion: null, isNewer: false })
    }
  })

  it('re-attributes a legacy number the first time a channel actually answers', async () => {
    // The repair path: the unowned number is replaced, not adopted. The run that queries is
    // the only run allowed to name an owner, and it names its own.
    const fs = volWith(
      JSON.stringify({
        last_check_at: new Date(T0 - 30 * DAY).toISOString(),
        latest_version: '0.30.0',
      }),
    )
    await decide({
      fs,
      exec: async () => ({ exitCode: 0, stdout: BREW_STABLE }),
      latestSource: async () => BREW_QUERY,
    })
    expect(fileIn(fs)).toMatchObject({ latest_version: '0.27.0', latest_version_channel: 'brew' })
  })

  it('does not adopt a legacy number when the query FAILS either', async () => {
    // The window is spent and the number is still unowned. A `?? cache.latest_version`
    // fallback here — the shape #24 had — would hand the reader an unattributed number on
    // exactly the run that learned nothing.
    const fs = volWith(
      JSON.stringify({
        last_check_at: new Date(T0 - 30 * DAY).toISOString(),
        latest_version: '0.30.0',
      }),
    )
    const d = await decide({
      fs,
      exec: async () => ({ exitCode: 1, stdout: '' }),
      latestSource: async () => BREW_QUERY,
    })
    expect(d.latestVersion).toBeNull()
    expect(fileIn(fs)).toMatchObject({ latest_version: '0.30.0', latest_version_channel: null })
  })

  it('leaves a version this module wrote readable by the pre-#215 reader', () => {
    // Forward compatibility across a downgrade: an older copy reads `latest_version` with no
    // notion of the stamp. It must find a bare semver string, never a decorated one.
    const fs = volWith(null)
    writeVersionCache({
      cache: { latest_version: '0.27.0', latest_version_channel: 'brew' },
      fs,
      home: HOME,
      processEnv: {},
    })
    expect(fileIn(fs).latest_version).toBe('0.27.0')
  })
})

// Every shipped .js file (lib/ and bin/), comment-free, as {path, code} — the same sweep
// lib/update-check.channel.qa.test.js:568 uses, so a claim about "nothing shipped" is
// measured over the package rather than over the files this author thought of.
function collectShipped(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (full.endsWith('.js') && !/\.test\.js$/.test(full)) {
        out.push({ path: full, code: codeWithoutComments(full) })
      }
    }
  }
  walk(join(root, 'lib'))
  walk(join(root, 'bin'))
  return out
}
