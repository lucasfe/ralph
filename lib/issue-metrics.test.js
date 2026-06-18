import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { appendIssueEvent, metricsPath } from './issue-metrics.js'

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
