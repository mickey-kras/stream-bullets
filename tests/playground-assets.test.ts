import { Buffer as NodeBuffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { imageSize } from "image-size";
import { describe, expect, it } from "vitest";
import { CHARACTER_ROWS } from "../app/components/overlay/characters/view";
import { WASTELAND_PLAYGROUND as theme, type Rect } from "../app/components/overlay/wasteland/playground-theme";

// Workers globals declare Buffer as any; use the Node constructor type for this Node test.
const Buffer: BufferConstructor = NodeBuffer as BufferConstructor;

const file = (url: string): Buffer => readFileSync(new URL(`../public${url.split("?")[0]}`, import.meta.url));
const courier: Buffer = file(theme.courier.url);
const terrain: Buffer = file(theme.terrain.url);

/** Alpha of every pixel of an 8-bit indexed PNG (the only kind the atlas tools write). */
function alphaOf(png: Buffer): { width: number; height: number; alpha: Uint8Array } {
  let pos = 8;
  let width = 0;
  let height = 0;
  let transparency: Buffer = Buffer.alloc(0);
  const data: Buffer[] = [];
  while (pos < png.length) {
    const length: number = png.readUInt32BE(pos);
    const type: string = png.toString("latin1", pos + 4, pos + 8);
    const body: Buffer = png.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect([body[8], body[9], body[12]]).toEqual([8, 3, 0]); // 8-bit, indexed, not interlaced
    }
    if (type === "tRNS") transparency = body;
    if (type === "IDAT") data.push(body);
    pos += length + 12;
  }
  const raw: Buffer = inflateSync(Buffer.concat(data));
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter: number = raw[y * (width + 1)];
    for (let x = 0; x < width; x++) {
      const value: number = raw[y * (width + 1) + 1 + x];
      const left: number = x > 0 ? indices[y * width + x - 1] : 0;
      const up: number = y > 0 ? indices[(y - 1) * width + x] : 0;
      const corner: number = x > 0 && y > 0 ? indices[(y - 1) * width + x - 1] : 0;
      const paeth = (): number => {
        const p: number = left + up - corner;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        return a <= b && a <= c ? left : b <= c ? up : corner;
      };
      const predictor: number = [0, left, up, (left + up) >> 1, paeth()][filter];
      indices[y * width + x] = (value + predictor) & 255;
    }
  }
  const alpha: Uint8Array = indices.map((i: number): number => (i < transparency.length ? transparency[i] : 255));
  return { width, height, alpha };
}

describe("playground atlas files", () => {
  it("have the sizes the theme expects and stay within the byte budgets", () => {
    const { regionWidth, regionHeight, cell, rows } = theme.courier;
    expect(imageSize(courier)).toMatchObject({ width: regionWidth * 3, height: regionHeight, type: "png" });
    expect(imageSize(terrain)).toMatchObject({ type: "png" });
    expect(rows).toEqual(CHARACTER_ROWS);
    expect(rows.length * cell).toBeLessThanOrEqual(regionHeight);
    expect(4 * cell).toBe(regionWidth);
    expect(courier.length).toBeLessThanOrEqual(25 * 1024);
    expect(terrain.length).toBeLessThanOrEqual(20 * 1024);
  });

  it("are named by their content hash", () => {
    for (const [url, bytes] of [
      [theme.courier.url, courier],
      [theme.terrain.url, terrain],
    ] as const) {
      expect(url).toBe(`${url.split("?")[0]}?v=${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}`);
    }
  });

  it("keep every mask pixel on a pixel of the base region", () => {
    const { width, height, alpha } = alphaOf(courier);
    const { regions, regionWidth } = theme.courier;
    let masked = 0;
    const outside: string[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < regionWidth; x++) {
        const base: number = alpha[y * width + regions.base + x];
        for (const region of [regions.helmet, regions.scarf]) {
          const mask: number = alpha[y * width + region + x];
          if (mask > 0) masked++;
          if (mask > 0 && base !== 255) outside.push(`${region + x},${y}`);
        }
      }
    }
    expect(outside).toEqual([]);
    expect(masked).toBeGreaterThan(1000);
  });

  it("place every terrain picture inside the atlas without overlap", () => {
    const { width, height } = imageSize(terrain);
    const rects: Rect[] = Object.values(theme.terrain.rects);
    for (const [x, y, w, h] of rects) {
      expect(Number.isInteger(x + y + w + h)).toBe(true);
      expect(x >= 0 && y >= 0 && x + w <= width && y + h <= height).toBe(true);
    }
    rects.forEach(([ax, ay, aw, ah]: Rect, i: number): void => {
      for (const [bx, by, bw, bh] of rects.slice(i + 1)) {
        expect(ax + aw <= bx || bx + bw <= ax || ay + ah <= by || by + bh <= ay).toBe(true);
      }
    });
    const tile: number = theme.terrain.tile;
    for (const name of ["girderL", "girderM", "girderR", "dirt0", "dirt1", "dirt2", "crack1", "crack2", "hole"] as const) {
      expect(theme.terrain.rects[name].slice(2)).toEqual([tile, tile]);
    }
  });

  it("place the loose equipment below the animation cells", () => {
    const { helmet, boot, rows, cell, regionWidth, regionHeight } = theme.courier;
    for (const [x, y, w, h] of [helmet, boot]) {
      expect(y).toBeGreaterThanOrEqual(rows.length * cell);
      expect(x + w <= regionWidth && y + h <= regionHeight).toBe(true);
    }
  });
});
