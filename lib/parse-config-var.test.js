import { describe, it, expect } from 'vitest'
import { parseConfigVar, configAssignsVar } from './parse-config-var.js'
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

  it('answers PRESENT for a blank assignment, where the value alone cannot (#118)', () => {
    // The distinction '' cannot carry, and the reason it is a second question rather than a
    // nullable value: bash masks an exported variable with a blank assignment but not with an
    // absent one, so a JS reader predicting what the loop will see has to tell the two apart.
    for (const text of [
      'X=""\n',
      "X=''\n",
      'X=\n',
      'export X=\n',
      'X=   \n',
      'X= # off for now\n',
      'X="" # off for now\n',
    ]) {
      expect(configAssignsVar(text, 'X'), text).toBe(true)
      expect(parseConfigVar(text, 'X'), text).toBe('')
    }
    // ...and ABSENT for every way of not assigning it, including the one a user reaches for to
    // back a knob out. A commented line is not an assignment, and a longer name is not this name.
    for (const text of [
      '',
      'TASK_SOURCE=folder\n',
      '# X=codex\n',
      '   # X=codex\n',
      'XX=codex\n',
      'X_MODEL=codex\n',
      'PREFIX_X=codex\n',
    ]) {
      expect(configAssignsVar(text, 'X'), JSON.stringify(text)).toBe(false)
      expect(parseConfigVar(text, 'X'), JSON.stringify(text)).toBe('')
    }
  })

  it('never says ABSENT about a line the value reader reads a value out of', () => {
    // THE TRIPWIRE, and the reason both readers are built from one `assignmentHead`. Two regexes
    // in two functions would each look right alone while disagreeing about what an assignment is,
    // and the disagreement would be invisible: a shape `parseConfigVar` reads a value out of but
    // `configAssignsVar` calls absent would send its caller to the process environment for a knob
    // the file had set — silently running the wrong agent, which is #118 again from the other end.
    //
    // So: over every shape either function claims to understand, a non-empty value IMPLIES an
    // assignment. GENERATED rather than listed, and that is the point — a table only pins the
    // shapes whoever wrote it thought of, so it cannot catch a revision that widens the value
    // grammar to a shape nobody listed. (Checked: a table of 23 hand-written shapes passes against
    // a `parseConfigVar` widened to accept `X:=codex`. The sweep below fails against it.)
    const prefixes = ['', 'export ', 'export', '  ', '\t', '#', '# ', '  # ']
    const names = ['X', 'XX', 'X_', 'x', 'YX']
    const separators = ['=', ' =', '= ', ' = ', ':=', '==', '+=', '', ' ']
    const values = ['', 'codex', '"codex"', "'codex'", '""', '#off', ' # off', '"a #b"', '"a""b"']
    let generated = 0
    for (const prefix of prefixes) {
      for (const name of names) {
        for (const separator of separators) {
          for (const value of values) {
            const text = `${prefix}${name}${separator}${value}\n`
            generated += 1
            if (parseConfigVar(text, 'X') !== '') {
              expect(configAssignsVar(text, 'X'), JSON.stringify(text)).toBe(true)
            }
          }
        }
      }
    }
    // The sweep is worth nothing if it silently generates nothing.
    expect(generated).toBe(prefixes.length * names.length * separators.length * values.length)

    // The hand-written shapes stay as well, as documentation of what each rule is FOR — the sweep
    // proves the implication, this names the cases.
    const shapes = [
      'X=codex',
      'X="codex"',
      "X='codex'",
      'export X=codex',
      'export   X="codex"',
      '   X="codex"   ',
      'X = codex',
      'X=codex # note',
      'X="codex" # note',
      'X="fol#der"',
      'X="a #b"',
      'X="a""b"',
      'X="30m"extra',
      'X="30m # note',
      'X=#off',
      'X= # off',
      'X=',
      'X=""',
      '# X=codex',
      'XX=codex',
      'X',
      '=codex',
      'X==codex',
    ]
    for (const line of shapes) {
      const text = `${line}\n`
      const value = parseConfigVar(text, 'X')
      if (value !== '') {
        expect(configAssignsVar(text, 'X'), `${line} -> ${JSON.stringify(value)}`).toBe(true)
      }
    }
    // The same implication over a file with several lines, where the assignment is not the first
    // thing in the text — the value reader takes the LAST live one, so presence must see it too.
    const late = 'TASK_SOURCE=folder\n# X=nope\nX="codex"\n'
    expect(parseConfigVar(late, 'X')).toBe('codex')
    expect(configAssignsVar(late, 'X')).toBe(true)
  })

  it('takes a name with regex metacharacters literally, in both answers', () => {
    // `escapeName` is shared by the two readers now; this is the assertion that it is actually
    // reached from the new one. A name treated as a pattern would match a DIFFERENT knob.
    expect(configAssignsVar('A.B=1\n', 'A.B')).toBe(true)
    expect(configAssignsVar('AxB=1\n', 'A.B')).toBe(false)
    expect(parseConfigVar('AxB=1\n', 'A.B')).toBe('')
  })

  it('answers falsy inputs without throwing, like the value reader', () => {
    for (const [text, name] of [
      [undefined, 'X'],
      [null, 'X'],
      ['', 'X'],
      ['X=1\n', undefined],
      ['X=1\n', ''],
    ]) {
      expect(configAssignsVar(text, name)).toBe(false)
      expect(parseConfigVar(text, name)).toBe('')
    }
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
