import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import {
  queueCount,
  queuePick,
  locateTask,
  startTask,
  completeTask,
  failTask,
} from './folder-queue.js'

// QA augmentation for #565. The dev's folder-queue.test.js locks the happy-path
// mechanics. These tests attack the FORWARD-PROGRESS invariants — the queue must
// always drain, a task must never be silently lost, and the move state machine
// must be idempotent under the exact sequences the bash loop drives.

const ROOT = '/repo/.ralph/tasks'

function volWith(files = {}) {
  const json = {}
  for (const [rel, body] of Object.entries(files)) {
    json[`${ROOT}/${rel}`] = body
  }
  const vol = Volume.fromJSON(json)
  for (const d of ['afk/todo', 'afk/in-progress', 'afk/done', 'afk/failed', 'hitl/todo']) {
    vol.mkdirSync(`${ROOT}/${d}`, { recursive: true })
  }
  return vol
}

describe('queuePick — ordering & selection edge cases (#565 QA)', () => {
  it('orders by numeric value, not string (2 before 10)', () => {
    const vol = volWith({ 'afk/todo/10-j.md': 'x', 'afk/todo/2-b.md': 'y' })
    expect(queuePick(ROOT, { fs: vol }).id).toBe(2)
  })

  it('zero-padded vs unpadded compare numerically (009 before 010, 2 before 010)', () => {
    const vol = volWith({
      'afk/todo/010-b.md': 'x',
      'afk/todo/009-a.md': 'y',
      'afk/todo/2-c.md': 'z',
    })
    expect(queuePick(ROOT, { fs: vol }).id).toBe(2)
  })

  it('skips a non-numbered .md and picks the lowest numbered one', () => {
    const vol = volWith({ 'afk/todo/README.md': 'x', 'afk/todo/002-b.md': 'y' })
    const pick = queuePick(ROOT, { fs: vol })
    expect(pick.id).toBe(2)
    expect(pick.file).toBe('002-b.md')
  })

  it('returns null when afk/todo holds only non-numbered .md files', () => {
    const vol = volWith({ 'afk/todo/README.md': 'x' })
    expect(queuePick(ROOT, { fs: vol })).toBe(null)
  })

  it('does NOT pick a task sitting in the hitl lane (afk-only queue)', () => {
    const vol = volWith({ 'hitl/todo/001-h.md': 'x' })
    expect(queuePick(ROOT, { fs: vol })).toBe(null)
    expect(queueCount(ROOT, { fs: vol })).toBe(0)
  })
})

describe('failTask — the forward-progress sweep (#565 QA, stories 16/18/19)', () => {
  it('sweeps a stuck in-progress task → failed (agent crashed mid-task)', () => {
    const vol = volWith({ 'afk/in-progress/003-c.md': 'body' })
    expect(failTask(ROOT, 3, { fs: vol })).toBe(true)
    expect(vol.existsSync(`${ROOT}/afk/in-progress/003-c.md`)).toBe(false)
    expect(vol.existsSync(`${ROOT}/afk/failed/003-c.md`)).toBe(true)
  })

  it('sweeps a never-started todo task → failed (agent exited 0 but did nothing)', () => {
    const vol = volWith({ 'afk/todo/004-d.md': 'body' })
    expect(failTask(ROOT, 4, { fs: vol })).toBe(true)
    expect(vol.existsSync(`${ROOT}/afk/todo/004-d.md`)).toBe(false)
    expect(vol.existsSync(`${ROOT}/afk/failed/004-d.md`)).toBe(true)
  })

  it('is a no-op (returns false) for a task ALREADY in failed — never double-moves', () => {
    const vol = volWith({ 'afk/failed/006-f.md': 'x' })
    expect(failTask(ROOT, 6, { fs: vol })).toBe(false)
    expect(vol.existsSync(`${ROOT}/afk/failed/006-f.md`)).toBe(true)
  })

  it('returns false for an unknown id (nothing to sweep, no crash)', () => {
    const vol = volWith({})
    expect(failTask(ROOT, 999, { fs: vol })).toBe(false)
  })

  it('preserves the file BODY when sweeping (no data loss on failure)', () => {
    const vol = volWith({ 'afk/in-progress/007-g.md': 'the original body' })
    failTask(ROOT, 7, { fs: vol })
    expect(vol.readFileSync(`${ROOT}/afk/failed/007-g.md`, 'utf8')).toBe('the original body')
  })
})

describe('move state machine — idempotency & guards (#565 QA)', () => {
  it('a full lifecycle todo→in-progress→done leaves exactly one copy in done', () => {
    const vol = volWith({ 'afk/todo/001-a.md': 'body' })
    expect(startTask(ROOT, 1, { fs: vol })).toBe(true)
    expect(completeTask(ROOT, 1, { fs: vol })).toBe(true)
    expect(vol.existsSync(`${ROOT}/afk/todo/001-a.md`)).toBe(false)
    expect(vol.existsSync(`${ROOT}/afk/in-progress/001-a.md`)).toBe(false)
    expect(vol.existsSync(`${ROOT}/afk/done/001-a.md`)).toBe(true)
    // Re-running a move whose source is now empty is a safe no-op.
    expect(startTask(ROOT, 1, { fs: vol })).toBe(false)
    expect(completeTask(ROOT, 1, { fs: vol })).toBe(false)
  })

  it('completeTask on a todo task (not yet started) is a no-op — wrong source lane', () => {
    const vol = volWith({ 'afk/todo/002-b.md': 'x' })
    expect(completeTask(ROOT, 2, { fs: vol })).toBe(false)
    expect(vol.existsSync(`${ROOT}/afk/todo/002-b.md`)).toBe(true)
    expect(vol.existsSync(`${ROOT}/afk/done/002-b.md`)).toBe(false)
  })

  it('mkdir -p: moves succeed even when destination dirs do not exist yet', () => {
    // A tree with only the source file — no status dirs pre-created.
    const vol = Volume.fromJSON({ [`${ROOT}/afk/in-progress/005-e.md`]: 'body' })
    expect(completeTask(ROOT, 5, { fs: vol })).toBe(true)
    expect(vol.existsSync(`${ROOT}/afk/done/005-e.md`)).toBe(true)
  })

  it('locate scans all afk statuses and reports the current one', () => {
    const vol = volWith({ 'afk/in-progress/008-h.md': 'x' })
    expect(locateTask(ROOT, 8, { fs: vol })).toBe('in-progress')
    completeTask(ROOT, 8, { fs: vol })
    expect(locateTask(ROOT, 8, { fs: vol })).toBe('done')
  })
})

describe('queueCount — degradation (#565 QA)', () => {
  it('counts every .md in afk/todo including non-numbered (raw file count)', () => {
    const vol = volWith({
      'afk/todo/001-a.md': 'x',
      'afk/todo/002-b.md': 'y',
      'afk/todo/README.md': 'z',
    })
    expect(queueCount(ROOT, { fs: vol })).toBe(3)
  })

  it('returns 0 when the whole tree is missing (never throws)', () => {
    expect(queueCount(ROOT, { fs: Volume.fromJSON({}) })).toBe(0)
  })
})
