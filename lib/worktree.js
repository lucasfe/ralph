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
// templates/ralph.sh is generated into consuming repositories, so anything spelled
// there is un-upgradable and untestable. The convention this file follows is already
// established by lib/folder-queue.js, lib/run-state.js and lib/jira-queue.js: the
// domain knowledge is an injectable-dependency ES module, the loop reaches it as
// `node "$RALPH_PKG_DIR/lib/worktree.js" <verb> …`, and the bash holds nothing but
// the call. MEASURED: `grep -vE '^\s*#' templates/ralph.sh | grep 'git worktree'`
// matches nothing — the phrase appears there only inside comments, which is the same
// scope test/loop.worktree.test.js asserts over so it stays that way.
//
// WHY THE REFUSAL GUARDS ARE SO LOUD
// Both verbs ask git to remove a tree — twice, escalating to `--force --force`, via the
// one `removeThroughGit` below — and, when git still declines, fall back to an
// `fs.rmSync(path, { recursive: true, force: true })`. That is a recursive delete aimed
// at a path this module DERIVED, so the derivation is the safety boundary.
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

// A task handle names one directory AND one git branch, and is interpolated into an
// argv this module hands to git. Conservative on purpose: the only handle the loop
// produces today is `issue-<n>`, so anything with a separator, a leading dot (`..`,
// `.git`), a leading dash (which git would read as a flag) or whitespace is a bug in
// the caller rather than an exotic branch name worth supporting.
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
// (a prune will NOT do, as measured above), because templates/ralph.sh turns
// createWorktree's throw into `break`.
//
// ONE HELPER, TWO CALLERS, rather than the same two lines in both: that fact is the
// entire content of both call sites, and a copy is what lets one of them be fixed while
// the other keeps the bug (which is how they came apart in the first place). What the
// callers do NEXT still differs — createWorktree sweeps in silence, removeWorktree
// warns first — so only the escalation is shared. A path git never registered answers
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
export function createWorktree(
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

  // Best-effort: an offline run must still get a worktree, off the last-known
  // origin ref, rather than no worktree at all.
  const fetched = git(['fetch', 'origin', base], { cwd })
  if (fetched.status !== 0) {
    stderr.write(
      `⚠️  worktree: git fetch origin ${base} failed (${firstLine(fetched.stderr) || `exit ${fetched.status}`}) — using the refs already on disk\n`,
    )
  }

  // origin/<base> is the intended base: it is what the PR will target. The local
  // branch is the fallback for a repo whose remote has no such branch yet.
  let start = `origin/${base}`
  if (git(['rev-parse', '--verify', '--quiet', start], { cwd }).status !== 0) {
    stderr.write(`⚠️  worktree: ${start} does not exist — basing ${handle} on local ${base}\n`)
    start = base
    if (git(['rev-parse', '--verify', '--quiet', start], { cwd }).status !== 0) {
      throw new Error(
        `worktree: cannot resolve a base commit for '${base}' — neither origin/${base} nor ${base} exists`,
      )
    }
  }

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

  const added = git(['worktree', 'add', '-B', handle, path, start], { cwd })
  if (added.status !== 0) {
    throw new Error(
      `worktree: git worktree add -B ${handle} ${path} ${start} failed (${firstLine(added.stderr) || `exit ${added.status}`})`,
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
 * (removeThroughGit, shared with createWorktree) and the prune ordering below are the
 * way they are.
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

  // The escalation lives in removeThroughGit, which createWorktree's leftover-clearing
  // shares — the measurements are up there. What matters here is the consequence: a
  // refusal absorbed instead of escalated is what used to send teardown down the fs
  // sweep and leave a record with no directory, and when that refusal was a LOCK, no
  // prune could clean it up afterwards.
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

// --- CLI entrypoint (for templates/ralph.sh) --------------------------------
// `path` is the verb the loop uses to learn where a worktree WILL be (for the
// PROJECT_ROOT placeholder and the agent's cwd) without creating anything.
function runCli(argv) {
  const [cmd, mainRoot, handle, baseRef] = argv
  const usage = () => {
    process.stderr.write(
      'usage: worktree.js <path|create|remove> <mainRoot> <handle> [baseRef]\n',
    )
    return 2
  }
  if (!cmd || !mainRoot || !handle) return usage()
  if (cmd === 'create' && !baseRef) return usage()
  if (!['path', 'create', 'remove'].includes(cmd)) return usage()
  try {
    switch (cmd) {
      case 'path':
        process.stdout.write(`${worktreePath(mainRoot, handle)}\n`)
        return 0
      case 'create':
        process.stdout.write(`${createWorktree(mainRoot, handle, baseRef)}\n`)
        return 0
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
