import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StationController, StationView } from "./scene.client";

type TourView = Extract<StationView, "hero" | "studio" | "entrance" | "rear" | "atom" | "mast" | "top" | "orbit">;

const TOUR: ReadonlyArray<readonly [TourView, string, boolean]> = [
  ["hero", "Hero", false],
  ["studio", "Studio", false],
  ["entrance", "Entrance", false],
  ["rear", "Steamworks", false],
  ["atom", "Atom", false],
  ["mast", "Mast", false],
  ["top", "Top", true],
  ["orbit", "Orbit", false],
];

const DISPLAY_FONT = "Oswald, 'Arial Narrow', sans-serif";

/** The interactive ON AIR station. Loads the Three.js scene lazily (on phones only once it nears the
    viewport), keeps the page usable when WebGL is missing, and offers a tour of the model. */
export function Station(): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<StationController | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [view, setView] = useState<TourView>("hero");
  const [moving, setMoving] = useState<boolean>(true);
  const [lit, setLit] = useState<boolean>(true);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const wide: MediaQueryList = window.matchMedia("(min-width: 701px)");
    const reduced: MediaQueryList = window.matchMedia("(prefers-reduced-motion: reduce)");
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
        setMoving(!reduced.matches);
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
      setMoving(!reduced.matches);
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
      {status === "ready" && (
        <fieldset className="landing-tour" aria-label="Explore the station">
          {TOUR.map(([name, label, wideOnly]: readonly [TourView, string, boolean]) => (
            <button
              type="button"
              key={name}
              className={wideOnly ? "landing-wide" : undefined}
              aria-pressed={view === name}
              onClick={() => {
                controller.current?.view(name);
                setView(name);
              }}
            >
              {label}
            </button>
          ))}
          <span className="landing-sep landing-wide" aria-hidden="true" />
          <button
            type="button"
            className="landing-wide"
            aria-pressed={moving}
            onClick={() => {
              controller.current?.motion(!moving);
              setMoving(!moving);
            }}
          >
            Motion
          </button>
          <button
            type="button"
            className="landing-wide"
            aria-pressed={lit}
            onClick={() => {
              controller.current?.lights(!lit);
              setLit(!lit);
            }}
          >
            Lights
          </button>
        </fieldset>
      )}
    </>
  );
}
