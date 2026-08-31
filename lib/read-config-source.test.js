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

  it('tolerates the export prefix, a space-or-tab indent, and padding after the value', () => {
    // Named as the two blanks it is rather than as "the whitespace bash ignores", which was
    // overstating it: bash's blanks are space and tab, and a JS `\s` indent class took 22
    // more that bash reads as part of a WORD (#147 — `\s` matches 24 characters other than
    // LF, all of them swept against a real bash in lib/parse-config-var.boundary.qa.test.js).
    // Padding AFTER the value is a separate rule, and it is now the same two blanks: the
    // grammar's value group is padded `[ \t]*` on both sides, because bash ASSIGNS a value
    // that starts or ends with anything wider (#147 follow-up).
    // Blanks BEFORE the value are a different rule and are no longer tolerated (#149 review): a
    // bare `NAME=` followed by a blank and a word is an environment PREFIX to that word, so bash
    // runs `folder` as a command and assigns nothing, and this reader now says nothing too — which
    // for THIS knob is the whole point, since the two answers are two different queues. Padding
    // after the value is unaffected: that is padding bash really does drop.
    expect(parseConfigSource('export TASK_SOURCE="folder"  \n')).toBe('folder')
    expect(parseConfigSource('   TASK_SOURCE=folder \n')).toBe('folder')
    expect(parseConfigSource('   TASK_SOURCE=  folder \n')).toBe('')
  })

  it('does not tolerate whitespace before the `=`, because bash does not (#147)', () => {
    // THE KNOB THIS COST THE MOST. Both readers of this line decide which QUEUE a run works
    // from, and they used to decide differently: templates/ralph.sh sources the file, sees no
    // assignment and dispatches github, while this reader returned `folder` and `ralph start`
    // announced a folder run. The measured transcript, and the two halves asserted against
    // each other, are in lib/parse-config-var.qa.test.js's #147 block.
    expect(parseConfigSource('   TASK_SOURCE =  folder \n')).toBe('')
    expect(parseConfigSource('TASK_SOURCE = folder\n')).toBe('')
    // ...and the earlier live line therefore keeps standing, as it does in bash.
    expect(parseConfigSource('TASK_SOURCE=github\nTASK_SOURCE = folder\n')).toBe('github')
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
