// Post-mortem policy (#59) — the report card `ralph status` prints once the run is
// over: how many tasks passed, WHICH ones did not, what the night cost in total and
// per task, how long the run took, when it ended and how long ago that was. One
// command then answers both of the reader's questions — "how is it going?" from the
// live view, "how did last night go?" from this one.
//
// WHY A SECOND MODULE instead of more of lib/progress.js: that one answers the
// bedtime question from a run in flight, and every number in it — pace, ETA,
// projected spend — is an extrapolation with a confidence to defend. Nothing here is
// extrapolated: the run is over, so every number is a fact already on disk. Two
// questions, two policies. The one thing they share is the file they read, and they
// read it through the same parser (see the imports) rather than through two.
//
// PURE, with no exceptions, for progress.js's reason: no fs, no network, no
// `Date.now`, no ambient clock. The metrics text, the run record, the queue depth and
// `now` are all passed in, so every line below is pinned by a unit test instead of by
// the machine the suite happens to run on. lib/commands/status.js is the I/O shell.
//
// THE UNKNOWN DISCIPLINE, inherited verbatim: every output is `null` — rendered
// `unknown` — the moment its inputs are missing, and no zero ever stands in for
// absent data. It matters MORE here than in the live view, because the records this
// module reads are exactly the ones a kill, a reboot or an older release left
// half-written: `0 failed` on a run that never recorded a count is a report card
// asserting a clean night nobody observed.
//
// TWO SOURCES FOR THE COUNTS, IN THIS ORDER. The record's own `ok`/`failed` when the
// loop got to write them — endRun writes them authoritatively, having watched every
// iteration, including the ones that never reached issues.jsonl. Otherwise a tally of
// the run's own events, where `pass` is ok and EVERYTHING else (`fail`, `unknown`) is
// failed, the same conservative accounting aggregateCycleCounts uses in
// lib/issue-metrics.js. The fallback is what makes an INTERRUPTED run readable at
// all: it never reached endRun, so its record carries no counts, and the events it
// appended on the way are the only surviving account of what it finished.
//
// AN INTERRUPTED RUN HAS NO FINISH, and `now` is never substituted for one. A run
// killed at 03:00 and noticed at 09:00 did not run for nine hours, so its finish
// time, its age and its total wall clock all read `unknown` — while its counts, its
// failed numbers and its spend, which it did record, print normally. That state is
// the one a hard-killed overnight run leaves behind, and the one most worth reading.
//
// WHAT AN INTERRUPTED CARD ADDS INSTEAD (#59 review): the run's START and its age,
// and the last task the record was on. Both are facts already on the record, and
// with no finish to anchor it the card would otherwise answer "when?" with nothing
// at all — a reader could not tell a run killed five minutes ago from one killed
// last week, nor which task it died on. They appear ONLY on an interrupted card,
// because a finished run has both readings already (its finish, its age and its wall
// clock) and the task it last worked on is simply the one it finished.
//
// The FAILED NUMBERS live only in the events, so they are scoped to the record's run
// id like every other per-run number, and an absent id matches nothing rather than
// everything (belongsToRun). Zero failures renders no list at all: an empty `—` reads
// as a list the renderer forgot to fill in.

import {
  belongsToRun,
  calendarInstantOrNull,
  finiteOrNull,
  formatClock,
  formatElapsed,
  padTaskNumber,
  parseIssueEvents,
  row,
  runIdOrNull,
  sum,
  usableSamples,
} from './progress.js'

// The snapshot. One object, recomputed on every call; every numeric field is either
// `null` or finite, the invariant progress.js states and this module keeps. Fields:
//   runId          — the run this card is about, or null
//   interrupted    — the record still says `running`: it never recorded an end
//   ok / failed    — outcome counts, from the record or tallied, or null
//   failedNumbers  — the task numbers behind `failed`, in file order (may be empty)
//   spendUsd       — total recorded cost for the run, or null
//   costPerTaskUsd — that total over the tasks that RECORDED a cost, or null
//   wallMs         — finished_at − started_at, or null
//   finishedAt     — epoch ms of the finish, or null
//   ageMs          — now − finishedAt, or null
//   startedAt      — epoch ms of the run's start, or null
//   startedAgeMs   — now − startedAt, or null
//   lastTaskNumber — the last task the record was on, or null
//   queue          — tasks waiting right now, or null
export function buildPostMortem({ metricsText, record, queue, now } = {}) {
  const runId = runIdOrNull(record?.run_id)
  const runEvents = parseIssueEvents(metricsText).filter((event) => belongsToRun(event, runId))

  // Tallied unconditionally, because the failed NUMBERS only ever come from here —
  // the record counts them but cannot name them.
  const tallied = tallyVerdicts(runEvents)
  const ok = finiteOrNull(record?.ok) ?? tallied.ok
  const failed = finiteOrNull(record?.failed) ?? tallied.failed

  // Rated over the tasks that RECORDED a cost, not over every completed task: a
  // mixed Claude/Codex run would otherwise report a rate half its real one. Same
  // rule, and the same `usableSamples`, as the live view's costPerTaskUsd.
  const costs = usableSamples(runEvents, 'total_cost_usd')
  const spendUsd = costs.length > 0 ? finiteOrNull(sum(costs)) : null
  const costPerTaskUsd = spendUsd == null ? null : spendUsd / costs.length

  const startedAt = finiteOrNull(Date.parse(record?.started_at))
  const finishedAt = finiteOrNull(Date.parse(record?.finished_at))
  const nowMs = finiteOrNull(now)
  // Both null-guarded before the subtraction rather than after: `null - x` is a
  // NUMBER in JS, so a missing stamp would otherwise report a run that took negative
  // eternity, or an age measured from 1970.
  const wallMs =
    startedAt == null || finishedAt == null ? null : finiteOrNull(finishedAt - startedAt)
  const ageMs = finishedAt == null || nowMs == null ? null : finiteOrNull(nowMs - finishedAt)
  // The age of the START, which is a different question from the age of the finish
  // and the only one an interrupted run can answer. Measuring it from `now` is not the
  // substitution the paragraph above refuses: "the run began 3h12m ago" is true of a
  // run that is over, whereas "it ran for 3h12m" would not be.
  const startedAgeMs = startedAt == null || nowMs == null ? null : finiteOrNull(nowMs - startedAt)

  return {
    runId,
    // The record still claims to be running, so nothing ever wrote its ending. The
    // caller has already established the run is gone (that is what makes the mode
    // `interrupted`); this is the same fact read off the record itself, which keeps
    // the renderer a function of the snapshot alone.
    interrupted: record?.status === 'running',
    ok,
    failed,
    failedNumbers: tallied.failedNumbers,
    spendUsd,
    costPerTaskUsd,
    wallMs,
    finishedAt,
    ageMs,
    startedAt,
    startedAgeMs,
    // The task the record was on when it stopped. Read HERE rather than in the
    // renderer, so the card stays a function of the snapshot alone and the record
    // never has to be threaded through two layers. `endRun` keeps this field on a
    // terminal record on purpose (it is the last task the run worked on), which is
    // exactly why the live view's in-flight count may not read it — see the liveness
    // gate in progress.js.
    lastTaskNumber: finiteOrNull(record?.current?.number),
    queue: finiteOrNull(queue),
  }
}

// The card, in the live view's label column so the two readings look like one
// command's output. PURE: a snapshot in, strings out. Every value says `unknown`
// rather than a number it cannot stand behind, and each segment with no data is
// simply absent — the reader must never have to work out whether `$0.00` means a free
// run or an unrecorded one.
export function renderPostMortem(snapshot) {
  const {
    runId,
    interrupted,
    ok,
    failed,
    failedNumbers,
    spendUsd,
    costPerTaskUsd,
    wallMs,
    finishedAt,
    ageMs,
    startedAt,
    startedAgeMs,
    lastTaskNumber,
    queue,
  } = snapshot ?? {}

  return [
    // Same grammar as the live heading's `(started 16:20, 3h12m ago)`, so the mode
    // word is the only thing a reader has to notice to know which view this is.
    `▸ ralph — ${interrupted ? 'interrupted' : 'idle'} · run ${runId || 'unknown'} ` +
      `(${finishPhrase(finishedAt, ageMs)})`,
    row('outcome', [outcomePhrase(ok, failed, failedNumbers)]),
    // Money that was RECORDED prints exactly, trailing zeros and all — `$268.10` is a
    // sum. The average is a rate, so it gets one decimal, matching the live view's
    // `$31.4/task`.
    row('spend', [
      spendUsd == null ? 'unknown' : `$${spendUsd.toFixed(2)} total`,
      costPerTaskUsd == null ? null : `$${costPerTaskUsd.toFixed(1)}/task avg`,
    ]),
    // formatElapsed already answers `unknown` for a duration it cannot compute, and
    // clamps a negative one (two stamps written by two clocks) to `0min`.
    row('ran for', [formatElapsed(wallMs)]),
    // The queue as it is NOW, not as the ended run left it: the next `ralph start`
    // picks up whatever is waiting at this moment, which is the number the hint below
    // is about.
    row('queue', [queue == null ? 'unknown' : `${queue} waiting`]),
    // The interrupted-only pair, AFTER the four readings above rather than beside the
    // duration they belong with: those four are the ones a reader goes looking for, and
    // they stay on the same rows in both modes so the card is read the same way twice.
    // A killed run then gets two extra rows, which is a shape change a reader notices
    // deliberately.
    ...(interrupted
      ? [
          row('started', [instantPhrase(startedAt, startedAgeMs)]),
          row('last task', [
            lastTaskNumber == null ? 'unknown' : `#${padTaskNumber(lastTaskNumber)}`,
          ]),
        ]
      : []),
    '',
    // One command, two labels: a killed run is restarted, a finished one starts its
    // next batch, and the verb is the only thing that differs.
    row(interrupted ? 'restart' : 'start', ['ralph start']),
  ]
}

// `7 ok · 2 failed  — #034 #041`. The counts are dropped individually when the record
// never recorded them, `unknown` when neither survives, and the failed list is absent
// rather than empty when nothing failed (AC: no dangling `—`).
function outcomePhrase(ok, failed, failedNumbers) {
  const counts = [countSegment(ok, 'ok'), countSegment(failed, 'failed')]
    .filter(Boolean)
    .join(' · ')
  if (counts === '') return 'unknown'
  // The list is an EXPLANATION of the failed count, so a count of zero silences it
  // even when the tally found names. That happens for real: events written before the
  // loop recorded a verdict tally as failures (everything that is not `pass` is), and
  // `0 failed  — #029 #030` would contradict itself on the same line. The record's
  // count is the authority; the numbers only ever annotate it.
  const numbers = failed === 0 ? [] : (failedNumbers ?? []).map((n) => `#${padTaskNumber(n)}`)
  return numbers.length === 0 ? counts : `${counts}  — ${numbers.join(' ')}`
}

function countSegment(value, label) {
  return finiteOrNull(value) == null ? null : `${value} ${label}`
}

// `finished 06:12, 2h18m ago`. No finish recorded (an interrupted run) reads
// `finished unknown`, never `--:--` beside an age measured from a finish that never
// happened.
function finishPhrase(finishedAt, ageMs) {
  return `finished ${instantPhrase(finishedAt, ageMs)}`
}

// `06:12, 2h18m ago` — the wall clock the reader remembers plus the age that tells
// them whether it is last night's run or last week's. One phrase for both instants the
// card can print, the finish and (interrupted only) the start.
//
// The instant goes through the CALENDAR guard, not merely a finite one (#59 review):
// `Date.parse` of a stamp nobody validated can answer a finite number the calendar
// cannot spell, and `new Date(8.7e15)` is an Invalid Date whose getters are all NaN.
// An instant that cannot be spelled is treated as ABSENT — `unknown`, the word this
// card already uses for every reading it does not have, rather than the `--:--` a
// formatter answers a caller with. The age is dropped with it: an age measured from an
// instant we refuse to print is a number with nothing to anchor it.
function instantPhrase(at, ageMs) {
  const instant = calendarInstantOrNull(at)
  if (instant == null) return 'unknown'
  return `${formatClock(instant)}${ageMs == null ? '' : `, ${formatElapsed(ageMs)} ago`}`
}

// `pass` is ok, everything else is failed — the loop's own conservative accounting,
// where an indeterminate iteration counts against the run. Returns nulls rather than
// zeros for a run with no events at all: "we found no record of this run" is not "it
// completed nothing".
function tallyVerdicts(events) {
  if (events.length === 0) return { ok: null, failed: null, failedNumbers: [] }
  let ok = 0
  let failed = 0
  const failedNumbers = []
  for (const event of events) {
    if (event.verdict === 'pass') {
      ok += 1
      continue
    }
    failed += 1
    // Only the ones it can name: an event with no usable issue number still counts
    // as a failure, it just cannot appear in the list.
    const number = finiteOrNull(event.issue_number)
    if (number != null) failedNumbers.push(number)
  }
  return { ok, failed, failedNumbers }
}
