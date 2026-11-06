/**
 * Value lists shared by the database CHECK constraints (db/schema.ts), the request validation
 * (app/server/validation.ts) and the API types (app/types.ts). Change a list here, then run
 * `pnpm db:generate` and hand-check the migration: SQLite cannot alter a CHECK in place.
 */

export const LOCALES = ["en", "es", "pt-BR", "de", "pl", "uk", "ru", "ja", "zh-CN", "fr", "hi"] as const;

/** Preset avatars 0..17. A user without a preset or upload shows the default preset. */
export const AVATAR_PRESET_COUNT = 18;
export const DEFAULT_AVATAR_PRESET = 14;

export const STREAMER_STATUSES = ["active", "frozen", "suspended"] as const;

/** Ideas board status on the official page (item 46). */
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

export const MASH_PHASES = ["setup", "countdown", "live", "finished"] as const;

/** Renders a value list as the inside of an SQL `IN (...)`. Values are constants, never user input. */
export function sqlList(values: readonly (string | number)[]): string {
  return values.map((value: string | number): string => (typeof value === "number" ? String(value) : `'${value}'`)).join(", ");
}
