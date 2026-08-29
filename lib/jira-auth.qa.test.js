import { describe, it, expect, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { probeJiraAuth } from './jira-auth.js'

// ---------------------------------------------------------------------------
// QA augmentation for #125 — probeJiraAuth as a TOTAL function.
//
// The dev's jira-auth.test.js proves the two verdicts and the four fail-safe
// shapes. This file asserts the two properties the module's own comment claims,
// as properties rather than as examples:
//
//   TOTALITY. `probeJiraAuth` NEVER REJECTS and never throws, for any `exec` and
//   any result, because its caller is `ralph doctor` — the command people run when
//   the machine is already broken. Every case below is asserted with `.resolves`,
//   which fails on a rejection instead of quietly reporting a pass.
//
//   EXIT CODE ONLY. The verdict is `r.exitCode === 0` and nothing else. The
//   adversarial half of that is the interesting half: a zero exit with stderr
//   screaming "not logged in" is AUTHENTICATED, and a non-zero exit that says
//   "Logged in as alice" is NOT — a CLI is free to change its wording, localise it
//   or be noisy on the way to succeeding, and the exit code is the part it
//   promises.
//
// Plus the ARGV, which is an interface: `acli jira auth status` with
// `{ reject: false }`. Dropping `reject: false` is the edit that would turn a
// clean "not authenticated" into a thrown execa error in production, so it is
// pinned on the call rather than assumed from the try/catch.
//
// No test here runs a real `acli`: `exec` is injected in every single call.
// ---------------------------------------------------------------------------

const NOT_AUTHED = { ok: false, reason: 'jira not authenticated' }
const AUTHED = { ok: true, reason: null }

describe('probeJiraAuth — the argv is the interface (#125 QA)', () => {
  it('runs exactly `acli jira auth status`, once, with reject:false', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }))
    await probeJiraAuth({ exec })
    expect(exec).toHaveBeenCalledTimes(1)
    const [cmd, argv, opts] = exec.mock.calls[0]
    expect(cmd).toBe('acli')
    expect(argv).toEqual(['jira', 'auth', 'status'])
    expect(argv).toHaveLength(3)
    // STRICTLY false, not merely falsy. `reject: undefined` is execa's default
    // (which throws on a non-zero exit), so a truthiness assertion here would pass
    // on the one edit this test exists to catch.
    expect(opts.reject).toBe(false)
  })

  it('passes no shell, no cwd and no env — it is one command, not a script', async () => {
    // A `shell: true` would make the argv a string a shell parses, and a `cwd`/`env`
    // would make the answer depend on where doctor was run from. None are wanted:
    // the probe asks acli about the user's session, full stop.
    const exec = vi.fn(async () => ({ exitCode: 0 }))
    await probeJiraAuth({ exec })
    const opts = exec.mock.calls[0][2]
    for (const key of ['shell', 'cwd', 'env', 'input', 'stdio']) {
      expect(key in opts, key).toBe(false)
    }
  })

  it('does not retry, and does not probe at all when there is nothing to probe with', async () => {
    const exec = vi.fn(async () => ({ exitCode: 1 }))
    await probeJiraAuth({ exec })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('hands out a FRESH result object per call', async () => {
    // The caller renders from this object; two callers must not be able to see each
    // other's verdict through a shared literal.
    const exec = async () => ({ exitCode: 0 })
    const a = await probeJiraAuth({ exec })
    const b = await probeJiraAuth({ exec })
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })

  it('documents the SHARED argv array (pre-existing pattern, same as agent-auth.js)', async () => {
    // The argv is a module-level constant handed straight to `exec`, exactly as
    // CODEX_LOGIN_STATUS_ARGV is in lib/agent-auth.js — so two calls see the SAME
    // array object, and an `exec` that mutated its arguments would corrupt every
    // later probe in the process. execa does not, and the pattern predates #125, so
    // this is recorded rather than reported. What matters is asserted: an unmutated
    // second call still gets the right argv.
    const seen = []
    const exec = async (_cmd, argv) => (seen.push(argv), { exitCode: 0 })
    await probeJiraAuth({ exec })
    await probeJiraAuth({ exec })
    expect(seen[0]).toBe(seen[1])
    expect(seen[1]).toEqual(['jira', 'auth', 'status'])
  })
})

describe('probeJiraAuth — the EXIT CODE decides, the text never does (#125 QA)', () => {
  const alarming = [
    ['stderr says not logged in', { stdout: '', stderr: 'not logged in' }],
    ['stderr says 401', { stdout: '', stderr: '401 Unauthorized' }],
    ['stdout says session expired', { stdout: 'session expired', stderr: '' }],
    ['stdout is the word error', { stdout: 'error', stderr: 'error' }],
    ['a deprecation notice', { stdout: '', stderr: 'WARN: acli 1.x is deprecated' }],
    ['no streams at all', {}],
    ['non-string streams', { stdout: 42, stderr: null }],
    ['a huge stdout', { stdout: 'x'.repeat(500_000), stderr: '' }],
  ]
  for (const [label, extra] of alarming) {
    it(`exit 0 is authenticated even when ${label}`, async () => {
      await expect(probeJiraAuth({ exec: async () => ({ exitCode: 0, ...extra }) })).resolves.toEqual(
        AUTHED,
      )
    })
  }

  const reassuring = [
    ['exit 1 while claiming a login', 1, { stdout: 'Logged in as alice@example.com' }],
    ['exit 2 with an empty stderr', 2, { stdout: 'ok', stderr: '' }],
    ['exit 127 (command not found)', 127, {}],
    ['exit 255', 255, {}],
    ['a negative exit code', -1, {}],
    ['a signal-shaped exit code', 130, {}],
  ]
  for (const [label, exitCode, extra] of reassuring) {
    it(`not authenticated on ${label}`, async () => {
      await expect(
        probeJiraAuth({ exec: async () => ({ exitCode, ...extra }) }),
      ).resolves.toEqual(NOT_AUTHED)
    })
  }

  it('is strict about the ZERO — only the number 0 is success', async () => {
    // `r.exitCode === 0` rather than `== 0` or `!r.exitCode`, which matters because
    // a result crossing a seam can carry any type. Every value below is falsy or
    // loosely-equal to zero and NONE of them is authenticated.
    for (const exitCode of ['0', '', null, undefined, false, NaN, [], ['0'], '0.0', 0n]) {
      await expect(
        probeJiraAuth({ exec: async () => ({ exitCode }) }),
        String(exitCode),
      ).resolves.toEqual(NOT_AUTHED)
    }
    // ...and the two spellings of the real thing are.
    await expect(probeJiraAuth({ exec: async () => ({ exitCode: 0 }) })).resolves.toEqual(AUTHED)
    await expect(probeJiraAuth({ exec: async () => ({ exitCode: -0 }) })).resolves.toEqual(AUTHED)
  })
})

describe('probeJiraAuth — total for every hostile exec and every hostile result (#125 QA)', () => {
  const execs = [
    ['no bag at all', undefined],
    ['an empty bag', {}],
    ['a null exec', null],
    ['an undefined exec', undefined],
    ['a string exec', 'acli'],
    ['a number exec', 42],
    ['a boolean exec', true],
    ['a plain object exec', {}],
    ['an array exec', []],
    ['a Symbol exec', Symbol('exec')],
    ['a Proxy that throws on call', new Proxy(function () {}, { apply() { throw new Error('nope') } })],
    ['a getter-only object', Object.defineProperty({}, 'call', { get() { throw new Error('nope') } })],
  ]
  for (const [label, exec] of execs) {
    it(`reports not-authenticated rather than throwing for ${label}`, async () => {
      const bag = label === 'no bag at all' ? undefined : { exec }
      await expect(probeJiraAuth(bag)).resolves.toEqual(NOT_AUTHED)
    })
  }

  const results = [
    ['undefined', async () => undefined],
    ['null', async () => null],
    ['the number 0', async () => 0],
    ['an empty string', async () => ''],
    ['false', async () => false],
    ['NaN', async () => NaN],
    ['a string', async () => 'Logged in'],
    ['an empty object', async () => ({})],
    ['an array', async () => []],
    ['a bare number', async () => 1],
    ['a result whose exitCode getter throws', async () => ({ get exitCode() { throw new Error('hostile getter') } })],
    ['a Proxy hostile on every get', async () => new Proxy({}, { get() { throw new Error('hostile proxy') } })],
  ]
  for (const [label, exec] of results) {
    it(`reports not-authenticated for a result that is ${label}`, async () => {
      await expect(probeJiraAuth({ exec })).resolves.toEqual(NOT_AUTHED)
    })
  }

  const failures = [
    ['throws synchronously', () => { throw new Error('ENOENT: acli not found') }],
    ['rejects', () => Promise.reject(new Error('boom'))],
    ['rejects with a non-Error', () => Promise.reject('a bare string')],
    ['rejects with undefined', () => Promise.reject(undefined)],
    ['throws a non-Error synchronously', () => { throw 'a bare string' }],
    ['returns a thenable whose then throws', () => ({ then() { throw new Error('hostile thenable') } })],
    ['returns a thenable that calls back with a rejection', () => ({ then: (_ok, bad) => bad(new Error('nope')) })],
  ]
  for (const [label, exec] of failures) {
    it(`reports not-authenticated when exec ${label}`, async () => {
      await expect(probeJiraAuth({ exec })).resolves.toEqual(NOT_AUTHED)
    })
  }

  it('accepts a SYNCHRONOUS exec that returns a plain result (await tolerates a non-thenable)', async () => {
    // Worth pinning because it is the shape a test double most often has, and the
    // one place a `.then` guard would have broken it.
    await expect(probeJiraAuth({ exec: () => ({ exitCode: 0 }) })).resolves.toEqual(AUTHED)
    await expect(probeJiraAuth({ exec: () => ({ exitCode: 1 }) })).resolves.toEqual(NOT_AUTHED)
  })

  it('waits for exec instead of fabricating a verdict while it is still running', async () => {
    // The pending case, tested WITHOUT hanging the suite: race the probe against a
    // short timer and assert the timer wins, then let exec answer. A probe that
    // guessed early would resolve first and fail this.
    let settle
    const exec = () => new Promise((resolve) => (settle = resolve))
    const probe = probeJiraAuth({ exec })
    const timer = new Promise((resolve) => setTimeout(() => resolve('still pending'), 20))
    expect(await Promise.race([probe, timer])).toBe('still pending')
    settle({ exitCode: 0 })
    await expect(probe).resolves.toEqual(AUTHED)
  })

  it('the reason is non-null EXACTLY when ok is false, and the shape never changes', async () => {
    // The SHAPE is the contract — two keys, a boolean and a nullable string —
    // rather than the wording. Nothing reads `reason` today: doctor renders its own
    // literal for the row (it has three states to spell and this has two), and
    // lib/commands/cycle.js is where a future slice would gate on it. Pinned so the
    // pair stays consistent for that consumer, not because a renderer echoes it.
    for (const exec of [async () => ({ exitCode: 0 }), async () => ({ exitCode: 1 }), undefined]) {
      const r = await probeJiraAuth({ exec })
      expect(Object.keys(r).sort()).toEqual(['ok', 'reason'])
      expect(typeof r.ok).toBe('boolean')
      if (r.ok) expect(r.reason).toBeNull()
      else expect(r.reason).toBe('jira not authenticated')
    }
  })
})

describe('probeJiraAuth — the module IMPORTS NOTHING, structurally (#125 QA)', () => {
  // The load-bearing claim in this file's own header comment, and the reason
  // `ralph doctor` may import it at all: doctor.js's import graph is pinned closed
  // against process spawners and sockets, so the module that RUNS a command must
  // reach the runner as an argument. Asserted on the comment-stripped source, so
  // the paragraph that explains the rule cannot satisfy or break it.
  const source = codeWithoutComments(fileURLToPath(new URL('./jira-auth.js', import.meta.url)))

  it('declares no imports and no requires at all', () => {
    expect(source).not.toMatch(/\bfrom\s*['"]/)
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\bimport\s*\(/)
    expect(source).not.toMatch(/\brequire\s*\(/)
  })

  it('names no process spawner, no socket and no ambient environment', () => {
    for (const banned of [
      /\bexeca\b/,
      /child_process/,
      /\bspawn(Sync)?\s*\(/,
      /\bexecSync\s*\(/,
      /\bfetch\s*\(/,
      /\bprocess\./,
      /node:/,
    ]) {
      expect(banned.test(source), String(banned)).toBe(false)
    }
  })

  it('spells the argv exactly once, as a named constant', () => {
    // The interface lives in one place; an inline copy at the call site is how the
    // two drift.
    expect(source.match(/'jira',\s*'auth',\s*'status'/g)).toHaveLength(1)
    expect(source).toContain('ACLI_JIRA_AUTH_STATUS_ARGV')
  })
})
