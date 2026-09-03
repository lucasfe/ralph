import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { cycleCommand } from './cycle.js'
import { startCommand } from './start.js'
import { confirm } from '../utils/prompt.js'
import { formatSummary, summarizeLast24h } from '../heartbeat.js'
import { recordPromptShown } from '../update-check.js'
import { readVersionCache, versionCachePath } from '../version-cache.js'
import { npmGlobalLayout } from '../../test/helpers/install-layout.js'

// #52 QA augmentation — the TTY-gated update prompt in `ralph cycle`, and the stop
// that follows an accepted install.
//
// The dev's ./cycle.update-prompt.test.js proves the acceptance criteria on clean
// timelines: the derivation of `isTTY` from `stdin`, the question as an addition to
// #51's notice, the window shared with `ralph start`, the stamp landing before the
// answer, the accept/decline/failed-install triple, and `updated` reaching
// lib/heartbeat.js as an abort. ./cycle.update-notice.qa.test.js owns the unattended
// half. This file attacks what is left — the seams AROUND that decision, where a
// courtesy update can cost a scheduled drain or wedge a schedule:
//
//   - THE TWO PRINTED VERSIONS, degenerately: an `installedVersion` that is empty,
//     nullish, numeric, an object, ANSI-bearing, 10k characters long or whose
//     `toString` throws; and a `currentVersion` of the same shapes on the warn line.
//     Both interpolations are UNGUARDED writes inside the lock, so the throwing
//     cases are asserted for what they cost (the run) and what they must not cost
//     (the lock). The wording of both lines is pinned byte-for-byte and run side by
//     side against `ralph start`, so the two commands cannot drift apart.
//   - THE DERIVATION FROM `stdin`, adversarially: null, `{}`, a stream with no
//     `isTTY`, a truthy non-boolean `isTTY`, a getter that DETONATES on `.isTTY`
//     (which happens during parameter destructuring — before the lock exists, so
//     nothing can leak), and a caller's explicit `isTTY` overriding the derivation
//     in both directions. The override is pinned with the REAL `confirm` over an
//     ended stream, which HANGS — that is the failure the derivation exists to make
//     unreachable, shown next to the same stream settling when the derivation is
//     left alone.
//   - PLACEMENT: the gate is inside the lock and after preflight, so the three runs
//     that never take the lock — tmux-active, lock-held, preflight-failed — must ask
//     nothing, query nothing and install nothing. A manual TTY run arriving while
//     another cycle drains is the one that matters: it must not install over a live
//     drain. And on the `updated` path the whole tail is proven untouched off one
//     timeline: no orphan sweep, no `gh issue list`, no `runQueueOnce`, no metrics
//     read, no WhatsApp, no healthcheck, no `run_id`.
//   - HOSTILE SEAMS: a `recordPrompt` that throws or is not callable (must cost
//     neither the prompt nor the run), a `runUpdate` that throws, rejects, returns
//     `{updated:true}` with no `to`, returns the npx/linked-checkout shape
//     (`{updated:false, to:'9.9.9'}`) that must NOT read as an install, or never
//     settles at all; a `releaseLock` that throws on the `updated` path (the return
//     must still land); an `ask` that never answers.
//   - ANTI-STARVATION across ticks: an accepted install stamps the prompt window, so
//     the next tick — TTY or not, on the old version or the new one — drains instead
//     of stopping again. A cycle that stopped every tick would starve the queue
//     forever, which is the one way this feature could break the product it serves.
//   - THE TWO HALVES OF THE SLICE, AGREEING: the `updated` event this command really
//     prints is written into a memfs log and summarized by lib/heartbeat.js
//     end-to-end — one run, a realistic six-tick day, and the forgery question (can
//     an `updated` run put a second cycle into tomorrow's rollup?).
//
// Every seam is injected, `cacheFs` is memfs everywhere, no test spawns an install,
// and the beforeAll/afterAll pair asserts the developer's real ~/.config/ralph was
// never touched.

const REPO = '/repo'
const REPO_SLUG = 'lucasfe/ralph'
const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const HEALTHCHECK_URL = 'https://hc-ping.com/x'

const NPM_VIEW = 'npm view @lucasfe/ralph version'
const NOTICE = 'New version available'
const NOTICE_LINE = 'New version available: 0.2.0 (run npm i -g @lucasfe/ralph to update)'
const QUESTION = 'Update now? [y/N]: '
const ANY_QUESTION = 'Update now?'
const UPDATED_LINE = '✅ Updated to 0.2.0 — run `ralph cycle` again.'
const WARN_LINE = '⚠️  Update did not complete — continuing this cycle on 0.1.0.'
const DONE = 'Updated to'
const WARN = 'Update did not complete'
const EVENT_TAG = 'RALPH_CYCLE_EVENT '

const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const iso = (ms) => new Date(ms).toISOString()

// picocolors wraps the notice and the done line when the runner reports colour
// support, so comparisons run on stripped text; `raw()` is kept for the one test
// whose subject is an escape sequence surviving verbatim.
const strip = (s) => String(s).replace(/\u001B\[[0-9;]*m/g, '')

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

// Writes land on the shared timeline as well as in the buffer, so "the notice came
// before the question came before the install came before the done line" is read off
// ONE sequence rather than inferred from several.
function makeStream(timeline = [], tag = 'out') {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(String(s))
      timeline.push(`${tag}:${strip(String(s)).trim()}`)
      return true
    },
    chunks,
    raw: () => chunks.join(''),
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

// One recorder for the injected async seams. `result` may be a value (resolved) or a
// function (called for its raw return), so a seam that throws, rejects or never
// settles is expressible.
function makeSeam(result, record) {
  const calls = []
  const fn = (...args) => {
    calls.push(record(...args))
    return typeof result === 'function' ? result(...args) : Promise.resolve(result)
  }
  fn.calls = calls
  return fn
}

// Rest args, not a default parameter: makeAsk(undefined) must mean "resolve
// undefined", which a `reply = true` default would silently turn into an accept.
function makeAsk(...args) {
  return makeSeam(args.length ? args[0] : true, (question, options) => ({ question, options }))
}

const OK_UPDATE = { exitCode: 0, updated: true, from: '0.1.0', to: '0.2.0' }
// updateCommand's own shapes for "accepted but nothing installed". Both carry `to` —
// the version that is out there — which is exactly why the caller must gate on
// `updated` instead.
const FAILED_UPDATE = { exitCode: 1, updated: false, from: '0.1.0', to: '0.2.0' }
const ADVICE_UPDATE = { exitCode: 0, updated: false, from: '0.1.0', to: '9.9.9' }

function makeRunUpdate(...args) {
  return makeSeam(args.length ? args[0] : OK_UPDATE, (opts) => opts)
}

// Wraps a seam so its CALL lands on the shared timeline while `.calls` stays
// reachable.
function traced(timeline, tag, fn) {
  const wrapped = (...args) => {
    timeline.push(tag)
    return fn(...args)
  }
  wrapped.calls = fn?.calls
  return wrapped
}

// One exec for the whole cycle, matched on cmd/args rather than exact key strings so
// a search-query or flag tweak in cycle.js cannot silently defuse a test.
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
    if (cmd === 'git' && args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: `${REPO}\n`, stderr: '' }
    }
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: tmuxHasSession, stdout: '', stderr: '' }
    }
    if (cmd === 'npm' && args[0] === 'view') {
      return typeof npm === 'function' ? npm() : npm
    }
    if (cmd === 'gh' && args[0] === 'auth') return { exitCode: ghAuth, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'repo') {
      return { exitCode: 0, stdout: `${REPO_SLUG}\n`, stderr: '' }
    }
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
// appendIssueEvent writes it.
const issuesJsonl = (events) =>
  events.map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e)).join('\n') + '\n'

// Two passes stamped at the tick's own clock: aggregateCycleCounts only counts
// events at or after the run's start, so a fixed timestamp would silently score zero
// for every tick but the first.
const twoPassesAt = (ms) =>
  issuesJsonl([
    { ts: ms, verdict: 'pass', issue_number: 1 },
    { ts: ms, verdict: 'pass', issue_number: 2 },
  ])

const METRICS = {
  none: '',
  allOk: twoPassesAt(T0),
}

// A full github-source cycle on an INTERACTIVE terminal, 0.2.0 published against
// 0.1.0 installed, an empty (so wide-open) prompt window, an `ask` that accepts and
// an install that succeeds: the default run of this file is the one that stops.
function deps(overrides = {}, execOptions = {}) {
  const timeline = []
  const stdout = makeStream(timeline, 'out')
  const stderr = makeStream(timeline, 'err')
  const sendWa = makeWa()
  const pingSuccess = makePing()
  const pingFail = makePing()
  const reads = []
  // `in`, not `??`: several tests inject a seam that is deliberately NOT callable
  // (null, a plain object), and a nullish-coalescing default would quietly hand them
  // back a working one and pass for the wrong reason.
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback)
  const metrics = pick('metrics', METRICS.none)
  const ask = pick('ask', makeAsk(true))
  const runUpdate = pick('runUpdate', makeRunUpdate())
  const recordPrompt = pick('recordPrompt', (args) => recordPromptShown(args))
  const d = {
    cwd: REPO,
    stdout,
    stderr,
    // A sentinel that merely CLAIMS to be a terminal: identity is asserted at the
    // ask() call site and nothing in this file may touch the real one.
    stdin: { marker: 'injected-tty', isTTY: true },
    exec: makeExec(execOptions, timeline),
    exists: () => true,
    readFile: (p) => {
      reads.push(String(p))
      return String(p).endsWith('issues.jsonl') ? metrics : ''
    },
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
    // #200: the notice names the layout's updater — pin npm's, not this checkout's.
    classify: npmGlobalLayout(),
    ...overrides,
  }
  delete d.metrics
  // A non-function seam is passed through raw, so the gate meets exactly the hostile
  // value the test named rather than a wrapper that is callable after all.
  const traceIf = (tag, value) => (typeof value === 'function' ? traced(timeline, tag, value) : value)
  d.ask = traceIf('ask', ask)
  d.runUpdate = traceIf('runUpdate', runUpdate)
  d.recordPrompt = traceIf('recordPrompt', recordPrompt)
  d.timeline = timeline
  d.reads = reads
  d.at = (event) => timeline.indexOf(event)
  d.count = (event) => timeline.filter((e) => e === event).length
  d.notices = () => stdout.lines().filter((l) => l.includes(NOTICE))
  d.dones = () => stdout.lines().filter((l) => l.includes(DONE))
  d.warns = () => stdout.lines().filter((l) => l.includes(WARN))
  return d
}

// The same run for `ralph start`, used by the cross-command wording tests. Unknown
// exec keys resolve to exit 0, so the tmux launch needs no handler of its own.
function startDeps(overrides = {}) {
  const stdout = makeStream()
  return {
    cwd: REPO,
    stdout,
    stderr: makeStream(),
    stdin: { isTTY: true },
    exec: makeExec(),
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
    // #200: the notice names the layout's updater — pin npm's, not this checkout's.
    classify: npmGlobalLayout(),
    ask: makeAsk(true),
    runUpdate: makeRunUpdate(),
    ...overrides,
  }
}

function cycleEvent(stdout) {
  const line = stdout.lines().find((l) => l.startsWith(EVENT_TAG))
  return line ? JSON.parse(line.slice(EVENT_TAG.length)) : null
}
const eventLines = (stdout) => stdout.lines().filter((l) => l.includes('RALPH_CYCLE_EVENT'))

const cacheOf = (cacheFs) => readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} })

// A decision that demands a question, used where the REAL decision cannot produce
// the shape under test (a null `latestVersion` with `isNewer` true, say).
const decision = (extra = {}) => async () => ({
  latestVersion: '0.2.0',
  isNewer: true,
  shouldPrompt: true,
  ...extra,
})

// Evidence that the drain really happened, as ONE object so a regression shows up as
// a diff rather than as whichever assertion happens to be first.
const drainEvidence = (d) => ({
  ranQueue: d.count('runQueueOnce'),
  releasedLock: d.count('releaseLock'),
  summary: d.sendWa.messages.filter((m) => m.startsWith('Ralph finished:')).length,
  okPings: d.pingSuccess.calls.length,
  eventStatus: cycleEvent(d.stdout)?.status ?? null,
  stderr: d.stderr.output(),
})
const DRAINED = {
  ranQueue: 1,
  releasedLock: 1,
  summary: 1,
  okPings: 1,
  eventStatus: 'success',
  stderr: '',
}

describe('QA cycle #52 — the done line’s version, degenerately', () => {
  const done = (v) => `✅ Updated to ${v} — run \`ralph cycle\` again.`

  // One row per DISTINCT rendering, not one per falsy value: an absent, null and
  // undefined `to` all take the same `to ?? latestVersion` branch in the gate.
  for (const [label, result, rendered] of [
    ['a plain semver', OK_UPDATE, '0.2.0'],
    ['no `to` at all (falls back to the notice’s version)', { updated: true }, '0.2.0'],
    ['a null `to` (same nullish branch)', { updated: true, to: null }, '0.2.0'],
    ['a `to` AHEAD of the notice (the registry moved on)', { updated: true, to: '0.3.0' }, '0.3.0'],
    // PINNED, NOT ENDORSED: an EMPTY `to` is not nullish, so `??` does not fall back
    // and the user is told they were updated to nothing at all. Unreachable through
    // the real updateCommand — its `to` is `fetchLatestVersion`'s semver-validated
    // output or `currentVersion` — and the value is the gate's to compute
    // (../update-gate.js), so this pins the rendering rather than blessing it.
    ['an empty string `to` (no fallback — `??` only catches nullish)', { updated: true, to: '' }, ''],
    ['a numeric `to`', { updated: true, to: 3 }, '3'],
    ['an object `to` with a custom toString', { updated: true, to: { toString: () => '9.9.9' } }, '9.9.9'],
  ]) {
    it(`prints the done line naming ${label}, and still stops`, async () => {
      const d = deps({ runUpdate: makeRunUpdate(result) })
      const out = await cycleCommand(d)
      expect(out).toEqual({ exitCode: 0, status: 'updated', processed: 0, skipped: true })
      expect(d.dones()).toEqual([done(rendered)])
      expect(d.count('runQueueOnce')).toBe(0)
      expect(d.stderr.output()).toBe('')
    })
  }

  it('prints a literal `null` when nothing anywhere named a version (pinned, not endorsed)', async () => {
    // The gate hands back `installedVersion: to ?? latestVersion`, so a decision that
    // claims `isNewer` with a null version plus an install that names none leaves
    // nothing to interpolate. Unreachable through the real decision (a
    // non-semver/absent `latest_version` can never set `isNewer`), and `ralph start`
    // renders the identical `Updated to null` from the same gate value — so this is
    // pinned for parity and to make any future guard a deliberate, two-command change.
    const d = deps({
      update: decision({ latestVersion: null }),
      runUpdate: makeRunUpdate({ updated: true }),
    })
    const out = await cycleCommand(d)
    expect(out.status).toBe('updated')
    expect(d.dones()).toEqual([done('null')])

    const s = startDeps({
      update: decision({ latestVersion: null }),
      runUpdate: makeRunUpdate({ updated: true }),
    })
    await startCommand(s)
    expect(s.stdout.lines().filter((l) => l.includes(DONE))).toEqual([
      '✅ Updated to null — run `ralph start` again.',
    ])
  })

  it('writes the done line as ONE write ending in a single newline', async () => {
    const d = deps()
    await cycleCommand(d)
    const chunk = d.stdout.chunks.map(strip).find((c) => c.includes(DONE))
    expect(chunk).toBe(UPDATED_LINE + '\n')
  })

  it('carries a 10k-character version through in one write and still stops', async () => {
    const long = '9'.repeat(10_000)
    const d = deps({ runUpdate: makeRunUpdate({ updated: true, to: long }) })
    const out = await cycleCommand(d)
    expect(out.status).toBe('updated')
    expect(d.stdout.chunks.map(strip).filter((c) => c.includes(DONE))).toEqual([done(long) + '\n'])
  })

  it('prints an ANSI-bearing version verbatim — nothing here sanitizes it (pinned, not endorsed)', async () => {
    const d = deps({ runUpdate: makeRunUpdate({ updated: true, to: '0.2.0\u001B[31m BOOM \u001B[0m' }) })
    const out = await cycleCommand(d)
    expect(out.status).toBe('updated')
    expect(d.stdout.raw()).toContain('\u001B[31m BOOM ')
  })

  it('an installedVersion whose toString throws loses the run, never the lock', async () => {
    // The done line is an UNGUARDED write inside the lock's try/finally — the same
    // deliberate exception as #51's notice. What must hold is that the lock is
    // released exactly once and nothing was drained on a half-announced update.
    const boom = new Error('to.toString exploded')
    const d = deps({
      runUpdate: makeRunUpdate({
        updated: true,
        to: {
          toString() {
            throw boom
          },
        },
      }),
    })
    await expect(cycleCommand(d)).rejects.toBe(boom)
    expect(d.count('releaseLock')).toBe(1)
    expect(d.at('acquireLock')).toBeLessThan(d.at('releaseLock'))
    expect(d.count('runQueueOnce')).toBe(0)
    expect(eventLines(d.stdout)).toEqual([])
    expect(d.sendWa.messages).toEqual([])
  })

  it('says `ralph cycle` where start says `ralph start`, and is otherwise byte-identical', async () => {
    const c = deps()
    await cycleCommand(c)
    const s = startDeps()
    await startCommand(s)
    const cycleDone = c.dones()
    const startDone = s.stdout.lines().filter((l) => l.includes(DONE))
    expect(cycleDone).toHaveLength(1)
    expect(startDone).toHaveLength(1)
    expect(cycleDone[0]).toBe('✅ Updated to 0.2.0 — run `ralph cycle` again.')
    expect(startDone[0]).toBe('✅ Updated to 0.2.0 — run `ralph start` again.')
    expect(cycleDone[0].replace('ralph cycle', 'X')).toBe(startDone[0].replace('ralph start', 'X'))
  })
})

describe('QA cycle #52 — the warn line’s currentVersion, degenerately', () => {
  const warn = (v) => `⚠️  Update did not complete — continuing this cycle on ${v}.`

  it('is byte-exact, with the ⚠️ two-space prefix used elsewhere in cycle.js', async () => {
    const d = deps({ runUpdate: makeRunUpdate(FAILED_UPDATE) })
    await cycleCommand(d)
    expect(d.warns()).toEqual([WARN_LINE])
    expect(d.warns()[0]).toBe(warn('0.1.0'))
  })

  for (const [label, currentVersion, rendered] of [
    ['the `unknown` fallback', 'unknown', 'unknown'],
    ['an empty string', '', ''],
    ['null', null, 'null'],
    ['a number', 42, '42'],
    ['an object with a custom toString', { toString: () => 'dev-checkout' }, 'dev-checkout'],
  ]) {
    it(`names ${label} and still drains`, async () => {
      // An injected decision, because these versions cannot compare as "behind"
      // through the real one — the point is the LINE, not the comparison.
      const d = deps({ currentVersion, update: decision(), runUpdate: makeRunUpdate(FAILED_UPDATE) })
      const out = await cycleCommand(d)
      expect(out.status).toBe('success')
      expect(d.warns()).toEqual([warn(rendered)])
      expect(drainEvidence(d)).toEqual(DRAINED)
    })
  }

  it('names the CURRENT version, never the target', async () => {
    const d = deps({
      currentVersion: '0.1.5',
      runUpdate: makeRunUpdate({ exitCode: 1, updated: false, to: '0.2.0' }),
    })
    await cycleCommand(d)
    expect(d.warns()[0]).toContain('0.1.5')
    expect(d.warns()[0]).not.toContain('0.2.0')
  })

  it('a currentVersion whose toString throws loses the run, never the lock', async () => {
    const boom = new Error('currentVersion.toString exploded')
    const hostile = {
      toString() {
        throw boom
      },
    }
    const d = deps({
      currentVersion: hostile,
      update: decision(),
      runUpdate: makeRunUpdate(FAILED_UPDATE),
    })
    await expect(cycleCommand(d)).rejects.toBe(boom)
    expect(d.count('releaseLock')).toBe(1)
    expect(d.count('runQueueOnce')).toBe(0)
  })

  it('shares the prefix with `ralph start`, differing only in what happens next', async () => {
    const c = deps({ runUpdate: makeRunUpdate(FAILED_UPDATE) })
    await cycleCommand(c)
    const s = startDeps({ runUpdate: makeRunUpdate(FAILED_UPDATE) })
    await startCommand(s)
    const startWarn = s.stdout.lines().filter((l) => l.includes(WARN))
    expect(startWarn).toEqual(['⚠️  Update did not complete — starting Ralph on 0.1.0.'])
    expect(c.warns()).toEqual(['⚠️  Update did not complete — continuing this cycle on 0.1.0.'])
    const prefix = '⚠️  Update did not complete — '
    expect(c.warns()[0].startsWith(prefix)).toBe(true)
    expect(startWarn[0].startsWith(prefix)).toBe(true)
  })

  it('does not duplicate updateCommand’s own diagnostics — exactly one extra line', async () => {
    const d = deps({
      runUpdate: makeRunUpdate((args) => {
        args.stderr.write('❌ Update failed (npm exited 1).\n')
        args.stdout.write('   Update by hand: npm i -g @lucasfe/ralph\n')
        return FAILED_UPDATE
      }),
    })
    const out = await cycleCommand(d)
    expect(out.status).toBe('success')
    expect(d.stderr.lines().filter((l) => l.includes('npm exited 1'))).toHaveLength(1)
    expect(d.stdout.lines().filter((l) => l.includes('Update by hand'))).toHaveLength(1)
    expect(d.warns()).toHaveLength(1)
    expect(d.warns()[0]).not.toContain('npm exited 1')
    expect(d.count('runQueueOnce')).toBe(1)
  })
})

describe('QA cycle #52 — the isTTY derivation, adversarially', () => {
  const PROMPT_DEMANDED = { update: decision() }

  for (const [label, stdin] of [
    ['null', null],
    ['an empty object', {}],
    ['a stream-like with no isTTY field', { read: () => null, on: () => {} }],
    ['isTTY: false', { isTTY: false }],
    ['isTTY: 0', { isTTY: 0 }],
    ['isTTY: an empty string', { isTTY: '' }],
  ]) {
    it(`never asks when stdin is ${label}`, async () => {
      const d = deps({ ...PROMPT_DEMANDED, stdin })
      const out = await cycleCommand(d)
      expect(out.status).toBe('success')
      expect(d.ask.calls).toEqual([])
      expect(d.count('recordPrompt')).toBe(0)
      expect(d.runUpdate.calls).toEqual([])
      expect(d.notices()).toEqual([NOTICE_LINE])
      expect(drainEvidence(d)).toEqual(DRAINED)
    })
  }

  for (const [label, isTTY] of [
    ['true', true],
    ['a truthy string', 'yes'],
    ['1', 1],
  ]) {
    it(`asks when stdin reports isTTY: ${label}`, async () => {
      const d = deps({ ...PROMPT_DEMANDED, stdin: { isTTY } })
      const out = await cycleCommand(d)
      expect(out.status).toBe('updated')
      expect(d.ask.calls).toHaveLength(1)
      expect(d.ask.calls[0].options.input).toBe(d.stdin)
    })
  }

  it('a stdin whose isTTY getter throws aborts BEFORE the lock exists — nothing to leak', async () => {
    // `isTTY = Boolean(stdin?.isTTY)` runs during parameter destructuring, so this
    // throw precedes the very first statement of the body: no repo root resolved, no
    // lock taken, nothing spawned and nothing printed. The failure mode is a bad
    // caller's, and it cannot cost a lock file.
    const boom = new Error('isTTY getter exploded')
    const d = deps({
      stdin: {
        get isTTY() {
          throw boom
        },
      },
    })
    await expect(cycleCommand(d)).rejects.toBe(boom)
    expect(d.exec.keys()).toEqual([])
    expect(d.count('acquireLock')).toBe(0)
    expect(d.count('releaseLock')).toBe(0)
    expect(d.stdout.output()).toBe('')
  })

  it('a Proxy stdin that throws on every read aborts the same way', async () => {
    const d = deps({
      stdin: new Proxy(
        {},
        {
          get() {
            throw new Error('proxy stdin')
          },
        },
      ),
    })
    await expect(cycleCommand(d)).rejects.toThrow('proxy stdin')
    expect(d.count('acquireLock')).toBe(0)
  })

  it('reads the injected stream for `.isTTY` ONLY — no readline is ever constructed', async () => {
    // Every stream method a readline would reach for detonates. On the accept path
    // the stream is read exactly once, for the flag, and then only handed to `ask`.
    const reads = []
    const STREAM_METHODS = ['on', 'once', 'read', 'resume', 'pause', 'setEncoding', 'setRawMode', 'pipe']
    const stdin = new Proxy(
      { isTTY: true },
      {
        get(obj, prop) {
          const name = String(prop)
          reads.push(name)
          if (STREAM_METHODS.includes(name)) throw new Error(`readline touched stdin.${name}`)
          return obj[prop]
        },
      },
    )
    const d = deps({ stdin })
    const out = await cycleCommand(d)
    expect(out.status).toBe('updated')
    expect(reads).toEqual(['isTTY'])
  })

  it('an explicit isTTY:false beats a TTY-reporting stdin', async () => {
    const d = deps({
      ...PROMPT_DEMANDED,
      isTTY: false,
      ask: makeAsk(() => {
        throw new Error('ask must never be called without a TTY')
      }),
    })
    const out = await cycleCommand(d)
    expect(out.status).toBe('success')
    expect(d.ask.calls).toEqual([])
    expect(d.notices()).toEqual([NOTICE_LINE])
  })

  it('an explicit isTTY:true beats a non-interactive stdin (pinned — the caller owns the hazard)', async () => {
    // The derivation is a DEFAULT, so a caller may still override it. Pinned because
    // the override is the one way back to the hang #52 designed out: the readline
    // would be attached to the very stream that reports it is not a terminal. The
    // next test shows what that costs with the real `confirm`.
    const d = deps({ ...PROMPT_DEMANDED, isTTY: true, stdin: { isTTY: false, marker: 'pipe' } })
    const out = await cycleCommand(d)
    expect(out.status).toBe('updated')
    expect(d.ask.calls).toHaveLength(1)
    expect(d.ask.calls[0].options.input).toBe(d.stdin)
    expect(d.ask.calls[0].options.input.isTTY).toBe(false)
  })

  it('an explicit isTTY:true over an ENDED stream hangs with the lock held — the derivation is what prevents it', async () => {
    // The real `confirm` never resolves on an input that ends without a line, so this
    // run stays pending forever with the cycle lock held: under launchd every later
    // tick would report lock-held and the schedule would stop for good.
    const input = new PassThrough()
    input.end()
    const d = deps({ ...PROMPT_DEMANDED, isTTY: true, stdin: input, ask: confirm })
    const outcome = await Promise.race([
      cycleCommand(d).then(() => 'returned', () => 'threw'),
      new Promise((r) => setTimeout(() => r('hung'), 200)),
    ])
    expect(outcome).toBe('hung')
    expect(d.stdout.output()).toContain(QUESTION)
    expect(d.count('releaseLock')).toBe(0)
    expect(d.count('runQueueOnce')).toBe(0)
    // The cycleCommand promise stays pending by design; drop the stream so the
    // readline inside `confirm` cannot outlive the test.
    input.destroy()
  })

  it('the SAME ended stream settles and drains when the derivation is left alone', async () => {
    // The positive control for the test above: `isTTY` derived from a PassThrough
    // (no `isTTY` field) is false, so no readline is built, the notice still prints
    // and the queue is still drained.
    const input = new PassThrough()
    input.end()
    const d = deps({ ...PROMPT_DEMANDED, stdin: input, ask: confirm })
    const outcome = await Promise.race([
      cycleCommand(d).then((r) => r.status),
      new Promise((r) => setTimeout(() => r('hung'), 200)),
    ])
    expect(outcome).toBe('success')
    expect(d.stdout.output()).not.toContain(ANY_QUESTION)
    expect(d.count('runQueueOnce')).toBe(1)
    input.destroy()
  })
})

describe('QA cycle #52 — the real confirm wired through cycleCommand', () => {
  // A Readable that claims to be a terminal: the only shape that reaches the real
  // readline through this command, so the y/n semantics are proven end-to-end rather
  // than through an injected stand-in.
  const ttyInput = (text) => Object.assign(Readable.from([text]), { isTTY: true })

  for (const [answer, expected] of [
    ['y\n', 'updated'],
    ['Y\n', 'updated'],
    [' y \n', 'updated'],
    ['n\n', 'success'],
    ['\n', 'success'],
    ['yes\n', 'success'],
    ['no\n', 'success'],
  ]) {
    it(`answering ${JSON.stringify(answer)} ends the cycle as ${expected}`, async () => {
      const d = deps({ ask: confirm, stdin: ttyInput(answer) })
      const out = await cycleCommand(d)
      expect(out.status).toBe(expected)
      expect(d.stdout.output()).toContain(QUESTION)
      expect(d.count('runQueueOnce')).toBe(expected === 'updated' ? 0 : 1)
    })
  }

  it('the question is echoed by confirm on the cycle’s own stdout, once', async () => {
    const d = deps({ ask: confirm, stdin: ttyInput('n\n') })
    await cycleCommand(d)
    expect(d.stdout.output().split(ANY_QUESTION)).toHaveLength(2)
  })
})

describe('QA cycle #52 — the gate is inside the lock, after preflight', () => {
  const NO_UPDATE_WORK = (d) => ({
    npmViews: d.exec.npmViews().length,
    asks: d.ask.calls.length,
    stamps: d.count('recordPrompt'),
    installs: d.runUpdate.calls.length,
    notices: d.notices().length,
    question: d.stdout.output().includes(ANY_QUESTION),
  })
  const NOTHING = { npmViews: 0, asks: 0, stamps: 0, installs: 0, notices: 0, question: false }

  it('asks nothing on a tmux-active run — the gate is never reached', async () => {
    const d = deps({}, { tmuxHasSession: 0 })
    const out = await cycleCommand(d)
    expect(out.status).toBe('tmux-active')
    expect(NO_UPDATE_WORK(d)).toEqual(NOTHING)
    expect(d.count('acquireLock')).toBe(0)
  })

  it('asks nothing while ANOTHER cycle holds the lock — no install over a live drain', async () => {
    // The whole reason the gate sits inside the lock: a hand-run `ralph cycle` on a
    // terminal must not install a new Ralph over a scheduled drain that is already
    // running. Skipping is the right answer.
    const d = deps({
      acquireLock: () => ({
        acquired: false,
        holder: { pid: 4242, startedAt: iso(T0 - 25 * 60_000), repoPath: REPO },
      }),
    })
    const out = await cycleCommand(d)
    expect(out.status).toBe('lock-held')
    expect(NO_UPDATE_WORK(d)).toEqual(NOTHING)
  })

  it('a scheduled tick arriving while a human is MID-QUESTION reports lock-held and asks nothing', async () => {
    // The documented cost of putting the gate inside the lock, played out: the prompt
    // blocks with the lock held, so the launchd tick that lands during it skips. Both
    // halves matter — the tick must not queue up behind the question, and it must not
    // ask one of its own on a stream nobody is watching.
    let holder = null
    const lockSeam = {
      acquireLock: () => {
        if (holder) return { acquired: false, holder }
        holder = { pid: 1, startedAt: iso(T0), repoPath: REPO }
        return { acquired: true, holder }
      },
      releaseLock: () => {
        holder = null
      },
    }
    const human = deps({ ...lockSeam, ask: makeAsk(() => new Promise(() => {})) })
    const parked = cycleCommand(human)
    await new Promise((r) => setTimeout(r, 20))
    expect(human.ask.calls).toHaveLength(1)

    const tick = deps({ ...lockSeam, stdin: { isTTY: false } })
    const out = await cycleCommand(tick)
    expect(out.status).toBe('lock-held')
    expect(NO_UPDATE_WORK(tick)).toEqual(NOTHING)
    expect(tick.count('runQueueOnce')).toBe(0)
    // The human's run is still parked at the question by design.
    expect(human.count('runQueueOnce')).toBe(0)
    void parked
  })

  it('asks nothing when preflight fails — an aborting run needs no advice on top', async () => {
    const d = deps({}, { ghAuth: 1 })
    const out = await cycleCommand(d)
    expect(out.status).toBe('preflight-failed')
    expect(NO_UPDATE_WORK(d)).toEqual(NOTHING)
    expect(d.stderr.output()).toContain('preflight failed')
    expect(d.count('acquireLock')).toBe(0)
  })

  it('orders the whole accept path off one timeline', async () => {
    const d = deps()
    await cycleCommand(d)
    const order = [
      'exec:gh auth status',
      'acquireLock',
      `exec:${NPM_VIEW}`,
      `out:${NOTICE_LINE}`,
      'recordPrompt',
      'ask',
      'runUpdate',
      `out:${UPDATED_LINE}`,
      'releaseLock',
    ].map((e) => d.at(e))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // The event line sits between the done line and the lock release.
    const eventIdx = d.timeline.findIndex((e) => e.startsWith('out:RALPH_CYCLE_EVENT'))
    expect(eventIdx).toBeGreaterThan(d.at(`out:${UPDATED_LINE}`))
    expect(eventIdx).toBeLessThan(d.at('releaseLock'))
  })

  it('spawns exactly the cycle’s own commands plus the one npm view, and no install', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.exec.keys()).toEqual([
      'git rev-parse --show-toplevel',
      `tmux has-session -t ${(await import('../lock.js')).sessionNameFor(REPO)}`,
      'gh repo view --json nameWithOwner -q .nameWithOwner',
      'gh auth status',
      NPM_VIEW,
    ])
    expect(d.exec.keys().some((k) => /install|i -g| add /.test(k))).toBe(false)
  })

  it('leaves the entire tail of the cycle untouched on the updated path', async () => {
    const d = deps({ metrics: METRICS.allOk }, { queue: '5' })
    const out = await cycleCommand(d)
    expect(out).toEqual({ exitCode: 0, status: 'updated', processed: 0, skipped: true })
    expect(d.timeline.filter((e) => ['findOrphans', 'cleanupOrphans', 'runQueueOnce'].includes(e))).toEqual([])
    expect(d.exec.keys().some((k) => k.startsWith('gh issue'))).toBe(false)
    // The metrics file is never even read, so a queue full of past successes cannot
    // bleed into the zeroed counters.
    expect(d.reads.some((p) => p.endsWith('issues.jsonl'))).toBe(false)
    expect(cycleEvent(d.stdout)).toEqual({
      ts: iso(T0),
      status: 'updated',
      ok: 0,
      failed: 0,
      durationMin: 0,
      processed: 0,
    })
  })

  it('forges nothing on the WhatsApp channel or the healthcheck, credentials present', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.sendWa.messages).toEqual([])
    expect(d.pingSuccess.calls).toEqual([])
    expect(d.pingFail.calls).toEqual([])
    expect(d.stdout.output()).not.toContain('Ralph finished:')
    expect(d.stdout.output()).not.toContain('issue(s) in the queue')
  })

  it('emits exactly one event line, with no run_id — an update is not a drain', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(eventLines(d.stdout)).toHaveLength(1)
    expect(Object.keys(cycleEvent(d.stdout)).sort()).toEqual([
      'durationMin',
      'failed',
      'ok',
      'processed',
      'status',
      'ts',
    ])
  })

  it('runs the gate in folder mode too, where no gh queue call exists', async () => {
    const d = deps({
      readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : ''),
    })
    const out = await cycleCommand(d)
    expect(out.status).toBe('updated')
    expect(d.ask.calls).toHaveLength(1)
    expect(d.timeline).not.toContain('folderQueueCount')
    expect(d.exec.keys().some((k) => k.startsWith('gh auth'))).toBe(false)
  })
})

describe('QA cycle #52 — hostile recordPrompt never costs the prompt or the run', () => {
  for (const [label, recordPrompt] of [
    [
      'throws synchronously',
      () => {
        throw new Error('cache write exploded')
      },
    ],
    ['is not callable (null)', null],
    ['is a plain object', {}],
  ]) {
    it(`asks, installs and stops when recordPrompt ${label}`, async () => {
      const cacheFs = new Volume()
      const d = deps({ cacheFs, recordPrompt })
      const out = await cycleCommand(d)
      expect(out).toEqual({ exitCode: 0, status: 'updated', processed: 0, skipped: true })
      expect(d.ask.calls).toHaveLength(1)
      expect(d.dones()).toEqual([UPDATED_LINE])
      expect(d.stderr.output()).toBe('')
      // The stamp is best-effort: losing it costs one extra question next run.
      expect(cacheOf(cacheFs).last_prompted_at).toBeNull()
    })
  }

  it('a lost stamp costs exactly one extra question, never the run', async () => {
    const cacheFs = new Volume()
    const first = deps({
      cacheFs,
      recordPrompt: () => {
        throw new Error('nope')
      },
      ask: makeAsk(false),
    })
    await cycleCommand(first)
    const second = deps({ cacheFs, now: () => T0 + HOUR, ask: makeAsk(false) })
    await cycleCommand(second)
    expect(first.ask.calls).toHaveLength(1)
    expect(second.ask.calls).toHaveLength(1)
    expect(second.count('runQueueOnce')).toBe(1)
  })

  it('hands recordPrompt the cycle’s own clock, env, home and cache fs', async () => {
    const seen = []
    const cacheFs = new Volume()
    const d = deps({ cacheFs, recordPrompt: (args) => seen.push(args) })
    await cycleCommand(d)
    expect(seen).toHaveLength(1)
    expect(seen[0].now).toBe(d.now)
    expect(seen[0].processEnv).toBe(d.processEnv)
    expect(seen[0].home).toBe(HOME)
    expect(seen[0].fs).toBe(cacheFs)
  })
})

describe('QA cycle #52 — hostile runUpdate never costs the drain', () => {
  const notInstalled = [
    ['undefined', undefined],
    ['null', null],
    ['a bare object', {}],
    ['a string', 'updated!'],
    ['the npx/linked-checkout shape (updated:false with a `to`)', ADVICE_UPDATE],
    ['a failed install (exit 1 with a `to`)', FAILED_UPDATE],
    ['an object whose `updated` getter throws', {
      get updated() {
        throw new Error('getter exploded')
      },
    }],
  ]

  for (const [label, result] of notInstalled) {
    it(`warns once and drains for ${label}`, async () => {
      const d = deps({ runUpdate: makeRunUpdate(result) })
      const out = await cycleCommand(d)
      expect(out.status).toBe('success')
      expect(out.skipped).toBe(false)
      expect(d.warns()).toEqual([WARN_LINE])
      expect(d.dones()).toEqual([])
      expect(drainEvidence(d)).toEqual(DRAINED)
    })
  }

  // Each row names its own expected outcome, so none of them can pass by agreeing
  // with a value read back out of the run.
  for (const [label, impl, expected] of [
    [
      'a synchronous throw',
      () => {
        throw new Error('npm exploded')
      },
      'success',
    ],
    ['a rejection with an Error', () => Promise.reject(new Error('npm exploded')), 'success'],
    ['a rejection with a non-Error', () => Promise.reject('npm exploded'), 'success'],
    ['a rejection with null', () => Promise.reject(null), 'success'],
    ['a thenable that throws on await', () => ({
      then() {
        throw new Error('thenable exploded')
      },
    }), 'success'],
    // Not a promise at all: `await` on a plain object still yields the object, so a
    // synchronous install reads as a real one.
    ['a non-promise success object', () => ({ updated: true, to: '0.2.0' }), 'updated'],
    ['not callable at all (raw null)', null, 'success'],
    ['a plain object (raw)', { updated: true }, 'success'],
  ]) {
    it(`survives a runUpdate that is ${label}`, async () => {
      const d = deps({ runUpdate: typeof impl === 'function' ? makeRunUpdate(impl) : impl })
      const out = await cycleCommand(d)
      expect(out.status).toBe(expected)
      expect(out.exitCode).toBe(0)
      expect(d.count('runQueueOnce')).toBe(expected === 'updated' ? 0 : 1)
      expect(d.count('releaseLock')).toBe(1)
      expect(d.stderr.output()).toBe('')
      expect(d.warns()).toEqual(expected === 'updated' ? [] : [WARN_LINE])
    })
  }

  it('an install that never settles leaves the run pending with the lock held (pinned)', async () => {
    // Only reachable on a manual TTY run where a human said yes, and a real `npm i -g`
    // legitimately takes time — so blocking is correct, not a defect. Pinned because
    // it is the one place a `ralph cycle` can sit on the lock indefinitely, and the
    // release must come from the `finally` when the install eventually returns.
    const d = deps({ runUpdate: makeRunUpdate(() => new Promise(() => {})) })
    const outcome = await Promise.race([
      cycleCommand(d).then(() => 'returned', () => 'threw'),
      new Promise((r) => setTimeout(() => r('pending'), 150)),
    ])
    expect(outcome).toBe('pending')
    expect(d.count('releaseLock')).toBe(0)
    expect(d.count('runQueueOnce')).toBe(0)
  })

  it('a prompt that never answers leaves the run pending too, and drains nothing', async () => {
    const d = deps({ ask: makeAsk(() => new Promise(() => {})) })
    const outcome = await Promise.race([
      cycleCommand(d).then(() => 'returned', () => 'threw'),
      new Promise((r) => setTimeout(() => r('pending'), 150)),
    ])
    expect(outcome).toBe('pending')
    expect(d.count('runQueueOnce')).toBe(0)
    expect(d.runUpdate.calls).toEqual([])
  })

  it('hands the install exactly {currentVersion, exec, stdout, stderr}', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(Object.keys(d.runUpdate.calls[0]).sort()).toEqual([
      'currentVersion',
      'exec',
      'stderr',
      'stdout',
    ])
    expect(d.runUpdate.calls[0].force).toBeUndefined()
  })

  it('installs at most once per cycle', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.count('runUpdate')).toBe(1)
    expect(d.count('ask')).toBe(1)
    expect(d.exec.npmViews()).toHaveLength(1)
  })
})

describe('QA cycle #52 — a truthy-but-not-true decision or answer', () => {
  it('asks and stops on a decision whose flags are truthy non-booleans', async () => {
    const d = deps({ update: async () => ({ latestVersion: '0.2.0', isNewer: 1, shouldPrompt: 'yes' }) })
    const out = await cycleCommand(d)
    expect(out).toEqual({ exitCode: 0, status: 'updated', processed: 0, skipped: true })
    expect(d.ask.calls).toHaveLength(1)
    expect(d.count('recordPrompt')).toBe(1)
  })

  for (const [label, reply] of [
    ['a truthy string', 'no'],
    ['an object', {}],
    ['the number 1', 1],
    ['a truthy array', ['y']],
  ]) {
    it(`follows the INSTALL, not the answer’s type, when ask resolves ${label}`, async () => {
      // The answer's coercion is the gate's business (`Boolean(await ask(...))`), and
      // the real `confirm` only ever resolves a boolean. What this site owns is that
      // the drain decision follows whether an install SUCCEEDED — so the same truthy
      // answer stops one run and drains the other.
      const stopped = deps({ ask: makeAsk(reply) })
      expect((await cycleCommand(stopped)).status).toBe('updated')
      expect(stopped.count('runQueueOnce')).toBe(0)

      const drained = deps({ ask: makeAsk(reply), runUpdate: makeRunUpdate(FAILED_UPDATE) })
      expect((await cycleCommand(drained)).status).toBe('success')
      expect(drained.count('runQueueOnce')).toBe(1)
    })
  }

  it('never announces both outcomes, on either branch', async () => {
    for (const runUpdate of [makeRunUpdate(), makeRunUpdate(FAILED_UPDATE), makeRunUpdate(ADVICE_UPDATE)]) {
      const d = deps({ runUpdate })
      await cycleCommand(d)
      expect(d.dones().length + d.warns().length).toBe(1)
    }
  })
})

describe('QA cycle #52 — releaseLock hostility on the updated path', () => {
  it('still returns the update-and-stop contract when releaseLock throws', async () => {
    const released = []
    const d = deps({
      releaseLock: () => {
        released.push('called')
        throw new Error('lock file vanished')
      },
    })
    const out = await cycleCommand(d)
    expect(out).toEqual({ exitCode: 0, status: 'updated', processed: 0, skipped: true })
    expect(released).toHaveLength(1)
    expect(d.dones()).toEqual([UPDATED_LINE])
    expect(eventLines(d.stdout)).toHaveLength(1)
  })

  it('lets the done line’s own throw win over a throwing releaseLock', async () => {
    const boom = new Error('EPIPE on the done line')
    const written = []
    const stdout = {
      write: (s) => {
        if (String(s).includes(DONE)) throw boom
        written.push(String(s))
        return true
      },
      chunks: written,
      raw: () => written.join(''),
      output: () => strip(written.join('')),
      lines: () => strip(written.join('')).split('\n').filter(Boolean),
    }
    const d = deps({
      stdout,
      releaseLock: () => {
        throw new Error('lock file vanished')
      },
    })
    await expect(cycleCommand(d)).rejects.toBe(boom)
    expect(d.count('runQueueOnce')).toBe(0)
  })

  it('releases the lock exactly once on every #52 outcome', async () => {
    const outcomes = [
      ['accept + install', {}],
      ['accept + failed install', { runUpdate: makeRunUpdate(FAILED_UPDATE) }],
      ['decline', { ask: makeAsk(false) }],
      ['no TTY', { stdin: { isTTY: false } }],
      ['a throwing recordPrompt', { recordPrompt: () => { throw new Error('x') } }],
      ['a throwing runUpdate', { runUpdate: makeRunUpdate(() => { throw new Error('x') }) }],
    ]
    for (const [label, overrides] of outcomes) {
      const d = deps(overrides)
      await cycleCommand(d)
      expect({ label, released: d.count('releaseLock') }).toEqual({ label, released: 1 })
      expect(d.at('acquireLock')).toBeLessThan(d.at('releaseLock'))
    }
  })
})

describe('QA cycle #52 — the stop cannot starve the schedule', () => {
  it('the next tick on the NEW version drains, silently', async () => {
    const cacheFs = new Volume()
    const first = deps({ cacheFs })
    expect((await cycleCommand(first)).status).toBe('updated')

    const second = deps({ cacheFs, currentVersion: '0.2.0', now: () => T0 + 4 * HOUR })
    const out = await cycleCommand(second)
    expect(out.status).toBe('success')
    expect(second.notices()).toEqual([])
    expect(second.ask.calls).toEqual([])
    expect(second.count('runQueueOnce')).toBe(1)
  })

  it('the next TTY tick still on the OLD version drains — it does not stop again', async () => {
    // The starvation scenario: if an accepted install did not burn the prompt window,
    // every following tick on a terminal would ask, install and stop, and the queue
    // would never be drained again. The stamp is what makes the stop a one-off.
    const cacheFs = new Volume()
    const first = deps({ cacheFs })
    expect((await cycleCommand(first)).status).toBe('updated')
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))

    const second = deps({ cacheFs, now: () => T0 + HOUR })
    const out = await cycleCommand(second)
    expect(out.status).toBe('success')
    expect(second.ask.calls).toEqual([])
    expect(second.runUpdate.calls).toEqual([])
    expect(second.notices()).toEqual([NOTICE_LINE])
    expect(second.count('runQueueOnce')).toBe(1)
  })

  it('six ticks after an accepted install produce one stop and five drains', async () => {
    const cacheFs = new Volume()
    const statuses = []
    for (let i = 0; i < 6; i++) {
      const d = deps({ cacheFs, now: () => T0 + i * 4 * HOUR })
      statuses.push((await cycleCommand(d)).status)
    }
    expect(statuses).toEqual(['updated', 'success', 'success', 'success', 'success', 'success'])
    expect(cacheOf(cacheFs)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
  })

  it('an accepted install writes both stamps and nothing else', async () => {
    const ops = []
    const vol = new Volume()
    const cacheFs = {
      readFileSync: (...a) => {
        ops.push({ op: 'read', path: String(a[0]) })
        return vol.readFileSync(...a)
      },
      writeFileSync: (...a) => {
        ops.push({ op: 'write', path: String(a[0]) })
        return vol.writeFileSync(...a)
      },
      mkdirSync: (...a) => {
        ops.push({ op: 'mkdir', path: String(a[0]) })
        return vol.mkdirSync(...a)
      },
    }
    const d = deps({ cacheFs })
    await cycleCommand(d)
    const written = ops.filter((o) => o.op === 'write').map((o) => o.path)
    expect(written).toHaveLength(2)
    expect([...new Set(written)]).toEqual([CACHE_PATH])
  })

  it('an unwritable cache still asks, still installs and still stops', async () => {
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
    const d = deps({ cacheFs })
    const out = await cycleCommand(d)
    expect(out.status).toBe('updated')
    expect(d.ask.calls).toHaveLength(1)
    expect(d.stderr.output()).toBe('')
  })
})

describe('QA cycle #52 — the `updated` event and lib/heartbeat.js agree end-to-end', () => {
  const LOG_DIR = '/repo/logs'
  const summarize = (text, clockMs = T0 + HOUR) =>
    summarizeLast24h({
      logDir: LOG_DIR,
      fs: Volume.fromJSON({ [join(LOG_DIR, 'ralph-cycle.out.log')]: text }, '/'),
      clock: () => clockMs,
    })

  it('an updated run is one cycle, one abort, no duration and no issues', async () => {
    const d = deps()
    await cycleCommand(d)
    const summary = summarize(d.stdout.output())
    expect(summary).toEqual({
      cycles: 1,
      totalIssues: 0,
      ok: 0,
      failed: 0,
      abortedCycles: 1,
      durations: [],
      lastCycle: {
        ts: iso(T0),
        status: 'updated',
        ok: 0,
        failed: 0,
        durationMin: 0,
        processed: 0,
      },
    })
  })

  it('the done line itself is not parsed as a cycle', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.stdout.output()).toContain(UPDATED_LINE)
    expect(summarize(d.stdout.output()).cycles).toBe(1)
  })

  it('a realistic day: four drains, one update, one lock-held', async () => {
    const logs = []
    const push = async (overrides, execOptions, at) => {
      const d = deps({ ...overrides, now: () => T0 + at }, execOptions)
      await cycleCommand(d)
      logs.push(d.stdout.output())
      return d
    }
    // Two ordinary drains, the accepted update, a tick that lands on the lock, then
    // two more drains once the schedule has moved to the new version.
    const drain = (at) => ({ ask: makeAsk(false), metrics: twoPassesAt(T0 + at) })
    await push(drain(0), { queue: '2' }, 0)
    await push(drain(HOUR), { queue: '2' }, HOUR)
    await push({}, {}, 2 * HOUR)
    await push(
      {
        acquireLock: () => ({ acquired: false, holder: { pid: 9, startedAt: iso(T0), repoPath: REPO } }),
      },
      {},
      3 * HOUR,
    )
    await push({ ...drain(4 * HOUR), currentVersion: '0.2.0' }, { queue: '2' }, 4 * HOUR)
    await push({ ...drain(5 * HOUR), currentVersion: '0.2.0' }, { queue: '2' }, 5 * HOUR)

    const summary = summarize(logs.join(''), T0 + 6 * HOUR)
    expect(summary.cycles).toBe(6)
    expect(summary.abortedCycles).toBe(2)
    expect(summary.durations).toEqual([0, 0, 0, 0])
    expect(summary.ok).toBe(8)
    expect(summary.failed).toBe(0)
    expect(summary.lastCycle.status).toBe('success')
    expect(formatSummary(summary, { repoSlug: REPO_SLUG })).toBe(
      '📊 Ralph 24h | 6 cycles, 8 issues (8 ok, 0 fail) | lucasfe/ralph',
    )
  })

  it('a day of nothing but updates reports zero issues and no warning flag', async () => {
    const logs = []
    for (let i = 0; i < 3; i++) {
      // Each tick gets its own cache, which is what a re-opened prompt window looks
      // like from the rollup's side.
      const d = deps({ now: () => T0 + i * HOUR })
      await cycleCommand(d)
      logs.push(d.stdout.output())
    }
    const summary = summarize(logs.join(''), T0 + 4 * HOUR)
    expect(summary.cycles).toBe(3)
    expect(summary.abortedCycles).toBe(3)
    expect(summary.durations).toEqual([])
    expect(formatSummary(summary, { repoSlug: REPO_SLUG })).toBe(
      '📊 Ralph 24h | 3 cycles, 0 issues (0 ok, 0 fail) | lucasfe/ralph',
    )
  })

  it('an updated run cannot put a second cycle into the rollup', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.stdout.output().split('RALPH_CYCLE_EVENT')).toHaveLength(2)
    expect(summarize(d.stdout.output()).cycles).toBe(1)
  })

  it('control: an injected install CAN forge one through its `to` — hence the semver guard upstream', async () => {
    // Nothing at this call site validates `installedVersion`, so a `to` carrying a
    // newline and a payload of its own lands a forged event on its own line. Not
    // reachable in production: updateCommand's `to` is fetchLatestVersion's
    // semver-validated output (or `currentVersion`), which is exactly what makes that
    // validation load-bearing rather than cosmetic. Pinned as the positive control
    // for the test above.
    const forged = `${EVENT_TAG}{"ts":"${iso(T0)}","status":"success","ok":99,"failed":0,"durationMin":1,"processed":99}`
    const d = deps({ runUpdate: makeRunUpdate({ updated: true, to: `0.2.0\n${forged}\n` }) })
    await cycleCommand(d)
    const summary = summarize(d.stdout.output())
    expect(summary.cycles).toBe(2)
    expect(summary.ok).toBe(99)
  })

  it('an update older than 24h drops out of the rollup entirely', async () => {
    const d = deps()
    await cycleCommand(d)
    const summary = summarize(d.stdout.output(), T0 + 25 * HOUR)
    expect(summary).toEqual({
      cycles: 0,
      totalIssues: 0,
      ok: 0,
      failed: 0,
      abortedCycles: 0,
      durations: [],
      lastCycle: null,
    })
  })
})

describe('QA cycle #52 — the launchd path is untouched by any of this', () => {
  it('a full unattended tick asks nothing, installs nothing and drains', async () => {
    const d = deps({ stdin: { isTTY: false }, ask: confirm, runUpdate: makeRunUpdate(OK_UPDATE) })
    const outcome = await Promise.race([
      cycleCommand(d).then((r) => r.status),
      new Promise((r) => setTimeout(() => r('hung'), 250)),
    ])
    expect(outcome).toBe('success')
    expect(d.stdout.output()).not.toContain(ANY_QUESTION)
    expect(d.count('recordPrompt')).toBe(0)
    expect(d.runUpdate.calls).toEqual([])
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(d.exec.keys().filter((k) => k.startsWith('npm '))).toEqual([NPM_VIEW])
  })

  it('an unattended tick leaves the prompt window for the next human', async () => {
    const cacheFs = new Volume()
    const d = deps({ cacheFs, stdin: { isTTY: false } })
    await cycleCommand(d)
    expect(cacheOf(cacheFs).last_prompted_at).toBeNull()
    const human = deps({ cacheFs, now: () => T0 + HOUR })
    expect((await cycleCommand(human)).status).toBe('updated')
    expect(human.ask.calls).toHaveLength(1)
  })

  it('asks nothing when the registry reports the version already installed', async () => {
    // The ordinary state of an up-to-date machine, through the REAL decision: no
    // notice, no question, no install, and the drain untouched.
    const d = deps({}, { npm: { exitCode: 0, stdout: '0.1.0\n', stderr: '', timedOut: false } })
    const out = await cycleCommand(d)
    expect(out.status).toBe('success')
    expect(d.notices()).toEqual([])
    expect(d.ask.calls).toEqual([])
    expect(d.runUpdate.calls).toEqual([])
    expect(drainEvidence(d)).toEqual(DRAINED)
  })

  for (const [label, npm] of [
    ['a failed query', { exitCode: 1, stdout: '', stderr: 'ENOTFOUND', timedOut: false }],
    ['a timed-out query', { exitCode: 1, stdout: '', stderr: '', timedOut: true }],
    ['garbage on stdout', { exitCode: 0, stdout: 'not-a-version\n', stderr: '', timedOut: false }],
    ['an exec that throws', () => { throw new Error('spawn failed') }],
  ]) {
    it(`asks nothing on ${label} — an offline machine still drains`, async () => {
      const d = deps({}, { npm })
      const out = await cycleCommand(d)
      expect(out.status).toBe('success')
      expect(d.notices()).toEqual([])
      expect(d.ask.calls).toEqual([])
      expect(d.stderr.output()).toBe('')
      expect(drainEvidence(d)).toEqual(DRAINED)
    })
  }

  it('RALPH_NO_UPDATE_CHECK=1 suppresses the question on a TTY, with no query and no install', async () => {
    const d = deps({ processEnv: { RALPH_NO_UPDATE_CHECK: '1' } })
    const out = await cycleCommand(d)
    expect(out.status).toBe('success')
    expect(d.ask.calls).toEqual([])
    expect(d.runUpdate.calls).toEqual([])
    expect(d.exec.npmViews()).toEqual([])
    expect(drainEvidence(d)).toEqual(DRAINED)
  })
})
