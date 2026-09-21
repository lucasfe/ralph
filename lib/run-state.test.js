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

// #222 — WHICH DIRECTORY IS RALPH WORKING IN? Since #218 every task runs in its own git
// worktree under `.ralph/worktrees/`, and until this slice nothing on disk said which one:
// a detached run left the reader to guess, or to run `git worktree list` and match by hand.
// The path is recorded BESIDE the task, like #127's key, and for the same reason: the loop
// MEASURED it (lib/worktree.js printed the path it created), and deriving
// `<root>/.ralph/worktrees/issue-<number>` here would replace that fact with a guess — one
// that is already wrong for the folder source, whose handle is `task-<number>`, and wrong
// again for an iteration whose worktree could not be created at all.
describe('beginTask — the in-flight worktree (#222)', () => {
  const WORKTREE = '/repo/.ralph/worktrees/issue-31'

  it('records the worktree beside the task, without losing the run fields', () => {
    const v = vol()
    beginRun(
      ROOT,
      { runId: 'run-1', session: 'sess', source: 'github', queueDepth: 6, startedAt: '2026-08-25T16:20:00.000Z' },
      v,
    )
    beginTask(ROOT, { number: 31, iteration: 3, worktree: WORKTREE }, v)
    expect(record(v)).toMatchObject({
      run_id: 'run-1',
      session: 'sess',
      status: 'running',
      queue_at_start: 6,
      current: { number: 31, iteration: 3, worktree: WORKTREE },
    })
  })

  it('keeps worktree null for an iteration that has none, and the field always exists', () => {
    // The two shapes of "no worktree", and neither may become a fabricated path. Bash
    // delivers an absent 5th argument as `''` — the record's documented unknown — and an
    // iteration that failed BEFORE the worktree existed (the loop's abort path records the
    // task it died on) passes exactly that. Present-and-null rather than absent, so both
    // renderers may key on `worktree === null` instead of on `'worktree' in current`.
    const v = vol()
    for (const worktree of [undefined, '', '   ', null]) {
      beginTask(ROOT, { number: 31, iteration: 1, worktree }, v)
      expect(record(v).current.worktree, String(worktree)).toBe(null)
      expect('worktree' in record(v).current, String(worktree)).toBe(true)
    }
  })

  it('records the path VERBATIM — a directory is an identity, not prose', () => {
    // No trimming, no normalizing, no shortening: the value's only consumer is somebody
    // (or something) that will `cd` into it, and a tidied path names no directory. Blank
    // is decided on the trimmed text above and everything else lands as it arrived — the
    // rule `task_key` already follows.
    const v = vol()
    for (const path of [
      '/repo/.ralph/worktrees/task-2',
      '/Users/someone/my repo/.ralph/worktrees/issue-7',
      '/repo/.ralph/worktrees/issue-31/',
      'relative/.ralph/worktrees/issue-9',
    ]) {
      beginTask(ROOT, { number: 9, iteration: 1, worktree: path }, v)
      expect(record(v).current.worktree, path).toBe(path)
    }
  })

  it('replaces the previous iteration’s worktree, and can drop it again', () => {
    // One record per run, rewritten every iteration: a task that got a worktree must not
    // leave its path behind for the next task, which is the stale-directory reading a
    // merge — rather than this module's whole-`current` rewrite — would produce.
    const v = vol()
    beginTask(ROOT, { number: 31, iteration: 1, worktree: WORKTREE }, v)
    beginTask(ROOT, { number: 32, iteration: 2, worktree: '/repo/.ralph/worktrees/issue-32' }, v)
    expect(record(v).current).toMatchObject({ number: 32, worktree: '/repo/.ralph/worktrees/issue-32' })
    beginTask(ROOT, { number: 33, iteration: 3, worktree: '' }, v)
    expect(record(v).current).toMatchObject({ number: 33, worktree: null })
  })

  it('reads a record written before the field existed, and fills it in on the next update', () => {
    // The compatibility half of the slice. `.ralph/run-state.json` on a machine that
    // upgraded mid-run holds a `current` with four keys, and it must read as a RECORD
    // rather than as no record at all: readRunState hands back what is on disk verbatim,
    // so the field is simply absent and every reader's `?.worktree` answers undefined.
    const legacy = {
      schema: 1,
      run_id: 'run-1',
      session: 'sess',
      source: 'github',
      status: 'running',
      started_at: '2026-08-25T16:20:00.000Z',
      queue_at_start: 6,
      current: { number: 30, task_key: null, started_at: '2026-08-25T18:00:00.000Z', iteration: 2 },
    }
    const v = vol({ [PATH]: JSON.stringify(legacy, null, 2) + '\n' })
    const read = readRunState(ROOT, v)
    expect(read.current).toMatchObject({ number: 30, iteration: 2 })
    expect('worktree' in read.current).toBe(false)
    // ...and the next iteration's update fills the field in, keeping the run fields the
    // older writer left — the read-modify-write this module has done since #55.
    beginTask(ROOT, { number: 31, iteration: 3, worktree: WORKTREE }, v)
    expect(record(v)).toMatchObject({
      run_id: 'run-1',
      queue_at_start: 6,
      current: { number: 31, iteration: 3, worktree: WORKTREE },
    })
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
