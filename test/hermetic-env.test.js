import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globalConfigPath } from '../lib/utils/global-config.js'
import { versionCachePath } from '../lib/version-cache.js'
import vitestConfig from '../vitest.config.js'

// #41 — hermeticity as an ASSERTED property, not a convention nobody enforces.
//
// ~20 modules under lib/ default a parameter to the ambient `process.env`
// (build-prompt, version-cache, update-check, utils/global-config, …), so any
// test that exercises one of those paths without injecting an explicit env bag
// silently reads the machine it runs on: green on a laptop, red on CI. That
// already shipped a red `main` once (#35).
//
// The contract these tests pin down:
//   1. the ralph-domain variables from the invoking shell are gone;
//   2. HOME resolves to a suite-owned sandbox, so a default-argument write can
//      never land in the developer's real ~/.config/ralph;
//   3. child processes spawned with `...process.env` (the bash-loop tests under
//      test/ do exactly that) inherit the same sandbox;
//   4. a test can still opt INTO a specific value explicitly, and that opt-in is
//      reverted before the next test;
//   5. the mechanism is wired once in vitest.config.js, so a NEW test file
//      inherits all of the above without opting in.
//
// The variable list below is deliberately spelled out here rather than imported
// from the setup file: it is this suite's statement of the contract, and it must
// stay readable as a spec even if the implementation grows a wider denylist.
// HEALTHCHECK_URL earns its place: it is prefixless and reached production code
// through `resolveCred()` rather than a `processEnv.X` reference, which is how the
// first version of the setup file missed it.
const LEAK_PRONE_NAMES = [
  'XDG_CONFIG_HOME',
  'TASK_SOURCE',
  'TASKS_ROOT',
  'PROJECT_ROOT',
  'HEALTHCHECK_URL',
]

function ralphDomainLeaks(env) {
  return Object.keys(env)
    .filter((k) => k.startsWith('RALPH_') || LEAK_PRONE_NAMES.includes(k))
    .sort()
}

describe('#41 the ambient environment is neutralized for every test file', () => {
  it('resolves HOME to a suite-owned sandbox under the OS temp dir', () => {
    expect(process.env.HOME).toBeTruthy()
    expect(
      process.env.HOME.startsWith(tmpdir()),
      `HOME is ${process.env.HOME}, which is not under ${tmpdir()} — tests can reach the real home`,
    ).toBe(true)
    // The sandbox must actually exist: bash-loop children do `mkdir -p "$HOME/..."`
    // and JS callers stat it.
    expect(existsSync(process.env.HOME)).toBe(true)
  })

  it('makes os.homedir() agree with the sandboxed HOME', () => {
    // Every lib/ module that defaults `home = homedir()` resolves through this.
    expect(homedir()).toBe(process.env.HOME)
  })

  it('exposes no RALPH_* / XDG_CONFIG_HOME / TASK_SOURCE from the invoking shell', () => {
    expect(ralphDomainLeaks(process.env)).toEqual([])
  })

  it('keeps default-argument path resolution inside the sandbox, never the real ~/.config/ralph', () => {
    // Called with no arguments on purpose: this is the #35 failure mode, where a
    // write honored an ambient XDG_CONFIG_HOME that the matching read did not.
    expect(globalConfigPath()).toBe(join(process.env.HOME, '.config', 'ralph', '.env'))
    expect(versionCachePath()).toBe(
      join(process.env.HOME, '.config', 'ralph', 'update-check.json'),
    )
  })

  it('propagates the sandbox to child processes spawned with ...process.env', () => {
    // The bash-loop tests build their child env as `{ ...process.env, PATH: … }`,
    // so neutralizing the worker env is what makes templates/ralph.sh hermetic.
    const out = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { env: { ...process.env }, encoding: 'utf8' },
    )
    const childEnv = JSON.parse(out)
    expect(ralphDomainLeaks(childEnv)).toEqual([])
    expect(childEnv.HOME).toBe(process.env.HOME)
  })
})

describe('#41 an explicit opt-in still works and is reverted before the next test', () => {
  // These two tests are ordered on purpose: the first one dirties the env, the
  // second one proves the harness cleaned up after it.
  it('honors a value a test sets explicitly', () => {
    process.env.XDG_CONFIG_HOME = '/opt-in-xdg'
    process.env.RALPH_AGENT = 'codex'
    process.env.HOME = '/opt-in-home'

    expect(globalConfigPath()).toBe(join('/opt-in-xdg', 'ralph', '.env'))
    expect(process.env.RALPH_AGENT).toBe('codex')
  })

  it('reverts every mutation the previous test made', () => {
    expect(process.env.XDG_CONFIG_HOME).toBeUndefined()
    expect(process.env.RALPH_AGENT).toBeUndefined()
    expect(process.env.HOME.startsWith(tmpdir())).toBe(true)
    expect(globalConfigPath()).toBe(join(process.env.HOME, '.config', 'ralph', '.env'))
  })
})

describe('#41 the mechanism is wired once, in vitest.config.js', () => {
  it('registers a setup file so a newly added test file inherits hermeticity', () => {
    const setupFiles = [vitestConfig.test?.setupFiles ?? []].flat()
    expect(
      setupFiles.length,
      'vitest.config.js declares no setupFiles — every new test file would inherit the raw shell environment',
    ).toBeGreaterThan(0)
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    for (const entry of setupFiles) {
      expect(existsSync(resolve(repoRoot, entry))).toBe(true)
    }
  })

  it('pins a process-per-worker pool, which the HOME sandbox depends on', () => {
    // The sandbox is applied by assigning process.env.HOME, and that only reaches
    // os.homedir() when a worker is its own process. Under a thread pool
    // process.env is a thread-local copy, os.homedir() keeps reporting the real
    // home, and every `home = homedir()` default in lib/ escapes the sandbox. The
    // setup file throws rather than run in that state; this keeps the config from
    // drifting into it in the first place.
    expect(
      vitestConfig.test?.pool,
      'vitest.config.js no longer pins a process-per-worker pool — the HOME sandbox cannot hold',
    ).toBe('forks')
  })
})
