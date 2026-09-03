import { describe, it, expect } from 'vitest'
import { updateCommand } from './update.js'
import { NPM_VERSION_QUERY } from '../update-check.js'

// #199: `ralph update` asks the channel this copy came from what the latest
// version is. That reorders the command — the classification now has to happen
// BEFORE the query, because the classification is what says which query to run —
// and it makes two strings channel-derived, so a Homebrew user is never told the
// npm registry is unreachable or handed an `npm install -g` to run by hand.
//
// The order inside the command is otherwise unchanged, `advice` before `argv`
// included: "never install over a linked checkout" is not a #199 question.

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

const CURRENT = '0.15.6'
const LATEST = '0.16.0'
const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'

const VIEW_KEY = 'npm view @lucasfe/ralph version'
const ROOT_KEY = 'npm root -g'
const INSTALL_KEY = 'npm install -g @lucasfe/ralph@latest'
const BREW_INFO_KEY = 'brew info --json=v2 ralph'
const BREW_UPGRADE_KEY = 'brew upgrade ralph'

// The two fields of `brew info --json=v2` output this command's answer depends on
// (see update-check.channel.test.js for the measured document shape).
const brewInfo = (stable) => ({
  exitCode: 0,
  stdout: JSON.stringify({ formulae: [{ name: 'ralph', versions: { stable } }], casks: [] }),
  stderr: '',
})

// No filesystem is stubbed anywhere in this file, deliberately: `updateCommand`
// injects only `exec` and `ralphHome` into `classifyInstall`, so there is no fs seam
// to reach through it. Every path below is synthetic and absent from this machine,
// which is what makes the linked/checkout probes answer "no" and leaves the path
// markers (or `npm root -g`) to decide — the same arrangement the #198 tests use.
const deps = (overrides = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    currentVersion: CURRENT,
    ralphHome: GLOBAL_RALPH,
    stdout,
    stderr,
    exec: makeExec({
      [VIEW_KEY]: { exitCode: 0, stdout: `${LATEST}\n`, stderr: '' },
      [ROOT_KEY]: { exitCode: 0, stdout: `${GLOBAL_ROOT}\n`, stderr: '' },
      [INSTALL_KEY]: { exitCode: 0, stdout: '', stderr: '' },
    }),
    ...overrides,
  }
}

// A brew install, classified for real: the whole point is that the QUERY follows
// from the classification, so stubbing the classification away would test nothing.
const brewDeps = (handlers = {}, overrides = {}) =>
  deps({
    ralphHome: BREW_RALPH,
    exec: makeExec({
      [BREW_INFO_KEY]: brewInfo(LATEST),
      [BREW_UPGRADE_KEY]: { exitCode: 0, stdout: '', stderr: '' },
      ...handlers,
    }),
    ...overrides,
  })

const keysOf = (d) => d.exec.calls.map((c) => c.key)
const both = (d) => `${d.stdout.output()}${d.stderr.output()}`

describe('updateCommand — classifies before it queries (#199)', () => {
  it('calls classify first, then fetchLatest', async () => {
    // Asserted on call ORDER rather than inferred from the argv, because the argv
    // would still look right if the query ran first with a descriptor from
    // somewhere else.
    const order = []
    const d = deps({
      classify: async () => {
        order.push('classify')
        return { kind: 'global-npm', argv: ['npm', 'install', '-g', 'x'], label: 'npm install -g x', reason: '', advice: null, latest: NPM_VERSION_QUERY }
      },
      fetchLatest: async () => {
        order.push('fetchLatest')
        return LATEST
      },
    })
    await updateCommand(d)
    expect(order).toEqual(['classify', 'fetchLatest'])
  })

  it('hands fetchLatest the injected exec, the timeout, and the classification’s query', async () => {
    let seen = null
    const target = {
      kind: 'global-npm',
      argv: ['npm', 'install', '-g', 'x'],
      label: 'npm install -g x',
      reason: '',
      advice: null,
      latest: NPM_VERSION_QUERY,
    }
    const d = deps({
      timeoutMs: 1234,
      classify: async () => target,
      fetchLatest: async (...args) => {
        seen = args
        return LATEST
      },
    })
    await updateCommand(d)
    expect(seen).toEqual([d.exec, 1234, target.latest])
  })

  it('probes for the layout before spawning the version query, end to end', async () => {
    // The real classify and the real fetchLatestVersion, so the order is visible
    // in the spawns themselves: `npm root -g` is classification, `npm view` is the
    // query, and the install comes last.
    const d = deps()
    const result = await updateCommand(d)
    expect(result.exitCode).toBe(0)
    expect(keysOf(d)).toEqual([ROOT_KEY, VIEW_KEY, INSTALL_KEY])
  })

  it('still checks advice before argv, so a linked checkout is never installed over', async () => {
    // Moving classify ahead of the query must not disturb the gating order inside
    // the command. A classification carrying BOTH is the case that can only be
    // decided by that order — `classifyInstall` never returns one today, which is
    // why this is stubbed rather than driven through a path.
    const d = deps({
      classify: async () => ({
        kind: 'linked',
        argv: ['npm', 'install', '-g', '@lucasfe/ralph@latest'],
        label: INSTALL_KEY,
        reason: 'a dev checkout',
        advice: 'Run `git pull` in that checkout to update it.',
        latest: NPM_VERSION_QUERY,
      }),
    })
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 0, updated: false, to: LATEST })
    expect(d.stdout.output()).toContain('git pull')
    expect(keysOf(d)).toEqual([VIEW_KEY])
  })
})

describe('updateCommand — a Homebrew install asks the tap (#199)', () => {
  it('reports the tap’s version and runs `brew upgrade`, touching npm not at all', async () => {
    const d = brewDeps()
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 0, updated: true, from: CURRENT, to: LATEST })
    expect(keysOf(d)).toEqual([BREW_INFO_KEY, BREW_UPGRADE_KEY])
    expect(d.stdout.output()).toContain(`${CURRENT} → ${LATEST}`)
  })

  it('reports already-up-to-date when the tap holds the installed version', async () => {
    const d = brewDeps({ [BREW_INFO_KEY]: brewInfo(CURRENT) })
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 0, updated: false, to: CURRENT })
    expect(d.stdout.output()).toMatch(/already up to date/i)
    expect(keysOf(d)).not.toContain(BREW_UPGRADE_KEY)
  })

  it('reports already-up-to-date when the tap is stale, rather than upgrading blind', async () => {
    // The accepted tradeoff, stated as a test: `brew info` reads the LOCALLY
    // TAPPED formula and refreshes nothing, so it can lag the tap's HEAD by any
    // amount — however long since the user last ran a brew command that
    // auto-updates (see the argv's comment in lib/install-target.js). What bounds
    // the damage is the direction, not the age: a stale tap can only UNDER-report an
    // upgrade — a late nag — and never promise a version brew cannot install.
    const d = brewDeps({ [BREW_INFO_KEY]: brewInfo('0.15.0') })
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 0, updated: false })
    expect(keysOf(d)).toEqual([BREW_INFO_KEY])
  })

  it('reinstalls with --force even when the tap has nothing newer', async () => {
    const d = brewDeps({ [BREW_INFO_KEY]: brewInfo(CURRENT) }, { force: true })
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 0, updated: true })
    expect(keysOf(d)).toEqual([BREW_INFO_KEY, BREW_UPGRADE_KEY])
  })
})

describe('updateCommand — a failed query names its own channel (#199)', () => {
  it('does not tell a Homebrew user the npm registry is unreachable', async () => {
    // Measured failure shape: `brew info --json=v2 <untapped>` exits 1 with empty
    // stdout.
    const d = brewDeps({ [BREW_INFO_KEY]: { exitCode: 1, stdout: '', stderr: 'Error: No available formula' } })
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 1, updated: false, to: null })
    expect(d.stderr.output()).toMatch(/could not read the latest published version/i)
    expect(both(d)).not.toMatch(/npm/i)
    expect(both(d)).toMatch(/brew|homebrew|tap/i)
  })

  it('points a Homebrew user at `brew upgrade`, not `npm install -g`', async () => {
    const d = brewDeps({ [BREW_INFO_KEY]: { exitCode: 1, stdout: '', stderr: '' } })
    await updateCommand(d)
    expect(d.stdout.output()).toContain(`update by hand: ${BREW_UPGRADE_KEY}`)
    expect(keysOf(d)).not.toContain(BREW_UPGRADE_KEY)
  })

  it('still says npm registry, and still hints npm, for an npm install', async () => {
    // The regression guard for the wording: the npm channel's message is the one
    // #21 shipped, byte for byte.
    const d = deps({ exec: makeExec({ [ROOT_KEY]: { exitCode: 0, stdout: `${GLOBAL_ROOT}\n` }, [VIEW_KEY]: { exitCode: 1, stdout: '', stderr: 'boom' } }) })
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 1, to: null })
    expect(d.stderr.output()).toContain(
      '❌ Could not read the latest published version (npm registry unreachable?).',
    )
    expect(d.stdout.output()).toContain(`   Try again later, or update by hand: ${INSTALL_KEY}`)
  })

  it.each([
    ['pnpm', '/Users/me/Library/pnpm/global/5/node_modules/@lucasfe/ralph', 'pnpm add -g @lucasfe/ralph@latest'],
    ['yarn', '/Users/me/.config/yarn/global/node_modules/@lucasfe/ralph', 'yarn global add @lucasfe/ralph@latest'],
    ['bun', '/Users/me/.bun/install/global/node_modules/@lucasfe/ralph', 'bun add -g @lucasfe/ralph@latest'],
  ])('hints the %s command a user of that store can run by hand', async (_name, ralphHome, label) => {
    // These stores install FROM npm, so the failed query is npm's — but the
    // command to run by hand is still theirs, and `npm install -g` would create a
    // second global install rather than update this one.
    const d = deps({
      ralphHome,
      exec: makeExec({ [VIEW_KEY]: { exitCode: 1, stdout: '', stderr: '' } }),
    })
    await updateCommand(d)
    expect(d.stdout.output()).toContain(`update by hand: ${label}`)
    expect(d.stdout.output()).not.toContain(INSTALL_KEY)
  })

  it('falls back to the npm command for a layout with no command of its own', async () => {
    // An `unknown` layout has no label, so this path's output is unchanged from
    // #21: the npm global install is the command anyone can run.
    const d = deps({
      ralphHome: '/Users/me/somewhere/else',
      exec: makeExec({ [VIEW_KEY]: { exitCode: 1, stdout: '', stderr: '' } }),
    })
    await updateCommand(d)
    expect(d.stdout.output()).toContain(`update by hand: ${INSTALL_KEY}`)
  })

  it('keeps the unknown-layout refusal pointing at the npm command', async () => {
    const d = deps({
      ralphHome: '/Users/me/somewhere/else',
      exec: makeExec({
        [VIEW_KEY]: { exitCode: 0, stdout: `${LATEST}\n` },
        [ROOT_KEY]: { exitCode: 0, stdout: `${GLOBAL_ROOT}\n` },
      }),
    })
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 1, updated: false, to: LATEST })
    expect(d.stdout.output()).toContain(`Update by hand: ${INSTALL_KEY}`)
  })
})

describe('updateCommand — the query follows the descriptor, never the kind (#199)', () => {
  it('runs the query a classification carries even for a kind it has never seen', async () => {
    // The capability-not-kind rule, stated where it can actually fail: a new
    // channel added to lib/install-target.js must work without this file learning
    // its name.
    const d = deps({
      classify: async () => ({
        kind: 'global-frobnicator',
        argv: ['frob', 'upgrade', 'ralph'],
        label: 'frob upgrade ralph',
        reason: 'a frobnicator store',
        advice: null,
        latest: { argv: ['frob', 'latest', 'ralph'], format: 'semver-line', unreachable: 'frobnicator unreachable?' },
      }),
      exec: makeExec({
        'frob latest ralph': { exitCode: 0, stdout: `${LATEST}\n`, stderr: '' },
        'frob upgrade ralph': { exitCode: 0, stdout: '', stderr: '' },
      }),
    })
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 0, updated: true, to: LATEST })
    expect(keysOf(d)).toEqual(['frob latest ralph', 'frob upgrade ralph'])
  })

  it('queries npm for a classification that says global-brew but carries the npm query', async () => {
    // The inverse: the `kind` string does not win. Nothing may key off the name.
    const d = deps({
      classify: async () => ({
        kind: 'global-brew',
        argv: ['brew', 'upgrade', 'ralph'],
        label: BREW_UPGRADE_KEY,
        reason: 'a Homebrew Cellar',
        advice: null,
        latest: NPM_VERSION_QUERY,
      }),
      exec: makeExec({
        [VIEW_KEY]: { exitCode: 0, stdout: `${LATEST}\n`, stderr: '' },
        [BREW_UPGRADE_KEY]: { exitCode: 0, stdout: '', stderr: '' },
      }),
    })
    await updateCommand(d)
    expect(keysOf(d)).toEqual([VIEW_KEY, BREW_UPGRADE_KEY])
  })

  it('queries npm for a classification carrying no query at all', async () => {
    // Anything shaped like a pre-#199 classification — including a stub in a test
    // written before this change — still works, because npm is the default.
    const d = deps({
      classify: async () => ({
        kind: 'global-npm',
        argv: ['npm', 'install', '-g', '@lucasfe/ralph@latest'],
        label: INSTALL_KEY,
        reason: '',
        advice: null,
      }),
    })
    const result = await updateCommand(d)
    expect(result).toMatchObject({ exitCode: 0, updated: true, to: LATEST })
    expect(keysOf(d)).toEqual([VIEW_KEY, INSTALL_KEY])
  })
})
