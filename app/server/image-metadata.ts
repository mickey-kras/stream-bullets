import { crc32 } from "node:zlib";
import { HttpError } from "./http.server";
import { orientationExif } from "./image-orientation";

// Strip private PNG/JPEG/WebP metadata without pixel decoding. API clients can bypass browser re-encoding.
// Keep ICC, Adobe APP14, and orientation. Requires `validateImage`.
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

// Keep ICC data in APP2; drop private application segments and comments.
function droppedJpegMarker(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xe2) {
    return payload.length < 14 || new TextDecoder().decode(payload.subarray(0, 12)) !== "ICC_PROFILE\0";
  }
  return marker === 0xe1 || (marker >= 0xe3 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
}

function invalidImage(): never {
  throw new HttpError(400, "Choose a valid PNG, JPEG, or WebP image.");
}

// Skip stuffed bytes and restart markers inside entropy-coded scan data.
function scanEnd(bytes: Uint8Array, start: number): number {
  let offset: number = start;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const markerStart: number = offset;
    while (bytes[offset] === 0xff) offset++;
    const marker: number = bytes[offset];
    if (marker !== 0 && (marker < 0xd0 || marker > 0xd7)) return markerStart;
    offset++;
  }
  return invalidImage();
}

function cleanJpegSegment(marker: number, payload: Uint8Array, original: Uint8Array): Uint8Array | undefined {
  const identifier: string = new TextDecoder().decode(payload.subarray(0, 6));
  if (marker === 0xe0) {
    if (payload.length < 14 || !identifier.startsWith("JFIF\0")) return undefined;
    const header: Uint8Array = payload.slice(0, 14);
    header[12] = 0;
    header[13] = 0;
    return concat([Uint8Array.of(0xff, 0xe0, 0, 16), header]);
  }
  if (marker === 0xe1) {
    const exif: Uint8Array | undefined = identifier === "Exif\0\0" ? orientationExif(payload) : undefined;
    return exif ? concat([Uint8Array.of(0xff, 0xe1, 0, exif.length + 8, 69, 120, 105, 102, 0, 0), exif]) : undefined;
  }
  if (marker === 0xee) {
    if (payload.length < 12 || !identifier.startsWith("Adobe")) return undefined;
    return concat([Uint8Array.of(0xff, 0xee, 0, 14), payload.subarray(0, 12)]);
  }
  return droppedJpegMarker(marker, payload) ? undefined : original;
}

function jpegSegmentEnd(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) return invalidImage();
  const length: number = (bytes[offset] << 8) | bytes[offset + 1];
  const end: number = offset + length;
  if (length < 2 || end > bytes.length) return invalidImage();
  return end;
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    const start: number = offset;
    if (bytes[offset] !== 0xff) return invalidImage();
    while (bytes[offset] === 0xff) offset++;
    const marker: number = bytes[offset++];
    if (marker === 0xd9) return concat([...parts, Uint8Array.of(0xff, 0xd9)]);
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(start, offset));
      continue;
    }
    const end: number = jpegSegmentEnd(bytes, offset);
    const segment: Uint8Array | undefined = cleanJpegSegment(
      marker,
      bytes.subarray(offset + 2, end),
      bytes.subarray(start, end),
    );
    if (segment) parts.push(segment);
    offset = end;
    if (marker === 0xda) {
      offset = scanEnd(bytes, end);
      parts.push(bytes.subarray(end, offset));
    }
  }
  return invalidImage();
}

const PNG_DROPPED: ReadonlySet<string> = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

function stripPng(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    // Length, type, data, CRC.
    const end: number = offset + 12 + view.getUint32(offset);
    if (end > bytes.length) return invalidImage();
    const type: string = String.fromCodePoint(...bytes.subarray(offset + 4, offset + 8));
    if (type === "eXIf") {
      const exif: Uint8Array | undefined = orientationExif(bytes.subarray(offset + 8, end - 4));
      if (exif) {
        const chunk: Uint8Array = new Uint8Array(exif.length + 12);
        const chunkView: DataView = new DataView(chunk.buffer);
        chunkView.setUint32(0, exif.length);
        chunk.set(bytes.subarray(offset + 4, offset + 8), 4);
        chunk.set(exif, 8);
        chunkView.setUint32(chunk.length - 4, crc32(chunk.subarray(4, -4)));
        parts.push(chunk);
      }
    } else if (!PNG_DROPPED.has(type)) parts.push(bytes.subarray(offset, end));
    if (type === "IEND") return concat(parts);
    offset = end;
  }
  return invalidImage();
}

// VP8X feature flags for an EXIF and an XMP chunk.
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function cleanWebpChunk(type: string, original: Uint8Array, size: number): Uint8Array | undefined {
  if (type === "XMP ") return undefined;
  if (type === "EXIF") {
    const exif: Uint8Array | undefined = orientationExif(original.subarray(8, 8 + size));
    if (!exif) return undefined;
    const chunk: Uint8Array = new Uint8Array(exif.length + 8);
    chunk.set(original.subarray(0, 4));
    new DataView(chunk.buffer).setUint32(4, exif.length, true);
    chunk.set(exif, 8);
    return chunk;
  }
  const chunk: Uint8Array = original.slice();
  if (type === "VP8X") {
    if (size !== 10) return invalidImage();
    chunk[8] &= ~(VP8X_EXIF | VP8X_XMP);
  }
  return chunk;
}

function stripWebp(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [];
  let hasExif = false;
  let offset = 12;
  if (bytes.length < 12 || view.getUint32(4, true) !== bytes.length - 8) return invalidImage();
  while (offset + 8 <= bytes.length) {
    const size: number = view.getUint32(offset + 4, true);
    // Chunks are padded to an even size.
    const end: number = offset + 8 + size + (size % 2);
    if (end > bytes.length) return invalidImage();
    const type: string = String.fromCodePoint(...bytes.subarray(offset, offset + 4));
    const chunk: Uint8Array | undefined = cleanWebpChunk(type, bytes.subarray(offset, end), size);
    if (chunk) {
      chunks.push(chunk);
      if (type === "EXIF") hasExif = true;
    }
    offset = end;
  }
  if (offset !== bytes.length) return invalidImage();
  if (hasExif) {
    const extended: Uint8Array | undefined = chunks.find(
      (chunk: Uint8Array): boolean => String.fromCodePoint(...chunk.subarray(0, 4)) === "VP8X",
    );
    if (!extended || extended.length < 18) return invalidImage();
    extended[8] |= VP8X_EXIF;
  }
  const body: Uint8Array = concat(chunks);
  const header: Uint8Array = bytes.slice(0, 12);
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return concat([header, body]);
}
