import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execa } from 'execa'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConfigVar, configAssignsVar } from './parse-config-var.js'
import { parseConfigSource } from './read-config-source.js'
import { resolveSource } from './task-source.js'

// ---------------------------------------------------------------------------
// QA augmentation for #147, which changed two tokens in one shared grammar:
// `assignmentHead` stopped allowing whitespace in front of the `=`, and
// `parseConfigVar`'s value group went `(.+?)` to `([^\n]*?)` so a bare `VAR=` matches
// with an empty tail. parse-config-var.qa.test.js measures the two spellings the slice
// was FILED for. This file attacks the edges either token opens up and nothing in the
// slice had to look at:
//
//   - the `=` BOUNDARY as a boundary, not as one spelling: `X==v`, `X+=v`, `=v`, a
//     name with no `=` at all, a tab on each side of it, and the prefix guard the head
//     now carries without a `\s*` to hide behind.
//   - EVERY spelling of a blank tail at once, on the claim the fix rests on — that all
//     of them read as '' and all of them read as PRESENT, so "the last uncommented
//     assignment wins" holds however the last one was emptied.
//   - the #118 pair as an INVARIANT over shapes rather than a row per shape: presence
//     decides whether the last line overrides, so the two functions cannot disagree
//     about which line is last. Measured against the pre-#147 module, that sweep goes
//     red on exactly 2 of its 24 shapes (`X=` and `export X=`) — it is the defect, not
//     a restatement of it.
//   - a line terminator at the END of a value, which `trimPadding`'s trailing class
//     decides and #133 only asked about the MIDDLE of a value.
//
// Every claim about bash below is measured by SOURCING A REAL FILE the way
// templates/ralph.sh does (`set -a; . ./ralph.config.sh; set +a`), because half these
// shapes are about what the sourcing shell is LEFT HOLDING: a line bash runs as a
// command leaves an exported value alone, and a blank assignment overwrites it. Only
// the file route can tell those apart.
//
// Nothing here writes to the repo: one throwaway directory under the OS temp dir,
// removed after (#41). Control characters are built from their code points, never
// typed (#107).
// ---------------------------------------------------------------------------

const UNSET = '«unset»'
const TAB = String.fromCharCode(0x09)
const CR = String.fromCharCode(0x0d)
const VT = String.fromCharCode(0x0b)
const FF = String.fromCharCode(0x0c)
const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)
const NBSP = String.fromCharCode(0xa0)
const BOM = String.fromCharCode(0xfeff)

let TMP = null
let seq = 0
beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'ralph-147-boundary-qa-'))
})
afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true })
})

// What `. ralph.config.sh` leaves in NAME, with an optional ambient value exported into
// the shell that sources the file. Returns the value (or «unset») and bash's first line
// of stderr — a `command not found` there is the shell reporting that it RAN part of a
// config file, which is the whole difference between "assigned nothing" and "assigned
// the empty string".
async function sourceFile(config, name, { ambient } = {}) {
  seq += 1
  const path = join(TMP, `config-${seq}.sh`)
  writeFileSync(path, config)
  const probe = `printf 'V<<%s>>' "\${${name}-${UNSET}}"`
  const run = await execa('bash', ['-c', `set -a; . '${path}'; set +a; ${probe}`], {
    env: ambient === undefined ? {} : { [name]: ambient },
    reject: false,
  })
  return {
    value: run.stdout.match(/V<<([\s\S]*)>>/)?.[1] ?? null,
    stderr: run.stderr.trim().split('\n')[0] ?? '',
  }
}

// The presence shape — `configAssignsVar(...)` decides, and only an ABSENT assignment reaches the
// ambient value. Spelled as `... : null` and then `??` because that is how #118 (RALPH_AGENT) and
// #120 (GH_REPO) landed it; since #149 the command spells it as one closure, `sourcedValue` at
// lib/commands/start.js:263, and EVERY knob of the box reads through it — RALPH_AGENT (:333),
// GH_REPO (:1187), RALPH_CODEX_MODEL, RALPH_CONTEXT_WINDOW and TASK_SOURCE (:463). Compared against
// `sourceFile` this is the property that matters: one config, one ambient value, two programs
// holding the same string.
//
// AND TASK_SOURCE HAS NO READER OF ITS OWN, which matters because most rows below are written on
// TASK_SOURCE (it is the knob whose two answers are two different QUEUES). `parseConfigSource` in
// lib/read-config-source.js looked like one and is `parseConfigVar(text, 'TASK_SOURCE')` verbatim,
// which is why the #149 review dropped `sourcedValue`'s per-site argument: this knob now reaches the
// shared grammar through the same one call as the other four, rather than through a `||`. The `||` is
// still live in three other commands (cycle.js:190, status.js:384, doctor.js:160), and it reaches
// PAST a blank where the presence test keeps it.
// On every row here the config value is non-blank, so the two
// shapes agree and this one models them both; the one shape where they part is a blanked assignment,
// and that is asserted through the real reader below ("a blanked TASK_SOURCE parts the two shapes")
// rather than left to be inferred. lib/commands/start.js:212-264 states the one rule and carries the
// measured bash transcript behind it, and lib/commands/start.precedence.qa.test.js drives a blanked
// file through the command ("masks the environment for a blanked TASK_SOURCE, and the PREFLIGHT
// follows the row").
const jsResolve = (config, name, ambient) =>
  (configAssignsVar(config, name) ? parseConfigVar(config, name) : null) ?? ambient ?? UNSET

// ---------------------------------------------------------------------------
// The `=` as a boundary.
// ---------------------------------------------------------------------------

describe('parseConfigVar — what ends the NAME, measured against a real bash (#147 QA)', () => {
  const AMBIENT = 'ambient'

  it.each([
    // `==` is the row that says the head consumes ONE `=` and hands the rest to the value:
    // bash's name ends at the first `=` too, so the second one is data.
    ['a doubled equals', 'X==v', '=v'],
    ['a doubled equals, quoted tail', 'X="=v"', '=v'],
    // A tab is a blank to bash's word splitter, so it ends the name exactly as a space
    // does — and the head, having no `\s*` left in front of the `=`, refuses it. Before
    // #147 this read `v` while the sourcing shell ran a command called X.
    ['a tab before the =', `X${TAB}=v`, AMBIENT],
    ['a tab on both sides of the =', `X ${TAB}=${TAB} v`, AMBIENT],
    // No name at all, and no `=` at all: neither is an assignment in either reader.
    ['a bare = with no name', '=v', AMBIENT],
    ['a name with no = at all', 'X', AMBIENT],
    ['a name whose = is on the NEXT line', `X${'\n'}=v`, AMBIENT],
    // The prefix guard, which used to be enforced by `\s*=` and is now enforced by the
    // `=` alone. Both directions, because the head is anchored at the start only.
    ['a name the target is a prefix of', 'XY=v', AMBIENT],
    ['a name the target is a prefix of, underscored', 'X_=v', AMBIENT],
    ['a name that ENDS with the target', 'YX=v', AMBIENT],
  ])('%s: bash and the presence-then-`??` shape both hold %o', async (_label, line, expected) => {
    const config = `${line}\n`
    const bash = await sourceFile(config, 'X', { ambient: AMBIENT })
    expect(bash.value, line).toBe(expected)
    expect(jsResolve(config, 'X', AMBIENT), line).toBe(expected)
  })

  it('the prefix guard holds on the real knob names, in both directions', async () => {
    // RALPH_AGENT and RALPH_AGENTX are the pair the head's comment names, and the guard
    // is worth asserting on the actual strings rather than on `X`: `escapeName` is
    // between the caller and the regex, and a name that is a prefix of another is the one
    // way a shared grammar can answer about the wrong knob.
    const longer = 'RALPH_AGENTX=codex\n'
    expect(configAssignsVar(longer, 'RALPH_AGENT')).toBe(false)
    expect(parseConfigVar(longer, 'RALPH_AGENT')).toBe('')
    expect(parseConfigVar(longer, 'RALPH_AGENTX')).toBe('codex')
    const shorter = 'RALPH_AGENT=claude\n'
    expect(configAssignsVar(shorter, 'RALPH_AGENTX')).toBe(false)
    expect(parseConfigVar(shorter, 'RALPH_AGENTX')).toBe('')
    // ...and the two names in one file answer independently, which is what a caller
    // reading both out of one text depends on.
    const both = 'RALPH_AGENT=claude\nRALPH_AGENTX=codex\n'
    expect(parseConfigVar(both, 'RALPH_AGENT')).toBe('claude')
    expect(parseConfigVar(both, 'RALPH_AGENTX')).toBe('codex')
    const bash = await sourceFile(both, 'RALPH_AGENT')
    expect(bash.value).toBe('claude')
  })

  it.each([
    // `+=` APPENDS in bash, and this parser has never modelled it — the head wants a `=`
    // where the `+` is, so the line is not an assignment here at all. Unchanged by #147:
    // `\s*=` did not match a `+` either. The direction is the safe one — the parser
    // under-reports, so a reader falls through to the environment rather than inventing a
    // value — but it IS a divergence, and it is the only one where bash's answer depends
    // on what the environment already held.
    ['an appending assignment', 'X+=v', `${'ambient'}v`, 'ambient'],
    // ...and the same operator with the base value in the file, where bash's answer
    // depends on nothing ambient at all and the parser still reads only the first line.
    ['an append after a plain assignment', `X=a${'\n'}X+=b`, 'ab', 'a'],
    // A prefix a config author might reach for out of habit. bash treats both as
    // assignments; the head requires the name to start the line (after blanks) or to
    // follow exactly one `export`.
    ['a declare prefix', 'declare X=v', 'v', 'ambient'],
    ['a doubled export prefix', 'export export X=v', 'v', 'ambient'],
  ])(
    '%s: bash says %o, the presence-then-`??` shape says %o — pinned divergence',
    async (_label, line, bashSays, jsSays) => {
      // NOT a bug report, a boundary marker — and the reason each of these is tolerable is
      // the same in all four: the JS reader answers "the file did not set this", which
      // sends it to the process environment, which is where bash's own answer for the
      // append rows came from anyway. What no row here does is the failure #147 was filed
      // for, which is the JS layer naming a value the loop will never hold.
      const config = `${line}\n`
      expect((await sourceFile(config, 'X', { ambient: 'ambient' })).value, line).toBe(bashSays)
      expect(jsResolve(config, 'X', 'ambient'), line).toBe(jsSays)
    },
  )
})

// ---------------------------------------------------------------------------
// Every spelling of a blank tail.
// ---------------------------------------------------------------------------

describe('parseConfigVar — every spelling of a blank tail agrees (#147 QA)', () => {
  // The claim the `*?` half of #147 rests on: a config author has half a dozen ways to
  // empty a knob, bash reads all of them as "assigned, and empty", and the JS pair has to
  // read all of them the same way — as '' from `parseConfigVar` and as PRESENT from
  // `configAssignsVar`, because those two answers together are what masks an exported
  // value. Before #147 the bare spellings read as '' for the wrong reason (no match at
  // all), which is why they lost to a live line above them.
  const BLANKS = [
    ['nothing at all', 'X='],
    ['two spaces', 'X=  '],
    ['a tab', `X=${TAB}`],
    ['empty double quotes', 'X=""'],
    ['empty single quotes', "X=''"],
    ['a comment', 'X= # off for now'],
    ['a comment with no space', 'X=#off'],
    ['empty quotes and a comment', 'X="" # off for now'],
    ['an export prefix', 'export X='],
    ['an indent and an export prefix', `  export X=${TAB}`],
  ]

  it.each(BLANKS)('%s: reads as blank AND as present', (_label, line) => {
    const config = `${line}\n`
    expect(parseConfigVar(config, 'X'), line).toBe('')
    expect(configAssignsVar(config, 'X'), line).toBe(true)
    // Present-and-blank is the one combination that OVERWRITES an exported value, which
    // is the whole reason `configAssignsVar` exists (#118).
    expect(jsResolve(config, 'X', 'ambient'), line).toBe('')
  })

  it.each(BLANKS)('%s: blanks a live assignment above it, and bash agrees', async (_label, line) => {
    // "The last uncommented assignment wins" over the spellings that empty it. The two
    // rows this used to fail on are the two with no character in the tail at all — `X=`
    // and `export X=` — where the value group required one, matched nothing, and left the
    // live line standing. `X=#off` is the counterpart that always worked, because the
    // comment gave the group something to match before the strip removed it.
    const config = `X=live\n${line}\n`
    const bash = await sourceFile(config, 'X', { ambient: 'ambient' })
    // Two of these lines bash reads as data rather than as a comment — a `#` opens a
    // comment only at the start of a WORD — so their bash column is the #62 divergence
    // and not a blank. Asserted rather than skipped, so the table says which is which.
    const bashBlank = line === 'X=#off' ? '#off' : ''
    expect(bash.value, line).toBe(bashBlank)
    expect(bash.stderr, line).toBe('')
    expect(parseConfigVar(config, 'X'), line).toBe('')
    expect(configAssignsVar(config, 'X'), line).toBe(true)
  })

  it.each([
    ['a space then empty double quotes', 'X= ""'],
    ['padding around empty quotes', 'X=  ""  '],
    ["a space then empty single quotes", "X= ''"],
  ])('%s: bash assigns nothing, and this parser no longer claims it did', async (_label, line) => {
    // THE SPELLING THAT LOOKS LIKE THE ROWS ABOVE AND IS NOT, which is why it is measured
    // rather than assumed: a space after the `=` puts this line in the whitespace-AFTER-the-`=`
    // family, so bash reads `X=` as an environment prefix and `""` as the COMMAND to run it on.
    // The command is the empty word, the shell says so, and X is never assigned in the sourcing
    // shell at all.
    //
    // #147 LEFT THAT FAMILY ALONE, THE FIRST #149 REVIEW REFUSED HALF OF IT, AND THE THIRD REFUSED
    // THE FAMILY. The half-way state is worth naming because two review rounds each found the same
    // defect one spelling over — `X= ""`, then `X=#c off` — which is what a rule drawn around
    // spellings does. The refusal now models bash's own word rule (`endOfWord` in
    // lib/parse-config-var.js), so `X= folder` is refused too, and NOTHING THIS REPO SHIPS depended
    // on the looser reading: templates/ralph.config.sh writes `RALPH_DIGEST_INTERVAL=""`, and no
    // rendered template has an unquoted blank after an `=` followed by a word (checked over the
    // template directory in lib/commands/start.sourced-value.qa.test.js's closing test). What did
    // depend on it was one pinned expectation, `RALPH_DIGEST_INTERVAL=  2h  `, flipped with the
    // reason written on it in lib/commands/start.digest-window.qa.test.js.
    //
    // The two directions the family had, kept apart because the costs are not equal. Reading a VALUE
    // off such a line INVENTS an answer, and a `||` caller was equally wrong about it. Reading
    // NOTHING off one DESTROYS the right answer: `configAssignsVar` called it PRESENT, and
    // present-and-blank is the combination that masks an exported value — which became a real defect
    // once #149 pointed every knob of `ralph start`'s box at that verdict. `envPrefixedNothing` in
    // lib/parse-config-var.js is the refusal, built from the same name as `assignmentHead` so both
    // readers still answer off one grammar.
    const alone = `${line}\n`
    const bash = await sourceFile(alone, 'X', { ambient: 'ambient' })
    expect(bash.stderr, line).toContain('command not found')
    expect(bash.value, line).toBe('ambient')
    // ...and this is now the same answer, on both readers: no assignment, so nothing to report,
    // so the caller's precedence reaches the ambient value the shell kept.
    expect(configAssignsVar(alone, 'X'), line).toBe(false)
    expect(parseConfigVar(alone, 'X'), line).toBe('')
    expect(jsResolve(alone, 'X', 'ambient'), line).toBe('ambient')
    // And it no longer clears a LIVE line above it — the sharpest instance of the divergence, and
    // the one that needed no environment at all to bite: bash keeps that line standing, and the
    // parser now agrees, which is what makes `X=live` still the answer for the whole file.
    const after = `X=live\n${line}\n`
    expect((await sourceFile(after, 'X', { ambient: 'ambient' })).value, line).toBe('live')
    expect(parseConfigVar(after, 'X'), line).toBe('live')
    // The file DOES assign X, on that first line — so the refusal above is about one line rather
    // than about the name, which is the distinction a `some()` over the wrong predicate would lose.
    expect(configAssignsVar(after, 'X'), line).toBe(true)
  })

  it('a blank tail and a SPACED line settle each other, in both directions', async () => {
    // The two tokens #147 changed, in one file, pulling opposite ways: one line is an
    // assignment of nothing, the other is not an assignment at all. Whichever order they
    // are written in, the answer is the blank — the spaced line can neither win nor
    // restore what the blank one cleared — and bash says the same.
    for (const config of ['X=\nX = live\n', 'X = live\nX=\n', 'X=first\nX=\nX = live\n']) {
      const bash = await sourceFile(config, 'X', { ambient: 'ambient' })
      expect(bash.value, JSON.stringify(config)).toBe('')
      expect(bash.stderr, JSON.stringify(config)).toContain('X: command not found')
      expect(parseConfigVar(config, 'X'), JSON.stringify(config)).toBe('')
      expect(configAssignsVar(config, 'X'), JSON.stringify(config)).toBe(true)
    }
    // ...and with no blank line to fall back on, the spaced line leaves the file assigning
    // nothing, which is the case that falls through to the environment.
    expect(configAssignsVar('X = live\n', 'X')).toBe(false)
    expect(jsResolve('X = live\n', 'X', 'ambient')).toBe('ambient')
  })

  it('a blank tail on a CRLF line is still blank, and the \\r is still the ending', async () => {
    // What makes this work with nothing in front of the `\r` is NOT the padding: the value
    // group's padding is `[ \t]*` since the #147 follow-up, which cannot match a `\r`, so the
    // group keeps it (`'X=\r'.match(assign)[1]` is `'\r'`, measured) and `trimPadding`'s
    // trailing class — which names CR, U+2028 and U+2029 for exactly this reason — removes it.
    // So the widening from `+?` to `*?` did not hand a control character to a caller.
    const config = `X=live${CR}\nX=${CR}\n`
    expect(parseConfigVar(config, 'X')).toBe('')
    expect(configAssignsVar(config, 'X')).toBe(true)
    // bash has no CRLF rule at all — it reads the `\r` as the value — so this row is the
    // repo's own line-ending policy rather than a bash divergence, and it is the policy
    // every other CRLF assertion in this module states (#565, #133).
    expect((await sourceFile(config, 'X')).value).toBe(CR)
  })

  it('a blanked TASK_SOURCE parts the two shapes — presence keeps it, a `||` reaches past', async () => {
    // WHERE THE TWO SHAPES PART, asserted rather than left to the reader of the note at the top of
    // this file. Every other row here carries a non-blank config value, on which presence and `||`
    // cannot disagree; a blanked assignment is exactly the shape on which they do, and it lands on
    // TASK_SOURCE, which is the knob most of this file is written on.
    //
    // Three answers to one config, and they are not two: bash assigns the blank (`set -a` exports
    // it), so templates/ralph.sh's `[ "${TASK_SOURCE:-github}" = "folder" ]` falls through to
    // GITHUB; `jsResolve` keeps the blank and agrees; a `||` reaches past the blank to the exported
    // `folder` and announces FOLDER for a loop reading GitHub issues. That is the criterion-2 shape
    // of #147 one module later than this grammar.
    //
    // `ralph start` USED TO BE the third answer here, on `parseConfigSource(configText) ||
    // processEnv.TASK_SOURCE`; #149 pointed it at the presence test, so it now lands with bash and
    // with `jsResolve`. The `||` row below is still shipped code — cycle.js:190, status.js:384 and
    // doctor.js:160 spell it — and doctor.js's own note is where that follow-up is recorded.
    //
    // NOT this grammar's defect either way: `parseConfigVar` and `parseConfigSource` both report the
    // blank correctly. Recorded here so this file's own model is honest about its edge.
    const config = 'TASK_SOURCE=\n'
    const bash = await sourceFile(config, 'TASK_SOURCE', { ambient: 'folder' })
    expect(bash.stderr).toBe('')
    expect(bash.value).toBe('')
    // The loop, off that blank.
    expect(resolveSource({ TASK_SOURCE: bash.value })).toBe('github')
    // The shape this file models: agrees.
    expect(jsResolve(config, 'TASK_SOURCE', 'folder')).toBe('')
    expect(resolveSource({ TASK_SOURCE: jsResolve(config, 'TASK_SOURCE', 'folder') })).toBe('github')
    // The shape `ralph cycle`, `ralph status` and `ralph doctor` still use: does not.
    expect(parseConfigSource(config)).toBe('')
    expect(resolveSource({ TASK_SOURCE: parseConfigSource(config) || 'folder' })).toBe('folder')
    // ...and `ralph start`, since #149, is on the side bash is on.
    expect(configAssignsVar(config, 'TASK_SOURCE')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The #118 pair, as an invariant rather than as a row per shape.
// ---------------------------------------------------------------------------

describe('parseConfigVar — the two readers cannot disagree about which line is LAST (#118 × #147)', () => {
  // The property, stated so it can go red for any shape and not only for the ones somebody
  // thought of: presence is what decides whether a trailing line OVERRIDES the one above
  // it. So for any line B, reading `X=first` then B must give B's own value when
  // `configAssignsVar` says B assigns something, and `first` when it says B does not.
  //
  // That is exactly the #147 defect written as one expression. Measured against the module
  // as it stood before this slice, the sweep below goes red on 2 of its 24 shapes — `X=`
  // and `export X=`, the two whose tail holds no character for a `+?` to match — and green
  // on the other 22, including `X=   ` and `X=` + `\r`, where the old `+?` backtracked into
  // the padding and matched after all. Which is why the fix is `*?` and not a trim.
  const SHAPES = [
    'X=v',
    'X=',
    'X=   ',
    `X=${TAB}`,
    `X=${CR}`,
    'X=""',
    "X=''",
    'X= # off',
    'X="" # off',
    'X=#off',
    'X="',
    'X= "" ',
    'X==v',
    'X+=v',
    '=v',
    'X',
    `X${TAB}=v`,
    'X = v',
    'X =v',
    'export X=',
    'export X = v',
    'XY=v',
    'X=a b',
    'X= v',
  ]

  it.each(SHAPES)('%o: presence decides whether it overrides the line above', (shape) => {
    const alone = `${shape}\n`
    const after = `X=first\n${shape}\n`
    const expected = configAssignsVar(alone, 'X') ? parseConfigVar(alone, 'X') : 'first'
    expect(parseConfigVar(after, 'X'), shape).toBe(expected)
  })

  it.each(SHAPES)('%o: a line that assigns nothing reads as nothing on its own', (shape) => {
    // The other half of the pair's contract, and the one a caller reads directly: anything
    // `configAssignsVar` says NO to must read as '' out of a file holding no other line, or
    // a caller taking the `null` branch and a caller taking the value branch would be
    // looking at two different files.
    const alone = `${shape}\n`
    if (!configAssignsVar(alone, 'X')) expect(parseConfigVar(alone, 'X'), shape).toBe('')
  })
})

// ---------------------------------------------------------------------------
// A line terminator at the END of a value.
// ---------------------------------------------------------------------------

describe('parseConfigVar — a line terminator at the END of a value (#133 × #147)', () => {
  // #133 widened the value class to `[^\n]` and asked about a terminator in the MIDDLE of a
  // value. #147 changed the quantifier that reaches the other position — so these rows say the
  // change did not move the trailing case either way. All six are divergences from bash, all
  // six predate #147, and all six are the same one rule: the terminator lands INSIDE the value
  // group (the padding is `[ \t]*` and cannot match one, so the group is forced to keep it) and
  // `trimPadding`'s trailing class strips it, naming CR, U+2028 and U+2029 for precisely this
  // reason. See lib/parse-config-var.js's `trimPadding`, which is the canonical record of why
  // that class stays wider than bash's blanks.
  it.each([
    ['a trailing CR — the CRLF case', `X=a${CR}`, `a${CR}`, 'a'],
    ['a trailing CR after a quoted value', `X="a"${CR}`, `a${CR}`, 'a'],
    ['a trailing U+2028', `X=a${LS}`, `a${LS}`, 'a'],
    ['a trailing U+2029', `X=a${PS}`, `a${PS}`, 'a'],
    ['a value that is ONLY a CR', `X=${CR}`, CR, ''],
    ['a value that is ONLY a U+2028', `X=${LS}`, LS, ''],
  ])(
    '%s: bash keeps it, this parser strips it — pinned divergence',
    async (_label, line, bashSays, parserSays) => {
      // The CRLF rows are policy: a config edited on Windows must not hand a control
      // character to a printed line, which is what #565 pinned and what this module has
      // always done. The U+2028/U+2029 rows are the same code answering a case nobody
      // chose — the class that made them line terminators in a JS regex also makes them
      // `\s` — and they are pinned here because #133 pinned the middle of a value and left
      // the end of one unstated.
      const config = `${line}\n`
      expect((await sourceFile(config, 'X')).value, line).toBe(bashSays)
      expect(parseConfigVar(config, 'X'), line).toBe(parserSays)
      // Present either way, so a caller never reads "the file did not set this" for a line
      // the file plainly set.
      expect(configAssignsVar(config, 'X'), line).toBe(true)
    },
  )
})

// ---------------------------------------------------------------------------
// The unterminated quote, through the FILE route.
// ---------------------------------------------------------------------------

describe('parseConfigVar — an unterminated quote, sourced as a file (#62 × #147 QA)', () => {
  it('bash executes the lines BEFORE the offending one and abandons the rest', async () => {
    // parse-config-var.qa.test.js measures `X="` with `bash -c` and records that bash has
    // no answer at all for it. Through the route the loop actually uses — `.` on a file —
    // the answer is sharper and worth having: the shell reads and runs the file as it goes,
    // so an assignment ABOVE the unterminated quote has already happened when the parse
    // error stops the source, and one BELOW it never happens. Measured here rather than
    // reasoned about, because "bash refuses the whole file" would be the natural guess and
    // it is only half right.
    const before = await sourceFile('X=v\nX="\n', 'X', { ambient: 'ambient' })
    expect(before.stderr).toContain('unexpected EOF while looking for matching')
    expect(before.value).toBe('v')
    const after = await sourceFile('X="\nX=v\n', 'X', { ambient: 'ambient' })
    expect(after.stderr).toContain('unexpected EOF while looking for matching')
    expect(after.value).toBe('ambient')
    // This parser reads both files line by line and never abandons anything, so it answers
    // the lone quote for the first and `v` for the second. Neither is a value any knob read
    // through here accepts, so both reach the same fallback — which is the only property
    // the existing pin claims, and this row is what says the difference is confined to it.
    expect(parseConfigVar('X=v\nX="\n', 'X')).toBe('"')
    expect(parseConfigVar('X="\nX=v\n', 'X')).toBe('v')
    expect(resolveSource({ TASK_SOURCE: parseConfigSource('TASK_SOURCE=folder\nTASK_SOURCE="\n') })).toBe(
      'github',
    )
  })
})

// ---------------------------------------------------------------------------
// Which knobs the tightening could even be measured against.
// ---------------------------------------------------------------------------

describe('parseConfigVar — every knob read through it moved together (#147 QA)', () => {
  // The slice's argument for tightening is "the JS layer stops resolving a value the loop
  // never held". That argument has a premise — that the loop holds an answer of its own —
  // and the premise is true for only some of the knobs this parser is asked about. Which
  // ones is a property of templates/ralph.sh's TEXT, so it is swept rather than asserted
  // from memory, and it is swept over the file that SHIPS: a knob the loop starts reading
  // tomorrow moves from one list to the other and this test says so.
  //
  // Comment-only lines are stripped first, because every one of these names appears in the
  // template's prose and prose is not a read (#119).
  const LOOP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'ralph.sh'), 'utf8')
  const LOOP_CODE = LOOP.split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

  // Every name any module passes to `parseConfigVar` or `configAssignsVar`.
  const KNOBS = [
    'RALPH_AGENT',
    'TASK_SOURCE',
    'JIRA_JQL',
    'GH_REPO',
    'RALPH_BANNER',
    'RALPH_DIGEST_INTERVAL',
    'RALPH_DIGEST_MODEL',
  ]

  it('the loop names three of the seven, and that is the list the fix is free for', () => {
    // A guard on the sweep before it is used as evidence: an empty haystack would make
    // every name look JS-only and turn the claim below into its own opposite.
    expect(LOOP_CODE).toContain('TASK_SOURCE')
    expect(LOOP_CODE.length).toBeGreaterThan(1000)
    const named = KNOBS.filter((name) => LOOP_CODE.includes(name))
    expect(named).toEqual(['RALPH_AGENT', 'TASK_SOURCE', 'JIRA_JQL'])
    // GH_REPO is the fourth knob with a bash-side answer and it is NOT named here, which is
    // why it is in neither list by this sweep's own rules: it reaches `gh` through the
    // environment the loop exports with `set -a`, so the reader is the `gh` binary rather
    // than the template. lib/commands/start.identity-facts.qa.test.js is where that knob's
    // two answers are compared.
    expect(LOOP_CODE).not.toContain('GH_REPO')
    // ...and these three have no bash reader at all, so for them #147 is the ONLY reader
    // changing its mind rather than two readers agreeing. What that costs is measured at the
    // command in lib/commands/start.digest-window.qa.test.js ("a spaced interval assignment
    // now opens no window at all") and in the banner tables of start/doctor/status.
    for (const name of ['RALPH_BANNER', 'RALPH_DIGEST_INTERVAL', 'RALPH_DIGEST_MODEL']) {
      expect(LOOP_CODE, name).not.toContain(name)
    }
  })

  it.each(KNOBS)('%s: the spaced spelling is refused, whichever knob it is', (name) => {
    // One grammar, so one answer — the property `assignmentHead` is a shared function for.
    // Asserted per name because `escapeName` sits between the caller and the regex, and
    // because a future knob added to the list above gets this row for free.
    const spaced = `${name} = value\n`
    expect(configAssignsVar(spaced, name), name).toBe(false)
    expect(parseConfigVar(spaced, name), name).toBe('')
    const plain = `${name}=value\n`
    expect(configAssignsVar(plain, name), name).toBe(true)
    expect(parseConfigVar(plain, name), name).toBe('value')
    // ...and the blank tail, the other token #147 changed, on the same name.
    expect(parseConfigVar(`${name}=value\n${name}=\n`, name), name).toBe('')
    expect(configAssignsVar(`${name}=value\n${name}=\n`, name), name).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// WAS FAILING ON PURPOSE — see the comment in the test. The grammar was fixed in answer to
// it and this block is now the pin on the fix.
// ---------------------------------------------------------------------------

describe('parseConfigVar — the blanks skipped BEFORE the name (#147 follow-up)', () => {
  it('skips only the blanks bash skips, so no indent can mask an exported value', async () => {
    // THIS TEST WAS WRITTEN RED, AS THE #147 DEFECT SURVIVING ONE CHARACTER CLASS. The
    // grammar changed in answer to it — `assignmentHead` now spells the indent `^[ \t]*` and
    // the export separator `[ \t]+`, with the per-character transcripts recorded above it (`$IFS`
    // is the WRONG THING to derive the class from, shown one paragraph down — both of those IFS
    // rows reproduce exactly, they just do not bear on the answer, and the conclusion the
    // derivation reaches is right anyway) — so every row below now passes. The report of the
    // defect is kept verbatim, because it is the reasoning the fix rests on.
    //
    // #147's rule was stated three times in the new prose — lib/parse-config-var.js's header
    // ("an indent before the name and padding after the value — the whitespace bash
    // ignores"), read-config-agent.js's header, and the renamed tests in
    // read-config-agent.test.js / read-config-source.test.js ("the whitespace bash
    // ignores"). The grammar spelled that indent `^\s*`, and JS `\s` is a strict SUPERSET of
    // the blanks bash skips: the shell's own TOKENIZER skips space and tab there and nothing
    // else, while JS `\s` adds 22 more characters — U+000B, U+000C, U+000D, U+00A0, U+1680,
    // U+2000 through U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. Not `$IFS`,
    // which is the natural guess and is a different mechanism: IFS splits the RESULT of an
    // expansion into fields, and changing it moves neither answer here. Measured both ways —
    //
    //   $ printf '<U+00A0>TASK_SOURCE=folder\n' > c.sh
    //   $ TASK_SOURCE=github bash -c 'IFS=$(printf "\302\240"); set -a; . ./c.sh; set +a
    //       printf "[%s]" "$TASK_SOURCE"'
    //   ./c.sh: line 1: <U+00A0>TASK_SOURCE=folder: command not found
    //   [github]                          # U+00A0 IN IFS, and still not a blank at the head
    //
    //   $ printf '   TASK_SOURCE=folder\n' > d.sh
    //   $ TASK_SOURCE=github bash -c 'IFS=; set -a; . ./d.sh; set +a; printf "[%s]" "$TASK_SOURCE"'
    //   [folder]                          # IFS EMPTY, and a space indent still assigns
    //
    // — so the class to spell is the tokenizer's two blanks, and `$IFS` is neither evidence
    // for it nor able to widen it. So each row below is a line this parser reads as an
    // assignment and the shell that sources the same file runs as a COMMAND — which is
    // exactly the shape #147 fixed for `X = v`, on the same knob, with the same
    // consequence: `ralph start` names the file's value while the loop holds the
    // environment's.
    //
    // Measured, on TASK_SOURCE — the knob whose two answers are two different QUEUES:
    //
    //   $ printf '<U+00A0>TASK_SOURCE=folder\n' > c.sh        # U+00A0 as the indent
    //   $ TASK_SOURCE=github bash -c 'set -a; . ./c.sh; set +a; printf "[%s]\n" "$TASK_SOURCE"'
    //   ./c.sh: line 1: <U+00A0>TASK_SOURCE=folder: command not found
    //   [github]
    //   > resolveSource({ TASK_SOURCE: parseConfigSource(text) })   // 'folder'
    //
    //   $ printf 'export<U+00A0>TASK_SOURCE=folder\n' > c.sh   # U+00A0 after `export`
    //   ./c.sh: line 1: export<U+00A0>TASK_SOURCE=folder: command not found
    //   [github]                                             # and this parser says folder
    //
    //   $ printf '<U+FEFF>TASK_SOURCE=folder\n' > c.sh         # a UTF-8 BOM, first line
    //   ./c.sh: line 1: <U+FEFF>TASK_SOURCE=folder: command not found
    //   [github]                                             # and this parser says folder
    //
    // REACHABILITY, so the row is judged on what it costs rather than on how odd it looks.
    // The BOM row is the one a shipped workflow produces: this module already supports a
    // config edited on Windows (the CRLF rows in parse-config-var.qa.test.js and #565's
    // whole-file case), and a BOM is what a Windows editor adds to the file it rewrote the
    // endings of. It only reaches a knob when the BOM lands on a line the JS layer reads,
    // which the shipped template's leading comment absorbs — so the exposure is a
    // hand-written or hand-truncated config, not the generated one. U+00A0 has no such
    // limit: it can indent ANY line, and it arrives by pasting a config snippet out of
    // anything that renders HTML. U+000B, U+000C, U+2028 and U+2029 behave identically and
    // are pinned in the same table because they are the same class, not because anybody
    // types them.
    //
    // The fix is the same shape as #147's own: spell the two blanks bash actually skips,
    // `^[ \t]*(?:export[ \t]+)?`, in `assignmentHead`. By the argument the slice already
    // makes for the `=`, that costs no working configuration — a line bash never assigned
    // was never reaching the loop — and it is what makes the three prose claims true. All
    // three now say "a space-or-tab indent" instead, which is the claim the fix supports.
    //
    // Left RED by the QA pass rather than fixed there, because a QA pass does not change the
    // grammar it is measuring; taken up and fixed immediately after, with the `export`
    // separator measured on the same shell before the class was narrowed. The class it landed
    // on is exactly right, swept rather than argued: of the 24 characters JS `\s` holds apart
    // from LF, bash accepts U+0009 and U+0020 and no others, in the indent position and after
    // the `export` keyword alike.
    const rows = [
      ['U+00A0 as the indent', `${NBSP}TASK_SOURCE=folder`],
      ['U+00A0 after the export keyword', `export${NBSP}TASK_SOURCE=folder`],
      ['a UTF-8 BOM before the name', `${BOM}TASK_SOURCE=folder`],
      ['U+000B as the indent', `${VT}TASK_SOURCE=folder`],
      ['U+000C as the indent', `${FF}TASK_SOURCE=folder`],
      ['U+2028 as the indent', `${LS}TASK_SOURCE=folder`],
      ['U+2029 as the indent', `${PS}TASK_SOURCE=folder`],
      ['a lone CR as the indent', `${CR}TASK_SOURCE=folder`],
      // Two of the fifteen the list above does NOT name, because "a strict superset" is a
      // claim about the whole class and seven named characters cannot carry it. Counted, not
      // estimated: JS `\s` minus LF is 24 characters, two of them are bash's own blanks
      // (U+0009, U+0020), and the rows above name seven of the remaining 22 — U+00A0, U+FEFF,
      // U+000B, U+000C, U+2028, U+2029 and CR — which leaves fifteen unnamed. These two are
      // one Unicode space separator and the ideographic space, which is the one of these a CJK keyboard
      // can produce by accident.
      ['U+2000 EN QUAD as the indent', `${String.fromCharCode(0x2000)}TASK_SOURCE=folder`],
      ['U+3000 IDEOGRAPHIC SPACE as the indent', `${String.fromCharCode(0x3000)}TASK_SOURCE=folder`],
      // The control rows, which must keep passing whatever happens to the ones above: the
      // two blanks bash DOES skip, before the name and after the keyword, in the spellings a
      // hand-indented file grows — including the two mixed, which is the row
      // lib/parse-config-var.js's `export` transcript shows and nothing else measured.
      ['a space indent', '   TASK_SOURCE=folder'],
      ['a tab indent', `${TAB}TASK_SOURCE=folder`],
      ['a space-and-tab mixed indent', ` ${TAB} TASK_SOURCE=folder`],
      ['a tab after the export keyword', `export${TAB}TASK_SOURCE=folder`],
      ['mixed blanks after the export keyword', `export ${TAB} TASK_SOURCE=folder`],
      ['a mixed indent AND mixed blanks after export', ` ${TAB}export ${TAB}TASK_SOURCE=folder`],
    ]
    for (const [label, line] of rows) {
      const config = `${line}\n`
      // bash first, so a failure cannot be read as "maybe bash agrees".
      const bash = await sourceFile(config, 'TASK_SOURCE', { ambient: 'github' })
      const js = jsResolve(config, 'TASK_SOURCE', 'github')
      expect(js, label).toBe(bash.value)
      // ...and the same claim at the resolver `ralph start` calls, which is where the
      // answer becomes a queue.
      expect(resolveSource({ TASK_SOURCE: parseConfigSource(config) }), label).toBe(
        bash.value === 'folder' ? 'folder' : 'github',
      )
    }
  })

  it('lands on exactly the class bash accepts, swept rather than sampled', async () => {
    // THE CLASS ITSELF, as a measurement instead of a list. Every row above names one
    // character, and a named row cannot say whether `[ \t]` is the RIGHT class — only that
    // some other character is not in it. This sweeps the whole of JS `\s`, which is the class
    // the grammar used to use, and asks bash about each member in both positions the head
    // grammar has. A future shell that skipped a third blank fails here first, and so does a
    // narrowing that went one character too far.
    const CLASS = []
    for (let code = 0; code <= 0xffff; code += 1) {
      const ch = String.fromCharCode(code)
      // LF excluded: it ends the line rather than indenting it, which the split handles.
      if (/\s/.test(ch) && ch !== '\n') CLASS.push(code)
    }
    // The class this grammar was written against, so the sweep cannot silently shrink.
    expect(CLASS.length).toBe(24)
    const accepted = { indent: [], afterExport: [] }
    for (const code of CLASS) {
      const ch = String.fromCharCode(code)
      const label = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
      const asIndent = await sourceFile(`${ch}TASK_SOURCE=folder\n`, 'TASK_SOURCE')
      if (asIndent.value === 'folder') accepted.indent.push(label)
      const afterExport = await sourceFile(`export${ch}TASK_SOURCE=folder\n`, 'TASK_SOURCE')
      if (afterExport.value === 'folder') accepted.afterExport.push(label)
      // ...and whatever bash did, this parser did the same. The `[ \t]` class is the claim;
      // this is the claim holding for every member of the wider one at once.
      expect(jsResolve(`${ch}TASK_SOURCE=folder\n`, 'TASK_SOURCE', 'github'), `indent ${label}`).toBe(
        asIndent.value === 'folder' ? 'folder' : 'github',
      )
      expect(
        jsResolve(`export${ch}TASK_SOURCE=folder\n`, 'TASK_SOURCE', 'github'),
        `export ${label}`,
      ).toBe(afterExport.value === 'folder' ? 'folder' : 'github')
    }
    // Two, in both positions, and the same two — which is what makes `[ \t]*(?:export[ \t]+)?`
    // one class rather than two guesses.
    expect(accepted.indent).toEqual(['U+0009', 'U+0020'])
    expect(accepted.afterExport).toEqual(['U+0009', 'U+0020'])
  })
})

// ---------------------------------------------------------------------------
// The PADDING classes, which #147 and its follow-up both left as `\s*` (#147 follow-up 2).
//
// WRITTEN RED, NOW GREEN — the grammar was fixed to match. `assignmentHead` spells the indent
// `[ \t]*` and the `export` separator `[ \t]+`, which closed the masking defect for a line's
// HEAD; this block found the same superset still sitting on both sides of the VALUE, where it
// did something the head version could not: bash ASSIGNS these lines. It just assigned a
// different string from the one this parser read, and the difference was a character this
// parser silently deleted. lib/parse-config-var.js now pads the value group with `[ \t]*` on
// both sides and trims it with `trimPadding` rather than `String.prototype.trim` (three trim
// sites, not two — the regex paddings, the `m[1]` trim, and the comment-strip branch's tail),
// so every UNQUOTED row below is now agreement rather than divergence. The two rows that
// still diverge are re-pinned as such further down, with where they actually diverge.
//
// THE TRANSCRIPTS AND THE ARGUMENT LIVE IN THE MODULE, not here: lib/parse-config-var.js's
// `trimPadding` comment carries the per-spelling bash measurements, and the paragraph above it
// carries the reason this is the #147 defect rather than the `X= folder` family the #149 review
// went on to refuse outright (bash ASSIGNS these lines, so there is a right answer to inherit; no
// shipped configuration depends on a no-break space being deleted; and the deletion manufactured a
// VALID enum value out of an invalid one, which is exactly how #147 masked a run). That is this repo's convention for a
// shared grammar — the module is the canonical record and the files acting on it point at it,
// the way `configAssignsVar`'s comment is pointed at from start.js — so repeating it here would
// give the pair two places to drift apart. The rows below are the measurement; the module is
// the argument.
//
// What IS this file's own is the second half of the finding, because it is a second module's
// rule and the module above has no reason to carry it. Measured after the fix, with bash
// holding a U+00A0 in all four (loop -> github every time):
//
//   TASK_SOURCE=<U+00A0>folder     parseConfigVar '<U+00A0>folder'   resolveSource folder
//   TASK_SOURCE=folder<U+00A0>     parseConfigVar 'folder<U+00A0>'   resolveSource folder
//   TASK_SOURCE="<U+00A0>folder"   parseConfigVar '<U+00A0>folder'   resolveSource folder
//   TASK_SOURCE="folder<U+00A0>"   parseConfigVar 'folder<U+00A0>'   resolveSource folder
//
// The FIRST trim was this module's `\s*`, and it is fixed: the unquoted pair used to report a
// bare `folder` and now reports the string bash reports, so this reader no longer invents a
// legal enum out of an illegal one. The SECOND trim is lib/task-source.js's, and it is not
// this grammar's at all: `resolveSource` does `String(raw).trim().toLowerCase()`, JS `trim`
// eats U+00A0, and so all four rows — including the quoted pair, which parseConfigVar read
// CORRECTLY before the fix as well as after — still reach `folder` off a correct value. #147
// scopes its fix to the one shared READER, so the resolver half is pinned below as the
// measured divergence it is and left OPEN for a follow-up issue against lib/task-source.js.
// ---------------------------------------------------------------------------

describe('parseConfigVar — the blanks trimmed AROUND the value (#147 follow-up 2)', () => {
  const NBSP2 = String.fromCharCode(0xa0)
  const IDEOGRAPHIC = String.fromCharCode(0x3000)

  it.each([
    ['U+00A0 right after the =', `X=${NBSP2}folder`],
    ['U+00A0 as trailing padding', `X=folder${NBSP2}`],
    ['U+00A0 on both sides', `X=${NBSP2}folder${NBSP2}`],
    ['U+00A0 inside the quotes', `X="${NBSP2}folder"`],
    ['U+3000 as trailing padding', `X=folder${IDEOGRAPHIC}`],
    ['U+00A0 as the WHOLE value', `X=${NBSP2}`],
    // The controls: the two blanks bash really does drop from a trailing position, which must
    // keep being dropped whatever happens to the rows above.
    ['a trailing space — the control', 'X=folder '],
    ['a trailing tab — the control', `X=folder${TAB}`],
    // NOT a control, and not part of this finding: a trailing CR diverges the same way and
    // is DELIBERATE — a config edited on Windows must not hand a control character to `gh`.
    // It is pinned as such in "a line terminator at the END of a value" above, and the fix
    // this block asked for (`[ \t]*` around the value) had to keep eating it: `trimPadding`
    // names CR, U+2028 and U+2029 in its trailing class for exactly that reason, so the
    // narrowing landed on bash's blanks WITHOUT reopening #133's line-ending policy.
    //
    // `X="folder"<U+00A0>` used to be a row here too, and it is now pinned one test down: it
    // diverges, but not through a padding trim, so making it agree is a different change.
  ])('%s: reads the string the sourcing shell is left holding', async (label, line) => {
    const config = `${line}\n`
    // bash first, so a failure cannot be read as "maybe bash agrees".
    const bash = await sourceFile(config, 'X', { ambient: 'AMBIENT' })
    // bash ASSIGNED, for every row here — which is what separates these from the head rows
    // above and from the `X= folder` family: there is a right answer, and it is this one.
    expect(bash.stderr, label).toBe('')
    expect(configAssignsVar(config, 'X'), label).toBe(true)
    expect(jsResolve(config, 'X', 'AMBIENT'), label).toBe(bash.value)
  })

  it.each([
    ['U+00A0 then a hash, no value', `X=${NBSP2}#off`, `${NBSP2}#off`, ''],
    ['U+00A0 between a value and a hash', `X=folder${NBSP2}#off`, `folder${NBSP2}#off`, 'folder'],
  ])(
    '%s: the COMMENT separator is still the wide class — pinned divergence',
    async (label, line, bashSays, parserSays) => {
      // THE SAME SUPERSET, ONE CLASS OVER, AND STILL OPEN. The padding either side of the value
      // narrowed to `[ \t]*` in this slice; the `\s+` in the inline-comment strip
      // (`raw.replace(/(^|\s+)#.*$/, '')` in lib/parse-config-var.js) did not. bash opens a
      // comment only at a `#` that begins a WORD, and its word separators there are the same two
      // blanks — so a U+00A0 in front of a `#` is DATA to the shell and a comment opener here.
      //
      // Left wide deliberately: narrowing it changes what this parser reads for these two lines,
      // which is a behaviour change with its own review rather than part of a padding fix. Pinned
      // here so it cannot be lost, and written the way the other open rows are — bash's answer and
      // each reader's answer, both measured — so the day the class is narrowed this goes red.
      const config = `${line}\n`
      // bash ASSIGNED both, with nothing on stderr: there is a right answer and this is not it.
      const bash = await sourceFile(config, 'X', { ambient: 'AMBIENT' })
      expect(bash.stderr, label).toBe('')
      expect(bash.value, label).toBe(bashSays)
      expect(parseConfigVar(config, 'X'), label).toBe(parserSays)
      expect(configAssignsVar(config, 'X'), label).toBe(true)
      // The first row is the DESTROYS direction lib/parse-config-var.js calls the sharper one:
      // present-and-blank, so it clears a live line above it where bash leaves that line's
      // successor holding data.
      const after = `X=live\n${line}\n`
      expect((await sourceFile(after, 'X', { ambient: 'AMBIENT' })).value, label).toBe(bashSays)
      expect(parseConfigVar(after, 'X'), label).toBe(parserSays)
    },
  )

  it('and that separator still reaches a different QUEUE than the loop', async () => {
    // The consequence on TASK_SOURCE, which is what makes the row above worth an issue rather
    // than a footnote: it is the #147 masking shape exactly — `ralph start` naming a queue the
    // loop will not run — surviving in the one class this slice did not narrow.
    const line = `TASK_SOURCE=folder${NBSP2}#off`
    const config = `${line}\n`
    const bash = await sourceFile(config, 'TASK_SOURCE', { ambient: 'github' })
    expect(bash.stderr).toBe('')
    // bash holds the whole thing, so templates/ralph.sh's `= "folder"` test fails and the loop
    // runs in GITHUB mode.
    expect(bash.value).toBe(`folder${NBSP2}#off`)
    expect(bash.value === 'folder').toBe(false)
    // This parser takes the U+00A0 for a word separator, reads `folder`, and announces the
    // folder queue.
    expect(parseConfigVar(config, 'TASK_SOURCE')).toBe('folder')
    expect(resolveSource({ TASK_SOURCE: parseConfigSource(config) })).toBe('folder')
    // ...and the no-value spelling goes the other way, which is the safe direction: both readers
    // miss `folder`, so they still agree on the queue even though they disagree on the string.
    const blanked = `TASK_SOURCE=${NBSP2}#off\n`
    expect((await sourceFile(blanked, 'TASK_SOURCE', { ambient: 'github' })).value).toBe(`${NBSP2}#off`)
    expect(resolveSource({ TASK_SOURCE: parseConfigSource(blanked) })).toBe('github')
  })

  it('still concatenates a blank onto a CLOSING quote, pinned rather than fixed', async () => {
    // The one row from the table above that the padding fix does not reach, kept as a
    // measurement instead of dropped. `X="folder"<U+00A0>` is a quoted value with something
    // stuck to the closing quote, and bash's answer comes from its WORD rule: the quotes are
    // syntax, so it holds `folder<U+00A0>`. This parser's quoted branch requires the quote to
    // close at the END of the value, so the trailing U+00A0 makes the match fail and the whole
    // thing falls through as an unquoted value — quote characters and all.
    //
    // That is the pre-existing adjacent-word divergence this module has always had (see the
    // `X=a"b"c` family), NOT a padding trim: no class of blank around the value is involved,
    // and narrowing `\s*` to `[ \t]*` neither caused it nor could cure it. It is pinned here
    // because it diverges in the SAFE direction — the parser keeps more than bash rather than
    // less, so the value is not a legal enum on either side and both readers reject it.
    const config = `X="folder"${NBSP2}\n`
    const bash = await sourceFile(config, 'X', { ambient: 'AMBIENT' })
    expect(bash.stderr).toBe('')
    expect(bash.value).toBe(`folder${NBSP2}`)
    expect(jsResolve(config, 'X', 'AMBIENT')).toBe(`"folder"${NBSP2}`)
    // ...and the direction: on TASK_SOURCE, both answers miss `folder`, so `ralph start` and
    // the loop still agree on the queue even though they disagree on the string.
    const asSource = `TASK_SOURCE="folder"${NBSP2}\n`
    const bashSource = await sourceFile(asSource, 'TASK_SOURCE', { ambient: 'github' })
    expect(bashSource.value).toBe(`folder${NBSP2}`)
    expect(resolveSource({ TASK_SOURCE: parseConfigSource(asSource) })).toBe('github')
  })

  it('does not turn a source the loop rejects into one it accepts', async () => {
    // The consequence, on the knob where the two answers are two different QUEUES — asserted at
    // the boundary this module actually owns. `parseConfigVar` is the only step in the chain
    // that turns config TEXT into a value, so the property that stops it inventing an accepted
    // source is: the string it hands on is `folder` exactly when the string the sourcing shell
    // is left holding is `folder`. Every row here was RED before the padding fix (the trim
    // manufactured a bare `folder` out of four spellings bash keeps a U+00A0 in), so this does
    // go red on a regression rather than restating the row above by accident.
    //
    // The last step, `resolveSource` -> queue, is NOT asserted here: it re-trims, so on these
    // rows it answers `folder` off a value this module now reports correctly. That is a
    // different module's rule and it is pinned as an open follow-up in the next test.
    for (const line of [
      `TASK_SOURCE=${NBSP2}folder`,
      `TASK_SOURCE=folder${NBSP2}`,
      `TASK_SOURCE="${NBSP2}folder"`,
      `TASK_SOURCE="folder${NBSP2}"`,
      // The control: the spelling bash, this parser, the resolver and the loop all read as
      // folder — so the four rows above are not passing merely because nothing reaches folder.
      'TASK_SOURCE=folder',
    ]) {
      const config = `${line}\n`
      const bash = await sourceFile(config, 'TASK_SOURCE', { ambient: 'github' })
      const loopSees = bash.value === 'folder' ? 'folder' : 'github'
      expect(jsResolve(config, 'TASK_SOURCE', 'github'), line).toBe(bash.value)
      expect(parseConfigSource(config) === 'folder' ? 'folder' : 'github', line).toBe(loopSees)
    }
    // ...and the control all the way through to the queue, which is the one row where every
    // reader in the chain is allowed to agree.
    expect(resolveSource({ TASK_SOURCE: parseConfigSource('TASK_SOURCE=folder\n') })).toBe('folder')
  })

  it('leaves the RESOLVER trim reaching the wrong queue — lib/task-source.js, a follow-up', async () => {
    // The half of this finding that is NOT this grammar's, pinned at its measured values so it
    // cannot be lost. `parseConfigVar` reports all four of these EXACTLY as bash does — that is
    // asserted first — and for the quoted pair it always did, because a quoted value never went
    // through the padding trim at all. The divergence that is left appears one module later:
    // lib/task-source.js's `resolveSource` does `String(raw).trim().toLowerCase()`, and JS
    // `trim` eats U+00A0, so a value whose only defect is a no-break space becomes `folder` to
    // `ralph start` while templates/ralph.sh's `[ "${TASK_SOURCE:-github}" = "folder" ]`
    // compares the untrimmed string and falls through to `github`.
    //
    // #147 scopes its fix to the one shared READER, and this is a second module's own
    // normalisation rule applied to a value that is now correct, so it is left OPEN here
    // deliberately and should be filed as a follow-up issue against lib/task-source.js. The
    // assertions are written the way the `X= folder` family is — bash's answer and each
    // reader's answer, both measured — so the day the resolver is fixed this test goes red and
    // names itself.
    for (const line of [
      `TASK_SOURCE=${NBSP2}folder`,
      `TASK_SOURCE=folder${NBSP2}`,
      `TASK_SOURCE="${NBSP2}folder"`,
      `TASK_SOURCE="folder${NBSP2}"`,
    ]) {
      const config = `${line}\n`
      const bash = await sourceFile(config, 'TASK_SOURCE', { ambient: 'github' })
      expect(bash.stderr, line).toBe('')
      // This grammar: the right answer, the same string bash is holding.
      expect(jsResolve(config, 'TASK_SOURCE', 'github'), line).toBe(bash.value)
      // The loop: not `folder`, because the U+00A0 is still in the string it compares.
      expect(bash.value === 'folder', line).toBe(false)
      // The resolver: `folder` anyway. The open half.
      expect(resolveSource({ TASK_SOURCE: parseConfigSource(config) }), line).toBe('folder')
    }
  })
})
