import type { LoaderFunctionArgs } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import {
  channelCardState,
  channelHealth,
  channelsResponseSchema,
  deliversChat,
  healthChanges,
  type ChannelView,
} from "../app/lib/channel-health";
import { ChannelIngest } from "../app/server/channel-ingest";
import { loadTokens, tokenStatement } from "../app/server/channel-tokens.server";
import { deleteAccount } from "../app/server/account.server";
import {
  REPAIR_BATCH,
  STATE_TTL_MS,
  disconnectAllChannels,
  expireYoutubeConnections,
  repairChannelSubscriptions,
  routeFor,
} from "../app/server/channels.server";
import { RECONCILE_INTERVAL_MS } from "../app/server/channel-ingest-limits";
import { loader as callbackLoader } from "../app/routes/channels-callback";
import { apiCaller } from "./helpers/api";
import { installFakeProviders, TWITCH_SCOPES, TWITCH_SUPPORT_SCOPES, type FakeProviders } from "./helpers/channels";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import { startOfQuotaWindow } from "./helpers/quota";
import { installWorkersRuntime, RoomNamespace, serverSocketOf, type RoomState } from "./helpers/room";

vi.mock("cloudflare:workers", () => import("./helpers/room"));

/** Connecting, reconnecting and disconnecting channels: ownership, recent sign-in, state and PKCE, revocation. */

const origin = "https://channels.example.test";
const secret = "test-only-secret-7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d";
const day = 86_400_000;
const page = "40000000-0000-4000-8000-000000000001";
const rivalPage = "40000000-0000-4000-8000-000000000002";
const frozenPage = "40000000-0000-4000-8000-000000000003";
const tokenKeys = `k1:${btoa(String.fromCodePoint(...new Uint8Array(32).fill(7)))}`;
const eventSubSecret = "eventsub-secret-0123456789abcdef0123";

let database: TestDatabase;
let env: AppEnv;
let fake: FakeProviders;
let ingest: RoomNamespace<ChannelIngest>;

const { call, cookie, context } = apiCaller(() => env, origin, secret);

async function seed(): Promise<void> {
  const now = Date.now();
  const users = JSON.stringify(["owner", "rival", "frozen", "viewer"]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id,name,email,email_verified,created_at,updated_at)
        SELECT value, 'Name '||value, value||'@example.test', 1, ?1, ?1 FROM json_each(?2)`,
    ).bind(now, users),
    env.DB.prepare(
      `INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at)
        SELECT 's-'||value, value||'-session-token', value, ?1, ?2, ?2 FROM json_each(?3)`,
    ).bind(now + day, now, users),
    env.DB.prepare(
      `INSERT INTO streamers (id,owner_id,handle,name,about,is_official,status) VALUES
        (?1,'owner','host_page','Host','',0,'active'),
        (?2,'rival','rival_page','Rival','',0,'active'),
        (?3,'frozen','frozen_page','Frozen','',0,'frozen')`,
    ).bind(page, rivalPage, frozenPage),
  ]);
}

/** Makes a session older than the recent sign-in window. */
async function staleSession(user: string): Promise<void> {
  await env.DB.prepare("UPDATE session SET created_at=? WHERE user_id=?")
    .bind(Date.now() - 11 * 60_000, user)
    .run();
}

async function startConnect(platform: string, user = "owner"): Promise<URL> {
  const response = await call("POST", `channels/${platform}/connect`, { user, body: {} });
  expect(response.status).toBe(200);
  return new URL((await response.json<{ authorizeUrl: string }>()).authorizeUrl);
}

/** The provider redirects the browser back to the callback. Returns the result code of the redirect. */
async function callback(platform: string, query: Record<string, string>, user: string | null = "owner"): Promise<string | null> {
  const url = `${origin}/channels/callback/${platform}?${new URLSearchParams(query)}`;
  const request = new Request(url, { headers: user ? { cookie: await cookie(user) } : {} });
  const response = await callbackLoader({
    request,
    params: { platform },
    context: context(),
    url: new URL(url),
    pattern: "/channels/callback/:platform",
  });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location") ?? "", origin);
  expect(location.pathname).toBe("/tools");
  expect(location.searchParams.get("view")).toBe("channels");
  expect(location.searchParams.get("channel")).toBe(platform);
  expect([...location.searchParams.keys()].sort()).toEqual(["channel", "result", "view"]);
  return location.searchParams.get("result");
}

async function connectChannel(platform: string, user = "owner"): Promise<string | null> {
  const authorize = await startConnect(platform, user);
  return callback(platform, { state: authorize.searchParams.get("state") ?? "", code: `${platform}-code` }, user);
}

async function channels(user = "owner"): Promise<Record<string, unknown>[]> {
  const response = await call("GET", "channels", { user });
  expect(response.status).toBe(200);
  return (await response.json<{ channels: Record<string, unknown>[] }>()).channels;
}

function ingestState(streamerId: string = page): RoomState {
  return ingest.entry(streamerId).state;
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
    BETTER_AUTH_SECRET: secret,
    TWITCH_CLIENT_ID: "twitch-client",
    TWITCH_CLIENT_SECRET: "twitch-secret",
    TWITCH_EVENTSUB_SECRET: eventSubSecret,
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    KICK_CLIENT_ID: "kick-client",
    KICK_CLIENT_SECRET: "kick-secret",
    CHANNEL_TOKEN_KEYS: tokenKeys,
  };
  ingest = new RoomNamespace((state: RoomState) => new ChannelIngest(state as unknown as DurableObjectState, env));
  env.CHANNEL_INGEST = ingest as unknown as DurableObjectNamespace;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM verification"),
    env.DB.prepare("DELETE FROM moderation_actions"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
  ]);
  await seed();
});

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/channels", (): void => {
  it("lists the three platforms for the owner's page only", async (): Promise<void> => {
    expect((await call("GET", "channels")).status).toBe(401);
    expect((await call("GET", "channels", { user: "viewer" })).status).toBe(404);
    const list = await channels();
    expect(list.map((item) => item.platform)).toEqual(["twitch", "youtube", "kick"]);
    expect(list.every((item) => item.available === true && item.connection === null)).toBe(true);
    expect(list[2].capabilities).toMatchObject({ delete: false, ban: true });
  });

  it("shows platforms without credentials, and every platform without token keys, as unavailable", async (): Promise<void> => {
    env.KICK_CLIENT_ID = undefined;
    env.TWITCH_EVENTSUB_SECRET = "short";
    expect((await channels()).map((item) => item.available)).toEqual([false, true, false]);
    env.CHANNELS_OFF = "1";
    expect((await channels()).map((item) => item.available)).toEqual([false, false, false]);
    env.CHANNELS_OFF = undefined;
    env.CHANNEL_TOKEN_KEYS = undefined;
    expect((await channels()).map((item) => item.available)).toEqual([false, false, false]);
    const response = await call("POST", "channels/youtube/connect", { user: "owner", body: {} });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "platform_unavailable" });
  });
});

describe("POST /api/channels/:platform/connect", (): void => {
  it("builds each provider's authorization URL with its own redirect and a single-use hashed state", async (): Promise<void> => {
    const twitch = await startConnect("twitch");
    expect(twitch.origin + twitch.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
    expect(twitch.searchParams.get("redirect_uri")).toBe(`${origin}/channels/callback/twitch`);
    // Each connect asks Twitch for the scopes of chat and for the three scopes of support events.
    expect(twitch.searchParams.get("scope")?.split(" ")).toEqual([...TWITCH_SCOPES, ...TWITCH_SUPPORT_SCOPES]);
    expect(TWITCH_SUPPORT_SCOPES).toEqual(["moderator:read:followers", "channel:read:subscriptions", "bits:read"]);
    expect(twitch.searchParams.get("scope")).not.toMatch(/manage|chat:edit|user:write|channel:moderate/);
    expect(twitch.searchParams.has("code_challenge")).toBe(false);
    for (const platform of ["youtube", "kick"]) {
      const url = await startConnect(platform);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    }
    const youtube = await startConnect("youtube");
    expect(youtube.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.readonly");
    expect(youtube.searchParams.get("access_type")).toBe("offline");
    expect(youtube.searchParams.has("include_granted_scopes")).toBe(false);
    const { results } = await env.DB.prepare("SELECT identifier, value FROM verification").all<{ identifier: string; value: string }>();
    expect(results).toHaveLength(4);
    const state = youtube.searchParams.get("state") ?? "";
    for (const row of results) {
      expect(row.identifier).toMatch(/^channel-connect:[0-9a-f]{64}$/);
      expect(row.identifier).not.toContain(state);
      expect(row.value).not.toContain(state);
    }
  });

  it("needs a recent sign-in, an own writable page and a same-origin request", async (): Promise<void> => {
    await staleSession("owner");
    const stale = await call("POST", "channels/twitch/connect", { user: "owner", body: {} });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "Sign in again to change channel connections.", code: "reauth_required" });
    expect((await call("POST", "channels/twitch/connect", { user: "viewer", body: {} })).status).toBe(404);
    expect((await call("POST", "channels/twitch/connect", { user: "frozen", body: {} })).status).toBe(423);
    expect((await call("POST", "channels/twitch/connect", { body: {} })).status).toBe(401);
    expect((await call("POST", "channels/twitch/connect", { user: "rival", body: { url: "x" } })).status).toBe(400);
    expect((await call("POST", "channels/other/connect", { user: "rival", body: {} })).status).toBe(404);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM verification").first("n")).toBe(0);
  });

  it("counts against the content quota", async (): Promise<void> => {
    await startOfQuotaWindow(env.DB);
    for (let index = 0; index < 6; index++) await startConnect("kick");
    expect((await call("POST", "channels/kick/reconnect", { user: "owner", body: {} })).status).toBe(429);
  });
});

describe("the channel callback", (): void => {
  it("connects all three platforms to one page and stores only encrypted tokens", async (): Promise<void> => {
    expect(await connectChannel("twitch")).toBe("connected");
    expect(await connectChannel("youtube")).toBe("connected");
    expect(await connectChannel("kick")).toBe("connected");
    const list = await channels();
    expect(list.map((item) => item.connection)).toMatchObject([
      { displayName: "TwitchHost", status: "active", code: null },
      { displayName: "Tube Host", status: "active", code: null },
      { displayName: "KickHost", status: "active", code: null },
    ]);
    const listing = JSON.stringify(list);
    const stored = JSON.stringify((await env.DB.prepare("SELECT * FROM channel_tokens").all()).results);
    for (const secretValue of ["-access", "-refresh", "-code", eventSubSecret]) {
      expect(listing).not.toContain(secretValue);
      expect(stored).not.toContain(secretValue);
    }
    // PKCE: the verifier goes to Google and Kick, never to Twitch, which does not document it.
    const exchanges = fake.calls.filter((item) => item.url.pathname.endsWith("/token") && item.body.includes("authorization_code"));
    expect(exchanges.map((item) => new URLSearchParams(item.body).has("code_verifier"))).toEqual([false, true, true]);
    // Twitch EventSub webhooks with an app token; Kick with the broadcaster's token.
    const twitchSubs = fake.calls.filter((item) => item.url.hostname === "api.twitch.tv" && item.method === "POST");
    // The types of chat come first, then the types of support events: each new connection reads them. The optional
    // live types come last.
    expect(twitchSubs.map((item) => (JSON.parse(item.body) as { type: string }).type)).toEqual([
      "channel.chat.message",
      "channel.chat.message_delete",
      "channel.chat.clear",
      "channel.chat.clear_user_messages",
      "channel.moderate",
      "channel.follow",
      "channel.subscribe",
      "channel.subscription.gift",
      "channel.subscription.message",
      "channel.cheer",
      "channel.raid",
      "stream.online",
      "stream.offline",
    ]);
    expect(list.map((item) => item.support)).toEqual([true, true, true]);
    expect(JSON.parse(twitchSubs[0].body)).toMatchObject({
      condition: { broadcaster_user_id: "111", user_id: "111" },
      transport: { method: "webhook", callback: `${origin}/hooks/twitch`, secret: eventSubSecret },
    });
    expect(twitchSubs[0].headers.get("Authorization")).toBe("Bearer twitch-app-token");
    // Kick: one call for the events of chat, one call for the support events, then one call for the live event.
    const kickSubs = fake.calls.filter((item) => item.url.hostname === "api.kick.com" && item.method === "POST");
    expect(kickSubs.map((item) => JSON.parse(item.body) as unknown)).toEqual([
      {
        broadcaster_user_id: 333,
        events: [
          { name: "chat.message.sent", version: 1 },
          { name: "moderation.banned", version: 1 },
        ],
        method: "webhook",
      },
      {
        broadcaster_user_id: 333,
        events: [
          { name: "channel.followed", version: 1 },
          { name: "channel.subscription.new", version: 1 },
          { name: "channel.subscription.renewal", version: 1 },
          { name: "channel.subscription.gifts", version: 1 },
          { name: "kicks.gifted", version: 1 },
        ],
        method: "webhook",
      },
      { broadcaster_user_id: 333, events: [{ name: "livestream.status.updated", version: 1 }], method: "webhook" },
    ]);
    expect(await ingestState().storage.get("subs:kick")).toEqual(
      fake.subscriptions.filter((item) => item.platform === "kick").map((item) => item.id),
    );
    expect(fake.subscriptions.filter((item) => item.platform === "kick")).toHaveLength(8);
    const audit = await env.DB.prepare("SELECT action, metadata FROM moderation_actions ORDER BY created_at").all();
    expect(audit.results).toEqual([
      { action: "channel_connected", metadata: '{"platform":"twitch"}' },
      { action: "channel_connected", metadata: '{"platform":"youtube"}' },
      { action: "channel_connected", metadata: '{"platform":"kick"}' },
    ]);
  });

  it("works once: a replayed, missing, malformed or expired state connects nothing", async (): Promise<void> => {
    const authorize = await startConnect("kick");
    const state = authorize.searchParams.get("state") ?? "";
    expect(await callback("kick", { code: "c" })).toBe("state_invalid");
    expect(await callback("kick", { state: "x".repeat(10), code: "c" })).toBe("state_invalid");
    expect(await callback("kick", { state, code: "c" })).toBe("connected");
    expect(await callback("kick", { state, code: "c" })).toBe("state_invalid");
    const late = (await startConnect("youtube")).searchParams.get("state") ?? "";
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + STATE_TTL_MS + 1);
    expect(await callback("youtube", { state: late, code: "c" })).toBe("state_invalid");
  });

  it("refuses a state from another platform, another account or no session (CSRF, swapped links)", async (): Promise<void> => {
    const youtube = (await startConnect("youtube")).searchParams.get("state") ?? "";
    expect(await callback("kick", { state: youtube, code: "c" })).toBe("state_invalid");
    const owner = (await startConnect("kick")).searchParams.get("state") ?? "";
    // The rival tricks the owner into finishing the rival's authorization, or the other way round.
    expect(await callback("kick", { state: owner, code: "c" }, "rival")).toBe("session_mismatch");
    const again = (await startConnect("kick")).searchParams.get("state") ?? "";
    expect(await callback("kick", { state: again, code: "c" }, null)).toBe("session_mismatch");
    // The state is consumed either way.
    expect(await callback("kick", { state: again, code: "c" })).toBe("state_invalid");
    expect((await channels()).every((item) => item.connection === null)).toBe(true);
    expect(fake.calls.some((item) => item.url.pathname.endsWith("/token"))).toBe(false);
  });

  it("reports a denied authorization and a failed or refused code exchange", async (): Promise<void> => {
    const denied = (await startConnect("kick")).searchParams.get("state") ?? "";
    expect(await callback("kick", { state: denied, error: "access_denied" })).toBe("denied");
    fake.tokenStatus = 400;
    expect(await connectChannel("kick")).toBe("denied");
    fake.tokenStatus = 500;
    const errors = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    expect(await connectChannel("kick")).toBe("failed");
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/kick-code|access/);
  });

  it("refuses a channel that another page connected (account substitution) and revokes the new token", async (): Promise<void> => {
    expect(await connectChannel("twitch", "rival")).toBe("connected");
    fake.calls.length = 0;
    expect(await connectChannel("twitch")).toBe("channel_taken");
    expect(fake.calls.some((item) => item.url.pathname === "/oauth2/revoke")).toBe(true);
    expect((await channels()).find((item) => item.platform === "twitch")?.connection).toBeNull();
  });

  it("does not revoke the Google grant that another page's YouTube connection still uses", async (): Promise<void> => {
    expect(await connectChannel("youtube", "rival")).toBe("connected");
    fake.calls.length = 0;
    expect(await connectChannel("youtube")).toBe("channel_taken");
    expect(fake.calls.some((item) => item.url.pathname === "/revoke")).toBe(false);
    const row = await env.DB.prepare("SELECT status FROM channel_connections WHERE platform='youtube'").first("status");
    expect(row).toBe("active");
  });

  it("sends Kick's revocation token in the query string", async (): Promise<void> => {
    expect(await connectChannel("kick", "rival")).toBe("connected");
    fake.calls.length = 0;
    expect(await connectChannel("kick")).toBe("channel_taken");
    const revoke = fake.calls.find((item) => item.url.pathname === "/oauth/revoke");
    expect(revoke?.url.searchParams.get("token")).toBeTruthy();
    expect(revoke?.url.searchParams.get("token_hint_type")).toBe("refresh_token");
  });

  it("keeps the row on reconnect and needs a disconnect before another channel of the same platform", async (): Promise<void> => {
    expect(await connectChannel("twitch")).toBe("connected");
    const before = await env.DB.prepare("SELECT id FROM channel_connections WHERE platform='twitch'").first("id");
    await env.DB.prepare("UPDATE channel_connections SET data_read_at=1").run();
    const reconnect = await call("POST", "channels/twitch/reconnect", { user: "owner", body: {} });
    const state = new URL((await reconnect.json<{ authorizeUrl: string }>()).authorizeUrl).searchParams.get("state") ?? "";
    expect(await callback("twitch", { state, code: "c" })).toBe("connected");
    expect(await env.DB.prepare("SELECT id FROM channel_connections WHERE platform='twitch'").first("id")).toBe(before);
    // The reconnect read the channel again, so its data clock starts again.
    expect(await env.DB.prepare("SELECT data_read_at FROM channel_connections").first("data_read_at")).toBeGreaterThan(1);
    fake.identity.twitch = { id: "999", name: "Other" };
    expect(await connectChannel("twitch")).toBe("disconnect_first");
    const actions = await env.DB.prepare("SELECT action FROM moderation_actions ORDER BY created_at").all();
    expect(actions.results.map((row) => row.action)).toEqual(["channel_connected", "channel_reconnected"]);
  });

  it("routes deliveries to a channel connected in this isolate at once, even after an unknown lookup", async (): Promise<void> => {
    const now = Date.now();
    expect(await routeFor(env, "twitch", fake.identity.twitch.id, now)).toBeNull();
    expect(await connectChannel("twitch")).toBe("connected");
    expect(await routeFor(env, "twitch", fake.identity.twitch.id, now)).toBe(page);
  });

  it("refuses an authorization with fewer scopes than the feed needs", async (): Promise<void> => {
    fake.grantedScopes = ["user:read"];
    expect(await connectChannel("kick")).toBe("scope_missing");
    expect((await channels()).find((item) => item.platform === "kick")?.connection).toBeNull();
  });

  it("shows a failed subscription as an error the owner can retry", async (): Promise<void> => {
    fake.subscribeStatus = 500;
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    expect(await connectChannel("kick")).toBe("failed");
    expect((await channels()).find((item) => item.platform === "kick")?.connection).toMatchObject({
      status: "error",
      code: "subscribe_failed",
    });
    fake.subscribeStatus = 401;
    expect(await connectChannel("kick")).toBe("failed");
    expect((await channels()).find((item) => item.platform === "kick")?.connection).toMatchObject({
      status: "needs_reauth",
      code: "authorization_revoked",
    });
  });

  it("answers an unknown platform with 404 and a frozen page with a failed result", async (): Promise<void> => {
    const state = (await startConnect("kick")).searchParams.get("state") ?? "";
    await expect(
      callbackLoader({
        request: new Request(`${origin}/channels/callback/tiktok`),
        params: { platform: "tiktok" },
        context: context(),
      } as unknown as LoaderFunctionArgs),
    ).rejects.toMatchObject({ status: 404 });
    await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(page).run();
    expect(await callback("kick", { state, code: "c" })).toBe("failed");
  });
});

describe("callback failures", (): void => {
  /** Runs `during` when the provider answers the identity request, as a parallel callback would. */
  function duringIdentity(during: () => Promise<void>): void {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      const response = await real(input, init);
      if (new URL(input).pathname === "/public/v1/users") await during();
      return response;
    });
  }

  it("maps a channel claimed by a parallel callback to channel_taken and revokes the new token", async (): Promise<void> => {
    duringIdentity(async (): Promise<void> => {
      await env.DB.prepare(
        `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,created_at,updated_at)
          VALUES ('race',?,'kick','333','Rival','',1,1)`,
      )
        .bind(rivalPage)
        .run();
    });
    expect(await connectChannel("kick")).toBe("channel_taken");
    expect(fake.calls.some((item) => item.url.pathname === "/oauth/revoke")).toBe(true);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_tokens").first("n")).toBe(0);
  });

  it("maps a platform slot filled by a parallel callback to disconnect_first", async (): Promise<void> => {
    duringIdentity(async (): Promise<void> => {
      await env.DB.prepare(
        `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,created_at,updated_at)
          VALUES ('race',?,'kick','999','Other','',1,1)`,
      )
        .bind(page)
        .run();
    });
    expect(await connectChannel("kick")).toBe("disconnect_first");
  });

  it("revokes and leaves nothing usable when the ingest object fails", async (): Promise<void> => {
    const errors = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const working = env.CHANNEL_INGEST;
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 503 })) }),
    } as unknown as DurableObjectNamespace;
    expect(await connectChannel("kick")).toBe("failed");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_connections").first("n")).toBe(0);
    expect(fake.calls.some((item) => item.url.pathname === "/oauth/revoke")).toBe(true);
    // A reconnect that fails keeps the row but needs a new authorization.
    env.CHANNEL_INGEST = working;
    expect(await connectChannel("kick")).toBe("connected");
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (): Promise<Response> => Promise.reject(new TypeError("down")) }),
    } as unknown as DurableObjectNamespace;
    expect(await connectChannel("kick")).toBe("failed");
    expect(await env.DB.prepare("SELECT status, status_code FROM channel_connections").first()).toEqual({
      status: "needs_reauth",
      status_code: "authorization_revoked",
    });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_tokens").first("n")).toBe(0);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/kick-access|kick-refresh|kick-code/);
  });

  it.each(["kick", "youtube"] as const)(
    "leaves a newer %s reconnect alone when an older reconnect's ingest call fails later",
    async (platform): Promise<void> => {
      vi.spyOn(console, "error").mockImplementation((): void => undefined);
      expect(await connectChannel(platform)).toBe("connected");
      const working = env.CHANNEL_INGEST;
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached = (): void => undefined;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let hold = true;
      env.CHANNEL_INGEST = {
        idFromName: (name: string) => working.idFromName(name),
        get: (id: DurableObjectId) => ({
          fetch: async (input: string, init?: RequestInit): Promise<Response> => {
            if (!hold || !new URL(input).pathname.endsWith("/connect")) return working.get(id).fetch(input, init);
            hold = false;
            reached();
            await held;
            return new Response(null, { status: 503 });
          },
        }),
      } as unknown as DurableObjectNamespace;
      const start = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(start);
      const older = connectChannel(platform);
      await waiting;
      // A second reconnect writes its tokens later and connects.
      vi.spyOn(Date, "now").mockReturnValue(start + 1000);
      expect(await connectChannel(platform)).toBe("connected");
      fake.calls.length = 0;
      release();
      expect(await older).toBe("failed");
      // Google revokes the whole grant, which the newer reconnect uses: the older YouTube token is not revoked.
      const revokes = fake.calls.filter((item) => item.url.pathname.endsWith("/revoke"));
      expect(revokes).toHaveLength(platform === "youtube" ? 0 : 1);
      expect(await env.DB.prepare("SELECT status, status_code FROM channel_connections").first()).toEqual({
        status: "active",
        status_code: null,
      });
      expect(await env.DB.prepare("SELECT updated_at FROM channel_tokens").first("updated_at")).toBe(start + 1000);
    },
  );

  it("connects nothing when channels were turned off after the start", async (): Promise<void> => {
    const authorize = await startConnect("kick");
    env.CHANNELS_OFF = "1";
    expect(await callback("kick", { state: authorize.searchParams.get("state") ?? "", code: "c" })).toBe("failed");
    expect(fake.calls.some((item) => item.url.pathname.endsWith("/token"))).toBe(false);
  });

  it("answers failed, not an error page, when the cleanup after a failed ingest call fails too", async (): Promise<void> => {
    const errors = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const authorize = await startConnect("kick");
    const real = env.DB;
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (): Promise<Response> => {
          // The database goes away as the ingest call fails.
          env.DB = { ...real, prepare: real.prepare.bind(real), batch: () => Promise.reject(new Error("D1 down")) } as unknown as D1Database;
          return Promise.resolve(new Response(null, { status: 503 }));
        },
      }),
    } as unknown as DurableObjectNamespace;
    expect(await callback("kick", { state: authorize.searchParams.get("state") ?? "", code: "c" })).toBe("failed");
    env.DB = real;
    expect(errors.mock.calls.map((call): unknown => call[0])).toContain("channel_connect_cleanup_failed");
  });

  it("does not overwrite a row that a disconnect marked between the check and the write", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    const tokensBefore = await env.DB.prepare("SELECT * FROM channel_tokens").all();
    const real = env.DB;
    env.DB = {
      prepare: real.prepare.bind(real),
      batch: async (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
        await real.prepare("UPDATE channel_connections SET status='needs_reauth', status_code='disconnecting'").run();
        return real.batch(statements);
      },
    } as unknown as D1Database;
    expect(await connectChannel("kick")).toBe("disconnect_first");
    env.DB = real;
    expect(await env.DB.prepare("SELECT status_code FROM channel_connections").first("status_code")).toBe("disconnecting");
    // The new tokens were not written over the old ones either.
    expect((await env.DB.prepare("SELECT * FROM channel_tokens").all()).results).toEqual(tokensBefore.results);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM moderation_actions WHERE action='channel_reconnected'").first("n")).toBe(0);
    expect(fake.calls.filter((item) => item.url.pathname === "/oauth/revoke")).toHaveLength(1);
  });

  it("refuses a reconnect while a disconnect of the channel is still running", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    await env.DB.prepare("UPDATE channel_connections SET status='needs_reauth', status_code='disconnecting'").run();
    expect(await connectChannel("kick")).toBe("disconnect_first");
  });

  it("leaves a row that a disconnect marked, and its tokens, alone when the cleanup after a failed ingest call runs", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    let tokens: unknown;
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (): Promise<Response> => {
          // A disconnect marks the row while the ingest call is out.
          await env.DB.prepare("UPDATE channel_connections SET status='needs_reauth', status_code='disconnecting'").run();
          tokens = (await env.DB.prepare("SELECT * FROM channel_tokens").all()).results;
          return new Response(null, { status: 503 });
        },
      }),
    } as unknown as DurableObjectNamespace;
    expect(await connectChannel("kick")).toBe("failed");
    expect(await env.DB.prepare("SELECT status_code FROM channel_connections").first("status_code")).toBe("disconnecting");
    expect((await env.DB.prepare("SELECT * FROM channel_tokens").all()).results).toEqual(tokens);
    expect(tokens).toHaveLength(1);
  });

  it("revokes and answers failed when the write fails", async (): Promise<void> => {
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const authorize = await startConnect("kick");
    // The token keys went away between the start and the callback, so the encrypted write fails.
    env.CHANNEL_TOKEN_KEYS = "broken";
    expect(await callback("kick", { state: authorize.searchParams.get("state") ?? "", code: "c" })).toBe("failed");
    expect(fake.calls.some((item) => item.url.pathname === "/oauth/revoke")).toBe(true);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_connections").first("n")).toBe(0);
  });
});

describe("DELETE /api/channels/:platform", (): void => {
  it("unsubscribes, revokes, deletes the tokens and stops ingestion", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    const connectionId = (await env.DB.prepare("SELECT id FROM channel_connections").first("id")) as string;
    fake.calls.length = 0;
    const response = await call("DELETE", "channels/kick", { user: "owner" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    const ids = fake.subscriptions.map((item) => item.id);
    expect(ids).toHaveLength(0);
    // One delete for each subscription: two of chat, five of support events and one of the live signals.
    expect(fake.calls.map((item) => `${item.method} ${item.url.pathname}`)).toEqual([
      "GET /public/v1/events/subscriptions",
      ...Array.from({ length: 8 }, (): string => "DELETE /public/v1/events/subscriptions"),
      "POST /oauth/revoke",
    ]);
    expect(new URLSearchParams(fake.calls[9].body).get("token_hint_type")).toBe("refresh_token");
    expect(await loadTokens(env, connectionId, "kick")).toBeNull();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_connections").first("n")).toBe(0);
    expect(await ingestState().storage.get("subs:kick")).toBeUndefined();
    const audit = await env.DB.prepare("SELECT metadata FROM moderation_actions WHERE action='channel_disconnected'").first("metadata");
    expect(JSON.parse(audit as string)).toEqual({ platform: "kick", revoked: true, unsubscribed: true });
  });

  it("deletes the connection even when the provider refuses the revoke, and records it", async (): Promise<void> => {
    expect(await connectChannel("youtube")).toBe("connected");
    fake.revokeStatus = 400;
    const response = await call("DELETE", "channels/youtube", { user: "owner" });
    expect(await response.json()).toEqual({ revoked: false });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_connections").first("n")).toBe(0);
  });

  it("refreshes an expired token before it revokes, and still revokes when the refresh fails", async (): Promise<void> => {
    fake.expiresIn = 0;
    expect(await connectChannel("twitch")).toBe("connected");
    fake.calls.length = 0;
    fake.refreshStatus = 400;
    expect(await (await call("DELETE", "channels/twitch", { user: "owner" })).json()).toEqual({ revoked: true });
    const revoke = fake.calls.find((item) => item.url.pathname === "/oauth2/revoke");
    // The connect already refreshed the expired token once; the failed refresh at disconnect falls back to it.
    expect(new URLSearchParams(revoke?.body).get("token")).toBe("twitch-access-1");
    expect(fake.calls.filter((item) => item.body.includes("grant_type=refresh_token"))).toHaveLength(1);
  });

  it("deletes the connection and records it when the ingest object fails", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (): Promise<Response> => Promise.reject(new TypeError("down")) }),
    } as unknown as DurableObjectNamespace;
    expect(await (await call("DELETE", "channels/kick", { user: "owner" })).json()).toEqual({ revoked: false });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_connections").first("n")).toBe(0);
    const audit = await env.DB.prepare("SELECT metadata FROM moderation_actions WHERE action='channel_disconnected'").first("metadata");
    expect(JSON.parse(audit as string)).toEqual({ platform: "kick", revoked: false, unsubscribed: false });
  });

  it("keeps a connection that a reconnect replaced during the disconnect, and answers 409", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    const real = env.CHANNEL_INGEST;
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: string, init?: RequestInit): Promise<Response> => {
          // A reconnect finishes while the disconnect runs.
          await env.DB.prepare("UPDATE channel_connections SET status='active', status_code=NULL").run();
          return (real as unknown as RoomNamespace<ChannelIngest>).get(ingest.idFromName(page)).fetch(input, init);
        },
      }),
    } as unknown as DurableObjectNamespace;
    const response = await call("DELETE", "channels/kick", { user: "owner" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "channel_conflict" });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_connections").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM moderation_actions WHERE action='channel_disconnected'").first("n")).toBe(0);
  });

  it("accepts no body or an empty object, and refuses other bodies", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    expect((await call("DELETE", "channels/kick", { user: "owner", body: { all: true } })).status).toBe(400);
    expect((await call("DELETE", "channels/kick", { user: "owner", body: {} })).status).toBe(200);
  });

  it("drops deliveries that race a disconnect", async (): Promise<void> => {
    expect(await connectChannel("twitch")).toBe("connected");
    const real = env.CHANNEL_INGEST;
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: string, init?: RequestInit): Promise<Response> => {
          // A delivery arrives while the disconnect runs: the row is already marked.
          const stub = (real as unknown as RoomNamespace<ChannelIngest>).get(ingest.idFromName(page));
          await stub.fetch(`https://channel-ingest.internal/event?streamerId=${page}&platform=twitch`, {
            method: "POST",
            body: JSON.stringify({
              deliveryId: "race",
              channelId: "111",
              events: [
                {
                  kind: "chat",
                  id: "twitch:race",
                  platform: "twitch",
                  channelId: "111",
                  messageId: "race",
                  user: { id: "u", displayName: "U" },
                  text: "hi",
                  fragments: [{ type: "text", text: "hi" }],
                  badges: [],
                  sentAt: null,
                  receivedAt: Date.now(),
                  live: true,
                },
              ],
            }),
          });
          return stub.fetch(input, init);
        },
      }),
    } as unknown as DurableObjectNamespace;
    await call("DELETE", "channels/twitch", { user: "owner" });
    expect(ingestState().storage.sql.exec("SELECT key FROM seen WHERE key LIKE '%race%'").toArray()).toEqual([]);
  });

  it("needs a recent sign-in and acts only on the viewer's own page", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    expect((await call("DELETE", "channels/kick", { user: "rival" })).status).toBe(404);
    expect((await call("DELETE", "channels/kick", { user: "viewer" })).status).toBe(404);
    await staleSession("owner");
    const stale = await call("DELETE", "channels/kick", { user: "owner" });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ code: "reauth_required" });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_connections").first("n")).toBe(1);
  });
});

describe("account deletion", (): void => {
  it("unsubscribes, revokes and closes the feed before the rows cascade away", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    expect(await connectChannel("twitch")).toBe("connected");
    const socket = serverSocketOf(
      (
        await ingest
          .get(ingest.idFromName(page))
          .fetch(`https://channel-ingest.internal/subscribe?streamerId=${page}`, {
            headers: { Upgrade: "websocket", "X-SB-Owner": "1" },
          })
      ).webSocket,
    );
    fake.calls.length = 0;
    await deleteAccount(env, "owner");
    expect(fake.subscriptions).toEqual([]);
    expect(fake.calls.filter((item) => item.url.pathname.endsWith("/revoke"))).toHaveLength(2);
    expect(socket.ofType("unavailable")).toHaveLength(1);
    expect(socket.open).toBe(false);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_connections").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_tokens").first("n")).toBe(0);
  });

  it("still deletes the account when the providers and the ingest object fail or hang", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (): Promise<Response> => Promise.reject(new TypeError("down")) }),
    } as unknown as DurableObjectNamespace;
    await deleteAccount(env, "owner");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM user WHERE id='owner'").first("n")).toBe(0);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('hang','H','h@x.test',1,1,1)"),
      env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES ('40000000-0000-4000-8000-000000000009','hang','hang_page','H')"),
      env.DB.prepare(
        `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,created_at,updated_at)
          VALUES ('h1','40000000-0000-4000-8000-000000000009','kick','777','H','',1,1)`,
      ),
    ]);
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (): Promise<Response> => new Promise<Response>(() => undefined) }),
    } as unknown as DurableObjectNamespace;
    const started = Date.now();
    await disconnectAllChannels(env, "40000000-0000-4000-8000-000000000009", 50);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("YouTube data retention", (): void => {
  const day = 86_400_000;

  async function setRow(platform: string, values: Record<string, unknown>): Promise<void> {
    const assignments = Object.keys(values).map((key) => `${key}=?`).join(", ");
    await env.DB.prepare(`UPDATE channel_connections SET ${assignments} WHERE platform=?`)
      .bind(...Object.values(values), platform)
      .run();
  }

  /** Answers YouTube channel reads with `answer` and returns a counter of those reads. */
  function stubYoutubeChannels(answer: () => Response): () => number {
    const real = globalThis.fetch;
    let count = 0;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
      if (!new URL(input).pathname.endsWith("/youtube/v3/channels")) return real(input, init);
      count += 1;
      return answer();
    });
    return (): number => count;
  }

  async function platforms(): Promise<string[]> {
    const { results } = await env.DB.prepare("SELECT platform FROM channel_connections ORDER BY platform").all<{ platform: string }>();
    return results.map((row) => row.platform);
  }

  it("keeps fresh YouTube rows, active ones aged 7 to 30 days, and other platforms of any age", async (): Promise<void> => {
    expect(await connectChannel("youtube")).toBe("connected");
    expect(await connectChannel("kick")).toBe("connected");
    const now = Date.now();
    // Kick is not under the YouTube rules, however old.
    await setRow("kick", { updated_at: now - 60 * day, data_read_at: now - 60 * day });
    // Active YouTube with an old status time but data read 10 days ago.
    await setRow("youtube", { updated_at: now - 20 * day, data_read_at: now - 10 * day });
    await expireYoutubeConnections(env, now);
    expect(await platforms()).toEqual(["kick", "youtube"]);
  });

  it("refreshes data older than 25 days instead of removing it", async (): Promise<void> => {
    expect(await connectChannel("youtube")).toBe("connected");
    const now = Date.now();
    await setRow("youtube", { data_read_at: now - 26 * day });
    fake.identity.youtube = { id: "UCchannel1", name: "Refreshed" };
    await expireYoutubeConnections(env, now);
    expect(await env.DB.prepare("SELECT display_name, data_read_at > ? AS fresh FROM channel_connections").bind(now - day).first()).toEqual({
      display_name: "Refreshed",
      fresh: 1,
    });
  });

  it("removes a connection that needs a new authorization for more than 7 days, and writes an audit row", async (): Promise<void> => {
    expect(await connectChannel("youtube")).toBe("connected");
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    await setRow("youtube", { status: "needs_reauth", status_code: "authorization_revoked", updated_at: now - 8 * day });
    fake.calls.length = 0;
    await expireYoutubeConnections(env, now);
    expect(await platforms()).toEqual([]);
    expect(fake.calls.some((item) => item.url.pathname === "/revoke")).toBe(true);
    const audit = await env.DB.prepare("SELECT actor_id, metadata FROM moderation_actions WHERE action='channel_expired'").first();
    expect(audit).toEqual({ actor_id: null, metadata: '{"platform":"youtube","reason":"reauth"}' });
    expect(warn).toHaveBeenCalledWith("channel_youtube_expired", { count: 1, reason: "reauth" });
  });

  it("removes a connection whose refresh found the access revoked, or whose data stays older than 30 days", async (): Promise<void> => {
    expect(await connectChannel("youtube")).toBe("connected");
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    await setRow("youtube", { data_read_at: now - 26 * day });
    await env.DB.prepare("UPDATE channel_tokens SET expires_at=1").run();
    fake.refreshStatus = 400;
    await expireYoutubeConnections(env, now);
    expect(await platforms()).toEqual([]);
    // Stale: the title read keeps failing. The object waits an hour between attempts, so this runs later.
    fake.refreshStatus = null;
    expect(await connectChannel("youtube")).toBe("connected");
    const later = now + 2 * 60 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await setRow("youtube", { data_read_at: later - 31 * day });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> =>
      new URL(input).pathname.endsWith("/youtube/v3/channels") ? new Response("down", { status: 500 }) : real(input, init),
    );
    await expireYoutubeConnections(env, later);
    expect(await platforms()).toEqual([]);
    const reasons = await env.DB.prepare("SELECT metadata FROM moderation_actions WHERE action='channel_expired' ORDER BY rowid").all();
    expect(reasons.results.map((row) => (JSON.parse(row.metadata as string) as { reason: string }).reason)).toEqual(["reauth", "stale"]);
  });

  it("keeps a connection that was reconnected after its refresh found the access revoked", async (): Promise<void> => {
    expect(await connectChannel("youtube")).toBe("connected");
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    await setRow("youtube", { data_read_at: now - 26 * day });
    await env.DB.prepare("UPDATE channel_tokens SET expires_at=1").run();
    fake.refreshStatus = 400;
    const working = env.CHANNEL_INGEST;
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => working.idFromName(name),
      get: (id: DurableObjectId) => ({
        fetch: async (input: string, init?: RequestInit): Promise<Response> => {
          const response = await working.get(id).fetch(input, init);
          // The owner reconnects after the refresh answered, before the job marks its rows.
          if (new URL(input).pathname.endsWith("/refresh")) await setRow("youtube", { status: "active", data_read_at: now });
          return response;
        },
      }),
    } as unknown as DurableObjectNamespace;
    await expireYoutubeConnections(env, now);
    env.CHANNEL_INGEST = working;
    expect(await platforms()).toEqual(["youtube"]);
    expect(await env.DB.prepare("SELECT status_code FROM channel_connections").first("status_code")).not.toBe("disconnecting");
  });

  it("never takes a row that a disconnect is marking now, and does nothing while channels are off", async (): Promise<void> => {
    expect(await connectChannel("youtube")).toBe("connected");
    const now = Date.now();
    // A disconnect marks the row now, with old data: neither the 7-day nor the data rule takes it while it runs.
    await setRow("youtube", { status: "needs_reauth", status_code: "disconnecting", updated_at: now, data_read_at: now - 40 * day });
    await expireYoutubeConnections(env, now + 30 * 60_000);
    expect(await platforms()).toEqual(["youtube"]);
    await setRow("youtube", { status: "needs_reauth", status_code: "authorization_revoked", updated_at: now - 8 * day });
    env.CHANNELS_OFF = "1";
    await expireYoutubeConnections(env, now);
    expect(await platforms()).toEqual(["youtube"]);
    env.CHANNELS_OFF = undefined;
  });

  it("finishes a disconnect that stopped more than an hour ago, on any platform", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    await setRow("kick", { status: "needs_reauth", status_code: "disconnecting", updated_at: now - 2 * 60 * 60_000 });
    fake.calls.length = 0;
    await expireYoutubeConnections(env, now);
    expect(await platforms()).toEqual([]);
    expect(fake.calls.some((item) => item.url.pathname === "/oauth/revoke")).toBe(true);
    expect(warn).toHaveBeenCalledWith("channel_youtube_expired", { count: 1, reason: "stuck" });
    const audit = await env.DB.prepare("SELECT actor_id, metadata FROM moderation_actions WHERE action='channel_expired'").first();
    expect(audit).toEqual({ actor_id: null, metadata: '{"platform":"kick","reason":"stuck"}' });
  });

  it("finishes a stopped disconnect while channels are off, without a call to the providers", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    await setRow("kick", { status: "needs_reauth", status_code: "disconnecting", updated_at: now - 2 * 60 * 60_000 });
    fake.calls.length = 0;
    env.CHANNELS_OFF = "1";
    await expireYoutubeConnections(env, now);
    env.CHANNELS_OFF = undefined;
    expect(await platforms()).toEqual([]);
    expect(fake.calls).toEqual([]);
    const audit = await env.DB.prepare("SELECT metadata FROM moderation_actions WHERE action='channel_expired'").first("metadata");
    expect(JSON.parse(audit as string)).toEqual({ platform: "kick", reason: "stuck" });
  });

  it("never removes data it did not try to refresh, and failing rows do not starve the others", async (): Promise<void> => {
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    // After a long outage: 25 YouTube connections on 25 pages, all with data older than 30 days (but not 32).
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 25; index++) {
      const id = `50000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`;
      statements.push(
        env.DB.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,1,1)").bind(
          `u${index}`,
          `U${index}`,
          `u${index}@x.test`,
        ),
        env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,?,?,?)").bind(id, `u${index}`, `p_${index}`, "P"),
        env.DB.prepare(
          `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,created_at,updated_at,data_read_at)
            VALUES (?,?,'youtube',?,'Old','',1,1,?)`,
        ).bind(`c${index}`, id, `UC${index}`, now - 31 * day - index),
        await tokenStatement(env, `c${index}`, "youtube", { accessToken: "a", refreshToken: "r", expiresAt: null }, 1),
      );
    }
    await env.DB.batch(statements);
    // YouTube is down for title reads: every refresh fails. The first run removes only the 20 it tried.
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> =>
      new URL(input).pathname.endsWith("/youtube/v3/channels") ? new Response("down", { status: 500 }) : real(input, init),
    );
    await expireYoutubeConnections(env, now);
    const left = await env.DB.prepare("SELECT id FROM channel_connections WHERE platform='youtube' ORDER BY id").all();
    // The oldest data goes first: c5 to c24 were tried and removed.
    expect(left.results.map((row) => row.id)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(warn).toHaveBeenCalledWith("channel_youtube_overdue", { count: 5 });
    expect(warn).toHaveBeenCalledWith("channel_youtube_refresh_failed", { count: 20 });
    // The next run reaches the other 5.
    await expireYoutubeConnections(env, now);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_connections WHERE platform='youtube'").first("n")).toBe(0);
  });

  it("does not remove an old connection that this run did not try to refresh, until the 32-day backstop", async (): Promise<void> => {
    expect(await connectChannel("youtube")).toBe("connected");
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    await setRow("youtube", { data_read_at: now - 31 * day });
    // The object tried a refresh a few minutes ago: this run skips it, so it is not removed now.
    await ingestState().storage.put("refreshAttemptAt", now - 5 * 60_000);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const reads = stubYoutubeChannels(() => new Response("down", { status: 500 }));
    await expireYoutubeConnections(env, now);
    expect(await platforms()).toEqual(["youtube"]);
    expect(reads()).toBe(0);
    expect(warn).toHaveBeenCalledWith("channel_youtube_overdue", { count: 1 });
    // Past 32 days the row goes even without a refresh attempt.
    await setRow("youtube", { data_read_at: now - 33 * day });
    await expireYoutubeConnections(env, now);
    expect(await platforms()).toEqual([]);
    expect(reads()).toBe(0);
    const audit = await env.DB.prepare("SELECT metadata FROM moderation_actions WHERE action='channel_expired'").first("metadata");
    expect(JSON.parse(audit as string)).toEqual({ platform: "youtube", reason: "stale_backstop" });
  });

  it("keeps a row whose refresh failed while its data is younger than 30 days, and counts the failure", async (): Promise<void> => {
    expect(await connectChannel("youtube")).toBe("connected");
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    await setRow("youtube", { data_read_at: now - 26 * day });
    vi.spyOn(Date, "now").mockReturnValue(now);
    const reads = stubYoutubeChannels(() => new Response("down", { status: 500 }));
    await expireYoutubeConnections(env, now);
    expect(await platforms()).toEqual(["youtube"]);
    expect(reads()).toBe(1);
    expect(warn).toHaveBeenCalledWith("channel_youtube_refresh_failed", { count: 1 });
    // The next run, 10 minutes later, skips the row: no second read.
    vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000);
    await expireYoutubeConnections(env, now + 10 * 60_000);
    expect(reads()).toBe(1);
    // The run after the hourly interval tries it again.
    vi.spyOn(Date, "now").mockReturnValue(now + 55 * 60_000);
    await expireYoutubeConnections(env, now + 55 * 60_000);
    expect(reads()).toBe(2);
  });

  it("keeps a stale row whose refresh wrote fresh data after the job stopped waiting for it", async (): Promise<void> => {
    expect(await connectChannel("youtube")).toBe("connected");
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    await setRow("youtube", { data_read_at: now - 31 * day });
    vi.spyOn(Date, "now").mockReturnValue(now);
    // The refresh is late for the job (it counts as failed), but its write of fresh data lands before the mark.
    stubYoutubeChannels(() => new Response("down", { status: 500 }));
    const real = env.CHANNEL_INGEST;
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => real.idFromName(name),
      get: (id: DurableObjectId) => {
        const stub = real.get(id);
        return {
          fetch: async (input: string, init?: RequestInit): Promise<Response> => {
            if (!new URL(input).pathname.endsWith("/refresh")) return stub.fetch(input, init);
            await env.DB.prepare("UPDATE channel_connections SET data_read_at=?").bind(now).run();
            return Response.json({ result: "failed" });
          },
        };
      },
    } as unknown as DurableObjectNamespace;
    await expireYoutubeConnections(env, now);
    expect(await platforms()).toEqual(["youtube"]);
  });

  it("counts a refresh that reads another channel as failed", async (): Promise<void> => {
    expect(await connectChannel("youtube")).toBe("connected");
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const now = Date.now();
    await setRow("youtube", { data_read_at: now - 31 * day });
    fake.identity.youtube = { id: "UCsomeoneElse", name: "Other" };
    await expireYoutubeConnections(env, now);
    expect(await platforms()).toEqual([]);
    const audit = await env.DB.prepare("SELECT metadata FROM moderation_actions WHERE action='channel_expired'").first("metadata");
    expect(JSON.parse(audit as string)).toEqual({ platform: "youtube", reason: "stale" });
  });

  it("still removes the row when the ingest object fails", async (): Promise<void> => {
    expect(await connectChannel("youtube")).toBe("connected");
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    await env.DB.prepare("UPDATE channel_connections SET data_read_at=0").run();
    env.CHANNEL_INGEST = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (): Promise<Response> => Promise.reject(new TypeError("down")) }),
    } as unknown as DurableObjectNamespace;
    await expireYoutubeConnections(env, Date.now());
    expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_connections").first("n")).toBe(0);
  });
});

describe("support events of a connection", (): void => {
  const SUPPORTED = [...TWITCH_SCOPES, ...TWITCH_SUPPORT_SCOPES];
  const TWITCH_CHAT_TYPES = ["channel.chat.clear", "channel.chat.clear_user_messages", "channel.chat.message", "channel.chat.message_delete", "channel.moderate"];
  const TWITCH_SUPPORT_TYPES = ["channel.cheer", "channel.follow", "channel.raid", "channel.subscribe", "channel.subscription.gift", "channel.subscription.message"];
  const KICK_CHAT_EVENTS = ["chat.message.sent", "moderation.banned"];
  const KICK_SUPPORT_EVENTS = ["channel.followed", "channel.subscription.gifts", "channel.subscription.new", "channel.subscription.renewal", "kicks.gifted"];
  // The optional live types: each connection asks for them, with or without support events.
  const TWITCH_LIVE_TYPES = ["stream.offline", "stream.online"];
  const KICK_LIVE_EVENTS = ["livestream.status.updated"];

  function flag(platform: string): Promise<number | null> {
    return env.DB.prepare("SELECT support_events FROM channel_connections WHERE platform=?").bind(platform).first<number>("support_events");
  }

  /** The subscription types that the provider holds for the platform, in alphabetical order. */
  function types(platform: "twitch" | "kick"): string[] {
    return fake.subscriptions
      .filter((item) => item.platform === platform)
      .map((item) => item.type ?? "")
      .sort();
  }

  function ids(platform: "twitch" | "kick", wanted: readonly string[]): string[] {
    return fake.subscriptions.filter((item) => item.platform === platform && wanted.includes(item.type ?? "")).map((item) => item.id);
  }

  /** The owner selects Reconnect: the address of the provider page. */
  async function reconnect(platform: string): Promise<URL> {
    const response = await call("POST", `channels/${platform}/reconnect`, { user: "owner", body: {} });
    expect(response.status).toBe(200);
    return new URL((await response.json<{ authorizeUrl: string }>()).authorizeUrl);
  }

  /** The owner approves at the provider, and the provider sends the browser back. */
  async function finish(platform: string, url: URL): Promise<string | null> {
    return callback(platform, { state: url.searchParams.get("state") ?? "", code: `${platform}-code` });
  }

  async function status(platform: string): Promise<unknown> {
    return env.DB.prepare("SELECT status, status_code FROM channel_connections WHERE platform=?").bind(platform).first();
  }

  /** The list as the Channels section reads it. */
  async function views(): Promise<ChannelView[]> {
    return channelsResponseSchema.parse({ channels: await channels() }).channels;
  }

  it("reads the support events of each new Twitch connection, and asks for their three scopes at each connect and reconnect", async (): Promise<void> => {
    expect(await connectChannel("twitch")).toBe("connected");
    expect(await flag("twitch")).toBe(1);
    expect(types("twitch")).toEqual([...TWITCH_CHAT_TYPES, ...TWITCH_SUPPORT_TYPES, ...TWITCH_LIVE_TYPES].sort());
    const list = await channels();
    expect(list[0]).toMatchObject({ support: true, connection: { status: "active", code: null } });
    // No connection: no support events. The list never names a scope, and it has no field of the old switch.
    expect(list.slice(1).map((item) => item.support)).toEqual([false, false]);
    expect(JSON.stringify(list)).not.toMatch(/user:read:chat|bits:read|supportScopes/);
    expect((await views()).map(channelCardState)).toEqual(["healthy", null, null]);
    const raid = fake.calls.filter((item) => item.method === "POST" && item.body.includes('"channel.raid"'));
    expect(JSON.parse(raid[0].body)).toMatchObject({ version: "1", condition: { to_broadcaster_user_id: "111" } });
    expect(JSON.stringify(fake.calls.map((item) => item.body))).not.toContain("channel.bits.use");
    // A reconnect asks for the same scopes and keeps the support events.
    const again = await reconnect("twitch");
    expect(again.origin + again.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
    expect(again.searchParams.get("redirect_uri")).toBe(`${origin}/channels/callback/twitch`);
    expect(again.searchParams.get("scope")?.split(" ")).toEqual(SUPPORTED);
    expect(await finish("twitch", again)).toBe("connected");
    expect(await flag("twitch")).toBe(1);
    expect(types("twitch")).toEqual([...TWITCH_CHAT_TYPES, ...TWITCH_SUPPORT_TYPES, ...TWITCH_LIVE_TYPES].sort());
    // A disconnect deletes each subscription, also the raid one that names the channel in another field.
    expect((await call("DELETE", "channels/twitch", { user: "owner" })).status).toBe(200);
    expect(fake.subscriptions).toEqual([]);
    // Nothing recorded a choice: the support events are no setting.
    const audit = await env.DB.prepare("SELECT count(*) AS n FROM moderation_actions WHERE action LIKE 'channel_support_%'").first("n");
    expect(audit).toBe(0);
  });

  it("reads the support events of each new YouTube and Kick connection without a new permission", async (): Promise<void> => {
    expect((await startConnect("youtube")).searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.readonly");
    expect((await startConnect("kick")).searchParams.get("scope")?.split(" ")).toEqual(["user:read", "channel:read", "events:subscribe"]);
    expect(await connectChannel("kick")).toBe("connected");
    expect(await flag("kick")).toBe(1);
    expect(types("kick")).toEqual([...KICK_SUPPORT_EVENTS, ...KICK_CHAT_EVENTS, ...KICK_LIVE_EVENTS].sort());
    expect(await status("kick")).toEqual({ status: "active", status_code: null });
    fake.calls.length = 0;
    expect(await connectChannel("youtube")).toBe("connected");
    expect(await flag("youtube")).toBe(1);
    // YouTube support comes with the chat: a connect makes no provider subscription.
    expect(fake.calls.filter((item) => item.url.pathname.includes("subscriptions"))).toEqual([]);
    expect((await channels()).map((item) => item.support)).toEqual([false, true, true]);
    // A reconnect keeps the support events, with the scope of today.
    const again = await reconnect("youtube");
    expect(again.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.readonly");
    expect(await finish("youtube", again)).toBe("connected");
    expect(await flag("youtube")).toBe(1);
  });

  it("connects the channel for chat when Twitch does not give the support scopes", async (): Promise<void> => {
    // The provider gives the scopes of chat only.
    fake.grantedScopes = TWITCH_SCOPES;
    const asked = await startConnect("twitch");
    // A state that a Worker from before this change wrote has the choice of the old switch: it still works.
    await env.DB.prepare("UPDATE verification SET value=json_set(value, '$.support', json('false'))").run();
    expect(await finish("twitch", asked)).toBe("support_denied");
    expect(await flag("twitch")).toBe(0);
    expect(await status("twitch")).toEqual({ status: "active", status_code: null });
    expect(types("twitch")).toEqual([...TWITCH_CHAT_TYPES, ...TWITCH_LIVE_TYPES].sort());
    expect((await channels())[0]).toMatchObject({ support: false, connection: { status: "active" } });
    // Chat still reaches the page. The support event of the same delivery leaves nothing.
    const stub = ingest.get(ingest.idFromName(page));
    const now = Date.now();
    const chat = { kind: "chat", id: "twitch:m1", platform: "twitch", channelId: "111", messageId: "m1", user: { id: "u", displayName: "U" }, text: "hi", fragments: [{ type: "text", text: "hi" }], badges: [], sentAt: null, receivedAt: now, live: true };
    const follow = { kind: "follow", id: "twitch:f1", platform: "twitch", deliveryId: "f1", sender: { id: "u", displayName: "U" }, anonymous: false, amount: null, currency: null, receivedAt: now, replay: false };
    await stub.fetch(`https://channel-ingest.internal/event?streamerId=${page}&platform=twitch`, {
      method: "POST",
      body: JSON.stringify({ deliveryId: "d1", channelId: "111", events: [chat, follow] }),
    });
    const seen = ingestState().storage.sql.exec("SELECT key FROM seen ORDER BY key").toArray();
    expect(seen).toEqual([{ key: "delivery:twitch:d1" }, { key: "message:twitch:m1" }]);
  });

  it("keeps the chat of a Twitch channel from before this change, shows it on the card only, and reads the support events after one reconnect", async (): Promise<void> => {
    // The channel as it was connected before this change: the scopes of chat, and no support events.
    fake.grantedScopes = TWITCH_SCOPES;
    expect(await connectChannel("twitch")).toBe("support_denied");
    fake.grantedScopes = null;
    expect(await env.DB.prepare("SELECT scopes FROM channel_connections WHERE platform='twitch'").first("scopes")).toBe(TWITCH_SCOPES.join(" "));
    const before: ChannelView[] = await views();
    // The card asks for a reconnect. The connection is healthy for everything else: no news, and Live shows it as connected.
    expect(channelCardState(before[0])).toBe("support_missing");
    expect(channelHealth(before[0])).toBe("healthy");
    expect(deliversChat(before)).toBe(true);
    const healthy: ChannelView[] = before.map((view: ChannelView): ChannelView => ({ ...view, support: view.connection !== null }));
    expect(healthChanges(healthy, before)).toEqual([]);
    expect(healthChanges(before, healthy)).toEqual([]);
    // The repair job does not ask Twitch for subscriptions that the authorization does not allow.
    const chat = ids("twitch", TWITCH_CHAT_TYPES);
    const later = Date.now() + RECONCILE_INTERVAL_MS;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    fake.calls.length = 0;
    await repairChannelSubscriptions(env, later);
    expect(fake.calls.filter((item) => item.method === "POST" && item.url.hostname === "api.twitch.tv")).toEqual([]);
    expect(types("twitch")).toEqual([...TWITCH_CHAT_TYPES, ...TWITCH_LIVE_TYPES].sort());
    expect(ids("twitch", TWITCH_CHAT_TYPES)).toEqual(chat);
    expect(await flag("twitch")).toBe(0);
    expect(await status("twitch")).toEqual({ status: "active", status_code: null });
    clock.mockRestore();
    // One reconnect: Twitch asks for the three scopes, and the connection reads the support events.
    const again = await reconnect("twitch");
    expect(again.searchParams.get("scope")?.split(" ")).toEqual(SUPPORTED);
    expect(await finish("twitch", again)).toBe("connected");
    expect(await flag("twitch")).toBe(1);
    expect(types("twitch")).toEqual([...TWITCH_CHAT_TYPES, ...TWITCH_SUPPORT_TYPES, ...TWITCH_LIVE_TYPES].sort());
    expect(channelCardState((await views())[0])).toBe("healthy");
  });

  it("keeps chat when Twitch refuses a support subscription, until a reconnect that Twitch accepts", async (): Promise<void> => {
    fake.supportStatus = 403;
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    expect(await connectChannel("twitch")).toBe("support_denied");
    expect(await flag("twitch")).toBe(0);
    expect(await status("twitch")).toEqual({ status: "active", status_code: null });
    expect(types("twitch")).toEqual([...TWITCH_CHAT_TYPES, ...TWITCH_LIVE_TYPES].sort());
    expect(warn).toHaveBeenCalledWith("channel_support_refused", { platform: "twitch" });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/access|refresh|app-token/);
    expect(channelCardState((await views())[0])).toBe("support_missing");
    // The same refusal at a reconnect: chat stays.
    expect(await finish("twitch", await reconnect("twitch"))).toBe("support_denied");
    expect(await flag("twitch")).toBe(0);
    expect(await status("twitch")).toEqual({ status: "active", status_code: null });
    expect(types("twitch")).toEqual([...TWITCH_CHAT_TYPES, ...TWITCH_LIVE_TYPES].sort());
    fake.supportStatus = null;
    expect(await finish("twitch", await reconnect("twitch"))).toBe("connected");
    expect(await flag("twitch")).toBe(1);
    expect(types("twitch")).toEqual([...TWITCH_CHAT_TYPES, ...TWITCH_SUPPORT_TYPES, ...TWITCH_LIVE_TYPES].sort());
  });

  it("keeps chat when Kick refuses the support events, until a reconnect that Kick accepts", async (): Promise<void> => {
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    fake.supportStatus = 401;
    expect(await connectChannel("kick")).toBe("support_denied");
    fake.supportStatus = 403;
    expect(await finish("kick", await reconnect("kick"))).toBe("support_denied");
    expect(await flag("kick")).toBe(0);
    expect(await status("kick")).toEqual({ status: "active", status_code: null });
    expect(types("kick")).toEqual([...KICK_CHAT_EVENTS, ...KICK_LIVE_EVENTS].sort());
    expect(warn.mock.calls.filter((entry: unknown[]) => entry[0] === "channel_support_refused")).toEqual([
      ["channel_support_refused", { platform: "kick" }],
      ["channel_support_refused", { platform: "kick" }],
    ]);
    const view: ChannelView = (await views())[2];
    expect([channelCardState(view), channelHealth(view)]).toEqual(["support_missing", "healthy"]);
    fake.supportStatus = null;
    expect(await finish("kick", await reconnect("kick"))).toBe("connected");
    expect(await flag("kick")).toBe(1);
    expect(types("kick")).toEqual([...KICK_SUPPORT_EVENTS, ...KICK_CHAT_EVENTS, ...KICK_LIVE_EVENTS].sort());
  });

  it("makes the support subscriptions of an old Kick connection at the next check after the migration", async (): Promise<void> => {
    // The channel as it was before this change: connected with the switch off, so only the subscriptions of chat.
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    fake.supportStatus = 403;
    expect(await connectChannel("kick")).toBe("support_denied");
    fake.supportStatus = null;
    const chat = ids("kick", KICK_CHAT_EVENTS);
    expect(types("kick")).toEqual([...KICK_CHAT_EVENTS, ...KICK_LIVE_EVENTS].sort());
    // Migration 0051 writes the row. No request tells the object.
    await env.DB.prepare("UPDATE channel_connections SET support_events=1 WHERE platform='kick'").run();
    const later = Date.now() + RECONCILE_INTERVAL_MS;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await repairChannelSubscriptions(env, later);
    expect(types("kick")).toEqual([...KICK_SUPPORT_EVENTS, ...KICK_CHAT_EVENTS, ...KICK_LIVE_EVENTS].sort());
    // The subscriptions of chat are the same ones: the check never touches them.
    expect(ids("kick", KICK_CHAT_EVENTS)).toEqual(chat);
    expect(await flag("kick")).toBe(1);
    expect(await status("kick")).toEqual({ status: "active", status_code: null });
  });

  it("has no endpoint that turns support events on or off", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    await env.DB.prepare("DELETE FROM moderation_actions").run();
    for (const body of [{ on: false }, { on: true }, {}]) {
      const response = await call("POST", "channels/kick/support", { user: "owner", body });
      expect(response.status).toBe(404);
    }
    expect(await flag("kick")).toBe(1);
    expect(types("kick")).toEqual([...KICK_SUPPORT_EVENTS, ...KICK_CHAT_EVENTS, ...KICK_LIVE_EVENTS].sort());
    expect(await env.DB.prepare("SELECT count(*) AS n FROM verification").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM moderation_actions").first("n")).toBe(0);
  });
});

describe("subscription repair job", (): void => {
  const hour = 3_600_000;

  /** Adds pages with one Twitch connection each. */
  async function addChannels(count: number): Promise<void> {
    const ids = JSON.stringify(Array.from({ length: count }, (_: unknown, index: number): string => String(index).padStart(2, "0")));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id,name,email,email_verified,created_at,updated_at)
          SELECT 'r'||value, 'R', 'r'||value||'@example.test', 1, 1, 1 FROM json_each(?)`,
      ).bind(ids),
      env.DB.prepare(
        `INSERT INTO streamers (id,owner_id,handle,name,about,is_official,status)
          SELECT '41000000-0000-4000-8000-0000000000'||value, 'r'||value, 'repair_'||value, 'R', '', 0, 'active' FROM json_each(?)`,
      ).bind(ids),
      env.DB.prepare(
        `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,status,created_at,updated_at)
          SELECT 'rc'||value, '41000000-0000-4000-8000-0000000000'||value, 'twitch', '9'||value, 'R', '', 'active', 1, 1 FROM json_each(?)`,
      ).bind(ids),
    ]);
  }

  it("checks at most REPAIR_BATCH channels a run, the others the next hour, and goes on after a failing one", async (): Promise<void> => {
    await addChannels(REPAIR_BATCH + 5);
    // Never checked: YouTube, a channel that waits for its owner, a running disconnect and a suspended page.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,status,status_code,created_at,updated_at)
          VALUES ('x1',?1,'youtube','UCx','Y','','active',NULL,1,1), ('x2',?1,'kick','71','K','','needs_reauth','authorization_revoked',1,1),
            ('x3',?2,'twitch','72','T','','needs_reauth','disconnecting',1,1), ('x4',?3,'twitch','73','T','','error','delivery_failed',1,1)`,
      ).bind(page, rivalPage, frozenPage),
      env.DB.prepare("UPDATE streamers SET status='suspended' WHERE id=?").bind(frozenPage),
    ]);
    const calls: URL[] = [];
    env.CHANNEL_INGEST = {
      idFromName: (name: string): string => name,
      get: () => ({
        fetch: (input: string): Promise<Response> => {
          calls.push(new URL(input));
          if (calls.length === 2) return Promise.reject(new TypeError("down"));
          return Promise.resolve(Response.json({ result: calls.length === 3 ? "repaired" : "ok" }));
        },
      }),
    } as unknown as DurableObjectNamespace;
    const error = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    await repairChannelSubscriptions(env, 6 * hour);
    expect(calls).toHaveLength(REPAIR_BATCH);
    expect(new Set(calls.map((url) => `${url.pathname}?${url.searchParams.get("platform")}`))).toEqual(new Set(["/reconcile?twitch"]));
    expect(error.mock.calls.map((call: unknown[]) => call[0])).toEqual(["channel_repair_failed"]);
    // Only counts are logged.
    expect(warn.mock.calls).toEqual([["channel_repair_run", { ok: REPAIR_BATCH - 2, failed: 1, repaired: 1 }]]);
    await repairChannelSubscriptions(env, 7 * hour);
    expect(calls).toHaveLength(REPAIR_BATCH + 5);
    const pages = new Set(calls.map((url) => url.searchParams.get("streamerId")));
    expect(pages.size).toBe(REPAIR_BATCH + 5);
    expect([...pages].every((id) => id?.startsWith("41000000-"))).toBe(true);
    env.CHANNELS_OFF = "1";
    await repairChannelSubscriptions(env, 8 * hour);
    expect(calls).toHaveLength(REPAIR_BATCH + 5);
  });

  it("makes a missing support subscription again, and deletes the support subscriptions of a connection that does not read them", async (): Promise<void> => {
    expect(await connectChannel("kick")).toBe("connected");
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    expect(fake.subscriptions).toHaveLength(8);
    const gone = fake.subscriptions.findIndex((item) => item.type === "kicks.gifted");
    fake.subscriptions.splice(gone, 1);
    let later = Date.now() + RECONCILE_INTERVAL_MS;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    await repairChannelSubscriptions(env, later);
    expect(fake.subscriptions.filter((item) => item.type === "kicks.gifted")).toHaveLength(1);
    expect(fake.subscriptions).toHaveLength(8);
    // The connection lost its support events without the object (a refusal that another check found): the next check cleans up.
    await env.DB.prepare("UPDATE channel_connections SET support_events=0").run();
    later += RECONCILE_INTERVAL_MS;
    clock.mockReturnValue(later);
    await repairChannelSubscriptions(env, later);
    expect(fake.subscriptions.map((item) => item.type).sort()).toEqual(["chat.message.sent", "livestream.status.updated", "moderation.banned"]);
    expect(await ingestState().storage.get("subs:kick")).toEqual(fake.subscriptions.map((item) => item.id));
    expect(await env.DB.prepare("SELECT status, status_code FROM channel_connections").first()).toEqual({
      status: "active",
      status_code: null,
    });
  });

  it("creates a revoked subscription again through the page's ingest object", async (): Promise<void> => {
    expect(await connectChannel("twitch")).toBe("connected");
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const revoked = fake.subscriptions[0];
    revoked.status = "notification_failures_exceeded";
    await env.DB.prepare("UPDATE channel_connections SET status='error', status_code='delivery_failed'").run();
    // The connect made every subscription: inside the interval the job leaves the channel alone.
    await repairChannelSubscriptions(env, Date.now());
    expect(fake.subscriptions).toContain(revoked);
    const later = Date.now() + RECONCILE_INTERVAL_MS;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await repairChannelSubscriptions(env, later);
    expect(fake.subscriptions).not.toContain(revoked);
    expect(fake.subscriptions.filter((item) => item.type === revoked.type && item.status === undefined)).toHaveLength(1);
    expect(await env.DB.prepare("SELECT status, status_code FROM channel_connections").first()).toEqual({
      status: "active",
      status_code: null,
    });
  });
});
