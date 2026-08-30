// #53 docs-guard support — the shared primitives the `ralph cycle` update-docs
// guards are built from: markdown section slicing, whitespace normalization, the
// repo-wide markdown enumeration, and the stale-claim pattern list.
//
// WHY THIS IS A MODULE AND NOT TWO COPIES
// lib/commands/cycle.update-docs.test.js (the contract) and
// cycle.update-docs.qa.test.js (the adversarial augmentation) both need these.
// They started as module-private functions in the first file that the second
// re-derived verbatim in order to drive them with crafted input — which meant a
// future edit to one copy would silently leave the other guard testing something
// different. Same problem test/helpers/env-surface.js solves for the env surface,
// same fix: one definition, imported by both, so QA's crafted-input tests
// (depth arithmetic, the EOF branch, the memfs walk) exercise the REAL helper the
// contract suite runs on, and drift is impossible by construction.
//
// Every function here is pure and fs-injectable where it touches the disk, so the
// walk can be driven against memfs instead of the real repo.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Slice one markdown section: the heading itself plus everything up to the next
 * heading of the same or shallower depth. A nested deeper heading (`####` under a
 * `###`) stays INSIDE the slice, so adding a sub-subsection cannot silently
 * truncate the claims below it.
 *
 * Scoping matters for a docs guard — a claim that only appears three sections
 * away is not documentation of the thing under test, it is a coincidence a reader
 * will never find.
 *
 * Returns '' for a heading that is not present. That is a vacuity hazard for
 * `not.` assertions, so callers must anchor the slice (assert it is non-trivial)
 * before relying on a negative.
 */
export function section(md, heading) {
  const depth = heading.match(/^#+/)[0].length
  const start = md.indexOf(`${heading}\n`)
  if (start === -1) return ''
  const rest = md.slice(start + heading.length)
  const next = rest.search(new RegExp(`^#{1,${depth}} `, 'm'))
  return heading + (next === -1 ? rest : rest.slice(0, next))
}

/**
 * Collapse every run of whitespace to one space, so a claim's words can be
 * matched as a phrase regardless of where a hard wrap fell.
 *
 * Load-bearing, not decoration: README.md wraps at ~78 columns and #53's own
 * headline claim ("never auto-updates") is split through the middle in the file.
 * Commander wraps `--help` output the same way. Structural assertions (headings,
 * section boundaries) must stay on RAW text — this is for prose only.
 */
export function prose(md) {
  return md.replace(/\s+/g, ' ')
}

/**
 * `prose()`, then strip the punctuation a claim's words get WRAPPED in but that
 * carries no part of the claim: markdown emphasis and code spans (`**bold**`,
 * `*italic*`, `_x_`, `` `code` ``) and the `//` or `#` a comment block repeats at the
 * head of every wrapped line.
 *
 * All three were load-bearing when this was added. #128 falsified the sentence "no
 * agent is invoked for a Jira ticket", and the five surviving copies of it were
 * spelled `**No agent is invoked for a Jira ticket**` in README.md and split across
 * two `//` lines in lib/task-source.js — so a pattern written in plain words matched
 * NEITHER, and the plain-word grep that went looking for them missed one entirely.
 * The `#` case is templates/ralph.config.sh, where the same argument is made to the
 * user in a 40-line comment block.
 *
 * Both comment strips are line-anchored, so a `https://` or a `#123` mid-sentence
 * survives. Like `prose()`, this is for prose only, and it is MORE destructive: a
 * markdown heading loses its `#` and a code span its backticks, so structural
 * assertions must stay on raw text or on `prose()`.
 */
export function claimText(text) {
  return prose(text.replace(/^[ \t]*(\/\/+|#+)/gm, ' ')).replace(/[*_`]+/g, '')
}

// Directories with no authored documentation in them. `.ralph/` and `logs/` are
// runtime state, the rest are build/vendor output.
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'logs', '.ralph', 'coverage']

/**
 * Every authored `.md` file in the repo, recursively, as repo-relative paths.
 *
 * ENUMERATED, NOT LISTED. A hardcoded list of doc files is exactly what lets a
 * stale claim into a NEW file — the regression the sweep exists to catch. Pass
 * `dir` to scope the walk to a subtree.
 *
 * CHANGELOG.md is the one deliberate exclusion: it is a dated record of what was
 * true at each release, so an entry describing pre-#51 behavior is history rather
 * than a stale claim.
 *
 * A LISTING IS A SNAPSHOT, NOT A LEASE: an entry can vanish between the readdir
 * and the stat, and in this repo one reliably does. Vitest transforms
 * `vitest.config.js` by writing `vitest.config.js.timestamp-<n>.mjs` beside it and
 * unlinking it immediately, so a walk that trusts its own listing dies on
 * `ENOENT` — intermittently, and only under enough parallel load to overlap a
 * config transform with a sweep, which is why this survived a smaller suite.
 * A vanished entry is skipped; any OTHER stat failure still throws, because a
 * sweep whose value is completeness must not quietly get smaller.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.dir='.']       subtree to walk, relative to `root`
 * @param {string}   [opts.root]          tree root (defaults to the repo root)
 * @param {object}   [opts.fs]            fs impl — inject memfs to walk a crafted tree
 * @returns {string[]} paths relative to `root`
 */
export function repoMarkdown({ dir = '.', root = REPO_ROOT, fs = { existsSync, readdirSync, statSync } } = {}) {
  const abs = join(root, dir)
  if (!fs.existsSync(abs)) return []
  const out = []
  for (const entry of fs.readdirSync(abs)) {
    if (SKIP_DIRS.includes(entry)) continue
    const full = join(abs, entry)
    const stat = statOrVanished(fs, full)
    if (stat == null) continue
    if (stat.isDirectory()) {
      out.push(...repoMarkdown({ dir: relative(root, full), root, fs }))
    } else if (entry.endsWith('.md') && entry !== 'CHANGELOG.md') {
      out.push(relative(root, full))
    }
  }
  return out
}

// `null` for an entry that is gone, a throw for anything else. Narrow on purpose:
// `ENOENT` is the one failure a concurrent writer explains, and swallowing (say)
// `EACCES` would shrink the sweep silently — the one way this guard can fail
// without failing.
function statOrVanished(fs, path) {
  try {
    return fs.statSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Sentences that would assert `ralph cycle` performs no update check.
 *
 * Before #51 that was TRUE, so a surviving sentence saying it is worse than a
 * missing doc: it tells a scheduler owner the opposite of what happens. The union
 * of the contract suite's original four spellings and the six wider ones QA
 * found, deduplicated into one list so there is a single place to widen.
 *
 * `[^.]` keeps every window inside one sentence, so a pattern cannot bridge two
 * unrelated statements. Match against `prose()`-normalized text: a wrap inside a
 * literal phrase a pattern spells out ("update\ncheck") is invisible otherwise.
 *
 * These are deliberately narrow. Legitimate prose that mentions an absent or
 * disabled check without denying one — `doctor`'s literal `no update check cached
 * yet` output, the `RALPH_NO_UPDATE_CHECK` row, "no throttle" — must not match, or
 * the docs would have to get vaguer to stay green.
 */
export const STALE_CLAIM_PATTERNS = [
  // "does not check FOR a new version"
  /`?ralph cycle`?[^.]{0,100}?\b(does not|doesn't|never|will not|won't)\b[^.]{0,60}?checks? for (a |the )?(new|newer|updated?)\b/i,
  // "runs / performs NO update check"
  /`?ralph cycle`?[^.]{0,100}?\b(runs|performs|does|makes)\b no (update|version) check/i,
  // "no update check IN / FOR `ralph cycle`"
  /\bno (update|version) check\b[^.]{0,20}?\b(in|for|on|during)\b[^.]{0,20}?`?ralph cycle`?/i,
  // "skips / bypasses / omits the update check"
  /`?ralph cycle`?[^.]{0,100}?\b(skips|bypasses|omits)\b[^.]{0,40}?(update|version) check/i,
  // "does not RUN / PERFORM / INCLUDE the update check" — the first pattern only
  // catches "check FOR a new version", the second only "does NO update check".
  /`?ralph cycle`?[^.]{0,100}?\b(does not|doesn't|never|will not|won't|cannot|can't)\b[^.]{0,60}?\b(run|runs|do|does|perform|performs|make|makes|include|includes)\b[^.]{0,30}?\b(an?|the|any)?\s*(update|version) check/i,
  // Passive voice, cycle named last.
  /\bno (update|version) check\b[^.]{0,60}?\b(is|are)?\s*(run|performed|done|made|included)\b[^.]{0,60}?`?ralph cycle`?/i,
  // The comparison form, where the denial has no object at all:
  // "Unlike `ralph start`, `ralph cycle` does not."
  /(unlike|whereas|only)\b[^.]{0,60}?`?ralph start`?[^.]{0,120}?`?ralph cycle`?[^.]{0,40}?\b(does not|doesn't|never|won't|will not)\b/i,
  // "…drains the queue WITHOUT any update check."
  /`?ralph cycle`?[^.]{0,120}?\b(without|with no)\b[^.]{0,30}?(update|version) check/i,
  // Exclusivity: "the update check runs only in `ralph start`."
  /(update|version) check\b[^.]{0,40}?\bonly\b[^.]{0,40}?`?ralph start`?/i,
  // "…INCLUDES / HAS no update check" — outside the `(runs|performs|does|makes)` group.
  /`?ralph cycle`?[^.]{0,100}?\b(includes|include|has|have|contains|contain|carries|carry|does|do)\b no (update|version) check/i,
]

/**
 * Sentences that would assert a `jira` run invokes no agent and does no work.
 *
 * Before #128 that was TRUE — the arm counted, selected and claimed, then went round
 * again — so a surviving sentence saying it is worse than a missing doc: it tells a
 * reader the source is a labelling machine when it now works the ticket and commits
 * to `DEV_BRANCH`. #128's own review found FIVE of them still standing in README.md
 * plus the one in lib/task-source.js, in a slice that had already corrected two
 * hunks of the same file, which is what earns this a sweep rather than an edit.
 *
 * Match against `claimText()`, not `prose()`: every real spelling was wrapped in
 * markdown emphasis or split across two `//` lines.
 *
 * DELIBERATELY NARROW, and the constraint is sharper here than for
 * STALE_CLAIM_PATTERNS: lib/digest.js says "no agent invoked" twice (at the `no-run`
 * status and the never-run branch) about a run that never STARTED, which is true and
 * must stay sayable. So every "no agent" pattern below requires an object bound to the
 * denial that only this claim supplies — `jira`, a ticket, a work item, a board, or the
 * assertion that labelling is *all* a run does — and the bare phrase on its own never
 * matches. The consequence clauses are spelled as whole phrases for the
 * same reason: "no PR" and "nothing pushes" are still TRUE of this source and of
 * folder mode, so nothing keys on them.
 */
/**
 * Sentences that would assert a `jira` run leaves an unfinished ticket unswept.
 *
 * Before #130 that was TRUE — the arm ended at the dispatch, so a killed or idle agent
 * left the ticket carrying `in-progress` with no `failed` label and nothing to clear it
 * — and every doc that describes the source said so, at length, because it was the one
 * caveat a reader had to know before pointing this at a real board. #130 writes the
 * sweep, so those sentences now tell a reader the opposite of what happens: that they
 * must go into Jira and strip a label Ralph already replaced.
 *
 * THE SHAPE OF THIS LIST IS #128's, and for the reason its header records: that slice
 * corrected two hunks of README.md while five more copies of the same claim stood, and
 * `grep` found nothing pinning any of them. The same claim was spelled in five files
 * this time (README.md, templates/ralph.config.sh, templates/prompt-team-jira.md,
 * lib/task-source.js and test/loop.jira.adversarial.test.js's pinned-gap test), so the
 * cheap edit and the sweep are the same amount of work only if the sweep exists.
 *
 * Match against `claimText()`, not `prose()`: every spelling wrapped the labels in code
 * spans (`` `failed` ``) or the emphasis a README warning block uses, and the config
 * template makes the argument in a `#` comment block.
 *
 * DELIBERATELY NARROW, and the constraint bites in two places. Folder mode has a real
 * **failure sweep** of its own that README.md documents (`- The bash loop owns the
 * failure sweep…`), so nothing here may key on that phrase alone. And the caveat that was
 * honest when this list was written — "what is still missing is the per-ticket telemetry
 * (#131)" — was written in the same sentence shape as the claims below, so every "missing"
 * pattern here requires the failure half or the sweep as its object. #131 has since landed
 * and falsified that caveat too; JIRA_UNRECORDED_CLAIM_PATTERNS below is its sweep, and
 * the two lists stay disjoint by each binding to its own object.
 */
export const JIRA_UNSWEPT_CLAIM_PATTERNS = [
  // "…but has no failure half" — the config table's row, and the shortest spelling.
  /\bno failure half\b/i,
  // "WHAT IS STILL MISSING IS THE FAILURE HALF" / "The missing half is now the failure
  // half", i.e. the denial with `missing` leading.
  /\b(missing|absent|unbuilt|unwired)\b[^.]{0,40}?\bfailure half\b/i,
  // …and trailing: "while the failure half is unbuilt".
  /\bfailure half\b[^.]{0,30}?\b(unbuilt|unwired|not wired|missing|absent)\b/i,
  // "the sweep for a ticket the agent could not finish" as the thing that is MISSING.
  // Bound to the denial, because the same phrase describes the sweep that now exists.
  /\b(missing|absent|unbuilt|unwired|not wired|no)\b[^.]{0,60}?\bsweep for a ticket\b/i,
  // "that sweep is not wired yet" — prompt-team-jira.md's Failed path.
  /\bsweep\b[^.]{0,30}?\bnot wired\b/i,
  // "nothing sweeps a ticket the invocation could not finish back out of `in-progress`".
  /\bnothing sweeps\b/i,
  // The consequence clauses, which deny the sweep without naming it. Each is the exact
  // shape #130 had to delete.
  /\bno failed label\b/i,
  // "so `in-progress` stays on it until you strip the label yourself" — the reader-facing
  // consequence, and the one sentence of the set that names no label but `in-progress`.
  // BOUND TO "until you", deliberately: lib/jira-queue.qa.test.js says "the mixed-case
  // in-progress label stays on the ticket" about a label whose CASE stopped a removal
  // matching, which is true and must stay sayable, so `stays on` alone cannot be the key.
  /\bin-progress\b[^.]{0,60}?\b(until|unless) you\b/i,
  // The README warning's headline. `comes back[^.]{0,6}off` rather than the plain phrase
  // because it wrapped mid-clause inside a `>` blockquote, and `claimText` strips markdown
  // emphasis but not the quote marker.
  /\bonly a ticket (it|ralph|the agent|the loop) (finished|resolved|completed)\b[^.]{0,40}?\bcomes back[^.]{0,6}?off\b/i,
  /\ba failed iteration does not\b/i,
  // THE COUNT-SHAPED CLAIM, which is the shape that survived the first sweep of this slice:
  // a sentence that denies the sweep by COUNTING Ralph's labels rather than by describing
  // what it does not do. Five copies stood at HEAD — two README sentences ("Two of those
  // four labels are Ralph's own writes", "the two labels Ralph writes"), two comments
  // ("BOTH LABELS RALPH WRITES ARE COMPOSED IN…" in lib/jira-jql.js and one in
  // lib/jira-jql.test.js) and one test TITLE in lib/jira-jql.qa.test.js. Measured against
  // the ten patterns above: each of the five is matched by one of the two below and by
  // NOTHING else. Naming a label is not enough to be caught, and deliberately so — every
  // pattern up there binds `in-progress` or `failed` to a denial, because both words appear
  // all over prose that is true.
  /\b(two|both) of (those|the) four labels\b/i,
  // Bound through `ralph` to the verb, deliberately: "the two labels a ticket's SUCCESS path
  // writes" is TRUE (the claim and the completion) and lib/jira-jql.test.js says it, so a
  // count beside the word `labels` alone cannot be the key. `[^.]` and not `.` because the
  // README copy wrapped between `Ralph` and `writes`, and a negated class matches a newline
  // where a dot does not.
  /\b(two|both) labels\b[^.]{0,20}?\bralph\b[^.]{0,20}?\bwrites?\b/i,
]

export const JIRA_AGENTLESS_CLAIM_PATTERNS = [
  // "No agent is invoked for a Jira ticket" / "…for one yet" / "…on it, so a green…"
  // — the denial with its object trailing.
  /\bno agent\b[^.]{0,20}?\b(is|was|gets|ever)?\s*invoked\b[^.]{0,20}?\b(for|on|under|by|in)\b[^.]{0,30}?\b(jira|ticket|work item|workitem|board|one yet|it,|it\.|this source|that source)/i,
  // The object leading instead: "under `jira` … no agent is invoked", "with no agent
  // invoked it is also all a run does".
  /\b(jira|ticket|work item|workitem)\b[^.]{0,120}?\bno agent\b[^.]{0,20}?\binvoked\b/i,
  // Active voice, the loop as subject: "selects a ticket and claims it, and invokes
  // no agent on it".
  /\binvokes no agent\b/i,
  // The denial as a subordinate clause, whose object is the RUN and not the ticket:
  // "But with no agent invoked it is also *all* a run does". Nothing in the sentence
  // names Jira, so the two patterns above cannot see it — which is why it is spelled
  // out, and why the bound object here is the "all a run does" claim itself.
  /\bno agent\b[^.]{0,20}?\binvoked\b[^.]{0,60}?\ball a (jira )?run does\b/i,
  // The consequence clauses, which deny the work without using the word "agent".
  // Each is the exact shape #128 had to delete, and each is false the moment the arm
  // dispatches at all.
  /\bthe work itself is still missing\b/i,
  /\bnothing is coded\b/i,
  /\b(resolves|resolve|works|work|does|do) no ticket\b/i,
  /\bwork(ed|s|ing)? none of them\b/i,
]

/**
 * Sentences that would assert a `jira` iteration records no telemetry event.
 *
 * Before #131 that was TRUE — the arm counted, selected, claimed, dispatched and swept, and
 * appended nothing to `.ralph/metrics/issues.jsonl` — so the caveat was written wherever the
 * source is described: six hunks of README.md, the `TASK_SOURCE` comment block in
 * templates/ralph.config.sh, the arm's own comment in templates/ralph.sh,
 * lib/task-source.js's history paragraph, and lib/progress.js's closed row, which had no
 * name to show precisely because no event carried one. #131 appends the event, so each of
 * those now tells a reader their Jira run leaves no record — the opposite of what
 * `ralph status`'s task table and `ralph cycle`'s counts will show them.
 *
 * THE SHAPE OF THIS LIST IS #128's AND #130's, for the reason their headers record: each of
 * those slices corrected the hunks it could find and left copies standing, because nothing
 * pinned the prose. Same three surfaces, then — markdown, tracked `.js`, tracked `.sh`.
 *
 * DELIBERATELY NARROW, and the constraint bites in three places, all of them sentences this
 * slice WROTE. `lib/task-source.js` now says the digest and the counts "finally have a
 * per-iteration record of a Jira run", so the per-iteration pattern is bound to the denial
 * ahead of it rather than to the phrase. README.md now says the loop "appends one per-ticket
 * event", so the telemetry patterns are bound to a word of absence. And `lib/jira-key.js`
 * still describes a real remaining defect — the digest's number-derived transcript path — in
 * the same sentence shape, so nothing here keys on `follow-up` alone.
 */
export const JIRA_UNRECORDED_CLAIM_PATTERNS = [
  // "What is still missing is the per-ticket telemetry" / "…is a per-ticket telemetry event
  // (#131)", the caveat's headline, with the absence leading and trailing.
  /\b(missing|absent|unbuilt|unwired|not wired|no)\b[^.]{0,40}?\bper-ticket (issue )?(telemetry|event)\b/i,
  /\bper-ticket telemetry\b[^.]{0,30}?\b(missing|absent|unbuilt|unwired|not wired|a follow-?up)\b/i,
  // "What is NOT WIRED is the telemetry" — the same claim with the noun bare, which is why
  // this binds to `wired` and never to the word `telemetry` on its own: that word is all
  // over prose about the sidecar that now exists.
  /\bnot wired is the telemetry\b/i,
  // The denial by way of the WRITE, in the four spellings that stood: "no issue event is
  // appended under this source", "nothing appends a task event under this source",
  // "nothing appends one under this source", "no RALPH_ISSUE_EVENT line is appended".
  /\bno (issue|task|per-ticket|per-iteration) event is appended\b/i,
  /\bnothing appends\b[^.]{0,30}?\b(event|one under)\b/i,
  /\bnothing records\b[^.]{0,40}?\btelemetry\b/i,
  /\bno RALPH_ISSUE_EVENT line is appended\b/i,
  // "the only two arms that append an event are `folder` and `github`" — the claim made by
  // COUNTING the arms, which is the shape that survives a grep for the word it never uses.
  /\bonly two arms\b/i,
  // The consequence clauses, which deny the event without naming it.
  /\b(have|has|with) no per-iteration\b/i,
  /\bcannot narrate a jira iteration\b/i,
  /\breads 0 completed\b/i,
  // lib/progress.js's closed row: "records `issue_number` and nothing else to name a task
  // by" — the same denial from the READER's side, in the module that draws the row, and the
  // one copy that named neither Jira nor telemetry.
  /\bnothing else to name a task by\b/i,
  // And the FUTURE TENSE, which is its own kind of stale: "#131 will put this arm's
  // telemetry block in the gap" was a promise, and a promise that has been kept reads as one
  // still outstanding. Bound to a verb so a reference to the slice itself stays sayable.
  /#131 (will|would|is going to) \w+/i,
]
