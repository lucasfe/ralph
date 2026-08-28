import { describe, it, expect } from 'vitest'
import { buildPostMortem, renderPostMortem } from './post-mortem.js'
import { padTaskNumber } from './progress.js'

// QA augmentation for #59. The dev's post-mortem.test.js pins the happy-path card,
// the two count sources and a first pass at the partial records a kill leaves behind.
// What is attacked here is the seam the whole module exists to defend, from both
// sides at once:
//
//   1. ABSENT IS NOT ZERO, AND ZERO IS NOT ABSENT. `0 failed` on a run that never
//      recorded a count is a report card asserting a clean night nobody observed —
//      and `unknown` on a run that really did fail nothing is a card refusing to
//      report the good news it has. Both directions are swept below over every
//      spelling of "no count" a record can carry (`null`, `undefined`, the key
//      absent, `NaN`, `'7'`, `-0`, `false`), because the record is JSON somebody
//      else wrote and only one of those spellings comes from run-state.js.
//   2. issues.jsonl IS UNTRUSTED APPEND-ONLY TEXT. Not "possibly malformed" —
//      untrusted: the loop appends to it while this module reads it, an older
//      release wrote rows with fewer fields, and a hard kill leaves a half line.
//      So the sweeps here feed it magnitudes that each pass a finite check but whose
//      SUM does not, issue numbers that are not numbers, verdicts that are not
//      strings, and the same task twice.
//   3. EVERY FIELD IS NULL OR FINITE — including after the arithmetic. Asserted
//      structurally (walk the snapshot, walk the rendered text) rather than field by
//      field, so a field added later is covered the day it appears.
//
// Hermetic: local Date constructors for the wall-clock fixtures (`finished 06:12` is
// a local reading, so a UTC ISO literal would make the suite red outside UTC) and an
// injected epoch-ms `now` everywhere. No clock, no fs, no network is touched.

const RUN_ID = 'ralph-repo-9f2c1a'
const MIN = 60000

const RUN_STARTED = new Date(2026, 7, 25, 20, 20, 0)
const RUN_FINISHED = new Date(2026, 7, 26, 6, 12, 0) // 9h52m of wall clock
const NOW = new Date(2026, 7, 26, 8, 30, 0).getTime() // 2h18m after the finish

const tagged = (row) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(row)
const event = ({ n, verdict = 'pass', cost = 30, runId = RUN_ID, ...rest }) =>
  tagged({ issue_number: n, run_id: runId, verdict, total_cost_usd: cost, ...rest })

// A terminal record, as endRun writes it — `current` INCLUDED, because endRun
// deliberately keeps the last task the run worked on.
const terminal = (overrides = {}) => ({
  schema: 1,
  run_id: RUN_ID,
  session: 'ralph-repo',
  source: 'github',
  status: 'partial',
  started_at: RUN_STARTED.toISOString(),
  queue_at_start: 11,
  current: { number: 42, started_at: new Date(2026, 7, 26, 5, 30, 0).toISOString(), iteration: 9 },
  finished_at: RUN_FINISHED.toISOString(),
  ok: 7,
  failed: 2,
  ...overrides,
})

// What a hard-killed run leaves on disk, EXACTLY as beginRun wrote it: still
// `running`, no finish, and `ok`/`failed` still the nulls beginRun initialised them
// to. That last detail is the one this file re-derives from run-state.js rather than
// assuming: if a future beginRun ever seeded them with 0 instead, the record's counts
// would beat the tally and every killed run would report `0 ok · 0 failed`.
const killed = (overrides = {}) =>
  terminal({ status: 'running', finished_at: null, ok: null, failed: null, ...overrides })

const build = (overrides = {}) =>
  buildPostMortem({ metricsText: '', record: terminal(), queue: 2, now: NOW, ...overrides })

const card = (overrides = {}) => renderPostMortem(build(overrides))
const outcomeOf = (overrides = {}) => card(overrides)[1]

// The two structural invariants, asserted over whatever shape the snapshot has
// TODAY: a field added to the snapshot later is covered by these the day it lands.
const expectNoInventedNumbers = (snapshot, label) => {
  for (const [field, value] of Object.entries(snapshot)) {
    if (typeof value === 'number') {
      expect(Number.isFinite(value), `${label}: ${field} = ${value}`).toBe(true)
      expect(Object.is(value, -0), `${label}: ${field} is -0`).toBe(false)
    }
  }
}

const expectReadableCard = (lines, label) => {
  const text = lines.join('\n')
  for (const forbidden of ['NaN', 'Infinity', 'undefined', 'null', 'Invalid Date', '--:--']) {
    expect(text, `${label}: the card said "${forbidden}"`).not.toContain(forbidden)
  }
  // A negative duration or a negative sum of money is the shape two clocks and one
  // corrupt row produce, and it is never a reading a reader can act on.
  expect(text, label).not.toMatch(/-\d+min|-\d+h\d\dm|\$-/)
  // A trailing `—` reads as a list the renderer forgot to fill in (the issue's AC).
  expect(text, label).not.toMatch(/—\s*$/m)
}

describe('buildPostMortem — absent is not zero, and zero is not absent (#59 QA)', () => {
  // The whole module exists for this distinction, so it is swept from both sides over
  // every spelling of a count a record can carry. `expected` is what the outcome line
  // must read with NO events behind it, which is what isolates the record's own
  // contribution: anything the record does not supply has to come out `unknown`,
  // because there is no tally to fall back to.
  const counts = {
    'the numbers endRun writes': { ok: 7, failed: 2, expected: '7 ok · 2 failed' },
    'a clean night, recorded': { ok: 9, failed: 0, expected: '9 ok · 0 failed' },
    'a night that finished nothing, recorded': { ok: 0, failed: 4, expected: '0 ok · 4 failed' },
    'both zero, recorded': { ok: 0, failed: 0, expected: '0 ok · 0 failed' },
    // `-0` survives JSON.parse('{"ok":-0}') as -0, and `${-0}` is the string "0"
    // anyway — but the snapshot must not carry one, because a consumer diffing two
    // documents would see -0 !== 0 on a strict compare.
    'a negative zero (JSON.parse keeps it)': { ok: -0, failed: -0, expected: '0 ok · 0 failed' },
    'nulls, the way beginRun initialises them': { ok: null, failed: null, expected: 'unknown' },
    'undefined, an older release’s record': { ok: undefined, failed: undefined, expected: 'unknown' },
    'NaN, a count that failed to parse': { ok: NaN, failed: NaN, expected: 'unknown' },
    'Infinity, a count that overflowed': { ok: Infinity, failed: Infinity, expected: 'unknown' },
    'strings, the shape bash would hand over': { ok: '7', failed: '2', expected: 'unknown' },
    'booleans, a truthiness bug upstream': { ok: true, failed: false, expected: 'unknown' },
    'objects': { ok: {}, failed: [], expected: 'unknown' },
    'only the ok half recorded': { ok: 5, failed: null, expected: '5 ok' },
    'only the failed half recorded': { ok: null, failed: 5, expected: '5 failed' },
    'only a recorded zero on the ok half': { ok: 0, failed: null, expected: '0 ok' },
    'only a recorded zero on the failed half': { ok: null, failed: 0, expected: '0 failed' },
  }

  for (const [label, { ok, failed, expected }] of Object.entries(counts)) {
    it(`reads ${label} as "${expected}"`, () => {
      const record = terminal({ ok, failed })
      const snapshot = buildPostMortem({ metricsText: '', record, queue: 2, now: NOW })
      expectNoInventedNumbers(snapshot, label)
      expect(renderPostMortem(snapshot)[1], label).toBe(`  outcome    ${expected}`)
      expectReadableCard(renderPostMortem(snapshot), label)
    })
  }

  it('reads a KEY THAT IS NOT THERE as unknown, not as the zero of its type', () => {
    // Distinct from `ok: undefined`: `delete` is what an older release's record and a
    // hand-edited one actually look like, and `'ok' in record` is false rather than
    // true-with-undefined. `??` treats them alike, and that has to stay true.
    const record = terminal()
    delete record.ok
    delete record.failed
    const snapshot = buildPostMortem({ metricsText: '', record, queue: 2, now: NOW })
    expect(snapshot.ok).toBe(null)
    expect(snapshot.failed).toBe(null)
    expect(renderPostMortem(snapshot)[1]).toBe('  outcome    unknown')
  })

  it('never lets the tally overwrite a recorded zero', () => {
    // `?? tallied` and not `|| tallied`: a recorded 0 is a measurement and must win
    // over the fallback exactly as a recorded 7 does. With events present, `||` would
    // silently promote the tally here and nowhere else.
    const rows = [event({ n: 29 }), event({ n: 30 })].join('\n')
    const snapshot = build({ metricsText: rows, record: terminal({ ok: 0, failed: 0 }) })
    expect(snapshot.ok).toBe(0)
    expect(snapshot.failed).toBe(0)
    expect(renderPostMortem(snapshot)[1]).toBe('  outcome    0 ok · 0 failed')
  })

  it('reports a REAL empty queue as `0 waiting` and a failed count as `unknown`', () => {
    // The queue's own half of the same distinction, and the only zero on the card
    // that is a measurement rather than a stand-in.
    expect(card({ queue: 0 })[4]).toBe('  queue      0 waiting')
    for (const queue of [null, undefined, NaN, Infinity, '0', '6', {}, [], false]) {
      expect(card({ queue })[4], JSON.stringify(queue) ?? 'undefined').toBe('  queue      unknown')
    }
  })

  it('reports a REAL zero spend as unknown, because a zero cost is not a measurement', () => {
    // A Codex run records no cost at all and the loop writes 0 when it could not
    // read one, so `$0.00 total` would read as a free night rather than an unmeasured
    // one. Same `usableSamples` rule the live view's spend uses.
    const free = [event({ n: 29, cost: 0 }), event({ n: 30, cost: null })].join('\n')
    const lines = card({ metricsText: free, record: killed() })
    expect(lines[2]).toBe('  spend      unknown')
    expect(lines.join('\n')).not.toContain('$0.00')
    // ...but the counts it DID observe still print: two separate measurements.
    expect(lines[1]).toBe('  outcome    2 ok · 0 failed')
  })
})

describe('buildPostMortem — a record nobody finished writing (#59 QA)', () => {
  // Every one of these is a record `readRunState` will hand over verbatim: it only
  // refuses JSON that is not an object, so a scalar cannot arrive — but `renderStatus`
  // and `buildPostMortem` are exported and a caller may pass anything, and the promise
  // is "never throws", not "never throws for the shapes we expect".
  const records = {
    'no record at all': null,
    'undefined': undefined,
    'an empty object': {},
    'an empty array': [],
    'an array of numbers': [1, 2, 3],
    'a bare string': 'idle',
    'a number': 42,
    'a boolean': true,
    'a prototype-less object': Object.assign(Object.create(null), { status: 'success', run_id: RUN_ID }),
    'a record whose fields are all objects': { status: {}, run_id: {}, ok: {}, failed: {}, started_at: {}, finished_at: {} },
    'a record whose fields are all arrays': { status: [], run_id: [], ok: [], failed: [], started_at: [], finished_at: [] },
  }

  for (const [label, record] of Object.entries(records)) {
    it(`yields a readable card, never a throw, for ${label}`, () => {
      let snapshot
      expect(() => {
        snapshot = buildPostMortem({ metricsText: '', record, queue: null, now: NOW })
      }, label).not.toThrow()
      expectNoInventedNumbers(snapshot, label)
      let lines
      expect(() => {
        lines = renderPostMortem(snapshot)
      }, label).not.toThrow()
      // Seven lines, always: the card's shape is not a function of how broken the
      // record is, so a reader never has to work out which lines went missing.
      expect(lines.length, label).toBe(7)
      expectReadableCard(lines, label)
      expect(lines.at(-1), label).toContain('ralph start')
    })
  }

  // Timestamps are the field a record is most likely to carry in the wrong shape:
  // bash writes them, an older release wrote a different format, and a kill can
  // truncate one mid-string. `wall` is what `ran for` must read given the paired
  // start, `finish` what the heading must read.
  const stamps = {
    'an empty string': { at: '', wall: 'unknown', finish: 'finished unknown' },
    'a word': { at: 'yesterday', wall: 'unknown', finish: 'finished unknown' },
    'the literal "null"': { at: 'null', wall: 'unknown', finish: 'finished unknown' },
    'a JSON null': { at: null, wall: 'unknown', finish: 'finished unknown' },
    'undefined': { at: undefined, wall: 'unknown', finish: 'finished unknown' },
    'epoch ms as a number': { at: 1756100000000, wall: 'unknown', finish: 'finished unknown' },
    'an object': { at: {}, wall: 'unknown', finish: 'finished unknown' },
    'an ISO string truncated mid-write': { at: '2026-08-26T06:1', wall: 'unknown', finish: 'finished unknown' },
    'an impossible offset': { at: '2026-08-26T06:12:00+99:00', wall: 'unknown', finish: 'finished unknown' },
    'one millisecond past the last instant Date can hold': {
      at: '+275760-09-14T00:00:00.000Z',
      wall: 'unknown',
      finish: 'finished unknown',
    },
  }

  for (const [label, { at, wall, finish }] of Object.entries(stamps)) {
    it(`reads a start and a finish of ${label} as unknown, both ways round`, () => {
      // Both stamps bad, then each one alone: `null - x` is a NUMBER in JS, so a
      // single missing stamp is the case that would otherwise report a run of
      // negative eternity or an age measured from 1970.
      for (const [which, record] of Object.entries({
        both: terminal({ started_at: at, finished_at: at }),
        'start only': terminal({ started_at: at }),
        'finish only': terminal({ finished_at: at }),
      })) {
        const lines = card({ record })
        const where = `${label} (${which})`
        expectNoInventedNumbers(build({ record }), where)
        expectReadableCard(lines, where)
        if (which !== 'start only') expect(lines[0], where).toContain(finish)
        expect(lines[3], where).toBe(`  ran for    ${wall}`)
      }
    })
  }

  it('trusts Date.parse’s reading of a bare number, which is a plausible date', () => {
    // CHARACTERISATION, and the one stamp that does NOT degrade: `Date.parse` coerces
    // to string first, so a numeric `0` reads as the year 2000 and `2026` as
    // 2026-01-01 — both finite, both plausible, neither the run's. Recorded here
    // because the guard is a FINITENESS check and no finiteness check can catch this:
    // it would take a shape check on the stamp itself. Not reachable through the CLI
    // (run-state.js only ever writes `new Date().toISOString()`), so it is pinned
    // rather than argued with — but a card reading `ran for 228854h` is the visible
    // symptom if it ever becomes reachable.
    const y2k = build({ record: terminal({ started_at: 0, finished_at: 0 }) })
    expect(y2k.finishedAt).toBe(Date.parse('0'))
    expect(y2k.wallMs).toBe(0)
    expect(renderPostMortem(y2k)[3]).toBe('  ran for    0min')
    const y2026 = build({ record: terminal({ started_at: 2026, finished_at: 2026 }) })
    expect(y2026.finishedAt).toBe(Date.parse('2026-01-01T00:00:00Z'))
    // Whatever it read, it is still finite and still readable — the promise that holds.
    for (const snapshot of [y2k, y2026]) {
      expectNoInventedNumbers(snapshot, 'numeric stamp')
      expectReadableCard(renderPostMortem(snapshot), 'numeric stamp')
    }
  })

  it('holds the calendar’s last instant without inventing a clock reading', () => {
    // The largest value Date.parse can answer with. It is finite, so it passes every
    // guard on the way to the renderer, and the renderer must format it rather than
    // fall off the end of the calendar.
    const CEIL = '+275760-09-13T00:00:00.000Z'
    const snapshot = build({ record: terminal({ started_at: CEIL, finished_at: CEIL }) })
    expect(snapshot.finishedAt).toBe(Date.parse(CEIL))
    expectNoInventedNumbers(snapshot, 'calendar ceiling')
    expectReadableCard(renderPostMortem(snapshot), 'calendar ceiling')
  })

  it('never reports a negative run for a finish recorded before the start', () => {
    // Two stamps written by two clocks — a container's and the host's — or a record
    // merged from two runs.
    for (const gap of [1, 60000, 9 * 3600000, 8.6e15 - RUN_FINISHED.getTime()]) {
      const record = terminal({
        started_at: new Date(RUN_FINISHED.getTime() + gap).toISOString(),
        finished_at: RUN_FINISHED.toISOString(),
      })
      const snapshot = build({ record })
      expect(snapshot.wallMs, `gap ${gap}`).toBe(-gap)
      // The snapshot keeps the sign (it is the measured difference), and the renderer
      // is what refuses to print it.
      expect(renderPostMortem(snapshot)[3], `gap ${gap}`).toBe('  ran for    0min')
      expectReadableCard(renderPostMortem(snapshot), `gap ${gap}`)
    }
  })

  it('never reports a negative age for a finish recorded after now', () => {
    // A record stamped by a machine whose clock runs fast, read by one whose does not.
    const record = terminal({ finished_at: new Date(NOW + 3 * 3600000).toISOString() })
    const snapshot = build({ record })
    expect(snapshot.ageMs).toBe(-3 * 3600000)
    const lines = renderPostMortem(snapshot)
    expect(lines[0]).toContain('0min ago')
    expectReadableCard(lines, 'future finish')
  })

  it('reads the age as unknown when the CLOCK is the thing that is missing', () => {
    // `now` is injected, so an unusable one is a real case for a caller that lost its
    // clock — and `nowMs - finishedAt` with a null `now` would land the age in 1970.
    for (const now of [null, undefined, NaN, Infinity, '1756100000000', {}]) {
      const snapshot = build({ now })
      expect(snapshot.ageMs, String(now)).toBe(null)
      // The finish itself is a fact on disk and still prints; only the age needed a
      // clock, so only the age goes.
      expect(snapshot.finishedAt, String(now)).toBe(RUN_FINISHED.getTime())
      expect(renderPostMortem(snapshot)[0], String(now)).toBe(
        `▸ ralph — idle · run ${RUN_ID} (finished 06:12)`,
      )
      expectReadableCard(renderPostMortem(snapshot), String(now))
    }
  })

  it('accepts a frozen record and mutates nothing it was handed', () => {
    // A status view owns none of what it reads, and the caller may publish the same
    // record to another surface after this call.
    const record = Object.freeze({ ...terminal(), current: Object.freeze({ number: 42 }) })
    const metricsText = [event({ n: 29 }), event({ n: 34, verdict: 'fail' })].join('\n')
    const before = JSON.stringify(record)
    let snapshot
    expect(() => {
      snapshot = buildPostMortem({ metricsText, record, queue: 2, now: NOW })
    }).not.toThrow()
    expect(JSON.stringify(record)).toBe(before)
    // ...and the renderer does not consume the snapshot it was handed: the shell may
    // hand the same object to a second surface.
    const numbersBefore = [...snapshot.failedNumbers]
    renderPostMortem(snapshot)
    renderPostMortem(snapshot)
    expect(snapshot.failedNumbers).toEqual(numbersBefore)
    expect(buildPostMortem({ metricsText, record, queue: 2, now: NOW })).toEqual(snapshot)
  })
})

describe('buildPostMortem — issues.jsonl is untrusted append-only text (#59 QA)', () => {
  const hostileTexts = {
    'nothing': '',
    'a null': null,
    'undefined': undefined,
    'a Buffer, the shape readFileSync answers with': Buffer.from(event({ n: 29 })),
    'a number': 42,
    'only blank lines': '\n\n\n',
    'only untagged noise': 'npm WARN deprecated foo@1.0.0\nnpm notice\n',
    'a truncated last line (a run killed mid-append)':
      [event({ n: 29 }), 'RALPH_ISSUE_EVENT {"issue_number":30,"run_'].join('\n'),
    'a tag with no payload at all': 'RALPH_ISSUE_EVENT ',
    'valid JSON that is an array': 'RALPH_ISSUE_EVENT []',
    'valid JSON that is null': 'RALPH_ISSUE_EVENT null',
    'valid JSON that is a number': 'RALPH_ISSUE_EVENT 42',
    'valid JSON that is a string': 'RALPH_ISSUE_EVENT "done"',
    'valid JSON that is a bare true': 'RALPH_ISSUE_EVENT true',
    'CRLF line endings': [event({ n: 29 }), event({ n: 30 })].join('\r\n'),
    'a 200-line run': Array.from({ length: 200 }, (_, i) => event({ n: i, cost: 1 })).join('\n'),
  }

  for (const [label, metricsText] of Object.entries(hostileTexts)) {
    it(`never throws and invents nothing for ${label}`, () => {
      let snapshot
      expect(() => {
        snapshot = buildPostMortem({ metricsText, record: killed(), queue: 2, now: NOW })
      }, label).not.toThrow()
      expectNoInventedNumbers(snapshot, label)
      expect(Array.isArray(snapshot.failedNumbers), label).toBe(true)
      expectReadableCard(renderPostMortem(snapshot), label)
    })
  }

  // The sum is the one place finite inputs produce a non-finite output, and the guard
  // has to be on the TOTAL rather than on each row. Two of these overflow; the third
  // is the case a per-row-only guard would pass and a total-only guard would catch.
  const overflows = {
    'two rows at the top of the double range': [1e308, 1e308],
    'three rows that each pass a finite check': [9e307, 9e307, 9e307],
    'a hundred rows of a twentieth of the range': Array.from({ length: 100 }, () => 1.7e307),
    'the largest finite double, twice': [Number.MAX_VALUE, Number.MAX_VALUE],
  }

  for (const [label, costs] of Object.entries(overflows)) {
    it(`degrades an overflowing spend to unknown for ${label}`, () => {
      const rows = costs.map((cost, i) => event({ n: i + 1, cost })).join('\n')
      const snapshot = build({ metricsText: rows, record: killed() })
      // Each row passed its own guard...
      expect(costs.every((c) => Number.isFinite(c))).toBe(true)
      // ...and the total did not, so both money figures go rather than one.
      expect(snapshot.spendUsd, label).toBe(null)
      expect(snapshot.costPerTaskUsd, label).toBe(null)
      const lines = renderPostMortem(snapshot)
      expect(lines[2], label).toBe('  spend      unknown')
      // The COUNTS came from a different measurement and must survive the overflow:
      // one broken number must not take the readable ones with it.
      expect(lines[1], label).toBe(`  outcome    ${costs.length} ok · 0 failed`)
      expectReadableCard(lines, label)
    })
  }

  it('keeps an absurd total that is still finite — the guard is not a magnitude ceiling', () => {
    // The other side of the same guard, so a future "reject anything implausible"
    // change cannot pass by rejecting everything: 3 × 4e307 is 1.2e308, absurd but
    // finite, and the module's stated rule is finiteness alone.
    const rows = [4e307, 4e307, 4e307].map((cost, i) => event({ n: i + 1, cost })).join('\n')
    const snapshot = build({ metricsText: rows, record: killed() })
    expect(snapshot.spendUsd).toBe(1.2e308)
    expect(snapshot.costPerTaskUsd).toBe(4e307)
  })

  it('drops a cost that is not a spend, one row at a time', () => {
    // Each of these is "not measured" rather than "measured as zero", so the total is
    // the 30 the one usable row recorded and the average is over that one row.
    const rows = [
      event({ n: 1, cost: 30 }),
      event({ n: 2, cost: 0 }),
      event({ n: 3, cost: -12.5 }),
      event({ n: 4, cost: '30' }),
      event({ n: 5, cost: null }),
      event({ n: 6, cost: NaN }), // JSON.stringify writes this as null
      event({ n: 7, cost: {} }),
      tagged({ issue_number: 8, run_id: RUN_ID, verdict: 'pass' }), // no cost key at all
    ].join('\n')
    const snapshot = build({ metricsText: rows, record: killed() })
    expect(snapshot.spendUsd).toBe(30)
    expect(snapshot.costPerTaskUsd).toBe(30)
    // All eight rows are still TASKS, though: the count and the spend are two
    // separate measurements over the same events.
    expect(snapshot.ok).toBe(8)
    expect(renderPostMortem(snapshot)[2]).toBe('  spend      $30.00 total · $30.0/task avg')
  })

  it('reports an average over the rows that recorded a cost, not over the task count', () => {
    // Documented policy, pinned because the two numbers on the card look like they
    // divide into each other and do not: a mixed Claude/Codex night records a cost for
    // half its tasks, and rating over all nine would report half the real rate.
    const rows = [
      event({ n: 1, cost: 30 }),
      event({ n: 2, cost: 30 }),
      event({ n: 3, cost: 30 }),
      ...[4, 5, 6, 7, 8, 9].map((n) => event({ n, cost: 0 })),
    ].join('\n')
    const snapshot = build({ metricsText: rows, record: terminal({ ok: 9, failed: 0 }) })
    expect(snapshot.spendUsd).toBe(90)
    expect(snapshot.costPerTaskUsd).toBe(30)
    const lines = renderPostMortem(snapshot)
    expect(lines[1]).toBe('  outcome    9 ok · 0 failed')
    // $90 over "9 ok" is $10 a task by the reader's arithmetic and $30 by the card's.
    expect(lines[2]).toBe('  spend      $90.00 total · $30.0/task avg')
  })

  const verdicts = {
    'a pass': { verdict: 'pass', ok: 1, failed: 0 },
    'a fail': { verdict: 'fail', ok: 0, failed: 1 },
    'an explicit unknown': { verdict: 'unknown', ok: 0, failed: 1 },
    'an empty verdict': { verdict: '', ok: 0, failed: 1 },
    'a shouted PASS': { verdict: 'PASS', ok: 0, failed: 1 },
    'a padded pass': { verdict: ' pass', ok: 0, failed: 1 },
    'a verdict that is true': { verdict: true, ok: 0, failed: 1 },
    'a verdict that is a number': { verdict: 1, ok: 0, failed: 1 },
    'a verdict that is an object': { verdict: {}, ok: 0, failed: 1 },
    'a verdict that is null': { verdict: null, ok: 0, failed: 1 },
  }

  for (const [label, { verdict, ok, failed }] of Object.entries(verdicts)) {
    it(`counts ${label} the conservative way (${ok} ok, ${failed} failed)`, () => {
      // `pass` is ok and EVERYTHING else is failed — an indeterminate iteration
      // counts against the run, the same accounting aggregateCycleCounts uses.
      const snapshot = build({ metricsText: event({ n: 34, verdict }), record: killed() })
      expect(snapshot.ok, label).toBe(ok)
      expect(snapshot.failed, label).toBe(failed)
      expect(snapshot.failedNumbers, label).toEqual(failed ? [34] : [])
    })
  }

  it('names only the failures it can name, and still counts the ones it cannot', () => {
    // An event with an unusable issue number is a failure that happened; dropping it
    // from the COUNT as well would report a cleaner night than the run had.
    const rows = [
      event({ n: 41, verdict: 'fail' }),
      event({ n: 'thirty-four', verdict: 'fail' }),
      event({ n: null, verdict: 'fail' }),
      event({ n: undefined, verdict: 'fail' }), // JSON.stringify drops the key
      event({ n: NaN, verdict: 'fail' }),
      event({ n: {}, verdict: 'fail' }),
      event({ n: 34, verdict: 'fail' }),
    ].join('\n')
    const snapshot = build({ metricsText: rows, record: killed() })
    expect(snapshot.failed).toBe(7)
    expect(snapshot.failedNumbers).toEqual([41, 34])
    expect(renderPostMortem(snapshot)[1]).toBe('  outcome    0 ok · 7 failed  — #041 #034')
  })

  it('counts the same task twice when the file recorded it twice', () => {
    // A retried task, or a row appended twice by a re-entrant loop. Deduplicating
    // would be a policy neither module has, and the card would then disagree with
    // `ralph metrics` over the same file — so the behaviour is pinned, not assumed.
    const rows = [
      event({ n: 34, verdict: 'fail', cost: 10 }),
      event({ n: 34, verdict: 'fail', cost: 10 }),
      event({ n: 34, verdict: 'pass', cost: 10 }),
    ].join('\n')
    const snapshot = build({ metricsText: rows, record: killed() })
    expect(snapshot.ok).toBe(1)
    expect(snapshot.failed).toBe(2)
    expect(snapshot.failedNumbers).toEqual([34, 34])
    expect(renderPostMortem(snapshot)[1]).toBe('  outcome    1 ok · 2 failed  — #034 #034')
    expect(snapshot.spendUsd).toBe(30)
  })

  const widths = {
    'a single digit': { n: 7, rendered: '#007' },
    'two digits': { n: 41, rendered: '#041' },
    'three digits': { n: 341, rendered: '#341' },
    'four digits, never truncated': { n: 1234, rendered: '#1234' },
    'six digits, never truncated': { n: 998877, rendered: '#998877' },
    'a zero': { n: 0, rendered: '#000' },
  }

  for (const [label, { n, rendered }] of Object.entries(widths)) {
    it(`pads a failed number of ${label} to ${rendered}`, () => {
      // The padding is what makes `#034 #041` read as a column, and the "never cut"
      // half is what keeps a four-digit repo's numbers honest.
      expect(`#${padTaskNumber(n)}`).toBe(rendered)
      const snapshot = build({ metricsText: event({ n, verdict: 'fail' }), record: killed() })
      expect(renderPostMortem(snapshot)[1]).toBe(`  outcome    0 ok · 1 failed  — ${rendered}`)
    })
  }
})

describe('buildPostMortem — every number is scoped to THIS run (#59 QA)', () => {
  // issues.jsonl accumulates across runs, and the file outlives every one of them.
  const foreign = [
    event({ n: 90, runId: 'run-old', cost: 500, verdict: 'fail' }),
    event({ n: 91, runId: 'run-old', cost: 500, verdict: 'fail' }),
  ].join('\n')

  const unnameable = {
    'a null run id': null,
    'an undefined run id': undefined,
    'an empty run id': '',
    'a run id that is an object': {},
    'a run id that is an array': [],
    'a run id that is false': false,
    'a run id that is NaN': NaN,
    'a run id that is Infinity': Infinity,
  }

  for (const [label, run_id] of Object.entries(unnameable)) {
    it(`matches NOTHING — not everything — for ${label}`, () => {
      // The direction that matters: a record too broken to name its run must not
      // inherit another run's failures, its spend or its outcome.
      const snapshot = build({ metricsText: foreign, record: killed({ run_id }) })
      expect(snapshot.runId, label).toBe(null)
      expect(snapshot.ok, label).toBe(null)
      expect(snapshot.failed, label).toBe(null)
      expect(snapshot.failedNumbers, label).toEqual([])
      expect(snapshot.spendUsd, label).toBe(null)
      const lines = renderPostMortem(snapshot)
      expect(lines[0], label).toContain('run unknown')
      expect(lines[1], label).toBe('  outcome    unknown')
      expect(lines.join('\n'), label).not.toContain('1000')
      expect(lines.join('\n'), label).not.toContain('#090')
    })
  }

  const scoping = {
    'a numeric id on both sides': { record: 7, event: 7, matches: true },
    'a numeric record id and a string event id': { record: 7, event: '7', matches: true },
    'a string record id and a numeric event id': { record: '7', event: 7, matches: true },
    'a zero id (falsy, but a name)': { record: 0, event: 0, matches: true },
    'a "0" string id': { record: '0', event: '0', matches: true },
    'a different run': { record: 'run-a', event: 'run-b', matches: false },
    'a trailing space': { record: 'run-a', event: 'run-a ', matches: false },
    'a case difference': { record: 'run-a', event: 'RUN-A', matches: false },
    'an event with no run id at all': { record: 'run-a', event: undefined, matches: false },
    'an event whose run id is null': { record: 'run-a', event: null, matches: false },
    'an id that only looks numeric': { record: '007', event: 7, matches: false },
  }

  for (const [label, { record, event: eventRunId, matches }] of Object.entries(scoping)) {
    it(`${matches ? 'claims' : 'refuses'} an event for ${label}`, () => {
      const rows = tagged({ issue_number: 34, run_id: eventRunId, verdict: 'fail', total_cost_usd: 12 })
      const snapshot = buildPostMortem({
        metricsText: rows,
        record: { status: 'running', run_id: record },
        queue: 2,
        now: NOW,
      })
      expect(snapshot.failed, label).toBe(matches ? 1 : null)
      expect(snapshot.failedNumbers, label).toEqual(matches ? [34] : [])
      expect(snapshot.spendUsd, label).toBe(matches ? 12 : null)
    })
  }

  it('reports the run’s own rows out of a file dominated by other runs', () => {
    const mixed = [
      event({ n: 1, runId: 'run-a', cost: 100 }),
      event({ n: 34, verdict: 'fail', cost: 30 }),
      event({ n: 2, runId: 'run-b', cost: 100, verdict: 'fail' }),
      event({ n: 35, cost: 20 }),
      event({ n: 3, runId: 'run-c', cost: 100 }),
    ].join('\n')
    const snapshot = build({ metricsText: mixed, record: killed() })
    expect(snapshot.ok).toBe(1)
    expect(snapshot.failed).toBe(1)
    expect(snapshot.failedNumbers).toEqual([34])
    expect(snapshot.spendUsd).toBe(50)
  })
})

describe('buildPostMortem — an interrupted run has no finish (#59 QA)', () => {
  it('substitutes NOTHING for the ending nobody wrote', () => {
    // A run killed at 03:00 and read at 09:00 did not run for nine hours, and the
    // one number a reader would carry away from this card is the wall clock. `now`
    // is six hours from the record here, so a substitution would be visible.
    const snapshot = build({ record: killed(), now: NOW })
    expect(snapshot.finishedAt).toBe(null)
    expect(snapshot.ageMs).toBe(null)
    expect(snapshot.wallMs).toBe(null)
    const lines = renderPostMortem(snapshot)
    expect(lines[0]).toBe(`▸ ralph — interrupted · run ${RUN_ID} (finished unknown)`)
    expect(lines[3]).toBe('  ran for    unknown')
    // No age phrase on the FINISH, rather than an age of zero. Scoped to the heading
    // and the duration by the dev: an interrupted card now carries the run's START and
    // its age (`started 20:20, 12h10m ago`), which is a reading of a stamp the record
    // really has and the only temporal anchor a killed run can offer. The property this
    // test exists for is unchanged — nothing is substituted for the ending nobody
    // wrote, and the two lines that would carry such a substitution are pinned above.
    expect(lines[0]).not.toContain('ago')
    expect(lines[0]).not.toContain('0min')
    expect(lines[3]).not.toContain('ago')
  })

  it('keeps a started_at it cannot use for a duration out of the duration line', () => {
    // The start IS on the record — the kill only cost it the finish — so this is the
    // shape a substitution would hide in: `now - started_at` is a perfectly finite
    // number and it is not this run's duration.
    const snapshot = build({ record: killed({ started_at: RUN_STARTED.toISOString() }) })
    expect(snapshot.wallMs).toBe(null)
    const lines = renderPostMortem(snapshot)
    // Scoped to the duration and the heading by the dev, for the reason in the test
    // above: `12h10m` (now − started_at) is now printed, LABELLED as the age of the
    // start, which is what it is. What this test forbids is any of these three numbers
    // appearing as the run's DURATION or as its finish, and that is asserted where it
    // would appear.
    for (const wrong of ['12h10m', '9h52m', '2h18m']) {
      expect(lines[3], wrong).not.toContain(wrong)
      expect(lines[0], wrong).not.toContain(wrong)
    }
    expect(lines[3]).toBe('  ran for    unknown')
    // ...and the one line that does carry it says what it is measuring.
    expect(lines[5]).toBe('  started    20:20, 12h10m ago')
  })

  it('still reports the counts, the numbers and the spend the kill did not erase', () => {
    // The whole reason the tally fallback exists: an interrupted record carries no
    // counts, and the rows it appended on the way are the only surviving account.
    const overnight = [
      ...[29, 30, 31, 32, 33].map((n) => event({ n, cost: 30 })),
      event({ n: 34, verdict: 'fail', cost: 30 }),
      event({ n: 40, cost: 30 }),
      event({ n: 41, verdict: 'unknown', cost: 30 }),
      event({ n: 42, cost: 28.1 }),
    ].join('\n')
    const lines = card({ metricsText: overnight, record: killed() })
    expect(lines[1]).toBe('  outcome    7 ok · 2 failed  — #034 #041')
    expect(lines[2]).toBe('  spend      $268.10 total · $29.8/task avg')
    expect(lines[4]).toBe('  queue      2 waiting')
    expect(lines.at(-1)).toBe('  restart    ralph start')
  })

  it('says `restart` for a killed run and `start` for a finished one, and nothing else', () => {
    // One command, two labels. The hint is the only line that differs between the
    // two modes, so it is the only thing a reader has to notice.
    expect(card({ record: killed() }).at(-1)).toBe('  restart    ralph start')
    expect(card({ record: terminal() }).at(-1)).toBe('  start      ralph start')
    for (const record of [killed(), terminal()]) {
      const text = card({ record }).join('\n')
      expect(text).not.toContain('tmux')
      expect(text).not.toContain('ralph stop')
      expect(text).not.toContain('ralph cycle')
    }
  })

  const statuses = {
    running: { interrupted: true, word: 'interrupted' },
    success: { interrupted: false, word: 'idle' },
    partial: { interrupted: false, word: 'idle' },
    failed: { interrupted: false, word: 'idle' },
    unknown: { interrupted: false, word: 'idle' },
    Running: { interrupted: false, word: 'idle' },
    ' running': { interrupted: false, word: 'idle' },
    'running ': { interrupted: false, word: 'idle' },
  }

  for (const [status, { interrupted, word }] of Object.entries(statuses)) {
    it(`calls a record whose status is ${JSON.stringify(status)} "${word}"`, () => {
      // The card's mode word is read off the RECORD, and `reconcileMode` in status.js
      // reads the mode off the same field with the same literal comparison. If either
      // ever loosened, the heading and the `--json` document's `mode` would disagree
      // over the same repo.
      const snapshot = build({ record: terminal({ status }) })
      expect(snapshot.interrupted, status).toBe(interrupted)
      expect(renderPostMortem(snapshot)[0], status).toContain(`▸ ralph — ${word} ·`)
    })
  }

  it('reports a half-written record that has BOTH a running status and a finish', () => {
    // `endRun` writes the status and the finish in one object, so this shape means
    // somebody else wrote the record — the card reports what it can read and the
    // heading's mode word is the one thing that stays a function of the status.
    const snapshot = build({ record: killed({ finished_at: RUN_FINISHED.toISOString() }) })
    expect(snapshot.interrupted).toBe(true)
    const lines = renderPostMortem(snapshot)
    expect(lines[0]).toBe(`▸ ralph — interrupted · run ${RUN_ID} (finished 06:12, 2h18m ago)`)
    expect(lines[3]).toBe('  ran for    9h52m')
    expectReadableCard(lines, 'running + finished_at')
  })
})

describe('renderPostMortem — the count-source precedence, and its disagreements (#59 QA)', () => {
  // Three failures in the file, and a record that disagrees with it. Precedence is
  // documented — the record wins — so what is attacked here is what the LIST does
  // when the number it annotates came from somewhere else.
  const threeFailures = [
    event({ n: 34, verdict: 'fail' }),
    event({ n: 41, verdict: 'fail' }),
    event({ n: 55, verdict: 'fail' }),
  ].join('\n')

  it('prints the record’s count even when the tally names a different number of tasks', () => {
    // endRun watched every iteration, including the ones that never reached
    // issues.jsonl, so its count is the authority. The list is an annotation and can
    // legitimately be shorter or longer than the count it annotates.
    const snapshot = build({ metricsText: threeFailures, record: terminal({ ok: 7, failed: 2 }) })
    expect(snapshot.failed).toBe(2)
    expect(snapshot.failedNumbers).toEqual([34, 41, 55])
    expect(renderPostMortem(snapshot)[1]).toBe('  outcome    7 ok · 2 failed  — #034 #041 #055')
  })

  it('silences the list when the record says nothing failed — and keeps it in the snapshot', () => {
    // `0 failed  — #034 #041 #055` would contradict itself on one line. The
    // suppression is a RENDERING decision, so a document published later still has the
    // whole picture rather than a card's editorial choice baked in.
    const snapshot = build({ metricsText: threeFailures, record: terminal({ ok: 9, failed: 0 }) })
    expect(snapshot.failedNumbers).toEqual([34, 41, 55])
    const lines = renderPostMortem(snapshot)
    expect(lines[1]).toBe('  outcome    9 ok · 0 failed')
    expect(lines[1]).not.toContain('#')
    expect(lines[1]).not.toContain('—')
  })

  it('does NOT silence the list when the count is unknown rather than zero', () => {
    // The suppression triggers on a recorded zero only. An absent count falls back to
    // the tally, which is the case an interrupted run is always in — silencing there
    // would hide every failure a killed run recorded.
    const snapshot = build({ metricsText: threeFailures, record: killed() })
    expect(snapshot.failed).toBe(3)
    expect(renderPostMortem(snapshot)[1]).toBe('  outcome    0 ok · 3 failed  — #034 #041 #055')
  })

  it('prints no dangling separator when the run really did fail nothing', () => {
    // The issue's AC, from both routes to a zero: recorded, and tallied.
    for (const [label, args] of Object.entries({
      recorded: { metricsText: [event({ n: 29 }), event({ n: 30 })].join('\n'), record: terminal({ ok: 2, failed: 0 }) },
      tallied: { metricsText: [event({ n: 29 }), event({ n: 30 })].join('\n'), record: killed() },
    })) {
      const lines = card(args)
      expect(lines[1], label).toBe('  outcome    2 ok · 0 failed')
      expect(lines[1], label).not.toContain('—')
      expect(lines[1], label).not.toContain('#')
      expectReadableCard(lines, label)
    }
  })

  it('prints no dangling separator for an empty failedNumbers beside a nonzero count', () => {
    // The count came from the record and the file has no rows for the run at all —
    // the shape an issues.jsonl rotated away from under a finished run leaves.
    const snapshot = build({ metricsText: '', record: terminal({ ok: 7, failed: 2 }) })
    expect(snapshot.failedNumbers).toEqual([])
    expect(renderPostMortem(snapshot)[1]).toBe('  outcome    7 ok · 2 failed')
  })

  it('reads a run of exactly one task without a plural or a list of one it cannot fill', () => {
    const one = build({ metricsText: event({ n: 29, cost: 12.5 }), record: killed() })
    expect(renderPostMortem(one)[1]).toBe('  outcome    1 ok · 0 failed')
    expect(renderPostMortem(one)[2]).toBe('  spend      $12.50 total · $12.5/task avg')
    const oneFail = build({ metricsText: event({ n: 29, verdict: 'fail', cost: 12.5 }), record: killed() })
    expect(renderPostMortem(oneFail)[1]).toBe('  outcome    0 ok · 1 failed  — #029')
  })

  it('reads a run whose every verdict was indeterminate as a run that failed', () => {
    const allUnknown = [29, 30, 31].map((n) => event({ n, verdict: 'unknown' })).join('\n')
    const lines = card({ metricsText: allUnknown, record: killed() })
    expect(lines[1]).toBe('  outcome    0 ok · 3 failed  — #029 #030 #031')
  })
})

describe('renderPostMortem — the card as a block of text (#59 QA)', () => {
  it('is one shape per mode, in one order, whatever it knows', () => {
    // The reader learns the shape once. A line that disappeared when its value was
    // unknown would make them count lines to find the one they came for.
    const worlds = {
      'everything known': {},
      'nothing known': { metricsText: '', record: {}, queue: null },
      'a killed run': { record: killed() },
      'an unnamed run': { record: { status: 'failed' } },
      'no record': { record: null },
      'no arguments at all': { metricsText: undefined, record: undefined, queue: undefined, now: undefined },
    }
    for (const [label, args] of Object.entries(worlds)) {
      const lines = card(args)
      const interrupted = lines[0].includes('— interrupted ·')
      // Seven lines for a run that ended, NINE for one that was killed: the dev added
      // the run's start, its age and the task it died on to the interrupted card, which
      // are the only readings a killed run can offer in place of the finish and the wall
      // clock it never recorded. The property this test defends is per-mode fixity — a
      // reader learns each shape once — so it is asserted per mode rather than loosened.
      expect(lines.length, label).toBe(interrupted ? 9 : 7)
      expect(lines[0], label).toMatch(/^▸ ralph — (idle|interrupted) · run /)
      // The four readings both modes share keep the same rows in both, so the card is
      // read the same way whichever it is.
      expect(lines.slice(1, 5).map((l) => l.slice(2, 13).trimEnd()), label).toEqual([
        'outcome',
        'spend',
        'ran for',
        'queue',
      ])
      expect(lines.slice(5, -2).map((l) => l.slice(2, 13).trimEnd()), label).toEqual(
        interrupted ? ['started', 'last task'] : [],
      )
      // The blank line is the block separator the live view uses before its advice.
      expect(lines.at(-2), label).toBe('')
      expect(lines.at(-1), label).toMatch(/^ {2}(start|restart) {4,}ralph start$/)
    }
  })

  it('holds the live view’s label column exactly, to the character', () => {
    // The two views are read minutes apart in the same terminal, from the same
    // `LABEL_WIDTH`. Asserted as absolute column positions rather than as a regex, so
    // a one-space drift in either module is a failure here.
    for (const line of card().filter((l) => l !== '' && !l.startsWith('▸'))) {
      expect(line.slice(0, 2), line).toBe('  ')
      expect(line[13], `${line} — the value column starts at 13`).not.toBe(' ')
      expect(line.slice(2, 13), line).toBe(line.slice(2, 13).trimEnd().padEnd(11))
    }
  })

  it('renders the same lines twice from the same snapshot, and from a fresh build', () => {
    const args = { metricsText: [event({ n: 29 }), event({ n: 34, verdict: 'fail' })].join('\n'), record: terminal(), queue: 2, now: NOW }
    const snapshot = buildPostMortem(args)
    expect(renderPostMortem(snapshot)).toEqual(renderPostMortem(snapshot))
    expect(renderPostMortem(snapshot)).toEqual(renderPostMortem(buildPostMortem(args)))
  })

  it('renders a hostile run id verbatim without breaking the heading into two lines', () => {
    // run-state.json is JSON somebody else wrote, and the id is copied into the
    // heading. A raw newline would split the card's first line in two.
    const hostile = 'run-\u001B[31mred\u001B[0m\tnot-a-heading'
    const lines = card({ record: terminal({ run_id: hostile }) })
    expect(lines.length).toBe(7)
    expect(lines[0]).toContain(hostile)
    expect(lines[0].includes('\n')).toBe(false)
  })
})

describe('renderPostMortem — the snapshot contract’s own edges (#59 QA)', () => {
  // The renderer is exported and documented as "a snapshot in, strings out", over a
  // snapshot whose every numeric field is "either `null` or FINITE". These two tests
  // hold it to exactly that contract — no narrower.
  const base = {
    runId: RUN_ID,
    interrupted: false,
    ok: 7,
    failed: 0,
    failedNumbers: [],
    spendUsd: 268.1,
    costPerTaskUsd: 29.8,
    wallMs: 9 * 3600000,
    finishedAt: RUN_FINISHED.getTime(),
    ageMs: 2 * 3600000,
    queue: 2,
  }

  it('formats a finite instant beyond the calendar as unknown, never as NaN:NaN', () => {
    // `Date` holds ±8.64e15 ms and no more. 8.7e15 is a FINITE number, so it passes
    // every guard the snapshot's contract states — and `new Date(8.7e15)` is an
    // Invalid Date, whose getHours() is NaN. progress.js range-checks exactly this
    // before formatting the document's instants (ISO_FLOOR_MS/ISO_CEIL_MS); the
    // card's own clock formatter does not, so the heading reads
    // `finished NaN:NaN` — a number the module promised to print as `unknown`.
    for (const finishedAt of [8.7e15, 1e300, -8.7e15, Number.MAX_VALUE]) {
      const lines = renderPostMortem({ ...base, finishedAt })
      expect(lines.join('\n'), `finishedAt = ${finishedAt}`).not.toContain('NaN')
    }
  })

  it('prints an absurd magnitude in exponent notation rather than refusing it', () => {
    // CHARACTERISATION. `toFixed` switches to exponent form at 1e21, and every one of
    // these came out of a `total_cost_usd` field in untrusted append-only text, so
    // `$1e+21 total` is reachable from a corrupt file. It is not a lie — the guard is
    // about finiteness and 1e21 is finite — but it is not a sum a reader can act on
    // either. Pinned rather than asserted against: if a magnitude ceiling is ever
    // added (the `unknown` a reader could at least act on), this is the test that
    // says which readings change.
    expect(renderPostMortem({ ...base, spendUsd: 1e21, costPerTaskUsd: 1e21 })[2]).toBe(
      '  spend      $1e+21 total · $1e+21/task avg',
    )
    expect(renderPostMortem({ ...base, queue: 1e21 })[4]).toBe('  queue      1e+21 waiting')
    expect(renderPostMortem({ ...base, ok: 1e21 })[1]).toBe('  outcome    1e+21 ok · 0 failed')
    // Whatever the magnitude, the card is still seven aligned lines: an absurd number
    // must not push the value column out from under the ones beside it.
    for (const snapshot of [{ ...base, spendUsd: 1e21 }, { ...base, queue: 1e21 }]) {
      const lines = renderPostMortem(snapshot)
      expect(lines.length).toBe(7)
      for (const line of lines.filter((l) => l.startsWith('  '))) {
        expect(line.slice(2, 13), line).toBe(line.slice(2, 13).trimEnd().padEnd(11))
      }
    }
  })
})
