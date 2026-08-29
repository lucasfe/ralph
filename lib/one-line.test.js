import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { oneLine, oneLineEcho } from './one-line.js'

// #108 — the two single-line promises this package makes about somebody else's text, in the
// module that owns them.
//
// WHY THIS FILE EXISTS AT ALL, since `oneLine` already had a spec in lib/digest.qa.test.js:
// the function MOVED, and it moved for a reason a test has to hold onto. `ralph doctor` may
// take no exec dependency — its import graph is pinned in
// lib/commands/doctor.version-line.qa.test.js to exactly node:fs, node:os, node:path and
// picocolors — so a warning it prints cannot be worded by a helper living in lib/digest.js, a
// module that imports execa. The helper is therefore here, in a module that imports NOTHING,
// which is the same extraction lib/parse-config-var.js and lib/read-config-source.js already
// made for the same reason. The last describe block in this file is what keeps that true.
//
// AND IT GREW A GUARANTEE. Collapsing whitespace neutralises LF, CR, TAB and U+2028 — every
// character that ENDS a line is whitespace to `\s`, almost — but it left ESC, NUL, BEL, DEL,
// U+0085 and the C1 block untouched, and those are the ones that command a terminal rather
// than break a line. So both functions now replace them, with the placeholder
// lib/banner-rows.js chose for the identity box's own facts, for the argument that module
// writes out at length: a stripped value silently MISREPORTS what was set, while a placeholder
// says "there is a character here you cannot see", which is the truth.
//
// Every control character below is built from its code point rather than typed, the convention
// test/source-control-bytes.test.js enforces over the whole repo (#107).
const NUL = String.fromCharCode(0x00)
const BEL = String.fromCharCode(0x07)
const BACKSPACE = String.fromCharCode(0x08)
const ESC = String.fromCharCode(0x1b)
const DEL = String.fromCharCode(0x7f)
// U+0085 NEL is a line break to a terminal and is NOT in JavaScript's `\s` class, so it is one
// of the two characters that get past a whitespace collapse and still end a line. U+009B is a
// single-byte CSI introducer: `ESC [` without the ESC.
const NEL = String.fromCharCode(0x85)
const C1_CSI = String.fromCharCode(0x9b)
// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR — line terminators to JavaScript, to
// JSON and to a good deal of what renders a pasted bug report, whatever a terminal makes of them.
const LINE_SEP = String.fromCharCode(0x2028)
const PARA_SEP = String.fromCharCode(0x2029)
const PLACEHOLDER = String.fromCharCode(0xfffd)

// Every character in the forbidden class, named by CODE POINT, as a predicate rather than as a
// literal character class. Two reasons, both learned here: an assertion that lists the bytes it
// looked for passes on the one this file forgot, and a longhand character class is a place for a
// raw byte to hide (#107). Built the way test/helpers/source-control-bytes.js builds its sets.
const isControlCode = (code) =>
  code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
const controlsIn = (text) =>
  [...String(text)].map((char) => char.codePointAt(0)).filter(isControlCode)

const HOSTILE_CHARS = { NUL, BEL, BACKSPACE, ESC, DEL, NEL, C1_CSI, LINE_SEP, PARA_SEP }

describe('oneLine — a diagnostic is one line, collapsed and capped (#61, hardened by #108)', () => {
  it('collapses every kind of whitespace to a single line', () => {
    // Unchanged from the day this shipped in lib/digest.js: one failure is one line, which is
    // what a reader greps and what a launchd log collects.
    expect(oneLine('a\nb\r\nc\td   e f')).toBe('a b c d e f')
    expect(oneLine('\n\n  padded  \n\n')).toBe('padded')
  })

  it('replaces the control characters a whitespace collapse leaves behind', () => {
    // The gap #108 closed. None of these is `\s`, so none of them was touched before — and each
    // either commands the terminal (ESC, C1_CSI, BEL, BACKSPACE) or ends the line anyway without
    // being whitespace (NEL, LINE_SEP, PARA_SEP).
    for (const [label, char] of Object.entries(HOSTILE_CHARS)) {
      const out = oneLine(`before${char}after`)
      expect(controlsIn(out), label).toEqual([])
      expect(out.split('\n'), label).toHaveLength(1)
    }
  })

  it('caps long text with an ellipsis rather than truncating silently', () => {
    const out = oneLine('z'.repeat(5000))
    expect(out).toHaveLength(200)
    expect(out.endsWith('…')).toBe(true)
  })

  it('is idempotent, because the engine and the CLI shell both apply it', () => {
    for (const input of ['a\nb', 'z'.repeat(5000), '', null, undefined, 0, {}, `x${ESC}[31m`, NUL]) {
      expect(oneLine(oneLine(input)), String(input)).toBe(oneLine(input))
    }
  })

  it('is the only flattener, reached by one import path and not two', () => {
    // WHAT THIS PINNED BEFORE, and why it changed: the extraction first left `export { oneLine }`
    // behind in lib/digest.js so no caller had to change a line, and this test asserted the two
    // exports were one function object. That re-export is gone. It was a permanent second import
    // path that routed a deliberately dependency-free helper back out through the one module the
    // extraction existed to escape — #108's own trap in reduced form — so the callers were
    // repointed instead, and the claim moved with them: there is one flattener because there is
    // one specifier for it, which is what makes the shape a reader greps a single shape.
    //
    // Asserted against the SOURCES, because the property is about who asks whom. A runtime
    // identity check cannot see a second path being added; an import line can only be read.
    const sourceOf = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
    for (const consumer of ['./digest.js', './commands/start.js', './commands/digest.js']) {
      const src = sourceOf(consumer)
      expect(src, consumer).toMatch(/import \{ oneLine \} from '\.\.?\/one-line\.js'/)
      expect(src, consumer).not.toMatch(/import \{[^}]*\boneLine\b[^}]*\} from '\.\.?\/digest\.js'/)
    }
    // ...and the module it moved out of hands it on to nobody, so the second path cannot come
    // back without this line failing.
    expect(sourceOf('./digest.js')).not.toMatch(/export \{[^}]*\boneLine\b/)
  })
})

describe('oneLineEcho — a value the user typed, echoed back safely (#108)', () => {
  it('leaves an ordinary value byte-identical', () => {
    // The common case is a typo, and a typo must come back EXACTLY as typed, or the reader goes
    // looking for a different bug. Nothing here is interpreted, formatted or quoted either.
    for (const value of ['codx', 'gpt-9000', 'CODEX', '%s%s%n', '${HOME}', '`whoami`', '$(rm -rf /)', 'a"b']) {
      expect(oneLineEcho(value), value).toBe(value)
    }
  })

  it('keeps the padding and the case of what was typed, unlike oneLine', () => {
    // THE REASON THERE ARE TWO FUNCTIONS. `oneLine` normalises, because a diagnostic is OUR
    // sentence about someone else's text. An echo may not: `resolveAgent` promises the ORIGINAL,
    // untrimmed, original-case value (lib/agent-registry.js, and lib/banner-mode.js makes the
    // same promise about RALPH_BANNER), so a user who typed three spaces sees three spaces and
    // learns that the padding was not the problem.
    expect(oneLineEcho('   codx   ')).toBe('   codx   ')
    expect(oneLineEcho(' GPT ')).toBe(' GPT ')
    expect(oneLine('   codx   ')).toBe('codx')
  })

  it('replaces every character that could end the line or command the terminal', () => {
    for (const [label, char] of Object.entries(HOSTILE_CHARS)) {
      const out = oneLineEcho(`before${char}after`)
      expect(out, label).toBe(`before${PLACEHOLDER}after`)
      expect(out.split('\n'), label).toHaveLength(1)
    }
    // LF and CR are in that class too — they are the two the issue was reported about — and they
    // are replaced rather than collapsed, because an echo counts characters.
    expect(oneLineEcho('x\n│ cwd     /elsewhere')).toBe(`x${PLACEHOLDER}│ cwd     /elsewhere`)
    expect(oneLineEcho('x\r\ny')).toBe(`x${PLACEHOLDER}${PLACEHOLDER}y`)
  })

  it('replaces rather than strips, one code point in for one code point out', () => {
    // lib/banner-rows.js's argument, applied to a warning: `codx` with a NUL in the middle is
    // not the same value as `codx`, and a message showing the second would be telling the user
    // their setting is something it is not.
    const hostile = `co${NUL}dx`
    expect(oneLineEcho(hostile)).not.toBe('codx')
    expect([...oneLineEcho(hostile)]).toHaveLength([...hostile].length)
    expect(oneLineEcho(`${ESC}[31mred${ESC}[0m`)).toBe(`${PLACEHOLDER}[31mred${PLACEHOLDER}[0m`)
  })

  it('caps a pathological value rather than filling the terminal with it', () => {
    // A warning is read by a human, and RALPH_AGENT is as long as a shell will let it be. The
    // same 200-character bound `ralph start` puts on the RALPH_BANNER warning (#62), for the same
    // reason: a screenful of `x` is not a diagnostic. It also closes the SOFT-wrap version of
    // #108's forgery — one very long line, wrapped by the terminal, can put arbitrary text at
    // column zero underneath a box with no line break in it at all.
    const out = oneLineEcho('x'.repeat(100_000))
    expect(out).toHaveLength(200)
    expect(out.endsWith('…')).toBe(true)
  })

  it('is total, and never hands back something it would change again', () => {
    for (const input of [undefined, null, '', 0, 7, {}, [], NUL]) {
      const out = oneLineEcho(input)
      expect(typeof out, String(input)).toBe('string')
      expect(controlsIn(out), String(input)).toEqual([])
      expect(oneLineEcho(out), String(input)).toBe(out)
    }
  })
})

describe('one-line.js — the module `ralph doctor` is allowed to reach', () => {
  const SOURCE = readFileSync(new URL('./one-line.js', import.meta.url), 'utf8')
  // The prose names execa and lib/digest.js in order to explain that it is neither of them, so
  // the assertions run against the source with its comments stripped — the technique
  // lib/progress.qa.test.js and the doctor import-graph walks already use.
  const CODE = SOURCE.split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line.replace(/\s\/\/.*$/, '')))
    .join('\n')

  it('imports nothing at all', () => {
    // THE WHOLE POINT OF THE EXTRACTION. `ralph doctor`'s import graph is pinned to four bare
    // specifiers and this module is now on it (doctor -> agent-registry -> here), so one import
    // in this file would fail that pin instead of failing in the field. Kept as a claim of its
    // own as well, because a graph walk cannot say WHY the edge is forbidden.
    //
    // The DYNAMIC form is checked too, and it is the one three regexes miss: `await import('execa')`
    // starts no line with `import` followed by whitespace, contains no `require(` and contains no
    // `from '`, so a guard without it reads as clean while the module reaches execa at runtime — a
    // reach a STATIC graph walk cannot see either. The exhaustive sweep over every loader form
    // (re-exports, createRequire, eval, the Function constructor, import.meta), with a positive
    // control proving each pattern fires, lives in lib/one-line.qa.test.js; this stays the short
    // list a reader editing this file will actually look at.
    expect(CODE).not.toMatch(/^\s*import\s/m)
    expect(CODE).not.toMatch(/\bimport\s*\(/)
    expect(CODE).not.toMatch(/require\(/)
    expect(CODE).not.toMatch(/from ['"]/)
  })

  it('reaches for no process, no clock and no filesystem either', () => {
    for (const forbidden of [/process\./, /Date\.now/, /\bfs\./, /execa|spawn|(?<![.\w])exec\(/, /Math\.random/]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('spells the bytes it forbids as escapes rather than embedding them', () => {
    // #107's rule reaches shipped code too, and this is the one module whose whole subject is
    // the class of bytes that rule is about: the C0 range and the replacement character are
    // written as escapes, so this file stays greppable and safe to `cat`.
    expect(SOURCE).toMatch(/\\u0000/)
    expect(SOURCE).toMatch(/\\uFFFD/)
    // TAB, LF and CR are exempt here and only here: they are how a source file is a source file,
    // and they are exactly the three #107's own sweep leaves alone
    // (test/helpers/source-control-bytes.js's TEXT_CONTROL_CODES). Every OUTPUT assertion in this
    // file uses the unfiltered `controlsIn`, because a diagnostic gets no such exemption.
    const TEXTUAL = [0x09, 0x0a, 0x0d]
    expect(controlsIn(SOURCE).filter((code) => !TEXTUAL.includes(code))).toEqual([])
  })
})
