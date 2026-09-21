// #218 — the single owner of every git-worktree fact in this package.
//
// WHY THIS MODULE EXISTS AT ALL
// The loop used to resolve a GitHub issue in the user's own working tree: the agent
// ran `git checkout -b issue-N` there, and the end-of-run Cleanup ran `git checkout
// dev`. Both move the HEAD of the tree a human is sitting in, and the second one
// does it even when the human never asked ralph to touch their branch. #217's fix is
// to give each issue its own worktree, and this module is where that lives.
//
// WHY IT IS A LIBRARY *AND* A CLI, and not bash
// NOT because the script is copied into the consuming repo — it is not, and that
// premise (which this comment carried until somebody went looking) is worth killing
// rather than repeating: `grep -n 'ralph.sh' lib/commands/init.js` matches nothing, so
// `ralph init` writes no loop script at all, and both launchers hand
// `templatePath('ralph.sh')` to bash and run it IN PLACE out of the install
// (lib/commands/start.js's `bash '<template>'`, lib/commands/cycle.js's
// `exec('bash', [ralphTemplate, '--once'])`), which is where the script's own
// `RALPH_PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"` comes from. It has been that way
// since 41c53d1 moved ralph.sh under templates/, so the script upgrades with the
// package exactly like this file does.
//
// The reason is TESTABILITY. Bash spelled in that script can only be reached by
// spawning the whole loop against a seeded git repo with stubbed CLIs on PATH, which is
// what test/loop.worktree.test.js does; the same rules in a module take an injected
// `fs`, `git` and `home` and get a unit test each — see the table-driven refusal cases
// in lib/worktree.test.js. The convention this file follows is already
// established by lib/folder-queue.js, lib/run-state.js and lib/jira-queue.js: the
// domain knowledge is an injectable-dependency ES module, the loop reaches it as
// `node "$RALPH_PKG_DIR/lib/worktree.js" <verb> …`, and the bash holds nothing but
// the call. MEASURED: `grep -vE '^\s*#' templates/ralph.sh | grep 'git worktree'`
// matches nothing — the phrase appears there only inside comments, which is the same
// scope test/loop.worktree.test.js asserts over so it stays that way.
//
// WHY THE REFUSAL GUARDS ARE SO LOUD
// Three of the verbs ask git to remove a tree — `create` and `create-detached` clear
// whatever a dead run left at the path, `remove` is the teardown — twice each, escalating
// to `--force --force`, via the one `removeThroughGit` below, and, when git still
// declines, they fall back to an `fs.rmSync(path, { recursive: true, force: true })`.
// That is a recursive delete aimed at a path this module DERIVED, so the derivation is
// the safety boundary.
// `assertSafeRoot` mirrors the refusal templates/ralph.sh already applies to
// PROJECT_ROOT ("empty, `/`, or $HOME" → abort) and adds the two cases a derived
// path can reach that a checked-out root cannot: a relative root (which would
// resolve against whatever cwd the caller happened to have) and a root inside
// `.git/`. A refusal always names the offending value, because the only reader is a
// human watching a tmux pane.
//
// Seams, all with real defaults, matching this package's convention:
//   fs         — node:fs, or a memfs Volume in lib/worktree.test.js
//   git        — a spawnSync runner, or a recording double in the tests
//   home       — os.homedir(), so the $HOME refusal is assertable without touching $HOME
//   processEnv — the bag the seed knob is read from (#219)
//   stderr     — process.stderr, so the warnings are assertable
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
// #219 — the ONE thing this module does to a worktree that is not a git operation: fill
// it with the gitignored files a project's tests need. Its own module because none of it
// asks git anything; see its header for the measurements and for why a bad entry warns
// rather than throwing.
import { SEED_FS, seedWorktree } from './worktree-seed.js'

// Ralph's own directory inside the project, already used for tasks (.ralph/tasks) and
// run state (.ralph/run-state.json), and already git-ignored in a ralph-managed repo.
const WORKTREES_SUBDIR = ['.ralph', 'worktrees']

// A task handle names one directory AND at least one git branch, and is interpolated
// into an argv this module hands to git. Conservative on purpose: the loop produces two
// shapes and no others — `issue-<n>` for the github source, which becomes the branch of
// that same name, and `task-<n>` for folder mode (#221), which gets a detached tree and
// only ever names a branch when a commit has to be parked on `ralph/task-<n>`. So
// anything with a separator, a leading dot (`..`, `.git`), a leading dash (which git
// would read as a flag) or whitespace is a bug in the caller rather than an exotic
// branch name worth supporting.
const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// A base branch is only ever read (fetched and resolved), never created, so it may
// carry the slashes real branch names use — `release/1.2` — but still not a leading
// dash or any whitespace.
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

// Real git: an argv array, never a shell string, so nothing in a handle or ref can be
// re-read as shell syntax. Returns the shape the tests' double returns.
function realGit(args, { cwd } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ''),
  }
}

const refuse = (message) => {
  throw new Error(`refusing ${message}`)
}

// Collapse git's multi-line diagnostics to something that fits one warning line.
const firstLine = (text) => String(text ?? '').trim().split('\n')[0] ?? ''

// Ask git to remove the worktree at `path`, escalating once if it refuses, and return
// git's LAST verdict (the callers use it to decide whether a human needs to be told).
//
// ONE --FORCE IS NOT ALWAYS ENOUGH. MEASURED on git 2.50.1 (Apple Git-155), on a
// worktree this module created and a `git worktree lock` then held: `git worktree remove
// --force <path>` exits 128 with `fatal: cannot remove a locked working tree;` / `use
// 'remove -f -f' to override or unlock first`, while `git worktree remove --force --force
// <path>` on that same tree exits 0 and takes the directory AND the record with it,
// leaving only the main registration. The gentler single --force stays first, so the
// ordinary case runs the command git documents and `-f -f` is only reached once git has
// said it is the only thing that will work.
//
// NOT GATED ON THE DIRECTORY, deliberately. MEASURED on the same lock with the directory
// already deleted: `--force` still exits 128 with those same two lines, `--force --force`
// still exits 0 and drops the record, and `git worktree prune -v` prints nothing and
// leaves `.git/worktrees/<name>` standing. So a lock refusal has nothing to do with
// whether the directory survived, and `-f -f` is the only thing that clears the record
// either way.
//
// WHY THE LOCK IS THE REFUSAL WORTH ESCALATING FOR: it is the one git will not let a
// prune undo. Absorb it, delete the directory anyway, and what is left is a record no
// `worktree prune` will drop — so the next `worktree add -B <handle> <path> <start>`
// exits 128 with `fatal: '<handle>' is already used by worktree at '<path>'`, and it
// keeps doing that on every run until a human unlocks it or runs `remove -f -f` by hand
// (a prune will NOT do, as measured above). Whichever create walks into it, the loop
// STOPS: templates/ralph.sh turns a throw from `create` or from `create-detached` into
// the same `|| task_worktree=""` and the same abort (templates/ralph.sh:818-830). The
// message quoted above is the one measured for the `-B` spelling, which is the only one
// of the two that names a branch.
//
// ONE HELPER, TWO CALLERS, rather than the same two lines in both: that fact is the
// entire content of both call sites, and a copy is what lets one of them be fixed while
// the other keeps the bug (which is how they came apart in the first place). The callers
// are `addWorktree` — the leftover-clearing both creates share — and `removeWorktree`.
// What they do NEXT still differs (the creates sweep in silence, the teardown warns
// first), so only the escalation is shared. A path git never registered answers
// `fatal: '<path>' is not a working tree` (128) to both spellings, so the escalation
// costs one wasted spawn in that case and nothing else.
function removeThroughGit(path, { cwd, git }) {
  const removed = git(['worktree', 'remove', '--force', path], { cwd })
  if (removed.status === 0) return removed
  return git(['worktree', 'remove', '--force', '--force', path], { cwd })
}

function assertSafeRoot(mainRoot, home) {
  if (typeof mainRoot !== 'string' || mainRoot.trim() === '') {
    refuse(`to derive a worktree path from an empty project root (got ${JSON.stringify(mainRoot)})`)
  }
  if (!isAbsolute(mainRoot)) {
    refuse(
      `to derive a worktree path from the relative project root '${mainRoot}' — it would resolve against whatever cwd the caller has`,
    )
  }
  // resolve() collapses `//` to `/` and drops a trailing slash, so the comparisons
  // below cannot be dodged by spelling the same directory differently.
  const root = resolve(mainRoot)
  if (root === sep) refuse(`to use the filesystem root '${mainRoot}' as a project root`)
  if (home && root === resolve(home)) {
    refuse(`to use the home directory '${mainRoot}' as a project root`)
  }
  if (root.split(sep).includes('.git')) {
    refuse(`to use '${mainRoot}' as a project root — it is inside a .git directory`)
  }
  return root
}

function assertSafeHandle(handle) {
  if (typeof handle !== 'string' || !SAFE_HANDLE.test(handle)) {
    refuse(
      `the task handle ${JSON.stringify(handle)} — a worktree handle must match ${SAFE_HANDLE}`,
    )
  }
  return handle
}

function assertSafeRef(baseRef) {
  if (typeof baseRef !== 'string' || !SAFE_REF.test(baseRef)) {
    refuse(
      `to guess a base branch: ${JSON.stringify(baseRef)} is not a usable ref name (must match ${SAFE_REF})`,
    )
  }
  return baseRef
}

/** `<mainRoot>/.ralph/worktrees` — the parent every per-task worktree lives under. */
export function worktreesRoot(mainRoot, { home = homedir() } = {}) {
  return join(assertSafeRoot(mainRoot, home), ...WORKTREES_SUBDIR)
}

/** `<mainRoot>/.ralph/worktrees/<handle>` — the one worktree for one task handle. */
export function worktreePath(mainRoot, handle, { home = homedir() } = {}) {
  const root = assertSafeRoot(mainRoot, home)
  return join(root, ...WORKTREES_SUBDIR, assertSafeHandle(handle))
}

// The whole of "put a worktree at this handle's path", minus the two facts its two
// callers disagree about. Both clear whatever a dead run left behind, prune, add, and
// seed — in that order, for the reasons measured below. What differs is only:
//
//   plan.resolveStart — WHICH COMMIT the tree starts at. The github flow fetches and
//                       prefers origin/<base>; the folder flow (#221) resolves the
//                       LOCAL ref and nothing else.
//   plan.addArgs      — WHICH ADD. `-B <handle>` puts the tree on a new branch;
//                       `--detach` (#221) puts it on no branch at all.
//
// FACTORED RATHER THAN COPIED, because every line in here is a measurement about git's
// bookkeeping — the escalation, the fs sweep, the single prune's position, the seed's
// position — and a second copy of it is what lets one caller be fixed while the other
// keeps the bug. The two public functions below are each short enough to read whole.
function addWorktree(
  mainRoot,
  handle,
  baseRef,
  {
    // Wider than removeWorktree's three verbs because the seed step (#219) reads, copies,
    // and clears a symlink the checkout may have left at a destination it is about to write
    // — and this object is passed STRAIGHT THROUGH to it. So the seed verbs are SPREAD FROM
    // THAT MODULE'S OWN SEAM rather than enumerated here: a list copied into this file is a
    // list that can drift out of lib/worktree-seed.js silently, and two of the names on it
    // (`lstatSync`, `unlinkSync`) ARE its write-through guard. `rmSync` is this function's
    // own; the seed step never deletes a directory.
    //
    // WHAT A MISSING VERB COSTS has no single answer, so it was MEASURED rather than
    // reasoned about: node v20.20.2 / darwin 25.6.0, one verb dropped at a time from this
    // object, this function driven against a real repository with a git double that checks a
    // symlink out at the seeded path. `existsSync` and `mkdirSync` throw `fs.X is not a
    // function` out of THIS function — the per-issue `break` — and `rmSync` does the same
    // when a leftover directory is at the path. `statSync` and `copyFileSync` cost the entry:
    // `⚠️  worktree: could not seed '.env.local' (fs.X is not a function)`, and the run
    // carries on. `unlinkSync` costs the entry the same way, but only when the destination
    // really is a link, and is silent otherwise. `lstatSync` — the one whose absence used to
    // lose the guard in SILENCE and let the copy write through into the main root — now costs
    // the entry too, by name: `refusing to seed '.env.local' — something is already at that
    // path in the worktree and this fs has no lstatSync …`. In every one of those runs the
    // main-root file the checked-out link pointed at kept its bytes.
    fs = { ...SEED_FS, rmSync },
    git = realGit,
    home = homedir(),
    processEnv = process.env,
    stderr = process.stderr,
  } = {},
  plan,
) {
  // Derivation first, so an unsafe root or handle is refused before any git runs.
  const path = worktreePath(mainRoot, handle, { home })
  const parent = worktreesRoot(mainRoot, { home })
  const base = assertSafeRef(baseRef)
  const cwd = resolve(mainRoot)

  fs.mkdirSync(parent, { recursive: true })

  // Whatever a crashed run left behind, in either half. `removeThroughGit` handles the
  // case where git still has it registered — including the LOCKED case, where the single
  // --force is refused and only `-f -f` will do it (see that function's measurements); the
  // fs sweep handles the case where git has no record at all, which is exactly why git
  // would decline. Letting git finish the job when it can is what keeps this step from
  // manufacturing a record with no directory: that is the state the prune below exists to
  // clear, and a LOCKED one is the version of it no prune can touch.
  //
  // THE REMOVE IS NOT GATED ON THE DIRECTORY, and the asymmetry with the sweep on the next
  // line is deliberate. The two halves of a worktree die separately, and the half that
  // blocks the add is the RECORD: MEASURED on git 2.50.1 (Apple Git-155), a locked record
  // whose directory has already been deleted still answers `worktree remove --force` with
  // `fatal: cannot remove a locked working tree;` (128) and still answers `--force --force`
  // with exit 0, and until something asks, `worktree add -B issue-95 <path> origin/main`
  // keeps failing `fatal: 'issue-95' is already used by worktree at '<path>'` (128) — a
  // per-issue deadlock, since ralph.sh turns that throw into `break`. An `existsSync` gate
  // here would skip the one call that clears it. The sweep, by contrast, has nothing to do
  // when the directory is gone, so it keeps its own check.
  //
  // The price on the common path — no leftover of either kind — is two spawns that both
  // exit 128 with `fatal: '<path>' is not a working tree` (MEASURED, both spellings). That
  // is what teardown has always paid for the same guarantee.
  //
  // A prune BETWEEN the remove and the sweep could never accomplish anything, which is
  // why there is not one: a remove that succeeded already dropped the record itself, and
  // a remove that failed in both spellings left the directory standing, where a prune —
  // which only drops records whose directory is missing — finds nothing. The single prune
  // below is the one that does the work, and it runs after this sweep for that reason.
  removeThroughGit(path, { cwd, git })
  if (fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true })

  const start = plan.resolveStart({ base, cwd, git, handle, stderr })

  // One prune, unconditional, immediately before the add — what drops a stale RECORD
  // whose directory is gone, whichever way it got that way: a killed process, or the fs
  // sweep above (which deletes a directory git had just declined to remove). git keeps
  // its bookkeeping in .git/worktrees/<name> independently of the directory and refuses
  // to re-add a path or a branch that is still registered.
  //
  // ONE KIND OF RECORD IS OUT OF ITS REACH, and naming it is the point of saying this
  // much: a LOCKED one. MEASURED on git 2.50.1 (Apple Git-155), with the locked
  // worktree's directory already deleted, `worktree prune -v` prints nothing and
  // `.git/worktrees/<name>` is still listed afterwards. That case is closed ABOVE
  // instead, by removeThroughGit's escalation to `--force --force`, which git accepts on
  // a locked tree whether or not the directory is still there — which is why that call is
  // not gated on the directory existing.
  //
  // So the sweep above hands this prune a case it cannot finish only for a leftover that
  // is BOTH locked AND corrupt in the one specific way, and that combination is left
  // unhandled on purpose rather than coded around. MEASURED on git 2.50.1 (Apple
  // Git-155), on a worktree that is locked and whose `.git` is a real directory instead
  // of a gitdir file: `--force` fails with `fatal: cannot remove a locked working tree;`
  // and `--force --force` fails too, with `fatal: validation failed, cannot remove
  // working tree: '<path>/.git' is not a .git file, error code 2` (128) — so the sweep
  // deletes the directory, `prune -v` then prints nothing, `.git/worktrees/<name>` still
  // stands, and the add fails `fatal: 'issue-95' is already used by worktree at '<path>'`
  // (128). Getting there takes two things this package does not do — MEASURED, `grep
  // lock` over this file outside its comments and over templates/ralph.sh matches nothing,
  // and the only `.git` inside a worktree here is the gitdir FILE `worktree add` writes.
  // And the recovery is one command a human runs once, MEASURED from exactly that stuck
  // state: `git worktree unlock <path>` exits 0 even though the directory is gone, after
  // which the plain prune below drops `.git/worktrees/issue-95` (exit 0, no output) and
  // the add exits 0. So the lock is the only thing a human has to undo, and the next run
  // of the loop finishes the job on its own.
  //
  // MEASURED end-to-end on git 2.50.1 (Apple Git-155), on a leftover whose `.git` is a
  // real directory rather than a gitdir file: `worktree remove --force` fails with
  // `fatal: validation failed, cannot remove working tree: … is not a .git file, error
  // code 2` (128); `worktree prune -v` with the directory still present prints nothing
  // and leaves both registrations; after `rm -rf`, `worktree add -B issue-98 <path>
  // main` fails with `fatal: 'issue-98' is already used by worktree at '<path>'` (128);
  // and the same add preceded by the plain `worktree prune` below exits 0. (The plain
  // prune is silent about it — `prune -v` is the spelling that reports `Removing
  // worktrees/issue-98: gitdir file points to non-existent location`.)
  // templates/ralph.sh turns a throw from here into `break`, so that one prune is the
  // difference between an issue that recovers by itself and an issue that aborts every
  // future run until a human prunes by hand.
  git(['worktree', 'prune'], { cwd })

  const addArgs = plan.addArgs({ handle, path, start })
  const added = git(addArgs, { cwd })
  if (added.status !== 0) {
    throw new Error(
      `worktree: git ${addArgs.join(' ')} failed (${firstLine(added.stderr) || `exit ${added.status}`})`,
    )
  }

  // AFTER the add, and it can only be after it (#219): `git worktree add` requires the
  // path to be missing or empty — MEASURED on git 2.50.1 (Apple Git-155), an add into a
  // directory holding one file exits 128 with `fatal: '<path>' already exists` — so a
  // seed that ran first would abort the create for every repo that has an `.env.local`,
  // which is the common case. And after the add SUCCEEDED, so a failed add leaves
  // nothing behind to seed. Everything about which files, and what a bad entry does,
  // belongs to the other module.
  seedWorktree(cwd, path, { fs, processEnv, stderr })
  return path
}

/**
 * Create the worktree for `handle` on a NEW branch of the same name, based on
 * `origin/<baseRef>`, and return its absolute path.
 *
 * Every git call runs with cwd = the MAIN repo root, never the worktree: the loop's
 * own cwd must not move, and the worktree does not exist yet when the first of them
 * runs.
 *
 * IDEMPOTENT BY DESIGN, because a crashed iteration is not a rare event. A leftover
 * directory at the path is cleared first, and `worktree add -B` resets the branch
 * rather than failing on it — otherwise one dead run would deadlock every future run
 * on that issue. What it will NOT do is take a branch away from a tree that has it
 * checked out: if `issue-N` is live somewhere else (the user's own tree, say), git
 * refuses the add and that refusal is thrown, which is the correct outcome — moving
 * their HEAD is the very thing #218 exists to stop.
 *
 * The tree it returns is SEEDED (#219): the gitignored files the project's tests need
 * are copied in before the agent is handed the path.
 */
export function createWorktree(mainRoot, handle, baseRef, opts = {}) {
  return addWorktree(mainRoot, handle, baseRef, opts, {
    // origin/<base> is the intended base: it is what the PR will target. The local
    // branch is the fallback for a repo whose remote has no such branch yet.
    resolveStart: ({ base, cwd, git, handle: h, stderr }) => {
      // Best-effort: an offline run must still get a worktree, off the last-known
      // origin ref, rather than no worktree at all.
      const fetched = git(['fetch', 'origin', base], { cwd })
      if (fetched.status !== 0) {
        stderr.write(
          `⚠️  worktree: git fetch origin ${base} failed (${firstLine(fetched.stderr) || `exit ${fetched.status}`}) — using the refs already on disk\n`,
        )
      }
      let start = `origin/${base}`
      if (git(['rev-parse', '--verify', '--quiet', start], { cwd }).status !== 0) {
        stderr.write(`⚠️  worktree: ${start} does not exist — basing ${h} on local ${base}\n`)
        start = base
        if (git(['rev-parse', '--verify', '--quiet', start], { cwd }).status !== 0) {
          throw new Error(
            `worktree: cannot resolve a base commit for '${base}' — neither origin/${base} nor ${base} exists`,
          )
        }
      }
      return start
    },
    addArgs: ({ handle: h, path, start }) => ['worktree', 'add', '-B', h, path, start],
  })
}

/**
 * Create the worktree for `handle` DETACHED at the tip of the LOCAL `baseRef`, and
 * return its absolute path. This is the folder-mode create (#221).
 *
 * WHY DETACHED. Folder tasks commit straight to DEV_BRANCH — no feature branch, no PR
 * — and git will not hand one branch to two worktrees. MEASURED on git 2.50.1 (Apple
 * Git-155), with `main` checked out in the main tree: `git worktree add -B main <path>
 * main` exits 128 with `fatal: 'main' is already used by worktree at '<mainRoot>'`,
 * while `git worktree add --detach <path> main` exits 0 (`Preparing worktree (detached
 * HEAD 0d71546)`), leaves `git branch --list` reading only `* main`, and gives a tree
 * whose `rev-parse --abbrev-ref HEAD` answers the literal `HEAD`. The agent commits
 * there; advanceOrPark below is what moves the branch afterwards.
 *
 * WHY NO FETCH, and no origin/<base> either. This source never pushes, so the branch
 * on disk is the only place the previous iteration's commit exists. Basing on
 * `origin/<base>` would quietly reset the tree to whatever was last pushed and drop
 * that work from the agent's view — so the local ref is resolved, and an unresolvable
 * one is thrown rather than guessed around. (The github twin above wants the opposite:
 * its branch is destined for a PR against the remote.)
 *
 * WHAT COUNTS AS A BASE is narrower than a rev: it has to be a local BRANCH, because
 * advanceOrPark is what moves it once the agent returns and a branch is the only thing
 * it can move. See resolveStart below.
 */
export function createDetachedWorktree(mainRoot, handle, baseRef, opts = {}) {
  return addWorktree(mainRoot, handle, baseRef, opts, {
    // A BRANCH, not merely a rev. `rev-parse --verify <base>` would accept a tag, `HEAD`,
    // or a raw sha — and a DEV_BRANCH pinned to a tag is a configuration, not a typo — but
    // advanceOrPark below can only move `refs/heads/<base>`, so a tree cut from anything
    // else produces a commit this loop has nowhere to put. Refusing here is the honest
    // early failure: it happens before the agent has done any work there is to lose, and
    // the loop's `|| task_worktree=""` turns it into an abort naming the reason. The full
    // spelling is what is verified; the ADD still gets the short base, which is what git
    // resolves in the repository itself.
    resolveStart: ({ base, cwd, git }) => {
      if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], { cwd }).status !== 0) {
        throw new Error(
          `worktree: cannot resolve a base commit for '${base}' — no local branch of that name exists, and this create never fetches`,
        )
      }
      return base
    },
    addArgs: ({ path, start }) => ['worktree', 'add', '--detach', path, start],
  })
}

/**
 * Remove the worktree for `handle` and return `true`.
 *
 * Unconditional and best-effort: teardown must not be the thing that fails a run, so
 * git's own verdict is not the last word — if the directory survives, the fs sweep
 * clears it, because whatever is left would otherwise be in the way of the next run
 * for the same handle. The BRANCH is deliberately left alone; it is what carries the
 * agent's commits to the PR.
 *
 * Best-effort is not the same as sloppy, though: whatever it takes to make the
 * directory go, the administrative RECORD has to go with it, or the next create for
 * the same handle inherits a state git will refuse. That is why the escalation
 * (removeThroughGit, shared with the creates' own leftover-clearing in addWorktree) and
 * the prune ordering below are the way they are.
 *
 * "Unconditional" is about THIS function, not about its callers, and since #220 that
 * distinction matters: templates/ralph.sh removes only after an iteration that FINISHED
 * its issue, and leaves a failed one's tree standing for a human to read the agent's
 * real diff out of. None of that reaches in here — pointed at a handle, this still
 * checks nothing about the tree's state before taking it apart, and the one thing the
 * caller learns is whether it got there: the CLI below turns a throw into exit 1, which
 * is what the loop's warning hangs off.
 */
export function removeWorktree(
  mainRoot,
  handle,
  {
    fs = { existsSync, mkdirSync, rmSync },
    git = realGit,
    home = homedir(),
    stderr = process.stderr,
  } = {},
) {
  const path = worktreePath(mainRoot, handle, { home })
  const cwd = resolve(mainRoot)

  // The escalation lives in removeThroughGit, which the creates' leftover-clearing (in
  // addWorktree) shares — the measurements are up there. What matters here is the
  // consequence: a refusal absorbed instead of escalated is what used to send teardown
  // down the fs sweep and leave a record with no directory, and when that refusal was a
  // LOCK, no prune could clean it up afterwards.
  const removed = removeThroughGit(path, { cwd, git })

  if (fs.existsSync(path)) {
    if (removed.status !== 0) {
      stderr.write(
        `⚠️  worktree: git worktree remove declined ${path} (${firstLine(removed.stderr) || `exit ${removed.status}`}) — deleting the directory\n`,
      )
    }
    fs.rmSync(path, { recursive: true, force: true })
  }

  // AFTER the sweep, never before it. `git worktree prune` only drops records whose
  // directory is MISSING: MEASURED on git 2.50.1, a prune run while the directory is
  // still there leaves both registrations standing, and the same prune after the
  // directory is deleted leaves one. Running it first would therefore find nothing in
  // exactly the case that needs it, and the record would outlive the sweep for the next
  // create to trip over. (The exit code and the empty output say nothing either way —
  // the plain prune this runs is silent in BOTH cases, and `prune -v` is the spelling
  // that reports `Removing worktrees/issue-98: gitdir file points to non-existent
  // location`. The registrations are what was measured.)
  git(['worktree', 'prune'], { cwd })
  return true
}

// Which checkout, if any, has `ref` checked out. Parsed from `git worktree list
// --porcelain`, whose records are blank-line separated and whose lines are `worktree
// <path>`, `HEAD <sha>`, and then either `branch <ref>` or `detached`. MEASURED on git
// 2.50.1 (Apple Git-155), a main tree on `main` plus one detached worktree:
//
//   worktree /private/var/.../work
//   HEAD 0d715465e2ff2d0c34b1e1ea1e0f0f1e2c9a7b41
//   branch refs/heads/main
//
//   worktree /private/var/.../work/.ralph/worktrees/task-1
//   HEAD 65e4ede0a9f0a1f1a4b0f5c2d3e4f5a6b7c8d9e0
//   detached
//
// `null` means nobody: no worktree in this repository has that ref checked out, so the
// ref is a file nothing is sitting on.
//
// WHAT THE `resolve()` BELOW DOES AND DOES NOT DO. It is `.`/`..`/`//`/trailing-slash
// normalization on a string that crossed a process boundary — nothing more. It is NOT
// what makes the caller's root and git's record comparable: git already prints one
// canonical spelling per worktree (absolute, and with every symlink in the path already
// resolved — MEASURED on git 2.50.1 in this very repo, and by
// lib/worktree.advance.qa.test.js against a repo reached through a symlink), so there is
// no second spelling of the SAME path for it to fold. The one mismatch that does happen
// is a caller spelling its own root through a symlink, and resolve() cannot fix that —
// which is why it is a pinned `other-worktree` park rather than a fast-forward. Kept
// anyway, as cheap normalization of untrusted text: deleting it changes no test.
function branchHolder(list, ref) {
  let path = null
  for (const line of String(list ?? '').split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
    else if (line.startsWith('branch ') && line.slice('branch '.length).trim() === ref) {
      return path ? resolve(path) : null
    }
  }
  return null
}

/**
 * Move `branch` to whatever the worktree for `handle` has committed — or, when that
 * cannot be done without touching a tree a human is working in, park the commit on
 * `ralph/<handle>` and say so. Returns a structured verdict, never throws for a park:
 *
 *   { action: 'up-to-date' | 'advanced' | 'parked', sha, branch, parkedOn, reason?, via? }
 *
 * WHY THIS IS A TABLE AND NOT A COMMAND (#221). Folder mode's agent commits on a
 * detached HEAD, so something has to move the branch afterwards, and the one thing
 * #217 forbids is disturbing the user's own checkout. The four states differ in what is
 * SAFE, not in what git will accept:
 *
 *   branch checked out nowhere  → write the ref. Nothing is sitting on it, so no index
 *                                 and no working tree can disagree with the new value.
 *   checked out here and clean  → `merge --ff-only`, cwd = the main root. This updates
 *                                 that tree, which is the point: it is a fast-forward
 *                                 of the branch it is already on, and HEAD keeps
 *                                 pointing at the same ref (no checkout, no switch).
 *   checked out here and dirty  → PARK. `update-ref` would exit 0 and leave the human's
 *                                 tree reading `D  agent-file.txt` — MEASURED on git
 *                                 2.50.1 (Apple Git-155): the ref moves under a live
 *                                 index, so their status now claims they staged the
 *                                 deletion of a file they have never seen. And
 *                                 `merge --ff-only` there often SUCCEEDS (it only
 *                                 refuses when the incoming diff touches a path the
 *                                 tree has dirty), which makes it a coin toss over
 *                                 someone else's uncommitted work rather than a rule.
 *   checked out in another tree → PARK. Same argument; that tree is not ours either.
 *
 * `diverged` IS THE FIFTH STATE and it precedes all four: if the branch tip is not an
 * ancestor of the worktree's HEAD there is no fast-forward to be had. MEASURED on git
 * 2.50.1 (Apple Git-155): `merge-base --is-ancestor <tip> <sha>` exits 1 and
 * `merge --ff-only <sha>` then fails `fatal: Not possible to fast-forward, aborting.`
 * — so the ancestor test reaches the same verdict for one cheap spawn and without
 * asking a repository to attempt anything.
 *
 * ITS NAME IS WIDER THAN ITS MEANING, and deliberately left that way. `--is-ancestor`
 * answers the same 1 for three shapes, and all three take this arm: a real divergence, a
 * commit that shares no history with the branch at all, and a worktree HEAD that is
 * merely BEHIND the tip — the branch moved forward while the agent worked and the agent
 * committed nothing new, so its HEAD is an ANCESTOR of the tip and the branch already
 * contains it. That last one parks a `ralph/<handle>` nothing needed. It is noise, never a
 * loss, and separating it out costs a second `--is-ancestor` spawn on every run; the
 * reason string is also pinned by lib/worktree.advance.qa.test.js, which documents it as
 * accepted rather than ideal.
 *
 * A PARK IS NOT A FAILURE. The task's own verdict is the terminal directory of its task
 * file, and it has already been decided by the time this runs; a branch ralph could not
 * advance is not a task ralph failed. So every park path returns normally, and the CLI
 * below exits 0 on it. What a park owes the human is FINDABILITY, which is why the
 * warning always names both the park branch and the sha — and still names the sha when
 * even the park write failed, since at that point it is the only handle left on the
 * commit.
 *
 * WHICH IS ALSO WHY EVERY UNCERTAIN ANSWER PARKS. A read that failed is never taken as
 * its own good news: an unreadable `git worktree list` does not mean nobody holds the
 * branch, and an unreadable `git status` does not mean the tree is clean. Once the agent
 * has committed, the only outcomes left are "the branch moved" and "the commit has a
 * name" — anything else strands work in a directory the next run for the same handle
 * force-removes.
 *
 * It DOES throw for an invocation that cannot mean anything: an unsafe root, a handle or
 * branch that is not a usable name, a worktree that is not there, a HEAD that cannot be
 * read, a `branch` that is not a local branch at all. Those are bugs in the caller rather
 * than outcomes of a run. Only the last of them can have an agent's commit behind it —
 * discovering it needs a repository, not just the arguments — so that one writes the park
 * ref before it throws and names it in the message. The commit keeps a name either way;
 * what the non-zero exit says is that the configuration was wrong, not the task.
 */
export function advanceOrPark(
  mainRoot,
  handle,
  branch,
  { fs = { existsSync }, git = realGit, home = homedir(), stderr = process.stderr } = {},
) {
  // Derivation and name checks first, so nothing unsafe reaches a git argv.
  const path = worktreePath(mainRoot, handle, { home })
  const cwd = resolve(mainRoot)
  const ref = `refs/heads/${assertSafeRef(branch)}`
  const parkBranch = `ralph/${handle}`

  if (!fs.existsSync(path)) {
    throw new Error(
      `worktree: no worktree at ${path} — there is no commit to advance ${branch} to`,
    )
  }

  // What the agent left in the tree it was given. cwd is the WORKTREE for this one call
  // only — it is the one question about the worktree's own HEAD.
  const head = git(['rev-parse', 'HEAD'], { cwd: path })
  if (head.status !== 0) {
    throw new Error(
      `worktree: cannot read HEAD in ${path} (${firstLine(head.stderr) || `exit ${head.status}`})`,
    )
  }
  const sha = firstLine(head.stdout)

  // Give the commit a name of its own. `branch -f` rather than `update-ref`: it is
  // per-handle and idempotent, so a second rescue for the same task overwrites its own
  // previous one instead of failing on it.
  //
  // Both of these are spelled BEFORE the branch is even resolved, because from here on the
  // agent's commit exists: every way of failing to move the branch has to write this ref
  // first — the park below, and the one refusal that still throws — or the commit is
  // reachable from nothing but a detached HEAD in a directory the next run for the same
  // handle force-removes.
  const rescue = () => git(['branch', '-f', parkBranch, sha], { cwd })

  // Park: rescue the commit, then tell the human where it went.
  const park = (reason, refusal) => {
    const wrote = rescue()
    const parkedOn = wrote.status === 0 ? parkBranch : null
    const why = refusal
      ? `${reason}: ${firstLine(refusal.stderr) || `exit ${refusal.status}`}`
      : reason
    stderr.write(
      parkedOn
        ? `⚠️  worktree: could not advance ${branch} (${why}) — commit ${sha} is parked on ${parkedOn}\n`
        : `⚠️  worktree: could not advance ${branch} (${why}), and could not park it either (${firstLine(wrote.stderr) || `exit ${wrote.status}`}) — commit ${sha} is in ${path}\n`,
    )
    return { action: 'parked', sha, branch, parkedOn, reason }
  }

  // A BRANCH THAT DOES NOT RESOLVE gets both halves: the commit is given a name, and then
  // the invocation is still refused. It is the one broken invocation that is only
  // discovered AFTER a commit exists, so neither half alone is enough — a bare throw
  // strands the work, and a bare park would report a base no `advance` can ever move (a
  // tag, `HEAD`, a raw sha) as an ordinary outcome of a run. createDetachedWorktree takes
  // nothing but a local branch, so from the loop this is unreachable; what is left is a
  // caller advancing something that was never a branch, which is a misconfiguration.
  //
  // No refusal is quoted for the read: `--verify --quiet` is silent by design, so there
  // is nothing git said to pass on. The rescue's own failure IS quoted, because then the
  // sha in this message is the only handle left on the commit.
  const tipRead = git(['rev-parse', '--verify', '--quiet', ref], { cwd })
  if (tipRead.status !== 0) {
    const rescued = rescue()
    throw new Error(
      rescued.status === 0
        ? `worktree: '${branch}' is not a local branch, so there is nothing to advance — commit ${sha} is parked on ${parkBranch}`
        : `worktree: '${branch}' is not a local branch, so there is nothing to advance, and commit ${sha} could not be parked on ${parkBranch} either (${firstLine(rescued.stderr) || `exit ${rescued.status}`}) — it is in ${path}`,
    )
  }
  const tip = firstLine(tipRead.stdout)

  // The ordinary shape of a folder task that only moved files around: the agent
  // committed nothing, so there is nothing to move and nothing to say. TWO PATHS REACH
  // IT, and the second is why this arm sits ahead of every holder question: an agent that
  // disobeyed the prompt and checked `branch` out in its own tree committed ON the branch,
  // so its commit IS the tip and nothing needs moving. That agent's own work is safe; the
  // cost is that its tree now holds `branch`, which parks every LATER task with
  // `other-worktree` until a human unpicks it.
  if (sha === tip) return { action: 'up-to-date', sha, branch, parkedOn: null }

  if (git(['merge-base', '--is-ancestor', tip, sha], { cwd }).status !== 0) {
    return park('diverged')
  }

  // FAIL CLOSED on an unreadable list, for the same reason a failed `status` read counts
  // as dirt below: an answer that never arrived is not an answer. This one parse selects
  // between three very different writes, and its `null` — "nobody holds the branch" — is
  // the ONE arm that moves a ref without asking any tree about its state, so a list that
  // came back empty because the command FAILED would move the branch under a live,
  // possibly dirty checkout. An empty list that git reported successfully still means
  // nobody, which is why the exit code is what is tested and not the text.
  const listed = git(['worktree', 'list', '--porcelain'], { cwd })
  if (listed.status !== 0) return park('holder-unknown', listed)
  const holder = branchHolder(listed.stdout, ref)

  if (holder === null) {
    // The old value is passed as the compare-and-swap argument, so a concurrent writer's
    // commit survives instead of being overwritten. RALPH is the side that loses the race:
    // git refuses ITS write, and the refusal below turns that into a `ref-write-refused`
    // park, so the branch keeps whatever the other writer put there and this commit is
    // still reachable from `ralph/<handle>`. MEASURED on git 2.50.1 (Apple Git-155) with a
    // stale old value: exit 128, `fatal: update_ref failed for ref 'refs/heads/main':
    // cannot lock ref 'refs/heads/main': is at <b> but expected <a>`.
    const wrote = git(['update-ref', ref, sha, tip], { cwd })
    if (wrote.status !== 0) return park('ref-write-refused', wrote)
    return { action: 'advanced', via: 'update-ref', sha, branch, parkedOn: null }
  }

  if (holder !== cwd) return park('other-worktree')

  // Ralph's own conservatism, not git's: ANY dirt in the human's tree is a park, and a
  // status read that itself failed counts as dirt (we did not learn that it was clean).
  const dirt = git(['status', '--porcelain'], { cwd })
  if (dirt.status !== 0 || String(dirt.stdout).trim() !== '') return park('dirty-main-tree')

  const merged = git(['merge', '--ff-only', sha], { cwd })
  if (merged.status !== 0) return park('ff-refused', merged)
  return { action: 'advanced', via: 'fast-forward', sha, branch, parkedOn: null }
}

// --- CLI entrypoint (for templates/ralph.sh) --------------------------------
// `path` is the verb the loop uses to learn where a worktree WILL be (for the
// PROJECT_ROOT placeholder and the agent's cwd) without creating anything.
//
// `advance` (#221) is the only verb whose interesting outcome is not an exit code: a
// park is a normal 0, because the task's verdict was already decided and a branch that
// could not be advanced is not a task that failed. The library writes the warning; this
// prints one line about a branch that DID move, and stays silent when nothing had to.
// A base that is not a local branch at all is the exception, and it is not a park: it
// reaches the catch below like any other broken invocation and exits 1 — with the commit
// already rescued onto `ralph/<handle>` and named in that one line.
//
// The verb table is spelled ONCE and the usage line is rendered from it, so the sentence
// a human reads cannot fall behind the set the switch accepts — which is the failure mode
// a second hand-written list has: a verb that works but is undocumented, or documented and
// rejected. `NEEDS_REF` is the subset that cannot guess its fourth argument.
const CLI_NEEDS_REF = ['create', 'create-detached', 'advance']
const CLI_VERBS = ['path', 'create', 'create-detached', 'advance', 'remove']
function runCli(argv) {
  const [cmd, mainRoot, handle, baseRef] = argv
  const usage = () => {
    process.stderr.write(
      `usage: worktree.js <${CLI_VERBS.join('|')}> <mainRoot> <handle> [baseRef|branch]\n`,
    )
    return 2
  }
  if (!CLI_VERBS.includes(cmd)) return usage()
  if (!mainRoot || !handle) return usage()
  if (CLI_NEEDS_REF.includes(cmd) && !baseRef) return usage()
  try {
    switch (cmd) {
      case 'path':
        process.stdout.write(`${worktreePath(mainRoot, handle)}\n`)
        return 0
      case 'create':
        process.stdout.write(`${createWorktree(mainRoot, handle, baseRef)}\n`)
        return 0
      case 'create-detached':
        process.stdout.write(`${createDetachedWorktree(mainRoot, handle, baseRef)}\n`)
        return 0
      case 'advance': {
        const res = advanceOrPark(mainRoot, handle, baseRef)
        if (res.action === 'advanced') {
          process.stdout.write(`✅ ${baseRef} advanced to ${res.sha} (${res.via})\n`)
        }
        return 0
      }
      case 'remove':
        removeWorktree(mainRoot, handle)
        return 0
    }
  } catch (e) {
    // One line, no stack — same rule as lib/run-state.js's CLI: this prints into the
    // tmux pane a human is watching, and a refusal's whole value is its message.
    process.stderr.write(`worktree.js: ${cmd} failed (${e?.message ?? 'unknown error'})\n`)
    return 1
  }
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  process.exit(runCli(process.argv.slice(2)))
}
