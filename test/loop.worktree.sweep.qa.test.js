import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
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

// QA augmentation for the loop-start sweep against REAL git (#223) — the end-to-end edges
// the dev's integration file (test/loop.worktree.sweep.test.js) does not drive. That file
// proves CLOSED-removed / OPEN-kept / hand-deleted-pruned with a gh stub that only ever
// answers with EMPTY label arrays. So two real properties go untested on disk:
//
//   1. the PENDING-MERGE path — an OPEN issue whose tree is removed because it carries the
//      label — which also exercises realQueryIssue's label-object -> name MAPPING that the
//      empty-array stub never touches; and
//   2. the CLI's refusal contract — an unsafe root exits 1 with the refusal on stderr and
//      touches no git — and the jira source pruning without consulting an issue.

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'worktree.js')

const CLOSED = 10
const OPEN = 20
const PENDING = 40
const HAND_DELETED = 30

let repo
let bindir

const wt = (n) => join(repo, '.ralph', 'worktrees', `issue-${n}`)

const registrations = () =>
  execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.startsWith('worktree '))

const addWorktree = (n) =>
  execFileSync('git', ['worktree', 'add', '-q', '-B', `issue-${n}`, wt(n), 'main'], { cwd: repo })

const sweep = (source = 'github') =>
  spawnSync(process.execPath, [CLI, 'sweep', repo, source], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bindir}:${process.env.PATH}` },
  })

beforeEach(() => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ralph-worktree-sweep-qa-'))
  bindir = join(sandbox, 'bin')
  mkdirSync(bindir, { recursive: true })

  // gh stub. The PENDING case answers with a label OBJECT ({"name":"pending-merge"}) — the
  // real `gh issue view --json labels` shape — so realQueryIssue's `.map(l => l?.name ?? l)`
  // is what turns it into the string the classifier compares. The empty-array cases in the
  // dev's stub never make that mapping do any work.
  const gh = join(bindir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/bash
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$3" in
    ${CLOSED}) echo '{"state":"CLOSED","labels":[]}' ;;
    ${OPEN}) echo '{"state":"OPEN","labels":[]}' ;;
    ${PENDING}) echo '{"state":"OPEN","labels":[{"name":"needs-review"},{"name":"pending-merge"}]}' ;;
    *) echo '{"state":"OPEN","labels":[]}' ;;
  esac
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  )

  const work = join(sandbox, 'work')
  mkdirSync(work, { recursive: true })
  execFileSync('git', ['init', '-q', '--initial-branch=main', work])
  execFileSync('git', ['config', 'user.email', 'ralph@example.test'], { cwd: work })
  execFileSync('git', ['config', 'user.name', 'Ralph Test'], { cwd: work })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: work })
  writeFileSync(join(work, 'README.md'), 'seed\n')
  execFileSync('git', ['add', '.'], { cwd: work })
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: work })
  repo = realpathSync(work)
  mkdirSync(join(repo, '.ralph', 'worktrees'), { recursive: true })
})

afterEach(() => {
  const sandbox = dirname(bindir)
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
})

describe('worktree.js sweep — pending-merge and CLI contract against real git (#223 QA)', () => {
  it('removes an OPEN issue that carries pending-merge, mapping the gh label object to its name', () => {
    addWorktree(PENDING)
    addWorktree(OPEN)
    expect(existsSync(wt(PENDING))).toBe(true)

    const res = sweep()
    expect(res.status, res.stderr).toBe(0)

    // The pending-merge tree AND its record are gone, named with the label as the reason.
    expect(existsSync(wt(PENDING))).toBe(false)
    expect(registrations()).not.toContain(`worktree ${wt(PENDING)}`)
    expect(res.stdout).toContain('swept issue-40 (pending-merge)')

    // The plain OPEN issue is untouched.
    expect(existsSync(wt(OPEN))).toBe(true)
    expect(registrations()).toContain(`worktree ${wt(OPEN)}`)
  })

  it('prunes a hand-deleted record whose issue is still OPEN, without removing any live tree', () => {
    // The open-issue protection only guards trees whose directory still exists; a record
    // git can prune because the directory is gone is dropped regardless of issue state.
    addWorktree(OPEN)
    addWorktree(HAND_DELETED) // gh stub answers OPEN for it too
    rmSync(wt(HAND_DELETED), { recursive: true, force: true })

    const res = sweep()
    expect(res.status, res.stderr).toBe(0)

    expect(registrations()).not.toContain(`worktree ${wt(HAND_DELETED)}`)
    // The live open tree survives.
    expect(existsSync(wt(OPEN))).toBe(true)
    expect(registrations()).toContain(`worktree ${wt(OPEN)}`)
    expect(res.stdout).not.toContain('swept')
  })

  it('under jira prunes a hand-deleted record but never removes a would-be-closed tree', () => {
    addWorktree(CLOSED)
    addWorktree(HAND_DELETED)
    rmSync(wt(HAND_DELETED), { recursive: true, force: true })

    const res = sweep('jira')
    expect(res.status, res.stderr).toBe(0)

    expect(registrations()).not.toContain(`worktree ${wt(HAND_DELETED)}`)
    expect(existsSync(wt(CLOSED))).toBe(true)
    expect(registrations()).toContain(`worktree ${wt(CLOSED)}`)
    expect(res.stdout).not.toContain('swept')
  })

  it('refuses the filesystem root: exit 1, a refusal on stderr, and no worktree touched', () => {
    addWorktree(CLOSED)
    const res = spawnSync(process.execPath, [CLI, 'sweep', '/', 'github'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bindir}:${process.env.PATH}` },
    })
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/refusing/)
    expect(res.stderr).toContain('worktree.js: sweep failed')
    // The real repo's worktree is untouched — the refusal fires before any git runs.
    expect(existsSync(wt(CLOSED))).toBe(true)
  })

  it('exits 2 (usage) when the source argument is missing', () => {
    const res = spawnSync(process.execPath, [CLI, 'sweep', repo], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bindir}:${process.env.PATH}` },
    })
    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(/usage:/)
  })
})
