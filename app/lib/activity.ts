import { z } from "zod";
import { CHANNEL_PLATFORMS, CHANNEL_STATUSES } from "../../db/enums";
import { addDays, formatDate, localDateOf, zonedTime } from "./zoned";

/**
 * The normalized activity feed of a page's connected channels (docs/channel-connections.md). The server builds
 * these events from verified provider deliveries; consumers (the overlay chat and characters) read them from
 * `/api/activity/:handle`. Every text field is untrusted input: render it as text, never as HTML, and load emote
 * images only from the hosts in `EMOTE_HOSTS`.
 */

export type ActivityPlatform = (typeof CHANNEL_PLATFORMS)[number];
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export type ActivityFragment =
  | { type: "text"; text: string }
  | { type: "emote"; id: string; name: string; url: string };

export interface ActivityChat {
  kind: "chat";
  /** `${platform}:${messageId}`: unique across platforms. */
  id: string;
  platform: ActivityPlatform;
  channelId: string;
  messageId: string;
  /** A participant is `platform` + `user.id`. Display names are not identities and are never merged. */
  user: { id: string; login?: string; displayName: string; color?: string };
  text: string;
  fragments: ActivityFragment[];
  badges: { id: string; label: string }[];
  /** When the platform says the message was sent, or null when it does not say. */
  sentAt: number | null;
  receivedAt: number;
  /**
   * False for a message from a reconnect snapshot, and for a message sent more than LIVE_WINDOW_MS before it was
   * received. Consumers act on commands only in live messages, so a reconnect or a late retry never runs an old
   * command again.
   */
  live: boolean;
}

export type ActivityEvent =
  | ActivityChat
  | { kind: "delete"; platform: ActivityPlatform; messageId: string; receivedAt: number }
  /** `until` is null for a permanent ban, else the end of the timeout. */
  | {
      kind: "ban";
      platform: ActivityPlatform;
      userId: string;
      until: number | null;
      receivedAt: number;
      /** When the platform says the ban was made, when it says so. A later ban of the same user has another time. */
      bannedAt?: number | null;
    }
  | { kind: "clear"; platform: ActivityPlatform; receivedAt: number }
  | { kind: "clear_user"; platform: ActivityPlatform; userId: string; receivedAt: number }
  | { kind: "status"; platform: ActivityPlatform; status: ChannelStatus | "disconnected"; code?: string };

/** The outcome of a channel callback, shown in the controls as `?channel=<platform>&result=<code>`. */
export const CONNECT_RESULTS = [
  "connected",
  "denied",
  "state_invalid",
  "session_mismatch",
  "channel_taken",
  "disconnect_first",
  "scope_missing",
  "failed",
] as const;
export type ConnectResult = (typeof CONNECT_RESULTS)[number];

/** The `status_code` values of a connection: why it is not healthy, as the controls explain it. */
export const CHANNEL_STATUS_CODES = [
  "authorization_revoked",
  "quota_exhausted",
  "subscribe_failed",
  "delivery_failed",
  "subscription_removed",
  "disconnecting",
] as const;
export type ChannelStatusCode = (typeof CHANNEL_STATUS_CODES)[number];

/** Google resets the YouTube Data API quota at midnight Pacific Time. */
const QUOTA_ZONE = "America/Los_Angeles";

/** The YouTube quota day of a time (`YYYY-MM-DD` in Pacific Time) and when it ends. */
export function quotaDay(now: number): { day: string; resetAt: number } {
  const today = localDateOf(now, QUOTA_ZONE);
  return { day: formatDate(today), resetAt: zonedTime(addDays(today, 1), 0, 0, QUOTA_ZONE) };
}

/** What each platform's official API lets the feed report. A false entry is a gap, not a bug. */
export const PLATFORM_CAPABILITIES: Readonly<
  Record<ActivityPlatform, Readonly<Record<"delete" | "clear" | "clearUser" | "ban" | "unban" | "emotes", boolean>>>
> = {
  twitch: { delete: true, clear: true, clearUser: true, ban: true, unban: true, emotes: true },
  youtube: { delete: true, clear: false, clearUser: false, ban: true, unban: false, emotes: false },
  kick: { delete: false, clear: false, clearUser: false, ban: true, unban: false, emotes: false },
};

/** The only hosts emote images may come from. URLs are built from emote ids, never taken from a payload. */
export const EMOTE_HOSTS: readonly string[] = ["static-cdn.jtvnw.net"];

/**
 * A chat message is live only when the platform sent it at most this long before the server received it (or did
 * not say when). A provider retry of an old delivery is then never live, so a consumer never runs it as a command.
 */
export const LIVE_WINDOW_MS = 30_000;

export function isLiveMessage(sentAt: number | null, receivedAt: number): boolean {
  return sentAt === null || receivedAt - sentAt <= LIVE_WINDOW_MS;
}

export const MAX_TEXT_LENGTH = 500;
export const MAX_BADGES = 16;
export const MAX_FRAGMENTS = 64;

const platform = z.enum(CHANNEL_PLATFORMS);
const id = z.string().min(1).max(128);
const time = z.number().int().nonnegative();
const emoteUrl = z
  .string()
  .max(300)
  .refine((value: string): boolean => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && EMOTE_HOSTS.includes(url.hostname);
    } catch {
      return false;
    }
  });

const chatSchema = z.object({
  kind: z.literal("chat"),
  id: z.string().min(1).max(160),
  platform,
  channelId: id,
  messageId: id,
  user: z.object({
    id,
    login: z.string().max(100).optional(),
    displayName: z.string().max(100),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  }),
  text: z.string().max(MAX_TEXT_LENGTH),
  fragments: z
    .array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string().max(MAX_TEXT_LENGTH) }),
        z.object({ type: z.literal("emote"), id, name: z.string().max(100), url: emoteUrl }),
      ]),
    )
    .max(MAX_FRAGMENTS),
  badges: z.array(z.object({ id: z.string().max(64), label: z.string().max(64) })).max(MAX_BADGES),
  sentAt: time.nullable(),
  receivedAt: time,
  live: z.boolean(),
});

export const activityEventSchema: z.ZodType<ActivityEvent> = z.union([
  chatSchema,
  z.object({ kind: z.literal("delete"), platform, messageId: id, receivedAt: time }),
  z.object({
    kind: z.literal("ban"),
    platform,
    userId: id,
    until: time.nullable(),
    receivedAt: time,
    bannedAt: time.nullable().optional(),
  }),
  z.object({ kind: z.literal("clear"), platform, receivedAt: time }),
  z.object({ kind: z.literal("clear_user"), platform, userId: id, receivedAt: time }),
  z.object({
    kind: z.literal("status"),
    platform,
    status: z.enum([...CHANNEL_STATUSES, "disconnected"]),
    code: z.string().max(40).optional(),
  }),
]);

/** A message on the activity socket: the reconnect snapshot first, then one live event at a time. */
export type ActivityMessage =
  | { type: "snapshot"; events: ActivityEvent[]; replay: true }
  | { type: "event"; event: ActivityEvent }
  | { type: "unavailable" };

const messageSchema: z.ZodType<ActivityMessage> = z.union([
  z.object({ type: z.literal("snapshot"), events: z.array(activityEventSchema).max(200), replay: z.literal(true) }),
  z.object({ type: z.literal("event"), event: activityEventSchema }),
  z.object({ type: z.literal("unavailable") }),
]);

/** The longest socket message a consumer accepts. The producer trims a snapshot to fit. */
export const MAX_ACTIVITY_MESSAGE_LENGTH = 512 * 1024;

/** Parses one socket message for a consumer. Anything malformed is null and must be ignored. */
export function parseActivityMessage(raw: unknown): ActivityMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_ACTIVITY_MESSAGE_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = messageSchema.safeParse(value);
  return result.success ? result.data : null;
}
