import { describe, it, expect } from 'vitest'
import { parseConfigSource } from './read-config-source.js'

// #565: mirror parseConfigAgent, but for the TASK_SOURCE setting. The cycle
// preflight reads this without sourcing ralph.config.sh to decide whether gh
// auth is required. The raw value is handed to resolveSource for validation.
describe('parseConfigSource — extract TASK_SOURCE from ralph.config.sh text', () => {
  it('returns empty string when the setting is absent', () => {
    expect(parseConfigSource('RALPH_AGENT="claude"\n')).toBe('')
  })

  it('reads a double-quoted value', () => {
    expect(parseConfigSource('TASK_SOURCE="folder"\n')).toBe('folder')
  })

  it('reads a single-quoted value', () => {
    expect(parseConfigSource("TASK_SOURCE='folder'\n")).toBe('folder')
  })

  it('reads an unquoted value', () => {
    expect(parseConfigSource('TASK_SOURCE=folder\n')).toBe('folder')
  })

  it('ignores commented-out lines', () => {
    expect(parseConfigSource('# TASK_SOURCE="folder"\n')).toBe('')
    expect(parseConfigSource('  #TASK_SOURCE=folder\n')).toBe('')
  })

  it('uses the LAST uncommented assignment', () => {
    expect(parseConfigSource('TASK_SOURCE=github\nTASK_SOURCE="folder"\n')).toBe('folder')
  })

  it('tolerates surrounding whitespace and export prefix', () => {
    expect(parseConfigSource('export TASK_SOURCE="folder"  \n')).toBe('folder')
    expect(parseConfigSource('   TASK_SOURCE =  folder \n')).toBe('folder')
  })

  it('strips an inline comment on an unquoted value', () => {
    expect(parseConfigSource('TASK_SOURCE=folder # local tasks\n')).toBe('folder')
  })

  it('does not match a DIFFERENT variable that merely ends in TASK_SOURCE', () => {
    expect(parseConfigSource('MY_TASK_SOURCE=folder\n')).toBe('')
  })

  it('returns empty string on empty/nullish input', () => {
    expect(parseConfigSource('')).toBe('')
    expect(parseConfigSource(null)).toBe('')
    expect(parseConfigSource(undefined)).toBe('')
  })

  it('an empty assignment yields empty string (TASK_SOURCE=)', () => {
    expect(parseConfigSource('TASK_SOURCE=\n')).toBe('')
  })
})
