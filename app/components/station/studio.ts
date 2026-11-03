import * as THREE from "three";
import * as T from "./textures";
import type { Kit } from "./kit";
import { add, mesh, box, cyl, ball, torus, rod, tube, plaque, frame, lathe, rivets, TAU, profile } from "./shapes";
import { plan, facing, facingIn, loop, band, planShape, planSector, GLASS_FROM, GLASS_TO } from "./plan";

interface StudioScope {
  studio: THREE.Group;
  hall: THREE.Group;
  floorY: number;
  deskTop: number;
  onDesk: (a: number, inset: number, out: boolean) => THREE.Group;
  counterTop: number;
  rack: ReturnType<typeof T.rackFace>;
}

function studioMicrophone(k: Kit, s: Pick<StudioScope, "onDesk">): void {
  const { chrome } = k;
  const { onDesk } = s;
  const g = onDesk(0.02, -0.6, true);
  g.scale.setScalar(1.15);
  lathe(
    profile(0, 0, 0.12, 0, 0.125, 0.012, 0.11, 0.03, 0.07, 0.045, 0.03, 0.06, 0.022, 0.075, 0, 0.075),
    chrome,
    [0, 0, 0],
    g,
    40,
  );
  cyl([0.012, 0.014, 0.2], [0, 0.17, 0], chrome, g, [12]);
  const head = add(new THREE.Group(), g);
  head.position.set(0, 0.43, 0);
  head.rotation.x = 0.12;
  const capsuleProfile: Array<[number, number]> = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24,
      y = -0.15 + t * 0.3;
    capsuleProfile.push([
      Math.max(0.001, 0.085 * Math.pow(Math.sin(t * Math.PI), 0.5) * (1 - 0.15 * Math.pow(Math.abs(t - 0.5) * 2, 2))),
      y,
    ]);
  }
  const grilleMap = T.grille();
  const capsule = lathe(
    capsuleProfile,
    new THREE.MeshStandardMaterial({ map: grilleMap, metalnessMap: grilleMap, metalness: 1, roughness: 0.28 }),
    [0, 0, 0],
    head,
    48,
  );
  capsule.scale.set(1.1, 1, 0.75);
  const spine = capsuleProfile.map(
    ([r, y]: [number, number]): THREE.Vector3 => new THREE.Vector3(0, y, r * 0.75 + 0.004),
  );
  tube(spine, 0.009, chrome, head, false, 0.5);
  tube(
    spine.map((p: THREE.Vector3): THREE.Vector3 => new THREE.Vector3(0, p.y, -p.z)),
    0.009,
    chrome,
    head,
    false,
    0.5,
  );
  tube(
    [
      new THREE.Vector3(-0.105, 0.0, 0),
      new THREE.Vector3(-0.105, -0.11, 0),
      new THREE.Vector3(-0.05, -0.18, 0),
      new THREE.Vector3(0, -0.185, 0),
      new THREE.Vector3(0.05, -0.18, 0),
      new THREE.Vector3(0.105, -0.11, 0),
      new THREE.Vector3(0.105, 0, 0),
    ],
    0.01,
    chrome,
    head,
  );
  for (const x of [-0.105, 0.105]) ball(0.02, [x, 0, 0], chrome, head, 12);
  cyl([0.012, 0.012, 0.08], [0, -0.22, 0], chrome, head, [10]);
}

function studioConsole(k: Kit, s: Pick<StudioScope, "onDesk">): void {
  const { brass, tealDark, rubber, gauge } = k;
  const { onDesk } = s;
  const g = onDesk(-1.0, -0.7, false);
  g.rotation.y += 0.25;
  box([0.62, 0.12, 0.4], [0, 0.06, 0], tealDark, g, 0.04);
  const top = add(new THREE.Group(), g);
  top.position.set(0, 0.14, 0);
  top.rotation.x = 0.3;
  box(
    [0.6, 0.035, 0.36],
    [0, 0, 0],
    new THREE.MeshStandardMaterial({ color: "#3a6a63", metalness: 0.4, roughness: 0.45 }),
    top,
    0.012,
  );
  for (let c = 0; c < 6; c++) {
    const x = -0.24 + c * 0.095;
    box([0.01, 0.006, 0.16], [x, 0.02, 0.07], rubber, top, 0.002);
    box(
      [0.035, 0.03, 0.025],
      [x, 0.04, 0.03 + (c % 3) * 0.035],
      new THREE.MeshStandardMaterial({ color: "#efe3c4", roughness: 0.35 }),
      top,
      0.008,
    );
    cyl([0.016, 0.018, 0.03], [x, 0.035, -0.08], rubber, top, [14]);
  }
  for (const x of [-0.13, 0.13]) {
    box([0.2, 0.14, 0.06], [x, 0.24, -0.17], brass, g, 0.02);
    gauge([x, 0.24, -0.135], 0, 0.06, g, true);
  }
}

function studioDeskPlant(k: Kit, s: Pick<StudioScope, "studio" | "deskTop">): void {
  const { gold, plant } = k;
  const { studio, deskTop } = s;
  const p = plan(-1.55, -0.62, deskTop);
  lathe(profile(0, 0, 0.1, 0, 0.12, 0.04, 0.13, 0.2, 0.14, 0.22, 0, 0.22), gold, [p.x, p.y, p.z], studio, 28);
  plant([p.x, p.y + 0.2, p.z], 11, 0.38, studio, 41);
}

function studioCrt(k: Kit, s: Pick<StudioScope, "onDesk" | "counterTop">): void {
  const { gold, iron, cream, animators, onLights } = k;
  const { onDesk, counterTop } = s;
  const g = onDesk(2.8, -0.38, false);
  g.position.y = counterTop;
  box([0.62, 0.5, 0.5], [0, 0.26, -0.02], cream, g, 0.11);
  box([0.52, 0.4, 0.04], [0, 0.28, 0.22], iron, g, 0.07);
  const crtMaterial = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOn: { value: 1 } },
    vertexShader:
      "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform float uTime; uniform float uOn; varying vec2 vUv;
              float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
              void main(){
                  vec2 p = vUv; vec2 d = p - 0.5;
                  float wave = 0.5 + sin(p.x * 14.0 + uTime * 2.6) * 0.1 * sin(uTime * 0.8 + p.x * 3.0);
                  float trace = smoothstep(0.025, 0.0, abs(p.y - wave));
                  float grid = step(0.965, fract(p.x * 7.0)) + step(0.965, fract(p.y * 5.0));
                  float scan = 0.86 + 0.14 * sin(p.y * 240.0 - uTime * 4.0);
                  float vig = smoothstep(0.75, 0.2, length(d * vec2(1.0, 1.2)));
                  vec3 col = vec3(0.32, 0.42, 0.36) * 0.55 + vec3(0.12, 0.16, 0.13) * grid + vec3(0.55, 1.0, 0.75) * trace;
                  col += hash(p * 300.0 + uTime) * 0.035;
                  gl_FragColor = vec4(col * scan * vig * mix(0.25, 1.25, uOn), 1.0);
              }`,
  });
  animators.push((t: number): void => {
    crtMaterial.uniforms.uTime!.value = t;
  });
  onLights.push((on: boolean): void => {
    crtMaterial.uniforms.uOn!.value = on ? 1 : 0.08;
  });
  const screenGeo = new THREE.SphereGeometry(1, 32, 24, Math.PI / 2 - 0.2, 0.4, Math.PI / 2 - 0.16, 0.32);
  screenGeo.translate(0, 0, -Math.cos(0.2) + 0.02);
  mesh(screenGeo, crtMaterial, [0, 0.28, 0.22], g, false);
  for (let i = 0; i < 2; i++)
    cyl([0.025, 0.025, 0.03], [0.2, 0.1 + i * 0.07, 0.25], gold, g, [12]).rotation.x = Math.PI / 2;
}

function studioTapeDeck(k: Kit, s: Pick<StudioScope, "onDesk" | "counterTop">): void {
  const { iron, animators } = k;
  const { onDesk, counterTop } = s;
  const g = onDesk(2.5, -0.36, false);
  g.position.y = counterTop;
  box([0.42, 0.3, 0.3], [0, 0.15, 0], iron, g, 0.03);
  const reelFace = new THREE.MeshStandardMaterial({
    map: T.reel(),
    metalness: 0.6,
    roughness: 0.35,
    transparent: true,
    alphaTest: 0.5,
  });
  for (const x of [-0.1, 0.1]) {
    const spool = add(new THREE.Group(), g);
    spool.position.set(x, 0.2, 0.155);
    mesh(new THREE.CircleGeometry(0.085, 28), reelFace, [0, 0, 0.002], spool, false);
    animators.push((_t: number, dt: number): void => {
      spool.rotation.z -= dt * (x < 0 ? 2 : 1.5);
    });
  }
}

function studioRack(k: Kit, s: Pick<StudioScope, "studio" | "floorY" | "rack">): void {
  const { brass, tealDark, emissives } = k;
  const { studio, floorY, rack } = s;
  const g = add(new THREE.Group(), studio);
  g.position.copy(plan(3.6, -0.32, floorY));
  g.rotation.y = facingIn(3.6);
  box([0.72, 1.62, 0.42], [0, 0.81, 0], tealDark, g, 0.03);
  const face = mesh(
    new THREE.PlaneGeometry(0.64, 1.5),
    new THREE.MeshStandardMaterial({
      map: rack.map,
      emissiveMap: rack.glow,
      emissive: "#ffb050",
      emissiveIntensity: 1.3,
      roughness: 0.45,
      metalness: 0.3,
    }),
    [0, 0.83, 0.215],
    g,
    false,
  );
  emissives.push([face.material as THREE.MeshStandardMaterial, 1.3]);
  for (const x of [-0.34, 0.34]) box([0.03, 1.6, 0.03], [x, 0.81, 0.22], brass, g, 0.01);
}

function studioLocker(k: Kit, s: Pick<StudioScope, "studio" | "floorY">): void {
  const { brass, gold, iron, cream, warm, practical } = k;
  const { studio, floorY } = s;
  const g = add(new THREE.Group(), studio);
  g.position.copy(plan(2.0, -0.3, floorY));
  g.rotation.y = facingIn(2.0);
  box([0.5, 1.45, 0.4], [0, 0.725, 0], cream, g, 0.03);
  for (let i = 0; i < 6; i++) box([0.3, 0.02, 0.02], [0, 1.15 + i * 0.04, 0.205], iron, g, 0.005);
  box([0.03, 0.14, 0.03], [0.18, 0.72, 0.21], gold, g, 0.01);
  const lamp = add(new THREE.Group(), g);
  lamp.position.set(0, 1.45, 0);
  cyl([0.08, 0.09, 0.05], [0, 0.025, 0], brass, lamp, [20]);
  ball(0.075, [0, 0.14, 0], warm, lamp, 20);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    tube(
      [
        new THREE.Vector3(Math.cos(a) * 0.085, 0.04, Math.sin(a) * 0.085),
        new THREE.Vector3(Math.cos(a) * 0.095, 0.15, Math.sin(a) * 0.095),
        new THREE.Vector3(0, 0.25, 0),
      ],
      0.006,
      brass,
      lamp,
    );
  }
  torus([0.09, 0.008], [0, 0.14, 0], brass, lamp);
  practical("#ffbf70", [1.6, 2], [0, 0.2, 0.1], lamp);
}

function studioDoor(k: Kit, s: Pick<StudioScope, "studio" | "floorY">): void {
  const { brass, gold, warmSoft } = k;
  const { studio, floorY } = s;
  const g = add(new THREE.Group(), studio);
  g.position.copy(plan(1.62, -0.07, floorY));
  g.rotation.y = facingIn(1.62);
  plaque([0.78, 1.7, 0.05, 0.1], [0, 0.87, 0], gold, g);
  frame([0.9, 1.82, 0.14, 0.07, 0.06], [0, 0.9, 0.02], brass, g);
  const oval = new THREE.Shape();
  oval.absellipse(0, 0, 0.09, 0.26, 0, TAU, false, 0);
  mesh(new THREE.ShapeGeometry(oval, 24), warmSoft, [0, 1.25, 0.056], g, false);
  tube(
    new THREE.EllipseCurve(0, 0, 0.1, 0.27)
      .getPoints(30)
      .map((p: THREE.Vector2): THREE.Vector3 => new THREE.Vector3(p.x, p.y + 1.25, 0.06)),
    0.014,
    brass,
    g,
    true,
  );
  rivets(
    [-0.33, 0.33].flatMap((x: number): THREE.Vector3[] =>
      [0.2, 0.5, 0.8, 1.1, 1.4].map((y: number): THREE.Vector3 => new THREE.Vector3(x, y, 0.06)),
    ),
    0.015,
    brass,
    g,
  );
  tube(
    [
      new THREE.Vector3(-0.3, 0.75, 0.07),
      new THREE.Vector3(-0.3, 0.78, 0.12),
      new THREE.Vector3(-0.3, 1.0, 0.12),
      new THREE.Vector3(-0.3, 1.03, 0.07),
    ],
    0.014,
    gold,
    g,
  );
}

function studioClock(k: Kit, s: Pick<StudioScope, "studio">): void {
  const { brass, iron } = k;
  const { studio } = s;
  const g = add(new THREE.Group(), studio);
  g.position.copy(plan(3.05, -0.1, 1.95));
  g.rotation.y = facingIn(3.05);
  cyl([0.16, 0.16, 0.04], [0, 0, 0], brass, g, [32]).rotation.x = Math.PI / 2;
  mesh(
    new THREE.CircleGeometry(0.14, 32),
    new THREE.MeshStandardMaterial({ map: T.clockFace(), roughness: 0.5 }),
    [0, 0, 0.021],
    g,
    false,
  );
  box([0.011, 0.09, 0.004], [0, 0.035, 0.03], iron, g, 0.002).rotation.z = -0.6;
  box([0.009, 0.12, 0.004], [0, 0.045, 0.033], iron, g, 0.002).rotation.z = 1.1;
}

function studioPendants(k: Kit, s: Pick<StudioScope, "studio">): void {
  const { brassSurface, brass, warm, halo, practical } = k;
  const { studio } = s;
  for (const [a, inset, drop] of [
    [-0.35, -0.72, 0.5],
    [2.8, -0.45, 0.35],
  ] as const) {
    const p = plan(a, inset, 2.43);
    const g = add(new THREE.Group(), studio);
    g.position.copy(p);
    rod(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -drop, 0), 0.006, brass, g, 4);
    lathe(
      profile(0.02, 0, 0.05, -0.01, 0.14, -0.06, 0.22, -0.14, 0.26, -0.2, 0.265, -0.21),
      new THREE.MeshStandardMaterial({
        map: brassSurface.map,
        metalness: 1,
        roughness: 0.35,
        color: "#ffe3ae",
        side: THREE.DoubleSide,
      }),
      [0, -drop, 0],
      g,
      40,
    );
    ball(0.07, [0, -drop - 0.14, 0], warm, g, 16);
    halo([0, -drop - 0.18, 0], 0.5, "#ffc070", 0.25, g);
    practical("#ffb466", [a < 0 ? 8 : 5, 4.5], [0, -drop - 0.3, 0], g);
  }
}

function studioChair(k: Kit, s: Pick<StudioScope, "studio" | "floorY">): void {
  const { chrome, rubber, leather } = k;
  const { studio, floorY } = s;
  const g = add(new THREE.Group(), studio);
  g.position.copy(plan(-0.3, -1.5, floorY));
  g.rotation.y = facing(-0.3) + 0.35;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    rod(
      new THREE.Vector3(0, 0.07, 0),
      new THREE.Vector3(Math.cos(a) * 0.3, 0.04, Math.sin(a) * 0.3),
      0.018,
      chrome,
      g,
      8,
    );
    ball(0.03, [Math.cos(a) * 0.3, 0.03, Math.sin(a) * 0.3], rubber, g, 10);
  }
  cyl([0.03, 0.035, 0.34], [0, 0.23, 0], chrome, g, [16]);
  box([0.56, 0.14, 0.52], [0, 0.47, 0], leather, g, 0.07);
  const back = box([0.54, 0.62, 0.14], [0, 0.85, -0.24], leather, g, 0.07);
  back.rotation.x = -0.14;
  for (const x of [-0.31, 0.31])
    tube(
      [
        new THREE.Vector3(x, 0.5, -0.2),
        new THREE.Vector3(x, 0.7, -0.12),
        new THREE.Vector3(x, 0.68, 0.14),
        new THREE.Vector3(x, 0.5, 0.2),
      ],
      0.016,
      chrome,
      g,
    );
}

function studioFloorPlant(k: Kit, s: Pick<StudioScope, "studio" | "floorY">): void {
  const { gold, plant } = k;
  const { studio, floorY } = s;
  const p = plan(-1.95, -0.5);
  lathe(profile(0, 0, 0.13, 0, 0.16, 0.05, 0.17, 0.3, 0.18, 0.32, 0, 0.32), gold, [p.x, floorY, p.z], studio, 28);
  plant([p.x, floorY + 0.3, p.z], 12, 0.55, studio, 31);
}

function studioPlanters(k: Kit, s: Pick<StudioScope, "hall">): void {
  const { gold, hallCream, soil, plant } = k;
  const { hall } = s;
  for (const [a0, a1, seed] of [
    [-1.5, -0.55, 17],
    [0.25, 0.62, 19],
  ] as const) {
    planSector([a0, a1], [0.25, 0.7], 0.36, hallCream, 0, hall);
    planSector([a0 + 0.02, a1 - 0.02], [0.28, 0.67], 0.02, soil, 0.37, hall).castShadow = false;
    tube(loop(a0, a1, 0.72, 0.38, 30), 0.025, gold, hall);
    const rnd = T.random(seed);
    for (let i = 0; i < 5; i++) {
      const p = plan(a0 + 0.06 + ((a1 - a0 - 0.12) * i) / 4, 0.48);
      plant([p.x, 0.38, p.z], 9, 0.38 + rnd() * 0.2, hall, seed * 10 + i);
    }
  }
}

export function buildStudio(k: Kit, hall: THREE.Group): void {
  const { steelSurface, brass, gold, copper, tealDark, cream, warm, wood, practical } = k;
  // The host faces the street: a curved desk follows the glazing, the microphone points out
  // through the glass, and the equipment wall (rack, CRT, locker, door) lines the back.
  const studio = add(new THREE.Group(), hall);
  const floorY = 0.63;
  const floorGeo = new THREE.ShapeGeometry(planShape(-0.03), 4);
  floorGeo.rotateX(-Math.PI / 2);
  mesh(
    floorGeo,
    new THREE.MeshStandardMaterial({
      map: T.repeat(steelSurface, 0.5, 0.5).map,
      color: "#5b6264",
      roughness: 0.7,
      metalness: 0.45,
    }),
    [0, floorY, 0],
    studio,
    false,
  );
  tube(loop(-1.85, 1.15, -1.25, floorY + 0.006, 60), 0.014, gold, studio).castShadow = false;
  tube(loop(-1.85, 1.15, -1.35, floorY + 0.006, 60), 0.014, gold, studio).castShadow = false;
  const fluteSurface = T.repeat(T.flutes(5), 5, 1);
  const flutedWall = new THREE.MeshStandardMaterial({
    map: fluteSurface.map,
    bumpMap: fluteSurface.bump,
    bumpScale: 2,
    roughness: 0.5,
    metalness: 0.35,
  });
  band([GLASS_TO + 0.03, GLASS_FROM + TAU - 0.03], [floorY, 2.44], -0.08, flutedWall, studio, { inward: true });
  const ceilingGeo = new THREE.ShapeGeometry(planShape(0), 4);
  ceilingGeo.rotateX(Math.PI / 2);
  mesh(ceilingGeo, new THREE.MeshStandardMaterial({ color: "#23302f", roughness: 0.85 }), [0, 2.43, 0], studio, false);
  for (const [x, z] of [
    [-1.4, 0.5],
    [1.2, 0.4],
    [-0.2, -1.1],
    [1.3, -1.0],
    [-1.6, -0.9],
  ]) {
    const spot = mesh(new THREE.CircleGeometry(0.07, 20), warm, [x, 2.425, z], studio, false);
    spot.rotation.x = Math.PI / 2;
  }
  // Service pipes on the back wall.
  tube(loop(1.75, 4.3, -0.16, 2.28, 50), 0.035, brass, studio);
  tube(loop(1.9, 4.2, -0.16, 2.18, 50), 0.025, copper, studio);
  for (const a of [2.15, 3.95, 4.15]) {
    const p = plan(a, -0.16);
    rod(p.clone().setY(floorY), p.clone().setY(2.42), 0.03, brass, studio, 10);
  }
  // Curved desk with a teal modesty panel and brass-handled drawer pedestals.
  const deskTop = floorY + 0.8;
  const deskFrom = -1.8,
    deskTo = 1.0;
  planSector([deskFrom, deskTo], [-0.98, -0.34], 0.06, wood, deskTop - 0.06, studio);
  tube(loop(deskFrom, deskTo, -0.98, deskTop + 0.005, 70), 0.022, gold, studio);
  band([deskFrom, deskTo], [floorY, deskTop - 0.06], -0.9, tealDark, studio, { inward: true, segments: 70 });
  tube(loop(deskFrom, deskTo, -0.91, floorY + 0.08, 70), 0.012, gold, studio);
  for (const a of [-1.45, 0.7]) {
    const g = add(new THREE.Group(), studio);
    g.position.copy(plan(a, -1.06, floorY));
    g.rotation.y = facingIn(a);
    box([0.48, 0.7, 0.32], [0, 0.35, 0], cream, g, 0.03);
    for (let i = 0; i < 3; i++) {
      box([0.42, 0.19, 0.02], [0, 0.14 + i * 0.2, 0.16], cream, g, 0.015);
      box([0.12, 0.025, 0.03], [0, 0.18 + i * 0.2, 0.18], gold, g, 0.01);
    }
  }
  const onDesk = (a: number, inset: number, out: boolean): THREE.Group => {
    const g = add(new THREE.Group(), studio);
    g.position.copy(plan(a, inset, deskTop));
    g.rotation.y = out ? facing(a) : facingIn(a);
    return g;
  };
  // Classic chrome microphone: heavy round base, stem, yoke and a ribbed pill capsule, facing the street.
  studioMicrophone(k, { onDesk });
  // Compact mixing console at the left of the desk, angled to the host.
  studioConsole(k, { onDesk });
  // Brass-potted plant on the desk.
  studioDeskPlant(k, { studio, deskTop });
  // Back counter with the CRT and a tape deck; tall equipment rack; louvred locker with a caged lamp; riveted door.
  const counterFrom = 2.35,
    counterTo = 3.3,
    counterTop = floorY + 0.74;
  planSector([counterFrom, counterTo], [-0.62, -0.1], 0.05, wood, counterTop - 0.05, studio);
  band([counterFrom, counterTo], [floorY, counterTop - 0.05], -0.6, cream, studio, { inward: true, segments: 40 });
  tube(loop(counterFrom, counterTo, -0.62, counterTop + 0.004, 40), 0.016, gold, studio);
  studioCrt(k, { onDesk, counterTop });
  studioTapeDeck(k, { onDesk, counterTop });
  const rack = T.rackFace();
  studioRack(k, { studio, floorY, rack });
  studioLocker(k, { studio, floorY });
  studioDoor(k, { studio, floorY });
  studioClock(k, { studio });
  // Brass dome pendants over the desk and the counter.
  studioPendants(k, { studio });
  // Swivel chair in tufted tan leather behind the desk, facing the window.
  studioChair(k, { studio, floorY });
  // Floor plant by the glazing.
  studioFloorPlant(k, { studio, floorY });
  practical("#ffa858", [4.5, 4.5], [0, 2.1, 0.6], studio);
  practical("#ff9f50", [3, 3.5], [0, 1.6, -1.2], studio);

  // Curved planters hugging the glazing outside.
  studioPlanters(k, { hall });
}
