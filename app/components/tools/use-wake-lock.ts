import { useEffect, useState, useSyncExternalStore } from "react";

/** "on": the screen stays on. "off": the browser has the feature and did not give the lock. */
export type WakeLockState = "on" | "off" | "unsupported";

function noSubscription(): () => void {
  return (): void => undefined;
}

function hasWakeLock(): boolean {
  return "wakeLock" in navigator;
}

/**
 * Keeps the screen on while `active`, with the Screen Wake Lock API. The browser takes the lock away when the page is
 * hidden: the hook asks again when the page shows again. It releases the lock when `active` ends.
 */
export function useWakeLock(active: boolean): WakeLockState {
  // The server does not know the browser: it renders as a browser with the feature, so no note flashes.
  const supported: boolean = useSyncExternalStore(noSubscription, hasWakeLock, (): boolean => true);
  const [held, setHeld] = useState<boolean>(false);
  useEffect(() => {
    if (!active || !supported) return;
    let sentinel: WakeLockSentinel | null = null;
    let ended = false;
    async function take(): Promise<void> {
      if (document.visibilityState !== "visible") return;
      try {
        const next: WakeLockSentinel = await navigator.wakeLock.request("screen");
        if (ended) {
          await next.release();
          return;
        }
        sentinel = next;
        next.addEventListener("release", (): void => setHeld(false));
        setHeld(true);
      } catch {
        // The browser refuses the lock on a low battery or in a power-saving mode.
        setHeld(false);
      }
    }
    const shown = (): void => {
      void take();
    };
    void take();
    document.addEventListener("visibilitychange", shown);
    return (): void => {
      ended = true;
      document.removeEventListener("visibilitychange", shown);
      if (sentinel) void sentinel.release();
    };
  }, [active, supported]);
  if (!supported) return "unsupported";
  return active && held ? "on" : "off";
}
