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
    if (fs.statSync(full).isDirectory()) {
      out.push(...repoMarkdown({ dir: relative(root, full), root, fs }))
    } else if (entry.endsWith('.md') && entry !== 'CHANGELOG.md') {
      out.push(relative(root, full))
    }
  }
  return out
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
