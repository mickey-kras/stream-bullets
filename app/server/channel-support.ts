import { z } from "zod";
import type { ActivitySupport, ActivityPlatform, SupportKind } from "../lib/activity";
import { cleanText, id, name } from "./channel-normalize";
import type { YoutubeMessage } from "./channel-providers.server";

/**
 * Turns verified provider payloads into support events of the activity contract (app/lib/activity.ts). A payload
 * that is not as the provider documents it gives no event. `docs/channel-connections.md` lists the provider events,
 * the attribution, and the anonymity.
 *
 * Each event has the delivery ID of the provider. A provider sends a delivery again with the same ID, so the second
 * delivery makes the same event ID and the consumer refuses it (`acceptDelivery`).
 */

type Sender = ActivitySupport["sender"];

const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const currency = z.string().regex(/^[A-Z]{3}$/);
const optionalText = z.string().max(2000).nullish();

/** A support event of a platform. `amount` and `currency` must agree with the kind, as the contract says. */
function support(
  platform: ActivityPlatform,
  kind: SupportKind,
  deliveryId: string,
  receivedAt: number,
  detail: { sender: Sender; anonymous?: boolean; amount?: number; currency?: string; text?: string | null },
): ActivitySupport {
  const anonymous: boolean = detail.anonymous === true;
  const text: string = cleanText(detail.text ?? "");
  return {
    kind,
    id: `${platform}:${deliveryId}`,
    platform,
    deliveryId,
    sender: anonymous ? null : detail.sender,
    anonymous,
    amount: detail.amount ?? null,
    currency: detail.currency ?? null,
    ...(text ? { text } : {}),
    receivedAt,
    replay: false,
  };
}

/** What a reader gives for a payload. `contentId` is the ID of the event when the delivery ID is not: see Kick. */
type SupportRead = Parameters<typeof support>[4] & { kind: SupportKind; contentId?: string };

const twitchUser = z.object({ user_id: id, user_name: name });
// An anonymous cheer and an anonymous gift have no user: Twitch sends null for each user field.
const twitchMaybeUser = z.object({
  is_anonymous: z.boolean(),
  user_id: id.nullable(),
  user_name: name.nullable(),
});

function twitchSender(user: { user_id: string | null; user_name: string | null }): Sender {
  return user.user_id === null ? null : { id: user.user_id, displayName: user.user_name ?? "" };
}

const TWITCH_SUPPORT: Record<string, (event: unknown) => SupportRead> = {
  "channel.follow": (event) => ({ kind: "follow", sender: twitchSender(twitchUser.parse(event)) }),
  // A gift bundle also sends `channel.subscribe` with `is_gift` for each person who got a gift. The bundle is one
  // event (`channel.subscription.gift`), so those give none.
  "channel.subscribe": (event) => {
    const value = twitchUser.extend({ is_gift: z.literal(false) }).parse(event);
    return { kind: "subscription", sender: twitchSender(value), amount: 1 };
  },
  // The message that a subscriber sends with a month of the subscription: the amount is all months so far.
  "channel.subscription.message": (event) => {
    const value = twitchUser
      .extend({ cumulative_months: count, message: z.object({ text: optionalText }).nullish() })
      .parse(event);
    return {
      kind: "subscription",
      sender: twitchSender(value),
      amount: value.cumulative_months,
      text: value.message?.text,
    };
  },
  "channel.subscription.gift": (event) => {
    const value = twitchMaybeUser.extend({ total: count }).parse(event);
    return { kind: "gift", sender: twitchSender(value), anonymous: value.is_anonymous, amount: value.total };
  },
  "channel.cheer": (event) => {
    const value = twitchMaybeUser.extend({ bits: count, message: optionalText }).parse(event);
    return {
      kind: "bits",
      sender: twitchSender(value),
      anonymous: value.is_anonymous,
      amount: value.bits,
      text: value.message,
    };
  },
  "channel.raid": (event) => {
    const value = z
      .object({ from_broadcaster_user_id: id, from_broadcaster_user_name: name, viewers: count })
      .parse(event);
    return {
      kind: "raid",
      sender: { id: value.from_broadcaster_user_id, displayName: value.from_broadcaster_user_name },
      amount: value.viewers,
    };
  },
};

/** The EventSub subscription types that give support events. */
export const TWITCH_SUPPORT_TYPES: readonly string[] = Object.keys(TWITCH_SUPPORT);

/** One EventSub subscription as Twitch takes it: the type, its version and its condition. */
export interface TwitchSubscription {
  type: string;
  version: string;
  condition: Record<string, string>;
}

/**
 * The EventSub subscriptions of the support types for a channel. `channel.bits.use` is not one of them: a cheer
 * would count two times.
 */
export function twitchSupportSubscriptions(broadcaster: string): TwitchSubscription[] {
  const own = { broadcaster_user_id: broadcaster };
  return [
    // Version 2 needs a moderator: the broadcaster is the moderator of the own channel.
    { type: "channel.follow", version: "2", condition: { ...own, moderator_user_id: broadcaster } },
    { type: "channel.subscribe", version: "1", condition: own },
    { type: "channel.subscription.gift", version: "1", condition: own },
    { type: "channel.subscription.message", version: "1", condition: own },
    { type: "channel.cheer", version: "1", condition: own },
    // A raid names the channel that gets it.
    { type: "channel.raid", version: "1", condition: { to_broadcaster_user_id: broadcaster } },
  ];
}

/**
 * The support event of one Twitch EventSub notification. `deliveryId` is the `Twitch-Eventsub-Message-Id` header:
 * Twitch sends a notification again with the same ID.
 */
export function twitchSupport(
  subscriptionType: string,
  event: unknown,
  deliveryId: string,
  receivedAt: number,
): ActivitySupport[] {
  return read("twitch", TWITCH_SUPPORT[subscriptionType], event, deliveryId, receivedAt);
}

const kickUser = z.object({ user_id: id, username: name });
// The person who gives gifts can stay anonymous: Kick then sends null for each field of the user.
const kickGifter = z.object({ is_anonymous: z.boolean().nullish(), user_id: id.nullish(), username: name.nullish() });

function kickSender(user: { user_id: string; username: string }): Sender {
  return { id: user.user_id, displayName: user.username };
}

/** A time as Kick writes it, such as `2025-01-14T16:08:06Z`. */
const kickTime = z.string().regex(/^[\dTZ:.+-]{10,40}$/);
const kickSubscription = z.object({ subscriber: kickUser, duration: count, created_at: kickTime.optional() });

/**
 * The ID of a Kick support event from its content. Kick signs the webhooks of all apps with one key, and a copy
 * that a different app got has a different message ID. The content is the same in each copy, so the copy makes the
 * same event ID and counts one time. Without the time of the event, the ID is the message ID.
 */
function kickContentId(type: string, who: string, at: string | undefined, more: string = ""): string | undefined {
  return at === undefined ? undefined : `${type}:${who}:${at}${more}`;
}

const KICK_SUPPORT: Record<string, (body: unknown) => SupportRead> = {
  // A follow has no time. A person follows one time: a second follow of the same person is the same event.
  "channel.followed": (body) => {
    const { follower } = z.object({ follower: kickUser }).parse(body);
    return { kind: "follow", sender: kickSender(follower), contentId: `channel.followed:${follower.user_id}` };
  },
  "channel.subscription.new": (body) => {
    const value = kickSubscription.parse(body);
    const contentId = kickContentId("channel.subscription.new", value.subscriber.user_id, value.created_at);
    return { kind: "subscription", sender: kickSender(value.subscriber), amount: value.duration, contentId };
  },
  "channel.subscription.renewal": (body) => {
    const value = kickSubscription.parse(body);
    const contentId = kickContentId("channel.subscription.renewal", value.subscriber.user_id, value.created_at);
    return { kind: "subscription", sender: kickSender(value.subscriber), amount: value.duration, contentId };
  },
  // One delivery for the bundle: the amount is the number of people who got a gift.
  "channel.subscription.gifts": (body) => {
    const value = z
      .object({
        gifter: kickGifter,
        giftees: z
          .array(z.object({ user_id: id.nullish() }))
          .min(1)
          .max(1000),
        created_at: kickTime.optional(),
      })
      .parse(body);
    const { gifter, giftees } = value;
    const anonymous: boolean = gifter.is_anonymous === true || gifter.user_id == null;
    // An anonymous bundle has no gifter, so the first person who got a gift is part of the ID.
    const bundle = `:${giftees.length}:${giftees[0].user_id ?? ""}`;
    return {
      kind: "gift",
      sender: anonymous || gifter.user_id == null ? null : { id: gifter.user_id, displayName: gifter.username ?? "" },
      anonymous,
      amount: giftees.length,
      contentId: kickContentId("channel.subscription.gifts", gifter.user_id ?? "anonymous", value.created_at, bundle),
    };
  },
  "kicks.gifted": (body) => {
    const value = z
      .object({
        sender: kickUser,
        gift: z.object({ amount: count, message: optionalText }),
        created_at: kickTime.optional(),
      })
      .parse(body);
    return {
      kind: "kicks",
      sender: kickSender(value.sender),
      amount: value.gift.amount,
      text: value.gift.message,
      contentId: kickContentId("kicks.gifted", value.sender.user_id, value.created_at, `:${value.gift.amount}`),
    };
  },
};

/** The Kick webhook events that give support events. */
export const KICK_SUPPORT_EVENTS: readonly string[] = Object.keys(KICK_SUPPORT);

/** The subscription types that only support events need. YouTube has none: its support comes with the chat. */
export const SUPPORT_SUBSCRIPTIONS: Readonly<Record<ActivityPlatform, readonly string[]>> = {
  twitch: TWITCH_SUPPORT_TYPES,
  youtube: [],
  kick: KICK_SUPPORT_EVENTS,
};

/**
 * The support event of one Kick webhook delivery. `deliveryId` is the `Kick-Event-Message-Id` header: Kick sends a
 * delivery again with the same ID. The event ID is from the content of the event (`kickContentId`), so a copy of
 * the delivery with a different message ID makes the same event.
 */
export function kickSupport(
  eventType: string,
  body: unknown,
  deliveryId: string,
  receivedAt: number,
): ActivitySupport[] {
  return read("kick", KICK_SUPPORT[eventType], body, deliveryId, receivedAt);
}

/**
 * A delivery ID is opaque text of the provider. Twitch sends Base64 text with `+`, `/` and `=`, so any printable
 * ASCII text without a space is an ID.
 */
const deliveryIdSchema = z.string().regex(/^[\x21-\x7e]{1,128}$/);

function read(
  platform: ActivityPlatform,
  reader: ((payload: unknown) => SupportRead) | undefined,
  payload: unknown,
  deliveryId: string,
  receivedAt: number,
): ActivitySupport[] {
  if (!reader) return [];
  try {
    const { kind, contentId, ...detail } = reader(payload);
    return [support(platform, kind, deliveryIdSchema.parse(contentId ?? deliveryId), receivedAt, detail)];
  } catch (error: unknown) {
    // A payload that is not as the provider documents it gives no event.
    if (error instanceof z.ZodError) return [];
    throw error;
  }
}

type YoutubeSnippet = YoutubeMessage["snippet"];

function youtubeDetail(snippet: YoutubeSnippet): SupportRead | null {
  const base = { sender: null };
  if (snippet.type === "superChatEvent" && snippet.superChatDetails) {
    const { amountMicros, currency: code, userComment } = snippet.superChatDetails;
    return { ...base, kind: "super_chat", amount: amountMicros, currency: code, text: userComment };
  }
  if (snippet.type === "superStickerEvent" && snippet.superStickerDetails) {
    const { amountMicros, currency: code } = snippet.superStickerDetails;
    return { ...base, kind: "super_sticker", amount: amountMicros, currency: code };
  }
  // A new member, or a member who went to a different level: the first month.
  if (snippet.type === "newSponsorEvent") return { ...base, kind: "membership", amount: 1 };
  if (snippet.type === "memberMilestoneChatEvent" && snippet.memberMilestoneChatDetails) {
    const { memberMonth, userComment } = snippet.memberMilestoneChatDetails;
    return { ...base, kind: "membership", amount: memberMonth, text: userComment };
  }
  // One message for the bundle. Each person who got a gift also makes a `giftMembershipReceivedEvent`, which gives
  // no event: the bundle counts one time.
  if (snippet.type === "membershipGiftingEvent" && snippet.membershipGiftingDetails)
    return { ...base, kind: "gift", amount: snippet.membershipGiftingDetails.giftMembershipsCount };
  return null;
}

/**
 * The support events of one page of YouTube live chat messages. The delivery ID is the ID of the message: YouTube
 * gives a message one ID, and a page that comes again has the same IDs. YouTube has no anonymous support in chat.
 */
export function youtubeSupport(items: readonly YoutubeMessage[], receivedAt: number): ActivitySupport[] {
  const events: ActivitySupport[] = [];
  for (const item of items) {
    const detail = youtubeDetail(item.snippet);
    const author = item.authorDetails;
    if (!detail || !author || !id.safeParse(item.id).success) continue;
    const money: boolean = detail.kind === "super_chat" || detail.kind === "super_sticker";
    // Money needs an amount above zero and an ISO 4217 code, as the contract says.
    if (money && !(count.safeParse(detail.amount).success && currency.safeParse(detail.currency).success)) continue;
    const { kind, ...rest } = detail;
    const sender: Sender = { id: author.channelId, displayName: cleanText(author.displayName, 100) };
    events.push(support("youtube", kind, item.id, receivedAt, { ...rest, sender }));
  }
  return events;
}
