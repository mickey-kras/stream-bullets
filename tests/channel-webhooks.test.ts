import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import { ChannelIngest } from "../app/server/channel-ingest";
import {
  MAX_WEBHOOK_AGE_MS,
  kickWebhook,
  logRejectedWebhook,
  MAX_RECENT_KICK,
  rememberKickId,
  resetKickKey,
  WebhookRejected,
  resetRoutes,
  twitchWebhook,
} from "../app/server/channel-webhooks.server";
import { ROUTE_CACHE_MS, UNKNOWN_CACHE_MS } from "../app/server/channels.server";
import { HttpError } from "../app/server/http.server";
import { installFakeProviders, type FakeProviders } from "./helpers/channels";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import { installWorkersRuntime, RoomNamespace, serverSocketOf, type FakeSocket, type RoomState } from "./helpers/room";

vi.mock("cloudflare:workers", () => import("./helpers/room"));

/** Signed provider webhooks: forged, stale, replayed and oversized deliveries, challenges and revocations. */

const origin = "https://hooks.example.test";
const page = "60000000-0000-4000-8000-000000000001";
const eventSubSecret = "eventsub-secret-0123456789abcdef0123";

let database: TestDatabase;
let env: AppEnv;
let fake: FakeProviders;
let ingest: RoomNamespace<ChannelIngest>;
let kickKeys: CryptoKeyPair;

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte: number): string => byte.toString(16).padStart(2, "0")).join("");
}

async function twitchRequest(
  body: string,
  options: { id?: string; timestamp?: string; type?: string; secret?: string; signature?: string; method?: string; path?: string } = {},
): Promise<Request> {
  const id = options.id ?? crypto.randomUUID();
  const timestamp = options.timestamp ?? new Date().toISOString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret ?? eventSubSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = `sha256=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id + timestamp + body)))}`;
  return new Request(`${origin}${options.path ?? "/hooks/twitch"}`, {
    method: options.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      "Twitch-Eventsub-Message-Id": id,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Signature": options.signature ?? signature,
      "Twitch-Eventsub-Message-Type": options.type ?? "notification",
    },
    ...(options.method === "GET" ? {} : { body }),
  });
}

function twitchNotification(type: string, event: Record<string, unknown>, broadcaster = "111"): string {
  return JSON.stringify({
    subscription: { id: "s1", type, version: "1", status: "enabled", condition: { broadcaster_user_id: broadcaster, user_id: broadcaster } },
    event,
  });
}

const twitchChat = {
  broadcaster_user_id: "111",
  chatter_user_id: "222",
  chatter_user_login: "fan",
  chatter_user_name: "Fan",
  message_id: "m1",
  message: { text: "hi", fragments: [{ type: "text", text: "hi", emote: null }] },
  badges: [],
};

async function kickRequest(body: string, options: { id?: string; timestamp?: string; type?: string; signature?: string } = {}): Promise<Request> {
  const id = options.id ?? crypto.randomUUID();
  const timestamp = options.timestamp ?? new Date().toISOString();
  const signed = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    kickKeys.privateKey,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return new Request(`${origin}/hooks/kick`, {
    method: "POST",
    headers: {
      "Kick-Event-Message-Id": id,
      "Kick-Event-Message-Timestamp": timestamp,
      "Kick-Event-Signature": options.signature ?? btoa(String.fromCodePoint(...new Uint8Array(signed))),
      "Kick-Event-Type": options.type ?? "chat.message.sent",
      "Kick-Event-Version": "1",
    },
    body,
  });
}

const kickChat = JSON.stringify({
  message_id: "k1",
  broadcaster: { user_id: 333, username: "host" },
  sender: { user_id: 444, username: "fan", identity: null },
  content: "hello",
  emotes: [],
  created_at: "2025-01-14T16:08:06Z",
});

async function listen(): Promise<FakeSocket> {
  const response = await ingest
    .get(ingest.idFromName(page))
    .fetch(`https://channel-ingest.internal/subscribe?streamerId=${page}`, { headers: { Upgrade: "websocket", "X-SB-Owner": "1" } });
  return serverSocketOf(response.webSocket);
}

async function status(response: Promise<Response>): Promise<number> {
  try {
    return (await response).status;
  } catch (error: unknown) {
    return (error as { status: number }).status;
  }
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  kickKeys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  installWorkersRuntime();
  fake = installFakeProviders();
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kickKeys.publicKey));
  const base64 = btoa(String.fromCodePoint(...spki));
  fake.kickPublicKey = `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g)?.join("\n")}\n-----END PUBLIC KEY-----\n`;
  resetKickKey();
  resetRoutes();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    POLL_ROOMS: {} as DurableObjectNamespace,
    CHANNEL_INGEST: {} as DurableObjectNamespace,
    REQUEST_LIMITER: {} as RateLimit,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: "x".repeat(40),
    TWITCH_EVENTSUB_SECRET: eventSubSecret,
  };
  ingest = new RoomNamespace((roomState: RoomState) => new ChannelIngest(roomState as unknown as DurableObjectState, env));
  env.CHANNEL_INGEST = ingest as unknown as DurableObjectNamespace;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('owner','O','o@x.test',1,1,1)"),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','hook_page','Host')").bind(page),
    env.DB.prepare(
      `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,created_at,updated_at)
        VALUES ('c-twitch',?1,'twitch','111','Host','',1,1), ('c-kick',?1,'kick','333','Host','',1,1)`,
    ).bind(page),
  ]);
});

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Twitch EventSub webhook", (): void => {
  it("delivers a signed chat message once, even when Twitch retries the same message id", async (): Promise<void> => {
    const socket = await listen();
    const body = twitchNotification("channel.chat.message", twitchChat);
    const first = await twitchRequest(body, { id: "delivery-1" });
    expect((await twitchWebhook(first, env)).status).toBe(204);
    expect((await twitchWebhook(await twitchRequest(body, { id: "delivery-1" }), env)).status).toBe(204);
    expect(socket.ofType<{ event: { id: string } }>("event").map((message) => message.event.id)).toEqual(["twitch:m1"]);
  });

  it("answers 503 when the ingest object fails, so Twitch retries", async (): Promise<void> => {
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (): Promise<Response> => new Response(null, { status: 500 }) }),
    } as unknown as DurableObjectNamespace;
    const body = twitchNotification("channel.chat.message", twitchChat);
    expect(await status(twitchWebhook(await twitchRequest(body), env))).toBe(503);
    const revocation = JSON.stringify({
      subscription: { type: "channel.chat.message", status: "authorization_revoked", condition: { broadcaster_user_id: "111" } },
    });
    expect(await status(twitchWebhook(await twitchRequest(revocation, { type: "revocation" }), env))).toBe(503);
  });

  it("answers an unreachable ingest object with one sampled `ingest` rejection, not an error per request", async (): Promise<void> => {
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (): Promise<Response> => Promise.reject(new TypeError("down")) }),
    } as unknown as DurableObjectNamespace;
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    for (const id of ["a", "b"]) {
      const error: unknown = await twitchWebhook(await twitchRequest(twitchNotification("channel.chat.message", twitchChat), { id }), env).catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ status: 503, reason: "ingest", forged: false });
      logRejectedWebhook("twitch", error, now);
    }
    expect(warn.mock.calls).toEqual([["channel_webhook_rejected", { platform: "twitch", reason: "ingest" }]]);
  });

  it("refuses forged signatures, other secrets, stale or future timestamps and bad ids", async (): Promise<void> => {
    const body = twitchNotification("channel.chat.message", twitchChat);
    expect(await status(twitchWebhook(await twitchRequest(body, { signature: "sha256=00" }), env))).toBe(403);
    expect(await status(twitchWebhook(await twitchRequest(body, { secret: "another-secret-0123456789abcdef01" }), env))).toBe(403);
    const old = new Date(Date.now() - MAX_WEBHOOK_AGE_MS - 1000).toISOString();
    expect(await status(twitchWebhook(await twitchRequest(body, { timestamp: old }), env))).toBe(403);
    const future = new Date(Date.now() + MAX_WEBHOOK_AGE_MS + 1000).toISOString();
    expect(await status(twitchWebhook(await twitchRequest(body, { timestamp: future }), env))).toBe(403);
    expect(await status(twitchWebhook(await twitchRequest(body, { timestamp: "yesterday" }), env))).toBe(403);
    expect(await status(twitchWebhook(await twitchRequest(body, { id: "bad id!" }), env))).toBe(403);
    // A valid signature over a tampered body is still a forgery.
    const request = await twitchRequest(body);
    const tampered = new Request(request, { body: body.replace("hi", "ho") });
    expect(await status(twitchWebhook(tampered, env))).toBe(403);
  });

  it("refuses oversized bodies, other methods, query strings, bad JSON and a missing secret", async (): Promise<void> => {
    const big = JSON.stringify({ padding: "x".repeat(70_000) });
    expect(await status(twitchWebhook(await twitchRequest(big), env))).toBe(413);
    expect(await status(twitchWebhook(await twitchRequest("", { method: "GET" }), env))).toBe(405);
    expect(await status(twitchWebhook(await twitchRequest("{}", { path: "/hooks/twitch?x=1" }), env))).toBe(400);
    expect(await status(twitchWebhook(await twitchRequest("{not json"), env))).toBe(400);
    expect(await status(twitchWebhook(await twitchRequest("{}"), env))).toBe(400);
    env.TWITCH_EVENTSUB_SECRET = undefined;
    expect(await status(twitchWebhook(await twitchRequest("{}"), env))).toBe(503);
  });

  it("answers the subscription challenge with the raw text, only for a connected channel", async (): Promise<void> => {
    const challenge = JSON.stringify({
      challenge: "pogchamp-kappa-360noscope-vohiyo",
      subscription: { type: "channel.chat.message", condition: { broadcaster_user_id: "111" } },
    });
    const response = await twitchWebhook(await twitchRequest(challenge, { type: "webhook_callback_verification" }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(await response.text()).toBe("pogchamp-kappa-360noscope-vohiyo");
    const unknown = challenge.replace('"111"', '"999"');
    expect(await status(twitchWebhook(await twitchRequest(unknown, { type: "webhook_callback_verification" }), env))).toBe(404);
  });

  it("marks the connection on a revocation and drops events for unknown channels", async (): Promise<void> => {
    const revocation = JSON.stringify({
      subscription: { type: "channel.chat.message", status: "authorization_revoked", condition: { broadcaster_user_id: "111" } },
    });
    expect((await twitchWebhook(await twitchRequest(revocation, { type: "revocation" }), env)).status).toBe(204);
    expect(await env.DB.prepare("SELECT status, status_code FROM channel_connections WHERE id='c-twitch'").first()).toEqual({
      status: "needs_reauth",
      status_code: "authorization_revoked",
    });
    const odd = revocation.replace("authorization_revoked", "something_new");
    await twitchWebhook(await twitchRequest(odd, { type: "revocation" }), env);
    expect(await env.DB.prepare("SELECT status_code FROM channel_connections WHERE id='c-twitch'").first("status_code")).toBe(
      "subscription_removed",
    );
    const unknownRevocation = revocation.replace('"111"', '"999"');
    expect((await twitchWebhook(await twitchRequest(unknownRevocation, { type: "revocation" }), env)).status).toBe(204);
    // A signed notification for an unknown channel answers 410, so Twitch removes the orphaned subscription.
    const elsewhere = twitchNotification("channel.chat.message", twitchChat, "999");
    expect((await twitchWebhook(await twitchRequest(elsewhere), env)).status).toBe(410);
    const unparsed = twitchNotification("channel.unknown_type", {}, "999");
    expect((await twitchWebhook(await twitchRequest(unparsed), env)).status).toBe(410);
    // A known channel with no events to forward is still acknowledged.
    expect((await twitchWebhook(await twitchRequest(twitchNotification("channel.unknown_type", {})), env)).status).toBe(204);
    // The ingest object never saw the delivery for the unknown channel.
    expect(ingest.entry(page).state.storage.sql.exec("SELECT key FROM seen").toArray()).toEqual([]);
  });
});

describe("webhook routing and the off switch", (): void => {
  function countRoutes(): () => number {
    let reads = 0;
    const real = env.DB;
    env.DB = {
      prepare: (sql: string): D1PreparedStatement => {
        if (sql.startsWith("SELECT streamer_id FROM channel_connections")) reads += 1;
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    return (): number => reads;
  }

  it("looks a channel up in D1 once for a burst, again after the cache time", async (): Promise<void> => {
    const reads = countRoutes();
    const now = Date.now();
    for (let index = 0; index < 5; index++) {
      const body = twitchNotification("channel.chat.message", { ...twitchChat, message_id: `m${index}` });
      await twitchWebhook(await twitchRequest(body), env, now);
    }
    expect(reads()).toBe(1);
    const later = twitchNotification("channel.chat.message", { ...twitchChat, message_id: "later" });
    await twitchWebhook(await twitchRequest(later, { timestamp: new Date(now + ROUTE_CACHE_MS).toISOString() }), env, now + ROUTE_CACHE_MS);
    expect(reads()).toBe(2);
    // An unknown channel is remembered for a short time only.
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    for (let index = 0; index < 3; index++)
      await twitchWebhook(await twitchRequest(twitchNotification("channel.chat.message", twitchChat, "999")), env, now);
    expect(reads()).toBe(3);
    const after = new Date(now + UNKNOWN_CACHE_MS).toISOString();
    await twitchWebhook(
      await twitchRequest(twitchNotification("channel.chat.message", twitchChat, "999"), { timestamp: after }),
      env,
      now + UNKNOWN_CACHE_MS,
    );
    expect(reads()).toBe(4);
    // Sampled: one log for the burst, without the channel id.
    expect(warn.mock.calls).toEqual([["channel_webhook_unknown_channel", { platform: "twitch" }]]);
  });

  it("still records a revocation while channels are off, and drops everything else", async (): Promise<void> => {
    env.CHANNELS_OFF = "1";
    const socket = await listen().catch((): null => null);
    expect(socket).not.toBeNull();
    const notification = twitchNotification("channel.chat.message", twitchChat);
    expect((await twitchWebhook(await twitchRequest(notification), env)).status).toBe(204);
    const challenge = JSON.stringify({
      challenge: "c",
      subscription: { type: "channel.chat.message", condition: { broadcaster_user_id: "111" } },
    });
    expect(await status(twitchWebhook(await twitchRequest(challenge, { type: "webhook_callback_verification" }), env))).toBe(404);
    const revocation = JSON.stringify({
      subscription: { type: "channel.chat.message", status: "authorization_revoked", condition: { broadcaster_user_id: "111" } },
    });
    expect((await twitchWebhook(await twitchRequest(revocation, { type: "revocation" }), env)).status).toBe(204);
    expect(await env.DB.prepare("SELECT status FROM channel_connections WHERE id='c-twitch'").first("status")).toBe("needs_reauth");
    expect(ingest.entry(page).state.storage.sql.exec("SELECT seq FROM events").toArray()).toEqual([]);
  });

  it("logs a refused webhook or a server-side failure, at most once a minute for each platform", (): void => {
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now() + 10 * 60_000;
    logRejectedWebhook("kick", new WebhookRejected(403, "x", "stale", false), now);
    logRejectedWebhook("kick", new WebhookRejected(403, "x", "signature", true), now + 1000);
    logRejectedWebhook("twitch", new HttpError(503, "Twitch is not configured."), now + 1000);
    logRejectedWebhook("twitch", new WebhookRejected(413, "x", "size", true), now + 2000);
    logRejectedWebhook("twitch", new HttpError(404, "Unknown channel."), now + 122_000);
    logRejectedWebhook("kick", new WebhookRejected(400, "x", "payload", false), now + 61_000);
    // One log a minute for each platform and reason: a flood of one reason never hides another.
    expect(warn.mock.calls).toEqual([
      ["channel_webhook_rejected", { platform: "kick", reason: "stale" }],
      ["channel_webhook_rejected", { platform: "kick", reason: "signature" }],
      ["channel_webhook_rejected", { platform: "twitch", reason: "unavailable" }],
      ["channel_webhook_rejected", { platform: "twitch", reason: "size" }],
      ["channel_webhook_rejected", { platform: "kick", reason: "payload" }],
    ]);
    warn.mockClear();
    logRejectedWebhook("kick", new WebhookRejected(403, "x", "stale", false), now + 2000);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("Kick webhook", (): void => {
  it("delivers a signed message once and caches the public key", async (): Promise<void> => {
    const socket = await listen();
    expect((await kickWebhook(await kickRequest(kickChat, { id: "kick-1" }), env)).status).toBe(204);
    expect((await kickWebhook(await kickRequest(kickChat, { id: "kick-1" }), env)).status).toBe(204);
    expect(socket.ofType<{ event: { id: string } }>("event").map((message) => message.event.id)).toEqual(["kick:k1"]);
    expect(fake.calls.filter((item) => item.url.pathname === "/public/v1/public-key")).toHaveLength(1);
  });

  it("accepts Unix-second timestamps and refuses stale, forged and malformed deliveries", async (): Promise<void> => {
    const seconds = String(Math.floor(Date.now() / 1000));
    expect((await kickWebhook(await kickRequest(kickChat, { timestamp: seconds }), env)).status).toBe(204);
    const old = new Date(Date.now() - MAX_WEBHOOK_AGE_MS - 1000).toISOString();
    expect(await status(kickWebhook(await kickRequest(kickChat, { timestamp: old }), env))).toBe(403);
    expect(await status(kickWebhook(await kickRequest(kickChat, { signature: "AAAA" }), env))).toBe(403);
    expect(await status(kickWebhook(await kickRequest(kickChat, { signature: "%%%" }), env))).toBe(403);
    expect(await status(kickWebhook(await kickRequest(kickChat, { id: "x y" }), env))).toBe(403);
    expect(await status(kickWebhook(await kickRequest("{bad"), env))).toBe(400);
    expect(await status(kickWebhook(await kickRequest("{}"), env))).toBe(400);
    expect(await status(kickWebhook(new Request(`${origin}/hooks/kick`), env))).toBe(405);
  });

  it("fetches the key again after a rotation, at most once a minute", async (): Promise<void> => {
    const now = Date.now();
    await kickWebhook(await kickRequest(kickChat), env, now);
    kickKeys = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const spki = btoa(String.fromCodePoint(...new Uint8Array(await crypto.subtle.exportKey("spki", kickKeys.publicKey))));
    fake.kickPublicKey = `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----`;
    expect(await status(kickWebhook(await kickRequest(kickChat), env, now + 1000))).toBe(403);
    expect((await kickWebhook(await kickRequest(kickChat), env, now + 61_000)).status).toBe(204);
    expect(fake.calls.filter((item) => item.url.pathname === "/public/v1/public-key")).toHaveLength(2);
  });

  it("answers a repeated Kick message id without the ingest object and counts the repeat", async (): Promise<void> => {
    const socket = await listen();
    const request = (): Promise<Request> => kickRequest(kickChat, { id: "same-id" });
    let repeats = 0;
    const count = async (): Promise<void> => {
      repeats += 1;
    };
    expect((await kickWebhook(await request(), env, Date.now(), count)).status).toBe(204);
    const calls = ingest.entry(page).state.storage.sql.exec("SELECT key FROM seen").toArray().length;
    for (let index = 0; index < 3; index++) expect((await kickWebhook(await request(), env, Date.now(), count)).status).toBe(204);
    expect(repeats).toBe(3);
    expect(ingest.entry(page).state.storage.sql.exec("SELECT key FROM seen").toArray().length).toBe(calls);
    expect(socket.ofType("event")).toHaveLength(1);
  });

  it("lets Kick's retry through when the first forward failed, without counting it", async (): Promise<void> => {
    const real = env.CHANNEL_INGEST;
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (): Promise<Response> => new Response(null, { status: 500 }) }),
    } as unknown as DurableObjectNamespace;
    let repeats = 0;
    const count = async (): Promise<void> => {
      repeats += 1;
    };
    await expect(kickWebhook(await kickRequest(kickChat, { id: "retry-id" }), env, Date.now(), count)).rejects.toMatchObject({ status: 503 });
    env.CHANNEL_INGEST = real;
    const socket = await listen();
    expect((await kickWebhook(await kickRequest(kickChat, { id: "retry-id" }), env, Date.now(), count)).status).toBe(204);
    expect(repeats).toBe(0);
    expect(socket.ofType("event")).toHaveLength(1);
  });

  it("counts a parallel copy as a repeat while the first is forwarded", async (): Promise<void> => {
    const socket = await listen();
    let repeats = 0;
    const count = async (): Promise<void> => {
      repeats += 1;
    };
    const copies = await Promise.all([kickRequest(kickChat, { id: "parallel" }), kickRequest(kickChat, { id: "parallel" })]);
    const answers = await Promise.all(copies.map((request) => kickWebhook(request, env, Date.now(), count)));
    expect(answers.map((response) => response.status)).toEqual([204, 204]);
    expect(repeats).toBe(1);
    expect(socket.ofType("event")).toHaveLength(1);
  });

  it("forgets the oldest Kick id past the cap", async (): Promise<void> => {
    expect((await kickWebhook(await kickRequest(kickChat, { id: "oldest" }), env)).status).toBe(204);
    for (let index = 0; index < MAX_RECENT_KICK; index++) rememberKickId(`filler-${index}`);
    let repeats = 0;
    const count = async (): Promise<void> => {
      repeats += 1;
    };
    // "oldest" left the map: it is forwarded again (the ingest object then drops it as a known delivery).
    await kickWebhook(await kickRequest(kickChat, { id: "oldest" }), env, Date.now(), count);
    expect(repeats).toBe(0);
    await kickWebhook(await kickRequest(kickChat, { id: `filler-${MAX_RECENT_KICK - 1}` }), env, Date.now(), count);
    expect(repeats).toBe(1);
  });

  it("counts a stale or unparsable signed Kick copy as forged", async (): Promise<void> => {
    const old = new Date(Date.now() - MAX_WEBHOOK_AGE_MS - 1000).toISOString();
    await expect(kickWebhook(await kickRequest(kickChat, { timestamp: old }), env)).rejects.toMatchObject({ reason: "stale", forged: true });
    await expect(kickWebhook(await kickRequest("{bad"), env)).rejects.toMatchObject({ reason: "payload", forged: true });
    await expect(kickWebhook(await kickRequest("{}"), env)).rejects.toMatchObject({ reason: "payload", forged: true });
  });

  it("answers 503 while the key cannot be fetched, and tries again at most once a minute", async (): Promise<void> => {
    fake.kickPublicKey = null;
    const now = Date.now();
    expect(await status(kickWebhook(await kickRequest(kickChat), env, now))).toBe(503);
    const keyCalls = (): number => fake.calls.filter((item) => item.url.pathname === "/public/v1/public-key").length;
    expect(await status(kickWebhook(await kickRequest(kickChat), env, now + 1000))).toBe(503);
    expect(keyCalls()).toBe(1);
    expect(await status(kickWebhook(await kickRequest(kickChat), env, now + 61_000))).toBe(503);
    expect(keyCalls()).toBe(2);
  });

  it("shares one key fetch between parallel deliveries and refuses a malformed key with 503", async (): Promise<void> => {
    const requests = await Promise.all([kickRequest(kickChat), kickRequest(kickChat), kickRequest(kickChat)]);
    const results = await Promise.all(requests.map((request) => kickWebhook(request, env)));
    expect(results.map((response) => response.status)).toEqual([204, 204, 204]);
    expect(fake.calls.filter((item) => item.url.pathname === "/public/v1/public-key")).toHaveLength(1);
    resetKickKey();
    fake.kickPublicKey = "-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----";
    expect(await status(kickWebhook(await kickRequest(kickChat), env))).toBe(503);
  });
});
