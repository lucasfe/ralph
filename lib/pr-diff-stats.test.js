import { describe, it, expect } from 'vitest'
import { fetchPrDiffStats } from './pr-diff-stats.js'

const ZERO = { additions: 0, deletions: 0, changedFiles: 0 }

describe('fetchPrDiffStats', () => {
  it('parses additions/deletions/changedFiles from the first PR in the JSON array', () => {
    const exec = () =>
      JSON.stringify([
        { additions: 42, deletions: 7, changedFiles: 3 },
        { additions: 999, deletions: 999, changedFiles: 999 },
      ])
    const stats = fetchPrDiffStats(530, { exec })
    expect(stats).toEqual({ additions: 42, deletions: 7, changedFiles: 3 })
  })

  it('passes the deterministic issue-<n> head ref and --state all to gh', () => {
    let seenArgs
    const exec = (args) => {
      seenArgs = args
      return JSON.stringify([{ additions: 1, deletions: 2, changedFiles: 3 }])
    }
    fetchPrDiffStats(530, { exec })
    // exec receives the full gh argv (excluding the `gh` binary itself).
    const joined = seenArgs.join(' ')
    expect(joined).toContain('pr list')
    expect(joined).toContain('--head issue-530')
    expect(joined).toContain('--state all')
    expect(joined).toContain('additions,deletions,changedFiles')
  })

  it('returns zeros when gh returns an empty array (no PR for the ref)', () => {
    const exec = () => '[]'
    expect(fetchPrDiffStats(530, { exec })).toEqual(ZERO)
  })

  it('returns zeros when exec throws (gh non-zero exit / not found)', () => {
    const exec = () => {
      throw new Error('gh: command failed')
    }
    expect(fetchPrDiffStats(530, { exec })).toEqual(ZERO)
  })

  it('returns zeros when gh emits unparseable JSON', () => {
    const exec = () => 'not json at all'
    expect(fetchPrDiffStats(530, { exec })).toEqual(ZERO)
  })

  it('returns zeros when issueNumber is null', () => {
    let called = false
    const exec = () => {
      called = true
      return '[]'
    }
    expect(fetchPrDiffStats(null, { exec })).toEqual(ZERO)
    expect(called).toBe(false)
  })

  it('returns zeros when the parsed JSON is not an array', () => {
    const exec = () => JSON.stringify({ additions: 5 })
    expect(fetchPrDiffStats(530, { exec })).toEqual(ZERO)
  })

  it('defaults missing PR fields to 0', () => {
    const exec = () => JSON.stringify([{ additions: 5 }])
    expect(fetchPrDiffStats(530, { exec })).toEqual({
      additions: 5,
      deletions: 0,
      changedFiles: 0,
    })
  })
})

// ---------------------------------------------------------------------------
// QA augmentation: adversarial fetcher inputs + exact argv regression guard +
// issueNumber edge values. Hermetic — every exec is a spy, never real `gh`.
// ---------------------------------------------------------------------------
describe('QA: fetchPrDiffStats — exact gh argv regression guard', () => {
  it('calls exec with EXACTLY the expected argv (command shape lock)', () => {
    let seen
    const exec = (args) => {
      seen = args
      return '[]'
    }
    fetchPrDiffStats(530, { exec })
    expect(seen).toEqual([
      'pr',
      'list',
      '--head',
      'issue-530',
      '--state',
      'all',
      '--json',
      'additions,deletions,changedFiles',
    ])
  })

  it('is invoked exactly once per call', () => {
    let calls = 0
    const exec = () => {
      calls++
      return '[]'
    }
    fetchPrDiffStats(530, { exec })
    expect(calls).toBe(1)
  })
})

describe('QA: fetchPrDiffStats — multiple PRs / determinism', () => {
  it('deterministically takes the FIRST PR when several are returned', () => {
    const exec = () =>
      JSON.stringify([
        { additions: 1, deletions: 1, changedFiles: 1 },
        { additions: 2, deletions: 2, changedFiles: 2 },
        { additions: 3, deletions: 3, changedFiles: 3 },
      ])
    expect(fetchPrDiffStats(530, { exec })).toEqual({
      additions: 1,
      deletions: 1,
      changedFiles: 1,
    })
  })

  it('first element being null falls back to all zeros (pr || {})', () => {
    const exec = () => JSON.stringify([null, { additions: 9 }])
    expect(fetchPrDiffStats(530, { exec })).toEqual(ZERO)
  })
})

describe('QA: fetchPrDiffStats — partial / wrong-typed fields', () => {
  it('only deletions present => deletions read, additions/changedFiles default 0', () => {
    const exec = () => JSON.stringify([{ deletions: 8 }])
    expect(fetchPrDiffStats(530, { exec })).toEqual({
      additions: 0,
      deletions: 8,
      changedFiles: 0,
    })
  })

  it('only changedFiles present => changedFiles read, others default 0', () => {
    const exec = () => JSON.stringify([{ changedFiles: 4 }])
    expect(fetchPrDiffStats(530, { exec })).toEqual({
      additions: 0,
      deletions: 0,
      changedFiles: 4,
    })
  })

  it('explicit null fields coalesce to 0 (?? guards null)', () => {
    const exec = () =>
      JSON.stringify([{ additions: null, deletions: null, changedFiles: null }])
    expect(fetchPrDiffStats(530, { exec })).toEqual(ZERO)
  })

  it('explicit 0 fields stay 0 (real zero distinguished from absent)', () => {
    const exec = () =>
      JSON.stringify([{ additions: 0, deletions: 0, changedFiles: 0 }])
    expect(fetchPrDiffStats(530, { exec })).toEqual(ZERO)
  })

  it('string-typed numbers ("5") pass through as-is (no coercion guarantee)', () => {
    // Documents CURRENT behavior: ?? only guards null/undefined, NOT type.
    // gh emits real numbers, so this is a contract note rather than a defect.
    const exec = () =>
      JSON.stringify([{ additions: '5', deletions: '2', changedFiles: '1' }])
    expect(fetchPrDiffStats(530, { exec })).toEqual({
      additions: '5',
      deletions: '2',
      changedFiles: '1',
    })
  })

  it('float additions pass through unchanged (no rounding)', () => {
    const exec = () =>
      JSON.stringify([{ additions: 5.5, deletions: 2, changedFiles: 1 }])
    expect(fetchPrDiffStats(530, { exec })).toEqual({
      additions: 5.5,
      deletions: 2,
      changedFiles: 1,
    })
  })
})

describe('QA: fetchPrDiffStats — malformed exec output', () => {
  it('returns zeros on empty string', () => {
    expect(fetchPrDiffStats(530, { exec: () => '' })).toEqual(ZERO)
  })

  it('returns zeros on whitespace-only output', () => {
    expect(fetchPrDiffStats(530, { exec: () => '   \n\t ' })).toEqual(ZERO)
  })

  it('returns zeros when JSON is a bare number', () => {
    expect(fetchPrDiffStats(530, { exec: () => '42' })).toEqual(ZERO)
  })

  it('returns zeros when JSON is the literal null', () => {
    expect(fetchPrDiffStats(530, { exec: () => 'null' })).toEqual(ZERO)
  })

  it('returns zeros when JSON is a string literal', () => {
    expect(fetchPrDiffStats(530, { exec: () => '"hello"' })).toEqual(ZERO)
  })

  it('returns zeros when exec returns a non-string (undefined) — JSON.parse throws', () => {
    expect(fetchPrDiffStats(530, { exec: () => undefined })).toEqual(ZERO)
  })

  it('never throws regardless of exec output', () => {
    const garbageOutputs = ['', '   ', 'null', '{}', '[', '[}', '"x"', '42', undefined]
    for (const out of garbageOutputs) {
      expect(() => fetchPrDiffStats(530, { exec: () => out })).not.toThrow()
    }
  })
})

describe('QA: fetchPrDiffStats — issueNumber edge values', () => {
  it('issueNumber 0 DOES attempt the fetch (0 is not null)', () => {
    let seen
    const exec = (args) => {
      seen = args
      return JSON.stringify([{ additions: 7, deletions: 1, changedFiles: 2 }])
    }
    const stats = fetchPrDiffStats(0, { exec })
    expect(seen).toContain('issue-0')
    expect(stats).toEqual({ additions: 7, deletions: 1, changedFiles: 2 })
  })

  it('issueNumber undefined => zeros, exec NOT called (== null catches undefined)', () => {
    let called = false
    const exec = () => {
      called = true
      return '[]'
    }
    expect(fetchPrDiffStats(undefined, { exec })).toEqual(ZERO)
    expect(called).toBe(false)
  })

  it('issueNumber NaN DOES attempt the fetch and builds an issue-NaN ref', () => {
    // NaN is not == null, so the guard does not short-circuit. Documents that
    // the caller (capture-issue-event) is responsible for passing null, not NaN.
    let seen
    const exec = (args) => {
      seen = args
      return '[]'
    }
    fetchPrDiffStats(NaN, { exec })
    expect(seen).toContain('issue-NaN')
  })

  it('negative issueNumber builds an issue--<n> ref and fetches', () => {
    let seen
    const exec = (args) => {
      seen = args
      return '[]'
    }
    fetchPrDiffStats(-5, { exec })
    expect(seen).toContain('issue--5')
  })

  it('numeric-string issueNumber interpolates into the head ref', () => {
    let seen
    const exec = (args) => {
      seen = args
      return '[]'
    }
    fetchPrDiffStats('77', { exec })
    expect(seen).toContain('issue-77')
  })
})
