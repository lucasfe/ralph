// #139 QA augmentation — the three properties the dev's specs assert VACUOUSLY or not at all.
//
// 1. FREEZING, as a consequence rather than as `Object.isFrozen`. labels.test.js asks the
//    predicate; this file attempts the mutations a real consumer would make and then RUNS a
//    consumer to show the vocabulary it spends is intact. `Object.isFrozen` is true of an
//    array whose nested objects are wide open, so the shape of the freeze matters, not the
//    flag.
//
// 2. THE LEGACY SET'S TEETH. LEGACY_LABELS is empty today, so every parity assertion that
//    loops over it is vacuously true — `for (const legacy of []) …` is a passing test that
//    checks nothing, and it will stay passing right up until the next slice fills the array
//    and discovers whether the mechanism ever worked. So the same check is exercised here
//    against a SYNTHETIC legacy set over the real template files, and pinned as detecting
//    exactly the files that carry each name. The teeth are measured now instead of assumed.
//
// 3. TABLE DRIFT IN THE DIRECTION NOTHING GUARDS. labels.parity.test.js walks a hardcoded
//    table of seven files and checks each one against disk. That catches a template that
//    LOSES a name. It cannot catch a template that GAINS one, or a NEW template that spells a
//    label and is never added to the table — the table simply does not mention it, and a
//    rename would sail past that copy in silence. This file walks the other way: glob every
//    file under templates/, work out which labels each one carries, and pin the whole map. A
//    new label-bearing template goes red here on the day it lands.
//
// Plus the `do-not-ralph` hole in the dev's code-literal sweep: labels.test.js guards three of
// the four names (GUARDED omits SKIP_LABEL, so jira-jql.js can keep its own copy), which means
// a NEW module hardcoding `do-not-ralph` passes it. Guarded here as an allowlist of exactly
// one known exemption.

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
    expect([...RALPH_LABELS]).toEqual([
      'claude-working',
      'claude-failed',
      'do-not-ralph',
      'pending-merge',
    ])
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
    expect(created).toEqual(['claude-working', 'claude-failed', 'pending-merge'])
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

// The names each template ACTUALLY carries, measured by reading every file in the tree.
const carried = new Map(
  templateFiles().map((path) => [
    rel(path),
    RALPH_LABELS.filter((name) => readFileSync(path, 'utf8').includes(name)),
  ]),
)

// The map as it stands today, measured rather than copied from the issue or from
// labels.parity.test.js's table. Only the files that carry at least one name are listed; every
// other file in the tree must carry none, which is asserted separately below.
const EXPECTED_CARRIED = {
  'ralph.sh': [IN_PROGRESS_LABEL, FAILED_LABEL, SKIP_LABEL, PENDING_MERGE_LABEL],
  'prompt-team.md': [IN_PROGRESS_LABEL, FAILED_LABEL, SKIP_LABEL, PENDING_MERGE_LABEL],
  'prompt-team-codex.md': [IN_PROGRESS_LABEL, FAILED_LABEL, SKIP_LABEL, PENDING_MERGE_LABEL],
  'prompt-team-jira.md': [SKIP_LABEL],
  'ralph.config.sh': [SKIP_LABEL],
  'slash-command.md': [IN_PROGRESS_LABEL],
  'validate-config.md': [IN_PROGRESS_LABEL],
}

describe('QA #139 — the parity table cannot go stale in the direction it does not look', () => {
  it('finds a real templates/ tree to sweep, subdirectories included', async () => {
    // A sweep with an empty haystack passes forever. templates/roles/ is a subdirectory of
    // prompt fragments, so the walk is pinned as having descended into it.
    const all = [...carried.keys()]
    expect(all.length).toBeGreaterThan(10)
    expect(all).toContain('ralph.sh')
    expect(all.some((f) => f.startsWith('roles/'))).toBe(true)
  })

  it('the set of label-bearing template files is EXACTLY the seven known ones', async () => {
    // The assertion labels.parity.test.js cannot make from its own table: a new template that
    // spells `claude-working` — a new prompt variant, a new role fragment, a new config
    // sample — is a copy the next rename would leave behind, and the only thing that notices
    // is a sweep that starts from the filesystem instead of from the list.
    const bearing = [...carried.entries()]
      .filter(([, names]) => names.length > 0)
      .map(([file]) => file)
      .sort()
    expect(bearing).toEqual(Object.keys(EXPECTED_CARRIED).sort())
  })

  it('and each one carries exactly the subset expected of it — no more, no fewer', async () => {
    for (const [file, expected] of Object.entries(EXPECTED_CARRIED)) {
      expect(carried.get(file), file).toEqual(expected)
    }
  })

  it('every other file under templates/ carries no Ralph label at all', async () => {
    // The negative half, over the whole tree rather than over one named file: folder mode's
    // prompt, the digest prompt, the notify sample, the env sample and all five role
    // fragments. Each is a place a label could appear later, and each would be invisible to a
    // per-file table.
    const stray = [...carried.entries()]
      .filter(([file, names]) => names.length > 0 && !(file in EXPECTED_CARRIED))
      .map(([file, names]) => `${file}: ${names.join(', ')}`)
    expect(stray).toEqual([])
    expect(carried.get('prompt-team-folder.md')).toEqual([])
  })
})

// The legacy check, factored out exactly as labels.parity.test.js performs it inline: for each
// listed file, does the text contain any name in the legacy set?
const legacyOffenders = (legacySet) =>
  [...carried.keys()]
    .flatMap((file) => {
      const text = readFileSync(join(TEMPLATES_DIR, file), 'utf8')
      return legacySet.filter((legacy) => text.includes(legacy)).map((legacy) => `${file}: ${legacy}`)
    })
    .sort()

describe('QA #139 — LEGACY_LABELS is empty, so its teeth are proven on a synthetic set', () => {
  it('is genuinely empty today — every parity assertion over it is therefore vacuous', async () => {
    // Stated so the tests below read as what they are: not a duplicate of the dev's legacy
    // assertion, but the only evidence that the assertion does anything.
    expect(LEGACY_LABELS).toEqual([])
    expect(legacyOffenders([...LEGACY_LABELS])).toEqual([])
  })

  it('detects a retired name in a synthetic string, so the matcher itself is not the hole', async () => {
    const synthetic = 'gh issue edit 7 --add-label claude-in-flight  # the old spelling'
    expect(['claude-in-flight'].filter((l) => synthetic.includes(l))).toEqual(['claude-in-flight'])
    expect(['claude-working'].filter((l) => synthetic.includes(l))).toEqual([])
  })

  it('and fires against the REAL templates when a current name is treated as retired', async () => {
    // The strongest available proof short of actually renaming: pretend `claude-working` was
    // retired and confirm the check reports every file that still spells it — the three that
    // do, and no others. When the next slice moves a name into LEGACY_LABELS, this is the
    // machinery that will go red, and it is measured working here.
    expect(legacyOffenders([IN_PROGRESS_LABEL])).toEqual([
      'prompt-team-codex.md: claude-working',
      'prompt-team.md: claude-working',
      'ralph.sh: claude-working',
      'slash-command.md: claude-working',
      'validate-config.md: claude-working',
    ])
    // A name nobody has ever used reports nothing, so the list above is discrimination and
    // not a matcher that says yes to everything.
    expect(legacyOffenders(['ralph-never-used-this-word'])).toEqual([])
  })

  it('a retired name must never also be a current one', async () => {
    // Non-vacuous version of the dev's overlap check: asserted over the union, so it fails if
    // the next slice adds a name to LEGACY_LABELS while leaving it in RALPH_LABELS — which is
    // a rename that did not happen, described as one that did.
    for (const legacy of LEGACY_LABELS) {
      expect(RALPH_LABELS, legacy).not.toContain(legacy)
      expect(MANAGED_LABELS.map((l) => l.name), legacy).not.toContain(legacy)
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
