// Progress policy (#57) — the three numbers that make `ralph status` worth
// running before bed: the pace the run is actually holding, an ETA with an honest
// range and a wall-clock finish time, and the spend so far plus where it lands.
//
// PURE, with no exceptions: no fs, no network, no `Date.now`, no ambient clock.
// The metrics file's raw text, the run record, the live queue depth and `now` are
// all passed in, so every number below is pinned by a unit test instead of by the
// machine the suite happens to run on. lib/commands/status.js is the I/O shell
// that reads those inputs and hands them over — and, since #60, lib/commands/start.js
// is a second one for the launch projection at the bottom of this file.
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
//
// TWO RENDERERS, ONE SNAPSHOT (#58): `renderProgress` writes the human lines and
// `toJsonSnapshot` writes the document `ralph status --json` prints, and both take
// the SAME object. That is deliberate and it is the point of the split — a second
// serializer that re-parsed issues.jsonl would be a second policy, free to drift
// from the one the reader sees on the terminal. `toJsonSnapshot` therefore
// computes nothing: it renames, converts units and clamps, and every number in it
// is a number the snapshot already stood behind.
//
// A SECOND SNAPSHOT (#60): `buildLaunchProjection`/`renderLaunchProjection` answer
// the same questions for `ralph start`, which has no run to observe yet. They live
// here because `ralph start` is an I/O shell, and a projection it computed itself
// would be a second policy free to contradict what `ralph status` prints an hour
// later.
//
// THE TASK TABLE (#56): the snapshot also carries `taskRows` — one row per task this
// run has touched, the completed ones in file order and the one in flight last — and
// `renderProgressLine`/`renderTaskTable` are the two surfaces that draw them. Same
// discipline as every number above, applied to a grid: the rows ARE the numerator the
// fraction counts, so the line and the table cannot disagree about what "2 of 9"
// means, and a cell with no measurement behind it prints `–` rather than the `$0.00`
// that would read as free.
//
// TITLES ARE AN INPUT, because nothing this module can read records one: the event
// stream carries a number, a duration, a cost and a verdict (lib/issue-event.js), and
// no title at all. So `buildProgress({ titles })` takes a map from task number to
// title and the shell fills it in if it can afford to — a row with none renders as
// its number alone, which is what `ralph status` printed before this issue anyway.
// They are also the ONE piece of attacker-controlled text in the whole view (somebody
// else writes an issue title), which is why the stripping and the truncation happen
// here, in the pure module, where they are pinned by a unit test rather than trusted
// to the caller.

const ISSUE_EVENT_TAG = 'RALPH_ISSUE_EVENT '

// How many recent tasks the in-run pace averages, and the fewest it will accept
// before falling back to the all-time mean. Two is the floor because one sample
// is an anecdote: a single 6-minute typo fix would promise the whole queue in an
// hour.
const PACE_WINDOW = 3
const PACE_MIN_SAMPLES = 2

// The live view's label column, matching the `  progress   ` / `  queue      `
// lines in lib/commands/status.js so the labels align down the block.
const LABEL_WIDTH = 11

// The task table's grid (#56). FIXED widths, not widths fitted to the data: the
// numbers, the money and the durations all have known shapes, and a column that
// resized itself per render would make two consecutive `ralph status` calls
// un-diffable. The one width that IS measured is the task column, which carries a
// title of arbitrary length — see `renderTaskTable`.
//
//   TASK_COLUMN_MIN     `task`, and `#031` — the same four columns
//   VERDICT_COLUMN      a two-column marker, a space, and `unknown`
//   VERDICT_WORD_WIDTH  the longest verdict word
//   COST_COLUMN         `<$0.01` … `$1234.56`
const TASK_COLUMN_MIN = 4
const VERDICT_COLUMN = 10
const VERDICT_WORD_WIDTH = 7
const COST_COLUMN = 8
const COLUMN_GAP = '  '

// THE EMOJI DECISION, which is the only thing in this file that depends on how a
// terminal draws a glyph. All four markers are Emoji_Presentation code points, so
// every terminal that draws one of them two columns wide draws all four that way —
// and each verdict cell is built as `marker + ' ' + word.padEnd(7)`, so the cells are
// identical in width BY CONSTRUCTION rather than by measurement. What that buys: the
// verdict, cost and time columns line up down the rows on any terminal, whatever it
// thinks an emoji is worth. The single residual assumption is that a marker is worth
// two columns, and it costs only the ASCII `verdict` header's alignment against the
// rows below it if a terminal disagrees.
const VERDICT_MARKERS = { pass: '✅', fail: '❌', unknown: '❔' }
const IN_FLIGHT_MARKER = '🔄'
const IN_FLIGHT_WORD = 'live'

// A cell with no measurement behind it: an en dash, and never `$0.00` or `0min`. The
// whole point of the unknown discipline, one glyph wide — see `measuredOrNull`.
const UNKNOWN_CELL = '–'

// The bar. Eight cells is enough to read a fraction at a glance and narrow enough
// that the line still fits beside the fraction and the task in flight on an 80-column
// terminal.
const BAR_WIDTH = 8
const BAR_FILLED = '█'
const BAR_EMPTY = '─'

// How wide a title is allowed to be, in terminal columns. Short on purpose: it is
// context for a number, not the issue itself, and the row it sits on already carries
// three more columns. Titles longer than this are truncated with an ellipsis rather
// than allowed to set the width of every row below them.
const TITLE_WIDTH = 24

// ...and how much raw text is even looked at on the way there. A title that needs a
// thousand characters to reach its first 24 printable columns is not a title, and
// issues.jsonl is untrusted append-only text: this bounds the sanitizing work per row
// so one absurd line cannot make a read-only view expensive.
const RAW_TITLE_LIMIT = 1000

// The START box's label column (#60) — a wider one on another command:
// `   Watch live:     ` is a 3-space indent and a 16-wide label field. The
// projection lines print among those, so they align with them rather than with the
// live view's narrower column.
const LAUNCH_INDENT = '   '
const LAUNCH_LABEL_WIDTH = 16

// The ± is rounded to five minutes, and a projection to a coarse dollar grid
// (below), for the same reason: they are guesses about a guess. `±1h31m` and
// `~$251.40` claim a precision the two samples behind them do not have — which is
// exactly the false precision the issue asks us not to print.
const SPREAD_ROUND_MS = 5 * 60000

// The three values `paceBasis` can take. Recorded in the snapshot so a surprising
// estimate is inspectable — and exposed verbatim by `toJsonSnapshot` (#58), which
// is why they are strings a consumer can switch on rather than an internal enum.
const PACE_BASIS = {
  lastInRun: 'last3-in-run',
  allTime: 'all-time',
  unknown: 'unknown',
}

// The first and last instants the document's timestamp format can spell (#58) —
// `0000-01-01T00:00:00.000Z` and `9999-12-31T23:59:59.999Z`. One millisecond
// outside either, `toISOString` switches to ISO-8601's expanded-year form
// (`+010000-01-01T00:00:00.000Z`), which `jq`'s `fromdate` refuses. Written as the
// numbers rather than derived with `Date.UTC`, whose two-digit-year rule maps
// year 0 to 1900.
const ISO_FLOOR_MS = -62167219200000
const ISO_CEIL_MS = 253402300799999

// Where fixed notation runs out: at 1e21 and above, both `String` and `toFixed`
// switch to exponent form (`1e+300`). Every integer these lines print goes through
// `fixedDigits` for that reason — see the note there.
const FIXED_NOTATION_LIMIT = 1e21

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
//   taskRows        — one row per task this run has touched (see buildTaskRows)
//   etaMs           — ms until the queue is empty, or null
//   finishAt        — epoch ms of that finish, or null
//   spreadMs        — the ± around etaMs, or null
//   spendUsd        — cost this run has recorded, or null
//   costPerTaskUsd  — the observed rate behind the projection, or null
//   projectedUsd    — spendUsd + remaining × rate, or null
//
// `titles` (#56) is the one OPTIONAL input, and the only one that is not a
// measurement: a map — a plain object or a `Map`, keyed by task number — of titles the
// shell managed to look up. Absent, every row simply has no title. It is optional
// because it costs the shell an extra network call and the two other callers of this
// function (`ralph status --json`, `ralph start`) publish no titles at all.
export function buildProgress({ metricsText, record, queue, now, titles } = {}) {
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
  // That all-time fallback is a CONTRACT, not just a default: buildLaunchProjection
  // (#60) calls this with no `record` precisely to get it, since a launch has no run
  // to observe yet. Narrowing the branch to in-run samples would leave that caller
  // with no pace at all.

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

  // The same two facts the counts above are made of, kept as ROWS (#56) rather than
  // recounted by a renderer: `completed` is `runEvents.length` and the rows are those
  // very events, so the table under the fraction lists exactly the tasks the fraction
  // counted.
  const taskRows = buildTaskRows({ runEvents, current: record?.current, titles, now })

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
    taskRows,
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
      paceMs == null ? 'unknown' : `~${fixedDigits(Math.round(paceMs / 60000))} min/task`,
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
    //
    // Both halves spell money through `usdText`, which is the point of it: they are
    // the same quantity a rounding apart, so a precision either half applied alone
    // could have the projection reading as LESS than the spend it contains.
    row('spend', [
      spendUsd == null ? 'unknown' : `${usdText(spendUsd)} so far`,
      projectedUsd == null ? null : `${formatProjectedUsd(projectedUsd, spendUsd)} projected`,
    ]),
  ]
}

// The PROGRESS LINE (#56) — how far through the queue this run is, which task is in
// flight, and a bar. It SUBSUMES #55's `in flight` line rather than sitting beside it:
// that line said which task and for how long, and this one says the same two things
// with a denominator around them, so the reader learns "2 of 9" without adding the
// queue to a count themselves.
//
// WHAT THE BAR DOES WITH AN UNKNOWN TOTAL: there is no bar, and no percentage either.
// A bar IS a picture of a denominator, and a `gh` call that failed leaves us without
// one — an empty bar would be indistinguishable from a run that has finished nothing,
// and a full one is a lie. The FRACTION still prints, as `2/unknown done`, because
// naming which half is missing is this module's own answer everywhere else: the
// numerator is a counted fact whatever the queue did.
//
// The percentage FLOORS and the two end cells are reserved, which is the same rule in
// three places: `Math.round` would print `100%` and a full bar beside a task still in
// flight (199 of 200 is 99.5%), and it would round a run's first finished task out of
// a 60-task queue down to no cells at all — erasing a measurement, which is the
// `$0.0/task` mistake in another alphabet.
export function renderProgressLine(snapshot) {
  const { completed, total } = snapshot ?? {}
  // Nothing counted at all — a caller holding no snapshot, which is a different thing
  // from a run that has completed nothing (`0/7` below).
  const done = finiteOrNull(completed)
  if (done == null) return row('progress', ['unknown'])

  // The task in flight is read off the ROW the table draws, not out of the record a
  // second time, so the line and the table can never name different tasks. Any
  // snapshot from `buildProgress` keeps the two consistent — `inFlight` is 1 exactly
  // when there is an in-flight row.
  const current = taskRowsOf(snapshot).find((taskRow) => taskRow?.inFlight)
  const denominator = finiteOrNull(total)
  const line = row('progress', [
    `${fixedDigits(done)}/${denominator == null ? 'unknown' : fixedDigits(denominator)} done`,
    current
      ? `#${padTaskNumber(current.number)} in flight (${taskMinutes(current.durationMs)})`
      : 'nothing in flight',
  ])

  // `0/0` — an empty queue for a run that completed nothing — is neither 0% nor 100%:
  // there is nothing to be a fraction of, so the bar stays away rather than picturing
  // a division nobody can do.
  if (denominator == null || denominator <= 0) return line
  return `${line}${COLUMN_GAP}${renderBar(done / denominator)}`
}

// The TASK TABLE (#56) — an ARRAY of lines, header first, empty when there is nothing
// to row, so the shell prints it by spreading rather than by deciding anything. Empty
// and not a bare header, for the same reason `renderLaunchProjection` returns nothing
// rather than a block of zeros: a header over no rows is furniture, not information.
//
// NO COLOR, deliberately and structurally: this module imports nothing, picocolors
// included, so the verdict is carried by a marker glyph and a word rather than by red
// and green. Which is the better answer anyway — the table survives `| tee`, a pipe
// into `grep`, and a reader who cannot distinguish the two colors.
//
// ONE MEASURED COLUMN. `task` carries a title of arbitrary length, so its width is the
// widest title on show — and it is computed from the TITLES rather than from the
// rendered cells, so that a corrupt row's absurd task number (`#1000000000000000000000`,
// one bad line of issues.jsonl away) overflows its OWN row instead of pushing every
// other row right. Truncating the number instead was never an option: identity and
// money are the two things this view will not shorten.
export function renderTaskTable(snapshot) {
  const rows = taskRowsOf(snapshot)
  if (rows.length === 0) return []

  const titleWidth = Math.max(0, ...rows.map((taskRow) => displayWidth(titleTextOf(taskRow))))
  const taskWidth = TASK_COLUMN_MIN + (titleWidth > 0 ? 1 + titleWidth : 0)
  const line = (task, verdict, cost, time) =>
    '  ' +
    padColumn(task, taskWidth) +
    COLUMN_GAP +
    // The verdict cells arrive already the same width as each other (see
    // VERDICT_MARKERS); this pad is what puts the ASCII header over them.
    padColumn(verdict, VERDICT_COLUMN) +
    COLUMN_GAP +
    padColumn(cost, COST_COLUMN) +
    COLUMN_GAP +
    // Time last and unpadded: nothing follows it, so it needs no width of its own.
    time

  return [
    line('task', 'verdict', 'cost', 'time'),
    ...rows.map((taskRow) =>
      line(taskCell(taskRow), verdictCell(taskRow), costCell(taskRow), timeCell(taskRow)),
    ),
  ]
}

// `#031` — three digits so consecutive lines align; wider numbers are never cut. It
// was #55's, in lib/commands/status.js, and it moved here when #56 gave the table a
// second caller for it — the same move `formatElapsed` and `formatClock` made, and
// status.js re-exports it the same way so #55's callers are untouched.
//
// Spelled through `fixedDigits` because a task number out of a corrupt file can be a
// magnitude `String` writes as `1e+21`, which reads as a bug in Ralph rather than in
// the file.
export function padTaskNumber(number) {
  if (typeof number !== 'number' || !Number.isFinite(number)) return '?'
  return fixedDigits(number).padStart(3, '0')
}

// The JSON surface (#58): the SAME snapshot `renderProgress` consumes, projected
// into the document `ralph status --json` prints. A PROJECTION and nothing more —
// it does not touch the metrics text, does not know the queue depth and recomputes
// no number; it renames camelCase to the snake_case a shell consumer expects,
// converts ms to minutes, and clamps. Which is what makes the two surfaces
// impossible to drift apart: there is one policy, rendered twice.
//
// `mode` is the top-level discriminator, and it is the FIRST thing a consumer
// reads — the sections below are the same five keys in all four modes, so the
// mode is what says whether a run is in flight at all. `record` supplies only the
// run's IDENTITY (its id, and the number/start of the task in flight): strings and
// a task number copied across, never a number this module could have derived.
//
// The unknown discipline carries straight through: every leaf is either a value or
// `null`, never `0` standing in for absent and never an ABSENT KEY — a consumer
// writes `.eta.finish_at` once and it resolves in every mode. The absent-key half
// takes care: JSON.stringify silently drops an `undefined` leaf, so each field
// here goes through a guard that answers `null` rather than passing `undefined`
// on. `samples`, `completed` and `in_flight` are counts, so a zero there is the
// measurement rather than a stand-in.
export function toJsonSnapshot(snapshot, { mode, record } = {}) {
  const {
    paceBasis,
    paceMs,
    paceMinMs,
    paceMaxMs,
    samples,
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
  } = snapshot ?? {}

  // Read once, published twice: it is the PACE's provenance, and it is on the
  // `eta` section too because the ETA is the number a reader distrusts — being
  // told "this came from the last three tasks" is what makes it checkable. Two
  // keys, one value, no second computation.
  const basis = paceBasis ?? PACE_BASIS.unknown

  return {
    mode: mode ?? null,
    run_id: runIdOrNull(record?.run_id),
    // How far through the queue: the four counts the live denominator is built
    // from. `remaining` and `total` are null when the queue count failed — the
    // distinction between "nothing left" and "we could not look" is the whole
    // reason this surface exists.
    progress: {
      completed: finiteOrNull(completed),
      in_flight: finiteOrNull(inFlight),
      remaining: finiteOrNull(remaining),
      total: finiteOrNull(total),
    },
    // ...and WHICH task that is. Gated on the snapshot's own in-flight count, not
    // on the record, so `progress.in_flight: 0` can never sit beside a named task:
    // run-state's endRun deliberately KEEPS `current` on a terminal record (it is
    // the last task the run worked on), and reading it directly would have an idle
    // document claim a finished run is still working.
    //
    // `started_at` rather than an elapsed: the moment a task began is a FACT, and
    // an `elapsed_min` would be stale the instant the document was written. A
    // status line redrawing on a timer wants the former and can derive the latter.
    tasks: {
      current: inFlight
        ? {
            number: finiteOrNull(record?.current?.number),
            started_at: isoUtcSecondsOrNull(Date.parse(record?.current?.started_at)),
          }
        : null,
    },
    // Minutes, rounded to the whole minute — the unit the human line prints
    // (`~84 min/task`) and all the precision a three-sample mean supports. The
    // observed extremes live HERE, next to the mean they were measured with,
    // rather than on the ETA: they are a fact about tasks, not about the finish.
    pace: {
      basis,
      per_task_min: minutesOrNull(paceMs),
      fastest_min: minutesOrNull(paceMinMs),
      slowest_min: minutesOrNull(paceMaxMs),
      samples: finiteOrNull(samples),
    },
    // `range_min`, NOT `spread_min`: this module already uses "spread" for the ±
    // delta (`snapshot.spreadMs`, printed as `(±1h30m)`), and these are the two
    // absolute endpoints instead. Publishing the module's own word for the opposite
    // quantity would invite a consumer to render `548 ± 457–639 min`, and a key in
    // a document is the one thing here that cannot be fixed after release.
    eta: {
      remaining_min: minutesOrNull(etaMs),
      finish_at: isoUtcSecondsClamped(finishAt),
      range_min: etaRangeMinutes(etaMs, spreadMs),
      basis,
    },
    // Money verbatim, unrounded: the human line puts the projection on a coarse
    // dollar grid because cents are noise TO A READER, and that is a rendering
    // decision. A machine gets the figure and rounds it however it likes.
    spend: {
      usd: finiteOrNull(spendUsd),
      per_task_usd: finiteOrNull(costPerTaskUsd),
      projected_usd: finiteOrNull(projectedUsd),
    },
  }
}

// The LAUNCH projection (#60) — the same questions, asked before there is a run to
// observe: how long a task takes, what it costs, and where that puts the queue
// `ralph start` just accepted.
//
// The DURATION half is BORROWED from buildProgress rather than re-derived. Handed no
// `record`, it has no run to scope samples to, so its pace falls back to the all-time
// mean over the whole history — precisely the basis a launch needs, since every task
// ever recorded here is the only evidence there is — and its `etaMs` reduces to
// `remaining × paceMs` (the in-flight term is zero) with `finishAt` following. Every
// overflow guard and every null in that arithmetic comes along for free.
//
// The MONEY half CANNOT be borrowed, and both sides of that are deliberate:
// `spendUsd`/`costPerTaskUsd` there are scoped to the run's own events because a
// status view reports what THIS run has spent, and at launch there is no run whose
// events could answer. So the rate is re-derived below over the whole history — the
// same all-time basis the pace just used. That parses the text a second time, which
// is one extra pass per launch over a file with one line per task ever recorded:
// cheaper than reshaping buildProgress's signature to hand its events back out.
export function buildLaunchProjection({ metricsText, queue, now } = {}) {
  const base = buildProgress({ metricsText, queue, now })

  const costs = usableSamples(parseIssueEvents(metricsText), 'total_cost_usd')
  // finiteOrNull on the MEAN for the same reason buildProgress applies it to the
  // pace: finite magnitudes still overflow their own sum, and an empty history
  // reaches the same null through 0/0.
  const costPerTaskUsd = finiteOrNull(mean(costs))
  // ...and once more on the product, because a huge queue times a finite rate
  // overflows from two inputs that each passed their own guard.
  const totalUsd =
    costPerTaskUsd == null || base.remaining == null
      ? null
      : finiteOrNull(base.remaining * costPerTaskUsd)

  return {
    basis: base.paceBasis,
    paceMs: base.paceMs,
    samples: base.samples,
    costPerTaskUsd,
    costSamples: costPerTaskUsd == null ? 0 : costs.length,
    queue: base.remaining,
    totalMs: base.etaMs,
    finishAt: base.finishAt,
    totalUsd,
  }
}

// The projection block of the `ralph start` box (#60) — an ARRAY of lines, empty
// when there is nothing to say, so the shell prints it by spreading rather than by
// deciding anything.
//
// SEGMENT-LEVEL ABSENCE, BLOCK-LEVEL OMISSION: empty only when NEITHER half exists —
// the fresh repo whose first run has no history at all, where `~0 min/task · ~$0/task`
// would be worse than silence. With one half known (a Codex project records durations
// but no cost) the known segments print and the rest drop out, exactly as `row`
// already does for the live view.
//
// And unlike every line of `ralph status`, the word `unknown` never appears here.
// This block is ADVICE on the way out the door rather than a report being
// interrogated: there, naming what could not be measured is the honest answer; here,
// absent reads as absent — which is why a missing clock, or one no calendar can
// spell, drops `done ≈` instead of printing `--:--`.
export function renderLaunchProjection(projection) {
  const { paceMs, costPerTaskUsd, totalMs, finishAt, totalUsd } = projection ?? {}

  // Minutes per task and dollars per task — the two rates, on the same ` · ` join
  // the live view's pace line uses.
  const perTask = [
    paceMs == null ? null : `~${fixedDigits(Math.round(paceMs / 60000))} min/task`,
    costPerTaskUsd == null ? null : `${formatProjectedUsd(costPerTaskUsd, 0)}/task`,
  ].filter(Boolean)
  if (perTask.length === 0) return []

  // ...and what they come to over the accepted queue, on a continuation line: no
  // second label, because these are the same projection's totals.
  const totals = [
    totalMs == null ? null : `~${formatElapsed(totalMs)}`,
    totalUsd == null ? null : formatProjectedUsd(totalUsd, 0),
    // The clock is asked whether it can spell the instant BEFORE being asked to,
    // because this block's answer for absent is absence: a finite finish outside the
    // calendar — one corrupt `duration_ms` away — would otherwise print `done ≈
    // --:--`, an empty clock dressed up as an answer. Same predicate `formatClock`
    // itself guards on, so the two can never disagree about which instants are
    // spellable.
    isSpellableInstant(finishAt) ? `done ≈ ${formatClock(finishAt)}` : null,
  ].filter(Boolean)

  const lines = [launchRow('Projection:', perTask.join(' · '))]
  if (totals.length > 0) lines.push(launchRow('', `→ ${totals.join(', ')}`))
  return lines
}

// The ETA's honest [low, high] range, in minutes: the finish you would get if every
// task still ahead ran at the observed extreme instead of the mean. ENDPOINTS, not
// a ±, which is why the key it feeds is `range_min` — see the note at that key.
//
// The issue's example writes `spread_min: [71, 97]`, which are the observed
// per-task extremes — but on the ETA those two numbers answer a question nobody
// asked (the ETA is not 71 to 97 minutes away). The pair that is useful next to
// `remaining_min` is the range around it, so that is what this is, and the raw
// extremes keep their own keys in the `pace` section where they were measured.
//
// Floored at zero, because the queue cannot finish in the past: a wide observed
// range easily puts `eta − spread` below now. Ordered ascending explicitly so a
// hand-built snapshot carrying a negative spread cannot emit a descending pair.
//
// Null unless BOTH ends survive the conversion — a half-known range is not a range,
// and the second guard is not redundant with the first: two finite doubles can
// still sum to Infinity, and a range with an infinite end is no more useful to a
// consumer than a missing one.
function etaRangeMinutes(etaMs, spreadMs) {
  const eta = finiteOrNull(etaMs)
  const spread = finiteOrNull(spreadMs)
  if (eta == null || spread == null) return null
  const low = minutesOrNull(Math.max(0, eta - spread))
  const high = minutesOrNull(eta + spread)
  if (low == null || high == null) return null
  return low <= high ? [low, high] : [high, low]
}

// Whole minutes, the unit every `*_min` key in the document carries. Both ends go
// through `finiteOrNull` — the input because a snapshot field may be missing, the
// rounded result because `Math.round` is where `-0` gets made.
function minutesOrNull(ms) {
  const n = finiteOrNull(ms)
  return n == null ? null : finiteOrNull(Math.round(n / 60000))
}

// The document's two instants, and they are TWO functions on purpose (#58 review).
// Both emit the same format; they disagree about what to do with an instant the
// format cannot spell, because one of them is a number this module derived and the
// other is a string somebody else wrote. Getting that backwards on either is how a
// document ends up asserting something the terminal beside it denies.
//
// The format, shared: ISO-8601 UTC to the SECOND — `2026-08-26T04:40:00Z`, not
// `...:00.000Z`. `jq`'s `fromdate` parses `%Y-%m-%dT%H:%M:%SZ` and FAILS outright
// on a fractional second, and a finish time carrying a ± of an hour and a half has
// no business claiming milliseconds. UTC and not the wall clock the human line
// prints, because a document is parsed, moved between machines and diffed, and all
// three want an unambiguous instant; the reader's local reading is the terminal's
// job.

// DERIVED — `eta.finish_at`, which is `now + etaMs`, arithmetic this module did
// itself. Saturates at the edge of the calendar.
//
// The hazard it exists for: a single corrupt line of issues.jsonl puts the finish
// past year 9999 without ever going near a `RangeError`. `duration_ms: 1e14` is a
// finite positive number that passes every sample guard on the way in, and six
// waiting tasks at that "pace" land the finish in the year 24208, where
// `toISOString` returns the expanded form and `fromdate` takes the shell prompt
// down with it.
//
// Saturating is honest HERE, and only here, because `remaining_min` sits directly
// beside this field carrying the true magnitude losslessly. The instant is a
// rendering of a number the document already published; clamping it reports the
// edge of what the field can express and lets its neighbour carry the rest —
// exactly what the ETA band does when it floors at zero. What that buys is an
// invariant worth writing a prompt against: `finish_at` is null only when there is
// no ETA at all, and otherwise ALWAYS a four-digit-year instant.
function isoUtcSecondsClamped(ms) {
  const n = finiteOrNull(ms)
  if (n == null) return null
  return isoUtcSeconds(Math.min(Math.max(n, ISO_FLOOR_MS), ISO_CEIL_MS))
}

// TRANSCRIBED — `tasks.current.started_at`, which is `Date.parse` of a string out
// of run-state.json. Reports `null` for an instant outside the calendar.
//
// The same clamp would be a LIE on this field. There is no adjacent magnitude here
// to carry the truth — an `elapsed_min` was deliberately left out, because an
// elapsed is stale the moment the document is written — so a saturated start is
// uncompensated: a `started_at` of `+024208-10-07T18:18:40Z` clamped to year 9999
// hands a status line computing `now - started_at` almost eight thousand years
// while the terminal beside it prints `(0min)`. That is precisely the two-surface
// disagreement this module's header promises cannot happen.
//
// `null` costs a consumer nothing it was not already handling: it is what this
// field has always returned for a start it cannot read (`'yesterday'`, `''`, a
// missing key), and the task itself still appears with its number.
function isoUtcSecondsOrNull(ms) {
  const n = finiteOrNull(ms)
  if (n == null || n < ISO_FLOOR_MS || n > ISO_CEIL_MS) return null
  return isoUtcSeconds(n)
}

// Both callers have already put `ms` inside the calendar, so `toISOString` can
// neither throw nor reach the expanded-year form, and the fractional second is the
// only thing left to drop. TRUNCATED, never rounded: `.999` must not report a task
// as having started in the second after it started.
function isoUtcSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// A run id is a NAME, so the document always types it as one: a string or null,
// never a number in some records and a string in others. `''` is unknown, matching
// belongsToRun above, which treats an unnamed run as matching nothing.
function runIdOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value !== '' ? value : null
}

// `3h12m` past the hour, `40min` below it — one rule, both of the issue's forms.
// The hour count is spelled out through `fixedDigits` because a corrupt
// `duration_ms` can make it a number `String` would print as `1.6e+294`.
export function formatElapsed(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'unknown'
  const minutes = Math.max(0, Math.floor(ms / 60000))
  if (minutes < 60) return `${minutes}min`
  const hours = Math.floor(minutes / 60)
  return `${fixedDigits(hours)}h${String(minutes % 60).padStart(2, '0')}m`
}

// Wall clock (`16:20`) in the reader's own timezone — these lines answer "when did
// I start this?" and "when will it be done?", which are local-time questions. A
// finish time past midnight simply reads as tomorrow's clock (`04:40`).
//
// `--:--` when it cannot spell the instant, which now includes one that is finite
// but OUTSIDE THE CALENDAR (#60 QA). A single `duration_ms: 1e16` line — finite,
// positive, past every sample guard — puts `now + etaMs` beyond the range
// `new Date(ms)` can represent, where every getter answers NaN and this printed
// `NaN:NaN`: an invented number wearing a clock's punctuation, which is worse than
// the honest blank the guard above already had a name for.
export function formatClock(ms) {
  if (!isSpellableInstant(ms)) return '--:--'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Whether `formatClock` can spell an instant at all — a separate predicate because
// the launch box needs the QUESTION rather than the answer (it drops `done ≈`
// instead of printing an empty clock), and one predicate keeps both surfaces on one
// set of bounds.
//
// Those bounds are #58's ISO ones, reused rather than re-derived: `isoUtcSecondsOrNull`
// already refuses the same instants on the JSON surface, so a finish the document
// calls unspellable is unspellable here too. They are also far tighter than
// `new Date(ms)`'s own ±8.64e15 range, deliberately — a five-digit year is no more
// use on a terminal line than `Invalid Date` is.
function isSpellableInstant(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return false
  return ms >= ISO_FLOOR_MS && ms <= ISO_CEIL_MS
}

// An integer in FIXED notation, whatever its magnitude (#60 QA). At 1e21 and above
// `String` and `toFixed` both switch to exponent form, so one corrupt line of
// issues.jsonl reached the terminal as `~1.6666666666666667e+295 min/task` or
// `~$1e+300` — the one shape of invented-looking number that passes every finite
// guard on the way in, and unreadable precisely where these lines exist to be
// skimmed. Spelling the digits out keeps an absurd figure visibly absurd, which is
// the honest reading of a corrupt duration, and leaves every ordinary magnitude's
// text byte-for-byte what it was.
function fixedDigits(n) {
  if (Math.abs(n) < FIXED_NOTATION_LIMIT) return String(n)
  // `BigInt` refuses a fractional double, and every caller above has rounded
  // already — the round here is for the ones that have not.
  return BigInt(Math.round(n)).toString()
}

// One label-column line. Empty segments are dropped rather than rendered, so a
// line never trails a dangling `·` around a number it does not have.
function row(label, segments) {
  return `  ${label.padEnd(LABEL_WIDTH)}${segments.filter(Boolean).join(' · ')}`
}

// One line of the START box's label column (#60). Same rule as `row` above — the
// caller has already dropped its empty segments — with an empty label producing the
// continuation line's bare indent, so the `→` sits under the first line's text.
function launchRow(label, text) {
  return `${LAUNCH_INDENT}${label.padEnd(LAUNCH_LABEL_WIDTH)}${text}`
}

// The bar and its percentage, from a ratio that is already 0..1 (#56). See
// `renderProgressLine` for why the ends are reserved: a `Math.round` alone claims
// `100%` at 99.5% and erases a measured task at 1.6%.
function renderBar(ratio) {
  const clamped = Math.min(1, Math.max(0, ratio))
  let filled = Math.round(clamped * BAR_WIDTH)
  if (filled === 0 && clamped > 0) filled = 1
  if (filled === BAR_WIDTH && clamped < 1) filled = BAR_WIDTH - 1
  const bar = `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(BAR_WIDTH - filled)}`
  return `[${bar}] ${Math.floor(clamped * 100)}%`
}

// The snapshot's rows, defensively: both renderers take a snapshot from a caller
// (every test of this module builds one by hand), and a missing `taskRows` reads as no
// rows rather than as a crash in a read-only view.
function taskRowsOf(snapshot) {
  return Array.isArray(snapshot?.taskRows) ? snapshot.taskRows : []
}

// The four cells of a row. Each one answers `–` for a value that was never measured
// rather than printing a zero — see UNKNOWN_CELL — and each one is written to survive
// a row that is null, a number that is missing and a verdict that is not a string,
// because issues.jsonl is untrusted text and this table is the surface that renders
// the most of it.
function taskCell(taskRow) {
  const title = titleTextOf(taskRow)
  return `#${padTaskNumber(taskRow?.number)}${title === '' ? '' : ` ${title}`}`
}

// A CLOSED SET of verdicts, with anything else read as `unknown`. The writer emits
// exactly pass/fail/unknown (lib/issue-event.js), so a row saying something else is a
// row this view cannot interpret — and printing it verbatim would let a 4 KB "verdict"
// out of a corrupt file take the whole column with it.
function verdictCell(taskRow) {
  if (taskRow?.inFlight) return `${IN_FLIGHT_MARKER} ${IN_FLIGHT_WORD.padEnd(VERDICT_WORD_WIDTH)}`
  const verdict = Object.hasOwn(VERDICT_MARKERS, taskRow?.verdict) ? taskRow.verdict : 'unknown'
  return `${VERDICT_MARKERS[verdict]} ${verdict.padEnd(VERDICT_WORD_WIDTH)}`
}

// Money in the module's one spelling (`usdText`), so a row agrees with the `spend`
// line three lines below it about how much precision the same dollar has.
function costCell(taskRow) {
  const usd = finiteOrNull(taskRow?.costUsd)
  return usd == null ? UNKNOWN_CELL : usdText(usd)
}

// The in-flight row's time wears the `~` the pace and ETA lines wear: it is the one
// duration on the table still running, and a reader scanning the column should not
// have to check the verdict to know which number is not final.
function timeCell(taskRow) {
  const ms = finiteOrNull(taskRow?.durationMs)
  if (ms == null) return UNKNOWN_CELL
  return `${taskRow?.inFlight ? '~' : ''}${taskMinutes(ms)}`
}

// A PER-TASK duration, in whole minutes — `97min`, and not `formatElapsed`'s `1h37m`.
//
// A second time spelling inside one module needs a reason, and this is it: this column
// is read DOWN, against the tasks above it and against the `~84 min/task` pace three
// lines below, and minutes are the unit that comparison happens in. It is the same
// argument the pace line already makes for itself — `~1h24m/task` is not a number you
// compare between tasks — and it is the spelling the issue's own worked example uses.
// `formatElapsed` keeps every RUN-scale span (the heading's `3h12m ago`, the ETA's
// `9h08m left`), where the hour is the unit a reader thinks in.
//
// The progress line's in-flight elapsed comes through here too, deliberately: it is the
// same task's duration as the table's last row, and the two must never read `1h37m` and
// `97min` on consecutive lines about one task.
function taskMinutes(ms) {
  const n = finiteOrNull(ms)
  if (n == null) return 'unknown'
  return `${fixedDigits(Math.max(0, Math.round(n / 60000)))}min`
}

function titleTextOf(taskRow) {
  return typeof taskRow?.title === 'string' ? taskRow.title : ''
}

// Pad to a width in TERMINAL COLUMNS rather than in code units (#56). `padEnd` counts
// UTF-16 units, so a title with one emoji in it — entirely ordinary on GitHub — would
// leave that row's remaining columns a space short of every other row's.
//
// Never truncates: a cell wider than its column overflows its own row, which is the
// same choice `padTaskNumber` makes about a number and for the same reason.
function padColumn(text, width) {
  const gap = width - displayWidth(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

// How many columns a terminal draws this text in. COARSE on purpose, and the coarseness
// is the point: everything here is used to line up four columns of a table, so being
// off by one on an exotic grapheme shifts one row's columns and never produces a wrong
// number or an exception. What it must get right is the ordinary cases — ASCII, an
// emoji in a title, a CJK title — and it does.
//
// Known residual: a multi-part emoji joined by ZWJ would measure as its parts, and a
// skin-tone modifier as a second glyph. The ZWJ half cannot arise here (title
// sanitizing strips format characters, see `cleanTitle`); the modifier half can, and
// costs that row two columns of alignment.
function displayWidth(text) {
  let width = 0
  for (const ch of String(text)) {
    if (ZERO_WIDTH.test(ch)) continue
    width += isWideGlyph(ch) ? 2 : 1
  }
  return width
}

// Truncate to a width in columns, with an ellipsis standing in for what was dropped —
// so a reader can see that a title was cut rather than wondering whether it really
// ends there. Measured the same way as the padding, or the two would disagree about
// the very cell they are both shaping.
function truncateToWidth(text, limit) {
  if (displayWidth(text) <= limit) return text
  let kept = ''
  let width = 0
  for (const ch of text) {
    const glyph = ZERO_WIDTH.test(ch) ? 0 : isWideGlyph(ch) ? 2 : 1
    // `limit - 1` leaves room for the ellipsis, which is itself one column.
    if (width + glyph > limit - 1) break
    kept += ch
    width += glyph
  }
  return `${kept}…`
}

// Two columns: every emoji drawn as an emoji (the property the four verdict markers
// are chosen from), plus the ranges a terminal draws full-width — CJK, Hangul, and the
// fullwidth forms. Written as a table because East Asian Width is not one of the
// Unicode properties a JS regex can ask about, unlike `Emoji_Presentation`.
const WIDE_RANGES = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
  [0x3041, 0x33ff], // Hiragana … CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe6f], // CJK compatibility forms, small forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x20000, 0x3fffd], // CJK extensions B and beyond
]

const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u
// Combining marks take no column of their own: they are drawn on the glyph before
// them. Variation selectors are marks too (U+FE0F is Mn), which is why an emoji
// spelled with one measures the same as one spelled without.
const ZERO_WIDTH = /^[\p{Mn}\p{Me}]$/u

function isWideGlyph(ch) {
  if (EMOJI_PRESENTATION.test(ch)) return true
  const cp = ch.codePointAt(0)
  return WIDE_RANGES.some(([low, high]) => cp >= low && cp <= high)
}

// A PROJECTION gets a coarse grid: `~$250`, not `~$251.40`, because the
// cents are noise on a number extrapolated from a handful of tasks. Small totals
// keep a decimal, where rounding to the nearest ten would erase the whole figure.
//
// THREE LIMITS on that grid, and all three resolve the same way — the exact figure
// wins. Coarseness is a courtesy to the reader, so it yields the moment it would
// print something the reader would be wrong to believe.
//
// `floorUsd` is the money the printed figure must never fall below, and it covers
// the first two. For the live view that is the spend ALREADY RECORDED, which sits on
// the same line printed to the cent: a projected total below money that is already
// gone is not merely coarse but wrong — `$104.99 so far · ~$100 projected` describes
// an impossibility. And a projection that extrapolates nothing is not an estimate at
// all. The launch box (#60) passes 0, having spent nothing yet.
//
// The third: the grid never rounds a real, positive figure away to NOTHING (#60 QA).
// Below a dollar the step is 10¢, so a measured 4¢-a-task rate — entirely ordinary
// on a cheap model — rounded to `~$0.0/task`, which reads as free rather than as
// cheap. A zero standing in for a measurement is the one thing this module refuses
// everywhere else, and a rounding that erases its own subject is not coarseness but
// a wrong answer. It surfaced on the launch box because a `floorUsd` of 0 is exactly
// where the first two limits cannot catch it.
//
// The `~` is part of what this returns rather than something a caller prepends,
// because one of `usdText`'s two spellings refuses it: `<$0.01` is already a claim
// about not-more-than, and `~<$0.01` would assert an approximation of an inequality.
function formatProjectedUsd(usd, floorUsd) {
  // Nothing extrapolated — an empty queue, or a rate of zero — means nothing
  // uncertain: the projection IS the money already on the books, so it prints to
  // the cent exactly like it, instead of being rounded away from a number we know.
  if (!(usd > floorUsd)) return approximately(usdText(usd))
  const grid = usd >= 100 ? 10 : usd >= 10 ? 1 : 0.1
  const rounded = Math.round(usd / grid) * grid
  // ...and the grid never wins over money already spent, nor over the existence of
  // the figure itself: reaching this line means `usd > floorUsd >= 0`, so a rounded
  // zero can only be the grid erasing a positive measurement.
  if (rounded < floorUsd || rounded === 0) return approximately(usdText(usd))
  return `~$${grid < 1 ? rounded.toFixed(1) : fixedDigits(rounded)}`
}

// Money, in the ONE spelling every figure on a line shares (#60 review) — which is
// the whole reason it is a function rather than a `toFixed(2)` at each site. Cents
// are the precision recorded money is kept in (`$62.80 so far`, a sum, trailing
// zeros and all), and the projection beside it falls back to this same spelling
// whenever the grid yields, so the two can never disagree about how much precision
// the same number has.
//
// A POSITIVE FIGURE UNDER A CENT is spelled as the BOUND it is — `<$0.01` — not with
// more decimals. Cents would print it as the `$0.00` this module refuses everywhere;
// stretching the decimals instead (`$0.007`) printed a projection that read as less
// than the spend beside it, which had rounded the very same number up to `$0.01`. A
// bound is true at every magnitude below a cent, so it needs no cap, no second
// spelling, and it reads as what such a figure means: cheap, not free.
function usdText(usd) {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${Math.abs(usd) < FIXED_NOTATION_LIMIT ? usd.toFixed(2) : fixedDigits(usd)}`
}

// A projection wears a `~`; a bound already carries its own qualifier and takes none.
function approximately(money) {
  return money.startsWith('<') ? money : `~${money}`
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

// ONE ROW PER TASK this run has touched (#56): the recorded ones in file order — which
// is append order, which is chronological — and then the task in flight, last, the only
// row not read out of the file at all.
//
// The rows are the same `runEvents` the counts above are made of, so the table can
// neither list a task the fraction did not count nor miss one it did. Scoping,
// malformed lines and the absent-run-id rule are therefore all inherited rather than
// re-implemented: whatever `parseIssueEvents` and `belongsToRun` decided upstream is
// what appears here.
//
// Each row: `{ number, title, verdict, costUsd, durationMs, inFlight }` — where every
// numeric field keeps the unknown discipline (null, never 0, for a value that was not
// measured) and `verdict`/`title` are null rather than ''.
function buildTaskRows({ runEvents, current, titles, now }) {
  const rows = runEvents.map((event) => ({
    number: finiteOrNull(event.issue_number),
    // `event.title` is a FORWARD-COMPATIBLE fallback, not a field that exists: nothing
    // writes one today (see the header). If the loop ever starts recording it, every
    // historical row gains a title with no change here — and the injected map still
    // wins, because the shell read GitHub seconds ago and the file may be months old.
    title: resolveTitle(titles, event.issue_number, event.title),
    verdict: typeof event.verdict === 'string' ? event.verdict : null,
    costUsd: measuredOrNull(event.total_cost_usd),
    durationMs: measuredOrNull(event.duration_ms),
    inFlight: false,
  }))

  // The in-flight row comes from the RECORD, which is why it stands even for a run too
  // broken to name itself: `belongsToRun` matches no history without a run id, but the
  // task the record says it is working on is the record's own fact.
  if (current) {
    rows.push({
      number: finiteOrNull(current.number),
      title: resolveTitle(titles, current.number, current.title),
      // No verdict and no cost yet, by definition — the loop records both when the
      // task ends. `null` here is what makes the row render as `🔄 live` and `–`.
      verdict: null,
      costUsd: null,
      durationMs: inFlightElapsedOrNull(current, now),
      inFlight: true,
    })
  }
  return rows
}

// The injected map wins, the event's own title is the fallback, and the result is
// cleaned either way — an injected title is untrusted text too, and the shell that
// injects it is not the place to know how wide this table's column is.
function resolveTitle(titles, number, recorded) {
  return cleanTitle(lookupTitle(titles, number) ?? recorded)
}

// A plain object or a `Map`, keyed by task number. Both, because the shell builds one
// from a `gh` response (an object is the natural shape) and a caller holding a `Map`
// should not have to convert it to be understood. Anything else — a string, a number,
// nothing at all — is no titles rather than an error: they are a courtesy, and a view
// that refused to render because its titles were the wrong shape would be worse than
// one that renders task numbers.
function lookupTitle(titles, number) {
  if (!titles) return null
  const key = finiteOrNull(number)
  if (key == null) return null
  if (typeof titles.get === 'function') return titles.get(key) ?? null
  if (typeof titles !== 'object') return null
  return titles[key] ?? null
}

// A TITLE IS ATTACKER-CONTROLLED TEXT — somebody else writes the issue — and this is
// the guard that says so. Three things happen to it, in this order:
//
//   1. ANSI sequences go first, while their introducer is still there to match on. A
//      title of `ESC[31mred` would otherwise repaint the reader's terminal from a
//      status view, and `ESC]0;...` renames their window.
//   2. Every CONTROL and FORMAT character becomes a space. Controls take the newline
//      that would break the row in half, the tab that would misalign it and the bell
//      that would make it audible; format characters take the bidi overrides, which
//      are the nastier half — U+202E reorders the rest of the LINE, so an issue title
//      can rewrite the verdict beside it. Surrogates (a truncated write) and private-use
//      code points (of unknown width) go with them.
//   3. Whitespace collapses and the result is truncated to the column.
//
// Not a string, or nothing left once cleaned, is NO TITLE — null, so the row renders as
// its number alone. `''` would render as a trailing space and a title of one space would
// silently widen the column for everybody.
function cleanTitle(value) {
  if (typeof value !== 'string' || value === '') return null
  const cleaned = value
    .slice(0, RAW_TITLE_LIMIT)
    .replace(ANSI_CSI, '')
    .replace(ANSI_OSC, '')
    .replace(CONTROL_OR_FORMAT, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned === '') return null
  return truncateToWidth(cleaned, TITLE_WIDTH)
}

// The two escape-sequence forms worth matching by shape: CSI (colors, cursor moves)
// and OSC (window titles). Anything else that starts with an ESC loses the ESC itself
// to the control-character pass below and survives only as inert text — ugly in a
// cell, never active in a terminal, which is the property that matters.
const ANSI_CSI = /\u001B\[[0-9;:?]*[\u0020-\u002F]*[\u0040-\u007E]/g
const ANSI_OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/g
// Cc controls, Cf format (bidi overrides, ZWJ, soft hyphen), Cs lone surrogates, Co
// private use, and the line/paragraph separators.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu

// One value under the same "measured" rule `usableSamples` applies to a set: zero,
// missing and non-finite are all ABSENT rather than data. The loop writes a 0 duration
// when it could not time an iteration and a Codex run records no cost at all, so this
// is where a row's `–` is decided — at the parse, from what the file says, rather than
// by a renderer guessing later what a zero was supposed to mean.
function measuredOrNull(value) {
  const n = finiteOrNull(value)
  return n != null && n > 0 ? n : null
}

// How long the task in flight has been going, for its ROW — and null, not zero, when
// `started_at` cannot be read.
//
// Deliberately NOT `elapsedOf`, which floors that same unreadable start to 0 for the
// ETA's sake. The two disagree because they are different kinds of claim: the ETA is
// an input to arithmetic that still owes an in-flight task a full estimate, while a
// table cell is a report, and `0min` there would assert the task started this instant.
// A start in the FUTURE does clamp to 0 in both, because that is a clock skew of
// seconds rather than a field nobody can read.
function inFlightElapsedOrNull(current, now) {
  const started = Date.parse(current?.started_at)
  if (!Number.isFinite(started) || !Number.isFinite(now)) return null
  return Math.max(0, now - started)
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

// The unknown discipline in one expression: `null` unless the value is a number
// this module can stand behind.
//
// The `=== 0` collapse is what keeps `-0` out of EVERY numeric leaf of the JSON
// document rather than just the minute ones (#58 review). `JSON.stringify` writes
// `-0` as `0`, so a document carrying one does not equal its own round trip under
// a strict comparison — a nasty thing to hand a consumer diffing two snapshots.
// It belongs here, at the single gate every number passes through, rather than
// repeated at each of the leaves that can produce one.
function finiteOrNull(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  return n === 0 ? 0 : n
}
