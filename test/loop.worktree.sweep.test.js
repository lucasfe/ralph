import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// #223 — the loop-start sweep, against REAL git, driven through the CLI the loop calls.
//
// WHY REAL GIT HERE, like test/loop.worktree.test.js and unlike the unit suite. The whole
// claim of #223 is a property of a git repository on disk: after a sweep, a closed issue's
// worktree directory AND git's administrative record of it are both gone, an open issue's
// survive intact, and a record whose directory was deleted by hand is pruned. A `git`
// double can assert none of that — it would pass just as happily against a sweep that
// pruned nothing. So `git` is real and only `gh` is a stub, put on PATH so the CLI's own
// default `gh` runner resolves to it and one issue reads CLOSED while another reads OPEN.
//
// It exercises the CLI directly rather than the whole loop: the loop wiring is asserted by
// the executable-line guard in test/loop.worktree.test.js, and what is under test here is
// the module's effect on a repository, which the CLI is the honest entry point to.

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'worktree.js')

// Issue numbers the gh stub classifies: one done, one still open, one whose directory this
// test deletes by hand (so the sweep only ever sees its stale record, never queries it).
const CLOSED = 10
const OPEN = 20
const HAND_DELETED = 30

let repo
let bindir

const wt = (n) => join(repo, '.ralph', 'worktrees', `issue-${n}`)

// One line per registered worktree — how "git kept no stale record" / "the record survives"
// is asked of a real repository.
const registrations = () =>
  execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.startsWith('worktree '))

const addWorktree = (n) =>
  execFileSync('git', ['worktree', 'add', '-q', '-B', `issue-${n}`, wt(n), 'main'], { cwd: repo })

const sweep = () =>
  spawnSync(process.execPath, [CLI, 'sweep', repo, 'github'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bindir}:${process.env.PATH}` },
  })

beforeEach(() => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ralph-worktree-sweep-'))
  bindir = join(sandbox, 'bin')
  mkdirSync(bindir, { recursive: true })

  // gh stub: `gh issue view <n> --json state,labels`. The number is the third arg.
  const gh = join(bindir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/bash
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$3" in
    ${CLOSED}) echo '{"state":"CLOSED","labels":[]}' ;;
    ${OPEN}) echo '{"state":"OPEN","labels":[]}' ;;
    *) echo '{"state":"OPEN","labels":[]}' ;;
  esac
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  )
  chmodSync(gh, 0o755)

  // A real repository with one commit on main.
  const work = join(sandbox, 'work')
  mkdirSync(work, { recursive: true })
  execFileSync('git', ['init', '-q', '--initial-branch=main', work])
  execFileSync('git', ['config', 'user.email', 'ralph@example.test'], { cwd: work })
  execFileSync('git', ['config', 'user.name', 'Ralph Test'], { cwd: work })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: work })
  writeFileSync(join(work, 'README.md'), 'seed\n')
  execFileSync('git', ['add', '.'], { cwd: work })
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: work })
  // git resolves symlinks in the paths it prints (/var → /private/var on macOS), and so
  // does the CLI's derivation, so pin the repo to the real path every assertion is made in.
  repo = realpathSync(work)
  mkdirSync(join(repo, '.ralph', 'worktrees'), { recursive: true })
})

afterEach(() => {
  const sandbox = dirname(bindir)
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
})

describe('worktree.js sweep — the loop-start sweep against real git (#223)', () => {
  it('removes the closed issue tree, keeps the open one, prunes a hand-deleted record', () => {
    addWorktree(CLOSED)
    addWorktree(OPEN)
    addWorktree(HAND_DELETED)
    // Simulate a directory a human deleted: the tree is gone, but git still has the record.
    rmSync(wt(HAND_DELETED), { recursive: true, force: true })

    // Anti-vacuity: all three are registered and two are on disk before the sweep.
    expect(registrations()).toHaveLength(4) // main + three worktrees
    expect(existsSync(wt(CLOSED))).toBe(true)
    expect(existsSync(wt(OPEN))).toBe(true)

    const res = sweep()
    expect(res.status, res.stderr).toBe(0)

    // The closed issue's directory AND its record are gone.
    expect(existsSync(wt(CLOSED))).toBe(false)
    expect(registrations()).not.toContain(`worktree ${wt(CLOSED)}`)
    // …and the sweep named it on stdout.
    expect(res.stdout).toContain('swept issue-10 (closed)')

    // The open issue's directory and record both survive — it is work a human may want.
    expect(existsSync(wt(OPEN))).toBe(true)
    expect(registrations()).toContain(`worktree ${wt(OPEN)}`)
    expect(res.stdout).not.toContain('issue-20')

    // The hand-deleted worktree's stale record was pruned.
    expect(registrations()).not.toContain(`worktree ${wt(HAND_DELETED)}`)
    // Only the main tree and the surviving open worktree remain registered.
    expect(registrations()).toEqual([`worktree ${repo}`, `worktree ${wt(OPEN)}`])
  })

  it('under folder mode prunes a hand-deleted record without touching a closed issue tree', () => {
    // No issue to query: even a tree whose number the gh stub would call CLOSED is left
    // alone, and only the git-prunable record is dropped.
    addWorktree(CLOSED)
    addWorktree(HAND_DELETED)
    rmSync(wt(HAND_DELETED), { recursive: true, force: true })

    const res = spawnSync(process.execPath, [CLI, 'sweep', repo, 'folder'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bindir}:${process.env.PATH}` },
    })
    expect(res.status, res.stderr).toBe(0)

    // Prune happened…
    expect(registrations()).not.toContain(`worktree ${wt(HAND_DELETED)}`)
    // …but the closed issue's tree is untouched: folder mode consults no issue.
    expect(existsSync(wt(CLOSED))).toBe(true)
    expect(registrations()).toContain(`worktree ${wt(CLOSED)}`)
    expect(res.stdout).not.toContain('swept')
  })
})
