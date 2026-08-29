// PURE Jira key grammar — NO I/O (#127). `FOO-123` is what a Jira work item is called, and
// this is the single place that reads one. Sibling of jira-jql.js and task-source.js: a
// grammar, tested as a grammar, importing nothing at all.
//
// THIS MODULE IMPORTS NOTHING, and that is load-bearing in the same way it is for
// jira-jql.js: lib/run-state.js consumes it, and run-state.js runs as its OWN CLI inside
// the loop's tmux pane — the "observability sidecar" its error path calls itself — as well
// as being imported by `ralph status`. A grammar with no edges can be read by anything
// without dragging a spawner behind it. (The loop's telemetry sidecar proper is
// lib/capture-issue-event.js, which does not read keys at all.)
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
// ticket on every surface a human reads. That claim is enumerable, so here is the list, all
// four measured: the progress line and the task table (progress.js `numberText`), the
// interrupted card's `last task` row (post-mortem.js) and the digest's `TASK` context
// (digest.js). TWO places still publish the NUMBER, and only the first is harmless:
// `ralph status --json`, whose key set is frozen — a machine surface, and a documented
// follow-up rather than a reader being shown `#123` — and `ralph digest`, which derives the
// transcript path it quotes (`logs/ralph-issue-123.log`) from the number rather than the
// key, so the same prompt that says `FOO-123` carries a GitHub-shaped path two lines later.
// That second one is a REAL DEFECT and not just a naming slip: a jira iteration invokes no
// agent, so it writes no per-task log, which leaves that path either absent or — in a repo
// that has also worked GitHub issues — a different task's transcript. Both the README and
// digest.js carry the argument; the fix is a follow-up. Telemetry consumes this properly in
// a later slice, and if a cross-project reading is ever needed it needs the key, not this.
//
// TWO POSTURES, ON PURPOSE, and the second is the one worth reading twice:
//
//   STRICT — `isJiraKey` / `normalizeJiraKey` / `numberFromKey` answer for the grammar
//   below and refuse everything else. A malformed key yields null rather than a throw,
//   because the production caller of this trio is on a path that must not fail over a name
//   it could not parse: `numberFromKey`, in run-state.js's `beginTask`, which is a RECORD
//   WRITE the loop runs with `|| true` and must never turn into a failed iteration.
//
//   `isJiraKey` AND `normalizeJiraKey` HAVE NO PRODUCTION CALLER TODAY — said plainly
//   rather than implied by "every caller", which review caught this comment asserting.
//   They are the grammar's own vocabulary: `normalizeJiraKey` is what `usableJiraKey` is
//   built out of, both are exercised directly by this module's tests (a predicate is the
//   honest way to pin what the regex accepts), and the next slice's telemetry needs the
//   validating pair when it starts recording keys. Kept for that, not deleted, and not
//   claimed to be load-bearing in the meantime.
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
 * jira-queue.js makes: past Number.MAX_SAFE_INTEGER the digits stop round-tripping, so the
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
