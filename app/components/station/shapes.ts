import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

/* Geometry helpers shared by every part of the station. Positions are passed as [x, y, z] tuples and
   sizes as tuples in the order the underlying Three.js geometry expects them. */

export type P = readonly [number, number, number];

export const TAU = Math.PI * 2;
/** Height of the deck plate above the platform origin. */
export const DECK_Y = 0.45;

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

/** Rounded box: size is [width, height, depth]. */
export function box(size: P, at: P, mat: THREE.Material, parent: THREE.Object3D, radius = 0.03): THREE.Mesh {
  const [w, h, d] = size;
  return mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 2, h / 2, d / 2)), mat, at, parent);
}

/** Cylinder: dims is [radiusTop, radiusBottom, height]; extra is [segments, openEnded, thetaStart, thetaLength]. */
export function cyl(
  dims: P,
  at: P,
  mat: THREE.Material,
  parent: THREE.Object3D,
  extra: readonly [number?, boolean?, number?, number?] = [],
): THREE.Mesh {
  const [seg = 48, open = false, start = 0, length = TAU] = extra;
  return mesh(new THREE.CylinderGeometry(dims[0], dims[1], dims[2], seg, 1, open, start, length), mat, at, parent);
}

export function ball(r: number, at: P, mat: THREE.Material, parent: THREE.Object3D, seg = 24): THREE.Mesh {
  return mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg * 0.66)), mat, at, parent);
}

/** Torus: ring is [radius, tube]; flat rings lie in the horizontal plane. */
export function torus(
  ring: readonly [number, number],
  at: P,
  mat: THREE.Material,
  parent: THREE.Object3D,
  flat = true,
): THREE.Mesh {
  const [r, tubeRadius] = ring;
  const m = mesh(new THREE.TorusGeometry(r, tubeRadius, 12, Math.max(24, Math.round(r * 60))), mat, at, parent);
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
  return mesh(new THREE.TubeGeometry(curve, Math.max(24, points.length * 12), r, 12, closed), mat, [0, 0, 0], parent);
}

/** Pipe through waypoints with tight, rounded elbows and a flange at each end. */
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
  const m = mesh(new THREE.TubeGeometry(path, points.length * 24, r, 14, false), mat, [0, 0, 0], parent);
  for (const p of [points[0], last]) {
    const dir = p === points[0] ? points[1].clone().sub(p) : p.clone().sub(previous);
    const flange = mesh(new THREE.CylinderGeometry(r * 1.6, r * 1.6, r * 0.8, 16), flangeMat, [p.x, p.y, p.z], parent);
    flange.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  }
  return m;
}

/** Points on a horizontal circle of radius r from angle a0 to a1 (angles from +z toward +x). */
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
    bevelSegments: 3,
    curveSegments: 32,
  });
  return mesh(geometry, mat, at, parent);
}

/** Rounded plate: size is [width, height, depth, cornerRadius]. */
export function plaque(
  size: readonly [number, number, number, number],
  at: P,
  mat: THREE.Material,
  parent: THREE.Object3D,
): THREE.Mesh {
  const [w, h, d, r] = size;
  return extrude(rounded(w, h, r), d, mat, at, parent, 0.015);
}

/** Rounded picture frame: size is [width, height, cornerRadius, border, depth]. */
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

/** Horizontal slab with rounded corners centred on `at`: size is [width, depth, height, cornerRadius]. */
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
    curveSegments: 20,
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
  return mesh(new THREE.LatheGeometry(points, seg), mat, at, parent);
}

export function rivets(
  points: THREE.Vector3[],
  r: number,
  mat: THREE.Material,
  parent: THREE.Object3D,
): THREE.InstancedMesh {
  const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), mat, points.length);
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

/** One leaf: a tapered ribbon from `base`, curving up. shape is [length, width, lift]. */
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

/** Lathe profile from flat [radius, height] pairs: profile(r0, h0, r1, h1, ...). */
export function profile(...pairs: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) out.push([pairs[i], pairs[i + 1]]);
  return out;
}
