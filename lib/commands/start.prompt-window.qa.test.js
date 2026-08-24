import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Volume } from 'memfs'
import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { startCommand, StartAbort } from './start.js'
import { sessionNameFor } from '../lock.js'
import { readVersionCache, versionCachePath } from '../version-cache.js'
import { recordPromptShown, UPDATE_CHECK_INTERVAL_MS } from '../update-check.js'

// #26 QA augmentation — the prompt window as `ralph start` actually drives it.
// The dev's describe('weekly prompt throttle + offline prompt-from-cache (#26)')
// in test/commands/start.test.js proves the acceptance criteria end to end. This
// file attacks the seam between them:
//   - the STAMP-BEFORE-ASK ordering, which is the one thing the ACs only imply:
//     an `ask` that rejects, throws synchronously, or never resolves at all (a
//     Ctrl-C at the prompt) must still leave the window burned, while a run whose
//     prompt never happened must leave it untouched;
//   - the ACCEPT path, where step 2.5 returns EARLY — the stamp must already be on
//     disk, exactly once, whether the install succeeds, fails, or throws;
//   - a run that ABORTS after the question (gh auth) — the window belongs to the
//     asking, so it stays burned;
//   - the two windows crossing over one file through the real decision + real
//     stamp, asserted on the WRITE SEQUENCE rather than only the end state, so a
//     stamp that re-read a stale snapshot would be caught;
//   - back-to-back runs on one volume, including two in the same millisecond and
//     two different repos, plus the roll-over on the far side of the window;
//   - malformed cache files driven through the whole command;
//   - the recordPrompt injection seam returning junk, and the argument identities
//     it shares with the decision.
//
// Hermeticity: `isTTY: true` is passed EXPLICITLY wherever a prompt is expected
// (process.stdin.isTTY is undefined in a vitest worker, so a defaulted gate never
// prompts and never stamps — a suite that relied on the default would be vacuous),
// and every run passes BOTH `cacheFs` (memfs) and `home`. The beforeAll/afterAll
// pair asserts the developer's real ~/.config/ralph cache was never touched.

const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const NPM_VIEW = 'npm view @lucasfe/ralph version'
const NOTICE = 'New version available'
const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const WEEK = UPDATE_CHECK_INTERVAL_MS
const iso = (ms) => new Date(ms).toISOString()
const strip = (s) => String(s).replace(/\u001B\[[0-9;]*m/g, '')

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

function makeStream(timeline = [], tag = 'out') {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      timeline.push(`${tag}:${strip(String(s)).trim()}`)
      return true
    },
    output: () => strip(chunks.join('')),
  }
}

// Matched on cmd/args, not exact key strings, so a flag tweak in start.js cannot
// silently turn an assertion vacuous.
function makeExec({ npm, queue = '1', tmuxHasSession = 1, ghAuth = 0, launch = 0 } = {}, timeline = []) {
  const calls = []
  const exec = async (cmd, args = []) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    timeline.push(`exec:${key}`)
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: tmuxHasSession, stdout: '', stderr: '' }
    if (cmd === 'tmux' && args[0] === 'new') return { exitCode: launch, stdout: '', stderr: launch === 0 ? '' : 'boom' }
    if (cmd === 'npm' && args[0] === 'view') {
      return npm ?? { exitCode: 0, stdout: '0.2.0\n', stderr: '', timedOut: false }
    }
    if (cmd === 'gh' && args[0] === 'auth') return { exitCode: ghAuth, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue' && args.includes('--search')) {
      return { exitCode: 0, stdout: queue, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  exec.npmViews = () => calls.filter((c) => c === NPM_VIEW)
  return exec
}

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

// Every op on the global cache, in order, with the bytes written — so the write
// SEQUENCE (decision first, stamp second, stamp built on the decision's bytes) is
// observable, not just the final file.
function spyFs(v) {
  const ops = []
  return {
    ops,
    writes: () => ops.filter((o) => o.op === 'write'),
    readFileSync: (...a) => {
      ops.push({ op: 'read', path: String(a[0]) })
      return v.readFileSync(...a)
    },
    writeFileSync: (...a) => {
      ops.push({ op: 'write', path: String(a[0]), data: String(a[1]) })
      return v.writeFileSync(...a)
    },
    mkdirSync: (...a) => {
      ops.push({ op: 'mkdir', path: String(a[0]) })
      return v.mkdirSync(...a)
    },
    statSync: (...a) => v.statSync(...a),
    existsSync: (...a) => v.existsSync(...a),
  }
}

function deps(overrides = {}, execOptions = {}) {
  const timeline = []
  const stdout = makeStream(timeline, 'out')
  const stderr = makeStream(timeline, 'err')
  const ask = overrides.ask ?? makeAsk(false)
  const runUpdate = overrides.runUpdate ?? makeRunUpdate()
  const stampCalls = []
  // The DEFAULT stamp is the real recordPromptShown, so the cache assertions are
  // about production behaviour; the wrapper only records the call on the shared
  // timeline. An override replaces the callee but is still recorded.
  const innerStamp = overrides.recordPrompt ?? recordPromptShown
  const d = {
    cwd: '/repo',
    stdout,
    stderr,
    stdin: { marker: 'injected-stdin', isTTY: false },
    isTTY: true,
    exec: makeExec(execOptions, timeline),
    exists: () => false,
    loadEnv: () => ({}),
    readFile: () => '',
    hasCommand: () => true,
    peekLock: () => null,
    folderQueueCount: async () => 1,
    currentVersion: '0.1.0',
    now: () => T0,
    home: HOME,
    processEnv: {},
    cacheFs: new Volume(),
    sendWa: async () => ({ ok: true }),
    ...overrides,
    ask,
    runUpdate,
  }
  d.recordPrompt = (args) => {
    timeline.push('stamp')
    stampCalls.push(args)
    return innerStamp(args)
  }
  d.stampCalls = stampCalls
  const innerAsk = d.ask
  const wrappedAsk = (question, options) => {
    timeline.push('ask')
    return innerAsk(question, options)
  }
  wrappedAsk.calls = innerAsk.calls
  d.ask = wrappedAsk
  d.timeline = timeline
  d.at = (needle) => timeline.findIndex((e) => e.includes(needle))
  return d
}

const cacheOf = (fs, processEnv = {}) => readVersionCache({ fs, home: HOME, processEnv })
const rawOf = (fs, path = CACHE_PATH) => fs.readFileSync(path, 'utf8').toString()
const seededCache = (cache) => Volume.fromJSON({ [CACHE_PATH]: JSON.stringify(cache) }, '/')
const seededRaw = (raw) => Volume.fromJSON({ [CACHE_PATH]: raw }, '/')

describe('QA #26 the stamp is written BEFORE the answer is awaited', () => {
  it('records the stamp before calling ask, on one timeline', async () => {
    const d = deps()
    await startCommand(d)
    expect(d.at('stamp')).toBeGreaterThan(-1)
    expect(d.at('ask')).toBeGreaterThan(-1)
    expect(d.at('stamp')).toBeLessThan(d.at('ask'))
    // ...and after the notice, so nothing is stamped for a question the user never
    // saw a reason for.
    expect(d.at(NOTICE)).toBeLessThan(d.at('stamp'))
  })

  it('keeps the window burned when ask REJECTS (the Ctrl-C at the prompt)', async () => {
    const cacheFs = new Volume()
    const boom = new Error('SIGINT')
    const d = deps({
      cacheFs,
      ask: makeAsk(() => Promise.reject(boom)),
    })
    await expect(startCommand(d)).rejects.toBe(boom)
    // The run aborted, but the question WAS put to a human: asking again seconds
    // later on the next `ralph start` is exactly what #26 forbids.
    expect(cacheOf(cacheFs)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
  })

  it('keeps the window burned when ask throws SYNCHRONOUSLY', async () => {
    const cacheFs = new Volume()
    const d = deps({
      cacheFs,
      ask: makeAsk(() => {
        throw new Error('tty vanished')
      }),
    })
    await expect(startCommand(d)).rejects.toThrow('tty vanished')
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))
  })

  it('has already burned the window while ask is still PENDING (a prompt left unanswered)', async () => {
    const cacheFs = new Volume()
    const d = deps({ cacheFs, ask: makeAsk(() => new Promise(() => {})) })
    const pending = startCommand(d).catch(() => 'threw')
    const outcome = await Promise.race([
      pending.then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('still-waiting'), 20)),
    ])
    expect(outcome).toBe('still-waiting')
    expect(d.ask.calls).toHaveLength(1)
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))
  })

  it('keeps the window burned when the run aborts AFTER the question (gh auth)', async () => {
    const cacheFs = new Volume()
    const d = deps({ cacheFs, ask: makeAsk(false) }, { ghAuth: 1 })
    await expect(startCommand(d)).rejects.toBeInstanceOf(StartAbort)
    expect(d.ask.calls).toHaveLength(1)
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))
  })

  it('does NOT stamp when the prompt window is already closed', async () => {
    const seed = {
      last_check_at: iso(T0 - DAY),
      last_prompted_at: iso(T0 - 2 * DAY),
      latest_version: '0.2.0',
    }
    const cacheFs = seededCache(seed)
    const before = rawOf(cacheFs)
    const d = deps({ cacheFs })
    const result = await startCommand(d)
    expect(d.stampCalls).toHaveLength(0)
    expect(d.ask.calls).toHaveLength(0)
    expect(rawOf(cacheFs)).toBe(before)
    expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
  })

  it('does NOT stamp when there is nothing newer to offer', async () => {
    const cacheFs = new Volume()
    const d = deps({ cacheFs, currentVersion: '0.2.0' })
    await startCommand(d)
    expect(d.stampCalls).toHaveLength(0)
    expect(cacheOf(cacheFs).last_prompted_at).toBeNull()
  })

  it('does NOT stamp without a TTY, however loudly the injected ask would answer', async () => {
    const cacheFs = new Volume()
    const d = deps({ cacheFs, isTTY: false, ask: makeAsk(true) })
    await startCommand(d)
    expect(d.stampCalls).toHaveLength(0)
    expect(d.ask.calls).toHaveLength(0)
    expect(cacheOf(cacheFs).last_prompted_at).toBeNull()
    expect(d.stdout.output()).toContain(NOTICE)
  })

  it('does NOT stamp when isTTY is left to default in a vitest worker (the hermeticity rule)', async () => {
    const cacheFs = new Volume()
    const d = deps({ cacheFs })
    delete d.isTTY
    await startCommand(d)
    expect(d.stampCalls).toHaveLength(0)
    expect(cacheOf(cacheFs).last_prompted_at).toBeNull()
    // Positive control: the very same run with a TTY-looking injected stdin DOES
    // stamp — so the assertion above is about the gate, not about a broken harness.
    const stamped = new Volume()
    const withTty = deps({ cacheFs: stamped, stdin: { isTTY: true } })
    delete withTty.isTTY
    await startCommand(withTty)
    expect(withTty.stampCalls).toHaveLength(1)
    expect(cacheOf(stamped).last_prompted_at).toBe(iso(T0))
  })

  it('stamps at the run’s `now`, not the wall clock', async () => {
    const cacheFs = new Volume()
    const when = T0 - 5 * DAY
    await startCommand(deps({ cacheFs, now: () => when }))
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(when))
  })
})

describe('QA #26 the accept path stamps exactly once, before it returns early', () => {
  it('a SUCCESSFUL update returns early with the window already burned', async () => {
    const cacheFs = spyFs(new Volume())
    const d = deps({ cacheFs, ask: makeAsk(true) })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.runUpdate.calls).toHaveLength(1)
    expect(d.stampCalls).toHaveLength(1)
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))
    // Two writes total: #24's check stamp, then #26's prompt stamp. Never three.
    expect(cacheFs.writes().map((o) => o.path)).toEqual([CACHE_PATH, CACHE_PATH])
  })

  for (const [label, result] of [
    ['a FAILED install', { exitCode: 1, updated: false, from: '0.1.0', to: '0.2.0' }],
    ['nothing to update here (npx / linked checkout)', { exitCode: 0, updated: false }],
    ['a THROWING update', () => Promise.reject(new Error('npm exploded'))],
    ['a synchronously throwing update', () => { throw new Error('npm exploded') }],
    ['a garbage return', 'not-an-object'],
    ['an undefined return', undefined],
  ]) {
    it(`${label} still leaves exactly one stamp and starts the loop`, async () => {
      const cacheFs = spyFs(new Volume())
      const d = deps({ cacheFs, ask: makeAsk(true), runUpdate: makeRunUpdate(result) })
      const outcome = await startCommand(d)
      expect(outcome).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.stampCalls).toHaveLength(1)
      expect(cacheFs.writes()).toHaveLength(2)
      expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))
    })
  }

  it('an accepted, throttled run writes ONLY the prompt stamp', async () => {
    const checkedAt = iso(T0 - DAY)
    const cacheFs = spyFs(
      seededCache({ last_check_at: checkedAt, last_prompted_at: null, latest_version: '0.2.0' }),
    )
    const d = deps({ cacheFs, ask: makeAsk(true) })
    await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(cacheFs.writes()).toHaveLength(1)
    expect(cacheOf(cacheFs)).toEqual({
      last_check_at: checkedAt,
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
  })

  it('the early return does not lose the stamp: the next run inside the window is silent', async () => {
    // The install "succeeded" but this process still reports the old version (the
    // real run would exec a new one). If the early return had skipped the stamp,
    // the user would be asked again on their very next start.
    const cacheFs = new Volume()
    const first = deps({ cacheFs, ask: makeAsk(true) })
    expect(await startCommand(first)).toEqual({ exitCode: 0, started: false })
    const second = deps({ cacheFs, now: () => T0 + 3 * DAY, ask: makeAsk(true) })
    const result = await startCommand(second)
    expect(second.ask.calls).toHaveLength(0)
    expect(second.runUpdate.calls).toHaveLength(0)
    expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))
  })

  it('accepting and declining burn the window identically', async () => {
    const accepted = new Volume()
    await startCommand(deps({ cacheFs: accepted, ask: makeAsk(true) }))
    const declined = new Volume()
    await startCommand(deps({ cacheFs: declined, ask: makeAsk(false) }))
    expect(rawOf(declined)).toBe(rawOf(accepted))
  })
})

describe('QA #26 the two windows crossing, through the real decision and stamp', () => {
  it('fresh check + ancient prompt: no query, one question, check stamp untouched', async () => {
    const checkedAt = iso(T0 - DAY)
    const cacheFs = seededCache({
      last_check_at: checkedAt,
      last_prompted_at: iso(T0 - 30 * DAY),
      latest_version: '0.2.0',
    })
    const d = deps({ cacheFs })
    await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(d.ask.calls).toHaveLength(1)
    expect(cacheOf(cacheFs)).toEqual({
      last_check_at: checkedAt,
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
  })

  it('ancient check + fresh prompt: one query, no question, prompt stamp preserved to the byte', async () => {
    const promptedAt = iso(T0 - 3 * DAY)
    const cacheFs = seededCache({
      last_check_at: iso(T0 - 30 * DAY),
      last_prompted_at: promptedAt,
      latest_version: '0.1.5',
    })
    const d = deps({ cacheFs })
    await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(1)
    expect(d.ask.calls).toHaveLength(0)
    expect(JSON.parse(rawOf(cacheFs))).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: promptedAt,
      latest_version: '0.2.0',
    })
  })

  it('both windows open: the stamp is built on the refreshed cache, not a stale snapshot', async () => {
    const cacheFs = spyFs(
      seededCache({
        last_check_at: iso(T0 - 30 * DAY),
        last_prompted_at: iso(T0 - 30 * DAY),
        latest_version: '0.1.5',
      }),
    )
    const d = deps({ cacheFs })
    await startCommand(d)
    const writes = cacheFs.writes()
    expect(writes).toHaveLength(2)
    // Write 1 — the decision: check window re-stamped, version refreshed, prompt
    // window carried through untouched.
    expect(JSON.parse(writes[0].data)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0 - 30 * DAY),
      latest_version: '0.2.0',
    })
    // Write 2 — the stamp: re-read from disk, so write 1's fresh values survive
    // instead of the pre-refresh ones coming back.
    expect(JSON.parse(writes[1].data)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
  })

  it('an offline run stamps the prompt it showed and keeps the cached version', async () => {
    const cacheFs = spyFs(
      seededCache({
        last_check_at: iso(T0 - 30 * DAY),
        last_prompted_at: null,
        latest_version: '0.2.0',
      }),
    )
    const d = deps({ cacheFs }, { npm: { exitCode: 1, stdout: '', stderr: 'offline' } })
    await startCommand(d)
    expect(d.ask.calls).toHaveLength(1)
    expect(cacheOf(cacheFs)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
  })

  it('an unwritable cache burns no window, so the next run still asks', async () => {
    // Best-effort by design: losing the stamp costs one extra question, never the
    // run. Documented here so a future "fail loudly" change has to face it.
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
    const second = deps({ cacheFs, now: () => T0 + 60_000 })
    await startCommand(first)
    await startCommand(second)
    expect(first.ask.calls).toHaveLength(1)
    expect(second.ask.calls).toHaveLength(1)
    expect(first.stderr.output()).toBe('')
    expect(second.stderr.output()).toBe('')
  })

  it('honours XDG_CONFIG_HOME for both writes, and writes nowhere else', async () => {
    const cacheFs = new Volume()
    const processEnv = { XDG_CONFIG_HOME: '/xdg' }
    const d = deps({ cacheFs, processEnv })
    await startCommand(d)
    const xdgPath = versionCachePath({ processEnv, home: HOME })
    expect(Object.keys(cacheFs.toJSON())).toEqual([xdgPath])
    expect(JSON.parse(rawOf(cacheFs, xdgPath))).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
  })
})

describe('QA #26 back-to-back runs over one shared cache', () => {
  it('asks once, stays quiet for a week, and asks again on the far side', async () => {
    const cacheFs = new Volume()
    const asks = []
    const stamps = []
    for (const now of [T0, T0 + 60_000, T0 + 6 * DAY, T0 + WEEK, T0 + WEEK + DAY]) {
      const d = deps({ cacheFs, now: () => now })
      await startCommand(d)
      asks.push(d.ask.calls.length)
      stamps.push(cacheOf(cacheFs).last_prompted_at)
    }
    expect(asks).toEqual([1, 0, 0, 1, 0])
    expect(stamps).toEqual([iso(T0), iso(T0), iso(T0), iso(T0 + WEEK), iso(T0 + WEEK)])
  })

  it('two runs in the SAME millisecond ask once — the first stamp is visible immediately', async () => {
    const cacheFs = new Volume()
    const first = deps({ cacheFs })
    const second = deps({ cacheFs })
    await startCommand(first)
    await startCommand(second)
    expect(first.ask.calls).toHaveLength(1)
    expect(second.ask.calls).toHaveLength(0)
    expect(second.exec.npmViews()).toHaveLength(0)
    expect(second.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })

  it('a second REPO in the same millisecond is suppressed too (one global window)', async () => {
    const cacheFs = new Volume()
    const a = deps({ cacheFs, cwd: '/repo-a' })
    const b = deps({ cacheFs, cwd: '/repo-b' })
    await startCommand(a)
    await startCommand(b)
    expect(a.ask.calls).toHaveLength(1)
    expect(b.ask.calls).toHaveLength(0)
    expect(a.exec.calls[0]).toContain(sessionNameFor('/repo-a'))
    expect(b.exec.calls[0]).toContain(sessionNameFor('/repo-b'))
    expect(JSON.parse(rawOf(cacheFs)).last_prompted_at).toBe(iso(T0))
  })

  it('five repos in one window produce exactly one question and one stamp write', async () => {
    const cacheFs = spyFs(new Volume())
    const asks = []
    for (let i = 0; i < 5; i++) {
      const d = deps({ cacheFs, cwd: `/repo-${i}`, now: () => T0 + i * 60_000 })
      await startCommand(d)
      asks.push(d.ask.calls.length)
    }
    expect(asks).toEqual([1, 0, 0, 0, 0])
    // One decision write (the first run's query) plus one stamp write. The other
    // four runs are throttled on both windows and write nothing at all.
    expect(cacheFs.writes()).toHaveLength(2)
  })

  it('a #24-era cache with no last_prompted_at key at all prompts, then gains the field', async () => {
    // The upgrade path: every cache written before this slice has two fields. A
    // missing stamp must read as "never prompted", not as a closed window.
    const cacheFs = Volume.fromJSON(
      {
        [CACHE_PATH]: JSON.stringify({
          last_check_at: iso(T0 - DAY),
          latest_version: '0.2.0',
        }),
      },
      '/',
    )
    const d = deps({ cacheFs })
    await startCommand(d)
    expect(d.ask.calls).toHaveLength(1)
    expect(Object.keys(JSON.parse(rawOf(cacheFs))).sort()).toEqual([
      'last_check_at',
      'last_prompted_at',
      'latest_version',
    ])
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))
  })

  it('a NEWER release discovered inside the window does not re-open it', async () => {
    // Deliberate: the throttle is per-window, not per-version. With no
    // declined_version there is nothing to compare against, and "one question a
    // week" has to hold even when the registry moves twice in that week.
    const cacheFs = seededCache({
      last_check_at: iso(T0 - 8 * DAY),
      last_prompted_at: iso(T0 - DAY),
      latest_version: '0.2.0',
    })
    const d = deps({ cacheFs }, { npm: { exitCode: 0, stdout: '9.9.9\n', stderr: '' } })
    await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(1)
    expect(d.ask.calls).toHaveLength(0)
    // The notice still names the brand-new version — only the question waits.
    expect(d.stdout.output()).toContain(`${NOTICE}: 9.9.9`)
    expect(cacheOf(cacheFs)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0 - DAY),
      latest_version: '9.9.9',
    })
  })

  it('a burst of simultaneous runs still leaves one valid, closed window', async () => {
    // There is no lock around the cache — three `ralph start`s launched at the same
    // instant can each read the same open window before any of them stamps, which
    // is the same last-writer-wins race #24 already documents for last_check_at.
    // What must hold regardless: the file is never corrupt, and the burst leaves
    // the window CLOSED so the runs that follow are silent.
    const cacheFs = new Volume()
    const runs = [deps({ cacheFs }), deps({ cacheFs }), deps({ cacheFs })]
    await Promise.all(runs.map((d) => startCommand(d)))
    expect(cacheOf(cacheFs)).toEqual({
      last_check_at: iso(T0),
      last_prompted_at: iso(T0),
      latest_version: '0.2.0',
    })
    const after = deps({ cacheFs, now: () => T0 + DAY })
    await startCommand(after)
    expect(after.ask.calls).toHaveLength(0)
    expect(after.exec.npmViews()).toHaveLength(0)
  })

  it('a headless run between two interactive ones neither burns nor blocks the window', async () => {
    const cacheFs = new Volume()
    const headless = deps({ cacheFs, isTTY: false })
    await startCommand(headless)
    expect(cacheOf(cacheFs).last_prompted_at).toBeNull()
    const interactive = deps({ cacheFs, now: () => T0 + DAY })
    await startCommand(interactive)
    expect(interactive.ask.calls).toHaveLength(1)
    expect(interactive.exec.npmViews()).toHaveLength(0)
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0 + DAY))
  })
})

describe('QA #26 malformed cache files driven through the whole command', () => {
  const hostile = [
    ['a JSON array', '[]'],
    ['an array holding a fresh stamp', `[{"last_prompted_at":"${iso(T0)}"}]`],
    ['a JSON string', '"2026-08-22T12:00:00.000Z"'],
    ['JSON null', 'null'],
    ['a JSON number', '42'],
    ['mangled JSON', '{ not json'],
    ['an empty file', ''],
    ['a numeric last_prompted_at', '{"last_prompted_at":0}'],
    ['a boolean last_prompted_at', '{"last_prompted_at":true}'],
    ['an object last_prompted_at', `{"last_prompted_at":{"at":"${iso(T0)}"}}`],
    ['a blank last_prompted_at', '{"last_prompted_at":"   "}'],
    ['a non-ISO last_prompted_at', '{"last_prompted_at":"tomorrow"}'],
  ]

  for (const [label, raw] of hostile) {
    it(`${label} → one question, and the file is repaired`, async () => {
      const cacheFs = seededRaw(raw)
      const d = deps({ cacheFs })
      const result = await startCommand(d)
      expect({ label, asks: d.ask.calls.length }).toEqual({ label, asks: 1 })
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.stderr.output()).toBe('')
      expect(cacheOf(cacheFs)).toEqual({
        last_check_at: iso(T0),
        last_prompted_at: iso(T0),
        latest_version: '0.2.0',
      })
    })
  }

  it('a hand-added declined_version cannot survive a run, or suppress the next window', async () => {
    const cacheFs = seededCache({
      last_check_at: iso(T0 - DAY),
      last_prompted_at: null,
      latest_version: '0.2.0',
      declined_version: '0.2.0',
      snooze_until: iso(T0 + 365 * DAY),
    })
    const first = deps({ cacheFs })
    await startCommand(first)
    expect(first.ask.calls).toHaveLength(1)
    expect(rawOf(cacheFs)).not.toMatch(/declined|snooze/i)
    expect(Object.keys(JSON.parse(rawOf(cacheFs))).sort()).toEqual([
      'last_check_at',
      'last_prompted_at',
      'latest_version',
    ])
    // Inside the window: suppressed. Past it: offered again, same version.
    const inside = deps({ cacheFs, now: () => T0 + 3 * DAY })
    await startCommand(inside)
    expect(inside.ask.calls).toHaveLength(0)
    const after = deps({ cacheFs, now: () => T0 + 8 * DAY })
    await startCommand(after)
    expect(after.ask.calls).toHaveLength(1)
    expect(after.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })

  it('a future prompt stamp is treated as due and rewound, not honoured forever', async () => {
    const cacheFs = seededCache({
      last_check_at: iso(T0 - DAY),
      last_prompted_at: iso(T0 + 365 * DAY),
      latest_version: '0.2.0',
    })
    const d = deps({ cacheFs })
    await startCommand(d)
    expect(d.ask.calls).toHaveLength(1)
    expect(cacheOf(cacheFs).last_prompted_at).toBe(iso(T0))
    // Rewound, so the NEXT run is throttled normally rather than asking forever.
    const next = deps({ cacheFs, now: () => T0 + DAY })
    await startCommand(next)
    expect(next.ask.calls).toHaveLength(0)
  })
})

describe('QA #26 the recordPrompt injection seam', () => {
  it('hands the stamp the very same clock, env, home and fs objects the decision got', async () => {
    const decisionArgs = []
    const cacheFs = new Volume()
    const d = deps({
      cacheFs,
      update: async (args) => {
        decisionArgs.push(args)
        return {
          latestVersion: '0.2.0',
          isNewer: true,
          shouldPrompt: true,
          source: 'network',
          updatedCache: null,
        }
      },
      recordPrompt: () => null,
    })
    await startCommand(d)
    expect(decisionArgs).toHaveLength(1)
    expect(d.stampCalls).toHaveLength(1)
    const [decision] = decisionArgs
    const [stamp] = d.stampCalls
    expect(stamp.now).toBe(decision.now)
    expect(stamp.processEnv).toBe(decision.processEnv)
    expect(stamp.home).toBe(decision.home)
    expect(stamp.fs).toBe(decision.fs)
    expect(stamp.fs).toBe(cacheFs)
  })

  for (const [label, value] of [
    ['null', null],
    ['undefined', undefined],
    ['false', false],
    ['a string', 'stamped'],
    ['a number', 0],
    ['an object with junk keys', { declined_version: '0.2.0' }],
  ]) {
    it(`ignores a stamp that returns ${label}`, async () => {
      const d = deps({ recordPrompt: () => value, ask: makeAsk(false) })
      const result = await startCommand(d)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.ask.calls).toHaveLength(1)
      expect(d.stderr.output()).toBe('')
    })
  }

  it('a stamp that mutates its argument bag cannot corrupt the run', async () => {
    const d = deps({
      recordPrompt: (args) => {
        args.fs = null
        args.home = 42
        args.now = null
        return null
      },
    })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
    expect(d.ask.calls).toHaveLength(1)
  })
})
