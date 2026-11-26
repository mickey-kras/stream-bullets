import { z } from "zod";
import { CHANNEL_PLATFORMS, CHANNEL_STATUSES } from "../../db/enums";
import { type PlaygroundFrame, parseFrame } from "./playground/protocol";
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

/**
 * The support events. A gift is one event for a gift bundle. `reactions` is one event for a group of reactions.
 * `tip` is a direct tip through StreamBullets: it is not from a platform.
 */
export const SUPPORT_KINDS = [
  "follow",
  "subscription",
  "membership",
  "gift",
  "raid",
  "bits",
  "super_chat",
  "super_sticker",
  "kicks",
  "tip",
  "reactions",
] as const;
export type SupportKind = (typeof SUPPORT_KINDS)[number];

/** The kinds whose amount is money. Their amount is in micros of `currency`: 1 000 000 is one unit. */
export const MONEY_KINDS: ReadonlySet<SupportKind> = new Set<SupportKind>(["super_chat", "super_sticker", "tip"]);

/** Where a support event comes from: a platform, or `direct` for a tip through StreamBullets. */
export type SupportSource = ActivityPlatform | "direct";

export interface ActivitySupport {
  kind: SupportKind;
  /** `${platform}:${deliveryId}`: unique across platforms. The same delivery never makes a second event. */
  id: string;
  platform: SupportSource;
  /** The ID that the provider gave this delivery. A provider sends the same ID again for a retry. */
  deliveryId: string;
  /** The supporter as a participant of the platform. Null: anonymous, or the platform does not say. */
  sender: { id: string; displayName: string } | null;
  /** True when the supporter asked to stay anonymous. An anonymous event has no sender. */
  anonymous: boolean;
  /**
   * The amount in the native unit of the kind: months for a subscription and a membership, gifts in a bundle,
   * viewers of a raid, Bits, KICKs, reactions in a group, and micros of `currency` for money. Null for a follow.
   */
  amount: number | null;
  /** The ISO 4217 code for a money kind. Null for each other kind: no conversion between units. */
  currency: string | null;
  /** The text that the supporter sent with it. Untrusted, as chat text. */
  text?: string;
  receivedAt: number;
  /**
   * True for an event that the server sends again: a replay of the owner, a test, or the snapshot of a reconnect.
   * A consumer can show a replay. It never counts a replay for a goal, a report, or revenue.
   */
  replay: boolean;
}

export type ActivityEvent =
  | ActivityChat
  | ActivitySupport
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
  "webhooks_rejected",
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

const supportShape = {
  id: z.string().min(1).max(160),
  deliveryId: id,
  sender: z.object({ id, displayName: z.string().max(100) }).nullable(),
  anonymous: z.boolean(),
  text: z.string().max(MAX_TEXT_LENGTH).optional(),
  receivedAt: time,
  replay: z.boolean(),
};
const amount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const currency = z.string().regex(/^[A-Z]{3}$/);

/** The kinds with an amount that is a count: months, gifts, viewers, Bits, KICKs, or reactions. */
const COUNT_KINDS = ["subscription", "membership", "gift", "raid", "bits", "kicks", "reactions"] as const;

/**
 * A support event. The amount and the currency must agree with the kind, the ID must be the platform and the
 * delivery ID, an anonymous event must have no sender, and only a tip is direct.
 */
const supportSchema: z.ZodType<ActivitySupport> = z
  .union([
    z.object({ ...supportShape, kind: z.literal("follow"), platform, amount: z.null(), currency: z.null() }),
    z.object({ ...supportShape, kind: z.enum(COUNT_KINDS), platform, amount, currency: z.null() }),
    z.object({ ...supportShape, kind: z.enum(["super_chat", "super_sticker"]), platform, amount, currency }),
    z.object({ ...supportShape, kind: z.literal("tip"), platform: z.literal("direct"), amount, currency }),
  ])
  .refine((event: ActivitySupport): boolean => event.id === `${event.platform}:${event.deliveryId}`)
  .refine((event: ActivitySupport): boolean => !event.anonymous || event.sender === null);

/** True for a support event. */
export function isSupport(event: ActivityEvent): event is ActivitySupport {
  return (SUPPORT_KINDS as readonly string[]).includes(event.kind);
}

export const activityEventSchema: z.ZodType<ActivityEvent> = z.union([
  chatSchema,
  supportSchema,
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

/**
 * A message on the activity socket: the reconnect snapshot first, then one live event at a time. A socket that asked
 * for characters (`?characters=1`) also gets playground frames (playground/protocol.ts).
 */
export type ActivityMessage =
  | { type: "snapshot"; events: ActivityEvent[]; replay: true; since?: number }
  | { type: "event"; event: ActivityEvent }
  | { type: "unavailable" }
  | PlaygroundFrame;

/**
 * `message` with the events of one platform only, or null when no part of it is left. Each event of the feed has a
 * platform, or is a direct tip: a direct tip is not from the platform. A snapshot stays, with the events of the
 * platform. A playground frame and `unavailable` are not events
 * of a platform and stay: `viewForPlatform` selects the characters.
 */
export function messageForPlatform(message: ActivityMessage, platform: ActivityPlatform): ActivityMessage | null {
  if (message.type === "event") return message.event.platform === platform ? message : null;
  if (message.type !== "snapshot") return message;
  const events: ActivityEvent[] = message.events.filter((event: ActivityEvent): boolean => event.platform === platform);
  return events.length === message.events.length ? message : { ...message, events };
}

const EVENT_KINDS: ReadonlySet<string> = new Set<string>([
  "chat",
  "delete",
  "ban",
  "clear",
  "clear_user",
  "status",
  ...SUPPORT_KINDS,
]);

/** True for an event of a kind that this version does not know: a newer server sent it. */
function unknownKind(event: unknown): boolean {
  const kind: unknown = typeof event === "object" && event !== null ? (event as { kind?: unknown }).kind : undefined;
  return typeof kind === "string" && !EVENT_KINDS.has(kind);
}

// A consumer ignores the kinds that it does not know. Thus a snapshot keeps its other events, and a newer server
// never empties the chat of an older page. An event of a known kind that is not valid still refuses its message.
const snapshotEvents = z
  .array(z.unknown())
  .max(200)
  .transform((events: unknown[]): unknown[] => events.filter((event: unknown): boolean => !unknownKind(event)))
  .pipe(z.array(activityEventSchema));

const messageSchema: z.ZodType<Exclude<ActivityMessage, PlaygroundFrame>, unknown> = z.union([
  z.object({
    type: z.literal("snapshot"),
    events: snapshotEvents,
    replay: z.literal(true),
    since: z.number().finite().optional(),
  }),
  z.object({ type: z.literal("event"), event: activityEventSchema }),
  z.object({ type: z.literal("unavailable") }),
]);

/** The largest number of delivery IDs that `acceptDelivery` keeps for one page. */
export const DELIVERIES_KEPT = 2000;

/**
 * Whether a support event is new, and the IDs to keep after it. A provider sends a delivery again after a timeout
 * or an error. The second delivery has the same ID, and it must make no second event. `seen` holds the IDs of the
 * newest events, the oldest first.
 */
export function acceptDelivery(
  seen: readonly string[],
  event: ActivitySupport,
): { accepted: boolean; seen: readonly string[] } {
  if (seen.includes(event.id)) return { accepted: false, seen };
  return { accepted: true, seen: [...seen, event.id].slice(-DELIVERIES_KEPT) };
}

/** The sums of support, for a goal or a report. Money has one sum for each currency: no conversion. */
export interface SupportTotals {
  /** The number of events of each kind. */
  events: Partial<Record<SupportKind, number>>;
  /** The sum of the amounts of each kind that is not money, in its native unit. */
  amounts: Partial<Record<SupportKind, number>>;
  /** The sum of the money amounts for each currency, in micros. */
  money: Record<string, number>;
}

/**
 * The totals of `events`. Each event counts one time: a replay never counts, and an ID that comes again never
 * counts again. Thus a replayed alert never changes a goal or a revenue record.
 */
export function supportTotals(events: readonly ActivitySupport[]): SupportTotals {
  const totals: SupportTotals = { events: {}, amounts: {}, money: {} };
  const counted = new Set<string>();
  for (const event of events) {
    if (event.replay || counted.has(event.id)) continue;
    counted.add(event.id);
    totals.events[event.kind] = (totals.events[event.kind] ?? 0) + 1;
    if (event.amount === null) continue;
    if (event.currency === null) totals.amounts[event.kind] = (totals.amounts[event.kind] ?? 0) + event.amount;
    else totals.money[event.currency] = (totals.money[event.currency] ?? 0) + event.amount;
  }
  return totals;
}

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
  // Frames have their own contract, with bounds on names, text and sizes.
  if (typeof value === "object" && value !== null && (value as { type?: unknown }).type === "playground")
    return parseFrame(raw);
  const result = messageSchema.safeParse(value);
  return result.success ? result.data : null;
}
