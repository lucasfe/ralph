import { existsSync as realExistsSync, lstatSync as realLstatSync } from 'node:fs'
import { sep } from 'node:path'
import { execa } from 'execa'
// #201: the half of layout recognition that needs no subprocess. The path markers, the
// matcher and the two link probes were all HERE until #201 moved them out so `ralph doctor`
// could read them: doctor's transitive import graph is pinned closed against process
// spawners, and the `execa` on the line above is why this module is permanently out of its
// reach. That module also gained something this one never had — a wording per channel, for
// the row the diagnostic draws — and what stayed here is everything that implies a SPAWN.
// See the store table below for where the two halves are joined.
import {
  HOMEBREW_FORMULA,
  INSTALL_MARKERS,
  NPX_CACHE_MARKER,
  hasMarker,
  linkSignal,
  matchingStores,
  normalizePath,
  pathSegments,
} from './install-markers.js'
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

// #22, #198, #201: what each recognized store's install is UPDATED by — a global add for
// the npm-shaped managers, and (#198) `brew upgrade` for Homebrew, which has no npm spec to
// add.
//
// THE TABLE IS IN TWO HALVES, and this is the half that implies a subprocess. The other one
// — the path markers that recognize each layout, the wording, `layout` and the Homebrew
// formula name — is lib/install-markers.js, which #201 cut out so `ralph doctor` could
// report the install channel without importing this module and its spawner. What stayed is
// what a diagnostic has no business holding: the `kind` string every consumer's channel
// handling keys on, the argv that updates the layout, and (#199) the query that asks what
// the newest version on that channel is.
//
// THE JOIN IS `store`, AND NOTHING ELSE. It is the manager's own name, and it is also
// argv[0], so the name is still spelled once and a row cannot acquire a command belonging to
// another manager. lib/install-markers.test.js asserts the join from the outside, over every
// row in that table: a row with no command here would classify as a store with an
// `undefined` argv, which is a crash in `ralph update` rather than a red test.
//
// #199: `latest` is optional — the query that answers "what is the newest version this
// channel has?". Only the Homebrew row sets it, because pnpm, yarn and bun all install FROM
// npm and so share NPM_VERSION_QUERY (the default in `runnable` below); Homebrew installs
// from its tap, which holds a different version whenever a release reaches one channel and
// not the other.
const STORE_UPDATES = new Map([
  ['pnpm', { kind: 'global-pnpm', argv: ['pnpm', 'add', '-g', `${PACKAGE_NAME}@latest`] }],
  ['yarn', { kind: 'global-yarn', argv: ['yarn', 'global', 'add', `${PACKAGE_NAME}@latest`] }],
  ['bun', { kind: 'global-bun', argv: ['bun', 'add', '-g', `${PACKAGE_NAME}@latest`] }],
  [
    'brew',
    {
      // #198: Homebrew. `brew upgrade <formula>`, not a global add of an npm spec —
      // brew's unit is the formula, and it builds from the release tag's source
      // tarball rather than from the registry (scripts/lib/render-homebrew-formula.js
      // is what writes that formula). It stays ONE spawn: no `brew update` first,
      // because brew refreshes its taps before an upgrade on its own cadence
      // (HOMEBREW_AUTO_UPDATE_SECS), so a second command would only slow the update
      // down and give it a second way to fail.
      //
      // The formula name is lib/install-markers.js's constant, the same one its `Cellar`
      // marker is built from, so a rename cannot leave the marker matching a formula this
      // argv does not upgrade — which would answer `brew upgrade` for someone else's Cellar.
      kind: 'global-brew',
      argv: ['brew', 'upgrade', HOMEBREW_FORMULA],
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
  ],
])

// The whole table `classifyInstall` matches on: every recognized layout, with the markers
// that find it and the command that updates it. Built rather than written, in the marker
// half's order — which is load-bearing, because the ambiguity message below names the
// managers a path matched in exactly this order.
const GLOBAL_STORES = INSTALL_MARKERS.map((row) => ({ ...row, ...STORE_UPDATES.get(row.store) }))

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
  const home = normalizePath(ralphHome ?? RALPH_HOME)
  if (!home) {
    return unknown('no install directory to classify (a blank or absent install path)')
  }
  const segments = pathSegments(home)

  // Which store's directory this path sits in, when exactly one does. Pure path
  // matching, so knowing it up front costs nothing — the refusals below only use
  // it to name a command, never to decide whether to run one.
  const stores = matchingStores(segments, GLOBAL_STORES)
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

async function npmGlobalRoot(exec) {
  if (typeof exec !== 'function') return null
  let result
  try {
    result = await exec('npm', ['root', '-g'], { reject: false })
  } catch {
    return null
  }
  if (!result || result.exitCode !== 0) return null
  return normalizePath(result.stdout)
}

function isInside(parent, child) {
  // Compare whole segments so `/x/node_modules-old/...` is not read as living
  // inside `/x/node_modules`.
  return child === parent || child.startsWith(parent + sep)
}

// Injectable fs, following lib/folder-queue.js's bound-method facade so tests
// can stub `linkSignal`'s two probes instead of touching the real filesystem.
//
// #201: THE REAL-FS DEFAULT STAYED HERE when the probes themselves moved to
// lib/install-markers.js, and the asymmetry is deliberate. A probe that cannot answer
// answers "no", which is not a safe default everywhere: a `npm link`ed root lives UNDER
// `npm root -g`, so a checkout the probes cannot see is classified `global-npm` — with an
// argv — by the `npm root -g` branch of `classifyInstall`. The path markers are the harmless
// case (no store directory looks like a working tree); this pair is the only thing standing
// between a linked checkout and `npm install -g`, so THIS caller falls back to the real
// filesystem rather than to nothing. The other caller of those probes is
// lib/commands/doctor.js, which passes a seam of its own and never reaches this function: its
// worst case for a probe that cannot answer is a row that reports the path's marker (or the
// hedge) for a directory that is really a link — a wrong word in a diagnostic, where the same
// silence here would be a tarball unpacked over a contributor's working tree.
function fsFrom(fsImpl) {
  // Truthiness, not `??`: a falsy non-nullish argument (`false`, `0`, `''`) is
  // not an fs, and reading properties off it would silently answer "no" to every
  // probe. Fall back to the real filesystem instead.
  const impl = fsImpl || { existsSync: realExistsSync, lstatSync: realLstatSync }
  const bind = (name) => (typeof impl[name] === 'function' ? impl[name].bind(impl) : null)
  return { existsSync: bind('existsSync'), lstatSync: bind('lstatSync') }
}
