// #67 QA — the one thing about this feature that cannot be caught by a unit test:
// WHAT SHIPS.
//
// The sprite arrives in the package as two new published files, and its generator
// arrives as a development-only tree that imports the GIF encoder out of test/. That
// is a legal arrangement exactly as long as no published file has a path into an
// unpublished one, and `files` in package.json is an allow-list rather than a
// denylist — so a mistake here is not a failing test, it is a broken `npm i -g`.
//
// This file guards it by ASKING NPM rather than by reading the `files` patterns:
// `npm pack --dry-run --json` is the tarball manifest itself, so:
//
//   * the three sprite modules must be in it and the whole placeholder pipeline must
//     not be;
//   * every relative import in every packed .js file must resolve to a path that is
//     ALSO in it — a closure check that catches an edge the grep cannot spell, such as
//     a dynamic `import()`, a specifier that reaches sideways rather than into a named
//     tree, or a lib/ file that will simply not be published.
//
// The rest of the file covers what the placeholder CLI does when a developer gets it
// wrong, and the two art invariants the dev's round-trip spec depends on without
// asserting: a legend with no duplicate colours, and a palette that is exactly the
// art's ink.
//
// LIKE ITS SIBLING, this file is deleted with the placeholder — EXCEPT the packaging
// block, which is about the published package and not the stand-in art: MOVE it, do
// not drop it. `node scripts/placeholder-sprite-source.js` prints the full checklist.

import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from './helpers/source-code.js'
import { ART_FRAMES, LEGEND, placeholderGif } from '../scripts/lib/placeholder-art.js'
import { palette } from '../lib/sprite-data.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'scripts', 'placeholder-sprite-source.js')

// The tarball manifest, from npm rather than from a reading of package.json: a
// `files` entry is a pattern, and what a pattern actually matches is npm's opinion.
// `--dry-run` writes nothing. Memoized because the manifest cannot change inside one
// run and the subprocess costs ~350ms.
let manifest
function packedFiles() {
  if (!manifest) {
    const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    manifest = JSON.parse(stdout)[0].files.map((entry) => entry.path)
  }
  return manifest
}

// Static and dynamic specifiers alike: `from '…'` and `import('…')`.
const SPECIFIER = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g

describe('QA packaging — the sprite ships and the pipeline that made it does not', () => {
  it('publishes the three sprite modules', () => {
    const packed = packedFiles()
    for (const path of ['lib/sprite-banner.js', 'lib/sprite-data.js', 'lib/sprite-render.js']) {
      expect(packed, path).toContain(path)
    }
  })

  it('publishes nothing from scripts/ or test/, and no spec file at all', () => {
    // The placeholder pipeline is three files — two under scripts/ and one under
    // test/ — and the asset it produced is the only trace of it that may ship.
    const packed = packedFiles()
    expect(packed.filter((path) => /^(scripts|test)\//.test(path))).toEqual([])
    expect(packed.filter((path) => /\.test\.js$/.test(path))).toEqual([])
    expect(packed).not.toContain('scripts/lib/placeholder-art.js')
    expect(packed).not.toContain('test/helpers/gif-fixture.js')
  })

  it('leaves no published file importing a file that is not published', () => {
    // The closure check. Every relative edge out of every packed module has to land
    // inside the tarball, or the package installs and then throws ERR_MODULE_NOT_FOUND
    // on the first import — which is what an import from lib/ into scripts/ or test/
    // would do, and also what a lib/ file excluded by a future `files` edit would do.
    const packed = packedFiles()
    const packedSet = new Set(packed)
    const offenders = []
    for (const path of packed.filter((entry) => entry.endsWith('.js'))) {
      const source = readFileSync(join(REPO_ROOT, path), 'utf8')
      for (const match of source.matchAll(SPECIFIER)) {
        const specifier = match[1]
        // Bare specifiers are dependencies, and package.json declares those.
        if (!specifier.startsWith('.')) continue
        const target = relative(REPO_ROOT, resolve(dirname(join(REPO_ROOT, path)), specifier))
        if (!packedSet.has(target)) offenders.push(`${path} → ${specifier} (${target})`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('confirms the edge that makes the check necessary: the art borrows the test encoder', () => {
    // Not a hypothetical. scripts/lib/placeholder-art.js imports the GIF ENCODER from
    // test/helpers/gif-fixture.js on purpose (see its header), so the closure above is
    // guarding a real edge from a real dev-only tree — and it stays legal only because
    // nothing published reaches that module.
    const art = readFileSync(join(REPO_ROOT, 'scripts', 'lib', 'placeholder-art.js'), 'utf8')
    expect(art).toMatch(/from '\.\.\/\.\.\/test\/helpers\/gif-fixture\.js'/)
    const packedSet = new Set(packedFiles())
    expect(packedSet.has('scripts/lib/placeholder-art.js')).toBe(false)
    expect(packedSet.has('test/helpers/gif-fixture.js')).toBe(false)
  })
})

describe('QA scripts/placeholder-sprite-source.js — the CLI, misused', () => {
  it('treats --help and -h as a successful run, on stdout', () => {
    // The script's own claim: asking for help is not an error. A non-zero exit here
    // would break any wrapper that checks the status of `--help`.
    for (const flag of ['--help', '-h']) {
      const result = spawnSync(process.execPath, [SCRIPT, flag], { encoding: 'utf8' })
      expect(result.status, flag).toBe(0)
      expect(result.stdout, flag).toContain('usage: node scripts/placeholder-sprite-source.js')
      expect(result.stderr, flag).toBe('')
    }
  })

  it('refuses --out with no path instead of writing somewhere surprising', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--out'], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('--out needs a path')
    expect(result.stdout).toBe('')
  })

  it('rejects a positional argument, which this script has no use for', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'ralph.gif'], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unknown option ralph\.gif/)
  })
})

describe('QA the placeholder art — the invariants the round trip depends on', () => {
  it('maps no two legend characters to the same colour', () => {
    // The round-trip spec reads the asset back through a colour→character map. Two
    // characters sharing a colour would make that map lossy and the round trip would
    // pass while the picture was wrong.
    const colours = [...LEGEND.values()].map((colour) => colour.join(','))
    expect(new Set(colours).size).toBe(colours.length)
  })

  it('agrees with the committed palette, colour for colour', () => {
    // Asset ↔ art, checked as a SET rather than by regenerating the module: the
    // emitter sorts the palette, and the background is transparent so it is not in it.
    // A colour in one and not the other means the two halves of the pipeline were run
    // at different times.
    const art = new Set([...LEGEND.values()].map((colour) => colour.join(',')))
    const asset = new Set(palette.map((colour) => colour.join(',')))
    expect([...asset].sort()).toEqual([...art].sort())
  })

  it('does not mutate the art while encoding it', () => {
    // `placeholderGif()` paints straight from ART_FRAMES; a normalisation done in
    // place would make the second call — and therefore the determinism the committed
    // asset rests on — a different picture.
    const before = structuredClone(ART_FRAMES)
    const legendBefore = [...LEGEND.entries()]
    placeholderGif()
    expect(ART_FRAMES).toEqual(before)
    expect([...LEGEND.entries()]).toEqual(legendBefore)
  })

  it('reaches no clock, no randomness and no filesystem of its own', () => {
    // The determinism of lib/sprite-data.js rests on this module being a pure function
    // of its own literals: the CLI wrapper owns the one write.
    const code = codeWithoutComments(join(REPO_ROOT, 'scripts', 'lib', 'placeholder-art.js'))
    expect(code).not.toMatch(/\bprocess\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/node:(fs|os|child_process)/)
  })
})
