import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { readFileSync } from 'node:fs'
import { cycleCommand } from './cycle.js'
import { startCommand } from './start.js'
import { readVersionCache, versionCachePath } from '../version-cache.js'

// #51 — `ralph cycle` prints #24's update notice, exactly as `ralph start` does.
//
// Its own file rather than more of cycle.test.js (1000+ lines of drain/lock/
// preflight behaviour) for the same reason start's update slices got theirs: the
// notice is one policy with one placement, and everything that can be said about
// it — where it runs, what it costs, what it must NOT touch — reads as one block.
//
// `ralph cycle` is the command the launchd schedule drives every 4 hours, so it is
// the one path that can run unattended for weeks while staying stale. Under launchd
// there is no human at the other end, which is why this slice stays NOTICE-ONLY:
// every run below is handed a NON-INTERACTIVE `stdin`, so the `isTTY` #52 derives
// from it is false, #25's question is off, and nothing here can construct a
// readline or block a drain. #52 did give `ralph cycle` that question — on a TTY,
// in ./cycle.update-prompt.test.js. What this file pins is the other half of the
// same gate: the unattended run, which must still get the advice and nothing else.
//
// What is asserted, and in what spirit:
//   - the notice itself, byte-identical to the line `ralph start` prints (run side
//     by side, not compared against a hand-copied constant);
//   - the PLACEMENT, as an ordering over one timeline — inside the lock, after
//     preflight, before the orphan sweep and the queue count (hence before the
//     queue-empty early return #24 already moved start's notice out from behind);
//   - what a skipped, aborted or opted-out run must NOT spend: no registry query;
//   - strict `start` parity on channels — stdout only, nothing over WhatsApp, and
//     not one new field in the RALPH_CYCLE_EVENT payload;
//   - that advice never costs a drain: an unreachable registry, a corrupt cache
//     and an unwritable ~/.config all leave the cycle draining.
//
// Every seam is injected, `cacheFs` is memfs, and no test touches the real
// ~/.config/ralph.

const REPO = '/repo'
const REPO_SLUG = 'lucasfe/ralph'
const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })

const NPM_VIEW = 'npm view @lucasfe/ralph version'
const NOTICE = 'New version available: 0.2.0'
const NOTICE_LINE = 'New version available: 0.2.0 (run npm i -g @lucasfe/ralph to update)'
// #25's question. #52 lets `ralph cycle` ask it, but only on a TTY — so no run in
// this file, all of which are non-interactive, may ever print it.
const QUESTION = 'Update now?'
const EVENT_TAG = 'RALPH_CYCLE_EVENT '

const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// picocolors wraps the notice in ANSI when the runner reports colour support, so
// output is compared with the codes stripped — the same helper the other update
// suites use.
const strip = (s) => String(s).replace(/\[[0-9;]*m/g, '')

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
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

// One exec for the whole cycle, matched on cmd/args rather than on exact key
// strings so a search-query tweak in cycle.js cannot silently defuse these tests.
// Every call is also appended to a shared timeline, which is what makes the
// placement assertions an ORDER rather than a presence check.
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

// A full github-source cycle that acquires the lock and drains, with 0.2.0
// published and 0.1.0 installed. The lock, orphan sweep and drain all record
// themselves on the same timeline as the exec calls.
function deps(overrides = {}, execOptions = {}) {
  const timeline = []
  const stdout = makeStream()
  const stderr = makeStream()
  const sendWa = makeWa()
  const d = {
    cwd: REPO,
    stdout,
    stderr,
    // #52 made `isTTY` derive from the resolved `stdin`, so this slice pins a
    // non-interactive stream on every run: it is the launchd shape, and it is what
    // keeps the assertions below about the NOTICE rather than about whatever stdin
    // the test runner happens to hand this process.
    stdin: { isTTY: false },
    exec: makeExec(execOptions, timeline),
    exists: () => true,
    readFile: () => '',
    loadEnv: () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' }),
    acquireLock: () => {
      timeline.push('acquireLock')
      return { acquired: true, holder: { pid: 1, startedAt: new Date(T0).toISOString(), repoPath: REPO } }
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
  d.timeline = timeline
  d.at = (event) => timeline.indexOf(event)
  d.notices = () => stdout.lines().filter((l) => l.includes('New version available'))
  return d
}

// The same run for `ralph start`, used only by the byte-parity test below. Unknown
// exec keys resolve to exit 0, so the tmux launch needs no handler of its own.
function startDeps(overrides = {}) {
  return {
    cwd: REPO,
    stdout: makeStream(),
    stderr: makeStream(),
    stdin: { isTTY: false },
    isTTY: false,
    exec: makeExec(),
    exists: () => false,
    loadEnv: () => ({}),
    readFile: () => '',
    hasCommand: () => true,
    ask: async () => false,
    peekLock: () => null,
    sendWa: async () => ({ ok: true }),
    now: () => T0,
    currentVersion: '0.1.0',
    home: HOME,
    processEnv: {},
    cacheFs: new Volume(),
    ...overrides,
  }
}

function cycleEvent(stdout) {
  const line = stdout.lines().find((l) => l.startsWith(EVENT_TAG))
  return line ? JSON.parse(line.slice(EVENT_TAG.length)) : null
}

const cacheOf = (cacheFs) => readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} })

// Swaps the AMBIENT process.stdin — the stream cycleCommand's own `stdin` default
// resolves to when a caller injects none. Used to prove that an INJECTED
// non-interactive stream still wins over an ambient terminal.
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

describe('cycleCommand — the update notice (#51)', () => {
  it('prints the notice on stdout and still drains the queue', async () => {
    const d = deps()
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.timeline).toContain('runQueueOnce')
    expect(d.stdout.output()).toContain(NOTICE_LINE)
    expect(d.stderr.output()).toBe('')
  })

  it('prints the notice exactly once, naming the version and the manual upgrade command', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.notices()).toHaveLength(1)
    expect(d.notices()[0]).toBe(NOTICE_LINE)
  })

  it('prints the byte-identical line `ralph start` prints', async () => {
    // Run side by side rather than compared to a constant: the point of #50's
    // shared gate is that the two commands cannot drift, and a hand-copied
    // expectation would not notice if one of them stopped using it.
    const c = deps()
    await cycleCommand(c)
    const s = startDeps()
    await startCommand(s)
    const startNotices = s.stdout.lines().filter((l) => l.includes('New version available'))
    expect(startNotices).toHaveLength(1)
    expect(c.notices()).toEqual(startNotices)
  })

  it('prints nothing when the published version is not newer', async () => {
    const d = deps({ currentVersion: '0.2.0' })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.stdout.output()).not.toContain('New version available')
  })

  it('hands the decision the same version, exec, clock, env bag, home and cache fs', async () => {
    const seen = []
    const d = deps({
      processEnv: { FOO: 'bar' },
      update: async (args) => {
        seen.push(args)
        return { latestVersion: null, isNewer: false, shouldPrompt: false }
      },
    })
    await cycleCommand(d)
    expect(seen).toHaveLength(1)
    expect(seen[0].currentVersion).toBe('0.1.0')
    expect(seen[0].exec).toBe(d.exec)
    expect(seen[0].now).toBe(d.now)
    expect(seen[0].processEnv).toBe(d.processEnv)
    expect(seen[0].home).toBe(HOME)
    expect(seen[0].fs).toBe(d.cacheFs)
  })
})

describe('cycleCommand — where the gate runs (#51)', () => {
  it('runs after acquireLock succeeds and before the orphan sweep and the queue count', async () => {
    const d = deps()
    await cycleCommand(d)
    const gateIdx = d.at(`exec:${NPM_VIEW}`)
    const queueIdx = d.timeline.findIndex((e) => e.startsWith('exec:gh issue list --search'))
    expect(d.at('acquireLock')).toBeGreaterThanOrEqual(0)
    expect(gateIdx).toBeGreaterThan(d.at('acquireLock'))
    expect(gateIdx).toBeLessThan(d.at('findOrphans'))
    expect(queueIdx).toBeGreaterThan(gateIdx)
  })

  it('runs after the preflight it must not talk over', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.at('exec:gh auth status')).toBeGreaterThanOrEqual(0)
    expect(d.at('exec:gh auth status')).toBeLessThan(d.at(`exec:${NPM_VIEW}`))
  })

  it('prints the notice before the queue-empty early return', async () => {
    const d = deps({}, { queue: '0' })
    const result = await cycleCommand(d)
    expect(result.status).toBe('queue-empty')
    const lines = d.stdout.lines()
    const noticeIdx = lines.findIndex((l) => l.includes(NOTICE))
    const emptyIdx = lines.findIndex((l) => l.includes('queue empty, exiting'))
    expect(noticeIdx).toBeGreaterThanOrEqual(0)
    expect(emptyIdx).toBeGreaterThan(noticeIdx)
  })

  it('releases the lock when the gate itself throws', async () => {
    // The notice write — including the interpolation of `latestVersion` — is the
    // one thing the gate deliberately leaves unguarded, so a hostile version
    // object is how a throw from inside the gate is reachable at all. Being inside
    // the lock's try/finally is what keeps that from leaking the lock file.
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
    expect(d.at('acquireLock')).toBeLessThan(d.at('releaseLock'))
    expect(d.timeline).not.toContain('runQueueOnce')
  })
})

describe('cycleCommand — a skipped or aborted cycle spends nothing (#51)', () => {
  it('makes no registry query and prints no notice when this project’s tmux session is live', async () => {
    const d = deps({}, { tmuxHasSession: 0 })
    const result = await cycleCommand(d)
    expect(result.status).toBe('tmux-active')
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(d.stdout.output()).not.toContain('New version available')
  })

  it('makes no registry query and prints no notice when another instance holds the lock', async () => {
    const d = deps({
      acquireLock: () => ({
        acquired: false,
        holder: { pid: 4242, startedAt: new Date(T0 - 25 * 60_000).toISOString(), repoPath: REPO },
      }),
    })
    const result = await cycleCommand(d)
    expect(result.status).toBe('lock-held')
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(d.stdout.output()).not.toContain('New version available')
  })

  it('prints no notice when the cycle aborts at preflight', async () => {
    const d = deps({}, { ghAuth: 1 })
    const result = await cycleCommand(d)
    expect(result.status).toBe('preflight-failed')
    expect(d.stderr.output()).toContain('preflight failed')
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(d.stdout.output()).not.toContain('New version available')
  })
})

describe('cycleCommand — an unattended notice never becomes a question (#51/#52)', () => {
  it('never prompts and never constructs a readline, even under an ambient interactive terminal', async () => {
    // The gate's `ask` default is the REAL confirm, and #52 derives `isTTY` from the
    // RESOLVED `stdin` — so the non-interactive stream deps() injects is what decides
    // here, and it has to win over the ambient terminal. That precedence is the
    // launchd guarantee: if the derivation ever reached past the parameter to
    // `process.stdin`, createInterface would be handed this fake and throw right
    // here, which is the point — a scheduled drain must fail loudly in a test rather
    // than hang forever in production with the cycle lock held.
    await withProcessStdin({ isTTY: true }, async () => {
      const d = deps()
      const result = await cycleCommand(d)
      expect(result.status).toBe('success')
      expect(d.stdout.output()).toContain(NOTICE)
      expect(d.stdout.output()).not.toContain(QUESTION)
      expect(d.timeline).toContain('runQueueOnce')
    })
  })

  it('installs nothing: the only npm call is the version query', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.exec.calls.filter((c) => c.startsWith('npm '))).toEqual([NPM_VIEW])
  })

  it('leaves the shared prompt window untouched, so the next interactive run still asks', async () => {
    const cacheFs = new Volume()
    await cycleCommand(deps({ cacheFs }))
    expect(cacheOf(cacheFs)).toEqual({
      last_check_at: new Date(T0).toISOString(),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
  })
})

describe('cycleCommand — strict `start` parity on channels (#51)', () => {
  it('adds no field to the RALPH_CYCLE_EVENT payload', async () => {
    const withNotice = deps()
    await cycleCommand(withNotice)
    const without = deps({ currentVersion: '0.2.0' })
    await cycleCommand(without)
    const noticed = cycleEvent(withNotice.stdout)
    const quiet = cycleEvent(without.stdout)
    expect(withNotice.stdout.output()).toContain(NOTICE)
    expect(without.stdout.output()).not.toContain('New version available')
    expect(Object.keys(noticed).sort()).toEqual([
      'durationMin',
      'failed',
      'ok',
      'processed',
      'run_id',
      'status',
      'ts',
    ])
    expect(Object.keys(noticed).sort()).toEqual(Object.keys(quiet).sort())
    expect(JSON.stringify(noticed)).not.toContain('0.2.0')
  })

  it('sends nothing about the update over WhatsApp', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.stdout.output()).toContain(NOTICE)
    // The cycle's own notifications still went out — this is silence about the
    // update, not silence about the run.
    expect(d.sendWa.messages.length).toBeGreaterThan(0)
    expect(d.sendWa.messages.some((m) => /New version available|npm i -g/.test(m))).toBe(false)
  })

  it('writes the notice to stdout, where launchd captures it, and nothing to stderr', async () => {
    const d = deps()
    await cycleCommand(d)
    expect(d.stdout.output()).toContain(NOTICE_LINE)
    expect(d.stderr.output()).toBe('')
  })
})

describe('cycleCommand — advice never costs a drain (#51)', () => {
  it('drains normally and says nothing when the registry is unreachable', async () => {
    const d = deps({}, { npm: { exitCode: 1, stdout: '', stderr: 'offline' } })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.timeline).toContain('runQueueOnce')
    expect(d.stdout.output()).not.toContain('New version available')
    expect(d.stderr.output()).toBe('')
  })

  it('still notices the new version with a corrupt cache file', async () => {
    const d = deps({ cacheFs: Volume.fromJSON({ [CACHE_PATH]: '{ not json at all' }, '/') })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.stdout.output()).toContain(NOTICE)
  })

  it('drains normally when ~/.config cannot be written', async () => {
    const d = deps({
      cacheFs: {
        readFileSync: () => {
          const e = new Error('ENOENT: no such file or directory')
          e.code = 'ENOENT'
          throw e
        },
        mkdirSync: () => {
          const e = new Error('EACCES: permission denied')
          e.code = 'EACCES'
          throw e
        },
        writeFileSync: () => {
          const e = new Error('EACCES: permission denied')
          e.code = 'EACCES'
          throw e
        },
      },
    })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.timeline).toContain('runQueueOnce')
    // The check itself still worked — only the stamp was lost.
    expect(d.stdout.output()).toContain(NOTICE)
    expect(d.stderr.output()).toBe('')
  })

  it('makes no query, prints nothing and drains with RALPH_NO_UPDATE_CHECK set', async () => {
    const cacheFs = new Volume()
    const d = deps({ cacheFs, processEnv: { RALPH_NO_UPDATE_CHECK: '1' } })
    const result = await cycleCommand(d)
    expect(result.status).toBe('success')
    expect(d.timeline).toContain('runQueueOnce')
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(d.stdout.output()).not.toContain('New version available')
    expect(cacheFs.existsSync(CACHE_PATH)).toBe(false)
  })
})

describe('cycleCommand — the weekly throttle is shared with `start` and `doctor` (#51)', () => {
  it('makes one registry query a week however many cycles the schedule runs', async () => {
    // A 4h launchd interval: six cycles a day, every day, all inside one weekly
    // window (the last is at +164h, still under 168h). One query, and the notice
    // on every single run — the throttle covers the network, never the advice.
    const cacheFs = new Volume()
    let queries = 0
    let notices = 0
    let runs = 0
    for (let day = 0; day < 7; day++) {
      for (const hour of [0, 4, 8, 12, 16, 20]) {
        const d = deps({ cacheFs, now: () => T0 + day * DAY + hour * HOUR })
        const result = await cycleCommand(d)
        expect(result.status).toBe('success')
        queries += d.exec.npmViews().length
        notices += d.notices().length
        runs += 1
      }
    }
    expect(runs).toBe(42)
    expect(queries).toBe(1)
    expect(notices).toBe(42)
  })

  it('queries again once the weekly window has elapsed', async () => {
    const cacheFs = new Volume()
    const first = deps({ cacheFs })
    await cycleCommand(first)
    const later = T0 + 8 * DAY
    const second = deps({ cacheFs, now: () => later })
    await cycleCommand(second)
    expect(first.exec.npmViews()).toHaveLength(1)
    expect(second.exec.npmViews()).toHaveLength(1)
    expect(cacheOf(cacheFs).last_check_at).toBe(new Date(later).toISOString())
  })
})

// bin/ralph.js parses argv on import and bin/ is outside vitest's include globs,
// so the wiring is asserted from the SOURCE — the same approach the template and
// summary-parity suites take for files they cannot call.
describe('bin/ralph.js hands `cycle` the installed version (#51)', () => {
  const bin = readFileSync(new URL('../../bin/ralph.js', import.meta.url), 'utf8')

  it('passes currentVersion: pkg.version to cycleCommand', () => {
    expect(bin).toMatch(/cycleCommand\(\{[\s\S]{0,200}?currentVersion:\s*pkg\.version/)
  })

  it('uses the same package.json version start, update and doctor already get', () => {
    // One source of truth for "what is installed" — cycle reads it from the same
    // `pkg`, not from a second parse or a hard-coded string.
    expect(bin).toMatch(/const pkg = JSON\.parse\(\s*readFileSync\(/)
    for (const call of ['startCommand', 'cycleCommand', 'updateCommand', 'doctorCommand']) {
      expect(bin).toMatch(new RegExp(`${call}\\(\\{[\\s\\S]{0,200}?currentVersion:\\s*pkg\\.version`))
    }
  })
})
