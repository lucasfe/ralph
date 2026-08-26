import { describe, it, expect } from 'vitest'
import { formatSummary, summarizeLast24h } from './heartbeat.js'

// #52 QA augmentation — ABORTED_STATUSES, now that 'updated' has joined it.
//
// ./heartbeat.test.js proves the happy path: an update-and-stop line counts as an
// abort and contributes no duration. This file pins the EDGES of that membership,
// because the daily rollup is the only place a user ever sees what the schedule did,
// and a mis-classified status is a silently wrong number rather than a visible fault:
//
//   - PARITY: 'updated' behaves identically to the three statuses that predate it,
//     asserted off one table so a status added to the set with different arithmetic
//     cannot pass. The complement table pins which statuses DO contribute a duration
//     — including 'queue-empty', which is a cycle that ran and found nothing, not an
//     abort.
//   - THE TRIPWIRE: the set is exact-match on a string, so 'Updated', ' updated' and
//     'update' are ordinary cycles. If lib/commands/cycle.js ever emits a differently
//     spelled status, the rollup silently averages a zero-minute cycle into the day's
//     durations instead of reporting an abort — these tests are what fails first.
//   - THE COUPLING, PINNED NOT ENDORSED: `ok`/`failed` are summed BEFORE the abort
//     check, so an abort line carrying counters still moves the day's issue totals.
//     Harmless today only because cycle.js zeroes them on every abort path (proven in
//     lib/commands/cycle.update-prompt.qa.test.js); pinned here so the dependency is
//     visible from this side too.
//   - THE INVARIANT the summary is supposed to satisfy on a mixed day, and what the
//     user-facing line reads like on a day that was nothing but updates.
//
// Everything runs on an injected in-memory fs and an injected clock; nothing reads a
// real log directory.

const LOG_DIR = '/repo/logs'
const LOG = `${LOG_DIR}/ralph-cycle.out.log`
const ROTATED = `${LOG_DIR}/ralph-cycle.out.log.1`
const NOW = Date.parse('2026-08-22T12:00:00Z')
const HOUR = 60 * 60 * 1000
const clock = () => NOW
const ago = (ms) => new Date(NOW - ms).toISOString()

function makeFs(files = {}) {
  return {
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`)
        err.code = 'ENOENT'
        throw err
      }
      return files[p]
    },
    readdirSync: (p) => {
      const prefix = p.endsWith('/') ? p : `${p}/`
      return Object.keys(files)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length).split('/')[0])
        .sort()
    },
  }
}

// The exact line lib/commands/cycle.js writes: `RALPH_CYCLE_EVENT ` followed by the
// JSON payload, one per line.
const line = ({ ts, status = 'success', ok = 0, failed = 0, durationMin = 0, processed = ok + failed, ...rest }) =>
  `RALPH_CYCLE_EVENT ${JSON.stringify({ ts, status, ok, failed, durationMin, processed, ...rest })}`

const summarize = (lines, files = {}) =>
  summarizeLast24h({
    logDir: LOG_DIR,
    fs: makeFs({ [LOG]: lines.join('\n') + '\n', ...files }),
    clock,
  })

// What `ralph cycle` really emits for an accepted install: zeroed counters, no
// run_id, status 'updated'.
const UPDATED = { ts: ago(HOUR), status: 'updated', ok: 0, failed: 0, durationMin: 0, processed: 0 }

describe('QA heartbeat #52 — `updated` is a full member of the abort family', () => {
  for (const status of ['preflight-failed', 'lock-held', 'tmux-active', 'updated']) {
    it(`counts a lone ${status} run as one cycle, one abort, no duration`, () => {
      const summary = summarize([line({ ts: ago(HOUR), status })])
      expect(summary).toEqual({
        cycles: 1,
        totalIssues: 0,
        ok: 0,
        failed: 0,
        abortedCycles: 1,
        durations: [],
        lastCycle: {
          ts: ago(HOUR),
          status,
          ok: 0,
          failed: 0,
          durationMin: 0,
          processed: 0,
        },
      })
    })
  }

  it('treats a day of one update per abort status identically — four aborts, no durations', () => {
    const summary = summarize([
      line({ ts: ago(4 * HOUR), status: 'preflight-failed' }),
      line({ ts: ago(3 * HOUR), status: 'lock-held' }),
      line({ ts: ago(2 * HOUR), status: 'tmux-active' }),
      line({ ts: ago(HOUR), status: 'updated' }),
    ])
    expect(summary.cycles).toBe(4)
    expect(summary.abortedCycles).toBe(4)
    expect(summary.durations).toEqual([])
  })

  for (const [status, durationMin] of [
    ['success', 12],
    ['partial', 7],
    ['failed', 3],
    // Not an abort: a queue-empty run really did run and really did find nothing, so
    // its duration belongs in the day's spread. Pinned as the boundary of the family
    // 'updated' just joined.
    ['queue-empty', 0],
  ]) {
    it(`still records a duration for a ${status} run`, () => {
      const summary = summarize([line({ ts: ago(HOUR), status, durationMin })])
      expect(summary.abortedCycles).toBe(0)
      expect(summary.durations).toEqual([durationMin])
    })
  }

  it('keeps cycles − abortedCycles equal to the number of durations on a mixed day', () => {
    const summary = summarize([
      line({ ts: ago(9 * HOUR), status: 'success', ok: 2, durationMin: 11 }),
      line({ ts: ago(8 * HOUR), status: 'updated' }),
      line({ ts: ago(7 * HOUR), status: 'queue-empty' }),
      line({ ts: ago(6 * HOUR), status: 'lock-held' }),
      line({ ts: ago(5 * HOUR), status: 'partial', ok: 1, failed: 1, durationMin: 20 }),
      line({ ts: ago(4 * HOUR), status: 'tmux-active' }),
      line({ ts: ago(3 * HOUR), status: 'failed', failed: 1, durationMin: 4 }),
      line({ ts: ago(2 * HOUR), status: 'updated' }),
    ])
    expect(summary.cycles).toBe(8)
    expect(summary.abortedCycles).toBe(4)
    expect(summary.durations).toEqual([11, 0, 20, 4])
    expect(summary.cycles - summary.abortedCycles).toBe(summary.durations.length)
    expect(summary.totalIssues).toBe(5)
  })
})

describe('QA heartbeat #52 — the membership test is exact, which makes it a tripwire', () => {
  for (const status of ['Updated', 'UPDATED', ' updated', 'updated ', 'update', 'updated\t', 'up-dated']) {
    it(`does NOT treat ${JSON.stringify(status)} as an abort (pinned, not endorsed)`, () => {
      // The set is a plain Set of strings, so anything but the exact token is an
      // ordinary cycle whose zero duration is averaged into the day. Nothing here
      // asks for fuzzy matching — the point is that the emitted string in
      // lib/commands/cycle.js and the token in lib/heartbeat.js are ONE contract, and
      // this is the test that fails if they ever drift apart.
      const summary = summarize([line({ ts: ago(HOUR), status })])
      expect(summary.cycles).toBe(1)
      expect(summary.abortedCycles).toBe(0)
      expect(summary.durations).toEqual([0])
    })
  }

  for (const [label, status] of [
    ['a missing status', undefined],
    ['a null status', null],
    ['a numeric status', 0],
    ['an object that stringifies to `updated`', { toString: 'updated' }],
    ['an array containing the token', ['updated']],
  ]) {
    it(`does not treat ${label} as an abort`, () => {
      const summary = summarize([line({ ts: ago(HOUR), status })])
      expect(summary.cycles).toBe(1)
      expect(summary.abortedCycles).toBe(0)
    })
  }

  it('is not fooled by the update announcement itself, which is prose, not an event', () => {
    // The `✅ Updated to …` line #52 prints sits in the same launchd log as the event
    // stream, and it must contribute nothing: no tag, no cycle.
    const summary = summarize([
      '✅ Updated to 0.2.0 — run `ralph cycle` again.',
      '⚠️  Update did not complete — continuing this cycle on 0.1.0.',
      line({ ts: ago(HOUR), status: 'success', ok: 1, durationMin: 5 }),
    ])
    expect(summary.cycles).toBe(1)
    expect(summary.abortedCycles).toBe(0)
    expect(summary.ok).toBe(1)
  })

  it('loses a whole event to anything appended after the payload (pinned, not endorsed)', () => {
    // parseEventLine JSON-parses EVERYTHING after the tag, so a single trailing
    // character drops the cycle rather than degrading it. That is why the event has to
    // be written as one line of its own — which lib/commands/cycle.js does, asserted
    // from the writing side in lib/commands/cycle.update-prompt.qa.test.js.
    const summary = summarize([line({ ...UPDATED }) + '   # trailing note'])
    expect(summary.cycles).toBe(0)
    expect(summary.abortedCycles).toBe(0)
  })
})

describe('QA heartbeat #52 — what an abort line’s own numbers still do', () => {
  it('sums ok/failed off an `updated` line even though it is an abort (pinned, not endorsed)', () => {
    // `ok += toInt(event.ok)` runs BEFORE the abort check, so counters on an abort
    // line move the day's issue totals. Unreachable through lib/commands/cycle.js,
    // which emits `ok: 0, failed: 0` on the updated path (asserted in
    // lib/commands/cycle.update-prompt.qa.test.js) — pinned here so that guarantee is
    // known to be load-bearing rather than incidental, and shared with the three
    // statuses that predate 'updated'.
    const summary = summarize([line({ ts: ago(HOUR), status: 'updated', ok: 5, failed: 2, processed: 7 })])
    expect(summary.abortedCycles).toBe(1)
    expect(summary.durations).toEqual([])
    expect({ ok: summary.ok, failed: summary.failed, totalIssues: summary.totalIssues }).toEqual({
      ok: 5,
      failed: 2,
      totalIssues: 7,
    })
  })

  for (const durationMin of [9, 0.5, -3, 1e9, Number.NaN, null, 'ten']) {
    it(`ignores durationMin ${JSON.stringify(durationMin)} on an updated line`, () => {
      const summary = summarize([line({ ts: ago(HOUR), status: 'updated', durationMin })])
      expect(summary.durations).toEqual([])
      expect(summary.abortedCycles).toBe(1)
    })
  }

  it('reports the update as the last cycle when it is the most recent event', () => {
    const summary = summarize([
      line({ ts: ago(2 * HOUR), status: 'success', ok: 3, durationMin: 8 }),
      line({ ...UPDATED }),
    ])
    expect(summary.lastCycle.status).toBe('updated')
    expect(summary.lastCycle.durationMin).toBe(0)
    expect(summary.lastCycle.ts).toBe(ago(HOUR))
    expect(summary.ok).toBe(3)
  })

  it('sorts by timestamp, not by file order, when an update was logged out of order', () => {
    const summary = summarize([line({ ...UPDATED }), line({ ts: ago(10 * 60_000), status: 'success', ok: 1, durationMin: 2 })])
    expect(summary.lastCycle.status).toBe('success')
    expect(summary.cycles).toBe(2)
    expect(summary.abortedCycles).toBe(1)
  })

  it('drops an update older than 24h and keeps one inside the window', () => {
    const summary = summarize([
      line({ ts: ago(25 * HOUR), status: 'updated' }),
      line({ ts: ago(23 * HOUR), status: 'updated' }),
    ])
    expect(summary.cycles).toBe(1)
    expect(summary.abortedCycles).toBe(1)
  })

  it('counts an update found in a ROTATED log file', () => {
    const summary = summarize([line({ ts: ago(HOUR), status: 'success', ok: 1, durationMin: 3 })], {
      [ROTATED]: line({ ts: ago(2 * HOUR), status: 'updated' }) + '\n',
    })
    expect(summary.cycles).toBe(2)
    expect(summary.abortedCycles).toBe(1)
    expect(summary.durations).toEqual([3])
  })
})

describe('QA heartbeat #52 — the line the user actually receives', () => {
  it('reads as N cycles with zero issues and no warning flag on an all-updates day', () => {
    const summary = summarize([
      line({ ts: ago(3 * HOUR), status: 'updated' }),
      line({ ts: ago(2 * HOUR), status: 'updated' }),
      line({ ...UPDATED }),
    ])
    expect(summary).toMatchObject({ cycles: 3, abortedCycles: 3, totalIssues: 0, durations: [] })
    // No ⚠️: that flag means "issues were attempted and all of them failed", which is
    // not what an update-and-stop day is.
    expect(formatSummary(summary, { repoSlug: 'lucasfe/ralph' })).toBe(
      '📊 Ralph 24h | 3 cycles, 0 issues (0 ok, 0 fail) | lucasfe/ralph',
    )
  })

  it('still counts the update in the user-facing cycle total (pinned, not endorsed)', () => {
    // formatSummary reads `cycles`, never `abortedCycles`, so the daily WhatsApp line
    // makes no distinction between a drain and an abort — the same treatment
    // lock-held and tmux-active have always had. Pinned because it is the visible
    // consequence of the classification, and because a future "3 cycles (1 aborted)"
    // wording should be a deliberate change, not a surprise.
    const summary = summarize([
      line({ ts: ago(2 * HOUR), status: 'success', ok: 4, durationMin: 15 }),
      line({ ...UPDATED }),
    ])
    expect(formatSummary(summary, { repoSlug: 'lucasfe/ralph', nextTick: 'today 20:00' })).toBe(
      '📊 Ralph 24h | 2 cycles, 4 issues (4 ok, 0 fail) | lucasfe/ralph | next today 20:00',
    )
  })

  it('keeps the ⚠️ flag reserved for real failures, even next to an update', () => {
    const summary = summarize([
      line({ ts: ago(2 * HOUR), status: 'failed', failed: 2, durationMin: 6 }),
      line({ ...UPDATED }),
    ])
    expect(formatSummary(summary, { repoSlug: 'lucasfe/ralph' })).toBe(
      '📊 Ralph 24h | 2 cycles, 2 issues (0 ok, 2 fail) ⚠️ | lucasfe/ralph',
    )
  })
})
