import { describe, it, expect } from 'vitest'
import { startCommand } from './start.js'
import { globalConfigPath } from '../utils/global-config.js'
import { sessionNameFor } from '../lock.js'

const REPO = '/repo'
const HOME = '/home/me'

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
  }
}

function makeExec(handlers = {}) {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, options })
    if (Object.prototype.hasOwnProperty.call(handlers, key)) {
      const v = handlers[key]
      return typeof v === 'function' ? v({ cmd, args, options }) : v
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

function makeWa() {
  const messages = []
  const sendWa = async (args) => {
    messages.push(args)
    return { ok: true }
  }
  sendWa.messages = messages
  return sendWa
}

const GLOBAL_PATH = globalConfigPath({ processEnv: {}, home: HOME })

// The tmux guard must NOT find an existing session; the queue is empty so start
// returns early after the env read site (which is what these tests exercise).
const baseHandlers = () => ({
  'tmux has-session -t': { exitCode: 1, stdout: '', stderr: '' },
})

const baseDeps = (overrides = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const sendWa = makeWa()
  const exec = makeExec()
  // tmux has-session uses a per-project session name, so match by prefix below.
  const wrapped = async (cmd, args, options = {}) => {
    if (cmd === 'tmux' && args[0] === 'has-session') {
      exec.calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    if (cmd === 'gh' && args.join(' ') === 'auth status') {
      exec.calls.push({ key: 'gh auth status', cmd, args, options })
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      exec.calls.push({ key: 'gh issue list', cmd, args, options })
      // queue empty → returns early right after startup notification would be
      return { exitCode: 0, stdout: '0', stderr: '' }
    }
    return exec(cmd, args, options)
  }
  wrapped.calls = exec.calls
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec: wrapped,
    exists: () => false,
    loadEnv: () => ({}),
    hasCommand: () => true,
    ask: async () => true,
    // #24: the weekly update check is a no-op in these suites — they exercise
    // other read sites, and injecting the decision keeps the global cache and
    // the registry out of the picture entirely.
    update: async () => ({
      latestVersion: null,
      isNewer: false,
      shouldPrompt: false,
      source: 'disabled',
      updatedCache: null,
    }),
    sendWa,
    peekLock: () => null,
    home: HOME,
    processEnv: {},
    ...overrides,
  }
}

describe('startCommand — global config read site (#3)', () => {
  it('does NOT warn about missing creds when the global file supplies them', async () => {
    const deps = baseDeps({
      exists: () => false, // no repo .env.local
      loadEnv: (path) =>
        path === GLOBAL_PATH
          ? { CALLMEBOT_KEY: 'global-key', WHATSAPP_PHONE: 'global-phone' }
          : {},
      processEnv: {},
    })
    const result = await startCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stdout.output()).not.toMatch(/notifications will be skipped/)
  })

  it('warns about missing creds when neither repo, process.env, nor global supply them', async () => {
    const deps = baseDeps({
      exists: () => false,
      loadEnv: () => ({}),
      processEnv: {},
    })
    await startCommand(deps)
    expect(deps.stdout.output()).toMatch(/notifications will be skipped/)
  })

  it('repo .env.local overrides the global file', async () => {
    const deps = baseDeps({
      exists: () => true, // repo .env.local present
      loadEnv: (path) =>
        path === GLOBAL_PATH
          ? { CALLMEBOT_KEY: 'global-key', WHATSAPP_PHONE: 'global-phone' }
          : { CALLMEBOT_KEY: 'repo-key', WHATSAPP_PHONE: 'repo-phone' },
      processEnv: {},
    })
    await startCommand(deps)
    // repo creds are present → no warning
    expect(deps.stdout.output()).not.toMatch(/notifications will be skipped/)
  })
})

// #565: `ralph start` must be folder-aware like `ralph cycle`. In folder mode
// the preflight never touches gh (no auth check, no label creation, no orphan
// sweep) and the queue count comes from the local .ralph/tasks tree instead of
// `gh issue list`. Behaviour is otherwise identical — only the pickup source
// differs; the launched loop (templates/ralph.sh) dispatches both. The github
// path (default) is unchanged — all the tests above still drive it through gh.
describe('startCommand — folder task source (#565)', () => {
  // exists() true only for ralph.config.sh so readConfigSource reads it; other
  // paths (.env.local, .mcp.json) stay absent to keep the run minimal.
  const folderDeps = (overrides = {}) =>
    baseDeps({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: (p) =>
        String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : '',
      folderQueueCount: async () => 1,
      ...overrides,
    })

  it('does NOT run gh auth status in folder mode', async () => {
    const deps = folderDeps()
    await startCommand(deps)
    expect(deps.exec.calls.some((c) => c.key === 'gh auth status')).toBe(false)
  })

  it('a broken gh auth does NOT block start in folder mode', async () => {
    // Custom exec: no tmux session exists, but gh auth is broken. In folder mode
    // start must never call gh auth, so a failing gh must not block the launch.
    const calls = []
    const exec = async (cmd, args, options = {}) => {
      calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
      if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
      if (cmd === 'gh' && args[0] === 'auth') return { exitCode: 1, stdout: '', stderr: 'not authenticated' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    exec.calls = calls
    const deps = folderDeps({ exec })
    const result = await startCommand(deps)
    // reaches the tmux launch (queue is 1) — proof preflight let it through.
    expect(result.started).toBe(true)
    expect(calls.some((c) => c.key === 'gh auth status')).toBe(false)
  })

  it('does NOT create labels or sweep orphans via gh in folder mode', async () => {
    const deps = folderDeps()
    await startCommand(deps)
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh label create'))).toBe(false)
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh issue list'))).toBe(false)
  })

  it('counts the folder queue (not gh issue list) and launches when non-empty', async () => {
    const deps = folderDeps({ folderQueueCount: async () => 3 })
    const result = await startCommand(deps)
    expect(result.started).toBe(true)
    expect(result.count).toBe(3)
    // the tmux loop was launched
    expect(deps.exec.calls.some((c) => c.cmd === 'tmux' && c.args[0] === 'new')).toBe(true)
  })

  it('exits "nothing to do" when the folder queue is empty', async () => {
    const deps = folderDeps({ folderQueueCount: async () => 0 })
    const result = await startCommand(deps)
    expect(result.started).toBe(false)
    expect(deps.stdout.output()).toMatch(/No issues in the queue/)
    // never launched a loop
    expect(deps.exec.calls.some((c) => c.cmd === 'tmux' && c.args[0] === 'new')).toBe(false)
  })
})

// #60: the startup box sets expectations before the user walks away — what the
// accepted queue should cost and when it should be done, plus the `ralph status`
// hint at the moment it becomes relevant. PURELY ADDITIVE: every pre-existing line
// keeps its text and its relative order, which is why these tests assert the whole
// box rather than the new lines alone.
//
// Driven through the folder source so the queue depth is a dependency rather than a
// `gh` stub — the box itself is source-independent.
describe('startCommand — launch projection and hints in the startup box (#60)', () => {
  const SESSION = sessionNameFor(REPO)
  const MIN = 60000

  // Two runs' worth of history: 97 and 71 minutes → 84 min/task, $34.10 and $28.75
  // → $31.43/task. Nine waiting is 12h36m and ~$280, and a 16:04 launch finishes at
  // 04:40 the next morning.
  const METRICS =
    [
      { issue_number: 29, run_id: 'ralph-a', ts: 1, duration_ms: 97 * MIN, total_cost_usd: 34.1 },
      { issue_number: 30, run_id: 'ralph-b', ts: 2, duration_ms: 71 * MIN, total_cost_usd: 28.75 },
    ]
      .map((e) => `RALPH_ISSUE_EVENT ${JSON.stringify(e)}`)
      .join('\n') + '\n'
  const NOW = new Date(2026, 7, 25, 16, 4, 0).getTime()

  // DERIVED from NOW rather than written out: the finish time is the reader's local
  // wall clock, so a hardcoded `04:40` would be asserting this machine's timezone.
  const clockOf = (ms) => {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const DONE = clockOf(NOW + 756 * MIN)

  const EXISTING_TAIL = [
    `   Watch live:     tmux attach -t ${SESSION}`,
    '   Detach:         inside the session, Ctrl+B then D',
    '   List:           tmux ls',
    `   Kill:           tmux kill-session -t ${SESSION}`,
    '   Logs:           logs/ralph-issue-*.log',
  ]
  // The box's own lines, named once: several tests assert the WHOLE box (that is
  // the point — the change is additive), and eight copies of the same two
  // projection strings is eight places to update when a label moves one column.
  const STARTED = '✅ Ralph started in background. 9 issues in the queue.'
  const PROJECTION = [
    '   Projection:     ~84 min/task · ~$31/task',
    `                   → ~12h36m, ~$280, done ≈ ${DONE}`,
  ]
  const PROGRESS = '   Progress:       ralph status'

  // config/metrics served from the SAME injected readFile the command already
  // takes, so no test touches a real filesystem.
  const boxDeps = ({ config = 'TASK_SOURCE=folder\n', metrics = METRICS, ...overrides } = {}) =>
    baseDeps({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: (p) => {
        const path = String(p)
        if (path.endsWith('ralph.config.sh')) return config
        if (path.endsWith('issues.jsonl')) return metrics
        return ''
      },
      folderQueueCount: async () => 9,
      now: () => NOW,
      ...overrides,
    })

  // The box only, from the success line down — the credential notice above it is a
  // different surface.
  const box = (deps) => {
    const lines = deps.stdout.output().split('\n')
    const first = lines.findIndex((l) => l.startsWith('✅ Ralph started in background.'))
    return lines.slice(first).filter(Boolean)
  }

  it('prints the projection and the status hint above the untouched tmux lines', async () => {
    const deps = boxDeps()
    const result = await startCommand(deps)
    expect(result.started).toBe(true)
    expect(box(deps)).toEqual([STARTED, ...PROJECTION, PROGRESS, ...EXISTING_TAIL])
  })

  it('omits the projection block entirely on a fresh repo with no metrics history', async () => {
    const deps = boxDeps({ metrics: '' })
    await startCommand(deps)
    // No `~0 min/task`, no `~$0` — the block is absent, and the hint is not.
    expect(box(deps)).toEqual([STARTED, PROGRESS, ...EXISTING_TAIL])
  })

  it('omits the projection when the metrics file cannot be read, and still launches', async () => {
    const deps = boxDeps({
      readFile: (p) => {
        if (String(p).endsWith('ralph.config.sh')) return 'TASK_SOURCE=folder\n'
        throw new Error('EACCES: permission denied')
      },
    })
    const result = await startCommand(deps)
    expect(result.started).toBe(true)
    expect(deps.stdout.output()).not.toContain('Projection:')
    expect(deps.stdout.output()).toContain(PROGRESS)
  })

  it('omits the projection when the metrics text is malformed', async () => {
    const deps = boxDeps({ metrics: 'RALPH_ISSUE_EVENT {truncated\nnot an event at all\n' })
    const result = await startCommand(deps)
    expect(result.started).toBe(true)
    expect(deps.stdout.output()).not.toContain('Projection:')
  })

  it('leaves the empty-queue early return untouched, history or not', async () => {
    const deps = boxDeps({ folderQueueCount: async () => 0 })
    const result = await startCommand(deps)
    expect(result).toEqual({ exitCode: 0, started: false })
    const out = deps.stdout.output()
    expect(out).toContain('ℹ️  No issues in the queue. Nothing to do.')
    expect(out).not.toContain('Projection:')
    expect(out).not.toContain('Progress:')
  })

  it('prints the digest hint only when RALPH_DIGEST_INTERVAL is configured', async () => {
    const deps = boxDeps({ config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\n' })
    await startCommand(deps)
    expect(box(deps)).toEqual([
      STARTED,
      ...PROJECTION,
      PROGRESS,
      '   Digest:         every 30m — runs alongside the loop',
      ...EXISTING_TAIL,
    ])
  })

  it('prints no digest hint when the interval is 0 or unset (every repo, today)', async () => {
    for (const config of [
      'TASK_SOURCE=folder\n',
      'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=0\n',
      'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=""\n',
    ]) {
      const deps = boxDeps({ config })
      await startCommand(deps)
      expect(deps.stdout.output()).not.toContain('Digest:')
    }
  })

  it('reads any spelling of a zero interval as off, never `every 0m`', async () => {
    // An interval of zero is not an interval, whichever way it is written — and the
    // live value carries a unit, so `0m` is the likelier way to write the knob off
    // than a bare `0`.
    for (const value of ['0', '0m', '0h', '00', '0.0m', '" 0 "']) {
      const deps = boxDeps({ config: `TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=${value}\n` })
      await startCommand(deps)
      expect(deps.stdout.output(), value).not.toContain('Digest:')
    }
    // ...and a fractional interval still prints, so "off" swallowed no real value.
    const on = boxDeps({ config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=0.5h\n' })
    await startCommand(on)
    expect(on.stdout.output()).toContain('   Digest:         every 0.5h')
  })

  it('reads ralph.config.sh ONCE for both the task source and the digest interval', async () => {
    const reads = []
    const deps = boxDeps({
      readFile: (p) => {
        const path = String(p)
        if (path.endsWith('ralph.config.sh')) {
          reads.push(path)
          return 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\n'
        }
        return path.endsWith('issues.jsonl') ? METRICS : ''
      },
    })
    await startCommand(deps)
    expect(reads).toHaveLength(1)
    // ...and both values came out of it.
    expect(deps.exec.calls.some((c) => c.key === 'gh auth status')).toBe(false)
    expect(deps.stdout.output()).toContain('   Digest:         every 30m')
  })
})
