import { describe, expect, it } from "vitest";
import {
  LIVE_WINDOW_MS,
  MAX_BADGES,
  MAX_TEXT_LENGTH,
  activityEventSchema,
  isLiveMessage,
  parseActivityMessage,
  type ActivityChat,
} from "../app/lib/activity";
import { cleanText, kickEvents, twitchEvents, youtubeEvents } from "../app/server/channel-normalize";
import { youtubeMessageSchema } from "../app/server/channel-providers.server";
import { youtubeText } from "./helpers/channels";

/** Provider payloads to the activity contract: identities, bounds, emotes and moderation. */

const now = 1_794_000_000_000;

function twitchChat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    broadcaster_user_id: "111",
    broadcaster_user_login: "host",
    broadcaster_user_name: "Host",
    chatter_user_id: "222",
    chatter_user_login: "fan",
    chatter_user_name: "Fan",
    message_id: "msg-1",
    message: {
      text: "Hi Kappa",
      fragments: [
        { type: "text", text: "Hi ", emote: null },
        { type: "emote", text: "Kappa", emote: { id: "25", emote_set_id: "0", format: ["static"] } },
      ],
    },
    color: "#FF0000",
    badges: [{ set_id: "moderator", id: "1", info: "" }],
    message_type: "text",
    ...overrides,
  };
}

describe("cleanText", (): void => {
  it("removes control and bidirectional format characters and bounds the length by UTF-16 code units", (): void => {
    expect(cleanText("a\u0000b‮c​d\te ")).toBe("abcd e");
    // Each emoji is two code units. The limit counts like the activity schema and never splits a pair.
    expect(cleanText("😀".repeat(10), 3)).toBe("😀");
    expect(cleanText("😀".repeat(10), 4)).toBe("😀😀");
  });

  it("keeps an emoji-only message and an emoji display name inside the schema limits", (): void => {
    const emoji = "😀".repeat(MAX_TEXT_LENGTH);
    const [event] = twitchEvents(
      "channel.chat.message",
      twitchChat({
        chatter_user_name: "😀".repeat(100),
        message: { text: emoji, fragments: [{ type: "text", text: emoji, emote: null }] },
      }),
      now,
      now,
    ) as ActivityChat[];
    expect(event.text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect(activityEventSchema.safeParse(event).success).toBe(true);
  });
});

describe("Twitch normalization", (): void => {
  it("stops before an emote that does not fit the remaining text budget", (): void => {
    const filler = "😀".repeat(249) + " ";
    const [event] = twitchEvents(
      "channel.chat.message",
      twitchChat({
        message: {
          text: `${filler}Kappa`,
          fragments: [
            { type: "text", text: filler, emote: null },
            { type: "emote", text: "Kappa", emote: { id: "25", emote_set_id: "0", format: ["static"] } },
          ],
        },
      }),
      now,
      now,
    ) as ActivityChat[];
    expect(event.text).toBe(filler);
    expect(event.fragments).toHaveLength(1);
    expect(activityEventSchema.safeParse(event).success).toBe(true);
  });

  it("maps a chat message with stable ids, fragments, emote URLs built from ids, and badges", (): void => {
    const [event] = twitchEvents("channel.chat.message", twitchChat(), now, now - 5) as ActivityChat[];
    expect(event).toEqual({
      kind: "chat",
      id: "twitch:msg-1",
      platform: "twitch",
      channelId: "111",
      messageId: "msg-1",
      user: { id: "222", login: "fan", displayName: "Fan", color: "#FF0000" },
      text: "Hi Kappa",
      fragments: [
        { type: "text", text: "Hi " },
        { type: "emote", id: "25", name: "Kappa", url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0" },
      ],
      badges: [{ id: "moderator", label: "moderator" }],
      sentAt: now - 5,
      receivedAt: now,
      live: true,
    });
    expect(activityEventSchema.safeParse(event).success).toBe(true);
  });

  it("bounds text and badges, drops a bad colour, and uses the text when there are no fragments", (): void => {
    const long = "x".repeat(2000);
    const [event] = twitchEvents(
      "channel.chat.message",
      twitchChat({
        message: { text: long, fragments: [] },
        color: "red;background:url(x)",
        badges: Array.from({ length: 40 }, (_, index) => ({ set_id: `b${index}`, id: "1", info: "" })),
      }),
      now,
      null,
    ) as ActivityChat[];
    expect(event.text).toHaveLength(MAX_TEXT_LENGTH);
    expect(event.badges).toHaveLength(MAX_BADGES);
    expect(event.user.color).toBeUndefined();
    expect(activityEventSchema.safeParse(event).success).toBe(true);
  });

  it("shows a message with an emote id that could change the URL as plain text, and drops malformed ones", (): void => {
    const bad = twitchChat({
      message: { text: "x Kappa", fragments: [{ type: "emote", text: "Kappa", emote: { id: "../../evil" } }] },
    });
    expect(twitchEvents("channel.chat.message", bad, now, null)).toMatchObject([
      { text: "x Kappa", fragments: [{ type: "text", text: "x Kappa" }] },
    ]);
    expect(twitchEvents("channel.chat.message", { message_id: 1 }, now, null)).toEqual([]);
    expect(twitchEvents("channel.unknown", {}, now, null)).toEqual([]);
  });

  it("maps deletions, clears, bans and timeouts", (): void => {
    expect(twitchEvents("channel.chat.message_delete", { message_id: "m1", target_user_id: "2" }, now, null)).toEqual([
      { kind: "delete", platform: "twitch", messageId: "m1", receivedAt: now },
    ]);
    expect(twitchEvents("channel.chat.message_delete", {}, now, null)).toEqual([]);
    expect(twitchEvents("channel.chat.clear", {}, now, null)).toEqual([{ kind: "clear", platform: "twitch", receivedAt: now }]);
    expect(twitchEvents("channel.chat.clear_user_messages", { target_user_id: "2" }, now, null)).toEqual([
      { kind: "clear_user", platform: "twitch", userId: "2", receivedAt: now },
    ]);
    expect(twitchEvents("channel.chat.clear_user_messages", {}, now, null)).toEqual([]);
    expect(twitchEvents("channel.moderate", { action: "ban", ban: { user_id: "3", reason: "" } }, now, null)).toEqual([
      { kind: "ban", platform: "twitch", userId: "3", until: null, receivedAt: now, bannedAt: null },
    ]);
    const expires = "2026-11-12T10:10:00Z";
    expect(twitchEvents("channel.moderate", { action: "timeout", timeout: { user_id: "3", expires_at: expires } }, now, null)).toEqual([
      { kind: "ban", platform: "twitch", userId: "3", until: Date.parse(expires), receivedAt: now, bannedAt: null },
    ]);
    expect(twitchEvents("channel.moderate", { action: "timeout", timeout: { user_id: "3", expires_at: "soon" } }, now, null)).toEqual([]);
    expect(twitchEvents("channel.moderate", { action: "unban", unban: { user_id: "3" } }, now, null)).toEqual([]);
    expect(twitchEvents("channel.moderate", { action: 5 }, now, null)).toEqual([]);
  });
});

describe("Kick normalization", (): void => {
  const message = {
    message_id: "k-1",
    broadcaster: { user_id: 333, username: "host", channel_slug: "host" },
    sender: {
      user_id: 444,
      username: "fan",
      channel_slug: "fan_slug",
      identity: { username_color: "#00FF00", badges: [{ text: "Moderator", type: "moderator" }] },
    },
    content: "Hello [emote:4148074:HYPERCLAP]",
    emotes: [{ emote_id: "4148074", positions: [{ s: 6, e: 30 }] }],
    created_at: "2025-01-14T16:08:06Z",
  };

  it("maps a chat message and shows emotes by name (no documented image host)", (): void => {
    expect(kickEvents("chat.message.sent", message, now)).toEqual([
      {
        kind: "chat",
        id: "kick:k-1",
        platform: "kick",
        channelId: "333",
        messageId: "k-1",
        user: { id: "444", login: "fan_slug", displayName: "fan", color: "#00FF00" },
        text: "Hello HYPERCLAP",
        fragments: [{ type: "text", text: "Hello HYPERCLAP" }],
        badges: [{ id: "moderator", label: "Moderator" }],
        sentAt: Date.parse("2025-01-14T16:08:06Z"),
        receivedAt: now,
        // Sent long before it was received: a late retry never runs as a command.
        live: false,
      },
    ]);
    const bare = { ...message, sender: { user_id: 444, username: "fan", identity: null }, created_at: undefined };
    expect(kickEvents("chat.message.sent", bare, now)).toMatchObject([{ user: { id: "444", displayName: "fan" }, badges: [], sentAt: null }]);
  });

  it("maps bans and timeouts and ignores other events", (): void => {
    const ban = { banned_user: { user_id: 5, username: "x" }, metadata: { reason: "r", created_at: "x", expires_at: null } };
    expect(kickEvents("moderation.banned", ban, now)).toEqual([
      { kind: "ban", platform: "kick", userId: "5", until: null, receivedAt: now, bannedAt: null },
    ]);
    const dated = { ...ban, metadata: { created_at: "2025-01-14T16:08:05Z", expires_at: null } };
    expect(kickEvents("moderation.banned", dated, now)).toMatchObject([{ bannedAt: Date.parse("2025-01-14T16:08:05Z") }]);
    const timeout = { ...ban, metadata: { expires_at: "2025-01-14T16:10:06Z" } };
    expect(kickEvents("moderation.banned", timeout, now)).toMatchObject([{ until: Date.parse("2025-01-14T16:10:06Z") }]);
    expect(kickEvents("moderation.banned", {}, now)).toEqual([]);
    expect(kickEvents("chat.message.sent", {}, now)).toEqual([]);
    expect(kickEvents("channel.followed", {}, now)).toEqual([]);
  });
});

describe("YouTube normalization", (): void => {
  function parse(value: unknown): ReturnType<typeof youtubeMessageSchema.parse> {
    return youtubeMessageSchema.parse(value);
  }

  it("maps text messages with badge flags, deletions and bans", (): void => {
    const items = [
      parse(youtubeText("y1", "UCa", "hi", { isChatOwner: true, isVerified: true })),
      parse({ id: "y2", snippet: { type: "tombstone" } }),
      parse({ id: "y3", snippet: { type: "messageDeletedEvent", messageDeletedDetails: { deletedMessageId: "y0" } } }),
      parse({
        id: "y4",
        snippet: { type: "userBannedEvent", userBannedDetails: { bannedUserDetails: { channelId: "UCb" }, banType: "permanent" } },
      }),
      parse({
        id: "y5",
        snippet: {
          type: "userBannedEvent",
          userBannedDetails: { bannedUserDetails: { channelId: "UCc" }, banType: "temporary", banDurationSeconds: "300" },
        },
      }),
      parse({ id: "y6", snippet: { type: "superChatEvent" } }),
      parse({ id: "y7", snippet: { type: "textMessageEvent" } }),
    ];
    expect(youtubeEvents(items, "UCchannel", now)).toEqual([
      {
        kind: "chat",
        id: "youtube:y1",
        platform: "youtube",
        channelId: "UCchannel",
        messageId: "y1",
        user: { id: "UCa", displayName: "Name UCa" },
        text: "hi",
        fragments: [{ type: "text", text: "hi" }],
        badges: [
          { id: "owner", label: "Owner" },
          { id: "verified", label: "Verified" },
        ],
        sentAt: Date.parse("2026-11-12T10:00:00Z"),
        receivedAt: now,
        live: true,
      },
      { kind: "delete", platform: "youtube", messageId: "y2", receivedAt: now },
      { kind: "delete", platform: "youtube", messageId: "y0", receivedAt: now },
      { kind: "ban", platform: "youtube", userId: "UCb", until: null, receivedAt: now, bannedAt: null },
      { kind: "ban", platform: "youtube", userId: "UCc", until: now + 300_000, receivedAt: now, bannedAt: null },
    ]);
  });

  it("counts a timeout from when YouTube published the ban, not from when it was read", (): void => {
    const published = now - 5 * 60_000;
    const item = youtubeMessageSchema.parse({
      id: "y9",
      snippet: {
        type: "userBannedEvent",
        publishedAt: new Date(published).toISOString(),
        userBannedDetails: { bannedUserDetails: { channelId: "UCd" }, banType: "temporary", banDurationSeconds: "60" },
      },
    });
    expect(youtubeEvents([item], "UCchannel", now)).toEqual([
      { kind: "ban", platform: "youtube", userId: "UCd", until: published + 60_000, receivedAt: now, bannedAt: published },
    ]);
  });

  it("falls back to the display message and drops empty text fragments", (): void => {
    const item = parse({
      id: "y8",
      snippet: { type: "textMessageEvent", displayMessage: "\u0000" },
      authorDetails: { channelId: "UCa", displayName: "A" },
    });
    expect(youtubeEvents([item], "UC", now)).toMatchObject([{ text: "", fragments: [] }]);
  });
});

describe("live window", (): void => {
  it("marks a message live only when it was sent at most LIVE_WINDOW_MS before it arrived", (): void => {
    expect(isLiveMessage(null, now)).toBe(true);
    expect(isLiveMessage(now - LIVE_WINDOW_MS, now)).toBe(true);
    expect(isLiveMessage(now - LIVE_WINDOW_MS - 1, now)).toBe(false);
    expect(isLiveMessage(now + 5000, now)).toBe(true);
    const [late] = twitchEvents("channel.chat.message", twitchChat(), now, now - LIVE_WINDOW_MS - 1) as ActivityChat[];
    expect(late.live).toBe(false);
    // YouTube uses publishedAt; Kick uses created_at.
    const old = youtubeMessageSchema.parse(youtubeText("y-old", "UCa", "!cmd", {}, new Date(now - LIVE_WINDOW_MS - 1).toISOString()));
    const fresh = youtubeMessageSchema.parse(youtubeText("y-new", "UCa", "!cmd", {}, new Date(now - LIVE_WINDOW_MS).toISOString()));
    expect((youtubeEvents([old, fresh], "UC", now) as ActivityChat[]).map((event) => event.live)).toEqual([false, true]);
  });
});

describe("activity socket messages", (): void => {
  it("parses snapshots and events and refuses anything else, including foreign emote hosts", (): void => {
    const [chat] = twitchEvents("channel.chat.message", twitchChat(), now, null);
    expect(parseActivityMessage(JSON.stringify({ type: "snapshot", events: [chat], replay: true }))).toMatchObject({ type: "snapshot" });
    expect(parseActivityMessage(JSON.stringify({ type: "event", event: chat }))).toMatchObject({ type: "event" });
    expect(parseActivityMessage(JSON.stringify({ type: "unavailable" }))).toEqual({ type: "unavailable" });
    const evil = { ...chat, fragments: [{ type: "emote", id: "1", name: "x", url: "https://evil.example/x.png" }] };
    expect(parseActivityMessage(JSON.stringify({ type: "event", event: evil }))).toBeNull();
    const plain = { ...chat, fragments: [{ type: "emote", id: "1", name: "x", url: "http://static-cdn.jtvnw.net/x" }] };
    expect(parseActivityMessage(JSON.stringify({ type: "event", event: plain }))).toBeNull();
    const broken = { ...chat, fragments: [{ type: "emote", id: "1", name: "x", url: "not a url" }] };
    expect(parseActivityMessage(JSON.stringify({ type: "event", event: broken }))).toBeNull();
    expect(parseActivityMessage("{")).toBeNull();
    expect(parseActivityMessage(5)).toBeNull();
    expect(parseActivityMessage(JSON.stringify({ type: "snapshot", events: [], replay: false }))).toBeNull();
    expect(parseActivityMessage(JSON.stringify({ type: "event", event: { kind: "status", platform: "kick", status: "disconnected" } }))).toMatchObject({
      type: "event",
    });
  });
});
