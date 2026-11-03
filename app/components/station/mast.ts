import * as THREE from "three";
import * as M from "./materials";
import * as T from "./textures";
import type { Kit } from "./kit";
import { add, mesh, box, ball, torus, rod, tube, lathe, rivets, TAU, profile } from "./shapes";

/** Half-width of the tower at height y: splayed feet, tapering to the spire. */
const half = (y: number): number => 0.06 + 0.6 * Math.pow(1 - Math.min(y, 2.95) / 3, 1.45);
const corner = (i: number, y: number): THREE.Vector3 => {
  const a = (i / 4) * TAU + Math.PI / 4,
    r = half(y) * Math.SQRT2;
  return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
};
/** Radius of the brass ring around the tower at height y; the sign arms leave from it. */
export const ringRadius = (y: number): number => half(y) * Math.SQRT2 + 0.1;

function buildTower(k: Kit, mast: THREE.Group): void {
  const { brass, gold, beacon } = k;
  const legSteel = M.wear(
    new THREE.MeshStandardMaterial({
      color: "#cfcbc0",
      metalness: 0.85,
      roughness: 0.42,
    }),
    {
      exposed: "#7a4a24",
      edges: 0.35,
      grime: 0,
      streaks: 0,
      exposedMetal: 0.3,
      exposedRough: 0.85,
    },
  );
  const levels = [0, 0.5, 0.95, 1.35, 1.7, 2.02, 2.3, 2.55, 2.78];
  for (let i = 0; i < 4; i++) {
    tube(
      Array.from({ length: 12 }, (_: unknown, k: number): THREE.Vector3 => corner(i, (k / 11) * 2.92)),
      0.038,
      legSteel,
      mast,
      false,
      0.5,
    );
    const foot = corner(i, 0);
    box([0.22, 0.04, 0.22], [foot.x * 1.05, 0.02, foot.z * 1.05], brass, mast, 0.01);
    rivets(
      [
        [-0.07, -0.07],
        [0.07, -0.07],
        [-0.07, 0.07],
        [0.07, 0.07],
      ].map(([dx, dz]: number[]): THREE.Vector3 => new THREE.Vector3(foot.x * 1.05 + dx, 0.045, foot.z * 1.05 + dz)),
      0.015,
      gold,
      mast,
    );
  }
  for (let k = 0; k < levels.length - 1; k++) {
    const ya = levels[k],
      yb = levels[k + 1];
    for (let i = 0; i < 4; i++) {
      rod(corner(i, ya), corner((i + 1) % 4, yb), 0.011, gold, mast, 5);
      rod(corner((i + 1) % 4, ya), corner(i, yb), 0.011, gold, mast, 5);
      if (k > 0) rod(corner(i, ya), corner((i + 1) % 4, ya), 0.014, gold, mast, 5);
    }
  }
  const ringHeights = [1.25, 1.75, 2.2];
  for (const y of ringHeights) {
    torus([ringRadius(y), 0.034], [0, y, 0], gold, mast);
    for (let i = 0; i < 4; i++) rod(corner(i, y), corner(i, y).setLength(ringRadius(y)).setY(y), 0.012, brass, mast, 5);
  }
  for (const y of [1, 1.95])
    for (const i of [0, 2]) {
      const p = corner(i, y);
      ball(0.03, [p.x * 1.12, y, p.z * 1.12], beacon, mast, 10);
    }
  lathe(profile(0, 0, 0.07, 0, 0.05, 0.1, 0.025, 0.35, 0.015, 0.42, 0, 0.42), gold, [0, 2.86, 0], mast, 20);
}

/** Brass orb, the three glowing signal rings that lean toward the viewer, and arcs. */
function buildSignal(k: Kit, mast: THREE.Group, mastTop: number): THREE.Group {
  const { tiles, animators, onLights, halo, practical } = k;
  const orbMaterial = new THREE.MeshStandardMaterial({
    map: tiles.brass.map,
    color: "#ffe3a8",
    metalness: 1,
    roughness: 0.3,
    emissive: "#ffb050",
    emissiveIntensity: 0.35,
  });
  ball(0.16, [0, mastTop + 0.45, 0], orbMaterial, mast, 32);
  halo([0, mastTop + 0.45, 0], 1, "#ffd08a", 0.35, mast);
  const orbLight = practical("#ffcf86", [5, 6], [0, mastTop + 0.45, 0], mast);
  // The ring set leans toward whoever is looking, so it always reads as open ellipses.
  const tilt = add(new THREE.Group(), mast);
  tilt.position.set(0, mastTop + 0.45, 0);
  tilt.rotation.order = "YXZ";
  // Three rings that pulse outward in turn, swelling and flaring like a broadcast going out.
  const lit = new THREE.Color("#ffc865");
  const dim = new THREE.Color("#6d5a35");
  const signalRings: Array<[THREE.Mesh, THREE.MeshBasicMaterial]> = [];
  for (let i = 0; i < 3; i++) {
    const glow = new THREE.MeshBasicMaterial({ color: lit.clone().multiplyScalar(2.2), fog: false });
    const ring = torus([0.7 + i * 0.62, 0.02], [0, 0, 0], glow, tilt);
    ring.castShadow = false;
    signalRings.push([ring, glow]);
  }
  animators.push((t: number): void =>
    signalRings.forEach(([ring, glow]: [THREE.Mesh, THREE.MeshBasicMaterial], i: number): void => {
      const pulse = Math.pow(0.5 + 0.5 * Math.sin(t * 3 - i * 1.15), 3);
      ring.scale.setScalar(1 + pulse * 0.2);
      ring.position.y = Math.sin(t * 1.1 + i) * 0.03;
      if (k.illuminated) glow.color.copy(lit).multiplyScalar(1.3 + pulse * 2.6);
      else glow.color.copy(dim);
    }),
  );
  // Electric arcs flicking off the orb.
  const arcGeometry = new THREE.BufferGeometry();
  const arcPositions = new Float32Array(3 * 2 * 3 * 8);
  arcGeometry.setAttribute("position", new THREE.BufferAttribute(arcPositions, 3));
  const arcs = new THREE.LineSegments(
    arcGeometry,
    new THREE.LineBasicMaterial({
      color: new THREE.Color("#ffe6b0").multiplyScalar(4),
      transparent: true,
      opacity: 0.9,
      fog: false,
    }),
  );
  arcs.position.set(0, mastTop + 0.45, 0);
  mast.add(arcs);
  const arcRandom = T.random(99);
  let arcTimer = 0;
  animators.push((t: number, dt: number): void => {
    const flicker = 0.85 + Math.sin(t * 13) * 0.08 + Math.sin(t * 31) * 0.07;
    orbMaterial.emissiveIntensity = k.illuminated ? 0.35 * flicker : 0;
    orbLight.intensity = k.illuminated ? 5 * flicker : 0;
    arcTimer -= dt;
    if (arcTimer <= 0) {
      arcTimer = 0.05 + arcRandom() * 0.12;
      let slot = 0;
      const show = arcRandom() > 0.35 && k.illuminated;
      for (let s = 0; s < 3; s++) {
        const dir = new THREE.Vector3(arcRandom() - 0.5, arcRandom() * 0.8 - 0.2, arcRandom() - 0.5).normalize();
        let prev = dir.clone().multiplyScalar(0.2);
        for (let j = 1; j <= 3; j++) {
          const next = dir
            .clone()
            .multiplyScalar(0.2 + j * 0.16)
            .add(new THREE.Vector3(arcRandom() - 0.5, arcRandom() - 0.5, arcRandom() - 0.5).multiplyScalar(0.12));
          arcPositions.set([prev.x, prev.y, prev.z, next.x, next.y, next.z], slot);
          slot += 6;
          prev = next;
        }
      }
      arcGeometry.attributes.position!.needsUpdate = true;
      arcs.visible = show;
    }
  });
  onLights.push((on: boolean): void => {
    for (const [, glow] of signalRings) glow.color.copy(on ? lit : dim).multiplyScalar(on ? 2.2 : 1);
    arcs.visible = false;
  });
  return tilt;
}

export function buildMast(k: Kit, hall: THREE.Group): THREE.Group {
  // Four splayed steel legs on bolted brass feet, brass X-bracing, three brass rings that carry the
  // sign arms, and a spire capped with a brass ball inside the signal rings.
  const mast = add(new THREE.Group(), hall);
  mast.position.set(0, 3.98, 0);
  mast.scale.setScalar(1.12);
  const mastTop = 3;
  buildTower(k, mast);
  return buildSignal(k, mast, mastTop);
}
