import * as THREE from "three";

/* Look-around: the camera leans around the station as the phone tilts (gyroscope) or the mouse moves,
   on top of wherever orbit drag has put it. The lean is applied just for the render and then undone,
   so OrbitControls never sees it and nothing accumulates. */

/** Gyroscope lean follows the phone one to one, so the station feels like a real object held in the
    hand: turn the phone 30 degrees and the view swings 30 degrees around it. The lean only eases off
    softly near these limits, in radians (about 80 degrees sideways and 70 degrees up and down). */
const GYRO_YAW = 1.4;
const GYRO_PITCH = 1.2;
/** Seconds for the resting grip to catch up with how the phone is held. Slow, so a held tilt stays put
    while you look, yet lying down or changing hands re-centres the view within a few breaths. */
const GRIP_SETTLE = 15;
/** How quickly the lean catches up, per second: quick for the gyroscope so it feels attached. */
const GYRO_FOLLOW = 14;
const MOUSE_FOLLOW = 6;
/** Mouse lean is gentler: it is always there while the pointer is over the page. */
const MOUSE_YAW = 0.12;
const MOUSE_PITCH = 0.06;
/** Keep the camera just off the poles, as orbit drag does, so it never flips over the top. */
const POLE = 0.05;
const DEG = Math.PI / 180;

/** Linear near zero, easing to at most `max`. */
const soften = (v: number, max: number): number => max * Math.tanh(v / max);
/** Shortest signed difference between two angles in degrees, so wrapping past 180 does not jump. */
const turn = (a: number, b: number): number => ((((a - b + 180) % 360) + 360) % 360) - 180;

export interface Look {
  /** Ease toward the latest tilt or pointer; returns true while the lean is still moving. With motion
      off (reduced motion) the lean is dropped at once. */
  step: (dt: number, enabled: boolean) => boolean;
  /** Lean the camera for this frame. Call `restore` after rendering. */
  apply: (camera: THREE.PerspectiveCamera, target: THREE.Vector3) => void;
  restore: (camera: THREE.PerspectiveCamera, target: THREE.Vector3) => void;
}

export function createLook(wrap: HTMLElement, signal: AbortSignal): Look {
  const goal = { yaw: 0, pitch: 0 };
  const now = { yaw: 0, pitch: 0 };
  const saved = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let gyro = false;
  let base: { beta: number; gamma: number } | null = null;
  let reading = { beta: 0, gamma: 0 };

  wrap.addEventListener(
    "pointermove",
    (e: PointerEvent): void => {
      if (e.pointerType !== "mouse" || gyro) return;
      const r = wrap.getBoundingClientRect();
      goal.yaw = (((e.clientX - r.left) / r.width) * 2 - 1) * MOUSE_YAW;
      goal.pitch = (((e.clientY - r.top) / r.height) * 2 - 1) * MOUSE_PITCH;
    },
    { signal },
  );
  wrap.addEventListener(
    "pointerleave",
    (): void => {
      if (gyro) return;
      goal.yaw = 0;
      goal.pitch = 0;
    },
    { signal },
  );

  globalThis.addEventListener?.(
    "deviceorientation",
    (e: DeviceOrientationEvent): void => {
      if (e.beta === null || e.gamma === null) return;
      gyro = true;
      // In landscape the axes swap, so lean always follows the screen, not the device.
      const angle = globalThis.screen?.orientation?.angle ?? 0;
      const turned = angle === 90 || angle === -90 || angle === 270;
      const sign = angle === 90 ? 1 : -1;
      reading = turned ? { beta: e.gamma * sign, gamma: e.beta * -sign } : { beta: e.beta, gamma: e.gamma };
      base ??= { ...reading };
    },
    { signal },
  );

  // On iOS motion arrives only once the person allows it from the station's tilt button (tilt.ts).

  return {
    step: (dt: number, enabled: boolean): boolean => {
      if (!enabled) {
        const was = now.yaw !== 0 || now.pitch !== 0;
        now.yaw = 0;
        now.pitch = 0;
        return was;
      }
      if (gyro && base) {
        // The resting angle drifts slowly toward however the phone is held, so any grip feels neutral.
        const drift = 1 - Math.exp(-dt / GRIP_SETTLE);
        base.beta += turn(reading.beta, base.beta) * drift;
        base.gamma += turn(reading.gamma, base.gamma) * drift;
        goal.yaw = -soften(turn(reading.gamma, base.gamma) * DEG, GYRO_YAW);
        // Tipping the top of the phone away lifts the view over the station, like peering down into it.
        goal.pitch = -soften(turn(reading.beta, base.beta) * DEG, GYRO_PITCH);
      }
      const k = 1 - Math.exp(-dt * (gyro ? GYRO_FOLLOW : MOUSE_FOLLOW));
      const dy = goal.yaw - now.yaw;
      const dp = goal.pitch - now.pitch;
      now.yaw += dy * k;
      now.pitch += dp * k;
      return Math.abs(dy) + Math.abs(dp) > 1e-4;
    },
    apply: (camera: THREE.PerspectiveCamera, target: THREE.Vector3): void => {
      saved.copy(camera.position);
      offset.copy(camera.position).sub(target);
      right.crossVectors(up, offset).normalize();
      // A positive pitch lowers the camera; stop the lean short of either pole so it never tips over.
      // The bounds always include zero, so a view already near a pole (the top preset) stays put.
      const polar = Math.acos(Math.max(-1, Math.min(1, offset.y / offset.length())));
      const pitch = Math.max(Math.min(0, POLE - polar), Math.min(Math.max(0, Math.PI - POLE - polar), now.pitch));
      offset.applyAxisAngle(up, now.yaw).applyAxisAngle(right.applyAxisAngle(up, now.yaw), pitch);
      camera.position.copy(target).add(offset);
      camera.lookAt(target);
      camera.updateMatrixWorld();
    },
    restore: (camera: THREE.PerspectiveCamera, target: THREE.Vector3): void => {
      camera.position.copy(saved);
      camera.lookAt(target);
      camera.updateMatrixWorld();
    },
  };
}
