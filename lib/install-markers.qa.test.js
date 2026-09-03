import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
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
import { NPM_VERSION_QUERY } from './update-check.js'
import { codeWithoutComments } from '../test/helpers/source-code.js'

// #201 QA augmentation. The dev's lib/install-markers.test.js proves the table's shape, the
// nine wordings `describeInstallChannel` can give, the two probes' precedence and that the
// module imports `node:path` and nothing else. Every one of those assertions is about the NEW
// module read on its own terms. This file attacks the two things that green cannot see.
//
// 1. THE EXTRACTION, WHICH IS THE ACTUAL RISK IN THIS DIFF. #201 is a +115/−207 restructuring
//    of lib/install-target.js: a table that used to be one array of literals is now
//    `INSTALL_MARKERS.map((row) => ({ ...row, ...STORE_UPDATES.get(row.store) }))`, a join on a
//    string key that did not exist before the change. Every consumer of `classifyInstall` —
//    `ralph update`, lib/update-gate.js's notice, #199's version query — reads a field off the
//    joined row, and the dev's suite checks exactly one of them (`target.argv[0]`). A join that
//    lost `layout`, or `latest`, or reordered the table, would still pass that. So the first
//    section below is a CHARACTERIZATION of the whole returned object across every layout
//    `classifyInstall` can reach, field by field and byte for byte — including the two `reason`
//    sentences that are DERIVED rather than stored (`a <argv[0]> global install directory` and
//    the ambiguity list), which are the two places a broken join surfaces as prose rather than
//    as a crash.
//
//    These goldens were captured by running the PRE-#201 module and the post-#201 module side
//    by side over the same seventeen cases and diffing the JSON: they were identical, exports
//    included. That is what makes them a fidelity spec rather than a snapshot of whatever the
//    code happens to do — they are the bytes the extraction promised not to move.
//
// 2. TOTALITY OF THE SEAMS, which is where the extraction did move something — and where the
//    tests in this file EARNED their keep. `linkSignal` replaced two guarded helpers
//    (`exists`/`isSymlink`, each with the whole expression inside its own try) with one `probe`,
//    and `probe` used to take `(fs, 'lstatSync', home)` — which left the `.isSymbolicLink?.()`
//    read off its RESULT outside the try. The section named for it caught that: a stat-like
//    object whose `isSymbolicLink` throws was a value the old helpers answered "not a link" for
//    and that shape of `probe` escaped from, out of `classifyInstall` and out of `ralph doctor`.
//    `probe` now takes the whole QUESTION as a thunk (lib/install-markers.js:334-340, called at
//    :289, with the argument for that shape at :277-288 and :319-333), so the guard covers
//    whatever the caller wrote rather than whatever the helper remembered to re-guard. The
//    section STAYS because that boundary is re-narrowable by one edit: hand `probe` a method
//    name again and every case below has to go red again.
//
// Plus the corners a table-driven happy path does not reach: near-miss segments (`Cellar` with
// somebody else's formula, `pnpm` without `global`, `_npx` as a substring), the precedence
// MATRIX rather than two of its cells, case and separator sensitivity, `..` collapsing, five
// thousand segments, astral-plane and control-byte segments, and whether the frozen table can
// be poisoned by a caller for every later call in the process.
//
// Hermetic (#41): every path is a literal, every filesystem is memfs or a counting stub, and
// nothing here reads the real RALPH_HOME — which in a vitest worker is this checkout, whose
// own honest answer is `linked (dev checkout)` and would make half of these assertions depend
// on where the suite was run from.

const HOME = '/Users/me'
const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'
const NPX_RALPH = `${HOME}/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph`
const CHECKOUT = `${HOME}/repos/ralph`
const PNPM_RALPH = `${HOME}/Library/pnpm/global/5/node_modules/@lucasfe/ralph`

// The three probe answers, as stubs rather than as a Volume, because most of what follows
// counts calls or forces a failure and a real-ish filesystem cannot express either.
const plainDirectory = () => ({
  existsSync: () => false,
  lstatSync: () => ({ isSymbolicLink: () => false }),
})
const withGitEntry = (root) => ({
  existsSync: (p) => String(p) === join(root, '.git'),
  lstatSync: () => ({ isSymbolicLink: () => false }),
})
const asSymlink = () => ({
  existsSync: () => false,
  lstatSync: () => ({ isSymbolicLink: () => true }),
})

const channelAt = (ralphHome, fs = plainDirectory()) => describeInstallChannel({ ralphHome, fs })

// The `npm root -g` probe, in the two answers that matter, so a case can reach `global-npm`
// and the two failures under it without any of the other layouts changing shape.
const rootIs = (root) => async () => ({ exitCode: 0, stdout: root, stderr: '' })
const rootFails = async () => ({ exitCode: 1, stdout: '', stderr: 'npm ERR!' })

const HEDGE = 'npm or other (not probed)'

describe('QA #201 the extraction is byte-faithful — every layout, every field', () => {
  // THE GOLDENS. One entry per branch `classifyInstall` can return from, with the WHOLE object
  // rather than the one field a happy-path test would read. `latest` is NPM_VERSION_QUERY by
  // reference for every non-Homebrew layout, which is itself part of the claim: #199 put the
  // default in `runnable`, and a join that started spelling a query per row would answer an
  // equal-but-separate object and pass a `toEqual` while breaking the "one query, one channel"
  // invariant lib/update-check.channel.qa.test.js is about. So it is asserted by identity below.
  const NPM_NOTICE = 'npm i -g @lucasfe/ralph'
  const store = (kind, argv, reason, latest = NPM_VERSION_QUERY) => ({
    kind,
    argv,
    label: argv.join(' '),
    reason,
    advice: null,
    latest,
    noticeLabel: argv.join(' '),
  })
  const refusal = (kind, reason, advice) => ({
    kind,
    argv: null,
    label: null,
    reason,
    advice,
    latest: NPM_VERSION_QUERY,
    noticeLabel: null,
  })
  const unknown = (reason) => ({
    kind: 'unknown',
    argv: null,
    label: null,
    reason,
    advice: null,
    latest: NPM_VERSION_QUERY,
    noticeLabel: NPM_NOTICE,
  })

  const BREW_LATEST = {
    argv: ['brew', 'info', '--json=v2', 'ralph'],
    format: 'brew-json-v2',
    unreachable: 'the Homebrew tap could not be read?',
  }

  // [name, ralphHome, fs, exec, expected]
  const cases = [
    [
      'a pnpm global store',
      PNPM_RALPH,
      plainDirectory(),
      null,
      store(
        'global-pnpm',
        ['pnpm', 'add', '-g', '@lucasfe/ralph@latest'],
        `${PNPM_RALPH} is inside a pnpm global install directory`,
      ),
    ],
    [
      'a yarn global store',
      `${HOME}/.config/yarn/global/node_modules/@lucasfe/ralph`,
      plainDirectory(),
      null,
      store(
        'global-yarn',
        ['yarn', 'global', 'add', '@lucasfe/ralph@latest'],
        `${HOME}/.config/yarn/global/node_modules/@lucasfe/ralph is inside a yarn global install directory`,
      ),
    ],
    [
      "yarn's OTHER marker, the dotted one",
      `${HOME}/.yarn/global/node_modules/@lucasfe/ralph`,
      plainDirectory(),
      null,
      store(
        'global-yarn',
        ['yarn', 'global', 'add', '@lucasfe/ralph@latest'],
        `${HOME}/.yarn/global/node_modules/@lucasfe/ralph is inside a yarn global install directory`,
      ),
    ],
    [
      'a bun global store',
      `${HOME}/.bun/install/global/node_modules/@lucasfe/ralph`,
      plainDirectory(),
      null,
      store(
        'global-bun',
        ['bun', 'add', '-g', '@lucasfe/ralph@latest'],
        `${HOME}/.bun/install/global/node_modules/@lucasfe/ralph is inside a bun global install directory`,
      ),
    ],
    [
      "bun's OTHER marker, without the dot",
      `${HOME}/bun/install/global/node_modules/@lucasfe/ralph`,
      plainDirectory(),
      null,
      store(
        'global-bun',
        ['bun', 'add', '-g', '@lucasfe/ralph@latest'],
        `${HOME}/bun/install/global/node_modules/@lucasfe/ralph is inside a bun global install directory`,
      ),
    ],
    [
      // The one row whose `reason` comes from `layout` rather than from argv[0], and the one
      // row with a `latest` of its own. Both live on the marker half of the join now, so this
      // case is the join's load-bearing test: drop `layout` and the sentence silently becomes
      // "is inside a brew global install directory", which is a phrase Homebrew never uses.
      'a Homebrew Cellar',
      BREW_RALPH,
      plainDirectory(),
      null,
      store(
        'global-brew',
        ['brew', 'upgrade', 'ralph'],
        `${BREW_RALPH} is inside a Homebrew Cellar (\`Cellar/ralph\`)`,
        BREW_LATEST,
      ),
    ],
    [
      'an npx cache',
      NPX_RALPH,
      plainDirectory(),
      null,
      refusal(
        'npx',
        `${NPX_RALPH} is inside an npx cache (\`_npx\`)`,
        'npx always fetches the latest published version, so there is nothing to update.',
      ),
    ],
    [
      'a dev checkout',
      CHECKOUT,
      withGitEntry(CHECKOUT),
      null,
      refusal(
        'linked',
        `${CHECKOUT} contains a .git entry (dev checkout)`,
        'Run `git pull` in that checkout to update it.',
      ),
    ],
    [
      'a symlinked root no store claims',
      GLOBAL_RALPH,
      asSymlink(),
      null,
      refusal(
        'linked',
        `${GLOBAL_RALPH} is a symlink to another location`,
        'Ralph will not overwrite a linked install; update it with whichever package manager created it.',
      ),
    ],
    [
      // The advice on this one is BUILT from the joined row's argv, so it is a second reader of
      // the join and it reads a different field than `runnable` does.
      'a symlinked root inside exactly one store',
      PNPM_RALPH,
      asSymlink(),
      null,
      refusal(
        'linked',
        `${PNPM_RALPH} is a symlink to another location`,
        'Ralph will not overwrite a linked install; run `pnpm add -g @lucasfe/ralph@latest` to update it.',
      ),
    ],
    [
      // The ambiguity sentence names the managers in TABLE ORDER, read off argv[0] of each
      // joined row — so it fails on a reordered table AND on a row that lost its argv.
      'a path all four managers claim',
      '/x/pnpm/global/yarn/global/bun/install/global/Cellar/ralph/x',
      plainDirectory(),
      null,
      unknown(
        '/x/pnpm/global/yarn/global/bun/install/global/Cellar/ralph/x matches more than one package manager (pnpm, yarn, bun, brew)',
      ),
    ],
    [
      'a path two managers claim',
      '/x/yarn/global/node_modules/pnpm/global/x',
      plainDirectory(),
      null,
      unknown(
        '/x/yarn/global/node_modules/pnpm/global/x matches more than one package manager (pnpm, yarn)',
      ),
    ],
    [
      'a plain global npm install with no spawner offered',
      GLOBAL_RALPH,
      plainDirectory(),
      null,
      unknown('`npm root -g` was not probed (no way to spawn it was available)'),
    ],
    [
      // #200's one deliberate divergence, and the reason `noticeLabel` is spelled out here
      // rather than derived like every other store row's: the runnable label is the long form
      // and the notice is #24's short one. A join that started defaulting this field would change
      // bytes that fourteen suites outside this file assert.
      'a plain global npm install, probed',
      GLOBAL_RALPH,
      plainDirectory(),
      rootIs(GLOBAL_ROOT),
      {
        ...store(
          'global-npm',
          ['npm', 'install', '-g', '@lucasfe/ralph@latest'],
          `installed under \`npm root -g\` (${GLOBAL_ROOT})`,
        ),
        noticeLabel: NPM_NOTICE,
      },
    ],
    [
      'a path outside the probed global root',
      '/opt/hand-built/ralph',
      plainDirectory(),
      rootIs(GLOBAL_ROOT),
      unknown(`/opt/hand-built/ralph is not under \`npm root -g\` (${GLOBAL_ROOT})`),
    ],
    [
      'a probe that answered nothing',
      '/opt/hand-built/ralph',
      plainDirectory(),
      rootFails,
      unknown('`npm root -g` did not report a global node_modules directory'),
    ],
    [
      'no install directory at all',
      '',
      plainDirectory(),
      null,
      unknown('no install directory to classify (a blank or absent install path)'),
    ],
  ]

  for (const [name, ralphHome, fs, exec, expected] of cases) {
    it(`returns the whole pre-#201 object for ${name}`, async () => {
      const target = await classifyInstall({ ralphHome, fs, exec })
      expect(target).toEqual(expected)
      // Field-for-field as well as deep-equal, because `toEqual` treats a missing key and an
      // `undefined` one as the same thing and #199/#200's contract is that EVERY kind carries
      // `latest` and `noticeLabel`. A join that dropped one would answer `undefined` here.
      expect(Object.keys(target).sort()).toEqual([
        'advice',
        'argv',
        'kind',
        'label',
        'latest',
        'noticeLabel',
        'reason',
      ])
    })
  }

  it('gives every non-Homebrew layout the SAME npm query object, not an equal copy', async () => {
    // #199's design: one query per channel, defaulted in `runnable` rather than spelled per
    // row. Identity is the assertion because an equal-but-separate literal on each row would
    // satisfy every `toEqual` above while making "which channel answered?" a per-row decision
    // again — the exact duplication the join was supposed to remove.
    for (const [name, ralphHome, fs, exec, expected] of cases) {
      if (expected.latest !== NPM_VERSION_QUERY) continue
      const target = await classifyInstall({ ralphHome, fs, exec })
      expect(target.latest, name).toBe(NPM_VERSION_QUERY)
    }
  })

  it('joins on `store` and nothing else — every marker row acquires a kind AND an argv', async () => {
    // The join key is a bare string, and a typo in either half is invisible to every
    // behavioural test that only reads argv[0]: `{ ...row, ...undefined }` is legal JavaScript
    // that silently produces a row with no `kind`, whose `runnable` then throws
    // `argv.join is not a function` from inside `ralph update`. Driven per MARKER rather than
    // per row, so a row's second marker cannot be the one that misses.
    for (const row of INSTALL_MARKERS) {
      for (const marker of row.markers) {
        const ralphHome = `/x/${marker.join('/')}/node_modules/@lucasfe/ralph`
        const target = await classifyInstall({ ralphHome, fs: plainDirectory(), exec: null })
        expect(target.kind, marker.join('/')).toBe(`global-${row.store}`)
        expect(target.argv?.[0], marker.join('/')).toBe(row.store)
        expect(target.label, marker.join('/')).toBe(target.argv.join(' '))
        expect(target.noticeLabel, marker.join('/')).toBe(target.label)
        expect(target.advice, marker.join('/')).toBeNull()
        expect(target.latest, marker.join('/')).toBeTruthy()
      }
    }
  })

  it('keeps `store` out of the answer — it is a join key, not a fact a consumer reads', async () => {
    // The new key exists to hold the two halves together and for no other reason. If it
    // started leaking into the classification, consumers would begin matching on it and the
    // `kind` string that lib/update-gate.js and lib/commands/update.js switch on would have a
    // rival — which is how a table with one key becomes a table with two.
    const target = await classifyInstall({ ralphHome: BREW_RALPH, fs: plainDirectory(), exec: null })
    expect(target).not.toHaveProperty('store')
    expect(target).not.toHaveProperty('channel')
    expect(target).not.toHaveProperty('markers')
    expect(target).not.toHaveProperty('layout')
  })

  it('exports exactly what it exported before the split', async () => {
    // The extraction moved private helpers out. It must not have moved a PUBLIC name: fourteen
    // suites outside this file assert NPM_GLOBAL_NOTICE_LABEL's bytes, #200's own among them, and
    // the two update labels are #24's.
    const mod = await import('./install-target.js')
    expect(Object.keys(mod).sort()).toEqual([
      'NPM_GLOBAL_NOTICE_LABEL',
      'NPM_GLOBAL_UPDATE_ARGV',
      'NPM_GLOBAL_UPDATE_LABEL',
      'classifyInstall',
    ])
    expect(mod.NPM_GLOBAL_UPDATE_LABEL).toBe('npm install -g @lucasfe/ralph@latest')
    expect(mod.NPM_GLOBAL_NOTICE_LABEL).toBe('npm i -g @lucasfe/ralph')
    expect(mod.NPM_GLOBAL_UPDATE_ARGV).toEqual(['npm', 'install', '-g', '@lucasfe/ralph@latest'])
  })

  it('agrees with `describeInstallChannel` about the channel for every layout in the table', async () => {
    // The two halves answer different questions — "what updates this?" and "what installed
    // it?" — and they must agree about WHICH layout they are looking at, or `ralph doctor`
    // names a channel `ralph update` then refuses to act on. Asserted across the whole
    // precedence order rather than for the store rows alone.
    const agreements = [
      [BREW_RALPH, plainDirectory(), 'global-brew', 'Homebrew (`Cellar/ralph`)'],
      [PNPM_RALPH, plainDirectory(), 'global-pnpm', 'pnpm (global store)'],
      [NPX_RALPH, plainDirectory(), 'npx', 'npx (`_npx` cache)'],
      [CHECKOUT, withGitEntry(CHECKOUT), 'linked', 'linked (dev checkout)'],
      [GLOBAL_RALPH, asSymlink(), 'linked', 'linked (symlinked install)'],
      [GLOBAL_RALPH, plainDirectory(), 'unknown', HEDGE],
      ['/x/pnpm/global/yarn/global/x', plainDirectory(), 'unknown', 'ambiguous (matches pnpm, yarn)'],
    ]
    for (const [ralphHome, fs, kind, channel] of agreements) {
      const target = await classifyInstall({ ralphHome, fs, exec: null })
      expect(target.kind, ralphHome).toBe(kind)
      expect(describeInstallChannel({ ralphHome, fs }), ralphHome).toBe(channel)
    }
  })
})

describe('QA #201 the frozen table cannot be poisoned for the rest of the process', () => {
  // `matchingStores` hands out the ROWS THEMSELVES, and two consumers read them in one process:
  // `ralph update`'s decision and a diagnostic. A caller that could write to one would change
  // what the other recognizes for every later call — and the failure would look like a marker
  // bug rather than like a mutation. The dev's suite asserts `Object.isFrozen` at all four of
  // the table's nesting depths — array, row, `markers`, marker — and on NPX_CACHE_MARKER
  // beside it; this section asserts what frozenness is FOR, by trying every write and then
  // re-asking the question.

  it('hands out the row objects rather than copies of them, which is why freezing matters', () => {
    const matched = matchingStores(pathSegments(BREW_RALPH))
    expect(matched).toHaveLength(1)
    expect(matched[0]).toBe(INSTALL_MARKERS.find((row) => row.store === 'brew'))
  })

  it('refuses every write a caller could reach through the matcher (ESM is strict mode)', () => {
    const row = matchingStores(pathSegments(BREW_RALPH))[0]
    expect(() => {
      row.channel = 'Homebrew (definitely)'
    }).toThrow(TypeError)
    expect(() => {
      row.store = 'npm'
    }).toThrow(TypeError)
    expect(() => {
      row.layout = 'somewhere else'
    }).toThrow(TypeError)
    expect(() => {
      delete row.markers
    }).toThrow(TypeError)
    expect(() => {
      row.markers.push(['Cellar', 'anything'])
    }).toThrow(TypeError)
    expect(() => {
      row.markers[0].push('extra')
    }).toThrow(TypeError)
    expect(() => {
      row.markers[0][0] = 'cellar'
    }).toThrow(TypeError)
  })

  it('refuses a write to the table itself and to the npx marker', () => {
    expect(() => INSTALL_MARKERS.push({ store: 'evil', channel: 'evil', markers: [['x']] })).toThrow(
      TypeError,
    )
    expect(() => {
      INSTALL_MARKERS[0] = { store: 'evil', channel: 'evil', markers: [['x']] }
    }).toThrow(TypeError)
    expect(() => INSTALL_MARKERS.reverse()).toThrow(TypeError)
    expect(() => NPX_CACHE_MARKER.push('_npm')).toThrow(TypeError)
    expect(() => {
      NPX_CACHE_MARKER[0] = 'anything'
    }).toThrow(TypeError)
  })

  it('still answers identically after a caller has tried, and failed, to poison it', async () => {
    // The property the freeze buys, measured rather than inferred: run every write through a
    // swallowing catch — which is what a `try`-happy caller in another module would do — and
    // then re-ask both consumers.
    const before = {
      brew: channelAt(BREW_RALPH),
      pnpm: channelAt(PNPM_RALPH),
      hedge: channelAt(GLOBAL_RALPH),
      target: await classifyInstall({ ralphHome: BREW_RALPH, fs: plainDirectory(), exec: null }),
    }
    for (const row of matchingStores(pathSegments('/x/pnpm/global/Cellar/ralph/x'))) {
      try {
        row.channel = 'poisoned'
      } catch {
        /* frozen, which is the point */
      }
      try {
        row.markers.length = 0
      } catch {
        /* frozen */
      }
      try {
        row.markers[0][0] = 'poisoned'
      } catch {
        /* frozen */
      }
    }
    expect(channelAt(BREW_RALPH)).toBe(before.brew)
    expect(channelAt(PNPM_RALPH)).toBe(before.pnpm)
    expect(channelAt(GLOBAL_RALPH)).toBe(before.hedge)
    expect(
      await classifyInstall({ ralphHome: BREW_RALPH, fs: plainDirectory(), exec: null }),
    ).toEqual(before.target)
  })

  it('lets the caller keep the ARRAY the matcher returned without that reaching the table', () => {
    // The array is a fresh `filter` result and is deliberately NOT frozen — a caller may sort
    // or splice their own copy. What must not follow is a change to what the next call matches.
    const mine = matchingStores(pathSegments('/x/pnpm/global/Cellar/ralph/x'))
    expect(mine.map((row) => row.store)).toEqual(['pnpm', 'brew'])
    mine.length = 0
    mine.push({ store: 'evil', markers: [['x']] })
    expect(matchingStores(pathSegments('/x/pnpm/global/Cellar/ralph/x')).map((r) => r.store)).toEqual(
      ['pnpm', 'brew'],
    )
    expect(INSTALL_MARKERS.map((row) => row.store)).toEqual(['pnpm', 'yarn', 'bun', 'brew'])
  })

  it("documents the hole the freeze does NOT cover: classifyInstall's argv and latest are shared", async () => {
    // PRE-EXISTING AND UNCHANGED BY #201 — recorded here because this file is where a reader
    // will come looking for "is the table safe?", and the honest answer has two halves.
    //
    // The marker half is frozen and the section above proves it holds. The UPDATE half —
    // STORE_UPDATES, which stayed in lib/install-target.js — is a plain Map of plain objects,
    // exactly as the single table it was cut out of was a plain array of plain objects. So the
    // `argv` and `latest` a classification carries are the module's own arrays, handed out by
    // reference, and a caller that mutated one would change what `ralph update` spawns for
    // every later call in the process. `install-target.js` has no such caller today and the
    // pre-#201 module had the same hole in the same place, so this is characterization rather
    // than a #201 finding — but the join is now the seam where the two halves have DIFFERENT
    // guarantees, and that asymmetry deserves to be written down somewhere it can go red.
    const first = await classifyInstall({ ralphHome: BREW_RALPH, fs: plainDirectory(), exec: null })
    const restore = { argv: [...first.argv], latest: [...first.latest.argv] }
    try {
      first.argv.push('--force')
      first.latest.argv.push('--force')
      const second = await classifyInstall({
        ralphHome: BREW_RALPH,
        fs: plainDirectory(),
        exec: null,
      })
      expect(second.argv).toEqual(['brew', 'upgrade', 'ralph', '--force'])
      expect(second.label).toBe('brew upgrade ralph --force')
      expect(second.latest.argv).toEqual(['brew', 'info', '--json=v2', 'ralph', '--force'])
      expect(second.latest).toBe(first.latest)
    } finally {
      // Restored in place, because vitest shares a module registry across the tests in this
      // FILE: a leaked `--force` would show up as a mystery failure in whichever golden above
      // happened to run next.
      first.argv.length = 0
      first.argv.push(...restore.argv)
      first.latest.argv.length = 0
      first.latest.argv.push(...restore.latest)
    }
    const after = await classifyInstall({ ralphHome: BREW_RALPH, fs: plainDirectory(), exec: null })
    expect(after.argv).toEqual(['brew', 'upgrade', 'ralph'])
    expect(after.latest.argv).toEqual(['brew', 'info', '--json=v2', 'ralph'])
    // ...and the frozen half was never reachable from any of that.
    expect(INSTALL_MARKERS.find((row) => row.store === 'brew').markers).toEqual([
      ['Cellar', HOMEBREW_FORMULA],
    ])
  })
})

describe('QA #201 near-miss paths — every marker is a WHOLE segment, and adjacent', () => {
  // A marker that matched a little too widely is the expensive failure in this module: over on
  // lib/install-target.js it answers `-g` for a package Ralph is not running from, and here it
  // puts a manager's name on a bug report that has nothing to do with it. The dev's suite
  // proves three of these through `hasMarker`; this drives them through the function `ralph
  // doctor` actually calls, so a widened marker cannot slip past by being right at the unit
  // level and wrong at the seam.
  const nearMisses = [
    ["somebody else's Cellar", '/opt/homebrew/Cellar/node/22/lib/node_modules/@lucasfe/ralph'],
    ['a Cellar formula with our name as a PREFIX', '/opt/homebrew/Cellar/ralph-old/1.0.0/libexec'],
    ['a Cellar formula with our name as a SUFFIX', '/opt/homebrew/Cellar/my-ralph/1.0.0/libexec'],
    ['a lowercased Cellar (case is not folded)', '/opt/homebrew/cellar/ralph/1.0.0/libexec'],
    ['a bare Cellar with no formula under it', '/opt/homebrew/Cellar'],
    ["pnpm's VIRTUAL store, which a project-local install has too", `${HOME}/proj/node_modules/.pnpm/x`],
    ['pnpm with the global segment not adjacent', `${HOME}/Library/pnpm/5/global/node_modules/x`],
    ['pnpm with the segments in the wrong order', `${HOME}/Library/global/pnpm/node_modules/x`],
    ['a pnpm-lookalike directory', `${HOME}/Library/pnpm-old/global/node_modules/x`],
    ['yarn without the global segment', `${HOME}/.config/yarn/link/@lucasfe/ralph`],
    ['bun without the install segment', `${HOME}/.bun/global/node_modules/x`],
    ['an _npx-lookalike directory', `${HOME}/.npm/_npx-old/abc/node_modules/x`],
    ['_npx as a substring of a longer segment', `${HOME}/.npm/my_npx/abc/node_modules/x`],
    ['_npx uppercased', `${HOME}/.npm/_NPX/abc/node_modules/x`],
    ['an uppercased pnpm store', '/x/PNPM/GLOBAL/node_modules/x'],
    [
      // On posix `sep` is '/', so a Windows path arrives as ONE segment full of backslashes and
      // matches nothing. That is the honest answer rather than a gap: the hedge says nobody
      // probed, which is exactly true. On Windows `sep` is a backslash and the same path splits.
      'a Windows-separated pnpm path, read on posix',
      'C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules',
    ],
    ['a path whose `..` segments collapse the marker away', '/x/pnpm/global/../../y'],
    ['the filesystem root', '/'],
  ]

  for (const [name, ralphHome] of nearMisses) {
    it(`hedges rather than naming a manager for ${name}`, () => {
      expect(channelAt(ralphHome)).toBe(HEDGE)
    })
  }

  const realHits = [
    ['a Cellar anywhere, under any prefix', '/home/linuxbrew/.linuxbrew/Cellar/ralph/1.0.0/x', 'Homebrew (`Cellar/ralph`)'],
    ['an Intel-prefix Cellar', '/usr/local/Cellar/ralph/1.0.0/libexec/lib/node_modules/@lucasfe/ralph', 'Homebrew (`Cellar/ralph`)'],
    ['a Cellar that IS the last two segments', '/x/Cellar/ralph', 'Homebrew (`Cellar/ralph`)'],
    ['a global store reached through redundant separators', '//x//pnpm//global//node_modules//x', 'pnpm (global store)'],
    ['a global store reached through a `.` segment', '/x/./pnpm/global/node_modules/x', 'pnpm (global store)'],
    ['a whitespace-padded path', `   ${PNPM_RALPH}   `, 'pnpm (global store)'],
    ['a bare `_npx` as the last segment', `${HOME}/.npm/_npx`, 'npx (`_npx` cache)'],
    ["pnpm's virtual store INSIDE a global one", `${HOME}/Library/pnpm/global/5/node_modules/.pnpm/x`, 'pnpm (global store)'],
    ['an astral-plane segment beside the marker', '/x/\u{1F600}/pnpm/global/node_modules/x', 'pnpm (global store)'],
    ['a CJK segment beside the marker', '/x/\u30E9\u30EB\u30D5/pnpm/global/x', 'pnpm (global store)'],
  ]

  for (const [name, ralphHome, expected] of realHits) {
    it(`still recognizes ${name}`, () => {
      expect(channelAt(ralphHome)).toBe(expected)
    })
  }

  it('never echoes the install path into the answer, so no path can forge a row', () => {
    // The load-bearing consequence, and the reason a control byte in RALPH_HOME cannot become a
    // second line inside `ralph doctor`'s frame: every answer this module can give is a LITERAL
    // from the table or a list of manager names, and none of them is built from the input. The
    // box's `textOr` scrub is a second gate on the far side (lib/banner-rows.js), and this is
    // the first one — a property rather than a sanitisation, which is the stronger kind.
    const NL = String.fromCharCode(10)
    const ESC = String.fromCharCode(27)
    const hostilePaths = [
      `/x/pnpm/global/a${NL}${ESC}[31mFAKE`,
      `/x/Cellar/ralph/${ESC}[2J`,
      `/x/${String.fromCharCode(0)}/pnpm/global/x`,
      `${HOME}/.npm/_npx/${NL}${NL}/x`,
    ]
    for (const ralphHome of hostilePaths) {
      const answer = channelAt(ralphHome)
      expect(typeof answer, ralphHome).toBe('string')
      expect(answer, ralphHome).not.toContain(NL)
      expect(answer, ralphHome).not.toContain(ESC)
      expect(answer, ralphHome).not.toContain(String.fromCharCode(0))
      expect(answer, ralphHome).not.toContain('FAKE')
      expect(answer, ralphHome).not.toContain(HOME)
    }
    // ...and the one answer that is built from anything at all is built from the TABLE's own
    // `store` keys, never from a segment the caller supplied.
    expect(channelAt('/x/pnpm/global/Cellar/ralph/x')).toBe('ambiguous (matches pnpm, brew)')
  })

  it('survives a path with five thousand segments without a stack or a timeout', () => {
    const long = `/${Array.from({ length: 5000 }, (_, i) => `seg${i}`).join('/')}`
    const started = Date.now()
    expect(channelAt(long)).toBe(HEDGE)
    expect(channelAt(`${long}/pnpm/global/x`)).toBe('pnpm (global store)')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('survives one absurdly long segment', () => {
    expect(channelAt(`/x/${'y'.repeat(200_000)}/pnpm/global/x`)).toBe('pnpm (global store)')
  })

  it('resolves a RELATIVE path against the process cwd — documented, and why it is safe here', () => {
    // `normalizePath` calls `resolve`, so a non-blank relative path is joined to the process's
    // cwd. That is the standard reading of a relative path and it is NOT the thing the module's
    // note forbids — what must never happen is a BLANK path becoming the cwd, since a cwd that
    // happened to sit under a global store would have doctor describing an unrelated directory.
    // Pinned as characterization because the only production caller (bin/ralph.js, via
    // lib/paths.js) always passes an absolute path derived from `import.meta.url`.
    expect(normalizePath('relative/pnpm/global/x')).toBe(`${process.cwd()}/relative/pnpm/global/x`)
    expect(channelAt('relative/pnpm/global/x')).toBe('pnpm (global store)')
    for (const blank of ['', '  ', String.fromCharCode(9), null, undefined]) {
      expect(normalizePath(blank), JSON.stringify(blank)).toBeNull()
      expect(describeInstallChannel({ ralphHome: blank }), JSON.stringify(blank)).toBeNull()
    }
  })

  it('COERCES a non-string rather than rejecting it — which is why doctor gates on typeof', () => {
    // `normalizePath` does `String(p ?? '')`, so a number, an object with a `toString` and even
    // a Symbol all become paths here: `String(sym)` is the one coercion of a Symbol that does
    // NOT throw, so this seam cannot be relied on to reject one. That is exactly why
    // lib/commands/doctor.js gates on `typeof ralphHome === 'string'` before this module is ever
    // reached — pinned from both sides, so a reader can see where the coercion is refused and
    // where it is merely survived. Nothing here throws, which is the part that matters for a
    // diagnostic; the part that matters for honesty is doctor's gate.
    expect(normalizePath(0)).toBe(`${process.cwd()}/0`)
    expect(normalizePath({ toString: () => 'x' })).toBe(`${process.cwd()}/x`)
    expect(normalizePath(Symbol('x'))).toBe(`${process.cwd()}/Symbol(x)`)
    for (const ralphHome of [42, {}, [], true, Symbol('x'), 0n]) {
      expect(() => describeInstallChannel({ ralphHome }), String(ralphHome)).not.toThrow()
    }
  })

  it('answers null for `[]`, which coerces to blank rather than to a path', () => {
    // `String([])` is `''`, so an array arrives blank and answers null — the "nobody asked"
    // reading. Worth pinning because `String([1])` is `'1'` and DOES resolve, which is the
    // asymmetry a reader would otherwise have to discover.
    expect(describeInstallChannel({ ralphHome: [] })).toBeNull()
    expect(describeInstallChannel({ ralphHome: ['pnpm/global/x'] })).toBe('pnpm (global store)')
  })
})

describe('QA #201 precedence is a MATRIX, not two cells', () => {
  // `describeInstallChannel`'s documented order is `classifyInstall`'s: link, then npx, then a
  // single store, then a named ambiguity, then the hedge. The dev's suite checks two cells of
  // that (store+git, npx+git). Every combination is driven here, because a precedence bug shows
  // up as a diagnostic naming a channel `ralph update` would then refuse to act on — the one
  // failure mode the shared order exists to prevent.
  const AMBIGUOUS = '/x/pnpm/global/yarn/global/node_modules/@lucasfe/ralph'
  const matrix = [
    ['a checkout beats a store', PNPM_RALPH, withGitEntry(PNPM_RALPH), 'linked (dev checkout)'],
    ['a checkout beats a Cellar', BREW_RALPH, withGitEntry(BREW_RALPH), 'linked (dev checkout)'],
    ['a checkout beats an npx cache', NPX_RALPH, withGitEntry(NPX_RALPH), 'linked (dev checkout)'],
    ['a checkout beats an ambiguity', AMBIGUOUS, withGitEntry(AMBIGUOUS), 'linked (dev checkout)'],
    ['a checkout beats the hedge', GLOBAL_RALPH, withGitEntry(GLOBAL_RALPH), 'linked (dev checkout)'],
    ['a symlink beats a store', PNPM_RALPH, asSymlink(), 'linked (symlinked install)'],
    ['a symlink beats a Cellar', BREW_RALPH, asSymlink(), 'linked (symlinked install)'],
    ['a symlink beats an npx cache', NPX_RALPH, asSymlink(), 'linked (symlinked install)'],
    ['a symlink beats an ambiguity', AMBIGUOUS, asSymlink(), 'linked (symlinked install)'],
    [
      'a .git beats a symlink on the same path — the checkout wording wins',
      CHECKOUT,
      { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => true }) },
      'linked (dev checkout)',
    ],
    ['npx beats a single store', `${HOME}/.npm/_npx/a/pnpm/global/x`, plainDirectory(), 'npx (`_npx` cache)'],
    ['npx beats a Cellar', `${HOME}/.npm/_npx/a/Cellar/ralph/x`, plainDirectory(), 'npx (`_npx` cache)'],
    [
      'npx beats an ambiguity',
      `${HOME}/.npm/_npx/a/pnpm/global/yarn/global/x`,
      plainDirectory(),
      'npx (`_npx` cache)',
    ],
    ['an ambiguity beats the hedge', AMBIGUOUS, plainDirectory(), 'ambiguous (matches pnpm, yarn)'],
  ]

  for (const [name, ralphHome, fs, expected] of matrix) {
    it(name, () => {
      expect(describeInstallChannel({ ralphHome, fs })).toBe(expected)
    })
  }

  it('names the managers in TABLE order however the path spells them', () => {
    // The ambiguity list is read off the table, not off the path, so two paths that mention the
    // managers in opposite orders answer the same sentence. That is what makes the message
    // stable enough for a bug report to be compared against another bug report.
    const forward = '/x/pnpm/global/yarn/global/bun/install/global/Cellar/ralph/x'
    const backward = '/x/Cellar/ralph/bun/install/global/yarn/global/pnpm/global/x'
    expect(channelAt(forward)).toBe('ambiguous (matches pnpm, yarn, bun, brew)')
    expect(channelAt(backward)).toBe(channelAt(forward))
  })

  it('agrees with `classifyInstall` about every cell of the matrix', async () => {
    // Same order, same inputs, checked against the module that has to ACT on the answer.
    for (const [name, ralphHome, fs, expected] of matrix) {
      const target = await classifyInstall({ ralphHome, fs, exec: null })
      const kind = expected.startsWith('linked')
        ? 'linked'
        : expected.startsWith('npx')
          ? 'npx'
          : 'unknown'
      expect(target.kind, name).toBe(kind)
      // ...and the two link wordings track the same `checkout` boolean on both sides.
      if (expected === 'linked (dev checkout)') {
        expect(target.advice, name).toBe('Run `git pull` in that checkout to update it.')
      } else if (expected === 'linked (symlinked install)') {
        expect(target.advice, name).toContain('will not overwrite a linked install')
      }
    }
  })
})

describe('QA #201 the probe seam must be TOTAL — a diagnostic never crashes over its own fs', () => {
  // `linkSignal`'s documented contract, quoted from its own JSDoc: "Any value this cannot use
  // answers 'not a link', which is the same answer a plain directory gets". Both callers depend
  // on it — lib/commands/doctor.js hands over a caller-supplied `installFs`, and
  // lib/install-target.js hands over `fsFrom`'s facade — and the pre-#201 code enforced it with
  // two helpers that each wrapped their WHOLE expression in a try. #201 replaced them with one
  // `probe`, whose first shape ended its try at the CALL — the seam this section was aimed at,
  // and the defect it caught. `probe` now takes the whole question as a thunk
  // (lib/install-markers.js:334-340), so every case below passes; they stay because a future
  // edit that narrowed the guard back to a call would have to break them first.

  const usable = [
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['a number', 42],
    ['a string', 'fs'],
    ['a boolean', true],
    ['an array', []],
    ['a function', () => {}],
    ['non-function probes', { existsSync: 'yes', lstatSync: 'yes' }],
    ['existsSync only, throwing', { existsSync: () => { throw new Error('EACCES') } }],
    ['lstatSync only, throwing', { lstatSync: () => { throw new Error('ELOOP') } }],
    ['both throwing', {
      existsSync: () => { throw new Error('EPERM') },
      lstatSync: () => { throw new Error('EPERM') },
    }],
    ['probes that are throwing GETTERS', {
      get existsSync() { throw new Error('hostile getter') },
      get lstatSync() { throw new Error('hostile getter') },
    }],
    ['a Proxy hostile on every get', new Proxy({}, { get() { throw new Error('hostile proxy') } })],
    ['a null-prototype bag', Object.create(null)],
    ['lstatSync returning null', { existsSync: () => false, lstatSync: () => null }],
    ['lstatSync returning a bare object', { existsSync: () => false, lstatSync: () => ({}) }],
    ['lstatSync returning a number', { existsSync: () => false, lstatSync: () => 42 }],
  ]

  for (const [name, fs] of usable) {
    it(`answers "not a link" for ${name}`, () => {
      expect(() => linkSignal(fs, CHECKOUT), name).not.toThrow()
      expect(linkSignal(fs, CHECKOUT), name).toBeNull()
      // ...and the public entry point falls through to whatever the PATH says, which for a
      // Cellar is still a positive identification: an unusable filesystem costs the two link
      // answers and nothing else.
      expect(describeInstallChannel({ ralphHome: BREW_RALPH, fs }), name).toBe(
        'Homebrew (`Cellar/ralph`)',
      )
      expect(describeInstallChannel({ ralphHome: GLOBAL_RALPH, fs }), name).toBe(HEDGE)
    })
  }

  // THE DEFECT THESE FOUR CASES CAUGHT, and the reason the section stays now that they pass.
  //
  // `probe` used to guard the CALL and only the call — `try { return fs[method](path) } catch
  // { return undefined }` — and `linkSignal` then read `?.isSymbolicLink?.()` off the RESULT,
  // outside that try. Every value below was one that guard did not cover, and the pre-#201 code
  // covered all of them: its `isSymlink` helper had the whole expression inside one try —
  //
  //   function isSymlink(fs, path) {
  //     try { return Boolean(fs.lstatSync?.(path)?.isSymbolicLink()) } catch { return false }
  //   }
  //
  // — so a stat it could not read answered false, which is what the contract promises. The
  // extraction had narrowed the guard from the expression to the call and changed nothing else,
  // which is why this was a #201 regression rather than a pre-existing gap.
  //
  // FIXED BY PASSING THE QUESTION rather than a method name. `probe` takes a thunk
  // (lib/install-markers.js:334-340) and `linkSignal` asks it
  // `probe(() => fs.lstatSync(home).isSymbolicLink())` at :289, so the stat, the property read
  // and the call all sit inside the one try — the guard now covers whatever the caller wrote
  // instead of whatever this helper remembered to re-guard. That argument is written out at
  // :277-288 and :319-333, and these cases are what it points at. They STAY because the guard
  // boundary is re-narrowable by a single edit: lift any step of that expression back out of the
  // thunk and this is the section that has to go red again before the defect can ship twice.
  //
  // THE FIRST CASE WAS THE PLAUSIBLE ONE, and it is worth reading before the hostile three: a
  // stat whose `isSymbolicLink` is not a FUNCTION. `?.()` short-circuits on null and undefined
  // only, so a plain-object stat — a `{ isSymbolicLink: false }` from a hand-rolled stub, a
  // structuredClone'd or JSON-round-tripped Stats (its methods do not survive either), a
  // BigInt-mode stat from some future wrapper — threw `TypeError: probe(...)?.isSymbolicLink is
  // not a function` straight out of the diagnostic. `installFs` is a documented public seam on
  // `doctorCommand`, so that shape arrives from a caller rather than from the disk.
  //
  // Two things made this worth a red test rather than a note. The contract is stated twice in
  // prose — in `linkSignal`'s own JSDoc ("Any value this cannot use answers 'not a link'") and
  // in lib/commands/doctor.js's `installFs` note ("Any value it cannot use answers 'not a
  // link'") — and it was false for a named class of value. And the blast radius was a THROW
  // OUT OF A DIAGNOSTIC: doctor is the command people run when the machine is already broken,
  // its exit code is what wrappers and CI steps gate on, and this row is additive output that
  // must not be able to move either. Not one of the three levels asserted below — the helper,
  // `describeInstallChannel`, `classifyInstall` — is allowed to propagate it.
  const hostileStats = [
    [
      'an isSymbolicLink that is not a function',
      { existsSync: () => false, lstatSync: () => ({ isSymbolicLink: false }) },
    ],
    [
      'an isSymbolicLink that throws when called',
      { existsSync: () => false, lstatSync: () => ({ isSymbolicLink: () => { throw new Error('EPERM') } }) },
    ],
    [
      'an isSymbolicLink that is a throwing getter',
      {
        existsSync: () => false,
        lstatSync: () => ({ get isSymbolicLink() { throw new Error('hostile stat getter') } }),
      },
    ],
    [
      'a stat Proxy hostile on every get',
      {
        existsSync: () => false,
        lstatSync: () => new Proxy({}, { get() { throw new Error('hostile stat proxy') } }),
      },
    ],
  ]

  for (const [name, fs] of hostileStats) {
    it(`answers "not a link" for a stat object with ${name}`, () => {
      expect(() => linkSignal(fs, CHECKOUT), name).not.toThrow()
      expect(linkSignal(fs, CHECKOUT), name).toBeNull()
    })

    it(`does not throw out of describeInstallChannel for ${name}`, () => {
      expect(() => describeInstallChannel({ ralphHome: BREW_RALPH, fs }), name).not.toThrow()
      expect(describeInstallChannel({ ralphHome: BREW_RALPH, fs }), name).toBe(
        'Homebrew (`Cellar/ralph`)',
      )
    })

    it(`does not throw out of classifyInstall for ${name}`, async () => {
      // The same escape reaches `ralph update`, which is the caller that then decides whether to
      // unpack a tarball over the directory. It classifies rather than crashing.
      await expect(
        classifyInstall({ ralphHome: BREW_RALPH, fs, exec: null }),
      ).resolves.toMatchObject({ kind: 'global-brew' })
    })
  }

  it('reads the two probes in the documented order, and asks for exactly two paths', () => {
    // `.git` first and THROUGH the link (existsSync follows symlinks), so a `npm link`ed root
    // finds the checkout's .git with no readlink — which is what makes the two link wordings
    // decidable at all. Order asserted, because swapping them would report every linked
    // checkout as a plain symlinked install and lose the `git pull` advice.
    const calls = []
    const fs = {
      existsSync: (p) => {
        calls.push(['existsSync', String(p)])
        return false
      },
      lstatSync: (p) => {
        calls.push(['lstatSync', String(p)])
        return { isSymbolicLink: () => false }
      },
    }
    expect(linkSignal(fs, CHECKOUT)).toBeNull()
    expect(calls).toEqual([
      ['existsSync', join(CHECKOUT, '.git')],
      ['lstatSync', CHECKOUT],
    ])
  })

  it('short-circuits the lstat when the .git probe already answered', () => {
    // Two probes is the row's whole documented cost, and a checkout should cost one. Pinned so
    // a future edit that hoisted the lstat above the branch is visible.
    const calls = []
    const fs = {
      existsSync: () => {
        calls.push('existsSync')
        return true
      },
      lstatSync: () => {
        calls.push('lstatSync')
        return { isSymbolicLink: () => false }
      },
    }
    expect(linkSignal(fs, CHECKOUT)).toEqual({
      reason: 'contains a .git entry (dev checkout)',
      checkout: true,
    })
    expect(calls).toEqual(['existsSync'])
  })

  it('believes a truthy non-boolean existsSync, as the pre-#201 Boolean() cast did', () => {
    // `probe` returns the raw value now instead of `Boolean(...)`; `linkSignal` uses it in an
    // `if`, so the two are equivalent — asserted rather than assumed, because a raw return is
    // also what would leak a non-boolean if some future caller stopped using it as a test.
    for (const answer of [true, 1, 'yes', {}, []]) {
      const fs = { existsSync: () => answer, lstatSync: () => ({ isSymbolicLink: () => false }) }
      expect(linkSignal(fs, CHECKOUT)?.checkout, JSON.stringify(answer)).toBe(true)
    }
    for (const answer of [false, 0, '', null, undefined, Number.NaN]) {
      const fs = { existsSync: () => answer, lstatSync: () => ({ isSymbolicLink: () => false }) }
      expect(linkSignal(fs, CHECKOUT), JSON.stringify(answer)).toBeNull()
    }
  })

  it('works against a real-shaped filesystem too, not only against stubs', () => {
    // memfs Stats are the closest thing to the real `node:fs` this suite can hold, and the
    // production default for both callers is the real one. A `.git` FILE (a worktree or
    // submodule) counts as a checkout exactly as a directory does.
    const worktree = Volume.fromJSON({ [`${CHECKOUT}/.git`]: 'gitdir: /elsewhere/.git/worktrees/x' })
    expect(describeInstallChannel({ ralphHome: CHECKOUT, fs: worktree })).toBe('linked (dev checkout)')
    const dir = Volume.fromJSON({ [`${CHECKOUT}/.git/HEAD`]: 'ref: refs/heads/main\n' })
    expect(describeInstallChannel({ ralphHome: CHECKOUT, fs: dir })).toBe('linked (dev checkout)')
    const link = Volume.fromJSON({ [`${CHECKOUT}/package.json`]: '{}' })
    link.mkdirSync(`${GLOBAL_ROOT}/@lucasfe`, { recursive: true })
    link.symlinkSync(CHECKOUT, GLOBAL_RALPH)
    // A symlink to something that is NOT a checkout: nothing but the lstat fires, so this is the
    // "installed copy that happens to be a link" wording.
    expect(describeInstallChannel({ ralphHome: GLOBAL_RALPH, fs: link })).toBe('linked (symlinked install)')
    // ...and the same link pointed at a real working tree. existsSync FOLLOWS the link, so
    // `.git`-through-the-link is found first and the checkout wording wins — which is the whole
    // reason the two probes are ordered the way they are, checked against a filesystem that
    // really resolves links rather than against a stub that was told the answer.
    const linkToCheckout = Volume.fromJSON({ [`${CHECKOUT}/.git/HEAD`]: 'ref: refs/heads/main\n' })
    linkToCheckout.mkdirSync(`${GLOBAL_ROOT}/@lucasfe`, { recursive: true })
    linkToCheckout.symlinkSync(CHECKOUT, GLOBAL_RALPH)
    expect(describeInstallChannel({ ralphHome: GLOBAL_RALPH, fs: linkToCheckout })).toBe(
      'linked (dev checkout)',
    )
  })

  it('never spawns and never reaches a socket, whatever it is handed', () => {
    // Belt and braces beside the import-graph walk below: an `fs` seam whose methods spawned
    // would be invisible to a static scan, so the two capabilities are also removed from under
    // the module at runtime for one call.
    const originalFetch = globalThis.fetch
    let fetches = 0
    globalThis.fetch = () => {
      fetches += 1
      throw new Error('install-markers must not open a socket')
    }
    try {
      expect(channelAt(BREW_RALPH)).toBe('Homebrew (`Cellar/ralph`)')
      expect(channelAt(GLOBAL_RALPH)).toBe(HEDGE)
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(fetches).toBe(0)
  })
})

describe('QA #201 hasMarker and the two path primitives, at their edges', () => {
  it('would match EVERY path for an empty marker, which is why no shipped row has one', () => {
    // An empty marker vacuously matches at index 0, which would make a row with `markers: [[]]`
    // claim every path there is. Pinned as characterization of what the loop actually does, and
    // as the reason the dev's suite asserts no shipped row has an empty marker.
    expect(hasMarker(['x'], [])).toBe(true)
    expect(hasMarker([], [])).toBe(true)
    // ...which is why the shipped table has none, checked from this side too.
    for (const row of INSTALL_MARKERS) {
      for (const marker of row.markers) expect(marker.length, row.store).toBeGreaterThan(0)
    }
  })

  it('matches a marker at the very start and at the very end of a path', () => {
    expect(hasMarker(['pnpm', 'global', 'x'], ['pnpm', 'global'])).toBe(true)
    expect(hasMarker(['x', 'pnpm', 'global'], ['pnpm', 'global'])).toBe(true)
    expect(hasMarker(['pnpm', 'global'], ['pnpm', 'global'])).toBe(true)
  })

  it('matches the LAST of several occurrences as readily as the first', () => {
    expect(hasMarker(['pnpm', 'x', 'pnpm', 'global'], ['pnpm', 'global'])).toBe(true)
  })

  it('compares segments with === , so no coercion and no prototype key can match', () => {
    // A `constructor` or `__proto__` segment must be an ordinary string here rather than a hit
    // on Object.prototype — the marker match is an array walk and never a property lookup.
    expect(hasMarker(['__proto__', 'global'], ['pnpm', 'global'])).toBe(false)
    expect(hasMarker(['constructor'], ['constructor'])).toBe(true)
    expect(channelAt('/x/__proto__/global/y')).toBe(HEDGE)
    expect({}.polluted).toBeUndefined()
  })

  it('splits on whole separators only, dropping empties', () => {
    expect(pathSegments('/Users/me//repos/ralph/')).toEqual(['Users', 'me', 'repos', 'ralph'])
    expect(pathSegments('/')).toEqual([])
    expect(pathSegments('')).toEqual([])
    expect(pathSegments('////')).toEqual([])
    // A segment may itself contain anything but the separator, control bytes included: the
    // scrub that matters happens in the box, and this function's job is only to split.
    expect(pathSegments(`/a${String.fromCharCode(10)}b/c`)).toEqual([
      `a${String.fromCharCode(10)}b`,
      'c',
    ])
  })

  it('normalizes a trailing separator away so a marker at the end still matches', () => {
    expect(normalizePath('/x/pnpm/global/')).toBe('/x/pnpm/global')
    expect(channelAt('/x/pnpm/global/')).toBe('pnpm (global store)')
  })
})

describe('QA #201 the pure module is pure — asserted independently of the dev`s walk', () => {
  // The dev's suite greps this module's own source for its import list. That is the right
  // check and it is one file deep. What doctor's guarantee actually needs is that the module's
  // whole TRANSITIVE reach is spawner-free, which is a different assertion and is the one this
  // block makes — walked here rather than borrowed from doctor's suite, so the property holds
  // for every OTHER importer too (lib/install-target.js reads this table, and one day something
  // else will).
  const MARKERS = new URL('./install-markers.js', import.meta.url)

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

  function importGraph(entry) {
    const files = new Map()
    const bare = new Set()
    const stack = [entry]
    while (stack.length > 0) {
      const file = stack.pop()
      const key = String(file)
      if (files.has(key)) continue
      // Comments stripped for the reason doctor's own walk states: this module argues at length
      // about why it may not import a spawner, and that argument cannot be made without naming
      // one. A guard that went red on a paragraph is a guard people route around.
      const src = codeWithoutComments(file)
      files.set(key, src)
      for (const spec of specifiersOf(src)) {
        if (spec.startsWith('.')) stack.push(new URL(spec, file))
        else bare.add(spec)
      }
    }
    return { files, bare }
  }

  const graph = importGraph(MARKERS)

  it('reached the module it claims to have walked (guards against a vacuous pass)', () => {
    expect(graph.files.size).toBe(1)
    expect([...graph.files.keys()][0]).toMatch(/lib\/install-markers\.js$/)
    expect([...graph.files.values()][0]).toContain('describeInstallChannel')
  })

  it('reaches `node:path` and nothing else, transitively', () => {
    expect([...graph.bare].sort()).toEqual(['node:path'])
  })

  it('reaches nothing that can spawn a process or open a socket', () => {
    const forbidden = [
      'execa',
      'node:child_process',
      'child_process',
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:dgram',
      'node:worker_threads',
      'node:cluster',
      'node:fs',
      'node:url',
      'undici',
      'node-fetch',
      'axios',
    ]
    for (const spec of forbidden) expect([...graph.bare]).not.toContain(spec)
  })

  it('names no capability in its code, however it might reach one', () => {
    const banned = [
      [/\bfetch\s*\(/, 'fetch('],
      [/\bexeca\b/, 'execa'],
      [/child_process/, 'child_process'],
      [/\bspawn(Sync)?\s*\(/, 'spawn('],
      [/\bexecSync\s*\(/, 'execSync('],
      [/\bprocess\./, 'process.'],
      [/\brequire\s*\(/, 'require('],
      [/createRequire/, 'createRequire'],
      [/\bnew\s+Function\b/, 'new Function'],
      [/\beval\s*\(/, 'eval('],
    ]
    for (const [file, src] of graph.files) {
      for (const [re, label] of banned) {
        expect(re.test(src), `${file} must not reference ${label}`).toBe(false)
      }
    }
  })

  it('holds no real-filesystem default, which is the asymmetry the split rests on', () => {
    // `linkSignal` takes its `fs` as an argument and this module never supplies one. The moment
    // a real default lives here, "pure path matching" becomes a claim about the file rather than
    // a property of it — and `node:fs` in the import list would put a filesystem one edit away
    // from a spawner in the same file.
    const code = codeWithoutComments(MARKERS)
    expect(code).not.toMatch(/existsSync\s*[,}]/)
    expect(code).not.toMatch(/lstatSync\s*[,}]/)
    expect(code).not.toMatch(/realExistsSync|realLstatSync/)
    // ...and lib/install-target.js is the file that DOES keep it, deliberately.
    const target = codeWithoutComments(new URL('./install-target.js', import.meta.url))
    expect(target).toMatch(/realExistsSync/)
    expect(target).toMatch(/function fsFrom\(/)
  })

  it('is deterministic — same answer for the same path, forever', () => {
    // No clock, no environment, no randomness: a diagnostic whose answer moved between two
    // runs of the same command would be a diagnostic nobody could compare against a report.
    for (const path of [BREW_RALPH, PNPM_RALPH, NPX_RALPH, GLOBAL_RALPH, '/']) {
      const answers = new Set(
        Array.from({ length: 25 }, () => String(describeInstallChannel({ ralphHome: path }))),
      )
      expect(answers.size, path).toBe(1)
    }
  })
})
