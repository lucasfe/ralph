import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'

// #221 — a folder task is resolved in a DETACHED worktree, and afterwards the loop
// either advances $DEV_BRANCH itself or parks the commit on `ralph/task-N`.
//
// WHY REAL GIT, like test/loop.worktree.test.js and unlike test/loop.test.js
// Every claim in this slice is a property of a repository: which ref moved, which one
// did not, what the user's working tree still holds afterwards. A `git` stub that
// `exit 0`s cannot tell an advance from a park — it would answer "yes" to both.
//
// WHY THE FIXTURE'S `origin` IS DELIBERATELY STALE
// The main root is one commit AHEAD of `origin/main`: commit A is pushed, commit B is
// local-only. Folder mode never pushes, so if the worktree were cut from
// `origin/$DEV_BRANCH` (which is what the github arm does) iteration 2 would silently
// drop iteration 1's work. B is what makes that mistake visible — the agent's commit
// has to have B as its PARENT, which is only true if the LOCAL branch was the base and
// nothing was fetched before the create. (The loop's end-of-run cleanup does fetch, once,
// after every iteration is over: that is #218's replacement for `git pull` and it moves
// no local branch, so it is invisible to every claim here.)
//
// THE AGENT STUB COMMITS FOR REAL, on the detached HEAD it wakes on, because "the loop
// advanced the branch to the agent's commit" and "the loop parked that commit on
// ralph/task-N" are both statements about a real commit object.
//
// THE THREE STATES DRIVEN HERE are the ones whose difference is only visible through a
// real repository:
//   • main tree on $DEV_BRANCH and CLEAN     -> fast-forward, no branch switch
//   • main tree on $DEV_BRANCH and DIRTY     -> park, write nothing, warn
//   • $DEV_BRANCH checked out NOWHERE        -> update the ref, never touch the tree
// lib/worktree.test.js owns the rest of the decision table against an injected git.
//
// HERMETIC: nothing here touches this repository. The fixture is a fresh clone-shaped
// repo with its own bare `origin` under the OS temp dir, and afterEach removes the whole
// sandbox.

const RALPH_TEMPLATE = templatePath('ralph.sh')
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

let sandbox
let workdir
let root
let originDir
let bindir
let localOnlySha

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

// Real git, against the fixture's MAIN working tree unless told otherwise.
function git(args, cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function gitOk(args, cwd = root) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function runLoop({ timeout = 60000, extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-worktree-folder-test',
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
    // Passed on the CHILD env, not assigned here: test/setup/hermetic-env.js deletes
    // DEV_BRANCH from the worker because templates/ralph.config.sh declares it, and the
    // fixture writes no ralph.config.sh of its own.
    DEV_BRANCH: 'main',
    TASK_SOURCE: 'folder',
    ...extraEnv,
  }
  return spawnSync('bash', [RALPH_TEMPLATE], { cwd: workdir, env, timeout, encoding: 'utf8' })
}

const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const sandboxFile = (name) => join(sandbox, name)
const worktreeDir = (handle = 'task-1') => join(root, '.ralph', 'worktrees', handle)

const registrations = () =>
  git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))

const DIRTY_README = 'seed\nlocal edit not committed\n'

function seedTask() {
  const dir = join(workdir, '.ralph', 'tasks', 'afk', 'todo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '001-first.md'), 'do the thing')
}

// The folder agent, doing on a detached HEAD exactly what the folder orchestrator
// prompt now asks for: commit here, create no branch, and move the task file in the
// MAIN root (the `.ralph/` tree is gitignored, so it exists in no checkout but that
// one). The paths are absolute and hardcoded rather than read out of the prompt: what
// is under test is the loop, and a stub that parsed its own instructions could pass by
// agreeing with a wrong prompt.
function folderAgent() {
  writeStub(
    'claude',
    `#!/bin/bash
cat > "${sandboxFile('prompt.txt')}"
pwd -P > "${sandboxFile('agent-cwd.txt')}"
git rev-parse --abbrev-ref HEAD > "${sandboxFile('agent-branch.txt')}" 2>&1
git symbolic-ref -q HEAD > "${sandboxFile('agent-symbolic-ref.txt')}" 2>&1 || echo "(detached)" > "${sandboxFile('agent-symbolic-ref.txt')}"
TODO="${join(root, '.ralph', 'tasks', 'afk', 'todo')}"
DONE="${join(root, '.ralph', 'tasks', 'afk', 'done')}"
mkdir -p "$DONE"
f=$(ls "$TODO"/*.md 2>/dev/null | sort | head -1)
[ -n "$f" ] && mv "$f" "$DONE/"
echo "hello from the agent" > agent-file.txt
git add agent-file.txt
git commit -q -m "feat: agent work (task #1)"
git rev-parse HEAD > "${sandboxFile('agent-head.txt')}"
git branch --list > "${sandboxFile('agent-branches.txt')}"
echo '{"type":"result","subtype":"success"}'
exit 0
`,
  )
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ralph-worktree-folder-'))
  originDir = join(sandbox, 'origin.git')
  workdir = join(sandbox, 'work')
  bindir = join(sandbox, 'bin')
  mkdirSync(bindir, { recursive: true })

  execFileSync('git', ['init', '--bare', '--initial-branch=main', originDir])
  mkdirSync(workdir, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: workdir })
  // Identity + no signing on the REPOSITORY config, which a worktree shares
  // ($GIT_DIR/config is not per-worktree) — that is what lets the agent stub commit
  // inside the tree the loop hands it.
  execFileSync('git', ['config', 'user.email', 'ralph@example.test'], { cwd: workdir })
  execFileSync('git', ['config', 'user.name', 'Ralph Test'], { cwd: workdir })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: workdir })
  // `.ralph/` is what `ralph init` appends, so a live worktree under `.ralph/worktrees`
  // and the task files under `.ralph/tasks` are not untracked content in the status
  // assertions below; `logs/` is this fixture's own, for the transcripts.
  writeFileSync(join(workdir, '.gitignore'), '.ralph/\nlogs/\n')
  writeFileSync(join(workdir, 'README.md'), 'seed\n')
  execFileSync('git', ['add', '.'], { cwd: workdir })
  execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: workdir })
  execFileSync('git', ['remote', 'add', 'origin', originDir], { cwd: workdir })
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: workdir })

  // COMMIT B — the previous folder iteration's work, committed locally and never
  // pushed. origin/main stays at A. Every test below asserts against this sha.
  writeFileSync(join(workdir, 'from-iteration-1.txt'), 'committed locally, never pushed\n')
  execFileSync('git', ['add', 'from-iteration-1.txt'], { cwd: workdir })
  execFileSync('git', ['commit', '-q', '-m', 'chore: local only, never pushed'], { cwd: workdir })

  // git resolves symlinks in `rev-parse --show-toplevel`, and the macOS temp dir is one
  // (/var → /private/var), so PROJECT_ROOT inside the loop is the REAL path and every
  // assertion has to use that spelling.
  root = realpathSync(workdir)
  localOnlySha = git(['rev-parse', 'HEAD']).trim()

  mkdirSync(join(workdir, 'logs'), { recursive: true })
  mkdirSync(join(workdir, '.ralph'), { recursive: true })
  writeFileSync(join(workdir, '.ralph', 'state.json'), '{}')

  writeStub('node', `#!/bin/bash\nexec "${REAL_NODE}" "$@"\n`)
  folderAgent()
  writeStub(
    'jq',
    `#!/bin/bash
for a in "$@"; do
  case "$a" in
    *".type"*)
      while IFS= read -r line; do printf '%s\\n' "$line"; done
      exit 0
      ;;
  esac
done
cat > /dev/null 2>/dev/null || true
exit 0
`,
  )
  // Present so the dependency check passes; folder mode must never call it.
  writeStub('gh', `#!/bin/bash\necho "$*" >> "${sandboxFile('gh-calls.log')}"\nexit 0\n`)
  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
})

afterEach(() => {
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. The tree the folder agent wakes in
// ---------------------------------------------------------------------------

describe('ralph.sh folder arm — the task is resolved in a detached worktree (#221)', () => {
  it('runs the agent detached at the LOCAL dev-branch tip, fetching nothing first and branching nothing', () => {
    seedTask()
    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)

    // The agent ran in the worktree, not in the user's checkout.
    expect(readIf(sandboxFile('agent-cwd.txt')).trim()).toBe(worktreeDir('task-1'))

    // DETACHED: `rev-parse --abbrev-ref HEAD` prints the literal `HEAD` there, and
    // `symbolic-ref -q HEAD` has nothing to print. MEASURED on git 2.50.1 (Apple
    // Git-155) after `git worktree add --detach <path> main`.
    expect(readIf(sandboxFile('agent-branch.txt')).trim()).toBe('HEAD')
    expect(readIf(sandboxFile('agent-symbolic-ref.txt')).trim()).toBe('(detached)')

    // NO `task-1` BRANCH WAS CREATED, which is the whole reason for --detach: the
    // branch folder mode commits to is already checked out in the main tree, and git
    // refuses to hand the same branch to a second worktree.
    expect(readIf(sandboxFile('agent-branches.txt'))).not.toContain('task-1')

    // THE BASE WAS THE LOCAL BRANCH, not origin/main: the agent's commit sits directly
    // on top of the never-pushed commit B. A fetch-and-base-on-origin create would
    // have made A the parent and dropped B's file from the tree entirely.
    const agentSha = readIf(sandboxFile('agent-head.txt')).trim()
    expect(git(['rev-parse', `${agentSha}^`]).trim()).toBe(localOnlySha)
    expect(git(['rev-parse', 'origin/main']).trim()).not.toBe(localOnlySha)
  })

  it('tells the agent its project root is the worktree and its task lane is the main root', () => {
    seedTask()
    runLoop()
    const prompt = readIf(sandboxFile('prompt.txt'))
    // {{PROJECT_ROOT}} — where the code is.
    expect(prompt).toContain(`Your project root is \`${worktreeDir('task-1')}\``)
    // {{MAIN_REPO_ROOT}} — where `.ralph/tasks/` is. The two are different paths in
    // folder mode, and the task files are gitignored, so they exist in the main root
    // ONLY: a bare `.ralph/tasks/afk/todo/` would point the agent at an empty
    // directory inside its own worktree.
    expect(prompt).toContain(`${root}/.ralph/tasks/afk/todo/`)
    expect(prompt).toContain(`${root}/.ralph/tasks/afk/done/`)
  })

  it('never invokes gh', () => {
    seedTask()
    runLoop()
    expect(
      existsSync(sandboxFile('gh-calls.log')),
      `gh was invoked in folder mode:\n${readIf(sandboxFile('gh-calls.log'))}`,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Advancing the branch — the two ways it is allowed to happen
// ---------------------------------------------------------------------------

describe('ralph.sh folder arm — the loop advances the dev branch after the agent (#221)', () => {
  it('fast-forwards a clean main tree without switching its branch', () => {
    seedTask()
    expect(git(['status', '--porcelain'])).toBe('')

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(res.status).toBe(0)

    const agentSha = readIf(sandboxFile('agent-head.txt')).trim()
    // The commit was made OUTSIDE this tree, in the worktree — which is what makes the
    // rest of this test about the loop's fast-forward rather than about the agent
    // having committed here directly.
    expect(readIf(sandboxFile('agent-cwd.txt')).trim()).toBe(worktreeDir('task-1'))

    // The branch moved to the agent's commit…
    expect(git(['rev-parse', 'main']).trim()).toBe(agentSha)
    // …and the reflog says HOW: a fast-forward, not a commit made here and not a
    // reset. MEASURED on git 2.50.1 (Apple Git-155) — `git merge --ff-only <sha>` in a
    // clean tree writes `main@{0} merge <sha>: Fast-forward`, where a commit in this
    // tree would have written `commit: <subject>`.
    expect(git(['reflog', 'show', '--format=%gs', 'main']).split('\n')[0]).toBe(
      `merge ${agentSha}: Fast-forward`,
    )
    // …IN PLACE: HEAD is still the same symbolic ref it was, so no checkout, no
    // switch, no detach happened in the user's tree.
    expect(git(['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main')
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(agentSha)
    // A fast-forward in a checked-out tree updates that tree, which is the point:
    // the user's checkout now holds the work rather than lagging behind its own branch.
    expect(existsSync(join(root, 'agent-file.txt'))).toBe(true)
    // Nothing was parked, because nothing had to be.
    expect(gitOk(['rev-parse', '--verify', '--quiet', 'refs/heads/ralph/task-1']).status).not.toBe(
      0,
    )
  })

  it('updates the ref directly when the dev branch is checked out nowhere', () => {
    // The user is off on their own branch with uncommitted work. `main` is checked out
    // in no worktree, so there is no tree to fast-forward and no tree to disturb: the
    // ref itself is written, and the user's checkout is not consulted at all.
    git(['checkout', '-q', '-b', 'feature/x'])
    writeFileSync(join(root, 'README.md'), DIRTY_README)
    const before = {
      head: git(['symbolic-ref', 'HEAD']).trim(),
      sha: git(['rev-parse', 'HEAD']).trim(),
      status: git(['status', '--porcelain']),
    }

    seedTask()
    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)

    const agentSha = readIf(sandboxFile('agent-head.txt')).trim()
    expect(git(['rev-parse', 'main']).trim()).toBe(agentSha)

    // THE USER'S TREE IS EXACTLY AS THEY LEFT IT: same branch, same commit, same
    // uncommitted edit, and the agent's file is not in it.
    expect(git(['symbolic-ref', 'HEAD']).trim()).toBe(before.head)
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(before.sha)
    expect(git(['status', '--porcelain'])).toBe(before.status)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(DIRTY_README)
    expect(existsSync(join(root, 'agent-file.txt'))).toBe(false)

    // A write that succeeded parks nothing.
    expect(gitOk(['rev-parse', '--verify', '--quiet', 'refs/heads/ralph/task-1']).status).not.toBe(
      0,
    )
  })
})

// ---------------------------------------------------------------------------
// 3. Parking — a branch Ralph could not advance is not a task Ralph failed
// ---------------------------------------------------------------------------

describe('ralph.sh folder arm — an unadvanceable branch parks the commit and warns (#221)', () => {
  it('writes nothing, parks on ralph/task-N, names branch and sha on stderr, and keeps the verdict', () => {
    // The user is editing a tracked file in the main tree, on the very branch the loop
    // wants to move. MEASURED on git 2.50.1 (Apple Git-155): a fast-forward here often
    // SUCCEEDS (git only refuses when the incoming diff touches a path the tree has
    // dirty), and `update-ref` on a checked-out branch succeeds unconditionally and
    // leaves the tree reading `D  <file>` for everything the new commit does not have.
    // Neither is something Ralph may do to a human's uncommitted work, so a dirty main
    // tree is a park — this refusal is Ralph's own conservatism, not git's.
    writeFileSync(join(root, 'README.md'), DIRTY_README)
    seedTask()

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()

    const agentSha = readIf(sandboxFile('agent-head.txt')).trim()

    // NOTHING WAS WRITTEN to the branch or to the tree.
    expect(git(['rev-parse', 'main']).trim()).toBe(localOnlySha)
    expect(git(['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main')
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(localOnlySha)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(DIRTY_README)
    expect(existsSync(join(root, 'agent-file.txt'))).toBe(false)

    // THE COMMIT IS NOT LOST: it is reachable from a branch a human can name.
    expect(git(['rev-parse', 'refs/heads/ralph/task-1']).trim()).toBe(agentSha)
    expect(git(['log', '--format=%s', 'ralph/task-1'])).toContain('feat: agent work (task #1)')

    // AND THE HUMAN IS TOLD, by both names they need to find it: the park branch and
    // the sha. The loop must not swallow that stderr.
    expect(res.stderr).toContain('ralph/task-1')
    expect(res.stderr).toContain(agentSha)

    // THE TASK'S OWN VERDICT STANDS. The agent moved the task to done, so the run is a
    // success — a branch Ralph could not advance is not a task Ralph failed.
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(res.status).toBe(0)
    expect(existsSync(join(root, '.ralph', 'tasks', 'afk', 'done', '001-first.md'))).toBe(true)
    expect(existsSync(join(root, '.ralph', 'tasks', 'afk', 'failed', '001-first.md'))).toBe(false)
  })

  it('keeps the worktree registered, so a human can read the diff out of it (#223 is the teardown)', () => {
    writeFileSync(join(root, 'README.md'), DIRTY_README)
    seedTask()
    runLoop()
    // Folder-mode teardown is a separate slice; until then the parked work is readable
    // from two places, and both are asserted so a later teardown cannot land silently.
    expect(registrations()).toEqual([`worktree ${root}`, `worktree ${worktreeDir('task-1')}`])
    expect(git(['rev-parse', 'HEAD'], worktreeDir('task-1')).trim()).toBe(
      readIf(sandboxFile('agent-head.txt')).trim(),
    )
  })
})
