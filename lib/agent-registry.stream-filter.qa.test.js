import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
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
