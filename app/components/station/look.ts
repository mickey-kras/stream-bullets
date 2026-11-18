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
  // Device attitude as a rotation. Beta and gamma alone flip when the phone is on its side or faces down.
  const attitude = new THREE.Euler();
  const reading = new THREE.Quaternion();
  const delta = new THREE.Quaternion();
  let base: THREE.Quaternion | null = null;
  let screenAngle = 0;

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
      // W3C order: alpha about Z, then beta about X, then gamma about Y.
      attitude.set(e.beta * DEG, e.gamma * DEG, (e.alpha ?? 0) * DEG, "ZXY");
      reading.setFromEuler(attitude);
      base ??= reading.clone();
      screenAngle = globalThis.screen?.orientation?.angle ?? 0;
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
        base.slerp(reading, 1 - Math.exp(-dt / GRIP_SETTLE));
        // Turn from the neutral grip, as a rotation vector on the phone's own axes. It is the same in each posture.
        delta.copy(base).invert().multiply(reading);
        const half = Math.acos(Math.min(1, Math.abs(delta.w)));
        const scale = (half < 1e-6 ? 2 : (2 * half) / Math.sin(half)) * Math.sign(delta.w || 1);
        const aboutX = delta.x * scale;
        const aboutY = delta.y * scale;
        // Swap axes in landscape to follow screen orientation.
        const turned = screenAngle === 90 || screenAngle === -90 || screenAngle === 270;
        const sign = screenAngle === 90 ? 1 : -1;
        goal.yaw = -soften(turned ? aboutX * -sign : aboutY, GYRO_YAW);
        // Tilting the phone top away raises the view.
        goal.pitch = -soften(turned ? aboutY * sign : aboutX, GYRO_PITCH);
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
