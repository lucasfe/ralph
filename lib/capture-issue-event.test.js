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

// Hermetic default: never shell out to gh in tests that don't care about diff
// stats. Tests that DO care inject their own fetchDiffStats.
const noGhDiff = () => ({ additions: 0, deletions: 0, changedFiles: 0 })

// captureIssueEvent with a hermetic fetcher injected unless the test overrides it.
function capture(opts = {}) {
  return captureIssueEvent({ fetchDiffStats: noGhDiff, ...opts })
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

    capture({ env: envFor() })

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
    expect(() => capture({ env: envFor() })).not.toThrow()
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
    capture({
      env: envFor({ RALPH_CLAUDE_EXIT: '1', RALPH_ISSUE_LABELS: 'claude-failed' }),
    })
    const events = readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].stderr_error_signals).toBe(2)
    expect(events[0].claude_exit_code).toBe(1)
    expect(events[0].verdict).toBe('fail')
  })

  it('parses comma-joined labels into an array for the verdict', () => {
    capture({
      env: envFor({ RALPH_ISSUE_LABELS: 'bug,claude-failed,enhancement' }),
    })
    const events = readEvents()
    expect(events[0].verdict).toBe('fail')
  })

  it('does not throw and writes nothing fatal when PROJECT_ROOT is unwritable-ish but best-effort', () => {
    // Empty labels + missing files: still must not throw.
    expect(() =>
      capture({ env: envFor({ RALPH_ISSUE_LABELS: '' }) }),
    ).not.toThrow()
    expect(readEvents()).toHaveLength(1)
  })
})

describe('captureIssueEvent — real PR diff stats (#530)', () => {
  it('records real files/insertions/deletions from the injected fetcher', () => {
    const fetchDiffStats = (issueNumber) => {
      expect(issueNumber).toBe(98)
      return { additions: 120, deletions: 30, changedFiles: 5 }
    }
    captureIssueEvent({ env: envFor(), fetchDiffStats })
    const events = readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].files).toBe(5)
    expect(events[0].insertions).toBe(120)
    expect(events[0].deletions).toBe(30)
  })

  it('records zeros when the fetcher returns zeros (no PR)', () => {
    const fetchDiffStats = () => ({ additions: 0, deletions: 0, changedFiles: 0 })
    captureIssueEvent({ env: envFor(), fetchDiffStats })
    const events = readEvents()
    expect(events[0].files).toBe(0)
    expect(events[0].insertions).toBe(0)
    expect(events[0].deletions).toBe(0)
  })

  it('degrades to zeros and never throws when the fetcher itself throws', () => {
    const fetchDiffStats = () => {
      throw new Error('gh blew up')
    }
    expect(() =>
      captureIssueEvent({ env: envFor(), fetchDiffStats }),
    ).not.toThrow()
    const events = readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].files).toBe(0)
    expect(events[0].insertions).toBe(0)
    expect(events[0].deletions).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// QA augmentation: best-effort contract + numeric coercion + determinism.
// ---------------------------------------------------------------------------
describe('QA: captureIssueEvent — best-effort + coercion', () => {
  it('missing .jsonl AND missing stderr => one event with zero/default fields, no throw', () => {
    // beforeEach makes the logs dir but writes no files.
    expect(() =>
      capture({ env: envFor({ RALPH_ISSUE_LABELS: 'pending-merge' }) }),
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
    expect(() => capture({ env: envFor() })).not.toThrow()
    const events = readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].subtype).toBeNull()
    expect(events[0].total_cost_usd).toBe(0)
  })

  it('non-numeric RALPH_ISSUE_NUMBER => issue_number is null (not NaN)', () => {
    capture({ env: envFor({ RALPH_ISSUE_NUMBER: 'not-a-number' }) })
    const events = readEvents()
    expect(events[0].issue_number).toBeNull()
    // JSON.parse would have turned NaN into null on disk; assert the in-memory
    // semantics by confirming it's exactly null after round-trip.
    expect(events[0].issue_number).not.toBeNaN?.()
  })

  it('non-numeric RALPH_CLAUDE_EXIT => claude_exit_code is null (not NaN)', () => {
    capture({ env: envFor({ RALPH_CLAUDE_EXIT: 'boom' }) })
    const events = readEvents()
    expect(events[0].claude_exit_code).toBeNull()
  })

  it('missing RALPH_ISSUE_NUMBER / RALPH_CLAUDE_EXIT entirely => null fields', () => {
    const env = envFor()
    delete env.RALPH_ISSUE_NUMBER
    delete env.RALPH_CLAUDE_EXIT
    capture({ env })
    const events = readEvents()
    expect(events[0].issue_number).toBeNull()
    expect(events[0].claude_exit_code).toBeNull()
  })

  it('empty RALPH_ISSUE_LABELS + OPEN state => empty labels => unknown verdict', () => {
    capture({
      env: envFor({ RALPH_ISSUE_LABELS: '', RALPH_ISSUE_STATE: 'OPEN' }),
    })
    const events = readEvents()
    expect(events[0].verdict).toBe('unknown')
  })

  it('empty RALPH_ISSUE_LABELS but CLOSED state => pass', () => {
    capture({
      env: envFor({ RALPH_ISSUE_LABELS: '', RALPH_ISSUE_STATE: 'CLOSED' }),
    })
    const events = readEvents()
    expect(events[0].verdict).toBe('pass')
  })

  it('uses the injected now() for ts (deterministic)', () => {
    capture({ env: envFor(), now: () => 1234567890 })
    const events = readEvents()
    expect(events[0].ts).toBe(1234567890)
  })

  it('whitespace-padded labels are trimmed and parsed', () => {
    capture({
      env: envFor({ RALPH_ISSUE_LABELS: '  bug , claude-failed , enhancement ' }),
    })
    const events = readEvents()
    expect(events[0].verdict).toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// QA augmentation: diff-stats fetcher wiring (#530) — resolved issue number,
// throwing-fetcher diagnostics, realistic numbers, fetcher contract.
// ---------------------------------------------------------------------------
describe('QA: captureIssueEvent — diff-stats fetcher wiring (#530)', () => {
  it('passes the RESOLVED numeric issue number to the fetcher', () => {
    let received = 'unset'
    const fetchDiffStats = (n) => {
      received = n
      return { additions: 0, deletions: 0, changedFiles: 0 }
    }
    captureIssueEvent({ env: envFor({ RALPH_ISSUE_NUMBER: '530' }), fetchDiffStats })
    expect(received).toBe(530)
  })

  it('passes NULL (not NaN) to the fetcher when RALPH_ISSUE_NUMBER is non-numeric', () => {
    let received = 'unset'
    const fetchDiffStats = (n) => {
      received = n
      return { additions: 0, deletions: 0, changedFiles: 0 }
    }
    captureIssueEvent({
      env: envFor({ RALPH_ISSUE_NUMBER: 'not-a-number' }),
      fetchDiffStats,
    })
    expect(received).toBeNull()
  })

  it('passes NULL to the fetcher when RALPH_ISSUE_NUMBER is missing entirely', () => {
    let received = 'unset'
    const fetchDiffStats = (n) => {
      received = n
      return { additions: 0, deletions: 0, changedFiles: 0 }
    }
    const env = envFor()
    delete env.RALPH_ISSUE_NUMBER
    captureIssueEvent({ env, fetchDiffStats })
    expect(received).toBeNull()
  })

  it('invokes the fetcher exactly once', () => {
    let calls = 0
    const fetchDiffStats = () => {
      calls++
      return { additions: 1, deletions: 1, changedFiles: 1 }
    }
    captureIssueEvent({ env: envFor(), fetchDiffStats })
    expect(calls).toBe(1)
  })

  it('flows large/realistic diff numbers into files/insertions/deletions', () => {
    const fetchDiffStats = () => ({
      additions: 12_345,
      deletions: 6_789,
      changedFiles: 87,
    })
    captureIssueEvent({ env: envFor(), fetchDiffStats })
    const events = readEvents()
    expect(events[0].insertions).toBe(12_345)
    expect(events[0].deletions).toBe(6_789)
    expect(events[0].files).toBe(87)
  })

  it('correctly maps changedFiles->files (not additions->files)', () => {
    // Regression guard against a field-mapping swap.
    const fetchDiffStats = () => ({
      additions: 100,
      deletions: 10,
      changedFiles: 3,
    })
    captureIssueEvent({ env: envFor(), fetchDiffStats })
    const events = readEvents()
    expect(events[0].files).toBe(3)
    expect(events[0].insertions).toBe(100)
    expect(events[0].deletions).toBe(10)
  })

  it('throwing fetcher => event written with zeros AND a diagnostic logged', () => {
    const logged = []
    const log = (msg) => logged.push(msg)
    const fetchDiffStats = () => {
      throw new Error('gh blew up')
    }
    expect(() =>
      captureIssueEvent({ env: envFor(), fetchDiffStats, log }),
    ).not.toThrow()
    const events = readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].files).toBe(0)
    expect(events[0].insertions).toBe(0)
    expect(events[0].deletions).toBe(0)
    // diagnostic was emitted via the injected log spy
    expect(logged.length).toBeGreaterThanOrEqual(1)
    expect(logged.some((m) => /diff stats unavailable/.test(m))).toBe(true)
    expect(logged.some((m) => /gh blew up/.test(m))).toBe(true)
  })

  it('fetcher returning null/undefined => event written with zero defaults, no throw', () => {
    const events1 = (() => {
      captureIssueEvent({ env: envFor(), fetchDiffStats: () => null })
      return readEvents()
    })()
    expect(events1[0].files).toBe(0)
    expect(events1[0].insertions).toBe(0)
    expect(events1[0].deletions).toBe(0)
  })

  it('does NOT log a diagnostic on the happy path (no spurious noise)', () => {
    const logged = []
    const log = (msg) => logged.push(msg)
    const fetchDiffStats = () => ({ additions: 1, deletions: 1, changedFiles: 1 })
    captureIssueEvent({ env: envFor(), fetchDiffStats, log })
    expect(logged).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#534): RALPH_CONTEXT_WINDOW env -> contextWindowOverride.
// A valid finite positive number is honored; 0 / negative / non-numeric / empty
// are ignored so the window falls back to the model-id map.
// ---------------------------------------------------------------------------
describe('QA: captureIssueEvent — RALPH_CONTEXT_WINDOW wiring (#534)', () => {
  // Write a stream whose LAST message_start uses an UNKNOWN model so the only way
  // pct can be non-null is via the env override flowing into contextWindowOverride.
  function writeUnknownModelStream(inputTokens = 100) {
    writeFileSync(
      join(workdir, 'logs', 'ralph-issue-98.jsonl'),
      JSON.stringify({
        type: 'message_start',
        message: { model: 'mystery-model-x', usage: { input_tokens: inputTokens } },
      }) + '\n',
    )
  }

  it('a valid RALPH_CONTEXT_WINDOW is applied to the computed pct', () => {
    writeUnknownModelStream(100)
    capture({ env: envFor({ RALPH_CONTEXT_WINDOW: '1000' }) })
    const events = readEvents()
    expect(events[0].context_end_tokens).toBe(100)
    expect(events[0].model).toBe('mystery-model-x')
    expect(events[0].context_end_pct).toBeCloseTo(0.1, 10)
  })

  it('RALPH_CONTEXT_WINDOW="0" is ignored => unknown model has no window => pct null', () => {
    writeUnknownModelStream(100)
    capture({ env: envFor({ RALPH_CONTEXT_WINDOW: '0' }) })
    const events = readEvents()
    expect(events[0].context_end_pct).toBeNull()
  })

  it('RALPH_CONTEXT_WINDOW="-5" is ignored => pct null for unknown model', () => {
    writeUnknownModelStream(100)
    capture({ env: envFor({ RALPH_CONTEXT_WINDOW: '-5' }) })
    const events = readEvents()
    expect(events[0].context_end_pct).toBeNull()
  })

  it('RALPH_CONTEXT_WINDOW="abc" is ignored => pct null for unknown model', () => {
    writeUnknownModelStream(100)
    capture({ env: envFor({ RALPH_CONTEXT_WINDOW: 'abc' }) })
    const events = readEvents()
    expect(events[0].context_end_pct).toBeNull()
  })

  it('RALPH_CONTEXT_WINDOW="" (empty) is ignored => pct null for unknown model', () => {
    writeUnknownModelStream(100)
    capture({ env: envFor({ RALPH_CONTEXT_WINDOW: '' }) })
    const events = readEvents()
    expect(events[0].context_end_pct).toBeNull()
  })

  it('RALPH_CONTEXT_WINDOW absent + KNOWN model => window resolved from model id (opus=1M)', () => {
    writeFileSync(
      join(workdir, 'logs', 'ralph-issue-98.jsonl'),
      JSON.stringify({
        type: 'message_start',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 12_345 } },
      }) + '\n',
    )
    const env = envFor()
    delete env.RALPH_CONTEXT_WINDOW
    capture({ env })
    const events = readEvents()
    expect(events[0].context_end_pct).toBe(0.012345)
  })
})
