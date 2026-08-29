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
