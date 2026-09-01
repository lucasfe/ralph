import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { cycleCommand } from './cycle.js'
import { startCommand } from './start.js'
import { summarizeLast24h } from '../heartbeat.js'
import { recordPromptShown } from '../update-check.js'
import { readVersionCache, versionCachePath } from '../version-cache.js'

// #52 — the TTY-gated update PROMPT in `ralph cycle`, and the stop that follows an
// accepted install.
//
// Its own file next to cycle.update-notice.test.js (#51) because the two slices
// answer different questions: #51 asked "does the cycle tell me?", this one asks
// "may the cycle ask me, and what happens to the drain if I say yes?". #51's file
// stays the regression guard for the unattended path — that a launchd tick with no
// terminal still only ever gets the printed line.
//
// The two things this slice owns, and nothing else (the notice, the question's
// wording, the weekly windows and the install all live in ../update-gate.js, #50):
//   1. WHERE isTTY comes from — the RESOLVED `stdin` parameter, so a caller that
//      injects a non-interactive stream can never be handed a readline over it.
//      Getting that backwards is not cosmetic: `confirm` never resolves on input
//      that ends without a line, so it is an unrecoverable hang on every launchd
//      tick, forever, with the cycle lock held.
//   2. What an accepted install MEANS for a drain — that it stops, rather than
//      draining, because THIS process holds pre-update module state and
//      `templatePath('ralph.sh')` still resolves against the OLD install: the
//      `--once` loop would be a mixture of two versions. `ralph start` refuses to
//      launch its loop for the same reason (start.js:182-201); the cycle refuses to
//      drain. The user re-runs `ralph cycle`, and the next scheduled tick picks the
//      new version up on its own.
//
// What is asserted, and in what spirit:
//   - the isTTY DERIVATION, from both ends: an injected non-interactive stream is
//     never asked over even under an ambient terminal that reports isTTY, and an
//     omitted `stdin` falls through to the ambient one (stubbed, so the result
//     never depends on how `npm test` was invoked);
//   - the question as an ADDITION to #51's notice — same wording as `ralph start`,
//     after the printed line, never instead of it;
//   - the window SHARED with `start`: prompted by `ralph start` this week means
//     `ralph cycle` does not ask again, proven by running the two in turn over one
//     memfs cache;
//   - the stamp landing BEFORE the answer is awaited, read off one timeline, so a
//     Ctrl-C (an `ask` that never resolves normally) still burns the window;
//   - the accept path as a complete contract: the done line, the `updated` event
//     with zeroed counters, the exact return object, the lock released, and
//     runQueueOnce NEVER called;
//   - the two fall-through paths — a decline and a failed install — draining on the
//     current version, because an update is never worth losing a run over, and the
//     gate being on whether an install SUCCEEDED rather than on the target version
//     (`to` is set even for an npx run or a linked dev checkout);
//   - `updated` reaching lib/heartbeat.js as an ABORT rather than as a zero-minute
//     cycle, asserted here end-to-end through the cycle's own stdout (the unit-level
//     classification lives in ../heartbeat.test.js).
//
// Every seam is injected, `cacheFs` is memfs everywhere, no test spawns an install,
// and the beforeAll/afterAll pair asserts the developer's real ~/.config/ralph was
// never touched.

const REPO = '/repo'
const REPO_SLUG = 'lucasfe/ralph'
const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })

const NPM_VIEW = 'npm view @lucasfe/ralph version'
const NOTICE = 'New version available'
const NOTICE_LINE = 'New version available: 0.2.0 (run npm i -g @lucasfe/ralph to update)'
// #25's wording, verbatim and shared with `ralph start` — the trailing space
// included, because that is what a user sees before their cursor.
const QUESTION = 'Update now? [y/N]: '
// Deliberately looser than QUESTION for the "never asked" assertions: any rewording
// of the prompt must still count as having asked.
const ANY_QUESTION = 'Update now?'
const UPDATED_LINE = '✅ Updated to 0.2.0 — run `ralph cycle` again.'
const DONE = 'Updated to'
const WARN = 'Update did not complete'
const EVENT_TAG = 'RALPH_CYCLE_EVENT '

const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const iso = (ms) => new Date(ms).toISOString()

// picocolors wraps the notice and the done line in ANSI when the runner reports
// colour support, so output is compared with the codes stripped.
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

// stdout/stderr writes land on the shared timeline as well as in the buffer, so
// "the notice came before the question" is read off ONE sequence rather than
// inferred from two.
function makeStream(timeline = [], tag = 'out') {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(String(s))
      timeline.push(`${tag}:${strip(String(s)).trim()}`)
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

// One recorder for both injected async seams below. `result` may be a value (which
// is resolved) or a function (called for its raw return), so a seam that throws,
// rejects or never settles is expressible. `record` says what a call looks like in
// `.calls`.
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
// updateCommand's own shapes for the two "accepted but nothing installed" outcomes.
// Both carry `to` — the version that is out there — which is precisely why the
// caller must gate on `updated` instead.
const FAILED_UPDATE = { exitCode: 1, updated: false, from: '0.1.0', to: '0.2.0' }
const NOTHING_TO_UPDATE = { exitCode: 0, updated: false, from: '0.1.0', to: '0.2.0' }

function makeRunUpdate(...args) {
  return makeSeam(args.length ? args[0] : OK_UPDATE, (opts) => opts)
}

// Wraps an injected seam so its CALL lands on the shared timeline while `.calls`
// stays reachable — that is what makes ordering against the stamp, the printed
// lines, the lock and the drain one single sequence.
function traced(timeline, tag, fn) {
  const wrapped = (...args) => {
    timeline.push(tag)
    return fn(...args)
  }
  wrapped.calls = fn.calls
  return wrapped
}

// One exec for the whole cycle, matched on cmd/args rather than on exact key
// strings so a search-query tweak in cycle.js cannot silently defuse these tests.
function makeExec(
  { npm = { exitCode: 0, stdout: '0.2.0\n', stderr: '' }, queue = '1', tmuxHasSession = 1, ghAuth = 0 } = {},
  timeline = [],
) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    timeline.push(`exec:${key}`)
    if (cmd === 'git' && args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: `${REPO}\n`, stderr: '' }
    }
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: tmuxHasSession, stdout: '', stderr: '' }
    }
    if (cmd === 'npm' && args[0] === 'view') return npm
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
  exec.npmViews = () => calls.filter((c) => c === NPM_VIEW)
  return exec
}

// A full github-source cycle on an INTERACTIVE terminal, with 0.2.0 published and
// 0.1.0 installed and an empty (so wide-open) prompt window: the default run of
// this file is the one that asks. The lock, orphan sweep, drain, stamp, prompt and
// install all record themselves on the same timeline as the exec calls and the
// printed lines.
function deps(overrides = {}, execOptions = {}) {
  const timeline = []
  const stdout = makeStream(timeline, 'out')
  const stderr = makeStream(timeline, 'err')
  const sendWa = makeWa()
  const ask = overrides.ask ?? makeAsk(true)
  const runUpdate = overrides.runUpdate ?? makeRunUpdate()
  const d = {
    cwd: REPO,
    stdout,
    stderr,
    // A sentinel that merely CLAIMS to be a terminal: identity is asserted at the
    // ask() call site, and nothing in this file may touch the real one.
    stdin: { marker: 'injected-stdin', isTTY: true },
    exec: makeExec(execOptions, timeline),
    exists: () => true,
    readFile: () => '',
    loadEnv: () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' }),
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
    sendWa,
    pingSuccess: async () => ({ ok: true }),
    pingFail: async () => ({ ok: true }),
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
  // The prompt-window stamp: recorded on the timeline AND delegated to the real
  // recordPromptShown, so one harness proves both the ordering against `ask` and
  // the write itself through `cacheFs`.
  d.recordPrompt =
    overrides.recordPrompt ??
    ((args) => {
      timeline.push('recordPrompt')
      return recordPromptShown(args)
    })
  d.ask = traced(timeline, 'ask', ask)
  d.runUpdate = traced(timeline, 'runUpdate', runUpdate)
  d.timeline = timeline
  d.at = (event) => timeline.indexOf(event)
  d.count = (event) => timeline.filter((e) => e === event).length
  d.notices = () => stdout.lines().filter((l) => l.includes(NOTICE))
  d.warns = () => stdout.lines().filter((l) => l.includes(WARN))
  return d
}

// The same run for `ralph start`, used only by the shared-window test. Unknown exec
// keys resolve to exit 0, so the tmux launch needs no handler of its own.
function startDeps(overrides = {}) {
  const stdout = makeStream()
  const ask = overrides.ask ?? makeAsk(false)
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
    ...overrides,
    ask,
  }
}

function cycleEvent(stdout) {
  const line = stdout.lines().find((l) => l.startsWith(EVENT_TAG))
  return line ? JSON.parse(line.slice(EVENT_TAG.length)) : null
}

const cacheOf = (cacheFs) => readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} })

// A cache inside BOTH weekly windows: no registry query, and the prompt window
// closed by a stamp from `ralph start` a day ago.
const promptedCache = (promptedAgoMs = DAY) =>
  Volume.fromJSON(
    {
      [CACHE_PATH]: JSON.stringify({
        last_check_at: iso(T0 - DAY),
        last_prompted_at: iso(T0 - promptedAgoMs),
        latest_version: '0.2.0',
      }),
    },
    '/',
  )

// Swaps the AMBIENT process.stdin, which is what the `stdin` parameter's own
// default resolves to. Stubbed rather than read, so no assertion depends on how
// `npm test` was invoked.
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

describe('cycleCommand — isTTY follows the RESOLVED stdin (#52)', () => {
  it('asks over the injected stream, by identity, when that stream reports a TTY', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.ask.calls).toHaveLength(1)
    expect(d.ask.calls[0].options.input).toBe(d.stdin)
    expect(d.ask.calls[0].options.output).toBe(d.stdout)
  })

  it('never asks over an injected non-interactive stream, whatever the ambient terminal claims', async () => {
    // The hang this ordering prevents: `confirm` never resolves on an input that
    // ends without a line, so a readline over a launchd-supplied pipe would block
    // forever with the cycle lock held. Deriving isTTY from the RESOLVED `stdin`
    // is what makes an injected stream authoritative over the ambient one.
    await withProcessStdin({ isTTY: true }, async () => {
      const d = deps({ stdin: { isTTY: false } })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.ask.calls).toEqual([])
      expect(d.notices()).toEqual([NOTICE_LINE])
      expect(d.count('runQueueOnce')).toBe(1)
    })
  })

  it('falls back to the ambient process.stdin when no stream is injected', async () => {
    const ambient = { marker: 'ambient-stdin', isTTY: true }
    await withProcessStdin(ambient, async () => {
      const d = deps({ stdin: undefined })
      await cycleCommand(d)
      expect(d.ask.calls).toHaveLength(1)
      expect(d.ask.calls[0].options.input).toBe(ambient)
    })
  })

  it('does not ask when the ambient process.stdin is not interactive — the launchd tick', async () => {
    await withProcessStdin({ marker: 'ambient-stdin', isTTY: false }, async () => {
      const d = deps({ stdin: undefined })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.ask.calls).toEqual([])
      expect(d.notices()).toEqual([NOTICE_LINE])
    })
  })
})

describe('cycleCommand — the question is an addition to the notice (#52)', () => {
  it('prints the notice and then asks `Update now? [y/N]:`', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(d.ask.calls[0].question).toBe(QUESTION)
    expect(d.at(`out:${NOTICE_LINE}`)).toBeGreaterThanOrEqual(0)
    expect(d.at(`out:${NOTICE_LINE}`)).toBeLessThan(d.at('ask'))
  })

  it('asks the same question `ralph start` asks — run side by side, not hand-copied', async () => {
    const c = deps()
    await cycleCommand(c)
    const s = startDeps()
    await startCommand(s)
    expect(s.ask.calls).toHaveLength(1)
    expect(c.ask.calls[0].question).toBe(s.ask.calls[0].question)
  })

  it('prints the notice and never asks on a non-interactive run (#51 regression guard)', async () => {
    const d = deps({ stdin: { isTTY: false } })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(d.stdout.output()).not.toContain(ANY_QUESTION)
    expect(d.ask.calls).toEqual([])
    expect(d.count('recordPrompt')).toBe(0)
    expect(d.runUpdate.calls).toEqual([])
  })

  it('prints the notice and does not ask when the weekly prompt window is closed', async () => {
    const cacheFs = promptedCache()
    const d = deps({ cacheFs })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(d.ask.calls).toEqual([])
    // Served from the warm cache, so the closed window cost no registry query either.
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0 - DAY))
  })

  it('asks again once the prompt window has elapsed', async () => {
    const d = deps({ cacheFs: promptedCache(8 * DAY) })
    await cycleCommand(d)
    expect(d.ask.calls).toHaveLength(1)
  })
})

describe('cycleCommand — the prompt window is shared with `ralph start` (#52)', () => {
  it('does not ask when `ralph start` already asked this week', async () => {
    const cacheFs = new Volume()
    const s = startDeps({ cacheFs })
    await startCommand(s)
    expect(s.ask.calls).toHaveLength(1)
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))

    const c = deps({ cacheFs, now: () => T0 + 4 * HOUR })
    const result = await cycleCommand(c)
    expect(result.status).toBe('success')
    expect(c.ask.calls).toEqual([])
    // The notice is not throttled with the question — a declined update is still
    // announced on every run.
    expect(c.notices()).toEqual([NOTICE_LINE])
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))
  })

  it('closes the window for the next `ralph start` once the cycle has asked', async () => {
    const cacheFs = new Volume()
    const c = deps({ cacheFs })
    await cycleCommand(c)
    expect(c.ask.calls).toHaveLength(1)
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))

    const s = startDeps({ cacheFs, now: () => T0 + 4 * HOUR })
    await startCommand(s)
    expect(s.ask.calls).toEqual([])
  })
})

describe('cycleCommand — the window is stamped before the answer is awaited (#52)', () => {
  it('records the prompt BEFORE awaiting ask', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.count('recordPrompt')).toBe(1)
    expect(d.at('recordPrompt')).toBeLessThan(d.at('ask'))
  })

  it('burns the window on a Ctrl-C at the prompt, and still releases the lock', async () => {
    // A Ctrl-C kills the real process, so the reachable stand-in is a prompt that
    // never answers normally. The window belongs to the ASKING: a user who has seen
    // the question must not be asked again on their next run seconds later.
    const boom = new Error('SIGINT at the prompt')
    const cacheFs = new Volume()
    const d = deps({ cacheFs, ask: makeAsk(() => Promise.reject(boom)) })
    await expect(cycleCommand(d)).rejects.toBe(boom)
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))
    expect(d.count('releaseLock')).toBe(1)
    expect(d.count('runQueueOnce')).toBe(0)
  })

  it('stamps the window exactly once per cycle, and only the prompt field', async () => {
    const cacheFs = new Volume()
    const d = deps({ cacheFs })
    await cycleCommand(d)
    expect(d.count('recordPrompt')).toBe(1)
    expect(cacheOf(cacheFs)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
  })
})

describe('cycleCommand — accept + a successful install stops the cycle (#52)', () => {
  it('prints the done line naming the installed version and the command to re-run', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.stdout.lines()).toContain(UPDATED_LINE)
    expect(d.stderr.output()).toBe('')
  })

  it('emits RALPH_CYCLE_EVENT with status `updated` and zeroed counters', async () => {
    const d = deps()
    await cycleCommand(d)
    const payload = cycleEvent(d.stdout)
    expect(payload).toEqual({
      ts: iso(T0),
      status: 'updated',
      ok: 0,
      failed: 0,
      durationMin: 0,
      processed: 0,
    })
  })

  it('returns exactly the update-and-stop contract', async () => {
    const d = deps()
    const result = await cycleCommand(d)
    expect(result).toEqual({ exitCode: 0, status: 'updated', processed: 0, skipped: true })
  })

  it('never calls runQueueOnce — no issue may be processed by a mixture of two versions', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.count('runQueueOnce')).toBe(0)
    // The whole tail of the cycle is skipped with it: no orphan sweep, no queue
    // count, no summary line and nothing over WhatsApp.
    expect(d.count('findOrphans')).toBe(0)
    expect(d.exec.calls.some((c) => c.startsWith('gh issue list'))).toBe(false)
    expect(d.stdout.output()).not.toContain('Ralph finished:')
    expect(d.sendWa.messages).toEqual([])
  })

  it('releases the lock on the way out, like every other path', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.count('releaseLock')).toBe(1)
    expect(d.at('acquireLock')).toBeLessThan(d.at('releaseLock'))
  })

  it('prints the done line before the event line, and installs after asking', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.at('ask')).toBeLessThan(d.at('runUpdate'))
    expect(d.at('runUpdate')).toBeLessThan(d.at(`out:${UPDATED_LINE}`))
    const lines = d.stdout.lines()
    expect(lines.findIndex((l) => l === UPDATED_LINE)).toBeLessThan(
      lines.findIndex((l) => l.startsWith(EVENT_TAG)),
    )
  })

  it('hands the install the cycle’s own version, exec and streams', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.runUpdate.calls).toHaveLength(1)
    expect(d.runUpdate.calls[0].currentVersion).toBe('0.1.0')
    expect(d.runUpdate.calls[0].exec).toBe(d.exec)
    expect(d.runUpdate.calls[0].stdout).toBe(d.stdout)
    expect(d.runUpdate.calls[0].stderr).toBe(d.stderr)
  })

  it('falls back to the notice’s version when the install names none', async () => {
    const d = deps({ runUpdate: makeRunUpdate({ exitCode: 0, updated: true }) })
    const result = await cycleCommand(d)
    expect(result.status).toBe('updated')
    expect(d.stdout.lines()).toContain(UPDATED_LINE)
  })
})

describe('cycleCommand — a declined update drains on the current version (#52)', () => {
  it('drains normally, with the full event and return contract', async () => {
    const d = deps({ ask: makeAsk(false) })
    const result = await cycleCommand(d)
    expect(result).toEqual({
      exitCode: 0,
      status: 'success',
      processed: 0,
      skipped: false,
      successes: [],
      failures: [],
      durationMin: 0,
    })
    expect(d.count('runQueueOnce')).toBe(1)
    expect(cycleEvent(d.stdout).status).toBe('success')
    expect(Object.keys(cycleEvent(d.stdout)).sort()).toEqual([
      'durationMin',
      'failed',
      'ok',
      'processed',
      'run_id',
      'status',
      'ts',
    ])
  })

  it('installs nothing and says nothing beyond the notice it was declining', async () => {
    const d = deps({ ask: makeAsk(false) })
    await cycleCommand(d)
    expect(d.runUpdate.calls).toEqual([])
    expect(d.notices()).toEqual([NOTICE_LINE])
    expect(d.stdout.output()).not.toContain(DONE)
    expect(d.stdout.output()).not.toContain(WARN)
    expect(d.stderr.output()).toBe('')
  })

  it('costs no run on any falsy answer, prompt included', async () => {
    // The gate coerces the answer (`Boolean(await ask(...))`), so anything that is
    // not an explicit yes is a decline. The real `confirm` narrows that to `y`
    // before it ever gets here; these are the returns an injected prompt — or a
    // future one that resolves an empty line rather than a boolean — can produce.
    for (const reply of [false, undefined, null, '', 0, NaN]) {
      const d = deps({ ask: makeAsk(reply) })
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.count('runQueueOnce')).toBe(1)
      expect(d.runUpdate.calls).toEqual([])
    }
  })
})

describe('cycleCommand — a failed or impossible install drains on the current version (#52)', () => {
  it('prints one neutral line naming the current version, then drains', async () => {
    const d = deps({ runUpdate: makeRunUpdate(FAILED_UPDATE) })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.warns()).toHaveLength(1)
    expect(d.warns()[0]).toContain('0.1.0')
    expect(d.stdout.output()).not.toContain(DONE)
    expect(d.count('runQueueOnce')).toBe(1)
    expect(d.stderr.output()).toBe('')
  })

  it('drains when runUpdate throws — no escape from a courtesy install', async () => {
    const d = deps({
      runUpdate: makeRunUpdate(() => {
        throw new Error('npm exploded')
      }),
    })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.warns()).toHaveLength(1)
    expect(d.count('runQueueOnce')).toBe(1)
  })

  it('drains when runUpdate rejects', async () => {
    const d = deps({ runUpdate: makeRunUpdate(() => Promise.reject(new Error('npm exploded'))) })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.count('runQueueOnce')).toBe(1)
  })

  it('gates on whether an install SUCCEEDED, not on the target version', async () => {
    // `to` names "the version that is out there", so updateCommand sets it even on
    // an npx run or a linked dev checkout where it installed nothing. Gating on it
    // would announce an update that never happened — and, worse here, skip a drain
    // for it.
    const d = deps({ runUpdate: makeRunUpdate(NOTHING_TO_UPDATE) })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(result.skipped).toBe(false)
    expect(d.stdout.output()).not.toContain(DONE)
    expect(d.warns()).toHaveLength(1)
    expect(d.count('runQueueOnce')).toBe(1)
  })

  it('emits the ordinary drain event, not an `updated` one', async () => {
    for (const result of [FAILED_UPDATE, NOTHING_TO_UPDATE, undefined, null, {}]) {
      const d = deps({ runUpdate: makeRunUpdate(result) })
      await cycleCommand(d)
      expect(cycleEvent(d.stdout).status).toBe('success')
      expect(d.count('runQueueOnce')).toBe(1)
    }
  })

  it('announces both outcomes never at once', async () => {
    // Mutually exclusive by construction (`else if`), so a dropped return above
    // cannot produce a run that claims an update AND a failed one.
    for (const runUpdate of [makeRunUpdate(), makeRunUpdate(FAILED_UPDATE)]) {
      const d = deps({ runUpdate })
      await cycleCommand(d)
      const claimsDone = d.stdout.output().includes(DONE)
      const claimsWarn = d.stdout.output().includes(WARN)
      expect(claimsDone && claimsWarn).toBe(false)
      expect(claimsDone || claimsWarn).toBe(true)
    }
  })
})

describe('cycleCommand — an update-and-stop is an ABORT in the 24h rollup (#52)', () => {
  // lib/heartbeat.js reads the RALPH_CYCLE_EVENT stream out of
  // logs/ralph-cycle.out.log, so the cycle's own stdout IS the summary's input.
  const LOG_DIR = '/repo/logs'
  const summarize = (stdout) => {
    const vol = Volume.fromJSON({ [join(LOG_DIR, 'ralph-cycle.out.log')]: stdout }, '/')
    return summarizeLast24h({ logDir: LOG_DIR, fs: vol, clock: () => T0 + HOUR })
  }

  it('counts the update as an aborted cycle and contributes no duration', async () => {
    const d = deps()
    await cycleCommand(d)
    const summary = summarize(d.stdout.output())
    expect(summary.cycles).toBe(1)
    expect(summary.abortedCycles).toBe(1)
    expect(summary.durations).toEqual([])
    expect(summary.lastCycle.status).toBe('updated')
  })

  it('a declined cycle still counts as a real cycle with a duration', async () => {
    const d = deps({ ask: makeAsk(false) })
    await cycleCommand(d)
    const summary = summarize(d.stdout.output())
    expect(summary.cycles).toBe(1)
    expect(summary.abortedCycles).toBe(0)
    expect(summary.durations).toEqual([0])
  })
})
