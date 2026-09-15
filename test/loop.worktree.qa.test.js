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

// QA augmentation for #218. test/loop.worktree.test.js owns the happy path against a
// real repository: the main tree stays on its branch with its uncommitted edit, the
// agent wakes in the worktree already on issue-N, the transcript survives the teardown.
//
// This file attacks the SAME claim from the directions a happy path cannot reach, and
// it uses the same instrument for the same reason — real git, because "the user's tree
// was not disturbed" is a property of a repository and a `git` stub that `exit 0`s
// would pass against the very `git checkout dev` this slice deletes.
//
// The questions here are:
//
//   • The PRD's promise covers the WHOLE tree, not just HEAD. An untracked file, a
//     STAGED change and a modified tracked file are three different things a branch
//     switch or a `git worktree add` could disturb; all three are seeded and compared
//     byte for byte, and so is `git reflog` — which is the assertion that says nothing
//     moved HEAD rather than that it moved and came back.
//   • A run that FAILS must be just as harmless, and must still not leak a worktree.
//   • Every way creating the worktree can fail — an unresolvable DEV_BRANCH, an
//     unwritable worktrees directory, `issue-N` checked out in the user's own tree, a
//     leftover registration from a dead run — must abort without yanking HEAD.
//   • The transcript has to survive the teardown even when the agent wandered out of
//     the tree it was given or deleted that tree outright.
//   • folder mode must be untouched: no worktree, no override in its prompt.
//
// HERMETIC: every fixture is a fresh repository under the OS temp dir, with its own
// bare `origin` beside it, and afterEach removes the whole sandbox. Nothing here runs
// git against this repository. `gh`, `jq`, `claude`, `tmux` and `curl` are stubs on a
// prepended PATH; `node` is the real binary, so lib/worktree.js and lib/build-prompt.js
// are the code under test rather than a fiction about them.

const RALPH_TEMPLATE = templatePath('ralph.sh')
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

// The permission test below has to be skipped for root, for whom a 0555 directory is
// still writable and the loop would therefore succeed instead of aborting.
const NOT_ROOT = typeof process.getuid !== 'function' || process.getuid() !== 0

let sandbox
let workdir
let root
let originDir
let bindir

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
    RALPH_TMUX_SESSION: 'ralph-worktree-qa',
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
    // Passed on the CHILD env, not assigned here: test/setup/hermetic-env.js deletes
    // DEV_BRANCH from the worker because templates/ralph.config.sh declares it.
    DEV_BRANCH: 'main',
    ...extraEnv,
  }
  return spawnSync('bash', [RALPH_TEMPLATE], { cwd: workdir, env, timeout, encoding: 'utf8' })
}

const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const sandboxFile = (name) => join(sandbox, name)
const worktreeDir = (handle = 'issue-98') => join(root, '.ralph', 'worktrees', handle)

// One line per registered worktree, which is how "no ghost registrations" is asked.
const registrations = () =>
  git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))

// The three-part snapshot the PRD is really about: which branch, which commit, and the
// exact porcelain status (which carries the staged, unstaged and untracked entries).
// The reflog is included because it is the only thing that distinguishes "HEAD never
// moved" from "HEAD moved and came back".
function treeSnapshot() {
  return {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    head: git(['rev-parse', 'HEAD']).trim(),
    status: git(['status', '--porcelain']),
    reflog: git(['reflog', 'show', '--format=%gd %gs', 'HEAD']),
  }
}

// --- Agent stubs -------------------------------------------------------------
// Each one records where it woke up and on what branch, so a test can tell "the loop
// never ran the agent" from "the agent ran in the wrong tree".
const record = () => `
cat > "${sandboxFile('prompt.txt')}"
pwd -P > "${sandboxFile('agent-cwd.txt')}"
git rev-parse --abbrev-ref HEAD > "${sandboxFile('agent-branch.txt')}" 2>&1
`

const AGENT_OK = () => `#!/bin/bash
${record()}
echo "hello from the agent" > agent-file.txt
git add agent-file.txt
git commit -q -m "feat(issue-98): agent work"
echo '{"type":"result","subtype":"success"}'
exit 0
`

// Non-zero exit AFTER writing something it never committed — the shape of a run killed
// by a rate limit or a crashed tool.
const AGENT_FAILS = () => `#!/bin/bash
${record()}
echo "half-finished" > scratch-from-agent.txt
echo '{"type":"result","subtype":"error"}'
echo "agent exploded" >&2
exit 7
`

// Commits one file and leaves another uncommitted, so the cost of an unconditional
// teardown can be stated rather than guessed at.
const AGENT_HALF_COMMITS = () => `#!/bin/bash
${record()}
echo committed > committed.txt
git add committed.txt
git commit -q -m "feat(issue-98): the part that was committed"
echo uncommitted > uncommitted.txt
echo '{"type":"result","subtype":"success"}'
exit 0
`

// Deletes the tree it was handed, from outside it.
const AGENT_SELF_DESTRUCTS = () => `#!/bin/bash
${record()}
here="$(pwd -P)"
cd /
rm -rf "$here"
echo '{"type":"result","subtype":"success"}'
exit 0
`

// Wanders off mid-run, which is what a `cd` in an agent-run script looks like from out
// here. The transcript still has to land in the main root.
const AGENT_WANDERS = () => `#!/bin/bash
${record()}
cd /
echo '{"type":"result","subtype":"success"}'
echo "wandered off" >&2
exit 0
`

// Reports what the fresh checkout actually contains.
const AGENT_INVENTORIES = () => `#!/bin/bash
${record()}
ls -A > "${sandboxFile('agent-ls.txt')}"
echo '{"type":"result","subtype":"success"}'
exit 0
`

// --- gh stub ----------------------------------------------------------------
// One issue (#98). `state` decides whether the loop classifies the iteration as a
// success (CLOSED) or falls through to its exit-code branch (OPEN).
function writeGh({ state = 'CLOSED' } = {}) {
  writeStub(
    'gh',
    `#!/bin/bash
echo "$*" >> "${sandboxFile('gh-calls.log')}"
CNT_FILE="${sandboxFile('count.txt')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  case "$*" in
    *sort:created-asc*) echo "98"; echo "0" > "$CNT_FILE" ;;
    *) cat "$CNT_FILE" ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "" ;;
    *state*)  echo "${state}" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ]; then echo "[]"; exit 0; fi
exit 0
`,
  )
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ralph-worktree-qa-'))
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
  // `.ralph/` is what `ralph init` itself appends (lib/commands/init.js:237), which is
  // why a live worktree under `.ralph/worktrees` does not show up in `git status`;
  // `logs/` is this fixture's own, so the transcripts the loop writes are not counted
  // as untracked content by the status comparisons below either.
  writeFileSync(join(workdir, '.gitignore'), '.ralph/\nlogs/\n')
  writeFileSync(join(workdir, 'README.md'), 'seed\n')
  writeFileSync(join(workdir, 'tracked-and-staged.txt'), 'original\n')
  execFileSync('git', ['add', '.'], { cwd: workdir })
  execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: workdir })
  execFileSync('git', ['remote', 'add', 'origin', originDir], { cwd: workdir })
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: workdir })

  // git resolves symlinks in `rev-parse --show-toplevel`, and the macOS temp dir is one
  // (/var → /private/var), so PROJECT_ROOT inside the loop is the REAL path.
  root = realpathSync(workdir)

  mkdirSync(join(workdir, 'logs'), { recursive: true })
  mkdirSync(join(workdir, '.ralph'), { recursive: true })
  writeFileSync(join(workdir, '.ralph', 'state.json'), '{}')

  // THE USER'S WORK IN PROGRESS, in all three states a working tree can hold it:
  //   • a modified TRACKED file — what `git checkout dev` used to put at risk,
  //   • a STAGED change — which lives in the index, a per-worktree file git could
  //     plausibly have shared,
  //   • an UNTRACKED file — the one a branch switch would have survived, kept so the
  //     comparison covers everything `git status` reports rather than a subset.
  writeFileSync(join(workdir, 'README.md'), 'seed\nlocal edit not committed\n')
  writeFileSync(join(workdir, 'tracked-and-staged.txt'), 'staged by the user\n')
  execFileSync('git', ['add', 'tracked-and-staged.txt'], { cwd: workdir })
  writeFileSync(join(workdir, 'scratch.txt'), 'untracked scratch\n')

  writeFileSync(sandboxFile('count.txt'), '1')

  writeStub('node', `#!/bin/bash\nexec "${REAL_NODE}" "$@"\n`)
  writeStub('claude', AGENT_OK())
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
  writeGh()
  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
})

afterEach(() => {
  if (sandbox && existsSync(sandbox)) {
    // Restore any permission the tests dropped, or the recursive delete cannot finish.
    const ro = join(workdir ?? '', '.ralph', 'worktrees')
    if (existsSync(ro)) {
      try {
        chmodSync(ro, 0o755)
      } catch {
        /* already writable */
      }
    }
    rmSync(sandbox, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 1. The user's working tree, in every state it can be in
// ---------------------------------------------------------------------------

describe('a run leaves the whole working tree alone, not just HEAD (#218 QA)', () => {
  it('a successful run changes nothing git can see about the main tree', () => {
    const before = treeSnapshot()
    const res = runLoop()
    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toContain('==> Cleanup')

    const after = treeSnapshot()
    expect(after.branch).toBe(before.branch)
    expect(after.head).toBe(before.head)
    // Byte-identical porcelain: the staged entry, the unstaged edit and the untracked
    // file all in the same state they were left in.
    expect(after.status).toBe(before.status)
    // …and no reflog entry, which is what proves HEAD never moved AT ALL rather than
    // having moved and been put back.
    expect(after.reflog).toBe(before.reflog)
  })

  it('the three kinds of work in progress are byte-identical afterwards', () => {
    runLoop()
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('seed\nlocal edit not committed\n')
    expect(readFileSync(join(root, 'scratch.txt'), 'utf8')).toBe('untracked scratch\n')
    expect(readFileSync(join(root, 'tracked-and-staged.txt'), 'utf8')).toBe('staged by the user\n')
    // The staged change is still STAGED, not merely present on disk: the index is a
    // per-worktree file and adding a worktree must not have touched the main one.
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe('tracked-and-staged.txt')
    expect(git(['show', ':tracked-and-staged.txt'])).toBe('staged by the user\n')
  })

  it('a FAILING run is just as harmless, and still removes the worktree', () => {
    writeStub('claude', AGENT_FAILS())
    writeGh({ state: 'OPEN' })
    const before = treeSnapshot()

    const res = runLoop()
    expect(res.signal).toBeNull()
    // The loop noticed the non-zero exit and classified the issue.
    expect(res.stderr).toMatch(/failed on issue #98 \(non-zero exit\)/)
    expect(res.stdout).toMatch(/0 ok, 1 failed/)

    const after = treeSnapshot()
    expect(after).toEqual(before)
    // The agent's uncommitted file went with the worktree and never reached the main
    // tree — the failure did not turn into a mess in the user's checkout.
    expect(existsSync(join(root, 'scratch-from-agent.txt'))).toBe(false)
    expect(existsSync(worktreeDir())).toBe(false)
    expect(registrations()).toEqual([`worktree ${root}`])
  })

  it('the Cleanup block moves nothing when DEV_BRANCH is unset', () => {
    // `${DEV_BRANCH:-main}` is the fallback under test, in BOTH the create and the
    // Cleanup fetch. Nothing may be checked out or fast-forwarded either way.
    const before = treeSnapshot()
    const res = runLoop({ extraEnv: { DEV_BRANCH: '' } })
    expect(res.signal).toBeNull()
    expect(res.stdout).toContain('==> Cleanup')
    expect(treeSnapshot()).toEqual(before)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')
  })

  it('the Cleanup block moves nothing when DEV_BRANCH names a branch nobody has', () => {
    // `git fetch origin nope` and `git branch --merged origin/nope` both fail here, and
    // both are swallowed. What matters is that neither leaves the tree changed.
    const before = treeSnapshot()
    const res = runLoop({ extraEnv: { DEV_BRANCH: 'nope' } })
    expect(res.signal).toBeNull()
    expect(res.stdout).toContain('==> Cleanup')
    expect(treeSnapshot()).toEqual(before)
  })

  it('never deletes an unmerged issue branch, and never deletes the branch it just used', () => {
    // The pruning is `git branch --merged origin/$DEV_BRANCH`, so a branch carrying a
    // commit origin/main does not have must survive — it is what the PR is opened from.
    git(['branch', 'issue-1-unmerged', 'main'])
    writeFileSync(join(root, '.ralph', 'unmerged-marker'), 'x')
    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(git(['branch', '--list', 'issue-98']).trim()).toContain('issue-98')
    // issue-1-unmerged points AT main, so it IS merged into origin/main and the sweep
    // is entitled to delete it. Asserted as the sweep still working, which is what
    // stops the test above from being vacuous.
    expect(git(['branch', '--list', 'issue-1-unmerged']).trim()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 2. Every way the worktree can fail to be created
// ---------------------------------------------------------------------------

describe('when the worktree cannot be created the loop aborts without touching HEAD (#218 QA)', () => {
  it('aborts when DEV_BRANCH exists neither locally nor on origin', () => {
    // The remote-tracking ref for `nope` does not exist and neither does a local
    // branch, so lib/worktree.js has no base commit to cut from and says so.
    const before = treeSnapshot()
    const res = runLoop({ extraEnv: { DEV_BRANCH: 'nope' } })

    expect(res.signal).toBeNull()
    expect(res.stderr).toContain('could not create a worktree for issue #98')
    expect(res.stderr).toMatch(/cannot resolve a base commit for 'nope'/)
    expect(treeSnapshot()).toEqual(before)
    expect(existsSync(worktreeDir())).toBe(false)
    expect(git(['branch', '--list', 'issue-98']).trim()).toBe('')
    // The agent was never spawned, so no invocation was billed for an issue that
    // could not be set up.
    expect(readIf(sandboxFile('agent-cwd.txt'))).toBe('')
    expect(res.stdout).toContain('==> Cleanup')
  })

  it('falls back to a LOCAL dev branch that origin has never seen, and still works', () => {
    git(['branch', 'local-only', 'main'])
    const before = treeSnapshot()
    const res = runLoop({ extraEnv: { DEV_BRANCH: 'local-only' } })

    expect(res.signal).toBeNull()
    expect(res.stderr).toMatch(/origin\/local-only does not exist/)
    expect(readIf(sandboxFile('agent-branch.txt')).trim()).toBe('issue-98')
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
    expect(treeSnapshot()).toEqual(before)
  })

  it('keeps going when the fetch cannot reach origin at all (an offline run)', () => {
    // A remote URL that resolves to nothing. `origin/main` is still on disk from the
    // seed push, so the run must proceed off the last-known ref with a warning rather
    // than refuse to work without a network.
    git(['remote', 'set-url', 'origin', join(sandbox, 'no-such-remote.git')])
    const before = treeSnapshot()
    const res = runLoop()

    expect(res.signal).toBeNull()
    expect(res.stderr).toMatch(/git fetch origin main failed/)
    expect(res.stderr).toMatch(/using the refs already on disk/)
    expect(readIf(sandboxFile('agent-branch.txt')).trim()).toBe('issue-98')
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
    expect(treeSnapshot()).toEqual(before)
  })

  it('aborts, and does NOT yank HEAD, when the user has issue-98 checked out themselves', () => {
    // The scenario #218 exists to protect: the branch the loop wants is live in the
    // human's own tree. git refuses the add; the loop must report that and stop, and
    // the human must still be on their branch with their edits.
    git(['checkout', '-q', '-b', 'issue-98'])
    const before = treeSnapshot()
    expect(before.branch).toBe('issue-98')

    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(res.stderr).toContain('could not create a worktree for issue #98')
    expect(res.stderr).toMatch(/is already used by worktree at/)
    expect(treeSnapshot()).toEqual(before)
    expect(existsSync(worktreeDir())).toBe(false)
    expect(registrations()).toEqual([`worktree ${root}`])
  })

  it.runIf(NOT_ROOT)('aborts when the worktrees directory is not writable', () => {
    const wtRoot = join(workdir, '.ralph', 'worktrees')
    mkdirSync(wtRoot, { recursive: true })
    chmodSync(wtRoot, 0o555)
    const before = treeSnapshot()
    try {
      const res = runLoop()
      expect(res.signal).toBeNull()
      expect(res.stderr).toContain('could not create a worktree for issue #98')
      expect(treeSnapshot()).toEqual(before)
      expect(readIf(sandboxFile('agent-cwd.txt'))).toBe('')
    } finally {
      chmodSync(wtRoot, 0o755)
    }
  })

  it('recovers from a leftover DIRECTORY at the worktree path', () => {
    const stale = worktreeDir()
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'stale.txt'), 'from a run that died')
    const before = treeSnapshot()

    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
    expect(existsSync(stale)).toBe(false)
    expect(treeSnapshot()).toEqual(before)
  })

  it('recovers when the worktree path is a FILE rather than a directory', () => {
    mkdirSync(join(workdir, '.ralph', 'worktrees'), { recursive: true })
    writeFileSync(worktreeDir(), 'someone redirected output here')
    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
    expect(existsSync(worktreeDir())).toBe(false)
  })

  // THE ORPHANED REGISTRATION. git keeps its worktree bookkeeping in
  // .git/worktrees/<name>, independently of the directory, and refuses to re-add a
  // path or a branch that is still registered — MEASURED here rather than assumed:
  // the arrange step below leaves exactly that state and `git worktree list
  // --porcelain` reports the second entry as `prunable`. A single `git worktree prune`
  // clears it, and lib/worktree.js runs exactly that unconditionally before its
  // `worktree add`. This test is what keeps that prune unconditional: while it lived
  // inside the module's `if (fs.existsSync(path))` branch this was the state a run
  // could not get out of, and the loop's response to a create that throws is `break` —
  // the whole run, not just this issue.
  it('recovers from a leftover REGISTRATION whose directory is already gone', () => {
    const stale = worktreeDir()
    git(['worktree', 'add', '-q', '-B', 'issue-98', stale, 'main'])
    rmSync(stale, { recursive: true, force: true })
    // The arrange step really did leave the state the comment describes: two
    // registrations, the second one prunable because its gitdir points nowhere.
    expect(registrations()).toHaveLength(2)
    expect(git(['worktree', 'list', '--porcelain'])).toMatch(
      /prunable gitdir file points to non-existent location/,
    )
    const before = treeSnapshot()

    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(
      res.stderr,
      'the run aborted instead of clearing a prunable registration',
    ).not.toContain('could not create a worktree for issue #98')
    expect(readIf(sandboxFile('agent-branch.txt')).trim()).toBe('issue-98')
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
    expect(registrations()).toEqual([`worktree ${root}`])
    expect(treeSnapshot()).toEqual(before)
  })

  // THE LOCKED LEFTOVER, which is the one state `git worktree prune` cannot repair.
  // MEASURED against real git here, and the reason lib/worktree.js escalates its
  // clearing remove instead of absorbing the refusal: with the tree locked,
  // `git worktree remove --force <path>` exits 128 (`fatal: cannot remove a locked
  // working tree; use 'remove -f -f' to override or unlock first`), and if the directory
  // is then deleted anyway the record SURVIVES — `git worktree prune -v` prints nothing
  // and `worktree add -B issue-98 …` exits 128 with `fatal: 'issue-98' is already used by
  // worktree at '<path>'`. The loop's answer to a create that throws is `break`, so that
  // would abort every future run of #98 until a human unlocked it by hand.
  it('recovers from a LOCKED leftover worktree, which no prune can clear', () => {
    const stale = worktreeDir()
    git(['worktree', 'add', '-q', '-B', 'issue-98', stale, 'main'])
    git(['worktree', 'lock', stale])
    // The arrange step really did leave a locked registration: git says so, and a prune
    // is powerless against it.
    expect(git(['worktree', 'list', '--porcelain'])).toContain('locked')
    git(['worktree', 'prune', '-v'])
    expect(registrations()).toHaveLength(2)
    const before = treeSnapshot()

    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(
      res.stderr,
      'the run aborted instead of clearing a locked leftover',
    ).not.toContain('could not create a worktree for issue #98')
    expect(readIf(sandboxFile('agent-branch.txt')).trim()).toBe('issue-98')
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
    // The lock went with the worktree git removed, so nothing is left for the next run
    // to trip over — neither the directory nor the record.
    expect(existsSync(stale)).toBe(false)
    expect(registrations()).toEqual([`worktree ${root}`])
    expect(treeSnapshot()).toEqual(before)
  })

  // THE SAME LOCK WITH THE DIRECTORY ALREADY GONE — the half-torn-down version, and the
  // one an `if (fs.existsSync(path))` gate on the clearing remove would walk straight
  // past. MEASURED here for the same reason as above: git's refusal does not depend on
  // the directory (`remove --force` still exits 128 with `fatal: cannot remove a locked
  // working tree;`, `-f -f` still exits 0), the record is what the add trips over, and no
  // prune can drop it while the lock stands. So the module asks git unconditionally, and
  // this test is what keeps the ask out of a directory check.
  it('recovers from a LOCKED leftover whose directory is already deleted', () => {
    const stale = worktreeDir()
    git(['worktree', 'add', '-q', '-B', 'issue-98', stale, 'main'])
    git(['worktree', 'lock', stale])
    rmSync(stale, { recursive: true, force: true })
    // The arrange step really did leave the state the comment describes: no directory, a
    // locked record, and a prune that cannot touch it.
    expect(existsSync(stale)).toBe(false)
    expect(git(['worktree', 'list', '--porcelain'])).toContain('locked')
    git(['worktree', 'prune', '-v'])
    expect(registrations()).toHaveLength(2)
    const before = treeSnapshot()

    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(
      res.stderr,
      'the run aborted instead of clearing a locked record with no directory',
    ).not.toContain('could not create a worktree for issue #98')
    expect(readIf(sandboxFile('agent-branch.txt')).trim()).toBe('issue-98')
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
    expect(existsSync(stale)).toBe(false)
    expect(registrations()).toEqual([`worktree ${root}`])
    expect(treeSnapshot()).toEqual(before)
  })

  // `worktree add -B` RESETS an existing branch. Documented here as behaviour, not
  // endorsed: it is what makes a crashed run recoverable, and it is also silent commit
  // loss if the previous run's `issue-98` had work on it that was never pushed. The
  // step it replaced (`git checkout -b issue-N`) failed loudly in the same situation.
  it('RESETS an existing issue-98 branch onto origin/DEV_BRANCH, discarding what it pointed at', () => {
    git(['checkout', '-q', '--orphan', 'issue-98'])
    writeFileSync(join(root, 'earlier-run.txt'), 'work from a previous run\n')
    git(['add', 'earlier-run.txt'])
    git(['commit', '-q', '-m', 'feat(issue-98): work from an earlier run'])
    const orphan = git(['rev-parse', 'issue-98']).trim()
    git(['checkout', '-q', 'main'])
    // Restore the working-tree state the orphan checkout disturbed, so the assertion
    // below is about the loop and not about this arrange step.
    writeFileSync(join(root, 'README.md'), 'seed\nlocal edit not committed\n')
    writeFileSync(join(root, 'tracked-and-staged.txt'), 'staged by the user\n')
    git(['add', 'tracked-and-staged.txt'])
    writeFileSync(join(root, 'scratch.txt'), 'untracked scratch\n')
    rmSync(join(root, 'earlier-run.txt'), { force: true })

    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(git(['rev-parse', 'issue-98']).trim()).not.toBe(orphan)
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
    expect(git(['log', '--format=%s', 'issue-98'])).not.toContain('work from an earlier run')
    expect(gitOk(['merge-base', '--is-ancestor', 'origin/main', 'issue-98']).status).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. The transcript, which is the only record of what the agent did
// ---------------------------------------------------------------------------

describe('the transcript lands in the main root whatever the agent does (#218 QA)', () => {
  const logPath = () => join(root, 'logs', 'ralph-issue-98.log')
  const jsonlPath = () => join(root, 'logs', 'ralph-issue-98.jsonl')

  it('survives an agent that wandered out of the tree it was given', () => {
    writeStub('claude', AGENT_WANDERS())
    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(existsSync(logPath())).toBe(true)
    expect(existsSync(jsonlPath())).toBe(true)
    expect(readFileSync(jsonlPath(), 'utf8')).toContain('"type":"result"')
    // stderr is teed into the .log, so the agent's own complaint is recoverable.
    expect(readFileSync(logPath(), 'utf8')).toContain('wandered off')
    // And nothing was written under the worktree, which is where a relative `logs/`
    // would have put both files — they would have gone with the teardown.
    expect(readdirSync(join(root, '.ralph', 'worktrees'))).toEqual([])
  })

  it('survives an agent that deleted its own worktree', () => {
    writeStub('claude', AGENT_SELF_DESTRUCTS())
    const before = treeSnapshot()
    const res = runLoop()

    expect(res.signal).toBeNull()
    expect(existsSync(jsonlPath())).toBe(true)
    expect(readFileSync(jsonlPath(), 'utf8')).toContain('"type":"result"')
    // Teardown of an already-gone tree is a no-op success, and it still drops the
    // registration — a ghost here is what would break the next run for this issue.
    expect(registrations()).toEqual([`worktree ${root}`])
    expect(treeSnapshot()).toEqual(before)
    expect(res.stdout).toContain('==> Cleanup')
  })

  it('records the failing run too, with the agent stderr in the log', () => {
    writeStub('claude', AGENT_FAILS())
    writeGh({ state: 'OPEN' })
    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(readFileSync(logPath(), 'utf8')).toContain('agent exploded')
    expect(readFileSync(jsonlPath(), 'utf8')).toContain('"subtype":"error"')
    // And the sidecar found both files at the main root: the telemetry line exists.
    const metrics = join(root, '.ralph', 'metrics', 'issues.jsonl')
    expect(existsSync(metrics), `no metrics written. stderr:\n${res.stderr}`).toBe(true)
    expect(readFileSync(metrics, 'utf8')).toContain('RALPH_ISSUE_EVENT')
  })

  it('writes the cycle event to the main root, not into a removed worktree', () => {
    runLoop()
    const cycle = join(root, 'logs', 'ralph-cycle.out.log')
    expect(existsSync(cycle)).toBe(true)
    expect(readFileSync(cycle, 'utf8')).toContain('RALPH_CYCLE_EVENT')
  })
})

// ---------------------------------------------------------------------------
// 4. What the worktree actually contains, and what teardown costs
// ---------------------------------------------------------------------------

describe('the shape of the tree the agent wakes up in (#218 QA)', () => {
  it('holds the TRACKED files only — the main tree untracked work is not there', () => {
    writeStub('claude', AGENT_INVENTORIES())
    const res = runLoop()
    expect(res.signal).toBeNull()
    const listing = readIf(sandboxFile('agent-ls.txt')).split('\n').filter(Boolean)
    expect(listing).toContain('README.md')
    expect(listing).toContain('.gitignore')
    expect(listing).toContain('.git')
    // The user's untracked scratch file is NOT in the worktree, which is the point of
    // cutting from origin/DEV_BRANCH — and also the cost: anything a project needs but
    // does not track (a .env.local, an installed node_modules) has to be re-made by
    // the prompt's own dependency step on every iteration.
    expect(listing).not.toContain('scratch.txt')
    // And the checkout is of the BASE, so the user's uncommitted edit is not in it.
    const readme = git(['show', 'origin/main:README.md'])
    expect(readme).toBe('seed\n')
  })

  it('discards work the agent left UNCOMMITTED while keeping what it committed', () => {
    // Teardown is unconditional in this slice, and `git worktree remove --force`
    // deletes a dirty tree without asking. Pinned so the tradeoff is visible: the
    // branch keeps the commits, the uncommitted remainder is gone with no warning.
    writeStub('claude', AGENT_HALF_COMMITS())
    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(git(['cat-file', '-p', 'issue-98:committed.txt'])).toContain('committed')
    expect(gitOk(['cat-file', '-e', 'issue-98:uncommitted.txt']).status).not.toBe(0)
    expect(existsSync(worktreeDir())).toBe(false)
    // The run still reported an outcome rather than dying on the teardown.
    expect(res.stdout).toContain('==> Cleanup')
    expect(res.stdout).toMatch(/1 ok, 0 failed/)
  })

  it('leaves no worktree and no ghost registration on the success path', () => {
    runLoop()
    expect(existsSync(worktreeDir())).toBe(false)
    expect(registrations()).toEqual([`worktree ${root}`])
    // `.ralph/worktrees` itself stays: it is the parent every create mkdirs and no
    // teardown removes, so an empty directory is the correct end state.
    expect(existsSync(join(root, '.ralph', 'worktrees'))).toBe(true)
    expect(readdirSync(join(root, '.ralph', 'worktrees'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. Cross-mode non-regression
// ---------------------------------------------------------------------------

describe('folder mode is untouched by #218 (#218 QA)', () => {
  function seedTask() {
    const dir = join(workdir, '.ralph', 'tasks', 'afk', 'todo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '001-first.md'), 'do the thing')
  }

  // The agent moves the task to done itself, exactly as the folder orchestrator prompt
  // instructs, and records the prompt it was handed plus where it ran.
  function folderAgent() {
    writeStub(
      'claude',
      `#!/bin/bash
cat > "${sandboxFile('prompt.txt')}"
pwd -P > "${sandboxFile('agent-cwd.txt')}"
TODO="$PROJECT_ROOT/.ralph/tasks/afk/todo"
DONE="$PROJECT_ROOT/.ralph/tasks/afk/done"
mkdir -p "$DONE"
f=$(ls "$TODO"/*.md 2>/dev/null | sort | head -1)
[ -n "$f" ] && mv "$f" "$DONE/"
echo '{"type":"result","subtype":"success"}'
exit 0
`,
    )
  }

  it('creates no worktree, runs the agent in the main root, and moves no HEAD', () => {
    seedTask()
    folderAgent()
    const before = treeSnapshot()

    const res = runLoop({ timeout: 40000, extraEnv: { TASK_SOURCE: 'folder' } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout).toMatch(/1 ok, 0 failed/)

    // No worktree was created for a folder task — the parent directory is not even
    // made, because lib/worktree.js is never invoked in this arm.
    expect(existsSync(join(root, '.ralph', 'worktrees'))).toBe(false)
    expect(registrations()).toEqual([`worktree ${root}`])
    expect(readIf(sandboxFile('agent-cwd.txt')).trim()).toBe(root)
    expect(treeSnapshot()).toEqual(before)
  })

  it('renders {{PROJECT_ROOT}} as the MAIN root, with no worktree path leaking in', () => {
    seedTask()
    folderAgent()
    runLoop({ timeout: 40000, extraEnv: { TASK_SOURCE: 'folder' } })
    const prompt = readIf(sandboxFile('prompt.txt'))
    expect(prompt).toContain(`Your project root is \`${root}\``)
    expect(prompt).not.toContain('.ralph/worktrees')
  })

  it('keeps its per-task transcript at the main root', () => {
    seedTask()
    folderAgent()
    runLoop({ timeout: 40000, extraEnv: { TASK_SOURCE: 'folder' } })
    expect(existsSync(join(root, 'logs', 'ralph-issue-1.log'))).toBe(true)
    expect(existsSync(join(root, 'logs', 'ralph-issue-1.jsonl'))).toBe(true)
    expect(readFileSync(join(root, 'logs', 'ralph-issue-1.jsonl'), 'utf8')).toContain(
      '"type":"result"',
    )
  })

  it('never invokes gh, which is the other half of "unchanged"', () => {
    seedTask()
    folderAgent()
    runLoop({ timeout: 40000, extraEnv: { TASK_SOURCE: 'folder' } })
    expect(
      existsSync(sandboxFile('gh-calls.log')),
      `gh was invoked in folder mode:\n${readIf(sandboxFile('gh-calls.log'))}`,
    ).toBe(false)
  })
})
