#!/usr/bin/env node
// ============================================================================
//  #67 — PLACEHOLDER SOURCE GIF. THE REAL ART IS MISSING.
//
//  lib/sprite-data.js, the sprite `ralph start` prints, was NOT generated from a
//  Wreck-It Ralph GIF. There is no such GIF in this repository and there never
//  was one: #66 deliberately made it a developer-supplied input (which is why
//  scripts/generate-sprite.js takes a path instead of a constant), and #67 had
//  to commit a data module regardless. So this script synthesizes a stand-in —
//  a blocky, original, obviously-not-Ralph figure — and the committed asset is
//  that stand-in put through the REAL generator, unedited.
//
//  SWAPPING IT IN IS ONE COMMAND:
//
//      node scripts/generate-sprite.js ralph.gif
//
//  That regenerates lib/sprite-data.js from the real art with the same defaults
//  (26x34, 12 colours, near-black 24) and nothing else has to change: no test
//  pins a pixel or a colour. Afterwards a handful of placeholder files get
//  deleted together — main() below prints that checklist when you run this
//  script, and that stdout is its one canonical copy.
// ============================================================================
//
// DEVELOPMENT ONLY, AND NOT PUBLISHED — same story as its sibling generator:
// package.json's `files` is an ALLOW-LIST ("bin", "lib", "templates" and two
// markdown files), so everything under scripts/ is outside the npm tarball by
// construction. test/sprite-placeholder-source.qa.test.js proves it against the real
// `npm pack` manifest, which matters here because the art module borrows the GIF
// encoder from the test tree (see its header for why).
//
// Like the generator, this file is the only part of its pipeline that touches the
// filesystem. The bytes come from scripts/lib/placeholder-art.js, which is pure —
// no clock, no randomness — so two runs produce an identical GIF and therefore an
// identical lib/sprite-data.js.

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { placeholderGif } from './lib/placeholder-art.js'

// A fixed path under the OS temp directory, not somewhere in the repo: the GIF is
// scaffolding for one `generate-sprite.js` invocation, and a stray binary in the
// working tree would be one more thing to gitignore and one more thing to
// accidentally commit. Fixed rather than randomised so the follow-up command this
// script prints can be copied without editing.
const DEFAULT_OUT = join(tmpdir(), 'ralph-placeholder-sprite.gif')

const USAGE = `usage: node scripts/placeholder-sprite-source.js [options]

  --out <path>   where to write the placeholder GIF
                 (default: ${DEFAULT_OUT})

Writes a deterministic 112x144 two-frame GIF standing in for the real Wreck-It
Ralph art, which this repository does not carry. Feed it to the generator:

  node scripts/generate-sprite.js "${DEFAULT_OUT}"

When the real GIF arrives, skip this script entirely and run

  node scripts/generate-sprite.js ralph.gif`

function usageError(message) {
  return new Error(`${message}\n\n${USAGE}`)
}

/**
 * Hand-rolled argv parsing, for the same reason generate-sprite.js does it:
 * `commander` is a runtime dependency of the published CLI and a development-only
 * script has no business widening what the package ships. Unknown flags are
 * rejected rather than ignored, so `--wdith 26` cannot look like a successful run
 * that quietly used the defaults.
 *
 * @param {string[]} argv process.argv.slice(2)
 */
function parseArgs(argv) {
  const options = { out: DEFAULT_OUT }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') {
      options.out = argv[i + 1]
      if (!options.out) throw usageError('--out needs a path')
      i += 1
    } else {
      // Positional arguments are rejected too: this script has no input to name.
      throw usageError(`unknown option ${arg}`)
    }
  }

  return options
}

function main(argv) {
  const options = parseArgs(argv)
  const outPath = resolve(options.out)
  writeFileSync(outPath, placeholderGif())

  process.stdout.write(
    `wrote ${outPath}\n` +
      `  PLACEHOLDER art — this is not the real Wreck-It Ralph GIF, which this\n` +
      `  repository does not carry. Generate the data module from it with:\n` +
      `\n` +
      `    node scripts/generate-sprite.js "${outPath}"\n` +
      `\n` +
      `  When you have the real GIF, run scripts/generate-sprite.js against that\n` +
      `  instead and delete all four placeholder files:\n` +
      `\n` +
      `    scripts/placeholder-sprite-source.js\n` +
      `    scripts/lib/placeholder-art.js\n` +
      `    test/sprite-placeholder-source.test.js\n` +
      `    test/sprite-placeholder-source.qa.test.js\n` +
      `\n` +
      `  Both spec files go red on swap. In the .qa one, keep or MOVE the packaging\n` +
      `  block (the "npm pack" manifest closure check) — it guards what the published\n` +
      `  tarball contains and is worth having either way.\n`,
  )
}

const argv = process.argv.slice(2)
try {
  // Asking for help is not an error, so it goes to stdout and exits 0. Every other
  // usage problem is a failed run: usage on stderr, non-zero status.
  if (argv.includes('--help') || argv.includes('-h')) process.stdout.write(`${USAGE}\n`)
  else main(argv)
} catch (error) {
  process.stderr.write(`placeholder-sprite-source: ${error.message}\n`)
  process.exit(1)
}
