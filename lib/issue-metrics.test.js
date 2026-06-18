import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { appendIssueEvent, metricsPath, aggregateCycleCounts } from './issue-metrics.js'

// In-memory fs stub matching the injectable-fs pattern from state.js.
function makeFsStub() {
  const files = new Map()
  const dirs = new Set()
  return {
    files,
    dirs,
    existsSync(p) {
      return files.has(p) || dirs.has(p)
    },
    mkdirSync(p) {
      dirs.add(p)
    },
    appendFileSync(p, data) {
      files.set(p, (files.get(p) || '') + data)
    },
  }
}

describe('metricsPath', () => {
  it('points at .ralph/metrics/issues.jsonl under the project root', () => {
    expect(metricsPath('/proj')).toBe(
      join('/proj', '.ralph', 'metrics', 'issues.jsonl'),
    )
  })
})

describe('appendIssueEvent', () => {
  it('appends exactly one RALPH_ISSUE_EVENT line with valid JSON', () => {
    const fs = makeFsStub()
    const event = { issue_number: 98, verdict: 'pass' }
    appendIssueEvent('/proj', event, fs)

    const contents = fs.files.get(metricsPath('/proj'))
    const lines = contents.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith('RALPH_ISSUE_EVENT ')).toBe(true)
    const json = lines[0].slice('RALPH_ISSUE_EVENT '.length)
    expect(JSON.parse(json)).toEqual(event)
    expect(contents.endsWith('\n')).toBe(true)
  })

  it('appends (does not overwrite) on a second call', () => {
    const fs = makeFsStub()
    appendIssueEvent('/proj', { issue_number: 1 }, fs)
    appendIssueEvent('/proj', { issue_number: 2 }, fs)

    const contents = fs.files.get(metricsPath('/proj'))
    const lines = contents.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0].slice('RALPH_ISSUE_EVENT '.length)).issue_number).toBe(1)
    expect(JSON.parse(lines[1].slice('RALPH_ISSUE_EVENT '.length)).issue_number).toBe(2)
  })

  it('mkdirs the metrics dir recursively', () => {
    const fs = makeFsStub()
    appendIssueEvent('/proj', { issue_number: 1 }, fs)
    expect(fs.dirs.has(join('/proj', '.ralph', 'metrics'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// QA augmentation: additivity + JSON-escaping round-trip.
// ---------------------------------------------------------------------------
describe('QA: appendIssueEvent — additive over many calls', () => {
  it('3 sequential appends => 3 lines, all valid JSON, in order', () => {
    const fs = makeFsStub()
    appendIssueEvent('/proj', { issue_number: 1 }, fs)
    appendIssueEvent('/proj', { issue_number: 2 }, fs)
    appendIssueEvent('/proj', { issue_number: 3 }, fs)

    const contents = fs.files.get(metricsPath('/proj'))
    const lines = contents.split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    const nums = lines.map((l) => {
      expect(l.startsWith('RALPH_ISSUE_EVENT ')).toBe(true)
      return JSON.parse(l.slice('RALPH_ISSUE_EVENT '.length)).issue_number
    })
    expect(nums).toEqual([1, 2, 3])
  })
})

describe('QA: appendIssueEvent — JSON escaping round-trip', () => {
  it('event with newlines + quotes in a string field stays ONE line and round-trips', () => {
    const fs = makeFsStub()
    const event = {
      issue_number: 7,
      note: 'line one\nline two with "quotes" and a \\ backslash',
      verdict: 'pass',
    }
    appendIssueEvent('/proj', event, fs)

    const contents = fs.files.get(metricsPath('/proj'))
    // exactly one trailing newline => exactly one record line
    const lines = contents.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0].slice('RALPH_ISSUE_EVENT '.length))
    expect(parsed).toEqual(event)
    expect(parsed.note).toContain('\n')
  })
})

// ---------------------------------------------------------------------------
// aggregateCycleCounts — pure aggregator over issues.jsonl text (#532).
// ---------------------------------------------------------------------------
describe('aggregateCycleCounts', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('returns all zeros for empty / missing input', () => {
    const empty = { ok: 0, failed: 0, processed: 0, okIssues: [], failedIssues: [] }
    expect(aggregateCycleCounts('', 0)).toEqual(empty)
    expect(aggregateCycleCounts(undefined, 0)).toEqual(empty)
    expect(aggregateCycleCounts(null, 0)).toEqual(empty)
  })

  it('counts pass as ok and fail/unknown as failed', () => {
    const text = [
      line({ issue_number: 1, verdict: 'pass', ts: 100 }),
      line({ issue_number: 2, verdict: 'fail', ts: 100 }),
      line({ issue_number: 3, verdict: 'unknown', ts: 100 }),
    ].join('\n')
    const counts = aggregateCycleCounts(text, 0)
    expect(counts.ok).toBe(1)
    expect(counts.failed).toBe(2)
    expect(counts.processed).toBe(3)
    expect(counts.okIssues).toEqual([1])
    expect(counts.failedIssues).toEqual([2, 3])
  })

  it('excludes events whose ts is before the since cutoff', () => {
    const text = [
      line({ issue_number: 1, verdict: 'pass', ts: 50 }), // before cutoff
      line({ issue_number: 2, verdict: 'pass', ts: 200 }), // after cutoff
      line({ issue_number: 3, verdict: 'fail', ts: 200 }), // after cutoff
    ].join('\n')
    const counts = aggregateCycleCounts(text, 100)
    expect(counts.ok).toBe(1)
    expect(counts.failed).toBe(1)
    expect(counts.processed).toBe(2)
    expect(counts.okIssues).toEqual([2])
    expect(counts.failedIssues).toEqual([3])
  })

  it('keeps events whose ts equals the since cutoff (>=)', () => {
    const text = line({ issue_number: 9, verdict: 'pass', ts: 100 })
    expect(aggregateCycleCounts(text, 100).ok).toBe(1)
  })

  it('tolerates malformed lines: blank, non-tagged, bad JSON, missing ts', () => {
    const text = [
      '',
      'garbage line without tag',
      'RALPH_ISSUE_EVENT {not valid json',
      line({ issue_number: 5, verdict: 'pass' }), // missing ts → skipped
      line({ issue_number: 6, verdict: 'pass', ts: 'nope' }), // non-finite ts → skipped
      '   ',
      line({ issue_number: 7, verdict: 'pass', ts: 100 }), // the only valid in-window event
    ].join('\n')
    const counts = aggregateCycleCounts(text, 0)
    expect(counts.ok).toBe(1)
    expect(counts.failed).toBe(0)
    expect(counts.processed).toBe(1)
    expect(counts.okIssues).toEqual([7])
  })

  it('collects issue numbers, dropping non-finite ones', () => {
    const text = [
      line({ issue_number: 10, verdict: 'pass', ts: 100 }),
      line({ issue_number: 'x', verdict: 'pass', ts: 100 }), // bad number kept out of okIssues
      line({ issue_number: 20, verdict: 'fail', ts: 100 }),
      line({ verdict: 'fail', ts: 100 }), // no issue_number
    ].join('\n')
    const counts = aggregateCycleCounts(text, 0)
    // verdict-based counts still tally every in-window event
    expect(counts.ok).toBe(2)
    expect(counts.failed).toBe(2)
    // ...but only finite issue numbers are collected into the arrays
    expect(counts.okIssues).toEqual([10])
    expect(counts.failedIssues).toEqual([20])
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#532): adversarial edge cases the happy path missed.
// ---------------------------------------------------------------------------
describe('QA: aggregateCycleCounts — since boundary is inclusive of ts === since', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('ts === since is INCLUDED, ts === since - 1 is EXCLUDED', () => {
    const text = [
      line({ issue_number: 1, verdict: 'pass', ts: 999 }), // since - 1 → out
      line({ issue_number: 2, verdict: 'pass', ts: 1000 }), // === since → in
    ].join('\n')
    const counts = aggregateCycleCounts(text, 1000)
    expect(counts.ok).toBe(1)
    expect(counts.processed).toBe(1)
    expect(counts.okIssues).toEqual([2])
  })
})

describe('QA: aggregateCycleCounts — ts type abuse is excluded', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('a numeric STRING ts ("1700000000000") is treated as malformed and excluded', () => {
    const text = line({ issue_number: 1, verdict: 'pass', ts: '1700000000000' })
    expect(aggregateCycleCounts(text, 0)).toEqual({
      ok: 0,
      failed: 0,
      processed: 0,
      okIssues: [],
      failedIssues: [],
    })
  })

  it('ts: null, missing ts, and ts: Infinity are all excluded', () => {
    const text = [
      line({ issue_number: 1, verdict: 'pass', ts: null }),
      line({ issue_number: 2, verdict: 'pass' }), // missing
      // Infinity is not representable in JSON; JSON.stringify emits null, but
      // construct the raw line by hand to be explicit about the intent.
      'RALPH_ISSUE_EVENT {"issue_number":3,"verdict":"pass","ts":1e999}', // → Infinity
    ].join('\n')
    const counts = aggregateCycleCounts(text, 0)
    expect(counts.processed).toBe(0)
    expect(counts.ok).toBe(0)
    expect(counts.failed).toBe(0)
  })

  it('ts: NaN (raw JSON) is excluded — and does not throw', () => {
    // NaN is invalid JSON; a hand-rolled "NaN" literal makes JSON.parse throw,
    // which the aggregator swallows. Either way the event must not be counted.
    const text = 'RALPH_ISSUE_EVENT {"issue_number":1,"verdict":"pass","ts":NaN}'
    expect(() => aggregateCycleCounts(text, 0)).not.toThrow()
    expect(aggregateCycleCounts(text, 0).processed).toBe(0)
  })
})

describe('QA: aggregateCycleCounts — JSON valid but not an object', () => {
  it('a tagged line whose JSON is a number / string / null is skipped, never throws', () => {
    const text = [
      'RALPH_ISSUE_EVENT 42',
      'RALPH_ISSUE_EVENT "hi"',
      'RALPH_ISSUE_EVENT null',
      'RALPH_ISSUE_EVENT true',
    ].join('\n')
    let counts
    expect(() => {
      counts = aggregateCycleCounts(text, 0)
    }).not.toThrow()
    expect(counts).toEqual({
      ok: 0,
      failed: 0,
      processed: 0,
      okIssues: [],
      failedIssues: [],
    })
  })
})

describe('QA: aggregateCycleCounts — issue_number abuse still tallies verdict', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('pass with missing/NaN/non-numeric issue_number counts in ok but not okIssues', () => {
    const text = [
      line({ verdict: 'pass', ts: 100 }), // missing issue_number
      line({ issue_number: 'abc', verdict: 'pass', ts: 100 }), // non-numeric
      'RALPH_ISSUE_EVENT {"issue_number":1e999,"verdict":"pass","ts":100}', // Infinity
      line({ verdict: 'fail', ts: 100 }), // missing, failed branch
      line({ issue_number: null, verdict: 'fail', ts: 100 }),
    ].join('\n')
    const counts = aggregateCycleCounts(text, 0)
    expect(counts.ok).toBe(3)
    expect(counts.failed).toBe(2)
    expect(counts.processed).toBe(5)
    expect(counts.okIssues).toEqual([])
    expect(counts.failedIssues).toEqual([])
  })
})

describe('QA: aggregateCycleCounts — realistic mixed blob', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('counts only in-window valid events amid noise; exact arrays', () => {
    const text = [
      'just some stdout', // non-tagged log line
      line({ issue_number: 10, verdict: 'pass', ts: 5000 }), // in-window pass
      '', // blank line
      line({ issue_number: 11, verdict: 'unknown', ts: 5000 }), // in-window unknown → failed
      line({ issue_number: 99, verdict: 'pass', ts: 100 }), // out-of-window pass
      'RALPH_ISSUE_EVENT {bad json here', // bad-JSON tagged line
      line({ issue_number: 12, verdict: 'fail', ts: 6000 }), // in-window fail
    ].join('\n')
    const counts = aggregateCycleCounts(text, 1000)
    expect(counts.ok).toBe(1)
    expect(counts.failed).toBe(2)
    expect(counts.processed).toBe(3)
    expect(counts.okIssues).toEqual([10])
    expect(counts.failedIssues).toEqual([11, 12])
  })
})

describe('QA: aggregateCycleCounts — tag position semantics', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('a tag embedded mid-line still parses (indexOf-based slicing is intentional)', () => {
    const text =
      '2026-01-01T00:00:00 ' + line({ issue_number: 7, verdict: 'pass', ts: 100 })
    const counts = aggregateCycleCounts(text, 0)
    expect(counts.ok).toBe(1)
    expect(counts.okIssues).toEqual([7])
  })

  it('a line containing the tag but no following JSON is skipped without throwing', () => {
    const text = 'noise RALPH_ISSUE_EVENT '
    expect(() => aggregateCycleCounts(text, 0)).not.toThrow()
    expect(aggregateCycleCounts(text, 0).processed).toBe(0)
  })
})

describe('QA: aggregateCycleCounts — CRLF logs still count', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('a \\r\\n-terminated event leaves a trailing \\r that JSON.parse tolerates', () => {
    // The impl splits on '\n' only, so each record retains a trailing '\r'.
    // JSON.parse ignores trailing whitespace, so CRLF logs must still count.
    const text =
      line({ issue_number: 5, verdict: 'pass', ts: 100 }) +
      '\r\n' +
      line({ issue_number: 6, verdict: 'fail', ts: 100 }) +
      '\r\n'
    const counts = aggregateCycleCounts(text, 0)
    expect(counts.ok).toBe(1)
    expect(counts.failed).toBe(1)
    expect(counts.processed).toBe(2)
    expect(counts.okIssues).toEqual([5])
    expect(counts.failedIssues).toEqual([6])
  })
})
