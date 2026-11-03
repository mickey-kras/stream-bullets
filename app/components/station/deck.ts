import * as THREE from "three";
import * as M from "./materials";
import * as T from "./textures";
import type { Kit } from "./kit";
import { add, mesh, cyl, ball, torus, rod, tube, arc, lathe, rivets, ringPoints, TAU, profile } from "./shapes";

export function buildDeck(k: Kit, station: THREE.Group): void {
  const { tiles, brassSurface, brass, gold, iron, emissives, halo, practical } = k;
  const DECK_Y = 0.45;
  cyl([5.02, 5.22, 0.36], [0, 0.18, 0], brass, station, [96]);
  cyl([5.08, 5.08, 0.1], [0, 0.38, 0], gold, station, [96]);
  cyl([4.4, 3.4, 0.7], [0, -0.35, 0], iron, station, [64]);
  torus([5, 0.05], [0, DECK_Y - 0.01, 0], gold, station);
  torus([3.9, 0.05], [0, -0.7, 0], brass, station);
  rivets(ringPoints(5.22, 0.1, 120), 0.03, gold, station);
  rivets(ringPoints(5.1, 0.37, 120), 0.024, gold, station);
  const deckSurface = T.deckPlates(13);
  const deck = mesh(
    new THREE.CircleGeometry(4.99, 128),
    M.wear(
      new THREE.MeshStandardMaterial({
        bumpMap: deckSurface.bump,
        bumpScale: 1.6,
        roughness: 0.9,
        metalness: 0.55,
        color: "#ffffff",
      }),
      {
        exposed: "#b9ab92",
        edges: 0,
        grime: 0,
        streaks: 0,
        exposedMetal: 0.8,
        exposedRough: 0.3,
        tile: tiles.steel,
        scale: 0.55,
        detail: 0.5,
      },
    ),
    [0, DECK_Y - 0.005, 0],
    station,
  );
  deck.rotation.x = -Math.PI / 2;
  deck.castShadow = false;
  // Guard rail around the deck with an open walkway at the front.
  {
    const r = 4.72,
      a0 = 0.42,
      a1 = TAU - 0.42;
    const posts = 34;
    for (let i = 0; i < posts; i++) {
      const a = a0 + ((a1 - a0) * i) / (posts - 1);
      const x = Math.sin(a) * r,
        z = Math.cos(a) * r;
      rod(new THREE.Vector3(x, DECK_Y, z), new THREE.Vector3(x, DECK_Y + 0.78, z), 0.022, gold, station, 8);
      ball(0.038, [x, DECK_Y + 0.8, z], gold, station, 10);
    }
    tube(arc(r, a0, a1, DECK_Y + 0.78, 80), 0.028, gold, station);
    tube(arc(r, a0, a1, DECK_Y + 0.44, 80), 0.018, brass, station);
    for (const a of [a0, a1]) {
      const x = Math.sin(a) * r,
        z = Math.cos(a) * r;
      cyl([0.05, 0.07, 0.9], [x, DECK_Y + 0.45, z], brass, station, [16]);
      ball(0.075, [x, DECK_Y + 0.95, z], gold, station);
    }
  }
  // Lamp standards: stepped bell base, fluted column, cup and an opal globe held in a ring cage.
  const opal = new THREE.MeshStandardMaterial({
    color: "#ffe9c2",
    emissive: "#ffc070",
    emissiveIntensity: 0.8,
    roughness: 0.6,
  });
  emissives.push([opal, 0.8]);
  for (const a of [-0.55, 0.6, 2, -1.45, Math.PI]) {
    const x = Math.sin(a) * 4.45,
      z = Math.cos(a) * 4.45;
    const lamp = add(new THREE.Group(), station);
    lamp.position.set(x, DECK_Y, z);
    lamp.scale.setScalar(1.12);
    lathe(
      profile(
        0,
        0,
        0.27,
        0,
        0.27,
        0.045,
        0.235,
        0.055,
        0.235,
        0.1,
        0.2,
        0.11,
        0.18,
        0.16,
        0.15,
        0.26,
        0.125,
        0.33,
        0.11,
        0.36,
        0,
        0.36,
      ),
      brass,
      [0, 0, 0],
      lamp,
      40,
    );
    cyl([0.085, 0.09, 0.05], [0, 0.385, 0], gold, lamp, [24]);
    cyl([0.05, 0.05, 0.52], [0, 0.67, 0], brass, lamp, [16]);
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * TAU;
      cyl([0.013, 0.013, 0.52], [Math.cos(t) * 0.055, 0.67, Math.sin(t) * 0.055], gold, lamp, [6]);
    }
    cyl([0.085, 0.08, 0.05], [0, 0.955, 0], gold, lamp, [24]);
    torus([0.075, 0.012], [0, 0.99, 0], brass, lamp);
    lathe(
      profile(0, 0, 0.04, 0, 0.07, 0.02, 0.13, 0.07, 0.165, 0.13, 0.17, 0.14),
      new THREE.MeshStandardMaterial({
        map: brassSurface.map,
        color: "#fff3d8",
        metalness: 1,
        roughness: 0.55,
        side: THREE.DoubleSide,
      }),
      [0, 1, 0],
      lamp,
      32,
    );
    ball(0.22, [0, 1.3, 0], opal, lamp, 40);
    torus([0.275, 0.016], [0, 1.31, 0], gold, lamp);
    for (let i = 0; i < 4; i++) {
      const t = (i / 4) * TAU + Math.PI / 4;
      tube(
        [
          new THREE.Vector3(Math.cos(t) * 0.165, 1.14, Math.sin(t) * 0.165),
          new THREE.Vector3(Math.cos(t) * 0.24, 1.2, Math.sin(t) * 0.24),
          new THREE.Vector3(Math.cos(t) * 0.275, 1.31, Math.sin(t) * 0.275),
        ],
        0.011,
        gold,
        lamp,
      );
    }
    halo([0, 1.3, 0], 1, "#ffc070", 0.22, lamp);
    if (Math.abs(a) < 1.1) practical("#ffc47a", [5, 3.2], [0, 1.45, 0], lamp);
  }
}
