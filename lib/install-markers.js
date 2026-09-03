import { join, resolve, sep } from 'node:path'

// #201: install-layout recognition, minus everything that can spawn.
//
// WHY THIS IS A FILE. lib/install-target.js answers "how is this copy updated?", and to answer
// it for one layout it has to run a subprocess: a plain global npm install has no directory of
// its own to recognize, so `npm root -g` is the only thing that identifies it. That module
// therefore imports a process runner at module scope — which puts it permanently out of reach
// of `ralph doctor`. lib/commands/doctor.version-line.qa.test.js walks doctor's whole transitive
// import graph and pins the exact set of bare specifiers it may reach, because doctor is the
// command people run when the machine is already broken and possibly offline: no spawner, no
// socket, no exceptions. `ralph doctor` may not import lib/install-target.js at all.
//
// But most of the recognition never needed a subprocess. A Homebrew Cellar, an npx cache, the
// three npm-shaped global stores and a linked install are all decidable from the package root's
// own path plus two `lstat`-shaped probes. So that half lives here, and BOTH consumers read it
// rather than each holding a copy:
//
//   - lib/install-target.js decorates these rows with the command that updates each layout and
//     the query that answers "what is the newest version this channel has?", then matches on
//     its own decorated table using the matcher below. Its exports and its behaviour are
//     unchanged by the extraction.
//   - lib/commands/doctor.js asks `describeInstallChannel` for one sentence, and draws it as the
//     identity box's `channel` row.
//
// THE IMPORT LIST IS THE CONTRACT: `node:path`, and nothing else, ever. Not `node:fs` — which
// doctor is in fact allowed to reach — because the moment a real filesystem default lives here,
// "pure path matching" is a claim about this module rather than a property of it, and the next
// author has one fewer reason to keep it true. `linkSignal` takes its `fs` as an argument, and
// whichever caller has already decided it may touch a disk supplies it. A spawner added here
// fails doctor's import-graph spec, which is the acceptance criterion for the split rather than
// a convention anybody has to remember.
//
// WHAT THIS MODULE CANNOT KNOW, said out loud because the wording depends on it: a plain
// `npm install -g` is invisible to path matching. Its directory is whatever `npm root -g`
// reports, which is a prefix this module has no way to learn. So `describeInstallChannel`
// answers with a HEDGE for every path no marker claimed — see UNPROBED_CHANNEL — and a reader
// of a pasted `ralph doctor` can tell that answer apart from a determination. Reporting `npm`
// there would be inventing the single most load-bearing fact on a bug report about a version.

// #198: the Homebrew formula this package installs as, spelled once so the marker, the channel
// wording and (over in lib/install-target.js) the `brew upgrade` argv and the `brew info` query
// cannot drift apart — a marker matching a formula the argv does not upgrade would answer
// `brew upgrade` for somebody else's Cellar.
//
// scripts/lib/render-homebrew-formula.js, which renders Formula/ralph.rb, holds a second copy of
// this literal, and neither direction of import is available to remove it. This file cannot
// import the renderer: package.json's `files` allow-list publishes `lib/` and not `scripts/`, so
// the import would resolve in a checkout and throw ERR_MODULE_NOT_FOUND in every installed copy.
// And the renderer cannot import this file either — test/homebrew-formula.test.js asserts its
// source contains no `import` and no `require(` at all, because its purity is what makes the
// rendered formula reproducible.
//
// So the duplication is structural, and the mitigation is a test rather than a shared constant:
// test/homebrew-formula.test.js pins the name in the rendered formula against the argv
// `classifyInstall` returns, so renaming one side alone fails there instead of on a user's
// machine, where it would stop the marker matching AND name a formula brew cannot find.
export const HOMEBREW_FORMULA = 'ralph'

// #22, #198, #201: the non-npm global stores — the markers that recognize each one, and the
// words `ralph doctor` reports it with.
//
// The markers are whole path segments that must appear ADJACENT in the install path. Every one
// of them names a directory that only a GLOBAL install lives in: a marker that also matched a
// project-local copy would let lib/install-target.js answer `-g` for a package Ralph is not
// running from, and report success for an update that did not happen.
//
// `store` IS THE ROW'S KEY, and it is the manager's own name — which is also argv[0] of the
// command that updates it, over in lib/install-target.js. That module joins on this key, so
// nothing is spelled twice and a row cannot acquire a command belonging to another manager.
//
// `channel` IS ON THE ROW, deliberately, rather than in a table doctor keeps. A marker and the
// words it is reported with are one fact: put them in two places and the day a marker is
// widened to cover a new directory layout is the day the row starts naming the wrong manager
// for it. Worded as `<manager> (<what was recognized>)` — the parenthetical is what makes the
// row honest, since it says what the answer is BASED ON and not merely what it is.
//
// `layout` is optional: the noun phrase that completes "<path> is inside …" in the reason
// lib/install-target.js builds. A row sets it when the derived wording — "a <manager> global
// install directory", built from argv[0] — would describe its directory wrongly.
//
// WHAT IS NOT HERE: the `kind` string, the update argv and the version query. All three stayed
// in lib/install-target.js, which is where the one meaning of "which channel does this install
// come from, and what runs to update it" lives. lib/update-check.channel.qa.test.js sweeps every
// shipped module for both: a `global-*` kind literal may appear in exactly that one file, and a
// VERSION_FORMAT reference in that file and in lib/update-check.js, which is where the constant
// is declared. This module holds what is decidable by looking at a path, and nothing that
// implies a subprocess.
export const INSTALL_MARKERS = deepFreeze([
  {
    store: 'pnpm',
    channel: 'pnpm (global store)',
    // `~/Library/pnpm/global/5/...` and `~/.local/share/pnpm/global/5/...` wherever PNPM_HOME
    // points. The `global` segment is required: a bare `.pnpm` is pnpm's virtual store, which a
    // project-local dependency has too, and `pnpm add -g` would then report success while
    // leaving the running copy alone — and create a global install the user never asked for. A
    // global store's own virtual store still matches, via the segments above it.
    markers: [['pnpm', 'global']],
  },
  {
    store: 'yarn',
    channel: 'yarn (global store)',
    // `~/.config/yarn/global/...` and `~/.yarn/global/...`.
    markers: [
      ['yarn', 'global'],
      ['.yarn', 'global'],
    ],
  },
  {
    store: 'bun',
    channel: 'bun (global store)',
    // `~/.bun/install/global/...` (BUN_INSTALL may move the `.bun` part).
    markers: [
      ['.bun', 'install', 'global'],
      ['bun', 'install', 'global'],
    ],
  },
  {
    store: 'brew',
    // Homebrew's own name for itself, and the marker that found it. `brew` is the token
    // lib/install-target.js builds `brew upgrade` from; `Homebrew` is what a user reading a
    // bug report calls the thing they installed with.
    channel: `Homebrew (\`Cellar/${HOMEBREW_FORMULA}\`)`,
    // `<prefix>/Cellar/ralph/<version>/libexec/lib/node_modules/@lucasfe/ralph`: the formula
    // runs `npm install` with `std_npm_args`, which installs under `libexec`, so the package
    // root is a plain directory — no symlink, no `.git`, and nowhere near `npm root -g`.
    // Nothing but this marker can recognize it.
    //
    // The PAIR, never a bare `Cellar`. A Cellar always holds `<formula>/<version>/`, so
    // `Cellar` + the formula name is exact, and it matches Apple silicon (`/opt/homebrew`),
    // Intel (`/usr/local`) and Linuxbrew (`/home/linuxbrew/.linuxbrew`) identically without
    // naming a prefix. Naming one would in fact be wrong as well as redundant: brew.sh derives
    // HOMEBREW_CELLAR as `${HOMEBREW_REPOSITORY}/Cellar` when that directory exists and only
    // otherwise as `${HOMEBREW_PREFIX}/Cellar`, so a legacy `/usr/local` install can keep its
    // Cellar outside the prefix. Every branch of that derivation still ends in a segment
    // literally named `Cellar`, which is all this marker reads. A bare `Cellar` would match two
    // things this row must not claim: any project that merely lives under a directory of that
    // name, and every OTHER formula's tree — and a copy of Ralph under someone else's Cellar is
    // not a `ralph` formula install, so `brew upgrade ralph` would upgrade something that does
    // not contain it, or a formula brew never installed at all.
    markers: [['Cellar', HOMEBREW_FORMULA]],
    // Homebrew's own name for the directory. The derived wording would say "a brew global
    // install directory", which is a phrase Homebrew does not use and a shape a Cellar does not
    // have — it holds every version of every formula, not one global tree.
    layout: `a Homebrew Cellar (\`Cellar/${HOMEBREW_FORMULA}\`)`,
  },
])

// `npx` unpacks into `~/.npm/_npx/<hash>/node_modules/...`. NOT a row above, because a row
// carries a manager's name and a global directory, and this is neither: it is a transient cache
// with nothing to update.
export const NPX_CACHE_MARKER = deepFreeze(['_npx'])

// FIVE OF THE NINE things `describeInstallChannel` can say, and why they are worded the way they
// are. The other four are the `channel` fields on INSTALL_MARKERS above — one per row, kept up
// there because a marker and the words it is reported with are one fact. These five are the ones no
// single marker row owns, and the last is a FAMILY rather than a string: the ambiguity names
// whichever stores collided, so its widest instance is the four-way, at 41 code points. All of it
// fits the 48-column value the box has at its design width, measured in install-markers.test.js.
const NPX_CHANNEL = 'npx (`_npx` cache)'
// The two links, told apart because they mean different things to the reader of a bug report: a
// contributor running their own working tree, versus an installed copy that happens to be a
// symlink (a `npm link`, or a store that links out of a content-addressable cache).
const CHECKOUT_CHANNEL = 'linked (dev checkout)'
const LINKED_CHANNEL = 'linked (symlinked install)'
// THE HEDGE, and the most carefully worded string in this module. Every layout but Homebrew's
// installs from npm, so npm is the best available guess — but a guess is what it is, and the
// probe that would settle it (`npm root -g`) is the one thing the consumer of this module is
// architecturally forbidden to run. `(not probed)` is therefore doing the real work: it tells a
// reader that this row is a DEFAULT rather than a finding, so nobody debugs a version mismatch
// on the strength of a channel nothing observed.
const UNPROBED_CHANNEL = 'npm or other (not probed)'
// ...and a path two managers both claim. Deliberately not the hedge: something WAS recognized
// here, and it is exactly the detail a reader could act on. lib/install-target.js refuses to run
// anything for this case, so the two answers agree about it being a real, named ambiguity.
const ambiguousChannel = (stores) =>
  `ambiguous (matches ${stores.map((store) => store.store).join(', ')})`

/**
 * Which channel this copy of Ralph was installed from, worded for a reader — or null.
 *
 * PATH MATCHING PLUS TWO PROBES, and nothing else: no subprocess, no socket, no environment.
 * The precedence is `classifyInstall`'s, deliberately and in the same order, because a
 * diagnostic that named a channel `ralph update` then refused to act on would be worse than no
 * row at all:
 *
 *   1. a link outranks everything — a contributor's working tree linked into a store is a
 *      working tree first, whatever store it is linked into;
 *   2. then an npx cache, which is a run rather than an install;
 *   3. then a store, when exactly one claims the path;
 *   4. then a NAMED ambiguity when more than one does;
 *   5. and otherwise the hedge, which says that the question was not settled.
 *
 * @param {object} [options]
 * @param {string} [options.ralphHome] the package root to describe. Absent or blank answers
 *   null — "nobody asked" — because a fabricated channel is the worst possible row on a bug
 *   report. Never falls back to a default of its own: a cwd that happens to sit under a global
 *   store would have this function describing some unrelated directory.
 * @param {{existsSync?: Function, lstatSync?: Function}} [options.fs] the two link probes. Any
 *   value this cannot use answers "not a link", which is the same answer a plain directory gets
 *   — the caller that cares about the difference is the one that would overwrite a checkout,
 *   and that caller is lib/install-target.js, which supplies the real filesystem.
 * @returns {string|null} the wording, or null when there was no path to describe.
 */
export function describeInstallChannel({ ralphHome, fs } = {}) {
  const home = normalizePath(ralphHome)
  if (!home) return null
  const segments = pathSegments(home)
  // Decided in the order documented above, so the code reads as the precedence it implements.
  const link = linkSignal(fs, home)
  if (link) return link.checkout ? CHECKOUT_CHANNEL : LINKED_CHANNEL
  if (hasMarker(segments, NPX_CACHE_MARKER)) return NPX_CHANNEL
  const stores = matchingStores(segments)
  if (stores.length > 1) return ambiguousChannel(stores)
  if (stores.length === 1) return stores[0].channel
  return UNPROBED_CHANNEL
}

/**
 * The rows whose directory this path sits inside, in table order.
 *
 * TAKES THE TABLE AS AN ARGUMENT, which is the seam that keeps ONE matcher in the package:
 * lib/install-target.js matches on rows it has decorated with a `kind`, an `argv` and a version
 * query, and a matcher that closed over INSTALL_MARKERS would have forced that module to hold a
 * second copy of this filter. Order is preserved because it is load-bearing — the ambiguity
 * message both consumers produce names the managers in table order.
 *
 * @param {string[]} segments the install path's whole segments, from `pathSegments`
 * @param {Array<{markers: string[][]}>} [rows] the table to match against
 * @returns {Array<object>} the rows that matched, in the order they appear in the table
 */
export function matchingStores(segments, rows = INSTALL_MARKERS) {
  return rows.filter((row) => row.markers.some((marker) => hasMarker(segments, marker)))
}

/**
 * Whether a marker's segments appear ADJACENT, as whole segments, anywhere in the path.
 *
 * Whole-segment and adjacent for the same reason lib/install-target.js's `isInside` compares
 * whole segments: `/x/pnpm-old/global/...` is not a pnpm store, and neither is
 * `/x/pnpm/tools/global/...`. A path shorter than the marker answers false rather than throwing.
 *
 * @param {string[]} segments the install path's whole segments
 * @param {string[]} marker the adjacent segments to look for
 * @returns {boolean} whether the marker is present
 */
export function hasMarker(segments, marker) {
  for (let i = 0; i + marker.length <= segments.length; i++) {
    if (marker.every((seg, j) => segments[i + j] === seg)) return true
  }
  return false
}

/**
 * Why this copy must not be replaced by a tarball, or null when it may be, plus whether the
 * thing found is a working tree — the two signals mean different things to the user, so they
 * carry different advice on lib/install-target.js's side and different wording on doctor's.
 *
 * `.git` is checked first, and through the link: existsSync follows symlinks, so a `npm link`ed
 * root finds the checkout's .git without any readlink. What is left when only the symlink probe
 * fires is a linked install, not a checkout — e.g. a package root linked out of a store, or a
 * link a user made by hand.
 *
 * Deliberately generous in the refusing direction: a symlinked install Ralph declines to touch
 * is recoverable by one command, and overwriting a contributor's working tree is not.
 *
 * @param {{existsSync?: Function, lstatSync?: Function}} fs the two probes, injected
 * @param {string} home the package root
 * @returns {{reason: string, checkout: boolean}|null} the signal, or null for a plain directory
 */
export function linkSignal(fs, home) {
  // A `.git` FILE is a worktree or submodule — as much a checkout as a directory is, so the
  // wording covers both.
  if (probe(() => fs.existsSync(join(home, '.git')))) {
    return { reason: 'contains a .git entry (dev checkout)', checkout: true }
  }
  // THE WHOLE QUESTION IS INSIDE THE GUARD, stat call and flag together, and it has to be: the
  // symlink answer takes TWO steps and only the first is the filesystem's. `probe` used to take
  // `(fs, 'lstatSync', home)` and the `.isSymbolicLink?.()` was read off its RESULT, outside the
  // try — so a stat whose `isSymbolicLink` was not callable, or threw, or sat behind a hostile
  // getter, escaped as an exception from a diagnostic that promises never to throw over its own
  // fs. `?.()` short-circuits on null and undefined ONLY, which is why the operator was never the
  // guard it looked like. The plausible shape is the dull one: a structuredClone'd or
  // JSON-round-tripped Stats has lost its methods, and a hand-rolled stub may expose the flag as
  // a plain boolean. The pre-#201 helper in lib/install-target.js had the whole expression in one
  // try for this reason; passing the QUESTION rather than a method name is how that survives an
  // expression growing a second step, since the guard now covers whatever the caller wrote
  // instead of whatever this helper remembered to re-guard.
  if (probe(() => fs.lstatSync(home).isSymbolicLink())) {
    return { reason: 'is a symlink to another location', checkout: false }
  }
  return null
}

/**
 * Absolute, separator-normalized form of a path, or null for blank input.
 *
 * A blank path must never resolve to the cwd: a cwd that happens to sit under a global store
 * would classify some unrelated directory as this install.
 *
 * @param {unknown} p the path
 * @returns {string|null} the resolved path, or null when there was nothing to resolve
 */
export function normalizePath(p) {
  const trimmed = String(p ?? '').trim()
  return trimmed ? resolve(trimmed) : null
}

/**
 * A path's whole segments, empties dropped — the form every marker is matched against.
 *
 * @param {string} home an already-normalized path
 * @returns {string[]} its segments
 */
export function pathSegments(home) {
  return home.split(sep).filter(Boolean)
}

// One probe, guarded once — and it takes the QUESTION, not a method and a path, so the guard
// covers the whole of whatever was asked rather than the first step of it. A question that cannot
// be answered (a missing method, an unreadable path, a stat with no callable flag, a seam that is
// not a filesystem at all) answers `undefined`, which every caller above reads as "no" — and that
// is not a safe default everywhere: a `npm link`ed root lives UNDER `npm root -g`, so a checkout
// these probes cannot see is classified as a global npm install, with an argv, by
// lib/install-target.js. Which is exactly why that module passes the REAL filesystem rather than
// nothing, and why this module refuses to default it: the choice belongs to the caller that knows
// what it is about to do with the answer.
//
// A thunk costs one closure per probe — two per `linkSignal` call, at most twice per `ralph
// doctor` — and buys a guard that cannot drift out of step with the expression it guards. That
// was not a hypothetical: the `(fs, method, path)` shape read totally at the call site while
// leaving `.isSymbolicLink?.()` outside the try, and the tests that caught it are in
// lib/install-markers.qa.test.js under "the probe seam must be TOTAL".
function probe(question) {
  try {
    return question()
  } catch {
    return undefined
  }
}

// The table is handed out by `matchingStores`, so it is frozen: a caller that mutated a row
// would change what every other consumer in the process recognizes, and the two consumers here
// are `ralph update`'s decision and a diagnostic. Same reason NPM_VERSION_QUERY is frozen in
// lib/update-check.js — a shared literal that is handed to callers is a shared literal that
// gets written to.
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
