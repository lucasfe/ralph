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

// #218 — a GitHub-mode issue is resolved in its own git worktree, so the loop
// never moves the user's HEAD.
//
// WHY THIS ONE USES REAL GIT, unlike every other loop*.test.js
// The whole claim of #218 is a property of a git repository: after a run, the main
// working tree is still on the branch it started on, its uncommitted edit is still
// there, and the agent's commit is reachable from `issue-N`. A `git` stub that
// `exit 0`s — which is what test/loop.test.js installs — can assert none of that:
// it would pass just as happily against the `git checkout dev` this slice deletes.
// So `git` is deliberately NOT stubbed here and the fixture is a real repository
// with a real bare `origin` beside it, both under the OS temp dir. `gh`, `jq`,
// `claude`, `tmux` and `curl` are still stubs, and `node` delegates the modules
// whose behaviour is under test to the real binary.
//
// THE AGENT STUB COMMITS FOR REAL. That is the only way the "reachable from
// issue-N" assertion means anything: a stub that wrote a file without committing
// would leave nothing to be reachable, and one that committed in the MAIN tree
// would be testing the bug.
//
// #219 — and the tree the agent wakes in is SEEDED. The last describe drives the same
// fixture with a gitignored `.env.local` and a `node_modules/` in the main root, and
// asks the agent stub what it found: real git is what makes those two absent from a
// fresh checkout in the first place, so the seed step has nothing to prove against a
// stub either.
//
// HERMETIC: nothing here touches this repository. The worktrees created live under
// the fixture's own `.ralph/worktrees/`, and afterEach removes the whole sandbox.

const RALPH_TEMPLATE = templatePath('ralph.sh')
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

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

// Real git, always run against the fixture's MAIN working tree.
function git(args, cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function runLoop({ timeout = 90000, extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-worktree-test',
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
    // The fixture's only branch, and the base every worktree is cut from. Passed on
    // the CHILD env rather than assigned here: test/setup/hermetic-env.js deletes
    // DEV_BRANCH from the worker (it is declared in templates/ralph.config.sh), and
    // the fixture writes no ralph.config.sh of its own — that file existing is what
    // would drag the whole lazy-validation block into this test.
    DEV_BRANCH: 'main',
    ...extraEnv,
  }
  return spawnSync('bash', [RALPH_TEMPLATE], { cwd: workdir, env, timeout, encoding: 'utf8' })
}

const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const worktreeDir = (handle = 'issue-98') => join(root, '.ralph', 'worktrees', handle)

// One line per registered worktree — how "git kept no stale record" is asked of a real
// repository, and the same instrument the removal test below uses in reverse to say the
// kept tree is a live worktree rather than an orphaned directory.
const registrations = () =>
  git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))

// --- gh: one issue (#98) ------------------------------------------------------
// `state` and `labels` are what the loop CLASSIFIES the iteration from, and since #220
// the classification is also what decides teardown — so they are the knob every outcome
// test below turns. `drain` is what empties the queue after the first selection; only
// the zero-progress test turns it off, because that guard cannot fire until the SAME
// issue has been handed out twice. Every invocation is logged, so a test can assert the
// loop's own label edits rather than infer them from its stdout.
function writeGh({ state = 'CLOSED', labels = '', drain = true } = {}) {
  writeStub(
    'gh',
    `#!/bin/bash
echo "$*" >> "${join(sandbox, 'gh-calls.log')}"
CNT_FILE="${join(sandbox, 'count.txt')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  case "$*" in
    *sort:created-asc*) echo "98"; ${drain ? 'echo "0" > "$CNT_FILE"' : ':'} ;;
    *) cat "$CNT_FILE" ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "${labels}" ;;
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
  sandbox = mkdtempSync(join(tmpdir(), 'ralph-worktree-'))
  originDir = join(sandbox, 'origin.git')
  workdir = join(sandbox, 'work')
  bindir = join(sandbox, 'bin')
  mkdirSync(bindir, { recursive: true })

  // --- The fixture repository: a bare `origin` and a clone-shaped working tree ---
  execFileSync('git', ['init', '--bare', '--initial-branch=main', originDir])
  mkdirSync(workdir, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: workdir })
  // Identity + no signing, on the REPOSITORY config: a worktree shares
  // $GIT_DIR/config, so this is also what lets the agent stub commit inside one.
  execFileSync('git', ['config', 'user.email', 'ralph@example.test'], { cwd: workdir })
  execFileSync('git', ['config', 'user.name', 'Ralph Test'], { cwd: workdir })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: workdir })
  // The same two entries this repo's own .gitignore carries, so the worktrees the
  // loop creates under .ralph/ and the transcripts under logs/ do not show up as
  // untracked content in the `git status` assertions below — plus `.env.local`, the
  // #219 subject: a fresh worktree holds only TRACKED files, so a gitignored one has
  // to be seeded into it or the project's tests cannot run there. MEASURED on git
  // 2.50.1 (Apple Git-155): `git worktree add` into a repo whose .gitignore lists
  // `.env.local` and `node_modules/` produces a directory holding `.git`, `.gitignore`
  // and `README.md` and neither of those two.
  writeFileSync(join(workdir, '.gitignore'), '.ralph/\nlogs/\n.env.local\nnode_modules/\n')
  writeFileSync(join(workdir, 'README.md'), 'seed\n')
  execFileSync('git', ['add', '.'], { cwd: workdir })
  execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: workdir })
  execFileSync('git', ['remote', 'add', 'origin', originDir], { cwd: workdir })
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: workdir })

  // git resolves symlinks in `rev-parse --show-toplevel`, and on macOS the temp dir
  // is one (/var → /private/var). PROJECT_ROOT inside the loop is therefore the
  // REAL path, so every assertion has to be made against that spelling.
  root = realpathSync(workdir)

  mkdirSync(join(workdir, 'logs'), { recursive: true })
  mkdirSync(join(workdir, '.ralph'), { recursive: true })
  writeFileSync(join(workdir, '.ralph', 'state.json'), '{}')

  // THE USER'S UNCOMMITTED WORK: a modification to a TRACKED file, which is the
  // thing `git checkout dev` in the old Cleanup block put at risk. An untracked
  // file would survive a branch switch and prove much less.
  writeFileSync(join(workdir, 'README.md'), 'seed\nlocal edit not committed\n')

  // THE GITIGNORED CONFIG A PROJECT'S TESTS NEED (#219). Written after the commit on
  // purpose: it is ignored, so it is in no tree and no `git worktree add` can produce
  // it. The default seed list is what puts it in the worktree.
  writeFileSync(join(workdir, '.env.local'), 'ANTHROPIC_API_KEY=sk-local\n')
  // …and the one gitignored directory that is deliberately NOT seeded, so the
  // assertion that the worktree has none of it is not vacuous.
  mkdirSync(join(workdir, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(workdir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')

  writeFileSync(join(sandbox, 'count.txt'), '1')

  // --- node: real for the modules under test, a dummy prompt for nothing --------
  // build-prompt.js runs FOR REAL here, because "the rendered prompt's
  // PROJECT_ROOT is the worktree" is one of the properties this file checks and a
  // stub that echoes "PROMPT" renders no placeholder at all.
  writeStub(
    'node',
    `#!/bin/bash
exec "${REAL_NODE}" "$@"
`,
  )

  // --- claude: the agent, stubbed to do real work in whatever tree it wakes in --
  writeStub(
    'claude',
    `#!/bin/bash
cat > "${join(sandbox, 'prompt.txt')}"
pwd -P > "${join(sandbox, 'agent-cwd.txt')}"
git rev-parse --abbrev-ref HEAD > "${join(sandbox, 'agent-branch.txt')}"
ls -a > "${join(sandbox, 'agent-ls.txt')}"
# #219: what the seed step left in the tree this invocation woke in. The append is
# the write-through probe — a symlinked seed would put it in the MAIN root's file,
# and the tree itself is deleted before the assertions can look at it.
if [ -e .env.local ]; then
  cp .env.local "${join(sandbox, 'agent-env-local.txt')}"
  if [ -L .env.local ]; then echo yes > "${join(sandbox, 'agent-env-local-link.txt')}"
  else echo no > "${join(sandbox, 'agent-env-local-link.txt')}"; fi
  printf 'AGENT_WROTE=1\\n' >> .env.local
fi
echo "hello from the agent" > agent-file.txt
git add agent-file.txt
git commit -q -m "feat(issue-98): agent work"
echo '{"type":"result","subtype":"success"}'
exit 0
`,
  )

  // --- jq: pass the stream through so the transcript has content ---------------
  writeStub(
    'jq',
    `#!/bin/bash
for a in "$@"; do
  case "$a" in
    *".type == \\"assistant\\""*|*".type"*)
      while IFS= read -r line; do printf '%s\\n' "$line"; done
      exit 0
      ;;
  esac
done
cat > /dev/null 2>/dev/null || true
exit 0
`,
  )

  // --- gh: one issue (#98), reported CLOSED afterwards (a success) -------------
  writeGh()

  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
})

afterEach(() => {
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
})

describe('ralph.sh github arm — the issue is resolved in a worktree (#218)', () => {
  it('leaves the main tree on its own branch with its uncommitted edit, and the commit on issue-N', () => {
    const res = runLoop()
    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toContain('==> Cleanup')

    // THE BUG THIS PRD EXISTS TO FIX: the user's HEAD never moved.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')

    // …and their uncommitted edit is byte-identical and still uncommitted.
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('seed\nlocal edit not committed\n')
    expect(git(['status', '--porcelain'])).toContain('README.md')

    // The agent's commit is reachable from issue-98, with its file in it.
    expect(git(['rev-parse', '--verify', 'issue-98']).trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
    expect(git(['cat-file', '-p', 'issue-98:agent-file.txt'])).toContain('hello from the agent')
    // issue-98 was cut from origin/main, so the seed commit is its parent.
    expect(git(['merge-base', '--is-ancestor', 'origin/main', 'issue-98'])).toBe('')

    // The main tree never saw the agent's file.
    expect(existsSync(join(root, 'agent-file.txt'))).toBe(false)
  })

  it('spawns the agent with cwd set to the worktree, already on issue-N', () => {
    runLoop()
    const expected = join(root, '.ralph', 'worktrees', 'issue-98')
    expect(readIf(join(sandbox, 'agent-cwd.txt')).trim()).toBe(expected)
    expect(readIf(join(sandbox, 'agent-branch.txt')).trim()).toBe('issue-98')
  })

  it("renders the prompt's PROJECT_ROOT as the worktree, not the main root", () => {
    runLoop()
    const prompt = readIf(join(sandbox, 'prompt.txt'))
    const worktree = join(root, '.ralph', 'worktrees', 'issue-98')
    expect(prompt).toContain(`Your project root is \`${worktree}\``)
    // The agent is told to stay inside the tree it is actually in, which is the
    // whole point of overriding the placeholder rather than the loop's own cwd.
    expect(prompt).not.toContain(`Your project root is \`${root}\``)
  })

  it('removes the worktree at the end of the iteration and leaves git with no stale registration', () => {
    runLoop()
    expect(existsSync(join(root, '.ralph', 'worktrees', 'issue-98'))).toBe(false)
    // `git worktree list` prints one line per registered worktree; only the main
    // one may remain.
    const list = git(['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
    expect(list).toEqual([`worktree ${root}`])
  })

  it('keeps the per-issue transcript in the MAIN root, so removing the worktree cannot take it', () => {
    runLoop()
    const log = join(root, 'logs', 'ralph-issue-98.log')
    const jsonl = join(root, 'logs', 'ralph-issue-98.jsonl')
    expect(existsSync(log)).toBe(true)
    expect(existsSync(jsonl)).toBe(true)
    expect(readFileSync(jsonl, 'utf8')).toContain('"type":"result"')
    // Nothing was written into a logs/ directory inside the worktree.
    expect(existsSync(join(root, '.ralph', 'worktrees'))).toBe(true)
    expect(existsSync(join(root, '.ralph', 'worktrees', 'issue-98', 'logs'))).toBe(false)
  })

  it('re-runs cleanly over a leftover worktree from a crashed run', () => {
    // Simulate the crash: a populated directory at the path, never registered.
    const stale = join(workdir, '.ralph', 'worktrees', 'issue-98')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'stale.txt'), 'from a run that died')

    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
    expect(existsSync(stale)).toBe(false)
  })

  it('does not prune the issue branch that has not landed on the base', () => {
    // The Cleanup block prunes MERGED issue-* branches; issue-98 carries a commit
    // origin/main does not have, so it must survive — otherwise the assertion
    // above about reachability would be testing a branch the loop had deleted.
    runLoop()
    expect(git(['branch', '--list', 'issue-98']).trim()).toContain('issue-98')
  })
})

describe('ralph.sh github arm — the worktree is seeded with the gitignored files (#219)', () => {
  const ENV_LOCAL = 'ANTHROPIC_API_KEY=sk-local\n'

  it('gives the agent the gitignored .env.local the main root has', () => {
    const res = runLoop()
    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    // The agent read this out of its own cwd, which the test above pins to the
    // worktree — so the file was in the tree `git worktree add` had just made.
    expect(readIf(join(sandbox, 'agent-env-local.txt'))).toBe(ENV_LOCAL)
  })

  it('seeds a COPY: the agent writing to it cannot reach the main root', () => {
    runLoop()
    expect(readIf(join(sandbox, 'agent-env-local-link.txt')).trim()).toBe('no')
    // The agent appended a line to its own copy. The user's file is byte-identical.
    expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe(ENV_LOCAL)
  })

  it('seeds nothing when the knob is blank, and the run still completes', () => {
    // Passed on the CHILD env for the reason runLoop's comment gives: the knob is
    // RALPH_*, so test/setup/hermetic-env.js deletes it from the worker by prefix.
    const res = runLoop({ extraEnv: { RALPH_WORKTREE_SEED_FILES: '' } })
    expect(res.signal).toBeNull()
    expect(existsSync(join(sandbox, 'agent-env-local.txt'))).toBe(false)
    // Anti-vacuity: the agent ran and did its work, it just had no .env.local.
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
  })

  it('seeds only what the knob names', () => {
    const res = runLoop({ extraEnv: { RALPH_WORKTREE_SEED_FILES: '.mcp.json' } })
    expect(res.signal).toBeNull()
    // .mcp.json does not exist in this fixture — an absent entry is a no-op — and
    // .env.local is no longer on the list, so nothing was seeded.
    expect(existsSync(join(sandbox, 'agent-env-local.txt'))).toBe(false)
  })

  it('does not seed node_modules — the agent installs in the worktree instead', () => {
    const res = runLoop({ extraEnv: { INSTALL_CMD: 'npm ci' } })
    expect(res.signal).toBeNull()
    const entries = readIf(join(sandbox, 'agent-ls.txt')).trim().split('\n')
    expect(entries).toContain('.env.local')
    expect(entries).not.toContain('node_modules')
    // …while the MAIN root has one, so the negative above is about the worktree and
    // not about a fixture that never had the directory.
    expect(existsSync(join(root, 'node_modules', 'left-pad', 'index.js'))).toBe(true)
    // And the per-issue install is what pays for it: step 0 of the prompt, run in the
    // cwd the test above pins to the worktree.
    expect(readIf(join(sandbox, 'prompt.txt'))).toContain('run `npm ci`')
  })
})

// #220 — teardown follows the OUTCOME: a terminal success takes the worktree with it, a
// failure leaves it standing.
//
// Real git for the same reason the rest of this file uses it, and one more: "the tree is
// still there and it is still a registered worktree on issue-98" is a question only a
// repository can answer, and the whole value of the keep is that a human can `cd` into
// it and read a diff. A stub that `exit 0`s to `worktree remove` would agree with any
// rule at all, including the unconditional one this slice replaces.
//
// EVERY KEEP STUB LEAVES SOMETHING UNCOMMITTED, deliberately. The commits are on the
// `issue-98` branch either way — teardown never touched those — so a tree whose contents
// were all committed would make the keep indistinguishable from the removal that
// preceded it. The uncommitted file IS the thing #218's unconditional teardown destroyed:
// the transcript records what the agent said, the tree records what it did to the code.

// Exits non-zero after writing something it never committed — a run killed by a rate
// limit or a crashed tool.
const AGENT_FAILS = () => `#!/bin/bash
cat > "${join(sandbox, 'prompt.txt')}"
pwd -P > "${join(sandbox, 'agent-cwd.txt')}"
echo "half-finished" > scratch-from-agent.txt
echo '{"type":"result","subtype":"error"}'
echo "agent exploded" >&2
exit 7
`

// Exits ZERO having changed no exclusion state, which is the spin the zero-progress
// guard exists to stop — and, with a `failed` label already on the issue, the way to ask
// for the label branch without an exit code that could explain the keep on its own.
const AGENT_CHANGES_NO_STATE = () => `#!/bin/bash
cat > "${join(sandbox, 'prompt.txt')}"
pwd -P > "${join(sandbox, 'agent-cwd.txt')}"
echo "half-finished" > scratch-from-agent.txt
echo '{"type":"result","subtype":"success"}'
exit 0
`

describe('ralph.sh github arm — teardown follows the outcome (#220)', () => {
  const leftBehind = () => readIf(join(worktreeDir(), 'scratch-from-agent.txt'))

  it('removes the worktree when the agent left `pending-merge` on an issue still OPEN', () => {
    // The other half of the terminal-success branch: `CLOSED` is covered above, and this
    // is the label a ralph agent leaves when the PR is up and merging. Both must remove.
    writeGh({ state: 'OPEN', labels: 'pending-merge' })
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/1 ok, 0 failed/)
    expect(existsSync(worktreeDir())).toBe(false)
    expect(registrations()).toEqual([`worktree ${root}`])
    // Anti-vacuity: the iteration really ran and its commits survived the removal.
    expect(git(['log', '--format=%s', 'issue-98'])).toContain('feat(issue-98): agent work')
  })

  it('KEEPS the worktree when the agent left the issue `failed`', () => {
    // The label is doing the work here, not the exit code: this agent exits 0.
    writeStub('claude', AGENT_CHANGES_NO_STATE())
    writeGh({ state: 'OPEN', labels: 'failed' })
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stdout, `stderr:\n${res.stderr}`).toMatch(/0 ok, 1 failed/)

    // The tree is there, and what the agent never committed is in it — which is the
    // whole point of keeping it.
    expect(existsSync(worktreeDir())).toBe(true)
    expect(leftBehind()).toBe('half-finished\n')
    // …and it is a LIVE worktree, not an orphaned directory: git still lists it, and it
    // is still on the branch whose diff a human would read.
    expect(registrations()).toHaveLength(2)
    expect(registrations()).toContain(`worktree ${worktreeDir()}`)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreeDir()).trim()).toBe('issue-98')
  })

  it('KEEPS the worktree when the agent exits non-zero, and still marks the issue failed', () => {
    writeStub('claude', AGENT_FAILS())
    writeGh({ state: 'OPEN' })
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    // The classification is unchanged by #220: the loop still labels the issue itself so
    // the queue advances, and still counts the iteration a failure.
    expect(res.stderr).toMatch(/failed on issue #98 \(non-zero exit\)/)
    expect(readIf(join(sandbox, 'gh-calls.log'))).toContain('issue edit 98 --add-label failed')
    expect(res.stdout).toMatch(/0 ok, 1 failed/)

    expect(existsSync(worktreeDir())).toBe(true)
    expect(leftBehind()).toBe('half-finished\n')
    // The user's own checkout still never saw it, which is #218's promise unchanged.
    expect(existsSync(join(root, 'scratch-from-agent.txt'))).toBe(false)
  })

  it('KEEPS the worktree when the zero-progress guard aborts the run', () => {
    // `drain: false` leaves the queue non-empty, so #98 is handed out a second time, and
    // this agent changes no state either time — the exact spin the guard breaks on.
    writeStub('claude', AGENT_CHANGES_NO_STATE())
    writeGh({ state: 'OPEN', drain: false })
    const res = runLoop()

    expect(res.signal, `loop was killed by timeout. stdout:\n${res.stdout}`).toBeNull()
    expect(res.stderr).toMatch(/no progress on issue #98 \(re-selected without state change\)/)
    expect(res.stdout).toContain('==> Cleanup')
    expect(res.stdout).toMatch(/0 ok, 2 failed/)

    // The `break` leaves the second iteration's tree exactly where it was — the abort is
    // the case a human is MOST likely to want to look at, since the loop stopped on it.
    expect(existsSync(worktreeDir())).toBe(true)
    expect(leftBehind()).toBe('half-finished\n')
  })
})

describe('the loop and the two GitHub prompts hold no branch-switching of their own (#218)', () => {
  const loop = readFileSync(RALPH_TEMPLATE, 'utf8')
  const claudePrompt = readFileSync(templatePath('prompt-team.md'), 'utf8')
  const codexPrompt = readFileSync(templatePath('prompt-team-codex.md'), 'utf8')

  // OVER THE EXECUTABLE LINES ONLY. Whole-line `#` comments are stripped first,
  // because the block that explains why worktree handling lives in lib/worktree.js
  // necessarily writes the words `git worktree`, and the Cleanup block names the
  // `git checkout dev` it replaced — a guard that could not tell a command from prose
  // about a command would forbid the explanation. MEASURED: neither phrase appears in
  // a trailing (same-line) comment in this file, so full-line stripping is exact.
  const loopCode = loop
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

  it('templates/ralph.sh invokes `git worktree` nowhere — it shells out to lib/worktree.js', () => {
    expect(loopCode).not.toMatch(/git\s+worktree/)
    // Anti-vacuity: the knowledge did not simply vanish, it moved to the module.
    expect(loopCode).toMatch(/lib\/worktree\.js" create /)
    expect(loopCode).toMatch(/lib\/worktree\.js" remove /)
    // #220: teardown is outcome-aware now, and it is still spelled EXACTLY ONCE — in the
    // helper the classification drives, rather than copied into each terminal-success
    // branch. A copy is what lets one call site be fixed while the other keeps the bug,
    // and it is also what would make the `|| true`-versus-warn decision divergeable.
    expect(loopCode.match(/lib\/worktree\.js" remove /g)).toHaveLength(1)
    expect(loopCode).toMatch(/remove_issue_worktree "\$num"/)
  })

  it('templates/ralph.sh never checks out a branch, so a run cannot move the HEAD of the main tree', () => {
    expect(loopCode).not.toMatch(/git\s+checkout/)
    // The end-of-run pruning survived the deletion, and does its work without
    // requiring the dev branch to be the checked-out one.
    expect(loopCode).toMatch(/git branch --merged "origin\/\$\{DEV_BRANCH:-main\}"/)
    expect(loopCode).not.toMatch(/git\s+pull/)
  })

  it.each([
    ['prompt-team.md', () => claudePrompt],
    ['prompt-team-codex.md', () => codexPrompt],
  ])('%s carries no "Prepare branch" step and no `git checkout -b`', (_name, get) => {
    const md = get()
    expect(md).not.toContain('Prepare branch')
    expect(md).not.toContain('git checkout -b')
    // Anchored: the file was read and is the orchestrator, so the two negatives
    // above are not vacuous.
    expect(md).toContain('## Required sequence')
  })

  it.each([
    ['prompt-team.md', () => claudePrompt],
    ['prompt-team-codex.md', () => codexPrompt],
  ])('%s tells the agent it already woke on issue-N', (_name, get) => {
    // Whitespace-tolerant: the sentence wraps mid-phrase in both templates, and the
    // claim is the words, not the line break.
    expect(get()).toMatch(/already on\s+`issue-N`/)
  })

  it.each([
    ['prompt-team.md', () => claudePrompt],
    ['prompt-team-codex.md', () => codexPrompt],
  ])('%s promises the agent the teardown the loop actually performs (#220)', (_name, get) => {
    const md = get()
    // Both templates used to tell the agent its tree "is removed after this invocation
    // returns" — flatly false since #220, and false in the one direction that matters:
    // an agent that believes the tree is doomed either way has no reason to leave the
    // evidence of a failure behind in it. The old sentence is pinned as an ABSENCE so a
    // future edit cannot quietly reintroduce the promise.
    expect(md).not.toContain('removed after this invocation returns')
    expect(md).toMatch(/removed once this issue is finished/)
    expect(md).toMatch(/kept for a human to inspect/)
    // And the half that did NOT change: whichever way teardown goes, the commits are on
    // the branch, which is what the PR in step 7 is opened from. Without this the two
    // clauses above could be read as "a failed run's work is only in the directory".
    expect(md).toMatch(/the branch and its commits survive/)
  })
})
