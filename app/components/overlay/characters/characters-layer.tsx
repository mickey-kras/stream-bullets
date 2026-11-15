import { useEffect, useRef, type ReactNode } from "react";
import { motionReduced, watchMotion } from "../../station/motion";
import { WASTELAND_PLAYGROUND, type PlaygroundTheme } from "../wasteland/playground-theme";
import { createMemory, draw, type DrawOptions, type RenderMemory } from "./renderer";
import { loadAtlas, type Atlas } from "./sprites";
import type { PlaygroundView } from "./view";

/** Design pixels per layout cell. */
const CELL_DESIGN_PX = 120;

interface CharactersLayerProps {
  /** Layer size in layout cells. */
  columns: number;
  rows: number;
  /** The view to draw at a performance.now() time, or null for nothing. Called once per animation frame. */
  source: (now: number) => PlaygroundView | null;
  /** Texts of the test and paused badges. */
  badges: DrawOptions["badges"];
  /** Called once if the pictures do not load or the canvas cannot draw; the layer then stays empty. */
  onError: (error: Error) => void;
  theme?: PlaygroundTheme;
}

/** The character playground: one transparent canvas at design size, redrawn on every animation frame. */
export function CharactersLayer({
  columns,
  rows,
  source,
  badges,
  onError,
  theme = WASTELAND_PLAYGROUND,
}: Readonly<CharactersLayerProps>): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The loop reads the newest props without restarting.
  const latest = useRef({ source, badges, onError });
  useEffect((): void => {
    latest.current = { source, badges, onError };
  });

  useEffect(() => {
    const canvas: HTMLCanvasElement | null = canvasRef.current;
    if (!canvas) return;
    const stop = new AbortController();
    let reduced: boolean = motionReduced();
    watchMotion((next: boolean): void => {
      reduced = next;
    }, stop.signal);
    const memory: RenderMemory = createMemory();
    let frame = 0;
    const fail = (error: unknown): void => {
      if (stop.signal.aborted) return;
      stop.abort();
      latest.current.onError(error instanceof Error ? error : new Error(String(error)));
    };
    const ctx: CanvasRenderingContext2D | null = canvas.getContext("2d");
    if (!ctx) {
      fail(new Error("The browser gave no 2D canvas context for the character layer."));
      return;
    }
    loadAtlas(theme).then((atlas: Atlas): void => {
      const tick = (now: number): void => {
        if (stop.signal.aborted) return;
        try {
          const view: PlaygroundView | null = latest.current.source(now);
          if (view)
            draw(ctx, view, theme, atlas, now, memory, {
              reduced,
              badges: latest.current.badges,
            });
          else ctx.clearRect(0, 0, canvas.width, canvas.height);
          frame = requestAnimationFrame(tick);
        } catch (error: unknown) {
          fail(error);
        }
      };
      frame = requestAnimationFrame(tick);
    }, fail);
    return (): void => {
      stop.abort();
      cancelAnimationFrame(frame);
    };
  }, [theme]);

  return (
    <canvas
      ref={canvasRef}
      className="characters-layer"
      width={columns * CELL_DESIGN_PX}
      height={rows * CELL_DESIGN_PX}
      aria-hidden="true"
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        imageRendering: "pixelated",
      }}
    />
  );
}
