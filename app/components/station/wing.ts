import * as THREE from "three";
import * as M from "./materials";
import type { Kit } from "./kit";
import {
  add,
  mesh,
  box,
  cyl,
  ball,
  torus,
  rod,
  tube,
  pipe,
  archShape,
  extrude,
  slab,
  rivets,
  TAU,
  DECK_Y,
} from "./shapes";
import { enamel } from "./palette";
import { wallEntry, HALL_AT } from "./plan";
import { GREY_TANK } from "./works";

interface WingScope {
  wing: THREE.Group;
  station: THREE.Group;
  creamShade: THREE.MeshStandardMaterial;
  stepSteel: THREE.MeshStandardMaterial;
}

function wingCanopy(k: Kit, s: Pick<WingScope, "wing">): void {
  const { gold, cream } = k;
  const { wing } = s;
  // Half-round canopy: straight against the wall, an elliptical sweep out front.
  const shape = new THREE.Shape();
  const rx = 1.08,
    rz = 1;
  shape.moveTo(-rx, 0);
  for (let k = 0; k <= 48; k++) {
    const t = Math.PI - (k / 48) * Math.PI;
    shape.lineTo(Math.cos(t) * rx, -Math.sin(t) * rz);
  }
  shape.lineTo(-rx, 0);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: 0.22,
    bevelEnabled: true,
    bevelSize: 0.03,
    bevelThickness: 0.03,
    bevelSegments: 3,
    curveSegments: 48,
  });
  g.rotateX(-Math.PI / 2);
  mesh(g, cream, [0.05, 2.32, 0.55], wing);
  const rim: THREE.Vector3[] = [];
  for (let k = 0; k <= 48; k++) {
    const t = Math.PI - (k / 48) * Math.PI;
    rim.push(new THREE.Vector3(0.05 + Math.cos(t) * (rx + 0.03), 2.31, 0.55 + Math.sin(t) * (rz + 0.03)));
  }
  tube(rim, 0.022, gold, wing);
}

function wingCanopyLight(k: Kit, s: Pick<WingScope, "wing">): void {
  const { gold, warm, halo, practical } = k;
  const { wing } = s;
  const dome = ball(0.13, [-0.08, 2.3, 1.02], warm, wing, 24);
  dome.scale.y = 0.45;
  torus([0.14, 0.018], [-0.08, 2.31, 1.02], gold, wing);
  halo([-0.08, 2.2, 1.05], 0.6, "#ffc87a", 0.15, wing);
  practical("#ffc478", [2.8, 3], [-0.08, 2, 1.4], wing);
}

function wingDoor(k: Kit, s: Pick<WingScope, "wing">): void {
  const { tiles, brassWear, gold, warm, halo } = k;
  const { wing } = s;
  const door = add(new THREE.Group(), wing);
  door.position.set(-0.08, 0.5, 0.7);
  const doorBrass = M.wear(
    new THREE.MeshStandardMaterial({
      color: "#ffe2a6",
      metalness: 1,
      roughness: 0.6,
    }),
    {
      ...brassWear,
      edges: 0.5,
      tile: tiles.brass,
      scale: 1.6,
      detail: 0.4,
    },
  );
  const head = new THREE.Shape();
  head.moveTo(-0.36, 0);
  head.lineTo(0.36, 0);
  head.lineTo(0.36, 1.45);
  head.quadraticCurveTo(0.36, 1.66, 0.15, 1.66);
  head.lineTo(-0.15, 1.66);
  head.quadraticCurveTo(-0.36, 1.66, -0.36, 1.45);
  head.lineTo(-0.36, 0);
  extrude(head, 0.05, doorBrass, [0, 0, 0], door, 0.012);
  const outer = new THREE.Shape();
  outer.moveTo(-0.44, 0);
  outer.lineTo(0.44, 0);
  outer.lineTo(0.44, 1.5);
  outer.quadraticCurveTo(0.44, 1.76, 0.18, 1.76);
  outer.lineTo(-0.18, 1.76);
  outer.quadraticCurveTo(-0.44, 1.76, -0.44, 1.5);
  outer.lineTo(-0.44, 0);
  outer.holes.push(head);
  extrude(outer, 0.08, gold, [0, 0, -0.01], door, 0.015);
  const oval = new THREE.Shape();
  oval.absellipse(0, 0, 0.085, 0.25, 0, TAU, false, 0);
  mesh(new THREE.ShapeGeometry(oval, 24), warm, [0, 1.1, 0.066], door, false);
  tube(
    new THREE.EllipseCurve(0, 0, 0.1, 0.265)
      .getPoints(32)
      .map((p: THREE.Vector2): THREE.Vector3 => new THREE.Vector3(p.x, p.y + 1.1, 0.07)),
    0.016,
    gold,
    door,
    true,
  );
  tube(
    [
      new THREE.Vector3(-0.27, 0.72, 0.07),
      new THREE.Vector3(-0.27, 0.75, 0.12),
      new THREE.Vector3(-0.27, 0.97, 0.12),
      new THREE.Vector3(-0.27, 1, 0.07),
    ],
    0.014,
    gold,
    door,
  );
  box([0.05, 0.1, 0.02], [0.27, 0.86, 0.066], gold, door, 0.01);
  halo([0, 1.1, 0.2], 0.5, "#ffbf70", 0.1, door);
}

function wingPlanterSoil(_k: Kit, s: Pick<WingScope, "wing">): void {
  const { wing } = s;
  const top = mesh(
    new THREE.CircleGeometry(0.27, 24),
    new THREE.MeshStandardMaterial({ color: "#2b1d12", roughness: 1 }),
    [-0.98, 0.535, 1.42],
    wing,
    false,
  );
  top.rotation.x = -Math.PI / 2;
}

function wingSideWall(k: Kit, s: Pick<WingScope, "wing" | "station">): void {
  const { brass, copper, iron } = k;
  const { wing, station } = s;
  const vent = add(new THREE.Group(), wing);
  // Sits in the gap between the two risers.
  vent.position.set(0.96, 1.75, -0.675);
  vent.rotation.y = Math.PI / 2;
  box([0.34, 0.42, 0.05], [0, 0, 0], iron, vent, 0.02);
  for (let i = 0; i < 6; i++)
    box([0.28, 0.025, 0.06], [0, -0.15 + i * 0.06, 0.03], brass, vent, 0.006).rotation.x = -0.5;
  const w = (x: number, y: number, z: number): THREE.Vector3 =>
    new THREE.Vector3(x, y - DECK_Y, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), wing.rotation.y).add(wing.position);
  // The tall riser climbs the side wall, then turns and runs square into the hall.
  const riser = w(1.02, 3, -0.4);
  pipe([w(1.02, 0.3, -0.4), riser, ...wallEntry(riser, HALL_AT)], 0.055, [brass, brass], station);
  // The grey receiver's outlet rises off its dome, crosses to the wall and drops down it into the deck.
  const outlet = GREY_TANK.clone().setY(DECK_Y + 1.6);
  const head = w(1.02, 2.6, -0.95);
  pipe([outlet, outlet.clone().setY(head.y), head, w(1.02, 0.3, -0.95)], 0.05, [copper, brass], station);
  for (const y of [1, 2]) box([0.1, 0.05, 0.12], [1, y, -0.4], iron, wing, 0.01);
}

function wingSteps(k: Kit, { wing, stepSteel }: Pick<WingScope, "wing" | "stepSteel">): void {
  const { gold } = k;
  // Three curved steel steps with brass nosing.
  for (let i = 0; i < 3; i++) {
    const r = 1.08 - i * 0.22;
    const s = new THREE.Shape();
    for (let k = 0; k <= 40; k++) {
      const t = Math.PI - (k / 40) * Math.PI;
      const px = Math.cos(t) * r,
        pz = Math.sin(t) * r * 0.85;
      if (k === 0) s.moveTo(px, -pz);
      else s.lineTo(px, -pz);
    }
    s.lineTo(-r, 0);
    const g = new THREE.ExtrudeGeometry(s, {
      depth: 0.14,
      bevelEnabled: true,
      bevelSize: 0.012,
      bevelThickness: 0.012,
      bevelSegments: 2,
      curveSegments: 40,
    });
    g.rotateX(-Math.PI / 2);
    mesh(g, stepSteel, [-0.08, 0.08 + i * 0.14, 0.7], wing);
    const nose: THREE.Vector3[] = [];
    for (let k = 0; k <= 40; k++) {
      const t = Math.PI - (k / 40) * Math.PI;
      nose.push(new THREE.Vector3(-0.08 + Math.cos(t) * r, 0.08 + (i + 1) * 0.14, 0.7 + Math.sin(t) * r * 0.85));
    }
    tube(nose, 0.018, gold, wing);
  }
}

/** Where the porch stands and how it is turned; the studio uses these to line its inner door up. */
export const WING_AT = new THREE.Vector3(2.35, DECK_Y, 0.3);
export const WING_YAW = Math.PI / 4;
/** The porch block's side face (local x) that juts into the studio, facing the glazing. */
export const WING_SIDE_X = -0.95;

export function buildWing(k: Kit, station: THREE.Group): THREE.Group {
  const { tiles, ivoryWear, brass, gold, teal, tealDark, cream, plant } = k;
  // Teal block with a round tower beside the door, a finned pylon, a cream cantilevered canopy on a
  // grooved pillar, a brass door, three curved steel steps with brass nosing and brass handrails.
  const wing = add(new THREE.Group(), station);
  // The porch is tucked against the end of the hall, opening toward the front-right corner.
  wing.position.copy(WING_AT);
  wing.rotation.y = WING_YAW;
  const creamShade = enamel(tiles.ivory, null, "#b9a888", ivoryWear);
  const stepSteel = M.wear(
    new THREE.MeshStandardMaterial({
      color: "#c4c2bb",
      metalness: 0.7,
      roughness: 0.4,
    }),
    {
      exposed: "#f4ecda",
      edges: 0.45,
      grime: 0.3,
      streaks: 0,
      exposedMetal: 1,
      exposedRough: 0.2,
    },
  );
  slab([2.25, 2.8, 0.08, 0.6], [-0.05, 0.04, 0.28], brass, wing);
  rivets(
    Array.from(
      { length: 15 },
      (_: unknown, i: number): THREE.Vector3 => new THREE.Vector3(-1 + i * 0.135, 0.045, 1.705),
    ),
    0.022,
    gold,
    wing,
  );
  slab([1.9, 1.9, 2.75, 0.35], [0, 0.08 + 1.375, -0.25], teal, wing);
  slab([1.5, 1.4, 0.32, 0.5], [0.1, 2.99, -0.35], teal, wing);
  slab([1, 0.9, 0.3, 0.4], [0.2, 3.3, -0.45], tealDark, wing);
  // Round tower to the right of the door, with a stepped cap.
  cyl([0.5, 0.5, 3.15], [0.8, 0.08 + 1.575, 0.48], teal, wing, [48]);
  cyl([0.4, 0.4, 0.38], [0.8, 3.42, 0.42], teal, wing, [40]);
  torus([0.505, 0.025], [0.8, 3.23, 0.48], gold, wing);
  torus([0.505, 0.022], [0.8, 0.14, 0.48], gold, wing);
  // Finned pylon on the left, rising through the canopy.
  extrude(archShape(0.52, 4.15), 0.42, teal, [-0.8, 0.08, 0.62], wing, 0.03);
  for (const x of [-0.95, -0.8, -0.65]) box([0.055, 1.78, 0.06], [x, 3.2, 1.08], gold, wing, 0.02);
  // Grooved cream pillar carrying the canopy.
  box([0.38, 2.25, 0.55], [-0.72, 0.08 + 1.125, 1], cream, wing, 0.05);
  for (const x of [-0.8, -0.64]) box([0.05, 1.05, 0.02], [x, 0.95, 1.28], creamShade, wing, 0.02);
  // Cantilevered half-round canopy with a dome light beneath.
  wingCanopy(k, { wing });
  wingCanopyLight(k, { wing });
  // Brass door with rounded head, oval light and pull.
  wingDoor(k, { wing });
  wingSteps(k, { wing, stepSteel });
  for (const side of [-1, 1]) {
    const x0 = -0.08 + side * 0.9,
      x1 = -0.08 + side * 0.5;
    const posts: Array<[number, number, number]> = [
      [x0, 0.08, 1.28],
      [-0.08 + side * 0.72, 0.36, 1],
      [x1, 0.5, 0.78],
    ];
    for (const [px, py, pz] of posts)
      rod(new THREE.Vector3(px, py, pz), new THREE.Vector3(px, py + 0.85, pz), 0.02, gold, wing, 10);
    tube(
      posts
        .map(([px, py, pz]: [number, number, number]): THREE.Vector3 => new THREE.Vector3(px, py + 0.85, pz))
        .concat([new THREE.Vector3(x1, 1.35, 0.7)]),
      0.024,
      gold,
      wing,
    );
    tube(
      posts.map(([px, py, pz]: [number, number, number]): THREE.Vector3 => new THREE.Vector3(px, py + 0.5, pz)),
      0.016,
      gold,
      wing,
    );
    for (const [px, py, pz] of posts) ball(0.032, [px, py + 0.87, pz], gold, wing, 12);
  }
  // Cream planter beside the steps.
  cyl([0.3, 0.27, 0.46], [-0.98, 0.08 + 0.23, 1.42], cream, wing, [32]);
  wingPlanterSoil(k, { wing });
  plant([-0.98, 0.53, 1.42], 12, 0.5, wing, 77);
  // Side wall: louvred vent and brass pipes climbing to the pressure dome on the roof.
  wingSideWall(k, { wing, station });
  return wing;
}
