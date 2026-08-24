import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { agentSpec } from './agent-registry.js'

// QA augmentation for #15. The dev rewrote the Claude CLAUDE_STREAM_FILTER (a jq
// program stored as a STRING in the registry). Every existing test asserts only
// the SHAPE of that string (`.toContain(...)`); none actually EXECUTES it. But
// production runs it for real — templates/ralph.sh pipes stream-json through
// `jq -rR --unbuffered "$RALPH_AGENT_STREAM_FILTER"`. These tests close that gap
// by piping representative stream-json events through the REAL filter via jq and
// asserting the rendered output, exactly as the loop's pretty-printer does.

const FILTER = agentSpec('claude').streamFilter

// Detect a usable jq once. If jq is absent we skip the behavioral suite rather
// than fail CI on a missing external tool (the string-structure suite in
// agent-registry.test.js still guards the filter's shape).
let JQ_AVAILABLE = false
try {
  execFileSync('jq', ['--version'], { stdio: 'ignore' })
  JQ_AVAILABLE = true
} catch {
  JQ_AVAILABLE = false
}

// Run the real filter over a list of stream-json event objects, exactly as the
// loop does: one JSON object per input line, `-rR` raw in/out, unbuffered.
function render(events) {
  const input = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const out = execFileSync('jq', ['-rR', '--unbuffered', FILTER], {
    input,
    encoding: 'utf8',
  })
  return out
}

// Convenience: the rendered lines with the trailing blank removed.
function renderLines(events) {
  const out = render(events)
  const lines = out.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

const d = JQ_AVAILABLE ? describe : describe.skip

d('QA behavioral: Claude stream filter rendered through real jq (#15)', () => {
  it('compiles and runs (the filter is a valid jq program)', () => {
    // A trivial event must not raise a jq compile error. If the stored program
    // has an invalid escape or syntax error this throws before asserting.
    expect(() => render([{ type: 'result', subtype: 'success' }])).not.toThrow()
  })

  it('collapses embedded newlines/tabs in a hint to a single line', () => {
    const lines = renderLines([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'git   add\n\t-A' } },
          ],
        },
      },
    ])
    // Exactly one rendered line — no raw newline split the hint across lines.
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toMatch(/[\t]/)
    // Runs of whitespace collapse to a single space, trimmed.
    expect(lines[0]).toBe('  ⏺ Bash(git add -A)')
  })

  it('truncates a >60-char hint with a trailing … and bounds the width', () => {
    const long = 'x'.repeat(120)
    const lines = renderLines([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: long } }],
        },
      },
    ])
    expect(lines).toHaveLength(1)
    const line = lines[0]
    expect(line.startsWith('  ⏺ Bash(')).toBe(true)
    expect(line.endsWith('…)')).toBe(true)
    // The parenthetical content is bounded to ~60 visible chars (59 + ellipsis).
    const inside = line.slice('  ⏺ Bash('.length, -1)
    expect([...inside].length).toBeLessThanOrEqual(60)
    expect(inside.endsWith('…')).toBe(true)
  })

  it('a hint of exactly 60 chars is NOT truncated (no ellipsis)', () => {
    const exact = 'y'.repeat(60)
    const lines = renderLines([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: exact } }],
        },
      },
    ])
    expect(lines[0]).toBe('  ⏺ Bash(' + exact + ')')
    expect(lines[0]).not.toContain('…')
  })

  it('an empty input object renders a bare ⏺ Name with NO parentheses', () => {
    const lines = renderLines([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'TodoWrite', input: {} }],
        },
      },
    ])
    expect(lines).toEqual(['  ⏺ TodoWrite'])
    expect(lines[0]).not.toContain('(')
  })

  it('an input with only unknown fields renders a bare ⏺ Name (no parens)', () => {
    const lines = renderLines([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }],
        },
      },
    ])
    expect(lines).toEqual(['  ⏺ TodoWrite'])
  })

  it('field precedence: command wins over file_path/path/pattern/description', () => {
    const lines = renderLines([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: {
                command: 'CMD',
                file_path: 'FP',
                path: 'P',
                pattern: 'PAT',
                description: 'D',
              },
            },
          ],
        },
      },
    ])
    expect(lines).toEqual(['  ⏺ Edit(CMD)'])
  })

  it('field precedence: file_path wins over path/pattern/description', () => {
    const lines = renderLines([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: 'FP', path: 'P', pattern: 'PAT', description: 'D' },
            },
          ],
        },
      },
    ])
    expect(lines).toEqual(['  ⏺ Read(FP)'])
  })

  it('a user/tool_result event produces NO output line at all', () => {
    const out = render([
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'huge blob' }] },
      },
    ])
    expect(out.trim()).toBe('')
  })

  it('an assistant message mixing text + tool_use emits both, in order', () => {
    const lines = renderLines([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello there' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.js' } },
          ],
        },
      },
    ])
    expect(lines).toEqual(['Hello there', '  ⏺ Read(/a/b.js)'])
  })

  it('==> result: renders the subtype, falling back to "ok" when absent', () => {
    expect(render([{ type: 'result', subtype: 'success' }]).trim()).toBe(
      '==> result: success',
    )
    expect(render([{ type: 'result' }]).trim()).toBe('==> result: ok')
  })

  // #39: the result event carries BOTH subtype and is_error and they disagree on
  // a hard failure — the real auth-failure payload is
  // {"subtype":"success","is_error":true,"num_turns":1}. A human reading the log
  // must never see `==> result: success` for that run.
  it('a result flagged is_error true renders as a failure, NOT success (#39)', () => {
    const lines = renderLines([
      { type: 'result', subtype: 'success', is_error: true, num_turns: 1 },
    ])
    // Exactly one rendered line per event, as for every other result.
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toBe('==> result: success')
    expect(lines[0]).toBe('==> result: error')
  })

  it('a flagged result KEEPS its own subtype when that already names the error', () => {
    expect(
      render([{ type: 'result', subtype: 'error_max_turns', is_error: true }]).trim(),
    ).toBe('==> result: error_max_turns')
  })

  it('a flagged result with NO subtype renders the generic error (#39)', () => {
    expect(render([{ type: 'result', is_error: true }]).trim()).toBe(
      '==> result: error',
    )
  })

  it('is_error false and an ABSENT is_error both still render success (#39)', () => {
    expect(
      render([{ type: 'result', subtype: 'success', is_error: false, num_turns: 1 }]).trim(),
    ).toBe('==> result: success')
    expect(render([{ type: 'result', subtype: 'success' }]).trim()).toBe(
      '==> result: success',
    )
  })

  it('adversarial: a non-string hint value (number / object) does not crash', () => {
    // A number in command...
    const numLines = renderLines([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 42 } }],
        },
      },
    ])
    expect(numLines).toEqual(['  ⏺ Bash(42)'])

    // ...and an object in command must not raise a jq error either.
    expect(() =>
      render([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: { nested: true } } },
            ],
          },
        },
      ]),
    ).not.toThrow()
  })

  it('a non-JSON / garbage input line is swallowed (fromjson? // empty)', () => {
    const out = execFileSync('jq', ['-rR', '--unbuffered', FILTER], {
      input: 'not json at all\n',
      encoding: 'utf8',
    })
    expect(out.trim()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// #39 hardening (QA follow-up). The rendered outcome is ONE line per event, and
// it must stay one line — and stay honest — for a subtype that is not a clean
// single-line string. `jq -r` prints raw, so an embedded newline in the subtype
// would split one event across TWO log lines whose FIRST reads exactly
// `==> result: success` for a run flagged as failed, bypassing the guard.
// ---------------------------------------------------------------------------

// Like render(), but tolerant of a non-zero jq exit (a jq runtime error is
// itself an outcome to assert on; production ignores jq's status and reads the
// agent's own exit code via PIPESTATUS).
function renderResult(event) {
  const r = spawnSync('jq', ['-rR', '--unbuffered', FILTER], {
    input: JSON.stringify(event) + '\n',
    encoding: 'utf8',
  })
  const lines = r.stdout.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return { lines, status: r.status }
}

d('QA behavioral: the result outcome is always exactly one honest line (#39)', () => {
  it('an embedded newline in a flagged subtype cannot forge a success line', () => {
    const lines = renderLines([
      { type: 'result', subtype: 'success\nfoo', is_error: true, num_turns: 1 },
    ])
    expect(lines).toHaveLength(1)
    expect(lines).not.toContain('==> result: success')
    // The value is preserved, collapsed onto the single line it belongs on.
    expect(lines[0]).toBe('==> result: success foo')
  })

  it('collapses any whitespace run in a subtype (tabs, CRs, newlines)', () => {
    expect(renderLines([{ type: 'result', subtype: 'a\t\r\n  b' }])).toEqual([
      '==> result: a b',
    ])
  })

  it('an EMPTY-STRING subtype names the outcome instead of rendering blank', () => {
    // Flagged: the log must say what the telemetry subtype says ('error'), not
    // trail off after the prefix.
    expect(
      renderLines([{ type: 'result', subtype: '', is_error: true, num_turns: 1 }]),
    ).toEqual(['==> result: error'])
    // Unflagged: the same cosmetic "ok" the filter already renders for an ABSENT
    // subtype — an empty subtype names no outcome either. This is a DELIBERATE
    // change from the previous bare `==> result: `; no real or tested run emits
    // this shape (AC#3's "unchanged" guarantee covers a real successful run).
    expect(renderLines([{ type: 'result', subtype: '' }])).toEqual(['==> result: ok'])
  })

  it('a NON-STRING subtype renders one line instead of crashing jq', () => {
    for (const subtype of [42, true, { a: 1 }, ['x']]) {
      const flagged = renderResult({ type: 'result', subtype, is_error: true })
      const unflagged = renderResult({ type: 'result', subtype })
      expect(flagged.status).toBe(0)
      expect(flagged.lines).toHaveLength(1)
      // The flag must not change how a garbled subtype renders...
      expect(flagged.lines).toEqual(unflagged.lines)
      // ...and it must never read as a success.
      expect(flagged.lines).not.toContain('==> result: success')
    }
    expect(renderResult({ type: 'result', subtype: 42 }).lines).toEqual([
      '==> result: 42',
    ])
  })
})

// #39: the is_error guard is CLAUDE-only — codex is already explicit about a
// failed turn. These run codex's own filter through real jq to pin that its
// rendered outcomes did not move.
d('QA behavioral: Codex stream filter outcomes are unchanged (#39)', () => {
  const codexFilter = agentSpec('codex').streamFilter
  const renderCodex = (events) =>
    execFileSync('jq', ['-rR', '--unbuffered', codexFilter], {
      input: events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      encoding: 'utf8',
    }).trim()

  it('turn.completed renders success', () => {
    expect(renderCodex([{ type: 'turn.completed', usage: {} }])).toBe(
      '==> result: success',
    )
  })

  it('turn.failed renders error', () => {
    expect(renderCodex([{ type: 'turn.failed', error: { message: 'boom' } }])).toBe(
      '==> result: error',
    )
  })

  it('a top-level error event renders error', () => {
    expect(renderCodex([{ type: 'error', message: 'unexpected status 404' }])).toBe(
      '==> result: error',
    )
  })
})
