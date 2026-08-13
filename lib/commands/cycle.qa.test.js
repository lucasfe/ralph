import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { cycleCommand } from './cycle.js'
import { sessionNameFor } from '../lock.js'
import { templatePath } from '../paths.js'

// #6 QA augmentation — cycle.js emits several translated status lines and the
// end-of-run summary. The dev's cycle.test.js proves the happy-path text; these
// probe that (a) each translated line still carries its INTERPOLATED dynamic
// values (a translation that dropped ${reason}/${pid}/${count} is a real bug),
// and (b) the English summary shape stays byte-for-byte consistent with the one
// templates/ralph.sh prints, since cycle aggregates the loop's output.

const REPO = '/repo'
const REPO_SLUG = 'lucasfe/agenthub'
const SESSION = sessionNameFor(REPO)
const NOW_MS = Date.parse('2026-04-29T00:30:00.000Z')

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
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec: makeExec(baseHandlers()),
    exists: () => true,
    loadEnv: () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' }),
    acquireLock: () => ({ acquired: true, holder: { pid: 1, startedAt: '2026-04-29T00:00:00.000Z', repoPath: REPO } }),
    releaseLock: () => {},
    findOrphans: async () => [],
    cleanupOrphans: async () => [],
    sendWa,
    pingSuccess: async () => ({ ok: true }),
    pingFail: async () => ({ ok: true }),
    runQueueOnce: async () => ({ successes: [], failures: [] }),
    readFile: () => '',
    now: () => NOW_MS,
    processEnv: {},
    home: '/home/me',
    ...overrides,
  }
}

const issuesJsonl = (events) =>
  events.map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e)).join('\n') + '\n'

describe('QA cycle — translated lines preserve their interpolated values (#6)', () => {
  it('preflight failure keeps ${reason} in stderr AND ${repoSlug}:${reason} in the notify', async () => {
    const deps = baseDeps({
      // gh not authenticated → preflight fails with that reason.
      exec: makeExec({ ...baseHandlers(), 'gh auth status': { exitCode: 1, stdout: '', stderr: '' } }),
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('preflight-failed')
    expect(deps.stderr.output()).toContain('ralph cycle: preflight failed (gh not authenticated).')
    const notice = deps.sendWa.messages.find((m) => /aborted in/i.test(m))
    expect(notice).toBeDefined()
    // repoSlug and reason must both survive the translation.
    expect(notice).toContain(REPO_SLUG)
    expect(notice).toContain('gh not authenticated')
    // No Portuguese fossils.
    expect(deps.stderr.output()).not.toMatch(/pr[ée]-checagem|abortado/)
  })

  it('lock-held keeps the holder PID and the age-in-minutes in both stdout and notify', async () => {
    const deps = baseDeps({
      acquireLock: () => ({
        acquired: false,
        holder: { pid: 4242, startedAt: '2026-04-29T00:05:00.000Z', repoPath: REPO },
      }),
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('lock-held')
    // 00:05 → 00:30 = 25 minutes.
    expect(deps.stdout.output()).toContain(
      'another instance is already running (PID 4242). Skipping.',
    )
    const notice = deps.sendWa.messages.find((m) => /skipped in/i.test(m))
    expect(notice).toContain('25min')
    expect(notice).toContain('PID 4242')
    expect(deps.stdout.output()).not.toMatch(/rodando|Pulando/i)
  })

  it('orphan cleanup keeps the count and the #-prefixed id list', async () => {
    const deps = baseDeps({
      findOrphans: async () => [12, 34],
      cleanupOrphans: async () => [12, 34],
      // Queue empty afterwards so the run stops right after the cleanup line.
      exec: makeExec({
        ...baseHandlers(),
        'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '0', stderr: '' },
      }),
    })
    await cycleCommand(deps)
    expect(deps.stdout.output()).toContain('ralph cycle: cleaned 2 orphan(s): #12 #34')
    const notice = deps.sendWa.messages.find((m) => /cleaned 2 orphans/i.test(m))
    expect(notice).toContain(REPO_SLUG)
    expect(notice).toContain('#12 #34')
  })

  it('queue-count line keeps ${queueCount} and ${repoSlug}', async () => {
    const deps = baseDeps({
      exec: makeExec({
        ...baseHandlers(),
        'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '7', stderr: '' },
      }),
      readFile: () => '',
    })
    await cycleCommand(deps)
    expect(deps.stdout.output()).toContain(`ralph cycle: 7 issue(s) in the queue in ${REPO_SLUG}.`)
  })
})

describe('QA cycle — English summary shape and parity with templates/ralph.sh (#6)', () => {
  it('summary interpolates the real ok/failed counts in the "Ralph finished:" shape', async () => {
    const deps = baseDeps({
      exec: makeExec({
        ...baseHandlers(),
        'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '3', stderr: '' },
      }),
      readFile: () =>
        issuesJsonl([
          { ts: NOW_MS, verdict: 'pass', issue_number: 1 },
          { ts: NOW_MS, verdict: 'pass', issue_number: 2 },
          { ts: NOW_MS, verdict: 'fail', issue_number: 9 },
        ]),
    })
    await cycleCommand(deps)
    const summary = deps.sendWa.messages.find((m) => /Ralph finished:/.test(m))
    expect(summary).toBeDefined()
    expect(summary).toMatch(/^Ralph finished: 2 ok, 1 failed, \d+min\. OK: #1 #2\| FAIL: #9$/)
    // No Portuguese remnants in the summary.
    expect(summary).not.toMatch(/finalizado|falharam/)
  })

  it('cycle.js and templates/ralph.sh emit the identical English summary skeleton', () => {
    // Both must print "Ralph finished: N ok, M failed, ...min. OK: ...| FAIL: ..."
    const cycleSrc = readFileSync(new URL('./cycle.js', import.meta.url), 'utf8')
    const loopSrc = readFileSync(templatePath('ralph.sh'), 'utf8')
    expect(cycleSrc).toContain('Ralph finished: ${okCount} ok, ${failedCount} failed')
    expect(loopSrc).toContain('Ralph finished: ${ok_count} ok, ${fail_count} failed')
    // Neither may still carry the old Portuguese summary.
    expect(cycleSrc).not.toMatch(/finalizado|falharam/)
    expect(loopSrc).not.toMatch(/finalizado|falharam/)
  })
})
