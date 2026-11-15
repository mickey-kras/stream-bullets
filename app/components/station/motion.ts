/**
 * The page's effective Motion setting. The head script (app/lib/prefs.ts) folds the person's choice with the
 * OS query into `html[data-reduced]` and keeps it current, so the station follows that, not the media query
 * alone: "Reduce" stops the scene, and "Full" plays it even when the OS asks for reduced motion.
 */
export function motionReduced(): boolean {
  const flag: string | undefined = globalThis.document?.documentElement?.dataset.reduced;
  if (flag !== undefined) return flag === "true";
  // Without the head script, fall back to the OS setting.
  return (
    typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Calls `listener` with the effective value whenever `html[data-reduced]` changes, until the signal aborts. */
export function watchMotion(listener: (reduced: boolean) => void, signal: AbortSignal): void {
  const root: HTMLElement | undefined = globalThis.document?.documentElement ?? undefined;
  if (!root || typeof MutationObserver !== "function") return;
  let last: boolean = motionReduced();
  const observer = new MutationObserver((): void => {
    const next: boolean = motionReduced();
    if (next === last) return;
    last = next;
    listener(next);
  });
  observer.observe(root, { attributes: true, attributeFilter: ["data-reduced"] });
  signal.addEventListener("abort", (): void => observer.disconnect(), { once: true });
}
