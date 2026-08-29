import { describe, expect, it } from 'vitest'
import { isJiraKey, normalizeJiraKey, numberFromKey, usableJiraKey } from './jira-key.js'

// QA augmentation for #127. The dev's lib/jira-key.test.js owns the grammar's contract —
// what a key is, what a non-key is, and the deliberate disagreement between the strict
// trio and the permissive `usableJiraKey`. This file only asks what that suite does not,
// and every question is about a consequence somewhere else in the repo:
//
//   1. THE DERIVED NUMBER IS WRITTEN INTO A RECORD OTHER CODE READS. `numberFromKey` is
//      how `.ralph/run-state.json` gets its numeric `number` (lib/run-state.js:101), and
//      the module's own header says null is "unknown" while 0 would be "task #0". So the
//      inputs that produce a number DISAGREEING with the text — leading zeros, an
//      all-zero suffix, a suffix past the safe-integer boundary — are pinned here by the
//      number they produce, not by whether they parse.
//
//   2. `usableJiraKey` IS AN ARGV AND A FILE, and it passes an unrecognised string
//      THROUGH. Everything it lets past reaches `acli jira workitem view --key <here>`
//      (lib/jira-queue.js:119) and `.ralph/run-state.json`, and from there the terminal,
//      via lib/progress.js. So the bytes it does not reject are worth naming one by one:
//      a NUL, a bidi override, a zero-width space, a megabyte of text.
//
//   3. NOTHING MAY THROW, and "nothing" has to include the inputs that make coercion
//      itself dangerous — an object whose `toString` throws, a Proxy that throws on every
//      trap, a Symbol. The module's answer is to never coerce at all; these are the tests
//      that would fail if a `String(value)` were ever added for convenience.
//
//   4. THE GRAMMAR IS AN OBJECT-KEY-SHAPED STRING. `constructor-1` and `toString-1`
//      satisfy it. Nothing in Ralph indexes an object by a task key today, so this is
//      pinned as a fact about the grammar plus a live check that no prototype moved.
//
// Control characters are spelled with `String.fromCharCode` throughout and never as
// literals — test/source-control-bytes.test.js guards that, and a suite about invisible
// bytes must not depend on an invisible byte surviving a copy or a tool argument.

const NUL = String.fromCharCode(0x00)
const TAB = String.fromCharCode(0x09)
const LF = String.fromCharCode(0x0a)
const VT = String.fromCharCode(0x0b)
const FF = String.fromCharCode(0x0c)
const CR = String.fromCharCode(0x0d)
const ESC = String.fromCharCode(0x1b)
const NBSP = String.fromCharCode(0xa0)
const ZWSP = String.fromCharCode(0x200b)
const RLO = String.fromCharCode(0x202e)
const BOM = String.fromCharCode(0xfeff)

// Every function this module exports, so "never throws" can be asserted of the MODULE
// rather than of whichever function a case happened to be written against. An input that
// only ever reached one of the four is the one that would take a run down.
const ALL = { isJiraKey, normalizeJiraKey, numberFromKey, usableJiraKey }

// A NAME FOR A VALUE THAT MAY REFUSE TO BE NAMED, and the second fallback is the point.
// `Object.prototype.toString.call(x)` reads `x[Symbol.toStringTag]`, so on a Proxy whose
// `get` trap throws it throws too — which made the catch clause below the thing that took
// the "a Proxy that throws on every trap" case down, inside the harness, before
// `numberFromKey` was ever called. A test that cannot describe its input must still RUN it,
// so the last resort is a constant.
const UNNAMEABLE = '<a value that throws when described>'
const label = (value) => {
  try {
    return typeof value === 'symbol' ? value.toString() : (JSON.stringify(value) ?? String(value))
  } catch {
    try {
      return Object.prototype.toString.call(value)
    } catch {
      return UNNAMEABLE
    }
  }
}

// `described` is passed by the callers that ALREADY have a name for the value — the hostile
// table below keys itself by one — so the assertion message never depends on describing an
// input whose whole point is that describing it explodes.
const nothingThrows = (value, described) => {
  const name = described ?? label(value)
  for (const [fnName, fn] of Object.entries(ALL)) {
    expect(() => fn(value), `${fnName}(${name})`).not.toThrow()
  }
}

describe('the grammar’s boundary, case by measured case (#127 QA)', () => {
  // The pairs below are `[input, {key, number}]` where `key` is what `usableJiraKey`
  // answers and `number` what `numberFromKey` does. Both in one table on purpose: the
  // module's whole design is that the two can disagree, and a table that only recorded
  // one of them would let the interesting half drift unnoticed.
  const measured = [
    // A second hyphen means the project key is not a project key, so there is no number
    // to take — but the string is still whatever acli called the ticket.
    ['FOO-123-456', { key: 'FOO-123-456', number: null }],
    // `\d` in this pattern is ASCII, not \p{Nd}: a full-width or Arabic-Indic numeral is
    // NOT a work item number. That matters because `Number('１')` is 1, so a tolerant
    // parse would silently agree with a key nobody typed.
    ['FOO-' + String.fromCharCode(0xff11), { key: 'FOO-' + String.fromCharCode(0xff11), number: null }],
    ['FOO-' + String.fromCharCode(0x661), { key: 'FOO-' + String.fromCharCode(0x661), number: null }],
    // Exponent, decimal and sign notations all name a DIFFERENT ticket than the text
    // does if read as numbers, which is why the pattern is digits only.
    ['FOO-1e3', { key: 'FOO-1e3', number: null }],
    ['FOO-1.5', { key: 'FOO-1.5', number: null }],
    ['FOO-+1', { key: 'FOO-+1', number: null }],
    ['FOO--1', { key: 'FOO--1', number: null }],
    ['FOO-0x10', { key: 'FOO-0x10', number: null }],
    ['FOO-1_2', { key: 'FOO-1_2', number: null }],
    // Half a key either way.
    ['FOO-', { key: 'FOO-', number: null }],
    ['-123', { key: '-123', number: null }],
    // A project key must START with a letter, so an underscore-leading one is not one —
    // which is also what keeps `__proto__-1` out of the grammar (see the pollution test).
    ['_A-1', { key: '_A-1', number: null }],
    ['1FOO-2', { key: '1FOO-2', number: null }],
    // The shortest legal key, and the two characters Jira allows after the first.
    ['A-1', { key: 'A-1', number: 1 }],
    ['A_B1-9', { key: 'A_B1-9', number: 9 }],
    // THE PAIR THAT DISAGREES BY DESIGN AND IS WORTH READING TWICE: a leading zero is
    // KEPT in the key (`normalizeJiraKey` documents that renumbering would ask about a
    // different ticket) and DROPPED in the number. So the record written for `FOO-0123`
    // says `number: 123`, which is FOO-123's number. Harmless only because the module
    // states the number is a handle and never an identity — pinned here so that claim
    // stays load-bearing rather than decorative.
    ['FOO-0123', { key: 'FOO-0123', number: 123 }],
    ['foo-007', { key: 'FOO-007', number: 7 }],
    // ...and its limit case: an all-zero suffix yields 0, the exact value the module's
    // own header calls out as a lie ("0 would be task #0"). Jira issues no work item 0,
    // so this is pinned as reachable-but-not-real rather than as a defect.
    ['FOO-0', { key: 'FOO-0', number: 0 }],
    ['FOO-00', { key: 'FOO-00', number: 0 }],
    // The safe-integer boundary, both sides. Above it the digits stop round-tripping, so
    // the key survives and the number does not — a record with a name and no handle,
    // which is the shape the record has always allowed.
    ['FOO-9007199254740991', { key: 'FOO-9007199254740991', number: Number.MAX_SAFE_INTEGER }],
    ['FOO-9007199254740992', { key: 'FOO-9007199254740992', number: null }],
    ['FOO-99999999999999999999', { key: 'FOO-99999999999999999999', number: null }],
  ]

  for (const [input, expected] of measured) {
    it(`reads ${label(input)} as key=${label(expected.key)} number=${expected.number}`, () => {
      expect(usableJiraKey(input)).toBe(expected.key)
      expect(numberFromKey(input)).toBe(expected.number)
      // The strict trio agrees with itself: a key `numberFromKey` could read is a key
      // `isJiraKey` accepts, except across the safe-integer boundary where only the
      // NUMBER is refused. That asymmetry is the one this assertion exists to expose.
      if (expected.number !== null) expect(isJiraKey(input)).toBe(true)
      nothingThrows(input)
    })
  }
})

describe('whitespace: what `trim` removes and what it does not (#127 QA)', () => {
  // `trimmedOrNull` is the module's only normalization of the surrounding bytes, and it
  // is `String.prototype.trim` — so it removes exactly the Unicode WhiteSpace set plus
  // line terminators, and NOTHING ELSE. The split matters because the trimmed forms end
  // up in an acli argv as a clean key while the untrimmed ones end up in one verbatim.
  const trimmed = [
    [' FOO-1 ', 'a plain space'],
    [TAB + 'FOO-1' + TAB, 'tabs'],
    [LF + 'FOO-1' + CR + LF, 'line terminators'],
    [VT + FF + 'FOO-1' + VT, 'vertical tab and form feed'],
    [NBSP + 'FOO-1' + NBSP, 'a non-breaking space — WhiteSpace, so it goes'],
    [BOM + 'FOO-1', 'a byte order mark — also WhiteSpace by the spec'],
  ]

  for (const [input, what] of trimmed) {
    it(`trims ${what} and reads the key underneath`, () => {
      expect(normalizeJiraKey(input)).toBe('FOO-1')
      expect(numberFromKey(input)).toBe(1)
      expect(usableJiraKey(input)).toBe('FOO-1')
    })
  }

  // The other half, and the one with consequences: these are NOT whitespace, so they are
  // not trimmed, the grammar refuses them, and `usableJiraKey` hands the whole thing on
  // to `acli jira workitem view --key <this>` and to `.ralph/run-state.json`.
  const kept = {
    'a trailing NUL': 'FOO-1' + NUL,
    'a leading NUL': NUL + 'FOO-1',
    'a zero-width space inside the project key': 'F' + ZWSP + 'OO-1',
    'a right-to-left override': 'FOO' + RLO + '-1',
    'an ESC byte': 'FOO-1' + ESC + '[31m',
    'an inner newline': 'FOO-1' + LF + 'BAR-2',
    'an inner tab': 'FOO' + TAB + '-1',
  }

  for (const [what, input] of Object.entries(kept)) {
    it(`refuses but PASSES THROUGH ${what} — the grammar validates, it does not gate`, () => {
      expect(isJiraKey(input), what).toBe(false)
      expect(numberFromKey(input), what).toBe(null)
      // Verbatim, byte for byte. This is the module's stated posture, and naming its
      // reach is the point: the two consumers downstream have to be the ones that cope.
      // lib/progress.js does (it runs the key through the title sanitizer); the acli
      // argv does not need to (a NUL makes Node's spawn throw, which lib/jira-queue.js
      // catches into a refused claim), and templates/ralph.sh cuts its `pick` capture at
      // the FIRST tab, so the inner-tab case above loses everything after it.
      expect(usableJiraKey(input), what).toBe(input)
      nothingThrows(input)
    })
  }

  it('answers null for a string that is nothing but whitespace, in every spelling', () => {
    for (const blank of ['', ' ', TAB, LF, CR + LF, NBSP, BOM, ' ' + TAB + LF + NBSP + ' ']) {
      expect(usableJiraKey(blank), label(blank)).toBe(null)
      expect(numberFromKey(blank), label(blank)).toBe(null)
      expect(isJiraKey(blank), label(blank)).toBe(false)
    }
  })

  it('a NUL-only string is NOT blank — it is a usable key, because NUL is not whitespace', () => {
    // The exact edge the case above stops at, stated so nobody reads "blank goes to null"
    // as covering it. A key of one NUL byte reaches lib/run-state.js and is written into
    // the record; lib/progress.js scrubs it back out on the way to a terminal.
    expect(usableJiraKey(NUL)).toBe(NUL)
    expect(usableJiraKey(NUL + NUL)).toBe(NUL + NUL)
  })
})

describe('inputs that punish coercion — the module never coerces (#127 QA)', () => {
  // `String(value)` is the convenience this module deliberately does not have, and these
  // are the values that would turn it into a throw on a status view's render path. The
  // guard is `typeof value !== 'string'`, so each of these must answer null WITHOUT the
  // value ever being read.
  const hostile = () => {
    const throwingToString = {
      toString() {
        throw new Error('toString exploded')
      },
    }
    const throwingValueOf = {
      valueOf() {
        throw new Error('valueOf exploded')
      },
      toString() {
        throw new Error('toString exploded too')
      },
    }
    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('proxied')
        },
        has() {
          throw new Error('proxied')
        },
        ownKeys() {
          throw new Error('proxied')
        },
      },
    )
    // A boxed String is `typeof 'object'`, and it is the shape a `new String(...)` in a
    // caller produces — the same case lib/jira-queue.qa.test.js pins for the JQL.
    return {
      'an object whose toString throws': throwingToString,
      'an object whose valueOf and toString both throw': throwingValueOf,
      'a Proxy that throws on every trap': throwingProxy,
      'a boxed String holding a real key': new String('FOO-1'),
      'a Symbol': Symbol('FOO-1'),
      'a BigInt': 123n,
      'a function returning a key': () => 'FOO-1',
      'a bare object with no prototype': Object.create(null),
      'a Date': new Date(0),
      'an array holding a key': ['FOO-1'],
      'a nested array': [['FOO-1']],
      'NaN': NaN,
      'Infinity': Infinity,
      'a negative zero': -0,
      'true': true,
      'false': false,
      'null': null,
      'undefined': undefined,
    }
  }

  for (const [what, value] of Object.entries(hostile())) {
    it(`answers null for ${what}, without reading it`, () => {
      // The description comes from the table's own key, never from the value: see
      // `nothingThrows`. Two of these entries throw when anything looks at them.
      nothingThrows(value, what)
      expect(isJiraKey(value), what).toBe(false)
      expect(normalizeJiraKey(value), what).toBe(null)
      expect(numberFromKey(value), what).toBe(null)
      expect(usableJiraKey(value), what).toBe(null)
    })
  }
})

describe('the grammar accepts object-key-shaped names — and moves no prototype (#127 QA)', () => {
  it('reads `constructor-1` and `toString-1` as ordinary keys', () => {
    // Both satisfy the pattern (a letter, then letters/digits/underscores), so a Jira
    // project literally called CONSTRUCTOR would work. Recorded because it is the shape
    // that would matter the moment anything indexed a map by a task key — nothing does
    // today (lib/progress.js keys its titles map by NUMBER, lib/run-state.js writes the
    // key as a value), and the next slice adding a `byKey` map is what this pins for.
    expect(normalizeJiraKey('constructor-1')).toBe('CONSTRUCTOR-1')
    expect(numberFromKey('constructor-1')).toBe(1)
    expect(normalizeJiraKey('toString-1')).toBe('TOSTRING-1')
    expect(normalizeJiraKey('prototype-2')).toBe('PROTOTYPE-2')
    // `__proto__` starts with an underscore, so it is not a project key at all — it is
    // still USABLE, verbatim, like every other unrecognised name.
    expect(isJiraKey('__proto__-1')).toBe(false)
    expect(usableJiraKey('__proto__-1')).toBe('__proto__-1')
  })

  it('leaves Object.prototype exactly as it found it', () => {
    // Anti-vacuity for the test above: the claim is that these names are just text.
    const before = Object.getOwnPropertyNames(Object.prototype).length
    for (const key of ['__proto__-1', 'constructor-1', 'prototype-3', 'toString-4', 'valueOf-5']) {
      usableJiraKey(key)
      normalizeJiraKey(key)
      numberFromKey(key)
      isJiraKey(key)
    }
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before)
    expect({}.polluted).toBeUndefined()
    expect([].polluted).toBeUndefined()
  })
})

describe('unbounded input — the pattern is anchored, so it stays linear (#127 QA)', () => {
  it('answers a megabyte of letters without throwing and without hanging', () => {
    // The regex is `^([A-Za-z][A-Za-z0-9_]*)-(\d+)$`. Anchored at both ends with one
    // greedy class and one required literal, so there is no nested quantifier for a long
    // string to make exponential — but "it looks fine" is not a measurement, and this
    // value arrives from acli's JSON, i.e. from outside. A generous ceiling: the point is
    // to catch a catastrophic case, not to benchmark a machine.
    const long = 'A'.repeat(1_000_000)
    for (const input of [long, long + '-', long + '-1', long + '-1x', '1'.repeat(1_000_000)]) {
      const started = Date.now()
      expect(() => usableJiraKey(input)).not.toThrow()
      expect(Date.now() - started, `${input.length} chars`).toBeLessThan(2000)
    }
  })

  it('does not BOUND what it passes through — a megabyte of text is a usable key', () => {
    // Pinned rather than judged, and it is the one place this module is permissive about
    // SIZE as well as about shape. That string goes into an acli argv and into
    // .ralph/run-state.json verbatim; lib/progress.js caps what it draws (its own
    // RAW_TITLE_LIMIT), so the terminal is safe and the FILE is not bounded here.
    const long = 'x'.repeat(1_000_000)
    expect(usableJiraKey(long)).toHaveLength(1_000_000)
    // A recognised key of a million digits keeps its key and loses its number, which is
    // the safe-integer refusal doing its job at scale.
    const bigNumber = 'FOO-' + '9'.repeat(400)
    expect(normalizeJiraKey(bigNumber)).toBe(bigNumber)
    expect(numberFromKey(bigNumber)).toBe(null)
  })
})
