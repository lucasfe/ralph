// #66 — a dependency-free GIF89a *encoder*, for tests only.
//
// WHY AN ENCODER LIVES IN THE TEST TREE
// The sprite pipeline's input is a Wreck-It Ralph GIF that is deliberately NOT
// committed (see the issue: "No asset is committed"). So the decoder under test
// has no real fixture file to chew on, and adding one would mean either shipping
// a binary blob or taking a dependency on an image library — both of which the
// issue forbids. Instead the specs SYNTHESIZE GIF bytes here: every field the
// decoder reads (logical screen descriptor, global/local colour tables, graphic
// control extensions, per-frame offsets, disposal methods, LZW sub-blocks) is
// something a test can dial in by hand and then assert on.
//
// THE OBVIOUS TRAP, and how the specs avoid it
// An encoder written by the same hand as the decoder can agree with it on a
// shared off-by-one and let both pass. That is why this file is only HALF the
// evidence: test/sprite-gif-decode.test.js also decodes the canonical 1×1
// transparent GIF (TRANSPARENT_1PX_GIF_BASE64 below, a byte sequence found in
// the wild and pasted verbatim) plus a 2×2 GIF whose bitstream is hand-derived
// bit by bit in a comment. Those anchors pin the absolute bit order; this
// encoder then covers the combinatorics.
//
// WHAT THE LZW HERE DOES, and does not
// It emits LITERAL codes only — one code per pixel, never a multi-pixel match.
// That is a legal, if fat, GIF: the decoder still has to walk the code table,
// grow the code width, and honour clear/EOI. Crucially the encoder MIRRORS the
// decoder's table growth (one entry per code after the first, width bump when the
// next code to be assigned would not fit), because that growth is what decides
// where the code-width boundaries land in the bitstream. Being fat is a feature:
// 10-to-12-bit codes and payloads well past 255 bytes fall out naturally, which
// is exactly the multi-sub-block path the issue calls out.

/** The GIF89a signature every fixture starts with, unless a spec overrides it. */
export const GIF89A = 'GIF89a'

// The canonical 1×1 fully transparent GIF that has been copy-pasted around the
// web for two decades. Used as an anchor precisely BECAUSE it was not produced
// by the encoder in this file. Note the two real-world quirks it carries, both of
// which the decoder must survive: its LZW bitstream stops after the single
// pixel's code (no EOI code), and the file ends without the 0x3B trailer.
export const TRANSPARENT_1PX_GIF_BASE64 =
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA='

// GIF integers are little-endian 16-bit.
function u16(value) {
  return [value & 0xff, (value >> 8) & 0xff]
}

/**
 * The colour-table size field is logarithmic: a table declared with size bits N
 * holds 2^(N+1) entries. So a 3-colour palette must be PADDED to 4 entries, and
 * the padding is real bytes in the file.
 */
export function colorTableSizeBits(entryCount) {
  if (entryCount < 1 || entryCount > 256) {
    throw new RangeError(`gif-fixture: a colour table holds 1..256 entries (got ${entryCount})`)
  }
  let bits = 0
  while (1 << (bits + 1) < entryCount) bits += 1
  return bits
}

function colorTableBytes(palette) {
  const bits = colorTableSizeBits(palette.length)
  const slots = 1 << (bits + 1)
  const out = []
  for (let i = 0; i < slots; i += 1) {
    const [r, g, b] = palette[i] ?? [0, 0, 0]
    out.push(r, g, b)
  }
  return { bits, bytes: out }
}

/**
 * The LZW minimum code size is the bit width of the palette, floored at 2 — a
 * 2-colour GIF still uses 2-bit literals, because widths 0 and 1 leave no room
 * for the clear and end-of-information codes.
 */
export function minCodeSizeFor(entryCount) {
  return Math.max(2, colorTableSizeBits(entryCount) + 1)
}

// Codes are packed LSB-first and are allowed to straddle byte boundaries: the
// low bits of a code go in the low free bits of the current byte, and whatever
// does not fit spills into the next one. The accumulator never holds more than
// 7 + 12 = 19 bits, so plain 32-bit shifts are safe.
class BitWriter {
  constructor() {
    this.bytes = []
    this.acc = 0
    this.bits = 0
  }

  write(code, width) {
    this.acc |= code << this.bits
    this.bits += width
    while (this.bits >= 8) {
      this.bytes.push(this.acc & 0xff)
      this.acc >>>= 8
      this.bits -= 8
    }
  }

  // A partial trailing byte is zero-padded. Decoders stop on EOI or on a full
  // frame, so the padding is never read as a code.
  flush() {
    if (this.bits > 0) {
      this.bytes.push(this.acc & 0xff)
      this.acc = 0
      this.bits = 0
    }
    return this.bytes
  }
}

/**
 * Literal-only LZW, mirroring the decoder's table growth so the code-width
 * boundaries land where a real decoder expects them.
 *
 * @param {ArrayLike<number>} indices one palette index per pixel, row-major
 * @param {number} minCodeSize
 * @returns {number[]} the raw code stream bytes (no sub-block framing)
 */
export function lzwCodeStream(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1
  const writer = new BitWriter()

  let width = minCodeSize + 1
  let next = clearCode + 2
  writer.write(clearCode, width)

  let havePrevious = false
  for (let i = 0; i < indices.length; i += 1) {
    writer.write(indices[i], width)
    // The decoder adds one table entry per code EXCEPT the first after a clear
    // (it has no previous string to extend), and it grows the width once the
    // code it would assign next no longer fits. Table growth stops at 4096:
    // past that a well-behaved encoder would emit a clear, and a decoder that
    // cannot tolerate the *absence* of one (the "deferred clear") mis-reads
    // every later code — so this encoder deliberately never sends it.
    if (havePrevious && next < 4096) {
      next += 1
      if (next === 1 << width && width < 12) width += 1
    }
    havePrevious = true
  }
  writer.write(eoiCode, width)
  return writer.flush()
}

/**
 * Wraps a byte payload in GIF sub-blocks: each chunk is prefixed with its own
 * length (1..255) and the run ends with a zero-length block. Anything over 255
 * bytes therefore arrives at the decoder in pieces, and a code may straddle the
 * seam — which is the whole point of exercising it.
 */
export function subBlocks(payload, chunkSize = 255) {
  const out = []
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize)
    out.push(chunk.length, ...chunk)
  }
  out.push(0x00)
  return out
}

/** Count the sub-blocks in an encoded frame — lets a spec prove its own fixture
 * actually splits, instead of assuming it does. */
export function countSubBlocks(payload, chunkSize = 255) {
  return Math.ceil(payload.length / chunkSize)
}

/** A comment extension (0x21 0xFE): pure metadata the decoder must skip whole. */
export function commentExtension(text) {
  const data = [...Buffer.from(text, 'ascii')]
  return [0x21, 0xfe, ...subBlocks(data)]
}

/** The NETSCAPE loop-count application extension (0x21 0xFF) — present in most
 * animated GIFs in the wild, and meaningless to this pipeline. */
export function netscapeLoopExtension(loops = 0) {
  return [0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, ...u16(loops), 0x00]
}

/**
 * A plain-text extension (0x21 0x01): a 12-byte fixed header followed by
 * sub-blocks. Included because its fixed header is a classic place to get the
 * skip length wrong.
 */
export function plainTextExtension(text = 'hi') {
  const header = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0]
  return [0x21, 0x01, 0x0c, ...header, ...subBlocks([...Buffer.from(text, 'ascii')])]
}

function graphicControlExtension({ disposal, delayCs, transparentIndex, userInput }) {
  const hasTransparency = transparentIndex !== null && transparentIndex !== undefined
  const packed =
    ((disposal & 0b111) << 2) | ((userInput ? 1 : 0) << 1) | (hasTransparency ? 1 : 0)
  return [
    0x21,
    0xf9,
    0x04,
    packed,
    ...u16(delayCs),
    hasTransparency ? transparentIndex : 0,
    0x00,
  ]
}

/**
 * Assemble a whole GIF.
 *
 * @param {object} spec
 * @param {number} spec.width logical screen width
 * @param {number} spec.height logical screen height
 * @param {number[][]} [spec.palette] global colour table as RGB triples
 * @param {object[]} spec.frames see `frameBytes` below
 * @param {string} [spec.signature] override to test signature rejection
 * @param {boolean} [spec.trailer] set false to omit 0x3B, as real files do
 * @param {number[]} [spec.leadingBlocks] raw bytes injected before the frames
 * @returns {Uint8Array}
 */
export function buildGif(spec) {
  const {
    width,
    height,
    palette = null,
    frames,
    backgroundIndex = 0,
    aspectRatio = 0,
    signature = GIF89A,
    trailer = true,
    leadingBlocks = [],
  } = spec

  const bytes = [...Buffer.from(signature, 'ascii')]
  const global = palette ? colorTableBytes(palette) : null
  const packed = global ? 0b1000_0000 | (0b111 << 4) | global.bits : 0
  bytes.push(...u16(width), ...u16(height), packed, backgroundIndex, aspectRatio)
  if (global) bytes.push(...global.bytes)
  bytes.push(...leadingBlocks)

  for (const frame of frames) bytes.push(...frameBytes(frame, palette))
  if (trailer) bytes.push(0x3b)
  return new Uint8Array(bytes)
}

/**
 * One frame: an optional graphic control extension, then the image descriptor,
 * then LZW data. `left`/`top`/`width`/`height` are the frame's own rectangle
 * inside the logical screen, which is how animated GIFs redraw only what moved.
 */
export function frameBytes(frame, globalPalette) {
  const {
    indices,
    width,
    height,
    left = 0,
    top = 0,
    delayCs = 0,
    disposal = 0,
    transparentIndex = null,
    userInput = false,
    interlaced = false,
    localPalette = null,
    withGce = true,
    before = [],
    chunkSize = 255,
    lzwBytes = null,
  } = frame

  if (indices && indices.length !== width * height) {
    throw new RangeError(
      `gif-fixture: frame is ${width}×${height} = ${width * height} pixels but got ${indices.length} indices`,
    )
  }

  const out = [...before]
  if (withGce) out.push(...graphicControlExtension({ disposal, delayCs, transparentIndex, userInput }))

  const local = localPalette ? colorTableBytes(localPalette) : null
  const descriptorPacked =
    (local ? 0b1000_0000 : 0) | (interlaced ? 0b0100_0000 : 0) | (local ? local.bits : 0)
  out.push(0x2c, ...u16(left), ...u16(top), ...u16(width), ...u16(height), descriptorPacked)
  if (local) out.push(...local.bytes)

  const entryCount = (localPalette ?? globalPalette ?? [[0, 0, 0], [0, 0, 0]]).length
  const minCodeSize = minCodeSizeFor(entryCount)
  const payload = lzwBytes ?? lzwCodeStream(indices, minCodeSize)
  out.push(minCodeSize, ...subBlocks(payload, chunkSize))
  return out
}
