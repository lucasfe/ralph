// #140 support — the primitives the retired-spelling sweeps are built from: the pattern that
// recognises a name Ralph has retired, the files still allowed to carry one, and the offender
// report over every file `git ls-files` knows about.
//
// WHY THIS IS A MODULE AND NOT TWO COPIES
// Two specs ask the same question of the whole repository. lib/labels.parity.test.js asks it as
// #140's acceptance criterion — no tracked file outside the mapping may still spell a retired
// name. lib/labels.rename.qa.test.js asks the stronger version: not as an exact substring, so
// neither a capital letter nor a hyphen left at a Markdown line break can hide one, and with the
// exemptions pinned as an exact offender list rather than as a skip-list. The second subsumes the
// first, and they used to be two sweeps carrying two hand-maintained copies of the exemption
// list, with the *count* of that list written out in prose in three more places. That is one fact
// in five files, in specs whose own subject is a module written to stop one fact living in four.
// Same problem test/helpers/source-control-bytes.js solves, same fix: one definition, imported by
// both, so drift is impossible by construction.
//
// THE LIST BECAME ONE DEFINITION; ITS SIZE DID NOT. #142 added an entry below and had to go
// hunting for the prose counts of this list, because a number in a comment is not a thing a
// shared definition can keep honest — consolidating the array did nothing for them. Measured
// afterwards, with the matcher in lib/labels.rename.qa.test.js run over the tree as it stood
// BEFORE #142: FOUR comments stated the size, and #142's FIRST pass — done by hand, before that
// matcher existed — rewrote three of them and walked straight past the fourth, which went on
// describing this list by a length it no longer had. DO NOT GO LOOKING FOR IT HERE: the same
// issue that noticed the miss fixed it, so all four read correctly in the landed tree. The stale
// claim survives in exactly one place — quoted verbatim as the regression fixture that matcher is
// demonstrated on — which is deliberate, because an argument about a defect nobody can still read
// is one a later reader is entitled to disbelieve. And the miss IS the argument rather than an
// embarrassment to note in passing: "remember to update the counts" is precisely what that first
// pass was, carried out attentively, and it still left the tree making a false claim about its
// own drift.
//
// So it is a RULE now instead of a recount. A comment may name this LIST and may not state its
// LENGTH, which is enforceable in a way that remembering is not. That same spec sweeps for it over
// every tracked `.js` and `.md` — prose is the only place a count of this kind has ever lived —
// skipping itself, since it has to quote the claim #142 left behind in order to demonstrate the
// matcher on it. The one enumeration left standing is that file's own, which lists the
// entries by the ROLE each earns its exemption for — kept because its argument is about which
// exemption is the dangerous one, and NOT because anything would catch it going stale: no
// assertion compares that paragraph to this array, so a fifth entry leaves it quietly incomplete.
// It is a claim a reader editing this array is standing next to, which is the whole of its
// protection. So adding an entry here is an edit to this array and to that one paragraph, and to
// no count anywhere.
//
// THE NEEDLES ARE COMPOSED, NEVER TYPED. Every spelling this module hunts for is derived from
// the keys of LEGACY_LABELS, which is what makes the sweep track the mapping instead of agreeing
// with it by coincidence: a future rename that records its old name in the mapping gets both
// sweeps for free, and one that forgets gets no sweep at all — which is why lib/labels.test.js
// pins the mapping's contents separately. It also keeps THIS file out of its own haystack. A
// hand-typed needle here would be a retired spelling in a tracked file, which is the exact thing
// being swept for, and the sweep would have to exempt its own detector to stay green.
//
// BECAUSE THE PATTERN IS SHARED, A BROKEN PATTERN WOULD GO VACUOUS IN BOTH PLACES AT ONCE. That
// is the one cost of merging the two sweeps, and it is paid in lib/labels.rename.qa.test.js,
// which demonstrates the matcher on live variants and on the two things that legitimately read
// like a retired name — the loop's `claude_failed` shell exit flag and ordinary English about the
// agent failing — before either sweep is believed.

import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { RALPH_HOME } from '../../lib/paths.js'
import { LEGACY_LABELS } from '../../lib/labels.js'
import { trackedFiles } from './source-control-bytes.js'

// The retired spellings themselves, straight off the mapping.
export const RETIRED_SPELLINGS = Object.freeze(Object.keys(LEGACY_LABELS))

const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A retired name as it actually survives in a tree, rather than as an exact substring:
//
//   * CASE-INSENSITIVELY, because a heading or a sentence capitalises it.
//   * WITH WHITESPACE TOLERATED AFTER EACH HYPHEN, because a Markdown reflow or a wrapped code
//     comment breaks the line exactly there — the hyphen is the only place in these names a
//     wrap can land.
//
// Hyphen-and-whitespace only, deliberately. Replace the hyphen with an underscore and you have
// templates/ralph.sh's own `claude_failed` agent-exit flag, 11 occurrences of it; replace it with
// a space and you have ordinary English about the agent failing, which ralph.sh and README.md
// both write. Neither is a label spelling, so neither is in the class.
export const RETIRED_SPELLING = new RegExp(
  RETIRED_SPELLINGS.map((name) =>
    name.split('-').map(escapeForRegExp).join('-\\s*'),
  ).join('|'),
  'i',
)

// The files a retired spelling is allowed to survive in, and why each one earns it. Asserted in
// BOTH directions by the specs that import it — an allowlisted file that no longer carries a
// retired name is deleted from this list rather than left standing as an excuse, and a file that
// is not on it carrying one is the failure.
export const LEGACY_EXEMPT = Object.freeze([
  // The mapping itself: old name to new. Deleting the entry would delete the migration warning
  // #141 reads off it.
  'lib/labels.js',
  // The spec that pins the mapping's contents. It has to name what was retired in order to
  // assert what it was retired in favour of; an assertion phrased over Object.keys alone would
  // agree with any mapping, including an empty one.
  'lib/labels.test.js',
  // One shipped release entry — the #40 stale-label fix, released in #46 — describing what a
  // past version really did. That version did stamp the old word, so rewriting the line would
  // falsify history rather than finish a rename; the one file #140 must leave byte-identical.
  'CHANGELOG.md',
  // The upgrade note in the troubleshooting section (#142), which is the OTHER END of #140's
  // clean break: Ralph has never run `gh label edit` on a user's board, so the two commands that
  // finish the rename are the user's to paste, and a command cannot avoid naming what it renames
  // — the same argument lib/labels.js makes for its own exemption, one level out from the code.
  // The difference is where a stale copy lands. lib/labels.js's literal is READ BY THE PROGRAM,
  // so a wrong one misbehaves; the README's is PASTED BY A HUMAN, so a wrong one fails in their
  // terminal with nothing on the page explaining why — which is why the exemption is paid for
  // rather than merely granted: lib/labels.parity.test.js drives the real findLegacyLabels and
  // requires each line here to equal, verbatim and once, the line `ralph start` prints. The
  // retired-spelling sweep can no longer defend this file, so that equality is what does.
  'README.md',
])

const repoRelative = (path) => relative(RALPH_HOME, path).split(sep).join('/')

// Every tracked file carrying a retired spelling, as `{ file, spelling }`, skipping the exempt
// list. Pass `exempt: []` to sweep the whole tree, which is how the exemption list is pinned as
// an exact offender list rather than trusted.
export function legacyOffenders({ exempt = LEGACY_EXEMPT } = {}) {
  const offenders = []
  for (const path of trackedFiles()) {
    const file = repoRelative(path)
    if (exempt.includes(file)) continue
    const hit = readFileSync(path, 'utf8').match(RETIRED_SPELLING)
    if (hit) offenders.push({ file, spelling: hit[0] })
  }
  return offenders
}

// The same report as a sorted list of paths, for the assertion that names who is allowed to
// carry one. `legacyOffenders` reports at most one hit per file, so this needs no deduplication.
export function filesCarryingRetiredSpelling() {
  return legacyOffenders({ exempt: [] })
    .map((offender) => offender.file)
    .sort()
}
