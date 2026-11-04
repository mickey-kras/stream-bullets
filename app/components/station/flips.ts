import * as THREE from "three";

/* The mast signs spin once on their arms when the pointer moves onto them, or when one is tapped. Each sign turns
   on its own, finishes its turn before it can start another, and only turns again after the pointer
   has left it and come back. */

const FLIP_SECONDS = 1.1;
/** A tap is a touch that lifts within this time and distance; anything longer is an orbit drag. */
const TAP_MS = 400;
const TAP_PX = 10;

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Sign {
  pivot: THREE.Group;
  /** Seconds into the current turn, or -1 at rest. */
  turn: number;
  hovered: boolean;
}

export interface Flips {
  /** Advance turns and check what the pointer is over; returns true while any sign is turning. */
  update: (camera: THREE.Camera, dt: number, enabled: boolean) => boolean;
}

function advanceTurns(signs: readonly Sign[], dt: number): boolean {
  let turning = false;
  for (const s of signs) {
    if (s.turn < 0) continue;
    s.turn += dt;
    const t = Math.min(s.turn / FLIP_SECONDS, 1);
    // The sign turns on its arm, like a wheel on an axle: the arm meets the back square-on, along z.
    s.pivot.rotation.z = -ease(t) * Math.PI * 2;
    if (t >= 1) {
      s.pivot.rotation.z = 0;
      s.turn = -1;
    } else turning = true;
  }
  return turning;
}

export function createFlips(
  pivots: readonly THREE.Group[],
  wrap: HTMLElement,
  canvas: HTMLElement,
  signal: AbortSignal,
): Flips {
  const signs: Sign[] = pivots.map((pivot: THREE.Group): Sign => ({ pivot, turn: -1, hovered: false }));
  const ray = new THREE.Raycaster();
  let hover: THREE.Vector2 | null = null;
  let tap: THREE.Vector2 | null = null;
  let down: { x: number; y: number; at: number } | null = null;

  const ndc = (e: PointerEvent): THREE.Vector2 => {
    const r = wrap.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  wrap.addEventListener(
    "pointermove",
    (e: PointerEvent): void => {
      if (e.pointerType === "mouse") hover = ndc(e);
    },
    { signal },
  );
  wrap.addEventListener(
    "pointerleave",
    (): void => {
      hover = null;
    },
    { signal },
  );
  wrap.addEventListener(
    "pointerdown",
    (e: PointerEvent): void => {
      if (e.pointerType !== "mouse") down = { x: e.clientX, y: e.clientY, at: e.timeStamp };
    },
    { signal },
  );
  wrap.addEventListener(
    "pointerup",
    (e: PointerEvent): void => {
      if (!down) return;
      const quick = e.timeStamp - down.at < TAP_MS;
      const still = Math.hypot(e.clientX - down.x, e.clientY - down.y) < TAP_PX;
      if (quick && still) tap = ndc(e);
      down = null;
    },
    { signal },
  );

  const signAt = (camera: THREE.Camera, at: THREE.Vector2): Sign | undefined => {
    ray.setFromCamera(at, camera);
    const hit = ray.intersectObjects([...pivots], true)[0];
    if (!hit) return undefined;
    return signs.find((s: Sign): boolean => {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) if (o === s.pivot) return true;
      return false;
    });
  };
  const start = (s: Sign | undefined): void => {
    if (s && s.turn < 0) s.turn = 0;
  };

  return {
    update: (camera: THREE.Camera, dt: number, enabled: boolean): boolean => {
      if (enabled) {
        const over = hover ? signAt(camera, hover) : undefined;
        for (const s of signs) {
          const now = s === over;
          if (now && !s.hovered) start(s);
          s.hovered = now;
        }
        canvas.style.cursor = over ? "pointer" : "";
        if (tap) start(signAt(camera, tap));
      }
      tap = null;
      return advanceTurns(signs, dt);
    },
  };
}
