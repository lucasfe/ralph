import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { updateCommand } from './update.js'
import { classifyInstall } from '../install-target.js'

// QA augmentation for #21. The dev's update.test.js pins the happy path, the
// short-circuit, --force and the four failure exits. These tests attack:
//   1. the argv taken from the classification (`target.argv`) and the refusal
//      when a classification carries nothing runnable
//   2. currentVersion values that are not semver (undefined/null/''/ahead/prerelease)
//   3. every exec failure mode the install call can see
//   4. the NO-BOGUS-INSTALL invariant, asserted by COUNTING spawns
//   5. the {exitCode, updated, from, to} contract a later consumer (#24/#25) reads
//   6. stdout vs stderr discipline

const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`
const CURRENT = '0.15.6'
const LATEST = '0.16.0'
const VIEW_KEY = 'npm view @lucasfe/ralph version'
const ROOT_KEY = 'npm root -g'
const INSTALL_ARGV = ['npm', 'install', '-g', '@lucasfe/ralph@latest']
const INSTALL_KEY = INSTALL_ARGV.join(' ')

const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    chunks,
    output: () => strip(chunks.join('')),
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

const baseHandlers = (overrides = {}) => ({
  [VIEW_KEY]: { exitCode: 0, stdout: `${LATEST}\n`, stderr: '' },
  [ROOT_KEY]: { exitCode: 0, stdout: `${GLOBAL_ROOT}\n`, stderr: '' },
  [INSTALL_KEY]: { exitCode: 0, stdout: '', stderr: '' },
  ...overrides,
})

function deps(overrides = {}) {
  const { handlers, ...rest } = overrides
  return {
    currentVersion: CURRENT,
    ralphHome: GLOBAL_RALPH,
    stdout: makeStream(),
    stderr: makeStream(),
    exec: makeExec(baseHandlers(handlers || {})),
    ...rest,
  }
}

// Any spawn that installs anything, regardless of the exact argv shape.
const installSpawns = (exec) =>
  (exec.calls || []).filter((c) => c.args.some((a) => String(a).includes('install')))

const globalNpm = (argv) => async () => ({
  kind: 'global-npm',
  argv,
  label: Array.isArray(argv) ? argv.join(' ') : null,
  reason: 'stubbed classification',
})

describe('updateCommand — install argv taken from the classification (#21 QA)', () => {
  it('takes the argv verbatim from the classification (single source of truth)', async () => {
    const d = deps({
      classify: globalNpm(['npm', 'install', '--global', '@lucasfe/ralph@latest']),
    })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    const spawn = installSpawns(d.exec)[0]
    expect(spawn.cmd).toBe('npm')
    expect(spawn.args).toEqual(['install', '--global', '@lucasfe/ralph@latest'])
  })

  it('passes an argument containing spaces through as ONE argv token', async () => {
    // The reason argv is not a display string: #22 adds kinds whose commands
    // carry paths. A space inside a token must never split into two tokens.
    const d = deps({
      classify: globalNpm([
        'npm',
        'install',
        '-g',
        '--prefix',
        '/Users/My Name/.npm-global',
        '@lucasfe/ralph@latest',
      ]),
    })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(installSpawns(d.exec)[0].args).toEqual([
      'install',
      '-g',
      '--prefix',
      '/Users/My Name/.npm-global',
      '@lucasfe/ralph@latest',
    ])
  })

  it('spawns the install with reject:false and NO timeout (a slow install is not killed)', async () => {
    const d = deps()
    await updateCommand(d)
    const spawn = d.exec.calls.find((c) => c.key === INSTALL_KEY)
    expect(spawn.options).toMatchObject({ reject: false })
    expect(spawn.options.timeout).toBeUndefined()
  })

  it('an empty argv is treated as "cannot update" and spawns nothing', async () => {
    const d = deps({ classify: globalNpm([]) })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    expect(result.updated).toBe(false)
    expect(installSpawns(d.exec)).toHaveLength(0)
    expect(d.stderr.output()).toMatch(/could not tell how this copy/i)
  })

  it('a null argv is refused even when the kind claims to be updatable', async () => {
    // The capability lives in argv, not in the kind string: a kind this slice
    // does not know (or a future kind with nothing runnable) must not install.
    const d = deps({
      classify: async () => ({ kind: 'pnpm-global', argv: null, label: null, reason: 'r' }),
    })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    expect(installSpawns(d.exec)).toHaveLength(0)
  })

  it('runs an unfamiliar kind that DOES carry argv — capability, not an allowlist', async () => {
    // #22 adds kinds with real commands. They must work without editing update.js.
    const argv = ['pnpm', 'add', '-g', '@lucasfe/ralph@latest']
    const d = deps({
      classify: async () => ({
        kind: 'pnpm-global',
        argv,
        label: argv.join(' '),
        reason: 'r',
      }),
    })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(true)
    const spawn = d.exec.calls.find((c) => c.cmd === 'pnpm')
    expect(spawn.args).toEqual(['add', '-g', '@lucasfe/ralph@latest'])
  })
})

describe('updateCommand — currentVersion values that are not comparable (#21 QA)', () => {
  it('an omitted currentVersion reports "unknown" and still updates', async () => {
    const d = deps({ currentVersion: undefined })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(true)
    expect(result.from).toBe('unknown')
    expect(result.to).toBe(LATEST)
    expect(d.stdout.output()).toContain(`unknown → ${LATEST}`)
  })

  it('the literal string "unknown" counts as behind and updates', async () => {
    const d = deps({ currentVersion: 'unknown' })
    const result = await updateCommand(d)
    expect(result.updated).toBe(true)
    expect(result.from).toBe('unknown')
    expect(installSpawns(d.exec)).toHaveLength(1)
  })

  it('a null currentVersion counts as behind and is echoed verbatim (characterized)', async () => {
    const d = deps({ currentVersion: null })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(true)
    expect(result.from).toBeNull()
    // Cosmetic: no 'unknown' fallback for null, so the notice reads "Ralph null".
    expect(d.stdout.output()).toContain(`null → ${LATEST}`)
  })

  it('an empty-string currentVersion counts as behind and updates (characterized)', async () => {
    const d = deps({ currentVersion: '' })
    const result = await updateCommand(d)
    expect(result.updated).toBe(true)
    expect(result.from).toBe('')
    expect(d.stdout.output()).toContain(`→ ${LATEST}`)
    expect(installSpawns(d.exec)).toHaveLength(1)
  })

  it('a local prerelease is behind the matching stable release and updates', async () => {
    const d = deps({ currentVersion: '0.16.0-rc.1' })
    const result = await updateCommand(d)
    expect(result.updated).toBe(true)
    expect(result.from).toBe('0.16.0-rc.1')
    expect(result.to).toBe(LATEST)
    const out = d.stdout.output()
    expect(out).toContain('0.16.0-rc.1')
    expect(out).toContain(LATEST)
  })

  it('a whitespace-padded currentVersion equal to latest still short-circuits (characterized)', async () => {
    const d = deps({ currentVersion: ` ${LATEST} ` })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(false)
    // The padding is echoed into the message rather than normalized.
    expect(d.stdout.output()).toMatch(/already up to date \( 0\.16\.0 \)/)
    expect(installSpawns(d.exec)).toHaveLength(0)
  })

  it('a local version ahead of the registry reports the LOCAL version, never a downgrade', async () => {
    const d = deps({ currentVersion: '9.9.9' })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(false)
    expect(result.from).toBe('9.9.9')
    expect(result.to).toBe('9.9.9')
    expect(d.stdout.output()).toMatch(/already up to date \(9\.9\.9\)/)
    expect(d.stdout.output()).not.toContain(LATEST)
    expect(installSpawns(d.exec)).toHaveLength(0)
  })
})

describe('updateCommand — the no-bogus-install invariant, by spawn count (#21 QA)', () => {
  it('a thrown registry query installs nothing and never classifies', async () => {
    let classifyCalls = 0
    const d = deps({
      handlers: {
        [VIEW_KEY]: () => {
          throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
        },
      },
      classify: async () => {
        classifyCalls++
        return { kind: 'global-npm', argv: INSTALL_ARGV, label: INSTALL_KEY, reason: 'r' }
      },
    })
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 1, updated: false, to: null })
    expect(classifyCalls).toBe(0)
    expect(d.exec.calls.map((c) => c.key)).toEqual([VIEW_KEY])
  })

  it('a non-semver registry answer installs nothing', async () => {
    const d = deps({ handlers: { [VIEW_KEY]: { exitCode: 0, stdout: 'latest\n' } } })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    expect(result.to).toBeNull()
    expect(installSpawns(d.exec)).toHaveLength(0)
    expect(d.exec.calls.map((c) => c.key)).not.toContain(ROOT_KEY)
  })

  const nonFunctionExecs = [
    ['null', null],
    ['a plain object', {}],
    ['a string', 'npm'],
  ]

  for (const [label, value] of nonFunctionExecs) {
    it(`reports a registry failure and spawns nothing when exec is ${label}`, async () => {
      const d = deps({ exec: value })
      const result = await updateCommand(d)
      expect(result).toEqual({ exitCode: 1, updated: false, from: CURRENT, to: null })
      expect(d.stderr.output()).toMatch(/could not read the latest published version/i)
    })
  }

  it('--force does NOT bypass the refusal on an unrecognized layout', async () => {
    const d = deps({ force: true, handlers: { [ROOT_KEY]: { exitCode: 0, stdout: '/opt/other' } } })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    expect(result.updated).toBe(false)
    expect(installSpawns(d.exec)).toHaveLength(0)
  })

  it('--force does NOT bypass a failed registry query', async () => {
    const d = deps({ force: true, handlers: { [VIEW_KEY]: { exitCode: 1, stdout: '' } } })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    expect(result.updated).toBe(false)
    expect(installSpawns(d.exec)).toHaveLength(0)
    expect(d.exec.calls).toHaveLength(1)
  })

  it('the up-to-date short-circuit queries the registry exactly once and classifies nothing', async () => {
    let classifyCalls = 0
    const d = deps({
      handlers: { [VIEW_KEY]: { exitCode: 0, stdout: `${CURRENT}\n` } },
      classify: async () => {
        classifyCalls++
        return { kind: 'global-npm', argv: INSTALL_ARGV, label: INSTALL_KEY, reason: 'r' }
      },
    })
    await updateCommand(d)
    expect(classifyCalls).toBe(0)
    expect(d.exec.calls.map((c) => c.key)).toEqual([VIEW_KEY])
  })

  it('a fetchLatest that returns a non-semver value never installs (safe direction)', async () => {
    const d = deps({ fetchLatest: async () => 'garbage' })
    const result = await updateCommand(d)
    expect(installSpawns(d.exec)).toHaveLength(0)
    expect(result.updated).toBe(false)
    expect(result.exitCode).toBe(0)
  })

  it('forwards the injected exec and timeout to fetchLatest, and exec/ralphHome to classify', async () => {
    const seen = {}
    const d = deps({
      timeoutMs: 1234,
      fetchLatest: async (exec, timeoutMs) => {
        seen.fetch = { sameExec: exec === d.exec, timeoutMs }
        return LATEST
      },
      classify: async (opts) => {
        seen.classify = { sameExec: opts.exec === d.exec, ralphHome: opts.ralphHome }
        return { kind: 'global-npm', argv: INSTALL_ARGV, label: INSTALL_KEY, reason: 'r' }
      },
    })
    await updateCommand(d)
    expect(seen.fetch).toEqual({ sameExec: true, timeoutMs: 1234 })
    expect(seen.classify).toEqual({ sameExec: true, ralphHome: GLOBAL_RALPH })
  })
})

describe('updateCommand — install-call failure modes (#21 QA)', () => {
  const brokenResults = [
    ['resolves undefined', undefined],
    ['resolves an empty object', {}],
    ['resolves with exitCode null', { exitCode: null }],
    ['resolves with exitCode undefined', { exitCode: undefined, stdout: '' }],
  ]

  for (const [label, value] of brokenResults) {
    it(`treats an install that ${label} as a failure with exit 1`, async () => {
      const d = deps({ handlers: { [INSTALL_KEY]: value } })
      const result = await updateCommand(d)
      expect(result.exitCode).toBe(1)
      expect(result.updated).toBe(false)
      expect(result.to).toBe(LATEST)
      expect(d.stderr.output()).toMatch(/update failed/i)
    })
  }

  it('propagates an exit code above 255 verbatim', async () => {
    const d = deps({ handlers: { [INSTALL_KEY]: { exitCode: 2147483647 } } })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(2147483647)
    expect(result.updated).toBe(false)
    expect(d.stderr.output()).toContain('exited 2147483647')
  })

  it('reports a thrown non-Error from the install without crashing (characterized)', async () => {
    const d = deps({
      handlers: {
        [INSTALL_KEY]: () => {
          throw 'no npm here'
        },
      },
    })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    expect(result.updated).toBe(false)
    expect(d.stderr.output()).toMatch(/could not run/i)
  })

  it('an install that reports timedOut with exitCode 0 is still called a success (characterized)', async () => {
    // No timeout is passed to the install spawn, so execa cannot set this flag;
    // the branch only reads exitCode. Locked in so a future timeout addition
    // (#23) has to decide deliberately.
    const d = deps({ handlers: { [INSTALL_KEY]: { exitCode: 0, timedOut: true } } })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(true)
  })
})

describe('updateCommand — return-shape contract for later consumers (#21 QA)', () => {
  const branches = [
    ['registry failure', { handlers: { [VIEW_KEY]: { exitCode: 1, stdout: '' } } }],
    ['unknown layout', { handlers: { [ROOT_KEY]: { exitCode: 0, stdout: '/opt/other' } } }],
    ['already up to date', { handlers: { [VIEW_KEY]: { exitCode: 0, stdout: CURRENT } } }],
    ['install failure', { handlers: { [INSTALL_KEY]: { exitCode: 7 } } }],
    ['happy path', {}],
    ['forced reinstall', { force: true, handlers: { [VIEW_KEY]: { exitCode: 0, stdout: CURRENT } } }],
  ]

  for (const [label, overrides] of branches) {
    it(`returns all four keys with updated:true only on a clean install — ${label}`, async () => {
      const d = deps(overrides)
      const result = await updateCommand(d)
      expect(Object.keys(result).sort()).toEqual(['exitCode', 'from', 'to', 'updated'])
      expect(result.from).toBe(CURRENT)
      if (result.updated) {
        expect(result.exitCode).toBe(0)
        expect(installSpawns(d.exec)).toHaveLength(1)
      } else {
        // Not updated => either it exited non-zero, or it never spawned an install.
        expect(result.exitCode !== 0 || installSpawns(d.exec).length === 0).toBe(true)
      }
    })
  }

  it('a registry failure is the only branch with to:null', async () => {
    const d = deps({ handlers: { [VIEW_KEY]: { exitCode: 1, stdout: '' } } })
    expect(await updateCommand(d)).toEqual({
      exitCode: 1,
      updated: false,
      from: CURRENT,
      to: null,
    })
  })

  it('an unrecognized layout still reports to:latest even though nothing was installed', async () => {
    // Characterized: `to` means "the version that is out there", not "the
    // version now installed". A consumer must gate on `updated`, not on `to`.
    const d = deps({ handlers: { [ROOT_KEY]: { exitCode: 0, stdout: '/opt/other' } } })
    expect(await updateCommand(d)).toEqual({
      exitCode: 1,
      updated: false,
      from: CURRENT,
      to: LATEST,
    })
  })

  it('the up-to-date branch reports to:currentVersion, not the registry answer', async () => {
    const d = deps({ handlers: { [VIEW_KEY]: { exitCode: 0, stdout: '0.15.6' } } })
    expect(await updateCommand(d)).toEqual({
      exitCode: 0,
      updated: false,
      from: CURRENT,
      to: CURRENT,
    })
  })

  it('a forced reinstall reports updated:true with from === to', async () => {
    const d = deps({ force: true, handlers: { [VIEW_KEY]: { exitCode: 0, stdout: CURRENT } } })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 0, updated: true, from: CURRENT, to: CURRENT })
    expect(d.stdout.output()).toMatch(/reinstall/i)
  })
})

describe('updateCommand — stdout vs stderr discipline (#21 QA)', () => {
  it('the happy path writes nothing to stderr', async () => {
    const d = deps()
    await updateCommand(d)
    expect(d.stderr.output()).toBe('')
  })

  it('a registry failure splits the error (stderr) from the manual command (stdout)', async () => {
    const d = deps({ handlers: { [VIEW_KEY]: { exitCode: 1, stdout: '' } } })
    await updateCommand(d)
    expect(d.stderr.output()).toMatch(/could not read the latest published version/i)
    // Characterized: a caller capturing only stderr loses the actionable step.
    expect(d.stderr.output()).not.toContain('npm install -g @lucasfe/ralph@latest')
    expect(d.stdout.output()).toContain('npm install -g @lucasfe/ralph@latest')
  })

  it('an unrecognized layout puts the reason and the manual command on stdout only', async () => {
    const d = deps({ handlers: { [ROOT_KEY]: { exitCode: 0, stdout: '/opt/other' } } })
    await updateCommand(d)
    expect(d.stderr.output()).toMatch(/will not guess/i)
    expect(d.stderr.output()).not.toContain('npm install -g @lucasfe/ralph@latest')
    const out = d.stdout.output()
    expect(out).toContain('/opt/other')
    expect(out).toContain('Update by hand: npm install -g @lucasfe/ralph@latest')
  })

  it('a failed install prints no recovery hint on either stream (characterized gap)', async () => {
    const d = deps({ handlers: { [INSTALL_KEY]: { exitCode: 1, stderr: 'EACCES' } } })
    await updateCommand(d)
    expect(d.stderr.output()).toContain('exited 1')
    expect(d.stdout.output()).not.toMatch(/by hand/i)
    expect(d.stderr.output()).not.toMatch(/by hand/i)
  })

  it('every write is a whole line — one trailing newline, no embedded blank writes', async () => {
    for (const overrides of [
      {},
      { handlers: { [VIEW_KEY]: { exitCode: 1, stdout: '' } } },
      { handlers: { [ROOT_KEY]: { exitCode: 0, stdout: '/opt/other' } } },
      { handlers: { [INSTALL_KEY]: { exitCode: 1 } } },
    ]) {
      const d = deps(overrides)
      await updateCommand(d)
      for (const chunk of [...d.stdout.chunks, ...d.stderr.chunks]) {
        expect(chunk.endsWith('\n')).toBe(true)
        expect(chunk.slice(0, -1)).not.toContain('\n')
      }
    }
  })
})

// --- #22 QA -----------------------------------------------------------------
// QA augmentation for #22. The dev's update.test.js pins the exit-0 refusal path
// with a stubbed classification plus one end-to-end `.git` sweep. These tests
// attack the seam itself:
//   1. the load-bearing invariant, asserted on the SPAWNED ARGV: for every
//      layout — npx cache, each global store, `npm root -g`, unrecognized, and
//      an ambiguous path — a linked/dev copy spawns nothing at all
//   2. exit codes: a deliberate refusal is 0 with updated:false; a layout merely
//      not recognized stays 1; `--force` never buys past either
//   3. what the refusal prints: nothing on stderr, and never `npm install -g`,
//      which is the wrong command for those layouts
//   4. the runnable kinds, end-to-end, spawning that manager's own command
//   5. the `advice` field itself: what update.js does with a malformed
//      classification (advice + argv, empty advice, missing reason)
// Every path is synthesized, so the real classification is always wrapped with a
// memfs volume: no directory on this machine can decide one of these tests.

const USER_HOME = '/Users/me'
const CHECKOUT = `${USER_HOME}/repos/ralph`
const NPX_RALPH = `${USER_HOME}/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph`
const PNPM_RALPH = `${USER_HOME}/Library/pnpm/global/5/node_modules/@lucasfe/ralph`
const YARN_RALPH = `${USER_HOME}/.config/yarn/global/node_modules/@lucasfe/ralph`
const BUN_RALPH = `${USER_HOME}/.bun/install/global/node_modules/@lucasfe/ralph`
// Two managers' markers on one path. The pnpm half is spelled `pnpm/global`: a
// bare `.pnpm` segment no longer means pnpm, because it also matched
// project-local installs.
const AMBIG_RALPH = `${USER_HOME}/.config/yarn/global/node_modules/pnpm/global/node_modules/@lucasfe/ralph`

// The real classification, with the filesystem stubbed. updateCommand has no fs
// parameter of its own, so this wrapper is the only way to reach it end-to-end.
const withFs = (vol) => (opts) => classifyInstall({ ...opts, fs: vol })

const noVol = () => Volume.fromJSON({})
const gitDirVol = (root) => Volume.fromJSON({ [`${root}/.git/HEAD`]: 'ref: refs/heads/main\n' })
function symlinkVol(root, target = root === CHECKOUT ? `${USER_HOME}/repos/ralph-fork` : CHECKOUT) {
  const vol = Volume.fromJSON({ [`${target}/package.json`]: '{}' })
  vol.mkdirSync(root.slice(0, root.lastIndexOf('/')), { recursive: true })
  vol.symlinkSync(target, root)
  return vol
}

// `npm link`: the same symlink, with a real checkout behind it.
function linkedCheckoutVol(root, target = `${USER_HOME}/repos/ralph-src`) {
  const vol = symlinkVol(root, target)
  vol.mkdirSync(`${target}/.git`, { recursive: true })
  vol.writeFileSync(`${target}/.git/HEAD`, 'ref: refs/heads/main\n')
  return vol
}

// Anything spawned that is not one of the two read-only probes. Stronger than
// grepping for 'install': `yarn global add` and `pnpm add -g` do not say it.
const nonProbeSpawns = (exec) =>
  (exec.calls || []).filter((c) => c.key !== VIEW_KEY && c.key !== ROOT_KEY)

const LAYOUTS = [
  ['an npx cache', NPX_RALPH],
  ['a pnpm global store', PNPM_RALPH],
  ['a yarn global dir', YARN_RALPH],
  ['a bun global dir', BUN_RALPH],
  ['the npm global root', GLOBAL_RALPH],
  ['a plain dev checkout', CHECKOUT],
  ['an unrecognized directory', `${USER_HOME}/somewhere/else/ralph`],
  ['a path matching two managers', AMBIG_RALPH],
]

// The global-add command each store owns, for the layouts where exactly one
// store marker matches. Anything else has no single command to name.
const STORE_COMMAND = {
  [PNPM_RALPH]: 'pnpm add -g @lucasfe/ralph@latest',
  [YARN_RALPH]: 'yarn global add @lucasfe/ralph@latest',
  [BUN_RALPH]: 'bun add -g @lucasfe/ralph@latest',
}

describe('updateCommand — never installs over a checkout, whatever the layout (#22 QA)', () => {
  for (const [label, home] of LAYOUTS) {
    // `checkout` says whether a working tree is reachable from the package root,
    // which is what decides the wording: a `.git` in the root or behind the link
    // means `git pull`; a link with nothing but a package behind it does not.
    for (const [how, vol, checkout] of [
      ['a .git directory', gitDirVol, true],
      ['a symlinked package root', symlinkVol, false],
      ['a symlink with a checkout behind it', linkedCheckoutVol, true],
    ]) {
      it(`spawns nothing for ${label} carrying ${how}`, async () => {
        const d = deps({ ralphHome: home, classify: withFs(vol(home)) })
        const result = await updateCommand(d)
        expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
        // The registry query is the ONLY thing that ran: no install, and not
        // even the `npm root -g` probe, because the refusal is decided first.
        expect(d.exec.calls.map((c) => c.key)).toEqual([VIEW_KEY])
        expect(nonProbeSpawns(d.exec)).toHaveLength(0)
      })

      it(`tells the user what to do for ${label} carrying ${how}, never npm`, async () => {
        // Which linked signal fired decides what the refusal SAYS. A reachable
        // `.git` means a checkout, so `git pull`. A symlink with no `.git` behind
        // it does not: pnpm and bun both symlink their global package roots, so
        // that case names the store's own command, or stays generic outside every
        // store. These rows used to expect `git pull` for every signal.
        const d = deps({ ralphHome: home, classify: withFs(vol(home)) })
        await updateCommand(d)
        const out = d.stdout.output()
        expect(out).toMatch(/nothing for ralph to update/i)
        expect(out).not.toContain('npm install -g')
        if (checkout) {
          expect(out).toContain('git pull')
          expect(out).not.toMatch(/pnpm add|yarn global add|bun add/)
        } else if (STORE_COMMAND[home]) {
          expect(out).toContain(STORE_COMMAND[home])
          expect(out).not.toContain('git pull')
        } else {
          expect(out).toMatch(/package manager/i)
          expect(out).not.toContain('git pull')
          expect(out).not.toMatch(/pnpm add|yarn global add|bun add/)
        }
        // Nothing failed, so nothing goes to stderr.
        expect(d.stderr.output()).toBe('')
      })
    }
  }

  it('--force does not buy past a linked checkout, even when already up to date', async () => {
    const d = deps({
      force: true,
      currentVersion: LATEST,
      ralphHome: GLOBAL_RALPH,
      classify: withFs(symlinkVol(GLOBAL_RALPH)),
      handlers: { [VIEW_KEY]: { exitCode: 0, stdout: `${LATEST}\n` } },
    })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 0, updated: false, from: LATEST, to: LATEST })
    expect(nonProbeSpawns(d.exec)).toHaveLength(0)
  })

  it('--force does not buy past an npx cache', async () => {
    const d = deps({ force: true, ralphHome: NPX_RALPH, classify: withFs(noVol()) })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(false)
    expect(nonProbeSpawns(d.exec)).toHaveLength(0)
  })

  it('refuses a checkout whose .git is a FILE (worktree/submodule)', async () => {
    const vol = Volume.fromJSON({ [`${CHECKOUT}/.git`]: 'gitdir: /elsewhere/.git/worktrees/w\n' })
    const d = deps({ ralphHome: CHECKOUT, classify: withFs(vol) })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(nonProbeSpawns(d.exec)).toHaveLength(0)
  })
})

describe('updateCommand — deliberate refusals exit 0 through the real classification (#22 QA)', () => {
  const refusals = [
    ['an npx cache', NPX_RALPH, noVol(), /npx/i],
    ['a linked dev checkout', CHECKOUT, gitDirVol(CHECKOUT), /git pull/],
    // Symlink with no `.git` behind it: a linked install, not a checkout, so the
    // advice is no longer `git pull` — this row used to expect it.
    ['a symlinked global install', GLOBAL_RALPH, symlinkVol(GLOBAL_RALPH), /package manager/i],
  ]

  for (const [label, home, vol, expected] of refusals) {
    it(`exits 0 with updated:false for ${label}`, async () => {
      const d = deps({ ralphHome: home, classify: withFs(vol) })
      const result = await updateCommand(d)
      expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
      expect(d.stdout.output()).toMatch(expected)
    })

    it(`writes nothing to stderr and no manual npm command for ${label}`, async () => {
      const d = deps({ ralphHome: home, classify: withFs(vol) })
      await updateCommand(d)
      expect(d.stderr.output()).toBe('')
      const out = d.stdout.output()
      expect(out).not.toContain('npm install -g')
      expect(out).not.toMatch(/update by hand/i)
      expect(out).not.toMatch(/❌/)
    })

    it(`writes whole lines only for ${label}`, async () => {
      const d = deps({ ralphHome: home, classify: withFs(vol) })
      await updateCommand(d)
      expect(d.stdout.chunks.length).toBeGreaterThan(0)
      for (const chunk of [...d.stdout.chunks, ...d.stderr.chunks]) {
        expect(chunk.endsWith('\n')).toBe(true)
        expect(chunk.slice(0, -1)).not.toContain('\n')
      }
    })

    it(`exits 0 for ${label} even when the local version is not semver`, async () => {
      const d = deps({ currentVersion: 'unknown', ralphHome: home, classify: withFs(vol) })
      const result = await updateCommand(d)
      expect(result).toEqual({ exitCode: 0, updated: false, from: 'unknown', to: LATEST })
      expect(nonProbeSpawns(d.exec)).toHaveLength(0)
    })
  }

  it('reports the reason as well as the advice, so the user learns WHY', async () => {
    const d = deps({ ralphHome: NPX_RALPH, classify: withFs(noVol()) })
    await updateCommand(d)
    const out = d.stdout.output()
    expect(out).toContain(NPX_RALPH)
    expect(out).toContain('_npx')
  })

  it('still exits 1 for layouts it merely failed to recognize', async () => {
    const unrecognized = [
      ['a directory outside every known layout', `${USER_HOME}/somewhere/else/ralph`],
      ['a path matching two managers', AMBIG_RALPH],
      ['a blank install directory', ''],
    ]
    for (const [, home] of unrecognized) {
      const d = deps({ ralphHome: home, classify: withFs(noVol()) })
      const result = await updateCommand(d)
      expect(result).toEqual({ exitCode: 1, updated: false, from: CURRENT, to: LATEST })
      expect(nonProbeSpawns(d.exec)).toHaveLength(0)
      expect(d.stderr.output()).toMatch(/could not tell how this copy/i)
      // Unlike a refusal, this branch DOES print the manual npm command.
      expect(d.stdout.output()).toContain(`Update by hand: ${INSTALL_KEY}`)
    }
  })
})

describe('updateCommand — runnable layouts spawn that manager own command (#22 QA)', () => {
  const runnable = [
    ['a pnpm global store', PNPM_RALPH, ['pnpm', ['add', '-g', '@lucasfe/ralph@latest']]],
    ['a yarn global dir', YARN_RALPH, ['yarn', ['global', 'add', '@lucasfe/ralph@latest']]],
    ['a bun global dir', BUN_RALPH, ['bun', ['add', '-g', '@lucasfe/ralph@latest']]],
    ['the npm global root', GLOBAL_RALPH, ['npm', ['install', '-g', '@lucasfe/ralph@latest']]],
  ]

  for (const [label, home, [cmd, args]] of runnable) {
    it(`spawns exactly \`${cmd} ${args.join(' ')}\` for ${label}`, async () => {
      const d = deps({ ralphHome: home, classify: withFs(noVol()) })
      const result = await updateCommand(d)
      expect(result).toEqual({ exitCode: 0, updated: true, from: CURRENT, to: LATEST })
      const spawns = nonProbeSpawns(d.exec)
      expect(spawns).toHaveLength(1)
      expect(spawns[0]).toMatchObject({ cmd, args })
      expect(spawns[0].options).toMatchObject({ reject: false })
    })

    it(`reports the failure with that manager's own label when ${label} fails`, async () => {
      const key = `${cmd} ${args.join(' ')}`
      const d = deps({
        ralphHome: home,
        classify: withFs(noVol()),
        handlers: { [key]: { exitCode: 7, stdout: '', stderr: 'boom' } },
      })
      const result = await updateCommand(d)
      expect(result).toEqual({ exitCode: 7, updated: false, from: CURRENT, to: LATEST })
      expect(d.stderr.output()).toContain(key)
      expect(d.stderr.output()).toContain('exited 7')
    })
  }

  it('refuses to guess for a project-local pnpm copy instead of installing globally', async () => {
    // This used to spawn `pnpm add -g` and report updated:true, while the copy
    // that is running went untouched — a global install the user never had, and
    // an `updated` flag #24/#25 gate on that lied. A bare `.pnpm` segment no
    // longer means "pnpm global", so this falls closed like the npm equivalent.
    const local = `${USER_HOME}/proj/node_modules/.pnpm/@lucasfe+ralph@0.16.0/node_modules/@lucasfe/ralph`
    const d = deps({ ralphHome: local, classify: withFs(noVol()) })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 1, updated: false, from: CURRENT, to: LATEST })
    expect(nonProbeSpawns(d.exec)).toHaveLength(0)
    expect(d.stderr.output()).toMatch(/could not tell how this copy/i)
  })

  it('never probes `npm root -g` for a layout a marker already decided', async () => {
    for (const [, home] of runnable.slice(0, 3)) {
      const d = deps({ ralphHome: home, classify: withFs(noVol()) })
      await updateCommand(d)
      expect(d.exec.calls.map((c) => c.key)).not.toContain(ROOT_KEY)
    }
  })
})

describe('updateCommand — the advice seam itself (#22 QA)', () => {
  const classification = (extra) => async () => ({
    kind: 'linked',
    argv: null,
    label: null,
    reason: 'a reason',
    ...extra,
  })

  it('refuses when a classification carries BOTH an argv and advice', async () => {
    // update.js used to gate on `argv?.length` first, so a classification that
    // set both installed anyway. Advice is checked first now, so "never install
    // over a linked checkout" no longer rests on classifyInstall never setting
    // both fields. Still data, never a kind allowlist.
    const d = deps({
      classify: classification({
        argv: INSTALL_ARGV,
        label: INSTALL_KEY,
        advice: 'Run `git pull` in that checkout to update it.',
      }),
    })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
    expect(nonProbeSpawns(d.exec)).toHaveLength(0)
  })

  it('an empty-string advice is NOT a refusal and keeps exit 1 (characterized)', async () => {
    const d = deps({ classify: classification({ advice: '' }) })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    expect(d.stderr.output()).toMatch(/could not tell how this copy/i)
    expect(nonProbeSpawns(d.exec)).toHaveLength(0)
  })

  it('any truthy advice is a refusal, whatever the kind claims (no kind allowlist)', async () => {
    for (const kind of ['npx', 'linked', 'global-brew', 'something-new', 'unknown']) {
      const d = deps({ classify: classification({ kind, advice: 'Do that instead.' }) })
      const result = await updateCommand(d)
      expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
      expect(d.stdout.output()).toContain('Do that instead.')
      expect(nonProbeSpawns(d.exec)).toHaveLength(0)
    }
  })

  it('an empty argv alongside advice still refuses with exit 0', async () => {
    const d = deps({ classify: classification({ argv: [], label: '', advice: 'Nothing to do.' }) })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(nonProbeSpawns(d.exec)).toHaveLength(0)
  })

  it('omits the reason line when a refusal has no reason', async () => {
    const d = deps({ classify: classification({ reason: null, advice: 'Only advice.' }) })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.stdout.chunks).toHaveLength(2)
    expect(d.stdout.output()).toContain('Only advice.')
  })

  it('passes only ralphHome and exec to the classification — the fs seam is not reachable here', async () => {
    // Characterized: `ralph update` always classifies against the REAL
    // filesystem; only a test that wraps `classify` can stub it.
    let seen = null
    const d = deps({
      ralphHome: CHECKOUT,
      classify: async (opts) => {
        seen = opts
        return { kind: 'unknown', argv: null, label: null, reason: 'r', advice: null }
      },
    })
    await updateCommand(d)
    expect(Object.keys(seen).sort()).toEqual(['exec', 'ralphHome'])
    expect(seen.ralphHome).toBe(CHECKOUT)
    expect(seen.fs).toBeUndefined()
  })

  it('returns the same four keys on the refusal branch as on every other branch', async () => {
    const d = deps({ ralphHome: NPX_RALPH, classify: withFs(noVol()) })
    const result = await updateCommand(d)
    expect(Object.keys(result).sort()).toEqual(['exitCode', 'from', 'to', 'updated'])
    // `to` still names the version that is out there, not the one installed.
    expect(result.to).toBe(LATEST)
  })

  it('short-circuits before classifying when already up to date, even for a refusable layout', async () => {
    let classifyCalls = 0
    const d = deps({
      ralphHome: NPX_RALPH,
      handlers: { [VIEW_KEY]: { exitCode: 0, stdout: `${CURRENT}\n` } },
      classify: async (...a) => {
        classifyCalls++
        return withFs(noVol())(...a)
      },
    })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: CURRENT })
    expect(classifyCalls).toBe(0)
  })
})

// --- #22 QA, second pass ----------------------------------------------------
// Store matching moved above the two refusals inside classifyInstall so a
// symlink refusal can name the manager's command. These tests hold the acceptance
// criterion at the only level that can prove it: what `ralph update` SPAWNS.

const STORE_ROWS = [
  ['a pnpm global store', PNPM_RALPH, ['pnpm', ['add', '-g', '@lucasfe/ralph@latest']]],
  ['a yarn global dir', YARN_RALPH, ['yarn', ['global', 'add', '@lucasfe/ralph@latest']]],
  ['a bun global dir', BUN_RALPH, ['bun', ['add', '-g', '@lucasfe/ralph@latest']]],
  ['the npm global root', GLOBAL_RALPH, ['npm', ['install', '-g', '@lucasfe/ralph@latest']]],
]

describe('updateCommand — no store command is ever spawned for a refused layout (#22 QA)', () => {
  // The layout × linked-signal matrix lives in "never installs over a checkout,
  // whatever the layout" above, which already pins the spawned keys as exactly
  // `[VIEW_KEY]`. These tests are what that matrix cannot say.
  for (const [label, home, [cmd, args]] of STORE_ROWS) {
    it(`spawns \`${cmd} ${args.join(' ')}\` for ${label}, and nothing at all once it is linked`, async () => {
      // The two halves side by side, on one path: the store command is genuinely
      // reachable, and every linked signal takes it away.
      const clean = deps({ ralphHome: home, classify: withFs(noVol()) })
      expect(await updateCommand(clean)).toEqual({ exitCode: 0, updated: true, from: CURRENT, to: LATEST })
      expect(nonProbeSpawns(clean.exec)).toHaveLength(1)
      expect(nonProbeSpawns(clean.exec)[0]).toMatchObject({ cmd, args })

      for (const vol of [gitDirVol, symlinkVol, linkedCheckoutVol]) {
        const d = deps({ ralphHome: home, classify: withFs(vol(home)) })
        const result = await updateCommand(d)
        expect(result.updated).toBe(false)
        expect(result.exitCode).toBe(0)
        expect(nonProbeSpawns(d.exec)).toHaveLength(0)
      }
    })
  }

  it('refuses an npx cache nested inside any store, naming npx and no manager', async () => {
    const caches = [
      `${USER_HOME}/Library/pnpm/global/5/node_modules/_npx/ab/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/.config/yarn/global/node_modules/_npx/ab/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/.bun/install/global/node_modules/_npx/ab/node_modules/@lucasfe/ralph`,
    ]
    for (const home of caches) {
      const d = deps({ ralphHome: home, classify: withFs(noVol()) })
      const result = await updateCommand(d)
      expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
      expect(d.exec.calls.map((c) => c.key)).toEqual([VIEW_KEY])
      const out = d.stdout.output()
      expect(out).toMatch(/npx/i)
      expect(out).not.toMatch(/pnpm add|yarn global add|bun add|npm install -g/)
    }
  })

  it('tells a `npm link`ed copy to `git pull`, in every store', async () => {
    for (const [, home] of LAYOUTS) {
      const d = deps({ ralphHome: home, classify: withFs(linkedCheckoutVol(home)) })
      await updateCommand(d)
      const out = d.stdout.output()
      expect(out).toContain('git pull')
      expect(out).not.toMatch(/pnpm add|yarn global add|bun add|npm install -g/)
    }
  })

  it('--force spawns nothing for a classification carrying both an argv and advice', async () => {
    // The advice gate is checked before the argv gate now; --force must not
    // reorder them.
    const d = deps({
      force: true,
      classify: async () => ({
        kind: 'global-npm',
        argv: INSTALL_ARGV,
        label: INSTALL_KEY,
        reason: 'a reason',
        advice: 'Run `git pull` in that checkout to update it.',
      }),
    })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
    expect(nonProbeSpawns(d.exec)).toHaveLength(0)
    expect(d.stdout.output()).toContain('git pull')
  })

  it('refuses every project-local pnpm layout instead of installing one globally', async () => {
    for (const home of [
      `${USER_HOME}/proj/node_modules/.pnpm/@lucasfe+ralph@0.16.0/node_modules/@lucasfe/ralph`,
      `${USER_HOME}/proj/packages/app/node_modules/.pnpm/@lucasfe+ralph@0.16.0/node_modules/@lucasfe/ralph`,
      `/srv/ci/build/node_modules/.pnpm/@lucasfe+ralph@0.16.0/node_modules/@lucasfe/ralph`,
    ]) {
      const d = deps({ ralphHome: home, classify: withFs(noVol()) })
      const result = await updateCommand(d)
      // exit 1 and updated:false — never a global install of a package the user
      // only has locally, and never a truthy `updated` for #24/#25 to act on.
      expect(result).toEqual({ exitCode: 1, updated: false, from: CURRENT, to: LATEST })
      expect(nonProbeSpawns(d.exec)).toHaveLength(0)
      expect(d.stdout.output()).not.toMatch(/pnpm add -g/)
    }
  })
})
