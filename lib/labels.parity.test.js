// #139 — the mechanism that makes a label literal OUTSIDE JavaScript safe.
//
// lib/labels.js is the single source of truth for JS, and a rename there is one edit. The
// bash loop and the prompt templates cannot import it: templates/ralph.sh spells its own
// SEARCH_QUERY because it runs standalone in tmux, and a prompt template is text an agent
// reads. So those spellings are COPIES, and a copy with nothing checking it is the drift
// this whole refactor exists to prevent — a loop that stamps the renamed label while the
// prompt tells the agent to add the old one is a loop whose queue never drains.
//
// WHAT THIS ASSERTS is the copies, per file: every TEMPLATE that spells a label, plus the two
// prose docs that spell one, must spell the CURRENT name and must not spell any name the
// module marks LEGACY. Today LEGACY_LABELS is empty and this test has no teeth on the negative
// half — #139 renames nothing, deliberately. The wiring, the file table and the reading of the
// module land here; the next slice fills the legacy array and every stale copy goes red at
// once. (The table is not "every non-JS file in the repo": what is in scope is enumerated
// below, and lib/labels.vocabulary.qa.test.js sweeps templates/ from the filesystem so a NEW
// label-bearing template cannot hide from this list.)
//
// THE TABLE IS PER-FILE, NOT BLANKET, because the files genuinely differ: ralph.sh, the two
// PR-flow prompts and README.md carry all four names, while validate-config.md mentions only
// the in-progress one and prompt-team-jira.md / ralph.config.sh / CONTRIBUTING.md only the
// human's `do-not-ralph`. A "all four names in every file" assertion would be false, and a
// test rewritten to pass is a test nobody trusts — so the subset each file actually carries is
// data, and the next slice edits one table.
//
// THE DOCS ARE IN SCOPE, AND CHANGELOG.md IS DELIBERATELY NOT. README.md is where a user reads
// which label to strip by hand and which one keeps Ralph off an issue — 41 mentions across the
// four names (claude-working 17, claude-failed 10, do-not-ralph 10, pending-merge 4) plus one
// verbatim copy of the whole search query — so a rename that skipped it would leave the
// documented remediation instructions doing nothing. CONTRIBUTING.md spells `do-not-ralph`
// 5 times — the Jira lane's restriction, plus the convention section that names this module as
// the only JavaScript allowed to spell a label — and spells no other name, deliberately: that
// section refers to the other three by their EXPORT identifiers precisely because the negative
// half below would go red if it named them. Both docs are text a rename must reach, so both
// are pinned.
// CHANGELOG.md spells `claude-working` once and `pending-merge` once and is EXCLUDED on
// purpose: both live inside shipped release entries (#40 and #130), which describe what a past
// version did. A rename must not rewrite them — the old release really did stamp the old word
// — so a test demanding the current spelling there would be demanding a falsified history.
//
// Prior art: lib/template-parity.test.js — read from disk, assert required structure, rather
// than trusting that an edit to one copy reached the other.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

describe('label parity — every non-JS copy spells the current names (#139)', () => {
  it.each(LABEL_FILES)('$file carries the names it is listed with', ({ file, names }) => {
    const text = read(file)
    for (const name of names) {
      expect(text, `${file} is missing ${name}`).toContain(name)
    }
  })

  it.each(LABEL_FILES)('$file carries no LEGACY name', ({ file }) => {
    const text = read(file)
    for (const legacy of LEGACY_LABELS) {
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
    // The half that makes the per-file subsets honest rather than merely permissive. Without
    // it the table could list one name per file and still pass, and the next slice's rename
    // would sail past every copy it did not happen to mention.
    for (const { file, names } of LABEL_FILES) {
      const text = read(file)
      for (const name of RALPH_LABELS) {
        if (names.includes(name)) continue
        expect(text, `${file} unexpectedly spells ${name} — add it to the table`).not.toContain(name)
      }
    }
  })

  it('templates/prompt-team-folder.md spells no label at all — folder mode has no board', () => {
    // Pinned as a NEGATIVE so its absence from the table above is a measured fact rather
    // than an oversight: folder mode tracks progress with the .ralph/tasks status dirs, so
    // there is no label to stamp and nothing to keep in parity.
    const folder = read('templates/prompt-team-folder.md')
    for (const name of RALPH_LABELS) {
      expect(folder, name).not.toContain(name)
    }
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
