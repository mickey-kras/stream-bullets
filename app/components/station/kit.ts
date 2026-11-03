import * as THREE from "three";
import { createPalette } from "./palette";
import { add, ball, box, cyl, frond, mesh, rod, TAU, torus, type P } from "./shapes";
import * as T from "./textures";

export type Animator = (time: number, dt: number) => void;
export type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

/**
 * Shared state for building and running the station: the palette, the registries the render loop and the
 * lights switch walk, and helpers that need either. Built once per station and passed to every part.
 */
export function createKit(compact: boolean, family: string) {
  const palette = createPalette(compact);
  const { brass, gold, red, plantGreen, plantDark } = palette;
  const glowTexture = T.glow();
  const psiFace = T.dial(false);
  const vuFace = T.dial(true);
  const kit = {
    ...palette,
    compact,
    family,
    illuminated: true,
    animators: [] as Animator[],
    repaints: [] as Array<() => void>,
    emissives: [...palette.lit],
    halos: [] as Array<[THREE.Sprite, number]>,
    practicals: [] as Array<[THREE.PointLight, number]>,
    /** Extra work for the lights switch, registered by the parts that own it. */
    onLights: [] as Array<(on: boolean) => void>,

    /** Soft additive glow around a light source. */
    halo(at: P, size: number, color: string, opacity: number, parent: THREE.Object3D): THREE.Sprite {
      const material = new THREE.SpriteMaterial({
        map: glowTexture,
        color,
        transparent: true,
        opacity: opacity * 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const s = new THREE.Sprite(material);
      s.position.set(at[0], at[1], at[2]);
      s.scale.set(size * 0.75, size * 0.75, 1);
      parent.add(s);
      kit.halos.push([s, opacity * 0.7]);
      return s;
    },
    /** Point light that goes dark with the lights switch. power is [intensity, distance]. */
    practical(color: string, power: readonly [number, number], at: P, parent: THREE.Object3D): THREE.PointLight {
      const l = new THREE.PointLight(color, power[0], power[1], 2);
      l.position.set(at[0], at[1], at[2]);
      parent.add(l);
      kit.practicals.push([l, power[0]]);
      return l;
    },
    /** Painted canvas label that repaints when the typeface changes. size is [width, height]. */
    label(
      draw: Draw,
      size: readonly [number, number],
      at: P,
      parent: THREE.Object3D,
      glowing = 0.1,
      px = 1024,
    ): THREE.Mesh {
      const [w, h] = size;
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = Math.round((px * h) / w);
      const ctx = canvas.getContext("2d")!;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      const paint = (): void => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        draw(ctx, canvas.width, canvas.height);
        tex.needsUpdate = true;
      };
      paint();
      kit.repaints.push(paint);
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        transparent: true,
        roughness: 0.55,
        emissive: "#ffffff",
        emissiveMap: tex,
        emissiveIntensity: glowing,
      });
      if (glowing > 0.5) kit.emissives.push([mat, glowing]);
      return mesh(new THREE.PlaneGeometry(w, h), mat, at, parent, false);
    },
    /** A clump of leaves. */
    plant(at: P, count: number, length: number, parent: THREE.Object3D, seed: number): void {
      const rnd = T.random(seed);
      for (let i = 0; i < count; i++) {
        const base: P = [at[0] + (rnd() - 0.5) * 0.08, at[1], at[2] + (rnd() - 0.5) * 0.08];
        const angle = rnd() * TAU;
        const shape = [length * (0.7 + rnd() * 0.5), 0.05 + rnd() * 0.03, 0.55 + rnd() * 0.5] as const;
        frond(base, angle, shape, rnd() > 0.5 ? plantGreen : plantDark, parent);
      }
    },
    /** Round instrument with a twitching needle; amber gauges are backlit VU meters. */
    gauge(at: P, rot: number, size: number, parent: THREE.Object3D, amber = false): void {
      const g = add(new THREE.Group(), parent);
      g.position.set(at[0], at[1], at[2]);
      g.rotation.y = rot;
      cyl([size * 1.1, size * 1.15, 0.06], [0, 0, 0], brass, g, [32]).rotation.x = Math.PI / 2;
      torus([size * 1.08, size * 0.1], [0, 0, 0.035], gold, g, false);
      const faceMaterial = new THREE.MeshStandardMaterial({
        map: amber ? vuFace : psiFace,
        roughness: 0.4,
        emissive: amber ? "#ffb24a" : "#000000",
        emissiveMap: amber ? vuFace : null,
        emissiveIntensity: amber ? 1.2 : 0,
      });
      mesh(new THREE.CircleGeometry(size, 32), faceMaterial, [0, 0, 0.032], g, false);
      if (amber) kit.emissives.push([faceMaterial, 1.2]);
      const needle = add(new THREE.Group(), g);
      needle.position.set(0, -size * 0.15, 0.04);
      box(
        [size * 0.04, size * 0.85, 0.006],
        [0, size * 0.42, 0],
        new THREE.MeshBasicMaterial({ color: "#7a1408" }),
        needle,
        0.002,
      );
      const seed = Math.random() * 10;
      const [speed, swing, jitter, rest] = amber ? [5.3, 0.45, 0.2, 0] : [0.7, 0.12, 0.02, -0.3];
      kit.animators.push((t: number): void => {
        needle.rotation.z = Math.sin(t * speed + seed) * swing + Math.sin(t * 11.7 + seed) * jitter + rest;
      });
    },
    /** Red hand-wheel valve. */
    valve(at: P, rot: THREE.Euler, size: number, parent: THREE.Object3D): void {
      const g = add(new THREE.Group(), parent);
      g.position.set(at[0], at[1], at[2]);
      g.rotation.copy(rot);
      cyl([size * 0.25, size * 0.25, size * 0.7], [0, -size * 0.35, 0], brass, g, [12]);
      torus([size, size * 0.12], [0, 0, 0], red, g);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU;
        rod(
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(Math.cos(a) * size, 0, Math.sin(a) * size),
          size * 0.07,
          red,
          g,
          6,
        );
      }
      ball(size * 0.2, [0, 0, 0], gold, g, 12);
    },
  };
  return kit;
}

export type Kit = ReturnType<typeof createKit>;
