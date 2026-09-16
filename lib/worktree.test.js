import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { spawnSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  advanceOrPark,
  createDetachedWorktree,
  createWorktree,
  removeWorktree,
  worktreePath,
  worktreesRoot,
} from './worktree.js'

const HOME = '/home/dev'
const ROOT = '/repo'

// A recording `git` double: answers every invocation with the scripted result for
// the FIRST word pair it matches, records every argv it was handed, and defaults
// to success. The default matters — most of createWorktree's calls are
// best-effort, so a double that failed by default would test the warning paths
// instead of the happy one.
function fakeGit(script = {}) {
  const calls = []
  const git = (args, opts = {}) => {
    calls.push({ args, cwd: opts.cwd })
    for (const [prefix, result] of Object.entries(script)) {
      if (args.join(' ').startsWith(prefix)) return { status: 0, stdout: '', stderr: '', ...result }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  git.calls = calls
  // Every argv joined, so a test can assert "this command ran" without indexing.
  git.lines = () => calls.map((c) => c.args.join(' '))
  return git
}

function makeStderr() {
  const calls = []
  return { write: (m) => calls.push(m), calls }
}

describe('worktree paths (#218)', () => {
  it('derives <mainRoot>/.ralph/worktrees/<handle>', () => {
    expect(worktreePath(ROOT, 'issue-7', { home: HOME })).toBe('/repo/.ralph/worktrees/issue-7')
    expect(worktreesRoot(ROOT, { home: HOME })).toBe('/repo/.ralph/worktrees')
  })

  it('tolerates a trailing slash on the main root', () => {
    expect(worktreePath('/repo/', 'issue-7', { home: HOME })).toBe('/repo/.ralph/worktrees/issue-7')
  })

  // The refusal guard mirrors templates/ralph.sh's PROJECT_ROOT refusal (the `[ -z
  // "$PROJECT_ROOT" ] || [ "$PROJECT_ROOT" = "/" ] || [ "$PROJECT_ROOT" = "$HOME" ]`
  // test), because this module is handed that same value and then hands the result
  // to `git worktree remove --force` / `rmSync -r`.
  describe('refusals', () => {
    it.each([
      ['an empty main root', ''],
      ['a null main root', null],
      ['the filesystem root', '/'],
      ['the filesystem root with a trailing slash', '//'],
      ["the user's home directory", HOME],
      ["the user's home directory with a trailing slash", `${HOME}/`],
      ['a relative main root', 'repo'],
    ])('refuses %s', (_label, root) => {
      expect(() => worktreePath(root, 'issue-7', { home: HOME })).toThrow(/refusing/i)
    })

    it('names the offending root in the refusal, so a run says what it refused', () => {
      expect(() => worktreePath(HOME, 'issue-7', { home: HOME })).toThrow(HOME)
    })

    it.each([
      ['an empty handle', ''],
      ['a null handle', null],
      ['a handle with a path separator', 'issue/7'],
      ['a parent-directory handle', '..'],
      ['a handle that starts with a dot', '.git'],
      ['a handle that starts with a dash (a git flag)', '-f'],
      ['a handle with a space', 'issue 7'],
      ['a handle with a shell metacharacter', 'issue-7;rm'],
    ])('refuses %s', (_label, handle) => {
      expect(() => worktreePath(ROOT, handle, { home: HOME })).toThrow(/refusing/i)
    })

    it('refuses a main root inside a .git directory', () => {
      // The one way a `.git` segment can reach the derived path: a caller that
      // passed git's own metadata directory (or a submodule's) as the main root.
      expect(() => worktreePath('/repo/.git', 'issue-7', { home: HOME })).toThrow(/\.git/)
      expect(() => worktreePath('/repo/.git/modules/sub', 'issue-7', { home: HOME })).toThrow(
        /\.git/,
      )
    })
  })
})

describe('createWorktree (#218)', () => {
  function setup() {
    return Volume.fromJSON({ '/repo/.git/HEAD': 'ref: refs/heads/main\n' })
  }

  it('returns the derived path and adds the worktree on a new branch off origin/<base>', () => {
    const git = fakeGit()
    const path = createWorktree(ROOT, 'issue-7', 'dev', {
      fs: setup(),
      git,
      home: HOME,
      stderr: makeStderr(),
    })
    expect(path).toBe('/repo/.ralph/worktrees/issue-7')
    expect(git.lines()).toContain('worktree add -B issue-7 /repo/.ralph/worktrees/issue-7 origin/dev')
  })

  it('fetches the base branch from origin before resolving it', () => {
    const git = fakeGit()
    createWorktree(ROOT, 'issue-7', 'dev', {
      fs: setup(),
      git,
      home: HOME,
      stderr: makeStderr(),
    })
    const lines = git.lines()
    expect(lines).toContain('fetch origin dev')
    expect(lines.indexOf('fetch origin dev')).toBeLessThan(
      lines.findIndex((l) => l.startsWith('worktree add')),
    )
  })

  it('runs every git command in the MAIN repo root', () => {
    const git = fakeGit()
    createWorktree(ROOT, 'issue-7', 'dev', {
      fs: setup(),
      git,
      home: HOME,
      stderr: makeStderr(),
    })
    for (const call of git.calls) expect(call.cwd).toBe(ROOT)
  })

  it('creates the worktrees parent directory', () => {
    const vol = setup()
    createWorktree(ROOT, 'issue-7', 'dev', {
      fs: vol,
      git: fakeGit(),
      home: HOME,
      stderr: makeStderr(),
    })
    expect(vol.existsSync('/repo/.ralph/worktrees')).toBe(true)
  })

  it('carries on when the fetch fails, warning once, and still adds the worktree', () => {
    // An offline run must still get a worktree off the last-known origin ref.
    const git = fakeGit({ fetch: { status: 128, stderr: 'could not resolve host\n' } })
    const stderr = makeStderr()
    const path = createWorktree(ROOT, 'issue-7', 'dev', {
      fs: setup(),
      git,
      home: HOME,
      stderr,
    })
    expect(path).toBe('/repo/.ralph/worktrees/issue-7')
    expect(stderr.calls.join('')).toMatch(/fetch/i)
    expect(git.lines()).toContain('worktree add -B issue-7 /repo/.ralph/worktrees/issue-7 origin/dev')
  })

  it('falls back to the LOCAL base branch when origin/<base> does not exist', () => {
    const git = fakeGit({
      'rev-parse --verify --quiet origin/dev': { status: 1 },
    })
    const stderr = makeStderr()
    createWorktree(ROOT, 'issue-7', 'dev', { fs: setup(), git, home: HOME, stderr })
    expect(git.lines()).toContain('worktree add -B issue-7 /repo/.ralph/worktrees/issue-7 dev')
    expect(stderr.calls.join('')).toMatch(/origin\/dev/)
  })

  it('throws when neither origin/<base> nor <base> can be resolved', () => {
    const git = fakeGit({ 'rev-parse': { status: 1 } })
    expect(() =>
      createWorktree(ROOT, 'issue-7', 'dev', {
        fs: setup(),
        git,
        home: HOME,
        stderr: makeStderr(),
      }),
    ).toThrow(/dev/)
  })

  it('throws when `git worktree add` fails, quoting git', () => {
    const git = fakeGit({
      'worktree add': { status: 128, stderr: "fatal: 'issue-7' is already checked out\n" },
    })
    expect(() =>
      createWorktree(ROOT, 'issue-7', 'dev', {
        fs: setup(),
        git,
        home: HOME,
        stderr: makeStderr(),
      }),
    ).toThrow(/already checked out/)
  })

  it('refuses an empty base branch rather than guessing one', () => {
    expect(() =>
      createWorktree(ROOT, 'issue-7', '', {
        fs: setup(),
        git: fakeGit(),
        home: HOME,
        stderr: makeStderr(),
      }),
    ).toThrow(/refusing/i)
  })

  it('refuses an unsafe main root before it spawns any git at all', () => {
    const git = fakeGit()
    expect(() =>
      createWorktree(HOME, 'issue-7', 'dev', {
        fs: setup(),
        git,
        home: HOME,
        stderr: makeStderr(),
      }),
    ).toThrow(/refusing/i)
    expect(git.calls).toHaveLength(0)
  })

  // --- The seed step (#219) --------------------------------------------------
  // The selection rules, the refusals and the copy itself belong to
  // lib/worktree-seed.js and are covered by lib/worktree-seed.test.js. What is asserted
  // here is the WIRING: the create path seeds at all, it does it after git has made the
  // tree, and it passes its own seams down.
  const SEEDED = '/repo/.ralph/worktrees/issue-7/.env.local'

  it('seeds the new worktree with the gitignored files the project needs', () => {
    const vol = Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.env.local': 'ANTHROPIC_API_KEY=sk-local\n',
    })
    createWorktree(ROOT, 'issue-7', 'dev', {
      fs: vol,
      git: fakeGit(),
      home: HOME,
      processEnv: {},
      stderr: makeStderr(),
    })
    expect(vol.readFileSync(SEEDED, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
  })

  it('seeds AFTER `git worktree add`, never before it', () => {
    // Order is the whole of it: git refuses to add into a non-empty directory, so a
    // seed that ran first would abort the create for every repo that has an
    // .env.local. Asserted by asking the question at the moment of the add.
    const vol = Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.env.local': 'ANTHROPIC_API_KEY=sk-local\n',
    })
    let seededAtAddTime = null
    const git = (args) => {
      if (args.join(' ').startsWith('worktree add')) seededAtAddTime = vol.existsSync(SEEDED)
      return { status: 0, stdout: '', stderr: '' }
    }
    createWorktree(ROOT, 'issue-7', 'dev', {
      fs: vol,
      git,
      home: HOME,
      processEnv: {},
      stderr: makeStderr(),
    })
    expect(seededAtAddTime).toBe(false)
    expect(vol.existsSync(SEEDED)).toBe(true)
  })

  it('seeds nothing when `git worktree add` failed', () => {
    const vol = Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.env.local': 'ANTHROPIC_API_KEY=sk-local\n',
    })
    const git = fakeGit({ 'worktree add': { status: 128, stderr: 'fatal: nope\n' } })
    expect(() =>
      createWorktree(ROOT, 'issue-7', 'dev', {
        fs: vol,
        git,
        home: HOME,
        processEnv: {},
        stderr: makeStderr(),
      }),
    ).toThrow(/nope/)
    expect(vol.existsSync(SEEDED)).toBe(false)
  })

  it('keeps the write-through guard on its OWN fs seam, with no double in the way', () => {
    // The seam, driven rather than read. The seed step's link guard needs `lstatSync` and
    // `unlinkSync`, this function's `fs` object is passed straight through, and an object
    // missing either one loses the guard on the LIVE path — where the destination link is
    // not hypothetical: `git worktree add` checks out a symlink the repository tracks into
    // exactly the path the seed step writes. So this test uses real fs, real paths, and no
    // `fs` override at all; the git double stands in for the checkout by planting the link
    // the way git would.
    const box = mkdtempSync(join(tmpdir(), 'ralph-worktree-seam-'))
    try {
      const root = join(box, 'repo')
      const tree = join(root, '.ralph', 'worktrees', 'issue-7')
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, '.env.local'), 'FROM-THE-MAIN-ROOT\n')
      writeFileSync(join(root, 'victim.txt'), 'THE USER FILE\n')
      const git = (args) => {
        if (args.join(' ').startsWith('worktree add')) {
          mkdirSync(tree, { recursive: true })
          symlinkSync(join('..', '..', '..', 'victim.txt'), join(tree, '.env.local'))
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      const stderr = makeStderr()
      expect(
        createWorktree(root, 'issue-7', 'dev', {
          git,
          home: HOME,
          processEnv: { RALPH_WORKTREE_SEED_FILES: '.env.local' },
          stderr,
        }),
      ).toBe(tree)
      expect(readFileSync(join(root, 'victim.txt'), 'utf8')).toBe('THE USER FILE\n')
      expect(lstatSync(join(tree, '.env.local')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(tree, '.env.local'), 'utf8')).toBe('FROM-THE-MAIN-ROOT\n')
      expect(stderr.calls.join('')).toMatch(/symlink/i)
    } finally {
      rmSync(box, { recursive: true, force: true })
    }
  })

  it('honours the seed knob off its injected environment bag', () => {
    const vol = Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.env.local': 'ANTHROPIC_API_KEY=sk-local\n',
    })
    createWorktree(ROOT, 'issue-7', 'dev', {
      fs: vol,
      git: fakeGit(),
      home: HOME,
      processEnv: { RALPH_WORKTREE_SEED_FILES: '' },
      stderr: makeStderr(),
    })
    expect(vol.existsSync(SEEDED)).toBe(false)
  })

  it('clears a leftover worktree at the same path before adding, so a stale run cannot deadlock the issue', () => {
    const vol = Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.ralph/worktrees/issue-7/stale.txt': 'from a crashed run',
    })
    const git = fakeGit()
    createWorktree(ROOT, 'issue-7', 'dev', { fs: vol, git, home: HOME, stderr: makeStderr() })
    const lines = git.lines()
    expect(lines).toContain('worktree remove --force /repo/.ralph/worktrees/issue-7')
    expect(lines.indexOf('worktree remove --force /repo/.ralph/worktrees/issue-7')).toBeLessThan(
      lines.findIndex((l) => l.startsWith('worktree add')),
    )
  })
})

describe('removeWorktree (#218)', () => {
  it('removes the worktree through git and reports success', () => {
    const vol = Volume.fromJSON({ '/repo/.git/HEAD': 'ref: refs/heads/main\n' })
    const git = fakeGit()
    expect(removeWorktree(ROOT, 'issue-7', { fs: vol, git, home: HOME, stderr: makeStderr() })).toBe(
      true,
    )
    expect(git.lines()).toContain('worktree remove --force /repo/.ralph/worktrees/issue-7')
    expect(git.lines()).toContain('worktree prune')
    for (const call of git.calls) expect(call.cwd).toBe(ROOT)
  })

  it('falls back to an fs remove when git leaves the directory behind', () => {
    const vol = Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.ralph/worktrees/issue-7/left.txt': 'git could not remove me',
    })
    // git says no (e.g. the directory was never registered as a worktree), so the
    // fs sweep is what has to clear it — otherwise the next run for this issue
    // finds a populated path.
    const git = fakeGit({ 'worktree remove': { status: 128, stderr: 'not a working tree\n' } })
    expect(removeWorktree(ROOT, 'issue-7', { fs: vol, git, home: HOME, stderr: makeStderr() })).toBe(
      true,
    )
    expect(vol.existsSync('/repo/.ralph/worktrees/issue-7')).toBe(false)
  })

  it('is a no-op success when there is nothing there', () => {
    const vol = Volume.fromJSON({ '/repo/.git/HEAD': 'ref: refs/heads/main\n' })
    expect(removeWorktree(ROOT, 'issue-7', { fs: vol, git: fakeGit(), home: HOME })).toBe(true)
  })

  // --- The locked-worktree escalation ---------------------------------------
  // MEASURED on git 2.50.1 (Apple Git-155): `git worktree remove --force <path>` on a
  // LOCKED worktree exits 128 with `fatal: cannot remove a locked working tree;` /
  // `use 'remove -f -f' to override or unlock first`, and `git worktree remove --force
  // --force <path>` on that same tree exits 0 and leaves only the main registration.
  //
  // Both doubles below reproduce git's SIDE EFFECT as well as its exit status — a
  // remove that succeeded really did delete the directory — because that is the only
  // way to state the point of the escalation: git finishes the job, so the recursive
  // `fs.rmSync` fallback never has to fire and there is nothing for a human to read on
  // stderr. An fs seam that ignored git would leave `existsSync` true and make the
  // sweep look mandatory.
  const WT = '/repo/.ralph/worktrees/issue-7'
  const LOCKED =
    "fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first\n"

  // removeWorktree touches exactly three fs methods, so the spy is exactly three
  // methods. (createWorktree's seam is wider since #219 — the seed step reads, copies,
  // and unlinks a symlink the checkout may have left where it is about to write — but
  // nothing in this describe goes near it.)
  function spyFs(vol) {
    const rmTargets = []
    return {
      rmTargets,
      fs: {
        existsSync: (p) => vol.existsSync(p),
        mkdirSync: (p, opts) => vol.mkdirSync(p, opts),
        rmSync: (p, opts) => {
          rmTargets.push(p)
          vol.rmSync(p, opts)
        },
      },
    }
  }

  // A git that accepts exactly one remove spelling and answers the locked refusal to
  // any other, deleting the directory when it accepts — as the real one does.
  function gitThatRemoves(vol, succeedsOn) {
    const lines = []
    const git = (args) => {
      const line = args.join(' ')
      lines.push(line)
      if (line.startsWith('worktree remove')) {
        if (line !== succeedsOn) return { status: 128, stdout: '', stderr: LOCKED }
        vol.rmSync(WT, { recursive: true, force: true })
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    git.lines = () => lines
    return git
  }

  const lockedVolume = () =>
    Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      [`${WT}/held.txt`]: 'the worktree git is refusing to remove',
    })

  it('escalates to --force --force when git refuses, and lets git finish the job', () => {
    const vol = lockedVolume()
    const { fs, rmTargets } = spyFs(vol)
    const git = gitThatRemoves(vol, `worktree remove --force --force ${WT}`)
    const stderr = makeStderr()

    expect(removeWorktree(ROOT, 'issue-7', { fs, git, home: HOME, stderr })).toBe(true)
    // Gentler spelling first, override second, prune last.
    expect(git.lines()).toEqual([
      `worktree remove --force ${WT}`,
      `worktree remove --force --force ${WT}`,
      'worktree prune',
    ])
    // git got there in the end, so the package's only recursive delete never ran and
    // there is no warning to explain — the escalation is invisible when it works.
    expect(rmTargets).toEqual([])
    expect(stderr.calls).toEqual([])
    expect(vol.existsSync(WT)).toBe(false)
  })

  it('does not reach for --force --force when one --force was enough', () => {
    const vol = lockedVolume()
    const { fs, rmTargets } = spyFs(vol)
    const git = gitThatRemoves(vol, `worktree remove --force ${WT}`)
    const stderr = makeStderr()

    expect(removeWorktree(ROOT, 'issue-7', { fs, git, home: HOME, stderr })).toBe(true)
    expect(git.lines()).toEqual([`worktree remove --force ${WT}`, 'worktree prune'])
    expect(rmTargets).toEqual([])
    expect(stderr.calls).toEqual([])
  })

  it('refuses an unsafe main root, so the teardown can never be aimed at $HOME', () => {
    const git = fakeGit()
    expect(() =>
      removeWorktree(HOME, 'issue-7', {
        fs: Volume.fromJSON({}),
        git,
        home: HOME,
        stderr: makeStderr(),
      }),
    ).toThrow(/refusing/i)
    expect(git.calls).toHaveLength(0)
  })
})

// --- #221: the folder-mode create ------------------------------------------
// Folder tasks commit straight to DEV_BRANCH, and git refuses to check one branch
// out in two trees at once, so this source gets a DETACHED tree instead of a
// per-task branch. Two things differ from createWorktree and nothing else does:
// there is no fetch (this source never pushes, so iteration 2 must build on
// iteration 1's LOCAL commit — basing on origin would silently drop it), and the
// add carries `--detach` rather than `-B <handle>`.
describe('createDetachedWorktree (#221)', () => {
  const setup = () => Volume.fromJSON({ '/repo/.git/HEAD': 'ref: refs/heads/main\n' })
  const TREE = '/repo/.ralph/worktrees/task-7'

  function create(opts = {}) {
    return createDetachedWorktree(ROOT, 'task-7', 'dev', {
      fs: setup(),
      git: fakeGit(),
      home: HOME,
      stderr: makeStderr(),
      ...opts,
    })
  }

  it('adds the worktree DETACHED at the local base, creating no branch', () => {
    // MEASURED on git 2.50.1 (Apple Git-155): `git worktree add --detach <path> main`
    // exits 0 printing `Preparing worktree (detached HEAD a5654b1)`, and `git branch
    // --list` afterwards still shows only `* main` — no `task-7` branch anywhere.
    const git = fakeGit()
    expect(create({ git })).toBe(TREE)
    expect(git.lines()).toContain(`worktree add --detach ${TREE} dev`)
    expect(git.lines().some((l) => l.includes('worktree add -B'))).toBe(false)
  })

  it('never fetches, and never even asks about origin/<base>', () => {
    const git = fakeGit()
    const stderr = makeStderr()
    create({ git, stderr })
    expect(git.lines().filter((l) => l.startsWith('fetch'))).toEqual([])
    expect(git.lines().filter((l) => l.includes('origin/'))).toEqual([])
    expect(stderr.calls).toEqual([])
  })

  it('resolves the LOCAL BRANCH ref, and throws naming it when that ref does not exist', () => {
    const git = fakeGit({ 'rev-parse --verify --quiet refs/heads/dev': { status: 1 } })
    expect(() => create({ git })).toThrow(/dev/)
    // No silent fallback to origin, and nothing added: a base that does not resolve
    // means the loop must abort rather than start the agent on a guess.
    expect(git.lines().some((l) => l.startsWith('worktree add'))).toBe(false)
    // The question is asked as the FULL branch spelling, which is the half of the
    // create/advance contract this end owns — see the next test.
    expect(git.lines()).toContain('rev-parse --verify --quiet refs/heads/dev')
  })

  it('refuses a base that resolves but is NOT a branch, because advance can only move one', () => {
    // A DEV_BRANCH of `v1.0` (a pinned tag is a configuration, not a typo), of `HEAD`,
    // or of a raw sha resolves perfectly well as a rev — so accepting any rev here used
    // to hand the agent a tree whose commit advanceOrPark could never move: it resolves
    // `refs/heads/<branch>`, finds nothing, and the commit ends up reachable from
    // nothing but this tree's detached HEAD, which the NEXT run for the same task
    // number force-removes. Refusing at the create is the honest early failure: it
    // happens before any agent work exists to lose, and the loop's `|| task_worktree=""`
    // turns it into an abort with the reason on stderr.
    const git = fakeGit({
      'rev-parse --verify --quiet refs/heads/v1.0': { status: 1 },
      'rev-parse --verify --quiet v1.0': { stdout: `${'c'.repeat(40)}\n` },
    })
    expect(() =>
      createDetachedWorktree(ROOT, 'task-7', 'v1.0', {
        fs: setup(),
        git,
        home: HOME,
        stderr: makeStderr(),
      }),
    ).toThrow(/no local branch/)
    expect(git.lines().some((l) => l.startsWith('worktree add'))).toBe(false)
  })

  it('clears a leftover tree, prunes, and only then adds — the shared create order', () => {
    const vol = Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      [`${TREE}/stale.txt`]: 'from a crashed run',
    })
    const git = fakeGit()
    create({ fs: vol, git })
    const lines = git.lines()
    const add = lines.findIndex((l) => l.startsWith('worktree add'))
    expect(lines.indexOf(`worktree remove --force ${TREE}`)).toBeLessThan(add)
    expect(lines.indexOf('worktree prune')).toBeLessThan(add)
    expect(vol.existsSync(`${TREE}/stale.txt`)).toBe(false)
  })

  it('seeds the tree it returns, like the github twin', () => {
    const vol = Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.env.local': 'ANTHROPIC_API_KEY=sk-local\n',
    })
    create({ fs: vol, processEnv: {} })
    expect(vol.readFileSync(`${TREE}/.env.local`, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
  })

  it('runs every git command in the MAIN repo root', () => {
    const git = fakeGit()
    create({ git })
    for (const call of git.calls) expect(call.cwd).toBe(ROOT)
  })

  it('throws when `git worktree add` fails, quoting git', () => {
    const git = fakeGit({
      'worktree add': { status: 128, stderr: "fatal: '/repo/…/task-7' already exists\n" },
    })
    expect(() => create({ git })).toThrow(/already exists/)
  })

  it('refuses an unsafe main root before it spawns any git at all', () => {
    const git = fakeGit()
    expect(() =>
      createDetachedWorktree(HOME, 'task-7', 'dev', {
        fs: setup(),
        git,
        home: HOME,
        stderr: makeStderr(),
      }),
    ).toThrow(/refusing/i)
    expect(git.calls).toHaveLength(0)
  })

  it('refuses an empty base branch rather than guessing one', () => {
    expect(() =>
      createDetachedWorktree(ROOT, 'task-7', '', {
        fs: setup(),
        git: fakeGit(),
        home: HOME,
        stderr: makeStderr(),
      }),
    ).toThrow(/refusing/i)
  })
})

// --- #221: advancing DEV_BRANCH, or parking the commit ----------------------
// The agent committed on a detached HEAD, so after it returns something has to move
// DEV_BRANCH to that commit — and the whole point of #217 is that "something" may
// never disturb the tree a human is sitting in. Hence a decision table rather than a
// command, and a structured return rather than prose, so both bash and these tests
// read a verdict.
//
// WHY `update-ref` IS NOT THE ANSWER EVERYWHERE. MEASURED on git 2.50.1 (Apple
// Git-155), with `main` checked out in the main tree and one modified tracked file in
// it: `git update-ref refs/heads/main <newSha> <oldSha>` exits 0, and `git status
// --short` in that tree then reads `D  agent.txt` beside the user's own ` M f.txt` —
// the ref moved under a live index, so the tree now says the human staged a deletion
// of a file they have never seen. That is the state this table exists to avoid.
describe('advanceOrPark (#221)', () => {
  const TREE = '/repo/.ralph/worktrees/task-7'
  const SHA = 'a'.repeat(40) // what the agent committed, in the worktree
  const TIP = 'b'.repeat(40) // where DEV_BRANCH points now
  const PARKED = 'ralph/task-7'

  // `git worktree list --porcelain` as git really spells it — MEASURED on git 2.50.1
  // (Apple Git-155) for a main tree on `main` plus one detached worktree.
  const LIST_MAIN_ON_BRANCH = `worktree /repo\nHEAD ${TIP}\nbranch refs/heads/main\n\nworktree ${TREE}\nHEAD ${SHA}\ndetached\n\n`
  const LIST_NOBODY_ON_BRANCH = `worktree /repo\nHEAD ${TIP}\nbranch refs/heads/feature/x\n\nworktree ${TREE}\nHEAD ${SHA}\ndetached\n\n`
  const LIST_OTHER_TREE_ON_BRANCH = `worktree /repo\nHEAD ${TIP}\nbranch refs/heads/feature/x\n\nworktree /repo/.ralph/worktrees/task-9\nHEAD ${TIP}\nbranch refs/heads/main\n\nworktree ${TREE}\nHEAD ${SHA}\ndetached\n\n`

  const vol = () =>
    Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      [`${TREE}/.git`]: 'gitdir: /repo/.git/worktrees/task-7\n',
    })

  // The four answers the module reads, each with its own scripted default, so a test
  // states only the one it is about.
  // `extra` is spread LAST on purpose: fakeGit matches in insertion order, and an
  // earlier key would shadow a test's own override of the same command (a re-assigned
  // key keeps its original position, so the ordering is unchanged either way).
  function gitFor({ sha = SHA, tip = TIP, list = LIST_MAIN_ON_BRANCH, status = '', ...extra } = {}) {
    return fakeGit({
      'rev-parse HEAD': { stdout: `${sha}\n` },
      'rev-parse --verify --quiet refs/heads/main': { stdout: `${tip}\n` },
      'worktree list --porcelain': { stdout: list },
      'status --porcelain': { stdout: status },
      'merge-base --is-ancestor': { status: 0 },
      ...extra,
    })
  }

  function advance(git, opts = {}) {
    return advanceOrPark(ROOT, 'task-7', 'main', {
      fs: vol(),
      git,
      home: HOME,
      stderr: makeStderr(),
      ...opts,
    })
  }

  it('is a silent no-op when the branch already points at the worktree HEAD', () => {
    const git = gitFor({ tip: SHA })
    const stderr = makeStderr()
    const res = advance(git, { stderr })
    expect(res).toMatchObject({ action: 'up-to-date', sha: SHA, branch: 'main' })
    // Nothing written, and nothing said: an agent that committed nothing is the
    // ordinary shape of a task that only moved files around.
    expect(git.lines().some((l) => l.startsWith('update-ref'))).toBe(false)
    expect(git.lines().some((l) => l.startsWith('merge'))).toBe(false)
    expect(git.lines().some((l) => l.startsWith('branch'))).toBe(false)
    expect(stderr.calls).toEqual([])
  })

  describe('the branch is checked out NOWHERE', () => {
    it('moves the ref itself, passing the old value so a concurrent writer loses', () => {
      // MEASURED on git 2.50.1 (Apple Git-155): the same command with a stale old
      // value exits 128 with `fatal: update_ref failed for ref 'refs/heads/main':
      // cannot lock ref 'refs/heads/main': is at <b> but expected <a>`.
      const git = gitFor({ list: LIST_NOBODY_ON_BRANCH })
      const stderr = makeStderr()
      const res = advance(git, { stderr })
      expect(res).toMatchObject({ action: 'advanced', via: 'update-ref', sha: SHA, branch: 'main' })
      expect(git.lines()).toContain(`update-ref refs/heads/main ${SHA} ${TIP}`)
      // The user's tree is never touched: no merge, no checkout, not even a status read.
      expect(git.lines().some((l) => l.startsWith('merge --ff-only'))).toBe(false)
      expect(git.lines().some((l) => l.startsWith('checkout'))).toBe(false)
      expect(stderr.calls).toEqual([])
    })

    it('parks instead of retrying when the ref write is refused', () => {
      const git = gitFor({
        list: LIST_NOBODY_ON_BRANCH,
        'update-ref': { status: 128, stderr: 'fatal: cannot lock ref\n' },
      })
      const res = advance(git)
      expect(res).toMatchObject({ action: 'parked', parkedOn: PARKED, sha: SHA })
      expect(git.lines()).toContain(`branch -f ${PARKED} ${SHA}`)
    })
  })

  describe('the branch is checked out in the MAIN tree', () => {
    it('fast-forwards it in place, with no branch switch, when that tree is clean', () => {
      // MEASURED on git 2.50.1 (Apple Git-155), clean tree on `main`: `git merge
      // --ff-only <sha>` exits 0 printing `Updating a5654b1..65e4ede` / `Fast-forward`,
      // and `git symbolic-ref HEAD` still answers `refs/heads/main` afterwards.
      const git = gitFor({ status: '' })
      const stderr = makeStderr()
      const res = advance(git, { stderr })
      expect(res).toMatchObject({ action: 'advanced', via: 'fast-forward', sha: SHA })
      expect(git.lines()).toContain(`merge --ff-only ${SHA}`)
      expect(git.calls.find((c) => c.args[0] === 'merge').cwd).toBe(ROOT)
      // The two spellings that would move a human's HEAD.
      expect(git.lines().some((l) => l.startsWith('checkout'))).toBe(false)
      expect(git.lines().some((l) => l.startsWith('switch'))).toBe(false)
      expect(stderr.calls).toEqual([])
    })

    it('writes NOTHING and parks when that tree is dirty, warning with the branch and the sha', () => {
      // The gate is ours, not git's: MEASURED on git 2.50.1 (Apple Git-155), a
      // `merge --ff-only` into a tree holding one modified tracked file that the
      // merge does not touch exits 0 and keeps the edit. It only refuses when the
      // merge would overwrite the dirty path (`error: The following untracked working
      // tree files would be overwritten by merge`). Ralph refuses on ANY dirt,
      // because a ref moving under a tree a human is working in is not ours to risk.
      const git = gitFor({ status: ' M README.md\n' })
      const stderr = makeStderr()
      const res = advance(git, { stderr })
      expect(res).toMatchObject({
        action: 'parked',
        parkedOn: PARKED,
        sha: SHA,
        branch: 'main',
        reason: 'dirty-main-tree',
      })
      expect(git.lines().some((l) => l.startsWith('merge --ff-only'))).toBe(false)
      expect(git.lines().some((l) => l.startsWith('update-ref'))).toBe(false)
      expect(git.lines()).toContain(`branch -f ${PARKED} ${SHA}`)
      const said = stderr.calls.join('')
      expect(said).toContain(PARKED)
      expect(said).toContain(SHA)
      expect(said).toContain('main')
    })

    it('parks when git refuses the fast-forward after all', () => {
      const git = gitFor({
        'merge --ff-only': { status: 1, stderr: 'error: would be overwritten by merge\n' },
      })
      const stderr = makeStderr()
      const res = advance(git, { stderr })
      expect(res).toMatchObject({ action: 'parked', parkedOn: PARKED, reason: 'ff-refused' })
      expect(stderr.calls.join('')).toContain(SHA)
    })
  })

  it('parks when the branch is checked out in some OTHER worktree', () => {
    const git = gitFor({ list: LIST_OTHER_TREE_ON_BRANCH })
    const res = advance(git)
    expect(res).toMatchObject({ action: 'parked', parkedOn: PARKED, reason: 'other-worktree' })
    expect(git.lines().some((l) => l.startsWith('update-ref'))).toBe(false)
    expect(git.lines().some((l) => l.startsWith('merge --ff-only'))).toBe(false)
  })

  it('parks when `worktree list` cannot be READ, instead of reading silence as nobody', () => {
    // The whole table hangs off this one parse, and an empty answer is indistinguishable
    // from "no worktree holds the branch" — which selects the single arm that writes a
    // ref without asking any tree about its dirt. So the exit code decides first: an
    // answer that never arrived is not an answer, exactly as a failed `status` read
    // counts as dirt rather than as cleanliness.
    const git = gitFor({
      'worktree list --porcelain': { status: 128, stdout: '', stderr: 'fatal: not a git repository\n' },
    })
    const stderr = makeStderr()
    const res = advance(git, { stderr })
    expect(res).toMatchObject({ action: 'parked', parkedOn: PARKED, reason: 'holder-unknown' })
    expect(git.lines().some((l) => l.startsWith('update-ref'))).toBe(false)
    expect(git.lines().some((l) => l.startsWith('merge --ff-only'))).toBe(false)
    expect(stderr.calls.join('')).toContain(SHA)
  })

  it('rescues the commit onto the park branch, then still refuses, when the branch does not resolve', () => {
    // A DEV_BRANCH that is not a branch (a tag, `HEAD`, a raw sha) is refused by
    // createDetachedWorktree, so from the loop this is unreachable — a direct caller can
    // still reach it, and by then the agent's commit EXISTS. Both halves are therefore
    // required: the ref write, because the invariant #221 rests on is that the commit is
    // reachable from some ref (a bare throw leaves it on nothing but a detached HEAD in a
    // directory the next run for the same task number force-removes), and the throw,
    // because a base no `advance` can ever move is a misconfiguration and not an outcome
    // of a run. So this is the one path here that writes the park ref WITHOUT a park's
    // exit code — the sha travels in the refusal instead of in a warning.
    const git = gitFor({ 'rev-parse --verify --quiet refs/heads/main': { status: 1 } })
    const stderr = makeStderr()
    expect(() => advance(git, { stderr })).toThrow(
      new RegExp(`'main' is not a local branch.*${SHA} is parked on ${PARKED}`),
    )
    expect(git.lines()).toContain(`branch -f ${PARKED} ${SHA}`)
    expect(git.lines().some((l) => l.startsWith('update-ref'))).toBe(false)
    expect(git.lines().some((l) => l.startsWith('merge --ff-only'))).toBe(false)
    // Nothing on the warning channel: the CLI turns the throw into the single line a
    // human reads, and two lines about one commit is what the loop's pane cannot afford.
    expect(stderr.calls).toEqual([])
  })

  it('says the sha and the directory when the branch does not resolve AND the rescue fails', () => {
    const git = gitFor({
      'rev-parse --verify --quiet refs/heads/main': { status: 1 },
      'branch -f': { status: 128, stderr: 'fatal: cannot lock ref\n' },
    })
    expect(() => advance(git, { stderr: makeStderr() })).toThrow(
      new RegExp(`could not be parked on ${PARKED} either \\(fatal: cannot lock ref\\).*${TREE}`),
    )
  })

  it('parks a DIVERGED history without asking anything else', () => {
    // MEASURED on git 2.50.1 (Apple Git-155): with the branch ahead of the worktree's
    // HEAD, `git merge-base --is-ancestor <tip> <sha>` exits 1 and `git merge
    // --ff-only <sha>` exits 128 with `fatal: Not possible to fast-forward,
    // aborting.` — so the ancestor test is the cheap way to reach the same verdict.
    const git = gitFor({ 'merge-base --is-ancestor': { status: 1 } })
    const stderr = makeStderr()
    const res = advance(git, { stderr })
    expect(res).toMatchObject({ action: 'parked', parkedOn: PARKED, reason: 'diverged' })
    expect(git.lines().some((l) => l.startsWith('update-ref'))).toBe(false)
    expect(git.lines().some((l) => l.startsWith('merge --ff-only'))).toBe(false)
    expect(stderr.calls.join('')).toContain(SHA)
  })

  it('still names the SHA when even the park write fails', () => {
    // The last line of defence: whatever else went wrong, a human has to be able to
    // find the commit. So the sha is in the warning even when no branch points at it.
    const git = gitFor({
      status: ' M README.md\n',
      'branch -f': { status: 128, stderr: 'fatal: cannot lock ref\n' },
    })
    const stderr = makeStderr()
    const res = advance(git, { stderr })
    expect(res).toMatchObject({ action: 'parked', parkedOn: null, sha: SHA })
    expect(stderr.calls.join('')).toContain(SHA)
  })

  it('never throws on any park path — a branch ralph could not advance is not a failed task', () => {
    for (const script of [
      { status: ' M README.md\n' },
      { 'merge-base --is-ancestor': { status: 1 } },
      { list: LIST_OTHER_TREE_ON_BRANCH },
      { 'merge --ff-only': { status: 1 } },
      { status: ' M x\n', 'branch -f': { status: 128 } },
      { 'worktree list --porcelain': { status: 128 } },
    ]) {
      expect(() => advance(gitFor(script))).not.toThrow()
    }
  })

  describe('the invocations that ARE broken', () => {
    it('throws when there is no worktree to read a commit from', () => {
      const git = fakeGit()
      expect(() =>
        advanceOrPark(ROOT, 'task-7', 'main', {
          fs: Volume.fromJSON({ '/repo/.git/HEAD': 'ref: refs/heads/main\n' }),
          git,
          home: HOME,
          stderr: makeStderr(),
        }),
      ).toThrow(new RegExp(TREE))
      expect(git.calls).toHaveLength(0)
    })

    it('refuses an unsafe main root before it spawns any git at all', () => {
      const git = fakeGit()
      expect(() =>
        advanceOrPark(HOME, 'task-7', 'main', {
          fs: vol(),
          git,
          home: HOME,
          stderr: makeStderr(),
        }),
      ).toThrow(/refusing/i)
      expect(git.calls).toHaveLength(0)
    })

    it('refuses a branch name that is not a usable ref', () => {
      expect(() =>
        advanceOrPark(ROOT, 'task-7', '--force', {
          fs: vol(),
          git: fakeGit(),
          home: HOME,
          stderr: makeStderr(),
        }),
      ).toThrow(/refusing/i)
    })
  })
})

// --- The CLI surface templates/ralph.sh actually calls -----------------------
// The library above is only half the module: the loop reaches it as
// `node lib/worktree.js <verb> …`, so the process contract is what it depends on.
// `path` needs no git and no repository, so it is covered here; `create` and
// `remove` are driven against a REAL git repository by
// test/loop.worktree.test.js, which runs the whole bash arm.
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'worktree.js')

function cli(...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 15000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('worktree.js CLI (#218)', () => {
  it('prints the derived path on stdout and exits 0', () => {
    const res = cli('path', '/tmp/ralph-worktree-cli/project', 'issue-7')
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe('/tmp/ralph-worktree-cli/project/.ralph/worktrees/issue-7')
    expect(res.stderr).toBe('')
  })

  it('exits 2 with a usage line on a bad invocation', () => {
    for (const argv of [
      [],
      ['path'],
      ['nonsense', '/tmp/x', 'issue-7'],
      // #221: both new verbs need a fourth argument — a base ref to detach at, and a
      // branch to advance — and neither may be guessed.
      ['create-detached', '/tmp/x', 'task-7'],
      ['advance', '/tmp/x', 'task-7'],
    ]) {
      const res = cli(...argv)
      expect(res.status).toBe(2)
      expect(res.stderr).toMatch(/usage: worktree\.js/)
      expect(res.stdout).toBe('')
    }
  })

  it('names every verb it accepts in the usage line (#221)', () => {
    const { stderr } = cli()
    for (const verb of ['path', 'create', 'create-detached', 'advance', 'remove']) {
      expect(stderr).toContain(verb)
    }
  })

  it('turns a refusal into ONE terse stderr line and a non-zero exit, never a stack trace', () => {
    // This runs inside the tmux pane a human is watching, so the same rule
    // lib/run-state.js's CLI follows applies: no stack, no `at ` frames.
    const res = cli('path', '/', 'issue-7')
    expect(res.status).not.toBe(0)
    expect(res.stderr).toMatch(/refusing/i)
    expect(res.stderr.trim().split('\n')).toHaveLength(1)
    expect(res.stderr).not.toContain('    at ')
    expect(res.stdout).toBe('')
  })
})
