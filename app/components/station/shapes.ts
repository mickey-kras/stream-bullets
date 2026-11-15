import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// Shared geometry helpers. Positions: [x,y,z]; sizes follow Three.js geometry tuple order.

export type P = readonly [number, number, number];

export const TAU = Math.PI * 2;
// Deck height above platform origin.
export const DECK_Y = 0.45;

// Reduce segments for thin rails.
export function sides(r: number, most = 12): number {
  return Math.min(most, Math.max(5, Math.round(5 + r * 90)));
}

// Visible round parts: 16 sides for 5cm caps; 48 for 1m tanks.
function roundSides(r: number): number {
  return Math.max(12, Math.round(12 + r * 40));
}

// Curve segments preserve bends without oversampling straight runs.
function runSegments(curve: THREE.Curve<THREE.Vector3>, closed: boolean): number {
  const length = curve.getLength();
  let turn = 0;
  const n = 48;
  let prev = curve.getTangentAt(0);
  for (let i = 1; i <= n; i++) {
    const t = curve.getTangentAt(Math.min(i / n, 1));
    turn += prev.angleTo(t);
    prev = t;
  }
  // At least one segment per 9-degree turn and half-meter run.
  return Math.min(closed ? 160 : 120, Math.max(4, Math.ceil(turn / 0.16), Math.ceil(length * 2)));
}

export function add<O extends THREE.Object3D>(obj: O, parent: THREE.Object3D): O {
  parent.add(obj);
  return obj;
}

export function mesh(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  at: P,
  parent: THREE.Object3D,
  shadow = true,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(at[0], at[1], at[2]);
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

// size = [width, height, depth].
export function box(size: P, at: P, mat: THREE.Material, parent: THREE.Object3D, radius = 0.03): THREE.Mesh {
  const [w, h, d] = size;
  // Use one bevel step for small parts.
  const steps = Math.max(w, h, d) < 0.35 ? 1 : 2;
  return mesh(new RoundedBoxGeometry(w, h, d, steps, Math.min(radius, w / 2, h / 2, d / 2)), mat, at, parent);
}

// dims = [radiusTop, radiusBottom, height]; extra = [segments, openEnded, thetaStart, thetaLength].
export function cyl(
  dims: P,
  at: P,
  mat: THREE.Material,
  parent: THREE.Object3D,
  extra: readonly [number?, boolean?, number?, number?] = [],
): THREE.Mesh {
  const [seg = 48, open = false, start = 0, length = TAU] = extra;
  const around = Math.min(seg, roundSides(Math.max(dims[0], dims[1])) * (length / TAU) + 4);
  return mesh(
    new THREE.CylinderGeometry(dims[0], dims[1], dims[2], Math.round(around), 1, open, start, length),
    mat,
    at,
    parent,
  );
}

export function ball(r: number, at: P, mat: THREE.Material, parent: THREE.Object3D, seg = 24): THREE.Mesh {
  const around = Math.min(seg, Math.max(8, Math.round(8 + r * 44)));
  return mesh(new THREE.SphereGeometry(r, around, Math.max(6, Math.round(around * 0.66))), mat, at, parent);
}

// ring = [radius, tube]; flat rings are horizontal.
export function torus(
  ring: readonly [number, number],
  at: P,
  mat: THREE.Material,
  parent: THREE.Object3D,
  flat = true,
): THREE.Mesh {
  const [r, tubeRadius] = ring;
  const around = Math.min(72, Math.max(24, Math.round(r * 30)));
  const m = mesh(new THREE.TorusGeometry(r, tubeRadius, sides(tubeRadius, 10), around), mat, at, parent);
  if (flat) m.rotation.x = Math.PI / 2;
  return m;
}

export function rod(
  a: THREE.Vector3,
  b: THREE.Vector3,
  r: number,
  mat: THREE.Material,
  parent: THREE.Object3D,
  seg = 10,
): THREE.Mesh {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const m = mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), seg), mat, [mid.x, mid.y, mid.z], parent);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

export function tube(
  points: THREE.Vector3[],
  r: number,
  mat: THREE.Material,
  parent: THREE.Object3D,
  closed = false,
  tension = 0.5,
): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points, closed, "catmullrom", tension);
  return mesh(new THREE.TubeGeometry(curve, runSegments(curve, closed), r, sides(r), closed), mat, [0, 0, 0], parent);
}

// Rounded-elbow pipe with end flanges.
export function pipe(
  points: THREE.Vector3[],
  r: number,
  mats: readonly [THREE.Material, THREE.Material],
  parent: THREE.Object3D,
): THREE.Mesh {
  const [mat, flangeMat] = mats;
  const path = new THREE.CurvePath<THREE.Vector3>();
  const bend = r * 3;
  let from = points[0].clone();
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const a = points[i - 1];
    const b = points[i + 1];
    const inPoint = p.clone().add(
      a
        .clone()
        .sub(p)
        .normalize()
        .multiplyScalar(Math.min(bend, a.distanceTo(p) / 2)),
    );
    const outPoint = p.clone().add(
      b
        .clone()
        .sub(p)
        .normalize()
        .multiplyScalar(Math.min(bend, b.distanceTo(p) / 2)),
    );
    path.add(new THREE.LineCurve3(from, inPoint));
    path.add(new THREE.QuadraticBezierCurve3(inPoint, p.clone(), outPoint));
    from = outPoint;
  }
  const [previous, last] = points.slice(-2);
  path.add(new THREE.LineCurve3(from, last.clone()));
  const m = mesh(
    new THREE.TubeGeometry(path, runSegments(path, false), r, sides(r, 14), false),
    mat,
    [0, 0, 0],
    parent,
  );
  for (const p of [points[0], last]) {
    const dir = p === points[0] ? points[1].clone().sub(p) : p.clone().sub(previous);
    const flange = mesh(
      new THREE.CylinderGeometry(r * 1.6, r * 1.6, r * 0.8, sides(r * 1.6, 16)),
      flangeMat,
      [p.x, p.y, p.z],
      parent,
    );
    flange.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  }
  return m;
}

// Horizontal circle points; angles run +z to +x.
export function arc(r: number, a0: number, a1: number, y: number, n = 48): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push(new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r));
  }
  return pts;
}

export function polar(r: number, a: number): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r);
}

export function rounded(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const l = -w / 2;
  const b = -h / 2;
  s.moveTo(l + r, b);
  s.lineTo(l + w - r, b);
  s.quadraticCurveTo(l + w, b, l + w, b + r);
  s.lineTo(l + w, b + h - r);
  s.quadraticCurveTo(l + w, b + h, l + w - r, b + h);
  s.lineTo(l + r, b + h);
  s.quadraticCurveTo(l, b + h, l, b + h - r);
  s.lineTo(l, b + r);
  s.quadraticCurveTo(l, b, l + r, b);
  return s;
}

export function archShape(w: number, h: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, h - w / 2);
  s.absarc(0, h - w / 2, w / 2, 0, Math.PI, false);
  s.lineTo(-w / 2, 0);
  return s;
}

export function extrude(
  shape: THREE.Shape,
  depth: number,
  mat: THREE.Material,
  at: P,
  parent: THREE.Object3D,
  bevel = 0.02,
): THREE.Mesh {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 2,
    curveSegments: 6,
  });
  return mesh(geometry, mat, at, parent);
}

// size = [width, height, depth, cornerRadius].
export function plaque(
  size: readonly [number, number, number, number],
  at: P,
  mat: THREE.Material,
  parent: THREE.Object3D,
): THREE.Mesh {
  const [w, h, d, r] = size;
  return extrude(rounded(w, h, r), d, mat, at, parent, 0.015);
}

// size = [width, height, cornerRadius, border, depth].
export function frame(
  size: readonly [number, number, number, number, number],
  at: P,
  mat: THREE.Material,
  parent: THREE.Object3D,
): THREE.Mesh {
  const [w, h, r, border, d] = size;
  const s = rounded(w, h, r);
  s.holes.push(rounded(w - border * 2, h - border * 2, Math.max(0.02, r - border)));
  return extrude(s, d, mat, at, parent, 0.015);
}

// Centered slab; size = [width, depth, height, cornerRadius].
export function slab(
  size: readonly [number, number, number, number],
  at: P,
  mat: THREE.Material,
  parent: THREE.Object3D,
): THREE.Mesh {
  const [w, d, h, r] = size;
  const g = new THREE.ExtrudeGeometry(rounded(w, d, r), {
    depth: h,
    bevelEnabled: true,
    bevelSize: 0.025,
    bevelThickness: 0.025,
    bevelSegments: 2,
    curveSegments: 8,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -h / 2, 0);
  return mesh(g, mat, at, parent);
}

export function lathe(
  profile: Array<[number, number]>,
  mat: THREE.Material,
  at: P,
  parent: THREE.Object3D,
  seg = 40,
): THREE.Mesh {
  const points = profile.map(([r, h]: [number, number]): THREE.Vector2 => new THREE.Vector2(r, h));
  const widest = Math.max(...profile.map(([r]: [number, number]): number => r));
  return mesh(new THREE.LatheGeometry(points, Math.min(seg, roundSides(widest))), mat, at, parent);
}

export function rivets(
  points: THREE.Vector3[],
  r: number,
  mat: THREE.Material,
  parent: THREE.Object3D,
): THREE.InstancedMesh {
  const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 5, 3), mat, points.length);
  const m = new THREE.Matrix4();
  points.forEach((p: THREE.Vector3, i: number): void => {
    m.makeScale(r, r, r).setPosition(p);
    inst.setMatrixAt(i, m);
  });
  inst.castShadow = false;
  inst.receiveShadow = true;
  parent.add(inst);
  return inst;
}

export function ringPoints(r: number, y: number, count: number, a0 = 0, a1 = TAU): THREE.Vector3[] {
  const full = Math.abs(a1 - a0 - TAU) < 1e-6;
  return Array.from({ length: count }, (_: unknown, i: number): THREE.Vector3 => {
    const a = a0 + ((a1 - a0) * i) / (full ? count : count - 1);
    return new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r);
  });
}

// Curved tapered leaf; shape = [length, width, lift].
export function frond(
  base: P,
  angle: number,
  shape: readonly [number, number, number],
  mat: THREE.Material,
  parent: THREE.Object3D,
): void {
  const [px, py, pz] = base;
  const [length, width, lift] = shape;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= 10; j++) {
    const t = j / 10;
    const d = t * length;
    const hgt = py + Math.sin(t * Math.PI * 0.85) * length * lift;
    const hw = Math.sin(t * Math.PI) * width;
    for (const side of [-1, 1]) {
      pos.push(
        px + Math.sin(angle) * d + Math.cos(angle) * hw * side,
        hgt - hw * 0.3,
        pz + Math.cos(angle) * d - Math.sin(angle) * hw * side,
      );
    }
    if (j < 10) idx.push(j * 2, j * 2 + 1, j * 2 + 2, j * 2 + 1, j * 2 + 3, j * 2 + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  mesh(g, mat, [0, 0, 0], parent, false);
}

// Flat radius/height pairs: profile(r0, h0, r1, h1, ...).
export function profile(...pairs: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) out.push([pairs[i], pairs[i + 1]]);
  return out;
}
