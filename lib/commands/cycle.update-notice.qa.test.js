import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { cycleCommand } from './cycle.js'
import { startCommand } from './start.js'
import { sessionNameFor } from '../lock.js'
import { summarizeLast24h } from '../heartbeat.js'
import { readVersionCache, versionCachePath } from '../version-cache.js'
import { UPDATE_CHECK_INTERVAL_MS } from '../update-check.js'

// #51 QA augmentation — the `ralph cycle` update-notice call site.
//
// The dev's cycle.update-notice.test.js proves the acceptance criteria on one
// happy timeline: the notice prints, it lands on stdout, it sits between
// acquireLock and the queue count, and a skipped or opted-out run spends nothing.
// This file attacks the seam between that gate and the DRAIN, which is the thing
// `ralph cycle` exists to do and the thing an unattended launchd run cannot be
// allowed to lose to a courtesy message:
//
//   - HOSTILE SEAMS: a decision that rejects, throws synchronously, is not
//     callable, returns a non-object, or whose property getters explode — every
//     one of them must leave a full drain behind (queue drained, metrics
//     aggregated, event emitted, WhatsApp summary sent, healthcheck pinged).
//   - THE LOCK: released exactly once on every outcome, including the ONE thing
//     the gate deliberately lets escape (the notice write), and including a
//     releaseLock that throws on top of it.
//   - PLACEMENT UNDER STRESS: the gate stays strictly between acquireLock and the
//     orphan sweep when the sweep throws, when orphans are cleared, in folder
//     task-source mode where no `gh` runs at all, and on the partial/failed drains.
//   - CHANNEL PARITY: the RALPH_CYCLE_EVENT payload keys are pinned per STATUS —
//     success, partial, failed, queue-empty, tmux-active, lock-held,
//     preflight-failed — and the notice text reaches neither WhatsApp nor stderr.
//   - THE CACHE AND THE ENV, adversarially: corrupt/truncated/hostile cache files,
//     a stamp in the future or unparseable, a cacheFs that throws on read, on
//     write, on mkdir or has no methods at all, a read-only volume, a `home` that
//     does not exist, XDG_CONFIG_HOME, and every documented value of
//     RALPH_NO_UPDATE_CHECK (`0`/`false`/empty keep the check ON — see
//     isUpdateCheckDisabled in ../update-check.js and the README table).
//   - THROTTLE MATH at the 7-day boundary, and the PROMPT window left unstamped:
//     a cycle never asked a human, so it must not burn the window the next
//     interactive `ralph start` needs — proven by running the two commands in turn.
//   - NO QUESTION WHEN UNATTENDED: every run here is handed a NON-INTERACTIVE
//     `stdin`, which is the launchd shape and the half of the gate this file owns
//     (#52 added the TTY half, in ./cycle.update-prompt.qa.test.js). A stdin that
//     reports isTTY and detonates on any stream access proves both directions of
//     the derivation: an injected non-interactive stream beats an ambient terminal,
//     and the ambient non-TTY stream launchd really supplies is read for `.isTTY`
//     and never opened — so no readline is ever constructed on this path.
//   - LOG INTEGRITY: the notice shares stdout with the RALPH_CYCLE_EVENT stream
//     that lib/heartbeat.js parses out of logs/ralph-cycle.out.log, so a hostile
//     cached version must not be able to forge a cycle in tomorrow's summary.
//
// Every seam is injected, `cacheFs` is memfs everywhere, and the beforeAll/afterAll
// pair asserts the developer's real ~/.config/ralph cache was never touched.

const REPO = '/repo'
const REPO_SLUG = 'lucasfe/ralph'
const SESSION = sessionNameFor(REPO)
const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const HEALTHCHECK_URL = 'https://hc-ping.com/x'

const NPM_VIEW = 'npm view @lucasfe/ralph version'
const NOTICE = 'New version available'
const NOTICE_LINE = 'New version available: 0.2.0 (run npm i -g @lucasfe/ralph to update)'
const QUESTION = 'Update now?'
const EVENT_TAG = 'RALPH_CYCLE_EVENT '

const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const WEEK = UPDATE_CHECK_INTERVAL_MS
const iso = (ms) => new Date(ms).toISOString()

// picocolors wraps the notice when the runner reports colour support, so every
// comparison is made with the escape codes stripped.
const strip = (s) => String(s).replace(/\[[0-9;]*m/g, '')

// Hermeticity net: no test in this file may reach the developer's real cache.
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

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(String(s))
      return true
    },
    chunks,
    output: () => strip(chunks.join('')),
    lines: () => strip(chunks.join('')).split('\n').filter(Boolean),
  }
}

function makeWa() {
  const messages = []
  const sendWa = async ({ message }) => {
    messages.push(message)
    return { ok: true }
  }
  sendWa.messages = messages
  return sendWa
}

function makePing() {
  const calls = []
  const fn = async (opts) => {
    calls.push(opts)
    return { ok: true }
  }
  fn.calls = calls
  return fn
}

// One exec for the whole cycle, matched on cmd/args rather than exact key strings
// so a search-query or flag tweak in cycle.js cannot silently defuse a test. Every
// spawn is appended to the shared timeline, which is what makes the placement
// assertions an ORDER and not a presence check.
function makeExec(
  {
    npm = { exitCode: 0, stdout: '0.2.0\n', stderr: '', timedOut: false },
    queue = '1',
    tmuxHasSession = 1,
    ghAuth = 0,
  } = {},
  timeline = [],
) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, options })
    timeline.push(`exec:${key}`)
    if (cmd === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: `${REPO}\n`, stderr: '' }
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: tmuxHasSession, stdout: '', stderr: '' }
    }
    if (cmd === 'npm' && args[0] === 'view') {
      return typeof npm === 'function' ? npm() : npm
    }
    if (cmd === 'gh' && args[0] === 'auth') return { exitCode: ghAuth, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'repo') return { exitCode: 0, stdout: `${REPO_SLUG}\n`, stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue' && args.includes('--search')) {
      return { exitCode: 0, stdout: String(queue), stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  exec.keys = () => calls.map((c) => c.key)
  exec.npmViews = () => exec.keys().filter((k) => k === NPM_VIEW)
  return exec
}

// One line of issues.jsonl per synthetic per-issue event, exactly as
// appendIssueEvent writes it — this is what makes the drain produce a real
// success/partial/failed status.
const issuesJsonl = (events) =>
  events.map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e)).join('\n') + '\n'

const METRICS = {
  none: '',
  allOk: issuesJsonl([
    { ts: T0, verdict: 'pass', issue_number: 1 },
    { ts: T0, verdict: 'pass', issue_number: 2 },
  ]),
  mixed: issuesJsonl([
    { ts: T0, verdict: 'pass', issue_number: 1 },
    { ts: T0, verdict: 'fail', issue_number: 9 },
  ]),
  allFailed: issuesJsonl([{ ts: T0, verdict: 'fail', issue_number: 9 }]),
}

// A full github-source cycle that acquires the lock and drains, with 0.2.0
// published and 0.1.0 installed. Lock, orphan sweep, folder count and drain all
// record themselves on the same timeline as the exec calls.
function deps(overrides = {}, execOptions = {}) {
  const timeline = []
  const stdout = makeStream()
  const stderr = makeStream()
  const sendWa = makeWa()
  const pingSuccess = makePing()
  const pingFail = makePing()
  const metrics = overrides.metrics ?? METRICS.none
  const d = {
    cwd: REPO,
    stdout,
    stderr,
    // #52 derives `isTTY` from the resolved `stdin`, so this file pins the launchd
    // shape on every run: a non-interactive stream, hence no question. It is also
    // what keeps these assertions independent of whatever stdin the test runner
    // hands the worker process. The TTY runs live in ./cycle.update-prompt.qa.test.js.
    stdin: { isTTY: false },
    exec: makeExec(execOptions, timeline),
    exists: () => true,
    // Keyed on the path: ralph.config.sh drives the task source / agent, and the
    // metrics file is what the drain's counts are aggregated from.
    readFile: (p) => (String(p).endsWith('issues.jsonl') ? metrics : ''),
    loadEnv: () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1', HEALTHCHECK_URL }),
    acquireLock: () => {
      timeline.push('acquireLock')
      return { acquired: true, holder: { pid: 1, startedAt: iso(T0), repoPath: REPO } }
    },
    releaseLock: () => {
      timeline.push('releaseLock')
    },
    findOrphans: async () => {
      timeline.push('findOrphans')
      return []
    },
    cleanupOrphans: async () => {
      timeline.push('cleanupOrphans')
      return []
    },
    folderQueueCount: async () => {
      timeline.push('folderQueueCount')
      return 1
    },
    sendWa,
    pingSuccess,
    pingFail,
    runQueueOnce: async () => {
      timeline.push('runQueueOnce')
      return { successes: [], failures: [] }
    },
    now: () => T0,
    currentVersion: '0.1.0',
    home: HOME,
    processEnv: {},
    cacheFs: new Volume(),
    ...overrides,
  }
  delete d.metrics
  d.timeline = timeline
  d.at = (event) => timeline.indexOf(event)
  d.first = (prefix) => timeline.findIndex((e) => e.startsWith(prefix))
  d.count = (event) => timeline.filter((e) => e === event).length
  d.notices = () => stdout.lines().filter((l) => l.includes(NOTICE))
  return d
}

// The evidence that the drain really happened, as ONE object so a regression shows
// up as a diff rather than as whichever assertion happens to be first.
function drainEvidence(d) {
  return {
    ranQueue: d.count('runQueueOnce'),
    releasedLock: d.count('releaseLock'),
    summary: d.sendWa.messages.filter((m) => m.startsWith('Ralph finished:')).length,
    okPings: d.pingSuccess.calls.length,
    failPings: d.pingFail.calls.length,
    eventStatus: cycleEvent(d.stdout)?.status ?? null,
    stderr: d.stderr.output(),
  }
}

const DRAINED = {
  ranQueue: 1,
  releasedLock: 1,
  summary: 1,
  okPings: 1,
  failPings: 0,
  eventStatus: 'success',
  stderr: '',
}

// The same run for `ralph start`, used by the cross-command parity tests. Unknown
// exec keys resolve to exit 0, so the tmux launch needs no handler of its own.
function startDeps(overrides = {}, execOptions = {}) {
  const stdout = makeStream()
  const asks = []
  const ask = async (question, options) => {
    asks.push({ question, options })
    return false
  }
  ask.calls = asks
  const d = {
    cwd: REPO,
    stdout,
    stderr: makeStream(),
    stdin: { isTTY: false },
    isTTY: false,
    exec: makeExec(execOptions, []),
    exists: () => false,
    loadEnv: () => ({}),
    readFile: () => '',
    hasCommand: () => true,
    peekLock: () => null,
    sendWa: async () => ({ ok: true }),
    now: () => T0,
    currentVersion: '0.1.0',
    home: HOME,
    processEnv: {},
    cacheFs: new Volume(),
    ...overrides,
  }
  d.ask = overrides.ask ?? ask
  d.notices = () => stdout.lines().filter((l) => l.includes(NOTICE))
  return d
}

function cycleEvent(stdout) {
  const line = stdout.lines().find((l) => l.startsWith(EVENT_TAG))
  return line ? JSON.parse(line.slice(EVENT_TAG.length)) : null
}

const cacheOf = (cacheFs, processEnv = {}) => readVersionCache({ fs: cacheFs, home: HOME, processEnv })
const seededCache = (cache) => Volume.fromJSON({ [CACHE_PATH]: JSON.stringify(cache) }, '/')
const seededRaw = (raw) => Volume.fromJSON({ [CACHE_PATH]: raw }, '/')

// A warm cache: inside the weekly network window, so no registry query happens and
// the notice (if any) is served from `latest_version`.
const warmCache = (latest = '0.2.0') =>
  seededCache({ last_check_at: iso(T0 - DAY), last_prompted_at: null, latest_version: latest })

const folderMode = (extra = {}) => ({
  readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : ''),
  ...extra,
})

// Swaps the AMBIENT process.stdin — the only thing the gate's own `isTTY` default
// could derive from. Used to prove this call site never consults it.
async function withProcessStdin(value, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin')
  Object.defineProperty(process, 'stdin', { configurable: true, get: () => value })
  try {
    return await fn()
  } finally {
    if (descriptor) Object.defineProperty(process, 'stdin', descriptor)
    else delete process.stdin
  }
}

// A stdin that records every property read and detonates on any stream method a
// readline would need. `isTTY` is a parameter so the same trap can play both shapes:
// `true` for an ambient terminal an injected non-interactive stream must beat, and
// `false` for the stream launchd actually supplies. Reading `.isTTY` is recorded but
// not fatal — #52 derives the flag from it, so the assertion is about which reads
// happen, not that none do.
const STREAM_METHODS = [
  'on',
  'once',
  'addListener',
  'removeListener',
  'off',
  'read',
  'resume',
  'pause',
  'setEncoding',
  'setRawMode',
  'pipe',
  'unpipe',
  'emit',
]
function trapStdin(isTTY = true) {
  const reads = []
  const target = { isTTY }
  const proxy = new Proxy(target, {
    get(obj, prop) {
      const name = String(prop)
      reads.push(name)
      if (STREAM_METHODS.includes(name)) {
        throw new Error(`readline touched process.stdin.${name} from ralph cycle`)
      }
      return obj[prop]
    },
  })
  return { proxy, reads }
}

const HOSTILE_DECISIONS = [
  ['a rejected promise', () => Promise.reject(new Error('decision exploded'))],
  [
    'a synchronous throw',
    () => {
      throw new Error('decision exploded')
    },
  ],
  ['null', () => null],
  ['undefined', () => undefined],
  ['a string', () => 'newer!'],
  ['a number', () => 42],
  ['a JSON array', () => []],
  ['a function', () => () => true],
  [
    'a thenable that throws on await',
    () => ({
      then() {
        throw new Error('thenable exploded')
      },
    }),
  ],
  [
    'an object whose latestVersion getter throws',
    () => ({
      get latestVersion() {
        throw new Error('getter exploded')
      },
      isNewer: true,
      shouldPrompt: true,
    }),
  ],
  [
    'an object whose isNewer getter throws',
    () => ({
      latestVersion: '0.2.0',
      get isNewer() {
        throw new Error('getter exploded')
      },
      shouldPrompt: false,
    }),
  ],
  [
    'an object whose shouldPrompt getter throws AFTER isNewer read true',
    () => ({
      latestVersion: '0.2.0',
      isNewer: true,
      get shouldPrompt() {
        throw new Error('getter exploded')
      },
    }),
  ],
  ['a Proxy that throws on every read', () => new Proxy({}, { get() { throw new Error('proxy') } })],
]

describe('QA cycle #51 — a hostile decision seam never costs the drain', () => {
  for (const [label, impl] of HOSTILE_DECISIONS) {
    it(`drains fully and prints no notice when the decision is ${label}`, async () => {
      const d = deps({ update: impl })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(result.exitCode).toBe(0)
      expect(drainEvidence(d)).toEqual(DRAINED)
      expect(d.notices()).toEqual([])
    })
  }

  for (const [label, update] of [
    ['not callable at all (null)', null],
    ['a plain object', {}],
    ['a string', 'resolveUpdateDecision'],
  ]) {
    it(`drains fully when the update seam is ${label}`, async () => {
      const d = deps({ update })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(drainEvidence(d)).toEqual(DRAINED)
      expect(d.notices()).toEqual([])
      // A broken seam replaces the decision, so no registry query is even attempted.
      expect(d.exec.npmViews()).toHaveLength(0)
    })
  }

  it('asks the decision exactly once per cycle', async () => {
    const calls = []
    const d = deps({
      update: async (args) => {
        calls.push(args)
        return { latestVersion: '0.2.0', isNewer: true, shouldPrompt: false }
      },
    })
    await cycleCommand(d)
    expect(calls).toHaveLength(1)
    expect(d.notices()).toHaveLength(1)
  })

  it('prints the notice and drains when the decision claims isNewer with truthy non-booleans', async () => {
    const d = deps({
      update: async () => ({ latestVersion: '0.3.0', isNewer: 'yes', shouldPrompt: 1 }),
    })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.notices()).toEqual([
      'New version available: 0.3.0 (run npm i -g @lucasfe/ralph to update)',
    ])
    expect(drainEvidence(d)).toEqual(DRAINED)
    // shouldPrompt was truthy and still nothing was asked: the injected stdin is not
    // a TTY, and #52 makes that — not the decision — the thing that opens the prompt.
    expect(d.stdout.output()).not.toContain(QUESTION)
  })

  it('never prompts on a decision that explicitly asks for a prompt, and leaves the window unstamped', async () => {
    // `shouldPrompt: true` is the decision saying the weekly window is OPEN. On an
    // unattended run that is still not enough: #52 requires a TTY as well, and the
    // window is left for the next human instead of being burned by launchd.
    const cacheFs = new Volume()
    const d = deps({
      cacheFs,
      update: async () => ({ latestVersion: '0.2.0', isNewer: true, shouldPrompt: true }),
    })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(d.stdout.output()).not.toContain(QUESTION)
    expect(drainEvidence(d)).toEqual(DRAINED)
    // The injected decision replaced the real one, so nothing wrote the cache at
    // all — the point is that no PROMPT stamp appeared either.
    expect(cacheOf(cacheFs).last_prompted_at).toBeNull()
  })

  it('a decision that mutates its own argument bag cannot corrupt the drain', async () => {
    const d = deps({
      update: async (args) => {
        args.exec = null
        args.home = 42
        args.now = null
        args.fs = null
        return { latestVersion: '0.2.0', isNewer: true, shouldPrompt: false }
      },
    })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.notices()).toHaveLength(1)
    expect(drainEvidence(d)).toEqual(DRAINED)
  })
})

describe('QA cycle #51 — a hostile latestVersion', () => {
  const notice = (v) => `New version available: ${v} (run npm i -g @lucasfe/ralph to update)`
  const seam = (latestVersion) => async () => ({ latestVersion, isNewer: true, shouldPrompt: false })

  for (const [label, value, rendered] of [
    ['an empty string', '', ''],
    ['whitespace only', '   ', '   '],
    ['a number', 3, '3'],
    ['a null (isNewer claimed anyway)', null, 'null'],
    ['an object with a custom toString', { toString: () => '9.9.9' }, '9.9.9'],
  ]) {
    it(`renders ${label} into the notice verbatim and still drains`, async () => {
      const d = deps({ update: seam(value) })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.notices()).toEqual([notice(rendered)])
      expect(drainEvidence(d)).toEqual(DRAINED)
    })
  }

  it('writes the notice as ONE write ending in a single newline', async () => {
    const d = deps()
    await cycleCommand(d)
    const chunk = d.stdout.chunks.map(strip).find((c) => c.includes(NOTICE))
    expect(chunk).toBe(NOTICE_LINE + '\n')
  })

  it('carries a very long version through in one write without losing the drain', async () => {
    const long = '9'.repeat(10_000)
    const d = deps({ update: seam(long) })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.stdout.chunks.map(strip).filter((c) => c.includes(NOTICE))).toEqual([
      notice(long) + '\n',
    ])
    expect(drainEvidence(d)).toEqual(DRAINED)
  })

  it('prints an ANSI-carrying version verbatim — nothing here sanitizes it (pinned, not endorsed)', async () => {
    // Unreachable through the real decision (see the cache group below: a
    // latest_version that is not a semver can never set isNewer), so this pins the
    // gate's documented "carried by reference, interpolated as-is" contract at the
    // cycle call site rather than endorsing it.
    const d = deps({ update: seam('0.2.0[31m BOOM [0m') })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.stdout.chunks.some((c) => c.includes('[31m BOOM'))).toBe(true)
    expect(drainEvidence(d)).toEqual(DRAINED)
  })

  it('a toString that throws aborts the cycle, releases the lock, and drains nothing', async () => {
    // The notice write — the interpolation of `latestVersion` included — is the one
    // boundary runUpdateGate deliberately leaves unguarded, so this is the only way
    // a throw from inside the gate is reachable. Being inside the lock's
    // try/finally is what keeps that from leaking the lock file.
    const boom = new Error('latestVersion.toString exploded')
    const d = deps({
      update: async () => ({
        isNewer: true,
        shouldPrompt: false,
        latestVersion: {
          toString() {
            throw boom
          },
        },
      }),
    })
    await expect(cycleCommand(d)).rejects.toBe(boom)
    expect(d.count('releaseLock')).toBe(1)
    expect(d.at('acquireLock')).toBeLessThan(d.at('releaseLock'))
    expect(drainEvidence(d)).toEqual({
      ranQueue: 0,
      releasedLock: 1,
      summary: 0,
      okPings: 0,
      failPings: 0,
      eventStatus: null,
      stderr: '',
    })
  })
})

describe('QA cycle #51 — the lock is released whatever the gate does', () => {
  const gateOutcomes = [
    ['a printed notice', {}],
    ['nothing newer', { currentVersion: '0.2.0' }],
    ['an unreachable registry', {}, { npm: { exitCode: 1, stdout: '', stderr: 'offline' } }],
    ['a corrupt cache', { cacheFs: seededRaw('{ not json') }],
    ['the opt-out', { processEnv: { RALPH_NO_UPDATE_CHECK: '1' } }],
    ['a throwing decision', { update: () => Promise.reject(new Error('boom')) }],
  ]

  for (const [label, overrides, execOptions] of gateOutcomes) {
    it(`releases the lock exactly once on ${label}`, async () => {
      const d = deps(overrides, execOptions)
      await cycleCommand(d)
      expect(d.count('releaseLock')).toBe(1)
      expect(d.at('acquireLock')).toBeLessThan(d.at('releaseLock'))
    })
  }

  it('propagates the gate’s own throw even when releaseLock throws on top of it', async () => {
    const boom = new Error('notice write exploded')
    const released = []
    const d = deps({
      stdout: {
        write: () => {
          throw boom
        },
        chunks: [],
        output: () => '',
        lines: () => [],
      },
      releaseLock: () => {
        released.push('called')
        throw new Error('lock file vanished')
      },
    })
    await expect(cycleCommand(d)).rejects.toBe(boom)
    expect(released).toHaveLength(1)
  })

  it('a stdout that throws only on the notice loses the run, not the lock', async () => {
    const boom = new Error('EPIPE')
    const written = []
    const stdout = {
      write: (s) => {
        if (String(s).includes(NOTICE)) throw boom
        written.push(String(s))
        return true
      },
      chunks: written,
      output: () => strip(written.join('')),
      lines: () => strip(written.join('')).split('\n').filter(Boolean),
    }
    const d = deps({ stdout })
    await expect(cycleCommand(d)).rejects.toBe(boom)
    expect(d.count('releaseLock')).toBe(1)
    expect(d.count('runQueueOnce')).toBe(0)
  })
})

describe('QA cycle #51 — placement holds under stress', () => {
  const gateIdx = (d) => d.at(`exec:${NPM_VIEW}`)

  it('stays between acquireLock and the sweep when findOrphans throws', async () => {
    const d = deps()
    d.findOrphans = async () => {
      d.timeline.push('findOrphans')
      throw new Error('gh exploded')
    }
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(gateIdx(d)).toBeGreaterThan(d.at('acquireLock'))
    expect(gateIdx(d)).toBeLessThan(d.at('findOrphans'))
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(drainEvidence(d)).toEqual(DRAINED)
  })

  it('stays between acquireLock and the sweep when cleanupOrphans throws', async () => {
    const d = deps({
      findOrphans: async () => {
        d.timeline.push('findOrphans')
        return [7]
      },
      cleanupOrphans: async () => {
        d.timeline.push('cleanupOrphans')
        throw new Error('gh exploded')
      },
    })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(gateIdx(d)).toBeLessThan(d.at('findOrphans'))
    expect(gateIdx(d)).toBeLessThan(d.at('cleanupOrphans'))
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(drainEvidence(d)).toEqual(DRAINED)
  })

  it('prints the notice BEFORE the orphan-cleanup line when orphans are cleared', async () => {
    const d = deps({
      findOrphans: async () => {
        d.timeline.push('findOrphans')
        return [12, 34]
      },
      cleanupOrphans: async () => {
        d.timeline.push('cleanupOrphans')
        return [12, 34]
      },
    })
    await cycleCommand(d)
    const lines = d.stdout.lines()
    const noticeIdx = lines.findIndex((l) => l.includes(NOTICE))
    const cleanedIdx = lines.findIndex((l) => l.includes('cleaned 2 orphan(s)'))
    expect(noticeIdx).toBeGreaterThanOrEqual(0)
    expect(cleanedIdx).toBeGreaterThan(noticeIdx)
  })

  it('runs in folder mode, where no gh queue call happens at all', async () => {
    const d = deps(folderMode())
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.exec.keys().some((k) => k.startsWith('gh issue'))).toBe(false)
    expect(d.exec.keys().some((k) => k === 'gh auth status')).toBe(false)
    expect(gateIdx(d)).toBeGreaterThan(d.at('acquireLock'))
    expect(gateIdx(d)).toBeLessThan(d.at('findOrphans'))
    expect(gateIdx(d)).toBeLessThan(d.at('folderQueueCount'))
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(drainEvidence(d)).toEqual(DRAINED)
  })

  it('prints the notice in folder mode with an EMPTY folder queue', async () => {
    const d = deps(folderMode({ folderQueueCount: async () => 0 }))
    const result = await cycleCommand(d)
    expect(result.status).toBe('queue-empty')
    const lines = d.stdout.lines()
    expect(lines.findIndex((l) => l.includes(NOTICE))).toBeLessThan(
      lines.findIndex((l) => l.includes('queue empty, exiting')),
    )
    expect(d.count('releaseLock')).toBe(1)
  })

  it('prints the notice in folder mode when a broken folder counter yields zero', async () => {
    const d = deps(
      folderMode({
        folderQueueCount: async () => {
          throw new Error('tasks dir unreadable')
        },
      }),
    )
    const result = await cycleCommand(d)
    expect(result.status).toBe('queue-empty')
    expect(d.notices()).toEqual([NOTICE_LINE])
  })

  for (const [label, metrics, status, pings] of [
    ['a partial drain', METRICS.mixed, 'partial', { okPings: 1, failPings: 0 }],
    ['a fully failed drain', METRICS.allFailed, 'failed', { okPings: 0, failPings: 1 }],
    ['a fully successful drain', METRICS.allOk, 'success', { okPings: 1, failPings: 0 }],
  ]) {
    it(`keeps the notice, the placement and the healthcheck on ${label}`, async () => {
      const d = deps({ metrics }, { queue: '2' })
      const result = await cycleCommand(d)
      expect(result.status).toBe(status)
      expect(d.notices()).toEqual([NOTICE_LINE])
      expect(gateIdx(d)).toBeGreaterThan(d.at('acquireLock'))
      expect(gateIdx(d)).toBeLessThan(d.at('findOrphans'))
      expect(gateIdx(d)).toBeLessThan(d.at('runQueueOnce'))
      expect(d.pingSuccess.calls).toHaveLength(pings.okPings)
      expect(d.pingFail.calls).toHaveLength(pings.failPings)
      expect(d.count('releaseLock')).toBe(1)
    })
  }

  it('the notice always precedes the RALPH_CYCLE_EVENT line on stdout', async () => {
    for (const [metrics, queue] of [
      [METRICS.none, '1'],
      [METRICS.mixed, '2'],
      [METRICS.allFailed, '1'],
      [METRICS.none, '0'],
    ]) {
      const d = deps({ metrics }, { queue })
      await cycleCommand(d)
      const lines = d.stdout.lines()
      const noticeIdx = lines.findIndex((l) => l.includes(NOTICE))
      const eventIdx = lines.findIndex((l) => l.startsWith(EVENT_TAG))
      expect(noticeIdx).toBeGreaterThanOrEqual(0)
      expect(eventIdx).toBeGreaterThan(noticeIdx)
    }
  })

  it('does not run before the lock is taken, even with a warm cache that needs no network', async () => {
    // A cache-served notice makes no npm spawn, so the ordering has to be proven
    // through the decision seam rather than through the registry query.
    const seen = []
    const d = deps({
      cacheFs: warmCache(),
      update: async () => {
        d.timeline.push('decision')
        seen.push('called')
        return { latestVersion: '0.2.0', isNewer: true, shouldPrompt: false }
      },
    })
    await cycleCommand(d)
    expect(seen).toHaveLength(1)
    expect(d.at('decision')).toBeGreaterThan(d.at('acquireLock'))
    expect(d.at('decision')).toBeLessThan(d.at('findOrphans'))
  })
})

describe('QA cycle #51 — payload and channel parity on every status', () => {
  const BASE_KEYS = ['durationMin', 'failed', 'ok', 'processed', 'status', 'ts']
  const cases = [
    ['success', BASE_KEYS.concat('run_id').sort(), {}, {}],
    ['partial', BASE_KEYS.concat('run_id').sort(), { metrics: METRICS.mixed }, { queue: '2' }],
    ['failed', BASE_KEYS.concat('run_id').sort(), { metrics: METRICS.allFailed }, {}],
    ['queue-empty', BASE_KEYS, {}, { queue: '0' }],
    ['tmux-active', BASE_KEYS, {}, { tmuxHasSession: 0 }],
    [
      'lock-held',
      BASE_KEYS.concat('holderPid').sort(),
      {
        acquireLock: () => ({
          acquired: false,
          holder: { pid: 4242, startedAt: iso(T0 - 25 * 60_000), repoPath: REPO },
        }),
      },
      {},
    ],
    ['preflight-failed', BASE_KEYS.concat('reason').sort(), {}, { ghAuth: 1 }],
  ]

  for (const [status, keys, overrides, execOptions] of cases) {
    it(`adds no payload key on status=${status}`, async () => {
      const withNotice = deps(overrides, execOptions)
      const result = await cycleCommand(withNotice)
      expect(result.status).toBe(status)
      const payload = cycleEvent(withNotice.stdout)
      expect(Object.keys(payload).sort()).toEqual(keys)
      expect(JSON.stringify(payload)).not.toContain('0.2.0')
      expect(JSON.stringify(payload)).not.toContain(NOTICE)

      // The same run with nothing to announce must produce the same key set, so a
      // future field cannot hide behind "only when there is a notice".
      const quiet = deps({ ...overrides, currentVersion: '0.2.0' }, execOptions)
      await cycleCommand(quiet)
      expect(Object.keys(cycleEvent(quiet.stdout)).sort()).toEqual(keys)
    })
  }

  it('says nothing about the update over WhatsApp on any drain status', async () => {
    for (const metrics of [METRICS.none, METRICS.mixed, METRICS.allFailed]) {
      const d = deps({ metrics }, { queue: '2' })
      await cycleCommand(d)
      expect(d.notices()).toEqual([NOTICE_LINE])
      expect(d.sendWa.messages.length).toBeGreaterThan(0)
      expect(d.sendWa.messages.some((m) => /New version|npm i -g|0\.2\.0/.test(m))).toBe(false)
    }
  })

  it('never writes the notice to stderr, even on the run that also writes stderr', async () => {
    const d = deps({}, { ghAuth: 1 })
    const result = await cycleCommand(d)
    expect(result.status).toBe('preflight-failed')
    expect(d.stderr.output()).toContain('preflight failed')
    expect(d.stderr.output()).not.toContain(NOTICE)
  })

  it('leaves the returned result shape untouched by the notice', async () => {
    const withNotice = deps()
    const quiet = deps({ currentVersion: '0.2.0' })
    const a = await cycleCommand(withNotice)
    const b = await cycleCommand(quiet)
    expect(withNotice.notices()).toHaveLength(1)
    expect(quiet.notices()).toHaveLength(0)
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort())
    expect(a).toEqual(b)
  })
})

describe('QA cycle #51 — a hostile global cache never costs a drain', () => {
  const corrupt = [
    ['an empty file', ''],
    ['whitespace only', '   \n\t'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"nope"'],
    ['a JSON number', '42'],
    ['truncated JSON', '{"last_check_at":"2026-08-2'],
    ['mangled JSON', '{ not json at all'],
    ['a BOM-prefixed object', '﻿{"last_check_at":"2026-08-21T12:00:00.000Z"}'],
    ['numeric field types', '{"last_check_at":1787356800000,"latest_version":17}'],
    ['a nested object field', '{"last_check_at":{"iso":"2026-08-21T12:00:00.000Z"}}'],
    ['an unparseable date', '{"last_check_at":"last tuesday"}'],
    ['unknown keys only', '{"foo":"bar","last_seen_release":"v0.16.0"}'],
    ['a stamp in the FUTURE', `{"last_check_at":"${iso(T0 + 90 * DAY)}","latest_version":"0.1.0"}`],
    ['a NaN stamp', '{"last_check_at":"NaN","latest_version":"0.1.0"}'],
  ]

  for (const [label, raw] of corrupt) {
    it(`drains and still notices the new version with ${label}`, async () => {
      const cacheFs = seededRaw(raw)
      const d = deps({ cacheFs })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.notices()).toEqual([NOTICE_LINE])
      expect(d.exec.npmViews()).toHaveLength(1)
      expect(drainEvidence(d)).toEqual(DRAINED)
      // The unusable file is replaced by the well-formed three-field shape.
      expect(cacheOf(cacheFs)).toEqual({
        last_check_at: iso(T0),
        last_prompted_at: null,
        latest_version: '0.2.0',
      })
    })
  }

  it('drains when a DIRECTORY occupies the cache path', async () => {
    const cacheFs = new Volume()
    cacheFs.mkdirSync(CACHE_PATH, { recursive: true })
    const d = deps({ cacheFs })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(drainEvidence(d)).toEqual(DRAINED)
  })

  const brokenFs = [
    [
      'readFileSync throws EACCES',
      () => ({
        readFileSync: () => {
          const e = new Error('EACCES: permission denied')
          e.code = 'EACCES'
          throw e
        },
        mkdirSync: () => undefined,
        writeFileSync: () => undefined,
      }),
    ],
    [
      'mkdirSync throws EACCES',
      () => ({
        readFileSync: () => {
          const e = new Error('ENOENT')
          e.code = 'ENOENT'
          throw e
        },
        mkdirSync: () => {
          const e = new Error('EACCES: permission denied')
          e.code = 'EACCES'
          throw e
        },
        writeFileSync: () => undefined,
      }),
    ],
    [
      'writeFileSync throws EROFS (a read-only volume)',
      () => {
        const v = Volume.fromJSON({ [CACHE_PATH]: '{}' }, '/')
        return {
          readFileSync: (...a) => v.readFileSync(...a),
          mkdirSync: () => undefined,
          writeFileSync: () => {
            const e = new Error('EROFS: read-only file system')
            e.code = 'EROFS'
            throw e
          },
        }
      },
    ],
    [
      'writeFileSync throws ENOSPC',
      () => ({
        readFileSync: () => '{}',
        mkdirSync: () => undefined,
        writeFileSync: () => {
          const e = new Error('ENOSPC: no space left on device')
          e.code = 'ENOSPC'
          throw e
        },
      }),
    ],
    ['the fs object has no methods at all', () => ({})],
    ['every fs method throws', () => ({
      readFileSync: () => {
        throw new Error('boom')
      },
      mkdirSync: () => {
        throw new Error('boom')
      },
      writeFileSync: () => {
        throw new Error('boom')
      },
    })],
  ]

  for (const [label, build] of brokenFs) {
    it(`drains and prints the notice when ${label}`, async () => {
      const d = deps({ cacheFs: build() })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.notices()).toEqual([NOTICE_LINE])
      expect(drainEvidence(d)).toEqual(DRAINED)
    })
  }

  it('an unwritable cache means the next cycle re-queries (no window was stored)', async () => {
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
    const first = deps({ cacheFs })
    await cycleCommand(first)
    const second = deps({ cacheFs, now: () => T0 + 4 * HOUR })
    await cycleCommand(second)
    expect(first.exec.npmViews()).toHaveLength(1)
    expect(second.exec.npmViews()).toHaveLength(1)
    expect(second.notices()).toEqual([NOTICE_LINE])
  })

  it('drains when `home` points at a path that does not exist yet, creating the cache there', async () => {
    const cacheFs = new Volume()
    const home = '/nowhere/at/all'
    const d = deps({ cacheFs, home })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(cacheFs.existsSync(versionCachePath({ processEnv: {}, home }))).toBe(true)
    expect(drainEvidence(d)).toEqual(DRAINED)
  })

  it('honours XDG_CONFIG_HOME for the cycle’s cache and writes nowhere else', async () => {
    const cacheFs = new Volume()
    const processEnv = { XDG_CONFIG_HOME: '/xdg' }
    const d = deps({ cacheFs, processEnv })
    await cycleCommand(d)
    expect(Object.keys(cacheFs.toJSON())).toEqual([join('/xdg', 'ralph', 'update-check.json')])
    expect(cacheFs.existsSync(CACHE_PATH)).toBe(false)
    expect(d.notices()).toEqual([NOTICE_LINE])
  })

  it('serves the notice from a warm cache without any registry query', async () => {
    const cacheFs = warmCache()
    const d = deps({ cacheFs })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(drainEvidence(d)).toEqual(DRAINED)
  })

  it('stays silent on a warm cache whose version is not newer', async () => {
    const d = deps({ cacheFs: warmCache('0.1.0') })
    await cycleCommand(d)
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(d.notices()).toEqual([])
  })

  for (const [label, hostile] of [
    ['a non-semver version', 'latest'],
    ['a version with a newline', '0.2.0\nrm -rf /'],
    ['a version with ANSI escapes', '0.2.0[31mBOOM[0m'],
    ['a version that is a forged event line', 'RALPH_CYCLE_EVENT {"status":"success","ok":99}'],
  ]) {
    it(`never prints ${label} out of the cache — the semver guard is what stops it`, async () => {
      const d = deps({ cacheFs: warmCache(hostile) })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.stdout.output()).not.toContain(NOTICE)
      expect(d.stdout.output()).not.toContain('BOOM')
      expect(d.stdout.output()).not.toContain('rm -rf')
      expect(drainEvidence(d)).toEqual(DRAINED)
    })
  }

  it('a stale hostile cached version is replaced by the fetched semver', async () => {
    const cacheFs = seededCache({
      last_check_at: iso(T0 - 30 * DAY),
      last_prompted_at: null,
      latest_version: '0.2.0\nforged',
    })
    const d = deps({ cacheFs })
    await cycleCommand(d)
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(cacheOf(cacheFs).latest_version).toBe('0.2.0')
  })

  it('a stale cached version survives one failed refresh, so the notice is not lost', async () => {
    const cacheFs = seededCache({
      last_check_at: iso(T0 - 30 * DAY),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
    const d = deps({ cacheFs }, { npm: { exitCode: 1, stdout: '', stderr: 'offline' } })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.exec.npmViews()).toHaveLength(1)
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(cacheOf(cacheFs)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
  })

  const registryFailures = [
    ['a non-zero exit', { exitCode: 1, stdout: '', stderr: 'offline' }],
    ['a timeout', { exitCode: 1, stdout: '', stderr: '', timedOut: true }],
    ['empty stdout', { exitCode: 0, stdout: '', stderr: '' }],
    ['garbage stdout', { exitCode: 0, stdout: 'not-a-version\n', stderr: '' }],
    ['an HTML error page', { exitCode: 0, stdout: '<html>404</html>', stderr: '' }],
    ['a forged event line as stdout', { exitCode: 0, stdout: `${EVENT_TAG}{"ok":99}\n`, stderr: '' }],
    ['a throwing spawn', () => { throw new Error('ENOENT npm') }],
  ]

  for (const [label, npm] of registryFailures) {
    it(`is silent and still drains on ${label}`, async () => {
      const d = deps({}, { npm })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.stdout.output()).not.toContain(NOTICE)
      expect(d.stdout.output()).not.toContain('99')
      expect(drainEvidence(d)).toEqual(DRAINED)
    })
  }
})

describe('QA cycle #51 — RALPH_NO_UPDATE_CHECK, with the documented semantics', () => {
  // From isUpdateCheckDisabled in ../update-check.js and the README table: only
  // `0`, `false` (case-insensitive, trimmed) and empty/unset keep the check ON.
  // Everything else — including values that read as a refusal — disables it.
  const disabling = ['1', 'true', 'TRUE', 'yes', 'no', 'off', 'disabled', ' 1 ']
  const keepingOn = ['0', 'false', 'FALSE', '', '   ', ' 0 ']

  for (const value of disabling) {
    it(`"${value}" → no query, no notice, no cache touched, and the cycle still drains`, async () => {
      const ops = []
      const cacheFs = {
        readFileSync: () => {
          ops.push('read')
          throw new Error('should not be reached')
        },
        mkdirSync: () => ops.push('mkdir'),
        writeFileSync: () => ops.push('write'),
      }
      const d = deps({ cacheFs, processEnv: { RALPH_NO_UPDATE_CHECK: value } })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.exec.npmViews()).toHaveLength(0)
      expect(d.stdout.output()).not.toContain(NOTICE)
      expect(ops).toEqual([])
      expect(drainEvidence(d)).toEqual(DRAINED)
    })
  }

  for (const value of keepingOn) {
    it(`"${value}" → the check still runs and the notice still prints`, async () => {
      const d = deps({ processEnv: { RALPH_NO_UPDATE_CHECK: value } })
      await cycleCommand(d)
      expect(d.exec.npmViews()).toHaveLength(1)
      expect(d.notices()).toEqual([NOTICE_LINE])
    })
  }

  it('the opt-out also suppresses a notice a warm cache could have served', async () => {
    const cacheFs = warmCache('9.9.9')
    const d = deps({ cacheFs, processEnv: { RALPH_NO_UPDATE_CHECK: '1' } })
    await cycleCommand(d)
    expect(d.stdout.output()).not.toContain(NOTICE)
    expect(d.exec.npmViews()).toHaveLength(0)
  })

  it('an opt-out in the repo .env.local does NOT reach the gate (parity with start)', async () => {
    // Both call sites hand the gate `processEnv` and nothing else, so the env var
    // is a SHELL/profile setting exactly as the README documents it. Pinned so a
    // future change to either command has to change both.
    const d = deps({
      loadEnv: () => ({
        CALLMEBOT_KEY: 'k',
        WHATSAPP_PHONE: '+1',
        HEALTHCHECK_URL,
        RALPH_NO_UPDATE_CHECK: '1',
      }),
    })
    await cycleCommand(d)
    expect(d.exec.npmViews()).toHaveLength(1)
    expect(d.notices()).toEqual([NOTICE_LINE])

    const s = startDeps({
      exists: (p) => String(p).endsWith('.env.local'),
      loadEnv: () => ({ RALPH_NO_UPDATE_CHECK: '1' }),
    })
    await startCommand(s)
    expect(s.exec.npmViews()).toHaveLength(1)
    expect(s.notices()).toHaveLength(1)
  })

  it('a hostile env bag never costs the drain', async () => {
    for (const processEnv of [
      { RALPH_NO_UPDATE_CHECK: 1 },
      { RALPH_NO_UPDATE_CHECK: null },
      { RALPH_NO_UPDATE_CHECK: {} },
      {
        get RALPH_NO_UPDATE_CHECK() {
          throw new Error('env getter exploded')
        },
      },
    ]) {
      const d = deps({ processEnv })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(drainEvidence(d)).toEqual(DRAINED)
      expect(d.stderr.output()).toBe('')
    }
  })
})

describe('QA cycle #51 — the weekly windows across a real schedule', () => {
  it('queries once at the 7-day boundary and not one millisecond earlier', async () => {
    const runs = [
      ['inside, 1ms short of the week', iso(T0 - WEEK + 1), 0],
      ['exactly one week old', iso(T0 - WEEK), 1],
      ['a week and a second old', iso(T0 - WEEK - 1000), 1],
    ]
    for (const [label, lastCheck, expected] of runs) {
      const cacheFs = seededCache({
        last_check_at: lastCheck,
        last_prompted_at: null,
        latest_version: '0.2.0',
      })
      const d = deps({ cacheFs })
      await cycleCommand(d)
      expect({ label, queries: d.exec.npmViews().length }).toEqual({ label, queries: expected })
      // Either way the notice is served — the throttle covers the network only.
      expect(d.notices()).toEqual([NOTICE_LINE])
    }
  })

  it('six cycles a day for two weeks make exactly two registry queries', async () => {
    const cacheFs = new Volume()
    let queries = 0
    let notices = 0
    let runs = 0
    for (let day = 0; day < 14; day++) {
      for (const hour of [0, 4, 8, 12, 16, 20]) {
        const d = deps({ cacheFs, now: () => T0 + day * DAY + hour * HOUR })
        const result = await cycleCommand(d)
        expect(result.status).toBe('success')
        queries += d.exec.npmViews().length
        notices += d.notices().length
        runs += 1
      }
    }
    expect(runs).toBe(84)
    // T0 (window opens) and T0 + 7d 00:00, which is exactly one week later.
    expect(queries).toBe(2)
    expect(notices).toBe(84)
    expect(cacheOf(cacheFs).last_prompted_at).toBeNull()
  })

  it('never stamps the prompt window, however many cycles run', async () => {
    const cacheFs = new Volume()
    for (const now of [T0, T0 + HOUR, T0 + DAY, T0 + WEEK, T0 + WEEK + DAY]) {
      await cycleCommand(deps({ cacheFs, now: () => now }))
      expect(cacheOf(cacheFs).last_prompted_at).toBeNull()
    }
  })

  it('leaves the window the next interactive `ralph start` needs, so the human is still asked', async () => {
    // The whole reason an unattended cycle must not stamp the prompt window: the
    // window belongs to the ASKING, and a launchd cycle has nobody to ask. #52 lets
    // a cycle ON A TTY stamp it — and then `start` correctly stays quiet, which is
    // the same policy seen from the other side (../update-gate.js, and the shared
    // window tests in ./cycle.update-prompt.test.js).
    const cacheFs = new Volume()
    const cycle = deps({ cacheFs })
    await cycleCommand(cycle)
    expect(cycle.notices()).toEqual([NOTICE_LINE])
    expect(cacheOf(cacheFs).last_prompted_at).toBeNull()

    const s = startDeps({ cacheFs, isTTY: true, stdin: { isTTY: true }, now: () => T0 + HOUR })
    await startCommand(s)
    expect(s.ask.calls).toHaveLength(1)
    expect(s.ask.calls[0].question).toContain(QUESTION)
    // Throttled on the network window the cycle already stamped: one query a week
    // between the two commands, exactly as #24 promises.
    expect(s.exec.npmViews()).toHaveLength(0)
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0 + HOUR))
  })

  it('a cycle after an interactive start neither re-asks nor loses the notice', async () => {
    const cacheFs = new Volume()
    const s = startDeps({ cacheFs, isTTY: true, stdin: { isTTY: true } })
    await startCommand(s)
    expect(s.ask.calls).toHaveLength(1)

    const cycle = deps({ cacheFs, now: () => T0 + 4 * HOUR })
    const result = await cycleCommand(cycle)
    expect(result.status).toBe('success')
    expect(cycle.exec.npmViews()).toHaveLength(0)
    expect(cycle.notices()).toEqual([NOTICE_LINE])
    expect(cycle.stdout.output()).not.toContain(QUESTION)
    // The start's stamp is preserved to the byte — a cycle rewrites no window it
    // did not open.
    expect(cacheOf(cacheFs)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
  })

  it('two repos on one machine share the cycle’s weekly window', async () => {
    const cacheFs = new Volume()
    const a = deps({ cacheFs, cwd: '/repo-a' })
    await cycleCommand(a)
    const b = deps({ cacheFs, cwd: '/repo-b', now: () => T0 + 2 * DAY })
    await cycleCommand(b)
    expect(a.exec.npmViews()).toHaveLength(1)
    expect(b.exec.npmViews()).toHaveLength(0)
    expect(a.notices()).toEqual([NOTICE_LINE])
    expect(b.notices()).toEqual([NOTICE_LINE])
  })

  it('a burst of concurrent cycles leaves one valid, closed window', async () => {
    const cacheFs = new Volume()
    const runs = [deps({ cacheFs }), deps({ cacheFs }), deps({ cacheFs })]
    await Promise.all(runs.map((d) => cycleCommand(d)))
    expect(cacheOf(cacheFs)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
    for (const d of runs) expect(d.notices()).toEqual([NOTICE_LINE])
    const after = deps({ cacheFs, now: () => T0 + DAY })
    await cycleCommand(after)
    expect(after.exec.npmViews()).toHaveLength(0)
  })

  it('a clock at the epoch or far in the future still notices and drains', async () => {
    // Only clocks the cycle's OWN emitEvent can render are exercised here: a NaN or
    // out-of-range `now` makes `new Date(now()).toISOString()` throw at line 83 of
    // cycle.js, which is pre-existing and has nothing to do with #51. What is #51's
    // business is that the gate does not add a second failure mode on top —
    // epochMs() in ../update-check.js absorbs a broken clock into the real one.
    for (const nowMs of [0, T0, Date.parse('2099-01-01T00:00:00.000Z')]) {
      const cacheFs = new Volume()
      const d = deps({ cacheFs, now: () => nowMs })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.notices()).toEqual([NOTICE_LINE])
      expect(cacheOf(cacheFs).last_check_at).toBe(iso(nowMs))
      expect(drainEvidence(d)).toEqual(DRAINED)
    }
  })

  it('a `now` that throws is absorbed by the gate, not turned into a second failure', async () => {
    // The gate/decision side must survive it (epochMs falls back to Date.now), so
    // the notice still prints; the cycle's own event emission is what fails, and it
    // fails the same way with or without the update check. Proven by comparing the
    // two runs rather than by asserting one of them.
    const broken = () => {
      throw new Error('clock exploded')
    }
    const withCheck = deps({ now: broken })
    const optedOut = deps({ now: broken, processEnv: { RALPH_NO_UPDATE_CHECK: '1' } })
    const a = await cycleCommand(withCheck).then(
      () => 'resolved',
      (e) => e.message,
    )
    const b = await cycleCommand(optedOut).then(
      () => 'resolved',
      (e) => e.message,
    )
    expect(a).toBe(b)
    expect(withCheck.count('releaseLock')).toBe(1)
    expect(optedOut.count('releaseLock')).toBe(1)
  })
})

describe('QA cycle #51 — degenerate currentVersion', () => {
  for (const [label, currentVersion, expectNotice] of [
    ['omitted (the `unknown` default)', undefined, false],
    ['equal to the published version', '0.2.0', false],
    ['newer than published (a linked dev checkout)', '9.9.9', false],
    ['a v-prefixed tag', 'v0.1.0', false],
    ['a two-part version', '0.1', false],
    ['an empty string', '', false],
    ['null', null, false],
    ['a number', 42, false],
    ['an object', {}, false],
    ['a prerelease of the published version', '0.2.0-rc.1', true],
    ['a build-metadata version', '0.1.0+build.5', true],
    ['an older prerelease', '0.1.0-rc.1', true],
  ]) {
    it(`${expectNotice ? 'notices' : 'says nothing'} when currentVersion is ${label}`, async () => {
      const cacheFs = new Volume()
      // Explicitly `undefined` for the omitted case, so cycleCommand's own
      // `currentVersion = 'unknown'` default is what runs (deps() would otherwise
      // supply 0.1.0 and quietly test the happy path again).
      const d = deps({ cacheFs, currentVersion })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.notices()).toHaveLength(expectNotice ? 1 : 0)
      expect(drainEvidence(d)).toEqual(DRAINED)
      // Either way the weekly network window is stamped: the query happened, and
      // the comparison is not what the throttle is about.
      expect(cacheOf(cacheFs)).toEqual({
        last_check_at: iso(T0),
        last_prompted_at: null,
        latest_version: '0.2.0',
      })
    })
  }

  it('prints the byte-identical line `ralph start` prints, for a plain and a prerelease version', async () => {
    for (const [currentVersion, published] of [
      ['0.1.0', '0.2.0\n'],
      ['0.2.0-rc.1', '0.2.0\n'],
      ['0.1.0', '1.0.0-rc.1\n'],
    ]) {
      const npm = { exitCode: 0, stdout: published, stderr: '' }
      const c = deps({ currentVersion }, { npm })
      await cycleCommand(c)
      const s = startDeps({ currentVersion }, { npm })
      await startCommand(s)
      expect(s.notices()).toHaveLength(1)
      expect(c.notices()).toEqual(s.notices())
    }
  })

  it('prints the byte-identical line `ralph start` prints from a warm cache too', async () => {
    const c = deps({ cacheFs: warmCache('0.5.0') })
    await cycleCommand(c)
    const s = startDeps({ cacheFs: warmCache('0.5.0') })
    await startCommand(s)
    expect(c.exec.npmViews()).toHaveLength(0)
    expect(s.exec.npmViews()).toHaveLength(0)
    expect(s.notices()).toHaveLength(1)
    expect(c.notices()).toEqual(s.notices())
  })
})

describe('QA cycle #51/#52 — an unattended cycle can never host a question', () => {
  const PROMPT_DEMANDED = {
    update: async () => ({ latestVersion: '0.2.0', isNewer: true, shouldPrompt: true }),
  }

  it('lets an injected non-interactive stdin beat an ambient terminal, untouched', async () => {
    // The precedence #52 depends on. `bin/ralph.js` injects no stdin, so the ambient
    // stream is what a real run resolves — but a caller that DOES inject one (the
    // launchd wrapper, a test, any future embedder) must be obeyed, or a scheduled
    // tick could be handed a readline over a terminal that is attached to some other
    // process's session. Not one property of the ambient stream is read.
    const { proxy, reads } = trapStdin(true)
    await withProcessStdin(proxy, async () => {
      const d = deps(PROMPT_DEMANDED)
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.notices()).toEqual([NOTICE_LINE])
      expect(d.stdout.output()).not.toContain(QUESTION)
      expect(d.count('runQueueOnce')).toBe(1)
    })
    expect(reads).toEqual([])
  })

  it('reads the ambient launchd stdin for its isTTY flag ONLY, and never opens it', async () => {
    // The real scheduled shape: no stdin injected, so cycleCommand's own
    // `stdin = process.stdin` default resolves the ambient stream — which under
    // launchd is not a terminal. Exactly one property is read, `isTTY`, and every
    // stream method a readline would reach for detonates, so the assertion is that
    // the flag alone decided and `confirm` was never entered.
    const { proxy, reads } = trapStdin(false)
    await withProcessStdin(proxy, async () => {
      const d = deps({ ...PROMPT_DEMANDED, stdin: undefined })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.notices()).toEqual([NOTICE_LINE])
      expect(d.stdout.output()).not.toContain(QUESTION)
      expect(d.count('runQueueOnce')).toBe(1)
    })
    expect(reads).toEqual(['isTTY'])
  })

  it('never blocks: a scheduled cycle whose prompt would hang still settles', async () => {
    // If the gate ever reached `confirm` over a stream that never ends a line, the
    // real command would hang forever under launchd — with the cycle lock held, so
    // every later tick would report lock-held and the schedule would stop for good.
    // This proves the unattended run settles.
    const { proxy } = trapStdin(false)
    await withProcessStdin(proxy, async () => {
      const d = deps({ ...PROMPT_DEMANDED, stdin: undefined })
      const outcome = await Promise.race([
        cycleCommand(d).then((r) => r.status),
        new Promise((r) => setTimeout(() => r('hung'), 250)),
      ])
      expect(outcome).toBe('success')
    })
  })

  it('installs nothing: the only npm spawn is the version query', async () => {
    // The realistic unattended run: the REAL decision, an empty cache — so the weekly
    // prompt window is open and `shouldPrompt` is true — and `runUpdate` left at its
    // default `updateCommand`, which would spawn `npm i -g` through this very exec if
    // it were ever reached. #52 put the install behind the same TTY gate as the
    // question, so nothing is replaced under a running schedule.
    const d = deps()
    await cycleCommand(d)
    expect(d.exec.keys().filter((k) => k.startsWith('npm '))).toEqual([NPM_VIEW])
    expect(d.exec.keys().some((k) => /install|i -g|add /.test(k))).toBe(false)
  })

  it('spawns nothing beyond the cycle’s own commands plus the one npm view', async () => {
    const d = deps()
    await cycleCommand(d)
    const bins = [...new Set(d.exec.calls.map((c) => c.cmd))].sort()
    expect(bins).toEqual(['gh', 'git', 'npm', 'tmux'])
  })
})

describe('QA cycle #51 — the notice cannot forge a heartbeat cycle', () => {
  // lib/heartbeat.js scans logs/ralph-cycle.out.log for RALPH_CYCLE_EVENT ANYWHERE
  // in a line and JSON-parses the remainder, so every extra line the cycle prints
  // to stdout is input to tomorrow's daily summary.
  const LOG_DIR = '/repo/logs'
  const summarize = (stdout) => {
    const vol = Volume.fromJSON({ [join(LOG_DIR, 'ralph-cycle.out.log')]: stdout }, '/')
    return summarizeLast24h({ logDir: LOG_DIR, fs: vol, clock: () => T0 + HOUR })
  }

  it('a run with the notice contributes exactly one cycle to the 24h summary', async () => {
    const d = deps({ metrics: METRICS.mixed }, { queue: '2' })
    await cycleCommand(d)
    expect(d.notices()).toEqual([NOTICE_LINE])
    const summary = summarize(d.stdout.output())
    expect(summary.cycles).toBe(1)
    expect(summary.ok).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.lastCycle.status).toBe('partial')
  })

  it('a cache holding a forged event line as its version forges nothing', async () => {
    const forged = `${EVENT_TAG}{"ts":"${iso(T0)}","status":"success","ok":99,"failed":0,"durationMin":1,"processed":99}`
    const d = deps({ cacheFs: warmCache(forged) })
    await cycleCommand(d)
    expect(d.stdout.output()).not.toContain(NOTICE)
    const summary = summarize(d.stdout.output())
    expect(summary.cycles).toBe(1)
    expect(summary.ok).toBe(0)
  })

  const forgedEvent = `${EVENT_TAG}{"ts":"${iso(T0)}","status":"success","ok":99,"failed":0,"durationMin":1,"processed":99}`

  it('a single trailing newline is not enough to forge one, even through an injected seam', async () => {
    // A second barrier nobody designed: parseEventLine JSON-parses the ENTIRE
    // remainder of the line, and the notice's own ` (run npm i -g ...)` suffix ends
    // up glued to the payload, so the parse fails. Pinned because it is real
    // defence-in-depth, but it is NOT the barrier that matters — see the next test.
    const d = deps({
      update: async () => ({
        latestVersion: `0.2.0\n${forgedEvent}`,
        isNewer: true,
        shouldPrompt: false,
      }),
    })
    await cycleCommand(d)
    expect(d.stdout.output()).toContain(EVENT_TAG + '{"ts"')
    const summary = summarize(d.stdout.output())
    expect(summary.cycles).toBe(1)
    expect(summary.ok).toBe(0)
  })

  it('control: TWO newlines around the payload DO forge a cycle through an injected seam', async () => {
    // The positive control for the cache test above. With the suffix pushed onto a
    // third line the forged payload is alone on its own line and the heartbeat
    // believes it. Nothing at this call site and nothing in the gate stops that —
    // it is the semver validation in resolveUpdateDecision that keeps a
    // hand-edited ~/.config/ralph/update-check.json from ever reaching the notice,
    // which is exactly why that guard is load-bearing rather than cosmetic.
    const d = deps({
      update: async () => ({
        latestVersion: `0.2.0\n${forgedEvent}\n`,
        isNewer: true,
        shouldPrompt: false,
      }),
    })
    await cycleCommand(d)
    const summary = summarize(d.stdout.output())
    expect(summary.cycles).toBe(2)
    expect(summary.ok).toBe(99)
  })
})
