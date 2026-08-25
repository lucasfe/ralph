import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { poisonEnv, ralphEnvSurface, REPO_ROOT } from './helpers/env-surface.js'

// #41 QA augmentation — the acceptance criterion nothing else in the suite can
// check from the inside.
//
// AC #1/#2 are statements about the RESULT OF A WHOLE RUN: "`npm test` gives the
// same result with or without XDG_CONFIG_HOME / HOME / TASK_SOURCE / any RALPH_*
// set in the invoking shell". A test running inside the suite has already had its
// environment neutralized, so it cannot observe that by inspecting itself — the
// only honest check is to re-invoke vitest as a child, once with a clean shell
// and once with a hostile one, and compare the two results.
//
// The hostile shell is not hand-written: poisonEnv() exports a loud value for
// EVERY name the static scan in test/helpers/env-surface.js found ralph reading,
// so a name that test/setup/hermetic-env.js forgot to neutralize turns into a
// count mismatch here instead of a red CI run for whoever next touches the file.
//
// Each nested run is a single ~0.5s vitest invocation over two spec files.

const VITEST_CLI = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs')

// The two specs that assert the hermeticity contract itself. Deliberately NOT
// this file, so there is no recursion and no guard variable to get wrong.
const TARGET_SPECS = ['test/hermetic-env.test.js', 'test/hermetic-env.qa.test.js']

const SURFACE_NAMES = ralphEnvSurface().map((entry) => entry.name)

/**
 * Run vitest as a child over TARGET_SPECS with a specific ambient environment.
 * `env` values of `undefined` mean "explicitly unset in the child".
 */
function runNested({ env = {}, args = [], specs = TARGET_SPECS } = {}) {
  const childEnv = { ...process.env }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[name]
    else childEnv[name] = value
  }
  const res = spawnSync(
    process.execPath,
    [VITEST_CLI, 'run', ...specs, '--reporter=json', '--silent', ...args],
    { cwd: REPO_ROOT, env: childEnv, encoding: 'utf8', timeout: 120000 },
  )
  const start = res.stdout.indexOf('{')
  if (start === -1) {
    throw new Error(
      `nested vitest produced no JSON report (status ${res.status}).\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    )
  }
  const report = JSON.parse(res.stdout.slice(start))
  const files = report.testResults ?? []
  return {
    status: res.status,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    total: report.numTotalTests,
    success: report.success,
    // Names of the failures, so a mismatch says WHICH assertion the ambient
    // environment broke rather than just "3 !== 0".
    failures: files
      .flatMap((file) => file.assertionResults ?? [])
      .filter((t) => t.status === 'failed')
      .map((t) => t.fullName),
    // Spec files that failed WITHOUT producing a single assertion — i.e. the file
    // never loaded, so a setupFiles-level throw aborted it. Tracked separately
    // because such a run reports ZERO failed tests: `failures` is empty for a run
    // that proved nothing, which is indistinguishable from a green run unless the
    // executed count is checked too.
    loadErrors: files
      .filter((file) => file.status === 'failed' && (file.assertionResults ?? []).length === 0)
      .map((file) => file.message ?? ''),
    stderr: res.stderr,
  }
}

/**
 * Assert a hostile run reproduced the reference run. Checks that tests actually
 * EXECUTED before comparing failure lists: an aborted run has an empty failure
 * list, so `expect(failures).toEqual([])` alone is satisfied by the very outcome
 * it is meant to catch.
 */
function expectSameResultAs(hostile, baseline) {
  expect(
    hostile.loadErrors,
    'the hostile run never loaded its spec files — nothing was proven',
  ).toEqual([])
  expect(hostile.total, 'the hostile run executed a different number of tests').toBe(baseline.total)
  expect(hostile.success).toBe(baseline.success)
  expect(hostile.status).toBe(baseline.status)
  expect(hostile.failures).toEqual(baseline.failures)
  expect({ passed: hostile.passed, failed: hostile.failed }).toEqual({
    passed: baseline.passed,
    failed: baseline.failed,
  })
}

// A shell with every ralph-domain name explicitly UNSET — the reference result
// every hostile run must reproduce. Computed rather than assumed, because this
// very file may itself have been launched from a dirty shell.
const CLEAN_ENV = Object.fromEntries(SURFACE_NAMES.map((name) => [name, undefined]))

// Memoized so both describes below share one reference run instead of depending
// on cross-describe ordering.
let cachedBaseline
function getBaseline() {
  cachedBaseline ??= runNested({ env: CLEAN_ENV })
  return cachedBaseline
}

describe('QA #41 AC1/AC2 — the suite result does not depend on the invoking shell', () => {
  // Every test below calls getBaseline() itself rather than relying on the first
  // test to assign it: a test that only passes when its neighbours ran is a test
  // that reports the wrong thing under `-t`, `.only` or a shard.
  it('establishes a baseline result with every ralph-domain variable unset', () => {
    const baseline = getBaseline()
    expect(baseline.loadErrors, `nested baseline never loaded its specs:\n${baseline.stderr}`).toEqual(
      [],
    )
    expect(baseline.failures, `nested baseline is not green:\n${baseline.stderr}`).toEqual([])
    expect(baseline.success).toBe(true)
    expect(baseline.status).toBe(0)
    // Guards every comparison below: a reference run of zero tests would make
    // "identical to baseline" trivially true for any hostile shell.
    expect(baseline.total).toBeGreaterThan(20)
  })

  it('gives an identical result with the exact #41 repro shell (XDG_CONFIG_HOME + RALPH_AGENT + TASK_SOURCE)', () => {
    // Verbatim from the issue: `XDG_CONFIG_HOME=/tmp/anything RALPH_AGENT=codex
    // TASK_SOURCE=folder npm test`.
    const xdg = mkdtempSync(join(tmpdir(), 'qa-ambient-xdg-'))
    try {
      const hostile = runNested({
        env: { ...CLEAN_ENV, XDG_CONFIG_HOME: xdg, RALPH_AGENT: 'codex', TASK_SOURCE: 'folder' },
      })
      expectSameResultAs(hostile, getBaseline())
    } finally {
      rmSync(xdg, { recursive: true, force: true })
    }
  })

  it('gives an identical result with a poison value exported for EVERY name ralph reads', () => {
    // The allowlist-vs-denylist check. Every name the static scan found is
    // exported; a name test/setup/hermetic-env.js does not neutralize shows up
    // as a named failure below.
    const baseline = getBaseline()
    const hostile = runNested({ env: { ...CLEAN_ENV, ...poisonEnv() } })
    expect(
      hostile.failures,
      'a ralph-domain variable from the invoking shell changed the suite result — test/setup/hermetic-env.js does not neutralize every name lib/ reads',
    ).toEqual(baseline.failures)
    expectSameResultAs(hostile, baseline)
  })

  it('gives an identical result with a hostile HOME and an unreadable XDG_CONFIG_HOME', () => {
    const hostile = runNested({
      env: {
        ...CLEAN_ENV,
        HOME: '/qa-nonexistent-home',
        XDG_CONFIG_HOME: '/qa-nonexistent-home/xdg',
        TEST_CMD: 'exit 7',
        INSTALL_CMD: 'exit 7',
        RALPH_HEAVY_TIER: '1',
      },
    })
    expectSameResultAs(hostile, getBaseline())
  })

  it('gives an identical result with the shell ralph itself exports around npm test', () => {
    // `ralph` runs the project's test command with RALPH_AGENT / RALPH_RUN_ID /
    // PROJECT_ROOT exported, so "the invoking shell" includes ralph running on
    // its own repo. Called out in the setup file's own preamble.
    const hostile = runNested({
      env: {
        ...CLEAN_ENV,
        RALPH_AGENT: 'codex',
        RALPH_RUN_ID: 'qa-run-id',
        RALPH_RESOLVED_AGENT: 'codex',
        PROJECT_ROOT: REPO_ROOT,
      },
    })
    expectSameResultAs(hostile, getBaseline())
  })
})

// A private temp dir for a nested run, so the sandboxes it creates can be
// attributed to it EXACTLY.
//
// Watching the shared tmpdir() and diffing before/after does not work: the outer
// suite's ~89 spec files are running in sibling workers the whole time, each
// creating and removing a `ralph-test-home-<pid>-<worker>` of its own. Any sibling
// that starts a file during the nested run leaves a NEW entry that the diff
// attributes to the child — green on a fast laptop where the window is small, red
// on a 2-core CI runner where it is not (the leftover that failed CI was worker
// 78, and a nested run over two specs only ever numbers its workers 1-2).
//
// `os.tmpdir()` resolves TMPDIR/TEMP/TMP from the environment in JS, so pointing
// the child at its own directory relocates every sandbox it makes. All three names
// are set for the win32 branch, and the setup file keeps them (they are in its
// TOOLCHAIN_NAMES) so the child does not delete its own temp root.
function withNestedTmp(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-nested-tmp-'))
  try {
    return fn({ tmp, env: { TMPDIR: tmp, TEMP: tmp, TMP: tmp } })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const sandboxesIn = (dir) => readdirSync(dir).filter((name) => name.startsWith('ralph-test-home-'))

describe('QA #41 the sandbox leaves nothing behind in the OS temp dir', () => {
  it('creates no sandbox that outlives the run that made it', () => {
    withNestedTmp(({ tmp, env }) => {
      const run = runNested({ env: { ...CLEAN_ENV, ...env } })
      // The run has to have PROVED something first: a child that aborted on load
      // leaves an empty temp dir too, which would satisfy the assertion below
      // without a single sandbox ever having been created. Being green also proves
      // the relocation took — test/hermetic-env.test.js asserts HOME is under
      // tmpdir(), and in the child tmpdir() IS `tmp`, so a sandbox that stayed in
      // the shared /tmp would fail the nested run rather than quietly make the
      // emptiness check below vacuous.
      expectSameResultAs(run, getBaseline())
      expect(run.total).toBeGreaterThan(20)
      const leftOver = sandboxesIn(tmp)
      expect(
        leftOver,
        `these sandboxes survived the nested run: ${leftOver.join(', ')} under ${tmp}`,
      ).toEqual([])
    })
  })
})

describe('QA #41 a pool that cannot be made hermetic is REFUSED, not silently tolerated', () => {
  // In a thread-based pool `process.env` is a thread-local copy that never
  // reaches libuv's getenv, so `process.env.HOME = sandbox` leaves os.homedir()
  // reporting the developer's REAL home and every `home = homedir()` default in
  // lib/ resolves against it. test/setup/hermetic-env.js detects that and throws
  // instead of running, which is the right call — but it means the run executes
  // ZERO tests, and a zero-test run has an EMPTY failure list. So the assertion
  // here must be the refusal itself, never "no tests failed": the latter is
  // satisfied by exactly the outcome it was written to catch.
  let threaded
  let newSandboxes

  beforeAll(() => {
    withNestedTmp(({ tmp, env }) => {
      threaded = runNested({ args: ['--pool=threads'], env: { ...CLEAN_ENV, ...env } })
      // Read from a temp root only this child could write to, so a sandbox found
      // here IS the refused run's — see withNestedTmp for why diffing the shared
      // tmpdir() against sibling workers cannot make that attribution.
      newSandboxes = sandboxesIn(tmp)
    })
  })

  it('exits non-zero and reports the run as unsuccessful', () => {
    expect(threaded.status, 'a pool that cannot be made hermetic must fail the run').not.toBe(0)
    expect(threaded.success).toBe(false)
  })

  it('executes ZERO tests — it aborts before any spec can run non-hermetically', () => {
    expect(
      threaded.total,
      'a spec executed under a pool where the HOME sandbox cannot hold — it would resolve `home = homedir()` against the real home',
    ).toBe(0)
    expect(threaded.passed).toBe(0)
  })

  it('refuses EVERY spec file, not just the first one to load', () => {
    expect(threaded.loadErrors.length).toBe(TARGET_SPECS.length)
  })

  it('names the mechanism, the cause and the remedy in the abort message', () => {
    // A silent abort would be nearly as bad as a silent leak: whoever flipped the
    // pool has to be told why, or they will assume the suite is broken.
    for (const message of threaded.loadErrors) {
      expect(message).toContain('hermetic-env (#41)')
      expect(message).toMatch(/os\.homedir\(\)/)
      expect(message).toMatch(/pool/)
    }
  })

  it('is NOT mistaken for a clean run by this file\'s own comparison helper', () => {
    // Self-check with teeth: `threaded.failures` IS empty, so a comparison that
    // looked only at failure lists would call this identical to the green
    // baseline. expectSameResultAs must reject it on the executed count.
    expect(threaded.failures).toEqual([])
    expect(() => expectSameResultAs(threaded, getBaseline())).toThrow()
  })

  it('cleans up its sandbox on the way out rather than leaking it into the temp dir', () => {
    // The abort path has to rmSync the sandbox it just made BEFORE throwing:
    // afterAll never registers, so nothing else will. Otherwise every accidental
    // `--pool=threads` invocation drops a directory in the temp dir forever.
    expect(
      newSandboxes,
      `the refused run left these behind in its private temp root: ${newSandboxes.join(', ')}`,
    ).toEqual([])
  })
})
