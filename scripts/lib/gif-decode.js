// #66 — a GIF89a decoder in plain Node, with no dependency of any kind.
//
// WHY HAND-ROLLED
// The sprite pipeline needs one thing from a GIF: the palette indices of each
// frame, plus the frame's rectangle, delay and disposal method. Every library
// that does that also decodes JPEG, resizes, and pulls in native bindings —
// and the issue is explicit that no runtime or dev dependency may be added for
// this. GIF89a is a small format: about 200 lines below, of which the LZW
// decoder is half.
//
// WHAT IT DOES NOT DO
// Interlaced frames are REJECTED rather than decoded. The source asset is not
// interlaced, and a silently wrong row order would show up as a scrambled
// sprite three slices later instead of here. Same reasoning for a truncated
// stream: this decoder never returns a partly-filled frame.
//
// PURE, and deliberately so: the bytes come in as a Uint8Array and everything
// else is arithmetic. The file reading lives in scripts/generate-sprite.js, so
// the whole decode path is testable from synthesized bytes with no temp files.
// It also reads no clock and no randomness, which is half of what makes the
// generator's output byte-identical across runs.

const SIGNATURES = ['GIF87a', 'GIF89a']

const BLOCK_EXTENSION = 0x21
const BLOCK_IMAGE_DESCRIPTOR = 0x2c
const BLOCK_TRAILER = 0x3b
const EXTENSION_GRAPHIC_CONTROL = 0xf9

// The LZW code table is capped at 4096 entries by the format: codes are at most
// 12 bits wide.
const MAX_CODES = 4096
const MAX_CODE_WIDTH = 12

/**
 * A cursor over the byte array that fails loudly instead of reading past the
 * end. Every read names what it was reading, so a truncated file produces
 * "truncated GIF - a colour table needs 12 byte(s) at offset 13" rather than a
 * silent `undefined` that turns into a black pixel much later.
 */
function createReader(bytes) {
  let offset = 0

  function need(count, what) {
    if (offset + count > bytes.length) {
      throw new Error(
        `gif-decode: truncated GIF — ${what} needs ${count} byte(s) at offset ${offset}, ` +
          `but the file is ${bytes.length} byte(s) long`,
      )
    }
  }

  return {
    get offset() {
      return offset
    },
    get done() {
      return offset >= bytes.length
    },
    u8(what) {
      need(1, what)
      const value = bytes[offset]
      offset += 1
      return value
    },
    // GIF integers are little-endian.
    u16(what) {
      need(2, what)
      const value = bytes[offset] | (bytes[offset + 1] << 8)
      offset += 2
      return value
    },
    take(count, what) {
      need(count, what)
      const slice = bytes.subarray(offset, offset + count)
      offset += count
      return slice
    },
    ascii(count, what) {
      return String.fromCharCode(...this.take(count, what))
    },
  }
}

/**
 * The colour-table size field is logarithmic: N means 2^(N+1) entries. Padding
 * entries are kept, because a frame is free to reference them.
 */
function tableEntryCount(sizeBits) {
  return 2 << sizeBits
}

function readColorTable(reader, entryCount, what) {
  const raw = reader.take(entryCount * 3, what)
  const table = []
  for (let i = 0; i < entryCount; i += 1) {
    table.push([raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]])
  }
  return table
}

/**
 * Every extension and every image's pixel data arrives as a chain of
 * length-prefixed sub-blocks ending in a zero length. Concatenating them here
 * means the LZW decoder never has to know a seam exists — and it means an
 * extension this pipeline does not care about is skipped by the same code that
 * reads the ones it does.
 */
function readSubBlocks(reader, what) {
  const chunks = []
  let total = 0
  for (;;) {
    const size = reader.u8(`a ${what} sub-block length`)
    if (size === 0) break
    chunks.push(reader.take(size, `a ${what} sub-block`))
    total += size
  }
  const joined = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.length
  }
  return joined
}

/**
 * The graphic control extension carries the three per-frame facts this pipeline
 * needs. Note the units: the format stores the delay in CENTIseconds, and a
 * decoder that forgets to multiply makes a 200 ms animation run at 2 ms.
 */
function parseGraphicControl(data) {
  if (data.length < 4) {
    throw new Error(
      `gif-decode: truncated graphic control extension — expected 4 byte(s), got ${data.length}`,
    )
  }
  const packed = data[0]
  return {
    disposal: (packed >> 2) & 0b111,
    hasTransparency: (packed & 0b1) === 1,
    delayMs: (data[1] | (data[2] << 8)) * 10,
    transparentIndex: data[3],
  }
}

function readImageDescriptor(reader) {
  const left = reader.u16('an image descriptor left offset')
  const top = reader.u16('an image descriptor top offset')
  const width = reader.u16('an image descriptor width')
  const height = reader.u16('an image descriptor height')
  const packed = reader.u8('an image descriptor packed field')
  return {
    left,
    top,
    width,
    height,
    hasLocalTable: (packed & 0b1000_0000) !== 0,
    interlaced: (packed & 0b0100_0000) !== 0,
    localTableEntries: tableEntryCount(packed & 0b111),
  }
}

/**
 * LZW as GIF uses it, over the already-joined sub-block payload.
 *
 * The table is three flat typed arrays rather than an array of arrays: an entry
 * is "the string at `prefix`, plus one byte" — so a string is reconstructed by
 * walking the prefix chain backwards, and no per-code allocation happens at all.
 * `first` caches each entry's leading byte, which is the one thing the algorithm
 * needs to look up in constant time.
 *
 * Three real-world tolerances are deliberate, and each has a spec:
 *   * the stream may end without an end-of-information code, as long as the
 *     frame is full (the canonical 1x1 transparent GIF does exactly this);
 *   * the table may saturate at 4096 entries without the encoder sending a
 *     clear code (the "deferred clear"), in which case decoding continues with
 *     the table frozen;
 *   * a code width never grows past 12 bits.
 * What is NOT tolerated is a frame that ends up short of its pixel count.
 */
function decodeLzw(data, minCodeSize, pixelCount, frameIndex) {
  if (minCodeSize < 2 || minCodeSize > 11) {
    throw new Error(
      `gif-decode: frame ${frameIndex} declares an LZW minimum code size of ${minCodeSize}, ` +
        `which is outside the legal 2..11`,
    )
  }

  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1

  const prefix = new Int16Array(MAX_CODES)
  const suffix = new Uint8Array(MAX_CODES)
  const first = new Uint8Array(MAX_CODES)
  const lengths = new Uint16Array(MAX_CODES)
  for (let code = 0; code < clearCode; code += 1) {
    prefix[code] = -1
    suffix[code] = code
    first[code] = code
    lengths[code] = 1
  }

  const out = new Uint8Array(pixelCount)
  let outAt = 0
  let codeWidth = minCodeSize + 1
  let next = clearCode + 2
  let previous = -1
  let bitBuffer = 0
  let bitCount = 0
  let at = 0

  // Writes the string for `code` into the output, back to front, since the
  // prefix chain runs from the last byte to the first.
  function emit(code) {
    const length = lengths[code]
    if (outAt + length > pixelCount) {
      throw new Error(
        `gif-decode: frame ${frameIndex} image data describes more than the ${pixelCount} ` +
          `pixel(s) the frame declares`,
      )
    }
    let write = outAt + length - 1
    let cursor = code
    while (cursor >= 0) {
      out[write] = suffix[cursor]
      write -= 1
      cursor = prefix[cursor]
    }
    outAt += length
  }

  // Returns the code assigned, or -1 once the table is frozen at 4096 entries.
  function define(from, symbol) {
    if (next >= MAX_CODES) return -1
    const code = next
    prefix[code] = from
    suffix[code] = symbol
    first[code] = first[from]
    lengths[code] = lengths[from] + 1
    next += 1
    // Grow once the code that will be assigned NEXT no longer fits — this is
    // where the encoder and decoder have to agree byte for byte.
    if (next === 1 << codeWidth && codeWidth < MAX_CODE_WIDTH) codeWidth += 1
    return code
  }

  while (outAt < pixelCount) {
    while (bitCount < codeWidth) {
      if (at >= data.length) {
        throw new Error(
          `gif-decode: truncated image data — frame ${frameIndex} decoded ${outAt} of the ` +
            `${pixelCount} pixel(s) it declares`,
        )
      }
      bitBuffer |= data[at] << bitCount
      at += 1
      bitCount += 8
    }
    const code = bitBuffer & ((1 << codeWidth) - 1)
    bitBuffer >>>= codeWidth
    bitCount -= codeWidth

    if (code === clearCode) {
      codeWidth = minCodeSize + 1
      next = clearCode + 2
      previous = -1
      continue
    }
    if (code === eoiCode) break

    if (code < next) {
      emit(code)
      if (previous >= 0) define(previous, first[code])
      previous = code
      continue
    }
    if (code === next && previous >= 0) {
      // The encoder referenced the entry the decoder is about to define — legal,
      // and the string is "previous, then previous's own first byte".
      const defined = define(previous, first[previous])
      if (defined < 0) {
        throw new Error(
          `gif-decode: frame ${frameIndex} references code ${code} with a full code table`,
        )
      }
      emit(defined)
      previous = defined
      continue
    }
    throw new Error(
      `gif-decode: frame ${frameIndex} contains LZW code ${code}, which is past the ` +
        `${next} code(s) defined so far`,
    )
  }

  if (outAt < pixelCount) {
    throw new Error(
      `gif-decode: truncated image data — frame ${frameIndex} decoded ${outAt} of the ` +
        `${pixelCount} pixel(s) it declares`,
    )
  }
  return out
}

function readFrame(reader, { control, globalPalette, index }) {
  const descriptor = readImageDescriptor(reader)
  if (descriptor.interlaced) {
    throw new Error(
      `gif-decode: frame ${index} is interlaced, which this decoder rejects rather than ` +
        `decoding into the wrong row order`,
    )
  }
  const palette = descriptor.hasLocalTable
    ? readColorTable(reader, descriptor.localTableEntries, 'a local colour table')
    : globalPalette
  if (!palette) {
    throw new Error(`gif-decode: frame ${index} has neither a local nor a global colour table`)
  }

  const pixelCount = descriptor.width * descriptor.height
  if (pixelCount === 0) {
    throw new Error(
      `gif-decode: frame ${index} is ${descriptor.width}x${descriptor.height}, which has no pixels`,
    )
  }

  const minCodeSize = reader.u8('an LZW minimum code size')
  const data = readSubBlocks(reader, 'image data')
  return {
    left: descriptor.left,
    top: descriptor.top,
    width: descriptor.width,
    height: descriptor.height,
    indices: decodeLzw(data, minCodeSize, pixelCount, index),
    palette,
    delayMs: control ? control.delayMs : 0,
    disposal: control ? control.disposal : 0,
    // `null`, not 0: index 0 is a perfectly ordinary transparency index, so the
    // absence of a declaration needs its own value.
    transparentIndex: control && control.hasTransparency ? control.transparentIndex : null,
    interlaced: false,
  }
}

/**
 * Decode a GIF87a/GIF89a byte stream.
 *
 * @param {Uint8Array} source
 * @returns {{ width: number, height: number, frames: object[] }} frames carry
 *   `{ left, top, width, height, indices, palette, delayMs, disposal,
 *   transparentIndex, interlaced }`
 */
export function decodeGif(source) {
  if (!(source instanceof Uint8Array)) {
    throw new TypeError(
      `gif-decode: expected a Uint8Array of GIF bytes (got ${source === null ? 'null' : typeof source})`,
    )
  }

  const reader = createReader(source)
  const signature = reader.ascii(6, 'the signature')
  if (!SIGNATURES.includes(signature)) {
    throw new Error(
      `gif-decode: unexpected signature ${JSON.stringify(signature)} — expected one of ` +
        SIGNATURES.join(', '),
    )
  }

  const width = reader.u16('the logical screen width')
  const height = reader.u16('the logical screen height')
  const packed = reader.u8('the logical screen packed field')
  reader.u8('the background colour index')
  reader.u8('the pixel aspect ratio')
  const globalPalette =
    (packed & 0b1000_0000) !== 0
      ? readColorTable(reader, tableEntryCount(packed & 0b111), 'the global colour table')
      : null

  const frames = []
  // A graphic control extension applies to the NEXT image only, so it is held
  // here and cleared once consumed. Carrying it forward is how a one-frame
  // delay ends up on every later frame.
  let control = null

  // `reader.done` rather than "until the trailer": files in the wild end without
  // one, including the canonical 1x1 transparent GIF this decoder is anchored
  // against.
  while (!reader.done) {
    const introducer = reader.u8('a block introducer')
    if (introducer === BLOCK_TRAILER) break
    if (introducer === BLOCK_EXTENSION) {
      const label = reader.u8('an extension label')
      const data = readSubBlocks(reader, 'extension')
      if (label === EXTENSION_GRAPHIC_CONTROL) control = parseGraphicControl(data)
      continue
    }
    if (introducer === BLOCK_IMAGE_DESCRIPTOR) {
      frames.push(readFrame(reader, { control, globalPalette, index: frames.length }))
      control = null
      continue
    }
    throw new Error(
      `gif-decode: unknown block introducer 0x${introducer.toString(16).padStart(2, '0')} at ` +
        `offset ${reader.offset - 1}`,
    )
  }

  if (frames.length === 0) throw new Error('gif-decode: the file declares no image frames')
  return { width, height, frames }
}
