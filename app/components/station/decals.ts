import * as THREE from "three";
import * as M from "./materials";
import * as T from "./textures";
import type { Kit } from "./kit";
import { mesh, TAU, DECK_Y } from "./shapes";
import { band } from "./plan";

export function buildDecals(k: Kit, station: THREE.Group, parts: { hall: THREE.Group; wing: THREE.Group }): void {
  const { hall, wing } = parts;
  {
    const rnd = T.random(808);
    const d = (kind: M.DecalKind, seed: number): THREE.MeshStandardMaterial => M.decalMaterial(kind, seed);
    const bolts = [d("bolts1", 1), d("bolts2", 2), d("bolts3", 3), d("bolts2", 9)];
    const chipsSet = [d("chip", 4), d("chip", 5), d("chip", 6)];
    const grime = [d("grime", 7), d("grime", 8)];
    const conform = (mat: THREE.Material, a0: number, a1: number, y0: number, y1: number, grow: number): void => {
      const m = band([a0, a1], [y0, y1], grow, mat, hall, {
        inward: false,
        segments: Math.max(4, Math.round((a1 - a0) * 40)),
        unit: true,
      });
      m.castShadow = false;
      m.renderOrder = 1;
    };
    const front = (a: number): boolean => Math.abs(Math.atan2(Math.sin(a + 0.14), Math.cos(a + 0.14))) < 0.85;
    // Rust beneath fascia/plinth rivets.
    for (let i = 0; i < 18; i++) {
      const a = rnd() * TAU;
      if (front(a)) continue;
      conform(bolts[i % 4], a - 0.07, a + 0.07, 2.7 + rnd() * 0.15, 3.38, 0.236);
    }
    for (let i = 0; i < 20; i++) {
      const a = rnd() * TAU;
      conform(bolts[i % 4], a - 0.06, a + 0.06, 0.1, 0.39, 0.212);
    }
    // Grime beneath ledges, sills and planter lips.
    for (const [a0, a1] of [
      [1.55, 2.35],
      [2.6, 3.45],
      [3.65, 4.4],
    ] as const)
      conform(grime[0], a0, a1, 1.2 + rnd() * 0.3, 2.45, 0.016);
    for (const [a0, a1] of [
      [-2, -1.2],
      [-1, -0.1],
      [0.15, 1.2],
      [1.6, 2.6],
      [3.4, 4.3],
    ] as const)
      conform(grime[1], a0, a1, 0.1, 0.57, 0.206);
    for (const [a0, a1] of [
      [-1.5, -0.55],
      [0.25, 0.62],
    ] as const)
      conform(grime[0], a0, a1, 0.04, 0.38, 0.735);
    // Flaking concentrates on weather-facing corners.
    for (let i = 0; i < 14; i++) {
      const a = rnd() * TAU,
        y = 2.55 + rnd() * 0.8;
      // Keep fascia lettering clear of paint flakes.
      if (front(a)) continue;
      conform(chipsSet[i % 3], a - 0.09, a + 0.09, y, y + 0.28, 0.238);
    }
    for (let i = 0; i < 8; i++) {
      const a = 1.4 + rnd() * 3.1,
        y = 0.8 + rnd() * 1.4;
      conform(chipsSet[i % 3], a - 0.1, a + 0.1, y, y + 0.3, 0.02);
    }
    // Contact wear on walls and steps.
    const sheet = (
      mat: THREE.Material,
      w: number,
      h: number,
      at: readonly [number, number, number],
      parent: THREE.Object3D,
      ry: number = 0,
      rx: number = 0,
    ): void => {
      const m = mesh(new THREE.PlaneGeometry(w, h), mat, at, parent, false);
      m.rotation.set(rx, ry, 0);
      m.renderOrder = 1;
    };
    sheet(d("scratches", 10), 0.3, 0.4, [-0.35, 1.3, 0.772], wing);
    sheet(d("scuff", 11), 0.6, 0.4, [-0.08, 0.75, 0.773], wing);
    sheet(d("scuff", 12), 1.4, 0.55, [-0.08, 0.224, 1.42], wing, 0, -Math.PI / 2);
    sheet(d("scuff", 13), 1, 0.45, [-0.08, 0.364, 1.15], wing, 0, -Math.PI / 2);
    sheet(d("scuff", 16), 0.7, 0.35, [-0.08, 0.504, 0.92], wing, 0, -Math.PI / 2);
    sheet(chipsSet[0], 0.3, 0.3, [-0.72, 1.75, 1.278], wing);
    sheet(chipsSet[1], 0.35, 0.25, [-0.66, 0.4, 1.278], wing);
    sheet(grime[1], 1, 0.9, [-0.08, 2.25, 0.705], wing);
    sheet(d("bolts2", 15), 0.5, 0.8, [0.45, 2.4, 0.706], wing);
    // Foot-traffic wear toward the door.
    for (const [x, z, r, w] of [
      [0.2, 3.6, 0.2, 1.6],
      [1.1, 3, -0.6, 1.3],
      [2, 2.2, -0.9, 1.1],
      [-0.6, 3.4, 0.4, 1.2],
    ] as const) {
      const m = mesh(
        new THREE.PlaneGeometry(w, w * 0.55),
        d("scuff", 20 + Math.round(x * 10)),
        [x, DECK_Y + 0.004, z],
        station,
        false,
      );
      m.rotation.set(-Math.PI / 2, 0, r);
      m.renderOrder = 1;
    }
    for (const [x, z, s] of [
      [-2.6, -0.6, 1],
      [2.9, -2.6, 0.8],
      [-1, -3.9, 0.9],
    ] as const) {
      const m = mesh(
        new THREE.PlaneGeometry(s, s),
        d("rust", 30 + Math.round(x * 10)),
        [x, DECK_Y + 0.004, z],
        station,
        false,
      );
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 1;
    }

    for (let i = 0; i < 10; i++) {
      const a = rnd() * TAU;
      const m = mesh(
        new THREE.CylinderGeometry(5.235, 5.235, 0.3, 12, 1, true, a, 0.28),
        d("verdigris", 40 + i),
        [0, 0.19, 0],
        station,
        false,
      );
      m.renderOrder = 1;
      (m.material as THREE.MeshStandardMaterial).side = THREE.FrontSide;
    }
  }
}
