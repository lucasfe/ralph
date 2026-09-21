import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { advanceOrPark, createDetachedWorktree } from './worktree.js'

// QA augmentation for #221's folder-mode create. The dev's suite proves the tree comes out
// detached at the local tip; this file drives the two promises in that function's header
// that only a REAL remote can falsify, and then the one thing the create/advance pair USED
// to disagree about (closed while this file was being written — see the last describe):
//
//   "WHY NO FETCH, and no origin/<base> either. This source never pushes, so the branch on
//    disk is the only place the previous iteration's commit exists."
//
//   — proven here against a real bare origin that is AHEAD of the local branch with a
//     commit the local repository has never seen, so a fetch would be visible in
//     `refs/remotes/origin/main` and in FETCH_HEAD rather than merely absent from an argv
//     log. (MEASURED on git 2.50.1 (Apple Git-155): neither `git clone` nor `git push -u`
//     writes `.git/FETCH_HEAD`, so its absence really does mean nothing fetched.)
//
//   "git will not hand one branch to two worktrees … `worktree add -B main <path> main`
//    exits 128 … while `worktree add --detach <path> main` exits 0"
//
//   — proven here by doing it with the branch genuinely checked out in the main tree,
//     which is the whole reason folder mode detaches.
//
// AND THE ASYMMETRY THAT USED TO EXIST: `create-detached` accepted any rev that `rev-parse
// --verify` resolves, while `advance` requires `refs/heads/<same name>`. A DEV_BRANCH naming
// a tag (or `HEAD`, or a raw sha) therefore passed the create and failed the advance, which
// is why the last describe in this file exists. It is closed in both directions now — the
// create asks for `refs/heads/<base>` (the `it.each` in the first describe below) and the
// advance keeps the commit reachable before it refuses — and what the last describe still
// asserts is the invariant itself, so it holds whichever end owns it.

const CLEAN_FS = {
  existsSync: () => false,
  mkdirSync: () => {},
  rmSync: () => {},
  lstatSync: () => {
    throw new Error('lstatSync: not reached')
  },
  statSync: () => {
    throw new Error('statSync: not reached')
  },
  copyFileSync: () => {
    throw new Error('copyFileSync: not reached')
  },
  unlinkSync: () => {
    throw new Error('unlinkSync: not reached')
  },
}

function recorder(script = {}) {
  const calls = []
  const git = (args, opts = {}) => {
    const line = args.join(' ')
    calls.push({ line, argv: args, cwd: opts.cwd })
    for (const [prefix, result] of Object.entries(script)) {
      if (line.startsWith(prefix)) return { status: 0, stdout: '', stderr: '', ...result }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  const said = []
  return { git, calls, said, stderr: { write: (m) => said.push(m) }, lines: () => calls.map((c) => c.line) }
}

// ---------------------------------------------------------------------------
// 1. No fetch, no remote-tracking ref — the argv log
// ---------------------------------------------------------------------------

describe('createDetachedWorktree — the git argv it builds (#221 QA)', () => {
  it('never spells `fetch` and never spells `origin/`, for any base', () => {
    // The narrow, fast version of the real-git proof below: the whole point of folder mode
    // is that iteration 2 builds on iteration 1's UNPUSHED commit, so a remote must not
    // enter this code path at all — not as a fetch, and not as an `origin/<base>` start
    // point that would silently reset the tree to what was last pushed.
    for (const base of ['main', 'dev', 'release/1.2']) {
      const rec = recorder()
      const path = createDetachedWorktree('/repo', 'task-1', base, {
        fs: CLEAN_FS,
        git: rec.git,
        home: '/home/dev',
        processEnv: {},
        stderr: rec.stderr,
      })
      expect(path).toBe('/repo/.ralph/worktrees/task-1')
      const flat = rec.calls.flatMap((c) => c.argv)
      expect(flat, base).not.toContain('fetch')
      expect(flat.filter((a) => a.includes('origin')), base).toEqual([])
      // The base is handed to `add` verbatim, so the tree is cut from the LOCAL ref.
      expect(rec.lines()).toContain(`worktree add --detach ${path} ${base}`)
      // Nothing was said: an ordinary create is silent, unlike the github twin, which
      // warns when it falls back off origin.
      expect(rec.said.join(''), base).toBe('')
    }
  })

  it('runs every git call in the MAIN root — the loop\'s cwd never moves', () => {
    const rec = recorder()
    createDetachedWorktree('/repo', 'task-1', 'main', {
      fs: CLEAN_FS,
      git: rec.git,
      home: '/home/dev',
      processEnv: {},
      stderr: rec.stderr,
    })
    expect(rec.calls.length).toBeGreaterThan(0)
    for (const call of rec.calls) expect(call.cwd).toBe('/repo')
  })

  it('refuses a base that resolves nowhere before it adds anything', () => {
    const rec = recorder({ 'rev-parse --verify --quiet': { status: 1 } })
    expect(() =>
      createDetachedWorktree('/repo', 'task-1', 'dev', {
        fs: CLEAN_FS,
        git: rec.git,
        home: '/home/dev',
        processEnv: {},
        stderr: rec.stderr,
      }),
    ).toThrow(/no local branch/)
    expect(rec.lines().some((l) => l.startsWith('worktree add'))).toBe(false)
  })

  // Added after the fix for the asymmetry at the bottom of this file: the question this
  // create asks is now the FULL branch spelling, which is what makes the create/advance
  // pair agree about what a base is. Each row below RESOLVES as a rev and is still refused.
  it.each([
    ['a tag', 'v1.0'],
    ['HEAD', 'HEAD'],
    ['a raw sha', 'f'.repeat(40)],
    ['a fully spelled ref', 'refs/heads/main'],
  ])('refuses %s, which resolves as a rev but is not a branch it could advance', (_label, base) => {
    // Scripted so the two spellings can disagree: the bare rev resolves, `refs/heads/<it>`
    // does not. That is the whole difference between the pair agreeing and the pre-fix
    // state, where a tree was handed out for a commit `advance` could never move.
    const rec = recorder({
      [`rev-parse --verify --quiet refs/heads/${base}`]: { status: 1 },
      'rev-parse --verify --quiet': { status: 0, stdout: `${'c'.repeat(40)}\n` },
    })
    expect(() =>
      createDetachedWorktree('/repo', 'task-1', base, {
        fs: CLEAN_FS,
        git: rec.git,
        home: '/home/dev',
        processEnv: {},
        stderr: rec.stderr,
      }),
    ).toThrow(/no local branch/)
    // The question really was asked as the branch spelling, and nothing was added.
    expect(rec.lines()).toContain(`rev-parse --verify --quiet refs/heads/${base}`)
    expect(rec.lines().some((l) => l.startsWith('worktree add'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Real git, real remote
// ---------------------------------------------------------------------------

// A bare origin that is genuinely AHEAD of the local branch, plus a local branch that is
// genuinely ahead of its remote-tracking ref — which is the state a folder-mode run is
// really in: iteration 1's commit exists only on disk.
function repoWithDivergentOrigin() {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'ralph-detached-qa-')))
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  const init = (cwd) => {
    g(cwd, 'config', 'user.email', 'ralph@example.test')
    g(cwd, 'config', 'user.name', 'Ralph Test')
    g(cwd, 'config', 'commit.gpgsign', 'false')
  }
  // `--initial-branch=main` is not decoration: without it the bare repo's HEAD is whatever
  // this machine's `init.defaultBranch` says, and a developer with `main` configured and a CI
  // runner with the built-in `master` disagree. The bare repo would then hold `refs/heads/main`
  // (pushed below) while its HEAD still named `refs/heads/master`, so cloning it a second time
  // for `other` checks nothing out — `warning: remote HEAD refers to nonexistent ref, unable to
  // checkout` — and `other`'s push fails with `src refspec main does not match any`. MEASURED
  // exactly that way on the CI runner. The two sibling fixtures (test/loop.worktree.folder*.js)
  // already pass the flag; this one did not.
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', 'origin.git'], {
    cwd: sandbox,
  })
  // stderr silenced: cloning the empty bare repo prints a warning that says nothing about
  // this fixture, and a non-zero exit still throws.
  execFileSync('git', ['clone', '-q', 'origin.git', 'work'], {
    cwd: sandbox,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const root = join(sandbox, 'work')
  init(root)
  writeFileSync(join(root, '.gitignore'), '.ralph/\n')
  writeFileSync(join(root, 'shared.txt'), 'A\n')
  g(root, 'add', '.')
  g(root, 'commit', '-q', '-m', 'A: pushed')
  g(root, 'branch', '-M', 'main')
  g(root, 'push', '-q', '-u', 'origin', 'main')

  // Somebody else pushes C. The local repository is never told.
  execFileSync('git', ['clone', '-q', 'origin.git', 'other'], {
    cwd: sandbox,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const other = join(sandbox, 'other')
  init(other)
  writeFileSync(join(other, 'theirs.txt'), 'C\n')
  g(other, 'add', '.')
  g(other, 'commit', '-q', '-m', 'C: someone else pushed')
  g(other, 'push', '-q', 'origin', 'main')

  // Iteration 1's commit: local only, exactly as folder mode leaves it.
  writeFileSync(join(root, 'from-iteration-1.txt'), 'B\n')
  g(root, 'add', '.')
  g(root, 'commit', '-q', '-m', 'B: local only, never pushed')

  return {
    sandbox,
    root,
    opts: { home: join(sandbox, 'not-a-home'), processEnv: {}, stderr: { write: () => {} } },
    rev: (ref, cwd = root) => g(cwd, 'rev-parse', ref).trim(),
  }
}

describe('createDetachedWorktree against a real remote — the no-fetch promise (#221 QA)', () => {
  it('cuts the tree from the LOCAL tip and leaves the remote-tracking ref untouched', () => {
    const { sandbox, root, opts, rev } = repoWithDivergentOrigin()
    try {
      const localTip = rev('main')
      const trackingBefore = rev('refs/remotes/origin/main')
      const upstreamNow = rev('main', join(sandbox, 'origin.git'))
      // The fixture really is divergent in both directions, or this test proves nothing.
      expect(trackingBefore).not.toBe(localTip)
      expect(upstreamNow).not.toBe(trackingBefore)

      const tree = createDetachedWorktree(root, 'task-1', 'main', opts)

      // Detached, at the commit that was never pushed.
      expect(rev('HEAD', tree)).toBe(localTip)
      expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tree, encoding: 'utf8' }).trim()).toBe('HEAD')
      expect(readFileSync(join(tree, 'from-iteration-1.txt'), 'utf8')).toBe('B\n')
      // Nothing fetched: the tracking ref still names A, not C, and no FETCH_HEAD was
      // written (MEASURED: neither clone nor `push -u` writes one, so this is not a
      // pre-existing file being re-observed).
      expect(rev('refs/remotes/origin/main')).toBe(trackingBefore)
      expect(existsSync(join(root, '.git', 'FETCH_HEAD'))).toBe(false)
      // And the other developer's file is nowhere in the tree the agent was handed.
      expect(existsSync(join(tree, 'theirs.txt'))).toBe(false)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('detaches while the branch is CHECKED OUT in the main tree, moving nobody\'s HEAD', () => {
    // The measurement in the function's header, exercised rather than quoted: `-B` cannot
    // do this, `--detach` can. The main tree is on `main` throughout — which is the normal
    // state of a user's own checkout when they start the loop.
    const { sandbox, root, opts, rev } = repoWithDivergentOrigin()
    try {
      const symbolicBefore = execFileSync('git', ['symbolic-ref', 'HEAD'], { cwd: root, encoding: 'utf8' })
      const branchesBefore = execFileSync('git', ['branch', '--list'], { cwd: root, encoding: 'utf8' })

      const tree = createDetachedWorktree(root, 'task-1', 'main', opts)

      expect(execFileSync('git', ['symbolic-ref', 'HEAD'], { cwd: root, encoding: 'utf8' })).toBe(symbolicBefore)
      // No branch was created for the task, so nothing can collide with `main` later.
      expect(execFileSync('git', ['branch', '--list'], { cwd: root, encoding: 'utf8' })).toBe(branchesBefore)
      expect(branchesBefore).not.toContain('task-1')
      expect(rev('HEAD', tree)).toBe(rev('main'))
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('recovers from a previous run that left a directory at the path', () => {
    // Idempotence, on the folder-mode path this time: task numbers repeat (a task that
    // failed is picked again), so a leftover tree must not deadlock every future run for
    // that number the way it would if `worktree add` were called on a non-empty path.
    const { sandbox, root, opts, rev } = repoWithDivergentOrigin()
    try {
      const stale = join(root, '.ralph', 'worktrees', 'task-1')
      mkdirSync(stale, { recursive: true })
      writeFileSync(join(stale, 'left-behind.txt'), 'from a crashed run\n')

      const tree = createDetachedWorktree(root, 'task-1', 'main', opts)
      expect(tree).toBe(stale)
      expect(rev('HEAD', tree)).toBe(rev('main'))
      expect(existsSync(join(tree, 'left-behind.txt'))).toBe(false)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 3. What create and advance each accept as a base — and the invariant that
//    survives them disagreeing
// ---------------------------------------------------------------------------

describe('create-detached and advance must agree about what DEV_BRANCH may be (#221 QA)', () => {
  it('keeps the agent\'s commit reachable from SOME ref when DEV_BRANCH names a tag', () => {
    // THE INVARIANT #221 EXISTS FOR: a folder task's commit is either on DEV_BRANCH or on
    // its park branch, never on neither — "a park is not a failure" is only true because
    // the commit is still findable by name.
    //
    // WHAT THIS WAS WRITTEN AGAINST: `createDetachedWorktree` used to accept any rev
    // `rev-parse --verify` resolves, so a DEV_BRANCH of `v1.0` (or `HEAD`, or a raw sha — a
    // plausible ralph.config.sh typo, and a pinned-tag configuration is not even a typo)
    // got a tree. `advanceOrPark` then resolved `refs/heads/v1.0`, found nothing, and threw
    // without writing anything — which templates/ralph.sh turns into a warning that changes
    // no count, so the run reported the task as done with the commit sitting on nothing but
    // a detached HEAD in a directory the next run for that same task number force-removes.
    //
    // Written fix-agnostically: either end of the pair can own this — refuse a base that
    // is not a local branch at CREATE (the symmetrical reading of "no local branch of that
    // name exists"), or keep the commit reachable at ADVANCE when the branch does not
    // resolve. This asserts only the invariant, so it holds for either, and it still holds
    // now that both ends were changed.
    const { sandbox, root, opts, rev } = repoWithDivergentOrigin()
    try {
      execFileSync('git', ['tag', 'v1.0'], { cwd: root })

      let tree = null
      let created = null
      try {
        tree = createDetachedWorktree(root, 'task-1', 'v1.0', opts)
      } catch (e) {
        created = e
      }
      if (created) {
        // Refused at the CREATE, which is one of the two ways this can hold: no agent work
        // exists yet, so there is nothing to strand. Asserted rather than merely returned,
        // so this row cannot pass by the create failing for some unrelated reason, and so
        // a leftover directory (which the next run for this task number would inherit)
        // still counts as a failure.
        expect(created.message).toContain("'v1.0'")
        expect(existsSync(join(root, '.ralph', 'worktrees', 'task-1'))).toBe(false)
        return
      }

      // The agent does its work and commits, exactly as templates/ralph.sh expects.
      writeFileSync(join(tree, 'agent-file.txt'), 'work the user asked for\n')
      execFileSync('git', ['add', 'agent-file.txt'], { cwd: tree })
      execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'feat: agent work'], {
        cwd: tree,
      })
      const sha = rev('HEAD', tree)

      let advanced = null
      let threw = null
      try {
        advanced = advanceOrPark(root, 'task-1', 'v1.0', opts)
      } catch (e) {
        threw = e
      }

      // Whatever happened, the commit must be reachable from a ref. `for-each-ref
      // --contains` is the whole answer: empty output means nothing in the repository
      // points at it, so the next `git gc` is free to delete the user's work.
      const refs = execFileSync('git', ['for-each-ref', '--contains', sha, '--format=%(refname)'], {
        cwd: root,
        encoding: 'utf8',
      }).trim()
      expect(refs, `advance ${threw ? `threw (${threw.message})` : JSON.stringify(advanced)}`).not.toBe('')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('names the branch and the reason when DEV_BRANCH exists only on the remote', () => {
    // The other half of the same base question, and the one that behaved WELL all along: a
    // branch that was pushed but never checked out locally is refused at the create, the
    // loop's `|| task_worktree=""` makes that an abort, and the message says why rather
    // than leaving a user to wonder where their `dev` branch went. Pinned because "this
    // create never fetches" makes it reachable by ordinary configuration, not by a typo.
    const { sandbox, root, opts } = repoWithDivergentOrigin()
    try {
      execFileSync('git', ['branch', 'dev'], { cwd: root })
      execFileSync('git', ['push', '-q', 'origin', 'dev'], { cwd: root })
      execFileSync('git', ['branch', '-D', 'dev'], { cwd: root })
      // `origin/dev` resolves; `dev` does not. The github arm would have used the former.
      expect(
        execFileSync('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/dev'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
      ).not.toBe('')

      let threw = null
      try {
        createDetachedWorktree(root, 'task-1', 'dev', opts)
      } catch (e) {
        threw = e
      }
      expect(threw).not.toBeNull()
      expect(threw.message).toContain("'dev'")
      expect(threw.message).toContain('never fetches')
      expect(existsSync(join(root, '.ralph', 'worktrees', 'task-1'))).toBe(false)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
