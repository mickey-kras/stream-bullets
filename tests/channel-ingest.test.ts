import nodeCrypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import { MAX_ACTIVITY_MESSAGE_LENGTH, parseActivityMessage, quotaDay, type ActivityChat, type ActivityEvent } from "../app/lib/activity";
import { ChannelIngest, snapshotMessage } from "../app/server/channel-ingest";
import {
  ADMISSION_BURST,
  CONNECTION_CACHE_MS,
  MODERATION_BURST,
  SEEN_MAX,
  SEEN_TTL_MS,
  MAX_SOCKETS,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_SIZE,
  YOUTUBE_DAILY_BUDGET,
  YOUTUBE_IDLE_POLL_MS,
  YOUTUBE_MIN_POLL_MS,
  YOUTUBE_NAME_REFRESH_MS,
  YOUTUBE_NAME_RETRY_MS,
  YOUTUBE_PAGE_DAILY_BUDGET,
} from "../app/server/channel-ingest-limits";
import { loadTokens, tokenStatement } from "../app/server/channel-tokens.server";

import { installFakeProviders, youtubeText, type FakeProviders } from "./helpers/channels";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import { installWorkersRuntime, RoomNamespace, serverSocketOf, type FakeSocket, type RoomState } from "./helpers/room";

vi.mock("cloudflare:workers", () => import("./helpers/room"));

/** The per-page ingest object: dedupe, admission, snapshot retention and purges, sockets, YouTube polling. */

const origin = "https://ingest.example.test";
const page = "50000000-0000-4000-8000-000000000001";
const otherPage = "50000000-0000-4000-8000-000000000002";
const tokenKeys = `k1:${btoa(String.fromCodePoint(...new Uint8Array(32).fill(9)))}`;

let database: TestDatabase;
let env: AppEnv;
let fake: FakeProviders;
let ingest: RoomNamespace<ChannelIngest>;

function url(path: string, query: Record<string, string> = {}): string {
  return `https://channel-ingest.internal/${path}?${new URLSearchParams({ streamerId: page, ...query })}`;
}

function post(path: string, platform: string, body?: unknown): Promise<Response> {
  return ingest.get(ingest.idFromName(page)).fetch(url(path, { platform }), {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

function chat(messageId: string, userId = "u1", platform: "twitch" | "kick" | "youtube" = "twitch", receivedAt = Date.now()): ActivityChat {
  return {
    kind: "chat",
    id: `${platform}:${messageId}`,
    platform,
    channelId: "111",
    messageId,
    user: { id: userId, displayName: `User ${userId}` },
    text: `hello ${messageId}`,
    fragments: [{ type: "text", text: `hello ${messageId}` }],
    badges: [],
    sentAt: null,
    receivedAt,
    live: true,
  };
}

/** A delivery as the Worker forwards it, for the channel the test connection uses (`111` for Twitch and Kick). */
function deliver(deliveryId: string, events: ActivityEvent[], platform = "twitch", channelId = "111"): Promise<Response> {
  return post("event", platform, { deliveryId, channelId, events });
}

async function listen(headers: Record<string, string> = { "X-SB-Owner": "1" }): Promise<FakeSocket> {
  const response = await ingest
    .get(ingest.idFromName(page))
    .fetch(url("subscribe"), { headers: { Upgrade: "websocket", ...headers } });
  expect(response.status).toBe(101);
  return serverSocketOf(response.webSocket);
}

function state(): RoomState {
  return ingest.entry(page).state;
}

function room(): ChannelIngest {
  return ingest.entry(page).room;
}

/** The snapshot a consumer that connects now receives. */
async function snapshot(): Promise<ActivityChat[]> {
  const socket = await listen();
  const [first] = socket.messages<{ type: string; events: ActivityChat[] }>();
  expect(first.type).toBe("snapshot");
  return first.events;
}

async function addConnection(
  platform: "twitch" | "youtube" | "kick",
  options: { status?: string; expiresAt?: number | null; externalId?: string } = {},
): Promise<string> {
  const id = `conn-${platform}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,status,created_at,updated_at)
        VALUES (?,?,?,?,'Host','',?,1,1)`,
    ).bind(id, page, platform, options.externalId ?? (platform === "youtube" ? "UCchannel1" : "111"), options.status ?? "active"),
    await tokenStatement(env, id, platform, {
      accessToken: `${platform}-stored-access`,
      refreshToken: `${platform}-stored-refresh`,
      expiresAt: options.expiresAt === undefined ? Date.now() + 3_600_000 : options.expiresAt,
    }, 100),
  ]);
  return id;
}

async function connectionRow(platform: string): Promise<{ status: string; status_code: string | null; last_event_at: number | null }> {
  const row = await env.DB.prepare("SELECT status, status_code, last_event_at FROM channel_connections WHERE platform=?")
    .bind(platform)
    .first<{ status: string; status_code: string | null; last_event_at: number | null }>();
  if (!row) throw new Error("no row");
  return row;
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  installWorkersRuntime();
  fake = installFakeProviders();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    POLL_ROOMS: {} as DurableObjectNamespace,
    CHANNEL_INGEST: {} as DurableObjectNamespace,
    REQUEST_LIMITER: {} as RateLimit,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: "x".repeat(40),
    TWITCH_CLIENT_ID: "twitch-client",
    TWITCH_CLIENT_SECRET: "twitch-secret",
    TWITCH_EVENTSUB_SECRET: "eventsub-secret-0123456789abcdef0123",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    KICK_CLIENT_ID: "kick-client",
    KICK_CLIENT_SECRET: "kick-secret",
    CHANNEL_TOKEN_KEYS: tokenKeys,
  };
  ingest = new RoomNamespace((roomState: RoomState) => new ChannelIngest(roomState as unknown as DurableObjectState, env));
  env.CHANNEL_INGEST = ingest as unknown as DurableObjectNamespace;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
    env.DB.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('owner','O','o@x.test',1,1,1)"),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','host_page','Host')").bind(page),
  ]);
});

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("snapshotMessage", (): void => {
  function emoteChat(index: number): ActivityChat {
    const fragments = Array.from({ length: 64 }, (_, n) =>
      n % 2 === 0
        ? { type: "emote" as const, id: `emotesv2_${"a".repeat(32)}`, name: "E", url: `https://static-cdn.jtvnw.net/emoticons/v2/emotesv2_${"a".repeat(32)}/default/dark/1.0` }
        : { type: "text" as const, text: " " },
    );
    return {
      kind: "chat",
      id: `twitch:m${index}`,
      platform: "twitch",
      channelId: "111",
      messageId: `m${index}`,
      user: { id: "222", displayName: "Fan" },
      text: fragments.map((fragment) => (fragment.type === "text" ? fragment.text : fragment.name)).join(""),
      fragments,
      badges: [],
      sentAt: null,
      receivedAt: index,
      live: false,
    };
  }

  it("keeps a full snapshot of large messages inside the consumer limit, newest first", (): void => {
    const events = Array.from({ length: 100 }, (_, index) => emoteChat(index));
    expect(JSON.stringify({ type: "snapshot", events, replay: true }).length).toBeGreaterThan(MAX_ACTIVITY_MESSAGE_LENGTH);
    const message = snapshotMessage(events);
    expect(message.length).toBeLessThanOrEqual(MAX_ACTIVITY_MESSAGE_LENGTH);
    const parsed = parseActivityMessage(message);
    expect(parsed?.type).toBe("snapshot");
    const kept = parsed?.type === "snapshot" ? parsed.events : [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.at(-1)).toMatchObject({ messageId: "m99" });
  });

  it("sends a small snapshot whole", (): void => {
    const events = [emoteChat(1), emoteChat(2)];
    expect(snapshotMessage(events)).toBe(JSON.stringify({ type: "snapshot", events, replay: true }));
  });
});

describe("ChannelIngest requests", (): void => {
  it("answers only its own page, known paths and methods, and known platforms", async (): Promise<void> => {
    const stub = ingest.get(ingest.idFromName(page));
    expect((await stub.fetch("https://channel-ingest.internal/event?streamerId=bad")).status).toBe(400);
    expect((await stub.fetch(`https://channel-ingest.internal/event?streamerId=${otherPage}`)).status).toBe(400);
    expect((await stub.fetch(url("nope"), { method: "POST" })).status).toBe(404);
    expect((await stub.fetch(url("event"))).status).toBe(405);
    expect((await post("event", "tiktok", {})).status).toBe(400);
    // Once bound to a page, the object refuses any other.
    const other = ingest.entry(otherPage);
    await ingest.get(ingest.idFromName(otherPage)).fetch(url("overlay-key").replace(page, otherPage), { method: "POST" });
    expect((await other.room.fetch(new Request(url("overlay-key"), { method: "POST" }))).status).toBe(400);
  });

  it("admits only sockets the Worker vouched for, up to the limit, and sends the snapshot first", async (): Promise<void> => {
    const stub = ingest.get(ingest.idFromName(page));
    expect((await stub.fetch(url("subscribe"))).status).toBe(426);
    expect((await stub.fetch(url("subscribe"), { headers: { Upgrade: "websocket" } })).status).toBe(403);
    const overlay = await listen({ "X-SB-Overlay": "1" });
    expect(state().tagsOf(overlay)).toEqual(["activity", "overlay-key"]);
    expect(overlay.messages()).toEqual([{ type: "snapshot", events: [], replay: true }]);
    for (let index = 1; index < MAX_SOCKETS; index++) await listen();
    expect((await stub.fetch(url("subscribe"), { headers: { Upgrade: "websocket", "X-SB-Owner": "1" } })).status).toBe(429);
  });

  it("closes a socket that sends anything, and the overlay-key sockets when the key changes", async (): Promise<void> => {
    const owner = await listen();
    const overlay = await listen({ "X-SB-Overlay": "1" });
    expect((await post("overlay-key", "twitch")).status).toBe(204);
    expect(overlay.closeCode).toBe(1001);
    expect(overlay.ofType("unavailable")).toHaveLength(1);
    expect(owner.open).toBe(true);
    await room().webSocketMessage(owner as unknown as WebSocket);
    expect(owner.closeCode).toBe(1008);
    const failing = await listen();
    room().webSocketError(failing as unknown as WebSocket);
    expect(failing.closeCode).toBe(1011);
    await room().webSocketClose(failing as unknown as WebSocket);
  });
});

describe("ChannelIngest deliveries", (): void => {
  it("drops deliveries for unknown or revoked channels and malformed bodies", async (): Promise<void> => {
    expect((await deliver("d1", [chat("m1")])).status).toBe(204);
    await addConnection("twitch", { status: "needs_reauth" });
    expect((await deliver("d2", [chat("m2")])).status).toBe(204);
    expect(await snapshot()).toEqual([]);
    expect((await post("event", "twitch", { deliveryId: 5, events: [] })).status).toBe(400);
    expect((await post("event", "twitch", { deliveryId: "x".repeat(200), events: [] })).status).toBe(400);
    expect((await post("event", "twitch")).status).toBe(400);
  });

  it("broadcasts live events once, however often a delivery or message repeats", async (): Promise<void> => {
    await addConnection("twitch");
    const socket = await listen();
    await deliver("d1", [chat("m1")]);
    await deliver("d1", [chat("m1")]);
    await deliver("d2", [chat("m1"), chat("m2")]);
    // A Kick-labelled event in a Twitch delivery and a malformed event are ignored.
    await deliver("d3", [chat("m3", "u1", "kick"), { kind: "nope" } as unknown as ActivityEvent]);
    const live = socket.ofType<{ event: ActivityChat }>("event").map((message) => message.event);
    expect(live.map((event) => [event.id, event.live])).toEqual([
      ["twitch:m1", true],
      ["twitch:m2", true],
    ]);
    const events = await snapshot();
    expect(events.map((event) => [event.id, event.live])).toEqual([
      ["twitch:m1", false],
      ["twitch:m2", false],
    ]);
    expect((await connectionRow("twitch")).last_event_at).not.toBeNull();
  });

  it("removes deleted, banned, timed-out and cleared messages before any snapshot, and never takes them back", async (): Promise<void> => {
    await addConnection("twitch");
    await addConnection("kick");
    await deliver("d1", [chat("m1", "a"), chat("m2", "b"), chat("m3", "c"), chat("m4", "d")]);
    await deliver("k1", [chat("k1", "a", "kick")], "kick");
    const now = Date.now();
    await deliver("d2", [{ kind: "delete", platform: "twitch", messageId: "m1", receivedAt: now }]);
    await deliver("d3", [{ kind: "ban", platform: "twitch", userId: "b", until: null, receivedAt: now }]);
    await deliver("d4", [{ kind: "clear_user", platform: "twitch", userId: "c", receivedAt: now }]);
    expect((await snapshot()).map((event) => event.id)).toEqual(["twitch:m4", "kick:k1"]);
    // A redelivered (or late) copy of a deleted message stays out.
    await deliver("d5", [chat("m1", "a")]);
    // A deletion that arrives before its message keeps the message out.
    await deliver("d6", [{ kind: "delete", platform: "twitch", messageId: "m9", receivedAt: now }]);
    await deliver("d7", [chat("m9", "z")]);
    await deliver("d8", [{ kind: "clear", platform: "twitch", receivedAt: now }]);
    expect((await snapshot()).map((event) => event.id)).toEqual(["kick:k1"]);
  });

  it("keeps the last 100 messages for at most 10 minutes", async (): Promise<void> => {
    await addConnection("twitch");
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    for (let batch = 0; batch < 3; batch++)
      await deliver(`d${batch}`, Array.from({ length: 50 }, (_, index) => chat(`m${batch * 50 + index}`, "u", "twitch", start)));
    const events = await snapshot();
    expect(events).toHaveLength(SNAPSHOT_SIZE);
    expect(events[0].id).toBe("twitch:m50");
    vi.spyOn(Date, "now").mockReturnValue(start + SNAPSHOT_MAX_AGE_MS + 1);
    expect(await snapshot()).toEqual([]);
  });

  it("expires stored messages with the alarm, also when no further delivery comes", async (): Promise<void> => {
    await addConnection("twitch");
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    await deliver("d1", [chat("m1", "u", "twitch", start)]);
    expect(state().storage.alarm).toBe(start + SNAPSHOT_MAX_AGE_MS + 1);
    vi.spyOn(Date, "now").mockReturnValue(start + 60_000);
    await deliver("d2", [chat("m2", "u", "twitch", start + 60_000)]);
    // The first message's expiry stays the next alarm.
    expect(state().storage.alarm).toBe(start + SNAPSHOT_MAX_AGE_MS + 1);
    vi.spyOn(Date, "now").mockReturnValue(start + SNAPSHOT_MAX_AGE_MS + 1);
    await room().alarm();
    const stored = (): string[] =>
      state().storage.sql.exec<{ message_id: string }>("SELECT message_id FROM events").toArray().map((row) => row.message_id);
    expect(stored()).toEqual(["m2"]);
    expect(state().storage.alarm).toBe(start + 60_000 + SNAPSHOT_MAX_AGE_MS + 1);
    vi.spyOn(Date, "now").mockReturnValue(start + 60_000 + SNAPSHOT_MAX_AGE_MS + 1);
    await room().alarm();
    expect(stored()).toEqual([]);
    // The delivery and message ids stay until SEEN_TTL_MS, and an alarm still comes for them.
    const ids = (): number => state().storage.sql.exec("SELECT key FROM seen").toArray().length;
    expect(ids()).toBe(4);
    expect(state().storage.alarm).toBe(start + SEEN_TTL_MS + 1);
    vi.spyOn(Date, "now").mockReturnValue(start + SEEN_TTL_MS + 1);
    await room().alarm();
    expect(ids()).toBe(2);
    // Cleanup alarms come at most once a minute.
    expect(state().storage.alarm).toBe(start + SEEN_TTL_MS + 1 + 60_000);
    vi.spyOn(Date, "now").mockReturnValue(start + SEEN_TTL_MS + 1 + 60_000);
    await room().alarm();
    expect(ids()).toBe(0);
    await state().storage.deleteAlarm();
    await room().alarm();
    expect(state().storage.alarm).toBeNull();
  });

  it("keeps deleted ids and delivery ids for the whole freshness window at the admission cap", async (): Promise<void> => {
    await addConnection("twitch");
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    await deliver("first", [chat("m0")]);
    await deliver("del", [{ kind: "delete", platform: "twitch", messageId: "gone", receivedAt: start }]);
    // Ten minutes of ids at the admission cap (a delivery id and a message id for each of 50 messages a second).
    const sql = state().storage.sql;
    sql.db.exec("BEGIN");
    // Three ids are stored already: the two deliveries and the first message.
    for (let index = 0; index < SEEN_MAX - 3; index++)
      sql.exec("INSERT INTO seen (key, at) VALUES (?, ?)", `filler-${index}`, start + 1 + Math.floor(index / 100) * 1000);
    // Five older ids put the table over its limit.
    for (let index = 0; index < 5; index++) sql.exec("INSERT INTO seen (key, at) VALUES (?, ?)", `old-${index}`, start - 1);
    sql.db.exec("COMMIT");
    // A restart counts the stored ids again.
    ingest.restart(page);
    const now = start + 600_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const socket = await listen();
    // A retry of the first delivery, still inside the 10-minute webhook window, is still recognized.
    await deliver("first", [chat("m0")]);
    // Over the limit, only the oldest ids went.
    expect(sql.exec("SELECT key FROM seen WHERE key LIKE 'old-%'").toArray()).toEqual([]);
    expect(sql.exec("SELECT key FROM seen WHERE key='delivery:twitch:first'").toArray()).toHaveLength(1);
    // A late copy of the deleted message stays out.
    await deliver("late", [chat("gone", "u1", "twitch", now)]);
    expect(socket.ofType("event")).toEqual([]);
    expect(sql.exec("SELECT key FROM seen").toArray().length).toBe(SEEN_MAX);
  });

  it("bounds a burst with the admission bucket and counts what it drops", async (): Promise<void> => {
    await addConnection("twitch");
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const socket = await listen();
    for (let batch = 0; batch < 6; batch++)
      await deliver(`d${batch}`, Array.from({ length: 60 }, (_, index) => chat(`m${batch}-${index}`)));
    expect(socket.ofType("event")).toHaveLength(ADMISSION_BURST);
    expect(warn).toHaveBeenCalledWith("channel_ingest_dropped", { chat: 50, moderation: 0 });
    // The bucket refills over time.
    vi.spyOn(Date, "now").mockReturnValue(now + 1000);
    await deliver("later", [chat("later")]);
    expect(socket.ofType("event")).toHaveLength(ADMISSION_BURST + 1);
  });
});

describe("ChannelIngest status and disconnect", (): void => {
  it("marks a revoked authorization as needing a reconnect and tells the consumers", async (): Promise<void> => {
    await addConnection("twitch");
    const socket = await listen();
    expect((await post("status", "twitch", { code: "Bad Code" })).status).toBe(400);
    expect((await post("status", "twitch", { code: "authorization_revoked" })).status).toBe(204);
    expect(await connectionRow("twitch")).toMatchObject({ status: "needs_reauth", status_code: "authorization_revoked" });
    expect(socket.ofType<{ event: unknown }>("event").map((message) => message.event)).toEqual([
      { kind: "status", platform: "twitch", status: "needs_reauth", code: "authorization_revoked" },
    ]);
    await post("status", "twitch", { code: "delivery_failed" });
    expect(await connectionRow("twitch")).toMatchObject({ status: "error", status_code: "delivery_failed" });
    expect((await post("status", "kick", { code: "delivery_failed" })).status).toBe(204);
  });

  it("purges the platform's messages on disconnect, also without a connection", async (): Promise<void> => {
    await addConnection("twitch");
    await addConnection("kick");
    await deliver("d1", [chat("m1")]);
    await deliver("k1", [chat("k1", "a", "kick")], "kick");
    expect(await (await post("disconnect", "twitch")).json()).toEqual({ revoked: true, unsubscribed: true });
    expect((await snapshot()).map((event) => event.id)).toEqual(["kick:k1"]);
    await env.DB.prepare("DELETE FROM channel_connections WHERE platform='kick'").run();
    expect(await (await post("disconnect", "kick")).json()).toEqual({ revoked: false, unsubscribed: true });
    expect(await snapshot()).toEqual([]);
  });

  it("reports a connect without a connection row, and a network failure while unsubscribing", async (): Promise<void> => {
    expect(await (await post("connect", "kick")).json()).toEqual({ status: "error", code: "subscribe_failed" });
    await addConnection("twitch");
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    expect(await (await post("connect", "twitch")).json()).toEqual({ status: "active", code: null });
    fake.failNetwork = /oauth2\/token/;
    expect(await (await post("disconnect", "twitch")).json()).toEqual({ revoked: true, unsubscribed: false });
  });
});

describe("ChannelIngest load and robustness", (): void => {
  /** Counts D1 reads of channel_connections. */
  function countConnectionReads(): () => number {
    let reads = 0;
    const real = env.DB;
    env.DB = {
      prepare: (sql: string): D1PreparedStatement => {
        if (sql.includes("FROM channel_connections c")) reads += 1;
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    return (): number => reads;
  }

  it("reads the connection from D1 once for a burst, and not at all for duplicates", async (): Promise<void> => {
    await addConnection("twitch");
    const reads = countConnectionReads();
    for (let index = 0; index < 20; index++) await deliver(`d${index}`, [chat(`m${index}`)]);
    expect(reads()).toBe(1);
    // A change to the connection clears the cache and reads it again once.
    await post("status", "twitch", { code: "delivery_failed" });
    expect(reads()).toBe(2);
    await deliver("d0", [chat("m0")]);
    await deliver("new", [chat("new")]);
    expect(reads()).toBe(2);
    // After the cache time, the next delivery reads it again.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + CONNECTION_CACHE_MS + 1_000);
    await deliver("later", [chat("later")]);
    expect(reads()).toBe(3);
  });

  it("deduplicates and admits before it reads D1, also with a cold cache", async (): Promise<void> => {
    await addConnection("twitch");
    await deliver("d1", [chat("m1")]);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + CONNECTION_CACHE_MS);
    const reads = countConnectionReads();
    await deliver("d1", [chat("m1")]);
    expect(reads()).toBe(0);
    // An empty bucket: a chat-only delivery is refused before any read.
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    for (let index = 0; index < ADMISSION_BURST; index++) await deliver(`f${index}`, [chat(`f${index}`)]);
    const before = reads();
    await deliver("refused", [chat("refused")]);
    expect(reads()).toBe(before);
  });

  it("closes no socket that raced a suspension, and trusts a fresh read otherwise", async (): Promise<void> => {
    const real = env.DB;
    let release: () => void = (): void => undefined;
    const gate = new Promise<void>((resolve): void => {
      release = resolve;
    });
    let held = false;
    env.DB = {
      prepare: (sql: string): D1PreparedStatement => {
        const statement = real.prepare(sql);
        if (sql === "SELECT status FROM streamers WHERE id=?" && !held) {
          held = true;
          return {
            bind: (...values: unknown[]) => ({
              first: async <T>(): Promise<T | null> => {
                const row = await statement.bind(...values).first<T>();
                await gate;
                return row;
              },
            }),
          } as unknown as D1PreparedStatement;
        }
        return statement;
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    // The subscribe reads "active", then a suspension arrives before it accepts.
    const stub = ingest.get(ingest.idFromName(page));
    const pending = stub.fetch(url("subscribe"), { headers: { Upgrade: "websocket", "X-SB-Owner": "1" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await real.prepare("UPDATE streamers SET status='suspended' WHERE id=?").bind(page).run();
    await post("page-status", "twitch");
    release();
    expect((await pending).status).toBe(404);
    // Lifted again: a later subscribe trusts its own fresh read.
    await real.prepare("UPDATE streamers SET status='active' WHERE id=?").bind(page).run();
    env.DB = real;
    expect((await stub.fetch(url("subscribe"), { headers: { Upgrade: "websocket", "X-SB-Owner": "1" } })).status).toBe(101);
  });

  it("refuses an overlay socket whose key changed while its check waited", async (): Promise<void> => {
    const real = env.DB;
    let release: () => void = (): void => undefined;
    const gate = new Promise<void>((resolve): void => {
      release = resolve;
    });
    let held = false;
    env.DB = {
      prepare: (sql: string): D1PreparedStatement => {
        const statement = real.prepare(sql);
        if (sql === "SELECT status FROM streamers WHERE id=?" && !held) {
          held = true;
          return {
            bind: (...values: unknown[]) => ({
              first: async <T>(): Promise<T | null> => {
                const row = await statement.bind(...values).first<T>();
                await gate;
                return row;
              },
            }),
          } as unknown as D1PreparedStatement;
        }
        return statement;
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    const stub = ingest.get(ingest.idFromName(page));
    const pending = stub.fetch(url("subscribe"), { headers: { Upgrade: "websocket", "X-SB-Overlay": "1" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await post("overlay-key", "twitch")).status).toBe(204);
    release();
    expect((await pending).status).toBe(403);
    expect(state().getWebSockets("overlay-key")).toHaveLength(0);
    env.DB = real;
    // A request with the new key afterwards connects.
    expect((await stub.fetch(url("subscribe"), { headers: { Upgrade: "websocket", "X-SB-Overlay": "1" } })).status).toBe(101);
  });

  it("keeps a reconnect when the hourly refresh of the old authorization is refused", async (): Promise<void> => {
    await addConnection("youtube");
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const real = globalThis.fetch;
    let hold = true;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      if (!hold || !new URL(input).pathname.endsWith("/youtube/v3/channels")) return real(input, init);
      hold = false;
      reached();
      await held;
      return new Response("expired", { status: 401 });
    });
    const pending = post("refresh", "youtube");
    await waiting;
    expect(await (await post("connect", "youtube")).json()).toEqual({ status: "active", code: null });
    release();
    expect(await (await pending).json()).toEqual({ result: "failed" });
    expect(await connectionRow("youtube")).toMatchObject({ status: "active", status_code: null });
  });

  it("writes nothing back from a disconnect that a close overtook", async (): Promise<void> => {
    await addConnection("twitch");
    await post("connect", "twitch");
    fake.deleteStatus = 500;
    fake.duringRefresh = null;
    const fetchReal = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      if (new URL(input).pathname.endsWith("/revoke")) await post("close", "twitch");
      return fetchReal(input, init);
    });
    await post("disconnect", "twitch");
    // The close deleted everything; the disconnect that it overtook stores nothing, not even its kept ids.
    expect(state().storage.values.size).toBe(0);
  });

  it("passes moderation on an empty chat bucket, also inside a delivery full of chat", async (): Promise<void> => {
    await addConnection("twitch");
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const sql = state().storage.sql;
    // Empty deliveries are not remembered and take no token.
    await deliver("empty", []);
    expect(sql.exec("SELECT key FROM seen WHERE key LIKE 'delivery:%'").toArray()).toEqual([]);
    // A chat flood empties the chat bucket; the excess is dropped and counted.
    for (let index = 0; index <= ADMISSION_BURST; index++) await deliver(`chat-${index}`, [chat(`m${index}`)]);
    expect(sql.exec("SELECT key FROM seen WHERE key = ?", `delivery:twitch:chat-${ADMISSION_BURST}`).toArray()).toEqual([]);
    expect(warn).toHaveBeenCalledWith("channel_ingest_dropped", { chat: 1, moderation: 0 });
    // A delete inside a delivery of more chat still goes through at once and leaves the snapshot.
    const socket = await listen();
    const flood = Array.from({ length: 10 }, (_, index) => chat(`late-${index}`));
    await deliver("mixed", [{ kind: "delete", platform: "twitch", messageId: "m0", receivedAt: now }, ...flood]);
    expect(socket.ofType<{ event: { kind: string } }>("event").map((message) => message.event.kind)).toEqual(["delete"]);
    expect((await snapshot()).map((event) => event.id)).not.toContain("twitch:m0");
  });

  it("charges no token for chat already seen or deleted, wherever it is in the delivery", async (): Promise<void> => {
    await addConnection("twitch");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    await deliver("seen", [chat("old")]);
    await deliver("del", [{ kind: "delete", platform: "twitch", messageId: "gone", receivedAt: now }]);
    for (let index = 1; index < ADMISSION_BURST; index++) await deliver(`f${index}`, [chat(`f${index}`)]);
    const socket = await listen();
    // One token left after 20 ms: the new message gets it, the known ones at the end cost nothing.
    vi.spyOn(Date, "now").mockReturnValue(now + 20);
    await deliver("again", [chat("brand-new"), chat("old"), chat("gone")]);
    expect(socket.ofType<{ event: { id?: string } }>("event").map((message) => message.event.id)).toEqual([
      "twitch:brand-new",
    ]);
  });

  it("remembers moderation deliveries, so a repeated clear never removes newer chat", async (): Promise<void> => {
    await addConnection("twitch");
    const now = Date.now();
    await deliver("d1", [{ kind: "clear", platform: "twitch", receivedAt: now }]);
    await deliver("d2", [chat("m2")]);
    const socket = await listen();
    // Twitch delivers at least once: the same clear comes again.
    await deliver("d1", [{ kind: "clear", platform: "twitch", receivedAt: now }]);
    expect((await snapshot()).map((event) => event.id)).toEqual(["twitch:m2"]);
    expect(socket.ofType("event")).toEqual([]);
  });

  it("deduplicates copies of one ban by content and sends a timeout that already ended as a clear_user", async (): Promise<void> => {
    await addConnection("kick");
    const now = Date.now();
    const socket = await listen();
    const until = now + 60_000;
    // Copies of one ban that came back through other apps carry new delivery ids.
    for (let index = 0; index < 3; index++)
      await deliver(`copy-${index}`, [{ kind: "ban", platform: "kick", userId: "u", until, receivedAt: now }], "kick");
    await deliver("ended", [{ kind: "ban", platform: "kick", userId: "v", until: now - 1, receivedAt: now }], "kick");
    // A ban of the same user with another end is a new ban.
    await deliver("longer", [{ kind: "ban", platform: "kick", userId: "u", until: null, receivedAt: now }], "kick");
    expect(socket.ofType<{ event: { userId: string; until: number | null } }>("event").map((message) => message.event)).toMatchObject([
      { kind: "ban", userId: "u", until },
      { kind: "clear_user", userId: "v" },
      { kind: "ban", userId: "u", until: null },
    ]);
  });

  it("purges again on a new ban after an unban, and sends an ended timeout as a clear_user", async (): Promise<void> => {
    await addConnection("kick");
    const now = Date.now();
    const socket = await listen();
    const ban = (bannedAt: number) => ({ kind: "ban", platform: "kick", userId: "u", until: null, receivedAt: now, bannedAt }) as const;
    await deliver("ban-1", [ban(now - 60_000)], "kick");
    // Unbanned (Kick does not report it), the user writes again, and a moderator bans again.
    await deliver("chat-1", [chat("after", "u", "kick")], "kick");
    await deliver("ban-2", [ban(now)], "kick");
    expect((await snapshot()).map((event) => event.id)).toEqual([]);
    expect(socket.ofType<{ event: { kind: string } }>("event").map((message) => message.event.kind)).toEqual(["ban", "chat", "ban"]);
    // A late timeout that already ended removes the user's messages; consumers remove them too, but see no ban.
    await deliver("chat-2", [chat("later", "v", "kick")], "kick");
    const before = socket.ofType("event").length;
    await deliver("ended", [{ kind: "ban", platform: "kick", userId: "v", until: now - 1, receivedAt: now }], "kick");
    expect((await snapshot()).map((event) => event.id)).toEqual([]);
    expect(socket.ofType<{ event: unknown }>("event").slice(before).map((message) => message.event)).toEqual([
      { kind: "clear_user", platform: "kick", userId: "v", receivedAt: now },
    ]);
  });

  it("bounds replayed or flooding moderation with its own bucket", async (): Promise<void> => {
    await addConnection("kick");
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const socket = await listen();
    const ban = (userId: string) => ({ kind: "ban", platform: "kick", userId, until: null, receivedAt: now }) as const;
    // The same signed delivery replayed is deduplicated.
    for (let index = 0; index < 5; index++) await deliver("replayed", [ban("u")], "kick");
    expect(socket.ofType("event")).toHaveLength(1);
    // Distinct deliveries stop at the moderation burst.
    for (let index = 0; index < MODERATION_BURST + 20; index++) await deliver(`ban-${index}`, [ban(`u${index}`)], "kick");
    expect(socket.ofType("event")).toHaveLength(MODERATION_BURST);
    expect(warn).toHaveBeenCalledWith("channel_ingest_dropped", { chat: 0, moderation: 1 });
    // Status events are never taken from a delivery.
    await deliver("status", [{ kind: "status", platform: "kick", status: "active" }], "kick");
    expect(socket.ofType("event")).toHaveLength(MODERATION_BURST);
  });

  it("handles parallel copies of one delivery once", async (): Promise<void> => {
    await addConnection("twitch");
    const socket = await listen();
    const clear: ActivityEvent = { kind: "clear", platform: "twitch", receivedAt: Date.now() };
    await Promise.all([deliver("same", [clear]), deliver("same", [clear])]);
    expect(socket.ofType("event")).toHaveLength(1);
  });

  it("drops a delivery whose connection read a disconnect overtook, and caches nothing stale", async (): Promise<void> => {
    await addConnection("twitch");
    const socket = await listen();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const db = env.DB;
    let hold = true;
    const prepare = (query: string): D1PreparedStatement => {
      const statement = db.prepare(query);
      if (!hold || !query.includes("FROM channel_connections c")) return statement;
      hold = false;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            first: async <T,>(): Promise<T | null> => {
              const row = await bound.first<T>();
              reached();
              await held;
              return row;
            },
          };
        },
      } as unknown as D1PreparedStatement;
    };
    env.DB = { prepare, batch: (statements: D1PreparedStatement[]) => db.batch(statements) } as unknown as D1Database;
    // The delivery reads the active connection, then waits while the disconnect runs to its end.
    const delivery = deliver("late", [chat("late")]);
    await waiting;
    await db.prepare("UPDATE channel_connections SET status='needs_reauth', status_code='disconnecting'").run();
    expect((await post("disconnect", "twitch")).status).toBe(200);
    release();
    expect((await delivery).status).toBe(204);
    await deliver("next", [chat("next")]);
    expect(socket.ofType<{ event: { kind: string } }>("event").map((message) => message.event.kind)).toEqual(["status"]);
  });

  it("does not cache an active status that a disconnect overtook while it was written", async (): Promise<void> => {
    await addConnection("twitch");
    const socket = await listen();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const db = env.DB;
    let hold = true;
    const prepare = (query: string): D1PreparedStatement => {
      const statement = db.prepare(query);
      if (!hold || !query.includes("UPDATE channel_connections SET status=?1")) return statement;
      hold = false;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            run: async (): Promise<D1Result> => {
              reached();
              await held;
              return bound.run();
            },
          };
        },
      } as unknown as D1PreparedStatement;
    };
    env.DB = { prepare, batch: (statements: D1PreparedStatement[]) => db.batch(statements) } as unknown as D1Database;
    // The connect's `active` write waits while a disconnect marks the row and runs to its end.
    const connect = post("connect", "twitch");
    await waiting;
    await db.prepare("UPDATE channel_connections SET status='needs_reauth', status_code='disconnecting'").run();
    expect((await post("disconnect", "twitch")).status).toBe(200);
    release();
    await connect;
    env.DB = db;
    expect(await connectionRow("twitch")).toMatchObject({ status: "needs_reauth", status_code: "disconnecting" });
    await deliver("after", [chat("after")]);
    expect(socket.ofType<{ event: { kind: string } }>("event").some((message) => message.event.kind === "chat")).toBe(false);
  });

  it("drops a delivery for another channel than the page's connection", async (): Promise<void> => {
    await addConnection("twitch");
    const socket = await listen();
    await deliver("other", [chat("x")], "twitch", "999");
    await deliver("other-clear", [{ kind: "clear", platform: "twitch", receivedAt: Date.now() }], "twitch", "999");
    expect(socket.ofType("event")).toEqual([]);
    expect((await post("event", "twitch", { deliveryId: "no-channel", events: [] })).status).toBe(400);
  });

  it("keeps the cleanup alarm when the poll fails before it starts", async (): Promise<void> => {
    await addConnection("youtube");
    await addConnection("twitch");
    await deliver("d1", [chat("m1")]);
    await listen();
    const errors = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    vi.spyOn(state().storage, "get").mockRejectedValue(new Error("storage down"));
    await state().storage.deleteAlarm();
    await room().alarm();
    expect(errors).toHaveBeenCalledWith("channel_poll_failed", { platform: "youtube", cause: "Error" });
    expect(state().storage.alarm).not.toBeNull();
  });

  it("deletes all stored state when the page goes away and still works after", async (): Promise<void> => {
    await addConnection("twitch");
    await deliver("d1", [chat("m1")]);
    await state().storage.put("subs:twitch", ["a"]);
    expect((await post("close", "twitch")).status).toBe(204);
    expect(state().storage.values.size).toBe(0);
    expect(state().storage.alarm).toBeNull();
    // The object binds to the page again and has fresh tables.
    expect((await deliver("d2", [chat("m2")])).status).toBe(204);
    expect((await snapshot()).map((event) => event.id)).toEqual(["twitch:m2"]);
  });

  it("writes nothing from a YouTube poll that a disconnect overtook", async (): Promise<void> => {
    await addConnection("youtube");
    await listen();
    await state().ready;
    await room().alarm();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      const response = await real(input, init);
      if (new URL(input).pathname.endsWith("/liveChat/messages")) await post("disconnect", "youtube");
      return response;
    });
    fake.chatPages = [{ items: [youtubeText("late", "UCa", "hi", {}, new Date().toISOString())], nextPageToken: "p" }];
    await state().storage.deleteAlarm();
    await room().alarm();
    expect(state().storage.sql.exec("SELECT seq FROM events").toArray()).toEqual([]);
    expect(await state().storage.get("youtube")).toBeUndefined();
  });

  it("writes nothing from a YouTube poll that a page suspension overtook", async (): Promise<void> => {
    await addConnection("youtube");
    await listen();
    await state().ready;
    await room().alarm();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      const response = await real(input, init);
      if (new URL(input).pathname.endsWith("/liveChat/messages")) {
        await env.DB.prepare("UPDATE streamers SET status='suspended' WHERE id=?").bind(page).run();
        await post("page-status", "youtube");
      }
      return response;
    });
    fake.chatPages = [{ items: [youtubeText("late", "UCa", "hi", {}, new Date().toISOString())], nextPageToken: "p" }];
    await state().storage.deleteAlarm();
    await room().alarm();
    expect(state().storage.sql.exec("SELECT seq FROM events").toArray()).toEqual([]);
  });

  it("keeps subscription ids it could not delete on disconnect", async (): Promise<void> => {
    await addConnection("twitch");
    await post("connect", "twitch");
    fake.deleteStatus = 500;
    await post("disconnect", "twitch");
    expect(await state().storage.get("subs:twitch")).toHaveLength(5);
  });

  it("closes the activity sockets on the next call while channels are off", async (): Promise<void> => {
    const socket = await listen();
    env.CHANNELS_OFF = "1";
    await room().alarm();
    expect(socket.ofType("unavailable")).toHaveLength(1);
    expect(socket.open).toBe(false);
  });

  it("starts the quota rows at the day's reset, so cleanup never removes them early", async (): Promise<void> => {
    await addConnection("youtube");
    await listen();
    await state().ready;
    await room().alarm();
    const { resetAt } = quotaDay(Date.now());
    const rows = await env.DB.prepare("SELECT window_start FROM app_rate_limits WHERE key LIKE 'youtube-quota:%'").all();
    expect(rows.results).toEqual([{ window_start: resetAt }, { window_start: resetAt }]);
  });
});

describe("ChannelIngest races with close", (): void => {
  it("leaves storage empty and no alarm when a close overtakes a connect", async (): Promise<void> => {
    await addConnection("youtube", { expiresAt: Date.now() - 1 });
    fake.duringRefresh = async (): Promise<void> => {
      await post("close", "youtube");
    };
    expect(await (await post("connect", "youtube")).json()).toEqual({ status: "error", code: "subscribe_failed" });
    expect(state().storage.values.size).toBe(0);
    expect(state().storage.alarm).toBeNull();
  });

  it("takes no status event from a delivery, also as the first request of a new object", async (): Promise<void> => {
    await addConnection("kick");
    expect((await deliver("only-status", [{ kind: "status", platform: "kick", status: "active" }], "kick")).status).toBe(204);
    expect(state().storage.sql.exec("SELECT key FROM seen").toArray()).toEqual([]);
  });
});

describe("ChannelIngest status writes", (): void => {
  it("moves the status time only when the status or its code changes", async (): Promise<void> => {
    await addConnection("twitch");
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await post("status", "twitch", { code: "delivery_failed" });
    vi.spyOn(Date, "now").mockReturnValue(now + 5000);
    await post("status", "twitch", { code: "delivery_failed" });
    const time = (): Promise<unknown> => env.DB.prepare("SELECT updated_at FROM channel_connections").first("updated_at");
    expect(await time()).toBe(now);
    await post("status", "twitch", { code: "subscription_removed" });
    expect(await time()).toBe(now + 5000);
  });

  it("never overwrites the mark of a running disconnect", async (): Promise<void> => {
    await addConnection("twitch");
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    await env.DB.prepare("UPDATE channel_connections SET status='needs_reauth', status_code='disconnecting'").run();
    await post("status", "twitch", { code: "delivery_failed" });
    expect(await connectionRow("twitch")).toMatchObject({ status: "needs_reauth", status_code: "disconnecting" });
  });
});

describe("ChannelIngest on a suspended page", (): void => {
  it("drops deliveries, refuses sockets, closes open ones and stops polling", async (): Promise<void> => {
    await addConnection("twitch");
    await addConnection("youtube");
    const socket = await listen();
    await env.DB.prepare("UPDATE streamers SET status='suspended' WHERE id=?").bind(page).run();
    expect((await post("page-status", "twitch")).status).toBe(204);
    expect(socket.ofType("unavailable")).toHaveLength(1);
    expect(socket.closeCode).toBe(1001);
    const stub = ingest.get(ingest.idFromName(page));
    expect((await stub.fetch(url("subscribe"), { headers: { Upgrade: "websocket", "X-SB-Owner": "1" } })).status).toBe(404);
    await deliver("d1", [chat("m1")]);
    expect(state().storage.sql.exec("SELECT seq FROM events").toArray()).toEqual([]);
    await env.DB.prepare("UPDATE streamers SET status='active' WHERE id=?").bind(page).run();
    await post("page-status", "twitch");
    const open = await listen();
    // A frozen page keeps its sockets.
    await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(page).run();
    await post("page-status", "twitch");
    expect(open.open).toBe(true);
    // Suspended again, with a socket left open (for example a page-status call that failed): no poll runs.
    await env.DB.prepare("UPDATE streamers SET status='suspended' WHERE id=?").bind(page).run();
    await post("status", "kick", { code: "delivery_failed" });
    fake.calls.length = 0;
    await room().alarm();
    expect(fake.calls).toHaveLength(0);
  });
});

describe("ChannelIngest provider subscriptions", (): void => {
  const callback = `${origin}/hooks/twitch`;

  it("deletes orphaned subscriptions for this callback before subscribing, and leaves other deployments alone", async (): Promise<void> => {
    await addConnection("twitch");
    fake.subscriptions.push(
      { platform: "twitch", id: "orphan", broadcaster: "111", callback },
      { platform: "twitch", id: "staging", broadcaster: "111", callback: "https://staging.example.test/hooks/twitch" },
    );
    expect(await (await post("connect", "twitch")).json()).toEqual({ status: "active", code: null });
    const ids = fake.subscriptions.map((item) => item.id);
    expect(ids).not.toContain("orphan");
    expect(ids).toContain("staging");
    expect(await state().storage.get("subs:twitch")).toEqual(ids.filter((id) => id !== "staging"));
  });

  const TWITCH_TYPES = [
    "channel.chat.message",
    "channel.chat.message_delete",
    "channel.chat.clear",
    "channel.chat.clear_user_messages",
    "channel.moderate",
  ];

  function stuck(callbackUrl: string = callback): void {
    for (const [index, type] of TWITCH_TYPES.entries())
      fake.subscriptions.push({ platform: "twitch", id: `stuck-${index}`, broadcaster: "111", callback: callbackUrl, type });
  }

  it("adopts existing subscriptions of every conflicting type and keeps ids it could not delete", async (): Promise<void> => {
    await addConnection("twitch");
    stuck();
    fake.deleteStatus = 500;
    expect(await (await post("connect", "twitch")).json()).toEqual({ status: "active", code: null });
    expect(await state().storage.get("subs:twitch")).toEqual(["stuck-0", "stuck-1", "stuck-2", "stuck-3", "stuck-4"]);
  });

  it("adopts on a conflict when only the first list failed", async (): Promise<void> => {
    await addConnection("twitch");
    stuck();
    fake.deleteStatus = 500;
    // The list before the deletes fails, so the stuck ids are unknown until the conflict lists again.
    fake.listFailures = 1;
    expect(await (await post("connect", "twitch")).json()).toEqual({ status: "active", code: null });
    expect(await state().storage.get("subs:twitch")).toEqual(["stuck-0", "stuck-1", "stuck-2", "stuck-3", "stuck-4"]);
  });

  it("fails the connect when a conflicting subscription belongs to another callback", async (): Promise<void> => {
    await addConnection("twitch");
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    stuck("https://staging.example.test/hooks/twitch");
    expect(await (await post("connect", "twitch")).json()).toEqual({ status: "error", code: "subscribe_failed" });
    expect(fake.subscriptions.filter((item) => item.callback === callback)).toEqual([]);
  });

  it("fails the connect when one conflicting type is adopted and another belongs to another callback", async (): Promise<void> => {
    await addConnection("twitch");
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    fake.subscriptions.push(
      { platform: "twitch", id: "mine", broadcaster: "111", callback, type: "channel.chat.message" },
      { platform: "twitch", id: "theirs", broadcaster: "111", callback: "https://staging.example.test/hooks/twitch", type: "channel.chat.clear" },
    );
    fake.deleteStatus = 500;
    expect(await (await post("connect", "twitch")).json()).toEqual({ status: "error", code: "subscribe_failed" });
    expect(await state().storage.get<string[]>("subs:twitch")).toContain("mine");
    expect(await state().storage.get<string[]>("subs:twitch")).not.toContain("theirs");
  });

  it("fails the connect when the list fails after a conflict", async (): Promise<void> => {
    await addConnection("twitch");
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    stuck();
    fake.deleteStatus = 500;
    fake.listFailures = 2;
    expect(await (await post("connect", "twitch")).json()).toEqual({ status: "error", code: "subscribe_failed" });
  });

  it("stores the ids created before a failure, so disconnect can delete them", async (): Promise<void> => {
    await addConnection("kick");
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    // The provider accepts one event and refuses the other.
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      const response = await real(input, init);
      if (init?.method === "POST" && new URL(input).hostname === "api.kick.com")
        return Response.json({ data: [{ subscription_id: fake.subscriptions[0].id }, { subscription_id: null, error: "no" }] });
      return response;
    });
    expect(await (await post("connect", "kick")).json()).toEqual({ status: "error", code: "subscribe_failed" });
    const stored = (await state().storage.get<string[]>("subs:kick")) ?? [];
    expect(stored).toHaveLength(1);
    expect(await (await post("disconnect", "kick")).json()).toMatchObject({ unsubscribed: true });
    expect(fake.subscriptions.map((item) => item.id)).not.toContain(stored[0]);
  });

  it("reports unsubscribed false when a delete fails or the provider list cannot be read", async (): Promise<void> => {
    await addConnection("twitch");
    await post("connect", "twitch");
    fake.deleteStatus = 500;
    expect(await (await post("disconnect", "twitch")).json()).toEqual({ revoked: true, unsubscribed: false });
    fake.deleteStatus = null;
    await post("connect", "twitch");
    fake.listStatus = 500;
    expect(await (await post("disconnect", "twitch")).json()).toEqual({ revoked: true, unsubscribed: false });
  });
});

describe("ChannelIngest tokens", (): void => {
  it("refreshes an expiring token once and stores the rotated refresh token encrypted", async (): Promise<void> => {
    const id = await addConnection("kick", { expiresAt: Date.now() + 1000 });
    await post("connect", "kick");
    expect(fake.refreshes).toBe(1);
    const refresh = fake.calls.find((item) => item.body.includes("grant_type=refresh_token"));
    expect(new URLSearchParams(refresh?.body).get("refresh_token")).toBe("kick-stored-refresh");
    expect(await loadTokens(env, id, "kick")).toMatchObject({ accessToken: "kick-access-1", refreshToken: "kick-refresh-1" });
  });

  it("keeps the newer tokens when another writer replaced them during a refresh (refresh race)", async (): Promise<void> => {
    const id = await addConnection("kick", { expiresAt: Date.now() - 1 });
    fake.duringRefresh = async (): Promise<void> => {
      // A reconnect stores new tokens while this refresh is in flight.
      await (await tokenStatement(env, id, "kick", { accessToken: "reconnect-access", refreshToken: "reconnect-refresh", expiresAt: Date.now() + 3_600_000 }, 500)).run();
    };
    expect(await (await post("connect", "kick")).json()).toEqual({ status: "active", code: null });
    expect(await loadTokens(env, id, "kick")).toMatchObject({ accessToken: "reconnect-access", refreshToken: "reconnect-refresh" });
    const subscribe = fake.calls.find((item) => item.method === "POST" && item.url.hostname === "api.kick.com");
    expect(subscribe?.headers.get("Authorization")).toBe("Bearer reconnect-access");
  });

  it("uses a reconnect's new tokens when the old refresh is refused during it", async (): Promise<void> => {
    const id = await addConnection("kick", { expiresAt: Date.now() - 1 });
    fake.refreshStatus = 400;
    fake.duringRefresh = async (): Promise<void> => {
      // A reconnect stores new tokens while the old, revoked refresh token is in flight.
      await (await tokenStatement(env, id, "kick", { accessToken: "reconnect-access", refreshToken: "reconnect-refresh", expiresAt: Date.now() + 3_600_000 }, 500)).run();
    };
    expect(await (await post("connect", "kick")).json()).toEqual({ status: "active", code: null });
    const subscribe = fake.calls.find((item) => item.method === "POST" && item.url.hostname === "api.kick.com");
    expect(subscribe?.headers.get("Authorization")).toBe("Bearer reconnect-access");
  });

  it("runs one refresh when two requests need fresh tokens at once", async (): Promise<void> => {
    await addConnection("kick", { expiresAt: Date.now() - 1 });
    let release: () => void = (): void => undefined;
    const gate = new Promise<void>((resolve): void => {
      release = resolve;
    });
    fake.duringRefresh = async (): Promise<void> => gate;
    const first = post("connect", "kick");
    const second = post("disconnect", "kick");
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([first, second]);
    expect(fake.refreshes).toBe(1);
  });

  it("marks tokens that no longer decrypt as needing a reconnect", async (): Promise<void> => {
    await addConnection("kick");
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    await env.DB.prepare("UPDATE channel_tokens SET key_id='gone'").run();
    expect(await (await post("connect", "kick")).json()).toEqual({ status: "needs_reauth", code: "authorization_revoked" });
    await env.DB.prepare("UPDATE channel_tokens SET key_id='k1', access_token='broken.value'").run();
    expect(await (await post("connect", "kick")).json()).toEqual({ status: "needs_reauth", code: "authorization_revoked" });
  });

  it("marks a refused refresh as needing a reconnect", async (): Promise<void> => {
    await addConnection("kick", { expiresAt: Date.now() - 1 });
    fake.refreshStatus = 400;
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    expect(await (await post("connect", "kick")).json()).toEqual({ status: "needs_reauth", code: "authorization_revoked" });
    expect(await connectionRow("kick")).toMatchObject({ status: "needs_reauth" });
    expect(warn).toHaveBeenCalledWith("channel_status_changed", {
      platform: "kick",
      status: "needs_reauth",
      code: "authorization_revoked",
    });
  });

  it("never logs tokens, codes or message text", async (): Promise<void> => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error"] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]): void => {
        logged.push(args);
      });
    await addConnection("youtube", { expiresAt: Date.now() - 1 });
    await addConnection("twitch");
    fake.subscribeStatus = 500;
    await post("connect", "twitch");
    fake.tokenStatus = 503;
    await listen();
    await room().alarm();
    await deliver("d", Array.from({ length: 50 }, (_, index) => chat(`secret-${index}`)));
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toMatch(/stored-access|stored-refresh|secret-|hello|twitch-app-token/);
  });
});

describe("ChannelIngest YouTube polling", (): void => {
  let clock: number;

  beforeEach((): void => {
    clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation((): number => clock);
  });

  /** Runs the alarm, as the runtime does: after the constructor, and not before the alarm time. */
  async function poll(): Promise<void> {
    await state().ready;
    clock = Math.max(clock, state().storage.alarm ?? clock);
    await room().alarm();
  }

  function pollCalls(): number {
    return fake.calls.filter((item) => item.url.hostname === "www.googleapis.com").length;
  }

  async function quota(key: string): Promise<unknown> {
    return env.DB.prepare("SELECT count FROM app_rate_limits WHERE key=?").bind(key).first("count");
  }

  it("ignores a poll under the old authorization that fails after a reconnect", async (): Promise<void> => {
    await addConnection("youtube");
    await listen();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const real = globalThis.fetch;
    let hold = true;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      if (!hold || new URL(input).hostname !== "www.googleapis.com") return real(input, init);
      hold = false;
      reached();
      await held;
      return new Response("expired", { status: 401 });
    });
    const pending = poll();
    await waiting;
    expect(await (await post("connect", "youtube")).json()).toEqual({ status: "active", code: null });
    release();
    await pending;
    expect(await connectionRow("youtube")).toMatchObject({ status: "active", status_code: null });
  });

  it("waits for pending subscription creation before completing a disconnect", async (): Promise<void> => {
    await addConnection("twitch");
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reached = (): void => undefined;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const real = globalThis.fetch;
    let hold = true;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      if (hold && init?.method === "POST" && new URL(input).pathname.endsWith("/eventsub/subscriptions")) {
        hold = false;
        reached();
        await held;
      }
      return real(input, init);
    });
    const reconnect = post("connect", "twitch");
    await waiting;
    await env.DB.prepare("UPDATE channel_connections SET status_code='disconnecting'").run();
    const disconnect = post("disconnect", "twitch");
    // Give cleanup a turn while the provider has not yet created the subscription.
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
    release();
    await reconnect;
    expect(await (await disconnect).json()).toEqual({ revoked: true, unsubscribed: true });
    expect(fake.subscriptions).toEqual([]);
    expect(state().storage.values.has("subs:twitch")).toBe(false);
  });

  it("serializes reconnects while an older subscription lookup is pending", async (): Promise<void> => {
    await addConnection("twitch");
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reached = (): void => undefined;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const real = globalThis.fetch;
    let hold = true;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      if (hold && new URL(input).hostname === "id.twitch.tv") {
        hold = false;
        reached();
        await held;
      }
      return real(input, init);
    });
    const older = post("connect", "twitch");
    await waiting;
    // Let the newer request finish its connection and token reads before checking provider calls.
    const db = env.DB;
    const load = vi.fn((sql: string): D1PreparedStatement => db.prepare(sql));
    env.DB = { prepare: load, batch: (statements: D1PreparedStatement[]) => db.batch(statements) } as unknown as D1Database;
    const newer = post("connect", "twitch");
    await vi.waitFor((): void => {
      expect(load.mock.calls.some(([sql]) => sql.includes("FROM channel_tokens"))).toBe(true);
    });
    release();
    await older;
    expect(await (await newer).json()).toEqual({ status: "active", code: null });
    const ids = fake.subscriptions.map((item) => item.id);
    expect(ids).toHaveLength(5);
    expect(fake.calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/eventsub/subscriptions"))).toHaveLength(5);
    expect(state().storage.values.get("subs:twitch")).toEqual(ids);
    expect(await connectionRow("twitch")).toMatchObject({ status: "active", status_code: null });
  });

  it("runs a queued reconnect after an older subscription request fails", async (): Promise<void> => {
    await addConnection("twitch");
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const real = globalThis.fetch;
    let hold = true;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      if (!hold || init?.method !== "POST" || !url.pathname.endsWith("/eventsub/subscriptions")) return real(input, init);
      hold = false;
      reached();
      await held;
      return new Response("unavailable", { status: 500 });
    });
    const older = post("connect", "twitch");
    await waiting;
    const newer = post("connect", "twitch");
    release();
    await older;
    expect(await (await newer).json()).toEqual({ status: "active", code: null });
    expect(await connectionRow("twitch")).toMatchObject({ status: "active", status_code: null });
  });

  it("polls only while a consumer listens and marks history on the first page as not live", async (): Promise<void> => {
    await addConnection("youtube");
    await poll();
    expect(fake.calls).toHaveLength(0);
    const socket = await listen();
    expect(state().storage.alarm).toBe(clock);
    const iso = (time: number): string => new Date(time).toISOString();
    fake.chatPages = [
      {
        items: [youtubeText("old", "UCa", "!old command", {}, iso(clock - 120_000)), youtubeText("recent", "UCa", "yo", {}, iso(clock))],
        nextPageToken: "p1",
        pollingIntervalMillis: 100,
      },
      {
        items: [youtubeText("new", "UCb", "hi", { isChatModerator: true }, iso(clock + YOUTUBE_MIN_POLL_MS))],
        nextPageToken: "p2",
        pollingIntervalMillis: 15_000,
      },
    ];
    const start = clock;
    await poll();
    expect(state().storage.alarm).toBe(start);
    await poll();
    expect(state().storage.alarm).toBe(start + YOUTUBE_MIN_POLL_MS);
    await poll();
    expect(state().storage.alarm).toBe(start + YOUTUBE_MIN_POLL_MS + 15_000);
    const events = socket.ofType<{ event: ActivityChat }>("event").map((message) => message.event);
    // The first page is shown, but its old message is not live, so its command never runs.
    expect(events.map((event) => [event.id, event.live, event.badges])).toEqual([
      ["youtube:old", false, []],
      ["youtube:recent", true, []],
      ["youtube:new", true, [{ id: "moderator", label: "Moderator" }]],
    ]);
    const pages = fake.calls.filter((item) => item.url.pathname.endsWith("/liveChat/messages"));
    expect(pages.map((item) => item.url.searchParams.get("pageToken"))).toEqual([null, "p1"]);
    const { day } = quotaDay(clock);
    // 1 for the broadcast check, 5 for each chat page, and 1 for the daily title refresh.
    expect(await quota(`youtube-quota:${day}`)).toBe(12);
    expect(await quota(`youtube-quota:${day}:${page}`)).toBe(12);
    expect(await env.DB.prepare("SELECT display_name FROM channel_connections WHERE platform='youtube'").first("display_name")).toBe(
      "Tube Host",
    );
  });

  it("never polls early for a new consumer or a cleanup alarm", async (): Promise<void> => {
    await addConnection("youtube");
    await addConnection("twitch");
    await listen();
    await poll();
    await poll();
    const calls = pollCalls();
    const due = state().storage.alarm ?? 0;
    expect(due).toBe(clock + YOUTUBE_MIN_POLL_MS);
    // A delivery schedules a cleanup alarm; it runs before the poll is due and spends nothing.
    await deliver("d1", [chat("m1")]);
    await room().alarm();
    expect(pollCalls()).toBe(calls);
    expect(state().storage.alarm).toBe(due);
    // A new consumer during the wait keeps the wait.
    await listen();
    expect(state().storage.alarm).toBe(due);
    await room().alarm();
    expect(pollCalls()).toBe(calls);
  });

  it("keeps the backoff when a consumer connects during it", async (): Promise<void> => {
    await addConnection("youtube");
    await listen();
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    vi.spyOn(nodeCrypto, "randomInt").mockImplementation((_min, max): number => Number(max) - 1);
    fake.chatError = "backendError";
    await poll();
    await poll();
    await poll();
    const calls = pollCalls();
    const due = state().storage.alarm ?? 0;
    expect(due - clock).toBe(2000);
    await listen();
    await room().alarm();
    expect(pollCalls()).toBe(calls);
    expect(state().storage.alarm).toBe(due);
  });

  it("waits while the channel is not live and after the chat ends", async (): Promise<void> => {
    await addConnection("youtube");
    await listen();
    fake.liveChatId = null;
    await poll();
    expect(state().storage.alarm).toBe(clock + YOUTUBE_IDLE_POLL_MS);
    fake.liveChatId = "chat-1";
    await poll();
    await poll();
    fake.chatPages = [{ items: [], offlineAt: "2026-11-12T10:00:00Z" }];
    await poll();
    expect(state().storage.alarm).toBe(clock + YOUTUBE_IDLE_POLL_MS);
    expect(await state().storage.get("youtube")).toMatchObject({ liveChatId: null });
    await poll();
    fake.chatError = "liveChatEnded";
    await poll();
    expect(await state().storage.get("youtube")).toMatchObject({ liveChatId: null, pageToken: null });
  });

  it("follows Google's quota day: midnight Pacific Time, also across summer time", (): void => {
    expect(quotaDay(Date.parse("2026-07-01T06:59:59Z"))).toEqual({ day: "2026-06-30", resetAt: Date.parse("2026-07-01T07:00:00Z") });
    expect(quotaDay(Date.parse("2026-07-01T07:00:00Z")).day).toBe("2026-07-01");
    // Summer time ends on 1 November 2026: that day has 25 hours.
    expect(quotaDay(Date.parse("2026-11-01T08:00:00Z")).resetAt).toBe(Date.parse("2026-11-02T08:00:00Z"));
    // It starts on 8 March 2026: that day has 23 hours.
    expect(quotaDay(Date.parse("2026-03-08T09:00:00Z")).resetAt).toBe(Date.parse("2026-03-09T07:00:00Z"));
  });

  it("stops at the shared daily budget, the page's own budget, and recovers after the reset", async (): Promise<void> => {
    await addConnection("youtube");
    await listen();
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const { day, resetAt } = quotaDay(clock);
    await env.DB.prepare("INSERT INTO app_rate_limits (key,count,window_start) VALUES (?,?,?)")
      .bind(`youtube-quota:${day}`, YOUTUBE_DAILY_BUDGET, clock)
      .run();
    await poll();
    expect(fake.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("channel_quota_exhausted", { platform: "youtube" });
    expect(await connectionRow("youtube")).toMatchObject({ status: "error", status_code: "quota_exhausted" });
    // The refused shared spend gave the page's units back.
    expect(await quota(`youtube-quota:${day}:${page}`)).toBe(0);
    expect(state().storage.alarm).toBe(resetAt + 60_000);
    await poll();
    expect(await connectionRow("youtube")).toMatchObject({ status: "active", status_code: null });
    const next = quotaDay(clock).day;
    await env.DB.prepare("INSERT OR REPLACE INTO app_rate_limits (key,count,window_start) VALUES (?,?,?)")
      .bind(`youtube-quota:${next}:${page}`, YOUTUBE_PAGE_DAILY_BUDGET, clock)
      .run();
    await poll();
    expect(await connectionRow("youtube")).toMatchObject({ status: "error", status_code: "quota_exhausted" });
    // The shared counter holds only the poll that succeeded after the reset, and its title refresh.
    expect(await quota(`youtube-quota:${next}`)).toBe(2);
  });

  it("does not poll while channels are off", async (): Promise<void> => {
    await addConnection("youtube");
    await listen();
    env.CHANNELS_OFF = "1";
    await poll();
    expect(pollCalls()).toBe(0);
  });

  it("keeps the newest chat and every moderation event of a page larger than the bucket", async (): Promise<void> => {
    await addConnection("youtube");
    const socket = await listen();
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const iso = new Date(clock).toISOString();
    const items: unknown[] = [];
    for (let index = 0; index < ADMISSION_BURST + 50; index++) items.push(youtubeText(`c${index}`, "UCa", "hi", {}, iso));
    items.push({ id: "gone", snippet: { type: "tombstone" } });
    items.push({ id: "b", snippet: { type: "userBannedEvent", userBannedDetails: { bannedUserDetails: { channelId: "UCx" }, banType: "permanent" } } });
    fake.chatPages = [{ items, nextPageToken: "p1", pollingIntervalMillis: 100 }];
    await poll();
    await poll();
    const events = socket.ofType<{ event: { kind: string; id?: string } }>("event").map((message) => message.event);
    const chats = events.filter((event) => event.kind === "chat");
    expect(chats).toHaveLength(ADMISSION_BURST);
    expect(chats[0].id).toBe("youtube:c50");
    expect(chats.at(-1)?.id).toBe(`youtube:c${ADMISSION_BURST + 49}`);
    expect(events.filter((event) => event.kind !== "chat").map((event) => event.kind)).toEqual(["delete", "ban"]);
  });

  it("writes nothing when a disconnect runs during the health write or during a failing poll", async (): Promise<void> => {
    await addConnection("youtube");
    await listen();
    await poll();
    const real = env.DB;
    let during: (() => Promise<unknown>) | null = (): Promise<unknown> => post("disconnect", "youtube");
    env.DB = {
      prepare: (sql: string): D1PreparedStatement => {
        if (sql.startsWith("UPDATE channel_connections SET last_event_at") && during) {
          const run = during;
          during = null;
          return { bind: () => ({ run: async () => run() }) } as unknown as D1PreparedStatement;
        }
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    fake.chatPages = [{ items: [youtubeText("x", "UCa", "hi", {}, new Date(clock).toISOString())], nextPageToken: "p" }];
    await poll();
    expect(await state().storage.get("youtube")).toBeUndefined();
    env.DB = real;
    // A failing poll overtaken by a disconnect logs nothing and writes nothing.
    await post("connect", "youtube");
    await poll();
    const errors = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const fetchReal = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      if (new URL(input).pathname.endsWith("/liveChat/messages")) {
        await post("disconnect", "youtube");
        return Response.json({ error: { errors: [{ reason: "backendError" }] } }, { status: 500 });
      }
      return fetchReal(input, init);
    });
    await poll();
    expect(errors).not.toHaveBeenCalledWith("channel_poll_failed", expect.anything());
    expect(await state().storage.get("youtube")).toBeUndefined();
  });

  it("does not poll again within the cache time after a refused refresh", async (): Promise<void> => {
    await addConnection("youtube", { expiresAt: Date.now() - 1 });
    await listen();
    fake.refreshStatus = 400;
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    await poll();
    expect(await connectionRow("youtube")).toMatchObject({ status: "needs_reauth" });
    const calls = fake.calls.length;
    await state().storage.setAlarm(clock);
    await poll();
    expect(fake.calls.length).toBe(calls);
  });

  it("reads the channel title again once a day while an overlay is open", async (): Promise<void> => {
    await addConnection("youtube");
    await listen();
    fake.identity.youtube = { id: "UCchannel1", name: "Renamed Tube" };
    await poll();
    const titles = (): Promise<unknown> =>
      env.DB.prepare("SELECT display_name, data_read_at, updated_at FROM channel_connections WHERE platform='youtube'").first();
    // The status time stays: only the data time moves.
    expect(await titles()).toEqual({ display_name: "Renamed Tube", data_read_at: clock, updated_at: 1 });
    const first = clock;
    fake.identity.youtube = { id: "UCchannel1", name: "Later" };
    await poll();
    expect(await titles()).toMatchObject({ display_name: "Renamed Tube", data_read_at: first });
    clock += YOUTUBE_NAME_REFRESH_MS;
    await state().storage.setAlarm(clock);
    await poll();
    expect(await titles()).toMatchObject({ display_name: "Later", data_read_at: clock });
    // A token for another channel never renames this one, spends no quota for the read, and waits a day.
    fake.identity.youtube = { id: "UCother", name: "Other" };
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const used = (): Promise<unknown> =>
      env.DB.prepare("SELECT count FROM app_rate_limits WHERE key=?").bind(`youtube-quota:${quotaDay(clock).day}:${page}`).first("count");
    const reads = (): number => fake.calls.filter((item) => item.url.pathname.endsWith("/youtube/v3/channels")).length;
    clock += YOUTUBE_NAME_REFRESH_MS;
    await state().storage.setAlarm(clock);
    const before = { quota: Number(await used()), reads: reads() };
    await poll();
    expect(await titles()).toMatchObject({ display_name: "Later" });
    expect(reads()).toBe(before.reads + 1);
    const mismatchUnits = Number(await used()) - before.quota;
    clock += YOUTUBE_NAME_RETRY_MS;
    await state().storage.setAlarm(clock);
    const quotaBefore = Number(await used());
    await poll();
    expect(reads()).toBe(before.reads + 1);
    expect(Number(await used()) - quotaBefore).toBe(mismatchUnits);
  });

  it("still ingests chat when the title read fails, and tries the title again after an hour", async (): Promise<void> => {
    await addConnection("youtube");
    const socket = await listen();
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const real = globalThis.fetch;
    let channelsDown = true;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      if (channelsDown && new URL(input).pathname.endsWith("/youtube/v3/channels")) return new Response("down", { status: 500 });
      return real(input, init);
    });
    const iso = new Date(clock).toISOString();
    fake.chatPages = [{ items: [youtubeText("c1", "UCa", "hi", {}, iso)], nextPageToken: "p1", pollingIntervalMillis: 100 }];
    await poll();
    await poll();
    expect(socket.ofType("event")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("channel_name_refresh_failed", { platform: "youtube", cause: "Error" });
    // The failed read spent no quota: 1 for the broadcast check and 5 for the chat page.
    expect(await env.DB.prepare("SELECT count FROM app_rate_limits WHERE key=?").bind(`youtube-quota:${quotaDay(clock).day}`).first("count")).toBe(6);
    const reads = (): number => fake.calls.filter((item) => item.url.pathname.endsWith("/youtube/v3/channels")).length;
    const before = reads();
    await poll();
    expect(reads()).toBe(before);
    channelsDown = false;
    clock += YOUTUBE_NAME_RETRY_MS;
    await state().storage.setAlarm(clock);
    await poll();
    expect(reads()).toBe(before + 1);
  });

  it("treats a quota error from Google as an exhausted quota", async (): Promise<void> => {
    await addConnection("youtube");
    await listen();
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    await poll();
    fake.chatError = "quotaExceeded";
    await poll();
    expect(await connectionRow("youtube")).toMatchObject({ status: "error", status_code: "quota_exhausted" });
  });

  it.each(["minimum", "maximum"] as const)("backs off at the %s jitter bound and stops when access is revoked", async (bound): Promise<void> => {
    await addConnection("youtube");
    await listen();
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    vi.spyOn(nodeCrypto, "randomInt").mockImplementation((min, max): number => bound === "minimum" ? Number(min) : Number(max) - 1);
    await poll();
    fake.chatError = "backendError";
    const waits: number[] = [];
    for (let index = 0; index < 12; index++) {
      await poll();
      waits.push((state().storage.alarm ?? 0) - clock);
    }
    expect(waits.slice(0, 4)).toEqual(bound === "minimum" ? [500, 1000, 2000, 4000] : [1000, 2000, 4000, 8000]);
    expect(Math.max(...waits)).toBe(bound === "minimum" ? 150_000 : 300_000);
    fake.chatError = null;
    await poll();
    expect(await state().storage.get("youtube")).toMatchObject({ backoffMs: 0 });
    await env.DB.prepare("UPDATE channel_tokens SET expires_at=1").run();
    fake.refreshStatus = 400;
    await poll();
    expect(await connectionRow("youtube")).toMatchObject({ status: "needs_reauth", status_code: "authorization_revoked" });
    await state().storage.deleteAlarm();
    await poll();
    expect(state().storage.alarm).toBeNull();
  });

  it("starts polling on connect and keeps a pending wait across a reconnect", async (): Promise<void> => {
    await addConnection("youtube");
    expect(await (await post("connect", "youtube")).json()).toEqual({ status: "active", code: null });
    expect(state().storage.alarm).toBe(clock);
    expect(await state().storage.get("youtube")).toEqual({
      liveChatId: null,
      pageToken: null,
      backoffMs: 0,
      nextPollAt: 0,
      nameAt: clock,
    });
    await state().storage.put("youtube", { liveChatId: "c", pageToken: "p", backoffMs: 4000, nextPollAt: clock + 50_000 });
    await state().storage.deleteAlarm();
    await post("connect", "youtube");
    expect(await state().storage.get("youtube")).toEqual({
      liveChatId: null,
      pageToken: null,
      backoffMs: 0,
      nextPollAt: clock + 50_000,
      nameAt: clock,
    });
    expect(state().storage.alarm).toBe(clock + 50_000);
  });
});
