import { existsSync as realExistsSync, lstatSync as realLstatSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { execa } from 'execa'
import { RALPH_HOME } from './paths.js'
import { NPM_VERSION_QUERY, PACKAGE_NAME, VERSION_FORMAT } from './update-check.js'

// The argv is the runnable form; the printable form is derived from it, so a
// command can never render one way and spawn another. Callers print the label
// when refusing to guess, since it is the command a user can always run by hand.
// (#200 adds ONE printable form that is not derived — NPM_GLOBAL_NOTICE_LABEL,
// below — and the comment there is what justifies the exception.)
export const NPM_GLOBAL_UPDATE_ARGV = ['npm', 'install', '-g', `${PACKAGE_NAME}@latest`]
export const NPM_GLOBAL_UPDATE_LABEL = NPM_GLOBAL_UPDATE_ARGV.join(' ')

// #200: the npm layout's command as a ONE-LINE NOTICE spells it — the only place in
// this file where a printable form is not derived from the argv, so it carries its
// reason with it.
//
// lib/update-gate.js prints `New version available: X (run <command> to update)` on
// every `ralph start` and `ralph cycle` that finds something newer and has a command to
// name, and from #24 until this change that command was `npm i -g @lucasfe/ralph` for
// every layout there is. Eight suites outside #200's own assert those
// exact bytes — measured by grepping the literal across `*.test.js` and discarding
// comments and one stub that prints a line of its own: lib/update-gate.test.js,
// lib/update-gate.channel.qa.test.js, lib/commands/cycle.update-notice.test.js and
// its .qa, lib/commands/cycle.update-prompt.test.js and its .qa,
// lib/commands/start.update-check.qa.test.js, test/commands/start.test.js. #200's
// job is to stop that line lying to the layouts it does not describe — not to
// re-word it for the layout it does.
//
// The difference is bounded to SPELLING, and measured on npm 10.8.2 rather than
// assumed:
//   - `i` is an alias of `install` — `npm install -h` prints
//     "aliases: add, i, in, ins, inst, insta, instal, isnt, isnta, isntal, isntall";
//   - the omitted `@latest` is the tag a bare spec already resolves to —
//     `npm config get tag` prints `latest`.
// So the two forms name the same operation on the same package, and a user who
// pastes this runs what an accepted prompt would have spawned — with one caveat worth
// stating rather than glossing: `latest` is npm's DEFAULT tag, not a property of npm.
// A user who has set `tag=beta` in their own npm config resolves a pasted
// `npm i -g @lucasfe/ralph` to THAT tag, where the prompt spawns an explicit `@latest`
// either way. The argv is the form that cannot drift, which is why it is the one that
// spawns and this one is print-only.
//
// The invariant above still holds where it bites: `argv` is untouched, nothing SPAWNS
// this string (it is print-only, and `label` remains the runnable form), and no layout
// but npm's can reach it — a Homebrew install carries `brew upgrade ralph` in both
// forms, which is the whole point of #200.
export const NPM_GLOBAL_NOTICE_LABEL = `npm i -g ${PACKAGE_NAME}`

// #198: the Homebrew formula this package installs as, spelled once here so the
// marker and the argv below cannot drift apart — a marker matching a formula the
// argv does not upgrade would answer `brew upgrade` for someone else's Cellar.
//
// scripts/lib/render-homebrew-formula.js, which renders Formula/ralph.rb, holds a
// second copy of this literal, and neither direction of import is available to
// remove it. This file cannot import the renderer: package.json's `files`
// allow-list publishes `lib/` and not `scripts/`, so the import would resolve in a
// checkout and throw ERR_MODULE_NOT_FOUND in every installed copy. And the
// renderer cannot import this file either — test/homebrew-formula.test.js asserts
// its source contains no `import` and no `require(` at all, because its purity is
// what makes the rendered formula reproducible.
//
// So the duplication is structural, and the mitigation is a test rather than a
// shared constant: test/homebrew-formula.test.js pins the name in the rendered
// formula against the argv `classifyInstall` returns, so renaming one side alone
// fails there instead of on a user's machine, where it would stop the marker
// matching AND name a formula brew cannot find.
const HOMEBREW_FORMULA = 'ralph'

// #22: the non-npm global stores, each with the command that updates a global
// install it owns — a global add for the npm-shaped managers, and (#198) `brew
// upgrade` for Homebrew, which has no npm spec to add. The markers are whole path
// segments that must appear ADJACENT in the install path; the manager's own name
// comes from argv[0], so nothing is spelled twice. Every marker names a directory
// that only a GLOBAL install lives in — a marker that also matches a
// project-local copy would answer `-g` for a package Ralph is not running from,
// and report success for an update that did not happen.
//
// `layout` is optional: the noun phrase that completes "<path> is inside …" in
// the reason. A row sets it when the derived wording — "a <manager> global
// install directory", built from argv[0] — would describe its directory wrongly.
//
// #199: `latest` is optional too — the query that answers "what is the newest
// version this channel has?". Only the Homebrew row sets it, because pnpm, yarn and
// bun all install FROM npm and so share NPM_VERSION_QUERY (the default in
// `runnable` below); Homebrew installs from its tap, which holds a different
// version whenever a release reaches one channel and not the other.
const GLOBAL_STORES = [
  {
    kind: 'global-pnpm',
    argv: ['pnpm', 'add', '-g', `${PACKAGE_NAME}@latest`],
    // `~/Library/pnpm/global/5/...` and `~/.local/share/pnpm/global/5/...`
    // wherever PNPM_HOME points. The `global` segment is required: a bare `.pnpm`
    // is pnpm's virtual store, which a project-local dependency has too, and
    // `pnpm add -g` would then report success while leaving the running copy
    // alone — and create a global install the user never asked for. A global
    // store's own virtual store still matches, via the segments above it.
    markers: [['pnpm', 'global']],
  },
  {
    kind: 'global-yarn',
    argv: ['yarn', 'global', 'add', `${PACKAGE_NAME}@latest`],
    // `~/.config/yarn/global/...` and `~/.yarn/global/...`.
    markers: [
      ['yarn', 'global'],
      ['.yarn', 'global'],
    ],
  },
  {
    kind: 'global-bun',
    argv: ['bun', 'add', '-g', `${PACKAGE_NAME}@latest`],
    // `~/.bun/install/global/...` (BUN_INSTALL may move the `.bun` part).
    markers: [
      ['.bun', 'install', 'global'],
      ['bun', 'install', 'global'],
    ],
  },
  {
    // #198: Homebrew. `brew upgrade <formula>`, not a global add of an npm spec —
    // brew's unit is the formula, and it builds from the release tag's source
    // tarball rather than from the registry (scripts/lib/render-homebrew-formula.js
    // is what writes that formula). It stays ONE spawn: no `brew update` first,
    // because brew refreshes its taps before an upgrade on its own cadence
    // (HOMEBREW_AUTO_UPDATE_SECS), so a second command would only slow the update
    // down and give it a second way to fail.
    kind: 'global-brew',
    argv: ['brew', 'upgrade', HOMEBREW_FORMULA],
    // `<prefix>/Cellar/ralph/<version>/libexec/lib/node_modules/@lucasfe/ralph`:
    // the formula runs `npm install` with `std_npm_args`, which installs under
    // `libexec`, so the package root is a plain directory — no symlink, no `.git`,
    // and nowhere near `npm root -g`. Nothing but this marker can recognize it.
    //
    // The PAIR, never a bare `Cellar`. A Cellar always holds
    // `<formula>/<version>/`, so `Cellar` + the formula name is exact, and it
    // matches Apple silicon (`/opt/homebrew`), Intel (`/usr/local`) and Linuxbrew
    // (`/home/linuxbrew/.linuxbrew`) identically without naming a prefix. Naming
    // one would in fact be wrong as well as redundant: brew.sh derives
    // HOMEBREW_CELLAR as `${HOMEBREW_REPOSITORY}/Cellar` when that directory
    // exists and only otherwise as `${HOMEBREW_PREFIX}/Cellar`, so a legacy
    // `/usr/local` install can keep its Cellar outside the prefix. Every branch of
    // that derivation still ends in a segment literally named `Cellar`, which is
    // all this marker reads. A bare `Cellar` would match two things this row must
    // not claim: any project that merely lives under a directory of that name, and
    // every OTHER formula's tree — and a copy of Ralph under someone else's Cellar
    // is not a `ralph` formula install, so `brew upgrade ralph` would upgrade
    // something that does not contain it, or a formula brew never installed at all.
    markers: [['Cellar', HOMEBREW_FORMULA]],
    // Homebrew's own name for the directory. The derived wording would say "a
    // brew global install directory", which is a phrase Homebrew does not use and
    // a shape a Cellar does not have — it holds every version of every formula,
    // not one global tree.
    layout: `a Homebrew Cellar (\`Cellar/${HOMEBREW_FORMULA}\`)`,
    // #199: the one row whose "latest version" is not npm's. A brew install comes
    // from the tap, so asking npm answers about a channel this copy was not
    // installed from — "already up to date" for as long as the registry sits behind
    // the formula, and an upgrade brew cannot fetch for as long as it sits ahead.
    // #196 is adding that tap so a refused `npm publish` cannot stop a release from
    // being installable, which makes the two channels holding different versions the
    // design rather than an accident.
    //
    // The formula name is the same literal as the argv above, so a rename cannot
    // make the query read formula A while the upgrade runs formula B.
    //
    // ACCEPTED TRADEOFF, deliberately not "fixed": `brew info` reads the LOCALLY
    // TAPPED formula, and refreshes nothing. `info` is not in auto-update.sh's
    // AUTO_UPDATE_COMMANDS (measured: `install outdated upgrade bundle release`,
    // plus `tap` with an argument), and HOMEBREW_AUTO_UPDATE_SECS is a MINIMUM
    // INTERVAL between the refreshes those commands do — "Run `brew update` once
    // every N seconds before some commands" — not a ceiling on how stale a tap may
    // be. So the lag here is unbounded: it is however long since the user last ran
    // an auto-updating brew command, a month if that is when they last installed
    // anything. A `brew update` of our own would trade that for a network fetch of
    // unbounded DURATION inside a command holding the user's terminal, and would
    // still be stale by the time the upgrade ran. What makes the staleness
    // acceptable is its direction, not its size: an old tap can only UNDER-report
    // an upgrade, never promise one brew cannot install, and `brew upgrade`
    // refreshes the tap itself — so the worst case is a late nag, and the next run
    // sees the newer version.
    latest: {
      argv: ['brew', 'info', '--json=v2', HOMEBREW_FORMULA],
      format: VERSION_FORMAT.BREW_JSON_V2,
      // Completes "Could not read the latest published version (…)".
      unreachable: 'the Homebrew tap could not be read?',
    },
  },
]

// `npx` unpacks into `~/.npm/_npx/<hash>/node_modules/...`.
const NPX_CACHE_MARKER = ['_npx']

const NPX_ADVICE =
  'npx always fetches the latest published version, so there is nothing to update.'
const CHECKOUT_ADVICE = 'Run `git pull` in that checkout to update it.'

// A symlinked package root with no checkout behind it: a normal install for a
// manager that links out of a content-addressable store — Ralph just will not
// overwrite a link. Node realpaths `import.meta.url`, so RALPH_HOME usually
// arrives already resolved and a real store install classifies by marker; this is
// the wording for the forms that do arrive as a link. `store` is the one package
// manager whose directory this path sits in, when exactly one does.
const linkedInstallAdvice = (store) =>
  store
    ? `Ralph will not overwrite a linked install; run \`${store.argv.join(' ')}\` to update it.`
    : 'Ralph will not overwrite a linked install; update it with whichever package manager created it.'

// #22, #198: seven recognized layouts plus `unknown`.
//   npx / linked        — recognized, but deliberately nothing to do: `argv` is
//                         null and `advice` says what to do instead
//   global-{pnpm,yarn,bun} — a GLOBAL_STORES path marker matched: that manager's
//                         own global-add command
//   global-brew         — the same table, one more row: a Homebrew Cellar path,
//                         upgraded by `brew upgrade <formula>`
//   global-npm          — npm has no marker of its own, so it is the fallback
//                         probe (`npm root -g`), tried only once every marker
//                         above has missed
//   unknown             — refuse to guess: no argv, and no advice either
// `argv` is null whenever Ralph must not run anything — that null, not the kind,
// is what callers gate on; `advice` is what tells a deliberate refusal apart
// from a failure to recognize the layout.
//
// #199: every one of them also carries `latest` — the query that answers "what is
// the newest version THIS channel has?" (argv to spawn, format to parse, and the
// wording for a failure to name the channel). It is on every classification this
// function can return — the four store rows, `global-npm`, both refusals and
// `unknown` — so a caller never has to ask which kinds have one; pass it to
// `fetchLatestVersion` rather than matching on `kind` to pick a query.
//
// #200: and `noticeLabel` — the command a one-line notice may tell the user to run,
// or null when this layout has nothing to offer. Present on every kind, same as
// `latest`, and it is what lib/update-gate.js prints instead of the npm coordinate it
// used to hardcode for every layout there is. It follows `label` on the store rows and
// on BOTH REFUSALS — a refusal carries `label: null` and answers null here too, because
// a notice that filled that gap with the npm command would name the exact command
// `ralph update` then declines to run. Exactly two kinds diverge, both by decision
// rather than accident:
//   - `global-npm` answers the shorter NPM_GLOBAL_NOTICE_LABEL over a `label` that is
//     the runnable NPM_GLOBAL_UPDATE_LABEL — #24's bytes.
//   - `unknown` answers NPM_GLOBAL_NOTICE_LABEL over a `label` of null, and IT is the row
//     the background notice actually reads. lib/update-gate.js calls
//     `classify({ exec: null })`, so a real global npm install takes the
//     `typeof exec !== 'function'` branch below and classifies `unknown` — never
//     `global-npm`, which only a run that hands over a spawner can reach.
//     lib/update-gate.notice-command.qa.test.js pins that, driving one npm layout both
//     ways and asserting the two kinds really do differ.
export async function classifyInstall({ ralphHome, exec = execa, fs: fsImpl } = {}) {
  // Never fall back to the cwd: a cwd that happens to sit under `npm root -g`
  // would classify some unrelated directory as this install.
  const home = normalize(ralphHome ?? RALPH_HOME)
  if (!home) {
    return unknown('no install directory to classify (a blank or absent install path)')
  }
  const segments = home.split(sep).filter(Boolean)

  // Which store's directory this path sits in, when exactly one does. Pure path
  // matching, so knowing it up front costs nothing — the refusals below only use
  // it to name a command, never to decide whether to run one.
  const stores = GLOBAL_STORES.filter((store) =>
    store.markers.some((marker) => hasMarker(segments, marker)),
  )
  const store = stores.length === 1 ? stores[0] : null

  // The two refusals are decided from the package root alone, before any
  // package-manager guess and before npm is probed at all — a published tarball
  // must never be installed over a contributor's working tree, whatever store
  // that checkout happens to be linked into.
  const linked = linkSignal(fsFrom(fsImpl), home)
  if (linked) {
    return refusal(
      'linked',
      `${home} ${linked.reason}`,
      linked.checkout ? CHECKOUT_ADVICE : linkedInstallAdvice(store),
    )
  }
  if (hasMarker(segments, NPX_CACHE_MARKER)) {
    return refusal('npx', `${home} is inside an npx cache (\`_npx\`)`, NPX_ADVICE)
  }

  if (stores.length > 1) {
    // Ambiguous layouts fail closed rather than picking a manager at random.
    const names = stores.map((s) => s.argv[0]).join(', ')
    return unknown(`${home} matches more than one package manager (${names})`)
  }
  if (store) {
    return runnable(
      store.kind,
      store.argv,
      `${home} is inside ${store.layout ?? `a ${store.argv[0]} global install directory`}`,
      { latest: store.latest },
    )
  }

  // #200: a caller may deliberately withhold `exec` to get a path-only
  // classification — lib/update-gate.js does, on every `ralph start`, because a
  // background notice must not cost a subprocess. Said separately from the failure
  // below because the reason is printed to the user by lib/commands/update.js, and it
  // may not report that a probe answered nothing when the probe never ran.
  if (typeof exec !== 'function') {
    return unknown('`npm root -g` was not probed (no way to spawn it was available)')
  }
  const globalRoot = await npmGlobalRoot(exec)
  if (!globalRoot) {
    return unknown('`npm root -g` did not report a global node_modules directory')
  }
  if (isInside(globalRoot, home)) {
    return runnable(
      'global-npm',
      NPM_GLOBAL_UPDATE_ARGV,
      `installed under \`npm root -g\` (${globalRoot})`,
      // #200: the one RUNNABLE layout whose notice is not its label — #24's bytes. The
      // background notice never arrives here, though: it withholds `exec`, so a global
      // npm install reaches those same bytes through the `unknown` returned at the
      // `typeof exec !== 'function'` branch above. This row is `ralph update`'s path.
      { noticeLabel: NPM_GLOBAL_NOTICE_LABEL },
    )
  }
  return unknown(`${home} is not under \`npm root -g\` (${globalRoot})`)
}

// #199: `latest` defaults to the npm query, so a store row only spells one when
// its channel is not npm — today just Homebrew's. Passing `store.latest` straight
// through takes the default when the row omits it.
//
// #200: `noticeLabel` defaults to the runnable label, which is what makes every store
// row's notice name its own manager without spelling a second command. Only
// `global-npm` overrides it.
function runnable(kind, argv, reason, { latest = NPM_VERSION_QUERY, noticeLabel } = {}) {
  const label = argv.join(' ')
  return { kind, argv, label, reason, advice: null, latest, noticeLabel: noticeLabel ?? label }
}

// A layout Ralph recognizes and deliberately will not write to: nothing to run,
// but something to tell the user. Callers gate their exit-0 path on `advice`
// being present, so a refusal never has to be matched by kind name.
//
// #199: a refusal carries a version query all the same, because `ralph update`
// asks what is out there before it decides there is nothing to install, and returns
// that answer as `to`. npm is the honest channel for both refusals: an npx run
// fetches from the registry every time, and a linked checkout is compared against
// what is published rather than against a tap it was never installed from.
//
// #200: and no notice command, for the same reason it has no argv. `advice` is the
// field that says what to do instead — and it is printed by the run the user ASKED
// for (`ralph update`), not by a one-line background notice that has no room to
// explain why the obvious command is the wrong one here.
function refusal(kind, reason, advice) {
  return {
    kind,
    argv: null,
    label: null,
    reason,
    advice,
    latest: NPM_VERSION_QUERY,
    noticeLabel: null,
  }
}

// #199: an unrecognized layout gets the npm query as well. Any channel is a guess
// here, and npm is the one `ralph update` already names when it refuses to guess at
// an install command (NPM_GLOBAL_UPDATE_LABEL) — so the version it reports and the
// command it suggests at least come from the same place.
//
// #200: which is exactly why it also gets the npm notice command — the SUGGESTION
// `ralph update` would print by hand, in the same channel's spelling. Unlike a refusal
// there is nothing here to explain: no layout was recognized, so the best available
// answer is the one that works for the layouts that install from npm, which is all of
// them but Homebrew's.
function unknown(reason) {
  return {
    kind: 'unknown',
    argv: null,
    label: null,
    reason,
    advice: null,
    latest: NPM_VERSION_QUERY,
    noticeLabel: NPM_GLOBAL_NOTICE_LABEL,
  }
}

// Why this copy must not be replaced by a tarball, or null when it may be, plus
// whether the thing found is a working tree — the two signals mean different
// things to the user, so they carry different advice.
//
// `.git` is checked first, and through the link: existsSync follows symlinks, so
// a `npm link`ed root finds the checkout's .git without any readlink. What is
// left when only the symlink probe fires is a linked install, not a checkout —
// e.g. a package root linked out of a store, or a link a user made by hand.
//
// Deliberately generous in the refusing direction: a symlinked install Ralph
// declines to touch is recoverable by one command, and overwriting a
// contributor's working tree is not.
function linkSignal(fs, home) {
  // A `.git` FILE is a worktree or submodule — as much a checkout as a directory
  // is, so the wording covers both.
  if (exists(fs, join(home, '.git'))) {
    return { reason: 'contains a .git entry (dev checkout)', checkout: true }
  }
  if (isSymlink(fs, home)) {
    return { reason: 'is a symlink to another location', checkout: false }
  }
  return null
}

async function npmGlobalRoot(exec) {
  if (typeof exec !== 'function') return null
  let result
  try {
    result = await exec('npm', ['root', '-g'], { reject: false })
  } catch {
    return null
  }
  if (!result || result.exitCode !== 0) return null
  return normalize(result.stdout)
}

// Whole-segment, adjacent match, for the same reason `isInside` compares whole
// segments: `/x/pnpm-old/global/...` is not a pnpm store, and neither is
// `/x/pnpm/tools/global/...`.
function hasMarker(segments, marker) {
  for (let i = 0; i + marker.length <= segments.length; i++) {
    if (marker.every((seg, j) => segments[i + j] === seg)) return true
  }
  return false
}

function isInside(parent, child) {
  // Compare whole segments so `/x/node_modules-old/...` is not read as living
  // inside `/x/node_modules`.
  return child === parent || child.startsWith(parent + sep)
}

// Absolute, separator-normalized form of a path, or null for blank input — a
// blank path must never resolve to the cwd.
function normalize(p) {
  const trimmed = String(p ?? '').trim()
  return trimmed ? resolve(trimmed) : null
}

// Injectable fs, following lib/folder-queue.js's bound-method facade so tests
// can stub the two probes below instead of touching the real filesystem.
function fsFrom(fsImpl) {
  // Truthiness, not `??`: a falsy non-nullish argument (`false`, `0`, `''`) is
  // not an fs, and reading properties off it would silently answer "no" to every
  // probe. Fall back to the real filesystem instead.
  const impl = fsImpl || { existsSync: realExistsSync, lstatSync: realLstatSync }
  const bind = (name) => (typeof impl[name] === 'function' ? impl[name].bind(impl) : null)
  return { existsSync: bind('existsSync'), lstatSync: bind('lstatSync') }
}

// A probe that cannot answer (missing method, unreadable path) answers "no",
// which is not a safe default everywhere: a `npm link`ed root lives UNDER
// `npm root -g`, so a checkout these probes cannot see is classified
// `global-npm` — with an argv — by the probe below. The path markers are the
// harmless case (no store directory looks like a working tree); this pair is the
// only thing standing between a linked checkout and `npm install -g`, so it
// falls back to the real fs rather than to nothing.
function isSymlink(fs, path) {
  try {
    return Boolean(fs.lstatSync?.(path)?.isSymbolicLink())
  } catch {
    return false
  }
}

function exists(fs, path) {
  try {
    return Boolean(fs.existsSync?.(path))
  } catch {
    return false
  }
}
