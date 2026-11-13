import { vi } from "vitest";

/**
 * Stands in for the Twitch, Google and Kick endpoints the channel code calls (app/server/channel-providers.server.ts).
 * Each response follows the documented shape. Tests change `fake` to make a provider refuse or fail.
 */

export interface ProviderCall {
  method: string;
  url: URL;
  body: string;
  headers: Headers;
}

export interface FakeProviders {
  calls: ProviderCall[];
  /** Status for every token request (code exchange and refresh). */
  tokenStatus: number;
  /** Status for refresh requests only, when set. */
  refreshStatus: number | null;
  /** Each refresh returns a new refresh token (`<platform>-refresh-<n>`). */
  refreshes: number;
  revokeStatus: number;
  subscribeStatus: number;
  identity: Record<"twitch" | "youtube" | "kick", { id: string; name: string }>;
  /** Scopes the provider says it granted; null grants all requested ones. */
  grantedScopes: string[] | null;
  /** Seconds an access token lives. */
  expiresIn: number;
  liveChatId: string | null;
  /** Pages liveChat/messages returns in order; the last one repeats. */
  chatPages: { items: unknown[]; nextPageToken?: string; pollingIntervalMillis?: number; offlineAt?: string }[];
  /** Error reason for liveChat/messages, with status 403. */
  chatError: string | null;
  kickPublicKey: string | null;
  /** Fails the next matching request with a network error. */
  failNetwork: RegExp | null;
  /** The webhook subscriptions the providers hold: created, listed and deleted like the real APIs. */
  subscriptions: { platform: "twitch" | "kick"; id: string; broadcaster: string; callback: string; type?: string }[];
  /** Status for listing subscriptions, when set. */
  listStatus: number | null;
  /** The next this many list requests fail with 500. */
  listFailures: number;
  /** Status for deleting subscriptions, when set. */
  deleteStatus: number | null;
  /** Runs while a refresh request is in flight, before the provider answers (to simulate a second writer). */
  duringRefresh: (() => Promise<void>) | null;
}

export const TWITCH_SCOPES = [
  "user:read:chat",
  "user:bot",
  "channel:bot",
  "moderator:read:blocked_terms",
  "moderator:read:chat_settings",
  "moderator:read:unban_requests",
  "moderator:read:banned_users",
  "moderator:read:chat_messages",
  "moderator:read:warnings",
  "moderator:read:moderators",
  "moderator:read:vips",
];

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function platformOfToken(url: URL): "twitch" | "youtube" | "kick" {
  if (url.hostname === "id.twitch.tv") return "twitch";
  if (url.hostname === "oauth2.googleapis.com") return "youtube";
  return "kick";
}

/** Installs the fake as `fetch`. Undo with vi.unstubAllGlobals(). */
export function installFakeProviders(): FakeProviders {
  const fake: FakeProviders = {
    calls: [],
    tokenStatus: 200,
    refreshStatus: null,
    refreshes: 0,
    revokeStatus: 200,
    subscribeStatus: 202,
    identity: {
      twitch: { id: "111", name: "TwitchHost" },
      youtube: { id: "UCchannel1", name: "Tube Host" },
      kick: { id: "333", name: "KickHost" },
    },
    grantedScopes: null,
    expiresIn: 3600,
    liveChatId: "chat-1",
    chatPages: [{ items: [], nextPageToken: "p1", pollingIntervalMillis: 1000 }],
    chatError: null,
    kickPublicKey: null,
    failNetwork: null,
    duringRefresh: null,
    subscriptions: [],
    listStatus: null,
    listFailures: 0,
    deleteStatus: null,
  };
  let subscription = 0;
  let page = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    fake.calls.push({ method: request.method, url, body, headers: request.headers });
    if (fake.failNetwork?.test(url.toString())) {
      fake.failNetwork = null;
      throw new TypeError("fetch failed");
    }
    const form = new URLSearchParams(body);
    const path = `${url.hostname}${url.pathname}`;
    if (path === "id.twitch.tv/oauth2/token" || path === "oauth2.googleapis.com/token" || path === "id.kick.com/oauth/token") {
      const platform = platformOfToken(url);
      if (form.get("grant_type") === "client_credentials") return json({ access_token: "twitch-app-token", expires_in: 1000 });
      const refreshing = form.get("grant_type") === "refresh_token";
      const status = refreshing ? (fake.refreshStatus ?? fake.tokenStatus) : fake.tokenStatus;
      // The hook runs while the refresh is in flight, whether the provider then accepts or refuses it.
      if (refreshing) await fake.duringRefresh?.();
      if (status !== 200) return json({ error: "invalid_grant" }, status);
      if (refreshing) fake.refreshes += 1;
      const requested: Record<typeof platform, string[]> = {
        twitch: TWITCH_SCOPES,
        youtube: ["https://www.googleapis.com/auth/youtube.readonly"],
        kick: ["user:read", "channel:read", "events:subscribe"],
      };
      const scopes = fake.grantedScopes ?? requested[platform];
      return json({
        access_token: refreshing ? `${platform}-access-${fake.refreshes}` : `${platform}-access`,
        refresh_token: refreshing ? `${platform}-refresh-${fake.refreshes}` : `${platform}-refresh`,
        expires_in: fake.expiresIn,
        token_type: "bearer",
        scope: platform === "twitch" ? scopes : scopes.join(" "),
      });
    }
    if (path === "api.twitch.tv/helix/users")
      return json({ data: [{ id: fake.identity.twitch.id, login: "twitchhost", display_name: fake.identity.twitch.name }] });
    if (path === "www.googleapis.com/youtube/v3/channels")
      return json({ items: [{ id: fake.identity.youtube.id, snippet: { title: fake.identity.youtube.name } }] });
    if (path === "api.kick.com/public/v1/users")
      return json({ data: [{ user_id: Number(fake.identity.kick.id), name: fake.identity.kick.name, email: "x@kick.test" }] });
    if (path === "api.twitch.tv/helix/eventsub/subscriptions" || path === "api.kick.com/public/v1/events/subscriptions") {
      const platform = url.hostname === "api.twitch.tv" ? "twitch" : "kick";
      if (request.method === "DELETE") {
        if (fake.deleteStatus !== null) return json({ error: "nope" }, fake.deleteStatus);
        const index = fake.subscriptions.findIndex((item) => item.id === url.searchParams.get("id"));
        if (index < 0) return json({ error: "not found" }, 404);
        fake.subscriptions.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        if (fake.listStatus !== null) return json({ error: "nope" }, fake.listStatus);
        if (fake.listFailures > 0) {
          fake.listFailures -= 1;
          return json({ error: "nope" }, 500);
        }
        const broadcaster = url.searchParams.get(platform === "twitch" ? "user_id" : "broadcaster_user_id");
        const mine = fake.subscriptions.filter((item) => item.platform === platform && item.broadcaster === broadcaster);
        if (platform === "kick")
          return json({
            data: mine.map((item) => ({
              id: item.id,
              broadcaster_user_id: Number(item.broadcaster),
              method: "webhook",
              event: item.type ?? "chat.message.sent",
              version: 1,
            })),
          });
        return json({
          data: mine.map((item) => ({
            id: item.id,
            type: item.type ?? "channel.chat.message",
            condition: { broadcaster_user_id: item.broadcaster, user_id: item.broadcaster },
            transport: { method: "webhook", callback: item.callback },
          })),
          pagination: {},
        });
      }
      if (fake.subscribeStatus >= 400) return json({ error: "nope" }, fake.subscribeStatus);
      if (platform === "twitch") {
        const sub = JSON.parse(body) as {
          type: string;
          condition: { broadcaster_user_id: string };
          transport: { callback: string };
        };
        // Twitch refuses a second subscription of a type for the same condition, whatever its callback.
        if (fake.subscriptions.some((item) => item.platform === "twitch" && item.type === sub.type && item.broadcaster === sub.condition.broadcaster_user_id))
          return json({ error: "Conflict" }, 409);
        subscription += 1;
        const id = `twitch-sub-${subscription}`;
        fake.subscriptions.push({
          platform,
          id,
          broadcaster: sub.condition.broadcaster_user_id,
          callback: sub.transport.callback,
          type: sub.type,
        });
        return json({ data: [{ id, status: "webhook_callback_verification_pending" }] }, 202);
      }
      const request_ = JSON.parse(body) as { broadcaster_user_id: number; events: { name: string }[] };
      const data = request_.events.map((event) => {
        subscription += 1;
        const id = `kick-sub-${subscription}`;
        fake.subscriptions.push({ platform, id, broadcaster: String(request_.broadcaster_user_id), callback: "", type: event.name });
        return { name: event.name, version: 1, subscription_id: id };
      });
      return json({ data });
    }
    if (path === "id.twitch.tv/oauth2/revoke" || path === "oauth2.googleapis.com/revoke" || path === "id.kick.com/oauth/revoke")
      return new Response(null, { status: fake.revokeStatus });
    if (path === "www.googleapis.com/youtube/v3/liveBroadcasts")
      return json({ items: fake.liveChatId ? [{ snippet: { liveChatId: fake.liveChatId } }] : [] });
    if (path === "www.googleapis.com/youtube/v3/liveChat/messages") {
      if (fake.chatError) return json({ error: { errors: [{ reason: fake.chatError }] } }, 403);
      const result = fake.chatPages[Math.min(page, fake.chatPages.length - 1)];
      page += 1;
      return json(result);
    }
    if (path === "api.kick.com/public/v1/public-key")
      return fake.kickPublicKey ? json({ data: { public_key: fake.kickPublicKey } }) : json({ message: "down" }, 503);
    return json({ error: `unexpected ${request.method} ${path}` }, 599);
  });
  return fake;
}

/** A YouTube text message as liveChatMessages.list returns it. */
export function youtubeText(
  id: string,
  author: string,
  text: string,
  flags: Record<string, boolean> = {},
  publishedAt = "2026-11-12T10:00:00Z",
): unknown {
  return {
    id,
    snippet: {
      type: "textMessageEvent",
      publishedAt,
      displayMessage: text,
      textMessageDetails: { messageText: text },
    },
    authorDetails: { channelId: author, displayName: `Name ${author}`, ...flags },
  };
}
