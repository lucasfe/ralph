import { describe, it, expect } from 'vitest'
import { parseConfigAgent } from './read-config-agent.js'

describe('parseConfigAgent — extract RALPH_AGENT from ralph.config.sh text', () => {
  it('returns empty string when the setting is absent', () => {
    expect(parseConfigAgent('INSTALL_CMD="npm ci"\n')).toBe('')
  })

  it('reads a double-quoted value', () => {
    expect(parseConfigAgent('RALPH_AGENT="codex"\n')).toBe('codex')
  })

  it('reads a single-quoted value', () => {
    expect(parseConfigAgent("RALPH_AGENT='codex'\n")).toBe('codex')
  })

  it('reads an unquoted value', () => {
    expect(parseConfigAgent('RALPH_AGENT=codex\n')).toBe('codex')
  })

  it('ignores commented-out lines', () => {
    expect(parseConfigAgent('# RALPH_AGENT="codex"\n')).toBe('')
    expect(parseConfigAgent('  #RALPH_AGENT=codex\n')).toBe('')
  })

  it('uses the LAST uncommented assignment', () => {
    expect(parseConfigAgent('RALPH_AGENT=claude\nRALPH_AGENT="codex"\n')).toBe('codex')
  })

  it('tolerates the export prefix, a space-or-tab indent, and padding after the value', () => {
    // Named as the two blanks it is rather than as "the whitespace bash ignores", which was
    // overstating it: bash's blanks are space and tab, and a JS `\s` indent class took 22
    // more that bash reads as part of a WORD (#147 — `\s` matches 24 characters other than
    // LF, all of them swept against a real bash in lib/parse-config-var.boundary.qa.test.js).
    // Padding AFTER the value is a separate rule, and it is now the same two blanks: the
    // grammar's value group is padded `[ \t]*` on both sides, because bash ASSIGNS a value
    // that starts or ends with anything wider (#147 follow-up).
    expect(parseConfigAgent('export RALPH_AGENT="codex"  \n')).toBe('codex')
    expect(parseConfigAgent('   RALPH_AGENT=  codex \n')).toBe('codex')
  })

  it('does not tolerate whitespace before the `=`, because bash does not (#147)', () => {
    // Used to read `codex` off this line. bash reads it as a command named RALPH_AGENT and
    // assigns nothing, so the loop ran whatever the environment held — while the JS readers
    // announced codex and probed codex's auth. The shared grammar refuses the line now; the
    // transcript is in lib/parse-config-var.js above `assignmentHead`.
    expect(parseConfigAgent('   RALPH_AGENT =  codex \n')).toBe('')
    expect(parseConfigAgent('RALPH_AGENT = codex\n')).toBe('')
    // ...and the earlier live line therefore keeps standing, as it does in bash.
    expect(parseConfigAgent('RALPH_AGENT=claude\nRALPH_AGENT = codex\n')).toBe('claude')
  })

  it('returns empty string on empty/nullish input', () => {
    expect(parseConfigAgent('')).toBe('')
    expect(parseConfigAgent(null)).toBe('')
    expect(parseConfigAgent(undefined)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#554): adversarial config-text parsing. The value is passed
// on to resolveAgent, so parseConfigAgent's only job is to faithfully extract
// the RAW string bash would assign. These pin the tricky shell-ish cases.
// ---------------------------------------------------------------------------

describe('QA: parseConfigAgent — adversarial extraction', () => {
  it('strips an inline comment on an UNQUOTED value', () => {
    expect(parseConfigAgent('RALPH_AGENT=codex # use openai\n')).toBe('codex')
  })

  it('does NOT strip a "#" INSIDE a quoted value', () => {
    // Within quotes, a # is literal to bash. Keep it verbatim.
    expect(parseConfigAgent('RALPH_AGENT="codex#1"\n')).toBe('codex#1')
  })

  it('a LATER commented reassignment does NOT override an earlier real one', () => {
    expect(parseConfigAgent('RALPH_AGENT=codex\n# RALPH_AGENT=claude\n')).toBe('codex')
  })

  it('a real reassignment AFTER a commented line wins', () => {
    expect(parseConfigAgent('# RALPH_AGENT=codex\nRALPH_AGENT=claude\n')).toBe('claude')
  })

  it('CRLF line endings are tolerated (trailing \\r stripped from unquoted value)', () => {
    expect(parseConfigAgent('RALPH_AGENT=codex\r\n')).toBe('codex')
  })

  it('an empty assignment yields empty string (RALPH_AGENT=)', () => {
    expect(parseConfigAgent('RALPH_AGENT=\n')).toBe('')
  })

  it('empty quoted assignment yields empty string', () => {
    expect(parseConfigAgent('RALPH_AGENT=""\n')).toBe('')
  })

  it('does not match a DIFFERENT variable that merely ends in RALPH_AGENT', () => {
    expect(parseConfigAgent('MY_RALPH_AGENT=codex\n')).toBe('')
  })

  it('does not match a variable that starts with RALPH_AGENT but is longer', () => {
    expect(parseConfigAgent('RALPH_AGENTX=codex\n')).toBe('')
  })

  it('preserves the raw casing/whitespace of an invalid value for resolveAgent to judge', () => {
    // parseConfigAgent is not responsible for validation — it hands the raw
    // string to resolveAgent. A mixed-case value passes through as-written.
    expect(parseConfigAgent('RALPH_AGENT=CoDeX\n')).toBe('CoDeX')
  })

  it('never throws on binary-ish / weird content', () => {
    // The two control bytes are written as `\u0000` and `\u0001` rather than
    // embedded (#107): raw, they make `file` classify this suite as `data`, and grep, rg
    // and git grep then skip it without a word — silently, because Node reads it
    // perfectly well. The string parseConfigAgent receives is byte-identical either way,
    // which is what keeps "binary-ish" an honest name for this case.
    expect(() => parseConfigAgent('\u0000\u0001RALPH_AGENT=codex\n')).not.toThrow()
  })
})
