import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { Volume } from 'memfs'
import { classifyInstall, NPM_GLOBAL_UPDATE_LABEL } from './install-target.js'
import { RALPH_HOME } from './paths.js'

// QA augmentation for #21. The dev's install-target.test.js pins the two happy
// classifications (global-npm / unknown). These tests attack the SAFETY
// direction of the path-boundary check — every ambiguous or malformed input must
// fail CLOSED (kind 'unknown', argv null) so `ralph update` never runs
// an install against a copy it does not actually own — plus the exec contract
// (anything other than a clean exit-0 with usable stdout is a refusal).

function makeExec(value) {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    return typeof value === 'function' ? value({ cmd, args, options }) : value
  }
  exec.calls = calls
  return exec
}

const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`
const rootOk = (stdout = `${GLOBAL_ROOT}\n`) => makeExec({ exitCode: 0, stdout, stderr: '' })

describe('classifyInstall — path-boundary adversarial (#21 QA)', () => {
  it('treats a ralphHome equal to the global root itself as global-npm', async () => {
    const result = await classifyInstall({ ralphHome: GLOBAL_ROOT, exec: rootOk() })
    expect(result.kind).toBe('global-npm')
  })

  it('classifies a deeply nested path under the global root as global-npm', async () => {
    const result = await classifyInstall({
      ralphHome: `${GLOBAL_ROOT}/@lucasfe/ralph/lib/commands`,
      exec: rootOk(),
    })
    expect(result.kind).toBe('global-npm')
  })

  it('resolves `..` segments before comparing, so an escape out of the root is unknown', async () => {
    const result = await classifyInstall({
      ralphHome: `${GLOBAL_ROOT}/../node_modules-old/@lucasfe/ralph`,
      exec: rootOk(),
    })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
    expect(result.reason).toContain('node_modules-old')
  })

  it('does not treat a parent of the global root as inside it', async () => {
    const result = await classifyInstall({ ralphHome: '/usr/local/lib', exec: rootOk() })
    expect(result.kind).toBe('unknown')
  })

  it('fails closed when the path differs only by case (no case folding)', async () => {
    const result = await classifyInstall({
      ralphHome: '/USR/local/lib/node_modules/@lucasfe/ralph',
      exec: rootOk(),
    })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  it('trims tabs and CRLF around `npm root -g` output', async () => {
    const result = await classifyInstall({
      ralphHome: GLOBAL_RALPH,
      exec: rootOk(`\t${GLOBAL_ROOT}\r\n`),
    })
    expect(result.kind).toBe('global-npm')
  })

  it('fails closed when npm prefixes its own warning line to the root output', async () => {
    const result = await classifyInstall({
      ralphHome: GLOBAL_RALPH,
      exec: rootOk(`npm WARN config global deprecated\n${GLOBAL_ROOT}\n`),
    })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  it('resolves a relative `npm root -g` output against the cwd (characterized)', async () => {
    const result = await classifyInstall({
      ralphHome: 'node_modules/@lucasfe/ralph',
      exec: rootOk('node_modules\n'),
    })
    expect(result.kind).toBe('global-npm')
    expect(result.reason).toContain(resolve('node_modules'))
  })

  it('a null ralphHome falls back to RALPH_HOME, never to the cwd', async () => {
    // A cwd fallback fails OPEN whenever the cwd happens to sit under
    // `npm root -g`; RALPH_HOME is the only directory this copy can own.
    // #22: RALPH_HOME during a test run IS this git checkout, so the correct
    // classification is now `linked` rather than `unknown` — the assertion that
    // carries this test's intent is the reason naming RALPH_HOME.
    const result = await classifyInstall({ ralphHome: null, exec: rootOk() })
    expect(result.kind).toBe('linked')
    expect(result.argv).toBeNull()
    expect(result.reason).toContain(RALPH_HOME)
  })

  it('a whitespace-only ralphHome is unknown, never global-npm', async () => {
    const result = await classifyInstall({ ralphHome: '   ', exec: rootOk() })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })
})

describe('classifyInstall — exec contract failures all fail closed (#21 QA)', () => {
  const failures = [
    ['resolves undefined', undefined],
    ['resolves null', null],
    ['resolves without an exitCode', { stdout: GLOBAL_ROOT }],
    ['resolves with exitCode null', { exitCode: null, stdout: GLOBAL_ROOT }],
    ['resolves with a string exitCode', { exitCode: '0', stdout: GLOBAL_ROOT }],
    ['resolves with exitCode 0 and no stdout', { exitCode: 0 }],
    ['resolves with exitCode 0 and undefined stdout', { exitCode: 0, stdout: undefined }],
    ['resolves with whitespace-only stdout', { exitCode: 0, stdout: '  \t \n' }],
  ]

  for (const [label, value] of failures) {
    it(`returns unknown when \`npm root -g\` ${label}`, async () => {
      const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: makeExec(value) })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      expect(typeof result.reason).toBe('string')
      expect(result.reason.length).toBeGreaterThan(0)
    })
  }

  it('returns unknown when exec throws a non-Error value', async () => {
    const exec = async () => {
      throw 'npm exploded'
    }
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  const nonFunctions = [
    ['a string', 'npm'],
    ['a number', 42],
    ['a plain object', {}],
  ]

  for (const [label, value] of nonFunctions) {
    it(`returns unknown when exec is ${label}`, async () => {
      const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: value })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
    })
  }

  it('never spawns more than the single `npm root -g` probe', async () => {
    const exec = rootOk()
    await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(exec.calls.map((c) => c.key)).toEqual(['npm root -g'])
  })
})

describe('classifyInstall — return-shape invariants (#21 QA)', () => {
  it('argv is non-null exactly when kind is global-npm', async () => {
    const stubs = [
      { exitCode: 0, stdout: GLOBAL_ROOT },
      { exitCode: 0, stdout: '/somewhere/else' },
      { exitCode: 1, stdout: '' },
      undefined,
    ]
    for (const stub of stubs) {
      const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: makeExec(stub) })
      expect(result.argv !== null).toBe(result.kind === 'global-npm')
      expect(['global-npm', 'unknown']).toContain(result.kind)
    }
  })

  it('argv is the runnable form and label is derived from it — no empty tokens either way', async () => {
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: rootOk() })
    expect(result.argv).toEqual(['npm', 'install', '-g', '@lucasfe/ralph@latest'])
    expect(result.argv.every((t) => typeof t === 'string' && t.trim() === t && t !== '')).toBe(
      true,
    )
    expect(result.label).toBe(result.argv.join(' '))
    expect(result.label).toBe(NPM_GLOBAL_UPDATE_LABEL)
  })

  it('an unknown classification has a null label alongside its null argv', async () => {
    const result = await classifyInstall({ ralphHome: '/somewhere/else', exec: rootOk() })
    expect(result.argv).toBeNull()
    expect(result.label).toBeNull()
  })
})

// --- #22 QA -----------------------------------------------------------------
// QA augmentation for #22. The dev's install-target.test.js pins one happy case
// per kind plus the ordering rule. These tests attack the parts a single case
// per kind cannot reach:
//   1. the path-marker matcher (prefixes/suffixes, adjacency, order, case,
//      separators, `..`, markers landing in a package name instead of a store)
//   2. ambiguity — two managers matching must fail CLOSED, never pick one
//   3. the refusal ordering: linked/npx are decided before any manager guess and
//      before `npm root -g` is probed at all, in EVERY store
//   4. fs probes that cannot answer (throwing, missing, non-function, degenerate
//      return values) — they must answer "no" without ever crashing
//   5. blank / non-string ralphHome, and marker paths with a broken exec
//   6. the return shape: the same five keys for all seven kinds, `advice`
//      non-null exactly for the deliberate refusals
// Every path below is synthesized, so every case injects a stub fs: a real
// directory on this machine must never be able to decide a classification.

const USER_HOME = '/Users/me'
const CHECKOUT = `${USER_HOME}/repos/ralph`
const NPX_RALPH = `${USER_HOME}/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph`
const PNPM_RALPH = `${USER_HOME}/Library/pnpm/global/5/node_modules/@lucasfe/ralph`
const YARN_RALPH = `${USER_HOME}/.config/yarn/global/node_modules/@lucasfe/ralph`
const BUN_RALPH = `${USER_HOME}/.bun/install/global/node_modules/@lucasfe/ralph`
// Two managers' markers on one path. Was yarn + a bare `.pnpm` segment; `.pnpm`
// alone no longer means pnpm (it matched project-local installs), so the pnpm
// half is spelled with its `pnpm/global` marker instead. Same intent: a path no
// single manager can claim.
const AMBIGUOUS_RALPH = `${USER_HOME}/.config/yarn/global/node_modules/pnpm/global/node_modules/@lucasfe/ralph`
const NUL = String.fromCharCode(0)

// Nothing exists: no symlink, no .git — only path markers can classify.
const noFs = () => Volume.fromJSON({})
const gitDirFs = (root) => Volume.fromJSON({ [`${root}/.git/HEAD`]: 'ref: refs/heads/main\n' })
// `git worktree` / submodule checkouts have a .git FILE, not a directory.
const gitFileFs = (root) =>
  Volume.fromJSON({ [`${root}/.git`]: 'gitdir: /Users/me/repos/ralph/.git/worktrees/w\n' })

// A symlinked package root with nothing but a package behind it — what pnpm and
// bun leave when they link a global install out of their store.
function symlinkFs(packageRoot, target = CHECKOUT) {
  const vol = Volume.fromJSON({ [`${target}/package.json`]: '{}' })
  vol.mkdirSync(packageRoot.slice(0, packageRoot.lastIndexOf('/')), { recursive: true })
  vol.symlinkSync(target, packageRoot)
  return vol
}

// What `npm link` leaves behind: the same symlink, with a real checkout behind it.
function symlinkToCheckoutFs(packageRoot, target = `${USER_HOME}/repos/ralph-src`) {
  const vol = symlinkFs(packageRoot, target)
  vol.mkdirSync(`${target}/.git`, { recursive: true })
  vol.writeFileSync(`${target}/.git/HEAD`, 'ref: refs/heads/main\n')
  return vol
}

// A link with nothing behind it: only the symlink probe can fire.
function danglingSymlinkFs(packageRoot) {
  const vol = Volume.fromJSON({})
  vol.mkdirSync(packageRoot.slice(0, packageRoot.lastIndexOf('/')), { recursive: true })
  vol.symlinkSync('/nowhere/at/all', packageRoot)
  return vol
}

// A probe that cannot answer: both methods throw the given errno.
const throwingFs = (code) => ({
  existsSync() {
    const e = new Error(`${code}: probe failed`)
    e.code = code
    throw e
  },
  lstatSync() {
    const e = new Error(`${code}: probe failed`)
    e.code = code
    throw e
  },
})

const KINDS = ['npx', 'linked', 'global-pnpm', 'global-yarn', 'global-bun', 'global-npm', 'unknown']
const REFUSALS = ['npx', 'linked']

describe('classifyInstall — marker segments are whole and adjacent (#22 QA)', () => {
  // Near-misses: a marker that is only a prefix/suffix of a segment, spelled in
  // the wrong order, or split apart by another segment, is NOT that store.
  const nearMisses = [
    ['a pnpm store whose segment is only a prefix', `${USER_HOME}/Library/pnpm-old/global/5/node_modules/@lucasfe/ralph`],
    ['a pnpm store whose segment is only a suffix', `${USER_HOME}/Library/old-pnpm/global/5/node_modules/@lucasfe/ralph`],
    ['a virtual store spelled `.pnpmx`', `${USER_HOME}/proj/node_modules/.pnpmx/x/node_modules/@lucasfe/ralph`],
    ['a virtual store spelled `x.pnpm`', `${USER_HOME}/proj/node_modules/x.pnpm/x/node_modules/@lucasfe/ralph`],
    ['an npx cache spelled `_npxcache`', `${USER_HOME}/.npm/_npxcache/ab/node_modules/@lucasfe/ralph`],
    ['an npx cache spelled `my_npx`', `${USER_HOME}/.npm/my_npx/ab/node_modules/@lucasfe/ralph`],
    ['a yarn dir spelled `yarnglobal`', `${USER_HOME}/.config/yarnglobal/node_modules/@lucasfe/ralph`],
    ['a yarn dir spelled `yarn-global`', `${USER_HOME}/.config/yarn-global/node_modules/@lucasfe/ralph`],
    ['a yarn dir whose second segment is `globals`', `${USER_HOME}/.yarn/globals/node_modules/@lucasfe/ralph`],
    ['pnpm markers in the wrong order', `${USER_HOME}/Library/global/pnpm/5/node_modules/@lucasfe/ralph`],
    ['yarn markers in the wrong order', `${USER_HOME}/.config/global/yarn/node_modules/@lucasfe/ralph`],
    ['pnpm markers split apart', `${USER_HOME}/Library/pnpm/5/global/node_modules/@lucasfe/ralph`],
    ['bun markers with the middle segment missing', `${USER_HOME}/.bun/global/node_modules/@lucasfe/ralph`],
    ['bun markers hyphenated into one segment', `${USER_HOME}/.bun/install-global/node_modules/@lucasfe/ralph`],
  ]

  for (const [label, ralphHome] of nearMisses) {
    it(`does not recognize ${label}`, async () => {
      const exec = rootOk()
      const result = await classifyInstall({ ralphHome, exec, fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      expect(result.advice).toBeNull()
    })
  }

  // Positive controls, so the near-misses above are not passing for the wrong
  // reason (e.g. a matcher that never matches anything).
  const positions = [
    ['the very first segment', '/_npx/ab/node_modules/@lucasfe/ralph', 'npx'],
    ['the very last segment', `${USER_HOME}/.npm/_npx`, 'npx'],
    ['a repeated marker', '/x/_npx/y/_npx/z', 'npx'],
    ['a path made of nothing but markers', '/pnpm/global', 'global-pnpm'],
    ['a bun store without the leading dot', '/opt/bun/install/global/node_modules/@lucasfe/ralph', 'global-bun'],
    [
      'a marker 1000 segments deep',
      `/${Array.from({ length: 1000 }, (_, i) => `d${i}`).join('/')}/_npx/node_modules/@lucasfe/ralph`,
      'npx',
    ],
  ]

  for (const [label, ralphHome, kind] of positions) {
    it(`matches a marker at ${label}`, async () => {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe(kind)
    })
  }

  it('is case-sensitive: an upper-case marker is not recognized (fails closed)', async () => {
    for (const ralphHome of [
      `${USER_HOME}/.npm/_NPX/ab/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/Library/PNPM/global/5/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/.config/Yarn/Global/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/proj/node_modules/.PNPM/x/node_modules/@lucasfe/ralph`,
    ]) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
    }
  })

  it('matches two markers of the SAME store as that one store, not as ambiguity', async () => {
    // Repointed at yarn's two markers: pnpm's second marker (a bare `.pnpm`) was
    // dropped because it also matched project-local installs.
    const result = await classifyInstall({
      ralphHome: `${USER_HOME}/.yarn/global/yarn/global/node_modules/@lucasfe/ralph`,
      exec: rootOk(),
      fs: noFs(),
    })
    expect(result.kind).toBe('global-yarn')
    expect(result.argv).toEqual(['yarn', 'global', 'add', '@lucasfe/ralph@latest'])
  })

  it("matches pnpm's virtual store inside its global dir as global-pnpm", async () => {
    const result = await classifyInstall({
      // pnpm's own realpath form: `.pnpm` sits directly under `global/5`.
      ralphHome: `${USER_HOME}/Library/pnpm/global/5/.pnpm/x/node_modules/@lucasfe/ralph`,
      exec: rootOk(),
      fs: noFs(),
    })
    expect(result.kind).toBe('global-pnpm')
    expect(result.argv).toEqual(['pnpm', 'add', '-g', '@lucasfe/ralph@latest'])
  })
})

describe('classifyInstall — separators and `..` resolution (#22 QA)', () => {
  it('resolves `..` before matching, so an escape INTO a cache is still refused', async () => {
    const result = await classifyInstall({
      ralphHome: `${USER_HOME}/foo/../_npx/ab/node_modules/@lucasfe/ralph`,
      exec: rootOk(),
      fs: noFs(),
    })
    expect(result.kind).toBe('npx')
    expect(result.reason).not.toContain('..')
  })

  it('resolves `..` before matching, so an escape OUT of a store is not that store', async () => {
    const result = await classifyInstall({
      ralphHome: `${USER_HOME}/Library/pnpm/global/../../..`,
      exec: rootOk(),
      fs: noFs(),
    })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  it('collapses doubled and trailing separators before matching', async () => {
    for (const ralphHome of [
      `${USER_HOME}/Library/pnpm//global/5/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/Library/pnpm/global/5/node_modules/@lucasfe/ralph/`,
      `${USER_HOME}/Library/pnpm/./global/5/node_modules/@lucasfe/ralph`,
      `//Users/me/Library/pnpm/global/5/node_modules/@lucasfe/ralph`,
    ]) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('global-pnpm')
    }
  })

  it('strips a trailing separator before the symlink probe (a real lstat would follow it)', async () => {
    // POSIX lstat('link/') resolves the link's TARGET, which would report a
    // directory and lose the refusal. normalize() must strip it first.
    const result = await classifyInstall({
      ralphHome: `${GLOBAL_RALPH}/`,
      exec: rootOk(),
      fs: symlinkFs(GLOBAL_RALPH),
    })
    expect(result.kind).toBe('linked')
  })

  it('a NUL byte in a segment cannot crash a probe, and never blocks a marker', async () => {
    // Both fs probes throw ERR_INVALID_ARG_VALUE for a NUL byte; they must
    // answer "no" instead of propagating. Marker matching never touches fs.
    const withMarker = await classifyInstall({
      ralphHome: `${USER_HOME}/_npx/ab${NUL}c`,
      exec: rootOk(),
      fs: noFs(),
    })
    expect(withMarker.kind).toBe('npx')
    const withoutMarker = await classifyInstall({
      ralphHome: `${USER_HOME}/ral${NUL}ph`,
      exec: rootOk(),
      fs: noFs(),
    })
    expect(withoutMarker.kind).toBe('unknown')
  })

  it('a backslash-separated (Windows-ish) path matches no marker on POSIX (characterized)', async () => {
    // `sep` is the platform separator, so on POSIX the whole Windows path is a
    // single segment. It resolves to `unknown` — the safe direction: nothing is
    // installed and nothing is refused on a machine that cannot own that path.
    for (const ralphHome of [
      'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\ab\\node_modules\\@lucasfe\\ralph',
      'C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@lucasfe\\ralph',
    ]) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      expect(result.advice).toBeNull()
    }
  })
})

describe('classifyInstall — a marker in a package name, not a store path (#22 QA)', () => {
  it('does not read a SCOPE named @yarn as a yarn store', async () => {
    const result = await classifyInstall({
      ralphHome: `${GLOBAL_ROOT}/@yarn/global`,
      exec: rootOk(),
      fs: noFs(),
    })
    expect(result.kind).toBe('global-npm')
  })

  it('reads an npm-global package named `.pnpm` as global-npm', async () => {
    // No longer a false positive: a bare `.pnpm` segment stopped meaning pnpm
    // when the marker was tightened to require `pnpm/global`.
    const exec = rootOk()
    const result = await classifyInstall({ ralphHome: `${GLOBAL_ROOT}/.pnpm`, exec, fs: noFs() })
    expect(result.kind).toBe('global-npm')
    expect(exec.calls).toHaveLength(1)
  })

  const falsePositives = [
    ['an npm-global package named `_npx`', `${GLOBAL_ROOT}/@lucasfe/_npx`, 'npx'],
    ['an npm-global package `global` under a directory `yarn`', `${GLOBAL_ROOT}/yarn/global`, 'global-yarn'],
  ]

  for (const [label, ralphHome, kind] of falsePositives) {
    it(`reads ${label} as ${kind} instead of global-npm (characterized)`, async () => {
      // Whole-segment matching cannot tell a store directory from a package
      // whose NAME is a marker. Pinned as-is: `@lucasfe/ralph` is the only
      // package this code ever classifies, so no real path can hit these.
      const exec = rootOk()
      const result = await classifyInstall({ ralphHome, exec, fs: noFs() })
      expect(result.kind).toBe(kind)
      expect(exec.calls).toHaveLength(0)
    })
  }
})

describe('classifyInstall — a project-local pnpm install (#22 QA)', () => {
  const LOCAL_PNPM = `${USER_HOME}/proj/node_modules/.pnpm/@lucasfe+ralph@0.16.0/node_modules/@lucasfe/ralph`

  it('refuses to guess for a project-local pnpm copy', async () => {
    // Was pinned as `global-pnpm` with `pnpm add -g`, which installed a global
    // copy the user never had and reported updated:true while the running copy
    // stayed behind. The pnpm marker now requires `pnpm/global`, so a virtual
    // store outside a global dir falls closed.
    const result = await classifyInstall({ ralphHome: LOCAL_PNPM, exec: rootOk(), fs: noFs() })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
    expect(result.label).toBeNull()
    expect(result.advice).toBeNull()
  })

  it('answers the same project-local layout the same way for npm and pnpm', async () => {
    // The two managers used to disagree about the identical situation: npm failed
    // closed, pnpm got a global install. Both refuse now.
    const npmLocal = await classifyInstall({
      ralphHome: `${USER_HOME}/proj/node_modules/@lucasfe/ralph`,
      exec: rootOk(),
      fs: noFs(),
    })
    const pnpmLocal = await classifyInstall({ ralphHome: LOCAL_PNPM, exec: rootOk(), fs: noFs() })
    expect(npmLocal.kind).toBe('unknown')
    expect(pnpmLocal.kind).toBe('unknown')
    expect(npmLocal.argv).toBeNull()
    expect(pnpmLocal.argv).toBeNull()
  })

  it('still refuses when the project-local copy is a checkout', async () => {
    const result = await classifyInstall({
      ralphHome: LOCAL_PNPM,
      exec: rootOk(),
      fs: gitDirFs(LOCAL_PNPM),
    })
    expect(result.kind).toBe('linked')
    expect(result.argv).toBeNull()
  })
})

describe('classifyInstall — ambiguous manager matches fail closed (#22 QA)', () => {
  // The pnpm halves are spelled `pnpm/global` (a bare `.pnpm` no longer means
  // pnpm); each path still carries two managers' markers.
  const ambiguous = [
    ['yarn + pnpm', AMBIGUOUS_RALPH, ['pnpm', 'yarn']],
    ['pnpm + bun', `${USER_HOME}/.bun/install/global/node_modules/pnpm/global/node_modules/@lucasfe/ralph`, ['pnpm', 'bun']],
    ['yarn + bun', `${USER_HOME}/.yarn/global/bun/install/global/node_modules/@lucasfe/ralph`, ['yarn', 'bun']],
    ['all three', '/x/pnpm/global/yarn/global/bun/install/global/node_modules/@lucasfe/ralph', ['pnpm', 'yarn', 'bun']],
  ]

  for (const [label, ralphHome, managers] of ambiguous) {
    it(`refuses to pick a manager when ${label} both match`, async () => {
      const exec = rootOk()
      const result = await classifyInstall({ ralphHome, exec, fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      expect(result.label).toBeNull()
      // No advice: this is a failure to recognize, not a deliberate refusal, so
      // the caller keeps its exit 1.
      expect(result.advice).toBeNull()
      for (const manager of managers) expect(result.reason).toContain(manager)
    })

    it(`decides ambiguity for ${label} without probing npm at all`, async () => {
      const exec = rootOk()
      await classifyInstall({ ralphHome, exec, fs: noFs() })
      expect(exec.calls).toHaveLength(0)
    })

    it(`still refuses ${label} as linked when it is a checkout`, async () => {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: gitDirFs(ralphHome) })
      expect(result.kind).toBe('linked')
      expect(result.advice).toContain('git pull')
    })
  }

  it('an ambiguous path that is ALSO an npx cache is refused as npx', async () => {
    const result = await classifyInstall({
      ralphHome: `${USER_HOME}/.config/yarn/global/node_modules/pnpm/global/_npx/ab/node_modules/@lucasfe/ralph`,
      exec: rootOk(),
      fs: noFs(),
    })
    expect(result.kind).toBe('npx')
    expect(result.advice).toMatch(/npx/i)
  })
})

describe('classifyInstall — refusals are decided before any manager guess (#22 QA)', () => {
  const layouts = [
    ['an npx cache', NPX_RALPH],
    ['a pnpm global store', PNPM_RALPH],
    ['a yarn global dir', YARN_RALPH],
    ['a bun global dir', BUN_RALPH],
    ['the npm global root', GLOBAL_RALPH],
    ['an unrecognized directory', `${USER_HOME}/somewhere/else/ralph`],
    ['a path matching two managers', AMBIGUOUS_RALPH],
  ]

  // Every filesystem shape that makes a package root untouchable, each with the
  // one thing only IT can say. The invariants (linked, no argv, no npm probe)
  // live in the body, so a row only carries what distinguishes it.
  const signals = [
    ['a .git directory', gitDirFs, (r) => expect(r.advice).toContain('git pull')],
    [
      'a .git FILE (worktree/submodule)',
      gitFileFs,
      (r) => {
        // The reason says ".git entry", so it covers a file as well as a directory.
        expect(r.reason).toContain('.git')
        expect(r.reason).not.toContain('directory')
        expect(r.advice).toContain('git pull')
      },
    ],
    [
      'a symlinked root with no checkout behind it',
      symlinkFs,
      (r) => {
        // A symlinked INSTALL, not a checkout: pnpm and bun symlink their own
        // package roots, so `git pull` named a checkout that does not exist.
        expect(r.advice).not.toContain('git pull')
        expect(r.advice).not.toContain('npm install -g')
      },
    ],
    [
      'a symlink whose TARGET is a checkout (`npm link`)',
      symlinkToCheckoutFs,
      // existsSync follows the link, so this still reads as a dev checkout.
      (r) => expect(r.advice).toContain('git pull'),
    ],
    [
      'a dangling symlink',
      danglingSymlinkFs,
      // Nothing behind the link to call a checkout.
      (r) => expect(r.advice).not.toContain('git pull'),
    ],
  ]

  for (const [where, ralphHome] of layouts) {
    for (const [what, makeFs, expectAdvice] of signals) {
      it(`refuses ${what} inside ${where}`, async () => {
        const exec = rootOk()
        const result = await classifyInstall({ ralphHome, exec, fs: makeFs(ralphHome) })
        expect(result.kind).toBe('linked')
        expect(result.argv).toBeNull()
        expect(result.label).toBeNull()
        expect(result.advice.length).toBeGreaterThan(0)
        // Decided from the package root alone: npm was never asked anything,
        // whatever store markers the path carries.
        expect(exec.calls).toHaveLength(0)
        expectAdvice(result)
      })
    }
  }

  it('an npx cache nested inside a store is refused as npx, not resolved to that store', async () => {
    for (const ralphHome of [
      `${USER_HOME}/.config/yarn/global/node_modules/_npx/ab/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/Library/pnpm/global/5/node_modules/_npx/ab/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/.bun/install/global/node_modules/_npx/ab/node_modules/@lucasfe/ralph`,
    ]) {
      const exec = rootOk()
      const result = await classifyInstall({ ralphHome, exec, fs: noFs() })
      expect(result.kind).toBe('npx')
      expect(result.argv).toBeNull()
      expect(exec.calls).toHaveLength(0)
    }
  })

  it('linked wins over npx when a cache path is also a symlink', async () => {
    const result = await classifyInstall({
      ralphHome: NPX_RALPH,
      exec: rootOk(),
      fs: symlinkFs(NPX_RALPH),
    })
    expect(result.kind).toBe('linked')
    expect(result.advice).not.toContain('git pull')
  })

  it('a real pnpm/bun global install is still refused as linked, but told to use its own manager', async () => {
    // pnpm and bun link the package root into a content-addressable store, so the
    // symlink probe fires before `global-pnpm` can. The refusal direction is the
    // safe one and stays; the advice used to say "run `git pull`", naming a
    // checkout this layout does not have. It now hands back the manager's own
    // global-add command, because the path also matched that store's marker.
    const result = await classifyInstall({
      ralphHome: PNPM_RALPH,
      exec: rootOk(),
      fs: symlinkFs(PNPM_RALPH, `${USER_HOME}/Library/pnpm/store/v3/files/ab/cd`),
    })
    expect(result.kind).toBe('linked')
    expect(result.argv).toBeNull()
    expect(result.advice).toContain('pnpm add -g @lucasfe/ralph@latest')
    expect(result.advice).not.toContain('git pull')
  })

  it('names each store own command in the symlink advice, and stays generic outside them', async () => {
    const cases = [
      [PNPM_RALPH, 'pnpm add -g @lucasfe/ralph@latest'],
      [YARN_RALPH, 'yarn global add @lucasfe/ralph@latest'],
      [BUN_RALPH, 'bun add -g @lucasfe/ralph@latest'],
    ]
    for (const [ralphHome, command] of cases) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: symlinkFs(ralphHome) })
      expect(result.advice).toContain(command)
    }
    for (const ralphHome of [GLOBAL_RALPH, NPX_RALPH, AMBIGUOUS_RALPH]) {
      // No single store owns these paths, so there is no command to name.
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: symlinkFs(ralphHome) })
      expect(result.advice).toMatch(/package manager/i)
      expect(result.advice).not.toMatch(/pnpm add|yarn global add|bun add|npm install/)
    }
  })
})

describe('classifyInstall — fs probes that cannot answer (#22 QA)', () => {
  const brokenProbes = [
    ['lstatSync and existsSync throw ENOENT', throwingFs('ENOENT')],
    ['lstatSync and existsSync throw EACCES', throwingFs('EACCES')],
    ['lstatSync throws while existsSync answers no', { lstatSync: () => { throw new Error('EIO') }, existsSync: () => false }],
    ['existsSync throws while lstatSync answers no', { existsSync: () => { throw new Error('EIO') }, lstatSync: () => ({ isSymbolicLink: () => false }) }],
    ['both methods are missing', {}],
    ['lstatSync is missing', { existsSync: () => false }],
    ['existsSync is missing', { lstatSync: () => ({ isSymbolicLink: () => false }) }],
    ['the methods are not functions', { lstatSync: 'nope', existsSync: 42 }],
    ['lstatSync returns a value without isSymbolicLink', { lstatSync: () => ({}), existsSync: () => false }],
    ['lstatSync returns null', { lstatSync: () => null, existsSync: () => false }],
    ['lstatSync returns undefined', { lstatSync: () => undefined, existsSync: () => false }],
    // `false` used to belong here, when a falsy non-nullish fs made every probe
    // answer "no". It now falls back to the REAL filesystem, so it is no longer a
    // probe that cannot answer — and leaving it in this matrix would make these
    // rows consult this machine's directories. Pinned hermetically instead, in
    // "the #22 fixes, pinned against what they replaced" below.
  ]

  for (const [label, fs] of brokenProbes) {
    it(`answers "no" without crashing when ${label}`, async () => {
      // A checkout OUTSIDE any recognized layout: an unanswerable probe must
      // still leave it un-installable.
      const result = await classifyInstall({ ralphHome: CHECKOUT, exec: rootOk(), fs })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      expect(result.label).toBeNull()
    })

    it(`still recognizes a store by path alone when ${label}`, async () => {
      // Marker classification never touches the filesystem, so a broken probe
      // cannot turn a store into `unknown`.
      const result = await classifyInstall({ ralphHome: YARN_RALPH, exec: rootOk(), fs })
      expect(result.kind).toBe('global-yarn')
      expect(result.argv).toEqual(['yarn', 'global', 'add', '@lucasfe/ralph@latest'])
    })

    it(`still refuses an npx cache by path alone when ${label}`, async () => {
      const result = await classifyInstall({ ralphHome: NPX_RALPH, exec: rootOk(), fs })
      expect(result.kind).toBe('npx')
      expect(result.argv).toBeNull()
    })
  }

  it('a probe that cannot answer LOSES the linked refusal under `npm root -g` (characterized gap)', async () => {
    // The one place an unanswerable probe changes the answer for the worse: a
    // `npm link`ed root lives under `npm root -g`, so with no working probe it
    // classifies as global-npm and becomes installable. Unreachable in
    // production (updateCommand never injects an fs, and a real lstat of a
    // readable global root does not fail), pinned so a future change to the fs
    // seam has to decide deliberately.
    for (const [, fs] of brokenProbes) {
      const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: rootOk(), fs })
      expect(result.kind).toBe('global-npm')
      expect(result.argv).toEqual(['npm', 'install', '-g', '@lucasfe/ralph@latest'])
    }
  })

  it('a partial fs still refuses when the probe it DOES have says yes', async () => {
    const seesGit = await classifyInstall({
      ralphHome: GLOBAL_RALPH,
      exec: rootOk(),
      fs: { existsSync: () => true },
    })
    expect(seesGit.kind).toBe('linked')
    expect(seesGit.reason).toContain('.git')

    const seesSymlink = await classifyInstall({
      ralphHome: GLOBAL_RALPH,
      exec: rootOk(),
      fs: { lstatSync: () => ({ isSymbolicLink: () => true }) },
    })
    expect(seesSymlink.kind).toBe('linked')
    expect(seesSymlink.reason).toContain('symlink')
  })

  it('a .git symlink pointing nowhere is not a checkout (characterized)', async () => {
    // existsSync FOLLOWS symlinks, so a dangling .git link reads as absent.
    const vol = Volume.fromJSON({ [`${CHECKOUT}/package.json`]: '{}' })
    vol.symlinkSync('/nowhere/at/all', `${CHECKOUT}/.git`)
    const result = await classifyInstall({ ralphHome: CHECKOUT, exec: rootOk(), fs: vol })
    expect(result.kind).toBe('unknown')
  })

  it('defaults to the real fs when no fs is injected, and a synthesized path is not a checkout', async () => {
    for (const fs of [undefined, null]) {
      const result = await classifyInstall({ ralphHome: `${USER_HOME}/nope/ralph`, exec: rootOk(), fs })
      expect(result.kind).toBe('unknown')
    }
  })
})

describe('classifyInstall — blank, malformed and non-string ralphHome (#22 QA)', () => {
  const blanks = [
    ['an empty string', ''],
    ['spaces', '   '],
    ['a tab and a newline', '\t\n'],
    ['an empty array', []],
  ]

  for (const [label, ralphHome] of blanks) {
    it(`refuses ${label} without probing npm and without touching the cwd`, async () => {
      const exec = rootOk()
      const result = await classifyInstall({ ralphHome, exec, fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      // Reworded: `npm root -g` is the last resort, not the only test, so the
      // reason for a blank path no longer mentions it. Still pinned verbatim,
      // because it is the line `ralph update` prints.
      expect(result.reason).toBe('no install directory to classify (a blank or absent install path)')
      expect(exec.calls).toHaveLength(0)
    })
  }

  it('treats the filesystem root as a plain path, not as a store', async () => {
    const result = await classifyInstall({ ralphHome: '/', exec: rootOk(), fs: noFs() })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  const nonStrings = [
    ['a number', 42],
    ['a boolean', true],
    ['a plain object', {}],
    ['a multi-element array', ['/a', '/b']],
  ]

  for (const [label, ralphHome] of nonStrings) {
    it(`stringifies ${label} and resolves it against the cwd (characterized)`, async () => {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      expect(result.reason).toContain(resolve(String(ralphHome)))
    })
  }

  it('a single-element array behaves like the string it stringifies to (characterized)', async () => {
    const result = await classifyInstall({ ralphHome: [NPX_RALPH], exec: rootOk(), fs: noFs() })
    expect(result.kind).toBe('npx')
  })

  const brokenExecs = [
    ['null', null],
    ['a non-function', 'npm'],
    ['a function that throws', async () => { throw new Error('spawn npm ENOENT') }],
    ['a function that resolves garbage', async () => ({ exitCode: 0, stdout: '' })],
  ]

  for (const [label, exec] of brokenExecs) {
    it(`classifies a store path with no help from exec — exec is ${label}`, async () => {
      const result = await classifyInstall({ ralphHome: BUN_RALPH, exec, fs: noFs() })
      expect(result.kind).toBe('global-bun')
      expect(result.argv).toEqual(['bun', 'add', '-g', '@lucasfe/ralph@latest'])
    })

    it(`refuses an npx cache with no help from exec — exec is ${label}`, async () => {
      const result = await classifyInstall({ ralphHome: NPX_RALPH, exec, fs: noFs() })
      expect(result.kind).toBe('npx')
      expect(result.advice).toMatch(/npx/i)
    })
  }
})

describe('classifyInstall — the RALPH_HOME fallback, hermetically (#22 QA)', () => {
  // The dev's #22 change made the fallback test assert `linked`, because
  // RALPH_HOME during a test run really is this checkout. These two cases pin
  // the same intent with a STUB fs, so the fallback target is proven from the
  // path the code probes rather than from this machine's .git.
  it('probes RALPH_HOME itself for a checkout, not the cwd', async () => {
    const result = await classifyInstall({
      ralphHome: null,
      exec: rootOk(),
      fs: gitDirFs(RALPH_HOME),
    })
    expect(result.kind).toBe('linked')
    expect(result.reason).toContain(RALPH_HOME)
  })

  it('falls back to RALPH_HOME and still refuses when it is outside `npm root -g`', async () => {
    for (const ralphHome of [undefined, null]) {
      const result = await classifyInstall({ ralphHome, exec: rootOk('/opt/other\n'), fs: noFs() })
      expect(result.kind).not.toBe('global-npm')
      expect(result.argv).toBeNull()
      expect(result.reason).toContain(RALPH_HOME)
    }
  })
})

describe('classifyInstall — one return shape for all seven kinds (#22 QA)', () => {
  const layouts = [
    ['npx', NPX_RALPH, () => noFs()],
    ['linked', GLOBAL_RALPH, () => symlinkFs(GLOBAL_RALPH)],
    ['global-pnpm', PNPM_RALPH, () => noFs()],
    ['global-yarn', YARN_RALPH, () => noFs()],
    ['global-bun', BUN_RALPH, () => noFs()],
    ['global-npm', GLOBAL_RALPH, () => noFs()],
    ['unknown', `${USER_HOME}/somewhere/else`, () => noFs()],
  ]

  it('returns exactly the same five keys for every kind', async () => {
    for (const [, ralphHome, fs] of layouts) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: fs() })
      expect(Object.keys(result).sort()).toEqual(['advice', 'argv', 'kind', 'label', 'reason'])
    }
  })

  it('every kind is one of the seven, and advice is non-null exactly for the refusals', async () => {
    for (const [kind, ralphHome, fs] of layouts) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: fs() })
      expect(result.kind).toBe(kind)
      expect(KINDS).toContain(result.kind)
      expect(result.advice != null).toBe(REFUSALS.includes(result.kind))
      if (result.advice != null) expect(result.advice.length).toBeGreaterThan(0)
    }
  })

  it('argv and label are null together, and label is always argv.join(" ")', async () => {
    for (const [, ralphHome, fs] of layouts) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: fs() })
      expect(result.argv === null).toBe(result.label === null)
      if (result.argv) {
        expect(result.label).toBe(result.argv.join(' '))
        expect(result.argv.length).toBeGreaterThan(0)
        expect(result.argv.every((t) => typeof t === 'string' && t !== '' && t.trim() === t)).toBe(true)
        expect(result.argv[result.argv.length - 1]).toBe('@lucasfe/ralph@latest')
      }
    }
  })

  it('a refusal carries argv null, never an empty array (the caller gates on `argv?.length`)', async () => {
    for (const [ralphHome, fs] of [
      [NPX_RALPH, noFs()],
      [GLOBAL_RALPH, symlinkFs(GLOBAL_RALPH)],
      [CHECKOUT, gitDirFs(CHECKOUT)],
    ]) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs })
      expect(result.argv).toBeNull()
      expect(result.advice).not.toBeNull()
    }
  })

  it('holds the shape invariants across a corpus of adversarial paths', async () => {
    const corpus = [
      '',
      '/',
      '/pnpm/global',
      '/_npx',
      GLOBAL_ROOT,
      GLOBAL_RALPH,
      NPX_RALPH,
      PNPM_RALPH,
      YARN_RALPH,
      BUN_RALPH,
      AMBIGUOUS_RALPH,
      CHECKOUT,
      `${USER_HOME}/proj/node_modules/.pnpm/x/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/Library/pnpm-old/global/5/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/.npm/_npxcache/ab`,
      `${GLOBAL_ROOT}/@yarn/global`,
      'C:\\Users\\me\\AppData\\Local\\pnpm\\global',
      `${USER_HOME}/ral${NUL}ph`,
    ]
    for (const ralphHome of corpus) {
      for (const fs of [noFs(), gitDirFs(CHECKOUT), throwingFs('EACCES'), {}]) {
        const result = await classifyInstall({ ralphHome, exec: rootOk(), fs })
        expect(KINDS).toContain(result.kind)
        expect(result.argv === null).toBe(result.label === null)
        expect(result.label).toBe(result.argv ? result.argv.join(' ') : null)
        expect(result.argv != null && result.advice != null).toBe(false)
        expect(typeof result.reason).toBe('string')
        expect(result.reason.length).toBeGreaterThan(0)
        expect(result.advice == null || REFUSALS.includes(result.kind)).toBe(true)
      }
    }
  })

  it('keeps NPM_GLOBAL_UPDATE_LABEL as the manual command for every non-npm kind', async () => {
    // The label callers print when refusing is npm's, so it must stay stable.
    expect(NPM_GLOBAL_UPDATE_LABEL).toBe('npm install -g @lucasfe/ralph@latest')
  })
})

// --- #22 QA, second pass ----------------------------------------------------
// Re-verification after the four fixes. Store matching now runs ABOVE the two
// refusals, so a symlink refusal can name the manager's own command. That moved
// the COMPUTATION of the store up; these tests prove it did not move the
// DECISION: linked and npx still win over every store kind, still decide without
// `npm root -g`, and the store a path sits in only ever changes the wording.
// They also pin each fix against the behavior it replaced, and probe the
// regressions the fixes could have introduced.

// The store each path sits in, with the command that store owns.
const STORE_ROWS = [
  ['a pnpm global store', PNPM_RALPH, 'global-pnpm', 'pnpm add -g @lucasfe/ralph@latest'],
  ['a yarn global dir', YARN_RALPH, 'global-yarn', 'yarn global add @lucasfe/ralph@latest'],
  ['a bun global dir', BUN_RALPH, 'global-bun', 'bun add -g @lucasfe/ralph@latest'],
]
const STORE_COMMANDS = /pnpm add -g|yarn global add|bun add -g|npm install -g/

describe('classifyInstall — refusal ordering survives store matching (#22 QA)', () => {
  // Every layout a refusal has to outrank. The layout × fs-signal matrix itself
  // lives in "refusals are decided before any manager guess" above — these tests
  // are the parts that matrix cannot express.
  const everywhere = [
    ['an npx cache', NPX_RALPH],
    ...STORE_ROWS.map(([label, home]) => [label, home]),
    ['the npm global root', GLOBAL_RALPH],
    ['a path matching two managers', AMBIGUOUS_RALPH],
    ['an unrecognized directory', `${USER_HOME}/somewhere/else/ralph`],
  ]

  it('a linked checkout inside a pnpm store is still linked, not global-pnpm', async () => {
    // The acceptance criterion, spelled out: the checkout signal is read before
    // any package-manager classification.
    const result = await classifyInstall({ ralphHome: PNPM_RALPH, exec: rootOk(), fs: gitDirFs(PNPM_RALPH) })
    expect(result.kind).toBe('linked')
    expect(result.argv).toBeNull()
    expect(result.advice).toBe('Run `git pull` in that checkout to update it.')
    expect(result.reason).toContain('.git')
    expect(result.reason).not.toContain('global install directory')
  })

  it('the same path answers a store kind ONLY while no refusal fires', async () => {
    // Paired on one path: the store is reachable, and the refusal outranks it.
    for (const [, home, kind] of STORE_ROWS) {
      const runnable = await classifyInstall({ ralphHome: home, exec: rootOk(), fs: noFs() })
      expect(runnable.kind).toBe(kind)
      expect(runnable.argv).not.toBeNull()

      for (const makeFs of [gitDirFs, symlinkFs]) {
        const refused = await classifyInstall({ ralphHome: home, exec: rootOk(), fs: makeFs(home) })
        expect(refused.kind).toBe('linked')
        expect(refused.argv).toBeNull()
      }
    }
  })

  it('an npx path inside every store is refused as npx, and the advice never names that store', async () => {
    // The store is computed before the refusals now; it must not leak into one.
    const caches = [
      `${USER_HOME}/Library/pnpm/global/5/node_modules/_npx/ab/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/.config/yarn/global/node_modules/_npx/ab/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/.bun/install/global/node_modules/_npx/ab/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/.yarn/global/pnpm/global/_npx/ab/node_modules/@lucasfe/ralph`,
    ]
    for (const ralphHome of caches) {
      const exec = rootOk()
      const result = await classifyInstall({ ralphHome, exec, fs: noFs() })
      expect(result.kind).toBe('npx')
      expect(result.argv).toBeNull()
      expect(result.advice).toMatch(/npx/i)
      expect(result.advice).not.toMatch(STORE_COMMANDS)
      expect(exec.calls).toHaveLength(0)
    }
  })

  it('linked beats npx, and says so — not npx advice, not `git pull`', async () => {
    // Strengthened back: the round-1 version pinned the advice text that changed,
    // so this asserts which refusal WON rather than which words it used.
    const exec = rootOk()
    const result = await classifyInstall({ ralphHome: NPX_RALPH, exec, fs: symlinkFs(NPX_RALPH) })
    expect(result.kind).toBe('linked')
    expect(result.argv).toBeNull()
    expect(result.advice).toMatch(/linked install/i)
    expect(result.advice).not.toMatch(/npx/i)
    expect(result.advice).not.toContain('git pull')
    expect(exec.calls).toHaveLength(0)
  })

  it('refuses without npm even when exec would blow up', async () => {
    // Proof by contradiction that `npm root -g` is not on the refusal path.
    const boom = () => {
      throw new Error('npm must not be spawned for a refusal')
    }
    for (const [, home] of everywhere) {
      expect((await classifyInstall({ ralphHome: home, exec: boom, fs: gitDirFs(home) })).kind).toBe('linked')
      expect((await classifyInstall({ ralphHome: home, exec: boom, fs: symlinkFs(home) })).kind).toBe('linked')
    }
    expect((await classifyInstall({ ralphHome: NPX_RALPH, exec: boom, fs: noFs() })).kind).toBe('npx')
  })

  it('a store still decides without npm, and ambiguity still fails closed above it', async () => {
    for (const [, home, kind] of STORE_ROWS) {
      const exec = rootOk()
      expect((await classifyInstall({ ralphHome: home, exec, fs: noFs() })).kind).toBe(kind)
      expect(exec.calls).toHaveLength(0)
    }
    const exec = rootOk()
    const ambiguous = await classifyInstall({ ralphHome: AMBIGUOUS_RALPH, exec, fs: noFs() })
    expect(ambiguous.kind).toBe('unknown')
    expect(ambiguous.argv).toBeNull()
    expect(exec.calls).toHaveLength(0)
  })
})

describe('classifyInstall — the #22 fixes, pinned against what they replaced (#22 QA)', () => {
  it('fix 1: no project-local pnpm layout answers `pnpm add -g`', async () => {
    const localCopies = [
      `${USER_HOME}/proj/node_modules/.pnpm/@lucasfe+ralph@0.16.0/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/proj/node_modules/.pnpm/x/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/proj/packages/app/node_modules/.pnpm/@lucasfe+ralph@0.16.0/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/proj/node_modules/.pnpm/node_modules/@lucasfe/ralph`,
      `/srv/ci/build/node_modules/.pnpm/@lucasfe+ralph@0.16.0/node_modules/@lucasfe/ralph`,
    ]
    for (const ralphHome of localCopies) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      expect(result.advice).toBeNull()
    }
  })

  it('fix 2: a symlinked root names its own store command, and a dangling one still does', async () => {
    for (const [, home, , command] of STORE_ROWS) {
      for (const makeFs of [symlinkFs, danglingSymlinkFs]) {
        const result = await classifyInstall({ ralphHome: home, exec: rootOk(), fs: makeFs(home) })
        expect(result.kind).toBe('linked')
        expect(result.advice).toContain(command)
        expect(result.advice).not.toContain('git pull')
      }
    }
  })

  it('fix 2: a symlink whose target is a checkout still says `git pull`, in every store', async () => {
    for (const [, home] of STORE_ROWS) {
      const result = await classifyInstall({
        ralphHome: home,
        exec: rootOk(),
        fs: symlinkToCheckoutFs(home),
      })
      expect(result.kind).toBe('linked')
      expect(result.advice).toBe('Run `git pull` in that checkout to update it.')
      expect(result.advice).not.toMatch(STORE_COMMANDS)
    }
  })

  it('fix 4: a falsy non-nullish fs falls back to the real filesystem', async () => {
    // RALPH_HOME during a test run is this repository, which really does have a
    // .git entry — the only real path in this file, and the point of the test.
    for (const falsy of [false, 0, '', Number.NaN]) {
      const result = await classifyInstall({ ralphHome: RALPH_HOME, exec: rootOk(), fs: falsy })
      expect(result.kind).toBe('linked')
      expect(result.reason).toContain('.git')
    }
    // Control: a stub fs that sees nothing answers differently for that same
    // path, so the four cases above prove the fallback and not the path.
    const stubbed = await classifyInstall({ ralphHome: RALPH_HOME, exec: rootOk(), fs: noFs() })
    expect(stubbed.kind).not.toBe('linked')
  })

  it('fix 4: a falsy fs can no longer turn a real checkout under `npm root -g` into an install', async () => {
    // The defect this replaced: `fs ?? real` accepted `false` as an fs, every
    // probe answered "no", and a checkout inside `npm root -g` came back
    // `global-npm` WITH an argv — `npm install -g` over a working tree.
    const parent = resolve(RALPH_HOME, '..')
    for (const falsy of [false, 0, '', Number.NaN]) {
      const result = await classifyInstall({
        ralphHome: RALPH_HOME,
        exec: rootOk(`${parent}\n`),
        fs: falsy,
      })
      expect(result.kind).toBe('linked')
      expect(result.argv).toBeNull()
    }
  })

  it('a truthy but empty fs stub is still honoured, and never reaches the real fs (characterized)', async () => {
    // Only falsy values fall back. `{}` and a bare function are objects a caller
    // meant as an fs, so their silence is taken at face value — which is what
    // keeps every other test in this file hermetic.
    const parent = resolve(RALPH_HOME, '..')
    for (const fs of [{}, () => {}, { existsSync: () => false }]) {
      const result = await classifyInstall({ ralphHome: RALPH_HOME, exec: rootOk(`${parent}\n`), fs })
      expect(result.kind).toBe('global-npm')
    }
  })
})

describe('classifyInstall — regressions the #22 fixes could have introduced (#22 QA)', () => {
  const pnpmGlobals = [
    ['the macOS PNPM_HOME default', `${USER_HOME}/Library/pnpm/global/5/node_modules/@lucasfe/ralph`],
    ['the XDG PNPM_HOME default', `${USER_HOME}/.local/share/pnpm/global/5/node_modules/@lucasfe/ralph`],
    ['a PNPM_HOME under /opt', '/opt/pnpm/global/5/node_modules/@lucasfe/ralph'],
    ['an older store version', `${USER_HOME}/Library/pnpm/global/4/node_modules/@lucasfe/ralph`],
    ['a future store version', `${USER_HOME}/Library/pnpm/global/10/node_modules/@lucasfe/ralph`],
    ['no store-version segment at all', `${USER_HOME}/Library/pnpm/global/node_modules/@lucasfe/ralph`],
    [
      // pnpm 9's actual realpath: `.pnpm` is a sibling of `global/5/node_modules`,
      // not a child of it — which is what Node reports for a global pnpm install.
      "the global dir's own virtual store (the realpath form)",
      `${USER_HOME}/Library/pnpm/global/5/.pnpm/@lucasfe+ralph@0.16.0/node_modules/@lucasfe/ralph`,
    ],
    ['a bin dir beside the global dir', `${USER_HOME}/Library/pnpm/global/5`],
  ]

  for (const [label, ralphHome] of pnpmGlobals) {
    it(`still recognizes a pnpm global install with ${label}`, async () => {
      // Narrowing the marker to `pnpm/global` must not have cost a real layout:
      // every documented PNPM_HOME keeps the `pnpm` segment.
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('global-pnpm')
      expect(result.argv).toEqual(['pnpm', 'add', '-g', '@lucasfe/ralph@latest'])
    })
  }

  const unnamedGlobalDirs = [
    ["pnpm 6's `~/.pnpm-global`", `${USER_HOME}/.pnpm-global/5/node_modules/@lucasfe/ralph`],
    ['a hand-configured `global-dir`', `${USER_HOME}/.config/pnpm-global/5/node_modules/@lucasfe/ralph`],
    ['a PNPM_HOME whose leaf is not `pnpm`', '/opt/pnpm-home/global/5/node_modules/@lucasfe/ralph'],
  ]

  for (const [label, ralphHome] of unnamedGlobalDirs) {
    it(`refuses to guess for ${label} instead of naming a manager (characterized)`, async () => {
      // The cost of the narrowed marker: a global dir with no `pnpm` segment is
      // no longer recognized. It fails CLOSED — no argv, so nothing runs — and
      // pnpm symlinks its global package roots anyway, so the realistic form of
      // this layout is caught by the linked refusal below.
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      expect(result.advice).toBeNull()
    })

    it(`still refuses ${label} when its package root is a symlink`, async () => {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: symlinkFs(ralphHome) })
      expect(result.kind).toBe('linked')
      expect(result.argv).toBeNull()
      expect(result.advice).toMatch(/package manager/i)
    })
  }

  it('checking .git before the symlink cannot make any layout installable', async () => {
    // The truth table both probes span. `.git` moved ahead of the symlink probe,
    // so only the WORDING can change: every combination that refused still
    // refuses, and the one that did not is still the only one with an argv.
    const home = PNPM_RALPH
    const table = [
      ['a .git entry only', gitDirFs(home), 'linked', /git pull/],
      ['a symlink only', symlinkFs(home), 'linked', /pnpm add -g/],
      ['both, via the link target', symlinkToCheckoutFs(home), 'linked', /git pull/],
      ['neither', noFs(), 'global-pnpm', null],
    ]
    for (const [, fs, kind, advice] of table) {
      const result = await classifyInstall({ ralphHome: home, exec: rootOk(), fs })
      expect(result.kind).toBe(kind)
      if (advice) {
        expect(result.advice).toMatch(advice)
        expect(result.argv).toBeNull()
      } else {
        expect(result.advice).toBeNull()
      }
    }
  })

  it('reads a symlinked root with a checkout behind it as a checkout, not as a store link', async () => {
    // The ordering flip, deliberately: under the old order this said "is a
    // symlink"; `npm link` is the case that matters and it has a checkout.
    const result = await classifyInstall({
      ralphHome: PNPM_RALPH,
      exec: rootOk(),
      fs: symlinkToCheckoutFs(PNPM_RALPH),
    })
    expect(result.reason).toContain('.git')
    expect(result.reason).not.toContain('symlink')
  })

  it('names a manager in symlink advice only from the path, which a package NAME can fake (characterized)', async () => {
    // `${GLOBAL_ROOT}/pnpm/global` is an npm-global package, not a pnpm store,
    // but whole-segment matching cannot tell. The wording is wrong; the answer is
    // not — there is still no argv, so nothing is ever run on this advice.
    const home = `${GLOBAL_ROOT}/pnpm/global`
    const result = await classifyInstall({ ralphHome: home, exec: rootOk(), fs: symlinkFs(home) })
    expect(result.kind).toBe('linked')
    expect(result.argv).toBeNull()
    expect(result.advice).toContain('pnpm add -g')
  })

  it('picks no manager at all for symlink advice when two stores match', async () => {
    for (const home of [AMBIGUOUS_RALPH, '/x/pnpm/global/yarn/global/bun/install/global/ralph']) {
      const result = await classifyInstall({ ralphHome: home, exec: rootOk(), fs: symlinkFs(home) })
      expect(result.kind).toBe('linked')
      expect(result.advice).toMatch(/whichever package manager/i)
      expect(result.advice).not.toMatch(STORE_COMMANDS)
    }
  })

  it('keeps whole-segment matching for the narrowed pnpm marker', async () => {
    // The near-miss corpus above was written against the old bare `.pnpm`
    // marker; these are the near-misses of the marker that replaced it.
    for (const ralphHome of [
      `${USER_HOME}/Library/.pnpm/global/5/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/Library/pnpm/globals/5/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/Library/pnpm/.global/5/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/Library/pnpmglobal/5/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/Library/pnpm/store/v3/files/ab/cd`,
    ]) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
    }
  })
})

// --- #198 QA ----------------------------------------------------------------
// QA augmentation for #198's Homebrew row. The dev's install-target.test.js pins
// the happy classification on all three prefixes. The row's marker is a PAIR —
// `Cellar` followed by the formula name — so these tests attack what a pair
// invites: the right first segment under the WRONG formula, a formula name with
// no `Cellar` above it, the pair reordered, split apart or welded into one
// segment, and a directory a user happens to have called `Cellar`. Plus the two
// rules the new row must not have bought its way out of — ambiguity still fails
// closed, and the .git/symlink refusals still outrank it — and the one false
// positive whole-segment matching cannot avoid, pinned as such.

const BREW_CELLAR = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'
const BREW_ARGV = ['brew', 'upgrade', 'ralph']
const BREW_COMMAND = BREW_ARGV.join(' ')

describe('classifyInstall — the Homebrew marker pair (#198 QA)', () => {
  const nearMisses = [
    [
      'a Cellar belonging to another formula',
      '/opt/homebrew/Cellar/ripgrep/14.1.1/libexec/lib/node_modules/@lucasfe/ralph',
    ],
    [
      // The formula Ralph's own `depends_on` names, and the likeliest way a
      // `@lucasfe/ralph` directory ends up under a Cellar that is not this
      // formula's: a node whose `lib/node_modules` is where global installs land.
      // Whatever put a copy there, `brew upgrade ralph` is the wrong answer — it
      // upgrades a formula that does not contain it. The positive control below
      // shows npm's own probe still free to claim that path.
      'a Cellar belonging to node itself',
      '/opt/homebrew/Cellar/node/23.11.0/lib/node_modules/@lucasfe/ralph',
    ],
    [
      'a formula whose name only starts with the formula name',
      '/opt/homebrew/Cellar/ralph-cli/0.16.0/libexec/lib/node_modules/@lucasfe/ralph',
    ],
    [
      'a formula whose name only ends with the formula name',
      '/opt/homebrew/Cellar/my-ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph',
    ],
    [
      'a project directory a user named `Cellar`',
      `${USER_HOME}/repos/Cellar/wine-notes/node_modules/@lucasfe/ralph`,
    ],
    ['a bare `Cellar` with no formula segment under it', '/opt/homebrew/Cellar'],
    [
      '`Cellar` spelled lower-case',
      '/opt/homebrew/cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph',
    ],
    [
      'the pair in the wrong order',
      '/opt/homebrew/ralph/Cellar/0.16.0/libexec/lib/node_modules/@lucasfe/ralph',
    ],
    [
      'the pair split apart by the version segment',
      '/opt/homebrew/Cellar/0.16.0/ralph/libexec/lib/node_modules/@lucasfe/ralph',
    ],
    [
      'a Cellar segment that is only a prefix',
      '/opt/homebrew/Cellar-old/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph',
    ],
    [
      'a Cellar segment that is only a suffix',
      '/opt/homebrew/MyCellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph',
    ],
    [
      'the pair hyphenated into one segment',
      '/opt/homebrew/Cellar-ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph',
    ],
    [
      // Homebrew's own `<prefix>/opt/<formula>` alias, which is a SYMLINK to the
      // Cellar directory. Node realpaths `import.meta.url`, so RALPH_HOME never
      // arrives in this form — and the alias carries no `Cellar` segment, so it
      // is not this store by path either.
      "brew's `opt` alias rather than the Cellar it points at",
      '/opt/homebrew/opt/ralph/libexec/lib/node_modules/@lucasfe/ralph',
    ],
  ]

  for (const [label, ralphHome] of nearMisses) {
    it(`does not recognize ${label}`, async () => {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).not.toBe('global-brew')
      expect(result.argv).not.toEqual(BREW_ARGV)
    })
  }

  it('falls closed to unknown for every near-miss, with nothing to run', async () => {
    // The stronger claim: not merely "not brew" but no command at all. None of
    // these paths sits under the global root the stub reports, so nothing below
    // the markers can pick them up either.
    for (const [, ralphHome] of nearMisses) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      expect(result.label).toBeNull()
      expect(result.advice).toBeNull()
    }
  })

  it('leaves a brew-managed npm global install to npm, whose root really does own it', async () => {
    // Positive control for the `Cellar/node` row above: with npm's own probe
    // answering, that path classifies global-npm — the correct answer, and proof
    // the row is refused by the marker rather than lost.
    const cellarNodeRoot = '/opt/homebrew/Cellar/node/23.11.0/lib/node_modules'
    const result = await classifyInstall({
      ralphHome: `${cellarNodeRoot}/@lucasfe/ralph`,
      exec: rootOk(`${cellarNodeRoot}\n`),
      fs: noFs(),
    })
    expect(result.kind).toBe('global-npm')
    expect(result.argv).toEqual(['npm', 'install', '-g', '@lucasfe/ralph@latest'])
  })

  // Positive controls, so the near-misses above cannot be passing because the
  // pair never matches anything.
  const positions = [
    ['a path made of nothing but the pair', '/Cellar/ralph'],
    ['the pair at the very last segments', `${USER_HOME}/x/Cellar/ralph`],
    ['a repeated pair', '/opt/homebrew/Cellar/ralph/0.16.0/Cellar/ralph/libexec'],
    [
      'the pair 1000 segments deep',
      `/${Array.from({ length: 1000 }, (_, i) => `d${i}`).join('/')}/Cellar/ralph/0.16.0/libexec`,
    ],
    [
      'a `..` that resolves INTO a Cellar',
      '/opt/homebrew/lib/../Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph',
    ],
    [
      'doubled and dotted separators around the pair',
      '/opt/homebrew//Cellar/./ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph/',
    ],
  ]

  for (const [label, ralphHome] of positions) {
    it(`matches ${label}`, async () => {
      const exec = rootOk()
      const result = await classifyInstall({ ralphHome, exec, fs: noFs() })
      expect(result.kind).toBe('global-brew')
      expect(result.argv).toEqual(BREW_ARGV)
      expect(exec.calls).toHaveLength(0)
    })
  }

  it('resolves `..` before matching, so an escape OUT of a Cellar is not brew', async () => {
    const result = await classifyInstall({
      ralphHome: '/opt/homebrew/Cellar/ralph/../../..',
      exec: rootOk(),
      fs: noFs(),
    })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  it('reads a project directory named `Cellar/ralph` as a brew install (characterized)', async () => {
    // Whole-segment matching cannot tell a Cellar from a directory pair spelled
    // like one, exactly as `${GLOBAL_ROOT}/yarn/global` cannot be told from a
    // yarn store above. Pinned rather than fixed: the realistic form of this
    // path is a checkout or a link, and both are refused before any marker is
    // consulted — the two tests below are that refusal.
    const home = `${USER_HOME}/repos/Cellar/ralph`
    const result = await classifyInstall({ ralphHome: home, exec: rootOk(), fs: noFs() })
    expect(result.kind).toBe('global-brew')
    expect(result.argv).toEqual(BREW_ARGV)
  })

  it('a backslash-separated path carrying the pair matches nothing on POSIX (characterized)', async () => {
    // `sep` is the platform separator, so the whole Windows-ish path is one
    // segment. Homebrew has no Windows build, so this is only the same safe
    // direction the #22 markers already answer in.
    const result = await classifyInstall({
      ralphHome: 'C:\\Homebrew\\Cellar\\ralph\\0.16.0\\libexec',
      exec: rootOk(),
      fs: noFs(),
    })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })
})

describe('classifyInstall — Homebrew ambiguity fails closed (#198 QA)', () => {
  // The Cellar pair on the same path as another manager's marker. Contrived —
  // brew's own layout has no node_modules above the package root — but the rule
  // is the table's, not this row's: a path no single manager can claim gets no
  // command at all.
  const ambiguous = [
    [
      'brew + pnpm',
      `${BREW_CELLAR.replace('/@lucasfe/ralph', '')}/pnpm/global/node_modules/@lucasfe/ralph`,
      ['brew', 'pnpm'],
    ],
    [
      'brew + yarn',
      '/opt/homebrew/Cellar/ralph/0.16.0/libexec/.yarn/global/node_modules/@lucasfe/ralph',
      ['brew', 'yarn'],
    ],
    [
      'brew + bun',
      '/opt/homebrew/Cellar/ralph/0.16.0/libexec/.bun/install/global/node_modules/@lucasfe/ralph',
      ['brew', 'bun'],
    ],
  ]

  for (const [label, ralphHome, managers] of ambiguous) {
    it(`refuses to pick a manager when ${label} both match`, async () => {
      const exec = rootOk()
      const result = await classifyInstall({ ralphHome, exec, fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      expect(result.label).toBeNull()
      // No advice: a failure to recognize, not a deliberate refusal, so the
      // caller keeps its exit 1.
      expect(result.advice).toBeNull()
      for (const manager of managers) expect(result.reason).toContain(manager)
      expect(exec.calls).toHaveLength(0)
    })

    it(`names no single command in the symlink advice for ${label}`, async () => {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: symlinkFs(ralphHome) })
      expect(result.kind).toBe('linked')
      expect(result.advice).toMatch(/whichever package manager/i)
      expect(result.advice).not.toContain(BREW_COMMAND)
    })
  }
})

describe('classifyInstall — the refusals still outrank the Cellar (#198 QA)', () => {
  // A contributor's checkout that happens to sit under a `Cellar` path, in every
  // filesystem shape that makes a package root untouchable. `brew upgrade` would
  // replace it with a released tarball, so the marker must never be reached.
  const CELLAR_CHECKOUT = `${USER_HOME}/repos/Cellar/ralph`

  const signals = [
    ['a .git directory', gitDirFs, (r) => expect(r.advice).toContain('git pull')],
    ['a .git FILE (worktree/submodule)', gitFileFs, (r) => expect(r.advice).toContain('git pull')],
    [
      'a symlinked root with no checkout behind it',
      symlinkFs,
      // A linked install, not a checkout — so it names brew's own command, the
      // one thing this row adds to the wording.
      (r) => {
        expect(r.advice).toContain(BREW_COMMAND)
        expect(r.advice).not.toContain('git pull')
      },
    ],
    [
      'a symlink whose TARGET is a checkout (`npm link`)',
      symlinkToCheckoutFs,
      (r) => {
        expect(r.advice).toContain('git pull')
        expect(r.advice).not.toContain(BREW_COMMAND)
      },
    ],
    [
      'a dangling symlink',
      danglingSymlinkFs,
      (r) => {
        expect(r.advice).toContain(BREW_COMMAND)
        expect(r.advice).not.toContain('git pull')
      },
    ],
  ]

  for (const home of [BREW_CELLAR, CELLAR_CHECKOUT]) {
    for (const [what, makeFs, expectAdvice] of signals) {
      it(`refuses ${what} under ${home === BREW_CELLAR ? 'a real Cellar path' : 'a checkout named Cellar/ralph'}`, async () => {
        const exec = rootOk()
        const result = await classifyInstall({ ralphHome: home, exec, fs: makeFs(home) })
        expect(result.kind).toBe('linked')
        expect(result.argv).toBeNull()
        expect(result.label).toBeNull()
        // Decided from the package root alone: npm was never asked anything, and
        // nothing was ever going to be upgraded.
        expect(exec.calls).toHaveLength(0)
        expectAdvice(result)
      })
    }
  }

  it('the same Cellar path answers global-brew ONLY while no refusal fires', async () => {
    const runnable = await classifyInstall({ ralphHome: BREW_CELLAR, exec: rootOk(), fs: noFs() })
    expect(runnable.kind).toBe('global-brew')
    expect(runnable.argv).toEqual(BREW_ARGV)

    for (const makeFs of [gitDirFs, gitFileFs, symlinkFs, danglingSymlinkFs]) {
      const refused = await classifyInstall({
        ralphHome: BREW_CELLAR,
        exec: rootOk(),
        fs: makeFs(BREW_CELLAR),
      })
      expect(refused.kind).toBe('linked')
      expect(refused.argv).toBeNull()
    }
  })

  it('an npx cache under a Cellar path is refused as npx, not upgraded', async () => {
    const result = await classifyInstall({
      ralphHome: '/opt/homebrew/Cellar/ralph/0.16.0/libexec/_npx/ab/node_modules/@lucasfe/ralph',
      exec: rootOk(),
      fs: noFs(),
    })
    expect(result.kind).toBe('npx')
    expect(result.argv).toBeNull()
    expect(result.advice).toMatch(/npx/i)
    expect(result.advice).not.toContain(BREW_COMMAND)
  })

  it('refuses a Cellar path without npm even when exec would blow up', async () => {
    const boom = () => {
      throw new Error('npm must not be spawned for a refusal')
    }
    for (const makeFs of [gitDirFs, symlinkFs]) {
      const result = await classifyInstall({
        ralphHome: BREW_CELLAR,
        exec: boom,
        fs: makeFs(BREW_CELLAR),
      })
      expect(result.kind).toBe('linked')
    }
  })

  it('classifies a Cellar path with no help from exec at all', async () => {
    for (const exec of [null, 'brew', async () => ({ exitCode: 1, stdout: '' })]) {
      const result = await classifyInstall({ ralphHome: BREW_CELLAR, exec, fs: noFs() })
      expect(result.kind).toBe('global-brew')
      expect(result.argv).toEqual(BREW_ARGV)
    }
  })

  it('still recognizes a Cellar install when the fs probes cannot answer', async () => {
    // Marker classification never touches the filesystem, so a probe that throws
    // cannot turn a brew install into `unknown`.
    for (const fs of [throwingFs('EACCES'), throwingFs('ENOENT'), {}]) {
      const result = await classifyInstall({ ralphHome: BREW_CELLAR, exec: rootOk(), fs })
      expect(result.kind).toBe('global-brew')
      expect(result.argv).toEqual(BREW_ARGV)
    }
  })
})

describe('classifyInstall — the Homebrew kind keeps the one return shape (#198 QA)', () => {
  it('returns the same five keys, with an argv and no advice', async () => {
    const result = await classifyInstall({ ralphHome: BREW_CELLAR, exec: rootOk(), fs: noFs() })
    expect(Object.keys(result).sort()).toEqual(['advice', 'argv', 'kind', 'label', 'reason'])
    expect(result.advice).toBeNull()
    expect(result.label).toBe(result.argv.join(' '))
    expect(result.argv.every((t) => typeof t === 'string' && t !== '' && t.trim() === t)).toBe(true)
    expect(typeof result.reason).toBe('string')
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('is the one runnable kind whose argv does not end in `@lucasfe/ralph@latest`', async () => {
    // brew names the FORMULA, not an npm spec — the one place a store row's argv
    // is not built from PACKAGE_NAME, and the reason the formula name is spelled
    // in the table rather than derived.
    const result = await classifyInstall({ ralphHome: BREW_CELLAR, exec: rootOk(), fs: noFs() })
    expect(result.argv[result.argv.length - 1]).toBe('ralph')
    expect(result.label).not.toContain('@lucasfe/ralph@latest')
  })

  it('holds the shape invariants across the Homebrew corpus', async () => {
    const corpus = [
      '/Cellar/ralph',
      '/opt/homebrew/Cellar',
      BREW_CELLAR,
      `${USER_HOME}/repos/Cellar/ralph`,
      '/usr/local/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph',
      '/home/linuxbrew/.linuxbrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph',
      '/opt/homebrew/Cellar/ripgrep/14.1.1/libexec',
      '/opt/homebrew/cellar/ralph/0.16.0/libexec',
      'C:\\Homebrew\\Cellar\\ralph\\0.16.0\\libexec',
    ]
    for (const ralphHome of corpus) {
      for (const fs of [noFs(), gitDirFs(ralphHome), symlinkFs(ralphHome), throwingFs('EACCES')]) {
        const result = await classifyInstall({ ralphHome, exec: rootOk(), fs })
        expect([...KINDS, 'global-brew']).toContain(result.kind)
        expect(result.argv === null).toBe(result.label === null)
        expect(result.label).toBe(result.argv ? result.argv.join(' ') : null)
        expect(result.argv != null && result.advice != null).toBe(false)
        expect(result.advice == null || REFUSALS.includes(result.kind)).toBe(true)
        expect(typeof result.reason).toBe('string')
        expect(result.reason.length).toBeGreaterThan(0)
      }
    }
  })
})

// --- #198 QA, second pass ---------------------------------------------------
// Second QA pass on #198. The first pass attacked the marker PAIR — wrong
// formula, wrong order, wrong case, split, welded, aliased — and the refusal
// ordering around it. What it left untouched is everything the new row changed
// that is NOT the pair:
//   1. the `layout ?? derived` seam in the reason line, which is the only
//      control-flow-adjacent edit the change made. No test anywhere pins the
//      three pre-existing rows' reason strings, so nothing yet proves the seam
//      left them alone — and nothing pins that the seam cannot render an empty
//      noun phrase for a row whose `layout` is falsy.
//   2. case variation beyond the single lower-case `cellar` already pinned —
//      mixed-case `Cellar` and a mixed-case FORMULA name, which is the half a
//      case-insensitive macOS volume makes reachable.
//   3. normalization: what the reason PRINTS for a messy input, not just what
//      it classifies. A user is invited to read that path.
//   4. precedence over the `npm root -g` probe when the two overlap — a real
//      shape, because the formula npm-installs with its prefix set to `libexec`,
//      so an npm global root genuinely exists inside the Cellar.
//   5. the ambiguity list's ORDER, the one thing that depends on the brew row
//      being last in the table.
//   6. brew's command leaking into a NEAR-MISS refusal's advice: the first pass
//      pinned the true Cellar and the ambiguous path, never the Cellar that is
//      not this formula's.

const BREW_LIBEXEC = '/opt/homebrew/Cellar/ralph/0.16.0/libexec'
const BREW_LAYOUT_REASON = 'is inside a Homebrew Cellar (`Cellar/ralph`)'

// Each store row's path, its argv[0], and the reason the row renders. The first
// three omit `layout` and get the derived wording; the fourth sets it.
const REASON_ROWS = [
  ['pnpm', PNPM_RALPH, 'pnpm', `${PNPM_RALPH} is inside a pnpm global install directory`],
  ['yarn', YARN_RALPH, 'yarn', `${YARN_RALPH} is inside a yarn global install directory`],
  ['bun', BUN_RALPH, 'bun', `${BUN_RALPH} is inside a bun global install directory`],
  ['brew', BREW_CELLAR, 'brew', `${BREW_CELLAR} ${BREW_LAYOUT_REASON}`],
]

describe('classifyInstall — the `layout ?? derived` reason seam (#198 QA, second pass)', () => {
  it('leaves the three pre-existing rows byte-identical, field or no field', async () => {
    // The regression the new optional field could have caused, and the one
    // nothing else asserts: before #198 the reason was built unconditionally from
    // argv[0], and no test in this repo pinned the resulting string. These three
    // are that pin — a `layout` added to any of these rows, or a change to the
    // derived template, now has to change a test.
    for (const [manager, home, , reason] of REASON_ROWS.slice(0, 3)) {
      const result = await classifyInstall({ ralphHome: home, exec: rootOk(), fs: noFs() })
      expect(result.reason).toBe(reason)
      expect(result.reason).toContain(`a ${manager} global install directory`)
    }
  })

  it('renders the Homebrew row from its `layout`, byte for byte', async () => {
    const result = await classifyInstall({ ralphHome: BREW_CELLAR, exec: rootOk(), fs: noFs() })
    expect(result.reason).toBe(`${BREW_CELLAR} ${BREW_LAYOUT_REASON}`)
    // The derived wording is the thing `layout` exists to replace, so it must be
    // absent — not merely supplemented.
    expect(result.reason).not.toContain('global install directory')
    expect(result.reason).not.toContain('a brew ')
  })

  it('never renders an empty, absent or doubled noun phrase after "is inside"', async () => {
    // The seam is `store.layout ?? derived`, and `??` only falls through for
    // null/undefined: a row whose `layout` were `''` or `0` would render
    // "<path> is inside " or "<path> is inside 0". GLOBAL_STORES is not exported,
    // so the field's type cannot be asserted directly — this is the observable
    // half, and it is what a user would actually be shown.
    for (const [, home] of REASON_ROWS) {
      const result = await classifyInstall({ ralphHome: home, exec: rootOk(), fs: noFs() })
      expect(result.reason).toMatch(/ is inside \S/)
      expect(result.reason).not.toMatch(/is inside\s*$/)
      expect(result.reason).not.toMatch(/is inside {2}/)
      expect(result.reason).not.toMatch(/\b(undefined|null|NaN|false|\[object Object\])\b/)
      // A noun phrase, not a bare path or a bare number.
      const phrase = result.reason.split(' is inside ')[1]
      expect(phrase.length).toBeGreaterThan(3)
      expect(phrase).toMatch(/[a-z]/)
    }
  })

  it('keeps the derived branch live for every row that omits `layout`', async () => {
    // Both branches of the seam are exercised by the shipped table: three rows
    // through the default, one through the override. A stray `layout` on a
    // derived row, or a lost `layout` on the Homebrew row, breaks exactly one of
    // these two halves.
    const derived = []
    const overridden = []
    for (const [, home, manager] of REASON_ROWS) {
      const result = await classifyInstall({ ralphHome: home, exec: rootOk(), fs: noFs() })
      const bucket = result.reason.includes('global install directory') ? derived : overridden
      bucket.push([result.kind, manager])
    }
    expect(derived).toEqual([
      ['global-pnpm', 'pnpm'],
      ['global-yarn', 'yarn'],
      ['global-bun', 'bun'],
    ])
    expect(overridden).toEqual([['global-brew', 'brew']])
  })
})

describe('classifyInstall — the Cellar marker under case variation (#198 QA, second pass)', () => {
  // The first pass pinned lower-case `cellar` as a non-match. That is the safe
  // direction, but it is worth saying WHY it is also the unreachable one, because
  // macOS's default APFS volume is case-INSENSITIVE: `/opt/homebrew/cellar/ralph`
  // names the same directory on disk as `/opt/homebrew/Cellar/ralph`.
  //
  // Measured, not reasoned. Running a module through a lower-case spelling of a
  // real upper-case directory returns that lower-case spelling in
  // `import.meta.url`: Node's ESM resolution realpaths symlinks but does not
  // case-fold (only `fs.realpathSync.native` returns the on-disk spelling).
  // Running the same module through a `bin/ralph` symlink whose target string
  // carries the canonical `Cellar` returns the canonical form. Homebrew writes
  // that symlink itself, and a `ralph` found on PATH is always reached through
  // it — so RALPH_HOME arrives canonical in every real brew install, and only a
  // hand-typed path can arrive otherwise. That path fails closed here rather
  // than running `brew upgrade` against a directory the classifier misread.
  const caseVariants = [
    ['`CELLAR` upper-cased', '/opt/homebrew/CELLAR/ralph/0.16.0/libexec'],
    ['`CeLLaR` mixed-case', '/opt/homebrew/CeLLaR/ralph/0.16.0/libexec'],
    ['`cELLAR` inverted', '/opt/homebrew/cELLAR/ralph/0.16.0/libexec'],
    ['a capitalized formula name', '/opt/homebrew/Cellar/Ralph/0.16.0/libexec'],
    ['an upper-cased formula name', '/opt/homebrew/Cellar/RALPH/0.16.0/libexec'],
    ['both halves upper-cased', '/opt/homebrew/CELLAR/RALPH/0.16.0/libexec'],
  ]

  for (const [label, ralphHome] of caseVariants) {
    it(`fails closed for ${label}`, async () => {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      expect(result.label).toBeNull()
      expect(result.advice).toBeNull()
      // And it does not half-recognize it: the reason echoes the path it was
      // given (which may itself contain a `Cellar` segment), but nothing in the
      // wording claims the Homebrew layout.
      expect(result.reason).not.toContain('Homebrew')
      expect(result.reason).not.toContain(BREW_LAYOUT_REASON)
    })
  }

  it('matches the canonical spelling of the very same path', async () => {
    // Positive control: the loop above is refusing on case, not on the path shape.
    const result = await classifyInstall({ ralphHome: BREW_LIBEXEC, exec: rootOk(), fs: noFs() })
    expect(result.kind).toBe('global-brew')
    expect(result.argv).toEqual(BREW_ARGV)
  })
})

describe('classifyInstall — a Homebrew path is normalized before it is matched or printed (#198 QA, second pass)', () => {
  // Every one of these resolves to BREW_LIBEXEC. What is pinned is not only the
  // match but the printed path: `ralph update` writes the reason to the terminal,
  // and a user reading `//Cellar/./ralph` there cannot paste it anywhere.
  const messy = [
    ['a trailing separator', `${BREW_LIBEXEC}/`],
    ['a trailing `/.`', `${BREW_LIBEXEC}/.`],
    ['tripled separators throughout', '/opt/homebrew///Cellar///ralph///0.16.0///libexec'],
    ['a `..` that resolves back into the Cellar', '/opt/homebrew/Cellar/ralph/0.16.0/x/../libexec'],
    ['surrounding whitespace and a newline', `  ${BREW_LIBEXEC}\n`],
    ['a mix of all of them', ` /opt/homebrew//Cellar/./ralph/0.16.0/y/../libexec/ `],
  ]

  for (const [label, ralphHome] of messy) {
    it(`matches through ${label} and prints the resolved path`, async () => {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('global-brew')
      expect(result.argv).toEqual(BREW_ARGV)
      expect(result.reason).toBe(`${BREW_LIBEXEC} ${BREW_LAYOUT_REASON}`)
      expect(result.reason).not.toContain('//')
      expect(result.reason).not.toContain('/./')
      expect(result.reason).not.toContain('..')
    })
  }

  it('matches a path that is exactly the pair under a real prefix, with nothing under it', async () => {
    // The boundary `segments` reaches when the marker is the LAST thing on the
    // path — a Cellar path with no version segment under it at all — with and
    // without a trailing separator, since `resolve` strips one and `filter(Boolean)`
    // drops what it leaves behind.
    for (const ralphHome of ['/opt/homebrew/Cellar/ralph', '/opt/homebrew/Cellar/ralph/']) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('global-brew')
      expect(result.reason).toBe(`/opt/homebrew/Cellar/ralph ${BREW_LAYOUT_REASON}`)
    }
  })

  it('fails closed when a NUL byte splits either half of the pair', async () => {
    // `resolve` does not validate a NUL (only an fs call would), so a poisoned
    // path reaches the matcher intact — and is refused there, by segment
    // inequality, rather than throwing out of a probe.
    for (const ralphHome of [
      `/opt/homebrew/Cellar${NUL}/ralph/0.16.0/libexec`,
      `/opt/homebrew/Cellar/ralph${NUL}/0.16.0/libexec`,
      `/opt/homebrew/Cellar/${NUL}ralph/0.16.0/libexec`,
    ]) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
    }
  })

  it('resolves a non-absolute input against the cwd before matching (characterized)', async () => {
    // The same characterization the #21 QA pass records for a relative
    // `npm root -g` output, now for the Cellar pair: `normalize` resolves, so a
    // relative path — and a `file://` URL, which resolves as a relative one whose
    // first segment is literally `file:` — can carry the pair into a match.
    // Harmless in the shipped path (RALPH_HOME is built with `fileURLToPath` and
    // is always absolute), pinned so a change to `normalize` is visible.
    for (const ralphHome of [
      'Cellar/ralph/0.16.0/libexec',
      'file:///opt/homebrew/Cellar/ralph/0.16.0/libexec',
    ]) {
      const result = await classifyInstall({ ralphHome, exec: rootOk(), fs: noFs() })
      expect(result.kind).toBe('global-brew')
      expect(result.reason).toBe(`${resolve(ralphHome)} ${BREW_LAYOUT_REASON}`)
    }
  })
})

describe('classifyInstall — the Cellar marker outranks the npm probe (#198 QA, second pass)', () => {
  // The overlap is not arbitrary. The formula runs
  // `system "npm", "install", *std_npm_args` (scripts/lib/render-homebrew-formula.js),
  // and `std_npm_args` sets npm's prefix to `libexec` — so
  // `<version>/libexec/lib/node_modules` genuinely IS an npm global root, just
  // not the user's. Should a user's own npm config point there too, the marker
  // still has to decide: `npm install -g` would write a published tarball into a
  // directory `brew upgrade` owns and overwrites.
  const overlappingRoots = [
    ['the Cellar itself', '/opt/homebrew/Cellar'],
    ["the formula's libexec node_modules", `${BREW_LIBEXEC}/lib/node_modules`],
    ['the package root itself', BREW_CELLAR],
  ]

  for (const [label, root] of overlappingRoots) {
    it(`answers brew, not npm, when \`npm root -g\` reports ${label}`, async () => {
      const exec = rootOk(`${root}\n`)
      const result = await classifyInstall({ ralphHome: BREW_CELLAR, exec, fs: noFs() })
      expect(result.kind).toBe('global-brew')
      expect(result.argv).toEqual(BREW_ARGV)
      expect(result.label).not.toContain('npm install -g')
      // And npm is never even asked: the marker decides above the probe.
      expect(exec.calls).toHaveLength(0)
    })
  }
})

describe('classifyInstall — the ambiguity list follows the table, not the path (#198 QA, second pass)', () => {
  // The brew row is LAST in GLOBAL_STORES. Selection cannot depend on that
  // (`stores.length === 1` is order-blind), but the ambiguity message is built by
  // mapping the matched rows in table order — the one place the row's position is
  // observable. Pinned so reordering the table is a visible change rather than a
  // silent reshuffle of a line users read.
  it('names every matching manager in table order, brew last', async () => {
    const home = '/x/pnpm/global/yarn/global/.bun/install/global/Cellar/ralph/node_modules/@lucasfe/ralph'
    const exec = rootOk()
    const result = await classifyInstall({ ralphHome: home, exec, fs: noFs() })
    expect(result.reason).toBe(`${home} matches more than one package manager (pnpm, yarn, bun, brew)`)
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
    expect(result.advice).toBeNull()
    expect(exec.calls).toHaveLength(0)
  })

  it('keeps table order even when the Cellar comes first in the path', async () => {
    const home = '/x/Cellar/ralph/pnpm/global/node_modules/@lucasfe/ralph'
    const result = await classifyInstall({ ralphHome: home, exec: rootOk(), fs: noFs() })
    expect(result.reason).toBe(`${home} matches more than one package manager (pnpm, brew)`)
    expect(result.kind).toBe('unknown')
  })
})

describe("classifyInstall — brew's command never leaks into a near-miss refusal (#198 QA, second pass)", () => {
  // `linkedInstallAdvice(store)` names a command when exactly ONE store matches.
  // The first pass pinned the two ends of that: a true Cellar names
  // `brew upgrade ralph`, an ambiguous path names nothing. The middle is what a
  // near-miss must produce — no store, so the generic wording, and above all not
  // brew's command for a Cellar that is not this formula's.
  const nearMisses = [
    ["another formula's Cellar", '/opt/homebrew/Cellar/ripgrep/14.1.1/libexec/lib/node_modules/@lucasfe/ralph'],
    ['a formula named `ralph-cli`', '/opt/homebrew/Cellar/ralph-cli/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'],
    ['a lower-case `cellar`', '/opt/homebrew/cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'],
    ["brew's `opt` alias", '/opt/homebrew/opt/ralph/libexec/lib/node_modules/@lucasfe/ralph'],
  ]

  for (const [label, home] of nearMisses) {
    it(`gives generic advice for a symlinked root under ${label}`, async () => {
      const exec = rootOk()
      const result = await classifyInstall({ ralphHome: home, exec, fs: symlinkFs(home) })
      expect(result.kind).toBe('linked')
      expect(result.argv).toBeNull()
      expect(result.reason).toContain('symlink')
      expect(result.advice).toMatch(/whichever package manager/i)
      expect(result.advice).not.toContain(BREW_COMMAND)
      expect(result.advice).not.toContain('brew')
      expect(result.advice).not.toMatch(STORE_COMMANDS)
      expect(exec.calls).toHaveLength(0)
    })

    it(`still says \`git pull\` for a checkout under ${label}`, async () => {
      const result = await classifyInstall({ ralphHome: home, exec: rootOk(), fs: gitDirFs(home) })
      expect(result.kind).toBe('linked')
      expect(result.advice).toBe('Run `git pull` in that checkout to update it.')
      expect(result.advice).not.toContain('brew')
    })
  }
})
