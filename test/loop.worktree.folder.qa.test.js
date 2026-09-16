import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'

// QA augmentation for #221 at the LOOP level. test/loop.worktree.folder.test.js drives the
// three advance-or-park states of a SINGLE successful task; this file drives the paths that
// only appear when something about the iteration is off, plus the one thing a single task
// can never show:
//
//   1. THE CREATE FAILING. The bash comment promises "ABORT, DON'T SKIP … Marking the task
//      `failed` and moving on would label work that may be in flight" — a claim about a
//      `break` and about a queue that must be left alone, which no green-path test reaches.
//   2. TWO TASKS IN ONE RUN, which is the actual reason folder mode does not fetch: task 2's
//      tree has to be cut from task 1's UNPUSHED commit. One task cannot distinguish "based
//      on the local branch" from "based on whatever was there at startup".
//   3. AN AGENT THAT COMMITTED NOTHING — the ordinary shape of a task that only moved files
//      — which must produce silence rather than a park branch and a warning.
//   4. A TASK THAT FAILED ITS VERDICT, where the two halves of the iteration have to come
//      apart: the commit is still real and still has to be reachable, while the count still
//      has to say the task did not finish.
//   5. AN `origin` THAT MOVED ON UNDER THE RUN, since "never fetches" is only load-bearing
//      if a third party's push cannot reach the tree the agent gets.
//
// Real git and a real `bash templates/ralph.sh`, for the reason the dev's file gives: every
// claim here is a property of a repository, and a `git` stub that exits 0 answers "yes" to
// both an advance and a park. Hermetic — a fresh repo with its own bare `origin` under the
// OS temp dir, removed in afterEach. Nothing touches this checkout.

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

function git(args, cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function gitOk(args, cwd = root) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function runLoop({ timeout = 90000, extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-worktree-folder-qa',
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
    // On the CHILD env only: test/setup/hermetic-env.js deletes DEV_BRANCH from the worker
    // because templates/ralph.config.sh declares it, and this fixture writes no config.
    DEV_BRANCH: 'main',
    TASK_SOURCE: 'folder',
    ...extraEnv,
  }
  return spawnSync('bash', [RALPH_TEMPLATE], { cwd: workdir, env, timeout, encoding: 'utf8' })
}

const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const sandboxFile = (name) => join(sandbox, name)
const worktreeDir = (handle) => join(root, '.ralph', 'worktrees', handle)
const lane = (name) => join(root, '.ralph', 'tasks', 'afk', name)
const laneFiles = (name) => (existsSync(lane(name)) ? readdirSync(lane(name)).sort() : [])

// One task file per id. Folder ids are numeric, so `001-first.md` is task #1.
function seedTasks(...names) {
  mkdirSync(lane('todo'), { recursive: true })
  for (const name of names) writeFileSync(join(lane('todo'), name), `do ${name}\n`)
}

// The agent stub, in three variants. All three record what tree they woke in and what HEAD
// they left, APPENDING rather than overwriting, because one run can invoke the agent more
// than once and the per-iteration order is itself under test.
//
// The task-lane paths are absolute and hardcoded at the MAIN root: what is under test is
// the loop, and a stub that parsed its own prompt could pass by agreeing with a wrong one.
function agentStub({ commits = true, finishes = true } = {}) {
  const TODO = lane('todo')
  const DONE = lane('done')
  writeStub(
    'claude',
    `#!/bin/bash
cat > "${sandboxFile('prompt.txt')}"
pwd -P >> "${sandboxFile('agent-cwds.txt')}"
git rev-parse --abbrev-ref HEAD >> "${sandboxFile('agent-branches.txt')}" 2>&1
f=$(ls "${TODO}"/*.md 2>/dev/null | sort | head -1)
[ -z "$f" ] && { echo "STUB: no task file in todo" >&2; exit 1; }
id=$(basename "$f" | cut -d- -f1)
echo "$id" >> "${sandboxFile('agent-ids.txt')}"
${finishes ? `mkdir -p "${DONE}"\nmv "$f" "${DONE}/"` : '# deliberately leaves the task where it was'}
${
  commits
    ? `echo "work for task $id" > "agent-$id.txt"
git add "agent-$id.txt"
git commit -q -m "feat: agent work (task $id)"`
    : '# deliberately commits nothing'
}
git rev-parse HEAD >> "${sandboxFile('agent-heads.txt')}"
# The tree the agent was given, as it saw it, so a later assertion can tell whether the
# loop's own bookkeeping lived inside it.
ls -a . >> "${sandboxFile('agent-listing.txt')}"
echo '{"type":"result","subtype":"success"}'
exit 0
`,
  )
}

const lines = (name) =>
  readIf(sandboxFile(name))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ralph-worktree-folder-qa-'))
  originDir = join(sandbox, 'origin.git')
  workdir = join(sandbox, 'work')
  bindir = join(sandbox, 'bin')
  mkdirSync(bindir, { recursive: true })

  execFileSync('git', ['init', '--bare', '--initial-branch=main', originDir])
  mkdirSync(workdir, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: workdir })
  execFileSync('git', ['config', 'user.email', 'ralph@example.test'], { cwd: workdir })
  execFileSync('git', ['config', 'user.name', 'Ralph Test'], { cwd: workdir })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: workdir })
  writeFileSync(join(workdir, '.gitignore'), '.ralph/\nlogs/\n')
  writeFileSync(join(workdir, 'README.md'), 'seed\n')
  execFileSync('git', ['add', '.'], { cwd: workdir })
  execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: workdir })
  execFileSync('git', ['remote', 'add', 'origin', originDir], { cwd: workdir })
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: workdir })

  // Commit B: the previous run's work, local only. origin/main stays at A.
  writeFileSync(join(workdir, 'from-iteration-1.txt'), 'committed locally, never pushed\n')
  execFileSync('git', ['add', 'from-iteration-1.txt'], { cwd: workdir })
  execFileSync('git', ['commit', '-q', '-m', 'chore: local only, never pushed'], { cwd: workdir })

  // git resolves symlinks in `rev-parse --show-toplevel` and the macOS temp dir is one
  // (/var → /private/var), so PROJECT_ROOT inside the loop is the REAL path.
  root = realpathSync(workdir)
  localOnlySha = git(['rev-parse', 'HEAD']).trim()

  mkdirSync(join(workdir, 'logs'), { recursive: true })
  mkdirSync(join(workdir, '.ralph'), { recursive: true })
  writeFileSync(join(workdir, '.ralph', 'state.json'), '{}')

  writeStub('node', `#!/bin/bash\nexec "${REAL_NODE}" "$@"\n`)
  agentStub()
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
  writeStub('gh', `#!/bin/bash\necho "$*" >> "${sandboxFile('gh-calls.log')}"\nexit 0\n`)
  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
})

afterEach(() => {
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. The create failing
// ---------------------------------------------------------------------------

describe('ralph.sh folder arm — a worktree it cannot create aborts the run (#221 QA)', () => {
  it('never runs the agent in the user own checkout, and leaves the queue alone', () => {
    // $DEV_BRANCH names no local branch — the misconfiguration folder mode is most exposed
    // to, since it never fetches, so a `dev` that exists only on the remote lands here.
    // What must NOT happen is the pre-#221 behaviour: the agent running in the user's
    // checkout, on whatever branch they happen to have out.
    seedTasks('001-first.md')
    const before = {
      tip: git(['rev-parse', 'HEAD']).trim(),
      head: git(['symbolic-ref', 'HEAD']).trim(),
      status: git(['status', '--porcelain']),
    }

    const res = runLoop({ extraEnv: { DEV_BRANCH: 'no-such-branch' } })

    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stderr).toContain('could not create a worktree for task #1')
    // THE AGENT NEVER RAN. Not in the worktree (there is none) and not in the main root.
    expect(existsSync(sandboxFile('prompt.txt'))).toBe(false)
    expect(existsSync(sandboxFile('agent-cwds.txt'))).toBe(false)
    // THE QUEUE IS UNTOUCHED: the task is still todo, not swept to failed, because
    // nothing was attempted on it.
    expect(laneFiles('todo')).toEqual(['001-first.md'])
    expect(laneFiles('failed')).toEqual([])
    expect(laneFiles('done')).toEqual([])
    // …and it is still counted as a failure of the RUN, so the summary does not claim
    // success for a task nobody worked on.
    expect(res.stdout).toMatch(/0 ok, 1 failed/)
    // Nothing was created, nothing was written, nothing switched.
    expect(existsSync(worktreeDir('task-1'))).toBe(false)
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(before.tip)
    expect(git(['symbolic-ref', 'HEAD']).trim()).toBe(before.head)
    expect(git(['status', '--porcelain'])).toBe(before.status)
    expect(gitOk(['rev-parse', '--verify', '--quiet', 'refs/heads/ralph/task-1']).status).not.toBe(0)
  })

  it('aborts the same way when $DEV_BRANCH names a TAG rather than a branch', () => {
    // The base that RESOLVES but cannot be advanced, end to end. A DEV_BRANCH pinned to a
    // tag is a configuration rather than a typo, and the only safe moment to refuse it is
    // before the agent works: `advance` moves `refs/heads/<DEV_BRANCH>`, which for a tag
    // does not exist, so a tree handed out here produces a commit the run has nowhere to
    // put. Driven through the real bash and the real lib/worktree.js, because what is
    // under test is that the refusal reaches the loop's abort rather than a warning.
    seedTasks('001-first.md')
    git(['tag', 'v1.0'])
    const before = {
      tip: git(['rev-parse', 'HEAD']).trim(),
      head: git(['symbolic-ref', 'HEAD']).trim(),
      status: git(['status', '--porcelain']),
    }

    const res = runLoop({ extraEnv: { DEV_BRANCH: 'v1.0' } })

    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stderr).toContain('could not create a worktree for task #1')
    // The reason is named, and it names the base rather than leaving a reader to guess.
    expect(res.stderr).toContain('v1.0')
    // No agent, no tree, no park branch, no queue movement — and the tag still points
    // where it did, since nothing here may write a ref.
    expect(existsSync(sandboxFile('prompt.txt'))).toBe(false)
    expect(existsSync(worktreeDir('task-1'))).toBe(false)
    expect(laneFiles('todo')).toEqual(['001-first.md'])
    expect(laneFiles('done')).toEqual([])
    expect(laneFiles('failed')).toEqual([])
    expect(res.stdout).toMatch(/0 ok, 1 failed/)
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(before.tip)
    expect(git(['symbolic-ref', 'HEAD']).trim()).toBe(before.head)
    expect(git(['status', '--porcelain'])).toBe(before.status)
    expect(git(['rev-parse', 'refs/tags/v1.0']).trim()).toBe(before.tip)
    expect(gitOk(['rev-parse', '--verify', '--quiet', 'refs/heads/ralph/task-1']).status).not.toBe(0)
  })

  it('stops the run rather than draining the rest of the queue', () => {
    // `break`, not `continue`: whatever is wrong with the repository is wrong for task 2
    // as well, and burning the queue against it is the outcome the bash comment refuses.
    seedTasks('001-first.md', '002-second.md', '003-third.md')

    const res = runLoop({ extraEnv: { DEV_BRANCH: 'no-such-branch' } })

    expect(res.signal).toBeNull()
    expect(laneFiles('todo')).toEqual(['001-first.md', '002-second.md', '003-third.md'])
    // Exactly one abort — the loop did not try the other two.
    expect(res.stderr.match(/could not create a worktree/g)).toHaveLength(1)
    expect(res.stdout).toMatch(/0 ok, 1 failed/)
    expect(res.stdout).not.toContain('Iteration for task #2')
  })
})

// ---------------------------------------------------------------------------
// 2. Two tasks in one run — the reason there is no fetch
// ---------------------------------------------------------------------------

describe('ralph.sh folder arm — task 2 builds on task 1 unpushed commit (#221 QA)', () => {
  it('chains the iterations through the LOCAL branch and fast-forwards it twice', () => {
    seedTasks('001-first.md', '002-second.md')
    expect(git(['status', '--porcelain'])).toBe('')

    const res = runLoop()

    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/2 ok, 0 failed/)
    expect(lines('agent-ids.txt')).toEqual(['001', '002'])

    // Each iteration got its OWN tree, named after its task.
    expect(lines('agent-cwds.txt')).toEqual([worktreeDir('task-1'), worktreeDir('task-2')])
    const [first, second] = lines('agent-heads.txt')
    expect(first).not.toBe(second)

    // THE CHAIN: task 2's commit sits directly on task 1's, which sits directly on the
    // never-pushed commit B. Nothing here is reachable from origin/main, so a create that
    // fetched and based on origin/$DEV_BRANCH would have broken this line — task 2 would
    // have been cut from A and dropped both B and task 1's work.
    expect(git(['rev-parse', `${second}^`]).trim()).toBe(first)
    expect(git(['rev-parse', `${first}^`]).trim()).toBe(localOnlySha)

    // The branch ends up at the last commit, having moved by fast-forward BOTH times, and
    // the user's tree is still on its own branch throughout.
    expect(git(['rev-parse', 'main']).trim()).toBe(second)
    expect(git(['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main')
    const reflog = git(['reflog', 'show', '--format=%gs', 'main']).split('\n')
    expect(reflog[0]).toBe(`merge ${second}: Fast-forward`)
    expect(reflog[1]).toBe(`merge ${first}: Fast-forward`)
    // Both files are in the user's checkout now, and nothing was parked.
    expect(existsSync(join(root, 'agent-001.txt'))).toBe(true)
    expect(existsSync(join(root, 'agent-002.txt'))).toBe(true)
    for (const handle of ['task-1', 'task-2']) {
      expect(
        gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/ralph/${handle}`]).status,
      ).not.toBe(0)
    }
    expect(laneFiles('done')).toEqual(['001-first.md', '002-second.md'])
  })
})

// ---------------------------------------------------------------------------
// 3. An agent that committed nothing
// ---------------------------------------------------------------------------

describe('ralph.sh folder arm — a task with no commit is silent (#221 QA)', () => {
  it('advances nothing, parks nothing, and says nothing about a branch', () => {
    // The ordinary shape of a folder task that only moved files around (a triage task, a
    // note, a task the agent decided needed no code): the worktree HEAD still equals the
    // branch tip, which is the table's `up-to-date` row. A park branch or a warning here
    // would be noise on the most common path there is.
    agentStub({ commits: false })
    seedTasks('001-first.md')
    const tipBefore = git(['rev-parse', 'main']).trim()

    const res = runLoop()

    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(res.status).toBe(0)
    expect(lines('agent-heads.txt')).toEqual([tipBefore])
    expect(git(['rev-parse', 'main']).trim()).toBe(tipBefore)
    expect(gitOk(['rev-parse', '--verify', '--quiet', 'refs/heads/ralph/task-1']).status).not.toBe(0)
    expect(res.stderr).not.toContain('could not advance')
    expect(res.stderr).not.toContain('parked')
    // No fast-forward either: the reflog's newest entry is still the fixture's own commit.
    expect(git(['reflog', 'show', '--format=%gs', 'main']).split('\n')[0]).not.toContain(
      'Fast-forward',
    )
    expect(laneFiles('done')).toEqual(['001-first.md'])
  })

  it('keeps its bookkeeping in the main root, never inside the worktree', () => {
    // `.ralph/` is the main root's, and the gitignore that hides it is the main root's
    // too: a `.ralph` created INSIDE the tree would be invisible to the next run, would
    // be untracked content in a tree the advance is about to read, and would put the task
    // lanes somewhere the sweep cannot find them.
    agentStub({ commits: false })
    seedTasks('001-first.md')

    runLoop()

    expect(existsSync(join(worktreeDir('task-1'), '.ralph'))).toBe(false)
    expect(readIf(sandboxFile('agent-listing.txt'))).not.toContain('.ralph')
    expect(existsSync(join(root, '.ralph', 'tasks', 'afk', 'done', '001-first.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. A task that failed its verdict still has a real commit
// ---------------------------------------------------------------------------

describe('ralph.sh folder arm — the advance runs before, and apart from, the verdict (#221 QA)', () => {
  it('lands the commit of a task it then sweeps to failed', () => {
    // The agent committed but never moved its task file, so the terminal-directory verdict
    // is `failed` — and its commit is still a real commit that the branch is still
    // fast-forwarded to, because the advance is not part of the verdict.
    //
    // THE CONSEQUENCE IS DELIBERATE AND WORTH READING TWICE: a task Ralph reports as
    // failed can still move $DEV_BRANCH and update the user's checkout. The alternative —
    // gating the advance on the verdict — orphans the commit in a directory nothing points
    // at, which is the outcome #221 exists to prevent. Pinned here so that trade cannot be
    // reversed by accident.
    agentStub({ finishes: false })
    seedTasks('001-first.md')

    const res = runLoop()

    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    const [sha] = lines('agent-heads.txt')
    expect(sha).toBeTruthy()
    // The verdict: failed, swept, counted.
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/0 ok, 1 failed/)
    expect(res.stderr).toContain('was not completed')
    expect(laneFiles('failed')).toEqual(['001-first.md'])
    expect(laneFiles('todo')).toEqual([])
    // The commit: reachable from the branch, in the user's tree, no park needed.
    expect(git(['rev-parse', 'main']).trim()).toBe(sha)
    expect(git(['reflog', 'show', '--format=%gs', 'main']).split('\n')[0]).toBe(
      `merge ${sha}: Fast-forward`,
    )
    expect(existsSync(join(root, 'agent-001.txt'))).toBe(true)
  })

  it('parks that commit when the user tree is dirty, and still reports the failure', () => {
    // Both halves at once, which is the combination neither suite covers: the branch
    // cannot move (dirt in the tree that has it checked out) AND the task did not finish.
    // The park warning must still name both the branch and the sha — they are the only
    // two strings that lead a human back to the work — and the count must still be a
    // failure, since a park is not a verdict.
    agentStub({ finishes: false })
    seedTasks('001-first.md')
    writeFileSync(join(root, 'README.md'), 'seed\nuncommitted local edit\n')
    const tipBefore = git(['rev-parse', 'main']).trim()

    const res = runLoop()

    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    const [sha] = lines('agent-heads.txt')
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/0 ok, 1 failed/)
    expect(res.status).toBe(0)
    expect(res.stderr).toContain(sha)
    expect(res.stderr).toContain('ralph/task-1')
    expect(res.stderr).toContain('main')
    expect(git(['rev-parse', 'refs/heads/ralph/task-1']).trim()).toBe(sha)
    expect(git(['rev-parse', 'main']).trim()).toBe(tipBefore)
    // The user's edit is exactly as they left it, and the agent's file did not appear in
    // their tree.
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('seed\nuncommitted local edit\n')
    expect(existsSync(join(root, 'agent-001.txt'))).toBe(false)
    expect(laneFiles('failed')).toEqual(['001-first.md'])
  })
})

// ---------------------------------------------------------------------------
// 5. An origin that moved on under the run
// ---------------------------------------------------------------------------

describe('ralph.sh folder arm — a third party push cannot reach the run (#221 QA)', () => {
  it('bases the tree on the local tip and never resets to the remote', () => {
    // Somebody pushes to origin/main while the loop is between iterations. Folder mode
    // never pushes and must never pull: the tree the agent gets is cut from the LOCAL tip,
    // and the branch is advanced from there.
    //
    // NOTE, and it is not a contradiction of the above: the END-OF-RUN cleanup in
    // templates/ralph.sh does run `git fetch origin "$DEV_BRANCH"` (its job is deleting
    // merged `issue-*` branches, which folder mode has none of). So the remote-tracking
    // ref may well have moved by the time this test looks. What must not have moved is
    // anything the run's own outcome depends on: the local branch, the base of the tree,
    // and the user's checkout.
    const other = join(sandbox, 'other')
    execFileSync('git', ['clone', '-q', originDir, other], { stdio: ['ignore', 'ignore', 'ignore'] })
    execFileSync('git', ['config', 'user.email', 'other@example.test'], { cwd: other })
    execFileSync('git', ['config', 'user.name', 'Other Dev'], { cwd: other })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: other })
    writeFileSync(join(other, 'theirs.txt'), 'pushed by somebody else\n')
    execFileSync('git', ['add', '.'], { cwd: other })
    execFileSync('git', ['commit', '-q', '-m', 'chore: their push'], { cwd: other })
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other })
    const theirs = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: other, encoding: 'utf8' }).trim()

    seedTasks('001-first.md')
    const res = runLoop()

    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    const [sha] = lines('agent-heads.txt')
    // The agent's commit is on top of the LOCAL tip, and their commit is not an ancestor
    // of it — the tree never saw the remote at all.
    expect(git(['rev-parse', `${sha}^`]).trim()).toBe(localOnlySha)
    expect(gitOk(['merge-base', '--is-ancestor', theirs, sha]).status).not.toBe(0)
    expect(existsSync(join(root, 'theirs.txt'))).toBe(false)
    // The branch advanced to the agent's commit — not to theirs, and not to a merge.
    expect(git(['rev-parse', 'main']).trim()).toBe(sha)
    expect(git(['rev-list', '--count', 'main']).trim()).toBe('3')
  })
})
