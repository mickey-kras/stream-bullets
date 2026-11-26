import { describe, expect, it } from "vitest";
import type {
  ActivityChat,
  ActivityEvent,
  ActivityMessage,
  ActivityPlatform,
  ActivitySupport,
  SupportKind,
} from "../app/lib/activity";
import { MAX_REMOVED_IDS } from "../app/lib/chat-feed";
import {
  CHAT_TEXT_DEFAULT,
  CHAT_TEXT_SIZES,
  LIVE_CHAT_LIMITS,
  chatTextStep,
  initialLiveChat,
  liveChatReducer,
  newSince,
  nextChatTextStep,
  rowKey,
  shownRows,
  type LiveChatRow,
  type LiveChatState,
  type LiveRow,
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

/** A snapshot. `since` is the receive time after which the producer still has each message that it keeps. */
function snapshot(events: ActivityEvent[], since?: number): ActivityMessage {
  return since === undefined
    ? { type: "snapshot", events, replay: true }
    : { type: "snapshot", events, replay: true, since };
}

function receive(state: LiveChatState, message: ActivityMessage): LiveChatState {
  return liveChatReducer(state, { type: "message", message });
}

function run(messages: ActivityMessage[], from: LiveChatState = initialLiveChat()): LiveChatState {
  return messages.reduce((state: LiveChatState, message: ActivityMessage) => receive(state, message), from);
}

/** A support event. Its ID is the platform and the delivery ID, as the feed makes it. */
function support(kind: SupportKind, n: number, more: Partial<ActivitySupport> = {}): ActivitySupport {
  const platform: ActivitySupport["platform"] = more.platform ?? "twitch";
  const deliveryId: string = more.deliveryId ?? `d${n}`;
  return {
    kind,
    id: `${platform}:${deliveryId}`,
    platform,
    deliveryId,
    sender: { id: `u${n}`, displayName: `Viewer ${n}` },
    anonymous: false,
    amount: null,
    currency: null,
    receivedAt: T0 + n * 1000,
    replay: false,
    ...more,
  };
}

/** The text of a chat row, "removed" for a moderated row, and the kind of a support row. */
function texts(state: LiveChatState): string[] {
  return state.rows.map((row: LiveRow): string => {
    if (row.kind === "support") return row.event;
    return row.removed
      ? "removed"
      : row.fragments.map((part) => (part.type === "text" ? part.text : part.name)).join("");
  });
}

function chatRows(state: LiveChatState): LiveChatRow[] {
  return state.rows.filter((row: LiveRow): row is LiveChatRow => row.kind === "chat");
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
    expect(chatRows(named)[0].badges).toEqual([
      { id: "mod", label: "MOD" },
      { id: "sub", label: "SUB" },
    ]);
  });

  it("shows the whole text of a long message, up to the limit", (): void => {
    const long: string = "x".repeat(LIVE_CHAT_LIMITS.maxDisplayChars + 5);
    const state: LiveChatState = run([event(chat(1, { text: long, fragments: [{ type: "text", text: long }] }))]);
    expect(chatRows(state)[0].truncated).toBe(true);
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

  it("adds the new messages of a reconnect snapshot and removes what was moderated after its boundary", (): void => {
    const before: LiveChatState = run([event(chat(1)), event(chat(2)), event(chat(3)), event(chat(4))]);
    // The server has the messages 2, 4 and 5: message 3 was deleted while the page was away. The boundary is the
    // time of message 1, so the snapshot tells nothing about it.
    const since: number = T0 + 1000;
    const after: LiveChatState = receive(before, snapshot([chat(2), chat(4), chat(5, { live: false })], since));
    expect(texts(after)).toEqual(["message 1", "message 2", "removed", "message 4", "message 5"]);
    expect(after.removed.has("twitch:m3")).toBe(true);
    // A snapshot never brings a removed message back.
    expect(texts(receive(after, snapshot([chat(2), chat(3), chat(4), chat(5)], since)))).toEqual(texts(after));
  });

  it("removes a moderated message that is older than each message of the snapshot", (): void => {
    const before: LiveChatState = run([event(chat(1)), event(chat(2)), event(chat(3))]);
    expect(texts(receive(before, snapshot([chat(2), chat(3)], T0)))).toEqual(["removed", "message 2", "message 3"]);
  });

  it("removes the rows after the boundary when a snapshot has no chat", (): void => {
    const before: LiveChatState = run([event(chat(1)), event(chat(2, { platform: "kick" }))]);
    // The chat was cleared while the page was away, and no message came after that.
    expect(texts(receive(before, snapshot([], T0)))).toEqual(["removed", "removed"]);
    expect(texts(receive(before, snapshot([{ kind: "status", platform: "twitch", status: "active" }], T0)))).toEqual([
      "removed",
      "removed",
    ]);
    // The server keeps no message this old, so an empty snapshot tells nothing about the rows.
    expect(receive(before, snapshot([], T0 + 2000))).toBe(before);
  });

  it("keeps the rows that the size limit of the server pushed out", (): void => {
    // The server keeps the newest 100 of 150 messages. Message 150 was deleted while the page was away.
    const before: LiveChatState = run(Array.from({ length: 150 }, (_, n: number) => event(chat(n + 1))));
    const kept: ActivityChat[] = Array.from({ length: 99 }, (_, n: number) => chat(n + 51));
    const after: LiveChatState = receive(before, snapshot(kept, T0 + 50_000));
    expect(
      chatRows(after)
        .filter((row: LiveChatRow): boolean => row.removed)
        .map((row) => row.id),
    ).toEqual(["twitch:m150"]);
  });

  it("reads a snapshot without a boundary from its oldest message, and an empty one not at all", (): void => {
    const before: LiveChatState = run([event(chat(1)), event(chat(2)), event(chat(3)), event(chat(4))]);
    expect(texts(receive(before, snapshot([chat(2), chat(4)])))).toEqual([
      "message 1",
      "message 2",
      "removed",
      "message 4",
    ]);
    expect(receive(before, snapshot([]))).toBe(before);
  });

  it("fills an empty log from the first snapshot", (): void => {
    expect(texts(run([snapshot([chat(1), chat(2)])]))).toEqual(["message 1", "message 2"]);
  });
});

describe("support events in the live chat log", (): void => {
  it("adds one row for each support event, in arrival order with the chat", (): void => {
    const cheer: ActivitySupport = support("bits", 2, { sender: null, anonymous: true, amount: 100, text: "gg" });
    const state: LiveChatState = run([event(chat(1)), event(cheer), event(support("follow", 3)), event(chat(4))]);
    expect(texts(state)).toEqual(["message 1", "bits", "follow", "message 4"]);
    expect(state.rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(state.rows[1]).toEqual({
      kind: "support",
      id: "twitch:d2",
      seq: 2,
      event: "bits",
      platform: "twitch",
      name: null,
      amount: 100,
      currency: null,
      text: "gg",
      receivedAt: T0 + 2000,
    });
    expect(state.rows[2]).toMatchObject({ event: "follow", name: "Viewer 3", amount: null, text: null });
  });

  it("has no name for a supporter that the platform does not name, and no text for an empty text", (): void => {
    const unnamed: ActivitySupport = support("follow", 1, { sender: { id: "u1", displayName: "" }, text: "" });
    expect(run([event(unnamed)]).rows[0]).toMatchObject({ name: null, text: null });
  });

  it("adds no second row for a replay, a provider retry or the copy of a snapshot", (): void => {
    const gift: ActivitySupport = support("gift", 1, { amount: 5 });
    const once: LiveChatState = run([event(gift)]);
    expect(receive(once, event({ ...gift, replay: true }))).toBe(once);
    expect(receive(once, event(gift))).toBe(once);
    expect(receive(once, snapshot([{ ...gift, replay: true }], T0))).toBe(once);
    // The same delivery ID on another platform is another event.
    expect(texts(receive(once, event(support("gift", 1, { platform: "kick", amount: 5 }))))).toEqual(["gift", "gift"]);
  });

  it("adds no row for a snapshot copy of a support event whose row newer chat pushed out", (): void => {
    const gift: ActivitySupport = support("gift", 1, { amount: 5 });
    const chats: ActivityMessage[] = Array.from({ length: LIVE_CHAT_LIMITS.maxRows }, (_, n: number) =>
      event(chat(n + 2)),
    );
    const busy: LiveChatState = run([event(gift), ...chats]);
    expect(busy.rows.some((row) => row.kind === "support")).toBe(false);
    // The server keeps the support event for the snapshot of a reconnect: it is not a new event.
    const again: LiveChatState = receive(busy, snapshot([{ ...gift, replay: true }]));
    expect(again.rows).toBe(busy.rows);
    expect(again.seq).toBe(busy.seq);
  });

  it("keeps a chat message and a support event that have the same ID as two rows", (): void => {
    const state: LiveChatState = run([
      event(chat(1, { platform: "youtube", messageId: "x" })),
      event(support("super_chat", 2, { platform: "youtube", deliveryId: "x", amount: 5_000_000, currency: "USD" })),
    ]);
    expect(state.rows.map((row) => row.id)).toEqual(["youtube:x", "youtube:x"]);
    expect(state.rows.map(rowKey)).toEqual(["youtube:x", "support:youtube:x"]);
    // The deletion of the message removes the chat row only.
    const deleted: LiveChatState = receive(
      state,
      event({ kind: "delete", platform: "youtube", messageId: "x", receivedAt: T0 }),
    );
    expect(texts(deleted)).toEqual(["removed", "super_chat"]);
  });

  it("puts the support events of a snapshot between its chat in the order of their receive times", (): void => {
    const first: LiveChatState = run([
      snapshot([chat(1), chat(4), support("raid", 2, { amount: 40, replay: true }), support("follow", 5)], T0),
    ]);
    expect(texts(first)).toEqual(["message 1", "raid", "message 4", "follow"]);
    // A snapshot with support events only adds them, and tells nothing about the chat without a boundary.
    const more: LiveChatState = receive(first, snapshot([support("kicks", 6, { platform: "kick", amount: 10 })]));
    expect(texts(more)).toEqual(["message 1", "raid", "message 4", "follow", "kicks"]);
  });

  it("never removes a support row: not for a deletion, a ban, a clear, or a snapshot without it", (): void => {
    const start: LiveChatState = run([
      event(chat(1)),
      event(support("subscription", 1, { amount: 3 })),
      event(support("follow", 2, { sender: { id: "u1", displayName: "Viewer 1" } })),
    ]);
    const moderated: LiveChatState = run(
      [
        event({ kind: "delete", platform: "twitch", messageId: "d1", receivedAt: T0 }),
        event({ kind: "ban", platform: "twitch", userId: "u1", until: null, receivedAt: T0 }),
        event({ kind: "clear_user", platform: "twitch", userId: "u1", receivedAt: T0 }),
        event({ kind: "clear", platform: "twitch", receivedAt: T0 }),
      ],
      start,
    );
    expect(texts(moderated)).toEqual(["removed", "subscription", "follow"]);
    // The feed keeps only chat for a late reader, so its snapshot has no support event.
    expect(texts(receive(start, snapshot([], T0)))).toEqual(["removed", "subscription", "follow"]);
    expect(texts(receive(start, snapshot([chat(1)], T0)))).toEqual(["message 1", "subscription", "follow"]);
  });

  it("applies the row limit to chat and support rows together", (): void => {
    const many: ActivityMessage[] = Array.from({ length: LIVE_CHAT_LIMITS.maxRows + 2 }, (_, n: number) =>
      event(n % 2 === 0 ? chat(n) : support("follow", n)),
    );
    const state: LiveChatState = run(many);
    expect(state.rows).toHaveLength(LIVE_CHAT_LIMITS.maxRows);
    expect(state.rows.slice(0, 2).map((row) => row.id)).toEqual(["twitch:m2", "twitch:d3"]);
  });

  it("filters support rows by platform, always shows a direct tip, and counts them for a paused chat", (): void => {
    const state: LiveChatState = run([
      event(chat(1)),
      event(support("follow", 2, { platform: "kick" })),
      event(support("tip", 3, { platform: "direct", amount: 2_000_000, currency: "EUR" })),
      event(support("membership", 4, { platform: "youtube", amount: 1 })),
    ]);
    const all = new Set<ActivityPlatform>(["twitch", "youtube", "kick"]);
    expect(shownRows(state.rows, new Set<ActivityPlatform>(["kick"])).map((row) => row.seq)).toEqual([1, 3, 4]);
    expect(shownRows(state.rows, all).map((row) => row.seq)).toEqual([3]);
    expect(newSince(state.rows, 1, new Set())).toBe(3);
    expect(newSince(state.rows, 1, new Set<ActivityPlatform>(["youtube"]))).toBe(2);
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

describe("text size of the full-screen chat", (): void => {
  it("starts above the page text size and reads a stored step", (): void => {
    expect(CHAT_TEXT_SIZES[CHAT_TEXT_DEFAULT]).toBeGreaterThan(1);
    expect(chatTextStep("0")).toBe(0);
    expect(chatTextStep(String(CHAT_TEXT_SIZES.length - 1))).toBe(CHAT_TEXT_SIZES.length - 1);
    for (const stored of [null, undefined, "", "big", "1.5", "-1", String(CHAT_TEXT_SIZES.length)])
      expect(chatTextStep(stored), String(stored)).toBe(CHAT_TEXT_DEFAULT);
  });

  it("steps one size at a time and stops at each end", (): void => {
    expect(nextChatTextStep(1, 1)).toBe(2);
    expect(nextChatTextStep(1, -1)).toBe(0);
    expect(nextChatTextStep(0, -1)).toBe(0);
    const last: number = CHAT_TEXT_SIZES.length - 1;
    expect(nextChatTextStep(last, 1)).toBe(last);
    expect([...CHAT_TEXT_SIZES]).toEqual([...CHAT_TEXT_SIZES].sort((a: number, b: number): number => a - b));
  });
});
