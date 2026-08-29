// QA augmentation for #121 — the extraction's seams, attacked from the side its own spec
// cannot see.
//
// The refactor's claim is that NOTHING OBSERVABLE CHANGED: three hand-maintained copies of one
// line grammar became one shared module, and the three readers of `.ralph/metrics/issues.jsonl`
// now differ only in which direction they walk. issue-event-lines.test.js pins that grammar as a
// contract and asserts the two walks agree with each other. What it cannot see, by construction,
// is everything on the far side of the seam — and a refactor whose whole justification is "the
// readers can no longer disagree" is exactly the refactor whose spec has to be written from the
// READERS, not from the parser:
//
//   1. THE AGREEMENT IS A CROSS-MODULE PROPERTY, ASSERTED IN ONE MODULE. The dev's biconditional
//      holds `issueEvents` against `newestIssueEvent` — two exports of the same file, over the
//      same `eventOn`, which is nearly a tautology. The bug #121 was opened about is `ralph
//      cycle`, `ralph status` and the launch box coming to different opinions about the same
//      file, so the table below feeds ONE hostile log to all SIX consumers at once
//      (`aggregateCycleCounts`, `parseIssueEvents`, `newestIssueEvent`, `buildProgress` /
//      `buildLaunchProjection`, `buildPostMortem`, `resolveBannerModel`) and asserts they agree
//      about which lines were events.
//
//   2. THE THREE SELF-REPORTED BEHAVIOURAL DELTAS ARE CLAIMS, NOT FACTS. An array is now
//      rejected by the cycle aggregator; the aggregator's `if (!jsonlText) return` early exit is
//      gone; and the coercion was deliberately NOT unified, so `progress.js` still runs
//      `String(jsonlText)` at its own door while `banner-model.js` refuses to. Each is attacked
//      here rather than accepted — the array claim by trying to build a JSON array that carries
//      a numeric `ts`, the early-return claim by demanding the exact object SHAPE back, and the
//      coercion claim by driving a `Buffer` and a bag whose `toString` throws through every
//      reader and pinning which of them absorbs which.
//
//   3. A GENERATOR HAS HAZARDS THREE ARRAYS DID NOT. It is exhausted by its first walk, it can
//      be abandoned mid-line, and it cannot be iterated twice — and `buildProgress` iterates its
//      events TWICE (once to scope them to the run, once for the all-time pace fallback). That
//      is why `parseIssueEvents` spreads, and the spread is therefore load-bearing rather than
//      stylistic. Asserted behaviourally, through the pace, so a "tidy" that returns the
//      generator straight through fails on a number a reader would have seen.
//
//   4. FOUR STATIC PURITY GUARDS WERE RE-AIMED. A purity guard that admits a new import edge is
//      one edit away from being a purity guard that admits any edge, so each re-aimed matcher is
//      replayed here against a PLANTED mutation and required to fire — and the one claim the
//      re-aim genuinely dropped (`lib/progress.js` used to forbid every `import` statement, and
//      now pins only the `from` specifiers) is restored as an assertion of its own.
//
// Hermetic and pure: every case is a string literal, exactly as #41 requires — no `.ralph`
// directory, no previous run, no clock. The one exception is the static block at the bottom,
// which reads this repository's own source, which is what a structural guard is.

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { ISSUE_EVENT_TAG, issueEvents, newestIssueEvent } from './issue-event-lines.js'
import { aggregateCycleCounts } from './issue-metrics.js'
import {
  belongsToRun,
  buildLaunchProjection,
  buildProgress,
  parseIssueEvents,
  usableSamples,
} from './progress.js'
import { buildPostMortem } from './post-mortem.js'
import { MODEL_PROVENANCE, resolveBannerModel } from './banner-model.js'

const LIB = fileURLToPath(new URL('.', import.meta.url))

/** A log line, spelled the way `appendIssueEvent` spells it. */
const tagged = (payload) => ISSUE_EVENT_TAG + payload
/** ...and one holding a JSON-encoded object, the way the writer really writes it. */
const line = (fields) => tagged(JSON.stringify(fields))
/** The forward walk, materialized. */
const walk = (text) => [...issueEvents(text)]

// Bytes that must never be committed raw into this repository's source (#107), so they are
// BUILT rather than embedded. Each is a byte a `tee`-and-pretty-print pipeline, a Windows
// checkout or a mangled editor can really put on a line of this file.
const CR = String.fromCharCode(13)
const TAB = String.fromCharCode(9)
const NBSP = String.fromCharCode(0xa0)
const BOM = String.fromCharCode(0xfeff)

// ---------------------------------------------------------------------------------------------
// 1. Splitting the log — every shape the file's LINES can take.
// ---------------------------------------------------------------------------------------------
describe('QA #121 the line split — logs the loop and its pipeline really leave behind', () => {
  it('treats a CR-only log as ONE line, and all three readers agree it holds nothing', () => {
    // `split('\n')` is the whole of the line rule and it does NOT split on a lone CR, so an
    // old-Mac or CR-mangled log is a single line holding several events: the tag is found at
    // the first, and the slice is then JSON followed by junk, which does not parse. The
    // DIRECTION of that failure is what matters and it is the safe one — no event at all,
    // rather than the OLDEST event reported as the newest. Pinned across all three readers
    // because a future "improve the split to handle CR" would change the box and the status
    // view at once, which is the coupling #121 bought.
    const oneLine = [line({ model: 'older', ts: 1, verdict: 'pass' }), line({ ts: 2 })].join(CR)
    expect(walk(oneLine)).toEqual([])
    expect(parseIssueEvents(oneLine)).toEqual([])
    expect(newestIssueEvent(oneLine)).toBe(null)
    expect(aggregateCycleCounts(oneLine, 0).processed).toBe(0)
  })

  it('reads a CRLF log identically to an LF one, and a lone CR before LF is not a line', () => {
    // The trailing CR of a CRLF log lands INSIDE the payload slice and is skipped as
    // whitespace by JSON.parse — which is why the CRLF case works at all. This pins the
    // stronger statement: the events are byte-identical to the LF reading, so a Windows
    // checkout and a Unix one produce the same launch box.
    const rows = [line({ issue_number: 29, ts: 1 }), line({ issue_number: 30, ts: 2 })]
    expect(walk(rows.join(CR + '\n') + CR + '\n')).toEqual(walk(rows.join('\n') + '\n'))
  })

  it('reads a one-line log with no trailing newline, and a log that is only newlines', () => {
    // The two ends of the file's normal life: a repo whose very first iteration has just
    // finished (one line, unterminated, because `>>` writes the newline last) and a file
    // truncated to nothing but blanks by a crash.
    expect(walk(line({ issue_number: 29, ts: 1 }))).toEqual([{ issue_number: 29, ts: 1 }])
    for (const empty of ['\n', '\n\n\n', '  \n \n', CR + '\n' + CR + '\n']) {
      expect(walk(empty), JSON.stringify(empty)).toEqual([])
      expect(newestIssueEvent(empty), JSON.stringify(empty)).toBe(null)
    }
  })

  it('refuses a line carrying the tag TWICE, and salvages neither half', () => {
    // Two events glued onto one line by a pipeline that dropped a newline. `indexOf` finds the
    // FIRST tag, so the slice is `{…} RALPH_ISSUE_EVENT {…}` and fails to parse. Refused, and
    // that is the right direction twice over: the first of the two is the OLDER event, so
    // salvaging it would report a stale run as the newest, and salvaging the LAST tag instead
    // would make `indexOf` a `lastIndexOf` and change what every reader counts.
    const glued = `${line({ model: 'older' })} ${line({ model: 'newer' })}`
    expect(walk(glued)).toEqual([])
    expect(newestIssueEvent(glued)).toBe(null)
    // ...including the degenerate spelling, where the second tag IS the payload.
    expect(walk(tagged(tagged('{"a":1}')))).toEqual([])
  })

  it('reads an event whose own VALUES quote the tag, and counts it exactly once', () => {
    // The realistic version of a forged line, and #121's own issue title is an instance of it:
    // a task titled "extract the RALPH_ISSUE_EVENT line grammar" flows through `capture-issue-
    // event` into the `title` field, and `JSON.stringify` escapes nothing about the tag because
    // there is nothing to escape. So a legitimate event can hold the tag inside a string value.
    // `indexOf` finds the REAL tag first (it is at the front of the line), the whole payload
    // parses, and the smuggled copy is inert text. One event, not two, and no forged verdict.
    const smuggled = line({
      issue_number: 121,
      ts: 5,
      verdict: 'pass',
      title: `extract the ${tagged('{"ts":9,"verdict":"pass","issue_number":999}')} grammar`,
    })
    expect(walk(smuggled)).toHaveLength(1)
    expect(aggregateCycleCounts(smuggled, 0)).toEqual({
      ok: 1,
      failed: 0,
      processed: 1,
      okIssues: [121],
      failedIssues: [],
    })
    // ...and the mirror case: an UNTAGGED line that merely mentions the tag mid-string is not
    // an event, because the slice taken after the inner tag is not valid JSON.
    const mention = `{"note":"${tagged('{\\"ts\\":9}')}"}`
    expect(walk(mention)).toEqual([])
  })

  it('keeps a payload holding an escaped newline on ONE line', () => {
    // `appendIssueEvent` writes `JSON.stringify(event)`, which encodes a real newline in a
    // value as the two characters backslash-n — so a multi-line issue title stays one log line.
    // If the split ever saw the escape as a break, every event with a body would truncate.
    const withBreak = line({ issue_number: 29, ts: 1, verdict: 'pass', title: 'a\nb\r\nc' })
    expect(withBreak.split('\n')).toHaveLength(1)
    expect(walk(withBreak)).toEqual([
      { issue_number: 29, ts: 1, verdict: 'pass', title: 'a\nb\r\nc' },
    ])
  })

  it('reads a one-megabyte line without throwing, and finds the event after it', () => {
    // The file is append-only for the life of the repo and a runaway agent can write a title
    // measured in megabytes. What matters is that a monster line costs a ROW and not the read:
    // the giant payload fails to parse (it is truncated on purpose), and the ordinary event on
    // the next line still lands.
    const monster = tagged(`{"title":"${'x'.repeat(1024 * 1024)}`)
    const text = [monster, line({ issue_number: 30, ts: 2 })].join('\n')
    expect(walk(text)).toEqual([{ issue_number: 30, ts: 2 }])
    expect(newestIssueEvent(text)).toEqual({ issue_number: 30, ts: 2 })
  })

  it('holds the tag’s TRAILING SPACE as load-bearing — no space, no event', () => {
    // The one byte of the tag a reader would delete as noise. `indexOf` searches for the space
    // too, so every spelling below is simply not the tag — and the file is append-only across
    // upgrades, so widening the match would start counting lines that were never events while
    // narrowing it would stop counting every line ever written.
    const bare = ISSUE_EVENT_TAG.trimEnd()
    for (const notTheTag of [
      `${bare}{"ts":1,"verdict":"pass"}`, // no separator at all
      `${bare}${TAB}{"ts":1,"verdict":"pass"}`, // a tab, which JSON.parse would have tolerated
      `${bare}${NBSP}{"ts":1,"verdict":"pass"}`, // a no-break space, invisible in a terminal
      `${bare}X {"ts":1,"verdict":"pass"}`, // a longer word that starts with the tag
      `${bare.toLowerCase()} {"ts":1,"verdict":"pass"}`,
      `RALPH_ISSUE_EVEN {"ts":1,"verdict":"pass"}`,
    ]) {
      expect(walk(notTheTag), JSON.stringify(notTheTag)).toEqual([])
      expect(newestIssueEvent(notTheTag), JSON.stringify(notTheTag)).toBe(null)
      expect(aggregateCycleCounts(notTheTag, 0).processed, JSON.stringify(notTheTag)).toBe(0)
    }
    // ...while EXTRA whitespace after the tag is fine, because the slice starts past the tag's
    // own space and JSON.parse skips what follows. A column-aligning pretty-printer costs no
    // row, and a BOM or a timestamp in FRONT of the tag costs none either.
    expect(walk(`${bare}   {"ts":1}`)).toEqual([{ ts: 1 }])
    expect(walk(`${BOM}10:00:00 | ${line({ ts: 1 })}`)).toEqual([{ ts: 1 }])
  })
})

// ---------------------------------------------------------------------------------------------
// 2. Prototype pollution and weird keys — at the CONSUMERS, not only at the parse.
// ---------------------------------------------------------------------------------------------
describe('QA #121 a hostile payload cannot reach a tally, a run scope or a sample', () => {
  // Every key the log could carry that means something to JavaScript rather than to Ralph. The
  // dev's spec pins one `__proto__` case at the parser; what a reader actually depends on is
  // that none of these changes a NUMBER on a report card, so each is driven through the verdict
  // tally, the run scope (`belongsToRun`) and the sample filter (`usableSamples`).
  const HOSTILE_KEYS = {
    '__proto__ carrying a whole event': '{"__proto__":{"ts":5,"verdict":"pass","issue_number":9}}',
    '__proto__ carrying a cost and a duration':
      '{"__proto__":{"duration_ms":999999,"total_cost_usd":999},"ts":5,"verdict":"pass"}',
    'constructor carrying a prototype': '{"constructor":{"prototype":{"ts":5,"verdict":"pass"}}}',
    'a ts whose VALUE is the pollution key': '{"ts":"__proto__","verdict":"pass"}',
    'hasOwnProperty shadowed': '{"hasOwnProperty":1,"ts":5,"verdict":"pass","issue_number":9}',
    'toString and valueOf shadowed': '{"toString":2,"valueOf":3,"ts":5,"verdict":"pass"}',
    'a run_id shadowing toString': '{"run_id":{"toString":"x"},"ts":5,"verdict":"pass"}',
  }

  it('never lets a payload key land on Object.prototype, through any reader', () => {
    // Asserted over the WHOLE set and over every reader, because `JSON.parse`'s treatment of
    // `__proto__` (an own data property, never an assignment) is the only thing standing
    // between an append-only file a foreign writer touches and this process's object graph.
    // A hand-rolled `Object.assign`-based normaliser added later would break exactly here.
    const before = ['ts', 'verdict', 'issue_number', 'duration_ms', 'total_cost_usd'].map(
      (key) => Object.prototype[key],
    )
    for (const [label, payload] of Object.entries(HOSTILE_KEYS)) {
      const text = tagged(payload)
      expect(() => walk(text), label).not.toThrow()
      expect(() => newestIssueEvent(text), label).not.toThrow()
      expect(() => aggregateCycleCounts(text, 0), label).not.toThrow()
      expect({}.ts, label).toBe(undefined)
      expect([].ts, label).toBe(undefined)
    }
    expect(
      ['ts', 'verdict', 'issue_number', 'duration_ms', 'total_cost_usd'].map(
        (key) => Object.prototype[key],
      ),
    ).toEqual(before)
  })

  it('counts a __proto__-only event as no event at all, rather than as a pass', () => {
    // The attack that would matter: a line whose `ts` and `verdict` live behind `__proto__`
    // would be a forged pass in `ralph cycle`'s summary if the aggregator read inherited keys.
    // It does not — `JSON.parse` put them on an own `__proto__` property, so `event.ts` is
    // undefined and the `ts` gate drops the line. Pinned as a NUMBER, so the guard survives a
    // rewrite of the gate.
    const forged = tagged(HOSTILE_KEYS['__proto__ carrying a whole event'])
    expect(walk(forged)).toHaveLength(1) // it IS an event object...
    expect(aggregateCycleCounts(forged, 0)).toEqual({
      ok: 0,
      failed: 0,
      processed: 0,
      okIssues: [],
      failedIssues: [],
    })
    // ...and its hidden duration and cost are not samples either, so no pace and no rate.
    expect(usableSamples(walk(forged), 'duration_ms')).toEqual([])
    expect(usableSamples(walk(forged), 'total_cost_usd')).toEqual([])
  })

  it('leaves the sample filter and the run scope reading own keys only', () => {
    // `usableSamples` reads `event[field]` and `belongsToRun` reads `event.run_id`, both of
    // which would consult a prototype chain if one existed. Two rows: a payload hiding a
    // duration behind `__proto__` contributes no sample even though a sibling key makes it a
    // real event, and a payload whose `run_id` hides behind `__proto__` matches no run.
    const hidden = walk(tagged(HOSTILE_KEYS['__proto__ carrying a cost and a duration']))
    expect(hidden).toHaveLength(1)
    expect(usableSamples(hidden, 'duration_ms')).toEqual([])
    const scoped = walk(tagged('{"__proto__":{"run_id":"run-1"},"ts":5,"verdict":"pass"}'))
    expect(belongsToRun(scoped[0], 'run-1')).toBe(false)
  })

  it('cannot be talked into reading a JSON ARRAY as an event by an earlier line', () => {
    // FALSIFYING THE FIRST SELF-REPORTED DELTA at its only escape hatch. The claim is that the
    // aggregator's new `Array.isArray` rejection is unobservable because a JSON array cannot
    // carry a numeric `ts` — which is true of `[].ts` only while nothing has put a `ts` on
    // `Array.prototype`. The log is the one input a foreign writer controls, so the question is
    // whether a LINE can do that before the array line is read. It cannot: `JSON.parse` writes
    // `__proto__` as an own property and touches no prototype, so the array on the second line
    // below is `ts`-less however hard the first line tries.
    const attack = [
      tagged('{"__proto__":{"ts":5,"verdict":"pass","issue_number":9}}'),
      tagged('["ts",5]'),
      tagged('[{"ts":5,"verdict":"pass","issue_number":9}]'),
      tagged('[]'),
    ].join('\n')
    expect(aggregateCycleCounts(attack, 0)).toEqual({
      ok: 0,
      failed: 0,
      processed: 0,
      okIssues: [],
      failedIssues: [],
    })
    expect(Array.prototype.ts).toBe(undefined)
    // ...and the array lines are not events for anybody, which is the agreement half.
    expect(walk(attack)).toHaveLength(1)
    expect(parseIssueEvents(attack)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------
// 3. Generator hazards — the shapes three arrays could not have had.
// ---------------------------------------------------------------------------------------------
describe('QA #121 the walk is a generator, with everything that costs', () => {
  const TWO = [line({ issue_number: 29, ts: 1 }), line({ issue_number: 30, ts: 2 })].join('\n')

  it('is EXHAUSTED by its first walk — which is why parseIssueEvents spreads', () => {
    // The hazard a returned array never had. This is not a complaint about the generator, it is
    // the reason the one caller whose consumers re-read their events must materialise it: hand
    // the generator itself to a caller that iterates twice and the second pass silently sees an
    // empty log. Pinned so the note in `parseIssueEvents` is a fact rather than a claim.
    const once = issueEvents(TWO)
    expect([...once]).toHaveLength(2)
    expect([...once]).toEqual([])
    // ...and a fresh call is a fresh walk, so nothing is cached across callers.
    expect([...issueEvents(TWO)]).toHaveLength(2)
  })

  it('survives being abandoned mid-line, by break, by return() and by throw()', () => {
    // `aggregateCycleCounts` walks to the end, but the generator is exported and a future
    // consumer that only wants the first event (or the first of a given run) will `break`. A
    // generator abandoned inside its `for` loop must simply close: no half-parsed state, no
    // exception on the way out, and no effect on any other walk of the same text.
    const abandoned = issueEvents(TWO)
    for (const event of abandoned) {
      expect(event).toEqual({ issue_number: 29, ts: 1 })
      break
    }
    expect(abandoned.next()).toEqual({ value: undefined, done: true })

    const returned = issueEvents(TWO)
    returned.next()
    expect(returned.return('stop')).toEqual({ value: 'stop', done: true })
    expect(returned.next().done).toBe(true)

    // `throw()` propagates rather than being swallowed, which is correct: the never-throws
    // contract is about the LOG's content, not about a caller injecting an exception into the
    // walk. Pinned so the two promises are not confused for each other.
    const thrown = issueEvents(TWO)
    thrown.next()
    expect(() => thrown.throw(new Error('caller boom'))).toThrow('caller boom')
    // ...and a text already fully read is unaffected by any of the above.
    expect([...issueEvents(TWO)]).toHaveLength(2)
  })

  it('runs two walks over the same text independently, interleaved', () => {
    // `parseIssueEvents` is called from three places on the same text — twice in `progress.js`,
    // once in `lib/post-mortem.js` — and `buildLaunchProjection` reaches both of the first two
    // for one projection, since it parses for the money after `buildProgress` has parsed for the
    // pace. Each call is its own walk over its own `split`, so there is no shared cursor for two
    // of them to fight over — pinned by interleaving them a step at a time, which is the shape a
    // shared `lastIndex` would break.
    const a = issueEvents(TWO)
    const b = issueEvents(TWO)
    expect([a.next().value, b.next().value, a.next().value, b.next().value]).toEqual([
      { issue_number: 29, ts: 1 },
      { issue_number: 29, ts: 1 },
      { issue_number: 30, ts: 2 },
      { issue_number: 30, ts: 2 },
    ])
  })

  it('hands parseIssueEvents’ callers a re-iterable ARRAY, never the walk itself', () => {
    // The seam stated as a type. Its three shipped call sites — `buildProgress` and
    // `buildLaunchProjection` in lib/progress.js, `buildPostMortem` in lib/post-mortem.js —
    // index, filter and window these events, and `Array.isArray` is what says they may.
    const events = parseIssueEvents(TWO)
    expect(Array.isArray(events)).toBe(true)
    expect(events.filter(() => true)).toHaveLength(2)
    expect(events.filter(() => true)).toHaveLength(2) // twice, which a generator could not do
  })

  it('keeps the ALL-TIME pace, which is the number a leaked generator would zero', () => {
    // THE BEHAVIOURAL WITNESS for the spread, and the reason it is not a stylistic choice.
    // `buildProgress` iterates its events twice: once to scope them to the run, and again for
    // the all-time fallback when the run has fewer than two of its own samples. Return the
    // generator from `parseIssueEvents` instead of an array and the first pass consumes it, so
    // the fallback averages an empty set and the pace reads `unknown` — on a log full of
    // durations, for `ralph status` and for the `ralph start` box that borrows this very
    // branch. Asserted as the pace a reader would have seen.
    const history = [
      line({ issue_number: 29, run_id: 'run-0', ts: 1, duration_ms: 60_000, verdict: 'pass' }),
      line({ issue_number: 30, run_id: 'run-0', ts: 2, duration_ms: 120_000, verdict: 'pass' }),
      line({ issue_number: 31, run_id: 'run-1', ts: 3, duration_ms: 180_000, verdict: 'pass' }),
    ].join('\n')
    const snapshot = buildProgress({
      metricsText: history,
      record: { run_id: 'run-1' },
      queue: 2,
      now: 1_000_000,
    })
    // One in-run sample is below the two-sample floor, so the basis falls back to all-time —
    // and all-time is the mean of THREE durations, which only exists if `events` re-iterated.
    expect(snapshot.paceBasis).toBe('all-time')
    expect(snapshot.paceMs).toBe(120_000)
    expect(snapshot.samples).toBe(3)
    // The same branch is what `buildLaunchProjection` borrows by passing no record at all.
    expect(buildLaunchProjection({ metricsText: history, queue: 2, now: 1_000_000 }).paceMs).toBe(
      120_000,
    )
  })
})

// ---------------------------------------------------------------------------------------------
// 4. The coercion seam — deliberately NOT unified, so both sides get pinned.
// ---------------------------------------------------------------------------------------------
describe('QA #121 the coercion boundary, and which reader absorbs which input', () => {
  const HISTORY = [
    line({ issue_number: 29, run_id: 'run-1', ts: 1, verdict: 'pass', duration_ms: 60_000 }),
    line({ issue_number: 30, run_id: 'run-1', ts: 2, verdict: 'fail' }),
  ].join('\n')

  /** A bag whose `toString` throws — the input the never-throws contract is written against. */
  const hostileBag = () => ({
    toString() {
      throw new Error('a log must never be coerced')
    },
  })

  it('reads a Buffer through parseIssueEvents, and refuses it everywhere else', () => {
    // THE ASYMMETRY, PINNED AS A DECISION. `progress.js` keeps `String(jsonlText)` at its own
    // door because progress.launch.qa.test.js drives `launch` with a Buffer on purpose (an
    // injected `readFile` called without an encoding hands one back), while `issueEvents`
    // refuses every non-string so that `banner-model.js` can never run a hostile `toString`.
    // The cost of that choice is exactly this row: the same Buffer is a log to `ralph status`
    // and is not a log to `ralph cycle` or the launch box. Nothing reaches those two with a
    // Buffer today — all three commands read through `safeReadText`, which calls `.toString()`
    // — so this is recorded as the shape of the seam, and it is recorded, because it is the
    // one input for which the three readers of one file still answer differently.
    const buffer = Buffer.from(HISTORY)
    expect(parseIssueEvents(buffer)).toHaveLength(2)
    expect(buildPostMortem({ metricsText: buffer, record: { run_id: 'run-1' }, now: 9 }).ok).toBe(1)
    expect(walk(buffer)).toEqual([])
    expect(newestIssueEvent(buffer)).toBe(null)
    expect(aggregateCycleCounts(buffer, 0).processed).toBe(0)
    expect(resolveBannerModel({ agent: 'claude', metricsText: buffer }).provenance).toBe(
      MODEL_PROVENANCE.UNKNOWN,
    )
  })

  it('refuses a boxed String and a Symbol without coercing either', () => {
    // `new String(text)` is `typeof 'object'`, so the parser's `typeof text !== 'string'` gate
    // refuses it — and a Symbol is the value for which `String(value)` and a template literal
    // disagree, which is what makes it worth naming. Both are refused rather than coerced, on
    // the same rule, and neither throws.
    const boxed = new String(HISTORY)
    expect(walk(boxed)).toEqual([])
    expect(newestIssueEvent(boxed)).toBe(null)
    expect(aggregateCycleCounts(boxed, 0).processed).toBe(0)
    for (const odd of [Symbol('a log'), 1n, () => HISTORY]) {
      expect(() => walk(odd), String(odd)).not.toThrow()
      expect(walk(odd), String(odd)).toEqual([])
      expect(newestIssueEvent(odd), String(odd)).toBe(null)
    }
  })

  it('keeps the launch box alive on a bag whose toString throws — the claim the seam buys', () => {
    // THE POINT OF NOT UNIFYING THE COERCION, asserted where it matters. `banner-model.js`
    // promises never to throw because it type-checks rather than coerces, and it now reaches
    // the log through a shared module — so the shared module has to keep that promise too. A
    // `String(text)` added to `issueEvents` for tidiness would run the `toString` below and
    // take a launch down, and this row is what turns that tidy into a red test.
    expect(() => resolveBannerModel({ agent: 'claude', metricsText: hostileBag() })).not.toThrow()
    expect(resolveBannerModel({ agent: 'claude', metricsText: hostileBag() }).provenance).toBe(
      MODEL_PROVENANCE.UNKNOWN,
    )
    expect(() => newestIssueEvent(hostileBag())).not.toThrow()
    expect(() => walk(hostileBag())).not.toThrow()
    // ...and the cycle aggregator inherits the same protection, which it did NOT have before
    // #121: the old body reached `.split` on any truthy value and threw, against a docblock
    // that promised it never would.
    expect(() => aggregateCycleCounts(hostileBag(), 0)).not.toThrow()
  })

  it('still throws out of parseIssueEvents on that same bag — the boundary, and its keeper', () => {
    // BOUNDARY, NOT A WISH, and unchanged by #121: `parseIssueEvents` coerces at its door, so a
    // value whose `toString` throws throws THROUGH it and out of `ralph status`'s live view and
    // post-mortem, both of whose headers promise never to throw. It is unreachable in the
    // shipped commands — `lib/commands/status.js` reads the log through `safeReadText`, whose
    // `try` spans the coercion and answers '' — so the promise holds for every real caller and
    // the hole is the exported function's. Pinned rather than fixed, with the keeper named, so
    // a future caller that skips `safeReadText` fails a test instead of a launch.
    expect(() => parseIssueEvents(hostileBag())).toThrow()
    expect(() => buildProgress({ metricsText: hostileBag(), queue: 1, now: 9 })).toThrow()
    expect(() => buildPostMortem({ metricsText: hostileBag(), now: 9 })).toThrow()
  })

  it('answers the empty log the same way whether it is missing, blank or unreadable', () => {
    // All five readers, over every spelling of "there is no log". `safeReadText` answers '' for
    // a missing file, an unreadable one and a nullish read, so '' is the shape every consumer
    // really sees — and `undefined`/`null` are what a caller that skipped it passes.
    for (const nothing of ['', undefined, null, '   ', '\n\n']) {
      const label = JSON.stringify(nothing)
      expect(walk(nothing), label).toEqual([])
      expect(parseIssueEvents(nothing), label).toEqual([])
      expect(newestIssueEvent(nothing), label).toBe(null)
      expect(aggregateCycleCounts(nothing, 0), label).toEqual({
        ok: 0,
        failed: 0,
        processed: 0,
        okIssues: [],
        failedIssues: [],
      })
      expect(resolveBannerModel({ agent: 'claude', metricsText: nothing }).provenance, label).toBe(
        MODEL_PROVENANCE.UNKNOWN,
      )
    }
  })
})

// ---------------------------------------------------------------------------------------------
// 5. The agreement itself — one hostile log, every reader of it.
// ---------------------------------------------------------------------------------------------
describe('QA #121 every reader of issues.jsonl agrees about one hostile log', () => {
  // THE MARQUEE CASE, built to the issue's own description of the interesting one: a tail the
  // loop was killed halfway through, a middle line that is a JSON array, and a newest COMPLETE
  // event that names no model. Each of those is a line one reader used to gate differently from
  // another, and all three are in the same text so a disagreement shows up as a contradiction
  // rather than as a difference of opinion about a different file.
  const HOSTILE = [
    'npm WARN deprecated something', // pipeline noise
    line({ issue_number: 29, run_id: 'run-1', ts: 1, verdict: 'pass', model: 'claude-opus-5' }),
    tagged('[{"issue_number":30,"ts":2,"verdict":"pass"}]'), // an array: nobody's event
    `10:00:02 | ${line({ issue_number: 31, run_id: 'run-1', ts: 3, verdict: 'fail' })}`,
    tagged('null'), // valid JSON, not an event
    line({ issue_number: 32, run_id: 'run-1', ts: 4, verdict: 'pass' }), // NEWEST: no model
    tagged('{"issue_number":33,"run_id":"run-1","ts":5,"verd'), // killed mid-append
  ].join('\n')

  it('yields the same three events to the forward walk and to parseIssueEvents', () => {
    // The two forward readers, over the identical gate. `ralph status` and `ralph cycle` see
    // one file and must see one set of events in it; the count is spelled out so a gate that
    // started admitting the array or the `null` fails by a number.
    expect(walk(HOSTILE)).toEqual(parseIssueEvents(HOSTILE))
    expect(walk(HOSTILE).map((event) => event.issue_number)).toEqual([29, 31, 32])
  })

  it('answers the reverse walk with the forward walk’s LAST yield, not with the tail', () => {
    // The half-written tail and the `null` line are both skipped from the end, so the newest
    // event is #032 — the same object the forward walk finishes on. This is the biconditional
    // #121 exists for, asserted across the two DIRECTIONS on one text.
    expect(newestIssueEvent(HOSTILE)).toEqual(walk(HOSTILE).at(-1))
    expect(newestIssueEvent(HOSTILE).issue_number).toBe(32)
  })

  it('tallies the same three events in the cycle summary, conservatively', () => {
    // `ralph cycle`'s accounting, derived from the SAME event list rather than restated: two
    // passes and one fail, with the array, the `null`, the noise and the tail contributing
    // nothing. Computed from `parseIssueEvents` so the two consumers are held to each other and
    // not to a hand-written expectation that could drift with them.
    const events = parseIssueEvents(HOSTILE)
    const dated = events.filter((event) => Number.isFinite(event.ts))
    expect(aggregateCycleCounts(HOSTILE, 0)).toEqual({
      ok: dated.filter((event) => event.verdict === 'pass').length,
      failed: dated.filter((event) => event.verdict !== 'pass').length,
      processed: dated.length,
      okIssues: [29, 32],
      failedIssues: [31],
    })
  })

  it('gives the post-mortem the same counts the cycle summary reports for that run', () => {
    // `ralph cycle` prints the tally at the end of a run and `ralph status` prints the report
    // card afterwards, over the same file and the same conservative rule (`pass` is ok,
    // everything else is a failure). Two modules, two policies, one event list — so the two
    // numbers a reader compares by eye are asserted equal here.
    const cycle = aggregateCycleCounts(HOSTILE, 0)
    const card = buildPostMortem({
      metricsText: HOSTILE,
      record: { run_id: 'run-1', status: 'running' },
      queue: 0,
      now: 9,
    })
    expect({ ok: card.ok, failed: card.failed }).toEqual({ ok: cycle.ok, failed: cycle.failed })
    expect(card.failedNumbers).toEqual(cycle.failedIssues)
  })

  it('answers UNKNOWN in the launch box, because the newest event names no model', () => {
    // THE CORRECTNESS ARGUMENT FOR THE EARLY RETURN, end to end rather than at the parser. The
    // newest complete event (#032) carries no `model`, and #029 three lines above it does. The
    // reverse walk must STOP at #032 so the box answers `unknown` — reaching back to #029 would
    // print `claude-opus-5` under a `last-run` tag, which is a lie about which run it was and
    // exactly the over-confidence the provenance tag exists to prevent.
    const answer = resolveBannerModel({ agent: 'claude', metricsText: HOSTILE })
    expect(answer).toEqual({
      agent: 'claude',
      model: null,
      contextWindow: null,
      provenance: MODEL_PROVENANCE.UNKNOWN,
    })
    // ...and the model that was NOT reached is really in the text, so the row is not passing
    // because the fixture forgot to put one there.
    expect(HOSTILE).toContain('claude-opus-5')
  })

  it('counts the same three events in the live view and in the launch projection', () => {
    // The last two consumers, both through `parseIssueEvents`: the live view's `completed` is
    // the run's own events and the launch box's samples are every event ever recorded. Neither
    // may count the array, the `null` or the tail.
    const snapshot = buildProgress({
      metricsText: HOSTILE,
      record: { run_id: 'run-1' },
      queue: 1,
      now: 9,
    })
    expect(snapshot.completed).toBe(3)
    expect(buildLaunchProjection({ metricsText: HOSTILE, queue: 1, now: 9 }).basis).toBe('unknown')
  })

  it('reads the same log the same way with and without its trailing newline', () => {
    // The file is appended to WHILE it is read, so a reader can catch it either side of the
    // newline that terminates a line. Both readings must agree, in both directions, or the box
    // and the status view would disagree depending on the millisecond they read.
    for (const text of [HOSTILE, `${HOSTILE}\n`, `${HOSTILE}\n\n`]) {
      expect(walk(text).length, JSON.stringify(text.slice(-4))).toBe(3)
      expect(newestIssueEvent(text).issue_number).toBe(32)
      expect(aggregateCycleCounts(text, 0).processed).toBe(3)
    }
  })

  it('throws out of the live view on a run_id that cannot be coerced — a PRE-EXISTING hole', () => {
    // FOUND WHILE ATTACKING #121 AND NOT CAUSED BY IT. `belongsToRun` scopes events to a run
    // with `String(event.run_id)`, and a payload whose `run_id` shadows BOTH `toString` and
    // `valueOf` with non-callables has no primitive form — so the coercion raises a TypeError
    // out of `buildProgress` and `buildPostMortem`, both of which promise in their own headers
    // never to throw for a log line. The gate #121 replaced admitted the identical object (it
    // read `!event || typeof event !== 'object' || Array.isArray(event)`), so this is the state
    // of the tree before and after the extraction; it is pinned here rather than left silent
    // because the alternative is a `ralph status` that dies on a hand-edited or foreign-written
    // `.ralph/metrics/issues.jsonl`, and nothing in the tree says so. A fix belongs in
    // `belongsToRun` — a `typeof`-gated compare, the rule every other reader of an untrusted
    // field in this repo already uses — and it turns this row red, which is the point.
    const unstringifiable = tagged('{"run_id":{"toString":"x","valueOf":"y"},"ts":5}')
    const text = [unstringifiable, line({ run_id: 'run-1', ts: 6, verdict: 'pass' })].join('\n')
    // The parse itself is clean: the line IS an event, and every reader that does not scope by
    // run reads it without complaint.
    expect(walk(text)).toHaveLength(2)
    expect(aggregateCycleCounts(text, 0).processed).toBe(2)
    expect(newestIssueEvent(text).run_id).toBe('run-1')
    // ...and the two run-scoped readers are the ones that die.
    expect(() =>
      buildProgress({ metricsText: text, record: { run_id: 'run-1' }, queue: 1, now: 9 }),
    ).toThrow(TypeError)
    expect(() =>
      buildPostMortem({ metricsText: text, record: { run_id: 'run-1' }, queue: 1, now: 9 }),
    ).toThrow(TypeError)
    // The launch box takes no record, so it never scopes and never coerces — which is why the
    // hole has gone unnoticed: the one command that reads this file before a run is immune.
    expect(() => buildLaunchProjection({ metricsText: text, queue: 1, now: 9 })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------------------------
// 6. The four re-aimed purity guards — still forbidding, and one claim restored.
// ---------------------------------------------------------------------------------------------
describe('QA #121 the re-aimed static guards fire on a planted edge', () => {
  // The four guards #121 edited, and the matcher each one uses. Replicated here rather than
  // imported (a test file exports nothing), so each replica is held to the guard's own source
  // by the pin below — a guard that changes its matcher fails HERE, by name, instead of leaving
  // this witness quietly proving something about a matcher nobody runs.
  const SPECIFIERS = /from\s*['"]([^'"]+)['"]/g
  const BANNER_IMPORTS = /^import .* from '(.*)'$/gm
  const specifiers = (code) => [...code.matchAll(SPECIFIERS)].map((m) => m[1])
  const bannerSpecifiers = (code) => [...code.matchAll(BANNER_IMPORTS)].map((m) => m[1]).sort()

  // Each entry is [the matcher the guard uses, a fragment proving it compares the RESULT with
  // `toEqual`]. Both halves matter: the matcher is what this block replicates, and the `toEqual`
  // is the difference between "these are the imports" and "these imports are allowed" — a
  // `toContain` or an `arrayContaining` would let a fifth edge in silently, which is precisely
  // how a re-aimed guard becomes a relaxed one.
  const GUARDS = {
    'lib/progress.qa.test.js': [
      `matchAll(/from\\s*['"]([^'"]+)['"]/g)`,
      `.map((m) => m[1])).toEqual([`,
    ],
    'lib/progress.table.qa.test.js': [
      `matchAll(/from\\s*['"]([^'"]+)['"]/g)`,
      `.map((m) => m[1])).toEqual([`,
    ],
    'lib/banner-model.test.js': [
      `matchAll(/^import .* from '(.*)'$/gm)`,
      `.map((m) => m[1]).sort()).toEqual([`,
    ],
    'lib/issue-event-lines.test.js': [
      `matchAll(/from\\s*['"]([^'"]+)['"]/g)`,
      `.map((m) => m[1])).toEqual([])`,
    ],
    // #116's extraction guard, whose own matcher predates #121 and reads the CLAUSE as well as
    // the specifier — which is what lets it say which NAMES moved and not only which files are
    // imported. #121 re-aimed the name lists it feeds, not the matcher, so its exactness pin is
    // spelled differently: it sorts the specifiers reaching out of the box's module.
    'lib/git-remote-slug.extraction.qa.test.js': [
      `/import\\s*\\{([^}]*)\\}\\s*from\\s*'([^']+)'/g`,
      `outOf('lib/banner-model.js').sort()).toEqual([`,
    ],
  }

  it('uses the same matcher the guards do, and each guard still pins an exact list', () => {
    // The link between this block and the guards it is vouching for: a guard that changes either
    // half fails HERE, by file name, instead of leaving this witness quietly proving something
    // about a matcher nobody runs.
    for (const [file, [matcher, exactness]] of Object.entries(GUARDS)) {
      const source = codeWithoutComments(join(LIB, '..', file))
      expect(source, `${file}: still uses the replicated matcher`).toContain(matcher)
      expect(source, `${file}: still reads the new edge`).toContain('issue-event-lines.js')
      expect(source, `${file}: still pins its list as an EXACT list`).toContain(exactness)
    }
  })

  it('fails on a node:fs import planted in lib/issue-event-lines.js', () => {
    // The far end of the two new edges, which is the whole reason they are safe: both
    // `banner-model.js` and `progress.js` are asserted pure, and importing a module that itself
    // reaches `node:fs` would launder the capability straight through. Three guards read this
    // file's imports; all three must fire.
    const planted = `import { readFileSync } from 'node:fs'\n${codeWithoutComments(
      join(LIB, 'issue-event-lines.js'),
    )}`
    expect(specifiers(planted)).toContain('node:fs')
    expect(specifiers(planted)).not.toEqual([])
    expect(planted).toMatch(/node:/)
  })

  it('fails on a second import planted in lib/banner-model.js and lib/progress.js', () => {
    // The near end. Both lists are pinned as exact sets, so a third edge out of the box's
    // module and a second out of the pure projection module each break their own row —
    // including the case the argument for #121 turns on, an edge to the module that holds
    // `node:fs`.
    const model = codeWithoutComments(join(LIB, 'banner-model.js'))
    const progress = codeWithoutComments(join(LIB, 'progress.js'))
    // The unmutated readings first, so a mutation that changed nothing cannot pass this row.
    expect(bannerSpecifiers(model)).toEqual(['./issue-event-lines.js', './issue-event.js'])
    expect(specifiers(progress)).toEqual(['./issue-event-lines.js'])
    const EDGES = ["import { metricsPath } from './issue-metrics.js'", `import x from 'y'`]
    for (const planted of EDGES) {
      expect(bannerSpecifiers(`${planted}\n${model}`)).not.toEqual([
        './issue-event-lines.js',
        './issue-event.js',
      ])
      expect(specifiers(`${planted}\n${progress}`)).not.toEqual(['./issue-event-lines.js'])
    }
  })

  it('fails on the tag re-inlined into banner-model.js, per the extraction sweep', () => {
    // #116's drift sweep, re-aimed by #121: `ISSUE_EVENT_TAG` must be absent from the box's
    // module and present in the grammar's. The "half left behind" this catches is the most
    // likely regression of all — a later edit that needs the tag and spells it locally rather
    // than importing it, which is exactly how there came to be four copies.
    const named = (code, name) => new RegExp(`\\b${name}\\b`).test(code)
    const model = codeWithoutComments(join(LIB, 'banner-model.js'))
    expect(named(model, 'ISSUE_EVENT_TAG')).toBe(false)
    expect(named(`const ISSUE_EVENT_TAG = 'x'\n${model}`, 'ISSUE_EVENT_TAG')).toBe(true)
    // ...and the retired local name cannot come back under its old spelling, while the new one
    // is not a false positive for it.
    expect(named(model, 'newestEvent')).toBe(false)
    expect(named(model, 'newestIssueEvent')).toBe(true)
  })

  it('restores the claim the re-aim dropped: progress.js has ONE import STATEMENT', () => {
    // THE ONE PLACE A RE-AIMED GUARD WAS GENUINELY WEAKENED, and the reason this row exists.
    // progress.qa.test.js used to assert `not.toMatch(/^\s*import\s/m)` — no import statement of
    // any kind. #121 replaced that with a pinned list of `from` SPECIFIERS, which is stronger
    // about named imports and blind to the shape that has none: a side-effect import,
    // `import './evil.js'`, matches no `from` and so passes every row the re-aim left behind.
    // (`import 'node:fs'` is still caught, but only by accident, and only by
    // progress.table.qa.test.js's separate `not.toMatch(/node:/)`.) A side-effect import runs a
    // module for its effects at load, which is precisely the capability the purity claim is
    // about — so the statement COUNT is asserted here beside the specifier list, and the same
    // count is asserted for the other two modules in the seam so the rule is one rule.
    const statements = (code) => [...code.matchAll(/^\s*import\b/gm)].length
    for (const [file, expected] of [
      ['progress.js', 1],
      ['banner-model.js', 2],
      ['issue-event-lines.js', 0],
    ]) {
      const code = codeWithoutComments(join(LIB, file))
      expect(statements(code), file).toBe(expected)
      // ...and the count really would move: a side-effect import is invisible to the specifier
      // matcher and visible to this one, which is the gap being closed.
      const planted = `import './evil.js'\n${code}`
      expect(specifiers(planted), file).toEqual(specifiers(code))
      expect(statements(planted), file).toBe(expected + 1)
    }
  })
})
