import { describe, it, expect } from 'vitest'
import {
  buildIssueEvent,
  lastMessageStart,
  resolveContextWindow,
  computeContextEnd,
} from './issue-event.js'

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

// Helper: a bare `message_start` event (the shape claude emits directly).
const messageStart = (overrides = {}) => ({
  type: 'message_start',
  message: {
    model: 'claude-opus-4-8',
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 50,
    },
    ...(overrides.message || {}),
  },
  ...(() => {
    const { message, ...rest } = overrides
    return rest
  })(),
})

// Helper: a `message_start` wrapped inside a `stream_event` envelope.
const wrappedMessageStart = (overrides = {}) => ({
  type: 'stream_event',
  event: messageStart(overrides),
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

  // #39: the real auth-failure result line claims subtype "success" while
  // flagging is_error true. The per-issue event must not record that as success.
  it('does NOT record subtype "success" for an is_error result line (#39)', () => {
    const raw = streamLines([
      { type: 'result', subtype: 'success', is_error: true, num_turns: 1 },
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.subtype).not.toBe('success')
    expect(e.subtype).toBe('error')
    expect(e.num_turns).toBe(1)
  })

  it('records subtype "success" for is_error false and for an absent is_error (#39)', () => {
    const flagged = streamLines([resultLine({ is_error: false })])
    const absent = streamLines([resultLine()])
    expect(buildIssueEvent(baseInput({ rawStreamJson: flagged })).subtype).toBe('success')
    expect(buildIssueEvent(baseInput({ rawStreamJson: absent })).subtype).toBe('success')
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

  // #39: the STREAM's own outcome (subtype) and the RUN's verdict are separate
  // signals. The verdict is derived from labels/state only, so reconciling the
  // subtype with the result line's is_error flag must not move it. Every
  // (labels, state) pair below yields the same verdict whether the stream
  // reports a healthy result or the real auth-failure payload.
  const VERDICT_CASES = [
    { labels: ['claude-failed'], state: 'CLOSED', verdict: 'fail' },
    { labels: ['claude-failed', 'pending-merge'], state: 'OPEN', verdict: 'fail' },
    { labels: ['pending-merge'], state: 'OPEN', verdict: 'pass' },
    { labels: [], state: 'CLOSED', verdict: 'pass' },
    { labels: [], state: 'OPEN', verdict: 'unknown' },
    { labels: ['bug', 'enhancement'], state: 'OPEN', verdict: 'unknown' },
  ]

  it.each(VERDICT_CASES)(
    'verdict is $verdict for labels $labels + state $state, flagged stream or not (#39)',
    ({ labels, state, verdict }) => {
      const healthy = streamLines([resultLine({ subtype: 'success', is_error: false })])
      const flagged = streamLines([
        { type: 'result', subtype: 'success', is_error: true, num_turns: 1 },
      ])
      const a = buildIssueEvent(baseInput({ labels, state, rawStreamJson: healthy }))
      const b = buildIssueEvent(baseInput({ labels, state, rawStreamJson: flagged }))
      expect(a.verdict).toBe(verdict)
      expect(b.verdict).toBe(verdict)
      // ...and the stream's own outcome IS reported differently for the two.
      expect(a.subtype).toBe('success')
      expect(b.subtype).not.toBe('success')
    },
  )

  // #565: folder mode has no issue state/labels to classify by — the terminal
  // task directory decides the verdict, passed in as verdictOverride. When set
  // (non-empty), it wins over the label/state precedence above.
  it('verdictOverride wins over label/state precedence when provided', () => {
    const e = buildIssueEvent(
      baseInput({ labels: ['claude-failed'], state: 'CLOSED', verdictOverride: 'pass' }),
    )
    expect(e.verdict).toBe('pass')
  })

  it('verdictOverride "fail" is recorded even for a CLOSED issue', () => {
    const e = buildIssueEvent(baseInput({ state: 'CLOSED', verdictOverride: 'fail' }))
    expect(e.verdict).toBe('fail')
  })

  it('an empty/absent verdictOverride falls back to label/state precedence', () => {
    const e = buildIssueEvent(baseInput({ state: 'CLOSED', verdictOverride: '' }))
    expect(e.verdict).toBe('pass')
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

// ---------------------------------------------------------------------------
// QA augmentation (#530): buildIssueEvent now READS files/insertions/deletions
// from input — verify they flow through and edge values are preserved.
// ---------------------------------------------------------------------------
describe('QA: buildIssueEvent — diff stats passthrough (#530)', () => {
  it('passes input files/insertions/deletions straight through to the event', () => {
    const e = buildIssueEvent(
      baseInput({ files: 5, insertions: 120, deletions: 30 }),
    )
    expect(e.files).toBe(5)
    expect(e.insertions).toBe(120)
    expect(e.deletions).toBe(30)
  })

  it('defaults each diff field independently to 0 when only some are provided', () => {
    const e = buildIssueEvent(baseInput({ insertions: 9 }))
    expect(e.files).toBe(0)
    expect(e.insertions).toBe(9)
    expect(e.deletions).toBe(0)
  })

  it('explicit 0 diff values stay 0 (real zero, not undefined/NaN)', () => {
    const e = buildIssueEvent(
      baseInput({ files: 0, insertions: 0, deletions: 0 }),
    )
    for (const v of [e.files, e.insertions, e.deletions]) {
      expect(v).toBe(0)
      expect(Number.isNaN(v)).toBe(false)
    }
  })

  it('preserves large diff numbers without truncation', () => {
    const e = buildIssueEvent(
      baseInput({ files: 87, insertions: 12_345, deletions: 6_789 }),
    )
    expect(e.files).toBe(87)
    expect(e.insertions).toBe(12_345)
    expect(e.deletions).toBe(6_789)
  })
})

// ---------------------------------------------------------------------------
// #534: end-of-job context-window occupancy.
// ---------------------------------------------------------------------------

describe('lastMessageStart — pure final-turn extraction', () => {
  it('picks the LAST message_start, not the first', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 1 } },
      }),
      { type: 'assistant', message: {} },
      messageStart({
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 3,
          },
        },
      }),
    ])
    const ms = lastMessageStart(raw)
    expect(ms.message.usage.input_tokens).toBe(10)
  })

  it('reads a single-turn stream', () => {
    const raw = streamLines([messageStart(), resultLine()])
    const ms = lastMessageStart(raw)
    expect(ms.message.usage.input_tokens).toBe(100)
  })

  it('handles the wrapped stream_event envelope shape', () => {
    const raw = streamLines([
      wrappedMessageStart({
        message: { model: 'claude-sonnet-4', usage: { input_tokens: 42 } },
      }),
    ])
    const ms = lastMessageStart(raw)
    expect(ms.message.usage.input_tokens).toBe(42)
    expect(ms.message.model).toBe('claude-sonnet-4')
  })

  it('returns null when there is no message_start', () => {
    expect(lastMessageStart(streamLines([resultLine()]))).toBeNull()
  })

  it('never throws on garbage / blank / partial lines', () => {
    const raw = 'not json\n{partial\n\n   \n'
    expect(() => lastMessageStart(raw)).not.toThrow()
    expect(lastMessageStart(raw)).toBeNull()
  })

  it('tolerates empty / null input', () => {
    expect(lastMessageStart('')).toBeNull()
    expect(lastMessageStart(null)).toBeNull()
  })
})

describe('resolveContextWindow — window resolution rules', () => {
  it('maps opus -> 1_000_000', () => {
    expect(resolveContextWindow('claude-opus-4-8', null)).toBe(1_000_000)
  })

  it('maps sonnet -> 1_000_000', () => {
    expect(resolveContextWindow('claude-sonnet-4-5', null)).toBe(1_000_000)
  })

  it('maps fable -> 1_000_000', () => {
    expect(resolveContextWindow('claude-fable-1', null)).toBe(1_000_000)
  })

  it('maps haiku -> 200_000', () => {
    expect(resolveContextWindow('claude-haiku-4-5', null)).toBe(200_000)
  })

  it('unknown model with no override -> null', () => {
    expect(resolveContextWindow('some-mystery-model', null)).toBeNull()
  })

  it('null/empty model with no override -> null', () => {
    expect(resolveContextWindow(null, null)).toBeNull()
    expect(resolveContextWindow('', null)).toBeNull()
  })

  it('numeric override wins over the map', () => {
    expect(resolveContextWindow('claude-opus-4-8', 500_000)).toBe(500_000)
  })

  it('override wins even for an unknown model', () => {
    expect(resolveContextWindow('mystery', 123_456)).toBe(123_456)
  })

  it('ignores non-positive / non-finite / non-numeric overrides (falls back to map)', () => {
    expect(resolveContextWindow('claude-opus-4-8', 0)).toBe(1_000_000)
    expect(resolveContextWindow('claude-opus-4-8', -5)).toBe(1_000_000)
    expect(resolveContextWindow('claude-opus-4-8', NaN)).toBe(1_000_000)
    expect(resolveContextWindow('claude-opus-4-8', Infinity)).toBe(1_000_000)
    expect(resolveContextWindow('claude-opus-4-8', 'abc')).toBe(1_000_000)
  })
})

describe('computeContextEnd — combined extraction + window resolution', () => {
  it('sums input + cache_read + cache_creation of the LAST message_start', () => {
    const raw = streamLines([
      messageStart({ message: { usage: { input_tokens: 1 } } }),
      messageStart({
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 50,
          },
        },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_tokens).toBe(350)
    expect(c.model).toBe('claude-opus-4-8')
    expect(c.context_end_pct).toBeCloseTo(350 / 1_000_000, 10)
  })

  it('does NOT use the cumulative result usage', () => {
    const raw = streamLines([
      messageStart({ message: { usage: { input_tokens: 100 } } }),
      resultLine({ usage: { input_tokens: 999_999 } }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_tokens).toBe(100)
  })

  it('handles cache_read / cache_creation present', () => {
    const raw = streamLines([
      messageStart({
        message: {
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 15,
          },
        },
      }),
    ])
    expect(computeContextEnd(raw, null).context_end_tokens).toBe(30)
  })

  it('unknown model, no override -> tokens + model emitted, pct null', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'mystery-x', usage: { input_tokens: 42 } },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_tokens).toBe(42)
    expect(c.model).toBe('mystery-x')
    expect(c.context_end_pct).toBeNull()
  })

  it('RALPH_CONTEXT_WINDOW override applies the pct', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'mystery-x', usage: { input_tokens: 100 } },
      }),
    ])
    const c = computeContextEnd(raw, 1000)
    expect(c.context_end_pct).toBeCloseTo(0.1, 10)
  })

  it('no message_start -> 0 tokens, null model, null pct', () => {
    const c = computeContextEnd(streamLines([resultLine()]), null)
    expect(c.context_end_tokens).toBe(0)
    expect(c.model).toBeNull()
    expect(c.context_end_pct).toBeNull()
  })

  it('garbled / missing usage degrades to 0, never throws', () => {
    const raw = streamLines([{ type: 'message_start', message: {} }])
    let c
    expect(() => {
      c = computeContextEnd(raw, null)
    }).not.toThrow()
    expect(c.context_end_tokens).toBe(0)
    expect(c.context_end_pct).toBeNull()
  })

  it('garbage stream never throws', () => {
    expect(() => computeContextEnd('garbage\n{broken', null)).not.toThrow()
    const c = computeContextEnd('garbage\n{broken', null)
    expect(c.context_end_tokens).toBe(0)
  })
})

describe('buildIssueEvent — context-window occupancy fields (#534)', () => {
  it('emits context_end_tokens / context_end_pct / model from the last message_start', () => {
    const raw = streamLines([
      messageStart({
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 500,
          },
        },
      }),
      resultLine(),
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.context_end_tokens).toBe(3500)
    expect(e.model).toBe('claude-opus-4-8')
    expect(e.context_end_pct).toBeCloseTo(3500 / 1_000_000, 10)
  })

  it('contextWindowOverride input is threaded through', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'mystery', usage: { input_tokens: 250 } },
      }),
    ])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, contextWindowOverride: 1000 }),
    )
    expect(e.context_end_pct).toBeCloseTo(0.25, 10)
  })

  it('unknown model, no override -> tokens + model, pct null', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'mystery', usage: { input_tokens: 7 } },
      }),
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.context_end_tokens).toBe(7)
    expect(e.model).toBe('mystery')
    expect(e.context_end_pct).toBeNull()
  })

  it('no message_start -> 0 tokens, null model/pct (graceful)', () => {
    const raw = streamLines([resultLine()])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.context_end_tokens).toBe(0)
    expect(e.model).toBeNull()
    expect(e.context_end_pct).toBeNull()
  })

  it('garbage stream -> safe defaults, never throws', () => {
    let e
    expect(() => {
      e = buildIssueEvent(baseInput({ rawStreamJson: 'garbage\n{broken' }))
    }).not.toThrow()
    expect(e.context_end_tokens).toBe(0)
    expect(e.context_end_pct).toBeNull()
    expect(e.model).toBeNull()
  })

  it('null input does not throw and yields safe context defaults', () => {
    const e = buildIssueEvent(null)
    expect(e.context_end_tokens).toBe(0)
    expect(e.context_end_pct).toBeNull()
    expect(e.model).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#534): adversarial context-window cases the happy path
// missed — mixed shapes, ordering, partial/typed usage, override precedence,
// rounding precision, and safe degradation.
// ---------------------------------------------------------------------------

describe('QA: lastMessageStart — mixed shapes + ordering (#534)', () => {
  it('LAST-wins when an EARLY one is bare and the LATER one is stream_event-wrapped', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 1 } },
      }),
      wrappedMessageStart({
        message: { model: 'claude-sonnet-4', usage: { input_tokens: 222 } },
      }),
    ])
    const ms = lastMessageStart(raw)
    // Returns the UNWRAPPED event, so callers always see `.message` directly.
    expect(ms.type).toBe('message_start')
    expect(ms.message.usage.input_tokens).toBe(222)
    expect(ms.message.model).toBe('claude-sonnet-4')
  })

  it('LAST-wins when an EARLY one is wrapped and the LATER one is bare', () => {
    const raw = streamLines([
      wrappedMessageStart({
        message: { model: 'claude-sonnet-4', usage: { input_tokens: 1 } },
      }),
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 333 } },
      }),
    ])
    const ms = lastMessageStart(raw)
    expect(ms.message.usage.input_tokens).toBe(333)
    expect(ms.message.model).toBe('claude-opus-4-8')
  })

  it('takes the message_start that appears AFTER the result line (by position, not assuming order)', () => {
    const raw = streamLines([
      messageStart({ message: { usage: { input_tokens: 11 } } }),
      resultLine(),
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 444 } },
      }),
    ])
    const ms = lastMessageStart(raw)
    expect(ms.message.usage.input_tokens).toBe(444)
  })

  it('a wrapped envelope whose inner event is NOT message_start is ignored', () => {
    const raw = streamLines([
      messageStart({ message: { usage: { input_tokens: 7 } } }),
      { type: 'stream_event', event: { type: 'content_block_delta' } },
    ])
    const ms = lastMessageStart(raw)
    expect(ms.message.usage.input_tokens).toBe(7)
  })
})

describe('QA: computeContextEnd — message_start AFTER result (#534)', () => {
  it('sums the LAST message_start even when it follows the result line', () => {
    const raw = streamLines([
      messageStart({ message: { usage: { input_tokens: 5 } } }),
      resultLine({ usage: { input_tokens: 999_999 } }),
      messageStart({
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 50,
          },
        },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_tokens).toBe(350)
    expect(c.model).toBe('claude-opus-4-8')
  })
})

describe('QA: computeContextEnd — partial usage fields (#534)', () => {
  it('only input_tokens present (no cache fields) sums correctly, no NaN', () => {
    const raw = streamLines([
      messageStart({ message: { usage: { input_tokens: 100 } } }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_tokens).toBe(100)
    expect(Number.isNaN(c.context_end_tokens)).toBe(false)
  })

  it('only cache fields present (no input_tokens) sums correctly, no NaN', () => {
    const raw = streamLines([
      messageStart({
        message: {
          usage: { cache_read_input_tokens: 10, cache_creation_input_tokens: 15 },
        },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_tokens).toBe(25)
    expect(Number.isNaN(c.context_end_tokens)).toBe(false)
  })

  it('usage entirely missing => 0 tokens, never NaN', () => {
    const raw = streamLines([{ type: 'message_start', message: { model: 'claude-opus-4-8' } }])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_tokens).toBe(0)
    expect(Number.isNaN(c.context_end_tokens)).toBe(false)
    expect(c.context_end_pct).toBeNull()
  })

  it('usage values explicitly null => treated as 0 (?? catches null), no NaN', () => {
    const raw = streamLines([
      messageStart({
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
          },
        },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_tokens).toBe(0)
    expect(Number.isNaN(c.context_end_tokens)).toBe(false)
    expect(c.context_end_pct).toBeNull()
  })

  // ----- BUG SURFACE: string usage values -----
  // The dev's sum uses `(usage.x ?? 0)`, which only substitutes for null/undefined.
  // A STRING value (e.g. "500") survives `??` and is then `+`-combined, so JS does
  // STRING CONCATENATION instead of numeric addition. The correct behavior is a
  // NUMBER. These tests assert the correct behavior and are EXPECTED TO FAIL until
  // the dev coerces usage values numerically (e.g. Number(x) || 0). Do not relax.
  it('BUG: string input_tokens "500" must sum as the NUMBER 500, not concatenate', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: '500' } },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(typeof c.context_end_tokens).toBe('number')
    expect(c.context_end_tokens).toBe(500)
    expect(Number.isNaN(c.context_end_tokens)).toBe(false)
  })

  it('BUG: mixed string + number usage must add numerically (string "500" + number 10 = 510)', () => {
    const raw = streamLines([
      messageStart({
        message: {
          model: 'claude-opus-4-8',
          usage: { input_tokens: '500', cache_read_input_tokens: 10 },
        },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(typeof c.context_end_tokens).toBe('number')
    expect(c.context_end_tokens).toBe(510)
  })
})

describe('QA: computeContextEnd — model edge cases (#534)', () => {
  it('model missing => model null, pct null (no window), tokens still emitted', () => {
    const raw = streamLines([
      { type: 'message_start', message: { usage: { input_tokens: 42 } } },
    ])
    const c = computeContextEnd(raw, null)
    expect(c.model).toBeNull()
    expect(c.context_end_pct).toBeNull()
    expect(c.context_end_tokens).toBe(42)
  })

  it('model non-string (number) => model null, pct null, tokens emitted', () => {
    const raw = streamLines([
      { type: 'message_start', message: { model: 12345, usage: { input_tokens: 42 } } },
    ])
    const c = computeContextEnd(raw, null)
    expect(c.model).toBeNull()
    expect(c.context_end_pct).toBeNull()
    expect(c.context_end_tokens).toBe(42)
  })

  it('model empty string => model "" (or null), pct null, tokens emitted', () => {
    const raw = streamLines([
      { type: 'message_start', message: { model: '', usage: { input_tokens: 42 } } },
    ])
    const c = computeContextEnd(raw, null)
    // '' is a string so model passes through as ''; window unknown -> pct null.
    expect(c.context_end_pct).toBeNull()
    expect(c.context_end_tokens).toBe(42)
  })
})

describe('QA: resolveContextWindow — override precedence (#534)', () => {
  it('override BEATS a known model map value (opus + 50000 => 50000)', () => {
    expect(resolveContextWindow('claude-opus-4-8', 50_000)).toBe(50_000)
  })

  it('override applies to computed pct (opus + 50000 => pct uses 50000)', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 5000 } },
      }),
    ])
    const c = computeContextEnd(raw, 50_000)
    expect(c.context_end_pct).toBeCloseTo(0.1, 10)
  })

  it('invalid overrides (0, -10, NaN, Infinity, "abc", "") fall back to the opus map', () => {
    for (const bad of [0, -10, NaN, Infinity, 'abc', '']) {
      expect(resolveContextWindow('claude-opus-4-8', bad)).toBe(1_000_000)
    }
  })

  it('numeric STRING override "50000" is honored (coerced via Number)', () => {
    expect(resolveContextWindow('claude-opus-4-8', '50000')).toBe(50_000)
  })
})

describe('QA: computeContextEnd — unknown model + override interplay (#534)', () => {
  it('unknown model, no override => tokens + model, pct null', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'mystery-x', usage: { input_tokens: 42 } },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_tokens).toBe(42)
    expect(c.model).toBe('mystery-x')
    expect(c.context_end_pct).toBeNull()
  })

  it('unknown model WITH a valid override => pct computed from the override', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'mystery-x', usage: { input_tokens: 100 } },
      }),
    ])
    const c = computeContextEnd(raw, 400)
    expect(c.context_end_pct).toBeCloseTo(0.25, 10)
  })
})

describe('QA: computeContextEnd — zero tokens with known window (#534)', () => {
  it('zero tokens + a known window => pct null (intentional, per dev choice)', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 0 } },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_tokens).toBe(0)
    expect(c.model).toBe('claude-opus-4-8')
    expect(c.context_end_pct).toBeNull()
  })

  it('zero tokens + an explicit override window => still pct null', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'mystery', usage: { input_tokens: 0 } },
      }),
    ])
    const c = computeContextEnd(raw, 1000)
    expect(c.context_end_pct).toBeNull()
  })
})

describe('QA: computeContextEnd — rounding / precision (#534)', () => {
  it('rounds an exact 6-dp ratio precisely (12345 / 1_000_000 = 0.012345)', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 12_345 } },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_pct).toBe(0.012345)
  })

  it('a tiny occupancy stays non-zero at 6 dp (350 / 1_000_000 = 0.00035)', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 350 } },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_pct).toBe(0.00035)
    expect(c.context_end_pct).toBeGreaterThan(0)
  })

  it('rounds beyond 6 dp (1 / 1_000_000 = 0.000001, exact)', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 1 } },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_pct).toBe(0.000001)
  })
})

// ---------------------------------------------------------------------------
// #553: surface the RESOLVED context_window alongside context_end_pct so the
// recorded window is guaranteed identical to the one behind the pct.
// ---------------------------------------------------------------------------

describe('computeContextEnd — resolved context_window (#553)', () => {
  it('opus -> 1_000_000', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 100 } },
      }),
    ])
    expect(computeContextEnd(raw, null).context_window).toBe(1_000_000)
  })

  it('sonnet -> 1_000_000', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100 } },
      }),
    ])
    expect(computeContextEnd(raw, null).context_window).toBe(1_000_000)
  })

  it('fable -> 1_000_000', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-fable-1', usage: { input_tokens: 100 } },
      }),
    ])
    expect(computeContextEnd(raw, null).context_window).toBe(1_000_000)
  })

  it('haiku -> 200_000', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-haiku-4-5', usage: { input_tokens: 100 } },
      }),
    ])
    expect(computeContextEnd(raw, null).context_window).toBe(200_000)
  })

  it('unrecognized model id -> null', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'mystery-x', usage: { input_tokens: 100 } },
      }),
    ])
    expect(computeContextEnd(raw, null).context_window).toBeNull()
  })

  it('honors the override argument (returns the overridden value)', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 100 } },
      }),
    ])
    expect(computeContextEnd(raw, 500_000).context_window).toBe(500_000)
  })

  it('override applies even for an unknown model', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'mystery-x', usage: { input_tokens: 100 } },
      }),
    ])
    expect(computeContextEnd(raw, 123_456).context_window).toBe(123_456)
  })

  it('the returned window equals the one implied by context_end_pct (tokens / window)', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 12_345 } },
      }),
    ])
    const c = computeContextEnd(raw, null)
    // pct === tokens / window, so window === tokens / pct.
    expect(c.context_end_tokens / c.context_window).toBe(c.context_end_pct)
  })
})

describe('buildIssueEvent — emits context_window after model (#553)', () => {
  it('emits context_window (1_000_000 for opus) in the context cluster', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 100 } },
      }),
      resultLine(),
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.context_window).toBe(1_000_000)
  })

  it('positions context_window IMMEDIATELY AFTER model in key order', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 100 } },
      }),
      resultLine(),
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    const keys = Object.keys(e)
    expect(keys.indexOf('context_window')).toBe(keys.indexOf('model') + 1)
  })

  it('honors the contextWindowOverride input', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'mystery', usage: { input_tokens: 100 } },
      }),
    ])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, contextWindowOverride: 1000 }),
    )
    expect(e.context_window).toBe(1000)
  })

  it('context_window is null for an unrecognized model with no override', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'mystery', usage: { input_tokens: 7 } },
      }),
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.context_window).toBeNull()
  })

  it('context_window is ALWAYS present (null) on garbage / null input', () => {
    expect(buildIssueEvent(baseInput({ rawStreamJson: 'garbage\n{broken' }))).toHaveProperty(
      'context_window',
      null,
    )
    expect(buildIssueEvent(null)).toHaveProperty('context_window', null)
  })
})

describe('QA: buildIssueEvent — context fields always present + safe (#534)', () => {
  it('buildIssueEvent(undefined) still emits the three context fields safely', () => {
    const e = buildIssueEvent(undefined)
    expect(e).toHaveProperty('context_end_tokens', 0)
    expect(e).toHaveProperty('context_end_pct', null)
    expect(e).toHaveProperty('model', null)
  })

  it('empty stream string emits zero/null context fields', () => {
    const e = buildIssueEvent(baseInput({ rawStreamJson: '' }))
    expect(e.context_end_tokens).toBe(0)
    expect(e.context_end_pct).toBeNull()
    expect(e.model).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#553): the resolved context_window is the SINGLE SOURCE OF
// TRUTH behind context_end_pct. These adversarial tests target invariants the
// happy-path #553 suite did not: the pct/window/tokens consistency guarantee
// (both directions), context_window fall-back on INVALID overrides routed
// THROUGH computeContextEnd/buildIssueEvent (not just resolveContextWindow),
// case-insensitive + substring model matching reflected in the window, and
// haiku / invalid-override flow through buildIssueEvent.
// ---------------------------------------------------------------------------

describe('QA: computeContextEnd — pct/window/tokens consistency invariant (#553)', () => {
  // The core "single source of truth" guarantee, both directions:
  //   - window non-null  => round(tokens/window, 6dp) === pct
  //   - window null      => pct MUST be null (never a bare/invented number)
  const scenarios = [
    { name: 'opus, small tokens', model: 'claude-opus-4-8', override: null, tokens: 350 },
    { name: 'opus, exact-6dp tokens', model: 'claude-opus-4-8', override: null, tokens: 12_345 },
    { name: 'opus, awkward tokens (rounding)', model: 'claude-opus-4-8', override: null, tokens: 7 },
    { name: 'haiku, tokens', model: 'claude-haiku-4-5', override: null, tokens: 33_333 },
    { name: 'sonnet, big tokens', model: 'claude-sonnet-4-5', override: null, tokens: 987_654 },
    { name: 'unknown model, no override (window null)', model: 'mystery-x', override: null, tokens: 500 },
    { name: 'unknown model + valid override', model: 'mystery-x', override: 40_000, tokens: 10_000 },
    { name: 'opus + override beats map', model: 'claude-opus-4-8', override: 250_000, tokens: 12_500 },
    { name: 'opus + INVALID override (falls to map)', model: 'claude-opus-4-8', override: 0, tokens: 12_345 },
  ]

  for (const { name, model, override, tokens } of scenarios) {
    it(`[${name}] window null <=> pct null, and pct === round(tokens/window)`, () => {
      const raw = streamLines([
        messageStart({ message: { model, usage: { input_tokens: tokens } } }),
      ])
      const c = computeContextEnd(raw, override)
      if (c.context_window === null) {
        // No window we trust => we must NOT emit a percentage.
        expect(c.context_end_pct).toBeNull()
      } else {
        // pct is EXACTLY the 6-dp rounding of tokens/window — same window that
        // produced pct is the one surfaced in context_window.
        const expected = Math.round((tokens / c.context_window) * 1e6) / 1e6
        expect(c.context_end_pct).toBe(expected)
      }
    })
  }

  it('whenever context_end_pct is non-null, context_window is a positive finite number', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 4321 } },
      }),
    ])
    const c = computeContextEnd(raw, null)
    expect(c.context_end_pct).not.toBeNull()
    expect(Number.isFinite(c.context_window)).toBe(true)
    expect(c.context_window).toBeGreaterThan(0)
  })
})

describe('QA: computeContextEnd — context_window fall-back on invalid overrides (#553)', () => {
  // resolveContextWindow ignores bad overrides; verify the IGNORING is visible
  // on the RESOLVED context_window field routed through computeContextEnd, not
  // just via resolveContextWindow directly.
  const mkRaw = (model) =>
    streamLines([
      messageStart({ message: { model, usage: { input_tokens: 100 } } }),
    ])

  for (const bad of [0, -5, NaN, Infinity, -Infinity, 'abc', '', null, undefined]) {
    it(`invalid override ${String(bad)} on opus => context_window falls back to 1_000_000`, () => {
      expect(computeContextEnd(mkRaw('claude-opus-4-8'), bad).context_window).toBe(
        1_000_000,
      )
    })
  }

  for (const bad of [0, -5, NaN, Infinity, 'abc']) {
    it(`invalid override ${String(bad)} on an UNKNOWN model => context_window stays null`, () => {
      const c = computeContextEnd(mkRaw('mystery-x'), bad)
      expect(c.context_window).toBeNull()
      expect(c.context_end_pct).toBeNull()
    })
  }

  it('valid numeric-string override "50000" on unknown model => context_window 50000', () => {
    const c = computeContextEnd(mkRaw('mystery-x'), '50000')
    expect(c.context_window).toBe(50_000)
    // and the pct is computed from that very window
    expect(c.context_end_pct).toBe(Math.round((100 / 50_000) * 1e6) / 1e6)
  })

  it('valid override with trailing/leading whitespace " 2000 " is coerced (Number) and wins', () => {
    const c = computeContextEnd(mkRaw('mystery-x'), ' 2000 ')
    expect(c.context_window).toBe(2000)
  })
})

describe('QA: computeContextEnd — case-insensitive + substring model matching drives the window (#553)', () => {
  const mkRaw = (model) =>
    streamLines([
      messageStart({ message: { model, usage: { input_tokens: 100 } } }),
    ])

  it('ALL-CAPS opus id "CLAUDE-OPUS-4-8" resolves to 1_000_000', () => {
    expect(computeContextEnd(mkRaw('CLAUDE-OPUS-4-8'), null).context_window).toBe(
      1_000_000,
    )
  })

  it('mixed-case "Claude-Haiku-4-5" resolves to 200_000', () => {
    expect(computeContextEnd(mkRaw('Claude-Haiku-4-5'), null).context_window).toBe(
      200_000,
    )
  })

  it('a vendor-prefixed id merely CONTAINING "sonnet" resolves to 1_000_000', () => {
    expect(
      computeContextEnd(mkRaw('bedrock/anthropic.SONNET-custom'), null).context_window,
    ).toBe(1_000_000)
  })

  it('an id containing "fable" as a substring resolves to 1_000_000', () => {
    expect(computeContextEnd(mkRaw('internal-fable-preview'), null).context_window).toBe(
      1_000_000,
    )
  })

  it('an id containing NONE of the known substrings stays null', () => {
    expect(computeContextEnd(mkRaw('some-mystery-model'), null).context_window).toBeNull()
  })
})

describe('QA: buildIssueEvent — context_window flows + is never undefined (#553)', () => {
  it('valid haiku stream => context_window 200_000 flows through buildIssueEvent', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-haiku-4-5', usage: { input_tokens: 100 } },
      }),
      resultLine(),
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.context_window).toBe(200_000)
  })

  it('haiku + override => the OVERRIDDEN value flows through (override wins over 200_000)', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-haiku-4-5', usage: { input_tokens: 100 } },
      }),
    ])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, contextWindowOverride: 12_000 }),
    )
    expect(e.context_window).toBe(12_000)
  })

  it('INVALID override (0) on opus stream => context_window falls back to 1_000_000', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 100 } },
      }),
    ])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, contextWindowOverride: 0 }),
    )
    expect(e.context_window).toBe(1_000_000)
  })

  it('context_window is a present key (never undefined) across malformed inputs', () => {
    const inputs = [
      null,
      undefined,
      baseInput({ rawStreamJson: '' }),
      baseInput({ rawStreamJson: 'not json\n{broken' }),
      baseInput({ rawStreamJson: streamLines([{ type: 'message_start', message: {} }]) }),
      baseInput({ rawStreamJson: streamLines([resultLine()]) }),
    ]
    for (const input of inputs) {
      const e = buildIssueEvent(input)
      expect('context_window' in e).toBe(true)
      expect(e.context_window).not.toBeUndefined()
    }
  })

  it('context_window equals context.context_window: matches computeContextEnd for the same stream/override', () => {
    const raw = streamLines([
      messageStart({
        message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 4321 } },
      }),
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw, contextWindowOverride: null }))
    const c = computeContextEnd(raw, null)
    expect(e.context_window).toBe(c.context_window)
    expect(e.context_end_pct).toBe(c.context_end_pct)
  })

  it('event-level invariant: context_window null <=> context_end_pct null', () => {
    const rawKnown = streamLines([
      messageStart({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 5 } } }),
    ])
    const rawUnknown = streamLines([
      messageStart({ message: { model: 'mystery-x', usage: { input_tokens: 5 } } }),
    ])
    const known = buildIssueEvent(baseInput({ rawStreamJson: rawKnown }))
    const unknown = buildIssueEvent(baseInput({ rawStreamJson: rawUnknown }))
    expect(known.context_window).not.toBeNull()
    expect(known.context_end_pct).not.toBeNull()
    expect(unknown.context_window).toBeNull()
    expect(unknown.context_end_pct).toBeNull()
  })
})

// --- #554: agent field + Codex event building ------------------------------
function codexTurnCompleted(usage = {}) {
  return {
    type: 'turn.completed',
    usage: {
      input_tokens: 10882,
      cached_input_tokens: 5690,
      cache_write_input_tokens: 0,
      output_tokens: 41,
      reasoning_output_tokens: 34,
      ...usage,
    },
  }
}

describe('buildIssueEvent — agent field (#554)', () => {
  it('defaults agent to "claude" with no agent input (no regression pin)', () => {
    const e = buildIssueEvent(baseInput())
    expect(e.agent).toBe('claude')
    // The full Claude event still carries every legacy field name.
    expect(e).toMatchObject({
      issue_number: 98,
      subtype: 'success',
      total_cost_usd: 0.1234,
      num_turns: 7,
      duration_ms: 4200,
      claude_exit_code: 0,
      verdict: 'unknown',
    })
    expect('claude_exit_code' in e).toBe(true)
  })

  it('records agent "codex" when injected', () => {
    const raw = streamLines([codexTurnCompleted()])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw, agent: 'codex' }))
    expect(e.agent).toBe('codex')
  })

  it('positions agent immediately after ts', () => {
    const keys = Object.keys(buildIssueEvent(baseInput()))
    expect(keys.indexOf('agent')).toBe(keys.indexOf('ts') + 1)
  })
})

describe('buildIssueEvent — codex zero/null gaps (#554)', () => {
  it('cost stays 0 and model comes from the injected configured model', () => {
    const raw = streamLines([codexTurnCompleted()])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, agent: 'codex', model: 'gpt-5-codex' }),
    )
    expect(e.total_cost_usd).toBe(0)
    expect(e.model).toBe('gpt-5-codex')
    expect(e.subtype).toBe('success')
    // Folded output: 41 + 34.
    expect(e.usage.output_tokens).toBe(75)
    expect(e.usage.cache_read_input_tokens).toBe(5690)
  })

  it('model is null when no configured model is injected', () => {
    const raw = streamLines([codexTurnCompleted()])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw, agent: 'codex' }))
    expect(e.model).toBeNull()
    // Unknown/absent model => no window => null pct.
    expect(e.context_window).toBeNull()
    expect(e.context_end_pct).toBeNull()
  })

  it('uses the injected wall-clock duration when the stream reports none', () => {
    const raw = streamLines([codexTurnCompleted()])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, agent: 'codex', durationMs: 90000 }),
    )
    expect(e.duration_ms).toBe(90000)
  })

  it('resolves a codex model window when the configured model is known', () => {
    const raw = streamLines([codexTurnCompleted({ input_tokens: 4000 })])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, agent: 'codex', model: 'gpt-5-codex' }),
    )
    expect(e.context_window).toBe(400_000)
    expect(e.context_end_pct).not.toBeNull()
  })

  it('a codex failure stream yields subtype "error"', () => {
    const raw = streamLines([
      { type: 'turn.started' },
      { type: 'turn.failed', error: { message: 'boom' } },
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw, agent: 'codex' }))
    expect(e.subtype).toBe('error')
  })
})

describe('resolveContextWindow — OpenAI prefixes (#554)', () => {
  it('gpt-5 family => 400_000', () => {
    expect(resolveContextWindow('gpt-5-codex', null)).toBe(400_000)
    expect(resolveContextWindow('gpt-5', null)).toBe(400_000)
  })
  it('gpt-4.1 => 400_000', () => {
    expect(resolveContextWindow('gpt-4.1', null)).toBe(400_000)
  })
  it('o3 / o4 families => 400_000', () => {
    expect(resolveContextWindow('o3', null)).toBe(400_000)
    expect(resolveContextWindow('o4-mini', null)).toBe(400_000)
  })
  it('codex-branded model => 400_000', () => {
    expect(resolveContextWindow('codex-mini-latest', null)).toBe(400_000)
  })
  it('legacy gpt-4o => 128_000 (not swallowed by the generic gpt rule)', () => {
    expect(resolveContextWindow('gpt-4o', null)).toBe(128_000)
    expect(resolveContextWindow('gpt-4o-mini', null)).toBe(128_000)
  })
  it('unknown OpenAI-ish id stays null', () => {
    expect(resolveContextWindow('davinci-003', null)).toBeNull()
  })
  it('manual override still wins over an OpenAI prefix', () => {
    expect(resolveContextWindow('gpt-5-codex', 250_000)).toBe(250_000)
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#554): OpenAI prefix boundaries, override precedence with a
// codex model, and codex event invariants the happy path did not pin.
// ---------------------------------------------------------------------------

describe('QA: resolveContextWindow — OpenAI prefix boundaries (#554)', () => {
  it('gpt-3.5 does NOT match any OpenAI window rule => null', () => {
    // gpt-3.5 contains neither gpt-4/gpt-5/codex nor o3/o4 => unknown.
    expect(resolveContextWindow('gpt-3.5-turbo', null)).toBeNull()
  })

  it('a bare "o3" / "o4" token matches; an unrelated "o30xyz" does NOT via \\b', () => {
    expect(resolveContextWindow('o3', null)).toBe(400_000)
    // startsWith('o3') fires for a leading o3 id, but a middle-of-word o3 does not.
    expect(resolveContextWindow('foo-o3', null)).toBe(400_000) // \bo3\b word boundary
    expect(resolveContextWindow('proto', null)).toBeNull() // 'o3' not present at all
  })

  it('gpt-4o wins over the generic gpt-4 rule (128k, not 400k)', () => {
    expect(resolveContextWindow('gpt-4o', null)).toBe(128_000)
    expect(resolveContextWindow('gpt-4o-2024-08-06', null)).toBe(128_000)
  })

  it('gpt-4-turbo (non-4o gpt-4) resolves to the 400k OpenAI window', () => {
    expect(resolveContextWindow('gpt-4-turbo', null)).toBe(400_000)
  })

  it('case-insensitive: GPT-5-CODEX resolves to 400_000', () => {
    expect(resolveContextWindow('GPT-5-CODEX', null)).toBe(400_000)
  })

  it('a near-miss OpenAI-ish id ("openai-mystery") stays null', () => {
    expect(resolveContextWindow('openai-mystery', null)).toBeNull()
  })

  it('numeric-string override wins over a codex model prefix', () => {
    expect(resolveContextWindow('gpt-5-codex', '250000')).toBe(250_000)
  })
})

describe('QA: buildIssueEvent — codex event invariants (#554)', () => {
  it('total_cost_usd is EXACTLY 0 even when a completed turn ran (never estimated)', () => {
    const raw = streamLines([codexTurnCompleted({ input_tokens: 50_000 })])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, agent: 'codex', model: 'gpt-5-codex' }),
    )
    expect(e.total_cost_usd).toBe(0)
  })

  it('agent field is "codex" and sits immediately after ts', () => {
    const raw = streamLines([codexTurnCompleted()])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw, agent: 'codex' }))
    expect(e.agent).toBe('codex')
    const keys = Object.keys(e)
    expect(keys.indexOf('agent')).toBe(keys.indexOf('ts') + 1)
  })

  it('injected model override drives the codex window (gpt-4o => 128k)', () => {
    // Zero the cache fields so context_end_tokens == input_tokens exactly.
    const raw = streamLines([
      codexTurnCompleted({
        input_tokens: 12_800,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
      }),
    ])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, agent: 'codex', model: 'gpt-4o' }),
    )
    expect(e.model).toBe('gpt-4o')
    expect(e.context_window).toBe(128_000)
    expect(e.context_end_tokens).toBe(12_800)
    expect(e.context_end_pct).toBeCloseTo(12_800 / 128_000, 10)
  })

  it('contextWindowOverride beats the injected codex model window', () => {
    const raw = streamLines([
      codexTurnCompleted({
        input_tokens: 1000,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
      }),
    ])
    const e = buildIssueEvent(
      baseInput({
        rawStreamJson: raw,
        agent: 'codex',
        model: 'gpt-5-codex',
        contextWindowOverride: 100_000,
      }),
    )
    expect(e.context_window).toBe(100_000)
    expect(e.context_end_tokens).toBe(1000)
    expect(e.context_end_pct).toBeCloseTo(1000 / 100_000, 10)
  })

  it('codex model stays null when neither stream nor override supplies one', () => {
    const raw = streamLines([codexTurnCompleted()])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw, agent: 'codex' }))
    expect(e.model).toBeNull()
    expect(e.context_window).toBeNull()
    expect(e.context_end_pct).toBeNull()
  })

  it('injected wall-clock duration is used ONLY when the stream self-reports none', () => {
    // Codex stream carries no duration => the injected 90s wall-clock is used.
    const raw = streamLines([codexTurnCompleted()])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, agent: 'codex', durationMs: 90_000 }),
    )
    expect(e.duration_ms).toBe(90_000)
  })

  it('a non-positive injected duration leaves duration_ms at the stream value (0)', () => {
    const raw = streamLines([codexTurnCompleted()])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, agent: 'codex', durationMs: 0 }),
    )
    expect(e.duration_ms).toBe(0)
  })

  it('a claude stream IGNORES an injected durationMs (stream duration wins)', () => {
    // Regression guard: Claude self-reports duration_ms=4200, so the injected
    // wall-clock must NOT override it.
    const e = buildIssueEvent(baseInput({ durationMs: 99_999 }))
    expect(e.duration_ms).toBe(4200)
  })

  it('codex event keeps every legacy field name (claude_exit_code present)', () => {
    const raw = streamLines([codexTurnCompleted()])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, agent: 'codex', claudeExitCode: 0 }),
    )
    expect('claude_exit_code' in e).toBe(true)
    expect(e.claude_exit_code).toBe(0)
  })
})

describe('QA: buildIssueEvent — claude no-regression with an agent param (#554)', () => {
  it('explicit agent:"claude" produces identical field values to the default', () => {
    const withDefault = buildIssueEvent(baseInput())
    const withExplicit = buildIssueEvent(baseInput({ agent: 'claude' }))
    expect(withExplicit).toEqual(withDefault)
  })

  it('an injected model override is IGNORED for claude (stream model wins)', () => {
    const raw = streamLines([
      messageStart({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 5 } } }),
      resultLine(),
    ])
    const e = buildIssueEvent(
      baseInput({ rawStreamJson: raw, agent: 'claude', model: 'gpt-5-codex' }),
    )
    // The stream carries a real model; the override must not clobber it.
    expect(e.model).toBe('claude-opus-4-8')
    expect(e.context_window).toBe(1_000_000)
  })
})
