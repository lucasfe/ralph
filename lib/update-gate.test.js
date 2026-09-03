import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { Readable } from 'node:stream'
import { runUpdateGate } from './update-gate.js'
import { readVersionCache, versionCachePath } from './version-cache.js'
import { NPM_VERSION_QUERY, recordPromptShown, resolveUpdateDecision } from './update-check.js'
import { confirm } from './utils/prompt.js'
import { npmGlobalLayout } from '../test/helpers/install-layout.js'

// #50: the update gate — #24's notice, #25's TTY-gated prompt and #26's prompt
// window, extracted out of startCommand's step 2.5 so `ralph cycle` can reuse the
// same policy instead of duplicating it. This file owns the module's OWN contract:
//   - the verdict shape, which is all a caller gets to act on;
//   - the notice printing on every isNewer run, prompt window open or not;
//   - the TTY gate, which must never construct a readline over a non-interactive
//     stdin (`confirm` never resolves on an input that ends without a line, so a
//     prompt there is a hang, not a cosmetic defect);
//   - the stamp landing BEFORE the answer is awaited;
//   - the never-throws boundaries: a throwing runUpdate, a throwing clock, a
//     hostile env bag, a rejecting `update`.
//
// The two CONSEQUENCES of the verdict — the ✅ line plus the early return, and the
// neutral ⚠️ line — stay with the caller and are proven where the caller lives
// (test/commands/start.test.js and lib/commands/start*.qa.test.js). Nothing here
// asserts them; a gate that printed them would be doing the caller's job.
//
// Hermeticity: `isTTY` is passed EXPLICITLY wherever a prompt is expected (it is
// undefined on a vitest worker's stdin, so a defaulted gate never prompts and the
// test would be vacuous), every run gets a memfs `cacheFs` and a fake `home`, and
// `exec` is injected so no registry query ever leaves the process. The DEFAULT
// `update` and `recordPrompt` are the real ones from ./update-check.js, so the
// cache assertions below are about production behaviour.

const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const NPM_VIEW = 'npm view @lucasfe/ralph version'
const PROMPT = 'Update now? [y/N]: '
const NOTICE = 'New version available'
const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()

// picocolors may or may not emit escapes depending on the ambient environment, so
// every message assertion runs on stripped text.
const strip = (s) => String(s).replace(/\u001B\[[0-9;]*m/g, '')

function makeStream(timeline = [], tag = 'out') {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      timeline.push(`${tag}:${strip(String(s)).trim()}`)
      return true
    },
    output: () => strip(chunks.join('')),
    lines: () => strip(chunks.join('')).split('\n').filter(Boolean),
  }
}

// Matched on cmd/args rather than exact key strings, the same idiom as the start
// suites, so a flag tweak cannot silently defuse an assertion into vacuous truth.
function makeExec({ npm } = {}, timeline = []) {
  const calls = []
  const exec = async (cmd, args = []) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    timeline.push(`exec:${key}`)
    if (cmd === 'npm' && args[0] === 'view') {
      return npm ?? { exitCode: 0, stdout: '0.2.0\n', stderr: '', timedOut: false }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  exec.npmViews = () => calls.filter((c) => c === NPM_VIEW)
  return exec
}

// `reply` may be a value (resolved) or a function (called for its raw return — used
// to exercise non-promise returns, throws and never-settling prompts). Rest args,
// not a default parameter: makeAsk(undefined) must mean "resolve undefined", which
// a `reply = true` default would silently turn into an accept.
function makeAsk(...args) {
  const reply = args.length ? args[0] : true
  const calls = []
  const ask = (question, options) => {
    calls.push({ question, options })
    return typeof reply === 'function' ? reply(question, options) : Promise.resolve(reply)
  }
  ask.calls = calls
  return ask
}

const OK_UPDATE = { exitCode: 0, updated: true, from: '0.1.0', to: '0.2.0' }

function makeRunUpdate(...args) {
  const result = args.length ? args[0] : OK_UPDATE
  const calls = []
  const fn = (a) => {
    calls.push(a)
    return typeof result === 'function' ? result(a) : Promise.resolve(result)
  }
  fn.calls = calls
  return fn
}

// One argument bag, with every call recorded on ONE timeline so the stamp/ask
// ordering and the notice/ask ordering are read off a single sequence.
function args(overrides = {}) {
  const timeline = []
  const stdout = makeStream(timeline, 'out')
  const stderr = makeStream(timeline, 'err')
  const stampCalls = []
  const decisionCalls = []
  const innerStamp = overrides.recordPrompt ?? recordPromptShown
  const innerUpdate = overrides.update ?? resolveUpdateDecision
  const a = {
    stdout,
    stderr,
    // A sentinel, NOT process.stdin: identity is asserted at the ask() call site
    // and nothing here may ever touch the real terminal.
    stdin: { marker: 'injected-stdin', isTTY: false },
    isTTY: true,
    exec: makeExec(overrides.execOptions, timeline),
    ask: overrides.ask ?? makeAsk(true),
    runUpdate: overrides.runUpdate ?? makeRunUpdate(),
    currentVersion: '0.1.0',
    now: () => T0,
    home: HOME,
    processEnv: {},
    cacheFs: new Volume(),
    // #200: the layout the notice describes. Injected because the default reads
    // RALPH_HOME — this checkout, a `.git`, so `linked` — and this file's subject is
    // the gate's policy, not which install it is running from. A plain npm global
    // install is the layout #24's notice bytes came from.
    classify: npmGlobalLayout(),
    ...overrides,
  }
  delete a.execOptions
  a.update = (bag) => {
    timeline.push('decide')
    decisionCalls.push(bag)
    return innerUpdate(bag)
  }
  a.recordPrompt = (bag) => {
    timeline.push('stamp')
    stampCalls.push(bag)
    return innerStamp(bag)
  }
  const innerAsk = a.ask
  const wrappedAsk = (question, options) => {
    timeline.push('ask')
    return innerAsk(question, options)
  }
  wrappedAsk.calls = innerAsk.calls
  a.ask = wrappedAsk
  a.timeline = timeline
  a.stampCalls = stampCalls
  a.decisionCalls = decisionCalls
  a.at = (needle) => timeline.findIndex((e) => e.includes(needle))
  return a
}

const cacheOf = (fs, processEnv = {}) => readVersionCache({ fs, home: HOME, processEnv })
const seededCache = (cache) => Volume.fromJSON({ [CACHE_PATH]: JSON.stringify(cache) }, '/')

const VERDICT_KEYS = [
  'accepted',
  'installed',
  'installedVersion',
  'isNewer',
  'latestVersion',
  'prompted',
]

describe('runUpdateGate — the verdict', () => {
  it('reports the version, the prompt, the answer and the install that happened', async () => {
    const a = args()
    const verdict = await runUpdateGate(a)
    expect(verdict).toEqual({
      isNewer: true,
      latestVersion: '0.2.0',
      prompted: true,
      accepted: true,
      installed: true,
      installedVersion: '0.2.0',
    })
    expect(Object.keys(verdict).sort()).toEqual(VERDICT_KEYS)
  })

  it('reports nothing newer, prints nothing and asks nothing when the release is current', async () => {
    const a = args({ currentVersion: '0.2.0' })
    const verdict = await runUpdateGate(a)
    expect(verdict).toEqual({
      isNewer: false,
      latestVersion: '0.2.0',
      prompted: false,
      accepted: false,
      installed: false,
      installedVersion: null,
    })
    expect(a.ask.calls).toHaveLength(0)
    expect(a.runUpdate.calls).toHaveLength(0)
    expect(a.stdout.output()).toBe('')
    expect(a.stderr.output()).toBe('')
  })

  it('reports a shown-but-declined prompt without an accept or an install', async () => {
    const a = args({ ask: makeAsk(false) })
    const verdict = await runUpdateGate(a)
    expect(verdict).toEqual({
      isNewer: true,
      latestVersion: '0.2.0',
      prompted: true,
      accepted: false,
      installed: false,
      installedVersion: null,
    })
    expect(a.runUpdate.calls).toHaveLength(0)
  })

  it('reports an accepted install that FAILED as accepted but not installed', async () => {
    const a = args({ runUpdate: makeRunUpdate({ exitCode: 1, updated: false, to: '0.2.0' }) })
    const verdict = await runUpdateGate(a)
    expect(verdict.accepted).toBe(true)
    expect(verdict.installed).toBe(false)
    expect(verdict.installedVersion).toBeNull()
  })

  // The whole reason runUpdateSafely reads `updated` and not `to`: updateCommand's
  // advice path (an npx run, a linked dev checkout) exits 0 with updated:false and
  // a `to` naming the version that is out there.
  it('gates the install on `updated`, never on `to`', async () => {
    const a = args({ runUpdate: makeRunUpdate({ exitCode: 0, updated: false, to: '0.2.0' }) })
    const verdict = await runUpdateGate(a)
    expect(verdict.installed).toBe(false)
    expect(verdict.installedVersion).toBeNull()
  })

  it('falls back to the notice’s version when a successful install names no `to`', async () => {
    const a = args({ runUpdate: makeRunUpdate({ updated: true }) })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ installed: true, installedVersion: '0.2.0' })
  })

  it('reports the install’s own `to` when the registry moved past the notice', async () => {
    const a = args({ runUpdate: makeRunUpdate({ updated: true, to: '0.3.0' }) })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ latestVersion: '0.2.0', installedVersion: '0.3.0' })
  })

  it('prints only the notice — the ✅ and ⚠️ consequences belong to the caller', async () => {
    const a = args()
    await runUpdateGate(a)
    expect(a.stdout.lines()).toHaveLength(1)
    expect(a.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    expect(a.stdout.output()).not.toContain('Updated to')
    expect(a.stdout.output()).not.toContain('Update did not complete')
    expect(a.stderr.output()).toBe('')
  })
})

describe('runUpdateGate — the notice prints on every newer run, throttled or not', () => {
  it('prints one notice naming the manual upgrade command, before the question', async () => {
    const a = args()
    await runUpdateGate(a)
    const notices = a.stdout.lines().filter((l) => l.includes(NOTICE))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('New version available: 0.2.0')
    expect(notices[0]).toContain('npm i -g @lucasfe/ralph')
    expect(a.at('decide')).toBeLessThan(a.at(`out:${NOTICE}`))
    expect(a.at(`out:${NOTICE}`)).toBeLessThan(a.at('ask'))
  })

  it('prints the notice from a stale cached version when the registry query fails', async () => {
    const a = args({
      cacheFs: seededCache({
        last_check_at: iso(T0 - 30 * DAY),
        last_prompted_at: null,
        latest_version: '0.2.0',
      }),
      execOptions: { npm: { exitCode: 1, stdout: '', stderr: 'offline' } },
    })
    const verdict = await runUpdateGate(a)
    expect(a.exec.npmViews()).toHaveLength(1)
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: '0.2.0', prompted: true })
    expect(a.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })

  // #26: only the QUESTION is throttled. This is what a run inside the 7-day
  // prompt window looks like — notice yes, question no.
  it('prints the notice with NO question when the prompt window is closed', async () => {
    const cacheFs = seededCache({
      last_check_at: iso(T0 - DAY),
      last_prompted_at: iso(T0 - 2 * DAY),
      latest_version: '0.2.0',
    })
    const a = args({ cacheFs })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ isNewer: true, prompted: false, accepted: false })
    expect(a.ask.calls).toHaveLength(0)
    expect(a.stampCalls).toHaveLength(0)
    expect(a.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })

  it('prints the notice from the CACHED version when the check window is closed', async () => {
    const a = args({
      cacheFs: seededCache({
        last_check_at: iso(T0 - DAY),
        last_prompted_at: null,
        latest_version: '0.2.0',
      }),
    })
    const verdict = await runUpdateGate(a)
    expect(a.exec.npmViews()).toHaveLength(0)
    expect(a.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    expect(verdict.prompted).toBe(true)
  })

  it('prints the notice without prompting on a non-TTY run', async () => {
    const a = args({ isTTY: false, ask: makeAsk(true) })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ isNewer: true, prompted: false, accepted: false })
    expect(a.ask.calls).toHaveLength(0)
    expect(a.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    expect(cacheOf(a.cacheFs).last_prompted_at).toBeNull()
  })

  it('prints nothing at all on the RALPH_NO_UPDATE_CHECK opt-out', async () => {
    const a = args({ processEnv: { RALPH_NO_UPDATE_CHECK: '1' } })
    const verdict = await runUpdateGate(a)
    expect(verdict.isNewer).toBe(false)
    expect(a.exec.npmViews()).toHaveLength(0)
    expect(a.stdout.output()).toBe('')
    expect(Object.keys(a.cacheFs.toJSON())).toEqual([])
  })
})

describe('runUpdateGate — the TTY gate never builds a readline it cannot escape', () => {
  // `confirm` never resolves on an input that ends without a line (readline closes
  // and the question callback is never invoked), so a prompt on a non-interactive
  // stdin is a HANG. The gate returning at all is the assertion.
  it('returns on a non-TTY run whose stdin has already ended, with the REAL confirm', async () => {
    const a = args({ isTTY: false, ask: confirm, stdin: Readable.from([]) })
    const outcome = await Promise.race([
      runUpdateGate(a).then((verdict) => verdict.prompted),
      new Promise((r) => setTimeout(() => r('hung'), 150)),
    ])
    expect(outcome).toBe(false)
    expect(a.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    // No readline was constructed, so the question was never echoed either.
    expect(a.stdout.output()).not.toContain(PROMPT)
  })

  // `createInterface({ input: null })` throws a raw TypeError, so a gate that
  // consulted anything other than its own `isTTY` here would escape rather than
  // return a verdict. `ask` is the real confirm precisely so that throw is reachable.
  it('builds no readline over a null stdin, with the REAL confirm', async () => {
    const a = args({ stdin: null, ask: confirm })
    delete a.isTTY
    const verdict = await runUpdateGate(a)
    expect(verdict.prompted).toBe(false)
    expect(a.stdout.output()).not.toContain(PROMPT)
  })

  it('defaults isTTY off the injected stdin — non-TTY stream, no question', async () => {
    const a = args({ stdin: { isTTY: false, marker: 'piped-stream' } })
    delete a.isTTY
    const verdict = await runUpdateGate(a)
    expect(verdict.prompted).toBe(false)
    expect(a.ask.calls).toHaveLength(0)
  })

  it('defaults isTTY off the injected stdin — TTY stream, question asked over it', async () => {
    const a = args({ stdin: { isTTY: true, marker: 'tty-ish' } })
    delete a.isTTY
    const verdict = await runUpdateGate(a)
    expect(verdict.prompted).toBe(true)
    expect(a.ask.calls[0].options.input).toBe(a.stdin)
  })

  it('an explicit isTTY:false beats a TTY-looking stdin', async () => {
    const a = args({
      isTTY: false,
      stdin: { isTTY: true, marker: 'tty-ish' },
      ask: makeAsk(() => {
        throw new Error('confirm must never be called without a TTY')
      }),
    })
    const verdict = await runUpdateGate(a)
    expect(verdict.prompted).toBe(false)
  })
})

describe('runUpdateGate — the stamp lands before the answer is awaited', () => {
  it('stamps after the notice and before the question, on one timeline', async () => {
    const a = args()
    await runUpdateGate(a)
    expect(a.stampCalls).toHaveLength(1)
    expect(a.at(`out:${NOTICE}`)).toBeLessThan(a.at('stamp'))
    expect(a.at('stamp')).toBeLessThan(a.at('ask'))
    expect(cacheOf(a.cacheFs).last_prompted_at).toBe(iso(T0))
  })

  // The window belongs to the ASKING, not the answering: a user who Ctrl-Cs at the
  // prompt has seen the question and must not be asked again seconds later.
  it('has already burned the window while the answer is still pending', async () => {
    const a = args({ ask: makeAsk(() => new Promise(() => {})) })
    const outcome = await Promise.race([
      runUpdateGate(a).then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('still-waiting'), 20)),
    ])
    expect(outcome).toBe('still-waiting')
    expect(cacheOf(a.cacheFs).last_prompted_at).toBe(iso(T0))
  })

  // PINNED, not endorsed, and identical to the pre-extraction behaviour: the `ask`
  // seam is one of the two boundaries the gate does NOT swallow (the other is the
  // notice write), so the caller keeps aborting on a broken prompt instead of
  // silently starting a loop it was never told to start. The real
  // `confirm` cannot reject (a Ctrl-C kills the process, an EOF hangs), so this is
  // unreachable today.
  it('lets a rejecting ask escape, with the window already burned', async () => {
    const boom = new Error('readline exploded')
    const a = args({ ask: makeAsk(() => Promise.reject(boom)) })
    await expect(runUpdateGate(a)).rejects.toBe(boom)
    expect(cacheOf(a.cacheFs).last_prompted_at).toBe(iso(T0))
    expect(a.runUpdate.calls).toHaveLength(0)
  })

  it('does not stamp when there is nothing newer to offer', async () => {
    const a = args({ currentVersion: '0.2.0' })
    await runUpdateGate(a)
    expect(a.stampCalls).toHaveLength(0)
    expect(cacheOf(a.cacheFs).last_prompted_at).toBeNull()
  })
})

describe('runUpdateGate — never throws', () => {
  it('resolves to a not-installed verdict when runUpdate REJECTS', async () => {
    const a = args({ runUpdate: makeRunUpdate(() => Promise.reject(new Error('npm exploded'))) })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ accepted: true, installed: false, installedVersion: null })
    expect(a.stderr.output()).toBe('')
  })

  it('resolves to a not-installed verdict when runUpdate throws SYNCHRONOUSLY', async () => {
    const a = args({
      runUpdate: makeRunUpdate(() => {
        throw new TypeError('not a function')
      }),
    })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ accepted: true, installed: false })
  })

  for (const [label, result] of [
    ['undefined', undefined],
    ['null', null],
    ['a bare object', {}],
    ['a string', 'not-an-object'],
  ]) {
    it(`resolves to a not-installed verdict when runUpdate returns ${label}`, async () => {
      const a = args({ runUpdate: makeRunUpdate(result) })
      const verdict = await runUpdateGate(a)
      expect(verdict).toMatchObject({ accepted: true, installed: false, installedVersion: null })
    })
  }

  it('resolves to a verdict when the `now` callback THROWS', async () => {
    const a = args({
      now: () => {
        throw new Error('clock exploded')
      },
    })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: '0.2.0', installed: true })
  })

  for (const [label, processEnv] of [
    ['null', null],
    ['undefined', undefined],
    ['a bag with no keys', {}],
  ]) {
    it(`resolves to a verdict on a ${label} processEnv`, async () => {
      const a = args({ processEnv })
      const verdict = await runUpdateGate(a)
      expect(verdict).toMatchObject({ isNewer: true, latestVersion: '0.2.0' })
    })
  }

  it('resolves to a verdict on a HOSTILE processEnv whose getter throws', async () => {
    // isUpdateCheckDisabled reads RALPH_NO_UPDATE_CHECK before resolveUpdateDecision
    // enters any try block, so this escapes the decision itself — the gate's own
    // guard is what makes the never-throws promise hold at the boundary.
    const processEnv = {}
    Object.defineProperty(processEnv, 'RALPH_NO_UPDATE_CHECK', {
      get() {
        throw new Error('hostile env')
      },
    })
    const a = args({ processEnv })
    const verdict = await runUpdateGate(a)
    expect(verdict).toEqual({
      isNewer: false,
      latestVersion: null,
      prompted: false,
      accepted: false,
      installed: false,
      installedVersion: null,
    })
    expect(a.stdout.output()).toBe('')
    expect(a.stderr.output()).toBe('')
  })

  it('resolves to a verdict when `update` REJECTS, silently', async () => {
    const a = args({ update: async () => Promise.reject(new Error('decision exploded')) })
    const verdict = await runUpdateGate(a)
    expect(verdict.isNewer).toBe(false)
    expect(a.ask.calls).toHaveLength(0)
    expect(a.stdout.output()).toBe('')
    expect(a.stderr.output()).toBe('')
  })

  it('resolves to a verdict when `update` throws SYNCHRONOUSLY', async () => {
    const a = args({
      update: () => {
        throw new Error('decision exploded')
      },
    })
    const verdict = await runUpdateGate(a)
    expect(verdict.isNewer).toBe(false)
    expect(a.ask.calls).toHaveLength(0)
  })

  it('resolves to a verdict when `update` is not callable at all', async () => {
    // Assigned past the harness's `??` fallback on purpose: a null seam reaches the
    // gate as null (a destructuring default only fires on undefined), so the call
    // itself is what throws.
    const a = args()
    a.update = null
    const verdict = await runUpdateGate(a)
    expect(verdict.isNewer).toBe(false)
    expect(a.ask.calls).toHaveLength(0)
    expect(a.stdout.output()).toBe('')
  })

  for (const [label, decision] of [
    ['undefined', undefined],
    ['null', null],
    ['a bare object', {}],
    ['a string', 'newer!'],
    ['isNewer with no latestVersion', { isNewer: true, shouldPrompt: false }],
  ]) {
    it(`resolves to a verdict when the decision is ${label}`, async () => {
      const a = args({ update: async () => decision })
      const verdict = await runUpdateGate(a)
      expect(Object.keys(verdict).sort()).toEqual(VERDICT_KEYS)
      expect(verdict.accepted).toBe(false)
      expect(verdict.installed).toBe(false)
    })
  }

  it('still asks when the stamp THROWS — losing the window costs a question, not the run', async () => {
    const a = args({
      recordPrompt: () => {
        throw new Error('cache exploded')
      },
    })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ prompted: true, accepted: true, installed: true })
    expect(a.stderr.output()).toBe('')
  })

  for (const [label, value] of [
    ['null', null],
    ['false', false],
    ['a string', 'stamped'],
    ['an object with junk keys', { declined_version: '0.2.0' }],
  ]) {
    it(`ignores a stamp that returns ${label}`, async () => {
      const a = args({ recordPrompt: () => value, ask: makeAsk(false) })
      const verdict = await runUpdateGate(a)
      expect(verdict).toMatchObject({ prompted: true, accepted: false })
    })
  }

  it('an unwritable cache burns no window and still asks', async () => {
    const cacheFs = {
      readFileSync: () => {
        const e = new Error('ENOENT')
        e.code = 'ENOENT'
        throw e
      },
      mkdirSync: () => {
        const e = new Error('EACCES')
        e.code = 'EACCES'
        throw e
      },
      writeFileSync: () => undefined,
    }
    const first = args({ cacheFs })
    const second = args({ cacheFs, now: () => T0 + 60_000 })
    expect((await runUpdateGate(first)).prompted).toBe(true)
    expect((await runUpdateGate(second)).prompted).toBe(true)
    expect(first.stderr.output()).toBe('')
    expect(second.stderr.output()).toBe('')
  })
})

describe('runUpdateGate — the seams it forwards', () => {
  it('hands the decision exactly {currentVersion, exec, now, processEnv, home, fs, latestSource}', async () => {
    const a = args()
    await runUpdateGate(a)
    expect(a.decisionCalls).toHaveLength(1)
    const [bag] = a.decisionCalls
    expect(Object.keys(bag).sort()).toEqual([
      'currentVersion',
      'exec',
      'fs',
      'home',
      // #200: the seventh key — WHICH CHANNEL to ask. A function, not a descriptor:
      // resolveUpdateDecision calls it only on the run that queries a channel, which
      // is what keeps the throttled and opted-out paths from classifying at all.
      'latestSource',
      'now',
      'processEnv',
    ])
    expect(bag.currentVersion).toBe('0.1.0')
    expect(bag.exec).toBe(a.exec)
    expect(bag.now).toBe(a.now)
    expect(bag.processEnv).toBe(a.processEnv)
    expect(bag.home).toBe(HOME)
    expect(bag.fs).toBe(a.cacheFs)
    expect(typeof bag.latestSource).toBe('function')
    // It resolves to the injected layout's channel — npm's query — and reads it off
    // the classification rather than naming one here.
    expect(await bag.latestSource()).toBe(NPM_VERSION_QUERY)
  })

  it('hands the stamp the very same clock, env, home and fs the decision got', async () => {
    const a = args()
    await runUpdateGate(a)
    const [decision] = a.decisionCalls
    const [stamp] = a.stampCalls
    expect(Object.keys(stamp).sort()).toEqual(['fs', 'home', 'now', 'processEnv'])
    expect(stamp.now).toBe(decision.now)
    expect(stamp.processEnv).toBe(decision.processEnv)
    expect(stamp.home).toBe(decision.home)
    expect(stamp.fs).toBe(decision.fs)
  })

  it('a stamp that mutates its own argument bag cannot corrupt the run', async () => {
    const a = args({
      recordPrompt: (bag) => {
        bag.fs = null
        bag.home = 42
        bag.now = null
        return null
      },
    })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ prompted: true, accepted: true, installed: true })
  })

  it('hands ask the prompt over exactly {input, output}', async () => {
    const a = args()
    await runUpdateGate(a)
    expect(a.ask.calls).toHaveLength(1)
    expect(a.ask.calls[0].question).toBe(PROMPT)
    expect(Object.keys(a.ask.calls[0].options).sort()).toEqual(['input', 'output'])
    expect(a.ask.calls[0].options.input).toBe(a.stdin)
    expect(a.ask.calls[0].options.output).toBe(a.stdout)
  })

  it('hands runUpdate exactly {currentVersion, exec, stdout, stderr}', async () => {
    const a = args()
    await runUpdateGate(a)
    const [bag] = a.runUpdate.calls
    expect(Object.keys(bag).sort()).toEqual(['currentVersion', 'exec', 'stderr', 'stdout'])
    expect(bag.currentVersion).toBe('0.1.0')
    expect(bag.exec).toBe(a.exec)
    expect(bag.stdout).toBe(a.stdout)
    expect(bag.stderr).toBe(a.stderr)
    // No `force`, and no processEnv/home leak into the update machinery.
    expect(bag.force).toBeUndefined()
  })

  it('asks exactly once and installs exactly once per call', async () => {
    const a = args()
    await runUpdateGate(a)
    expect(a.ask.calls).toHaveLength(1)
    expect(a.runUpdate.calls).toHaveLength(1)
    expect(a.exec.npmViews()).toHaveLength(1)
  })

  it('never spawns an install of its own — the update goes through runUpdate', async () => {
    const a = args()
    await runUpdateGate(a)
    expect(a.exec.calls).toEqual([NPM_VIEW])
  })

  it('resolves to a verdict on a bag carrying nothing but the cache seams', async () => {
    // Everything else defaults: the real decision, the real stamp, `confirm`,
    // `updateCommand`, and an `exec` that is absent entirely — which
    // fetchLatestVersion answers with null rather than a throw. Proves the defaults
    // are wired and that a caller contributing no policy still gets a verdict.
    const verdict = await runUpdateGate({
      cacheFs: new Volume(),
      home: HOME,
      processEnv: {},
      stdout: makeStream(),
      stderr: makeStream(),
    })
    expect(Object.keys(verdict).sort()).toEqual(VERDICT_KEYS)
    expect(verdict).toMatchObject({ isNewer: false, prompted: false, installed: false })
  })
})
