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
import { fileURLToPath } from 'node:url'
import { templatePath } from '../lib/paths.js'

// QA augmentation for #220 — outcome-aware worktree teardown.
//
// test/loop.worktree.test.js owns the four headline outcomes (a `pending-merge` issue
// removes, a `failed` label keeps, a non-zero agent exit keeps, a zero-progress abort
// keeps) and test/loop.worktree.qa.test.js adds one jammed removal. All five drive ONE
// issue through ONE iteration of ONE run, with the classification handed exactly one
// signal at a time. This file attacks the places that shape cannot reach:
//
//   1. THE SIGNALS DISAGREE. The classification tests `failed` FIRST, so `CLOSED` +
//      `failed` and `pending-merge` + `failed` both fall to the keep branch. Nothing
//      pinned which way those go.
//   2. THE SIGNALS ARE SUBSTRINGS. Both tests are `grep -q` against `",$labels,"`, so
//      `pending-merge-later`, `not-failed` and `failed-qa` are each a chance for a tree
//      to be deleted or kept for a reason nobody intended.
//   3. TWO ITERATIONS IN ONE RUN. Removal is per-issue now, so one run can both remove
//      and keep. A kept tree has to survive the REST of the run — including the
//      `==> Cleanup` block, which deletes merged `issue-*` branches — and must not get
//      in the way of the next issue's create.
//   4. THE RETRY. The helper's header rests its whole "keeping a tree is affordable"
//      argument on the create path reclaiming a leftover, so an issue whose tree was
//      kept and is then picked up again starts clean instead of deadlocking. That is
//      the single most load-bearing claim in the change and it needs two real runs.
//   5. THE BRANCH. `remove_issue_worktree`'s header and the Cleanup block's both claim
//      `git branch --merged` marks a worktree-held branch `+ ` so the pruning skips it.
//      Asserted here in situ, with the same run in its removing form as anti-vacuity.
//   6. THE OTHER SOURCES. folder mode reaches no classification at all, so a worktree
//      already sitting at `.ralph/worktrees/issue-1` must come out of a folder run
//      untouched.
//   7. REFUSALS THE DEV'S ONE CASE DOES NOT COVER: a tree with local modifications, a
//      tree a human locked, a tree the agent deleted itself, and an unwritable
//      `.ralph/worktrees` — which is a different failure from an unwritable child and
//      produces a different errno.
//
// REAL GIT, for the reason the two files above give: "the tree is still there and it is
// still a registered worktree on issue-N" is a question only a repository can answer,
// and a `git` stub that `exit 0`s to `worktree remove` would agree with any teardown
// rule at all — including the unconditional one this slice replaces. `gh`, `jq`,
// `claude`, `tmux` and `curl` are stubs on a prepended PATH; `node` is the real binary,
// so lib/worktree.js and lib/build-prompt.js are the code under test.
//
// HERMETIC: every fixture is a fresh repository under the OS temp dir with its own bare
// `origin` beside it, and afterEach removes the whole sandbox. Nothing here runs git
// against this repository.

const RALPH_TEMPLATE = templatePath('ralph.sh')
// The module the loop shells out to, resolved from this file rather than from the runner's
// cwd, so the one fixture that has to build a worktree WITHOUT the loop builds it the
// same way the loop would.
const WORKTREE_CLI = fileURLToPath(new URL('../lib/worktree.js', import.meta.url))
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

// The two permission tests below have to be skipped for root, for whom a 0500 directory
// is still writable and the removal would therefore simply succeed.
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

function runLoop({ timeout = 90000, extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-worktree-teardown-qa',
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
    // On the CHILD env, not assigned here: test/setup/hermetic-env.js deletes DEV_BRANCH
    // from the worker because templates/ralph.config.sh declares it.
    DEV_BRANCH: 'main',
    ...extraEnv,
  }
  return spawnSync('bash', [RALPH_TEMPLATE], { cwd: workdir, env, timeout, encoding: 'utf8' })
}

const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const sandboxFile = (name) => join(sandbox, name)
// What an agent stub wrote for one issue. Empty rather than a throw when the file is
// missing, so a test that expected an iteration to happen fails on the assertion it
// cares about instead of on an ENOENT.
const recorded = (name) => readIf(sandboxFile(`${name}.txt`))
const worktreeDir = (handle) => join(root, '.ralph', 'worktrees', handle)

// One line per registered worktree. Used in both directions here: to say a removed tree
// left no ghost record, and to say a KEPT tree is a live worktree rather than an
// orphaned directory — which is the entire value of keeping it, since what a human does
// with it is `git -C .ralph/worktrees/issue-N diff`.
const registrations = () =>
  git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))

const branchExists = (name) => git(['branch', '--list', name]).trim() !== ''

// --- The gh stub: a QUEUE of issues, each with its own labels and state ------
// The dev's stub answers for one issue. This one is driven off a file holding the
// numbers still to be handed out, so a single run can work #98 and then #99 and the
// classification can be given a different verdict for each — which is what "one run
// both removes and keeps" needs. `gh issue list --search … sort:created-asc` pops the
// head; the loop's other `gh issue list` (its queue_count) reports how many are left.
function setQueue(numbers) {
  writeFileSync(sandboxFile('queue.txt'), numbers.map((n) => `${n}\n`).join(''))
}

// `state` and `labels` are what templates/ralph.sh classifies from, and since #220 the
// classification is also what decides teardown, so they are the knob every test turns.
function setIssue(num, { state = 'OPEN', labels = '' } = {}) {
  writeFileSync(sandboxFile(`state-${num}.txt`), `${state}\n`)
  writeFileSync(sandboxFile(`labels-${num}.txt`), `${labels}\n`)
}

function writeGh() {
  writeStub(
    'gh',
    `#!/bin/bash
echo "$*" >> "${sandboxFile('gh-calls.log')}"
Q="${sandboxFile('queue.txt')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  case "$*" in
    *sort:created-asc*)
      head -1 "$Q"
      tail -n +2 "$Q" > "$Q.next"
      mv "$Q.next" "$Q"
      ;;
    *) grep -c . "$Q" || true ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  n="$3"
  case "$*" in
    *labels*) cat "${sandboxFile('labels-')}$n.txt" 2>/dev/null || echo "" ;;
    *state*)  cat "${sandboxFile('state-')}$n.txt" 2>/dev/null || echo "OPEN" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ]; then echo "[]"; exit 0; fi
exit 0
`,
  )
}

// --- Agent stubs -------------------------------------------------------------
// Every stub records PER ISSUE, keyed off the basename of the tree it woke in
// (`issue-98`), because a two-iteration run has two of everything to compare and a
// single `prompt.txt` would only ever hold the last one.
const record = () => `
h="$(basename "$(pwd -P)")"
cat > "${sandboxFile('prompt-')}$h.txt"
pwd -P > "${sandboxFile('cwd-')}$h.txt"
git rev-parse --abbrev-ref HEAD > "${sandboxFile('branch-')}$h.txt" 2>&1
ls -A > "${sandboxFile('ls-')}$h.txt"
git status --porcelain > "${sandboxFile('status-')}$h.txt" 2>&1
`

// Commits, and leaves something UNCOMMITTED as well. The uncommitted half is the thing
// #218's unconditional teardown destroyed and #220 exists to keep, so every stub here
// leaves one: a tree whose contents were all committed would make a keep
// indistinguishable from a removal, the branch holding the commits either way.
const AGENT_OK = () => `#!/bin/bash
${record()}
echo "committed by the agent" > agent-file.txt
git add agent-file.txt
git commit -q -m "feat($(basename "$(pwd -P)")): agent work"
echo "half-finished" > scratch-from-agent.txt
echo '{"type":"result","subtype":"success"}'
exit 0
`

// Exits ZERO having changed no exclusion state — the way to ask for a LABEL-driven
// branch without an exit code that could explain a keep on its own.
const AGENT_OK_NO_COMMIT = () => `#!/bin/bash
${record()}
echo "half-finished" > scratch-from-agent.txt
echo '{"type":"result","subtype":"success"}'
exit 0
`

// Exits non-zero after writing something it never committed.
const AGENT_FAILS = () => `#!/bin/bash
${record()}
echo "half-finished" > scratch-from-agent.txt
echo '{"type":"result","subtype":"error"}'
echo "agent exploded" >&2
exit 7
`

// LOCAL MODIFICATIONS, in all three states a working tree can hold them: a modified
// TRACKED file, a STAGED change, and an untracked file. This is the case #220's
// acceptance criterion names as one git refuses to remove — see the test.
const AGENT_LEAVES_MODIFICATIONS = () => `#!/bin/bash
${record()}
echo "modified in the worktree" > README.md
echo "staged in the worktree" > tracked-and-staged.txt
git add tracked-and-staged.txt
echo untracked > untracked-in-the-worktree.txt
echo '{"type":"result","subtype":"success"}'
exit 0
`

// LOCKS its own tree, which is what a human protecting a tree they want to read looks
// like from out here — `git worktree lock` is the one refusal git will not let a prune
// undo, and the only one lib/worktree.js escalates for.
const AGENT_LOCKS_ITS_TREE = () => `#!/bin/bash
${record()}
echo "half-finished" > scratch-from-agent.txt
git worktree lock "$(pwd -P)"
echo '{"type":"result","subtype":"success"}'
exit 0
`

// Deletes the tree it was handed, from outside it, so teardown is aimed at a registered
// worktree whose directory is already gone.
const AGENT_DELETES_ITS_TREE = () => `#!/bin/bash
${record()}
here="$(pwd -P)"
cd /
rm -rf "$here"
echo '{"type":"result","subtype":"success"}'
exit 0
`

// JAMS THE TEARDOWN FROM THE PARENT, not from a child. The dev's stub drops permissions
// on a directory INSIDE the tree; this one drops them on `.ralph/worktrees` itself, and
// the two are not the same failure — see the test for both measurements.
const AGENT_JAMS_THE_PARENT = () => `#!/bin/bash
${record()}
echo "half-finished" > scratch-from-agent.txt
chmod 0500 "$(dirname "$(pwd -P)")"
echo '{"type":"result","subtype":"success"}'
exit 0
`

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ralph-worktree-teardown-qa-'))
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
  // `.ralph/` is what `ralph init` appends, which is why a live worktree under
  // `.ralph/worktrees` is invisible to `git status` — the property that lets a kept tree
  // cost the user's checkout nothing. `logs/` keeps the transcripts out of it too.
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

  setQueue([98])
  setIssue(98, { state: 'CLOSED' })

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
    // Restore anything the permission tests dropped, or the recursive delete below
    // cannot finish either. Both the parent and any child a stub jammed.
    const parent = join(workdir ?? '', '.ralph', 'worktrees')
    if (existsSync(parent)) {
      try {
        chmodSync(parent, 0o755)
        for (const entry of readdirSync(parent)) {
          const jammed = join(parent, entry, 'undeletable')
          if (existsSync(jammed)) chmodSync(jammed, 0o755)
        }
      } catch {
        /* already writable */
      }
    }
    rmSync(sandbox, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 1. When the classification's two signals disagree
// ---------------------------------------------------------------------------
//
// templates/ralph.sh asks `failed` FIRST and `CLOSED`/`pending-merge` second, so an
// issue carrying both never reaches the branch that removes. Nothing in the dev's suite
// hands the classification more than one signal, so nothing says whether that ordering
// is the intended reading of #220 — and it is the ordering that decides whether a tree
// gets deleted. Pinned in the direction that is safe either way: a `failed` label means
// somebody is going to look, and the tree is what they look at.

describe('a classification given two signals keeps the tree whenever one of them is `failed` (#220 QA)', () => {
  it.each([
    ['CLOSED and `failed` together', { state: 'CLOSED', labels: 'failed' }],
    ['`pending-merge` and `failed` together', { state: 'OPEN', labels: 'pending-merge,failed' }],
    ['CLOSED, `pending-merge` and `failed` all three', { state: 'CLOSED', labels: 'pending-merge,failed' }],
  ])('keeps it for %s, and counts the iteration a failure', (_label, issue) => {
    writeStub('claude', AGENT_OK_NO_COMMIT())
    setIssue(98, issue)
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    // `failed` wins the classification outright: not a partial, a failure.
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/0 ok, 1 failed/)

    expect(existsSync(worktreeDir('issue-98'))).toBe(true)
    expect(readIf(join(worktreeDir('issue-98'), 'scratch-from-agent.txt'))).toBe('half-finished\n')
    // …and a LIVE worktree, so `git -C … diff` works on it.
    expect(registrations()).toContain(`worktree ${worktreeDir('issue-98')}`)
  })

  it('removes it for `pending-merge` even when the AGENT exited non-zero', () => {
    // The third disagreement, and the only one where #220's acceptance criterion reads
    // one way ("an agent that exits non-zero keeps the worktree") and the code goes the
    // other. It goes the other way on purpose: the classification greps the labels first
    // and consults $claude_failed only in its `else` arm, so an agent that got the PR up
    // and then died on the way out is a FINISHED issue — there is a PR to read, and the
    // tree holds nothing the branch does not. Untested until now on either side, which
    // for a divergence between the criterion's words and the code is the worst state to
    // leave it in: it would look like a bug to the next reader either way.
    writeStub('claude', AGENT_FAILS())
    setIssue(98, { state: 'OPEN', labels: 'pending-merge' })
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    // Counted a success, and the exit code was never consulted — the `else` arm's
    // "Marking failed" warning is the one thing that would prove it had been.
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(res.stderr).not.toMatch(/claude failed on issue #98/)
    // The agent really did fail, so this is not a run that quietly succeeded.
    expect(res.stderr).toContain('agent exploded')
    // And the tree went, uncommitted leftover and all, with no ghost record.
    expect(existsSync(worktreeDir('issue-98'))).toBe(false)
    expect(registrations()).toEqual([`worktree ${root}`])
    expect(res.stderr).not.toMatch(/could not remove the worktree/)
  })

  it('removes it for CLOSED and `pending-merge` together, since neither is a failure', () => {
    // The complement of the cases above: two SUCCESS signals at once must still take
    // exactly one trip through the removing branch, not none and not a double.
    setIssue(98, { state: 'CLOSED', labels: 'pending-merge' })
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(existsSync(worktreeDir('issue-98'))).toBe(false)
    expect(registrations()).toEqual([`worktree ${root}`])
    // No second removal complained about a tree that was already gone.
    expect(res.stderr).not.toMatch(/could not remove the worktree/)
  })
})

// ---------------------------------------------------------------------------
// 2. Labels that merely LOOK like the two the classification greps for
// ---------------------------------------------------------------------------
//
// Both tests are `echo ",$labels," | grep -q ",<name>,"`, so the commas are the whole
// guard against a substring match. A label named `failed-qa` matching would keep a
// finished issue's tree forever; a label named `pending-merge-later` matching would
// DELETE an unfinished issue's tree, which is the loss #220 exists to prevent. Neither
// direction is pinned anywhere, so both are pinned here — as the behaviour the commas
// actually produce, which in every case below is the reading a human would want.

describe('the label match is exact, so a lookalike label decides nothing (#220 QA)', () => {
  it.each([
    // Lookalikes of `failed`, on an issue that IS finished: the tree must still go.
    ['not-failed on a CLOSED issue', 'removed', { state: 'CLOSED', labels: 'not-failed' }],
    ['failed-qa on a CLOSED issue', 'removed', { state: 'CLOSED', labels: 'failed-qa' }],
    ['qa-failed on a CLOSED issue', 'removed', { state: 'CLOSED', labels: 'qa-failed' }],
    // …and the real thing in a LIST still keeps it, so the negatives above are not just
    // "this fixture never keeps anything".
    ['a real `failed` among other labels', 'kept', { state: 'CLOSED', labels: 'area:cli,failed,p1' }],
    // Lookalikes of `pending-merge`, on an issue that is NOT finished: the tree must stay.
    ['pending-merge-later on an OPEN issue', 'kept', { state: 'OPEN', labels: 'pending-merge-later' }],
    ['not-pending-merge on an OPEN issue', 'kept', { state: 'OPEN', labels: 'not-pending-merge' }],
    // …and the real thing in a list still removes it.
    ['a real `pending-merge` among other labels', 'removed', { state: 'OPEN', labels: 'area:cli,pending-merge,p1' }],
  ])('%s is %s', (_label, verdict, issue) => {
    writeStub('claude', AGENT_OK_NO_COMMIT())
    setIssue(98, issue)
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(existsSync(worktreeDir('issue-98'))).toBe(verdict === 'kept')
    // The verdict line is the other half of the classification and must agree with it:
    // a removal only ever happens on the success branch.
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(
      verdict === 'kept' ? /0 ok, 1 failed/ : /1 ok, 0 failed/,
    )
  })
})

// ---------------------------------------------------------------------------
// 3. Two iterations in one run: one removes, one keeps
// ---------------------------------------------------------------------------
//
// This is the shape #220 created and #218 could not have: before it, every iteration
// ended the same way, so "the run" and "an iteration" were the same question. Now a
// single run can leave one tree on disk and take another away, and the kept one has to
// live through everything that comes after it — the next iteration's `git worktree add`,
// the next iteration's own teardown, and the `==> Cleanup` block, which runs `git branch
// -d` over merged `issue-*` branches.

describe('one run, two issues, two different outcomes (#220 QA)', () => {
  it('removes the finished issue tree and keeps the failed one, in that order', () => {
    setQueue([98, 99])
    setIssue(98, { state: 'CLOSED' })
    setIssue(99, { state: 'OPEN', labels: 'failed' })
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 1 failed/)
    // Both iterations really ran, in the order the queue handed them out.
    expect(res.stdout).toContain('==> Iteration for issue #98')
    expect(res.stdout).toContain('==> Iteration for issue #99')
    expect(res.stdout).toContain('==> Cleanup')

    expect(existsSync(worktreeDir('issue-98'))).toBe(false)
    expect(existsSync(worktreeDir('issue-99'))).toBe(true)
    // Exactly one leftover, named for the issue that needs looking at, and it is a live
    // worktree on its own branch.
    expect(readdirSync(join(root, '.ralph', 'worktrees'))).toEqual(['issue-99'])
    expect(registrations()).toEqual([`worktree ${root}`, `worktree ${worktreeDir('issue-99')}`])
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreeDir('issue-99')).trim()).toBe(
      'issue-99',
    )
    expect(readIf(join(worktreeDir('issue-99'), 'scratch-from-agent.txt'))).toBe('half-finished\n')
  })

  it('keeps the failed one FIRST and still creates and removes the next issue tree', () => {
    // The reverse order, which asks the question the first test cannot: does a tree left
    // standing get in the way of the iteration that follows it? The leftover is at a
    // different path and holds a different branch, so it must not — but "must not" is
    // exactly the kind of claim that is worth one real run.
    setQueue([99, 98])
    setIssue(99, { state: 'OPEN', labels: 'failed' })
    setIssue(98, { state: 'CLOSED' })
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 1 failed/)
    // The second iteration was not aborted by the leftover: the loop's create failure is
    // a `break` with this line, and it never fired.
    expect(res.stderr).not.toMatch(/could not create a worktree/)
    // #98's tree came and went; #99's outlived the whole run, Cleanup block included.
    expect(existsSync(worktreeDir('issue-98'))).toBe(false)
    expect(existsSync(worktreeDir('issue-99'))).toBe(true)
    expect(readIf(join(worktreeDir('issue-99'), 'scratch-from-agent.txt'))).toBe('half-finished\n')
    // #98 was really worked in its own tree, on its own branch.
    expect(recorded('cwd-issue-98').trim()).toBe(worktreeDir('issue-98'))
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
  })

  it('gives each iteration a prompt naming its OWN worktree, with no leak from the kept one', () => {
    // RALPH_PROMPT_PROJECT_ROOT is `unset` after every agent run and re-exported by the
    // next iteration, and #220 left that unconditional while making the removal
    // conditional — so the interesting case is the iteration that FOLLOWS a keep, where
    // the previous tree is still on disk and a stale value would still resolve.
    setQueue([99, 98])
    setIssue(99, { state: 'OPEN', labels: 'failed' })
    setIssue(98, { state: 'CLOSED' })
    runLoop()

    const first = recorded('prompt-issue-99')
    const second = recorded('prompt-issue-98')
    expect(first).toContain(`Your project root is \`${worktreeDir('issue-99')}\``)
    expect(second).toContain(`Your project root is \`${worktreeDir('issue-98')}\``)
    // Neither prompt names the other issue's tree, and neither falls back to the main
    // root — the two failure modes a stale export would produce.
    expect(first).not.toContain('issue-98')
    expect(second).not.toContain('issue-99')
    expect(second).not.toContain(`Your project root is \`${root}\``)
  })
})

// ---------------------------------------------------------------------------
// 4. The retry — the claim the whole slice rests on
// ---------------------------------------------------------------------------
//
// From remove_issue_worktree's header: "THE LEFTOVER IS NOT A DEADLOCK … the create path
// clears whatever is at the path before it adds anything … so the next iteration that
// picks the SAME issue up starts from a clean tree. Which is also the kept tree's
// lifetime: it survives until ralph tries that issue again, not forever."
//
// If that is false, #220 does not merely keep a directory around — it breaks the loop for
// every issue that ever fails. It cannot be asked inside one run, because re-selecting
// the same issue in one run is what the zero-progress guard exists to stop; so it is
// asked of two runs, which is also how a human meets it (ralph runs again tomorrow).

describe('an issue whose tree was kept can be retried (#220 QA)', () => {
  it('reclaims the kept tree on the next run, hands the agent a CLEAN one, and is not deadlocked', () => {
    // RUN 1: the agent commits, leaves something uncommitted, and the issue comes back
    // `failed` — so the tree is kept, live, dirty, and holding the branch.
    writeStub('claude', AGENT_OK())
    setIssue(98, { state: 'OPEN', labels: 'failed' })
    const first = runLoop()
    expect(first.signal, `run 1 was killed by timeout. stdout:\n${first.stdout}`).toBeNull()
    expect(first.stdout).toMatch(/0 ok, 1 failed/)
    expect(existsSync(worktreeDir('issue-98'))).toBe(true)
    expect(readIf(join(worktreeDir('issue-98'), 'scratch-from-agent.txt'))).toBe('half-finished\n')

    // RUN 2: the same issue, this time finished. The queue has to be refilled — a run is
    // a process, and run 1 drained it.
    setQueue([98])
    setIssue(98, { state: 'CLOSED' })
    writeStub('claude', AGENT_OK_NO_COMMIT())
    const second = runLoop()

    expect(second.signal, `run 2 was killed by timeout. stdout:\n${second.stdout}`).toBeNull()
    // NOT DEADLOCKED: the loop turns a failed create into this line plus `break`, and the
    // whole risk of keeping trees is that it starts firing. It did not.
    expect(second.stderr).not.toMatch(/could not create a worktree/)
    expect(second.stdout, `stderr:\n${second.stderr}`).toMatch(/1 ok, 0 failed/)

    // THE AGENT WOKE IN A CLEAN TREE, on the right branch: run 1's uncommitted file was
    // not still sitting there. This is what "starts from a clean tree" has to mean —
    // anything else and the retry inherits the failure it is retrying.
    expect(recorded('cwd-issue-98').trim()).toBe(worktreeDir('issue-98'))
    expect(recorded('branch-issue-98').trim()).toBe('issue-98')
    // Asked of run 2's own iteration rather than of the disk after the fact: run 2
    // removed the tree, so the only witness is the inventory run 2's agent took while
    // it was standing in it. Run 1's uncommitted leftover is not in it, and neither is
    // run 1's committed file — the tree was reset, not merely un-dirtied.
    const inventory = recorded('ls-issue-98')
    expect(inventory).toContain('README.md')
    expect(inventory).not.toContain('scratch-from-agent.txt')
    expect(inventory).not.toContain('agent-file.txt')
    // A clean `git status` in it, too: nothing staged or modified was carried over.
    expect(recorded('status-issue-98').trim()).toBe('')

    // And run 2 finished the issue, so its tree is gone with no ghost record.
    expect(existsSync(worktreeDir('issue-98'))).toBe(false)
    expect(registrations()).toEqual([`worktree ${root}`])
  })

  it('closes the evidence window when it reclaims: the retry resets the branch too', () => {
    // The other half of "it survives until ralph tries that issue again". A human who
    // does not look before the next run loses BOTH halves of what the keep preserved,
    // and the second half is easy to miss: `remove_issue_worktree` never touches a
    // branch, but the create path adds with `-B`, which resets one.
    //
    // MEASURED (git 2.50.1, Apple Git-155): `git worktree add -B issue-98 <path>
    // origin/main` over a kept worktree holding a commit that origin/main does not have
    // exits 0, and leaves `git log issue-98` without that commit.
    writeStub('claude', AGENT_OK())
    setIssue(98, { state: 'OPEN', labels: 'failed' })
    runLoop()
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')

    setQueue([98])
    setIssue(98, { state: 'OPEN', labels: 'failed' })
    writeStub('claude', AGENT_OK_NO_COMMIT())
    const second = runLoop()
    expect(second.signal).toBeNull()

    // Run 1's commit is off the branch, and run 1's uncommitted file is off the disk.
    // The tree is kept again — for run 2's failure, not run 1's.
    expect(git(['log', '--format=%s', 'issue-98'])).not.toContain('feat(issue-98): agent work')
    expect(existsSync(worktreeDir('issue-98'))).toBe(true)
    expect(existsSync(join(worktreeDir('issue-98'), 'agent-file.txt'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. The kept tree's BRANCH, through the real Cleanup block
// ---------------------------------------------------------------------------
//
// Two comments in templates/ralph.sh make the same MEASURED claim — remove_issue_worktree's
// header and the Cleanup block's — that `git branch --merged` marks a branch held by
// another worktree with `+ ` rather than a space, so `grep -E '^\s+issue-'` never hands
// it to `git branch -d`. Both were measured at the shell; neither is asserted through the
// loop. It matters because a kept tree whose branch was pruned is half a keep: the
// header's own argument is that "the branch is half of what there is to read".
//
// The agent commits NOTHING in both tests below, deliberately: that leaves `issue-98`
// pointing exactly at origin/main, which is the only way `git branch --merged
// origin/main` lists it at all and therefore the only way the pruning is even aimed at
// it. The two tests are the same run with the classification flipped.

describe('the Cleanup pruning and a kept worktree (#220 QA)', () => {
  beforeEach(() => {
    writeStub('claude', AGENT_OK_NO_COMMIT())
  })

  it('spares the merged branch of a KEPT tree, so the tree and its branch survive together', () => {
    setIssue(98, { state: 'OPEN', labels: 'failed' })
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout).toContain('==> Cleanup')
    expect(existsSync(worktreeDir('issue-98'))).toBe(true)
    // The branch the human would read the diff against is still there.
    expect(branchExists('issue-98')).toBe(true)
    // And it really was a candidate: git lists it as merged, just marked `+ `.
    expect(git(['branch', '--merged', 'origin/main'])).toMatch(/^\+ issue-98$/m)
  })

  it('and DOES prune that same merged branch once the tree is removed', () => {
    // Anti-vacuity for the test above: identical run, identical branch, identical
    // Cleanup block — the only difference is that the issue came back CLOSED, so the
    // tree went and the branch stopped being marked `+ `. If the pruning could not
    // reach this branch at all, the test above would be saying nothing.
    setIssue(98, { state: 'CLOSED' })
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout).toContain('==> Cleanup')
    expect(existsSync(worktreeDir('issue-98'))).toBe(false)
    expect(branchExists('issue-98')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. The sources that never classify anything
// ---------------------------------------------------------------------------
//
// remove_issue_worktree guards on `[ "$TASK_SOURCE" = "github" ]`, and the folder and
// jira arms also `continue` well before the classification that calls it — belt and
// braces. What no test asks is whether a worktree ALREADY on disk survives a run in one
// of those modes, which is the only way the guard can be observed from outside: a folder
// run works task #1, so an unguarded removal would be aimed at `.ralph/worktrees/issue-1`.
//
// #221 SHARPENED THIS, and did not overturn it. Folder mode now creates a worktree of its
// own (`task-1`, detached), so the run below ends with TWO trees the guard has to leave
// alone: the leftover `issue-1` an unguarded `remove_issue_worktree 1` would aim at, and
// the folder task's own tree, whose teardown is a separate slice (#223). Both are asserted,
// so #223 cannot land silently and a regression in the guard cannot hide behind it.

describe('folder mode performs no teardown, even with worktrees sitting there (#220 QA, #221)', () => {
  function seedTask() {
    const dir = join(workdir, '.ralph', 'tasks', 'afk', 'todo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '001-first.md'), 'do the thing')
  }

  // Deliberately COMMITS NOTHING: this section is about teardown, and a worktree whose
  // HEAD is still the dev branch's own tip makes the loop's advance step a silent no-op,
  // so nothing here can be confused for a park or an advance. `$PROJECT_ROOT` is still
  // the MAIN root in the agent's environment (only the prompt's {{PROJECT_ROOT}} is
  // overridden), which is how the gitignored task lane is reachable from the worktree.
  function folderAgent() {
    writeStub(
      'claude',
      `#!/bin/bash
cat > "${sandboxFile('prompt-folder.txt')}"
pwd -P > "${sandboxFile('cwd-folder.txt')}"
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

  it('leaves an existing issue-1 worktree registered, on its branch, with its contents', () => {
    seedTask()
    folderAgent()
    // A worktree at exactly the path an unguarded `remove_issue_worktree 1` would name,
    // made the way the loop makes them so the fixture is not a fiction about one.
    execFileSync('node', [WORKTREE_CLI, 'create', root, 'issue-1', 'main'], {
      cwd: root,
      encoding: 'utf8',
    })
    writeFileSync(join(worktreeDir('issue-1'), 'precious.txt'), 'a human is reading this\n')

    const res = runLoop({ timeout: 40000, extraEnv: { TASK_SOURCE: 'folder' } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    // The task really was worked, in ITS OWN detached tree — so this is a folder run that
    // got all the way through its outcome handling, not one that bailed early.
    expect(readIf(sandboxFile('cwd-folder.txt')).trim()).toBe(worktreeDir('task-1'))

    // Nothing was removed, deregistered, or emptied.
    expect(readFileSync(join(worktreeDir('issue-1'), 'precious.txt'), 'utf8')).toBe(
      'a human is reading this\n',
    )
    // Sorted rather than in registration order: three entries now, and which of the two
    // children git lists first is not the claim. The main root sorts first either way —
    // it is a prefix of both — and `issue-1` before `task-1`.
    expect(registrations().sort()).toEqual([
      `worktree ${root}`,
      `worktree ${worktreeDir('issue-1')}`,
      `worktree ${worktreeDir('task-1')}`,
    ])
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreeDir('issue-1')).trim()).toBe('issue-1')
    // The folder task's own tree is detached, and it is still there: #223 owns removing it.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreeDir('task-1')).trim()).toBe('HEAD')
    // And no removal was even attempted, successfully or otherwise.
    expect(res.stderr).not.toMatch(/could not remove the worktree/)
    expect(res.stderr).not.toMatch(/worktree remove declined/)
    // The guard that owns the outcome above, pinned here rather than in a test of its
    // own: this run reached its outcome handling in a non-github mode with a worktree
    // sitting on disk, which is the only view from outside in which the guard is doing
    // anything, so the run and the line that explains it belong together.
    expect(readFileSync(RALPH_TEMPLATE, 'utf8')).toMatch(
      /\[ "\$TASK_SOURCE" = "github" \] \|\| return 0/,
    )
  })
})

// ---------------------------------------------------------------------------
// 7. Removals git or the filesystem makes hard
// ---------------------------------------------------------------------------
//
// The dev's suite covers ONE refusal: a mode-0500 directory INSIDE the tree. Every case
// below is a different one, and they do not all end the same way — which is the point,
// because the loop's new warning is only correct if it fires when a tree really was left
// behind and stays quiet when it was not. Each measurement is quoted at its test.

describe('the shapes a removal can take on the success path (#220 QA)', () => {
  beforeEach(() => {
    setIssue(98, { state: 'CLOSED' })
  })

  it('removes a tree with LOCAL MODIFICATIONS without refusing and without warning', () => {
    // #220's acceptance criterion names "git refuses to remove a worktree with local
    // modifications" as a case to handle. MEASURED (git 2.50.1, Apple Git-155): that is
    // true only of the UNFORCED spelling — `git worktree remove <path>` on a tree with a
    // modified tracked file exits 128 with `fatal: '<path>' contains modified or
    // untracked files, use --force to delete it` — and lib/worktree.js never uses it.
    // Its first spelling is `--force`, which exits 0 on that same tree and takes it. So
    // there is no refusal to warn about here, and this pins the real behaviour: the
    // uncommitted work is discarded in silence because the issue is finished.
    writeStub('claude', AGENT_LEAVES_MODIFICATIONS())
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(existsSync(worktreeDir('issue-98'))).toBe(false)
    expect(registrations()).toEqual([`worktree ${root}`])
    // No warning from either layer: the module's `declined` line or the loop's own.
    expect(res.stderr).not.toMatch(/worktree remove declined/)
    expect(res.stderr).not.toMatch(/could not remove the worktree/)
    expect(res.stderr).not.toMatch(/worktree\.js: remove failed/)
    // The agent really did modify a tracked file, and the MAIN root's copy is untouched
    // — so the removal above discarded work rather than nothing.
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('seed\n')
    expect(readFileSync(join(root, 'tracked-and-staged.txt'), 'utf8')).toBe('original\n')
  })

  it('removes a LOCKED tree by escalating, and says nothing about it', () => {
    // MEASURED (git 2.50.1, Apple Git-155) on a worktree lib/worktree.js created and
    // `git worktree lock` then held: `worktree remove --force <path>` exits 128 with
    // `fatal: cannot remove a locked working tree;` / `use 'remove -f -f' to override or
    // unlock first`, and `worktree remove --force --force <path>` exits 0 and takes the
    // directory AND the record. The escalation is unit-tested with doubles and exercised
    // on the CREATE path by loop.worktree.qa.test.js; this is it on the REMOVE path,
    // which is the path #220 moved.
    writeStub('claude', AGENT_LOCKS_ITS_TREE())
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(existsSync(worktreeDir('issue-98'))).toBe(false)
    expect(registrations()).toEqual([`worktree ${root}`])
    // git finished the job, so nothing was left for a human to act on and nothing was
    // said. A warning here would be the false alarm the `|| true`-versus-warn decision
    // is meant to avoid.
    expect(res.stderr).not.toMatch(/could not remove the worktree/)
    expect(res.stderr).not.toMatch(/worktree\.js: remove failed/)
    // Anti-vacuity: the lock really was taken, so `--force` really was refused once.
    expect(recorded('cwd-issue-98').trim()).toBe(worktreeDir('issue-98'))
  })

  it('is a silent success when the AGENT already deleted the tree', () => {
    // MEASURED (git 2.50.1, Apple Git-155) through the module CLI against a registered
    // worktree whose directory had been deleted: `node lib/worktree.js remove …` exits 0
    // with empty stderr and leaves only the main registration. The removal has nothing
    // to delete, so the module's fs sweep is skipped and its prune drops the record.
    writeStub('claude', AGENT_DELETES_ITS_TREE())
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(existsSync(worktreeDir('issue-98'))).toBe(false)
    // No ghost record for the next create to trip over…
    expect(registrations()).toEqual([`worktree ${root}`])
    // …and no warning, because nothing was left behind: the warning names a directory
    // still on disk, and there is none.
    expect(res.stderr).not.toMatch(/could not remove the worktree/)
  })

  it.runIf(NOT_ROOT)(
    'warns, keeps its verdict, and names the leftover when the PARENT directory is unwritable',
    () => {
      // A different jam from the dev's mode-0500 CHILD: here every file inside the tree is
      // deletable and what cannot go is the tree's own directory entry, since removing an
      // entry needs write permission on the directory holding it. MEASURED (git 2.50.1
      // Apple Git-155 / node v20.20.2) with `.ralph/worktrees` at mode 0500 and a worktree
      // registered inside it: `worktree remove --force <path>` DEREGISTERS the tree and
      // then fails `error: failed to delete '<path>': Permission denied` (255); `--force
      // --force` answers `fatal: '<path>' is not a working tree` (128); and the fs sweep
      // then fails with an EACCES the CLI prints as `worktree.js: remove failed (…)`
      // before exiting 1. Which SYSCALL that errno names is a per-platform detail — macOS
      // says `rmdir` here and `unlink` for the child case, the Linux CI runner names
      // neither — so the assertions below stop at the errno class, and
      // lib/worktree.remove.qa.test.js explains why with both observed strings.
      writeStub('claude', AGENT_JAMS_THE_PARENT())
      const parent = join(root, '.ralph', 'worktrees')
      try {
        const res = runLoop()
        expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()

        // The module said what it hit, and the loop said which directory is still there.
        expect(res.stderr).toMatch(/worktree\.js: remove failed/)
        expect(res.stderr).toMatch(/EACCES/)
        expect(res.stderr).toMatch(/could not remove the worktree for issue #98/)
        expect(res.stderr).toContain('.ralph/worktrees/issue-98')

        // TEARDOWN GETS NO VOTE ON THE VERDICT: the issue was resolved, so the iteration
        // is a success, the run reaches its own end, and the exit status is unchanged.
        expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
        expect(res.stdout).toContain('==> Cleanup')
        expect(res.status).toBe(0)

        // The warning is not a false alarm.
        expect(existsSync(worktreeDir('issue-98'))).toBe(true)
      } finally {
        if (existsSync(parent)) chmodSync(parent, 0o755)
      }
    },
  )
})

// ---------------------------------------------------------------------------
// 8. Where the warning goes
// ---------------------------------------------------------------------------
//
// The dev's jammed-removal test asserts the warning is IN stderr. Two things it does not
// ask: that it is not ALSO on stdout, and that it is not on stdout INSTEAD on a run whose
// streams are plumbed differently. Both matter because stdout is what a `tmux capture-pane`
// and the cycle log carry, and a warning duplicated into a machine-read stream is noise
// the digest has to filter — while a warning that only reaches stdout is one `2>/dev/null`
// away from silence.

describe('the leftover warning is a stderr line and only a stderr line (#220 QA)', () => {
  it.runIf(NOT_ROOT)('keeps the warning off stdout entirely', () => {
    writeStub('claude', AGENT_JAMS_THE_PARENT())
    const parent = join(root, '.ralph', 'worktrees')
    try {
      const res = runLoop()
      expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
      expect(res.stderr).toMatch(/could not remove the worktree for issue #98/)

      // Neither the loop's sentence nor the module's reaches stdout.
      expect(res.stdout).not.toMatch(/could not remove the worktree/)
      expect(res.stdout).not.toMatch(/worktree\.js: remove failed/)
      expect(res.stdout).not.toMatch(/worktree remove declined/)

      // The one line stdout DOES carry about this issue is the verdict, unchanged.
      expect(res.stdout).toMatch(/1 ok, 0 failed/)
    } finally {
      if (existsSync(parent)) chmodSync(parent, 0o755)
    }
  })

  it('names the worktree by its path, not just the issue, so a human can cd to it', () => {
    // The loop's sentence is the only place the path is spelled — the module prints an
    // absolute path, the loop a repo-relative one, and a reader needs at least one.
    const loop = readFileSync(RALPH_TEMPLATE, 'utf8')
    expect(loop).toContain(
      'could not remove the worktree for issue #$1 — leaving .ralph/worktrees/issue-$1 in place.',
    )
    // On stderr, by the redirection on that same line.
    const warnLine = loop.split('\n').find((l) => l.includes('could not remove the worktree'))
    expect(warnLine).toMatch(/>&2\s*$/)
  })
})

// ---------------------------------------------------------------------------
// 9. The transcript, on the path that now keeps its tree
// ---------------------------------------------------------------------------
//
// The LOG_DIR comment's argument is that a relative `logs/…` would resolve INSIDE the
// worktree and be deleted with it, so every log path is anchored to $PROJECT_ROOT. #218's
// tests check that on the success path, where the tree is gone and the only thing left to
// look at is the main root. On a KEEP the tree survives, which makes the stronger
// assertion possible for the first time: the surviving tree can be searched, and it holds
// no transcript at all.

describe('the transcripts are anchored to the main root on the KEEP path too (#220 QA)', () => {
  it('writes them to the main root and nothing log-shaped into the kept tree', () => {
    writeStub('claude', AGENT_FAILS())
    setIssue(98, { state: 'OPEN' })
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/0 ok, 1 failed/)
    expect(existsSync(worktreeDir('issue-98'))).toBe(true)

    // Both halves of the transcript are in the main root, with the agent's own words in
    // them — so the keep is additive to the record, not a substitute for it.
    expect(readIf(join(root, 'logs', 'ralph-issue-98.log'))).toContain('agent exploded')
    expect(readIf(join(root, 'logs', 'ralph-issue-98.jsonl'))).toContain('"type":"result"')
    // And the kept tree — which is now inspectable, unlike on the success path — holds no
    // logs/ directory and no transcript that a future teardown would take with it.
    expect(existsSync(join(worktreeDir('issue-98'), 'logs'))).toBe(false)
    expect(readdirSync(worktreeDir('issue-98')).filter((e) => e.startsWith('ralph-issue-'))).toEqual(
      [],
    )
  })
})
