// #69 QA — adversarial specs for the FIVE ROWS the identity box grew for `ralph start`
// (`agent`, `context`, `source`, `repo`, and the model sentence inside the first of them).
//
// banner-compose.test.js proves the intended matrix: one literal 60-column box with all five
// rows, a wording table per provenance tag, a window table, one bare form at 30. This file
// attacks the same three builders from outside that matrix, along the four seams that make
// #69's rows different in kind from every row the box had before:
//
//   * ONE ROW IS BUILT FROM THREE FACTS. `agent — model (last run)` is the only row in this
//     box assembled by concatenation, and the sentence it assembles is a CLAIM ABOUT
//     CONFIDENCE: the model is evidence from the previous run, or from a knob, or absent. So
//     the assertions here are mostly negative and mostly about a string NOT being on screen —
//     a model named under the `unknown` tag, or a tag the box invented a sentence for, is a
//     defect of the kind the whole provenance mechanism exists to prevent.
//   * THE TAG IS A LOOKUP KEY A CALLER CONTROLS. `MODEL_SUFFIX` is a Map rather than an object
//     literal precisely so that `constructor` cannot answer for a tag nobody registered, and
//     that is a property worth asserting rather than trusting: an object literal here would
//     put `claude — claude-opus-5 (function Object() { … })` on a terminal.
//   * ONE ROW IS THE BOX'S FIRST NUMBER. Every other fact is text gated by `textOr`; the
//     window is a number gated by arithmetic, and it arrives from a JSON log line that a
//     RALPH_CONTEXT_WINDOW override is free to have written as anything finite. The row must
//     print a count a reader can match against the value they set, and it must print NO row
//     rather than a count the box worked out for itself.
//   * FOUR MORE FACTS REACH A TERMINAL. `agent` comes from an ambient environment variable,
//     `model` from a log file nobody reads as bytes, `repo` from `GH_REPO` or `.git/config`,
//     and `source` from a config file. Any of them can carry an LF, a CR, a bare ESC or a
//     U+009B, and any of those in an ungated row forges a line outside the width guarantee.
//     Asserted across the #72 width ladder, because a row added after the ladder shipped is
//     exactly where the ladder breaks.
//
// Control bytes are built with `String.fromCharCode` rather than embedded, for the reason
// test/source-control-bytes.test.js states: a raw one makes `file` call this source `data`
// and makes grep skip it silently. Escapes, glyphs and labels are spelled out rather than
// imported, so an expectation here cannot agree with a typo in the implementation's own
// constants. Nothing in this file reads an ambient environment, a clock or a real file (#41).

import { describe, expect, it } from 'vitest'
import { BANNER_WIDTH, SPRITE_MIN_WIDTH, composeBanner } from './banner-compose.js'

const ESC = String.fromCharCode(27)
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const PLACEHOLDER = String.fromCharCode(0xfffd)
const LABEL_WIDTH = 8
const VERTICAL = '│'

const stripAnsi = (line) => line.replace(SGR, '')
/** Code points, which is the measure the module pads, clips and promises in. */
const visibleWidth = (line) => [...stripAnsi(line)].length

const VERSION = '1.2.3'
const CWD = '/repo'
const MODEL = 'claude-opus-5'
const SOURCE = 'github issues'
const REPO = 'lucasfe/ralph'

// The fact bag `ralph start` passes in github mode with a last-run model resolved — every one
// of #69's five rows present at once, which is the shape each table below varies one fact of.
const START = {
  version: VERSION,
  agent: 'claude',
  model: MODEL,
  provenance: 'last-run',
  contextWindow: 1_000_000,
  cwd: CWD,
  source: SOURCE,
  repo: REPO,
}
/** The rows that bag draws, in order, under the title — the row SET as an expectation. */
const START_LABELS = ['agent', 'context', 'cwd', 'source', 'repo']

const compose = (facts = {}, options = {}) =>
  composeBanner({ facts: { version: VERSION, cwd: CWD, ...facts }, ...options })

/** A row by its label, in either line form — or undefined when no such row was drawn. */
const rowFor = (lines, label) =>
  lines.find((line) => {
    const text = stripAnsi(line)
    return (
      text.startsWith(`${VERTICAL} ${label.padEnd(LABEL_WIDTH)}`) ||
      text.startsWith(label.padEnd(LABEL_WIDTH))
    )
  })

/** A row's value — frame, gutter and right-hand padding removed. */
const valueOf = (lines, label) => {
  const row = rowFor(lines, label)
  if (row === undefined) return undefined
  const text = stripAnsi(row)
  const boxed = text.startsWith(`${VERTICAL} `)
  const inner = boxed ? text.slice(2, -2) : text
  return inner.slice(LABEL_WIDTH).trimEnd()
}

/**
 * Every label the box actually drew, in order — the row SET, as data.
 *
 * A row is identified by the SHAPE of its first eight columns: a lowercase word and then
 * nothing but padding. Narrower than "starts with a letter" on purpose, because the bare
 * form's title line starts with `ralph ` and would otherwise be counted as a row.
 */
const labelsOf = (lines) =>
  lines
    .map((line) => stripAnsi(line))
    .map((text) => (text.startsWith(`${VERTICAL} `) ? text.slice(2) : text).slice(0, LABEL_WIDTH))
    .filter((gutter) => /^[a-z]+ +$/.test(gutter))
    .map((gutter) => gutter.trim())

/** The whole box as one string, for the "this model is nowhere on screen" assertions. */
const screenful = (lines) => stripAnsi(lines.join(LF))

// The widths the layout branches on: the target, both rungs of #72's ladder, and the
// degenerate ones where a row has no room for its own label but still may not throw.
const USABLE_WIDTHS = [200, 80, 61, 60, 59, 45, 44, 43, 30, 27, 26, 25, 15, 12, 10, 9, 8, 5, 3, 1]

describe('QA #69 model rows — the window is a number, not a story about one', () => {
  it('draws NO window row for a count that floors to zero', () => {
    // THE FRACTIONAL WINDOW, and it is the one number in this feature the box can invent.
    // `windowTokens` refuses `0` and `-1` outright — the dev's own table pins both as no row
    // — but a value BETWEEN zero and one passes the `<= 0` guard, floors to 0, divides
    // exactly by a million, and comes back as the string `0M tokens`, which is truthy and so
    // earns a row. `context  0M tokens` is a context window no model has and no user set: a
    // number this box worked out for itself, which is precisely what the flooring comment
    // above `windowTokens` says it must never do.
    //
    // REACHABLE, not theoretical: lib/capture-issue-event.js accepts any
    // RALPH_CONTEXT_WINDOW that is `Number.isFinite(cw) && cw > 0`, so `0.5` is written to
    // the metrics log as `"context_window":0.5`; lib/banner-model.js's own
    // `positiveNumberOr` accepts it on the same terms and hands it here. Pinned end-to-end in
    // lib/commands/start.identity-facts.qa.test.js as well.
    for (const contextWindow of [0.5, 0.999, 0.000_001, 1e-7, 1e-323, Number.MIN_VALUE]) {
      const lines = compose({ ...START, contextWindow })
      expect(rowFor(lines, 'context'), String(contextWindow)).toBeUndefined()
      expect(labelsOf(lines), String(contextWindow)).toEqual(['agent', 'cwd', 'source', 'repo'])
    }
  })

  it('floors a fractional window ABOVE one rather than rounding it up', () => {
    // The other side of the same guard, and the side that is right: a count of 1.5 tokens is
    // 1 token, and a window one token short of a round million is not a million. Pinned
    // because rounding would be the tempting fix for the case above and would put a window on
    // screen that is larger than the one the run was given.
    for (const [contextWindow, expected] of [
      [1, '1 tokens'],
      [1.5, '1 tokens'],
      [1.999_999, '1 tokens'],
      [999.5, '999 tokens'],
      [1000.5, '1k tokens'],
      [999_999.9, '999999 tokens'],
      [1_000_000.4, '1M tokens'],
      [1_000_000.999, '1M tokens'],
      [200_000.5, '200k tokens'],
    ]) {
      expect(valueOf(compose({ ...START, contextWindow }), 'context'), String(contextWindow)).toBe(
        expected,
      )
    }
  })

  it('never writes a window in exponent notation', () => {
    // A window a reader cannot match against the number they set is the one thing the
    // abbreviation rule exists to prevent — that is the argument written above
    // `windowTokens`, and `1e+30 tokens` breaks it as surely as `1.5M tokens` would. Same
    // reachable knob as the fractional case: `Number('1e30')` is finite and positive, so
    // RALPH_CONTEXT_WINDOW=1e30 is accepted by lib/capture-issue-event.js, written to the log
    // and drawn here. Lower stakes than the fractional row — nothing is INVENTED, it is the
    // right number spelled unreadably — but it is still a row a user cannot act on.
    // `?? ''` because NO ROW is a way of never writing the notation, and the way this was
    // eventually fixed: a count JS cannot hold exactly is not stated at all (see
    // `windowTokens`). Kept as a guarantee about the row's TEXT rather than rewritten as
    // `toBeUndefined()`, so it still fails if a future scale cap starts spelling one instead.
    for (const contextWindow of [1e30, 1e40, 1e100, Number.MAX_VALUE]) {
      const value = valueOf(compose({ ...START, contextWindow }), 'context')
      expect(value ?? '', String(contextWindow)).not.toMatch(/e[+-]/i)
    }
  })

  it('closes the gap: a huge round window is no window at all', () => {
    // WHAT THE CAP REPLACED, which is what this expectation was written to record. The gap
    // pinned here was `1e21` dividing exactly by a million and printing the quotient in full —
    // `1000000000000000M tokens`, sixteen digits and an `M`. Arithmetically the number that was
    // passed, so it was pinned rather than demanded; unreadable, so it went the same way as the
    // exponent row above when `windowTokens` grew one rule for both: a count outside JS's exact
    // integer range is not a count this box states. `1e21` is past 2^53, so it is now no row.
    expect(valueOf(compose({ ...START, contextWindow: 1e21 }), 'context')).toBeUndefined()
  })

  it('draws no window row for anything that is not a positive finite number', () => {
    // The dev's table covers the list; this adds the shapes a JSON log and a hand-edited
    // config can actually hold and it adds the assertion that MATTERS about them — that the
    // agent row above is untouched, so a bad window costs its own row and nothing else.
    for (const contextWindow of [
      -0,
      -1e6,
      '1000000',
      '1M',
      1_000_000n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      null,
      false,
      true,
      [1_000_000],
      { valueOf: () => 1_000_000 },
      () => 1_000_000,
    ]) {
      const lines = compose({ ...START, contextWindow })
      expect(rowFor(lines, 'context'), String(contextWindow)).toBeUndefined()
      expect(valueOf(lines, 'agent'), String(contextWindow)).toBe(
        `claude — ${MODEL} (last run)`,
      )
    }
  })

  it('never runs a hostile window’s own arithmetic hooks', () => {
    // `typeof value !== 'number'` first is what makes this true, and it is a real property of
    // this gate rather than a coincidence: the value arrives from a parsed JSON line, and a
    // `Number(value)` here would hand control of a launch to whatever the log contained.
    const trap = {
      valueOf() {
        throw new Error('valueOf must never run')
      },
      toString() {
        throw new Error('toString must never run')
      },
      [Symbol.toPrimitive]() {
        throw new Error('Symbol.toPrimitive must never run')
      },
    }
    expect(() => compose({ ...START, contextWindow: trap })).not.toThrow()
    expect(rowFor(compose({ ...START, contextWindow: trap }), 'context')).toBeUndefined()
  })

  it('documents the gap: a window is drawn even when no model was named', () => {
    // A window is a property OF a model, so `context 1M tokens` under `agent claude — model
    // resolves at first run` is a row about a model the box just said it does not know. It is
    // expressible here because `contextRows` reads `facts.contextWindow` independently of the
    // agent row — and it is UNREACHABLE from every caller, because lib/banner-model.js never
    // returns a window without a model (asserted as a property over eleven input shapes in
    // lib/banner-model.qa.test.js). Pinned as current behaviour so that the day someone
    // couples the two rows, this is the test that tells them which decision they changed.
    const lines = compose({ ...START, provenance: 'unknown', model: null })
    expect(valueOf(lines, 'agent')).toBe('claude — model resolves at first run')
    expect(valueOf(lines, 'context')).toBe('1M tokens')
  })
})

describe('QA #69 model rows — never more confidence than the tag warrants', () => {
  // Every provenance value that is NOT one of the two registered tags, and what each one must
  // earn. The bag under it always carries a perfectly good model, so a row that names one is
  // a row that decided a sentence for a tag nobody wrote.
  //
  // The first five are the reason `MODEL_SUFFIX` is a Map: on an object literal,
  // `MODEL_SUFFIX['constructor']` is a function and `MODEL_SUFFIX['toString']` is another, so
  // each of them would put a chunk of JavaScript source inside the parentheses of a row.
  const UNREGISTERED = [
    ['constructor', 'claude'],
    ['__proto__', 'claude'],
    ['toString', 'claude'],
    ['valueOf', 'claude'],
    ['hasOwnProperty', 'claude'],
    ['prototype', 'claude'],
    // A tag whose case or spelling drifted: refused, which is the conservative direction —
    // evidence of an unrecognized kind claims nothing rather than picking a sentence.
    ['Last-Run', 'claude'],
    ['LAST-RUN', 'claude'],
    ['last run', 'claude'],
    ['lastrun', 'claude'],
    ['last-run-ish', 'claude'],
    ['Configured', 'claude'],
    ['UNKNOWN', 'claude'],
    ['un known', 'claude'],
    // ...and the tag that says there is no evidence, which names the agent and promises
    // nothing. Padded too, because `textOr` trims and a tag with a stray space is still that
    // tag.
    ['unknown', 'claude — model resolves at first run'],
    ['  unknown  ', 'claude — model resolves at first run'],
  ]

  for (const [provenance, expected] of UNREGISTERED) {
    it(`says ${JSON.stringify(expected)} for the tag ${JSON.stringify(provenance)}`, () => {
      const lines = compose({ ...START, provenance })
      expect(valueOf(lines, 'agent')).toBe(expected)
      // THE CLAIM THAT MATTERS: the model is not on the screen at all. Asserted against the
      // whole box rather than against the row, because a sentence assembled out of the wrong
      // pieces could put it anywhere.
      expect(screenful(lines)).not.toContain(MODEL)
      expect(screenful(lines)).not.toContain('last run')
      expect(screenful(lines)).not.toContain('configured')
      expect(screenful(lines)).not.toContain('function')
    })
  }

  it('names no model for a provenance that is not a string at all', () => {
    // The tag arrives from lib/banner-model.js today, but the box is a public function three
    // commands call and `textOr` refuses a non-string rather than coercing it — so every one
    // of these is "no tag", which is the bare row.
    for (const provenance of [
      undefined,
      null,
      42,
      0,
      true,
      false,
      {},
      [],
      ['last-run'],
      Symbol('last-run'),
      new Map([['last-run', 'last run']]),
      () => 'last-run',
    ]) {
      const lines = compose({ ...START, provenance })
      expect(valueOf(lines, 'agent'), String(provenance)).toBe('claude')
      expect(screenful(lines), String(provenance)).not.toContain(MODEL)
    }
  })

  it('accepts a padded registered tag, since the tag is trimmed like every other fact', () => {
    // The other direction, so the tests above cannot be satisfied by a gate that simply
    // refuses everything: a tag with whitespace around it is that tag, because `textOr` trims
    // before it looks — the same reading RALPH_CODEX_MODEL gets in lib/banner-model.js.
    expect(valueOf(compose({ ...START, provenance: ' last-run ' }), 'agent')).toBe(
      `claude — ${MODEL} (last run)`,
    )
    expect(
      valueOf(compose({ ...START, provenance: `${LF}configured${LF}` }), 'agent'),
    ).toBe(`claude — ${MODEL} (configured)`)
  })

  it('names no model when the model itself is unusable, whatever the tag claims', () => {
    // A tag with no model behind it is a shape the resolver never produces (it never tags a
    // missing model), so this is the box refusing to be talked into `claude — (last run)` —
    // a row that states nothing while looking like it states something.
    for (const model of [undefined, null, '', '   ', LF, `${CR}${LF}`, 42, 0, {}, [], true, () => MODEL]) {
      for (const provenance of ['last-run', 'configured']) {
        const lines = compose({ ...START, model, provenance })
        expect(valueOf(lines, 'agent'), `${provenance} / ${String(model)}`).toBe(
          'claude — model resolves at first run',
        )
        expect(screenful(lines), `${provenance} / ${String(model)}`).not.toContain('(last run)')
        expect(screenful(lines), `${provenance} / ${String(model)}`).not.toContain('(configured)')
      }
    }
  })

  it('draws no agent row at all when there is no agent to name', () => {
    // The gate that keeps `ralph status`'s and `ralph doctor`'s boxes byte-identical: a
    // caller that passes a model and a tag but no agent asked no question this box can answer,
    // so it gets no row — and the model it passed is nowhere on screen.
    for (const agent of [undefined, null, '', '   ', 42, {}, [], true]) {
      const lines = compose({ ...START, agent })
      expect(rowFor(lines, 'agent'), String(agent)).toBeUndefined()
      expect(screenful(lines), String(agent)).not.toContain(MODEL)
      // ...and the window row is not the agent row's keeper: it is drawn from its own fact.
      expect(valueOf(lines, 'context'), String(agent)).toBe('1M tokens')
    }
  })

  it('never runs a hostile fact’s toString, on any of the five new facts', () => {
    // `textOr` refuses non-strings instead of coercing them, and this is the assertion that
    // pins WHY: four of these five facts come from a file or an environment, and
    // `${agent} — ${model}` on an object would run whatever it carried.
    const ran = []
    const trap = (name) => ({
      toString() {
        ran.push(`${name}.toString`)
        return 'pwned'
      },
      valueOf() {
        ran.push(`${name}.valueOf`)
        return 'pwned'
      },
      [Symbol.toPrimitive]() {
        ran.push(`${name}.toPrimitive`)
        return 'pwned'
      },
    })
    const lines = compose({
      version: VERSION,
      cwd: CWD,
      agent: trap('agent'),
      model: trap('model'),
      provenance: trap('provenance'),
      contextWindow: trap('contextWindow'),
      source: trap('source'),
      repo: trap('repo'),
    })
    expect(ran).toEqual([])
    expect(screenful(lines)).not.toContain('pwned')
    expect(labelsOf(lines)).toEqual(['cwd'])
  })
})

describe('QA #69 model rows — five facts that reach a terminal', () => {
  // One entry per way a terminal can be instructed by something that is supposed to be a
  // fact. LF and CR END A LINE — a returned string containing either is two terminal rows,
  // the second composed by nobody and covered by no width guarantee. ESC opens a sequence;
  // U+009B is the same attack with no ESC to grep for; U+0085 is C1's own line break; U+007F
  // is DEL. All of them are one code point in and one code point out, so the width accounting
  // stays exact.
  const CONTROLS = [
    ['LF', LF],
    ['CR', CR],
    ['ESC', ESC],
    ['C1 CSI (U+009B)', String.fromCharCode(0x9b)],
    ['NEL (U+0085)', String.fromCharCode(0x85)],
    ['DEL (U+007F)', String.fromCharCode(0x7f)],
    ['NUL', String.fromCharCode(0)],
    ['TAB', String.fromCharCode(9)],
    ['VT', String.fromCharCode(11)],
    ['FF', String.fromCharCode(12)],
    ['BEL', String.fromCharCode(7)],
    ['SO', String.fromCharCode(14)],
  ]

  for (const [label, control] of CONTROLS) {
    it(`replaces a ${label} in the agent, the model, the source and the repo`, () => {
      // Embedded BETWEEN two segments, never leading or trailing: a fact that is nothing but
      // a control byte trims to blank and reads as a fact nobody gave us, which is a
      // different case (covered above). This one is a real value with something unprintable
      // in it, and it must survive AS such — replaced, never stripped, or the box would be
      // reporting an agent and a repository that are not the ones it was handed.
      const lines = compose(
        {
          ...START,
          agent: `cla${control}ude`,
          model: `opus${control}5`,
          source: `git${control}hub`,
          repo: `o${control}/n`,
        },
        { capabilities: { color: true } },
      )
      // The claim about the RETURN VALUE: five rows, a title and a closer, and not one of
      // them is two terminal lines pretending to be one.
      expect(lines).toHaveLength(7)
      for (const line of lines) {
        expect(line, JSON.stringify(line)).not.toMatch(/[\n\r]/)
        expect(stripAnsi(line), JSON.stringify(line)).not.toContain(ESC)
        expect(stripAnsi(line), JSON.stringify(line)).not.toContain(String.fromCharCode(0x9b))
        expect(visibleWidth(line), JSON.stringify(line)).toBe(BANNER_WIDTH)
      }
      // ...and the values still say what they were given, with the byte marked rather than
      // deleted.
      expect(valueOf(lines, 'agent')).toBe(
        `cla${PLACEHOLDER}ude — opus${PLACEHOLDER}5 (last run)`,
      )
      expect(valueOf(lines, 'source')).toBe(`git${PLACEHOLDER}hub`)
      expect(valueOf(lines, 'repo')).toBe(`o${PLACEHOLDER}/n`)
      expect(labelsOf(lines)).toEqual(START_LABELS)
    })
  }

  for (const [label, control] of CONTROLS) {
    it(`holds the frame with a ${label} in every new fact, at every usable width`, () => {
      // The same poison across #72's ladder, because a control byte and a clip are the two
      // mechanisms that can break a line and this is where they meet: the gate runs in the
      // builder, the clip runs in `render`, and a byte that survived the first would be
      // measured by the second as one column of nothing.
      for (const width of USABLE_WIDTHS) {
        const lines = compose(
          {
            ...START,
            agent: `cla${control}ude`,
            model: `opus${control}5`,
            source: `git${control}hub`,
            repo: `o${control}/n`,
          },
          { width, capabilities: { color: true } },
        )
        // Seven lines boxed (title, five rows, closer); six bare, which has no closer.
        expect(lines, `${label} @ ${width}`).toHaveLength(width >= 44 ? 7 : 6)
        for (const line of lines) {
          const context = `${label} @ ${width}: ${JSON.stringify(line)}`
          expect(line, context).not.toMatch(/[\n\r]/)
          expect(visibleWidth(line), context).toBeLessThanOrEqual(width)
          // No escape at all: none of #69's rows is painted, so a colour capability changes
          // nothing about them and an ESC on one of these lines came from a fact.
          expect(line, context).not.toContain(ESC)
        }
      }
    })
  }

  it('cannot be made to forge a row, a frame or a closing border', () => {
    // The attack the LF gate exists for, spelled out as the thing an attacker would actually
    // write: a model id out of a metrics log that a foreign writer appended to, carrying a
    // whole extra row — and the repo slug version of the same, which would put a repository
    // on screen that the loop is not about to read.
    const forgeries = [
      `${MODEL}${LF}${VERTICAL} repo    evil/repo                                     ${VERTICAL}`,
      `${MODEL}${CR}${LF}repo    evil/repo`,
      `${MODEL}${LF}╰──────────────────────────────────────────────────────────╯`,
      `${MODEL}${LF}${LF}${LF}`,
      `${MODEL}${ESC}[2K${ESC}[1A`,
      `${MODEL}${String.fromCharCode(0x9b)}31m`,
    ]
    for (const forged of forgeries) {
      for (const key of ['model', 'agent', 'source', 'repo']) {
        const lines = compose({ ...START, [key]: forged })
        const context = `${key}: ${JSON.stringify(forged)}`
        // Seven lines in, seven lines out; exactly one closing border; and the ROW SET is
        // unchanged — the forged `repo` row is text inside somebody else's row, never a row.
        expect(lines, context).toHaveLength(7)
        expect(lines.filter((line) => line.startsWith('╰')), context).toHaveLength(1)
        expect(labelsOf(lines), context).toEqual(START_LABELS)
        expect(lines.join(''), context).not.toContain(ESC)
        for (const line of lines) expect(visibleWidth(line), context).toBe(BANNER_WIDTH)
        // ...and the row that actually names the repository still names the real one. This is
        // the assertion that matters for the requirement: the forged text is visible (the gate
        // REPLACES the newline, it does not delete the characters around it) but it is on the
        // agent row, marked with a placeholder, while `repo` says what the caller passed.
        if (key !== 'repo') expect(valueOf(lines, 'repo'), context).toBe(REPO)
      }
    }
  })

  it('cannot be made to forge a row through the provenance tag either', () => {
    // The tag is the one fact that is a LOOKUP rather than a value, so a forged row in it can
    // only reach the screen through the `unknown` comparison — which it fails, leaving the
    // bare row. Worth its own test because it is the one fact whose gate is a Map miss rather
    // than a replacement.
    const forged = `unknown${LF}${VERTICAL} repo    evil/repo${VERTICAL}`
    const lines = compose({ ...START, provenance: forged })
    expect(lines).toHaveLength(7)
    expect(valueOf(lines, 'agent')).toBe('claude')
    expect(screenful(lines)).not.toContain('evil/repo')
  })
})

describe('QA #69 model rows — the ladder crossed with all five rows', () => {
  it('draws the same row SET at every usable width', () => {
    // A row added after #72's ladder shipped is exactly where the ladder breaks, and the
    // property that catches it is that the row COUNT does not depend on the width: the bare
    // form is the same rows in a different frame, never fewer rows. The label set is asserted
    // only where the eight-column gutter itself survives the clip — below that there is no
    // label left to read, which is the clip working.
    for (const width of USABLE_WIDTHS) {
      const lines = compose(START, { width })
      expect(lines, String(width)).toHaveLength(width >= 44 ? 7 : 6)
      // The labels are only READABLE down to the sprite rung: below it the clip eats into the
      // eight-column gutter itself and replaces its tail with an ellipsis, which is the clip
      // doing its job rather than a row going missing — the length assertion above is what
      // covers the rows nobody can label any more.
      if (width >= SPRITE_MIN_WIDTH) {
        expect(labelsOf(lines), String(width)).toEqual(START_LABELS)
      }
      for (const line of lines) {
        expect(visibleWidth(line), `${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width)
      }
    }
  })

  it('carries all five rows through the sprite rung', () => {
    // 26 columns is where the box becomes a bare list (#72's SPRITE_MIN_WIDTH), and it is the
    // width at which #69's rows are most likely to be dropped by a layout that treats them as
    // optional decoration. They are not: they are the answer to "which agent, which model,
    // which repo", which is exactly what a reader on a narrow terminal is checking.
    const lines = compose(START, { width: SPRITE_MIN_WIDTH })
    expect(labelsOf(lines)).toEqual(START_LABELS)
    for (const line of lines) {
      expect(line).not.toContain(VERTICAL)
      expect(visibleWidth(line)).toBeLessThanOrEqual(SPRITE_MIN_WIDTH)
    }
    // The long sentence is clipped rather than wrapped — one fact, one line, always, with the
    // ellipsis that says so.
    const sentence = valueOf(lines, 'agent')
    expect(sentence).toHaveLength(SPRITE_MIN_WIDTH - LABEL_WIDTH)
    expect(sentence.endsWith('…')).toBe(true)
  })

  it('clips a very long model id and a very long slug without losing a row', () => {
    // Neither value has a length limit anywhere upstream: a model id comes out of an agent's
    // stream and a slug out of `GH_REPO`, and both are text. A megabyte of it is one clipped
    // row, at every width, and it may not cost the rows under it.
    const long = 'm'.repeat(200_000)
    for (const width of [200, 60, 44, 30, 26, 12, 1]) {
      const lines = compose({ ...START, model: long, repo: `${long}/${long}` }, { width })
      expect(lines.length, String(width)).toBeGreaterThanOrEqual(6)
      for (const line of lines) {
        expect(visibleWidth(line), String(width)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('is a function of its facts alone, and mutates none of them', () => {
    // The bag is assembled by `ralph start` out of a config file, an environment and a
    // resolver's answer, and it is passed to nothing else — but the box being pure is what
    // makes every table in this file a table rather than a sequence.
    const facts = { ...START, whatsNew: ['one', 'two'] }
    const snapshot = JSON.stringify(facts)
    const first = compose(facts, { width: 60 })
    const second = compose(facts, { width: 60 })
    expect(JSON.stringify(facts)).toBe(snapshot)
    expect(first).toEqual(second)
  })
})
