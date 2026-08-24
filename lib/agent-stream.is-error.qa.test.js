import { describe, it, expect } from 'vitest'
import { parseAgentStream } from './agent-stream.js'

// QA augmentation for #39. The dev's suite pins the HAPPY path of the new
// is_error reconciliation: the real auth-failure payload, an already-named error
// subtype, is_error false, an absent is_error, last-line-wins, and a flagged
// result with no subtype. What it does NOT cover is what a garbled / hostile
// `result` line does to the two fields the fix now reconciles.
//
// These tests attack `isErrorResult` (strict `=== true`) and `reportedSubtype`
// (truthiness + `!== 'success'`) from the type-abuse angle, plus multi-result /
// truncation ordering and the module's stated "NEVER throws" contract. The
// matching jq-side behavior — and whether the two layers AGREE — lives in
// agent-outcome-parity.qa.test.js.

// One newline-delimited stream from JSON-able objects (never read from logs/).
function streamLines(objs) {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

// One raw claude `result` line, ready to hand to parseAgentStream.
function resultStream(result) {
  return streamLines([result])
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

// ---------------------------------------------------------------------------
// is_error TYPE abuse. `isErrorResult` is deliberately strict (`=== true`), so
// every truthy-but-not-boolean shape must be treated as a HEALTHY run — i.e.
// today's behavior is preserved exactly, and `is_error` is always a boolean on
// the normalized result no matter what the stream put in that field.
// ---------------------------------------------------------------------------

describe('QA: parseAgentStream — claude is_error type abuse (#39)', () => {
  const NON_TRUE = [
    { label: 'string "true"', value: 'true' },
    { label: 'string "TRUE"', value: 'TRUE' },
    { label: 'string "false"', value: 'false' },
    { label: 'number 1', value: 1 },
    { label: 'number 0', value: 0 },
    { label: 'null', value: null },
    { label: 'empty array', value: [] },
    { label: 'empty object', value: {} },
    { label: 'non-empty object', value: { flagged: true } },
    { label: 'boolean false', value: false },
  ]

  it.each(NON_TRUE)(
    'is_error as $label is NOT a failure — subtype stays "success" (strict === true)',
    ({ value }) => {
      const p = parseAgentStream(
        resultStream({ type: 'result', subtype: 'success', is_error: value }),
        'claude',
      )
      expect(p.subtype).toBe('success')
      expect(p.is_error).toBe(false)
    },
  )

  it.each(NON_TRUE)('is_error as $label still normalizes to a BOOLEAN', ({ value }) => {
    const p = parseAgentStream(
      resultStream({ type: 'result', subtype: 'success', is_error: value }),
      'claude',
    )
    expect(typeof p.is_error).toBe('boolean')
  })

  it('only the JSON boolean true flags a failure', () => {
    const p = parseAgentStream(
      resultStream({ type: 'result', subtype: 'success', is_error: true }),
      'claude',
    )
    expect(p.is_error).toBe(true)
    expect(p.subtype).toBe('error')
  })

  it('a DUPLICATED is_error key resolves last-wins, both directions', () => {
    // A garbled / concatenated line can carry the key twice; JSON.parse keeps the
    // last occurrence. Pinned because jq resolves duplicates the same way, so the
    // log and the telemetry cannot disagree here.
    const falseThenTrue = '{"type":"result","subtype":"success","is_error":false,"is_error":true}\n'
    const trueThenFalse = '{"type":"result","subtype":"success","is_error":true,"is_error":false}\n'
    expect(parseAgentStream(falseThenTrue, 'claude').is_error).toBe(true)
    expect(parseAgentStream(falseThenTrue, 'claude').subtype).toBe('error')
    expect(parseAgentStream(trueThenFalse, 'claude').is_error).toBe(false)
    expect(parseAgentStream(trueThenFalse, 'claude').subtype).toBe('success')
  })

  it('is_error nested somewhere else on the line does NOT flag the run', () => {
    // The flag is read off the result line itself, never from a nested object.
    const p = parseAgentStream(
      resultStream({
        type: 'result',
        subtype: 'success',
        usage: { is_error: true },
        error: { is_error: true },
      }),
      'claude',
    )
    expect(p.is_error).toBe(false)
    expect(p.subtype).toBe('success')
  })

  it('is_error true on a NON-result line is ignored (no result line => not an error)', () => {
    const p = parseAgentStream(
      streamLines([
        { type: 'assistant', is_error: true, message: { content: [] } },
        { type: 'system', is_error: true },
      ]),
      'claude',
    )
    expect(p.is_error).toBe(false)
    expect(p.subtype).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// subtype TYPE abuse alongside the flag. `reportedSubtype` keeps the stream's
// own subtype when it is truthy and not exactly 'success'. These pin what that
// means for values Claude would never emit, so a future rewrite of the helper
// cannot silently change the recorded telemetry value.
// ---------------------------------------------------------------------------

describe('QA: parseAgentStream — claude subtype abuse alongside is_error (#39)', () => {
  const FLAGGED_CASES = [
    { label: 'exact "success"', subtype: 'success', reported: 'error' },
    { label: 'null', subtype: null, reported: 'error' },
    { label: 'empty string', subtype: '', reported: 'error' },
    { label: 'boolean false', subtype: false, reported: 'error' },
    { label: 'number 0', subtype: 0, reported: 'error' },
    { label: 'named error subtype', subtype: 'error_max_turns', reported: 'error_max_turns' },
    // Truthy non-'success' values are passed through verbatim — including shapes
    // that are not strings at all. Recorded as-is; see the report for the
    // log/telemetry divergence this creates on the jq side.
    { label: 'boolean true', subtype: true, reported: true },
    { label: 'number 42', subtype: 42, reported: 42 },
    { label: 'capitalized "Success"', subtype: 'Success', reported: 'Success' },
    { label: 'leading-space " success"', subtype: ' success', reported: ' success' },
    { label: 'trailing-space "success "', subtype: 'success ', reported: 'success ' },
  ]

  it.each(FLAGGED_CASES)(
    'flagged result with subtype $label reports $reported — never plain "success"',
    ({ subtype, reported }) => {
      const p = parseAgentStream(
        resultStream({ type: 'result', subtype, is_error: true }),
        'claude',
      )
      expect(p.subtype).toEqual(reported)
      // The acceptance criterion, restated per case: a flagged run is never
      // reported as a plain success.
      expect(p.subtype).not.toBe('success')
      expect(p.is_error).toBe(true)
    },
  )

  const UNFLAGGED_CASES = [
    { label: 'exact "success"', subtype: 'success', reported: 'success' },
    { label: 'null', subtype: null, reported: null },
    { label: 'empty string', subtype: '', reported: '' },
    { label: 'boolean false', subtype: false, reported: false },
    { label: 'number 0', subtype: 0, reported: 0 },
    { label: 'number 42', subtype: 42, reported: 42 },
    { label: 'named error subtype', subtype: 'error_during_execution', reported: 'error_during_execution' },
  ]

  it.each(UNFLAGGED_CASES)(
    'is_error false leaves subtype $label EXACTLY as the stream sent it',
    ({ subtype, reported }) => {
      const flagged = parseAgentStream(
        resultStream({ type: 'result', subtype, is_error: false }),
        'claude',
      )
      const absent = parseAgentStream(resultStream({ type: 'result', subtype }), 'claude')
      expect(flagged.subtype).toEqual(reported)
      expect(absent.subtype).toEqual(reported)
      expect(flagged.is_error).toBe(false)
      expect(absent.is_error).toBe(false)
    },
  )

  it('a MISSING subtype key behaves like an explicit null (both flag states)', () => {
    expect(parseAgentStream(resultStream({ type: 'result' }), 'claude').subtype).toBeNull()
    expect(
      parseAgentStream(resultStream({ type: 'result', is_error: false }), 'claude').subtype,
    ).toBeNull()
    expect(
      parseAgentStream(resultStream({ type: 'result', is_error: true }), 'claude').subtype,
    ).toBe('error')
  })

  it('a subtype of "error" with is_error true stays "error" (no double-mapping)', () => {
    const p = parseAgentStream(
      resultStream({ type: 'result', subtype: 'error', is_error: true }),
      'claude',
    )
    expect(p.subtype).toBe('error')
  })

  it('a subtype containing a NEWLINE is recorded verbatim, and is not "success"', () => {
    // The jq pretty-printer renders this value into the log; see
    // agent-outcome-parity.qa.test.js for the divergence that creates.
    const p = parseAgentStream(
      resultStream({ type: 'result', subtype: 'success\nfoo', is_error: true }),
      'claude',
    )
    expect(p.subtype).toBe('success\nfoo')
    expect(p.subtype).not.toBe('success')
    expect(p.is_error).toBe(true)
  })

  it('the flag does not disturb the OTHER fields read off the same line', () => {
    const p = parseAgentStream(
      streamLines([claudeResult({ subtype: 'success', is_error: true })]),
      'claude',
    )
    expect(p.num_turns).toBe(7)
    expect(p.total_cost_usd).toBe(0.1234)
    expect(p.duration_ms).toBe(4200)
    expect(p.usage).toEqual({
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    })
  })
})

// ---------------------------------------------------------------------------
// Multiple result lines, truncation, and lines that are valid JSON but not
// objects. The flag must follow the SAME last-parseable-result-line rule as
// every other field, so a truncated tail can never silently clear a failure.
// ---------------------------------------------------------------------------

describe('QA: parseAgentStream — claude result-line ordering + truncation (#39)', () => {
  it('a CLEAN early result followed by a FLAGGED one reports the failure', () => {
    const p = parseAgentStream(
      streamLines([
        claudeResult({ subtype: 'success', is_error: false }),
        claudeResult({ subtype: 'success', is_error: true }),
      ]),
      'claude',
    )
    expect(p.is_error).toBe(true)
    expect(p.subtype).toBe('error')
  })

  it('three result lines: the LAST one decides, whatever the middle said', () => {
    const p = parseAgentStream(
      streamLines([
        claudeResult({ subtype: 'success', is_error: true }),
        claudeResult({ subtype: 'error_max_turns', is_error: true }),
        claudeResult({ subtype: 'success' }),
      ]),
      'claude',
    )
    expect(p.subtype).toBe('success')
    expect(p.is_error).toBe(false)
  })

  it('a TRUNCATED final result line cannot clear an earlier flagged failure', () => {
    const raw =
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 1 }) +
      '\n' +
      '{"type":"result","subtype":"success","is_err' // cut mid-key
    const p = parseAgentStream(raw, 'claude')
    expect(p.is_error).toBe(true)
    expect(p.subtype).toBe('error')
    expect(p.num_turns).toBe(1)
  })

  it('a truncated final line cannot invent a failure either (clean run stays clean)', () => {
    const raw =
      JSON.stringify(claudeResult({ subtype: 'success' })) +
      '\n' +
      '{"type":"result","is_error":tru' // cut mid-literal
    const p = parseAgentStream(raw, 'claude')
    expect(p.is_error).toBe(false)
    expect(p.subtype).toBe('success')
  })

  it('a result line that is valid JSON but an ARRAY is skipped, not read as a result', () => {
    const raw =
      '[{"type":"result","subtype":"success","is_error":true}]\n' +
      JSON.stringify(claudeResult({ subtype: 'success' }))
    const p = parseAgentStream(raw, 'claude')
    expect(p.is_error).toBe(false)
    expect(p.subtype).toBe('success')
  })

  it('valid-JSON scalar lines (string / number / true / null) are skipped, never throw', () => {
    const raw = [
      '"result"',
      '42',
      'true',
      'null',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true }),
    ].join('\n')
    let p
    expect(() => {
      p = parseAgentStream(raw, 'claude')
    }).not.toThrow()
    expect(p.is_error).toBe(true)
    expect(p.subtype).toBe('error')
  })

  it('garbage + blank lines around a flagged result do not lose the flag', () => {
    const raw = [
      '',
      'not json at all',
      '{broken',
      '   ',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 1 }),
      'trailing noise',
      '',
    ].join('\n')
    const p = parseAgentStream(raw, 'claude')
    expect(p.is_error).toBe(true)
    expect(p.subtype).toBe('error')
    expect(p.num_turns).toBe(1)
  })

  it('a flagged result followed by non-result events keeps the flag', () => {
    const p = parseAgentStream(
      streamLines([
        { type: 'result', subtype: 'success', is_error: true },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'bye' }] } },
        {
          type: 'message_start',
          message: { model: 'claude-opus-4-8', usage: { input_tokens: 5 } },
        },
      ]),
      'claude',
    )
    expect(p.is_error).toBe(true)
    expect(p.subtype).toBe('error')
    // ...and the unrelated model/context derivation still works.
    expect(p.model).toBe('claude-opus-4-8')
    expect(p.context_end_tokens).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// The module's contract: "Both degrade gracefully on blank / truncated /
// non-JSON input and NEVER throw." Re-verified with the new flag in play.
// ---------------------------------------------------------------------------

describe('QA: parseAgentStream — never throws on hostile result shapes (#39)', () => {
  const HOSTILE = [
    { label: 'is_error as a deep object', line: { type: 'result', is_error: { a: { b: {} } } } },
    { label: 'is_error as an array of true', line: { type: 'result', is_error: [true] } },
    { label: 'subtype as an object', line: { type: 'result', subtype: { name: 'x' }, is_error: true } },
    { label: 'subtype as an array', line: { type: 'result', subtype: ['error'], is_error: true } },
    { label: 'usage as null', line: { type: 'result', subtype: 'success', is_error: true, usage: null } },
    { label: 'usage as a string', line: { type: 'result', is_error: true, usage: 'nope' } },
    { label: 'num_turns as a string', line: { type: 'result', is_error: true, num_turns: 'many' } },
    { label: 'a huge numeric subtype', line: { type: 'result', subtype: 1e308, is_error: true } },
    { label: 'a __proto__ key', line: { type: 'result', subtype: 'success', ['__proto__']: { is_error: true } } },
    { label: 'every field null', line: { type: 'result', subtype: null, is_error: null, usage: null, num_turns: null } },
  ]

  it.each(HOSTILE)('$label does not throw and still returns the shape', ({ line }) => {
    let p
    expect(() => {
      p = parseAgentStream(resultStream(line), 'claude')
    }).not.toThrow()
    expect(typeof p.is_error).toBe('boolean')
    expect(p).toHaveProperty('subtype')
    expect(p).toHaveProperty('usage')
    expect(Number.isNaN(p.context_end_tokens)).toBe(false)
  })

  it('a __proto__-carrying result line cannot smuggle in a failure flag', () => {
    const raw = '{"type":"result","subtype":"success","__proto__":{"is_error":true}}\n'
    const p = parseAgentStream(raw, 'claude')
    expect(p.is_error).toBe(false)
    expect(p.subtype).toBe('success')
  })

  it('a pathologically nested line is swallowed; a later flagged result still wins', () => {
    // JSON.parse may blow its stack on this — jsonLines must absorb that too.
    const deep = '['.repeat(100000) + ']'.repeat(100000)
    const raw = deep + '\n' + JSON.stringify({ type: 'result', subtype: 'success', is_error: true })
    let p
    expect(() => {
      p = parseAgentStream(raw, 'claude')
    }).not.toThrow()
    expect(p.is_error).toBe(true)
    expect(p.subtype).toBe('error')
  })

  it('null / undefined / whitespace-only streams report a clean, unflagged run', () => {
    for (const raw of [null, undefined, '', '   \n\t\n']) {
      const p = parseAgentStream(raw, 'claude')
      expect(p.is_error).toBe(false)
      expect(p.subtype).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// Codex: the flag is derived from the failure EVENTS, so it must track the
// subtype exactly. `is_error` on a codex event must be inert — the claude guard
// must not leak across agents.
// ---------------------------------------------------------------------------

describe('QA: parseAgentStream — codex is_error is event-derived, not field-derived (#39)', () => {
  it('an is_error:true field on turn.completed does NOT make a codex run fail', () => {
    const p = parseAgentStream(
      streamLines([{ type: 'turn.completed', is_error: true, usage: { input_tokens: 1 } }]),
      'codex',
    )
    expect(p.subtype).toBe('success')
    expect(p.is_error).toBe(false)
  })

  it('an is_error:false field on turn.failed does NOT rescue a codex failure', () => {
    const p = parseAgentStream(
      streamLines([{ type: 'turn.failed', is_error: false, error: { message: 'boom' } }]),
      'codex',
    )
    expect(p.subtype).toBe('error')
    expect(p.is_error).toBe(true)
  })

  it('a CLAUDE result line in a codex stream is inert (no turns, no failure)', () => {
    const p = parseAgentStream(
      streamLines([{ type: 'result', subtype: 'success', is_error: true, num_turns: 1 }]),
      'codex',
    )
    expect(p.subtype).toBeNull()
    expect(p.is_error).toBe(false)
    expect(p.num_turns).toBe(0)
  })

  it('subtype and is_error can never disagree for codex (matrix)', () => {
    const streams = [
      [{ type: 'turn.completed', usage: {} }],
      [{ type: 'turn.failed', error: {} }],
      [{ type: 'error', message: 'x' }],
      [{ type: 'item.completed', item: { type: 'error', message: 'x' } }],
      [{ type: 'turn.completed', usage: {} }, { type: 'turn.failed', error: {} }],
      [{ type: 'turn.started' }],
      [],
    ]
    for (const events of streams) {
      const p = parseAgentStream(events.length ? streamLines(events) : '', 'codex')
      // The flag is exactly "subtype === 'error'" for codex.
      expect(p.is_error).toBe(p.subtype === 'error')
    }
  })
})
