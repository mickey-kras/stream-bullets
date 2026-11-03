import * as THREE from "three";
import * as T from "./textures";
import type { Kit } from "./kit";
import { add, mesh, box, cyl, ball, torus, rod, pipe, polar, rivets, ringPoints, TAU, DECK_Y } from "./shapes";

interface WorksScope {
  works: THREE.Group;
  tankB: THREE.Group;
  tankA: THREE.Group;
}

function worksLadder(k: Kit, s: Pick<WorksScope, "tankB">): void {
  const { brass } = k;
  const { tankB } = s;
  const a = 2.85 + 0.9;
  const ladder = add(new THREE.Group(), tankB);
  ladder.position.set(Math.sin(a) * 0.58, 0, Math.cos(a) * 0.58);
  ladder.rotation.y = a;
  for (const x of [-0.13, 0.13])
    rod(new THREE.Vector3(x, 0.2, 0), new THREE.Vector3(x, 2.85, 0), 0.016, brass, ladder, 6);
  for (let i = 0; i < 11; i++)
    rod(
      new THREE.Vector3(-0.13, 0.35 + i * 0.24, 0),
      new THREE.Vector3(0.13, 0.35 + i * 0.24, 0),
      0.012,
      brass,
      ladder,
      6,
    );
}

function worksBoiler(k: Kit, s: Pick<WorksScope, "works">): void {
  const { vents, brass, copper, iron, cream, red, gauge, valve } = k;
  const { works } = s;
  const a = -2.45;
  const g = add(new THREE.Group(), works);
  g.position.copy(polar(3.88, a));
  g.rotation.y = a + Math.PI / 2;
  for (const x of [-0.6, 0.6]) {
    box([0.22, 0.55, 0.9], [x, 0.3, 0], iron, g, 0.03);
  }
  const body = cyl([0.6, 0.6, 1.9], [0, 0.95, 0], red, g, [48]);
  body.rotation.z = Math.PI / 2;
  for (const x of [-0.95, 0.95]) {
    const end = ball(0.6, [x, 0.95, 0], cream, g, 40);
    end.scale.x = 0.38;
  }
  for (const x of [-0.7, 0, 0.7]) {
    const band = torus([0.615, 0.03], [x, 0.95, 0], brass, g, false);
    band.rotation.y = Math.PI / 2;
  }
  const door = add(new THREE.Group(), g);
  door.position.set(1.17, 0.95, 0);
  door.rotation.y = Math.PI / 2;
  cyl([0.26, 0.26, 0.05], [0, 0, 0], iron, door, [32]).rotation.x = Math.PI / 2;
  torus([0.26, 0.025], [0, 0, 0.03], brass, door, false);
  mesh(
    new THREE.CircleGeometry(0.08, 20),
    new THREE.MeshStandardMaterial({ color: "#ff8a3a", emissive: "#ff5a10", emissiveIntensity: 2.4 }),
    [0, 0, 0.031],
    door,
    false,
  );
  cyl([0.13, 0.16, 1.2], [-0.3, 2.0, 0], copper, g, [24]);
  cyl([0.22, 0.14, 0.14], [-0.3, 2.62, 0], brass, g, [24]);
  vents.push(g.localToWorld(new THREE.Vector3(-0.3, 2.7, 0)).clone());
  gauge([0.2, 1.62, 0], 0, 0.12, g);
  valve([0.55, 1.7, 0], new THREE.Euler(0, 0, 0), 0.12, g);
}

function worksGenerator(k: Kit, s: Pick<WorksScope, "works">): void {
  const { copper, iron, tealDark, red, beacon } = k;
  const { works } = s;
  const g = add(new THREE.Group(), works);
  g.position.copy(polar(3.95, 3.18));
  g.rotation.y = 3.18;
  box([1.0, 0.9, 0.65], [0, 0.45, 0], tealDark, g, 0.05);
  for (let i = 0; i < 6; i++) box([0.7, 0.025, 0.03], [0, 0.25 + i * 0.07, 0.33], iron, g, 0.005);
  mesh(
    new THREE.PlaneGeometry(0.8, 0.12),
    new THREE.MeshStandardMaterial({ map: T.hazard(), roughness: 0.6 }),
    [0, 0.78, 0.33],
    g,
    false,
  );
  box([0.12, 0.2, 0.05], [0.38, 0.62, 0.34], iron, g, 0.01);
  rod(new THREE.Vector3(0.38, 0.6, 0.38), new THREE.Vector3(0.38, 0.82, 0.5), 0.015, copper, g, 6);
  ball(0.03, [0.38, 0.82, 0.5], red, g, 10);
  ball(0.03, [-0.38, 0.62, 0.34], beacon, g, 10);
}

function worksFanUnit(k: Kit, s: Pick<WorksScope, "works">): void {
  const { brass, copper, chrome, iron, steel, animators } = k;
  const { works } = s;
  const g = add(new THREE.Group(), works);
  g.position.copy(polar(4.05, -1.88));
  g.rotation.y = -1.88;
  box([0.95, 0.85, 0.5], [0, 0.45, 0], steel, g, 0.05);
  const fan = add(new THREE.Group(), g);
  fan.position.set(0, 0.47, 0.26);
  torus([0.3, 0.035], [0, 0, 0], iron, fan, false);
  for (let i = 0; i < 4; i++) torus([0.08 + i * 0.065, 0.008], [0, 0, 0.02], iron, fan, false);
  const blades = add(new THREE.Group(), fan);
  for (let i = 0; i < 5; i++) {
    const holder = add(new THREE.Group(), blades);
    holder.rotation.z = (i / 5) * TAU;
    box([0.08, 0.26, 0.01], [0, 0.14, 0], chrome, holder, 0.01).rotation.y = 0.5;
  }
  ball(0.05, [0, 0, 0.02], brass, fan, 12);
  animators.push((_t: number, dt: number): void => {
    blades.rotation.z -= dt * 9;
  });
  for (const x of [-0.4, 0.4]) box([0.08, 0.1, 0.55], [x, 0.05, 0], iron, g, 0.02);
  pipe(
    [new THREE.Vector3(0.35, 0.85, -0.1), new THREE.Vector3(0.35, 1.4, -0.1), new THREE.Vector3(0.35, 1.4, -0.5)],
    0.045,
    [copper, brass],
    g,
  );
}

function worksGreyTank(k: Kit, s: Pick<WorksScope, "works">): void {
  const { brass, copper, iron, steel, gauge } = k;
  const { works } = s;
  const g = add(new THREE.Group(), works);
  g.position.copy(polar(4.05, 2.1));
  cyl([0.48, 0.5, 0.12], [0, 0.06, 0], iron, g, [32]);
  cyl([0.44, 0.44, 1.35], [0, 0.8, 0], steel, g, [40]);
  ball(0.44, [0, 1.48, 0], steel, g, 40).scale.y = 0.35;
  for (const y of [0.3, 1.3]) torus([0.45, 0.025], [0, y, 0], brass, g);
  rivets(ringPoints(0.45, 0.8, 26), 0.016, brass, g);
  pipe(
    [new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(0, 2.0, 0), new THREE.Vector3(-0.75, 2.0, 0)],
    0.05,
    [copper, brass],
    g,
  );
  gauge([0, 0.95, 0.45], 0, 0.1, g);
}

function worksPipework(k: Kit, s: Pick<WorksScope, "works">): void {
  const { brass, copper, gauge, valve } = k;
  const { works } = s;
  const w = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  const A = polar(3.2, 2.5),
    B = polar(3.55, 2.85);
  pipe([w(A.x - 0.45, 1.6, A.z + 0.3), w(A.x - 0.9, 1.6, A.z + 0.6), w(1.1, 1.6, -1.65)], 0.07, [copper, brass], works);
  pipe(
    [w(B.x + 0.2, 2.4, B.z + 0.4), w(B.x + 0.2, 2.4, A.z - 0.1), w(A.x - 0.3, 2.4, A.z - 0.1)],
    0.055,
    [copper, brass],
    works,
  );
  pipe([w(A.x, 2.55, A.z), w(A.x, 3.3, A.z), w(1.3, 3.3, -1.0), w(0.4, 3.95, -0.9)], 0.08, [brass, brass], works);
  const boiler = polar(3.88, -2.45);
  pipe(
    [w(boiler.x + 0.3, 1.55, boiler.z + 0.35), w(boiler.x + 0.3, 2.0, boiler.z + 0.35), w(-1.6, 2.0, -2.0)],
    0.06,
    [copper, brass],
    works,
  );
  pipe(
    [w(boiler.x + 0.5, 0.5, boiler.z - 0.3), w(-0.2, 0.5, -3.4), w(B.x - 0.4, 0.5, B.z)],
    0.05,
    [copper, brass],
    works,
  );
  valve([B.x + 0.2, 2.4, (B.z + A.z) / 2 + 0.2], new THREE.Euler(0, 0, Math.PI / 2), 0.13, works);
  valve([A.x - 0.7, 1.6, A.z + 0.47], new THREE.Euler(Math.PI / 2, 0, 0), 0.12, works);
  valve([-0.6, 0.5, -3.33], new THREE.Euler(Math.PI / 2, 0, 0), 0.1, works);
  gauge([-0.2, 0.75, -3.35], Math.PI, 0.1, works);
}

export function buildWorks(k: Kit, station: THREE.Group): void {
  const { vents, brass, gold, iron, cream, red, label, gauge } = k;
  const works = add(new THREE.Group(), station);
  works.position.y = DECK_Y;
  function tank(at: THREE.Vector3, r: number, h: number, stripes: number[]): THREE.Group {
    const g = add(new THREE.Group(), works);
    g.position.copy(at);
    cyl([r + 0.1, r + 0.14, 0.16], [0, 0.08, 0], iron, g, [40]);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      box([0.1, 0.3, 0.1], [Math.sin(a) * (r + 0.02), 0.25, Math.cos(a) * (r + 0.02)], iron, g, 0.02).rotation.y = a;
    }
    cyl([r, r, h], [0, 0.2 + h / 2, 0], cream, g, [48]);
    const dome = ball(r, [0, 0.2 + h, 0], cream, g, 40);
    dome.scale.y = 0.62;
    for (const s of stripes) torus([r + 0.012, 0.045], [0, 0.2 + h * s, 0], red, g);
    for (const s of [0.04, 0.5, 0.98]) rivets(ringPoints(r + 0.01, 0.2 + h * s, 36), 0.02, brass, g);
    cyl([0.07, 0.09, 0.25], [0, 0.2 + h + r * 0.62, 0], brass, g, [16]);
    ball(0.08, [0, 0.32 + h + r * 0.62, 0], gold, g, 12);
    vents.push(at.clone().add(new THREE.Vector3(0, DECK_Y + 0.4 + h + r * 0.62, 0)));
    return g;
  }
  const tankA = tank(polar(3.2, 2.5), 0.62, 1.9, [0.62, 0.78]);
  const tankB = tank(polar(3.55, 2.85), 0.5, 2.5, [0.3, 0.7]);
  gauge([Math.sin(2.5) * 0.63, 1.25, Math.cos(2.5) * 0.63], 2.5, 0.14, tankA);
  label(
    (ctx: CanvasRenderingContext2D, w: number, h: number): void => {
      ctx.fillStyle = "#efe3c4";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#2b2116";
      ctx.lineWidth = 8;
      ctx.strokeRect(6, 6, w - 12, h - 12);
      ctx.fillStyle = "#a5352a";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `800 ${Math.round(h * 0.5)}px ${k.family}`;
      ctx.fillText("HIGH PRESSURE", w / 2, h * 0.55, w * 0.9);
    },
    [0.7, 0.16],
    [Math.sin(2.85) * 0.51, 1.0, Math.cos(2.85) * 0.51],
    tankB,
    0.1,
    512,
  ).rotation.y = 2.85;
  // Ladder up the tall tank.
  worksLadder(k, { tankB });
  // Horizontal boiler on cradles, with a riveted firebox door and a smokestack.
  worksBoiler(k, { works });
  // Generator cabinet with louvres, hazard plate and a knife switch.
  worksGenerator(k, { works });
  worksFanUnit(k, { works });
  worksGreyTank(k, { works });
  // Pipework tying boiler and tanks into the hall.
  worksPipework(k, { works });
}
