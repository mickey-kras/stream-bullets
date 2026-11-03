import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StationController } from "./scene.client";

type View = "hero" | "studio" | "rear" | "orbit";

export function Station(): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<StationController | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [view, setView] = useState<View>("hero");
  const [moving, setMoving] = useState<boolean>(false);
  const [lit, setLit] = useState<boolean>(true);

  useEffect(() => {
    const desktop: MediaQueryList = window.matchMedia("(min-width: 701px)");
    const reduced: MediaQueryList = window.matchMedia("(prefers-reduced-motion: reduce)");
    let generation: number = 0;
    let disposed: boolean = false;
    function release(): void {
      controller.current?.dispose();
      controller.current = null;
    }
    async function update(): Promise<void> {
      const current: number = ++generation;
      release();
      if (!desktop.matches) return;
      setStatus("loading");
      try {
        const [scene] = await Promise.all([import("./scene.client"), document.fonts.ready]);
        if (disposed || current !== generation || !host.current) return;
        controller.current = scene.createStation(host.current, () => {
          release();
          setStatus("unavailable");
        });
        controller.current.motion(!reduced.matches);
        setMoving(!reduced.matches);
        setView("hero");
        setLit(true);
        setStatus("ready");
      } catch {
        if (disposed || current !== generation) return;
        release();
        setStatus("unavailable");
      }
    }
    function resize(): void { void update(); }
    function preference(): void {
      setMoving(!reduced.matches);
      controller.current?.motion(!reduced.matches);
    }
    desktop.addEventListener("change", resize);
    reduced.addEventListener("change", preference);
    void update();
    return () => {
      disposed = true;
      generation++;
      desktop.removeEventListener("change", resize);
      reduced.removeEventListener("change", preference);
      release();
    };
  }, []);

  return (
    <section className="landing-station" aria-label="Interactive broadcast station">
      <div className="landing-canvas" ref={host} />
      {status !== "ready" && <p className="station-status" role="status">{status === "loading" ? "Tuning the signal…" : "The station preview is unavailable. You can still explore streamers and join the conversation."}</p>}
      {status === "ready" && (
        <details className="station-controls">
          <summary>3D controls</summary>
          <div role="group" aria-label="Station camera">
            {(["hero", "studio", "rear", "orbit"] as const).map((name: View) => (
              <button type="button" key={name} aria-pressed={view === name} onClick={() => { controller.current?.view(name); setView(name); }}>{name}</button>
            ))}
            <button type="button" aria-pressed={moving} onClick={() => { controller.current?.motion(!moving); setMoving(!moving); }}>{moving ? "Pause motion" : "Play motion"}</button>
            <button type="button" aria-pressed={lit} onClick={() => { controller.current?.lights(!lit); setLit(!lit); }}>{lit ? "Lights on" : "Lights off"}</button>
          </div>
        </details>
      )}
    </section>
  );
}
