import { useSyncExternalStore } from "react";
import { motionReduced, watchMotion } from "../station/motion";

function subscribeMotion(onChange: () => void): () => void {
  const stop = new AbortController();
  watchMotion((): void => onChange(), stop.signal);
  return (): void => stop.abort();
}

/**
 * The page's effective reduced-motion setting (the site's Motion preference, or the OS setting), kept current.
 * False on the server and before the first effect.
 */
export function useMotionReduced(): boolean {
  return useSyncExternalStore(subscribeMotion, motionReduced, (): boolean => false);
}
