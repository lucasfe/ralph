import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import {
  EMPTY_VERSION_CACHE,
  cachedVersionFor,
  readVersionCache,
  withLatestVersion,
  writeVersionCache,
} from './version-cache.js'

// QA #215 — the channel STAMP, attacked at the seam rather than exercised.
//
// lib/version-cache.channel.test.js drives the happy shape of the fix: npm writes, brew reads
// nothing, a legacy file is attributed to nobody. This file assumes the fix works for the two
// channels it was written for and asks the questions a two-copy machine can still put to it:
//
//   1. IS THE MATCH EXACT? A stamp and a reader are two strings compared with `!==`. Case,
//      padding, a third channel id, the empty string and ABSENT-vs-ABSENT are each a way for
//      that comparison to answer yes when it should answer no — and one of them (`undefined ===
//      undefined`) is the way a naive implementation of this rule leaks every legacy file to
//      every reader.
//   2. IS `readVersionCache` STILL TOTAL? #24's promise is that `ralph start` never aborts over
//      its own cache, and #215 added a fourth field for a hand-editor to get wrong. The table
//      below is the same hostile-value table this module was built on, applied to the new field
//      and to the new field's PAIRINGS — a stamp with no version, a version with no stamp.
//   3. DOES THE PAIR SURVIVE A ROUND TRIP? The whole safety argument is that a number and its
//      owner move together. That is a property of `withLatestVersion` in memory AND of
//      `writeVersionCache`/`readVersionCache` across the file, so it is asserted across the file.
//
// The command-level halves are lib/update-check.cache-channel.qa.test.js (the decision, the
// stamp, the races) and lib/update-gate.cache-channel.qa.test.js (what a user actually reads).
//
// Hermetic (#41): memfs, a fake home, an empty env bag. Nothing here reaches ~/.config.

const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')

const NPM = 'npm'
const BREW = 'brew'

const vol = (seed = {}) => Volume.fromJSON(seed, '/')
const fileOf = (raw) => vol({ [CACHE_PATH]: raw })
const read = (fs) => readVersionCache({ fs, home: HOME, processEnv: {} })
const write = (cache, fs) => writeVersionCache({ cache, fs, home: HOME, processEnv: {} })
const rawOf = (fs) => fs.readFileSync(CACHE_PATH, 'utf8').toString()

describe('QA #215 the stamp/reader match must be EXACT, and fail closed every other way', () => {
  // THE MATRIX. Every stamp a file can carry crossed with every channel a reader can name, and
  // the only cells that serve a version are the ones where two non-blank strings are equal
  // after trimming. Written as a matrix rather than as cases because the defect this guards is
  // a WIDENING — a `.toLowerCase()` added for convenience, or a `??` that turns absent into a
  // wildcard — and a widening shows up as one extra cell, not as a failed case.
  const STAMPS = [undefined, null, '', '   ', NPM, BREW, 'NPM', 'Brew', ' brew ', 'homebrew']
  const READERS = [undefined, null, '', '   ', NPM, BREW, 'NPM', 'Brew', ' brew ', 'homebrew']
  const trimmed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

  for (const stamp of STAMPS) {
    it(`serves a version stamped ${JSON.stringify(stamp)} to exactly one reader`, () => {
      const cache = { latest_version: '0.27.0', latest_version_channel: stamp }
      const served = READERS.filter((reader) => cachedVersionFor(cache, reader) === '0.27.0')
      const expected = trimmed(stamp)
        ? READERS.filter((reader) => trimmed(reader) === trimmed(stamp))
        : []
      expect(served, `stamp ${JSON.stringify(stamp)}`).toEqual(expected)
      // ...and every cell that did not serve served NOTHING, not `undefined` and not the
      // untrimmed string. A caller distinguishing those two would have a fourth state to get
      // wrong, and `ralph start`'s banner tests `typeof === 'string'` nowhere any more.
      for (const reader of READERS) {
        if (served.includes(reader)) continue
        expect(cachedVersionFor(cache, reader), JSON.stringify([stamp, reader])).toBeNull()
      }
    })
  }

  it('does not let ABSENT match ABSENT — the legacy-file leak, refused', () => {
    // THE SINGLE MOST IMPORTANT CELL IN THE MATRIX ABOVE, spelled out because a plain
    // `cache.latest_version_channel === channel` would pass every other test in this file and
    // fail this one: `undefined === undefined` is true, so a legacy file (no stamp) would be
    // served to a caller that named no channel. On the machine #215 was reported from that
    // caller reads a field a 0.26.0 Homebrew copy wrote with the TAP's number in it.
    const legacy = { latest_version: '0.23.0' }
    expect(cachedVersionFor(legacy, undefined)).toBeNull()
    expect(cachedVersionFor(legacy, null)).toBeNull()
    expect(cachedVersionFor({ latest_version: '0.23.0', latest_version_channel: null }, null))
      .toBeNull()
    // The same trap one level down: a blank stamp and a blank reader are also equal as strings.
    expect(cachedVersionFor({ latest_version: '0.23.0', latest_version_channel: '' }, '')).toBeNull()
    expect(cachedVersionFor({ latest_version: '0.23.0', latest_version_channel: '  ' }, '\t'))
      .toBeNull()
  })

  it('is case SENSITIVE in both directions, so a hand-edited stamp fails closed', () => {
    // The ids are a storage format (lib/install-markers.js says so), and nothing in the package
    // writes anything but lowercase. A file that says `NPM` is therefore a file a human edited,
    // and the safe reading of a human's guess at an internal id is "nobody's".
    expect(cachedVersionFor({ latest_version: '1.0.0', latest_version_channel: 'NPM' }, NPM))
      .toBeNull()
    expect(cachedVersionFor({ latest_version: '1.0.0', latest_version_channel: NPM }, 'NPM'))
      .toBeNull()
    expect(cachedVersionFor({ latest_version: '1.0.0', latest_version_channel: 'BREW' }, BREW))
      .toBeNull()
  })

  it('serves nothing for a channel id no version of Ralph ever wrote', () => {
    // A THIRD CHANNEL, which is what a future one looks like from an older copy: if the tap is
    // ever joined by a third publisher, or an id is renamed, every existing copy must read the
    // new stamp as somebody else's — not as its own, and not as a wildcard.
    const cache = { latest_version: '0.27.0', latest_version_channel: 'cellar' }
    for (const reader of [NPM, BREW, 'homebrew', 'tap', 'pnpm', 'brew ralph']) {
      expect(cachedVersionFor(cache, reader), reader).toBeNull()
    }
    // ...and symmetrically, a copy that named a channel nobody has written cannot read either
    // of the two that exist.
    for (const stamp of [NPM, BREW]) {
      expect(cachedVersionFor({ latest_version: '0.27.0', latest_version_channel: stamp }, 'cellar'))
        .toBeNull()
    }
  })

  it('compares the WHOLE id, so no stamp is a prefix or a substring of another', () => {
    // Cheap now, load-bearing the day a third id arrives: `brew` must not be readable by
    // `brew-head`, and `npm` must not be readable by `npmjs`.
    for (const [stamp, reader] of [
      [BREW, 'brew-head'],
      ['brew-head', BREW],
      [NPM, 'npmjs'],
      ['npmjs', NPM],
    ]) {
      expect(
        cachedVersionFor({ latest_version: '0.27.0', latest_version_channel: stamp }, reader),
        `${stamp} -> ${reader}`,
      ).toBeNull()
    }
  })

  it('trims but does not otherwise repair either side', () => {
    // Padding is the one difference the rule forgives, because `normalizeField` has forgiven it
    // on every field since #24 and a file a human touched should not lose its meaning to a
    // space. Everything else — an inner space, a newline in the middle, a NUL — is a different
    // id, measured here so nobody widens the trim into a sanitizer by accident.
    expect(cachedVersionFor({ latest_version: '1.0.0', latest_version_channel: '\n brew\t' }, BREW))
      .toBe('1.0.0')
    for (const stamp of ['br ew', 'b\nrew', `brew${String.fromCharCode(0)}`, 'brew.']) {
      expect(
        cachedVersionFor({ latest_version: '1.0.0', latest_version_channel: stamp }, BREW),
        JSON.stringify(stamp),
      ).toBeNull()
    }
  })

  it('answers a version only when there IS one, whatever the stamp says', () => {
    // The pair rule read from the other end: a stamp with nothing beside it is a claim about a
    // number that is not there, and the answer is null rather than the empty string a
    // `cache.latest_version` read would have produced.
    for (const version of [undefined, null, '', '   ', 42, {}, [], true]) {
      expect(
        cachedVersionFor({ latest_version: version, latest_version_channel: BREW }, BREW),
        JSON.stringify(version),
      ).toBeNull()
    }
  })

  it('reads a cache with no prototype, and one whose keys came from a JSON `__proto__`', () => {
    // Two shapes a real file can produce. `Object.create(null)` is what a defensive caller
    // hands over; the `__proto__` payload is what a hostile file produces, and JSON.parse makes
    // it an OWN property rather than a prototype write — so the nested pair must not be
    // reachable as this cache's own.
    const bare = Object.assign(Object.create(null), {
      latest_version: '0.27.0',
      latest_version_channel: BREW,
    })
    expect(cachedVersionFor(bare, BREW)).toBe('0.27.0')
    const parsed = JSON.parse(
      '{"__proto__":{"latest_version":"9.9.9","latest_version_channel":"npm"},' +
        '"latest_version":"0.27.0"}',
    )
    expect(cachedVersionFor(parsed, NPM)).toBeNull()
    expect(cachedVersionFor(parsed, BREW)).toBeNull()
    expect(Object.prototype.latest_version_channel).toBeUndefined()
  })
})

describe('QA #215 readVersionCache stays TOTAL over the new field', () => {
  // Every value a human, a crash or a foreign writer can leave in the field, driven through the
  // real reader over a real (in-memory) file. The claim is two-part and both parts matter: the
  // read does not throw, AND the result is a cache no reader can claim.
  const HOSTILE_STAMPS = [
    ['a number', 42],
    ['a float', 0.1],
    ['an object', { name: 'brew' }],
    ['an array', ['brew']],
    ['a nested array', [['brew']]],
    ['a boolean', true],
    ['boolean false', false],
    ['an explicit null', null],
    ['a blank string', ''],
    ['spaces', '   '],
    ['a tab and a newline', '\t\n'],
  ]

  for (const [label, stamp] of HOSTILE_STAMPS) {
    it(`reads a file whose channel is ${label} without crashing, and attributes it to nobody`, () => {
      const fs = fileOf(
        JSON.stringify({ latest_version: '0.27.0', latest_version_channel: stamp }),
      )
      const cache = read(fs)
      expect(cache.latest_version_channel).toBeNull()
      // The VERSION survives — the field is still readable, it is simply unowned, which is the
      // legacy behaviour #215 chose deliberately over discarding the number.
      expect(cache.latest_version).toBe('0.27.0')
      expect(cachedVersionFor(cache, NPM)).toBeNull()
      expect(cachedVersionFor(cache, BREW)).toBeNull()
    })
  }

  it('reads an absurdly long channel id, and serves it to nobody a real copy can be', () => {
    // 70 KB in one field. Not a crash risk in JS, but it is the shape a truncated write or a
    // log paste can leave, and the answer must be "not my channel" rather than a slow compare
    // against every id in the table.
    const long = 'b'.repeat(70_000)
    const cache = read(fileOf(JSON.stringify({ latest_version: '1.0.0', latest_version_channel: long })))
    expect(cache.latest_version_channel).toHaveLength(70_000)
    expect(cachedVersionFor(cache, BREW)).toBeNull()
    expect(cachedVersionFor(cache, NPM)).toBeNull()
    // ...and it is still self-consistent: a reader that really was that channel reads it.
    expect(cachedVersionFor(cache, long)).toBe('1.0.0')
  })

  it('reads the two half-pairs — a stamp with no version, a version with no stamp', () => {
    const stampOnly = read(fileOf(JSON.stringify({ latest_version_channel: BREW })))
    expect(stampOnly).toEqual({ ...EMPTY_VERSION_CACHE, latest_version_channel: BREW })
    expect(cachedVersionFor(stampOnly, BREW)).toBeNull()

    const versionOnly = read(fileOf(JSON.stringify({ latest_version: '0.23.0' })))
    expect(versionOnly).toEqual({ ...EMPTY_VERSION_CACHE, latest_version: '0.23.0' })
    expect(cachedVersionFor(versionOnly, NPM)).toBeNull()
  })

  it('reads every valid non-object JSON document as empty defaults', () => {
    // #24's table, re-run because the shape has a fourth field now: a file that parses to a
    // non-object must produce the SAME four nulls, not a three-field object some later
    // `toEqual` compares against.
    for (const raw of ['[1,2]', '"npm"', 'null', '42', 'true', '[]', '{}']) {
      expect(read(fileOf(raw)), raw).toEqual(EMPTY_VERSION_CACHE)
    }
  })

  it('reads a torn write — a file cut off mid-field — as empty defaults', () => {
    // What a crash between `writeFileSync`'s first and last byte leaves behind. The read fails
    // CLOSED: an unparseable file is not a file whose visible half can be believed.
    const torn = '{"latest_version":"0.27.0","latest_version_ch'
    expect(read(fileOf(torn))).toEqual(EMPTY_VERSION_CACHE)
    expect(cachedVersionFor(read(fileOf(torn)), BREW)).toBeNull()
  })

  it('reads a UTF-8 BOM as empty defaults rather than half a cache', () => {
    // A file an editor saved with a BOM does not parse, and the fallback is the same total one.
    const bom = String.fromCharCode(0xfeff)
    expect(read(fileOf(`${bom}{"latest_version":"1.0.0","latest_version_channel":"npm"}`)))
      .toEqual(EMPTY_VERSION_CACHE)
  })

  it('takes the LAST of two duplicate channel keys, as JSON.parse defines it', () => {
    // A hand-merged file can carry the key twice. Measured rather than assumed, because the
    // answer decides which channel is believed and the two halves of a merge conflict disagree.
    const cache = read(
      fileOf('{"latest_version_channel":"brew","latest_version_channel":"npm","latest_version":"1.0.0"}'),
    )
    expect(cache.latest_version_channel).toBe(NPM)
    expect(cachedVersionFor(cache, BREW)).toBeNull()
  })

  it('stays total for an fs seam that answers something other than a string', () => {
    // The `fs` argument is a seam, so `readFileSync` is not bound by node's contract. Each of
    // these ends in empty defaults rather than a TypeError out of `.toString()` or JSON.parse.
    const ok = '{"latest_version":"1.0.0","latest_version_channel":"npm"}'
    const seams = [
      ['throws', () => { throw new Error('EACCES') }],
      ['returns a number', () => 42],
      ['returns null', () => null],
      ['returns undefined', () => undefined],
      ['returns an array', () => []],
    ]
    for (const [label, readFileSync] of seams) {
      expect(() => readVersionCache({ fs: { readFileSync }, home: HOME, processEnv: {} }), label)
        .not.toThrow()
      expect(readVersionCache({ fs: { readFileSync }, home: HOME, processEnv: {} }), label)
        .toEqual(EMPTY_VERSION_CACHE)
    }
    // ...while the two seams that answer something string-LIKE are read, which is what keeps
    // the `.toString()` in the reader honest rather than decorative.
    for (const readFileSync of [() => Buffer.from(ok), () => ({ toString: () => ok })]) {
      expect(readVersionCache({ fs: { readFileSync }, home: HOME, processEnv: {} }))
        .toMatchObject({ latest_version: '1.0.0', latest_version_channel: NPM })
    }
  })

  it('is NOT total for a hostile home, which is why its callers guard the call', () => {
    // Pinned as a boundary rather than as a wart: `versionCachePath()` runs in a default
    // parameter, ahead of the reader's own try blocks, so a non-string home throws out of
    // `join`. Both commands that read this cache wrap the call for exactly this reason
    // (update-check.js:271-281, doctor.js/start.js's `cachedLatestVersion`), and a future
    // reader that forgets to has a live crash rather than a missing row.
    for (const home of [null, 42, {}, []]) {
      expect(() => readVersionCache({ fs: vol(), home, processEnv: {} }), JSON.stringify(home))
        .toThrow()
    }
  })
})

describe('QA #215 the pair survives the file, and the file keeps its fixed shape', () => {
  it('writes exactly four keys, in order, and drops everything else', () => {
    // #24's fixed-shape promise, re-measured with the new field in it. The MAP ALTERNATIVE is
    // in the drop list on purpose: if a later slice reverses lib/version-cache.js:28-53 and
    // writes `latest_version_by_channel`, this is the test that says the two designs are not
    // silently coexisting in one file.
    const fs = vol()
    write(
      {
        last_check_at: '2026-09-09T17:13:35.685Z',
        last_prompted_at: null,
        latest_version: '0.27.0',
        latest_version_channel: BREW,
        latest_version_by_channel: { npm: '0.23.0', brew: '0.27.0' },
        declined_version: '0.26.0',
        channel: 'Homebrew (`Cellar/ralph`)',
      },
      fs,
    )
    const raw = JSON.parse(rawOf(fs))
    expect(Object.keys(raw)).toEqual([
      'last_check_at',
      'last_prompted_at',
      'latest_version',
      'latest_version_channel',
    ])
    expect(raw.latest_version_channel).toBe(BREW)
  })

  it('does not pollute Object.prototype through a `__proto__` key on the way out', () => {
    const fs = vol()
    write(JSON.parse('{"__proto__":{"polluted":1},"latest_version":"1.0.0","latest_version_channel":"npm"}'), fs)
    expect(rawOf(fs)).not.toContain('__proto__')
    expect({}.polluted).toBeUndefined()
    expect(read(fs)).toMatchObject({ latest_version: '1.0.0', latest_version_channel: NPM })
  })

  it('never lands a version on disk without its owner, over the whole hostile table', () => {
    // THE INVARIANT, asserted as one: after any write of any garbage, the file holds either a
    // stamped pair, or an unowned number, or nothing — never a number attributed to a channel
    // the writer did not name. Every cell is written and then READ BACK, because the property
    // has to hold across JSON and not only in memory.
    const CHANNELS = [undefined, null, '', '  ', 42, {}, [], NPM, BREW, ' brew ']
    const VERSIONS = [undefined, null, '', '   ', 42, {}, '0.27.0', ' 0.27.0 ']
    for (const channel of CHANNELS) {
      for (const version of VERSIONS) {
        const fs = vol()
        write(withLatestVersion({ ...EMPTY_VERSION_CACHE }, { version, channel }), fs)
        const back = read(fs)
        const label = JSON.stringify([version, channel])
        if (back.latest_version_channel !== null) {
          // A stamp exists, so a version must exist beside it and the pair must be readable by
          // exactly that channel.
          expect(back.latest_version, label).not.toBeNull()
          expect(cachedVersionFor(back, back.latest_version_channel), label)
            .toBe(back.latest_version)
        }
        // ...and whatever landed, no OTHER channel can read it.
        for (const other of [NPM, BREW]) {
          if (other === back.latest_version_channel) continue
          expect(cachedVersionFor(back, other), `${label} as ${other}`).toBeNull()
        }
      }
    }
  })

  it('round-trips both channels through the same path without either leaking', () => {
    // One file, written twice — which is what a two-copy machine does. The stamp design keeps
    // ONE channel's number at a time, so the second write REPLACES the first; what must never
    // happen is the first channel's number surviving under the second's name.
    const fs = vol()
    write(withLatestVersion({ ...EMPTY_VERSION_CACHE }, { version: '0.23.0', channel: NPM }), fs)
    expect(cachedVersionFor(read(fs), NPM)).toBe('0.23.0')
    write(withLatestVersion(read(fs), { version: '0.27.0', channel: BREW }), fs)
    const after = read(fs)
    expect(after).toMatchObject({ latest_version: '0.27.0', latest_version_channel: BREW })
    expect(cachedVersionFor(after, NPM)).toBeNull()
    expect(cachedVersionFor(after, BREW)).toBe('0.27.0')
  })

  it('shows nothing to a reader that arrives between the mkdir and the write', () => {
    // The one interleaving a single-file cache really has: `writeVersionCache` creates the
    // directory and then writes, so a copy that reads in between finds no file at all. It must
    // read as "nobody has checked", never as a half-written pair — which it does, because the
    // reader's own missing-file path is the one that fires.
    const disk = vol()
    const midWrite = []
    const fs = {
      mkdirSync: (...args) => disk.mkdirSync(...args),
      readFileSync: (...args) => disk.readFileSync(...args),
      writeFileSync: (...args) => {
        midWrite.push(read(disk))
        return disk.writeFileSync(...args)
      },
    }
    writeVersionCache({
      cache: withLatestVersion({ ...EMPTY_VERSION_CACHE }, { version: '0.27.0', channel: BREW }),
      fs,
      home: HOME,
      processEnv: {},
    })
    expect(midWrite).toEqual([EMPTY_VERSION_CACHE])
    expect(cachedVersionFor(midWrite[0], BREW)).toBeNull()
    expect(cachedVersionFor(read(disk), BREW)).toBe('0.27.0')
  })

  it('leaves a stale in-memory cache unable to resurrect the channel it replaced', () => {
    // The lost-update shape: copy A reads, copy B writes its own pair, copy A writes back from
    // the cache it read a minute ago. A's write wins the file — that is a lost REFRESH and the
    // documented cost of one global file (lib/version-cache.js:56-67) — but the number and the
    // stamp move together, so what lands is A's own consistent pair and never B's number under
    // A's name.
    const fs = vol()
    write(withLatestVersion({ ...EMPTY_VERSION_CACHE }, { version: '0.23.0', channel: NPM }), fs)
    const staleInA = read(fs)
    write(withLatestVersion(read(fs), { version: '0.27.0', channel: BREW }), fs)
    write(withLatestVersion(staleInA, { version: '0.23.1', channel: NPM }), fs)
    expect(read(fs)).toMatchObject({ latest_version: '0.23.1', latest_version_channel: NPM })
    expect(cachedVersionFor(read(fs), BREW)).toBeNull()
  })
})

describe('QA #215 the two compatibility directions across the field', () => {
  it('lets a pre-#215 reader see a bare, valid version and nothing it cannot parse', () => {
    // FORWARD compatibility, as far as it can go: an older copy reads `latest_version` and has
    // no idea the fourth key exists, so it sees the last writer's number whatever this slice
    // does. What it must never see is a number it cannot parse — a `0.27.0 (brew)`, or an
    // object — because its own semver check is the only thing standing between it and a notice
    // for a version that does not exist.
    const fs = vol()
    write(withLatestVersion({ ...EMPTY_VERSION_CACHE }, { version: '0.27.0', channel: BREW }), fs)
    const asOldCodeReadsIt = JSON.parse(rawOf(fs)).latest_version
    expect(typeof asOldCodeReadsIt).toBe('string')
    expect(asOldCodeReadsIt).toBe('0.27.0')
  })

  it('reads a file an older Ralph left, and repairs it into the four-key shape on the next write', () => {
    // BACKWARD compatibility. The three-key file is the file #215 was observed in: readable,
    // unowned, and re-shaped the first time anything writes — with the number kept, because the
    // run that resolves a new one is the only run allowed to attribute it.
    const fs = fileOf(
      JSON.stringify({
        last_check_at: '2026-09-09T17:13:35.685Z',
        last_prompted_at: null,
        latest_version: '0.23.0',
      }),
    )
    const legacy = read(fs)
    expect(legacy.latest_version_channel).toBeNull()
    write(legacy, fs)
    expect(Object.keys(JSON.parse(rawOf(fs)))).toContain('latest_version_channel')
    expect(read(fs).latest_version).toBe('0.23.0')
    expect(cachedVersionFor(read(fs), NPM)).toBeNull()
  })

  it('reads a file from a FUTURE Ralph that also carries a channel map, ignoring the map', () => {
    // The forward direction of the design argued down at lib/version-cache.js:28-53. If a later
    // slice does add a map, this copy must read the stamp it understands and ignore the key it
    // does not — rather than crashing, or finding a version in the map and believing it.
    const fs = fileOf(
      JSON.stringify({
        last_check_at: '2026-09-09T17:13:35.685Z',
        latest_version: '0.27.0',
        latest_version_channel: BREW,
        latest_version_by_channel: { npm: '0.23.0', brew: '0.27.0' },
      }),
    )
    const cache = read(fs)
    expect(cache).toEqual({
      last_check_at: '2026-09-09T17:13:35.685Z',
      last_prompted_at: null,
      latest_version: '0.27.0',
      latest_version_channel: BREW,
    })
    expect(cachedVersionFor(cache, NPM)).toBeNull()
    expect(cachedVersionFor(cache, BREW)).toBe('0.27.0')
  })
})
