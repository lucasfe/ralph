import { describe, it, expect } from 'vitest'
import { cleanupOrphans, findOrphans } from './orphan-cleanup.js'

const REPO = '/Users/me/repos/agenthub'

// The exact argv findOrphans must issue. `--state all` (not `--state open`) is
// load-bearing for #40: an issue closed by a merged PR can still carry
// claude-working, and a sweep scoped to open issues can never see it — which is
// why the existing backlog had to be cleaned by hand. `--limit 100` only raises
// gh's default 30-item page; it is not a guarantee (see the truncation test at
// the bottom of this file for the bound it actually gives).
const LIST_KEY =
  'gh issue list --state all --label claude-working --limit 100 --json number,title,updatedAt'

function makeExec(handlers = {}) {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, options })
    if (handlers[key]) {
      const v = handlers[key]
      return typeof v === 'function' ? v({ cmd, args, options }) : v
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

function makeLog() {
  const messages = []
  const log = (...args) => {
    messages.push(args.join(' '))
  }
  log.messages = messages
  return log
}

describe('findOrphans', () => {
  it('returns [] when gh returns an empty array', async () => {
    const exec = makeExec({
      [LIST_KEY]: {
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
    })
    const result = await findOrphans({ exec, repoPath: REPO })
    expect(result).toEqual([])
  })

  it('returns the slim shape for each orphan when gh returns issues', async () => {
    const stdout = JSON.stringify([
      { number: 12, title: 'first', updatedAt: '2026-04-29T00:00:00Z' },
      { number: 34, title: 'second', updatedAt: '2026-04-29T01:00:00Z' },
    ])
    const exec = makeExec({
      [LIST_KEY]: {
        exitCode: 0,
        stdout,
        stderr: '',
      },
    })
    const result = await findOrphans({ exec, repoPath: REPO })
    expect(result).toEqual([
      { number: 12, title: 'first', updatedAt: '2026-04-29T00:00:00Z' },
      { number: 34, title: 'second', updatedAt: '2026-04-29T01:00:00Z' },
    ])
  })

  it('runs gh in the supplied repoPath', async () => {
    const exec = makeExec({
      [LIST_KEY]: {
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      },
    })
    await findOrphans({ exec, repoPath: REPO })
    const ghCall = exec.calls.find((c) => c.cmd === 'gh')
    expect(ghCall).toBeDefined()
    expect(ghCall.options.cwd).toBe(REPO)
  })

  it('returns [] when gh exits non-zero', async () => {
    const log = makeLog()
    const exec = makeExec({
      [LIST_KEY]: {
        exitCode: 1,
        stdout: '',
        stderr: 'gh: not authenticated',
      },
    })
    const result = await findOrphans({ exec, repoPath: REPO, log })
    expect(result).toEqual([])
    expect(log.messages.join('\n')).toMatch(/not authenticated|gh|orphan/i)
  })

  it('returns [] when gh stdout is invalid JSON', async () => {
    const log = makeLog()
    const exec = makeExec({
      [LIST_KEY]: {
        exitCode: 0,
        stdout: 'not json {{',
        stderr: '',
      },
    })
    const result = await findOrphans({ exec, repoPath: REPO, log })
    expect(result).toEqual([])
  })

  it('returns [] when exec throws', async () => {
    const log = makeLog()
    const exec = async () => {
      throw new Error('boom')
    }
    const result = await findOrphans({ exec, repoPath: REPO, log })
    expect(result).toEqual([])
    expect(log.messages.join('\n')).toMatch(/boom/)
  })
})

describe('cleanupOrphans', () => {
  it('is a no-op when orphans is empty (returns [])', async () => {
    const exec = makeExec()
    const result = await cleanupOrphans({ exec, orphans: [] })
    expect(result).toEqual([])
    expect(exec.calls).toEqual([])
  })

  it('is a no-op when orphans is missing/undefined', async () => {
    const exec = makeExec()
    const result = await cleanupOrphans({ exec })
    expect(result).toEqual([])
    expect(exec.calls).toEqual([])
  })

  it('removes the claude-working label from each orphan and returns the cleared numbers', async () => {
    const exec = makeExec({
      'gh issue edit 12 --remove-label claude-working': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue edit 34 --remove-label claude-working': { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await cleanupOrphans({
      exec,
      orphans: [
        { number: 12, title: 'first' },
        { number: 34, title: 'second' },
      ],
    })
    expect(result).toEqual([12, 34])
    expect(exec.calls.map((c) => c.key)).toEqual([
      'gh issue edit 12 --remove-label claude-working',
      'gh issue edit 34 --remove-label claude-working',
    ])
  })

  it('swallows gh errors (non-zero exit) and continues with the remaining orphans', async () => {
    const log = makeLog()
    const exec = makeExec({
      'gh issue edit 12 --remove-label claude-working': {
        exitCode: 1,
        stdout: '',
        stderr: 'label not found',
      },
      'gh issue edit 34 --remove-label claude-working': { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await cleanupOrphans({
      exec,
      orphans: [
        { number: 12, title: 'first' },
        { number: 34, title: 'second' },
      ],
      log,
    })
    expect(result).toEqual([34])
    expect(log.messages.join('\n')).toMatch(/12/)
  })

  it('swallows thrown errors from exec and continues with the remaining orphans', async () => {
    const log = makeLog()
    let calls = 0
    const exec = async (cmd, args) => {
      calls++
      if (args.includes('12')) throw new Error('exec blew up')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const result = await cleanupOrphans({
      exec,
      orphans: [
        { number: 12, title: 'first' },
        { number: 34, title: 'second' },
      ],
      log,
    })
    expect(result).toEqual([34])
    expect(calls).toBe(2)
    expect(log.messages.join('\n')).toMatch(/exec blew up/)
  })

  it('is idempotent — calling twice on already-cleared issues still returns the cleared numbers', async () => {
    const exec = makeExec({
      'gh issue edit 12 --remove-label claude-working': { exitCode: 0, stdout: '', stderr: '' },
    })
    const orphans = [{ number: 12, title: 'first' }]
    const first = await cleanupOrphans({ exec, orphans })
    const second = await cleanupOrphans({ exec, orphans })
    expect(first).toEqual([12])
    expect(second).toEqual([12])
  })
})

// ---------------------------------------------------------------------------
// Issue #40 — the sweep must also repair CLOSED issues. When a merged PR closes
// an issue with `Closes #N`, neither of the agent's label-removal paths runs, so
// claude-working survives on a successfully resolved (CLOSED) issue. A sweep
// scoped to `--state open` cannot see those, so the backlog can only grow.
// ---------------------------------------------------------------------------
describe('findOrphans — CLOSED issues holding claude-working (#40)', () => {
  it('lists issues in ANY state, so a CLOSED issue holding the label is visible', async () => {
    const exec = makeExec()
    await findOrphans({ exec, repoPath: REPO })
    const ghCall = exec.calls.find((c) => c.cmd === 'gh')
    expect(ghCall).toBeDefined()
    // `--state all` covers open + closed; the old `--state open` made every
    // closed orphan invisible to the sweep.
    const stateIdx = ghCall.args.indexOf('--state')
    expect(stateIdx).toBeGreaterThanOrEqual(0)
    expect(ghCall.args[stateIdx + 1]).toBe('all')
    expect(ghCall.args.join(' ')).not.toContain('--state open')
    // Still scoped to the label — the sweep never touches unlabelled issues.
    expect(ghCall.args).toContain('--label')
    expect(ghCall.args).toContain('claude-working')
  })

  it('returns a CLOSED orphan and cleanupOrphans clears it (backlog repaired, not just prevented)', async () => {
    const stdout = JSON.stringify([
      { number: 22, title: 'closed by a merged PR', updatedAt: '2026-08-01T00:00:00Z' },
      { number: 27, title: 'also closed', updatedAt: '2026-08-02T00:00:00Z' },
    ])
    const exec = makeExec({ [LIST_KEY]: { exitCode: 0, stdout, stderr: '' } })

    const orphans = await findOrphans({ exec, repoPath: REPO })
    expect(orphans.map((o) => o.number)).toEqual([22, 27])

    const cleared = await cleanupOrphans({ exec, orphans })
    expect(cleared).toEqual([22, 27])
    expect(exec.calls.map((c) => c.key)).toEqual([
      LIST_KEY,
      'gh issue edit 22 --remove-label claude-working',
      'gh issue edit 27 --remove-label claude-working',
    ])
  })

  it('keeps its behavior for OPEN orphans unchanged (they are still found and cleared)', async () => {
    const stdout = JSON.stringify([
      { number: 12, title: 'genuinely orphaned open issue', updatedAt: '2026-04-29T00:00:00Z' },
    ])
    const exec = makeExec({ [LIST_KEY]: { exitCode: 0, stdout, stderr: '' } })

    const orphans = await findOrphans({ exec, repoPath: REPO })
    expect(orphans).toEqual([
      { number: 12, title: 'genuinely orphaned open issue', updatedAt: '2026-04-29T00:00:00Z' },
    ])
    expect(await cleanupOrphans({ exec, orphans })).toEqual([12])
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#40) — adversarial paths for the widened sweep. Reuses the
// LIST_KEY/makeExec/makeLog fakes above.
// ---------------------------------------------------------------------------
describe('QA: findOrphans — adversarial payloads (#40)', () => {
  it('returns a MIXED open+closed page verbatim and in page order (state filtering is gh\'s job, not ours)', async () => {
    // gh's `--json number,title,updatedAt` carries no state field, so the sweep
    // is deliberately state-blind: whatever gh returns for `--state all --label
    // claude-working` is by definition an orphan. Pin that no client-side state
    // inference sneaks in and that page order is preserved (cleanupOrphans
    // clears in this order).
    const page = [
      { number: 91, title: 'closed by merged PR', updatedAt: '2026-08-20T00:00:00Z' },
      { number: 7, title: 'open + genuinely stuck', updatedAt: '2026-08-19T00:00:00Z' },
      { number: 55, title: 'closed manually', updatedAt: '2026-08-18T00:00:00Z' },
    ]
    const exec = makeExec({ [LIST_KEY]: { exitCode: 0, stdout: JSON.stringify(page), stderr: '' } })

    const orphans = await findOrphans({ exec, repoPath: REPO })
    expect(orphans.map((o) => o.number)).toEqual([91, 7, 55])
    expect(await cleanupOrphans({ exec, orphans })).toEqual([91, 7, 55])
  })

  it('slims every item to exactly {number,title,updatedAt} (shape contract cycle.js depends on)', async () => {
    const page = [
      {
        number: 12,
        title: 'first',
        updatedAt: '2026-04-29T00:00:00Z',
        state: 'CLOSED',
        labels: [{ name: 'claude-working' }],
        body: 'x'.repeat(50),
      },
    ]
    const exec = makeExec({ [LIST_KEY]: { exitCode: 0, stdout: JSON.stringify(page), stderr: '' } })

    const orphans = await findOrphans({ exec, repoPath: REPO })
    expect(Object.keys(orphans[0]).sort()).toEqual(['number', 'title', 'updatedAt'])
  })

  it('drops malformed items (null, missing number, string number, nested) and keeps the valid ones', async () => {
    const page = [
      null,
      { title: 'no number at all', updatedAt: '2026-08-01T00:00:00Z' },
      { number: '34', title: 'number as a string' },
      { number: null, title: 'null number' },
      { number: { n: 5 }, title: 'nested number' },
      { number: 12, title: 'valid', updatedAt: '2026-08-02T00:00:00Z' },
      'not an object',
      42,
    ]
    const exec = makeExec({ [LIST_KEY]: { exitCode: 0, stdout: JSON.stringify(page), stderr: '' } })

    const orphans = await findOrphans({ exec, repoPath: REPO })
    expect(orphans).toEqual([{ number: 12, title: 'valid', updatedAt: '2026-08-02T00:00:00Z' }])
    // And nothing malformed reaches gh: exactly one edit, for the valid number.
    expect(await cleanupOrphans({ exec, orphans })).toEqual([12])
  })

  it.each([
    ['a JSON object', '{"number":12}'],
    ['JSON null', 'null'],
    ['a bare number', '7'],
    ['a JSON string', '"[]"'],
  ])('returns [] when gh stdout is %s instead of an array', async (_label, stdout) => {
    const exec = makeExec({ [LIST_KEY]: { exitCode: 0, stdout, stderr: '' } })
    expect(await findOrphans({ exec, repoPath: REPO })).toEqual([])
  })

  it('returns [] and logs when exec resolves undefined (no result object)', async () => {
    const log = makeLog()
    const exec = async () => undefined
    expect(await findOrphans({ exec, repoPath: REPO, log })).toEqual([])
    expect(log.messages.join('\n')).toMatch(/orphan-cleanup/)
  })

  it('returns [] when exec throws SYNCHRONOUSLY (not a rejected promise)', async () => {
    const log = makeLog()
    // A non-async exec that throws before returning a promise — `await exec(...)`
    // inside the try still catches it, but only because the call itself is in the
    // try block. Pin that.
    const exec = () => {
      throw new TypeError('exec is not configured')
    }
    expect(await findOrphans({ exec, repoPath: REPO, log })).toEqual([])
    expect(log.messages.join('\n')).toMatch(/exec is not configured/)
  })

  it('does no client-side truncation: a page bigger than --limit 100 is returned whole', async () => {
    // Defensive: findOrphans must not silently cap what gh handed back.
    const page = Array.from({ length: 150 }, (_, i) => ({
      number: i + 1,
      title: `orphan ${i + 1}`,
      updatedAt: '2026-08-01T00:00:00Z',
    }))
    const exec = makeExec({ [LIST_KEY]: { exitCode: 0, stdout: JSON.stringify(page), stderr: '' } })

    const orphans = await findOrphans({ exec, repoPath: REPO })
    expect(orphans.length).toBe(150)
    expect(orphans[149].number).toBe(150)
  })

  // -------------------------------------------------------------------------
  // The `--limit 100` bound, characterized honestly. `gh issue list` without a
  // `--search` orders by CREATED_AT DESC (newest first), so the page is filled
  // from the newest orphan backwards and the OLDEST orphans fall off the end.
  // The loop, by contrast, picks work with `sort:created-asc` — the OLDEST open
  // issue. So a long-lived OPEN orphan is exactly the item most likely to be
  // truncated away once >100 closed orphans exist, and `--limit 100` raises the
  // ceiling (from gh's default 30) without eliminating the failure mode. This
  // test documents the gap rather than asserting it away: there is no second
  // `--state open` pass and no state-aware handling to fall back on.
  // -------------------------------------------------------------------------
  it('makes exactly one list call — no second `--state open` pass compensates for truncation', async () => {
    // gh truncates server-side at 100; the open orphan (#3, the oldest) is the
    // 101st item and never appears in stdout.
    const page = Array.from({ length: 100 }, (_, i) => ({
      number: 1000 + i,
      title: `closed orphan ${i}`,
      updatedAt: '2026-08-01T00:00:00Z',
    }))
    const exec = makeExec({ [LIST_KEY]: { exitCode: 0, stdout: JSON.stringify(page), stderr: '' } })

    const orphans = await findOrphans({ exec, repoPath: REPO })
    expect(orphans.length).toBe(100)
    // Whatever gh truncated is simply lost: nothing in the implementation
    // compensates, because only ONE gh list call is ever made.
    expect(exec.calls.filter((c) => c.args[1] === 'list').length).toBe(1)
    expect(exec.calls[0].args.join(' ')).toContain('--limit 100')
  })
})

describe('QA: cleanupOrphans — adversarial (#40)', () => {
  it('partial success on a CLOSED backlog: the failing number is skipped, the rest still clear', async () => {
    // End-to-end through findOrphans so the CLOSED-backlog argv is exercised:
    // #91 clears, #7 fails (e.g. the label was already gone / a 403), #55 clears.
    const page = [
      { number: 91, title: 'closed by merged PR', updatedAt: '2026-08-20T00:00:00Z' },
      { number: 7, title: 'permission denied', updatedAt: '2026-08-19T00:00:00Z' },
      { number: 55, title: 'closed manually', updatedAt: '2026-08-18T00:00:00Z' },
    ]
    const log = makeLog()
    const exec = makeExec({
      [LIST_KEY]: { exitCode: 0, stdout: JSON.stringify(page), stderr: '' },
      'gh issue edit 7 --remove-label claude-working': {
        exitCode: 1,
        stdout: '',
        stderr: 'HTTP 403: Resource not accessible',
      },
    })

    const orphans = await findOrphans({ exec, repoPath: REPO })
    expect(await cleanupOrphans({ exec, orphans, log })).toEqual([91, 55])
    // All three were ATTEMPTED — one failure must not short-circuit the sweep.
    expect(exec.calls.map((c) => c.key)).toEqual([
      LIST_KEY,
      'gh issue edit 91 --remove-label claude-working',
      'gh issue edit 7 --remove-label claude-working',
      'gh issue edit 55 --remove-label claude-working',
    ])
    expect(log.messages.join('\n')).toMatch(/403|#7/)
  })

  it('a mid-list exec that throws SYNCHRONOUSLY still lets the remaining orphans clear', async () => {
    const log = makeLog()
    const calls = []
    const exec = (cmd, args) => {
      calls.push(args.join(' '))
      if (args.includes('7')) throw new Error('spawn gh ENOENT')
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }
    const cleared = await cleanupOrphans({
      exec,
      orphans: [{ number: 91 }, { number: 7 }, { number: 55 }],
      log,
    })
    expect(cleared).toEqual([91, 55])
    expect(calls.length).toBe(3)
    expect(log.messages.join('\n')).toMatch(/ENOENT/)
  })

  it('never calls gh for malformed orphan entries', async () => {
    const exec = makeExec()
    const cleared = await cleanupOrphans({
      exec,
      orphans: [null, { number: '12' }, { title: 'no number' }, { number: 12 }, undefined],
    })
    expect(cleared).toEqual([12])
    expect(exec.calls.map((c) => c.key)).toEqual(['gh issue edit 12 --remove-label claude-working'])
  })

  it('treats an undefined exec result as a failure (no false "cleared" report)', async () => {
    // A false positive here would make `ralph cycle` announce "cleaned 1 orphan"
    // for a label that is still on the issue.
    const log = makeLog()
    const exec = async () => undefined
    expect(await cleanupOrphans({ exec, orphans: [{ number: 12 }], log })).toEqual([])
    expect(log.messages.join('\n')).toMatch(/12/)
  })

  it('is a no-op when orphans is not an array (a bad findOrphans return cannot crash the cycle)', async () => {
    const exec = makeExec()
    expect(await cleanupOrphans({ exec, orphans: null })).toEqual([])
    expect(await cleanupOrphans({ exec, orphans: 'nope' })).toEqual([])
    expect(await cleanupOrphans({ exec, orphans: { number: 12 } })).toEqual([])
    expect(exec.calls).toEqual([])
  })
})
