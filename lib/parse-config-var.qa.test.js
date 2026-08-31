import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execa } from 'execa'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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

  it('honors the export prefix, a space-or-tab indent, and padding after the value', () => {
    // Named as the two blanks it is: the shell TOKENIZER's `blank` is space and tab, so an
    // indent class of `\s` was wider than the shell's and is now `[ \t]`. Not derived from
    // `$IFS` — IFS splits the result of an expansion into fields and does not decide how a
    // source line is tokenized, which is measured both ways in
    // parse-config-var.boundary.qa.test.js. The evidence for the class itself is that file's
    // `lands on exactly the class bash accepts, swept rather than sampled`, which asks a real
    // bash about all 24 characters JS `\s` matches apart from LF and gets exactly two back.
    // The whitespace between the name and the `=`, and the padding after the `=`, are two
    // further questions with their own tests below.
    expect(parseConfigVar('  export TASK_SOURCE=  folder  \n', 'TASK_SOURCE')).toBe('folder')
    expect(parseConfigVar('\texport\tTASK_SOURCE=folder\t\n', 'TASK_SOURCE')).toBe('folder')
  })

  it('refuses whitespace BEFORE the `=`, which is what bash does (#147)', () => {
    // Was pinned here as "LOOSER than bash, not endorsed", with a note that the day the
    // grammar tightened this would be the test naming what stopped working. It tightened
    // in #147, so this is that naming: `VAR = folder` is a COMMAND named VAR to a shell,
    // it assigns nothing, and both readers now agree with the shell. Measured:
    //
    //   $ printf 'TASK_SOURCE = folder\n' > t1.sh
    //   $ TASK_SOURCE=github bash -c 'set -a; . ./t1.sh; set +a; printf "[%s]\n" "${TASK_SOURCE-«unset»}"'
    //   ./t1.sh: line 1: TASK_SOURCE: command not found
    //   [github]
    //
    // What stopped working, exactly: a config that spelled ANY knob read through this
    // parser with a space before the `=` used to reach `ralph start`, `ralph status`,
    // `ralph doctor` and `ralph cycle` while reaching the loop as nothing at all. Those
    // configs now read as unset in the JS layer too. Every variable read through this
    // grammar moved together, which is what `assignmentHead` is a shared function for —
    // and the cost of that is NOT uniform, because the knobs split in two:
    //
    //   • The knobs bash also reads — TASK_SOURCE, RALPH_AGENT and JIRA_JQL are named in
    //     templates/ralph.sh, GH_REPO reaches `gh` through the environment the loop
    //     exports — where the fix CLOSES A DIVERGENCE: it takes a value away from the JS
    //     reader and leaves it holding the nothing the loop already held.
    //   • The knobs only the JS layer reads — RALPH_BANNER, RALPH_DIGEST_INTERVAL,
    //     RALPH_DIGEST_MODEL, which appear nowhere in the template — where there is no
    //     second reader to agree with, so the fix CHANGES BEHAVIOUR OUTRIGHT. A repo whose
    //     config said `RALPH_DIGEST_INTERVAL = 30m` used to get a digest window and now
    //     gets none, silently, because an absent interval is the documented default and
    //     warns about nothing. That is the trade one shared grammar costs, and it is
    //     pinned at the command rather than argued here: see "a spaced interval assignment
    //     now opens no window at all" in lib/commands/start.digest-window.qa.test.js, and
    //     the flipped banner rows in start/doctor/status.
    //
    // Which knob is in which list is a property of templates/ralph.sh's text, and it is
    // swept off the shipped file in parse-config-var.boundary.qa.test.js rather than
    // recited from memory here.
    expect(parseConfigVar('TASK_SOURCE = folder\n', 'TASK_SOURCE')).toBe('')
    expect(configAssignsVar('TASK_SOURCE = folder\n', 'TASK_SOURCE')).toBe(false)
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
    // WHITESPACE AFTER THE `=` USED TO HOLD THE LAST TWO ROWS OF THIS TABLE, and it is no longer
    // a divergence at all: `X= folder` and `X=a b` are one family — bash's WORD rule, where the
    // `X=` prefixes a COMMAND and the assignment dies with it — and the #149 review made the
    // parser model that rule instead of pinning it, on both readers. The rows moved to "reads
    // NOTHING off a line whose assignment bash throws away" below, which measures the same two
    // spellings plus the `export` form that behaves differently, and the module carries the
    // scan's own transcript. Its sibling — whitespace BEFORE the `=` — was refused earlier, by
    // #147 (see "refuses whitespace BEFORE the `=`" above, and the #147 block at the foot of this
    // file for both halves measured side by side).
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
      // parse-config-var.test.js pins the concatenation shapes, and the word-rule family stopped
      // being a divergence FOR THE READER PAIR in the #149 review, which taught both readers that
      // rule (the two rows that used to mark it here moved to "reads NOTHING off a line whose
      // assignment bash throws away" below). The four numbers were re-run against the shipped parser
      // after that change and every one of them reproduced unchanged — 1554 shapes, 626 accepted,
      // 355 read differently, 115 of those the leading-`#` case — because this sweep compares
      // `parseConfigVar` ALONE with what the shell holds, and refusing a line makes it answer '' for
      // a shell holding an inherited value, which still counts as a difference here. Swept the way
      // a CALLER reads the file — `configAssignsVar(...) ? parseConfigVar(...) : inherited`, the
      // shape lib/commands/start.js:263 uses — the same 626 shapes leave 211 divergences, so 144 of
      // the 355 are lines the pair now resolves exactly as bash does. The 1554 follows from the
      // alphabet (6 + 6² + 6³ + 6⁴); the rest are measurements rather than anything the rows here
      // prove, so re-checking them means writing the sweep again, as this round did.
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
    // the end of the input — is an unterminated quote, and there is no right answer to
    // inherit for the VALUE, so any answer this parser gives for it is arbitrary. Stated
    // precisely, because "bash refuses the whole file" is the natural guess and it is only
    // half true: through the route the loop uses (`.` on a file) the shell reads and runs as
    // it goes, so it EXECUTES every line above the offending one and abandons from there —
    // an assignment before the lone quote survives, one after it never happens. Measured
    // that way, with the file route and an ambient value, in
    // parse-config-var.boundary.qa.test.js ("bash executes the lines BEFORE the offending
    // one"); what `bashValue` below shows is the narrower thing it can show, which is that
    // one line in isolation yields no value at all.
    // None of that is the general rule for a quote this parser sees opened and not closed: a
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
    // What the widened class had to leave alone — and the MECHANISM changed under it in the
    // #147 follow-up, so it is worth stating rather than inheriting. While the padding was
    // `\s*` the \r fell OUTSIDE the value group, because `\s` matched it. The padding is now
    // `[ \t]*`, which cannot, so the group is forced to keep the \r and `trimPadding`'s
    // trailing class — which names CR, U+2028 and U+2029 for exactly this reason — is what
    // removes it. Measured on the module's own regex:
    //
    //   > 'X=abc\r'.match(assign)[1]   // 'abc\r'  — INSIDE the group
    //   > 'X=\r'.match(assign)[1]      // '\r'     — the whole of it, with an empty tail
    //   > 'X=abc '.match(assign)[1]    // 'abc'    — a real blank still falls to the padding
    //
    // Same answers as when the class was `.`, and #147's widening from `+?` to `*?` did not
    // move them either: the empty-tail case is the `X=` + \r row in
    // parse-config-var.boundary.qa.test.js.
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

// ---------------------------------------------------------------------------
// #147 QA — the two spellings this grammar accepted that bash assigns NOTHING for.
//
// Both were pinned green before this slice, deliberately: parse-config-var.qa.test.js
// called the first "LOOSER than bash, not endorsed", and lib/commands/start.identity-facts
// .qa.test.js pinned the pair as "the two spellings bash assigns nothing at all for" on
// GH_REPO. This block is what replaced those pins — the same two spellings, measured the
// same way, now asserting the shell's answer instead of the parser's old one.
//
// Every row below is measured by SOURCING A REAL FILE the way templates/ralph.sh does
// (`set -a; . ./ralph.config.sh; set +a`) rather than by running one line inline, because
// the whole point of both defects is what the sourcing shell is left holding: an
// assignment that never happened leaves the environment's value alone, and a blank one
// overwrites it. Only the file route shows the difference.
//
// Nothing here writes to the repo: one throwaway directory under the OS temp dir,
// removed after (#41).
// ---------------------------------------------------------------------------

describe('parseConfigVar — whitespace around the `=`, and a bare `=` (#147 QA)', () => {
  const UNSET = '«unset»'
  let TMP = null
  let seq = 0
  beforeAll(() => {
    TMP = mkdtempSync(join(tmpdir(), 'ralph-147-qa-'))
  })
  afterAll(() => {
    if (TMP) rmSync(TMP, { recursive: true, force: true })
  })

  // The loop's OWN task-source resolution, lifted out of templates/ralph.sh rather than
  // paraphrased here. Criterion 5 is a claim about two programs agreeing, so the bash half
  // has to be the bash that ships — a hand-copied `if` would keep agreeing with this test
  // after the template stopped agreeing with it.
  const LOOP = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'ralph.sh'),
    'utf8',
  )
  const DISPATCH_HEAD = 'if [ "${TASK_SOURCE:-github}" = "folder" ]; then'
  const DISPATCH = (() => {
    const from = LOOP.indexOf(DISPATCH_HEAD)
    const to = LOOP.indexOf('\nfi\n', from)
    return from === -1 || to === -1 ? null : LOOP.slice(from, to + 3)
  })()

  it('lifted the loop’s real dispatch, so the rows below cannot measure stale bash', () => {
    // The guard on the extraction itself. A template that moved or rewrote this block
    // leaves `DISPATCH` null or short, and every row below would silently start measuring
    // nothing — the failure mode a test that reads another file has to rule out first.
    expect(DISPATCH).toContain(DISPATCH_HEAD)
    expect(DISPATCH).toContain('elif [ "${TASK_SOURCE:-github}" = "jira" ]; then')
    expect(DISPATCH).toContain('TASK_SOURCE="github"')
    expect(DISPATCH.trimEnd().endsWith('fi')).toBe(true)
  })

  // bash's answer for a whole FILE, with an optional ambient value exported into the shell
  // that sources it. Returns the value (or «unset»), bash's stderr — a `command not found`
  // line is how the shell reports that it ran part of a config file as a COMMAND — and the
  // loop's resolved task source when `dispatch` is asked for.
  async function sourceFile(config, name, { ambient, dispatch = false } = {}) {
    // A dispatch row that could not find the loop's block must THROW, not quietly measure a
    // bare `set -a; . file`: several rows below would still pass against that, because the
    // sourced value and the loop's answer coincide whenever the config assigns a real source.
    if (dispatch && !DISPATCH) throw new Error('templates/ralph.sh: task-source dispatch not found')
    seq += 1
    const path = join(TMP, `config-${seq}.sh`)
    writeFileSync(path, config)
    const probe = `printf 'V<<%s>>' "\${${name}-${UNSET}}"`
    const script = `set -a; . '${path}'; set +a; ${dispatch ? `${DISPATCH}\n` : ''}${probe}`
    const run = await execa('bash', ['-c', script], {
      env: ambient === undefined ? {} : { [name]: ambient },
      reject: false,
    })
    return {
      value: run.stdout.match(/V<<([\s\S]*)>>/)?.[1] ?? null,
      stderr: run.stderr.trim(),
    }
  }

  // The presence shape — `configAssignsVar(...)` decides, and only an ABSENT assignment reaches
  // the ambient value. Written out here so the comparison below is against a shape a caller uses
  // rather than against `parseConfigVar` alone. #118 (RALPH_AGENT) and #120 (GH_REPO) landed it for
  // two knobs as `... : null` and then `??`, which is why it is spelled that way here; #149 folded
  // it into one closure, `sourcedValue` at lib/commands/start.js:263, and pointed EVERY knob of
  // `ralph start`'s box at it — RALPH_AGENT (:333), GH_REPO (:1187), RALPH_CODEX_MODEL,
  // RALPH_CONTEXT_WINDOW and TASK_SOURCE (:463).
  //
  // TASK_SOURCE — which is the knob the rows below are written on — keeps NEITHER a precedence nor a
  // reader of its own. The #149 review took the second one away: `sourcedValue` is single-arity, so
  // this knob reads `parseConfigVar(configText, 'TASK_SOURCE')` like every other, and the reader that
  // once looked separate never was — `parseConfigSource` in lib/read-config-source.js is that call
  // verbatim, with nothing added. The `||` that
  // used to be spelled here is still live in three other commands (cycle.js:190, status.js:379,
  // doctor.js:160), and `||` reaches past a BLANK config value where the presence test keeps it, so
  // the two shapes are not interchangeable in general — the blank row is measured through both in
  // parse-config-var.boundary.qa.test.js ("a blanked TASK_SOURCE parts the two shapes") and driven
  // through the whole command in lib/commands/start.precedence.qa.test.js ("masks the environment
  // for a blanked TASK_SOURCE, and the PREFLIGHT follows the row"). No row below carries a blank
  // config value, so on these rows the two shapes agree — and rather than assert that in prose, the
  // test asserts BOTH, which is what lets its title say `ralph start`.
  const jsResolve = (config, name, ambient) =>
    (configAssignsVar(config, name) ? parseConfigVar(config, name) : null) ?? ambient ?? UNSET
  // What `sourcedValue('TASK_SOURCE')` at start.js:463 evaluates to — deliberately spelled through
  // `parseConfigSource` rather than `parseConfigVar`, so that this stays a TRIPWIRE: the two readers
  // are the same call today, and if anyone gives `parseConfigSource` a grammar of its own the rows
  // below go red in the file whose whole subject is that there is one grammar.
  const startResolve = (config, ambient) =>
    configAssignsVar(config, 'TASK_SOURCE') ? parseConfigSource(config) : ambient

  it.each([
    ['a plain assignment — the control row', 'TASK_SOURCE=folder', 'folder'],
    ['an indent before the name', '   TASK_SOURCE=folder', 'folder'],
    ['padding after the value', 'TASK_SOURCE=folder   ', 'folder'],
    ['an export prefix', 'export TASK_SOURCE=folder', 'folder'],
    // The spelling #147 is about. bash runs a command named TASK_SOURCE and the ambient
    // value survives untouched; the JS layer used to answer `folder` and mask it.
    ['a space before the =', 'TASK_SOURCE = folder', 'github'],
    ['a space before the =, none after', 'TASK_SOURCE =folder', 'github'],
    ['a tab before the =', 'TASK_SOURCE\t=folder', 'github'],
    // `export` fails differently and assigns just as little: the argument `=` is not a
    // valid identifier, so the builtin refuses the whole line.
    ['an export prefix and a space before the =', 'export TASK_SOURCE = folder', 'github'],
    // A quoted value does not rescue it — the space is what ends the name.
    ['a space before the = and a quoted value', 'TASK_SOURCE = "folder"', 'github'],
  ])('%s: bash and `ralph start` both hold %o', async (_label, line, expected) => {
    // The property, over both halves at once: for one config and one ambient value, the
    // shell that sources the file and the JS that parses it must be holding the same
    // string. `github` in the expected column is the ambient value below, not a default —
    // these rows are about a config line MASKING it or not.
    const config = `${line}\n`
    const bash = await sourceFile(config, 'TASK_SOURCE', { ambient: 'github' })
    expect(bash.value, line).toBe(expected)
    expect(jsResolve(config, 'TASK_SOURCE', 'github'), line).toBe(expected)
    // ...and through the reader `ralph start` really uses for THIS knob, so the title is a
    // measurement rather than a claim about a shape these rows do not go through. The two
    // agree here because no row blanks the knob; the row that parts them is elsewhere, named
    // in the note above `jsResolve`.
    expect(startResolve(config, 'github'), line).toBe(expected)
  })

  it('records the stderr bash emits for the refused spellings', async () => {
    // The measurement the fix rests on, kept as an assertion rather than only as a comment
    // in lib/parse-config-var.js: bash does not merely ignore these lines, it RUNS them,
    // and says so. A future shell that started assigning them would break this row first.
    const spaced = await sourceFile('TASK_SOURCE = folder\n', 'TASK_SOURCE', { ambient: 'github' })
    expect(spaced.stderr).toContain('TASK_SOURCE: command not found')
    expect(spaced.value).toBe('github')
    const exported = await sourceFile('export TASK_SOURCE = folder\n', 'TASK_SOURCE')
    expect(exported.stderr).toContain('not a valid identifier')
    expect(exported.value).toBe(UNSET)
    // ...and the control: the spelling bash accepts costs no stderr at all.
    const plain = await sourceFile('TASK_SOURCE=folder\n', 'TASK_SOURCE', { ambient: 'github' })
    expect(plain.stderr).toBe('')
    expect(plain.value).toBe('folder')
  })

  it('a spaced line does not beat a live assignment above it, in either reader', async () => {
    // Two live-looking lines, one of which is not an assignment. bash keeps the first;
    // the parser used to take the second because "the last line that matched" was the
    // rule and the spaced line matched.
    const config = 'TASK_SOURCE=github\nTASK_SOURCE = folder\n'
    const bash = await sourceFile(config, 'TASK_SOURCE')
    expect(bash.stderr).toContain('TASK_SOURCE: command not found')
    expect(bash.value).toBe('github')
    expect(parseConfigVar(config, 'TASK_SOURCE')).toBe('github')
  })

  it('a bare `=` blanks an earlier assignment, in both readers', async () => {
    // Criterion 2. `configAssignsVar` always said PRESENT here — it is the case #118 added
    // it for — while `parseConfigVar` matched no value and left the earlier line standing,
    // so the pair disagreed and the caller got "present, and set to the earlier value".
    const config = 'GH_REPO=committed/repo\nGH_REPO=\n'
    const bash = await sourceFile(config, 'GH_REPO', { ambient: 'ambient/repo' })
    expect(bash.stderr).toBe('')
    expect(bash.value).toBe('')
    expect(configAssignsVar(config, 'GH_REPO')).toBe(true)
    expect(parseConfigVar(config, 'GH_REPO')).toBe('')
    expect(jsResolve(config, 'GH_REPO', 'ambient/repo')).toBe('')
    // Every spelling of a blank tail bash treats the same way, measured the same way.
    for (const blank of ['GH_REPO=', 'export GH_REPO=', 'GH_REPO=   ', 'GH_REPO= # not any more']) {
      const text = `GH_REPO=committed/repo\n${blank}\n`
      const each = await sourceFile(text, 'GH_REPO', { ambient: 'ambient/repo' })
      expect(each.value, blank).toBe('')
      expect(parseConfigVar(text, 'GH_REPO'), blank).toBe('')
      expect(configAssignsVar(text, 'GH_REPO'), blank).toBe(true)
    }
  })

  it('`TASK_SOURCE = folder` resolves to the same source in the loop and in `ralph start`', async () => {
    // CRITERION 5, and the reason #147 was worth a slice of its own rather than a note in
    // the divergence table: this line is not a banner or a label, it is which QUEUE a run
    // reads. Before, the loop resolved `github` and `ralph start` announced `folder` — the
    // command printed one queue's name and the process it launched read the other's.
    //
    // Both halves are the shipped code: bash's is templates/ralph.sh's own dispatch block,
    // lifted above; the JS half is `resolveSource` over `parseConfigSource`, which is what
    // `ralph cycle`, `ralph status` and `ralph doctor` call for this knob — and
    // lib/read-config-source.js defines `parseConfigSource` as `parseConfigVar(text,
    // 'TASK_SOURCE')` verbatim, so it is the same reader the spellings below are about.
    // `ralph start` reaches that reader by another route since #149 and no longer imports
    // `parseConfigSource` at all: `resolveSource` there (lib/commands/start.js:443) is handed
    // `sourcedValue('TASK_SOURCE')` (:463), the closure at :263 that asks
    // `configAssignsVar(configText, name) ? parseConfigVar(configText, name) : processEnv[name]`.
    // The grammar under both is this module's, which is why one table covers all four commands;
    // where the two routes DO part is an assignment bash blanks, and that is pinned in
    // lib/commands/start.sourced-value.qa.test.js rather than here.
    for (const [line, expected] of [
      ['TASK_SOURCE = folder', 'github'],
      ['TASK_SOURCE =folder', 'github'],
      ['export TASK_SOURCE = folder', 'github'],
      // The spellings that always agreed, so the row above reads as a fix and not as a
      // blanket refusal of the knob.
      ['TASK_SOURCE=folder', 'folder'],
      ['export TASK_SOURCE="folder"', 'folder'],
      ['   TASK_SOURCE=folder   ', 'folder'],
      ['TASK_SOURCE=folder # local tasks', 'folder'],
    ]) {
      const config = `${line}\n`
      const loop = await sourceFile(config, 'TASK_SOURCE', { dispatch: true })
      expect(loop.value, line).toBe(expected)
      expect(resolveSource({ TASK_SOURCE: parseConfigSource(config) }), line).toBe(expected)
    }
  })

  it('reads NOTHING off a line whose assignment bash throws away, and says so on both readers', async () => {
    // THE SCOPE LINE, MOVED — measured rather than argued, and it now runs the other way. A space
    // after the `=` is a DIFFERENT bash rule from a space before it: `X= folder` parses fine,
    // assigns nothing, and runs `folder` as a command with `X` empty in its environment only — so
    // the sourcing shell is left with whatever it already held, exactly as for `X = folder`. This
    // used to be pinned as a divergence in the table above (the parser read `folder` off it); the
    // #149 review made both readers model bash's word rule instead, because the presence half of
    // the pair had turned the wart into a defect: `configAssignsVar` saying PRESENT about a line
    // bash ignores is what MASKS the environment the loop actually reads.
    const after = await sourceFile('TASK_SOURCE=github\nTASK_SOURCE= folder\n', 'TASK_SOURCE')
    expect(after.stderr).toContain('folder: command not found')
    expect(after.value).toBe('github')
    // So the earlier live line stands here as well, which is the property that matters: the line is
    // SKIPPED rather than read as a blank, so it neither becomes the answer nor displaces one.
    expect(parseConfigVar('TASK_SOURCE=github\nTASK_SOURCE= folder\n', 'TASK_SOURCE')).toBe('github')
    expect(parseConfigVar('TASK_SOURCE= folder\n', 'TASK_SOURCE')).toBe('')
    expect(configAssignsVar('TASK_SOURCE= folder\n', 'TASK_SOURCE')).toBe(false)
    // And the same rule with no space after the `=` at all — one family, one answer, which is why
    // fixing half of it was the wrong shape.
    const word = await sourceFile('TASK_SOURCE=fol der\n', 'TASK_SOURCE')
    expect(word.stderr).toContain('der: command not found')
    expect(word.value).toBe(UNSET)
    expect(parseConfigVar('TASK_SOURCE=fol der\n', 'TASK_SOURCE')).toBe('')
    expect(configAssignsVar('TASK_SOURCE=fol der\n', 'TASK_SOURCE')).toBe(false)
    const two = await sourceFile('TASK_SOURCE=a b\n', 'TASK_SOURCE')
    expect(two.stderr).toContain('b: command not found')
    expect(two.value).toBe(UNSET)
    expect(parseConfigVar('TASK_SOURCE=a b\n', 'TASK_SOURCE')).toBe('')
    expect(configAssignsVar('TASK_SOURCE=a b\n', 'TASK_SOURCE')).toBe(false)
    // `export` changes the answer for the first of those, which is why the two are not one
    // row: `export X= folder` is the builtin given `X=` and `folder`, so it DOES assign —
    // the empty string — and the parser's `folder` is wrong about that line in the other
    // direction. Measured, not reasoned.
    const exported = await sourceFile('export TASK_SOURCE= folder\n', 'TASK_SOURCE')
    expect(exported.stderr).toBe('')
    expect(exported.value).toBe('')
    expect(parseConfigVar('export TASK_SOURCE= folder\n', 'TASK_SOURCE')).toBe('folder')
    expect(configAssignsVar('export TASK_SOURCE= folder\n', 'TASK_SOURCE')).toBe(true)
    // Which is why the refusal is scoped to a BARE `NAME=`, and this is the boundary a later
    // "simplify the scan" commit is most likely to break: `export` really does assign, so a
    // present-and-blank verdict is the RIGHT one here even though the line looks like the ones
    // above. Measured on both spellings.
    const exportedBlank = await sourceFile('export TASK_SOURCE= ""\n', 'TASK_SOURCE')
    expect(exportedBlank.stderr).toContain('not a valid identifier')
    expect(exportedBlank.value).toBe('')
    expect(parseConfigVar('export TASK_SOURCE= ""\n', 'TASK_SOURCE')).toBe('')
    expect(configAssignsVar('export TASK_SOURCE= ""\n', 'TASK_SOURCE')).toBe(true)
    // ...and a tail that is only whitespace, or only a comment, is a blank assignment in
    // both — the shapes the template's own "comment the value out" edit produces.
    for (const line of ['TASK_SOURCE=   ', 'TASK_SOURCE= # decide later']) {
      const blank = await sourceFile(`${line}\n`, 'TASK_SOURCE')
      expect(blank.stderr, line).toBe('')
      expect(blank.value, line).toBe('')
      expect(parseConfigVar(`${line}\n`, 'TASK_SOURCE'), line).toBe('')
      expect(configAssignsVar(`${line}\n`, 'TASK_SOURCE'), line).toBe(true)
    }
  })
})
