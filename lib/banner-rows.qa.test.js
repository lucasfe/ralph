// QA augmentation for #122 — the extraction's seam, attacked from the side its own spec
// cannot see.
//
// The refactor's claim is that NOTHING OBSERVABLE CHANGED: one ~900-line module that both built
// rows and painted them became two, and the box every one of `ralph start`, `ralph doctor` and
// `ralph status` prints is byte-identical. banner-rows.test.js pins the row list as a contract —
// which fact earns which sentence, in which order — and it is the wrong file to make the claim
// that matters, because it can only ever hold one half of the seam against itself:
//
//   1. THE AGREEMENT IS A CROSS-MODULE PROPERTY. `bannerRows` returning the right list proves
//      nothing about what a reader sees; `composeBanner` is what writes the terminal, and a row
//      dropped, reordered or double-drawn on the far side of the seam is exactly the defect a
//      row-level spec cannot detect. So the table below drives BOTH halves with one facts object
//      and requires the composed box, frame and padding stripped off, to be the row list
//      verbatim — including which rows are painted and which are not.
//
//   2. THE FRAME HALF'S IGNORANCE IS THE POINT, AND IT IS A CLAIM ABOUT SOURCE. "The row half is
//      pure text, the frame half knows nothing about facts" is not visible in any rendered line —
//      both arrangements draw the same box. It is a question about the text (#119's rule for when
//      a sweep is the honest instrument), so it is asked as one: after the split
//      lib/banner-compose.js names exactly ONE fact, the title's subject, and not one row label.
//
//   3. A SEAM CAN BE A CYCLE, AND ESM WOULD NOT SAY SO. If the rows half ever reached back for
//      `clip` or a column count, one module would observe the other half-initialised — on the
//      first line of a run, and only in whichever order Node happened to load them. The same
//      guard lib/sprite-banner.qa.test.js makes about the ladder, re-aimed at the new edge.
//
//   4. PURITY WAS ONE FILE'S CLAIM AND IS NOW TWO. A purity guard that quietly covers half of
//      what it used to cover is worse than none, so the trip-wire demonstration
//      banner-compose.qa.test.js makes for the composer is re-made here for the assembler alone.
//
// Hermetic and pure: every case is a string literal, exactly as #41 requires. The one exception
// is the source block, which reads this repository's own text, which is what a structural guard
// is.

import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { COLOR_OFF, UNKNOWN, bannerRows, textOr } from './banner-rows.js'
import { BANNER_WIDTH, composeBanner } from './banner-compose.js'

const YELLOW = '\u001B[33m'
const GREEN = '\u001B[32m'
const stripAnsi = (line) => line.replaceAll(/\u001B\[\d+m/g, '')
/** The frame's own gutter, which is the one number this side of the seam has to know. */
const LABEL_WIDTH = 8

/**
 * The composed box with the frame taken off — the content of each row line, in order.
 *
 * `slice(1, -1)` drops the title and the bottom rule; `slice(2, -2)` drops `│ ` and ` │`; the
 * `trimEnd` drops the padding that lines the right border up. What is left is exactly what
 * `rowLine` was handed, which is what makes the comparison below a claim about the seam rather
 * than about the box's decoration.
 */
const contentOf = (lines) => lines.slice(1, -1).map((line) => stripAnsi(line).slice(2, -2).trimEnd())

/** The same rows, spelled the way the frame half is obliged to spell them. */
const expectedContent = (facts) =>
  bannerRows(facts).map((row) => String(row.label).padEnd(LABEL_WIDTH) + textOr(row.value, UNKNOWN))

// Every facts object worth driving through both halves at once. Values are kept short on
// purpose: at 60 columns a value has 48, and a clip here would be the frame half doing its job
// and would make the comparison a test of `clip` instead of of the seam.
const CASES = [
  ['nothing at all', {}],
  ['`ralph status`’s one-row box (#76)', { version: '0.22.0', cwd: '/repo' }],
  [
    '`ralph doctor`’s diagnostic box (#75)',
    { version: '0.22.0', cwd: '/repo', os: 'mac', agent: 'claude', cachedLatest: '0.22.0' },
  ],
  [
    '`ralph doctor` with an update waiting',
    { version: '0.22.0', cwd: '/repo', os: 'mac', agent: 'claude', cachedLatest: '9.9.9' },
  ],
  [
    '`ralph start`’s box, every row at once (#69/#70)',
    {
      version: '0.22.0',
      latestVersion: '9.9.9',
      cwd: '/repo',
      agent: 'claude',
      model: 'claude-opus-5',
      provenance: 'last-run',
      contextWindow: 1_000_000,
      source: 'github',
      repo: 'lucasfe/ralph',
      whatsNew: ['one', 'two', 'three'],
    },
  ],
  [
    'a Codex project on its first ever start',
    {
      version: '0.22.0',
      cwd: '/repo',
      agent: 'codex',
      model: 'gpt-5-codex',
      provenance: 'configured',
      contextWindow: 400_000,
      source: 'folder',
    },
  ],
  [
    'facts that are all hostile at once',
    {
      version: '0.22.0',
      cwd: '/a\u0000b',
      agent: { toString: () => 'claude' },
      model: 'gpt\u001B[31m5',
      provenance: 'configured',
      contextWindow: '1000000',
      source: 'git\nhub',
      repo: null,
      whatsNew: ['a\u001Bb', null, 42],
    },
  ],
]

describe('QA banner-rows — the two halves of the box agree, row for row (#122)', () => {
  for (const [name, facts] of CASES) {
    it(`draws exactly the rows it built, in order, for ${name}`, () => {
      const lines = composeBanner({ facts, width: BANNER_WIDTH })
      expect(contentOf(lines)).toEqual(expectedContent(facts))
      // Anti-vacuity: the comparison is worthless if either side produced nothing.
      expect(expectedContent(facts).length).toBeGreaterThan(0)
      expect(lines.length).toBe(expectedContent(facts).length + 2)
    })

    it(`paints exactly the rows that named a colour, for ${name}`, () => {
      // The other half of what a row record carries. `render` is the only place an escape byte
      // is written and it spends whichever opener the ROW handed it, so a row that named no
      // colour must reach the terminal with no escape on its line at all — and one that did
      // must carry that opener and the single reset both colours share.
      const rows = bannerRows(facts)
      const lines = composeBanner({ facts, width: BANNER_WIDTH, capabilities: { color: true } })
      rows.forEach((row, index) => {
        const line = lines[index + 1]
        if (row.paint) {
          expect(line, row.label).toContain(row.paint)
          expect(line, row.label).toContain(COLOR_OFF)
        } else {
          expect(line, row.label).not.toContain('\u001B')
        }
      })
    })
  }

  it('is the only source of rows: a colour it never names is never painted', () => {
    // The inverse of the pair above, and the reason it earns a case of its own: the frame half
    // must not have kept an opinion of its own about which row means what. #75 removed exactly
    // that (a `render` that decided from the label, or from whether the value held the word
    // "available"), and the split is the moment such an opinion could come back unnoticed.
    const facts = { version: '0.22.0', cwd: '/repo', latestVersion: '9.9.9', cachedLatest: '0.22.0' }
    const painted = new Set(bannerRows(facts).filter((row) => row.paint).map((row) => row.label))
    expect(painted).toEqual(new Set(['update', 'cached']))
    const lines = composeBanner({ facts, width: BANNER_WIDTH, capabilities: { color: true } })
    expect(lines.filter((line) => line.includes('\u001B'))).toHaveLength(2)
    expect(lines.find((line) => stripAnsi(line).includes('update'))).toContain(YELLOW)
    expect(lines.find((line) => stripAnsi(line).includes('up to date'))).toContain(GREEN)
  })

  it('every record is the exact shape the frame half reads, and nothing more', () => {
    // `rowLine` destructures `{ label, value, paint }` and `render` refuses to splice an
    // opener it was not given. A record carrying a fourth key, or a `paint` that is not one of
    // the two openers, would be a row form the frame half has no contract for — and the failure
    // mode is bytes, not an exception: a `paint: true` would splice the literal `true` into a
    // terminal line.
    for (const [, facts] of CASES) {
      for (const row of bannerRows(facts)) {
        expect(Object.keys(row).sort()).toEqual(
          row.paint === undefined ? ['label', 'value'] : ['label', 'paint', 'value'],
        )
        expect(typeof row.label).toBe('string')
        if (row.paint !== undefined) expect([YELLOW, GREEN]).toContain(row.paint)
      }
    }
  })
})

describe('QA banner-rows — purity, demonstrated rather than read', () => {
  it('builds the whole list with Date, Math.random and process trip-wired', () => {
    // The other half of banner-rows.test.js's static read: this module MAY not mention
    // `process`, but it imports one that does — update-check.js defaults `processEnv` to
    // `process.env` — and a static read of one file cannot see that. The two functions it
    // actually calls have to be reachable without any of it.
    const realDate = globalThis.Date
    const realRandom = Math.random
    const realProcess = globalThis.process
    const tripwire = (name) => () => {
      throw new Error(`banner-rows touched ${name}`)
    }
    let rows
    try {
      globalThis.Date = tripwire('Date')
      Math.random = tripwire('Math.random')
      globalThis.process = new Proxy(
        {},
        {
          get(_target, property) {
            throw new Error(`banner-rows read process.${String(property)}`)
          },
        },
      )
      rows = bannerRows({ version: '1.0.0', latestVersion: '2.0.0', cwd: '/r', cachedLatest: '2.0.0' })
    } finally {
      globalThis.Date = realDate
      Math.random = realRandom
      globalThis.process = realProcess
    }
    expect(rows.map((row) => row.label)).toEqual(['update', 'cached', 'cwd'])
  })

  it('does not mutate the facts it was handed, nor the list inside them', () => {
    const facts = { version: '0.22.0', cwd: '/repo', whatsNew: ['one', 'two', 'three', 'four'] }
    const before = structuredClone(facts)
    bannerRows(facts)
    expect(facts).toEqual(before)
    // The cap is applied to a copy: the caller's bullet list still holds all four, so a second
    // consumer of the same array (lib/commands/changelog.js reads the same entries) sees it whole.
    expect(facts.whatsNew).toHaveLength(4)
  })
})

describe('QA banner-rows — the seam runs one way only (#122)', () => {
  const rowsCode = () => codeWithoutComments(new URL('./banner-rows.js', import.meta.url))
  const frameCode = () => codeWithoutComments(new URL('./banner-compose.js', import.meta.url))

  it('is not a cycle: the rows half never reaches back for the frame', () => {
    // A cycle between these two would not fail loudly under ESM — one of them would just observe
    // the other half-initialised, on the first line of a run and only in whichever order Node
    // loaded them. The same claim lib/sprite-banner.qa.test.js makes about the ladder, re-aimed
    // at the edge #122 opened.
    const rows = rowsCode()
    for (const needle of ['banner-compose', 'composeBanner', 'bannerLayout', 'rowLine', 'titleLine']) {
      expect(rows, needle).not.toContain(needle)
    }
    expect([...frameCode().matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1])).toEqual([
      './banner-rows.js',
    ])
  })

  it('leaves the frame half knowing exactly one fact, and not one row label', () => {
    // #122's whole claim about lib/banner-compose.js, as a property of its text. `version` stays
    // because it is the box's SUBJECT — its title, which needs no label to say so — and every
    // other fact is now a question the rows half asks. A `facts.os` or a `label: 'repo'` back in
    // that file would mean the seam had started leaking, and no rendered line would show it.
    const frame = frameCode()
    for (const fact of [
      'latestVersion',
      'cachedLatest',
      'whatsNew',
      'provenance',
      'contextWindow',
      'agent',
      'model',
      'source',
      'repo',
      'cwd',
    ]) {
      expect(frame, fact).not.toContain(fact)
    }
    expect(frame).toContain('facts?.version')
    expect(frame).not.toMatch(/label: /)
    // ...and the width machinery stayed put, which is the other half of the same claim: the
    // ladder's rungs are still written down exactly once, in the module lib/banner-mode.js and
    // lib/sprite-banner.js ask for them.
    for (const needle of ['BOX_MIN_WIDTH', 'SPRITE_MIN_WIDTH', 'BANNER_WIDTH', 'LABEL_WIDTH', 'function clip(']) {
      expect(frame, needle).toContain(needle)
    }
  })

  it('published both halves, so an installed Ralph has the module it now imports', () => {
    // The split adds a file under lib/, which is an allow-listed directory in package.json's
    // `files` rather than an enumerated file — so this passes by construction today. It is
    // asserted anyway because the failure mode is not a red test: a `banner-rows.js` missing
    // from the tarball is an unresolvable import on the FIRST line of `ralph start`, and every
    // suite in this repo runs against the working tree, where the file is always there.
    expect(rowsCode().length).toBeGreaterThan(0)
    const files = JSON.parse(
      codeWithoutComments(new URL('../package.json', import.meta.url)),
    ).files
    expect(files).toContain('lib')
  })
})
