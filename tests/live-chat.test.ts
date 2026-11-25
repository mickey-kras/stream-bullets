import { describe, expect, it } from "vitest";
import type { ActivityChat, ActivityEvent, ActivityMessage, ActivityPlatform } from "../app/lib/activity";
import { MAX_REMOVED_IDS } from "../app/lib/chat-feed";
import {
  LIVE_CHAT_LIMITS,
  initialLiveChat,
  liveChatReducer,
  newSince,
  shownRows,
  type LiveChatRow,
  type LiveChatState,
} from "../app/lib/live-chat";

// The chat log of the Live section of Streamer tools: a pure state machine over the activity feed.

const T0 = 1_800_000_000_000;

function chat(n: number, more: Partial<ActivityChat> = {}): ActivityChat {
  const platform: ActivityPlatform = more.platform ?? "twitch";
  const messageId: string = more.messageId ?? `m${n}`;
  return {
    kind: "chat",
    id: `${platform}:${messageId}`,
    platform,
    channelId: "c1",
    messageId,
    user: { id: `u${n}`, displayName: `Viewer ${n}` },
    text: `message ${n}`,
    fragments: [{ type: "text", text: `message ${n}` }],
    badges: [],
    sentAt: null,
    receivedAt: T0 + n * 1000,
    live: true,
    ...more,
  };
}

function event(value: ActivityEvent): ActivityMessage {
  return { type: "event", event: value };
}

function snapshot(events: ActivityEvent[]): ActivityMessage {
  return { type: "snapshot", events, replay: true };
}

/** Server time of the reducer calls: after each message of `chat`, and inside the time the producer keeps one. */
const NOW = T0 + 60_000;

function receive(state: LiveChatState, message: ActivityMessage, now: number = NOW): LiveChatState {
  return liveChatReducer(state, { type: "message", message, now });
}

function run(messages: ActivityMessage[], from: LiveChatState = initialLiveChat()): LiveChatState {
  return messages.reduce((state: LiveChatState, message: ActivityMessage) => receive(state, message), from);
}

function texts(state: LiveChatState): string[] {
  return state.rows.map((row: LiveChatRow): string =>
    row.removed ? "removed" : row.fragments.map((part) => (part.type === "text" ? part.text : part.name)).join(""),
  );
}

describe("live chat log", (): void => {
  it("keeps messages in arrival order and never shows a message twice", (): void => {
    const state: LiveChatState = run([event(chat(2)), event(chat(1)), event(chat(2))]);
    expect(texts(state)).toEqual(["message 2", "message 1"]);
    expect(state.rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(state.rows[0]).toMatchObject({
      id: "twitch:m2",
      platform: "twitch",
      userId: "u2",
      name: "Viewer 2",
      receivedAt: T0 + 2000,
      removed: false,
      truncated: false,
    });
  });

  it("uses the login for a viewer without a display name, and keeps two badges", (): void => {
    const badges = ["mod", "sub", "vip"].map((id: string) => ({ id, label: id.toUpperCase() }));
    const named: LiveChatState = run([
      event(chat(1, { user: { id: "u1", login: "login1", displayName: "" }, badges })),
      event(chat(2, { user: { id: "u2", displayName: "" } })),
    ]);
    expect(named.rows.map((row) => row.name)).toEqual(["login1", ""]);
    expect(named.rows[0].badges).toEqual([
      { id: "mod", label: "MOD" },
      { id: "sub", label: "SUB" },
    ]);
  });

  it("shows the whole text of a long message, up to the limit", (): void => {
    const long: string = "x".repeat(LIVE_CHAT_LIMITS.maxDisplayChars + 5);
    const state: LiveChatState = run([event(chat(1, { text: long, fragments: [{ type: "text", text: long }] }))]);
    expect(state.rows[0].truncated).toBe(true);
    expect(texts(state)[0]).toHaveLength(LIVE_CHAT_LIMITS.maxDisplayChars);
  });

  it("keeps only the newest rows", (): void => {
    const many: ActivityMessage[] = Array.from({ length: LIVE_CHAT_LIMITS.maxRows + 3 }, (_, n: number) =>
      event(chat(n)),
    );
    const state: LiveChatState = run(many);
    expect(state.rows).toHaveLength(LIVE_CHAT_LIMITS.maxRows);
    expect(state.rows[0].id).toBe("twitch:m3");
    expect(state.rows.at(-1)?.seq).toBe(LIVE_CHAT_LIMITS.maxRows + 3);
  });

  it("keeps a deleted message in its place without its text, also when the message comes later", (): void => {
    const state: LiveChatState = run([
      event(chat(1, { badges: [{ id: "mod", label: "MOD" }] })),
      event(chat(2)),
      event({ kind: "delete", platform: "twitch", messageId: "m1", receivedAt: T0 }),
      // The same message on another platform is another message.
      event(chat(1, { platform: "kick" })),
      event({ kind: "delete", platform: "twitch", messageId: "m9", receivedAt: T0 }),
      event(chat(9)),
      event(chat(1)),
    ]);
    expect(texts(state)).toEqual(["removed", "message 2", "message 1"]);
    expect(state.rows[0]).toMatchObject({ id: "twitch:m1", removed: true, badges: [], fragments: [] });
    expect([...state.removed]).toEqual(["twitch:m1", "twitch:m9"]);
    // A second delete of the same message changes nothing.
    const again: LiveChatState = receive(
      state,
      event({ kind: "delete", platform: "twitch", messageId: "m1", receivedAt: T0 }),
    );
    expect(again.rows).toBe(state.rows);
  });

  it("removes each message of a banned or timed-out viewer on that platform only", (): void => {
    const start: ActivityMessage[] = [
      event(chat(1)),
      event(chat(2, { user: { id: "u1", displayName: "Viewer 1" } })),
      event(chat(3, { platform: "youtube", user: { id: "u1", displayName: "Other 1" } })),
      event(chat(4)),
    ];
    const banned: LiveChatState = run([
      ...start,
      event({ kind: "ban", platform: "twitch", userId: "u1", until: null, receivedAt: T0 }),
    ]);
    expect(texts(banned)).toEqual(["removed", "removed", "message 3", "message 4"]);
    expect([...banned.removed]).toEqual(["twitch:m1", "twitch:m2"]);
    const cleared: LiveChatState = run([
      ...start,
      event({ kind: "clear_user", platform: "youtube", userId: "u1", receivedAt: T0 }),
    ]);
    expect(texts(cleared)).toEqual(["message 1", "message 2", "removed", "message 4"]);
    // A ban of a viewer without messages changes nothing.
    const none: LiveChatState = run(start);
    expect(receive(none, event({ kind: "ban", platform: "kick", userId: "u1", until: 5, receivedAt: T0 }))).toBe(none);
  });

  it("removes each message of a cleared platform, and ignores status events, frames and an unavailable feed", (): void => {
    const start: LiveChatState = run([event(chat(1)), event(chat(2, { platform: "kick" }))]);
    const cleared: LiveChatState = receive(start, event({ kind: "clear", platform: "twitch", receivedAt: T0 }));
    expect(texts(cleared)).toEqual(["removed", "message 2"]);
    expect(receive(start, event({ kind: "status", platform: "twitch", status: "error" }))).toBe(start);
    expect(receive(start, { type: "unavailable" })).toBe(start);
  });

  it("forgets the oldest removed ids above the limit", (): void => {
    let state: LiveChatState = initialLiveChat();
    for (let n = 0; n < MAX_REMOVED_IDS + 2; n++)
      state = receive(state, event({ kind: "delete", platform: "twitch", messageId: `m${n}`, receivedAt: T0 }));
    expect(state.removed.size).toBe(MAX_REMOVED_IDS);
    expect(state.removed.has("twitch:m0")).toBe(false);
    expect(state.removed.has(`twitch:m${MAX_REMOVED_IDS + 1}`)).toBe(true);
  });

  it("adds the new messages of a reconnect snapshot and removes what was moderated in its window", (): void => {
    const before: LiveChatState = run([event(chat(1)), event(chat(2)), event(chat(3)), event(chat(4))]);
    // The server has the messages 2, 4 and 5: message 3 was deleted while the page was away. The server keeps a
    // message for 10 minutes, and message 1 is older than that, so the snapshot tells nothing about it.
    const now: number = T0 + 9 * 60_000 + 1500;
    const after: LiveChatState = receive(before, snapshot([chat(2), chat(4), chat(5, { live: false })]), now);
    expect(texts(after)).toEqual(["message 1", "message 2", "removed", "message 4", "message 5"]);
    expect(after.removed.has("twitch:m3")).toBe(true);
    // A snapshot never brings a removed message back.
    expect(texts(receive(after, snapshot([chat(2), chat(3), chat(4), chat(5)]), now))).toEqual(texts(after));
  });

  it("removes a moderated message that is older than each message of a snapshot that is not full", (): void => {
    const before: LiveChatState = run([event(chat(1)), event(chat(2)), event(chat(3))]);
    expect(texts(receive(before, snapshot([chat(2), chat(3)])))).toEqual(["removed", "message 2", "message 3"]);
  });

  it("removes the rows that the server no longer has when a snapshot has no chat", (): void => {
    const before: LiveChatState = run([event(chat(1)), event(chat(2, { platform: "kick" }))]);
    // The chat was cleared while the page was away, and no message came after that.
    const cleared: LiveChatState = receive(before, snapshot([]));
    expect(texts(cleared)).toEqual(["removed", "removed"]);
    expect(texts(receive(before, snapshot([{ kind: "status", platform: "twitch", status: "active" }])))).toEqual(
      texts(cleared),
    );
    // The server keeps no message this long, so an empty snapshot tells nothing about the rows.
    expect(receive(before, snapshot([]), T0 + 20 * 60_000)).toBe(before);
  });

  it("starts the window of a full snapshot at its oldest message", (): void => {
    const before: LiveChatState = run([event(chat(1)), event(chat(2)), event(chat(3)), event(chat(4))]);
    // 100 messages: 3 and 5 to 103. Newer messages pushed the older ones out, so 1 and 2 tell nothing.
    const full: ActivityChat[] = [chat(3), ...Array.from({ length: 99 }, (_, n: number) => chat(n + 5))];
    const after: LiveChatState = receive(before, snapshot(full));
    expect(texts(after).slice(0, 5)).toEqual(["message 1", "message 2", "message 3", "removed", "message 5"]);
    expect(after.rows).toHaveLength(103);
  });

  it("fills an empty log from the first snapshot", (): void => {
    expect(texts(run([snapshot([chat(1), chat(2)])]))).toEqual(["message 1", "message 2"]);
  });
});

describe("paused live chat log", (): void => {
  const pause = (state: LiveChatState): LiveChatState => liveChatReducer(state, { type: "pause" });
  const resume = (state: LiveChatState): LiveChatState => liveChatReducer(state, { type: "resume" });
  const many = (from: number, count: number): ActivityMessage[] =>
    Array.from({ length: count }, (_, n: number) => event(chat(from + n)));

  it("keeps the rows that it shows while more messages arrive than the log keeps", (): void => {
    const paused: LiveChatState = pause(run(many(0, 3)));
    expect(paused.pausedAt).toBe(3);
    // A second pause does not move the place.
    expect(pause(run([event(chat(3))], paused))).toMatchObject({ pausedAt: 3 });
    const busy: LiveChatState = run(many(3, LIVE_CHAT_LIMITS.maxRows + 20), paused);
    expect(texts(busy).slice(0, 4)).toEqual(["message 0", "message 1", "message 2", "message 23"]);
    expect(busy.rows).toHaveLength(3 + LIVE_CHAT_LIMITS.maxRows);
    expect(newSince(busy.rows, 3, new Set())).toBe(LIVE_CHAT_LIMITS.maxRows);
    // Moderation still reaches a row that the pause keeps.
    const banned: LiveChatState = run(
      [event({ kind: "ban", platform: "twitch", userId: "u1", until: null, receivedAt: T0 })],
      busy,
    );
    expect(texts(banned).slice(0, 3)).toEqual(["message 0", "removed", "message 2"]);
    // Jump to latest keeps the newest rows only.
    const resumed: LiveChatState = resume(banned);
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.rows).toHaveLength(LIVE_CHAT_LIMITS.maxRows);
    expect(texts(resumed)[0]).toBe("message 23");
  });
});

describe("live chat filters and the count of a paused chat", (): void => {
  const state: LiveChatState = run([
    event(chat(1)),
    event(chat(2, { platform: "youtube" })),
    event(chat(3, { platform: "kick" })),
    event(chat(4)),
    event({ kind: "delete", platform: "twitch", messageId: "m4", receivedAt: T0 }),
    event(chat(5, { platform: "youtube" })),
  ]);

  it("shows the rows of the platforms that are not hidden", (): void => {
    expect(shownRows(state.rows, new Set())).toHaveLength(5);
    expect(shownRows(state.rows, new Set<ActivityPlatform>(["twitch"])).map((row) => row.seq)).toEqual([2, 3, 5]);
    expect(shownRows(state.rows, new Set<ActivityPlatform>(["twitch", "youtube", "kick"]))).toEqual([]);
  });

  it("counts the messages after a row, without removed messages and hidden platforms", (): void => {
    expect(newSince(state.rows, 0, new Set())).toBe(4);
    expect(newSince(state.rows, 2, new Set())).toBe(2);
    expect(newSince(state.rows, 2, new Set<ActivityPlatform>(["youtube"]))).toBe(1);
    expect(newSince(state.rows, 5, new Set())).toBe(0);
  });
});
