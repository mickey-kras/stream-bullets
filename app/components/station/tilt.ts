/* Motion access for the tilt effect. iOS reports device orientation only after the person allows it,
   and Safari shows that question only from a tap on something the page offers, so the station shows a
   small "tilt" button while access is still needed. A refusal is remembered on this device, so the
   button does not keep coming back; an allowed visit simply starts receiving motion and hides it. */

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

/** True when this browser needs a tap before it reports motion and the person has not said no here. */
export function tiltNeedsAsking(): boolean {
  return typeof orientationApi()?.requestPermission === "function" && !remembered();
}

/** Ask for motion access. Call only from a tap handler. Resolves to the browser's answer. */
export async function askForTilt(): Promise<PermissionState> {
  const ask = orientationApi()?.requestPermission;
  if (!ask) return "granted";
  const answer = await ask.call(orientationApi());
  if (answer === "denied") {
    try {
      globalThis.localStorage?.setItem(DECLINED, "1");
    } catch {
      // Storage can be blocked (private browsing); the button then simply returns next visit.
    }
  }
  return answer;
}

/** Calls `onMotion` once, as soon as real orientation data arrives (access already allowed). */
export function onFirstMotion(onMotion: () => void): () => void {
  const listener = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;
    globalThis.removeEventListener?.("deviceorientation", listener);
    onMotion();
  };
  globalThis.addEventListener?.("deviceorientation", listener);
  return (): void => globalThis.removeEventListener?.("deviceorientation", listener);
}
