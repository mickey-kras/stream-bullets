import { z } from "zod";
import { STREAM_TITLE_LENGTH, type ActivityPlatform, type ActivityStream } from "../lib/activity";
import { cleanText, id, parseTime } from "./channel-normalize";
import type { TwitchSubscription } from "./channel-support";

/**
 * Turns verified provider payloads into live signals (`ActivityStream` in app/lib/activity.ts): the stream of a
 * channel starts or stops. A payload that is not as the provider documents it gives no signal. The live
 * subscriptions are optional: a channel is healthy without them (docs/channel-connections.md).
 */

/** The EventSub subscriptions of the live signals for a channel. They need no scope of the broadcaster. */
export function twitchLiveSubscriptions(broadcaster: string): TwitchSubscription[] {
  const own = { broadcaster_user_id: broadcaster };
  return [
    { type: "stream.online", version: "1", condition: own },
    { type: "stream.offline", version: "1", condition: own },
  ];
}

/** The EventSub subscription types that give live signals. */
export const TWITCH_LIVE_TYPES: readonly string[] = twitchLiveSubscriptions("").map(
  (subscription: TwitchSubscription): string => subscription.type,
);

/** The Kick webhook events that give live signals. */
export const KICK_LIVE_EVENTS: readonly string[] = ["livestream.status.updated"];

/** The subscription types of the live signals. YouTube has none: the poll of its live chat sees the stream. */
export const LIVE_SUBSCRIPTIONS: Readonly<Record<ActivityPlatform, readonly string[]>> = {
  twitch: TWITCH_LIVE_TYPES,
  youtube: [],
  kick: KICK_LIVE_EVENTS,
};

/**
 * The provider refused a live subscription. The channel stays healthy and reads chat and support as before: only
 * its live signals stop. A repair asks for the type again.
 */
export function liveRefused(platform: ActivityPlatform, type: string): void {
  // Only the platform and the type: never a token, an id or a name.
  console.warn("channel_live_refused", { platform, type });
}

/** A provider time with an offset, such as `2025-01-14T16:08:06Z`, as milliseconds. Another value is refused. */
const startTime = z
  .string()
  .max(64)
  .transform((value: string): number | null => parseTime(value))
  .pipe(z.number().int().nonnegative());

/** The values of `type` that Twitch documents for `stream.online`. */
const TWITCH_STREAM_TYPES = ["live", "playlist", "watch_party", "premiere", "rerun"] as const;

const twitchOnline = z.object({
  broadcaster_user_id: id,
  type: z.enum(TWITCH_STREAM_TYPES),
  started_at: startTime,
});
const twitchOffline = z.object({ broadcaster_user_id: id });

/** The live signal of one Twitch EventSub notification. */
export function twitchLiveSignal(subscriptionType: string, event: unknown, receivedAt: number): ActivityStream[] {
  if (subscriptionType === "stream.online") {
    const parsed = twitchOnline.safeParse(event);
    // A playlist, a watch party, a premiere or a rerun is not a live stream of the channel: it gives no signal.
    if (!parsed.success || parsed.data.type !== "live") return [];
    return [{ kind: "stream", platform: "twitch", live: true, startedAt: parsed.data.started_at, receivedAt }];
  }
  if (subscriptionType === "stream.offline" && twitchOffline.safeParse(event).success)
    return [{ kind: "stream", platform: "twitch", live: false, receivedAt }];
  return [];
}

const kickLiveSchema = z.object({
  broadcaster: z.object({ user_id: id }),
  is_live: z.boolean(),
  title: z.string().max(2000),
  started_at: startTime,
  ended_at: z.string().max(64).nullable(),
});

/**
 * The live signal of one Kick webhook delivery. Each signal keeps the start time, and the title cut to
 * STREAM_TITLE_LENGTH. The title is untrusted text, as chat text.
 */
export function kickLiveSignal(eventType: string, body: unknown, receivedAt: number): ActivityStream[] {
  if (eventType !== "livestream.status.updated") return [];
  const parsed = kickLiveSchema.safeParse(body);
  if (!parsed.success) return [];
  const title: string = cleanText(parsed.data.title, STREAM_TITLE_LENGTH);
  return [
    {
      kind: "stream",
      platform: "kick",
      live: parsed.data.is_live,
      startedAt: parsed.data.started_at,
      ...(title ? { title } : {}),
      receivedAt,
    },
  ];
}
