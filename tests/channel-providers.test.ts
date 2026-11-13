import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import {
  ProviderError,
  ReauthRequired,
  channelIdentity,
  configuredPlatform,
  exchangeCode,
  listSubscriptions,
  refreshTokens,
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
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init));
    const next = responses[Math.min(requests.length - 1, responses.length - 1)];
    return next();
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
    expect(await subscribe(env, "youtube", "UC", "t", "https://app.test", [])).toEqual({ conflicts: [] });
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
    expect(await listSubscriptions(env, "twitch", "111", null, origin)).toEqual([{ id: "mine", type: "channel.chat.message" }]);
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
    expect(await listSubscriptions(env, "kick", "333", "t", origin)).toEqual([{ id: "k1", type: "chat.message.sent" }]);
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
