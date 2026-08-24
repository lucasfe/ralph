import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { agentSpec } from './agent-registry.js'
import { parseAgentStream } from './agent-stream.js'

// QA augmentation for #39. Ralph reports a run's outcome through TWO independent
// layers reading the SAME `result` event:
//
//   1. the cosmetic jq filter in agent-registry.js → the `==> result: …` line a
//      human reads in logs/ralph-issue-N.log;
//   2. parseAgentStream in agent-stream.js → the `subtype` recorded in
//      .ralph/metrics/issues.jsonl.
//
// Issue #39 IS a divergence bug: the log said `success` for a run telemetry
// should have called a failure. The dev fixed both layers separately, and both
// suites test them separately. This suite tests them TOGETHER: for the same
// payload, the rendered line and the recorded subtype must tell the same story.
//
// The jq side runs the REAL filter through the REAL jq exactly as
// templates/ralph.sh does (`jq -rR --unbuffered "$RALPH_AGENT_STREAM_FILTER"`),
// reusing the JQ_AVAILABLE gating from agent-registry.stream-filter.qa.test.js so
// a machine without jq skips instead of failing.

const CLAUDE_FILTER = agentSpec('claude').streamFilter
const CODEX_FILTER = agentSpec('codex').streamFilter

let JQ_AVAILABLE = false
try {
  execFileSync('jq', ['--version'], { stdio: 'ignore' })
  JQ_AVAILABLE = true
} catch {
  JQ_AVAILABLE = false
}

const PREFIX = '==> result: '

// Run a filter over stream-json events WITHOUT throwing on a non-zero jq exit —
// a jq runtime error (exit 5) is itself an outcome worth asserting on, and
// production never checks jq's status (templates/ralph.sh reads PIPESTATUS[1],
// the agent's own exit code).
function run(filter, events) {
  const input = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const r = spawnSync('jq', ['-rR', '--unbuffered', filter], { input, encoding: 'utf8' })
  const lines = r.stdout.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return { lines, status: r.status, stderr: r.stderr }
}

const renderClaude = (events) => run(CLAUDE_FILTER, events)
const renderCodex = (events) => run(CODEX_FILTER, events)

// The rendered outcome of a single claude result event (the text after the
// `==> result: ` prefix), or null when nothing was rendered.
function renderedOutcome(result) {
  const { lines } = renderClaude([result])
  if (lines.length !== 1) return null
  return lines[0].startsWith(PREFIX) ? lines[0].slice(PREFIX.length) : null
}

// What the authoritative parse records for the same single result event.
function recordedSubtype(result) {
  return parseAgentStream(JSON.stringify(result) + '\n', 'claude').subtype
}

const d = JQ_AVAILABLE ? describe : describe.skip

// ---------------------------------------------------------------------------
// is_error type abuse, BOTH layers, same payload. The JS uses `=== true` and the
// jq uses `== true`; both must therefore treat every non-boolean shape as a
// healthy run, and must keep saying the same thing.
// ---------------------------------------------------------------------------

d('QA parity: is_error type abuse renders and records identically (#39)', () => {
  const IS_ERROR_VALUES = [
    { label: 'boolean true', value: true, outcome: 'error' },
    { label: 'boolean false', value: false, outcome: 'success' },
    { label: 'string "true"', value: 'true', outcome: 'success' },
    { label: 'string "TRUE"', value: 'TRUE', outcome: 'success' },
    { label: 'string "false"', value: 'false', outcome: 'success' },
    { label: 'number 1', value: 1, outcome: 'success' },
    { label: 'number 0', value: 0, outcome: 'success' },
    { label: 'null', value: null, outcome: 'success' },
    { label: 'empty array', value: [], outcome: 'success' },
    { label: 'empty object', value: {}, outcome: 'success' },
  ]

  it.each(IS_ERROR_VALUES)(
    'is_error as $label → log and telemetry both say $outcome',
    ({ value, outcome }) => {
      const result = { type: 'result', subtype: 'success', is_error: value, num_turns: 1 }
      expect(renderedOutcome(result)).toBe(outcome)
      expect(recordedSubtype(result)).toBe(outcome)
    },
  )

  it('a duplicated is_error key resolves last-wins in BOTH layers', () => {
    const falseThenTrue =
      '{"type":"result","subtype":"success","is_error":false,"is_error":true}\n'
    const r = spawnSync('jq', ['-rR', '--unbuffered', CLAUDE_FILTER], {
      input: falseThenTrue,
      encoding: 'utf8',
    })
    expect(r.stdout.trim()).toBe('==> result: error')
    expect(parseAgentStream(falseThenTrue, 'claude').subtype).toBe('error')
  })

  it('is_error true nested inside usage/error does not flag EITHER layer', () => {
    const result = {
      type: 'result',
      subtype: 'success',
      usage: { is_error: true },
      error: { is_error: true },
    }
    expect(renderedOutcome(result)).toBe('success')
    expect(recordedSubtype(result)).toBe('success')
  })
})

// ---------------------------------------------------------------------------
// subtype abuse, BOTH layers. jq's `//` treats false/null as absent while JS's
// `??` only treats null/undefined as absent, and jq's truthiness differs from
// JS's — so this is where the two layers can drift apart.
// ---------------------------------------------------------------------------

d('QA parity: subtype abuse alongside the flag (#39)', () => {
  // Values where the layers agree. `logged` is what jq renders; `recorded` is
  // what telemetry stores. The two KNOWN asymmetries are pinned separately right
  // below this table, so its parity claim stays meaningful: jq's cosmetic "ok"
  // for an absent subtype (no telemetry equivalent — it records null), and a
  // numeric-zero subtype, where jq's truthiness genuinely differs from JS's.
  const AGREEING = [
    { label: '"success" + flag', subtype: 'success', flag: true, logged: 'error', recorded: 'error' },
    { label: '"success" no flag', subtype: 'success', flag: false, logged: 'success', recorded: 'success' },
    { label: 'null + flag', subtype: null, flag: true, logged: 'error', recorded: 'error' },
    { label: 'false + flag', subtype: false, flag: true, logged: 'error', recorded: 'error' },
    { label: '"error_max_turns" + flag', subtype: 'error_max_turns', flag: true, logged: 'error_max_turns', recorded: 'error_max_turns' },
    { label: '"error" + flag', subtype: 'error', flag: true, logged: 'error', recorded: 'error' },
    // Case / whitespace variants of "success" are NOT recognized as success by
    // either layer, so both pass them through verbatim. Consistent — but note a
    // human still reads "==> result: Success" as a pass; see the report.
    { label: '"Success" + flag', subtype: 'Success', flag: true, logged: 'Success', recorded: 'Success' },
    { label: '" success" + flag', subtype: ' success', flag: true, logged: ' success', recorded: ' success' },
    { label: '"success " + flag', subtype: 'success ', flag: true, logged: 'success ', recorded: 'success ' },
  ]

  it.each(AGREEING)('subtype $label → log "$logged", telemetry "$recorded"', ({ subtype, flag, logged, recorded }) => {
    const result = { type: 'result', subtype, is_error: flag }
    expect(renderedOutcome(result)).toBe(logged)
    expect(recordedSubtype(result)).toBe(recorded)
  })

  it('an ABSENT subtype: jq renders its cosmetic "ok", telemetry records null (unflagged)', () => {
    // Pinned as a KNOWN, pre-#39 asymmetry, so the parity assertions above stay
    // meaningful.
    expect(renderedOutcome({ type: 'result' })).toBe('ok')
    expect(recordedSubtype({ type: 'result' })).toBeNull()
  })

  it('DOCUMENTED asymmetry: a NUMERIC-ZERO subtype logs "0" while telemetry says "error"', () => {
    // The one place the two layers genuinely disagree under the flag, and the
    // limit of this suite's parity claim. `0` is TRUTHY in jq (only false/null
    // are falsy) so $named becomes "0" and renders as the outcome; `0` is FALSY
    // in JS, so reportedSubtype falls through to the generic "error". Accepted,
    // not fixed: no Claude build emits a numeric subtype, closing it would mean
    // teaching one layer the other's truthiness rules, and both answers already
    // deny success — which is all #39 requires.
    const flagged = { type: 'result', subtype: 0, is_error: true }
    expect(renderedOutcome(flagged)).toBe('0')
    expect(recordedSubtype(flagged)).toBe('error')
    // Neither layer claims success, and the log still gets exactly one line.
    expect(renderClaude([flagged]).lines).toEqual(['==> result: 0'])
    // Unflagged, both pass the garbage through untouched (jq stringifies it).
    const unflagged = { type: 'result', subtype: 0 }
    expect(renderedOutcome(unflagged)).toBe('0')
    expect(recordedSubtype(unflagged)).toBe(0)
  })

  // Found by QA, fixed in this change. An EMPTY-STRING subtype on a flagged
  // result used to degrade the log line to a bare `==> result: ` with no outcome
  // at all while telemetry recorded "error" — the exact class of divergence #39
  // exists to eliminate. The shipped filter treats an empty $named the same way
  // it treats an absent one and renders the flag's $fallback, so both layers now
  // say "error".
  it('an EMPTY-STRING subtype on a flagged result renders "error" in BOTH layers', () => {
    const result = { type: 'result', subtype: '', is_error: true, num_turns: 1 }
    expect(recordedSubtype(result)).toBe('error')
    expect(renderedOutcome(result)).toBe('error')
  })

  // Found by QA, fixed in this change. jq renders values raw (`-r`), so a subtype
  // containing a NEWLINE used to emit TWO lines for one event — and the first of
  // them was EXACTLY `==> result: success` for a run flagged is_error:true,
  // bypassing acceptance criterion #1. The shipped filter collapses whitespace
  // runs while building $named, so the event renders on the single line it
  // belongs on (`==> result: success foo`) and never reads as a bare success.
  it('a NEWLINE in a flagged subtype renders exactly one line, never a bare success', () => {
    const result = { type: 'result', subtype: 'success\nfoo', is_error: true, num_turns: 1 }
    const { lines } = renderClaude([result])
    expect(lines).not.toContain('==> result: success')
    expect(lines).toHaveLength(1)
  })

  it('a non-string TRUTHY subtype renders the SAME with and without the flag', () => {
    // The filter forces the subtype through `tostring` while building $named, so
    // a non-string subtype renders one line at exit 0 (`==> result: 42`). That
    // incidentally closed a pre-existing hole: `"==> result: " + 42` was a jq
    // runtime error, so such an event used to render ZERO lines and exit
    // non-zero (the unflagged branch had always concatenated `.subtype` raw).
    // See the matching pin in agent-registry.stream-filter.qa.test.js. Asserted
    // here as the fix-agnostic invariant: whatever the filter does with a
    // non-string subtype, the flag must not change it, at most one line is
    // emitted, and that line never claims success.
    for (const subtype of [42, true, {}, ['x']]) {
      const flagged = renderClaude([{ type: 'result', subtype, is_error: true }])
      const unflagged = renderClaude([{ type: 'result', subtype }])
      expect(flagged.lines).toEqual(unflagged.lines)
      expect(flagged.status).toBe(unflagged.status)
      expect(flagged.lines.length).toBeLessThanOrEqual(1)
      expect(flagged.lines).not.toContain('==> result: success')
      // The parser, by contrast, never loses the event.
      expect(recordedSubtype({ type: 'result', subtype, is_error: true })).not.toBe('success')
    }
  })

  it('a garbled result event does NOT swallow the rest of the stream', () => {
    // Resilience guarantee for the case above: whether jq errors on the bad input
    // or renders it, the events AFTER it must still reach the log.
    const { lines } = renderClaude([
      { type: 'result', subtype: 42, is_error: true },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'after' }] } },
      { type: 'result', subtype: 'success' },
    ])
    expect(lines.slice(-2)).toEqual(['after', '==> result: success'])
  })
})

// ---------------------------------------------------------------------------
// One line per event — the pretty-printer's contract. The result branch resolves
// $named (the subtype forced to a single-line string), $failed, $fallback and
// $outcome to exactly one string for EVERY payload, so the $fallback must always
// fire when the subtype names nothing usable: never zero lines, never two.
// ---------------------------------------------------------------------------

d('QA parity: exactly one rendered line per result event (#39)', () => {
  const ONE_LINE_PAYLOADS = [
    { label: 'flagged success (the auth failure)', result: { type: 'result', subtype: 'success', is_error: true, num_turns: 1 } },
    { label: 'flagged, no subtype', result: { type: 'result', is_error: true } },
    { label: 'flagged, null subtype', result: { type: 'result', subtype: null, is_error: true } },
    { label: 'flagged, false subtype', result: { type: 'result', subtype: false, is_error: true } },
    { label: 'flagged, named error subtype', result: { type: 'result', subtype: 'error_max_turns', is_error: true } },
    { label: 'unflagged success', result: { type: 'result', subtype: 'success', is_error: false } },
    { label: 'absent flag', result: { type: 'result', subtype: 'success' } },
    { label: 'absent flag and absent subtype', result: { type: 'result' } },
    { label: 'flag as a string', result: { type: 'result', subtype: 'success', is_error: 'true' } },
    { label: 'result line with nothing else on it', result: { type: 'result', is_error: false } },
  ]

  it.each(ONE_LINE_PAYLOADS)('$label renders exactly one line, prefixed', ({ result }) => {
    const { lines, status } = renderClaude([result])
    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith(PREFIX)).toBe(true)
    expect(status).toBe(0)
  })

  it('the $fallback always fires — no flagged payload renders zero lines', () => {
    for (const subtype of ['success', null, false, '']) {
      const { lines } = renderClaude([{ type: 'result', subtype, is_error: true }])
      expect(lines).toHaveLength(1)
    }
  })

  it('N result events render N lines, and the LAST agrees with the parser', () => {
    const events = [
      { type: 'result', subtype: 'success', is_error: true },
      { type: 'result', subtype: 'error_max_turns', is_error: true },
      { type: 'result', subtype: 'success', is_error: false },
    ]
    const { lines } = renderClaude(events)
    expect(lines).toEqual([
      '==> result: error',
      '==> result: error_max_turns',
      '==> result: success',
    ])
    // jq is stateless per event; the parser takes the LAST result line. The two
    // agree on the run's final outcome.
    const parsed = parseAgentStream(events.map((e) => JSON.stringify(e)).join('\n'), 'claude')
    expect(lines[lines.length - 1]).toBe(PREFIX + parsed.subtype)
  })

  it('an early clean result followed by a flagged one: the last log line is the failure', () => {
    const events = [
      { type: 'result', subtype: 'success', is_error: false },
      { type: 'result', subtype: 'success', is_error: true },
    ]
    const { lines } = renderClaude(events)
    expect(lines[lines.length - 1]).toBe('==> result: error')
    const parsed = parseAgentStream(events.map((e) => JSON.stringify(e)).join('\n'), 'claude')
    expect(parsed.subtype).toBe('error')
  })

  it('a TRUNCATED final result line renders nothing extra (fromjson? // empty)', () => {
    const input =
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true }) +
      '\n{"type":"result","subtype":"success","is_err\n'
    const r = spawnSync('jq', ['-rR', '--unbuffered', CLAUDE_FILTER], {
      input,
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('==> result: error')
  })

  it('a result line that is valid JSON but NOT an object is a pre-existing jq error', () => {
    // `null` is safely indexable in jq; every other scalar/array raises when the
    // filter indexes `.type`. The JS parser skips all of them silently. Pinned so
    // the asymmetry is visible — and so the events AFTER the garbage are proven
    // to still render (the loop's log must not go dark).
    const nullLine = spawnSync('jq', ['-rR', '--unbuffered', CLAUDE_FILTER], {
      input: 'null\n',
      encoding: 'utf8',
    })
    expect(nullLine.status).toBe(0)
    expect(nullLine.stdout.trim()).toBe('')

    for (const scalar of ['"result"', '42', 'true', '[1,2]']) {
      const alone = spawnSync('jq', ['-rR', '--unbuffered', CLAUDE_FILTER], {
        input: scalar + '\n',
        encoding: 'utf8',
      })
      expect(alone.stdout.trim()).toBe('')
      expect(alone.status).not.toBe(0)
      expect(alone.stderr).toMatch(/jq: error/)
      // The parser, by contrast, absorbs the same line without complaint.
      expect(() => parseAgentStream(scalar + '\n', 'claude')).not.toThrow()
    }

    const mixed = spawnSync('jq', ['-rR', '--unbuffered', CLAUDE_FILTER], {
      input: '"result"\n42\ntrue\n[1,2]\n' + JSON.stringify({ type: 'result', subtype: 'success' }) + '\n',
      encoding: 'utf8',
    })
    // ...yet the well-formed event after the garbage still renders, and jq's own
    // exit status reflects only the LAST input (production ignores it anyway —
    // templates/ralph.sh reads PIPESTATUS[1], the agent's exit code).
    expect(mixed.stdout.trim()).toBe('==> result: success')
    expect(mixed.status).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The production round-trip. In the loop the filter is never handed to jq
// directly: agent-invocation.js emits it as a single-quoted bash assignment,
// templates/ralph.sh `eval`s that and expands "$RALPH_AGENT_STREAM_FILTER" into
// `jq -rR --unbuffered`. The new `== true` / `as $binding` / `gsub(...)` syntax
// must survive that quoting untouched — a broken eval would silently kill the whole
// pretty-printed log, and the string-equality tests in agent-invocation.test.js
// cannot catch a filter that quotes fine but no longer COMPILES.
// ---------------------------------------------------------------------------

d('QA: the filter still compiles after the bash eval round-trip (#39)', () => {
  const invocationScript = fileURLToPath(new URL('./agent-invocation.js', import.meta.url))

  // Reproduce production: eval the emitted assignments, then pipe events through
  // jq using the exported env var, exactly as run_agent_stream() does.
  function renderThroughBash(events, agent) {
    const input = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    const script =
      'eval "$(RALPH_AGENT="$3" node "$1")" && printf \'%s\' "$2" | jq -rR --unbuffered "$RALPH_AGENT_STREAM_FILTER"'
    const r = spawnSync('bash', ['-c', script, 'qa', invocationScript, input, agent], {
      encoding: 'utf8',
    })
    return { stdout: r.stdout, status: r.status, stderr: r.stderr }
  }

  it('the flagged auth-failure payload renders as a failure through eval + jq', () => {
    const r = renderThroughBash(
      [{ type: 'result', subtype: 'success', is_error: true, num_turns: 1 }],
      'claude',
    )
    expect(r.stderr).not.toMatch(/jq: error/)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('==> result: error')
  })

  it('the unflagged payloads still render success/ok through eval + jq', () => {
    expect(renderThroughBash([{ type: 'result', subtype: 'success' }], 'claude').stdout.trim()).toBe(
      '==> result: success',
    )
    expect(
      renderThroughBash([{ type: 'result', subtype: 'success', is_error: false }], 'claude').stdout.trim(),
    ).toBe('==> result: success')
    expect(renderThroughBash([{ type: 'result' }], 'claude').stdout.trim()).toBe('==> result: ok')
  })

  it('a mixed stream renders assistant lines AND the reconciled result line', () => {
    const r = renderThroughBash(
      [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'gh pr list' } }] },
        },
        { type: 'result', subtype: 'success', is_error: true },
      ],
      'claude',
    )
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([
      'working',
      '  ⏺ Bash(gh pr list)',
      '==> result: error',
    ])
  })

  it('the codex filter still round-trips too (RALPH_AGENT=codex)', () => {
    expect(renderThroughBash([{ type: 'turn.completed', usage: {} }], 'codex').stdout.trim()).toBe(
      '==> result: success',
    )
    expect(renderThroughBash([{ type: 'turn.failed', error: {} }], 'codex').stdout.trim()).toBe(
      '==> result: error',
    )
  })
})

// ---------------------------------------------------------------------------
// Cross-agent contamination. The #39 guard is claude-only; neither filter may
// react to the other agent's events.
// ---------------------------------------------------------------------------

d('QA: the is_error guard does not leak across agents (#39)', () => {
  it('codex outcome events render NOTHING through the claude filter', () => {
    for (const event of [
      { type: 'turn.completed', usage: {} },
      { type: 'turn.failed', error: { message: 'boom' } },
      { type: 'error', message: 'unexpected status 404' },
      { type: 'item.completed', item: { type: 'error', message: 'x' } },
    ]) {
      const { lines, status } = renderClaude([event])
      expect(lines).toHaveLength(0)
      expect(status).toBe(0)
    }
  })

  it('a claude result (flagged or not) renders NOTHING through the codex filter', () => {
    for (const event of [
      { type: 'result', subtype: 'success', is_error: true, num_turns: 1 },
      { type: 'result', subtype: 'success' },
      { type: 'result', is_error: true },
    ]) {
      const { lines, status } = renderCodex([event])
      expect(lines).toHaveLength(0)
      expect(status).toBe(0)
    }
  })

  it('an is_error field on a codex event leaves codex rendering untouched', () => {
    expect(renderCodex([{ type: 'turn.completed', is_error: true, usage: {} }]).lines).toEqual([
      '==> result: success',
    ])
    expect(renderCodex([{ type: 'turn.failed', is_error: false, error: {} }]).lines).toEqual([
      '==> result: error',
    ])
    expect(renderCodex([{ type: 'error', is_error: false, message: 'x' }]).lines).toEqual([
      '==> result: error',
    ])
    // A codex event carrying BOTH claude-ish fields still renders by type alone.
    expect(
      renderCodex([{ type: 'turn.completed', subtype: 'error', is_error: true, usage: {} }]).lines,
    ).toEqual(['==> result: success'])
  })

  it('codex outcome events each render exactly one line', () => {
    for (const event of [
      { type: 'turn.completed', usage: {} },
      { type: 'turn.failed', error: { message: 'boom' } },
      { type: 'error', message: 'x' },
    ]) {
      expect(renderCodex([event]).lines).toHaveLength(1)
    }
  })

  it('DOCUMENTED codex asymmetry: an error ITEM renders ✗ but no result line', () => {
    // parseAgentStream treats an `item.completed` error item as a failed run
    // (subtype "error"), while the codex filter only prints `==> result:` for
    // turn.completed / turn.failed / error. A stream with an error item AND a
    // completed turn therefore LOGS success while telemetry records error —
    // pre-existing, codex-only, out of #39's claude scope, reported as an
    // observation so it is not mistaken for a regression here.
    const events = [
      { type: 'item.completed', item: { type: 'error', message: 'model not found' } },
      { type: 'turn.completed', usage: { input_tokens: 1 } },
    ]
    const { lines } = renderCodex(events)
    expect(lines).toEqual(['  ✗ model not found', '==> result: success'])
    const parsed = parseAgentStream(events.map((e) => JSON.stringify(e)).join('\n'), 'codex')
    expect(parsed.subtype).toBe('error')
    expect(parsed.is_error).toBe(true)
  })
})
