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
