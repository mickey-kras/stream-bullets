import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import {
  PROVIDERS,
  ProviderError,
  ReauthRequired,
  SUPPORT_SCOPES,
  authorizationUrl,
  channelIdentity,
  configuredPlatform,
  exchangeCode,
  listSubscriptions,
  refreshTokens,
  requiredSubscriptions,
  revokeToken,
  subscribe,
  unsubscribe,
  youtubeChatPage,
  youtubeLiveChat,
} from "../app/server/channel-providers.server";

/** Provider answers the happy-path tests do not reach: odd bodies, refusals, conflicts and network errors. */

const env = {
  TWITCH_CLIENT_ID: "twitch-client",
  TWITCH_CLIENT_SECRET: "twitch-secret",
  TWITCH_EVENTSUB_SECRET: "eventsub-secret-0123456789abcdef0123",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  KICK_CLIENT_ID: "kick-client",
  KICK_CLIENT_SECRET: "kick-secret",
} as AppEnv;

/** Answers every request with the next response in the list (the last one repeats) and records the requests. */
function answers(...responses: (() => Response)[]): Request[] {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", (input: string, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init));
    const next = responses[Math.min(requests.length - 1, responses.length - 1)];
    return Promise.resolve(next());
  });
  return requests;
}

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe("channel provider clients", (): void => {
  it("needs both client values, and for Twitch an EventSub secret of 32 to 100 printable characters", (): void => {
    expect(configuredPlatform(env, "twitch")).toBe(true);
    expect(configuredPlatform({ ...env, TWITCH_EVENTSUB_SECRET: undefined }, "twitch")).toBe(false);
    expect(configuredPlatform({ ...env, TWITCH_EVENTSUB_SECRET: "x".repeat(101) }, "twitch")).toBe(false);
    expect(configuredPlatform({ ...env, GOOGLE_CLIENT_SECRET: undefined }, "youtube")).toBe(false);
  });

  it("keeps the old refresh token when a refresh returns none, and rejects malformed token bodies", async (): Promise<void> => {
    answers(() => Response.json({ access_token: "a2" }));
    expect(await refreshTokens(env, "youtube", "r1", 5)).toEqual({ accessToken: "a2", refreshToken: "r1", expiresAt: null });
    answers(() => Response.json({ token: "x" }));
    await expect(exchangeCode(env, "kick", { code: "c", redirectUri: "r", codeVerifier: "v" })).rejects.toBeInstanceOf(ProviderError);
    answers(() => new Response("oops", { status: 200 }));
    await expect(refreshTokens(env, "kick", "r")).rejects.toBeInstanceOf(ProviderError);
    answers(() => new Response(null, { status: 401 }));
    await expect(refreshTokens(env, "kick", "r")).rejects.toBeInstanceOf(ReauthRequired);
  });

  it("revokes the refresh token where there is one, else the access token, and never throws", async (): Promise<void> => {
    let requests = answers(() => new Response(null, { status: 200 }));
    expect(await revokeToken(env, "kick", { accessToken: "a", refreshToken: null, expiresAt: null })).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(await requests[0].text()))).toEqual({ token: "a", token_hint_type: "access_token" });
    requests = answers(() => new Response(null, { status: 200 }));
    await revokeToken(env, "youtube", { accessToken: "a", refreshToken: null, expiresAt: null });
    expect(new URLSearchParams(await requests[0].text()).get("token")).toBe("a");
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("down")));
    expect(await revokeToken(env, "twitch", { accessToken: "a", refreshToken: "r", expiresAt: null })).toBe(false);
  });

  it("reads identities strictly and maps refusals and API errors", async (): Promise<void> => {
    answers(() => Response.json({ data: [] }));
    await expect(channelIdentity(env, "kick", "t")).rejects.toThrow();
    answers(() => new Response(null, { status: 401 }));
    await expect(channelIdentity(env, "twitch", "t")).rejects.toBeInstanceOf(ReauthRequired);
    answers(() => Response.json({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 }));
    await expect(channelIdentity(env, "youtube", "t")).rejects.toMatchObject({ status: 403, reason: "quotaExceeded" });
    answers(() => new Response("bad gateway", { status: 502 }));
    await expect(youtubeLiveChat("t")).rejects.toMatchObject({ status: 502, reason: null });
  });

  it("reports a Twitch conflict and maps subscription refusals, keeping the ids created so far", async (): Promise<void> => {
    answers(
      () => Response.json({ access_token: "app" }),
      () => Response.json({ error: "Conflict" }, { status: 409 }),
    );
    const none: string[] = [];
    expect(await subscribe(env, "twitch", "111", "user-token", "https://app.test", none)).toEqual({
      conflicts: [
        "channel.chat.message",
        "channel.chat.message_delete",
        "channel.chat.clear",
        "channel.chat.clear_user_messages",
        "channel.moderate",
      ],
      refused: false,
    });
    expect(none).toEqual([]);
    answers(
      () => Response.json({ access_token: "app" }),
      () => new Response(null, { status: 403 }),
    );
    await expect(subscribe(env, "twitch", "111", "t", "https://app.test", [])).rejects.toBeInstanceOf(ReauthRequired);
    answers(
      () => Response.json({ access_token: "app" }),
      () => Response.json({ data: [{ id: "first" }] }, { status: 202 }),
      () => new Response(null, { status: 500 }),
    );
    const partial: string[] = [];
    await expect(subscribe(env, "twitch", "111", "t", "https://app.test", partial)).rejects.toBeInstanceOf(ProviderError);
    expect(partial).toEqual(["first"]);
    answers(() => new Response(null, { status: 500 }));
    await expect(subscribe(env, "twitch", "111", "t", "https://app.test", [])).rejects.toBeInstanceOf(ProviderError);
    const kick: string[] = [];
    answers(() => Response.json({ data: [{ subscription_id: "k1" }, { subscription_id: null, error: "not allowed" }] }));
    await expect(subscribe(env, "kick", "333", "t", "https://app.test", kick)).rejects.toBeInstanceOf(ProviderError);
    expect(kick).toEqual(["k1"]);
    answers(() => new Response(null, { status: 401 }));
    await expect(subscribe(env, "kick", "333", "t", "https://app.test", [])).rejects.toBeInstanceOf(ReauthRequired);
    answers(() => new Response(null, { status: 500 }));
    await expect(subscribe(env, "kick", "333", "t", "https://app.test", [])).rejects.toBeInstanceOf(ProviderError);
    expect(await subscribe(env, "youtube", "UC", "t", "https://app.test", [])).toEqual({ conflicts: [], refused: false });
  });

  it("asks for the support scopes only when support is wanted", (): void => {
    const input = { state: "s", redirectUri: "https://app.test/cb", codeChallenge: "c" };
    const scopes = (platform: "twitch" | "youtube" | "kick", support: boolean): string[] =>
      new URL(authorizationUrl(env, platform, { ...input, support })).searchParams.get("scope")?.split(" ") ?? [];
    expect(SUPPORT_SCOPES).toEqual({
      twitch: ["moderator:read:followers", "channel:read:subscriptions", "bits:read"],
      youtube: [],
      kick: [],
    });
    for (const platform of ["twitch", "youtube", "kick"] as const) {
      expect(scopes(platform, false)).toEqual(PROVIDERS[platform].scopes);
      expect(scopes(platform, true)).toEqual([...PROVIDERS[platform].scopes, ...SUPPORT_SCOPES[platform]]);
    }
    // Only read scopes: support events never give a right to change the channel.
    expect(scopes("twitch", true).join(" ")).not.toMatch(/manage|edit|write/);
  });

  it("makes the support subscriptions after the chat ones, each with its version and condition", async (): Promise<void> => {
    let made = 0;
    const requests = answers(
      () => Response.json({ access_token: "app" }),
      () => Response.json({ data: [{ id: `s${++made}` }] }, { status: 202 }),
    );
    const created: string[] = [];
    expect(await subscribe(env, "twitch", "111", null, "https://app.test", created, { only: null, support: true })).toEqual({
      conflicts: [],
      refused: false,
    });
    const bodies = await Promise.all(requests.slice(1).map((request) => request.json<Record<string, unknown>>()));
    expect(bodies.map((body) => [body.type, body.version, body.condition])).toEqual([
      ["channel.chat.message", "1", { broadcaster_user_id: "111", user_id: "111" }],
      ["channel.chat.message_delete", "1", { broadcaster_user_id: "111", user_id: "111" }],
      ["channel.chat.clear", "1", { broadcaster_user_id: "111", user_id: "111" }],
      ["channel.chat.clear_user_messages", "1", { broadcaster_user_id: "111", user_id: "111" }],
      ["channel.moderate", "2", { broadcaster_user_id: "111", moderator_user_id: "111" }],
      ["channel.follow", "2", { broadcaster_user_id: "111", moderator_user_id: "111" }],
      ["channel.subscribe", "1", { broadcaster_user_id: "111" }],
      ["channel.subscription.gift", "1", { broadcaster_user_id: "111" }],
      ["channel.subscription.message", "1", { broadcaster_user_id: "111" }],
      ["channel.cheer", "1", { broadcaster_user_id: "111" }],
      ["channel.raid", "1", { to_broadcaster_user_id: "111" }],
    ]);
    // A cheer also sends `channel.bits.use`: the feed never subscribes to it, so Bits count one time.
    expect(requiredSubscriptions("twitch", true)).not.toContain("channel.bits.use");
    expect(created).toHaveLength(11);
    expect(requiredSubscriptions("twitch", true)).toEqual(bodies.map((body) => body.type));
    expect(requiredSubscriptions("kick", true)).toEqual([
      "chat.message.sent",
      "moderation.banned",
      "channel.followed",
      "channel.subscription.new",
      "channel.subscription.renewal",
      "channel.subscription.gifts",
      "kicks.gifted",
    ]);
    expect(requiredSubscriptions("youtube", true)).toEqual([]);
  });

  it("keeps the chat subscriptions when Twitch refuses a support type, and asks for no further support type", async (): Promise<void> => {
    let made = 0;
    const requests = answers(
      () => Response.json({ access_token: "app" }),
      ...Array.from({ length: 6 }, () => (): Response => Response.json({ data: [{ id: `s${++made}` }] }, { status: 202 })),
      () => new Response(null, { status: 403 }),
    );
    const created: string[] = [];
    const result = await subscribe(env, "twitch", "111", null, "https://app.test", created, { only: null, support: true });
    expect(result).toEqual({ conflicts: [], refused: true });
    // The five chat types and the follow type exist; the refused type ended the support types.
    expect(created).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(requests).toHaveLength(8);
    expect(await requests[7].json()).toMatchObject({ type: "channel.subscribe" });
    // The same answer for a chat type still needs a new authorization.
    answers(
      () => Response.json({ access_token: "app" }),
      () => new Response(null, { status: 403 }),
    );
    const scope = { only: null, support: true };
    await expect(subscribe(env, "twitch", "111", null, "https://app.test", [], scope)).rejects.toBeInstanceOf(ReauthRequired);
  });

  it("asks Kick for the chat events first, and takes a refusal of the support events without an error", async (): Promise<void> => {
    const scope = { only: null, support: true };
    for (const refusal of [401, 403]) {
      const requests = answers(
        () => Response.json({ data: [{ subscription_id: "k1" }, { subscription_id: "k2" }] }),
        () => new Response(null, { status: refusal }),
      );
      const created: string[] = [];
      expect(await subscribe(env, "kick", "333", "t", "https://app.test", created, scope)).toEqual({ conflicts: [], refused: true });
      expect(created).toEqual(["k1", "k2"]);
      expect(await requests[0].json()).toMatchObject({ events: [{ name: "chat.message.sent" }, { name: "moderation.banned" }] });
      expect((await requests[1].json<{ events: { name: string }[] }>()).events.map((event) => event.name)).toEqual([
        "channel.followed",
        "channel.subscription.new",
        "channel.subscription.renewal",
        "channel.subscription.gifts",
        "kicks.gifted",
      ]);
    }
    // An event without a subscription id is a refusal too; the ids that Kick made stay known.
    answers(
      () => Response.json({ data: [{ subscription_id: "k1" }, { subscription_id: "k2" }] }),
      () => Response.json({ data: [{ subscription_id: "k3" }, { subscription_id: null, error: "not allowed" }] }),
    );
    const partial: string[] = [];
    expect(await subscribe(env, "kick", "333", "t", "https://app.test", partial, scope)).toEqual({ conflicts: [], refused: true });
    expect(partial).toEqual(["k1", "k2", "k3"]);
    // An outage is no refusal: the repair tries again, and the support events stay on.
    answers(
      () => Response.json({ data: [{ subscription_id: "k1" }, { subscription_id: "k2" }] }),
      () => new Response(null, { status: 500 }),
    );
    await expect(subscribe(env, "kick", "333", "t", "https://app.test", [], scope)).rejects.toBeInstanceOf(ProviderError);
    // A refusal of the chat events still needs a new authorization, and no support event is asked for.
    const refused = answers(() => new Response(null, { status: 403 }));
    await expect(subscribe(env, "kick", "333", "t", "https://app.test", [], scope)).rejects.toBeInstanceOf(ReauthRequired);
    expect(refused).toHaveLength(1);
    // A repair that misses only support events asks for those alone.
    const repair = answers(() => Response.json({ data: [{ subscription_id: "k9" }] }));
    await subscribe(env, "kick", "333", "t", "https://app.test", [], { only: ["kicks.gifted"], support: true });
    expect(repair).toHaveLength(1);
    expect(await repair[0].json()).toMatchObject({ events: [{ name: "kicks.gifted", version: 1 }] });
  });

  it("returns the ids it could not delete", async (): Promise<void> => {
    expect(await unsubscribe(env, "kick", [], null)).toEqual([]);
    expect(await unsubscribe(env, "kick", ["a"], null)).toEqual(["a"]);
    let requests = answers(() => new Response(null, { status: 404 }));
    expect(await unsubscribe(env, "kick", ["a"], "t")).toEqual([]);
    expect(requests[0].headers.get("Authorization")).toBe("Bearer t");
    requests = answers(
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 204 }),
    );
    expect(await unsubscribe(env, "kick", ["a", "b"], "t")).toEqual(["a"]);
    expect(requests).toHaveLength(2);
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("down")));
    expect(await unsubscribe(env, "kick", ["a"], "t")).toEqual(["a"]);
    expect(await unsubscribe(env, "twitch", ["a"], null)).toEqual(["a"]);
  });

  it("lists the raid subscription of the channel, which names it as the channel that gets the raid", async (): Promise<void> => {
    const origin = "https://app.test";
    const raid = (id: string, condition: Record<string, string>): unknown => ({
      id,
      type: "channel.raid",
      status: "enabled",
      condition,
      transport: { method: "webhook", callback: `${origin}/hooks/twitch` },
    });
    answers(
      () => Response.json({ access_token: "app" }),
      () =>
        Response.json({
          data: [
            raid("to-me", { from_broadcaster_user_id: "", to_broadcaster_user_id: "111" }),
            raid("to-other", { from_broadcaster_user_id: "", to_broadcaster_user_id: "999" }),
            raid("from-me", { from_broadcaster_user_id: "111", to_broadcaster_user_id: "" }),
          ],
          pagination: {},
        }),
    );
    expect(await listSubscriptions(env, "twitch", "111", null, origin)).toEqual([{ id: "to-me", type: "channel.raid", health: "enabled" }]);
  });

  it("lists only this app's webhook subscriptions for the channel and callback", async (): Promise<void> => {
    const origin = "https://app.test";
    const item = (id: string, broadcaster: string, callback: string, method = "webhook"): unknown => ({
      id,
      type: "channel.chat.message",
      condition: { broadcaster_user_id: broadcaster, user_id: broadcaster },
      transport: { method, callback },
    });
    const requests = answers(
      () => Response.json({ access_token: "app" }),
      () =>
        Response.json({
          data: [item("mine", "111", `${origin}/hooks/twitch`), item("other-deploy", "111", "https://other.test/hooks/twitch")],
          pagination: { cursor: "next" },
        }),
      () =>
        Response.json({
          data: [item("raid", "999", `${origin}/hooks/twitch`), item("socket", "111", `${origin}/hooks/twitch`, "websocket")],
          pagination: {},
        }),
    );
    expect(await listSubscriptions(env, "twitch", "111", null, origin)).toEqual([{ id: "mine", type: "channel.chat.message", health: "enabled" }]);
    expect(new URL(requests[1].url).searchParams.get("user_id")).toBe("111");
    expect(new URL(requests[2].url).searchParams.get("after")).toBe("next");
    answers(() =>
      Response.json({
        data: [
          { id: "k1", broadcaster_user_id: 333, method: "webhook", event: "chat.message.sent" },
          { id: "k2", broadcaster_user_id: 444, method: "webhook", event: "chat.message.sent" },
        ],
      }),
    );
    expect(await listSubscriptions(env, "kick", "333", "t", origin)).toEqual([{ id: "k1", type: "chat.message.sent", health: "enabled" }]);
    expect(await listSubscriptions(env, "kick", "333", null, origin)).toBeNull();
    answers(() => new Response(null, { status: 500 }));
    expect(await listSubscriptions(env, "kick", "333", "t", origin)).toBeNull();
    answers(
      () => Response.json({ access_token: "app" }),
      () => new Response(null, { status: 500 }),
    );
    expect(await listSubscriptions(env, "twitch", "111", null, origin)).toBeNull();
    answers(() => Response.json({ bad: true }));
    expect(await listSubscriptions(env, "kick", "333", "t", origin)).toBeNull();
    expect(await listSubscriptions(env, "youtube", "UC", null, origin)).toEqual([]);
  });

  it("reads the health of each Twitch subscription and creates only the named types", async (): Promise<void> => {
    const origin = "https://app.test";
    const item = (id: string, status?: string): unknown => ({
      id,
      type: "channel.chat.message",
      ...(status ? { status } : {}),
      condition: { broadcaster_user_id: "111", user_id: "111" },
      transport: { method: "webhook", callback: `${origin}/hooks/twitch` },
    });
    answers(
      () => Response.json({ access_token: "app" }),
      () =>
        Response.json({
          data: [
            item("on", "enabled"),
            item("pending", "webhook_callback_verification_pending"),
            item("failed", "webhook_callback_verification_failed"),
            item("revoked", "notification_failures_exceeded"),
            item("new-status", "something_new"),
            item("no-status"),
          ],
        }),
    );
    expect((await listSubscriptions(env, "twitch", "111", null, origin))?.map((entry) => [entry.id, entry.health])).toEqual([
      ["on", "enabled"],
      ["pending", "pending"],
      ["failed", "unhealthy"],
      ["revoked", "unhealthy"],
      ["new-status", "unhealthy"],
      // A list without the documented status proves no failure.
      ["no-status", "enabled"],
    ]);
    expect(requiredSubscriptions("twitch", false)).toEqual([
      "channel.chat.message",
      "channel.chat.message_delete",
      "channel.chat.clear",
      "channel.chat.clear_user_messages",
      "channel.moderate",
    ]);
    expect(requiredSubscriptions("kick", false)).toEqual(["chat.message.sent", "moderation.banned"]);
    expect(requiredSubscriptions("youtube", false)).toEqual([]);
    let requests = answers(
      () => Response.json({ access_token: "app" }),
      () => Response.json({ data: [{ id: "made" }] }, { status: 202 }),
    );
    const created: string[] = [];
    // Twitch needs no user token: the app token creates the webhook subscription.
    await subscribe(env, "twitch", "111", null, origin, created, { only: ["channel.moderate"], support: false });
    expect(created).toEqual(["made"]);
    expect(requests).toHaveLength(2);
    expect(await requests[1].json()).toMatchObject({ type: "channel.moderate", version: "2" });
    expect(requests[1].headers.get("Authorization")).toBe("Bearer app");
    requests = answers(() => Response.json({ data: [{ subscription_id: "k2" }] }));
    await subscribe(env, "kick", "333", "t", origin, [], { only: ["moderation.banned"], support: false });
    expect(await requests[0].json()).toMatchObject({ events: [{ name: "moderation.banned", version: 1 }] });
    // Kick subscribes only with the broadcaster's token.
    await expect(subscribe(env, "kick", "333", null, origin, [])).rejects.toBeInstanceOf(ReauthRequired);
    // A refused app token is not the owner's to repair: no reconnect is asked for.
    answers(
      () => Response.json({ access_token: "app" }),
      () => new Response(null, { status: 401 }),
    );
    await expect(subscribe(env, "twitch", "111", null, origin, [])).rejects.toBeInstanceOf(ProviderError);
  });

  it("skips malformed live chat items and fills the documented defaults", async (): Promise<void> => {
    const requests = answers(() => Response.json({ items: [{ id: "x" }, { id: "y", snippet: { type: "textMessageEvent" } }] }));
    expect(await youtubeChatPage("t", "chat", null)).toEqual({
      items: [{ id: "y", snippet: { type: "textMessageEvent" } }],
      nextPageToken: null,
      pollingIntervalMillis: 5000,
      offline: false,
    });
    expect(new URL(requests[0].url).searchParams.get("part")).toBe("id,snippet,authorDetails");
  });
});
