import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { Volume } from 'memfs'
import { updateCommand, UpdateAbort } from './update.js'
import { classifyInstall } from '../install-target.js'

const BIN = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))

const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`
const CURRENT = '0.15.6'
const LATEST = '0.16.0'
const INSTALL_KEY = 'npm install -g @lucasfe/ralph@latest'

// Colour is on in tests, so `output()` strips ANSI: every assertion below reads
// the text a user would see, not the escape codes around it.
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

// #199: the two fields `fetchLatestVersion` reads out of a `brew info --json=v2`
// document (lib/update-check.channel.test.js records the shape measured against a
// real Homebrew). The brew cases below need it because a Homebrew install asks the
// tap for its latest version, not npm.
const BREW_INFO_KEY = 'brew info --json=v2 ralph'
const brewInfoSaying = (stable) => ({
  exitCode: 0,
  stdout: JSON.stringify({ formulae: [{ name: 'ralph', versions: { stable } }], casks: [] }),
  stderr: '',
})

// npm view -> latest published; npm root -g -> the global node_modules that
// contains this copy of Ralph; npm install -g -> the update itself; brew info ->
// what the tap holds, for a Homebrew install (#199).
const baseHandlers = (overrides = {}) => ({
  'npm view @lucasfe/ralph version': { exitCode: 0, stdout: `${LATEST}\n`, stderr: '' },
  'npm root -g': { exitCode: 0, stdout: `${GLOBAL_ROOT}\n`, stderr: '' },
  [INSTALL_KEY]: { exitCode: 0, stdout: '', stderr: '' },
  [BREW_INFO_KEY]: brewInfoSaying(LATEST),
  ...overrides,
})

const baseDeps = (overrides = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    currentVersion: CURRENT,
    ralphHome: GLOBAL_RALPH,
    stdout,
    stderr,
    exec: makeExec(baseHandlers()),
    ...overrides,
  }
}

const installCalls = (exec) => exec.calls.filter((c) => c.key === INSTALL_KEY)

describe('updateCommand — npm-global happy path (#21)', () => {
  it('runs `npm install -g @lucasfe/ralph@latest` and exits 0 when behind', async () => {
    const deps = baseDeps()
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(true)
    expect(result.from).toBe(CURRENT)
    expect(result.to).toBe(LATEST)
    expect(installCalls(deps.exec)).toHaveLength(1)
    expect(installCalls(deps.exec)[0]).toMatchObject({
      cmd: 'npm',
      args: ['install', '-g', '@lucasfe/ralph@latest'],
    })
  })

  it('names both the version it came from and the version it moved to', async () => {
    const deps = baseDeps()
    await updateCommand(deps)
    const output = deps.stdout.output()
    expect(output).toContain(CURRENT)
    expect(output).toContain(LATEST)
    expect(output).toMatch(/updated/i)
  })

  it('queries the registry before attempting an install', async () => {
    const deps = baseDeps()
    await updateCommand(deps)
    const keys = deps.exec.calls.map((c) => c.key)
    expect(keys.indexOf('npm view @lucasfe/ralph version')).toBeLessThan(
      keys.indexOf(INSTALL_KEY),
    )
  })

  it('never inspects git or a Ralph project — it works from any directory', async () => {
    const deps = baseDeps()
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.exec.calls.every((c) => c.cmd === 'npm')).toBe(true)
  })
})

describe('updateCommand — up-to-date short-circuit and --force (#21)', () => {
  it('prints "already up to date (X)", makes no install call, and exits 0', async () => {
    const deps = baseDeps({
      exec: makeExec(
        baseHandlers({
          'npm view @lucasfe/ralph version': {
            exitCode: 0,
            stdout: `${CURRENT}\n`,
            stderr: '',
          },
        }),
      ),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(false)
    expect(deps.stdout.output()).toMatch(
      new RegExp(`already up to date \\(${CURRENT.replace(/\./g, '\\.')}\\)`, 'i'),
    )
    expect(installCalls(deps.exec)).toHaveLength(0)
  })

  it('short-circuits when the installed version is ahead of the registry', async () => {
    const deps = baseDeps({
      currentVersion: '9.9.9',
      exec: makeExec(baseHandlers()),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(false)
    expect(installCalls(deps.exec)).toHaveLength(0)
  })

  it('--force reinstalls even when already on the latest version', async () => {
    const deps = baseDeps({
      force: true,
      exec: makeExec(
        baseHandlers({
          'npm view @lucasfe/ralph version': {
            exitCode: 0,
            stdout: `${CURRENT}\n`,
            stderr: '',
          },
        }),
      ),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(true)
    expect(installCalls(deps.exec)).toHaveLength(1)
    expect(installCalls(deps.exec)[0].args).toEqual([
      'install',
      '-g',
      '@lucasfe/ralph@latest',
    ])
  })
})

describe('updateCommand — refusals and failures (#21)', () => {
  it('refuses to guess when the layout is not npm-global and prints the manual command', async () => {
    const deps = baseDeps({ ralphHome: '/Users/me/repos/ralph' })
    const result = await updateCommand(deps)
    expect(result.exitCode).not.toBe(0)
    expect(result.updated).toBe(false)
    const output = deps.stdout.output() + deps.stderr.output()
    expect(output).toContain('npm install -g @lucasfe/ralph@latest')
    expect(installCalls(deps.exec)).toHaveLength(0)
  })

  it('reports a failed registry query and makes no install attempt', async () => {
    const deps = baseDeps({
      exec: makeExec(
        baseHandlers({
          'npm view @lucasfe/ralph version': {
            exitCode: 1,
            stdout: '',
            stderr: 'network down',
          },
        }),
      ),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).not.toBe(0)
    expect(result.updated).toBe(false)
    expect(result.to).toBeNull()
    expect(deps.stderr.output()).toMatch(/latest version|registry/i)
    expect(installCalls(deps.exec)).toHaveLength(0)
    // #199 inverted the first two steps: the classification runs BEFORE the query,
    // because it is what names the channel to query — so `npm root -g` is expected
    // here now. What this line has always been for still holds, and is now stated
    // as the whole spawn list: nothing runs AFTER the query that failed.
    expect(deps.exec.calls.map((c) => c.key)).toEqual([
      'npm root -g',
      'npm view @lucasfe/ralph version',
    ])
  })

  it('propagates a non-zero install exit code', async () => {
    const deps = baseDeps({
      exec: makeExec(
        baseHandlers({ [INSTALL_KEY]: { exitCode: 1, stdout: '', stderr: 'EACCES' } }),
      ),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(result.updated).toBe(false)
    expect(deps.stderr.output()).toMatch(/failed/i)
  })

  it('preserves the install command exit code verbatim', async () => {
    const deps = baseDeps({
      exec: makeExec(
        baseHandlers({ [INSTALL_KEY]: { exitCode: 243, stdout: '', stderr: 'boom' } }),
      ),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(243)
  })

  it('reports a non-zero exit when the install command cannot be spawned', async () => {
    const handlers = baseHandlers()
    const exec = async (cmd, args, options) => {
      if (`${cmd} ${args.join(' ')}` === INSTALL_KEY) {
        const e = new Error('spawn npm ENOENT')
        e.code = 'ENOENT'
        throw e
      }
      return makeExec(handlers)(cmd, args, options)
    }
    const deps = baseDeps({ exec })
    const result = await updateCommand(deps)
    expect(result.exitCode).not.toBe(0)
    expect(result.updated).toBe(false)
    expect(deps.stderr.output()).toMatch(/failed/i)
  })
})

describe('updateCommand — deliberate refusals exit 0 (#22)', () => {
  // A classification that recognized the layout and knows there is nothing to
  // install carries `advice`. Nothing failed, so the exit code is 0 — unlike
  // `unknown`, which has no advice and keeps its exit 1.
  const refusal = (kind, advice) => async () => ({
    kind,
    argv: null,
    label: null,
    reason: `${kind} layout`,
    advice,
  })

  it('exits 0 and installs nothing for a linked dev checkout', async () => {
    const deps = baseDeps({
      classify: refusal('linked', 'Run `git pull` in that checkout to update it.'),
    })
    const result = await updateCommand(deps)
    expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
    expect(installCalls(deps.exec)).toHaveLength(0)
    expect(deps.stdout.output()).toContain('git pull')
  })

  it('never suggests `npm install -g` against a linked checkout', async () => {
    const deps = baseDeps({
      classify: refusal('linked', 'Run `git pull` in that checkout to update it.'),
    })
    await updateCommand(deps)
    const output = deps.stdout.output() + deps.stderr.output()
    expect(output).not.toContain('npm install -g')
  })

  it('exits 0 for an npx invocation and says there is nothing to update', async () => {
    const deps = baseDeps({
      classify: refusal('npx', 'npx always fetches the latest published version.'),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(false)
    expect(installCalls(deps.exec)).toHaveLength(0)
    expect(deps.stdout.output()).toMatch(/npx/)
  })

  it('reports a refusal on stdout only — nothing failed', async () => {
    const deps = baseDeps({ classify: refusal('npx', 'npx always fetches the latest.') })
    await updateCommand(deps)
    expect(deps.stderr.output()).toBe('')
    expect(deps.stdout.output()).toContain('npx layout')
  })

  it('exits 0 through the real classification for an npx cache path', async () => {
    const deps = baseDeps({
      ralphHome: '/Users/me/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph',
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.updated).toBe(false)
    expect(installCalls(deps.exec)).toHaveLength(0)
  })

  it('never installs over a linked checkout, whatever store it is linked into', async () => {
    // End-to-end through the real classification: the update command must not
    // spawn anything for a dev checkout, no matter which layout it sits in.
    const checkouts = [
      GLOBAL_RALPH,
      '/Users/me/repos/ralph',
      '/Users/me/Library/pnpm/global/5/node_modules/@lucasfe/ralph',
      '/Users/me/.config/yarn/global/node_modules/@lucasfe/ralph',
      '/Users/me/.bun/install/global/node_modules/@lucasfe/ralph',
    ]
    for (const home of checkouts) {
      const vol = Volume.fromJSON({ [`${home}/.git/HEAD`]: 'ref: refs/heads/main\n' })
      const deps = baseDeps({
        ralphHome: home,
        classify: (opts) => classifyInstall({ ...opts, fs: vol }),
      })
      const result = await updateCommand(deps)
      expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
      expect(deps.exec.calls.filter((c) => c.args.includes('install'))).toHaveLength(0)
      expect(deps.stdout.output()).toContain('git pull')
    }
  })

  it('refuses a classification carrying advice even when it also carries an argv', async () => {
    // Defense in depth: "never install over a linked checkout" must not rest on
    // classifyInstall never setting both fields. Still data, never kind names.
    const deps = baseDeps({
      classify: async () => ({
        kind: 'linked',
        argv: ['npm', 'install', '-g', '@lucasfe/ralph@latest'],
        label: 'npm install -g @lucasfe/ralph@latest',
        reason: 'linked layout',
        advice: 'Run `git pull` in that checkout to update it.',
      }),
    })
    const result = await updateCommand(deps)
    expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
    expect(installCalls(deps.exec)).toHaveLength(0)
  })

  it('still exits 1 for a layout it merely failed to recognize (no advice)', async () => {
    const deps = baseDeps({
      classify: async () => ({
        kind: 'unknown',
        argv: null,
        label: null,
        reason: 'r',
        advice: null,
      }),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(deps.stderr.output()).toMatch(/could not tell how this copy/i)
  })
})

// --- #23 ---------------------------------------------------------------------
// A failed install must SAY what the package manager said — bounded, so a
// pathological npm log cannot flood the terminal — and name the fix for the
// permission failure that is by far the most common real-world cause. Every
// assertion here goes through `updateCommand` with a stubbed failing `exec`:
// nothing is installed, and no real manager is consulted.

// What npm actually prints when the global prefix is root-owned.
const NPM_EACCES = [
  'npm error code EACCES',
  'npm error syscall mkdir',
  'npm error path /usr/local/lib/node_modules/@lucasfe',
  'npm error errno -13',
  "npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@lucasfe'",
].join('\n')

// A failing install, with everything else on the happy path.
const failedInstall = (failure = {}, overrides = {}) =>
  baseDeps({
    exec: makeExec(
      baseHandlers({ [INSTALL_KEY]: { exitCode: 1, stdout: '', stderr: '', ...failure } }),
    ),
    ...overrides,
  })

const errLines = (deps) => deps.stderr.output().split('\n').filter(Boolean)

describe('updateCommand — install-failure diagnostics (#23)', () => {
  it("prints the install command's stderr instead of swallowing it", async () => {
    const deps = failedInstall({ stderr: NPM_EACCES })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(result.updated).toBe(false)
    const out = deps.stderr.output()
    expect(out).toContain('exited 1')
    for (const line of NPM_EACCES.split('\n')) expect(out).toContain(line)
  })

  it('truncates a pathological multi-line log instead of printing all of it', async () => {
    const stderr = Array.from({ length: 400 }, (_, i) => `npm error line ${i + 1}`).join('\n')
    const deps = failedInstall({ stderr })
    await updateCommand(deps)
    const lines = errLines(deps)
    // Bounded: the whole report stays a screenful, whatever npm logged.
    expect(lines.length).toBeLessThanOrEqual(20)
    // The tail is what matters — npm's own error code is at the END of its log.
    expect(lines.some((l) => l.trim() === 'npm error line 400')).toBe(true)
    expect(lines.some((l) => l.trim() === 'npm error line 1')).toBe(false)
    // And the clip is visible, so a truncated tail never reads as complete.
    expect(deps.stderr.output()).toContain('…')
    expect(deps.stderr.output()).toMatch(/omitted/i)
  })

  it('clips one pathological long line rather than printing megabytes of it', async () => {
    const deps = failedInstall({ stderr: `npm error ${'x'.repeat(200_000)}` })
    await updateCommand(deps)
    const out = deps.stderr.output()
    expect(out.length).toBeLessThan(1000)
    expect(out).toContain('npm error xxx')
    expect(out).toContain('…')
  })

  it('adds an actionable hint for a permission failure, beyond the raw error', async () => {
    const deps = failedInstall({ stderr: NPM_EACCES })
    await updateCommand(deps)
    const out = deps.stderr.output()
    expect(out).toMatch(/permission/i)
    // The two real fixes: own the global prefix, or run this once as root.
    expect(out).toContain('npm config set prefix')
    expect(out).toContain(`sudo ${INSTALL_KEY}`)
  })

  const permissionSignals = [
    ['npm code EACCES', 'npm error code EACCES'],
    ['a Windows EPERM', 'npm error code EPERM'],
    ['a bare errno -13', 'npm error errno -13'],
    ['a plain permission denied', 'error: permission denied writing /usr/local/lib'],
    ['an operation not permitted', 'error: operation not permitted'],
  ]

  for (const [label, stderr] of permissionSignals) {
    it(`recognizes ${label} as a permission failure`, async () => {
      const deps = failedInstall({ stderr })
      await updateCommand(deps)
      const out = deps.stderr.output()
      expect(out).toContain('npm config set prefix')
      expect(out).toContain(`sudo ${INSTALL_KEY}`)
    })
  }

  it('names the manager that actually ran, never npm for a pnpm install', async () => {
    const argv = ['pnpm', 'add', '-g', '@lucasfe/ralph@latest']
    const key = argv.join(' ')
    const deps = baseDeps({
      classify: async () => ({
        kind: 'global-pnpm',
        argv,
        label: key,
        reason: 'r',
        advice: null,
      }),
      exec: makeExec(
        baseHandlers({
          [key]: { exitCode: 1, stdout: '', stderr: 'ERR_PNPM_LINKING  permission denied' },
        }),
      ),
    })
    await updateCommand(deps)
    const out = deps.stderr.output()
    expect(out).toContain(`sudo ${key}`)
    expect(out).toMatch(/pnpm/)
    // npm's prefix knob is the wrong advice for a pnpm store.
    expect(out).not.toContain('npm config set')
  })

  it('stays generic for a manager whose global-prefix knob Ralph has no data for', async () => {
    // The stand-in used to be brew; #198 gave brew a row of its own (an ownership
    // fix, and no sudo line, because Homebrew aborts as root), so it can no
    // longer play "a manager Ralph has no data for". MacPorts takes the part, and
    // is a truer fit for these two assertions than brew ever was: nothing in
    // install-failure.js knows `port`, and MacPorts really is driven with sudo.
    // The kind is hypothetical — as `global-brew` was when this test was written
    // — because the hint is keyed on argv[0] and never on the kind.
    const argv = ['port', 'upgrade', 'ralph']
    const key = argv.join(' ')
    const deps = baseDeps({
      classify: async () => ({
        kind: 'global-port',
        argv,
        label: key,
        reason: 'r',
        advice: null,
      }),
      exec: makeExec(baseHandlers({ [key]: { exitCode: 1, stderr: 'Error: EACCES' } })),
    })
    await updateCommand(deps)
    const out = deps.stderr.output()
    expect(out).toContain(`sudo ${key}`)
    expect(out).toMatch(/point it somewhere you own/i)
    // Naming npm's knob for a manager Ralph has no data for is worse than none.
    expect(out).not.toContain('npm config set')
  })

  it('adds no permission hint when the failure is something else', async () => {
    const deps = failedInstall({ stderr: 'npm error code E404\nnpm error 404 Not Found' })
    await updateCommand(deps)
    const out = deps.stderr.output()
    expect(out).toContain('npm error 404 Not Found')
    expect(out).not.toMatch(/sudo|prefix|permission/i)
  })

  it('says the install printed nothing rather than failing in silence', async () => {
    const deps = failedInstall({ stderr: '', stdout: '' })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(1)
    const out = deps.stderr.output()
    expect(out).toContain('exited 1')
    expect(out).toMatch(/printed no|no output/i)
    expect(out).toContain(INSTALL_KEY)
  })

  it('reads the error off stdout when the manager wrote it there', async () => {
    const deps = failedInstall({
      stderr: '',
      stdout: 'ERR_PNPM_ENOTDIR  permission denied, mkdir /usr/local/lib',
    })
    await updateCommand(deps)
    const out = deps.stderr.output()
    expect(out).toContain('ERR_PNPM_ENOTDIR')
    expect(out).toContain(`sudo ${INSTALL_KEY}`)
  })

  it('exits non-zero on a permission failure, with the command exit code verbatim', async () => {
    const deps = failedInstall({ exitCode: 243, stderr: NPM_EACCES })
    const result = await updateCommand(deps)
    expect(result).toEqual({ exitCode: 243, updated: false, from: CURRENT, to: LATEST })
  })

  it('diagnoses a permission failure that stopped the command from running at all', async () => {
    const handlers = baseHandlers()
    const exec = async (cmd, args, options) => {
      if (`${cmd} ${args.join(' ')}` === INSTALL_KEY) {
        const e = new Error('spawn npm EACCES')
        e.code = 'EACCES'
        throw e
      }
      return makeExec(handlers)(cmd, args, options)
    }
    const deps = baseDeps({ exec })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(1)
    const out = deps.stderr.output()
    expect(out).toMatch(/could not run/i)
    expect(out).toContain(`sudo ${INSTALL_KEY}`)
  })

  it('writes the whole report one whole line per write', async () => {
    const deps = failedInstall({ stderr: NPM_EACCES })
    await updateCommand(deps)
    expect(deps.stderr.chunks.length).toBeGreaterThan(1)
    for (const chunk of [...deps.stdout.chunks, ...deps.stderr.chunks]) {
      expect(chunk.endsWith('\n')).toBe(true)
      expect(chunk.slice(0, -1)).not.toContain('\n')
    }
  })

  it('prints no failure diagnostics when the update succeeds', async () => {
    const deps = baseDeps()
    const result = await updateCommand(deps)
    expect(result.updated).toBe(true)
    expect(deps.stderr.output()).toBe('')
    expect(deps.stdout.output()).not.toMatch(/sudo|permission|omitted|wrote:/i)
  })

  it('treats a #22 refusal as no failure at all — exit 0, no diagnostics', async () => {
    const advices = [
      'npx always fetches the latest published version, so there is nothing to update.',
      'Run `git pull` in that checkout to update it.',
    ]
    for (const advice of advices) {
      const deps = baseDeps({
        classify: async () => ({
          kind: 'npx',
          argv: null,
          label: null,
          reason: 'r',
          advice,
        }),
      })
      const result = await updateCommand(deps)
      expect(result.exitCode).toBe(0)
      expect(deps.stderr.output()).toBe('')
      expect(deps.stdout.output()).not.toMatch(/sudo|permission|omitted|wrote:/i)
    }
  })

  it('prints no install diagnostics for an unrecognized layout — nothing ran', async () => {
    // #22's shipped behavior: no advice means it is still a failure (exit 1), but
    // it is not an INSTALL failure — there is no manager output to report.
    const deps = baseDeps({
      classify: async () => ({
        kind: 'unknown',
        argv: null,
        label: null,
        reason: 'r',
        advice: null,
      }),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(1)
    const both = deps.stdout.output() + deps.stderr.output()
    expect(both).not.toMatch(/sudo|permission|omitted|wrote:/i)
  })
})

// --- #198 --------------------------------------------------------------------
// A Homebrew install. The formula npm-installs under `libexec` (brew's own
// `std_npm_args`), so the package root is a plain directory at
// `<prefix>/Cellar/ralph/<version>/libexec/lib/node_modules/@lucasfe/ralph`.
// That layout used to classify `unknown`, so `ralph update` exited 1 and printed
// `npm install -g @lucasfe/ralph@latest` — advice that installs a SECOND copy,
// after which whichever of the two comes first on PATH shadows the other. These
// go through the REAL classification, so what is pinned is the command a brew
// install actually spawns, not a stub's idea of it.

const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'
const BREW_ARGV = ['brew', 'upgrade', 'ralph']
const BREW_KEY = BREW_ARGV.join(' ')

// The real classification against a stub fs: no directory on this machine can
// decide the answer, and nothing on it is probed.
const brewDeps = (overrides = {}) =>
  baseDeps({
    ralphHome: BREW_RALPH,
    classify: (opts) => classifyInstall({ ...opts, fs: Volume.fromJSON({}) }),
    exec: makeExec(baseHandlers({ [BREW_KEY]: { exitCode: 0, stdout: '', stderr: '' } })),
    ...overrides,
  })

describe('updateCommand — Homebrew install (#198)', () => {
  it('spawns `brew upgrade ralph` and nothing else', async () => {
    const deps = brewDeps()
    const result = await updateCommand(deps)
    expect(result).toEqual({ exitCode: 0, updated: true, from: CURRENT, to: LATEST })
    // The whole spawn list, on exact argv rather than a substring: the version
    // query, then one `brew upgrade`. No npm AT ALL — #199 made the query follow
    // the channel, so a brew install asks the tap and never `npm view` or `npm
    // root -g` (the marker decides the layout above it) — and no separate `brew
    // update`, because brew refreshes its taps on its own auto-update cadence.
    expect(deps.exec.calls.map((c) => ({ cmd: c.cmd, args: c.args }))).toEqual([
      { cmd: 'brew', args: ['info', '--json=v2', 'ralph'] },
      { cmd: 'brew', args: ['upgrade', 'ralph'] },
    ])
  })

  it('never suggests `npm install -g`, which would install a second copy', async () => {
    const deps = brewDeps()
    await updateCommand(deps)
    const output = deps.stdout.output() + deps.stderr.output()
    expect(output).not.toContain('npm install -g')
    expect(output).toMatch(/updated/i)
    expect(deps.stderr.output()).toBe('')
  })

  it('answers a permission failure with `brew doctor`, and offers no `sudo brew`', async () => {
    // A Cellar the user does not own is a common real state: an Intel
    // `/usr/local` prefix, or any prefix a past `sudo brew` left root-owned.
    // Both of the generic permission-hint lines are unrunnable for Homebrew —
    // there is no prefix setting to point somewhere else, and `brew` aborts as
    // root — so a brew user is sent to the command that identifies the
    // directories and prints the chown for them, rather than to a chown of the
    // whole prefix, which brew's own docs rule out and which could not reach a
    // root-owned cache anyway (it lives outside the prefix on macOS).
    const deps = brewDeps({
      exec: makeExec(
        baseHandlers({
          [BREW_KEY]: {
            exitCode: 1,
            stdout: '',
            stderr: 'Error: Permission denied @ dir_s_mkdir - /usr/local/Cellar/ralph',
          },
        }),
      ),
    })
    const result = await updateCommand(deps)
    expect(result.exitCode).toBe(1)
    const out = deps.stderr.output()
    // The hint still fires — what changes is only what it says to do.
    expect(out).toContain('That is a permission error')
    expect(out).toContain('`brew doctor`')
    expect(out).not.toContain('chown')
    expect(out).not.toContain('sudo brew')
    expect(out).not.toContain('elevated privileges')
    expect(out).not.toMatch(/global-prefix setting/)
    // And brew's own words are still reported above the hint.
    expect(out).toContain('Permission denied @ dir_s_mkdir')
  })

  it('reports the failure against brew when the upgrade exits non-zero', async () => {
    const deps = brewDeps({
      exec: makeExec(
        baseHandlers({
          [BREW_KEY]: { exitCode: 1, stdout: '', stderr: 'Error: ralph not installed' },
        }),
      ),
    })
    const result = await updateCommand(deps)
    expect(result).toEqual({ exitCode: 1, updated: false, from: CURRENT, to: LATEST })
    const out = deps.stderr.output()
    expect(out).toContain(BREW_KEY)
    expect(out).toContain('Error: ralph not installed')
  })

  it('never `brew upgrade`s a checkout that happens to sit under a `Cellar` path', async () => {
    // `~/repos/Cellar/ralph` carries the marker pair by coincidence. The .git
    // refusal is decided from the package root alone, before any marker, so
    // nothing is spawned past the registry query.
    const home = '/Users/me/repos/Cellar/ralph'
    const deps = baseDeps({
      ralphHome: home,
      classify: (opts) =>
        classifyInstall({
          ...opts,
          fs: Volume.fromJSON({ [`${home}/.git/HEAD`]: 'ref: refs/heads/main\n' }),
        }),
    })
    const result = await updateCommand(deps)
    expect(result).toEqual({ exitCode: 0, updated: false, from: CURRENT, to: LATEST })
    expect(deps.exec.calls.map((c) => c.key)).toEqual(['npm view @lucasfe/ralph version'])
    expect(deps.stdout.output()).toContain('git pull')
  })
})

describe('UpdateAbort', () => {
  it('is an Error carrying an exit code, defaulting to 1', () => {
    const abort = new UpdateAbort('nope')
    expect(abort).toBeInstanceOf(Error)
    expect(abort.message).toBe('nope')
    expect(abort.exitCode).toBe(1)
    expect(new UpdateAbort('nope', 7).exitCode).toBe(7)
  })
})

describe('ralph update — CLI registration (#21)', () => {
  it('appears in `ralph --help`', async () => {
    const result = await execa('node', [BIN, '--help'], { reject: false })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^\s*update\b/m)
  })

  it('accepts --force', async () => {
    const result = await execa('node', [BIN, 'update', '--help'], { reject: false })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/--force/)
  })

  it('does not register an `upgrade` alias', async () => {
    const result = await execa('node', [BIN, 'upgrade'], { reject: false })
    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/unknown command/i)
  })
})
