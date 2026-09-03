import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { dirname, join, resolve } from 'node:path'
import { startCommand, StartAbort } from './start.js'
import { sessionNameFor } from '../lock.js'
import { globalConfigPath } from '../utils/global-config.js'
import { readVersionCache, versionCachePath } from '../version-cache.js'
import { writeGlobalCreds } from '../utils/global-config-writer.js'
import { npmGlobalLayout } from '../../test/helpers/install-layout.js'

// #24 QA augmentation — the `ralph start` step-2.5 read site. The dev's
// test/commands/start.test.js proves the placement and the main acceptance
// criteria with a single repo. This file attacks the integration:
//   - the ORDER of the check against every observable side effect (dep probes,
//     tmux guard, first gh spawn, the .env.local read), from one timeline;
//   - the notice on the paths that have no gh at all (folder source) and on the
//     paths that abort AFTER 2.5 (gh auth failure);
//   - an unwritable / unreadable / occupied global cache: `ralph start` must
//     still launch AND still print a pending notice;
//   - the cache being GLOBAL: two different repos share one weekly window;
//   - the ralph/.env non-interference invariant proven by recording fs ops;
//   - proof that step 2.5 no longer reads .ralph/state.json (readSt/writeSt gone).

const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const ENV_PATH = globalConfigPath({ processEnv: {}, home: HOME })
const NPM_VIEW = 'npm view @lucasfe/ralph version'
const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const NOTICE = 'New version available'

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').filter(Boolean),
  }
}

// One exec for the whole preflight, matched on cmd/args rather than on exact key
// strings so a search-query tweak in start.js cannot silently defuse the tests.
function makeExec({ npm, queue = '1', orphan = '', tmuxHasSession = 1, ghAuth = 0 } = {}, timeline = []) {
  const calls = []
  const exec = async (cmd, args = [], opts = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    timeline.push(`exec:${key}`)
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: tmuxHasSession, stdout: '', stderr: '' }
    }
    if (cmd === 'npm' && args[0] === 'view') {
      return npm ?? { exitCode: 0, stdout: '0.2.0\n', stderr: '', timedOut: false }
    }
    if (cmd === 'gh' && args[0] === 'auth') return { exitCode: ghAuth, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue' && args.includes('--search')) {
      return { exitCode: 0, stdout: queue, stderr: '' }
    }
    if (cmd === 'gh' && args[0] === 'issue') return { exitCode: 0, stdout: orphan, stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  exec.npmViews = () => calls.filter((c) => c === NPM_VIEW)
  return exec
}

function deps(overrides = {}, execOptions = {}) {
  const timeline = []
  const stdout = makeStream()
  const stderr = makeStream()
  const paths = { exists: [], readFile: [] }
  const d = {
    cwd: '/repo',
    stdout,
    stderr,
    stdin: process.stdin,
    exec: makeExec(execOptions, timeline),
    exists: (p) => {
      paths.exists.push(String(p))
      timeline.push(`exists:${p}`)
      return false
    },
    loadEnv: (p) => {
      timeline.push(`loadEnv:${p}`)
      return {}
    },
    readFile: (p) => {
      paths.readFile.push(String(p))
      timeline.push(`readFile:${p}`)
      return ''
    },
    hasCommand: (c) => {
      timeline.push(`hasCommand:${c}`)
      return true
    },
    ask: async () => false,
    peekLock: () => null,
    sendWa: async () => ({ ok: true }),
    currentVersion: '0.1.0',
    now: () => T0,
    home: HOME,
    processEnv: {},
    cacheFs: new Volume(),
    // #200: the notice names the layout's updater — pin npm's, not this checkout's.
    classify: npmGlobalLayout(),
    ...overrides,
  }
  d.timeline = timeline
  d.paths = paths
  return d
}

// Records every cache fs op so ".env untouched" is proven at the call level.
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

const folderOverrides = (extra = {}) => ({
  exists: (p) => String(p).endsWith('ralph.config.sh'),
  readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : ''),
  folderQueueCount: async () => 1,
  ...extra,
})

describe('QA start step 2.5 ordering — one timeline, every side effect (#24)', () => {
  it('runs after the tmux guard and every dependency probe, before the first gh spawn and the .env.local read', async () => {
    const d = deps()
    await startCommand(d)
    const t = d.timeline
    const npmIdx = t.indexOf(`exec:${NPM_VIEW}`)
    const tmuxGuardIdx = t.findIndex((e) => e.startsWith('exec:tmux has-session'))
    const lastDepProbeIdx = t.reduce((acc, e, i) => (e.startsWith('hasCommand:') ? i : acc), -1)
    const firstGhIdx = t.findIndex((e) => e.startsWith('exec:gh '))
    const envLocalIdx = t.findIndex((e) => e.startsWith('exists:') && e.endsWith('.env.local'))
    const firstLoadEnvIdx = t.findIndex((e) => e.startsWith('loadEnv:'))

    expect(npmIdx).toBeGreaterThan(-1)
    expect(tmuxGuardIdx).toBeGreaterThan(-1)
    expect(firstGhIdx).toBeGreaterThan(-1)
    expect(envLocalIdx).toBeGreaterThan(-1)
    expect(firstLoadEnvIdx).toBeGreaterThan(-1)

    expect(tmuxGuardIdx).toBeLessThan(npmIdx)
    expect(lastDepProbeIdx).toBeLessThan(npmIdx)
    expect(npmIdx).toBeLessThan(firstGhIdx)
    expect(npmIdx).toBeLessThan(envLocalIdx)
    expect(npmIdx).toBeLessThan(firstLoadEnvIdx)
  })

  it('spawns npm view exactly once per run, and it is the FIRST spawn after the tmux guard', async () => {
    const d = deps()
    await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(1)
    const spawns = d.exec.calls
    expect(spawns[0].startsWith('tmux has-session')).toBe(true)
    expect(spawns[1]).toBe(NPM_VIEW)
  })

  it('prints the notice before the queue verdict, whatever the queue says', async () => {
    for (const queue of ['1', '0']) {
      const d = deps({}, { queue })
      await startCommand(d)
      const lines = d.stdout.lines()
      const noticeIdx = lines.findIndex((l) => l.includes(NOTICE))
      expect(noticeIdx).toBeGreaterThan(-1)
      const verdictIdx = lines.findIndex(
        (l) => l.includes('No issues in the queue') || l.includes('Ralph started in background'),
      )
      expect(verdictIdx).toBeGreaterThan(noticeIdx)
    }
  })

  it('prints the notice after the optional-dependency warnings (not interleaved)', async () => {
    const d = deps({ hasCommand: (c) => c !== 'jq' })
    await startCommand(d)
    const lines = d.stdout.lines()
    const jqIdx = lines.findIndex((l) => l.includes("'jq' not found"))
    const noticeIdx = lines.findIndex((l) => l.includes(NOTICE))
    expect(jqIdx).toBeGreaterThan(-1)
    expect(noticeIdx).toBeGreaterThan(jqIdx)
    expect(d.exec.npmViews()).toHaveLength(1)
  })

  it('emits the notice as a single stdout line with the upgrade command, and nothing on stderr', async () => {
    const d = deps()
    await startCommand(d)
    const noticeLines = d.stdout.lines().filter((l) => l.includes(NOTICE))
    expect(noticeLines).toHaveLength(1)
    expect(noticeLines[0]).toContain('0.2.0')
    expect(noticeLines[0]).toContain('npm i -g @lucasfe/ralph')
    expect(d.stderr.output()).toBe('')
  })
})

describe('QA start step 2.5 on the paths the old step 8.5 never reached (#24)', () => {
  it('prints the notice in folder mode, where no gh spawn happens at all', async () => {
    const d = deps(folderOverrides())
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(d.exec.calls.some((c) => c.startsWith('gh '))).toBe(false)
    expect(d.exec.npmViews()).toHaveLength(1)
    expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })

  it('prints the notice in folder mode with an EMPTY folder queue', async () => {
    const d = deps(folderOverrides({ folderQueueCount: async () => 0 }))
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(d.stdout.output()).toContain('No issues in the queue')
    expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })

  it('prints the notice even when a broken folder queue counter yields zero', async () => {
    const d = deps(
      folderOverrides({
        folderQueueCount: async () => {
          throw new Error('tasks dir unreadable')
        },
      }),
    )
    const result = await startCommand(d)
    expect(result.started).toBe(false)
    expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })

  it('has already checked (and stamped) when the run aborts on gh auth', async () => {
    // 2.5 sits before the gh guard on purpose, so a gh-auth abort still gets the
    // notice and still burns the weekly window. Pinned: it is the direct
    // consequence of "before the first gh invocation".
    const cacheFs = new Volume()
    const d = deps({ cacheFs }, { ghAuth: 1 })
    await expect(startCommand(d)).rejects.toBeInstanceOf(StartAbort)
    expect(d.exec.npmViews()).toHaveLength(1)
    expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    expect(readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} })).toEqual({
      last_check_at: new Date(T0).toISOString(),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
  })

  it('does not check when the critical-dep guard aborts on a missing tmux', async () => {
    const cacheFs = new Volume()
    const d = deps({ cacheFs, hasCommand: (c) => c !== 'tmux' })
    await expect(startCommand(d)).rejects.toBeInstanceOf(StartAbort)
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(d.stdout.output()).not.toContain(NOTICE)
    expect(cacheFs.existsSync(CACHE_PATH)).toBe(false)
  })

  it('does not check when the critical-dep guard aborts on a missing npm', async () => {
    const d = deps({ hasCommand: (c) => c !== 'npm' })
    await expect(startCommand(d)).rejects.toBeInstanceOf(StartAbort)
    expect(d.exec.npmViews()).toHaveLength(0)
  })

  it('does not check when a stale-but-alive cycle lock is held', async () => {
    const cacheFs = new Volume()
    const d = deps({
      cacheFs,
      peekLock: () => ({ holder: { pid: 7, startedAt: '2026-08-22T10:00:00.000Z' }, alive: true }),
    })
    await expect(startCommand(d)).rejects.toBeInstanceOf(StartAbort)
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(cacheFs.existsSync(CACHE_PATH)).toBe(false)
  })

  it('DOES check when a dead cycle lock is present (start proceeds)', async () => {
    const d = deps({ peekLock: () => ({ holder: { pid: 7 }, alive: false }) })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(d.exec.npmViews()).toHaveLength(1)
  })
})

describe('QA start survives a hostile global cache (#24)', () => {
  const corrupt = [
    ['an empty file', ''],
    ['whitespace only', '   \n\t'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"nope"'],
    ['truncated JSON', '{"last_check_at":"2026-08-2'],
    ['a BOM-prefixed object', '﻿{"last_check_at":"2026-08-21T12:00:00.000Z"}'],
    ['numeric field types', '{"last_check_at":1787356800000,"latest_version":17}'],
    ['a nested object field', '{"last_check_at":{"iso":"2026-08-21T12:00:00.000Z"}}'],
    ['an unparseable date string', '{"last_check_at":"last tuesday"}'],
    ['unknown keys only', '{"foo":"bar","last_seen_release":"v0.16.0"}'],
  ]

  for (const [label, raw] of corrupt) {
    it(`starts and still notices the new version with ${label}`, async () => {
      const cacheFs = Volume.fromJSON({ [CACHE_PATH]: raw }, '/')
      const d = deps({ cacheFs })
      const result = await startCommand(d)
      expect(result.started).toBe(true)
      expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
      expect(d.exec.npmViews()).toHaveLength(1)
      // and the corrupt file is replaced by a well-formed one
      expect(readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} }).last_check_at).toBe(
        new Date(T0).toISOString(),
      )
    })
  }

  it('starts and notices when a DIRECTORY occupies the cache path', async () => {
    const cacheFs = new Volume()
    cacheFs.mkdirSync(CACHE_PATH, { recursive: true })
    const d = deps({ cacheFs })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })

  const unwritable = [
    [
      'mkdirSync throws EACCES',
      {
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
      },
    ],
    [
      'writeFileSync throws EROFS',
      {
        readFileSync: () => {
          const e = new Error('ENOENT')
          e.code = 'ENOENT'
          throw e
        },
        mkdirSync: () => undefined,
        writeFileSync: () => {
          const e = new Error('EROFS: read-only file system')
          e.code = 'EROFS'
          throw e
        },
      },
    ],
    [
      'writeFileSync throws ENOSPC',
      {
        readFileSync: () => '{}',
        mkdirSync: () => undefined,
        writeFileSync: () => {
          const e = new Error('ENOSPC: no space left on device')
          e.code = 'ENOSPC'
          throw e
        },
      },
    ],
    [
      'readFileSync throws EACCES',
      {
        readFileSync: () => {
          const e = new Error('EACCES: permission denied')
          e.code = 'EACCES'
          throw e
        },
        mkdirSync: () => undefined,
        writeFileSync: () => undefined,
      },
    ],
    ['the fs object has no methods at all', {}],
  ]

  for (const [label, cacheFs] of unwritable) {
    it(`launches the loop and prints the notice when ${label}`, async () => {
      const d = deps({ cacheFs })
      const result = await startCommand(d)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
      expect(d.stderr.output()).toBe('')
    })
  }

  it('an unwritable cache means the next run re-queries (no window was stored)', async () => {
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
    await startCommand(first)
    const second = deps({ cacheFs, now: () => T0 + DAY })
    await startCommand(second)
    expect(first.exec.npmViews()).toHaveLength(1)
    expect(second.exec.npmViews()).toHaveLength(1)
    expect(second.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })
})

describe('QA the weekly window is GLOBAL, not per-repo (#24)', () => {
  it('two different repos sharing a home make ONE npm view and both see the notice', async () => {
    const cacheFs = new Volume()
    const a = deps({ cacheFs, cwd: '/repo-a' })
    await startCommand(a)
    const b = deps({ cacheFs, cwd: '/repo-b', now: () => T0 + 2 * DAY })
    await startCommand(b)
    expect(a.exec.npmViews()).toHaveLength(1)
    expect(b.exec.npmViews()).toHaveLength(0)
    expect(a.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    expect(b.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    // Per-repo tmux sessions prove these really were different projects.
    expect(a.exec.calls[0]).toContain(sessionNameFor('/repo-a'))
    expect(b.exec.calls[0]).toContain(sessionNameFor('/repo-b'))
  })

  it('a third repo after the window elapses re-queries once for everyone', async () => {
    const cacheFs = new Volume()
    const runs = [
      ['/repo-a', T0],
      ['/repo-b', T0 + 2 * DAY],
      ['/repo-c', T0 + 8 * DAY],
      ['/repo-a', T0 + 9 * DAY],
    ]
    const views = []
    for (const [cwd, now] of runs) {
      const d = deps({ cacheFs, cwd, now: () => now })
      await startCommand(d)
      views.push(d.exec.npmViews().length)
    }
    expect(views).toEqual([1, 0, 1, 0])
    expect(readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} }).last_check_at).toBe(
      new Date(T0 + 8 * DAY).toISOString(),
    )
  })

  it('honors $XDG_CONFIG_HOME for the shared cache and never writes ~/.config', async () => {
    const cacheFs = new Volume()
    const processEnv = { XDG_CONFIG_HOME: '/xdg' }
    const a = deps({ cacheFs, processEnv, cwd: '/repo-a' })
    await startCommand(a)
    const b = deps({ cacheFs, processEnv, cwd: '/repo-b', now: () => T0 + DAY })
    await startCommand(b)
    expect(cacheFs.existsSync(join('/xdg', 'ralph', 'update-check.json'))).toBe(true)
    expect(cacheFs.existsSync(CACHE_PATH)).toBe(false)
    expect(b.exec.npmViews()).toHaveLength(0)
  })

  it('a future stamp written by a skewed machine is corrected on the next run', async () => {
    const cacheFs = Volume.fromJSON(
      {
        [CACHE_PATH]: JSON.stringify({
          last_check_at: new Date(T0 + 90 * DAY).toISOString(),
          last_prompted_at: null,
          latest_version: '0.1.0',
        }),
      },
      '/',
    )
    const d = deps({ cacheFs })
    await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(1)
    expect(readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} }).last_check_at).toBe(
      new Date(T0).toISOString(),
    )
    expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })
})

describe('QA the cache never disturbs the global .env during start (#24)', () => {
  const ENV_CONTENT = '# ralph creds\nCALLMEBOT_KEY=secret\nWHATSAPP_PHONE=+15550001111\n'

  it('writes only the cache path — the .env is never read, written or chmodded', async () => {
    const v = Volume.fromJSON({ [ENV_PATH]: ENV_CONTENT }, '/')
    v.chmodSync(ENV_PATH, 0o600)
    v.chmodSync(dirname(ENV_PATH), 0o700)
    const cacheFs = spyFs(v)
    const d = deps({ cacheFs })
    await startCommand(d)
    expect(cacheFs.ops.some((o) => o.path === ENV_PATH)).toBe(false)
    expect(cacheFs.ops.filter((o) => o.op === 'write').map((o) => o.path)).toEqual([CACHE_PATH])
    expect(v.readFileSync(ENV_PATH, 'utf8').toString()).toBe(ENV_CONTENT)
    expect(v.statSync(ENV_PATH).mode & 0o777).toBe(0o600)
    expect(v.statSync(dirname(ENV_PATH)).mode & 0o777).toBe(0o700)
  })

  it('adds exactly one file to the config dir across repeated runs', async () => {
    const v = Volume.fromJSON({ [ENV_PATH]: ENV_CONTENT }, '/')
    const before = Object.keys(v.toJSON()).sort()
    for (const now of [T0, T0 + 8 * DAY, T0 + 16 * DAY]) {
      await startCommand(deps({ cacheFs: v, now: () => now }))
    }
    expect(Object.keys(v.toJSON()).sort()).toEqual([...before, CACHE_PATH].sort())
  })

  it('leaves the cache alone when creds are written afterwards (init/whatsapp flow)', async () => {
    const v = new Volume()
    await startCommand(deps({ cacheFs: v }))
    const cacheBefore = v.readFileSync(CACHE_PATH, 'utf8').toString()
    writeGlobalCreds({ values: { CALLMEBOT_KEY: 'k' }, fs: v, home: HOME, processEnv: {} })
    expect(v.readFileSync(CACHE_PATH, 'utf8').toString()).toBe(cacheBefore)
    expect(v.statSync(ENV_PATH).mode & 0o777).toBe(0o600)
    expect(v.statSync(dirname(ENV_PATH)).mode & 0o777).toBe(0o700)
  })

  it('never writes a credential value into the cache file', async () => {
    const v = Volume.fromJSON({ [ENV_PATH]: ENV_CONTENT }, '/')
    const d = deps({
      cacheFs: v,
      exists: (p) => String(p).endsWith('.env.local'),
      loadEnv: () => ({ CALLMEBOT_KEY: 'repo-secret', WHATSAPP_PHONE: '+1' }),
    })
    await startCommand(d)
    const raw = v.readFileSync(CACHE_PATH, 'utf8').toString()
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('CALLMEBOT')
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'last_check_at',
      'last_prompted_at',
      'latest_version',
    ])
  })
})

describe('QA RALPH_NO_UPDATE_CHECK through start (#24)', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', ' 1 ']) {
    it(`"${value}" → no spawn, no output, no cache file, start still works`, async () => {
      const cacheFs = spyFs(new Volume())
      const d = deps({ cacheFs, processEnv: { RALPH_NO_UPDATE_CHECK: value } })
      const result = await startCommand(d)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.exec.npmViews()).toHaveLength(0)
      expect(d.stdout.output()).not.toContain(NOTICE)
      expect(cacheFs.ops).toHaveLength(0)
    })
  }

  for (const value of ['0', 'false', '', '   ']) {
    it(`"${value}" → the check still runs and the notice still prints`, async () => {
      const d = deps({ processEnv: { RALPH_NO_UPDATE_CHECK: value } })
      await startCommand(d)
      expect(d.exec.npmViews()).toHaveLength(1)
      expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    })
  }

  it('the opt-out also suppresses the notice that a warm cache could have served', async () => {
    const cacheFs = Volume.fromJSON(
      {
        [CACHE_PATH]: JSON.stringify({
          last_check_at: new Date(T0 - DAY).toISOString(),
          last_prompted_at: null,
          latest_version: '9.9.9',
        }),
      },
      '/',
    )
    const d = deps({ cacheFs, processEnv: { RALPH_NO_UPDATE_CHECK: '1' } })
    await startCommand(d)
    expect(d.stdout.output()).not.toContain(NOTICE)
    expect(d.exec.npmViews()).toHaveLength(0)
  })
})

describe('QA start stays silent when there is nothing to announce (#24)', () => {
  it('says nothing when the registry trails or matches the installed version', async () => {
    for (const [currentVersion, stdout] of [
      ['0.2.0', '0.2.0\n'],
      ['0.3.0', '0.2.0\n'],
    ]) {
      const d = deps({ currentVersion }, { npm: { exitCode: 0, stdout, stderr: '' } })
      await startCommand(d)
      expect(d.stdout.output()).not.toContain(NOTICE)
      expect(d.stderr.output()).toBe('')
    }
  })

  it('says nothing when currentVersion is not a comparable semver, but still stamps the window', async () => {
    const cacheFs = new Volume()
    const d = deps({ cacheFs, currentVersion: 'unknown' })
    await startCommand(d)
    expect(d.stdout.output()).not.toContain(NOTICE)
    expect(readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} })).toEqual({
      last_check_at: new Date(T0).toISOString(),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
  })

  it('says nothing on a throttled run whose cached version is not newer', async () => {
    const cacheFs = Volume.fromJSON(
      {
        [CACHE_PATH]: JSON.stringify({
          last_check_at: new Date(T0 - DAY).toISOString(),
          last_prompted_at: null,
          latest_version: '0.1.0',
        }),
      },
      '/',
    )
    const d = deps({ cacheFs })
    await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(0)
    expect(d.stdout.output()).not.toContain(NOTICE)
  })

  const registryFailures = [
    ['a non-zero exit', { exitCode: 1, stdout: '', stderr: 'offline' }],
    ['a timeout', { exitCode: 1, stdout: '', stderr: '', timedOut: true }],
    ['empty stdout', { exitCode: 0, stdout: '', stderr: '' }],
    ['garbage stdout', { exitCode: 0, stdout: 'not-a-version\n', stderr: '' }],
    ['an HTML error page', { exitCode: 0, stdout: '<html>404</html>', stderr: '' }],
  ]

  for (const [label, npm] of registryFailures) {
    it(`is silent and non-blocking on ${label}`, async () => {
      const d = deps({}, { npm })
      const result = await startCommand(d)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(d.stdout.output()).not.toContain(NOTICE)
      expect(d.stderr.output()).toBe('')
      // The tmux loop was still launched.
      expect(d.exec.calls.some((c) => c.startsWith('tmux new '))).toBe(true)
    })
  }

  it('a stale cached version survives one failed refresh so the notice is not lost', async () => {
    const cacheFs = Volume.fromJSON(
      {
        [CACHE_PATH]: JSON.stringify({
          last_check_at: new Date(T0 - 30 * DAY).toISOString(),
          last_prompted_at: null,
          latest_version: '0.2.0',
        }),
      },
      '/',
    )
    const d = deps({ cacheFs }, { npm: { exitCode: 1, stdout: '', stderr: 'offline' } })
    await startCommand(d)
    expect(d.exec.npmViews()).toHaveLength(1)
    expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    expect(readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} })).toEqual({
      last_check_at: new Date(T0).toISOString(),
      last_prompted_at: null,
      latest_version: '0.2.0',
    })
  })
})

describe('QA step 2.5 no longer touches project state (#24 removal of readSt/writeSt)', () => {
  it('never reads or writes .ralph/state.json while producing the notice', async () => {
    const d = deps()
    await startCommand(d)
    const touched = [...d.paths.exists, ...d.paths.readFile]
    expect(touched.some((p) => p.includes('state.json'))).toBe(false)
    // #60 added the ONE other path under .ralph this command consults: the metrics
    // file the launch projection reads, at the box and long after step 2.5. So the
    // invariant is now spelled out as the two things it was always about — no
    // state.json, and nothing else under .ralph but that read-only metrics read.
    expect(touched.filter((p) => p.includes('.ralph'))).toEqual([
      join('/repo', '.ralph', 'metrics', 'issues.jsonl'),
    ])
    expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
  })

  it('the only project files consulted are ralph.config.sh, .env.local and .mcp.json', async () => {
    const d = deps()
    await startCommand(d)
    const expected = new Set([
      resolve('/repo', 'ralph.config.sh'),
      resolve('/repo', '.env.local'),
      resolve('/repo', '.mcp.json'),
    ])
    for (const p of d.paths.exists) expect(expected.has(p)).toBe(true)
  })

  it('the notice is unaffected by a state.json that still names the same release', async () => {
    // #24 stopped reading last_seen_release but did not remove the field. A repo
    // whose state.json still names 0.2.0 must STILL get the notice — the old
    // step-8.5 dedupe (which would have suppressed it) is gone.
    const d = deps({
      exists: (p) => !String(p).endsWith('.mcp.json'),
      readFile: (p) =>
        String(p).endsWith('state.json')
          ? JSON.stringify({ last_seen_release: '0.2.0' })
          : '',
      loadEnv: () => ({}),
    })
    await startCommand(d)
    expect(d.stdout.output()).toContain(`${NOTICE}: 0.2.0`)
    expect(d.paths.readFile.some((p) => p.includes('state.json'))).toBe(false)
  })
})
