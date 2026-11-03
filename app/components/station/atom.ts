import * as THREE from "three";
import type { Kit } from "./kit";
import { add, mesh, cyl, ball, torus, tube, polar, lathe, TAU, DECK_Y, profile } from "./shapes";

export function buildAtom(k: Kit, station: THREE.Group): void {
  const { brassSurface, brass, gold, red, animators } = k;
  // All brass: stepped base with a red enamel band, a tall cone ringed by blade spikes, a single
  // sphere nucleus and three wire orbits carrying brass electrons.
  const atom = add(new THREE.Group(), station);
  {
    atom.position.copy(polar(3.95, -0.98)).setY(DECK_Y);
    atom.scale.setScalar(1.2);
    const patina = new THREE.MeshStandardMaterial({
      map: brassSurface.map,
      roughnessMap: brassSurface.rough,
      color: "#a8c2a2",
      metalness: 0.75,
      roughness: 0.7,
    });
    lathe(
      profile(0, 0, 0.52, 0, 0.52, 0.06, 0.48, 0.08, 0.46, 0.1, 0.46, 0.16, 0.42, 0.17, 0, 0.17),
      brass,
      [0, 0, 0],
      atom,
      48,
    );
    cyl([0.39, 0.41, 0.17], [0, 0.255, 0], red, atom, [48]);
    torus([0.405, 0.018], [0, 0.18, 0], gold, atom);
    torus([0.395, 0.018], [0, 0.335, 0], gold, atom);
    lathe(profile(0, 0, 0.4, 0, 0.4, 0.04, 0.35, 0.05, 0, 0.05), brass, [0, 0.34, 0], atom, 48);
    lathe(profile(0, 0, 0.25, 0, 0.21, 0.2, 0.12, 0.65, 0.05, 1, 0.035, 1.05, 0, 1.05), gold, [0, 0.39, 0], atom, 40);
    for (let i = 0; i < 4; i++) {
      const t = (i / 4) * TAU + Math.PI / 4;
      const spike = mesh(
        new THREE.ConeGeometry(0.075, 0.62, 4),
        i % 2 ? patina : gold,
        [Math.cos(t) * 0.27, 0.39 + 0.31, Math.sin(t) * 0.27],
        atom,
      );
      spike.rotation.y = -t + Math.PI / 4;
      spike.rotation.z = Math.cos(t) * -0.08;
      spike.rotation.x = Math.sin(t) * 0.08;
      spike.scale.set(1, 1, 0.45);
    }
    cyl([0.018, 0.022, 0.32], [0, 1.56, 0], gold, atom, [10]);
    const core = add(new THREE.Group(), atom);
    core.position.y = 1.86;
    ball(0.19, [0, 0, 0], gold, core, 40);
    const orbits = add(new THREE.Group(), core);
    for (let i = 0; i < 3; i++) {
      const spin = add(new THREE.Group(), orbits);
      spin.rotation.z = (i * Math.PI) / 3 + 0.3;
      const plane = add(new THREE.Group(), spin);
      plane.rotation.x = 0.35 + i * 0.25;
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j < 72; j++) {
        const a2 = (j / 72) * TAU;
        pts.push(new THREE.Vector3(Math.cos(a2) * 0.62, Math.sin(a2) * 0.25, 0));
      }
      tube(pts, 0.011, gold, plane, true);
      const e = ball(0.038, [0.62, 0, 0], gold, plane, 16);
      const speed = 0.9 + i * 0.3,
        phase = i * 2.1;
      animators.push((t: number): void => {
        const a2 = t * speed + phase;
        e.position.set(Math.cos(a2) * 0.62, Math.sin(a2) * 0.25, 0);
      });
    }
    animators.push((t: number): void => {
      orbits.rotation.y = t * 0.2;
    });
  }
}
