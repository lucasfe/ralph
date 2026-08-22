import { resolve, sep } from 'node:path'
import { execa } from 'execa'
import { RALPH_HOME } from './paths.js'
import { PACKAGE_NAME } from './update-check.js'

// The argv is the runnable form; the printable form is derived from it, so a
// command can never render one way and spawn another. Callers print the label
// when refusing to guess, since it is the command a user can always run by hand.
export const NPM_GLOBAL_UPDATE_ARGV = ['npm', 'install', '-g', `${PACKAGE_NAME}@latest`]
export const NPM_GLOBAL_UPDATE_LABEL = NPM_GLOBAL_UPDATE_ARGV.join(' ')

// #21: only two kinds exist in this slice — `global-npm` (this copy lives under
// `npm root -g`, so npm can update it) and `unknown` (refuse to guess, tell the
// user to run the command themselves). #22 widens this to pnpm/yarn/bun global
// stores, the npx cache, and linked dev checkouts; the {kind, argv, label,
// reason} shape stays the same. `argv` is null whenever Ralph must not run
// anything — that null, not the kind, is what callers gate on.
export async function classifyInstall({ ralphHome, exec = execa } = {}) {
  // Never fall back to the cwd: a cwd that happens to sit under `npm root -g`
  // would classify some unrelated directory as this install.
  const home = normalize(ralphHome ?? RALPH_HOME)
  const globalRoot = await npmGlobalRoot(exec)
  if (!globalRoot) {
    return unknown('`npm root -g` did not report a global node_modules directory')
  }
  if (!home) {
    return unknown('no install directory to compare against `npm root -g`')
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
  return { kind, argv, label: argv.join(' '), reason }
}

function unknown(reason) {
  return { kind: 'unknown', argv: null, label: null, reason }
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
