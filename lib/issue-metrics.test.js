import { describe, it, expect } from 'vitest'
import { join, resolve } from 'node:path'
import { appendIssueEvent, metricsPath, aggregateCycleCounts } from './issue-metrics.js'
// The namespace TOO, for the claim of #117 that is about the module's SHAPE rather than about any
// one function's answers: which names it exports, and that the retired one is not among them.
import * as issueMetrics from './issue-metrics.js'

// In-memory fs stub matching the injectable-fs pattern from state.js.
function makeFsStub() {
  const files = new Map()
  const dirs = new Set()
  return {
    files,
    dirs,
    existsSync(p) {
      return files.has(p) || dirs.has(p)
    },
    mkdirSync(p) {
      dirs.add(p)
    },
    appendFileSync(p, data) {
      files.set(p, (files.get(p) || '') + data)
    },
  }
}

describe('metricsPath', () => {
  it('points at .ralph/metrics/issues.jsonl under the project root', () => {
    expect(metricsPath('/proj')).toBe(
      join('/proj', '.ralph', 'metrics', 'issues.jsonl'),
    )
  })
})

// ---------------------------------------------------------------------------
// safeReadText (#117) — the never-throws text reader this module lends out.
//
// It carried a metrics-specific name while the metrics log was its only subject. #69 gave it a
// second one — `ralph start` reads `<cwd>/.git/config` through it for the banner's repo row —
// and from that point the name argued with the call site: a reader arriving at a call whose
// second argument was a git config had to stop and rule out a mistake. Nothing about the
// function was ever metrics-specific (a path in, the text or '' out, never throws), so #117
// renamed it and changed NOTHING else. That the retired spelling survives nowhere is asserted in
// issue-metrics.qa.test.js, over every file git tracks at every extension — one sweep, not two.
//
// Which is why these are behavioural assertions and not a spelling check: "no behaviour change"
// is only a claim until the contract is written down, and it has one clause that surprises —
// `?.toString() || ''` is nullish-coalescing on the way IN and falsy-coalescing on the way OUT,
// so `null` and `0` do not answer the same thing. Both are pinned below.
// ---------------------------------------------------------------------------
describe('safeReadText', () => {
  it('is exported under a name no longer tied to metrics, with no alias beside it', () => {
    // The NAMESPACE rather than a named import, on #116's argument: a named import that has
    // gone missing is a LINK error, so the file would fail to LOAD rather than fail here, and a
    // suite that cannot say which claim broke is a suite that gets deleted. Read as a SET, so a
    // backwards-compatible alias is as visible as a missing rename — two spellings would put
    // the retired one back in front of the next reader, which is what #117 removed.
    expect(Object.keys(issueMetrics).sort()).toEqual([
      'aggregateCycleCounts',
      'appendIssueEvent',
      'metricsPath',
      'safeReadText',
    ])
  })

  it('returns the text the injected reader hands back, and asks it for utf8', () => {
    const calls = []
    const readFile = (path, encoding) => {
      calls.push([path, encoding])
      return 'RALPH_ISSUE_EVENT {"issue_number":1}\n'
    }
    expect(issueMetrics.safeReadText(readFile, metricsPath('/proj'))).toBe(
      'RALPH_ISSUE_EVENT {"issue_number":1}\n',
    )
    expect(calls).toEqual([[metricsPath('/proj'), 'utf8']])
  })

  it('reads any path, not just the metrics log — the call #69 added', () => {
    // The reason for the rename, as a test: this is a git config, and the contract fits it
    // exactly. Nothing in the function looks at the path.
    const gitConfig = '[remote "origin"]\n\turl = git@github.com:lucasfe/ralph.git\n'
    const path = resolve('/proj', '.git', 'config')
    expect(issueMetrics.safeReadText(() => gitConfig, path)).toBe(gitConfig)
  })

  it("answers '' for every way a read can throw, whatever it throws", () => {
    // THE ONE HOME FOR THE THROW CONTRACT, and it asserts the ANSWER rather than merely the
    // absence of a throw: "never throws" and "answers ''" are two claims, and a `catch` that
    // returned `undefined` would satisfy the first while handing every caller downstream a value
    // their `.split('\n')` dies on. The throw SHAPE is varied because `catch` binds anything —
    // the three real errno cases a metrics log or a `.git/config` actually produces, plus the
    // four non-Error throws that would defeat a `catch (err) { if (err.code) … }` refinement.
    const errno = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code })
    for (const boom of [
      () => {
        throw errno('ENOENT', 'no such file')
      },
      () => {
        throw errno('EISDIR', 'illegal operation on a directory')
      },
      () => {
        throw errno('EACCES', 'permission denied')
      },
      () => {
        throw 'a string, not an Error'
      },
      () => {
        throw null
      },
      () => {
        throw undefined
      },
      () => {
        throw Symbol('a thrown symbol')
      },
      () => {
        throw { code: 'not an Error at all' }
      },
    ]) {
      expect(issueMetrics.safeReadText(boom, '/nope')).toBe('')
    }
  })

  it('normalizes a Buffer — an injected fs called without an encoding hands one back', () => {
    expect(issueMetrics.safeReadText(() => Buffer.from('from a Buffer'), '/p')).toBe(
      'from a Buffer',
    )
  })

  it("answers '' for the nullish and empty reads", () => {
    // `Buffer.alloc(0)` is the realistic one: an EMPTY metrics log read by an encoding-less fs.
    // It reaches `|| ''` as '' rather than as nullish, so both halves of the expression are what
    // make an empty file and a missing file answer the same thing — which is the property every
    // caller's uniform fallback rests on.
    for (const value of [undefined, null, '', Buffer.alloc(0)]) {
      expect(issueMetrics.safeReadText(() => value, '/p'), String(value)).toBe('')
    }
  })

  it('stringifies a non-string, falsy read rather than swallowing it', () => {
    // The surprising half of `?.toString() || ''`: optional chaining stops at nullish only, so
    // 0 and false reach `.toString()` and come out TRUTHY. Pinned because #117 promised the
    // semantics byte-identical, and "tidying" this into `String(x ?? '')` would change them.
    expect(issueMetrics.safeReadText(() => 0, '/p')).toBe('0')
    expect(issueMetrics.safeReadText(() => false, '/p')).toBe('false')
    expect(issueMetrics.safeReadText(() => 42, '/p')).toBe('42')
  })

})

describe('appendIssueEvent', () => {
  it('appends exactly one RALPH_ISSUE_EVENT line with valid JSON', () => {
    const fs = makeFsStub()
    const event = { issue_number: 98, verdict: 'pass' }
    appendIssueEvent('/proj', event, fs)

    const contents = fs.files.get(metricsPath('/proj'))
    const lines = contents.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith('RALPH_ISSUE_EVENT ')).toBe(true)
    const json = lines[0].slice('RALPH_ISSUE_EVENT '.length)
    expect(JSON.parse(json)).toEqual(event)
    expect(contents.endsWith('\n')).toBe(true)
  })

  it('appends (does not overwrite) on a second call', () => {
    const fs = makeFsStub()
    appendIssueEvent('/proj', { issue_number: 1 }, fs)
    appendIssueEvent('/proj', { issue_number: 2 }, fs)

    const contents = fs.files.get(metricsPath('/proj'))
    const lines = contents.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0].slice('RALPH_ISSUE_EVENT '.length)).issue_number).toBe(1)
    expect(JSON.parse(lines[1].slice('RALPH_ISSUE_EVENT '.length)).issue_number).toBe(2)
  })

  it('mkdirs the metrics dir recursively', () => {
    const fs = makeFsStub()
    appendIssueEvent('/proj', { issue_number: 1 }, fs)
    expect(fs.dirs.has(join('/proj', '.ralph', 'metrics'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// QA augmentation: additivity + JSON-escaping round-trip.
// ---------------------------------------------------------------------------
describe('QA: appendIssueEvent — additive over many calls', () => {
  it('3 sequential appends => 3 lines, all valid JSON, in order', () => {
    const fs = makeFsStub()
    appendIssueEvent('/proj', { issue_number: 1 }, fs)
    appendIssueEvent('/proj', { issue_number: 2 }, fs)
    appendIssueEvent('/proj', { issue_number: 3 }, fs)

    const contents = fs.files.get(metricsPath('/proj'))
    const lines = contents.split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    const nums = lines.map((l) => {
      expect(l.startsWith('RALPH_ISSUE_EVENT ')).toBe(true)
      return JSON.parse(l.slice('RALPH_ISSUE_EVENT '.length)).issue_number
    })
    expect(nums).toEqual([1, 2, 3])
  })
})

describe('QA: appendIssueEvent — JSON escaping round-trip', () => {
  it('event with newlines + quotes in a string field stays ONE line and round-trips', () => {
    const fs = makeFsStub()
    const event = {
      issue_number: 7,
      note: 'line one\nline two with "quotes" and a \\ backslash',
      verdict: 'pass',
    }
    appendIssueEvent('/proj', event, fs)

    const contents = fs.files.get(metricsPath('/proj'))
    // exactly one trailing newline => exactly one record line
    const lines = contents.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0].slice('RALPH_ISSUE_EVENT '.length))
    expect(parsed).toEqual(event)
    expect(parsed.note).toContain('\n')
  })
})

// ---------------------------------------------------------------------------
// aggregateCycleCounts — pure aggregator over issues.jsonl text (#532).
// ---------------------------------------------------------------------------
describe('aggregateCycleCounts', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('returns all zeros for empty / missing input', () => {
    const empty = { ok: 0, failed: 0, processed: 0, okIssues: [], failedIssues: [] }
    expect(aggregateCycleCounts('', 0)).toEqual(empty)
    expect(aggregateCycleCounts(undefined, 0)).toEqual(empty)
    expect(aggregateCycleCounts(null, 0)).toEqual(empty)
  })

  it('counts pass as ok and fail/unknown as failed', () => {
    const text = [
      line({ issue_number: 1, verdict: 'pass', ts: 100 }),
      line({ issue_number: 2, verdict: 'fail', ts: 100 }),
      line({ issue_number: 3, verdict: 'unknown', ts: 100 }),
    ].join('\n')
    const counts = aggregateCycleCounts(text, 0)
    expect(counts.ok).toBe(1)
    expect(counts.failed).toBe(2)
    expect(counts.processed).toBe(3)
    expect(counts.okIssues).toEqual([1])
    expect(counts.failedIssues).toEqual([2, 3])
  })

  it('excludes events whose ts is before the since cutoff', () => {
    const text = [
      line({ issue_number: 1, verdict: 'pass', ts: 50 }), // before cutoff
      line({ issue_number: 2, verdict: 'pass', ts: 200 }), // after cutoff
      line({ issue_number: 3, verdict: 'fail', ts: 200 }), // after cutoff
    ].join('\n')
    const counts = aggregateCycleCounts(text, 100)
    expect(counts.ok).toBe(1)
    expect(counts.failed).toBe(1)
    expect(counts.processed).toBe(2)
    expect(counts.okIssues).toEqual([2])
    expect(counts.failedIssues).toEqual([3])
  })

  it('keeps events whose ts equals the since cutoff (>=)', () => {
    const text = line({ issue_number: 9, verdict: 'pass', ts: 100 })
    expect(aggregateCycleCounts(text, 100).ok).toBe(1)
  })

  it('tolerates malformed lines: blank, non-tagged, bad JSON, missing ts', () => {
    const text = [
      '',
      'garbage line without tag',
      'RALPH_ISSUE_EVENT {not valid json',
      line({ issue_number: 5, verdict: 'pass' }), // missing ts → skipped
      line({ issue_number: 6, verdict: 'pass', ts: 'nope' }), // non-finite ts → skipped
      '   ',
      line({ issue_number: 7, verdict: 'pass', ts: 100 }), // the only valid in-window event
    ].join('\n')
    const counts = aggregateCycleCounts(text, 0)
    expect(counts.ok).toBe(1)
    expect(counts.failed).toBe(0)
    expect(counts.processed).toBe(1)
    expect(counts.okIssues).toEqual([7])
  })

  it('collects issue numbers, dropping non-finite ones', () => {
    const text = [
      line({ issue_number: 10, verdict: 'pass', ts: 100 }),
      line({ issue_number: 'x', verdict: 'pass', ts: 100 }), // bad number kept out of okIssues
      line({ issue_number: 20, verdict: 'fail', ts: 100 }),
      line({ verdict: 'fail', ts: 100 }), // no issue_number
    ].join('\n')
    const counts = aggregateCycleCounts(text, 0)
    // verdict-based counts still tally every in-window event
    expect(counts.ok).toBe(2)
    expect(counts.failed).toBe(2)
    // ...but only finite issue numbers are collected into the arrays
    expect(counts.okIssues).toEqual([10])
    expect(counts.failedIssues).toEqual([20])
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#532): adversarial edge cases the happy path missed.
// ---------------------------------------------------------------------------
describe('QA: aggregateCycleCounts — since boundary is inclusive of ts === since', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('ts === since is INCLUDED, ts === since - 1 is EXCLUDED', () => {
    const text = [
      line({ issue_number: 1, verdict: 'pass', ts: 999 }), // since - 1 → out
      line({ issue_number: 2, verdict: 'pass', ts: 1000 }), // === since → in
    ].join('\n')
    const counts = aggregateCycleCounts(text, 1000)
    expect(counts.ok).toBe(1)
    expect(counts.processed).toBe(1)
    expect(counts.okIssues).toEqual([2])
  })
})

describe('QA: aggregateCycleCounts — ts type abuse is excluded', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('a numeric STRING ts ("1700000000000") is treated as malformed and excluded', () => {
    const text = line({ issue_number: 1, verdict: 'pass', ts: '1700000000000' })
    expect(aggregateCycleCounts(text, 0)).toEqual({
      ok: 0,
      failed: 0,
      processed: 0,
      okIssues: [],
      failedIssues: [],
    })
  })

  it('ts: null, missing ts, and ts: Infinity are all excluded', () => {
    const text = [
      line({ issue_number: 1, verdict: 'pass', ts: null }),
      line({ issue_number: 2, verdict: 'pass' }), // missing
      // Infinity is not representable in JSON; JSON.stringify emits null, but
      // construct the raw line by hand to be explicit about the intent.
      'RALPH_ISSUE_EVENT {"issue_number":3,"verdict":"pass","ts":1e999}', // → Infinity
    ].join('\n')
    const counts = aggregateCycleCounts(text, 0)
    expect(counts.processed).toBe(0)
    expect(counts.ok).toBe(0)
    expect(counts.failed).toBe(0)
  })

  it('ts: NaN (raw JSON) is excluded — and does not throw', () => {
    // NaN is invalid JSON; a hand-rolled "NaN" literal makes JSON.parse throw,
    // which the aggregator swallows. Either way the event must not be counted.
    const text = 'RALPH_ISSUE_EVENT {"issue_number":1,"verdict":"pass","ts":NaN}'
    expect(() => aggregateCycleCounts(text, 0)).not.toThrow()
    expect(aggregateCycleCounts(text, 0).processed).toBe(0)
  })
})

describe('QA: aggregateCycleCounts — JSON valid but not an object', () => {
  it('a tagged line whose JSON is a number / string / null is skipped, never throws', () => {
    const text = [
      'RALPH_ISSUE_EVENT 42',
      'RALPH_ISSUE_EVENT "hi"',
      'RALPH_ISSUE_EVENT null',
      'RALPH_ISSUE_EVENT true',
    ].join('\n')
    let counts
    expect(() => {
      counts = aggregateCycleCounts(text, 0)
    }).not.toThrow()
    expect(counts).toEqual({
      ok: 0,
      failed: 0,
      processed: 0,
      okIssues: [],
      failedIssues: [],
    })
  })
})

describe('QA: aggregateCycleCounts — issue_number abuse still tallies verdict', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('pass with missing/NaN/non-numeric issue_number counts in ok but not okIssues', () => {
    const text = [
      line({ verdict: 'pass', ts: 100 }), // missing issue_number
      line({ issue_number: 'abc', verdict: 'pass', ts: 100 }), // non-numeric
      'RALPH_ISSUE_EVENT {"issue_number":1e999,"verdict":"pass","ts":100}', // Infinity
      line({ verdict: 'fail', ts: 100 }), // missing, failed branch
      line({ issue_number: null, verdict: 'fail', ts: 100 }),
    ].join('\n')
    const counts = aggregateCycleCounts(text, 0)
    expect(counts.ok).toBe(3)
    expect(counts.failed).toBe(2)
    expect(counts.processed).toBe(5)
    expect(counts.okIssues).toEqual([])
    expect(counts.failedIssues).toEqual([])
  })
})

describe('QA: aggregateCycleCounts — realistic mixed blob', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('counts only in-window valid events amid noise; exact arrays', () => {
    const text = [
      'just some stdout', // non-tagged log line
      line({ issue_number: 10, verdict: 'pass', ts: 5000 }), // in-window pass
      '', // blank line
      line({ issue_number: 11, verdict: 'unknown', ts: 5000 }), // in-window unknown → failed
      line({ issue_number: 99, verdict: 'pass', ts: 100 }), // out-of-window pass
      'RALPH_ISSUE_EVENT {bad json here', // bad-JSON tagged line
      line({ issue_number: 12, verdict: 'fail', ts: 6000 }), // in-window fail
    ].join('\n')
    const counts = aggregateCycleCounts(text, 1000)
    expect(counts.ok).toBe(1)
    expect(counts.failed).toBe(2)
    expect(counts.processed).toBe(3)
    expect(counts.okIssues).toEqual([10])
    expect(counts.failedIssues).toEqual([11, 12])
  })
})

describe('QA: aggregateCycleCounts — tag position semantics', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('a tag embedded mid-line still parses (indexOf-based slicing is intentional)', () => {
    const text =
      '2026-01-01T00:00:00 ' + line({ issue_number: 7, verdict: 'pass', ts: 100 })
    const counts = aggregateCycleCounts(text, 0)
    expect(counts.ok).toBe(1)
    expect(counts.okIssues).toEqual([7])
  })

  it('a line containing the tag but no following JSON is skipped without throwing', () => {
    const text = 'noise RALPH_ISSUE_EVENT '
    expect(() => aggregateCycleCounts(text, 0)).not.toThrow()
    expect(aggregateCycleCounts(text, 0).processed).toBe(0)
  })
})

describe('QA: aggregateCycleCounts — CRLF logs still count', () => {
  const line = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)

  it('a \\r\\n-terminated event leaves a trailing \\r that JSON.parse tolerates', () => {
    // The impl splits on '\n' only, so each record retains a trailing '\r'.
    // JSON.parse ignores trailing whitespace, so CRLF logs must still count.
    const text =
      line({ issue_number: 5, verdict: 'pass', ts: 100 }) +
      '\r\n' +
      line({ issue_number: 6, verdict: 'fail', ts: 100 }) +
      '\r\n'
    const counts = aggregateCycleCounts(text, 0)
    expect(counts.ok).toBe(1)
    expect(counts.failed).toBe(1)
    expect(counts.processed).toBe(2)
    expect(counts.okIssues).toEqual([5])
    expect(counts.failedIssues).toEqual([6])
  })
})
