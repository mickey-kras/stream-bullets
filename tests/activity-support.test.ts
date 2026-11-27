import { describe, expect, it } from "vitest";
import {
  DELIVERIES_KEPT,
  MONEY_KINDS,
  SUPPORT_KINDS,
  acceptDelivery,
  isSupport,
  messageForPlatform,
  parseActivityMessage,
  supportTotals,
  type ActivityEvent,
  type ActivityMessage,
  type ActivitySupport,
  type SupportKind,
  type SupportSource,
} from "../app/lib/activity";
import { SAMPLE_CHAT, chatReducer, initialChatState, type ChatState } from "../app/lib/chat-feed";
import { initialLiveChat, liveChatReducer, type LiveChatState } from "../app/lib/live-chat";

// The support events of the activity feed: their format, one event for one delivery, and a replay that never counts.

/** A valid event of `kind`, with the amount and the currency that the kind needs. */
function support(kind: SupportKind, change: Partial<ActivitySupport> = {}): ActivitySupport {
  const direct: boolean = kind === "tip" || kind === "topic";
  const platform: SupportSource = change.platform ?? (direct ? "direct" : "twitch");
  const deliveryId: string = change.deliveryId ?? `d-${kind}`;
  return {
    kind,
    id: `${platform}:${deliveryId}`,
    platform,
    deliveryId,
    sender: { id: "u1", displayName: "Tess" },
    anonymous: false,
    amount: kind === "follow" || kind === "topic" ? null : 5,
    currency: MONEY_KINDS.has(kind) ? "EUR" : null,
    receivedAt: 1000,
    replay: false,
    ...change,
  };
}

const parsed = (event: unknown): ActivityMessage | null =>
  parseActivityMessage(JSON.stringify({ type: "event", event }));

describe("the format of a support event", (): void => {
  it("has the eleven kinds of the first issue and the topic credit, and three of them are money", (): void => {
    expect([...SUPPORT_KINDS]).toEqual([
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
      "topic",
    ]);
    expect([...MONEY_KINDS]).toEqual(["super_chat", "super_sticker", "tip"]);
  });

  it("accepts each kind with the amount and the currency of that kind", (): void => {
    for (const kind of SUPPORT_KINDS) {
      const event: ActivitySupport = support(kind, { text: kind === "super_chat" ? "gg" : undefined });
      expect(parsed(event), kind).toEqual({ type: "event", event });
      expect(isSupport(event)).toBe(true);
    }
    expect(isSupport(SAMPLE_CHAT[0])).toBe(false);
    // An anonymous event, and an event of a platform that does not name the sender.
    expect(parsed(support("gift", { anonymous: true, sender: null }))).not.toBeNull();
    expect(parsed(support("raid", { sender: null }))).not.toBeNull();
    // A replay is a valid event with its mark.
    expect(parsed(support("bits", { replay: true }))).not.toBeNull();
  });

  it("has the credit of a topic as a direct event without an amount, with the title as its text", (): void => {
    const credit: ActivitySupport = support("topic", { deliveryId: "topic:e1:7", text: "Which boss first?" });
    expect(credit).toMatchObject({ id: "direct:topic:e1:7", platform: "direct", amount: null, currency: null });
    expect(parsed(credit)).toEqual({ type: "event", event: credit });
    // It is not money and it has no count.
    expect(supportTotals([credit])).toEqual({ events: { topic: 1 }, amounts: {}, money: {} });
  });

  it("keeps the time of the platform when the event has one", (): void => {
    const timed: ActivitySupport = support("super_chat", { platform: "youtube", currency: "EUR", sentAt: 400 });
    expect(parsed(timed)).toEqual({ type: "event", event: timed });
    expect(parsed(support("bits"))).toEqual({ type: "event", event: support("bits") });
    for (const sentAt of [-1, 1.5, "400", null])
      expect(parsed({ ...support("bits"), sentAt }), String(sentAt)).toBeNull();
  });

  it("refuses an event that is not correct for its kind", (): void => {
    const wrong: [string, unknown][] = [
      ["a follow with an amount", support("follow", { amount: 1 })],
      ["Bits without an amount", support("bits", { amount: null })],
      ["an amount of zero", support("bits", { amount: 0 })],
      ["an amount below zero", support("raid", { amount: -3 })],
      ["an amount that is not a whole number", support("kicks", { amount: 1.5 })],
      ["a count with a currency", support("gift", { currency: "USD" })],
      ["money without a currency", support("super_chat", { currency: null })],
      ["a currency that is not a code", support("tip", { currency: "eur" })],
      ["a direct follow", support("follow", { platform: "direct" })],
      ["a tip from a platform", support("tip", { platform: "twitch" })],
      ["a Super Chat that is direct", support("super_chat", { platform: "direct" })],
      ["a topic credit from a platform", support("topic", { platform: "twitch" })],
      ["a topic credit with an amount", support("topic", { amount: 1 })],
      ["a topic credit with a currency", support("topic", { currency: "EUR" })],
      ["an anonymous event with a sender", support("gift", { anonymous: true })],
      ["an ID that is not the platform and the delivery ID", { ...support("bits"), id: "twitch:other" }],
      ["no delivery ID", { ...support("bits"), deliveryId: "" }],
      ["no replay mark", { ...support("bits"), replay: undefined }],
      ["no anonymous flag", { ...support("bits"), anonymous: undefined }],
      ["a text that is too long", support("super_chat", { text: "x".repeat(501) })],
      ["a platform that does not exist", { ...support("bits"), platform: "vimeo", id: "vimeo:d-bits" }],
    ];
    for (const [name, event] of wrong) expect(parsed(event), name).toBeNull();
  });
});

describe("a consumer and the kinds that it does not know", (): void => {
  const chat: ActivityEvent = SAMPLE_CHAT[0];
  const unknown = { kind: "hype_train", platform: "twitch", level: 3 };

  it("ignores an event of a kind that it does not know", (): void => {
    expect(parsed(unknown)).toBeNull();
  });

  it("keeps the other events of a snapshot with a kind that it does not know", (): void => {
    const snapshot = { type: "snapshot", replay: true, events: [chat, unknown, support("raid")] };
    expect(parseActivityMessage(JSON.stringify(snapshot))).toEqual({
      type: "snapshot",
      replay: true,
      events: [chat, support("raid")],
    });
    // An event of a known kind that is not valid refuses its snapshot, as before.
    const broken = { type: "snapshot", replay: true, events: [chat, support("follow", { amount: 2 })] };
    expect(parseActivityMessage(JSON.stringify(broken))).toBeNull();
    const many = { type: "snapshot", replay: true, events: Array.from({ length: 201 }, () => unknown) };
    expect(parseActivityMessage(JSON.stringify(many))).toBeNull();
  });

  it("leaves the chat of the overlay as it is for a support event, and Live shows the event as a row", (): void => {
    const event: ActivityMessage = { type: "event", event: support("bits") };
    const overlay: ChatState = initialChatState();
    expect(chatReducer(overlay, { type: "message", message: event, now: 1000 }, { hideCommands: false })).toBe(overlay);
    const live: LiveChatState = liveChatReducer(initialLiveChat(), { type: "message", message: event });
    expect(live.rows).toMatchObject([{ kind: "support", event: "bits", seq: 1 }]);
  });

  it("does not show a direct event or the support of a different platform in an output for Twitch only", (): void => {
    const twitch: ActivityMessage = { type: "event", event: support("bits") };
    expect(messageForPlatform(twitch, "twitch")).toBe(twitch);
    for (const event of [
      support("tip"),
      support("topic"),
      support("super_chat", { platform: "youtube" }),
      support("kicks", { platform: "kick" }),
    ])
      expect(messageForPlatform({ type: "event", event }, "twitch"), event.kind).toBeNull();
  });
});

describe("one event for one delivery", (): void => {
  const sources: SupportSource[] = ["twitch", "youtube", "kick", "direct"];

  for (const platform of sources)
    it(`makes no second event for a second delivery with the same ID (${platform})`, (): void => {
      const kind: SupportKind = platform === "direct" ? "tip" : "subscription";
      const first: ActivitySupport = support(kind, { platform, deliveryId: "delivery-1" });
      const one = acceptDelivery([], first);
      expect(one).toEqual({ accepted: true, seen: [`${platform}:delivery-1`] });
      // The provider sends the delivery again, for example after a timeout.
      const again = acceptDelivery(one.seen, { ...first, receivedAt: 9000 });
      expect(again.accepted).toBe(false);
      expect(again.seen).toBe(one.seen);
      // A different delivery is a new event.
      expect(acceptDelivery(one.seen, support(kind, { platform, deliveryId: "delivery-2" })).accepted).toBe(true);
    });

  it("keeps the same delivery ID of two platforms as two events", (): void => {
    const twitch = acceptDelivery([], support("follow", { platform: "twitch", deliveryId: "same" }));
    expect(acceptDelivery(twitch.seen, support("follow", { platform: "kick", deliveryId: "same" })).accepted).toBe(
      true,
    );
  });

  it("keeps a limited number of IDs, the newest ones", (): void => {
    let seen: readonly string[] = [];
    for (let index = 0; index < DELIVERIES_KEPT + 5; index += 1)
      seen = acceptDelivery(seen, support("bits", { deliveryId: `d${index}` })).seen;
    expect(seen).toHaveLength(DELIVERIES_KEPT);
    expect(seen.at(-1)).toBe(`twitch:d${DELIVERIES_KEPT + 4}`);
    expect(seen[0]).toBe("twitch:d5");
  });
});

describe("totals for a goal or a report", (): void => {
  const events: ActivitySupport[] = [
    support("bits", { deliveryId: "b1", amount: 100 }),
    support("bits", { deliveryId: "b2", amount: 250 }),
    support("follow", { deliveryId: "f1" }),
    support("super_chat", { platform: "youtube", deliveryId: "s1", amount: 5_000_000, currency: "EUR" }),
    support("tip", { deliveryId: "t1", amount: 2_500_000, currency: "EUR" }),
    support("tip", { deliveryId: "t2", amount: 3_000_000, currency: "USD" }),
  ];
  const totals = supportTotals(events);

  it("sums each kind in its native unit, and money for each currency without a conversion", (): void => {
    expect(totals).toEqual({
      events: { bits: 2, follow: 1, super_chat: 1, tip: 2 },
      amounts: { bits: 350 },
      money: { EUR: 7_500_000, USD: 3_000_000 },
    });
  });

  it("never counts a replay: a replayed alert changes no goal and no revenue record", (): void => {
    const replayed: ActivitySupport[] = [
      ...events,
      { ...events[0], replay: true },
      { ...events[4], replay: true },
      support("raid", { deliveryId: "r1", amount: 40, replay: true }),
    ];
    expect(supportTotals(replayed)).toEqual(totals);
    expect(supportTotals([support("tip", { replay: true })])).toEqual({ events: {}, amounts: {}, money: {} });
  });

  it("never counts the same event two times", (): void => {
    expect(supportTotals([...events, events[1], events[4]])).toEqual(totals);
  });
});
