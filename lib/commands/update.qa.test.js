import { describe, it, expect } from 'vitest'
import { updateCommand } from './update.js'

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
