import type { CSSProperties } from "react";
import type { ActivityPlatform } from "../../../lib/activity";

/**
 * The wasteland overlay theme (docs/design/wasteland-overlays). Only colours and textures live here: layout is in
 * wasteland.css and behaviour in the chat reducer, so another theme can replace this file alone. These values render
 * on stream, so they do not follow the site's light or dark theme.
 */

export const WASTELAND_COLORS = {
  /** Row fill: dark teal at 94 %. */
  fill: "rgb(15 59 51 / 0.94)",
  fillSolid: "#0F3B33",
  /** The thick worn border and the grille ticks. */
  border: "#D4B02A",
  /** The thin dark line outside the border. */
  outline: "#12110D",
  username: "#F2D22E",
  message: "#F3EAD3",
  /** Removed messages and emote placeholders. */
  muted: "#A9C2BA",
} as const;

/** Platform accents. Each platform also has its own glyph shape, so colour is never the only cue. */
export const PLATFORM_COLORS: Readonly<Record<ActivityPlatform, string>> = {
  youtube: "#E5322D",
  twitch: "#9146FF",
  kick: "#53FC18",
};

/** Platform names are brand names; they are not translated. */
export const PLATFORM_NAMES: Readonly<Record<ActivityPlatform, string>> = {
  youtube: "YouTube",
  twitch: "Twitch",
  kick: "Kick",
};

type Rgb = readonly [number, number, number];

function svgUri(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * A tiling noise texture drawn by an SVG turbulence filter: no image files. `alpha` and `offset` map the noise to
 * opacity, so a high alpha with a low offset leaves sparse specks.
 */
export function noiseTexture(
  baseFrequency: string,
  octaves: number,
  seed: number,
  rgb: Rgb,
  alpha: number,
  offset: number,
  width = 260,
  height = 90,
): string {
  return svgUri(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'>` +
      `<filter id='n' x='0' y='0' width='100%' height='100%'>` +
      `<feTurbulence type='fractalNoise' baseFrequency='${baseFrequency}' numOctaves='${octaves}' seed='${seed}' stitchTiles='stitch'/>` +
      `<feColorMatrix values='0 0 0 0 ${rgb[0]} 0 0 0 0 ${rgb[1]} 0 0 0 0 ${rgb[2]} ${alpha} 0 0 0 ${offset}'/>` +
      `</filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`,
  );
}

/** The four row textures: dark grunge, faint horizontal scratches, yellow spray flecks and dark border chips. */
export const WASTELAND_TEXTURES = {
  grunge: noiseTexture(".028 .09", 3, 7, [0.01, 0.08, 0.07], 2.6, -1.2),
  scratch: noiseTexture(".006 .8", 2, 4, [0.62, 0.8, 0.74], 7, -5.1),
  fleck: noiseTexture(".75", 2, 3, [0.86, 0.71, 0.17], 9, -5.7),
  chip: noiseTexture(".6", 2, 11, [0.06, 0.2, 0.17], 10, -6.4),
} as const;

/** The theme as CSS custom properties, set on the root of a themed layer. wasteland.css reads only these. */
export const WASTELAND_STYLE: CSSProperties = {
  "--wl-fill": WASTELAND_COLORS.fill,
  "--wl-border": WASTELAND_COLORS.border,
  "--wl-outline": WASTELAND_COLORS.outline,
  "--wl-user": WASTELAND_COLORS.username,
  "--wl-text": WASTELAND_COLORS.message,
  "--wl-muted": WASTELAND_COLORS.muted,
  "--wl-tex-grunge": WASTELAND_TEXTURES.grunge,
  "--wl-tex-scratch": WASTELAND_TEXTURES.scratch,
  "--wl-tex-fleck": WASTELAND_TEXTURES.fleck,
  "--wl-tex-chip": WASTELAND_TEXTURES.chip,
} as CSSProperties;

/** A stable offset in [0, 200) px for a row's border chips, so no two rows look the same and none flicker. */
export function chipOffset(id: string): number {
  let hash: number = 0x5bf03635;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) % 200;
}
