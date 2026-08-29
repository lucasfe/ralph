import { describe, it, expect } from 'vitest'
import { resolveSource, VALID_SOURCES, DEFAULT_SOURCE } from './task-source.js'

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

  // #125: jira is the third NAMABLE source. Nothing resolves a ticket yet — this
  // resolver's whole job is that `TASK_SOURCE=jira` stops being a typo, so the
  // dependency check and `ralph doctor` can be asked what a Jira run needs. The
  // trimming/case rules are asserted here rather than assumed from the shared
  // code path: they are what a hand-edited ralph.config.sh actually exercises.
  it('returns jira for a jira value (case-insensitive, trimmed)', () => {
    expect(resolveSource({ TASK_SOURCE: 'jira' })).toBe('jira')
    expect(resolveSource({ TASK_SOURCE: 'JIRA' })).toBe('jira')
    expect(resolveSource({ TASK_SOURCE: '  Jira  ' })).toBe('jira')
    expect(resolveSource({ TASK_SOURCE: '\tjIrA\n' })).toBe('jira')
  })

  it('falls back to github on an unrecognized value', () => {
    expect(resolveSource({ TASK_SOURCE: 'gitlab' })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: 'nonsense' })).toBe('github')
    // #125: a near-miss on the NEW value falls back like any other typo — adding
    // a source must not make its neighbours resolvable.
    expect(resolveSource({ TASK_SOURCE: 'jiras' })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: 'jra' })).toBe('github')
  })

  it('exposes the valid source list', () => {
    expect(VALID_SOURCES).toEqual(['github', 'folder', 'jira'])
  })

  it('keeps github as the DEFAULT even though a third source exists (#125)', () => {
    // The zero-regression promise, restated where it can break: a new member of
    // VALID_SOURCES must not move DEFAULT_SOURCE, or every repo with no
    // TASK_SOURCE line changes behaviour on upgrade.
    expect(DEFAULT_SOURCE).toBe('github')
    expect(resolveSource({})).toBe(DEFAULT_SOURCE)
  })
})
