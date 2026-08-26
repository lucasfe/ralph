// #66 — the emitted data module's spec.
//
// The generator's output is source code, and the only way to be sure generated
// source is source is to run it. So these specs write the emitted text into a
// throwaway directory and `import()` it: a stray comma, a bad escape or a
// half-quoted row string fails here instead of at the first `ralph start` after
// someone regenerates the sprite.
//
// The other half of the file is shape: the renderer that ships in lib/ has a
// contract (palette of RGB triples, one index-row string per pixel row) and the
// emitter is the only thing that writes to it. Asserting the two agree — by
// feeding the imported module straight into renderSprite — is what keeps the
// generator and the renderer from drifting while both stay individually green.

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeGif } from '../scripts/lib/gif-decode.js'
import { buildSprite } from '../scripts/lib/sprite-build.js'
import { emitSpriteModule } from '../scripts/lib/emit-sprite-module.js'
import { renderSprite } from '../lib/sprite-render.js'
import { buildGif } from './helpers/gif-fixture.js'

const workDirs = []

afterAll(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true })
})

/** Writes module text to a throwaway directory and imports it for real. */
async function importModuleText(text, name) {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-sprite-emit-'))
  workDirs.push(dir)
  const file = join(dir, name)
  writeFileSync(file, text)
  return import(pathToFileURL(file).href)
}

// A 4x3 screen with a near-black background and a plus-shaped blob of two
// colours, over two frames, downsampled 1:1 so the fixture stays readable.
const BACKGROUND = [8, 8, 8]
const INK = [210, 40, 30]
const OTHER = [20, 120, 210]

function spriteFixture() {
  const bytes = buildGif({
    width: 4,
    height: 3,
    palette: [BACKGROUND, INK, OTHER],
    frames: [
      { width: 4, height: 3, indices: [0, 1, 0, 0, 1, 1, 1, 0, 0, 2, 0, 0], delayCs: 20, disposal: 1 },
      { width: 4, height: 3, indices: [0, 2, 0, 0, 2, 2, 2, 0, 0, 1, 0, 0], delayCs: 20, disposal: 1 },
    ],
  })
  return buildSprite(decodeGif(bytes), { grid: { width: 3, height: 3 }, colorCount: 2 })
}

describe('emitSpriteModule — text shape', () => {
  // Emitted per test rather than once per describe: work done while the suite is
  // being COLLECTED reports as "0 tests in this file" instead of a named failure.
  const emit = () => emitSpriteModule(spriteFixture())

  it('opens with a do-not-edit banner naming the generator', () => {
    const text = emit()
    expect(text.split('\n')[0]).toMatch(/generated/i)
    expect(text).toMatch(/scripts\/generate-sprite\.js/)
    expect(text).toMatch(/#66/)
  })

  it('ends with exactly one trailing newline', () => {
    const text = emit()
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })

  it('embeds no timestamp, hostname or absolute path', () => {
    const text = emit()
    // Criterion 3 is byte-identical reruns, and a "generated at" line is the
    // classic way to lose it.
    expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
    expect(text).not.toMatch(/generated (at|on)\b/i)
    expect(text).not.toMatch(/\/(Users|home)\//)
  })

  it('quotes every index row as a single-quoted string', () => {
    const text = emit()
    expect(text).toMatch(/rows: \[/)
    for (const row of spriteFixture().frames[0].rows) {
      expect(text).toContain(`'${row}'`)
    }
  })
})

describe('emitSpriteModule — the emitted module runs', () => {
  it('imports as ESM and exports the palette as RGB triples', async () => {
    const sprite = spriteFixture()
    const mod = await importModuleText(emitSpriteModule(sprite), 'sprite-data.js')

    expect(mod.palette).toEqual(sprite.palette)
    expect(mod.palette.length).toBeGreaterThan(0)
    for (const entry of mod.palette) {
      expect(entry).toHaveLength(3)
      for (const channel of entry) {
        expect(Number.isInteger(channel)).toBe(true)
        expect(channel).toBeGreaterThanOrEqual(0)
        expect(channel).toBeLessThanOrEqual(255)
      }
    }
  })

  it('exports frames as delayMs plus one row string per pixel row', async () => {
    const sprite = spriteFixture()
    const mod = await importModuleText(emitSpriteModule(sprite), 'sprite-data.js')

    expect(mod.spriteWidth).toBe(3)
    expect(mod.spriteHeight).toBe(3)
    expect(mod.frames).toHaveLength(2)
    for (const frame of mod.frames) {
      expect(frame.delayMs).toBe(200)
      expect(frame.rows).toHaveLength(3)
      for (const row of frame.rows) expect(row).toHaveLength(3)
    }
    expect(mod.frames).toEqual(sprite.frames)
  })

  it('round-trips through the shipped renderer', async () => {
    const mod = await importModuleText(emitSpriteModule(spriteFixture()), 'sprite-data.js')
    for (const frame of mod.frames) {
      const lines = renderSprite({ palette: mod.palette, rows: frame.rows })
      // Three pixel rows pair into two text rows, the last against transparency.
      expect(lines).toHaveLength(2)
      for (const line of lines) expect(typeof line).toBe('string')
    }
  })

  it('emits the same text for the same sprite, twice', () => {
    expect(emitSpriteModule(spriteFixture())).toBe(emitSpriteModule(spriteFixture()))
  })
})
