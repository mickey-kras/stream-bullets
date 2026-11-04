import * as THREE from "three";

/* Look-around: the camera leans around the station as the phone tilts (gyroscope) or the mouse moves,
   on top of wherever orbit drag has put it. The lean is applied just for the render and then undone,
   so OrbitControls never sees it and nothing accumulates. */

/** Furthest lean, in radians: about 20 degrees sideways and 10 degrees up and down. */
const MAX_YAW = 0.35;
const MAX_PITCH = 0.17;
/** Device tilt, in degrees, that gives the full lean. */
const FULL_TILT = 25;
/** Mouse lean is gentler: it is always there while the pointer is over the page. */
const MOUSE_YAW = 0.12;
const MOUSE_PITCH = 0.06;

const clamp = (v: number): number => Math.max(-1, Math.min(1, v));

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
        const drift = 1 - Math.exp(-dt / 4);
        base.beta += (reading.beta - base.beta) * drift;
        base.gamma += (reading.gamma - base.gamma) * drift;
        goal.yaw = -clamp((reading.gamma - base.gamma) / FULL_TILT) * MAX_YAW;
        goal.pitch = clamp((reading.beta - base.beta) / FULL_TILT) * MAX_PITCH;
      }
      const k = 1 - Math.exp(-dt * 6);
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
      offset.applyAxisAngle(up, now.yaw).applyAxisAngle(right.applyAxisAngle(up, now.yaw), now.pitch);
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
