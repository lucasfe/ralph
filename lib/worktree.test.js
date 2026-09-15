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
    for (const argv of [[], ['path'], ['nonsense', '/tmp/x', 'issue-7']]) {
      const res = cli(...argv)
      expect(res.status).toBe(2)
      expect(res.stderr).toMatch(/usage: worktree\.js/)
      expect(res.stdout).toBe('')
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
