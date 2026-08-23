import { existsSync as realExistsSync, lstatSync as realLstatSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { execa } from 'execa'
import { RALPH_HOME } from './paths.js'
import { PACKAGE_NAME } from './update-check.js'

// The argv is the runnable form; the printable form is derived from it, so a
// command can never render one way and spawn another. Callers print the label
// when refusing to guess, since it is the command a user can always run by hand.
export const NPM_GLOBAL_UPDATE_ARGV = ['npm', 'install', '-g', `${PACKAGE_NAME}@latest`]
export const NPM_GLOBAL_UPDATE_LABEL = NPM_GLOBAL_UPDATE_ARGV.join(' ')

// #22: the non-npm global stores, each with its own global-add command. The
// markers are whole path segments that must appear ADJACENT in the install path;
// the manager's own name comes from argv[0], so nothing is spelled twice. Every
// marker names a directory that only a GLOBAL install lives in — a marker that
// also matches a project-local copy would answer `-g` for a package Ralph is not
// running from, and report success for an update that did not happen.
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

// #22: six recognized layouts plus `unknown`.
//   npx / linked        — recognized, but deliberately nothing to do: `argv` is
//                         null and `advice` says what to do instead
//   global-{pnpm,yarn,bun} — a GLOBAL_STORES path marker matched: that manager's
//                         own global-add command
//   global-npm          — npm has no marker of its own, so it is the fallback
//                         probe (`npm root -g`), tried only once every marker
//                         above has missed
//   unknown             — refuse to guess: no argv, and no advice either
// `argv` is null whenever Ralph must not run anything — that null, not the kind,
// is what callers gate on; `advice` is what tells a deliberate refusal apart
// from a failure to recognize the layout.
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
      `${home} is inside a ${store.argv[0]} global install directory`,
    )
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
    )
  }
  return unknown(`${home} is not under \`npm root -g\` (${globalRoot})`)
}

function runnable(kind, argv, reason) {
  return { kind, argv, label: argv.join(' '), reason, advice: null }
}

// A layout Ralph recognizes and deliberately will not write to: nothing to run,
// but something to tell the user. Callers gate their exit-0 path on `advice`
// being present, so a refusal never has to be matched by kind name.
function refusal(kind, reason, advice) {
  return { kind, argv: null, label: null, reason, advice }
}

function unknown(reason) {
  return { kind: 'unknown', argv: null, label: null, reason, advice: null }
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
