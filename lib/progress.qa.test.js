import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildProgress, formatClock, formatElapsed, renderProgress } from './progress.js'

// QA augmentation for #57. The dev's progress.test.js locks the worked example,
// the three pace bases and the happy-path rendering. These tests attack the two
// promises the module makes about itself, from the hostile side:
//
//   1. THE UNKNOWN DISCIPLINE IS A HARD RULE, not a happy path. The reader is
//      deciding whether to go to sleep, so every line either states a number the
//      module can stand behind or says `unknown`. There is therefore a sweep at
//      the bottom of this file that runs a matrix of wrecked inputs through
//      buildProgress + renderProgress and greps the result for `NaN`,
//      `undefined`, `null`, `Infinity`, `$0.00`, exponent notation and a minus
//      sign in front of a digit — none of which may EVER reach the terminal.
//   2. A READ-ONLY VIEW NEVER THROWS. issues.jsonl is append-only untrusted text
//      that a killed run can leave half-written, and the record is JSON somebody
//      else wrote. So every table below feeds the shapes that file and that
//      record can actually take — truncated JSON, a JSON array, a scalar, CRLF,
//      `__proto__`, a 2 MiB line, an absent/empty/numeric run id — and asserts a
//      snapshot comes back rather than an exception.
//
// Plus the boundaries the arithmetic turns on: the pace window at 1/2/3/4/5
// in-run samples (asserted by VALUE, so an off-by-one that keeps the count right
// and drops the wrong sample is still caught), the floor-at-zero rule as the
// in-flight task overruns, and ETA monotonicity across a sweep of `now`.
//
// Hermetic by construction: the module is pure, so every input here is injected —
// `now` is an integer, the wall-clock fixtures are LOCAL Date constructors (the
// rendered `04:40` is local time, so a UTC ISO literal would make the suite
// timezone-dependent), and there is one test that stubs `Date.now` to throw to
// prove the module never reaches for the ambient clock at all.

const MIN = 60000
const RUN = 'ralph-ralph-b36ff7b1'
const OTHER_RUN = 'ralph-ralph-0badf00d'

const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime() // 40min into #031

// One recorded iteration, shaped like lib/issue-event.js builds them.
const event = ({ number = 1, run = RUN, minutes = null, cost = null, verdict = 'pass', ts = 1 } = {}) => ({
  issue_number: number,
  run_id: run,
  ts,
  duration_ms: minutes == null ? null : minutes * MIN,
  total_cost_usd: cost,
  verdict,
})

const tagged = (payload) => 'RALPH_ISSUE_EVENT ' + payload
const jsonl = (...events) => events.map((e) => tagged(JSON.stringify(e))).join('\n') + '\n'

// N in-run rows whose durations are the values given, in file order. No costs:
// the duration side is asserted on its own everywhere it is the subject.
const runOf = (...minutes) =>
  jsonl(...minutes.map((m, i) => event({ number: 20 + i, minutes: m, ts: i + 1 })))

// The issue's worked example — #029 97min/$34.10, #030 71min/$28.75 — used as the
// default fixture so every degradation below is asserted against a run that DOES
// have a pace and a spend to lose.
const WORKED = jsonl(
  event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
  event({ number: 30, minutes: 71, cost: 28.75, ts: 2 }),
)

const inFlightRecord = (overrides = {}) => ({
  run_id: RUN,
  queue_at_start: 8,
  current: { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 1 },
  ...overrides,
})

const build = (overrides = {}) =>
  buildProgress({
    metricsText: WORKED,
    record: inFlightRecord(),
    queue: 6,
    now: NOW,
    ...overrides,
  })

const render = (overrides = {}) => renderProgress(build(overrides)).join('\n')

describe('buildProgress — the pace window, asserted by VALUE (#57 QA)', () => {
  // The window is "the LAST three", so the test that matters is not the count but
  // WHICH three: every case below drops a distinctive oldest duration and asserts
  // it is absent from the mean AND from the min/max the ± is derived from.
  const windows = {
    'one in-run sample falls back to the all-time mean': {
      durations: [42],
      basis: 'all-time',
      samples: 1,
      paceMin: 42,
      minMax: [42, 42],
    },
    'two in-run samples are the in-run pace (the fallback boundary)': {
      durations: [97, 71],
      basis: 'last3-in-run',
      samples: 2,
      paceMin: 84,
      minMax: [71, 97],
    },
    'three in-run samples are all of them': {
      durations: [90, 60, 30],
      basis: 'last3-in-run',
      samples: 3,
      paceMin: 60,
      minMax: [30, 90],
    },
    'four in-run samples drop the OLDEST, not the newest': {
      durations: [120, 90, 60, 30],
      basis: 'last3-in-run',
      samples: 3,
      paceMin: 60, // mean(90, 60, 30) — the 120 is gone from the mean...
      minMax: [30, 90], // ...and from the range the ± is built on.
    },
    'five in-run samples keep only the last three': {
      durations: [600, 120, 90, 60, 30],
      basis: 'last3-in-run',
      samples: 3,
      paceMin: 60,
      minMax: [30, 90],
    },
  }

  for (const [label, { durations, basis, samples, paceMin, minMax }] of Object.entries(windows)) {
    it(label, () => {
      const snapshot = build({ metricsText: runOf(...durations) })
      expect(snapshot.paceBasis).toBe(basis)
      expect(snapshot.samples).toBe(samples)
      expect(snapshot.paceMs).toBe(paceMin * MIN)
      expect([snapshot.paceMinMs, snapshot.paceMaxMs]).toEqual([minMax[0] * MIN, minMax[1] * MIN])
    })
  }

  it('reaches PAST unusable rows for the third sample rather than shrinking the window', () => {
    // The window counts measurements, not lines: a Codex row records no duration,
    // and treating it as a sample would be averaging in a zero.
    const snapshot = build({
      metricsText: jsonl(
        event({ number: 26, minutes: 30, ts: 1 }),
        event({ number: 27, minutes: 60, ts: 2 }),
        event({ number: 28, minutes: null, ts: 3 }),
        event({ number: 29, minutes: 90, ts: 4 }),
      ),
    })
    expect(snapshot.samples).toBe(3)
    expect(snapshot.paceMs).toBe(60 * MIN) // mean(30, 60, 90)
    expect(snapshot.completed).toBe(4) // ...but all four rows are completed tasks
  })

  it('averages the WHOLE history on the all-time fallback, not its last three', () => {
    // The all-time mean is a different statistic from the in-run one: it is the
    // lifetime average, so a 10-run history contributes all ten rows.
    const metricsText = jsonl(
      ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((m, i) =>
        event({ number: 100 + i, run: OTHER_RUN, minutes: m, ts: i + 1 }),
      ),
    )
    const snapshot = build({ metricsText })
    expect(snapshot.paceBasis).toBe('all-time')
    expect(snapshot.samples).toBe(10)
    expect(snapshot.paceMs).toBe(55 * MIN) // mean(10..100), not mean(80, 90, 100)
    expect(snapshot.paceMinMs).toBe(10 * MIN)
    expect(snapshot.paceMaxMs).toBe(100 * MIN)
  })

  it('is unknown — never a zero — with no usable duration anywhere', () => {
    const snapshot = build({ metricsText: jsonl(event({ number: 29, run: OTHER_RUN, minutes: 0 })) })
    expect(snapshot.paceBasis).toBe('unknown')
    expect([snapshot.paceMs, snapshot.paceMinMs, snapshot.paceMaxMs]).toEqual([null, null, null])
    expect(snapshot.samples).toBe(0)
    expect([snapshot.etaMs, snapshot.finishAt, snapshot.spreadMs]).toEqual([null, null, null])
  })
})

describe('buildProgress — a duration that is not a measurement (#57 QA)', () => {
  // Every shape issues.jsonl can carry in `duration_ms` that is NOT a positive
  // finite number of milliseconds. Each must be ignored as a sample — never
  // coerced, never averaged in as a zero, never turned into NaN.
  const shapes = {
    zero: '0',
    negative: '-1000',
    null: 'null',
    'a string of digits': '"97000"',
    'a string that is not a number': '"nope"',
    'the string NaN': '"NaN"',
    'a JSON overflow that parses to Infinity': '1e400',
    'a JSON underflow that parses to 0': '1e-400',
    true: 'true',
    false: 'false',
    'an object': '{}',
    'an array': '[]',
  }

  for (const [label, raw] of Object.entries(shapes)) {
    it(`ignores ${label} as a pace sample`, () => {
      const metricsText = [
        tagged(`{"issue_number":28,"run_id":"${RUN}","ts":1,"duration_ms":${raw}}`),
        tagged(JSON.stringify(event({ number: 29, minutes: 84, ts: 2 }))),
      ].join('\n')
      const snapshot = build({ metricsText })
      // One usable sample in the run → the all-time fallback over that same row.
      expect(snapshot.samples).toBe(1)
      expect(snapshot.paceMs).toBe(84 * MIN)
      expect(Number.isFinite(snapshot.etaMs)).toBe(true)
      expect(snapshot.completed).toBe(2)
    })
  }

  it('leaves the field absent entirely as unusable too', () => {
    const snapshot = build({
      metricsText: [
        tagged(`{"issue_number":28,"run_id":"${RUN}","ts":1}`),
        tagged(`{"issue_number":29,"run_id":"${RUN}","ts":2}`),
      ].join('\n'),
    })
    expect(snapshot.paceBasis).toBe('unknown')
    expect(snapshot.paceMs).toBe(null)
    expect(snapshot.completed).toBe(2)
  })
})

describe('buildProgress — a cost that is not a spend (#57 QA)', () => {
  const shapes = {
    zero: '0',
    negative: '-12.5',
    null: 'null',
    'a string of digits': '"34.10"',
    'a JSON overflow that parses to Infinity': '1e400',
    true: 'true',
    'an object': '{}',
  }

  for (const [label, raw] of Object.entries(shapes)) {
    it(`reports an unknown spend — never $0.00 — for ${label}`, () => {
      const metricsText = [
        tagged(
          `{"issue_number":28,"run_id":"${RUN}","ts":1,"duration_ms":${84 * MIN},"total_cost_usd":${raw}}`,
        ),
        tagged(
          `{"issue_number":29,"run_id":"${RUN}","ts":2,"duration_ms":${84 * MIN},"total_cost_usd":null}`,
        ),
      ].join('\n')
      const snapshot = build({ metricsText })
      expect(snapshot.spendUsd).toBe(null)
      expect(snapshot.costPerTaskUsd).toBe(null)
      expect(snapshot.projectedUsd).toBe(null)
      const lines = renderProgress(snapshot)
      expect(lines[2]).toBe('  spend      unknown')
      expect(lines.join('\n')).not.toContain('$0.00')
      // The duration side is a separate measurement and must survive.
      expect(snapshot.paceMs).toBe(84 * MIN)
    })
  }

  it('absent total_cost_usd is unknown, and the pace line simply drops the rate', () => {
    const snapshot = build({
      metricsText: [
        tagged(`{"issue_number":28,"run_id":"${RUN}","ts":1,"duration_ms":${84 * MIN}}`),
        tagged(`{"issue_number":29,"run_id":"${RUN}","ts":2,"duration_ms":${84 * MIN}}`),
      ].join('\n'),
    })
    expect(renderProgress(snapshot)[0]).toBe('  pace       ~84 min/task')
    expect(renderProgress(snapshot)[0]).not.toContain('/task · $')
  })

  it('spells a sub-cent spend the same way in both halves of the line', () => {
    // The two halves are the SAME number here — an empty queue extrapolates
    // nothing, so the projection is the recorded spend — and a spend of 0.7¢ is the
    // magnitude where each half is tempted into a different precision: cents round
    // it to `$0.01` while more decimals print `$0.007`, and a line reading
    // `$0.01 so far · ~$0.007 projected` claims a projection below money that is
    // already gone. Neither half may read as free either: `$0.00` is the invented
    // zero this module refuses everywhere.
    const snapshot = build({
      metricsText: jsonl(
        event({ number: 29, minutes: 97, cost: 0.004, ts: 1 }),
        event({ number: 30, minutes: 71, cost: 0.003, ts: 2 }),
      ),
      queue: 0,
    })
    expect(snapshot.spendUsd).toBeCloseTo(0.007, 6)
    expect(snapshot.projectedUsd).toBe(snapshot.spendUsd)

    // Whatever spelling the module picks, both halves must pick the same one — the
    // money TOKEN out of each segment, compared, rather than a literal pinned here.
    const spendLine = renderProgress(snapshot)[2]
    const [soFar, projected] = spendLine.split(' · ')
    const money = (segment) => segment.match(/[<~]*\$[\d.]+/)[0].replace('~', '')
    expect(money(soFar), spendLine).toBe(money(projected))
    expect(money(soFar), spendLine).not.toBe('$0.00')
    expect(spendLine).not.toContain('$0.00')
  })
})

describe('buildProgress — the live queue depth, hostile (#57 QA)', () => {
  const queues = {
    'a real empty queue': { queue: 0, remaining: 0, total: 3 },
    'a failed count (null)': { queue: null, remaining: null, total: null },
    'a negative count clamps to zero rather than shortening the ETA': {
      queue: -5,
      remaining: 0,
      total: 3,
    },
    'NaN is unknown, not zero': { queue: NaN, remaining: null, total: null },
    'Infinity is unknown, not a number': { queue: Infinity, remaining: null, total: null },
    'a numeric string is unknown (the shell coerces; the policy does not)': {
      queue: '6',
      remaining: null,
      total: null,
    },
    'undefined is unknown': { queue: undefined, remaining: null, total: null },
    'an object is unknown': { queue: { count: 6 }, remaining: null, total: null },
  }

  for (const [label, { queue, remaining, total }] of Object.entries(queues)) {
    it(`treats ${label}`, () => {
      const snapshot = build({ queue })
      expect(snapshot.remaining).toBe(remaining)
      expect(snapshot.total).toBe(total)
      if (remaining == null) {
        // Unknown depth => no ETA and no projection, but the pace and the
        // recorded spend are still counted facts.
        expect(snapshot.etaMs).toBe(null)
        expect(snapshot.projectedUsd).toBe(null)
        expect(snapshot.paceMs).toBe(84 * MIN)
      } else {
        expect(snapshot.etaMs).toBeGreaterThanOrEqual(0)
      }
      expect(renderProgress(snapshot).join('\n')).not.toMatch(/-\d|NaN|undefined|Infinity/)
    })
  }

  it('never lets a negative queue push the ETA below the in-flight remainder', () => {
    // -5 waiting is nonsense a corrupt count could produce; it must read as an
    // empty queue, i.e. the same ETA as `queue: 0`, never a negative one.
    expect(build({ queue: -5 }).etaMs).toBe(build({ queue: 0 }).etaMs)
    expect(build({ queue: -5 }).etaMs).toBe(44 * MIN)
  })

  it('carries a non-integer depth through without rounding it into a wrong ETA', () => {
    const snapshot = build({ queue: 2.5 })
    expect(snapshot.remaining).toBe(2.5)
    expect(snapshot.etaMs).toBe(44 * MIN + 2.5 * 84 * MIN)
    expect(renderProgress(snapshot).join('\n')).not.toMatch(/NaN|Infinity/)
  })
})

describe('buildProgress — a wrecked run record still yields a snapshot (#57 QA)', () => {
  const records = {
    'no record at all': null,
    'undefined': undefined,
    'an empty object': {},
    'an array': [],
    'a record with no run id': { current: null },
    'a run id that is the empty string': { run_id: '', current: null },
    'a run id that is null': { run_id: null, current: null },
    'nothing in flight': inFlightRecord({ current: null }),
    'current as an empty object': inFlightRecord({ current: {} }),
    'current as a string': inFlightRecord({ current: 'issue 31' }),
    'current as an array': inFlightRecord({ current: [31] }),
    'current with no started_at': inFlightRecord({ current: { number: 31 } }),
    'current with an unparseable started_at': inFlightRecord({
      current: { number: 31, started_at: 'yesterday' },
    }),
    'current with a null started_at': inFlightRecord({
      current: { number: 31, started_at: null },
    }),
    'current with a started_at in the future (clock skew)': inFlightRecord({
      current: { number: 31, started_at: new Date(NOW + 3 * 60 * MIN).toISOString() },
    }),
  }

  for (const [label, record] of Object.entries(records)) {
    it(`builds and renders for ${label}`, () => {
      let snapshot
      expect(() => {
        snapshot = buildProgress({ metricsText: runOf(97, 71), record, queue: 6, now: NOW })
      }).not.toThrow()
      // Whatever the record says, the derived numbers stay inside their contract.
      expect(snapshot.inFlight === 0 || snapshot.inFlight === 1).toBe(true)
      expect(snapshot.etaMs).toBeGreaterThanOrEqual(0)
      expect(snapshot.completed).toBeGreaterThanOrEqual(0)
      expect(['last3-in-run', 'all-time', 'unknown']).toContain(snapshot.paceBasis)
      expect(renderProgress(snapshot).join('\n')).not.toMatch(
        /NaN|undefined|Infinity|null|\$0\.00|-\d/,
      )
    })
  }

  it('owes a task with an unusable start a FULL estimate, never a negative one', () => {
    // The task IS in flight, so the ETA still owes it the whole pace; the
    // alternative (NaN, or a negative remainder) would be an invented number.
    // `0` is deliberately NOT in this list: a numeric started_at reads as an
    // instant long past, so spending the whole in-flight allowance is right.
    for (const started_at of [undefined, null, 'yesterday', '', new Date(NOW + 60 * MIN).toISOString()]) {
      const snapshot = build({ record: inFlightRecord({ current: { number: 31, started_at } }) })
      expect(snapshot.inFlight, String(started_at)).toBe(1)
      expect(snapshot.etaMs, String(started_at)).toBe(7 * 84 * MIN)
    }
  })

  it('never claims another run’s work when the record cannot name its own run', () => {
    for (const run_id of [undefined, null, '']) {
      const snapshot = build({ record: inFlightRecord({ run_id }) })
      expect(snapshot.completed, String(run_id)).toBe(0)
      expect(snapshot.spendUsd, String(run_id)).toBe(null)
    }
  })
})

describe('buildProgress — run scoping is EXACT, not fuzzy (#57 QA)', () => {
  // issues.jsonl accumulates forever, and run ids share a prefix by construction
  // (`ralph-<repo>-<hash>`). A substring match would silently fold a neighbouring
  // run's tasks into this run's pace, spend and completed count.
  // An absent key is not the same input as an explicit null — `event({ run:
  // undefined })` would silently take the fixture's default — so the rows here are
  // built field by field, with ABSENT meaning "the loop wrote no run_id at all".
  const ABSENT = Symbol('no run_id key')
  const rowWith = (run, number, ts) => {
    const row = { issue_number: number, ts, duration_ms: 10 * MIN, total_cost_usd: 500, verdict: 'pass' }
    return run === ABSENT ? row : { ...row, run_id: run }
  }

  const nonMatches = {
    'a longer id with this one as a prefix': `${RUN}-2`,
    'a longer id with this one as a suffix': `old-${RUN}`,
    'this id with a trailing space': `${RUN} `,
    'this id in a different case': RUN.toUpperCase(),
    'the repo-and-hash-less stem': 'ralph',
    'an absent run id on the row': ABSENT,
    'a null run id on the row': null,
    'a numeric run id where the record has a string': 42,
  }

  for (const [label, run] of Object.entries(nonMatches)) {
    it(`does not count a row whose run id is ${label}`, () => {
      const snapshot = build({
        metricsText: jsonl(rowWith(run, 90, 1), rowWith(run, 91, 2)),
      })
      expect(snapshot.completed).toBe(0)
      expect(snapshot.spendUsd).toBe(null)
      // Those rows are still HISTORY, so the all-time fallback may use them —
      // what must not happen is them counting as this run's own tasks.
      expect(snapshot.paceBasis).toBe('all-time')
    })
  }

  it('matches a numeric run id in the record against the string in the row', () => {
    // run-state.json is JSON somebody else wrote; a run id that came back as a
    // number must still find its own rows rather than silently scoping to nothing.
    const snapshot = buildProgress({
      metricsText: jsonl(
        event({ number: 29, run: '20260826', minutes: 97, cost: 34.1, ts: 1 }),
        event({ number: 30, run: '20260826', minutes: 71, cost: 28.75, ts: 2 }),
      ),
      record: inFlightRecord({ run_id: 20260826 }),
      queue: 6,
      now: NOW,
    })
    expect(snapshot.completed).toBe(2)
    expect(snapshot.paceBasis).toBe('last3-in-run')
    expect(snapshot.spendUsd).toBeCloseTo(62.85, 5)
  })

  it('keeps a neighbouring run’s spend out of this run’s total AND rate', () => {
    const snapshot = build({
      metricsText: jsonl(
        event({ number: 90, run: OTHER_RUN, minutes: 10, cost: 500, ts: 1 }),
        event({ number: 29, minutes: 97, cost: 34.1, ts: 2 }),
        event({ number: 30, minutes: 71, cost: 28.75, ts: 3 }),
      ),
    })
    expect(snapshot.spendUsd).toBeCloseTo(62.85, 5)
    expect(snapshot.costPerTaskUsd).toBeCloseTo(31.425, 5)
    expect(renderProgress(snapshot)[2]).not.toContain('562')
  })
})

describe('buildProgress — malformed JSONL never throws (#57 QA)', () => {
  // Every shape a real .ralph/metrics/issues.jsonl can take. The two good rows are
  // appended after the junk in each case, so the assertion is not just "no throw"
  // but "the junk did not swallow the data behind it".
  const junk = {
    'a blank file': '',
    'blank lines': '\n\n\n',
    'whitespace-only lines': '   \n\t\n \r\n',
    'untagged stdout from the loop': 'npm WARN deprecated foo@1.0.0\n==> Iteration for issue #29',
    'the tag with nothing after it': 'RALPH_ISSUE_EVENT ',
    'the tag with only whitespace after it': 'RALPH_ISSUE_EVENT    ',
    'JSON truncated mid-write (a run killed mid-append)': `RALPH_ISSUE_EVENT {"issue_number":31,"run_id":"${RUN}"`,
    'a JSON array': 'RALPH_ISSUE_EVENT [{"duration_ms":999999999}]',
    'a JSON number': 'RALPH_ISSUE_EVENT 3',
    'a JSON string': 'RALPH_ISSUE_EVENT "x"',
    'JSON null': 'RALPH_ISSUE_EVENT null',
    'JSON true': 'RALPH_ISSUE_EVENT true',
    'a trailing comma': `RALPH_ISSUE_EVENT {"run_id":"${RUN}","duration_ms":1,}`,
    'a bare NaN literal JSON rejects': `RALPH_ISSUE_EVENT {"run_id":"${RUN}","duration_ms":NaN}`,
    'the tag twice on one line': `RALPH_ISSUE_EVENT RALPH_ISSUE_EVENT {"run_id":"${RUN}","duration_ms":999999999}`,
    'the tag separated by a tab instead of a space': `RALPH_ISSUE_EVENT\t{"run_id":"${RUN}","duration_ms":999999999}`,
    'a 2 MiB single line': `RALPH_ISSUE_EVENT {"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`,
    'a NUL byte in the payload': 'RALPH_ISSUE_EVENT {"note":"a\\u0000b"}',
    'a lone surrogate escape': 'RALPH_ISSUE_EVENT {"note":"\\ud800"}',
  }

  for (const [label, prefix] of Object.entries(junk)) {
    it(`skips ${label} and still reads the rows behind it`, () => {
      const metricsText = prefix + '\n' + runOf(97, 71)
      let snapshot
      expect(() => {
        snapshot = build({ metricsText })
      }).not.toThrow()
      expect(snapshot.completed).toBe(2)
      expect(snapshot.paceMs).toBe(84 * MIN)
      expect(snapshot.paceBasis).toBe('last3-in-run')
    })
  }

  it('reads rows written with CRLF line endings and with no trailing newline', () => {
    const rows = [
      tagged(JSON.stringify(event({ number: 29, minutes: 97, ts: 1 }))),
      tagged(JSON.stringify(event({ number: 30, minutes: 71, ts: 2 }))),
    ]
    for (const [label, text] of [
      ['CRLF', rows.join('\r\n') + '\r\n'],
      ['no trailing newline', rows.join('\n')],
      ['a trailing blank line', rows.join('\n') + '\n\n'],
    ]) {
      const snapshot = build({ metricsText: text })
      expect(snapshot.completed, label).toBe(2)
      expect(snapshot.paceMs, label).toBe(84 * MIN)
    }
  })

  it('reads the row when the tag appears mid-line behind other output', () => {
    // The loop tees the agent's stdout, so a tagged line can arrive with a prefix.
    const snapshot = build({
      metricsText: '2026-08-25 19:00:00 ' + runOf(97, 71),
    })
    expect(snapshot.completed).toBe(2)
  })

  it('does not let __proto__ in a payload pollute Object.prototype', () => {
    const before = Object.prototype.duration_ms
    const snapshot = build({
      metricsText:
        `RALPH_ISSUE_EVENT {"__proto__":{"duration_ms":999999999,"run_id":"${RUN}","total_cost_usd":999}}\n` +
        runOf(97, 71),
    })
    expect(Object.prototype.duration_ms).toBe(before)
    expect({}.duration_ms).toBe(undefined)
    // ...and the poisoned row contributed nothing of its own.
    expect(snapshot.paceMs).toBe(84 * MIN)
    expect(snapshot.spendUsd).toBe(null)
  })

  it('accepts a metricsText that is not a string without throwing', () => {
    // safeReadText in status.js normalizes, but the pure module is exported and
    // must not assume a caller did.
    for (const metricsText of [undefined, null, 0, 42, false, {}, [], () => {}]) {
      let snapshot
      expect(() => {
        snapshot = build({ metricsText })
      }, String(metricsText)).not.toThrow()
      expect(snapshot.completed, String(metricsText)).toBe(0)
      expect(snapshot.paceBasis, String(metricsText)).toBe('unknown')
    }
  })

  it('reads a Buffer of jsonl text the way the shell’s readFile can hand it over', () => {
    const snapshot = build({ metricsText: Buffer.from(runOf(97, 71)) })
    expect(snapshot.completed).toBe(2)
    expect(snapshot.paceMs).toBe(84 * MIN)
  })
})

describe('buildProgress — the in-flight floor and ETA direction (#57 QA)', () => {
  const at = (minutesIn) => build({ now: TASK_STARTED.getTime() + minutesIn * MIN })

  it('is exactly remaining × pace at the instant the in-flight task hits the pace', () => {
    // The boundary of the floor: elapsed === pace leaves nothing owed to the task
    // in flight, and one millisecond either side must not change the sign.
    expect(at(84).etaMs).toBe(6 * 84 * MIN)
    expect(build({ now: TASK_STARTED.getTime() + 84 * MIN - 1 }).etaMs).toBe(6 * 84 * MIN + 1)
    expect(build({ now: TASK_STARTED.getTime() + 84 * MIN + 1 }).etaMs).toBe(6 * 84 * MIN)
  })

  it('floors at zero when the task has vastly overrun the pace', () => {
    for (const minutesIn of [85, 200, 5000, 100000]) {
      expect(at(minutesIn).etaMs, `${minutesIn}min in`).toBe(6 * 84 * MIN)
    }
  })

  it('never counts backwards as the in-flight task runs on', () => {
    // The one direction an ETA may never move. Swept minute by minute across the
    // floor, because that is where a sign error would show up.
    let previous = Infinity
    for (let minutesIn = 0; minutesIn <= 300; minutesIn += 1) {
      const snapshot = at(minutesIn)
      expect(snapshot.etaMs, `${minutesIn}min in`).toBeLessThanOrEqual(previous)
      expect(snapshot.etaMs, `${minutesIn}min in`).toBeGreaterThanOrEqual(0)
      previous = snapshot.etaMs
    }
  })

  it('never moves the wall-clock finish EARLIER as time passes', () => {
    // now + eta: while the in-flight estimate is being spent the finish line holds
    // still, and once floored it slides later. It must never slide earlier.
    let previous = -Infinity
    for (let minutesIn = 0; minutesIn <= 300; minutesIn += 5) {
      const { finishAt } = at(minutesIn)
      expect(finishAt, `${minutesIn}min in`).toBeGreaterThanOrEqual(previous)
      previous = finishAt
    }
  })

  it('treats a `now` before the task started as no elapsed time, not negative', () => {
    const snapshot = build({ now: TASK_STARTED.getTime() - 90 * MIN })
    expect(snapshot.etaMs).toBe(7 * 84 * MIN)
    expect(renderProgress(snapshot).join('\n')).not.toMatch(/-\d/)
  })

  it('keeps the ETA but not the finish time when `now` is unusable', () => {
    for (const now of [null, undefined, NaN, Infinity, '1787700000000', new Date(NOW)]) {
      const snapshot = build({ now })
      expect(snapshot.finishAt, String(now)).toBe(null)
      expect(renderProgress(snapshot).join('\n'), String(now)).not.toMatch(
        /NaN|undefined|Infinity|\$0\.00/,
      )
    }
  })
})

describe('renderProgress — the ± only when there is an observed spread (#57 QA)', () => {
  it('omits the ± for two samples that agree, not just for one sample', () => {
    // Two identical durations are two samples with a zero range: `(±0min)` would
    // be a claim of certainty, and the dev's rule is to print nothing.
    const line = renderProgress(build({ metricsText: runOf(84, 84) }))[1]
    expect(line).toBe('  eta        ~9h08m left → ~04:40')
    expect(line).not.toContain('±')
  })

  it('renders a ± as soon as the samples disagree', () => {
    const line = renderProgress(build({ metricsText: runOf(97, 71) }))[1]
    expect(line).toContain('(±1h30m)')
  })

  it('renders no ± for a single all-time sample', () => {
    const line = renderProgress(build({ metricsText: runOf(84) }))[1]
    expect(line).not.toContain('±')
    expect(line).toContain('left → ~')
  })

  it('renders no ± when the spread is smaller than the grid it is rounded to', () => {
    // Sub-grid noise rounds to zero and is then dropped entirely, rather than
    // printing `(±0min)`.
    const line = renderProgress(build({ metricsText: runOf(84, 84.5), queue: 0 }))[1]
    expect(line).not.toContain('±')
  })

  it('is unknown, with no ± and no clock, when the queue depth is unknown', () => {
    expect(renderProgress(build({ queue: null }))[1]).toBe('  eta        unknown')
  })

  it('survives a snapshot it did not build', () => {
    // renderProgress is exported on its own; a caller handing it nothing at all
    // must get the three unknown lines rather than an exception.
    for (const snapshot of [undefined, null, {}]) {
      expect(renderProgress(snapshot), String(snapshot)).toEqual([
        '  pace       unknown',
        '  eta        unknown',
        '  spend      unknown',
      ])
    }
  })
})

describe('renderProgress — the wall-clock finish across day boundaries (#57 QA)', () => {
  // Timezone-independent by construction: `now` is built with a LOCAL Date
  // constructor and the expected clock is read back off a LOCAL Date, so the
  // assertion holds in any zone. What is pinned is the arithmetic (finishAt) and
  // that the reading is local wall clock, not UTC.
  const clockOf = (ms) => {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  it('crosses midnight into tomorrow’s clock', () => {
    const lateNight = new Date(2026, 7, 25, 23, 40, 0).getTime()
    const snapshot = buildProgress({
      metricsText: runOf(50, 50),
      record: inFlightRecord({ current: null }),
      queue: 1,
      now: lateNight,
    })
    expect(snapshot.etaMs).toBe(50 * MIN)
    expect(snapshot.finishAt).toBe(lateNight + 50 * MIN)
    expect(renderProgress(snapshot)[1]).toBe(`  eta        ~50min left → ~${clockOf(lateNight + 50 * MIN)}`)
    expect(clockOf(lateNight + 50 * MIN)).toMatch(/^00:3\d$/)
  })

  it('crosses MULTIPLE days as hours-left, never a wrapped or negative figure', () => {
    // A 5-deep queue at a 10-hour pace: two days out. `50h00m` is the honest
    // reading; a modulo-24 bug would print `2h00m` and a sign error a negative.
    const snapshot = buildProgress({
      metricsText: runOf(600, 600),
      record: inFlightRecord({ current: null }),
      queue: 5,
      now: NOW,
    })
    expect(snapshot.etaMs).toBe(3000 * MIN)
    expect(snapshot.finishAt).toBe(NOW + 3000 * MIN)
    const line = renderProgress(snapshot)[1]
    expect(line).toBe(`  eta        ~50h00m left → ~${clockOf(NOW + 3000 * MIN)}`)
    expect(line).not.toMatch(/-\d|NaN|Infinity/)
    expect(formatElapsed(snapshot.etaMs)).toBe('50h00m')
  })

  it('renders a finish time on the same clock reading as a plain formatClock', () => {
    // The ETA line's clock is formatClock(finishAt) and nothing else — no second,
    // divergent formatter for the same instant.
    const snapshot = build()
    expect(renderProgress(snapshot)[1]).toContain(`→ ~${formatClock(snapshot.finishAt)}`)
  })
})

describe('buildProgress / renderProgress — the unknown discipline as a hard rule (#57 QA)', () => {
  // The sweep: every hostile-but-reachable input, through the whole pipeline, with
  // the rendered text grepped for the tokens that mean "we made a number up".
  const FORBIDDEN = [
    [/NaN/, 'NaN'],
    [/undefined/, 'undefined'],
    [/\bnull\b/, 'null'],
    [/Infinity/, 'Infinity'],
    [/\$0\.00/, '$0.00'],
    [/-\d/, 'a minus sign in front of a digit'],
    [/e[+-]\d/, 'exponent notation'],
  ]

  const cases = {
    'no usable input at all': { metricsText: null, record: null, queue: null, now: null },
    'an empty metrics file': { metricsText: '' },
    'a metrics file of pure junk': { metricsText: 'RALPH_ISSUE_EVENT {\n\n???\n' },
    'no record': { record: null },
    'an empty record': { record: {} },
    'no run id': { record: inFlightRecord({ run_id: null }) },
    'an empty run id': { record: inFlightRecord({ run_id: '' }) },
    'nothing in flight': { record: inFlightRecord({ current: null }) },
    'a broken in-flight start': { record: inFlightRecord({ current: { number: 31 } }) },
    'a future in-flight start': {
      record: inFlightRecord({
        current: { number: 31, started_at: new Date(NOW + 600 * MIN).toISOString() },
      }),
    },
    'a failed queue count': { queue: null },
    'a negative queue count': { queue: -3 },
    'an empty queue': { queue: 0 },
    'a non-integer queue count': { queue: 3.5 },
    'a five-figure queue': { queue: 20000 },
    'no now': { now: null },
    'a NaN now': { now: NaN },
    'a now before the run started': { now: TASK_STARTED.getTime() - 1000 * MIN },
    'zero durations and zero costs': {
      metricsText: jsonl(
        event({ number: 29, minutes: 0, cost: 0, ts: 1 }),
        event({ number: 30, minutes: 0, cost: 0, ts: 2 }),
      ),
    },
    'costs recorded on only one of two tasks': {
      metricsText: jsonl(
        event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
        event({ number: 30, minutes: 71, cost: null, ts: 2 }),
      ),
    },
    'a sub-cent recorded cost': {
      metricsText: jsonl(
        event({ number: 29, minutes: 97, cost: 0.004, ts: 1 }),
        event({ number: 30, minutes: 71, cost: 0.004, ts: 2 }),
      ),
    },
    'a history from other runs only': {
      metricsText: jsonl(
        event({ number: 90, run: OTHER_RUN, minutes: 40, cost: 1, ts: 1 }),
        event({ number: 91, run: OTHER_RUN, minutes: 80, cost: 1, ts: 2 }),
      ),
    },
    'one task, one cent, one waiting': {
      metricsText: jsonl(event({ number: 29, minutes: 1, cost: 0.01, ts: 1 })),
      queue: 1,
    },
  }

  for (const [label, overrides] of Object.entries(cases)) {
    it(`prints no invented number for ${label}`, () => {
      const text = render(overrides)
      for (const [pattern, name] of FORBIDDEN) {
        expect(text, `${label} → ${name} in:\n${text}`).not.toMatch(pattern)
      }
      // Three lines, always, in the live view's label column.
      const lines = renderProgress(build(overrides))
      expect(lines.length).toBe(3)
      expect(lines.map((l) => l.slice(2).split(' ')[0])).toEqual(['pace', 'eta', 'spend'])
    })
  }

  it('never renders a non-finite derived number, whatever the file’s magnitudes', () => {
    // The guards are per-INPUT (finiteOrNull on each field), so a magnitude that
    // is finite on its own but overflows the sum or the product escapes them. A
    // corrupt issues.jsonl line is untrusted text, so this is reachable.
    const overflows = {
      'two costs that overflow their sum': {
        metricsText: [
          tagged(`{"run_id":"${RUN}","ts":1,"duration_ms":${97 * MIN},"total_cost_usd":1e308}`),
          tagged(`{"run_id":"${RUN}","ts":2,"duration_ms":${71 * MIN},"total_cost_usd":1e308}`),
        ].join('\n'),
      },
      'a duration whose product with the queue overflows': {
        metricsText: [
          tagged(`{"run_id":"${RUN}","ts":1,"duration_ms":1e308}`),
          tagged(`{"run_id":"${RUN}","ts":2,"duration_ms":1e308}`),
        ].join('\n'),
      },
      'a queue depth at the top of the number range': { queue: Number.MAX_VALUE },
    }

    for (const [label, overrides] of Object.entries(overflows)) {
      const snapshot = build(overrides)
      for (const field of [
        'paceMs',
        'paceMinMs',
        'paceMaxMs',
        'etaMs',
        'finishAt',
        'spreadMs',
        'spendUsd',
        'costPerTaskUsd',
        'projectedUsd',
        'total',
      ]) {
        const value = snapshot[field]
        expect(
          value == null || Number.isFinite(value),
          `${label} → snapshot.${field} = ${value}`,
        ).toBe(true)
      }
      expect(render(overrides), label).not.toMatch(/NaN|Infinity/)
    }
  })
})

describe('progress.js — PURE, with no exceptions (#57 QA)', () => {
  const SOURCE = readFileSync(new URL('./progress.js', import.meta.url), 'utf8')
  // The module's own prose names `Date.now` and `fs` to promise it does not use
  // them, so the assertions below run against the source with comments stripped —
  // otherwise the promise would fail the test that checks the promise.
  const CODE = SOURCE.split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line.replace(/\s\/\/.*$/, '')))
    .join('\n')

  it('imports nothing at all', () => {
    // No fs, no path, no execa, no sibling module: the pure module has no edges.
    expect(CODE).not.toMatch(/^\s*import\s/m)
    expect(CODE).not.toMatch(/require\(/)
    expect(CODE).not.toMatch(/from ['"]node:/)
  })

  it('reaches for no clock, no filesystem, no network and no process', () => {
    for (const forbidden of [
      /Date\.now/,
      /performance\.now/,
      /\bfs\./,
      /readFileSync|writeFileSync|appendFileSync|existsSync/,
      /\bfetch\(/,
      /process\./,
      // `exec(` only as a CALL of its own, not as a method on something: the point
      // is that this module cannot run a subprocess, and `RE.exec(text)` is a regex
      // match. Left coarse, it banned a spelling rather than a capability and cost
      // shipped code a comment apologising for the workaround.
      /execa|spawn|(?<![.\w])exec\(/,
      /\bnew Date\(\s*\)/, // `new Date(ms)` is a formatter; `new Date()` is a clock
      /Math\.random/,
    ]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('still works with Date.now stubbed to throw', () => {
    // Belt to the source-text braces: if anything reached the ambient clock at
    // runtime, this would surface it as the thrown error rather than a diff.
    const real = Date.now
    try {
      Date.now = () => {
        throw new Error('progress.js reached for the ambient clock')
      }
      const snapshot = build()
      expect(snapshot.etaMs).toBe(548 * MIN)
      expect(renderProgress(snapshot)[1]).toBe('  eta        ~9h08m left → ~04:40  (±1h30m)')
    } finally {
      Date.now = real
    }
  })

  it('is deterministic: same inputs, same snapshot, same lines', () => {
    const args = { metricsText: runOf(97, 71), record: inFlightRecord(), queue: 6, now: NOW }
    expect(buildProgress(args)).toEqual(buildProgress(args))
    expect(renderProgress(buildProgress(args))).toEqual(renderProgress(buildProgress(args)))
  })

  it('mutates none of its inputs', () => {
    const record = inFlightRecord()
    const metricsText = runOf(97, 71)
    const before = JSON.stringify(record)
    buildProgress({ metricsText, record, queue: 6, now: NOW })
    expect(JSON.stringify(record)).toBe(before)
    expect(metricsText).toBe(runOf(97, 71))
  })

  it('accepts a frozen record — a status view owns none of what it reads', () => {
    const record = Object.freeze({
      ...inFlightRecord(),
      current: Object.freeze({ number: 31, started_at: TASK_STARTED.toISOString() }),
    })
    expect(() => buildProgress({ metricsText: runOf(97, 71), record, queue: 6, now: NOW })).not.toThrow()
  })
})
