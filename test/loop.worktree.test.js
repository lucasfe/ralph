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
  // untracked content in the `git status` assertions below.
  writeFileSync(join(workdir, '.gitignore'), '.ralph/\nlogs/\n')
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
  writeStub(
    'gh',
    `#!/bin/bash
CNT_FILE="${join(sandbox, 'count.txt')}"
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
    *state*)  echo "CLOSED" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ]; then echo "[]"; exit 0; fi
exit 0
`,
  )

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
})
