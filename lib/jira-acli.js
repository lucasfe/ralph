// THE acli LAYER (#129) — the only place in Ralph that knows what Atlassian's `acli` is
// called, what argv it takes, and what its output looks like. Split out of jira-queue.js,
// which is now the VERBS (count, pick, claim, complete, comment, and #130's locate and fail)
// and their policy; this file is HOW YOU TALK TO acli AND HOW YOU READ WHAT IT SAYS, and
// nothing about queues.
//
// WHY THE SPLIT HAPPENED HERE. jira-queue.js's header carried a note from #127's review
// naming this file and saying it was "worth doing when the next slice adds acli writes; not
// worth it for four invocations". #129 is that slice: completion adds a transition, a
// label removal and a comment, so the count was seven invocations and four of them are WRITES.
// #132's batch title lookup makes EIGHT, and it is a READ, so the four is still all of them.
// The line between the two files is the one the note drew — argv, the spawn seam, and the
// readers for acli's envelope on this side; the decisions about what any of it MEANS for a
// queue on the other.
//
// EVERY SPELLING IN THIS FILE IS TRANSCRIBED, NOT MEASURED, AND THAT IS THE WHOLE REASON IT
// IS ONE FILE. No test in this repo may spawn the real Atlassian CLI: there is none in CI,
// and four of these invocations WRITE TO SOMEBODY'S LIVE BOARD (a label, a label removal, a
// status transition, a comment). So the argv below is read off Atlassian's documentation and
// not off a run. The failure that buys is loud and safe in every case — an argv acli rejects
// exits non-zero, `acliText` turns that into a refusal, and the verb above degrades: a count
// reads as unknown, a pick as an empty queue, a claim as "not claimed, ticket still
// eligible", a transition as "move it by hand", a comment as nothing at all, a locate as
// `unknown` (which the loop reads as "not provably done" and sweeps), and a sweep as a
// `failed` label the board never took, reported on stderr. WHAT IT COSTS
// IS A BOARD WRITE, NEVER A RUN. And because every spelling is here, a correction is one edit
// in one file rather than a search.
//
// `--yes` IS NOT A STYLE CHOICE. This runs inside a detached tmux pane with no terminal to
// answer on, so an acli that stopped to confirm a write would hang the iteration until the
// loop's caller killed it. Every WRITE builder below carries it, and jira-queue.test.js
// asserts that of every recorded write rather than of these lines, so a write added later
// cannot quietly omit it. THREE OF THE FOUR ARE TRANSCRIBED AND THE FOURTH IS EXTRAPOLATED —
// `comment create` is documented without it; see the note at `acliCommentArgv`.
//
// PURE, AND EDGELESS ON PURPOSE: this file imports nothing at all (asserted in
// jira-queue.qa.test.js, alongside jira-jql.js and jira-key.js). It never names a spawner —
// `exec` arrives as an argument, exactly as it does in the verbs — so importing it costs an
// importer no execa, no child_process, and no capability it did not already have.

// --- argv, the interface ---------------------------------------------------------------

// The count. A function rather than a constant only because the composed query is an
// argument; the shape around it is the interface.
export const acliCountArgv = (jql) => ['jira', 'workitem', 'search', '--jql', jql, '--count']

// The same search, asked for ONE work item and its text instead of a total (#127).
//
// `--fields` ON `search` ACCEPTS ONLY issuetype, key, assignee, priority, status, summary,
// reporter and labels — a documented allowlist, and the reason this asks for `key,summary`
// and nothing else. (Pinned in jira-queue.test.js: any field added here is checked against
// that allowlist.)
//
// THE ORDERING IS THE SAME KIND OF CLAIM AS THE FLAG SPELLINGS — TRANSCRIBED, NOT MEASURED.
// The documentation describes `--fields` as restricting what is FETCHED and says nothing
// about what may be ORDERED ON, so the expectation is that the composer's `ORDER BY created
// ASC` still decides which single work item `--limit 1` returns. Nothing here can run acli
// against a real site to confirm it. If a jira run is ever seen handing out tickets in some
// other order — newest first, or arbitrary — this argv is where to look, and the failure is
// mild: the queue still drains, one ticket per iteration, just not oldest-first.
export const acliPickArgv = (jql) => [
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

// The same search again, asked for MANY work items' text at once (#132) — the argv behind
// `titlesFor`, which resolves the summary of every ticket `ralph status` is about to name.
//
// WHY A SEPARATE BUILDER RATHER THAN A `--limit` ARGUMENT ON `acliPickArgv`. The two differ in
// what they are FOR, and the difference is worth being able to read at the call site: a pick
// asks the board "what should I work on next" and takes the first answer, while this asks "what
// are these named tickets called" and wants every answer. The `--fields` allowlist above
// governs this line too — `key,summary`, for the same documented reason — and `--json` is what
// makes the answer readable rather than a table drawn for a human.
//
// THE LIMIT IS THE CALLER'S TICKET COUNT, NOT A CONSTANT, and that is a correctness detail
// rather than tidiness: acli's default page size is not something this repo can measure, so
// asking for nine tickets and being handed a default five would leave four rows silently
// untitled. TICKETS, i.e. the number of terms the `jql` beside it names, which is what
// `titlesFor` passes and not the number of spellings its caller asked with — the same word this
// is called by at that call site. The caller bounds the count before it gets here (see
// `MAX_TITLE_KEYS` in jira-queue.js); this only spells it. Numbers are stringified because argv
// is strings.
export const acliTitlesArgv = (jql, limit) => [
  'jira',
  'workitem',
  'search',
  '--jql',
  jql,
  '--limit',
  String(limit),
  '--json',
  '--fields',
  'key,summary',
]

// The read half of every label write. Asks for the ONE field it is about to overwrite.
export const acliViewLabelsArgv = (key) => [
  'jira',
  'workitem',
  'view',
  '--key',
  key,
  '--fields',
  'labels',
  '--json',
]

// The label write. ONE comma-joined value, which is how acli spells a list.
//
// WHETHER THIS APPENDS OR REPLACES IS THE THING THIS REPO CANNOT VERIFY, and every label
// write above is read-then-union because of it — see jira-queue.js's `addLabel`. The
// documentation says only "Edit the labels".
export const acliEditLabelsArgv = (key, labels) => [
  'jira',
  'workitem',
  'edit',
  '--key',
  key,
  '--labels',
  labels,
  '--yes',
]

// The label REMOVAL (#129), and the reason it is spelled with its own flag rather than with
// another `--labels`: `--remove-labels` is UNAMBIGUOUS. "Remove these labels" means the same
// thing under either reading of `--labels`, whereas expressing a removal as `--labels
// <everything except in-progress>` would be a bet on replace semantics — and if `--labels`
// appends, that write would do nothing at all and leave `in-progress` on a finished ticket
// forever. TRANSCRIBED, like the rest: if a completion is ever seen failing with a usage
// error rather than a permission one, this line is the first place to look, and the cost is
// a stale `in-progress` beside a `done` — untidy, and never a ticket back in the queue,
// because the exclusion matches on `done` too.
export const acliRemoveLabelsArgv = (key, labels) => [
  'jira',
  'workitem',
  'edit',
  '--key',
  key,
  '--remove-labels',
  labels,
  '--yes',
]

// The status transition (#129). THE ONE WRITE THAT IS EXPECTED TO FAIL SOMETIMES, and not
// because of this spelling: a Jira workflow decides which transitions exist from a given
// status and what they require, so `--status "Done"` is refused outright on any board whose
// workflow has no such move from where the ticket sits, or that demands a field first. The
// caller treats that as a board move lost and never as a failed task — see `completeTask`.
// So a wrong spelling here costs exactly what a refused workflow costs: a warning, and a
// ticket a human moves by hand.
export const acliTransitionArgv = (key, status) => [
  'jira',
  'workitem',
  'transition',
  '--key',
  key,
  '--status',
  status,
  '--yes',
]

// The comment (#129). `comment create` — a two-word subcommand, unlike every other argv here,
// which is exactly the kind of detail worth having in one place.
//
// THIS IS THE ONE WHOSE FAILURE COSTS THE MOST AND CHANGES THE LEAST. In Jira mode nothing
// pushes and no PR is opened, so a comment carrying the commit SHA is the only audit trail
// that leaves the machine — and yet a comment that fails must not change a run's outcome,
// because the work is already committed. Best-effort, `|| true`, like the telemetry sidecar in
// templates/ralph.sh.
//
// `--yes` HERE IS EXTRAPOLATED FROM `edit`, NOT TRANSCRIBED FROM `comment`'s OWN DOCUMENTATION.
// The other three writes are documented as taking it; this one is the assumption that a CLI
// with a global confirmation flag applies it uniformly. It is the weakest spelling in the file
// AND the one whose rejection is quietest — the verb above exits 0 by contract, so a usage
// error costs the comment silently, with only a line on stderr to say the audit trail did not
// land. If Jira comments are ever seen going missing while the label and the transition work,
// drop this flag first; a comment needs no confirmation to be safe, unlike a label write.
export const acliCommentArgv = (key, body) => [
  'jira',
  'workitem',
  'comment',
  'create',
  '--key',
  key,
  '--body',
  body,
  '--yes',
]

// --- the spawn seam --------------------------------------------------------------------

// ONE SPAWN SEAM FOR EVERY acli INVOCATION IN RALPH. There are eight argv builders above and
// each invocation has to guard the same three ways a process comes back with nothing.
// Guarding them once means a ninth inherits all three instead of having to remember them,
// and that jira-queue.js's central promise — EVERY FAILURE IS A VALUE, NOTHING THROWS — holds
// by construction rather than by eight independent copies of it staying right. #132's title
// lookup is the proof rather than the hope: it was added as one builder and one reader, and
// inherited every failure path below without adding a line to any of them.
//
// Returns the TEXT acli printed, or a sentence saying why there is none. The sentence is what
// `ralph status` shows a human, so it names the thing to go and check.
export const SPAWN_FAILED = (err) => `acli could not be run: ${err?.message || 'unknown error'}`
export const EXIT_FAILED =
  'acli did not exit cleanly — is it installed, and is the session logged in?'
export const UNREADABLE = 'acli exited cleanly but Ralph could not read its output'

export async function acliText(exec, argv) {
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
    return {
      ok: true,
      text: typeof stdout === 'string' ? stdout : (stdout?.toString?.() ?? ''),
      reason: null,
    }
  } catch {
    return { ok: false, text: null, reason: UNREADABLE }
  }
}

// --- reading what acli printed ---------------------------------------------------------

// A DIGIT STRING AND NOTHING ELSE. `Number('')` is 0 and `Number('  7 ')` is 7, so a
// tolerant parse would read an empty answer — the shape a broken spawn produces — as a
// real count of zero, and would accept `1e3`, `0x10` and `-3` as counts too. A count acli
// did not clearly report is not a count, so it comes back as null and NOT as 0: telling the
// two apart is the whole point of `queueCountResult`.
export function parseCount(text) {
  const raw = text.trim()
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

// `undefined` for anything that is not JSON — including the empty string, which is what a
// search with no matches may well print. A parse failure and an empty answer are the same
// finding to every caller: nothing to read.
export function parseJsonOrUndefined(text) {
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
// THE WRAPPER NAMES, ONCE. Order is significant — the first one present wins, and a page that
// somehow carried two is read by the same rule every time — so this is a list and not a set. It
// is a constant rather than two literals because a wrapper acli starts using must be ONE edit:
// `allWorkItems` is the only reader of the envelope, and `firstWorkItem` is its first element.
const WORK_ITEM_WRAPPERS = ['issues', 'workItems', 'results']

// A BARE OBJECT IS A LIST OF ONE, which is the last clause: a JSON-printing client asked for one
// field of one ticket may well print the ticket. Anything that is not an object at all — a
// string, a number, `null`, the prose acli prints when a search matches nothing — is an EMPTY
// list, so a caller filtering entries never has to ask whether it was handed items or an
// explanation.
export function allWorkItems(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed === null || typeof parsed !== 'object') return []
  for (const wrapper of WORK_ITEM_WRAPPERS) {
    if (Array.isArray(parsed[wrapper])) return parsed[wrapper]
  }
  return [parsed]
}

// THE FIRST ITEM, WHICH IS THE FIRST ELEMENT OF THE LIST — expressed that way rather than as a
// second walk of the envelope. The two had duplicate bodies when #132 added the list reader, and
// the reason given for the copy (`firstWorkItem` is on the queue's critical path) was a
// performance argument about one array index that does not survive being said out loud: review
// rejected it, and the duplicate spelling of the wrapper list was a real cost, since a wrapper
// acli started using would have been two edits in two places. Equivalence is not an assumption
// either — `allWorkItems(x)[0] === firstWorkItem(x)` is measured over twenty envelopes by
// lib/jira-acli.qa.test.js's parity sweep, and it now holds by construction.
//
// `[0]` OF AN EMPTY LIST IS `undefined`, which is the answer every caller of this already
// expects: an empty page, a non-object and an unrecognised shape are one finding — nothing to
// read — and that was true of the old body too.
export const firstWorkItem = (parsed) => allWorkItems(parsed)[0]

// The summary, wherever the envelope keeps it. '' rather than null or undefined when there is
// none: this value is printed into a `<key>\t<summary>` line for bash, where a template hole
// would print the word "undefined" and read as a real ticket title.
export function summaryOf(item) {
  const summary = item?.fields?.summary ?? item?.summary
  return typeof summary === 'string' ? summary : ''
}

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
export function findLabelArray(node, depth = 0) {
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
// `readWritableLabels` in jira-queue.js. This function reports what can be sent; it does not
// judge what it means that nothing can.
export function writableLabels(raw) {
  const out = []
  for (const label of raw) {
    if (typeof label !== 'string') continue
    const trimmed = label.trim()
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}
