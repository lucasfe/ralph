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

// #224 — a jira ticket is resolved in a DETACHED worktree, and afterwards the loop either
// advances $DEV_BRANCH itself or parks the commit on `ralph/task-<safe-key>`. This is folder
// mode's treatment (#221) reusing the SAME lib/worktree.js `advance`/`advanceOrPark`, on the
// same advance-or-park seam — the difference from folder is only which SOURCE selects the
// ticket and how it is marked done (a Jira label, via lib/jira-queue.js).
//
// WHY REAL GIT, like test/loop.worktree.folder.test.js and unlike test/loop.jira.adversarial.test.js
// Every claim here is a property of a repository: which ref moved, which one did not, what the
// user's working tree still holds afterwards. A `git` stub that `exit 0`s cannot tell an advance
// from a park — it answers "yes" to both. The adversarial suite owns the SHELL wiring against a
// stubbed git; this file owns the git behaviour.
//
// WHY THE FIXTURE'S `origin` IS DELIBERATELY STALE
// The main root is one commit AHEAD of `origin/main`: commit A is pushed, commit B is
// local-only. Jira mode never pushes, so a worktree cut from `origin/$DEV_BRANCH` would silently
// drop B — the agent's commit must have B as its PARENT, which is only true if the LOCAL branch
// was the base and nothing was fetched before the create.
//
// THE AGENT STUB COMMITS FOR REAL on the detached HEAD it wakes on, and completes the ticket the
// way step 7 of prompt-team-jira.md tells it to — `node lib/jira-queue.js complete <KEY>` against
// the fake acli on PATH — so "the loop advanced the branch to the agent's commit" and "the loop
// parked it" are both statements about a real commit object AND a really-completed ticket.
//
// HERMETIC: nothing here touches this repository. A fresh clone-shaped repo with its own bare
// `origin` under the OS temp dir, and afterEach removes the whole sandbox. NO TEST RUNS THE REAL
// `acli`: it is a bash script on a prepended PATH, and a claim/complete is a WRITE to a board.

const RALPH_TEMPLATE = templatePath('ralph.sh')
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

const KEY = 'FOO-123'
const JQL = 'project = RALPH AND statusCategory != Done'
const LF = String.fromCharCode(0x0a)
const TAB = String.fromCharCode(0x09)

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
    RALPH_TMUX_SESSION: 'ralph-worktree-jira-test',
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
    // On the CHILD env only: test/setup/hermetic-env.js deletes DEV_BRANCH from the worker
    // because templates/ralph.config.sh declares it, and this fixture writes no config.
    DEV_BRANCH: 'main',
    TASK_SOURCE: 'jira',
    JIRA_JQL: JQL,
    ...extraEnv,
  }
  return spawnSync('bash', [RALPH_TEMPLATE], { cwd: workdir, env, timeout, encoding: 'utf8' })
}

const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const sandboxFile = (name) => join(sandbox, name)
const worktreeDir = (handle = 'task-FOO-123') => join(root, '.ralph', 'worktrees', handle)

const registrations = () =>
  git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))

const DIRTY_README = 'seed\nlocal edit not committed\n'

// The fake acli: label-remembering, key-aware, exactly the shape lib/jira-queue.js drives (the
// same design test/loop.jira.adversarial.test.js proves). A SUCCESSFUL claim writes the flag
// that drains the queue and the labels file that later `view`s answer from, so the ticket really
// leaves the board and `locate` really reports what completion wrote.
function acliStub() {
  writeFileSync(sandboxFile('acli-key.txt'), KEY)
  writeFileSync(sandboxFile('acli-count.txt'), `1${LF}`)
  writeFileSync(sandboxFile('acli-pick.json'), JSON.stringify([{ key: KEY, fields: { summary: 'Do the thing' } }]))
  // Seeded document until the first write: no labels, so the claim's union is just `in-progress`.
  writeFileSync(sandboxFile('acli-view.json'), `{"key":${JSON.stringify(KEY)},"fields":{"labels":[]}}`)
  writeStub(
    'acli',
    `#!/bin/bash
RALPH_TEST_FLAG="${sandboxFile('acli-claimed')}"
RALPH_TEST_LABELS="${sandboxFile('acli-labels.txt')}"
{
  echo "ARGC:$#"
  for a in "$@"; do echo "ARG:$a"; done
} >> "${sandboxFile('acli-called.log')}"
asked=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--key" ]; then asked="$a"; fi
  prev="$a"
done
want=$(cat "${sandboxFile('acli-key.txt')}")
case "$*" in
  *--count*)
    if [ -f "$RALPH_TEST_FLAG" ]; then echo 0; else cat "${sandboxFile('acli-count.txt')}"; fi ;;
  *"--limit 1"*)
    if [ -f "$RALPH_TEST_FLAG" ]; then echo '[]'; else cat "${sandboxFile('acli-pick.json')}"; fi ;;
  *" view "*)
    if [ "$asked" != "$want" ]; then echo "acli: work item $asked not found" >&2; exit 1; fi
    if [ -f "$RALPH_TEST_LABELS" ]; then
      list=$(cat "$RALPH_TEST_LABELS")
      if [ -z "$list" ]; then
        echo '{"fields":{"labels":[]}}'
      else
        echo '{"fields":{"labels":['"$(printf '%s' "$list" | sed 's/[^,][^,]*/"&"/g')"']}}'
      fi
    else
      cat "${sandboxFile('acli-view.json')}"
    fi ;;
  *" edit "*)
    if [ "$asked" != "$want" ]; then echo "acli: work item $asked not found" >&2; exit 1; fi
    touch "$RALPH_TEST_FLAG"
    prev=""
    for a in "$@"; do
      case "$prev" in
        --labels) printf '%s' "$a" > "$RALPH_TEST_LABELS" ;;
        --remove-labels)
          old=$(cat "$RALPH_TEST_LABELS" 2>/dev/null || true)
          new=""
          OLDIFS=$IFS; IFS=','
          for l in $old; do
            [ "$l" = "$a" ] || new="\${new:+$new,}$l"
          done
          IFS=$OLDIFS
          printf '%s' "$new" > "$RALPH_TEST_LABELS" ;;
      esac
      prev="$a"
    done ;;
esac
exit 0
`,
  )
}

// The jira agent, doing on a detached HEAD what the jira orchestrator prompt now asks for:
// commit here, create no branch, and (when `completes`) mark the ticket done through
// lib/jira-queue.js — the same command step 7 names. Paths are absolute/hardcoded rather than
// parsed from the prompt: what is under test is the loop, and a stub that read its own
// instructions could pass by agreeing with a wrong prompt.
function jiraAgent({ completes = true } = {}) {
  writeStub(
    'claude',
    `#!/bin/bash
cat > "${sandboxFile('prompt.txt')}"
pwd -P > "${sandboxFile('agent-cwd.txt')}"
git rev-parse --abbrev-ref HEAD > "${sandboxFile('agent-branch.txt')}" 2>&1
git symbolic-ref -q HEAD > "${sandboxFile('agent-symbolic-ref.txt')}" 2>&1 || echo "(detached)" > "${sandboxFile('agent-symbolic-ref.txt')}"
git branch --list > "${sandboxFile('agent-branches.txt')}"
echo "hello from the agent" > agent-file.txt
git add agent-file.txt
git commit -q -m "feat: agent work (${KEY})"
git rev-parse HEAD > "${sandboxFile('agent-head.txt')}"
${
  completes
    ? `[ -n "\${RALPH_TASK_KEY:-}" ] && node "$RALPH_PKG_DIR/lib/jira-queue.js" complete "\$RALPH_TASK_KEY" >/dev/null 2>&1 || true`
    : '# deliberately does not complete the ticket'
}
echo '{"type":"result","subtype":"success"}'
exit 0
`,
  )
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ralph-worktree-jira-'))
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

  // Commit B: the previous ticket's work, committed locally and never pushed. origin/main
  // stays at A. Every test below asserts against this sha.
  writeFileSync(join(workdir, 'from-ticket-1.txt'), 'committed locally, never pushed\n')
  execFileSync('git', ['add', 'from-ticket-1.txt'], { cwd: workdir })
  execFileSync('git', ['commit', '-q', '-m', 'chore: local only, never pushed'], { cwd: workdir })

  // git resolves symlinks in `rev-parse --show-toplevel`, and the macOS temp dir is one
  // (/var → /private/var), so PROJECT_ROOT inside the loop is the REAL path.
  root = realpathSync(workdir)
  localOnlySha = git(['rev-parse', 'HEAD']).trim()

  mkdirSync(join(workdir, 'logs'), { recursive: true })
  mkdirSync(join(workdir, '.ralph'), { recursive: true })
  writeFileSync(join(workdir, '.ralph', 'state.json'), '{}')

  // Full passthrough node, like the folder worktree suite: the real bridges (worktree.js,
  // jira-queue.js, build-prompt.js, run-state.js, capture-issue-event.js, agent-invocation.js)
  // all run for real; there is no "PROMPT" echo to fake because build-prompt.js is the real one.
  writeStub('node', `#!/bin/bash\nexec "${REAL_NODE}" "$@"\n`)
  acliStub()
  jiraAgent()
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
  // Present so the dependency check passes; jira mode must never call it.
  writeStub('gh', `#!/bin/bash\necho "$*" >> "${sandboxFile('gh-calls.log')}"\nexit 0\n`)
  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
})

afterEach(() => {
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. The tree the jira agent wakes in
// ---------------------------------------------------------------------------

describe('ralph.sh jira arm — the ticket is resolved in a detached worktree (#224)', () => {
  it('runs the agent detached at the LOCAL dev-branch tip, fetching nothing first and branching nothing', () => {
    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)

    // The agent ran in the worktree, not the user's checkout.
    expect(readIf(sandboxFile('agent-cwd.txt')).trim()).toBe(worktreeDir())

    // DETACHED: `rev-parse --abbrev-ref HEAD` prints the literal `HEAD`, and `symbolic-ref -q
    // HEAD` has nothing to print. Same measurement as folder mode after `git worktree add
    // --detach <path> main`.
    expect(readIf(sandboxFile('agent-branch.txt')).trim()).toBe('HEAD')
    expect(readIf(sandboxFile('agent-symbolic-ref.txt')).trim()).toBe('(detached)')

    // NO `task-FOO-123` BRANCH WAS CREATED — the whole reason for --detach.
    expect(readIf(sandboxFile('agent-branches.txt'))).not.toContain('task-FOO-123')

    // THE BASE WAS THE LOCAL BRANCH, not origin/main: the agent's commit sits directly on top
    // of the never-pushed commit B. A fetch-and-base-on-origin create would have made A the
    // parent and dropped B's file entirely.
    const agentSha = readIf(sandboxFile('agent-head.txt')).trim()
    expect(git(['rev-parse', `${agentSha}^`]).trim()).toBe(localOnlySha)
    expect(git(['rev-parse', 'origin/main']).trim()).not.toBe(localOnlySha)
  })

  it('tells the agent its project root is the worktree, and logs under the main root', () => {
    runLoop()
    const prompt = readIf(sandboxFile('prompt.txt'))
    // {{PROJECT_ROOT}} — where the code is: the worktree.
    expect(prompt).toContain(`Your project root is \`${worktreeDir()}\``)
    // {{MAIN_REPO_ROOT}} — where `logs/` lives: the main checkout, which the worktree is not.
    expect(prompt).toContain(`${root}/logs/ralph-issue-${KEY}.log`)
  })

  it('never invokes gh', () => {
    runLoop()
    expect(
      existsSync(sandboxFile('gh-calls.log')),
      `gh was invoked in jira mode:\n${readIf(sandboxFile('gh-calls.log'))}`,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Advancing the branch after a completed ticket
// ---------------------------------------------------------------------------

describe('ralph.sh jira arm — the loop advances the dev branch after the agent (#224)', () => {
  it('fast-forwards a clean main tree without switching its branch, and counts the ticket done', () => {
    expect(git(['status', '--porcelain'])).toBe('')

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(res.status).toBe(0)

    const agentSha = readIf(sandboxFile('agent-head.txt')).trim()
    // The commit was made in the worktree, which is what makes this about the loop's advance.
    expect(readIf(sandboxFile('agent-cwd.txt')).trim()).toBe(worktreeDir())

    // The branch moved to the agent's commit, by FAST-FORWARD (reflog), IN PLACE (same
    // symbolic ref), and the user's checkout now holds the work.
    expect(git(['rev-parse', 'main']).trim()).toBe(agentSha)
    expect(git(['reflog', 'show', '--format=%gs', 'main']).split('\n')[0]).toBe(
      `merge ${agentSha}: Fast-forward`,
    )
    expect(git(['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main')
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(agentSha)
    expect(existsSync(join(root, 'agent-file.txt'))).toBe(true)
    // Nothing was parked, because nothing had to be.
    expect(
      gitOk(['rev-parse', '--verify', '--quiet', 'refs/heads/ralph/task-FOO-123']).status,
    ).not.toBe(0)
  })

  it('updates the ref directly when the dev branch is checked out nowhere', () => {
    // The user is off on their own branch with uncommitted work. `main` is checked out in no
    // worktree, so there is no tree to fast-forward and none to disturb: the ref is written and
    // the user's checkout is not consulted.
    git(['checkout', '-q', '-b', 'feature/x'])
    writeFileSync(join(root, 'README.md'), DIRTY_README)
    const before = {
      head: git(['symbolic-ref', 'HEAD']).trim(),
      sha: git(['rev-parse', 'HEAD']).trim(),
      status: git(['status', '--porcelain']),
    }

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)

    const agentSha = readIf(sandboxFile('agent-head.txt')).trim()
    expect(git(['rev-parse', 'main']).trim()).toBe(agentSha)

    // THE USER'S TREE IS EXACTLY AS THEY LEFT IT.
    expect(git(['symbolic-ref', 'HEAD']).trim()).toBe(before.head)
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(before.sha)
    expect(git(['status', '--porcelain'])).toBe(before.status)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(DIRTY_README)
    expect(existsSync(join(root, 'agent-file.txt'))).toBe(false)
    expect(
      gitOk(['rev-parse', '--verify', '--quiet', 'refs/heads/ralph/task-FOO-123']).status,
    ).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Parking — a branch Ralph could not advance is not a ticket Ralph failed
// ---------------------------------------------------------------------------

describe('ralph.sh jira arm — an unadvanceable branch parks the commit and warns (#224)', () => {
  it('writes nothing, parks on ralph/task-<key>, names branch and sha, and keeps the done verdict', () => {
    // The user is editing a tracked file in the main tree, on the very branch the loop wants to
    // move — a dirty main tree, which Ralph parks rather than touch (its own conservatism).
    writeFileSync(join(root, 'README.md'), DIRTY_README)

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()

    const agentSha = readIf(sandboxFile('agent-head.txt')).trim()

    // NOTHING WAS WRITTEN to the branch or to the tree.
    expect(git(['rev-parse', 'main']).trim()).toBe(localOnlySha)
    expect(git(['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main')
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(localOnlySha)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(DIRTY_README)
    expect(existsSync(join(root, 'agent-file.txt'))).toBe(false)

    // THE COMMIT IS NOT LOST: reachable from a branch a human can name.
    expect(git(['rev-parse', 'refs/heads/ralph/task-FOO-123']).trim()).toBe(agentSha)
    expect(git(['log', '--format=%s', 'ralph/task-FOO-123'])).toContain(`feat: agent work (${KEY})`)

    // AND THE HUMAN IS TOLD, by both names: the park branch and the sha.
    expect(res.stderr).toContain('ralph/task-FOO-123')
    expect(res.stderr).toContain(agentSha)

    // THE TICKET'S OWN VERDICT STANDS: it was completed on the board, so the run is a success —
    // a branch Ralph could not advance is not a ticket Ralph failed.
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(res.status).toBe(0)
    expect(readIf(sandboxFile('acli-labels.txt'))).toContain('done')
  })

  it('lands the commit of a ticket it then sweeps to failed — advance runs apart from the verdict', () => {
    // The agent committed but did NOT complete the ticket, so the board never gained `done` and
    // the loop sweeps it to `failed` — yet its commit is a real commit the branch is still
    // fast-forwarded to, because the advance is not part of the verdict. The trade #224 inherits
    // from #221, pinned so it cannot be reversed by accident.
    jiraAgent({ completes: false })
    expect(git(['status', '--porcelain'])).toBe('')

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    const agentSha = readIf(sandboxFile('agent-head.txt')).trim()
    expect(agentSha).toBeTruthy()

    // The verdict: failed, swept, counted.
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/0 ok, 1 failed/)
    expect(res.stderr).toContain('was not completed')
    expect(readIf(sandboxFile('acli-labels.txt'))).toContain('failed')

    // The commit: reachable from the branch, in the user's tree, no park needed.
    expect(git(['rev-parse', 'main']).trim()).toBe(agentSha)
    expect(git(['reflog', 'show', '--format=%gs', 'main']).split('\n')[0]).toBe(
      `merge ${agentSha}: Fast-forward`,
    )
    expect(existsSync(join(root, 'agent-file.txt'))).toBe(true)
  })

  it('keeps the worktree registered, so a human can read the diff out of it', () => {
    writeFileSync(join(root, 'README.md'), DIRTY_README)
    runLoop()
    // Jira-mode teardown, like folder's, is not this slice: the parked work stays readable from
    // the worktree, and both registrations are asserted so a later teardown cannot land silently.
    expect(registrations()).toEqual([`worktree ${root}`, `worktree ${worktreeDir()}`])
    expect(git(['rev-parse', 'HEAD'], worktreeDir()).trim()).toBe(
      readIf(sandboxFile('agent-head.txt')).trim(),
    )
  })
})

// Guard against a literal control byte sneaking into this source via a copied fixture.
describe('ralph.sh jira worktree suite — no hidden control bytes', () => {
  it('builds tab/newline constants from char codes', () => {
    expect(TAB).toBe('\t')
    expect(LF).toBe('\n')
  })
})
