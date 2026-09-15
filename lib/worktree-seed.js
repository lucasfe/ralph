// #219 — the seed step of the per-issue worktree: the few GITIGNORED files a project's
// tests need, copied from the main root into a tree git has just made.
//
// WHY A WORKTREE NEEDS SEEDING AT ALL
// `git worktree add` produces a checkout, so what lands in it is what is TRACKED.
// MEASURED on git 2.50.1 (Apple Git-155), in a repo whose .gitignore lists `.env.local`
// and `node_modules/` and which has both on disk: the new tree holds `.git`,
// `.gitignore` and `README.md`, and neither ignored path. The same thing is measured
// through the loop itself in test/loop.worktree.test.js, where the agent's own `ls -a`
// inside the worktree reported exactly `.  ..  .git  .gitignore  README.md` before this
// module existed. So an agent that woke in a worktree had no `.env.local` — the common
// case — and no untracked `.mcp.json`, and any test that reads one failed there for a
// reason that has nothing to do with the issue being worked.
//
// WHY IT IS ITS OWN MODULE, and not more of lib/worktree.js
// That file is the single owner of every GIT fact — the derivation, the refusals, the
// escalating remove, the prune ordering — and it is already 400+ lines of measured
// commentary about git's behaviour. Nothing here asks git anything: this is a list
// parsed out of one environment variable, a path guard, and a copy. The two halves
// share only the moment they run in, which is one call, and keeping them apart is what
// lets the selection rules be driven with no git double in sight
// (lib/worktree-seed.test.js does not import worktree.js at all).
//
// WHY `node_modules` IS NOT ON THE LIST — AND CANNOT BE PUT ON IT
// A copy would be slow and a SYMLINK would be worse: the whole point of a per-issue
// worktree is that a branch which bumps a dependency cannot mutate the tree the user is
// developing in, and a linked `node_modules` hands it exactly that. So the seed step
// copies REGULAR FILES only — a directory entry is refused whatever the configuration
// says, which is the guard that makes `node_modules` unseedable rather than merely
// absent from the default. What pays for that is step 0 of the orchestrator prompt
// (`templates/prompt-team.md:59`, "run `{{INSTALL_CMD}}`"), which the agent runs in its
// own cwd — the worktree. A per-issue install is the accepted cost of the isolation.
//
// WHY A BAD ENTRY WARNS INSTEAD OF THROWING
// templates/ralph.sh turns a throw out of the create path into `break` (see the "ABORT,
// DON'T SKIP" block beside its `worktree.js create` call), which is the right answer for
// a tree git would not make and the wrong one for a typo in a config file: it would abort
// every future run of the loop, on every issue, until a human edited that line. A refused
// entry therefore costs its own file and nothing else, and says so on stderr naming the
// value — the same "a refusal always names the offending value" rule lib/worktree.js
// follows, minus the throw.
//
// Seams, matching lib/worktree.js's: `fs` (node:fs, or a memfs Volume in the tests — the
// verbs it needs are exported as SEED_FS below, so the caller that passes its own object
// through cannot drift away from them), `processEnv` (the bag the knob is read from — the
// loop SOURCES ralph.config.sh with `set -a`, so the value reaches this process as an
// ordinary environment variable) and `stderr`.
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The one knob, declared in templates/ralph.config.sh and exported by the loop. */
export const SEED_FILES_VAR = 'RALPH_WORKTREE_SEED_FILES'

/**
 * What an UNSET knob means — the two files Ralph itself already knows about.
 *
 * Deliberately a second copy of the value templates/ralph.config.sh ships, and the
 * duplication is the same one RALPH_BANNER's `full` has (`DEFAULT_BANNER_MODE` in
 * lib/banner-mode.js beside `RALPH_BANNER="full"` in the template): a repo whose
 * ralph.config.sh was generated before this knob existed assigns nothing, and it must
 * still get the seeding rather than nothing at all.
 */
export const DEFAULT_SEED_FILES = Object.freeze(['.env.local', '.mcp.json'])

// Entries are separated by whitespace OR commas, and both are accepted on purpose.
// The config file's one syntax rule means a list with spaces in it has to be quoted
// (`RALPH_WORKTREE_SEED_FILES=".env.local .mcp.json"`), and a user who reaches for the
// other spelling instead gets no warning from anywhere: `.env.local,.mcp.json` read as
// ONE entry is a filename no project has, and an entry that does not exist is a silent
// no-op by design — so the whole feature would quietly do nothing. The disclosed limit
// is the mirror image: a filename containing a comma or a blank cannot be named here.
const ENTRY_SEPARATORS = /[\s,]+/

/**
 * Every fs verb this module calls, as ONE seam.
 *
 * Exported because lib/worktree.js passes its own `fs` object straight through to
 * seedWorktree, so the two have to agree about what the seed step needs — and a list of
 * verbs copied into that file is a list that can drift out of this one silently. Two of
 * them are the reason that matters: `lstatSync` and `unlinkSync` ARE the write-through
 * guard below, and an `fs` without them cannot tell a symlink at the destination from a
 * regular file there. So createWorktree spreads this object instead of enumerating verbs
 * (`fs = { ...SEED_FS, rmSync }`, lib/worktree.js:219) and the guard cannot be dropped from
 * the live path by an edit that forgets a name.
 */
export const SEED_FS = Object.freeze({
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  statSync,
  unlinkSync,
})

// `copyFileSync`'s "fail if the destination exists" flag, which is what stands in for the
// guard when the injected `fs` cannot lstat (see the `guarded` branch in seedWorktree).
// WHAT IT DOES IS NOT THE SAME ON THE TWO FILESYSTEMS THIS MODULE RUNS ON, so both were
// MEASURED over the same five destination shapes — node v20.20.2 / darwin 25.6.0, and memfs
// 4.57.2, the version in node_modules. Real fs throws EEXIST for all five: a regular file, a
// directory, a symlink to a file, a symlink to a directory, and a DANGLING symlink. memfs
// throws for the first four and, on the fifth, REPLACES the dangling link with a regular file
// instead of failing — its existence check follows the link, so a link pointing at nothing
// looks to it like an empty destination. So neither "it always throws" nor "it can only fail"
// is true of this flag, and this comment used to claim both.
//
// WHAT HOLDS ON BOTH is the property the guard actually needs: no write goes THROUGH the
// link. In every link case measured, on either filesystem, the target's bytes are untouched
// and a dangling target is never created — the link is either refused (real fs, all five;
// memfs, the four non-dangling) or unlinked and replaced (memfs, dangling). The divergent
// cell is pinned by a test rather than asserted here: lib/worktree-seed.test.js, 'replaces a
// DANGLING link on memfs rather than writing through it'.
const NO_CLOBBER = constants.COPYFILE_EXCL

const refuse = (message) => {
  throw new Error(`refusing ${message}`)
}

// This step reads from the main root and writes into the worktree, so both have to be
// absolute or the paths resolve against whatever cwd the caller happened to have. It is
// NOT a second copy of lib/worktree.js's assertSafeRoot: the `/`, `$HOME` and `.git/`
// policy lives there, runs before createWorktree gets as far as this call, and is the
// only place that decides what a usable project root is.
function assertAbsolute(path, role) {
  if (typeof path !== 'string' || path.trim() === '') {
    refuse(`to seed with an empty ${role} (got ${JSON.stringify(path)})`)
  }
  if (!isAbsolute(path)) {
    refuse(`to seed with the relative ${role} '${path}' — it would resolve against the caller's cwd`)
  }
  return resolve(path)
}

/**
 * Remove the destination when — and only when — it is a SYMLINK, and report whether it was.
 *
 * REPLACE AND SAY SO, rather than refuse and skip. Skipping would leave the agent holding
 * the checkout's link, which is the write-through into the main root the whole step
 * promises not to have — strictly the worse of the two outcomes, and a silent one. The tree
 * is removed when the iteration ends, so replacing a checked-out link costs nothing that
 * outlives the run, and the warning names the entry so a repository that really does track
 * a link there can see why the worktree holds a copy instead.
 *
 * `unlinkSync` and not `rmSync`, MEASURED on both fs implementations this module runs
 * against: `unlinkSync` takes the LINK and leaves its target alone on node v20.20.2 and on
 * memfs alike, while `rmSync(dest, { force: true })` agrees only on real fs — on memfs it
 * follows the link and deletes the TARGET, which on the very shape this guard exists for is
 * the main-root file the guard is protecting.
 *
 * A REGULAR file at the destination is left to `copyFileSync`, which overwrites it in
 * place: laying the user's working copy over what the checkout produced is what the step is
 * for, and a tracked name on the list is a documented use of it.
 *
 * The lstat has a try of its own because the failures it can have all mean "nothing a copy
 * needs to worry about is there": ENOENT for the ordinary empty destination, and ENOTDIR
 * when something ABOVE the destination is a file rather than a directory — MEASURED on node
 * v20.20.2 and on memfs 4, `lstatSync('<a file>/x')` is ENOTDIR on both. What that try does
 * NOT stand in for is an `fs` with no `lstatSync` at all: that question is asked once per
 * entry, before anything is written, because a caller who cannot answer it cannot have this
 * guard and must not be handed a copy that behaves as though it does.
 */
function unlinkIfSymlink(fs, dest) {
  let linked = false
  try {
    linked = fs.lstatSync(dest)?.isSymbolicLink() === true
  } catch {
    return false
  }
  if (!linked) return false
  fs.unlinkSync(dest)
  return true
}

/**
 * The first DIRECTORY component of `parts` inside `tree` that is a symlink, or null.
 *
 * The half of "copied, never linked" that lstatting the destination alone does not cover,
 * and the more expensive half. MEASURED on git 2.50.1 (Apple Git-155): `git worktree add`
 * checks out every symlink the repository TRACKS — a `.config -> realdir` and a
 * `tracked-link -> ../victim.txt` pointing OUT of the tree both arrive as links in the new
 * tree — so a nested entry (`.config/local.json`) whose first segment is one of them has
 * `join(tree, entry)` name a path outside the tree, and neither call that follows notices.
 * MEASURED on node v20.20.2 / darwin 25.6.0 and on memfs 4 alike: `mkdirSync(<link to a
 * directory>, { recursive: true })` succeeds silently, and `mkdirSync(<link>/sub, {
 * recursive: true })` creates `sub` INSIDE THE LINK'S TARGET. That is why this walk runs
 * BEFORE the mkdir rather than after it — by then the write has already left the tree.
 *
 * ONLY THE COMPONENTS THE ENTRY NAMES are walked, never the ones the tree path is made of,
 * and that is what makes this cheaper than canonicalising the destination. The tree path
 * comes from lib/worktree.js's derivation rather than from the knob, and on this platform it
 * legitimately contains links: MEASURED, for an ordinary directory `<mkdtemp>/repo/.ralph/
 * worktrees/issue-7/.config`, `realpathSync` answers `/private/var/…` while the tree is
 * spelled `/var/…`, so `realpathSync(dirname(dest)).startsWith(tree + sep)` is FALSE for a
 * destination that never left the tree. Canonicalising both sides would fix that and add a
 * second spelling of every path to reason about; asking each component the entry adds
 * whether it is a link answers a cheaper and STRICTER question instead — did anything under
 * the tree redirect the write at all? Stricter because a link that stays inside the tree is
 * refused too (MEASURED: with `.config` a link to `<tree>/real`, the entry is refused and
 * `<tree>/real/local.json` is not created), and where the link points is deliberately not
 * asked: answering it is the canonicalisation this avoids, and the cost of not answering it
 * is one entry that a rename in the repository would fix. The refusal message therefore says
 * the copy would not go where the entry NAMES, which is true of both directions.
 *
 * A linked component is REFUSED rather than replaced, the opposite of what the leaf gets,
 * and the asymmetry is deliberate: the leaf is where the copy goes and a regular file is
 * exactly what belongs there, while a linked directory is the checkout's own layout for a
 * whole subtree, and unlinking it would take tracked content out of the tree to seed one
 * file.
 */
function linkedComponent(fs, tree, parts) {
  let at = tree
  for (const part of parts.slice(0, -1)) {
    at = join(at, part)
    let stat
    try {
      stat = fs.lstatSync(at)
    } catch {
      // ENOENT: this component is not there, so nothing below it can be either, and the
      // recursive mkdir will make real directories for the rest of them. ENOTDIR: something
      // above it is a file — the mkdir fails on that and the entry is warned about there.
      return null
    }
    if (stat?.isSymbolicLink() === true) return at
  }
  return null
}

/**
 * The configured list, in the order it was written.
 *
 * Unset means DEFAULT_SEED_FILES; an empty (or all-whitespace) value means seed
 * NOTHING. Those two are different answers to different questions and the shell keeps
 * them apart for us: `set -a` plus `NAME=""` exports the empty string, while a file that
 * never mentions the name exports nothing — the distinction lib/parse-config-var.js's
 * `configAssignsVar` exists for, measured at the top of that file.
 */
export function seedList({ processEnv = process.env } = {}) {
  const raw = processEnv?.[SEED_FILES_VAR]
  if (raw === undefined || raw === null) return [...DEFAULT_SEED_FILES]
  return String(raw)
    .split(ENTRY_SEPARATORS)
    .filter((entry) => entry !== '')
}

/**
 * Copy every configured seed file that exists in `mainRoot` into `worktree`, and return
 * the entries actually copied.
 *
 * Never throws for anything about one ENTRY — a missing file is a silent no-op, and a
 * refused, unstattable or unreadable one is a warning on stderr — because a seed step that
 * can abort is a seed step that can deadlock the queue (see the header). Every fs call about
 * an entry that CAN throw is therefore inside the guard, the stat included. The one left
 * outside it cannot: MEASURED on node v20.20.2, for a file whose parent directory is chmod
 * 000, `existsSync` answers FALSE while `statSync` on the same path throws EACCES — which is
 * both why the existence check needs no guard and why the stat does. The two things this
 * function does throw for are its own preconditions: a root or a worktree path that is not
 * absolute.
 *
 * An entry is refused, by name on stderr, when it is absolute, when it resolves outside the
 * main root, when its destination is not inside the worktree, when it names `.git` or
 * anything under it, when it is not a regular file, or when the copy would have to go
 * THROUGH a symlink — at the destination itself when this `fs` cannot lstat, or, WHEN IT
 * CAN, at any directory component the entry adds inside the tree.
 *
 * That second clause is scoped, and the scope is not a hedge: an `fs` with no `lstatSync`
 * cannot walk the components at all, so the directory-component half of the guard is simply
 * absent for one. MEASURED, real fs, `fs = { existsSync, statSync, mkdirSync, copyFileSync }`,
 * entry `.config/local.json`, `.config` checked out as a link out of the tree: this function
 * returns `['.config/local.json']`, warns NOTHING, and writes into the MAIN ROOT. The full
 * seam on the same fixture returns `[]`, warns once naming `.config`, and leaves the main
 * root untouched. See the no-lstat branch below for why that gap has no lstat-free fix and
 * why every seam that ships carries the verb.
 */
export function seedWorktree(
  mainRoot,
  worktree,
  { fs = SEED_FS, processEnv = process.env, stderr = process.stderr } = {},
) {
  const root = assertAbsolute(mainRoot, 'project root')
  const tree = assertAbsolute(worktree, 'worktree path')
  // `resolve()` drops a trailing separator everywhere except at the filesystem root, so
  // the prefix has to be built rather than concatenated — otherwise a root of `/` would
  // compare against `//` and refuse everything.
  const inside = root.endsWith(sep) ? root : root + sep
  const warn = (message) => stderr.write(`⚠️  worktree: ${message}\n`)

  const copied = []
  for (const entry of seedList({ processEnv })) {
    // An absolute entry is refused before it is resolved, because `resolve(root, '/x')`
    // IS `/x` — the join a relative entry gets is no boundary at all for one of these.
    if (isAbsolute(entry)) {
      warn(
        `refusing to seed the absolute path '${entry}' — a seed entry names a file inside the project root`,
      )
      continue
    }
    const src = resolve(root, entry)
    if (!src.startsWith(inside)) {
      warn(`refusing to seed '${entry}' — it resolves to ${src}, outside the project root`)
      continue
    }
    // THE DESTINATION GETS THE SAME QUESTION THE SOURCE GOT, because the test above is
    // vacuous for one root: `resolve('/', '../x')` is `/x`, which IS inside `/`, while
    // `join(<tree>, '../x')` is not inside the tree. Cheap, and it makes "everything this
    // step writes is under the worktree" true of the path rather than of the argument.
    const dest = join(tree, entry)
    const within = relative(tree, dest)
    // `..` is compared as a COMPONENT and not as a prefix: `..foo` is a legal filename, and
    // `startsWith('..')` would refuse it for the two dots it begins with.
    if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      warn(`refusing to seed '${entry}' — its destination ${dest} is not inside the worktree`)
      continue
    }
    const parts = within.split(sep)
    // `.git` IS NOT A SEED DESTINATION, whatever the list says. In a worktree it is the
    // gitdir POINTER `git worktree add` wrote (a FILE holding `gitdir:
    // <main checkout>/.git/worktrees/<handle>`), so copying the main checkout's `.git`
    // metadata over it, or making a directory where it is, would leave every git command the
    // agent runs reading the USER'S checkout — an outcome that shows up nowhere near this
    // module. A refusal that names the entry is a better answer than the EEXIST or ENOTDIR
    // the write would otherwise raise (MEASURED, both: real fs fails the mkdir with EEXIST,
    // memfs lets the mkdir pass and fails the copy with ENOTDIR). The check is on a path
    // SEGMENT, so `.gitignore` — an ordinary tracked file — is untouched by it.
    if (parts[0] === '.git') {
      warn(
        `refusing to seed '${entry}' — nothing under '.git' is seedable: a worktree's .git is ` +
          `the gitdir pointer git wrote, and replacing it would point the agent's git at the ` +
          `main checkout`,
      )
      continue
    }
    // ABSENT IS THE ORDINARY CASE, so it is silent: the default list names two files and
    // most repos have one of them, and a line of warning per iteration about the other
    // would be noise about nothing being wrong.
    if (!fs.existsSync(src)) continue
    try {
      // THE STAT IS INSIDE THE TRY, and that placement is the whole of it. `existsSync`
      // followed by `statSync` is a time-of-check/time-of-use pair, and the realistic
      // version needs no race at all: a seed file on a network mount or an external volume
      // can answer the first call and fail the second with EIO or EPERM. A throw escaping
      // here is not a lost file — templates/ralph.sh turns it into `break` (see the
      // header), so it is the per-issue deadlock this module exists not to have.
      if (!fs.statSync(src).isFile()) {
        warn(
          `refusing to seed '${entry}' — it is not a regular file, and the seed step never ` +
            `copies or links a directory (node_modules is installed in the worktree instead)`,
        )
        continue
      }
      // CAN THIS `fs` TELL A LINK FROM A FILE? Asked once, before anything is written,
      // because the answer changes what a safe copy IS — and asked about the verb rather
      // than inferred from a failure, so that a double narrower than SEED_FS costs the
      // ENTRY and never the promise. Only `lstatSync` is checked: a missing `unlinkSync`
      // throws where it is called, which the catch below turns into the same per-entry
      // warning (MEASURED, `fs.unlinkSync is not a function`).
      const guarded = typeof fs.lstatSync === 'function'
      // A DIRECTORY COMPONENT THE CHECKOUT MADE A LINK redirects the whole write out of the
      // tree, and it has to be caught before the mkdir — see linkedComponent, which measures
      // why.
      if (guarded) {
        const linked = linkedComponent(fs, tree, parts)
        if (linked) {
          warn(
            `refusing to seed '${entry}' — '${relative(tree, linked)}' in the worktree is a ` +
              `symlink, so the copy would not go where the entry names; the seed step never ` +
              `writes through a link`,
          )
          continue
        }
      }
      // A nested entry (`.config/local.json`) may name a directory the checkout does not
      // have, because the seed file is the only thing in it that is not ignored.
      fs.mkdirSync(dirname(dest), { recursive: true })
      if (guarded) {
        // A LINK AT THE DESTINATION IS REPLACED, NOT WRITTEN THROUGH — the other end of the
        // "copied, never linked" promise, and the one `copyFileSync` cannot keep by itself.
        // MEASURED on node v20.20.2 / darwin 25.6.0 and on memfs alike: copying onto a
        // symlink writes the LINK'S TARGET and leaves the link standing. A repository that
        // TRACKS a symlink at a seeded name has `git worktree add` check that link out into
        // exactly the path this step writes, so `.env.local -> ../../../victim.txt` would
        // have the seed step overwrite a file in the user's main root and hand the agent a
        // link back into it.
        if (unlinkIfSymlink(fs, dest)) {
          warn(
            `replaced the symlink the checkout put at '${entry}' with a copy — a seeded file ` +
              `is always a regular file of the worktree's own`,
          )
        }
        // COPY, NEVER LINK. MEASURED on node v20.20.2: `copyFileSync` writes a regular file
        // even when the SOURCE is a symlink (`lstatSync(dest).isSymbolicLink()` is false),
        // and appending to the destination afterwards leaves the source byte-identical —
        // which is the property the isolation rests on. It also refuses the two cases this
        // loop has already excluded above, so neither can arrive here as a surprise: a
        // missing source throws ENOENT and a directory source throws ENOTSUP (measured on
        // darwin 25.6.0).
        fs.copyFileSync(src, dest)
      } else {
        // NO LSTAT, SO NOTHING MAY BE OVERWRITTEN AT ALL. An `fs` this narrow cannot be
        // asked what is at the destination, so the copy is made with the flag that refuses
        // to clobber anything (see NO_CLOBBER's measurements) and an occupied destination
        // costs the entry instead of risking a write through a link out of the tree. The
        // empty destination — every ordinary one, since the tree is a fresh checkout and
        // `.gitignore` is why the file is missing from it — still gets its copy, and gets it
        // silently: with nothing there, there is no link to write through.
        //
        // What this does NOT recover is linkedComponent's half of the guard, which has no
        // lstat-free equivalent: `existsSync` and `statSync` both FOLLOW links, which is
        // measured by two tests that depend on it (a dangling source link is a silent no-op
        // because `existsSync` answers false through it, and a `node_modules` SYMLINK is
        // refused as "not a regular file" because `statSync` answers about its target). So an
        // `fs` without `lstatSync`, plus a nested entry whose directory component the checkout
        // linked, can still write outside the tree. Every seam that ships carries `lstatSync`
        // (SEED_FS, and lib/worktree.js spreads it), which is what keeps that case inside the
        // tests that build their own doubles.
        try {
          fs.copyFileSync(src, dest, NO_CLOBBER)
        } catch (e) {
          if (e?.code !== 'EEXIST') throw e
          warn(
            `refusing to seed '${entry}' — something is already at that path in the worktree ` +
              `and this fs has no lstatSync, so the copy cannot be told apart from a write ` +
              `through a link out of the tree`,
          )
          continue
        }
      }
    } catch (e) {
      // An unreadable source or an unwritable destination is one file lost, not a run.
      warn(`could not seed '${entry}' (${e?.message ?? 'unknown error'}) — carrying on without it`)
      continue
    }
    // AFTER the copy returned, and only there: every refusal above uses `continue`, so an
    // entry in this list is one whose destination is a regular file inside the worktree
    // holding the source's bytes. Nothing reads the return value today — the create path
    // ignores it (lib/worktree.js:347) — which is exactly why it must not be the thing that
    // is loose about what happened.
    copied.push(entry)
  }
  return copied
}
