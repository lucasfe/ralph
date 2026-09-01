// #161 QA — adversarial specs for the BESIDE RUNG of the degradation ladder.
//
// banner-compose.ladder.qa.test.js owns the rungs as a TABLE — one row per width, boundaries
// spelled out, the two older rungs swept for order and monotonicity — and #161 added two columns
// to it. This file is about the thing a table cannot state: the rung is not a threshold on its
// own, it is one half of an ARITHMETIC PROMISE whose other half lives in lib/banner-beside.js.
//
//   `beside` says the box may go to the right of the picture. `besideWidth` says how wide to lay
//   it out there. Nothing in either module ever checks the result: the join concatenates and the
//   composer clips to the width it was handed, so "a joined line fits the terminal" is true only
//   because `limit - 26 - 2`, capped at 60, is exactly the width that makes it true. That is one
//   subtraction, in one expression, and it is the whole guarantee.
//
// So the four things attacked here are the four ways that subtraction can be wrong:
//
//   1. AT EVERY WIDTH, NOT AT THE BOUNDARY. Swept across the domain with the REAL sprite, the
//      REAL frames and a REAL box, measured in code points — the unit this package counts in —
//      rather than asserted from the same `Math.min` the implementation used.
//   2. FOR A WIDTH THAT IS NOT A WIDTH. `stdout.columns` is `undefined` on a pipe and `0` on some
//      CI runners, and a programmatic caller can hand over a fraction, a string or
//      `Number.MAX_SAFE_INTEGER`. `besideWidth` reaches a `' '.repeat(...)` one module over, so
//      every one of those has to come back as a small whole number of columns.
//   3. WITH HOSTILE FACTS IN THE BOX. A box line wider than `besideWidth` overhangs the terminal;
//      a box line CONTAINING A NEWLINE is worse than it used to be, and that is #161's doing —
//      before this issue a forged line was an ugly banner, and now it is a row inside an animated
//      frame that lib/sprite-player.js will count and the terminal will scroll.
//   4. WITHOUT MOVING THE OTHER TWO COMMANDS. `ralph doctor` and `ralph status` draw the same box
//      through the same composer and know nothing about a sprite, so the new fields must be
//      invisible to them — asserted as bytes at wide widths AND as an import graph, because a
//      field nobody reads is only safe while nobody reads it.
//
// Pure and hermetic (#41): the composer and the ladder are pure, the frames are rendered from
// injected capabilities, and no width below comes from the terminal the suite runs in.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  BANNER_WIDTH,
  BESIDE_GAP,
  BOX_MIN_WIDTH,
  SPRITE_MIN_WIDTH,
  bannerLayout,
  composeBanner,
} from './banner-compose.js'
import { joinBeside } from './banner-beside.js'
import { renderSplashFrames } from './sprite-banner.js'
import { spriteWidth } from './sprite-data.js'

const ESC = String.fromCharCode(27)
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const NEWLINE = String.fromCharCode(10)
const CARRIAGE_RETURN = String.fromCharCode(13)
const codePoints = (line) => [...line.replace(SGR, '')].length

/**
 * A box with something in every row it can draw, so the widest possible line is under test.
 *
 * Deep `cwd`, a newer version (the yellow hint is the longest sentence the box says), a long
 * model id, a repo slug and three changelog bullets: twelve rows, which is the tallest box
 * lib/banner-compose.js can produce.
 */
const FULL_FACTS = {
  version: '1.2.3',
  latestVersion: '9.9.9',
  cwd: '/Users/somebody/code/a/rather/deeply/nested/checkout/of/ralph',
  agent: 'codex',
  model: 'gpt-5-codex-preview-2026-05-01',
  provenance: 'configured',
  contextWindow: 400_000,
  source: 'github',
  repo: 'lucoferr/ralph',
  whatsNew: ['the first bullet of the release', 'the second one', 'and a third'],
}

describe('QA the beside rung — a joined line fits the terminal, at every width (#161)', () => {
  it('spells its threshold out of the three constants it is made of', () => {
    // NOT A LITERAL 72, and that is the point of finding it by scanning: the rung is "the sprite,
    // the air, and a box wide enough to have four sides", so it moves if any of those three
    // move. A test holding a 72 would keep passing on the day BESIDE_GAP became 3 and the box
    // started overhanging by one column.
    const expected = SPRITE_MIN_WIDTH + BESIDE_GAP + BOX_MIN_WIDTH
    let first = null
    for (let width = 1; width <= 400 && first === null; width += 1) {
      if (bannerLayout(width).beside) first = width
    }
    expect(first).toBe(expected)
    // ...and what that number is TODAY, said once so a reader does not have to do the sum.
    expect(expected).toBe(72)
    // Once true, always true: there is no wider terminal that goes back to stacking.
    for (let width = expected; width <= 1000; width += 1) {
      expect(bannerLayout(width).beside, `width ${width}`).toBe(true)
    }
  })

  it('never lets the sprite, the air and the box add up to more than the terminal', () => {
    // THE PROMISE, AS ARITHMETIC, over the whole integer domain the rung is live on. Stated as
    // the three summands rather than as `besideWidth <= leftover`, because that is the sentence
    // the terminal cares about: 26 cells of picture, two of air, and whatever the box was laid
    // out at.
    for (let width = 1; width <= 1000; width += 1) {
      const layout = bannerLayout(width)
      expect(Number.isInteger(layout.besideWidth), `width ${width}`).toBe(true)
      expect(layout.besideWidth).toBeGreaterThanOrEqual(0)
      expect(layout.besideWidth).toBeLessThanOrEqual(BANNER_WIDTH)
      if (!layout.beside) continue
      expect(SPRITE_MIN_WIDTH + BESIDE_GAP + layout.besideWidth, `width ${width}`).toBeLessThanOrEqual(
        width,
      )
      // ...and the arrangement never hands the box MORE columns than it would have had stacked,
      // which is what makes "beside" a rearrangement of the same banner rather than a second,
      // wider design nobody reviewed.
      expect(layout.besideWidth, `width ${width}`).toBeLessThanOrEqual(layout.boxWidth)
    }
  })

  it('grows the box monotonically with the terminal and never shrinks it by one column', () => {
    // #72's own shape claim, extended to the new field: widening a terminal must never take
    // something away. A `Math.max(0, ...)` that had been a `Math.abs` would pass every boundary
    // row in the table and fail here, at 27 columns, where the leftover crosses zero.
    for (let width = 2; width <= 1000; width += 1) {
      expect(bannerLayout(width).besideWidth, `width ${width}`).toBeGreaterThanOrEqual(
        bannerLayout(width - 1).besideWidth,
      )
    }
  })

  it('measures the real joined line against the real terminal, not against its own formula', () => {
    // THE END OF THE CHAIN, driven rather than derived: the frames the command renders, the box
    // the command composes, glued by the function the command calls, measured in code points.
    // Every width from the rung to well past the cap, plus the two columns either side of it.
    for (let width = SPRITE_MIN_WIDTH; width <= 200; width += 1) {
      const layout = bannerLayout(width)
      if (!layout.beside) continue
      const boxLines = composeBanner({
        facts: FULL_FACTS,
        width: layout.besideWidth,
        capabilities: { color: true },
      })
      const frame = renderSplashFrames({ isTTY: true, color: true, width })[0]
      const joined = joinBeside({ spriteLines: frame.lines, boxLines, spriteWidth })
      for (const [index, line] of joined.entries()) {
        expect(codePoints(line), `width ${width} row ${index}`).toBeLessThanOrEqual(width)
      }
      // ...and the picture really is there: the arrangement is not fitting by dropping the box.
      expect(joined[0]).toContain(boxLines[0])
      expect(joined).toHaveLength(frame.lines.length)
    }
  })

  it('answers a width that is not a width with a small whole number of columns', () => {
    // `stdout.columns` is `undefined` on a pipe and `0` on some CI runners, and `besideWidth`
    // reaches a `' '.repeat(...)` in lib/banner-beside.js — so the fallback is not cosmetic, it
    // is what keeps a nonsense column count from becoming a RangeError inside a picture.
    const DOMAIN = [
      undefined,
      null,
      0,
      -1,
      -1000,
      0.5,
      71.9,
      72.4,
      Number.NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_VALUE,
      1e9,
      '72',
      {},
      [],
      true,
    ]
    for (const width of DOMAIN) {
      const label = String(width)
      const layout = () => bannerLayout(width)
      expect(layout, label).not.toThrow()
      const { beside, besideWidth } = layout()
      expect(typeof beside, label).toBe('boolean')
      expect(Number.isInteger(besideWidth), label).toBe(true)
      expect(besideWidth, label).toBeGreaterThanOrEqual(0)
      expect(besideWidth, label).toBeLessThanOrEqual(BANNER_WIDTH)
      // And the whole arrangement still survives being built out of it, which is the only claim
      // that matters: no throw, and a box that fits the width the ladder said it was working to.
      const boxLines = composeBanner({ facts: FULL_FACTS, width: besideWidth, capabilities: {} })
      const joined = joinBeside({ spriteLines: ['XY'], boxLines, spriteWidth })
      for (const line of joined) {
        expect(codePoints(line), label).toBeLessThanOrEqual(
          spriteWidth + BESIDE_GAP + layout().besideWidth,
        )
      }
    }
    // Two of them are worth naming rather than leaving in the sweep. A FRACTION floors, so the
    // rung is decided on whole columns either side of it...
    expect(bannerLayout(72.4).beside).toBe(true)
    expect(bannerLayout(71.9).beside).toBe(false)
    // ...and `Infinity` is NOT a wide terminal, it is an unusable one: it falls back to the
    // 60-column target, where there is no room for the arrangement at all. A caller who expected
    // "infinitely wide" to mean "beside" would be surprised, so it is pinned.
    expect(bannerLayout(Infinity)).toEqual(bannerLayout(undefined))
    expect(bannerLayout(Infinity).beside).toBe(false)
  })
})

describe('QA the beside rung — a hostile fact cannot forge a row inside a frame (#161)', () => {
  // WHY THIS IS SHARPER THAN IT WAS. lib/banner-compose.js's gate has always replaced control
  // bytes, and the reason given for it is a width guarantee and a promise of no stray escapes.
  // #161 adds a third consequence that is strictly worse than either: the box's lines are now
  // rows of an ANIMATED FRAME. A line carrying a newline is a row lib/sprite-player.js counts
  // off the chunk (correctly) and the terminal scrolls (correctly) — but the frame is then one
  // row taller than the picture it is redrawing, every cycle, so the animation walks. And an ESC
  // that reached a joined line would be sitting two columns from a truecolor sprite cell.
  const HOSTILE = {
    'a newline in the version': { version: `1.2.3${NEWLINE}╰─ forged ─╯` },
    'a newline in the cwd': { version: '1.2.3', cwd: `/repo${NEWLINE}│ forged │` },
    'a carriage return in the cwd': { version: '1.2.3', cwd: `/repo${CARRIAGE_RETURN}forged` },
    'an escape in the cwd': { version: '1.2.3', cwd: `/repo${ESC}[31m/red` },
    'an escape in a bullet': { version: '1.2.3', whatsNew: [`news${ESC}[5m`] },
    'a newline in a bullet': { version: '1.2.3', whatsNew: [`news${NEWLINE}│ forged │`] },
    'a newline in the repo slug': { version: '1.2.3', source: 'github', repo: `o/n${NEWLINE}x` },
    'a four-thousand-character cwd': { version: '1.2.3', cwd: `/${'deep/'.repeat(800)}` },
    'a hostile object where a string goes': {
      version: '1.2.3',
      cwd: {
        toString() {
          return `/forged${NEWLINE}│ x │`
        },
      },
    },
  }

  for (const [label, facts] of Object.entries(HOSTILE)) {
    it(`keeps ${label} inside one row of a joined frame`, () => {
      for (const width of [72, 88, 120, 400]) {
        const layout = bannerLayout(width)
        const boxLines = composeBanner({
          facts,
          width: layout.besideWidth,
          capabilities: { color: true },
        })
        const frame = renderSplashFrames({ isTTY: true, color: true, width })[0]
        const joined = joinBeside({ spriteLines: frame.lines, boxLines, spriteWidth })
        // ONE ARRAY SLOT IS ONE TERMINAL ROW, which is the invariant the animation's cursor
        // arithmetic is built on. Asserted on the joined block, because that is what reaches
        // the player, and asserted for BOTH terminators — a lone CR rewinds the cursor to the
        // start of the line without ending it, which draws the box over its own left border.
        for (const [index, line] of joined.entries()) {
          expect(line.includes(NEWLINE), `${width} row ${index}`).toBe(false)
          expect(line.includes(CARRIAGE_RETURN), `${width} row ${index}`).toBe(false)
          expect(codePoints(line), `${width} row ${index}`).toBeLessThanOrEqual(width)
        }
        expect(joined).toHaveLength(frame.lines.length)
        // The only escapes in the block are the sprite's own and the box's one paint colour —
        // nothing a fact brought with it. Counted against the same block with the fact's bytes
        // removed from consideration: the box's rows carry NO escape unless they are painted,
        // and none of these facts earns a painted row.
        const boxEscapes = boxLines.join('').split(ESC).length - 1
        expect(boxEscapes, `${width} box escapes`).toBe(0)
      }
    })
  }
})

describe('QA the beside rung — ralph doctor and ralph status cannot see it (#161)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const read = (relative) => readFileSync(join(here, relative), 'utf8')

  it('draws the same 60-column box for a composer caller that names no sprite', () => {
    // `ralph doctor` and `ralph status` call `composeBanner` with the terminal's own width and no
    // picture at all, so on a 200-column terminal they must still print a 60-wide box starting in
    // column 0 — byte for byte what they printed before this issue. The new fields are on the
    // ladder's return value, and this is the claim that they are INERT to the composer: the box
    // at width W is the box at width W, whatever `beside` says about W.
    for (const width of [61, 71, 72, 73, 88, 120, 200, 10_000]) {
      const lines = composeBanner({ facts: FULL_FACTS, width, capabilities: { color: true } })
      expect(bannerLayout(width).beside, `width ${width}`).toBe(width >= 72)
      for (const line of lines) {
        expect(codePoints(line), `width ${width}`).toBe(BANNER_WIDTH)
        // No indent: a composer that had started honouring `besideWidth` on its own would put
        // the frame 28 columns in, and this is the cheapest way to see that.
        expect(line.startsWith(' '), `width ${width}`).toBe(false)
      }
      expect(lines[0].startsWith('╭')).toBe(true)
      expect(lines[lines.length - 1].startsWith('╰')).toBe(true)
    }
    // ...and the two widths either side of the rung compose IDENTICAL boxes, which is the
    // strongest form of "inert": crossing the threshold changes nothing about the box itself.
    expect(composeBanner({ facts: FULL_FACTS, width: 72 })).toEqual(
      composeBanner({ facts: FULL_FACTS, width: 71 }),
    )
  })

  it('keeps the join out of both commands’ import graphs', () => {
    // A field nobody reads is only safe while nobody reads it, so the claim is structural as
    // well as behavioural. Walked transitively rather than grepped at the top level, on the same
    // argument lib/commands/start.splash.qa.test.js makes about the player's exclusivity: a
    // helper that pulled the join in indirectly would satisfy a one-file grep.
    const walk = (entry) => {
      const seen = new Set()
      const queue = [entry]
      while (queue.length) {
        const file = queue.pop()
        if (seen.has(file)) continue
        seen.add(file)
        let source
        try {
          source = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        for (const match of source.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
          queue.push(join(dirname(file), match[1]))
        }
      }
      return seen
    }
    for (const command of ['commands/doctor.js', 'commands/status.js']) {
      const graph = [...walk(join(here, command))].map((file) => file.replace(`${here}/`, ''))
      expect(graph, command).not.toContain('banner-beside.js')
      expect(graph, command).not.toContain('sprite-player.js')
    }
    // ...and the two command sources never name the rung either, which catches the shape the
    // graph walk cannot: a `bannerLayout(...).beside` read inside a file that already imports
    // the ladder for its `boxed` answer.
    for (const command of ['commands/doctor.js', 'commands/status.js']) {
      const source = read(command)
      expect(source, command).not.toContain('joinBeside')
      expect(source, command).not.toContain('besideWidth')
      expect(source, command).not.toContain('banner-beside')
    }
    // The walk is checked against a file that DOES reach the join, so it cannot pass vacuously.
    const startGraph = [...walk(join(here, 'commands/start.js'))].map((file) =>
      file.replace(`${here}/`, ''),
    )
    expect(startGraph).toContain('banner-beside.js')
  })
})
