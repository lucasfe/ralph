// #66 — the GIF89a decoder's spec.
//
// The pipeline's input is a GIF that is NOT in the repo, so every expectation
// here comes from one of two places: bytes found in the wild (the two anchors at
// the top, one of which is hand-derived bit by bit) or bytes synthesized by
// test/helpers/gif-fixture.js. The anchors exist because the fixture encoder and
// the decoder were written by the same hand and could agree on a shared
// off-by-one; a byte sequence nobody here produced cannot be wrong in the same
// direction.

import { describe, it, expect } from 'vitest'
import { decodeGif } from '../scripts/lib/gif-decode.js'
import {
  buildGif,
  commentExtension,
  countSubBlocks,
  lzwCodeStream,
  netscapeLoopExtension,
  plainTextExtension,
  TRANSPARENT_1PX_GIF_BASE64,
} from './helpers/gif-fixture.js'

// The 4-colour table the synthetic fixtures share, so a spec can talk about
// "index 2" and mean green everywhere.
const QUAD = [
  [0, 0, 0],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
]

describe('decodeGif — anchors against bytes this repo did not encode', () => {
  it('decodes the canonical 1x1 transparent GIF found in the wild', () => {
    const bytes = new Uint8Array(Buffer.from(TRANSPARENT_1PX_GIF_BASE64, 'base64'))
    const gif = decodeGif(bytes)

    expect(gif.width).toBe(1)
    expect(gif.height).toBe(1)
    expect(gif.frames).toHaveLength(1)

    const [frame] = gif.frames
    expect([...frame.indices]).toEqual([0])
    // Its global colour table is black + white, in that order.
    expect(frame.palette).toEqual([
      [0, 0, 0],
      [255, 255, 255],
    ])
    // Its graphic control extension declares index 0 transparent, no delay, no
    // disposal.
    expect(frame.transparentIndex).toBe(0)
    expect(frame.delayMs).toBe(0)
    expect(frame.disposal).toBe(0)
    expect(frame.interlaced).toBe(false)
    expect({ left: frame.left, top: frame.top, width: frame.width, height: frame.height }).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 1,
    })
  })

  it('tolerates that same file having no EOI code and no trailer byte', () => {
    // Both quirks are real and both are in that 41-byte file, so the assertion
    // above already depends on the tolerance. This test states it outright so a
    // future "stricter" decoder fails with a message about the right thing.
    const bytes = new Uint8Array(Buffer.from(TRANSPARENT_1PX_GIF_BASE64, 'base64'))
    expect(bytes[bytes.length - 1]).not.toBe(0x3b)
    // 0x02 min code size, 0x01 one-byte sub-block, 0x44 payload, 0x00 terminator:
    // eight bits hold the 3-bit clear code and the 3-bit literal and nothing else,
    // so the end-of-information code was never written.
    expect([...bytes.slice(-4)]).toEqual([0x02, 0x01, 0x44, 0x00])
    expect(() => decodeGif(bytes)).not.toThrow()
  })

  it('decodes a 2x2 GIF whose bitstream is derived by hand below', () => {
    // Hand-derived, so that no helper in this repo is party to the expectation.
    //
    // Pixels are indices 0,1,2,3 (one of each palette entry, row-major).
    // minCodeSize = 2 → clear = 4, EOI = 5, first assignable code = 6, width = 3.
    //   emit clear(4)                          width 3
    //   emit 0    (first code: no table entry) width 3
    //   emit 1    (assigns 6; 7 still fits)    width 3
    //   emit 2    (assigns 7; next is 8 = 2^3 → width becomes 4)
    //   emit 3                                 width 4
    //   emit EOI(5)                            width 4
    // Packed LSB-first, low bits of each code first:
    //   4 -> 0,0,1   0 -> 0,0,0   1 -> 1,0,0   2 -> 0,1,0
    //   3 -> 1,1,0,0             5 -> 1,0,1,0
    //   byte0 bits 0..7  = 0,0,1,0,0,0,1,0 -> 1<<2 | 1<<6 = 0x44
    //   byte1 bits 8..15 = 0,0,1,0,1,1,0,0 -> 1<<2 | 1<<4 | 1<<5 = 0x34
    //   byte2 bits 16..19 = 1,0,1,0 (zero-padded)  -> 1<<0 | 1<<2 = 0x05
    const bytes = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
      0x02, 0x00, 0x02, 0x00, // logical screen 2x2
      0x91, // global colour table, 4 entries (size bits 1)
      0x00, 0x00, // background index, pixel aspect ratio
      0x00, 0x00, 0x00, // 0 black
      0xff, 0x00, 0x00, // 1 red
      0x00, 0xff, 0x00, // 2 green
      0x00, 0x00, 0xff, // 3 blue
      0x2c, // image descriptor (no graphic control extension at all)
      0x00, 0x00, 0x00, 0x00, // left 0, top 0
      0x02, 0x00, 0x02, 0x00, // 2x2
      0x00, // no local colour table, not interlaced
      0x02, // LZW minimum code size
      0x03, 0x44, 0x34, 0x05, // one 3-byte sub-block
      0x00, // block terminator
      0x3b, // trailer
    ])

    const gif = decodeGif(bytes)
    expect(gif.width).toBe(2)
    expect(gif.height).toBe(2)
    expect(gif.frames).toHaveLength(1)
    expect([...gif.frames[0].indices]).toEqual([0, 1, 2, 3])
    expect(gif.frames[0].palette).toEqual(QUAD)
    // No graphic control extension means no declared transparency at all.
    expect(gif.frames[0].transparentIndex).toBe(null)
    expect(gif.frames[0].delayMs).toBe(0)
  })
})

describe('decodeGif — headers and colour tables', () => {
  it('reads the logical screen descriptor', () => {
    const gif = decodeGif(
      buildGif({
        width: 7,
        height: 5,
        palette: QUAD,
        frames: [{ width: 7, height: 5, indices: new Array(35).fill(1) }],
      }),
    )
    expect(gif.width).toBe(7)
    expect(gif.height).toBe(5)
  })

  it('reads the global colour table, padded entries included, in file order', () => {
    // A 3-colour palette is stored in a 4-slot table; the padding slot is real
    // and the decoder must not silently drop or reorder it.
    const gif = decodeGif(
      buildGif({
        width: 1,
        height: 1,
        palette: [
          [1, 2, 3],
          [4, 5, 6],
          [7, 8, 9],
        ],
        frames: [{ width: 1, height: 1, indices: [2] }],
      }),
    )
    expect(gif.frames[0].palette).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [0, 0, 0],
    ])
  })

  it('prefers a frame local colour table over the global one', () => {
    const local = [
      [10, 10, 10],
      [20, 20, 20],
      [30, 30, 30],
      [40, 40, 40],
    ]
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 1,
        palette: QUAD,
        frames: [{ width: 2, height: 1, indices: [1, 3], localPalette: local }],
      }),
    )
    expect(gif.frames[0].palette).toEqual(local)
  })

  it('rejects a file whose signature is not GIF87a or GIF89a', () => {
    const bytes = buildGif({
      width: 1,
      height: 1,
      palette: QUAD,
      frames: [{ width: 1, height: 1, indices: [0] }],
      signature: 'PNG\r\n',
    })
    expect(() => decodeGif(bytes)).toThrow(/signature/i)
  })

  it('accepts the older GIF87a signature', () => {
    const bytes = buildGif({
      width: 1,
      height: 1,
      palette: QUAD,
      frames: [{ width: 1, height: 1, indices: [2], withGce: false }],
      signature: 'GIF87a',
    })
    expect([...decodeGif(bytes).frames[0].indices]).toEqual([2])
  })

  it('rejects a stream truncated inside the global colour table', () => {
    const bytes = buildGif({
      width: 2,
      height: 1,
      palette: QUAD,
      frames: [{ width: 2, height: 1, indices: [0, 1] }],
    })
    // 13 header bytes + 12 colour table bytes: cut two colours in.
    expect(() => decodeGif(bytes.slice(0, 19))).toThrow(/truncated/i)
  })

  it('rejects every short prefix of a valid file rather than half-decoding it', () => {
    // Stronger than cutting at one hand-picked offset, and it needs no byte
    // arithmetic that a fixture change could invalidate: EVERY prefix up to the
    // sub-block terminator is malformed, whether the cut lands in the header, a
    // colour table, an extension, the image descriptor or the code stream.
    // Only the trailer (the final 0x3B) is optional, because files in the wild
    // omit it.
    const bytes = buildGif({
      width: 2,
      height: 1,
      palette: QUAD,
      frames: [{ width: 2, height: 1, indices: [0, 1] }],
    })
    for (let cut = 1; cut < bytes.length - 1; cut += 1) {
      expect(() => decodeGif(bytes.slice(0, cut)), `prefix of ${cut} bytes must throw`).toThrow()
    }
    expect(() => decodeGif(bytes.slice(0, bytes.length - 1))).not.toThrow()
  })

  it('rejects image data that stops before the frame is full', () => {
    // 16 pixels are declared but the LZW payload only codes for four, so the
    // frame cannot be filled. Silently returning a quarter-decoded frame would
    // hand the build stage a canvas of mostly-zero indices.
    const short = lzwCodeStream([0, 1, 2, 3], 2)
    const bytes = buildGif({
      width: 4,
      height: 4,
      palette: QUAD,
      frames: [{ width: 4, height: 4, indices: new Array(16).fill(0), lzwBytes: short }],
    })
    expect(() => decodeGif(bytes)).toThrow(/truncated|pixels/i)
  })
})

describe('decodeGif — graphic control extensions', () => {
  it('converts the delay from centiseconds to milliseconds', () => {
    // GIF stores hundredths of a second. The source GIF's 200 ms frames are
    // stored as 20, and a decoder that forgets the unit makes the banner run
    // 100x too fast.
    const gif = decodeGif(
      buildGif({
        width: 1,
        height: 1,
        palette: QUAD,
        frames: [
          { width: 1, height: 1, indices: [0], delayCs: 20 },
          { width: 1, height: 1, indices: [1], delayCs: 7 },
        ],
      }),
    )
    expect(gif.frames.map((f) => f.delayMs)).toEqual([200, 70])
  })

  it('extracts the disposal method from the packed field', () => {
    const gif = decodeGif(
      buildGif({
        width: 1,
        height: 1,
        palette: QUAD,
        frames: [
          { width: 1, height: 1, indices: [0], disposal: 0 },
          { width: 1, height: 1, indices: [1], disposal: 1 },
          { width: 1, height: 1, indices: [2], disposal: 2 },
          { width: 1, height: 1, indices: [3], disposal: 3 },
        ],
      }),
    )
    expect(gif.frames.map((f) => f.disposal)).toEqual([0, 1, 2, 3])
  })

  it('reports the transparency index only when the flag is set', () => {
    const gif = decodeGif(
      buildGif({
        width: 1,
        height: 1,
        palette: QUAD,
        frames: [
          { width: 1, height: 1, indices: [0], transparentIndex: 2 },
          { width: 1, height: 1, indices: [1], transparentIndex: null },
        ],
      }),
    )
    // Index 0 is a legal transparency index, so `null` — not 0 — has to mean
    // "none declared".
    expect(gif.frames.map((f) => f.transparentIndex)).toEqual([2, null])
  })

  it('does not leak one frame delay or disposal into the next', () => {
    const gif = decodeGif(
      buildGif({
        width: 1,
        height: 1,
        palette: QUAD,
        frames: [
          { width: 1, height: 1, indices: [0], delayCs: 20, disposal: 2, transparentIndex: 1 },
          { width: 1, height: 1, indices: [1], withGce: false },
        ],
      }),
    )
    expect(gif.frames[1]).toMatchObject({ delayMs: 0, disposal: 0, transparentIndex: null })
  })
})

describe('decodeGif — blocks that must be skipped whole', () => {
  it('skips application, comment and plain-text extensions', () => {
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        palette: QUAD,
        leadingBlocks: [...netscapeLoopExtension(0), ...commentExtension('made by nobody')],
        frames: [
          {
            width: 2,
            height: 2,
            indices: [0, 1, 2, 3],
            before: [...plainTextExtension('skip me'), ...commentExtension('x'.repeat(300))],
          },
        ],
      }),
    )
    expect(gif.frames).toHaveLength(1)
    expect([...gif.frames[0].indices]).toEqual([0, 1, 2, 3])
  })
})

describe('decodeGif — per-frame geometry', () => {
  it('keeps each frame own offset and size rather than the screen size', () => {
    const gif = decodeGif(
      buildGif({
        width: 8,
        height: 6,
        palette: QUAD,
        frames: [
          { width: 8, height: 6, indices: new Array(48).fill(0) },
          { width: 2, height: 3, left: 5, top: 2, indices: [1, 2, 3, 1, 2, 3] },
        ],
      }),
    )
    expect(gif.frames[1]).toMatchObject({ left: 5, top: 2, width: 2, height: 3 })
    expect([...gif.frames[1].indices]).toEqual([1, 2, 3, 1, 2, 3])
  })

  it('rejects an interlaced frame instead of mis-ordering its rows', () => {
    const bytes = buildGif({
      width: 4,
      height: 4,
      palette: QUAD,
      frames: [{ width: 4, height: 4, indices: new Array(16).fill(1), interlaced: true }],
    })
    expect(() => decodeGif(bytes)).toThrow(/interlac/i)
  })
})

describe('decodeGif — LZW', () => {
  it('reassembles a code stream split across many sub-blocks', () => {
    const indices = []
    for (let y = 0; y < 40; y += 1) {
      for (let x = 0; x < 40; x += 1) indices.push((x * 7 + y * 3) % 4)
    }
    // Prove the fixture really exercises the seam before trusting the result:
    // 1600 literal codes at 10-to-11 bits each is thousands of bytes.
    expect(countSubBlocks(lzwCodeStream(indices, 2))).toBeGreaterThan(1)

    const gif = decodeGif(
      buildGif({ width: 40, height: 40, palette: QUAD, frames: [{ width: 40, height: 40, indices }] }),
    )
    expect([...gif.frames[0].indices]).toEqual(indices)
  })

  it('reassembles a code stream split at an awkward sub-block size', () => {
    // Deliberately tiny sub-blocks so codes straddle nearly every seam.
    const indices = []
    for (let i = 0; i < 300; i += 1) indices.push(i % 4)
    const gif = decodeGif(
      buildGif({
        width: 20,
        height: 15,
        palette: QUAD,
        frames: [{ width: 20, height: 15, indices, chunkSize: 3 }],
      }),
    )
    expect([...gif.frames[0].indices]).toEqual(indices)
  })

  it('tolerates a full code table with no clear code (deferred clear)', () => {
    // 5040 literal codes saturate the 4096-entry table. An encoder is supposed
    // to send a clear at that point; plenty do not, and a decoder that keeps
    // assigning codes past 4095 or bumps the width past 12 loses the stream.
    const indices = []
    for (let i = 0; i < 70 * 72; i += 1) indices.push((i * 3) % 4)
    const gif = decodeGif(
      buildGif({ width: 70, height: 72, palette: QUAD, frames: [{ width: 70, height: 72, indices }] }),
    )
    expect([...gif.frames[0].indices]).toEqual(indices)
  })

  it('decodes a 256-colour frame, where the code width starts at 9 bits', () => {
    const palette = []
    for (let i = 0; i < 256; i += 1) palette.push([i, 255 - i, (i * 3) % 256])
    const indices = []
    for (let i = 0; i < 64; i += 1) indices.push((i * 4) % 256)
    const gif = decodeGif(
      buildGif({ width: 8, height: 8, palette, frames: [{ width: 8, height: 8, indices }] }),
    )
    expect([...gif.frames[0].indices]).toEqual(indices)
    expect(gif.frames[0].palette).toHaveLength(256)
  })
})
