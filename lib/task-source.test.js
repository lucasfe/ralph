import { describe, it, expect } from 'vitest'
import { resolveSource, VALID_SOURCES } from './task-source.js'

describe('resolveSource — TASK_SOURCE normalization (#565)', () => {
  it('defaults to github when TASK_SOURCE is unset/empty/whitespace', () => {
    expect(resolveSource({})).toBe('github')
    expect(resolveSource({ TASK_SOURCE: '' })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: '   ' })).toBe('github')
    expect(resolveSource()).toBe('github')
  })

  it('returns folder for a folder value (case-insensitive, trimmed)', () => {
    expect(resolveSource({ TASK_SOURCE: 'folder' })).toBe('folder')
    expect(resolveSource({ TASK_SOURCE: 'FOLDER' })).toBe('folder')
    expect(resolveSource({ TASK_SOURCE: '  Folder  ' })).toBe('folder')
  })

  it('returns github explicitly', () => {
    expect(resolveSource({ TASK_SOURCE: 'github' })).toBe('github')
  })

  it('falls back to github on an unrecognized value', () => {
    expect(resolveSource({ TASK_SOURCE: 'gitlab' })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: 'nonsense' })).toBe('github')
  })

  it('exposes the valid source list', () => {
    expect(VALID_SOURCES).toEqual(['github', 'folder'])
  })
})
