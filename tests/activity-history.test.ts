import { describe, expect, it } from "vitest";
import type { ActivityChat, ActivityEvent, ActivityMessage, ActivityPlatform } from "../app/lib/activity";
import {
  HISTORY_SIZE,
  emptyHistory,
  historyMessages,
  historySnapshot,
  keepHistory,
  type ActivityHistory,
  type AlertsStateMessage,
} from "../app/lib/activity-history";
import type { AlertView } from "../app/lib/alerts";

// What an activity feed keeps for a reader that subscribes after the snapshot of the socket.

function chat(n: number, platform: ActivityPlatform = "twitch", user: string = `u${n}`): ActivityChat {
  const text = `message ${n}`;
  return {
    kind: "chat",
    id: `${platform}:m${n}`,
    platform,
    channelId: "c1",
    messageId: `m${n}`,
    user: { id: user, displayName: user },
    text,
    fragments: [{ type: "text", text }],
    badges: [],
    sentAt: null,
    receivedAt: 1000 + n,
    live: true,
  };
}

const snapshot = (events: ActivityEvent[], since?: number): ActivityMessage =>
  since === undefined ? { type: "snapshot", events, replay: true } : { type: "snapshot", events, replay: true, since };
const event = (value: ActivityEvent): ActivityMessage => ({ type: "event", event: value });

function after(...messages: ActivityMessage[]): ActivityHistory {
  return messages.reduce(keepHistory, emptyHistory());
}

function kept(history: ActivityHistory): string[] {
  const message = historySnapshot(history);
  if (message?.type !== "snapshot") throw new Error("The feed has no snapshot for a reader.");
  return message.events.map((value: ActivityEvent): string => (value.kind === "chat" ? value.id : value.kind));
}

describe("the chat that a feed keeps for a late reader", (): void => {
  it("has nothing for a reader before the socket sent its snapshot", (): void => {
    expect(historySnapshot(emptyHistory())).toBeNull();
    // An event before the snapshot is in the snapshot that comes: the feed does not keep it twice.
    expect(historySnapshot(after(event(chat(1))))).toBeNull();
  });

  it("gives the chat of the snapshot and of the events after it, with the boundary of the server", (): void => {
    const history = after(snapshot([chat(1), chat(2)], 900), event(chat(3)), event(chat(3)));
    expect(historySnapshot(history)).toEqual({
      type: "snapshot",
      events: [chat(1), chat(2), chat(3)],
      replay: true,
      since: 900,
    });
    // A snapshot without a boundary gives none.
    expect(historySnapshot(after(snapshot([chat(1)])))).toEqual({ type: "snapshot", events: [chat(1)], replay: true });
    // An empty snapshot is a snapshot: the reader learns that the chat is empty.
    expect(kept(after(snapshot([])))).toEqual([]);
  });

  it("leaves out each message that moderation removed", (): void => {
    const start = snapshot([
      chat(1, "twitch", "ann"),
      chat(2, "youtube", "ann"),
      chat(3, "twitch", "bob"),
      chat(4, "kick"),
    ]);
    const removed = (value: ActivityEvent): string[] => kept(after(start, event(value)));
    expect(removed({ kind: "delete", platform: "twitch", messageId: "m3", receivedAt: 2000 })).toEqual([
      "twitch:m1",
      "youtube:m2",
      "kick:m4",
    ]);
    // A ban and a clear of one user remove the messages of that user on that platform only.
    const ban: ActivityEvent = { kind: "ban", platform: "twitch", userId: "ann", until: null, receivedAt: 2000 };
    expect(removed(ban)).toEqual(["youtube:m2", "twitch:m3", "kick:m4"]);
    expect(removed({ kind: "clear_user", platform: "youtube", userId: "ann", receivedAt: 2000 })).toEqual([
      "twitch:m1",
      "twitch:m3",
      "kick:m4",
    ]);
    expect(removed({ kind: "clear", platform: "twitch", receivedAt: 2000 })).toEqual(["youtube:m2", "kick:m4"]);
    // A status and a message of another kind change nothing.
    const same = after(start);
    expect(keepHistory(same, event({ kind: "status", platform: "kick", status: "active" }))).toBe(same);
    expect(keepHistory(same, event({ kind: "delete", platform: "kick", messageId: "none", receivedAt: 1 }))).toBe(same);
  });

  it("keeps no support event: an alert must not play again for a late reader", (): void => {
    const support: ActivityEvent = {
      kind: "follow",
      id: "twitch:d1",
      platform: "twitch",
      deliveryId: "d1",
      sender: { id: "u9", displayName: "Fan" },
      anonymous: false,
      amount: null,
      currency: null,
      receivedAt: 1500,
      replay: false,
    };
    expect(kept(after(snapshot([chat(1), support]), event(support)))).toEqual(["twitch:m1"]);
  });

  it("keeps as many messages as a snapshot of the server, and moves the boundary past each one that left", (): void => {
    const many: ActivityChat[] = Array.from({ length: HISTORY_SIZE + 5 }, (_, n: number): ActivityChat => chat(n));
    const history = many
      .slice(1)
      .reduce(
        (state: ActivityHistory, value: ActivityChat): ActivityHistory => keepHistory(state, event(value)),
        after(snapshot([many[0]], 500)),
      );
    const message = historySnapshot(history);
    expect(message).toMatchObject({ type: "snapshot", since: many[4].receivedAt });
    expect(kept(history)).toEqual(many.slice(5).map((value: ActivityChat): string => value.id));
    // The boundary of the server stays when it is newer than each message that left.
    const late = many
      .slice(0, HISTORY_SIZE + 1)
      .reduce(
        (state: ActivityHistory, value: ActivityChat): ActivityHistory => keepHistory(state, event(value)),
        after(snapshot([], 5000)),
      );
    expect(historySnapshot(late)).toMatchObject({ since: 5000 });
  });

  it("starts again when the feed is not available, and at each new snapshot", (): void => {
    expect(historySnapshot(after(snapshot([chat(1)]), { type: "unavailable" }))).toBeNull();
    expect(kept(after(snapshot([chat(1)]), event(chat(2)), snapshot([chat(7)], 10)))).toEqual(["twitch:m7"]);
  });
});

describe("the state of the alerts that a feed keeps for a late reader", (): void => {
  const alert: AlertView = {
    id: "twitch:d1",
    origin: "live",
    kind: "gift",
    platform: "twitch",
    name: "LanternFox",
    anonymous: false,
    amount: 5,
    currency: null,
    banner: true,
    chat: true,
    startsAt: 5000,
    endsAt: 11_000,
  };
  const state = (at: number, more: Partial<AlertsStateMessage> = {}): AlertsStateMessage => ({
    type: "alerts",
    at,
    muted: false,
    current: null,
    waiting: 0,
    goal: { counts: "subs", value: 17, startedAt: 0 },
    ...more,
  });

  it("has no message before the socket sent one", (): void => {
    expect(emptyHistory().alerts).toBeNull();
    expect(historyMessages(emptyHistory())).toEqual([]);
  });

  it("gives the snapshot and then the last state, in the sequence of the socket", (): void => {
    const last: AlertsStateMessage = state(6000, { current: alert, waiting: 2 });
    const history = after(snapshot([chat(1)], 900), state(5000), event(chat(2)), last);
    expect(history.alerts).toBe(last);
    expect(historyMessages(history)).toEqual([
      { type: "snapshot", events: [chat(1), chat(2)], replay: true, since: 900 },
      last,
    ]);
    // The state has the times of the alert on stream, so the reader shows only the time that is left.
    expect(history.alerts?.current).toMatchObject({ startsAt: 5000, endsAt: 11_000 });
  });

  it("keeps the state when the snapshot comes after it, and gives it without a snapshot", (): void => {
    const first: AlertsStateMessage = state(5000);
    expect(historyMessages(after(first))).toEqual([first]);
    expect(historyMessages(after(first, snapshot([chat(1)])))).toEqual([
      { type: "snapshot", events: [chat(1)], replay: true },
      first,
    ]);
  });

  it("keeps no alert that plays at once: it must not play again for a late reader", (): void => {
    const follow: ActivityMessage = { type: "alert", alert: { ...alert, id: "twitch:f1", banner: false, endsAt: 5000 } };
    const history = after(snapshot([chat(1)]), follow);
    expect(history.alerts).toBeNull();
    expect(historyMessages(history)).toEqual([{ type: "snapshot", events: [chat(1)], replay: true }]);
  });

  it("starts again when the feed is not available", (): void => {
    expect(historyMessages(after(snapshot([chat(1)]), state(5000), { type: "unavailable" }))).toEqual([]);
  });
});
