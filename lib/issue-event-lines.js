// #121 — how a line of .ralph/metrics/issues.jsonl becomes an event, in ONE place.
//
// The log is one `RALPH_ISSUE_EVENT <json>` line per finished issue iteration, appended by a
// bash loop with `>>` and never truncated, so it accumulates across every run a repo has ever
// done. Reading it back has always taken the same four rules applied in the same order:
//
//   * FIND THE TAG WITH `indexOf`, NOT `startsWith`. The loop pipes its output through `tee`
//     and a pretty-printer, so a line can arrive with a timestamp or a prefix in front of the
//     tag and still be a perfectly good event.
//   * PARSE INSIDE A `try`, AND SKIP WHAT THROWS. A run killed mid-append leaves a half-written
//     last line, which is the NORMAL state of this file rather than an exceptional one.
//   * CHECK THE SHAPE, NOT ONLY THE PARSE. `null`, `42`, `"done"`, `true` and `[]` are all
//     valid JSON and none of them is an event.
//   * NEVER THROW, WHATEVER THE LINE LOOKS LIKE. Every consumer is a reader — a cycle report, a
//     status view, a launch box — and none of them may die for a log line.
//
// THREE MODULES USED TO SPELL ALL FOUR OUT FOR THEMSELVES, plus a fourth copy of the tag:
// `aggregateCycleCounts` in lib/issue-metrics.js, `parseIssueEvents` in lib/progress.js, and
// `newestEvent` in lib/banner-model.js. They agreed, which was both the point and the problem —
// `ralph cycle`, `ralph status` and the launch box read the SAME file, so the day two of those
// loops drifted a reader would not see drift, they would see the box contradicting
// `ralph status` about a run and file it as a bug. The rules live here now, and the three
// callers differ only in which DIRECTION they walk and what they do with what they get.
//
// PURE AND IMPORT-FREE, which is the constraint that decided where this module lives. The
// obvious home was lib/issue-metrics.js, since that module owns the file and already held the
// tag — but it also holds `node:fs`, and both lib/banner-model.js and lib/progress.js are
// asserted pure by static reads of their own source. A shared parser they cannot import is not
// shared. So this file has no imports at all and no capabilities to lend, and
// issue-event-lines.test.js checks that rather than assuming it.
//
// IT OWNS THE WRITE DIRECTION TOO, to the extent one string can: `appendIssueEvent` joins
// payloads onto the same `ISSUE_EVENT_TAG` its readers slice off, so the format has exactly one
// spelling in the shipped source. A test next door sweeps lib/ to keep it that way.
//
// TEXT IN, EVENTS OUT — and the text has to be text. Normalizing a `Buffer` or some other
// value an injected `readFile` handed back is the CALLER's business (see the coercion in
// `parseIssueEvents`), because `String(value)` on a hostile bag runs its `toString`, and
// lib/banner-model.js's never-throws contract is written against exactly that.

/**
 * The log's line tag, byte for byte — read by every consumer and written by `appendIssueEvent`.
 *
 * The trailing space is load-bearing in both directions: readers slice at
 * `indexOf(tag) + tag.length` and the writer joins the payload straight onto it. The file is
 * append-only across upgrades, so this string can never change.
 */
export const ISSUE_EVENT_TAG = 'RALPH_ISSUE_EVENT '

/**
 * One line in, one event or `null` out. The four rules above, and the only place they live.
 *
 * AN ARRAY IS NOT AN EVENT, and that is the one rule the three old copies did not all share:
 * `aggregateCycleCounts` gated on `!event || typeof event !== 'object'`, which admits `[]`,
 * while the other two also rejected `Array.isArray`. Nothing observable changed by taking the
 * stricter rule — a JSON array cannot carry a numeric `ts`, so the aggregator dropped it on the
 * very next line anyway — but it is now a decision in one place instead of a difference nobody
 * had noticed, and issue-event-lines.test.js pins it so a reader does not have to wonder.
 */
function eventOn(line) {
  const at = line.indexOf(ISSUE_EVENT_TAG)
  if (at === -1) return null
  let value
  try {
    value = JSON.parse(line.slice(at + ISSUE_EVENT_TAG.length))
  } catch {
    return null
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/**
 * Every event in the log, oldest first — a GENERATOR, so no caller has to hold the EVENTS.
 *
 * Precisely the events, and no more than that: both walks in this file `split` the whole text
 * before they look at any of it, so a log's worth of LINES is materialised either way. What the
 * generator saves is the array of parsed objects on top of them — which is what the issue asked
 * for, and it earns its keep at one of the two call sites: `aggregateCycleCounts` tallies
 * verdicts as it walks and never wants the events themselves, and this file grows without bound.
 * `parseIssueEvents` spreads it into the array its own callers index and filter, and says so
 * where it does it.
 *
 * FILE ORDER, WITH NO SORT. Append order is chronological, which is what "the last three" means
 * to the pace window — and `ts` is optional, so sorting on it would silently reshuffle that
 * window for a log with one undated line in it.
 *
 * @param {string} text the whole log, as text. Anything that is not a non-empty string yields
 *   nothing, including a value a failed read handed back.
 * @yields {object} each parseable event, in file order. Never throws.
 */
export function* issueEvents(text) {
  if (typeof text !== 'string' || !text) return
  for (const line of text.split('\n')) {
    const event = eventOn(line)
    if (event) yield event
  }
}

/**
 * The newest parseable event, or `null` — the same gate as the forward walk, from the other end.
 *
 * FROM THE END, because the file is append-only and accumulates across runs: for the launch box
 * the interesting event is the last one, not the first, and a forward generator cannot serve
 * that without reading the whole log to reach its tail. It returns on the FIRST line that
 * parses, which is not merely an optimisation — lib/banner-model.js depends on the search
 * STOPPING there. An event that parses but names no model has to end the scan so the box can
 * answer `unknown`, rather than reaching back to an older run and labelling it `last-run`.
 *
 * @param {string} text the whole log, as text — same contract as `issueEvents`.
 * @returns {object|null} the last parseable event, or null if the text holds none. Never throws.
 */
export function newestIssueEvent(text) {
  if (typeof text !== 'string' || !text) return null
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = eventOn(lines[index])
    if (event) return event
  }
  return null
}
