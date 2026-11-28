import { describe, expect, it } from "vitest";
import type { ActivityChat, ActivityMessage } from "../app/lib/activity";
import {
  INITIAL_ALERTS,
  NO_ALERTS,
  SAMPLE_ALERT,
  alertFace,
  alertsAfter,
  bannerMs,
  chatMark,
  goalBar,
  type AlertsSeen,
} from "../app/lib/alert-feed";
import { ALERT_SHOW_MS, alertViewSchema, type AlertView } from "../app/lib/alerts";
import { SAMPLE_CHAT } from "../app/lib/chat-feed";
import type { GoalProgress } from "../app/lib/goals";

// What an overlay page makes of the alert messages of the activity socket: the alert on stream and its time, the
// mark in chat, and the bar of the goal.

/** Server time of the fixtures. */
const T0 = 1_800_000_000_000;

function view(override: Partial<AlertView> = {}): AlertView {
  return {
    id: "twitch:d1",
    origin: "live",
    kind: "gift",
    platform: "twitch",
    name: "LanternFox",
    anonymous: false,
    amount: 5,
    currency: null,
    text: "A message of the supporter",
    banner: true,
    chat: true,
    startsAt: T0,
    endsAt: T0 + ALERT_SHOW_MS,
    ...override,
  };
}

const goal: GoalProgress = { counts: "subs", value: 17, startedAt: T0 - 60_000 };

function alerts(
  current: AlertView | null,
  more: Partial<Extract<ActivityMessage, { type: "alerts" }>> = {},
): ActivityMessage {
  return { type: "alerts", at: T0, muted: false, current, waiting: 0, goal: null, ...more };
}

describe("the face of an alert", (): void => {
  it("has who, what and where from, and never the text of the supporter", (): void => {
    const face = alertFace(view());
    expect(face).toEqual({
      id: "twitch:d1",
      origin: "live",
      kind: "gift",
      platform: "twitch",
      name: "LanternFox",
      anonymous: false,
      amount: 5,
      currency: null,
    });
    expect(Object.keys(face)).not.toContain("text");
    expect(JSON.stringify(face)).not.toContain("A message of the supporter");
  });

  it("has no name for an anonymous alert, also when a faulty producer sends one", (): void => {
    expect(alertFace(view({ anonymous: true, name: null })).name).toBeNull();
    const faulty: AlertView = view({ anonymous: true, name: "LanternFox" });
    // The parser refuses this view. The page does not depend on it.
    expect(alertViewSchema.safeParse(faulty).success).toBe(false);
    expect(JSON.stringify(alertFace(faulty))).not.toContain("LanternFox");
  });

  it("has a sample for the editor preview that is a valid alert without an end", (): void => {
    expect(
      alertViewSchema.safeParse({ ...SAMPLE_ALERT, banner: true, chat: true, startsAt: 0, endsAt: 0 }).success,
    ).toBe(true);
    expect(SAMPLE_ALERT.origin).toBe("live");
  });
});

describe("the state of the alerts on a page", (): void => {
  it("starts with no alert, no line, and no count of the goal", (): void => {
    expect(INITIAL_ALERTS).toEqual({ state: NO_ALERTS, seenAt: 0 });
    expect(NO_ALERTS).toEqual({ muted: false, current: null, waiting: 0, goal: null });
    expect(bannerMs(INITIAL_ALERTS, 0)).toBe(0);
  });

  it("takes each `alerts` message as the whole state", (): void => {
    const first: AlertsSeen = alertsAfter(INITIAL_ALERTS, alerts(view(), { waiting: 2, goal }), 5000);
    expect(first).toEqual({ state: { muted: false, current: view(), waiting: 2, goal }, seenAt: 5000 });
    const muted: AlertsSeen = alertsAfter(first, alerts(null, { muted: true, goal }), 6000);
    expect(muted).toEqual({ state: { muted: true, current: null, waiting: 0, goal }, seenAt: 0 });
    // The message has more fields than the state: the page keeps the fields of the state only.
    expect(Object.keys(first.state).sort()).toEqual(["current", "goal", "muted", "waiting"]);
  });

  it("keeps the time of the first message while the server sends the same alert again", (): void => {
    const first: AlertsSeen = alertsAfter(INITIAL_ALERTS, alerts(view()), 5000);
    // The goal counted during the alert: a new state with the same alert on stream.
    const again: AlertsSeen = alertsAfter(first, alerts(view(), { goal: { ...goal, value: 18 } }), 7000);
    expect(again.seenAt).toBe(5000);
    expect(again.state.goal?.value).toBe(18);
    // The next alert, and a replay of the first one, are new plays.
    expect(alertsAfter(again, alerts(view({ id: "twitch:d2" })), 11_000).seenAt).toBe(11_000);
    expect(alertsAfter(again, alerts(view({ id: "twitch:d1~r1", origin: "replay" })), 12_000).seenAt).toBe(12_000);
  });

  it("returns the same state for each message that is not about alerts", (): void => {
    const seen: AlertsSeen = alertsAfter(INITIAL_ALERTS, alerts(view()), 5000);
    const chat: ActivityChat = SAMPLE_CHAT[0];
    const others: ActivityMessage[] = [
      { type: "snapshot", events: [chat], replay: true },
      { type: "event", event: chat },
      // An alert without a banner plays at once: it is not the alert on stream.
      { type: "alert", alert: view({ id: "twitch:f1", banner: false, endsAt: T0 }) },
    ];
    for (const message of others) expect(alertsAfter(seen, message, 9000)).toBe(seen);
  });

  it("ends the alert when the feed is not available, and keeps the mute state and the goal", (): void => {
    const seen: AlertsSeen = alertsAfter(INITIAL_ALERTS, alerts(view(), { muted: false, waiting: 3, goal }), 5000);
    expect(alertsAfter(seen, { type: "unavailable" }, 6000)).toEqual({
      state: { muted: false, current: null, waiting: 0, goal },
      seenAt: 0,
    });
    expect(alertsAfter(INITIAL_ALERTS, { type: "unavailable" }, 6000)).toBe(INITIAL_ALERTS);
    // Only a line that waits: it also goes.
    const waiting: AlertsSeen = alertsAfter(INITIAL_ALERTS, alerts(null, { waiting: 1 }), 5000);
    expect(alertsAfter(waiting, { type: "unavailable" }, 6000).state.waiting).toBe(0);
  });
});

describe("the time of the banner", (): void => {
  /** A page whose clock is `offset` behind the server gets the alert at the server time `at`. */
  const seenAt = (at: number, offset: number, alert: AlertView = view()): AlertsSeen =>
    alertsAfter(INITIAL_ALERTS, alerts(alert), at - offset);

  it("is the time of the alert for a page that gets it at its start", (): void => {
    expect(bannerMs(seenAt(T0, 0), 0)).toBe(ALERT_SHOW_MS);
    // The offset of the clock of the page does not change the time.
    expect(bannerMs(seenAt(T0, 90_000), 90_000)).toBe(ALERT_SHOW_MS);
    expect(bannerMs(seenAt(T0, -90_000), -90_000)).toBe(ALERT_SHOW_MS);
  });

  it("is only the time that is left for a page that connects during the alert", (): void => {
    expect(bannerMs(seenAt(T0 + 4000, 250), 250)).toBe(2000);
    expect(bannerMs(seenAt(T0 + ALERT_SHOW_MS - 1, 0), 0)).toBe(1);
  });

  it("is zero for an alert that ended: a late server message shows no banner", (): void => {
    expect(bannerMs(seenAt(T0 + ALERT_SHOW_MS, 0), 0)).toBe(0);
    expect(bannerMs(seenAt(T0 + 60_000, 0), 0)).toBe(0);
  });

  it("is never longer than the alert, so a wrong clock of the page keeps no banner on stream", (): void => {
    // The page measured an offset that is 30 seconds wrong: by its clock the alert starts in the future.
    expect(bannerMs(seenAt(T0, 0), -30_000)).toBe(ALERT_SHOW_MS);
    // An alert without a banner has no time.
    expect(bannerMs(seenAt(T0, 0, view({ banner: false, endsAt: T0 })), 0)).toBe(0);
  });
});

describe("the alert that a chat marks", (): void => {
  it("marks an alert that plays at once, and the alert on stream, when the rule has the mark in chat on", (): void => {
    const follow: AlertView = view({ id: "twitch:f1", kind: "follow", amount: null, banner: false, endsAt: T0 });
    expect(chatMark({ type: "alert", alert: follow }, null, T0 + 10)).toBe(follow);
    expect(chatMark(alerts(view()), null, T0 + 10)).toEqual(view());
    expect(chatMark({ type: "alert", alert: { ...follow, chat: false } }, null, T0)).toBeNull();
    expect(chatMark(alerts(view({ chat: false })), null, T0)).toBeNull();
    expect(chatMark(alerts(null), null, T0)).toBeNull();
  });

  it("marks no alert that ended: a late state and the state that a late reader gets play nothing", (): void => {
    expect(chatMark(alerts(view()), null, T0 + ALERT_SHOW_MS - 1)).not.toBeNull();
    expect(chatMark(alerts(view()), null, T0 + ALERT_SHOW_MS)).toBeNull();
  });

  it("marks nothing for a message that is not about alerts", (): void => {
    expect(chatMark({ type: "event", event: SAMPLE_CHAT[0] }, null, T0)).toBeNull();
    expect(chatMark({ type: "snapshot", events: [], replay: true }, null, T0)).toBeNull();
    expect(chatMark({ type: "unavailable" }, null, T0)).toBeNull();
  });
});

describe("the bar of the goal", (): void => {
  const layer = { counts: "subs", target: 25 } as const;

  it("is empty at 0, before the server sent a count", (): void => {
    expect(goalBar(layer, null)).toEqual({ value: 0, target: 25, part: 0 });
    expect(goalBar(layer, { ...goal, value: 0 })).toEqual({ value: 0, target: 25, part: 0 });
  });

  it("is in the middle at 17 of 25", (): void => {
    expect(goalBar(layer, goal)).toEqual({ value: 17, target: 25, part: 0.68 });
  });

  it("is full at the target, and never more than full above it: the number stays the real count", (): void => {
    expect(goalBar(layer, { ...goal, value: 25 })).toEqual({ value: 25, target: 25, part: 1 });
    expect(goalBar(layer, { ...goal, value: 40 })).toEqual({ value: 40, target: 25, part: 1 });
  });

  it("starts at 0 while the server still counts a different thing than the layer", (): void => {
    expect(goalBar({ counts: "follows", target: 25 }, goal)).toEqual({ value: 0, target: 25, part: 0 });
  });

  it("never divides by a target below 1", (): void => {
    expect(goalBar({ counts: "subs", target: 0 }, goal)).toEqual({ value: 17, target: 1, part: 1 });
  });
});
