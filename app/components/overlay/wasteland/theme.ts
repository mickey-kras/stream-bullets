import type { CSSProperties } from "react";
import type { ActivityPlatform } from "../../../lib/activity";
import { CHAT_LIMITS } from "../../../lib/chat-feed";

/**
 * The wasteland overlay theme: the approved compact chat cards of issue #663. Only colours live here, and the fade
 * time, which comes from the chat reducer: layout and motion are in wasteland.css and use-row-motion.ts, and
 * behaviour is in the chat reducer, so another theme can replace this file alone. These values render on stream,
 * so they do not follow the site's light or dark theme.
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
  /** The warm glow in the top-left corner of each card: `accent` at 8 %. */
  glow: "#e5bd5414",
  /** The thin inner frame of each card: `accent` at 16 %. */
  inner: "#e5bd5429",
  /** The dark inset ring inside the card border. */
  inset: "#081f2480",
  /** The faint horizontal scan lines on each card. */
  scan: "#0000000c",
  /** The drop shadow under each card. */
  shadow: "#00000030",
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
  "--wl-glow": WASTELAND_COLORS.glow,
  "--wl-inner": WASTELAND_COLORS.inner,
  "--wl-inset": WASTELAND_COLORS.inset,
  "--wl-scan": WASTELAND_COLORS.scan,
  "--wl-shadow": WASTELAND_COLORS.shadow,
  // The fade of a leaving or removed card. It is the reducer's leave time, so the fade and the reducer agree.
  "--wl-leave": `${CHAT_LIMITS.leaveMs}ms`,
} as CSSProperties;
