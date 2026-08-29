import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildPostMortem, renderPostMortem } from './post-mortem.js'

// #59 — the morning-after view. `ralph status` on an idle repo has to answer "how
// did last night go?" from the record the loop left behind plus the events it
// appended on the way, and it has to do it without a clock of its own: every
// number below is pinned by an injected `now` and a string of metrics text.
//
// The two properties these tests exist for, both inherited from lib/progress.js:
//
//   1. THE UNKNOWN DISCIPLINE. A report card is read by someone deciding whether
//      last night was worth the money, so a zero standing in for absent data is
//      worse than no number at all. Every field is `null` — rendered `unknown` —
//      the moment its inputs are missing, and that is asserted for the partial
//      records a killed or older run leaves behind, not only for the happy path.
//   2. THE COUNTS HAVE TWO SOURCES, IN ORDER. The loop writes `ok`/`failed`
//      authoritatively when it gets to end the run; an interrupted run never does,
//      so the card tallies its events instead — `pass` is ok and EVERYTHING else
//      (fail, unknown) is failed, the same conservative accounting
//      aggregateCycleCounts uses in lib/issue-metrics.js.
//
// Hermetic: local Date constructors for the wall-clock fixtures (`finished 06:12`
// is a local reading, so a UTC ISO literal would make the suite red outside UTC)
// and an injected epoch-ms `now` everywhere.

const RUN_ID = 'ralph-repo-9f2c1a'
const MIN = 60000

const RUN_STARTED = new Date(2026, 7, 25, 20, 20, 0)
const RUN_FINISHED = new Date(2026, 7, 26, 6, 12, 0) // 9h52m of wall clock
const NOW = new Date(2026, 7, 26, 8, 30, 0).getTime() // 2h18m after the finish

const tagged = (row) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(row)
const event = ({ n, verdict = 'pass', cost = 30, ts = 1, runId = RUN_ID }) =>
  tagged({
    issue_number: n,
    run_id: runId,
    verdict,
    ts,
    duration_ms: 60 * MIN,
    total_cost_usd: cost,
  })

// The issue's overnight run: nine tasks, seven passes, #034 and #041 not passes,
// $268.10 recorded. #041's verdict is `unknown` rather than `fail` on purpose —
// an indeterminate task counts as failed, the way the loop counts it.
const OVERNIGHT = [
  event({ n: 29, ts: 1 }),
  event({ n: 30, ts: 2 }),
  event({ n: 31, ts: 3 }),
  event({ n: 32, ts: 4 }),
  event({ n: 33, ts: 5 }),
  event({ n: 34, ts: 6, verdict: 'fail' }),
  event({ n: 40, ts: 7 }),
  event({ n: 41, ts: 8, verdict: 'unknown' }),
  event({ n: 42, ts: 9, cost: 28.1 }),
].join('\n')

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

// What a hard-killed run leaves on disk: still `running`, no finish, no counts.
const killed = (overrides = {}) =>
  terminal({ status: 'running', finished_at: null, ok: null, failed: null, ...overrides })

const build = (overrides = {}) =>
  buildPostMortem({ metricsText: OVERNIGHT, record: terminal(), queue: 2, now: NOW, ...overrides })

describe('buildPostMortem — the run the loop left behind (#59)', () => {
  it('reads the counts, the spend, the wall clock and the finish age off one record', () => {
    const snapshot = build()
    expect(snapshot.runId).toBe(RUN_ID)
    expect(snapshot.interrupted).toBe(false)
    expect(snapshot.ok).toBe(7)
    expect(snapshot.failed).toBe(2)
    expect(snapshot.failedNumbers).toEqual([34, 41])
    expect(snapshot.spendUsd).toBeCloseTo(268.1, 5)
    expect(snapshot.costPerTaskUsd).toBeCloseTo(268.1 / 9, 5)
    expect(snapshot.wallMs).toBe((9 * 60 + 52) * MIN)
    expect(snapshot.finishedAt).toBe(RUN_FINISHED.getTime())
    expect(snapshot.ageMs).toBe((2 * 60 + 18) * MIN)
    expect(snapshot.queue).toBe(2)
  })

  it('prefers the counts the loop recorded over its own tally of the events', () => {
    // The loop wrote them authoritatively at the end of the run, and it saw
    // iterations this file may not have an event for.
    const snapshot = build({ metricsText: event({ n: 29, ts: 1 }), record: terminal({ ok: 7, failed: 2 }) })
    expect(snapshot.ok).toBe(7)
    expect(snapshot.failed).toBe(2)
  })

  it('tallies the events when the record never recorded counts (an interrupted run)', () => {
    // The whole reason the fallback exists: a killed run never reached endRun, so
    // its own record says nothing about what it completed.
    const snapshot = build({ record: killed() })
    expect(snapshot.interrupted).toBe(true)
    expect(snapshot.ok).toBe(7)
    expect(snapshot.failed).toBe(2)
    expect(snapshot.failedNumbers).toEqual([34, 41])
  })

  it('counts a verdict that is not `pass` as failed, whatever it says', () => {
    const rows = [
      event({ n: 1, ts: 1, verdict: 'pass' }),
      event({ n: 2, ts: 2, verdict: 'fail' }),
      event({ n: 3, ts: 3, verdict: 'unknown' }),
      // No verdict at all — an older event, or one truncated to its numbers.
      tagged({ issue_number: 4, run_id: RUN_ID, ts: 4, total_cost_usd: 30 }),
      event({ n: 5, ts: 5, verdict: 'PASS' }),
    ].join('\n')
    const snapshot = build({ metricsText: rows, record: killed() })
    expect(snapshot.ok).toBe(1)
    expect(snapshot.failed).toBe(4)
    expect(snapshot.failedNumbers).toEqual([2, 3, 4, 5])
  })

  it('keeps the failed numbers in file order, and only the ones it can name', () => {
    const rows = [
      event({ n: 41, ts: 1, verdict: 'fail' }),
      event({ n: 'thirty-four', ts: 2, verdict: 'fail' }),
      event({ n: 34, ts: 3, verdict: 'fail' }),
    ].join('\n')
    expect(build({ metricsText: rows, record: killed() }).failedNumbers).toEqual([41, 34])
  })

  it('scopes every number to the record’s own run — issues.jsonl outlives a run', () => {
    const otherRun = [
      event({ n: 90, ts: 1, runId: 'run-old', cost: 500 }),
      event({ n: 91, ts: 2, runId: 'run-old', cost: 500, verdict: 'fail' }),
    ].join('\n')
    const snapshot = build({ metricsText: otherRun, record: killed() })
    expect(snapshot.spendUsd).toBe(null)
    expect(snapshot.ok).toBe(null)
    expect(snapshot.failed).toBe(null)
    expect(snapshot.failedNumbers).toEqual([])
  })

  it('matches NOTHING for a record too broken to name its run', () => {
    for (const runId of [null, undefined, '']) {
      const snapshot = build({ record: killed({ run_id: runId }) })
      expect(snapshot.runId, JSON.stringify(runId)).toBe(null)
      expect(snapshot.spendUsd, JSON.stringify(runId)).toBe(null)
      expect(snapshot.ok, JSON.stringify(runId)).toBe(null)
      expect(snapshot.failedNumbers, JSON.stringify(runId)).toEqual([])
    }
  })

  it('averages the spend over the tasks that RECORDED a cost, not every task', () => {
    // A mixed Claude/Codex run records no cost for the Codex half, and dividing by
    // every completed task would report half the real rate.
    const mixed = [
      event({ n: 29, ts: 1, cost: 30 }),
      event({ n: 30, ts: 2, cost: 0 }),
      event({ n: 31, ts: 3, cost: null }),
      event({ n: 32, ts: 4, cost: 20 }),
    ].join('\n')
    const snapshot = build({ metricsText: mixed, record: killed() })
    expect(snapshot.spendUsd).toBe(50)
    expect(snapshot.costPerTaskUsd).toBe(25)
  })

  it('reads the finish, its age and the wall clock as unknown when the run never ended', () => {
    // `now` is NOT a stand-in for a finish that never happened: an interrupted run
    // has no finish time, so it has no duration either.
    const snapshot = build({ record: killed() })
    expect(snapshot.finishedAt).toBe(null)
    expect(snapshot.ageMs).toBe(null)
    expect(snapshot.wallMs).toBe(null)
  })

  it('never throws, and invents nothing, for a partially written record', () => {
    const records = {
      'an empty object': {},
      'a status and nothing else': { status: 'success' },
      'the older format: a run id and a status': { status: 'success', run_id: RUN_ID },
      'a finish with no start': { status: 'success', run_id: RUN_ID, finished_at: RUN_FINISHED.toISOString() },
      'a start with no finish': { status: 'success', run_id: RUN_ID, started_at: RUN_STARTED.toISOString() },
      'an unparseable finish': { status: 'success', run_id: RUN_ID, finished_at: 'this morning' },
      'counts written as strings': { status: 'partial', run_id: RUN_ID, ok: '7', failed: '2' },
      'no record at all': null,
    }
    for (const [label, record] of Object.entries(records)) {
      let snapshot
      expect(() => {
        snapshot = buildPostMortem({ metricsText: '', record, queue: null, now: NOW })
      }, label).not.toThrow()
      for (const [field, value] of Object.entries(snapshot)) {
        if (typeof value === 'number') {
          expect(Number.isFinite(value), `${label}: ${field} = ${value}`).toBe(true)
        }
      }
      expect(() => renderPostMortem(snapshot), label).not.toThrow()
      expect(renderPostMortem(snapshot).join('\n'), label).not.toMatch(/NaN|Infinity|undefined/)
    }
  })

  it('holds the invariant every field is either null or finite, given hostile events', () => {
    const hostile = [
      'not an event at all',
      'RALPH_ISSUE_EVENT {"truncated":',
      'RALPH_ISSUE_EVENT []',
      'RALPH_ISSUE_EVENT null',
      tagged({ issue_number: 29, run_id: RUN_ID, verdict: 'pass', total_cost_usd: 1e308 }),
      tagged({ issue_number: 30, run_id: RUN_ID, verdict: 'pass', total_cost_usd: 1e308 }),
      tagged({ issue_number: 31, run_id: RUN_ID, verdict: 'fail', total_cost_usd: 'free' }),
      '',
    ].join('\n')
    const snapshot = build({ metricsText: hostile, record: killed() })
    for (const [field, value] of Object.entries(snapshot)) {
      if (typeof value === 'number') {
        expect(Number.isFinite(value), `${field} = ${value}`).toBe(true)
      }
    }
    // The three parseable rows still count, and the overflowing sum degrades to
    // unknown rather than printing `$Infinity total`.
    expect(snapshot.ok).toBe(2)
    expect(snapshot.failed).toBe(1)
    expect(snapshot.spendUsd).toBe(null)
    expect(snapshot.costPerTaskUsd).toBe(null)
  })

  it('reaches for no clock of its own', () => {
    const real = Date.now
    try {
      Date.now = () => {
        throw new Error('post-mortem.js reached for the ambient clock')
      }
      expect(build().ageMs).toBe((2 * 60 + 18) * MIN)
    } finally {
      Date.now = real
    }
  })

  it('is deterministic: same inputs, same snapshot, same lines', () => {
    const args = { metricsText: OVERNIGHT, record: terminal(), queue: 2, now: NOW }
    expect(buildPostMortem(args)).toEqual(buildPostMortem(args))
    expect(renderPostMortem(buildPostMortem(args))).toEqual(renderPostMortem(buildPostMortem(args)))
  })
})

describe('renderPostMortem — the report card (#59)', () => {
  it('renders the idle card: outcome, spend, wall clock, queue and the start hint', () => {
    expect(renderPostMortem(build())).toEqual([
      `▸ ralph — idle · run ${RUN_ID} (finished 06:12, 2h18m ago)`,
      '  outcome    7 ok · 2 failed  — #034 #041',
      '  spend      $268.10 total · $29.8/task avg',
      '  ran for    9h52m',
      '  queue      2 waiting',
      '',
      '  start      ralph start',
    ])
  })

  it('aligns its label column with the live view’s `  in flight  ` block', () => {
    // The two views are read minutes apart in the same terminal; a column that
    // shifted between them would read as a different command's output.
    for (const line of renderPostMortem(build()).filter((l) => l.startsWith('  '))) {
      // Two spaces, then an 11-wide label column, then the value — the same shape
      // `  queue      6 waiting` has had since #55.
      expect(line, line).toMatch(/^ {2}[a-z][a-z ]* {2,}\S/)
      expect(line.slice(13).startsWith(' '), `${line} — value column drifted`).toBe(false)
      expect(line.slice(2, 13).trimEnd().length, `${line} — label too wide`).toBeLessThan(11)
    }
  })

  it('prints NO failed list for a run that failed nothing', () => {
    // An empty `—` would read as a list the renderer forgot to fill in.
    const clean = [
      event({ n: 29, ts: 1 }),
      event({ n: 30, ts: 2 }),
    ].join('\n')
    const lines = renderPostMortem(build({ metricsText: clean, record: terminal({ ok: 7, failed: 0 }) }))
    expect(lines[1]).toBe('  outcome    7 ok · 0 failed')
    // Scoped to the outcome line: the heading's own `—` is a separator, not a list.
    expect(lines[1]).not.toContain('—')
    expect(lines[1]).not.toContain('#')
  })

  it('silences the failed list when the RECORD says nothing failed', () => {
    // The events these numbers came from predate the verdict field, so the tally read
    // them as failures — but the loop wrote `failed: 0` having watched the run, and
    // `0 failed  — #034 #041` would contradict itself on one line.
    const older = [
      tagged({ issue_number: 34, run_id: RUN_ID, ts: 1, total_cost_usd: 30 }),
      tagged({ issue_number: 41, run_id: RUN_ID, ts: 2, total_cost_usd: 30 }),
    ].join('\n')
    const snapshot = build({ metricsText: older, record: terminal({ ok: 2, failed: 0 }) })
    // The snapshot still carries the names — the suppression is a rendering decision,
    // so a document published later keeps the whole picture.
    expect(snapshot.failedNumbers).toEqual([34, 41])
    expect(renderPostMortem(snapshot)[1]).toBe('  outcome    2 ok · 0 failed')
  })

  it('marks an interrupted run and still lists what it completed before the kill', () => {
    const lines = renderPostMortem(build({ record: killed() }))
    expect(lines).toEqual([
      `▸ ralph — interrupted · run ${RUN_ID} (finished unknown)`,
      '  outcome    7 ok · 2 failed  — #034 #041',
      '  spend      $268.10 total · $29.8/task avg',
      // No finish, so no duration — never `now` standing in for one.
      '  ran for    unknown',
      '  queue      2 waiting',
      // ...and the two readings that replace them, both off the record: when the run
      // began (the only temporal anchor it has) and the task it died on.
      '  started    20:20, 12h10m ago',
      '  last task  #042',
      '',
      '  restart    ralph start',
    ])
    // The age on that line is measured from the START, so neither the finish nor the
    // duration may carry one.
    expect(lines[0]).not.toContain('ago')
    expect(lines[3]).not.toContain('ago')
  })

  it('anchors a killed run in time by its start when it has no finish to be anchored by', () => {
    // The card's `unknown` finish is honest and it is also useless on its own: a reader
    // who cannot tell a run killed five minutes ago from one killed last week cannot
    // decide whether to restart it. The start is on the record — the kill only cost the
    // finish — so the age of the START is the reading that answers them.
    for (const [label, { now, expected }] of Object.entries({
      'a run killed minutes ago': { now: RUN_STARTED.getTime() + 40 * MIN, expected: '40min ago' },
      'a run killed overnight': { now: NOW, expected: '12h10m ago' },
      'a run killed last week': { now: NOW + 7 * 24 * 60 * MIN, expected: '180h10m ago' },
    })) {
      const snapshot = build({ record: killed(), now })
      expect(snapshot.startedAt, label).toBe(RUN_STARTED.getTime())
      expect(snapshot.startedAgeMs, label).toBe(now - RUN_STARTED.getTime())
      expect(renderPostMortem(snapshot)[5], label).toBe(`  started    20:20, ${expected}`)
      // ...and none of it leaks into the duration, which nobody recorded.
      expect(renderPostMortem(snapshot)[3], label).toBe('  ran for    unknown')
    }
  })

  it('names the last task a killed run was on, and says unknown when the record cannot', () => {
    // `beginRun`/`recordTask` write `current` and a kill leaves it there, so this is
    // the task the loop died inside. Reported as the LAST task rather than as one in
    // flight: nothing is running, which is what makes the mode interrupted.
    expect(renderPostMortem(build({ record: killed() }))[6]).toBe('  last task  #042')
    expect(renderPostMortem(build({ record: killed({ current: { number: 7 } }) }))[6]).toBe(
      '  last task  #007',
    )
    for (const current of [null, undefined, {}, { number: 'x' }, { number: null }]) {
      const lines = renderPostMortem(build({ record: killed({ current }) }))
      expect(lines[6], JSON.stringify(current) ?? 'undefined').toBe('  last task  unknown')
    }
  })

  it('names a killed JIRA run by its ticket KEY, never by the number derived from it (#127)', () => {
    // Review's finding, and it is a MISREAD rather than a cosmetic one: `FOO-123`'s
    // derived number is 123, so a card printing `#123` names a task nobody can look up
    // — and in a repo that also has GitHub issues it reads as issue #123. The key is
    // what names the ticket on the board, so it is what names it here. Same rule the
    // live view applies (progress.js numberText), one command away.
    const jira = (current) => renderPostMortem(build({ record: killed({ source: 'jira', current }) }))[6]

    expect(jira({ number: 123, task_key: 'FOO-123' })).toBe('  last task  FOO-123')
    // A key the grammar cannot NUMBER still has a name worth printing: this row used to
    // read `unknown`, which is the card saying it does not know a ticket it recorded.
    expect(jira({ number: null, task_key: 'FOO-BAR-9' })).toBe('  last task  FOO-BAR-9')
    // Untrusted, exactly as in the live view: this string reached the record through
    // acli and bash, so a key carrying an escape or a forged second row is scrubbed
    // before it is drawn.
    const ESC = String.fromCharCode(0x1b)
    // MEASURED, both rows: the colour sequence is taken WHOLE (`[31m` does not survive
    // as text), and the forged row's newline plus its indent collapse to one space, so
    // the forgery lands inside this row instead of becoming a second one.
    expect(jira({ number: null, task_key: `FOO-1${ESC}[31m` })).toBe('  last task  FOO-1')
    expect(jira({ number: 9, task_key: `FOO-9${String.fromCharCode(0x0a)}  #999 pass` })).toBe(
      '  last task  FOO-9 #999 pass',
    )

    // AND THE GITHUB CARD IS UNTOUCHED — a record with no key still reads as a padded
    // issue number, which is every card written before #127 existed.
    for (const current of [{ number: 42 }, { number: 42, task_key: null }, { number: 42, task_key: '' }, { number: 42, task_key: 7 }]) {
      expect(jira(current), JSON.stringify(current)).toBe('  last task  #042')
    }
    // A record with neither is still `unknown`: nothing was recorded to name.
    expect(jira({ number: null, task_key: '   ' })).toBe('  last task  unknown')
  })

  it('keeps both extra readings OFF the card of a run that ended properly', () => {
    // A finished run already answers "when?" with its finish and its age, and the task
    // it last worked on is simply the one it finished. Two more rows would be noise on
    // the card a reader sees every morning.
    const lines = renderPostMortem(build())
    expect(lines.length).toBe(7)
    expect(lines.join('\n')).not.toContain('started')
    expect(lines.join('\n')).not.toContain('last task')
  })

  it('reads a finish beyond the calendar as unknown rather than formatting a NaN clock', () => {
    // A finite instant is not a spellable one: `Date` holds ±8.64e15 ms, and beyond that
    // `new Date(ms)` is an Invalid Date whose getters are all NaN. The stamps come from
    // JSON somebody else wrote, so the renderer treats an instant it cannot spell as
    // absent — the same `unknown` it prints for a stamp that was never there.
    for (const finishedAt of [8.7e15, 1e300, -8.7e15, Number.MAX_VALUE, 253402300800000]) {
      const lines = renderPostMortem({ ...build(), finishedAt })
      expect(lines[0], String(finishedAt)).toBe(`▸ ralph — idle · run ${RUN_ID} (finished unknown)`)
      expect(lines.join('\n'), String(finishedAt)).not.toMatch(/NaN|--:--/)
    }
    // The instants either side of the boundary still print, so the guard is a calendar
    // check and not a magnitude the card refuses.
    expect(renderPostMortem({ ...build(), finishedAt: 253402300799999 })[0]).not.toContain(
      'finished unknown',
    )
  })

  it('says unknown, never zero, for everything a partial record never recorded', () => {
    const lines = renderPostMortem(
      buildPostMortem({ metricsText: '', record: { status: 'success', run_id: RUN_ID }, queue: null, now: NOW }),
    )
    expect(lines).toEqual([
      `▸ ralph — idle · run ${RUN_ID} (finished unknown)`,
      '  outcome    unknown',
      '  spend      unknown',
      '  ran for    unknown',
      '  queue      unknown',
      '',
      '  start      ralph start',
    ])
    // The three readings a zero would lie about.
    expect(lines.join('\n')).not.toContain('0 ok')
    expect(lines.join('\n')).not.toContain('$0.00')
    expect(lines.join('\n')).not.toContain('0 waiting')
  })

  it('names an unnamed run `unknown` rather than printing a blank', () => {
    const lines = renderPostMortem(buildPostMortem({ record: { status: 'failed' }, now: NOW }))
    expect(lines[0]).toBe('▸ ralph — idle · run unknown (finished unknown)')
  })

  it('renders a REAL empty queue as `0 waiting`', () => {
    // The one zero that is a measurement rather than a stand-in: the queue drained.
    expect(renderPostMortem(build({ queue: 0 }))).toContain('  queue      0 waiting')
  })

  it('pads the failed numbers to three digits, in file order, wider ones intact', () => {
    const rows = [
      event({ n: 7, ts: 1, verdict: 'fail' }),
      event({ n: 1234, ts: 2, verdict: 'fail' }),
      event({ n: 41, ts: 3, verdict: 'fail' }),
    ].join('\n')
    const lines = renderPostMortem(build({ metricsText: rows, record: killed() }))
    expect(lines[1]).toBe('  outcome    0 ok · 3 failed  — #007 #1234 #041')
  })

  it('clamps a finish recorded before the start to 0min rather than a negative run', () => {
    // Clock skew between the two stamps, or a record written by two machines.
    const skewed = terminal({ finished_at: new Date(2026, 7, 25, 19, 20, 0).toISOString() })
    const lines = renderPostMortem(build({ record: skewed }))
    expect(lines).toContain('  ran for    0min')
    expect(lines.join('\n')).not.toMatch(/-\d+(min|h)/)
  })

  it('degrades to a card, not a throw, when handed no snapshot at all', () => {
    for (const snapshot of [undefined, null, {}]) {
      expect(() => renderPostMortem(snapshot), JSON.stringify(snapshot)).not.toThrow()
      const lines = renderPostMortem(snapshot)
      expect(lines.at(-1), JSON.stringify(snapshot)).toContain('ralph start')
      expect(lines.join('\n'), JSON.stringify(snapshot)).not.toMatch(/NaN|undefined|Invalid Date/)
    }
  })
})

// The same source-text braces progress.js wears, for the same reason: "pure" is a
// promise about what the module CANNOT do, and the injected `now` above only proves
// it did not reach for a clock on the paths these tests walk.
describe('post-mortem.js — PURE, with no exceptions (#59)', () => {
  const SOURCE = readFileSync(new URL('./post-mortem.js', import.meta.url), 'utf8')
  // The module's prose names `Date.now` and `fs` to promise it does not use them, so
  // the assertions run against the source with comments stripped — otherwise the
  // promise itself would fail the test that checks the promise.
  const CODE = SOURCE.split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line.replace(/\s\/\/.*$/, '')))
    .join('\n')

  it('imports only the shared policy from progress.js', () => {
    // One edge, and it points at the other pure module — never at the I/O shell,
    // which imports this one (that would be a cycle) and never at node itself.
    const imports = CODE.match(/^\s*import\s[\s\S]*?from ['"](.+)['"]/gm) ?? []
    expect(imports.length).toBe(1)
    expect(imports[0]).toContain("from './progress.js'")
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
      /execa|spawn|(?<![.\w])exec\(/,
      /\bnew Date\(\s*\)/, // `new Date(ms)` is a formatter; `new Date()` is a clock
      /Math\.random/,
    ]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden)
    }
  })
})
