// Jira-mode task queue (#126, #127, #129, #130). When TASK_SOURCE=jira, the queue depth comes
// from a Jira project instead of `gh issue list`: this module composes the configured JIRA_JQL
// (see jira-jql.js) and asks Atlassian's `acli` — through jira-acli.js — to count what matches,
// select the next ticket, claim it, record it as done when the work has been committed, and
// sweep it to `failed` when the invocation ended without recording anything.
// Structural mirror of folder-queue.js — a library API for the JS commands plus a node CLI
// the bash loop and the orchestrator prompt can shell out to — so neither bash nor the prompt
// holds Jira knowledge of its own.
//
// THE SPLIT #127's REVIEW ASKED FOR HAS HAPPENED (#129). The note that stood here said the
// acli LAYER — the argv builders, `acliText`, `firstWorkItem` and `findLabelArray` — should
// become `lib/jira-acli.js` "when the next slice adds acli writes; not worth it for four
// invocations". This is that slice: completion adds a transition, a label removal and a
// comment, so there were seven invocations and four of them were writes (#132's title lookup
// makes eight, and it is a read). They live in
// jira-acli.js now, which is pure and edgeless, and THIS FILE IS THE VERBS AND THEIR POLICY —
// what a failure MEANS for a queue, which failures a caller must hear about, and which of
// them are allowed to cost nothing.
//
// Library API (injectable exec for hermetic tests):
//   queueCountResult(jql, {exec}) — one probe, reported honestly: {ok, count, reason}
//   queueCount(jql, {exec})       — the same probe read as a number; 0 on anything that is
//                                   not a provable count
//   queuePick(jql, {exec})        — the top ticket of that same query: {key, summary}|null
//   claimTask(key, {exec})        — label it in-progress, read-then-union: {ok, labels, reason}
//   completeTask(key, {doneStatus, exec, stderr})
//                                 — transition it, label it done, take in-progress off:
//                                   {ok, labels, reason}. Only the LABEL can fail it.
//   commentTask(key, body, {exec})
//                                 — post a comment: {ok, reason}. Best-effort by contract.
//   locateTask(key, {exec})       — which bookkeeping state the BOARD reports for a ticket:
//                                   'done'|'failed'|'working'|'open', or 'unknown' when it
//                                   could not be read. A string, never a throw.
//   failTask(key, {exec, stderr}) — label it failed and take in-progress off:
//                                   {ok, labels, reason}. Only the LABEL can fail it.
//   titlesFor(keys, {exec})       — what these tickets are CALLED: a key → summary map, in ONE
//                                   acli call however many keys. `{}` on every failure.
//
// CLI (for templates/ralph.sh and templates/prompt-team-jira.md — except `titles`, which no
// file in this repo invokes; see its own note below):
//   node jira-queue.js count "<jql>"        → prints the count
//   node jira-queue.js pick "<jql>"         → prints `<key>\t<summary>`, or nothing when empty
//   node jira-queue.js claim "<KEY>"        → claims it; exit 1 (and a sentence on stderr) if not
//   node jira-queue.js complete "<KEY>"     → records it done (JIRA_DONE_STATUS from the env);
//                                             exit 1 only if the `done` LABEL could not be set
//   node jira-queue.js comment "<KEY>" "<body>"
//                                           → posts a comment; ALWAYS exits 0
//   node jira-queue.js locate "<KEY>"       → prints the state word; ALWAYS exits 0
//   node jira-queue.js fail "<KEY>"         → sweeps it to failed; exit 1 (and a sentence on
//                                             stderr) if the `failed` LABEL could not be set
//   node jira-queue.js titles "<KEY> ..."   → prints one `<key>\t<summary>` line per key it
//                                             could resolve, in the order asked, and nothing at
//                                             all for one it could not; ALWAYS exits 0
//
// THE CLAIM IS THE FIRST THING RALPH WRITES TO SOMEBODY'S BOARD (#127), and every label write
// in this file is READ-THEN-UNION rather than a bare append. `acli jira workitem edit
// --labels` is documented as "Edit the labels" and NOTHING IN THIS REPO CAN VERIFY WHETHER IT
// APPENDS OR REPLACES: no test here may spawn the real Atlassian CLI (there is none in CI, and
// a claim is a write to a live board). Under replace semantics a bare `--labels in-progress`
// would silently delete every label a team had put on the ticket — a destructive, invisible
// loss that would look like a successful claim. Reading the labels first and writing back the
// UNION is correct under EITHER semantics, which is the only way to be right without knowing
// which one it is. The cost is one extra process per write; the alternative is unbounded.
//
// AND IT IS ALSO WHY A WRITE THAT COULD NOT READ WRITES NOTHING AT ALL. An unreadable label
// list is a write that has to be abandoned, not one to be made optimistically: writing
// `in-progress` alone on a ticket whose labels came back as prose would be exactly the wipe
// the read exists to prevent. The loop treats that refusal as a warning and moves on.
//
// UNREADABLE INCLUDES A LIST THAT WAS FOUND AND SURVIVED AS NOTHING — QA's finding (#127),
// and the case where this file was wrong rather than merely cautious: `labels:
// [{"name":"frontend"},{"name":"p2"}]` IS an array, so the "no label list" refusal did not
// fire, every entry was then dropped as unsendable, and the write went out as `--labels
// in-progress` alone. That is the wipe arriving THROUGH the read. So the emptied case now
// refuses with the unknown-labels wording, and `labels: []` — a common, correct answer —
// still claims. EMPTY AND EMPTIED ARE THE TWO CASES THIS FUNCTION MUST NOT CONFUSE.
//
// COMPLETION IS THREE WRITES WITH THREE DIFFERENT PROMISES (#129), and getting those promises
// wrong in either direction is worse than not writing at all. With no PR and no pushed branch,
// the ticket is the only audit trail of what Ralph changed:
//
//   THE TRANSITION IS BEST-EFFORT. A Jira workflow decides which moves exist from a given
//   status and what they require, and Ralph cannot know any project's workflow. A refusal is
//   therefore a BOARD MOVE RALPH DID NOT GET — never a failed task, and never a reason to
//   leave a resolved ticket in the queue. It warns, naming the ticket and the status, and
//   carries on.
//
//   THE LABEL IS THE PROMISE, and the only reportable failure. Labels are freeform text that
//   no workflow rule can veto, so `done` is what actually drains the queue (jira-jql.js
//   composes it into the exclusion). A completion that could not write it is the one outcome
//   that would hand the same resolved ticket out again on the next pass, so that — and
//   nothing else — is what `ok: false` means here.
//
//   THE COMMENT NEVER COUNTS. `commentTask` is `|| true` by contract, in the same sense as the
//   telemetry sidecar in templates/ralph.sh: it is a separate call precisely so that its
//   failure has nothing to change, and the CLI verb exits 0 whatever happens.
//
// THE FAILURE HALF IS BASH'S, NOT THE AGENT'S (#130), and that asymmetry is the point of the
// last two verbs. Completion is the agent's job because only the agent knows whether the work
// landed and what SHA it landed as. But an agent that was KILLED — out of credit, out of
// context, out of tmux — records nothing at all, and the ticket it was working is then still
// labelled `in-progress` and still the oldest eligible ticket in the queue. So the sweep has to
// belong to the process that outlives the agent, which is templates/ralph.sh, and it needs
// exactly two things from this module: a way to ask the board what happened, and a write that
// cannot be refused.
//
//   `locateTask` IS THE VERDICT, and it reads the BOARD rather than the agent's exit code
//   (which the loop does not inspect: an agent killed after committing did the work, and one
//   that exited 0 having done nothing did not). It answers for every ticket, including one
//   nobody can read — `unknown`, which bash compares against `done`, finds different, and
//   sweeps. It is the one function here that returns a bare string rather than a result object,
//   because its consumer is `[ "$outcome" != "done" ]` in a shell script, and it mirrors
//   folder-queue.js's `locateTask` (which answers with a directory name) for the same reason.
//
//   `failTask` IS THE GUARANTEE, and it is a guarantee because it is a LABEL. Folder mode can
//   promise forward progress because bash can always `mv` a file; jira mode can promise it
//   because Jira labels are freeform text no workflow rule can veto — no transition to find, no
//   required field to fill in, no status to guess. It works from every state a dead invocation
//   can leave behind (claimed, never claimed, already swept) and is idempotent, because bash
//   sweeps unconditionally and a re-run must cost nothing.
//
// `exec` HAS NO DEFAULT, exactly as in jira-auth.js, and it is worth being precise about what
// that buys and what it does not.
//
//   WHAT IT BUYS: a defaulted parameter needs a module-scope `import { execa }`, which would
//   put execa on the import graph of EVERY importer of this file — including a command that
//   only wanted the pure count. Without the default, the spawner arrives as an argument from
//   whoever already has one: `lib/commands/status.js` and `lib/commands/cycle.js` each default
//   their own `exec = execa` from their own module-scope import (status.js:283, cycle.js:60),
//   and bin/ralph.js injects one explicitly for `doctorCommand` alone. So this module's
//   callers hold the spawner; this module never names it outside the CLI verb below, which
//   imports it lazily so it stays out of the loaded set at runtime.
//
//   WHAT IT DOES NOT BUY: reachability from `ralph doctor`. That guard
//   (doctor.version-line.qa.test.js) extracts DYNAMIC specifiers as well as static ones and
//   greps every file on the graph for the token `execa`, so this module would fail it either
//   way — the laziness is a runtime property, not a pass. THIS FILE THEREFORE MUST NOT APPEAR
//   ON DOCTOR'S GRAPH AT ALL. A diagnostic that wants Jira knowledge should import
//   ./jira-jql.js or ./jira-acli.js, both of which are pure and have no edges; anything
//   needing a live count belongs behind an injected seam the diagnostic is handed, not behind
//   an import.
//
// TWO CALLERS, ONE PROBE, TWO LEGITIMATE DEGRADATIONS — which is why there are two count
// functions rather than one, and why the second is a thin wrapper over the first:
//
//   `ralph cycle` is a SCHEDULER, and a count it cannot take means "no work I can prove",
//   which costs a tick and never a wrong one. Throwing instead would abort a scheduled run
//   over a diagnostic problem, and guessing would send the loop at a ticket it cannot even
//   see. That reading is `queueCount`, whose every failure is 0 and none of them throws.
//
//   `ralph status` is a READ-ONLY VIEW, and its job is to SAY when it does not know: a Jira
//   board nobody could reach must render `unknown`, never `0 waiting`, because `0 waiting`
//   is a claim about the board and reads as "almost done". That reading needs a signal 0
//   cannot carry — by contract 0 is also a real, empty queue — so it consumes
//   `queueCountResult`, whose `ok:false` is the "nobody took a count" that `finiteOrNull`
//   in status.js turns into null.
//
// The failures are identical for both; only the sentence each caller reads out of them
// differs. Keeping the probe single means a new failure mode is handled once, and neither
// posture can drift into being the other one's bug.

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { composeJiraJql, JIRA_DONE_LABEL, JIRA_FAILED_LABEL, JIRA_IN_PROGRESS_LABEL } from './jira-jql.js'
import { normalizeJiraKey, usableJiraKey } from './jira-key.js'
// ONE LINE ON PURPOSE, however long it is: the import pin in jira-queue.qa.test.js reads the
// specifier off every line that starts with `import `, so a wrapped statement makes its first
// line an `import ` with no `from` on it and the pin throws rather than failing. Add a name
// here; do not reflow the line. THE SAME HOLDS FOR THE jira-jql.js IMPORT ABOVE, which took a
// third label constant in #130 and stays on one line for this reason and no other.
import { acliCommentArgv, acliCountArgv, acliEditLabelsArgv, acliPickArgv, acliRemoveLabelsArgv, acliText, acliTitlesArgv, acliTransitionArgv, acliViewLabelsArgv, allWorkItems, findLabelArray, firstWorkItem, parseCount, parseJsonOrUndefined, summaryOf, writableLabels } from './jira-acli.js'

const noCount = (reason) => ({ ok: false, count: null, reason })

/**
 * The next Jira work item the loop should pick up, per the configured eligibility query.
 *
 * NULL IS THE ONLY FAILURE, unlike the count below, and that asymmetry is deliberate: a
 * count has two readings a caller has to tell apart ("zero waiting" vs "nobody could look"),
 * whereas a pick has one — there is no ticket to work on right now — and every reason for it
 * is the same instruction to the loop: stop. `queueCount` already ran, and it is the surface
 * that reports Jira being unreachable.
 *
 * @param {string} jql the raw JIRA_JQL value from ralph.config.sh
 * @param {{ exec?: Function }} [deps] injected process spawner (no default — see above)
 * @returns {Promise<{key: string, summary: string}|null>}
 */
export async function queuePick(jql, { exec } = {}) {
  const composed = composeJiraJql(jql)
  // A misconfigured JIRA_JQL SPAWNS NOTHING, for the reason queueCountResult gives: Ralph's
  // half of the query alone selects every work item on the Jira site, so there is no query
  // to fall back to — and here the consequence would be worse than a wrong number, because
  // the loop would go and CLAIM a stranger's ticket.
  if (!composed.ok) return null

  const read = await acliText(exec, acliPickArgv(composed.jql))
  if (!read.ok) return null

  const item = firstWorkItem(parseJsonOrUndefined(read.text))
  // The KEY is what makes a result a ticket: without one there is nothing to claim, nothing
  // to name in the record and nothing to tell a reader. `usableJiraKey` also rejects a
  // non-string and a blank one, so a malformed result is an empty queue rather than a crash.
  const key = usableJiraKey(item?.key)
  if (key === null) return null
  return { key, summary: summaryOf(item) }
}

// --- the summaries a read-only view names its rows with (#132) -----------------------------

// HOW MANY KEYS ONE QUERY MAY ASK ABOUT. The only caller wants at most nine (progress.js draws
// MAX_TABLE_ROWS closed rows plus the one in flight), so this is not a limit anybody reaches —
// it is the bound that keeps a public function safe when it is handed an untrusted list. The
// keys come out of `.ralph/metrics/issues.jsonl` and `.ralph/run-state.json`, files this repo
// only reads, and a ten-thousand-line metrics file must not become ten thousand keys of JQL
// handed to a process.
//
// A COUNT, AND ONLY A COUNT. This bounds how many keys are accepted; it says nothing about how
// long the resulting `--jql` string is, because a single key inside the grammar may be hundreds
// of characters (`[A-Za-z][A-Za-z0-9_]*` has no length limit) and 32 of those are a long query.
// That is deliberate: the argv goes to a spawned process, not into a URL or a shell line, so its
// length is Atlassian's problem to answer with an error — which arrives here as `!read.ok` and
// leaves as `{}`, the same as every other failure. Do not read this constant as a size limit.
//
// DELIBERATELY NOT AN IMPORT OF `MAX_TABLE_ROWS`. This module's import set is pinned (see the
// one-line note below), and joining it to progress.js — a module that formats a terminal — to
// borrow the number 8 would trade a real edge for a cosmetic agreement. The two are independent
// bounds on independent concerns: the caller decides how many rows it is about to draw, this
// decides how many keys it is willing to name in one query. Generous enough that the first will
// always fit inside the second, which is the only relationship they need.
const MAX_TITLE_KEYS = 32

// THE ONE JQL QUERY IN RALPH THAT `composeJiraJql` DOES NOT BUILD, and that is a statement about
// what it asks rather than a shortcut. Every other query in jira mode asks what is ELIGIBLE, so
// the composer wraps the operator's JIRA_JQL in Ralph's own bookkeeping — an exclusion of
// `in-progress`, `done` and `failed`, and an ordering. This one asks what a NAMED ticket is
// called, about tickets that are mostly finished: the table's closed rows all carry `done`, so
// the exclusion would filter out every row it was asked about, and an ordering is meaningless
// when the answer is looked up by key. It is also the reason this stayed here rather than moving
// into jira-jql.js: it needs the key grammar, and that module is pinned as importing nothing.
//
// SAFE ONLY BECAUSE OF THE GATE IN FRONT OF IT. `keys` here are already through
// `normalizeJiraKey`, so every one of them is `[A-Za-z][A-Za-z0-9_]*-\d+` and contains no quote,
// paren, comma or space to close the clause with. Nothing else may be passed to this function.
//
// UNQUOTED, AND THERE IS ONE COST TO THAT WORTH KNOWING. Injection is not it — the grammar has
// already made that impossible — but the grammar happily accepts a project key that is a JQL
// reserved word (`AND-1`, `OR-1`, `NOT-1`, `EMPTY-1`), and Jira may answer a query naming one
// with a parse error rather than a result. The blast radius is the whole call, so a table of
// nine rows would lose ALL nine titles rather than that one: `!read.ok`, then `{}`, then a table
// of bare keys — the same view a pre-#132 jira run rendered, degraded and never wrong. Left
// unquoted rather than fixed blind, because which words a given Jira rejects here is a fact
// about Atlassian's parser that this repo cannot measure (no acli in CI, and every spelling in
// jira-acli.js is transcribed rather than observed), and `key IN ("AND-1")` would be a guess at
// what it prefers. Quoting is the fix if a real project ever hits it; it stays injection-safe
// either way, because the gate is what makes it safe.
const keysJql = (keys) => `key IN (${keys.join(', ')})`

/**
 * What these Jira work items are CALLED — a map from the key the caller asked with to that
 * ticket's summary, resolved in ONE `acli` call however many keys are asked about.
 *
 * The jira analog of `readIssueTitles` in lib/commands/status.js, which asks GitHub and
 * therefore knows nothing about a board, and it copies that function's posture exactly: a
 * summary is A COURTESY AND NEVER A FACT. Every failure — a misconfigured site, a logged-out
 * session, no acli on PATH, an envelope Ralph cannot read — is the EMPTY MAP, and the surface
 * above then renders what a pre-#132 jira run rendered: the keys, with nothing beside them.
 * NOTHING HERE THROWS.
 *
 * ONE CALL FOR N KEYS is the whole reason this is a batch function and not a lookup. `ralph
 * status` is a view people leave on a timer beside the loop, and nine `acli` processes per
 * render — each a network round trip to Atlassian — is not a courtesy, it is a tax.
 *
 * THE KEYS ARE UNTRUSTED, and this is the one place in Ralph where a stranger's text would
 * become QUERY SYNTAX. So the gate is the STRICT grammar (`normalizeJiraKey`) and not the
 * permissive `usableJiraKey` every other verb here uses, which is a deliberate difference worth
 * reading twice: `usableJiraKey` passes ANY non-empty string through, because elsewhere the key
 * is the SUBJECT of the call — it arrives in its own argv slot, where `acli` either finds that
 * ticket or does not, and refusing a project key Ralph's regex has never seen would be Ralph
 * overruling the board. Here the key is spelled INSIDE a JQL string, where `FOO-1") OR key IN
 * ("BAR-2` is not a ticket that will not be found but a DIFFERENT QUESTION. What the strictness
 * costs is a row on an exotically-named project showing its key and no summary; what it buys is
 * that a hostile `.ralph/` file cannot rewrite the query. If NOTHING survives the gate, this
 * SPAWNS NOTHING at all.
 *
 * THE MAP IS KEYED BY THE CALLER'S SPELLING, not by Jira's. `normalizeJiraKey` uppercases a
 * project key, so a record holding `foo-1` would otherwise get back a map full of `FOO-1` and
 * match nothing — the caller looks a row up by the very text that NAMES the row. So the query is
 * built from the normalized keys, acli's answers are matched by normalizing what it says, and
 * the map that comes back out is spelled the way the question was asked.
 *
 * ONE ENTRY PER SPELLING ASKED, not per ticket. A metrics file written across a rename, or by two
 * agents that disagreed about case, can name one ticket as both `foo-1` and `FOO-1`, and each of
 * those is a SEPARATE ROW in the table above — the row is looked up by its own recorded text, so
 * a map holding only the first spelling leaves the second row blank beside a summary it already
 * has. The query still names that ticket ONCE and `--limit` still counts TICKETS, because the
 * duplication is in the question, not on the board.
 *
 * @param {unknown} keys the work item keys to resolve, as the caller spells them
 * @param {{ exec?: Function }} [deps] injected process spawner (no default — see the header)
 * @returns {Promise<Record<string, string>>} key → summary; `{}` for every failure
 */
export async function titlesFor(keys, { exec } = {}) {
  // normalized key → EVERY spelling the caller asked that ticket about, in the order asked. A Map
  // rather than an object because the normalized key is arbitrary text and `Object.hasOwn`
  // bookkeeping around a prototype is noise here; insertion order is also the order the query
  // names the tickets in, which makes the argv a test can pin deterministic. Two keys that
  // normalize together (`foo-1` and `FOO-1`) are ONE ticket and TWO answers: one query term, two
  // entries in the returned map.
  const wanted = new Map()
  // The spellings already accepted, so a list that repeats itself costs nothing and cannot spend
  // the bound below twice on the same text.
  const asked = new Set()
  // Not `Array.isArray` on the argument alone: a caller that forgot the list, or passed a
  // string, must spawn nothing rather than iterate characters.
  if (Array.isArray(keys)) {
    for (const key of keys) {
      // The bound is applied while building, so an absurd list costs one loop and never a giant
      // string. It counts SPELLINGS, which is the input the caller controls; the number of
      // tickets named in the query is at most that and usually the same.
      if (asked.size >= MAX_TITLE_KEYS) break
      const strict = normalizeJiraKey(key)
      if (strict === null || asked.has(key)) continue
      asked.add(key)
      const spellings = wanted.get(strict)
      if (spellings === undefined) wanted.set(strict, [key])
      else spellings.push(key)
    }
  }
  if (wanted.size === 0) return {}

  // `--limit` IS THE TICKET COUNT, not a constant and not the number of spellings asked: acli's
  // default page size is not something this repo can measure, and being handed a default five for
  // a nine-ticket question would leave four rows untitled with nothing saying so. `wanted.size`
  // is exactly the number of terms `keysJql` is about to name, so the two can never disagree.
  const read = await acliText(exec, acliTitlesArgv(keysJql([...wanted.keys()]), wanted.size))
  if (!read.ok) return {}

  const titles = {}
  // The tickets already answered for, so the FIRST answer wins per TICKET rather than per
  // spelling — see below.
  const resolved = new Set()
  for (const item of allWorkItems(parseJsonOrUndefined(read.text))) {
    // FILTERED ON THE WAY IN, both halves. A non-string key is not a ticket, and a summary that
    // is an object would reach the renderer as `[object Object]` while a missing one would
    // arrive as the word "undefined" — `summaryOf` answers '' for both, which is the same
    // finding as "this entry has no title" and is dropped here rather than published as one.
    const answered = normalizeJiraKey(item?.key)
    if (answered === null) continue
    const spellings = wanted.get(answered)
    // A key nobody asked about is ignored rather than added: the map is an answer to the
    // question, and a board that volunteered extra tickets must not put rows in it.
    if (spellings === undefined || resolved.has(answered)) continue
    const summary = summaryOf(item)
    if (summary === '') continue
    // FIRST WINS on a repeated key, matching `readIssueTitles` in status.js and for the same
    // reason: a later entry overwriting an earlier one makes the map depend on paging. Recorded
    // against the normalized key, not against a spelling, so a board that names the ticket twice
    // is one answer no matter how many ways the caller spelled the question.
    resolved.add(answered)
    // Every spelling of this ticket gets the summary. Assigning into a bare object is safe
    // because these strings are through the STRICT grammar, which starts at `[A-Za-z]` and so
    // cannot spell `__proto__` — the prototype-poisoning pin above holds on the gate, not here.
    for (const spelling of spellings) titles[spelling] = summary
  }
  return titles
}

// --- labels: the read, and the union write the three label verbs share --------------------

const noLabels = (reason) => ({ ok: false, labels: null, reason })

// The label list this ticket carries today, in the only form Ralph may write back — or a
// refusal naming why the current labels are UNKNOWN. FOUR CALLERS, measured: `addLabel`
// below, which is the whole of `claimTask`, `completeTask`'s `done` write and #130's
// `failTask` sweep; and `locateTask`, which calls it DIRECTLY. Shared rather than copied on
// purpose: the three refusals below ARE the safety property of every label write in this
// file, and a second copy of them is a second thing to keep right.
//
// THE FOURTH CALLER ONLY READS, and that is a different claim from the other three rather
// than a bigger version of it. `locateTask` writes nothing, so for it these refusals are not
// a safety property at all — they are the answer "the board could not be read", which it
// reports as `unknown` and never as a state. The sentences below are phrased for a write
// (they end "so nothing was written", "were left alone") and only the WRITERS put them in
// front of an operator; the reader consumes the `ok` flag and drops the prose.
async function readWritableLabels(exec, target) {
  const read = await acliText(exec, acliViewLabelsArgv(target))
  if (!read.ok) {
    return noLabels(`could not read ${target}'s labels, so nothing was written: ${read.reason}`)
  }

  const current = findLabelArray(parseJsonOrUndefined(read.text))
  if (current === null) {
    return noLabels(
      `acli printed no label list for ${target}, so its labels are unknown and were left alone`,
    )
  }

  const labels = writableLabels(current)
  // A LIST THAT WAS FOUND AND EMPTIED IS AN UNREADABLE LIST, NOT AN EMPTY ONE — QA's finding,
  // and the distinction the safety property turns on. `labels: []` is a ticket with no labels
  // and writes normally; a NON-EMPTY list out of which nothing could be sent is acli spelling
  // labels in a shape this reader does not know, with the real label text somewhere inside the
  // entries it just discarded (`[{"name":"frontend"}]` is the shape a REST payload uses).
  // Writing then would send the new label alone, which under replace semantics is the wipe the
  // read exists to prevent — reached through a read that SUCCEEDED, which is why the check has
  // to be here and not in the null branch above.
  //
  // A PARTIAL drop does not refuse, deliberately: `["frontend", null, 42]` still writes
  // `frontend,<new>`, because a list with at least one readable label was read correctly and
  // the entries dropped from it cannot be labels Jira held (its label field holds non-empty
  // text, so a number, an object or `"   "` is not a label being deleted). The all-dropped
  // case is different in kind — it is evidence about the ENVELOPE, not about the entries — and
  // evidence that Ralph is misreading acli is not a licence to write.
  if (current.length > 0 && labels.length === 0) {
    return noLabels(
      `acli spelled ${target}'s labels in a shape Ralph cannot send back, so its labels are unknown and were left alone`,
    )
  }

  return { ok: true, labels, reason: null }
}

// Add one label to a ticket, READ then UNION then WRITE — never a bare write; see the header
// for why that is not caution but correctness. IDEMPOTENT: a ticket that already carries the
// label is reported as done and touched no further, so a re-run of a half-finished iteration
// is free. `labels` on success is the ticket's full label set AFTER the write, which is what
// makes the returned value auditable against the argv that was sent.
async function addLabel(exec, target, label) {
  const read = await readWritableLabels(exec, target)
  if (!read.ok) return read

  // Already there. The cheapest idempotence is the one that does not touch a board it has
  // nothing to change on — and it keeps a re-selected ticket from looking like a fresh claim.
  if (read.labels.includes(label)) return { ok: true, labels: read.labels, reason: null }

  const union = [...read.labels, label]
  const write = await acliText(exec, acliEditLabelsArgv(target, union.join(',')))
  if (!write.ok) return noLabels(`could not label ${target} ${label}: ${write.reason}`)
  return { ok: true, labels: union, reason: null }
}

// The warnings ARE the user interface of everything the two terminal writes forgive, so they
// must survive a stream that is closed, wrapped or absent — a completion that threw while
// reporting a board it could not move would turn a lost transition into a lost run, and a sweep
// that threw would turn a drained queue into an aborted one. Shared by `completeTask` and
// `failTask` (#130) rather than written twice: it is one promise about one stream.
const warner = (stderr) => (sentence) => {
  try {
    stderr?.write?.(`jira-queue.js: ${sentence}\n`)
  } catch {
    /* a stream that cannot be written to is not a reason to fail a write that succeeded */
  }
}

// Take `in-progress` back off a ticket that has just been recorded terminal, and report the
// label set as it now stands. LAST STEP OF BOTH TERMINAL WRITES, so that a ticket is never
// un-owned and un-terminal at the same time, and shared between them (#130) because the
// mechanics and the forgiveness are identical: `--remove-labels` is unambiguous under either
// reading of `--labels` (see jira-acli.js), and a refusal is untidy rather than broken, because
// the exclusion in jira-jql.js matches on `terminal` as well — a ticket carrying both labels is
// already out of the queue. `labels` is the set after the terminal label went on; the return is
// the ticket as it actually stands, not as it was meant to.
async function clearInProgress(exec, target, labels, terminal, warn) {
  if (!labels.includes(JIRA_IN_PROGRESS_LABEL)) return labels
  const removed = await acliText(exec, acliRemoveLabelsArgv(target, JIRA_IN_PROGRESS_LABEL))
  if (!removed.ok) {
    warn(
      `could not remove ${JIRA_IN_PROGRESS_LABEL} from ${target} (${removed.reason}) — it is ` +
        `labelled ${terminal}, so it is out of Ralph's queue either way`,
    )
    return labels
  }
  return labels.filter((label) => label !== JIRA_IN_PROGRESS_LABEL)
}

/**
 * Claim a Jira work item for this run by labelling it `in-progress` — the label the composed
 * query EXCLUDES (see jira-jql.js), so a claimed ticket drops out of the next pick and the
 * queue drains instead of handing the same ticket out forever.
 *
 * @param {string} key the work item key, e.g. `FOO-123`
 * @param {{ exec?: Function }} [deps] injected process spawner (no default — see above)
 * @returns {Promise<{ok: boolean, labels: string[]|null, reason: string|null}>}
 */
export async function claimTask(key, { exec } = {}) {
  const target = usableJiraKey(key)
  // Nothing to claim SPAWNS NOTHING: an `acli edit` with an empty key is a request whose
  // subject is whatever acli decides it is, and this is a write.
  if (target === null) return noLabels('no Jira work item key to claim')
  return addLabel(exec, target, JIRA_IN_PROGRESS_LABEL)
}

/**
 * Record a Jira work item as finished: transition it to the configured done status, label it
 * `done`, and take `in-progress` back off.
 *
 * WHAT `ok` MEANS HERE IS NARROWER THAN IT LOOKS, and the header explains why at length:
 * `ok: false` is "the `done` label could not be written" — or, before any process runs, "that
 * is not a work item key" — i.e. "this resolved ticket is still in Ralph's queue and will be
 * handed out again". A workflow that refused the transition, and an `in-progress` that would
 * not come off, are both WARNINGS on `stderr` and a successful completion — a board Ralph
 * cannot drive is not a task Ralph failed.
 *
 * EVERY WARNING IS WRITTEN AFTER THE WRITE IT DESCRIBES, including the transition's, which is
 * held until the label's outcome is known: the only useful thing to say about a lost board
 * move is what happened to the label, and stderr is read top to bottom by an agent deciding
 * whether the ticket is complete.
 *
 * An unset or empty `doneStatus` SKIPS the transition rather than aborting: the label is what
 * drains the queue, so a repo that never configured JIRA_DONE_STATUS still gets its ticket
 * recorded, and pays one warning for the board move nobody asked for.
 *
 * @param {string} key the work item key, e.g. `FOO-123`
 * @param {{ doneStatus?: string, exec?: Function, stderr?: {write: Function} }} [deps]
 * @returns {Promise<{ok: boolean, labels: string[]|null, reason: string|null}>}
 */
export async function completeTask(key, { doneStatus, exec, stderr = process.stderr } = {}) {
  const target = usableJiraKey(key)
  // Nothing to complete SPAWNS NOTHING, for claimTask's reason: three writes whose subject is
  // whatever acli decides it is would be three writes to the wrong ticket.
  if (target === null) return noLabels('no Jira work item key to complete')

  const warn = warner(stderr)

  // 1. THE TRANSITION, FIRST AND BEST-EFFORT. First because a board whose workflow still
  // accepts the move should get it before Ralph starts labelling, so a human watching the
  // ticket sees it move and then settle rather than the other way round.
  //
  // THE ORDER IS NOT FREE, and the cost falls on the case where the label then fails: the
  // board reads "Done" for a ticket that still matches the eligibility query, so the next
  // iteration can hand out a ticket a human has already seen resolved. Label-first pays the
  // symmetric price — a ticket labelled out of the queue while the board still shows it in
  // flight — but never that one. Transition-first is kept because the label is the write this
  // function actually promises: it is the one whose failure is REPORTED, so it is the one that
  // should run last and closest to the verdict, and a lost board move is loud on stderr
  // whereas a queue that quietly re-serves a finished ticket is not. If completion is ever
  // seen re-serving resolved tickets in the field, this is the trade-off to revisit.
  const status = typeof doneStatus === 'string' ? doneStatus.trim() : ''
  // THE SENTENCE IS HELD, NOT PRINTED — review round 1 of #129, and the reason is that every
  // honest thing to say about a lost board move is a claim about the LABEL ("it is labelled
  // done and out of Ralph's queue anyway"), which is not known yet. Warning here would put
  // that claim on stderr ABOVE the line saying the label could not be written, and step 7 of
  // prompt-team-jira.md tells the agent to read exactly this output before deciding whether
  // the ticket is complete. So the transition's outcome is recorded as a phrase and finished
  // once `addLabel` has answered.
  let lostMove = null
  if (status === '') {
    lostMove = `JIRA_DONE_STATUS is not set, so ${target} was not moved on the board`
  } else {
    const moved = await acliText(exec, acliTransitionArgv(target, status))
    // A refused transition names BOTH the ticket and the status, because the fix is one or the
    // other: either JIRA_DONE_STATUS is not a status this project's workflow can reach from
    // here, or the move needs a field only a human can fill in.
    if (!moved.ok) {
      lostMove = `Jira refused to transition ${target} to "${status}" (${moved.reason})`
    }
  }

  // 2. THE LABEL, AND THE ONLY THING THAT CAN FAIL THIS FUNCTION. Read-then-union, through
  // the same machinery the claim uses.
  const done = await addLabel(exec, target, JIRA_DONE_LABEL)

  // The held sentence, now that its second half is knowable. Both endings are true when they
  // are written, which is the whole point of holding it.
  if (lostMove !== null) {
    warn(
      done.ok
        ? `${lostMove} — it is labelled ${JIRA_DONE_LABEL} and out of Ralph's queue, so moving ` +
            `it on the board is yours to do by hand`
        : `${lostMove}, and the ${JIRA_DONE_LABEL} label could not be written either, so it is ` +
            `still in Ralph's queue and this ticket is NOT complete`,
    )
  }

  // NOTHING IS REMOVED AFTER A FAILED ADD: a ticket that lost `in-progress` without gaining
  // `done` is a ticket back in the queue with no owner, which is strictly worse than a ticket
  // that reads as still in flight.
  if (!done.ok) return done

  // 3. `in-progress` COMES OFF LAST, so the ticket is never un-owned and un-done at once. Its
  // refusal is forgiven, and by the shared step rather than by a copy of it (#130).
  return {
    ok: true,
    labels: await clearInProgress(exec, target, done.labels, JIRA_DONE_LABEL, warn),
    reason: null,
  }
}

// The four words `locateTask` can answer with, and what each one means to the caller that
// matters — the outcome branch of templates/ralph.sh, which compares against `done` and sweeps
// everything else. Named rather than inline because they are a WIRE FORMAT: bash reads them out
// of stdout, so a rewording here is a rewording of an interface.
const LOCATE_DONE = 'done'
const LOCATE_FAILED = 'failed'
const LOCATE_WORKING = 'working'
const LOCATE_OPEN = 'open'
// Not a state of the ticket but a state of the READING: acli could not be run, or answered in a
// shape this module will not guess at. It is deliberately not `open` — treating an unreadable
// ticket as untouched work would put it back in the queue on nothing but a failed probe — and
// deliberately not an error either, because the loop's next move is the same as for any un-done
// ticket: sweep it. bash's own `${outcome:-unknown}` default spells this same word for a node
// that could not print one at all.
const LOCATE_UNKNOWN = 'unknown'

/**
 * Which bookkeeping state the BOARD reports for a Jira work item, read off the labels Ralph
 * writes: `done`, `failed`, `working` (i.e. claimed, `in-progress`), or `open` — a ticket
 * carrying none of them. `unknown` when the ticket could not be read.
 *
 * THE STRUCTURAL MIRROR OF folder-queue.js's `locateTask`, which answers with the directory a
 * task file sits in, and the same contract: it is the loop's ONLY input for deciding whether an
 * iteration achieved anything, so it must answer for every ticket and NEVER THROW. A throw here
 * would abort the run with the ticket still labelled `in-progress` and still excluded from the
 * query — the one state #130 exists to make impossible.
 *
 * A BARE STRING, not the {ok, ...} shape the writes in this file use, because the consumer is
 * `[ "$outcome" != "done" ]` in a shell script and a JSON envelope would only be something for
 * bash to parse. `unknown` carries the provenance that `ok:false` would have.
 *
 * THE TERMINAL LABELS WIN over the ownership one, and `done` wins over `failed`: a ticket can
 * legitimately carry two (a completion whose `in-progress` removal was refused reports SUCCESS
 * and leaves both on), and the question this answers is "is this still open work?".
 *
 * READS ONLY THE LABELS, not the ticket's status. Ralph's own bookkeeping is labels — it is the
 * write no workflow can veto, which is why the whole guarantee rests on it — and a project's
 * status vocabulary is unknowable from here: `JIRA_DONE_STATUS` is configuration precisely
 * because this code cannot know what "finished" is called on somebody's board.
 *
 * @param {string} key the work item key, e.g. `FOO-123`
 * @param {{ exec?: Function }} [deps] injected process spawner (no default — see above)
 * @returns {Promise<'done'|'failed'|'working'|'open'|'unknown'>}
 */
export async function locateTask(key, { exec } = {}) {
  const target = usableJiraKey(key)
  if (target === null) return LOCATE_UNKNOWN

  // THE SAME READER THE WRITES USE, so "unreadable" means one thing in this module rather than
  // two. Its refusal sentences are phrased for a write ("so nothing was written") and are
  // discarded here — this is a read, and the only thing the caller can do with a refusal is
  // sweep, which is what `unknown` gets it.
  const read = await readWritableLabels(exec, target)
  if (!read.ok) return LOCATE_UNKNOWN

  // EXACT MATCHES, and only on the labels Ralph itself writes: `writableLabels` has already
  // trimmed the list, so ` done ` counts, but `Done` does not and must not — Ralph's labels are
  // the ones it wrote, and a team's similarly-spelled label is a team's business.
  if (read.labels.includes(JIRA_DONE_LABEL)) return LOCATE_DONE
  if (read.labels.includes(JIRA_FAILED_LABEL)) return LOCATE_FAILED
  if (read.labels.includes(JIRA_IN_PROGRESS_LABEL)) return LOCATE_WORKING
  return LOCATE_OPEN
}

/**
 * Sweep a Jira work item out of Ralph's queue after an iteration that did not finish it: label
 * it `failed` and take `in-progress` back off.
 *
 * THIS IS THE FORWARD-PROGRESS GUARANTEE OF JIRA MODE (#130), and the mirror of folder mode's
 * `mv` into `afk/failed`. It is bash's call rather than the agent's for a reason no exit code
 * can fix: the invocation that most needs sweeping is the one that DIED, and a dead agent
 * records nothing. Without it, a ticket a killed invocation was working stays `in-progress`,
 * stays the oldest eligible ticket, and is handed to a new paid invocation on every pass.
 *
 * WORKS FROM EVERY STATE and is IDEMPOTENT, because the loop sweeps unconditionally: a ticket
 * that was claimed loses `in-progress`, a ticket whose claim never landed is simply labelled,
 * and a ticket already labelled `failed` costs nothing and reports success.
 *
 * `ok: false` MEANS EXACTLY ONE THING, as in `completeTask`: the `failed` LABEL could not be
 * written, so the ticket is still in the queue and the guarantee did not hold — which is when
 * the loop's zero-progress guard becomes the thing that stops the run. An `in-progress` that
 * would not come off is a warning and a success.
 *
 * NO TRANSITION AND NO COMMENT. A sweep is bash saying "Ralph stopped trying", and bash has
 * neither a status it could claim this board accepts nor anything to say about work that did
 * not happen. Whatever the agent did manage to write is left exactly as it stands.
 *
 * @param {string} key the work item key, e.g. `FOO-123`
 * @param {{ exec?: Function, stderr?: {write: Function} }} [deps]
 * @returns {Promise<{ok: boolean, labels: string[]|null, reason: string|null}>}
 */
export async function failTask(key, { exec, stderr = process.stderr } = {}) {
  const target = usableJiraKey(key)
  // Nothing to sweep SPAWNS NOTHING, for claimTask's reason: a write whose subject is whatever
  // acli decides it is would be a write to the wrong ticket.
  if (target === null) return noLabels('no Jira work item key to fail')

  // 1. THE LABEL, AND THE ONLY THING THAT CAN FAIL THIS FUNCTION. Read-then-union, through the
  // same machinery the claim and the completion use.
  const failed = await addLabel(exec, target, JIRA_FAILED_LABEL)
  // NOTHING IS REMOVED AFTER A FAILED ADD: a ticket that lost `in-progress` without gaining
  // `failed` is back in the queue with no owner and no record that Ralph ever tried it.
  if (!failed.ok) return failed

  // 2. `in-progress` COMES OFF LAST, so the ticket is never un-owned and un-swept at once.
  return {
    ok: true,
    labels: await clearInProgress(exec, target, failed.labels, JIRA_FAILED_LABEL, warner(stderr)),
    reason: null,
  }
}

/**
 * Post a comment on a Jira work item — in Jira mode the ONLY audit trail from the board back
 * to the work, because nothing pushes the commit and no PR is opened.
 *
 * BEST-EFFORT BY CONTRACT, and a separate function rather than a step inside `completeTask`
 * for exactly that reason: its failure has nothing to change, because the caller's verdict was
 * already computed from the label write. `{ok: false}` here is information for a log, never an
 * outcome — and like everything else in this module it never throws.
 *
 * @param {string} key the work item key, e.g. `FOO-123`
 * @param {string} body the comment text, sent as ONE argv element, unescaped and unquoted
 * @param {{ exec?: Function }} [deps] injected process spawner (no default — see above)
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function commentTask(key, body, { exec } = {}) {
  const target = usableJiraKey(key)
  if (target === null) return { ok: false, reason: 'no Jira work item key to comment on' }

  // AN EMPTY COMMENT IS WORSE THAN NO COMMENT, so it is refused before a process is started:
  // on the board it reads as Ralph having recorded something, and it is the one artifact that
  // outlives the invocation. A non-string body is the same finding — there is no text to post.
  const text = typeof body === 'string' ? body : ''
  if (text.trim() === '') return { ok: false, reason: `no comment body to post to ${target}` }

  // `text` and not `body`: they are the same string on every path that reaches here, and
  // sending the value the guard above actually inspected keeps it that way if the guard ever
  // gains a case (a trim, a cap) rather than leaving correctness to the order of two lines.
  const posted = await acliText(exec, acliCommentArgv(target, text))
  if (!posted.ok) return { ok: false, reason: `could not comment on ${target}: ${posted.reason}` }
  return { ok: true, reason: null }
}

/**
 * Ask acli how many Jira work items match the configured eligibility query, and report the
 * answer WITH ITS PROVENANCE: `ok:false` is "nobody took a count", which 0 cannot mean here
 * because 0 is also a real, empty queue. Never throws; every failure is a value.
 *
 * Same discriminated shape as its pure sibling `composeJiraJql` — {ok, <payload>, reason},
 * reason a sentence when there is nothing to report and null when there is.
 *
 * @param {string} jql the raw JIRA_JQL value from ralph.config.sh
 * @param {{ exec?: Function }} [deps] injected process spawner (no default — see above)
 * @returns {Promise<{ok: boolean, count: number|null, reason: string|null}>}
 */
export async function queueCountResult(jql, { exec } = {}) {
  const composed = composeJiraJql(jql)
  // A misconfigured JIRA_JQL SPAWNS NOTHING. Ralph's half of the query on its own selects
  // every work item on the Jira site, so there is no query to fall back to here. The
  // composer's own sentence is forwarded rather than restated — it is the one that names the
  // knob the reader has to go and fix.
  if (!composed.ok) return noCount(composed.reason)

  // Every way the process itself can fail to answer is handled by the shared seam in
  // jira-acli.js, so what is left here is the one thing specific to counting: whether the
  // text IS a count.
  const read = await acliText(exec, acliCountArgv(composed.jql))
  if (!read.ok) return noCount(read.reason)

  const count = parseCount(read.text)
  if (count === null) {
    return noCount('acli exited cleanly but printed no count Ralph could read')
  }
  return { ok: true, count, reason: null }
}

/**
 * How many Jira work items are waiting, per the configured eligibility query — the SCHEDULER's
 * reading of the probe above, in which anything unprovable is 0. Deliberately lossy, and a
 * wrapper rather than a second copy of the logic so the two readings cannot drift apart.
 *
 * @param {string} jql the raw JIRA_JQL value from ralph.config.sh
 * @param {{ exec?: Function }} [deps] injected process spawner (no default — see above)
 * @returns {Promise<number>} the count, or 0 when it cannot be proven
 */
export async function queueCount(jql, deps) {
  const result = await queueCountResult(jql, deps)
  return result.ok ? result.count : 0
}

// --- CLI entrypoint (for templates/ralph.sh and the orchestrator prompt) ------------------
// Async, unlike folder-queue.js's, for one reason: the spawner is resolved HERE rather than
// at module scope, so a command that only wants the library never loads execa.
const USAGE =
  'usage: jira-queue.js count|pick "<jql>" | jira-queue.js claim|complete|locate|fail "<KEY>"' +
  ' | jira-queue.js comment "<KEY>" "<body>" | jira-queue.js titles "<KEY> [KEY...]"\n'

// ONE ROW OF THE `titles` MAP, with the two bytes that DELIMIT that map taken out of the summary
// first (#132). A summary is text off somebody's board — the one value in this file that a
// stranger writes and Ralph prints — and the `titles` output is a two-dimensional format: TAB
// separates the key from the summary, NEWLINE separates the rows. Interpolated raw, a summary
// reading `bad<LF>FOO-999<TAB>anything` would arrive at a shell's `read` loop as TWO rows, the
// second one a ticket nobody asked about and a title nobody wrote. That is a forged record, not a
// cosmetic problem, so the delimiters are removed HERE, where the line is built.
//
// A NEWLINE TRUNCATES, A TAB IS REPLACED. They are not the same injury. Everything after the
// first CR or LF is a SECOND RECORD trying to exist and is dropped entirely — replacing the
// newline with a space would keep the forged key visible in the title, which is exactly the text
// the attacker wanted printed. A tab only mis-splits the row it is in, so it becomes a space and
// the whole summary survives as the second field, which is the field's contract.
//
// WHY `pick` DOES NOT DO THIS, and is right not to. `pick` prints exactly ONE line and its caller
// reads exactly one line and cuts it at the first tab (`${pick%%$'\t'*}`), so the key — the only
// value that caller uses — is already whatever precedes the first tab, and anything a summary
// smuggled in lands in a field the loop discards. There is no second record to forge when there
// is no second record. `titles` is the multi-line surface, so `titles` is where the scrub belongs;
// the pin on `pick`'s raw interpolation is deliberate and stays.
//
// String splitting rather than a regular expression, so the two bytes being removed are spelled
// as the escapes every reader knows instead of hidden inside a character class.
//
// THE EMPTY ANSWER IS NO LINE, not a line with a hole: a summary that was nothing but newlines
// scrubs down to blank, and the promise this verb's output makes is that a key it cannot title is
// simply absent.
function mapLine(key, summary) {
  const oneLine = summary.split('\n')[0].split('\r')[0].split('\t').join(' ')
  if (oneLine.trim() === '') return ''
  return `${key}\t${oneLine}\n`
}

async function runCli(argv) {
  // A verb, the thing it acts on, and — for `comment` alone — the text to post. Same shape
  // folder-queue.js's CLI has.
  const [cmd, arg, ...rest] = argv
  if (!cmd || !arg) {
    process.stderr.write(USAGE)
    return 2
  }
  // Resolved once for every verb (a claim runs two processes through it, a completion up to
  // four). Still inside the CLI and still dynamic, which is the property that matters: no
  // importer of this module's library API pulls execa in.
  const { execa } = await import('execa')
  switch (cmd) {
    case 'count': {
      process.stdout.write(String(await queueCount(arg, { exec: execa })) + '\n')
      return 0
    }
    case 'pick': {
      // `<key>\t<summary>`, mirroring folder-queue.js's `<id>\t<path>`: bash cuts at the tab
      // (`${pick%%$'\t'*}`), so the key can never be confused with a summary containing
      // spaces. NOTHING AT ALL on an empty queue, and exit 0 — an empty queue is an answer,
      // and the loop reads the empty capture as "stop" rather than as a failure.
      const pick = await queuePick(arg, { exec: execa })
      if (pick) process.stdout.write(`${pick.key}\t${pick.summary}\n`)
      return 0
    }
    case 'claim': {
      // EXIT CODE IS THE ANSWER (1, not 2: the call was well formed, the claim failed), and
      // the reason goes to STDERR so it reaches the run's log without polluting a capture.
      const result = await claimTask(arg, { exec: execa })
      if (result.ok) return 0
      process.stderr.write(`jira-queue.js: ${result.reason}\n`)
      return 1
    }
    case 'complete': {
      // JIRA_DONE_STATUS ARRIVES THROUGH THE ENVIRONMENT, and does not need a flag or a loop
      // change to get here: templates/ralph.sh sources ralph.config.sh under `set -a`, so
      // every value in that file is exported into the agent's environment and reaches this
      // process. Unset or empty skips the transition and warns — see `completeTask`.
      // `stderr` is left to `completeTask`'s own default (process.stderr) — passing it here
      // read as if the choice were significant to this verb.
      const result = await completeTask(arg, {
        doneStatus: process.env.JIRA_DONE_STATUS,
        exec: execa,
      })
      if (result.ok) return 0
      process.stderr.write(`jira-queue.js: ${result.reason}\n`)
      return 1
    }
    case 'comment': {
      // ALWAYS EXIT 0 — the `|| true` promise, spelled as an exit code. The work is already
      // committed by the time anything comments, so a failed post is a line in a log and
      // never a signal that could turn a finished ticket into a failed iteration.
      //
      // THE BODY IS REJOINED FROM WHATEVER ARGUMENTS ARRIVED, because the caller here is an
      // LLM writing a shell command: the prompt tells it to quote both the key and the body
      // (step 7), and a body it quoted anyway arrives as ONE argument and is rejoined from a
      // list of one. This is the disobedient case — an unquoted body arrives as many arguments,
      // and joining them back with single spaces yields a slightly-squashed comment instead of
      // a truncated one. Newlines are already lost to the shell by then; nothing this side can
      // recover them. Note the KEY has no such recovery, which is why it is quoted in the
      // template: `arg` is one argument or it is the first word of one.
      const result = await commentTask(arg, rest.join(' '), { exec: execa })
      if (!result.ok) process.stderr.write(`jira-queue.js: ${result.reason}\n`)
      return 0
    }
    case 'titles': {
      // ONE `<key>\t<summary>` LINE PER RESOLVED KEY (#132) — `pick`'s field separator, chosen
      // for the same reason: bash cuts at the tab, so a summary containing spaces can never be
      // read as part of the key. A key nobody could resolve gets NO LINE AT ALL rather than a
      // blank one, so the output is a map a caller can read with `while IFS=$'\t' read -r key
      // summary` and never a row with a hole in it. Unlike `pick`, every line here goes through
      // `mapLine`, because this verb prints MANY rows — see that function's comment.
      //
      // NOTHING IN THIS REPO CALLS THIS VERB, and that is worth stating rather than leaving a
      // reader to grep for it. `templates/ralph.sh` and `templates/prompt-team-jira.md` do not
      // mention it, and `ralph status` — the surface #132 was for — calls the LIBRARY function
      // `titlesFor` directly rather than spawning a second node process to parse its stdout.
      // The verb exists so that a template or an orchestrator prompt CAN ask a key → summary
      // question the same way it already asks `count`, `pick` and `locate` theirs: #132 requires
      // it, and a bash caller has no other way in. No caller is promised here, and none is
      // implied — if one lands, this paragraph is where it gets named.
      //
      // THE KEYS ARRIVE HOWEVER A SHELL FELT LIKE SPELLING THEM — several arguments, one quoted
      // argument of several words, or a comma-separated list — because a caller would be a
      // template or an LLM writing a shell command, and all three spellings mean the same
      // question. Splitting on whitespace-or-comma covers them with one rule; anything that is
      // not a key the grammar recognises is dropped by `titlesFor` itself.
      //
      // ALWAYS EXITS 0, the same promise `comment` and `locate` make, and for the same reason:
      // a title is a courtesy, and a non-zero exit here would invite a `|| true` at the call
      // site that swallowed the LINES as well as the code.
      const asked = [arg, ...rest]
        .join(' ')
        .split(/[\s,]+/)
        .filter((key) => key !== '')
      const titles = await titlesFor(asked, { exec: execa })
      // Printed in the order they were ASKED, not the order acli answered: the output of a
      // read-only lookup should not depend on a board's paging. One write, so a caller reading
      // this with `read` never sees a half-written map. `mapLine` — not an interpolation — is
      // what keeps a board-written summary from forging a row; see its comment.
      const printed = new Set()
      let out = ''
      for (const key of asked) {
        if (printed.has(key) || !Object.hasOwn(titles, key)) continue
        printed.add(key)
        out += mapLine(key, titles[key])
      }
      if (out !== '') process.stdout.write(out)
      return 0
    }
    case 'locate': {
      // THE STATE WORD ON STDOUT, mirroring folder-queue.js's `locate` — templates/ralph.sh
      // captures it and compares it against `done`. ALWAYS EXITS 0, and prints `unknown` rather
      // than nothing when the board could not be read: an unreadable ticket is an ANSWER here
      // ("not provably done", so sweep it), and a non-zero exit would invite a `|| true` at the
      // call site that hid the word as well.
      process.stdout.write((await locateTask(arg, { exec: execa })) + '\n')
      return 0
    }
    case 'fail': {
      // EXIT CODE IS THE ANSWER, exactly as for `claim`: 1 means the `failed` label did not go
      // on, i.e. the ticket is still in the queue. The loop does not branch on it — a sweep it
      // could not make is a run it must still finish — but the code is what makes this verb
      // usable by anything that does, and the sentence on stderr is the only record of why the
      // board never changed.
      const result = await failTask(arg, { exec: execa })
      if (result.ok) return 0
      process.stderr.write(`jira-queue.js: ${result.reason}\n`)
      return 1
    }
    default:
      process.stderr.write(`jira-queue.js: unknown command '${cmd}'\n`)
      return 2
  }
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code))
}
