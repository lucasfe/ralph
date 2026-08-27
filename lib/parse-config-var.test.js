import { describe, it, expect } from 'vitest'
import { parseConfigVar } from './parse-config-var.js'
import { parseConfigSource } from './read-config-source.js'
import { resolveSource } from './task-source.js'

// #62 — the one rule this parser exists to imitate: what BASH would have read out of
// ralph.config.sh. The loop sources that file; the JS layer text-parses it. Every
// disagreement between the two is a setting that means one thing to the shell and
// another to `ralph start`, and the reader has no way to see which one won.
//
// A `#` that begins a word begins a comment in bash — including when it is the FIRST
// thing after the `=`, which is how anyone comments out a value they still want to
// keep the name of. The parser stripped an inline comment only when it followed a
// value, so `RALPH_DIGEST_INTERVAL= # off for now` read as the interval
// `# off for now`: an interval `ralph start` then reported in its launch box and
// warned about on stderr, on every launch, for a knob the user had turned OFF.
//
// The rule is general, so it lands here rather than in the one caller that noticed:
// `TASK_SOURCE= # decide later` and `RALPH_AGENT= # was codex` have exactly the same
// shape, and each of those values goes through a registry that would take the
// comment for a name.

describe('parseConfigVar — a value that is only a comment is no value (#62)', () => {
  it('reads an empty value when the value is commented out on its own line', () => {
    expect(parseConfigVar('RALPH_DIGEST_INTERVAL= # off for now\n', 'RALPH_DIGEST_INTERVAL')).toBe('')
    expect(parseConfigVar('TASK_SOURCE=  # decide later\n', 'TASK_SOURCE')).toBe('')
    expect(parseConfigVar('RALPH_AGENT=#was codex\n', 'RALPH_AGENT')).toBe('')
  })

  it('still strips a comment that follows a real value, and keeps the value', () => {
    expect(parseConfigVar('RALPH_DIGEST_INTERVAL=30m # every half hour\n', 'RALPH_DIGEST_INTERVAL')).toBe('30m')
    expect(parseConfigVar('TASK_SOURCE=folder # local\n', 'TASK_SOURCE')).toBe('folder')
  })

  it('keeps a `#` that bash would keep — inside a word, or inside quotes', () => {
    // Bash only opens a comment at the start of a word, so neither of these is one.
    expect(parseConfigVar('TASK_SOURCE=fol#der\n', 'TASK_SOURCE')).toBe('fol#der')
    expect(parseConfigVar('TASK_SOURCE="fol#der"\n', 'TASK_SOURCE')).toBe('fol#der')
    expect(parseConfigVar('TASK_SOURCE="# not a comment"\n', 'TASK_SOURCE')).toBe('# not a comment')
    expect(parseConfigVar("TASK_SOURCE='# nor this'\n", 'TASK_SOURCE')).toBe('# nor this')
  })

  it('reads the value out of a QUOTED assignment that carries a note', () => {
    // The template writes every knob QUOTED, so annotating one is `VAR="30m" # note`
    // far more often than `VAR=30m # note`. bash reads `30m` for both (checked); this
    // parser used to read the first one as the entire tail of the line, quotes and
    // comment included, because "is it quoted?" looked only at the first character and
    // then stripped nothing — and the whole-value unwrap below could not help, since
    // the value no longer ENDED with a quote.
    expect(parseConfigVar('RALPH_DIGEST_INTERVAL="30m" # every half hour\n', 'RALPH_DIGEST_INTERVAL')).toBe('30m')
    expect(parseConfigVar("RALPH_DIGEST_INTERVAL='2h' # too chatty otherwise\n", 'RALPH_DIGEST_INTERVAL')).toBe('2h')
    expect(parseConfigVar('RALPH_DIGEST_MODEL="haiku"   # cheap\n', 'RALPH_DIGEST_MODEL')).toBe('haiku')
    expect(parseConfigVar('TASK_SOURCE="folder" # local tasks\n', 'TASK_SOURCE')).toBe('folder')
    // The knob whose misreading changes what a whole run DOES, read through its own
    // reader: a folder-source repo must not quietly start reading GitHub issues
    // because someone annotated the line.
    expect(resolveSource({ TASK_SOURCE: parseConfigSource('TASK_SOURCE="folder" # local tasks\n') })).toBe('folder')
  })

  it('still refuses to see a comment INSIDE the quotes', () => {
    // The other side of that strip: everything between the quotes is the value, so a
    // `#` in there is data. This is the assertion that a strip written one character
    // too greedily would break.
    expect(parseConfigVar('X="a #b"\n', 'X')).toBe('a #b')
    expect(parseConfigVar('X="fol#der" # note\n', 'X')).toBe('fol#der')
    expect(parseConfigVar("X='# literal' # note\n", 'X')).toBe('# literal')
    expect(parseConfigVar('X="30 m"\n', 'X')).toBe('30 m')
    expect(parseConfigVar('X=""\n', 'X')).toBe('')
    expect(parseConfigVar('X="" # off for now\n', 'X')).toBe('')
  })

  it('leaves the shapes it never claimed to parse exactly as they were', () => {
    // bash CONCATENATES adjacent quoted words (`"a""b"` is `ab`) and an unterminated
    // quote is a syntax error that stops the loop sourcing the file at all. This parser
    // models neither, and the rule is deliberately built so it cannot start by accident:
    // the quoted reading requires the text after the closing quote to be a comment or
    // nothing, and everything else keeps the raw text for a downstream registry or
    // duration parser to refuse.
    //
    // Which is the safe direction. A value this parser hands back raw fails a validator
    // and says so; a value it silently repairs into something plausible does not, and
    // the file bash sourced said something else.
    expect(parseConfigVar('X="a""b"\n', 'X')).toBe('a""b')
    expect(parseConfigVar('X="30m"extra\n', 'X')).toBe('"30m"extra')
    expect(parseConfigVar('X="30m # note\n', 'X')).toBe('"30m # note')
  })

  it('lets a later commented-out assignment lose to an earlier live one, as bash does', () => {
    // `VAR=30m` then `VAR= # off` is bash setting it and then unsetting it: last wins,
    // and the last one is empty.
    const text = 'RALPH_DIGEST_INTERVAL=30m\nRALPH_DIGEST_INTERVAL= # off for now\n'
    expect(parseConfigVar(text, 'RALPH_DIGEST_INTERVAL')).toBe('')
    // Whereas a whole line commented out is not an assignment at all, so the live one
    // upstream of it still stands.
    const commentedLine = 'RALPH_DIGEST_INTERVAL=30m\n# RALPH_DIGEST_INTERVAL=2h\n'
    expect(parseConfigVar(commentedLine, 'RALPH_DIGEST_INTERVAL')).toBe('30m')
  })
})
