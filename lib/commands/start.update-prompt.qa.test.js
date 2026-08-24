import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { dirname } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { startCommand, StartAbort } from './start.js'
import { sessionNameFor } from '../lock.js'
import { globalConfigPath } from '../utils/global-config.js'
import { readVersionCache, versionCachePath } from '../version-cache.js'
import { confirm } from '../utils/prompt.js'

// #25 QA augmentation — the TTY-gated update prompt in `ralph start`. The dev's
// test/commands/start.test.js proves the acceptance criteria (asks on a TTY,
// accept returns without starting, decline starts, failure warns, no TTY never
// asks). This file attacks the integration around it:
//   - the ORDER of the prompt against every observable side effect, read off ONE
//     timeline that records exec spawns, fs probes AND stdout writes;
//   - the accept path's side effects — proving the loop, the gh calls, the MCP
//     probe and the WhatsApp notification are all skipped even when each one's
//     preconditions are satisfied;
//   - folder source, where there is no gh at all;
//   - hostile `ask` and `runUpdate` returns (non-boolean, non-promise, throwing,
//     rejecting with a non-Error, `{updated:true}` with no `to`);
//   - the output contract (one notice, one warn, clean stderr, no duplication of
//     updateCommand's own diagnostics);
//   - the global cache: accepting must not re-stamp #24's fields, and (since #26)
//     showing the prompt stamps last_prompted_at and nothing else;
//   - the abort guards, each proven to win BEFORE any prompt;
//   - a throttled, cache-served run still prompting;
//   - the isTTY default, which follows the RESOLVED stdin — the injected stream
//     when there is one, the ambient `process.stdin` otherwise — with
//     `process.stdin` stubbed deterministically so the result never depends on
//     how `npm test` was invoked;
//   - the real `confirm` from lib/utils/prompt.js wired end-to-end through
//     startCommand over in-process fake streams.
//
// isTTY is passed EXPLICITLY everywhere except the tests whose whole point is the
// default, and those stub `process.stdin` rather than reading the real one.

const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const ENV_PATH = globalConfigPath({ processEnv: {}, home: HOME })
const NPM_VIEW = 'npm view @lucasfe/ralph version'
const PROMPT = 'Update now? [y/N]: '
const NOTICE = 'New version available'
const UPDATED = 'Updated to'
const WARN = 'Update did not complete'
const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const SESSION = sessionNameFor('/repo')
const TMUX_GUARD = `tmux has-session -t ${SESSION}`

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

// Same idiom as the #24 QA harness: matched on cmd/args rather than exact key
// strings so a search-query or flag tweak in start.js cannot silently defuse a
// test into vacuous truth.
function makeExec(
  { npm, queue = '1', orphan = '', tmuxHasSession = 1, ghAuth = 0, jq = 0, launch = 0 } = {},
  timeline = [],
) {
  const calls = []
  const exec = async (cmd, args = []) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    timeline.push(`exec:${key}`)
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: tmuxHasSession, stdout: '', stderr: '' }
    }
    if (cmd === 'tmux' && args[0] === 'new') {
      return { exitCode: launch, stdout: '', stderr: launch === 0 ? '' : 'boom' }
    }
    if (cmd === 'npm' && args[0] === 'view') {
      return npm ?? { exitCode: 0, stdout: '0.2.0\n', stderr: '', timedOut: false }
    }
    if (cmd === 'jq') return { exitCode: jq, stdout: 'memory', stderr: '' }
    if (cmd === 'gh' && args[0] === 'auth') return { exitCode: ghAuth, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue' && args.includes('--search')) {
      return { exitCode: 0, stdout: queue, stderr: '' }
    }
    if (cmd === 'gh' && args[0] === 'issue') return { exitCode: 0, stdout: orphan, stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  exec.npmViews = () => calls.filter((c) => c === NPM_VIEW)
  exec.ghCalls = () => calls.filter((c) => c.startsWith('gh '))
  return exec
}

// `reply` may be a value (resolved) or a function (called for its raw return —
// used to exercise non-promise returns, throws and rejections).
// Rest args, not a default parameter: makeAsk(undefined) must mean "resolve
// undefined", which a `reply = true` default would silently turn into an accept.
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

// Rest args for the same reason as makeAsk: makeRunUpdate(undefined) must mean
// "resolve undefined", not "resolve the happy-path object".
function makeRunUpdate(...args) {
  const result = args.length ? args[0] : OK_UPDATE
  const calls = []
  const fn = (args) => {
    calls.push(args)
    return typeof result === 'function' ? result(args) : Promise.resolve(result)
  }
  fn.calls = calls
  return fn
}

function makeWa() {
  const calls = []
  const sendWa = async (args) => {
    calls.push(args)
    return { ok: true }
  }
  sendWa.calls = calls
  return sendWa
}

function deps(overrides = {}, execOptions = {}) {
  const timeline = []
  const stdout = makeStream(timeline, 'out')
  const stderr = makeStream(timeline, 'err')
  const ask = overrides.ask ?? makeAsk(true)
  const runUpdate = overrides.runUpdate ?? makeRunUpdate()
  const sendWa = overrides.sendWa ?? makeWa()
  const d = {
    cwd: '/repo',
    stdout,
    stderr,
    // A sentinel, NOT process.stdin: identity is asserted at the ask() call site
    // and nothing here may ever touch the real terminal.
    stdin: { marker: 'injected-stdin', isTTY: false },
    isTTY: true,
    exec: makeExec(execOptions, timeline),
    exists: (p) => {
      timeline.push(`exists:${p}`)
      return false
    },
    loadEnv: (p) => {
      timeline.push(`loadEnv:${p}`)
      return {}
    },
    readFile: (p) => {
      timeline.push(`readFile:${p}`)
      return ''
    },
    hasCommand: (c) => {
      timeline.push(`hasCommand:${c}`)
      return true
    },
    peekLock: () => {
      timeline.push('peekLock')
      return null
    },
    folderQueueCount: async () => {
      timeline.push('folderQueueCount')
      return 1
    },
    currentVersion: '0.1.0',
    now: () => T0,
    home: HOME,
    processEnv: {},
    cacheFs: new Volume(),
    ...overrides,
    ask,
    runUpdate,
    sendWa,
  }
  d.timeline = timeline
  d.at = (needle) => timeline.findIndex((e) => e.includes(needle))
  d.askIdx = () => timeline.findIndex((e) => e === 'ask')
  // ask() is recorded on the same timeline so ordering against exec spawns, fs
  // probes and printed lines is read from one sequence.
  const inner = d.ask
  const wrapped = (question, options) => {
    timeline.push('ask')
    return inner(question, options)
  }
  wrapped.calls = inner.calls
  d.ask = wrapped
  return d
}

const folderOverrides = (extra = {}) => ({
  exists: (p) => String(p).endsWith('ralph.config.sh'),
  readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : ''),
  ...extra,
})

// A cache fs that records every op, so "the accept path touches nothing else"
// is proven at the call level.
function spyFs(v) {
  const ops = []
  return {
    ops,
    readFileSync: (...a) => {
      ops.push({ op: 'read', path: String(a[0]) })
      return v.readFileSync(...a)
    },
    writeFileSync: (...a) => {
      ops.push({ op: 'write', path: String(a[0]) })
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

const warmCache = (latest = '0.2.0', ageMs = DAY) =>
  Volume.fromJSON(
    {
      [CACHE_PATH]: JSON.stringify({
        last_check_at: new Date(T0 - ageMs).toISOString(),
        last_prompted_at: null,
        latest_version: latest,
      }),
    },
    '/',
  )

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

describe('QA #25 prompt ordering — one timeline, every side effect', () => {
  it('asks after the tmux guard, the cycle-lock guard, every dep probe and the notice', async () => {
    const d = deps()
    await startCommand(d)
    const askIdx = d.askIdx()
    const lastDepProbe = d.timeline.reduce(
      (acc, e, i) => (e.startsWith('hasCommand:') ? i : acc),
      -1,
    )
    expect(askIdx).toBeGreaterThan(-1)
    expect(d.at(`exec:${TMUX_GUARD}`)).toBeLessThan(askIdx)
    expect(d.at('peekLock')).toBeLessThan(askIdx)
    expect(lastDepProbe).toBeLessThan(askIdx)
    expect(d.at(`exec:${NPM_VIEW}`)).toBeLessThan(askIdx)
    // #24's notice is printed BEFORE the question, never replaced by it.
    expect(d.at(`out:${NOTICE}`)).toBeLessThan(askIdx)
  })

  it('on ACCEPT nothing after step 2.5 ever runs — no .env.local, gh, jq, labels, orphans, queue or launch', async () => {
    const d = deps({}, { orphan: '  #7 stuck' })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    const after = d.timeline.slice(d.askIdx() + 1)
    expect(after.filter((e) => e.startsWith('exec:'))).toEqual([])
    expect(after.some((e) => e.startsWith('exists:'))).toBe(false)
    expect(after.some((e) => e.startsWith('loadEnv:'))).toBe(false)
    expect(after.some((e) => e === 'folderQueueCount')).toBe(false)
    expect(d.exec.calls).toEqual([TMUX_GUARD, NPM_VIEW])
  })

  it('on DECLINE the question precedes the .env.local read, gh auth, labels, orphans, queue and launch', async () => {
    const d = deps({ ask: makeAsk(false) }, { orphan: '  #7 stuck' })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
    const askIdx = d.askIdx()
    for (const marker of [
      'exists:/repo/.env.local',
      'exec:gh auth status',
      'exec:gh label create claude-working',
      'exec:gh issue list --state open --label claude-working',
      'exec:gh issue list --search',
      'exec:tmux new',
    ]) {
      expect(d.at(marker), marker).toBeGreaterThan(askIdx)
    }
  })

  it('asks exactly once per run', async () => {
    const d = deps({ ask: makeAsk(false) })
    await startCommand(d)
    expect(d.ask.calls).toHaveLength(1)
    expect(d.timeline.filter((e) => e === 'ask')).toHaveLength(1)
  })

  it('hands confirm the injected stdin and stdout, and nothing else', async () => {
    const d = deps()
    await startCommand(d)
    expect(d.ask.calls[0].question).toBe(PROMPT)
    expect(d.ask.calls[0].options.input).toBe(d.stdin)
    expect(d.ask.calls[0].options.output).toBe(d.stdout)
    expect(Object.keys(d.ask.calls[0].options).sort()).toEqual(['input', 'output'])
  })
})

describe('QA #25 the accept path has no side effects', () => {
  it('sends NO WhatsApp startup notification even when credentials are present', async () => {
    const d = deps({
      exists: (p) => String(p).endsWith('.env.local'),
      loadEnv: () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+15550001111' }),
    })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.sendWa.calls).toHaveLength(0)
    // The creds were never even resolved, so neither notification line appears.
    expect(d.stdout.output()).not.toContain('WhatsApp')
    expect(d.stdout.output()).not.toContain('📲')
  })

  it('never probes .mcp.json with jq — a broken .mcp.json cannot defeat an accepted update', async () => {
    const d = deps({ exists: (p) => String(p).endsWith('.mcp.json') }, { jq: 1 })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.exec.calls.some((c) => c.startsWith('jq '))).toBe(false)
    expect(d.stderr.output()).toBe('')
  })

  it('never sweeps orphans, so an interrupted previous run is not reported twice', async () => {
    const d = deps({}, { orphan: '  #7 stuck\n  #8 also stuck' })
    await startCommand(d)
    expect(d.stdout.output()).not.toContain('claude-working')
    expect(d.exec.ghCalls()).toEqual([])
  })

  it('never launches tmux, re-execs, or spawns an install of its own', async () => {
    const d = deps()
    await startCommand(d)
    expect(d.exec.calls.some((c) => c.startsWith('tmux new'))).toBe(false)
    expect(d.exec.calls.some((c) => c.includes('install') || c.includes('npm i'))).toBe(false)
    expect(d.exec.calls.some((c) => c.includes('ralph start'))).toBe(false)
    // The install went through the injected runUpdate, not a spawn from start.js.
    expect(d.runUpdate.calls).toHaveLength(1)
  })

  it('returns the SAME shape as the empty-queue early return (no count key)', async () => {
    const d = deps()
    const result = await startCommand(d)
    expect(Object.keys(result).sort()).toEqual(['exitCode', 'started'])
    expect(result.exitCode).toBe(0)
  })

  it('hands runUpdate exactly {currentVersion, exec, stdout, stderr}', async () => {
    const d = deps()
    await startCommand(d)
    const args = d.runUpdate.calls[0]
    expect(Object.keys(args).sort()).toEqual(['currentVersion', 'exec', 'stderr', 'stdout'])
    expect(args.currentVersion).toBe('0.1.0')
    expect(args.exec).toBe(d.exec)
    expect(args.stdout).toBe(d.stdout)
    expect(args.stderr).toBe(d.stderr)
    // No `force`, and no processEnv/home leak into the update machinery.
    expect(args.force).toBeUndefined()
  })
})

describe('QA #25 folder source — a prompt with no gh anywhere', () => {
  it('still asks, and accepting returns without counting the folder queue', async () => {
    const d = deps(folderOverrides())
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.ask.calls).toHaveLength(1)
    expect(d.exec.calls).toEqual([TMUX_GUARD, NPM_VIEW])
    expect(d.timeline).not.toContain('folderQueueCount')
    expect(d.stdout.output()).toContain(`${UPDATED} 0.2.0`)
  })

  it('accepting returns started:false even when the folder queue is EMPTY', async () => {
    const d = deps(folderOverrides({ folderQueueCount: async () => 0 }))
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.stdout.output()).toContain(`${UPDATED} 0.2.0`)
    expect(d.stdout.output()).not.toContain('No issues in the queue')
  })

  it('declining launches the folder loop and never touches gh', async () => {
    const d = deps(folderOverrides({ ask: makeAsk(false), folderQueueCount: async () => 3 }))
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(d.exec.ghCalls()).toEqual([])
    expect(d.exec.calls.some((c) => c.startsWith('tmux new'))).toBe(true)
  })

  it('declining with an EMPTY folder queue exits "nothing to do" with the notice intact', async () => {
    const d = deps(folderOverrides({ ask: makeAsk(false), folderQueueCount: async () => 0 }))
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.stdout.output()).toContain('No issues in the queue')
    expect(d.stdout.lines().filter((l) => l.includes(NOTICE))).toHaveLength(1)
  })

  it('a failed update in folder mode still launches the folder loop', async () => {
    const d = deps(
      folderOverrides({ runUpdate: makeRunUpdate({ exitCode: 1, updated: false, to: '0.2.0' }) }),
    )
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
    expect(d.stdout.output()).toContain(WARN)
    expect(d.exec.ghCalls()).toEqual([])
  })
})

describe('QA #25 hostile ask() returns', () => {
  // Only the two values `confirm` can actually resolve are pinned. Non-boolean
  // replies are deliberately NOT pinned: asserting that e.g. the string 'no' is
  // an ACCEPT would only restate JS truthiness, and it would pin as contract a
  // behaviour that becomes a BUG the day `ask` is swapped for a free-text prompt
  // (`promptValue` sits right next to `confirm` in lib/utils/prompt.js).
  it('treats a resolved `true` as ACCEPT', async () => {
    const d = deps({ ask: makeAsk(true) })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.runUpdate.calls).toHaveLength(1)
  })

  it('treats a resolved `false` as DECLINE and launches the loop', async () => {
    const d = deps({ ask: makeAsk(false) })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
    expect(d.runUpdate.calls).toHaveLength(0)
    expect(d.stdout.output()).not.toContain(UPDATED)
    expect(d.stdout.output()).not.toContain(WARN)
  })

  it('accepts a SYNCHRONOUS (non-promise) true — the await tolerates a plain value', async () => {
    const d = deps({ ask: makeAsk(() => true) })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.runUpdate.calls).toHaveLength(1)
  })

  it('declines on a SYNCHRONOUS (non-promise) false', async () => {
    const d = deps({ ask: makeAsk(() => false) })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
  })

  // PINNED, not endorsed: a throwing prompt aborts the whole run with the raw
  // error (NOT a StartAbort), so bin/ralph.js rethrows it and the user gets a
  // stack trace instead of a loop. The real `confirm` never rejects — a Ctrl-C at
  // the prompt kills the process and an EOF hangs (see the pty block below) — so
  // this is unreachable today. If it ever becomes reachable, the fix is to wrap
  // the ask in the same swallow-everything guard as runUpdateSafely and treat a
  // broken prompt as "decline and start the loop".
  it('lets a REJECTING ask abort the whole run (no loop, no StartAbort, raw error)', async () => {
    const boom = new Error('readline exploded')
    const d = deps({ ask: makeAsk(() => Promise.reject(boom)) })
    await expect(startCommand(d)).rejects.toBe(boom)
    expect(d.exec.calls.some((c) => c.startsWith('tmux new'))).toBe(false)
    expect(d.runUpdate.calls).toHaveLength(0)
    expect(d.stdout.output()).toContain(NOTICE)
  })

  it('lets a SYNCHRONOUSLY THROWING ask abort the whole run the same way', async () => {
    const throwing = () => {
      throw new TypeError('output.write is not a function')
    }
    await expect(startCommand(deps({ ask: makeAsk(throwing) }))).rejects.toBeInstanceOf(TypeError)
    // Not a StartAbort, so bin/ralph.js rethrows instead of exiting cleanly.
    await expect(startCommand(deps({ ask: makeAsk(throwing) }))).rejects.not.toBeInstanceOf(
      StartAbort,
    )
  })
})

describe('QA #25 hostile runUpdate() returns', () => {
  // One case per DISTINCT meaning, not one per falsy value: `{updated:0}`,
  // `{updated:''}`, `{exitCode:0}`, `{}` and non-object returns all take the
  // identical `result?.updated` branch, so they would only re-prove `?.` and
  // truthiness. The two `to`-bearing rows are the ones that matter — they are the
  // real updateCommand shapes where gating on `to` instead of `updated` would
  // announce an update that never happened.
  const notUpdated = [
    ['undefined', undefined],
    ['null', null],
    ['the advice path (updated:false with a `to`)', { exitCode: 0, updated: false, to: '0.2.0' }],
    ['the already-latest path (to === currentVersion)', { exitCode: 0, updated: false, to: '0.1.0' }],
  ]

  for (const [label, result] of notUpdated) {
    it(`warns once and launches the loop for ${label}`, async () => {
      const d = deps({ runUpdate: makeRunUpdate(result) })
      const out = await startCommand(d)
      expect(out).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.stdout.lines().filter((l) => l.includes(WARN))).toHaveLength(1)
      expect(d.stdout.output()).toContain('starting Ralph on 0.1.0')
      expect(d.stdout.output()).not.toContain(UPDATED)
      expect(d.stderr.output()).toBe('')
    })
  }

  // Same rule: `to:null` and `to:undefined` are the same nullish branch as an
  // absent `to`, and `{updated:1}` the same truthiness branch as `{updated:'yes'}`.
  const succeeded = [
    ['{updated:true, to:"0.2.0"}', { updated: true, to: '0.2.0' }, '0.2.0'],
    ['{updated:true} with NO `to` (?? falls back to latestVersion)', { updated: true }, '0.2.0'],
    ['{updated:"yes"} (truthy non-boolean)', { updated: 'yes', to: '0.2.0' }, '0.2.0'],
    ['a `to` AHEAD of the notice (registry moved on)', { updated: true, to: '0.3.0' }, '0.3.0'],
  ]

  for (const [label, result, version] of succeeded) {
    it(`reports success naming ${version} for ${label}`, async () => {
      const d = deps({ runUpdate: makeRunUpdate(result) })
      const out = await startCommand(d)
      expect(out).toEqual({ exitCode: 0, started: false })
      const lines = d.stdout.lines().filter((l) => l.includes(UPDATED))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(`${UPDATED} ${version}`)
      expect(lines[0]).toContain('run `ralph start` again')
      expect(d.stdout.output()).not.toContain(WARN)
    })
  }

  const rejections = [
    ['a non-Error string', 'npm exploded'],
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { code: 'EACCES' }],
  ]

  for (const [label, reason] of rejections) {
    it(`swallows a rejection with ${label} and launches on the current version`, async () => {
      const d = deps({ runUpdate: makeRunUpdate(() => Promise.reject(reason)) })
      const out = await startCommand(d)
      expect(out).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.stdout.output()).toContain(WARN)
      expect(d.stderr.output()).toBe('')
    })
  }

  it('swallows a SYNCHRONOUS throw from runUpdate', async () => {
    const d = deps({
      runUpdate: makeRunUpdate(() => {
        throw new Error('not a function')
      }),
    })
    const out = await startCommand(d)
    expect(out.started).toBe(true)
    expect(d.stdout.output()).toContain(WARN)
  })

  it('accepts a SYNCHRONOUS (non-promise) success object', async () => {
    const d = deps({ runUpdate: makeRunUpdate(() => ({ updated: true, to: '0.2.0' })) })
    const out = await startCommand(d)
    expect(out).toEqual({ exitCode: 0, started: false })
  })

  it('a failed update that consumed the version check does NOT re-check or re-ask', async () => {
    const d = deps({ runUpdate: makeRunUpdate({ updated: false }) })
    await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(1)
    expect(d.ask.calls).toHaveLength(1)
  })
})

describe('QA #25 output contract', () => {
  it('accept-success prints exactly one notice and one ✅ line, and nothing on stderr', async () => {
    const d = deps()
    await startCommand(d)
    const lines = d.stdout.lines()
    expect(lines.filter((l) => l.includes(NOTICE))).toHaveLength(1)
    const ok = lines.filter((l) => l.includes(UPDATED))
    expect(ok).toHaveLength(1)
    expect(ok[0].startsWith('✅ ')).toBe(true)
    expect(d.stderr.output()).toBe('')
    // start.js never echoes the question itself — that is confirm's job, on the
    // stream it was handed.
    expect(d.stdout.output()).not.toContain(PROMPT)
  })

  it('decline prints the notice and NOTHING else about updating, on either stream', async () => {
    const d = deps({ ask: makeAsk(false) })
    await startCommand(d)
    expect(d.stdout.lines().filter((l) => l.includes(NOTICE))).toHaveLength(1)
    expect(d.stdout.output()).not.toContain(UPDATED)
    expect(d.stdout.output()).not.toContain(WARN)
    expect(d.stdout.output()).not.toContain(PROMPT)
    expect(d.stderr.output()).toBe('')
  })

  it('the warn line uses the ⚠️ two-space prefix used elsewhere in start.js', async () => {
    const d = deps({ runUpdate: makeRunUpdate({ updated: false }) })
    await startCommand(d)
    const warn = d.stdout.lines().find((l) => l.includes(WARN))
    expect(warn).toBe('⚠️  Update did not complete — starting Ralph on 0.1.0.')
  })

  it('does not duplicate updateCommand’s own diagnostics — exactly one extra line', async () => {
    const d = deps({
      runUpdate: makeRunUpdate((args) => {
        args.stderr.write('❌ Update failed (npm exited 1).\n')
        args.stdout.write('   Update by hand: npm i -g @lucasfe/ralph\n')
        return { exitCode: 1, updated: false, from: '0.1.0', to: '0.2.0' }
      }),
    })
    await startCommand(d)
    // updateCommand's diagnostics survive verbatim, exactly once each...
    expect(d.stderr.lines().filter((l) => l.includes('Update failed (npm exited 1)'))).toHaveLength(1)
    expect(d.stdout.lines().filter((l) => l.includes('Update by hand'))).toHaveLength(1)
    // ...and start.js adds exactly one line of its own, without restating them.
    expect(d.stdout.lines().filter((l) => l.includes(WARN))).toHaveLength(1)
    expect(d.stdout.output()).not.toContain('npm exited 1')
  })

  it('the warn line names the CURRENT version, never the target', async () => {
    const d = deps({
      currentVersion: '0.1.5',
      runUpdate: makeRunUpdate({ exitCode: 1, updated: false, to: '0.2.0' }),
    })
    await startCommand(d)
    const warn = d.stdout.lines().find((l) => l.includes(WARN))
    expect(warn).toContain('0.1.5')
    expect(warn).not.toContain('0.2.0')
  })

  it('a successful accept never prints the tmux hint block (nothing was started)', async () => {
    const d = deps()
    await startCommand(d)
    const out = d.stdout.output()
    expect(out).not.toContain('Ralph started in background')
    expect(out).not.toContain('tmux attach -t')
    expect(out).not.toContain('Detach:')
  })
})

describe('QA #25 the global cache around the prompt', () => {
  // UPDATED for #26: the prompt now stamps last_prompted_at at the moment it is
  // shown, so an accepted run writes #24's two fields AND the prompt window.
  it('accepting writes #24’s fields plus #26’s prompt stamp, and nothing else', async () => {
    const cacheFs = new Volume()
    const d = deps({ cacheFs })
    await startCommand(d)
    const cache = readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} })
    expect(cache).toEqual({
      last_check_at: new Date(T0).toISOString(),
      last_prompted_at: new Date(T0).toISOString(),
      latest_version: '0.2.0',
    })
    expect(Object.keys(JSON.parse(cacheFs.readFileSync(CACHE_PATH, 'utf8').toString())).sort()).toEqual([
      'last_check_at',
      'last_prompted_at',
      'latest_version',
    ])
  })

  it('declining writes the same cache as accepting — the answer is not persisted', async () => {
    const accepted = new Volume()
    await startCommand(deps({ cacheFs: accepted }))
    const declined = new Volume()
    await startCommand(deps({ cacheFs: declined, ask: makeAsk(false) }))
    expect(declined.readFileSync(CACHE_PATH, 'utf8').toString()).toBe(
      accepted.readFileSync(CACHE_PATH, 'utf8').toString(),
    )
  })

  // UPDATED for #26: a throttled run makes no registry query, so last_check_at
  // and latest_version are left exactly as they were — but showing the prompt
  // still stamps last_prompted_at. That is the whole point of the second window.
  it('a throttled accept re-stamps ONLY last_prompted_at', async () => {
    const cacheFs = warmCache()
    const before = JSON.parse(cacheFs.readFileSync(CACHE_PATH, 'utf8').toString())
    const d = deps({ cacheFs })
    await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(d.runUpdate.calls).toHaveLength(1)
    expect(readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} })).toEqual({
      ...before,
      last_prompted_at: new Date(T0).toISOString(),
    })
  })

  it('a pre-existing last_prompted_at is preserved, never cleared, by a network refresh', async () => {
    // The stamp is 2 days old, so #26 throttles the question — but the run is
    // still due a registry query, and that refresh must carry the field through
    // rather than clearing it (which would re-open the window every week).
    const stamped = new Date(T0 - 2 * DAY).toISOString()
    const cacheFs = Volume.fromJSON(
      {
        [CACHE_PATH]: JSON.stringify({
          last_check_at: new Date(T0 - 30 * DAY).toISOString(),
          last_prompted_at: stamped,
          latest_version: '0.2.0',
        }),
      },
      '/',
    )
    const d = deps({ cacheFs })
    await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(1)
    expect(readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} }).last_prompted_at).toBe(
      stamped,
    )
  })

  it('the accept path writes ONLY the cache path and never reads the global .env', async () => {
    const ENV_CONTENT = 'CALLMEBOT_KEY=secret\nWHATSAPP_PHONE=+15550001111\n'
    const v = Volume.fromJSON({ [ENV_PATH]: ENV_CONTENT }, '/')
    v.chmodSync(ENV_PATH, 0o600)
    v.chmodSync(dirname(ENV_PATH), 0o700)
    const cacheFs = spyFs(v)
    const d = deps({ cacheFs })
    await startCommand(d)
    expect(cacheFs.ops.some((o) => o.path === ENV_PATH)).toBe(false)
    // UPDATED for #26: two writes now — #24's check stamp and #26's prompt stamp
    // — but the invariant is unchanged: every one of them lands on the cache path.
    const written = cacheFs.ops.filter((o) => o.op === 'write').map((o) => o.path)
    expect(written).toHaveLength(2)
    expect([...new Set(written)]).toEqual([CACHE_PATH])
    expect(v.readFileSync(ENV_PATH, 'utf8').toString()).toBe(ENV_CONTENT)
    expect(v.statSync(ENV_PATH).mode & 0o777).toBe(0o600)
  })

  it('an unwritable cache still prompts and still accepts', async () => {
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
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.ask.calls).toHaveLength(1)
    expect(d.stderr.output()).toBe('')
  })

  it('a corrupt cache still prompts and still accepts', async () => {
    const cacheFs = Volume.fromJSON({ [CACHE_PATH]: '{ not json' }, '/')
    const d = deps({ cacheFs })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.ask.calls).toHaveLength(1)
  })
})

describe('QA #25 abort guards win before any prompt', () => {
  it('an existing tmux session aborts without asking', async () => {
    const d = deps({}, { tmuxHasSession: 0 })
    await expect(startCommand(d)).rejects.toBeInstanceOf(StartAbort)
    expect(d.ask.calls).toHaveLength(0)
    expect(d.runUpdate.calls).toHaveLength(0)
    expect(d.exec.npmViews()).toHaveLength(0)
  })

  it('an alive cycle lock aborts without asking', async () => {
    const d = deps({
      peekLock: () => ({ holder: { pid: 7, startedAt: '2026-08-22T10:00:00.000Z' }, alive: true }),
    })
    await expect(startCommand(d)).rejects.toBeInstanceOf(StartAbort)
    expect(d.ask.calls).toHaveLength(0)
    expect(d.runUpdate.calls).toHaveLength(0)
  })

  for (const missing of ['git', 'gh', 'tmux', 'npm']) {
    it(`a missing critical dep (${missing}) aborts without asking`, async () => {
      const d = deps({ hasCommand: (c) => c !== missing })
      await expect(startCommand(d)).rejects.toBeInstanceOf(StartAbort)
      expect(d.ask.calls).toHaveLength(0)
      expect(d.runUpdate.calls).toHaveLength(0)
    })
  }

  it('positive control: a DEAD cycle lock still reaches the prompt', async () => {
    const d = deps({ peekLock: () => ({ holder: { pid: 7 }, alive: false }) })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.ask.calls).toHaveLength(1)
  })

  it('a gh-auth abort happens AFTER the prompt, so declining still surfaces it', async () => {
    const d = deps({ ask: makeAsk(false) }, { ghAuth: 1 })
    await expect(startCommand(d)).rejects.toBeInstanceOf(StartAbort)
    expect(d.ask.calls).toHaveLength(1)
    expect(d.stderr.output()).toContain('gh not authenticated')
  })

  it('accepting SHIELDS the run from a broken gh auth — the abort is never reached', async () => {
    const d = deps({}, { ghAuth: 1 })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.stderr.output()).toBe('')
  })

  it('a failed tmux launch after a DECLINED prompt still aborts', async () => {
    const d = deps({ ask: makeAsk(false) }, { launch: 1 })
    await expect(startCommand(d)).rejects.toBeInstanceOf(StartAbort)
    expect(d.stderr.output()).toContain('Failed to start tmux session')
  })
})

describe('QA #25 the gate is shouldPrompt && isTTY — not the queue', () => {
  const decision = (extra) => ({
    latestVersion: null,
    isNewer: false,
    shouldPrompt: false,
    source: 'network',
    updatedCache: null,
    ...extra,
  })

  // UPDATED for #26: the gate moved from `isNewer && isTTY` to
  // `shouldPrompt && isTTY`. isNewer alone now prints the notice and nothing else
  // — that is exactly what a run inside the 7-day prompt window looks like.
  it('does NOT prompt when isNewer is true but shouldPrompt is false, yet still prints the notice', async () => {
    const d = deps({
      update: async () => decision({ latestVersion: '0.2.0', isNewer: true, shouldPrompt: false }),
    })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
    expect(d.ask.calls).toHaveLength(0)
    expect(d.runUpdate.calls).toHaveLength(0)
    expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })

  it('prompts when both isNewer and shouldPrompt are true', async () => {
    const d = deps({
      update: async () => decision({ latestVersion: '0.2.0', isNewer: true, shouldPrompt: true }),
    })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.ask.calls).toHaveLength(1)
  })

  it('does NOT prompt when shouldPrompt is true but isNewer is false', async () => {
    const d = deps({
      update: async () => decision({ latestVersion: '9.9.9', isNewer: false, shouldPrompt: true }),
    })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
    expect(d.ask.calls).toHaveLength(0)
    expect(d.stdout.output()).not.toContain(NOTICE)
  })

  for (const [label, value] of [
    ['undefined', undefined],
    ['null', null],
    ['a bare object', {}],
  ]) {
    it(`does not prompt or crash when the decision is ${label}`, async () => {
      const d = deps({ update: async () => value })
      const result = await startCommand(d)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.ask.calls).toHaveLength(0)
    })
  }

  it('prompts identically whether the queue is empty or full (the queue is read later)', async () => {
    for (const queue of ['0', '1', '']) {
      const d = deps({}, { queue })
      const result = await startCommand(d)
      expect(result).toEqual({ exitCode: 0, started: false })
      expect(d.ask.calls).toHaveLength(1)
    }
  })

  it('RALPH_NO_UPDATE_CHECK=1 suppresses the prompt on a TTY, with no npm view and no cache write', async () => {
    const cacheFs = spyFs(new Volume())
    const d = deps({ cacheFs, processEnv: { RALPH_NO_UPDATE_CHECK: '1' } })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
    expect(d.ask.calls).toHaveLength(0)
    expect(d.runUpdate.calls).toHaveLength(0)
    expect(cacheFs.ops).toHaveLength(0)
  })

  it('RALPH_NO_UPDATE_CHECK=0 leaves the prompt ON', async () => {
    const d = deps({ processEnv: { RALPH_NO_UPDATE_CHECK: '0' } })
    await startCommand(d)
    expect(d.ask.calls).toHaveLength(1)
  })

  it('a non-semver currentVersion (npx/dev checkout) never prompts', async () => {
    const d = deps({ currentVersion: 'unknown' })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(d.ask.calls).toHaveLength(0)
  })
})

describe('QA #25 throttled, cache-served runs still prompt', () => {
  it('a run inside the weekly window prompts from the CACHED version with no npm view', async () => {
    const d = deps({ cacheFs: warmCache('0.2.0', 3 * DAY) })
    const result = await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    expect(d.ask.calls).toHaveLength(1)
    expect(result).toEqual({ exitCode: 0, started: false })
  })

  // UPDATED for #26: both windows are global, so the second repo's run is
  // throttled on the network AND on the question. It still gets the notice.
  it('two runs sharing one home: the second neither queries nor asks', async () => {
    const cacheFs = new Volume()
    const first = deps({ cacheFs, ask: makeAsk(false) })
    await startCommand(first)
    const second = deps({ cacheFs, cwd: '/repo-b', now: () => T0 + 2 * DAY, ask: makeAsk(false) })
    await startCommand(second)
    expect(first.exec.npmViews()).toHaveLength(1)
    expect(second.exec.npmViews()).toHaveLength(0)
    expect(first.ask.calls).toHaveLength(1)
    expect(second.ask.calls).toHaveLength(0)
    expect(second.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    expect(second.exec.calls[0]).toContain(sessionNameFor('/repo-b'))
  })

  // UPDATED for #26 (this was the pinned tripwire): declining is now remembered
  // by last_prompted_at until the window rolls over, so the next runs get the
  // notice without the question. Re-offering is covered in test/commands/start.test.js.
  it('declining stops the next runs inside the window from asking again', async () => {
    const cacheFs = new Volume()
    const runs = []
    for (const now of [T0, T0 + 60_000, T0 + DAY]) {
      const d = deps({ cacheFs, now: () => now, ask: makeAsk(false) })
      await startCommand(d)
      runs.push(d.ask.calls.length)
    }
    expect(runs).toEqual([1, 0, 0])
  })

  it('a stale cached version survives a failed refresh and is still offered', async () => {
    const cacheFs = warmCache('0.2.0', 30 * DAY)
    const d = deps({ cacheFs }, { npm: { exitCode: 1, stdout: '', stderr: 'offline' } })
    const result = await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(1)
    expect(d.ask.calls).toHaveLength(1)
    expect(result).toEqual({ exitCode: 0, started: false })
  })
})

describe('QA #25 the isTTY default follows the RESOLVED stdin', () => {
  // Every test here exercises the default, and each one stubs process.stdin so
  // the outcome never depends on how `npm test` was invoked. The first two pass
  // `stdin: undefined` so the `stdin = process.stdin` fallback is what the gate
  // resolves against; the next three cover an explicitly injected non-stream
  // (`stdin: null`) and both stream polarities, which is what the gate must
  // follow instead of the ambient terminal.
  it('does not prompt when stdin falls back to a non-TTY ambient process.stdin', async () => {
    await withProcessStdin({ isTTY: false }, async () => {
      const d = deps({ stdin: undefined })
      delete d.isTTY
      const result = await startCommand(d)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.ask.calls).toHaveLength(0)
    })
  })

  it('does not prompt when process.stdin is missing entirely', async () => {
    await withProcessStdin(undefined, async () => {
      const d = deps({ stdin: undefined })
      delete d.isTTY
      const result = await startCommand(d)
      expect(result.started).toBe(true)
      expect(d.ask.calls).toHaveLength(0)
    })
  })

  // REGRESSION GUARD (this was a pinned defect: the default used to consult the
  // AMBIENT process.stdin while the readline it gates is attached to the
  // INJECTED `stdin`). A caller that passes a non-interactive `stdin` and lets
  // isTTY default must never be prompted: per the pty block below, the real
  // confirm NEVER resolves on such a stream, so that run would hang forever —
  // the exact failure the TTY gate exists to prevent.
  it('does not prompt an injected NON-TTY stdin even when the ambient terminal IS a TTY', async () => {
    await withProcessStdin({ isTTY: true }, async () => {
      const d = deps({
        stdin: { isTTY: false, marker: 'piped-stream' },
        ask: makeAsk(() => {
          throw new Error('confirm must never be called on a non-interactive stdin')
        }),
      })
      delete d.isTTY
      const result = await startCommand(d)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.ask.calls).toHaveLength(0)
      // #24's passive notice is still printed — only the question is withheld.
      expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    })
  })

  // The `stdin` parameter's OWN default (`stdin = process.stdin`) already covers
  // both "not injected" and "injected as undefined", so an explicit `stdin: null`
  // is the only value that reaches the gate as a non-stream. It must read as
  // NOT a TTY: reading the ambient terminal instead would gate a readline that is
  // then attached to `input: null`, and `createInterface({ input: null })` throws
  // a raw TypeError straight out of startCommand — not a StartAbort, so
  // bin/ralph.js rethrows and the user gets a stack trace instead of a loop.
  // `ask` here is the REAL confirm precisely so that throw is reachable.
  it('does not prompt an explicit stdin:null under a TTY terminal, and builds no readline', async () => {
    await withProcessStdin({ isTTY: true }, async () => {
      const d = deps({ stdin: null, ask: confirm })
      delete d.isTTY
      const result = await startCommand(d)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.askIdx()).toBe(-1)
      // #24's notice still prints; only the question is withheld. No readline was
      // constructed, so the prompt was never echoed either.
      expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
      expect(d.stdout.output()).not.toContain(PROMPT)
    })
  })

  // The other direction, which is what proves the default TRACKS the injected
  // stream rather than merely ignoring one particular terminal.
  it('prompts an injected TTY stdin even when the ambient terminal is NOT a TTY', async () => {
    await withProcessStdin({ isTTY: false }, async () => {
      const d = deps({ stdin: { isTTY: true, marker: 'tty-ish' } })
      delete d.isTTY
      const result = await startCommand(d)
      expect(result).toEqual({ exitCode: 0, started: false })
      expect(d.ask.calls).toHaveLength(1)
      // The readline is attached to the very stream the gate read.
      expect(d.ask.calls[0].options.input).toBe(d.stdin)
      expect(d.ask.calls[0].options.input.isTTY).toBe(true)
    })
  })

  it('an explicit isTTY:false beats a TTY-looking injected stdin AND a TTY terminal', async () => {
    await withProcessStdin({ isTTY: true }, async () => {
      const d = deps({
        isTTY: false,
        stdin: { isTTY: true, marker: 'tty-ish' },
        ask: makeAsk(() => {
          throw new Error('confirm must never be called without a TTY')
        }),
      })
      const result = await startCommand(d)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    })
  })

  it('a TTY terminal with no injected stdin and no isTTY DOES reach ask — hence the injection rule', async () => {
    // Shows why injection is mandatory rather than stylistic: with a stubbed TTY
    // terminal, no injected stdin and no isTTY, the gate opens and `ask` is
    // reached. A suite that left `ask` defaulted here would block on a real
    // readline over the developer's terminal. Proven with a recording stand-in.
    //
    // NOTE — this test inspects only its own run; it makes no claim about other
    // files. Hermeticity of a start suite needs `ask`-or-`isTTY` injected AND
    // `runUpdate` injected. lib/commands/start.test.js and
    // lib/commands/start.qa.test.js inject `ask: async () => true` but leave
    // `runUpdate` defaulted to the REAL updateCommand. They are safe only
    // because their `currentVersion` defaults to 'unknown', so `isNewer` is
    // false and the accept branch is unreachable. A future test in either file
    // that sets a semver `currentVersion` alongside a newer `npm view` stub
    // would run the real `updateCommand`, whose `classifyInstall` reads the real
    // fs and RALPH_HOME. Inject `runUpdate` there before doing that.
    await withProcessStdin({ isTTY: true }, async () => {
      const d = deps({ stdin: undefined })
      delete d.isTTY
      await startCommand(d)
      expect(d.ask.calls).toHaveLength(1)
    })
  })
})

describe('QA #25 the real confirm() wired through startCommand (in-process pty stand-ins)', () => {
  function collectingWritable() {
    const chunks = []
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk))
        cb()
      },
    })
    stream.output = () => strip(chunks.join(''))
    return stream
  }

  const answers = [
    ['y', true],
    ['Y', true],
    [' y ', true],
    ['', false],
    ['n', false],
    ['N', false],
    ['yes', false],
    ['no', false],
    ['   ', false],
  ]

  for (const [answer, expected] of answers) {
    it(`confirm("${PROMPT}") with ${JSON.stringify(answer + '\n')} → ${expected}`, async () => {
      const output = collectingWritable()
      const result = await confirm(PROMPT, { input: Readable.from([`${answer}\n`]), output })
      expect(result).toBe(expected)
      expect(output.output()).toContain(PROMPT)
    })
  }

  it('the empty answer is NO end-to-end: start launches the loop on the current version', async () => {
    const stdout = collectingWritable()
    const d = deps({ ask: confirm, stdin: Readable.from(['\n']), stdout })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
    const out = stdout.output()
    expect(out).toContain(`${NOTICE}: 0.2.0`)
    expect(out).toContain(PROMPT)
    expect(out).not.toContain(UPDATED)
    expect(out).not.toContain(WARN)
  })

  it('a typed "y" is YES end-to-end: start updates and returns without launching', async () => {
    const stdout = collectingWritable()
    const d = deps({ ask: confirm, stdin: Readable.from(['y\n']), stdout })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(stdout.output()).toContain(`${UPDATED} 0.2.0`)
    expect(d.exec.calls).toEqual([TMUX_GUARD, NPM_VIEW])
  })

  it('a typed "n" is NO end-to-end, and the loop launches', async () => {
    const stdout = collectingWritable()
    const d = deps({ ask: confirm, stdin: Readable.from(['n\n']), stdout })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
    expect(d.runUpdate.calls).toHaveLength(0)
  })

  // Why the TTY gate has to be right: on a stream that ends without a line,
  // confirm NEVER resolves (readline closes and the question callback is never
  // invoked). A non-interactive run that reached this prompt would hang forever,
  // which is precisely what isTTY exists to prevent.
  it('confirm never resolves on an input that ends without a line (the hang the gate prevents)', async () => {
    const output = collectingWritable()
    const settled = confirm(PROMPT, { input: Readable.from([]), output }).then(() => 'settled')
    const race = await Promise.race([
      settled,
      new Promise((resolve) => setTimeout(() => resolve('pending'), 150)),
    ])
    expect(race).toBe('pending')
    // `settled` is deliberately abandoned still pending — that IS the assertion.
    // It holds nothing open: the input has already ended and readline has closed,
    // so there is no live handle to keep the runner alive.
  })

  it('startCommand hangs on an ended stdin if the gate is bypassed (isTTY forced true)', async () => {
    const stdout = collectingWritable()
    const input = new PassThrough()
    input.end()
    const d = deps({ ask: confirm, stdin: input, stdout, isTTY: true })
    const race = await Promise.race([
      startCommand(d).then(() => 'returned'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 150)),
    ])
    expect(race).toBe('hung')
    expect(stdout.output()).toContain(PROMPT)
    // Same deal: the startCommand promise stays pending forever by design. Drop
    // the stream so the readline inside `confirm` cannot outlive the test.
    input.destroy()
  })
})
