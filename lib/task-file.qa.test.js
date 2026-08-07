import { describe, it, expect } from 'vitest'
import { parseTaskFile, taskIdFromFilename, nextTaskNumber } from './task-file.js'

// QA augmentation for #565. The dev's task-file.test.js locks the happy paths
// (comma/bracket labels, no-frontmatter, quoted title, next-number max+1). These
// adversarial cases attack the parser's robustness against real-world task files
// an author (or an editor on Windows) will actually produce.

describe('parseTaskFile — adversarial frontmatter (#565 QA)', () => {
  it('BUG: CRLF line endings must not silently drop title/labels', () => {
    // A `.md` authored on Windows (or via a cross-platform editor) uses \r\n.
    // src.split('\n') then leaves a trailing \r on every line, so the closing
    // fence still matches (trim()) BUT the `key: value` regex is anchored with
    // $ and the trailing \r defeats the `(.*)` capture's tail — title/labels are
    // silently lost while the body still parses. That is a data-loss defect: the
    // task's human-readable title vanishes from telemetry.
    const text = [
      '---',
      'title: Fix the login button',
      'labels: bug, ui',
      '---',
      '',
      'The body survives.',
    ].join('\r\n')
    const parsed = parseTaskFile(text)
    expect(parsed.title).toBe('Fix the login button')
    expect(parsed.labels).toEqual(['bug', 'ui'])
  })

  it('does not over-split on a `---` that appears inside the body', () => {
    const text = ['---', 'title: T', '---', 'intro', '---', 'outro'].join('\n')
    const parsed = parseTaskFile(text)
    expect(parsed.title).toBe('T')
    expect(parsed.body).toBe('intro\n---\noutro')
  })

  it('frontmatter present but no title → empty title, body preserved', () => {
    const text = ['---', 'labels: bug', '---', 'the work'].join('\n')
    const parsed = parseTaskFile(text)
    expect(parsed.title).toBe('')
    expect(parsed.labels).toEqual(['bug'])
    expect(parsed.body).toBe('the work')
  })

  it('an unterminated frontmatter fence yields no title and the whole text as body', () => {
    const text = ['---', 'title: never closes', 'still going'].join('\n')
    const parsed = parseTaskFile(text)
    expect(parsed.title).toBe('')
    expect(parsed.body).toBe('---\ntitle: never closes\nstill going')
  })

  it('an empty file yields empty title/labels/body', () => {
    const parsed = parseTaskFile('')
    expect(parsed).toEqual({ title: '', labels: [], body: '' })
  })

  it('handles a nullish input without throwing', () => {
    expect(parseTaskFile(null)).toEqual({ title: '', labels: [], body: '' })
    expect(parseTaskFile(undefined)).toEqual({ title: '', labels: [], body: '' })
  })

  it('strips quotes from bracketed and quoted label entries', () => {
    const text = ['---', 'title: T', 'labels: ["bug", \'ui\']', '---', 'b'].join('\n')
    expect(parseTaskFile(text).labels).toEqual(['bug', 'ui'])
  })

  it('an empty bracketed labels list [] is an empty array (not [""])', () => {
    const text = ['---', 'title: T', 'labels: []', '---', 'b'].join('\n')
    expect(parseTaskFile(text).labels).toEqual([])
  })

  it('ignores a non-frontmatter line that merely starts with text before ---', () => {
    // First line is not a fence, so there is no frontmatter at all.
    const text = ['not a fence', '---', 'title: T', '---'].join('\n')
    const parsed = parseTaskFile(text)
    expect(parsed.title).toBe('')
  })
})

describe('taskIdFromFilename — adversarial (#565 QA)', () => {
  it('reads leading zeros as the decimal value (007-x.md → 7, not octal)', () => {
    expect(taskIdFromFilename('007-x.md')).toBe(7)
    expect(taskIdFromFilename('012-y.md')).toBe(12)
  })

  it('pure-number filename resolves to that number', () => {
    expect(taskIdFromFilename('12.md')).toBe(12)
    expect(taskIdFromFilename('0.md')).toBe(0)
  })

  it('returns null for garbage / no leading digit', () => {
    expect(taskIdFromFilename('v2-thing.md')).toBe(null)
    expect(taskIdFromFilename('   3-space.md')).toBe(null)
    expect(taskIdFromFilename(null)).toBe(null)
    expect(taskIdFromFilename(undefined)).toBe(null)
  })

  it('reads the leading integer even with no separator/extension', () => {
    expect(taskIdFromFilename('99')).toBe(99)
  })
})

describe('nextTaskNumber — never reuse a number (#565 QA)', () => {
  it('a gap in numbering yields max+1, not count+1', () => {
    expect(nextTaskNumber(['001-a.md', '005-e.md'])).toBe(6)
  })

  it('the highest number in a TERMINAL lane (done/failed) is still counted — never reused', () => {
    const dirs = {
      'afk/todo': ['001-a.md'],
      'afk/done': ['099-z.md'],
      'afk/failed': ['050-m.md'],
      'hitl/todo': ['007-g.md'],
    }
    expect(nextTaskNumber(dirs)).toBe(100)
  })

  it('a duplicate number across two lanes does not inflate the next number', () => {
    expect(nextTaskNumber({ a: ['003-x.md'], b: ['003-y.md'] })).toBe(4)
  })

  it('zero-padded and unpadded numbers compare by value, not string', () => {
    // '9-a.md' > '010-b.md' lexically, but 10 > 9 numerically.
    expect(nextTaskNumber(['9-a.md', '010-b.md'])).toBe(11)
  })

  it('a listing of only non-numbered files yields 1', () => {
    expect(nextTaskNumber(['README.md', 'notes.md'])).toBe(1)
  })

  it('tolerates junk shapes in the map (non-array values are ignored)', () => {
    expect(nextTaskNumber({ a: ['004-d.md'], b: null, c: 'nope', d: 42 })).toBe(5)
  })

  it('a null/garbage listing yields 1 without throwing', () => {
    expect(nextTaskNumber(null)).toBe(1)
    expect(nextTaskNumber(undefined)).toBe(1)
    expect(nextTaskNumber('nope')).toBe(1)
  })
})
