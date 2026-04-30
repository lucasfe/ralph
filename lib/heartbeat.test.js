import { describe, it, expect } from 'vitest'
import { formatSummary, summarizeLast24h } from './heartbeat.js'

const LOG_DIR = '/repo/logs'
const NOW = Date.parse('2026-04-29T12:00:00Z')
const clock = () => NOW

function makeFs(files = {}) {
  const dirs = new Set()
  for (const path of Object.keys(files)) {
    let parent = path
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'))
      dirs.add(parent)
    }
  }
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p) || dirs.has(p),
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
      const entries = new Set()
      for (const k of Object.keys(files)) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length)
          const head = rest.split('/')[0]
          if (head) entries.add(head)
        }
      }
      return Array.from(entries).sort()
    },
  }
}

function eventLine({
  ts,
  status = 'success',
  ok = 0,
  failed = 0,
  durationMin = 0,
  processed = ok + failed,
}) {
  return `RALPH_CYCLE_EVENT ${JSON.stringify({
    ts,
    status,
    ok,
    failed,
    durationMin,
    processed,
  })}`
}

describe('summarizeLast24h', () => {
  it('returns zeros when log file is missing', () => {
    const fs = makeFs({})
    const result = summarizeLast24h({ logDir: LOG_DIR, fs, clock })
    expect(result).toEqual({
      cycles: 0,
      totalIssues: 0,
      ok: 0,
      failed: 0,
      abortedCycles: 0,
      durations: [],
      lastCycle: null,
    })
  })

  it('ignores noise lines and malformed RALPH_CYCLE_EVENT entries', () => {
    const lines = [
      'random log noise',
      'RALPH_CYCLE_EVENT not-json-at-all',
      'RALPH_CYCLE_EVENT { "ts": "broken json',
      eventLine({
        ts: '2026-04-28T20:00:00Z',
        status: 'success',
        ok: 2,
        failed: 0,
        durationMin: 5,
      }),
    ].join('\n')
    const fs = makeFs({ [`${LOG_DIR}/ralph-cycle.out.log`]: lines })
    const result = summarizeLast24h({ logDir: LOG_DIR, fs, clock })
    expect(result.cycles).toBe(1)
    expect(result.ok).toBe(2)
    expect(result.failed).toBe(0)
  })

  it('aggregates multiple cycles inside the 24h window', () => {
    const lines = [
      eventLine({
        ts: '2026-04-28T18:00:00Z',
        status: 'success',
        ok: 3,
        failed: 0,
        durationMin: 7,
      }),
      eventLine({
        ts: '2026-04-28T22:00:00Z',
        status: 'partial',
        ok: 2,
        failed: 1,
        durationMin: 12,
      }),
      eventLine({
        ts: '2026-04-29T06:00:00Z',
        status: 'failed',
        ok: 0,
        failed: 2,
        durationMin: 5,
      }),
    ].join('\n')
    const fs = makeFs({ [`${LOG_DIR}/ralph-cycle.out.log`]: lines })
    const result = summarizeLast24h({ logDir: LOG_DIR, fs, clock })
    expect(result.cycles).toBe(3)
    expect(result.ok).toBe(5)
    expect(result.failed).toBe(3)
    expect(result.totalIssues).toBe(8)
    expect(result.abortedCycles).toBe(0)
    expect(result.durations).toEqual([7, 12, 5])
    expect(result.lastCycle).toMatchObject({
      ts: '2026-04-29T06:00:00Z',
      status: 'failed',
      ok: 0,
      failed: 2,
    })
  })

  it('excludes cycles older than the 24h window', () => {
    const lines = [
      eventLine({
        ts: '2026-04-27T11:00:00Z',
        status: 'success',
        ok: 99,
        failed: 99,
        durationMin: 1,
      }),
      eventLine({
        ts: '2026-04-29T06:00:00Z',
        status: 'success',
        ok: 1,
        failed: 0,
        durationMin: 5,
      }),
    ].join('\n')
    const fs = makeFs({ [`${LOG_DIR}/ralph-cycle.out.log`]: lines })
    const result = summarizeLast24h({ logDir: LOG_DIR, fs, clock })
    expect(result.cycles).toBe(1)
    expect(result.ok).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.lastCycle.ts).toBe('2026-04-29T06:00:00Z')
  })

  it('counts aborted cycles separately and excludes them from durations', () => {
    const lines = [
      eventLine({
        ts: '2026-04-29T01:00:00Z',
        status: 'lock-held',
        ok: 0,
        failed: 0,
        durationMin: 0,
      }),
      eventLine({
        ts: '2026-04-29T02:00:00Z',
        status: 'preflight-failed',
        ok: 0,
        failed: 0,
        durationMin: 0,
      }),
      eventLine({
        ts: '2026-04-29T03:00:00Z',
        status: 'success',
        ok: 1,
        failed: 0,
        durationMin: 5,
      }),
    ].join('\n')
    const fs = makeFs({ [`${LOG_DIR}/ralph-cycle.out.log`]: lines })
    const result = summarizeLast24h({ logDir: LOG_DIR, fs, clock })
    expect(result.cycles).toBe(3)
    expect(result.abortedCycles).toBe(2)
    expect(result.durations).toEqual([5])
    expect(result.lastCycle.status).toBe('success')
  })

  it('reads rotated log copies in addition to the main log', () => {
    const linesMain = eventLine({
      ts: '2026-04-29T11:00:00Z',
      status: 'success',
      ok: 2,
      failed: 0,
      durationMin: 6,
    })
    const linesRotated = eventLine({
      ts: '2026-04-29T05:00:00Z',
      status: 'success',
      ok: 1,
      failed: 0,
      durationMin: 4,
    })
    const fs = makeFs({
      [`${LOG_DIR}/ralph-cycle.out.log`]: linesMain,
      [`${LOG_DIR}/ralph-cycle.out.log.1`]: linesRotated,
    })
    const result = summarizeLast24h({ logDir: LOG_DIR, fs, clock })
    expect(result.cycles).toBe(2)
    expect(result.ok).toBe(3)
    expect(result.lastCycle.ts).toBe('2026-04-29T11:00:00Z')
  })

  it('skips events with missing or unparseable timestamps', () => {
    const lines = [
      'RALPH_CYCLE_EVENT {"status":"success","ok":1,"failed":0}',
      eventLine({
        ts: '2026-04-29T06:00:00Z',
        status: 'success',
        ok: 1,
        failed: 0,
        durationMin: 3,
      }),
    ].join('\n')
    const fs = makeFs({ [`${LOG_DIR}/ralph-cycle.out.log`]: lines })
    const result = summarizeLast24h({ logDir: LOG_DIR, fs, clock })
    expect(result.cycles).toBe(1)
    expect(result.ok).toBe(1)
  })
})

describe('formatSummary', () => {
  it('renders cycle and issue counts with next tick', () => {
    const summary = {
      cycles: 6,
      totalIssues: 12,
      ok: 10,
      failed: 2,
      abortedCycles: 0,
      durations: [],
      lastCycle: { ts: '2026-04-29T11:00:00Z', status: 'success' },
    }
    const out = formatSummary(summary, {
      repoSlug: 'lucasfe/agenthub',
      nextTick: '12:30',
    })
    expect(out).toMatch(/📊/)
    expect(out).toMatch(/Ralph 24h/)
    expect(out).toMatch(/6 cycles/)
    expect(out).toMatch(/12 issues/)
    expect(out).toMatch(/10 ok/)
    expect(out).toMatch(/2 fail/)
    expect(out).toMatch(/next.*12:30/)
  })

  it('renders zero-cycles output without crashing', () => {
    const summary = {
      cycles: 0,
      totalIssues: 0,
      ok: 0,
      failed: 0,
      abortedCycles: 0,
      durations: [],
      lastCycle: null,
    }
    const out = formatSummary(summary, {
      repoSlug: 'lucasfe/agenthub',
      nextTick: '09:00',
    })
    expect(out).toMatch(/0 cycles/)
    expect(out).toMatch(/lucasfe\/agenthub/)
    expect(out).toMatch(/next.*09:00/)
  })

  it('flags all-failed scenario with a warning marker', () => {
    const summary = {
      cycles: 3,
      totalIssues: 5,
      ok: 0,
      failed: 5,
      abortedCycles: 0,
      durations: [],
      lastCycle: null,
    }
    const out = formatSummary(summary, {
      repoSlug: 'lucasfe/agenthub',
      nextTick: '09:00',
    })
    expect(out).toMatch(/0 ok/)
    expect(out).toMatch(/5 fail/)
    expect(out).toMatch(/⚠️/)
  })

  it('falls back to a slug-only header when nextTick is missing', () => {
    const summary = {
      cycles: 1,
      totalIssues: 1,
      ok: 1,
      failed: 0,
      abortedCycles: 0,
      durations: [],
      lastCycle: null,
    }
    const out = formatSummary(summary, { repoSlug: 'lucasfe/agenthub' })
    expect(out).toMatch(/lucasfe\/agenthub/)
    expect(out).not.toMatch(/next undefined/)
  })
})
