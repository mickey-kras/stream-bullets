import { z } from "zod";
import { CHANNEL_PLATFORMS, CHANNEL_STATUSES } from "../../db/enums";
import type { ActivityPlatform, ChannelStatus } from "./activity";

/** One platform as GET /api/channels and the Streamer tools loader list it. */
export interface ChannelView {
  platform: ActivityPlatform;
  available: boolean;
  connection: {
    displayName: string;
    status: ChannelStatus;
    code: string | null;
    connectedAt: number;
    lastEventAt: number | null;
    updatedAt: number;
  } | null;
  /** Whether the connection reads support events. Not there in the answer of a server from before them. */
  support?: boolean;
  /** The permissions that the provider asks for when the streamer turns support events on. */
  supportScopes?: string[];
}

/** The body of GET /api/channels. Fields that the panel does not read are dropped. */
export const channelsResponseSchema: z.ZodType<{ channels: ChannelView[] }> = z.object({
  channels: z.array(
    z.object({
      platform: z.enum(CHANNEL_PLATFORMS),
      available: z.boolean(),
      connection: z
        .object({
          displayName: z.string(),
          status: z.enum(CHANNEL_STATUSES),
          code: z.string().nullable(),
          connectedAt: z.number(),
          lastEventAt: z.number().nullable(),
          updatedAt: z.number(),
        })
        .nullable(),
      support: z.boolean().optional(),
      supportScopes: z.array(z.string().max(200)).max(20).optional(),
    }),
  ),
});

/**
 * The health of one platform. "unavailable" is a connection of a platform that this site does not offer: the
 * owner cannot repair it here, and it delivers no chat.
 */
export type ChannelHealth = "healthy" | "attention" | "none" | "unavailable";

export function channelHealth(channel: ChannelView): ChannelHealth {
  if (channel.connection === null) return "none";
  if (!channel.available) return "unavailable";
  return channel.connection.status === "active" ? "healthy" : "attention";
}

/** True when at least one connected platform delivers chat. */
export function deliversChat(channels: readonly ChannelView[]): boolean {
  return channels.some((channel: ChannelView): boolean => channelHealth(channel) === "healthy");
}

/** A connected platform that got a problem ("attention") or that works again ("healthy"). */
export interface HealthChange {
  channel: ChannelView;
  to: "attention" | "healthy";
}

/**
 * The platforms whose health changed between two reads: healthy to a problem, or a problem to healthy. A new
 * connection, a removed connection and another code for the same problem state are no change.
 */
export function healthChanges(previous: readonly ChannelView[], next: readonly ChannelView[]): HealthChange[] {
  const changes: HealthChange[] = [];
  for (const channel of next) {
    const before: ChannelView | undefined = previous.find(
      (item: ChannelView): boolean => item.platform === channel.platform,
    );
    if (!before) continue;
    const from: ChannelHealth = channelHealth(before);
    const to: ChannelHealth = channelHealth(channel);
    if (from === "healthy" && to === "attention") changes.push({ channel, to });
    if (from === "attention" && to === "healthy") changes.push({ channel, to });
  }
  return changes;
}

const AGE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
];

/**
 * The age of a time as text in the locale, for example "2 minutes ago". Null means "just now": less than a
 * second, or a time ahead of this clock.
 */
export function relativeAge(at: number, now: number, locale: string): string | null {
  const elapsed: number = now - at;
  for (const [unit, size] of AGE_UNITS) {
    if (elapsed >= size)
      return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-Math.floor(elapsed / size), unit);
  }
  return null;
}
