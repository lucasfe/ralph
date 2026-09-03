import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { updateCommand } from './update.js'
import { installFailureDetails } from '../install-failure.js'
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
// #199: a Homebrew install asks the TAP what the latest version is, so the brew
// cases below need `brew info` to answer as well as `brew upgrade`. The document is
// the two fields `fetchLatestVersion` reads (lib/update-check.channel.test.js
// records the shape measured against a real Homebrew).
const BREW_INFO_KEY = 'brew info --json=v2 ralph'
const brewInfoSaying = (stable) => ({
  exitCode: 0,
  stdout: JSON.stringify({ formulae: [{ name: 'ralph', versions: { stable } }], casks: [] }),
  stderr: '',
})

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
  [BREW_INFO_KEY]: brewInfoSaying(LATEST),
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
  it('a thrown registry query installs nothing, whatever the classification offered', async () => {
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
    // #199: the classification now runs FIRST — it is what names the channel to
    // query — so it is expected to have run exactly once with a runnable argv in
    // hand. The invariant this test is here for is the SPAWN list: the query is the
    // last thing that ran, and the argv it was holding was never used.
    expect(classifyCalls).toBe(1)
    expect(d.exec.calls.map((c) => c.key)).toEqual([VIEW_KEY])
  })

  it('a non-semver registry answer installs nothing', async () => {
    const d = deps({ handlers: { [VIEW_KEY]: { exitCode: 0, stdout: 'latest\n' } } })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    expect(result.to).toBeNull()
    expect(installSpawns(d.exec)).toHaveLength(0)
    // #199: `npm root -g` is the classification, and it now runs before the query
    // rather than after it, so what is pinned is the order and the absence of
    // anything past the unusable answer.
    expect(d.exec.calls.map((c) => c.key)).toEqual([ROOT_KEY, VIEW_KEY])
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
    // Classification (`npm root -g`) then the query, and nothing after it (#199).
    expect(d.exec.calls.map((c) => c.key)).toEqual([ROOT_KEY, VIEW_KEY])
  })

  it('the up-to-date short-circuit queries the registry exactly once and installs nothing', async () => {
    let classifyCalls = 0
    const d = deps({
      handlers: { [VIEW_KEY]: { exitCode: 0, stdout: `${CURRENT}\n` } },
      classify: async () => {
        classifyCalls++
        return { kind: 'global-npm', argv: INSTALL_ARGV, label: INSTALL_KEY, reason: 'r' }
      },
    })
    await updateCommand(d)
    // #199: classified once, up front, because the classification chooses the
    // query. The short-circuit is still on the VERSION — one query, no spawn of the
    // argv it was holding.
    expect(classifyCalls).toBe(1)
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

  it('a failed install puts its whole diagnosis on stderr (gap closed by #23)', async () => {
    // This row used to assert the ABSENCE of any recovery hint. #23 fills the
    // gap: what the manager said, plus the permission fix, now land under the
    // headline — all on stderr, so a wrapper capturing only stderr keeps the
    // whole diagnosis instead of an opaque "exited 1".
    const d = deps({ handlers: { [INSTALL_KEY]: { exitCode: 1, stderr: 'EACCES' } } })
    await updateCommand(d)
    expect(d.stderr.output()).toContain('exited 1')
    expect(d.stderr.output()).toMatch(/permission/i)
    expect(d.stderr.output()).toContain(`sudo ${INSTALL_KEY}`)
    expect(d.stdout.output()).not.toMatch(/permission|sudo/i)
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

// Anything spawned that is not one of the read-only probes. Stronger than
// grepping for 'install': `yarn global add` and `pnpm add -g` do not say it.
// #199 added a third probe — `brew info`, the tap's version read — which changes
// nothing about what a REFUSAL may spawn: it reports a version and writes nothing.
const READ_ONLY_PROBES = [VIEW_KEY, ROOT_KEY, BREW_INFO_KEY]
const nonProbeSpawns = (exec) =>
  (exec.calls || []).filter((c) => !READ_ONLY_PROBES.includes(c.key))

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

  it('short-circuits on the version when already up to date, even for a refusable layout', async () => {
    // The refusal wording is never reached: an up-to-date copy is up to date
    // whatever its layout would have advised. #199 moved the classification ahead
    // of the query, so it does run — once — but only to choose the channel; what
    // must not appear is the "nothing for Ralph to update here" branch below it.
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
    expect(classifyCalls).toBe(1)
    expect(d.stdout.output()).not.toMatch(/nothing for ralph to update/i)
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

// --- #23 QA -----------------------------------------------------------------
// QA augmentation for #23. The dev's update.test.js pins the stderr tail, the two
// truncation bounds, the permission hint and the exit code with a stubbed failing
// `exec`. The wording bounds themselves are attacked in install-failure.qa.test.js;
// these tests attack what only the command can decide:
//   1. the bound as the STREAM sees it — how many writes, how many bytes, and
//      whether the module's lines arrive verbatim, one per write
//   2. stream discipline: the whole diagnosis on stderr, nothing on stdout
//   3. the exit contract around the diagnostics: verbatim codes, exit 0 with
//      garbage on stderr staying silent, a signal-killed install, refusals
//   4. the failure shapes REAL execa produces with `reject: false` — which is
//      what update.js passes, and which changes what "the command never ran"
//      even looks like: execa RESOLVES that case (exitCode undefined, code
//      ENOENT/EACCES, empty output, the cause only in `message`) instead of
//      throwing. Verified against node_modules/execa.
//   5. the catch branch with the error shapes it can actually see

// A failing install, everything else on the happy path, through the real
// classification of the npm global root.
const failing = (failure, overrides = {}) =>
  deps({ handlers: { [INSTALL_KEY]: failure }, ...overrides })

// What execa returns — resolves, does NOT throw — when the command cannot be
// spawned at all and `reject: false` is set. `exitCode` is undefined, the output
// is empty, and `message`/`code` are the only carriers of the cause.
const spawnFailure = (code) => ({
  exitCode: undefined,
  code,
  failed: true,
  stdout: '',
  stderr: '',
  shortMessage: `Command failed with ${code}: ${INSTALL_KEY}\nspawn npm ${code}`,
  message: `Command failed with ${code}: ${INSTALL_KEY}\nspawn npm ${code}`,
})

const npmLog = (n) => Array.from({ length: n }, (_, i) => `npm error line ${i + 1}`).join('\n')

describe('updateCommand — the diagnostics bound, as the stream sees it (#23 QA)', () => {
  it('turns a 200k-line npm log into a screenful of bounded writes', async () => {
    const d = failing({ exitCode: 1, stderr: npmLog(200_000) })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    // 1 headline + 1 `npm wrote:` + 1 omitted marker + 12 kept lines.
    expect(d.stderr.chunks).toHaveLength(15)
    expect(d.stderr.output().length).toBeLessThan(2000)
    for (const chunk of d.stderr.chunks) {
      expect(chunk.endsWith('\n')).toBe(true)
      expect(chunk.slice(0, -1)).not.toContain('\n')
      expect(chunk.length).toBeLessThan(300)
    }
    const out = d.stderr.output()
    expect(out).toContain('npm error line 200000')
    expect(out).toMatch(/199988 earlier lines omitted/)
  })

  it('clips one 5 MB line instead of streaming megabytes to the terminal', async () => {
    const d = failing({ exitCode: 1, stderr: `npm error ${'x'.repeat(5 * 1024 * 1024)}` })
    await updateCommand(d)
    expect(d.stderr.output().length).toBeLessThan(1000)
    expect(d.stderr.chunks).toHaveLength(3)
    expect(d.stderr.output()).toContain('…')
  })

  it('writes the module lines verbatim, in order, one write each', async () => {
    // The contract between update.js and install-failure.js: no re-wrapping, no
    // joining, no reordering — a wrapper reading stderr line by line sees exactly
    // the display-ready lines the module produced.
    const failure = { exitCode: 1, stdout: '', stderr: 'npm error code EACCES\nnpm error errno -13' }
    const d = failing(failure)
    await updateCommand(d)
    const written = d.stderr.chunks.map((c) => strip(c).slice(0, -1))
    expect(written).toEqual([
      `❌ Update failed: \`${INSTALL_KEY}\` exited 1.`,
      ...installFailureDetails(failure, { argv: INSTALL_ARGV, label: INSTALL_KEY }),
    ])
  })

  it('leaves stdout with nothing but the progress line when the install fails', async () => {
    const d = failing({ exitCode: 1, stderr: 'npm error code EACCES\nnpm error errno -13' })
    await updateCommand(d)
    expect(d.stdout.chunks).toHaveLength(1)
    expect(d.stdout.output()).toMatch(/^Updating Ralph .*\n$/)
    expect(d.stdout.output()).not.toMatch(/sudo|permission|omitted|wrote:/i)
  })
})

describe('updateCommand — the exit contract around the diagnostics (#23 QA)', () => {
  const codes = [127, 243, 1]

  for (const exitCode of codes) {
    it(`exits ${exitCode} verbatim and still prints the diagnosis`, async () => {
      const d = failing({ exitCode, stderr: 'npm error code EACCES' })
      const result = await updateCommand(d)
      expect(result).toEqual({ exitCode, updated: false, from: CURRENT, to: LATEST })
      expect(d.stderr.output()).toContain(`exited ${exitCode}`)
      expect(d.stderr.output()).toContain('npm error code EACCES')
    })
  }

  it('prints NO diagnostics for an install that exited 0 with a flood on stderr', async () => {
    // npm writes deprecation and funding notices to stderr on a perfectly good
    // install. Only the exit code decides whether anything failed.
    const d = failing({
      exitCode: 0,
      stderr: `npm warn deprecated x\n${npmLog(500)}\nnpm error code EACCES`,
    })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 0, updated: true, from: CURRENT, to: LATEST })
    expect(d.stderr.output()).toBe('')
    expect(d.stdout.output()).not.toMatch(/sudo|permission|omitted|wrote:|❌/i)
  })

  it('treats an install that resolved null as a failure and still says something', async () => {
    const d = failing(null)
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    const out = d.stderr.output()
    expect(out).toContain('exited 1')
    expect(out).toMatch(/printed no output/)
    expect(out).toContain(INSTALL_KEY)
    expect(out).not.toContain('undefined')
  })

  it('reports an install killed by a signal as a failure, with what it printed', async () => {
    // execa reports a signal death with exitCode undefined and a signal name.
    const d = failing({ exitCode: undefined, signal: 'SIGKILL', stdout: '', stderr: 'Killed' })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    expect(d.stderr.output()).toContain('Killed')
  })

  it('prints no install diagnostics for a refusal reached through the real classification', async () => {
    for (const [home, vol] of [
      [NPX_RALPH, noVol()],
      [CHECKOUT, gitDirVol(CHECKOUT)],
      [GLOBAL_RALPH, symlinkVol(GLOBAL_RALPH)],
    ]) {
      const d = deps({ ralphHome: home, classify: withFs(vol) })
      const result = await updateCommand(d)
      expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
      expect(d.stderr.output()).toBe('')
      expect(nonProbeSpawns(d.exec)).toHaveLength(0)
      expect(d.stdout.output()).not.toMatch(/sudo|permission|omitted|wrote:|❌/i)
    }
  })
})

describe('updateCommand — each manager gets its own fix, end to end (#23 QA)', () => {
  const managers = [
    ['a pnpm global store', PNPM_RALPH, 'pnpm add -g @lucasfe/ralph@latest', 'pnpm setup'],
    ['a yarn global dir', YARN_RALPH, 'yarn global add @lucasfe/ralph@latest', 'yarn config set prefix'],
    ['a bun global dir', BUN_RALPH, 'bun add -g @lucasfe/ralph@latest', 'BUN_INSTALL'],
  ]

  for (const [label, home, key, knob] of managers) {
    it(`names ${key.split(' ')[0]}'s own knob for a permission failure in ${label}`, async () => {
      // Through the REAL classification, so the manager whose knob is named is
      // the manager the layout actually chose.
      const d = deps({
        ralphHome: home,
        classify: withFs(noVol()),
        handlers: { [key]: { exitCode: 1, stdout: '', stderr: "EACCES: permission denied, mkdir '/x'" } },
      })
      const result = await updateCommand(d)
      expect(result.exitCode).toBe(1)
      const out = d.stderr.output()
      expect(out).toContain(knob)
      expect(out).toContain(`sudo ${key}`)
      // npm's prefix knob is the wrong advice for every one of these.
      expect(out).not.toContain('npm config set prefix')
      expect(out).not.toContain(`sudo ${INSTALL_KEY}`)
    })
  }
})

describe('updateCommand — the catch branch, with the shapes it can really see (#23 QA)', () => {
  const throwing = (error) => {
    const d = deps()
    const inner = d.exec
    const exec = async (cmd, args, options) => {
      if (`${cmd} ${args.join(' ')}` === INSTALL_KEY) throw error
      return inner(cmd, args, options)
    }
    exec.calls = inner.calls
    return { ...d, exec }
  }

  it('does not blame permissions for a missing binary (ENOENT is not EACCES)', async () => {
    const e = new Error('spawn npm ENOENT')
    e.code = 'ENOENT'
    const d = throwing(e)
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    const out = d.stderr.output()
    expect(out).toMatch(/could not run/i)
    expect(out).toContain(INSTALL_KEY)
    expect(out).not.toMatch(/permission error|sudo|config set prefix/i)
  })

  it('survives an error carrying no message at all and still names the command', async () => {
    const d = throwing(new Error(''))
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 1, updated: false, from: CURRENT, to: LATEST })
    expect(d.stderr.output()).toContain(INSTALL_KEY)
    for (const chunk of d.stderr.chunks) expect(chunk.slice(0, -1)).not.toContain('\n')
  })

  it('survives a thrown string, hinting nothing because a string carries no fields', async () => {
    // Characterized: execa always throws an Error, so this is only reachable from
    // a broken stub — but it must not crash the command, and the text of a thrown
    // string is not searched for signals.
    const d = throwing('EACCES: permission denied')
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    expect(d.stderr.output()).toMatch(/could not run/i)
    expect(d.stderr.output()).not.toMatch(/permission error|sudo/i)
  })

  it('keeps the failure headline to one bounded line, whatever the error message', async () => {
    // The headline names the cause, and real error messages are neither one line nor
    // bounded — which is why it goes through `failureCause` and never `e.message`
    // raw. Two shapes execa really produces:
    //   1. an invalid-option TypeError — two lines, which execa throws even with
    //      `reject: false` (verified against execa 9)
    //   2. an ExecaError, whose `message` includes the subprocess output BY
    //      DESIGN — `shortMessage` is the one that excludes it, see
    //      node_modules/execa/types/return/result.d.ts
    // Interpolated raw, either one would put several lines in a single `write()`, and
    // the second would carry the whole unbounded log the rest of #23 goes to such
    // lengths to clip — so both shapes are driven through the real headline here.
    const invalidOption = new TypeError(
      'Invalid option `encoding: "bogus"`.\nPlease rename it to one of: "utf8", "buffer".',
    )
    const execaError = new Error(`Command failed with exit code 1: ${INSTALL_KEY}\n\n${npmLog(500)}`)
    execaError.code = 'EACCES'
    execaError.stderr = npmLog(500)

    for (const error of [invalidOption, execaError]) {
      const d = throwing(error)
      await updateCommand(d)
      for (const chunk of d.stderr.chunks) {
        expect(chunk.slice(0, -1)).not.toContain('\n')
      }
      expect(d.stderr.output().length).toBeLessThan(2000)
    }
  })
})

describe('updateCommand — a command that could not be spawned at all (#23 QA)', () => {
  // `reject: false` is what update.js passes, and with it execa RESOLVES a spawn
  // failure instead of throwing: `exitCode` undefined, `code` ENOENT/EACCES,
  // stdout and stderr both empty, and the cause spelled only in `message`.
  // Verified against node_modules/execa 9.
  it('reports WHY npm could not run, instead of claiming it printed nothing', async () => {
    const d = failing(spawnFailure('ENOENT'))
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    const out = d.stderr.output()
    // The one thing the user needs: npm is not on PATH. It is right there in the
    // failure object, so a diagnostics slice must not drop it.
    expect(out).toMatch(/ENOENT/)
  })

  it('names the cause when the npm binary itself could not be executed', async () => {
    const d = failing(spawnFailure('EACCES'))
    await updateCommand(d)
    const out = d.stderr.output()
    // Both streams are empty here, so `shortMessage`/`message` in OUTPUT_SOURCES is
    // the only thing that can carry the cause — and it must, because the hint below
    // fires off `code: 'EACCES'` and names the global prefix, which is the WRONG
    // fix for a binary that is not executable. Printing `spawn npm EACCES` above the
    // hint is what lets the user tell the two apart (#23).
    expect(out).toContain('spawn npm EACCES')
  })
})

// --- #198 QA -----------------------------------------------------------------
// QA augmentation for #198's Homebrew row at the COMMAND level. The dev's four
// new update.test.js cases cover the happy spawn list, "never npm install -g",
// one non-zero exit, and a `.git` checkout under a Cellar path. These attack the
// paths those four do not enter:
//   1. the two version short-circuits on a brew path — `--force` reinstalling
//      when already current, and already-current WITHOUT `--force`, which must
//      never reach brew at all
//   2. `--force` against a refusal: the flag must not buy past a checkout or a
//      link merely because the path now names a store Ralph can upgrade
//   3. the failure shapes a real `brew` produces that npm does not: brew silent
//      on both streams, brew missing from PATH (which `reject: false` makes a
//      RESOLVED failure, not a throw), and the catch branch
//   4. what exit 0 from `brew upgrade` does and does not prove
// Every case goes through the REAL classification against a memfs volume, so it
// is the shipped marker deciding, not a stub.

const BREW_HOME = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'
const BREW_ARGV = ['brew', 'upgrade', 'ralph']
const BREW_KEY = BREW_ARGV.join(' ')
const CELLAR_CHECKOUT = `${USER_HOME}/repos/Cellar/ralph`

// A brew install, classified for real, with `brew upgrade` answering however the
// case needs it to.
const brewDeps = (overrides = {}) =>
  deps({ ralphHome: BREW_HOME, classify: withFs(noVol()), ...overrides })

const brewSaying = (failure, overrides = {}) =>
  brewDeps({ handlers: { [BREW_KEY]: failure }, ...overrides })

describe('updateCommand — the version short-circuits on a Homebrew path (#198 QA)', () => {
  it('reinstalls through brew under --force when already current', async () => {
    const d = brewDeps({ currentVersion: LATEST, force: true })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 0, updated: true, from: LATEST, to: LATEST })
    // The whole spawn list: the version query — the TAP's, since #199 — then ONE
    // `brew upgrade`. --force repairs a broken install, so it re-runs the manager's
    // command, but it must not run it twice, and npm is not involved at all.
    expect(d.exec.calls.map((c) => c.key)).toEqual([BREW_INFO_KEY, BREW_KEY])
    const out = d.stdout.output()
    expect(out).toContain('Reinstalling Ralph 0.16.0 (--force)')
    expect(out).toContain('✅ Reinstalled Ralph 0.16.0.')
    expect(d.stderr.output()).toBe('')
  })

  it('never reaches brew upgrade when already current without --force', async () => {
    // The short-circuit sits between the version query and the argv, so a brew
    // install that is already current must not spawn `brew upgrade` at all — an
    // upgrade of a formula with nothing to do is still a tap refresh and a lock the
    // user did not ask for. Asking the tap for its version (#199) is not that: it
    // is a read, and it is the question being answered.
    const d = brewDeps({ currentVersion: LATEST })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 0, updated: false, from: LATEST, to: LATEST })
    expect(d.exec.calls.map((c) => c.key)).toEqual([BREW_INFO_KEY])
    expect(nonProbeSpawns(d.exec)).toHaveLength(0)
    expect(d.stdout.output()).toContain('already up to date (0.16.0)')
  })

  it('asks for the version exactly once, whatever brew then does', async () => {
    // One version question per run, on every brew outcome — the query is not
    // retried per attempt, and the classification never asks a second time. #199:
    // that question goes to the tap, and npm is never asked at all.
    const cases = [
      ['a clean upgrade', brewDeps()],
      ['a failed upgrade', brewSaying({ exitCode: 1, stderr: 'Error: nope' })],
      ['a forced reinstall', brewDeps({ currentVersion: LATEST, force: true })],
    ]
    for (const [, d] of cases) {
      await updateCommand(d)
      expect(d.exec.calls.filter((c) => c.key === BREW_INFO_KEY)).toHaveLength(1)
      expect(d.exec.calls.filter((c) => c.key === VIEW_KEY)).toHaveLength(0)
      expect(d.exec.calls.filter((c) => c.key === ROOT_KEY)).toHaveLength(0)
    }
  })
})

describe('updateCommand — --force does not buy past a refusal on a Cellar path (#198 QA)', () => {
  // The new row means a Cellar path now HAS a command Ralph could run, so both of
  // these have to keep refusing. A contributor's checkout that happens to live
  // under a directory called `Cellar`: `brew upgrade ralph` there would act on a
  // formula that does not contain the running copy, reporting success for an
  // update that did not happen (or failing on a formula brew never installed). And
  // a Cellar package root that is a symlink: Ralph does not overwrite a link.
  // `--force` included — the flag exists to repair a broken install, not to
  // overrule a refusal.
  const refusals = [
    ['a .git checkout under a Cellar path', CELLAR_CHECKOUT, gitDirVol, 'git pull'],
    ['a symlinked Cellar package root', BREW_HOME, symlinkVol, BREW_KEY],
    ['a symlink with a checkout behind it', BREW_HOME, linkedCheckoutVol, 'git pull'],
  ]

  for (const [label, home, vol, expected] of refusals) {
    for (const force of [false, true]) {
      it(`refuses ${label}${force ? ' even with --force' : ''}`, async () => {
        const d = deps({ ralphHome: home, classify: withFs(vol(home)), force })
        const result = await updateCommand(d)
        expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
        // The registry query is all that ran: no `brew upgrade`, no npm probe.
        expect(d.exec.calls.map((c) => c.key)).toEqual([VIEW_KEY])
        expect(nonProbeSpawns(d.exec)).toHaveLength(0)
        expect(d.stdout.output()).toContain(expected)
        expect(d.stdout.output()).not.toContain('npm install -g')
        expect(d.stderr.output()).toBe('')
      })
    }
  }

  it('names brew in the advice for a linked Cellar root, and only there', async () => {
    // The one thing the row adds to the refusal wording: a linked install inside a
    // Cellar can name the command that would fix it. A linked install under a
    // Cellar belonging to ANOTHER formula cannot, and must not borrow it.
    const linked = deps({ ralphHome: BREW_HOME, classify: withFs(symlinkVol(BREW_HOME)) })
    await updateCommand(linked)
    expect(linked.stdout.output()).toContain(`run \`${BREW_KEY}\` to update it`)

    const other = '/opt/homebrew/Cellar/ripgrep/14.1.1/libexec/lib/node_modules/@lucasfe/ralph'
    const foreign = deps({ ralphHome: other, classify: withFs(symlinkVol(other)) })
    await updateCommand(foreign)
    // The path it prints necessarily contains `homebrew`; what must not appear is
    // the COMMAND, offered for a formula that does not contain this copy.
    expect(foreign.stdout.output()).not.toContain('brew upgrade')
    expect(foreign.stdout.output()).toMatch(/whichever package manager/i)
  })
})

describe('updateCommand — how a failed `brew upgrade` reports (#198 QA)', () => {
  it('says which command to run by hand when brew printed nothing at all', async () => {
    // brew can fail with both streams empty (a lock it could not take, a
    // die-with-no-message). Silence must still produce a runnable next step, and
    // that step is brew's command — not npm's.
    const d = brewSaying({ exitCode: 1, stdout: '', stderr: '' })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 1, updated: false, from: CURRENT, to: LATEST })
    expect(d.stderr.chunks.map((c) => strip(c).slice(0, -1))).toEqual([
      `❌ Update failed: \`${BREW_KEY}\` exited 1.`,
      `   brew printed no output. Run \`${BREW_KEY}\` yourself to see it.`,
    ])
  })

  it('reports brew missing from PATH as a failure that names brew', async () => {
    // `reject: false` makes execa RESOLVE this: exitCode undefined, both streams
    // empty, `spawn brew ENOENT` only in `message`. update.js reads exitCode as
    // `?? 1`, so it lands in the non-zero branch rather than the catch — the
    // headline therefore says "exited 1", and the cause has to come from the
    // message. A brew user without brew on PATH is real: a Cellar copied onto a
    // machine, or a PATH stripped by a launchd job.
    const d = brewSaying({
      exitCode: undefined,
      code: 'ENOENT',
      failed: true,
      stdout: '',
      stderr: '',
      shortMessage: `Command failed with ENOENT: ${BREW_KEY}\nspawn brew ENOENT`,
      message: `Command failed with ENOENT: ${BREW_KEY}\nspawn brew ENOENT`,
    })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    const out = d.stderr.output()
    expect(out).toContain(`\`${BREW_KEY}\` exited 1`)
    expect(out).toContain('spawn brew ENOENT')
    expect(out).toContain('brew printed no output; the error reads:')
  })

  it('reports a brew call that threw through the catch branch', async () => {
    const d = brewSaying(() => {
      throw Object.assign(new Error('long\nmulti\nline'), {
        shortMessage: 'Command failed: brew upgrade ralph',
      })
    })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 1, updated: false, from: CURRENT, to: LATEST })
    const out = d.stderr.output()
    expect(out).toContain(`could not run \`${BREW_KEY}\``)
    // One write per line, still, with a multi-line error in hand.
    for (const chunk of d.stderr.chunks) expect(chunk.slice(0, -1)).not.toContain('\n')
  })

  it('exits the code brew exited, verbatim', async () => {
    for (const exitCode of [1, 2, 127]) {
      const d = brewSaying({ exitCode, stderr: 'Error: No available formula' })
      const result = await updateCommand(d)
      expect(result).toEqual({ exitCode, updated: false, from: CURRENT, to: LATEST })
      expect(d.stderr.output()).toContain(`exited ${exitCode}`)
    }
  })

  it('never prints the npm global command for ANY brew failure', async () => {
    // The whole point of the row: following `npm install -g` on a brew install
    // creates a second copy, and whichever comes first on PATH shadows the other.
    // A failure is exactly when a user is most likely to paste what they are
    // shown, so no failure shape may print it.
    const shapes = [
      { exitCode: 1, stderr: 'Error: ralph not installed' },
      { exitCode: 1, stdout: '', stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
      null,
      { exitCode: undefined, signal: 'SIGKILL', stdout: '', stderr: 'Killed' },
    ]
    for (const shape of shapes) {
      const d = brewSaying(shape)
      await updateCommand(d)
      const out = d.stdout.output() + d.stderr.output()
      expect(out).not.toContain('npm install -g')
      expect(out).not.toContain(INSTALL_KEY)
    }
  })
})

describe('updateCommand — a Homebrew permission failure (#198 QA)', () => {
  it('does not hand a brew user advice Homebrew refuses to run', async () => {
    // Written as a KNOWN FAILING test by QA, and fixed in the same change: the
    // assertions are QA's, the row that satisfies them is the dev's.
    //
    // A Cellar the user does not own is a common real state (an Intel `/usr/local`,
    // or a prefix a past `sudo brew` left root-owned). brew reports it as
    // "Error: Permission denied @ dir_s_mkdir - /usr/local/Cellar/ralph", which
    // matches install-failure.js's `/permission denied/i` signal, so the hint
    // fires with `manager` = 'brew'. Its fix table had a row for npm, pnpm, yarn
    // and bun — every manager Ralph could run before #198 — and none for brew, so
    // the hint fell through to two lines that are both wrong for Homebrew:
    //   "Point it somewhere you own (see brew's global-prefix setting)."
    //     — Homebrew has no such setting; HOMEBREW_PREFIX is fixed per platform.
    //   "Or re-run this install with elevated privileges: `sudo brew upgrade ralph`"
    //     — Homebrew refuses to run as root outright, so this cannot be followed.
    // install-failure.js's own comment set the bar that missed: "Naming the wrong
    // knob is worse than naming none." `PERMISSION_FIX` now carries a brew row
    // whose fix is `brew doctor` — the command that identifies the directories
    // that are not writable and prints the chown for exactly those — and whose
    // `rootAborts` drops the elevated-privileges line entirely.
    const d = brewSaying({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Permission denied @ dir_s_mkdir - /usr/local/Cellar/ralph',
    })
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(1)
    const out = d.stderr.output()
    // What brew said still has to be shown — that part is right today.
    expect(out).toContain('Permission denied @ dir_s_mkdir')
    // What must not be said.
    expect(out).not.toContain('sudo brew')
    expect(out).not.toMatch(/brew's global-prefix setting/)
  })
})

describe('updateCommand — what exit 0 from brew does and does not prove (#198 QA)', () => {
  it('reports a successful update from the exit code alone (characterized)', async () => {
    // Worth writing down, because it is the one place a brew install can differ
    // from an npm one. `npm install -g @lucasfe/ralph@latest` names the version it
    // fetches, so exit 0 means the latest really is installed. `brew upgrade ralph`
    // names a FORMULA instead, and Ralph reads nothing but its exit code — so
    // whatever brew did, exit 0 prints "Updated Ralph 0.15.6 → 0.16.0" and `to`
    // names the version the QUERY reported as available, never the version now on
    // disk. This fixture is one shape of that: brew saying it did nothing
    // ("Warning: ralph 0.15.6 already installed") and exiting 0 anyway. Pinned, not
    // endorsed: closing it needs a second version read after the upgrade, which is
    // a change of its own.
    //
    // #199 narrowed how this is reached, without closing it. The version compared
    // used to come from `npm view`, which the formula is bumped independently of
    // (scripts/generate-homebrew-formula.js renders the formula, and its own header
    // records that the release job to run it does not exist yet — #196), so a
    // formula behind the npm publish produced exactly this phantom update. The
    // version now comes from the tapped formula itself, so that case reports
    // "already up to date" instead — and the same holds for a stale TAP, the case
    // the single-spawn argv cannot cover: `brew upgrade` normally refreshes its taps
    // itself (`upgrade` is in auto-update.sh's AUTO_UPDATE_COMMANDS, on a 24-hour
    // HOMEBREW_AUTO_UPDATE_SECS default, which is why Ralph runs no separate `brew
    // update`), but `auto-update()` returns immediately when HOMEBREW_NO_AUTO_UPDATE
    // is set. A user who exports it now gets a stale answer to BOTH the query and
    // the upgrade, which under-reports an upgrade rather than inventing one.
    // What is left is the gap between the two spawns and any other reason brew can
    // exit 0 without moving the installed version — still invisible to a caller
    // reading only the exit code.
    const d = brewSaying({
      exitCode: 0,
      stdout: 'Warning: ralph 0.15.6 already installed',
      stderr: '',
    })
    const result = await updateCommand(d)
    expect(result).toEqual({ exitCode: 0, updated: true, from: CURRENT, to: LATEST })
    expect(d.stdout.output()).toContain(`✅ Updated Ralph ${CURRENT} → ${LATEST}.`)
    expect(d.stderr.output()).toBe('')
  })
})
