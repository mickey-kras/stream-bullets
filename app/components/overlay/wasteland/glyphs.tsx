import type { ReactNode } from "react";
import type { ActivityPlatform } from "../../../lib/activity";

/*
 * The chat card artwork, drawn in code in currentColor. The platform icons are monochrome outline shapes from the
 * approved reference (issue #663). Each platform has its own silhouette, so colour is never the only cue.
 */

/** One shape of a glyph on a 24 x 24 grid: a filled path, or a path stroked 2 px wide. */
export interface GlyphShape {
  d: string;
  paint: "fill" | "stroke";
}

/**
 * The platform glyphs, shared by the chat cards (SVG) and the character name tags (canvas Path2D), so both draw the
 * same shapes.
 */
export const PLATFORM_GLYPHS: Readonly<Record<ActivityPlatform, readonly GlyphShape[]>> = {
  youtube: [
    { d: "M6 5h12a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z", paint: "stroke" },
    { d: "m10 8 6 4-6 4z", paint: "fill" },
  ],
  twitch: [
    { d: "M4 2h18v13l-6 6h-5l-4 3v-3H2V6zm1 3v12h5v3l3-3h4l3-3V5z", paint: "fill" },
    { d: "M11 7v6m5-6v6", paint: "stroke" },
  ],
  kick: [{ d: "M3 3h5v7h3V7h3V3h7v6h-4v3h-3v2h3v3h4v4h-7v-3h-3v-3H8v6H3z", paint: "fill" }],
};

/** The glyph of a platform without its own: a ring with three dots. */
export const GENERIC_GLYPH: readonly GlyphShape[] = [
  { d: "M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z", paint: "stroke" },
  { d: "M7 10h2v4H7zm4 0h2v4h-2zm4 0h2v4h-2z", paint: "fill" },
];

/** The glyph of a platform id; an unknown id gets GENERIC_GLYPH. */
export function glyphOf(platform: string): readonly GlyphShape[] {
  return Object.hasOwn(PLATFORM_GLYPHS, platform) ? PLATFORM_GLYPHS[platform as ActivityPlatform] : GENERIC_GLYPH;
}

function IconPaths({ platform }: Readonly<{ platform: ActivityPlatform }>): ReactNode {
  return PLATFORM_GLYPHS[platform].map((shape: GlyphShape) =>
    shape.paint === "fill" ? (
      <path key={shape.d} fill="currentColor" d={shape.d} />
    ) : (
      <path key={shape.d} fill="none" stroke="currentColor" strokeWidth="2" d={shape.d} />
    ),
  );
}

/**
 * The platform icon. The drawing is hidden from assistive technology; the platform name is visually hidden text
 * after it, so a screen reader reads the name before the user name.
 */
export function PlatformIcon({
  platform,
  label,
  className,
}: Readonly<{ platform: ActivityPlatform; label: string; className?: string }>): ReactNode {
  return (
    <>
      <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-platform={platform}>
        <IconPaths platform={platform} />
      </svg>
      <span className="sr-only">{`${label} `}</span>
    </>
  );
}

/** The vault mark at the right end of each card: a ring with a hub and two pairs of side ticks. Decorative. */
export function VaultMark({ className }: Readonly<{ className?: string }>): ReactNode {
  return (
    <svg className={className} viewBox="0 0 36 24" aria-hidden="true" focusable="false">
      <path d="M1 9h10M1 15h10M25 9h10M25 15h10" />
      <circle cx="18" cy="12" r="9" />
      <circle cx="18" cy="12" r="4" />
    </svg>
  );
}
