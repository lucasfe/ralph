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

const ROOT = '/repo/.ralph/tasks'

function volWith(files = {}) {
  // files: { 'afk/todo/001-a.md': 'body', ... } relative to ROOT
  const json = {}
  for (const [rel, body] of Object.entries(files)) {
    json[`${ROOT}/${rel}`] = body
  }
  // Ensure the standard lanes exist even when empty.
  const vol = Volume.fromJSON(json)
  for (const d of [
    'afk/todo',
    'afk/in-progress',
    'afk/done',
    'afk/failed',
    'hitl/todo',
  ]) {
    vol.mkdirSync(`${ROOT}/${d}`, { recursive: true })
  }
  return vol
}

describe('queueCount — files in afk/todo (#565)', () => {
  it('counts .md files in afk/todo', () => {
    const vol = volWith({ 'afk/todo/001-a.md': 'x', 'afk/todo/002-b.md': 'y' })
    expect(queueCount(ROOT, { fs: vol })).toBe(2)
  })

  it('returns 0 when afk/todo is empty', () => {
    const vol = volWith({})
    expect(queueCount(ROOT, { fs: vol })).toBe(0)
  })

  it('returns 0 when the tree does not exist yet', () => {
    const vol = Volume.fromJSON({})
    expect(queueCount(ROOT, { fs: vol })).toBe(0)
  })

  it('ignores non-.md files', () => {
    const vol = volWith({ 'afk/todo/001-a.md': 'x', 'afk/todo/notes.txt': 'y' })
    expect(queueCount(ROOT, { fs: vol })).toBe(1)
  })
})

describe('queuePick — lowest-numbered task in afk/todo (#565)', () => {
  it('picks the lowest-numbered task and returns id + path', () => {
    const vol = volWith({
      'afk/todo/003-c.md': 'x',
      'afk/todo/001-a.md': 'y',
      'afk/todo/002-b.md': 'z',
    })
    const pick = queuePick(ROOT, { fs: vol })
    expect(pick.id).toBe(1)
    expect(pick.path).toBe(`${ROOT}/afk/todo/001-a.md`)
    expect(pick.file).toBe('001-a.md')
  })

  it('returns null when the queue is empty', () => {
    expect(queuePick(ROOT, { fs: volWith({}) })).toBe(null)
  })

  it('returns null when the tree does not exist', () => {
    expect(queuePick(ROOT, { fs: Volume.fromJSON({}) })).toBe(null)
  })
})

describe('locateTask — which afk status dir holds a task (#565)', () => {
  it('finds a task in todo', () => {
    const vol = volWith({ 'afk/todo/005-e.md': 'x' })
    expect(locateTask(ROOT, 5, { fs: vol })).toBe('todo')
  })

  it('finds a task in done', () => {
    const vol = volWith({ 'afk/done/010-j.md': 'x' })
    expect(locateTask(ROOT, 10, { fs: vol })).toBe('done')
  })

  it('returns null for an unknown id', () => {
    expect(locateTask(ROOT, 99, { fs: volWith({}) })).toBe(null)
  })
})

describe('move helpers — start / complete / fail (#565)', () => {
  it('startTask moves todo → in-progress', () => {
    const vol = volWith({ 'afk/todo/001-a.md': 'body' })
    startTask(ROOT, 1, { fs: vol })
    expect(vol.existsSync(`${ROOT}/afk/todo/001-a.md`)).toBe(false)
    expect(vol.existsSync(`${ROOT}/afk/in-progress/001-a.md`)).toBe(true)
    expect(vol.readFileSync(`${ROOT}/afk/in-progress/001-a.md`, 'utf8')).toBe('body')
  })

  it('completeTask moves in-progress → done', () => {
    const vol = volWith({ 'afk/in-progress/002-b.md': 'body' })
    completeTask(ROOT, 2, { fs: vol })
    expect(vol.existsSync(`${ROOT}/afk/in-progress/002-b.md`)).toBe(false)
    expect(vol.existsSync(`${ROOT}/afk/done/002-b.md`)).toBe(true)
  })

  it('failTask sweeps a stuck in-progress task → failed', () => {
    const vol = volWith({ 'afk/in-progress/003-c.md': 'body' })
    failTask(ROOT, 3, { fs: vol })
    expect(vol.existsSync(`${ROOT}/afk/in-progress/003-c.md`)).toBe(false)
    expect(vol.existsSync(`${ROOT}/afk/failed/003-c.md`)).toBe(true)
  })

  it('failTask sweeps a never-started todo task → failed (no-op sweep)', () => {
    const vol = volWith({ 'afk/todo/004-d.md': 'body' })
    failTask(ROOT, 4, { fs: vol })
    expect(vol.existsSync(`${ROOT}/afk/todo/004-d.md`)).toBe(false)
    expect(vol.existsSync(`${ROOT}/afk/failed/004-d.md`)).toBe(true)
  })

  it('creates a missing destination status dir defensively', () => {
    // Volume without the standard lanes — startTask must mkdir -p as needed.
    const vol = Volume.fromJSON({ [`${ROOT}/afk/todo/001-a.md`]: 'body' })
    startTask(ROOT, 1, { fs: vol })
    expect(vol.existsSync(`${ROOT}/afk/in-progress/001-a.md`)).toBe(true)
  })

  it('move helpers return true on success, false when the task is not found', () => {
    const vol = volWith({ 'afk/todo/001-a.md': 'body' })
    expect(startTask(ROOT, 1, { fs: vol })).toBe(true)
    expect(completeTask(ROOT, 999, { fs: vol })).toBe(false)
  })
})
