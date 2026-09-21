import { describe, it, expect } from 'vitest'
import { sweepWorktrees } from './worktree.js'

// QA augmentation for sweepWorktrees (#223) — the adversarial and edge cases the dev's
// happy-path suite (lib/worktree.sweep.test.js) does not drive. That file covers the
// decision table on well-formed porcelain and one issue per case; what it does NOT drive
// is the parser fed hostile porcelain, the `git worktree list` FAILURE arm, the prune
// output arriving on stderr, and a single sweep that has to make several different
// verdicts at once. This file drives those, through the same injected seams.
//
// SEAMS mirror the dev's file, but the git double is wider: this harness lets a test hand
// `sweepWorktrees` an ARBITRARY porcelain string and an arbitrary `worktree list` exit
// status, which is the only way to exercise `issueWorktreeHandles`' skip rules and the
// list-failed guard — the dev's `porcelain(handles)` helper can only ever produce
// well-formed `issue-<N>` records the parser already accepts.

const HOME = '/home/dev'
const ROOT = '/repo'
const WT = (h) => `/repo/.ralph/worktrees/${h}`
const SHA = '2'.repeat(40)

const makeSink = () => {
  const calls = []
  return { calls, write: (m) => calls.push(m) }
}

// One porcelain record. `branch` may be replaced with a bare `detached` marker to prove
// the parser keys only off the `worktree ` line and never the follow-up.
const record = (path, { detached = false, branch } = {}) =>
  detached
    ? `worktree ${path}\nHEAD ${SHA}\ndetached`
    : `worktree ${path}\nHEAD ${SHA}\nbranch ${branch ?? `refs/heads/${path.split('/').pop()}`}`

// Assemble a full `git worktree list --porcelain` payload from raw record strings.
const listing = (...records) => records.join('\n\n') + '\n'

// A trace across git + fs, with FULL control of the porcelain and the list exit status —
// which is what separates this harness from the dev's. `porcelain`/`listStatus` feed the
// `worktree list` call directly; `prune` feeds the prune call's two streams independently.
function harness({
  porcelain = '',
  listStatus = 0,
  prune = { stdout: '', stderr: '' },
  issues = {},
  present = [],
  rmThrowsFor = new Set(),
} = {}) {
  const steps = []
  const gitLines = []
  const stdout = makeSink()
  const stderr = makeSink()
  const paths = new Set(present)
  paths.add('/repo/.git')

  const git = (args) => {
    const line = args.join(' ')
    gitLines.push(line)
    steps.push(`git ${line}`)
    if (line.startsWith('worktree prune')) {
      return { status: 0, stdout: prune.stdout, stderr: prune.stderr }
    }
    if (line === 'worktree list --porcelain') {
      return {
        status: listStatus,
        stdout: listStatus === 0 ? porcelain : '',
        stderr: listStatus === 0 ? '' : 'fatal: not a git repository\n',
      }
    }
    return { status: 0, stdout: '', stderr: '' }
  }

  const fs = {
    existsSync: (p) => paths.has(p),
    mkdirSync: (p) => paths.add(p),
    rmSync: (p) => {
      steps.push(`rm ${p}`)
      if (rmThrowsFor.has(p)) throw new Error(`EACCES: permission denied, rmdir '${p}'`)
      paths.delete(p)
    },
  }

  const queryCalls = []
  const queryIssue = (n) => {
    queryCalls.push(n)
    const entry = issues[n]
    if (entry === 'throw') throw new Error('gh exploded')
    if (entry === undefined) return null
    return entry
  }

  const removed = () => gitLines.filter((l) => l.startsWith('worktree remove'))

  return {
    git,
    fs,
    stdout,
    stderr,
    steps,
    gitLines,
    paths,
    queryCalls,
    removed,
    deps: (source) => ({ source, fs, git, queryIssue, home: HOME, stdout, stderr }),
  }
}

// ---------------------------------------------------------------------------
// 1. `git worktree list` FAILURE — best-effort: warn and return, never throw
// ---------------------------------------------------------------------------
//
// The dev's suite always returns status 0 from the list, so the guard right after it
// (`if (listed.status !== 0) { warn; return }`) has never run. It is the one place a
// github sweep bails out before phase 2 without an issue verdict, and the loop calls this
// with `|| true`, so a throw here would still poison the pane it prints into.

describe('sweepWorktrees when `git worktree list` fails (#223 QA)', () => {
  it('warns, queries nothing, removes nothing, and does not throw — but still pruned', () => {
    const h = harness({ listStatus: 128, issues: { 5: { state: 'CLOSED', labels: [] } } })
    expect(() => sweepWorktrees(ROOT, h.deps('github'))).not.toThrow()

    // The prune still ran first — a list that cannot be read does not undo phase 1.
    expect(h.gitLines[0]).toBe('worktree prune -v')
    // No enumeration verdict was reached: nothing queried, nothing removed.
    expect(h.queryCalls).toEqual([])
    expect(h.removed()).toEqual([])
    // …and the human is told why the sweep stopped short.
    expect(h.stderr.calls.join('')).toMatch(/could not list worktrees to sweep/)
  })
})

// ---------------------------------------------------------------------------
// 2. Prune reporting on the STDERR channel is still echoed to the sweep's stdout
// ---------------------------------------------------------------------------
//
// The module reads BOTH `pruned.stdout` and `pruned.stderr` because "git splits that
// reporting across stdout and stderr depending on version". The dev's harness only ever
// puts prune output on stdout, so the stderr half of that concatenation is never
// exercised — a regression that dropped it would pass the whole happy-path suite.

describe('sweepWorktrees echoes prune output regardless of which stream git used (#223 QA)', () => {
  it('echoes prune reporting that git wrote to stderr onto the sweep stdout', () => {
    const h = harness({
      porcelain: '',
      prune: { stdout: '', stderr: 'Removing worktrees/issue-77: gitdir file points to non-existent location\n' },
    })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.stdout.calls.join('')).toContain('issue-77')
  })

  it('says nothing on stdout when git pruned nothing at all', () => {
    const h = harness({ prune: { stdout: '', stderr: '' } })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.stdout.calls.join('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 3. Porcelain parsing — the shapes that MUST NOT be taken for a github worktree
// ---------------------------------------------------------------------------
//
// `issueWorktreeHandles` is not exported, so each rule is proved through its only
// observable consequence: an unrecognised worktree is neither queried nor removed. The
// dev's file proves a single foreign `scratch` handle is skipped; these cover the rest of
// the skip rules and the two matches that must still land.

describe('sweepWorktrees only reasons about issue-<N> trees directly under .ralph/worktrees (#223 QA)', () => {
  it('skips a worktree one level DEEPER than the worktrees root', () => {
    // A checkout git registered inside an issue tree is not itself an issue tree.
    const h = harness({
      porcelain: listing(record(WT('issue-5/nested'))),
      issues: { 5: { state: 'CLOSED', labels: [] } },
    })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.queryCalls).toEqual([])
    expect(h.removed()).toEqual([])
  })

  it('skips a task-<N> folder-mode handle even when the source is github', () => {
    const h = harness({
      porcelain: listing(record(WT('task-9'))),
      issues: { 9: { state: 'CLOSED', labels: [] } },
    })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.queryCalls).toEqual([])
    expect(h.removed()).toEqual([])
  })

  it('skips the MAIN repo worktree, which is not under .ralph/worktrees', () => {
    const h = harness({ porcelain: listing(record(ROOT, { branch: 'refs/heads/main' })) })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.queryCalls).toEqual([])
    expect(h.removed()).toEqual([])
  })

  it('does not match issue-foo, issue-, or issue-12abc — only issue-<digits>', () => {
    const h = harness({
      porcelain: listing(
        record(WT('issue-foo')),
        record(WT('issue-')),
        record(WT('issue-12abc')),
      ),
    })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.queryCalls).toEqual([])
    expect(h.removed()).toEqual([])
  })

  it('tolerates trailing whitespace on the worktree path line and still matches', () => {
    const h = harness({
      porcelain: `worktree ${WT('issue-8')}   \nHEAD ${SHA}\nbranch refs/heads/issue-8\n`,
      issues: { 8: { state: 'CLOSED', labels: [] } },
      present: [WT('issue-8')],
    })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.queryCalls).toEqual(['8'])
    expect(h.removed()).toContain(`worktree remove --force ${WT('issue-8')}`)
  })

  it('matches an issue worktree whose record ends in `detached` rather than `branch`', () => {
    const h = harness({
      porcelain: listing(record(WT('issue-6'), { detached: true })),
      issues: { 6: { state: 'CLOSED', labels: [] } },
      present: [WT('issue-6')],
    })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.queryCalls).toEqual(['6'])
    expect(h.removed()).toContain(`worktree remove --force ${WT('issue-6')}`)
  })

  it('does nothing on blank / empty porcelain', () => {
    const h = harness({ porcelain: '\n\n' })
    expect(() => sweepWorktrees(ROOT, h.deps('github'))).not.toThrow()
    expect(h.queryCalls).toEqual([])
    expect(h.removed()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. State classification — the shapes the happy path did not spell out
// ---------------------------------------------------------------------------

describe('sweepWorktrees state classification edges (#223 QA)', () => {
  it('keeps a tree whose issue answer is missing its state ({}), and warns', () => {
    const h = harness({
      porcelain: listing(record(WT('issue-1'))),
      issues: { 1: {} },
      present: [WT('issue-1')],
    })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.removed()).toEqual([])
    expect(h.paths.has(WT('issue-1'))).toBe(true)
    expect(h.stderr.calls.join('')).toContain('issue-1')
  })

  it('removes a CLOSED issue even when the answer carries NO labels field', () => {
    // `labels` defaults to [] — a missing array must not throw on `.includes`.
    const h = harness({
      porcelain: listing(record(WT('issue-2'))),
      issues: { 2: { state: 'CLOSED' } },
      present: [WT('issue-2')],
    })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.removed()).toContain(`worktree remove --force ${WT('issue-2')}`)
    expect(h.stdout.calls.join('')).toContain('swept issue-2 (closed)')
  })

  it('KEEPS a lowercase "closed" — the state compare is exact, so an unexpected spelling is conservative', () => {
    const h = harness({
      porcelain: listing(record(WT('issue-3'))),
      issues: { 3: { state: 'closed', labels: [] } },
      present: [WT('issue-3')],
    })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.removed()).toEqual([])
    expect(h.paths.has(WT('issue-3'))).toBe(true)
  })

  it('removes when pending-merge sits among OTHER labels on an OPEN issue', () => {
    const h = harness({
      porcelain: listing(record(WT('issue-4'))),
      issues: { 4: { state: 'OPEN', labels: ['needs-review', 'pending-merge'] } },
      present: [WT('issue-4')],
    })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.removed()).toContain(`worktree remove --force ${WT('issue-4')}`)
    expect(h.stdout.calls.join('')).toContain('swept issue-4 (pending-merge)')
  })
})

// ---------------------------------------------------------------------------
// 5. A single sweep that must make FOUR different verdicts at once
// ---------------------------------------------------------------------------
//
// The dev's multi-worktree test is two CLOSED trees with one removal jammed. This one
// mixes every verdict the table produces in ONE pass and asserts each independently — the
// proof that a keep between two removes (or an indeterminate one) does not derail the rest.

describe('sweepWorktrees classifies a mixed set independently in one pass (#223 QA)', () => {
  it('removes the done ones, keeps the open and the unknowable, and reports each', () => {
    const h = harness({
      porcelain: listing(
        record(WT('issue-1')),
        record(WT('issue-2')),
        record(WT('issue-3')),
        record(WT('issue-4')),
      ),
      issues: {
        1: { state: 'CLOSED', labels: [] },
        2: { state: 'OPEN', labels: [] },
        3: { state: 'OPEN', labels: ['pending-merge'] },
        // 4 omitted -> queryIssue returns null -> indeterminate
      },
      present: [WT('issue-1'), WT('issue-2'), WT('issue-3'), WT('issue-4')],
    })
    sweepWorktrees(ROOT, h.deps('github'))

    // Every issue was consulted, in porcelain order.
    expect(h.queryCalls).toEqual(['1', '2', '3', '4'])

    // The two done ones are gone and named…
    expect(h.paths.has(WT('issue-1'))).toBe(false)
    expect(h.paths.has(WT('issue-3'))).toBe(false)
    expect(h.stdout.calls.join('')).toContain('swept issue-1 (closed)')
    expect(h.stdout.calls.join('')).toContain('swept issue-3 (pending-merge)')

    // …the OPEN one and the indeterminate one both survive.
    expect(h.paths.has(WT('issue-2'))).toBe(true)
    expect(h.paths.has(WT('issue-4'))).toBe(true)
    expect(h.stdout.calls.join('')).not.toContain('issue-2')
    // Only the indeterminate one is warned about (the open one is silent).
    const warnings = h.stderr.calls.join('')
    expect(warnings).toContain('issue-4')
    expect(warnings).not.toContain('issue-2')
  })

  it('a removal that THROWS mid-set does not stop the verdicts after it', () => {
    // issue-1 CLOSED but its removal jams; issue-2 pending-merge must still be swept.
    const h = harness({
      porcelain: listing(record(WT('issue-1')), record(WT('issue-2'))),
      issues: {
        1: { state: 'CLOSED', labels: [] },
        2: { state: 'OPEN', labels: ['pending-merge'] },
      },
      present: [WT('issue-1'), WT('issue-2')],
      rmThrowsFor: new Set([WT('issue-1')]),
    })
    expect(() => sweepWorktrees(ROOT, h.deps('github'))).not.toThrow()
    expect(h.stderr.calls.join('')).toContain('issue-1')
    expect(h.stdout.calls.join('')).toContain('swept issue-2 (pending-merge)')
    expect(h.paths.has(WT('issue-2'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. Ordering — prune, then list, then removals; prune echo survives a real removal
// ---------------------------------------------------------------------------

describe('sweepWorktrees ordering with a firing phase 2 (#223 QA)', () => {
  it('prunes (echoing) BEFORE it lists, and lists before it removes', () => {
    const h = harness({
      porcelain: listing(record(WT('issue-9'))),
      prune: { stdout: 'Removing worktrees/issue-77: gitdir file points to non-existent location\n', stderr: '' },
      issues: { 9: { state: 'CLOSED', labels: [] } },
      present: [WT('issue-9')],
    })
    sweepWorktrees(ROOT, h.deps('github'))

    // The prune's report is echoed even though phase 2 also removed a tree.
    expect(h.stdout.calls.join('')).toContain('issue-77')
    expect(h.stdout.calls.join('')).toContain('swept issue-9 (closed)')

    // Order of the three git milestones.
    const prune = h.gitLines.indexOf('worktree prune -v')
    const list = h.gitLines.indexOf('worktree list --porcelain')
    const remove = h.gitLines.findIndex((l) => l.startsWith('worktree remove'))
    expect(prune).toBeGreaterThanOrEqual(0)
    expect(prune).toBeLessThan(list)
    expect(list).toBeLessThan(remove)
  })
})
