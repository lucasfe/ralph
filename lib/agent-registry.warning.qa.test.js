import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { resolveAgent, VALID_AGENTS } from './agent-registry.js'

// #108 QA — the fallback WARNING, attacked at the source rather than at either printer.
//
// The fix's third acceptance criterion is architectural: the sanitisation lives in ONE place, at
// the source, so every caller inherits it. That claim cannot be tested by a printer test — a
// printer test proves that printer is safe today — so this file tests the sentence itself, and
// then pins the STRUCTURE that makes "every caller" true: how many places in lib/ compose the
// string `RALPH_AGENT='`, and how the resolver reaches the sanitiser without dragging execa onto
// `ralph doctor`'s import graph.
//
// WHO PRINTS IT IS NOT ASKED HERE ANY MORE (#119). A third sweep used to sit at the bottom of
// this file naming the modules that take `warning` back out of the resolver, and a source sweep
// is the wrong instrument for that question: it pins how the field is SPELLED rather than what
// reaches a user, so it read prose as code until #69 tightened it and then stopped seeing a
// property read afterwards. That claim is behavioural now and lives in
// lib/agent-registry.warning.consumers.qa.test.js, which drives every call site and asserts the
// line on the stream each one actually writes to. If a command starts or stops printing the
// warning, THAT file is where it shows up.
//
// Three things get attacked here that lib/agent-registry.test.js does not reach:
//
//   1. THE VALUE IS NOT NECESSARILY A STRING. `resolveAgent(env)` reads a caller's bag, and not
//      every caller hands over `process.env` — lib/commands/start.js, lib/commands/cycle.js and
//      lib/commands/init.js each assemble one. `process.env` coerces everything it stores
//      to a string, an assembled bag does not, and the sentence interpolates whatever comes
//      back. lib/banner-mode.js has a test for exactly this on RALPH_BANNER, so the precedent
//      for asking is already in the repo.
//   2. THE SENTENCE HAS A LENGTH. `oneLineEcho` caps the echo at 200, but the warning is the
//      echo plus 76 characters of wording, and the criterion is about what a TERMINAL does with
//      it. So the total is pinned, and so is the thing a truncation could plausibly eat: the
//      CLOSING QUOTE that tells a reader where the value they typed ended.
//   3. THE EMPTINESS GUARD RUNS BEFORE THE SANITISER. `String(raw).trim() === ''` is evaluated
//      first, which means (a) a hostile value that trims to nothing is reported as UNSET rather
//      than as a typo, and (b) a value whose coercion throws never reaches `oneLineEcho` at all.
//      Both are pinned, the second as a documented gap.
//
// Control characters are built from their code points, never typed (#107).

const LIB = fileURLToPath(new URL('.', import.meta.url))
const LF = String.fromCharCode(0x0a)
const CR = String.fromCharCode(0x0d)
const NUL = String.fromCharCode(0x00)
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const TAB = String.fromCharCode(0x09)
const VT = String.fromCharCode(0x0b)
const NEL = String.fromCharCode(0x85)
const DEL = String.fromCharCode(0x7f)
const LINE_SEP = String.fromCharCode(0x2028)
const PLACEHOLDER = String.fromCharCode(0xfffd)

const isControlCode = (code) =>
  code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
const controlsIn = (text) =>
  [...String(text)].map((char) => char.codePointAt(0)).filter(isControlCode)

const warn = (RALPH_AGENT) => resolveAgent({ RALPH_AGENT }).warning

describe('QA #108 — a warning is one line for anything a caller can put in the bag', () => {
  it('stays one line and control-free for every character in the class', () => {
    // Swept rather than sampled, at the level where the sentence is COMPOSED. The printers add
    // a prefix and a colour; if the sentence itself is single-line then no prefix can make it
    // two, which is what "at the source, so every caller inherits it" has to mean.
    const twoLiners = []
    for (let code = 0; code <= 0x9f; code += 1) {
      if (code > 0x1f && code < 0x7f) continue
      const value = `codx${String.fromCharCode(code)}tail`
      const warning = warn(value)
      if (warning == null) continue
      if (warning.split(LF).length !== 1 || warning.split(CR).length !== 1) {
        twoLiners.push(`U+${code.toString(16)}`)
      }
      if (controlsIn(warning).length) twoLiners.push(`U+${code.toString(16)} (control survived)`)
    }
    expect(twoLiners).toEqual([])
  })

  it('reports the ORIGINAL value, so a mistyped agent is still recognisable', () => {
    // The other half of criterion 2, and the reason the fix could not simply strip. A user who
    // set `CODX` sees `CODX`, not `codx`, and a user who set `  codx  ` learns that the padding
    // was not their problem — a diagnostic that silently normalises sends the reader looking
    // for a bug in the wrong place.
    expect(warn('CODX')).toContain("RALPH_AGENT='CODX'")
    expect(warn('  codx  ')).toContain("RALPH_AGENT='  codx  '")
    expect(warn(`codx${NUL}`)).toContain(`RALPH_AGENT='codx${PLACEHOLDER}'`)
  })

  it('says nothing at all when a hostile value still trims to a valid agent', () => {
    // A consequence of the ORDER inside resolveAgent that nobody has written down: the trim
    // happens before the lookup, so a value wrapped in line terminators resolves CLEANLY. This
    // is right — `RALPH_AGENT=$'codex\n'` out of a heredoc is the agent the user meant, not a
    // typo — but it means the sanitiser is not on the path at all for the most likely way a
    // newline gets into this variable, which is worth knowing when reading the fix.
    for (const wrapper of [LF, CR, TAB, VT, ' ', LINE_SEP]) {
      const result = resolveAgent({ RALPH_AGENT: `${wrapper}codex${wrapper}` })
      expect(result.agent, JSON.stringify(wrapper)).toBe('codex')
      expect(result.fellBack, JSON.stringify(wrapper)).toBe(false)
      expect(result.warning, JSON.stringify(wrapper)).toBeNull()
    }
    // ...and the characters the trim does NOT remove are exactly the ones that make the same
    // value a typo instead, which is where the echo earns its keep.
    for (const clinger of [NUL, ESC, BEL, NEL, DEL]) {
      const result = resolveAgent({ RALPH_AGENT: `codex${clinger}` })
      expect(result.agent, JSON.stringify(clinger)).toBe('claude')
      expect(result.fellBack, JSON.stringify(clinger)).toBe(true)
      expect(result.warning, JSON.stringify(clinger)).toContain(`'codex${PLACEHOLDER}'`)
    }
  })

  it('treats a value that is nothing but line terminators as UNSET, not as a typo', () => {
    // DOCUMENTED, because it is the branch a reader of the fix would most likely get wrong. The
    // emptiness guard trims with JavaScript's `\s`, so a value of pure LF/TAB/U+2028 is
    // indistinguishable from unset and produces NO warning and NO fallback flag — which is the
    // correct reading (`RALPH_AGENT=` in a config is a variable nobody set) and also means
    // criterion 1 is satisfied here by there being no line to emit at all.
    for (const value of [LF, `${LF}${LF}`, TAB, VT, ' ', LINE_SEP, `${LF}${TAB} `]) {
      const result = resolveAgent({ RALPH_AGENT: value })
      expect(result, JSON.stringify(value)).toEqual({
        agent: 'claude',
        fellBack: false,
        warning: null,
      })
    }
    // The C0 characters that are NOT `\s` do not trim away, so they DO warn, and the sentence
    // shows a value that is one visible placeholder — honest about a variable that is set to
    // something unprintable rather than pretending it is unset.
    expect(warn(NUL)).toContain(`RALPH_AGENT='${PLACEHOLDER}'`)
    expect(warn(`${' '}${NUL}`)).toContain(`RALPH_AGENT=' ${PLACEHOLDER}'`)
    expect(warn(NEL)).toContain(`RALPH_AGENT='${PLACEHOLDER}'`)
  })

  it('keeps warning and fellBack in agreement, whatever was passed', () => {
    // The invariant every caller relies on without checking: `ralph doctor` prints on `warning`
    // and telemetry records on `fellBack`, so a value that warns without flagging (or the
    // reverse) would make the two disagree about whether a typo happened.
    for (const value of [
      undefined, null, '', ' ', LF, 'claude', 'CODEX', ' codex ', 'codx', '0', 0, 1, true, false,
      `codex${NUL}`, `x${LF}y`, 'x'.repeat(500),
    ]) {
      const { fellBack, warning } = resolveAgent({ RALPH_AGENT: value })
      expect(Boolean(warning), JSON.stringify(String(value))).toBe(fellBack)
    }
  })
})

describe('QA #108 — the value is not necessarily a string', () => {
  // Not every caller of resolveAgent hands over `process.env`: lib/commands/start.js,
  // lib/commands/cycle.js and lib/commands/init.js each build a bag literal, and a bag literal
  // can hold anything — a number out of a parsed config, an array from a repeated CLI flag, an
  // object from a JSON settings file. `process.env` would have coerced all of these to strings on
  // assignment; a bag does not, and the warning interpolates the result either way.
  const COERCIBLE = {
    'a number': [7, "'7'"],
    'a negative number': [-1, "'-1'"],
    'NaN': [Number.NaN, "'NaN'"],
    'a boolean': [true, "'true'"],
    'a bigint': [7n, "'7'"],
    'an array of one': [['codx'], "'codx'"],
    'an array of two': [['codx', 'claude'], "'codx,claude'"],
    'a plain object': [{}, "'[object Object]'"],
    'a custom toString': [{ toString: () => 'codx' }, "'codx'"],
    'a Symbol': [Symbol('codx'), "'Symbol(codx)'"],
    'a function': [function codx() {}, null],
  }

  for (const [label, [value, expected]] of Object.entries(COERCIBLE)) {
    it(`survives ${label} and still emits exactly one line`, () => {
      const { agent, fellBack, warning } = resolveAgent({ RALPH_AGENT: value })
      expect(agent).toBe('claude')
      expect(fellBack).toBe(true)
      expect(warning.split(LF)).toHaveLength(1)
      expect(controlsIn(warning)).toEqual([])
      if (expected) expect(warning).toContain(`RALPH_AGENT=${expected}`)
    })
  }

  it('sanitises a non-string whose coercion produces a newline', () => {
    // The case that makes the block above load-bearing rather than pedantic: an object CAN
    // coerce to a two-line string, and then the guarantee is being asked of a value that was
    // never a string in the first place. `oneLineEcho` coerces internally, so it holds — but
    // nothing else in the suite drives a non-string through the sanitiser.
    const hostile = { toString: () => `codx${LF}│ agent   codex` }
    const warning = warn(hostile)
    expect(warning.split(LF)).toHaveLength(1)
    expect(warning).toContain(`RALPH_AGENT='codx${PLACEHOLDER}│ agent   codex'`)
    // ...and an array whose members carry the newline, since `String([a, b])` joins them raw.
    expect(warn([`a${LF}b`, 'c']).split(LF)).toHaveLength(1)
  })

  it('documents the gap: a value whose coercion THROWS escapes resolveAgent uncaught', () => {
    // NOT a #108 regression and NOT a fix this issue promised — pinned so it is a known
    // boundary rather than a surprise. The throw happens on the FIRST line of resolveAgent,
    // `String(raw).trim() === ''`, which is the emptiness guard; the sanitiser is never
    // reached, so no amount of hardening inside lib/one-line.js would change this. It is only
    // reachable through a caller-assembled bag (process.env stores strings), which is why it
    // has never been hit — but `resolveAgent` is an exported function of a module documented as
    // PURE and total, and #41's argument for injecting every seam is precisely that an exported
    // API gets called with things its author did not picture.
    expect(() => resolveAgent({ RALPH_AGENT: { toString: () => { throw new Error('nope') } } }))
      .toThrow('nope')
    expect(() => resolveAgent({ RALPH_AGENT: Object.create(null) })).toThrow(TypeError)
    expect(() => resolveAgent({ RALPH_AGENT: { [Symbol.toPrimitive]: () => Symbol('x') } }))
      .toThrow(TypeError)
  })

  it('is total for the BAG itself, which is the seam that actually varies', () => {
    // The counterweight to the test above: the missing/odd ENV is handled, by `env = {}` and by
    // `env?.RALPH_AGENT`. Worth pinning because a call site's bag is a parameter it was handed or
    // a literal it built — not necessarily `process.env` — and a diagnostic command may not crash
    // on a bag it was given.
    for (const bag of [undefined, {}, null, 0, '', false, Object.create(null), [], 'RALPH_AGENT']) {
      expect(resolveAgent(bag), JSON.stringify(bag)).toEqual({
        agent: 'claude',
        fellBack: false,
        warning: null,
      })
    }
  })
})

describe('QA #108 — the sentence has a length, and a closing quote', () => {
  // The wording around the echo: 13 characters of prefix (`RALPH_AGENT='`) and 63 of suffix
  // (`' unrecognized; falling back to 'claude'. Valid: claude, codex.`). With the echo capped at
  // 200 that is a hard ceiling of 276 — asserted as a number, because the point of a cap is that
  // somebody can reason about the worst case, and a cap on a substring of an unbounded sentence
  // is not a cap on anything.
  const CEILING = 276

  it('never exceeds 276 characters, however long the value was', () => {
    for (const length of [1, 100, 199, 200, 201, 1000, 100_000]) {
      const warning = warn('x'.repeat(length))
      expect(warning.length, `${length}`).toBeLessThanOrEqual(CEILING)
    }
    expect(warn('x'.repeat(100_000))).toHaveLength(CEILING)
  })

  it('keeps the closing quote on every side of the cap boundary', () => {
    // The interaction the cap makes possible: the echo is truncated INSIDE a quoted region, so
    // a cap that ate its own delimiter would produce `RALPH_AGENT='xxx…` and leave a reader
    // unable to tell where the value ended and our sentence began. Driven across 195–205 rather
    // than at 201, because a fencepost error shows up on one side of the boundary only.
    for (let length = 195; length <= 205; length += 1) {
      const warning = warn('x'.repeat(length))
      expect(warning, `${length}`).toMatch(/^RALPH_AGENT='/)
      expect(warning, `${length}`).toContain(
        `' unrecognized; falling back to 'claude'. Valid: ${VALID_AGENTS.join(', ')}.`,
      )
      // Exactly four quotes: the pair around the echo and the pair around the fallback name. A
      // value carrying quotes of its own is the case below; here the count IS the structure.
      expect([...warning].filter((c) => c === "'"), `${length}`).toHaveLength(4)
    }
  })

  it('does not escape a quote or a backslash in the value, on the record', () => {
    // DELIBERATE and worth pinning as such: the echo is not shell-quoted, so a value containing
    // `'` produces a sentence with an odd number of quotes. That is the honest rendering of what
    // was typed (criterion 2), and this warning is prose for a human rather than something
    // anyone re-executes — but a reader who assumed the quotes delimit reliably should find the
    // decision written down here rather than discover it.
    expect(warn("co'dx")).toContain("RALPH_AGENT='co'dx'")
    expect(warn('co\\dx')).toContain("RALPH_AGENT='co\\dx'")
    expect(warn('$(whoami)')).toContain("RALPH_AGENT='$(whoami)'")
    expect(warn('%s%n')).toContain("RALPH_AGENT='%s%n'")
  })

  it('leaves the echo the last variable part, so the wording cannot be pushed off the line', () => {
    // A cap only bounds the sentence if the CAPPED part is the only unbounded one. `DEFAULT_AGENT`
    // and `VALID_AGENTS` are module constants, so the suffix is fixed — pinned here so a future
    // agent name with a long label does not silently uncap the total above.
    expect(VALID_AGENTS).toEqual(['claude', 'codex'])
    const suffix = `' unrecognized; falling back to 'claude'. Valid: ${VALID_AGENTS.join(', ')}.`
    expect(suffix).toHaveLength(63)
    expect(warn('x').endsWith(suffix)).toBe(true)
  })
})

describe('QA #108 — the structure that makes "one place, at the source" true', () => {
  // Criterion 3 is a claim about the CODEBASE, not about a function, and the only way to test it
  // is to look at the codebase. What is left here after #119 is the half a sweep can answer
  // honestly — WHERE THE SENTENCE IS COMPOSED, and what the composing module imports — because
  // both are properties of the source rather than proxies for something a user can see. The sweep
  // runs over lib/ with comments stripped, since the prose in these modules discusses the very
  // strings being counted; the anti-vacuity check below is what keeps it from passing on nothing.
  const libFiles = (dir = LIB, acc = []) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) libFiles(path, acc)
      else if (entry.endsWith('.js') && !entry.includes('.test.')) acc.push(path)
    }
    return acc
  }
  const FILES = libFiles()

  it('composes the RALPH_AGENT warning in exactly one module', () => {
    // If a second module ever spells this sentence, the sanitiser is no longer at the source and
    // criterion 1 becomes a promise each author has to remember. The sweep looks for the
    // ASSIGNMENT-shaped prefix rather than the variable name, because `RALPH_AGENT` legitimately
    // appears in a dozen modules that read it.
    const composers = FILES.filter((path) => codeWithoutComments(path).includes("RALPH_AGENT='"))
    expect(composers.map((path) => path.slice(LIB.length)).sort()).toEqual(['agent-registry.js'])
  })

  it('sanity-checks that sweep by finding the modules that merely READ the variable', () => {
    // ANTI-VACUITY. A comment-stripping bug, a bad path join or an empty `FILES` would make the
    // assertion above pass by finding nothing anywhere. So the same sweep is made to find
    // something it must find: the variable name itself, in the resolver and in the config
    // reader that parses it out of ralph.config.sh.
    expect(FILES.length).toBeGreaterThan(40)
    const readers = FILES.filter((path) => codeWithoutComments(path).includes('RALPH_AGENT'))
      .map((path) => path.slice(LIB.length))
    expect(readers).toContain('agent-registry.js')
    expect(readers).toContain('read-config-agent.js')
    expect(readers.length).toBeGreaterThan(2)
  })

  it('reaches the sanitiser by a static import of the module that imports nothing', () => {
    // The other half of the fix's shape, and the reason it is a structural test: this module is
    // on `ralph doctor`'s import graph, whose bare-specifier set is pinned to four. The
    // sanitiser therefore had to be reachable from here WITHOUT dragging in lib/digest.js, which
    // imports execa — so the import is spelled as exactly one relative specifier, and the
    // absence of the other one is the assertion.
    const code = codeWithoutComments(join(LIB, 'agent-registry.js'))
    expect(code).toMatch(/import\s*\{\s*oneLineEcho\s*\}\s*from\s*'\.\/one-line\.js'/)
    expect(code).not.toMatch(/from\s*'\.\/digest\.js'/)
    expect(code).not.toMatch(/execa/)
    // ...and it is the ONLY import in the module, which is what makes the graph claim above a
    // property of this file rather than a fact about today's dependency tree.
    const imports = code.match(/^import\s.*$/gm) ?? []
    expect(imports).toHaveLength(1)
  })
})
