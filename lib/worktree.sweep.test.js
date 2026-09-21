import { describe, it, expect } from 'vitest'
import { sweepWorktrees } from './worktree.js'

// #223 — the loop-start sweep of stray worktrees, driven entirely through injected seams.
//
// WHY A UNIT SUITE AT ALL, given #223 also ships a real-git integration test. The
// integration test proves the CLI wired into a live repository does the right thing to
// disk; it cannot cheaply enumerate the decision table — closed vs open vs pending-merge
// vs an issue query that FAILS — without a `gh` stub per case and a repository per case.
// The table is behaviour, so it is tested the way this package tests behaviour: an
// injectable-dependency module and a double per seam. See lib/worktree.remove.qa.test.js
// for the trace-across-seams harness this file mirrors.
//
// SEAMS: an `fs` object of the three verbs removeWorktree touches (sweep passes its own
// straight through), a `git` function returning `{status, stdout, stderr}`, a `queryIssue`
// function the github arm asks for one issue's state, and `stdout`/`stderr` sinks — the
// sweep's whole observable output is what it writes to those two.

const HOME = '/home/dev'
const ROOT = '/repo'
const WT = (h) => `/repo/.ralph/worktrees/${h}`

const makeSink = () => {
  const calls = []
  return { calls, write: (m) => calls.push(m) }
}

// `git worktree list --porcelain` for the main tree plus the given handles, each a live
// worktree under .ralph/worktrees. The exact shape git 2.50.1 prints (blank-line
// separated records, `worktree <path>` / `HEAD <sha>` / `branch <ref>`).
const porcelain = (handles) =>
  [
    `worktree ${ROOT}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main`,
    ...handles.map(
      (h) =>
        `worktree ${WT(h)}\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/${h}`,
    ),
  ].join('\n\n') + '\n'

// One trace across BOTH the git and fs seams, because most of what is asked below is
// ordering — "did the prune run before the enumeration?", "did the second worktree still
// get swept after the first one threw?" — which separate spies cannot order themselves.
// `present` is the set of paths on disk; removeWorktree's fs sweep deletes from it.
function harness({
  handles = [],
  present = null,
  pruneOut = '',
  issues = {},
  rmThrowsFor = new Set(),
} = {}) {
  const steps = []
  const gitLines = []
  const stdout = makeSink()
  const stderr = makeSink()
  const paths = new Set(present ?? handles.map(WT))
  paths.add('/repo/.git')

  const git = (args) => {
    const line = args.join(' ')
    gitLines.push(line)
    steps.push(`git ${line}`)
    if (line.startsWith('worktree prune -v')) return { status: 0, stdout: pruneOut, stderr: '' }
    if (line === 'worktree list --porcelain') return { status: 0, stdout: porcelain(handles), stderr: '' }
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

  // The github seam: number -> a scripted result, or a sentinel that makes it fail.
  const queryCalls = []
  const queryIssue = (n) => {
    queryCalls.push(n)
    const entry = issues[n]
    if (entry === 'throw') throw new Error('gh exploded')
    if (entry === undefined) return null // indeterminate
    return entry
  }

  return {
    git,
    fs,
    stdout,
    stderr,
    steps,
    gitLines,
    paths,
    queryCalls,
    deps: (source) => ({ source, fs, git, queryIssue, home: HOME, stdout, stderr }),
  }
}

// ---------------------------------------------------------------------------
// 1. The prune runs for EVERY source, before anything else
// ---------------------------------------------------------------------------

describe('sweepWorktrees prunes git-prunable records for every source (#223)', () => {
  it('runs `worktree prune -v` and echoes what git pruned to stdout', () => {
    const pruneOut =
      'Removing worktrees/issue-98: gitdir file points to non-existent location\n'
    const h = harness({ handles: [], pruneOut })
    sweepWorktrees(ROOT, h.deps('github'))

    // The prune is the FIRST thing sweep does (cwd carries the root; the argv is what
    // we assert), before any enumeration.
    expect(h.gitLines[0]).toBe('worktree prune -v')
    // …and what it named is on stdout so the tmux pane records the hand-deleted record.
    expect(h.stdout.calls.join('')).toContain('issue-98')
  })

  it('under folder mode prunes but never lists or queries an issue', () => {
    const h = harness({ handles: ['issue-7'], issues: { 7: { state: 'CLOSED', labels: [] } } })
    sweepWorktrees(ROOT, h.deps('folder'))

    expect(h.gitLines).toContain('worktree prune -v')
    expect(h.gitLines).not.toContain('worktree list --porcelain')
    expect(h.queryCalls).toEqual([])
    // The closed issue's worktree is left alone: folder mode has no issue to consult.
    expect(h.gitLines.some((l) => l.startsWith('worktree remove'))).toBe(false)
  })

  it('under jira mode prunes but never lists or queries an issue', () => {
    const h = harness({ handles: ['issue-7'], issues: { 7: { state: 'CLOSED', labels: [] } } })
    sweepWorktrees(ROOT, h.deps('jira'))

    expect(h.gitLines).toContain('worktree prune -v')
    expect(h.gitLines).not.toContain('worktree list --porcelain')
    expect(h.queryCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. The github decision table: closed / pending-merge removed, open kept
// ---------------------------------------------------------------------------

describe('sweepWorktrees removes github worktrees whose issue is done (#223)', () => {
  it('removes a worktree whose issue is CLOSED and names it on stdout', () => {
    const h = harness({ handles: ['issue-42'], issues: { 42: { state: 'CLOSED', labels: [] } } })
    sweepWorktrees(ROOT, h.deps('github'))

    expect(h.gitLines).toContain(`worktree remove --force ${WT('issue-42')}`)
    expect(h.stdout.calls.join('')).toContain('swept issue-42 (closed)')
    expect(h.paths.has(WT('issue-42'))).toBe(false)
  })

  it('removes a worktree whose OPEN issue carries pending-merge', () => {
    const h = harness({
      handles: ['issue-42'],
      issues: { 42: { state: 'OPEN', labels: ['pending-merge'] } },
    })
    sweepWorktrees(ROOT, h.deps('github'))

    expect(h.gitLines).toContain(`worktree remove --force ${WT('issue-42')}`)
    expect(h.stdout.calls.join('')).toContain('swept issue-42 (pending-merge)')
  })

  it('keeps a worktree whose issue is still OPEN and says nothing on stdout about it', () => {
    const h = harness({ handles: ['issue-42'], issues: { 42: { state: 'OPEN', labels: [] } } })
    sweepWorktrees(ROOT, h.deps('github'))

    expect(h.gitLines.some((l) => l.startsWith('worktree remove'))).toBe(false)
    expect(h.stdout.calls.join('')).not.toContain('issue-42')
    expect(h.paths.has(WT('issue-42'))).toBe(true)
  })

  it('only touches issue-<N> directories directly under .ralph/worktrees', () => {
    // A foreign directory git happens to have registered under the worktrees root is not
    // ours to reason about: no `issue-<N>` handle, so it is never queried or removed.
    const h = harness({ handles: ['issue-9', 'scratch'], issues: { 9: { state: 'CLOSED', labels: [] } } })
    sweepWorktrees(ROOT, h.deps('github'))
    expect(h.queryCalls).toEqual(['9'])
    expect(h.gitLines).toContain(`worktree remove --force ${WT('issue-9')}`)
    expect(h.gitLines).not.toContain(`worktree remove --force ${WT('scratch')}`)
  })
})

// ---------------------------------------------------------------------------
// 3. Conservatism: an indeterminate query keeps the tree and warns
// ---------------------------------------------------------------------------

describe('sweepWorktrees keeps what it cannot classify (#223)', () => {
  it('keeps a worktree when the issue query fails, and warns on stderr', () => {
    const h = harness({ handles: ['issue-42'], issues: { 42: 'throw' } })
    sweepWorktrees(ROOT, h.deps('github'))

    expect(h.gitLines.some((l) => l.startsWith('worktree remove'))).toBe(false)
    expect(h.paths.has(WT('issue-42'))).toBe(true)
    expect(h.stderr.calls.join('')).toContain('issue-42')
  })

  it('keeps a worktree when the query returns nothing (indeterminate), and warns', () => {
    const h = harness({ handles: ['issue-42'], issues: {} })
    sweepWorktrees(ROOT, h.deps('github'))

    expect(h.gitLines.some((l) => l.startsWith('worktree remove'))).toBe(false)
    expect(h.paths.has(WT('issue-42'))).toBe(true)
    expect(h.stderr.calls.join('')).toContain('issue-42')
  })
})

// ---------------------------------------------------------------------------
// 4. A removal that cannot finish warns and does not stop the sweep
// ---------------------------------------------------------------------------

describe('sweepWorktrees never aborts on a removal it cannot finish (#223)', () => {
  it('warns on a stuck removal and still sweeps the next worktree', () => {
    const h = harness({
      handles: ['issue-1', 'issue-2'],
      issues: { 1: { state: 'CLOSED', labels: [] }, 2: { state: 'CLOSED', labels: [] } },
      rmThrowsFor: new Set([WT('issue-1')]),
    })
    // No throw escapes to the caller.
    expect(() => sweepWorktrees(ROOT, h.deps('github'))).not.toThrow()

    // The first removal is warned about…
    expect(h.stderr.calls.join('')).toContain('issue-1')
    // …and the second one still went through and was named on stdout.
    expect(h.stdout.calls.join('')).toContain('swept issue-2 (closed)')
    expect(h.paths.has(WT('issue-2'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Broken invocations still throw — that is the one thing sweep does not absorb
// ---------------------------------------------------------------------------

describe('sweepWorktrees refuses an unsafe root (#223)', () => {
  it('throws for a relative root before running any git', () => {
    const h = harness({})
    expect(() => sweepWorktrees('relative/root', h.deps('github'))).toThrow(/refusing/)
    expect(h.gitLines).toEqual([])
  })
})
