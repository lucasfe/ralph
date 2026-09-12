#!/usr/bin/env node
// #202 — everything the release job needs to know before it renders a formula:
// `node scripts/homebrew-tap-plan.js --remote <url> --into <dir> [--version 1.2.3]`
//
// Prints three `key=value` lines on stdout, in the shape a GitHub Actions step
// appends straight to `$GITHUB_OUTPUT`, and one human sentence on stderr so the run
// log says what it decided and why:
//
//   version=0.25.4
//   tarball_url=https://github.com/lucasfe/ralph/archive/refs/tags/v0.25.4.tar.gz
//   carries_version=false
//
// DEVELOPMENT ONLY, AND NOT PUBLISHED. package.json's `files` is an allow-list
// ("bin", "lib", "templates", and two markdown files), so everything under scripts/
// is outside the npm tarball by construction — there is no ignore rule to keep in
// sync.
//
// WHY THIS IS A SCRIPT AND NOT A `run:` BLOCK. The one case #202 singles out is an
// EMPTY tap, and a shell heredoc inside a workflow is reachable by nothing but a real
// release: it cannot be driven, so "an empty tap does not fail the job" would be a
// claim nobody could check until the day it mattered. As a script it is driven for
// real in test/homebrew-release-job.test.js against taps that spec builds itself with
// `git init --bare`, empty one included.
//
// WHY A CLONE, AND NOT AN API CALL. Measured against the real lucasfe/homebrew-ralph,
// which today has no commits:
//
//   git clone --depth 1 https://github.com/lucasfe/homebrew-ralph   exit 0
//     warning: You appear to have cloned an empty repository.
//   gh api repos/lucasfe/homebrew-ralph/contents/Formula/ralph.rb   exit 1
//     {"message":"This repository is empty.", "status":"404"}
//   gh api repos/lucasfe/homebrew-ralph/commits                     HTTP 409
//     Git Repository is empty.
//   curl .../raw/main/Formula/ralph.rb                              HTTP 404
//
// Every API-shaped probe reports the empty tap as a FAILURE, so using one means
// swallowing its failure to mean "no" — and a swallowed failure cannot tell an empty
// tap from a tap that was deleted, renamed or made private. The clone tells them
// apart at the exit status: emptiness is 0, absence is not. (One more thing the API
// answers unhelpfully, recorded because #202's own wording says otherwise: for this
// empty repository `gh api repos/lucasfe/homebrew-ralph` reports
// `default_branch: main`, not the absence of one. The branch name is not evidence
// that a commit exists.)
//
// The clone is also the checkout the push step needs, so the probe costs the job
// nothing it was not going to spend.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tagTarballUrl } from './lib/render-homebrew-formula.js'

// Resolved from this file, not from the working directory, for the same reason
// scripts/generate-homebrew-formula.js resolves it that way: the version being
// released is this repository's, not that of whatever package.json is nearest to cwd.
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url))
const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))

// Where a Homebrew tap keeps its formulae, and the file this package's formula is.
// The name is `ralph` because Homebrew derives a formula's class from its file name
// (Formulary.class_s) and the renderer emits `class Ralph`.
const FORMULA_PATH = 'Formula/ralph.rb'

const USAGE = `usage: node scripts/homebrew-tap-plan.js --remote <url> --into <dir> [options]

  --remote <url>        the tap to clone: a clone URL, or a path to a repository
  --into <dir>          where to clone it; must not exist yet
  --version <x.y.z>     version being released (default: this package.json's, ${pkg.version})

Prints version=, tarball_url= and carries_version= on stdout, for $GITHUB_OUTPUT.
An EMPTY tap is reported as carries_version=false, not as an error.`

function usageError(message) {
  return new Error(`${message}\n\n${USAGE}`)
}

/**
 * Hand-rolled argv parsing, following scripts/generate-homebrew-formula.js:
 * `commander` is a runtime dependency of the published CLI, and a development-only
 * script has no business widening what the package ships with. Unknown flags are
 * rejected rather than ignored, so a typo in the workflow cannot quietly probe
 * nothing and report "no".
 *
 * @param {string[]} argv process.argv.slice(2)
 */
function parseArgs(argv) {
  const options = { remote: null, into: null, version: pkg.version }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--remote' || arg === '--into' || arg === '--version') {
      const value = argv[i + 1]
      if (!value) throw usageError(`${arg} needs a value`)
      options[arg.slice(2)] = value
      i += 1
    } else if (arg.startsWith('-')) {
      throw usageError(`unknown option ${arg}`)
    } else {
      throw usageError(`unexpected argument ${JSON.stringify(arg)}`)
    }
  }

  if (options.remote === null) throw usageError('no --remote tap given')
  if (options.into === null) throw usageError('no --into directory given')
  return options
}

/**
 * Clones the tap, shallowly. Exits the process on a clone that actually failed —
 * a remote that is not there, or is not readable — because that is a broken release
 * and not a first one.
 *
 * @param {string} remote clone URL or path
 * @param {string} into directory to clone into
 */
function cloneTap(remote, into) {
  // --depth 1 because the only thing wanted from the history is the current formula,
  // and the tap grows one commit per release forever. git ignores it for a local
  // remote (it says so: "warning: --depth is ignored in local clones") and still
  // exits 0, which is why the specs can use a path.
  const result = spawnSync('git', ['clone', '--depth', '1', remote, into], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error(`could not run git: ${result.error.message}`)
  if (result.status !== 0) {
    // Worded around the bare past tense of "fail" ON PURPOSE, and it is not
    // squeamishness: `failed` is one of the four names in lib/labels.js's
    // RALPH_LABELS, and lib/labels.vocabulary.qa.test.js sweeps every non-comment
    // line under scripts/ for a label spelled as a code literal — a guard against a
    // rename half-landing. A diagnostic string is a false positive to that sweep,
    // and the sweep is worth more than this sentence's phrasing.
    throw new Error(
      `git clone ${remote} exited ${result.status}. An EMPTY tap is not this case — ` +
        `cloning one exits 0 — so the remote is missing, renamed, private or ` +
        `unreachable.\n${(result.stderr ?? '').trim()}`,
    )
  }
}

/**
 * The tap's formula, or null when the tap does not have one — which covers both the
 * empty tap (a clone with no commits leaves nothing but .git/) and a tap that carries
 * other formulae and not this one.
 *
 * @param {string} into the directory the tap was cloned into
 * @returns {string|null}
 */
function tapFormula(into) {
  try {
    return readFileSync(resolve(into, FORMULA_PATH), 'utf8')
  } catch (error) {
    // ENOENT is the answer "no formula", not a failure. Anything else — a directory
    // where the file should be, a permission problem — is a real error and is
    // rethrown, because reading it as "no" would push over the top of a tap whose
    // state is unknown.
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function main(argv) {
  const { remote, into, version } = parseArgs(argv)
  // Built by the renderer, so it IS the string the formula's `url` line will hold.
  // The job hashes the bytes this URL serves; see tagTarballUrl for why it is not
  // spelled a second time in the workflow. It is also computed before the clone, so
  // an unusable --version fails before anything is fetched.
  const url = tagTarballUrl(version)

  cloneTap(remote, into)
  const formula = tapFormula(into)

  // The formula's OWN url line is the version marker, not a regex over the tag: the
  // question is whether the tap already points at these exact bytes, and the url is
  // the only line that says so. A tap carrying 0.25.40 cannot look like 0.25.4 this
  // way, which a substring match on the bare version could.
  const carries = formula !== null && formula.includes(`url "${url}"`)

  process.stdout.write(`version=${version}\ntarball_url=${url}\ncarries_version=${carries}\n`)

  // stderr, so the run log carries the reason even though stdout is redirected into
  // $GITHUB_OUTPUT. This is the "says so in the log" half of #202's skip criterion.
  if (carries) {
    process.stderr.write(`The tap already carries ${version} — nothing to render, nothing to push.\n`)
  } else if (formula === null) {
    process.stderr.write(
      `The tap has no ${FORMULA_PATH} (an empty tap reads the same way) — will render ${version}.\n`,
    )
  } else {
    process.stderr.write(`The tap carries some other version — will render ${version}.\n`)
  }
}

const argv = process.argv.slice(2)
try {
  if (argv.includes('--help') || argv.includes('-h')) process.stdout.write(`${USAGE}\n`)
  else main(argv)
} catch (error) {
  process.stderr.write(`homebrew-tap-plan: ${error.message}\n`)
  process.exit(1)
}
