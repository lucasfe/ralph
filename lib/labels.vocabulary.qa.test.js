// #139 QA augmentation — the three properties the dev's specs assert VACUOUSLY or not at all.
//
// 1. FREEZING, as a consequence rather than as `Object.isFrozen`. labels.test.js asks the
//    predicate; this file attempts the mutations a real consumer would make and then RUNS a
//    consumer to show the vocabulary it spends is intact. `Object.isFrozen` is true of an
//    array whose nested objects are wide open, so the shape of the freeze matters, not the
//    flag.
//
// 2. THE LEGACY MAPPING'S TEETH. This was written when LEGACY_LABELS was empty and every
//    parity assertion that looped over it was vacuously true — `for (const legacy of []) …` is
//    a passing test that checks nothing — so the teeth were proven on a SYNTHETIC legacy set
//    instead. #140 is the slice that filled the mapping, so the same checks now run against the
//    REAL retired spellings and the synthetic scaffolding is gone: the sweep over templates/
//    reports nothing because the rename reached every one of them, which is a fact rather than
//    a vacuum. The discrimination half stayed — a matcher that reports nothing is worth nothing
//    unless it can be shown reporting something.
//
// 3. TABLE DRIFT IN THE DIRECTION NOTHING GUARDS. labels.parity.test.js walks a hardcoded
//    table of nine files and checks each one against disk. That catches a template that
//    LOSES a name. It cannot catch a template that GAINS one, or a NEW template that spells a
//    label and is never added to the table — the table simply does not mention it, and a
//    rename would sail past that copy in silence. This file walks the other way: glob every
//    file under templates/, work out which labels each one carries, and pin the whole map. A
//    new label-bearing template goes red here on the day it lands.
//
//    ASKED TWO WAYS SINCE #140, because "the file contains the word" stopped being the same
//    question as "the file spells a label". The renamed labels are `in-progress` and `failed`,
//    and templates/ is full of both for other reasons: the folder lane's four status
//    directories, the Jira lane's own board labels in ralph.config.sh's JQL comment, three role
//    fragments that use "failed" as English, and a notify sample documenting a `"failed"` status
//    string. A bare-substring sweep over all four names now reports 12 of the tree's files, so
//    pinning that list would pin the collision rather than the labels. So the map is measured
//    over LABEL-SHAPED occurrences — the name next to the `gh` flag or `-label:` clause that
//    issues it — and a second, bare-substring map is kept for the two names that are still
//    Ralph's own coinages, where mere mention is still evidence.
//
// Plus the `do-not-ralph` hole in the dev's code-literal sweep: labels.test.js guards one of
// the four names as a code literal (its GUARDED set — see the long note there for why #140 cost
// it the other two, and why SKIP_LABEL was never in it), which means a NEW module hardcoding
// `do-not-ralph` passes it. Guarded here as an allowlist of exactly one known exemption.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { TEMPLATES_DIR } from './paths.js'
import {
  FAILED_LABEL,
  IN_PROGRESS_LABEL,
  LEGACY_LABELS,
  MANAGED_LABELS,
  PENDING_MERGE_LABEL,
  RALPH_LABELS,
  SKIP_LABEL,
} from './labels.js'

const LIB_DIR = new URL('.', import.meta.url).pathname
const REPO_DIR = join(LIB_DIR, '..')

// ---------------------------------------------------------------------------
// 1. Freezing — the mutation a consumer would actually attempt
// ---------------------------------------------------------------------------

describe('QA #139 — the exported vocabulary cannot be poisoned by a consumer', () => {
  it('refuses a push, a splice, a sort and an index write on RALPH_LABELS', async () => {
    // ESM is strict mode, so a write to a frozen array THROWS rather than silently failing —
    // which is the behaviour worth pinning: a consumer that tried would find out at the call
    // rather than by handing every other consumer a different label set.
    expect(() => RALPH_LABELS.push('qa-injected')).toThrow(TypeError)
    expect(() => RALPH_LABELS.splice(0, 1)).toThrow(TypeError)
    expect(() => RALPH_LABELS.sort()).toThrow(TypeError)
    expect(() => {
      RALPH_LABELS[0] = 'qa-injected'
    }).toThrow(TypeError)
    // Unchanged afterwards, in the original order.
    expect([...RALPH_LABELS]).toEqual(['in-progress', 'failed', 'do-not-ralph', 'pending-merge'])
  })

  it('refuses a write to a managed spec’s name, colour or description — the DEEP half', async () => {
    // `Object.freeze` on the outer array leaves the spec objects mutable, and a spec object is
    // where the damage is: `MANAGED_LABELS[0].description = '…'` would rewrite the description
    // `gh label create` publishes to every board on the next `ralph start`.
    for (const key of ['name', 'color', 'description']) {
      expect(() => {
        MANAGED_LABELS[0][key] = 'qa-injected'
      }, key).toThrow(TypeError)
    }
    expect(() => {
      MANAGED_LABELS[0].extra = 'qa-injected'
    }).toThrow(TypeError)
    expect(() => delete MANAGED_LABELS[0].name).toThrow(TypeError)
    expect(() => MANAGED_LABELS.push({ name: 'qa-injected', color: 'FFFFFF', description: 'x' })).toThrow(
      TypeError,
    )
  })

  it('and a consumer run AFTER those attempts still spends the real vocabulary', async () => {
    // The poisoning scenario end to end: one importer tries to mutate, another importer runs.
    // Module state is shared per worker, so a successful mutation above would show up here as
    // a fourth `gh label create` or a renamed one — which is precisely the cross-consumer
    // failure a module-level mutable array invites.
    const { startCommand } = await import('./commands/start.js')
    const { Volume } = await import('memfs')
    const calls = []
    const exec = async (cmd, args = [], options = {}) => {
      calls.push({ cmd, args, options })
      if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { exitCode: 0, stdout: args.includes('--search') ? '0' : '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const sink = { write: () => true }
    await startCommand({
      cwd: '/repo',
      stdout: sink,
      stderr: sink,
      exec,
      exists: () => false,
      loadEnv: () => ({}),
      hasCommand: () => true,
      ask: async () => true,
      update: async () => ({
        latestVersion: null,
        isNewer: false,
        shouldPrompt: false,
        source: 'disabled',
        updatedCache: null,
      }),
      sendWa: async () => ({ ok: true }),
      peekLock: () => null,
      home: '/home/me',
      processEnv: { RALPH_BANNER: 'off' },
      cacheFs: new Volume(),
    })
    const created = calls
      .filter((c) => c.cmd === 'gh' && c.args[0] === 'label' && c.args[1] === 'create')
      .map((c) => c.args[2])
    expect(created).toEqual(['in-progress', 'failed', 'pending-merge'])
    expect(created).not.toContain('qa-injected')
  })
})

describe('QA #139 — the MANAGED / RALPH boundary as set arithmetic', () => {
  it('holds no duplicate name, in either array', async () => {
    // A duplicate in RALPH_LABELS would emit the same `-label:` clause twice — harmless to gh,
    // and a silent mismatch against the 42 whole-command-line exec-mock keys in the suite that
    // spell the assembled query out in full (counted across cycle.test.js, cycle.qa.test.js and
    // test/commands/start.test.js).
    expect(new Set(RALPH_LABELS).size).toBe(RALPH_LABELS.length)
    const names = MANAGED_LABELS.map((l) => l.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('is exactly: every excluded name is created, except the one a HUMAN writes', async () => {
    const created = new Set(MANAGED_LABELS.map((l) => l.name))
    const excludeOnly = RALPH_LABELS.filter((name) => !created.has(name))
    // Stated as an equality rather than a `not.toContain`: it says both that `do-not-ralph` is
    // never created AND that nothing else is exclude-only, so a future label added to the
    // exclusion without a spec — the shape that makes the loop skip work nothing ever created
    // — cannot land unnoticed.
    expect(excludeOnly).toEqual([SKIP_LABEL])
    for (const name of created) expect(RALPH_LABELS, name).toContain(name)
  })

  it('has no managed spec whose name is SKIP_LABEL, however the array is reordered', async () => {
    for (const spec of MANAGED_LABELS) expect(spec.name, spec.name).not.toBe(SKIP_LABEL)
  })
})

// ---------------------------------------------------------------------------
// 2 + 3. The non-JS copies: what carries a label, and whether legacy detection works
// ---------------------------------------------------------------------------

// Every file under templates/, relative to it, with posix separators so the expectations below
// read the same on any platform.
function templateFiles(dir = TEMPLATES_DIR) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...templateFiles(path))
      continue
    }
    found.push(path)
  }
  return found
}

const rel = (path) => relative(TEMPLATES_DIR, path).split(sep).join('/')

// Every way a template can WRITE a label: the `gh` flags that add or remove one, the `-label:`
// clause that excludes one, and the comma-wrapped form templates/ralph.sh greps a joined label
// list with. Anything else — a name in prose, a status directory, an English adjective — is a
// mention and not a write, which is the distinction #140 forced (see the header).
const writeShapes = (name) => [
  `--add-label ${name}`,
  `--remove-label ${name}`,
  `--label ${name}`,
  `-label:${name}`,
  `,${name},`,
]

// The names each template WRITES, measured by reading every file in the tree.
const writes = new Map(
  templateFiles().map((path) => {
    const text = readFileSync(path, 'utf8')
    return [rel(path), RALPH_LABELS.filter((name) => writeShapes(name).some((s) => text.includes(s)))]
  }),
)

// The map as it stands today, measured rather than copied from the issue or from
// labels.parity.test.js's table. Only the files that write at least one name are listed; every
// other file in the tree must write none, which is asserted separately below. Three files, and
// they are the three that talk to a board: the loop and the two PR-flow orchestrators. Each
// writes all four names — the three it stamps or reads, plus the human's one in its exclusion.
const EXPECTED_WRITES = {
  'ralph.sh': [IN_PROGRESS_LABEL, FAILED_LABEL, SKIP_LABEL, PENDING_MERGE_LABEL],
  'prompt-team.md': [IN_PROGRESS_LABEL, FAILED_LABEL, SKIP_LABEL, PENDING_MERGE_LABEL],
  'prompt-team-codex.md': [IN_PROGRESS_LABEL, FAILED_LABEL, SKIP_LABEL, PENDING_MERGE_LABEL],
}

// The second question, for the two names #140 left unambiguous. `do-not-ralph` and
// `pending-merge` are Ralph's coinages and nothing else in templates/ has a use for either, so
// a bare mention of one still means a label is being described — which catches the prose copy a
// write-shaped sweep cannot see, such as prompt-team-jira.md telling the agent which ticket
// label means hands off. Derived by subtraction from RALPH_LABELS so a third rename cannot leave
// a stale word here; the same set labels.parity.test.js scopes its negative half to.
const DISTINCTIVE_NAMES = RALPH_LABELS.filter(
  (name) => name !== IN_PROGRESS_LABEL && name !== FAILED_LABEL,
)

const mentions = new Map(
  templateFiles().map((path) => {
    const text = readFileSync(path, 'utf8')
    return [rel(path), DISTINCTIVE_NAMES.filter((name) => text.includes(name))]
  }),
)

const EXPECTED_MENTIONS = {
  'ralph.sh': [SKIP_LABEL, PENDING_MERGE_LABEL],
  'prompt-team.md': [SKIP_LABEL, PENDING_MERGE_LABEL],
  'prompt-team-codex.md': [SKIP_LABEL, PENDING_MERGE_LABEL],
  // Jira mode keeps its own vocabulary (lib/jira-jql.js), so the hands-off label a HUMAN
  // applies is the only one it shares — described to the agent, never written by it.
  'prompt-team-jira.md': [SKIP_LABEL],
  // ...and the config template documents that same exclusion in its JIRA_JQL comment.
  'ralph.config.sh': [SKIP_LABEL],
}

describe('QA #139 — the parity table cannot go stale in the direction it does not look', () => {
  it('finds a real templates/ tree to sweep, subdirectories included', async () => {
    // A sweep with an empty haystack passes forever. templates/roles/ is a subdirectory of
    // prompt fragments, so the walk is pinned as having descended into it.
    const all = [...writes.keys()]
    expect(all.length).toBeGreaterThan(10)
    expect(all).toContain('ralph.sh')
    expect(all.some((f) => f.startsWith('roles/'))).toBe(true)
    // And both needles must still be asking about something.
    expect(DISTINCTIVE_NAMES.length).toBeGreaterThan(0)
    expect(writeShapes('x').length).toBeGreaterThan(1)
  })

  it('the set of template files that WRITE a label is EXACTLY the three known ones', async () => {
    // The assertion labels.parity.test.js cannot make from its own table: a new template that
    // stamps a label — a new prompt variant, a new role fragment, a new config sample — is a
    // copy the next rename would leave behind, and the only thing that notices is a sweep that
    // starts from the filesystem instead of from the list.
    const bearing = [...writes.entries()]
      .filter(([, names]) => names.length > 0)
      .map(([file]) => file)
      .sort()
    expect(bearing).toEqual(Object.keys(EXPECTED_WRITES).sort())
  })

  it('and each one writes exactly the subset expected of it — no more, no fewer', async () => {
    for (const [file, expected] of Object.entries(EXPECTED_WRITES)) {
      expect(writes.get(file), file).toEqual(expected)
    }
  })

  it('every other file under templates/ writes no Ralph label at all', async () => {
    // The negative half, over the whole tree rather than over one named file: folder mode's
    // prompt, the Jira prompt, the digest prompt, the notify sample, the env sample and all five
    // role fragments. Each is a place a label could appear later, and each would be invisible to
    // a per-file table.
    const stray = [...writes.entries()]
      .filter(([file, names]) => names.length > 0 && !(file in EXPECTED_WRITES))
      .map(([file, names]) => `${file}: ${names.join(', ')}`)
    expect(stray).toEqual([])
    // Folder mode named explicitly, because it is the one template that LOOKS like it should be
    // on the list: it tracks the same four states, but as `.ralph/tasks/afk/…` directories on
    // disk. Since #140 two of those directory names are homographs of two Ralph labels, so
    // "writes none" is the only version of this claim that is still true — and it is the whole
    // acceptance criterion "folder mode is unaffected", asked of the template itself.
    expect(writes.get('prompt-team-folder.md')).toEqual([])
  })

  it('and the two names still unique to Ralph appear only in the files that mean them', async () => {
    // The half a write-shaped needle gives up: `do-not-ralph` in prose is a real copy of a real
    // label, and prompt-team-jira.md carries one. Pinned as an exact map for the same reason as
    // the writes above — a new template that mentions either coinage has to be argued for here.
    const bearing = Object.fromEntries(
      [...mentions.entries()].filter(([, names]) => names.length > 0),
    )
    expect(bearing).toEqual(EXPECTED_MENTIONS)
    expect(mentions.get('prompt-team-folder.md')).toEqual([])
  })
})

// The legacy check, factored out exactly as labels.parity.test.js performs it inline: for each
// file in the tree, does the text contain any name in the legacy set?
const legacyOffenders = (legacySet) =>
  [...writes.keys()]
    .flatMap((file) => {
      const text = readFileSync(join(TEMPLATES_DIR, file), 'utf8')
      return legacySet.filter((legacy) => text.includes(legacy)).map((legacy) => `${file}: ${legacy}`)
    })
    .sort()

describe('QA #140 — LEGACY_LABELS has a real set now, and the sweep is run against it', () => {
  it('is no longer empty, so every parity assertion over it does something', async () => {
    // The premise the rest of this describe rests on, and the one thing that changed with #140:
    // while the mapping was empty, `for (const legacy of []) …` was a passing test that checked
    // nothing, in every file that loops it. Asserted as a COUNT rather than as contents —
    // labels.test.js pins which names and what they map to; this only needs the loop to run.
    expect(Object.keys(LEGACY_LABELS).length).toBeGreaterThan(0)
  })

  it('reports nothing across the whole templates/ tree — the rename reached all of it', async () => {
    // Now a measurement rather than a vacuum: every file under templates/, including the four
    // orchestrator prompts, the role fragments and both samples, read for both retired
    // spellings. The repo-wide version of this — every file `git ls-files` reports, not just
    // templates/ — is in labels.parity.test.js; this one is here because it shares the tree walk
    // above and so also covers a template nobody has added to any table.
    expect(legacyOffenders(Object.keys(LEGACY_LABELS))).toEqual([])
  })

  it('detects a retired name in a synthetic string, so the matcher itself is not the hole', async () => {
    // A green sweep is worth nothing unless the matcher can be shown reporting something. Both
    // needles here are names Ralph has never used, so neither can collide with a real one.
    const synthetic = 'gh issue edit 7 --add-label qa-retired-spelling  # the old one'
    expect(['qa-retired-spelling'].filter((l) => synthetic.includes(l))).toEqual([
      'qa-retired-spelling',
    ])
    expect(['qa-never-used-this-word'].filter((l) => synthetic.includes(l))).toEqual([])
  })

  it('and fires against the REAL templates when a current name is treated as retired', async () => {
    // The same machinery pointed at a name that IS in the tree: pretend `pending-merge` had been
    // retired and confirm the sweep names every file that still spells it — the three that do,
    // and no others. That is the shape of the failure #140 would have produced had it missed a
    // template, demonstrated on a green tree.
    //
    // `pending-merge` and not one of the two renamed names, because after #140 pretending
    // `failed` was retired reports 10 files — the folder and Jira prompts, ralph.config.sh's JQL
    // comment, the notify sample and three role fragments' English among them — and a list like
    // that measures the collision rather than the matcher. See this file's header.
    expect(legacyOffenders([PENDING_MERGE_LABEL])).toEqual([
      'prompt-team-codex.md: pending-merge',
      'prompt-team.md: pending-merge',
      'ralph.sh: pending-merge',
    ])
    // A name nobody has ever used reports nothing, so the list above is discrimination and
    // not a matcher that says yes to everything.
    expect(legacyOffenders(['ralph-never-used-this-word'])).toEqual([])
  })

  it('a retired name must never also be a current one', async () => {
    // Non-vacuous since #140: asserted over the mapping's keys, so it fails if a future rename
    // records a name as retired while leaving it in RALPH_LABELS — a rename that did not happen,
    // described as one that did.
    for (const legacy of Object.keys(LEGACY_LABELS)) {
      expect(RALPH_LABELS, legacy).not.toContain(legacy)
      expect(MANAGED_LABELS.map((l) => l.name), legacy).not.toContain(legacy)
    }
  })

  it('and every replacement it points at is a name the module still hands out', async () => {
    // The other end of each pair, which only exists because #140 made LEGACY_LABELS a MAP: a
    // migration that told a user to rename their board's issues to a label Ralph does not
    // recognise would be worse than no migration at all.
    for (const [legacy, current] of Object.entries(LEGACY_LABELS)) {
      expect(RALPH_LABELS, `${legacy} → ${current}`).toContain(current)
    }
  })
})

// ---------------------------------------------------------------------------
// The `do-not-ralph` hole in the dev's code-literal sweep
// ---------------------------------------------------------------------------

function jsSources(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__fixtures__' || entry.name === 'node_modules') continue
      found.push(...jsSources(path))
      continue
    }
    if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue
    found.push(path)
  }
  return found
}

describe('QA #139 — `do-not-ralph` as a code literal: one exemption, allowlisted', () => {
  it('appears in exactly one file besides labels.js — lib/jira-jql.js, and by name', async () => {
    // labels.test.js's GUARDED set is the three GitHub-only names, so the fourth is
    // unguarded: a new module could hardcode `do-not-ralph` and the dev's sweep would agree.
    // Pinned as an ALLOWLIST rather than skipped, so the exemption stays at one file and the
    // next `do-not-ralph` literal has to be argued for.
    const offenders = []
    for (const file of [...jsSources(LIB_DIR), ...jsSources(join(REPO_DIR, 'bin')), ...jsSources(join(REPO_DIR, 'scripts'))]) {
      if (file.endsWith(join('lib', 'labels.js'))) continue
      if (codeWithoutComments(file).includes(SKIP_LABEL)) offenders.push(rel2(file))
    }
    expect(offenders).toEqual(['lib/jira-jql.js'])
  })

  it('no JavaScript outside lib/ spells any Ralph label as a code literal', async () => {
    // bin/ and scripts/ are the two JS trees labels.test.js's sweep never looks at. Empty
    // today; asserted so a CLI entry point that grew a label literal is caught by the module's
    // own suite rather than by a rename that half-lands.
    const offenders = []
    for (const file of [...jsSources(join(REPO_DIR, 'bin')), ...jsSources(join(REPO_DIR, 'scripts'))]) {
      const code = codeWithoutComments(file)
      for (const name of RALPH_LABELS) {
        if (code.includes(name)) offenders.push(`${rel2(file)}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

function rel2(path) {
  return relative(REPO_DIR, path).split(sep).join('/')
}
