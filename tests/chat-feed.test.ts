import { describe, expect, it } from "vitest";
import {
  parseActivityMessage,
  type ActivityChat,
  type ActivityEvent,
  type ActivityMessage,
  type ActivityPlatform,
} from "../app/lib/activity";
import {
  CHAT_LIMITS,
  MAX_REMOVED_IDS,
  SAMPLE_CHAT,
  chatReducer,
  displayFragments,
  initialChatState,
  graphemes,
  isChatCommand,
  nextWakeAt,
  safeEmoteUrl,
  type ChatOptions,
  type ChatRow,
  type ChatState,
} from "../app/lib/chat-feed";

const T0 = 1_800_000_000_000;
const options: ChatOptions = { hideCommands: true };
const showAll: ChatOptions = { hideCommands: false };

let counter = 0;

function chat(overrides: Partial<ActivityChat> & { text?: string } = {}): ActivityChat {
  counter += 1;
  const platform: ActivityPlatform = overrides.platform ?? "twitch";
  const messageId: string = overrides.messageId ?? `m${counter}`;
  const text: string = overrides.text ?? `hello ${counter}`;
  return {
    kind: "chat",
    id: `${platform}:${messageId}`,
    platform,
    channelId: "c1",
    messageId,
    user: { id: "u1", displayName: "User" },
    text,
    fragments: [{ type: "text", text }],
    badges: [],
    sentAt: null,
    receivedAt: T0,
    live: true,
    ...overrides,
  };
}

function event(value: ActivityEvent): ActivityMessage {
  return { type: "event", event: value };
}

function snapshot(events: ActivityEvent[]): ActivityMessage {
  return { type: "snapshot", events, replay: true };
}

function send(state: ChatState, message: ActivityMessage, now: number, opts: ChatOptions = options, serverOffset?: number): ChatState {
  return chatReducer(state, { type: "message", message, now, serverOffset }, opts);
}

function tick(state: ChatState, now: number, opts: ChatOptions = options): ChatState {
  return chatReducer(state, { type: "tick", now }, opts);
}

/** Ticks at every wake time up to `until`. */
function runUntil(state: ChatState, until: number, opts: ChatOptions = options): ChatState {
  let current: ChatState = state;
  for (let i = 0; i < 10_000; i += 1) {
    const wake: number | null = nextWakeAt(current, opts);
    if (wake === null || wake > until) break;
    current = tick(current, Math.max(wake, 0), opts);
  }
  return tick(current, until, opts);
}

function ids(rows: readonly ChatRow[]): string[] {
  return rows.map((row: ChatRow): string => row.id);
}

function textOf(row: ChatRow): string {
  return row.fragments.map((fragment) => (fragment.type === "text" ? fragment.text : `[${fragment.name}]`)).join("");
}

describe("isChatCommand", () => {
  it("matches a leading !word only", () => {
    expect(isChatCommand("!jump")).toBe(true);
    expect(isChatCommand("  !jump now")).toBe(true);
    expect(isChatCommand("!sprung_2")).toBe(true);
    expect(isChatCommand("!прыжок")).toBe(true);
    expect(isChatCommand("! jump")).toBe(false);
    expect(isChatCommand("!jump!")).toBe(false);
    expect(isChatCommand("I said !jump")).toBe(false);
    expect(isChatCommand("!")).toBe(false);
    expect(isChatCommand(`!${"a".repeat(33)}`)).toBe(false);
    expect(isChatCommand("")).toBe(false);
  });

  it("treats a full-width ！ as ! and skips leading format characters and white space", () => {
    expect(isChatCommand("！jump")).toBe(true);
    expect(isChatCommand("\u200b!jump")).toBe(true);
    expect(isChatCommand("\ufeff\u200d !jump")).toBe(true);
    expect(isChatCommand("\u2066\u3000！ジャンプ now")).toBe(true);
    expect(isChatCommand("！")).toBe(false);
    expect(isChatCommand("！ jump")).toBe(false);
    expect(isChatCommand(`！${"a".repeat(32)}`)).toBe(true);
    expect(isChatCommand(`！${"a".repeat(33)}`)).toBe(false);
    expect(isChatCommand("\u200bhi !jump")).toBe(false);
  });
});

describe("safeEmoteUrl", () => {
  it("allows HTTPS on the default port from EMOTE_HOSTS only", () => {
    const good = "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0";
    expect(safeEmoteUrl(good)).toBe(good);
    expect(safeEmoteUrl("https://static-cdn.jtvnw.net:443/x")).toBe("https://static-cdn.jtvnw.net/x");
    expect(safeEmoteUrl("https://static-cdn.jtvnw.net:8443/x")).toBeNull();
    expect(safeEmoteUrl("https://user@static-cdn.jtvnw.net/x")).toBeNull();
    expect(safeEmoteUrl("https://:secret@static-cdn.jtvnw.net/x")).toBeNull();
    expect(safeEmoteUrl("http://static-cdn.jtvnw.net/x")).toBeNull();
    expect(safeEmoteUrl("https://evil.example/x")).toBeNull();
    expect(safeEmoteUrl("not a url")).toBeNull();
  });
});

describe("graphemes", () => {
  it("keeps emoji sequences and combining marks whole", () => {
    expect(graphemes("a👨‍👩‍👧‍👦é")).toEqual(["a", "👨‍👩‍👧‍👦", "é"]);
  });
});

describe("displayFragments", () => {
  it("keeps short messages and reports no cut", () => {
    const message = chat({ text: "short" });
    expect(displayFragments(message, 200)).toEqual({ fragments: [{ type: "text", text: "short" }], truncated: false });
  });

  it("falls back to text when there are no fragments, and skips empty text", () => {
    expect(displayFragments(chat({ text: "plain", fragments: [] }), 10).fragments).toEqual([{ type: "text", text: "plain" }]);
    expect(displayFragments(chat({ text: "", fragments: [] }), 10)).toEqual({ fragments: [], truncated: false });
    expect(displayFragments(chat({ text: "a", fragments: [{ type: "text", text: "" }, { type: "text", text: "a" }] }), 10).fragments).toEqual([
      { type: "text", text: "a" },
    ]);
  });

  it("never splits a ZWJ emoji sequence", () => {
    const family = "👨‍👩‍👧‍👦";
    const result = displayFragments(chat({ text: `ab${family}${family}` }), 3);
    expect(result).toEqual({ fragments: [{ type: "text", text: `ab${family}` }], truncated: true });
  });

  it("never splits combining marks or skin tones", () => {
    const e = "é";
    const wave = "👋🏾";
    expect(displayFragments(chat({ text: `${e}${e}${e}` }), 2).fragments).toEqual([{ type: "text", text: `${e}${e}` }]);
    expect(displayFragments(chat({ text: `${wave}${wave}` }), 1).fragments).toEqual([{ type: "text", text: wave }]);
  });

  it("cuts right-to-left text by characters, keeping it as text", () => {
    const result = displayFragments(chat({ text: "مرحبا بالعالم" }), 5);
    expect(result).toEqual({ fragments: [{ type: "text", text: "مرحبا" }], truncated: true });
  });

  it("counts an emote as one character", () => {
    const emote = { type: "emote" as const, id: "25", name: "Kappa", url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0" };
    const message = chat({ text: "ab Kappa cd", fragments: [{ type: "text", text: "ab " }, emote, { type: "text", text: " cd" }] });
    expect(displayFragments(message, 4)).toEqual({ fragments: [{ type: "text", text: "ab " }, emote], truncated: true });
    expect(displayFragments(message, 7)).toEqual({ fragments: message.fragments, truncated: false });
    expect(displayFragments(message, 3)).toEqual({ fragments: [{ type: "text", text: "ab " }], truncated: true });
    expect(displayFragments(message, 5)).toEqual({ fragments: [{ type: "text", text: "ab " }, emote, { type: "text", text: " " }], truncated: true });
    expect(displayFragments(message, 0)).toEqual({ fragments: [], truncated: true });
    expect(displayFragments(chat({ fragments: [emote, emote] }), 1)).toEqual({ fragments: [emote], truncated: true });
  });

  it("shows an emote from a host outside EMOTE_HOSTS as its name", () => {
    const message = chat({
      fragments: [
        { type: "emote", id: "1", name: "Bad", url: "https://evil.example/x.png" },
        { type: "emote", id: "2", name: "Plain", url: "http://static-cdn.jtvnw.net/x" },
        { type: "emote", id: "3", name: "Broken", url: "not a url" },
        { type: "emote", id: "4", name: "Port", url: "https://static-cdn.jtvnw.net:8443/x" },
        { type: "emote", id: "5", name: "Login", url: "https://a:b@static-cdn.jtvnw.net/x" },
      ],
    });
    expect(displayFragments(message, 50).fragments).toEqual([
      { type: "text", text: "Bad" },
      { type: "text", text: "Plain" },
      { type: "text", text: "Broken" },
      { type: "text", text: "Port" },
      { type: "text", text: "Login" },
    ]);
  });
});

describe("chatReducer: live events", () => {
  it("shows a lone message at once with an enter animation, then settles", () => {
    const message = chat({ user: { id: "u9", displayName: "Nine" }, badges: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] });
    let state = send(initialChatState(), event(message), 1000);
    expect(state.pending).toEqual([]);
    expect(state.rows).toHaveLength(1);
    const row = state.rows[0];
    expect(row).toMatchObject({ id: message.id, name: "Nine", userId: "u9", phase: "entering", animate: true, shownAt: 1000, phaseAt: 1000 });
    expect(row.badges).toEqual([{ id: "a", label: "A" }, { id: "b", label: "B" }]);
    expect(nextWakeAt(state, options)).toBe(1000 + CHAT_LIMITS.enterMs);
    expect(tick(state, 1000 + CHAT_LIMITS.enterMs - 1, options)).toBe(state);
    state = tick(state, 1000 + CHAT_LIMITS.enterMs, options);
    expect(state.rows[0].phase).toBe("shown");
    expect(nextWakeAt(state, options)).toBe(1000 + CHAT_LIMITS.lifetimeMs);
  });

  it("falls back to the login, then to an empty name", () => {
    let state = send(initialChatState(), event(chat({ user: { id: "x", login: "log", displayName: "" } })), 0);
    state = send(state, event(chat({ user: { id: "y", displayName: "" } })), 1000);
    expect(state.rows.map((row) => row.name)).toEqual(["log", ""]);
  });

  it("keeps arrival order even when sentAt says otherwise", () => {
    const late = chat({ sentAt: T0 - 60_000, live: false });
    const early = chat({ sentAt: T0 + 5_000 });
    const middle = chat({ sentAt: null });
    let state = initialChatState();
    state = send(state, event(early), 0);
    state = send(state, event(late), 10);
    state = send(state, event(middle), 20);
    state = runUntil(state, 2000);
    expect(ids(state.rows)).toEqual([early.id, late.id, middle.id]);
    expect(state.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it("promotes one queued row per interval", () => {
    let state = initialChatState();
    const messages = [chat(), chat(), chat()];
    for (const message of messages) state = send(state, event(message), 0);
    expect(state.rows).toHaveLength(1);
    expect(state.pending).toHaveLength(2);
    expect(nextWakeAt(state, options)).toBe(CHAT_LIMITS.enterIntervalMs);
    state = tick(state, CHAT_LIMITS.enterIntervalMs, options);
    expect(state.rows).toHaveLength(2);
    expect(state.rows[1].animate).toBe(true);
    state = tick(state, CHAT_LIMITS.enterIntervalMs * 2, options);
    expect(ids(state.rows)).toEqual(ids(messages.map((m) => ({ id: m.id }) as ChatRow)));
  });

  it("skips duplicates in rows, pending and removed", () => {
    const a = chat();
    const b = chat();
    let state = send(initialChatState(), event(a), 0);
    state = send(state, event(b), 0);
    expect(send(state, event(a), 1)).toBe(state);
    expect(send(state, event(b), 1)).toBe(state);
    const deleted = send(state, event({ kind: "delete", platform: "twitch", messageId: a.messageId, receivedAt: T0 }), 2);
    const settled = runUntil(deleted, 10_000);
    expect(settled.rows.some((row) => row.id === a.id)).toBe(false);
    expect(send(settled, event(a), 10_001)).toBe(settled);
  });

  it("hides commands only when asked, and never acts on them", () => {
    const command = chat({ text: "!jump" });
    expect(send(initialChatState(), event(command), 0).rows).toEqual([]);
    const shown = send(initialChatState(), event(command), 0, showAll);
    expect(textOf(shown.rows[0])).toBe("!jump");
    expect(shown.rows[0].command).toBe(true);
  });

  it("removes shown and queued commands when hideCommands turns on", () => {
    const opts: ChatOptions = { hideCommands: false, limits: { burstThreshold: 100 } };
    const [a, b, c, d] = [chat({ text: "!jump" }), chat({ text: "hi" }), chat({ text: "！dance" }), chat({ text: "yo" })];
    let state = initialChatState();
    state = send(state, event(a), 0, opts);
    state = runUntil(state, 500, opts);
    state = send(state, event(b), 500, opts);
    state = send(state, event(c), 500, opts);
    state = send(state, event(d), 500, opts);
    expect(ids(state.rows)).toEqual([a.id, b.id]);
    expect(ids(state.pending)).toEqual([c.id, d.id]);
    const on: ChatOptions = { ...opts, hideCommands: true };
    state = chatReducer(state, { type: "filter", hideCommands: true, now: 500 }, on);
    expect(state.rows.map((row) => [row.id, row.phase])).toEqual([
      [a.id, "leaving"],
      [b.id, "entering"],
    ]);
    expect(ids(state.pending)).toEqual([d.id]);
    state = runUntil(state, 500 + CHAT_LIMITS.leaveMs, on);
    expect(ids(state.rows)).toEqual([b.id, d.id]);
  });

  it("changes nothing when hideCommands turns off or nothing matches", () => {
    let state = send(initialChatState(), event(chat({ text: "hi" })), 0, showAll);
    state = runUntil(state, 500, showAll);
    expect(chatReducer(state, { type: "filter", hideCommands: false, now: 600 }, showAll)).toBe(state);
    expect(chatReducer(state, { type: "filter", hideCommands: true, now: 600 }, options)).toBe(state);
    // Hidden commands are never kept, so turning the option off does not bring them back.
    const hiddenState = send(initialChatState(), event(chat({ text: "!jump" })), 0, options);
    expect(chatReducer(hiddenState, { type: "filter", hideCommands: false, now: 10 }, showAll).rows).toEqual([]);
  });

  it("leaves a command row that is already leaving alone when filtering", () => {
    const opts: ChatOptions = { hideCommands: false, limits: { maxRows: 1 } };
    let state = send(initialChatState(), event(chat({ text: "!jump" })), 0, opts);
    state = send(state, event(chat({ text: "hi" })), 1000, opts);
    expect(state.rows.map((row) => row.phase)).toEqual(["leaving", "entering"]);
    expect(chatReducer(state, { type: "filter", hideCommands: true, now: 1000 }, opts)).toBe(state);
  });

  it("drops the oldest queued message when the queue is full", () => {
    const limits = { burstThreshold: 100 };
    const opts: ChatOptions = { hideCommands: true, limits };
    let state = initialChatState();
    const messages = Array.from({ length: 12 }, () => chat());
    for (const message of messages) state = send(state, event(message), 0, opts);
    expect(state.rows).toHaveLength(1);
    expect(ids(state.pending)).toEqual(messages.slice(4).map((m) => m.id));
  });

  it("shows a burst at once in arrival order (oldest first) without animation", () => {
    let state = initialChatState();
    const messages = Array.from({ length: 6 }, () => chat());
    for (const message of messages) state = send(state, event(message), 0);
    expect(state.pending).toHaveLength(5);
    state = tick(state, CHAT_LIMITS.enterIntervalMs, options);
    expect(state.pending).toEqual([]);
    expect(state.rows.slice(1).every((row) => !row.animate && row.phase === "shown")).toBe(true);
    expect(ids(state.rows)).toEqual(messages.map((m) => m.id));
  });

  it("stays bounded through a 1,000 message burst and shows the newest", () => {
    let state = initialChatState();
    const messages: ActivityChat[] = [];
    let now = 0;
    for (let i = 0; i < 1000; i += 1) {
      const message = chat({ user: { id: `u${i % 50}`, displayName: `U${i}` } });
      messages.push(message);
      now += 3;
      state = send(state, event(message), now);
      expect(state.pending.length).toBeLessThanOrEqual(CHAT_LIMITS.maxPending);
      expect(state.rows.filter((row) => row.phase !== "leaving").length).toBeLessThanOrEqual(CHAT_LIMITS.maxRows);
      expect(state.rows.length).toBeLessThanOrEqual(CHAT_LIMITS.maxRows + CHAT_LIMITS.maxLeaving);
    }
    state = runUntil(state, now + 5_000);
    expect(state.pending).toEqual([]);
    expect(state.rows).toHaveLength(CHAT_LIMITS.maxRows);
    expect(state.rows.at(-1)?.id).toBe(messages.at(-1)?.id);
    const shownSeqs = state.rows.map((row) => row.seq);
    expect(shownSeqs).toEqual([...shownSeqs].sort((a, b) => a - b));
    // Each burst shows the newest queued messages, so the screen only holds the last few hundred arrivals.
    expect(Math.min(...shownSeqs)).toBeGreaterThan(700);
  });

  it("retires rows past the row bound and the lifetime through a leave phase", () => {
    const opts: ChatOptions = { hideCommands: true, limits: { maxRows: 2 } };
    let state = initialChatState();
    const [a, b, c] = [chat(), chat(), chat()];
    state = send(state, event(a), 0, opts);
    state = send(state, event(b), 1000, opts);
    state = send(state, event(c), 2000, opts);
    expect(state.rows.map((row) => row.phase)).toEqual(["leaving", "shown", "entering"]);
    expect(nextWakeAt(state, opts)).toBe(2000 + CHAT_LIMITS.leaveMs);
    state = tick(state, 2000 + CHAT_LIMITS.leaveMs, opts);
    expect(ids(state.rows)).toEqual([b.id, c.id]);
    state = tick(state, 1000 + CHAT_LIMITS.lifetimeMs, opts);
    expect(state.rows.map((row) => row.phase)).toEqual(["leaving", "shown"]);
    state = runUntil(state, 2000 + CHAT_LIMITS.lifetimeMs + CHAT_LIMITS.leaveMs, opts);
    expect(state.rows).toEqual([]);
    expect(nextWakeAt(state, opts)).toBeNull();
  });

  it("caps rows that are leaving", () => {
    const opts: ChatOptions = { hideCommands: true, limits: { maxRows: 1, maxLeaving: 2, burstThreshold: 1 } };
    let state = initialChatState();
    for (let i = 0; i < 6; i += 1) state = send(state, event(chat()), 0, opts);
    state = tick(state, 200, opts);
    expect(state.rows.filter((row) => row.phase === "leaving").length).toBeLessThanOrEqual(2);
    expect(state.rows.filter((row) => row.phase !== "leaving")).toHaveLength(1);
  });

  it("ignores status events", () => {
    const state = send(initialChatState(), event(chat()), 0);
    expect(send(state, event({ kind: "status", platform: "twitch", status: "error", code: "x" }), 1)).toBe(state);
  });

  it("clears everything on unavailable and on reset", () => {
    let state = send(initialChatState(), event(chat()), 0);
    state = send(state, event(chat()), 0);
    state = send(state, event({ kind: "delete", platform: "kick", messageId: "zz", receivedAt: T0 }), 0);
    expect(state.removed.size).toBe(1);
    expect(send(state, { type: "unavailable" }, 1)).toEqual(initialChatState());
    expect(chatReducer(state, { type: "reset" }, options)).toEqual(initialChatState());
  });
});

describe("chatReducer: moderation", () => {
  function shownState(messages: ActivityChat[]): ChatState {
    let state = initialChatState();
    let now = 0;
    for (const message of messages) {
      state = send(state, event(message), now);
      now += 1000;
    }
    return state;
  }

  it("marks a deleted message removed, then drops it", () => {
    const [a, b] = [chat(), chat()];
    let state = shownState([a, b]);
    state = send(state, event({ kind: "delete", platform: "twitch", messageId: a.messageId, receivedAt: T0 }), 5000);
    expect(state.rows.map((row) => row.phase)).toEqual(["removed", "shown"]);
    expect(state.rows[0].animate).toBe(false);
    expect(state.removed.has(a.id)).toBe(true);
    expect(nextWakeAt(state, options)).toBe(5000 + CHAT_LIMITS.removedHoldMs);
    state = tick(state, 5000 + CHAT_LIMITS.removedHoldMs, options);
    expect(ids(state.rows)).toEqual([b.id]);
  });

  it("matches deletes by platform and message id", () => {
    const a = chat({ platform: "youtube", messageId: "same" });
    const b = chat({ platform: "twitch", messageId: "same" });
    let state = shownState([a, b]);
    state = send(state, event({ kind: "delete", platform: "youtube", messageId: "same", receivedAt: T0 }), 5000);
    expect(state.rows.map((row) => row.phase)).toEqual(["removed", "shown"]);
  });

  it("remembers a delete that arrives before its message", () => {
    const a = chat();
    let state = send(initialChatState(), event({ kind: "delete", platform: "twitch", messageId: a.messageId, receivedAt: T0 }), 0);
    state = send(state, event(a), 1);
    expect(state.rows).toEqual([]);
    expect(state.pending).toEqual([]);
  });

  it("removes a banned or cleared user's rows and queued messages on that platform only", () => {
    for (const kind of ["ban", "clear_user"] as const) {
      const bad = { id: "bad", displayName: "Bad" };
      const messages = [
        chat({ user: bad }),
        chat({ user: { id: "good", displayName: "Good" } }),
        chat({ user: bad, platform: "kick" }),
        chat({ user: bad }),
        chat({ user: bad }),
      ];
      let state = initialChatState();
      for (const message of messages) state = send(state, event(message), 0);
      expect(state.pending).toHaveLength(4);
      const moderation: ActivityEvent =
        kind === "ban"
          ? { kind, platform: "twitch", userId: "bad", until: null, receivedAt: T0 }
          : { kind, platform: "twitch", userId: "bad", receivedAt: T0 };
      state = send(state, event(moderation), 0);
      expect(state.rows[0]).toMatchObject({ id: messages[0].id, phase: "removed" });
      expect(state.removed.has(messages[3].id)).toBe(true);
      state = runUntil(state, 10_000);
      expect(ids(state.rows)).toEqual([messages[1].id, messages[2].id]);
    }
  });

  it("sends a cleared platform's rows straight to leaving", () => {
    const [a, b, c] = [chat({ platform: "twitch" }), chat({ platform: "youtube" }), chat({ platform: "twitch" })];
    let state = shownState([a, b]);
    state = send(state, event(c), 1200);
    expect(state.pending).toHaveLength(0);
    const queued = chat({ platform: "twitch" });
    state = send(state, event(queued), 1201);
    expect(state.pending).toHaveLength(1);
    state = send(state, event({ kind: "clear", platform: "twitch", receivedAt: T0 }), 1202);
    expect(state.rows.map((row) => row.phase)).toEqual(["leaving", "entering", "leaving"]);
    expect(state.pending).toEqual([]);
    expect(state.removed.has(queued.id)).toBe(true);
    state = runUntil(state, 3000);
    expect(ids(state.rows)).toEqual([b.id]);
  });

  it("leaves rows that are already leaving alone and ignores moderation with no match", () => {
    const a = chat();
    let state = shownState([a]);
    state = send(state, event({ kind: "clear", platform: "twitch", receivedAt: T0 }), 10);
    const again = send(state, event({ kind: "delete", platform: "twitch", messageId: a.messageId, receivedAt: T0 }), 11);
    expect(again.rows[0].phase).toBe("leaving");
    const none = send(state, event({ kind: "ban", platform: "kick", userId: "nobody", until: 5, receivedAt: T0 }), 12);
    expect(none).toBe(state);
  });

  it("keeps the removed set bounded", () => {
    let state = initialChatState();
    for (let i = 0; i < MAX_REMOVED_IDS + 5; i += 1) {
      state = send(state, event({ kind: "delete", platform: "twitch", messageId: `d${i}`, receivedAt: T0 }), i);
    }
    expect(state.removed.size).toBe(MAX_REMOVED_IDS);
    expect(state.removed.has("twitch:d0")).toBe(false);
    expect(state.removed.has(`twitch:d${MAX_REMOVED_IDS + 4}`)).toBe(true);
  });
});

describe("chatReducer: snapshots", () => {
  it("shows a first snapshot without animation, newest rows within the lifetime", () => {
    const now = T0 + 1_000_000;
    const old = chat({ receivedAt: now - CHAT_LIMITS.lifetimeMs - 1, live: false });
    const recent = Array.from({ length: 45 }, (_, i) => chat({ receivedAt: now - 60_000 + i, live: false }));
    const command = chat({ text: "!jump", receivedAt: now - 1, live: false });
    const state = send(initialChatState(), snapshot([old, ...recent, command, { kind: "clear", platform: "kick", receivedAt: 1 }]), now);
    expect(state.rows).toHaveLength(CHAT_LIMITS.maxRows);
    expect(ids(state.rows)).toEqual(recent.slice(5).map((m) => m.id));
    expect(state.rows.every((row) => row.phase === "shown" && !row.animate && row.phaseAt === now)).toBe(true);
    expect(state.rows[0].shownAt).toBe(now - 60_000 + 5);
    expect(nextWakeAt(state, options)).toBe(now - 60_000 + 5 + CHAT_LIMITS.lifetimeMs);
  });

  it("uses serverOffset to place snapshot rows in local time", () => {
    const server = T0;
    const local = T0 - 3_600_000;
    const message = chat({ receivedAt: server - 100_000, live: false });
    const withOffset = send(initialChatState(), snapshot([message]), local, options, server - local);
    expect(withOffset.rows[0].shownAt).toBe(local - 100_000);
    const stale = chat({ receivedAt: server - CHAT_LIMITS.lifetimeMs - 1, live: false });
    expect(send(initialChatState(), snapshot([stale]), local, options, server - local).rows).toEqual([]);
    // Without an offset, a server clock ahead of the local one never places rows in the future.
    const noOffset = send(initialChatState(), snapshot([message]), local, options);
    expect(noOffset.rows[0].shownAt).toBe(local);
  });

  it("reconciles a reconnect: removes moderated rows, adds newer rows, never replays", () => {
    const [a, b, c] = [chat({ receivedAt: T0 }), chat({ receivedAt: T0 + 1 }), chat({ receivedAt: T0 + 2 })];
    let state = initialChatState();
    for (const message of [a, b, c]) state = send(state, event(message), 0);
    state = runUntil(state, 1000);
    expect(ids(state.rows)).toEqual([a.id, b.id, c.id]);
    const d = chat({ receivedAt: T0 + 3, live: false });
    const e = chat({ receivedAt: T0 + 4, live: false });
    // b was deleted while the socket was away.
    state = send(state, snapshot([{ ...a, live: false }, { ...c, live: false }, d, e]), 2000);
    expect(ids(state.rows)).toEqual([a.id, c.id, d.id, e.id]);
    expect(state.rows.slice(2).every((row) => !row.animate && row.phase === "shown")).toBe(true);
    // The same snapshot again changes nothing visible.
    const again = send(state, snapshot([{ ...a, live: false }, { ...c, live: false }, d, e]), 2100);
    expect(ids(again.rows)).toEqual(ids(state.rows));
    expect(again.seq).toBe(state.seq);
  });

  it("compares against the newest row even when server times arrive out of order", () => {
    const [late, early, between] = [chat({ receivedAt: T0 + 50 }), chat({ receivedAt: T0 + 10 }), chat({ receivedAt: T0 + 30 })];
    let state = send(initialChatState(), event(late), 0);
    state = send(state, event(early), 1000);
    state = send(state, snapshot([{ ...early, live: false }, { ...between, live: false }, { ...late, live: false }]), 2000);
    expect(ids(state.rows)).toEqual([late.id, early.id]);
  });

  it("does not re-add rows older than the newest shown row", () => {
    const [a, b] = [chat({ receivedAt: T0 + 10 }), chat({ receivedAt: T0 + 20 })];
    let state = send(initialChatState(), event(b), 0);
    state = send(state, snapshot([{ ...a, live: false }, { ...b, live: false }]), 100);
    expect(ids(state.rows)).toEqual([b.id]);
  });

  it("keeps rows older than the window of a full snapshot", () => {
    const opts: ChatOptions = { hideCommands: true, limits: { maxRows: 200 } };
    const old = chat({ receivedAt: T0 - 50_000 });
    let state = send(initialChatState(), event(old), T0 - 50_000, opts);
    const full = Array.from({ length: 100 }, (_, i) => chat({ receivedAt: T0 + i, live: false }));
    state = send(state, snapshot(full), T0 + 1000, opts);
    expect(state.rows.some((row) => row.id === old.id)).toBe(true);
    expect(state.rows).toHaveLength(101);
    // A partial snapshot is authoritative for everything.
    state = send(state, snapshot(full.slice(-10)), T0 + 1100, opts);
    expect(state.rows.some((row) => row.id === old.id)).toBe(false);
    expect(state.rows.every((row) => row.phase === "shown")).toBe(true);
  });

  it("flushes queued messages without animation, unless the snapshot removed them", () => {
    let state = initialChatState();
    const [a, b, c] = [chat({ receivedAt: T0 }), chat({ receivedAt: T0 + 1 }), chat({ receivedAt: T0 + 2 })];
    for (const message of [a, b, c]) state = send(state, event(message), 0);
    expect(state.pending).toHaveLength(2);
    state = send(state, snapshot([{ ...a, live: false }, { ...c, live: false }]), 50);
    expect(state.pending).toEqual([]);
    expect(ids(state.rows)).toEqual([a.id, c.id]);
    expect(state.rows[1].animate).toBe(false);
  });

  it("skips removed ids and keeps leaving rows during a snapshot", () => {
    const a = chat({ receivedAt: T0 });
    let state = send(initialChatState(), event(a), 0);
    state = send(state, event({ kind: "delete", platform: "twitch", messageId: a.messageId, receivedAt: T0 }), 1);
    state = send(state, snapshot([]), 2);
    expect(state.rows.map((row) => row.phase)).toEqual(["removed"]);
    const fresh = send(initialChatState(), event({ kind: "delete", platform: "twitch", messageId: a.messageId, receivedAt: T0 }), 0);
    expect(send(fresh, snapshot([{ ...a, live: false }]), 1).rows).toEqual([]);
  });

  it("is resilient after unavailable: the next snapshot rebuilds without animation", () => {
    let state = send(initialChatState(), event(chat({ receivedAt: T0 })), T0);
    state = send(state, { type: "unavailable" }, T0 + 1);
    const later = chat({ receivedAt: T0 + 2, live: false });
    state = send(state, snapshot([later]), T0 + 3);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].animate).toBe(false);
  });
});

describe("unsafe input", () => {
  it("keeps HTML as text", () => {
    const html = '<img src=x onerror="alert(1)"><b>hi</b>';
    const state = send(initialChatState(), event(chat({ text: html, user: { id: "h", displayName: "<script>x</script>" } })), 0);
    expect(textOf(state.rows[0])).toBe(html);
    expect(state.rows[0].name).toBe("<script>x</script>");
  });

  it("relies on the parser to refuse disallowed emote hosts and oversized messages", () => {
    const base = chat();
    const bad = { type: "event", event: { ...base, fragments: [{ type: "emote", id: "1", name: "x", url: "https://evil.example/e.png" }] } };
    expect(parseActivityMessage(JSON.stringify(bad))).toBeNull();
    const long = { type: "event", event: { ...base, text: "x".repeat(501), fragments: [] } };
    expect(parseActivityMessage(JSON.stringify(long))).toBeNull();
  });

  it("cuts long messages to the display limit", () => {
    const text = "a".repeat(250);
    const state = send(initialChatState(), event(chat({ text })), 0);
    expect(state.rows[0].truncated).toBe(true);
    expect(textOf(state.rows[0])).toHaveLength(CHAT_LIMITS.maxDisplayChars);
  });
});

describe("nextWakeAt", () => {
  it("is null for an empty state and due now for a queue with no rows", () => {
    expect(nextWakeAt(initialChatState(), options)).toBeNull();
    let state = send(initialChatState(), event(chat()), 0);
    state = send(state, event(chat()), 0);
    const orphan: ChatState = { ...state, rows: [] };
    expect(nextWakeAt(orphan, options)).toBe(0);
    expect(tick(orphan, 5, options).rows).toHaveLength(1);
  });

  it("takes the earliest of lifetime and enter end for entering rows", () => {
    const opts: ChatOptions = { hideCommands: true, limits: { lifetimeMs: 100 } };
    const state = send(initialChatState(), event(chat()), 0, opts);
    expect(nextWakeAt(state, opts)).toBe(100);
    expect(tick(state, 100, opts).rows[0].phase).toBe("leaving");
  });
});

describe("SAMPLE_CHAT", () => {
  it("covers every platform, a command, a badge, an emote and parses as feed messages", () => {
    expect(new Set(SAMPLE_CHAT.map((sample) => sample.platform))).toEqual(new Set(["twitch", "youtube", "kick"]));
    expect(SAMPLE_CHAT.filter((sample) => isChatCommand(sample.text))).toHaveLength(1);
    expect(SAMPLE_CHAT.some((sample) => sample.badges.length > 0)).toBe(true);
    expect(SAMPLE_CHAT.some((sample) => sample.fragments.some((fragment) => fragment.type === "emote"))).toBe(true);
    expect(SAMPLE_CHAT.some((sample) => sample.text.length > CHAT_LIMITS.maxDisplayChars)).toBe(true);
    expect(SAMPLE_CHAT.some((sample) => /[؀-ۿ]/u.test(sample.text))).toBe(true);
    expect(SAMPLE_CHAT.some((sample) => sample.text.includes("‍"))).toBe(true);
    for (const sample of SAMPLE_CHAT) {
      expect(parseActivityMessage(JSON.stringify({ type: "event", event: sample }))).not.toBeNull();
    }
    const state = send(initialChatState(), snapshot([...SAMPLE_CHAT]), SAMPLE_CHAT.at(-1)?.receivedAt ?? 0);
    expect(state.rows).toHaveLength(SAMPLE_CHAT.length - 1);
  });
});
