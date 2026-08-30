import { describe, it, expect } from 'vitest'
import { buildProgress, renderProgress, toJsonSnapshot } from './progress.js'

// #58 — the JSON projection of the snapshot. What is under test here is NOT a
// second serializer: `toJsonSnapshot` takes the exact object `renderProgress`
// takes, and every assertion below is written to fail the moment the projection
// starts computing a number of its own instead of reading one off the snapshot.
//
// Three properties, and the whole file is those three:
//
//   1. THE SCHEMA IS A CONTRACT. A shell prompt or a status line is written once
//      against these keys and then runs for months, so the top-level keys and
//      each section's keys are pinned by VALUE with toEqual — not probed with
//      toHaveProperty, which would let a rename slip through as an addition.
//   2. THE UNKNOWN DISCIPLINE SURVIVES SERIALIZATION. `null` is the only way this
//      surface says "I do not know": never `0` (which reads as a free run or an
//      empty queue) and never an absent key. The absent-key half needs its own
//      assertion because JSON.stringify DROPS `undefined` leaves silently, so a
//      projection that reads a misspelled snapshot field would emit a document
//      that is missing the key rather than one that says null.
//   3. IT IS DRIVEN BY THE SNAPSHOT, not by the metrics file. There is a test
//      below that hands over a snapshot no buildProgress ever produced, and the
//      document has to follow it.
//
// Hermetic like the rest of the progress suite: local Date constructors for the
// fixtures, an injected `now`, and the expected ISO strings derived from those
// same Date objects so the assertions hold in any timezone.

const MIN = 60000
const RUN = 'ralph-ralph-b36ff7b1'

const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime() // 40min into #031

// The document's ISO fields are UTC to the SECOND, so the expectations are built
// from the same Date objects the fixtures are — never from a hand-written literal,
// which would pin the suite to one timezone.
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

const event = ({ number = 1, run = RUN, minutes = null, cost = null, verdict = 'pass', ts = 1 } = {}) => ({
  issue_number: number,
  run_id: run,
  ts,
  duration_ms: minutes == null ? null : minutes * MIN,
  total_cost_usd: cost,
  verdict,
})

const jsonl = (...events) =>
  events.map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e)).join('\n') + '\n'

// The issue's worked example: #029 97min/$34.10, #030 71min/$28.75, #031 in flight
// 40min, 6 waiting. Pace 84 min/task, ETA 548min, ±91min, $62.85 spent.
const WORKED_EXAMPLE = jsonl(
  event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
  event({ number: 30, minutes: 71, cost: 28.75, ts: 2 }),
)

const inFlightRecord = (overrides = {}) => ({
  run_id: RUN,
  queue_at_start: 8,
  current: { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 1 },
  ...overrides,
})

// One snapshot, projected once — the same call shape statusCommand makes.
const project = ({ mode = 'running', record = inFlightRecord(), ...overrides } = {}) =>
  toJsonSnapshot(
    buildProgress({ metricsText: WORKED_EXAMPLE, record, queue: 6, now: NOW, ...overrides }),
    { mode, record },
  )

describe('toJsonSnapshot — the schema is the contract (#58)', () => {
  it('emits the mode discriminator, the run id and the six sections, and nothing else', () => {
    const doc = project()
    // `digest` (#63) is LAST, appended: a published document grows at the end, so a
    // consumer diffing two versions of it reads one added key rather than a reorder.
    expect(Object.keys(doc)).toEqual([
      'mode',
      'run_id',
      'progress',
      'tasks',
      'pace',
      'eta',
      'spend',
      'digest',
    ])
  })

  it('pins the keys of every section', () => {
    const doc = project()
    expect(Object.keys(doc.progress)).toEqual(['completed', 'in_flight', 'remaining', 'total'])
    expect(Object.keys(doc.tasks)).toEqual(['current'])
    // `task_key` (#132) is appended for the same reason `digest` was: the document
    // grows at the end, so a consumer reading it positionally is undisturbed.
    expect(Object.keys(doc.tasks.current)).toEqual(['number', 'started_at', 'task_key'])
    expect(Object.keys(doc.pace)).toEqual([
      'basis',
      'per_task_min',
      'fastest_min',
      'slowest_min',
      'samples',
    ])
    expect(Object.keys(doc.eta)).toEqual(['remaining_min', 'finish_at', 'range_min', 'basis'])
    expect(Object.keys(doc.spend)).toEqual(['usd', 'per_task_usd', 'projected_usd'])
  })

  it('projects the issue’s worked example, section by section', () => {
    const doc = project()
    expect(doc.mode).toBe('running')
    expect(doc.run_id).toBe(RUN)
    expect(doc.progress).toEqual({ completed: 2, in_flight: 1, remaining: 6, total: 9 })
    expect(doc.tasks.current).toEqual({
      number: 31,
      started_at: isoSeconds(TASK_STARTED.getTime()),
      // The worked example is a GitHub run, so it has no Jira key to publish and the
      // leaf is present-and-null (#132) rather than absent. `null` here is a fact
      // about the run — "this task is named by its number" — not a failed lookup.
      task_key: null,
    })
    expect(doc.pace).toEqual({
      basis: 'last3-in-run',
      per_task_min: 84,
      fastest_min: 71,
      slowest_min: 97,
      samples: 2,
    })
    expect(doc.eta).toEqual({
      remaining_min: 548,
      finish_at: isoSeconds(NOW + 548 * MIN),
      // 548 ± 91, the honest band — see the range_min block below.
      range_min: [457, 639],
      basis: 'last3-in-run',
    })
    expect(doc.spend.usd).toBeCloseTo(62.85, 5)
    expect(doc.spend.per_task_usd).toBeCloseTo(31.425, 5)
    expect(doc.spend.projected_usd).toBeCloseTo(251.4, 5)
  })

  it('emits money as raw numbers, leaving the rounding to whoever is reading', () => {
    // The human line prints `~$250 projected` on a coarse grid because cents are
    // noise to a reader; a machine consumer gets the figure and rounds it itself.
    const { spend } = project()
    for (const value of Object.values(spend)) expect(typeof value).toBe('number')
    expect(spend.projected_usd).not.toBe(250)
  })

  it('survives a round trip through JSON with every key intact', () => {
    // The absent-key trap: JSON.stringify silently DROPS an `undefined` leaf, so a
    // projection reading a misspelled snapshot field would emit a document missing
    // the key rather than one saying null. Round-tripping catches it.
    const doc = project()
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc)
  })
})

describe('toJsonSnapshot — one shape for all four modes (#58)', () => {
  const KEYS = ['mode', 'run_id', 'progress', 'tasks', 'pace', 'eta', 'spend', 'digest']

  it('carries the mode verbatim as the top-level discriminator', () => {
    for (const mode of ['running', 'interrupted', 'idle', 'never-run']) {
      expect(project({ mode }).mode, mode).toBe(mode)
    }
  })

  it('emits the same keys for a mode that measured nothing as for one that measured everything', () => {
    // idle and never-run read no metrics file and count no queue, so the shell
    // hands over a snapshot built from nothing. The document must not shrink.
    const blind = toJsonSnapshot(
      buildProgress({ metricsText: '', record: null, queue: null, now: NOW }),
      { mode: 'never-run', record: null },
    )
    expect(Object.keys(blind)).toEqual(KEYS)
    expect(Object.keys(blind.pace)).toEqual(Object.keys(project().pace))
    expect(Object.keys(blind.eta)).toEqual(Object.keys(project().eta))
    expect(Object.keys(blind.spend)).toEqual(Object.keys(project().spend))
    expect(Object.keys(blind.progress)).toEqual(Object.keys(project().progress))
    expect(Object.keys(blind.tasks)).toEqual(Object.keys(project().tasks))
  })

  it('has no run id and nothing in flight when there is no record at all', () => {
    const doc = toJsonSnapshot(
      buildProgress({ metricsText: '', record: null, queue: null, now: NOW }),
      { mode: 'never-run', record: null },
    )
    expect(doc.run_id).toBe(null)
    expect(doc.tasks.current).toBe(null)
  })

  it('names the run even when nothing about it was measured', () => {
    // The idle line prints the last run's id, and a consumer keyed on run identity
    // needs it in every mode the record survives into.
    const record = { run_id: RUN, status: 'partial', current: { number: 31 } }
    const doc = toJsonSnapshot(
      buildProgress({ metricsText: '', record: null, queue: null, now: NOW }),
      { mode: 'idle', record },
    )
    expect(doc.run_id).toBe(RUN)
  })

  it('reports a run id that came back as a number as a string, never as two types', () => {
    const record = inFlightRecord({ run_id: 20260826 })
    expect(project({ record }).run_id).toBe('20260826')
  })

  it('has no run id for one that cannot name a run', () => {
    for (const run_id of [null, undefined, '', {}, [], NaN]) {
      expect(project({ record: inFlightRecord({ run_id }) }).run_id, String(run_id)).toBe(null)
    }
  })
})

describe('toJsonSnapshot — unknown is null, never 0 and never absent (#58)', () => {
  // Every leaf that can be unknown, by section and key, so a failure names the
  // field rather than dumping a diff of the whole document.
  const UNKNOWABLE = [
    ['pace', 'per_task_min'],
    ['pace', 'fastest_min'],
    ['pace', 'slowest_min'],
    ['eta', 'remaining_min'],
    ['eta', 'finish_at'],
    ['eta', 'range_min'],
    ['spend', 'usd'],
    ['spend', 'per_task_usd'],
    ['spend', 'projected_usd'],
  ]

  it('says null for every pace, ETA and cost a run with no history cannot know', () => {
    const blind = project({ metricsText: '', queue: null })
    const parsed = JSON.parse(JSON.stringify(blind))
    expect(parsed).toEqual(blind) // nothing dropped on the way out
    for (const [section, key] of UNKNOWABLE) {
      expect(parsed[section], `${section}.${key} must be present`).toHaveProperty(key)
      expect(parsed[section][key], `${section}.${key} must be null, not ${parsed[section][key]}`).toBe(
        null,
      )
    }
  })

  it('keeps the basis a named string rather than a null, since it has an unknown of its own', () => {
    const blind = project({ metricsText: '' })
    expect(blind.pace.basis).toBe('unknown')
    expect(blind.eta.basis).toBe('unknown')
  })

  it('says unknown, not zero, for a costless run that still has a pace', () => {
    const doc = project({
      metricsText: jsonl(
        event({ number: 29, minutes: 97, cost: 0, ts: 1 }),
        event({ number: 30, minutes: 71, cost: null, ts: 2 }),
      ),
    })
    expect(doc.spend).toEqual({ usd: null, per_task_usd: null, projected_usd: null })
    expect(doc.pace.per_task_min).toBe(84)
  })

  it('says unknown for the ETA but keeps the spend when the queue count failed', () => {
    const doc = project({ queue: null })
    expect(doc.progress).toEqual({ completed: 2, in_flight: 1, remaining: null, total: null })
    expect(doc.eta).toEqual({
      remaining_min: null,
      finish_at: null,
      range_min: null,
      basis: 'last3-in-run',
    })
    expect(doc.pace.per_task_min).toBe(84)
    expect(doc.spend.usd).toBeCloseTo(62.85, 5)
    expect(doc.spend.projected_usd).toBe(null)
  })

  it('never emits a non-finite number, whatever the file’s magnitudes', () => {
    // JSON.stringify turns Infinity and NaN into a bare `null`, which would look
    // like an honest unknown while actually being an overflow nobody noticed. The
    // snapshot's own guards are what prevent it, and this pins that they hold
    // through the projection.
    const overflow = [
      `RALPH_ISSUE_EVENT {"run_id":"${RUN}","ts":1,"duration_ms":1e308,"total_cost_usd":1e308}`,
      `RALPH_ISSUE_EVENT {"run_id":"${RUN}","ts":2,"duration_ms":1e308,"total_cost_usd":1e308}`,
    ].join('\n')
    const doc = project({ metricsText: overflow, queue: Number.MAX_VALUE })
    const text = JSON.stringify(doc)
    expect(text).not.toContain('Infinity')
    expect(text).not.toContain('NaN')
    expect(JSON.parse(text)).toEqual(doc)
  })
})

// #63 — the digest section. Same discipline as every other section: the projection
// reads a view the digest module built and computes nothing of its own, and the key
// is ALWAYS present so a consumer writes `.digest` once and it resolves in every
// mode.
describe('toJsonSnapshot — the digest section (#63)', () => {
  const DIGEST_AT = new Date(2026, 7, 25, 19, 20, 0).getTime() // 12min before NOW
  const digestView = (overrides = {}) => ({
    atMs: DIGEST_AT,
    ageMs: NOW - DIGEST_AT,
    model: 'claude-haiku-4-5',
    task: '#031',
    stale: false,
    narrative: 'two paragraphs\n\nof narration',
    ...overrides,
  })

  const withDigest = (digest) => {
    const record = inFlightRecord()
    return toJsonSnapshot(
      buildProgress({ metricsText: WORKED_EXAMPLE, record, queue: 6, now: NOW }),
      { mode: 'running', record, digest },
    )
  }

  it('publishes the instant, the age, the model, the task, the staleness and the text', () => {
    const doc = withDigest(digestView())
    expect(Object.keys(doc.digest)).toEqual(['at', 'age_min', 'model', 'task', 'stale', 'text'])
    expect(doc.digest).toEqual({
      at: isoSeconds(DIGEST_AT),
      age_min: 12,
      model: 'claude-haiku-4-5',
      task: '#031',
      stale: false,
      // The RAW narrative, not the wrapped block the terminal prints: a document is
      // not 64 columns wide.
      text: 'two paragraphs\n\nof narration',
    })
  })

  it('is present and null when there is no digest for this run', () => {
    for (const digest of [undefined, null]) {
      const doc = withDigest(digest)
      expect(doc, String(digest)).toHaveProperty('digest')
      expect(doc.digest, String(digest)).toBe(null)
      expect(JSON.parse(JSON.stringify(doc)), String(digest)).toEqual(doc)
    }
  })

  it('carries the staleness the view judged, rather than judging it again', () => {
    expect(withDigest(digestView({ stale: true })).digest.stale).toBe(true)
  })

  it('says null for every leaf the entry could not supply, never 0 and never absent', () => {
    const doc = withDigest(digestView({ atMs: null, ageMs: null, model: null, task: null }))
    expect(JSON.parse(JSON.stringify(doc.digest))).toEqual({
      at: null,
      age_min: null,
      model: null,
      task: null,
      // `stale` goes null WITH the age it is a verdict about: `false` beside
      // `age_min: null` would tell a consumer "fresh" when the answer is "cannot say",
      // which is the same lie a `0` would be for a duration. The unknown discipline
      // outranks the leaf's type.
      stale: null,
      text: 'two paragraphs\n\nof narration',
    })
  })

  it('never publishes a staleness verdict without the age it was judged from', () => {
    // Tied to the PUBLISHED `age_min`, not to the view's own flag, so the two leaves
    // cannot disagree — a view claiming `stale: true` with no readable clock still
    // reports `null` rather than a verdict nothing supports.
    for (const stale of [true, false]) {
      const doc = withDigest(digestView({ ageMs: null, stale }))
      expect(doc.digest.age_min, String(stale)).toBe(null)
      expect(doc.digest.stale, String(stale)).toBe(null)
    }
    // ...and a readable age still publishes a boolean, never null.
    expect(withDigest(digestView({ ageMs: 0 })).digest.stale).toBe(false)
  })

  it('says null for an instant outside the calendar rather than an expanded year', () => {
    // Transcribed, like `tasks.current.started_at`: the stamp came off disk, so an
    // instant `fromdate` cannot parse is reported as unknown rather than clamped.
    expect(withDigest(digestView({ atMs: 8.7e15 })).digest.at).toBe(null)
  })
})

describe('toJsonSnapshot — the ETA range (#58)', () => {
  // The issue's example shows `spread_min: [71, 97]`, which are the observed
  // per-task extremes. Those live in `pace` (fastest_min/slowest_min), because on
  // the ETA the useful pair is the FINISH range: what the estimate becomes if every
  // task still ahead runs at one extreme instead of the mean.
  //
  // And the key is `range_min`, not the issue's `spread_min`: this repo already uses
  // "spread" for the ± delta the human line prints as `(±1h30m)`, and these are the
  // two absolute endpoints instead.
  it('is the ETA ± the snapshot’s spread, ascending, in whole minutes', () => {
    const doc = project()
    expect(doc.eta.remaining_min).toBe(548)
    expect(doc.eta.range_min).toEqual([457, 639])
    expect(doc.eta.range_min[0]).toBeLessThanOrEqual(doc.eta.remaining_min)
    expect(doc.eta.range_min[1]).toBeGreaterThanOrEqual(doc.eta.remaining_min)
  })

  it('leaves the observed per-task extremes in the pace section, where they were measured', () => {
    const { pace } = project()
    expect([pace.fastest_min, pace.slowest_min]).toEqual([71, 97])
  })

  it('floors the low end at zero rather than promising a finish in the past', () => {
    // Two wildly disagreeing samples: the low end of the band lands below zero and
    // must clamp, because the queue cannot finish before now.
    const doc = project({ metricsText: jsonl(event({ number: 29, minutes: 2, ts: 1 }), event({ number: 30, minutes: 200, ts: 2 })), queue: 1 })
    expect(doc.eta.range_min[0]).toBe(0)
    expect(doc.eta.range_min[1]).toBeGreaterThan(doc.eta.remaining_min)
  })

  it('is a band of two equal ends — not an omission — when the samples agree', () => {
    const doc = project({ metricsText: jsonl(event({ number: 29, minutes: 84, ts: 1 }), event({ number: 30, minutes: 84, ts: 2 })) })
    expect(doc.eta.range_min).toEqual([doc.eta.remaining_min, doc.eta.remaining_min])
  })

  it('is null when the ETA or the spread is unknown', () => {
    expect(project({ queue: null }).eta.range_min).toBe(null)
    expect(project({ metricsText: '' }).eta.range_min).toBe(null)
  })
})

describe('toJsonSnapshot — the wall-clock finish as ISO-8601 UTC (#58)', () => {
  it('is UTC to the second, so `jq fromdate` can read it', () => {
    // jq's fromdate parses `%Y-%m-%dT%H:%M:%SZ` and FAILS on a fractional second,
    // and a finish time carrying a ± of an hour and a half has no business
    // claiming milliseconds anyway.
    const { finish_at } = project().eta
    expect(finish_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(Date.parse(finish_at)).toBe(NOW + 548 * MIN)
  })

  it('is the same instant the human line renders as a wall clock', () => {
    const snapshot = buildProgress({
      metricsText: WORKED_EXAMPLE,
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    const doc = toJsonSnapshot(snapshot, { mode: 'running', record: inFlightRecord() })
    expect(Date.parse(doc.eta.finish_at)).toBe(snapshot.finishAt)
    // ...and that instant is the one the pure renderer put on the eta line.
    const local = new Date(snapshot.finishAt)
    const clock = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`
    expect(renderProgress(snapshot)[1]).toContain(`→ ~${clock}`)
  })

  it('saturates a finish time past the end of the calendar instead of throwing', () => {
    // `new Date(ms).toISOString()` throws outside ±8.64e15 ms and emits an
    // expanded year (`+024208-...`) for anything past year 9999 — and a corrupt
    // issues.jsonl reaches both long before it overflows a double. A read-only
    // view may not throw, and `jq fromdate` refuses the expanded form, so the
    // instant saturates at the edge of the shape every consumer was promised.
    // `remaining_min` beside it still carries the real magnitude.
    for (const finishAt of [1e16, 1e308, 2.6e14]) {
      const doc = toJsonSnapshot({ etaMs: finishAt, finishAt, spreadMs: 0 }, { mode: 'running' })
      expect(doc.eta.finish_at, `finishAt = ${finishAt}`).toBe('9999-12-31T23:59:59Z')
      expect(doc.eta.remaining_min, `finishAt = ${finishAt}`).not.toBe(null)
    }
    // Symmetric at the other end: an instant before year 0000 saturates there.
    const before = toJsonSnapshot({ etaMs: 0, finishAt: -1e16, spreadMs: 0 }, { mode: 'running' })
    expect(before.eta.finish_at).toBe('0000-01-01T00:00:00Z')
  })

  it('normalizes the in-flight task’s start the same way, and drops an unreadable one', () => {
    expect(project().tasks.current.started_at).toBe(isoSeconds(TASK_STARTED.getTime()))
    for (const started_at of ['yesterday', '', null, undefined]) {
      const record = inFlightRecord({ current: { number: 31, started_at } })
      expect(project({ record }).tasks.current, String(started_at)).toEqual({
        number: 31,
        started_at: null,
        task_key: null,
      })
    }
  })
})

describe('toJsonSnapshot — the in-flight task is named only when one is counted (#58)', () => {
  it('is null when the run has not begun a task', () => {
    const doc = project({ record: inFlightRecord({ current: null }) })
    expect(doc.progress.in_flight).toBe(0)
    expect(doc.tasks.current).toBe(null)
  })

  it('never contradicts the count the denominator used', () => {
    // `progress.in_flight` is the 0-or-1 the total is built from; `tasks.current`
    // names that task. They are read off the same snapshot field, so a document
    // saying "0 in flight" can never also name a task in flight.
    for (const record of [
      inFlightRecord(),
      inFlightRecord({ current: null }),
      inFlightRecord({ current: {} }),
      inFlightRecord({ current: 'issue 31' }),
    ]) {
      const doc = project({ record })
      expect(Boolean(doc.tasks.current), JSON.stringify(record.current)).toBe(
        doc.progress.in_flight === 1,
      )
    }
  })

  it('degrades a task number that is not a number to null, never to garbage', () => {
    for (const current of [{ started_at: TASK_STARTED.toISOString() }, 'issue 31', [31], {}]) {
      const doc = project({ record: inFlightRecord({ current }) })
      expect(doc.tasks.current.number, JSON.stringify(current)).toBe(null)
    }
  })
})

describe('toJsonSnapshot — a projection, not a second computation (#58)', () => {
  it('follows a snapshot no buildProgress produced', () => {
    // The property the whole slice turns on: the document is a projection of the
    // object it is handed. Hand over numbers that no metrics file could have
    // produced and the document must still be built from them.
    const doc = toJsonSnapshot(
      {
        paceBasis: 'all-time',
        paceMs: 10 * MIN,
        paceMinMs: 5 * MIN,
        paceMaxMs: 15 * MIN,
        samples: 7,
        completed: 4,
        inFlight: 0,
        remaining: 3,
        total: 7,
        etaMs: 30 * MIN,
        finishAt: NOW + 30 * MIN,
        spreadMs: 10 * MIN,
        spendUsd: 9.5,
        costPerTaskUsd: 2.375,
        projectedUsd: 16.625,
      },
      { mode: 'interrupted', record: { run_id: 'hand-built' } },
    )
    expect(doc.pace).toEqual({
      basis: 'all-time',
      per_task_min: 10,
      fastest_min: 5,
      slowest_min: 15,
      samples: 7,
    })
    expect(doc.eta.remaining_min).toBe(30)
    expect(doc.eta.range_min).toEqual([20, 40])
    expect(doc.progress).toEqual({ completed: 4, in_flight: 0, remaining: 3, total: 7 })
    expect(doc.spend).toEqual({ usd: 9.5, per_task_usd: 2.375, projected_usd: 16.625 })
  })

  it('reads nothing but the snapshot: no metrics text reaches it', () => {
    // Same call, twice, with the metrics file the snapshot came from thrown away.
    const snapshot = buildProgress({
      metricsText: WORKED_EXAMPLE,
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    expect(toJsonSnapshot(snapshot, { mode: 'running', record: inFlightRecord() })).toEqual(
      toJsonSnapshot(snapshot, { mode: 'running', record: inFlightRecord() }),
    )
  })

  it('mutates neither the snapshot nor the record', () => {
    const snapshot = buildProgress({
      metricsText: WORKED_EXAMPLE,
      record: inFlightRecord(),
      queue: 6,
      now: NOW,
    })
    const record = inFlightRecord()
    const before = [JSON.stringify(snapshot), JSON.stringify(record)]
    toJsonSnapshot(snapshot, { mode: 'running', record })
    expect([JSON.stringify(snapshot), JSON.stringify(record)]).toEqual(before)
  })

  it('survives a snapshot it did not build, the way renderProgress does', () => {
    // Exported on its own, so a caller handing over nothing must get the shape
    // with null leaves rather than an exception.
    for (const snapshot of [undefined, null, {}]) {
      let doc
      expect(() => {
        doc = toJsonSnapshot(snapshot, { mode: 'running' })
      }, String(snapshot)).not.toThrow()
      expect(Object.keys(doc), String(snapshot)).toEqual([
        'mode',
        'run_id',
        'progress',
        'tasks',
        'pace',
        'eta',
        'spend',
        'digest',
      ])
      expect(doc.eta, String(snapshot)).toEqual({
        remaining_min: null,
        finish_at: null,
        range_min: null,
        basis: 'unknown',
      })
    }
  })

  it('says nothing about the mode it was not told', () => {
    expect(toJsonSnapshot(buildProgress({}), {}).mode).toBe(null)
    expect(toJsonSnapshot(buildProgress({})).mode).toBe(null)
  })
})
