import type { ReactNode } from "react";
import type { ActivityPlatform } from "../../../lib/activity";
import { PLATFORM_COLORS, WASTELAND_COLORS } from "./theme";

/*
 * Original wasteland artwork, drawn in code. The platform glyphs are generic
 * shapes, not trademark logos: a play tile, a speech square and a notched K block. Each platform has its own
 * silhouette, so colour is never the only cue.
 */

function GlyphPaths({ platform }: Readonly<{ platform: ActivityPlatform }>): ReactNode {
  const color: string = PLATFORM_COLORS[platform];
  if (platform === "youtube")
    return (
      <>
        <rect x="1" y="4" width="22" height="16" rx="5" fill={color} />
        <path d="M9.5 8.2v7.6l6.6-3.8z" fill="#fff" />
      </>
    );
  if (platform === "twitch")
    return (
      <>
        <path d="M2.5 3h19v13.5H11l-5.5 5v-5h-3z" fill={color} />
        <circle cx="7.5" cy="10" r="1.7" fill="#fff" />
        <circle cx="12" cy="10" r="1.7" fill="#fff" />
        <circle cx="16.5" cy="10" r="1.7" fill="#fff" />
      </>
    );
  return (
    <>
      <path d="M5 1.5h14l3.5 3.5v14L19 22.5H5L1.5 19V5z" fill={color} />
      <g fill="#0d1f08">
        <rect x="6.5" y="6" width="3.5" height="12" />
        <rect x="10" y="10" width="2.5" height="4" />
        <rect x="12.5" y="8" width="2.5" height="2.5" />
        <rect x="14.5" y="6" width="3" height="2.5" />
        <rect x="12.5" y="13.5" width="2.5" height="2.5" />
        <rect x="14.5" y="15.5" width="3" height="2.5" />
      </g>
    </>
  );
}

/**
 * The platform glyph. With a label it is an image with that accessible name; without one it is decorative and the
 * caller names the platform another way.
 */
export function PlatformGlyph({
  platform,
  label,
  className,
}: Readonly<{ platform: ActivityPlatform; label?: string; className?: string }>): ReactNode {
  const named: boolean = label !== undefined;
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      role={named ? "img" : undefined}
      aria-label={label}
      aria-hidden={named ? undefined : true}
      focusable="false"
      data-platform={platform}
    >
      <GlyphPaths platform={platform} />
    </svg>
  );
}

/** The orbit-and-bolt emblem: one tilted orbit ring crossed by a lightning bolt. Drawn in currentColor. */
export function Emblem({ className }: Readonly<{ className?: string }>): ReactNode {
  return (
    <svg className={className} viewBox="0 0 64 40" aria-hidden="true" focusable="false">
      <ellipse
        cx="32"
        cy="20"
        rx="29"
        ry="10.5"
        transform="rotate(-17 32 20)"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.6"
      />
      <path
        d="M36.5 2 L23 22 H31 L27 38 L42 15.5 H34 L39.5 2Z"
        fill="currentColor"
        stroke={WASTELAND_COLORS.fillSolid}
        strokeWidth="3"
        strokeLinejoin="round"
        paintOrder="stroke"
      />
    </svg>
  );
}

export interface PixelArt {
  width: number;
  height: number;
  /** [x, y] of each lit pixel. */
  pixels: readonly (readonly [number, number])[];
}

/**
 * The emblem for pixel art (the playground's doors and flag): a tilted ring with the pixels next to the bolt
 * removed, so the ring breaks around it. `bolt` rows use `#` for a lit pixel.
 */
export function emblemPixels(
  width: number,
  height: number,
  radiusX: number,
  radiusY: number,
  bolt: readonly string[],
  boltX: number,
  boltY: number,
): PixelArt {
  const centerX: number = (width - 1) / 2;
  const centerY: number = (height - 1) / 2;
  const tilt: number = -0.25;
  const boltPixels: [number, number][] = bolt.flatMap((row: string, y: number): [number, number][] =>
    [...row].flatMap((cell: string, x: number): [number, number][] => (cell === "#" ? [[boltX + x, boltY + y]] : [])),
  );
  const boltKeys = new Set<string>(boltPixels.map(([x, y]) => `${x},${y}`));
  const ring = new Set<string>();
  for (let angle = 0; angle < 6.3; angle += 0.02) {
    const ex: number = radiusX * Math.cos(angle);
    const ey: number = radiusY * Math.sin(angle);
    const x: number = Math.round(centerX + ex * Math.cos(tilt) - ey * Math.sin(tilt));
    const y: number = Math.round(centerY + ex * Math.sin(tilt) + ey * Math.cos(tilt));
    ring.add(`${x},${y}`);
  }
  const nearBolt = (x: number, y: number): boolean => {
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) if (boltKeys.has(`${x + dx},${y + dy}`)) return true;
    return false;
  };
  const ringPixels: [number, number][] = [...ring]
    .map((key: string): [number, number] => {
      const [x, y] = key.split(",").map(Number);
      return [x, y];
    })
    .filter(([x, y]) => !nearBolt(x, y));
  return { width, height, pixels: [...ringPixels, ...boltPixels] };
}

/** The 26x12 pixel emblem. */
export const EMBLEM_PIXELS: PixelArt = emblemPixels(
  26,
  12,
  12,
  3.2,
  ["...###", "..###.", ".###..", "######", "...###", "..###.", ".###..", ".##...", "##....", "#....."],
  10,
  1,
);

/** The 17x9 pixel emblem for small plates. */
export const EMBLEM_PIXELS_SMALL: PixelArt = emblemPixels(
  17,
  9,
  7.5,
  2.2,
  ["..###", ".###.", "#####", "..##.", ".##..", ".#...", "#...."],
  6,
  1,
);

/** Pixel art as crisp SVG squares, drawn in currentColor. */
export function PixelEmblem({
  art = EMBLEM_PIXELS,
  className,
}: Readonly<{ art?: PixelArt; className?: string }>): ReactNode {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${art.width} ${art.height}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path fill="currentColor" d={art.pixels.map(([x, y]) => `M${x} ${y}h1v1h-1z`).join("")} />
    </svg>
  );
}
