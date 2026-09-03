import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { updateCommand } from './update.js'
import { classifyInstall } from '../install-target.js'
import { NPM_VERSION_QUERY, VERSION_FORMAT } from '../update-check.js'

// #199 QA augmentation — the COMMAND side of "ask the channel this copy came from".
//
// The dev's lib/commands/update.channel.test.js proves the happy paths: classify
// runs first, a Cellar asks the tap, the failure names brew, the by-hand hint names
// each store, and the query follows the descriptor rather than the `kind`. What it
// drives are well-formed descriptors.
//
// This file attacks what is left:
//
//   - a DESCRIPTOR THAT IS BROKEN, from a classification seam a caller supplied —
//     null, a primitive, an array, a non-array `argv`, a missing or non-string
//     `unreachable`. `updateCommand` must survive every one, and the CHANNEL IT
//     ASKED and the CHANNEL IT NAMES must be checked separately, because they are
//     decided by two different fields of the same object (`argv` in
//     fetchLatestVersion, `unreachable` here) and can therefore disagree.
//   - the descriptor TRAVELLING on every path the real `classifyInstall` produces,
//     the two refusals and the ambiguous multi-store `unknown` included — driven
//     through paths, not through stubs.
//   - the exact SPAWN OPTIONS of each step, which is where "a version read may not
//     hang the command, and an install may not be killed at 5 s" lives — and where
//     the reordering put an UNBOUNDED spawn ahead of the bounded one.
//   - the two channel-derived strings BYTE FOR BYTE, indentation included.
//   - `--force` against a tap that is BEHIND the installed version: the direction
//     #199 says is the safe one, which still prints a success line naming a version
//     older than the one installed.
//
// Hermeticity (#41): every test injects `exec` and `ralphHome`; the paths are
// synthetic, and the cases that need a filesystem answer inject a memfs volume
// through a `classify` wrapper — `updateCommand` has no `fs` seam of its own (pinned
// in update.qa.test.js).

// The ANSI pattern is built from a char code so no literal control byte lives in
// this source — a raw escape character in a test file is a nasty thing to grep for.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const strip = (s) => s.replace(ANSI, '')

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    chunks,
    output: () => strip(chunks.join('')),
    lines: () => strip(chunks.join('')).split('\n').filter(Boolean),
  }
}

function makeExec(handlers = {}) {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, options })
    if (Object.prototype.hasOwnProperty.call(handlers, key)) {
      const v = handlers[key]
      return typeof v === 'function' ? v({ cmd, args, options }) : v
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

const CURRENT = '0.15.6'
const LATEST = '0.16.0'
const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`
const USER_HOME = '/Users/me'
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'

const VIEW_KEY = 'npm view @lucasfe/ralph version'
const ROOT_KEY = 'npm root -g'
const INSTALL_KEY = 'npm install -g @lucasfe/ralph@latest'
const BREW_INFO_KEY = 'brew info --json=v2 ralph'
const BREW_UPGRADE_KEY = 'brew upgrade ralph'
const BREW_ARGV = ['brew', 'info', '--json=v2', 'ralph']

const brewInfo = (stable) => ({
  exitCode: 0,
  stdout: JSON.stringify({
    formulae: [{ name: 'ralph', revision: 0, versions: { stable, head: 'HEAD', bottle: true } }],
    casks: [],
  }),
  stderr: '',
})

const okHandlers = (overrides = {}) => ({
  [VIEW_KEY]: { exitCode: 0, stdout: `${LATEST}\n`, stderr: '' },
  [ROOT_KEY]: { exitCode: 0, stdout: `${GLOBAL_ROOT}\n`, stderr: '' },
  [INSTALL_KEY]: { exitCode: 0, stdout: '', stderr: '' },
  [BREW_INFO_KEY]: brewInfo(LATEST),
  [BREW_UPGRADE_KEY]: { exitCode: 0, stdout: '', stderr: '' },
  ...overrides,
})

const deps = ({ handlers = {}, ...overrides } = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    currentVersion: CURRENT,
    ralphHome: GLOBAL_RALPH,
    stdout,
    stderr,
    exec: makeExec(okHandlers(handlers)),
    ...overrides,
  }
}

const keysOf = (d) => d.exec.calls.map((c) => c.key)
const optsFor = (d, key) => d.exec.calls.find((c) => c.key === key)?.options
const both = (d) => `${d.stdout.output()}${d.stderr.output()}`

// The REAL classification, with the filesystem answered by memfs. `updateCommand`
// injects only `ralphHome` and `exec` into it, so the volume has to arrive through
// the seam itself.
const withFs = (vol) => (opts) => classifyInstall({ ...opts, fs: vol })
const emptyFs = () => Volume.fromJSON({})

function symlinkVol(packageRoot, target = `${USER_HOME}/repos/ralph-src`) {
  const vol = Volume.fromJSON({ [`${target}/package.json`]: '{}' })
  vol.mkdirSync(packageRoot.slice(0, packageRoot.lastIndexOf('/')), { recursive: true })
  vol.symlinkSync(target, packageRoot)
  return vol
}

const gitDirVol = (root) => Volume.fromJSON({ [`${root}/.git/HEAD`]: 'ref: refs/heads/main\n' })

// A classification with everything but the descriptor held fixed, so the only
// variable in the table below is `latest`.
const targetWith = (latest) => ({
  kind: 'global-npm',
  argv: ['npm', 'install', '-g', '@lucasfe/ralph@latest'],
  label: INSTALL_KEY,
  reason: 'installed under `npm root -g`',
  advice: null,
  latest,
})

describe('updateCommand — a classification whose descriptor is broken (#199 QA)', () => {
  // Every row makes the version query FAIL, because that is the path where the
  // descriptor is read twice: once to choose the channel and once to name it.
  const failing = () => ({
    [VIEW_KEY]: { exitCode: 1, stdout: '', stderr: 'boom' },
    [BREW_INFO_KEY]: { exitCode: 1, stdout: '', stderr: 'Error: No available formula' },
  })

  const brokenDescriptors = [
    ['null', null, VIEW_KEY],
    ['undefined', undefined, VIEW_KEY],
    ['a string', 'brew info --json=v2 ralph', VIEW_KEY],
    ['a number', 42, VIEW_KEY],
    ['a boolean', false, VIEW_KEY],
    ['an array', ['brew', 'info'], VIEW_KEY],
    ['an empty object', {}, VIEW_KEY],
    ['argv as an empty array', { argv: [], unreachable: 'nowhere?' }, VIEW_KEY],
    ['argv as a string', { argv: 'brew info', unreachable: 'nowhere?' }, VIEW_KEY],
    ['a runnable argv with no format', { argv: BREW_ARGV, unreachable: 'the tap?' }, BREW_INFO_KEY],
    ['a runnable argv with a nonsense format', { argv: BREW_ARGV, format: 'yaml', unreachable: 'the tap?' }, BREW_INFO_KEY],
  ]

  it.each(brokenDescriptors)(
    'survives a descriptor that is %s: exits 1, installs nothing',
    async (_label, latest, expectedQuery) => {
      const d = deps({ handlers: failing(), classify: async () => targetWith(latest) })
      const result = await updateCommand(d)
      expect(result).toEqual({ exitCode: 1, updated: false, from: CURRENT, to: null })
      // The channel it actually asked, and nothing after the failure.
      expect(keysOf(d)).toEqual([expectedQuery])
      expect(d.stderr.output()).toMatch(/could not read the latest published version/i)
      // The by-hand hint comes from `label`, which is intact on every row, so a
      // broken descriptor never costs the user the command they can run.
      expect(d.stdout.output()).toContain(`update by hand: ${INSTALL_KEY}`)
    },
  )

  it('names the npm registry whenever the descriptor could not say otherwise', async () => {
    for (const latest of [null, undefined, 42, {}, [], { argv: [] }, { argv: 'x' }]) {
      const d = deps({ handlers: failing(), classify: async () => targetWith(latest) })
      await updateCommand(d)
      expect(d.stderr.output()).toContain(
        '❌ Could not read the latest published version (npm registry unreachable?).',
      )
    }
  })

  it('DOCUMENTED ASYMMETRY: the channel asked and the channel named are decided by different fields', async () => {
    // `fetchLatestVersion` picks the channel from `argv`; this command picks the
    // WORDING from `unreachable`. A descriptor holding one without the other
    // therefore reports a channel it never asked — the exact shape of the #199 bug,
    // reachable again if a future GLOBAL_STORES row is half-written.
    //
    // Not reachable from anything shipped today: every row lib/install-target.js can
    // return carries both fields, and lib/install-target.channel.test.js asserts
    // that for every layout. Pinned here so the hole is a decision rather than a
    // surprise, and so a change that closes it (gating both reads on the same field)
    // has a test to update.

    // A brew wording with no runnable argv: npm was asked, the tap was blamed.
    const noArgv = deps({
      handlers: failing(),
      classify: async () =>
        targetWith({ argv: null, format: VERSION_FORMAT.BREW_JSON_V2, unreachable: 'the Homebrew tap could not be read?' }),
    })
    await updateCommand(noArgv)
    expect(keysOf(noArgv)).toEqual([VIEW_KEY])
    expect(noArgv.stderr.output()).toContain('(the Homebrew tap could not be read?)')

    // And the inverse: a runnable brew argv with no wording at all blames npm for a
    // query it never ran.
    const noWording = deps({
      handlers: failing(),
      classify: async () => targetWith({ argv: BREW_ARGV, format: VERSION_FORMAT.BREW_JSON_V2 }),
    })
    await updateCommand(noWording)
    expect(keysOf(noWording)).toEqual([BREW_INFO_KEY])
    expect(noWording.stderr.output()).toContain('(npm registry unreachable?)')
  })

  it('DOCUMENTED: a non-string `unreachable` is interpolated raw', async () => {
    // No coercion guard, because every shipped descriptor carries a string (asserted
    // per-layout in lib/install-target.channel.test.js). What lands in the message
    // for the shapes that are not:
    const cases = [
      [42, '(42)'],
      [{}, '([object Object])'],
      [['a', 'b'], '(a,b)'],
      // Empty string is not nullish, so `??` keeps it and the parens come out bare.
      ['', '()'],
      // Only null/undefined reach the npm fallback wording.
      [null, '(npm registry unreachable?)'],
      [undefined, '(npm registry unreachable?)'],
    ]
    for (const [unreachable, expected] of cases) {
      const d = deps({
        handlers: failing(),
        classify: async () => targetWith({ argv: BREW_ARGV, format: VERSION_FORMAT.BREW_JSON_V2, unreachable }),
      })
      await updateCommand(d)
      expect(d.stderr.output()).toContain(`❌ Could not read the latest published version ${expected}.`)
    }
  })

  it('keeps one write per line for every shipped descriptor', async () => {
    // The repo's one-write-per-line contract, checked where channel text is now
    // interpolated into it: each write is exactly one line.
    for (const [ralphHome, handlers] of [
      [GLOBAL_RALPH, { [VIEW_KEY]: { exitCode: 1, stdout: '', stderr: '' } }],
      [BREW_RALPH, { [BREW_INFO_KEY]: { exitCode: 1, stdout: '', stderr: '' } }],
    ]) {
      const d = deps({ ralphHome, handlers, classify: withFs(emptyFs()) })
      await updateCommand(d)
      for (const chunk of [...d.stdout.chunks, ...d.stderr.chunks]) {
        expect(strip(chunk).endsWith('\n')).toBe(true)
        expect(strip(chunk).slice(0, -1)).not.toContain('\n')
      }
    }
  })
})

describe('updateCommand — the descriptor travels on every real classification (#199 QA)', () => {
  // Through PATHS, not stubs: whichever layout `classifyInstall` decides on, the
  // query it spawns must be that layout's channel. The refusals and `unknown` are
  // the rows most likely to be forgotten, so they are the point of the table.
  const layouts = [
    ['a global npm install', GLOBAL_RALPH, emptyFs, VIEW_KEY, 1],
    ['a pnpm global store', `${USER_HOME}/Library/pnpm/global/5/node_modules/@lucasfe/ralph`, emptyFs, VIEW_KEY, 0],
    ['a yarn global store', `${USER_HOME}/.config/yarn/global/node_modules/@lucasfe/ralph`, emptyFs, VIEW_KEY, 0],
    ['a bun global store', `${USER_HOME}/.bun/install/global/node_modules/@lucasfe/ralph`, emptyFs, VIEW_KEY, 0],
    ['a Homebrew Cellar', BREW_RALPH, emptyFs, BREW_INFO_KEY, 0],
    ['an npx cache', `${USER_HOME}/.npm/_npx/1a2b3c/node_modules/@lucasfe/ralph`, emptyFs, VIEW_KEY, 0],
    ['a dev checkout', `${USER_HOME}/repos/ralph`, () => gitDirVol(`${USER_HOME}/repos/ralph`), VIEW_KEY, 0],
    ['a symlinked global install', GLOBAL_RALPH, () => symlinkVol(GLOBAL_RALPH), VIEW_KEY, 0],
    ['an unrecognized directory', `${USER_HOME}/somewhere/else`, emptyFs, VIEW_KEY, 1],
    [
      'two managers on one path',
      `${USER_HOME}/.config/yarn/global/node_modules/pnpm/global/node_modules/@lucasfe/ralph`,
      emptyFs,
      VIEW_KEY,
      0,
    ],
  ]

  it.each(layouts)('asks %s its own channel', async (_label, ralphHome, fs, expectedQuery) => {
    const d = deps({ ralphHome, classify: withFs(fs()) })
    await updateCommand(d)
    const versionQueries = keysOf(d).filter((k) => k === VIEW_KEY || k === BREW_INFO_KEY)
    expect(versionQueries).toEqual([expectedQuery])
  })

  it.each(layouts)('spawns `npm root -g` for %s only when a marker missed', async (_label, ralphHome, fs, _q, rootProbes) => {
    // The reordering makes the classification the FIRST spawn, so its own cost is
    // now paid on every path — including the ones that used to short-circuit before
    // reaching it. This pins which layouts pay it.
    const d = deps({ ralphHome, classify: withFs(fs()) })
    await updateCommand(d)
    expect(keysOf(d).filter((k) => k === ROOT_KEY)).toHaveLength(rootProbes)
  })

  it('asks npm — not the tap — for a symlinked install that lives inside a Cellar', async () => {
    // The interaction the table cannot show: the refusals are decided from the
    // package root, ABOVE the store table, so a linked install under a Cellar is a
    // `linked` refusal carrying the npm descriptor while its ADVICE names brew. Both
    // halves are deliberate (a linked copy is compared against what is published),
    // and both are asserted here so neither can be "fixed" into the other by
    // accident.
    const d = deps({ ralphHome: BREW_RALPH, classify: withFs(symlinkVol(BREW_RALPH)) })
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 0, updated: false, to: LATEST })
    expect(keysOf(d)).toEqual([VIEW_KEY])
    expect(d.stdout.output()).toContain('brew upgrade ralph')
    expect(d.stdout.output()).toContain('Nothing for Ralph to update here.')
  })

  it('fails closed on an ambiguous layout, and asks npm for the version', async () => {
    // Two managers' markers on one path is `unknown`: no argv, no advice, the npm
    // descriptor — and, because the ambiguity is decided from the path, no `npm
    // root -g` probe either.
    const d = deps({
      ralphHome: `${USER_HOME}/.config/yarn/global/node_modules/pnpm/global/node_modules/@lucasfe/ralph`,
      classify: withFs(emptyFs()),
    })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 1, updated: false, from: CURRENT, to: LATEST })
    expect(keysOf(d)).toEqual([VIEW_KEY])
    // MEASURED: the managers are named in GLOBAL_STORES order (pnpm before yarn),
    // not in the order their markers appear in the path — so the wording is stable
    // for a given pair of stores however the path is nested.
    expect(d.stdout.output()).toContain('matches more than one package manager (pnpm, yarn)')
    expect(d.stdout.output()).toContain(`   Update by hand: ${INSTALL_KEY}\n`)
  })

  it('keeps the by-hand hint on npm for `unknown`, whatever the descriptor says', async () => {
    // `unknown` has a null `label`, so the hint falls back to the npm global
    // install. It must fall back on the LABEL being absent and not on the channel:
    // a hypothetical unknown carrying a brew query still has no command of its own
    // to suggest.
    const d = deps({
      classify: async () => ({
        kind: 'unknown',
        argv: null,
        label: null,
        reason: 'nowhere recognizable',
        advice: null,
        latest: { argv: BREW_ARGV, format: VERSION_FORMAT.BREW_JSON_V2, unreachable: 'the tap?' },
      }),
    })
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 1, updated: false, to: LATEST })
    expect(keysOf(d)).toEqual([BREW_INFO_KEY])
    expect(d.stdout.output()).toContain(`   Update by hand: ${INSTALL_KEY}\n`)
  })
})

describe('updateCommand — what each step is bounded by (#199 QA)', () => {
  it('bounds the tap read at the timeout and leaves the upgrade unbounded', async () => {
    // The version read owns a timeout because it is a courtesy; `brew upgrade`
    // must not be killed at 5 s, because it compiles.
    const d = deps({ ralphHome: BREW_RALPH, classify: withFs(emptyFs()), timeoutMs: 777 })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(keysOf(d)).toEqual([BREW_INFO_KEY, BREW_UPGRADE_KEY])
    expect(optsFor(d, BREW_INFO_KEY)).toEqual({ timeout: 777, reject: false })
    expect(optsFor(d, BREW_UPGRADE_KEY)).toEqual({ reject: false })
  })

  it('bounds the npm query and leaves the global install unbounded', async () => {
    const d = deps({ classify: withFs(emptyFs()), timeoutMs: 777 })
    await updateCommand(d)
    expect(optsFor(d, VIEW_KEY)).toEqual({ timeout: 777, reject: false })
    expect(optsFor(d, INSTALL_KEY)).toEqual({ reject: false })
  })

  it('DOCUMENTED: the classification probe carries no timeout, and now runs first', async () => {
    // `npm root -g` is spawned with `reject: false` and nothing else, so `timeoutMs`
    // does not bound it. That was already true before #199 — but the probe used to
    // run AFTER the bounded query and after the up-to-date short-circuit, so an
    // up-to-date user never reached it. Since the reorder it is the first thing
    // `ralph update` spawns on the npm path, which makes it the step that decides
    // whether the command answers at all.
    const d = deps({ classify: withFs(emptyFs()), timeoutMs: 777 })
    await updateCommand(d)
    expect(keysOf(d)[0]).toBe(ROOT_KEY)
    expect(optsFor(d, ROOT_KEY)).toEqual({ reject: false })
    expect(optsFor(d, ROOT_KEY)).not.toHaveProperty('timeout')
  })

  it('still reaches the classification when the copy is already up to date', async () => {
    // The other half of the same change: the short-circuit is still on the VERSION,
    // but it now sits below a classification that has already run.
    const d = deps({
      currentVersion: LATEST,
      ralphHome: BREW_RALPH,
      classify: withFs(emptyFs()),
    })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 0, updated: false, from: LATEST, to: LATEST })
    expect(keysOf(d)).toEqual([BREW_INFO_KEY])
  })

  it('DOCUMENTED: a classification seam that cannot answer now breaks every path', async () => {
    // `target.label` is read before anything is guarded, so a `classify` that
    // resolves NULLISH or rejects takes the whole command down — including the
    // already-up-to-date path, which before #199 returned before classifying at all.
    // `classifyInstall` itself is total (its every return is an object literal), so
    // this is a seam contract rather than a live failure; it is written down because
    // the reorder is what widened which paths depend on it.
    for (const classify of [async () => null, async () => undefined]) {
      const d = deps({ currentVersion: LATEST, classify })
      await expect(updateCommand(d)).rejects.toThrow(TypeError)
    }
    const throwing = deps({
      currentVersion: LATEST,
      classify: async () => {
        throw new Error('cannot classify')
      },
    })
    await expect(updateCommand(throwing)).rejects.toThrow('cannot classify')
    // Nothing was spawned on the way out: no version query, no install.
    expect(keysOf(throwing)).toEqual([])
  })

  it('degrades to the npm channel for a classification that is a primitive', async () => {
    // MEASURED: property reads on a boxed primitive answer undefined rather than
    // throwing, so a non-nullish non-object classification behaves as "no label, no
    // descriptor, no argv" — the npm query, then the refusal-to-guess path. Worth a
    // pin because the two halves of "hostile classify" behave differently and only
    // one of them is a crash.
    const upToDate = deps({ currentVersion: LATEST, classify: async () => 42 })
    expect(await updateCommand(upToDate)).toEqual({
      exitCode: 0,
      updated: false,
      from: LATEST,
      to: LATEST,
    })
    expect(keysOf(upToDate)).toEqual([VIEW_KEY])

    const behind = deps({ classify: async () => 'a string' })
    expect(await updateCommand(behind)).toEqual({
      exitCode: 1,
      updated: false,
      from: CURRENT,
      to: LATEST,
    })
    expect(keysOf(behind)).toEqual([VIEW_KEY])
    expect(behind.stdout.output()).toContain(`   Update by hand: ${INSTALL_KEY}\n`)
  })
})

describe('updateCommand — the channel-named strings, byte for byte (#199 QA)', () => {
  it('writes the Homebrew failure exactly, indentation included', async () => {
    const d = deps({
      ralphHome: BREW_RALPH,
      classify: withFs(emptyFs()),
      handlers: { [BREW_INFO_KEY]: { exitCode: 1, stdout: '', stderr: 'Error: No available formula' } },
    })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 1, updated: false, from: CURRENT, to: null })
    expect(d.stderr.lines()).toEqual([
      '❌ Could not read the latest published version (the Homebrew tap could not be read?).',
    ])
    expect(d.stdout.lines()).toEqual(['   Try again later, or update by hand: brew upgrade ralph'])
    // The word npm appears nowhere — that is the #199 bug, stated as an absence.
    expect(both(d)).not.toMatch(/npm/i)
  })

  it('writes the npm failure exactly as it did before #199', async () => {
    const d = deps({
      classify: withFs(emptyFs()),
      handlers: { [VIEW_KEY]: { exitCode: 1, stdout: '', stderr: 'boom' } },
    })
    await updateCommand(d)
    expect(d.stderr.lines()).toEqual([
      '❌ Could not read the latest published version (npm registry unreachable?).',
    ])
    expect(d.stdout.lines()).toEqual([
      '   Try again later, or update by hand: npm install -g @lucasfe/ralph@latest',
    ])
  })

  it('writes the whole Homebrew success transcript', async () => {
    const d = deps({ ralphHome: BREW_RALPH, classify: withFs(emptyFs()) })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 0, updated: true, from: CURRENT, to: LATEST })
    expect(d.stdout.lines()).toEqual([
      'Updating Ralph 0.15.6 → 0.16.0…',
      '✅ Updated Ralph 0.15.6 → 0.16.0.',
    ])
    expect(d.stderr.output()).toBe('')
  })

  it('propagates the brew exit code, and names brew in the failure', async () => {
    const d = deps({
      ralphHome: BREW_RALPH,
      classify: withFs(emptyFs()),
      handlers: { [BREW_UPGRADE_KEY]: { exitCode: 3, stdout: '', stderr: 'Error: nope' } },
    })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 3, updated: false, from: CURRENT, to: LATEST })
    expect(d.stderr.output()).toContain('❌ Update failed: `brew upgrade ralph` exited 3.')
  })
})

describe('updateCommand — --force against a tap that is behind (#199 QA)', () => {
  it('DOCUMENTED: the reinstall line names the tap version, not the installed one', async () => {
    // The accepted staleness direction, followed one step further than the dev's
    // table goes. With the tap BEHIND the installed copy, `--force` still reinstalls
    // (that is what --force is for) — and both the success line and `to` name the
    // TAP's older version, while what is on disk is the newer one the two lines
    // above it just printed.
    //
    // Pre-existing in shape: the reinstall line has interpolated `latest` since #21,
    // and before #199 `latest` was npm's answer, which could sit behind a brew
    // install for exactly the same reason. #199 changes only which channel produces
    // the lower number. Closing it needs a second version read after the upgrade,
    // which the dev's #198 comment already names as a change of its own.
    const d = deps({
      currentVersion: '0.16.0',
      ralphHome: BREW_RALPH,
      classify: withFs(emptyFs()),
      force: true,
      handlers: { [BREW_INFO_KEY]: brewInfo('0.15.0') },
    })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 0, updated: true, from: '0.16.0', to: '0.15.0' })
    expect(d.stdout.lines()).toEqual([
      'Reinstalling Ralph 0.16.0 (--force)…',
      '✅ Reinstalled Ralph 0.15.0.',
    ])
    expect(keysOf(d)).toEqual([BREW_INFO_KEY, BREW_UPGRADE_KEY])
  })

  it('never reinstalls when the tap read failed, --force or not', async () => {
    for (const force of [true, false]) {
      const d = deps({
        ralphHome: BREW_RALPH,
        classify: withFs(emptyFs()),
        force,
        handlers: { [BREW_INFO_KEY]: { exitCode: 1, stdout: '', stderr: '' } },
      })
      const result = await updateCommand(d)
      expect(result).toMatchObject({ exitCode: 1, updated: false, to: null })
      expect(keysOf(d)).toEqual([BREW_INFO_KEY])
    }
  })

  it('reads the shared npm descriptor by identity on the paths that install', async () => {
    // The last stop on the "no copies" argument: whatever `classifyInstall` decided,
    // the object `updateCommand` hands the query is the one the classification
    // carried — not a reconstruction of it.
    const seen = []
    const d = deps({
      classify: withFs(emptyFs()),
      fetchLatest: async (_exec, _timeout, source) => {
        seen.push(source)
        return LATEST
      },
    })
    await updateCommand(d)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(NPM_VERSION_QUERY)
  })
})
