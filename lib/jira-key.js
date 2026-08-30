// PURE Jira key grammar — NO I/O (#127). `FOO-123` is what a Jira work item is called, and
// this is the single place that reads one. Sibling of jira-jql.js and task-source.js: a
// grammar, tested as a grammar, importing nothing at all.
//
// THIS MODULE IMPORTS NOTHING, and that is load-bearing in the same way it is for
// jira-jql.js: lib/run-state.js consumes it, and run-state.js runs as its OWN CLI inside
// the loop's tmux pane — the "observability sidecar" its error path calls itself — as well
// as being imported by `ralph status`. A grammar with no edges can be read by anything
// without dragging a spawner behind it. The loop's telemetry sidecar proper,
// lib/capture-issue-event.js, reads keys too since #131 — a second `|| true` CLI the loop
// spawns per iteration, and the same argument applies to it exactly.
//
// WHY A NUMBER AT ALL, since Jira's identifier is the key. `.ralph/run-state.json` has
// carried a NUMERIC `number` for the in-flight task since #55, and so does every issue
// event lib/issue-event.js writes; both were designed around `gh issue`, where the number
// IS the name. Rather than widening those fields' types in a slice about selection, the
// number is DERIVED from the key — `FOO-123` yields 123 — and the key is recorded beside
// it. So a jira run's record has both spellings: the one a reader recognises on the board,
// and the one every existing consumer already knows how to read.
//
// THE DERIVED NUMBER IS NOT UNIQUE ACROSS PROJECTS, and nothing here pretends otherwise:
// `FOO-123` and `BAR-123` both yield 123. That is tolerable exactly because the number is
// a HANDLE and never an identity — one run works one queue, and the key is what names the
// ticket on the surfaces that name the task in flight. That claim is enumerable, so here is
// the list, all four measured: the progress line and the task table (progress.js
// `numberText`), the interrupted card's `last task` row (post-mortem.js) and the digest's
// `TASK` context (digest.js). FOUR places still publish the NUMBER, and only the first is
// harmless: `ralph status --json`, which as of #132 publishes the KEY BESIDE it
// (`tasks.current.task_key`), so a script reading that document is offered the ticket's real
// name and the number is a handle it may ignore — the one member of this list that is now
// CLOSED, and it closed by growing the document rather than by re-spelling the number;
// `ralph digest`, which derives the transcript path it quotes (`logs/ralph-issue-123.log`)
// from the number rather than the key, so the same prompt that says `FOO-123` carries a
// GitHub-shaped path two lines later; and TWO summary lines built out of the EVENTS, which
// #131 made reachable under this source by giving the jira arm telemetry at all — before it,
// a jira run appended no events, so both lines below had nothing to name and printed nothing.
//
// Those two are `ralph cycle`'s end-of-run summary, whose `OK:`/`FAIL:` lists are
// `#`-prefixed `issue_number`s taken off the events (lib/commands/cycle.js) — a line both
// printed and SENT as the run's notification, so a Jira cycle reports `OK: #123` for a
// ticket called `FOO-123` — and the REPORT CARD's `outcome` row, whose failed list is the
// same field read off the same events by `tallyVerdicts` (lib/post-mortem.js). One card
// therefore carries both spellings of one ticket:
//
//   outcome    1 ok · 2 failed  — #123
//   last task  FOO-123
//
// #131 recorded the key beside the number so that both of those are rendering changes
// somebody can make later rather than schema ones; it made NEITHER, and deliberately not
// just one: they are the same change — one list of numbers off one stream of events — and a
// run whose events carry both spellings needs a single rule for printing `#41` beside
// `FOO-123`, which is worth deciding once. Both are pinned as they stand, so the slice that
// takes them reddens a test rather than guessing: lib/commands/cycle.qa.test.js, and
// lib/post-mortem.qa.test.js's "prints the ticket TWO WAYS on one card".
//
// THAT SECOND ONE IS A REAL DEFECT and not just a naming slip, and #128 is what made it
// bite. Before #128 a jira iteration invoked no agent at all, so nothing wrote a per-task log
// and the digest had nothing to find under EITHER spelling — the wrong path cost nothing
// because no right path existed. #128 dispatches the agent and writes the transcript named
// from the KEY (the jira arm derives a filesystem-safe `task_log_handle` from it, which is the
// key itself for anything the grammar above recognises), while digest.js still builds its
// tail path from `record.current.number` alone and its `inFlightLogPath` formats
// `logs/ralph-issue-${number}.log`. So `ralph digest` is now blind to every jira transcript
// that exists, and it degrades QUIETLY: the ENOENT is swallowed and the digest still reports
// ok, so the narration is prose about the run with no transcript behind it. In a repo that has
// also worked GitHub issues that path can be issue #123's log instead, and two tickets sharing
// a number (`AAA-7`, `BBB-7`) collide on one path. Read as an UNFINISHED IMPROVEMENT rather
// than a regression — it was equally wrong and entirely harmless the day it was written.
//
// #131 DID NOT FIX IT, and this comment used to promise it would ("#131 is its home"), which
// is the kind of claim worth not making twice: that slice gave the jira arm its telemetry and
// nothing in it touched digest.js, which still names that path from `record.current.number`. What
// it did do is put the KEY into the record telemetry writes (`task_key`, lib/issue-event.js),
// which is the ingredient a fix needs — the path can be named from the key the loop actually
// used instead of a number reconstructed from it. Left as an OPEN follow-up with no owning
// slice named here; lib/digest.qa.test.js pins the current behaviour so the day it changes, a
// test says so, and the README carries the same argument. And if a cross-project reading is
// ever needed it needs the key, not this number.
//
// TWO POSTURES, ON PURPOSE, and the second is the one worth reading twice:
//
//   STRICT — `isJiraKey` / `normalizeJiraKey` / `numberFromKey` answer for the grammar
//   below and refuse everything else. A malformed key yields null rather than a throw,
//   because every production caller of this trio is on a path that must not fail over a name
//   it could not parse: `numberFromKey`, in run-state.js's `beginTask` and in
//   capture-issue-event.js's `resolveTaskNumber` (#131) — one a RECORD WRITE and the other a
//   TELEMETRY append, each run by the loop with `|| true` — and `normalizeJiraKey`, on a
//   read-only view's render path.
//
//   `normalizeJiraKey` HAS EXACTLY ONE PRODUCTION CALLER OUTSIDE THIS FILE — `usableJiraKey`
//   below is built out of it, so it has always run wherever that one does (the queue's verbs,
//   run-state.js, capture-issue-event.js, build-prompt.js) — and that one caller is the most
//   load-bearing use
//   the strict posture has: jira-queue.js's `titlesFor` (#132) calls it twice, once on the keys
//   `ralph status` hands it and once on the keys acli answers with. That is the ONE place in
//   this repo where a key becomes QUERY SYNTAX — it is interpolated into a JQL string, `key IN
//   (…)`, rather than passed as an argv element — so the grammar is the injection gate, and
//   `[A-Za-z][A-Za-z0-9_]*-\d+` is what guarantees no quote, paren or JQL operator can be in
//   there. A key the grammar rejects is DROPPED, and if none survives no process is spawned.
//   That is a deliberate deviation from the permissive posture below, argued at the call site.
//
//   `isJiraKey` STILL HAS NO PRODUCTION CALLER — said plainly rather than implied by "every
//   caller", which review caught this comment asserting once already. It is the grammar's own
//   vocabulary, exercised directly by this module's tests (a predicate is the honest way to pin
//   what the regex accepts), and `normalizeJiraKey` is what `usableJiraKey` is built out of.
//   Kept for that, not deleted.
//
//   PERMISSIVE — `usableJiraKey` is the key RALPH WILL USE, in an acli argv and in the run
//   record, and it passes an unrecognised one THROUGH. Jira names its own tickets: a
//   project key this regex has never seen is still the ticket acli said was next, and
//   refusing to claim it would be Ralph's regex overruling the board — a queue that reads
//   as permanently empty for whoever owns that project. The cost of being permissive is a
//   record with a key and no number, which is a shape the record already allows (`number`
//   has always been nullable, meaning "unknown"). The cost of being strict would be a run
//   that cannot work at all. So the grammar VALIDATES and never GATES.
//
// THE GRAMMAR is Jira's own project-key rule as Jira documents it — a letter, then letters,
// digits or underscores — a hyphen, then the digits of the work item number. It is
// deliberately narrower than Jira's full field of possibilities in one respect worth
// naming: `FOO-BAR-1` is refused, because a project key cannot contain a hyphen, so the
// second hyphen means this is not a key Ralph can take a number out of. `usableJiraKey`
// still hands that string on.

// One place, one pattern. Anchored, and the number is digits ONLY: `FOO-1.5`, `FOO-+1` and
// `FOO-12a` are not work items, and a tolerant parse would turn each of them into a number
// pointing at a DIFFERENT ticket than the text says.
const JIRA_KEY = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/

// Never coerced — `String(value)` on a hostile object runs a getter that can throw, and on
// a symbol it throws outright. A key that is not a string is a caller bug, and the answer
// to a caller bug here is null rather than an exception on a status view's render path.
const trimmedOrNull = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

const matchKey = (value) => {
  const trimmed = trimmedOrNull(value)
  return trimmed === null ? null : JIRA_KEY.exec(trimmed)
}

/**
 * Is this text a Jira work item key Ralph can read?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isJiraKey(value) {
  return matchKey(value) !== null
}

/**
 * The key in the spelling Jira itself uses: an UPPERCASE project key. Whitespace is
 * trimmed and the case of the project key is fixed; the NUMBER is left exactly as written,
 * leading zeros and all, because the key is Jira's identity and renumbering it would ask
 * about a different ticket.
 *
 * @param {unknown} value
 * @returns {string|null} the normalized key, or null when this is not one
 */
export function normalizeJiraKey(value) {
  const match = matchKey(value)
  return match === null ? null : `${match[1].toUpperCase()}-${match[2]}`
}

/**
 * The numeric handle a key carries — `FOO-123` → 123 — for the record fields that predate
 * Jira and are typed as numbers.
 *
 * A number too big to hold exactly is NOT a number here, the same refusal `parseCount` in
 * jira-acli.js makes: past Number.MAX_SAFE_INTEGER the digits stop round-tripping, so the
 * value would name a different ticket than the text does.
 *
 * @param {unknown} value
 * @returns {number|null} the work item number, or null when there is none to read
 */
export function numberFromKey(value) {
  const match = matchKey(value)
  if (match === null) return null
  const n = Number(match[2])
  return Number.isSafeInteger(n) ? n : null
}

/**
 * The key as Ralph will USE it — in an acli argv, in `.ralph/run-state.json`. Normalized
 * when the grammar recognises it, and passed through trimmed when it does not, for the
 * reason in the header: Jira names the ticket, this module only reads the name.
 *
 * @param {unknown} value
 * @returns {string|null} the key to use, or null when there is nothing usable
 */
export function usableJiraKey(value) {
  return normalizeJiraKey(value) ?? trimmedOrNull(value)
}
