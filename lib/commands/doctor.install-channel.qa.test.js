import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { INSTALL_MARKERS } from '../install-markers.js'
import { composeBanner, BOX_MIN_WIDTH } from '../banner-compose.js'
import { doctorCommand } from './doctor.js'

// #201 QA augmentation for the `channel` row.
//
// The dev's lib/commands/doctor.install-channel.test.js proves eight of the nine wordings reach
// the box — every one but the ambiguity, which the LAYOUTS list below adds — plus the row's
// position, that no path means no row, that the exit code does not move, and that the row costs
// no `exec` and at most two probes for ONE layout. This file goes after the properties a
// per-answer test cannot see, in the order they would hurt if they were false.
//
// 1. THE HEDGE'S HONESTY, AS A PROPERTY RATHER THAN AS ONE STRING. The acceptance criterion is
//    not "the npm row says `not probed`" — it is that a reader of a pasted box can tell a
//    DETERMINATION from a DEFAULT. That is a statement about the whole vocabulary: every value
//    the row can take must either name a channel something observed, or say out loud that
//    nothing did, and no value may read as a confident npm claim. Driven over every layout at
//    once below, against a vocabulary read out of lib/install-markers.js's own table.
//
// 2. THE COST, MEASURED RATHER THAN ARGUED. `ralph doctor` is the command people run when the
//    machine is already broken and possibly offline, and #201's whole design constraint is that
//    the row buys its answer with path matching. So: no spawner consulted even when one is
//    handed over and would throw if touched, `globalThis.fetch` never called, the install path
//    the only path read, NO fs method but the two probes even LOOKED UP, and not one byte
//    written to the version cache. Each of those is a counter or a throwing stub, not a claim.
//
// 3. SEAM TOTALITY AT THE COMMAND LEVEL. The dev's suite drives five `installFs` values; the
//    interesting ones are the values a stub-shaped test does not think of, because `installFs`
//    is a documented public option on an exported function. The stat-object family is where it
//    WENT red — that is the defect the section named for it caught, fixed in this round by
//    giving lib/install-markers.js's `probe` the whole question as a thunk (:334-340). See
//    lib/install-markers.qa.test.js for the same cases at the three levels below this one.
//
// 4. NOTHING ELSE MOVED, PROVED FROM BOTH SIDES. `ralph start`'s and `ralph status`'s boxes are
//    byte-identical because they pass no `channel`; that is asserted here as a source fact AND
//    as a rendered one, and doctor's own output is asserted byte-identical except for the single
//    line the row adds. Plus the clip ladder: the channel row must degrade with the rest of the
//    box all the way down — thirteen terminal widths, from the 60-column design width to a single
//    column — rather than break the frame at any of them.
//
// 5. THE IMPORT GRAPH, WALKED INDEPENDENTLY. doctor.version-line.qa.test.js owns that spec and
//    must keep passing unmodified, so this file does not touch it — but it re-walks the graph to
//    assert the two things #201 specifically changed about it: install-markers.js is now ON it,
//    and install-target.js and lib/paths.js are still off it.
//
// Hermetic (#41): memfs for the cache, a text seam for the config, literal install paths and
// injected probes. Nothing here reads the real RALPH_HOME — in a vitest worker that is this
// checkout, which honestly answers `linked (dev checkout)` and would make the layout
// assertions depend on where the suite was run from.

const ESC = String.fromCharCode(27)
const NL = String.fromCharCode(10)
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
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

const allPresent = () => true
const HOME = '/home/me'
const CWD = '/repo'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')

const GLOBAL_RALPH = '/usr/local/lib/node_modules/@lucasfe/ralph'
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'
const NPX_RALPH = '/Users/me/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph'
const CHECKOUT = '/Users/me/repos/ralph'
const PNPM_RALPH = '/Users/me/Library/pnpm/global/5/node_modules/@lucasfe/ralph'
const AMBIGUOUS = '/x/pnpm/global/yarn/global/node_modules/@lucasfe/ralph'

const warmCache = (latestVersion) =>
  Volume.fromJSON({ [CACHE_PATH]: JSON.stringify({ latest_version: latestVersion }) }, '/')

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

async function runDoctor({ cacheFs = new Volume(), env = {}, extra = {} } = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  const result = await doctorCommand({
    stdout,
    stderr,
    hasCommand: allPresent,
    platform: 'mac',
    env,
    currentVersion: '0.17.0',
    cacheFs,
    home: HOME,
    cwd: CWD,
    color: false,
    exists: () => false,
    readFile: () => '',
    ...extra,
  })
  return { result, out: stdout.output(), raw: stdout.raw(), err: stderr.output() }
}

const GUTTER = 8
const prefixFor = (label) => `│ ${label.padEnd(GUTTER)}`
const rowValue = (out, label) => {
  const prefix = prefixFor(label)
  const line = out.split('\n').find((l) => l.startsWith(prefix))
  return line === undefined ? undefined : line.slice(prefix.length, -2).trimEnd()
}
const rowLabels = (out) =>
  out
    .split('\n')
    .filter((l) => l.startsWith('│ '))
    .map((l) => l.slice(2, 2 + GUTTER).trimEnd())
const boxLines = (out) => out.split('\n').filter((l) => /^[╭│╰]/.test(l))
// The identity block whatever form it took — the lines before the blank one doctor prints under
// it. Needed for the clip ladder, where the frame is gone and `boxLines` sees nothing.
const identityLines = (out) => {
  const lines = out.split('\n')
  const end = lines.indexOf('')
  return end === -1 ? lines : lines.slice(0, end)
}

// Every layout the row can describe, as the doctor call that reaches it. One list, so each
// property below is asserted across all of them rather than for the one that was convenient.
const LAYOUTS = [
  ['a Homebrew Cellar', BREW_RALPH, plainDirectory(), 'Homebrew (`Cellar/ralph`)'],
  ['a pnpm global store', PNPM_RALPH, plainDirectory(), 'pnpm (global store)'],
  [
    'a yarn global store',
    '/Users/me/.config/yarn/global/node_modules/@lucasfe/ralph',
    plainDirectory(),
    'yarn (global store)',
  ],
  [
    'a bun global store',
    '/Users/me/.bun/install/global/node_modules/@lucasfe/ralph',
    plainDirectory(),
    'bun (global store)',
  ],
  ['an npx cache', NPX_RALPH, plainDirectory(), 'npx (`_npx` cache)'],
  ['a dev checkout', CHECKOUT, withGitEntry(CHECKOUT), 'linked (dev checkout)'],
  ['a symlinked install', GLOBAL_RALPH, asSymlink(), 'linked (symlinked install)'],
  ['a global npm install', GLOBAL_RALPH, plainDirectory(), 'npm or other (not probed)'],
  ['an ambiguous path', AMBIGUOUS, plainDirectory(), 'ambiguous (matches pnpm, yarn)'],
]

describe('QA #201 the hedge is honest — every value the row can take, at the surface', () => {
  it('draws every layout as its documented wording', async () => {
    // The whole vocabulary in one place, so the properties below are asserted over a list a
    // reader can check rather than over whichever layout each test happened to pick.
    for (const [name, ralphHome, installFs, expected] of LAYOUTS) {
      const { out } = await runDoctor({ extra: { ralphHome, installFs } })
      expect(rowValue(out, 'channel'), name).toBe(expected)
    }
  })

  it('takes the store wordings from the marker table rather than from doctor', async () => {
    // The channel a store install is reported as lives on the same table row as the marker that
    // recognized it (lib/install-markers.js's own argument for that). Read back OUT of the table
    // here, so a row whose wording drifted from its marker fails at the rendered surface too and
    // not only in the pure module's unit test.
    const fromTable = INSTALL_MARKERS.map((row) => row.channel)
    const rendered = []
    for (const [, ralphHome, installFs] of LAYOUTS) {
      const { out } = await runDoctor({ extra: { ralphHome, installFs } })
      rendered.push(rowValue(out, 'channel'))
    }
    for (const channel of fromTable) expect(rendered, channel).toContain(channel)
  })

  it('never renders a bare confident `npm`, on any layout', async () => {
    // THE CRITERION. `npm install -g` cannot be positively identified without spawning
    // `npm root -g`, which doctor may not do — so no value the row can take may read as an
    // assertion that npm installed this copy. The distinction is what the row is worth on a bug
    // report: a reader who cannot tell a finding from a fallback will debug a version mismatch
    // against a channel nothing observed.
    for (const [name, ralphHome, installFs] of LAYOUTS) {
      const { out } = await runDoctor({ extra: { ralphHome, installFs } })
      const value = rowValue(out, 'channel')
      expect(value, name).not.toBe('npm')
      expect(value, name).not.toBe('npm (global)')
      expect(value, name).not.toBe('npm (global store)')
      // Any value that mentions npm at all either hedges in the same breath (`npm or other (not
      // probed)`) or is about a DIFFERENT channel that happens to be spelled with those three
      // letters (`npx (\`_npx\` cache)`). What is forbidden is a value that STARTS with npm as a
      // claim and then qualifies it with something other than the hedge.
      if (/^npm\b/.test(value)) expect(value, name).toBe('npm or other (not probed)')
    }
  })

  it('says `not probed` for exactly the one layout nothing could observe', async () => {
    // The other direction, and the one a weaker test misses: the hedge must not spread. A row
    // that hedged on a Homebrew Cellar would throw away the one channel this feature can name
    // for certain, and it would look exactly as correct as the honest version.
    for (const [name, ralphHome, installFs, expected] of LAYOUTS) {
      const { out } = await runDoctor({ extra: { ralphHome, installFs } })
      const hedged = rowValue(out, 'channel').includes('not probed')
      expect(hedged, name).toBe(expected === 'npm or other (not probed)')
      // ...and the whole report says it once, in the row, and nowhere else.
      expect(out.split('not probed'), name).toHaveLength(hedged ? 2 : 1)
    }
  })

  it('keeps the install path, and anything hiding in it, out of the report', async () => {
    // The row is a wording from a closed vocabulary, never an echo of the path — which is what
    // makes it safe to print a directory nobody audited. Three things a path can carry are
    // checked: a home directory (an absolute path is a small privacy leak in a public paste), a
    // token-shaped segment (people do put credentials in paths), and control bytes (a `\n` in a
    // channel value would forge a line outside the box's width guarantee, and an ESC would leak
    // a sequence into a command that promises none).
    const hostile = [
      `/Users/alice/Cellar/ralph/npm_token=SECRETVALUE/x`,
      `/Users/alice/.npm/_npx/authorization=Bearer-SECRETVALUE/x`,
      `/Users/alice/pnpm/global/SECRETVALUE${ESC}[31m/x`,
      `/Users/alice/lib/node_modules/@lucasfe/ralph${NL}SECRETVALUE`,
    ]
    for (const ralphHome of hostile) {
      const { out, result } = await runDoctor({
        extra: { ralphHome, installFs: plainDirectory() },
      })
      expect(result.exitCode, ralphHome).toBe(0)
      expect(out, ralphHome).not.toContain('SECRETVALUE')
      expect(out, ralphHome).not.toContain('/Users/alice')
      expect(rowValue(out, 'channel'), ralphHome).not.toContain(ESC)
      // ...and the box is still a box: a forged line would show up as a seventh frame line or as
      // a line of the wrong width.
      expect(boxLines(out), ralphHome).toHaveLength(7)
      for (const line of boxLines(out)) expect([...line].length, line).toBe(60)
    }
  })

  it('answers the same way twice for the same install, and for a warm cache as for a cold one', async () => {
    // The row must be a function of the path and the two probes and NOTHING else — not the
    // cache, not the clock, not the run. A diagnostic whose channel moved between two runs of
    // the same command is a diagnostic nobody can compare against a bug report.
    for (const [name, ralphHome, installFs] of LAYOUTS) {
      const cold = await runDoctor({ extra: { ralphHome, installFs } })
      const warm = await runDoctor({
        cacheFs: warmCache('0.18.0'),
        extra: { ralphHome, installFs },
      })
      const again = await runDoctor({ extra: { ralphHome, installFs } })
      expect(rowValue(warm.out, 'channel'), name).toBe(rowValue(cold.out, 'channel'))
      expect(again.out, name).toBe(cold.out)
    }
  })
})

describe('QA #201 the row costs path matching — counted, not argued', () => {
  it('does not call a spawner it is handed, even one that would throw if it did', async () => {
    // Stronger than a call recorder: if the channel row reached for `exec` at all, this run
    // would crash rather than merely record a call. Doctor's `exec` exists for #125's Jira auth
    // row and this report resolves the source as github, so nothing may touch it.
    let calls = 0
    const exec = () => {
      calls += 1
      throw new Error('doctor must not spawn for the channel row')
    }
    for (const [name, ralphHome, installFs, expected] of LAYOUTS) {
      const { out, result } = await runDoctor({ extra: { ralphHome, installFs, exec } })
      expect(result.exitCode, name).toBe(0)
      expect(rowValue(out, 'channel'), name).toBe(expected)
    }
    expect(calls).toBe(0)
  })

  it('renders the identical row with no exec, a stub exec and a throwing exec', async () => {
    // The row's independence from the spawner, said as an equality rather than as a count: the
    // three runs differ only in a seam the row may not read, so their whole reports must match
    // to the byte.
    const bag = { ralphHome: GLOBAL_RALPH, installFs: plainDirectory() }
    const none = await runDoctor({ extra: bag })
    const stub = await runDoctor({
      extra: { ...bag, exec: async () => ({ exitCode: 0, stdout: '/usr/local/lib/node_modules', stderr: '' }) },
    })
    const throwing = await runDoctor({
      extra: {
        ...bag,
        exec: () => {
          throw new Error('nope')
        },
      },
    })
    expect(stub.out).toBe(none.out)
    expect(throwing.out).toBe(none.out)
    // ...and specifically NOT the answer a `npm root -g` probe would have licensed. A stub that
    // reported this very directory as the global root does not upgrade the hedge, because doctor
    // never asks.
    expect(rowValue(stub.out, 'channel')).toBe('npm or other (not probed)')
  })

  it('opens no socket, on any layout', async () => {
    // Belt and braces beside the import-graph walk at the bottom of this file: a static scan
    // cannot see a socket reached through an injected seam, so the capability is removed from
    // under the whole command for the duration of these runs.
    const originalFetch = globalThis.fetch
    let fetches = 0
    globalThis.fetch = () => {
      fetches += 1
      throw new Error('doctor must not open a socket')
    }
    try {
      for (const [name, ralphHome, installFs, expected] of LAYOUTS) {
        const { out, result } = await runDoctor({ extra: { ralphHome, installFs } })
        expect(result.exitCode, name).toBe(0)
        expect(rowValue(out, 'channel'), name).toBe(expected)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(fetches).toBe(0)
  })

  it('reads the install path and nothing else, on every layout', async () => {
    // The dev's suite measures this for one layout. Every layout matters because the probes
    // short-circuit differently: a checkout stops after the first, and a store path runs both.
    // What must never appear is a THIRD path — a parent directory walk, a package.json read, a
    // `node_modules` probe — because each one is a stat on a machine that may be the reason the
    // user is running this command.
    for (const [name, ralphHome, installFs, expected] of LAYOUTS) {
      const paths = []
      const spy = {
        existsSync: (p) => {
          paths.push(String(p))
          return installFs.existsSync(p)
        },
        lstatSync: (p) => {
          paths.push(String(p))
          return installFs.lstatSync(p)
        },
      }
      const { out } = await runDoctor({ extra: { ralphHome, installFs: spy } })
      expect(rowValue(out, 'channel'), name).toBe(expected)
      expect(paths.length, name).toBeLessThanOrEqual(2)
      expect(paths[0], name).toBe(join(ralphHome, '.git'))
      for (const p of paths) {
        expect(p === ralphHome || p === join(ralphHome, '.git'), `${name}: ${p}`).toBe(true)
      }
    }
    // ...and a checkout costs ONE probe, because the first one already answered.
    const paths = []
    const counting = {
      existsSync: (p) => {
        paths.push(String(p))
        return String(p) === join(CHECKOUT, '.git')
      },
      lstatSync: (p) => {
        paths.push(String(p))
        return { isSymbolicLink: () => false }
      },
    }
    await runDoctor({ extra: { ralphHome: CHECKOUT, installFs: counting } })
    expect(paths).toEqual([join(CHECKOUT, '.git')])
  })

  it('looks up NO fs method but the two probes', async () => {
    // A Proxy that throws for every property but `existsSync` and `lstatSync`. This is the
    // assertion that the row's cost is BOUNDED rather than merely small: a future edit that
    // reached for `readFileSync`, `realpathSync` or `statSync` through this seam fails here
    // instead of quietly adding a read to a command that promised two.
    const asked = []
    const installFs = new Proxy(plainDirectory(), {
      get(target, prop) {
        asked.push(String(prop))
        if (prop === 'existsSync' || prop === 'lstatSync') return target[prop]
        throw new Error(`doctor must not reach for fs.${String(prop)}`)
      },
    })
    const { out, result } = await runDoctor({ extra: { ralphHome: BREW_RALPH, installFs } })
    expect(result.exitCode).toBe(0)
    expect(rowValue(out, 'channel')).toBe('Homebrew (`Cellar/ralph`)')
    expect([...new Set(asked)].sort()).toEqual(['existsSync', 'lstatSync'])
  })

  it('writes nothing — not to the cache, not anywhere the seam can see', async () => {
    // doctor.js's own rule for the `cached` row, re-measured now that a second fact sits beside
    // it: "answered from the cache #24 writes and NOTHING else — no registry query, no socket, no
    // exec, no cache write". Compared as a whole filesystem snapshot rather
    // than as a mtime, so a rewrite of identical content would still show up as a changed
    // volume only if the bytes changed — and a NEW file anywhere would show up regardless.
    const cacheFs = warmCache('0.18.0')
    const before = JSON.stringify(cacheFs.toJSON())
    for (const [, ralphHome, installFs] of LAYOUTS) {
      await runDoctor({ cacheFs, extra: { ralphHome, installFs } })
    }
    expect(JSON.stringify(cacheFs.toJSON())).toBe(before)
  })
})

describe('QA #201 the installFs seam must be TOTAL at the command level', () => {
  // Doctor's own contract for this option, quoted from doctor.js: "Any value it cannot use
  // answers 'not a link', which is the same answer a plain directory gets". `installFs` is a
  // documented public option on an exported async function, so these are a CALLER'S values —
  // and doctor.js makes exactly this argument twice already, for `readCache` (cachedLatestVersion)
  // and for `probeJiraAuth`/`exec` (jiraAuthState): "a diagnostic that crashed over its own
  // arguments would fail in the one situation it exists for", and getting a row wrong costs a
  // line where throwing costs the whole report AND the exit code the dependency check already
  // computed.

  const seams = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', 'fs'],
    ['a boolean', false],
    ['an empty object', {}],
    ['an array', []],
    ['a function', () => {}],
    ['a null-prototype bag', Object.create(null)],
    ['non-function probes', { existsSync: 'yes', lstatSync: 'yes' }],
    ['both probes throwing', {
      existsSync: () => { throw new Error('EACCES') },
      lstatSync: () => { throw new Error('ELOOP') },
    }],
    ['probes that are throwing getters', {
      get existsSync() { throw new Error('hostile getter') },
      get lstatSync() { throw new Error('hostile getter') },
    }],
    ['a Proxy hostile on every get', new Proxy({}, { get() { throw new Error('hostile proxy') } })],
    ['lstatSync answering null', { existsSync: () => false, lstatSync: () => null }],
    ['lstatSync answering a bare object', { existsSync: () => false, lstatSync: () => ({}) }],
    ['lstatSync answering a number', { existsSync: () => false, lstatSync: () => 7 }],
  ]

  for (const [name, installFs] of seams) {
    it(`still reports the Cellar, and still exits 0, for ${name}`, async () => {
      const { out, result } = await runDoctor({ extra: { ralphHome: BREW_RALPH, installFs } })
      expect(result.exitCode, name).toBe(0)
      expect(rowValue(out, 'channel'), name).toBe('Homebrew (`Cellar/ralph`)')
    })

    it(`still hedges, and still exits 0, for ${name} on a global npm path`, async () => {
      // The other end of the precedence: a seam that cannot answer costs the two LINK answers
      // and must cost nothing else. Worth its own case because "a probe that cannot answer
      // answers no" is the one place where the safe default is not obviously safe — doctor's own
      // note weighs it and accepts a wrong WORD in a diagnostic, which is only true if the row
      // still appears.
      const { out, result } = await runDoctor({ extra: { ralphHome: GLOBAL_RALPH, installFs } })
      expect(result.exitCode, name).toBe(0)
      expect(rowValue(out, 'channel'), name).toBe('npm or other (not probed)')
    })
  }

  // THE STAT-OBJECT FAMILY, which is where the seam STOPPED being total — the defect these four
  // cases caught, and the reason they stay now that they pass.
  //
  // lib/install-markers.js's `probe` used to guard the CALL and not the expression: `probe(fs,
  // 'lstatSync', home)?.isSymbolicLink?.()` read the property and made the call OUTSIDE the try.
  // So every value below — a stat whose `isSymbolicLink` is not a function, one that throws when
  // called, one behind a throwing getter, one behind a hostile Proxy — propagated out of
  // `describeInstallChannel`, out of `installChannel`, out of `composeBanner`'s caller and out of
  // `doctorCommand` itself. The pre-#201 code wrapped the whole expression in one try and
  // answered false for all four (lib/install-markers.qa.test.js quotes the deleted helper).
  //
  // FIXED BY PASSING THE QUESTION rather than a method name: `probe` takes a thunk
  // (lib/install-markers.js:334-340) and `linkSignal` asks it
  // `probe(() => fs.lstatSync(home).isSymbolicLink())` at :289, so the stat, the property read
  // and the call are all inside the one try. That argument is written out at :277-288 and
  // :319-333. These cases STAY because the guard boundary is re-narrowable by a single edit —
  // lift any step of that expression back out of the thunk and this section is what goes red.
  //
  // WHY IT MATTERED MORE HERE THAN ONE MODULE DOWN. This is the command, and what was lost is not
  // a word in a row: `doctorCommand` never returned, so the report was truncated mid-box, the
  // dependency rows never printed, and the `{ exitCode }` the caller gates on never arrived —
  // bin/ralph.js saw a rejected promise instead. doctor.js's own note says the box "remains
  // additive OUTPUT ONLY … the exit code this function returns must never move", and this was a
  // value for which it moved from 0 to an unhandled rejection.
  //
  // THE FIRST CASE WAS THE PLAUSIBLE ONE. `?.()` short-circuits on null and undefined only, so a
  // stat that is a plain object rather than a real `Stats` — `{ isSymbolicLink: false }` from a
  // hand-rolled stub, a JSON-round-tripped or structuredClone'd stat (neither keeps its
  // methods), a wrapper that exposes the flag as a property — threw `TypeError:
  // probe(...)?.isSymbolicLink is not a function`. That is a shape a caller of a public option
  // plausibly passes, and it is the one the dev's five-value totality list does not reach.
  const hostileStats = [
    [
      'an isSymbolicLink that is not a function',
      { existsSync: () => false, lstatSync: () => ({ isSymbolicLink: false }) },
    ],
    [
      'an isSymbolicLink that throws when called',
      {
        existsSync: () => false,
        lstatSync: () => ({ isSymbolicLink: () => { throw new Error('EPERM') } }),
      },
    ],
    [
      'an isSymbolicLink behind a throwing getter',
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

  for (const [name, installFs] of hostileStats) {
    it(`does not throw out of the whole command for ${name}`, async () => {
      await expect(
        runDoctor({ extra: { ralphHome: BREW_RALPH, installFs } }),
        name,
      ).resolves.toBeTruthy()
    })

    it(`still returns an exit code and a full report for ${name}`, async () => {
      const { out, result } = await runDoctor({ extra: { ralphHome: BREW_RALPH, installFs } })
      expect(result.exitCode, name).toBe(0)
      expect(rowValue(out, 'channel'), name).toBe('Homebrew (`Cellar/ralph`)')
      // The rows that come AFTER the box are what a truncated report loses, and they are the
      // reason anybody runs this command.
      expect(out, name).toContain('All deps present.')
    })
  }
})

describe('QA #201 the ralphHome seam refuses every value that is not a path', () => {
  // The `typeof` gate in doctor.js's `installChannel` is the whole protection, and its argument
  // is worth restating because it is unusual: this is a place where REFUSING to coerce is the
  // safe act. `String(0)` is `'0'`, which `resolve` turns into a directory under the process's
  // cwd — so a coercing gate would let a diagnostic describe a directory the install has
  // nothing to do with, confidently, in a paste somebody is about to debug from.
  //
  // The dev's suite drives the blank strings, the primitives and a throwing `toString`. What is
  // added here is the family that would SUCCEED at coercion — a boxed String, a bag whose
  // `toString` returns a real store path, a Proxy that answers anything — because those are the
  // values a `try`-based gate would have accepted and named a channel for.
  const notPaths = [
    ['a boxed String holding a real store path', new String(BREW_RALPH)],
    ['a bag whose toString returns a store path', { toString: () => BREW_RALPH }],
    ['a bag whose valueOf returns a store path', { valueOf: () => BREW_RALPH }],
    ['a template-tag-shaped array of one path', [BREW_RALPH]],
    ['a Proxy that answers every get', new Proxy({}, { get: () => BREW_RALPH })],
    ['a Symbol', Symbol(BREW_RALPH)],
    ['a bigint', 0n],
    ['a number that resolves to a real directory', 0],
    ['a Date', new Date(0)],
    ['a URL object', new URL('file:///opt/homebrew/Cellar/ralph/1.0.0')],
    ['a Buffer of a path', Buffer.from(BREW_RALPH)],
    ['a function returning a path', () => BREW_RALPH],
    ['a bag whose toString throws', { toString() { throw new Error('hostile ralphHome') } }],
    ['a Proxy that throws on every get', new Proxy({}, { get() { throw new Error('hostile') } })],
  ]

  for (const [name, ralphHome] of notPaths) {
    it(`draws no row and exits 0 for ${name}`, async () => {
      const { out, result } = await runDoctor({
        extra: { ralphHome, installFs: plainDirectory() },
      })
      expect(result.exitCode, name).toBe(0)
      expect(rowLabels(out), name).not.toContain('channel')
      expect(out, name).not.toContain('Homebrew')
      expect(out, name).not.toContain('not probed')
      // The box every other doctor suite asserts, unmoved.
      expect(boxLines(out), name).toHaveLength(6)
    })
  }

  it('accepts a string subclass instance only if it really is a string primitive', () => {
    // The line the gate draws, stated as the JavaScript fact it rests on rather than as a
    // behaviour: `typeof new String(x)` is 'object'. That is why the boxed case above draws no
    // row, and it is the one thing a reader of `installChannel` has to know to see that the gate
    // is doing something.
    expect(typeof new String(BREW_RALPH)).toBe('object')
    expect(typeof BREW_RALPH).toBe('string')
  })
})

describe('QA #201 no other box moved, and the frame still holds', () => {
  it('leaves `ralph start`s and `ralph status`s fact bags without a channel', () => {
    // Source-level, because the claim is about what those commands PASS rather than about what
    // some rendering of them happens to show — a fact bag is where a row is decided, and #201's
    // guarantee is that neither command grew one. lib/banner-rows.js's `factRows` gate is the
    // mechanism; this is the premise the mechanism needs.
    for (const file of ['./start.js', './status.js']) {
      const code = codeWithoutComments(new URL(file, import.meta.url))
      expect(code, file).not.toMatch(/\bchannel\s*:/)
      expect(code, file).not.toMatch(/install-markers/)
      expect(code, file).not.toMatch(/describeInstallChannel/)
    }
  })

  it('renders the same box for those fact bags as it did before the row existed', () => {
    // ...and the rendered half of the same claim, driven through the composer both commands use.
    // The pre-#201 output for these bags is fully determined by the rows they earn, so the
    // assertion is that no `channel` line appears and the line count is what those rows imply —
    // and that adding the fact adds EXACTLY one line, which is what makes the gate a gate.
    const startFacts = {
      version: '0.17.0',
      latestVersion: null,
      cwd: '/repo',
      agent: 'claude',
      model: 'claude-opus-5',
      provenance: 'last-run',
      contextWindow: 200_000,
      source: 'github',
      repo: 'lucasfe/ralph',
      whatsNew: null,
    }
    const statusFacts = { version: '0.17.0', cwd: '/repo' }
    for (const facts of [startFacts, statusFacts]) {
      const without = composeBanner({ facts, width: 60, capabilities: { color: false } })
      expect(without.join(NL)).not.toContain('channel')
      const withChannel = composeBanner({
        facts: { ...facts, channel: 'Homebrew (`Cellar/ralph`)' },
        width: 60,
        capabilities: { color: false },
      })
      expect(withChannel).toHaveLength(without.length + 1)
      // Every OTHER line is byte-identical, and in the same order.
      expect(withChannel.filter((l) => !l.includes('channel'))).toEqual(without)
    }
  })

  it('is byte-identical to a run that passed no install path, for every unusable seam', async () => {
    // The property doctor.version-line.qa.test.js depends on WITHOUT knowing it: that suite's
    // `runDoctor` passes no `ralphHome`, so its byte-identical-across-cache-states claims are
    // only safe if the row is inert when nobody asked. Asserted here so that a future default
    // for `ralphHome` — the one thing that would break that suite — fails in this file, which is
    // the one allowed to change.
    const baseline = await runDoctor({ cacheFs: warmCache('0.18.0') })
    for (const installFs of [undefined, plainDirectory(), null, 42, {}]) {
      const { out } = await runDoctor({
        cacheFs: warmCache('0.18.0'),
        extra: { installFs },
      })
      expect(out, JSON.stringify(installFs ?? null)).toBe(baseline.out)
    }
    expect(rowLabels(baseline.out)).toEqual(['os', 'agent', 'cached', 'cwd'])
  })

  it('changes exactly one line of the report between one layout and another', async () => {
    // The row is additive, and this is what "additive" means measured rather than asserted: two
    // runs that differ only in the install layout differ in exactly one line of output.
    const runs = []
    for (const [name, ralphHome, installFs] of LAYOUTS) {
      const { out } = await runDoctor({
        cacheFs: warmCache('0.18.0'),
        extra: { ralphHome, installFs },
      })
      runs.push([name, out.split(NL)])
    }
    const [, first] = runs[0]
    for (const [name, lines] of runs.slice(1)) {
      expect(lines.length, name).toBe(first.length)
      const differing = lines.filter((line, i) => line !== first[i])
      expect(differing.length, `${name}: ${JSON.stringify(differing)}`).toBe(1)
      expect(differing[0], name).toContain('channel')
    }
  })

  it('is suppressed entirely by RALPH_BANNER=off, like every other row', async () => {
    // The knob silences a picture, and the channel is part of the picture. A row that survived
    // `off` would put a fact in the output of a command a user asked to be quiet — and, worse,
    // would be the one row that did.
    for (const value of ['off', 'OFF', ' off ']) {
      const { out, result } = await runDoctor({
        env: { RALPH_BANNER: value },
        extra: { ralphHome: BREW_RALPH, installFs: plainDirectory() },
      })
      expect(result.exitCode, value).toBe(0)
      expect(out, value).not.toContain('channel')
      expect(out, value).not.toContain('Homebrew')
      expect(boxLines(out), value).toHaveLength(0)
      // Not one byte between the command line and the first line of the report, which is what
      // `off` means in `ralph start` too.
      expect(out.startsWith(NL), value).toBe(false)
    }
  })

  it('is suppressed by RALPH_BANNER=off in ralph.config.sh as well as in the environment', async () => {
    // One knob, two places it can be set, and doctor reads the config file for exactly this
    // reason. A channel row that only honoured the environment would be a setting answering
    // differently in `ralph doctor` than in `ralph start`.
    const { out } = await runDoctor({
      extra: {
        ralphHome: BREW_RALPH,
        installFs: plainDirectory(),
        exists: () => true,
        readFile: () => 'RALPH_BANNER=off\n',
      },
    })
    expect(out).not.toContain('channel')
    expect(out).not.toContain('Homebrew')
  })

  it('degrades with the rest of the box down the whole width ladder', async () => {
    // #72's ladder: framed at the design width, a bare label/value form when a frame no longer
    // fits, and a code-point clip below that. Measured with the Homebrew wording, whose row comes
    // to 33 code points — the 8-column label gutter plus a 25-code-point value. That is a MIDDLE
    // case rather than a worst case, and the numbers are worth having straight: of the nine
    // wordings the row can take, `linked (symlinked install)` is 34 and the four-way
    // `ambiguous (matches pnpm, yarn, bun, brew)` is 49, which is the widest text #201 added;
    // `cached`'s own "unknown (no update check cached yet)" is 44. So this case exercises the
    // ladder's SHAPE, not its widest value — the four-way one is driven against the terminal in
    // the next test, at three of these widths. A broken frame is not cosmetic here: an
    // unterminated line is a line outside the width guarantee, in output people paste into an
    // issue.
    for (const columns of [60, 50, 44, 43, 40, 33, 24, 18, 12, 8, 4, 2, 1]) {
      const { out } = await runDoctor({
        cacheFs: warmCache('0.18.0'),
        extra: { ralphHome: BREW_RALPH, installFs: plainDirectory(), columns },
      })
      const lines = identityLines(out)
      const framed = lines[0].startsWith('╭')
      // The frame appears exactly where lib/banner-compose.js says it does, channel row or not:
      // the row must not push the box across its own form boundary, which is the way a new row
      // would break a narrow terminal without ever producing an over-wide line.
      expect(framed, `columns=${columns}`).toBe(columns >= BOX_MIN_WIDTH)
      // SIX identity lines in the bare form (title plus five rows), SEVEN when a frame is drawn
      // (the same plus the closing edge). Either way the channel row is one line and never two.
      expect(lines.length, `columns=${columns}`).toBe(framed ? 7 : 6)
      for (const line of lines) {
        // MEASURED IN CODE POINTS, not in `.length`: the frame glyphs and the box's ellipsis are
        // all outside the BMP-adjacent single-unit range in the sense that matters here — a
        // width asserted in UTF-16 units would pass for a line one column too wide.
        expect([...line].length, `columns=${columns}: ${line}`).toBeLessThanOrEqual(columns)
        if (framed) {
          // Every frame line opens and closes, and they are all the same width. An unterminated
          // or short line is the failure this checks.
          expect(/^[╭│╰]/.test(line), line).toBe(true)
          expect(/[╮│╯]$/.test(line), line).toBe(true)
          expect([...line].length, line).toBe([...lines[0]].length)
        } else {
          // ...and the bare form carries no frame byte at all, so nothing can be half-drawn.
          expect(/[╭╮╰╯│─]/.test(line), line).toBe(false)
        }
      }
      // The row survives as a row, wherever the clip lands. At eight columns the label is the
      // whole line, which is still a channel row and still one of six.
      const channelLine = lines.find((l) => l.replace('│ ', '').startsWith('channel'))
      if (columns >= 8) expect(channelLine, `columns=${columns}`).toBeTruthy()
    }
  })

  it('never lets a long channel value push the box wider than the terminal', async () => {
    // The ambiguity wording is the longest the vocabulary can produce — all four managers named,
    // 41 code points. The 48-column BOUND on it is already measured, and against exactly this
    // value: lib/install-markers.test.js:338-352 checks every answer the module can give against
    // `VALUE_WIDTH`, and its line 345 is the four-way path. What is distinct here is what it is
    // measured against — 48 is a constant the box guarantees at its design width, and the
    // TERMINAL is the thing that varies. So the question this test asks is the other one: when the
    // value no longer fits the window, does the box clip rather than widen? A row that widened the
    // frame past the terminal is how a long value turns into a wrapped, unreadable paste.
    const fourWay = '/x/pnpm/global/yarn/global/bun/install/global/Cellar/ralph/x'
    for (const columns of [60, 44, 24]) {
      const { out } = await runDoctor({
        extra: { ralphHome: fourWay, installFs: plainDirectory(), columns },
      })
      for (const line of identityLines(out)) {
        expect([...line].length, `columns=${columns}: ${line}`).toBeLessThanOrEqual(columns)
      }
    }
    // ...and at the design width it survives INTACT, which is the note's actual claim: 41 code
    // points inside a 48-column value column, all four managers still named. A row that clipped
    // here would drop the last manager, and the whole point of not hedging on an ambiguity is
    // that the reader can see which ones collided.
    const { out } = await runDoctor({
      extra: { ralphHome: fourWay, installFs: plainDirectory(), columns: 60 },
    })
    expect(rowValue(out, 'channel')).toBe('ambiguous (matches pnpm, yarn, bun, brew)')
  })
})

describe('QA #201 doctor reaches the pure module and still cannot reach a spawner', () => {
  // doctor.version-line.qa.test.js owns the bare-specifier spec and must keep passing
  // UNMODIFIED, which is the acceptance criterion for the whole extraction. This block does not
  // touch it — it walks the graph again, independently, to assert the two things #201 changed
  // about it and the one thing it must not have: install-markers.js is now reachable,
  // install-target.js and lib/paths.js are still not, and the walk really did visit doctor.js
  // rather than passing vacuously.
  const DOCTOR = new URL('./doctor.js', import.meta.url)

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
      // Comments stripped, for the reason the version-line spec states: doctor.js argues at
      // length about why it may not import a spawner, and that argument names one in prose.
      const src = codeWithoutComments(file)
      files.set(key, src)
      for (const spec of specifiersOf(src)) {
        if (spec.startsWith('.')) stack.push(new URL(spec, file))
        else bare.add(spec)
      }
    }
    return { files, bare }
  }

  const graph = importGraph(DOCTOR)
  const names = [...graph.files.keys()].map((f) => f.replace(/^.*\/lib\//, 'lib/'))

  it('walked a graph that really contains doctor.js and the pure module', () => {
    expect(names).toContain('lib/commands/doctor.js')
    expect(names).toContain('lib/install-markers.js')
    expect(graph.files.size).toBeGreaterThan(5)
  })

  it('cannot reach lib/install-target.js, which is the reason the split exists', () => {
    expect(names).not.toContain('lib/install-target.js')
    // ...nor the module whose only job is to hold RALPH_HOME, which is why `ralphHome` has no
    // default: lib/paths.js reaches `node:url`.
    expect(names).not.toContain('lib/paths.js')
    expect([...graph.bare]).not.toContain('node:url')
  })

  it('reaches no process spawner and no socket, transitively', () => {
    for (const spec of [
      'execa',
      'node:child_process',
      'child_process',
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dgram',
      'undici',
      'node-fetch',
    ]) {
      expect([...graph.bare], spec).not.toContain(spec)
    }
    for (const [file, src] of graph.files) {
      for (const [re, label] of [
        [/\bfetch\s*\(/, 'fetch('],
        [/\bexeca\b/, 'execa'],
        [/child_process/, 'child_process'],
        [/\bspawn(Sync)?\s*\(/, 'spawn('],
        [/\bexecSync\s*\(/, 'execSync('],
        [/\bnew\s+WebSocket\b/, 'new WebSocket'],
      ]) {
        expect(re.test(src), `${file} must not reference ${label}`).toBe(false)
      }
    }
  })

  it('keeps the two link probes as the only new capability the row spends', () => {
    // `node:fs` was already on this graph before #201 (the config read and the version cache
    // both reach it), so the row costs the specifier set nothing — that is doctor.js's own
    // argument for defaulting `installFs` here at all. Asserted so that a reader can see the
    // premise is true rather than take the note's word for it.
    expect([...graph.bare]).toContain('node:fs')
    const code = codeWithoutComments(DOCTOR)
    expect(code).toMatch(/import \{ existsSync, lstatSync \} from 'node:fs'/)
    // And the two names are used for ONE thing: the default of the injectable option, never at a
    // call site of their own. A direct call would be an unfixable read for a caller that
    // injected a seam precisely to avoid it (#41).
    expect(code).toMatch(/installFs = \{ existsSync, lstatSync \}/)
    // The LOOKBEHIND is the assertion. What is forbidden is the BARE identifier called: a call
    // through the seam object is the sanctioned shape and reaches the same function, so
    // `installFs.existsSync(p)` has to be excluded by its `.` while `row(label, existsSync(p))`
    // and `{ existsSync(p) }` must both still be caught — a pattern written in terms of the one
    // character BEFORE the name gets that backwards, because the character before a direct call
    // is usually the same space or brace it would have to allow. `\w` and `$` keep a longer name
    // ending in these letters from reading as a bare one.
    expect(code).not.toMatch(/(?<![.\w$])existsSync\s*\(/)
    expect(code).not.toMatch(/(?<![.\w$])lstatSync\s*\(/)
  })
})
