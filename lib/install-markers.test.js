import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import {
  HOMEBREW_FORMULA,
  INSTALL_MARKERS,
  NPX_CACHE_MARKER,
  describeInstallChannel,
  hasMarker,
  linkSignal,
  matchingStores,
  normalizePath,
  pathSegments,
} from './install-markers.js'
import { classifyInstall } from './install-target.js'
import { codeWithoutComments } from '../test/helpers/source-code.js'
// The frame half's two numbers, imported rather than spelled: the channel wording is drawn
// into a row of `ralph doctor`'s identity box, and a string that does not fit is a string the
// box clips with an ellipsis — which for the one row whose whole job is to answer "how did you
// install it?" would mean answering it halfway.
import { BANNER_WIDTH, LABEL_WIDTH } from './banner-compose.js'

// #201 — the PURE half of install-layout recognition, and the reason it is a file of its own.
//
// lib/install-target.js answers "how is this copy updated?", and to do it it spawns: `npm root
// -g` is the only thing that can identify a plain global npm install, so that module imports a
// process runner at module scope. lib/commands/doctor.version-line.qa.test.js walks doctor's
// whole transitive import graph and asserts the diagnostic can reach no spawner and no socket —
// doctor is the command people run when the machine is already broken and possibly offline —
// so `ralph doctor` may not import install-target.js, not even for a fact it could get by
// matching path segments.
//
// The install channel is exactly such a fact for every layout but one. A Homebrew Cellar, an npx
// cache, the three npm-shaped global stores and a linked checkout are all decidable from the
// package root's own path plus two `lstat`-shaped probes, with nothing spawned. So the matching
// core lives here, importing `node:path` and nothing else, and BOTH consumers read it:
// install-target.js decorates these rows with the update commands, and doctor.js asks
// `describeInstallChannel` for a sentence.
//
// WHAT THIS FILE MAY NOT BECOME is the other half of the point. The moment it imports a
// spawner, doctor's import-graph spec goes red — which is the guard, stated as a test rather
// than as a convention. That is also why `linkSignal` takes its `fs` as an argument and this
// module holds no real-filesystem default: the default (`existsSync`/`lstatSync` bound to the
// real fs) belongs to whichever caller has already decided it is allowed to touch a disk.
//
// THE HEDGE IS THE INTERESTING CASE, and it is asserted here as wording rather than as a
// classification. Marker matching can POSITIVELY identify Homebrew, npx, the three npm-shaped
// global stores and a link; it cannot identify a plain `npm install -g`, because what decides
// that is `npm root -g`. So the answer for every unmatched path says `not probed` out loud. A
// reader of a pasted doctor dump has to be able to tell a determination from a default, and a
// row that said `npm` for a path nothing recognized would be this module inventing the single
// most load-bearing fact on a bug report.
//
// Hermetic (#41): every path is a literal, every filesystem is memfs, and nothing here reads
// RALPH_HOME — which in a vitest worker is this checkout, whose own answer is `linked`.

const HOME = '/Users/me'
const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'
const NPX_RALPH = `${HOME}/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph`
const CHECKOUT = `${HOME}/repos/ralph`

// The value column at the box's design width: the frame is `│ ` + an eight-column label
// gutter + the value + ` │`, so a wording longer than this is one the box clips.
const VALUE_WIDTH = BANNER_WIDTH - LABEL_WIDTH - 4

const emptyFs = () => Volume.fromJSON({})
const gitFs = (root = CHECKOUT) =>
  Volume.fromJSON({ [`${root}/.git/HEAD`]: 'ref: refs/heads/main\n' })

// A package root that IS a symlink — the layout a `npm link` or a store that links out of a
// content-addressable cache leaves behind. Built the way lib/install-target.channel.test.js
// builds it, so both suites are describing the same filesystem.
function fsWithSymlink(packageRoot, target = CHECKOUT) {
  const vol = Volume.fromJSON({ [`${target}/package.json`]: '{}' })
  vol.mkdirSync(packageRoot.slice(0, packageRoot.lastIndexOf('/')), { recursive: true })
  vol.symlinkSync(target, packageRoot)
  return vol
}

const channelAt = (ralphHome, fs = emptyFs()) => describeInstallChannel({ ralphHome, fs })

// One path per store row, built FROM the row's own markers rather than written out beside it:
// a marker edited without a fixture to match would otherwise keep passing against a path that
// no longer describes anything.
const pathForMarker = (marker) => `/x/${marker.join('/')}/node_modules/@lucasfe/ralph`

describe('INSTALL_MARKERS — the store table, and the order it is read in (#201)', () => {
  it('lists the four stores in the order the ambiguity message names them', () => {
    // The order is load-bearing: lib/install-target.js reports a path matching two managers as
    // `matches more than one package manager (pnpm, yarn, bun, brew)`, and that sentence is
    // this list read left to right. install-target.qa.test.js pins those bytes.
    expect(INSTALL_MARKERS.map((row) => row.store)).toEqual(['pnpm', 'yarn', 'bun', 'brew'])
  })

  it('gives every row a channel wording that names the manager it recognized', () => {
    for (const row of INSTALL_MARKERS) {
      expect(typeof row.channel, row.store).toBe('string')
      expect(row.channel.trim(), row.store).toBe(row.channel)
      // `brew` is inside `Homebrew`, which is the name Homebrew calls itself — the row is
      // allowed to be better-worded than its key, not to be about something else.
      expect(row.channel.toLowerCase(), row.store).toContain(row.store)
    }
  })

  it('gives every row at least one whole-segment marker, and no empty one', () => {
    for (const row of INSTALL_MARKERS) {
      expect(Array.isArray(row.markers), row.store).toBe(true)
      expect(row.markers.length, row.store).toBeGreaterThan(0)
      for (const marker of row.markers) {
        expect(marker.length, row.store).toBeGreaterThan(0)
        for (const segment of marker) expect(typeof segment, row.store).toBe('string')
      }
    }
  })

  it('spells the Homebrew formula once, and builds the Cellar marker out of it', () => {
    // #198's invariant, inherited: a marker matching a formula the argv does not upgrade would
    // answer `brew upgrade` for somebody else's Cellar.
    expect(HOMEBREW_FORMULA).toBe('ralph')
    const brew = INSTALL_MARKERS.find((row) => row.store === 'brew')
    expect(brew.markers).toEqual([['Cellar', HOMEBREW_FORMULA]])
    expect(brew.channel).toContain(HOMEBREW_FORMULA)
  })

  it('hands the table out FROZEN, since `matchingStores` hands out the rows themselves', () => {
    // Two consumers read this table in one process — `ralph update`'s decision and a
    // diagnostic — and the matcher returns the row objects rather than copies of them, so a
    // caller that mutated one would change what the other recognizes. Same reason
    // NPM_VERSION_QUERY is frozen in lib/update-check.js.
    expect(Object.isFrozen(INSTALL_MARKERS)).toBe(true)
    expect(Object.isFrozen(NPX_CACHE_MARKER)).toBe(true)
    for (const row of INSTALL_MARKERS) {
      expect(Object.isFrozen(row), row.store).toBe(true)
      expect(Object.isFrozen(row.markers), row.store).toBe(true)
      for (const marker of row.markers) expect(Object.isFrozen(marker), row.store).toBe(true)
    }
  })

  it('keeps the npx cache marker separate from the stores — it is not one', () => {
    // npx is a layout with nothing to update rather than a manager with a global directory,
    // so it is not a row: a row carries a command, and this one must not.
    expect(NPX_CACHE_MARKER).toEqual(['_npx'])
    expect(INSTALL_MARKERS.map((row) => row.store)).not.toContain('npx')
  })
})

describe('hasMarker — whole segments, adjacent (#201)', () => {
  it('matches a marker whose segments are adjacent anywhere in the path', () => {
    expect(hasMarker(['Users', 'me', 'Library', 'pnpm', 'global', '5'], ['pnpm', 'global'])).toBe(true)
    expect(hasMarker(['opt', 'homebrew', 'Cellar', 'ralph', '0.16.0'], ['Cellar', 'ralph'])).toBe(true)
  })

  it('refuses a partial segment and a non-adjacent pair', () => {
    // The two failures that matter: `/x/pnpm-old/global/...` is not a pnpm store, and
    // `/x/pnpm/tools/global/...` is not one either.
    expect(hasMarker(['x', 'pnpm-old', 'global'], ['pnpm', 'global'])).toBe(false)
    expect(hasMarker(['x', 'pnpm', 'tools', 'global'], ['pnpm', 'global'])).toBe(false)
    expect(hasMarker(['x', 'Cellar', 'ralphie', '1.0.0'], ['Cellar', 'ralph'])).toBe(false)
  })

  it('answers false rather than throwing for a path shorter than the marker', () => {
    expect(hasMarker([], ['pnpm', 'global'])).toBe(false)
    expect(hasMarker(['pnpm'], ['pnpm', 'global'])).toBe(false)
  })
})

describe('normalizePath / pathSegments — the two path primitives (#201)', () => {
  it('resolves a usable path and answers null for a blank one', () => {
    // A blank path must never resolve to the cwd: a cwd that happens to sit under a global
    // store would classify some unrelated directory as this install.
    expect(normalizePath('/opt/ralph/')).toBe('/opt/ralph')
    for (const blank of ['', '   ', null, undefined]) {
      expect(normalizePath(blank), JSON.stringify(blank)).toBeNull()
    }
  })

  it('splits a path into whole segments, dropping the empties', () => {
    expect(pathSegments('/Users/me//repos/ralph/')).toEqual(['Users', 'me', 'repos', 'ralph'])
    expect(pathSegments('/')).toEqual([])
  })
})

describe('matchingStores — which rows a path sits inside (#201)', () => {
  it('matches exactly the row whose directory the path is in', () => {
    for (const row of INSTALL_MARKERS) {
      for (const marker of row.markers) {
        const matched = matchingStores(pathSegments(pathForMarker(marker)))
        expect(matched.map((hit) => hit.store), marker.join('/')).toEqual([row.store])
      }
    }
  })

  it('matches nothing for a path no store owns', () => {
    expect(matchingStores(pathSegments(GLOBAL_RALPH))).toEqual([])
    expect(matchingStores(pathSegments('/opt/hand-built/ralph'))).toEqual([])
  })

  it('reports BOTH rows for a path two managers claim, rather than picking one', () => {
    const both = `${HOME}/.config/yarn/global/node_modules/pnpm/global/node_modules/@lucasfe/ralph`
    expect(matchingStores(pathSegments(both)).map((hit) => hit.store)).toEqual(['pnpm', 'yarn'])
  })

  it('reads the table it is HANDED, which is what lets install-target decorate the rows', () => {
    // The seam that keeps one matcher: lib/install-target.js adds a `kind`, an `argv` and a
    // version query to each row and then matches on its own decorated table. A matcher that
    // closed over INSTALL_MARKERS would force that module to duplicate the filter.
    const decorated = INSTALL_MARKERS.map((row) => ({ ...row, argv: ['fake', row.store] }))
    const matched = matchingStores(pathSegments(BREW_RALPH), decorated)
    expect(matched).toHaveLength(1)
    expect(matched[0].argv).toEqual(['fake', 'brew'])
  })
})

describe('linkSignal — the two probes, and neither of them spawns (#201)', () => {
  it('calls a `.git` entry a dev checkout', () => {
    expect(linkSignal(gitFs(), CHECKOUT)).toEqual({
      reason: 'contains a .git entry (dev checkout)',
      checkout: true,
    })
  })

  it('calls a symlinked package root a linked install, not a checkout', () => {
    const signal = linkSignal(fsWithSymlink(GLOBAL_RALPH), GLOBAL_RALPH)
    expect(signal).toEqual({ reason: 'is a symlink to another location', checkout: false })
  })

  it('answers null for a plain directory', () => {
    expect(linkSignal(emptyFs(), GLOBAL_RALPH)).toBeNull()
  })

  it('answers no rather than throwing for an fs it cannot use', () => {
    // A probe that cannot answer answers "no". The callers are a diagnostic and a background
    // notice, and neither may crash over the shape of an injected seam.
    for (const fs of [undefined, null, {}, 42, 'fs', { existsSync: () => { throw new Error('x') } }]) {
      expect(() => linkSignal(fs, CHECKOUT), JSON.stringify(fs)).not.toThrow()
      expect(linkSignal(fs, CHECKOUT), JSON.stringify(fs)).toBeNull()
    }
  })
})

describe('describeInstallChannel — the row `ralph doctor` draws (#201)', () => {
  it('positively names Homebrew for a Cellar path', () => {
    // The layout the whole row exists for: npm and the tap hold different versions (#196), so
    // "how did you install it?" is the first question on every bug report about a version.
    expect(channelAt(BREW_RALPH)).toBe('Homebrew (`Cellar/ralph`)')
  })

  it('names each npm-shaped global store by the manager whose directory it is', () => {
    expect(channelAt(`${HOME}/Library/pnpm/global/5/node_modules/@lucasfe/ralph`)).toBe(
      'pnpm (global store)',
    )
    expect(channelAt(`${HOME}/.config/yarn/global/node_modules/@lucasfe/ralph`)).toBe(
      'yarn (global store)',
    )
    expect(channelAt(`${HOME}/.bun/install/global/node_modules/@lucasfe/ralph`)).toBe(
      'bun (global store)',
    )
  })

  it('names an npx cache as such', () => {
    expect(channelAt(NPX_RALPH)).toBe('npx (`_npx` cache)')
  })

  it('tells a dev checkout apart from a linked install', () => {
    expect(channelAt(CHECKOUT, gitFs())).toBe('linked (dev checkout)')
    expect(channelAt(GLOBAL_RALPH, fsWithSymlink(GLOBAL_RALPH))).toBe('linked (symlinked install)')
  })

  it('HEDGES for a plain global npm install rather than claiming npm', () => {
    // The criterion this module was cut out for. `npm root -g` is what decides this layout and
    // doctor is architecturally forbidden to spawn it, so the row says what it knows: npm is
    // the likely answer, and nobody checked. `npm` alone would read as a determination.
    const answer = channelAt(GLOBAL_RALPH)
    expect(answer).toBe('npm or other (not probed)')
    expect(answer).not.toBe('npm')
    expect(answer).toMatch(/not probed/)
  })

  it('gives an unrecognized path the same hedge, for the same reason', () => {
    expect(channelAt('/opt/hand-built/ralph')).toBe('npm or other (not probed)')
  })

  it('says which managers a path matched when more than one claims it', () => {
    // Not the hedge: something WAS recognized here, and reporting it as "not probed" would
    // hide the one detail a reader of the paste could act on.
    const both = `${HOME}/.config/yarn/global/node_modules/pnpm/global/node_modules/@lucasfe/ralph`
    expect(channelAt(both)).toBe('ambiguous (matches pnpm, yarn)')
  })

  it('answers NOTHING when it was given no install directory', () => {
    // The caller that passed no path did not ask the question, and a fabricated channel is the
    // worst possible answer on a bug report. doctor draws no row at all for this.
    for (const blank of [undefined, null, '', '    ']) {
      expect(describeInstallChannel({ ralphHome: blank }), JSON.stringify(blank)).toBeNull()
    }
    expect(describeInstallChannel()).toBeNull()
    expect(describeInstallChannel({})).toBeNull()
  })

  it('puts a refusal ahead of a store, exactly as `classifyInstall` does', () => {
    // A contributor's checkout linked into a store is a checkout first. The two answers must
    // agree about precedence, or `ralph doctor` names a channel `ralph update` then refuses.
    const inStore = `${HOME}/Library/pnpm/global/5/node_modules/@lucasfe/ralph`
    expect(channelAt(inStore, gitFs(inStore))).toBe('linked (dev checkout)')
    const npxCheckout = gitFs(NPX_RALPH)
    expect(channelAt(NPX_RALPH, npxCheckout)).toBe('linked (dev checkout)')
  })

  it('puts npx ahead of a store too', () => {
    expect(channelAt(`${HOME}/.npm/_npx/abc/node_modules/pnpm/global/x`)).toBe('npx (`_npx` cache)')
  })

  it('reads the filesystem at most twice and never spawns anything', () => {
    // The whole cost of the row: two `lstat`-shaped probes on the package root. Counted,
    // because a row that grew a `npm root -g` probe is a row that breaks doctor's guarantee.
    const calls = []
    const fs = {
      existsSync: (p) => {
        calls.push(`exists ${p}`)
        return false
      },
      lstatSync: (p) => {
        calls.push(`lstat ${p}`)
        return { isSymbolicLink: () => false }
      },
    }
    expect(describeInstallChannel({ ralphHome: BREW_RALPH, fs })).toBe('Homebrew (`Cellar/ralph`)')
    expect(calls).toHaveLength(2)
  })

  it('never throws, whatever it is handed', () => {
    for (const bag of [{ ralphHome: 7 }, { ralphHome: {} }, { ralphHome: [] }, { fs: 42 }]) {
      expect(() => describeInstallChannel(bag), JSON.stringify(bag)).not.toThrow()
    }
  })

  it('fits the row it is drawn in, for every answer it can give', () => {
    const answers = [
      ...INSTALL_MARKERS.map((row) => row.channel),
      channelAt(NPX_RALPH),
      channelAt(CHECKOUT, gitFs()),
      channelAt(GLOBAL_RALPH, fsWithSymlink(GLOBAL_RALPH)),
      channelAt(GLOBAL_RALPH),
      // Every store at once, which is the longest the ambiguity wording can get.
      channelAt('/x/pnpm/global/yarn/global/bun/install/global/Cellar/ralph/x'),
    ]
    for (const answer of answers) {
      expect(typeof answer, String(answer)).toBe('string')
      expect([...answer].length, answer).toBeLessThanOrEqual(VALUE_WIDTH)
    }
  })
})

describe('the two halves cannot drift apart (#201)', () => {
  it("answers with the row's own channel for every marker it lists, not just the first", () => {
    // HALF THE JOIN, and only half — said plainly because the name this test used to carry
    // promised the whole of it. What is asserted here is the marker-to-wording half: every marker
    // in the table, including the second on the rows that have two, resolves through
    // `describeInstallChannel` to that row's own `channel`. So a marker widened without its wording
    // following it fails here. `classifyInstall` is never called, which means this test cannot see
    // a row that has no STORE_UPDATES entry on the other side.
    //
    // THE JOIN ITSELF — a marker row with no update command over there classifies as a store with
    // an `undefined` argv, which is a crash in `ralph update` rather than a red test — is held by
    // the next test in this file ("agrees with `classifyInstall` about every layout, wording
    // aside", which compares `target.argv[0]` for one marker per row) and, per MARKER and field by
    // field, by lib/install-markers.qa.test.js:358-376.
    for (const row of INSTALL_MARKERS) {
      for (const marker of row.markers) {
        const ralphHome = pathForMarker(marker)
        expect(channelAt(ralphHome), marker.join('/')).toBe(row.channel)
      }
    }
  })

  it('agrees with `classifyInstall` about every layout, wording aside', async () => {
    const fs = emptyFs()
    for (const row of INSTALL_MARKERS) {
      const ralphHome = pathForMarker(row.markers[0])
      const target = await classifyInstall({ ralphHome, exec: null, fs })
      expect(target.argv?.[0], row.store).toBe(row.store)
      expect(describeInstallChannel({ ralphHome, fs }), row.store).toBe(row.channel)
    }
  })

  it('has install-target READ this table rather than hold a second copy of it', () => {
    // Source-level, because the duplication this forbids would pass every behavioural test in
    // both suites right up to the day the two copies disagreed.
    const code = codeWithoutComments(new URL('./install-target.js', import.meta.url))
    expect(code).toMatch(/from '\.\/install-markers\.js'/)
    // `'global'` is deliberately NOT in this list: it survives over there as a word in yarn's
    // argv (`yarn global add …`), which is a command rather than a marker.
    for (const gone of ["'_npx'", "'Cellar'", 'function hasMarker(', 'function linkSignal(']) {
      expect(code, gone).not.toContain(gone)
    }
  })

  it('imports nothing here but `node:path`, which is what keeps doctor offline', () => {
    // The acceptance criterion of the extraction, stated where the import would be written.
    // The full version is lib/commands/doctor.version-line.qa.test.js's import-graph walk,
    // which fails on the same edit from doctor's side.
    const code = codeWithoutComments(new URL('./install-markers.js', import.meta.url))
    expect([...code.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1])).toEqual(['node:path'])
    expect(code).not.toMatch(/\bexeca\b/)
    expect(code).not.toMatch(/child_process/)
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/node:(fs|http|https|net)/)
  })
})
