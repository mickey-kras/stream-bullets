import { describe, expect, it } from "vitest";
import {
  acceptDelivery,
  activityEventSchema,
  supportTotals,
  type ActivityEvent,
  type ActivitySupport,
} from "../app/lib/activity";
import { youtubeEvents } from "../app/server/channel-normalize";
import { youtubeMessageSchema, type YoutubeMessage } from "../app/server/channel-providers.server";
import {
  KICK_SUPPORT_EVENTS,
  TWITCH_SUPPORT_TYPES,
  kickSupport,
  twitchSupport,
  youtubeSupport,
} from "../app/server/channel-support";
import kickFixture from "./fixtures/providers/kick-support.json";
import twitchFixture from "./fixtures/providers/twitch-support.json";
import youtubeFixture from "./fixtures/providers/youtube-support.json";

/**
 * Support events from the payloads that the providers document (tests/fixtures/providers). Each fixture names its
 * source. A delivery that comes again makes the same event ID, and a gift bundle makes one event.
 */

const now = 1_794_000_000_000;
const twitchPayloads: Record<string, unknown> = twitchFixture.events;
const kickPayloads: Record<string, unknown> = kickFixture.events;
const youtubeItems: YoutubeMessage[] = youtubeFixture.items.map(
  (item: unknown): YoutubeMessage => youtubeMessageSchema.parse(item),
);

/** The one event of a payload, checked against the contract of the feed. */
function one(events: ActivitySupport[]): ActivitySupport {
  expect(events).toHaveLength(1);
  expect(activityEventSchema.safeParse(events[0]).success).toBe(true);
  return events[0];
}

/** The subscription type of a fixture name such as `channel.cheer (anonymous)`. */
const typeOf = (name: string): string => name.split(" ")[0];
const twitch = (name: string, deliveryId: string = "d1"): ActivitySupport[] =>
  twitchSupport(typeOf(name), twitchPayloads[name], deliveryId, now);
const kick = (name: string, deliveryId: string = "01JKICKDELIVERY"): ActivitySupport[] =>
  kickSupport(typeOf(name), kickPayloads[name], deliveryId, now);

describe("Twitch support events", (): void => {
  it("reads each documented EventSub example", (): void => {
    const user = { id: "1234", displayName: "Cool_User" };
    expect(one(twitch("channel.follow"))).toEqual({
      kind: "follow",
      id: "twitch:d1",
      platform: "twitch",
      deliveryId: "d1",
      sender: user,
      anonymous: false,
      amount: null,
      currency: null,
      receivedAt: now,
      replay: false,
    });
    expect(one(twitch("channel.subscribe"))).toMatchObject({ kind: "subscription", sender: user, amount: 1 });
    // The message of a subscriber has all the months so far, and its text.
    expect(one(twitch("channel.subscription.message"))).toMatchObject({
      kind: "subscription",
      sender: user,
      amount: 15,
      text: "Love the stream! FevziGG",
    });
    expect(one(twitch("channel.cheer"))).toMatchObject({
      kind: "bits",
      sender: user,
      amount: 1000,
      text: "Cheer1000 pogchamp",
    });
    // The sender of a raid is the channel that raids.
    expect(one(twitch("channel.raid"))).toMatchObject({ kind: "raid", sender: user, amount: 9001, currency: null });
  });

  it("makes one event for a gift bundle, and none for each person who got a gift", (): void => {
    expect(one(twitch("channel.subscription.gift"))).toMatchObject({ kind: "gift", amount: 2, anonymous: false });
    expect(twitch("channel.subscribe (a gift of a bundle)")).toEqual([]);
  });

  it("names nobody for an anonymous cheer and an anonymous gift", (): void => {
    for (const name of ["channel.cheer (anonymous)", "channel.subscription.gift (anonymous)"]) {
      const event = one(twitch(name));
      expect(event.anonymous, name).toBe(true);
      expect(event.sender, name).toBeNull();
      expect(JSON.stringify(event), name).not.toContain("Cool_User");
    }
  });

  it("gives the same event ID for a delivery that Twitch sends again, so it counts one time", (): void => {
    const first = one(twitch("channel.cheer", "retry-1"));
    const again = one(twitch("channel.cheer", "retry-1"));
    expect(again.id).toBe(first.id);
    const kept = acceptDelivery([], first);
    expect(kept.accepted).toBe(true);
    expect(acceptDelivery(kept.seen, again).accepted).toBe(false);
    expect(supportTotals([first, again]).amounts.bits).toBe(1000);
    // A different delivery of the same payload is a different event.
    expect(one(twitch("channel.cheer", "retry-2")).id).not.toBe(first.id);
  });

  it("gives no event for a payload or a type that is not as the reference says", (): void => {
    expect(
      twitchSupport("channel.cheer", { ...(twitchPayloads["channel.cheer"] as object), bits: 0 }, "d1", now),
    ).toEqual([]);
    expect(twitchSupport("channel.raid", { viewers: 5 }, "d1", now)).toEqual([]);
    expect(twitchSupport("channel.follow", null, "d1", now)).toEqual([]);
    expect(twitchSupport("channel.follow", twitchPayloads["channel.follow"], "not a valid id", now)).toEqual([]);
    // A cheer also sends `channel.bits.use`. The feed reads `channel.cheer` only, so Bits count one time.
    expect(TWITCH_SUPPORT_TYPES).not.toContain("channel.bits.use");
    expect(twitchSupport("channel.bits.use", twitchPayloads["channel.cheer"], "d1", now)).toEqual([]);
    expect(twitchSupport("channel.chat.message", twitchPayloads["channel.follow"], "d1", now)).toEqual([]);
  });

  it("removes control characters from the text and the name, and bounds the text", (): void => {
    const event = one(
      twitchSupport(
        "channel.cheer",
        { ...(twitchPayloads["channel.cheer"] as object), user_name: "Co\u202Eol", message: `a\u0000b${"x".repeat(900)}` },
        "d1",
        now,
      ),
    );
    expect(event.sender?.displayName).toBe("Cool");
    expect(event.text?.startsWith("abx")).toBe(true);
    expect(event.text).toHaveLength(500);
  });
});

describe("Kick support events", (): void => {
  it("reads each documented webhook example", (): void => {
    expect(one(kick("channel.followed"))).toEqual({
      kind: "follow",
      id: "kick:channel.followed:987654321",
      platform: "kick",
      deliveryId: "channel.followed:987654321",
      sender: { id: "987654321", displayName: "follower_name" },
      anonymous: false,
      amount: null,
      currency: null,
      receivedAt: now,
      replay: false,
    });
    expect(one(kick("channel.subscription.new"))).toMatchObject({
      kind: "subscription",
      sender: { id: "987654321", displayName: "subscriber_name" },
      amount: 1,
    });
    expect(one(kick("channel.subscription.renewal"))).toMatchObject({ kind: "subscription", amount: 3 });
    expect(one(kick("kicks.gifted"))).toMatchObject({
      kind: "kicks",
      sender: { id: "987654321", displayName: "gift_sender" },
      amount: 500,
      text: "w",
    });
  });

  it("makes one event for a gift bundle, with the number of people who got a gift", (): void => {
    expect(one(kick("channel.subscription.gifts"))).toMatchObject({
      kind: "gift",
      sender: { id: "987654321", displayName: "gifter_name" },
      anonymous: false,
      amount: 1,
    });
    const bundle = one(kick("channel.subscription.gifts (anonymous, a bundle of 3)"));
    expect(bundle).toMatchObject({ kind: "gift", sender: null, anonymous: true, amount: 3 });
    // The people who got a gift are not supporters: the event names none of them.
    expect(JSON.stringify(bundle)).not.toContain("giftee");
  });

  it("gives the same event ID for a delivery that Kick sends again", (): void => {
    const first = one(kick("kicks.gifted", "01JSAME"));
    expect(acceptDelivery(acceptDelivery([], first).seen, one(kick("kicks.gifted", "01JSAME"))).accepted).toBe(false);
  });

  it("gives the same event ID for a copy with a different message ID, so the copy counts one time", (): void => {
    // Kick signs the webhooks of all apps with one key: a different app can send its copy of a real event.
    for (const name of Object.keys(kickPayloads)) {
      const first = one(kick(name, "01JFIRST"));
      const copy = one(kick(name, "01JCOPY"));
      expect(copy.id, name).toBe(first.id);
      expect(first.id, name).not.toContain("01JFIRST");
      expect(acceptDelivery(acceptDelivery([], first).seen, copy).accepted, name).toBe(false);
    }
    expect(one(kick("kicks.gifted")).id).toBe("kick:kicks.gifted:987654321:2025-10-20T04:00:08.634Z:500");
    // A different time, a different person, or a different bundle is a different event.
    const gifted = kickPayloads["kicks.gifted"] as Record<string, unknown>;
    const later = one(kickSupport("kicks.gifted", { ...gifted, created_at: "2025-10-20T04:00:09.000Z" }, "d", now));
    expect(later.id).not.toBe(one(kick("kicks.gifted")).id);
    expect(one(kick("channel.subscription.gifts")).id).not.toBe(
      one(kick("channel.subscription.gifts (anonymous, a bundle of 3)")).id,
    );
    expect(one(kick("channel.subscription.new")).id).not.toBe(one(kick("channel.subscription.renewal")).id);
  });

  it("uses the message ID for an event without its time", (): void => {
    const gifted: Record<string, unknown> = Object.fromEntries(
      Object.entries(kickPayloads["kicks.gifted"] as object).filter(([key]: [string, unknown]) => key !== "created_at"),
    );
    expect(one(kickSupport("kicks.gifted", gifted, "01JMESSAGE", now)).id).toBe("kick:01JMESSAGE");
    expect(kickSupport("kicks.gifted", gifted, "not a valid id", now)).toEqual([]);
    expect(kickSupport("kicks.gifted", { ...gifted, created_at: "not a time" }, "01JMESSAGE", now)).toEqual([]);
  });

  it("gives no event for a payload or an event that is not as the documentation says", (): void => {
    expect(kickSupport("channel.subscription.gifts", { gifter: {}, giftees: [] }, "d1", now)).toEqual([]);
    expect(kickSupport("kicks.gifted", { sender: {}, gift: { amount: 5 } }, "d1", now)).toEqual([]);
    // Kick also sends reward redemptions. The feed does not read them.
    expect(KICK_SUPPORT_EVENTS).not.toContain("channel.reward.redemption.updated");
    expect(kickSupport("channel.reward.redemption.updated", kickPayloads["channel.followed"], "d1", now)).toEqual([]);
    expect(kickSupport("chat.message.sent", kickPayloads["channel.followed"], "d1", now)).toEqual([]);
  });
});

describe("YouTube support events", (): void => {
  const viewer = { id: "UCviewer0000000000000001", displayName: "Viewer One" };

  it("reads the support messages of a page of live chat, and keeps the chat for the chat normalizer", (): void => {
    const events = youtubeSupport(youtubeItems, now);
    for (const event of events) expect(activityEventSchema.safeParse(event).success, event.id).toBe(true);
    expect(
      events.map((event: ActivitySupport) => [event.kind, event.deliveryId, event.amount, event.currency]),
    ).toEqual([
      ["super_chat", "LCC.superchat1", 5_000_000, "USD"],
      ["super_sticker", "LCC.sticker1", 2_000_000, "EUR"],
      ["membership", "LCC.member1", 1, null],
      ["membership", "LCC.milestone1", 7, null],
      ["gift", "LCC.gifting1", 5, null],
    ]);
    expect(events[0]).toMatchObject({
      id: "youtube:LCC.superchat1",
      sender: viewer,
      anonymous: false,
      text: "Great stream",
    });
    expect(events[1].text).toBeUndefined();
    expect(events[3].text).toBe("Seven months");
    // The chat normalizer still reads the text message of the page, and no support message.
    const chat: ActivityEvent[] = youtubeEvents(youtubeItems, "UCchannel", now);
    expect(chat.map((event: ActivityEvent): string => event.kind)).toEqual(["chat"]);
  });

  it("makes one event for a gift bundle: the message of each person who got a gift gives none", (): void => {
    const received = youtubeItems.filter((item: YoutubeMessage) => item.snippet.type === "giftMembershipReceivedEvent");
    expect(received).toHaveLength(2);
    expect(youtubeSupport(received, now)).toEqual([]);
    expect(supportTotals(youtubeSupport(youtubeItems, now)).amounts.gift).toBe(5);
  });

  it("gives the same event ID for a page that comes again", (): void => {
    const first = youtubeSupport(youtubeItems, now);
    const again = youtubeSupport(youtubeItems, now + 5000);
    expect(again.map((event: ActivitySupport): string => event.id)).toEqual(
      first.map((event: ActivitySupport): string => event.id),
    );
    expect(supportTotals([...first, ...again]).money).toEqual({ USD: 5_000_000, EUR: 2_000_000 });
  });

  it("gives no event for money without an amount or a currency code, and still parses the page", (): void => {
    const [superChat] = youtubeFixture.items;
    const broken = (details: Record<string, unknown>): YoutubeMessage =>
      youtubeMessageSchema.parse({ ...superChat, snippet: { ...superChat.snippet, superChatDetails: details } });
    expect(youtubeSupport([broken({ amountMicros: "0", currency: "USD" })], now)).toEqual([]);
    expect(youtubeSupport([broken({ amountMicros: "1000000", currency: "dollars" })], now)).toEqual([]);
    // A detail that is not as documented does not refuse the item.
    expect(youtubeSupport([broken({ amountMicros: "one", currency: 5 })], now)).toEqual([]);
    // A message without its author gives no event.
    const noAuthor = youtubeMessageSchema.parse({ id: superChat.id, snippet: superChat.snippet });
    expect(youtubeSupport([noAuthor], now)).toEqual([]);
  });
});
