// #140 QA augmentation — the rename, attacked where the dev's specs measure each half
// separately or where the new names are too ordinary for a text sweep to mean anything.
//
// WHAT IS ALREADY COVERED, so this file does not repeat it. labels.test.js pins the names and
// the composed query; labels.parity.test.js pins what each non-JS copy CONTAINS, what it
// WRITES, and sweeps every tracked file for a retired spelling; labels.vocabulary.qa.test.js
// walks templates/ from the filesystem instead of from a table; labels.seam.qa.test.js
// substitutes the module and reads back the argv five consumers hand `gh`.
//
// THE FOUR HOLES THIS FILE FILLS:
//
//   1. STAMP AND EXCLUSION ARE ASSERTED SEPARATELY, NEVER AGAINST EACH OTHER. labels.parity's
//      LABEL_WRITES proves ralph.sh contains `--add-label failed`, and its query block proves
//      ralph.sh contains the composed exclusion. Both would still pass if the two halves named
//      DIFFERENT words — which is the exact failure #139 and #140 exist to make impossible: a
//      loop that stamps a label its own query does not exclude is handed the same issue on
//      every pass, forever, at a paid invocation each time. Nothing read either file and asked
//      whether the word in the stamp is the word in the filter. That question is asked here,
//      per file, over names PARSED OUT OF THE FILE'S OWN TEXT — not out of lib/labels.js, which
//      is the whole point: a test that takes both needles from the module cannot disagree with
//      the module.
//
//   2. A PARTIAL COPY OF THE QUERY IS INVISIBLE. labels.parity asserts README carries the
//      assembled query "verbatim, once" — `split(query)` of length 2. A second copy that is
//      almost the query does not affect that count at all, so a documented filter missing a
//      clause reads as green. That is not hypothetical: see the failing test below.
//
//   3. THE NEW NAMES ARE SHORT, GENERIC WORDS HANDED TO `gh` AND MATCHED IN A JOINED LIST. The
//      retired pair could only ever have been Ralph's; `failed` is a word other people put on
//      their own boards. So `build-failed`, `qa-failed` and `failed-review` are now live inputs
//      to the outcome precedence, and none of them existed as a question before #140.
//
//   4. THE RETIRED SPELLINGS WERE SWEPT AS EXACT SUBSTRINGS. An `includes` of the retired
//      in-progress name misses it capitalised in a heading, and misses one a Markdown reflow
//      wrapped across a line break at the hyphen — both of which are how a retired label name
//      actually survives in prose. And lib/labels.js is exempted from that sweep WHOLESALE, so
//      it is one of the three files allowed to spell a retired name and the only one whose
//      retyped literal would SHIP: the other two are a spec and a changelog. Only the spec and
//      the module spell BOTH retired names; the changelog names just the retired in-progress
//      one, in the single release entry that describes stamping it.
//
// NOTHING IN THIS FILE SPELLS EITHER RETIRED NAME, and that is a requirement rather than a
// style: this file is inside the haystack its own sweep enumerates, so a needle typed here is
// an offender. Every spelling it needs is composed from the keys of LEGACY_LABELS, via
// test/helpers/legacy-label-sweep.js — which is also the honest version of the test, since a
// hand-typed needle can drift from the mapping it claims to be hunting.
//
// Everything here reads bytes off disk or drives a consumer for real. No test in this file
// takes its needle from the module it is checking.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { Volume } from 'memfs'
import { trackedFiles } from '../test/helpers/source-control-bytes.js'
import {
  LEGACY_EXEMPT,
  RETIRED_SPELLING,
  RETIRED_SPELLINGS,
  filesCarryingRetiredSpelling,
  legacyOffenders,
} from '../test/helpers/legacy-label-sweep.js'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { RALPH_HOME } from './paths.js'
import { buildIssueEvent } from './issue-event.js'
import { startCommand } from './commands/start.js'

const read = (file) => readFileSync(join(RALPH_HOME, file), 'utf8')
const relPath = (path) => relative(RALPH_HOME, path).split(sep).join('/')

// ---------------------------------------------------------------------------
// 1. The stamp and the exclusion, asked of each copy in its own words
// ---------------------------------------------------------------------------

// Every label name a file SPENDS, parsed out of the four argv shapes that spend one. Names are
// read from the text rather than looked up, so this file has no opinion about what the labels
// are called — only that one copy's answers agree with the other's.
const namesAfter = (text, pattern) => [
  ...new Set([...text.matchAll(pattern)].map((match) => match[1])),
]

const parseCopy = (file) => {
  const text = read(file)
  return {
    file,
    // `-label:X` — the exclusion clauses, i.e. what the queue REFUSES to hand out.
    excluded: namesAfter(text, /-label:([A-Za-z0-9_-]+)/g),
    // `--add-label X` — the claim, the give-up stamp, the pending-merge swap.
    added: namesAfter(text, /--add-label ([A-Za-z0-9_-]+)/g),
    // `--remove-label X` — the stale-label sweep and both halves of a swap.
    removed: namesAfter(text, /--remove-label ([A-Za-z0-9_-]+)/g),
    // `grep -q ",X,"` — how templates/ralph.sh reads a comma-joined label list back.
    grepped: namesAfter(text, /grep\s+-q\s+",([A-Za-z0-9_-]+),"/g),
  }
}

// The three copies that talk to a GitHub board. Folder mode and Jira mode are absent because
// they issue no label call at all — labels.parity.test.js pins that as a negative.
const BOARD_COPIES = ['templates/ralph.sh', 'templates/prompt-team.md', 'templates/prompt-team-codex.md']

describe('QA #140 — the word a copy STAMPS is the word its own query EXCLUDES', () => {
  const copies = BOARD_COPIES.map(parseCopy)

  it('parses a non-trivial argv out of each board copy — the premise of everything below', () => {
    // Four `for … of []` loops would agree with a rename that deleted the whole mechanism, so
    // the parse is pinned as having found something in every file before anything is compared.
    for (const copy of copies) {
      expect(copy.excluded.length, `${copy.file}: exclusion clauses`).toBeGreaterThanOrEqual(4)
      expect(copy.added.length, `${copy.file}: --add-label calls`).toBeGreaterThanOrEqual(1)
      expect(copy.removed.length, `${copy.file}: --remove-label calls`).toBeGreaterThanOrEqual(1)
    }
    // And the comma-wrapped read-back only exists in the bash loop, which is the only copy that
    // reads a label list rather than issuing a single edit.
    expect(parseCopy('templates/ralph.sh').grepped.length).toBeGreaterThanOrEqual(2)
  })

  it.each(BOARD_COPIES)('%s stamps nothing its own filter fails to exclude', (file) => {
    // THE FAILURE THIS IS ABOUT: a rename that reached the `--add-label` and missed the
    // `-label:` clause (or the reverse) leaves the loop stamping a word the query still lets
    // through. The issue is picked, worked, stamped, and picked again on the next pass — for
    // as long as the run lasts, at one paid agent invocation per pass, with the work already
    // done. Neither half of labels.parity.test.js can see it: one asserts the stamp exists,
    // the other asserts the query exists, and both are true of a half-landed rename.
    const { added, excluded } = parseCopy(file)
    for (const name of added) {
      expect(excluded, `${file}: stamps \`${name}\` but its query does not exclude it`).toContain(
        name,
      )
    }
  })

  it.each(BOARD_COPIES)('%s only ever REMOVES a label its own filter excludes', (file) => {
    // The mirror image, and it is not the same assertion. A removal is only ever a way OUT of
    // the excluded set — the stale-label sweep, or the `in-progress → pending-merge` swap. A
    // `--remove-label` naming a word the query never excluded is a no-op the author believed
    // in, which is how the sweep half of #40 would silently stop working after a rename.
    const { removed, excluded } = parseCopy(file)
    for (const name of removed) {
      expect(excluded, `${file}: removes \`${name}\`, which its query never excluded`).toContain(
        name,
      )
    }
  })

  it('templates/ralph.sh only greps a joined label list for words its own filter excludes', () => {
    // The read-back half: `,failed,` and `,pending-merge,` decide the iteration's verdict. A
    // grep for a word the query does not exclude would be classifying on a label that cannot
    // keep the issue out of the queue — a "failure" the next pass picks up again.
    const { grepped, excluded } = parseCopy('templates/ralph.sh')
    for (const name of grepped) {
      expect(excluded, `ralph.sh greps for \`,${name},\` but does not exclude it`).toContain(name)
    }
  })

  it('and all three copies exclude the SAME set of names, in the same order', () => {
    // Cross-copy, not per-copy: each file could be internally consistent about a different
    // vocabulary. The bash loop and the two prompts run against ONE board, so a prompt that
    // claims with a word the loop's query still returns is the same forever-loop as above,
    // split across two files. Order is included because it is pinned elsewhere and cheaply
    // broken: the JS copy's clause order is fixed byte-for-byte by 43 exec-mock keys — 42 of them
    // whole `gh issue list … | length` command lines — across cycle.test.js (24),
    // test/commands/start.test.js (14), cycle.qa.test.js (4) and status.test.js (1). None of
    // those reads a prompt template; what pins the PROMPTS to the loop is labels.parity.test.js,
    // which asserts each prompt contains the composed LABEL_EXCLUSION and templates/ralph.sh the
    // whole ISSUE_SEARCH_QUERY.
    const [loop, ...prompts] = BOARD_COPIES.map((file) => parseCopy(file).excluded)
    for (const [index, prompt] of prompts.entries()) {
      expect(prompt, BOARD_COPIES[index + 1]).toEqual(loop)
    }
  })

  it('and the label the two prompts CLAIM with is the one the loop sweeps and the orphan sweep hunts', () => {
    // Four copies of one word, in three languages: the prompts' step 2 `--add-label`, the bash
    // sweep's `--remove-label`, and the argv lib/orphan-cleanup.js actually spawns. The last is
    // read from a real call rather than from the source, because orphan-cleanup.js freezes its
    // LIST_ARGS at module load — the one shape where a stale copy is invisible to a source read.
    const claimed = new Set()
    for (const file of ['templates/prompt-team.md', 'templates/prompt-team-codex.md']) {
      const text = read(file)
      // Step 2 of the required sequence: the ONE bare `--add-label` with no `--remove-label`
      // in front of it. The other two writes in these files are swaps.
      const step2 = [...text.matchAll(/(?<!--remove-label \S+ )--add-label ([A-Za-z0-9_-]+)/g)]
      expect(step2.length, `${file}: expected exactly one bare claim`).toBe(1)
      claimed.add(step2[0][1])
    }
    expect(claimed.size, `the two prompts claim with different labels: ${[...claimed]}`).toBe(1)
    const claim = [...claimed][0]

    // The bash sweep: the helper's body, so a rename that missed the definition is caught even
    // if every call site moved.
    const sweep = read('templates/ralph.sh').match(
      /clear_in_progress_label\(\)\s*\{[^}]*--remove-label ([A-Za-z0-9_-]+)/,
    )
    expect(sweep, 'ralph.sh: the sweep helper is not shaped as expected').not.toBeNull()
    expect(sweep[1], 'the bash sweep strips a different label than the prompts claim with').toBe(
      claim,
    )
  })
})

// ---------------------------------------------------------------------------
// 2. A partial copy of the exclusion is a documented filter that does not exist
// ---------------------------------------------------------------------------

// Every maximal run of consecutive `-label:` clauses in a file, as arrays of names.
const exclusionRuns = (text) =>
  [...text.matchAll(/-label:[A-Za-z0-9_-]+(?:\s+-label:[A-Za-z0-9_-]+)*/g)].map((match) =>
    [...match[0].matchAll(/-label:([A-Za-z0-9_-]+)/g)].map((clause) => clause[1]),
  )

describe('QA #140 — no copy of the exclusion is a PARTIAL copy', () => {
  // Prose and templates only. Test files legitimately assert one clause at a time
  // (`expect(query).toContain('-label:do-not-ralph')`), and a single-clause run in prose is a
  // sentence about one label rather than a copy of the filter — so the rule is about runs of
  // TWO OR MORE, which can only be somebody reproducing the query.
  const scope = trackedFiles()
    .map(relPath)
    .filter((file) => file.startsWith('templates/') || /^[^/]+\.md$/.test(file))

  it('finds the canonical run and a real scope to compare against it', () => {
    expect(scope).toContain('README.md')
    expect(scope).toContain('templates/ralph.sh')
    expect(scope.length).toBeGreaterThan(5)
  })

  it('every multi-clause run of `-label:` names the same labels as the loop’s own query', () => {
    // The loop's SEARCH_QUERY is the definition of the filter — it is the string that actually
    // runs — so it is the reference rather than lib/labels.js. A doc that reproduces three of
    // its four clauses tells a user their `pending-merge` issue is eligible when the loop skips
    // it, which is exactly the class of "documented remediation that does nothing" the parity
    // spec's verbatim-copy check exists to prevent and cannot see: an almost-copy leaves the
    // `split(query).toHaveLength(2)` count untouched.
    const canonical = exclusionRuns(read('templates/ralph.sh')).find((run) => run.length > 1)
    expect(canonical, 'ralph.sh no longer contains a multi-clause exclusion').toBeDefined()

    const partial = []
    for (const file of scope) {
      for (const run of exclusionRuns(read(file))) {
        if (run.length < 2) continue
        if (run.join(' ') !== canonical.join(' ')) partial.push(`${file}: ${run.join(' ')}`)
      }
    }
    expect(partial).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. The shape of a short, generic label name
// ---------------------------------------------------------------------------

describe('QA #140 — `failed` and `in-progress` are matched as WHOLE labels, not substrings', () => {
  const verdictOf = (labels, state = 'OPEN') =>
    buildIssueEvent({ issueNumber: 1, runId: 'r', labels, state, ts: '2026-08-30T00:00:00.000Z' })
      .verdict

  it('reads the exact names', () => {
    // The control. Literals rather than imports: a check that read FAILED_LABEL could not
    // disagree with a module that changed it.
    expect(verdictOf(['failed'])).toBe('fail')
    expect(verdictOf(['pending-merge'])).toBe('pass')
    expect(verdictOf(['in-progress'])).toBe('unknown')
    expect(verdictOf([])).toBe('unknown')
  })

  it.each([
    'build-failed',
    'qa-failed',
    'failed-review',
    'failedd',
    'Failed',
    'FAILED',
    ' failed',
    'failed ',
  ])('a board label spelled `%s` is NOT Ralph’s failure label', (label) => {
    // Before #140 this class of input could not exist: no third party names a label after the
    // retired, `claude-`prefixed spelling. `failed` is a word other people use, so a repo that
    // already runs a
    // `build-failed` or `failed-review` label now hands one to the outcome precedence on every
    // iteration — and a verdict of `fail` there would report somebody else's bookkeeping as
    // Ralph having given up, closing the issue out of the queue with the work undone.
    expect(verdictOf([label])).toBe('unknown')
    expect(verdictOf([label], 'CLOSED')).toBe('pass')
  })

  it.each(['pending-merge-later', 'not-pending-merge', 'pending-merged'])(
    'a board label spelled `%s` is NOT Ralph’s rollforward label',
    (label) => {
      expect(verdictOf([label])).toBe('unknown')
    },
  )

  it('finds the real name however the board orders it, and beside a colliding neighbour', () => {
    // Position independence, with a near-miss in the list: the precedence reads an ARRAY, so
    // no anchor can be accidental — but the loop's bash half greps a comma-JOINED string, and
    // these are the label sets that tell the two halves apart (see
    // test/loop.label-shape.qa.test.js for the same cases run through templates/ralph.sh).
    expect(verdictOf(['failed', 'in-progress'])).toBe('fail')
    expect(verdictOf(['in-progress', 'failed'])).toBe('fail')
    expect(verdictOf(['bug', 'failed', 'build-failed'])).toBe('fail')
    expect(verdictOf(['build-failed', 'pending-merge'])).toBe('pass')
    // Precedence unchanged by the rename: failure outranks a closed state.
    expect(verdictOf(['failed'], 'CLOSED')).toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// 4. Ralph never vandalises a label it did not create
// ---------------------------------------------------------------------------

describe('QA #140 — a board that already has an `in-progress` label is not rewritten', () => {
  const runStart = async (labelCreateExit) => {
    const calls = []
    const out = []
    const exec = async (cmd, args = [], options = {}) => {
      calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
      if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
      if (cmd === 'gh' && args[0] === 'label' && args[1] === 'create') {
        // What real `gh` does when the label is already there: non-zero, with a message. It
        // does NOT update the colour or the description, which is why the rename cannot be
        // done for the user and why #141 exists.
        return {
          exitCode: labelCreateExit,
          stdout: '',
          stderr: labelCreateExit === 0 ? '' : 'HTTP 422: Validation Failed (already_exists)',
        }
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { exitCode: 0, stdout: args.includes('--search') ? '3' : '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const result = await startCommand({
      cwd: '/repo',
      stdout: { write: (s) => (out.push(s), true) },
      stderr: { write: () => true },
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
    return { result, calls, stdout: out.join('') }
  }

  it('a `gh label create` that fails because the label EXISTS never becomes an edit', async () => {
    // The epic's criterion, and the one the rename made reachable: the retired in-progress
    // spelling was Ralph's own coinage, so `label create` failing meant a previous Ralph made it.
    // `in-progress` is a label plenty of boards already have, with their own colour and their
    // own description — so the create now collides with somebody else's label on a first run.
    // Ralph must leave it exactly as it found it: no `label edit`, no `--force`, no `--color`
    // on anything but the create it was always allowed to attempt.
    const { result, calls } = await runStart(1)
    const argv = calls.map((c) => c.key).join('\n')
    expect(argv).not.toMatch(/gh label edit/)
    expect(argv).not.toMatch(/--force/)
    expect(argv).not.toMatch(/gh label delete/)
    // ...and the collision is not fatal: every label is still attempted and the run proceeds
    // to the queue count and the launch. A first-run abort on somebody else's label would
    // make Ralph unusable on exactly the boards this rename was meant to suit.
    const creates = calls.filter((c) => c.args[0] === 'label' && c.args[1] === 'create')
    expect(creates).toHaveLength(3)
    for (const create of creates) expect(create.options.reject, create.key).toBe(false)
    expect(calls.some((c) => c.args.includes('--search'))).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it('and the happy path spends the same argv, so the two cases differ only in gh’s answer', async () => {
    const existing = await runStart(1)
    const fresh = await runStart(0)
    const argvOf = ({ calls }) =>
      calls.filter((c) => c.args[0] === 'label').map((c) => c.args.join(' '))
    expect(argvOf(existing)).toEqual(argvOf(fresh))
  })
})

// ---------------------------------------------------------------------------
// 5. The retired spellings cannot hide — beyond an exact substring
// ---------------------------------------------------------------------------

// The exemption list, the matcher and the sweep all come from test/helpers/legacy-label-sweep.js
// — one definition, shared with the acceptance-criterion sweep in lib/labels.parity.test.js. The
// two used to be separate, with two copies of the exemption list and the pattern typed out here;
// that is one fact in two files, in a pair of specs whose subject is a module written to stop
// exactly that. What this file adds on top is not a second list, it is the HARDER QUESTIONS asked
// of the shared one: that the matcher really fires on the variants an exact substring misses, and
// that the exemption list is an exact offender list rather than a skip-list nobody rechecks.
//
// The needles stay independent of any literal — they are composed from LEGACY_LABELS' keys — and
// that is the independence that matters. Independence from the OTHER SWEEP was never worth
// anything: both ask the same question of the same tree, and a wrong answer is wrong twice.

describe('QA #140 — a retired spelling cannot survive a capital letter or a line break', () => {
  it('sweeps a real file list and the pattern really matches the spellings #140 retired', () => {
    // Fail closed on all three ways this could scan nothing: no files, no needles, or a matcher
    // that does not match. The last one matters more now that the pattern is shared — a broken
    // matcher would go vacuous in the parity sweep too, and this is the only test that would
    // notice. Every input below is BUILT from a retired spelling rather than typed, because a
    // literal here would be an offender in the sweep two tests down.
    expect(trackedFiles().length).toBeGreaterThan(200)
    expect(RETIRED_SPELLINGS.length).toBeGreaterThan(0)

    for (const spelling of RETIRED_SPELLINGS) {
      // The spelling itself, and the two variants an `includes` would walk straight past: one
      // capitalised by a heading, one wrapped by a reflow at the hyphen.
      expect(RETIRED_SPELLING.test(spelling), spelling).toBe(true)
      expect(RETIRED_SPELLING.test(spelling.toUpperCase()), 'capitalised').toBe(true)
      expect(RETIRED_SPELLING.test(spelling.replace('-', '-\n  ')), 'wrapped').toBe(true)
      // ...and NOT on the two things that legitimately read like a retired name: an underscore
      // in place of the hyphen is the loop's own agent-exit shell flag, 11 occurrences in
      // templates/ralph.sh, and a space is ordinary English about the agent.
      expect(RETIRED_SPELLING.test(spelling.replace('-', '_')), 'shell flag').toBe(false)
      expect(RETIRED_SPELLING.test(spelling.replace('-', ' ')), 'plain English').toBe(false)
    }
  })

  it('no tracked file outside the mapping, its spec and the CHANGELOG spells one, however cased or wrapped', () => {
    expect(
      legacyOffenders().map(({ file, spelling }) => `${file}: ${JSON.stringify(spelling)}`),
    ).toEqual([])
  })

  it('and the exempt files are exactly the ones that still need to be — no extras', () => {
    // Stated as the exact offender list rather than as a skip-list, so an exemption cannot be
    // widened by adding a file: the assertion names who is allowed to carry a retired spelling,
    // and anything else appearing there is the failure. This is also what would catch a NEW test
    // file that spelled a retired name in its own prose — including this one.
    expect(filesCarryingRetiredSpelling()).toEqual([...LEGACY_EXEMPT].sort())
  })
})

describe('QA #140 — lib/labels.js’s exemption is not a blanket', () => {
  it('spells each retired name exactly once in code, and only as a key of the mapping', () => {
    // The sweep skips this file wholesale, which is correct — the mapping has to name what was
    // retired — but it means a retyped literal HERE is the one place a stale spelling is
    // invisible to it. So each retired word is pinned to exactly one code occurrence, and that
    // occurrence is pinned to the left-hand side of a mapping entry: an `export const` assigning
    // a retired spelling to the in-progress constant would be two occurrences of one name and
    // zero of the other pattern, and go red twice.
    const code = codeWithoutComments(new URL('./labels.js', import.meta.url))
    expect(RETIRED_SPELLINGS.length).toBeGreaterThan(0)
    for (const legacy of RETIRED_SPELLINGS) {
      expect(code.split(legacy).length - 1, legacy).toBe(1)
      expect(code, `${legacy} is not a mapping key`).toMatch(
        new RegExp(`'${legacy}':\\s*[A-Z_]+_LABEL,`),
      )
    }
    // And nothing in the module ASSIGNS a retired name to an exported constant, whatever the
    // quoting: the mapping's values are the current constants, never a literal.
    expect(code).not.toMatch(new RegExp(`=\\s*['"](${RETIRED_SPELLINGS.join('|')})['"]`))
  })
})

// ---------------------------------------------------------------------------
// 6. The two lanes now share spellings — they must not have been wired together
// ---------------------------------------------------------------------------

describe('QA #140 — the Jira and folder lanes still own their own vocabulary', () => {
  it('lib/jira-jql.js imports nothing, so it cannot be reading the GitHub names', async () => {
    // labels.js's header says the identical spellings on both sides are "deliberate and must
    // not be unified". That is a claim about the import graph, so it is asked of the import
    // graph: a later slice that "deduplicated" the two `in-progress` strings would have to add
    // an import here, and this is what stops it — the same property jira-jql.test.js asserts
    // for purity, asserted again for the reason #140 gave it.
    const code = codeWithoutComments(new URL('./jira-jql.js', import.meta.url))
    expect([...code.matchAll(/^import .* from '(.*)'$/gm)]).toEqual([])
    expect(code).not.toContain('labels.js')
  })

  it('lib/folder-queue.js spells its status directories itself and imports no label module', async () => {
    // The folder lane's `in-progress` is a DIRECTORY NAME, and since #140 it is a homograph of
    // a GitHub label. A folder lane that imported IN_PROGRESS_LABEL would rename users'
    // on-disk task directories the next time the label changed — silently losing every task
    // sitting in the old one.
    const code = codeWithoutComments(new URL('./folder-queue.js', import.meta.url))
    expect(code).not.toContain('labels.js')
    expect(code).toContain("'in-progress'")
  })

  it('and the two exclusions are different strings in different query languages', async () => {
    // The collision made "the GitHub assertion passed on a Jira constant" possible. Pinned by
    // comparing the two composed exclusions: same words, and still not interchangeable.
    const { JIRA_LABEL_EXCLUSION } = await import('./jira-jql.js')
    const { LABEL_EXCLUSION } = await import('./labels.js')
    expect(JIRA_LABEL_EXCLUSION).not.toBe(LABEL_EXCLUSION)
    expect(JIRA_LABEL_EXCLUSION).not.toContain('-label:')
    expect(LABEL_EXCLUSION).not.toContain('labels NOT IN')
  })
})
