import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import {
  classifyInstall,
  NPM_GLOBAL_UPDATE_ARGV,
  NPM_GLOBAL_UPDATE_LABEL,
} from './install-target.js'
import { RALPH_HOME } from './paths.js'

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

const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`

const npmRootOk = (stdout = `${GLOBAL_ROOT}\n`) => ({
  'npm root -g': { exitCode: 0, stdout, stderr: '' },
})

describe('classifyInstall — npm-global vs unknown (#21)', () => {
  it('classifies a package under `npm root -g` as global-npm with the npm update argv', async () => {
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(result.kind).toBe('global-npm')
    expect(result.argv).toEqual(['npm', 'install', '-g', '@lucasfe/ralph@latest'])
    expect(result.reason).toContain('npm root -g')
  })

  it('derives the printable label from the argv, never the other way round', async () => {
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(result.label).toBe(result.argv.join(' '))
    expect(result.label).toBe('npm install -g @lucasfe/ralph@latest')
  })

  it('queries npm root with exact argv and never rejects', async () => {
    const exec = makeExec(npmRootOk())
    await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0]).toMatchObject({ cmd: 'npm', args: ['root', '-g'] })
    expect(exec.calls[0].options).toMatchObject({ reject: false })
  })

  it('tolerates a trailing slash and surrounding whitespace in npm root output', async () => {
    const exec = makeExec(npmRootOk(`  ${GLOBAL_ROOT}/  \n`))
    const result = await classifyInstall({ ralphHome: `${GLOBAL_RALPH}/`, exec })
    expect(result.kind).toBe('global-npm')
  })

  it('returns unknown when the package lives outside npm root -g', async () => {
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({ ralphHome: '/Users/me/repos/ralph', exec })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
    expect(result.label).toBeNull()
    expect(result.reason).toContain('/Users/me/repos/ralph')
  })

  it('does not treat a sibling directory sharing a path prefix as global-npm', async () => {
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({
      ralphHome: `${GLOBAL_ROOT}-old/@lucasfe/ralph`,
      exec,
    })
    expect(result.kind).toBe('unknown')
  })

  it('returns unknown when `npm root -g` exits non-zero', async () => {
    const exec = makeExec({
      'npm root -g': { exitCode: 1, stdout: '', stderr: 'boom' },
    })
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
    expect(result.reason).toContain('npm root -g')
  })

  it('returns unknown when npm root -g prints nothing', async () => {
    const exec = makeExec({ 'npm root -g': { exitCode: 0, stdout: '\n', stderr: '' } })
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(result.kind).toBe('unknown')
  })

  it('returns unknown when npm is missing (exec throws ENOENT)', async () => {
    const exec = async () => {
      const e = new Error('spawn npm ENOENT')
      e.code = 'ENOENT'
      throw e
    }
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  it('returns unknown when no exec is available', async () => {
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: null })
    expect(result.kind).toBe('unknown')
  })

  it('falls back to RALPH_HOME when ralphHome is omitted or null', async () => {
    const exec = makeExec(npmRootOk())
    for (const ralphHome of [undefined, null]) {
      const result = await classifyInstall({ ralphHome, exec })
      expect(result.reason).toContain(RALPH_HOME)
    }
  })

  it('exposes the npm-global argv and its printable label', () => {
    expect(NPM_GLOBAL_UPDATE_ARGV).toEqual([
      'npm',
      'install',
      '-g',
      '@lucasfe/ralph@latest',
    ])
    expect(NPM_GLOBAL_UPDATE_LABEL).toBe(NPM_GLOBAL_UPDATE_ARGV.join(' '))
  })
})

// --- #22: the remaining layouts --------------------------------------------
// The linked/npx probes read the filesystem, so every #22 test injects one: a
// synthesized path must never be confused with a real directory on this machine.

const HOME = '/Users/me'
const NPX_RALPH = `${HOME}/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph`
const PNPM_RALPH = `${HOME}/Library/pnpm/global/5/node_modules/@lucasfe/ralph`
// pnpm's virtual store outside any global dir: a project dependency, not a
// global install.
const LOCAL_PNPM_RALPH = `${HOME}/proj/node_modules/.pnpm/@lucasfe+ralph@0.16.0/node_modules/@lucasfe/ralph`
// Two managers' markers on one path — nothing to pick between them.
const AMBIGUOUS_RALPH = `${HOME}/.config/yarn/global/node_modules/pnpm/global/node_modules/@lucasfe/ralph`

// Nothing exists: no symlink, no .git — so only path markers can classify.
const emptyFs = () => Volume.fromJSON({})

const fsWithGitDir = (packageRoot) =>
  Volume.fromJSON({ [`${packageRoot}/.git/HEAD`]: 'ref: refs/heads/main\n' })

// What `npm link` leaves behind: the package root is a symlink to a checkout.
function fsWithSymlink(packageRoot, target = '/Users/me/repos/ralph') {
  const vol = Volume.fromJSON({ [`${target}/package.json`]: '{}' })
  vol.mkdirSync(packageRoot.slice(0, packageRoot.lastIndexOf('/')), { recursive: true })
  vol.symlinkSync(target, packageRoot)
  return vol
}

describe('classifyInstall — npx cache refusal (#22)', () => {
  it('classifies an npx cache path as npx with nothing to run', async () => {
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({ ralphHome: NPX_RALPH, exec, fs: emptyFs() })
    expect(result.kind).toBe('npx')
    expect(result.argv).toBeNull()
    expect(result.label).toBeNull()
    expect(result.reason).toContain('_npx')
  })

  it('explains that npx always fetches the latest, so there is nothing to update', async () => {
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({ ralphHome: NPX_RALPH, exec, fs: emptyFs() })
    expect(result.advice).toMatch(/npx/i)
    expect(result.advice).toMatch(/latest/i)
  })

  it('decides npx without probing `npm root -g`', async () => {
    const exec = makeExec(npmRootOk())
    await classifyInstall({ ralphHome: NPX_RALPH, exec, fs: emptyFs() })
    expect(exec.calls).toHaveLength(0)
  })

  it('matches `_npx` as a whole segment, never as a prefix', async () => {
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({
      ralphHome: `${HOME}/.npm/_npx-old/1a2b3c4d5e/node_modules/@lucasfe/ralph`,
      exec,
      fs: emptyFs(),
    })
    expect(result.kind).toBe('unknown')
    expect(result.advice).toBeNull()
  })
})

describe('classifyInstall — linked dev checkout refusal (#22)', () => {
  it('classifies a symlinked package root as linked', async () => {
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({
      ralphHome: GLOBAL_RALPH,
      exec,
      fs: fsWithSymlink(GLOBAL_RALPH),
    })
    expect(result.kind).toBe('linked')
    expect(result.argv).toBeNull()
    expect(result.label).toBeNull()
    expect(result.reason).toContain(GLOBAL_RALPH)
  })

  it('classifies a package root containing a .git directory as linked', async () => {
    const checkout = '/Users/me/repos/ralph'
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({
      ralphHome: checkout,
      exec,
      fs: fsWithGitDir(checkout),
    })
    expect(result.kind).toBe('linked')
    expect(result.argv).toBeNull()
  })

  it('points the user at `git pull` instead of any install command', async () => {
    const checkout = '/Users/me/repos/ralph'
    const result = await classifyInstall({
      ralphHome: checkout,
      exec: makeExec(npmRootOk()),
      fs: fsWithGitDir(checkout),
    })
    expect(result.advice).toContain('git pull')
    expect(result.advice).not.toContain('npm install')
  })

  it('decides linked without probing `npm root -g`, even inside the global root', async () => {
    // The whole point: a `npm link`ed copy sits under `npm root -g`, so the npm
    // probe would call it global-npm and clobber the checkout with a tarball.
    const exec = makeExec(npmRootOk())
    const result = await classifyInstall({
      ralphHome: GLOBAL_RALPH,
      exec,
      fs: fsWithSymlink(GLOBAL_RALPH),
    })
    expect(result.kind).toBe('linked')
    expect(exec.calls).toHaveLength(0)
  })

  it('wins over a package-manager marker: a checkout inside a pnpm store is linked', async () => {
    const result = await classifyInstall({
      ralphHome: PNPM_RALPH,
      exec: makeExec(npmRootOk()),
      fs: fsWithGitDir(PNPM_RALPH),
    })
    expect(result.kind).toBe('linked')
    expect(result.argv).toBeNull()
  })

  it('says `git pull` only when a .git is actually there — a symlink alone is not a checkout', async () => {
    // pnpm and bun symlink their package roots, so "symlink" on its own must not
    // send the user to a checkout that does not exist. The refusal still holds;
    // only the wording changes, and it names the store's own command.
    const store = `${HOME}/Library/pnpm/store/v3/files/ab/cd`
    const result = await classifyInstall({
      ralphHome: PNPM_RALPH,
      exec: makeExec(npmRootOk()),
      fs: fsWithSymlink(PNPM_RALPH, store),
    })
    expect(result.kind).toBe('linked')
    expect(result.reason).toContain('symlink')
    expect(result.advice).toContain('pnpm add -g @lucasfe/ralph@latest')
    expect(result.advice).not.toContain('git pull')
  })

  it('falls back to generic advice for a symlinked root outside every known store', async () => {
    const result = await classifyInstall({
      ralphHome: GLOBAL_RALPH,
      exec: makeExec(npmRootOk()),
      fs: fsWithSymlink(GLOBAL_RALPH),
    })
    expect(result.kind).toBe('linked')
    expect(result.advice).toMatch(/package manager/i)
    expect(result.advice).not.toContain('git pull')
    expect(result.advice).not.toContain('npm install -g')
  })

  it('says `git pull` when the symlink target is a real checkout (npm link)', async () => {
    // existsSync follows the link, so the target's .git is found through it.
    const target = `${HOME}/repos/ralph`
    const vol = fsWithSymlink(GLOBAL_RALPH, target)
    vol.mkdirSync(`${target}/.git`, { recursive: true })
    const result = await classifyInstall({
      ralphHome: GLOBAL_RALPH,
      exec: makeExec(npmRootOk()),
      fs: vol,
    })
    expect(result.kind).toBe('linked')
    expect(result.advice).toContain('git pull')
  })

  it('refuses a .git FILE (worktree or submodule) with wording that covers it', async () => {
    const root = `${HOME}/repos/ralph-worktree`
    const result = await classifyInstall({
      ralphHome: root,
      exec: makeExec(npmRootOk()),
      fs: Volume.fromJSON({ [`${root}/.git`]: 'gitdir: /elsewhere/.git/worktrees/w\n' }),
    })
    expect(result.kind).toBe('linked')
    expect(result.reason).toContain('.git')
    expect(result.reason).not.toContain('directory')
    expect(result.advice).toContain('git pull')
  })

  it('is not linked when the package root is a plain directory', async () => {
    const result = await classifyInstall({
      ralphHome: GLOBAL_RALPH,
      exec: makeExec(npmRootOk()),
      fs: Volume.fromJSON({ [`${GLOBAL_RALPH}/package.json`]: '{}' }),
    })
    expect(result.kind).toBe('global-npm')
  })
})

describe('classifyInstall — pnpm/yarn/bun global stores (#22)', () => {
  const stores = [
    ['pnpm global store on macOS', PNPM_RALPH, 'global-pnpm'],
    [
      'pnpm global store under the XDG data home',
      `${HOME}/.local/share/pnpm/global/5/node_modules/@lucasfe/ralph`,
      'global-pnpm',
    ],
    [
      // The realpath of a global pnpm install: `.pnpm` sits directly under
      // `global/5`, beside `node_modules`, not inside it.
      "pnpm's virtual store inside its global dir",
      `${HOME}/Library/pnpm/global/5/.pnpm/@lucasfe+ralph@0.16.0/node_modules/@lucasfe/ralph`,
      'global-pnpm',
    ],
    [
      'yarn global dir under the XDG config home',
      `${HOME}/.config/yarn/global/node_modules/@lucasfe/ralph`,
      'global-yarn',
    ],
    ['yarn global dir under ~/.yarn', `${HOME}/.yarn/global/node_modules/@lucasfe/ralph`, 'global-yarn'],
    [
      'bun global install dir',
      `${HOME}/.bun/install/global/node_modules/@lucasfe/ralph`,
      'global-bun',
    ],
  ]

  const expectedArgv = {
    'global-pnpm': ['pnpm', 'add', '-g', '@lucasfe/ralph@latest'],
    'global-yarn': ['yarn', 'global', 'add', '@lucasfe/ralph@latest'],
    'global-bun': ['bun', 'add', '-g', '@lucasfe/ralph@latest'],
  }

  for (const [label, ralphHome, kind] of stores) {
    it(`resolves a ${label} to that manager's own global-add command`, async () => {
      const exec = makeExec(npmRootOk())
      const result = await classifyInstall({ ralphHome, exec, fs: emptyFs() })
      expect(result.kind).toBe(kind)
      expect(result.argv).toEqual(expectedArgv[kind])
      expect(result.label).toBe(expectedArgv[kind].join(' '))
      expect(result.advice).toBeNull()
    })

    it(`never asks npm about a ${label}`, async () => {
      const exec = makeExec(npmRootOk())
      await classifyInstall({ ralphHome, exec, fs: emptyFs() })
      expect(exec.calls).toHaveLength(0)
    })
  }

  it('matches store markers as whole segments, never as prefixes', async () => {
    const result = await classifyInstall({
      ralphHome: `${HOME}/Library/pnpm-old/global/5/node_modules/@lucasfe/ralph`,
      exec: makeExec(npmRootOk()),
      fs: emptyFs(),
    })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  it('requires the marker segments to be adjacent', async () => {
    const result = await classifyInstall({
      ralphHome: `${HOME}/pnpm/tools/global/node_modules/@lucasfe/ralph`,
      exec: makeExec(npmRootOk()),
      fs: emptyFs(),
    })
    expect(result.kind).toBe('unknown')
  })

  it('fails closed when markers for two different managers both match', async () => {
    const result = await classifyInstall({
      ralphHome: AMBIGUOUS_RALPH,
      exec: makeExec(npmRootOk()),
      fs: emptyFs(),
    })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  it('does not read a project-local pnpm store as a global install', async () => {
    // A bare `.pnpm` segment used to match, so a project-local dependency got
    // `pnpm add -g` — which reports success while leaving the running copy
    // untouched. The `global` segment is required now, so this falls closed,
    // exactly as the npm equivalent of the same layout does.
    const result = await classifyInstall({
      ralphHome: LOCAL_PNPM_RALPH,
      exec: makeExec(npmRootOk()),
      fs: emptyFs(),
    })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
    expect(result.advice).toBeNull()
  })
})

describe('classifyInstall — one shape across every kind (#22)', () => {
  const layouts = [
    ['npx', NPX_RALPH, emptyFs()],
    ['linked', GLOBAL_RALPH, fsWithSymlink(GLOBAL_RALPH)],
    ['global-pnpm', PNPM_RALPH, emptyFs()],
    ['global-yarn', `${HOME}/.config/yarn/global/node_modules/@lucasfe/ralph`, emptyFs()],
    ['global-bun', `${HOME}/.bun/install/global/node_modules/@lucasfe/ralph`, emptyFs()],
    ['global-npm', GLOBAL_RALPH, emptyFs()],
    ['unknown', '/Users/me/somewhere/else', emptyFs()],
  ]

  for (const [kind, ralphHome, fs] of layouts) {
    it(`classifies its layout as ${kind}`, async () => {
      const result = await classifyInstall({ ralphHome, exec: makeExec(npmRootOk()), fs })
      expect(result.kind).toBe(kind)
    })
  }

  it('advice is set exactly for the deliberate refusals, and never alongside an argv', async () => {
    const refusals = ['npx', 'linked']
    for (const [kind, ralphHome, fs] of layouts) {
      const result = await classifyInstall({ ralphHome, exec: makeExec(npmRootOk()), fs })
      expect(result.advice != null).toBe(refusals.includes(kind))
      // Ralph either has something to run, or something to say — never both.
      expect(result.argv != null && result.advice != null).toBe(false)
      expect(typeof result.reason).toBe('string')
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })

  it('a label is present exactly when an argv is, and is derived from it', async () => {
    for (const [, ralphHome, fs] of layouts) {
      const result = await classifyInstall({ ralphHome, exec: makeExec(npmRootOk()), fs })
      expect(result.label).toBe(result.argv ? result.argv.join(' ') : null)
    }
  })
})

// --- #198: the Homebrew channel --------------------------------------------
// A brew install is the layout none of the #22 markers can reach: the formula
// npm-installs under `libexec` (brew's own `std_npm_args`), so the package root is
// a plain directory at `<prefix>/Cellar/ralph/<version>/libexec/lib/node_modules/@lucasfe/ralph`
// — no symlink, no `.git`, and nowhere near `npm root -g`. It classified
// `unknown`, so `ralph update` printed `npm install -g @lucasfe/ralph@latest`;
// following that advice installs a SECOND copy, and whichever of the two comes
// first on PATH shadows the other.

const BREW_ARGV = ['brew', 'upgrade', 'ralph']

// Every prefix Homebrew installs itself under. The Cellar's shape is the same in
// all three, which is the reason the marker is `Cellar` + the formula name
// rather than anything anchored to a prefix.
const BREW_PREFIXES = [
  ['Apple silicon', '/opt/homebrew'],
  ['Intel macOS', '/usr/local'],
  ['Linuxbrew', '/home/linuxbrew/.linuxbrew'],
]

const brewRalph = (prefix, version = '0.16.0') =>
  `${prefix}/Cellar/ralph/${version}/libexec/lib/node_modules/@lucasfe/ralph`

describe('classifyInstall — Homebrew Cellar (#198)', () => {
  for (const [label, prefix] of BREW_PREFIXES) {
    it(`resolves a ${label} Cellar install to \`brew upgrade ralph\``, async () => {
      const exec = makeExec(npmRootOk())
      const result = await classifyInstall({ ralphHome: brewRalph(prefix), exec, fs: emptyFs() })
      expect(result.kind).toBe('global-brew')
      expect(result.argv).toEqual(BREW_ARGV)
      expect(result.label).toBe('brew upgrade ralph')
      expect(result.advice).toBeNull()
    })

    it(`never asks npm about a ${label} Cellar install`, async () => {
      const exec = makeExec(npmRootOk())
      await classifyInstall({ ralphHome: brewRalph(prefix), exec, fs: emptyFs() })
      expect(exec.calls).toHaveLength(0)
    })
  }

  it('answers identically on all three prefixes, differing only in the path it names', async () => {
    const answers = []
    for (const [, prefix] of BREW_PREFIXES) {
      const result = await classifyInstall({
        ralphHome: brewRalph(prefix),
        exec: makeExec(npmRootOk()),
        fs: emptyFs(),
      })
      expect(result.kind).toBe('global-brew')
      expect(result.reason).toContain(brewRalph(prefix))
      answers.push({ ...result, reason: null })
    }
    for (const answer of answers) expect(answer).toEqual(answers[0])
  })

  it('names the layout in the reason, not only the manager that owns it', async () => {
    // `brew` alone would be the manager's name off argv[0]; what a user needs to
    // recognize is the directory they are being told about.
    const result = await classifyInstall({
      ralphHome: brewRalph('/opt/homebrew'),
      exec: makeExec(npmRootOk()),
      fs: emptyFs(),
    })
    expect(result.reason).toMatch(/Homebrew/)
    expect(result.reason).toContain('Cellar')
  })

  it('upgrades in a single spawn — one argv, no shell string and no `brew update`', async () => {
    const result = await classifyInstall({
      ralphHome: brewRalph('/opt/homebrew'),
      exec: makeExec(npmRootOk()),
      fs: emptyFs(),
    })
    expect(result.argv).toEqual(['brew', 'upgrade', 'ralph'])
    expect(result.argv.some((token) => /&&|;|\|/.test(token))).toBe(false)
  })

  it('reads the version segment as opaque, whatever brew put there', async () => {
    // A Cellar directory is not always a plain semver: `_1` is a formula
    // revision, and a `--HEAD` build is named after the commit it was built
    // from. The marker stops above all of them, so none of these can matter.
    for (const version of ['0.16.0', '0.16.0_1', '0.16.0-rc.1', 'HEAD-a1b2c3d']) {
      const result = await classifyInstall({
        ralphHome: brewRalph('/opt/homebrew', version),
        exec: makeExec(npmRootOk()),
        fs: emptyFs(),
      })
      expect(result.kind).toBe('global-brew')
      expect(result.argv).toEqual(BREW_ARGV)
    }
  })
})
