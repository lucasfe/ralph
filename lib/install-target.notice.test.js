import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import {
  classifyInstall,
  NPM_GLOBAL_NOTICE_LABEL,
  NPM_GLOBAL_UPDATE_LABEL,
} from './install-target.js'
import { NPM_VERSION_QUERY, PACKAGE_NAME } from './update-check.js'

// #200: a classification already says how to UPDATE this copy (#22) and which channel
// to ask for the latest version (#199). Now it also says WHICH COMMAND A ONE-LINE
// NOTICE MAY NAME — `noticeLabel` — because lib/update-gate.js printed
// `run npm i -g @lucasfe/ralph to update` to every install there is, which on a
// Homebrew copy is an instruction to plant a second install competing on PATH.
//
// Three things make this its own field rather than a reuse of `label`:
//
//   - the notice's npm form is SHORTER than the runnable one. `label` is
//     `npm install -g @lucasfe/ralph@latest`, which is what an accepted prompt
//     spawns; the notice has said `npm i -g @lucasfe/ralph` since #24 and eight
//     suites pin those bytes, so #200 must not change what an npm user reads.
//   - a layout with NOTHING to run must name nothing. Both refusals (an npx run, a
//     linked checkout) carry `label: null` already, and a notice that filled that gap
//     with the npm form would offer the exact command the accept path then refuses.
//   - `unknown` is the opposite case: nothing to run, but something to suggest. It
//     carries the npm form, for the same reason lib/commands/update.js falls back to
//     NPM_GLOBAL_UPDATE_LABEL when it refuses to guess.
//
// Hermeticity (#41): every classification here is driven by an injected `ralphHome`
// and a memfs volume, so nothing reads this checkout — whose own layout is `linked`.

const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`
const HOME = '/Users/me'
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'

const emptyFs = () => Volume.fromJSON({})

function makeExec(stdout = `${GLOBAL_ROOT}\n`) {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    return { exitCode: 0, stdout, stderr: '' }
  }
  exec.calls = calls
  return exec
}

function fsWithSymlink(packageRoot, target = '/Users/me/repos/ralph') {
  const vol = Volume.fromJSON({ [`${target}/package.json`]: '{}' })
  vol.mkdirSync(packageRoot.slice(0, packageRoot.lastIndexOf('/')), { recursive: true })
  vol.symlinkSync(target, packageRoot)
  return vol
}

// Every layout classifyInstall can answer, with the command its notice may name.
// A table rather than separate tests for the same reason
// install-target.channel.test.js uses one: a row added to GLOBAL_STORES without a
// notice command has nowhere to hide.
const LAYOUTS = [
  ['global-npm', { ralphHome: GLOBAL_RALPH, fs: emptyFs() }, `npm i -g ${PACKAGE_NAME}`],
  [
    'global-pnpm',
    { ralphHome: `${HOME}/Library/pnpm/global/5/node_modules/@lucasfe/ralph`, fs: emptyFs() },
    `pnpm add -g ${PACKAGE_NAME}@latest`,
  ],
  [
    'global-yarn',
    { ralphHome: `${HOME}/.config/yarn/global/node_modules/@lucasfe/ralph`, fs: emptyFs() },
    `yarn global add ${PACKAGE_NAME}@latest`,
  ],
  [
    'global-bun',
    { ralphHome: `${HOME}/.bun/install/global/node_modules/@lucasfe/ralph`, fs: emptyFs() },
    `bun add -g ${PACKAGE_NAME}@latest`,
  ],
  ['global-brew', { ralphHome: BREW_RALPH, fs: emptyFs() }, 'brew upgrade ralph'],
  [
    'npx',
    { ralphHome: `${HOME}/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph`, fs: emptyFs() },
    null,
  ],
  ['linked', { ralphHome: GLOBAL_RALPH, fs: fsWithSymlink(GLOBAL_RALPH) }, null],
  [
    'linked',
    {
      ralphHome: '/Users/me/repos/ralph',
      fs: Volume.fromJSON({ '/Users/me/repos/ralph/.git/HEAD': 'ref: refs/heads/main\n' }),
    },
    null,
  ],
  ['unknown', { ralphHome: '/Users/me/somewhere/else', fs: emptyFs() }, `npm i -g ${PACKAGE_NAME}`],
  ['unknown', { ralphHome: '   ', fs: emptyFs() }, `npm i -g ${PACKAGE_NAME}`],
  [
    'unknown',
    {
      // Two managers' markers on one path: no argv, and no advice either.
      ralphHome: `${HOME}/.config/yarn/global/node_modules/pnpm/global/node_modules/@lucasfe/ralph`,
      fs: emptyFs(),
    },
    `npm i -g ${PACKAGE_NAME}`,
  ],
]

const classify = (input) => classifyInstall({ exec: makeExec(), ...input })

describe('classifyInstall — every layout says what a notice may tell the user (#200)', () => {
  it.each(LAYOUTS)('gives %s the command its notice names', async (kind, input, expected) => {
    const result = await classify(input)
    expect(result.kind).toBe(kind)
    expect(result.noticeLabel).toBe(expected)
  })

  it.each(LAYOUTS)('never leaves %s undefined — null is a decision', async (kind, input) => {
    // The field a caller reads must EXIST on every classification, so that a missing
    // one is impossible rather than merely unlikely: `undefined` and `null` print the
    // same (nothing), but only one of them is a statement about the layout.
    const result = await classify(input)
    expect('noticeLabel' in result).toBe(true)
    expect(result.noticeLabel === null || typeof result.noticeLabel === 'string').toBe(true)
    expect(result.noticeLabel).not.toBe('')
  })

  it('names a runnable layout’s own manager, never a second one', async () => {
    // The harm #200 fixes: `npm i -g` into a pnpm/yarn/bun/brew layout installs a
    // SECOND copy competing on PATH rather than updating this one, so no runnable
    // layout may name npm unless npm is what it runs.
    for (const [kind, input] of LAYOUTS) {
      const result = await classify(input)
      if (!result.argv || kind === 'global-npm') continue
      expect(result.noticeLabel).toBe(result.label)
      // The FIRST TOKEN, not a substring: `pnpm add -g` contains the three letters
      // of npm and is not an npm command, so the assertion has to be about the
      // program the user would run.
      expect(result.noticeLabel.split(' ')[0], kind).not.toBe('npm')
      expect(result.noticeLabel.split(' ')[0], kind).toBe(result.argv[0])
    }
  })
})

describe('classifyInstall — the Homebrew notice says brew and only brew (#200)', () => {
  it('names `brew upgrade <formula>`, the same command an accepted prompt runs', async () => {
    const result = await classify({ ralphHome: BREW_RALPH, fs: emptyFs() })
    expect(result.noticeLabel).toBe('brew upgrade ralph')
    expect(result.noticeLabel).toBe(result.argv.join(' '))
  })

  it('mentions no npm at all — the user-visible harm, asserted directly', async () => {
    const result = await classify({ ralphHome: BREW_RALPH, fs: emptyFs() })
    expect(result.noticeLabel).not.toMatch(/npm/i)
    expect(result.noticeLabel).not.toContain(PACKAGE_NAME)
  })
})

describe('classifyInstall — the npm notice keeps the bytes #24 shipped (#200)', () => {
  it('is `npm i -g @lucasfe/ralph`, the line eight other suites pin', async () => {
    const result = await classify({ ralphHome: GLOBAL_RALPH, fs: emptyFs() })
    expect(result.noticeLabel).toBe('npm i -g @lucasfe/ralph')
    expect(result.noticeLabel).toBe(NPM_GLOBAL_NOTICE_LABEL)
  })

  it('is the same command as the runnable label, spelled short', async () => {
    // Measured against npm 10.8.2: `npm i --help` lists `i` among the aliases of
    // `install` (`add, i, in, ins, inst, …`), and `npm config get tag` is `latest`, so
    // a bare spec resolves the tag `@latest` names. The two forms differ in SPELLING;
    // what a user pastes is what an accepted prompt would have spawned.
    const result = await classify({ ralphHome: GLOBAL_RALPH, fs: emptyFs() })
    expect(result.label).toBe(NPM_GLOBAL_UPDATE_LABEL)
    expect(result.label).toBe('npm install -g @lucasfe/ralph@latest')
    expect(result.noticeLabel).not.toBe(result.label)
    for (const form of [result.label, result.noticeLabel]) {
      const [cmd, install, global] = form.split(' ')
      expect(cmd).toBe('npm')
      expect(['i', 'install']).toContain(install)
      expect(global).toBe('-g')
      expect(form).toContain(PACKAGE_NAME)
    }
  })

  it('spells the package coordinate once, out of PACKAGE_NAME', () => {
    expect(NPM_GLOBAL_NOTICE_LABEL).toBe(`npm i -g ${PACKAGE_NAME}`)
    expect(NPM_GLOBAL_UPDATE_LABEL).toContain(PACKAGE_NAME)
  })
})

describe('classifyInstall — a layout with nothing to run names nothing (#200)', () => {
  const REFUSALS = LAYOUTS.filter(([kind]) => kind === 'npx' || kind === 'linked')

  it.each(REFUSALS)('offers %s no command the accept path would decline', async (kind, input) => {
    const result = await classify(input)
    expect(result.argv).toBeNull()
    expect(result.advice).toBeTruthy()
    expect(result.noticeLabel).toBeNull()
  })

  it('separates "nothing to run" from "nothing to suggest"', async () => {
    // Both refusals and `unknown` carry `label: null`. What tells them apart is
    // `advice` — the field lib/commands/update.js already gates its exit-0 path on —
    // so the notice command follows the same split rather than a kind allowlist.
    const npx = await classify(LAYOUTS.find(([kind]) => kind === 'npx')[1])
    const unknown = await classify({ ralphHome: '/Users/me/somewhere/else', fs: emptyFs() })
    expect([npx.label, unknown.label]).toEqual([null, null])
    expect(npx.advice).toBeTruthy()
    expect(unknown.advice).toBeNull()
    expect(npx.noticeLabel).toBeNull()
    expect(unknown.noticeLabel).toBe(NPM_GLOBAL_NOTICE_LABEL)
  })
})

describe('classifyInstall — an unrecognized layout suggests what `ralph update` does (#200)', () => {
  it('names npm, the channel it also reports versions from', async () => {
    const result = await classify({ ralphHome: '/opt/hand-built/ralph', fs: emptyFs() })
    expect(result.kind).toBe('unknown')
    expect(result.noticeLabel).toBe('npm i -g @lucasfe/ralph')
    expect(result.noticeLabel).toBe(NPM_GLOBAL_NOTICE_LABEL)
    // Same channel, same suggestion: #199 gave `unknown` the npm query for exactly
    // this reason, and a notice that named a different manager than the version it
    // just reported would be advice about two different installs.
    expect(result.latest).toBe(NPM_VERSION_QUERY)
  })
})

describe('classifyInstall — classifying without a spawn (#200)', () => {
  // lib/update-gate.js classifies on EVERY `ralph start`, including the throttled
  // runs whose whole point is to cost nothing, so it passes no exec. What that gives
  // up is pinned here: the KIND of a plain npm global install, and nothing a notice or
  // a version query can see.
  const bothWays = async (input) => ({
    probed: await classifyInstall({ exec: makeExec(), ...input }),
    pathOnly: await classifyInstall({ exec: null, ...input }),
  })

  it.each(LAYOUTS)('answers %s with the same notice command and channel', async (kind, input) => {
    const { probed, pathOnly } = await bothWays(input)
    expect(probed.kind).toBe(kind)
    expect(pathOnly.noticeLabel).toBe(probed.noticeLabel)
    expect(pathOnly.latest).toBe(probed.latest)
  })

  it.each(LAYOUTS)('changes the kind of %s only where the probe decides it', async (kind, input) => {
    const { pathOnly } = await bothWays(input)
    expect(pathOnly.kind).toBe(kind === 'global-npm' ? 'unknown' : kind)
  })

  it('says the probe was not run, rather than that it answered nothing', async () => {
    // `reason` is printed to the user by lib/commands/update.js, so it may not claim
    // an `npm root -g` that never ran came back empty.
    const pathOnly = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: null, fs: emptyFs() })
    expect(pathOnly.reason).toContain('npm root -g')
    expect(pathOnly.reason).toMatch(/not probed|was not run/i)
    expect(pathOnly.reason).not.toMatch(/did not report/)
  })

  it('still says the probe answered nothing when it really did', async () => {
    const failing = async () => ({ exitCode: 1, stdout: '', stderr: 'npm ERR!' })
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: failing, fs: emptyFs() })
    expect(result.kind).toBe('unknown')
    expect(result.reason).toContain('did not report')
  })

  it('spawns nothing for a Cellar even when an exec is available', async () => {
    // #198's property, re-asserted because #200 adds a caller that depends on it: the
    // markers decide a Homebrew install from the path alone.
    const exec = makeExec()
    const result = await classifyInstall({ ralphHome: BREW_RALPH, exec, fs: emptyFs() })
    expect(result.kind).toBe('global-brew')
    expect(exec.calls).toHaveLength(0)
  })
})
