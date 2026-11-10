import { describe, expect, it } from "vitest";
import { orientationExif } from "../app/server/image-orientation";

function exif(little: boolean, orientation: number): Uint8Array {
  const bytes: Uint8Array = new Uint8Array(38);
  const view: DataView = new DataView(bytes.buffer);
  view.setUint16(0, little ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, 2, little);
  // Private camera tag before orientation, followed by a private IFD pointer.
  view.setUint16(10, 0x010f, little);
  view.setUint16(22, 0x0112, little);
  view.setUint16(24, 3, little);
  view.setUint32(26, 1, little);
  view.setUint16(30, orientation, little);
  view.setUint32(34, 1234, little);
  return bytes;
}

describe("orientation EXIF", () => {
  it.each([true, false])("reads either byte order and removes other tags and pointers (%s)", (little: boolean) => {
    const result: Uint8Array | undefined = orientationExif(exif(little, 6));
    expect(result).toHaveLength(26);
    expect(result?.[18]).toBe(6);
    expect(result?.subarray(22)).toEqual(new Uint8Array(4));
  });

  it("rejects invalid TIFF headers, directories and orientation entries", () => {
    const original: Uint8Array = exif(true, 6);
    for (const length of [0, 4, 7, 9, 20, 37]) expect(orientationExif(original.subarray(0, length))).toBeUndefined();
    for (const [offset, value] of [[0, 0], [2, 0], [4, 0], [4, 255], [8, 255],
      [22, 0], [24, 4], [26, 2], [30, 0], [30, 9]]) {
      const bytes: Uint8Array = original.slice();
      bytes[offset] = value;
      expect(orientationExif(bytes)).toBeUndefined();
    }
  });
});
