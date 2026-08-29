import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { DIAGNOSTIC_MAX_CHARS, oneLine, oneLineEcho } from './one-line.js'
import { formatHistoryEntry } from './digest.js'
import { parseLatestDigest } from './digest-history.js'
import { HEADING_PREFIX } from './digest-file.js'

// #108 QA — adversarial specs for lib/one-line.js.
//
// lib/one-line.test.js proves the intended slice: both functions flatten to one line, the echo
// keeps the padding and the case, the control characters a whitespace collapse never reached are
// replaced rather than stripped, and the module imports nothing. This file attacks the parts of
// that slice that a sample-based spec cannot see, and it is organised around the four things the
// implementation actually decides:
//
//   1. THE CLASS IS A DENYLIST. `CONTROL` names four ranges, and a spec that checks nine sample
//      characters passes on the tenth it forgot. So the class is pinned as a SET over the whole
//      BMP — every code point classified, the boundaries named one by one — and the characters
//      that are deliberately OUTSIDE it (bidi overrides, zero-width joiners, combining marks)
//      are pinned as kept, WITH the argument for why that is the right answer rather than an
//      oversight. lib/banner-rows.js writes that argument out for the identity box's facts;
//      this file checks whether it still holds for a value echoed back at its author.
//   2. THE CAP COUNTS CODE POINTS, NOT UTF-16 UNITS. `cap` spends `[...text]` on it, which is
//      what lib/banner-compose.js's `clip` and `visibleWidth` already do and is the fix this
//      block drove: the first draft was `text.slice(0, 199)`, and a unit slice lands in the
//      middle of a surrogate pair. So the bound is driven at 199/200/201 in both functions, and
//      across a value made of astral code points, where the old spelling returned a lone
//      surrogate that Node then wrote out as a replacement character nobody set.
//   3. THE OLD PROMISE MUST NOT HAVE MOVED. `oneLine` is not a new function: it is #61's, with a
//      replacement pass added, and its output feeds a heading that is PADDED TO A COLUMN
//      (lib/digest.js) and then parsed back by lib/digest-history.js. So the strengthening is
//      checked for the property that makes it safe — one code point in, one code point out, so
//      no width moved — and the writer/reader round trip is driven through it.
//   4. "THIS MODULE IMPORTS NOTHING" IS THE LOAD-BEARING CLAIM (`ralph doctor`'s import graph),
//      and the companion spec checked it with three regexes that a dynamic `import()` walked
//      straight past (it names that form too now, prompted by this block). So the guard is
//      re-asserted here from a pattern set with a POSITIVE CONTROL: each pattern is proven to
//      fire on a synthetic module that uses that loader form, and then proven not to fire on
//      this one.
//
// Every control character below is built from its code point rather than typed, which is #107's
// rule for this repo (test/source-control-bytes.test.js sweeps it). That guard walks
// `git ls-files`, and until this landed lib/one-line.js was untracked and so outside its scope
// entirely — hence the by-code-point check in the last describe block, which was the only thing
// watching the new file while it was new and is a belt-and-braces duplicate of the sweep now.

const ONE_LINE_JS = fileURLToPath(new URL('./one-line.js', import.meta.url))

const LF = String.fromCharCode(0x0a)
const PLACEHOLDER = String.fromCharCode(0xfffd)
const ELLIPSIS = String.fromCharCode(0x2026)

/** Every code point in `text` that lib/one-line.js promises to have replaced. */
const isControlCode = (code) =>
  code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
const controlsIn = (text) =>
  [...String(text)].map((char) => char.codePointAt(0)).filter(isControlCode)
/** Every lone surrogate in `text` — a code unit with no partner, which is not a code point. */
const loneSurrogatesIn = (text) =>
  [...String(text)]
    .map((char) => char.codePointAt(0))
    .filter((code) => code >= 0xd800 && code <= 0xdfff)

describe('QA #108 — the control class, pinned as a SET rather than as samples', () => {
  it('replaces exactly four ranges over the whole BMP, and nothing else', () => {
    // THE CLAIM THE COMPANION SPEC CANNOT MAKE. lib/one-line.test.js names nine characters; this
    // classifies all 63 488 non-surrogate BMP code points and asserts the partition, so a
    // character the denylist forgot shows up as an extra range rather than as a case nobody
    // thought of. Surrogate code units are excluded here and attacked on their own below —
    // half a pair is not a character and cannot be classified as one.
    const replaced = []
    const mangled = []
    for (let code = 0; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      // U+FFFD is skipped because it is the placeholder: a value that already held one in and
      // the same string out is indistinguishable from a replacement, and the ambiguity has a
      // test of its own below.
      if (code === 0xfffd) continue
      const char = String.fromCharCode(code)
      const out = oneLineEcho(`a${char}b`)
      if (out === `a${PLACEHOLDER}b`) replaced.push(code)
      // A third outcome would be the interesting one: neither kept nor cleanly replaced, i.e.
      // dropped, doubled or reordered. Collected rather than asserted per code point so the
      // failure names every offender at once instead of only the first of 63 000.
      else if (out !== `a${char}b`) mangled.push(`U+${code.toString(16)} -> ${JSON.stringify(out)}`)
    }
    expect(mangled).toEqual([])
    // Compressed to ranges, so the assertion reads as the class it is asserting.
    const ranges = []
    for (const code of replaced) {
      const last = ranges[ranges.length - 1]
      if (last && last[1] === code - 1) last[1] = code
      else ranges.push([code, code])
    }
    expect(ranges).toEqual([
      [0x0000, 0x001f],
      [0x007f, 0x009f],
      [0x2028, 0x2029],
    ])
  })

  it('turns on and off exactly where the ranges say, one boundary at a time', () => {
    // The four edges, named, so a fencepost error in the regex is a failure about a boundary
    // rather than a failure about a range. U+0020 SPACE and U+00A0 NBSP are the two characters
    // most likely to be swept in by mistake, and neither commands a terminal.
    const IN = [0x001f, 0x007f, 0x009f, 0x2028, 0x2029]
    const OUT = [0x0020, 0x007e, 0x00a0, 0x2027, 0x202a]
    for (const code of IN) {
      expect(oneLineEcho(String.fromCharCode(code)), `U+${code.toString(16)}`).toBe(PLACEHOLDER)
    }
    for (const code of OUT) {
      const char = String.fromCharCode(code)
      expect(oneLineEcho(`a${char}b`), `U+${code.toString(16)}`).toBe(`a${char}b`)
    }
  })

  it('finds nothing to replace outside the BMP, and lets nothing astral end a line', () => {
    // Unicode puts no C0/C1 block above U+FFFF, so the class is complete by construction — but
    // the astral planes DO hold format characters (the tag block, the musical layout controls,
    // the variation selectors), and none of them is in the denylist. Pinned as kept, with the
    // load-bearing half asserted separately: kept or not, the result is still ONE line.
    const ASTRAL_FORMATS = [0x1d173, 0x1d17a, 0xe0001, 0xe0041, 0xe007f, 0xe0100, 0x1f600]
    for (const code of ASTRAL_FORMATS) {
      const char = String.fromCodePoint(code)
      const out = oneLineEcho(`a${char}b`)
      expect(out, `U+${code.toString(16)}`).toBe(`a${char}b`)
      expect(out.split(LF), `U+${code.toString(16)}`).toHaveLength(1)
    }
  })
})

describe('QA #108 — what the denylist deliberately leaves alone, and whether that holds', () => {
  // The characters a reader would reasonably ask about, grouped by what they actually do. None
  // of them is in `CONTROL`, and the question this block answers is not "are they replaced" but
  // "can any of them do the thing #108 was filed about" — end a line, or move a cursor.
  const NOT_IN_CLASS = {
    'U+00AD SOFT HYPHEN': 0x00ad,
    'U+061C ARABIC LETTER MARK': 0x061c,
    'U+180E MONGOLIAN VOWEL SEPARATOR': 0x180e,
    'U+200B ZERO WIDTH SPACE': 0x200b,
    'U+200C ZERO WIDTH NON-JOINER': 0x200c,
    'U+200D ZERO WIDTH JOINER': 0x200d,
    'U+200E LEFT-TO-RIGHT MARK': 0x200e,
    'U+200F RIGHT-TO-LEFT MARK': 0x200f,
    'U+202A LEFT-TO-RIGHT EMBEDDING': 0x202a,
    'U+202B RIGHT-TO-LEFT EMBEDDING': 0x202b,
    'U+202C POP DIRECTIONAL FORMATTING': 0x202c,
    'U+202D LEFT-TO-RIGHT OVERRIDE': 0x202d,
    'U+202E RIGHT-TO-LEFT OVERRIDE': 0x202e,
    'U+2060 WORD JOINER': 0x2060,
    'U+2066 LEFT-TO-RIGHT ISOLATE': 0x2066,
    'U+2067 RIGHT-TO-LEFT ISOLATE': 0x2067,
    'U+2068 FIRST STRONG ISOLATE': 0x2068,
    'U+2069 POP DIRECTIONAL ISOLATE': 0x2069,
    'U+0300 COMBINING GRAVE ACCENT': 0x0300,
    'U+FFF9 INTERLINEAR ANNOTATION ANCHOR': 0xfff9,
  }

  it('keeps every one of them, and not one of them can end a line', () => {
    // DOCUMENTED BEHAVIOUR, and the reasoning is lib/banner-rows.js's, checked rather than
    // inherited. That module excludes the bidi controls from its own identical class with an
    // argument: they REORDER text a terminal is otherwise printing normally, which is the same
    // class of problem as an East Asian glyph occupying two cells, and replacing them would
    // mangle a legitimate value containing a ZWJ emoji sequence. The argument holds here for the
    // reason that matters to #108 — none of these produces a second line, so none of them is
    // the defect this issue is about. What they CAN do is reorder the sentence around the echo,
    // which is a residual worth a reader knowing about and not a criterion this fix claims.
    for (const [label, code] of Object.entries(NOT_IN_CLASS)) {
      const char = String.fromCharCode(code)
      const out = oneLineEcho(`co${char}dx`)
      expect(out, label).toBe(`co${char}dx`)
      expect(out.split(LF), label).toHaveLength(1)
      expect(controlsIn(out), label).toEqual([])
    }
  })

  it('collapses U+FEFF because it is whitespace to the collapse, not because it is in the class', () => {
    // A pair worth separating, because they look like the same answer and are not. U+FEFF is in
    // JavaScript's `\s`, so `oneLine` turns it into a space by the collapse it always had —
    // while `oneLineEcho`, which does not collapse, keeps it verbatim. Neither one replaces it,
    // and a reader who assumed the class covered it would be wrong about both functions.
    const BOM = String.fromCharCode(0xfeff)
    expect(oneLine(`co${BOM}dx`)).toBe('co dx')
    expect(oneLineEcho(`co${BOM}dx`)).toBe(`co${BOM}dx`)
  })

  it('cannot tell a value that already held U+FFFD from one it scrubbed', () => {
    // On the record, because a diagnostic's whole job is to be trusted: the placeholder is not
    // escaped, so `oneLineEcho('a�b')` and `oneLineEcho('a' + NUL + 'b')` produce the same
    // string. Both readings are honest — "there is a character here you cannot see" is true of
    // a real U+FFFD too — and escaping it would cost the one-code-point-in-one-out property the
    // width accounting downstream depends on. Pinned so the ambiguity is a decision.
    const NUL = String.fromCharCode(0x00)
    expect(oneLineEcho(`a${PLACEHOLDER}b`)).toBe(oneLineEcho(`a${NUL}b`))
  })
})

describe('QA #108 — the cap, at the boundary and through a surrogate pair', () => {
  it('caps at exactly 200 characters and only past 200, in both functions', () => {
    // 199/200/201 rather than 5000: the bound is `length > MAX`, and the interesting question is
    // whether a value of exactly MAX is left alone (it must be — an ellipsis on a value that was
    // not truncated says something false) and whether MAX + 1 comes back at MAX rather than at
    // MAX + 1. The `x`-only input keeps this a claim about the arithmetic; the surrogate test
    // below is the claim about the slice.
    for (const fn of [oneLine, oneLineEcho]) {
      expect(fn('x'.repeat(199))).toHaveLength(199)
      expect(fn('x'.repeat(199)).endsWith(ELLIPSIS)).toBe(false)
      expect(fn('x'.repeat(200))).toHaveLength(200)
      expect(fn('x'.repeat(200)).endsWith(ELLIPSIS)).toBe(false)
      expect(fn('x'.repeat(201))).toHaveLength(200)
      expect(fn('x'.repeat(201)).endsWith(ELLIPSIS)).toBe(true)
    }
    expect(DIAGNOSTIC_MAX_CHARS).toBe(200)
  })

  it('spends a character on the ellipsis rather than appending one past the bound', () => {
    // The same rule lib/banner-compose.js's `clip` states: a truncated string is exactly as long
    // as it was asked to be, so a caller doing its own width arithmetic is not off by one.
    const out = oneLineEcho('x'.repeat(500))
    expect(out.slice(0, 199)).toBe('x'.repeat(199))
    expect(out.slice(199)).toBe(ELLIPSIS)
  })

  it('does not split a surrogate pair — a sanitiser may not emit a lone surrogate', () => {
    // THE DEFECT THIS CLOSED. `cap` used to slice UTF-16 CODE UNITS (`text.slice(0, 199)`), and
    // an emoji is two of them. A 200-emoji value is 400 units long, so the slice landed between
    // the high and low halves of the hundredth one and the returned string ended
    // `<lone high surrogate>…` — a string `isWellFormed()` rejects, which Node then wrote to the
    // terminal as a replacement character that nothing in the value put there. `cap` now counts
    // and slices with `[...text]`, so the pair is indivisible and the bound is a bound on
    // characters.
    //
    // WHY THAT WAS A DEFECT AND NOT A CURIOSITY, kept because it is the argument for the current
    // spelling. This module's own header states the contract the unit slice broke: one code point
    // in, one code point out. A value of 200 emoji came back as 99 emoji plus a broken half plus
    // an ellipsis, so the count was not part of anything. lib/banner-compose.js had hit the exact
    // same hazard and spends `[...s]` on it — `visibleWidth` and `clip` both count code points,
    // with a comment saying why — so the repo had already made this decision once, in the module
    // #108 borrowed its placeholder from, and the fix was to agree with it rather than to invent
    // a second answer. It was not a line forgery and not a regression (#61's `oneLine` sliced the
    // same way inside lib/digest.js), but #108 is what put this function on the path that echoes
    // a user-controlled value into `ralph doctor`'s report, and a report that invents a
    // replacement character is a report that misstates what was set.
    const emoji = String.fromCodePoint(0x1f600)
    const out = oneLineEcho(emoji.repeat(200))
    expect(loneSurrogatesIn(out)).toEqual([])
    expect(out.isWellFormed()).toBe(true)
    // ...and the bound is a bound on CHARACTERS, which is what `DIAGNOSTIC_MAX_CHARS` is called.
    expect([...out]).toHaveLength(200)
  })

  it('does not split a surrogate pair in oneLine either — it is the same cap', () => {
    // The diagnostic half of the same function. It matters slightly less (an agent's stderr is
    // not quoted back at its author) and it is the same one-line fix, so it is pinned separately
    // rather than folded in: a fix applied to `cap` closes both, and a fix applied to one caller
    // would leave this red.
    const out = oneLine(String.fromCodePoint(0x1f4a9).repeat(300))
    expect(loneSurrogatesIn(out)).toEqual([])
    expect(out.isWellFormed()).toBe(true)
  })

  it('documents the other half: an ill-formed value arrives ill-formed and leaves ill-formed', () => {
    // DELIBERATE, and the contrast with the two tests above is the point. A lone surrogate the
    // CALLER supplied is not in the control class, does not end a line and does not drive a
    // terminal, so passing it through is the same answer this module gives every other
    // unprintable-but-harmless character (see the bidi block above). The defect above was that
    // `cap` MANUFACTURED one out of a well-formed value — we may hand back what we were given,
    // and may not invent it.
    const lone = `co${String.fromCharCode(0xd83d)}dx`
    expect(oneLineEcho(lone)).toBe(lone)
    expect(oneLineEcho(lone).split(LF)).toHaveLength(1)
  })
})

describe('QA #108 — oneLine still means what it meant before it was strengthened', () => {
  // Everything in JavaScript's `\s` that is ALSO in the new control class. These are the
  // characters where the two passes could disagree, and the order in `oneLine` (collapse, THEN
  // replace) decides it: the collapse gets first refusal, so they still become a single space
  // and never a placeholder. That is not a detail — a digest heading is padded to a fixed
  // column, and a run of newlines turning into a row of placeholders instead of one space would
  // move every heading in `.ralph/digest.log`.
  const WHITESPACE_MEMBERS = {
    TAB: 0x09,
    LF: 0x0a,
    VT: 0x0b,
    FF: 0x0c,
    CR: 0x0d,
    'U+2028 LINE SEPARATOR': 0x2028,
    'U+2029 PARAGRAPH SEPARATOR': 0x2029,
  }

  it('collapses the whitespace members to one space, exactly as it did in lib/digest.js', () => {
    for (const [label, code] of Object.entries(WHITESPACE_MEMBERS)) {
      const char = String.fromCharCode(code)
      expect(oneLine(`a${char}b`), label).toBe('a b')
      expect(oneLine(`a${char.repeat(9)}b`), label).toBe('a b')
      // ...and at the edges they still TRIM away rather than surviving as a placeholder, which
      // is what keeps `oneLine('\n\n text \n')` equal to `'text'`.
      expect(oneLine(`${char}${char}text${char}`), label).toBe('text')
    }
    // The one that is NOT whitespace and is in the class: U+0085 NEL ends a line for a terminal
    // and is absent from `\s`, which is exactly why the class had to exist. It trims to nothing
    // in neither direction — it becomes a visible placeholder even at the edge.
    const NEL = String.fromCharCode(0x85)
    expect(oneLine(`${NEL}text${NEL}`)).toBe(`${PLACEHOLDER}text${PLACEHOLDER}`)
  })

  it('changes the length of nothing — one code point in, one out, for every newly-scrubbed byte', () => {
    // The property that makes the strengthening safe for every width-sensitive consumer
    // downstream. Swept over the whole class rather than sampled, because "the same length" is
    // the entire argument that no padding moved.
    for (let code = 0; code <= 0x9f; code += 1) {
      if (code > 0x1f && code < 0x7f) continue
      const value = `run-${String.fromCharCode(code)}-1`
      expect([...oneLine(value)], `U+${code.toString(16)}`).toHaveLength([...value].length)
      expect([...oneLineEcho(value)], `U+${code.toString(16)}`).toHaveLength([...value].length)
    }
  })

  it('is idempotent across the strengthened class, exhaustively over triples', () => {
    // lib/digest.qa.test.js pins idempotence over seven sample inputs, and lib/commands/digest.js
    // relies on it for real: it writes `oneLine(result.diagnostic)` where `diagnostic` was
    // already flattened by the engine. The strengthening added a pass that could break it — a
    // replacement that produced whitespace, or a placeholder the collapse then ate — so the
    // property is re-checked over every ordered triple drawn from the interesting code points
    // (the class, its boundaries, the placeholder, the whitespace that is not in the class, an
    // astral pair): 25^3 strings, both functions.
    const POOL = [
      0x00, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9b, 0x9f,
      0x2028, 0x2029, 0x20, 0xa0, 0xfeff, 0x200b, 0x202e, 0xfffd, 0x41, 0x1f600,
    ]
    const unstable = []
    for (const a of POOL) {
      for (const b of POOL) {
        for (const c of POOL) {
          const input = String.fromCodePoint(a) + String.fromCodePoint(b) + String.fromCodePoint(c)
          const label = [a, b, c].map((code) => code.toString(16)).join(',')
          for (const [name, fn] of [['oneLine', oneLine], ['oneLineEcho', oneLineEcho]]) {
            const once = fn(input)
            if (fn(once) !== once) unstable.push(`${name}(${label})`)
          }
        }
      }
    }
    expect(unstable).toEqual([])
    // ...and at the one place a second pass could plausibly differ: a capped value ends in an
    // ellipsis, which the next pass must not cap again into a shorter string.
    for (const fn of [oneLine, oneLineEcho]) {
      for (const length of [199, 200, 201, 400]) {
        const once = fn('x'.repeat(length))
        expect(fn(once), `${length}`).toBe(once)
      }
    }
  })

  it('is total for every primitive, and documents the one input that is not survivable', () => {
    // `String(text ?? '')` is total for primitives, and both functions are asked to flatten
    // exception messages and environment values that arrive from a caller's bag.
    for (const input of [undefined, null, '', 0, -0, 7, Number.NaN, Infinity, true, false, [], {}, 9007199254740993n]) {
      expect(typeof oneLine(input), String(input)).toBe('string')
      expect(typeof oneLineEcho(input), String(input)).toBe('string')
    }
    // A Symbol is special-cased by `String()` and survives; a `toString` that throws does not,
    // and the throw comes out of the coercion rather than out of the replacement. Pinned as a
    // gap rather than as a promise: neither function claims to be a guard against a hostile
    // object, and the callers that could hand one over are documented where they are
    // (lib/agent-registry.warning.qa.test.js).
    expect(oneLineEcho(Symbol('codx'))).toBe('Symbol(codx)')
    expect(() => oneLineEcho({ toString: () => { throw new Error('nope') } })).toThrow('nope')
    expect(() => oneLine(Object.create(null))).toThrow(TypeError)
  })
})

describe('QA #108 — the blast radius: oneLine feeds a padded heading and a parser', () => {
  // The strengthening reaches every `oneLine` caller, and one of them is not a stderr line: the
  // digest history HEADING is padded to a fixed column by lib/digest.js and parsed back by
  // lib/digest-history.js. `run_id` is read verbatim off disk (lib/run-state.js says it may be
  // hand-edited or from a future version) and `model` comes from RALPH_DIGEST_MODEL, so both are
  // strings a user can put a control character in — and both now come out as placeholders where
  // they used to come out raw. Nobody pinned what that does to the column or to the reader.
  const HOSTILE_RUN_IDS = {
    NUL: 0x00,
    BEL: 0x07,
    ESC: 0x1b,
    DEL: 0x7f,
    'U+0085 NEL': 0x85,
    'U+009B C1 CSI': 0x9b,
    LF: 0x0a,
    TAB: 0x09,
    'U+2028 LINE SEPARATOR': 0x2028,
  }

  for (const [label, code] of Object.entries(HOSTILE_RUN_IDS)) {
    it(`leaves the heading exactly 64 columns wide for a run id holding ${label}`, () => {
      const entry = formatHistoryEntry({
        at: '2026-01-01T00:00:00Z',
        runId: `r${String.fromCharCode(code)}1`,
        task: '#001',
        model: 'haiku',
        narrative: 'the loop is doing the thing',
      })
      const heading = entry.split(LF).find((line) => line.startsWith(HEADING_PREFIX))
      // The whole reason the 1:1 replacement matters: `heading()` computes its trailing rule as
      // `WIDTH - opened.length`, so a replacement that changed the length by one character would
      // shift the rule and a history file would stop skimming as a column of entries.
      expect([...heading]).toHaveLength(64)
      // Still ONE heading line and one blank-line-delimited block, which is the format's own
      // self-delimiting promise (`grep '^── '` counts entries exactly).
      expect(entry.split(LF).filter((line) => line.startsWith(HEADING_PREFIX))).toHaveLength(1)
      expect(controlsIn(heading)).toEqual([])
    })
  }

  it('still round-trips through the reader that parses what the writer writes', () => {
    // lib/digest-history.js anchors its heading regex on `\s─+$`, and a placeholder is not `\s`
    // — so a scrubbed run id has to stay on the FIELD side of that anchor rather than being read
    // as part of the padding. Driven through the real reader rather than through the regex.
    for (const [label, code] of Object.entries(HOSTILE_RUN_IDS)) {
      const entry = formatHistoryEntry({
        at: '2026-01-01T00:00:00Z',
        runId: `r${String.fromCharCode(code)}1`,
        task: '#001',
        model: 'haiku',
        narrative: 'the loop is doing the thing',
      })
      const parsed = parseLatestDigest(entry)
      expect(parsed, label).not.toBeNull()
      expect(parsed.task, label).toBe('#001')
      expect(parsed.model, label).toBe('haiku')
      // Three characters in, three characters out — a run id a reader can still match against
      // the record, with the unprintable one visible rather than silently gone.
      expect([...parsed.runId], label).toHaveLength(3)
      expect(controlsIn(parsed.runId), label).toEqual([])
    }
  })
})

describe('QA #108 — one-line.js imports nothing, checked against every loader form', () => {
  const SOURCE = readFileSync(ONE_LINE_JS, 'utf8')
  const CODE = codeWithoutComments(ONE_LINE_JS)

  // Every way a JavaScript module can reach another one, as a pattern set. The companion spec
  // checked three (`^\s*import\s`, `require(`, `from '`) and a DYNAMIC import walked past all
  // three: `await import('execa')` starts no line with `import` followed by whitespace, contains
  // no `require(` and contains no `from '`. It now names that fourth form as well — this block is
  // why — and the full set stays here, with its controls. The graph walk in
  // lib/commands/doctor.version-line.qa.test.js would catch it — which is the real gate — but
  // the claim this module makes about ITSELF should not be weaker than the claim made about it
  // from outside, because the local one is what a reader editing this file will look at.
  const LOADERS = {
    'a static import': /(^|[\s;])import[\s{*'"]/,
    'a dynamic import': /\bimport\s*\(/,
    'a re-export': /\bexport\s+(\{[^}]*\}|\*)\s*from\b/,
    'a bare from clause': /\bfrom\s*['"]/,
    'a require call': /\brequire\s*\(/,
    'createRequire': /createRequire/,
    'a process.binding': /process\s*\.\s*binding/,
    'an eval': /\beval\s*\(/,
    'a Function constructor': /\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"]/,
    'import.meta': /import\s*\.\s*meta/,
  }

  it('fires each loader pattern on a module that uses that form (positive control)', () => {
    // Without this, the sweep below is ten regexes nobody has seen match anything, and a typo in
    // one of them reads exactly like a clean module. Same argument the import-graph walks make
    // for naming the modules they reached.
    const SAMPLES = {
      'a static import': "import { execa } from 'execa'",
      'a dynamic import': "const { execa } = await import('execa')",
      'a re-export': "export { oneLine } from './digest.js'",
      'a bare from clause': "export * from 'execa'",
      'a require call': "const { execa } = require('execa')",
      createRequire: "const require = createRequire(import.meta.url)",
      'a process.binding': "const fs = process.binding('fs')",
      'an eval': "eval('import(\"execa\")')",
      'a Function constructor': "const load = new Function('s', 'return import(s)')",
      'import.meta': 'const here = import.meta.url',
    }
    for (const [label, pattern] of Object.entries(LOADERS)) {
      expect(SAMPLES[label], label).toBeTypeOf('string')
      expect(pattern.test(SAMPLES[label]), label).toBe(true)
    }
  })

  it('matches not one of them in lib/one-line.js', () => {
    // THE POINT OF THE WHOLE EXTRACTION. `ralph doctor` is on this module's downstream (doctor →
    // agent-registry → here) and doctor's bare-specifier set is pinned to four. One loader call
    // in this file — of any form, at any depth, including one hidden behind `await` — is a
    // dependency added to every command in the package.
    for (const [label, pattern] of Object.entries(LOADERS)) {
      expect(pattern.test(CODE), `${label} appears in lib/one-line.js`).toBe(false)
    }
    // ...and the prose is what makes that checkable: this module ARGUES about execa and
    // lib/digest.js in order to explain that it is neither, so a raw-text grep would fail on the
    // paragraph explaining the property. Asserted the way doctor.identity-box.qa.test.js asserts
    // the same thing about its own comment-stripping.
    expect(SOURCE, 'the prose should still name execa').toMatch(/execa/)
    expect(CODE, 'the code must not name execa').not.toMatch(/execa/)
  })

  it('reaches for no ambient capability either — no clock, no env, no randomness', () => {
    // Wider than the companion spec's five patterns. A pure function of its argument is what
    // makes both of these safe to call from a command that must work on a broken machine, and
    // it is also what makes the idempotence test above a property rather than an observation.
    for (const forbidden of [
      /process\s*\./,
      /globalThis/,
      /Date\b/,
      /Math\s*\.\s*random/,
      /\bfs\b/,
      /readFile|writeFile|existsSync/,
      /execa|spawn|(?<![.\w])exec\(/,
      /setTimeout|setInterval|queueMicrotask/,
      /\bawait\b|\basync\b/,
    ]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('holds no raw control byte, independently of the repo-wide guard', () => {
    // #107's sweep walks `git ls-files`, and while this module was still unstaged it sat outside
    // that guard's scope entirely, so "the suite is green" said nothing about it — which is why
    // the check was written here. From the commit that landed it the sweep covers the file too
    // and this becomes a deliberate duplicate, kept because it fails in the file about #108 and
    // names the line. Checked by CODE POINT — TAB, LF and CR excepted, which is exactly the
    // exemption test/helpers/source-control-bytes.js makes (TEXT_CONTROL_CODES) — so the file
    // cannot ship as something `file` calls `data` and grep skips in silence.
    const TEXTUAL = new Set([0x09, 0x0a, 0x0d])
    const offenders = []
    SOURCE.split(LF).forEach((line, index) => {
      for (const char of line) {
        const code = char.codePointAt(0)
        if ((code <= 0x1f || code === 0x7f) && !TEXTUAL.has(code)) {
          offenders.push(`lib/one-line.js:${index + 1}: U+${code.toString(16).toUpperCase().padStart(4, '0')}`)
        }
      }
    })
    expect(offenders, 'Re-spell it as a \\uXXXX escape — byte-identical at runtime, searchable on disk.').toEqual([])
    // ...and the class it forbids is spelled as escapes, which is the reason the file above is
    // clean rather than a coincidence.
    expect(SOURCE).toMatch(/\\u0000-\\u001F/)
    expect(SOURCE).toMatch(/\\u007F-\\u009F/)
    expect(SOURCE).toMatch(/\\u2028\\u2029/)
  })
})
