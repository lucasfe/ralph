#!/usr/bin/env node
// #197 — the Homebrew formula generator:
// `node scripts/generate-homebrew-formula.js --sha256 <digest> [--version 1.2.3] [--out path]`
//
// DEVELOPMENT ONLY, AND NOT PUBLISHED. package.json's `files` is an allow-list
// ("bin", "lib", "templates", and two markdown files), so everything under
// scripts/ is outside the npm tarball by construction — there is no ignore rule
// to keep in sync.
//
// ARGUMENT PLUMBING ONLY. Not one word of Ruby lives here: this reads the
// package's own metadata, parses flags, and hands both to
// scripts/lib/render-homebrew-formula.js, which owns every line of the formula.
// test/homebrew-formula.test.js asserts that split from both ends — this file is
// checked for Ruby it must not contain, and its stdout is compared byte for byte
// against the renderer's output for package.json's fields.
//
// The digest is an ARGUMENT rather than something computed here: fetching the
// tarball to hash it would make what this prints depend on the network at the
// moment it ran. A release job — none exists yet; it is a later slice of #196 —
// would fetch it once and pass it in, and running this twice with the same flags
// stays a way to get the same formula.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderFormula } from './lib/render-homebrew-formula.js'

// Resolved from this file, not from the working directory: a release job runs
// from wherever it happens to be checked out, and the version being packaged is
// this repository's, not that of whatever package.json is nearest to cwd.
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url))
const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))

const USAGE = `usage: node scripts/generate-homebrew-formula.js --sha256 <digest> [options]

  --sha256 <hex>        sha256 of the release tag's source tarball, 64 hex
                        characters: \`curl -sL <tag tarball> | shasum -a 256\`
  --version <x.y.z>     version to render (default: this package.json's, ${pkg.version})
  --out <path>          where to write the formula (default: stdout)

The digest is not computed here on purpose: it belongs to a remote artifact, so a
caller fetches it once and passes it in, and this stays reproducible.`

function usageError(message) {
  return new Error(`${message}\n\n${USAGE}`)
}

/**
 * Hand-rolled argv parsing, following scripts/generate-sprite.js: `commander` is a
 * runtime dependency of the published CLI, and a development-only script has no
 * business widening what the package ships with. Unknown flags are rejected rather
 * than ignored, so a typo cannot quietly render a formula for the wrong tag.
 *
 * @param {string[]} argv process.argv.slice(2)
 */
function parseArgs(argv) {
  const options = { sha256: null, version: pkg.version, out: null }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--sha256') {
      options.sha256 = argv[i + 1]
      if (!options.sha256) throw usageError('--sha256 needs a digest')
      i += 1
    } else if (arg === '--version') {
      options.version = argv[i + 1]
      if (!options.version) throw usageError('--version needs a version')
      i += 1
    } else if (arg === '--out') {
      options.out = argv[i + 1]
      if (!options.out) throw usageError('--out needs a path')
      i += 1
    } else if (arg.startsWith('-')) {
      throw usageError(`unknown option ${arg}`)
    } else {
      throw usageError(`unexpected argument ${JSON.stringify(arg)}`)
    }
  }

  if (options.sha256 === null) throw usageError('no --sha256 digest given')
  return options
}

function main(argv) {
  const options = parseArgs(argv)
  const formula = renderFormula({
    version: options.version,
    sha256: options.sha256,
    description: pkg.description,
    homepage: pkg.homepage,
    license: pkg.license,
  })

  // Rendering happens before anything is written, so a rejected version or digest
  // leaves no half-written formula for a release job to pick up.
  if (options.out === null) {
    process.stdout.write(formula)
    return
  }
  writeFileSync(resolve(options.out), formula)
  process.stdout.write(`wrote ${options.out}\n  version     ${options.version}\n  sha256      ${options.sha256}\n`)
}

const argv = process.argv.slice(2)
try {
  // Asking for help is not an error, so it goes to stdout and exits 0. Every other
  // usage problem is a failed run: usage on stderr, non-zero status, so a bad flag
  // in a release job cannot look like a successful render.
  if (argv.includes('--help') || argv.includes('-h')) process.stdout.write(`${USAGE}\n`)
  else main(argv)
} catch (error) {
  process.stderr.write(`generate-homebrew-formula: ${error.message}\n`)
  process.exit(1)
}
