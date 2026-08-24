import { describe, it, expect } from 'vitest'
import { parseAgentStream, lastMessageStart, normalizeUsage } from './agent-stream.js'

// ---- Claude fixtures (carried over from issue-event.test.js to PIN behavior) ----
function streamLines(objs) {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

const claudeResult = (overrides = {}) => ({
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

const claudeMessageStart = (overrides = {}) => ({
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
})

describe('parseAgentStream — claude (pinned carry-over)', () => {
  it('reads subtype/turns from the result line', () => {
    const raw = streamLines([claudeMessageStart(), claudeResult()])
    const p = parseAgentStream(raw, 'claude')
    expect(p.subtype).toBe('success')
    expect(p.num_turns).toBe(7)
  })

  it('normalizes usage from the result line', () => {
    const raw = streamLines([claudeResult()])
    const p = parseAgentStream(raw, 'claude')
    expect(p.usage).toEqual({
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    })
  })

  it('uses the LAST result line when several appear', () => {
    const raw = streamLines([
      claudeResult({ subtype: 'error_max_turns', total_cost_usd: 0.01 }),
      claudeResult({ subtype: 'success', total_cost_usd: 0.99 }),
    ])
    const p = parseAgentStream(raw, 'claude')
    expect(p.subtype).toBe('success')
  })

  it('derives model + context_end_tokens from the last message_start', () => {
    const raw = streamLines([claudeMessageStart(), claudeResult()])
    const p = parseAgentStream(raw, 'claude')
    expect(p.model).toBe('claude-opus-4-8')
    // input(100) + cache_read(200) + cache_creation(50)
    expect(p.context_end_tokens).toBe(350)
  })

  it('degrades to zeros/null when the result line is missing', () => {
    const raw = streamLines([{ type: 'assistant', message: {} }])
    const p = parseAgentStream(raw, 'claude')
    expect(p.subtype).toBeNull()
    expect(p.num_turns).toBe(0)
    expect(p.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    expect(p.model).toBeNull()
    expect(p.context_end_tokens).toBe(0)
  })

  it('never throws on blank/non-JSON claude input', () => {
    expect(() => parseAgentStream('', 'claude')).not.toThrow()
    expect(() => parseAgentStream('not json\n{bad', 'claude')).not.toThrow()
    expect(parseAgentStream('', 'claude').context_end_tokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// #39: the claude `result` event carries BOTH `subtype` and `is_error`, and they
// DISAGREE on a hard failure — the real auth-failure payload is
// {"subtype":"success","is_error":true,"num_turns":1}. The flag is
// authoritative, so a flagged result never reports a success subtype.
// ---------------------------------------------------------------------------

describe('parseAgentStream — claude result is_error flag (#39)', () => {
  it('the real auth-failure payload does NOT report a success subtype', () => {
    const raw = streamLines([
      { type: 'result', subtype: 'success', is_error: true, num_turns: 1 },
    ])
    const p = parseAgentStream(raw, 'claude')
    expect(p.subtype).not.toBe('success')
    expect(p.subtype).toBe('error')
    // The flag itself is surfaced on the normalized result.
    expect(p.is_error).toBe(true)
    // Everything else on that line is still read as before.
    expect(p.num_turns).toBe(1)
  })

  it('a flagged result KEEPS its own subtype when that already names the error', () => {
    const raw = streamLines([claudeResult({ subtype: 'error_max_turns', is_error: true })])
    const p = parseAgentStream(raw, 'claude')
    expect(p.subtype).toBe('error_max_turns')
    expect(p.is_error).toBe(true)
  })

  it('is_error false preserves the current behavior exactly (subtype "success")', () => {
    const raw = streamLines([claudeResult({ is_error: false })])
    const p = parseAgentStream(raw, 'claude')
    expect(p.subtype).toBe('success')
    expect(p.is_error).toBe(false)
  })

  it('an ABSENT is_error preserves the current behavior exactly (subtype "success")', () => {
    const raw = streamLines([claudeResult()])
    const p = parseAgentStream(raw, 'claude')
    expect(p.subtype).toBe('success')
    expect(p.is_error).toBe(false)
  })

  it('the LAST result line decides the flag (a clean retry clears an earlier failure)', () => {
    const raw = streamLines([
      claudeResult({ subtype: 'success', is_error: true }),
      claudeResult({ subtype: 'success', is_error: false }),
    ])
    const p = parseAgentStream(raw, 'claude')
    expect(p.subtype).toBe('success')
    expect(p.is_error).toBe(false)
  })

  it('a flagged result with NO subtype at all reports the generic error subtype', () => {
    const raw = streamLines([{ type: 'result', is_error: true }])
    const p = parseAgentStream(raw, 'claude')
    expect(p.subtype).toBe('error')
    expect(p.is_error).toBe(true)
  })

  it('a MISSING result line is not an error (flag false, subtype null)', () => {
    const raw = streamLines([{ type: 'assistant', message: {} }])
    const p = parseAgentStream(raw, 'claude')
    expect(p.subtype).toBeNull()
    expect(p.is_error).toBe(false)
  })
})

// ---- Codex fixtures (observed real event shape from `codex exec --json`) ----
const codexTurnCompleted = (usage = {}) => ({
  type: 'turn.completed',
  usage: {
    input_tokens: 10882,
    cached_input_tokens: 5690,
    cache_write_input_tokens: 0,
    output_tokens: 41,
    reasoning_output_tokens: 34,
    ...usage,
  },
})

describe('parseAgentStream — codex', () => {
  it('maps token usage onto the four normalized keys', () => {
    const raw = streamLines([
      { type: 'thread.started', thread_id: 'x' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'hi' } },
      codexTurnCompleted(),
    ])
    const p = parseAgentStream(raw, 'codex')
    expect(p.usage.input_tokens).toBe(10882)
    expect(p.usage.cache_read_input_tokens).toBe(5690)
    expect(p.usage.cache_creation_input_tokens).toBe(0)
    // output(41) + reasoning(34) folded together
    expect(p.usage.output_tokens).toBe(75)
  })

  it('folds reasoning tokens into output tokens', () => {
    const raw = streamLines([
      codexTurnCompleted({ output_tokens: 100, reasoning_output_tokens: 900 }),
    ])
    const p = parseAgentStream(raw, 'codex')
    expect(p.usage.output_tokens).toBe(1000)
  })

  it('counts completed turns for num_turns', () => {
    const raw = streamLines([
      { type: 'turn.started' },
      codexTurnCompleted(),
      { type: 'turn.started' },
      codexTurnCompleted({ input_tokens: 20 }),
    ])
    const p = parseAgentStream(raw, 'codex')
    expect(p.num_turns).toBe(2)
  })

  it('reports subtype "success" when a turn completed and none failed', () => {
    const raw = streamLines([codexTurnCompleted()])
    expect(parseAgentStream(raw, 'codex').subtype).toBe('success')
  })

  it('reports subtype "error" when a turn.failed event is present', () => {
    const raw = streamLines([
      { type: 'turn.started' },
      { type: 'turn.failed', error: { message: 'boom' } },
    ])
    const p = parseAgentStream(raw, 'codex')
    expect(p.subtype).toBe('error')
    expect(p.num_turns).toBe(0)
  })

  it('reports subtype "error" when a top-level error event is present', () => {
    const raw = streamLines([
      { type: 'item.completed', item: { type: 'error', message: 'model not found' } },
      { type: 'error', message: 'unexpected status 404' },
      { type: 'turn.failed', error: { message: '404' } },
    ])
    expect(parseAgentStream(raw, 'codex').subtype).toBe('error')
  })

  it('model is null — the codex stream carries no model id', () => {
    const raw = streamLines([codexTurnCompleted()])
    expect(parseAgentStream(raw, 'codex').model).toBeNull()
  })

  it('cost and self-reported duration are 0 (loop injects wall-clock)', () => {
    const raw = streamLines([codexTurnCompleted()])
    const p = parseAgentStream(raw, 'codex')
    expect(p.total_cost_usd).toBe(0)
    expect(p.duration_ms).toBe(0)
  })

  it('context_end_tokens is the input side of the last turn (input + cache)', () => {
    const raw = streamLines([
      codexTurnCompleted({
        input_tokens: 12345,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
      }),
    ])
    expect(parseAgentStream(raw, 'codex').context_end_tokens).toBe(12345)
  })

  it('folds cached-input and cache-write into context_end_tokens', () => {
    const raw = streamLines([
      codexTurnCompleted({
        input_tokens: 100,
        cached_input_tokens: 20,
        cache_write_input_tokens: 5,
      }),
    ])
    expect(parseAgentStream(raw, 'codex').context_end_tokens).toBe(125)
  })

  it('uses the LAST turn.completed usage for the end-of-job figures', () => {
    const raw = streamLines([
      codexTurnCompleted({ input_tokens: 100 }),
      codexTurnCompleted({ input_tokens: 999 }),
    ])
    expect(parseAgentStream(raw, 'codex').usage.input_tokens).toBe(999)
  })

  // #39: codex has always been explicit about failure, so its subtype is
  // UNCHANGED; the shared normalized result just also carries the flag.
  it('surfaces is_error alongside the subtype, without changing it', () => {
    const ok = parseAgentStream(streamLines([codexTurnCompleted()]), 'codex')
    expect(ok.subtype).toBe('success')
    expect(ok.is_error).toBe(false)

    const failed = parseAgentStream(
      streamLines([{ type: 'turn.started' }, { type: 'turn.failed', error: {} }]),
      'codex',
    )
    expect(failed.subtype).toBe('error')
    expect(failed.is_error).toBe(true)

    const errored = parseAgentStream(
      streamLines([{ type: 'error', message: 'unexpected status 404' }]),
      'codex',
    )
    expect(errored.subtype).toBe('error')
    expect(errored.is_error).toBe(true)
  })

  it('degrades gracefully on blank input', () => {
    const p = parseAgentStream('', 'codex')
    expect(p.subtype).toBeNull()
    expect(p.is_error).toBe(false)
    expect(p.num_turns).toBe(0)
    expect(p.usage.input_tokens).toBe(0)
    expect(p.model).toBeNull()
    expect(p.context_end_tokens).toBe(0)
  })

  it('degrades gracefully on truncated / non-JSON input, never throws', () => {
    const truncated = '{"type":"turn.completed","usage":{"input_tokens":10'
    expect(() => parseAgentStream(truncated, 'codex')).not.toThrow()
    expect(parseAgentStream(truncated, 'codex').usage.input_tokens).toBe(0)
    expect(() => parseAgentStream('garbage\nlines\nhere', 'codex')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#554): adversarial Codex-parser cases the happy path missed.
// Codex's real event shape is ASSUMED, so these pin degradation + coercion.
// ---------------------------------------------------------------------------

describe('QA: parseAgentStream — codex reasoning-token fold (adversarial)', () => {
  it('MISSING reasoning_output_tokens => output_tokens is base output only, no NaN', () => {
    const raw = streamLines([
      {
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 42 }, // no reasoning field
      },
    ])
    const p = parseAgentStream(raw, 'codex')
    expect(p.usage.output_tokens).toBe(42)
    expect(Number.isNaN(p.usage.output_tokens)).toBe(false)
  })

  it('reasoning present but base output MISSING => output_tokens is reasoning only', () => {
    const raw = streamLines([
      { type: 'turn.completed', usage: { reasoning_output_tokens: 7 } },
    ])
    const p = parseAgentStream(raw, 'codex')
    expect(p.usage.output_tokens).toBe(7)
  })

  it('both output and reasoning MISSING => output_tokens 0 (never NaN)', () => {
    const raw = streamLines([{ type: 'turn.completed', usage: { input_tokens: 5 } }])
    const p = parseAgentStream(raw, 'codex')
    expect(p.usage.output_tokens).toBe(0)
    expect(Number.isNaN(p.usage.output_tokens)).toBe(false)
  })
})

describe('QA: parseAgentStream — codex usage coercion (never NaN / concat)', () => {
  it('STRING-typed usage values coerce numerically, not concatenate', () => {
    const raw = streamLines([
      {
        type: 'turn.completed',
        usage: {
          input_tokens: '500',
          output_tokens: '40',
          reasoning_output_tokens: '10',
          cached_input_tokens: '20',
          cache_write_input_tokens: '5',
        },
      },
    ])
    const p = parseAgentStream(raw, 'codex')
    expect(p.usage.input_tokens).toBe(500)
    expect(typeof p.usage.output_tokens).toBe('number')
    expect(p.usage.output_tokens).toBe(50) // 40 + 10 numeric, not "4010"
    expect(p.usage.cache_read_input_tokens).toBe(20)
    expect(p.usage.cache_creation_input_tokens).toBe(5)
    // context_end = input + cache_read + cache_creation, all numeric.
    expect(p.context_end_tokens).toBe(525)
  })

  it('NULL usage values coerce to 0, never NaN', () => {
    const raw = streamLines([
      {
        type: 'turn.completed',
        usage: {
          input_tokens: null,
          output_tokens: null,
          reasoning_output_tokens: null,
          cached_input_tokens: null,
          cache_write_input_tokens: null,
        },
      },
    ])
    const p = parseAgentStream(raw, 'codex')
    for (const v of Object.values(p.usage)) {
      expect(v).toBe(0)
      expect(Number.isNaN(v)).toBe(false)
    }
    expect(p.context_end_tokens).toBe(0)
  })

  it('non-numeric garbage usage values coerce to 0 (never NaN)', () => {
    const raw = streamLines([
      {
        type: 'turn.completed',
        usage: { input_tokens: 'abc', output_tokens: {}, reasoning_output_tokens: [] },
      },
    ])
    const p = parseAgentStream(raw, 'codex')
    expect(p.usage.input_tokens).toBe(0)
    // output {} => NaN via Number, folded with [] => Number([])===0; both -> 0.
    expect(Number.isNaN(p.usage.output_tokens)).toBe(false)
    expect(p.usage.output_tokens).toBe(0)
  })

  it('turn.completed with usage MISSING entirely => all-zero usage, no throw', () => {
    const raw = streamLines([{ type: 'turn.completed' }])
    let p
    expect(() => {
      p = parseAgentStream(raw, 'codex')
    }).not.toThrow()
    expect(p.num_turns).toBe(1)
    expect(p.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })
})

describe('QA: parseAgentStream — codex subtype precedence (adversarial)', () => {
  it('a completed turn FOLLOWED by turn.failed => failure wins (subtype "error")', () => {
    const raw = streamLines([
      { type: 'turn.started' },
      codexTurnCompleted(),
      { type: 'turn.failed', error: { message: 'boom' } },
    ])
    const p = parseAgentStream(raw, 'codex')
    expect(p.subtype).toBe('error')
    // The completed turn is still counted.
    expect(p.num_turns).toBe(1)
    // Usage from the completed turn is preserved.
    expect(p.usage.input_tokens).toBe(10882)
  })

  it('a turn.failed BEFORE a completed turn still yields "error" (any failure wins)', () => {
    const raw = streamLines([
      { type: 'turn.failed', error: { message: 'boom' } },
      codexTurnCompleted(),
    ])
    expect(parseAgentStream(raw, 'codex').subtype).toBe('error')
  })

  it('an item.completed error item ALONE (no turn.failed/error) => "error"', () => {
    const raw = streamLines([
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'error', message: 'model not found' } },
    ])
    expect(parseAgentStream(raw, 'codex').subtype).toBe('error')
  })

  it('ZERO turn.completed events (only turn.started) => num_turns 0, subtype null', () => {
    const raw = streamLines([
      { type: 'thread.started', thread_id: 'x' },
      { type: 'turn.started' },
    ])
    const p = parseAgentStream(raw, 'codex')
    expect(p.num_turns).toBe(0)
    expect(p.subtype).toBeNull()
  })

  it('a later turn.completed WITHOUT usage keeps the prior turn usage (last-with-usage)', () => {
    const raw = streamLines([
      codexTurnCompleted({ input_tokens: 111 }),
      { type: 'turn.completed' }, // no usage object
    ])
    const p = parseAgentStream(raw, 'codex')
    expect(p.num_turns).toBe(2)
    expect(p.usage.input_tokens).toBe(111)
  })
})

describe('QA: parseAgentStream — codex degradation (adversarial)', () => {
  it('whitespace-only input degrades to safe defaults, never throws', () => {
    let p
    expect(() => {
      p = parseAgentStream('   \n\t\n   ', 'codex')
    }).not.toThrow()
    expect(p.subtype).toBeNull()
    expect(p.num_turns).toBe(0)
    expect(p.usage.input_tokens).toBe(0)
    expect(p.context_end_tokens).toBe(0)
  })

  it('interleaved blank lines + garbage between valid events still parses usage', () => {
    const raw = [
      '',
      'not json',
      '{partial',
      JSON.stringify({ type: 'turn.started' }),
      '   ',
      JSON.stringify(codexTurnCompleted({ input_tokens: 4242 })),
      '{ broken',
      '',
    ].join('\n')
    let p
    expect(() => {
      p = parseAgentStream(raw, 'codex')
    }).not.toThrow()
    expect(p.num_turns).toBe(1)
    expect(p.usage.input_tokens).toBe(4242)
    expect(p.subtype).toBe('success')
  })

  it('a truncated FINAL turn.completed line is skipped, earlier complete turn wins', () => {
    const raw =
      JSON.stringify(codexTurnCompleted({ input_tokens: 999 })) +
      '\n' +
      '{"type":"turn.completed","usage":{"input_tokens":10' // truncated
    const p = parseAgentStream(raw, 'codex')
    expect(p.num_turns).toBe(1)
    expect(p.usage.input_tokens).toBe(999)
  })

  it('null rawStream degrades to zeros (parseAgentStream coalesces null to "")', () => {
    const p = parseAgentStream(null, 'codex')
    expect(p.num_turns).toBe(0)
    expect(p.context_end_tokens).toBe(0)
    expect(p.model).toBeNull()
  })
})

describe('QA: parseAgentStream — claude no-regression through the refactor', () => {
  it('a full claude stream produces the exact pre-refactor field values', () => {
    const raw = streamLines([claudeMessageStart(), claudeResult()])
    const p = parseAgentStream(raw, 'claude')
    expect(p).toEqual({
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 25,
      },
      subtype: 'success',
      is_error: false, // #39: an absent is_error is a healthy run
      num_turns: 7,
      model: 'claude-opus-4-8',
      total_cost_usd: 0.1234,
      duration_ms: 4200,
      context_end_tokens: 350, // 100 + 200 + 50 from message_start
    })
  })

  it('claude model stays a string from the stream (never overridden to null)', () => {
    const raw = streamLines([claudeMessageStart(), claudeResult()])
    expect(parseAgentStream(raw, 'claude').model).toBe('claude-opus-4-8')
  })
})

describe('parseAgentStream — dispatcher guards', () => {
  it('throws on an unknown agent', () => {
    expect(() => parseAgentStream('', 'gpt')).toThrow()
  })

  it('QA: throws with a message that names the bad agent', () => {
    expect(() => parseAgentStream('', 'gpt')).toThrow(/gpt/)
  })

  it('QA: throws even when the stream is null/undefined for an unknown agent', () => {
    expect(() => parseAgentStream(null, 'bogus')).toThrow()
    expect(() => parseAgentStream(undefined, undefined)).toThrow()
  })
})

describe('exported claude helpers still available', () => {
  it('lastMessageStart returns the last message_start', () => {
    const raw = streamLines([claudeMessageStart(), claudeResult()])
    expect(lastMessageStart(raw).message.model).toBe('claude-opus-4-8')
  })
  it('normalizeUsage coerces missing fields to 0', () => {
    expect(normalizeUsage({ input_tokens: 5 })).toEqual({
      input_tokens: 5,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })
})
