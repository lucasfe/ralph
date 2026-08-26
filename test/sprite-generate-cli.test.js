// #66 — the generator script itself, run the way a developer runs it.
//
// The pure stages have their own specs; what is left is the thin I/O shell and
// two acceptance criteria that only exist at the file level:
//
//   * "Running the generator twice on the same input produces byte-identical
//     output." Two calls to a pure function inside one process is the weaker
//     version of that claim — a module-level cache or a lazily seeded map would
//     survive it. Two SPAWNS, compared byte for byte, is the claim itself.
//   * "…and is excluded from the published `files` list." package.json's `files`
//     is an allow-list (bin, lib, templates, two markdown files), so scripts/ is
//     already outside the tarball. That is easy to break by adding one entry, so
//     the guard asserts the allow-list, not the absence of an ignore rule.
//
// No GIF is committed (the issue is explicit), so the fixture is synthesized
// into a temp dir by test/helpers/gif-fixture.js and the output is written there
// too — nothing under lib/ is touched by running these specs.

import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGif } from './helpers/gif-fixture.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const GENERATOR = join(REPO_ROOT, 'scripts', 'generate-sprite.js')

const workDirs = []

afterAll(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true })
})

function workDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-sprite-cli-'))
  workDirs.push(dir)
  return dir
}

// A 12x16 two-frame GIF with a near-black background and four ink colours, so
// the quantizer has something to cluster and the two frames differ.
function gifFixture() {
  const palette = [
    [8, 8, 8],
    [210, 40, 30],
    [20, 120, 210],
    [240, 220, 60],
    [30, 160, 90],
  ]
  const frame = (shift) => {
    const indices = []
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 12; x += 1) {
        const inside = x > 0 && x < 11 && y > 0 && y < 15
        indices.push(inside ? 1 + ((x + y + shift) % 4) : 0)
      }
    }
    return { width: 12, height: 16, indices, delayCs: 20, disposal: 1 }
  }
  return buildGif({ width: 12, height: 16, palette, frames: [frame(0), frame(1)] })
}

// spawnSync rather than execFileSync: a failing run is an EXPECTED outcome in
// half these specs, and asserting on `stderr` beats pattern-matching whatever
// exec chooses to put in an exception message.
function runGenerator(args, cwd) {
  return spawnSync(process.execPath, [GENERATOR, ...args], { cwd, encoding: 'utf8' })
}

function runOk(args, cwd) {
  const result = runGenerator(args, cwd)
  expect(result.status, `generator failed:\n${result.stderr}`).toBe(0)
  return result
}

describe('scripts/generate-sprite.js', () => {
  it('writes a data module for the GIF it is pointed at', () => {
    const dir = workDir()
    writeFileSync(join(dir, 'ralph.gif'), gifFixture())
    runOk(['ralph.gif', '--out', 'sprite-data.js', '--width', '6', '--height', '8'], dir)

    const emitted = readFileSync(join(dir, 'sprite-data.js'), 'utf8')
    expect(emitted).toMatch(/export const palette/)
    expect(emitted).toMatch(/export const frames/)
    expect(emitted).toMatch(/export const spriteWidth = 6/)
    expect(emitted).toMatch(/export const spriteHeight = 8/)
  })

  it('produces byte-identical output when run twice on the same input', () => {
    const dir = workDir()
    writeFileSync(join(dir, 'ralph.gif'), gifFixture())
    runOk(['ralph.gif', '--out', 'first.js'], dir)
    runOk(['ralph.gif', '--out', 'second.js'], dir)

    const first = readFileSync(join(dir, 'first.js'))
    const second = readFileSync(join(dir, 'second.js'))
    expect(first.equals(second)).toBe(true)
    expect(first.length).toBeGreaterThan(0)
  })

  it('fails loudly when the input is not a GIF', () => {
    const dir = workDir()
    writeFileSync(join(dir, 'not.gif'), 'this is not a GIF at all')
    const result = runGenerator(['not.gif', '--out', 'out.js'], dir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/signature|GIF/i)
  })

  it('fails loudly when no input path is given', () => {
    const result = runGenerator([], workDir())
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/usage/i)
  })

  it('rejects an unknown flag instead of ignoring it', () => {
    const dir = workDir()
    writeFileSync(join(dir, 'ralph.gif'), gifFixture())
    const result = runGenerator(['ralph.gif', '--colours', '8'], dir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unknown|usage/i)
  })
})

describe('packaging: the generator is development-only', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

  it('keeps scripts/ out of the published files allow-list', () => {
    // The allow-list is what publishes; an entry for scripts (or a bare '.' or
    // '*') would drag the generator into the tarball.
    expect(pkg.files).toBeDefined()
    for (const entry of pkg.files) {
      expect(entry.startsWith('!') || !/scripts/.test(entry)).toBe(true)
      expect(['.', '*', './']).not.toContain(entry)
    }
  })

  it('ships the renderer, which is the half that is not development-only', () => {
    expect(pkg.files).toContain('lib')
  })

  it('adds no dependency for GIF decoding', () => {
    // The whole point of hand-rolling GIF89a: no sharp, no jimp, no gifuct, and
    // nothing new in devDependencies either.
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['commander', 'execa', 'picocolors'])
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(['memfs', 'vitest'])
  })
})
