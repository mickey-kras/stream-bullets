import type { CSSProperties } from "react";
import type { ActivityPlatform } from "../../../lib/activity";

/**
 * The wasteland overlay theme: the approved compact chat cards of issue #663. Only colours live here: layout and
 * motion are in wasteland.css and use-row-motion.ts, and behaviour is in the chat reducer, so another theme can
 * replace this file alone. These values render on stream, so they do not follow the site's light or dark theme.
 */

export const WASTELAND_COLORS = {
  /** Card fill: dark teal at 90 %. */
  card: "rgba(8, 43, 46, 0.9)",
  /** The thin card border. The newest card uses `accent` for its border and left bar. */
  border: "#b89649",
  /** User names, platform icons, the vault mark and the newest card. */
  accent: "#e5bd54",
  /** Message text. */
  message: "#f4ebce",
  /** Removed messages, badges and emote placeholders. */
  muted: "#c4c2a8",
} as const;

/** Platform names are brand names; they are not translated. */
export const PLATFORM_NAMES: Readonly<Record<ActivityPlatform, string>> = {
  youtube: "YouTube",
  twitch: "Twitch",
  kick: "Kick",
};

/** The theme as CSS custom properties, set on the root of a themed layer. wasteland.css reads only these. */
export const WASTELAND_STYLE: CSSProperties = {
  "--wl-card": WASTELAND_COLORS.card,
  "--wl-border": WASTELAND_COLORS.border,
  "--wl-accent": WASTELAND_COLORS.accent,
  "--wl-text": WASTELAND_COLORS.message,
  "--wl-muted": WASTELAND_COLORS.muted,
} as CSSProperties;
