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
import { join, relative } from 'node:path'
import { captureIssueEvent } from './capture-issue-event.js'
import { metricsPath } from './issue-metrics.js'
// The #131 docs sweep at the bottom of this file, built from the SHARED primitives #53 put in
// test/helpers/ and #128 and #130 extended — `claimText`/`repoMarkdown`/the pattern list from
// doc-guard.js, and `trackedFiles` (the repo's fail-closed source enumerator) from
// source-control-bytes.js. Nothing above it reads the repo; these are the sweep's alone.
import {
  claimText,
  repoMarkdown,
  JIRA_UNRECORDED_CLAIM_PATTERNS,
  REPO_ROOT,
} from '../test/helpers/doc-guard.js'
import { trackedFiles } from '../test/helpers/source-control-bytes.js'

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

// ---------------------------------------------------------------------------
// #565: folder task source. The task id (RALPH_TASK_ID) is the event's
// issue_number, the terminal directory (RALPH_TASK_OUTCOME: done|failed) drives
// the verdict, and NO gh PR diff is fetched (folder mode opens no PRs). The github
// path is unchanged.
//
// NO LABELS REACH A FOLDER EVENT, and this header used to say frontmatter ones flowed
// through RALPH_ISSUE_LABELS: the loop exports that variable at ONE site, the github
// telemetry block, and the `folderEnv` below inherits the shared `envFor` default rather
// than anything the folder arm would set. Inert either way — the outcome override wins in
// `computeVerdict` before labels are looked at — so the tests below assert the override,
// not the labels.
// ---------------------------------------------------------------------------
describe('captureIssueEvent — folder task source (#565)', () => {
  const folderEnv = (overrides = {}) =>
    envFor({
      TASK_SOURCE: 'folder',
      RALPH_TASK_ID: '7',
      RALPH_TASK_OUTCOME: 'done',
      ...overrides,
    })

  it('uses RALPH_TASK_ID as the event issue_number in folder mode', () => {
    capture({ env: folderEnv() })
    expect(readEvents()[0].issue_number).toBe(7)
  })

  it('maps RALPH_TASK_OUTCOME=done to a pass verdict', () => {
    capture({ env: folderEnv({ RALPH_TASK_OUTCOME: 'done' }) })
    expect(readEvents()[0].verdict).toBe('pass')
  })

  it('maps RALPH_TASK_OUTCOME=failed to a fail verdict', () => {
    capture({ env: folderEnv({ RALPH_TASK_OUTCOME: 'failed' }) })
    expect(readEvents()[0].verdict).toBe('fail')
  })

  it('maps an unknown/absent outcome to unknown', () => {
    capture({ env: folderEnv({ RALPH_TASK_OUTCOME: 'in-progress' }) })
    expect(readEvents()[0].verdict).toBe('unknown')
  })

  it('does NOT call the PR diff fetcher in folder mode (no PR to diff)', () => {
    let calls = 0
    const fetchDiffStats = () => {
      calls++
      return { additions: 9, deletions: 9, changedFiles: 9 }
    }
    captureIssueEvent({ env: folderEnv(), fetchDiffStats })
    expect(calls).toBe(0)
    const e = readEvents()[0]
    expect(e.files).toBe(0)
    expect(e.insertions).toBe(0)
    expect(e.deletions).toBe(0)
  })

  it('records the agent for a folder-mode event', () => {
    capture({ env: folderEnv({ RALPH_AGENT: 'codex' }) })
    expect(readEvents()[0].agent).toBe('codex')
  })

  it('github mode still fetches PR diff stats (no regression)', () => {
    let calls = 0
    const fetchDiffStats = () => {
      calls++
      return { additions: 4, deletions: 2, changedFiles: 1 }
    }
    captureIssueEvent({ env: envFor(), fetchDiffStats })
    expect(calls).toBe(1)
    expect(readEvents()[0].files).toBe(1)
  })
})

describe('captureIssueEvent — agent selection (#554)', () => {
  it('records agent "claude" by default (RALPH_AGENT unset)', () => {
    writeFileSync(
      join(workdir, 'logs', 'ralph-issue-98.jsonl'),
      JSON.stringify({ type: 'result', subtype: 'success' }) + '\n',
    )
    capture({ env: envFor() })
    expect(readEvents()[0].agent).toBe('claude')
  })

  it('records the RESOLVED agent on a RALPH_AGENT typo (fallback to claude, auditable)', () => {
    writeFileSync(
      join(workdir, 'logs', 'ralph-issue-98.jsonl'),
      JSON.stringify({ type: 'result', subtype: 'success' }) + '\n',
    )
    capture({ env: envFor({ RALPH_AGENT: 'codx' }) })
    expect(readEvents()[0].agent).toBe('claude')
  })

  it('builds a codex event: agent, folded output, configured model, wall-clock duration', () => {
    writeFileSync(
      join(workdir, 'logs', 'ralph-issue-98.jsonl'),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 4000,
          cached_input_tokens: 100,
          cache_write_input_tokens: 0,
          output_tokens: 41,
          reasoning_output_tokens: 34,
        },
      }) + '\n',
    )
    capture({
      env: envFor({
        RALPH_AGENT: 'codex',
        RALPH_CODEX_MODEL: 'gpt-5-codex',
        RALPH_DURATION_MS: '75000',
      }),
    })
    const e = readEvents()[0]
    expect(e.agent).toBe('codex')
    expect(e.model).toBe('gpt-5-codex')
    expect(e.total_cost_usd).toBe(0)
    expect(e.duration_ms).toBe(75000)
    expect(e.usage.output_tokens).toBe(75)
    expect(e.context_window).toBe(400_000)
  })

  it('codex with no configured model => model null, window null', () => {
    writeFileSync(
      join(workdir, 'logs', 'ralph-issue-98.jsonl'),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 } }) + '\n',
    )
    capture({ env: envFor({ RALPH_AGENT: 'codex' }) })
    const e = readEvents()[0]
    expect(e.model).toBeNull()
    expect(e.context_window).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// #131: jira task source. The ticket KEY (RALPH_TASK_KEY) is recorded as a
// first-class `task_key` field and the event's numeric `issue_number` is DERIVED
// from it (lib/jira-key.js), the loop-read outcome (RALPH_TASK_OUTCOME) drives
// the verdict exactly as in folder mode, and NO gh PR diff is fetched — a jira
// iteration opens no PR, so a machine without `gh` still writes complete
// telemetry. github and folder events carry no `task_key` key at all.
// ---------------------------------------------------------------------------
describe('captureIssueEvent — jira task source (#131)', () => {
  // The env the loop's jira arm actually exports: a key and an outcome, and NONE of the
  // three GitHub inputs — there is no issue to read a number, a label set or a state off.
  // Dropped rather than left at their defaults on purpose: with `pending-merge` still in
  // the fixture, a verdict test would pass through the github precedence and prove nothing
  // about the outcome mapping this describe is here for.
  const jiraEnv = (overrides = {}) => {
    const base = envFor()
    delete base.RALPH_ISSUE_NUMBER
    delete base.RALPH_ISSUE_LABELS
    delete base.RALPH_ISSUE_STATE
    return {
      ...base,
      TASK_SOURCE: 'jira',
      RALPH_TASK_KEY: 'FOO-123',
      RALPH_TASK_OUTCOME: 'done',
      ...overrides,
    }
  }

  it('records the ticket key as task_key and the derived number as issue_number', () => {
    capture({ env: jiraEnv() })
    const e = readEvents()[0]
    expect(e.task_key).toBe('FOO-123')
    expect(e.issue_number).toBe(123)
  })

  it('normalizes the key the way lib/jira-key.js does (project key uppercased, number verbatim)', () => {
    capture({ env: jiraEnv({ RALPH_TASK_KEY: ' foo-007 ' }) })
    const e = readEvents()[0]
    expect(e.task_key).toBe('FOO-007')
    expect(e.issue_number).toBe(7)
  })

  it('maps RALPH_TASK_OUTCOME=done to a pass verdict (identical to folder mode)', () => {
    capture({ env: jiraEnv({ RALPH_TASK_OUTCOME: 'done' }) })
    expect(readEvents()[0].verdict).toBe('pass')
  })

  it('maps RALPH_TASK_OUTCOME=failed to a fail verdict (identical to folder mode)', () => {
    capture({ env: jiraEnv({ RALPH_TASK_OUTCOME: 'failed' }) })
    expect(readEvents()[0].verdict).toBe('fail')
  })

  it('maps an unknown/absent outcome to unknown', () => {
    capture({ env: jiraEnv({ RALPH_TASK_OUTCOME: 'in-progress' }) })
    expect(readEvents()[0].verdict).toBe('unknown')
  })

  it('does NOT call the PR diff fetcher in jira mode, even when it would throw', () => {
    // The AC spelled as a test: a machine with no `gh` at all must still get a
    // complete event, so the fetcher is never reached rather than merely tolerated.
    let calls = 0
    const fetchDiffStats = () => {
      calls++
      throw new Error('gh must not be called in jira mode')
    }
    expect(() => captureIssueEvent({ env: jiraEnv(), fetchDiffStats })).not.toThrow()
    expect(calls).toBe(0)
    const e = readEvents()[0]
    expect(e.files).toBe(0)
    expect(e.insertions).toBe(0)
    expect(e.deletions).toBe(0)
  })

  it('a malformed RALPH_TASK_KEY yields a null issue_number (never NaN) and still writes the event', () => {
    capture({ env: jiraEnv({ RALPH_TASK_KEY: 'FOO-BAR-1' }) })
    const events = readEvents()
    expect(events).toHaveLength(1)
    // Passed through as the key, because Jira names its own tickets; no number can
    // be read out of it, and null is the record's "unknown".
    expect(events[0].task_key).toBe('FOO-BAR-1')
    expect(events[0].issue_number).toBeNull()
  })

  it('a missing RALPH_TASK_KEY still writes an event, with no key and no number', () => {
    const env = jiraEnv()
    delete env.RALPH_TASK_KEY
    capture({ env })
    const events = readEvents()
    expect(events).toHaveLength(1)
    expect('task_key' in events[0]).toBe(false)
    expect(events[0].issue_number).toBeNull()
  })

  it('ignores RALPH_ISSUE_NUMBER and RALPH_TASK_ID in jira mode — the key is the identity', () => {
    capture({ env: jiraEnv({ RALPH_ISSUE_NUMBER: '98', RALPH_TASK_ID: '7' }) })
    expect(readEvents()[0].issue_number).toBe(123)
  })

  it('the key beats a stray claude-failed label, like the folder outcome does', () => {
    capture({ env: jiraEnv({ RALPH_ISSUE_LABELS: 'claude-failed' }) })
    expect(readEvents()[0].verdict).toBe('pass')
  })

  it('populates duration, agent, model, context window and the log-derived fields', () => {
    // Everything the other two sources record is recorded here too: the fields come
    // from the same stream parse and the same env, not from a jira-specific path.
    writeFileSync(
      join(workdir, 'logs', 'ralph-issue-98.jsonl'),
      JSON.stringify({
        type: 'message_start',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 12_345 } },
      }) +
        '\n' +
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          total_cost_usd: 0.25,
          num_turns: 4,
          usage: { input_tokens: 10 },
        }) +
        '\n',
    )
    writeFileSync(join(workdir, 'logs', 'ralph-issue-98.log'), 'Credit balance too low\n')
    capture({
      env: jiraEnv({ RALPH_DURATION_MS: '75000', RALPH_CLAUDE_EXIT: '0' }),
      now: () => 1234567890,
    })
    const e = readEvents()[0]
    expect(e.duration_ms).toBe(75000)
    expect(e.agent).toBe('claude')
    expect(e.model).toBe('claude-opus-4-8')
    expect(e.context_window).toBe(1_000_000)
    expect(e.context_end_tokens).toBe(12_345)
    expect(e.context_end_pct).toBe(0.012345)
    expect(e.total_cost_usd).toBe(0.25)
    expect(e.num_turns).toBe(4)
    expect(e.stderr_error_signals).toBe(1)
    expect(e.claude_exit_code).toBe(0)
    expect(e.run_id).toBe('ralph-abc-1718000000')
    expect(e.ts).toBe(1234567890)
  })

  it('records the resolved agent for a jira event', () => {
    capture({ env: jiraEnv({ RALPH_AGENT: 'codex', RALPH_CODEX_MODEL: 'gpt-5-codex' }) })
    const e = readEvents()[0]
    expect(e.agent).toBe('codex')
    expect(e.model).toBe('gpt-5-codex')
  })

  it('a telemetry crash under jira mode never throws out of the sidecar', () => {
    expect(() =>
      capture({ env: jiraEnv({ PROJECT_ROOT: '/nonexistent/\0/root' }) }),
    ).not.toThrow()
  })

  it('emits NO task_key key for a github event (the on-disk format is untouched)', () => {
    captureIssueEvent({ env: envFor(), fetchDiffStats: noGhDiff })
    const e = readEvents()[0]
    expect('task_key' in e).toBe(false)
  })

  it('emits NO task_key key for a folder event, even when RALPH_TASK_KEY is set', () => {
    // A stale export from an earlier jira run in the same shell must not leak a key
    // onto a folder event: the SOURCE decides which identity is recorded.
    capture({
      env: envFor({
        TASK_SOURCE: 'folder',
        RALPH_TASK_ID: '7',
        RALPH_TASK_OUTCOME: 'done',
        RALPH_TASK_KEY: 'FOO-123',
      }),
    })
    const e = readEvents()[0]
    expect('task_key' in e).toBe(false)
    expect(e.issue_number).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// No document still says a jira iteration records nothing (#131).
// ---------------------------------------------------------------------------
//
// WHY A SWEEP AND NOT AN EDIT, and it is #128's and #130's review finding rather than a
// precaution: each of those slices corrected the hunks it could find and left copies of the
// falsified sentence standing, because nothing pinned the prose. #131 falsifies the LAST of
// the `jira` source's caveats — "what is still missing is the per-ticket telemetry" — and it
// was written wherever the source is described, because it was the thing a reader had to
// know before pointing this at a board they wanted a record of. So the same sweep is applied
// to the same three surfaces — markdown, tracked `.js`, tracked `.sh` — with the pattern list
// beside the other two in test/helpers/doc-guard.js.
//
// AND IT HAS A MEASURED CATCH, argued from what happened rather than from precedent: this
// slice's first prose pass corrected six hunks of README.md, lib/task-source.js and
// templates/ralph.sh and believed the claim was gone. The copy buried in the middle of
// templates/ralph.config.sh's `TASK_SOURCE` comment block survived all of it, and turned up
// only when the search was widened
// from the phrases to the bare word `telemetry` across every tracked file — which is the
// search this sweep runs by construction, every time, instead of once by hand.
describe('QA #131 no doc or comment still claims a jira iteration records nothing', () => {
  // The two files that MUST carry the banned sentences to do their job: the module that
  // defines the patterns, and this one, which spells the pre-#131 wording out as a positive
  // control. Derived from the definition sites rather than a convenience list, and the anchor
  // below proves both really do match.
  const SELF_REFERENTIAL = [
    join('test', 'helpers', 'doc-guard.js'),
    join('lib', 'capture-issue-event.test.js'),
  ]

  const swept = () => {
    const code = trackedFiles()
      .map((abs) => relative(REPO_ROOT, abs))
      .filter((rel) => rel.endsWith('.js') || rel.endsWith('.sh'))
    return [...repoMarkdown(), ...code].filter((rel) => !SELF_REFERENTIAL.includes(rel))
  }

  it.each(SELF_REFERENTIAL)('%s is excluded because it really does carry the banned strings', (rel) => {
    // Read off DISK, the same way the sweep reads its own files, so the exclusion stays
    // honest: reword either file into no longer carrying a banned string and this reddens
    // rather than leaving a file permanently unswept with nothing saying so.
    const text = claimText(readFileSync(join(REPO_ROOT, rel), 'utf8'))
    expect(JIRA_UNRECORDED_CLAIM_PATTERNS.some((p) => p.test(text)), rel).toBe(true)
  })

  it('sweeps the real surface (the negative guard is not vacuous)', () => {
    const files = swept()
    // Every file that carried a banned claim at HEAD, which is where a reworded copy of one
    // would land. MEASURED, not recalled: these five are the files whose HEAD contents match
    // at least one pattern when run through `claimText` — README.md matched nine of the
    // patterns, lib/task-source.js and templates/ralph.config.sh three each,
    // templates/ralph.sh two and lib/progress.js one.
    expect(files).toContain('README.md')
    expect(files).toContain(join('templates', 'ralph.config.sh'))
    expect(files).toContain(join('templates', 'ralph.sh'))
    expect(files).toContain(join('lib', 'task-source.js'))
    // The module whose own comment made the reader-facing half of the claim: a closed row
    // had no name to show because no event carried one.
    expect(files).toContain(join('lib', 'progress.js'))
    // Floors, not equalities, so a new doc or module does not redden the suite — but a walk
    // that has collapsed to a handful of root files does.
    expect(files.filter((f) => f.endsWith('.md')).length).toBeGreaterThanOrEqual(14)
    expect(files.filter((f) => f.endsWith('.js')).length).toBeGreaterThanOrEqual(150)
    expect(files.filter((f) => f.endsWith('.sh')).length).toBeGreaterThanOrEqual(2)
  })

  it.each(swept())('%s claims no such thing', (rel) => {
    // `claimText` and not `prose`: two of the six README copies wrapped the noun in markdown
    // emphasis, and two more were `//` and `#` comment blocks broken across lines.
    const text = claimText(readFileSync(join(REPO_ROOT, rel), 'utf8'))
    for (const pattern of JIRA_UNRECORDED_CLAIM_PATTERNS) {
      expect(text, `${rel} matched ${pattern}`).not.toMatch(pattern)
    }
  })

  it('the patterns really do catch every sentence #131 had to delete', () => {
    // Positive control, and none of these is invented: each is VERBATIM text that stood in
    // the repo before this slice, so the sweep above is proven to be doing work rather than
    // matching nothing. Kept as the wrapped, emphasised, `#`-prefixed strings they were, so
    // `claimText`'s stripping is load-bearing here too.
    const deleted = [
      'Nothing pushes the commit either, and\nnothing records a per-ticket telemetry event.',
      'What is still missing is the **per-ticket telemetry** — no issue event\n  is appended under this source, so nothing narrates a Jira iteration the way the digest\n  narrates a GitHub one.',
      'What is still missing is the\nper-ticket telemetry — and what `ralph start` does around the loop has not moved with\nit either.',
      '**nothing appends a\ntask event under this source**: the ticket does get worked, but the per-ticket telemetry\nthat would record it is a follow-up, so the only two arms that append an event are\n`folder` and `github`. So a `jira` run reads `0` completed for its whole life',
      'What is **not** wired is the **telemetry**, and it is a follow-up: no per-ticket issue\nevent is appended under this source, so `ralph status` and the digest have no\nper-iteration Jira record to narrate.',
      'What is **not** wired is the telemetry: no per-ticket event is appended under this source at all.',
      '# WHAT IS STILL MISSING IS THE PER-TICKET TELEMETRY: no issue event is appended under this\n# source, so `ralph status` and the digest cannot narrate a Jira iteration the way they do\n# a GitHub one.',
      '// makes the queue drain either way. What is still missing is a per-ticket telemetry\n// event (#131): nothing appends one under this source, so `ralph status` and the digest\n// have no per-iteration record of a Jira run to narrate.',
      '    # What is still missing is per-ticket telemetry (#131): no RALPH_ISSUE_EVENT line\n    # is appended under this source, which is why nothing here reads `claude_failed`\n    # even now that the outcome is known.',
      // The future-tense promise, and the reader-facing denial in lib/progress.js — the two
      // copies that named neither the telemetry nor Jira, and so were invisible to a grep
      // for either.
      '    # block sits in the gap between the two, reading `$outcome` — which is where #131\n    # will put this arm’s, so the split stays where the twin keeps it.',
      '    // No key: lib/issue-event.js records `issue_number` and nothing else to name a task\n    // by, so a CLOSED row has none',
    ]
    for (const sentence of deleted) {
      const text = claimText(sentence)
      expect(
        JIRA_UNRECORDED_CLAIM_PATTERNS.some((p) => p.test(text)),
        sentence,
      ).toBe(true)
    }
  })
})
