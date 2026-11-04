import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StationController } from "./scene.client";

const DISPLAY_FONT = "Oswald, 'Arial Narrow', sans-serif";

/** The interactive ON AIR station. Loads the Three.js scene lazily (on phones only once it nears the
    viewport), keeps the page usable when WebGL is missing. */
export function Station(): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<StationController | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const wide: MediaQueryList = globalThis.matchMedia("(min-width: 701px)");
    const reduced: MediaQueryList = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
    let disposed: boolean = false;
    let started: boolean = false;
    function fail(): void {
      controller.current?.dispose();
      controller.current = null;
      if (!disposed) setStatus("unavailable");
    }
    async function start(): Promise<void> {
      if (started) return;
      started = true;
      try {
        const [scene] = await Promise.all([
          import("./scene.client"),
          document.fonts.load(`700 80px ${DISPLAY_FONT}`).catch((): FontFace[] => []),
        ]);
        if (disposed || !host.current) return;
        controller.current = scene.createStation(host.current, fail, {
          family: DISPLAY_FONT,
          shift: (width: number): number => (wide.matches && width > 900 ? 0.24 : 0),
        });
        controller.current.motion(!reduced.matches);
        setStatus("ready");
      } catch {
        if (!disposed) fail();
      }
    }
    // Phones fetch the scene only when it is about to scroll into view.
    const near = new IntersectionObserver(
      (entries: IntersectionObserverEntry[]): void => {
        if (entries.some((entry: IntersectionObserverEntry): boolean => entry.isIntersecting)) {
          near.disconnect();
          void start();
        }
      },
      { rootMargin: "200px" },
    );
    if (wide.matches) void start();
    else near.observe(element);
    function preference(): void {
      controller.current?.motion(!reduced.matches);
    }
    reduced.addEventListener("change", preference);
    return () => {
      disposed = true;
      near.disconnect();
      reduced.removeEventListener("change", preference);
      controller.current?.dispose();
      controller.current = null;
    };
  }, []);

  return (
    <>
      <div className="landing-station" aria-label="Interactive broadcast station">
        <div className="landing-canvas" ref={host} />
        {status !== "ready" && (
          <output className="station-status">
            {status === "loading"
              ? "Tuning the signal…"
              : "The station preview is unavailable. You can still explore streamers and join the conversation."}
          </output>
        )}
      </div>
    </>
  );
}
