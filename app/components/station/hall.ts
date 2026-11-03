import * as THREE from "three";
import * as T from "./textures";
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
  rounded,
  plaque,
  frame,
  rivets,
  ringPoints,
  TAU,
  DECK_Y,
} from "./shapes";
import { plan, facing, loop, band, capSlab, dome, onWall, GLASS_FROM, GLASS_TO } from "./plan";

interface HallScope {
  hall: THREE.Group;
  onAir: THREE.Group;
}

function hallRoofTanks(k: Kit, s: Pick<HallScope, "hall">): void {
  const { brass, gold, iron, tealDark, cream, red } = k;
  const { hall } = s;
  const g = add(new THREE.Group(), hall);
  g.position.set(1.35, 3.72, -1.05);
  cyl([0.55, 0.6, 0.2], [0, 0.1, 0], iron, g, [32]);
  cyl([0.52, 0.52, 0.5], [0, 0.45, 0], cream, g, [40]);
  ball(0.52, [0, 0.7, 0], cream, g, 40).scale.y = 0.8;
  for (const y of [0.42, 0.58]) torus([0.53, 0.03], [0, y, 0], red, g);
  rivets(ringPoints(0.53, 0.25, 30), 0.016, brass, g);
  ball(0.06, [0, 1.13, 0], gold, g, 12);
  const service = ball(0.6, [-1.1, 3.78, -1.2], tealDark, hall, 40);
  service.scale.y = 0.6;
  torus([0.6, 0.03], [-1.1, 3.78, -1.2], gold, hall);
}

function hallServiceDoor(k: Kit, s: Pick<HallScope, "hall">): void {
  const { brass, gold, iron, steel } = k;
  const { hall } = s;
  const g = onWall(hall, 3.1, 0.62, 0.02);
  plaque([0.82, 1.62, 0.06, 0.1], [0, 0.81, 0], steel, g);
  frame([0.92, 1.72, 0.12, 0.06, 0.06], [0, 0.81, 0.02], brass, g);
  rivets(
    [-0.33, 0.33].flatMap((x: number): THREE.Vector3[] =>
      [0.2, 0.6, 1.0, 1.4].map((y: number): THREE.Vector3 => new THREE.Vector3(x, y, 0.07)),
    ),
    0.02,
    gold,
    g,
  );
  box([0.06, 0.26, 0.06], [0.3, 0.85, 0.1], iron, g, 0.01);
  box([0.5, 0.04, 0.05], [0, 1.15, 0.08], iron, g, 0.01);
}

function hallFuseBox(k: Kit, s: Pick<HallScope, "hall">): void {
  const { copper, iron, steel, beacon } = k;
  const { hall } = s;
  const g = onWall(hall, 3.45, 1.45, 0.04);
  box([0.5, 0.62, 0.18], [0, 0, 0], steel, g, 0.03);
  mesh(
    new THREE.PlaneGeometry(0.28, 0.09),
    new THREE.MeshStandardMaterial({ map: T.hazard(), roughness: 0.6 }),
    [0, 0.18, 0.095],
    g,
    false,
  );
  ball(0.03, [-0.15, -0.18, 0.1], beacon, g, 10);
  for (const x of [-0.12, 0, 0.12])
    rod(new THREE.Vector3(x, -0.31, 0.05), new THREE.Vector3(x, -0.85, 0.05), 0.022, iron, g, 8);
  for (const x of [-0.12, 0.12])
    rod(new THREE.Vector3(x, 0.31, 0.05), new THREE.Vector3(x, 1.0, 0.05), 0.022, copper, g, 8);
}

function hallOnAirSign(k: Kit, s: Pick<HallScope, "onAir">): void {
  const { gold, iron, warm, neon, signRed, halo, practical, label } = k;
  const { onAir } = s;
  const a = -0.14;
  onAir.position.copy(plan(a, 0.36, 3.0));
  onAir.rotation.y = facing(a);
  plaque([2.55, 0.98, 0.1, 0.22], [0, 0, -0.12], iron, onAir);
  frame([2.55, 0.98, 0.22, 0.13, 0.2], [0, 0, -0.06], gold, onAir);
  plaque([2.32, 0.76, 0.02, 0.14], [0, 0, -0.04], signRed, onAir);
  const outline = rounded(2.12, 0.6, 0.1)
    .getPoints(24)
    .map((p: THREE.Vector2): THREE.Vector3 => new THREE.Vector3(p.x, p.y, 0.03));
  tube(outline, 0.016, neon, onAir, true, 0.2).castShadow = false;
  label(
    (ctx: CanvasRenderingContext2D, w: number, h: number): void => {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `800 ${Math.round(h * 0.9)}px ${k.family}`;
      ctx.fillStyle = "#ffe9c4";
      ctx.fillText("ON AIR", w / 2, h * 0.54, w * 0.9);
    },
    [1.9, 0.52],
    [0, 0, 0.05],
    onAir,
    0.4,
  );
  for (let i = 0; i < 18; i++) {
    const p = rounded(2.42, 0.86, 0.18).getPointAt(i / 18);
    ball(0.028, [p.x, p.y, 0.15], warm, onAir, 10);
  }
  for (const x of [-0.9, 0.9]) box([0.08, 0.3, 0.3], [x, -0.45, -0.2], iron, onAir, 0.02);
  halo([0, 0, 0.5], 3.2, "#ff5a30", 0.3, onAir);
  practical("#ff5534", [4, 3.5], [0, -0.2, 0.7], onAir);
}

export function buildHall(k: Kit, station: THREE.Group): THREE.Group {
  const { brass, gold, copper, iron, cream, hallTeal, hallCream, hallDark, steel, warmSoft, glass } = k;
  const hall = add(new THREE.Group(), station);
  hall.position.set(-0.7, DECK_Y, -0.25);
  // Plinth: iron footing, cream enamel skirt, riveted brass trim.
  capSlab(0.3, 0, 0.1, iron, hall);
  band([0, TAU], [0.1, 0.6], 0.2, hallCream, hall);
  capSlab(0.2, 0.1, 0.5, hallCream, hall).visible = false;
  capSlab(0.24, 0.58, 0.04, brass, hall);
  tube(loop(0, TAU, 0.25, 0.62, 160, true), 0.03, gold, hall, true);
  rivets(loop(0, TAU, 0.205, 0.33, 120, true), 0.018, brass, hall);
  // Glazing wraps the front; a riveted wall closes the back.
  const panes = band([GLASS_FROM, GLASS_TO], [0.62, 2.46], 0, glass, hall);
  panes.castShadow = false;
  panes.receiveShadow = false;
  panes.renderOrder = 2;
  band([GLASS_TO, GLASS_FROM + TAU], [0.62, 2.46], 0.01, hallTeal, hall);
  for (let i = 0; i <= 10; i++) {
    const p = plan(GLASS_FROM + ((GLASS_TO - GLASS_FROM) * i) / 10, 0.03);
    rod(p.clone().setY(0.62), p.clone().setY(2.46), i === 0 || i === 10 ? 0.06 : 0.032, brass, hall, 10);
  }
  tube(loop(GLASS_FROM, GLASS_TO, 0.04, 0.66, 90), 0.04, gold, hall);
  tube(loop(GLASS_FROM, GLASS_TO, 0.04, 2.42, 90), 0.04, gold, hall);
  // Streamline fascia with three enamel speed stripes, overhanging the glass.
  capSlab(0.22, 2.44, 0.04, hallDark, hall);
  band([0, TAU], [2.46, 3.46], 0.22, hallTeal, hall);
  tube(loop(0, TAU, 0.25, 2.48, 160, true), 0.055, gold, hall, true);
  for (const y of [2.72, 2.88, 3.04]) tube(loop(0, TAU, 0.245, y, 160, true), 0.032, cream, hall, true);
  rivets(loop(0, TAU, 0.228, 3.3, 140, true), 0.016, brass, hall);
  band([0, TAU], [3.46, 3.62], 0.3, hallDark, hall);
  tube(loop(0, TAU, 0.31, 3.62, 160, true), 0.05, gold, hall, true);
  dome(0.28, 3.62, 0.45, hallDark, hall);
  // Roof furniture: vents, a cream pressure dome with red bands and a teal service dome.
  for (const [x, z] of [
    [-1.3, -0.6],
    [-1.55, 0.3],
  ]) {
    cyl([0.13, 0.13, 0.45], [x, 3.95, z], brass, hall, [16]);
    cyl([0.2, 0.2, 0.05], [x, 4.2, z], gold, hall, [16]);
  }
  hallRoofTanks(k, { hall });
  // Rear portholes with warm light leaking from the studio.
  for (const a of [1.95, 4.2]) {
    const g = onWall(hall, a, 1.62, 0.02);
    torus([0.27, 0.05], [0, 0, 0.02], brass, g, false);
    mesh(new THREE.CircleGeometry(0.25, 32), warmSoft, [0, 0, 0.0], g, false);
    rivets(
      ringPoints(0.36, 0, 10).map((p: THREE.Vector3): THREE.Vector3 => new THREE.Vector3(p.x, p.z, 0.03)),
      0.02,
      gold,
      g,
    );
  }
  for (const [a, y] of [
    [2.5, 2.0],
    [3.75, 1.95],
  ] as const) {
    const g = onWall(hall, a, y, 0.03);
    box([0.82, 0.5, 0.06], [0, 0, 0], steel, g, 0.03);
    for (let i = 0; i < 6; i++) box([0.7, 0.03, 0.07], [0, -0.17 + i * 0.068, 0.03], iron, g, 0.008).rotation.x = -0.5;
  }
  hallServiceDoor(k, { hall });
  hallFuseBox(k, { hall });
  // Copper service lines wrapping the back of the hall.
  tube(loop(1.55, 4.4, 0.14, 1.0, 60), 0.05, copper, hall);
  tube(loop(1.85, 2.85, 0.14, 2.3, 30), 0.035, copper, hall);
  for (let i = 0; i < 10; i++) {
    const a = 1.6 + i * 0.3;
    if (Math.abs(a - 3.1) < 0.3) continue;
    box([0.06, 1.45, 0.06], [0, 0, 0], iron, onWall(hall, a, 1.62, 0.1), 0.01);
  }

  // ON AIR marquee, mounted proud of the fascia.
  const onAir = add(new THREE.Group(), hall);
  hallOnAirSign(k, { onAir });
  return hall;
}
