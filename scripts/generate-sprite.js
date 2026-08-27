#!/usr/bin/env node
// #66 — the GIF-to-sprite generator: `node scripts/generate-sprite.js ralph.gif`
//
// DEVELOPMENT ONLY, AND NOT PUBLISHED. package.json's `files` is an ALLOW-LIST
// ("bin", "lib", "templates", and two markdown files), so everything under
// scripts/ is outside the npm tarball by construction — there is no ignore rule
// to keep in sync, and test/sprite-generate-cli.test.js guards the allow-list
// against an entry that would drag this in.
//
// The source Wreck-It Ralph GIF is likewise NOT committed: it is an input a
// developer points this at, which is why the path is an argument and not a
// constant. The OUTPUT, though, is committed as of #67 — lib/sprite-data.js is a
// tracked file that ships in the tarball, so rerunning this overwrites it and the
// diff belongs in the commit.
//
// This file is the ONLY part of the pipeline that touches the filesystem. Every
// decision — decoding, compositing, transparency, downsampling, quantizing,
// formatting — lives in the pure modules under scripts/lib/, so all of it is
// testable from synthesized bytes and none of it can read a clock. That is what
// makes rerunning the generator produce byte-identical output.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decodeGif } from './lib/gif-decode.js'
import {
  buildSprite,
  DEFAULT_COLOR_COUNT,
  DEFAULT_GRID,
  NEAR_BLACK_MAX,
} from './lib/sprite-build.js'
import { emitSpriteModule } from './lib/emit-sprite-module.js'

const DEFAULT_OUT = 'lib/sprite-data.js'

const USAGE = `usage: node scripts/generate-sprite.js <source.gif> [options]

  --out <path>          where to write the data module (default: ${DEFAULT_OUT})
  --width <cells>       target grid width (default: ${DEFAULT_GRID.width})
  --height <cells>      target grid height (default: ${DEFAULT_GRID.height})
  --colors <n>          palette size, shared by all frames (default: ${DEFAULT_COLOR_COUNT})
  --near-black <sum>    channel sum at or below which a pixel counts as
                        transparent (default: ${NEAR_BLACK_MAX})

The defaults are the measured values for the source asset: a 303x394 bounding box
downsamples to ${DEFAULT_GRID.width}x${DEFAULT_GRID.height} within 0.2% of its aspect ratio, and its background is
opaque near-black rather than the transparency index the file declares.`

function usageError(message) {
  return new Error(`${message}\n\n${USAGE}`)
}

function positiveInteger(raw, flag) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw usageError(`${flag} needs a positive integer (got ${JSON.stringify(raw ?? '')})`)
  }
  return value
}

/**
 * Hand-rolled argv parsing: `commander` is a runtime dependency of the published
 * CLI, and a development-only script has no business widening what the package
 * ships with. Unknown flags are rejected rather than ignored, so a typo cannot
 * silently produce a sprite with default settings.
 *
 * @param {string[]} argv process.argv.slice(2)
 */
function parseArgs(argv) {
  const options = {
    input: null,
    out: DEFAULT_OUT,
    grid: { ...DEFAULT_GRID },
    colorCount: DEFAULT_COLOR_COUNT,
    nearBlackMax: NEAR_BLACK_MAX,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') {
      options.out = argv[i + 1]
      if (!options.out) throw usageError('--out needs a path')
      i += 1
    } else if (arg === '--width') {
      options.grid.width = positiveInteger(argv[i + 1], '--width')
      i += 1
    } else if (arg === '--height') {
      options.grid.height = positiveInteger(argv[i + 1], '--height')
      i += 1
    } else if (arg === '--colors') {
      options.colorCount = positiveInteger(argv[i + 1], '--colors')
      i += 1
    } else if (arg === '--near-black') {
      const value = Number(argv[i + 1])
      if (!Number.isInteger(value)) {
        throw usageError(`--near-black needs an integer (got ${JSON.stringify(argv[i + 1] ?? '')})`)
      }
      options.nearBlackMax = value
      i += 1
    } else if (arg.startsWith('-')) {
      throw usageError(`unknown option ${arg}`)
    } else if (options.input === null) {
      options.input = arg
    } else {
      throw usageError(`unexpected extra argument ${JSON.stringify(arg)}`)
    }
  }

  if (options.input === null) throw usageError('no source GIF given')
  return options
}

function main(argv) {
  const options = parseArgs(argv)
  const bytes = new Uint8Array(readFileSync(resolve(options.input)))
  const sprite = buildSprite(decodeGif(bytes), {
    grid: options.grid,
    colorCount: options.colorCount,
    nearBlackMax: options.nearBlackMax,
  })
  const outPath = resolve(options.out)
  writeFileSync(outPath, emitSpriteModule(sprite))

  const { box, source, palette, frames } = sprite
  process.stdout.write(
    `wrote ${options.out}\n` +
      `  source      ${source.width}x${source.height}, ${frames.length} frame(s)\n` +
      `  bounding    ${box.width}x${box.height} at (${box.left}, ${box.top})\n` +
      `  grid        ${sprite.width}x${sprite.height} cells\n` +
      `  palette     ${palette.length} colour(s), shared by every frame\n` +
      `  delays      ${frames.map((frame) => `${frame.delayMs}ms`).join(', ')}\n`,
  )
}

const argv = process.argv.slice(2)
try {
  // Asking for help is not an error, so it goes to stdout and exits 0. Every
  // other usage problem is a failed run: usage on stderr, non-zero status, so a
  // typo in a Makefile or a CI step cannot look like a successful regeneration.
  if (argv.includes('--help') || argv.includes('-h')) process.stdout.write(`${USAGE}\n`)
  else main(argv)
} catch (error) {
  process.stderr.write(`generate-sprite: ${error.message}\n`)
  process.exit(1)
}
