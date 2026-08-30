// PURE label vocabulary — NO I/O (#139). The single place in JavaScript where a Ralph
// GitHub label is spelled, and the place the exclusion query is COMPOSED rather than typed.
// Sibling of git-remote-slug.js, task-file.js and jira-jql.js in posture: deterministic
// values and composed strings, no filesystem, no clock, no imports at all.
//
// WHY A MODULE FOR FOUR WORDS. Before #139 the in-progress name was a code literal in four
// files under lib/ — start.js five times, and once each in cycle.js, status.js and
// orphan-cleanup.js — and the exclusion query was typed out by hand in three commands —
// `ralph start`, `ralph cycle` and `ralph status` — each carrying its own copy of a string
// whose clause order nothing checked. Every one of those copies is one half of a mechanism
// whose other half is somewhere else: the loop STAMPS a label and the query EXCLUDES it, and
// if the two ever disagree the queue stops draining. A Ralph that claims one word and
// excludes another is handed the same issue on every pass, forever, at a paid agent
// invocation each time, having already done the work. That is the failure this file exists
// to make impossible, and it is the same argument lib/jira-jql.js makes for the Jira side.
// #140 is what the module was built for: the rename below is a one-line edit here, and every
// copy outside JavaScript is held to it by lib/labels.parity.test.js.
//
// THE JIRA SIDE IS STILL NOT HERE, AND SINCE #140 THE TWO VOCABULARIES OVERLAP. jira-jql.js
// owns `in-progress` / `done` / `failed` on a different board, and the rename means two of
// those three words are now spelled identically on both sides — same word, same meaning, two
// separate constants (`JIRA_IN_PROGRESS_LABEL` / `JIRA_FAILED_LABEL` there,
// `IN_PROGRESS_LABEL` / `FAILED_LABEL` here). That is deliberate and must not be "unified":
// the two lanes write to different systems, so a board that renames its Jira label has no
// business renaming a GitHub one, and jira-jql.js's spec pins that module at ZERO imports so
// it could not read this one anyway. `done` has no counterpart here at all — GitHub says done
// by CLOSING the issue — and `do-not-ralph` is the one word both lanes genuinely share, with
// jira-jql.js composing its own copy for that same purity reason. Each name lives beside the
// exclusion it feeds; what changed in #140 is that the spellings agree, not the ownership.

// The label a CLAIM writes: `ralph.sh` and the orchestrator prompts add it to the issue the
// loop just picked, and the query below is what makes the next pick skip it. Also the label
// the ORPHAN SWEEP hunts (lib/orphan-cleanup.js) — an invocation that dies mid-issue leaves
// it behind, and an issue nobody is working on that every query excludes is work lost until
// something strips it.
export const IN_PROGRESS_LABEL = 'in-progress'

// The label a GIVE-UP writes. It outranks everything in the outcome precedence
// (lib/issue-event.js) — an issue can be CLOSED and still have failed — and it takes the
// issue out of the queue so the loop advances instead of spinning on work it cannot finish.
export const FAILED_LABEL = 'failed'

// The label a SUCCESS writes when the PR landed on a staging branch rather than the default
// one: the issue stays open awaiting the rollforward, so its own state cannot say "done" and
// this label says it instead. Read as a PASS by lib/issue-event.js for exactly that reason.
export const PENDING_MERGE_LABEL = 'pending-merge'

// The label a HUMAN writes, and the only one of the four Ralph never creates. It means
// hands off this issue — so a `gh label create` for it would be Ralph offering to skip its
// own work, which is why it is absent from MANAGED_LABELS below. It is in the exclusion,
// because excluding it is the entire point of it.
export const SKIP_LABEL = 'do-not-ralph'

// All four, in the order the exclusion query uses them. The ORDER IS PART OF THE CONTRACT
// and not a style choice: `gh issue list --search` does not care, but the assembled query
// string is spelled out 46 times across the repository, and 43 of those sit in four
// pre-existing test files (cycle.test.js 24, test/commands/start.test.js 14, cycle.qa.test.js
// 4, status.test.js 1), where 42 are whole `gh` command lines used as exec-mock keys — so
// reordering these clauses is a behaviour change as far as every one of them is concerned.
// The other three copies are prose or parity anchors rather than mock keys: templates/ralph.sh
// (the loop's own SEARCH_QUERY), README.md and labels.test.js. Counts re-measured after #140
// renamed the first two clauses; the rename moved every copy but changed none of the totals.
export const RALPH_LABELS = Object.freeze([
  IN_PROGRESS_LABEL,
  FAILED_LABEL,
  SKIP_LABEL,
  PENDING_MERGE_LABEL,
])

// The labels Ralph CREATES, with the colour and description `ralph start` has always given
// them. Three entries, not four — see SKIP_LABEL above for the missing one.
//
// The descriptions are USER-VISIBLE and `gh label create` writes them, so a casual reword
// here rewrites the description on every board that runs a newer Ralph. They are pinned
// byte-for-byte in labels.test.js for that reason.
//
// Iterated by `ralph start` into one `gh label create` per entry — name, then `--color`,
// then `--description`, which is the argv the shell-level tests key on.
export const MANAGED_LABELS = Object.freeze([
  Object.freeze({
    name: IN_PROGRESS_LABEL,
    color: 'FFA500',
    description: 'Ralph loop in progress',
  }),
  Object.freeze({
    name: FAILED_LABEL,
    color: 'B60205',
    description: 'Ralph loop tried and gave up',
  }),
  Object.freeze({
    name: PENDING_MERGE_LABEL,
    color: '0E8A16',
    description: 'Ralph PR merged into staging branch, awaiting rollforward to default',
  }),
])

// Names Ralph has RETIRED, mapped OLD SPELLING to the name that replaced it. #140 dropped the
// `claude-` prefix from the two labels Ralph stamps on an issue: the words describe what the
// LOOP is doing — this issue is in progress, this issue failed — and Ralph has driven Codex as
// well as Claude since #554, so the prefix named the wrong thing on half its runs.
//
// A MAP AND NOT A LIST, because both readers need the destination and not just the departure.
// `ralph start` prints a migration warning off it (#141) and cannot say "rename it to WHAT"
// from a list of dead words; labels.parity.test.js sweeps every tracked file for the keys.
// One export rather than a list beside a map: two shapes carrying one fact is exactly the
// drift this module was written to remove, one level up.
//
// An entry here is a PROMISE that the old spelling is gone from every non-JS copy too, and
// labels.parity.test.js is what collects on it — a template, a doc or a test still carrying a
// key of this object fails the suite. The exemptions are enumerated and argued for once, in
// test/helpers/legacy-label-sweep.js; this module is on that list, because a mapping cannot
// avoid naming what it retired.
export const LEGACY_LABELS = Object.freeze({
  'claude-working': IN_PROGRESS_LABEL,
  'claude-failed': FAILED_LABEL,
})

// The exclusion clauses, composed from the names above. This is the half the orchestrator
// prompts carry, because they pass `--state open` to `gh` as a flag rather than as a
// `state:` search term.
export const LABEL_EXCLUSION = RALPH_LABELS.map((name) => `-label:${name}`).join(' ')

// The query `ralph start`, `ralph cycle`, `ralph status` and templates/ralph.sh all select
// work with — one string, so "6 waiting" in the status view means the same six issues the
// loop would pick up next.
//
// COMPOSED, never typed: that is the whole point of the file, and it is what makes a rename
// one edit rather than four literals and a hope. A hardcoded copy here would pass every
// assertion about the query's current value while silently decoupling it from the names.
export const ISSUE_SEARCH_QUERY = `state:open ${LABEL_EXCLUSION}`
