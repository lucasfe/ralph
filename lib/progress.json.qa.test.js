import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildProgress, toJsonSnapshot } from './progress.js'

// QA augmentation for #58. The dev's progress.json.test.js pins the schema by
// value, the ETA band arithmetic and the happy-path projection. What is attacked
// here is the ONE invariant the document lives or dies by, from the hostile side:
//
//   EVERY LEAF OF THE DOCUMENT IS EITHER A VALUE OR `null`. Never `0` standing in
//   for absent (a consumer reads `0` as "free run" or "empty queue"), never
//   `Infinity`/`NaN` (which JSON.stringify silently launders into a bare `null`
//   that looks like an honest unknown), and never an ABSENT KEY (which
//   JSON.stringify does to an `undefined` leaf, so a projection reading a
//   misspelled snapshot field emits a document missing the key instead of one
//   saying null). A shell prompt written once against `.eta.finish_at` runs for
//   months, so the key has to resolve in every mode and for every wrecked input.
//
// So this file does not check one document; it WALKS every leaf of ~30 documents
// projected from hostile-but-reachable inputs — a truncated issues.jsonl, an array
// payload, a `duration_ms` that is a string / negative / `-0` / `1e308`, a
// five-figure queue against a real pace, a record that is an array or a bare
// string, an unparseable or future `started_at`, an unusable `now` — and asserts
// the leaf contract on the PRE-STRINGIFY object as well as after a round trip.
// Asserting only the round-tripped copy would miss exactly the two defects that
// matter, because stringify hides both.
//
// The other half is the anti-drift property: the document is a PROJECTION, so it
// must not be able to compute a number of its own. That is pinned by value in the
// dev's file and by a source-purity grep at the bottom of this one — `toJsonSnapshot`
// may not mention the metrics text, the event tag or the parser.
//
// Hermetic like the rest of the progress suite: the module is pure, so every input
// is injected, and the expected ISO strings are derived from the same Date objects
// the fixtures are so the assertions hold in any timezone.

const MIN = 60000
const RUN = 'ralph-ralph-b36ff7b1'
const OTHER_RUN = 'ralph-ralph-0badf00d'

const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime() // 40min into #031

// `digest` (#63) is the section this file's projections never populate — it is handed
// in, not derived, and nothing here hands one in — so it is pinned as the key that
// must be PRESENT and null in every mode, which is the half of the contract that
// matters to a consumer writing `.digest` once.
const TOP_KEYS = ['mode', 'run_id', 'progress', 'tasks', 'pace', 'eta', 'spend', 'digest']
const SECTION_KEYS = {
  progress: ['completed', 'in_flight', 'remaining', 'total'],
  tasks: ['current'],
  pace: ['basis', 'per_task_min', 'fastest_min', 'slowest_min', 'samples'],
  eta: ['remaining_min', 'finish_at', 'range_min', 'basis'],
  spend: ['usd', 'per_task_usd', 'projected_usd'],
}

// The only leaves that may be strings. Everything else in the document is a number
// or null, and a string arriving anywhere else means a raw record field was copied
// through without being typed.
const STRING_LEAVES = new Set([
  'mode',
  'run_id',
  'pace.basis',
  'eta.basis',
  'eta.finish_at',
  'tasks.current.started_at',
])

// The shape `jq`'s `fromdate` parses: `%Y-%m-%dT%H:%M:%SZ`, four-digit year, no
// fractional second, no sign. jq errors out on anything else.
const JQ_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

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
const rawRow = (fields) => tagged(`{"issue_number":29,"run_id":"${RUN}","ts":1,${fields}}`)

// The issue's worked example — #029 97min/$34.10, #030 71min/$28.75 — the default
// fixture, so every degradation below is measured against a run that DOES have a
// pace and a spend to lose.
const WORKED = jsonl(
  event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
  event({ number: 30, minutes: 71, cost: 28.75, ts: 2 }),
)

const inFlightRecord = (overrides = {}) => ({
  run_id: RUN,
  status: 'running',
  queue_at_start: 8,
  current: { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 1 },
  ...overrides,
})

// One snapshot, projected once — the same two calls statusCommand makes, in the
// same order, with the same record handed to both.
const project = ({ mode = 'running', record = inFlightRecord(), ...overrides } = {}) => {
  const snapshot = buildProgress({
    metricsText: WORKED,
    record,
    queue: 6,
    now: NOW,
    ...overrides,
  })
  return toJsonSnapshot(snapshot, { mode, record })
}

// Every leaf of the document as `path -> value`, with array elements flattened
// (`eta.range_min[0]`) so the band's ends are held to the same contract as any
// other number. Object.entries keeps a key whose value is `undefined`, which is
// the point: that is the leaf JSON.stringify would drop.
function leaves(value, path = '', out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${path}[${i}]`, out))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) leaves(v, path ? `${path}.${key}` : key, out)
  } else {
    out.push([path, value])
  }
  return out
}

// The whole leaf contract, applied to the object BEFORE it is serialized and again
// after a round trip. `label` names the input so a failure reads as a diagnosis
// rather than a diff of the whole document.
function expectLeafContract(doc, label) {
  expect(Object.keys(doc), `${label}: top-level keys`).toEqual(TOP_KEYS)
  for (const [section, keys] of Object.entries(SECTION_KEYS)) {
    expect(Object.keys(doc[section]), `${label}: ${section} keys`).toEqual(keys)
  }
  if (doc.tasks.current !== null) {
    expect(Object.keys(doc.tasks.current), `${label}: tasks.current keys`).toEqual([
      'number',
      'started_at',
    ])
  }

  for (const [path, value] of leaves(doc)) {
    expect(value, `${label}: ${path} is undefined — stringify would DROP the key`).not.toBe(undefined)
    if (typeof value === 'number') {
      expect(
        Number.isFinite(value),
        `${label}: ${path} = ${value} — stringify launders it into a fake null`,
      ).toBe(true)
      expect(Object.is(value, -0), `${label}: ${path} is -0, which round-trips to 0`).toBe(false)
    } else if (typeof value === 'string') {
      expect(STRING_LEAVES.has(path), `${label}: ${path} is a string ("${value}")`).toBe(true)
    } else {
      expect(value, `${label}: ${path} = ${String(value)} is neither number, string nor null`).toBe(
        null,
      )
    }
  }

  // The round trip is the consumer's actual view of the document, and it is the
  // only way to catch a dropped `undefined` leaf. The pre-stringify assertions
  // above are what catch the non-finite one, which stringify would hide.
  const text = JSON.stringify(doc)
  expect(text, `${label}: raw Infinity in the text`).not.toContain('Infinity')
  expect(text, `${label}: raw NaN in the text`).not.toContain('NaN')
  expect(JSON.parse(text), `${label}: survives a round trip unchanged`).toEqual(doc)
}

// Hostile-but-reachable inputs. issues.jsonl is untrusted append-only text a killed
// run can leave half-written, run-state.json is JSON somebody else wrote, and the
// queue depth is whatever a subprocess printed.
const HOSTILE = {
  'the worked example': {},
  'no history at all': { metricsText: '' },
  'a metrics file of pure junk': { metricsText: 'RALPH_ISSUE_EVENT {\n\n???\n' },
  'a last line truncated mid-append': {
    metricsText: WORKED + tagged(`{"issue_number":31,"run_id":"${RUN}"`),
  },
  'a JSON array payload': { metricsText: tagged('[{"duration_ms":999999999}]') + '\n' + WORKED },
  'a JSON string payload': { metricsText: tagged('"x"') + '\n' + WORKED },
  'a JSON null payload': { metricsText: tagged('null') + '\n' + WORKED },
  'duration_ms as a string of digits': { metricsText: rawRow('"duration_ms":"5820000"') },
  'a negative duration_ms': { metricsText: rawRow('"duration_ms":-5820000') },
  'duration_ms as -0': { metricsText: rawRow('"duration_ms":-0') },
  'duration_ms at 1e308, whose product with the queue overflows': {
    metricsText: [rawRow('"duration_ms":1e308'), tagged(`{"run_id":"${RUN}","ts":2,"duration_ms":1e308}`)].join('\n'),
  },
  'total_cost_usd as a string': { metricsText: rawRow(`"duration_ms":${84 * MIN},"total_cost_usd":"34.10"`) },
  'two costs that overflow their own sum': {
    metricsText: [
      rawRow(`"duration_ms":${97 * MIN},"total_cost_usd":1e308`),
      tagged(`{"run_id":"${RUN}","ts":2,"duration_ms":${71 * MIN},"total_cost_usd":1e308}`),
    ].join('\n'),
  },
  'a history belonging entirely to another run': {
    metricsText: jsonl(
      event({ number: 90, run: OTHER_RUN, minutes: 40, cost: 500, ts: 1 }),
      event({ number: 91, run: OTHER_RUN, minutes: 80, cost: 500, ts: 2 }),
    ),
  },
  'a five-figure queue against a real pace': { queue: 99999 },
  'a queue at the top of the number range': { queue: Number.MAX_VALUE },
  'a failed queue count': { queue: null },
  'a negative queue count': { queue: -5 },
  'a real empty queue': { queue: 0 },
  'a non-integer queue count': { queue: 2.5 },
  'a queue that answered with a string': { queue: '6' },
  'no record at all': { record: null },
  'a record that is an array': { record: [] },
  'a record that is a bare string': { record: 'running' },
  'a record with no run id': { record: inFlightRecord({ run_id: undefined }) },
  'a run id that is an object': { record: inFlightRecord({ run_id: {} }) },
  'a run id that is the empty string': { record: inFlightRecord({ run_id: '' }) },
  'a run id that is a number': { record: inFlightRecord({ run_id: 20260826 }) },
  'nothing in flight': { record: inFlightRecord({ current: null }) },
  'current as a string': { record: inFlightRecord({ current: 'issue 31' }) },
  'current as an array': { record: inFlightRecord({ current: [31] }) },
  'a task number that is not a number': {
    record: inFlightRecord({ current: { number: 'thirty-one', started_at: TASK_STARTED.toISOString() } }),
  },
  'a task with an unparseable started_at': {
    record: inFlightRecord({ current: { number: 31, started_at: 'yesterday' } }),
  },
  'a task with a started_at in the future (clock skew)': {
    record: inFlightRecord({ current: { number: 31, started_at: new Date(NOW + 600 * MIN).toISOString() } }),
  },
  'a status nobody defined': { record: inFlightRecord({ status: 'weird-new-status' }) },
  'no now': { now: null },
  'a NaN now': { now: NaN },
  'an Infinity now': { now: Infinity },
  'a Date object for now': { now: new Date(NOW) },
  'a Buffer of metrics text': { metricsText: Buffer.from(WORKED) },
}

describe('toJsonSnapshot — every leaf is null or finite, for every wrecked input (#58 QA)', () => {
  for (const [label, overrides] of Object.entries(HOSTILE)) {
    it(`holds the leaf contract for ${label}`, () => {
      let doc
      expect(() => {
        doc = project(overrides)
      }, label).not.toThrow()
      expectLeafContract(doc, label)
    })
  }

  it('holds it in all four modes, for the input that measured nothing', () => {
    for (const mode of ['running', 'interrupted', 'idle', 'never-run']) {
      const doc = toJsonSnapshot(
        buildProgress({ metricsText: '', record: null, queue: null, now: NOW }),
        { mode, record: null },
      )
      expectLeafContract(doc, `mode ${mode}`)
      expect(doc.mode, mode).toBe(mode)
    }
  })
})

describe('toJsonSnapshot — the null implications a consumer reasons with (#58 QA)', () => {
  // A consumer branches on these. If `remaining_min` is a number it will render a
  // countdown, so the module may not then say it does not know the pace; if the
  // spend is unknown there can be no projection to show. Each rule is asserted
  // across the whole hostile matrix rather than on one happy document.
  const rules = {
    'an unknown pace leaves the basis saying "unknown"': (doc) =>
      doc.pace.per_task_min == null ? doc.pace.basis === 'unknown' : true,
    'an unknown pace means an unknown ETA': (doc) =>
      doc.pace.per_task_min == null ? doc.eta.remaining_min == null : true,
    'an unknown ETA means no finish time and no band': (doc) =>
      doc.eta.remaining_min == null
        ? doc.eta.finish_at == null && doc.eta.range_min == null
        : true,
    'an unknown remaining count means an unknown total and an unknown ETA': (doc) =>
      doc.progress.remaining == null
        ? doc.progress.total == null && doc.eta.remaining_min == null
        : true,
    'an unknown spend means no rate and no projection': (doc) =>
      doc.spend.usd == null
        ? doc.spend.per_task_usd == null && doc.spend.projected_usd == null
        : true,
    'a projection implies both a spend and a remaining count': (doc) =>
      doc.spend.projected_usd == null
        ? true
        : doc.spend.usd != null && doc.progress.remaining != null,
    'a named pace basis implies a pace': (doc) =>
      doc.pace.basis === 'unknown' ? true : doc.pace.per_task_min != null,
    'the extremes are known exactly when the mean is': (doc) =>
      (doc.pace.fastest_min == null) === (doc.pace.per_task_min == null) &&
      (doc.pace.slowest_min == null) === (doc.pace.per_task_min == null),
    'the counts are never null, because a count of zero IS the measurement': (doc) =>
      doc.progress.completed != null && doc.progress.in_flight != null && doc.pace.samples != null,
  }

  for (const [rule, holds] of Object.entries(rules)) {
    it(rule, () => {
      for (const [label, overrides] of Object.entries(HOSTILE)) {
        expect(holds(project(overrides)), `${rule} — broken by ${label}`).toBe(true)
      }
    })
  }

  it('publishes ONE basis under two keys, never two answers', () => {
    // `pace.basis` and `eta.basis` are the same value read once. If they could
    // disagree, a reader distrusting the ETA would be told two provenances.
    for (const [label, overrides] of Object.entries(HOSTILE)) {
      const doc = project(overrides)
      expect(doc.eta.basis, label).toBe(doc.pace.basis)
      expect(['last3-in-run', 'all-time', 'unknown'], label).toContain(doc.pace.basis)
    }
  })

  it('keeps the ETA band ascending and straddling the estimate, whatever the input', () => {
    for (const [label, overrides] of Object.entries(HOSTILE)) {
      const { eta } = project(overrides)
      if (eta.range_min == null) continue
      expect(Array.isArray(eta.range_min), label).toBe(true)
      expect(eta.range_min.length, label).toBe(2)
      expect(eta.range_min[0], label).toBeLessThanOrEqual(eta.range_min[1])
      expect(eta.range_min[0], label).toBeGreaterThanOrEqual(0)
      expect(eta.range_min[0], label).toBeLessThanOrEqual(eta.remaining_min)
      expect(eta.range_min[1], label).toBeGreaterThanOrEqual(eta.remaining_min)
    }
  })
})

describe('toJsonSnapshot — the in-flight task can never contradict the count (#58 QA)', () => {
  it('names a task exactly when progress.in_flight is 1, across the whole matrix', () => {
    // `progress.in_flight` is the 0-or-1 the denominator was built from and
    // `tasks.current` names that task. A document that says "0 in flight" while
    // naming one would have a status line report a task nobody is working on.
    for (const [label, overrides] of Object.entries(HOSTILE)) {
      const doc = project(overrides)
      expect(doc.tasks.current !== null, `${label}: in_flight=${doc.progress.in_flight}`).toBe(
        doc.progress.in_flight === 1,
      )
    }
  })

  it('counts the named task in the total it publishes', () => {
    for (const [label, overrides] of Object.entries(HOSTILE)) {
      const { progress } = project(overrides)
      if (progress.remaining == null) continue
      expect(progress.total, label).toBe(progress.completed + progress.in_flight + progress.remaining)
    }
  })
})

describe('toJsonSnapshot — the ISO instants a shell consumer feeds to `date`/`fromdate` (#58 QA)', () => {
  it('emits `%Y-%m-%dT%H:%M:%SZ` or null, never anything in between', () => {
    for (const [label, overrides] of Object.entries(HOSTILE)) {
      const doc = project(overrides)
      for (const [path, value] of [
        ['eta.finish_at', doc.eta.finish_at],
        ['tasks.current.started_at', doc.tasks.current?.started_at ?? null],
      ]) {
        if (value == null) continue
        expect(value, `${label}: ${path}`).toMatch(JQ_INSTANT)
        expect(Number.isFinite(Date.parse(value)), `${label}: ${path} must re-parse`).toBe(true)
      }
    }
  })

  it('re-parses to exactly the instant the snapshot recorded, to the second', () => {
    const snapshot = buildProgress({ metricsText: WORKED, record: inFlightRecord(), queue: 6, now: NOW })
    const doc = toJsonSnapshot(snapshot, { mode: 'running', record: inFlightRecord() })
    expect(Date.parse(doc.eta.finish_at)).toBe(Math.floor(snapshot.finishAt / 1000) * 1000)
    expect(Date.parse(doc.tasks.current.started_at)).toBe(
      Math.floor(TASK_STARTED.getTime() / 1000) * 1000,
    )
  })

  it('truncates a sub-second start rather than rounding it into the future', () => {
    // The task started at .999; a rounded instant would claim it started in the
    // next second, i.e. after itself.
    const started = new Date(TASK_STARTED.getTime() + 999)
    const record = inFlightRecord({ current: { number: 31, started_at: started.toISOString() } })
    const doc = project({ record })
    expect(Date.parse(doc.tasks.current.started_at)).toBeLessThanOrEqual(started.getTime())
    expect(doc.tasks.current.started_at).toMatch(JQ_INSTANT)
  })

  it('emits a four-digit-year instant, never an extended year `jq fromdate` refuses', () => {
    // A `try/catch` around `toISOString` only catches the RangeError past ±8.64e15
    // ms — but INSIDE that range it still switches to the ISO-8601 expanded year
    // form (`+024205-12-27T18:40:00Z`, `-001199-02-15T14:13:20Z`) for any instant
    // outside 0000-9999. `jq`'s fromdate errors out on that shape, which is the one
    // thing the document's ISO fields exist to guarantee.
    //
    // Reachable: issues.jsonl is untrusted append-only text, and a `duration_ms`
    // of 1e14 is a finite positive number that passes every sample guard. Six
    // waiting tasks at that pace put the finish time in the year 24205.
    const absurdPace = [
      tagged(`{"issue_number":29,"run_id":"${RUN}","ts":1,"duration_ms":1e14}`),
      tagged(`{"issue_number":30,"run_id":"${RUN}","ts":2,"duration_ms":1e14}`),
    ].join('\n')
    const finish = project({ metricsText: absurdPace }).eta.finish_at
    expect(finish, `finish_at = ${finish}`).toMatch(JQ_INSTANT)

    // The in-flight task's start is held to the same GUARANTEE — a jq instant or
    // nothing — but not by the same rule: it is transcribed rather than derived, so
    // an out-of-calendar start reads null instead of saturating. See the round-2
    // block below for why the two fields part ways here.
    const record = inFlightRecord({
      current: { number: 31, started_at: '+275760-09-13T00:00:00.000Z' },
    })
    const started = project({ record }).tasks.current.started_at
    expect(started, `started_at = ${started}`).toBe(null)
  })
})

describe('toJsonSnapshot — a hand-built snapshot cannot smuggle a bad leaf out (#58 QA)', () => {
  // The function is exported, so the snapshot is not always one buildProgress made:
  // a future caller, or a partially-populated object, must still produce a document
  // whose every leaf is null or finite rather than one carrying a string where a
  // consumer expects a number.
  const snapshots = {
    'every numeric field a string of digits': {
      paceMs: '5040000',
      paceMinMs: '4260000',
      paceMaxMs: '5820000',
      samples: '2',
      completed: '2',
      inFlight: '1',
      remaining: '6',
      total: '9',
      etaMs: '32880000',
      finishAt: '1787700000000',
      spreadMs: '5460000',
      spendUsd: '62.85',
      costPerTaskUsd: '31.425',
      projectedUsd: '251.4',
    },
    'every numeric field Infinity': {
      paceMs: Infinity,
      paceMinMs: Infinity,
      paceMaxMs: Infinity,
      samples: Infinity,
      completed: Infinity,
      inFlight: Infinity,
      remaining: Infinity,
      total: Infinity,
      etaMs: Infinity,
      finishAt: Infinity,
      spreadMs: Infinity,
      spendUsd: Infinity,
      costPerTaskUsd: Infinity,
      projectedUsd: Infinity,
    },
    'every numeric field NaN': {
      paceMs: NaN,
      etaMs: NaN,
      finishAt: NaN,
      spreadMs: NaN,
      spendUsd: NaN,
      costPerTaskUsd: NaN,
      projectedUsd: NaN,
      remaining: NaN,
      total: NaN,
      completed: NaN,
      inFlight: NaN,
      samples: NaN,
    },
    'every field explicitly null': {
      paceBasis: null,
      paceMs: null,
      paceMinMs: null,
      paceMaxMs: null,
      samples: null,
      completed: null,
      inFlight: null,
      remaining: null,
      total: null,
      etaMs: null,
      finishAt: null,
      spreadMs: null,
      spendUsd: null,
      costPerTaskUsd: null,
      projectedUsd: null,
    },
    'a basis nobody defined': { paceBasis: 'vibes', paceMs: 84 * MIN, paceMinMs: 84 * MIN, paceMaxMs: 84 * MIN },
    'an ETA past the end of the calendar': { etaMs: 1e16, finishAt: 1e16, spreadMs: 0 },
    'a finish time before the epoch': { etaMs: 0, finishAt: -1e12, spreadMs: 0 },
    'an object where a number belongs': { paceMs: { ms: 1 }, etaMs: [1], spendUsd: () => 1 },
  }

  for (const [label, snapshot] of Object.entries(snapshots)) {
    it(`degrades ${label} to nulls without throwing`, () => {
      let doc
      expect(() => {
        doc = toJsonSnapshot(snapshot, { mode: 'running', record: { run_id: RUN } })
      }, label).not.toThrow()

      expect(Object.keys(doc), label).toEqual(TOP_KEYS)
      for (const [section, keys] of Object.entries(SECTION_KEYS)) {
        expect(Object.keys(doc[section]), `${label}: ${section}`).toEqual(keys)
      }
      for (const [path, value] of leaves(doc)) {
        expect(value, `${label}: ${path} is undefined`).not.toBe(undefined)
        if (typeof value === 'number') {
          expect(Number.isFinite(value), `${label}: ${path} = ${value}`).toBe(true)
        }
      }
      const text = JSON.stringify(doc)
      expect(text, label).not.toContain('Infinity')
      expect(text, label).not.toContain('NaN')
    })
  }

  it('keeps a basis it does not recognise rather than inventing one', () => {
    // The basis is provenance a consumer switches on; silently rewriting an
    // unfamiliar one would hide a newer producer from an older reader.
    const doc = toJsonSnapshot({ paceBasis: 'vibes' }, { mode: 'running' })
    expect(doc.pace.basis).toBe('vibes')
    expect(doc.eta.basis).toBe('vibes')
  })

  it('types a record whose run id is a hostile string without reshaping it', () => {
    // A run id is a NAME: whatever bytes it carries, it stays a string, and the
    // control characters that would break a one-line document are escaped by
    // JSON.stringify rather than sanitized away here.
    const hostile = `ralph-${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m-\n-${String.fromCharCode(9)}`
    const doc = toJsonSnapshot(buildProgress({}), { mode: 'idle', record: { run_id: hostile } })
    expect(doc.run_id).toBe(hostile)
    const text = JSON.stringify(doc)
    expect(text.includes('\n'), 'a raw newline would split the document into two lines').toBe(false)
    expect(text.includes(String.fromCharCode(27)), 'a raw ESC would colour a consumer’s terminal').toBe(
      false,
    )
    expect(JSON.parse(text).run_id).toBe(hostile)
  })
})

describe('toJsonSnapshot — a projection, provably (#58 QA)', () => {
  // Source-purity, in the style of the #57 sweep: the promise the whole slice
  // turns on is that there is ONE policy rendered twice. A projection that reached
  // for the metrics text, the event tag or the parser would be a second policy,
  // free to drift from the numbers on the terminal — and no value assertion can
  // rule that out as cheaply as reading the function.
  const SOURCE = readFileSync(new URL('./progress.js', import.meta.url), 'utf8')
  const stripComments = (text) =>
    text
      .split('\n')
      .map((line) => (line.trimStart().startsWith('//') ? '' : line.replace(/\s\/\/.*$/, '')))
      .join('\n')

  const body = (name) => {
    const start = SOURCE.indexOf(`export function ${name}(`)
    expect(start, `${name} must be exported from progress.js`).toBeGreaterThan(-1)
    const end = SOURCE.indexOf('\n}\n', start)
    return stripComments(SOURCE.slice(start, end))
  }

  it('never touches the metrics text, the event tag or the parser', () => {
    const code = body('toJsonSnapshot')
    for (const forbidden of [
      /metricsText/,
      /RALPH_ISSUE_EVENT/,
      /ISSUE_EVENT_TAG/,
      /parseIssueEvents/,
      /belongsToRun/,
      /usableSamples/,
      /JSON\.parse/,
      /queue/,
      /Date\.now/,
      /\bnow\b/,
    ]) {
      expect(code, `toJsonSnapshot mentions ${forbidden}`).not.toMatch(forbidden)
    }
  })

  it('does no arithmetic of its own beyond renaming, converting and clamping', () => {
    // No `+`, `*` or `/` in the projection's own body: the unit conversion and the
    // band live in named helpers, and every number in the document is one the
    // snapshot already stood behind.
    const code = body('toJsonSnapshot')
    for (const operator of ['*', '/', ' + ', ' - ']) {
      expect(code.includes(operator), `toJsonSnapshot computes with "${operator}"`).toBe(false)
    }
  })

  it('reads the record for identity only — never for a number it could derive', () => {
    // `record` supplies the run's name and the in-flight task's number/start. If it
    // reached for a duration, a cost or a queue depth the document could disagree
    // with the snapshot the terminal renders.
    //
    // Asserted on the RESOLVED reads rather than on the source text: a Proxy records
    // every property the projection actually touches, so destructuring the record,
    // dropping an optional chain or renaming a local all read the same here, and a
    // read that is genuinely new is still caught.
    const touched = new Set()
    const spy = (path) =>
      new Proxy(
        {},
        {
          get(_target, key) {
            if (typeof key !== 'string') return undefined
            const here = path ? `${path}.${key}` : key
            touched.add(here)
            // `current` is the only nested object the record offers; everything else
            // must read as a leaf so a wrong read shows up as a value, not a Proxy.
            return here === 'current' ? spy(here) : undefined
          },
        },
      )
    toJsonSnapshot({ inFlight: 1 }, { mode: 'running', record: spy('') })
    expect([...touched].sort()).toEqual(['current', 'current.number', 'current.started_at', 'run_id'])
  })
})

// ---------------------------------------------------------------------------
// Round 2. The expanded-year leak reported above was fixed by CLAMPING derived
// instants into the four-digit-year calendar and RANGE-CHECKING transcribed ones —
// two helpers over one shared formatter, because a saturated ETA is still an honest
// bound while a saturated start time is a different fact. That is a NEW code path
// with its own edges, and "the two tests that used to fail now pass" is not evidence
// that it is right — a clamp is exactly the kind of change that can be off by one at
// the boundary, or silently truncate honest in-range values if a constant is
// mistyped. So the guard is attacked here from four directions: the boundaries
// themselves, the whole band the old code leaked through, the inputs that must still
// produce `null`, and the `-0` normalization that shipped beside it.
// ---------------------------------------------------------------------------

// The edges of ISO-8601's four-digit-year form, derived rather than copied: these are
// what the module's two literals are SUPPOSED to be, computed independently so a
// fat-fingered digit in either constant is caught rather than mirrored.
const CALENDAR_CEIL_MS = Date.parse('9999-12-31T23:59:59.999Z')
const CALENDAR_FLOOR_MS = Date.parse('0000-01-01T00:00:00.000Z')
const CEIL_INSTANT = '9999-12-31T23:59:59Z'
const FLOOR_INSTANT = '0000-01-01T00:00:00Z'

// The two ISO fields, exercised through the public projection (the helper itself is
// private, and pinning it through the document is what a consumer actually reads).
const finishAtOf = (finishAt) =>
  toJsonSnapshot({ etaMs: 1, finishAt, spreadMs: 0 }, { mode: 'running' }).eta.finish_at

const startedAtOf = (started_at) =>
  toJsonSnapshot({ inFlight: 1 }, { mode: 'running', record: { run_id: RUN, current: { number: 31, started_at } } })
    .tasks.current.started_at

describe('the ISO clamp — at, on and past both edges of the calendar (#58 QA round 2)', () => {
  it('encodes the true edges of the four-digit-year calendar in its two constants', () => {
    // A clamp is only as good as the numbers it clamps to: ISO_CEIL_MS one second
    // short would quietly report every ETA in the last second of year 9999 as
    // earlier than it is, and a mistyped digit would move the edge by centuries
    // without any test noticing, because clamping is invisible from the outside.
    // So the literals are pinned against instants parsed from the strings they
    // stand for, and the platform assumption they encode — that ONE MILLISECOND
    // further leaves the four-digit form — is pinned beside them.
    const source = readFileSync(new URL('./progress.js', import.meta.url), 'utf8')
    expect(CALENDAR_CEIL_MS, 'the ceiling instant must parse').toBe(253402300799999)
    expect(CALENDAR_FLOOR_MS, 'the floor instant must parse').toBe(-62167219200000)
    expect(source, 'ISO_CEIL_MS is not the last millisecond of year 9999').toContain(
      `const ISO_CEIL_MS = ${CALENDAR_CEIL_MS}`,
    )
    expect(source, 'ISO_FLOOR_MS is not the first millisecond of year 0000').toContain(
      `const ISO_FLOOR_MS = ${CALENDAR_FLOOR_MS}`,
    )
    // Why those two and not others: one step outside, `toISOString` switches to the
    // expanded form that `jq fromdate` refuses. This is the reason the clamp exists.
    expect(new Date(CALENDAR_CEIL_MS + 1).toISOString()).toBe('+010000-01-01T00:00:00.000Z')
    expect(new Date(CALENDAR_FLOOR_MS - 1).toISOString()).toBe('-000001-12-31T23:59:59.999Z')
  })

  // Every boundary the fix introduced, plus the one the OLD code used to throw at
  // (±8.64e15, the limit of a JS Date), plus the epoch and its neighbours — where an
  // off-by-one in the clamp or a `Math.min`/`Math.max` swapped would show up first.
  const EDGES = [
    ['the epoch', 0, '1970-01-01T00:00:00Z'],
    ['one ms before the epoch', -1, '1969-12-31T23:59:59Z'],
    ['negative zero', -0, '1970-01-01T00:00:00Z'],
    ['the smallest positive double', Number.MIN_VALUE, '1970-01-01T00:00:00Z'],
    ['the ceiling itself', CALENDAR_CEIL_MS, CEIL_INSTANT],
    ['one ms inside the ceiling', CALENDAR_CEIL_MS - 1, CEIL_INSTANT],
    ['one ms past the ceiling', CALENDAR_CEIL_MS + 1, CEIL_INSTANT],
    ['one second past the ceiling', CALENDAR_CEIL_MS + 1000, CEIL_INSTANT],
    ['year 10000 exactly', 253402300800000, CEIL_INSTANT],
    ['the floor itself', CALENDAR_FLOOR_MS, FLOOR_INSTANT],
    ['one ms inside the floor', CALENDAR_FLOOR_MS + 1, FLOOR_INSTANT],
    ['one ms before the floor', CALENDAR_FLOOR_MS - 1, FLOOR_INSTANT],
    ['one second before the floor', CALENDAR_FLOOR_MS - 1000, FLOOR_INSTANT],
    ['the old RangeError edge', 8.64e15, CEIL_INSTANT],
    ['one ms past the old RangeError edge', 8.64e15 + 1, CEIL_INSTANT],
    ['the negative RangeError edge', -8.64e15, FLOOR_INSTANT],
    ['one ms past the negative RangeError edge', -8.64e15 - 1, FLOOR_INSTANT],
    ['1e16, which used to throw', 1e16, CEIL_INSTANT],
    ['-1e16, which used to throw', -1e16, FLOOR_INSTANT],
    ['1e308', 1e308, CEIL_INSTANT],
    ['-1e308', -1e308, FLOOR_INSTANT],
    ['the largest double', Number.MAX_VALUE, CEIL_INSTANT],
    ['the smallest double', -Number.MAX_VALUE, FLOOR_INSTANT],
  ]

  for (const [label, ms, expected] of EDGES) {
    it(`saturates ${label} to ${expected}`, () => {
      expect(finishAtOf(ms)).toBe(expected)
      // `started_at` is TRANSCRIBED, not derived, so it does NOT saturate: it has no
      // adjacent magnitude field to carry the truth a clamp would discard, so an
      // out-of-calendar start reads null rather than as a different instant. Inside
      // the calendar the two fields agree exactly.
      const transcribed = new Date(Math.min(Math.max(ms, -8.64e15), 8.64e15)).toISOString()
      const inCalendar = JQ_INSTANT.test(transcribed.replace(/\.\d{3}Z$/, 'Z'))
      expect(startedAtOf(transcribed), transcribed).toBe(inCalendar ? expected : null)
    })
  }

  it('never clamps an instant the calendar CAN express', () => {
    // The other half of a clamp's contract, and the half a passing boundary table
    // does not cover: an honest in-range finish must come out untouched. If either
    // constant were wrong in the direction that narrows the window, every assertion
    // above would still pass and real ETAs would be silently rewritten.
    const inRange = [
      0,
      1000,
      NOW,
      Date.parse('0000-01-01T00:00:01.000Z'),
      Date.parse('0001-01-01T00:00:00.000Z'),
      Date.parse('1969-07-20T20:17:40.000Z'),
      Date.parse('2500-06-15T12:34:56.000Z'),
      Date.parse('9998-12-31T23:59:59.000Z'),
      Date.parse('9999-12-31T23:59:58.000Z'),
      CALENDAR_CEIL_MS - 1000,
      CALENDAR_FLOOR_MS + 1000,
    ]
    for (const ms of inRange) {
      const instant = finishAtOf(ms)
      expect(instant, `ms = ${ms}`).toMatch(JQ_INSTANT)
      // Truncated to the second, never rounded and never moved: the second the
      // instant names is the second the input fell in.
      expect(Date.parse(instant), `ms = ${ms} was rewritten`).toBe(Math.floor(ms / 1000) * 1000)
    }
  })

  it('is monotonic across both edges — saturation may flatten, never invert', () => {
    // A consumer sorting or diffing two documents relies on later never reading as
    // earlier. `Math.min(Math.max(...))` with its arguments transposed would invert
    // exactly here, and every single-value assertion above would still pass.
    const ascending = [
      -Number.MAX_VALUE,
      -1e16,
      CALENDAR_FLOOR_MS - 1,
      CALENDAR_FLOOR_MS,
      CALENDAR_FLOOR_MS + 1000,
      -1000,
      0,
      NOW,
      CALENDAR_CEIL_MS - 1000,
      CALENDAR_CEIL_MS,
      CALENDAR_CEIL_MS + 1,
      1e16,
      Number.MAX_VALUE,
    ]
    const instants = ascending.map((ms) => finishAtOf(ms))
    for (let i = 1; i < instants.length; i++) {
      expect(
        Date.parse(instants[i]),
        `${ascending[i - 1]} -> ${instants[i - 1]} but ${ascending[i]} -> ${instants[i]}`,
      ).toBeGreaterThanOrEqual(Date.parse(instants[i - 1]))
    }
  })

  it('spans the whole band the expanded-year form used to escape through', () => {
    // The band the round-1 report identified: above the calendar ceiling
    // (~2.534e14) and up to the old throw limit (8.64e15), `toISOString` returned
    // `+024208-10-07T18:18:40.000Z` and the try/catch never fired. 1e308 was
    // SAFER than 1e15, because it overflowed and was correctly nulled. Both signs.
    const band = [2.6e14, 3e14, 5e14, 1e15, 4.2e15, 8.63e15, 8.639e15, 8.64e15]
    for (const ms of [...band, ...band.map((n) => -n)]) {
      const instant = finishAtOf(ms)
      expect(instant, `ms = ${ms}`).toMatch(JQ_INSTANT)
      expect(instant, `ms = ${ms}`).toBe(ms > 0 ? CEIL_INSTANT : FLOOR_INSTANT)
      // ...and the magnitude is not lost: `remaining_min` beside it is what makes
      // saturating the instant an acceptable answer rather than a fabricated one.
      expect(
        toJsonSnapshot({ etaMs: ms, finishAt: ms, spreadMs: 0 }, { mode: 'running' }).eta.remaining_min,
        `ms = ${ms}`,
      ).toBe(Math.round(ms / 60000))
    }
  })

  it('answers with a jq-parseable instant for EVERY finite magnitude, in both signs', () => {
    // A log-scale sweep of the whole double range: if any finite input can still
    // produce a string `JQ_INSTANT` rejects, the clamp has a hole. 3796 inputs.
    //
    // Every one of them must come back a STRING, never null: the sweep only feeds
    // finite milliseconds, and a finite input that survives `finiteOrNull` is
    // saturated into [floor, ceiling] before it is formatted. A null here would mean
    // the derived field had started discarding instants it is supposed to bound.
    const bad = []
    let checked = 0
    for (let exponent = -324; exponent <= 308; exponent++) {
      for (const mantissa of [1, 1.5, 9.99]) {
        for (const sign of [1, -1]) {
          const ms = sign * mantissa * 10 ** exponent
          if (!Number.isFinite(ms) || ms === 0) continue
          checked++
          const instant = finishAtOf(ms)
          if (typeof instant !== 'string' || !JQ_INSTANT.test(instant)) {
            bad.push(`${ms} -> ${JSON.stringify(instant)}`)
          }
        }
      }
    }
    expect(checked, 'the sweep must actually cover the double range').toBeGreaterThan(3000)
    expect(bad.slice(0, 10), `${bad.length} finite inputs produced a non-instant`).toEqual([])
  })

  it('is null — never an instant, never a throw — for anything that is not a finite number', () => {
    // The clamp sits BEHIND finiteOrNull, and it has to stay there: `Math.min` would
    // happily turn NaN into NaN and `new Date(NaN).toISOString()` throws, while
    // `Math.max(Infinity, floor)` would sail into the ceiling and report a confident
    // year 9999 for a number nobody measured. Unknown must stay unknown.
    const notNumbers = [
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['a numeric string', '253402300799999'],
      ['an ISO string', '2026-08-25T18:52:00Z'],
      ['null', null],
      ['undefined', undefined],
      ['an object', {}],
      ['an array', []],
      ['a boolean', true],
      ['a Date instance', new Date(NOW)],
      ['a BigInt', 1n],
    ]
    for (const [label, value] of notNumbers) {
      expect(() => finishAtOf(value), `${label} must not throw`).not.toThrow()
      expect(finishAtOf(value), `finish_at for ${label}`).toBe(null)
    }
  })

  it('reports a hostile started_at as null rather than as a different instant', () => {
    // `tasks.current.started_at` is `Date.parse` of a string SOMEBODY ELSE wrote into
    // run-state.json, so the expanded-year form arrives here directly rather than
    // through arithmetic. `+275760-09-13T00:00:00.000Z` is the maximum a JS Date can
    // represent and round-trips through Date.parse, so it is the strongest input the
    // field can be handed.
    //
    // THE ASYMMETRY IS THE POINT, and it is why the two ISO fields go through two
    // functions. On `eta.finish_at` a saturated instant sits next to `remaining_min`,
    // which still carries the true magnitude, so clamping loses no fact. Here there
    // is no adjacent magnitude field — an `elapsed_min` was deliberately left out —
    // so a clamped start would not lose precision, it would FABRICATE a fact: a
    // consumer computing `now - started_at` would get ~8000 years of elapsed time
    // where the human view beside it prints `(0min)`. `null` is what this field
    // already returns for a start it cannot read, so no consumer gains a case.
    expect(startedAtOf('+275760-09-13T00:00:00.000Z')).toBe(null)
    expect(startedAtOf('-271821-04-20T00:00:00.000Z')).toBe(null)
    expect(startedAtOf('+024208-10-07T18:18:40.000Z')).toBe(null)
    expect(startedAtOf('-001199-02-15T14:13:20.000Z')).toBe(null)
    // The edges of the calendar itself are still transcribed, not discarded.
    expect(startedAtOf('9999-12-31T23:59:59.999Z')).toBe(CEIL_INSTANT)
    expect(startedAtOf('0000-01-01T00:00:00.000Z')).toBe(FLOOR_INSTANT)
    // One millisecond outside either edge is the first input that reads null.
    expect(startedAtOf(new Date(CALENDAR_CEIL_MS + 1).toISOString())).toBe(null)
    expect(startedAtOf(new Date(CALENDAR_FLOOR_MS - 1).toISOString())).toBe(null)
    // Past what a Date can hold, Date.parse gives NaN and the field stays honest.
    for (const unparseable of ['275760-09-14T00:00:00.000Z', '+275760-09-14T00:00:00.000Z']) {
      expect(startedAtOf(unparseable), unparseable).toBe(null)
    }
    // And a non-string is not coerced into an instant by Date.parse's String() step.
    for (const value of [null, undefined, NOW, {}, [], 'yesterday', '']) {
      expect(startedAtOf(value), `started_at = ${String(value)}`).toBe(null)
    }
  })
})

describe('the minute conversion — the -0 normalization that shipped with it (#58 QA round 2)', () => {
  // `Math.round` hands back -0 for any input in (-30000, 0]: JSON.stringify writes it
  // as `0`, so the document would not equal its own round trip under the strict
  // equality vitest (and a consumer diffing snapshots) uses. The fix collapses it.
  // What is checked here is that it collapses on EVERY `*_min` leaf, and that it did
  // not perturb the ordinary values around it.

  // Leaf-wise Object.is, which is what makes -0 visible: `toEqual` on the whole
  // document also distinguishes it, but a path in the message is worth more.
  const expectStrictRoundTrip = (doc, label) => {
    const before = leaves(doc)
    const after = leaves(JSON.parse(JSON.stringify(doc)))
    expect(after.length, `${label}: leaf count`).toBe(before.length)
    before.forEach(([path, value], i) => {
      expect(Object.is(value, after[i][1]), `${label}: ${path} = ${value} changed to ${after[i][1]}`).toBe(
        true,
      )
    })
  }

  // Every `*_min` leaf, with the snapshot field that feeds it. -30000 ms is the
  // extreme of the -0 window (Math.round(-0.5) is -0, not 0).
  const MINUTE_LEAVES = [
    ['pace.per_task_min', 'paceMs', (d) => d.pace.per_task_min],
    ['pace.fastest_min', 'paceMinMs', (d) => d.pace.fastest_min],
    ['pace.slowest_min', 'paceMaxMs', (d) => d.pace.slowest_min],
    ['eta.remaining_min', 'etaMs', (d) => d.eta.remaining_min],
  ]

  for (const [path, field, read] of MINUTE_LEAVES) {
    for (const ms of [-1, -100, -29999, -30000]) {
      it(`writes 0 rather than -0 on ${path} for ${ms}ms`, () => {
        const doc = toJsonSnapshot({ [field]: ms, spreadMs: 0 }, { mode: 'running' })
        const value = read(doc)
        expect(Object.is(value, -0), `${path} is -0, which round-trips to 0`).toBe(false)
        expect(value).toBe(0)
        expectStrictRoundTrip(doc, `${path} = ${ms}ms`)
      })
    }
  }

  it('writes 0 rather than -0 on both ends of the ETA band', () => {
    // The band is the only leaf built from arithmetic rather than a snapshot field:
    // the low end is floored at 0 by Math.max, but the HIGH end is `eta + spread`
    // and reaches the -0 window on its own.
    const doc = toJsonSnapshot({ etaMs: -30000, spreadMs: 0 }, { mode: 'running' })
    expect(doc.eta.range_min).toEqual([0, 0])
    for (const [i, value] of doc.eta.range_min.entries()) {
      expect(Object.is(value, -0), `eta.range_min[${i}] is -0`).toBe(false)
    }
    expectStrictRoundTrip(doc, 'a negative sub-minute band')
  })

  it('rounds to the nearest whole minute on both sides of the half minute', () => {
    // The normalization is a `=== 0` collapse, so it must not have moved the rounding
    // boundary or turned a real negative minute into a zero.
    const table = [
      [0, 0],
      [1, 0],
      [29999, 0],
      [30000, 1],
      [59999, 1],
      [60000, 1],
      [90000, 2],
      [-1, 0],
      [-29999, 0],
      [-30000, 0],
      [-30001, -1],
      [-60000, -1],
      [-90000, -1],
      [8e15, 133333333333],
    ]
    for (const [ms, minutes] of table) {
      expect(
        toJsonSnapshot({ etaMs: ms, spreadMs: 0 }, { mode: 'running' }).eta.remaining_min,
        `${ms}ms`,
      ).toBe(minutes)
    }
  })

  it('left every ordinary minute value on the worked example untouched', () => {
    // The regression guard for the fix itself: 84 min/task from 97 and 71, 548
    // minutes of ETA over six waiting tasks plus the one in flight, band [457, 639].
    // Timezone-independent by construction — these are durations, not clock times.
    const doc = project()
    expect(doc.pace.per_task_min).toBe(84)
    expect(doc.pace.fastest_min).toBe(71)
    expect(doc.pace.slowest_min).toBe(97)
    expect(doc.eta.remaining_min).toBe(548)
    expect(doc.eta.range_min).toEqual([457, 639])
    expectStrictRoundTrip(doc, 'the worked example')
  })

  it('survives a strict round trip for every hostile input in the matrix', () => {
    // The -0 hazard is not confined to the minute leaves — this is the whole-document
    // form of the property, over the same hostile inputs the leaf contract uses.
    for (const [label, overrides] of Object.entries(HOSTILE)) {
      expectStrictRoundTrip(project(overrides), label)
    }
  })
})
