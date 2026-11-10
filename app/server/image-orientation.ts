/** Read only IFD0 orientation; never copy private tags, pointers or thumbnails. */
export function orientationExif(input: Uint8Array): Uint8Array | undefined {
  const prefixed: boolean = input.length >= 6 && input[0] === 0x45 && input[1] === 0x78 &&
    input[2] === 0x69 && input[3] === 0x66 && input[4] === 0 && input[5] === 0;
  const bytes: Uint8Array = prefixed ? input.subarray(6) : input;
  if (bytes.length < 8) return undefined;
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order: number = view.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return undefined;
  const little: boolean = order === 0x4949;
  if (view.getUint16(2, little) !== 42) return undefined;
  const ifd: number = view.getUint32(4, little);
  if (ifd < 8 || ifd > bytes.length - 2) return undefined;
  const count: number = view.getUint16(ifd, little);
  if (ifd + 2 + count * 12 + 4 > bytes.length) return undefined;
  for (let index = 0; index < count; index++) {
    const offset: number = ifd + 2 + index * 12;
    if (view.getUint16(offset, little) !== 0x0112 || view.getUint16(offset + 2, little) !== 3 ||
      view.getUint32(offset + 4, little) !== 1) continue;
    const orientation: number = view.getUint16(offset + 8, little);
    if (orientation < 1 || orientation > 8) return undefined;
    return Uint8Array.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0,
      0x12, 1, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0]);
  }
  return undefined;
}
