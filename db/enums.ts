// Share enum values across schema CHECKs, validation, and API types.
// After changes, run `pnpm db:generate` and review the migration; SQLite cannot alter CHECKs in place.

export const LOCALES = ["en", "es", "pt-BR", "de", "pl", "uk", "ru", "ja", "zh-CN", "fr", "hi"] as const;

// Presets 0-17; no preset or upload uses the default.
export const AVATAR_PRESET_COUNT = 18;
export const DEFAULT_AVATAR_PRESET = 14;

export const STREAMER_STATUSES = ["active", "frozen", "suspended"] as const;

// Ideas board status on the official page.
export const ENTRY_STATUSES = ["review", "planned", "progress", "shipped", "declined"] as const;

export const MODERATION_TARGETS = ["streamer", "report", "entry", "passkey", "admin_session"] as const;

export const STREAM_PLATFORMS = ["twitch", "youtube", "kick", "tiktok", "other"] as const;
export const STREAM_EVENT_STATUSES = ["scheduled", "live", "ended", "cancelled"] as const;

export const CARD_ICONS = [
  "chat",
  "poll",
  "calendar",
  "discord",
  "heart",
  "gift",
  "star",
  "link",
  "mic",
  "gamepad",
  "palette",
  "megaphone",
] as const;
export const CARD_TABS = ["topics", "polls", "schedule", "about", "community"] as const;
export const MAX_COMMUNITY_CARDS = 8;

export const SUPPORT_LINK_KINDS = [
  "kofi",
  "patreon",
  "bmac",
  "paypal",
  "streamlabs",
  "streamelements",
  "twitch",
  "youtube",
  "other",
] as const;
export const MAX_SUPPORT_LINKS = 4;

export const OVERLAY_SOURCES = ["auto", "poll", "topic", "next", "message", "card", "support", "hidden"] as const;
export const OVERLAY_POSITIONS = ["lower", "top", "corner", "center"] as const;
export const OVERLAY_SIZES = ["s", "m", "l"] as const;
export const OVERLAY_MESSAGE_STYLES = ["info", "hype"] as const;

/** Streaming platforms a page can connect for its activity feed (docs/channel-connections.md). */
export const CHANNEL_PLATFORMS = ["twitch", "youtube", "kick"] as const;
/** `needs_reauth`: the provider revoked access or the refresh failed; the owner must reconnect. */
export const CHANNEL_STATUSES = ["active", "needs_reauth", "error"] as const;

export const MASH_PHASES = ["setup", "countdown", "live", "finished"] as const;

// SQL `IN (...)` values must be constants, never user input.
export function sqlList(values: readonly (string | number)[]): string {
  return values
    .map((value: string | number): string => (typeof value === "number" ? String(value) : `'${value}'`))
    .join(", ");
}
