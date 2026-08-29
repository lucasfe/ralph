import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { beginRun, beginTask, endRun, readRunState, runStatePath } from './run-state.js'
import { statePath } from './state.js'

const ROOT = '/repo'
const PATH = `${ROOT}/.ralph/run-state.json`

function vol(json = {}) {
  return Volume.fromJSON(json)
}

function record(v) {
  return JSON.parse(v.readFileSync(PATH, 'utf8').toString())
}

describe('runStatePath — the file this module owns (#55)', () => {
  it('lives under .ralph/ and is NOT state.json (the config-hash/validation file)', () => {
    expect(runStatePath(ROOT)).toBe(PATH)
    expect(runStatePath(ROOT)).not.toBe(statePath(ROOT))
  })
})

describe('beginRun — the run record (#55)', () => {
  it('writes a running record with the run id, session, source and queue depth', () => {
    const v = vol()
    beginRun(
      ROOT,
      {
        runId: 'ralph-repo-abc-1756000000',
        session: 'ralph-repo-abc',
        source: 'github',
        queueDepth: 6,
        startedAt: '2026-08-25T16:20:00.000Z',
      },
      v,
    )
    expect(record(v)).toMatchObject({
      run_id: 'ralph-repo-abc-1756000000',
      session: 'ralph-repo-abc',
      source: 'github',
      status: 'running',
      started_at: '2026-08-25T16:20:00.000Z',
      queue_at_start: 6,
      current: null,
    })
  })

  it('creates .ralph/ when it does not exist yet', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'r', session: 's', source: 'folder', queueDepth: 1 }, v)
    expect(v.existsSync(PATH)).toBe(true)
  })

  it('coerces a bash-supplied string queue depth to a number, and an empty one to null', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'r', session: 's', source: 'github', queueDepth: '6' }, v)
    expect(record(v).queue_at_start).toBe(6)
    beginRun(ROOT, { runId: 'r', session: 's', source: 'github', queueDepth: '' }, v)
    expect(record(v).queue_at_start).toBe(null)
  })

  it('starts a fresh record: a second run does not inherit the previous run’s task', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'run-1', session: 's', source: 'github', queueDepth: 2 }, v)
    beginTask(ROOT, { number: 31, iteration: 1 }, v)
    beginRun(ROOT, { runId: 'run-2', session: 's', source: 'github', queueDepth: 5 }, v)
    expect(record(v)).toMatchObject({ run_id: 'run-2', status: 'running', current: null })
  })

  it('defaults started_at to now when the caller does not supply one', () => {
    const v = vol()
    const before = Date.now()
    beginRun(ROOT, { runId: 'r', session: 's', source: 'github', queueDepth: 0 }, v)
    const stamped = Date.parse(record(v).started_at)
    expect(stamped).toBeGreaterThanOrEqual(before - 1000)
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000)
  })
})

describe('beginTask — the in-flight task (#55)', () => {
  it('records the task number, its start and the iteration index without losing run fields', () => {
    const v = vol()
    beginRun(
      ROOT,
      { runId: 'run-1', session: 'sess', source: 'github', queueDepth: 6, startedAt: '2026-08-25T16:20:00.000Z' },
      v,
    )
    beginTask(ROOT, { number: 31, iteration: 3, startedAt: '2026-08-25T19:00:00.000Z' }, v)
    expect(record(v)).toMatchObject({
      run_id: 'run-1',
      session: 'sess',
      source: 'github',
      status: 'running',
      started_at: '2026-08-25T16:20:00.000Z',
      queue_at_start: 6,
      current: { number: 31, started_at: '2026-08-25T19:00:00.000Z', iteration: 3 },
    })
  })

  it('replaces the previous task on the next iteration', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'r', session: 's', source: 'github', queueDepth: 2 }, v)
    beginTask(ROOT, { number: 31, iteration: 1 }, v)
    beginTask(ROOT, { number: 32, iteration: 2 }, v)
    expect(record(v).current).toMatchObject({ number: 32, iteration: 2 })
  })

  it('coerces bash-supplied strings to numbers', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'r', session: 's', source: 'github', queueDepth: 2 }, v)
    beginTask(ROOT, { number: '031', iteration: '4' }, v)
    expect(record(v).current).toMatchObject({ number: 31, iteration: 4 })
  })

  it('writes a usable record even when begin never ran (a lost begin must not lose the task)', () => {
    const v = vol()
    beginTask(ROOT, { number: 7, iteration: 1 }, v)
    expect(record(v)).toMatchObject({ status: 'running', current: { number: 7, iteration: 1 } })
  })
})

// #127 — a jira run's in-flight task has a NAME, and `number` alone cannot hold it. The
// record has carried a numeric `number` since #55 and every reader was written against an
// integer, so the key is recorded BESIDE it rather than instead of it: `.ralph/run-state.json`
// names the real ticket, and nothing that reads the number changes.
describe('beginTask — the in-flight task’s Jira key (#127)', () => {
  it('records task_key beside the number, and derives the number from the key', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'r', session: 's', source: 'jira', queueDepth: 4 }, v)
    // What bash passes in jira mode: no number (it has none — `''` is the record's
    // documented "unknown") and the key acli named.
    beginTask(ROOT, { number: '', iteration: '1', taskKey: 'FOO-123' }, v)
    expect(record(v).current).toMatchObject({
      number: 123,
      task_key: 'FOO-123',
      iteration: 1,
    })
  })

  it('keeps task_key null for the github and folder sources, which have no key', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'r', session: 's', source: 'github', queueDepth: 2 }, v)
    beginTask(ROOT, { number: '31', iteration: '1' }, v)
    expect(record(v).current).toMatchObject({ number: 31, task_key: null })
    // Bash passes every argument as a string, and an absent 4th one arrives as ''.
    beginTask(ROOT, { number: '32', iteration: '2', taskKey: '' }, v)
    expect(record(v).current).toMatchObject({ number: 32, task_key: null })
  })

  it('normalizes the key, and records an unrecognised one verbatim', () => {
    const v = vol()
    beginTask(ROOT, { number: '', iteration: '1', taskKey: '  foo-123  ' }, v)
    expect(record(v).current).toMatchObject({ number: 123, task_key: 'FOO-123' })
    // A project key Ralph's grammar does not recognise still names the ticket — the record
    // says so, and simply has no number to offer.
    beginTask(ROOT, { number: '', iteration: '2', taskKey: 'FOO-BAR-1' }, v)
    expect(record(v).current).toMatchObject({ number: null, task_key: 'FOO-BAR-1' })
  })

  it('an EXPLICIT number wins over the key’s — the caller measured, the grammar guessed', () => {
    const v = vol()
    beginTask(ROOT, { number: '99', iteration: '1', taskKey: 'FOO-123' }, v)
    expect(record(v).current).toMatchObject({ number: 99, task_key: 'FOO-123' })
  })

  it('leaves the existing numeric field valid: still a number or null, never a string', () => {
    const v = vol()
    for (const [number, taskKey] of [
      ['', 'FOO-123'],
      ['', 'FOO-BAR-1'],
      ['31', ''],
      ['', ''],
    ]) {
      beginTask(ROOT, { number, iteration: '1', taskKey }, v)
      const { number: written } = record(v).current
      expect(written === null || typeof written === 'number', `${number}/${taskKey}`).toBe(true)
    }
  })
})

describe('endRun — the terminal record (#55)', () => {
  it('records the terminal status, finished_at and the ok/failed counts', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'run-1', session: 's', source: 'github', queueDepth: 3 }, v)
    beginTask(ROOT, { number: 31, iteration: 1 }, v)
    endRun(ROOT, { status: 'partial', ok: 2, failed: 1, finishedAt: '2026-08-25T20:00:00.000Z' }, v)
    expect(record(v)).toMatchObject({
      run_id: 'run-1',
      status: 'partial',
      finished_at: '2026-08-25T20:00:00.000Z',
      ok: 2,
      failed: 1,
    })
  })

  it('keeps the last task on the record (it is the run’s last known work)', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'r', session: 's', source: 'folder', queueDepth: 1 }, v)
    beginTask(ROOT, { number: 12, iteration: 1 }, v)
    endRun(ROOT, { status: 'success', ok: 1, failed: 0 }, v)
    expect(record(v).current).toMatchObject({ number: 12 })
  })

  it('coerces bash-supplied counts and defaults finished_at to now', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'r', session: 's', source: 'github', queueDepth: 1 }, v)
    const before = Date.now()
    endRun(ROOT, { status: 'failed', ok: '0', failed: '1' }, v)
    const r = record(v)
    expect(r.ok).toBe(0)
    expect(r.failed).toBe(1)
    expect(Date.parse(r.finished_at)).toBeGreaterThanOrEqual(before - 1000)
  })
})

describe('readRunState — never throws (#55)', () => {
  it('round-trips the record written by beginRun', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'run-1', session: 's', source: 'github', queueDepth: 4 }, v)
    expect(readRunState(ROOT, v)).toMatchObject({ run_id: 'run-1', status: 'running' })
  })

  it('returns null when the file is missing', () => {
    expect(readRunState(ROOT, vol())).toBe(null)
  })

  it('returns null on an empty file', () => {
    expect(readRunState(ROOT, vol({ [PATH]: '' }))).toBe(null)
  })

  it('returns null on a truncated write (half a JSON object)', () => {
    expect(readRunState(ROOT, vol({ [PATH]: '{"run_id":"run-1","stat' }))).toBe(null)
  })

  it('returns null on malformed JSON', () => {
    expect(readRunState(ROOT, vol({ [PATH]: 'not json at all' }))).toBe(null)
  })

  it('returns null on valid JSON that is not an object (array / scalar / null)', () => {
    expect(readRunState(ROOT, vol({ [PATH]: '[]' }))).toBe(null)
    expect(readRunState(ROOT, vol({ [PATH]: '42' }))).toBe(null)
    expect(readRunState(ROOT, vol({ [PATH]: 'null' }))).toBe(null)
  })

  it('returns null when the read itself fails (unreadable path)', () => {
    const hostile = {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error('EACCES')
      },
    }
    expect(readRunState(ROOT, hostile)).toBe(null)
  })
})
