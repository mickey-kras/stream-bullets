import * as THREE from "three";

// Hover flips once until pointer exit; taps/clicks activate after the current flip ends. onActivate receives
// the sign index for directory navigation.

const FLIP_SECONDS = 1.1;
// Tap time/distance bounds distinguish orbit drags.
const TAP_MS = 400;
const TAP_PX = 10;

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Sign {
  pivot: THREE.Group;
  // Turn elapsed seconds; -1 at rest.
  turn: number;
  hovered: boolean;
  // Activate after the current turn.
  pending: boolean;
}

export interface Flips {
  // Advance turns/hit testing; return whether animating.
  update: (camera: THREE.Camera, dt: number, enabled: boolean) => boolean;
}

function advanceTurns(signs: readonly Sign[], dt: number, done: (sign: Sign) => void): boolean {
  let turning = false;
  for (const s of signs) {
    if (s.turn < 0) continue;
    s.turn += dt;
    const t = Math.min(s.turn / FLIP_SECONDS, 1);
    // Positive local-x rotation rolls the top edge toward the viewer.
    s.pivot.rotation.x = ease(t) * Math.PI * 2;
    if (t >= 1) {
      s.pivot.rotation.x = 0;
      s.turn = -1;
      done(s);
    } else turning = true;
  }
  return turning;
}

export function createFlips(
  pivots: readonly THREE.Group[],
  wrap: HTMLElement,
  canvas: HTMLElement,
  signal: AbortSignal,
  onActivate?: (index: number) => void,
): Flips {
  const signs: Sign[] = pivots.map((pivot: THREE.Group): Sign => ({ pivot, turn: -1, hovered: false, pending: false }));
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
      // Mouse clicks activate; drags orbit.
      if (e.pointerType !== "mouse" || e.button === 0) down = { x: e.clientX, y: e.clientY, at: e.timeStamp };
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
  const activated = (s: Sign): void => {
    if (!s.pending) return;
    s.pending = false;
    onActivate?.(signs.indexOf(s));
  };

  return {
    update: (camera: THREE.Camera, dt: number, enabled: boolean): boolean => {
      // Show pointer cursor regardless of motion settings.
      const over = hover ? signAt(camera, hover) : undefined;
      for (const s of signs) {
        const now = s === over;
        if (enabled && now && !s.hovered) start(s);
        s.hovered = now;
      }
      canvas.style.cursor = over ? "pointer" : "";
      const tapped: Sign | undefined = tap ? signAt(camera, tap) : undefined;
      tap = null;
      if (tapped) {
        if (enabled) {
          start(tapped);
          tapped.pending = true;
        } else {
          // Reduced motion activates immediately.
          tapped.pending = true;
          activated(tapped);
        }
      }
      return advanceTurns(signs, dt, activated);
    },
  };
}
