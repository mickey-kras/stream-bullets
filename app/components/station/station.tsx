import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { AtomLoader } from "./loader";
import { askForTilt, onFirstMotion, tiltPillWanted } from "./tilt";
import type { StationController } from "./scene.client";

const DISPLAY_FONT = "Oswald, 'Arial Narrow', sans-serif";

/** The interactive ON AIR station. Loads the Three.js scene straight away (it fills the landing), shows
    the atom while it loads, and keeps the page usable when WebGL is missing. */
export function Station({ onSign }: Readonly<{ onSign?: (index: number) => void }> = {}): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<StationController | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  /** Set once the tilt button is no longer wanted: motion arrived, or the person answered. */
  const [tiltDone, setTiltDone] = useState<boolean>(false);
  /** The latest sign handler, so the scene (built once) always calls the current one. */
  const signHandler = useRef<typeof onSign>(onSign);
  useEffect(() => {
    signHandler.current = onSign;
  }, [onSign]);

  // Motion arriving on its own means access is already allowed, so the button can go.
  useEffect(() => onFirstMotion((): void => setTiltDone(true)), []);

  useEffect(() => {
    if (!host.current) return;
    const wide: MediaQueryList = globalThis.matchMedia("(min-width: 701px)");
    const reduced: MediaQueryList = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
    let disposed: boolean = false;
    function fail(): void {
      controller.current?.dispose();
      controller.current = null;
      if (!disposed) setStatus("unavailable");
    }
    async function start(): Promise<void> {
      try {
        const [scene] = await Promise.all([
          import("./scene.client"),
          document.fonts.load(`700 80px ${DISPLAY_FONT}`).catch((): FontFace[] => []),
        ]);
        if (disposed || !host.current) return;
        const station = await scene.createStation(host.current, fail, {
          family: DISPLAY_FONT,
          shift: (width: number): number => (wide.matches && width > 900 ? 0.24 : 0),
          onSign: (index: number): void => signHandler.current?.(index),
          // On phones the copy overlaps the top of the stage; the mast may rise behind the buttons.
          overlap: (): number => {
            const actions = document.querySelector(".landing-actions")?.getBoundingClientRect();
            const stage = host.current?.getBoundingClientRect();
            return actions && stage ? Math.max(0, actions.top - stage.top) : 0;
          },
        });
        // The page may have moved on while the station was building.
        if (disposed) {
          station.dispose();
          return;
        }
        controller.current = station;
        station.motion(!reduced.matches);
        setStatus("ready");
      } catch {
        if (!disposed) fail();
      }
    }
    void start();
    function preference(): void {
      controller.current?.motion(!reduced.matches);
    }
    reduced.addEventListener("change", preference);
    return () => {
      disposed = true;
      reduced.removeEventListener("change", preference);
      controller.current?.dispose();
      controller.current = null;
    };
  }, []);

  return (
    <div className="landing-station" aria-label={t("landing.station")} data-status={status}>
      <div className="landing-canvas" ref={host} />
      {status === "loading" && <AtomLoader label={t("landing.tuning")} />}
      {/* Only after the station is ready (which happens in the browser), so server and client agree. */}
      {status === "ready" && !tiltDone && tiltPillWanted() && (
        <button
          type="button"
          className="station-tilt"
          onClick={(): void => {
            askForTilt()
              .then((answer: PermissionState): void => setTiltDone(answer !== "prompt"))
              .catch((): void => setTiltDone(false));
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <rect x="7" y="3" width="10" height="18" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M3 9c-1 2-1 4 0 6M21 9c1 2 1 4 0 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          Tilt to look around
        </button>
      )}
      {status === "unavailable" && (
        <output className="station-status">
          The station preview is unavailable. You can still sign in and join the conversation.
        </output>
      )}
    </div>
  );
}
