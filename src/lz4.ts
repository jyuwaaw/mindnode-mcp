// Decoder for Apple's raw LZ4 framing as produced by the Compression
// framework (COMPRESSION_LZ4): a sequence of blocks, each starting with a
// 4-byte magic — "bv41" (LZ4-compressed block: u32le decodedSize,
// u32le encodedSize, then a standard LZ4 block), "bv4-" (stored block:
// u32le size, then raw bytes) — terminated by "bv4$".

const MAGIC_COMPRESSED = 0x31347662; // "bv41" LE
const MAGIC_STORED = 0x2d347662; // "bv4-" LE
const MAGIC_END = 0x24347662; // "bv4$" LE

export function appleLz4Decode(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const magic = buf.readUInt32LE(pos);
    if (magic === MAGIC_END) break;
    if (magic === MAGIC_STORED) {
      const size = buf.readUInt32LE(pos + 4);
      const start = pos + 8;
      out.push(buf.subarray(start, start + size));
      pos = start + size;
    } else if (magic === MAGIC_COMPRESSED) {
      const decodedSize = buf.readUInt32LE(pos + 4);
      const encodedSize = buf.readUInt32LE(pos + 8);
      const start = pos + 12;
      out.push(lz4BlockDecode(buf.subarray(start, start + encodedSize), decodedSize));
      pos = start + encodedSize;
    } else {
      throw new Error(`unexpected LZ4 frame magic 0x${magic.toString(16)} at offset ${pos}`);
    }
  }
  return Buffer.concat(out);
}

// Standard LZ4 block decompression.
export function lz4BlockDecode(src: Buffer, decodedSize: number): Buffer {
  const dst = Buffer.allocUnsafe(decodedSize);
  let s = 0;
  let d = 0;
  while (s < src.length) {
    const token = src[s++];
    // literals
    let litLen = token >> 4;
    if (litLen === 15) {
      let b;
      do {
        b = src[s++];
        litLen += b;
      } while (b === 255);
    }
    src.copy(dst, d, s, s + litLen);
    s += litLen;
    d += litLen;
    if (s >= src.length) break; // last sequence has no match
    // match
    const offset = src.readUInt16LE(s);
    s += 2;
    if (offset === 0) throw new Error("invalid LZ4 match offset 0");
    let matchLen = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let b;
      do {
        b = src[s++];
        matchLen += b;
      } while (b === 255);
    }
    let m = d - offset;
    // byte-by-byte copy: matches may overlap the output being written
    while (matchLen-- > 0) dst[d++] = dst[m++];
  }
  if (d !== decodedSize) {
    throw new Error(`LZ4 block decoded ${d} bytes, expected ${decodedSize}`);
  }
  return dst;
}
