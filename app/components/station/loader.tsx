import { useEffect, useRef, type ReactNode } from "react";

/* Loading indicator for the station: an atom drawn on three stacked 2D canvases. The bottom layer holds
   the faint orbits, the middle layer the glowing trails, which fade a little every frame so a particle
   leaves a dying comet tail rather than a fixed line, and the top layer the hot particle heads. */

const SIZE = 240;
const A = 84;
const B = 27;
const TAU = Math.PI * 2;
/** Tilt, speed (radians per second of the orbit parameter) and starting phase of each electron. */
const ELECTRONS = [
  { tilt: Math.PI / 2, speed: 5.2, phase: 0.3 },
  { tilt: Math.PI / 6, speed: 4.6, phase: 2.4 },
  { tilt: -Math.PI / 6, speed: 4.9, phase: 4.3 },
] as const;
type Electron = (typeof ELECTRONS)[number];

/** Warped orbit parameter: fast through the long straight runs, slow round the tight ends. */
const warp = (u: number): number => u - 0.32 * Math.sin(2 * u);

function at(e: Electron, u: number): [number, number] {
  const th = warp(u);
  const x = A * Math.cos(th);
  const y = B * Math.sin(th);
  const c = Math.cos(e.tilt);
  const s = Math.sin(e.tilt);
  return [SIZE / 2 + x * c - y * s, SIZE / 2 + x * s + y * c];
}

function drawOrbits(o: CanvasRenderingContext2D): void {
  o.strokeStyle = "rgba(255, 205, 110, 0.3)";
  o.lineWidth = 1.2;
  o.shadowColor = "#f2bf49";
  o.shadowBlur = 6;
  for (const e of ELECTRONS) {
    o.save();
    o.translate(SIZE / 2, SIZE / 2);
    o.rotate(e.tilt);
    o.beginPath();
    o.ellipse(0, 0, A, B, 0, 0, TAU);
    o.stroke();
    o.restore();
  }
}

function drawHead(h: CanvasRenderingContext2D, [x, y]: [number, number]): void {
  const g = h.createRadialGradient(x, y, 0, x, y, 24);
  g.addColorStop(0, "rgba(255, 252, 235, 1)");
  g.addColorStop(0.18, "rgba(255, 226, 150, 0.95)");
  g.addColorStop(0.4, "rgba(242, 176, 60, 0.45)");
  g.addColorStop(1, "rgba(242, 160, 40, 0)");
  h.fillStyle = g;
  h.beginPath();
  h.arc(x, y, 24, 0, TAU);
  h.fill();
}

function drawTrail(t: CanvasRenderingContext2D, e: Electron, u0: number, u1: number): void {
  t.globalCompositeOperation = "lighter";
  t.lineCap = "round";
  const steps = 8;
  for (const [width, alpha, blur] of [
    [9, 0.14, 24],
    [4, 0.3, 12],
    [1.8, 1, 6],
  ] as const) {
    t.lineWidth = width;
    t.strokeStyle = `rgba(255, 214, 130, ${alpha})`;
    t.shadowColor = "#f2b440";
    t.shadowBlur = blur;
    t.beginPath();
    t.moveTo(...at(e, u0));
    for (let i = 1; i <= steps; i++) t.lineTo(...at(e, u0 + ((u1 - u0) * i) / steps));
    t.stroke();
  }
}

/** The 2D surface the atom needs from each layer; a real canvas, or a stand-in in tests. */
export interface Layer {
  width: number;
  height: number;
  getContext(kind: "2d"): CanvasRenderingContext2D | null;
}

/** Start the atom on its three layers (orbits, trails, heads). Returns a function that stops it, or
    nothing when there is nothing to stop: under reduced motion it draws one still frame and is done. */
export function startAtom(layers: readonly Layer[], reduced: boolean): (() => void) | undefined {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const [o, t, h] = layers.map((c: Layer): CanvasRenderingContext2D | null => {
    c.width = c.height = SIZE * dpr;
    const g = c.getContext("2d");
    g?.scale(dpr, dpr);
    return g;
  });
  if (!o || !t || !h) return undefined;
  drawOrbits(o);
  if (reduced) {
    for (const e of ELECTRONS) {
      drawTrail(t, e, e.phase - 0.9, e.phase);
      drawHead(h, at(e, e.phase));
    }
    return undefined;
  }
  const u: number[] = ELECTRONS.map((e: Electron): number => e.phase);
  let last = performance.now();
  let frame = 0;
  const tick = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    // Fade the trail layer so older light dies away.
    t.globalCompositeOperation = "destination-out";
    t.shadowBlur = 0;
    t.fillStyle = `rgba(0, 0, 0, ${1 - Math.exp(-dt * 7)})`;
    t.fillRect(0, 0, SIZE, SIZE);
    h.clearRect(0, 0, SIZE, SIZE);
    ELECTRONS.forEach((e: Electron, i: number): void => {
      const u0 = u[i];
      u[i] += e.speed * dt;
      drawTrail(t, e, u0, u[i]);
      drawHead(h, at(e, u[i]));
    });
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return (): void => cancelAnimationFrame(frame);
}

/** Glowing atom shown while the station loads. */
export function AtomLoader({ label }: Readonly<{ label: string }>): ReactNode {
  const layers = useRef<Array<HTMLCanvasElement | null>>([]);

  useEffect(() => {
    const canvases = layers.current.filter((c: HTMLCanvasElement | null): c is HTMLCanvasElement => c !== null);
    return startAtom(canvases, globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  return (
    <output className="station-loader" aria-label={label}>
      {[0, 1, 2].map(
        (i: number): ReactNode => (
          <canvas
            key={i}
            aria-hidden="true"
            ref={(c: HTMLCanvasElement | null): void => {
              layers.current[i] = c;
            }}
          />
        ),
      )}
    </output>
  );
}
