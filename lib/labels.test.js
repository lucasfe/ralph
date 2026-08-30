// #139 — the spec for Ralph's label vocabulary, next to the module that owns it.
//
// WHAT IS BEING ASSERTED. Ralph's GitHub labels were spelled as literals in six source
// files and seven templates, and the exclusion query that keeps the loop off work already
// in flight was typed out by hand in three commands. Nothing made those spellings agree:
// a loop that stamps one word and excludes another hands the same issue out forever, at a
// paid invocation per pass, having done the work each time. This module is the one place
// in JavaScript a label name is written, and the query is COMPOSED from those names rather
// than retyped beside them — so a rename is one edit and cannot half-land.
//
// THE COMPOSITION IS THE POINT, not the presence. A literal `claude-working` typed into
// the query would satisfy every `toContain` here while leaving the exported name free to
// say something else, which is exactly the drift the module exists to prevent. So the
// query is asserted against a string ASSEMBLED from the exports, and the module's own
// source is read back to confirm each name appears exactly once in code.
//
// PURE, asserted by a static read at the bottom — no clock, no environment, no filesystem
// and no imports at all, like git-remote-slug.js and jira-jql.js next door (#41).

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import {
  FAILED_LABEL,
  IN_PROGRESS_LABEL,
  ISSUE_SEARCH_QUERY,
  LABEL_EXCLUSION,
  LEGACY_LABELS,
  MANAGED_LABELS,
  PENDING_MERGE_LABEL,
  RALPH_LABELS,
  SKIP_LABEL,
} from './labels.js'

const LIB_DIR = new URL('.', import.meta.url).pathname

// The query as it has always read, byte for byte. Pinned as a LITERAL here and nowhere
// else in lib/: this exact string appears 43 times across cycle.test.js (24),
// test/commands/start.test.js (14), cycle.qa.test.js (4) and status.test.js (1) — 42 of them
// as whole `gh issue list … | length` exec-mock keys — and clause ORDER is part of it —
// `gh issue list --search` does not care, but a test that compares whole command lines
// does, so a reordering is a behaviour change as far as the suite is concerned.
const QUERY_TODAY =
  'state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge'

describe('the names (#139)', () => {
  it('spells each of Ralph’s four label names once, as a named export', () => {
    expect(IN_PROGRESS_LABEL).toBe('claude-working')
    expect(FAILED_LABEL).toBe('claude-failed')
    expect(PENDING_MERGE_LABEL).toBe('pending-merge')
    // The one a HUMAN applies, and the only one of the four Ralph never creates: it is a
    // hands-off marker, so a Ralph that created it would be offering to skip its own work.
    expect(SKIP_LABEL).toBe('do-not-ralph')
  })

  it('lists them in RALPH_LABELS in the order the exclusion uses them', () => {
    expect(RALPH_LABELS).toEqual([IN_PROGRESS_LABEL, FAILED_LABEL, SKIP_LABEL, PENDING_MERGE_LABEL])
  })
})

describe('the managed-label specs (#139)', () => {
  it('carries exactly the three labels `ralph start` creates today', () => {
    expect(MANAGED_LABELS.map((l) => l.name)).toEqual([
      IN_PROGRESS_LABEL,
      FAILED_LABEL,
      PENDING_MERGE_LABEL,
    ])
  })

  it('keeps each label’s current colour and English description', () => {
    // Byte-for-byte the three `gh label create` calls start.js made before #139. `gh label
    // create` is idempotent-ish but NOT a no-op on an existing label's description, so a
    // drifted string here would silently rewrite every user's board on the next start.
    expect(MANAGED_LABELS).toEqual([
      { name: 'claude-working', color: 'FFA500', description: 'Ralph loop in progress' },
      { name: 'claude-failed', color: 'B60205', description: 'Ralph loop tried and gave up' },
      {
        name: 'pending-merge',
        color: '0E8A16',
        description: 'Ralph PR merged into staging branch, awaiting rollforward to default',
      },
    ])
  })

  it('does NOT include `do-not-ralph` — Ralph has never created it and must not start', () => {
    expect(MANAGED_LABELS.map((l) => l.name)).not.toContain(SKIP_LABEL)
    expect(MANAGED_LABELS).toHaveLength(3)
  })

  it('gives every spec a name, a 6-hex colour and a non-empty description', () => {
    for (const spec of MANAGED_LABELS) {
      expect(Object.keys(spec), spec.name).toEqual(['name', 'color', 'description'])
      expect(spec.name, spec.name).toMatch(/^[a-z0-9-]+$/)
      expect(spec.color, spec.name).toMatch(/^[0-9A-F]{6}$/)
      expect(spec.description.trim(), spec.name).not.toBe('')
    }
  })

  it('names every managed label from the exported constants, not from a retyped literal', () => {
    // Positional: each spec's `name` must be the very string the constant holds, so a
    // rename of the constant renames the label Ralph creates with no second edit.
    for (const name of [IN_PROGRESS_LABEL, FAILED_LABEL, PENDING_MERGE_LABEL]) {
      expect(MANAGED_LABELS.some((l) => l.name === name), name).toBe(true)
    }
  })
})

describe('the exclusion query (#139)', () => {
  it('is byte-identical to the literal the three commands hardcoded, clause order included', () => {
    expect(ISSUE_SEARCH_QUERY).toBe(QUERY_TODAY)
  })

  it('is COMPOSED from the names rather than written out', () => {
    // The whole query, assembled from the exports. A hardcoded string fails this the moment
    // a name changes — which is the property the next slice's one-line rename depends on.
    expect(ISSUE_SEARCH_QUERY).toBe(
      `state:open -label:${IN_PROGRESS_LABEL} -label:${FAILED_LABEL}` +
        ` -label:${SKIP_LABEL} -label:${PENDING_MERGE_LABEL}`,
    )
    // ...and the exclusion clauses alone, which is the half the templates carry (the
    // prompt templates pass `--state open` as a flag instead of a `state:` term).
    expect(LABEL_EXCLUSION).toBe(
      `-label:${IN_PROGRESS_LABEL} -label:${FAILED_LABEL}` +
        ` -label:${SKIP_LABEL} -label:${PENDING_MERGE_LABEL}`,
    )
    expect(ISSUE_SEARCH_QUERY).toBe(`state:open ${LABEL_EXCLUSION}`)
  })

  it('excludes all four names, one `-label:` clause each and nothing else', () => {
    for (const name of RALPH_LABELS) {
      expect(ISSUE_SEARCH_QUERY, name).toContain(`-label:${name}`)
    }
    expect(ISSUE_SEARCH_QUERY.match(/-label:/g)).toHaveLength(4)
    expect(ISSUE_SEARCH_QUERY.startsWith('state:open ')).toBe(true)
  })

  it('is derived, not stored: the source holds no copy of the assembled query', () => {
    // The composition property, asserted where hardcoding would hide — a module that
    // returned the right string from a literal passes every assertion above.
    const code = codeWithoutComments(new URL('./labels.js', import.meta.url))
    expect(code).not.toContain(QUERY_TODAY)
    expect(code).not.toContain(`-label:${IN_PROGRESS_LABEL}`)
  })
})

describe('the legacy set (#139)', () => {
  it('is empty today — this slice renames nothing', () => {
    // #139 is a deliberate no-op in behaviour: the mechanism lands, the words do not move.
    // The parity test's teeth arrive when the next slice fills this array, and an entry here
    // is a promise that the old spelling is gone from every template.
    expect(LEGACY_LABELS).toEqual([])
  })

  it('never overlaps the current names', () => {
    for (const legacy of LEGACY_LABELS) {
      expect(RALPH_LABELS, legacy).not.toContain(legacy)
    }
  })
})

// ---------------------------------------------------------------------------
// Single source of truth — the acceptance criterion, as a guard
// ---------------------------------------------------------------------------
//
// The criterion is "a grep for `claude-working` across lib/ returns only the module's own
// definition". Asserted rather than merely done, because the failure is silent: a new
// command that types the word instead of importing it works perfectly until the rename,
// and then works perfectly against the wrong label.
//
// COMMENTS ARE OUT OF THE HAYSTACK, and that is a decision rather than a convenience.
// agent-registry.js, cycle.js and issue-event.js all EXPLAIN a label mechanism in prose,
// and prose that named the constant instead of the label would be worse writing to satisfy
// a grep. codeWithoutComments is the same haystack every purity spec in lib/ uses.
//
// `do-not-ralph` IS NOT IN THIS GUARD, on purpose. jira-jql.js composes it into
// JIRA_LABEL_EXCLUSION as a code literal and cannot import it from here: its own spec
// (jira-jql.test.js, "reads no clock, no environment and no filesystem — and imports
// nothing") pins that module at zero imports, and #139 may not edit an existing test.
// So the guard covers the three GitHub-only names, and the Jira-side spelling stays where
// its own spec put it.
const GUARDED = [IN_PROGRESS_LABEL, FAILED_LABEL, PENDING_MERGE_LABEL]

function sourceFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__fixtures__') continue
      found.push(...sourceFiles(path))
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    if (entry.name.endsWith('.test.js')) continue
    found.push(path)
  }
  return found
}

describe('lib/labels.js is the only JavaScript that spells a Ralph label (#139)', () => {
  const files = sourceFiles(LIB_DIR).filter((f) => !f.endsWith('labels.js'))

  it('finds a non-trivial set of lib/ sources to sweep', () => {
    // A guard whose haystack is empty passes forever. jira-jql.js is one of the files it
    // must actually read, so the sweep is pinned as having found it.
    expect(files.length).toBeGreaterThan(40)
    expect(files.some((f) => f.endsWith('jira-jql.js'))).toBe(true)
    expect(files.some((f) => f.endsWith(join('commands', 'start.js')))).toBe(true)
  })

  it('no other source file in lib/ carries one as a code literal', () => {
    const offenders = []
    for (const file of files) {
      const code = codeWithoutComments(file)
      for (const name of GUARDED) {
        if (code.includes(name)) offenders.push(`${file}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('and labels.js itself spells each name exactly once', () => {
    const code = codeWithoutComments(new URL('./labels.js', import.meta.url))
    for (const name of [...GUARDED, SKIP_LABEL]) {
      expect(code.split(name).length - 1, name).toBe(1)
    }
  })
})

describe('labels — purity', () => {
  it('reads no clock, no environment and no filesystem — and imports nothing', () => {
    // Values and composed strings only. Nothing here needs a seam, so nothing here has one:
    // the whole module is answerable by reading it, which is what lets every consumer above
    // import it without dragging a dependency along.
    const code = codeWithoutComments(new URL('./labels.js', import.meta.url))
    expect(code).not.toMatch(/\bprocess\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/node:(fs|os|path|child_process|tty)/)
    expect([...code.matchAll(/^import .* from '(.*)'$/gm)]).toEqual([])
  })

  it('freezes what it hands out, so a consumer cannot rewrite the vocabulary', () => {
    // A module-level array every command imports is shared mutable state; one `.push` in a
    // consumer (or a test) would change the label set for the whole process.
    expect(Object.isFrozen(MANAGED_LABELS)).toBe(true)
    expect(Object.isFrozen(RALPH_LABELS)).toBe(true)
    expect(Object.isFrozen(LEGACY_LABELS)).toBe(true)
    for (const spec of MANAGED_LABELS) expect(Object.isFrozen(spec), spec.name).toBe(true)
  })

  it('ships in the published package, and its spec does not', () => {
    // Read off package.json's `files` rather than off the filesystem: the module being present
    // in a checkout says nothing about the tarball. `lib` is listed, so labels.js ships with
    // the commands that import it; `!**/*.test.js` is listed, so this file and the parity spec
    // beside it do not. A packaging change that dropped either half — an npm-installed ralph
    // whose commands import a missing module, or one that shipped vitest specs to users —
    // fails here rather than at a user's first `ralph start`.
    const pkg = JSON.parse(readFileSync(join(LIB_DIR, '..', 'package.json'), 'utf8'))
    expect(pkg.files).toContain('lib')
    expect(pkg.files).toContain('!**/*.test.js')
  })
})
