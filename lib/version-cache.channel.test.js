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

// #215: ONE cache file, TWO channels — and a number that is only ever served back to the
// channel that produced it.
//
// The bug this file pins shut, observed on 2026-09-13 on a machine carrying two copies of
// Ralph (nvm/npm at 0.25.4 and a fresh Homebrew 0.26.0): the brew copy's `ralph doctor`
// reported `cached 0.23.0`, a number only npm's channel could have produced — it is the last
// version npm accepted before the 403 of #196 and has been npm's `latest` ever since, while
// six tags shipped past it. The cache was one global file with one un-keyed field, so
// whichever copy ran first inside the weekly window wrote the number every other copy then
// read.
//
// The harmless direction is the one that was observed; the harmful one is the same field read
// the other way, and it is what #200 exists to prevent: the brew copy resolves 0.27.0 from the
// tap, the npm copy reads it out of the shared field, compares it against its own 0.25.4 and
// nags — with npm's advice, because #200 correctly takes the advice from the reading copy's own
// layout. The user then runs `npm i -g @lucasfe/ralph@latest` and gets 0.23.0, because that is
// what npm will serve. #199 and #200 each do the right thing per copy; the shared field
// reintroduced the mismatch one layer below them.
//
// WHAT THIS FILE OWNS is the FILE's half of the fix — the fourth field, the pair rule and the
// two accessors. Which channel a running copy IS, and how the number gets filed under it, is
// lib/update-check.cache-channel.test.js; the diagnostic that reported the wrong number is
// lib/commands/doctor.cached-channel.test.js.

const HOME = '/home/me'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')

const NPM = 'npm'
const BREW = 'brew'

function vol(seed = {}) {
  return Volume.fromJSON(seed, '/')
}

const read = (fs) => readVersionCache({ fs, home: HOME, processEnv: {} })
const write = (cache, fs) => writeVersionCache({ cache, fs, home: HOME, processEnv: {} })

describe('the cache field that says WHICH channel resolved the version (#215)', () => {
  it('is part of the empty shape, so an untouched cache attributes nothing', () => {
    expect(EMPTY_VERSION_CACHE.latest_version_channel).toBeNull()
    expect(read(vol())).toEqual(EMPTY_VERSION_CACHE)
  })

  it('round-trips the version and its channel as one pair', () => {
    const fs = vol()
    write(withLatestVersion(EMPTY_VERSION_CACHE, { version: '0.27.0', channel: BREW }), fs)
    expect(read(fs)).toMatchObject({
      latest_version: '0.27.0',
      latest_version_channel: BREW,
    })
  })

  it('survives the write as a field of its own, not as a decoration on the version', () => {
    // The value on disk is still the bare version string every consumer since #24 has read,
    // so nothing has to parse a channel out of a version.
    const fs = vol()
    write({ latest_version: '0.27.0', latest_version_channel: BREW }, fs)
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
    expect(raw.latest_version).toBe('0.27.0')
    expect(raw.latest_version_channel).toBe(BREW)
  })

  it('normalizes the channel exactly as it normalizes every other field', () => {
    // #24's rule, unchanged: only a non-blank string survives, trimmed. A hand-edited number
    // or object becomes null, which reads as "unattributed" rather than as a channel whose
    // name happens to be `[object Object]`.
    const fs = vol({
      [CACHE_PATH]: JSON.stringify({
        latest_version: '0.27.0',
        latest_version_channel: '  brew  ',
      }),
    })
    expect(read(fs).latest_version_channel).toBe(BREW)
    for (const bogus of [42, { name: 'brew' }, ['brew'], true, '   ', null]) {
      const v = vol({
        [CACHE_PATH]: JSON.stringify({ latest_version: '0.27.0', latest_version_channel: bogus }),
      })
      expect(read(v).latest_version_channel, JSON.stringify(bogus)).toBeNull()
    }
  })
})

describe('cachedVersionFor — a version is served to ONE channel (#215)', () => {
  it('answers the channel that wrote it and nothing else', () => {
    const cache = { latest_version: '0.27.0', latest_version_channel: BREW }
    expect(cachedVersionFor(cache, BREW)).toBe('0.27.0')
    expect(cachedVersionFor(cache, NPM)).toBeNull()
  })

  it('is the whole regression, over one file: brew writes, npm reads nothing', () => {
    // Two channels, one cache file, as a two-install machine really has it. The npm copy
    // must not be able to see the tap's number at all — this is the read that nagged a user
    // towards a version npm cannot serve.
    const fs = vol()
    write(withLatestVersion(EMPTY_VERSION_CACHE, { version: '0.27.0', channel: BREW }), fs)
    const shared = read(fs)
    expect(cachedVersionFor(shared, BREW)).toBe('0.27.0')
    expect(cachedVersionFor(shared, NPM)).toBeNull()
  })

  it('does not attribute a LEGACY file — a bare version with no channel — to its reader', () => {
    // The file the bug was observed in, byte for byte. Every copy on that machine must read
    // it as "nobody has checked yet": the field could have been written by either channel
    // (a 0.26.0 brew copy has #199/#200 and wrote the TAP's number into it), so believing it
    // is a coin flip between a harmless answer and the exact nag this issue exists to stop.
    const fs = vol({
      [CACHE_PATH]: JSON.stringify({
        last_check_at: '2026-09-09T17:13:35.685Z',
        last_prompted_at: null,
        latest_version: '0.23.0',
      }),
    })
    const legacy = read(fs)
    // Total, as it has always been for a file it cannot use: the value is READ, it is just
    // not attributed.
    expect(legacy.latest_version).toBe('0.23.0')
    expect(legacy.latest_version_channel).toBeNull()
    expect(cachedVersionFor(legacy, NPM)).toBeNull()
    expect(cachedVersionFor(legacy, BREW)).toBeNull()
  })

  it('answers nothing to a reader that names no channel', () => {
    // A caller that cannot say which channel it came from has not earned another channel's
    // number. Not "npm by default": npm is a guess, and the whole cost of this issue was a
    // guess that read as a determination.
    const cache = { latest_version: '0.27.0', latest_version_channel: NPM }
    for (const channel of [undefined, null, '', '   ', 42, {}]) {
      expect(cachedVersionFor(cache, channel), JSON.stringify(channel)).toBeNull()
    }
  })

  it('answers nothing for a cache that holds no usable version', () => {
    for (const cache of [
      undefined,
      null,
      {},
      { latest_version: null, latest_version_channel: NPM },
      { latest_version: '   ', latest_version_channel: NPM },
      { latest_version: 42, latest_version_channel: NPM },
    ]) {
      expect(cachedVersionFor(cache, NPM), JSON.stringify(cache)).toBeNull()
    }
  })

  it('trims both sides before comparing, so a hand-edited file still matches', () => {
    expect(cachedVersionFor({ latest_version: ' 0.27.0 ', latest_version_channel: ' brew ' }, BREW))
      .toBe('0.27.0')
  })
})

describe('withLatestVersion — the version and its channel move together (#215)', () => {
  it('writes both, leaving the two windows untouched', () => {
    const before = {
      last_check_at: '2026-09-09T17:13:35.685Z',
      last_prompted_at: '2026-09-01T00:00:00.000Z',
      latest_version: '0.23.0',
      latest_version_channel: NPM,
    }
    expect(withLatestVersion(before, { version: '0.27.0', channel: BREW })).toEqual({
      last_check_at: '2026-09-09T17:13:35.685Z',
      last_prompted_at: '2026-09-01T00:00:00.000Z',
      latest_version: '0.27.0',
      latest_version_channel: BREW,
    })
  })

  it('never leaves a stamp with no version beside it', () => {
    // An orphan stamp would be a claim about a number that is not there, and the next read
    // would compare against a channel nothing answered.
    for (const version of [null, undefined, '', '   ', 42]) {
      expect(withLatestVersion({ latest_version: '0.23.0', latest_version_channel: NPM }, {
        version,
        channel: BREW,
      })).toMatchObject({ latest_version: null, latest_version_channel: null })
    }
  })

  it('writes an unattributable number as unattributed rather than as the reader’s', () => {
    // A channel that cannot be named is the legacy case created fresh: the number is kept for
    // the record and served to nobody, which is strictly better than filing it under npm — a
    // channel that did not answer.
    const stamped = withLatestVersion(EMPTY_VERSION_CACHE, { version: '0.27.0', channel: null })
    expect(stamped.latest_version).toBe('0.27.0')
    expect(stamped.latest_version_channel).toBeNull()
    expect(cachedVersionFor(stamped, NPM)).toBeNull()
  })

  it('does not mutate the cache it was handed', () => {
    const before = { ...EMPTY_VERSION_CACHE }
    withLatestVersion(before, { version: '0.27.0', channel: BREW })
    expect(before).toEqual(EMPTY_VERSION_CACHE)
    // ...and the frozen empty literal is safe to hand it, which is what every caller does
    // when the cache could not be read.
    expect(() => withLatestVersion(EMPTY_VERSION_CACHE, { version: '0.1.0', channel: NPM })).not.toThrow()
  })
})
