import { crc32 } from "node:zlib";
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

  it("drops non-ICC APP2 data before and after JPEG scans", () => {
    const metadata = [...segment(0xe2, ascii("FPXR private camera information")),
      ...segment(0xe2, ascii("ICC_PROFILE")), ...segment(0xe2, [...ascii("ICC_PROFILEX"), 1, 1])];
    const input = Uint8Array.from([0xff, 0xd8, ...metadata, ...jpeg().subarray(2, -2), ...metadata, 0xff, 0xd9]);
    const clean = stripImageMetadata(input, "image/jpeg");
    expect(contains(clean, "FPXR")).toBe(false);
    expect(contains(clean, "private camera information")).toBe(false);
    expect(contains(clean, "ICC_PROFILEX")).toBe(false);
    expect(Buffer.from(clean).indexOf("ICC_PROFILE")).toBe(Buffer.from(clean).lastIndexOf("ICC_PROFILE"));
    expect(imageSize(clean)).toMatchObject({ type: "jpg", width: 2, height: 3 });
  });

  it("removes JFIF and JFXX thumbnails, unknown APP0 data and surplus APP14 data", () => {
    const jfif = [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 1, 1];
    const adobe = [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, 1];
    const input = Uint8Array.from([0xff, 0xd8,
      ...segment(0xe0, [...jfif, 123, 45, 67]),
      ...segment(0xe0, [...ascii("JFXX"), 0, 0x10, ...ascii("uncropped thumbnail")]),
      ...segment(0xe0, ascii("vendor private data")), ...segment(0xe0, ascii("JFIF")),
      ...segment(0xee, [...adobe, ...ascii("private tail")]), ...segment(0xee, ascii("private vendor")),
      ...jpeg().subarray(2)]);
    const clean = stripImageMetadata(input, "image/jpeg");
    for (const text of ["JFXX", "uncropped", "private"]) expect(contains(clean, text)).toBe(false);
    expect([...clean.subarray(2, 20)]).toEqual(segment(0xe0, [...jfif.slice(0, 12), 0, 0]));
    expect(Buffer.from(clean).includes(Buffer.from([123, 45, 67]))).toBe(false);
    expect(Buffer.from(clean).includes(Buffer.from(segment(0xee, adobe)))).toBe(true);
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

  it("rejects truncated containers instead of retaining private trailing bytes", () => {
    for (const [bytes, mime] of [[jpeg().subarray(0, 8), "image/jpeg"],
      [png().subarray(0, 20), "image/png"], [webp().subarray(0, 16), "image/webp"]] as const) {
      expect(() => stripImageMetadata(bytes, mime)).toThrow("Choose a valid");
    }
  });

  it("removes metadata between JPEG scans and before EOI while preserving stuffed and restart bytes", () => {
    const scan = [0x12, 0xff, 0, 0xe1, 0xff, 0xd0, 0x34];
    const input = Uint8Array.from([...jpeg().subarray(0, -2),
      ...segment(0xfe, ascii("private comment")), ...segment(0xe1, ascii("private EXIF")),
      ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), ...scan,
      0xff, ...segment(0xfe, ascii("last comment")), 0xff, 0xd9, ...ascii("trailing secret")]);
    const clean = stripImageMetadata(input, "image/jpeg");
    for (const text of ["private", "last comment", "trailing secret"]) expect(contains(clean, text)).toBe(false);
    expect([...clean.subarray(-scan.length - 2)]).toEqual([...scan, 0xff, 0xd9]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("keeps only orientation %i in each container", (orientation: number) => {
    const tiff = [73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0,
      orientation, 0, 0, 0, 0, 0, 0, 0];
    const privateExif = [...tiff, ...ascii("GPS camera owner")];
    const jpg = Uint8Array.from([0xff, 0xd8, ...segment(0xe1, [...ascii("Exif"), 0, 0, ...privateExif]),
      ...jpeg().subarray(2)]);
    const pngInput = Uint8Array.from([...png().subarray(0, 33), ...pngChunk("eXIf", privateExif), ...png().subarray(33)]);
    const webpBody = [...webp().subarray(12), ...riffChunk("EXIF", privateExif)];
    const webpInput = Uint8Array.from([...ascii("RIFF"), ...u32le(webpBody.length + 4), ...ascii("WEBP"), ...webpBody]);
    for (const [input, mime] of [[jpg, "image/jpeg"], [pngInput, "image/png"], [webpInput, "image/webp"]] as const) {
      const clean = stripImageMetadata(input, mime);
      expect(contains(clean, "GPS")).toBe(false);
      expect(contains(clean, "camera owner")).toBe(false);
      expect(Buffer.from(clean).includes(Buffer.from(tiff))).toBe(true);
      expect(stripImageMetadata(clean, mime)).toEqual(clean);
      if (mime === "image/png") {
        const offset: number = Buffer.from(clean).indexOf("eXIf");
        const view: DataView = new DataView(clean.buffer, clean.byteOffset, clean.byteLength);
        expect(view.getUint32(offset + 4 + tiff.length)).toBe(crc32(clean.subarray(offset, offset + 4 + tiff.length)));
      }
      if (mime === "image/webp") expect(clean[20] & 0x08).toBe(0x08);
    }
    expect(imageSize(stripImageMetadata(jpg, "image/jpeg")).orientation).toBe(orientation);
  });

  it("rejects malformed JPEG lengths, missing EOI and unterminated scans", () => {
    for (const tail of [[0], [0xff], [0xff, 0xe1], [0xff, 0xe1, 0, 1],
      segment(0xe1, [0]), [...segment(0xda, [0]), 0x12, 0xff]]) {
      expect(() => stripImageMetadata(Uint8Array.from([0xff, 0xd8, ...tail]), "image/jpeg")).toThrow("Choose a valid");
    }
  });

  it("preserves standalone JPEG markers", () => {
    const input = Uint8Array.from([0xff, 0xd8, 0xff, 1, 0xff, 0xd0, ...jpeg().subarray(2)]);
    expect([...stripImageMetadata(input, "image/jpeg").subarray(0, 6)]).toEqual([...input.subarray(0, 6)]);
  });

  it("rejects PNGs without an end chunk and malformed WebP chunks", () => {
    expect(() => stripImageMetadata(png().subarray(0, -12), "image/png")).toThrow("Choose a valid");
    const invalid = webp().slice();
    new DataView(invalid.buffer).setUint32(16, invalid.length, true);
    expect(() => stripImageMetadata(invalid, "image/webp")).toThrow("Choose a valid");
    new DataView(invalid.buffer).setUint32(16, 2, true);
    expect(() => stripImageMetadata(invalid, "image/webp")).toThrow("Choose a valid");
  });

  it("refuses a type it does not know", () => {
    expect(() => stripImageMetadata(new Uint8Array(4), "image/gif")).toThrow("Unsupported image type");
  });
});
