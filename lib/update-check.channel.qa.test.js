import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RALPH_HOME } from './paths.js'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import {
  fetchLatestVersion,
  resolveUpdateDecision,
  NPM_VERSION_QUERY,
  PACKAGE_NAME,
  VERSION_FORMAT,
} from './update-check.js'
import { classifyInstall } from './install-target.js'

// #199 QA augmentation — the QUERY side of "ask the channel this copy came from".
//
// The dev's lib/update-check.channel.test.js proves the two shipped descriptors
// work: the npm default is byte-identical to what #21 spawned, and the Homebrew one
// parses a real `--json=v2` document, with a 17-row table of output it cannot read.
// Every row of that table is a well-formed DESCRIPTOR carrying broken OUTPUT.
//
// This file attacks the other axis and the seams around it:
//
//   - the DESCRIPTOR itself as hostile input — null, a string, a number, an array,
//     an empty object, a non-array `argv`, an `argv` of non-strings, an unknown or
//     non-string `format`, a null-prototype bag. `fetchLatestVersion` promises it
//     never throws; a descriptor is now the second thing that can break that.
//   - the EXEC BOUNDARY under the new format seam: a synchronous throw, a
//     non-promise return, `undefined`, a stringly `exitCode`, a truthy non-boolean
//     `timedOut`, JSON on stderr with nothing on stdout — plus the exact options
//     bag the query spawns with, which is what keeps a version read from hanging
//     the command.
//   - the `--json=v2` document's REAL shape, measured on this machine (see the
//     fixture header) rather than assumed: a formula that came back as a cask,
//     several entries in `formulae`, a `revision`, and JSON shapes written to
//     pollute a prototype.
//   - the caller #199 left on npm and #200 taught to follow the channel —
//     `resolveUpdateDecision`, the weekly background check. What is pinned here is
//     what did NOT change: handed no channel it still spawns exactly #21's npm
//     query, and it still reaches for no classification of its own. Which channel a
//     caller hands it is `lib/update-gate.js`'s business, and #200's own specs
//     (`lib/update-check.decision-channel.test.js`,
//     `lib/update-gate.notice-command.test.js`) are where that lives.
//
// Hermeticity (#41): every test injects `exec`, and the one `resolveUpdateDecision`
// test injects a memfs volume, a fake home and an empty env bag, so nothing here
// queries a registry or touches this machine's cache.

function makeExec(handler = okOut('0.16.0')) {
  const calls = []
  const exec = async (cmd, args, opts) => {
    calls.push({ key: `${String(cmd)} ${Array.isArray(args) ? args.join(' ') : args}`, cmd, args, opts })
    return handler({ cmd, args, opts })
  }
  exec.calls = calls
  return exec
}

const okOut = (stdout) => async () => ({ exitCode: 0, stdout, stderr: '', timedOut: false })

// The Homebrew descriptor as SHIPPED, read off a real classification — a retyped
// twin would let this file and the table drift apart. A Cellar path classifies on
// its markers alone, so no exec and no real filesystem is involved.
const BREW_CELLAR = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'
const brewQuery = async () => {
  const target = await classifyInstall({
    ralphHome: BREW_CELLAR,
    exec: null,
    fs: Volume.fromJSON({}),
  })
  expect(target.kind).toBe('global-brew')
  return target.latest
}

// MEASURED, on this machine, `Homebrew 6.0.21-34-ga8820d0` (the same build the
// dev's comments name):
//
//   $ brew info --json=v2 jq
//   top-level keys: [ 'formulae', 'casks' ]      formulae: 1 entry, casks: 0
//   formulae[0].versions = {"stable":"1.8.2","head":"HEAD","bottle":true}
//   formulae[0].revision = 0
//
// So the fixture carries all three `versions` keys AND the sibling `revision`,
// because those are the neighbours a parser reading only `stable` has to ignore.
const brewDoc = (stable, formulaExtra = {}, docExtra = {}) =>
  JSON.stringify({
    formulae: [
      {
        name: 'ralph',
        full_name: 'lucasfe/ralph/ralph',
        revision: 0,
        versions: { stable, head: 'HEAD', bottle: true },
        ...formulaExtra,
      },
    ],
    casks: [],
    ...docExtra,
  })

describe('fetchLatestVersion — a descriptor that is not a descriptor (#199 QA)', () => {
  // Totality on the SOURCE argument. `ralph update` interpolates a failure and
  // exits 1; a throw from here would instead be a stack trace over what is only a
  // version check, and every one of these shapes is one property away from a
  // classification a future caller stubs.
  const fallsBackToNpm = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'brew info --json=v2 ralph'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', ['brew', 'info']],
    ['an empty object', {}],
    ['argv as a string', { argv: 'brew info', format: VERSION_FORMAT.SEMVER_LINE }],
    ['argv as an empty array', { argv: [], format: VERSION_FORMAT.SEMVER_LINE }],
    ['argv as an array-like object', { argv: { 0: 'brew', length: 1 }, format: VERSION_FORMAT.SEMVER_LINE }],
    ['argv as null', { argv: null, format: VERSION_FORMAT.BREW_JSON_V2, unreachable: 'the tap?' }],
    ['argv as a number', { argv: 4, format: VERSION_FORMAT.SEMVER_LINE }],
  ]

  it.each(fallsBackToNpm)('spawns the npm query for a source that is %s', async (_label, source) => {
    const exec = makeExec(okOut('0.16.0\n'))
    expect(await fetchLatestVersion(exec, 5000, source)).toBe('0.16.0')
    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0].cmd).toBe('npm')
    expect(exec.calls[0].args).toEqual(['view', PACKAGE_NAME, 'version'])
    // The FORMAT comes from the fallback too, not from the broken source: a source
    // carrying `brew-json-v2` and no argv must not be handed npm's one-line output
    // to JSON.parse. `0.16.0` coming back proves the semver-line parser ran.
  })

  it('answers null without throwing for a source whose format it does not know', async () => {
    const argv = ['brew', 'info', '--json=v2', 'ralph']
    for (const format of [undefined, null, 0, 42, '', 'semver_line', 'SEMVER_LINE', {}, [], true]) {
      const exec = makeExec(okOut(brewDoc('0.17.0')))
      await expect(fetchLatestVersion(exec, 5000, { argv, format })).resolves.toBeNull()
      // It still SPAWNED — the argv was runnable, so the failure is the parse, and
      // it happens once. A second attempt with another parser would be a guess.
      expect(exec.calls).toHaveLength(1)
      expect(exec.calls[0].cmd).toBe('brew')
    }
  })

  it('reads a null-prototype descriptor as happily as an object literal', async () => {
    // `Object.create(null)` has no `hasOwnProperty`, no prototype and no
    // `constructor`; a lookup written as anything but a plain property read would
    // break on it.
    const source = Object.assign(Object.create(null), {
      argv: ['brew', 'info', '--json=v2', 'ralph'],
      format: VERSION_FORMAT.BREW_JSON_V2,
      unreachable: 'the tap?',
    })
    const exec = makeExec(okOut(brewDoc('0.17.0')))
    expect(await fetchLatestVersion(exec, 5000, source)).toBe('0.17.0')
  })

  it('forwards a non-string argv element verbatim rather than coercing it', async () => {
    // Documented, not endorsed: validating argv here would be a second gate on a
    // value lib/install-target.js already builds from literals. What matters is the
    // failure mode — real execa rejects a non-string command, and that rejection
    // answers null like every other spawn failure.
    const stub = makeExec(okOut('0.16.0'))
    await fetchLatestVersion(stub, 5000, { argv: [42, 'x'], format: VERSION_FORMAT.SEMVER_LINE })
    expect(stub.calls[0].cmd).toBe(42)

    const throwing = makeExec(() => {
      throw new TypeError('The "file" argument must be of type string')
    })
    await expect(
      fetchLatestVersion(throwing, 5000, { argv: [42, 'x'], format: VERSION_FORMAT.SEMVER_LINE }),
    ).resolves.toBeNull()
  })

  it('runs a one-word argv with an empty argument list', async () => {
    const exec = makeExec(okOut('0.16.0'))
    expect(
      await fetchLatestVersion(exec, 5000, { argv: ['ralph-latest'], format: VERSION_FORMAT.SEMVER_LINE }),
    ).toBe('0.16.0')
    expect(exec.calls[0].cmd).toBe('ralph-latest')
    expect(exec.calls[0].args).toEqual([])
  })

  it('mutates neither the descriptor it was handed nor the shared npm one', async () => {
    // NPM_VERSION_QUERY is handed back BY IDENTITY to every non-brew layout, so a
    // write here would change the query for the whole process.
    const before = JSON.stringify(NPM_VERSION_QUERY)
    const source = { argv: ['brew', 'info', '--json=v2', 'ralph'], format: VERSION_FORMAT.BREW_JSON_V2 }
    const snapshot = JSON.stringify(source)
    await fetchLatestVersion(makeExec(okOut(brewDoc('0.17.0'))), 5000, source)
    await fetchLatestVersion(makeExec(okOut('0.16.0')), 5000)
    expect(JSON.stringify(source)).toBe(snapshot)
    expect(JSON.stringify(NPM_VERSION_QUERY)).toBe(before)
  })

  it('answers null for a crossed pair — brew output read as a version line, and back', async () => {
    // The format and the argv travel together for exactly this reason. Neither
    // mismatch may produce a version.
    const asLine = makeExec(okOut(brewDoc('0.17.0')))
    expect(
      await fetchLatestVersion(asLine, 5000, {
        argv: ['brew', 'info', '--json=v2', 'ralph'],
        format: VERSION_FORMAT.SEMVER_LINE,
      }),
    ).toBeNull()

    const asJson = makeExec(okOut('0.16.0\n'))
    expect(
      await fetchLatestVersion(asJson, 5000, {
        argv: ['npm', 'view', PACKAGE_NAME, 'version'],
        format: VERSION_FORMAT.BREW_JSON_V2,
      }),
    ).toBeNull()
  })
})

describe('fetchLatestVersion — the exec boundary under the format seam (#199 QA)', () => {
  it('bounds the brew query with exactly the two options npm gets, and nothing else', async () => {
    // The whole options bag, not a subset: an extra `shell: true` would turn a
    // version read into a shell invocation, and a missing `reject: false` would
    // turn execa's own rejection into the throw this function promises not to do.
    const exec = makeExec(okOut(brewDoc('0.17.0')))
    await fetchLatestVersion(exec, 777, await brewQuery())
    expect(Object.keys(exec.calls[0].opts).sort()).toEqual(['reject', 'timeout'])
    expect(exec.calls[0].opts).toEqual({ timeout: 777, reject: false })
  })

  it('still bounds the brew query at 5000ms when the timeout is passed as undefined', async () => {
    // The three-parameter call shape makes an explicitly-undefined middle argument
    // reachable (`fetchLatest(exec, undefined, target.latest)`), and a query with no
    // timeout is a `ralph update` that can hang.
    const exec = makeExec(okOut(brewDoc('0.17.0')))
    expect(await fetchLatestVersion(exec, undefined, await brewQuery())).toBe('0.17.0')
    expect(exec.calls[0].opts).toEqual({ timeout: 5000, reject: false })
  })

  it('answers null for a brew query that timed out, however truthy the flag is', async () => {
    for (const timedOut of [true, 'yes', 1, {}]) {
      const exec = makeExec(async () => ({ exitCode: 0, stdout: brewDoc('0.17.0'), timedOut }))
      await expect(fetchLatestVersion(exec, 5000, await brewQuery())).resolves.toBeNull()
    }
  })

  it('reads a version when timedOut is explicitly falsy', async () => {
    for (const timedOut of [false, 0, '', null, undefined]) {
      const exec = makeExec(async () => ({ exitCode: 0, stdout: brewDoc('0.17.0'), timedOut }))
      expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBe('0.17.0')
    }
  })

  it('answers null for an exitCode that is not the number 0', async () => {
    // Strict comparison, deliberately: a stub answering the STRING '0' has not
    // told us the command succeeded, and a document read out of a failed brew run
    // is the case the dev's measurement (exit 1, empty stdout) says not to trust.
    for (const exitCode of ['0', null, undefined, 0.0000001, -0.5, NaN]) {
      const exec = makeExec(async () => ({ exitCode, stdout: brewDoc('0.17.0') }))
      await expect(fetchLatestVersion(exec, 5000, await brewQuery())).resolves.toBeNull()
    }
  })

  it('never reads stderr — a document printed there is not an answer', async () => {
    const exec = makeExec(async () => ({ exitCode: 0, stdout: '', stderr: brewDoc('0.17.0') }))
    expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBeNull()
  })

  it('answers null when the result carries no stdout key at all', async () => {
    const exec = makeExec(async () => ({ exitCode: 0, timedOut: false }))
    expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBeNull()
  })

  it('survives an exec that is not async — a plain return, a throw, and undefined', async () => {
    const source = await brewQuery()

    // Returns a value rather than a promise: `await` handles it, and the brew
    // parser must not depend on having been resumed from a microtask.
    const sync = (cmd, args, opts) => {
      sync.calls.push({ cmd, args, opts })
      return { exitCode: 0, stdout: brewDoc('0.17.0'), timedOut: false }
    }
    sync.calls = []
    expect(await fetchLatestVersion(sync, 5000, source)).toBe('0.17.0')
    expect(sync.calls).toHaveLength(1)

    // Throws before ever returning a promise: the try/catch has to be around the
    // CALL, not only around the await.
    const throwsSync = () => {
      throw new Error('spawn brew ENOENT')
    }
    expect(await fetchLatestVersion(throwsSync, 5000, source)).toBeNull()

    // Returns nothing.
    expect(await fetchLatestVersion(() => undefined, 5000, source)).toBeNull()
    expect(await fetchLatestVersion(() => null, 5000, source)).toBeNull()
    expect(await fetchLatestVersion(() => 'brew said so', 5000, source)).toBeNull()
  })

  it('answers null for a thenable that rejects with a non-Error', async () => {
    const exec = () => ({
      then: (_ok, fail) => fail('brew exploded'),
    })
    expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBeNull()
  })

  it('spawns nothing at all when exec is not callable, whatever the descriptor says', async () => {
    const source = await brewQuery()
    for (const value of [null, undefined, {}, 'brew', 42, []]) {
      await expect(fetchLatestVersion(value, 5000, source)).resolves.toBeNull()
    }
  })
})

describe('fetchLatestVersion — the shape of a real `--json=v2` document (#199 QA)', () => {
  it('reads the measured document — three `versions` keys and a sibling revision', async () => {
    // The fixture header records the measurement. This is the positive control for
    // every negative below it.
    const exec = makeExec(okOut(brewDoc('0.17.0')))
    expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBe('0.17.0')
  })

  it('ignores a revision, so a formula-only rebuild reads as no new version', async () => {
    // Homebrew keeps `revision` OUT of `versions.stable` (measured: jq's revision
    // is a sibling field, and its stable is the bare upstream version). A revision
    // bump is a rebuild of the same version, so reporting the bare `stable` is
    // right — and it errs in the direction #199 accepts, under-reporting rather
    // than naming a version brew cannot fetch.
    const exec = makeExec(okOut(brewDoc('0.17.0', { revision: 2 })))
    expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBe('0.17.0')
  })

  it('answers null when the formula came back as a cask instead', async () => {
    // `brew info --json=v2 <name>` sorts its answer into `formulae` or `casks`. A
    // `ralph` cask is not the `ralph` FORMULA `brew upgrade ralph` would upgrade,
    // so this must fail closed rather than report a cask's version.
    const asCask = JSON.stringify({
      formulae: [],
      casks: [{ token: 'ralph', version: '9.9.9' }],
    })
    const exec = makeExec(okOut(asCask))
    expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBeNull()
  })

  it('takes the first entry in `formulae`, and takes it deterministically', async () => {
    // Measured: a one-formula query answers with exactly one entry (`formulae: 1
    // entry` above), so `[0]` is the only entry there is. Pinned anyway, because
    // "first" is a choice a reader could otherwise flip to "last" or to a name
    // search without any test noticing.
    const twoEntries = JSON.stringify({
      formulae: [
        { name: 'ralph', versions: { stable: '0.17.0' } },
        { name: 'ralph', versions: { stable: '9.9.9' } },
      ],
      casks: [],
    })
    for (let i = 0; i < 3; i++) {
      const exec = makeExec(okOut(twoEntries))
      expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBe('0.17.0')
    }
  })

  // These two rows differ by ONE backslash, and that difference is invisible in a
  // test name, so they are named here and measured below rather than inlined:
  // BOM_DOC begins with a real U+FEFF, ESCAPE_DOC with the six ASCII characters
  // that spell the escape. Both fail `JSON.parse`, for different reasons, which is
  // why no assertion in the table below can tell them apart.
  const BOM_DOC = '\uFEFF{"formulae":[{"versions":{"stable":"0.17.0"}}]}'
  const ESCAPE_DOC = '\\uFEFF{"formulae":[{"versions":{"stable":"0.17.0"}}]}'

  const unreadable = [
    ['a null formula entry', '{"formulae":[null],"casks":[]}'],
    ['a string formula entry', '{"formulae":["ralph"],"casks":[]}'],
    ['a null versions object', '{"formulae":[{"versions":null}],"casks":[]}'],
    ['versions as a string', '{"formulae":[{"versions":"0.17.0"}],"casks":[]}'],
    ['a stable that is an array', '{"formulae":[{"versions":{"stable":["0.17.0"]}}],"casks":[]}'],
    ['a stable that is an object', '{"formulae":[{"versions":{"stable":{"v":"0.17.0"}}}],"casks":[]}'],
    ['a stable that is boolean true', '{"formulae":[{"versions":{"stable":true}}],"casks":[]}'],
    ['a two-part stable', '{"formulae":[{"versions":{"stable":"2.55"}}],"casks":[]}'],
    ['a stable with a revision suffix', '{"formulae":[{"versions":{"stable":"0.17.0_1"}}],"casks":[]}'],
    ['a bare version line, not JSON at all', '0.17.0'],
    ['a JSON number', '2.55'],
    ['a byte-order mark ahead of the document', BOM_DOC],
    ['a literal \\uFEFF escape ahead of the document, not a BOM', ESCAPE_DOC],
    ['a JSON Lines stream', '{"formulae":[]}\n{"formulae":[{"versions":{"stable":"0.17.0"}}]}'],
    ['only an installed version', '{"formulae":[{"installed":[{"version":"0.17.0"}]}],"casks":[]}'],
    ['only a head version', '{"formulae":[{"versions":{"head":"HEAD","bottle":true}}],"casks":[]}'],
  ]

  it.each(unreadable)('answers null for %s', async (_label, stdout) => {
    const exec = makeExec(okOut(stdout))
    await expect(fetchLatestVersion(exec, 5000, await brewQuery())).resolves.toBeNull()
  })

  // What the two labels above claim, asserted rather than trusted: a row whose name
  // says BOM must really carry one. Written as escapes because this file, like every
  // source file here, is held to ASCII bytes by test/source-control-bytes.test.js.
  it('carries a real byte-order mark in one row and a bare escape in the other', () => {
    expect(BOM_DOC.charCodeAt(0)).toBe(0xfeff)
    expect(BOM_DOC.slice(1)).toBe('{"formulae":[{"versions":{"stable":"0.17.0"}}]}')
    expect(ESCAPE_DOC.charCodeAt(0)).toBe(92) // a backslash, so no BOM anywhere in it
    expect(ESCAPE_DOC).not.toContain(String.fromCharCode(0xfeff))
  })

  const polluting = [
    ['__proto__ carrying the document', '{"__proto__":{"formulae":[{"versions":{"stable":"9.9.9"}}]}}'],
    ['constructor carrying the document', '{"constructor":{"formulae":[{"versions":{"stable":"9.9.9"}}]}}'],
    ['a formula whose versions live on __proto__', '{"formulae":[{"__proto__":{"versions":{"stable":"9.9.9"}}}]}'],
    ['a prototype-shaped stable', '{"formulae":[{"versions":{"__proto__":{"stable":"9.9.9"}}}]}'],
  ]

  it.each(polluting)('answers null for %s, and pollutes no prototype', async (_label, stdout) => {
    const exec = makeExec(okOut(stdout))
    await expect(fetchLatestVersion(exec, 5000, await brewQuery())).resolves.toBeNull()
    // JSON.parse assigns `__proto__` as an OWN property rather than invoking the
    // setter, so nothing should leak — asserted rather than assumed, because a
    // parser swapped for a hand-rolled walk is exactly where that stops being true.
    expect(Object.prototype.formulae).toBeUndefined()
    expect(Object.prototype.versions).toBeUndefined()
    expect(Object.prototype.stable).toBeUndefined()
    expect({}.formulae).toBeUndefined()
  })

  it('parses a multi-megabyte document without going quadratic', async () => {
    // `brew info --json=v2` on a formula with a long description or a large
    // dependency list is a big string, and this runs inside a command holding the
    // user's terminal. A budget rather than a benchmark: linear parsing finishes in
    // milliseconds, and anything quadratic on a 4 MB input blows straight past 5 s.
    const big = brewDoc('0.17.0', { desc: 'x'.repeat(4_000_000) })
    expect(big.length).toBeGreaterThan(4_000_000)
    const exec = makeExec(okOut(big))
    const started = Date.now()
    expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBe('0.17.0')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('answers null for a multi-megabyte document it cannot read, just as fast', async () => {
    // The failing direction of the same shape: a truncated 4 MB document must not
    // be walked twice, and the semver regex must not backtrack over the payload.
    const truncated = '{"formulae":[{"desc":"' + 'x'.repeat(4_000_000)
    const exec = makeExec(okOut(truncated))
    const started = Date.now()
    await expect(fetchLatestVersion(exec, 5000, await brewQuery())).resolves.toBeNull()
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('answers null for a long non-version line on the npm format, just as fast', async () => {
    // Same guard for the other parser: `isValidSemver` runs its regex on whatever
    // the channel printed, and the padding-then-fail shape is the classic
    // backtracking trap.
    const exec = makeExec(okOut('1.0.0-' + 'a'.repeat(200_000) + '!'))
    const started = Date.now()
    await expect(fetchLatestVersion(exec)).resolves.toBeNull()
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('takes the first of tens of thousands of entries without stalling', async () => {
    const many = JSON.stringify({
      formulae: [
        { name: 'ralph', versions: { stable: '0.17.0' } },
        ...Array.from({ length: 20_000 }, (_, i) => ({
          name: `other-${i}`,
          versions: { stable: '9.9.9' },
        })),
      ],
      casks: [],
    })
    const exec = makeExec(okOut(many))
    const started = Date.now()
    expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBe('0.17.0')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('resolveUpdateDecision — npm is what it falls back to (#199 QA, #200)', () => {
  // #199 left this caller on npm outright; #200 gave it a `latestSource` and the gate
  // hands it the channel the install came from. What these tests hold is the floor
  // under that: called with no channel — every caller before #200, and the gate
  // itself on a layout it cannot place — it asks npm, with #21's argv and options
  // bag, and it finds the answer without classifying anything.
  const HOME = '/home/me'

  it('spawns exactly the npm query when handed no channel — no brew, no `npm root -g`', async () => {
    const exec = makeExec(okOut('0.17.0\n'))
    const decision = await resolveUpdateDecision({
      currentVersion: '0.16.0',
      now: () => Date.parse('2026-08-22T12:00:00.000Z'),
      exec,
      processEnv: {},
      fs: Volume.fromJSON({}),
      home: HOME,
    })
    expect(decision.source).toBe('network')
    expect(decision.latestVersion).toBe('0.17.0')
    expect(exec.calls.map((c) => c.key)).toEqual([`npm view ${PACKAGE_NAME} version`])
    expect(exec.calls[0].opts).toEqual({ timeout: 5000, reject: false })
  })

  it('does not classify the install, even for a home that is a Homebrew Cellar', async () => {
    // This module takes no `ralphHome` and has no business finding one: a channel is
    // handed IN (#200), never worked out here — that is what keeps one meaning of
    // "which channel" in `lib/install-target.js`. Driven with a Cellar-shaped home so
    // an implementation that "helpfully" classified would be visible as a second
    // spawn, and `home` is the update-check cache's directory anyway.
    const exec = makeExec(okOut('0.17.0\n'))
    await resolveUpdateDecision({
      currentVersion: '0.16.0',
      now: () => Date.parse('2026-08-22T12:00:00.000Z'),
      exec,
      processEnv: {},
      fs: Volume.fromJSON({}),
      home: '/opt/homebrew/Cellar/ralph/0.16.0',
    })
    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0].cmd).toBe('npm')
  })

  it('takes no dependency on the classification, by construction', async () => {
    // Source-level, in the idiom lib/commands/doctor.version-line.test.js uses for
    // the same class of claim: importing `classifyInstall` here is the change #199
    // declined to make and #200 still declines — #200 threads a channel through a
    // PARAMETER, so this module stays the one that queries and never the one that
    // decides. Comments are stripped first, because the prose in both issues argues
    // about install layouts at length and a guard a paragraph can trip is one people
    // learn to route around.
    const code = codeWithoutComments(new URL('./update-check.js', import.meta.url))
    expect(code).not.toMatch(/install-target/)
    expect(code).not.toMatch(/classifyInstall/)
    // The module knows how to PARSE brew's output (VERSION_FORMAT.BREW_JSON_V2 and
    // brewStableVersion live here); what it must not know is how to reach for it.
    expect(code).not.toMatch(/['"`]brew['"`]/)
  })
})

describe('the channel is chosen by descriptor, never by kind (#199 QA)', () => {
  // A sweep, because "no consumer switches on the kind string" is a claim about
  // every file rather than about the three #199 touched — and the next channel is
  // supposed to be a row in GLOBAL_STORES, not an edit in two files.
  const SHIPPED = collectShipped(RALPH_HOME)

  it('spells a `global-*` kind literal in exactly one shipped module', () => {
    const offenders = SHIPPED.filter(
      ({ path, code }) => /['"`]global-[a-z]+['"`]/.test(code) && !path.endsWith('lib/install-target.js'),
    ).map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('spells the `npm view` argv in exactly one shipped module', () => {
    // NPM_VERSION_QUERY is the only place that argv exists — a second copy is how a
    // channel-aware query quietly becomes npm-only again for one caller. Matched as
    // the PAIR (`'npm'` then `'view'` within one expression) rather than on `view`
    // alone, which `gh issue view`, `launchctl` and the Jira CLI all spell for
    // reasons that have nothing to do with a version query.
    const npmView = /['"`]npm['"`][^\n]{0,40}['"`]view['"`]/
    const spellers = SHIPPED.filter(({ code }) => npmView.test(code)).map(({ path }) =>
      path.replace(RALPH_HOME, '').replace(/^[/\\]/, ''),
    )
    expect(spellers).toEqual(['lib/update-check.js'])
  })

  it('imports VERSION_FORMAT only where a descriptor is BUILT', () => {
    // Reading a format outside the parser and the table means someone is branching
    // on the channel by hand.
    const importers = SHIPPED.filter(({ code }) => /VERSION_FORMAT/.test(code)).map(({ path }) =>
      path.replace(RALPH_HOME, '').replace(/^[/\\]/, ''),
    )
    expect(importers.sort()).toEqual(['lib/install-target.js', 'lib/update-check.js'])
  })
})

// Every shipped .js file (lib/ and bin/), comment-free, as {path, code}. Test files
// are excluded: they name kinds and argvs on purpose.
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
