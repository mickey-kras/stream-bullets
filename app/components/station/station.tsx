import { isbot } from "isbot";
import { useEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react";
import { t } from "../../i18n";
import { motionReduced, watchMotion } from "./motion";
import { askForTilt, onFirstMotion, tiltPillWanted } from "./tilt";
import type { StationController } from "./scene.client";

const DISPLAY_FONT = "Oswald, 'Arial Narrow', sans-serif";
// Phone poster pixels: width, height.
const PHONE_POSTER = [487, 557] as const;

// Crawlers and link verifiers keep the static poster without booting WebGL or showing a fallback error.
export function stationHost(element: HTMLDivElement | null): HTMLDivElement | null {
  if (isbot(globalThis.navigator?.userAgent ?? "")) return null;
  return element;
}

export function Station({ onSign }: Readonly<{ onSign?: (index: number) => void }> = {}): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<StationController | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  // The poster stays below the canvas until the canvas fade ends.
  const [stage, setStage] = useState<"poster" | "fade" | "live">("poster");
  // Hide Tilt after motion arrives or permission is answered.
  const [tiltDone, setTiltDone] = useState<boolean>(false);
  // Keep the one-time scene bound to the latest handler.
  const signHandler = useRef<typeof onSign>(onSign);
  useEffect(() => {
    signHandler.current = onSign;
  }, [onSign]);

  // Incoming motion proves permission; hide the button.
  useEffect(() => onFirstMotion((): void => setTiltDone(true)), []);

  useEffect(() => {
    if (!stationHost(host.current)) return;
    const wide: MediaQueryList = globalThis.matchMedia("(min-width: 701px)");
    const lifecycle = new AbortController();
    let disposed: boolean = false;
    function fail(): void {
      controller.current?.dispose();
      controller.current = null;
      if (!disposed) setStatus("unavailable");
    }
    // Phone content above the stage covers its top. The poster and the camera use the same value.
    function overlap(): number {
      const actions = document.querySelector(".landing-actions")?.getBoundingClientRect();
      const stageBox = host.current?.getBoundingClientRect();
      const covered: number = actions && stageBox ? Math.max(0, actions.top - stageBox.top) : 0;
      host.current?.parentElement?.style.setProperty("--station-overlap", `${covered}px`);
      return covered;
    }
    overlap();
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
          // Phone mast may overlap buttons above the stage.
          overlap,
          // Reduced motion swaps at once. Otherwise the canvas fades in above the poster.
          onFrame: (): void => setStage(motionReduced() ? "live" : "fade"),
        });
        // Discard completed builds after navigation.
        if (disposed) {
          station.dispose();
          return;
        }
        controller.current = station;
        station.motion(!motionReduced());
        setStatus("ready");
      } catch {
        if (!disposed) fail();
      }
    }
    void start();
    watchMotion((reduced: boolean): void => controller.current?.motion(!reduced), lifecycle.signal);
    return () => {
      disposed = true;
      lifecycle.abort();
      controller.current?.dispose();
      controller.current = null;
    };
  }, []);

  return (
    <section
      className="landing-station"
      aria-label={t("landing.station")}
      data-status={status}
      data-live={status === "ready" && stage !== "poster" ? "" : undefined}
    >
      {/* Rendered from the model at the first camera position: one frame for wide screens, one for phones. */}
      {!(status === "ready" && stage === "live") && (
        <picture>
          <source
            media="(max-width: 700px)"
            srcSet="/assets/station-poster-phone.webp"
            width={PHONE_POSTER[0]}
            height={PHONE_POSTER[1]}
          />
          <img
            className="station-poster"
            src="/assets/station-poster.webp"
            alt=""
            width="1024"
            height="1024"
            fetchPriority="high"
          />
        </picture>
      )}
      <div
        className="landing-canvas"
        ref={host}
        onTransitionEnd={(event: TransitionEvent<HTMLDivElement>): void => {
          if (event.target === event.currentTarget && event.propertyName === "opacity") setStage("live");
        }}
      />
      {/* Wait for browser readiness to preserve hydration equality. */}
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
        <div className="station-fallback">
          <output className="station-status">{t("landing.unavailable")}</output>
        </div>
      )}
    </section>
  );
}
