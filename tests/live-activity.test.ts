import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, loadCatalog, setLocaleSource, t, type Locale } from "../app/i18n";
import type { ActivityChat, ActivityMessage, ActivitySupport } from "../app/lib/activity";
import { ALERT_REFUSALS, type AlertRefusal, type AlertsReply } from "../app/lib/alert-control";
import type { AlertView } from "../app/lib/alerts";
import { sampleSupportAt } from "../app/lib/chat-feed";
import {
  ACTIVITY_ROWS,
  INITIAL_ACTIVITY,
  REFUSAL_TEXT,
  REPLAY_KEPT,
  REPLAY_WINDOW_MS,
  activityAfter,
  nowLine,
  refusalText,
  replayable,
  secondsLeft,
  shownAlerts,
  type ActivityRow,
  type ActivityState,
  type ShownAlerts,
} from "../app/lib/live-activity";
import { SNAPSHOT_MAX_AGE_MS, SUPPORT_SNAPSHOT_SIZE } from "../app/server/channel-ingest-limits";

// The Activity part of Live and the dock as pure state: the rows, Replay, the state of the alerts, and refusals.

const T0 = 1_800_000_000_000;

afterEach((): void => {
  setLocaleSource((): Locale => DEFAULT_LOCALE);
});

function support(deliveryId: string, more: Partial<ActivitySupport> = {}): ActivitySupport {
  return {
    kind: "gift",
    id: `twitch:${deliveryId}`,
    platform: "twitch",
    deliveryId,
    sender: { id: "viewer-1", displayName: "LanternFox" },
    anonymous: false,
    amount: 5,
    currency: null,
    receivedAt: T0,
    replay: false,
    ...more,
  };
}

const chat: ActivityChat = {
  kind: "chat",
  id: "twitch:m1",
  platform: "twitch",
  channelId: "111",
  messageId: "m1",
  user: { id: "u1", displayName: "Chatter" },
  text: "hello",
  fragments: [{ type: "text", text: "hello" }],
  badges: [],
  sentAt: null,
  receivedAt: T0,
  live: true,
};

const event = (item: ActivitySupport | ActivityChat): ActivityMessage => ({ type: "event", event: item });

function after(messages: readonly ActivityMessage[], from: ActivityState = INITIAL_ACTIVITY): ActivityState {
  return messages.reduce(activityAfter, from);
}

function view(more: Partial<AlertView> = {}): AlertView {
  return {
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
    startsAt: T0,
    endsAt: T0 + 6000,
    ...more,
  };
}

describe("the rows of the activity", (): void => {
  it("lists support events newest first, without chat, and without a second row for a known ID", (): void => {
    const state: ActivityState = after([
      event(support("d1", { receivedAt: T0 })),
      event(chat),
      event(support("d2", { receivedAt: T0 + 2000, kind: "follow", amount: null })),
      // A provider retry and the copy of a snapshot have the same ID.
      event(support("d1", { receivedAt: T0 + 5000 })),
      { type: "snapshot", events: [chat, support("d2", { replay: true })], replay: true },
    ]);
    expect(state.rows.map((row: ActivityRow): string => row.id)).toEqual(["twitch:d2", "twitch:d1"]);
    expect(state.rows[1]).toEqual({
      id: "twitch:d1",
      kind: "gift",
      platform: "twitch",
      name: "LanternFox",
      amount: 5,
      currency: null,
      receivedAt: T0,
      original: true,
    });
  });

  it("keeps the events of a snapshot as originals, and an event that the server sends again as a replay", (): void => {
    const state: ActivityState = after([
      { type: "snapshot", events: [support("old", { replay: true })], replay: true },
      event(support("again", { replay: true, receivedAt: T0 + 1 })),
    ]);
    expect(state.rows.map((row: ActivityRow): [string, boolean] => [row.id, row.original])).toEqual([
      ["twitch:again", false],
      ["twitch:old", true],
    ]);
  });

  it("never shows a name for an anonymous event, and none for an event without a name", (): void => {
    const state: ActivityState = after([
      event(support("a", { anonymous: true, sender: null })),
      event(support("b", { sender: { id: "x", displayName: "" }, receivedAt: T0 + 1 })),
      event(support("c", { anonymous: true, receivedAt: T0 + 2 })),
    ]);
    expect(state.rows.map((row: ActivityRow): string | null => row.name)).toEqual([null, null, null]);
  });

  it("puts the later of two events with the same time first", (): void => {
    const state: ActivityState = after([
      { type: "snapshot", events: [support("a"), support("b")], replay: true },
      event(support("c")),
    ]);
    expect(state.rows.map((row: ActivityRow): string => row.id)).toEqual(["twitch:c", "twitch:b", "twitch:a"]);
  });

  it("keeps the newest rows only", (): void => {
    const messages: ActivityMessage[] = Array.from({ length: ACTIVITY_ROWS + 5 }, (_, n: number) =>
      event(support(`d${n}`, { receivedAt: T0 + n })),
    );
    const state: ActivityState = after(messages);
    expect(state.rows).toHaveLength(ACTIVITY_ROWS);
    expect(state.rows[0].id).toBe(`twitch:d${ACTIVITY_ROWS + 4}`);
    expect(state.rows.at(-1)?.id).toBe("twitch:d5");
  });

  it("changes nothing for other messages, and keeps the time of the newest alerts state", (): void => {
    const start: ActivityState = after([event(support("d1"))]);
    expect(activityAfter(start, event(chat))).toBe(start);
    expect(activityAfter(start, { type: "unavailable" })).toBe(start);
    expect(activityAfter(start, { type: "event", event: { kind: "clear", platform: "twitch", receivedAt: T0 } })).toBe(
      start,
    );
    const state = { type: "alerts", muted: false, current: null, waiting: 0, goal: null } as const;
    const seen: ActivityState = activityAfter(start, { ...state, at: T0 + 10 });
    expect(seen).toEqual({ rows: start.rows, kept: start.kept, alertsAt: T0 + 10 });
    // An older state that comes late does not move the time back.
    expect(activityAfter(seen, { ...state, at: T0 + 5 })).toBe(seen);
  });
});

describe("Replay", (): void => {
  it("uses the retention of the server", (): void => {
    expect(REPLAY_WINDOW_MS).toBe(SNAPSHOT_MAX_AGE_MS);
    expect(REPLAY_KEPT).toBe(SUPPORT_SNAPSHOT_SIZE);
  });

  it("shows for an event of the last 10 minutes, and not for an older one", (): void => {
    const { rows, kept } = after([event(support("d1"))]);
    const none = new Set<string>();
    expect(replayable(rows[0], kept, T0 + REPLAY_WINDOW_MS - 1, none)).toBe(true);
    expect(replayable(rows[0], kept, T0 + REPLAY_WINDOW_MS, none)).toBe(false);
  });

  it("shows for the newest events that the server keeps, and not for an older row", (): void => {
    const messages: ActivityMessage[] = Array.from({ length: REPLAY_KEPT + 2 }, (_, n: number) =>
      event(support(`d${n}`, { receivedAt: T0 + n })),
    );
    // A replay row does not count: the server keeps only originals.
    messages.push(event(support("again", { replay: true, receivedAt: T0 + 1000 })));
    const { rows, kept } = after(messages);
    const shown: string[] = rows
      .filter((row: ActivityRow): boolean => replayable(row, kept, T0 + 2000, new Set<string>()))
      .map((row: ActivityRow): string => row.id);
    expect(shown).toHaveLength(REPLAY_KEPT);
    expect(shown).not.toContain("twitch:again");
    expect(shown).not.toContain("twitch:d0");
    expect(shown).not.toContain("twitch:d1");
    expect(shown).toContain("twitch:d2");
  });

  it("counts events with one time in their order of arrival, as a YouTube page gives them", (): void => {
    // Each event of one poll page has the same time. The server keeps the newest REPLAY_KEPT by arrival.
    const messages: ActivityMessage[] = Array.from({ length: REPLAY_KEPT + 1 }, (_, n: number) =>
      event(support(`p${n}`, { receivedAt: T0 })),
    );
    const { rows, kept } = after(messages);
    const shown: string[] = rows
      .filter((row: ActivityRow): boolean => replayable(row, kept, T0 + 10, new Set<string>()))
      .map((row: ActivityRow): string => row.id);
    expect(shown).toHaveLength(REPLAY_KEPT);
    expect(shown).not.toContain("twitch:p0");
    expect(shown).toContain(`twitch:p${REPLAY_KEPT}`);
    // A row that is not in the list has no Replay.
    const [other] = after([event(support("elsewhere"))]).rows;
    expect(replayable(other, kept, T0 + 10, new Set<string>())).toBe(false);
  });

  it("follows the order in which the server stored the events, not their times", (): void => {
    // A YouTube poll stores its page after a Twitch event, with the earlier time of the poll start.
    const first: ActivitySupport = support("t1", { receivedAt: T0 + 100 });
    const page: ActivityMessage[] = Array.from({ length: REPLAY_KEPT }, (_, n: number) =>
      event(support(`y${n}`, { id: `youtube:y${n}`, platform: "youtube", receivedAt: T0 })),
    );
    const { rows, kept } = after([event(first), ...page]);
    const shown: string[] = rows
      .filter((row: ActivityRow): boolean => replayable(row, kept, T0 + 200, new Set<string>()))
      .map((row: ActivityRow): string => row.id);
    // The server dropped the Twitch event: it is the oldest that it stored.
    expect(shown).toHaveLength(REPLAY_KEPT);
    expect(shown).not.toContain("twitch:t1");
    expect(shown).toContain("youtube:y0");
    // A snapshot gives the list of the server again. A replay does not change it.
    const snapshot: ActivityState = after([{ type: "snapshot", events: [first], replay: true, since: 0 }]);
    expect(snapshot.kept).toEqual(["twitch:t1"]);
    expect(after([event(support("t1", { replay: true }))], snapshot).kept).toEqual(["twitch:t1"]);
  });

  it("does not show for a row that is itself a replay, or for an event that the server answered as gone", (): void => {
    const { rows, kept } = after([event(support("d1")), event(support("again", { replay: true, receivedAt: T0 + 1 }))]);
    const [again, original] = rows;
    expect(replayable(again, kept, T0 + 10, new Set<string>())).toBe(false);
    expect(replayable(original, kept, T0 + 10, new Set<string>())).toBe(true);
    expect(replayable(original, kept, T0 + 10, new Set<string>(["twitch:d1"]))).toBe(false);
  });
});

describe("the state of the alerts", (): void => {
  const socket: ShownAlerts = { muted: false, current: view(), waiting: 2, goal: null, until: 9000 };
  const reply = (more: Partial<AlertsReply>): AlertsReply => ({
    at: T0 + 10,
    muted: false,
    current: view(),
    waiting: 2,
    goal: null,
    ...more,
  });

  it("is the state of the socket without an answer, or when the socket is newer", (): void => {
    expect(shownAlerts(socket, T0, null)).toBe(socket);
    expect(shownAlerts(socket, T0 + 11, reply({ muted: true }))).toBe(socket);
  });

  it("takes the mute and the line from a newer answer, and the time of the alert from the socket", (): void => {
    expect(shownAlerts(socket, T0, reply({ waiting: 3, goal: { counts: "subs", value: 1, startedAt: 0 } }))).toEqual({
      muted: false,
      current: view(),
      waiting: 3,
      goal: { counts: "subs", value: 1, startedAt: 0 },
      until: 9000,
    });
  });

  it("ends the alert on stream after a skip or a mute, and never starts one", (): void => {
    expect(shownAlerts(socket, T0, reply({ muted: true, current: null, waiting: 0 }))).toEqual({
      muted: true,
      current: null,
      waiting: 0,
      goal: null,
      until: 0,
    });
    const quiet: ShownAlerts = { ...socket, current: null, until: 0 };
    expect(shownAlerts(quiet, T0, reply({})).current).toBeNull();
    expect(shownAlerts(socket, T0, reply({ current: view({ id: "twitch:next" }) })).current).toBeNull();
  });

  it("counts the seconds that are left, and the alerts that wait", async (): Promise<void> => {
    expect(secondsLeft(T0 + 4000, T0)).toBe(4);
    expect(secondsLeft(T0 + 4000, T0 + 1)).toBe(4);
    expect(secondsLeft(T0 + 4000, T0 + 3001)).toBe(1);
    expect(secondsLeft(T0 + 4000, T0 + 5000)).toBe(0);
    expect(nowLine(4, 0)).toBe("4 s left");
    expect(nowLine(4, 1)).toBe("4 s left · 1 alert waits");
    expect(nowLine(1, 2)).toBe("1 s left · 2 alerts wait");
    await loadCatalog("ru");
    setLocaleSource((): Locale => "ru");
    expect(nowLine(1, 1)).toBe("осталась 1 с · ждёт 1 оповещение");
    expect(nowLine(3, 3)).toBe("осталось 3 с · ждут 3 оповещения");
    expect(nowLine(5, 5)).toBe("осталось 5 с · ждут 5 оповещений");
  });
});

describe("a refusal of a control", (): void => {
  it("has its own text for each code of the alert host", (): void => {
    for (const code of Object.keys(ALERT_REFUSALS) as AlertRefusal[])
      expect(refusalText(code, ALERT_REFUSALS[code])).toBe(REFUSAL_TEXT[code]);
    expect(new Set(Object.values(REFUSAL_TEXT)).size).toBe(Object.keys(ALERT_REFUSALS).length);
    expect(t(REFUSAL_TEXT.alert_gone)).toBe("This event is too old for a replay.");
    expect(t(REFUSAL_TEXT.alerts_muted)).toBe("Alerts are muted. Turn off Mute alerts first.");
  });

  it("has a text for too many requests and for alerts that are off, and none for other errors", (): void => {
    expect(refusalText(null, 429)).toBe("tools.live.activity.refused.rateLimit");
    expect(refusalText(null, 503)).toBe("tools.live.activity.refused.unavailable");
    expect(refusalText("page_frozen", 423)).toBeNull();
    expect(refusalText(null, 401)).toBeNull();
  });
});

describe("the sample support event of the test deployment", (): void => {
  it("is a new live gift each time, with the time of the call", (): void => {
    const first: ActivitySupport = sampleSupportAt(T0);
    expect(first).toMatchObject({ kind: "gift", platform: "twitch", amount: 5, replay: false, receivedAt: T0 });
    expect(first.sentAt).toBe(T0);
    expect(first.id).toBe(`twitch:${first.deliveryId}`);
    expect(sampleSupportAt(T0 + 1).id).not.toBe(first.id);
  });
});
