// #139 QA augmentation — IS THE SEAM LOAD-BEARING? Asked by renaming, not by reading.
//
// The dev's labels.test.js proves the module composes its query from its own names, and
// sweeps lib/ for a leftover literal with codeWithoutComments. Both are STATIC arguments,
// and both share one blind spot: they can only say that a string does not appear in a file.
// They cannot say that the string a consumer actually spends came from the module. A
// consumer that built the name by concatenation, read it off a config default, or kept a
// stale copy in a second constant would pass every one of them.
//
// So this file asks the question the next slice actually depends on: SUBSTITUTE the module,
// run the consumers, and see whether the renamed words come out the other end. Every export
// is replaced with an obviously-fake spelling (`qa-…`), the five consumers are driven for
// real, and the argv they hand to `gh` is read back. If any consumer still reaches for
// `in-progress`, its call comes out carrying the REAL name while the module says
// otherwise — which is exactly the half-landed rename #139 exists to make impossible, and
// the failure a same-value assertion cannot see.
//
// The fake names are deliberately NOT plausible label names: `qa-claimed` can only be
// here by having travelled through the module, and a real name in this file's output can
// only be a literal somewhere in lib/. They also must not CONTAIN a real name, which #140 is how
// we found out: the fake in-progress label was `qa-in-progress`, harmless while the real one
// carried a `claude-` prefix, and every "emits no REAL name" assertion below went red the moment
// the real one became `in-progress` — the substituted argv was spelling it as a substring of its
// own fake. Renamed to `qa-claimed`, which shares no substring with any label Ralph has ever had.
//
// AND SINCE #140 THIS FILE CARRIES A CLAIM THE STATIC HALF NO LONGER CAN. The renamed labels are
// spelled `in-progress` and `failed`, words the folder lane's status directories, the Jira lane's
// labels and ordinary English all use, so "the string is absent from this module's source" stopped
// being evidence that the name was not retyped (labels.test.js says so at its GUARDED set).
// Substitution does not care that a label name is also an English word: a hardcoded `'failed'`
// emits `failed` while the module says `qa-gave-up`, and that is a red test whatever the word is.

import { describe, expect, it, vi } from 'vitest'
import { Volume } from 'memfs'

// The substituted vocabulary. `vi.hoisted` because the mock factory below is hoisted above
// every import and cannot close over an ordinary const. Composed the same way the real
// module composes — that is the shape under test, not the values.
const FAKE = vi.hoisted(() => {
  const IN_PROGRESS_LABEL = 'qa-claimed'
  const FAILED_LABEL = 'qa-gave-up'
  const PENDING_MERGE_LABEL = 'qa-awaiting-rollforward'
  const SKIP_LABEL = 'qa-hands-off'
  const RALPH_LABELS = Object.freeze([
    IN_PROGRESS_LABEL,
    FAILED_LABEL,
    SKIP_LABEL,
    PENDING_MERGE_LABEL,
  ])
  const MANAGED_LABELS = Object.freeze([
    Object.freeze({ name: IN_PROGRESS_LABEL, color: '111111', description: 'QA in progress' }),
    Object.freeze({ name: FAILED_LABEL, color: '222222', description: 'QA gave up' }),
    Object.freeze({ name: PENDING_MERGE_LABEL, color: '333333', description: 'QA awaiting merge' }),
  ])
  const LABEL_EXCLUSION = RALPH_LABELS.map((name) => `-label:${name}`).join(' ')
  return {
    IN_PROGRESS_LABEL,
    FAILED_LABEL,
    PENDING_MERGE_LABEL,
    SKIP_LABEL,
    RALPH_LABELS,
    MANAGED_LABELS,
    // Shape-correct and empty: an OBJECT since #140, because the real export is a mapping from
    // retired spelling to replacement and a consumer that iterated `Object.entries` on an array
    // would sail through a substitution that handed it the wrong container. It stays EMPTY under
    // substitution even now that #141 reads it: this file's whole question is which words a
    // consumer emits, and a fake retired name would put a `qa-…` spelling in `ralph start`'s
    // output for reasons that have nothing to do with the vocabulary being substituted. What #141
    // is owed is that the migration warning cannot invent a name of its own, and that is the
    // stub below plus the catch-all further down.
    LEGACY_LABELS: Object.freeze({}),
    // #141's check, stubbed to "this board is clean". The real one shells out; substituting the
    // module has to substitute that too, or `ralph start` reaches for an export the fake does not
    // have and the four assertions in this file die on a TypeError instead of measuring anything.
    // Returning an empty list is the honest stub for an empty LEGACY_LABELS above — it is
    // precisely what the real function does with nothing retired.
    findLegacyLabels: async () => [],
    LABEL_EXCLUSION,
    ISSUE_SEARCH_QUERY: `state:open ${LABEL_EXCLUSION}`,
  }
})

vi.mock('./labels.js', () => FAKE)

// Imported AFTER the mock is registered (vitest hoists `vi.mock`, so these already see it).
const { startCommand } = await import('./commands/start.js')
const { cycleCommand } = await import('./commands/cycle.js')
const { statusCommand } = await import('./commands/status.js')
const { findOrphans, cleanupOrphans } = await import('./orphan-cleanup.js')
const { buildIssueEvent } = await import('./issue-event.js')
const { sessionNameFor } = await import('./lock.js')

// The names as they are spelled TODAY, as literals — the one file in lib/ that is allowed to
// type them beside a mocked module, because "no consumer emitted one of these" is the claim.
// Literals and not imports on purpose, twice over: `vi.mock` is in force for the whole file so
// an import would hand back the fakes, and a check written against the module under substitution
// could not disagree with it.
const REAL_NAMES = ['in-progress', 'failed', 'pending-merge', 'do-not-ralph']

const REPO = '/repo'
const HOME = '/home/me'

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

// One recorder for every consumer below: whole argv and options, so a claim about a `gh`
// command line is measured against the array that would have been spawned.
function makeExec({ queue = '0', orphans = '  #7 a stranded issue' } = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      if (args.includes('--search')) return { exitCode: 0, stdout: queue, stderr: '' }
      return { exitCode: 0, stdout: orphans, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

const searchOf = (exec) => {
  const call = exec.calls.find((c) => c.cmd === 'gh' && c.args.includes('--search'))
  return call ? call.args[call.args.indexOf('--search') + 1] : null
}

const allArgv = (exec) => exec.calls.map((c) => c.key).join('\n')

describe('QA #139 — the seam under substitution: `ralph start`', () => {
  const startDeps = (overrides = {}) => ({
    cwd: REPO,
    stdout: makeStream(),
    stderr: makeStream(),
    exec: makeExec(),
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
    home: HOME,
    processEnv: { RALPH_BANNER: 'off' },
    cacheFs: new Volume(),
    ...overrides,
  })

  it('creates the SUBSTITUTED labels — name, colour and description all follow the module', async () => {
    const deps = startDeps()
    await startCommand(deps)
    const creates = deps.exec.calls.filter(
      (c) => c.cmd === 'gh' && c.args[0] === 'label' && c.args[1] === 'create',
    )
    // Whole argv arrays, in call order: the loop over MANAGED_LABELS must spend the specs it
    // was handed, and nothing else.
    expect(creates.map((c) => c.args)).toEqual([
      ['label', 'create', 'qa-claimed', '--color', '111111', '--description', 'QA in progress'],
      ['label', 'create', 'qa-gave-up', '--color', '222222', '--description', 'QA gave up'],
      [
        'label',
        'create',
        'qa-awaiting-rollforward',
        '--color',
        '333333',
        '--description',
        'QA awaiting merge',
      ],
    ])
  })

  it('sweeps for orphans under the SUBSTITUTED in-progress label, and says so in the notice', async () => {
    const deps = startDeps()
    await startCommand(deps)
    const list = deps.exec.calls.find(
      (c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args.includes('--label'),
    )
    expect(list.args[list.args.indexOf('--label') + 1]).toBe('qa-claimed')
    // The user-facing half: the remediation line tells a human which label to strip by hand,
    // so a stale literal there is a printed instruction that does not work.
    const out = deps.stdout.output()
    expect(out).toContain("Issues with the 'qa-claimed' label")
    expect(out).toContain('gh issue edit <n> --remove-label qa-claimed')
  })

  it('selects work with the SUBSTITUTED query', async () => {
    const deps = startDeps()
    await startCommand(deps)
    expect(searchOf(deps.exec)).toBe(
      'state:open -label:qa-claimed -label:qa-gave-up -label:qa-hands-off -label:qa-awaiting-rollforward',
    )
  })

  it('emits no REAL label name anywhere in its argv or its output', async () => {
    // The catch-all. A second constant, a concatenation, or one block of the old three that
    // survived the loop would show up here and nowhere else in the suite.
    const deps = startDeps()
    await startCommand(deps)
    const haystack = `${allArgv(deps.exec)}\n${deps.stdout.output()}\n${deps.stderr.output()}`
    for (const name of REAL_NAMES) expect(haystack, name).not.toContain(name)
  })
})

describe('QA #139 — the seam under substitution: `ralph cycle` and `ralph status`', () => {
  const cycleDeps = (overrides = {}) => ({
    cwd: REPO,
    stdout: makeStream(),
    stderr: makeStream(),
    exec: makeExec({ queue: '' }),
    // ralph.config.sh present — the cycle preflight aborts without it, well before the
    // queue count this test is about.
    exists: () => true,
    loadEnv: () => ({}),
    acquireLock: () => ({
      acquired: true,
      holder: { pid: 1, startedAt: '2026-04-29T00:00:00.000Z', repoPath: REPO },
    }),
    releaseLock: () => {},
    findOrphans: async () => [],
    cleanupOrphans: async () => [],
    sendWa: async () => ({ ok: true }),
    pingSuccess: async () => ({ ok: true }),
    pingFail: async () => ({ ok: true }),
    runQueueOnce: async () => ({ successes: [], failures: [] }),
    readFile: () => '',
    now: () => Date.parse('2026-04-29T00:30:00.000Z'),
    cacheFs: new Volume(),
    ...overrides,
  })

  it('`ralph cycle` counts the queue with the SUBSTITUTED query', async () => {
    const deps = cycleDeps()
    await cycleCommand(deps)
    expect(searchOf(deps.exec)).toBe(FAKE.ISSUE_SEARCH_QUERY)
    for (const name of REAL_NAMES) expect(allArgv(deps.exec), name).not.toContain(name)
  })

  it('`ralph status` counts the queue with the SUBSTITUTED query — the same one', async () => {
    // The point of the shared module: "N waiting" and "what the loop picks next" are one
    // string. Substituting proves they move TOGETHER, which three equal literals also
    // satisfied right up until one of them was edited.
    const deps = {
      cwd: REPO,
      stdout: makeStream(),
      exec: makeExec({ queue: '6' }),
      exists: () => false,
      readFile: () => '',
      readRunState: () => ({
        schema: 1,
        run_id: sessionNameFor(REPO),
        session: sessionNameFor(REPO),
        source: 'github',
        status: 'running',
        started_at: new Date(2026, 7, 25, 16, 20, 0).toISOString(),
        queue_at_start: 8,
        current: null,
        finished_at: null,
        ok: null,
        failed: null,
      }),
      folderQueueCount: async () => 6,
      peekLock: () => null,
      now: () => new Date(2026, 7, 25, 19, 32, 0).getTime(),
      processEnv: { RALPH_BANNER: 'off' },
    }
    await statusCommand(deps)
    expect(searchOf(deps.exec)).toBe(FAKE.ISSUE_SEARCH_QUERY)
    for (const name of REAL_NAMES) expect(allArgv(deps.exec), name).not.toContain(name)
  })
})

describe('QA #139 — the seam under substitution: the orphan sweep', () => {
  it('lists and clears under the SUBSTITUTED label, in both of its argv', async () => {
    // orphan-cleanup.js builds LIST_ARGS at MODULE LOAD from the imported name, which is the
    // one shape where a stale copy is invisible to a call-site read: the array is frozen in
    // place the first time the module is imported.
    const exec = makeExec()
    const found = await findOrphans({ exec, repoPath: REPO, log: () => {} })
    expect(Array.isArray(found)).toBe(true)
    const list = exec.calls.find((c) => c.args.includes('--label'))
    expect(list.args[list.args.indexOf('--label') + 1]).toBe('qa-claimed')

    const cleared = await cleanupOrphans({
      exec,
      orphans: [{ number: 7, title: 'x' }],
      log: () => {},
    })
    expect(cleared).toEqual([7])
    const edit = exec.calls.find((c) => c.args.includes('--remove-label'))
    expect(edit.args).toEqual(['issue', 'edit', '7', '--remove-label', 'qa-claimed'])
    for (const name of REAL_NAMES) expect(allArgv(exec), name).not.toContain(name)
  })
})

describe('QA #139 — the seam under substitution: the outcome precedence', () => {
  const verdictOf = (labels, state) =>
    buildIssueEvent({ issueNumber: 1, runId: 'r', labels, state, ts: '2026-04-29T00:00:00.000Z' })
      .verdict

  it('reads the SUBSTITUTED failed / pending-merge labels', async () => {
    expect(verdictOf(['qa-gave-up'], 'OPEN')).toBe('fail')
    expect(verdictOf(['qa-awaiting-rollforward'], 'OPEN')).toBe('pass')
  })

  it('and no longer recognises the real ones — proof it is not reading a second copy', async () => {
    // The negative that makes the positive mean something. If `computeVerdict` kept a literal
    // `'failed'` beside the import, this would still say `fail` and the rename would
    // half-land: metrics keyed to a word the loop no longer stamps.
    expect(verdictOf(['failed'], 'OPEN')).toBe('unknown')
    expect(verdictOf(['pending-merge'], 'OPEN')).toBe('unknown')
    // `CLOSED` is a STATE and not a label, so it must survive the substitution untouched.
    expect(verdictOf([], 'CLOSED')).toBe('pass')
  })
})

describe('QA #139 — the one place a rename does NOT propagate (disclosed, pinned)', () => {
  it('lib/jira-jql.js keeps its own hands-off literal, and it still matches the REAL SKIP_LABEL', async () => {
    // NOT a passing grade — a DISCLOSED EXCEPTION. jira-jql.js cannot import labels.js because
    // its own spec (jira-jql.test.js, 'reads no clock, no environment and no filesystem — and
    // imports nothing') asserts the module has zero imports, and #139 may not edit an existing
    // test. So the Jira JQL still spells the hands-off label by hand, and a future rename of
    // `do-not-ralph` is TWO edits, not one.
    //
    // Asserted against `importActual` and NOT against the FAKE above: the mocked vocabulary is
    // in force for the rest of this file, and comparing jira-jql.js's literal to a fake name it
    // never had — `expect(…).not.toContain('qa-hands-off')` — would pass no matter what either
    // side spelled. Read the real module instead, so the two copies are compared to each other
    // and a rename of SKIP_LABEL makes this line red.
    //
    // The other guard on this exemption is labels.vocabulary.qa.test.js, 'appears in exactly one
    // file besides labels.js — lib/jira-jql.js, and by name', which allowlists the literal so a
    // SECOND hardcoded copy has to be argued for. This one covers the drift; that one covers
    // the spread.
    const { SKIP_LABEL: REAL_SKIP } = await vi.importActual('./labels.js')
    const { JIRA_LABEL_EXCLUSION } = await import('./jira-jql.js')
    expect(REAL_SKIP).not.toBe(FAKE.SKIP_LABEL)
    expect(JIRA_LABEL_EXCLUSION).toContain(REAL_SKIP)
  })
})
