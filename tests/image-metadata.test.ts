import { describe, expect, it } from "vitest";
import { imageSize } from "image-size";
import { stripImageMetadata } from "../app/server/image-metadata";

const ascii = (text: string): number[] => [...text].map((char: string): number => char.codePointAt(0) ?? 0);
const contains = (bytes: Uint8Array, text: string): boolean => Buffer.from(bytes).includes(Buffer.from(text));

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
function u32le(value: number): number[] {
  return u32be(value).reverse();
}

/** A JPEG segment: marker, big-endian length (including itself), payload. */
function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

function jpeg(): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xe1, [...ascii("Exif"), 0, 0, ...ascii("GPS 51.5N 0.1W iPhone")]),
    ...segment(0xe2, [...ascii("ICC_PROFILE"), 0, 1, 1]),
    ...segment(0xed, [...ascii("Photoshop 3.0 IPTC caption")]),
    ...segment(0xfe, ascii("comment by camera")),
    // SOF0: 8-bit, 2x3 pixels, one component.
    ...segment(0xc0, [8, 0, 3, 0, 2, 1, 1, 0x11, 0]),
    ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12,
    0x34,
    0xff,
    0xd9,
  ]);
}

function pngChunk(type: string, data: number[]): number[] {
  // The CRC is not checked here; image-size and the strip do not read it.
  return [...u32be(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
}

function png(): Uint8Array {
  return Uint8Array.from([
    0x89,
    ...ascii("PNG\r\n\x1a\n"),
    ...pngChunk("IHDR", [...u32be(4), ...u32be(5), 8, 6, 0, 0, 0]),
    ...pngChunk("eXIf", ascii("MM GPS secret")),
    ...pngChunk("tEXt", [...ascii("Author"), 0, ...ascii("Jane Doe")]),
    ...pngChunk("iCCP", ascii("icc")),
    ...pngChunk("IDAT", [1, 2, 3]),
    ...pngChunk("IEND", []),
  ]);
}

function riffChunk(type: string, data: number[]): number[] {
  return [...ascii(type), ...u32le(data.length), ...data, ...(data.length % 2 ? [0] : [])];
}

function webp(): Uint8Array {
  // VP8X: flags with EXIF (0x08) and XMP (0x04) set, canvas 7x9 stored as width-1, height-1 in 24 bits.
  const vp8x = [0x08 | 0x04 | 0x20, 0, 0, 0, 6, 0, 0, 8, 0, 0];
  const body = [
    ...ascii("WEBP"),
    ...riffChunk("VP8X", vp8x),
    ...riffChunk("ICCP", ascii("icc")),
    ...riffChunk("VP8 ", [1, 2, 3]),
    ...riffChunk("EXIF", ascii("GPS secret")),
    ...riffChunk("XMP ", ascii("<x:xmpmeta>creator</x:xmpmeta>")),
  ];
  return Uint8Array.from([...ascii("RIFF"), ...u32le(body.length), ...body]);
}

describe("image metadata removal", () => {
  it("drops EXIF, IPTC and comments from a JPEG and keeps JFIF, the ICC profile and the image data", () => {
    const clean = stripImageMetadata(jpeg(), "image/jpeg");
    for (const text of ["Exif", "GPS", "IPTC", "comment by camera"]) expect(contains(clean, text)).toBe(false);
    for (const text of ["JFIF", "ICC_PROFILE"]) expect(contains(clean, text)).toBe(true);
    expect([...clean.subarray(-4)]).toEqual([0x12, 0x34, 0xff, 0xd9]);
    expect(imageSize(clean)).toMatchObject({ type: "jpg", width: 2, height: 3 });
  });

  it("drops eXIf and text chunks from a PNG and keeps the rest in order", () => {
    const clean = stripImageMetadata(png(), "image/png");
    for (const text of ["eXIf", "GPS", "tEXt", "Jane Doe"]) expect(contains(clean, text)).toBe(false);
    expect(contains(clean, "iCCP")).toBe(true);
    expect(imageSize(clean)).toMatchObject({ type: "png", width: 4, height: 5 });
    expect([...clean.subarray(-8, -4)]).toEqual(ascii("IEND"));
  });

  it("drops EXIF and XMP chunks from a WebP, clears their VP8X flags and fixes the RIFF size", () => {
    const clean = stripImageMetadata(webp(), "image/webp");
    for (const text of ["EXIF", "XMP ", "GPS", "creator"]) expect(contains(clean, text)).toBe(false);
    const view = new DataView(clean.buffer, clean.byteOffset, clean.byteLength);
    expect(view.getUint32(4, true)).toBe(clean.length - 8);
    // The ICC flag (0x20) stays, the EXIF and XMP flags go.
    expect(clean[20]).toBe(0x20);
    expect(imageSize(clean)).toMatchObject({ type: "webp", width: 7, height: 9 });
  });

  it("keeps a truncated trailing segment as it is instead of reading past the end", () => {
    const cut = jpeg().subarray(0, 8);
    expect([...stripImageMetadata(cut, "image/jpeg")]).toEqual([...cut]);
    const pngCut = png().subarray(0, 20);
    expect([...stripImageMetadata(pngCut, "image/png")]).toEqual([...pngCut]);
    const webpCut = webp().subarray(0, 16);
    expect(stripImageMetadata(webpCut, "image/webp").subarray(8, 16)).toEqual(webpCut.subarray(8, 16));
  });

  it("refuses a type it does not know", () => {
    expect(() => stripImageMetadata(new Uint8Array(4), "image/gif")).toThrow("Unsupported image type");
  });
});
