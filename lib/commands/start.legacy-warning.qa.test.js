// #141 QA augmentation — where step 7b sits in the run, and what it costs when the rest of the
// preflight is going wrong around it.
//
// The dev's six integration tests in test/commands/start.test.js drive the warning through a
// clean preflight: legacy present, legacy absent, both present, the list failing, nothing renamed
// by Ralph itself, folder mode silent. Five of the six run with steps 6, 7 and 8 all succeeding —
// the sixth is the folder-mode one, where 6 and 7 are inside the github-only block and so never
// run at all, and where the only failure any of the six injects is the list at 7b. What that
// leaves untested
// is the interaction, which is the whole of what a step 7b can get wrong:
//
// 1. POSITION. The warning has to land after the creates (so the destination it names exists),
//    after the orphan notice (they are read together), and BEFORE the empty-queue early return
//    at step 8 — a board with a retired label on its live issues is exactly a board whose
//    current-name queue can read as empty, so a warning printed after that return would never
//    reach the user who most needs it.
//
// 2. INDEPENDENCE. A failing orphan sweep, three failing `gh label create` calls, an empty
//    queue and a gh that is not installed at all must each leave the warning's own outcome
//    alone, in both directions: printed when it should be, silent when it should be, and never
//    the thing that ends the run.
//
// 3. THE CALL, not the line. Folder mode is asserted here as ZERO `gh label` calls of any verb
//    in the whole run — a folder run that asked gh anyway would be a silent network round trip
//    on the one source that never needs gh, and no assertion about output could see it. Same
//    posture for `label edit`: pinned as the absence of the CALL across every case below, since
//    "Ralph never migrates on your behalf" is a claim about what leaves the process.
//
// 4. THE ONE SEQUENCING CONSEQUENCE NOBODY LOOKED AT. The user #141 is written for is the user
//    who just upgraded — and if they upgraded THROUGH this command's own update gate, that run
//    returns at step 2.5, with steps 3 through 7 in between it and the check. Measured below:
//    their first sight of the warning is their SECOND `ralph start`. That is not a defect, but
//    it is load-bearing for
//    anyone who later moves the gate or the check.
//
// THE RETIRED SPELLINGS ARE COMPOSED FROM Object.keys(LEGACY_LABELS) AND NEVER TYPED — this file
// is tracked, and lib/labels.parity.test.js and lib/labels.rename.qa.test.js sweep every tracked
// file outside test/helpers/legacy-label-sweep.js's exemption list for them, case-insensitively.
//
// The harness is the one in start.labels-argv.qa.test.js next door, extended with a label listing
// the tests control and an options-recording exec, because test/commands/start.test.js's `makeExec`
// takes `(cmd, args)` only and so cannot see the `{ reject: false }` the check is supposed to
// pass.

import { describe, expect, it } from 'vitest'
import { Volume } from 'memfs'
import { startCommand } from './start.js'
import { LEGACY_LABELS } from '../labels.js'

const REPO = '/repo'
const HOME = '/home/me'

const RETIRED = Object.freeze(Object.keys(LEGACY_LABELS))

// `gh label list --json name` answers with objects, not bare names.
const listing = (...names) => JSON.stringify(names.map((name) => ({ name })))

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
  }
}

// Whole argv and options recorded, so the check's `{ reject: false }` and the ORDER of the
// preflight's calls are both observable. Each of the four gh steps is answerable independently —
// the three `label create` WRITES at step 6 (one per MANAGED_LABELS entry, all keyed off the one
// `createExit`), then the three reads at 7, 7b and 8 — and `labelList` may be a function so a
// throwing gh is reachable.
function makeExec({
  queue = '1',
  orphans = '',
  orphanExit = 0,
  createExit = 0,
  labelList = { exitCode: 0, stdout: '[]', stderr: '' },
} = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'label' && args[1] === 'list') {
      return typeof labelList === 'function' ? labelList() : labelList
    }
    if (cmd === 'gh' && args[0] === 'label' && args[1] === 'create') {
      return { exitCode: createExit, stdout: '', stderr: createExit === 0 ? '' : 'HTTP 422' }
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      if (args.includes('--search')) return { exitCode: 0, stdout: queue, stderr: '' }
      return { exitCode: orphanExit, stdout: orphans, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  exec.keys = () => calls.map((call) => call.key)
  return exec
}

const NO_UPDATE = {
  latestVersion: null,
  isNewer: false,
  shouldPrompt: false,
  source: 'disabled',
  updatedCache: null,
}

const baseDeps = (overrides = {}) => ({
  cwd: REPO,
  stdout: makeStream(),
  stderr: makeStream(),
  exec: makeExec(),
  exists: () => false,
  loadEnv: () => ({}),
  hasCommand: () => true,
  ask: async () => true,
  update: async () => NO_UPDATE,
  sendWa: async () => ({ ok: true }),
  peekLock: () => null,
  home: HOME,
  processEnv: { RALPH_BANNER: 'off' },
  cacheFs: new Volume(),
  ...overrides,
})

const labelCalls = (exec, verb) =>
  exec.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'label' && c.args[1] === verb)

const WARNING = (legacy) => `⚠️  Retired label '${legacy}' still exists on this board`

describe('QA #141 — step 7b against the rest of the preflight', () => {
  it('warns even when the ORPHAN sweep itself failed', async () => {
    // The two notices are adjacent and independent. This is also the case where the warning is
    // worth the most: the orphan sweep lists the CURRENT in-progress name, so on an unmigrated
    // board it reports nothing whether it succeeded or not, and the migration warning is the
    // only line that explains why.
    const deps = baseDeps({
      exec: makeExec({ orphanExit: 1, labelList: { exitCode: 0, stdout: listing(RETIRED[0]) } }),
    })
    const result = await startCommand(deps)
    expect(deps.stdout.output()).toContain(WARNING(RETIRED[0]))
    expect(result.started).toBe(true)
  })

  it('warns even when every `gh label create` failed', async () => {
    // Step 6 exits non-zero on a label that already exists, which is the NORMAL case on any
    // board `ralph start` has run on before — and the board this warning is about is by
    // definition an old one. A step 7b that only ran after a clean step 6 would be silent on
    // every repository it was written for.
    const deps = baseDeps({
      exec: makeExec({ createExit: 1, labelList: { exitCode: 0, stdout: listing(...RETIRED) } }),
    })
    const result = await startCommand(deps)
    for (const legacy of RETIRED) expect(deps.stdout.output()).toContain(WARNING(legacy))
    expect(labelCalls(deps.exec, 'create')).toHaveLength(3)
    expect(result.started).toBe(true)
  })

  it('warns BEFORE the empty-queue early return, so the run that needs it most still sees it', async () => {
    // The scenario, in full: a board whose only open work carries a retired label. The queue
    // count excludes the CURRENT names, so those issues are counted as available — but a user
    // who has just closed the rest of their board reads "No issues in the queue" and stops.
    // Step 7b sits above that return, so the explanation arrives first. Asserted on the run
    // that returns `started: false`, which is the one an assertion about the happy path cannot
    // reach.
    const deps = baseDeps({
      exec: makeExec({ queue: '0', labelList: { exitCode: 0, stdout: listing(RETIRED[0]) } }),
    })
    const result = await startCommand(deps)
    const out = deps.stdout.output()
    expect(out).toContain(WARNING(RETIRED[0]))
    expect(out).toContain('No issues in the queue')
    expect(out.indexOf(WARNING(RETIRED[0]))).toBeLessThan(out.indexOf('No issues in the queue'))
    expect(result).toEqual({ exitCode: 0, started: false })
  })

  it('still launches when the label list THROWS — a missing gh is not a broken setup', async () => {
    // Distinct from the dev's non-zero-exit case: a gh that is not on PATH makes the call throw
    // rather than return, and the throw would escape step 7b into the caller if the guard were
    // only an exit-code check. `hasCommand` is left saying yes on purpose — the dependency gate
    // at step 2 is not what is under test.
    const deps = baseDeps({
      exec: makeExec({
        labelList: () => {
          throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
        },
      }),
    })
    const result = await startCommand(deps)
    expect(deps.stdout.output()).not.toContain('Retired label')
    expect(deps.stderr.output()).not.toContain('Retired label')
    expect(result.started).toBe(true)
    expect(deps.exec.keys().some((key) => key.startsWith('tmux new -d'))).toBe(true)
  })

  it('asks gh for the label list exactly ONCE, with `{ reject: false }`', async () => {
    // One round trip for the whole mapping, and the option that makes a non-zero exit an answer
    // instead of an exception. Neither is observable through test/commands/start.test.js's
    // exec double, which records `(cmd, args)` and discards the options object.
    const deps = baseDeps({
      exec: makeExec({ labelList: { exitCode: 0, stdout: listing(...RETIRED) } }),
    })
    await startCommand(deps)
    const lists = labelCalls(deps.exec, 'list')
    expect(lists).toHaveLength(1)
    expect(lists[0].args).toEqual(['label', 'list', '--limit', '100', '--json', 'name'])
    expect(lists[0].options).toEqual({ reject: false })
  })

  it('runs after the last create and the orphan sweep, and before the queue count and the launch', async () => {
    // Position in the run as indices rather than as prose. The creates have to come first
    // because they are what put the destination names on a fresh board; the queue count and the
    // launch have to come after because a diagnostic that delayed either would be changing the
    // run rather than describing it.
    const deps = baseDeps({
      exec: makeExec({ labelList: { exitCode: 0, stdout: listing(RETIRED[0]) } }),
    })
    await startCommand(deps)
    const keys = deps.exec.keys()
    const lastCreate = keys.reduce((acc, k, i) => (k.startsWith('gh label create') ? i : acc), -1)
    const orphan = keys.findIndex((k) => k.startsWith('gh issue list --state open --label'))
    const list = keys.findIndex((k) => k.startsWith('gh label list'))
    const queue = keys.findIndex((k) => k.startsWith('gh issue list --search'))
    const launch = keys.findIndex((k) => k.startsWith('tmux new -d'))
    expect(lastCreate).toBeGreaterThanOrEqual(0)
    expect(list).toBeGreaterThan(lastCreate)
    expect(list).toBeGreaterThan(orphan)
    expect(queue).toBeGreaterThan(list)
    expect(launch).toBeGreaterThan(queue)
  })

  it('prints all four lines to STDOUT and nothing to stderr', async () => {
    // The warning is advice, and the run is a success. Three of the four lines are the ones that
    // make it actionable — the two halves of the consequence and the command — so all four are
    // pinned as one ordered block rather than as four independent `toContain`s.
    //
    // FOUR AND NOT THREE since the middle line was corrected: it used to be one line claiming
    // the issues were "invisible to Ralph", which the describe at the bottom of this file
    // measured as the inverse of what the run does. The consequence is two facts pointing in
    // opposite directions — selected by the queue, unseen by the sweep — so it is now two lines,
    // and this block pins both of them in place rather than only the one that read well.
    const deps = baseDeps({
      exec: makeExec({ labelList: { exitCode: 0, stdout: listing(RETIRED[0]) } }),
    })
    await startCommand(deps)
    const out = deps.stdout.output()
    const current = LEGACY_LABELS[RETIRED[0]]
    const block = [
      `⚠️  Retired label '${RETIRED[0]}' still exists on this board (now '${current}').`,
      '   Issues carrying it are no longer excluded from the queue: Ralph picks them up again as fresh work.',
      '   The orphan sweep can no longer see them either. Rename the label with:',
      `   gh label edit ${RETIRED[0]} --name ${current} --description 'Ralph loop in progress'`,
    ]
    let cursor = -1
    for (const line of block) {
      const at = out.indexOf(line)
      expect(at, line).toBeGreaterThan(cursor)
      cursor = at
    }
    expect(deps.stderr.output()).toBe('')
  })
})

describe('QA #141 — what step 7b must never do', () => {
  it('issues no `gh label edit`, `label delete` or `--force` in the entire run', async () => {
    // The check DIAGNOSES. Asserted over every call the run made and not just over the label
    // verbs, because the hazard is a helpful future edit anywhere in the preflight, not a
    // mis-shaped one inside labels.js.
    const deps = baseDeps({
      exec: makeExec({ labelList: { exitCode: 0, stdout: listing(...RETIRED) } }),
    })
    await startCommand(deps)
    expect(labelCalls(deps.exec, 'edit')).toEqual([])
    expect(labelCalls(deps.exec, 'delete')).toEqual([])
    const everything = deps.exec.keys().join('\n')
    expect(everything).not.toMatch(/label edit/)
    expect(everything).not.toMatch(/label delete/)
    expect(everything).not.toMatch(/--force/)
    // ...and the command really was printed, so the negatives above are not measuring a run
    // that simply had nothing to say.
    expect(deps.stdout.output()).toContain(`gh label edit ${RETIRED[0]} --name`)
  })

  it('makes no `gh label` call of ANY verb under folder source', async () => {
    // Folder mode tracks progress through the .ralph/tasks status directories, so there is no
    // board, no retired label and nothing to ask. Pinned as zero calls with `label` as the
    // first argument — a broader net than "no `gh label list`", so a future step 7c cannot leak
    // one either.
    const deps = baseDeps({
      processEnv: { RALPH_BANNER: 'off', TASK_SOURCE: 'folder' },
      folderQueueCount: async () => 1,
      exec: makeExec({ labelList: { exitCode: 0, stdout: listing(...RETIRED) } }),
    })
    const result = await startCommand(deps)
    expect(deps.exec.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'label')).toEqual([])
    expect(deps.stdout.output()).not.toContain('Retired label')
    expect(result.started).toBe(true)
  })

  it('DOES ask, and does warn, under jira source — pinned as the sibling steps behave', async () => {
    // Not an endorsement: `jira` is the source #127 documents as still running steps 6, 7 and 8
    // against GitHub, and step 7b is inside the same `source !== 'folder'` block, so it inherits
    // that. Recorded here so that whoever moves those four steps together — the follow-up
    // README calls "What is still GitHub's" — has this one in the list rather than discovering
    // it as a surprise gh call in a Jira run.
    const deps = baseDeps({
      processEnv: { RALPH_BANNER: 'off', TASK_SOURCE: 'jira' },
      exec: makeExec({ labelList: { exitCode: 0, stdout: listing(RETIRED[0]) } }),
    })
    await startCommand(deps)
    expect(labelCalls(deps.exec, 'list')).toHaveLength(1)
    expect(deps.stdout.output()).toContain(WARNING(RETIRED[0]))
  })

  it('is never reached by the run that INSTALLED the upgrade — the warning arrives one run late', async () => {
    // The sequencing nobody looked at, and the user #141 names in its own issue text: someone
    // who upgrades without reading the changelog. If they upgrade through this command's own
    // gate at step 2.5, it returns `started: false` there — five numbered steps above the check — so
    // that run never asks gh for a label list at all. They see the warning on their NEXT
    // `ralph start`. Measured rather than assumed, and pinned because it is the only path where
    // step 7b's placement below the update gate is observable.
    const deps = baseDeps({
      isTTY: true,
      stdin: { marker: 'injected-stdin', isTTY: false },
      currentVersion: '0.1.0',
      update: async () => ({ latestVersion: '0.2.0', isNewer: true, shouldPrompt: true }),
      ask: async () => true,
      runUpdate: async () => ({ exitCode: 0, updated: true, from: '0.1.0', to: '0.2.0' }),
      exec: makeExec({ labelList: { exitCode: 0, stdout: listing(...RETIRED) } }),
    })
    const result = await startCommand(deps)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(deps.stdout.output()).toContain('run `ralph start` again')
    expect(deps.stdout.output()).not.toContain('Retired label')
    expect(deps.exec.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'label')).toEqual([])
  })
})

describe('QA #141 — the consequence the warning states, against the one the run measures', () => {
  it('does not tell the user the issues are INVISIBLE, when the queue in the same run selects them', async () => {
    // THIS TEST WAS RED WHEN IT WAS WRITTEN, AND IS THE REASON THE WARNING HAS FOUR LINES.
    // It was never a wording preference: the middle line of the first draft stated the opposite
    // of what the run printing it does, and both halves of the real consequence are measured off
    // that one run below. The prose was corrected in lib/commands/start.js — "no longer excluded
    // from the queue: Ralph picks them up again as fresh work" plus "the orphan sweep can no
    // longer see them either" — and the assertions here are unchanged, so what was a detector is
    // now the regression guard for the same inversion coming back.
    //
    //   was printed: "   Issues that carry it are invisible to Ralph until you run:"
    //   measured:    the queue argv this run really spent is
    //             `--search state:open -label:in-progress -label:failed -label:do-not-ralph
    //             -label:pending-merge` — four clauses, none of them a retired name. An open
    //             issue whose only Ralph label is the retired one matches that search. It is
    //             SELECTED, not hidden.
    //
    // The half the line gets right is the orphan sweep, which lists the CURRENT in-progress
    // name and so cannot report those issues — and that is what start.js's own step-7b comment
    // says ("the issues this warning is about are precisely the ones it cannot see", about the
    // SWEEP). labels.js's header says the other half out loud too: "the loop hands one out as
    // fresh work IT HAS ALREADY DONE". Neither of those is "invisible to Ralph"; between them
    // they describe an issue that is visible to the one query that costs money and invisible to
    // the one query that would have flagged it.
    //
    // WHY IT MATTERS MORE THAN A WORD. "Invisible" reads as inert — nothing will happen to
    // these issues until I get around to this. What actually happens is that the next loop pass
    // picks one up as fresh work, at a paid agent invocation, and redoes work already merged;
    // for the retired FAILED name it retries work Ralph explicitly gave up on, every pass,
    // forever. A user who reads "invisible" and defers the paste is choosing the expensive
    // option while believing they chose the cheap one.
    //
    // The negative at the bottom is deliberately narrow — the exact phrase, not a paraphrase —
    // because it is the only part of this test that can go stale: the two measurements above are
    // read off the argv and stay true whatever the wording is. The ordered-block test further up
    // is what pins the corrected lines themselves.
    const deps = baseDeps({
      exec: makeExec({ labelList: { exitCode: 0, stdout: listing(RETIRED[0]) } }),
    })
    await startCommand(deps)
    const out = deps.stdout.output()
    expect(out).toContain(WARNING(RETIRED[0]))

    // MEASURED 1 — the queue search this run spent excludes no retired name, so an issue
    // carrying one is selected by it.
    const queueCall = deps.exec.calls.find((c) => c.args.includes('--search'))
    const search = queueCall.args[queueCall.args.indexOf('--search') + 1]
    const excluded = [...search.matchAll(/-label:(\S+)/g)].map((match) => match[1])
    for (const legacy of RETIRED) expect(excluded, legacy).not.toContain(legacy)

    // MEASURED 2 — the orphan sweep this run spent hunts the CURRENT name, so it is the sweep
    // that is blind, not the loop.
    const sweep = deps.exec.calls.find(
      (c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args.includes('--label'),
    )
    const hunted = sweep.args[sweep.args.indexOf('--label') + 1]
    expect(RETIRED).not.toContain(hunted)
    expect(hunted).toBe(LEGACY_LABELS[RETIRED[0]])

    // THE PHRASE THAT WAS FALSE against both measurements above, and must not come back.
    expect(out).not.toContain('invisible to Ralph')
  })
})

describe('QA #141 — the migration command is aimed at a board this same run has already changed', () => {
  it('creates the destination label at step 6 and THEN prints a rename onto that name', async () => {
    // FLAGGED FOR REVIEW. This test asserts only what was measured, and what was measured is a
    // collision course:
    //
    //   step 6  `gh label create <current> --color … --description …`   (idempotent, every run)
    //   step 7b `gh label edit <legacy> --name <current> --description …`  (printed for a human)
    //
    // So by the time the user reads the command, the name it renames ONTO exists — either
    // because it already did, or because this very run just created it. `gh label edit` has no
    // `--force` (measured from `gh label edit --help`; `gh label create` does have one), and
    // GitHub's REST docs for PATCH /repos/{owner}/{repo}/labels/{name} document only a 200 and
    // say nothing at all about a `new_name` that is already taken — so what a colliding rename
    // does is not something this file is willing to claim either way.
    //
    // WHAT IS CLAIMED is the ordering, because the ordering is what a reviewer needs in order to
    // judge the question: if a colliding `gh label edit` is refused, then the single line #141
    // exists to hand over cannot succeed on any board it is ever printed on, and the remediation
    // would have to be the two-step one instead — move the issues to the current label, then
    // delete the retired one. If GitHub merges the labels instead, the command is right as it
    // stands and this test is a harmless pin.
    //
    // Deliberately NOT written as a failing assertion: the defect is conditional on an
    // undocumented server behaviour, and a red test that asserts a guess is worse than a green
    // test that states the measurement.
    const deps = baseDeps({
      exec: makeExec({ labelList: { exitCode: 0, stdout: listing(RETIRED[0]) } }),
    })
    await startCommand(deps)
    const current = LEGACY_LABELS[RETIRED[0]]
    const created = labelCalls(deps.exec, 'create').map((call) => call.args[2])
    expect(created).toContain(current)
    const printed = `gh label edit ${RETIRED[0]} --name ${current}`
    expect(deps.stdout.output()).toContain(printed)
    // The create really did come first, in this same process, in this same run.
    const keys = deps.exec.keys()
    expect(keys.indexOf(`gh label create ${current} --color FFA500 --description Ralph loop in progress`))
      .toBeGreaterThanOrEqual(0)
    expect(keys.findIndex((k) => k.startsWith(`gh label create ${current} `))).toBeLessThan(
      keys.findIndex((k) => k.startsWith('gh label list')),
    )
  })
})
