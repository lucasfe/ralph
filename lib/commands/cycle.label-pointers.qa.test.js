// #139 QA augmentation — the `file.js:LINE` pointers this diff REWROTE.
//
// #139 added six lines to the top of lib/orphan-cleanup.js and four to lib/commands/start.js,
// which shifted every line below them — so the dev re-numbered the source-comment pointers in
// cycle.js's preflight paragraph. Those pointers are the only thing telling a reader where the
// two `gh` spawns a scheduled Jira tick pays for actually are, and a comment that names a line
// is a claim that goes false silently: nothing in the suite reads it, and the next slice adds
// lines to the same two files.
//
// So the pointers are pinned to the CODE THEY DESCRIBE rather than to a number: each entry
// below is a NEEDLE, the expected line is derived by finding it in the target file, and cycle.js
// must spell that derived number. Nothing here restates 35, 39, 76, 105, 624, 646 or 654 — a
// second copy of a line number is a second thing to update, which is the failure mode this file
// exists to catch. Verified by reading the target line rather than by trusting the arithmetic: a
// mechanical `+6` keeps a pointer consistent with itself while saying nothing about whether it
// was ever right.
//
// ALSO COVERED, after review round 1: the four `./start.js:N` pointers in the same file, which
// were stale BEFORE #139 and which #139 shifted by the `+4` its own import added — preserving a
// pre-existing error rather than introducing one. They were left alone in the first pass and
// reported; they are now corrected to the measured anchors (the unwrapped-`runUpdateGate`
// rationale, the post-update refusal, its `else if` branch, and the `isTTY` derivation) and
// pinned here by needle, so the next edit to either file cannot shift them a fifth time. Ranges
// are pinned on their FIRST number: that is the one an inserted line above moves, and the end of
// a block is not addressable by a unique needle.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const sourceOf = (url) => readFileSync(new URL(url, import.meta.url), 'utf8')

// The 1-based line of the ONE line containing `needle`. Unique-or-throw on purpose: a needle
// that matched twice would let this file derive a plausible wrong number and agree with a
// pointer that is wrong in the same way.
function lineWith(source, needle) {
  const hits = source
    .split('\n')
    .map((line, index) => (line.includes(needle) ? index + 1 : 0))
    .filter(Boolean)
  if (hits.length !== 1) {
    throw new Error(`needle ${JSON.stringify(needle)} matched ${hits.length} lines, expected 1`)
  }
  return hits[0]
}

const cycle = sourceOf('./cycle.js')
const orphan = sourceOf('../orphan-cleanup.js')
const start = sourceOf('./start.js')

// Each pointer cycle.js spells, and the code it claims is there.
const ORPHAN_POINTERS = [
  // "...reports through its own `log = console.error` default (orphan-cleanup.js:N)"
  { needle: 'export async function findOrphans(', claim: 'the findOrphans signature' },
  // "...spawn `gh issue list --state all --label in-progress` (orphan-cleanup.js:N)"
  { needle: "await exec('gh', LIST_ARGS", claim: 'the list spawn' },
  // "...per orphan found, `gh issue edit N --remove-label in-progress` (orphan-cleanup.js:N)"
  { needle: "await exec('gh', args", claim: 'the per-orphan remove-label write' },
]

const START_POINTERS = [
  // "Unwrapped for the reasons at ./start.js:N-…"
  {
    needle: '// The gate prints nothing but the notice,',
    claim: 'the argument for leaving runUpdateGate unwrapped',
  },
  // "`ralph start` refuses to launch its loop after an update (./start.js:N-…)"
  { needle: 'if (updateGate.installed) {', claim: 'the post-update refusal' },
  // "Neutral line and `else if` as ./start.js:N-…"
  { needle: '} else if (updateGate.accepted) {', claim: 'the accepted-but-not-installed branch' },
  // "derived from the RESOLVED `stdin` above exactly as ./start.js:N does"
  { needle: 'isTTY = Boolean(stdin?.isTTY)', claim: 'the isTTY default' },
]

// Every `orphan-cleanup.js:N` / `./start.js:N` cycle.js spells, first number of a range only.
const pointersInto = (file) =>
  [...cycle.matchAll(new RegExp(`${file.replace(/[./]/g, '\\$&')}:(\\d+)`, 'g'))].map((m) =>
    Number(m[1]),
  )

const sorted = (numbers) => [...numbers].sort((a, b) => a - b)

describe('QA #139 — cycle.js’s pointers into orphan-cleanup.js name the right lines', () => {
  it('spells exactly the three pointers this table accounts for', () => {
    // A guard over a table is only as good as the table's coverage: if the paragraph grows a
    // fourth pointer, it must be added here rather than going unchecked.
    expect(sorted(pointersInto('orphan-cleanup.js'))).toEqual(
      sorted(ORPHAN_POINTERS.map((p) => lineWith(orphan, p.needle))),
    )
  })

  it.each(ORPHAN_POINTERS)('the pointer for $claim is the line holding `$needle`', ({ needle }) => {
    expect(pointersInto('orphan-cleanup.js')).toContain(lineWith(orphan, needle))
  })

  it('and the module makes exactly the two `exec` calls the paragraph accounts for', () => {
    // The preflight paragraph's whole point is a COUNT, and this module supplies both halves of
    // it: the `gh issue list` sweep — the second of the two spawns a healthy tick pays for,
    // after `resolveRepoSlug`'s `gh repo view` — and the `gh issue edit` write the paragraph
    // charges at one PER ORPHAN FOUND. Two `exec` call sites, two claims. A third added here is
    // a spawn the arithmetic in that comment does not account for, whichever half it lands in,
    // so it goes red rather than merely making the comment wrong.
    expect([...orphan.matchAll(/await exec\(/g)]).toHaveLength(2)
  })
})

describe('QA #139 — and its pointers into start.js, corrected in review round 1', () => {
  it('spells exactly the four pointers this table accounts for', () => {
    expect(sorted(pointersInto('./start.js'))).toEqual(
      sorted(START_POINTERS.map((p) => lineWith(start, p.needle))),
    )
  })

  it.each(START_POINTERS)('the pointer for $claim is the line holding `$needle`', ({ needle }) => {
    expect(pointersInto('./start.js')).toContain(lineWith(start, needle))
  })
})
