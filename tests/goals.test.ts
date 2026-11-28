import { describe, expect, it } from "vitest";
import { acceptDelivery, type ActivitySupport, type SupportKind, type SupportSource } from "../app/lib/activity";
import {
  GOAL_COUNTS,
  GOAL_TARGET,
  GOAL_TITLE_LENGTH,
  countSupport,
  goalAmount,
  goalProgressSchema,
  type GoalCount,
  type GoalProgress,
} from "../app/lib/goals";

// The goal of a page: what each count takes from a support event, and that an event counts one time.

function support(kind: SupportKind, change: Partial<ActivitySupport> = {}): ActivitySupport {
  const platform: SupportSource = change.platform ?? "twitch";
  const deliveryId: string = change.deliveryId ?? `d-${kind}`;
  return {
    kind,
    id: `${platform}:${deliveryId}`,
    platform,
    deliveryId,
    sender: { id: "u1", displayName: "Tess" },
    anonymous: false,
    amount: kind === "follow" || kind === "topic" ? null : 5,
    currency: null,
    receivedAt: 5000,
    replay: false,
    ...change,
  };
}

const started = (counts: GoalCount, value: number = 0): GoalProgress => ({ counts, value, startedAt: 1000 });

describe("what a goal counts", (): void => {
  it("has the six counts of the design, and the limits of the target and the title", (): void => {
    expect(GOAL_COUNTS).toEqual(["subs", "follows", "bits", "kicks", "chatters", "votes"]);
    expect(GOAL_TARGET).toEqual({ min: 1, max: 10_000_000, default: 25 });
    expect(GOAL_TITLE_LENGTH).toBe(60);
  });

  it("counts 1 for a subscription and a membership, and the gifts of a bundle", (): void => {
    expect(goalAmount("subs", support("subscription", { amount: 1 }))).toBe(1);
    // The amount of a subscription is its months: a month 14 is one subscription.
    expect(goalAmount("subs", support("subscription", { amount: 14 }))).toBe(1);
    expect(goalAmount("subs", support("membership", { platform: "youtube", amount: 7 }))).toBe(1);
    expect(goalAmount("subs", support("gift", { amount: 5 }))).toBe(5);
    expect(goalAmount("subs", support("gift", { platform: "kick", amount: 20, anonymous: true, sender: null }))).toBe(
      20,
    );
    // A gift without an amount is not valid in the feed. It counts nothing.
    expect(goalAmount("subs", support("gift", { amount: null }))).toBe(0);
  });

  it("counts 1 for a follow, and the amount of Bits and of KICKs", (): void => {
    expect(goalAmount("follows", support("follow"))).toBe(1);
    expect(goalAmount("bits", support("bits", { amount: 250 }))).toBe(250);
    expect(goalAmount("kicks", support("kicks", { platform: "kick", amount: 40 }))).toBe(40);
  });

  it("counts one thing: no other kind, and no conversion between units", (): void => {
    const kinds: Record<GoalCount, SupportKind[]> = {
      subs: ["subscription", "membership", "gift"],
      follows: ["follow"],
      bits: ["bits"],
      kicks: ["kicks"],
      chatters: [],
      votes: [],
    };
    const all: SupportKind[] = [
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
    ];
    for (const counts of GOAL_COUNTS)
      for (const kind of all)
        expect(goalAmount(counts, support(kind)) > 0, `${counts} ${kind}`).toBe(kinds[counts].includes(kind));
  });

  it("never counts a replay: a replay of the owner, a test, and the snapshot of a reconnect", (): void => {
    for (const counts of GOAL_COUNTS)
      for (const kind of ["subscription", "gift", "follow", "bits", "kicks"] as const)
        expect(goalAmount(counts, support(kind, { replay: true })), `${counts} ${kind}`).toBe(0);
  });
});

describe("the count of a goal", (): void => {
  it("adds the amount of an event, and keeps the progress for an event that does not count", (): void => {
    const zero: GoalProgress = started("subs");
    const five: GoalProgress = countSupport(zero, support("gift", { amount: 5 }));
    expect(five).toEqual({ counts: "subs", value: 5, startedAt: 1000 });
    expect(zero.value).toBe(0);
    expect(countSupport(five, support("subscription", { deliveryId: "s1" })).value).toBe(6);
    // The same object: nothing to store and nothing to send.
    expect(countSupport(five, support("bits"))).toBe(five);
    expect(countSupport(five, support("gift", { replay: true }))).toBe(five);
  });

  it("counts a live gift of 5 one time: a replay, a test, and a provider retry leave it at 5", (): void => {
    // The server refuses a known ID (acceptDelivery) and then counts.
    let seen: readonly string[] = [];
    let progress: GoalProgress = started("subs");
    const receive = (event: ActivitySupport): void => {
      const delivery = acceptDelivery(seen, event);
      seen = delivery.seen;
      if (delivery.accepted) progress = countSupport(progress, event);
    };
    const gift: ActivitySupport = support("gift", { deliveryId: "g1", amount: 5 });
    receive(gift);
    expect(progress.value).toBe(5);
    // The provider sends the delivery again.
    receive({ ...gift, receivedAt: 9000 });
    // A replay and a test have the replay mark, also with an ID that the server does not know.
    receive({ ...gift, replay: true });
    receive(support("gift", { deliveryId: "test-1", amount: 5, replay: true }));
    expect(progress.value).toBe(5);
    receive(support("gift", { deliveryId: "g2", amount: 2 }));
    expect(progress.value).toBe(7);
  });

  it("does not count an event from before the start of the count", (): void => {
    const progress: GoalProgress = started("bits", 100);
    // YouTube sends an old message again a long time after it: the time of the platform decides.
    expect(countSupport(progress, support("bits", { sentAt: 999, receivedAt: 5000 }))).toBe(progress);
    expect(countSupport(progress, support("bits", { sentAt: 1000, receivedAt: 5000 })).value).toBe(105);
    // Without a time of the platform, the receive time decides.
    expect(countSupport(progress, support("bits", { receivedAt: 999 }))).toBe(progress);
    expect(countSupport(progress, support("bits", { receivedAt: 1000 })).value).toBe(105);
  });

  it("stops at the largest safe number", (): void => {
    const full: GoalProgress = started("bits", Number.MAX_SAFE_INTEGER - 2);
    const next: GoalProgress = countSupport(full, support("bits", { amount: 500 }));
    expect(next.value).toBe(Number.MAX_SAFE_INTEGER);
    expect(goalProgressSchema.safeParse(next).success).toBe(true);
  });

  it("reads a progress, and refuses one that is not correct", (): void => {
    const progress: GoalProgress = started("follows", 17);
    expect(goalProgressSchema.parse({ ...progress, more: true })).toEqual(progress);
    for (const wrong of [
      { ...progress, counts: "likes" },
      { ...progress, value: -1 },
      { ...progress, value: 1.5 },
      { ...progress, startedAt: -1 },
      { counts: "subs", value: 1 },
      null,
    ])
      expect(goalProgressSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
  });
});
