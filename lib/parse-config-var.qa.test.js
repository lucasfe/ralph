import { describe, it, expect } from 'vitest'
import { parseConfigVar } from './parse-config-var.js'

// QA augmentation for #554/#565. parse-config-var.js has no direct test of its
// own (it is exercised transitively via read-config-source/read-config-agent).
// These tests pin the shared assignment grammar's adversarial edges directly, so
// a future refactor of the regex can't quietly change how ralph.config.sh is
// read without a red test.

describe('parseConfigVar — bash-assignment grammar edges (#565 QA)', () => {
  it('returns "" for empty/nullish text or var name', () => {
    expect(parseConfigVar('', 'TASK_SOURCE')).toBe('')
    expect(parseConfigVar(null, 'TASK_SOURCE')).toBe('')
    expect(parseConfigVar('TASK_SOURCE=folder', '')).toBe('')
    expect(parseConfigVar('TASK_SOURCE=folder', null)).toBe('')
  })

  it('LAST uncommented assignment wins (bash source semantics)', () => {
    const text = 'TASK_SOURCE=github\nTASK_SOURCE=folder\n'
    expect(parseConfigVar(text, 'TASK_SOURCE')).toBe('folder')
  })

  it('a later COMMENTED reassignment does not override an earlier live one', () => {
    const text = 'TASK_SOURCE=folder\n# TASK_SOURCE=github\n'
    expect(parseConfigVar(text, 'TASK_SOURCE')).toBe('folder')
  })

  it('strips an inline comment on an unquoted value but not inside quotes', () => {
    expect(parseConfigVar('TASK_SOURCE=folder # local\n', 'TASK_SOURCE')).toBe('folder')
    // A `#` inside a quoted value is part of the value, not a comment.
    expect(parseConfigVar('TASK_SOURCE="fol#der"\n', 'TASK_SOURCE')).toBe('fol#der')
  })

  it('honors the export prefix and surrounding whitespace', () => {
    expect(parseConfigVar('  export TASK_SOURCE =  folder  \n', 'TASK_SOURCE')).toBe('folder')
  })

  it('accepts whitespace around the `=`, which is LOOSER than bash', () => {
    // bash reads `VAR = folder` as a command named VAR and sets nothing. Pinned
    // here as this parser's documented behaviour, not endorsed — if the grammar
    // ever tightens, this is the test that says which configs stop working, and
    // every variable read through it moves together.
    expect(parseConfigVar('TASK_SOURCE = folder\n', 'TASK_SOURCE')).toBe('folder')
  })

  it('unwraps a quoted value, single or double, including an empty one', () => {
    // Quotes are the config author's, not part of the value: a hint that printed
    // `every "1h"` would be reading the file more literally than bash does.
    expect(parseConfigVar('RALPH_DIGEST_INTERVAL="1h"\n', 'RALPH_DIGEST_INTERVAL')).toBe('1h')
    expect(parseConfigVar("RALPH_DIGEST_INTERVAL='2h'\n", 'RALPH_DIGEST_INTERVAL')).toBe('2h')
    expect(parseConfigVar('RALPH_DIGEST_INTERVAL=""\n', 'RALPH_DIGEST_INTERVAL')).toBe('')
    expect(parseConfigVar("RALPH_DIGEST_INTERVAL=''\n", 'RALPH_DIGEST_INTERVAL')).toBe('')
    // A quoted zero is still a zero — callers that treat 0 as "off" rely on this.
    expect(parseConfigVar('RALPH_DIGEST_INTERVAL="0"\n', 'RALPH_DIGEST_INTERVAL')).toBe('0')
  })

  it('reads a file with CRLF line endings', () => {
    // A config edited on Windows, or fetched through a tool that rewrote the
    // endings: the \r must not survive into the value and reach a printed line.
    const text = 'TASK_SOURCE=github\r\nRALPH_DIGEST_INTERVAL=30m\r\n'
    expect(parseConfigVar(text, 'TASK_SOURCE')).toBe('github')
    expect(parseConfigVar(text, 'RALPH_DIGEST_INTERVAL')).toBe('30m')
  })

  it('an empty assignment (VAR=) yields ""', () => {
    expect(parseConfigVar('TASK_SOURCE=\n', 'TASK_SOURCE')).toBe('')
    expect(parseConfigVar('export TASK_SOURCE=\n', 'TASK_SOURCE')).toBe('')
  })

  it('does not match a variable whose name merely ENDS with the target', () => {
    expect(parseConfigVar('MY_TASK_SOURCE=folder\n', 'TASK_SOURCE')).toBe('')
  })

  it('does not match a variable whose name merely STARTS with the target', () => {
    expect(parseConfigVar('TASK_SOURCE_X=folder\n', 'TASK_SOURCE')).toBe('')
  })

  it('a commented line with leading whitespace is ignored', () => {
    expect(parseConfigVar('   #TASK_SOURCE=folder\n', 'TASK_SOURCE')).toBe('')
  })

  it('never throws on regex-special characters in the var name', () => {
    // escapeName must neutralize regex metacharacters.
    expect(() => parseConfigVar('A.B=1\n', 'A.B')).not.toThrow()
    expect(parseConfigVar('A.B=1\n', 'A.B')).toBe('1')
  })
})
