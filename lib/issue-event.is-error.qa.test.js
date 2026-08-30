import { describe, it, expect } from 'vitest'
import { buildIssueEvent } from './issue-event.js'

// QA augmentation for #39. Two claims in the change need adversarial proof at the
// EVENT level, not the parser level:
//
//   1. the RALPH_ISSUE_EVENT schema is deliberately UNCHANGED — parseAgentStream
//      gained an `is_error` field, and that new field must not leak into the
//      per-issue event written to .ralph/metrics/issues.jsonl (a silently widened
//      schema breaks every downstream reader of the jsonl);
//   2. the run-level `verdict` (labels + issue state, or the folder-mode override)
//      is provably unmoved. The dev pinned 6 (labels, state) pairs; this walks the
//      FULL cross product of label sets x states x stream payloads, so no stream
//      shape — flagged, garbled, empty, codex — can influence a verdict.

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
  rawStreamJson: streamLines([resultLine()]),
  stderrLog: '',
  issueNumber: 98,
  runId: 'run-1',
  claudeExitCode: 0,
  labels: [],
  state: 'OPEN',
  ts: 1730000000000,
  ...overrides,
})

// The event schema as of #39 — the field set the README documents. Frozen here on
// purpose: adding a field is a schema change and must break this test.
const EVENT_KEYS = [
  'issue_number',
  'run_id',
  'ts',
  'agent',
  'subtype',
  'total_cost_usd',
  'num_turns',
  'duration_ms',
  'usage',
  'claude_exit_code',
  'stderr_error_signals',
  'verdict',
  'files',
  'insertions',
  'deletions',
  'context_end_tokens',
  'context_end_pct',
  'model',
  'context_window',
]

// The stream payloads used to prove nothing about the stream can move the schema
// or the verdict. Covers the real auth-failure payload, the healthy payload, and
// the degradation cases.
const STREAMS = [
  {
    label: 'the real auth-failure payload (flagged success)',
    agent: 'claude',
    raw: streamLines([{ type: 'result', subtype: 'success', is_error: true, num_turns: 1 }]),
  },
  {
    label: 'a healthy claude result',
    agent: 'claude',
    raw: streamLines([resultLine()]),
  },
  {
    label: 'a flagged claude result with a named error subtype',
    agent: 'claude',
    raw: streamLines([resultLine({ subtype: 'error_max_turns', is_error: true })]),
  },
  {
    label: 'a claude result with is_error false',
    agent: 'claude',
    raw: streamLines([resultLine({ is_error: false })]),
  },
  { label: 'an empty claude stream', agent: 'claude', raw: '' },
  {
    label: 'a garbled claude stream',
    agent: 'claude',
    raw: 'not json\n{"type":"result","is_err',
  },
  {
    label: 'a failed codex stream',
    agent: 'codex',
    raw: streamLines([{ type: 'turn.failed', error: { message: 'boom' } }]),
  },
  {
    label: 'a completed codex stream',
    agent: 'codex',
    raw: streamLines([{ type: 'turn.completed', usage: { input_tokens: 10 } }]),
  },
]

// ---------------------------------------------------------------------------
// Schema integrity: the new normalized `is_error` must NOT reach the jsonl.
// ---------------------------------------------------------------------------

describe('QA: buildIssueEvent — the event schema is unchanged by #39', () => {
  it.each(STREAMS)('$label produces EXACTLY the documented key set', ({ agent, raw }) => {
    const e = buildIssueEvent(baseInput({ agent, rawStreamJson: raw }))
    expect(Object.keys(e).sort()).toEqual([...EVENT_KEYS].sort())
  })

  it.each(STREAMS)('$label does not leak an is_error field onto the event', ({ agent, raw }) => {
    const e = buildIssueEvent(baseInput({ agent, rawStreamJson: raw }))
    expect('is_error' in e).toBe(false)
    expect(e.is_error).toBeUndefined()
    // Nor anywhere nested inside the usage object.
    expect('is_error' in e.usage).toBe(false)
  })

  it('the usage sub-object keeps exactly its four keys for a flagged run', () => {
    const raw = streamLines([resultLine({ is_error: true })])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(Object.keys(e.usage).sort()).toEqual([
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
      'input_tokens',
      'output_tokens',
    ])
  })

  it('the event round-trips through JSON.stringify with no extra field (jsonl safety)', () => {
    const raw = streamLines([{ type: 'result', subtype: 'success', is_error: true, num_turns: 1 }])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    const round = JSON.parse(JSON.stringify(e))
    expect(Object.keys(round).sort()).toEqual([...EVENT_KEYS].sort())
    expect(round.subtype).toBe('error')
  })

  it('a flagged result still records every OTHER field off that same line', () => {
    // Reconciling the subtype must not disturb cost/turns/duration/usage/context.
    const raw = streamLines([
      { type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 350 } } },
      resultLine({ is_error: true }),
    ])
    const e = buildIssueEvent(baseInput({ rawStreamJson: raw }))
    expect(e.subtype).toBe('error')
    expect(e.total_cost_usd).toBe(0.1234)
    expect(e.num_turns).toBe(7)
    expect(e.duration_ms).toBe(4200)
    expect(e.usage.input_tokens).toBe(1000)
    expect(e.model).toBe('claude-opus-4-8')
    expect(e.context_end_tokens).toBe(350)
  })

  it('claude_exit_code is INDEPENDENT of the stream flag (both directions)', () => {
    // The loop derives claude_exit_code from the process, not the stream; a
    // stream-flagged failure with exit 0 and a clean stream with exit 1 are both
    // recorded verbatim. Pinned so the fix never starts inferring one from the
    // other.
    const flagged = buildIssueEvent(
      baseInput({
        claudeExitCode: 0,
        rawStreamJson: streamLines([{ type: 'result', subtype: 'success', is_error: true }]),
      }),
    )
    expect(flagged.claude_exit_code).toBe(0)
    expect(flagged.subtype).toBe('error')

    const clean = buildIssueEvent(
      baseInput({ claudeExitCode: 1, rawStreamJson: streamLines([resultLine()]) }),
    )
    expect(clean.claude_exit_code).toBe(1)
    expect(clean.subtype).toBe('success')
  })

  it('stderr_error_signals is unaffected by the flag (independent signal)', () => {
    const raw = streamLines([{ type: 'result', subtype: 'success', is_error: true }])
    const withSignals = buildIssueEvent(
      baseInput({ rawStreamJson: raw, stderrLog: 'auth failure\nrate limit hit\n' }),
    )
    expect(withSignals.stderr_error_signals).toBe(2)
    const withoutSignals = buildIssueEvent(baseInput({ rawStreamJson: raw, stderrLog: '' }))
    expect(withoutSignals.stderr_error_signals).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Verdict independence, harder than the dev's 6 cases: the FULL cross product of
// label sets x states x stream payloads must collapse to one verdict per
// (labels, state) pair.
// ---------------------------------------------------------------------------

describe('QA: buildIssueEvent — verdict is provably independent of the stream (#39)', () => {
  const LABEL_SETS = [
    [],
    ['bug'],
    ['pending-merge'],
    ['failed'],
    ['failed', 'pending-merge'],
    ['pending-merge', 'bug', 'enhancement'],
    ['FAILED'], // case-sensitive on purpose: not the failure label
  ]
  const STATES = ['OPEN', 'CLOSED', 'closed', undefined, null, '']

  // The expected verdict per (labels, state), derived from the documented
  // precedence: failed => fail; else CLOSED or pending-merge => pass;
  // else unknown. Written out independently of the implementation.
  function expected(labels, state) {
    if (labels.includes('failed')) return 'fail'
    if (state === 'CLOSED' || labels.includes('pending-merge')) return 'pass'
    return 'unknown'
  }

  for (const labels of LABEL_SETS) {
    for (const state of STATES) {
      it(`labels [${labels.join(',')}] + state ${JSON.stringify(state)} yields one verdict for EVERY stream`, () => {
        const want = expected(labels, state)
        const verdicts = new Set()
        for (const { agent, raw } of STREAMS) {
          const e = buildIssueEvent(baseInput({ labels, state, agent, rawStreamJson: raw }))
          verdicts.add(e.verdict)
        }
        expect([...verdicts]).toEqual([want])
      })
    }
  }

  it('a flagged stream never turns a passing verdict into a failure', () => {
    const flagged = streamLines([{ type: 'result', subtype: 'success', is_error: true }])
    const closed = buildIssueEvent(
      baseInput({ labels: [], state: 'CLOSED', rawStreamJson: flagged }),
    )
    expect(closed.verdict).toBe('pass')
    // ...while the STREAM's own outcome is reported as the failure it is.
    expect(closed.subtype).toBe('error')
  })

  it('a healthy stream never turns a failing verdict into a pass', () => {
    const healthy = streamLines([resultLine({ is_error: false })])
    const e = buildIssueEvent(
      baseInput({ labels: ['failed'], state: 'CLOSED', rawStreamJson: healthy }),
    )
    expect(e.verdict).toBe('fail')
    expect(e.subtype).toBe('success')
  })

  it('verdictOverride still wins for every stream shape (folder mode, #565)', () => {
    for (const { agent, raw } of STREAMS) {
      for (const override of ['done', 'failed', '  failed  ']) {
        const e = buildIssueEvent(
          baseInput({
            agent,
            rawStreamJson: raw,
            labels: ['failed'],
            state: 'CLOSED',
            verdictOverride: override,
          }),
        )
        expect(e.verdict).toBe(override.trim())
      }
    }
  })

  it('an EMPTY/blank verdictOverride falls back to labels+state, flagged or not', () => {
    for (const override of ['', '   ', null, undefined]) {
      const flagged = buildIssueEvent(
        baseInput({
          rawStreamJson: streamLines([{ type: 'result', subtype: 'success', is_error: true }]),
          labels: ['pending-merge'],
          state: 'OPEN',
          verdictOverride: override,
        }),
      )
      expect(flagged.verdict).toBe('pass')
    }
  })
})
