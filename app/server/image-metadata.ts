/**
 * Removes metadata (EXIF with GPS and device data, XMP, IPTC, comments, text chunks) from an uploaded PNG, JPEG or
 * WebP without decoding the pixels. The browser cropper already re-encodes uploads, but any other client could
 * send a camera file straight to the API, and uploaded images are public. Colour data (ICC profiles, Adobe APP14)
 * stays, so images look the same. Input must already have passed `validateImage`.
 */
export function stripImageMetadata(bytes: Uint8Array, mime: string): Uint8Array {
  if (mime === "image/jpeg") return stripJpeg(bytes);
  if (mime === "image/png") return stripPng(bytes);
  if (mime === "image/webp") return stripWebp(bytes);
  throw new Error(`Unsupported image type: ${mime}`);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size: number, part: Uint8Array): number => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** JPEG segments dropped: APP1 (EXIF, XMP), APP3-APP13 (IPTC, vendor data), APP15 and COM. */
function droppedJpegMarker(marker: number): boolean {
  return marker === 0xe1 || (marker >= 0xe3 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker: number = bytes[offset + 1];
    // Start of scan: the entropy-coded image data and everything after it is kept as it is.
    if (marker === 0xda) break;
    const end: number = offset + 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
    if (end > bytes.length) break;
    if (!droppedJpegMarker(marker)) parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  parts.push(bytes.subarray(offset));
  return concat(parts);
}

const PNG_DROPPED: ReadonlySet<string> = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

function stripPng(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    // Length, type, data, CRC.
    const end: number = offset + 12 + view.getUint32(offset);
    if (end > bytes.length) break;
    const type: string = String.fromCodePoint(...bytes.subarray(offset + 4, offset + 8));
    if (!PNG_DROPPED.has(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  parts.push(bytes.subarray(offset));
  return concat(parts);
}

/** VP8X feature flags for an EXIF and an XMP chunk. */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function stripWebp(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size: number = view.getUint32(offset + 4, true);
    // Chunks are padded to an even size.
    const end: number = offset + 8 + size + (size % 2);
    if (end > bytes.length) break;
    const type: string = String.fromCodePoint(...bytes.subarray(offset, offset + 4));
    if (type !== "EXIF" && type !== "XMP ") {
      const chunk: Uint8Array = bytes.slice(offset, end);
      if (type === "VP8X") chunk[8] &= ~(VP8X_EXIF | VP8X_XMP);
      chunks.push(chunk);
    }
    offset = end;
  }
  chunks.push(bytes.subarray(offset));
  const body: Uint8Array = concat(chunks);
  const header: Uint8Array = bytes.slice(0, 12);
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return concat([header, body]);
}
