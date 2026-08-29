// QA augmentation for #122 — the SEAM itself, driven from both ends at once.
//
// #122 is a pure refactor: one ~900-line module that both decided what the identity box says
// and painted it became two, and the claim is that every byte of every box is where it was.
// banner-rows.test.js asserts the row list, the four banner-compose specs assert the frame, and
// banner-rows.qa.test.js holds the two against each other at the 60-column design width. This
// file is the part neither of them reaches: the SAME correspondence at every rung of #72's
// ladder, plus the properties the split newly made possible to get wrong.
//
// Five claims, and each one is a way the seam could tear while every existing spec stayed green:
//
//   1. ROW-FOR-LINE CORRESPONDENCE AT EVERY WIDTH. The rows are built in one module and painted
//      in another, so "one row in, one line out, in order, saying what the row said" is now a
//      CROSS-MODULE property. A row dropped, reordered, double-drawn or off by one on the far
//      side of the seam is invisible to a row-level spec and invisible to a frame-level spec
//      that builds its own expectations from the same composer. The oracle here is an
//      INDEPENDENT reimplementation of the gutter and the clip (nine lines, below), so the
//      comparison cannot be satisfied by both halves making the same mistake.
//
//   2. THE GUTTER IS EIGHT COLUMNS ON ONE SIDE OF THE SEAM AND SEVEN CHARACTERS ON THE OTHER.
//      `LABEL_WIDTH` stayed in lib/banner-compose.js and every label moved to
//      lib/banner-rows.js, and the only thing holding them together is a test — the dev's own
//      note says so. Both existing guards are SOURCE SWEEPS (a regex for `label:` literals, a
//      length check on the strings it finds). This asks the question the way a reader sees it:
//      in the rendered box, at boxed AND bare widths, does every value start at the same
//      column, with air after the longest label there is?
//
//   3. THE SEAM'S GATE ASYMMETRY IS A CONTRACT, NOT AN ACCIDENT. `bannerRows` pushes some
//      values RAW (documented: the frame half's `rowLine` is the funnel) and gates others in
//      the builder that concatenates them. That is fine for the one consumer that exists — and
//      it is a loaded gun for the second one, because `bannerRows` is now EXPORTED. So the set
//      of labels whose value still holds a control byte after `bannerRows` is pinned as a
//      literal: exactly one, `cwd`. A new pass-through row joins that list and the test says so.
//
//   4. THE PAINT INDEX. `render` splices an opener the ROW named, at offsets the FRAME
//      measured, into a line the frame chose the position of. An off-by-one introduced by the
//      split — the title counted as a row, a row list sliced one short — paints the wrong row's
//      value, at every colour-capable terminal, and no width or escape-balance assertion would
//      notice. Every escape found in the output is therefore traced back to the row that asked
//      for it.
//
//   5. PURITY OF A MODULE GRAPH, DEMONSTRATED IN A PROCESS OF ITS OWN. Both halves' purity is
//      pinned by static reads of one file each, and lib/banner-rows.js's own transitive edge
//      reaches lib/version-cache.js, which opens `node:fs`, `node:os` and (through
//      lib/utils/global-config.js) `XDG_CONFIG_HOME` — a capability no sweep of banner-rows.js
//      can see. #119 prefers a behavioural claim where one is available, and one is: a fresh
//      `node` with `process.env` replaced by a recording proxy imports both halves and composes
//      the box without reading one ralph-domain variable, calling one clock or drawing one
//      random number.
//
// Hermetic (#41): every fact is a string literal, and the one child process is given the
// composed box to print rather than any part of the developer's environment. Control bytes are
// built with `String.fromCharCode` and never typed, per #107.

import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ralphEnvSurface } from '../test/helpers/env-surface.js'
import { UNKNOWN, bannerRows, textOr } from './banner-rows.js'
import { BANNER_WIDTH, BOX_MIN_WIDTH, bannerLayout, composeBanner } from './banner-compose.js'

const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\\[[0-9]+m`, 'g')
const YELLOW = `${ESC}[33m`
const GREEN = `${ESC}[32m`
const COLOR_OFF = `${ESC}[39m`
const REPLACEMENT = String.fromCharCode(0xfffd)
const ELLIPSIS = '…'
// A separator for joining lines when the assertion is ABOUT control bytes: a newline would be
// one of the code points under test and would fail the sweep on the test's own scaffolding.
const SEPARATOR = '‖'
// Every code point lib/banner-rows.js's `CONTROL` gate is about, as a matcher rather than as a
// copy of it: C0 with TAB/LF/CR included (all three are instructions to a terminal, and the box
// replaces them), DEL and the whole C1 block whose U+009B is a single-byte CSI introducer.
const CONTROL_BYTES = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`, 'u')

const stripAnsi = (line) => line.replaceAll(ANSI, '')
const codePoints = (text) => [...text].length

// ---------------------------------------------------------------------------
// The oracle. Written from #72's prose and #68's gutter rule, NOT from either module — a
// comparison against a helper that imported `bannerLayout` or `clip` would be satisfied by any
// mistake both halves agreed on, which is precisely the failure a seam has.
// ---------------------------------------------------------------------------
const LABEL_WIDTH = 8

/** Cut to `columns`, the ellipsis REPLACING the last column rather than being added to it. */
const clipTo = (text, columns) => {
  if (columns <= 0) return ''
  const glyphs = [...text]
  return glyphs.length <= columns ? text : glyphs.slice(0, columns - 1).join('') + ELLIPSIS
}

/** #72's ladder, restated: a usable width, the 60-column cap, and the frame's own floor. */
const layoutOracle = (width) => {
  const whole = typeof width === 'number' && Number.isFinite(width) ? Math.floor(width) : 0
  const limit = whole >= 1 ? whole : BANNER_WIDTH
  return { limit, boxWidth: Math.min(limit, BANNER_WIDTH), boxed: limit >= BOX_MIN_WIDTH }
}

/** What each row line must READ, gutter and clip applied the way #68 describes them. */
const expectedContent = (facts, width) => {
  const { boxWidth, boxed } = layoutOracle(width)
  const inner = boxed ? Math.max(0, boxWidth - 4) : boxWidth
  return bannerRows(facts).map((row) =>
    clipTo(String(row.label).padEnd(LABEL_WIDTH) + textOr(row.value, UNKNOWN), inner),
  )
}

/** The composed box with the frame and the padding taken back off — one entry per row line. */
const contentOf = (lines, boxed) =>
  (boxed ? lines.slice(1, -1) : lines.slice(1)).map((line) => {
    const plain = stripAnsi(line)
    return boxed ? plain.slice(2, -2).trimEnd() : plain
  })

// Every width worth asking the question at: the two rungs and the column either side of each,
// the gutter boundary, the degenerate ones, and every shape that is not a width at all.
const WIDTHS = [
  undefined,
  null,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  -5,
  0,
  0.5,
  1,
  2,
  7,
  8,
  9,
  12,
  25,
  26,
  27,
  43,
  44,
  45,
  59,
  60,
  61,
  200,
  44.9,
  '80',
  1e9,
]

const LONG_PATH = `/Users/someone/repos/${'deeply-nested-'.repeat(6)}project`

const CASES = [
  ['nothing at all', {}],
  ['`ralph status`’s one-row box (#76)', { version: '0.22.0', cwd: '/repo' }],
  [
    '`ralph doctor`’s diagnostic box (#75)',
    { version: '0.22.0', cwd: '/repo', os: 'mac', agent: 'claude', cachedLatest: '0.22.0' },
  ],
  [
    'every row at once, values that fit (#69/#70)',
    {
      version: '0.22.0',
      latestVersion: '9.9.9',
      cwd: '/repo',
      os: 'mac',
      agent: 'claude',
      model: 'claude-opus-5',
      provenance: 'last-run',
      contextWindow: 1_000_000,
      source: 'github',
      repo: 'lucasfe/ralph',
      cachedLatest: '9.9.9',
      whatsNew: ['one', 'two', 'three'],
    },
  ],
  [
    'every row at once, values that must clip',
    {
      version: '1.0.0-alpha.20260101.build.1234+sha.abcdef0123456789',
      latestVersion: '9.9.9',
      cwd: LONG_PATH,
      os: 'mac',
      agent: 'claude',
      model: 'claude-opus-5-20260101-preview-extended-thinking',
      provenance: 'configured',
      contextWindow: 1_500_000.7,
      source: 'github',
      repo: `some-very-long-organisation-name/${'a'.repeat(40)}`,
      cachedLatest: '9.9.9',
      whatsNew: [`${'bullet text that runs well past the value column '.repeat(2)}end`, 'two'],
    },
  ],
  [
    'facts that are hostile in every slot at once',
    {
      version: `0.22.0${String.fromCharCode(0)}`,
      latestVersion: `9.9.9${ESC}[31m`,
      cwd: `/a${String.fromCharCode(10)}b`,
      os: { toString: () => 'mac' },
      agent: `claude${String.fromCharCode(13)}`,
      model: `gpt${ESC}[31m5`,
      provenance: 'configured',
      contextWindow: '1000000',
      source: `git${String.fromCharCode(0x9b)}hub`,
      repo: null,
      cachedLatest: `2.0.0${String.fromCharCode(7)}`,
      whatsNew: [`a${ESC}b`, null, 42, `${String.fromCharCode(9)}three`],
    },
  ],
]

describe('QA #122 seam — one row in, one line out, at every rung of the ladder', () => {
  for (const [name, facts] of CASES) {
    it(`draws the row list verbatim, in order, at every width — ${name}`, () => {
      let sawClip = false
      let sawWhole = false
      for (const width of WIDTHS) {
        const { limit, boxed } = layoutOracle(width)
        // The oracle and the module have to agree about the rung before the rows can be
        // compared at it; a disagreement here would make every row assertion below meaningless.
        expect(bannerLayout(width), String(width)).toEqual({
          width: limit,
          boxWidth: Math.min(limit, BANNER_WIDTH),
          boxed,
          sprite: limit >= 26,
        })
        const lines = composeBanner({ facts, width })
        const expected = expectedContent(facts, width)
        // ONE LINE PER ROW, plus the title, plus the bottom rule where there is a frame. This
        // is the count assertion that catches a row dropped or drawn twice on the far side of
        // the seam — the thing a per-row spec cannot see.
        expect(lines, `${name} @ ${width}`).toHaveLength(expected.length + (boxed ? 2 : 1))
        expect(contentOf(lines, boxed), `${name} @ ${width}`).toEqual(expected)
        // ...and the frame's own guarantee, restated over the same lines: nothing wider than
        // the width the caller gave us, measured in code points as this package promises. The
        // boxed form owes the stronger version of it — every line EXACTLY the box's width, or
        // the right border does not line up — while the bare form pads nothing by design.
        for (const line of lines) {
          expect(codePoints(line), `${name} @ ${width}`).toBeLessThanOrEqual(limit)
          if (boxed) expect(codePoints(line), `${name} @ ${width}`).toBe(Math.min(limit, BANNER_WIDTH))
        }
        if (expected.some((content) => content.includes(ELLIPSIS))) sawClip = true
        if (expected.some((content) => !content.includes(ELLIPSIS))) sawWhole = true
      }
      // Anti-vacuity, both directions: a table where nothing ever clipped would be a table
      // about `padEnd`, and one where everything clipped would never compare a whole sentence.
      expect(sawClip).toBe(true)
      expect(sawWhole).toBe(true)
    })
  }

  it('keeps the row ORDER across the seam, not merely the row set', () => {
    // The order is lib/banner-rows.js's decision and the frame draws what it is handed; the
    // failure this pins is a frame half that sorted, filtered or re-grouped. Asserted against
    // the labels rather than the values, because two rows can hold the same sentence (`update`
    // and `cached` say the identical thing when both are behind — which is #75's own design).
    const facts = CASES[3][1]
    const labels = bannerRows(facts).map((row) => row.label)
    expect(labels).toEqual(['update', 'os', 'agent', 'context', 'cached', 'cwd', 'source', 'repo', 'new', '', '', 'more'])
    for (const width of [60, 44, 43, 30]) {
      const { boxed } = layoutOracle(width)
      const drawn = contentOf(composeBanner({ facts, width }), boxed).map((content) => content.slice(0, LABEL_WIDTH).trim())
      expect(drawn, String(width)).toEqual(labels)
    }
  })

  it('draws the title from the ONE fact the frame half still knows, and never as a row', () => {
    // `version` is the box's subject and the only fact that did not cross the seam. A frame
    // half that started asking `bannerRows` for it would draw it twice; one that stopped
    // reading it would lose it entirely, and the row list would still compare equal.
    const facts = { version: '0.22.0', cwd: '/repo' }
    expect(bannerRows(facts).map((row) => row.label)).not.toContain('version')
    expect(composeBanner({ facts, width: 60 })[0]).toContain('ralph 0.22.0')
    expect(composeBanner({ facts, width: 20 })[0]).toBe('ralph 0.22.0')
    // ...and a version the caller could not read is the word for it, on both forms.
    expect(composeBanner({ facts: { cwd: '/repo' }, width: 20 })[0]).toBe(`ralph ${UNKNOWN}`)
  })
})

describe('QA #122 seam — the gutter, measured in the rendered box rather than swept for', () => {
  const FACTS = {
    version: '0.22.0',
    latestVersion: '9.9.9',
    cwd: '/repo',
    os: 'mac',
    agent: 'claude',
    model: 'opus',
    provenance: 'last-run',
    contextWindow: 1_000_000,
    source: 'github',
    repo: 'lucasfe/ralph',
    cachedLatest: '9.9.9',
    whatsNew: ['one', 'two'],
  }

  for (const width of [60, BOX_MIN_WIDTH, BOX_MIN_WIDTH - 1, 30, 26]) {
    it(`starts every value at the same column, ${width >= BOX_MIN_WIDTH ? 'boxed' : 'bare'} at ${width}`, () => {
      // The claim `LABEL_WIDTH` exists for, asked of the output: a reader's eye follows one
      // column down the box. It is worth asking at both forms because the bare form moves the
      // content two columns left (`frame.indent`) and a gutter measured from a literal 2 rather
      // than from the frame would tear exactly here.
      const rows = bannerRows(FACTS)
      const contents = contentOf(composeBanner({ facts: FACTS, width }), width >= BOX_MIN_WIDTH)
      expect(contents).toHaveLength(rows.length)
      contents.forEach((content, index) => {
        const { label } = rows[index]
        expect(content.slice(0, LABEL_WIDTH).trim(), label).toBe(label)
        // Air after the label, always — this is what a nine-character label would eat.
        if (label) expect(content[label.length], label).toBe(' ')
        // ...and the value begins at the gutter, never one column early or late: what stands
        // from column eight on is the row's own text, or as much of its front as fitted.
        const value = textOr(rows[index].value, UNKNOWN)
        const drawn = content.slice(LABEL_WIDTH)
        const whole = drawn.endsWith(ELLIPSIS) ? drawn.slice(0, -1) : drawn
        expect(value.startsWith(whole), `${label}: ${drawn}`).toBe(true)
        if (!drawn.endsWith(ELLIPSIS)) expect(drawn, label).toBe(value)
      })
    })
  }

  it('leaves the longest label one column of air, which is the whole of the eight', () => {
    // The arithmetic the gutter is, demonstrated rather than described: `context` is seven and
    // clears it; the nine-letter word #75 rejected would print with no air at all, which is
    // what `os` rather than `platform` was chosen to avoid. Neither string is production code
    // here — the point is that the number in lib/banner-compose.js and the labels in
    // lib/banner-rows.js are one decision held apart by nothing but this kind of assertion.
    const labels = bannerRows(FACTS).map((row) => row.label)
    expect(labels).toContain('context')
    for (const label of labels) expect(label.length, label).toBeLessThan(LABEL_WIDTH)
    expect('context'.padEnd(LABEL_WIDTH) + 'mac').toBe('context mac')
    expect('platform'.padEnd(LABEL_WIDTH) + 'mac').toBe('platformmac')
  })

  it('lets the clip run THROUGH the gutter rather than around it', () => {
    // The label is text like any other text, and at the widths where nothing is left the line
    // is still a line rather than a crash or a border with nothing inside it. Nine columns: the
    // gutter stands and the ellipsis takes the column the value would have started in. Eight:
    // the ellipsis eats the last column of the gutter itself. One: all that is left is the mark
    // that something was cut. Pinned because the gutter is padded in the frame half out of a
    // label that came from the row half, and "a padded label clips like text" is the property
    // that makes a nine-character label a cosmetic bug rather than a torn line.
    const facts = { version: '0.22.0', cwd: '/repo' }
    expect(composeBanner({ facts, width: 9 }).slice(1)).toEqual([`cwd     ${ELLIPSIS}`])
    expect(composeBanner({ facts, width: 8 }).slice(1)).toEqual([`cwd    ${ELLIPSIS}`])
    expect(composeBanner({ facts, width: 1 }).slice(1)).toEqual([ELLIPSIS])
  })
})

describe('QA #122 seam — which values cross it raw, pinned as a literal', () => {
  it('hands the frame half exactly one ungated value, and it is `cwd`', () => {
    // The gate travels with the row that CONCATENATES (the agent sentence, the bullets, the
    // two verdicts); a row that passes a scalar straight through is gated on the far side by
    // `rowLine`. That is a documented arrangement and it is sound for the one consumer that
    // exists — and `bannerRows` is exported now, so the arrangement is also a hazard with a
    // precise size. This is that size, as a list: any OTHER label appearing here is a value a
    // second consumer of `bannerRows` would print unsanitised, and the fix is a gate in the
    // builder rather than an edit to this expectation.
    const facts = CASES[5][1]
    const leaky = bannerRows(facts)
      .filter((row) => typeof row.value !== 'string' || CONTROL_BYTES.test(row.value))
      .map((row) => row.label)
    expect(leaky).toEqual(['cwd'])
    // ...and the frame half does sanitise it, which is why the box is safe today.
    const line = composeBanner({ facts, width: 60 }).find((text) => text.includes('cwd'))
    expect(line).toContain(`/a${REPLACEMENT}b`)
    expect(CONTROL_BYTES.test(line)).toBe(false)
  })

  it('gates every value it builds by concatenation, before the frame half ever sees it', () => {
    // The other half of the same claim, and the one that matters for a second consumer: the
    // rows that are SENTENCES are already clean when they leave this module.
    const facts = CASES[5][1]
    for (const row of bannerRows(facts)) {
      if (row.label === 'cwd') continue
      expect(typeof row.value, row.label).toBe('string')
      expect(CONTROL_BYTES.test(row.value), row.label).toBe(false)
    }
  })
})

describe('QA #122 seam — no control byte reaches a terminal, from any code point', () => {
  // The whole class, one code point at a time, rather than the handful a table usually names:
  // every C0 byte including TAB, LF and CR, then DEL and the entire C1 block. All 65 of them
  // go through the one fact that crosses the seam raw, at a boxed and a bare width.
  const C0 = Array.from({ length: 0x20 }, (_, index) => index)
  const C1 = Array.from({ length: 0xa0 - 0x7f }, (_, index) => 0x7f + index)
  const CODE_POINTS = [...C0, ...C1]

  for (const width of [60, 43]) {
    it(`replaces all 65 of them in cwd and emits none, at ${width} columns`, () => {
      expect(CODE_POINTS).toHaveLength(65)
      for (const code of CODE_POINTS) {
        const at = `U+${code.toString(16).padStart(4, '0')}`
        const cwd = `/a${String.fromCharCode(code)}b`
        const lines = composeBanner({ facts: { version: '0.22.0', cwd }, width })
        // Line by line rather than over a joined string: the separator a join would use is
        // itself one of the 65 code points under test.
        for (const line of lines) expect(CONTROL_BYTES.test(line), at).toBe(false)
        expect(lines.join(SEPARATOR), at).toContain(`/a${REPLACEMENT}b`)
        // ONE code point in, one out, on ONE line — the reason the frame's width accounting
        // needs no second pass over a sanitised value, and the reason a newline cannot become
        // a second row.
        expect(lines.filter((line) => line.includes(REPLACEMENT)), at).toHaveLength(1)
        expect(lines, at).toHaveLength(width >= BOX_MIN_WIDTH ? 3 : 2)
        for (const line of lines) expect(codePoints(line), at).toBeLessThanOrEqual(width)
      }
    })
  }

  it('cannot be made to forge a ROW out of a control byte, only to quote one', () => {
    // The attack the replacement exists to stop, and the distinction that makes the box safe.
    // A `cwd` carrying a newline and a frame glyph is trying to print a SECOND terminal row —
    // one no builder composed, that no width guarantee covers, and that a reader would take for
    // a fact about their machine. What it gets instead is one row, still exactly the box's
    // width, with its own forgery quoted inside it as text: the newline became a replacement
    // character, so the terminal never breaks the line and the frame's arithmetic never sees a
    // value it did not measure.
    const cwd = `/repo${String.fromCharCode(10)}│ os      pwned`
    const lines = composeBanner({ facts: { version: '0.22.0', cwd }, width: 60 })
    expect(lines).toHaveLength(3)
    const body = lines.slice(1, -1)
    expect(body).toHaveLength(1)
    expect(body[0].slice(2, 10)).toBe('cwd     ')
    expect(body[0]).toContain(`/repo${REPLACEMENT}`)
    for (const line of lines) {
      expect(CONTROL_BYTES.test(line)).toBe(false)
      expect(codePoints(line)).toBe(60)
      expect(line.endsWith('│') || line.endsWith('╮') || line.endsWith('╯')).toBe(true)
    }
  })

  it('leaves a lone surrogate alone and still counts it as exactly one column', () => {
    // NOT a control byte, deliberately — the gate is about instructions to a terminal, and a
    // path that really does contain an unpaired surrogate is a path, not an attack. What the
    // seam owes it is arithmetic: `[...text]` yields one element for a lone surrogate, so the
    // frame's padding and clip stay exact and the right border still lines up. A `split('')`
    // anywhere in either half would show up right here.
    for (const code of [0xd800, 0xdc00, 0xdbff]) {
      const cwd = `/a${String.fromCharCode(code)}b`
      const lines = composeBanner({ facts: { version: '0.22.0', cwd }, width: 60 })
      expect(lines.join('\n'), code.toString(16)).toContain(String.fromCharCode(code))
      expect(lines.join('\n'), code.toString(16)).not.toContain(REPLACEMENT)
      for (const line of lines) expect(codePoints(line), code.toString(16)).toBe(60)
    }
    // ...and a surrogate PAIR is one column too, which is the documented code-point promise
    // rather than a display-cell one.
    const pair = String.fromCodePoint(0x1f600)
    const long = `/${pair.repeat(60)}`
    for (const line of composeBanner({ facts: { version: '0.22.0', cwd: long }, width: 60 })) {
      expect(codePoints(line)).toBe(60)
    }
  })
})

describe('QA #122 seam — the paint the row named, on the line the row is', () => {
  const PAINTED = {
    version: '0.22.0',
    latestVersion: '9.9.9',
    cachedLatest: '0.22.0',
    cwd: '/repo',
    os: 'mac',
    agent: 'claude',
    whatsNew: ['one'],
  }

  it('traces every escape back to the row that asked for it, at every width', () => {
    // The off-by-one guard. `render` receives offsets from the frame and an opener from the
    // row, and the two are joined by nothing but the position of the line in an array — so a
    // frame half that counted the title as a row, or sliced the list one short, would paint a
    // neighbouring row's value in the colour of a verdict it does not hold. Checked at every
    // width, because the offsets are width-dependent and the bare form moves them two columns.
    const rows = bannerRows(PAINTED)
    expect(rows.filter((row) => row.paint).map((row) => row.label)).toEqual(['update', 'cached'])
    for (const width of WIDTHS) {
      const { boxed } = layoutOracle(width)
      const lines = composeBanner({ facts: PAINTED, width, capabilities: { color: true } })
      const body = boxed ? lines.slice(1, -1) : lines.slice(1)
      expect(body).toHaveLength(rows.length)
      body.forEach((line, index) => {
        const openers = [...line.matchAll(ANSI)].map((match) => match[0])
        if (openers.length === 0) return
        // A painted line is exactly one opener and one reset, in that order — never a lone
        // reset, never a nested pair, and never an opener the row did not name.
        expect(openers, `${width} row ${rows[index].label}`).toEqual([rows[index].paint, COLOR_OFF])
        expect(line.indexOf(rows[index].paint)).toBeLessThan(line.indexOf(COLOR_OFF))
      })
      // The title and the bottom rule are the frame's own bytes and hold no colour at all.
      expect(lines[0]).not.toContain(ESC)
      if (boxed) expect(lines.at(-1)).not.toContain(ESC)
    }
  })

  it('keeps the two colours meaning what the rows say they mean', () => {
    // #75's argument, restated across the seam: the frame half must hold no opinion about
    // which row is advice and which is a verdict. A `render` that decided from the label or
    // from the words in the value would pass every width and balance assertion in the suite.
    const behind = composeBanner({
      facts: { version: '0.22.0', latestVersion: '9.9.9', cachedLatest: '9.9.9', cwd: '/repo' },
      width: 60,
      capabilities: { color: true },
    })
    expect(behind.filter((line) => line.includes(YELLOW))).toHaveLength(2)
    expect(behind.filter((line) => line.includes(GREEN))).toHaveLength(0)
    const current = composeBanner({
      facts: { version: '0.22.0', cachedLatest: '0.22.0', cwd: '/repo' },
      width: 60,
      capabilities: { color: true },
    })
    expect(current.filter((line) => line.includes(GREEN))).toHaveLength(1)
    expect(current.filter((line) => line.includes(YELLOW))).toHaveLength(0)
  })

  it('emits not one escape byte with colour off, however painted the rows are', () => {
    // Both openers and the reset live in lib/banner-rows.js now and travel ON the records, so
    // "colour off means no bytes" is a claim about the frame half spending them — a row that
    // named a colour is still a row that named a colour with the capability withheld.
    for (const width of WIDTHS) {
      for (const capabilities of [{}, { color: false }, { color: 'true' }, { color: 1 }, undefined]) {
        const lines = composeBanner({ facts: PAINTED, width, capabilities })
        expect(lines.join('\n'), `${width} ${JSON.stringify(capabilities)}`).not.toContain(ESC)
      }
    }
  })

  it('changes not one visible column by being painted, at every width', () => {
    for (const width of WIDTHS) {
      const plain = composeBanner({ facts: PAINTED, width })
      const painted = composeBanner({ facts: PAINTED, width, capabilities: { color: true } })
      expect(painted.map(stripAnsi), String(width)).toEqual(plain)
    }
  })
})

describe('QA #122 seam — the window row at the boundaries the tables stop short of', () => {
  const windowOf = (contextWindow) =>
    bannerRows({ contextWindow }).find((row) => row.label === 'context')?.value

  const cases = [
    // The two abbreviation thresholds, from below and from exactly on them.
    [999, '999 tokens'],
    [1_000, '1k tokens'],
    [999_999, '999999 tokens'],
    [1_000_000, '1M tokens'],
    [1_000_000_000, '1000M tokens'],
    // Floored BEFORE the abbreviation, which is why this one is `1500k` and not `1500000`.
    [1_500_000.7, '1500k tokens'],
    [1_000_000.5, '1M tokens'],
    [1_000.9, '1k tokens'],
    // The largest count JS can state exactly still states itself, digit for digit.
    [Number.MAX_SAFE_INTEGER, `${Number.MAX_SAFE_INTEGER} tokens`],
  ]
  for (const [contextWindow, expected] of cases) {
    it(`says ${expected} for ${contextWindow}`, () => {
      expect(windowOf(contextWindow)).toBe(expected)
    })
  }

  const refused = [
    ['negative zero', -0],
    ['a window that floors to zero', 0.999_999],
    ['the smallest positive double', Number.MIN_VALUE],
    ['2^53, the first unsafe integer', 2 ** 53],
    ['a count with no digits to print', 1e21],
    ['a numeric string', '999999'],
    ['a boxed number', Object(1_000_000)],
    ['a bigint-shaped bag', { valueOf: () => 1_000_000, toString: () => '1M' }],
  ]
  for (const [name, contextWindow] of refused) {
    it(`draws no window row for ${name}`, () => {
      expect(windowOf(contextWindow)).toBeUndefined()
    })
  }

  it('keeps a sixteen-digit window inside the frame rather than tearing it', () => {
    // A number the box CAN state exactly is not necessarily a number that fits, and the two
    // halves answer that separately now: the row says the digits, the frame clips them.
    const facts = { version: '0.22.0', cwd: '/repo', contextWindow: Number.MAX_SAFE_INTEGER }
    for (const width of [60, 44, 30, 12]) {
      for (const line of composeBanner({ facts, width })) {
        expect(codePoints(line), String(width)).toBeLessThanOrEqual(Math.min(width, BANNER_WIDTH))
      }
    }
  })
})

describe('QA #122 seam — the edge runs one way, in whichever order Node loads them', () => {
  it('composes the same box whichever half is imported first', async () => {
    // A cycle between the two halves would not throw under ESM: one module would observe the
    // other half-initialised, on the first line of every run, and only in whichever order the
    // process happened to load them. The existing guard is a source sweep for the specifier;
    // this is the behaviour it stands for, and it fails on a cycle no sweep would recognise
    // (a re-export, a dynamic import, a third module in between).
    const facts = CASES[3][1]
    vi.resetModules()
    const rowsFirst = await import('./banner-rows.js')
    const frameAfter = await import('./banner-compose.js')
    const boxA = frameAfter.composeBanner({ facts, width: 60, capabilities: { color: true } })
    expect(rowsFirst.COLOR_OFF).toBe(COLOR_OFF)
    expect(frameAfter.BANNER_WIDTH).toBe(60)

    vi.resetModules()
    const frameFirst = await import('./banner-compose.js')
    const rowsAfter = await import('./banner-rows.js')
    const boxB = frameFirst.composeBanner({ facts, width: 60, capabilities: { color: true } })
    expect(rowsAfter.COLOR_OFF).toBe(COLOR_OFF)
    expect(frameFirst.BANNER_WIDTH).toBe(60)

    expect(boxB).toEqual(boxA)
    expect(boxA).toEqual(composeBanner({ facts, width: 60, capabilities: { color: true } }))
    vi.resetModules()
  })
})

describe('QA #122 seam — purity of the whole graph, in a process of its own (#119)', () => {
  // What a static read of either file cannot say. lib/banner-rows.js imports
  // lib/update-check.js, which imports lib/version-cache.js, which opens `node:fs`, `node:os`
  // and — through lib/utils/global-config.js — reads XDG_CONFIG_HOME. Every one of those is
  // legitimate where it lives and every one of them must stay behind a CALL, because this
  // module graph is evaluated before `ralph start`'s first preflight line and the box's whole
  // testability rests on nothing in it answering to the developer's shell (#41).
  //
  // So the claim is made the way #119 asks for it: behaviourally, in a fresh `node` where
  // `process.env` is a recording proxy installed BEFORE the import, and where the clock and
  // the random source are wrapped for the duration of the composition. The child prints the box
  // it drew; the parent compares it to the one this worker draws and audits what was read.
  const script = `
    const seen = []
    const proxy = new Proxy({}, {
      get(_target, key) { seen.push(String(key)); return undefined },
      has() { return false },
      ownKeys() { return [] },
      getOwnPropertyDescriptor() { return undefined },
    })
    Object.defineProperty(process, 'env', { value: proxy, configurable: true, writable: true })
    ;(async () => {
      const rows = await import(process.argv[1])
      const frame = await import(process.argv[2])
      const atImport = [...seen]
      seen.length = 0
      const calls = []
      const realNow = Date.now
      const realRandom = Math.random
      Date.now = () => { calls.push('Date.now'); return realNow() }
      Math.random = () => { calls.push('Math.random'); return 0 }
      const facts = JSON.parse(process.argv[3])
      const labels = rows.bannerRows(facts).map((row) => row.label)
      const lines = frame.composeBanner({ facts, width: 60, capabilities: { color: true } })
      Date.now = realNow
      Math.random = realRandom
      process.stdout.write(JSON.stringify({ atImport, atCompose: [...seen], calls, labels, lines }))
    })().catch((error) => { process.stdout.write(JSON.stringify({ error: String(error) })) })
  `
  const facts = {
    version: '0.22.0',
    latestVersion: '9.9.9',
    cwd: '/repo',
    os: 'mac',
    agent: 'claude',
    model: 'claude-opus-5',
    provenance: 'last-run',
    contextWindow: 1_000_000,
    source: 'github',
    repo: 'lucasfe/ralph',
    cachedLatest: '9.9.9',
    whatsNew: ['one', 'two'],
  }

  const child = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          script,
          new URL('./banner-rows.js', import.meta.url).href,
          new URL('./banner-compose.js', import.meta.url).href,
          JSON.stringify(facts),
        ],
        { encoding: 'utf8', cwd: fileURLToPath(new URL('../', import.meta.url)) },
      ),
    )

  it('imports both halves and draws the box without reading one ralph-domain variable', () => {
    const result = child()
    expect(result.error).toBeUndefined()
    // The audit is against #41's own derived surface rather than a list retyped here, so a knob
    // added to lib/ or to templates/ralph.config.sh is covered the day it lands. Node's own
    // loader reads names of its own (WATCH_REPORT_DEPENDENCIES, NODE_*) and those are not this
    // module graph's business.
    const ralphNames = new Set(ralphEnvSurface().map((entry) => entry.name))
    expect(result.atImport.filter((name) => ralphNames.has(name))).toEqual([])
    expect(result.atCompose.filter((name) => ralphNames.has(name))).toEqual([])
    // No clock and no randomness — a banner that read either would make its own spec
    // non-deterministic and would put a time-dependent line above a preflight.
    expect(result.calls).toEqual([])
  })

  it('draws in that process exactly the box this one draws', () => {
    // Anti-vacuity for the audit above, and a claim of its own: the two halves resolve as
    // plain ESM under a bare `node` — no vitest resolution, no transform — which is how an
    // installed Ralph loads them. A `banner-rows.js` missing from the published `files` would
    // be an unresolvable import on the first line of `ralph start`, and every suite in this
    // repo runs against a working tree where the file is always there.
    const result = child()
    expect(result.labels).toEqual(bannerRows(facts).map((row) => row.label))
    expect(result.lines).toEqual(composeBanner({ facts, width: 60, capabilities: { color: true } }))
    expect(result.lines.length).toBeGreaterThan(10)
  })
})
