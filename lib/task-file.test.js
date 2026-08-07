import { describe, it, expect } from 'vitest'
import { parseTaskFile, taskIdFromFilename, nextTaskNumber } from './task-file.js'

describe('parseTaskFile — YAML-ish frontmatter + markdown body (#565)', () => {
  it('extracts title, labels (comma list), and body', () => {
    const text = [
      '---',
      'title: Fix the login button',
      'labels: bug, ui',
      '---',
      '',
      'The login button does nothing when clicked.',
      '',
      'Steps to reproduce: click it.',
    ].join('\n')
    const parsed = parseTaskFile(text)
    expect(parsed.title).toBe('Fix the login button')
    expect(parsed.labels).toEqual(['bug', 'ui'])
    expect(parsed.body).toBe(
      'The login button does nothing when clicked.\n\nSteps to reproduce: click it.',
    )
  })

  it('parses labels given as a bracketed list [a, b]', () => {
    const text = ['---', 'title: T', 'labels: [bug, ui, perf]', '---', 'body'].join('\n')
    const parsed = parseTaskFile(text)
    expect(parsed.labels).toEqual(['bug', 'ui', 'perf'])
  })

  it('treats labels as optional — empty array when absent', () => {
    const text = ['---', 'title: No labels here', '---', 'the body'].join('\n')
    const parsed = parseTaskFile(text)
    expect(parsed.title).toBe('No labels here')
    expect(parsed.labels).toEqual([])
    expect(parsed.body).toBe('the body')
  })

  it('strips surrounding quotes from the title value', () => {
    const text = ['---', 'title: "Quoted title"', '---', 'b'].join('\n')
    expect(parseTaskFile(text).title).toBe('Quoted title')
  })

  it('tolerates a file with no frontmatter — whole text is the body', () => {
    const text = 'just a plain body with no frontmatter'
    const parsed = parseTaskFile(text)
    expect(parsed.title).toBe('')
    expect(parsed.labels).toEqual([])
    expect(parsed.body).toBe('just a plain body with no frontmatter')
  })

  it('drops empty label entries from a trailing comma', () => {
    const text = ['---', 'title: T', 'labels: bug, , ui,', '---', 'b'].join('\n')
    expect(parseTaskFile(text).labels).toEqual(['bug', 'ui'])
  })
})

describe('taskIdFromFilename — leading integer identity (#565)', () => {
  it('reads the leading integer from a numbered filename', () => {
    expect(taskIdFromFilename('001-fix-login.md')).toBe(1)
    expect(taskIdFromFilename('42-do-thing.md')).toBe(42)
    expect(taskIdFromFilename('7.md')).toBe(7)
  })

  it('returns null when the filename has no leading integer', () => {
    expect(taskIdFromFilename('fix-login.md')).toBe(null)
    expect(taskIdFromFilename('')).toBe(null)
    expect(taskIdFromFilename('-3-neg.md')).toBe(null)
  })
})

describe('nextTaskNumber — max(N)+1 across all listings (#565)', () => {
  it('returns 1 for an empty listing', () => {
    expect(nextTaskNumber([])).toBe(1)
  })

  it('scans all filenames and takes max+1', () => {
    const listing = ['001-a.md', '003-c.md', '002-b.md', 'notes.txt']
    expect(nextTaskNumber(listing)).toBe(4)
  })

  it('ignores non-numbered files', () => {
    expect(nextTaskNumber(['readme.md', 'todo.md'])).toBe(1)
  })

  it('accepts a map of directory → filenames and scans across both lanes', () => {
    const dirs = {
      'afk/todo': ['005-e.md'],
      'afk/done': ['010-j.md'],
      'hitl/todo': ['007-g.md'],
    }
    expect(nextTaskNumber(dirs)).toBe(11)
  })
})
