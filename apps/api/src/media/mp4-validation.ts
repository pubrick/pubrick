/**
 * Bounded ISO BMFF top-level length check. This catches truncated or forged
 * `ftyp`-only uploads that signature sniffing cannot detect. It deliberately
 * does not claim to decode frames, inspect codecs, or validate nested boxes.
 */
export function hasCompleteMp4Boxes(bytes: Buffer): boolean {
  let offset = 0;
  let first = true;
  let hasMovie = false;
  let hasMedia = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) return false;
    const size32 = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let header = 8;
    let size = size32;
    if (size32 === 1) {
      if (bytes.length - offset < 16) return false;
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large > BigInt(bytes.length)) return false;
      size = Number(large);
      header = 16;
    } else if (size32 === 0) {
      size = bytes.length - offset;
    }
    if (size < header || size > bytes.length - offset) return false;
    if (!/^[\x20-\x7e]{4}$/.test(type)) return false;
    if (first && (type !== "ftyp" || size < header + 8)) return false;
    if (type === "moov" && size > header) hasMovie = true;
    if (type === "mdat" && size > header) hasMedia = true;
    offset += size;
    first = false;
  }
  return offset === bytes.length && hasMovie && hasMedia;
}
