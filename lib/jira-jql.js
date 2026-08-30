// PURE JQL composition — NO I/O (#126). The single place that turns the JIRA_JQL line a
// user wrote in ralph.config.sh into the query Ralph actually runs. Sibling of
// git-remote-slug.js and task-file.js: a grammar, tested as a grammar, reachable from a
// command that has to spawn a process without dragging the spawner in here.
//
// THE SPLIT OF RESPONSIBILITY IS THE POINT. The user writes ELIGIBILITY — which work items
// are candidates at all — and Ralph writes the two clauses that are about the LOOP rather
// than about the board:
//
//   the EXCLUSION, so the loop never picks up work that is already in flight, has already
//   failed, or has been marked hands-off. `labels IS EMPTY` is half of it and not a
//   flourish: in JQL a `NOT IN` comparison does not match an item whose field is unset, so
//   `labels NOT IN (...)` ALONE would hide every unlabelled ticket — which is most freshly
//   filed ones, i.e. exactly the queue.
//
//   the ORDERING, so a queue drains instead of churning. github mode spells this
//   `sort:created-asc`; this is the same rule for the same reason.
//
// THE USER'S CLAUSE IS PARENTHESIZED, and that is a correctness fix rather than tidiness.
// JQL binds AND tighter than OR, so appending `AND <exclusion>` to `a OR b` would mean
// `a OR (b AND <exclusion>)` — every item matching `a` stays eligible however it is
// labelled, which is the in-progress work the exclusion exists to skip.
//
// THE WRAP IS NOT VALIDATION, THOUGH, and nothing here checks parenthesis balance — a known
// escape rather than a guarantee. A clause that closes Ralph's opening paren and reopens its
// own — `project = R) OR (1=1` — composes to `(project = R) OR (1=1) AND (<exclusion>) ...`,
// which is BALANCED and valid, so Jira runs it happily with the exclusion demoted to the
// right-hand branch of the OR and every `project = R` item eligible however it is labelled.
// That is the drain guarantee gone, from a config value, with nothing erroring. Its saving
// grace is that it takes a clause deliberately built to re-balance against the injected `)`:
// an ordinary unbalanced typo composes to unbalanced JQL, which Jira rejects, which costs a
// count and never a wrong one. Real, unlikely, and wide when it happens. Pinned as a
// limitation in jira-jql.qa.test.js — "does NOT contain a clause that closes Ralph's
// parenthesis for it (pinned limitation)" — and a fix (rejecting an unbalanced clause) is a
// follow-up rather than part of #126.
//
// ORDER BY IS RELOCATED, NOT REFUSED. Jira requires the ordering to be the LAST clause, so
// a query that ends with one cannot simply have text appended to it. The ordering is cut
// off, the exclusion is inserted into the where-clause, and the ordering is put back
// VERBATIM at the end — case, spacing and all, because it is the user's text and rewriting
// it would be a second grammar nobody asked for.
//
// AND THE CUT IS QUOTE-AWARE, which is the one place a naive `split(/order by/i)` is
// actively dangerous: `summary ~ "order by"` is a text search for a phrase, and cutting
// inside that literal produces a different query rather than a syntax error.
//
// AN EMPTY VALUE IS A REFUSAL, never a permissive default. Ralph's half on its own —
// `(labels NOT IN (...) OR labels IS EMPTY)` — selects EVERY work item on the Jira site,
// so an unset JIRA_JQL would silently report somebody else's board as this repo's queue.
// The caller is handed `ok: false` and decides what an unconfigured source is worth: `ralph
// cycle` treats it as no work, `ralph status` renders it as an unknown depth.

// The label a claim WRITES (#127) — named here, in the module that composes the query which
// EXCLUDES it, because the two are one mechanism seen from two ends: jira-queue.js stamps
// this label on the ticket it picked, and the exclusion below is what makes the next pick
// skip it. Spelled once so the two can never drift into a loop that claims `in-progress`
// and excludes something else, i.e. that hands the same ticket out forever.
export const JIRA_IN_PROGRESS_LABEL = 'in-progress'

// The label a COMPLETION writes (#129), named here for exactly the reason its sibling above
// is, and carrying more weight than that one does.
//
// A completion has three parts and only this one is guaranteed to land: the transition to a
// done status can be REFUSED by a project's workflow (a missing transition, a required field,
// a validator), and the comment is best-effort by design. Jira labels, by contrast, are
// freeform text that no workflow rule can veto — so THIS LABEL IS WHAT ACTUALLY TAKES A
// RESOLVED TICKET OUT OF THE QUEUE, on every board, whatever its workflow says. If it ever
// drifted from the exclusion below, a Ralph that had just resolved a ticket would be handed
// the same ticket again on its next pass, forever, having done the work each time.
export const JIRA_DONE_LABEL = 'done'

// The label the SWEEP writes (#130) — the third and last of Ralph's own labels, and the one
// that makes jira mode's forward-progress guarantee a guarantee.
//
// An agent invocation can end having recorded nothing: killed with the tmux session, out of
// credit, crashed, or simply finished without doing anything. The ticket is then still
// `in-progress` and still open work, and the next pass would pick it again — the loop spinning
// on one ticket at a paid invocation per pass, which is the failure this label exists to
// prevent. templates/ralph.sh stamps it on anything the board does not report as done, and it
// can promise that BECAUSE it is a label: freeform text no workflow can veto, needing no
// transition and no permission beyond editing the ticket.
//
// The word was already in the exclusion below when #126 wrote the clause, spelled as a literal
// for a sweep that did not exist yet. It is a constant now for the same reason as the two
// above: one spelling, so the write and the exclusion cannot drift.
export const JIRA_FAILED_LABEL = 'failed'

// Ralph's half, in one named place: the clause IS the interface, and an interface spelled
// inline at its call site is an interface nobody finds (the same argument
// ACLI_JIRA_AUTH_STATUS_ARGV makes in jira-auth.js).
//
// ALL THREE LABELS RALPH WRITES ARE COMPOSED IN FROM THE CONSTANTS ABOVE rather than retyped
// here: the two ends of each mechanism (the write, and the exclusion that makes the write
// matter) cannot drift if there is only one spelling of each. `do-not-ralph` is the exception
// and belongs here as a literal — it is the only one of the four Ralph never writes, since a
// HUMAN puts it on a ticket to keep the loop off it.
export const JIRA_LABEL_EXCLUSION =
  `AND (labels NOT IN (${JIRA_IN_PROGRESS_LABEL}, ${JIRA_DONE_LABEL}, ${JIRA_FAILED_LABEL}, do-not-ralph) OR labels IS EMPTY)`

// Oldest first — the analog of github mode's `sort:created-asc`.
export const JIRA_DEFAULT_ORDER_BY = 'ORDER BY created ASC'

const MISCONFIGURED =
  'JIRA_JQL is empty — set the Jira eligibility query in ralph.config.sh'

// `/[A-Za-z0-9_]/.test(undefined)` is TRUE (the argument is coerced to the string
// "undefined"), which would make position 0 look like it followed a word character. Hence
// the explicit type check rather than a bare regex test.
const isWordChar = (ch) => typeof ch === 'string' && /[A-Za-z0-9_]/.test(ch)

// Where the ordering clause starts, or -1. Walks the string once, tracking quote state, and
// returns the LAST match found outside a string literal: a query with two of them is not
// legal JQL to begin with, and keeping the last one at least leaves the composed query
// syntactically whole instead of stranding an ORDER BY in the middle of it.
function lastUnquotedOrderBy(jql) {
  // STICKY, so it can ask "does an ORDER BY start HERE" without scanning ahead into a quoted
  // region the walk has already ruled out — and declared INSIDE the walk, where its
  // `lastIndex` cannot outlive the call. A module-level sticky regex would be shared mutable
  // state whose only protection is every future edit remembering to set `lastIndex` first; one
  // allocation per call buys that hazard away.
  const orderByAt = /order\s+by\b/iy
  let quote = null
  let found = -1
  for (let i = 0; i < jql.length; i += 1) {
    const ch = jql[i]
    if (quote !== null) {
      // A backslash escapes the next character, so `"say \" order by"` stays one literal.
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if ((ch === 'o' || ch === 'O') && !isWordChar(jql[i - 1])) {
      orderByAt.lastIndex = i
      if (orderByAt.test(jql)) found = i
    }
  }
  return found
}

const refusal = () => ({ ok: false, jql: null, reason: MISCONFIGURED })

/**
 * Compose the query Ralph runs from the eligibility clause the user configured.
 *
 * @param {string} userJql the raw JIRA_JQL value — eligibility only
 * @returns {{ ok: true, jql: string, reason: null } | { ok: false, jql: null, reason: string }}
 */
export function composeJiraJql(userJql) {
  // Never coerced: a config value that is not a string is a caller bug or a hostile
  // object, and `String(value)` on the second one throws inside a getter.
  if (typeof userJql !== 'string') return refusal()
  const trimmed = userJql.trim()
  if (trimmed === '') return refusal()

  const cut = lastUnquotedOrderBy(trimmed)
  const where = (cut === -1 ? trimmed : trimmed.slice(0, cut)).trim()
  const ordering = cut === -1 ? JIRA_DEFAULT_ORDER_BY : trimmed.slice(cut).trim()

  // An ordering with no eligibility clause is the dangerous case wearing a configured
  // one's clothes: the where-clause would be Ralph's half alone.
  if (where === '') return refusal()

  return { ok: true, jql: `(${where}) ${JIRA_LABEL_EXCLUSION} ${ordering}`, reason: null }
}
