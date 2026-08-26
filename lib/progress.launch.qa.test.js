import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildLaunchProjection,
  buildProgress,
  formatClock,
  renderLaunchProjection,
} from './progress.js'

// QA augmentation for #60 — the LAUNCH projection surface. The dev's
// progress.test.js pins the worked example, the costless history, the unknown
// queue, one overflow and the sub-dollar decimal. This file attacks the two
// promises the module makes about itself, on the new surface, from the hostile
// side:
//
//   1. THE UNKNOWN DISCIPLINE, restated for a projection: every numeric field is
//      either `null` or finite, and NO ZERO EVER STANDS IN FOR ABSENT DATA. The
//      reader of this block is deciding whether to walk away from the machine, so
//      `~0 min/task · ~$0.0/task` is worse than silence — it reads as "free and
//      instant" rather than "never measured". There is therefore a field sweep
//      and a rendered-token sweep at the bottom of this file, run over a matrix of
//      wrecked histories and absurd queue depths.
//   2. A LAUNCH IS NEVER BLOCKED BY A HINT. issues.jsonl is untrusted append-only
//      text that a killed run leaves half-written, so every shape that file can
//      actually take — a truncated LAST line, an untagged line, a JSON array, a
//      scalar, a duplicated tag, a 2 MiB line, CRLF, `__proto__` — has to come
//      back as a projection rather than an exception.
//
// Plus the property that makes the BORROW safe (#60 borrows the duration half from
// `buildProgress` by calling it with no `record`): handed no record, the pace basis
// is all-time and `etaMs` carries no in-flight term, so `totalMs` is exactly
// `queue × paceMs`. That is asserted here by value and swept in the field matrix
// (`basis` may never be `last3-in-run`), so a future edit to `buildProgress` that
// re-scopes its samples or adds a term to its ETA fails on this file loudly
// instead of silently making `ralph start` contradict the `ralph status` the same
// user runs an hour later.
//
// Hermetic by construction: the module is pure, so every input is injected, `now`
// is an integer built from a LOCAL Date (the rendered clock is local time, so a
// UTC literal would make the suite timezone-dependent) and the expected clock is
// read back off the same local Date.

const MIN = 60000
const RUN = 'ralph-ralph-b36ff7b1'
const OTHER_RUN = 'ralph-ralph-0badf00d'

// A launch at 16:04; nine tasks at 84 min/task land the finish at 04:40 tomorrow.
const NOW = new Date(2026, 7, 25, 16, 4, 0).getTime()

// The box's text column: `   Watch live:     ` is a 3-space indent and a 16-wide
// label field, and the projection lines print among those lines.
const BOX_TEXT_COLUMN = '   Watch live:     '.length

const event = ({ number = 1, run = RUN, minutes = null, cost = null, ts = 1 } = {}) => ({
  issue_number: number,
  run_id: run,
  ts,
  duration_ms: minutes == null ? null : minutes * MIN,
  total_cost_usd: cost,
  verdict: 'pass',
})

const tagged = (payload) => 'RALPH_ISSUE_EVENT ' + payload
const jsonl = (...events) => events.map((e) => tagged(JSON.stringify(e))).join('\n') + '\n'

// The issue's worked example, spread across TWO runs on purpose: a launch has no
// run of its own, so every task ever recorded counts. #029 97min/$34.10 (an older
// run), #030 71min/$28.75 → 84 min/task and $31.425/task.
const HISTORY = jsonl(
  event({ number: 29, run: OTHER_RUN, minutes: 97, cost: 34.1, ts: 1 }),
  event({ number: 30, minutes: 71, cost: 28.75, ts: 2 }),
)

// Durations only, no cost anywhere — a Codex project, whose stream carries no cost.
const DURATIONS_ONLY = jsonl(
  event({ number: 29, run: OTHER_RUN, minutes: 97, ts: 1 }),
  event({ number: 30, minutes: 71, ts: 2 }),
)

// Cost only, and no usable duration anywhere — the mirror case.
const COSTS_ONLY = jsonl(
  event({ number: 29, run: OTHER_RUN, cost: 34.1, ts: 1 }),
  event({ number: 30, cost: 28.75, ts: 2 }),
)

const launch = (overrides = {}) =>
  buildLaunchProjection({ metricsText: HISTORY, queue: 9, now: NOW, ...overrides })

const lines = (overrides = {}) => renderLaunchProjection(launch(overrides))

// The local wall clock of an instant, the way the box prints it — derived rather
// than written out, so the assertions hold in any timezone.
const clockOf = (ms) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// A NEGATIVE FIGURE: a minus that STARTS a number — `~$-31`, `-5 min/task`,
// `→ -1h20m` — rather than any hyphen standing in front of a digit. Narrowed to
// that (#60 review): the broad form would also flag wording this block may
// legitimately grow one day (`~12h36m-14h00m`, `done ≈ 2026-08-26`) for reasons
// that are not a defect, while what may never reach a reader is a money or
// duration figure that went below zero.
const NEGATIVE_FIGURE = /(?:^|[\s(≈$])-\d/

describe('buildLaunchProjection — hostile issues.jsonl never throws (#60 QA)', () => {
  // Every shape a real .ralph/metrics/issues.jsonl can take, PREPENDED to the two
  // good rows, so the assertion is not merely "no throw" but "the junk did not
  // swallow the history behind it".
  const junk = {
    'a blank file': '',
    'blank lines': '\n\n\n',
    'whitespace-only lines': '   \n\t\n \r\n',
    'untagged loop stdout': 'npm WARN deprecated foo@1.0.0\n==> Iteration for issue #29',
    'the tag with nothing after it': 'RALPH_ISSUE_EVENT ',
    'JSON truncated mid-write': `RALPH_ISSUE_EVENT {"issue_number":31,"run_id":"${RUN}"`,
    'a JSON array': 'RALPH_ISSUE_EVENT [{"duration_ms":999999999,"total_cost_usd":999}]',
    'a JSON number': 'RALPH_ISSUE_EVENT 3',
    'a JSON string': 'RALPH_ISSUE_EVENT "x"',
    'JSON null': 'RALPH_ISSUE_EVENT null',
    'JSON true': 'RALPH_ISSUE_EVENT true',
    'a trailing comma': `RALPH_ISSUE_EVENT {"run_id":"${RUN}","duration_ms":1,}`,
    'a bare NaN literal': `RALPH_ISSUE_EVENT {"run_id":"${RUN}","duration_ms":NaN}`,
    'the tag twice on one line': `RALPH_ISSUE_EVENT RALPH_ISSUE_EVENT {"duration_ms":999999999,"total_cost_usd":999}`,
    'the tag separated by a tab': `RALPH_ISSUE_EVENT\t{"duration_ms":999999999,"total_cost_usd":999}`,
    'a 2 MiB single line': `RALPH_ISSUE_EVENT {"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`,
    'a NUL byte in the payload': 'RALPH_ISSUE_EVENT {"note":"a\\u0000b"}',
    'a lone surrogate escape': 'RALPH_ISSUE_EVENT {"note":"\\ud800"}',
  }

  for (const [label, prefix] of Object.entries(junk)) {
    it(`skips ${label} and still projects the rows behind it`, () => {
      let projection
      expect(() => {
        projection = launch({ metricsText: prefix + '\n' + HISTORY })
      }).not.toThrow()
      expect(projection.paceMs).toBe(84 * MIN)
      expect(projection.samples).toBe(2)
      expect(projection.costPerTaskUsd).toBeCloseTo(31.425, 5)
      expect(projection.costSamples).toBe(2)
      expect(projection.totalMs).toBe(756 * MIN)
    })
  }

  it('reads the history when the LAST line is the truncated one (a killed run)', () => {
    // The shape a run killed mid-append actually leaves: complete rows, then half
    // of one. The projection must be the two complete rows and nothing else.
    const projection = launch({
      metricsText: HISTORY + `RALPH_ISSUE_EVENT {"issue_number":31,"duration_ms":9999`,
    })
    expect(projection.paceMs).toBe(84 * MIN)
    expect(projection.samples).toBe(2)
    expect(projection.costPerTaskUsd).toBeCloseTo(31.425, 5)
  })

  it('reads CRLF rows, and rows with no trailing newline', () => {
    const rows = [
      tagged(JSON.stringify(event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }))),
      tagged(JSON.stringify(event({ number: 30, minutes: 71, cost: 28.75, ts: 2 }))),
    ]
    for (const [label, metricsText] of [
      ['CRLF', rows.join('\r\n') + '\r\n'],
      ['no trailing newline', rows.join('\n')],
      ['a trailing blank line', rows.join('\n') + '\n\n'],
    ]) {
      const projection = launch({ metricsText })
      expect(projection.paceMs, label).toBe(84 * MIN)
      expect(projection.costPerTaskUsd, label).toBeCloseTo(31.425, 5)
    }
  })

  it('accepts a metricsText that is not a string', () => {
    // safeReadMetrics in start.js normalizes, but the pure function is exported
    // and must not assume a caller did.
    for (const metricsText of [undefined, null, 0, 42, false, {}, [], () => {}]) {
      let projection
      expect(() => {
        projection = launch({ metricsText })
      }, String(metricsText)).not.toThrow()
      expect(projection.basis, String(metricsText)).toBe('unknown')
      expect(projection.paceMs, String(metricsText)).toBe(null)
      expect(projection.costPerTaskUsd, String(metricsText)).toBe(null)
      expect(renderLaunchProjection(projection), String(metricsText)).toEqual([])
    }
  })

  it('reads a Buffer the way the shell’s readFile can hand it over', () => {
    const projection = launch({ metricsText: Buffer.from(HISTORY) })
    expect(projection.paceMs).toBe(84 * MIN)
    expect(projection.costPerTaskUsd).toBeCloseTo(31.425, 5)
  })

  it('does not let __proto__ in a payload pollute Object.prototype or the rate', () => {
    const before = Object.prototype.total_cost_usd
    const projection = launch({
      metricsText:
        'RALPH_ISSUE_EVENT {"__proto__":{"duration_ms":999999999,"total_cost_usd":999}}\n' + HISTORY,
    })
    expect(Object.prototype.total_cost_usd).toBe(before)
    expect({}.total_cost_usd).toBe(undefined)
    expect(projection.paceMs).toBe(84 * MIN)
    expect(projection.costPerTaskUsd).toBeCloseTo(31.425, 5)
  })

  it('reads the two halves off ONE text: parsing it twice cannot disagree', () => {
    // buildLaunchProjection parses the text a second time for the money half, so
    // the two passes must be reading the same rows. A history where exactly one
    // row carries a cost catches a pass that drifted: 2 duration samples, 1 cost.
    const projection = launch({
      metricsText: jsonl(
        event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
        event({ number: 30, minutes: 71, ts: 2 }),
      ),
    })
    expect(projection.samples).toBe(2)
    expect(projection.paceMs).toBe(84 * MIN)
    // Rated over the tasks that RECORDED a cost, not over every task.
    expect(projection.costSamples).toBe(1)
    expect(projection.costPerTaskUsd).toBeCloseTo(34.1, 5)
  })
})

describe('buildLaunchProjection — a value that is not a measurement (#60 QA)', () => {
  // Every shape `duration_ms` can carry that is NOT a positive finite number of
  // milliseconds. Each must be ignored as a sample — never coerced, never averaged
  // in as a zero.
  const shapes = {
    zero: '0',
    'negative zero': '-0',
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
        tagged(`{"issue_number":28,"ts":1,"duration_ms":${raw}}`),
        tagged(JSON.stringify(event({ number: 29, minutes: 84, ts: 2 }))),
      ].join('\n')
      const projection = launch({ metricsText })
      expect(projection.samples).toBe(1)
      expect(projection.paceMs).toBe(84 * MIN)
      expect(projection.totalMs).toBe(9 * 84 * MIN)
    })

    it(`ignores ${label} as a cost sample — never a $0 rate`, () => {
      const metricsText = [
        tagged(`{"issue_number":28,"ts":1,"duration_ms":${84 * MIN},"total_cost_usd":${raw}}`),
        tagged(`{"issue_number":29,"ts":2,"duration_ms":${84 * MIN},"total_cost_usd":null}`),
      ].join('\n')
      const projection = launch({ metricsText })
      expect(projection.costPerTaskUsd).toBe(null)
      expect(projection.costSamples).toBe(0)
      expect(projection.totalUsd).toBe(null)
      // The duration side is a separate measurement and must survive.
      expect(projection.paceMs).toBe(84 * MIN)
      const rendered = renderLaunchProjection(projection).join('\n')
      expect(rendered).not.toMatch(/\$/)
    })
  }

  it('leaves both fields absent as unmeasured, with no zeros anywhere', () => {
    const projection = launch({
      metricsText: [tagged('{"issue_number":28,"ts":1}'), tagged('{"issue_number":29,"ts":2}')].join(
        '\n',
      ),
    })
    expect(projection).toEqual({
      basis: 'unknown',
      paceMs: null,
      samples: 0,
      costPerTaskUsd: null,
      costSamples: 0,
      queue: 9,
      totalMs: null,
      finishAt: null,
      totalUsd: null,
    })
    expect(renderLaunchProjection(projection)).toEqual([])
  })

  it('drops a rate whose samples overflow their own sum rather than reporting Infinity', () => {
    const projection = launch({
      metricsText: [
        tagged(`{"ts":1,"duration_ms":1e308,"total_cost_usd":1e308}`),
        tagged(`{"ts":2,"duration_ms":1e308,"total_cost_usd":1e308}`),
      ].join('\n'),
    })
    expect(projection.paceMs).toBe(null)
    expect(projection.samples).toBe(0)
    expect(projection.costPerTaskUsd).toBe(null)
    // ...and the counts drop with the rate, so neither ever describes a rate that
    // is not there.
    expect(projection.costSamples).toBe(0)
    expect(renderLaunchProjection(projection)).toEqual([])
  })
})

describe('buildLaunchProjection — the accepted queue depth, hostile (#60 QA)', () => {
  const queues = {
    'a real empty queue': { queue: 0, expected: 0 },
    'a failed count (null)': { queue: null, expected: null },
    'undefined': { queue: undefined, expected: null },
    'NaN — the shape `Number("abc")` takes': { queue: NaN, expected: null },
    'Infinity': { queue: Infinity, expected: null },
    'a numeric string': { queue: '9', expected: null },
    'an object': { queue: { count: 9 }, expected: null },
    'a negative count clamps to zero, never a negative total': { queue: -5, expected: 0 },
    'negative zero collapses to a plain zero': { queue: -0, expected: 0 },
    'a non-integer count': { queue: 2.5, expected: 2.5 },
  }

  for (const [label, { queue, expected }] of Object.entries(queues)) {
    it(`treats ${label}`, () => {
      const projection = launch({ queue })
      expect(projection.queue).toBe(expected)
      expect(Object.is(projection.queue, -0)).toBe(false)
      if (expected == null) {
        // No depth means no totals — but the two RATES are measured facts and stay.
        expect(projection.totalMs).toBe(null)
        expect(projection.totalUsd).toBe(null)
        expect(projection.finishAt).toBe(null)
        expect(projection.paceMs).toBe(84 * MIN)
        expect(projection.costPerTaskUsd).toBeCloseTo(31.425, 5)
        // ...so the block is one line, with no dangling `→`.
        expect(renderLaunchProjection(projection)).toHaveLength(1)
      } else {
        expect(projection.totalMs).toBe(expected * 84 * MIN)
        expect(projection.totalUsd).toBeCloseTo(expected * 31.425, 5)
        expect(projection.finishAt).toBe(NOW + expected * 84 * MIN)
      }
      const rendered = renderLaunchProjection(projection).join('\n')
      expect(rendered).not.toMatch(/NaN|undefined|Infinity|null/)
      expect(rendered).not.toMatch(NEGATIVE_FIGURE)
    })
  }

  it('never lets a negative count read as a shorter queue than empty', () => {
    expect(launch({ queue: -5 }).totalMs).toBe(launch({ queue: 0 }).totalMs)
    expect(launch({ queue: -5 }).totalUsd).toBe(launch({ queue: 0 }).totalUsd)
  })

  it('reports null rather than Infinity when the queue overflows a finite rate', () => {
    for (const queue of [1e308, Number.MAX_VALUE]) {
      const projection = launch({
        metricsText: jsonl(event({ number: 29, minutes: 1e10, cost: 1e300, ts: 1 })),
        queue,
      })
      expect(projection.totalMs, String(queue)).toBe(null)
      expect(projection.totalUsd, String(queue)).toBe(null)
      expect(projection.finishAt, String(queue)).toBe(null)
    }
  })
})

describe('buildLaunchProjection — the all-time borrow, pinned (#60 QA)', () => {
  // The launch projection borrows buildProgress's duration arithmetic by calling
  // it with no `record`. These are the properties that borrow depends on. If one
  // of them stops holding, `ralph start` and `ralph status` begin telling the same
  // user two different stories about the same queue — so they are asserted here
  // rather than left as prose in a comment.

  it('is ALWAYS the all-time basis, never the in-run window', () => {
    // Five rows in one run: `ralph status` mid-run would report the last three
    // (60 min). A launch has no run, so it must report the lifetime mean (180).
    const five = jsonl(
      ...[600, 120, 90, 60, 30].map((m, i) => event({ number: 20 + i, minutes: m, ts: i + 1 })),
    )
    const projection = launch({ metricsText: five, queue: 1 })
    expect(projection.basis).toBe('all-time')
    expect(projection.samples).toBe(5)
    expect(projection.paceMs).toBe(180 * MIN)
    expect(buildProgress({ metricsText: five, record: { run_id: RUN }, queue: 1, now: NOW }).paceMs)
      .toBe(60 * MIN)
  })

  it('counts every run in the file — a launch is not scoped to anything', () => {
    const projection = launch({
      metricsText: jsonl(
        event({ number: 1, run: 'run-a', minutes: 60, cost: 10, ts: 1 }),
        event({ number: 2, run: 'run-b', minutes: 120, cost: 20, ts: 2 }),
        event({ number: 3, run: 'run-c', minutes: 60, cost: 30, ts: 3 }),
      ),
      queue: 1,
    })
    expect(projection.samples).toBe(3)
    expect(projection.paceMs).toBe(80 * MIN)
    expect(projection.costSamples).toBe(3)
    expect(projection.costPerTaskUsd).toBeCloseTo(20, 5)
  })

  it('carries NO in-flight term: totalMs is exactly queue × paceMs', () => {
    // The identity the borrow reduces to. Swept over depths, because a term that
    // is zero for one depth and not another would slip past a single case.
    for (const queue of [0, 1, 2, 9, 37, 1000]) {
      const projection = launch({ queue })
      expect(projection.totalMs, String(queue)).toBe(queue * projection.paceMs)
      expect(projection.finishAt, String(queue)).toBe(NOW + projection.totalMs)
      expect(projection.totalUsd, String(queue)).toBeCloseTo(queue * projection.costPerTaskUsd, 5)
    }
  })

  it('ignores a `record` handed to it — there is no run at launch', () => {
    // A caller (or a future refactor) passing the live record must not be able to
    // scope the launch projection to a run, nor add an in-flight remainder to it.
    const record = {
      run_id: RUN,
      current: { number: 31, started_at: new Date(NOW - 10 * MIN).toISOString() },
    }
    expect(launch({ record })).toEqual(launch())
  })

  it('borrows the duration half verbatim from a record-less buildProgress', () => {
    const base = buildProgress({ metricsText: HISTORY, queue: 9, now: NOW })
    const projection = launch()
    expect(projection.paceMs).toBe(base.paceMs)
    expect(projection.samples).toBe(base.samples)
    expect(projection.queue).toBe(base.remaining)
    expect(projection.totalMs).toBe(base.etaMs)
    expect(projection.finishAt).toBe(base.finishAt)
    expect(projection.basis).toBe(base.paceBasis)
    // ...and a record-less buildProgress has nothing in flight to add.
    expect(base.inFlight).toBe(0)
    expect(base.completed).toBe(0)
  })

  it('agrees with `ralph status` once a run has done the whole history', () => {
    // The cross-surface property: the numbers the box promised at launch are the
    // numbers the live view reports later, over the same evidence. One run, two
    // rows — so status's window and the all-time mean cover the same samples.
    const metricsText = jsonl(
      event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
      event({ number: 30, minutes: 71, cost: 28.75, ts: 2 }),
    )
    const live = buildProgress({ metricsText, record: { run_id: RUN }, queue: 9, now: NOW })
    const projection = buildLaunchProjection({ metricsText, queue: 9, now: NOW })
    expect(projection.paceMs).toBe(live.paceMs)
    expect(projection.costPerTaskUsd).toBe(live.costPerTaskUsd)
    expect(projection.totalMs).toBe(live.etaMs)
    expect(projection.finishAt).toBe(live.finishAt)
  })

  it('drops the finish time, and only that, when `now` is unusable', () => {
    for (const now of [null, undefined, NaN, Infinity, -Infinity, '1787684640000', new Date(NOW)]) {
      const projection = launch({ now })
      expect(projection.finishAt, String(now)).toBe(null)
      // The duration and the money are independent of the clock and must survive.
      expect(projection.totalMs, String(now)).toBe(756 * MIN)
      expect(projection.totalUsd, String(now)).toBeCloseTo(282.825, 5)
    }
  })
})

describe('renderLaunchProjection — segment absence vs block omission (#60 QA)', () => {
  it('renders the worked example in the start box’s label column', () => {
    expect(lines()).toEqual([
      '   Projection:     ~84 min/task · ~$31/task',
      `                   → ~12h36m, ~$280, done ≈ ${clockOf(NOW + 756 * MIN)}`,
    ])
  })

  it('aligns both lines with the box lines they print among', () => {
    const [first, second] = lines()
    expect(first.indexOf('~')).toBe(BOX_TEXT_COLUMN)
    // The continuation line has no second label, so the `→` sits under the first
    // line's text rather than under its label.
    expect(second.indexOf('→')).toBe(BOX_TEXT_COLUMN)
    expect(second.slice(0, BOX_TEXT_COLUMN).trim()).toBe('')
    expect(first.startsWith('   Projection:')).toBe(true)
  })

  it('says nothing at all for a projection it did not build', () => {
    for (const projection of [undefined, null, {}, [], 0, 'nope', true]) {
      expect(renderLaunchProjection(projection), String(projection)).toEqual([])
    }
  })

  it('omits the whole block on a fresh repo — no zeros, no `unknown`', () => {
    for (const metricsText of ['', '\n\n', 'RALPH_ISSUE_EVENT {\n???\n']) {
      expect(renderLaunchProjection(launch({ metricsText })), JSON.stringify(metricsText)).toEqual(
        [],
      )
    }
  })

  it('drops the money segments on a costless history, and says neither $0 nor unknown', () => {
    const rendered = lines({ metricsText: DURATIONS_ONLY })
    expect(rendered).toEqual([
      '   Projection:     ~84 min/task',
      `                   → ~12h36m, done ≈ ${clockOf(NOW + 756 * MIN)}`,
    ])
    expect(rendered.join('\n')).not.toMatch(/\$|unknown/)
  })

  it('drops the duration segments on a history with costs but no usable durations', () => {
    const rendered = lines({ metricsText: COSTS_ONLY })
    expect(rendered).toEqual([
      '   Projection:     ~$31/task',
      '                   → ~$280',
    ])
    // No pace means no finish, and the absent clock is absent rather than `--:--`.
    expect(rendered.join('\n')).not.toMatch(/min|done|--:--|unknown/)
  })

  it('drops `done ≈` rather than printing `--:--` when there is no clock', () => {
    for (const now of [null, undefined, NaN, Infinity, 'now', new Date(NOW)]) {
      const rendered = lines({ now })
      expect(rendered, String(now)).toEqual([
        '   Projection:     ~84 min/task · ~$31/task',
        '                   → ~12h36m, ~$280',
      ])
      expect(rendered.join('\n'), String(now)).not.toContain('--:--')
    }
  })

  it('prints the rates with no totals line when the queue depth is unknown', () => {
    for (const queue of [null, undefined, NaN, 'nine']) {
      expect(lines({ queue }), String(queue)).toEqual([
        '   Projection:     ~84 min/task · ~$31/task',
      ])
    }
  })

  it('prints one clock, formatted by formatClock and nothing else', () => {
    // No second, divergent formatter for the same instant — the box's clock and
    // the live view's are the same function of the same number.
    const projection = launch()
    expect(renderLaunchProjection(projection)[1]).toContain(
      `done ≈ ${formatClock(projection.finishAt)}`,
    )
  })

  it('crosses midnight as tomorrow’s clock, never a wrapped or negative reading', () => {
    const lateNight = new Date(2026, 7, 25, 23, 40, 0).getTime()
    const rendered = lines({ metricsText: jsonl(event({ minutes: 50, ts: 1 })), queue: 1, now: lateNight })
    expect(rendered[1]).toBe(`                   → ~50min, done ≈ ${clockOf(lateNight + 50 * MIN)}`)
    expect(clockOf(lateNight + 50 * MIN)).toMatch(/^00:3\d$/)
  })
})

describe('renderLaunchProjection — the coarse dollar grid at the low end (#60 QA)', () => {
  // `floorUsd` is 0 on this surface, so the live view's "never below the money
  // already spent" limit cannot bite here — which leaves the 10¢ grid free to
  // round a small, GENUINELY MEASURED rate all the way to zero. A rate of a few
  // cents a task is entirely ordinary on a cheap model.
  const cheap = (cost, queue = 9) =>
    lines({
      metricsText: jsonl(
        event({ number: 29, minutes: 97, cost, ts: 1 }),
        event({ number: 30, minutes: 71, cost, ts: 2 }),
      ),
      queue,
    })

  it('keeps the decimal on a sub-dollar rate', () => {
    // The dev's case, re-pinned: 40¢ a task survives the grid.
    expect(cheap(0.4)[0]).toBe('   Projection:     ~84 min/task · ~$0.4/task')
  })

  it('never prints a MEASURED rate as zero dollars a task', () => {
    // 4¢ a task was measured — twice — so `~$0.0/task` is an invented zero, and
    // this module's whole discipline is that a zero never stands in for data.
    // Which figure replaces it is the dev's call (the exact `~$0.04/task`, on the
    // same "the exact figure wins" rule the grid already has for its two limits);
    // what may not survive is a rate that reads as free.
    for (const cost of [0.001, 0.004, 0.01, 0.04, 0.049]) {
      const rateSegment = cheap(cost)[0].split(' · ')[1]
      // A money figure with its qualifier — `~$0.04/task` for an approximation,
      // `<$0.01/task` for a bound — either of which is an answer. The pin is the
      // line below: whatever the spelling, the figure may not read as free.
      expect(rateSegment, `${cost}/task`).toMatch(/^[~<]\$[\d.]+\/task$/)
      expect(Number(rateSegment.replace(/[^\d.]/g, '')), `${cost}/task`).toBeGreaterThan(0)
    }
  })

  it('never prints a projected TOTAL as zero dollars for a queue that costs money', () => {
    // Same grid, same zero, one line down: one task at 4¢ is 4¢ of projected
    // spend, and `~$0.0` reads as a free run.
    const total = cheap(0.04, 1)[1].split(', ')[1]
    expect(Number(total.replace(/[^\d.]/g, ''))).toBeGreaterThan(0)
  })

  it('keeps the grid’s coarseness where there is something to be coarse about', () => {
    // The grid is right for the magnitudes it was written for; this pins that the
    // fix above may not sharpen them into false precision.
    expect(cheap(31.425)[0]).toBe('   Projection:     ~84 min/task · ~$31/task')
    expect(cheap(251.4)[0]).toBe('   Projection:     ~84 min/task · ~$250/task')
  })
})

describe('renderLaunchProjection — a magnitude the formatters cannot spell (#60 QA)', () => {
  it('never renders a clock or an elapsed no reader can parse', () => {
    // Two routes, both reachable from untrusted input: a corrupt `duration_ms`,
    // and an absurd queue depth. Each puts a FINITE `finishAt` outside the range
    // `new Date(ms)` can represent, and the human formatters have no clamp — the
    // JSON surface's `isoUtcSecondsClamped` exists for exactly this hazard, and
    // this block does not go through it.
    const cases = {
      'a corrupt duration_ms of 1e16': {
        metricsText: jsonl(event({ number: 29, minutes: 1e16 / MIN, cost: 1, ts: 1 })),
        queue: 6,
      },
      'a corrupt duration_ms of 1e300': {
        metricsText: jsonl(event({ number: 29, minutes: 1e300 / MIN, cost: 1, ts: 1 })),
        queue: 6,
      },
      // Same hazard on the money half: past 1e21 both `String` and `toFixed`
      // switch to exponent notation, so the grid hands the box `~$1e+300/task`.
      'a corrupt total_cost_usd of 1e300': {
        metricsText: jsonl(event({ number: 29, minutes: 97, cost: 1e300, ts: 1 })),
        queue: 6,
      },
      'a queue depth at the top of the safe-integer range': {
        queue: Number.MAX_SAFE_INTEGER,
      },
      'an absurd queue depth': { queue: 1e15 },
    }
    for (const [label, overrides] of Object.entries(cases)) {
      const rendered = lines(overrides).join('\n')
      expect(rendered, `${label}:\n${rendered}`).not.toMatch(/NaN/)
      expect(rendered, `${label}:\n${rendered}`).not.toMatch(/e[+-]\d/)
    }
  })
})

describe('buildLaunchProjection / renderLaunchProjection — the hard rule (#60 QA)', () => {
  // The sweep. Every numeric field either null or finite, no `-0`, no count
  // describing a rate that is not there, the basis never the in-run window, and
  // the rendered text free of every token that means "we made a number up".
  //
  // The magnitudes that currently break the rendered half — an out-of-calendar
  // clock and an exponent-notation rate — have their own test above (`a magnitude
  // the formatters cannot spell`) rather than rows here, so one defect reports
  // from one place.
  const FIELDS = [
    'paceMs',
    'samples',
    'costPerTaskUsd',
    'costSamples',
    'queue',
    'totalMs',
    'finishAt',
    'totalUsd',
  ]
  const FORBIDDEN = [
    [/NaN/, 'NaN'],
    [/undefined/, 'undefined'],
    [/\bnull\b/, 'null'],
    [/Infinity/, 'Infinity'],
    [/unknown/, 'the word unknown'],
    [/--:--/, 'an empty clock'],
    [NEGATIVE_FIGURE, 'a negative money or duration figure'],
    [/e[+-]\d/, 'exponent notation'],
    [/·\s*$|→\s*$|,\s*$/, 'a dangling separator'],
  ]

  const cases = {
    'no usable input at all': { metricsText: null, queue: null, now: null },
    'an empty history': { metricsText: '' },
    'pure junk': { metricsText: 'RALPH_ISSUE_EVENT {\n\n???\n' },
    'a truncated last line': { metricsText: HISTORY + 'RALPH_ISSUE_EVENT {"duration' },
    'durations but no costs': { metricsText: DURATIONS_ONLY },
    'costs but no durations': { metricsText: COSTS_ONLY },
    'zero durations and zero costs': {
      metricsText: jsonl(
        event({ number: 29, minutes: 0, cost: 0, ts: 1 }),
        event({ number: 30, minutes: 0, cost: 0, ts: 2 }),
      ),
    },
    'negative durations and negative costs': {
      metricsText: [
        tagged('{"ts":1,"duration_ms":-1000,"total_cost_usd":-5}'),
        tagged('{"ts":2,"duration_ms":-2000,"total_cost_usd":-5}'),
      ].join('\n'),
    },
    'string numbers throughout': {
      metricsText: [
        tagged('{"ts":1,"duration_ms":"5040000","total_cost_usd":"31.42"}'),
        tagged('{"ts":2,"duration_ms":"5040000","total_cost_usd":"31.42"}'),
      ].join('\n'),
    },
    'costs that overflow their sum': {
      metricsText: [
        tagged(`{"ts":1,"duration_ms":${97 * MIN},"total_cost_usd":1e308}`),
        tagged(`{"ts":2,"duration_ms":${71 * MIN},"total_cost_usd":1e308}`),
      ].join('\n'),
    },
    'durations that overflow their sum': {
      metricsText: [
        tagged('{"ts":1,"duration_ms":1e308}'),
        tagged('{"ts":2,"duration_ms":1e308}'),
      ].join('\n'),
    },
    // Magnitudes chosen to overflow the PRODUCT while each rate still prints: the
    // unprintable rates are the subject of the formatters test above, and one
    // defect should report from one place.
    'a rate whose product with the queue overflows': {
      metricsText: jsonl(event({ number: 29, minutes: 1e10 / MIN, cost: 1e10, ts: 1 })),
      queue: 1e308,
    },
    'a queue at the top of the number range': { queue: Number.MAX_VALUE },
    'a five-figure queue': { queue: 20000 },
    'an empty queue': { queue: 0 },
    'a negative queue': { queue: -3 },
    'a queue of negative zero': { queue: -0 },
    'a non-integer queue': { queue: 3.5 },
    'a failed queue count': { queue: null },
    'a queue count that is a string': { queue: '9' },
    'no now': { now: null },
    'a NaN now': { now: NaN },
    'a now at the epoch': { now: 0 },
    'a now before the epoch': { now: -1000 },
    'a history from many runs': {
      metricsText: jsonl(
        event({ number: 1, run: 'a', minutes: 40, cost: 1, ts: 1 }),
        event({ number: 2, run: 'b', minutes: 80, cost: 2, ts: 2 }),
      ),
    },
    'one task, one waiting': {
      metricsText: jsonl(event({ number: 29, minutes: 1, cost: 0.5, ts: 1 })),
      queue: 1,
    },
    'a 2 MiB padded line': {
      metricsText: `RALPH_ISSUE_EVENT {"pad":"${'x'.repeat(2 * 1024 * 1024)}"}\n` + HISTORY,
    },
  }

  for (const [label, overrides] of Object.entries(cases)) {
    it(`holds every field and every line for ${label}`, () => {
      const projection = launch(overrides)

      for (const field of FIELDS) {
        const value = projection[field]
        expect(
          value == null || Number.isFinite(value),
          `${label} → ${field} = ${value}`,
        ).toBe(true)
        expect(Object.is(value, -0), `${label} → ${field} is -0`).toBe(false)
      }
      // Counts never describe a rate that is not there, and never go negative.
      expect(projection.samples, label).toBeGreaterThanOrEqual(0)
      expect(projection.costSamples, label).toBeGreaterThanOrEqual(0)
      if (projection.paceMs == null) expect(projection.samples, label).toBe(0)
      if (projection.costPerTaskUsd == null) expect(projection.costSamples, label).toBe(0)
      // Nothing here can be negative: not a queue, not a duration, not a dollar.
      for (const field of ['queue', 'totalMs', 'totalUsd', 'paceMs', 'costPerTaskUsd']) {
        if (projection[field] != null) {
          expect(projection[field], `${label} → ${field}`).toBeGreaterThanOrEqual(0)
        }
      }
      // The borrow's precondition, on every input: a launch is never in-run.
      expect(['all-time', 'unknown'], label).toContain(projection.basis)

      const rendered = renderLaunchProjection(projection)
      expect(rendered.length, label).toBeLessThanOrEqual(2)
      const text = rendered.join('\n')
      for (const [pattern, name] of FORBIDDEN) {
        expect(text, `${label} → ${name} in:\n${text || '(empty)'}`).not.toMatch(pattern)
      }
      // Either the whole block, or a first line and nothing dangling after it.
      if (rendered.length > 0) expect(rendered[0], label).toContain('   Projection:     ')
      if (rendered.length === 2) expect(rendered[1], label).toContain('→ ')
    })
  }

  it('is deterministic and mutates nothing it was handed', () => {
    const args = { metricsText: HISTORY, queue: 9, now: NOW }
    expect(buildLaunchProjection(args)).toEqual(buildLaunchProjection(args))
    expect(renderLaunchProjection(buildLaunchProjection(args))).toEqual(
      renderLaunchProjection(buildLaunchProjection(args)),
    )
    expect(args.metricsText).toBe(HISTORY)
    // ...and a frozen projection renders: a renderer owns none of what it reads.
    expect(() => renderLaunchProjection(Object.freeze(buildLaunchProjection(args)))).not.toThrow()
  })

  it('reaches for no clock of its own, even for the finish time', () => {
    // `now` is an input on this surface too, so a stubbed ambient clock must not
    // change a single character of the block.
    const real = Date.now
    try {
      Date.now = () => {
        throw new Error('progress.js reached for the ambient clock')
      }
      expect(lines()).toEqual([
        '   Projection:     ~84 min/task · ~$31/task',
        `                   → ~12h36m, ~$280, done ≈ ${clockOf(NOW + 756 * MIN)}`,
      ])
    } finally {
      Date.now = real
    }
  })

  it('keeps the launch path out of the source’s I/O ban', () => {
    // The two new exports live in the pure module, so the module-wide purity
    // grep in progress.qa.test.js already covers them — this asserts the pair is
    // actually THERE, so a future move into a shell would fail here rather than
    // silently leaving the grep passing over a file that no longer owns them.
    const source = readFileSync(new URL('./progress.js', import.meta.url), 'utf8')
    expect(source).toMatch(/export function buildLaunchProjection\(/)
    expect(source).toMatch(/export function renderLaunchProjection\(/)
  })
})
