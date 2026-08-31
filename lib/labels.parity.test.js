// #139 — the mechanism that makes a label literal OUTSIDE JavaScript safe. #140 — the rename
// that spent it, and the reason three of the four assertions below are shaped the way they are.
//
// lib/labels.js is the single source of truth for JS, and a rename there is one edit. The
// bash loop and the prompt templates cannot import it: templates/ralph.sh spells its own
// SEARCH_QUERY because it runs standalone in tmux, and a prompt template is text an agent
// reads. So those spellings are COPIES, and a copy with nothing checking it is the drift
// this whole refactor exists to prevent — a loop that stamps the renamed label while the
// prompt tells the agent to add the old one is a loop whose queue never drains.
//
// WHAT #140 CHANGED ABOUT THE QUESTION, because it is the whole design of this file. The two
// renamed labels used to carry a `claude-` prefix — coinages nothing else in this repository
// had any use for, spelled out in lib/labels.js's LEGACY_LABELS and nowhere else since the
// rename — so "does this file contain the string" was a faithful proxy for "does this file
// spell the label". The new names are `in-progress` and `failed`, and both are spoken
// elsewhere by things that are not GitHub labels — the folder lane's status directories
// (`.ralph/tasks/afk/in-progress/`, `afk/failed/`), the Jira lane's own labels
// (lib/jira-jql.js), and, for `failed`, ordinary English: templates/roles/dev.md says "the
// issue is marked failed" and templates/ralph-notify.sh.example documents a `"failed"` status
// string. templates/ralph.sh alone says `failed` 37 times, and only 3 of those write or read the
// GitHub label — the `-label:failed` exclusion clause, the comma-wrapped `,failed,` grep, and
// the `--add-label failed` on the non-zero-exit path. 11 are the `claude_failed` agent-exit
// flag; the rest are the folder and Jira lanes' own outcome words, the cycle's own status, or
// prose. So `text.includes('failed')` now tells you almost nothing about that file.
//
// So this file asks THREE different questions, at three different strengths, and the split is
// deliberate rather than incidental:
//
//   1. WHAT A FILE WRITES (`LABEL_WRITES`) — the strong half, and the one a rename actually
//      turns on. A file writes a label in a `gh` argv or a `-label:` clause, and those
//      spellings are exact whatever the word is. This is the "stamps" side of the invariant
//      whose other side is the composed query at the bottom of this file: the loop STAMPS
//      `in-progress` and the query EXCLUDES it, and if the two disagree the queue never drains.
//   2. WHAT A FILE MENTIONS (`LABEL_FILES`) — the per-file table, unchanged in mechanism. Still
//      worth having as a presence check on the prose docs and the two prose-only templates,
//      where a label is described rather than issued; weaker than it was for the two renamed
//      names, and the header of each half says so where it matters.
//   3. WHETHER ANY RETIRED SPELLING SURVIVES ANYWHERE — the repo-wide sweep, mid-file. The
//      retired names are still unique, so hunting them is still exact, and the sweep needs no
//      table at all: it reads every file `git ls-files` reports. That is what replaced the
//      teeth the "names NOT listed for a file are absent" half lost, and it is why that half is
//      now scoped to the two names that are still unambiguous as text.
//
// THE TABLE IS PER-FILE, NOT BLANKET, because the files genuinely differ: ralph.sh, the two
// PR-flow prompts and README.md carry all four names, while slash-command.md and
// validate-config.md mention only the in-progress one and prompt-team-jira.md /
// ralph.config.sh / CONTRIBUTING.md are listed for the human's `do-not-ralph`. A "all four
// names in every file" assertion would be false, and a test rewritten to pass is a test
// nobody trusts — so the subset each file actually carries is data.
//
// THE DOCS ARE IN SCOPE, AND CHANGELOG.md IS DELIBERATELY NOT. README.md is where a user reads
// which label to strip by hand and which one keeps Ralph off an issue — it spells all four
// names, and 11 of those mentions sit next to label-shaped syntax — counted as occurrences of
// `-label:`, `--label `, `--remove-label` and `--remove-labels`, the last two being distinct
// flags and 2 of the 11 being the plural — plus one verbatim copy of the whole search query, so a
// rename that skipped it would leave the documented remediation instructions doing nothing.
// (Count re-measured at #142, which added a `gh label edit` line per retired label: those two
// carry `--name`, not a label flag, so the label-shaped total is still 11.) SINCE #142 README.md
// IS ALSO EXEMPT FROM THE RETIRED-NAME HALF — and only that half — because the upgrade note it
// gained has to name what #140 retired in order to tell a user how to rename it. That exemption
// is not free: the section's two commands are pinned against a real findLegacyLabels call in its
// own describe below, which is a stronger guard than the substring sweep it replaces, since it
// fails on a documented flag that drifted rather than only on a documented name that did.
// CONTRIBUTING.md is listed for `do-not-ralph`, which it spells 5 times: the Jira lane's
// restriction, plus the convention section that names this module as the only JavaScript allowed
// to spell a label. That section deliberately refers to the OTHER names by their export
// identifiers (`IN_PROGRESS_LABEL`, `FAILED_LABEL`, `PENDING_MERGE_LABEL`) rather than by their
// words — a habit worth keeping for its own sake, though since #140 the negative half no longer
// enforces it for the two renamed names, because CONTRIBUTING.md now writes `in-progress` and
// `failed` about the folder and Jira lanes for reasons that have nothing to do with a GitHub
// label.
// CHANGELOG.md spells a retired name once and `pending-merge` once and is EXCLUDED from every
// assertion here: both live inside shipped release entries (#40 and #130), which describe what
// a past version did. A rename must not rewrite them — the old release really did stamp the old
// word — so a test demanding the current spelling there would be demanding a falsified history.
//
// Prior art: lib/template-parity.test.js — read from disk, assert required structure, rather
// than trusting that an edit to one copy reached the other.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { trackedFiles } from '../test/helpers/source-control-bytes.js'
import { prose } from '../test/helpers/doc-guard.js'
import {
  LEGACY_EXEMPT,
  RETIRED_SPELLING,
  RETIRED_SPELLINGS,
  legacyOffenders,
} from '../test/helpers/legacy-label-sweep.js'
import { RALPH_HOME } from './paths.js'
import {
  FAILED_LABEL,
  IN_PROGRESS_LABEL,
  ISSUE_SEARCH_QUERY,
  LABEL_EXCLUSION,
  LEGACY_LABELS,
  PENDING_MERGE_LABEL,
  RALPH_LABELS,
  SKIP_LABEL,
  findLegacyLabels,
} from './labels.js'

// Repo-relative so the table can hold a template and a doc side by side; every path below is
// read from the checkout root rather than from templates/.
const read = (file) => readFileSync(join(RALPH_HOME, file), 'utf8')

// Every file outside JavaScript that spells a Ralph label, with the names it actually carries.
// MEASURED by reading each one rather than inherited from the issue's list, which had gone
// stale: prompt-team-jira.md and ralph.config.sh landed after it was written.
const LABEL_FILES = [
  // The loop itself: composes the search query, sweeps stale in-progress labels, and reads
  // the failed / pending-merge labels back to decide an issue's outcome.
  {
    file: 'templates/ralph.sh',
    names: [IN_PROGRESS_LABEL, FAILED_LABEL, SKIP_LABEL, PENDING_MERGE_LABEL],
  },
  // The two PR-flow orchestrators: select, claim, hand off, and mark the outcome.
  {
    file: 'templates/prompt-team.md',
    names: [IN_PROGRESS_LABEL, FAILED_LABEL, SKIP_LABEL, PENDING_MERGE_LABEL],
  },
  {
    file: 'templates/prompt-team-codex.md',
    names: [IN_PROGRESS_LABEL, FAILED_LABEL, SKIP_LABEL, PENDING_MERGE_LABEL],
  },
  // Jira mode tracks its own vocabulary (lib/jira-jql.js: in-progress / done / failed), so
  // the only name it shares is the hands-off one a HUMAN applies.
  { file: 'templates/prompt-team-jira.md', names: [SKIP_LABEL] },
  // ...and the config template documents that same exclusion in its JIRA_JQL comment.
  { file: 'templates/ralph.config.sh', names: [SKIP_LABEL] },
  // Both of these only describe the orphan sweep, so only the in-progress label appears.
  { file: 'templates/slash-command.md', names: [IN_PROGRESS_LABEL] },
  { file: 'templates/validate-config.md', names: [IN_PROGRESS_LABEL] },
  // The docs a human reads: what each label means, which one to strip by hand after a crashed
  // run, and which one to apply to keep Ralph off an issue. See the header for why CHANGELOG.md
  // is not here.
  { file: 'README.md', names: [IN_PROGRESS_LABEL, FAILED_LABEL, SKIP_LABEL, PENDING_MERGE_LABEL] },
  { file: 'CONTRIBUTING.md', names: [SKIP_LABEL] },
]

// The two names still spoken by nothing but a Ralph GitHub label. `do-not-ralph` and
// `pending-merge` are Ralph's own coinages; `in-progress` and `failed` were, until #140,
// prefixed with `claude-` and equally distinctive, and are now shared with the folder lane's
// status directories, the Jira lane's labels and plain English. Derived from RALPH_LABELS by
// SUBTRACTING the two renamed names rather than listed independently, so a third rename cannot
// leave a stale word in this set.
const DISTINCTIVE_NAMES = RALPH_LABELS.filter(
  (name) => name !== IN_PROGRESS_LABEL && name !== FAILED_LABEL,
)

// Every way a `gh` command line asks for a label. Used to ask "does this file touch a board"
// without asking about a particular word — which is the only version of that question the
// folder template can be asked since #140.
const LABEL_FLAGS = ['--add-label', '--remove-label', '--label ', '-label:']

describe('label parity — every non-JS copy spells the current names (#139)', () => {
  it.each(LABEL_FILES)('$file carries the names it is listed with', ({ file, names }) => {
    const text = read(file)
    for (const name of names) {
      expect(text, `${file} is missing ${name}`).toContain(name)
    }
  })

  // Every row of the table EXCEPT the ones allowed to spell a retired name. Filtered against
  // the shared exemption list rather than by dropping a row, so the file keeps its place in the
  // "carries the names it is listed with" checks above: since #142 README.md documents #140's
  // migration and therefore names both retired labels on purpose, and that permission is granted
  // in one place (test/helpers/legacy-label-sweep.js) for every sweep in the suite rather than
  // re-argued here. A row whose exemption is later dropped rejoins this check automatically.
  const MIGRATED_FILES = LABEL_FILES.filter(({ file }) => !LEGACY_EXEMPT.includes(file))

  it('the exemption list really removes something from the table, and not everything', () => {
    // Fail closed on the filter: an exemption list that grew to cover the whole table would make
    // the check below iterate nothing and pass forever, and one that matched no row at all means
    // the filter is doing nothing — either because the path spelling drifted (`README.md` vs
    // `./README.md`), leaving README asked a question #142 made it unable to answer, or because a
    // later change legitimately un-exempted every doc in the table, which is what moving the
    // upgrade note into an `UPGRADING.md` of its own would look like. The two are told apart by
    // whether LEGACY_EXEMPT still names a row: this only insists that the filter has an effect.
    expect(MIGRATED_FILES.length).toBeGreaterThan(0)
    expect(MIGRATED_FILES.length).toBeLessThan(LABEL_FILES.length)
  })

  it.each(MIGRATED_FILES)('$file carries no LEGACY name', ({ file }) => {
    // Non-vacuous since #140: LEGACY_LABELS holds two retired spellings, so this loop runs.
    // The repo-wide version of the same question is below and needs no table.
    const text = read(file)
    for (const legacy of Object.keys(LEGACY_LABELS)) {
      expect(text, `${file} still spells the retired ${legacy}`).not.toContain(legacy)
    }
  })

  it('the table accounts for every name the module exports', () => {
    // A file list is only as good as its coverage: each of the four names must be pinned in
    // at least one file, or a rename could land with nothing checking that copy.
    for (const name of RALPH_LABELS) {
      expect(
        LABEL_FILES.some((entry) => entry.names.includes(name)),
        name,
      ).toBe(true)
    }
  })

  it('every listed subset is a subset of the module’s names', () => {
    // Guards the table against a typo'd literal creeping in beside the imports above.
    for (const { file, names } of LABEL_FILES) {
      expect(names.length, file).toBeGreaterThan(0)
      for (const name of names) expect(RALPH_LABELS, `${file}: ${name}`).toContain(name)
    }
  })

  it('names NOT listed for a file really are absent from it', () => {
    // The half that makes the per-file subsets honest rather than merely permissive: without
    // it the table could list one name per file and still pass.
    //
    // SCOPED TO THE TWO NAMES THAT ARE STILL UNAMBIGUOUS AS TEXT (#140). `do-not-ralph` and
    // `pending-merge` are Ralph's own coinages and nothing else in this repository spells
    // them, so their absence from a file is a fact about labels. `in-progress` and `failed`
    // are not: the folder lane's status directories, the Jira lane's labels and plain English
    // all write them, so asking this question of those two names would force `failed` onto
    // nearly every row of the table — turning a discrimination test into a tautology, which
    // is the "test rewritten to pass" this file's header refuses. What that half was really
    // protecting — a copy the table forgot to mention — is now asked directly, over every
    // tracked file and with no table at all, by the sweep below.
    for (const { file, names } of LABEL_FILES) {
      const text = read(file)
      for (const name of DISTINCTIVE_NAMES) {
        if (names.includes(name)) continue
        expect(text, `${file} unexpectedly spells ${name} — add it to the table`).not.toContain(name)
      }
    }
  })

  it('templates/prompt-team-folder.md issues no label call at all — folder mode has no board', () => {
    // Pinned as a NEGATIVE so its absence from the table above is a measured fact rather
    // than an oversight: folder mode tracks progress with the .ralph/tasks status dirs, so
    // there is no label to stamp and nothing to keep in parity.
    //
    // ASKED AS "WRITES", NOT "MENTIONS", SINCE #140. That template says `in-progress` six
    // times and `failed` four, every one of them a `.ralph/tasks/afk/…` DIRECTORY — the folder
    // lane's status vocabulary, which the rename made homographic with the GitHub labels. So
    // the old "contains none of the four words" phrasing became false the day #140 landed
    // while the property it was defending — folder mode touches nobody's board — was still
    // exactly true. Phrased as the absence of a label FLAG it is both true and stronger: it
    // now also fails on a `--add-label` of a name this module has never heard of.
    const folder = read('templates/prompt-team-folder.md')
    for (const flag of LABEL_FLAGS) {
      expect(folder, `folder mode must issue no ${flag} call`).not.toContain(flag)
    }
    for (const name of DISTINCTIVE_NAMES) {
      expect(folder, name).not.toContain(name)
    }
  })
})

// ---------------------------------------------------------------------------
// What each copy WRITES — the stamping half of the invariant (#140)
// ---------------------------------------------------------------------------
//
// The exclusion query at the bottom of this file is the "excludes" half. This is the "stamps"
// half, and until #140 nothing pinned it: the table above could only say that `ralph.sh`
// CONTAINED the failed label's name, which the file also happens to contain 37 times over in
// prose and in the `claude_failed` exit flag. A `--add-label` that had been left on the old
// spelling would have satisfied it. These are the exact argv fragments instead, so the word and
// the flag are asserted together.
const LABEL_WRITES = [
  {
    file: 'templates/ralph.sh',
    writes: [
      // The stale-label sweep, and the give-up stamp on the non-zero-exit path.
      `--remove-label ${IN_PROGRESS_LABEL}`,
      `--add-label ${FAILED_LABEL}`,
      // How the loop READS the labels back: `$labels` is comma-joined and grepped with the
      // commas included, so the delimiters are part of the needle. A bare `failed` here would
      // also match `pre-failed` or `failed-qa` on somebody's board.
      `,${FAILED_LABEL},`,
      `,${PENDING_MERGE_LABEL},`,
    ],
  },
  // Both PR-flow orchestrators, which must move together — the claim at step 2, the swap to
  // pending-merge at step 9, and the failure path. Asserted as whole fragments because the two
  // swaps are single command lines whose label order is what makes them a swap.
  ...['templates/prompt-team.md', 'templates/prompt-team-codex.md'].map((file) => ({
    file,
    writes: [
      `--add-label ${IN_PROGRESS_LABEL}`,
      `--remove-label ${IN_PROGRESS_LABEL} --add-label ${PENDING_MERGE_LABEL}`,
      `--remove-label ${IN_PROGRESS_LABEL} --add-label ${FAILED_LABEL}`,
    ],
  })),
]

describe('label parity — what each copy WRITES, flag and name together (#140)', () => {
  it.each(LABEL_WRITES)('$file issues every label call it is listed with', ({ file, writes }) => {
    const text = read(file)
    for (const fragment of writes) {
      expect(text, `${file} is missing \`${fragment}\``).toContain(fragment)
    }
  })

  it('every listed fragment names a current label — no fragment can outlive a rename', () => {
    // Guards the table against a fragment typed as a literal rather than composed from the
    // exports: each one must end in, or bracket, a name the module still hands out.
    for (const { file, writes } of LABEL_WRITES) {
      expect(writes.length, file).toBeGreaterThan(0)
      for (const fragment of writes) {
        expect(
          RALPH_LABELS.some((name) => fragment.includes(name)),
          `${file}: ${fragment}`,
        ).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The rename, as a repo-wide sweep (#140)
// ---------------------------------------------------------------------------
//
// The acceptance criterion of #140: no source file, template, doc or test outside the exemption
// list may still spell either retired name. Asked here rather than in the
// per-file table above, because it is the same concern — the copies that cannot import — asked
// without a table. The table can only check the files somebody remembered to list; this sweep
// starts from `git ls-files`, so a copy in a file nobody thought about is found anyway.
//
// THIS FILE IS IN ITS OWN HAYSTACK, which is why no comment above names a retired spelling: a
// sweep that exempted the sweep would be the one place a stale copy could hide. The files that
// are allowlisted, and the argument each one makes for itself, live in
// test/helpers/legacy-label-sweep.js — one list, imported by both sweeps rather than typed out
// twice with the count restated in prose beside it.
//
// IT IS ALSO WHAT REPLACED THE NEGATIVE HALF'S TEETH. Before #140 the table's "names NOT
// listed for a file really are absent" assertion was the only thing standing between a
// rename and a copy the table did not mention. It could be, because the retired names were
// `claude-`prefixed coinages nothing else in this repository had a use for. Since the rename
// they are `in-progress` and `failed` — the folder lane's status directories, the Jira lane's
// own labels (lib/jira-jql.js) and, in the case of `failed`, ordinary English, which
// templates/roles/dev.md and templates/ralph-notify.sh.example both write. So absence of the
// substring stopped being evidence of anything, and the guard that survives is this one: the
// RETIRED spellings are still unique, and hunting them is still exact.
//
// THE NEEDLES COME OUT OF THE MAPPING, not out of a literal, so the sweep tracks
// LEGACY_LABELS rather than agreeing with it by coincidence. A future rename that adds a
// third retired name gets this sweep for free; a rename that forgets to record the old name
// gets no sweep at all, which is why labels.test.js pins the mapping's contents too. The
// composition, and the matcher that makes a capital letter or a wrapped line count as the same
// spelling, are in the shared helper.
describe('the rename reached every tracked file (#140)', () => {
  const tracked = trackedFiles()

  it('sweeps a real file list — fail closed, like the byte guard it borrows from', () => {
    // A sweep with an empty haystack passes forever. `trackedFiles` throws on a missing git or
    // a non-repository, so the only remaining way to scan nothing is a filter that removes
    // everything; both halves are pinned. The third way — a needle set that is empty because
    // the mapping is — is pinned here too, since every needle is derived from it.
    expect(tracked.length).toBeGreaterThan(200)
    expect(RETIRED_SPELLINGS.length).toBeGreaterThan(0)
  })

  it('no tracked file outside the exemption list spells a retired name', () => {
    expect(
      legacyOffenders().map(({ file, spelling }) => `${file}: ${spelling}`),
    ).toEqual([])
  })

  it('and every allowlisted file really does still carry one', () => {
    // The half that keeps the allowlist from rotting into names nobody rechecks: an exemption is
    // only legitimate while the file needs it, so a `lib/labels.js` that lost its mapping, a
    // CHANGELOG.md whose history somebody "tidied", or a README whose upgrade note was deleted
    // once the migration felt old — all go red here rather than leaving a standing excuse.
    for (const file of LEGACY_EXEMPT) {
      expect(
        RETIRED_SPELLING.test(read(file)),
        `${file} no longer needs its exemption — drop it from LEGACY_EXEMPT`,
      ).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// The migration the user runs by hand — README against the lines #141 prints (#142)
// ---------------------------------------------------------------------------
//
// #140's rename is a CLEAN BREAK: Ralph has never run `gh label edit` on a board's behalf, so
// every repository that ran an older Ralph is still holding the retired names on live issues
// until a human pastes two commands. #141 made `ralph start` say so and print those two
// commands. #142 is the other end of the same promise — the README has to state the rename, the
// commands, and what skipping them costs, in one place an upgrading reader actually reaches.
//
// WHY THAT BELONGS IN THIS FILE AND NOT A NEW ONE. This spec already owns every "does README.md
// agree with lib/labels.js" question — the verbatim-once copy of ISSUE_SEARCH_QUERY below is the
// same shape of fact, a COMPOSED string reproduced in prose with nothing but a test holding the
// two together. A migration command is that fact again: composed by `migrationCommand`, printed
// at runtime by step 7b of `ralph start`, and now typed out in a doc, where a user PASTES it. So
// it is a fourth question for the file that asks the other three rather than a fourth file
// asking about the same pair of files.
//
// THE EXPECTATION IS DRIVEN, NEVER TYPED, and that is the whole argument for lib/labels.js
// existing. A hand-copied `gh label edit …` line here would agree with a README that had drifted
// from the runtime warning — the two copies would be equal to each other and both wrong — so the
// needles come out of a real `findLegacyLabels` call against a stub `exec` reporting every
// retired name present. That also keeps this file out of its own haystack: the sweep above reads
// every tracked file for a retired spelling, and this one must not be an offender.
//
// README.md IS ON test/helpers/legacy-label-sweep.js's EXEMPTION LIST BECAUSE OF THIS SECTION.
// A migration command cannot avoid naming what it renames, which is the same argument
// lib/labels.js makes for its own exemption; the difference is that this one is prose a human
// pastes rather than a mapping the code reads. Which is why the assertions below are the
// strongest available: an exempt file is a file the retired-spelling sweep can no longer defend,
// so what defends the README's two lines from now on is that they must equal what the check
// composes.

// The bold lead of the README entry, which is also the phrase `ralph start` puts on the screen
// ("Retired label '…' still exists on this board"). Used as the section anchor rather than a
// heading: `## Troubleshooting` is built entirely of bold-lead entries, and a `###` inside it
// would visually adopt every later entry as a subsection of the upgrade note.
const UPGRADE_LEAD = '**`ralph start` warns that a retired label still exists on this board.**'

// The migration lines the runtime check really composes, off a board that still carries every
// name #140 retired. One `exec`, one listing, no filesystem — the same seam `ralph start` hands
// over, which is what makes this the runtime answer rather than a second opinion about it.
const migrationLines = () =>
  findLegacyLabels({
    exec: async () => ({
      exitCode: 0,
      stdout: JSON.stringify(Object.keys(LEGACY_LABELS).map((name) => ({ name }))),
      stderr: '',
    }),
  })

describe('the README documents #140’s migration in the words #141 prints (#142)', () => {
  const readme = read('README.md')

  // Everything from the bold lead up to the next troubleshooting entry. The entries in that
  // section are separated by a blank line and a bold lead, so that pair is the terminator; no
  // paragraph INSIDE the upgrade note may open with bold emphasis, or it would cut its own
  // section short — which the size floor below is what notices.
  const section = (readme.split(UPGRADE_LEAD)[1] ?? '').split('\n\n**')[0]

  // The same slice with every run of whitespace collapsed, for the CLAIMS only. README.md
  // hard-wraps at ~78 columns and "carries over to every issue already holding it" is split
  // through the middle of it in the file, so a phrase asserted on raw text would be asserting
  // about where a wrap happened to fall. The COMMANDS are asserted on RAW text for the opposite
  // reason: a `gh label edit` line a reflow broke in half is a paste that does not run, so there
  // the absence of a wrap is exactly the thing under test.
  const claims = prose(section)

  it('carries the upgrade entry once, and it is a section rather than a sentence', () => {
    // Two halves of one non-vacuity guard: the anchor is present exactly once (a second copy
    // would make every assertion below ambiguous about which one it measured), and the slice it
    // opens is big enough to hold an argument. Every check that follows reads `section`, so a
    // terminator that fired early would quietly narrow all of them to nothing.
    expect(readme.split(UPGRADE_LEAD)).toHaveLength(2)
    expect(section.length).toBeGreaterThan(600)
    expect(section.length).toBeLessThan(readme.length)
  })

  it('carries every `gh label edit` line the check composes — verbatim, once, and in the section', async () => {
    // THE CRITERION THAT MATTERS: the documented remediation and the printed remediation are the
    // same bytes. A README that drifted by one flag is a paste that fails for a reason nothing on
    // the page explains, in the one paragraph a stuck upgrader is reading. Counted rather than
    // merely contained, for the reason the query's copy is counted: a second copy is a second
    // thing to keep in step and should be added here deliberately if it ever appears.
    const found = await migrationLines()
    expect(found.length, 'the check found nothing to migrate — the fixture is broken').toBe(
      Object.keys(LEGACY_LABELS).length,
    )
    // ...and not vacuously equal, which it would be for a mapping that had been emptied.
    expect(found.length).toBeGreaterThan(0)
    for (const { command } of found) {
      expect(readme.split(command), command).toHaveLength(2)
      expect(section, command).toContain(command)
    }
  })

  it('and the section spells both flags a stale board needs, per retired label', async () => {
    // The same criterion measured from the README's side instead of the command's, so it does not
    // depend on the assertion above having been the one that held. The two kinds of staleness
    // arrive together and one paste has to fix both: `--name` for the rename, `--description`
    // because `gh label create` refuses a label that already exists and so never updated the
    // description an older Ralph wrote. The shape is built from the mapping, never typed.
    for (const { legacy, current } of await migrationLines()) {
      expect(section, legacy).toMatch(
        new RegExp(`gh label edit ${legacy} --name ${current} --description '[^']+'`),
      )
    }
  })

  it('explains that ONE rename carries the label over to every issue already holding it', () => {
    // The fact that makes a clean break defensible rather than merely cheap. Without it a reader
    // sensibly assumes two commands cannot possibly be the whole job for a board with a hundred
    // labelled issues, and goes looking for a bulk relabel that nothing here provides.
    expect(claims).toMatch(/\bID\b/)
    expect(claims).toContain('carries over to every issue already holding it')
    expect(claims).toContain('per-issue relabelling')
  })

  it('states BOTH halves of what skipping the migration costs', () => {
    // Both, because either alone reads as harmless. "Still excluded but unswept" is a tidiness
    // problem; "no longer excluded" is a paid agent invocation per pass on work already done.
    // The pair is what makes the gap expensive, and it is the same pair step 7b prints.
    expect(claims).toContain('no longer excluded from the queue')
    expect(claims).toContain('orphan sweep')
  })
})

describe('label parity — the composed query’s copies (#139)', () => {
  it('templates/ralph.sh carries the exact query lib/labels.js composes', () => {
    // The bash loop's SEARCH_QUERY and the JS one must select the same issues; they are two
    // copies of one string, and this is the only thing making them equal.
    expect(read('templates/ralph.sh')).toContain(ISSUE_SEARCH_QUERY)
  })

  it.each(['templates/prompt-team.md', 'templates/prompt-team-codex.md'])(
    '%s carries the exclusion clauses in the same order',
    (file) => {
      // The prompts pass `--state open` as a gh FLAG rather than a `state:` search term, so
      // they carry the clause half of the query — the same four clauses, same order.
      expect(read(file)).toContain(LABEL_EXCLUSION)
    },
  )

  it('README.md documents that same query verbatim, once', () => {
    // The eligibility table in README tells a user exactly which issues Ralph will pick. It is
    // a third copy of the string, in the one place a human checks when the loop skips something
    // — so a rename that left it behind would leave the documentation describing a query that
    // no longer runs. Counted rather than merely contained: a second copy is a second thing to
    // keep in step, and it should be added here deliberately if it ever appears.
    //
    // ONE COPY IS THE DELIBERATE STATE, and #140 is when it became true. The "No issues are
    // picked up" troubleshooting entry used to restate the query and had drifted to three of
    // its four clauses — telling a user their `pending-merge` issue was eligible while the loop
    // skipped it, in the one paragraph somebody reads when the queue looks stuck. A truncated
    // copy is invisible to the count below, so it was replaced with prose that names the four
    // labels and links to the table rather than a second string to keep in step. Restating the
    // query there again is the mistake this comment exists to head off; QA's
    // labels.rename.qa.test.js is what catches it, by requiring every multi-clause `-label:`
    // run in the docs to name the same labels in the same order as the loop's own SEARCH_QUERY.
    expect(read('README.md').split(ISSUE_SEARCH_QUERY)).toHaveLength(2)
  })

  it('and both prompts still ask for the oldest issue first', () => {
    // Not a label claim, but it travels in the same string: a queue with no ordering churns
    // instead of draining. Pinned so a rewrite of that gh line cannot drop it silently.
    for (const file of ['templates/prompt-team.md', 'templates/prompt-team-codex.md']) {
      expect(read(file), file).toContain(`${LABEL_EXCLUSION} sort:created-asc`)
    }
  })
})
