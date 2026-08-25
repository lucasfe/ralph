import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { globalConfigPath, createCredentialResolver } from '../lib/utils/global-config.js'
import { versionCachePath, writeVersionCache } from '../lib/version-cache.js'
import { credentialResolverKeys, ralphEnvSurface, TOOLCHAIN_NAMES } from './helpers/env-surface.js'

// #41 QA augmentation of test/setup/hermetic-env.js.
//
// The dev's test/hermetic-env.test.js asserts the happy path of the contract:
// HOME is under tmpdir, os.homedir() agrees, four named vars plus RALPH_* are
// gone, default-argument paths land in the sandbox, a child spawned with
// `...process.env` inherits it, and one opt-in/revert pair. These tests attack
// the parts that leaves implicit:
//
//   1. THE DENYLIST GAP. `AMBIENT_NAMES` in the setup file is hand-maintained,
//      and the dev's spec re-types four of its entries — so the two only ever
//      agree with each other. Here the name set is RECOMPUTED from the sources
//      (see test/helpers/env-surface.js), which is the only form of the
//      assertion that can catch the #35 failure mode: a name nobody remembered.
//   2. SNAPSHOT/RESTORE at the boundaries the doc actually promises — a delete,
//      an overwrite, a brand-new var, a set-but-EMPTY var (absent and "" are
//      different states and the restore loop compares with `!==`), and hooks
//      the test file declares itself, including nested describes.
//   3. THE SANDBOX AS A REAL DIRECTORY: writable, still there later in the file,
//      and provably not the developer's real home — checked against
//      os.userInfo().homedir, which reads the passwd entry and so is immune to
//      the $HOME override the mechanism relies on.
//   4. CHILD PROCESSES, the way the bash-loop tests actually spawn them.
//   5. EXPLICIT OPT-IN in both supported directions (injection and mutation).
//
// Ordered PAIRS appear throughout: the first test dirties something, the second
// proves the harness cleaned up. They must stay adjacent and in order.

const SURFACE = ralphEnvSurface()
const SURFACE_NAMES = SURFACE.map((entry) => entry.name)

// ---------------------------------------------------------------------------
// 1. Denylist coverage — derived from the sources, not from the dev's list.
// ---------------------------------------------------------------------------
describe('QA #41 denylist coverage — every name ralph reads from the ambient env is neutralized', () => {
  it('finds a non-trivial ambient surface to check (guards against a scanner that silently matches nothing)', () => {
    // A scanner that returns [] would make every assertion below vacuous.
    expect(SURFACE_NAMES.length).toBeGreaterThan(20)
    expect(SURFACE_NAMES).toContain('XDG_CONFIG_HOME')
    expect(SURFACE_NAMES).toContain('TASK_SOURCE')
    expect(SURFACE_NAMES).toContain('CALLMEBOT_KEY')
    // ...and it must not have swept up the toolchain names the suite needs.
    for (const keep of TOOLCHAIN_NAMES) expect(SURFACE_NAMES).not.toContain(keep)
  })

  it('leaves no scanned ralph-domain name behind in process.env', () => {
    // Vacuous on a clean shell BY DESIGN: this same assertion is re-run under a
    // shell where every one of these names is exported, by
    // test/hermetic-env.idempotence.qa.test.js. A name the mechanism forgot
    // fails there.
    const leaked = SURFACE.filter(({ name }) => name in process.env).map(
      ({ name, sources }) => `${name} (read by ${sources.join(', ')})`,
    )
    expect(
      leaked,
      'these names are read from the ambient environment by ralph and were NOT neutralized by test/setup/hermetic-env.js',
    ).toEqual([])
  })

  it('resolves every createCredentialResolver key to undefined with NO injection at all', () => {
    // The exact production shape: cycle/start/schedule build the resolver with
    // `processEnv` and `home` defaulted to the ambient values. An ambient
    // credential therefore reaches real code with no test opting in.
    const keys = credentialResolverKeys()
    expect(keys.length).toBeGreaterThan(3)
    const resolve = createCredentialResolver({ repoEnv: {}, loadEnv: () => ({}) })
    const resolved = keys.filter((key) => resolve(key) !== undefined)
    expect(
      resolved,
      'an ambient value for these keys reaches createCredentialResolver — resolveCred() in lib/commands/* would use it',
    ).toEqual([])
  })

  it('leaks no scanned ralph-domain name into a child spawned with { ...process.env }', () => {
    const out = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { env: { ...process.env }, encoding: 'utf8' },
    )
    const childEnv = JSON.parse(out)
    expect(SURFACE_NAMES.filter((name) => name in childEnv)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Snapshot / restore.
// ---------------------------------------------------------------------------
describe('QA #41 snapshot/restore — a brand-new variable', () => {
  it('lets a test add a variable that did not exist', () => {
    process.env.QA_BRAND_NEW = 'x'
    process.env.RALPH_BRAND_NEW = 'y'
    expect(process.env.QA_BRAND_NEW).toBe('x')
  })

  it('removes it entirely before the next test — absent, not empty', () => {
    // `in` rather than `=== undefined`: a var restored as '' would satisfy a
    // loose check while still being SET, which is a different state for
    // `${VAR:-default}` in bash and for `??` in JS.
    expect('QA_BRAND_NEW' in process.env).toBe(false)
    expect('RALPH_BRAND_NEW' in process.env).toBe(false)
  })
})

describe('QA #41 snapshot/restore — set-but-empty is not the same as absent', () => {
  it('lets a test set a previously-absent variable to the EMPTY STRING', () => {
    process.env.QA_EMPTY_ADDED = ''
    expect('QA_EMPTY_ADDED' in process.env).toBe(true)
    expect(process.env.QA_EMPTY_ADDED).toBe('')
  })

  it('removes the set-but-empty variable rather than leaving it set to ""', () => {
    expect('QA_EMPTY_ADDED' in process.env).toBe(false)
  })
})

describe('QA #41 snapshot/restore — a variable whose baseline value IS the empty string', () => {
  // beforeAll runs before the setup file's per-test beforeEach snapshot, so this
  // var is part of the baseline every test in this describe is restored to. That
  // is the only way to get a set-but-empty var INTO the snapshot, which is the
  // case the `process.env[name] !== value` restore comparison has to get right.
  beforeAll(() => {
    process.env.QA_BASELINE_EMPTY = ''
  })

  it('sees the empty-valued baseline variable as SET', () => {
    expect('QA_BASELINE_EMPTY' in process.env).toBe(true)
    expect(process.env.QA_BASELINE_EMPTY).toBe('')
  })

  it('lets a test delete it', () => {
    delete process.env.QA_BASELINE_EMPTY
    expect('QA_BASELINE_EMPTY' in process.env).toBe(false)
  })

  it('restores it as SET-AND-EMPTY, not as absent and not as some other value', () => {
    expect('QA_BASELINE_EMPTY' in process.env).toBe(true)
    expect(process.env.QA_BASELINE_EMPTY).toBe('')
  })

  it('lets a test overwrite the empty baseline with a real value', () => {
    process.env.QA_BASELINE_EMPTY = 'now-real'
    expect(process.env.QA_BASELINE_EMPTY).toBe('now-real')
  })

  it('restores the empty baseline over that real value', () => {
    expect(process.env.QA_BASELINE_EMPTY).toBe('')
  })
})

describe('QA #41 snapshot/restore — HOME is deleted outright', () => {
  it('lets a test delete HOME', () => {
    delete process.env.HOME
    expect('HOME' in process.env).toBe(false)
  })

  it('restores HOME to the sandbox, and os.homedir() follows it back', () => {
    expect(process.env.HOME.startsWith(tmpdir())).toBe(true)
    expect(homedir()).toBe(process.env.HOME)
    expect(globalConfigPath()).toBe(join(process.env.HOME, '.config', 'ralph', '.env'))
  })
})

describe('QA #41 snapshot/restore — HOME is overwritten with a foreign path', () => {
  it('lets a test point HOME somewhere else entirely', () => {
    process.env.HOME = '/qa-foreign-home'
    expect(globalConfigPath()).toBe(join('/qa-foreign-home', '.config', 'ralph', '.env'))
  })

  it('restores the sandboxed HOME (and USERPROFILE stays in agreement)', () => {
    expect(process.env.HOME.startsWith(tmpdir())).toBe(true)
    expect(existsSync(process.env.HOME)).toBe(true)
    expect(process.env.USERPROFILE).toBe(process.env.HOME)
  })
})

describe('QA #41 snapshot/restore — a toolchain variable the harness itself needs', () => {
  let originalPath

  it('lets a test clobber PATH', () => {
    originalPath = process.env.PATH
    process.env.PATH = '/qa-empty-path'
    expect(process.env.PATH).toBe('/qa-empty-path')
  })

  it('restores PATH so the next spawning test is not broken by the previous one', () => {
    expect(process.env.PATH).toBe(originalPath)
    // Proof it is a working PATH, not just the right string.
    expect(spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout.trim()).toBe('ok')
  })
})

describe('QA #41 snapshot/restore — hooks the test file declares itself', () => {
  describe('nested describe with its own beforeAll and beforeEach', () => {
    beforeAll(() => {
      process.env.QA_NESTED_BEFORE_ALL = 'from-beforeAll'
    })

    // Registered AFTER the setup file's root-level beforeEach, so it runs after
    // the snapshot is taken — its mutations must therefore be reverted per test.
    beforeEach(() => {
      process.env.QA_NESTED_BEFORE_EACH = 'from-beforeEach'
      delete process.env.HOME
    })

    it('sees both the beforeAll value and the beforeEach value', () => {
      expect(process.env.QA_NESTED_BEFORE_ALL).toBe('from-beforeAll')
      expect(process.env.QA_NESTED_BEFORE_EACH).toBe('from-beforeEach')
      // The nested beforeEach also deleted HOME; the setup must put it back
      // afterwards, which the sibling tests below assert from outside.
      expect('HOME' in process.env).toBe(false)
    })

    it('gets the beforeEach mutations re-applied cleanly on the second test too', () => {
      expect(process.env.QA_NESTED_BEFORE_EACH).toBe('from-beforeEach')
      expect('HOME' in process.env).toBe(false)
    })
  })

  it('has HOME back in the sandbox after a nested describe whose beforeEach deleted it', () => {
    expect(process.env.HOME, 'HOME was never restored after the nested hooks').toBeTruthy()
    expect(process.env.HOME.startsWith(tmpdir())).toBe(true)
    expect(homedir()).toBe(process.env.HOME)
    expect(existsSync(process.env.HOME)).toBe(true)
  })

  it('has dropped the value the nested beforeEach set', () => {
    expect('QA_NESTED_BEFORE_EACH' in process.env).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. The sandbox itself.
// ---------------------------------------------------------------------------
describe('QA #41 the sandbox is a real, writable, private directory', () => {
  it('is a directory, not a stale file or a dangling path', () => {
    expect(statSync(process.env.HOME).isDirectory()).toBe(true)
  })

  it('is writable the way a bash child needs it to be (mkdir -p "$HOME/.config")', () => {
    const dir = join(process.env.HOME, '.config', 'ralph')
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, 'qa-writable-probe')
    writeFileSync(probe, 'ok')
    expect(readFileSync(probe, 'utf8')).toBe('ok')
    rmSync(probe, { force: true })
  })

  it('is NOT the real home — checked against the passwd entry, which $HOME cannot fake', () => {
    // os.userInfo().homedir reads the OS user database, so it still reports the
    // developer's real home even with HOME repointed. If a default-argument path
    // resolved under it, the suite would be writing to the real ~/.config/ralph.
    const realHome = userInfo().homedir
    expect(process.env.HOME).not.toBe(realHome)
    for (const p of [globalConfigPath(), versionCachePath()]) {
      expect(p.startsWith(realHome + '/'), `${p} resolves under the real home ${realHome}`).toBe(
        false,
      )
      expect(p.startsWith(process.env.HOME + '/')).toBe(true)
    }
  })

  it('catches a REAL uninjected write: writeVersionCache() with the default fs lands in the sandbox', () => {
    // version-cache.js defaults `fs` to the real node:fs AND `home` to
    // homedir(), so this call genuinely writes to disk. Assert the destination
    // BEFORE writing so a broken sandbox never causes this test to pollute the
    // developer's real ~/.config/ralph.
    const target = versionCachePath()
    expect(target.startsWith(process.env.HOME + '/')).toBe(true)
    const written = writeVersionCache({ cache: { latest_version: '9.9.9' } })
    expect(written).toBe(target)
    expect(JSON.parse(readFileSync(target, 'utf8')).latest_version).toBe('9.9.9')
    rmSync(target, { force: true })
  })
})

describe('QA #41 the sandbox survives across tests in one file', () => {
  const marker = () => join(process.env.HOME, 'qa-sandbox-marker')

  it('writes a file into $HOME', () => {
    writeFileSync(marker(), 'still-here')
    expect(existsSync(marker())).toBe(true)
  })

  it('still sees that file in a later test (the sandbox is not recreated per test)', () => {
    expect(
      existsSync(marker()),
      'the sandbox was wiped between two tests of the same file — a concurrent worker sharing this pid rmSync-ed it',
    ).toBe(true)
    expect(readFileSync(marker(), 'utf8')).toBe('still-here')
    rmSync(marker(), { force: true })
  })
})

// ---------------------------------------------------------------------------
// 4. Child processes — the way the bash-loop tests actually spawn them.
// ---------------------------------------------------------------------------
describe('QA #41 child-process propagation', () => {
  it("makes a node child's OWN os.homedir() the sandbox, not the real home", () => {
    // Stronger than comparing env vars: it proves the HOME override reaches the
    // child's libuv, which is what every `home = homedir()` default depends on.
    const out = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(require("os").homedir())'],
      { env: { ...process.env }, encoding: 'utf8' },
    )
    expect(out).toBe(process.env.HOME)
    expect(out).not.toBe(userInfo().homedir)
  })

  it('resolves the bash global-config path — ${XDG_CONFIG_HOME:-$HOME/.config} — inside the sandbox', () => {
    // This is literally the expression templates/ralph.sh line 45 evaluates.
    const res = spawnSync('bash', ['-c', 'echo "${XDG_CONFIG_HOME:-$HOME/.config}/ralph/.env"'], {
      env: { ...process.env },
      encoding: 'utf8',
    })
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe(join(process.env.HOME, '.config', 'ralph', '.env'))
  })

  it('lets no credential reach a child, even one built the runLoopNoCreds way', () => {
    // runLoopNoCreds() in test/loop.test.js spreads process.env and deletes only
    // CALLMEBOT_KEY / WHATSAPP_PHONE. Everything else it inherits verbatim —
    // including XDG_CONFIG_HOME, which is exactly how #35 shipped red.
    const env = { ...process.env, PATH: `/qa-stub-bin:${process.env.PATH}` }
    delete env.CALLMEBOT_KEY
    delete env.WHATSAPP_PHONE
    const out = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { env, encoding: 'utf8' },
    )
    const childEnv = JSON.parse(out)
    for (const key of credentialResolverKeys()) {
      expect(key in childEnv, `${key} reached a spawned child`).toBe(false)
    }
    expect('XDG_CONFIG_HOME' in childEnv).toBe(false)
    expect(childEnv.HOME).toBe(process.env.HOME)
  })

  it('propagates an in-test opt-in to a child spawned in the SAME test', () => {
    process.env.XDG_CONFIG_HOME = '/qa-opt-in-xdg'
    const res = spawnSync('bash', ['-c', 'echo "${XDG_CONFIG_HOME:-unset}"'], {
      env: { ...process.env },
      encoding: 'utf8',
    })
    expect(res.stdout.trim()).toBe('/qa-opt-in-xdg')
  })

  it('does not propagate that opt-in to a child spawned in the NEXT test', () => {
    const res = spawnSync('bash', ['-c', 'echo "${XDG_CONFIG_HOME:-unset}"'], {
      env: { ...process.env },
      encoding: 'utf8',
    })
    expect(res.stdout.trim()).toBe('unset')
  })
})

// ---------------------------------------------------------------------------
// 5. Explicit opt-in, both supported directions.
// ---------------------------------------------------------------------------
describe('QA #41 explicit opt-in — injection', () => {
  it('is completely unaffected by the sandbox when both processEnv and home are injected', () => {
    expect(globalConfigPath({ processEnv: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/me' })).toBe(
      join('/xdg', 'ralph', '.env'),
    )
    expect(globalConfigPath({ processEnv: {}, home: '/home/me' })).toBe(
      join('/home/me', '.config', 'ralph', '.env'),
    )
  })

  it('honors an injected empty bag over the ambient environment (no silent fallthrough to process.env)', () => {
    process.env.XDG_CONFIG_HOME = '/should-be-ignored'
    expect(globalConfigPath({ processEnv: {}, home: '/home/me' })).toBe(
      join('/home/me', '.config', 'ralph', '.env'),
    )
    // Injection also beats a mutation made in the same test.
    expect(globalConfigPath({ processEnv: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/me' })).toBe(
      join('/xdg', 'ralph', '.env'),
    )
  })

  it('honors an injected credential bag while the ambient one stays empty', () => {
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: { CALLMEBOT_KEY: 'injected' },
      home: '/home/me',
      loadEnv: () => ({}),
    })
    expect(resolve('CALLMEBOT_KEY')).toBe('injected')
    // The ambient resolver, in the same test, still sees nothing.
    expect(
      createCredentialResolver({ repoEnv: {}, loadEnv: () => ({}) })('CALLMEBOT_KEY'),
    ).toBeUndefined()
  })
})

describe('QA #41 explicit opt-in — in-test process.env mutation', () => {
  it('reaches default-argument resolution inside lib/', () => {
    process.env.XDG_CONFIG_HOME = '/qa-mutated-xdg'
    expect(globalConfigPath()).toBe(join('/qa-mutated-xdg', 'ralph', '.env'))
    expect(versionCachePath()).toBe(join('/qa-mutated-xdg', 'ralph', 'update-check.json'))
    process.env.CALLMEBOT_KEY = 'mutated'
    expect(
      createCredentialResolver({ repoEnv: {}, loadEnv: () => ({}) })('CALLMEBOT_KEY'),
    ).toBe('mutated')
  })

  it('is gone in the next test — both the var and its effect on resolution', () => {
    expect('XDG_CONFIG_HOME' in process.env).toBe(false)
    expect('CALLMEBOT_KEY' in process.env).toBe(false)
    expect(globalConfigPath()).toBe(join(process.env.HOME, '.config', 'ralph', '.env'))
  })
})

// ---------------------------------------------------------------------------
// 6. os.homedir() / USERPROFILE.
// ---------------------------------------------------------------------------
describe('QA #41 os.homedir() and the win32 USERPROFILE branch', () => {
  it('keeps HOME, USERPROFILE and os.homedir() in three-way agreement', () => {
    expect(process.env.USERPROFILE).toBe(process.env.HOME)
    expect(homedir()).toBe(process.env.HOME)
  })

  it('sandboxes USERPROFILE under the OS temp dir too, so the win32 branch is hermetic as well', () => {
    expect(process.env.USERPROFILE.startsWith(tmpdir())).toBe(true)
    expect(existsSync(process.env.USERPROFILE)).toBe(true)
  })
})
