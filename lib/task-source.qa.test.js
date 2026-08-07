import { describe, it, expect } from 'vitest'
import { resolveSource } from './task-source.js'

// QA augmentation for #565. The dev's task-source.test.js locks the core
// normalization. These tests attack the "a typo must never abort a run" contract
// with the adversarial inputs a hand-edited ralph.config.sh / stray env var can
// actually produce. The invariant: resolveSource ALWAYS returns a member of
// VALID_SOURCES, defaulting to 'github', and never throws.

describe('resolveSource — adversarial values always resolve safely (#565 QA)', () => {
  it('mixed-case and padded folder values normalize to folder', () => {
    expect(resolveSource({ TASK_SOURCE: 'Folder' })).toBe('folder')
    expect(resolveSource({ TASK_SOURCE: 'FoLdEr' })).toBe('folder')
    expect(resolveSource({ TASK_SOURCE: '\tfolder\n' })).toBe('folder')
  })

  it('near-miss / typo values fall back to github (never abort)', () => {
    for (const v of ['git', 'gitlab', 'folders', 'fold', 'local', 'gh', 'file']) {
      expect(resolveSource({ TASK_SOURCE: v })).toBe('github')
    }
  })

  it('non-string TASK_SOURCE values fall back to github without throwing', () => {
    expect(resolveSource({ TASK_SOURCE: 123 })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: true })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: null })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: {} })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: [] })).toBe('github')
  })

  it('a nullish env object resolves to github', () => {
    expect(resolveSource(null)).toBe('github')
    expect(resolveSource(undefined)).toBe('github')
  })

  it('the result is ALWAYS a valid source for arbitrary garbage', () => {
    const garbage = ['', '   ', 'GITHUB', 'GitHub', 'x'.repeat(500), '\0', '../folder']
    for (const g of garbage) {
      expect(['github', 'folder']).toContain(resolveSource({ TASK_SOURCE: g }))
    }
  })
})
