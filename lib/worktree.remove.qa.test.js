import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeWorktree } from './worktree.js'

// QA augmentation for removeWorktree — the path #220 hung its warning off.
//
// Before #220, `removeWorktree` failing was invisible: templates/ralph.sh called it with
// `|| true` and moved on. Now the loop BRANCHES on its exit status and prints a sentence
// naming a directory it claims is still on disk, so the module's failure path stopped
// being decoration and became a contract. What was covered of it:
//
//   lib/worktree.test.js  removes through git; falls back to the fs when git leaves the
//                         directory; no-op success; the lock escalation in both
//                         directions; the unsafe-root refusal.
//   lib/worktree.qa.test.js  the exact recursive-delete target; "silent when git did not
//                         decline"; multi-line diagnostics collapsed to one line; the
//                         branch is never deleted; prune of a stale registration.
//
// What NONE of them drives is the case the loop's new warning exists for: git declines
// AND the sweep cannot finish either. Every existing failure test stops one step short —
// the sweep always succeeds, so `removeWorktree` always returns true and the CLI always
// exits 0. This file drives the step past that, in the four shapes it comes in, plus the
// ordering question an actually-firing sweep makes askable and the errno the loop's
// comment quotes.
//
// SEAMS, matching lib/worktree.test.js's: an `fs` object of the three verbs
// removeWorktree touches, a `git` function returning `{status, stdout, stderr}`, and a
// `stderr` sink. Section 5 leaves the doubles behind for the real CLI, because the exact
// errno text a comment in templates/ralph.sh quotes is a fact about node and the
// filesystem, not about this module.

const HOME = '/home/dev'
const ROOT = '/repo'
const WT = '/repo/.ralph/worktrees/issue-7'

// git's refusals, verbatim from git 2.50.1 (Apple Git-155):
//  - a LOCKED worktree, which is what `--force` alone hits;
//  - what `--force --force` answers once a failed `--force` has already DEREGISTERED the
//    worktree, measured with `.ralph/worktrees` at mode 0500. That pair is the real
//    both-spellings-declined sequence, so it is the one scripted below.
const LOCKED =
  "fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first\n"
const NOT_A_WORKING_TREE = `fatal: '${WT}' is not a working tree\n`

const makeStderr = () => {
  const calls = []
  return { calls, write: (m) => calls.push(m) }
}

// One trace across BOTH seams, because most of what is asked below is about what did or
// did not happen AFTER a failure — "was the record pruned?", "was the warning written
// before the sweep was attempted?" — and separate spies cannot order themselves.
function harness({ decline = null, present = [WT], rmThrows = null } = {}) {
  const steps = []
  const gitLines = []
  const stderr = makeStderr()
  const paths = new Set([...present, '/repo/.git'])

  const git = (args, opts = {}) => {
    const line = args.join(' ')
    gitLines.push(line)
    steps.push(`git ${line}`)
    if (line.startsWith('worktree remove') && decline) return { status: 0, stderr: '', ...decline(line) }
    return { status: 0, stdout: '', stderr: '' }
  }

  const fs = {
    existsSync: (p) => paths.has(p),
    mkdirSync: (p) => paths.add(p),
    rmSync: (p) => {
      steps.push(`rm ${p}`)
      if (rmThrows) throw rmThrows
      paths.delete(p)
    },
  }

  return { git, fs, stderr, steps, gitLines, paths, deps: { fs, git, home: HOME, stderr } }
}

// The realistic shape: BOTH spellings decline, with the two messages git really produces.
const bothDecline = () => (line) =>
  line.includes('--force --force')
    ? { status: 128, stderr: NOT_A_WORKING_TREE }
    : { status: 255, stderr: `error: failed to delete '${WT}': Permission denied\n` }

// ---------------------------------------------------------------------------
// 1. git declined AND the sweep cannot finish — the case the loop's warning is for
// ---------------------------------------------------------------------------
//
// From templates/ralph.sh's remove_issue_worktree header: "lib/worktree.js exits non-zero
// only when the tree outlived both git and the fs". That sentence is the whole contract
// between the two files, and nothing exercised the state it describes.

describe('removeWorktree when the filesystem refuses too (#220 QA)', () => {
  it('lets the errno propagate instead of returning true, so the caller can warn', () => {
    const boom = Object.assign(new Error(`EACCES: permission denied, rmdir '${WT}'`), {
      code: 'EACCES',
      syscall: 'rmdir',
    })
    const h = harness({ decline: bothDecline(), rmThrows: boom })

    // NOT `toBe(true)` and not a swallowed false: the only signal a shell caller can read
    // is the exit status, and the CLI produces that from a throw. A `removeWorktree` that
    // caught this would make the loop's warning unreachable and its "leaving … in place"
    // sentence unprintable in the one case it is true.
    expect(() => removeWorktree(ROOT, 'issue-7', h.deps)).toThrow(
      `EACCES: permission denied, rmdir '${WT}'`,
    )

    // The module said what git said BEFORE it tried the sweep, so a human reading the pane
    // gets both halves: git's reason, then node's.
    expect(h.stderr.calls).toHaveLength(1)
    expect(h.stderr.calls[0]).toBe(
      `⚠️  worktree: git worktree remove declined ${WT} (fatal: '${WT}' is not a working tree) — deleting the directory\n`,
    )
  })

  it('does not prune after a sweep that threw, because the record is all that is left', () => {
    // `git worktree prune` sits AFTER the sweep and only drops records whose directory is
    // missing, so a throw skipping it costs nothing: the directory is still there, and a
    // prune would find nothing to do. What matters is that this is DELIBERATE and stays
    // that way — a prune moved above the sweep would run here and drop the record while
    // the directory survives, which is the orphaned-directory state the module's own
    // ordering comment exists to prevent and which no `worktree prune` can undo.
    const h = harness({ decline: bothDecline(), rmThrows: new Error('EACCES') })
    expect(() => removeWorktree(ROOT, 'issue-7', h.deps)).toThrow()

    expect(h.gitLines).toEqual([
      `worktree remove --force ${WT}`,
      `worktree remove --force --force ${WT}`,
    ])
    expect(h.gitLines).not.toContain('worktree prune')
    // And the last thing attempted was the sweep, not a git call.
    expect(h.steps.at(-1)).toBe(`rm ${WT}`)
  })

  it('propagates a sweep failure even when git reported SUCCESS, and says nothing extra', () => {
    // git exits 0 and the directory is still there — the shape a network filesystem or a
    // half-applied delete produces. The warning is gated on git's status, not on the
    // sweep's, so there is nothing to explain about git; the throw still has to escape,
    // because the tree really did survive and the loop really does need to say so.
    const h = harness({ rmThrows: new Error(`EPERM: operation not permitted, rmdir '${WT}'`) })
    expect(() => removeWorktree(ROOT, 'issue-7', h.deps)).toThrow(/EPERM/)
    expect(h.stderr.calls).toEqual([])
    expect(h.gitLines).toEqual([`worktree remove --force ${WT}`])
  })
})

// ---------------------------------------------------------------------------
// 2. git declined but there is nothing left to sweep
// ---------------------------------------------------------------------------
//
// The complement, and the one that decides whether the loop's warning is trustworthy.
// MEASURED on git 2.50.1 (Apple Git-155): a `worktree remove --force` that fails on
// permissions has ALREADY deregistered the worktree, so the escalation's `fatal: … is not
// a working tree` is what a partly-succeeded removal looks like. If the directory went
// with it, nothing was left behind — and a warning here would send a human looking for a
// directory that is not there.

describe('removeWorktree when git declined but the directory is already gone (#220 QA)', () => {
  it('succeeds silently, sweeps nothing, and still prunes the record', () => {
    const h = harness({ decline: bothDecline(), present: [] })
    expect(removeWorktree(ROOT, 'issue-7', h.deps)).toBe(true)

    // No warning: the sentence it would print ("deleting the directory") would be false,
    // and the loop's would be too.
    expect(h.stderr.calls).toEqual([])
    // No recursive delete aimed at a path that does not exist…
    expect(h.steps.filter((s) => s.startsWith('rm '))).toEqual([])
    // …and the prune still runs, which is the call that clears the record git left when
    // it deregistered and then failed. Skipping it would leave the next create for this
    // handle inheriting a state git refuses.
    expect(h.gitLines).toContain('worktree prune')
  })
})

// ---------------------------------------------------------------------------
// 3. The prune ordering, with a sweep that actually fires
// ---------------------------------------------------------------------------
//
// The module's ordering comment argues the prune must come AFTER the sweep, since a prune
// only drops records whose directory is missing. Both existing escalation tests assert
// `rmTargets` is EMPTY — git finished the job — so the sweep has never run in the same
// test as the prune, and the order of the two has never been observed.

describe('removeWorktree prunes after the sweep, not before it (#220 QA)', () => {
  it('interleaves remove, escalate, sweep, prune — in that order', () => {
    const h = harness({ decline: bothDecline() })
    expect(removeWorktree(ROOT, 'issue-7', h.deps)).toBe(true)

    expect(h.steps).toEqual([
      `git worktree remove --force ${WT}`,
      `git worktree remove --force --force ${WT}`,
      `rm ${WT}`,
      'git worktree prune',
    ])
    // The prune came last, so it ran against a MISSING directory, which is the only state
    // it can act on.
    expect(h.paths.has(WT)).toBe(false)
  })

  it('still prunes when only ONE remove was needed and the sweep had to finish it', () => {
    // git accepted the gentle spelling but left the directory: no escalation, a sweep, and
    // the prune after it. Distinguishes "prune follows the sweep" from "prune follows the
    // escalation", which the test above alone cannot.
    const h = harness({ decline: () => ({ status: 0 }) })
    expect(removeWorktree(ROOT, 'issue-7', h.deps)).toBe(true)
    expect(h.steps).toEqual([`git worktree remove --force ${WT}`, `rm ${WT}`, 'git worktree prune'])
    // A clean exit from git means nothing to report, even though the sweep did the work.
    expect(h.stderr.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. What the warning says when git says nothing
// ---------------------------------------------------------------------------
//
// The message has a fallback — `firstLine(removed.stderr) || \`exit ${removed.status}\`` —
// and lib/worktree.qa.test.js covers the multi-line case but not the empty one, where the
// fallback is the whole content of the parenthesis.

describe('the declined-removal warning always carries a reason (#220 QA)', () => {
  it('falls back to the exit status when git declined without a word', () => {
    const h = harness({ decline: () => ({ status: 255, stderr: '' }) })
    expect(removeWorktree(ROOT, 'issue-7', h.deps)).toBe(true)
    expect(h.stderr.calls[0]).toBe(
      `⚠️  worktree: git worktree remove declined ${WT} (exit 255) — deleting the directory\n`,
    )
  })

  it('reports the reason the ESCALATION gave, not the reason the first refusal gave', () => {
    // Both spellings declined for different reasons. The one worth printing is the last
    // one, because the first is expected on every locked tree and says nothing about why
    // the removal ultimately failed — and a warning quoting `use 'remove -f -f' to
    // override` after the module already did exactly that would read as a bug.
    const h = harness({
      decline: (line) =>
        line.includes('--force --force')
          ? { status: 255, stderr: `error: failed to delete '${WT}': Permission denied\n` }
          : { status: 128, stderr: LOCKED },
    })
    expect(removeWorktree(ROOT, 'issue-7', h.deps)).toBe(true)
    expect(h.stderr.calls[0]).toContain("error: failed to delete")
    expect(h.stderr.calls[0]).not.toContain('remove -f -f')
  })
})

// ---------------------------------------------------------------------------
// 5. The CLI's failure line, against a real filesystem
// ---------------------------------------------------------------------------
//
// templates/ralph.sh's remove_issue_worktree header quotes an errno: "the fs sweep raises
// `EACCES: permission denied, unlink '<path>/undeletable/x'`, which its CLI prints as
// `worktree.js: remove failed (…)` before exiting 1." That is a claim about node and the
// filesystem, so the doubles above cannot check it — and the exit status is what the
// loop's whole new branch reads. Both permission shapes are measured here because they
// produce DIFFERENT syscalls, and only one of them is the one the comment quotes.

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'worktree.js')
// 0500 is still writable by root, for whom both removals below would simply succeed.
const NOT_ROOT = typeof process.getuid !== 'function' || process.getuid() !== 0

describe('worktree.js remove — the CLI contract on a jammed sweep (#220 QA)', () => {
  let repo
  let wt

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ralph-worktree-remove-qa-'))
    execFileSync('git', ['init', '-q', '--initial-branch=main', repo])
    execFileSync('git', ['config', 'user.email', 'ralph@example.test'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Ralph Test'], { cwd: repo })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo })
    writeFileSync(join(repo, 'README.md'), 'seed\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo })
    wt = join(repo, '.ralph', 'worktrees', 'issue-7')
    mkdirSync(join(repo, '.ralph', 'worktrees'), { recursive: true })
    execFileSync('git', ['worktree', 'add', '-q', '-B', 'issue-7', wt, 'main'], { cwd: repo })
  })

  afterEach(() => {
    // Undo whatever a test locked down, or the sandbox delete cannot finish either.
    for (const p of [join(repo, '.ralph', 'worktrees'), join(wt, 'undeletable')]) {
      if (existsSync(p)) {
        try {
          chmodSync(p, 0o755)
        } catch {
          /* already writable */
        }
      }
    }
    rmSync(repo, { recursive: true, force: true })
  })

  const remove = () =>
    spawnSync(process.execPath, [CLI, 'remove', repo, 'issue-7'], { encoding: 'utf8' })

  it('exits 0 and says nothing when the removal goes through', () => {
    // Anti-vacuity for the two below: this fixture's removal is ordinarily silent and
    // clean, so a non-zero exit there is caused by the permission drop and nothing else.
    const res = remove()
    expect(res.status).toBe(0)
    expect(res.stderr).toBe('')
    expect(existsSync(wt)).toBe(false)
  })

  it.runIf(NOT_ROOT)('exits 1 with an `unlink` errno when a directory INSIDE the tree is sealed', () => {
    // The comment's own case. MEASURED (git 2.50.1 Apple Git-155 / node v20.20.2): a file
    // inside a mode-0500 directory cannot be unlinked, so the recursive sweep fails on the
    // FILE and the errno names `unlink`.
    mkdirSync(join(wt, 'undeletable'))
    writeFileSync(join(wt, 'undeletable', 'x'), 'pinned\n')
    chmodSync(join(wt, 'undeletable'), 0o500)

    const res = remove()
    expect(res.status).toBe(1)
    expect(res.stdout).toBe('')
    // Exactly the two lines the loop's comment describes: git's reason, then node's.
    const lines = res.stderr.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(
      `⚠️  worktree: git worktree remove declined ${wt} (fatal: '${wt}' is not a working tree) — deleting the directory`,
    )
    expect(lines[1]).toBe(
      `worktree.js: remove failed (EACCES: permission denied, unlink '${join(wt, 'undeletable', 'x')}')`,
    )
    // The warning is not a false alarm: the tree really did outlive both attempts.
    expect(existsSync(wt)).toBe(true)
  })

  it.runIf(NOT_ROOT)('exits 1 with an `rmdir` errno when the worktrees PARENT is sealed', () => {
    // A different jam and a different syscall, which is why the comment's `unlink` cannot
    // stand in for it. MEASURED (git 2.50.1 Apple Git-155 / node v20.20.2): everything
    // inside the tree is deletable, so the sweep gets all the way to removing the
    // directory ENTRY and fails there — `rmdir`, not `unlink`. Same exit code, same first
    // line, so the loop's branch and warning are unaffected; pinned so that a reader who
    // meets this in a pane can see it is the documented failure and not a new one.
    chmodSync(join(repo, '.ralph', 'worktrees'), 0o500)

    const res = remove()
    expect(res.status).toBe(1)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain(
      `⚠️  worktree: git worktree remove declined ${wt} (fatal: '${wt}' is not a working tree)`,
    )
    expect(res.stderr).toContain(`worktree.js: remove failed (EACCES: permission denied, rmdir '${wt}')`)
    expect(existsSync(wt)).toBe(true)
  })

  it.runIf(NOT_ROOT)('leaves NO registration behind either way, so the retry has to rebuild it', () => {
    // The cost of the jam, stated once: git's first `--force` deregistered the worktree
    // before failing, so what survives is a DIRECTORY, not a worktree — `git -C <path>
    // status` no longer works in it, and the create path's `worktree add -B` is what
    // makes it a worktree again. Worth pinning because the loop's warning says "leaving
    // .ralph/worktrees/issue-N in place", which a reader could take to mean the worktree
    // rather than its contents.
    chmodSync(join(repo, '.ralph', 'worktrees'), 0o500)
    expect(remove().status).toBe(1)

    const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
    expect(listed).toEqual([`worktree ${execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()}`])
    // The branch is untouched — the module never deletes one, and it is half of what a
    // human reads.
    expect(execFileSync('git', ['branch', '--list', 'issue-7'], { cwd: repo, encoding: 'utf8' }).trim()).not.toBe('')
  })
})
