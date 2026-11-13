import * as THREE from "three";
import { random, type Random } from "./textures";

// Seamless teal, steel, brass and ivory tiles. Generate color/normal/roughness from one height field so wear
// aligns.

export interface Tile {
  map: THREE.Texture;
  normal: THREE.Texture;
  rough: THREE.Texture;
}

// Paint in 1024 units; SIZE controls pixel resolution, reduced on phones.
const U = 1024;
let SIZE = 1024;
export function setTileResolution(pixels: number): void {
  SIZE = pixels;
}

class Field {
  readonly color: Uint8ClampedArray;
  readonly height: Float32Array;
  readonly rough: Float32Array;
  constructor(
    readonly w: number,
    readonly h: number,
    base: [number, number, number],
    roughness: number,
  ) {
    this.color = new Uint8ClampedArray(w * h * 4);
    this.height = new Float32Array(w * h).fill(0.5);
    this.rough = new Float32Array(w * h).fill(roughness);
    for (let i = 0; i < w * h; i++) {
      this.color[i * 4] = base[0];
      this.color[i * 4 + 1] = base[1];
      this.color[i * 4 + 2] = base[2];
      this.color[i * 4 + 3] = 255;
    }
  }
  readonly k: number = SIZE / U;
  index(x: number, y: number): number {
    return (((Math.trunc(y) % this.h) + this.h) % this.h) * this.w + (((Math.trunc(x) % this.w) + this.w) % this.w);
  }
  // Blend at wrapped painting coordinates; optionally adjust height/roughness.
  paint(
    x: number,
    y: number,
    rgb: readonly [number, number, number],
    alpha: number,
    dh: number = 0,
    rough: number = -1,
  ): void {
    this.paintPx(x * this.k, y * this.k, rgb, alpha, dh, rough);
  }
  // Pixel-coordinate variant.
  paintPx(
    x: number,
    y: number,
    rgb: readonly [number, number, number],
    alpha: number,
    dh: number = 0,
    rough: number = -1,
  ): void {
    const i = this.index(x, y),
      c = i * 4;
    this.color[c] = this.color[c] + (rgb[0] - this.color[c]) * alpha;
    this.color[c + 1] = this.color[c + 1] + (rgb[1] - this.color[c + 1]) * alpha;
    this.color[c + 2] = this.color[c + 2] + (rgb[2] - this.color[c + 2]) * alpha;
    this.height[i] = this.height[i] + dh * alpha;
    if (rough >= 0) this.rough[i] = this.rough[i] + (rough - this.rough[i]) * alpha;
  }
  disc(
    center: readonly [number, number],
    r: number,
    rgb: readonly [number, number, number],
    alpha: number,
    dh: number = 0,
    rough: number = -1,
    soft: boolean = true,
  ): void {
    const [cx, cy] = center;
    const pr = Math.max(0.6, r * this.k),
      px = cx * this.k,
      py = cy * this.k;
    const R = Math.ceil(pr);
    for (let y = -R; y <= R; y++)
      for (let x = -R; x <= R; x++) {
        const d = Math.hypot(x, y) / pr;
        if (d > 1) continue;
        this.paintPx(px + x, py + y, rgb, alpha * (soft ? 1 - d * d : 1), dh, rough);
      }
  }
  line(
    start: readonly [number, number],
    x1: number,
    y1: number,
    rgb: readonly [number, number, number],
    alpha: number,
    dh: number = 0,
    rough: number = -1,
  ): void {
    const [x0, y0] = start;
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * this.k));
    for (let i = 0; i <= n; i++) this.paint(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, rgb, alpha, dh, rough);
  }
  // Seamless low-frequency mottling.
  mottle(
    rnd: Random,
    cells: number,
    rgb: readonly [number, number, number],
    amount: number,
    roughDelta: number = 0,
  ): void {
    const grid = Array.from({ length: cells * cells }, (): number => rnd());
    const at = (gx: number, gy: number): number =>
      grid[(((gy % cells) + cells) % cells) * cells + (((gx % cells) + cells) % cells)];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const fx = (x / this.w) * cells,
          fy = (y / this.h) * cells;
        const ix = Math.floor(fx),
          iy = Math.floor(fy);
        let tx = fx - ix,
          ty = fy - iy;
        tx = tx * tx * (3 - 2 * tx);
        ty = ty * ty * (3 - 2 * ty);
        const v =
          (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) +
          (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
        const i = y * this.w + x;
        this.paint(x, y, rgb, Math.max(0, v - 0.45) * amount);
        this.rough[i] = this.rough[i] + (v - 0.5) * roughDelta;
      }
  }
  grain(rnd: Random, amount: number): void {
    for (let i = 0; i < this.w * this.h; i++) {
      const n = (rnd() - 0.5) * amount;
      this.color[i * 4] = this.color[i * 4] + n;
      this.color[i * 4 + 1] = this.color[i * 4 + 1] + n;
      this.color[i * 4 + 2] = this.color[i * 4 + 2] + n;
      this.height[i] = this.height[i] + n / 900;
    }
  }
  toTile(strength: number): Tile {
    const { w, h } = this;
    const canvas = (): [HTMLCanvasElement, CanvasRenderingContext2D, ImageData] => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      return [c, ctx, ctx.createImageData(w, h)];
    };
    const [mc, mctx, mimg] = canvas();
    mimg.data.set(this.color);
    mctx.putImageData(mimg, 0, 0);
    const [nc, nctx, nimg] = canvas();
    const [rc, rctx, rimg] = canvas();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const dx = (this.height[this.index(x + 1, y)] - this.height[this.index(x - 1, y)]) * strength;
        const dy = (this.height[this.index(x, y + 1)] - this.height[this.index(x, y - 1)]) * strength;
        const len = Math.hypot(dx, dy, 1);
        const o = (y * w + x) * 4;
        nimg.data[o] = ((-dx / len) * 0.5 + 0.5) * 255;
        nimg.data[o + 1] = ((dy / len) * 0.5 + 0.5) * 255;
        nimg.data[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
        nimg.data[o + 3] = 255;
        const r = Math.max(0, Math.min(1, this.rough[y * w + x])) * 255;
        rimg.data[o] = rimg.data[o + 1] = rimg.data[o + 2] = r;
        rimg.data[o + 3] = 255;
      }
    nctx.putImageData(nimg, 0, 0);
    rctx.putImageData(rimg, 0, 0);
    const wrap = (c: HTMLCanvasElement, srgb: boolean): THREE.Texture => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      return t;
    };
    return {
      map: wrap(mc, true),
      normal: wrap(nc, false),
      rough: wrap(rc, false),
    };
  }
}

const rgb = (hex: string): [number, number, number] => {
  const c = Number.parseInt(hex.slice(1), 16);
  return [c >> 16, (c >> 8) & 255, c & 255];
};

// Jagged rust/primer chip with a raised paint rim.
function chip(
  f: Field,
  rnd: Random,
  at: readonly [number, number],
  r: number,
  colors: readonly [string, string],
): void {
  const [cx, cy] = at;
  const [inside, rim] = colors;
  const points = 7 + Math.floor(rnd() * 5);
  const radii = Array.from({ length: points }, (): number => r * (0.5 + rnd() * 0.7));
  const R = Math.ceil(r * 1.4);
  for (let y = -R; y <= R; y++)
    for (let x = -R; x <= R; x++) {
      const ang = ((Math.atan2(y, x) + Math.PI) / (Math.PI * 2)) * points;
      const k = Math.floor(ang) % points,
        t = ang - Math.floor(ang);
      const edge = radii[k] * (1 - t) + radii[(k + 1) % points] * t;
      const d = Math.hypot(x, y);
      if (d < edge) f.paint(cx + x, cy + y, rgb(inside), 0.92, -0.35, 0.85);
      else if (d < edge + 1.6) f.paint(cx + x, cy + y, rgb(rim), 0.45, 0.08);
    }
}

function drip(
  f: Field,
  rnd: Random,
  at: readonly [number, number],
  len: number,
  paint: readonly [string, number],
): void {
  const [x, y] = at;
  const [color, alpha] = paint;
  let px = x;
  for (let i = 0; i < len; i++) {
    px += (rnd() - 0.5) * 0.35;
    const a = alpha * Math.pow(1 - i / len, 1.3);
    f.paint(px, y + i, rgb(color), a, 0, 0.75);
    f.paint(px + 1, y + i, rgb(color), a * 0.5);
  }
}

// Teal paint, hairline cracks and rust runs.
export function tealPaint(seed: number = 1): Tile {
  const rnd = random(seed);
  const f = new Field(SIZE, SIZE, rgb("#1f6a60"), 0.55);
  f.mottle(rnd, 6, rgb("#2a7a6e"), 0.5, 0.25);
  f.mottle(rnd, 18, rgb("#17564e"), 0.4, 0.1);
  f.grain(rnd, 7);
  for (let i = 0; i < 220; i++) {
    const x = rnd() * U,
      y = rnd() * U,
      a = rnd() * Math.PI * 2,
      l = 10 + rnd() * 40;
    f.line([x, y], x + Math.cos(a) * l, y + Math.sin(a) * l, rgb("#4f9d90"), 0.18, 0.02);
  }
  for (let i = 0; i < 150; i++) {
    const x = rnd() * U,
      y = rnd() * U,
      r = 1.5 + Math.pow(rnd(), 2.5) * 9;
    chip(f, rnd, [x, y], r, [rnd() > 0.3 ? "#7a4a24" : "#5b3a20", "#3f9488"]);
    if (rnd() > 0.55) drip(f, rnd, [x, y + r], 15 + rnd() * 70, ["#6e4a2c", 0.28]);
  }
  return f.toTile(9);
}

// Steel scratches and rust blooms.
export function platformSteel(seed: number = 2): Tile {
  const rnd = random(seed);
  const f = new Field(SIZE, SIZE, rgb("#776a5b"), 0.5);
  f.mottle(rnd, 5, rgb("#857767"), 0.55, 0.2);
  f.mottle(rnd, 14, rgb("#62574b"), 0.5, 0.15);
  f.grain(rnd, 9);
  for (let i = 0; i < 26; i++) {
    const x = rnd() * U,
      y = rnd() * U;
    for (let k = 0; k < 6; k++)
      f.disc([x + (rnd() - 0.5) * 40, y + (rnd() - 0.5) * 40], 10 + rnd() * 22, rgb("#94603a"), 0.22, -0.02, 0.8);
  }
  for (let i = 0; i < 500; i++) {
    const x = rnd() * U,
      y = rnd() * U,
      a = rnd() * Math.PI * 2,
      l = 15 + rnd() * 90;
    f.line([x, y], x + Math.cos(a) * l, y + Math.sin(a) * l, rgb("#bfae93"), 0.12 + rnd() * 0.15, -0.03, 0.3);
  }
  for (let i = 0; i < 1500; i++) f.disc([rnd() * U, rnd() * U], 0.8 + rnd(), rgb("#3a3129"), 0.4, -0.05);
  return f.toTile(7);
}

// Brushed brass, tarnish, pits and scratches.
export function agedBrass(seed: number = 3): Tile {
  const rnd = random(seed);
  const f = new Field(SIZE, SIZE, rgb("#b5862f"), 0.4);
  f.mottle(rnd, 5, rgb("#c99a40"), 0.6, 0.15);
  f.mottle(rnd, 12, rgb("#946a24"), 0.55, 0.2);
  for (let y = 0; y < SIZE; y++) {
    let run = 0;
    const shade = (rnd() - 0.5) * 28;
    for (let x = 0; x < SIZE; x++) {
      if (run <= 0) run = 20 + rnd() * 200;
      run--;
      const i = y * SIZE + x;
      f.color[i * 4] = f.color[i * 4] + shade * 0.6;
      f.color[i * 4 + 1] = f.color[i * 4 + 1] + shade * 0.5;
      f.color[i * 4 + 2] = f.color[i * 4 + 2] + shade * 0.25;
      f.height[i] = f.height[i] + shade / 1500;
    }
  }
  for (let i = 0; i < 120; i++) {
    const x = rnd() * U,
      y = rnd() * U;
    for (let k = 0; k < 8; k++)
      f.disc([x + (rnd() - 0.5) * 26, y + (rnd() - 0.5) * 18], 0.8 + rnd() * 2, rgb("#5d5a2e"), 0.7, -0.08, 0.75);
  }
  for (let i = 0; i < 60; i++) {
    const x = rnd() * U,
      y = rnd() * U,
      a = -0.4 + (rnd() - 0.5) * 0.4,
      l = 40 + rnd() * 160;
    f.line([x, y], x + Math.cos(a) * l, y + Math.sin(a) * l, rgb("#f2c46a"), 0.5, -0.04, 0.2);
  }
  return f.toTile(6);
}

function enamelEdge(x: number, y: number, step: number, cells: number, pts: readonly number[]): number {
  const gx = Math.floor(x / step),
    gy = Math.floor(y / step);
  let d1 = 1e9,
    d2 = 1e9;
  for (let oy = -1; oy <= 1; oy++)
    for (let ox = -1; ox <= 1; ox++) {
      const cx = gx + ox,
        cy = gy + oy;
      const wx = ((cx % cells) + cells) % cells,
        wy = ((cy % cells) + cells) % cells;
      const px = pts[(wy * cells + wx) * 2] + (cx - wx) * step,
        py = pts[(wy * cells + wx) * 2 + 1] + (cy - wy) * step;
      const d = Math.hypot(px - x, py - y);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) d2 = d;
    }
  return d2 - d1;
}

// Ivory enamel, cracks, pits and rust runs.
export function ivoryEnamel(seed: number = 4): Tile {
  const rnd = random(seed);
  const f = new Field(SIZE, SIZE, rgb("#dcc08a"), 0.45);
  f.mottle(rnd, 6, rgb("#e6cd98"), 0.5, 0.15);
  f.mottle(rnd, 16, rgb("#cfb07a"), 0.45, 0.1);
  f.grain(rnd, 6);
  // Cracks follow seamless jittered Voronoi borders.
  const cells = Math.max(16, Math.round((64 * SIZE) / U)),
    step = SIZE / cells;
  const pts: number[] = [];
  for (let gy = 0; gy < cells; gy++)
    for (let gx = 0; gx < cells; gx++) pts.push((gx + rnd()) * step, (gy + rnd()) * step);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const e = enamelEdge(x, y, step, cells, pts);
      if (e < 1.4) f.paintPx(x, y, rgb("#a88a58"), 0.55 * (1 - e / 1.4), -0.12, 0.7);
    }
  for (let i = 0; i < 130; i++) {
    const x = rnd() * U,
      y = rnd() * U,
      r = 1.5 + rnd() * 3.5;
    f.disc([x, y], r + 1.5, rgb("#c8945a"), 0.5, -0.05);
    f.disc([x, y], r, rgb("#9c4a1c"), 0.95, -0.3, 0.85, false);
    if (rnd() > 0.7) drip(f, rnd, [x, y + r], 20 + rnd() * 60, ["#b8743a", 0.35]);
  }
  return f.toTile(8);
}

// World-space curvature, height and facing place edge wear, grime and dust independently of tile repetition.
export interface WearOptions {
  // Exposed substrate.
  exposed: string;
  // Edge wear strength, 0..1.
  edges: number;
  // Deck grime strength, 0..1.
  grime: number;
  // Exposed substrate metalness/roughness.
  exposedMetal: number;
  exposedRough: number;
  // Deck height in model units.
  ground?: number;
  // Vertical rain-streak strength.
  streaks?: number;
  // Model-space triplanar mapping preserves texel density.
  tile?: Tile;
  // Tiles per model unit.
  scale?: number;
  // Tile normal strength.
  detail?: number;
}

// Inverse station world matrix keeps wear attached during sway/rotation.
export const frame = { value: new THREE.Matrix4() };
export const frameInverse = { value: new THREE.Matrix4() };

const NOISE = `
    float sbHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float sbNoise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(sbHash(i), sbHash(i + vec3(1,0,0)), f.x), mix(sbHash(i + vec3(0,1,0)), sbHash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(sbHash(i + vec3(0,0,1)), sbHash(i + vec3(1,0,1)), f.x), mix(sbHash(i + vec3(0,1,1)), sbHash(i + vec3(1,1,1)), f.x), f.y), f.z); }
    float sbFbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * sbNoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

export function wear(material: THREE.MeshStandardMaterial, o: WearOptions): THREE.MeshStandardMaterial {
  const exposed = new THREE.Color(o.exposed);
  const tiled = !!o.tile;
  material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    shader.uniforms.sbExposed = { value: exposed };
    shader.uniforms.sbWear = {
      value: new THREE.Vector4(o.edges, o.grime, o.ground ?? 0.45, o.streaks ?? 0.5),
    };
    shader.uniforms.sbExposedPbr = {
      value: new THREE.Vector2(o.exposedMetal, o.exposedRough),
    };
    shader.uniforms.sbFrame = frame;
    shader.uniforms.sbFrameInverse = frameInverse;
    shader.uniforms.sbTile = { value: o.tile?.map ?? null };
    shader.uniforms.sbTileRough = { value: o.tile?.rough ?? null };
    shader.uniforms.sbTileNormal = { value: o.tile?.normal ?? null };
    shader.uniforms.sbTiling = {
      value: new THREE.Vector2(o.scale ?? 0.8, o.detail ?? 0.6),
    };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform mat4 sbFrame;\nvarying vec3 vSbWP;\nvarying vec3 vSbWN;",
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
                vec4 sbP = vec4(transformed, 1.0);
                vec3 sbN = objectNormal;
                #ifdef USE_INSTANCING
                    sbP = instanceMatrix * sbP;
                    sbN = mat3(instanceMatrix) * sbN;
                #endif
                vSbWP = (sbFrame * modelMatrix * sbP).xyz;
                vSbWN = normalize(mat3(sbFrame) * mat3(modelMatrix) * sbN);`,
      );
    let frag = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
                varying vec3 vSbWP; varying vec3 vSbWN;
                uniform vec3 sbExposed; uniform vec4 sbWear; uniform vec2 sbExposedPbr; uniform vec2 sbTiling;
                uniform mat4 sbFrameInverse;
                uniform sampler2D sbTile; uniform sampler2D sbTileRough; uniform sampler2D sbTileNormal;
                float sbMask = 0.0; float sbGrime = 0.0; float sbRust = 0.0;
                ${NOISE}
                vec3 sbWeights(vec3 n){ vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z); }
                vec4 sbTri(sampler2D t, vec3 p, vec3 w){ return texture2D(t, p.zy) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z; }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
                {
                    vec3 n = normalize(vSbWN);
                    ${tiled ? "diffuseColor.rgb *= sbTri(sbTile, vSbWP * sbTiling.x, sbWeights(n)).rgb;" : ""}
                    float curvature = clamp(length(fwidth(n)) * 6.0 / max(length(fwidth(vSbWP)) * 40.0, 0.25), 0.0, 1.0);
                    float breakup = sbFbm(vSbWP * 7.0);
                    float speck = sbNoise(vSbWP * 55.0);
                    sbMask = smoothstep(0.55, 0.85, curvature * 0.9 + breakup * 0.55 + speck * 0.18) * sbWear.x;
                    sbMask = max(sbMask, smoothstep(0.84, 0.9, breakup * 0.7 + speck * 0.45) * sbWear.x * 0.8);
                    float h = vSbWP.y - sbWear.z;
                    sbGrime = (1.0 - smoothstep(0.0, 0.9, h)) * (0.55 + 0.45 * sbFbm(vSbWP * 3.0)) * sbWear.y;
                    float streak = smoothstep(0.62, 0.9, sbNoise(vec3(vSbWP.x * 22.0 + vSbWP.z * 22.0, vSbWP.y * 0.8, 0.0))) * (1.0 - abs(n.y)) * sbWear.w;
                    #ifdef USE_BUMPMAP
                    {
                        // Rust blooms along panel seams (dark in the bump map) and around rivets (bright),
                        // then runs downward in thin, broken streaks.
                        vec2 texel = 4.0 / vec2(textureSize(bumpMap, 0));
                        float source = 0.0;
                        for (int k = 0; k < 4; k++) {
                            vec2 o = vec2(float(k == 0) - float(k == 1), float(k == 2) - float(k == 3)) * texel;
                            float b = texture2D(bumpMap, vBumpMapUv + o).r;
                            source = max(source, max(1.0 - smoothstep(0.2, 0.42, b), smoothstep(0.78, 0.9, b)));
                        }
                        float run = 0.0;
                        for (int k = 1; k <= 7; k++) {
                            float b = texture2D(bumpMap, vBumpMapUv + vec2(0.0, float(k) * texel.y * 1.6)).r;
                            float src = max(1.0 - smoothstep(0.2, 0.42, b), smoothstep(0.78, 0.9, b));
                            run = max(run, src * (1.0 - float(k) / 8.0));
                        }
                        float lanes = smoothstep(0.5, 0.78, sbNoise(vec3((vSbWP.x + vSbWP.z) * 38.0, vSbWP.y * 1.5, 3.0)));
                        sbRust = max(source * smoothstep(0.35, 0.62, breakup + speck * 0.35), run * lanes * (1.0 - abs(n.y))) * sbWear.x;
                        vec3 rustColor = mix(vec3(0.22, 0.07, 0.02), vec3(0.36, 0.13, 0.04), speck);
                        diffuseColor.rgb = mix(diffuseColor.rgb, rustColor, clamp(sbRust, 0.0, 1.0) * 0.85);
                    }
                    #endif
                    diffuseColor.rgb = mix(diffuseColor.rgb, sbExposed * (0.75 + 0.5 * speck), sbMask);
                    diffuseColor.rgb *= 1.0 - sbGrime * 0.38 - streak * 0.18;
                    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.3, 0.2), sbGrime * 0.18);
                }`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
                ${tiled ? "roughnessFactor *= sbTri(sbTileRough, vSbWP * sbTiling.x, sbWeights(normalize(vSbWN))).g * 1.6;" : ""}
                roughnessFactor = mix(roughnessFactor, sbExposedPbr.y, sbMask);
                roughnessFactor = clamp(roughnessFactor + sbGrime * 0.25 + sbRust * 0.35, 0.04, 1.0);`,
      )
      .replace(
        "#include <metalnessmap_fragment>",
        `#include <metalnessmap_fragment>
                metalnessFactor = mix(metalnessFactor, sbExposedPbr.x, sbMask);`,
      );
    if (tiled)
      frag = frag.replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
                {
                    vec3 n = normalize(vSbWN);
                    vec3 w = sbWeights(n);
                    vec3 p = vSbWP * sbTiling.x;
                    vec3 tx = texture2D(sbTileNormal, p.zy).xyz * 2.0 - 1.0;
                    vec3 ty = texture2D(sbTileNormal, p.xz).xyz * 2.0 - 1.0;
                    vec3 tz = texture2D(sbTileNormal, p.xy).xyz * 2.0 - 1.0;
                    tx = vec3(tx.xy + n.zy, abs(tx.z) * n.x);
                    ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y);
                    tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);
                    vec3 detailed = normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
                    vec3 delta = mat3(viewMatrix) * mat3(sbFrameInverse) * (detailed - n);
                    normal = normalize(normal + delta * sbTiling.y);
                }`,
      );
    shader.fragmentShader = frag;
  };
  material.customProgramCacheKey = (): string => `sb-wear-${o.exposed}-${o.edges}-${o.grime}-${tiled}`;
  return material;
}

// Noise-painted alpha decals add flaked edges and feathered drips.
export type DecalKind =
  | "chip"
  | "bolts1"
  | "bolts2"
  | "bolts3"
  | "scratches"
  | "gouge"
  | "scuff"
  | "crossed"
  | "rust"
  | "verdigris"
  | "grime";

function valueNoise(seed: number): (x: number, y: number) => number {
  const rnd = random(seed);
  const N = 256;
  const table = Array.from({ length: N * N }, (): number => rnd());
  const at = (x: number, y: number): number => table[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  const noise = (x: number, y: number): number => {
    const ix = Math.floor(x),
      iy = Math.floor(y);
    let fx = x - ix,
      fy = y - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    return (
      (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) +
      (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy
    );
  };
  return (x: number, y: number): number =>
    noise(x, y) * 0.5 + noise(x * 2.1, y * 2.1) * 0.25 + noise(x * 4.3, y * 4.3) * 0.15 + noise(x * 9.1, y * 9.1) * 0.1;
}

type PixelPainter = (x: number, y: number, color: readonly [number, number, number], alpha: number) => void;
interface DecalPaint {
  kind: DecalKind;
  rnd: Random;
  fbm: (x: number, y: number) => number;
  W: number;
  H: number;
  px: PixelPainter;
}
const rust = (v: number): [number, number, number] => [118 + v * 40, 58 + v * 28, 22 + v * 10];

function paintChip({ rnd, fbm, W, H, px }: DecalPaint): void {
  // Chip layers: teal rim, ivory primer, pitted rust.
  const sx = 0.8 + rnd() * 0.5;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / (W * 0.42 * sx),
        dy = (y - H / 2) / (H * 0.3);
      const m = fbm(x / 26, y / 26) * 1.15 - Math.hypot(dx, dy) * 0.75;
      if (m > 0.5) {
        const v = fbm(x / 5, y / 5);
        px(x, y, v > 0.62 ? [70, 34, 16] : rust(v), 0.97);
      } else if (m > 0.4) px(x, y, [214, 196, 158], 0.95);
      else if (m > 0.37) px(x, y, [70, 150, 136], 0.7);
      else if (m > 0.35) px(x, y, [20, 30, 28], 0.35);
    }
}

function paintBoltRuns({ rnd, fbm, px }: DecalPaint, bx: number): void {
  for (let k = 0; k < 6; k++) {
    let x = bx + (rnd() - 0.5) * 44;
    const len = 120 + rnd() * 340,
      w = 1.2 + rnd() * 4.5;
    for (let y = 40; y < 40 + len; y++) {
      x += (fbm(x / 20, y / 30) - 0.5) * 0.5;
      const t = (y - 40) / len,
        a = 0.75 * Math.pow(1 - t, 1.2) * (0.6 + 0.4 * fbm(x / 6, y / 6));
      for (let o = -w; o <= w; o++) px(x + o, y, rust(fbm(x / 9, y / 9) * 0.8), a * (1 - Math.abs(o) / (w + 1)));
    }
  }
}

function paintBoltHead({ fbm, px }: DecalPaint, bx: number): void {
  for (let y = 0; y < 90; y++)
    for (let x = bx - 50; x < bx + 50; x++) {
      const d = Math.hypot(x - bx, (y - 40) * 1.3) / 48;
      const v = fbm(x / 8, y / 8);
      if (d < 1 && v > d * 0.7) px(x, y, rust(v), 0.85 * (1 - d));
    }
  for (let y = 26; y < 56; y++)
    for (let x = bx - 15; x < bx + 15; x++) {
      const d = Math.hypot(x - bx, y - 41) / 14;
      if (d < 1) {
        const l = 1 - Math.hypot(x - bx + 5, y - 36) / 18;
        px(x, y, [90 + l * 120, 62 + l * 90, 30 + l * 50], 1);
      }
    }
}

function paintBolts(paint: DecalPaint): void {
  const { kind, W } = paint;
  const n = Number(kind.slice(5));
  const xs = Array.from(
    { length: n },
    (_: unknown, i: number): number => W * (n === 1 ? 0.5 : 0.18 + (0.64 * i) / (n - 1)),
  );
  for (const bx of xs) {
    paintBoltRuns(paint, bx);
    paintBoltHead(paint, bx);
  }
}

function paintCorrosionPixel({ kind, fbm, W, H, px }: DecalPaint, x: number, y: number): void {
  const green = kind === "verdigris";
  const d = Math.hypot(x - W / 2, y - H / 2) / (W * 0.45);
  const v = fbm(x / 22, y / 22),
    fine = fbm(x / 4, y / 4);
  const m = v * 1.2 - d * 0.8;
  const rustColor: [number, number, number] = fine > 0.65 ? [64, 30, 14] : rust(fine);
  if (m > 0.34)
    px(
      x,
      y,
      green ? [70 + fine * 60, 120 + fine * 50, 90 + fine * 30] : rustColor,
      green ? 0.75 * Math.min(1, (m - 0.34) * 6) : 0.95,
    );
  else if (!green && m > 0.28 && fine > 0.6) px(x, y, rust(fine), 0.9);
}

function paintCorrosion(paint: DecalPaint): void {
  const { W, H } = paint;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      paintCorrosionPixel(paint, x, y);
    }
}

function paintGrime({ rnd, fbm, W, px }: DecalPaint): void {
  for (let y = 0; y < 40; y++)
    for (let x = 0; x < W; x++) px(x, y, [52, 44, 30], 0.55 * (1 - y / 40) * (0.5 + fbm(x / 10, y / 10)));
  for (let k = 0; k < 26; k++) {
    let x = rnd() * W;
    const len = 60 + rnd() * 380,
      w = 2 + rnd() * 9;
    for (let y = 20; y < 20 + len; y++) {
      x += (fbm(x / 20, y / 25) - 0.5) * 0.4;
      const a = 0.45 * Math.pow(1 - (y - 20) / len, 1.5);
      for (let o = -w; o <= w; o++)
        px(x + o, y, [60, 52, 34], a * (1 - Math.abs(o) / (w + 1)) * (0.5 + fbm(x / 5, y / 5)));
    }
  }
}

interface Scratch {
  ang: number;
  cx: number;
  cy: number;
  len: number;
  bend: number;
  wmax: number;
}
function paintScratchWidth(
  { kind, fbm, px }: DecalPaint,
  { x, y, a, taper, w }: { x: number; y: number; a: number; taper: number; w: number },
): void {
  for (let o = -w; o <= w; o++) {
    const nx = x - Math.sin(a) * o,
      ny = y + Math.cos(a) * o;
    if (kind === "gouge") px(nx, ny, Math.abs(o) > w * 0.6 ? [214, 196, 158] : rust(fbm(nx / 4, ny / 4)), 0.95);
    else
      px(
        nx,
        ny,
        o < 0 ? [226, 205, 160] : [60, 46, 30],
        (kind === "scuff" ? 0.28 : 0.7) * taper * (1 - Math.abs(o) / (w + 1)),
      );
  }
}

function paintScratch(paint: DecalPaint, { ang, cx, cy, len, bend, wmax }: Scratch): void {
  for (let t = -len / 2; t < len / 2; t++) {
    const a = ang + bend * t;
    const x = cx + Math.cos(a) * t,
      y = cy + Math.sin(a) * t + bend * t * t * 0.5;
    const taper = 1 - Math.abs(t) / (len / 2);
    const w = wmax * Math.sqrt(taper);
    paintScratchWidth(paint, { x, y, a, taper, w });
  }
}

function paintScratches(paint: DecalPaint): void {
  const { kind, rnd, W, H } = paint;
  // Parallel, swirling and crossed scratches.
  const lineCounts: Partial<Record<DecalKind, number>> = {
    scuff: 70,
    crossed: 14,
    gouge: 5,
  };
  const lines = lineCounts[kind] ?? 12;
  const base = -0.25 + (rnd() - 0.5) * 0.3;
  for (let i = 0; i < lines; i++) {
    const crossAngle = i % 2 ? 0.6 : -0.7;
    const ang = kind === "crossed" ? crossAngle + (rnd() - 0.5) * 0.3 : base + (rnd() - 0.5) * 0.15;
    const cx = W * (0.2 + rnd() * 0.6),
      cy = H * (0.2 + rnd() * 0.6),
      len = (kind === "scuff" ? 40 : 90) + rnd() * 120;
    const bend = kind === "scuff" ? (rnd() - 0.5) * 0.02 : 0;
    const wmax = kind === "gouge" ? 7 + rnd() * 6 : 0.8 + rnd() * 1.4;
    paintScratch(paint, { ang, cx, cy, len, bend, wmax });
  }
}

export function decalTexture(kind: DecalKind, seed: number): THREE.Texture {
  const rnd = random(seed);
  const fbm = valueNoise(seed + 17);
  const tall = kind.startsWith("bolts") || kind === "grime";
  const W = 256,
    H = tall ? 512 : 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const px = (x: number, y: number, col: readonly [number, number, number], a: number): void => {
    x = Math.trunc(x);
    y = Math.trunc(y);
    if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
    const o = (y * W + x) * 4,
      A = img.data[o + 3] / 255,
      na = a + A * (1 - a);
    for (let k = 0; k < 3; k++) img.data[o + k] = (col[k] * a + img.data[o + k] * A * (1 - a)) / Math.max(na, 1e-4);
    img.data[o + 3] = na * 255;
  };
  const paint: DecalPaint = { kind, rnd, fbm, W, H, px };
  if (kind === "chip") paintChip(paint);
  else if (kind.startsWith("bolts")) paintBolts(paint);
  else if (kind === "rust" || kind === "verdigris") paintCorrosion(paint);
  else if (kind === "grime") paintGrime(paint);
  else paintScratches(paint);
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function decalMaterial(kind: DecalKind, seed: number): THREE.MeshStandardMaterial {
  const shiny = kind === "scratches" || kind === "scuff" || kind === "crossed";
  return new THREE.MeshStandardMaterial({
    map: decalTexture(kind, seed),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    roughness: shiny ? 0.35 : 0.85,
    metalness: shiny ? 0.5 : 0.1,
  });
}

export { random } from "./textures";
