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

// QA augmentation for #224 at the LOOP level, the jira twin of test/loop.worktree.folder.qa.test.js.
// test/loop.worktree.jira.test.js (the dev's file) drives the happy detached-worktree path and two
// park shapes (dirty main tree, dev-branch checked out nowhere). This file drives the edges that
// file did not, and that only a REAL repository can settle:
//
//   1. THE FILESYSTEM-SAFE HANDLE UNDER A HOSTILE KEY. `$task_key` is passed through verbatim by
//      usableJiraKey (Jira names its own tickets), so a `/` or a space in it reaches the loop. The
//      sanitised handle has to drive the worktree path, the park branch AND the actual log file all
//      at once — a `/` that split one from another would scatter a ticket across the filesystem or
//      escape `.ralph/worktrees/`. And the `task-` prefix has to make the handle SAFE_HANDLE-valid
//      no matter what the key was.
//   2. THE `other-worktree` PARK. The dev covers dirty-main-tree and checked-out-nowhere; the third
//      refusal — $DEV_BRANCH live in ANOTHER tree — is the one where advanceOrPark must leave a
//      checkout that is not ours entirely alone and still rescue the commit onto ralph/task-<key>.
//   3. THE CREATE-FAILURE ABORT the dev flagged: `failures+=("$num")` with an EMPTY $num in jira
//      mode. The abort must still name the ticket, stop the run, leave the board unclaimed, and
//      count the failure — pinned so the empty-$num FAIL-list entry is a visible, deliberate shape.
//   4. TWO TICKETS IN ONE RUN — the actual reason jira mode does not fetch: ticket 2's detached
//      tree has to be cut from ticket 1's UNPUSHED, advanced tip. One ticket cannot show that.
//   5. THE ITERATION TELEMETRY under an empty $num: the RALPH_ISSUE_EVENT the loop appends must
//      carry the KEY and a number DERIVED from it, not a corrupt record built from the empty $num.
//
// Real git and a real `bash templates/ralph.sh`, for the dev file's reason: every claim is a
// property of a repository, and a `git` stub that exits 0 answers "yes" to both an advance and a
// park. Hermetic — a fresh repo with its own bare `origin` under the OS temp dir, removed in
// afterEach. Nothing here touches this checkout, and no test runs the real `acli` (a bash stub on
// a prepended PATH; a claim/complete is a WRITE to a board).

const RALPH_TEMPLATE = templatePath('ralph.sh')
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

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
    RALPH_TMUX_SESSION: 'ralph-worktree-jira-qa',
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
const worktreeDir = (handle) => join(root, '.ralph', 'worktrees', handle)
const parkExists = (handle) =>
  gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/ralph/${handle}`]).status === 0
const lines = (name) =>
  readIf(sandboxFile(name))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

const registrations = () =>
  git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))

const DIRTY_README = 'seed\nlocal edit not committed\n'

// The eligibility queue as an ORDERED list of keys in a file, so one stub serves both the
// single-ticket tests and the two-ticket one. count = unclaimed, pick = first unclaimed, and a
// successful claim (`edit --labels …,in-progress`) touches a per-key flag that drops it from
// both — exactly the read-then-union shape lib/jira-queue.js drives. bash 3.2 clean (no mapfile,
// no associative arrays), because the stub runs under /bin/bash like templates/ralph.sh.
function setQueue(...keys) {
  writeFileSync(sandboxFile('acli-keys.txt'), keys.join(LF) + LF)
}
function acliStub() {
  writeStub(
    'acli',
    `#!/bin/bash
SB="${sandbox}"
CLAIMED_DIR="$SB/claimed"; LABELS_DIR="$SB/labels"
mkdir -p "$CLAIMED_DIR" "$LABELS_DIR"
{ echo "ARGC:$#"; for a in "$@"; do echo "ARG:$a"; done; } >> "$SB/acli-called.log"
asked=""; prev=""
for a in "$@"; do [ "$prev" = "--key" ] && asked="$a"; prev="$a"; done
kf() { printf '%s' "$1" | tr '/ ' '__'; }
KEYS=()
while IFS= read -r line; do [ -n "$line" ] && KEYS+=("$line"); done < "$SB/acli-keys.txt"
count_unclaimed() { local n=0; for k in "\${KEYS[@]}"; do [ -f "$CLAIMED_DIR/$(kf "$k")" ] || n=$((n+1)); done; echo "$n"; }
first_unclaimed() { for k in "\${KEYS[@]}"; do [ -f "$CLAIMED_DIR/$(kf "$k")" ] || { printf '%s' "$k"; return; }; done; }
case "$*" in
  *--count*)
    count_unclaimed ;;
  *"--limit 1"*)
    k=$(first_unclaimed)
    if [ -z "$k" ]; then echo '[]'; else printf '[{"key":"%s","fields":{"summary":"do the thing"}}]\\n' "$k"; fi ;;
  *" view "*)
    lf="$LABELS_DIR/$(kf "$asked")"
    if [ -f "$lf" ]; then list=$(cat "$lf"); else list=""; fi
    if [ -z "$list" ]; then
      echo '{"fields":{"labels":[]}}'
    else
      echo '{"fields":{"labels":['"$(printf '%s' "$list" | sed 's/[^,][^,]*/"&"/g')"']}}'
    fi ;;
  *" edit "*)
    lf="$LABELS_DIR/$(kf "$asked")"
    prev=""
    for a in "$@"; do
      case "$prev" in
        --labels)
          printf '%s' "$a" > "$lf"
          case ",$a," in *,in-progress,*) touch "$CLAIMED_DIR/$(kf "$asked")" ;; esac ;;
        --remove-labels)
          old=$(cat "$lf" 2>/dev/null || true); new=""
          OLDIFS=$IFS; IFS=','
          for l in $old; do [ "$l" = "$a" ] || new="\${new:+$new,}$l"; done
          IFS=$OLDIFS
          printf '%s' "$new" > "$lf" ;;
      esac
      prev="$a"
    done ;;
esac
exit 0
`,
  )
}

// The jira agent, on a detached HEAD: commit, create no branch, and (when completing) mark the
// ticket done through lib/jira-queue.js — the command step 7 names. Uses the RUNTIME
// $RALPH_TASK_KEY so one stub serves any key, and APPENDS its cwd/head so a two-ticket run's order
// is itself observable.
function jiraAgent({ completes = true } = {}) {
  writeStub(
    'claude',
    `#!/bin/bash
cat > "${sandboxFile('prompt.txt')}"
pwd -P >> "${sandboxFile('agent-cwds.txt')}"
git rev-parse --abbrev-ref HEAD >> "${sandboxFile('agent-branches.txt')}" 2>&1
echo "hello from $RALPH_TASK_KEY" > agent-file.txt
git add agent-file.txt
git commit -q -m "feat: agent work (\${RALPH_TASK_KEY})"
git rev-parse HEAD >> "${sandboxFile('agent-heads.txt')}"
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
  sandbox = mkdtempSync(join(tmpdir(), 'ralph-worktree-jira-qa-'))
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
  // stays at A. A create that fetched would drop B.
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

  writeStub('node', `#!/bin/bash\nexec "${REAL_NODE}" "$@"\n`)
  acliStub()
  setQueue('FOO-123')
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
  writeStub('gh', `#!/bin/bash\necho "$*" >> "${sandboxFile('gh-calls.log')}"\nexit 0\n`)
  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
})

afterEach(() => {
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. The filesystem-safe handle, under a key the SAFE_HANDLE regex would reject
// ---------------------------------------------------------------------------

describe('ralph.sh jira arm — one sanitised handle drives worktree, park branch AND log (#224 QA)', () => {
  it('a key with a `/` cannot split the three surfaces, and never escapes .ralph/worktrees', () => {
    // `FOO/1` is a key usableJiraKey passes through verbatim (its grammar wants `FOO-1`), so the
    // `/` reaches the loop. `${task_key//[^A-Za-z0-9._-]/_}` maps it to `FOO_1`, and the whole
    // point is that ONE sanitised handle names all three surfaces: the worktree `task-FOO_1`, the
    // park branch `ralph/task-FOO_1`, and the log `ralph-issue-FOO_1.log`. A `/` surviving into
    // any one of them would name `task-FOO/1` (which lib/worktree.js REFUSES) or the nested path
    // `logs/ralph-issue-FOO/1.log` (a directory that does not exist) — scattering or aborting.
    //
    // Driven through a PARK (dirty main tree) so the park branch actually materialises and can be
    // asserted by name against the agent's real sha.
    setQueue('FOO/1')
    writeFileSync(join(root, 'README.md'), DIRTY_README)

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()

    // The create was NOT refused — a `task-FOO/1` handle would have thrown SAFE_HANDLE and aborted
    // the run before the agent ran. The agent ran, in the sanitised worktree.
    expect(res.stderr).not.toMatch(/must match|refusing the task handle/)
    expect(existsSync(sandboxFile('prompt.txt'))).toBe(true)
    expect(lines('agent-cwds.txt')).toEqual([worktreeDir('task-FOO_1')])
    expect(existsSync(worktreeDir('task-FOO_1'))).toBe(true)

    const agentSha = lines('agent-heads.txt')[0]

    // ALL THREE SURFACES carry the SAME sanitised handle.
    expect(git(['rev-parse', 'refs/heads/ralph/task-FOO_1']).trim()).toBe(agentSha) // park branch
    expect(existsSync(join(root, 'logs', 'ralph-issue-FOO_1.log'))).toBe(true) // log file

    // NOTHING escaped: no `/`-split path anywhere.
    expect(existsSync(worktreeDir('task-FOO'))).toBe(false)
    expect(existsSync(join(root, '.ralph', 'worktrees', 'task-FOO', '1'))).toBe(false)
    expect(existsSync(join(root, 'logs', 'ralph-issue-FOO'))).toBe(false)

    // The human is told where the parked commit is, by both names.
    expect(res.stderr).toContain('ralph/task-FOO_1')
    expect(res.stderr).toContain(agentSha)

    // A park is not a failure: the ticket completed on the board, so the run is a success.
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(res.status).toBe(0)
  })

  it('a key with a space is sanitised the same way, and the create still succeeds', () => {
    // A space is also outside `[A-Za-z0-9._-]`, and would break the argv/redirection if it reached
    // a path unquoted. `foo 1` → `foo_1`, an accepted handle; the agent runs in `task-foo_1` and
    // the branch advances cleanly (no dirt this time), proving the sanitisation is not park-only.
    setQueue('foo 1')

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stderr).not.toMatch(/must match|refusing the task handle/)
    expect(lines('agent-cwds.txt')).toEqual([worktreeDir('task-foo_1')])
    expect(existsSync(join(root, 'logs', 'ralph-issue-foo_1.log'))).toBe(true)

    const agentSha = lines('agent-heads.txt')[0]
    // Clean tree → fast-forward, no park.
    expect(git(['rev-parse', 'main']).trim()).toBe(agentSha)
    expect(parkExists('task-foo_1')).toBe(false)
    expect(res.stdout).toMatch(/1 ok, 0 failed/)
  })
})

// ---------------------------------------------------------------------------
// 2. The `other-worktree` park — the third refusal the dev file does not reach
// ---------------------------------------------------------------------------

describe('ralph.sh jira arm — a dev branch live in another tree parks the commit (#224 QA)', () => {
  it('leaves that other tree untouched and rescues the commit onto ralph/task-<key>', () => {
    // $DEV_BRANCH (`main`) is checked out in a SEPARATE worktree while the loop's own root sits on
    // a different branch. advanceOrPark finds the branch held by a tree that is not `cwd`, so it
    // must PARK rather than fast-forward someone else's checkout. This is the holder!==cwd arm,
    // distinct from the dev's dirty-tree and checked-out-nowhere cases.
    git(['checkout', '-q', '-b', 'feature/x'])
    const otherTree = join(sandbox, 'other-main')
    git(['worktree', 'add', '-q', otherTree, 'main'])
    const otherBefore = git(['rev-parse', 'HEAD'], otherTree).trim()
    expect(otherBefore).toBe(localOnlySha)

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()

    const agentSha = lines('agent-heads.txt')[0]

    // main was NOT advanced — the holder is not ours.
    expect(git(['rev-parse', 'main']).trim()).toBe(localOnlySha)
    // The OTHER tree is exactly as it was: same HEAD, same branch, no agent file.
    expect(git(['rev-parse', 'HEAD'], otherTree).trim()).toBe(otherBefore)
    expect(git(['symbolic-ref', 'HEAD'], otherTree).trim()).toBe('refs/heads/main')
    expect(existsSync(join(otherTree, 'agent-file.txt'))).toBe(false)
    // The loop's own root is still on its own branch, untouched.
    expect(git(['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/feature/x')

    // The commit is rescued and the human is told, naming the reason, the branch and the sha.
    expect(git(['rev-parse', 'refs/heads/ralph/task-FOO-123']).trim()).toBe(agentSha)
    expect(res.stderr).toContain('other-worktree')
    expect(res.stderr).toContain('ralph/task-FOO-123')
    expect(res.stderr).toContain(agentSha)

    // The ticket still completed: a branch Ralph could not advance is not a ticket Ralph failed.
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(res.status).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. The create-failure abort — the empty-$num edge the dev flagged
// ---------------------------------------------------------------------------

describe('ralph.sh jira arm — a worktree it cannot create aborts the run (#224 QA)', () => {
  it('aborts naming the ticket, never claims the board, and counts the failure (empty $num)', () => {
    // $DEV_BRANCH names no local branch — the misconfiguration jira mode is most exposed to,
    // since it never fetches. create-detached throws, the loop hits the abort check BEFORE the
    // jira arm's claim, and stops. The abort message names the TICKET via `$task_label`
    // ("ticket FOO-123") even though `$num` is empty in this mode. That empty `$num` is what the
    // dev flagged: `failures+=("$num")` records a blank, so the count is right (1) but the FAIL
    // list carries a bare `#`, not the key. Pinned so a later "fix" to use `$task_key` reddens a
    // test and is made on purpose rather than by accident.
    const before = {
      tip: git(['rev-parse', 'HEAD']).trim(),
      head: git(['symbolic-ref', 'HEAD']).trim(),
      status: git(['status', '--porcelain']),
    }

    const res = runLoop({ extraEnv: { DEV_BRANCH: 'no-such-branch' } })

    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    // The abort NAMES the ticket, which is the human-facing signal that survives the empty $num.
    expect(res.stderr).toContain('could not create a worktree for ticket FOO-123')
    // The agent never ran, in the worktree (there is none) or anywhere.
    expect(existsSync(sandboxFile('prompt.txt'))).toBe(false)
    expect(existsSync(sandboxFile('agent-cwds.txt'))).toBe(false)
    // The board was never claimed — the abort precedes the jira arm's claim, so the ticket stays
    // eligible rather than being stranded `in-progress`.
    expect(existsSync(join(sandbox, 'claimed', 'FOO-123'))).toBe(false)
    // Nothing created, nothing written, nothing switched.
    expect(existsSync(worktreeDir('task-FOO-123'))).toBe(false)
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(before.tip)
    expect(git(['symbolic-ref', 'HEAD']).trim()).toBe(before.head)
    expect(git(['status', '--porcelain'])).toBe(before.status)
    expect(parkExists('task-FOO-123')).toBe(false)
    // Counted as a failure of the RUN.
    expect(res.stdout).toMatch(/0 ok, 1 failed/)
    // THE EMPTY-$num SHAPE, pinned: the FAIL list is a bare `#`, not `#FOO-123`.
    expect(res.stdout).toMatch(/FAIL: #/)
    expect(res.stdout).not.toMatch(/FAIL:[^\n]*FOO-123/)
  })

  it('aborts the same way when $DEV_BRANCH names a TAG rather than a branch', () => {
    // The base that RESOLVES but cannot be advanced: create-detached refuses anything but a local
    // branch, because `advance` moves `refs/heads/<DEV_BRANCH>` and a tag has none. The refusal
    // must reach the loop's abort (naming the base) rather than a warning that lets the agent run.
    git(['tag', 'v1.0'])
    const before = git(['rev-parse', 'HEAD']).trim()

    const res = runLoop({ extraEnv: { DEV_BRANCH: 'v1.0' } })

    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stderr).toContain('could not create a worktree for ticket FOO-123')
    expect(res.stderr).toContain('v1.0')
    expect(existsSync(sandboxFile('prompt.txt'))).toBe(false)
    expect(existsSync(worktreeDir('task-FOO-123'))).toBe(false)
    expect(existsSync(join(sandbox, 'claimed', 'FOO-123'))).toBe(false)
    expect(res.stdout).toMatch(/0 ok, 1 failed/)
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(before)
    expect(git(['rev-parse', 'refs/tags/v1.0']).trim()).toBe(before)
    expect(parkExists('task-FOO-123')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. Two tickets in one run — the reason there is no fetch
// ---------------------------------------------------------------------------

describe('ralph.sh jira arm — ticket 2 builds on ticket 1 unpushed commit (#224 QA)', () => {
  it('chains the detached trees through the LOCAL branch and fast-forwards it twice', () => {
    // Nothing here is reachable from origin/main. A create that fetched and based ticket 2 on
    // origin/$DEV_BRANCH would cut it from commit A and drop both B and ticket 1's work — so this
    // chain is the load-bearing proof of "no fetch, ever" that one ticket cannot give.
    setQueue('FOO-1', 'FOO-2')
    expect(git(['status', '--porcelain'])).toBe('')

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/2 ok, 0 failed/)

    // Each ticket got its OWN detached tree, named after its sanitised key, in order.
    expect(lines('agent-cwds.txt')).toEqual([worktreeDir('task-FOO-1'), worktreeDir('task-FOO-2')])
    const [first, second] = lines('agent-heads.txt')
    expect(first).not.toBe(second)

    // THE CHAIN: ticket 2's commit sits on ticket 1's, which sits on the never-pushed commit B.
    expect(git(['rev-parse', `${second}^`]).trim()).toBe(first)
    expect(git(['rev-parse', `${first}^`]).trim()).toBe(localOnlySha)

    // The branch ends at the last commit, having moved by fast-forward BOTH times, and the user's
    // tree is still on `main` throughout.
    expect(git(['rev-parse', 'main']).trim()).toBe(second)
    expect(git(['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main')
    const reflog = git(['reflog', 'show', '--format=%gs', 'main']).split('\n')
    expect(reflog[0]).toBe(`merge ${second}: Fast-forward`)
    expect(reflog[1]).toBe(`merge ${first}: Fast-forward`)
    // Nothing parked; both files landed in the user's checkout.
    expect(parkExists('task-FOO-1')).toBe(false)
    expect(parkExists('task-FOO-2')).toBe(false)
    expect(existsSync(join(root, 'agent-file.txt'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Iteration telemetry under an empty $num
// ---------------------------------------------------------------------------

describe('ralph.sh jira arm — the issue event carries the key, not a corrupt empty $num (#224 QA)', () => {
  it('appends one valid RALPH_ISSUE_EVENT keyed by the ticket, number derived from the key', () => {
    // $num is deliberately empty in jira mode, but capture-issue-event.js derives the numeric
    // field from RALPH_TASK_KEY (`FOO-123` → 123) and records the key beside it. The event must
    // be one well-formed record — an empty $num must not leave it blank or unparseable. Each line
    // is `RALPH_ISSUE_EVENT <json>` (lib/issue-metrics.js), so the tag is stripped before parse.
    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.stdout).toMatch(/1 ok, 0 failed/)

    const eventsPath = join(root, '.ralph', 'metrics', 'issues.jsonl')
    expect(existsSync(eventsPath)).toBe(true)
    const rows = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l.replace(/^RALPH_ISSUE_EVENT\s+/, ''))) // throws if the record is corrupt
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const ev = rows[rows.length - 1]
    expect(ev.task_key).toBe('FOO-123')
    expect(ev.issue_number).toBe(123)
  })
})

// Guard against a literal control byte sneaking into this source via a copied fixture.
describe('ralph.sh jira worktree QA suite — no hidden control bytes', () => {
  it('builds tab/newline constants from char codes', () => {
    expect(TAB).toBe('\t')
    expect(LF).toBe('\n')
  })
})
