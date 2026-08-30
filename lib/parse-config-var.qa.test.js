import { describe, it, expect } from 'vitest'
import { execa } from 'execa'
import { parseConfigVar, configAssignsVar } from './parse-config-var.js'
import { parseConfigAgent } from './read-config-agent.js'
import { parseConfigSource } from './read-config-source.js'
import { resolveAgent } from './agent-registry.js'
import { resolveSource } from './task-source.js'

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

// ---------------------------------------------------------------------------
// #62 widened the inline-comment strip from `/\s+#.*$/` to `/(^|\s+)#.*$/` so that a
// value which IS a comment (`RALPH_AGENT=#was codex`) reads as unset. This is the
// highest-blast-radius change in that slice: ONE regex, in the one parser every JS
// reader of ralph.config.sh goes through — RALPH_AGENT, TASK_SOURCE,
// RALPH_DIGEST_INTERVAL, RALPH_DIGEST_MODEL — so a value it now eats is a setting that
// silently stops being read, in a file bash reads differently.
//
// The measure of "differently" is not an opinion here: every row below is run through a
// REAL bash and compared. `#` is the only shell metacharacter involved and no row
// executes anything but `printf`, so this is a grammar differential and nothing else.
// ---------------------------------------------------------------------------

// bash's own answer for one assignment line: what `. ralph.config.sh` would leave in X.
async function bashValue(line) {
  const script = `${line}\nprintf 'V<<%s>>' "\${X-«unset»}"`
  const { stdout } = await execa('bash', ['-c', script], { reject: false })
  return stdout.match(/V<<([\s\S]*)>>/)?.[1] ?? null
}

describe('parseConfigVar — the widened comment strip, measured against bash (#62 QA)', () => {
  it.each([
    ['a plain value', 'X=folder', 'folder'],
    ['a value and a note', 'X=folder # local tasks', 'folder'],
    ['a note two spaces out', 'X=30m  # every half hour', '30m'],
    ['a hash mid-word', 'X=30m#note', '30m#note'],
    ['a hash mid-word, quoted', 'X="fol#der"', 'fol#der'],
    ['a hash inside a quoted value, after a space', 'X="a #b"', 'a #b'],
    ['a hash-leading value in single quotes', "X='# literal'", '# literal'],
    ['a hash-leading value in double quotes', 'X="#quoted"', '#quoted'],
    ['a comment and no value', 'X= # off for now', ''],
    ['an empty quoted value', 'X=""', ''],
    ['an export prefix', 'export X=codex', 'codex'],
    ['a zero', 'X=0', '0'],
    ['a space between number and unit, quoted', 'X="30 m"', '30 m'],
    // A quote inside the NOTE, which is the shape that decides whether the quoted rule
    // may be greedy. Read greedily, the pair would close on the last quote of the line
    // and the value would swallow the comment; bash closes it at the first one.
    ['a quoted value and a note that quotes something else', 'X="30m" # not "2h"', '30m'],
    ['a quoted value and a note with an apostrophe', 'X="30m" # don\'t go lower', '30m'],
    ['a single-quoted value and a note that quotes something else', 'X=\'2h\' # not \'30m\'', '2h'],
  ])('%s: parser and bash both read %o as the value', async (_label, line, expected) => {
    // The rows that MUST agree, and the reason the list is this long: each of these is
    // a shape the shipped template's own prose invites, and each one is read twice per
    // run — once by bash sourcing the file, once by the JS layer parsing it.
    expect(parseConfigVar(`${line}\n`, 'X')).toBe(expected)
    expect(await bashValue(line)).toBe(expected)
  })

  it.each([
    // A `#` that OPENS the value.
    ['a value that is only a comment', 'X=#off', '#off', ''],
    ['a bare hash', 'X=#', '#', ''],
    ['a double hash', 'X=##', '##', ''],
    ['a shebang-shaped value', 'X=#!/bin/sh', '#!/bin/sh', ''],
    ['an exported comment', 'export X=#x', '#x', ''],
    // A `#` ADJACENT to the closing quote — the other half of the same divergence. The
    // comment the quoted rule allows after the closing quote needs no whitespace in
    // front of it (`(?:\s*#.*)?`, and `\s*` matches nothing), so a hash glued to that
    // quote opens a comment here where bash reads it as more of the same word.
    ['a hash glued to a closing quote', 'X="a"#b', 'a#b', 'a'],
    ['a hash glued to an EMPTY quoted value', 'X=""#note', '#note', ''],
    ['an interval with a glued note', 'X="30m"#note', '30m#note', '30m'],
    ['a hash inside AND after the quotes', 'X="a#b"#c', 'a#b#c', 'a#b'],
    // Divergences that predate #62.
    ['an escaped space before a hash', 'X=a\\ #b', 'a #b', 'a\\'],
    ['whitespace around the =', 'X = folder', '«unset»', 'folder'],
  ])(
    '%s: bash says %o, this parser says %o — pinned divergence',
    async (_label, line, bashSays, parserSays) => {
      // NOT a bug report, a boundary marker. Every KIND of comment divergence is here,
      // which is what makes parse-config-var.js's claim about itself ("two deliberate
      // divergences from bash's COMMENT rule: a leading `#`, and a `#` glued to a closing
      // quote") checkable rather than merely stated. bash opens a comment only at a `#`
      // that begins a WORD, so in each row the `#` is inside the assignment word and a
      // real shell keeps it.
      //
      // Kinds, not instances, and the difference is worth being exact about: an
      // exhaustive sweep of every 1-to-4-character value over `" ' a # space b` (1554
      // shapes) finds 626 bash will even accept, and the parser reads 355 of them
      // differently. Those 355 fall into three families: 115 are the leading-`#` case
      // above, and the remaining 240 are `#`-glued-to-a-closing-quote plus shapes that
      // are not about the comment rule at all. The split BETWEEN those last two is not
      // written down here on purpose — where one ends and the other begins depends on
      // what counts as "glued to a quote" versus "glued to a word", and two careful
      // readers of the same 240 shapes will draw that line in different places. The third
      // family is about bash's WORD rules: adjacent quoted segments concatenate (`X=""a`
      // is `a`, `X="a"b` is `ab`, `X="'"a` is `'a`), and `X= word` is an env-prefixed
      // COMMAND rather than an assignment. Both of those predate #62 —
      // parse-config-var.test.js pins the concatenation shapes, and the `X = folder` row
      // above marks the other. The sweep itself is not in this repo: the 1554 follows from
      // the alphabet (6 + 6² + 6³ + 6⁴), but 626, 355 and 115 are measurements rather than
      // anything the rows here prove, so re-checking them means writing the sweep again.
      //
      // The BEHAVIOUR is still the one Ralph wants: none of the values in the `bash
      // says` column is a legal setting for any knob read through this parser (see the
      // collateral test below), so each divergence trades a value that would have been
      // rejected for the reading the line plainly means. Requiring whitespace before
      // the `#` would not remove the divergence, only move it — `X="30m"#note` would
      // fall through raw and produce a warning plus a launch-box line quoting the note.
      expect(await bashValue(line)).toBe(bashSays)
      expect(parseConfigVar(`${line}\n`, 'X')).toBe(parserSays)
    },
  )

  it('eats no LEGITIMATE value of any knob it is asked to read', async () => {
    // The blast-radius question, answered at the consumers rather than at the regex:
    // every value the four JS-read knobs can validly hold, read back through the real
    // readers. A `#` anywhere in this set would mean the widened strip had broken a
    // supported configuration.
    const knobs = {
      RALPH_AGENT: ['claude', 'codex', 'CODEX', ' claude '],
      TASK_SOURCE: ['github', 'folder', 'GitHub', ' folder '],
      RALPH_DIGEST_INTERVAL: ['30m', '60', '2h', '1d', '24d', '0'],
      RALPH_DIGEST_MODEL: ['haiku', 'sonnet', 'gpt-5-mini', 'claude-3-5-haiku-20241022'],
    }
    for (const [name, values] of Object.entries(knobs)) {
      for (const value of values) {
        expect(value.includes('#'), `${name}=${value}`).toBe(false)
        expect(parseConfigVar(`${name}="${value}"\n`, name), `${name}=${value}`).toBe(value)
      }
    }
    // And the shape the strip now eats resolves to each knob's default rather than to
    // a comment masquerading as a setting.
    expect(parseConfigAgent('RALPH_AGENT=#was codex\n')).toBe('')
    expect(resolveAgent({ RALPH_AGENT: parseConfigAgent('RALPH_AGENT=#was codex\n') })).toEqual({
      agent: 'claude',
      fellBack: false,
      warning: null,
    })
    expect(parseConfigSource('TASK_SOURCE=#folder\n')).toBe('')
    expect(resolveSource({ TASK_SOURCE: parseConfigSource('TASK_SOURCE=#folder\n') })).toBe('github')
  })

  it('leaves a LONE quote alone, and bash calls it a syntax error', async () => {
    // `VAR="` with nothing after it — which is what the rows below are, a lone quote at
    // the end of the input — is an unterminated quote: bash refuses the whole file, so
    // there is no right answer to inherit and any answer this parser gives is arbitrary.
    // That is NOT the general rule for a quote this parser sees opened and not closed: a
    // LATER line can close it, and bash then reads a value spanning both lines
    // (`X="30m` + `still the value"`) where this line-based parser reads `"30m`. No knob
    // read through here can hold a multi-line value, so nothing downstream depends on
    // the difference — see the note in parse-config-var.js. Pinned
    // because it was arbitrary AND undocumented — pre-#62 the "starts and ends with the
    // same quote" test was true of a single character, so `X="` unwrapped to '' — and an
    // undocumented arbitrary answer is the kind that changes twice.
    //
    // The answer now is the raw character, which is what "no matching pair, so nothing
    // to unwrap" produces. Nothing downstream can tell the difference: `"` is not a
    // legal value of any knob, so it reaches the same fallback '' would have.
    expect(parseConfigVar('X="\n', 'X')).toBe('"')
    expect(parseConfigVar("X='\n", 'X')).toBe("'")
    // bash's answer, for the record: it does not have one.
    expect(await bashValue('X="')).toBe(null)
    expect(await bashValue("X='")).toBe(null)
    // ...and the consumers land on their defaults either way, which is the only
    // behaviour any caller of this parser depends on here.
    expect(resolveSource({ TASK_SOURCE: parseConfigSource('TASK_SOURCE="\n') })).toBe('github')
    expect(resolveAgent({ RALPH_AGENT: parseConfigAgent('RALPH_AGENT="\n') })).toMatchObject({
      agent: 'claude',
    })
  })

  it('ignores a comment on a CRLF line without letting the \\r reach the value', async () => {
    const text = 'X=30m # note\r\nY=#off\r\nZ="fol#der"\r\n'
    expect(parseConfigVar(text, 'X')).toBe('30m')
    expect(parseConfigVar(text, 'Y')).toBe('')
    expect(parseConfigVar(text, 'Z')).toBe('fol#der')
  })

  it('still takes the LAST live assignment when comments are in play', () => {
    // The interaction between the two rules that decide what a value is: which line
    // wins, and what on that line counts. A commented-out value is a LIVE assignment
    // of nothing, so it beats an earlier real one — which is exactly what a user
    // means by editing the value out and leaving the note.
    expect(parseConfigVar('X=30m\nX=#off\n', 'X')).toBe('')
    expect(parseConfigVar('X=#off\nX=30m\n', 'X')).toBe('30m')
    // ...and a fully commented LINE is not an assignment at all, so it does not.
    expect(parseConfigVar('X=30m\n# X=2h\n', 'X')).toBe('30m')
  })

  it('reads the value out of a QUOTED assignment that carries a note', async () => {
    // The shipped ralph.config.sh writes this knob QUOTED (`RALPH_DIGEST_INTERVAL=""`),
    // so filling it in and annotating the choice — `RALPH_DIGEST_INTERVAL="30m" # every
    // half hour` — is the single most likely edit a user makes to that file. bash reads
    // `30m`, and so does this parser: the quoted rule matches the pair and lets the
    // trailing comment fall outside it.
    //
    // The regression this guards is the reading it replaced, where "is it quoted?" was
    // decided on the FIRST character alone and the whole line's tail became the value.
    // Every consumer got the comment as part of the setting:
    //   • RALPH_DIGEST_INTERVAL → no digest window, and a launch box quoting the note
    //   • TASK_SOURCE → silently falls back to github, i.e. a folder-source repo starts
    //     reading GitHub issues
    //   • RALPH_AGENT → falls back to claude with a warning naming a value nobody typed
    // Which is why the rows below end at the two consumers rather than at the parser.
    const rows = [
      ['RALPH_DIGEST_INTERVAL="30m" # every half hour', 'RALPH_DIGEST_INTERVAL', '30m'],
      ["RALPH_DIGEST_INTERVAL='2h' # hourly is too chatty", 'RALPH_DIGEST_INTERVAL', '2h'],
      ['TASK_SOURCE="folder" # local tasks, not issues', 'TASK_SOURCE', 'folder'],
      ["RALPH_AGENT='codex' # was claude", 'RALPH_AGENT', 'codex'],
      ['RALPH_DIGEST_MODEL="haiku"   # cheap', 'RALPH_DIGEST_MODEL', 'haiku'],
    ]
    // bash's answer first, so a failure below cannot be read as "maybe bash agrees".
    for (const [line, name, expected] of rows) {
      expect(await bashValue(line.replace(name, 'X')), line).toBe(expected)
    }
    expect(rows.map(([line, name]) => parseConfigVar(`${line}\n`, name))).toEqual(
      rows.map(([, , expected]) => expected),
    )
    // ...and the two consumers where a misread value changes what a run DOES.
    expect(resolveSource({ TASK_SOURCE: parseConfigSource('TASK_SOURCE="folder" # local\n') })).toBe(
      'folder',
    )
    expect(resolveAgent({ RALPH_AGENT: parseConfigAgent('RALPH_AGENT="codex" # was claude\n') })).toEqual(
      { agent: 'codex', fellBack: false, warning: null },
    )
  })
})

// ---------------------------------------------------------------------------
// #133 QA — the value class widened from `.` to `[^\n]`.
//
// `.` matches no LINE TERMINATOR in a JS regex, and that set is larger than it looks:
// LF, CR, U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR. Lines here are already
// split at LF, so the only ones that could ever appear INSIDE one are the other three —
// and each made the whole assignment fail to match, so this parser returned '' (or an
// earlier line's value) for a line the shell that sources the same file reads whole.
//
// It surfaced on JIRA_JQL, the one knob whose two readers act on different answers:
// templates/ralph.sh sources the file and the loop got the user's query, while
// `ralph cycle` and `ralph status` read it through here and saw "not configured", which
// lib/jira-jql.js reports as an empty query and counts as depth 0. The line reaches this
// parser however it was written — the template asks for hand edits of that very line —
// and a PASTE into `ralph init` is one route among them, on the runtimes where readline
// keeps the separator: measured at the real prompt, it hands both back intact on every
// node measured from 18.20.8 up to 23.11.1 and ends the line at one on 24.16.0. The six
// versions actually measured, and the 23 -> 24 boundary, are pinned in
// lib/init.qa.test.js.
//
// Every row is measured against a real bash, like the #62 block above, and the CRLF rows
// are the ones that say the widening did not cost anything: a trailing \r is a LINE
// ENDING and must not survive into a value.
//
// Control characters are built from their code points, never typed (#107).
// ---------------------------------------------------------------------------

describe('parseConfigVar — line terminators INSIDE a value (#133 QA)', () => {
  const CR = String.fromCharCode(0x0d)
  const LS = String.fromCharCode(0x2028)
  const PS = String.fromCharCode(0x2029)

  it.each([
    ['U+2028 in a quoted value', `X="a${LS}b"`, `a${LS}b`],
    ['U+2029 in a quoted value', `X="a${PS}b"`, `a${PS}b`],
    ['U+2028 in an UNQUOTED value', `X=a${LS}b`, `a${LS}b`],
    ['a CR in a quoted value', `X="a${CR}b"`, `a${CR}b`],
    ['a CR in an unquoted value', `X=a${CR}b`, `a${CR}b`],
    ['U+2028 beside a comment', `X="a${LS}b" # note`, `a${LS}b`],
  ])('%s: this parser and bash agree', async (_label, line, expected) => {
    // bash first, so a failure below cannot be read as "maybe bash agrees".
    expect(await bashValue(line)).toBe(expected)
    expect(parseConfigVar(`${line}\n`, 'X')).toBe(expected)
  })

  it('a value carrying one of these no longer loses to an EARLIER assignment', () => {
    // The sharpest edge of the old behaviour, and the reason '' was not the worst of it:
    // a line that matched nothing was SKIPPED, so the previous assignment stayed the
    // answer — "the last assignment wins" quietly stopped being true.
    expect(parseConfigVar(`X="first"\nX="a${LS}b"\n`, 'X')).toBe(`a${LS}b`)
    expect(parseConfigVar(`X="first"\nX="a${CR}b"\n`, 'X')).toBe(`a${CR}b`)
  })

  it('a trailing \\r is still a LINE ENDING, not part of the value', () => {
    // What the widened class had to leave alone. `+?` is lazy, so the group takes the
    // shortest run that lets `\s*$` match the rest — and a trailing \r is whitespace, so
    // it still falls outside the value exactly as it did when the class was `.`.
    expect(parseConfigVar(`X="abc"${CR}\n`, 'X')).toBe('abc')
    expect(parseConfigVar(`X=abc${CR}\n`, 'X')).toBe('abc')
    expect(parseConfigVar(`X=30m # note${CR}\n`, 'X')).toBe('30m')
    expect(parseConfigVar(`X=""${CR}\n`, 'X')).toBe('')
    // And the whole-file CRLF case the #565 block pins, re-read here beside its edge.
    expect(parseConfigVar(`TASK_SOURCE=github${CR}\nX=1${CR}\n`, 'TASK_SOURCE')).toBe('github')
  })

  it('an embedded LF is still NOT a value — the documented line-based limit', () => {
    // The one member of the class that is not affected, because the split happens at it:
    // bash reads a value spanning both lines, this parser reads the first line and hands
    // back the opening quote with it. Unchanged by the widening, and pinned here so the
    // two are not confused for each other.
    expect(parseConfigVar('X="a\nb"\n', 'X')).toBe('"a')
    expect(configAssignsVar('X="a\nb"\n', 'X')).toBe(true)
  })

  it('configAssignsVar always agreed, and still does', () => {
    // The head-only reader never had a `.` in it, so it said "assigned" for every line
    // above while parseConfigVar said ''. That disagreement was the shape every JS caller
    // reads through (`configAssignsVar(...) ? parseConfigVar(...) : null`), and it landed
    // on "assigned, and empty" — the one answer that means "configured with nothing".
    for (const line of [`X="a${LS}b"`, `X="a${PS}b"`, `X="a${CR}b"`]) {
      expect(configAssignsVar(`${line}\n`, 'X'), line).toBe(true)
      expect(parseConfigVar(`${line}\n`, 'X'), line).not.toBe('')
    }
  })
})
