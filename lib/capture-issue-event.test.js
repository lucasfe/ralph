import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureIssueEvent } from './capture-issue-event.js'
import { metricsPath } from './issue-metrics.js'

let workdir

function envFor(overrides = {}) {
  return {
    PROJECT_ROOT: workdir,
    RALPH_ISSUE_NUMBER: '98',
    RALPH_RUN_ID: 'ralph-abc-1718000000',
    RALPH_CLAUDE_EXIT: '0',
    RALPH_ISSUE_LABELS: 'pending-merge',
    RALPH_ISSUE_STATE: 'OPEN',
    RALPH_DEV_BRANCH: 'dev',
    RALPH_RAW_JSONL_PATH: join(workdir, 'logs', 'ralph-issue-98.jsonl'),
    RALPH_STDERR_LOG_PATH: join(workdir, 'logs', 'ralph-issue-98.log'),
    ...overrides,
  }
}

function readEvents() {
  const p = metricsPath(workdir)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l.slice('RALPH_ISSUE_EVENT '.length)))
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-capture-'))
  mkdirSync(join(workdir, 'logs'), { recursive: true })
})

afterEach(() => {
  if (workdir && existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true })
  }
})

describe('captureIssueEvent', () => {
  it('appends exactly one event line from a fixture .jsonl + stderr log', () => {
    writeFileSync(
      join(workdir, 'logs', 'ralph-issue-98.jsonl'),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.5,
        num_turns: 3,
        duration_ms: 1000,
        usage: { input_tokens: 10 },
      }) + '\n',
    )
    writeFileSync(
      join(workdir, 'logs', 'ralph-issue-98.log'),
      'all good\n',
    )

    captureIssueEvent({ env: envFor() })

    const events = readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].issue_number).toBe(98)
    expect(events[0].subtype).toBe('success')
    expect(events[0].total_cost_usd).toBe(0.5)
    expect(events[0].verdict).toBe('pass')
    expect(events[0].run_id).toBe('ralph-abc-1718000000')
    expect(typeof events[0].ts).toBe('number')
    expect(events[0].stderr_error_signals).toBe(0)
  })

  it('still appends an event with default/zero fields when the .jsonl is missing', () => {
    // No .jsonl, no stderr log written.
    expect(() => captureIssueEvent({ env: envFor() })).not.toThrow()
    const events = readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].subtype).toBeNull()
    expect(events[0].total_cost_usd).toBe(0)
    expect(events[0].issue_number).toBe(98)
  })

  it('counts stderr error signals from the stderr log', () => {
    writeFileSync(
      join(workdir, 'logs', 'ralph-issue-98.jsonl'),
      JSON.stringify({ type: 'result', subtype: 'error_during_execution' }) + '\n',
    )
    writeFileSync(
      join(workdir, 'logs', 'ralph-issue-98.log'),
      'Credit balance too low\nAuthentication error\n',
    )
    captureIssueEvent({
      env: envFor({ RALPH_CLAUDE_EXIT: '1', RALPH_ISSUE_LABELS: 'claude-failed' }),
    })
    const events = readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].stderr_error_signals).toBe(2)
    expect(events[0].claude_exit_code).toBe(1)
    expect(events[0].verdict).toBe('fail')
  })

  it('parses comma-joined labels into an array for the verdict', () => {
    captureIssueEvent({
      env: envFor({ RALPH_ISSUE_LABELS: 'bug,claude-failed,enhancement' }),
    })
    const events = readEvents()
    expect(events[0].verdict).toBe('fail')
  })

  it('does not throw and writes nothing fatal when PROJECT_ROOT is unwritable-ish but best-effort', () => {
    // Empty labels + missing files: still must not throw.
    expect(() =>
      captureIssueEvent({ env: envFor({ RALPH_ISSUE_LABELS: '' }) }),
    ).not.toThrow()
    expect(readEvents()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// QA augmentation: best-effort contract + numeric coercion + determinism.
// ---------------------------------------------------------------------------
describe('QA: captureIssueEvent — best-effort + coercion', () => {
  it('missing .jsonl AND missing stderr => one event with zero/default fields, no throw', () => {
    // beforeEach makes the logs dir but writes no files.
    expect(() =>
      captureIssueEvent({ env: envFor({ RALPH_ISSUE_LABELS: 'pending-merge' }) }),
    ).not.toThrow()
    const events = readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].subtype).toBeNull()
    expect(events[0].total_cost_usd).toBe(0)
    expect(events[0].stderr_error_signals).toBe(0)
    expect(events[0].usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })

  it('garbage/malformed .jsonl => event still written with safe defaults, no throw', () => {
    writeFileSync(
      join(workdir, 'logs', 'ralph-issue-98.jsonl'),
      'not json\n{ broken\n\n',
    )
    expect(() => captureIssueEvent({ env: envFor() })).not.toThrow()
    const events = readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].subtype).toBeNull()
    expect(events[0].total_cost_usd).toBe(0)
  })

  it('non-numeric RALPH_ISSUE_NUMBER => issue_number is null (not NaN)', () => {
    captureIssueEvent({ env: envFor({ RALPH_ISSUE_NUMBER: 'not-a-number' }) })
    const events = readEvents()
    expect(events[0].issue_number).toBeNull()
    // JSON.parse would have turned NaN into null on disk; assert the in-memory
    // semantics by confirming it's exactly null after round-trip.
    expect(events[0].issue_number).not.toBeNaN?.()
  })

  it('non-numeric RALPH_CLAUDE_EXIT => claude_exit_code is null (not NaN)', () => {
    captureIssueEvent({ env: envFor({ RALPH_CLAUDE_EXIT: 'boom' }) })
    const events = readEvents()
    expect(events[0].claude_exit_code).toBeNull()
  })

  it('missing RALPH_ISSUE_NUMBER / RALPH_CLAUDE_EXIT entirely => null fields', () => {
    const env = envFor()
    delete env.RALPH_ISSUE_NUMBER
    delete env.RALPH_CLAUDE_EXIT
    captureIssueEvent({ env })
    const events = readEvents()
    expect(events[0].issue_number).toBeNull()
    expect(events[0].claude_exit_code).toBeNull()
  })

  it('empty RALPH_ISSUE_LABELS + OPEN state => empty labels => unknown verdict', () => {
    captureIssueEvent({
      env: envFor({ RALPH_ISSUE_LABELS: '', RALPH_ISSUE_STATE: 'OPEN' }),
    })
    const events = readEvents()
    expect(events[0].verdict).toBe('unknown')
  })

  it('empty RALPH_ISSUE_LABELS but CLOSED state => pass', () => {
    captureIssueEvent({
      env: envFor({ RALPH_ISSUE_LABELS: '', RALPH_ISSUE_STATE: 'CLOSED' }),
    })
    const events = readEvents()
    expect(events[0].verdict).toBe('pass')
  })

  it('uses the injected now() for ts (deterministic)', () => {
    captureIssueEvent({ env: envFor(), now: () => 1234567890 })
    const events = readEvents()
    expect(events[0].ts).toBe(1234567890)
  })

  it('whitespace-padded labels are trimmed and parsed', () => {
    captureIssueEvent({
      env: envFor({ RALPH_ISSUE_LABELS: '  bug , claude-failed , enhancement ' }),
    })
    const events = readEvents()
    expect(events[0].verdict).toBe('fail')
  })
})
