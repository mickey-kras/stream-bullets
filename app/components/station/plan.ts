import * as THREE from "three";
import { add, mesh, TAU, DECK_Y } from "./shapes";

/* The broadcast hall stands on a superellipse plan: round-ish, with a broad, flattened, glazed front.
   Angles run from +z (the street) toward +x; `grow` pushes a point outward from the wall line. */

const HX = 2.75;
const HZ = 2.05;
const SE = 3.2;

/** Where the hall stands on the station deck. */
export const HALL_AT = new THREE.Vector3(-0.7, DECK_Y, -0.25);

export const GLASS_FROM = -2.05;
export const GLASS_TO = 1.3;

export function plan(a: number, grow = 0, y = 0): THREE.Vector3 {
  const s = Math.sin(a);
  const c = Math.cos(a);
  return new THREE.Vector3(
    Math.sign(s) * Math.abs(s) ** (2 / SE) * (HX + grow),
    y,
    Math.sign(c) * Math.abs(c) ** (2 / SE) * (HZ + grow),
  );
}

/** Outward-facing yaw of the wall at angle a, for mounting things flush on it. */
export function facing(a: number): number {
  const p = plan(a - 0.003);
  const q = plan(a + 0.003);
  return Math.atan2(-(q.z - p.z), q.x - p.x);
}

export function facingIn(a: number): number {
  return facing(a) + Math.PI;
}

export function loop(a0: number, a1: number, grow: number, y: number, n = 96, closed = false): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < (closed ? n : n + 1); i++) pts.push(plan(a0 + ((a1 - a0) * i) / n, grow, y));
  return pts;
}

export interface BandOptions {
  /** Faces point into the hall instead of out of it. */
  inward?: boolean;
  segments?: number;
  /** UVs span 0..1 across the band (decals) instead of metres. */
  unit?: boolean;
}

/** A vertical strip of wall following the plan between angles `range` and heights `heights`. */
export function band(
  range: readonly [number, number],
  heights: readonly [number, number],
  grow: number,
  mat: THREE.Material,
  parent: THREE.Object3D,
  options: BandOptions = {},
): THREE.Mesh {
  const [a0, a1] = range;
  const [y0, y1] = heights;
  const { inward = false, segments: n = 128, unit = false } = options;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let run = 0;
  let prev = plan(a0, grow);
  for (let i = 0; i <= n; i++) {
    const p = plan(a0 + ((a1 - a0) * i) / n, grow);
    run += p.distanceTo(prev);
    prev = p;
    pos.push(p.x, y0, p.z, p.x, y1, p.z);
    const u = unit ? i / n : run / 5;
    uv.push(u, 0, u, unit ? 1 : (y1 - y0) / 2.5);
    if (i < n) {
      const A = i * 2;
      if (inward) idx.push(A, A + 1, A + 2, A + 2, A + 1, A + 3);
      else idx.push(A, A + 2, A + 1, A + 2, A + 3, A + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return mesh(g, mat, [0, 0, 0], parent);
}

export function planShape(grow: number): THREE.Shape {
  const s = new THREE.Shape();
  loop(0, TAU, grow, 0, 160, true).forEach((p: THREE.Vector3, i: number): void => {
    if (i === 0) s.moveTo(p.x, -p.z);
    else s.lineTo(p.x, -p.z);
  });
  s.closePath();
  return s;
}

/** A flat plate in the plan's shape, `h` thick, starting at height `y`. */
export function capSlab(grow: number, y: number, h: number, mat: THREE.Material, parent: THREE.Object3D): THREE.Mesh {
  const g = new THREE.ExtrudeGeometry(planShape(grow), { depth: h, bevelEnabled: false, curveSegments: 4 });
  g.rotateX(-Math.PI / 2);
  return mesh(g, mat, [0, y, 0], parent);
}

/** A curved block between angles `range` and outward offsets `grows`, `h` tall, starting at height `y`. */
export function planSector(
  range: readonly [number, number],
  grows: readonly [number, number],
  h: number,
  mat: THREE.Material,
  y: number,
  parent: THREE.Object3D,
): THREE.Mesh {
  const [a0, a1] = range;
  const s = new THREE.Shape();
  loop(a0, a1, grows[1], 0, 40).forEach((p: THREE.Vector3, i: number): void => {
    if (i === 0) s.moveTo(p.x, -p.z);
    else s.lineTo(p.x, -p.z);
  });
  for (const p of loop(a0, a1, grows[0], 0, 40).reverse()) s.lineTo(p.x, -p.z);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: h,
    bevelEnabled: true,
    bevelSize: 0.02,
    bevelThickness: 0.02,
    bevelSegments: 2,
  });
  g.rotateX(-Math.PI / 2);
  return mesh(g, mat, [0, y, 0], parent);
}

/** Low roof dome over the plan. */
export function dome(grow: number, y: number, h: number, mat: THREE.Material, parent: THREE.Object3D): THREE.Mesh {
  const J = 10;
  const n = 128;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= J; j++) {
    const t = j / J;
    const k = Math.cos((t * Math.PI) / 2);
    const yy = Math.sin((t * Math.PI) / 2) * h;
    for (let i = 0; i <= n; i++) {
      const p = plan((i / n) * TAU, grow);
      pos.push(p.x * k, y + yy, p.z * k);
      uv.push((i / n) * 4, t);
      if (j < J && i < n) {
        const A = j * (n + 1) + i;
        const B = A + n + 1;
        idx.push(A, A + 1, B, A + 1, B + 1, B);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return mesh(g, mat, [0, 0, 0], parent);
}

/** A group mounted flush on the wall at angle a, height y, `out` metres proud of it. */
export function onWall(hall: THREE.Object3D, a: number, y: number, out = 0): THREE.Group {
  const g = add(new THREE.Group(), hall);
  g.position.copy(plan(a, out, y));
  g.rotation.y = facing(a);
  return g;
}

/** Where a pipe leaving point p (in a frame where the hall sits at `hall`) meets the hall wall square-on:
    a point `stand` metres off the wall, then the wall face itself (where the flange shows), both at p's height. */
export function wallEntry(p: THREE.Vector3, hall: THREE.Vector3, stand = 0.3): [THREE.Vector3, THREE.Vector3] {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < 720; i++) {
    const a = (i / 720) * TAU;
    const q = plan(a).add(hall);
    const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = a;
    }
  }
  const y = p.y - hall.y;
  return [plan(best, stand, y).add(hall), plan(best, 0.01, y).add(hall)];
}
