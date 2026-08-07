import { describe, it, expect } from 'vitest'
import { cycleCommand } from './cycle.js'
import { sessionNameFor } from '../lock.js'

const REPO = '/repo'
const REPO_SLUG = 'lucasfe/agenthub'
const SESSION = sessionNameFor(REPO)

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

const baseHandlers = () => ({
  'git rev-parse --show-toplevel': { exitCode: 0, stdout: `${REPO}\n`, stderr: '' },
  [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
  'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
  'gh repo view --json nameWithOwner -q .nameWithOwner': {
    exitCode: 0,
    stdout: `${REPO_SLUG}\n`,
    stderr: '',
  },
})

const baseDeps = (overrides = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const sendWa = makeWa()
  const pingSuccess = makePing()
  const pingFail = makePing()
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec: makeExec(baseHandlers()),
    exists: () => true,
    loadEnv: () => ({
      CALLMEBOT_KEY: 'k',
      WHATSAPP_PHONE: '+1',
      HEALTHCHECK_URL: 'https://hc-ping.com/x',
    }),
    acquireLock: () => ({ acquired: true, holder: { pid: 1, startedAt: '2026-04-29T00:00:00.000Z', repoPath: REPO } }),
    releaseLock: () => {},
    findOrphans: async () => [],
    cleanupOrphans: async () => [],
    sendWa,
    pingSuccess,
    pingFail,
    runQueueOnce: async () => ({ successes: [], failures: [] }),
    readFile: () => '',
    now: () => Date.parse('2026-04-29T00:30:00.000Z'),
    ...overrides,
  }
}

// Build an issues.jsonl text body of synthetic per-issue events, exactly as the
// writer (appendIssueEvent) emits them: one `RALPH_ISSUE_EVENT <json>` per line.
function issuesJsonl(events) {
  return events.map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e)).join('\n') + '\n'
}

// The base `now` in this harness; synthetic events with ts >= this are in-window.
const NOW_MS = Date.parse('2026-04-29T00:30:00.000Z')

describe('cycleCommand — tmux active', () => {
  it('exits 0 silently when this project\'s tmux session is already running', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await cycleCommand(deps)
    expect(result).toEqual({
      exitCode: 0,
      status: 'tmux-active',
      processed: 0,
      skipped: true,
    })
    expect(deps.sendWa.messages).toEqual([])
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh auth status'))).toBe(false)
  })

  it('checks the per-project derived session name, not the literal "ralph"', async () => {
    const deps = baseDeps()
    await cycleCommand(deps)
    expect(deps.exec.calls.some((c) => c.key === `tmux has-session -t ${SESSION}`)).toBe(true)
    expect(deps.exec.calls.some((c) => c.key === 'tmux has-session -t ralph')).toBe(false)
  })

  it('does not skip when another project\'s session is active but this project\'s is not', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      // Another project's interactive session is live...
      'tmux has-session -t ralph-other-deadbeef': { exitCode: 0, stdout: '', stderr: '' },
      // ...but this project's derived session is NOT.
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.status).not.toBe('tmux-active')
    expect(result.status).toBe('queue-empty')
  })
})

describe('cycleCommand — tmux guard is keyed to the repo ROOT, not cwd', () => {
  it('checks sessionNameFor(root) when cwd is a subdirectory and git resolves a different root', async () => {
    // cwd is deep inside the repo; git rev-parse resolves the true repo root.
    const SUBDIR = '/repo/packages/x'
    const deps = baseDeps({ cwd: SUBDIR })
    deps.exec = makeExec({
      ...baseHandlers(),
      // git rev-parse returns the repo root, NOT the cwd subdir.
      'git rev-parse --show-toplevel': { exitCode: 0, stdout: `${REPO}\n`, stderr: '' },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    // The guard must check the root-derived name, not a cwd-derived one.
    expect(deps.exec.calls.some((c) => c.key === `tmux has-session -t ${sessionNameFor(REPO)}`)).toBe(true)
    expect(deps.exec.calls.some((c) => c.key === `tmux has-session -t ${sessionNameFor(SUBDIR)}`)).toBe(false)
    // Sanity: the two derived names genuinely differ, so this is a real distinction.
    expect(sessionNameFor(REPO)).not.toBe(sessionNameFor(SUBDIR))
  })

  it('skips only when the ROOT-derived session is active — a session keyed to the cwd subdir must NOT cause a skip', async () => {
    const SUBDIR = '/repo/packages/x'
    const deps = baseDeps({ cwd: SUBDIR })
    deps.exec = makeExec({
      ...baseHandlers(),
      'git rev-parse --show-toplevel': { exitCode: 0, stdout: `${REPO}\n`, stderr: '' },
      // A session derived from the cwd subdir is live...
      [`tmux has-session -t ${sessionNameFor(SUBDIR)}`]: { exitCode: 0, stdout: '', stderr: '' },
      // ...but the root-derived session is NOT.
      [`tmux has-session -t ${sessionNameFor(REPO)}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.status).not.toBe('tmux-active')
    expect(result.status).toBe('queue-empty')
  })

  it('uses a DIFFERENT session key for a different repo root and skips only when THAT key is active', async () => {
    const OTHER = '/other/project'
    const deps = baseDeps({ cwd: OTHER })
    deps.exec = makeExec({
      ...baseHandlers(),
      'git rev-parse --show-toplevel': { exitCode: 0, stdout: `${OTHER}\n`, stderr: '' },
      // The OTHER project's own derived session is live → must skip.
      [`tmux has-session -t ${sessionNameFor(OTHER)}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('tmux-active')
    expect(result.skipped).toBe(true)
    // It must have queried the OTHER-derived name, never the default /repo one.
    expect(deps.exec.calls.some((c) => c.key === `tmux has-session -t ${sessionNameFor(OTHER)}`)).toBe(true)
    expect(deps.exec.calls.some((c) => c.key === `tmux has-session -t ${sessionNameFor(REPO)}`)).toBe(false)
    expect(sessionNameFor(OTHER)).not.toBe(sessionNameFor(REPO))
  })

  it('trims trailing whitespace/newline from git output before deriving the session name', async () => {
    // git rev-parse output is trimmed by resolveRepoRoot; the derived name must
    // match sessionNameFor('/repo'), not sessionNameFor('/repo\n') or with stray spaces.
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      'git rev-parse --show-toplevel': { exitCode: 0, stdout: `  ${REPO}  \n`, stderr: '' },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    expect(deps.exec.calls.some((c) => c.key === `tmux has-session -t ${sessionNameFor(REPO)}`)).toBe(true)
  })

  it('derives a sanitized session name when the repo root basename has special chars', async () => {
    // basename with characters outside [A-Za-z0-9_-] must be sanitized to '-'.
    const WEIRD = '/work/my repo.v2'
    const deps = baseDeps({ cwd: WEIRD })
    deps.exec = makeExec({
      ...baseHandlers(),
      'git rev-parse --show-toplevel': { exitCode: 0, stdout: `${WEIRD}\n`, stderr: '' },
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    const expected = sessionNameFor(WEIRD)
    // The sanitized name is what we expect a real tmux target to look like.
    expect(expected).toBe('ralph-my-repo-v2-' + expected.slice(-8))
    expect(deps.exec.calls.some((c) => c.key === `tmux has-session -t ${expected}`)).toBe(true)
  })
})

describe('cycleCommand — preflight failure', () => {
  it('returns preflight-failed and notifies WhatsApp when gh auth is broken', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh auth status': { exitCode: 1, stdout: '', stderr: 'not authenticated' },
    })
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(result.status).toBe('preflight-failed')
    expect(deps.sendWa.messages.length).toBeGreaterThan(0)
    expect(deps.sendWa.messages[0]).toMatch(/abort/i)
  })

  it('returns preflight-failed when ralph.config.sh is missing', async () => {
    const deps = baseDeps()
    deps.exists = (path) => !path.endsWith('ralph.config.sh')
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(result.status).toBe('preflight-failed')
    expect(result.reason).toMatch(/ralph\.config\.sh/)
  })

  it('returns preflight-failed when .ralph/state.json is missing', async () => {
    const deps = baseDeps()
    deps.exists = (path) => !path.endsWith('state.json')
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(result.status).toBe('preflight-failed')
    expect(result.reason).toMatch(/state\.json/)
  })

  it('returns preflight-failed when claude credentials file is missing', async () => {
    const deps = baseDeps()
    deps.exists = (path) => !path.includes('.claude')
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(result.status).toBe('preflight-failed')
    expect(result.reason).toMatch(/claude/i)
  })
})

// #559: the preflight must resolve the agent from ralph.config.sh and run THAT
// agent's auth probe — so a Codex-only machine (no ~/.claude credentials, but a
// logged-in codex CLI) passes, and a codex auth failure is caught in preflight
// rather than mid-loop. The claude path above is unchanged.
describe('cycleCommand — preflight is agent-aware (#559)', () => {
  // A codex-only machine: config selects codex, ~/.claude creds are ABSENT, and
  // `codex login status` exits 0. Preflight must pass and the cycle proceeds.
  const codexOnlyDeps = (overrides = {}) =>
    baseDeps({
      // No claude credentials file on this machine; everything else exists.
      exists: (path) => !String(path).includes('.claude'),
      readFile: (p) =>
        String(p).endsWith('ralph.config.sh') ? 'RALPH_AGENT=codex\n' : '',
      ...overrides,
    })

  it('a Codex-only machine passes preflight (no claude creds, codex login ok)', async () => {
    const deps = codexOnlyDeps()
    const result = await cycleCommand(deps)
    // Not preflight-failed: with the queue empty (default), it reaches the
    // queue-empty branch — proof preflight let it through.
    expect(result.status).not.toBe('preflight-failed')
    // It probed codex login status, never a claude credentials file.
    expect(deps.exec.calls.some((c) => c.key === 'codex login status')).toBe(true)
  })

  it('catches a codex auth failure in preflight (login status non-zero)', async () => {
    const deps = codexOnlyDeps({
      exec: makeExec({
        ...baseHandlers(),
        'codex login status': { exitCode: 1, stdout: '', stderr: 'not logged in' },
      }),
    })
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(1)
    expect(result.status).toBe('preflight-failed')
    expect(result.reason).toMatch(/codex/i)
    // Failure is caught in preflight — the queue is never touched.
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh issue list'))).toBe(false)
  })

  it('a codex "login not required" (exit 0) is treated as authenticated', async () => {
    const deps = codexOnlyDeps({
      exec: makeExec({
        ...baseHandlers(),
        'codex login status': {
          exitCode: 0,
          stdout: '',
          stderr: 'Login is not required. Uses managed credentials.',
        },
      }),
    })
    const result = await cycleCommand(deps)
    expect(result.status).not.toBe('preflight-failed')
  })
})

// #565: in folder mode the preflight must NOT require gh auth, and the queue
// count comes from the local .ralph/tasks/afk/todo tree instead of `gh issue
// list`. The github path (default) is unchanged — all the tests above still
// drive it through gh.
describe('cycleCommand — folder task source (#565)', () => {
  const folderDeps = (overrides = {}) =>
    baseDeps({
      readFile: (p) =>
        String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : '',
      ...overrides,
    })

  it('does NOT run gh auth status in folder mode', async () => {
    const deps = folderDeps({
      // one task in the folder queue → proceeds past queue-empty
      folderQueueCount: async () => 1,
    })
    await cycleCommand(deps)
    expect(deps.exec.calls.some((c) => c.key === 'gh auth status')).toBe(false)
  })

  it('a broken gh auth does NOT fail folder-mode preflight', async () => {
    const deps = folderDeps({ folderQueueCount: async () => 0 })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh auth status': { exitCode: 1, stdout: '', stderr: 'not authenticated' },
    })
    deps.readFile = (p) =>
      String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : ''
    const result = await cycleCommand(deps)
    // reaches queue-empty (queue is 0) — proof preflight let it through.
    expect(result.status).not.toBe('preflight-failed')
    expect(result.status).toBe('queue-empty')
  })

  it('counts the folder queue (not gh issue list) in folder mode', async () => {
    const deps = folderDeps({ folderQueueCount: async () => 3 })
    await cycleCommand(deps)
    // the gh issue-list query must NOT have been used to count the queue
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh issue list'))).toBe(false)
  })

  it('exits queue-empty when the folder queue is empty', async () => {
    const deps = folderDeps({ folderQueueCount: async () => 0 })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('queue-empty')
  })

  it('github mode still uses gh auth + gh issue list (no regression)', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    expect(deps.exec.calls.some((c) => c.key === 'gh auth status')).toBe(true)
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh issue list'))).toBe(true)
  })
})

describe('cycleCommand — lock held', () => {
  it('returns lock-held and notifies skipped when another instance holds the lock', async () => {
    const deps = baseDeps({
      acquireLock: () => ({
        acquired: false,
        holder: {
          pid: 9999,
          startedAt: '2026-04-29T00:00:00.000Z',
          repoPath: REPO,
        },
      }),
    })
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('lock-held')
    expect(result.skipped).toBe(true)
    expect(deps.sendWa.messages.length).toBe(1)
    expect(deps.sendWa.messages[0]).toMatch(/skip/i)
  })

  it('does not call runQueueOnce when lock is held', async () => {
    let queueCalled = false
    const deps = baseDeps({
      acquireLock: () => ({
        acquired: false,
        holder: { pid: 9999, startedAt: '2026-04-29T00:00:00.000Z', repoPath: REPO },
      }),
      runQueueOnce: async () => {
        queueCalled = true
        return { successes: [], failures: [] }
      },
    })
    await cycleCommand(deps)
    expect(queueCalled).toBe(false)
  })
})

describe('cycleCommand — orphans cleared', () => {
  it('runs cleanupOrphans and notifies aggregated when orphans existed', async () => {
    const deps = baseDeps({
      findOrphans: async () => [
        { number: 12, title: 'a', updatedAt: '2026-04-28T00:00:00Z' },
        { number: 34, title: 'b', updatedAt: '2026-04-28T01:00:00Z' },
      ],
      cleanupOrphans: async () => [12, 34],
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    const orphanMsg = deps.sendWa.messages.find((m) => /orphan|limpou|cleared/i.test(m))
    expect(orphanMsg).toBeDefined()
    expect(orphanMsg).toMatch(/12/)
    expect(orphanMsg).toMatch(/34/)
  })

  it('does not notify orphan summary when no orphans were cleared', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    expect(deps.sendWa.messages.find((m) => /orphan|limpou|cleared/i.test(m))).toBeUndefined()
  })
})

describe('cycleCommand — queue empty', () => {
  it('exits 0 silently and releases the lock when queue has 0 issues', async () => {
    let released = false
    const deps = baseDeps({ releaseLock: () => { released = true } })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result).toMatchObject({
      exitCode: 0,
      status: 'queue-empty',
      processed: 0,
      skipped: true,
    })
    expect(deps.sendWa.messages).toEqual([])
    expect(released).toBe(true)
  })
})

describe('cycleCommand — success path', () => {
  it('sends start + end WhatsApp, runs queue, pings success, releases lock', async () => {
    let released = false
    const deps = baseDeps({
      releaseLock: () => { released = true },
      readFile: () => issuesJsonl([
        { issue_number: 101, verdict: 'pass', ts: NOW_MS },
        { issue_number: 102, verdict: 'pass', ts: NOW_MS },
      ]),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '2',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('success')
    expect(result.processed).toBe(2)
    expect(deps.sendWa.messages.length).toBe(2)
    expect(deps.sendWa.messages[0]).toMatch(/cycle started/i)
    expect(deps.sendWa.messages[0]).toMatch(/2 issues/)
    expect(deps.sendWa.messages[0]).toMatch(REPO_SLUG)
    expect(deps.sendWa.messages[1]).toMatch(/finalizado|finished|done/i)
    expect(deps.sendWa.messages[1]).toMatch(/2 ok/i)
    expect(deps.pingSuccess.calls.length).toBe(1)
    expect(deps.pingFail.calls.length).toBe(0)
    expect(released).toBe(true)
  })

  it('reports partial status when some issues failed', async () => {
    const deps = baseDeps({
      readFile: () => issuesJsonl([
        { issue_number: 101, verdict: 'pass', ts: NOW_MS },
        { issue_number: 102, verdict: 'fail', ts: NOW_MS },
      ]),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '2',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('partial')
    expect(deps.pingSuccess.calls.length).toBe(1)
    expect(deps.pingFail.calls.length).toBe(0)
  })

  it('reports failed status and pings fail when every issue failed', async () => {
    const deps = baseDeps({
      readFile: () => issuesJsonl([
        { issue_number: 101, verdict: 'fail', ts: NOW_MS },
      ]),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('failed')
    expect(deps.pingSuccess.calls.length).toBe(0)
    expect(deps.pingFail.calls.length).toBe(1)
  })
})

describe('cycleCommand — best-effort failures never abort the cycle', () => {
  it('still returns success when WhatsApp send throws', async () => {
    const deps = baseDeps({
      sendWa: async () => {
        throw new Error('callmebot down')
      },
      runQueueOnce: async () => ({ successes: [101], failures: [] }),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('success')
  })

  it('still returns success when pingSuccess throws', async () => {
    const deps = baseDeps({
      pingSuccess: async () => {
        throw new Error('hc down')
      },
      runQueueOnce: async () => ({ successes: [101], failures: [] }),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('success')
  })

  it('still releases the lock when runQueueOnce throws', async () => {
    let released = false
    const deps = baseDeps({
      releaseLock: () => { released = true },
      runQueueOnce: async () => {
        throw new Error('queue blew up')
      },
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    await expect(cycleCommand(deps)).rejects.toThrow(/queue blew up/)
    expect(released).toBe(true)
  })

  it('skips healthcheck silently when HEALTHCHECK_URL is missing', async () => {
    const deps = baseDeps({
      loadEnv: () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' }),
      runQueueOnce: async () => ({ successes: [101], failures: [] }),
      processEnv: {},
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('success')
    expect(deps.pingSuccess.calls.length).toBe(0)
    expect(deps.pingFail.calls.length).toBe(0)
  })

  it('skips WhatsApp silently when CALLMEBOT_KEY/WHATSAPP_PHONE are missing', async () => {
    const deps = baseDeps({
      loadEnv: () => ({}),
      runQueueOnce: async () => ({ successes: [101], failures: [] }),
      processEnv: {},
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('success')
    expect(deps.sendWa.messages).toEqual([])
  })
})

describe('cycleCommand — RALPH_CYCLE_EVENT log line', () => {
  function readEvent(stdout) {
    const text = stdout.output()
    const idx = text.indexOf('RALPH_CYCLE_EVENT ')
    if (idx === -1) return null
    const lineEnd = text.indexOf('\n', idx)
    const line = text.slice(idx, lineEnd === -1 ? text.length : lineEnd)
    const jsonPart = line.slice('RALPH_CYCLE_EVENT '.length).trim()
    return JSON.parse(jsonPart)
  }

  it('emits status=success with ts/ok/failed/durationMin/processed on the success path', async () => {
    const deps = baseDeps({
      readFile: () => issuesJsonl([
        { issue_number: 101, verdict: 'pass', ts: NOW_MS },
        { issue_number: 102, verdict: 'pass', ts: NOW_MS },
      ]),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '2',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    expect(event.status).toBe('success')
    expect(event.ok).toBe(2)
    expect(event.failed).toBe(0)
    expect(event.processed).toBe(2)
    expect(typeof event.ts).toBe('string')
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('emits status=tmux-active when tmux session is already running', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    expect(event.status).toBe('tmux-active')
  })

  it('emits status=lock-held when another instance holds the lock', async () => {
    const deps = baseDeps({
      acquireLock: () => ({
        acquired: false,
        holder: { pid: 9999, startedAt: '2026-04-29T00:00:00.000Z', repoPath: REPO },
      }),
    })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    expect(event.status).toBe('lock-held')
    expect(event.holderPid).toBe(9999)
  })

  it('emits status=preflight-failed when preflight rejects', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh auth status': { exitCode: 1, stdout: '', stderr: 'not authenticated' },
    })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    expect(event.status).toBe('preflight-failed')
  })

  it('emits status=queue-empty when no issues are queued', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '0',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    expect(event.status).toBe('queue-empty')
  })

  it('emits status=failed when every issue failed', async () => {
    const deps = baseDeps({
      readFile: () => issuesJsonl([
        { issue_number: 101, verdict: 'fail', ts: NOW_MS },
      ]),
    })
    deps.exec = makeExec({
      ...baseHandlers(),
      'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
        exitCode: 0,
        stdout: '1',
        stderr: '',
      },
    })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    expect(event.status).toBe('failed')
    expect(event.ok).toBe(0)
    expect(event.failed).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// #532: real per-issue counts read from .ralph/metrics/issues.jsonl, not the
// (always-empty) runQueueOnce return; plus run_id threading into --once.
// ---------------------------------------------------------------------------
describe('cycleCommand — real counts from issues.jsonl (#532)', () => {
  function readEvent(stdout) {
    const text = stdout.output()
    const idx = text.indexOf('RALPH_CYCLE_EVENT ')
    if (idx === -1) return null
    const lineEnd = text.indexOf('\n', idx)
    const line = text.slice(idx, lineEnd === -1 ? text.length : lineEnd)
    return JSON.parse(line.slice('RALPH_CYCLE_EVENT '.length).trim())
  }

  const queueHandler = (n) => ({
    'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
      exitCode: 0,
      stdout: String(n),
      stderr: '',
    },
  })

  const expectedRunId = sessionNameFor(REPO) + '-' + Math.floor(NOW_MS / 1000)

  it('reports REAL ok/failed (not 0/0) from in-window metrics events', async () => {
    const deps = baseDeps({
      readFile: () => issuesJsonl([
        // An earlier event from a prior run — BEFORE start; must be excluded.
        { issue_number: 99, verdict: 'pass', ts: NOW_MS - 60000, run_id: 'stale-1' },
        { issue_number: 101, verdict: 'pass', ts: NOW_MS, run_id: expectedRunId },
        { issue_number: 102, verdict: 'fail', ts: NOW_MS, run_id: expectedRunId },
        { issue_number: 103, verdict: 'unknown', ts: NOW_MS, run_id: expectedRunId },
      ]),
    })
    deps.exec = makeExec({ ...baseHandlers(), ...queueHandler(3) })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event).not.toBeNull()
    // 1 pass = ok; fail + unknown = 2 failed. NOT 0/0.
    expect(event.ok).toBe(1)
    expect(event.failed).toBe(2)
    expect(event.processed).toBe(3)
    expect(event.status).toBe('partial')
    // The excluded stale event (#99) must not have inflated counts.
    expect(event.ok + event.failed).toBe(3)
  })

  it('the emitted run_id matches <session>-<epoch-seconds> and the in-window events', async () => {
    const deps = baseDeps({
      readFile: () => issuesJsonl([
        { issue_number: 101, verdict: 'pass', ts: NOW_MS, run_id: expectedRunId },
      ]),
    })
    deps.exec = makeExec({ ...baseHandlers(), ...queueHandler(1) })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    expect(event.run_id).toBe(expectedRunId)
    expect(event.run_id).toMatch(new RegExp('^' + sessionNameFor(REPO) + '-\\d+$'))
  })

  it('passes the computed runId down into runQueueOnce (→ --once)', async () => {
    let seenRunId
    const deps = baseDeps({
      runQueueOnce: async ({ runId }) => {
        seenRunId = runId
        return { successes: [], failures: [] }
      },
      readFile: () => issuesJsonl([
        { issue_number: 101, verdict: 'pass', ts: NOW_MS, run_id: expectedRunId },
      ]),
    })
    deps.exec = makeExec({ ...baseHandlers(), ...queueHandler(1) })
    await cycleCommand(deps)
    expect(seenRunId).toBe(expectedRunId)
  })

  it('status=success when every in-window event passed', async () => {
    const deps = baseDeps({
      readFile: () => issuesJsonl([
        { issue_number: 101, verdict: 'pass', ts: NOW_MS },
        { issue_number: 102, verdict: 'pass', ts: NOW_MS },
      ]),
    })
    deps.exec = makeExec({ ...baseHandlers(), ...queueHandler(2) })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('success')
    expect(result.successes).toEqual([101, 102])
    expect(result.failures).toEqual([])
  })

  it('status=failed when only failures/unknowns are in window (crash-only cycle)', async () => {
    const deps = baseDeps({
      readFile: () => issuesJsonl([
        { issue_number: 101, verdict: 'unknown', ts: NOW_MS },
        { issue_number: 102, verdict: 'fail', ts: NOW_MS },
      ]),
    })
    deps.exec = makeExec({ ...baseHandlers(), ...queueHandler(2) })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('failed')
    expect(result.failures).toEqual([101, 102])
    expect(deps.pingFail.calls.length).toBe(1)
    expect(deps.pingSuccess.calls.length).toBe(0)
  })

  it('reports 0/0 success when the metrics file is unreadable (degrades gracefully)', async () => {
    const deps = baseDeps({
      readFile: () => { throw new Error('ENOENT') },
    })
    deps.exec = makeExec({ ...baseHandlers(), ...queueHandler(1) })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('success')
    expect(result.processed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#532): the append-only file accumulates history across runs.
// These probe that `since` strictly fences this run from prior ones — the most
// important defect class (double-counting an append-only log).
// ---------------------------------------------------------------------------
describe('QA: cycleCommand — cross-run accumulation is fenced by `since`', () => {
  function readEvent(stdout) {
    const text = stdout.output()
    const idx = text.indexOf('RALPH_CYCLE_EVENT ')
    if (idx === -1) return null
    const lineEnd = text.indexOf('\n', idx)
    const line = text.slice(idx, lineEnd === -1 ? text.length : lineEnd)
    return JSON.parse(line.slice('RALPH_CYCLE_EVENT '.length).trim())
  }

  const queueHandler = (n) => ({
    'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length': {
      exitCode: 0,
      stdout: String(n),
      stderr: '',
    },
  })

  const expectedRunId = sessionNameFor(REPO) + '-' + Math.floor(NOW_MS / 1000)

  it('counts ONLY this run, ignoring a fat history of multiple prior runs', async () => {
    // A realistic append-only file: three prior runs (well before `start`)
    // plus this run's two events. Only the latter two may be counted.
    const deps = baseDeps({
      readFile: () => issuesJsonl([
        // --- prior run A (1 hour ago) ---
        { issue_number: 1, verdict: 'pass', ts: NOW_MS - 3600000, run_id: 'run-A' },
        { issue_number: 2, verdict: 'fail', ts: NOW_MS - 3600000, run_id: 'run-A' },
        // --- prior run B (10 min ago) ---
        { issue_number: 3, verdict: 'pass', ts: NOW_MS - 600000, run_id: 'run-B' },
        { issue_number: 4, verdict: 'unknown', ts: NOW_MS - 600000, run_id: 'run-B' },
        // --- prior run C: exactly 1ms before start → must be EXCLUDED ---
        { issue_number: 5, verdict: 'pass', ts: NOW_MS - 1, run_id: 'run-C' },
        // --- THIS run (ts === start) ---
        { issue_number: 101, verdict: 'pass', ts: NOW_MS, run_id: expectedRunId },
        { issue_number: 102, verdict: 'fail', ts: NOW_MS, run_id: expectedRunId },
      ]),
    })
    deps.exec = makeExec({ ...baseHandlers(), ...queueHandler(2) })
    const result = await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    // Only this run's two events: 1 pass + 1 fail. Prior 5 events ignored.
    expect(event.ok).toBe(1)
    expect(event.failed).toBe(1)
    expect(event.processed).toBe(2)
    expect(event.status).toBe('partial')
    expect(result.successes).toEqual([101])
    expect(result.failures).toEqual([102])
    // The fenced-out #5 (ts = start - 1) must not leak in.
    expect(result.successes).not.toContain(5)
  })

  it('releases the lock even when the metrics file read throws (ENOENT)', async () => {
    let released = false
    const deps = baseDeps({
      releaseLock: () => { released = true },
      readFile: () => { throw new Error('ENOENT') },
    })
    deps.exec = makeExec({ ...baseHandlers(), ...queueHandler(1) })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('success')
    expect(result.processed).toBe(0)
    expect(released).toBe(true)
  })

  it('run_id round-trips: emitted run_id === runId passed to runQueueOnce === in-window events run_id', async () => {
    let seenRunId
    const inWindow = [
      { issue_number: 101, verdict: 'pass', ts: NOW_MS, run_id: expectedRunId },
      { issue_number: 102, verdict: 'fail', ts: NOW_MS, run_id: expectedRunId },
    ]
    const deps = baseDeps({
      runQueueOnce: async ({ runId }) => {
        seenRunId = runId
        return { successes: [], failures: [] }
      },
      readFile: () => issuesJsonl(inWindow),
    })
    deps.exec = makeExec({ ...baseHandlers(), ...queueHandler(2) })
    await cycleCommand(deps)
    const event = readEvent(deps.stdout)
    // All three must be the same identifier.
    expect(seenRunId).toBe(expectedRunId)
    expect(event.run_id).toBe(seenRunId)
    expect(inWindow.every((e) => e.run_id === event.run_id)).toBe(true)
  })
})
