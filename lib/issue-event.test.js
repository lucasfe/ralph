import { describe, it, expect } from 'vitest'
import { buildIssueEvent } from './issue-event.js'

// Helper: build a stream-json string from an array of JSON-able objects, one
// per line (newline-delimited). Mirrors claude's --output-format stream-json.
function streamLines(objs) {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

const resultLine = (overrides = {}) => ({
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.1234,
  num_turns: 7,
  duration_ms: 4200,
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 25,
  },
  ...overrides,
})

const baseInput = (overrides = {}) => ({
  rawStreamJson: streamLines([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    resultLine(),
  ]),
  stderrLog: '',
  issueNumber: 98,
  runId: 'ralph-abc-1718000000',
  claudeExitCode: 0,
  labels: [],
  state: 'OPEN',
  ts: 1718000123456,
  ...overrides,
})

describe('buildIssueEvent — result line parsing', () => {
  it('reads cost/turns/duration/subtype from the result line (success)', () => {
    const e = buildIssueEvent(baseInput())
    expect(e.subtype).toBe('success')
    expect(e.total_cost_usd).toBe(0.1234)
    expect(e.num_turns).toBe(7)
    expect(e.duration_ms).toBe(4200)
  })

  it('stores usage RAW as found on the result line', () => {
    const e = buildIssueEvent(baseInput())
    expect(e.usage).toEqual({
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    })
  })

  it('defaults missing usage fields to 0', () => {
    const raw = streamLines([resultLine({ usage: { input_tokens: 5 } })])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.usage).toEqual({
      input_tokens: 5,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })

  it('captures error_max_turns subtype', () => {
    const raw = streamLines([resultLine({ subtype: 'error_max_turns' })])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.subtype).toBe('error_max_turns')
  })

  it('captures error_during_execution subtype', () => {
    const raw = streamLines([resultLine({ subtype: 'error_during_execution' })])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.subtype).toBe('error_during_execution')
  })

  it('uses the LAST result line when several are present', () => {
    const raw = streamLines([
      resultLine({ subtype: 'error_max_turns', total_cost_usd: 0.01 }),
      resultLine({ subtype: 'success', total_cost_usd: 0.99 }),
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.subtype).toBe('success')
    expect(e.total_cost_usd).toBe(0.99)
  })

  it('never throws on truncated / garbage stream and falls back to safe defaults', () => {
    const raw = 'not json at all\n{ broken json\n\n   \n'
    let e
    expect(() => {
      e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    }).not.toThrow()
    expect(e.total_cost_usd).toBe(0)
    expect(e.num_turns).toBe(0)
    expect(e.duration_ms).toBe(0)
    expect(e.subtype).toBeNull()
    expect(e.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })

  it('tolerates an empty stream string', () => {
    const e = buildIssueEvent(baseInput({ rawStreamJson: '' }))
    expect(e.subtype).toBeNull()
    expect(e.total_cost_usd).toBe(0)
  })
})

describe('buildIssueEvent — stderr error-signal counting', () => {
  it('counts 0 when stderr has no error signals', () => {
    const e = buildIssueEvent(
      baseInput({ stderrLog: 'just a normal log line\nanother line\n' }),
    )
    expect(e.stderr_error_signals).toBe(0)
  })

  it('counts lines matching auth / credit / rate-limit (case-insensitive)', () => {
    const stderr = [
      'Authentication failed',
      'Credit balance too low',
      'You have been RATE LIMITED',
      'rate-limit exceeded',
      'all good here',
    ].join('\n')
    const e = buildIssueEvent(baseInput({ stderrLog: stderr }))
    expect(e.stderr_error_signals).toBe(4)
  })

  it('counts 0 on empty stderr', () => {
    const e = buildIssueEvent(baseInput({ stderrLog: '' }))
    expect(e.stderr_error_signals).toBe(0)
  })
})

describe('buildIssueEvent — verdict precedence', () => {
  it("claude-failed label => 'fail' even when state is CLOSED", () => {
    const e = buildIssueEvent(
      baseInput({ labels: ['claude-failed'], state: 'CLOSED' }),
    )
    expect(e.verdict).toBe('fail')
  })

  it("claude-failed label => 'fail' even with pending-merge label", () => {
    const e = buildIssueEvent(
      baseInput({ labels: ['claude-failed', 'pending-merge'], state: 'OPEN' }),
    )
    expect(e.verdict).toBe('fail')
  })

  it("pending-merge label => 'pass'", () => {
    const e = buildIssueEvent(
      baseInput({ labels: ['pending-merge'], state: 'OPEN' }),
    )
    expect(e.verdict).toBe('pass')
  })

  it("state CLOSED => 'pass'", () => {
    const e = buildIssueEvent(baseInput({ labels: [], state: 'CLOSED' }))
    expect(e.verdict).toBe('pass')
  })

  it("plain OPEN with no labels => 'unknown'", () => {
    const e = buildIssueEvent(baseInput({ labels: [], state: 'OPEN' }))
    expect(e.verdict).toBe('unknown')
  })

  it("unrelated labels OPEN => 'unknown'", () => {
    const e = buildIssueEvent(
      baseInput({ labels: ['bug', 'enhancement'], state: 'OPEN' }),
    )
    expect(e.verdict).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// QA augmentation: adversarial / edge cases beyond the happy-path suite above.
// ---------------------------------------------------------------------------

describe('QA: buildIssueEvent — result line parsing (adversarial)', () => {
  it('finds the result line even when interleaved with blank + garbage + partial-json lines', () => {
    const raw = [
      '',
      'not json at all',
      '{partial',
      JSON.stringify({ type: 'assistant', message: {} }),
      '   ',
      JSON.stringify(resultLine({ subtype: 'success', total_cost_usd: 0.42 })),
      '{ broken',
      '',
    ].join('\n')
    let e
    expect(() => {
      e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    }).not.toThrow()
    expect(e.subtype).toBe('success')
    expect(e.total_cost_usd).toBe(0.42)
  })

  it('result line with type:result but usage entirely MISSING => all-zero usage', () => {
    const line = resultLine()
    delete line.usage
    const raw = streamLines([line])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    // present scalar fields still read raw
    expect(e.num_turns).toBe(7)
  })

  it('result line with usage set to null => all-zero usage, no throw', () => {
    const raw = streamLines([resultLine({ usage: null })])
    let e
    expect(() => {
      e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    }).not.toThrow()
    expect(e.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })

  it('stream that is ONLY garbage (no result line) => safe zero defaults, valid object', () => {
    const raw = 'garbage one\nmore garbage\n{still not json\n'
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.subtype).toBeNull()
    expect(e.total_cost_usd).toBe(0)
    expect(e.num_turns).toBe(0)
    expect(e.duration_ms).toBe(0)
    expect(e.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })

  it('distinguishes a real 0 from absent: explicit zeros stay 0 with no NaN/undefined leak', () => {
    const raw = streamLines([
      resultLine({ total_cost_usd: 0, num_turns: 0, duration_ms: 0 }),
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.total_cost_usd).toBe(0)
    expect(e.num_turns).toBe(0)
    expect(e.duration_ms).toBe(0)
    for (const v of [e.total_cost_usd, e.num_turns, e.duration_ms]) {
      expect(Number.isNaN(v)).toBe(false)
      expect(v).not.toBeUndefined()
    }
  })

  it('result line missing scalar fields => 0 (not undefined/NaN)', () => {
    const raw = streamLines([{ type: 'result', subtype: 'success' }])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.total_cost_usd).toBe(0)
    expect(e.num_turns).toBe(0)
    expect(e.duration_ms).toBe(0)
    for (const v of [e.total_cost_usd, e.num_turns, e.duration_ms]) {
      expect(Number.isNaN(v)).toBe(false)
      expect(v).not.toBeUndefined()
    }
  })

  it('never throws when input itself is null/undefined', () => {
    expect(() => buildIssueEvent(undefined)).not.toThrow()
    expect(() => buildIssueEvent(null)).not.toThrow()
    const e = buildIssueEvent(null)
    expect(e.subtype).toBeNull()
    expect(e.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })
})

describe('QA: buildIssueEvent — stderr error-signal counting (adversarial)', () => {
  it('a line matching MULTIPLE keywords counts ONCE (per-line, not per-keyword)', () => {
    const stderr = 'auth failure and credit issue and rate limit too\n'
    const e = buildIssueEvent(baseInput({ stderrLog: stderr }))
    expect(e.stderr_error_signals).toBe(1)
  })

  it('matches rate-limit spelling variants (rate limit, rate-limit, ratelimit)', () => {
    const stderr = ['rate limit', 'rate-limit', 'ratelimit'].join('\n')
    const e = buildIssueEvent(baseInput({ stderrLog: stderr }))
    expect(e.stderr_error_signals).toBe(3)
  })

  it('is case-insensitive (AUTH, Rate Limit)', () => {
    const stderr = ['AUTH', 'Rate Limit'].join('\n')
    const e = buildIssueEvent(baseInput({ stderrLog: stderr }))
    expect(e.stderr_error_signals).toBe(2)
  })

  it('blank / whitespace lines do not count', () => {
    const stderr = '\n   \n\t\nauth\n\n'
    const e = buildIssueEvent(baseInput({ stderrLog: stderr }))
    expect(e.stderr_error_signals).toBe(1)
  })
})

describe('QA: buildIssueEvent — verdict (adversarial)', () => {
  it('labels null => no throw, unknown', () => {
    let e
    expect(() => {
      e = buildIssueEvent(baseInput({ labels: null, state: 'OPEN' }))
    }).not.toThrow()
    expect(e.verdict).toBe('unknown')
  })

  it('labels undefined => no throw, unknown', () => {
    let e
    expect(() => {
      e = buildIssueEvent(baseInput({ labels: undefined, state: 'OPEN' }))
    }).not.toThrow()
    expect(e.verdict).toBe('unknown')
  })

  it('labels a non-array string => no throw, unknown', () => {
    let e
    expect(() => {
      e = buildIssueEvent(baseInput({ labels: 'pending-merge', state: 'OPEN' }))
    }).not.toThrow()
    expect(e.verdict).toBe('unknown')
  })

  it('pending-merge present AND state OPEN => pass', () => {
    const e = buildIssueEvent(
      baseInput({ labels: ['pending-merge'], state: 'OPEN' }),
    )
    expect(e.verdict).toBe('pass')
  })
})

describe('QA: buildIssueEvent — diff placeholders always zero', () => {
  it('files/insertions/deletions stay exactly 0 even with garbage input', () => {
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: 'garbage', stderrLog: 'auth\nauth', labels: null }),
    )
    expect(e.files).toBe(0)
    expect(e.insertions).toBe(0)
    expect(e.deletions).toBe(0)
  })

  it('files/insertions/deletions stay 0 even if the result line tries to set them', () => {
    const raw = streamLines([
      resultLine({ files: 99, insertions: 12, deletions: 34 }),
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.files).toBe(0)
    expect(e.insertions).toBe(0)
    expect(e.deletions).toBe(0)
  })
})

describe('buildIssueEvent — passthrough + placeholders', () => {
  it('passes through issue_number, run_id, ts, claude_exit_code', () => {
    const e = buildIssueEvent(
      baseInput({ issueNumber: 42, runId: 'r-1', ts: 999, claudeExitCode: 3 }),
    )
    expect(e.issue_number).toBe(42)
    expect(e.run_id).toBe('r-1')
    expect(e.ts).toBe(999)
    expect(e.claude_exit_code).toBe(3)
  })

  it('includes diff placeholder fields set to 0', () => {
    const e = buildIssueEvent(baseInput())
    expect(e.files).toBe(0)
    expect(e.insertions).toBe(0)
    expect(e.deletions).toBe(0)
  })
})
