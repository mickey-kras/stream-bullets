// iOS motion permission requires a user tap. Show Tilt until granted; remember refusals to avoid repeated
// prompts.

type Orientation = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<PermissionState> };

const DECLINED = "stream-bullets:tilt-declined";

function orientationApi(): Orientation | undefined {
  return (globalThis as { DeviceOrientationEvent?: Orientation }).DeviceOrientationEvent;
}

function remembered(): boolean {
  try {
    return globalThis.localStorage?.getItem(DECLINED) === "1";
  } catch {
    return false;
  }
}

// Needs user permission and has no stored refusal.
export function tiltNeedsAsking(): boolean {
  return typeof orientationApi()?.requestPermission === "function" && !remembered();
}

// Request motion permission only from a tap handler.
export async function askForTilt(): Promise<PermissionState> {
  const ask = orientationApi()?.requestPermission;
  if (!ask) return "granted";
  const answer = await ask.call(orientationApi());
  if (answer === "denied") {
    try {
      globalThis.localStorage?.setItem(DECLINED, "1");
    } catch {
      // Blocked storage may restore the prompt next visit.
    }
  }
  return answer;
}

// Call once when real orientation data arrives.
export function onFirstMotion(onMotion: () => void): () => void {
  const listener = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;
    globalThis.removeEventListener?.("deviceorientation", listener);
    onMotion();
  };
  globalThis.addEventListener?.("deviceorientation", listener);
  return (): void => globalThis.removeEventListener?.("deviceorientation", listener);
}

// Offer Tilt only on coarse, non-hover devices requiring requestPermission, without a stored refusal. Never
// on desktop/Android.
export function tiltPillWanted(): boolean {
  const touch: boolean =
    typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(hover: none) and (pointer: coarse)").matches;
  return touch && tiltNeedsAsking();
}
