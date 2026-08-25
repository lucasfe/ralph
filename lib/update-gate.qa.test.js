import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Volume } from 'memfs'
import {
  existsSync as realExistsSync,
  mkdtempSync,
  readFileSync as realReadFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runUpdateGate } from './update-gate.js'
import { readVersionCache, versionCachePath } from './version-cache.js'
import { recordPromptShown, resolveUpdateDecision } from './update-check.js'

// #50 QA augmentation — the extracted update gate. lib/update-gate.test.js (the
// dev's file) proves the contract on well-formed inputs: the verdict, the notice,
// the TTY gate, the stamp ordering, the never-throws boundaries. This file attacks
// the edges around it and nothing it already covers:
//
//   - the VERDICT AS A TOTAL CONTRACT: one table walking every path, asserting the
//     six keys, that no key is ever `undefined`, that the four flags are strictly
//     booleans (not truthy values that leaked through from a seam), and the
//     implication chain installed → accepted → prompted → isNewer;
//   - MALFORMED decisions: missing keys, `isNewer:true` with a null/number/object
//     `latestVersion` and how each renders in the notice, truthy non-boolean flags,
//     a decision that is a primitive, and a decision whose GETTER throws;
//   - hostile `runUpdate` RESULTS: `{updated:'yes'}`, `{updated:true,to:null}`,
//     `{updated:true,to:''}`, `{to:…}` with no `updated`, primitives, and a
//     non-callable seam;
//   - the ANSWER COERCION: `Boolean(await ask(...))` means every truthy answer is an
//     accept — including the string 'no' — and every falsy one a decline;
//   - the NON-TTY guarantee, adversarially: an stdin whose every listener method is
//     a tripwire, proving no readline is constructed over it AND that the gate
//     itself never touches the stream even on the prompting path;
//   - ORDERING: the install waits for the answer; the stamp lands once, never
//     without a question; a SYNCHRONOUSLY throwing `ask` escapes with the window
//     already burned (the dev pins the rejecting variant);
//   - the REAL `resolveUpdateDecision`/`recordPromptShown` at their own boundaries:
//     the weekly window burned and reopened across three runs, XDG_CONFIG_HOME
//     honored end-to-end, a non-string `home`, a truthy non-string XDG_CONFIG_HOME,
//     the opt-out's negative values, clock skew, a corrupt cache;
//   - a broken `exec` — throwing, resolving junk, timing out, not a function;
//   - the UNGUARDED boundaries, pinned and not endorsed: `ask` and `stdout.write`
//     (identical to the caller's own `out`), both named in the module header;
//   - the zero-argument call, where every default is the production one.
//
// Hermeticity (#41): every test injects `processEnv`, `home` and a memfs `cacheFs`,
// and `exec` is injected so no registry query can leave the process. `isTTY` is
// passed EXPLICITLY wherever a prompt is expected — it is undefined on a vitest
// worker's stdin, so a defaulted gate never prompts and such a test would be
// vacuous. The single zero-argument test opts in the documented way instead: it
// points `process.env.XDG_CONFIG_HOME` at a throwaway directory it creates and
// removes, so the real defaults are exercised without writing anywhere else. The
// beforeAll/afterAll tripwire below proves the whole file leaves this machine's
// own update-check cache byte-identical.

const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const NPM_VIEW = 'npm view @lucasfe/ralph version'
const PROMPT = 'Update now? [y/N]: '
const NOTICE = 'New version available'
const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()

// The cache path this machine would really use (the #41 HOME sandbox). Nothing in
// this file may change it — not even the zero-argument test.
const REAL_CACHE_PATH = versionCachePath()
const realCacheSnapshot = () =>
  realExistsSync(REAL_CACHE_PATH) ? realReadFileSync(REAL_CACHE_PATH, 'utf8') : null
let realBefore
beforeAll(() => {
  realBefore = realCacheSnapshot()
})
afterAll(() => {
  expect(realCacheSnapshot()).toBe(realBefore)
})

// picocolors may or may not emit escapes depending on the ambient environment, so
// every message assertion runs on stripped text.
const strip = (s) => String(s).replace(/\u001B\[[0-9;]*m/g, '')

function makeStream(timeline = [], tag = 'out') {
  const chunks = []
  const stream = {
    write: (s) => {
      chunks.push(s)
      timeline.push(`${tag}:${strip(String(s)).trim()}`)
      return true
    },
    writes: () => chunks.slice(),
    output: () => strip(chunks.join('')),
  }
  return stream
}

// Matched on cmd/args rather than exact key strings, the same idiom as the rest of
// the update suites, so a flag tweak cannot silently defuse an assertion into
// vacuous truth. `npm` may be a value or a function (for a throwing exec).
function makeExec({ npm } = {}, timeline = []) {
  const calls = []
  const exec = async (cmd, args = [], opts) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    timeline.push(`exec:${key}`)
    if (cmd === 'npm' && args[0] === 'view') {
      if (typeof npm === 'function') return npm({ cmd, args, opts })
      return npm ?? { exitCode: 0, stdout: '0.2.0\n', stderr: '', timedOut: false }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  exec.npmViews = () => calls.filter((c) => c === NPM_VIEW)
  return exec
}

// `reply` may be a value (resolved) or a function (called for its raw return — used
// for non-promise returns, throws and never-settling prompts). Rest args, not a
// default parameter: makeAsk(undefined) must mean "resolve undefined", which a
// `reply = true` default would silently turn into an accept.
function makeAsk(...rest) {
  const reply = rest.length ? rest[0] : true
  const calls = []
  const ask = (question, options) => {
    calls.push({ question, options })
    return typeof reply === 'function' ? reply(question, options) : Promise.resolve(reply)
  }
  ask.calls = calls
  return ask
}

// An `ask` that must never run. Used wherever the assertion is "no question was
// put to anybody" — a spy count alone would still pass if the call happened and
// its answer was ignored.
function tripwireAsk() {
  return makeAsk(() => {
    throw new Error('the gate asked a question it must never have asked')
  })
}

const OK_UPDATE = { exitCode: 0, updated: true, from: '0.1.0', to: '0.2.0' }

function makeRunUpdate(...rest) {
  const result = rest.length ? rest[0] : OK_UPDATE
  const calls = []
  const fn = (bag) => {
    calls.push(bag)
    return typeof result === 'function' ? result(bag) : Promise.resolve(result)
  }
  fn.calls = calls
  return fn
}

// A stdin whose every readline-relevant method is a tripwire: `touched` stays empty
// unless something tried to drive the stream. Property READS (the gate's own
// `stdin?.isTTY`) are deliberately not recorded — deriving the TTY flag is the one
// thing the gate is supposed to do with it.
function tripwireStdin({ isTTY } = {}) {
  const touched = []
  const stdin = { isTTY, marker: 'tripwire-stdin', touched }
  for (const method of [
    'on',
    'once',
    'off',
    'addListener',
    'removeListener',
    'prependListener',
    'removeAllListeners',
    'emit',
    'read',
    'resume',
    'pause',
    'pipe',
    'unpipe',
    'setEncoding',
    'setRawMode',
    'destroy',
    'end',
  ]) {
    stdin[method] = (...callArgs) => {
      touched.push(`${method}(${callArgs.length})`)
      return stdin
    }
  }
  return stdin
}

// One argument bag, with every seam call recorded on ONE timeline so orderings are
// read off a single sequence. The `update`/`recordPrompt` wrappers delegate to the
// REAL implementations unless overridden, so the cache assertions are about
// production behaviour.
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

// Waits for a condition the gate reaches asynchronously (the decision awaits the
// registry query before the question is put), bounded so a regression fails the
// assertion instead of hanging the suite.
async function until(predicate, { timeoutMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

const cacheOf = (fs, processEnv = {}) => readVersionCache({ fs, home: HOME, processEnv })
const seededCache = (cache, path = CACHE_PATH) =>
  Volume.fromJSON({ [path]: JSON.stringify(cache) }, '/')
const rawSeed = (raw, path = CACHE_PATH) => Volume.fromJSON({ [path]: raw }, '/')

const VERDICT_KEYS = [
  'accepted',
  'installed',
  'installedVersion',
  'isNewer',
  'latestVersion',
  'prompted',
]

// The verdict's shape as a CONTRACT rather than as a value: whatever a seam did,
// a caller can read all six keys, branch on four real booleans, and trust that an
// installedVersion is only ever present when an install actually landed. The
// implication chain is what makes `if (verdict.installed)` safe as the caller's
// first branch — it cannot be true on a run that never asked.
function expectTotalVerdict(verdict) {
  expect(verdict, 'the gate must resolve to a verdict object').toBeTypeOf('object')
  expect(verdict).not.toBeNull()
  expect(Object.keys(verdict).sort()).toEqual(VERDICT_KEYS)
  for (const key of VERDICT_KEYS) {
    expect(verdict[key], `${key} must never be undefined`).not.toBeUndefined()
  }
  for (const key of ['isNewer', 'prompted', 'accepted', 'installed']) {
    expect(typeof verdict[key], `${key} must be a real boolean`).toBe('boolean')
  }
  if (verdict.installed) expect(verdict.accepted, 'installed implies accepted').toBe(true)
  if (verdict.accepted) expect(verdict.prompted, 'accepted implies prompted').toBe(true)
  if (verdict.prompted) expect(verdict.isNewer, 'prompted implies isNewer').toBe(true)
  if (!verdict.installed) {
    expect(verdict.installedVersion, 'no install means no installedVersion').toBeNull()
  }
}

describe('runUpdateGate — the verdict is total on every path', () => {
  // One case per branch of the gate, each asserting the whole contract rather than
  // the one field it is about. A future branch that forgets a key fails here even
  // if its own test only looks at `installed`.
  const CASES = [
    ['nothing newer', { currentVersion: '0.2.0' }, { isNewer: false, latestVersion: '0.2.0' }],
    [
      'the RALPH_NO_UPDATE_CHECK opt-out',
      { processEnv: { RALPH_NO_UPDATE_CHECK: '1' } },
      { isNewer: false, latestVersion: null },
    ],
    [
      'a rejecting decision seam',
      { update: async () => Promise.reject(new Error('decision exploded')) },
      { isNewer: false, latestVersion: null },
    ],
    [
      'a decision with no keys at all',
      { update: async () => ({}) },
      { isNewer: false, latestVersion: null },
    ],
    [
      'a closed prompt window',
      {
        cacheFs: seededCache({
          last_check_at: iso(T0 - DAY),
          last_prompted_at: iso(T0 - 2 * DAY),
          latest_version: '0.2.0',
        }),
      },
      { isNewer: true, latestVersion: '0.2.0', prompted: false },
    ],
    ['a non-TTY run', { isTTY: false }, { isNewer: true, prompted: false }],
    ['a declined question', { ask: makeAsk(false) }, { prompted: true, accepted: false }],
    [
      'an accepted install that failed',
      { runUpdate: makeRunUpdate({ exitCode: 1, updated: false, to: '0.2.0' }) },
      { accepted: true, installed: false },
    ],
    [
      'an accepted install that returned nothing',
      { runUpdate: makeRunUpdate(undefined) },
      { accepted: true, installed: false },
    ],
    [
      'a completed install',
      {},
      { installed: true, installedVersion: '0.2.0', accepted: true, prompted: true },
    ],
  ]

  for (const [label, overrides, expected] of CASES) {
    it(`answers all six questions on ${label}`, async () => {
      const a = args(overrides)
      const verdict = await runUpdateGate(a)
      expectTotalVerdict(verdict)
      expect(verdict).toMatchObject(expected)
      // Not one line on stderr, on any path: the gate's only output is the notice.
      expect(a.stderr.output()).toBe('')
    })
  }

  it('writes the notice as ONE write ending in a single newline', async () => {
    // The repo's one-write-per-line convention: a caller that counts writes (or a
    // stream that flushes per write) must not see the notice split or doubled.
    const a = args()
    await runUpdateGate(a)
    const writes = a.stdout.writes()
    expect(writes).toHaveLength(1)
    expect(writes[0].endsWith('\n')).toBe(true)
    expect(writes[0].slice(0, -1)).not.toContain('\n')
  })

  it('gives each call its own verdict object', async () => {
    const first = await runUpdateGate(args())
    const second = await runUpdateGate(args({ currentVersion: '0.2.0' }))
    expect(first).not.toBe(second)
    first.installed = 'mutated'
    expect(second.installed).toBe(false)
  })
})

describe('runUpdateGate — malformed decisions', () => {
  // The gate trusts `isNewer` and prints `latestVersion` verbatim; validating semver
  // is resolveUpdateDecision's job (isNewer is only ever true there for a version
  // that passed isValidSemver). These pin what the gate does with a decision the
  // real one cannot produce, so a future seam — `ralph cycle`'s, or a stub — cannot
  // change it silently.
  it('prints a null latestVersion verbatim when a decision claims isNewer anyway', async () => {
    const a = args({ update: async () => ({ isNewer: true, latestVersion: null, shouldPrompt: false }) })
    const verdict = await runUpdateGate(a)
    expectTotalVerdict(verdict)
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: null, prompted: false })
    // PINNED, not endorsed: unreachable through the real decision, and identical to
    // the pre-extraction block. Worth knowing it reads "null" rather than throwing.
    expect(a.stdout.output()).toContain(`${NOTICE}: null`)
  })

  it('carries a non-string latestVersion through to the notice and the verdict', async () => {
    const a = args({ update: async () => ({ isNewer: true, latestVersion: 42, shouldPrompt: false }) })
    const verdict = await runUpdateGate(a)
    expect(verdict.latestVersion).toBe(42)
    expect(a.stdout.output()).toContain(`${NOTICE}: 42`)
  })

  it('renders a weird-but-truthy latestVersion through String interpolation', async () => {
    const latestVersion = { toString: () => '9.9.9' }
    const a = args({ update: async () => ({ isNewer: true, latestVersion, shouldPrompt: false }) })
    const verdict = await runUpdateGate(a)
    expect(a.stdout.output()).toContain(`${NOTICE}: 9.9.9`)
    expect(verdict.latestVersion).toBe(latestVersion)
  })

  it('treats truthy non-boolean decision flags as true', async () => {
    const a = args({
      update: async () => ({ isNewer: 'yes', latestVersion: '0.2.0', shouldPrompt: 1 }),
    })
    const verdict = await runUpdateGate(a)
    expectTotalVerdict(verdict)
    expect(verdict).toMatchObject({ isNewer: true, prompted: true, accepted: true })
    expect(a.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })

  for (const [label, decision] of [
    ['a number', 42],
    ['an array', []],
    ['a boolean', true],
    ['a decision with isNewer false but a version', { isNewer: false, latestVersion: '9.9.9' }],
  ]) {
    it(`prints nothing and asks nothing when the decision is ${label}`, async () => {
      const a = args({ update: async () => decision, ask: tripwireAsk() })
      const verdict = await runUpdateGate(a)
      expectTotalVerdict(verdict)
      expect(verdict.isNewer).toBe(false)
      expect(a.stdout.output()).toBe('')
      expect(a.stampCalls).toHaveLength(0)
    })
  }

  it('keeps the never-throws promise when a decision PROPERTY getter throws', async () => {
    // The decision CALL and all three READS of its result sit inside one try, so a
    // property getter — which can throw exactly as easily as the call can — cannot
    // escape as a stack trace. The catch resets all three locals, so a getter that
    // throws part way through leaves no half-read decision for the gate to act on:
    // an unreadable decision is treated as no decision, silent and total. This
    // guards the module header's central promise — never throws, with two
    // deliberate exceptions (`ask` and the notice write) — against the same class
    // of hostile input as the processEnv getter pinned above; an earlier revision
    // read these three outside the try and did escape here.
    const decision = { isNewer: true, shouldPrompt: true }
    Object.defineProperty(decision, 'latestVersion', {
      get() {
        throw new Error('hostile decision')
      },
    })
    const a = args({ update: async () => decision })
    const outcome = await runUpdateGate(a).catch((e) => e)
    expect(outcome, 'the decision boundary must not escape as a throw').not.toBeInstanceOf(Error)
    expectTotalVerdict(outcome)
  })
})

describe('runUpdateGate — hostile install results', () => {
  it('reports a truthy non-boolean `updated` as a real boolean install', async () => {
    const a = args({ runUpdate: makeRunUpdate({ updated: 'yes' }) })
    const verdict = await runUpdateGate(a)
    expectTotalVerdict(verdict)
    expect(verdict.installed).toBe(true)
    expect(verdict.installedVersion).toBe('0.2.0')
  })

  it('falls back to the notice’s version when a successful install reports `to: null`', async () => {
    const a = args({ runUpdate: makeRunUpdate({ updated: true, to: null }) })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ installed: true, installedVersion: '0.2.0' })
  })

  it('keeps an EMPTY `to` instead of falling back', async () => {
    // PINNED, not endorsed: `??` guards null/undefined only, so an empty string
    // survives and the caller would print "✅ Updated to  — run `ralph start`
    // again." Unreachable through the real updateCommand (`to` is the semver it
    // just validated) and identical to the pre-extraction expression, so this is a
    // documented edge rather than a regression.
    const a = args({ runUpdate: makeRunUpdate({ updated: true, to: '' }) })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ installed: true, installedVersion: '' })
  })

  for (const [label, result] of [
    ['`to` with no `updated` at all', { to: '0.3.0' }],
    ['`updated: 0`', { updated: 0, to: '0.3.0' }],
    ['`updated: null`', { updated: null, to: '0.3.0' }],
    ['`updated: ""`', { updated: '', to: '0.3.0' }],
    ['a number', 7],
    ['an array', []],
    ['a boolean true', true],
  ]) {
    it(`reports no install when runUpdate returns ${label}`, async () => {
      const a = args({ runUpdate: makeRunUpdate(result) })
      const verdict = await runUpdateGate(a)
      expectTotalVerdict(verdict)
      expect(verdict).toMatchObject({ accepted: true, installed: false, installedVersion: null })
      expect(a.stderr.output()).toBe('')
    })
  }

  it('survives a runUpdate seam that is not callable at all', async () => {
    // Assigned past the harness so the null reaches the gate (a destructuring
    // default only fires on undefined): the CALL is what throws, and the install
    // boundary swallows it like any other failed install.
    const a = args()
    a.runUpdate = null
    const verdict = await runUpdateGate(a)
    expectTotalVerdict(verdict)
    expect(verdict).toMatchObject({ accepted: true, installed: false })
    expect(a.stderr.output()).toBe('')
  })

  it('survives a runUpdate whose thenable throws on await', async () => {
    const hostile = {
      then() {
        throw new Error('hostile thenable')
      },
    }
    const a = args({ runUpdate: makeRunUpdate(() => hostile) })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ accepted: true, installed: false })
  })
})

describe('runUpdateGate — the answer is coerced, never trusted', () => {
  // `accepted = Boolean(await ask(...))`. The real `confirm` resolves a boolean, so
  // the coercion is a safety net; what these pin is that the net is TOTAL — a seam
  // can hand back anything and the verdict still carries a real boolean, and the
  // install runs on exactly the truthy half.
  for (const [label, reply] of [
    ['true', true],
    ['the string "y"', 'y'],
    ['the string "no"', 'no'],
    ['1', 1],
    ['an object', {}],
    ['an array', []],
  ]) {
    it(`installs on a truthy answer: ${label}`, async () => {
      const a = args({ ask: makeAsk(reply) })
      const verdict = await runUpdateGate(a)
      expectTotalVerdict(verdict)
      expect(verdict.accepted).toBe(true)
      expect(a.runUpdate.calls).toHaveLength(1)
    })
  }

  for (const [label, reply] of [
    ['false', false],
    ['undefined', undefined],
    ['null', null],
    ['0', 0],
    ['the empty string', ''],
    ['NaN', NaN],
  ]) {
    it(`declines on a falsy answer: ${label}`, async () => {
      const a = args({ ask: makeAsk(reply) })
      const verdict = await runUpdateGate(a)
      expectTotalVerdict(verdict)
      expect(verdict).toMatchObject({ prompted: true, accepted: false, installedVersion: null })
      expect(a.runUpdate.calls).toHaveLength(0)
    })
  }

  it('accepts a SYNCHRONOUS (non-promise) answer', async () => {
    const a = args({ ask: makeAsk(() => true) })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ accepted: true, installed: true })
  })

  it('accepts a thenable that is not a native promise', async () => {
    const a = args({ ask: makeAsk(() => ({ then: (resolve) => resolve('y') })) })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ accepted: true, installed: true })
  })
})

describe('runUpdateGate — a non-interactive run never touches stdin', () => {
  // `confirm` never resolves on an input that ends without a line, so a readline on
  // a non-interactive stdin is an unrecoverable HANG. A spy count on `ask` proves
  // the question was not asked; these prove the STREAM was not even driven, which
  // is what a readline would have to do first.
  it('drives no listener on the stream and asks nothing when isTTY is derived false', async () => {
    const stdin = tripwireStdin({ isTTY: false })
    const a = args({ stdin, ask: tripwireAsk() })
    delete a.isTTY
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ isNewer: true, prompted: false, accepted: false })
    expect(stdin.touched).toEqual([])
    expect(a.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    expect(a.stdout.output()).not.toContain(PROMPT)
  })

  it('drives no listener on a TTY-looking stream when isTTY is explicitly false', async () => {
    const stdin = tripwireStdin({ isTTY: true })
    const a = args({ stdin, isTTY: false, ask: tripwireAsk() })
    const verdict = await runUpdateGate(a)
    expect(verdict.prompted).toBe(false)
    expect(stdin.touched).toEqual([])
  })

  it('does not touch the stream even on the PROMPTING path — only `ask` may', async () => {
    // The gate hands the stream to `ask` and does nothing else with it: no
    // setRawMode, no listener, no read. Whatever the prompt implementation is, the
    // gate contributes no state of its own to stdin.
    const stdin = tripwireStdin({ isTTY: true })
    const a = args({ stdin })
    delete a.isTTY
    const verdict = await runUpdateGate(a)
    expect(verdict.prompted).toBe(true)
    expect(a.ask.calls[0].options.input).toBe(stdin)
    expect(stdin.touched).toEqual([])
  })

  for (const [label, stdin] of [
    ['null', null],
    ['a number', 42],
    ['a string', 'not-a-stream'],
    ['a bare object', {}],
    ['a stream with isTTY undefined', { marker: 'no-isTTY' }],
  ]) {
    it(`prompts nothing and crashes on nothing when stdin is ${label}`, async () => {
      const a = args({ stdin, ask: tripwireAsk() })
      delete a.isTTY
      const verdict = await runUpdateGate(a)
      expectTotalVerdict(verdict)
      expect(verdict).toMatchObject({ isNewer: true, prompted: false })
      expect(a.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    })
  }

  it('leaves the prompt window unburned on a non-TTY run, with the REAL stamp', async () => {
    const a = args({ isTTY: false, ask: tripwireAsk() })
    await runUpdateGate(a)
    expect(a.stampCalls).toHaveLength(0)
    expect(cacheOf(a.cacheFs).last_prompted_at).toBeNull()
  })

  it('treats an explicitly null isTTY as non-interactive, TTY stdin or not', async () => {
    // A destructuring default only fires on undefined, so `isTTY: null` is a
    // caller saying "not a TTY" — it does NOT fall back to the stdin-derived
    // default. Pinned because the opposite guess (null means "you decide") is the
    // natural one, and the safe answer is the one the gate gives.
    const a = args({ isTTY: null, stdin: tripwireStdin({ isTTY: true }), ask: tripwireAsk() })
    const verdict = await runUpdateGate(a)
    expect(verdict.prompted).toBe(false)
    expect(a.stdin.touched).toEqual([])
  })

  it('prompts on a truthy non-boolean isTTY', async () => {
    const a = args({ isTTY: 1, stdin: { isTTY: false, marker: 'piped' } })
    const verdict = await runUpdateGate(a)
    expect(verdict.prompted).toBe(true)
    // The explicit flag wins over the stream, which is what makes the derivation a
    // DEFAULT rather than a guard: a caller that passes isTTY itself owns the
    // hang risk. startCommand derives its own from the same resolved stdin.
    expect(a.ask.calls[0].options.input).toBe(a.stdin)
  })
})

describe('runUpdateGate — ordering around the question', () => {
  it('does not start the install until the answer resolves', async () => {
    let answer
    const a = args({ ask: makeAsk(() => new Promise((resolve) => (answer = resolve))) })
    const running = runUpdateGate(a)
    await until(() => a.ask.calls.length === 1)
    expect(a.ask.calls).toHaveLength(1)
    expect(a.runUpdate.calls, 'the install must wait for the human').toHaveLength(0)
    answer(true)
    const verdict = await running
    expect(verdict).toMatchObject({ accepted: true, installed: true })
    expect(a.runUpdate.calls).toHaveLength(1)
  })

  it('stamps exactly once, before the question, on the accept path', async () => {
    const a = args()
    await runUpdateGate(a)
    expect(a.stampCalls).toHaveLength(1)
    expect(a.at('stamp')).toBeLessThan(a.at('ask'))
    expect(a.timeline.filter((e) => e === 'stamp')).toHaveLength(1)
  })

  it('lets a SYNCHRONOUSLY throwing ask escape, with the window already burned', async () => {
    // The dev's suite pins the rejecting variant; a sync throw takes a different
    // path out of `Boolean(await ask(...))` and must behave identically — escape,
    // stamp already written, no install.
    const boom = new Error('readline exploded synchronously')
    const a = args({
      ask: makeAsk(() => {
        throw boom
      }),
    })
    await expect(runUpdateGate(a)).rejects.toBe(boom)
    expect(cacheOf(a.cacheFs).last_prompted_at).toBe(iso(T0))
    expect(a.runUpdate.calls).toHaveLength(0)
  })

  it('never stamps a window it did not open — closed prompt window, real stamp', async () => {
    const a = args({
      cacheFs: seededCache({
        last_check_at: iso(T0 - DAY),
        last_prompted_at: iso(T0 - DAY),
        latest_version: '0.2.0',
      }),
      ask: tripwireAsk(),
    })
    await runUpdateGate(a)
    expect(a.stampCalls).toHaveLength(0)
    expect(cacheOf(a.cacheFs).last_prompted_at).toBe(iso(T0 - DAY))
  })
})

describe('runUpdateGate — the real decision and stamp at their own boundaries', () => {
  it('burns the prompt window and reopens it a week later, across three runs', async () => {
    const cacheFs = new Volume()
    const first = args({ cacheFs })
    expect(await runUpdateGate(first)).toMatchObject({ prompted: true, installed: true })
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))

    // A minute later: the notice still prints (from the cached version, no second
    // registry query), the question does not.
    const second = args({ cacheFs, now: () => T0 + 60_000, ask: tripwireAsk() })
    const secondVerdict = await runUpdateGate(second)
    expect(secondVerdict).toMatchObject({ isNewer: true, latestVersion: '0.2.0', prompted: false })
    expect(second.exec.npmViews()).toHaveLength(0)
    expect(second.stdout.output()).toContain(`${NOTICE}: 0.2.0`)

    // Eight days later: both windows are open again.
    const third = args({ cacheFs, now: () => T0 + 8 * DAY })
    expect(await runUpdateGate(third)).toMatchObject({ prompted: true })
    expect(third.exec.npmViews()).toHaveLength(1)
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0 + 8 * DAY))
  })

  it('resolves the cache through an injected XDG_CONFIG_HOME, not through home', async () => {
    const processEnv = { XDG_CONFIG_HOME: '/xdg' }
    const cacheFs = new Volume()
    const a = args({ processEnv, cacheFs })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ prompted: true, installed: true })
    const written = Object.keys(cacheFs.toJSON())
    expect(written).toEqual([join('/xdg', 'ralph', 'update-check.json')])
    expect(cacheOf(cacheFs, processEnv).last_prompted_at).toBe(iso(T0))
  })

  for (const [label, home] of [
    ['a number', 42],
    ['null', null],
    ['an object', {}],
  ]) {
    it(`still returns a verdict when home is ${label}`, async () => {
      // versionCachePath() runs in readVersionCache's default parameter, ahead of
      // its own try blocks, so a non-string home throws a TypeError out of
      // join()/trim(). Both the decision and the stamp guard that boundary; the
      // gate's job is only to keep going, which means: notice, question, install.
      const a = args({ home })
      const verdict = await runUpdateGate(a)
      expectTotalVerdict(verdict)
      expect(verdict).toMatchObject({ isNewer: true, prompted: true, installed: true })
      expect(Object.keys(a.cacheFs.toJSON())).toEqual([])
      expect(a.stderr.output()).toBe('')
    })
  }

  it('still returns a verdict on a truthy non-string XDG_CONFIG_HOME', async () => {
    const a = args({ processEnv: { XDG_CONFIG_HOME: 42 } })
    const verdict = await runUpdateGate(a)
    expectTotalVerdict(verdict)
    expect(verdict).toMatchObject({ isNewer: true, prompted: true })
    expect(Object.keys(a.cacheFs.toJSON())).toEqual([])
  })

  for (const [label, value, disabled] of [
    ['1', '1', true],
    ['yes', 'yes', true],
    ['  TRUE  ', '  TRUE  ', true],
    ['0', '0', false],
    ['false', 'false', false],
    ['FALSE', 'FALSE', false],
    ['the empty string', '', false],
  ]) {
    it(`${disabled ? 'skips' : 'runs'} the whole gate on RALPH_NO_UPDATE_CHECK=${label}`, async () => {
      // The opt-out's negative values are update-check's contract, asserted HERE
      // through the gate because the gate is what a user experiences: `=0` must
      // still print the notice, `=yes` must print nothing.
      const a = args({
        processEnv: { RALPH_NO_UPDATE_CHECK: value },
        ask: disabled ? tripwireAsk() : makeAsk(false),
      })
      const verdict = await runUpdateGate(a)
      expectTotalVerdict(verdict)
      expect(verdict.isNewer).toBe(!disabled)
      expect(a.exec.npmViews()).toHaveLength(disabled ? 0 : 1)
      if (disabled) {
        expect(a.stdout.output()).toBe('')
        expect(Object.keys(a.cacheFs.toJSON())).toEqual([])
      } else {
        expect(a.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
        expect(verdict.prompted).toBe(true)
      }
    })
  }

  it('prompts through clock skew — a last_prompted_at in the FUTURE is not a closed window', async () => {
    const a = args({
      cacheFs: seededCache({
        last_check_at: iso(T0 - DAY),
        last_prompted_at: iso(T0 + 30 * DAY),
        latest_version: '0.2.0',
      }),
    })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ isNewer: true, prompted: true })
    expect(cacheOf(a.cacheFs).last_prompted_at).toBe(iso(T0))
  })

  for (const [label, raw] of [
    ['not JSON at all', 'not json {'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON string', '"nope"'],
    ['null', 'null'],
    ['fields of the wrong type', '{"last_check_at":5,"last_prompted_at":{},"latest_version":[]}'],
  ]) {
    it(`treats a cache that is ${label} as absent`, async () => {
      const a = args({ cacheFs: rawSeed(raw) })
      const verdict = await runUpdateGate(a)
      expectTotalVerdict(verdict)
      expect(verdict).toMatchObject({ isNewer: true, latestVersion: '0.2.0', prompted: true })
      expect(a.exec.npmViews()).toHaveLength(1)
      expect(cacheOf(a.cacheFs)).toMatchObject({
        last_check_at: iso(T0),
        last_prompted_at: iso(T0),
        latest_version: '0.2.0',
      })
    })
  }

  for (const [label, currentVersion] of [
    ['the default "unknown"', undefined],
    ['null', null],
    ['the empty string', ''],
    ['a v-prefixed tag', 'v0.1.0'],
    ['a two-part version', '0.1'],
  ]) {
    it(`offers nothing when the running version is ${label}`, async () => {
      // isNewer needs BOTH sides to be valid semver, so an unidentifiable current
      // version means no notice and no question — never a blind "0.2.0 is newer
      // than nothing". A user in that state is on an npx or dev copy that
      // `ralph update` would refuse to touch anyway.
      const a = args({ ask: tripwireAsk() })
      if (currentVersion === undefined) delete a.currentVersion
      else a.currentVersion = currentVersion
      const verdict = await runUpdateGate(a)
      expectTotalVerdict(verdict)
      expect(verdict).toMatchObject({ isNewer: false, latestVersion: '0.2.0' })
      expect(a.stdout.output()).toBe('')
    })
  }
})

describe('runUpdateGate — a broken exec never costs the run', () => {
  const BROKEN = [
    [
      'throws synchronously',
      () => {
        throw new Error('spawn ENOENT')
      },
    ],
    ['rejects', () => Promise.reject(new Error('npm exploded'))],
    ['resolves undefined', () => undefined],
    ['resolves a non-semver stdout', () => ({ exitCode: 0, stdout: 'not-a-version', stderr: '' })],
    ['times out', () => ({ exitCode: 0, stdout: '0.2.0', stderr: '', timedOut: true })],
    ['exits non-zero', () => ({ exitCode: 7, stdout: '', stderr: 'boom' })],
  ]

  for (const [label, npm] of BROKEN) {
    it(`returns a silent verdict when the registry query ${label}`, async () => {
      const a = args({ execOptions: { npm }, ask: tripwireAsk() })
      const verdict = await runUpdateGate(a)
      expectTotalVerdict(verdict)
      expect(verdict).toMatchObject({ isNewer: false, latestVersion: null })
      expect(a.stdout.output()).toBe('')
      expect(a.stderr.output()).toBe('')
      // The failed query still closes the network window: retrying on every run is
      // most useless exactly when the network is broken.
      expect(cacheOf(a.cacheFs).last_check_at).toBe(iso(T0))
    })

    it(`still serves the cached version when the registry query ${label}`, async () => {
      const a = args({
        execOptions: { npm },
        cacheFs: seededCache({
          last_check_at: iso(T0 - 30 * DAY),
          last_prompted_at: null,
          latest_version: '0.2.0',
        }),
      })
      const verdict = await runUpdateGate(a)
      expect(verdict).toMatchObject({ isNewer: true, latestVersion: '0.2.0', prompted: true })
      expect(a.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
      expect(cacheOf(a.cacheFs).latest_version).toBe('0.2.0')
    })
  }

  for (const [label, exec] of [
    ['missing', undefined],
    ['not a function', 'npm'],
    ['null', null],
  ]) {
    it(`returns a verdict when exec is ${label}`, async () => {
      const a = args({ ask: tripwireAsk() })
      if (exec === undefined) delete a.exec
      else a.exec = exec
      const verdict = await runUpdateGate(a)
      expectTotalVerdict(verdict)
      expect(verdict.isNewer).toBe(false)
      expect(a.stdout.output()).toBe('')
    })
  }

  it('forwards the very same broken exec to the install it was accepted for', async () => {
    // The install path gets the caller's exec verbatim — the gate never substitutes
    // a working one for a failed decision, so updateCommand reports the real
    // failure rather than the gate inventing a success.
    const a = args({
      execOptions: {
        npm: () => ({ exitCode: 0, stdout: '0.2.0\n', stderr: '', timedOut: false }),
      },
    })
    await runUpdateGate(a)
    expect(a.runUpdate.calls[0].exec).toBe(a.exec)
  })
})

describe('runUpdateGate — the unguarded boundaries, pinned not endorsed', () => {
  it('lets a throwing stdout escape', async () => {
    // The notice write is NOT wrapped, exactly like startCommand's own `out`: a
    // process whose stdout throws loses the run either way, and the alternative —
    // swallowing it — would hide a broken terminal behind a silent success. Pinned
    // so the choice is visible; if it ever needs to change, change it here first.
    const boom = new Error('EPIPE')
    const a = args({
      stdout: {
        write() {
          throw boom
        },
      },
    })
    await expect(runUpdateGate(a)).rejects.toBe(boom)
    expect(a.runUpdate.calls).toHaveLength(0)
  })

  it('never writes to stderr, so a throwing stderr cannot break a run', async () => {
    const a = args({
      stderr: {
        write() {
          throw new Error('stderr is closed')
        },
      },
    })
    const verdict = await runUpdateGate(a)
    expect(verdict).toMatchObject({ installed: true, installedVersion: '0.2.0' })
    // It is still handed to the install, which owns its own diagnostics.
    expect(a.runUpdate.calls[0].stderr).toBe(a.stderr)
  })

  it('lets a non-callable ask escape, like a throwing one', async () => {
    const a = args()
    a.ask = null
    await expect(runUpdateGate(a)).rejects.toThrow(TypeError)
    // The window was burned before the call, which is the documented order.
    expect(cacheOf(a.cacheFs).last_prompted_at).toBe(iso(T0))
  })
})

describe('runUpdateGate — the production defaults', () => {
  // The one place the REAL defaults for home/processEnv/stdout/fs are exercised.
  // Hermetic by opt-in rather than by injection: XDG_CONFIG_HOME is pointed at a
  // throwaway directory this test creates and removes, so `processEnv =
  // process.env` resolves the cache there instead of at the worker's HOME sandbox
  // (the beforeAll/afterAll tripwire proves that file never changes). No exec is
  // passed, and fetchLatestVersion answers a missing exec with null rather than a
  // throw, so nothing reaches the network.
  let xdg
  beforeAll(() => {
    xdg = mkdtempSync(join(tmpdir(), 'ralph-gate-qa-'))
  })
  afterAll(() => {
    rmSync(xdg, { recursive: true, force: true })
  })

  for (const [label, call] of [
    ['no argument at all', () => runUpdateGate()],
    ['an empty bag', () => runUpdateGate({})],
  ]) {
    it(`returns a verdict with ${label}`, async () => {
      process.env.XDG_CONFIG_HOME = xdg
      const verdict = await call()
      expectTotalVerdict(verdict)
      expect(verdict).toEqual({
        isNewer: false,
        latestVersion: null,
        prompted: false,
        accepted: false,
        installed: false,
        installedVersion: null,
      })
      // Proof the defaults are the production ones: the real cache writer ran, at
      // the real resolved path, with the real fs.
      const written = join(xdg, 'ralph', 'update-check.json')
      expect(realExistsSync(written)).toBe(true)
      expect(JSON.parse(realReadFileSync(written, 'utf8'))).toMatchObject({
        last_prompted_at: null,
        latest_version: null,
      })
    })
  }
})
