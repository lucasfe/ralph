import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureIssueEvent } from './capture-issue-event.js'
import { metricsPath } from './issue-metrics.js'

// QA augmentation for #565. The dev's capture-issue-event.test.js locks the
// happy folder-mode paths. These attack the telemetry sidecar's "never break the
// loop, never call gh in folder mode" contract under adversarial inputs.

let workdir

function envFor(overrides = {}) {
  return {
    PROJECT_ROOT: workdir,
    RALPH_RUN_ID: 'ralph-abc-1718000000',
    RALPH_CLAUDE_EXIT: '0',
    RALPH_DEV_BRANCH: 'dev',
    RALPH_RAW_JSONL_PATH: join(workdir, 'logs', 'x.jsonl'),
    RALPH_STDERR_LOG_PATH: join(workdir, 'logs', 'x.log'),
    ...overrides,
  }
}

const folderEnv = (overrides = {}) =>
  envFor({ TASK_SOURCE: 'folder', RALPH_TASK_ID: '7', RALPH_TASK_OUTCOME: 'done', ...overrides })

function readEvents() {
  const p = metricsPath(workdir)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l.slice('RALPH_ISSUE_EVENT '.length)))
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-capture-qa-'))
  mkdirSync(join(workdir, 'logs'), { recursive: true })
})

afterEach(() => {
  if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true })
})

describe('captureIssueEvent — folder telemetry adversarial (#565 QA)', () => {
  it('folder mode NEVER calls the gh diff fetcher, even when it would throw', () => {
    const fetchDiffStats = () => {
      throw new Error('gh must not be called in folder mode')
    }
    // Must not throw and must still write a zeroed-diff event.
    expect(() =>
      captureIssueEvent({ env: folderEnv(), fetchDiffStats }),
    ).not.toThrow()
    const e = readEvents()[0]
    expect(e.files).toBe(0)
    expect(e.insertions).toBe(0)
    expect(e.deletions).toBe(0)
  })

  it('RALPH_TASK_OUTCOME verdict is case-insensitive (DONE → pass, FAILED → fail)', () => {
    captureIssueEvent({ env: folderEnv({ RALPH_TASK_OUTCOME: 'DONE' }), fetchDiffStats: () => ({}) })
    expect(readEvents()[0].verdict).toBe('pass')
  })

  it('the folder verdict override beats a stray claude-failed label', () => {
    captureIssueEvent({
      env: folderEnv({ RALPH_TASK_OUTCOME: 'done', RALPH_ISSUE_LABELS: 'claude-failed' }),
      fetchDiffStats: () => ({}),
    })
    // Even though a claude-failed label is present, the terminal-dir outcome wins.
    expect(readEvents()[0].verdict).toBe('pass')
  })

  it('a non-numeric RALPH_TASK_ID becomes a null issue_number (never NaN in JSON)', () => {
    captureIssueEvent({
      env: folderEnv({ RALPH_TASK_ID: 'not-a-number' }),
      fetchDiffStats: () => ({}),
    })
    const e = readEvents()[0]
    expect(e.issue_number).toBe(null)
  })

  it('reads RALPH_TASK_ID (not RALPH_ISSUE_NUMBER) as the number in folder mode', () => {
    captureIssueEvent({
      env: folderEnv({ RALPH_TASK_ID: '42', RALPH_ISSUE_NUMBER: '98' }),
      fetchDiffStats: () => ({}),
    })
    expect(readEvents()[0].issue_number).toBe(42)
  })

  it('a garbage TASK_SOURCE resolves to github and DOES read RALPH_ISSUE_NUMBER', () => {
    // resolveSource falls back to github; the sidecar then reads the issue number.
    let called = 0
    captureIssueEvent({
      env: envFor({ TASK_SOURCE: 'gitlab', RALPH_ISSUE_NUMBER: '55', RALPH_TASK_ID: '7' }),
      fetchDiffStats: () => {
        called++
        return { additions: 0, deletions: 0, changedFiles: 0 }
      },
    })
    expect(readEvents()[0].issue_number).toBe(55)
    expect(called).toBe(1)
  })

  it('a telemetry crash (unwritable project root) never throws out of the sidecar', () => {
    expect(() =>
      captureIssueEvent({
        env: folderEnv({ PROJECT_ROOT: '/nonexistent/\0/root' }),
        fetchDiffStats: () => ({}),
      }),
    ).not.toThrow()
  })
})
