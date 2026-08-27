// #70 QA — adversarial specs for the WHAT'S-NEW SECTION of the box, kept beside
// banner-compose.qa.test.js (#68's) rather than inside it: that file's four seams are
// the width, escape integrity, the facts and purity, and this section adds a fifth that
// none of them describe. Every other fact in the box is ONE SCALAR the caller resolved.
// This one is a LIST, it is PREFIXED with a glyph, and its contents are committed
// markdown — the least-read bytes in the package — rendered above every preflight line.
//
// So the attack surface is the three things a list has that a scalar does not:
//
//   * HOW FAR IT IS READ. The cap is applied to what SURVIVES the gate, by a loop that
//     breaks. Whether it breaks is not visible in the output of a 5-element list (three
//     bullets either way), and it is what decides whether element four of a hostile list
//     is touched at all. Asserted by accounting for every property read, not by reading
//     the lines.
//   * THE PREFIX. `'• ' + bullet` is the one concatenation in this module that happens
//     to a value before `rowLine`'s gate sees it, which is exactly the coercion the gate
//     exists to prevent. banner-compose.test.js tripwires an object's `toString`; this
//     file adds the shapes that are strings ENOUGH to fool a `typeof`-free check — a
//     boxed `new String`, a Symbol, a function — and the control bytes that a scalar
//     fact would also carry but that only a bullet gets from a file nobody proofreads.
//   * WHAT COUNTS AS THE LIST. `Array.isArray` is the door, and a caller who reads a
//     file can hand over anything: a Set, a typed array, an `arguments` object, an
//     Array subclass, a Proxy. Each must either render or vanish — never throw, and
//     never half-draw a section with a heading and no news in it.
//
// And the boundary this file states rather than tests: an element whose GETTER throws
// propagates out of `composeBanner`, exactly as a `facts` object whose getter throws
// does (banner-compose.test.js builds one deliberately). That is a property of the
// module's whole argument contract and not of #70 — so instead of pinning a throw as
// though it were desirable, the last block here proves the shipped caller cannot
// produce such an array: `latestBullets` returns a plain array of primitive strings.
//
// Widths, escapes and glyphs are spelled out rather than imported, so an expectation
// here cannot agree with a typo in the implementation's own constants. Nothing in this
// file reads an ambient environment, a clock or a real file (#41).

import { describe, expect, it } from 'vitest'
import { BANNER_WIDTH, bannerLayout, composeBanner } from './banner-compose.js'
import { latestBullets, parseChangelog } from './changelog.js'

const ESC = '\u001B'
const YELLOW = `${ESC}[33m`
const YELLOW_OFF = `${ESC}[39m`
const SGR = /\u001B\[[0-9;]*m/g

// The control code points a bullet can carry out of a file, each named for what it does
// to a terminal rather than for its number — the assertions below are about the damage.
const LF = '\n'
const CR = '\r'
const NUL = '\u0000'
const BEL = '\u0007'
const BACKSPACE = '\u0008'
const VT = '\u000B'
const FF = '\u000C'
const DEL = '\u007F'
// U+009B: a one-byte CSI introducer, i.e. the escape attack without an ESC to grep for.
const C1_CSI = '\u009B'
// U+0085 NEL, the C1 block's own line break.
const NEL = '\u0085'
const PLACEHOLDER = '�'

const VERSION = '0.22.0'
const CWD = '/repo'
const POINTER = 'run `ralph changelog` for the rest'
const GLYPH = '•'

const stripAnsi = (line) => line.replace(SGR, '')
/** Code points, which is the measure the module pads, clips and promises in. */
const visibleWidth = (line) => [...stripAnsi(line)].length

const compose = (facts = {}, options = {}) =>
  composeBanner({ facts: { version: VERSION, cwd: CWD, ...facts }, ...options })

/** The section's rows: everything from the `new` row to the row above the bottom rule. */
const sectionOf = (lines) => {
  const first = lines.findIndex((line) => stripAnsi(line).startsWith(`${'│'} new`))
  return first === -1 ? [] : lines.slice(first, lines.length - 1)
}

// The widths #68's QA file sweeps, for the same reason: the 60-column target, the 44 and
// 26 rungs of #72's future ladder, and the degenerate widths where no box can be drawn
// but nothing may throw either.
const USABLE_WIDTHS = [200, 80, 61, 60, 59, 45, 44, 43, 30, 27, 26, 25, 12, 8, 5, 4, 3, 2, 1]

/**
 * The two invariants that hold for EVERY case in this file, whatever the bullets were.
 *
 * (a) no line is wider than the width the caller gave, measured in code points with the
 * colour stripped; (b) with colour off, not one escape byte — neither ESC nor the C1
 * CSI — appears anywhere. Plus the structural half that makes (a) meaningful: a line
 * carrying a LF or a CR would be two terminal rows, the second one composed by nobody
 * and covered by no guarantee, so a bullet that smuggled one in would defeat the width
 * promise without ever producing a long string.
 *
 * The ceiling and the FORM both come from `bannerLayout` rather than from arithmetic
 * restated here, which is what keeps this helper honest across #72's ladder: above 44
 * columns the frame is the box's own at both ends, and below it there is no frame to
 * claim — so what holds there is that the line is still a line (never blank) and that
 * nothing was padded to a border that is not being drawn.
 */
function expectBoxHolds(lines, { width = BANNER_WIDTH, color = false } = {}, why = '') {
  const layout = bannerLayout(width)
  const ceiling = layout.boxWidth
  expect(lines.length, why).toBeGreaterThan(0)
  for (const line of lines) {
    const context = `${why} ${JSON.stringify(line)}`
    expect(visibleWidth(line), context).toBeLessThanOrEqual(ceiling)
    expect(line, context).not.toContain(LF)
    expect(line, context).not.toContain(CR)
    expect(line, context).not.toContain(NEL)
    if (!color) expect(line, context).not.toContain(ESC)
    expect(line, context).not.toContain(C1_CSI)
    // The frame is the box's own, at both ends: a value cannot become the start of a
    // line, whatever it contains, because the label column always precedes it.
    if (layout.boxed && visibleWidth(line) >= 2) {
      expect(stripAnsi(line)[0], context).toMatch(/[╭│╰…]/)
      expect(stripAnsi(line).at(-1), context).toMatch(/[╮│╯…]/)
    }
    // ...and where there is no frame (#72), the two claims that replace it. Not a "no
    // frame glyph" claim, deliberately: a bullet in this file's hostile changelog is a
    // forged box row, so a `│` can legitimately be part of what a bare line SAYS.
    if (!layout.boxed) {
      expect(stripAnsi(line).trim(), context).not.toBe('')
      expect(line, context).toBe(line.trimEnd())
    }
  }
}

describe('QA composeBanner — how many lines the section is, and how far it reads', () => {
  it('is exactly one row per shown bullet plus the pointer, from one bullet to six', () => {
    // The cap's arithmetic as a table, because the two ENDS are where it is easy to get
    // wrong: one bullet must not draw two rows and six must not draw seven. The baseline
    // is the box this slice never touched, so each count is stated as what the section
    // ADDED — the same claim the module's header makes ("later slices add LINES").
    const baseline = compose().length
    const table = [
      [0, 0],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 4],
      [6, 4],
      [50, 4],
    ]
    for (const [count, added] of table) {
      const whatsNew = Array.from({ length: count }, (_, index) => `bullet ${index}`)
      const lines = compose({ whatsNew })
      const why = `${count} bullets`
      expect(lines.length - baseline, why).toBe(added)
      expect(sectionOf(lines), why).toHaveLength(added)
      expectBoxHolds(lines, {}, why)
    }
  })

  it('points at `ralph changelog` even when there is no rest — deliberately', () => {
    // PINNED AS DELIBERATE, and worth saying why out loud because it reads like an
    // off-by-one: with one or two bullets the pointer still says "for the rest", and
    // there is no rest of the ENTRY. There is a rest of the FILE — every release before
    // this one — and that is what `ralph changelog` (#71) shows. The alternative is a
    // section whose last row appears and disappears depending on how many bullets a
    // release happened to have, which is a box that changes shape between runs for no
    // reason a reader can see. If this ever becomes conditional, this test is the record
    // that the current wording was a choice.
    for (const whatsNew of [['only one'], ['one', 'two'], ['one', 'two', 'three']]) {
      const rows = sectionOf(compose({ whatsNew }))
      expect(rows.at(-1), String(whatsNew.length)).toContain(POINTER)
      expect(rows.at(-1), String(whatsNew.length)).toContain('more')
      // ...and the pointer row is never a bullet: no glyph, so a reader cannot mistake
      // it for a fourth piece of news.
      expect(rows.at(-1), String(whatsNew.length)).not.toContain(GLYPH)
    }
  })

  it('reads no further than the third bullet it can use', () => {
    // THE CAP AS A READ LIMIT, which is invisible in the lines and is the difference
    // between "shows three" and "touches three". A changelog entry can be enormous —
    // release-please writes one bullet per commit, and a squashed release branch is
    // dozens — and this box is drawn before the first preflight line, so the section
    // must cost the same at 3 bullets and at 3000.
    //
    // A Proxy over a real array (`Array.isArray` is true through one, which is why this
    // shape reaches the loop at all) records every property read. Element three is a
    // TRAP: if the loop ever stops breaking, this test fails with the trap's own
    // message rather than with a puzzling count.
    const reads = []
    const bullets = new Proxy(['one', 'two', 'three', 'four', 'five'], {
      get(target, property) {
        reads.push(String(property))
        if (property === '3') throw new Error('the fourth bullet must never be read')
        return target[property]
      },
    })
    const lines = compose({ whatsNew: bullets })
    expect(sectionOf(lines)).toHaveLength(4)
    // The indices, in order, and no more of them: 0, 1, 2 and then the break.
    expect(reads.filter((key) => /^\d+$/.test(key))).toEqual(['0', '1', '2'])
  })

  it('counts survivors, not elements, when it decides it has enough', () => {
    // The gate runs BEFORE the cap, so a list that starts with rubbish still shows three
    // pieces of news — the difference between "the first three elements" and "the first
    // three bullets". Losing a release's news to a stray comma in the file would be the
    // worse of the two failures, and this is the case that says so at the boundary: the
    // three usable bullets are the 4th, 6th and 8th elements.
    const lines = compose({
      whatsNew: [null, 'first', undefined, 'second', 42, `${VT} ${FF}`, 'third', 'fourth', 'fifth'],
    })
    const rows = sectionOf(lines)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain(`${GLYPH} first`)
    expect(rows[1]).toContain(`${GLYPH} second`)
    expect(rows[2]).toContain(`${GLYPH} third`)
    expect(lines.join('\n')).not.toContain('fourth')
    expect(lines.join('\n')).not.toContain('fifth')
  })
})

describe('QA composeBanner — the bullet column, measured to the code point', () => {
  it('fits 46 code points and clips the 47th, at the 60-column target', () => {
    // The exact boundary, DERIVED rather than asserted from a magic number: the widest
    // bullet that survives verbatim is found by search, and then checked against the
    // arithmetic the layout is made of — 60 columns, less 4 for `│ ` and ` │`, less the
    // 8-column label gutter, less the two the `• ` prefix costs. If a future slice
    // widens the gutter for a longer label, this test says so in one number instead of
    // failing in a dozen padding comparisons.
    const fits = (length) => {
      const bullet = 'x'.repeat(length)
      return compose({ whatsNew: [bullet] }).some((line) => line.includes(bullet))
    }
    let room = 0
    for (let length = 1; length <= BANNER_WIDTH; length += 1) if (fits(length)) room = length
    expect(room).toBe(46)
    expect(room).toBe(BANNER_WIDTH - 4 - 8 - 2)
    // One under, exact, one over — and every one of them a 60-wide row, because the clip
    // replaces a column with the ellipsis rather than appending one to it.
    for (const length of [room - 1, room, room + 1, room + 40]) {
      const bullet = 'x'.repeat(length)
      const lines = compose({ whatsNew: [bullet] })
      const row = sectionOf(lines)[0]
      const why = `${length} code points`
      expect(visibleWidth(row), why).toBe(BANNER_WIDTH)
      if (length <= room) {
        expect(row, why).toContain(bullet)
        expect(row, why).not.toContain('…')
      } else {
        expect(row, why).not.toContain(bullet)
        expect(row, why).toContain('…')
        expect(row, why).toContain('x'.repeat(room - 1))
      }
    }
  })

  it('holds the guarantee at every width, with three bullets nothing can print', () => {
    // #68's width sweep, re-run with the section present and the bullets hostile: a long
    // one to force the clip, one made of control bytes to force the replacement, and one
    // full of astral glyphs so the clip lands inside a surrogate pair if it counts UTF-16
    // units. Both invariants, at every width, in both colour modes.
    const whatsNew = [
      `a release note that ${'goes on and on '.repeat(30)}forever`,
      `bullet${ESC}[31m${NUL}${DEL}${C1_CSI}[2J${BEL}${BACKSPACE}two`,
      `${'🧑\u200D🚀'.repeat(20)} astronauts`,
    ]
    for (const width of [...USABLE_WIDTHS, undefined, 1000, 100000]) {
      for (const color of [false, true]) {
        const lines = composeBanner({
          facts: { version: VERSION, cwd: CWD, whatsNew },
          width,
          capabilities: { color },
        })
        expectBoxHolds(lines, { width, color }, `width ${width} color ${color}`)
        // No lone surrogate anywhere: a clip that counted UTF-16 units could cut an
        // astral glyph in half, and half a surrogate pair is a replacement character on
        // the user's terminal rather than a truncated word.
        const withoutPairs = lines.join('').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
        expect(withoutPairs, `width ${width}`).not.toMatch(/[\uD800-\uDFFF]/)
      }
    }
  })

  it('gives a wide terminal the same 60-column box the target gets', () => {
    // The box is a TARGET, not a minimum: a 200-wide rule is a line nobody can follow.
    // Asserted with the section present because it is the part that grows — a section
    // that stretched to the terminal while the rows above held 60 would be a box with a
    // ragged edge, which reads as a bug in Ralph rather than as a wide window.
    const whatsNew = ['one', 'two', 'three']
    const at60 = compose({ whatsNew }, { width: 60 })
    for (const width of [61, 80, 200, 1000]) {
      expect(compose({ whatsNew }, { width }), String(width)).toEqual(at60)
    }
  })

  it('counts code points, not display cells — the documented limitation', () => {
    // PINNED AS DELIBERATE, because it looks like a bug the first time it is seen: the
    // module's own comment states the guarantee in CODE POINTS and says why (a
    // character-width table is not something this package will carry for a banner). So a
    // bullet of 46 CJK ideographs is 46 code points and occupies about 92 terminal
    // cells, and the row below is exactly as "wide" as the module promised while
    // visibly overflowing a 60-column window.
    //
    // This test exists so that behaviour is a RECORDED decision rather than an accident
    // — and so the day someone adds a width table, its failure is the reminder that this
    // section is one of the places that must change.
    const cjk = compose({ whatsNew: ['字'.repeat(46), 'é'.repeat(23)] })
    for (const line of cjk) expect(visibleWidth(line)).toBe(BANNER_WIDTH)
    expect(sectionOf(cjk)[0]).toContain('字'.repeat(46))
    // A combining acute is its own code point, so `é` written as e + U+0301 costs two of
    // the 46 — 23 of them fit exactly, and 24 would clip.
    expect(sectionOf(cjk)[1]).toContain('é'.repeat(23))
    expect(sectionOf(compose({ whatsNew: ['é'.repeat(24)] }))[0]).toContain('…')
  })
})

describe('QA composeBanner — a bullet is the least trusted text in the box', () => {
  it('replaces every control code point, one for one', () => {
    // banner-compose.test.js pins LF, CR and ESC — the three that matter. This is the
    // rest of the class, each with what it would do if it got through: BEL rings, BS
    // walks the cursor back over the frame, NEL breaks a line in the C1 block, DEL and
    // the C1 CSI are the same attacks as ESC without an ESC byte to grep for.
    //
    // ONE FOR ONE is the part that makes the width accounting exact: the module replaces
    // rather than strips, precisely one code point in for one out, so a bullet of N
    // controls is a bullet of N placeholders and the padding still lands.
    const CONTROLS = [LF, CR, NUL, BEL, BACKSPACE, VT, FF, DEL, C1_CSI, NEL, '\u0001', '\u009F']
    for (const control of CONTROLS) {
      const bullet = `head${control}${control}tail`
      const lines = compose({ whatsNew: [bullet] })
      const row = sectionOf(lines)[0]
      const why = JSON.stringify(control)
      expectBoxHolds(lines, {}, why)
      expect(row, why).toContain('head')
      expect(row, why).toContain('tail')
      expect(row, why).not.toContain(control)
      expect(row, why).toContain(`head${PLACEHOLDER}${PLACEHOLDER}tail`)
      expect(visibleWidth(row), why).toBe(BANNER_WIDTH)
    }
  })

  it('shows a bullet of nothing but controls, and drops one of nothing but whitespace', () => {
    // The two ends of the same rule, and they differ for a reason worth recording. NUL
    // and DEL are not whitespace, so a bullet made only of them is a fact that contains
    // something unprintable: the box says so with a placeholder, because "name what is
    // missing, never invent it" cuts both ways — silently dropping it would hide that
    // the file has bytes in it that nobody meant to commit. VT and FF ARE whitespace to
    // `trim`, so a bullet of them is a bullet that says nothing, and is skipped.
    const shown = sectionOf(compose({ whatsNew: [`${NUL}${DEL}`] }))
    expect(shown).toHaveLength(2)
    expect(shown[0]).toContain(`${GLYPH} ${PLACEHOLDER}${PLACEHOLDER}`)
    const baseline = compose()
    for (const blank of ['', '   ', VT, FF, `${VT}${FF} \t`, '\u00A0', '\u2028', '　']) {
      expect(compose({ whatsNew: [blank] }), JSON.stringify(blank)).toEqual(baseline)
    }
  })

  it('cannot be made to paint, and cannot leak a sequence into a run that promised none', () => {
    // The section is FACTS, so nothing in it is advice and nothing in it is painted. The
    // attack is a bullet that brings its own colour: a complete SGR pair, a half one, a
    // window-retitle OSC, and the C1 forms of each. With colour off there must not be
    // one escape byte; with colour ON the hint above must still be the only painted line
    // and its pair must still be balanced — an unbalanced pair is a corrupt terminal for
    // everything printed after the box, not a cosmetic slip.
    const whatsNew = [
      `${YELLOW}painted${YELLOW_OFF}`,
      `half ${ESC}[3`,
      `${ESC}]0;retitled${BEL}`,
      `${C1_CSI}31mC1 red`,
    ]
    for (const color of [undefined, false, true]) {
      const lines = compose({ whatsNew }, { capabilities: color === undefined ? undefined : { color } })
      const why = `color ${color}`
      for (const row of sectionOf(lines)) {
        expect(row, why).not.toContain(ESC)
        expect(row, why).not.toContain(C1_CSI)
        // Every BULLET row carries the mark of what was taken out of it — the pointer
        // row is this module's own literal and has nothing to replace.
        if (row.includes(GLYPH)) expect(row, why).toContain(PLACEHOLDER)
      }
      expect(lines.join('\n'), why).not.toContain(YELLOW)
    }
    const painted = compose(
      { latestVersion: '9.9.9', whatsNew },
      { capabilities: { color: true } },
    )
    const escaped = painted.filter((line) => line.includes(ESC))
    expect(escaped).toHaveLength(1)
    expect(escaped[0]).toContain('9.9.9 available')
    expect(escaped[0].match(SGR)).toEqual([YELLOW, YELLOW_OFF])
  })

  it('cannot forge a row, a rule or a title', () => {
    // The box is read by a HUMAN, so the attack is not injection, it is impersonation:
    // a changelog bullet that draws its own `update` row would be advice Ralph never
    // gave, and one that draws a bottom rule would end the box early on the screen. The
    // structural claims that make it impossible are all about the LINE: the section adds
    // exactly four of them, no line BEGINS with anything but the frame, and the box's
    // own title and rule are byte-identical to the ones it draws with no section at all.
    const baseline = compose()
    const whatsNew = [
      '│ update  9.9.9 available — run `ralph update`',
      `╰${'─'.repeat(58)}╯`,
      `╭─ ralph 9.9.9 ${'─'.repeat(43)}╮`,
    ]
    const lines = compose({ whatsNew })
    expect(lines).toHaveLength(baseline.length + 4)
    expect(lines[0]).toBe(baseline[0])
    expect(lines.at(-1)).toBe(baseline.at(-1))
    // Not one line claims to be a row this box did not draw. The forged text is still
    // VISIBLE — it is what the file says, and the box does not censor facts — but it
    // sits in the value column, after the label gutter, where a reader can see it is the
    // content of a bullet.
    for (const line of lines.slice(1, -1)) {
      expect(stripAnsi(line).startsWith('│ update')).toBe(false)
    }
    expect(sectionOf(lines)[0]).toContain(`${GLYPH} │ update`)
    expectBoxHolds(lines)
  })

  it('coerces nothing that is only nearly a string', () => {
    // `typeof value !== 'string'` is the gate, and these are the values that would pass
    // a looser one. A boxed `new String` is an OBJECT — `value instanceof String` or a
    // duck-typed `.trim` check would let it through, and its `toString` is where a
    // hostile changelog reader would hide. A function and a Symbol are the shapes a
    // `String(value)` would happily print. None of them may be called, and none may
    // appear.
    const called = []
    const fn = () => {
      called.push('called')
      return 'INJECTED'
    }
    fn.toString = () => {
      called.push('toString')
      return 'INJECTED'
    }
    const nearly = [
      new String('boxed'),
      fn,
      Symbol('symbolic'),
      10n,
      Object.assign(Object.create(null), { trim: () => 'INJECTED' }),
      { toString: () => 'INJECTED', length: 8, trim: () => 'INJECTED' },
      ['a nested array'],
    ]
    const lines = compose({ whatsNew: [...nearly, 'the one real bullet'] })
    expect(called).toEqual([])
    expect(lines.join('\n')).not.toContain('INJECTED')
    expect(lines.join('\n')).not.toContain('boxed')
    expect(lines.join('\n')).not.toContain('nested array')
    // ...and the real bullet still shows: one hostile element is not a reason to go
    // quiet about the release.
    expect(sectionOf(lines)[0]).toContain(`${GLYPH} the one real bullet`)
    expect(sectionOf(lines)).toHaveLength(2)
  })
})

describe('QA composeBanner — every shape the list itself can arrive in', () => {
  it('renders the array shapes a caller can legitimately produce', () => {
    // All four are `Array.isArray` true, and all four are things a reader or a future
    // caller can hand over: a frozen list (a module-level constant), a sparse one (a
    // `delete` or an assignment past the end), a subclass (a collection type), and a
    // Proxy (a recording or lazily-loading wrapper). Holes read as `undefined` and are
    // skipped like any other unusable element — they are not shown as blank bullets.
    const sparse = ['first']
    sparse[4] = 'second'
    class Bullets extends Array {}
    const shapes = {
      frozen: Object.freeze(['first', 'second']),
      sparse,
      subclass: Bullets.from(['first', 'second']),
      proxy: new Proxy(['first', 'second'], {}),
    }
    for (const [name, whatsNew] of Object.entries(shapes)) {
      const rows = sectionOf(compose({ whatsNew }))
      expect(rows, name).toHaveLength(3)
      expect(rows[0], name).toContain(`${GLYPH} first`)
      expect(rows[1], name).toContain(`${GLYPH} second`)
    }
  })

  it('drops the section for everything that is not an array', () => {
    // `Array.isArray` is the door, and it is checked rather than iterated on purpose: a
    // `for…of` over a non-iterable throws, and this box is printed before anything else
    // `ralph start` does. banner-compose.test.js sweeps the obvious non-lists; these are
    // the ITERABLE ones, which a duck-typed check would walk straight into, plus the
    // array-likes a `length` property makes plausible.
    const baseline = compose()
    const generator = function* () {
      yield 'generated'
    }
    const shapes = {
      'a Set': new Set(['a set is not an array']),
      'a Map': new Map([['k', 'v']]),
      'a generator': generator(),
      'the generator function': generator,
      'a typed array': new Uint8Array([1, 2, 3]),
      'an array-like bag': { 0: 'first', 1: 'second', length: 2 },
      'an arguments object': (function () {
        // eslint-disable-next-line prefer-rest-params
        return arguments
      })('first', 'second'),
      'a string of bullets': 'first\nsecond',
      'a Buffer': Buffer.from('first'),
      'a promise of bullets': Promise.resolve(['first']),
      'a thenable': { then: () => {} },
      'a prototypeless bag': Object.create(null),
      'a boxed array': new Proxy({ length: 1, 0: 'first' }, {}),
    }
    for (const [name, whatsNew] of Object.entries(shapes)) {
      const lines = compose({ whatsNew })
      expect(lines, name).toEqual(baseline)
      expect(lines.join('\n'), name).not.toContain('ralph changelog')
      expect(lines.join('\n'), name).not.toContain(GLYPH)
    }
  })

  it('is deterministic and leaves the list exactly as it found it', () => {
    // The box is composed once per run and the same facts must draw the same box — no
    // clock, no counter, no `lastIndex` left behind by a global regex (the CONTROL
    // pattern carries `g`, which is precisely the kind of state that makes the second
    // call differ from the first). And the input is the CALLER's array: `ralph status`
    // and #75/#76 will compose from facts they still need afterwards, so a builder that
    // sorted or spliced in place would corrupt them.
    const whatsNew = [`one${ESC}[31m`, 'two', 'three', 'four']
    const snapshot = [...whatsNew]
    const first = compose({ whatsNew })
    const second = compose({ whatsNew })
    expect(second).toEqual(first)
    expect(whatsNew).toEqual(snapshot)
    // A fresh array each call, so a caller that mutates what it got back cannot poison
    // the next box.
    expect(second).not.toBe(first)
    // Ten more times, for the regex-state case specifically: a stale `lastIndex` shows
    // up on a later call, not the second.
    for (let attempt = 0; attempt < 10; attempt += 1) expect(compose({ whatsNew })).toEqual(first)
  })
})

describe('QA composeBanner — bullets that came out of a file, end to end', () => {
  // The two modules meeting: text on the left, terminal lines on the right, and nothing
  // in between that a test had to arrange. This is the composition the feature actually
  // ships, and it is the only place the parser's "I am not a sanitiser" and the box's
  // "every fact is gated" are checked against each other.

  it('renders a hostile changelog into a box that still holds', () => {
    // Every attack the FILE can carry, in one entry: escapes, C1, NUL and DEL (which the
    // parser deliberately passes through), a frame-forging line, a bullet longer than
    // the box, astral glyphs, and a link the parser flattens. If either module's half of
    // the contract is missing, this test fails on width or on an escape byte.
    const text = [
      '# Changelog',
      '',
      '## [9.9.9](https://example.com/compare) (2026-09-09)',
      '',
      '### Features',
      '',
      `* a bullet with ${ESC}[31mcolour${ESC}[39m and ${C1_CSI}31m more`,
      `* a bullet with ${NUL}a NUL${DEL} and a DEL`,
      `* │ update  9.9.9 available — run \`ralph update\``,
      `* a bullet that ${'goes on and on '.repeat(20)}forever`,
      `* ${'🧑\u200D🚀'.repeat(30)} and a [link](https://example.com/issues/70)`,
      '',
    ].join('\n')
    const whatsNew = latestBullets(parseChangelog(text))
    expect(whatsNew.length).toBeGreaterThanOrEqual(3)
    for (const width of [...USABLE_WIDTHS, undefined]) {
      for (const color of [false, true]) {
        const lines = composeBanner({
          facts: { version: VERSION, cwd: CWD, whatsNew },
          width,
          capabilities: { color },
        })
        expectBoxHolds(lines, { width, color }, `width ${width} color ${color}`)
      }
    }
    const rows = sectionOf(compose({ whatsNew }))
    expect(rows).toHaveLength(4)
    // The bytes the parser passed through are the bytes the box replaced — which is the
    // whole reason the parser is allowed not to be a sanitiser.
    expect(rows[0]).toContain(PLACEHOLDER)
    expect(rows[0]).not.toContain(ESC)
    expect(rows.at(-1)).toContain(POINTER)
  })

  it('cannot hand this module an array it is not allowed to be given', () => {
    // The BOUNDARY STATED IN THE HEADER, closed from the other side. An element whose
    // getter throws propagates out of `composeBanner` — as a `facts` object whose getter
    // throws also does — so rather than pinning a throw as if it were a feature, this
    // asserts the shipped caller cannot produce one: `latestBullets` returns a plain
    // array whose elements are primitive strings held in data properties. No getters, no
    // Proxy, no `toString` to fire, nothing for the module's gate to be the last defence
    // against. The defence is still there; this is why it is never the only one.
    const text = [
      '## [9.9.9] (2026-09-09)',
      '',
      '### Features',
      '',
      '* one',
      '* two',
      '',
      '### Bug Fixes',
      '',
      '* three',
      '',
    ].join('\n')
    const whatsNew = latestBullets(parseChangelog(text))
    expect(Object.getPrototypeOf(whatsNew)).toBe(Array.prototype)
    expect(Object.isFrozen(whatsNew)).toBe(false)
    for (let index = 0; index < whatsNew.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(whatsNew, index)
      expect(descriptor.get, String(index)).toBeUndefined()
      expect(typeof descriptor.value, String(index)).toBe('string')
    }
    // And what it produces draws the section it is supposed to, which is the point of
    // the whole chain being three modules instead of one.
    expect(sectionOf(compose({ whatsNew })).map((row) => row.trim())).toEqual([
      `│ new     ${GLYPH} one${' '.repeat(43)} │`.trim(),
      `│         ${GLYPH} two${' '.repeat(43)} │`.trim(),
      `│         ${GLYPH} three${' '.repeat(41)} │`.trim(),
      `│ more    ${POINTER}${' '.repeat(14)} │`.trim(),
    ])
  })
})
