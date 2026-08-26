// Progress policy (#57) — the three numbers that make `ralph status` worth
// running before bed: the pace the run is actually holding, an ETA with an honest
// range and a wall-clock finish time, and the spend so far plus where it lands.
//
// PURE, with no exceptions: no fs, no network, no `Date.now`, no ambient clock.
// The metrics file's raw text, the run record, the live queue depth and `now` are
// all passed in, so every number below is pinned by a unit test instead of by the
// machine the suite happens to run on. lib/commands/status.js is the I/O shell
// that reads those inputs and hands them over.
//
// THE UNKNOWN DISCIPLINE, which is the whole point of the module: the reader is
// deciding whether to go to sleep. A guessed ETA is worse than no ETA, so every
// output is `null` — rendered `unknown` — the moment its inputs are missing. No
// zeros standing in for absent data, no pace invented from a single sample's
// worth of nothing, no projection when the run recorded no cost.
//
// Stated as one invariant, because it is the property the QA sweep pins: EVERY
// numeric field of the snapshot is either `null` or finite. That holds for the
// DERIVED values too, not just the parsed ones — issues.jsonl is untrusted
// append-only text, and magnitudes that each pass a finite check can still
// overflow their own sum or product. `Infinity` is an invented number like any
// other, and it renders worse than one: `~Infinity min/task`, or the hybrid
// `~unknown left → ~--:--` where half a line degraded and half did not.
//
// WHY THE PACE IS THE LAST THREE, not a lifetime average: a queue's difficulty
// drifts, and the tasks a run just finished track the tasks it is about to pick up
// far better than every task ever recorded. The all-time mean is the FALLBACK,
// for a run too young to have an opinion of its own — and the snapshot records
// which of the two answered (`paceBasis`) so a surprising estimate is
// inspectable rather than mysterious.
//
// This module also owns `formatElapsed` and `formatClock`: they were #55's, they
// are pure time formatters, and the ETA line needs both. Rather than duplicate
// 20 lines of formatting in a second file, they live here — in the pure module
// that now does all of the live view's time arithmetic — and status.js re-exports
// them so #55's callers and tests are untouched.

const ISSUE_EVENT_TAG = 'RALPH_ISSUE_EVENT '

// How many recent tasks the in-run pace averages, and the fewest it will accept
// before falling back to the all-time mean. Two is the floor because one sample
// is an anecdote: a single 6-minute typo fix would promise the whole queue in an
// hour.
const PACE_WINDOW = 3
const PACE_MIN_SAMPLES = 2

// The live view's label column, matching the `  in flight  ` / `  queue      `
// lines in lib/commands/status.js so the labels align down the block.
const LABEL_WIDTH = 11

// The ± is rounded to five minutes, and a projection to a coarse dollar grid
// (below), for the same reason: they are guesses about a guess. `±1h31m` and
// `~$251.40` claim a precision the two samples behind them do not have — which is
// exactly the false precision the issue asks us not to print.
const SPREAD_ROUND_MS = 5 * 60000

// The three values `paceBasis` can take. Recorded in the snapshot so a surprising
// estimate is inspectable — and so the next slice's `--json` can expose it.
const PACE_BASIS = {
  lastInRun: 'last3-in-run',
  allTime: 'all-time',
  unknown: 'unknown',
}

// The snapshot. One object, recomputed on every call — nothing here is cached or
// frozen, because a status view that reports a stale denominator is the bug this
// replaces. Fields:
//   paceBasis       — 'last3-in-run' | 'all-time' | 'unknown'
//   paceMs          — mean ms per task on that basis, or null
//   paceMinMs/MaxMs — the observed extremes of the SAME samples, or null
//   samples         — how many durations backed the pace
//   completed       — tasks this run has recorded, pass or fail
//   inFlight        — 1 while a task is in flight, else 0
//   remaining       — tasks still waiting (the live queue depth), or null
//   total           — the live denominator: completed + inFlight + remaining
//   etaMs           — ms until the queue is empty, or null
//   finishAt        — epoch ms of that finish, or null
//   spreadMs        — the ± around etaMs, or null
//   spendUsd        — cost this run has recorded, or null
//   costPerTaskUsd  — the observed rate behind the projection, or null
//   projectedUsd    — spendUsd + remaining × rate, or null
export function buildProgress({ metricsText, record, queue, now } = {}) {
  const runId = record?.run_id
  const events = parseIssueEvents(metricsText)
  const runEvents = events.filter((event) => belongsToRun(event, runId))

  // The pace, and the spread, over ONE sample set: reporting a mean from the last
  // three and a range from the whole history would describe two different runs.
  const inRunDurations = usableSamples(runEvents, 'duration_ms').slice(-PACE_WINDOW)
  const [candidates, basis] =
    inRunDurations.length >= PACE_MIN_SAMPLES
      ? [inRunDurations, PACE_BASIS.lastInRun]
      : [usableSamples(events, 'duration_ms'), PACE_BASIS.allTime]
  // finiteOrNull on the MEAN, not only on each sample: finite magnitudes still
  // overflow their own sum. An empty set reaches the same null by the same route
  // (0/0 → NaN).
  const paceMs = finiteOrNull(mean(candidates))
  // A pace that cannot be computed finitely drops its samples with it, so the
  // basis, the count and the extremes never describe a pace that is not there.
  const paceSamples = paceMs == null ? [] : candidates
  const paceMinMs = paceSamples.length > 0 ? Math.min(...paceSamples) : null
  const paceMaxMs = paceSamples.length > 0 ? Math.max(...paceSamples) : null

  const completed = runEvents.length
  const inFlight = record?.current ? 1 : 0
  // The LIVE denominator, rebuilt here on every call from the queue depth the
  // shell just counted — never from `queue_at_start`. Items are opened and closed
  // while a run is going, and a denominator frozen at launch makes both the
  // fraction and the ETA drift silently away from the truth.
  const liveQueue = finiteOrNull(queue)
  const remaining = liveQueue == null ? null : Math.max(0, liveQueue)
  const total = remaining == null ? null : completed + inFlight + remaining

  // What is left of the in-flight task's estimate, floored at zero: a task that
  // has already run longer than the pace predicted cannot push the finish line
  // further out on its own, and must never make the ETA count backwards.
  const inFlightRemainingMs =
    inFlight && paceMs != null ? Math.max(0, paceMs - elapsedOf(record?.current, now)) : 0
  // Every product and sum below is re-checked the same way: a huge queue depth
  // times a finite pace overflows from two inputs that each passed their own
  // guard, and `~Infinity min/task` is exactly the invented number this module
  // exists to refuse. Null instead, which the renderer already reads as `unknown`.
  const etaMs =
    paceMs == null || remaining == null
      ? null
      : finiteOrNull(inFlightRemainingMs + remaining * paceMs)
  // `!Number.isFinite(now)` stays explicit: `null + etaMs` is a NUMBER in JS, so a
  // missing clock would otherwise land the finish time in 1970.
  const finishAt = etaMs == null || !Number.isFinite(now) ? null : finiteOrNull(now + etaMs)

  // The ± is the ETA you would get if every task still ahead ran at the observed
  // extreme instead of the mean — half the observed range, once per task ahead.
  const spreadMs =
    etaMs == null
      ? null
      : finiteOrNull(((paceMaxMs - paceMinMs) / 2) * (remaining + inFlight))

  const costs = usableSamples(runEvents, 'total_cost_usd')
  const spendUsd = costs.length > 0 ? finiteOrNull(sum(costs)) : null
  // Rated over the tasks that RECORDED a cost, not over every completed task: a
  // mixed Claude/Codex run would otherwise report a rate half its real one.
  const costPerTaskUsd = spendUsd == null ? null : spendUsd / costs.length
  const projectedUsd =
    spendUsd == null || remaining == null
      ? null
      : finiteOrNull(spendUsd + remaining * costPerTaskUsd)

  return {
    paceBasis: paceMs == null ? PACE_BASIS.unknown : basis,
    paceMs,
    paceMinMs,
    paceMaxMs,
    samples: paceSamples.length,
    completed,
    inFlight,
    remaining,
    total,
    etaMs,
    finishAt,
    spreadMs,
    spendUsd,
    costPerTaskUsd,
    projectedUsd,
  }
}

// The three lines, in the live view's label column. PURE: a snapshot in, strings
// out. Every line says `unknown` rather than a number it cannot stand behind, and
// each segment that has no data is simply absent — the reader should never have to
// work out whether `$0.00` means free or unrecorded.
export function renderProgress(snapshot) {
  const {
    paceMs,
    etaMs,
    finishAt,
    spreadMs,
    spendUsd,
    costPerTaskUsd,
    projectedUsd,
  } = snapshot ?? {}

  const spread = Math.round((spreadMs ?? 0) / SPREAD_ROUND_MS) * SPREAD_ROUND_MS
  return [
    // Minutes per task even past the hour: `~84 min/task` is the unit a reader
    // compares between runs, and `~1h24m/task` is not.
    row('pace', [
      paceMs == null ? 'unknown' : `~${Math.round(paceMs / 60000)} min/task`,
      costPerTaskUsd == null ? null : `$${costPerTaskUsd.toFixed(1)}/task`,
    ]),
    row('eta', [
      etaMs == null
        ? 'unknown'
        : `~${formatElapsed(etaMs)} left → ~${formatClock(finishAt)}` +
          // No ± at all when the samples show no observed spread (a single one
          // never can): `(±0min)` is a claim of certainty nothing supports.
          (spread > 0 ? `  (±${formatElapsed(spread)})` : ''),
    ]),
    // Money that was RECORDED prints exactly, trailing zeros and all — `$62.80`
    // is a sum, not a typo. Only the projection below is rounded.
    row('spend', [
      spendUsd == null ? 'unknown' : `$${spendUsd.toFixed(2)} so far`,
      projectedUsd == null ? null : `~$${formatProjectedUsd(projectedUsd, spendUsd)} projected`,
    ]),
  ]
}

// `3h12m` past the hour, `40min` below it — one rule, both of the issue's forms.
export function formatElapsed(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'unknown'
  const minutes = Math.max(0, Math.floor(ms / 60000))
  if (minutes < 60) return `${minutes}min`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

// Wall clock (`16:20`) in the reader's own timezone — these lines answer "when did
// I start this?" and "when will it be done?", which are local-time questions. A
// finish time past midnight simply reads as tomorrow's clock (`04:40`).
export function formatClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '--:--'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// One label-column line. Empty segments are dropped rather than rendered, so a
// line never trails a dangling `·` around a number it does not have.
function row(label, segments) {
  return `  ${label.padEnd(LABEL_WIDTH)}${segments.filter(Boolean).join(' · ')}`
}

// A PROJECTION gets a coarse grid: `~$250`, not `~$251.40`, because the
// cents are noise on a number extrapolated from a handful of tasks. Small totals
// keep a decimal, where rounding to the nearest ten would erase the whole figure.
//
// TWO LIMITS on that grid, both because it sits next to a spend figure printed to
// the cent. A projected total can never be below the money already recorded, so a
// grid that rounds it there is not merely coarse but wrong — `$104.99 so far ·
// ~$100 projected` describes an impossibility. And a projection that extrapolates
// nothing is not an estimate at all. In both cases the exact figure wins.
function formatProjectedUsd(usd, spendUsd) {
  // Nothing extrapolated — an empty queue, or a rate of zero — means nothing
  // uncertain: the projection IS the recorded spend, so it prints to the cent
  // exactly like it, instead of being rounded away from a number we know.
  if (!(usd > spendUsd)) return usd.toFixed(2)
  const grid = usd >= 100 ? 10 : usd >= 10 ? 1 : 0.1
  const rounded = Math.round(usd / grid) * grid
  // ...and the grid never wins over the money already on the books.
  if (rounded < spendUsd) return usd.toFixed(2)
  return grid < 1 ? rounded.toFixed(1) : String(rounded)
}

// PURE parser over the newline-delimited issues.jsonl text, same contract as
// aggregateCycleCounts in issue-metrics.js: each `RALPH_ISSUE_EVENT <json>` line
// becomes an event, and blank, untagged, malformed and truncated lines (a run
// killed mid-append leaves one) are skipped silently. NEVER throws — a read-only
// status view must not be the thing that breaks on a half-written log line.
function parseIssueEvents(jsonlText) {
  if (!jsonlText) return []
  const events = []
  for (const line of String(jsonlText).split('\n')) {
    const idx = line.indexOf(ISSUE_EVENT_TAG)
    if (idx === -1) continue
    let event
    try {
      event = JSON.parse(line.slice(idx + ISSUE_EVENT_TAG.length))
    } catch {
      continue
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    events.push(event)
  }
  // File order, which is append order, which is chronological — the same order
  // "the last three" means. No sort: a row's `ts` is optional, and sorting on a
  // missing key would silently reshuffle the window.
  return events
}

// issues.jsonl accumulates across runs, so every per-run number has to be scoped.
// An absent run id matches nothing rather than everything: a record too broken to
// name its run has no business claiming another run's tasks as its own.
function belongsToRun(event, runId) {
  if (runId == null || runId === '') return false
  return String(event.run_id) === String(runId)
}

// The usable values of one numeric field, in file order. Zero, missing and
// non-finite are all "not measured" rather than samples: the loop records a 0
// duration when it could not time an iteration, and a Codex run records no cost at
// all — averaging either in would quietly halve the pace or the rate.
function usableSamples(events, field) {
  const samples = []
  for (const event of events) {
    const value = finiteOrNull(event[field])
    if (value != null && value > 0) samples.push(value)
  }
  return samples
}

// How long the in-flight task has been going. An unparseable or future
// `started_at` reads as 0 elapsed rather than NaN — the task IS in flight, so the
// ETA still owes it a full estimate.
function elapsedOf(current, now) {
  const started = Date.parse(current?.started_at)
  if (!Number.isFinite(started) || !Number.isFinite(now)) return 0
  return Math.max(0, now - started)
}

function mean(values) {
  return sum(values) / values.length
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0)
}

function finiteOrNull(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
