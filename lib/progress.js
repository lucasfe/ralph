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
// SINCE #121 IT HAS EXACTLY ONE IMPORT, where it used to have none: `issueEvents`,
// the walk that turns a `RALPH_ISSUE_EVENT` line into an event. That walk was
// written out here, again in lib/issue-metrics.js and again in lib/banner-model.js
// — three copies of one tag and one parse discipline over the same append-only
// file, agreeing by hand. `ralph status` and the launch box disagreeing about which
// lines of issues.jsonl are events is not an abstract risk: it is the bug a reader
// reports as "the box contradicts `ralph status`". lib/issue-event-lines.js has no
// imports of its own and no capability to lend, so the edge costs this module
// nothing that the purity sweep in progress.qa.test.js was protecting — and that
// sweep now pins the specifier and reads the far end of it, rather than counting to
// zero.
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
// This module also owns `formatElapsed`, `formatClock` and `padTaskNumber`: they
// were #55's, they are pure formatters, and the ETA line needs the first two.
// Rather than duplicate 20 lines of formatting in a second file, they live here —
// in the pure module that now does all of the live view's time arithmetic — and
// status.js re-exports them so #55's callers and tests are untouched.
//
// EIGHT MORE EXPORTS ARE SHARED, not public API (#59): `parseIssueEvents`,
// `belongsToRun`, `usableSamples`, `finiteOrNull`, `runIdOrNull`, `sum`, `row` and
// `calendarInstantOrNull`.
// lib/post-mortem.js reads the SAME issues.jsonl to build the idle report card, and a
// second parse of untrusted append-only text — or a second rule for which run an event
// belongs to, which values count as samples, what a run id may be, or how wide the
// label column is, or which instants can be spelled — would be a second policy free to
// drift from the one the live view reports. One parse, one scoping rule, one sample
// rule, one finite gate, one naming rule, one column, one calendar.
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
// TWO MORE RENDERERS OVER THE SAME SNAPSHOT (#56): `renderProgressLine` writes the
// `2/9 done · #031 in flight (40min)  [██──────] 22%` line and `renderTaskTable`
// writes the per-task grid under it, both from the `tasks` rows `buildProgress` now
// builds. Four surfaces, one policy — the fraction, the percentage, the bar and the
// rows are ONE fact rendered four ways, which is why they are computed once here
// rather than in the shell that prints them.
//
// This module therefore owns the table's LAYOUT as well: its column widths, its
// verdict markers and the `–` that stands where a cost was never recorded. That is
// unusual for a pure module and it is deliberate — the alignment is arithmetic over
// the widest title actually on show, which is a property worth a unit test, and
// lib/commands/status.js is deliberately colour-free (a QA test there asserts
// `picocolors` appears nowhere in it), so the markers are text and the widths are
// numbers. Nothing below emits an escape sequence.
//
// AND IT OWNS THE SANITIZING OF THE ONE UNTRUSTED STRING IN THE VIEW. Every other
// input here is a number written by Ralph's own loop; an issue TITLE is prose
// somebody else wrote, arriving over a pipe into a terminal. It is cleaned here, in the
// module where it is unit tested, by a scrubber that deliberately SUPERSEDES the one
// lib/digest-history.js runs over the model's own narration rather than following it.
// `printable` there is a single pass over C0-minus-newline, DEL and C1 and stops; this
// one also takes CSI and OSC sequences WHOLE (a pass that removes the ESC alone leaves
// `[31mred` sitting on the line as text), strips the Cf/Cs/Co/Zl/Zp categories, and
// bounds its input before doing any of it. Two scrubbers is one more than this repo
// wants, and the difference is not a disagreement — it is a boundary that faced a
// stranger being written after one that faced our own model. Unifying them means moving
// this one under lib/digest-history.js and re-testing the digest against it, which is a
// follow-up and not #56. See `cleanTitle`.

import { issueEvents } from './issue-event-lines.js'

// How many recent tasks the in-run pace averages, and the fewest it will accept
// before falling back to the all-time mean. Two is the floor because one sample
// is an anecdote: a single 6-minute typo fix would promise the whole queue in an
// hour.
const PACE_WINDOW = 3
const PACE_MIN_SAMPLES = 2

// The live view's label column, matching the `  in flight  ` / `  queue      `
// lines in lib/commands/status.js so the labels align down the block.
const LABEL_WIDTH = 11

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

// THE VIEW'S TWO-SPACE GUTTER, and it is the view's rather than the table's — three
// things below use it: the gap between the table's columns, the indent the `… N earlier`
// line sits in, and the space before the progress line's bar. One constant because they
// are one visual unit, the same two spaces lib/digest-history.js spells as
// SECTION_INDENT. Named for what it IS and not for the table, deliberately: while it was
// `COLUMN_GAP` under the header below, widening the table's gutter would have silently
// moved the bar on a line that is not in the table at all. A grid that ever wants a
// wider gutter than the view's gets its own constant; this one stays as it is.
const GUTTER = '  '

// ---------------------------------------------------------------------------
// THE TASK TABLE'S GRID (#56). Four columns — task, verdict, cost, time — and the
// last one is deliberately unpadded so no line trails whitespace into a reader's
// clipboard.
//
// Three of the four are FIXED, and only the task column is derived. That asymmetry is
// the point: a verdict cell is `marker + ' ' + word` where the four words are
// `pass`/`fail`/`live`/`unknown`, so padding the word to the longest of them makes
// every verdict cell identical in width BY CONSTRUCTION rather than by measurement.
// The cost column fits `<$0.01`, `$34.45` and four figures of dollars. Only the task
// column depends on data nobody here controls — the widest title on show — so only it
// is measured.
// ---------------------------------------------------------------------------
// The narrowest task column, sized to `#031` so the header's own `task` fits it, and
// the widest it will stretch to for issue numbers alone: eight columns is `#1234567`,
// past which a NUMBER is a corrupt row rather than a repo's issue and gets to overflow
// its OWN line instead of shifting every other row right.
//
// A JIRA KEY REACHES THIS CEILING WITHOUT BEING CORRUPT (#127), which is the half this
// comment used to leave out: `INFRA-1234` is ten columns and `PLATFORM-1234` thirteen,
// so ordinary keys on real boards go ragged here. The trade is unchanged and is now a
// judgement rather than a diagnosis — one long row overflowing beats every other row
// shifting right to accommodate a project prefix, and the identity is never shortened
// to fit. Pinned in progress.table.qa.test.js ('lets a key past the ceiling overflow
// its OWN line, and no other'). Sizing the column to the widest KEY on show is the
// alternative, and it belongs with the slice that widens the record's fields.
const NUMBER_COLUMN_MIN = 4
const NUMBER_COLUMN_MAX = 8
const VERDICT_WORD_WIDTH = 7 // `unknown`, the longest of the four
const VERDICT_COLUMN = 10 // marker (2) + space + word (7)
const COST_COLUMN = 8 // `$1234.56`

// How much of a title is shown, and how much is even LOOKED AT. Three caps rather
// than one, because they fail differently: `TITLE_WIDTH` is the column budget,
// `TITLE_CODE_POINT_LIMIT` catches text whose display width is a lie (a thousand
// combining marks measure zero columns and still stack into a blot on one cell), and
// `RAW_TITLE_LIMIT` bounds the work done at all, since the sanitizing below is a few
// regex passes over a string a stranger chose the length of.
const TITLE_WIDTH = 24
const TITLE_CODE_POINT_LIMIT = 64
const RAW_TITLE_LIMIT = 1000
const ELLIPSIS = '…'

// The verdict markers. EMOJI RATHER THAN COLOUR, and the reason is structural: the
// status command must not import picocolors (its own QA test asserts that), the view
// is routinely piped, and a colour-only distinction disappears for the reader who
// most needs it. Each is two columns wide, which is what makes the fixed cell above
// hold for all four.
const VERDICT_MARKERS = { pass: '✅', fail: '❌', unknown: '❔' }
const IN_FLIGHT_MARKER = '🔄'
const IN_FLIGHT_WORD = 'live'
// An EN DASH for "never recorded" — the same distinction the whole module rests on,
// drawn in one character. `$0.00` would read as free and `0min` as instant, and both
// are measurements this view does not have.
const UNKNOWN_CELL = '–'

// The bar: eight cells, and both ends RESERVED. A run one task from done must not
// draw a full bar, and a run that has finished one of sixty must not draw an empty
// one — erasing a task that really ran is the `$0.00` mistake in another alphabet.
const BAR_WIDTH = 8
const BAR_FILLED = '█'
const BAR_EMPTY = '─'

// How many CLOSED rows the table DRAWS, which is a different question from how many the
// snapshot holds. The view's height is a promise this command already made: the digest
// caps the model's narration at lib/digest-history.js's MAX_BODY_LINES = 8 and closes the
// block with `… full narration in .ralph/digest.log`, precisely so that the `attach`/`kill`
// pair underneath — the two lines a reader can act on — is one glance away. One line per
// closed task made the WHOLE view O(tasks done): for the run the bar above reasons about,
// one of 102, the table alone would be 103 lines and the queue count, the pace, the ETA,
// the spend, the digest and that pair would all be below the fold.
//
// EIGHT, which is the digest's number, and taking it deliberately rather than by
// coincidence is half the argument: a view with two variable blocks should elide by one
// rule a reader learns once. The other half is that eight is past where eliding is the
// common case — the durations this module measures run an hour or more a task, so a run
// with nine closed tasks has been going most of a night, and by then the reader wants the
// file rather than a screenful. With it the table is at most 11 lines (header, the marker,
// eight rows, the one in flight) whatever the run has done.
//
// THE CAP IS THIS RENDERER'S ALONE. `buildTaskRows` keeps every row, because those rows
// are the numerator `renderProgressLine` counts and the set `toJsonSnapshot` publishes
// (see the `tasks` field above) — capping them would turn `60/67 done` into a statement
// about the screen instead of about the run.
const MAX_TABLE_ROWS = 8

// What a terminal draws two columns wide, in TWO rules because the set has two halves.
// A table aligned with `padEnd` counts UTF-16 units, so a single CJK or emoji title —
// or, as it turns out, the module's own verdict markers — would bend the whole grid
// around itself. See `displayWidth`.
//
// The first rule is default emoji presentation, which is what makes `✅` two columns
// and is the reason it is a property test rather than a list: the four markers below
// live at U+2705, U+274C, U+2754 and U+1F504, three of which are nowhere near the
// pictograph blocks, and a hand-written list that missed one would misalign every row
// of the table by a column.
const EMOJI_WIDE = /^\p{Emoji_Presentation}$/u
// The second is the East Asian Width W and F ranges — CJK, Hangul, the fullwidth
// forms — which no property escape covers.
const WIDE_RANGES = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals … CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Hangul Compatibility Jamo, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Misc symbols and pictographs, emoticons
  [0x1f680, 0x1f6ff], // Transport and map symbols
  [0x1f900, 0x1f9ff], // Supplemental symbols and pictographs
  [0x20000, 0x3fffd], // CJK extensions B…
]
// Everything a terminal draws as nothing at all. Mn/Me are DELIBERATELY here rather
// than in the sanitizer's strip list: a combining acute (U+0301 after a bare letter) is
// how macOS spells an accented word, so removing it would corrupt ordinary text — it is
// zero-width, which is a width question, not a safety one.
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u
// ...and everything a terminal OBEYS, which is a safety question. Cc is the control
// bytes (a bell, a carriage return that overwrites the line, a newline that would
// forge a row), Cf the format characters (a bidi override reorders the rest of the
// line and could rewrite the verdict beside it), Cs a lone surrogate from a truncated
// write, Co private use of unknowable width, Zl/Zp the line and paragraph separators.
const OBEYED_BYTES = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu
// Escape sequences, matched WHOLE so their parameters go with them: the byte pass
// above takes the ESC itself, which would leave `[31mred` and `]0;pwned` sitting on
// the line as ordinary text. Spelled with `\u` escapes inside a string, the same way
// digest-history.js spells its control range and for the same reason — a source file
// carrying the raw byte is one careless copy away from being unreadable, and this file
// is read far more often than it is edited. An unterminated sequence keeps whatever
// follows it; the ESC is gone either way, so a terminal has nothing left to obey.
const CSI_SEQUENCE = new RegExp('\\u001b\\[[0-9;?]*[ -/]*[@-~]', 'g')
const OSC_SEQUENCE = new RegExp('\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?', 'g')

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
//   tasks           — one row per task this run has touched (#56), in file order,
//                     with the in-flight one last: {number, key, title, verdict,
//                     costUsd, durationMs, inFlight} — `key` being the Jira key when
//                     the task has one (#127, #131) and null otherwise, on every row
//                     for one shape rather than two. The rows ARE the numerator: their count
//                     is `completed` and `inFlight` by construction, so the table and
//                     the fraction above it cannot disagree.
//
// `runAlive` is the one input that is not a measurement (#59): it answers "is this
// run still going?", and it defaults to true because every caller before #59 only
// ever asked about a run that was. See the gate below for what hangs off it.
//
// `titles` is the one input that is not a measurement EITHER, and it is OPTIONAL (#56):
// a map (a plain object or a `Map`) from a task's IDENTITY to its title. It exists because
// nothing this module is handed records one — lib/issue-event.js writes numbers,
// durations, costs and a verdict, and the run record's `current` names a number too —
// so the shell looks the titles up separately and passes them in. Absent, wrong-shaped
// or half-filled, every row simply renders as its own name, which is exactly what folder
// mode does on purpose. A title is CONTEXT; the identity is the fact.
//
// AN IDENTITY, NOT A NUMBER (#132), and the distinction is what lets one map serve both task
// sources: a row is looked up by the same string that NAMES it, so a github row keys on its
// issue number (123) and a jira row on its ticket key (`FOO-123`). The shell builds whichever
// map fits its source — `gh issue list --json number,title` for github, jira-queue.js's
// `titlesFor` for jira, neither for folder — and a map of the wrong shape resolves nothing
// rather than mislabelling a row, because in practice no key of one is a key of the other.
// PRACTICE, not type safety: a github map's own properties are the STRINGS '123' (see
// `readIssueTitles`) and `taskKeyOf` does not enforce the Jira grammar, so a digits-only
// `task_key` would meet them. What keeps them apart is that nothing writes such a key —
// spelled out where it matters, on the row in `buildTaskRows`.
export function buildProgress({
  metricsText,
  record,
  queue,
  now,
  runAlive = true,
  titles,
} = {}) {
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
  // THE LIVENESS GATE (#59), stated once: a run that is over has no task in flight
  // and no future. Both halves of that sentence are here and nowhere else, so no
  // field downstream needs a mode of its own.
  //
  // It exists because `interrupted` — a record still saying `running` with no
  // process behind it — used to be treated as live, and the report card beside this
  // snapshot calls that run OVER. `record.current` survives on a terminal record on
  // purpose (it is the last task the run worked on), so reading it as an in-flight
  // task had the two surfaces contradict each other: a card announcing a dead run
  // beside a document naming the task it was "working on" and predicting when it
  // would finish. Nothing measured is withheld — the counts, the pace and the spend
  // are all facts about tasks that really ran, and they stay.
  const inFlight = runAlive && record?.current ? 1 : 0
  // The LIVE denominator, rebuilt here on every call from the queue depth the
  // shell just counted — never from `queue_at_start`. Items are opened and closed
  // while a run is going, and a denominator frozen at launch makes both the
  // fraction and the ETA drift silently away from the truth.
  const liveQueue = finiteOrNull(queue)
  const remaining = liveQueue == null ? null : Math.max(0, liveQueue)
  const total = remaining == null ? null : completed + inFlight + remaining

  // The other half of the gate: what may be EXTRAPOLATED from the queue. Both the
  // ETA and the projected spend are "the tasks still waiting, at the rate this run
  // held" — neither is a thing that will happen once the run is not running, so both
  // read this one flag instead of asking about the mode themselves.
  const projectable = runAlive && remaining != null

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
    paceMs == null || !projectable
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
    spendUsd == null || !projectable
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
    // The rows, built from the SAME scoped events the counts above came from and the
    // same `inFlight` gate — which is what makes "the rows are the numerator" a
    // property of the code rather than a promise in a comment. `record.current` is
    // passed only when that gate opened, so an interrupted run's table has no
    // `🔄 live` row to contradict the report card printed beside it.
    tasks: buildTaskRows({
      runEvents,
      current: inFlight ? record?.current : null,
      titles,
      now,
    }),
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

// THE PROGRESS LINE (#56) — `2/9 done · #031 in flight (40min)  [██──────] 22%`, and
// it REPLACES #55's separate `in flight` line rather than joining it. One line, because
// the two facts only mean anything together: `#031 in flight` on its own never answered
// the question the reader actually has, which is how much of the queue is left.
//
// SEGMENTS ABSENT RATHER THAN FAKED, the module's rule applied to a picture: an unknown
// queue count means no denominator, and a bar is a picture OF a denominator, so it and
// the percentage both stay away rather than being drawn against a guess. The completed
// count survives on its own — it is the table's row count, and naming which half is
// missing beats dropping both.
//
// THE IN-FLIGHT TASK IS NOT DONE. It is named here and it is counted in the total, but
// never in the numerator: `3/9` while #031 is still running would mean the reader
// cannot trust the number to go up when something finishes.
export function renderProgressLine(snapshot) {
  const { completed, total, tasks } = snapshot ?? {}
  const done = finiteOrNull(completed)
  // No count at all is the never-measured snapshot idle and never-run build; the whole
  // line degrades to one word rather than to `unknown/unknown done`.
  if (done == null) return row('progress', ['unknown'])

  const denominator = finiteOrNull(total)
  const current = taskRowsOf(snapshot).find((task) => task?.inFlight)
  const elapsed = measuredOrNull(current?.durationMs)
  const fraction = `${fixedDigits(done)}/${denominator == null ? 'unknown' : fixedDigits(denominator)} done`
  // `(unknown)` rather than the table's `–`: this is prose, and a dash inside
  // parentheses reads as a redaction rather than as a missing measurement.
  // `numberText` rather than a second `#${padTaskNumber(...)}` written out here (#127):
  // one spelling of a task's name for both surfaces, so a jira run's ticket key cannot
  // reach the table and miss this line.
  const flight = current
    ? `${numberText(current)} in flight (${elapsed == null ? 'unknown' : taskMinutes(elapsed)})`
    : 'nothing in flight'

  // Two spaces before the bar, not the ` · ` the label column joins with: the bar is
  // the same fact drawn rather than a third fact, so it sits apart from the sentence.
  // A denominator of 0 draws nothing — 0/0 is not 0% and it is not 100% either.
  const bar = denominator != null && denominator > 0 ? GUTTER + renderBar(done / denominator) : ''
  return row('progress', [fraction, flight]) + bar
}

// THE TABLE (#56). A header and one line per row SHOWN, or NOTHING AT ALL — a bare
// header over no rows is furniture, and the shell would still be spending two blank
// lines standing it off from its neighbours.
//
// This function is the SOLE OWNER of the table's layout: the widths, the padding, the
// markers, the two dashes and — since the review of #56 — HOW MANY LINES THE BLOCK
// COSTS. See MAX_TABLE_ROWS for why that bound exists and why it is enforced here
// rather than in the snapshot.
//
// It is deliberately not a generic table helper — the column rules here are arguments
// about this data (a number is never truncated, a missing cost is never a zero, a
// verdict is one of four words, a run's history does not get to be taller than the
// screen) and a helper that took them as options would let a second caller make a
// different argument.
export function renderTaskTable(snapshot) {
  const all = taskRowsOf(snapshot)
  if (all.length === 0) return []

  // The two kinds of row, split rather than sliced off the end, and the split does three
  // jobs. It picks WHICH rows the cap may drop — the closed ones, because the row still
  // running is the only one whose numbers are still changing and a reader watching a live
  // view is watching that. It puts the in-flight row last no matter where a caller put it,
  // which is the one ordering the snapshot's own documentation promises. And it keeps ONE
  // such row: `buildProgress` never makes a second, but both renderers are public and take
  // a snapshot they did not build, so a malformed one must not be able to reintroduce the
  // unbounded table through the row the cap does not count.
  //
  // The most recent rows, not the first: a live view answers "what just happened", and
  // .ralph/metrics/issues.jsonl keeps every row this drops.
  const closed = all.filter((task) => !task?.inFlight)
  const inFlight = all.filter((task) => task?.inFlight)
  const rows = [...closed.slice(-MAX_TABLE_ROWS), ...inFlight.slice(-1)]

  // The ONE derived width, and it is derived in two parts rather than as a plain max
  // over the whole cell. The number's share is clamped: `#029` and `#1235` in the same
  // run must both fit (a repo whose queue crossed #1000 mid-run), while a corrupt
  // `1e21` gets to overflow its own line rather than push every other row 18 columns
  // right. The title's share is the widest title ON SHOW, already capped at
  // TITLE_WIDTH by the sanitizer, so the table is as narrow as the data allows.
  //
  // Explicit loops, not `Math.max(0, ...rows.map(…))`. The cap above is what makes that
  // safe now — nine rows is nothing to spread — but the loops stay, because a spread here
  // was the RangeError this function used to be one long-lived run away from: a call stack
  // is the bound on it, and a repo's own history is enough to reach that. The 200 000-row
  // case in progress.table.test.js is what holds both halves.
  let numberWidth = NUMBER_COLUMN_MIN
  let titleWidth = 0
  for (const task of rows) {
    const width = displayWidth(numberText(task))
    if (width > numberWidth && width <= NUMBER_COLUMN_MAX) numberWidth = width
    const title = displayWidth(titleText(task))
    if (title > titleWidth) titleWidth = title
  }
  const taskWidth = numberWidth + (titleWidth > 0 ? 1 + titleWidth : 0)

  // `time` last and UNPADDED, so no line trails whitespace into a reader's clipboard.
  const line = (task, verdict, cost, time) =>
    GUTTER +
    padColumn(task, taskWidth) +
    GUTTER +
    padColumn(verdict, VERDICT_COLUMN) +
    GUTTER +
    padColumn(cost, COST_COLUMN) +
    GUTTER +
    time

  // The elided rows are NAMED, never silently missing, the same bargain
  // lib/digest-history.js's MORE_MARKER strikes: how many are not here, and where the
  // rest of them are. A count with no destination would leave the reader nowhere to go,
  // and a table that quietly stopped at eight would make the fraction above it — which
  // still counts every task — look like a bug in Ralph.
  //
  // Directly UNDER THE HEADER, because that is where the missing rows would have been:
  // the rows run oldest to newest, so what was dropped came before the first one shown,
  // and a marker at the foot would read as newer rows withheld. In the view's gutter and
  // off the grid — it is one sentence, not a fifth column.
  const elided = all.length - rows.length
  const marker =
    elided === 0
      ? []
      : [`${GUTTER}… ${fixedDigits(elided)} earlier task${elided === 1 ? '' : 's'} in .ralph/metrics/issues.jsonl`]

  return [
    line('task', 'verdict', 'cost', 'time'),
    ...marker,
    ...rows.map((task) => line(taskCell(task), verdictCell(task), costCell(task), timeCell(task))),
  ]
}

// The JSON surface (#58): the SAME snapshot `renderProgress` consumes, projected
// into the document `ralph status --json` prints. A PROJECTION and nothing more —
// it does not touch the metrics text, does not know the queue depth and recomputes
// no number; it renames camelCase to the snake_case a shell consumer expects,
// converts ms to minutes, and clamps. Which is what makes the two surfaces
// impossible to drift apart: there is one policy, rendered twice.
//
// `mode` is the top-level discriminator, and it is the FIRST thing a consumer
// reads — the same six section keys are present in all four modes, so the mode is
// what says whether a run is in flight at all. `record` supplies only the run's
// IDENTITY (its id, and the number/start of the task in flight): strings and a task
// number copied across, never a number this module could have derived.
//
// Five of the six are a fixed shape whose LEAVES go null; `digest` is null WHOLESALE
// when there is nothing to report, following `tasks.current`, which does the same. The
// difference is real and deliberate: a section whose every leaf is null still asserts
// that the thing exists and was unmeasurable, which is the honest reading for a pace or
// an ETA — there is always a pace, even when we cannot compute it — whereas there is
// genuinely no digest to describe. `.digest.age_min` still resolves either way, to null
// or to a number, which is the property a consumer actually writes against.
//
// The unknown discipline carries straight through: every leaf is either a value or
// `null`, never `0` standing in for absent and never an ABSENT KEY — a consumer
// writes `.eta.finish_at` once and it resolves in every mode. The absent-key half
// takes care: JSON.stringify silently drops an `undefined` leaf, so each field
// here goes through a guard that answers `null` rather than passing `undefined`
// on. `samples`, `completed` and `in_flight` are counts, so a zero there is the
// measurement rather than a stand-in.
//
// `digest` (#63) is the third thing handed in rather than derived, and it is a whole
// SECTION rather than a leaf, so the same one-snapshot rule applies to it: the shell
// builds the digest view once (lib/digest-history.js), the terminal renders it and
// this projection publishes it, and neither surface re-reads `.ralph/digest.log`. A
// caller that has no digest to publish — every mode but `running`, a repo with the
// digest off, an unreadable history — passes nothing, and the key is still there,
// saying `null`.
export function toJsonSnapshot(snapshot, { mode, record, digest } = {}) {
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
    //
    // AND WHAT THE BOARD CALLS IT (#132), for a jira run: `task_key` is the third and LAST key
    // of this object, because a document grows at the END — a consumer reading positionally
    // sees the two fields it always saw, then the new one. It is PRESENT AND NULL for every
    // github and folder run rather than absent, which is this document's rule everywhere:
    // `JSON.stringify` drops an `undefined` leaf, so a key that comes and goes is a `jq`
    // filter that works on one repo and fails on another.
    //
    // #127 DELIBERATELY LEFT THIS OUT and pinned the two-key shape, on the grounds that adding
    // to a published contract "must be a decision somebody makes on purpose". This is that
    // decision: the number here is DERIVED from the key and is not unique across projects
    // (`AAA-7` and `BBB-7` both yield 7), so a machine reading this document had no way to
    // name the ticket the run is working on. The pin moved with the decision.
    tasks: {
      current: inFlight
        ? {
            number: finiteOrNull(record?.current?.number),
            started_at: isoUtcSecondsOrNull(Date.parse(record?.current?.started_at)),
            task_key: recordedKeyOrNull(record?.current?.task_key),
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
    // The run's latest narration (#63), APPENDED LAST — a published document grows at
    // the end, so a consumer diffing two versions of it reads one added key rather
    // than a reorder.
    digest: digestSection(digest),
  }
}

// The digest view, projected. A PROJECTION like every other section here: it renames,
// converts ms to minutes and formats one instant, and it judges nothing — `stale` is
// the view's own verdict, made against the configured interval, and recomputing it
// here would give the document a second opinion about the same digest.
//
// `age_min` and not an `age_ms`: the document's other durations are minutes, and a
// narration's freshness is a minutes-scale question. `at` is TRANSCRIBED, so it uses
// the null-outside-the-calendar rule rather than the clamp — the stamp came off disk
// (see isoUtcSecondsOrNull), and there is no adjacent magnitude to carry the truth if
// it were saturated. `text` is the raw narrative: the terminal's 64-column block is a
// rendering, and a consumer re-wrapping to its own width needs the paragraphs whole.
function digestSection(digest) {
  if (!digest) return null
  const ageMin = minutesOrNull(digest.ageMs)
  return {
    at: isoUtcSecondsOrNull(digest.atMs),
    age_min: ageMin,
    model: textOrNull(digest.model),
    task: textOrNull(digest.task),
    // The document's one boolean, and it is one deliberately: `stale` is a yes/no
    // about a digest, and publishing it as a string would make a consumer parse a
    // word to get an answer it can already read off `age_min` and its own interval.
    //
    // ...and it is a THREE-valued one, because the unknown discipline outranks the type:
    // with no readable clock there is no age to judge, and `false` there would tell a
    // consumer "fresh" when the honest answer is "we cannot say" — the same lie `0` would
    // be for a duration. Tied to `age_min`, not to the view's flag, so the two leaves can
    // never disagree: `age_min: null` always reads `stale: null`. The `=== true` keeps an
    // absent verdict from reaching the wire as `undefined`, which JSON.stringify drops.
    stale: ageMin == null ? null : digest.stale === true,
    text: textOrNull(digest.narrative),
  }
}

// A text leaf, or null. Deliberately NOT runIdOrNull: that one also spells a numeric
// id as a string, because a run id may legitimately arrive as a number out of a
// hand-edited record. These three come off a text parse already typed, so a number
// here would mean something upstream is broken — reporting it as unknown is the
// honest reading, and it keeps `undefined` out of the document either way.
function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null
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
  const n = calendarInstantOrNull(ms)
  return n == null ? null : isoUtcSeconds(n)
}

// The instants a CALENDAR can spell, as a guard rather than a pair of constants —
// the same window `isoUtcSecondsOrNull` above needs (years 0000–9999), because the
// hazard is not the format, it is the instant.
//
// Shared with the report card (#59) so an out-of-calendar finish reads `unknown`
// there for the same reason it reads `null` in the document, off one rule instead of
// two. `Number.isFinite` is NOT this rule and never was: `8.7e15` passes it, and
// `new Date(8.7e15)` is an Invalid Date whose every getter answers NaN.
export function calendarInstantOrNull(ms) {
  const n = finiteOrNull(ms)
  return n == null || n < ISO_FLOOR_MS || n > ISO_CEIL_MS ? null : n
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
// belongsToRun above, which treats an unnamed run as matching nothing. Shared with
// the report card (#59), which scopes its events by the same rule.
export function runIdOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value !== '' ? value : null
}

// The Jira key the RECORD holds, for the `--json` document alone (#132) — a string or null,
// never the empty string and never a number, so a consumer can test the field rather than the
// shape of the field.
//
// NOT `taskKeyOf`, WHICH SCRUBS, and that difference is the same one `runIdOrNull` already
// makes: this is a MACHINE surface, and `JSON.stringify` escapes everything a document has to
// escape, so a key carrying an ANSI escape stays a one-line document with the bytes intact.
// Truncating or scrubbing an identity for a consumer that is not a terminal would publish a key
// that names no ticket — the terminal-safety scrub belongs to the two renderers, which is where
// it is. (Measured for `run_id` in lib/commands/status.json.qa.test.js: 'keeps a hostile run id
// from breaking the one-line contract'.)
//
// BLANK IS NO KEY, decided on the TRIMMED text and then published VERBATIM: `'   '` is not an
// identity, while `' FOO-1 '` is a key somebody hand-edited whitespace into and this document's
// job is to say what the record holds, not to tidy it.
//
// NOR IS IT BOUNDED IN LENGTH, deliberately and consistently with `run_id`: a 1 MB `task_key`
// hand-written into `.ralph/run-state.json` lands in the document at 1 MB. Truncating an
// identity would publish a key that names no ticket, which is worse for the only consumer this
// field has (a machine, resolving a ticket), and the size is bounded by the file the caller
// already chose to read. The TERMINAL surfaces are bounded — `cleanTitle` and the table's
// overflow rule — because there the cost is somebody else's column, not a wrong answer.
//
// NEARLY THE SAME FUNCTION AS `runIdOrNull` ABOVE, and the difference is not an oversight worth
// unifying away: that one also accepts a finite NUMBER and spells it as a string (old records
// wrote numeric run ids), while this one must never coerce, because a number is not a Jira key
// and `123` published as `"123"` would name a ticket that does not exist. Two one-liners with
// two rules beats one with a flag.
const recordedKeyOrNull = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value : null

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

// `#031` — three digits so consecutive lines align; wider numbers are never cut.
// Shared by the live view's progress line, its task table (#56) and the report card's
// failed list (#59), where the padding is what makes `#034 #041` read as a column of
// task numbers.
//
// `fixedDigits` for the same reason `formatElapsed` uses it: one corrupt
// `issue_number: 1e21` in untrusted append-only text would otherwise print `#1e+21`,
// which reads as a bug in Ralph rather than as a bad line in a file.
export function padTaskNumber(number) {
  if (typeof number !== 'number' || !Number.isFinite(number)) return '?'
  return fixedDigits(number).padStart(3, '0')
}

// Wall clock (`16:20`) in the reader's own timezone — these lines answer "when did
// I start this?" and "when will it be done?", which are local-time questions. A
// finish time past midnight simply reads as tomorrow's clock (`04:40`).
//
// `--:--` when it cannot spell the instant, and the guard is the CALENDAR's, not
// `Number.isFinite`'s (#60 QA, #59). A single `duration_ms: 1e16` line — finite,
// positive, past every sample guard — puts `now + etaMs` beyond the range
// `new Date(ms)` can represent, where every getter answers NaN and this printed
// `NaN:NaN`: an invented number wearing a clock's punctuation, which is worse than
// the honest blank the guard above already had a name for. No formatter in this
// codebase may emit NaN, whatever it is handed.
export function formatClock(ms) {
  const at = calendarInstantOrNull(ms)
  if (at == null) return '--:--'
  const d = new Date(at)
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
//
// It DERIVES from `calendarInstantOrNull` rather than re-testing the bounds, which is
// what keeps "one set of bounds" true rather than merely intended: the report card
// (#59) needs the value and the launch box needs the question, and a second copy of
// `ms >= ISO_FLOOR_MS && ms <= ISO_CEIL_MS` is exactly how the two surfaces would
// drift apart on the next edit to either.
function isSpellableInstant(ms) {
  return calendarInstantOrNull(ms) != null
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
export function row(label, segments) {
  return `  ${label.padEnd(LABEL_WIDTH)}${segments.filter(Boolean).join(' · ')}`
}

// One line of the START box's label column (#60). Same rule as `row` above — the
// caller has already dropped its empty segments — with an empty label producing the
// continuation line's bare indent, so the `→` sits under the first line's text.
function launchRow(label, text) {
  return `${LAUNCH_INDENT}${label.padEnd(LAUNCH_LABEL_WIDTH)}${text}`
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

// The whole log as an ARRAY of events, in file order — which is append order, which
// is chronological, which is the order "the last three" means to the pace window.
// Never throws: a read-only status view must not be the thing that breaks on a
// half-written log line.
//
// SINCE #121 IT DECIDES NOTHING ITSELF. What a `RALPH_ISSUE_EVENT` line is — the tag
// found with `indexOf`, the parse that swallows a truncated tail, the shape gate that
// refuses a bare `null` or an array — is lib/issue-event-lines.js's, shared with the
// cycle aggregator and with the launch box that reads the same file backwards. Two
// things stay HERE because they are this function's own and not the walk's:
//
//   * THE ARRAY. `issueEvents` is a generator so that `aggregateCycleCounts` can tally
//     an unbounded log without ever holding its events; this function's callers index,
//     filter and window theirs, so it spreads the walk once, here, rather than making
//     its three call sites — `buildProgress` and `buildLaunchProjection` below, and
//     `buildPostMortem` in lib/post-mortem.js — remember to.
//   * THE COERCION, which is a boundary rule rather than a parse rule. This export is
//     handed whatever a shell's injected `readFile` returned, and a `Buffer` is a log
//     (QA pins that). The parser refuses anything that is not a string on purpose —
//     lib/banner-model.js may not run a hostile `toString` — so the one caller that
//     wants the coercion does it at its own door, in the open.
export function parseIssueEvents(jsonlText) {
  if (!jsonlText) return []
  return [...issueEvents(String(jsonlText))]
}

// issues.jsonl accumulates across runs, so every per-run number has to be scoped.
// An absent run id matches nothing rather than everything: a record too broken to
// name its run has no business claiming another run's tasks as its own.
export function belongsToRun(event, runId) {
  if (runId == null || runId === '') return false
  return String(event.run_id) === String(runId)
}

// The usable values of one numeric field, in file order. Zero, missing and
// non-finite are all "not measured" rather than samples: the loop records a 0
// duration when it could not time an iteration, and a Codex run records no cost at
// all — averaging either in would quietly halve the pace or the rate.
export function usableSamples(events, field) {
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

// ---------------------------------------------------------------------------
// THE ROWS (#56), and the cells they render as.
// ---------------------------------------------------------------------------

// One row per recorded event, in file order, then the in-flight task last. File order
// is append order is chronological, the same order "the last three" means above — no
// sort, for the reason parseIssueEvents gives: `ts` is optional, and sorting on a
// missing key would silently reshuffle the table.
//
// Every numeric cell goes through `measuredOrNull`, which is `usableSamples`' rule for
// a single value: zero, missing and non-finite are all "not measured". A 0 that reached
// the table would print as `$0.00` or `0min` — free, or instant — and both are claims
// this module refuses to make anywhere else.
function buildTaskRows({ runEvents, current, titles, now }) {
  const rows = runEvents.map((event) => {
    // #131 gave the jira arm its telemetry, and the event it appends carries `task_key`
    // beside the number derived from it — the same field name the run record uses, so the
    // same `taskKeyOf` names a CLOSED row that names the in-flight one below. Until then
    // there was nothing to name: a jira iteration recorded no event at all, so every closed
    // row came from a github or folder run and had no key to have. The field stays on every
    // row (null for those two) for one shape rather than two.
    const key = taskKeyOf(event)
    // HOISTED so the handle below is the row's OWN number and not the raw field. A review
    // measured the difference and it is not cosmetic: with `issue_number: "123"` the cell
    // renders `#?` — `finiteOrNull` refused the string, which is this row saying "I could not
    // read this task's number" — while the raw field still resolved GitHub issue 123's title
    // out of the map, so the row was titled by a task it had just declined to name. Both come
    // from `.ralph/metrics/issues.jsonl`, which this repo only ever reads.
    const number = finiteOrNull(event.issue_number)
    return {
      number,
      key,
      // AND IT LOOKS ITSELF UP BY THE SAME KEY (#132) — the rule written out on the in-flight
      // row below, applied identically to a closed one. `key ?? number` is the handle, which
      // is also exactly the expression the cell is rendered from.
      title: resolveTitle(titles, key ?? number, event.title),
      verdict: verdictOrNull(event.verdict),
      costUsd: measuredOrNull(event.total_cost_usd),
      durationMs: measuredOrNull(event.duration_ms),
      inFlight: false,
    }
  })
  if (current) {
    // #127: a jira run's in-flight task is a TICKET (`FOO-123`), and that key is what
    // names the row. The record's `number` is derived from it (lib/jira-key.js) and is a
    // handle for consumers that need an integer, NOT something to show a reader: `#123`
    // is a number nobody can look up, and in a repo that also has GitHub issues it reads
    // as issue #123.
    const key = taskKeyOf(current)
    // Hoisted for the same reason as on the closed row above: the handle must be the number
    // this row will actually PRINT, not the raw `.ralph/run-state.json` field it came from.
    const number = finiteOrNull(current.number)
    rows.push({
      number,
      key,
      // A ROW IS TITLED BY WHATEVER NAMES IT (#132), and this line is the whole of that rule:
      // the lookup handle is `key ?? number`, the same expression `numberText` renders the cell
      // from — literally the same local. So a jira row asks the map for `FOO-123` and a github
      // row asks it for 123.
      //
      // THIS REPLACED A `null`, and the thing it replaced is worth knowing about because the
      // hazard has not gone away — only the defence has changed. Until #132 a keyed row was
      // handed no map at all, because the only lookup source that existed was `gh issue list
      // --json number,title` keyed by GITHUB issue number: the number here is DERIVED from the
      // key (lib/jira-key.js), so looking `FOO-123` up as 123 printed a stranger's issue title
      // beside the ticket as if it were its summary. Withholding the map was the only defence
      // available while every map had one shape.
      //
      // Now that lib/commands/status.js builds a KEY-keyed map for a jira run (jira-queue.js's
      // `titlesFor`) the collision is avoided by WHAT IS WRITTEN, not by what can be
      // represented, and the difference matters. The two key spaces CAN meet: `readIssueTitles`
      // spells its properties `titles[number]`, so a github map's own key is the STRING '123',
      // and `taskKeyOf` deliberately does not enforce the Jira grammar (see its comment — a key
      // the grammar rejects is still the ticket that run is working on), so a `task_key` of
      // '123' would be handed straight to that map and find a GitHub issue's title. A review
      // measured exactly that, and so did this one: `usableJiraKey('123')` answers `'123'`.
      //
      // What actually holds is narrower, and it is a claim about WRITERS rather than about
      // validation. Two things write this field — lib/capture-issue-event.js for an event and
      // lib/run-state.js for the record — and BOTH gate it through the permissive
      // `usableJiraKey`, so neither refuses a digits-only key. What refuses one is further
      // upstream: the value is `RALPH_TASK_KEY`, which templates/ralph.sh sets from the first
      // field of `jira-queue.js pick`, i.e. from a key Atlassian answered with. Jira keys are
      // `PROJECT-123`, so nothing in a real run writes digits alone. That is a bound on the
      // BOARD, not on this repo — and it is enough here because a log hostile enough to write
      // a digits-only key can already write `event.title`, which this line reads anyway.
      //
      // Which is also why this is ONE rule and not two paths — a hybrid metrics file, from a
      // repo that worked GitHub issues and then switched TASK_SOURCE, renders both kinds of row
      // correctly out of one map with no branch to get wrong.
      //
      // The record's OWN title still counts as the fallback, for both kinds: nothing writes one
      // today, and a writer that starts recording the Jira summary needs no change here.
      title: resolveTitle(titles, key ?? number, current.title),
      // No verdict yet, by definition — the row renders as `🔄 live`, which is a
      // status rather than an outcome.
      verdict: null,
      // Nor a cost: the loop records one when the iteration ENDS, so a running task's
      // spend is unknown rather than zero.
      costUsd: null,
      durationMs: inFlightElapsedMs(current, now),
      inFlight: true,
    })
  }
  return rows
}

// The closed set the writer emits (lib/issue-event.js), and null for everything else.
// Normalising HERE rather than in the renderer is what keeps the snapshot's verdict a
// value a consumer could switch on — and it is also the defence: issues.jsonl is
// untrusted text, and a 4 KB "verdict" printed verbatim would take the column with it.
//
// `Object.hasOwn` on a table with exactly three keys, so a row claiming
// `verdict: "constructor"` finds nothing.
function verdictOrNull(verdict) {
  return typeof verdict === 'string' && Object.hasOwn(VERDICT_MARKERS, verdict) ? verdict : null
}

// How long the in-flight task has been going, for the SNAPSHOT — which is not quite
// `elapsedOf` above, and the difference is deliberate. `elapsedOf` reads an unreadable
// `started_at` as 0 elapsed, which is the conservative input to an ETA: the task is in
// flight, so it still owes the estimate a full task's work. Here the same 0 would be a
// zero standing in for an absent measurement, in a `durationMs` field this module
// promises never to fake — it would say "this task has run for no time", and every
// consumer would have to know that what it means is "we could not read its start". So
// this one answers null.
//
// Both renderers already spell that honestly (`timeCell` and `renderProgressLine` put the
// field through `measuredOrNull`, so an absent duration prints `–` and `(unknown)`), which
// is the point rather than a redundancy: the FIELD's own value is the claim `--json`
// publishes, and it is not this function's to weaken.
//
// A start in the FUTURE (clock skew) clamps to 0 rather than reporting a negative elapsed,
// because that read SUCCEEDED — it is a measurement that disagrees with the clock, and a
// negative duration is a number a `--json` consumer could do arithmetic with. Zero and
// negative render identically in both cells (`measuredOrNull` gates on `> 0`), so the
// clamp is about what the field says, not about what a reader sees.
function inFlightElapsedMs(current, now) {
  const started = Date.parse(current?.started_at)
  if (!Number.isFinite(started) || !Number.isFinite(now)) return null
  return Math.max(0, now - started)
}

// One value's worth of `usableSamples`' rule: measured, or null.
function measuredOrNull(value) {
  const n = finiteOrNull(value)
  return n != null && n > 0 ? n : null
}

// The rows a snapshot carries, or none. Both renderers go through this rather than
// trusting `snapshot.tasks`: they are public, a caller can hand them anything, and a
// read-only view must not be the thing that throws on a malformed snapshot.
function taskRowsOf(snapshot) {
  return Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
}

// ---------------------------------------------------------------------------
// THE STRINGS THIS VIEW DOES NOT TRUST. There are two, and both are scrubbed by
// `cleanTitle` below: the issue TITLE, and (#127) the in-flight task's Jira KEY.
// A title comes from a `gh` call the shell made or from a recorded event, a key
// from acli by way of `.ralph/run-state.json` — nothing in either was written by
// this repo, and both end up drawn to a terminal.
// ---------------------------------------------------------------------------

// A task's Jira key (#127), or null for one that has none — every github and folder task,
// and every run recorded before #127 existed.
//
// TAKES THE RUN RECORD'S `current` OR A RECORDED EVENT, because since #131 both spell the
// key the same way (`task_key`, lib/issue-event.js), and one reader for one field name is
// what keeps the in-flight row and the closed rows above from naming the same ticket two
// different ways.
//
// THROUGH `cleanTitle`, THE SAME TRUST BOUNDARY A TITLE CROSSES, and for the same reason
// rather than by analogy: this string was printed by acli, cut out of its JSON by
// lib/jira-queue.js, passed through bash and written into a file this view merely reads —
// so a Jira project whose key carried an ANSI escape, or a `\n  #999 pass` that forges a
// second table row, would arrive here exactly as a hostile issue title does. Scrubbing it
// keeps the key (it is what names the row) and drops what a terminal would obey.
//
// Not `usableJiraKey`: this is a READ-ONLY view of what a run recorded, and a key the
// grammar does not recognise is still the ticket that run is working on. Refusing to
// display it would make the view disagree with the board.
//
// EXPORTED for the two other surfaces that name a task: lib/post-mortem.js, which names
// the last task of a KILLED run, and lib/digest.js, whose `TASK` context a model narrates
// from — both were printing `#123` for `FOO-123` until review caught the first and tracing
// it found the second. Shared rather than copied for the reason all three modules already
// share `padTaskNumber`: the scrub and the "a key the grammar cannot parse is still a name"
// rule are one policy, and a second copy of it would drift the moment either half changed.
export function taskKeyOf(current) {
  const raw = current?.task_key
  return typeof raw === 'string' ? cleanTitle(raw) : null
}

/**
 * The Jira keys the table is ABOUT TO NAME (#132) — the handles a caller should look summaries
 * up for, in row order, with the in-flight ticket last. Empty for a github or folder run,
 * because those tasks have no key.
 *
 * WHY THIS LIVES HERE AND NOT IN THE SHELL. "Which rows the table draws" is this module's
 * policy: the cap, the in-flight-last ordering, the run scoping and the scrubbing are all
 * already decided in this file, and a second copy of them in lib/commands/status.js would drift
 * the moment any one of them moved — a cap raised here would leave the last row untitled, and a
 * scrub changed here would have the lookup ask about a key that is not the key drawn.
 *
 * THE SCRUBBED KEY IS THE ONE ASKED ABOUT, for exactly that reason: `taskKeyOf` is what names
 * the row, so it is also what the row is titled by, and one string means a truncated or
 * scrubbed key cannot name one ticket while being titled from another. A key that scrubs away
 * to nothing is not asked about at all.
 *
 * BOUNDED BY THE TABLE, which is the point of doing it here: at most MAX_TABLE_ROWS closed keys
 * plus the one in flight — nine — whatever a night's run left in issues.jsonl. De-duplicated,
 * because a retried ticket occupies two rows and is one question.
 *
 * NO `runAlive` GATE, unlike `buildProgress`'s row builder: the record's `current` survives the
 * end of a run (run-state's `endRun` keeps it deliberately), so for a DEAD run this returns one
 * key the table will not draw. Harmless and cheaper than the alternative — it is one more key in
 * a query that is already being made — and the only caller does not ask at all unless the run is
 * running (lib/commands/status.js).
 *
 * A SECOND PARSE of the metrics text, and knowingly: `buildProgress` parses it too, and the
 * caller needs the keys BEFORE it can build the map that `buildProgress` is handed. Paid only in
 * jira mode, only for the human view (`--json` resolves no titles at all), on a text this
 * process has already read into memory.
 *
 * @param {{metricsText?: string, record?: object}} [input] the same two inputs buildProgress takes
 * @returns {string[]} the keys, in row order; `[]` when there are none
 */
export function taskKeysFor({ metricsText, record } = {}) {
  const events = parseIssueEvents(metricsText).filter((event) =>
    belongsToRun(event, record?.run_id),
  )
  const keys = []
  const seen = new Set()
  const add = (key) => {
    if (key === null || seen.has(key)) return
    seen.add(key)
    keys.push(key)
  }
  // Sliced BEFORE the de-duplication, mirroring the renderer: it draws the last MAX_TABLE_ROWS
  // closed rows and a repeated ticket occupies two of them, so the window is the same window.
  for (const event of events.slice(-MAX_TABLE_ROWS)) add(taskKeyOf(event))
  if (record?.current) add(taskKeyOf(record.current))
  return keys
}

// The injected map wins over a title the EVENT carries, and the event's is a fallback
// rather than the primary source. That ordering is forward compatibility in one
// direction and freshness in the other: nothing writes `event.title` today, so reading
// it costs nothing and means a writer that starts recording one needs no change here —
// but when both exist the injected one is what the shell just looked up, and the
// recorded one is however the task was titled when it was closed.
//
// `handle` IS WHATEVER NAMES THE ROW (#132) — the Jira key when the task has one, the task
// number when it does not — and that single rule is what replaced the older defence of
// withholding the map from a keyed row. See `buildTaskRows` for why the substitution is
// safe rather than merely tidier.
function resolveTitle(titles, handle, eventTitle) {
  const injected = lookupTitle(titles, handle)
  const raw =
    typeof injected === 'string' ? injected : typeof eventTitle === 'string' ? eventTitle : null
  return raw == null ? null : cleanTitle(raw)
}

// A HANDLE WORTH LOOKING UP: a finite number, or a non-empty string. Everything else — NaN, a
// number that is not one, `''`, an object — is a row with no identity to ask about, and asking
// anyway would read `titles[NaN]` or `titles['']`, both of which a hostile map can define.
const usableHandle = (handle) =>
  typeof handle === 'string' ? handle !== '' : typeof handle === 'number' && Number.isFinite(handle)

// A plain object OR a `Map`, and NEITHER is required to be well-formed. The shell builds
// this out of `gh issue list --json number,title` output, or out of an `acli` search (#132) —
// both a subprocess's stdout, so "not a map at all" is a shape this has to answer, not an
// assertion it may make. Anything unrecognised reads as no title, which renders the row as
// its own name and nothing else.
//
// Both key types are tried on a Map because `JSON.parse` gives an object with STRING
// keys while the events carry numbers; an object needs no such branch, since property
// access coerces the number itself. A string handle makes the two `get` calls identical,
// which costs one redundant lookup on a Map and keeps the branch single.
function lookupTitle(titles, handle) {
  if (titles == null || typeof titles !== 'object') return undefined
  // THE WHOLE BODY is guarded, not just the `Map.get` call — QA's finding, and the guard
  // used to sit around the one read that made its failure obvious. Every read below runs
  // caller code on a shape this function promises to accept: sniffing `.get` fires an own
  // getter or a Proxy's `get` trap, `Object.hasOwn` fires a Proxy's `has` /
  // `getOwnPropertyDescriptor` trap, and `titles[handle]` fires an own getter. A throw
  // from any of them escaped `buildProgress` and took the entire view down over a
  // COURTESY lookup — for a repo whose `gh` answered, at that.
  //
  // Which one threw is not worth distinguishing: the answer is the same one an absent map
  // gives, and the row renders as its number. That is the contract stated above, and this
  // is what makes the code match it.
  //
  // THE HANDLE IS CHECKED ABOVE THE BRANCH, not inside the object arm — review's finding, and
  // the guard used to sit below, which made the comment on `usableHandle` describe half of what
  // it protects. A Map is only ever a test's shape here, so this costs nothing in production
  // and makes the claim complete: `''`, `NaN` and `null` are not asked of either kind of map.
  try {
    if (!usableHandle(handle)) return undefined
    if (typeof titles.get === 'function') {
      return titles.get(handle) ?? titles.get(String(handle))
    }
    // `hasOwn`, so a task named like a prototype key — `#123` or a project literally called
    // `constructor` — cannot inherit `[object Object]` as its title.
    return Object.hasOwn(titles, handle) ? titles[handle] : undefined
  } catch {
    return undefined
  }
}

// THE TRUST BOUNDARY, and it is the second one this view has. The first is
// lib/digest-history.js's `printable`, which this deliberately SUPERSEDES rather than
// follows: that one is a single pass over C0-minus-newline, DEL and C1, and the three
// things it does not do are point 1 below (the input bound), point 2 (taking a sequence
// whole rather than only its ESC) and the Cf/Cs/Co/Zl/Zp categories that point 2's byte
// pass carries with it — see OBEYED_BYTES. The
// difference is the input, not a disagreement — `printable` reads a file Ralph's own model
// wrote, while a GitHub issue title is prose somebody else wrote (on a public repo,
// anybody at all) arriving over a pipe into a terminal that OBEYS some of what it is sent.
// Which is also why unifying the two is a FOLLOW-UP and not #56: the stricter pass is the
// one that should survive, and moving it means re-testing the digest against it. So:
//
//   1. BOUND THE WORK FIRST. Everything below is a few passes over a string whose
//      length a stranger chose. 1000 characters is far more than 24 columns can show.
//   2. TAKE THE SEQUENCES WHOLE, then the bytes. Stripping the ESC alone would leave
//      `[31mred` on the line; taking the sequence first leaves nothing to read.
//   3. EVERY REMOVED BYTE BECOMES A SPACE, never nothing — otherwise a scrubbed
//      sequence fuses the words either side of it into one — and the run then collapses
//      like any other whitespace, which is also what turns a forged `\n  #999 pass`
//      row back into part of one cell.
//   4. AN EMPTY RESULT IS NO TITLE. `''` would silently widen nothing and print a
//      trailing space; null renders the number alone, which is honest.
//
// What is NOT stripped: combining marks. A decomposed accent — a bare letter followed by
// U+0301 — is how macOS writes an accented word, and removing Mn would corrupt ordinary
// text where a title is not English. They are zero-WIDTH, which `displayWidth`
// handles, and their other hazard — thousands of them stacked on one cell — is a
// question of how many code points are emitted, which `truncateToWidth` caps.
function cleanTitle(raw) {
  const bounded = raw.length > RAW_TITLE_LIMIT ? raw.slice(0, RAW_TITLE_LIMIT) : raw
  const printable = bounded
    .replace(CSI_SEQUENCE, ' ')
    .replace(OSC_SEQUENCE, ' ')
    .replace(OBEYED_BYTES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return printable === '' ? null : truncateToWidth(printable, TITLE_WIDTH)
}

// Truncation with the ellipsis PAID FOR inside the budget, so a cut title is exactly as
// wide as an uncut one is allowed to be — otherwise the marker itself would push the
// column it exists to protect.
//
// TWO caps, because they catch different lies: the column budget is what the terminal
// draws, and the code-point limit catches text whose drawn width is nearly zero (a
// thousand combining marks) but which is neither readable nor cheap to render.
function truncateToWidth(text, width) {
  const points = [...text]
  if (points.length <= TITLE_CODE_POINT_LIMIT && displayWidth(text) <= width) return text
  const budget = width - 1
  let used = 0
  let out = ''
  for (const ch of points.slice(0, TITLE_CODE_POINT_LIMIT - 1)) {
    const w = charWidth(ch)
    if (used + w > budget) break
    used += w
    out += ch
  }
  return out + ELLIPSIS
}

// ---------------------------------------------------------------------------
// COLUMNS — what a terminal actually draws, which is not what `.length` counts.
// ---------------------------------------------------------------------------

// Width in TERMINAL COLUMNS, iterating code points (`for…of` on a string) rather than
// UTF-16 units. Both halves of that matter and they pull in opposite directions: an
// emoji is one code point of two columns but two units, while a CJK character is one
// unit of two columns — so `padEnd`, which counts units, is wrong in both directions
// and a single such title would bend the whole grid around itself.
function displayWidth(text) {
  let width = 0
  for (const ch of String(text)) width += charWidth(ch)
  return width
}

function charWidth(ch) {
  // Zero FIRST, because the three rules overlap and the zero-width one has to win. The
  // combining kana voiced sound mark (U+3099) is Mn and it also sits inside the Hiragana
  // range below, so testing the wide ranges first would give a mark that draws nothing two
  // columns of its own. U+FE0F, the variation selector that asks for emoji presentation, is
  // caught here too — it is Mn, not Cf, and it is not Emoji_Presentation itself; the
  // character it modifies is what carries the width.
  if (ZERO_WIDTH.test(ch)) return 0
  if (EMOJI_WIDE.test(ch)) return 2
  const point = ch.codePointAt(0)
  for (const [lo, hi] of WIDE_RANGES) if (point >= lo && point <= hi) return 2
  return 1
}

// Pad to a column count, never truncate. A cell WIDER than its column overflows its own
// line and leaves every other row where it was — which is the right failure for the two
// things this table will not shorten, a task's number and its money.
function padColumn(text, width) {
  const pad = width - displayWidth(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}

// ---------------------------------------------------------------------------
// THE CELLS.
// ---------------------------------------------------------------------------

// WHAT NAMES A TASK: its Jira key when it has one, else the padded number (#127). The key
// is preferred because it is the only spelling a reader can look up — `#123` derived from
// `FOO-123` names nothing, and in a repo that also has GitHub issues it names the wrong
// thing. Both renderers below go through this ONE function, so the table and the progress
// line cannot disagree about what the task is called.
const numberText = (task) =>
  typeof task?.key === 'string' && task.key !== '' ? task.key : `#${padTaskNumber(task?.number)}`
const titleText = (task) => (typeof task?.title === 'string' ? task.title : '')

// `#029 sidebar`, or `#029` alone. The space belongs to the title rather than to the
// number, so a titleless run's column is as narrow as its numbers.
function taskCell(task) {
  const title = titleText(task)
  return title === '' ? numberText(task) : `${numberText(task)} ${title}`
}

// Marker AND word, not the marker alone: the glyph is what a reader scans for down the
// column, and the word is what survives a terminal without the font, a `grep`, and a
// reader who cannot see colour or emoji at all. Padding the word — never the raw
// value — is what makes all four cells one width by construction.
function verdictCell(task) {
  if (task?.inFlight) return `${IN_FLIGHT_MARKER} ${IN_FLIGHT_WORD.padEnd(VERDICT_WORD_WIDTH)}`
  const verdict = verdictOrNull(task?.verdict) ?? 'unknown'
  return `${VERDICT_MARKERS[verdict]} ${verdict.padEnd(VERDICT_WORD_WIDTH)}`
}

// Money in the module's ONE spelling, so a cost in the table and the same cost in the
// `spend` line below it cannot disagree about how much precision they have. `–` for
// anything unmeasured, which is the whole reason this column is worth a table: a reader
// scanning it must never wonder whether `$0.00` means free or unrecorded.
function costCell(task) {
  const usd = measuredOrNull(task?.costUsd)
  return usd == null ? UNKNOWN_CELL : usdText(usd)
}

// `97min` for a closed task, `~40min` for the one still running — the `~` because the
// number is still moving, the same qualifier the pace and ETA lines wear.
function timeCell(task) {
  const ms = measuredOrNull(task?.durationMs)
  if (ms == null) return UNKNOWN_CELL
  return `${task?.inFlight ? '~' : ''}${taskMinutes(ms)}`
}

// MINUTES past the hour, unlike `formatElapsed`'s `3h12m`. This column is read DOWN,
// against the other tasks and against the `~84 min/task` pace line two lines below it,
// and minutes are the unit that comparison happens in — the same argument the pace line
// already makes for itself. The RUN-scale spans keep the hour, and the two never
// describe the same quantity.
function taskMinutes(ms) {
  return `${fixedDigits(Math.max(0, Math.round(ms / 60000)))}min`
}

// The bar and the percentage, from one ratio so they cannot disagree.
//
// BOTH ENDS RESERVE, and they reserve TOGETHER. A run one task short of done must not
// print `100%` or a full bar beside a task still in flight; a run that has finished one
// of sixty — or one of 102, the queue count's own `--limit 100` ceiling plus a task in
// flight — must not print `0%` or an empty one. Erasing a task that really ran is the
// `$0.00` mistake in another alphabet, and it is the same mistake whether it happens in
// the picture or in the number beside it. Hence the floor of 1% rather than a bare
// `Math.floor`, which is what makes the two ends symmetrical.
//
// `Math.floor` for everything in between, deliberately: a progress reading should never
// round UP to a milestone the run has not reached.
function renderBar(ratio) {
  const clamped = Math.min(1, Math.max(0, finiteOrNull(ratio) ?? 0))
  let filled = Math.round(clamped * BAR_WIDTH)
  if (filled === 0 && clamped > 0) filled = 1
  if (filled === BAR_WIDTH && clamped < 1) filled = BAR_WIDTH - 1
  const percent =
    clamped === 0 ? 0 : clamped === 1 ? 100 : Math.max(1, Math.floor(clamped * 100))
  return `[${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(BAR_WIDTH - filled)}] ${percent}%`
}

function mean(values) {
  return sum(values) / values.length
}

export function sum(values) {
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
export function finiteOrNull(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  return n === 0 ? 0 : n
}
