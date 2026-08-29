// Jira-mode task queue (#126). When TASK_SOURCE=jira, the queue depth comes from a Jira
// project instead of `gh issue list`: this module composes the configured JIRA_JQL (see
// jira-jql.js) and asks Atlassian's `acli` to count what matches. Structural mirror of
// folder-queue.js — a library API for the JS commands plus a node CLI the bash loop can
// shell out to — so bash holds no Jira knowledge of its own.
//
// THIS IS THE ONLY PLACE IN RALPH THAT KNOWS `acli` EXISTS as a thing you run, and the argv
// below is the interface. `lib/jira-auth.js` knows the auth subcommand for the same reason
// and in the same shape; keep both spellings in their one named place rather than inline at
// a call site, where an interface is an interface nobody finds.
//
// WHERE THIS SPLITS, WHEN IT NEXT GROWS (review's suggestion, deliberately not done in
// #127): the acli LAYER here — the argv builders, `acliText`, `firstWorkItem` and
// `findLabelArray` — would become `lib/jira-acli.js`, leaving this file as the verbs
// (count, pick, claim). Worth doing when the next slice adds acli writes; not worth it for
// four invocations.
//
// Library API (injectable exec for hermetic tests):
//   queueCountResult(jql, {exec}) — one probe, reported honestly: {ok, count, reason}
//   queueCount(jql, {exec})       — the same probe read as a number; 0 on anything that is
//                                   not a provable count
//   queuePick(jql, {exec})        — the top ticket of that same query: {key, summary}|null
//   claimTask(key, {exec})        — label it in-progress, read-then-union: {ok, labels, reason}
//
// CLI (for templates/ralph.sh):
//   node jira-queue.js count "<jql>"   → prints the count
//   node jira-queue.js pick "<jql>"    → prints `<key>\t<summary>`, or nothing when empty
//   node jira-queue.js claim "<KEY>"   → claims it; exit 1 (and a sentence on stderr) if not
//
// THE CLAIM IS THE FIRST THING RALPH WRITES TO SOMEBODY'S BOARD (#127), and it is written
// READ-THEN-UNION rather than as a bare append. `acli jira workitem edit --labels` is
// documented as "Edit the labels" and NOTHING IN THIS REPO CAN VERIFY WHETHER IT APPENDS OR
// REPLACES: no test here may spawn the real Atlassian CLI (there is none in CI, and a claim
// is a write to a live board). Under replace semantics a bare `--labels in-progress` would
// silently delete every label a team had put on the ticket — a destructive, invisible loss
// that would look like a successful claim. Reading the labels first and writing back the
// UNION is correct under EITHER semantics, which is the only way to be right without knowing
// which one it is. The cost is one extra process per iteration; the alternative is unbounded.
//
// AND IT IS ALSO WHY A CLAIM THAT COULD NOT READ WRITES NOTHING AT ALL. An unreadable label
// list is a claim that has to be abandoned, not one to be made optimistically: writing
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
//   ./jira-jql.js, which is pure and has no edges; anything needing a live count belongs
//   behind an injected seam the diagnostic is handed, not behind an import.
//
// TWO CALLERS, ONE PROBE, TWO LEGITIMATE DEGRADATIONS — which is why there are two
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
import { composeJiraJql, JIRA_IN_PROGRESS_LABEL } from './jira-jql.js'
import { usableJiraKey } from './jira-key.js'

// The argv, in its one named place — see the header. A function rather than a constant only
// because the composed query is an argument; the shape around it is the interface. MODULE-
// PRIVATE, like ACLI_JIRA_AUTH_STATUS_ARGV in jira-auth.js: naming it is for readers of this
// file, and exporting it would invite a second caller to know what Ralph runs. Tests reach it
// through the argv `queueCountResult` records on the injected `exec`.
const acliCountArgv = (jql) => ['jira', 'workitem', 'search', '--jql', jql, '--count']

// The same search, asked for ONE work item and its text instead of a total (#127).
//
// `--fields` ON `search` ACCEPTS ONLY issuetype, key, assignee, priority, status, summary,
// reporter and labels — a documented allowlist, and the reason this asks for `key,summary`
// and nothing else. (Pinned in jira-queue.test.js: any field added here is checked against
// that allowlist.)
//
// THE ORDERING IS THE SAME KIND OF CLAIM AS THE FLAG SPELLINGS BELOW — TRANSCRIBED, NOT
// MEASURED. The documentation describes `--fields` as restricting what is FETCHED and says
// nothing about what may be ORDERED ON, so the expectation is that the composer's `ORDER BY
// created ASC` still decides which single work item `--limit 1` returns. Nothing here can
// run acli against a real site to confirm it. If a jira run is ever seen handing out
// tickets in some other order — newest first, or arbitrary — this argv is where to look, and
// the failure is mild: the queue still drains, one ticket per iteration, just not
// oldest-first.
const acliPickArgv = (jql) => [
  'jira',
  'workitem',
  'search',
  '--jql',
  jql,
  '--limit',
  '1',
  '--json',
  '--fields',
  'key,summary',
]

// The two halves of the claim. The read asks for the ONE field it is about to overwrite.
//
// THE FLAG SPELLINGS BELOW (`--key`, and `--json` on `view`) ARE TRANSCRIBED, NOT MEASURED.
// Nothing in this repo runs a real acli, so if a claim ever fails in the field with a
// usage error rather than a permission one, THESE TWO LINES ARE WHERE TO LOOK — the argv is
// the interface, and it is deliberately here in one place so a correction is one edit and
// not a search. The failure mode is loud and safe: an argv acli rejects exits non-zero, the
// read fails, nothing is written, and the loop warns.
const acliViewLabelsArgv = (key) => ['jira', 'workitem', 'view', '--key', key, '--fields', 'labels', '--json']

// `--yes` IS NOT OPTIONAL, and not a style choice: this runs inside a detached tmux pane
// with no terminal to answer on, so an acli that stops to confirm an edit would hang the
// iteration until the loop's caller killed it. Every WRITE in this file carries it, and
// jira-queue.test.js asserts that of every write rather than of this line, so a second
// write added later cannot quietly omit it.
const acliEditLabelsArgv = (key, labels) => [
  'jira',
  'workitem',
  'edit',
  '--key',
  key,
  '--labels',
  labels,
  '--yes',
]

// A DIGIT STRING AND NOTHING ELSE. `Number('')` is 0 and `Number('  7 ')` is 7, so a
// tolerant parse would read an empty answer — the shape a broken spawn produces — as a
// real count of zero, and would accept `1e3`, `0x10` and `-3` as counts too. A count acli
// did not clearly report is not a count, so it comes back as null and NOT as 0: telling the
// two apart is the whole point of `queueCountResult` below.
function parseCount(text) {
  const raw = text.trim()
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

const noCount = (reason) => ({ ok: false, count: null, reason })

// ONE SPAWN SEAM FOR EVERY acli INVOCATION IN THIS FILE (#127). There are four of them now —
// count, pick, and the claim's read and write — and each has to guard the same three ways a
// process comes back with nothing. Guarding them once means a fifth invocation added later
// inherits all three instead of having to remember them, and that the module's central
// promise (every failure is a VALUE, nothing throws) holds by construction rather than by
// four independent copies of it staying right.
//
// Returns the TEXT acli printed, or a sentence saying why there is none. The sentence is what
// `ralph status` shows a human, so it names the thing to go and check.
const SPAWN_FAILED = (err) => `acli could not be run: ${err?.message || 'unknown error'}`
const EXIT_FAILED = 'acli did not exit cleanly — is it installed, and is the session logged in?'
const UNREADABLE = 'acli exited cleanly but Ralph could not read its output'

async function acliText(exec, argv) {
  let r
  try {
    r = await exec('acli', argv, { reject: false })
  } catch (err) {
    // A missing/unusable `exec` lands here too (calling a non-function throws), which is why
    // there is no separate guard for it: both mean "no process was run".
    return { ok: false, text: null, reason: SPAWN_FAILED(err) }
  }
  // EXIT CODE FIRST, text second — the same rule jira-auth.js keys on. A non-zero exit with
  // plausible output is not an answer; it is a CLI explaining itself. A result with no
  // exitCode at all (execa's ENOENT shape, a spawn that never happened) fails the same test.
  if (!r || r.exitCode !== 0) return { ok: false, text: null, reason: EXIT_FAILED }
  // READING the text is inside a guard too, not just parsing it: `stdout` may be a getter on
  // a destroyed stream, or an object whose `toString` explodes. Both mean nothing usable came
  // back, and neither may escape as a throw.
  try {
    const stdout = r.stdout
    return { ok: true, text: typeof stdout === 'string' ? stdout : (stdout?.toString?.() ?? ''), reason: null }
  } catch {
    return { ok: false, text: null, reason: UNREADABLE }
  }
}

// `undefined` for anything that is not JSON — including the empty string, which is what a
// search with no matches may well print. A parse failure and an empty answer are the same
// finding to every caller here: nothing to read.
function parseJsonOrUndefined(text) {
  const raw = (typeof text === 'string' ? text : '').trim()
  if (raw === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

// THE ENVELOPE acli WRAPS A WORK ITEM IN IS NOT SOMETHING THIS REPO CAN VERIFY, so the
// readers below accept the shapes a JSON-printing Jira client plausibly produces — a bare
// array, a `{issues: [...]}` page, or a single object — instead of betting the queue on one.
// Being wrong here is a queue that reads as permanently empty, which is silent; being
// tolerant costs a few lines and cannot misread a shape it does not recognise (it answers
// "nothing", the same as an empty queue).
function firstWorkItem(parsed) {
  if (Array.isArray(parsed)) return parsed[0]
  if (parsed === null || typeof parsed !== 'object') return undefined
  for (const wrapper of ['issues', 'workItems', 'results']) {
    if (Array.isArray(parsed[wrapper])) return parsed[wrapper][0]
  }
  return parsed
}

// The summary, wherever the envelope keeps it. '' rather than null or undefined when there is
// none: this value is printed into a `<key>\t<summary>` line for bash, where a template hole
// would print the word "undefined" and read as a real ticket title.
function summaryOf(item) {
  const summary = item?.fields?.summary ?? item?.summary
  return typeof summary === 'string' ? summary : ''
}

/**
 * The next Jira work item the loop should pick up, per the configured eligibility query.
 *
 * NULL IS THE ONLY FAILURE, unlike the count above, and that asymmetry is deliberate: a
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

const noClaim = (reason) => ({ ok: false, labels: null, reason })

// The label list this work item carries today, or null when acli's answer did not contain
// one. NULL IS NOT AN EMPTY LIST HERE, and that distinction is the safety property: a
// document with no readable `labels` means the current labels are UNKNOWN, and a write built
// on that guess is the wipe the read exists to prevent. An explicitly empty `labels: []` is
// a fine, common answer — most of the queue looks like that.
//
// The search is depth-bounded rather than keyed to one path, for the envelope reason above:
// `{labels}`, `{fields:{labels}}` and either of those inside a one-item array or a wrapper
// object are all shapes a Jira client prints, and the first `labels` array found is the
// one this work item has (the read asked for that single field, so there is nothing else
// in the document for it to confuse it with).
function findLabelArray(node, depth = 0) {
  if (depth > 4 || node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findLabelArray(child, depth + 1)
      if (hit !== null) return hit
    }
    return null
  }
  if (Array.isArray(node.labels)) return node.labels
  for (const value of Object.values(node)) {
    const hit = findLabelArray(value, depth + 1)
    if (hit !== null) return hit
  }
  return null
}

// Labels as they can be written back: trimmed, de-duplicated, order preserved.
//
// A LABEL IS SENT AS ONE COMMA-JOINED VALUE, which is how acli spells a list, so a label
// that itself contained a comma would arrive at Jira as two. It is kept rather than dropped
// anyway: Jira's own label field rejects whitespace, this repo cannot verify what else it
// rejects, and dropping a label Ralph merely found suspicious is the deletion the union
// exists to avoid. A non-string entry IS dropped, because there is no text to send.
//
// THE DROP IS PER ENTRY, AND WHAT AN ALL-DROPPED LIST MEANS IS DECIDED BY THE CALLER — see
// `claimTask`. This function reports what can be sent; it does not judge what it means that
// nothing can.
function writableLabels(raw) {
  const out = []
  for (const label of raw) {
    if (typeof label !== 'string') continue
    const trimmed = label.trim()
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/**
 * Claim a Jira work item for this run by labelling it `in-progress` — the label the composed
 * query EXCLUDES (see jira-jql.js), so a claimed ticket drops out of the next pick and the
 * queue drains instead of handing the same ticket out forever.
 *
 * READ, UNION, WRITE — never a bare write; see the module header for why that is not
 * caution but correctness. IDEMPOTENT: a ticket that already carries the label is reported
 * as claimed and touched no further, so a re-run of a half-finished iteration is free.
 *
 * @param {string} key the work item key, e.g. `FOO-123`
 * @param {{ exec?: Function }} [deps] injected process spawner (no default — see above)
 * @returns {Promise<{ok: boolean, labels: string[]|null, reason: string|null}>}
 */
export async function claimTask(key, { exec } = {}) {
  const target = usableJiraKey(key)
  // Nothing to claim SPAWNS NOTHING: an `acli edit` with an empty key is a request whose
  // subject is whatever acli decides it is, and this is a write.
  if (target === null) return noClaim('no Jira work item key to claim')

  const read = await acliText(exec, acliViewLabelsArgv(target))
  if (!read.ok) return noClaim(`could not read ${target}'s labels, so nothing was written: ${read.reason}`)

  const current = findLabelArray(parseJsonOrUndefined(read.text))
  if (current === null) {
    return noClaim(
      `acli printed no label list for ${target}, so its labels are unknown and were left alone`,
    )
  }

  const labels = writableLabels(current)
  // A LIST THAT WAS FOUND AND EMPTIED IS AN UNREADABLE LIST, NOT AN EMPTY ONE — QA's finding,
  // and the distinction the safety property turns on. `labels: []` is a ticket with no labels
  // and claims normally; a NON-EMPTY list out of which nothing could be sent is acli spelling
  // labels in a shape this file's reader does not know, with the real label text somewhere
  // inside the entries it just discarded (`[{"name":"frontend"}]` is the shape a REST payload
  // uses). Writing then would send `--labels in-progress` alone, which under replace semantics
  // is the wipe the read exists to prevent — reached through a read that SUCCEEDED, which is
  // why the check has to be here and not in the null branch above.
  //
  // A PARTIAL drop does not refuse, deliberately: `["frontend", null, 42]` still writes
  // `frontend,in-progress`, because a list with at least one readable label was read
  // correctly and the entries dropped from it cannot be labels Jira held (its label field
  // holds non-empty text, so a number, an object or `"   "` is not a label being deleted).
  // The all-dropped case is different in kind — it is evidence about the ENVELOPE, not about
  // the entries — and evidence that Ralph is misreading acli is not a licence to write.
  if (current.length > 0 && labels.length === 0) {
    return noClaim(
      `acli spelled ${target}'s labels in a shape Ralph cannot send back, so its labels are unknown and were left alone`,
    )
  }

  // Already ours. The cheapest idempotence is the one that does not touch a board it has
  // nothing to change on — and it keeps a re-selected ticket from looking like a fresh claim.
  if (labels.includes(JIRA_IN_PROGRESS_LABEL)) return { ok: true, labels, reason: null }

  const claimed = [...labels, JIRA_IN_PROGRESS_LABEL]
  const write = await acliText(exec, acliEditLabelsArgv(target, claimed.join(',')))
  if (!write.ok) return noClaim(`could not label ${target} ${JIRA_IN_PROGRESS_LABEL}: ${write.reason}`)
  return { ok: true, labels: claimed, reason: null }
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

  // Every way the process itself can fail to answer is handled by the shared seam above, so
  // what is left here is the one thing specific to counting: whether the text IS a count.
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

// --- CLI entrypoint (for templates/ralph.sh) --------------------------------
// Async, unlike folder-queue.js's, for one reason: the spawner is resolved HERE rather than
// at module scope, so a command that only wants the library never loads execa.
async function runCli(argv) {
  // One positional argument, read as a query by `count`/`pick` and as a key by `claim` —
  // the same shape folder-queue.js's CLI has (a verb and the thing it acts on).
  const [cmd, arg] = argv
  if (!cmd || !arg) {
    process.stderr.write('usage: jira-queue.js count|pick "<jql>" | jira-queue.js claim "<KEY>"\n')
    return 2
  }
  // Resolved once for all three verbs (a `claim` runs two processes through it). Still inside
  // the CLI and still dynamic, which is the property that matters: no importer of this
  // module's library API pulls execa in.
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
