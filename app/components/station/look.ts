import * as THREE from "three";

// Apply tilt/pointer lean only during rendering, then restore. OrbitControls never sees or accumulates it.
// Gyroscope lean is 1:1 near center, easing near limits (~80 degrees horizontal, 70 vertical).
const GYRO_YAW = 1.4;
const GYRO_PITCH = 1.2;
// Slow grip drift recenters after posture changes while preserving held tilts.
const GRIP_SETTLE = 15;
// Gyroscope response rate per second.
const GYRO_FOLLOW = 14;
const MOUSE_FOLLOW = 6;
// Gentler mouse lean while hovering.
const MOUSE_YAW = 0.12;
const MOUSE_PITCH = 0.06;
// Avoid camera pole crossings.
const POLE = 0.05;
const DEG = Math.PI / 180;

// Linear near zero; bounded by max.
const soften = (v: number, max: number): number => max * Math.tanh(v / max);
// Shortest signed degree difference across angle wrapping.
const turn = (a: number, b: number): number => ((((a - b + 180) % 360) + 360) % 360) - 180;

export interface Look {
  // Ease toward input; return whether moving. Reduced motion clears lean immediately.
  step: (dt: number, enabled: boolean) => boolean;
  // Apply frame lean; call restore after rendering.
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
      // Swap axes in landscape to follow screen orientation.
      const angle = globalThis.screen?.orientation?.angle ?? 0;
      const turned = angle === 90 || angle === -90 || angle === 270;
      const sign = angle === 90 ? 1 : -1;
      reading = turned ? { beta: e.gamma * sign, gamma: e.beta * -sign } : { beta: e.beta, gamma: e.gamma };
      base ??= { ...reading };
    },
    { signal },
  );

  // iOS events begin after Tilt permission.

  return {
    step: (dt: number, enabled: boolean): boolean => {
      if (!enabled) {
        const was = now.yaw !== 0 || now.pitch !== 0;
        now.yaw = 0;
        now.pitch = 0;
        return was;
      }
      if (gyro && base) {
        // Slowly adapt the neutral grip.
        const drift = 1 - Math.exp(-dt / GRIP_SETTLE);
        base.beta += turn(reading.beta, base.beta) * drift;
        base.gamma += turn(reading.gamma, base.gamma) * drift;
        goal.yaw = -soften(turn(reading.gamma, base.gamma) * DEG, GYRO_YAW);
        // Tilting the phone top away raises the view.
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
      // Positive pitch lowers the camera. Keep bounds short of poles and inclusive of zero so near-pole presets remain stable.
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
