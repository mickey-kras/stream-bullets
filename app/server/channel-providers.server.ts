import { z } from "zod";
import type { AppEnv } from "../env";
import type { ActivityPlatform } from "../lib/activity";
import type { ChannelTokens } from "./channel-tokens.server";
import { HttpError } from "./http.server";

/**
 * The official OAuth and API calls for channel connections. Endpoints, scopes and fields follow each provider's
 * documentation as listed in docs/channel-connections.md. Error messages and logs never include provider bodies:
 * they can quote tokens or codes.
 */

/** The provider refused the token or the refresh token: the owner must connect the channel again. */
export class ReauthRequired extends Error {}

/** The provider answered with a failure that is not about the token (rate limit, quota, outage). */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null = null,
  ) {
    super(`Provider request failed (${status})`);
  }
}

interface Provider {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  /** Twitch does not document PKCE for the authorization code flow; Google and Kick accept S256. */
  pkce: boolean;
  /** Extra authorization parameters. */
  extra: Readonly<Record<string, string>>;
}

export const PROVIDERS: Readonly<Record<ActivityPlatform, Provider>> = {
  twitch: {
    authorizeUrl: "https://id.twitch.tv/oauth2/authorize",
    tokenUrl: "https://id.twitch.tv/oauth2/token",
    // Read-only chat access for EventSub with an app token (channel.chat.*), and the read-only moderator scopes
    // that channel.moderate v2 requires. No chat posting and no moderation writes.
    scopes: [
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
    ],
    pkce: false,
    extra: { force_verify: "true" },
  },
  youtube: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
    pkce: true,
    // No include_granted_scopes: the channel token carries only the YouTube scope, never the sign-in scopes.
    extra: { access_type: "offline", prompt: "consent" },
  },
  kick: {
    authorizeUrl: "https://id.kick.com/oauth/authorize",
    tokenUrl: "https://id.kick.com/oauth/token",
    scopes: ["user:read", "channel:read", "events:subscribe"],
    pkce: true,
    extra: {},
  },
};

/** The OAuth client of a platform. The YouTube connection uses the Google sign-in client with its own redirect. */
export function providerClient(env: AppEnv, platform: ActivityPlatform): { id: string; secret: string } {
  const pairs: Record<ActivityPlatform, [string | undefined, string | undefined]> = {
    twitch: [env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET],
    youtube: [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET],
    kick: [env.KICK_CLIENT_ID, env.KICK_CLIENT_SECRET],
  };
  const [id, secret] = pairs[platform];
  const twitchSecret = env.TWITCH_EVENTSUB_SECRET ?? "";
  if (!id || !secret || (platform === "twitch" && !/^[\x21-\x7e]{32,100}$/.test(twitchSecret)))
    throw new HttpError(503, "This platform is not configured.", "platform_unavailable");
  return { id, secret };
}

export function configuredPlatform(env: AppEnv, platform: ActivityPlatform): boolean {
  try {
    providerClient(env, platform);
    return true;
  } catch {
    return false;
  }
}

export function authorizationUrl(
  env: AppEnv,
  platform: ActivityPlatform,
  input: { state: string; redirectUri: string; codeChallenge: string },
): string {
  const provider = PROVIDERS[platform];
  const url = new URL(provider.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: providerClient(env, platform).id,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: provider.scopes.join(" "),
    state: input.state,
    ...(provider.pkce ? { code_challenge: input.codeChallenge, code_challenge_method: "S256" } : {}),
    ...provider.extra,
  }).toString();
  return url.toString();
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096).optional(),
  expires_in: z.number().nonnegative().optional(),
  // Twitch sends an array; Google and Kick a space-separated string.
  scope: z.union([z.array(z.string()), z.string()]).optional(),
});

async function postForm(url: string, body: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
  });
}

async function tokenRequest(
  platform: ActivityPlatform,
  body: Record<string, string>,
  previousRefresh: string | null,
  now: number,
): Promise<ChannelTokens & { scopes: string[] }> {
  const response = await postForm(PROVIDERS[platform].tokenUrl, body);
  if (response.status === 400 || response.status === 401) throw new ReauthRequired();
  if (!response.ok) throw new ProviderError(response.status);
  const parsed = tokenSchema.safeParse(await response.json().catch((): null => null));
  if (!parsed.success) throw new ProviderError(502);
  const { scope } = parsed.data;
  return {
    accessToken: parsed.data.access_token,
    // Refresh tokens may change on every refresh (Twitch, Kick): always keep the newest one.
    refreshToken: parsed.data.refresh_token ?? previousRefresh,
    expiresAt: parsed.data.expires_in === undefined ? null : now + parsed.data.expires_in * 1000,
    scopes: Array.isArray(scope) ? scope : (scope ?? "").split(" ").filter(Boolean),
  };
}

export async function exchangeCode(
  env: AppEnv,
  platform: ActivityPlatform,
  input: { code: string; redirectUri: string; codeVerifier: string },
  now: number = Date.now(),
): Promise<ChannelTokens & { scopes: string[] }> {
  const client = providerClient(env, platform);
  return tokenRequest(
    platform,
    {
      client_id: client.id,
      client_secret: client.secret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
      ...(PROVIDERS[platform].pkce ? { code_verifier: input.codeVerifier } : {}),
    },
    null,
    now,
  );
}

export async function refreshTokens(
  env: AppEnv,
  platform: ActivityPlatform,
  refreshToken: string,
  now: number = Date.now(),
): Promise<ChannelTokens> {
  const client = providerClient(env, platform);
  const tokens = await tokenRequest(
    platform,
    { client_id: client.id, client_secret: client.secret, grant_type: "refresh_token", refresh_token: refreshToken },
    refreshToken,
    now,
  );
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt };
}

/** Revokes the provider authorization. Returns whether the provider confirmed it. Never throws. */
export async function revokeToken(env: AppEnv, platform: ActivityPlatform, tokens: ChannelTokens): Promise<boolean> {
  try {
    const client = providerClient(env, platform);
    let response: Response;
    if (platform === "twitch") {
      response = await postForm("https://id.twitch.tv/oauth2/revoke", {
        client_id: client.id,
        token: tokens.accessToken,
      });
    } else if (platform === "youtube") {
      // Revoking the refresh token also ends its access tokens.
      response = await postForm("https://oauth2.googleapis.com/revoke", {
        token: tokens.refreshToken ?? tokens.accessToken,
      });
    } else {
      // Kick documents the parameters in the query string; the form body carries them too.
      const params = {
        token: tokens.refreshToken ?? tokens.accessToken,
        token_hint_type: tokens.refreshToken ? "refresh_token" : "access_token",
      };
      response = await postForm(`https://id.kick.com/oauth/revoke?${new URLSearchParams(params)}`, params);
    }
    return response.ok;
  } catch {
    return false;
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (response.status === 401) throw new ReauthRequired();
  if (!response.ok) {
    const body: unknown = await response.json().catch((): null => null);
    throw new ProviderError(response.status, youtubeReason(body));
  }
  return response.json();
}

/** The first `error.errors[].reason` of a Google API error body, which names quota and chat states. */
function youtubeReason(body: unknown): string | null {
  const parsed = z
    .object({ error: z.object({ errors: z.array(z.object({ reason: z.string().max(64) })).min(1) }) })
    .safeParse(body);
  return parsed.success ? parsed.data.error.errors[0].reason : null;
}

const nameSchema = z.string().trim().min(1).max(100);
const externalIdSchema = z.union([z.string().regex(/^[\w-]{1,64}$/), z.number().int().nonnegative()]).transform(String);

/** The channel the token belongs to: the proof of ownership. Its id is the platform's stable id. */
export async function channelIdentity(
  env: AppEnv,
  platform: ActivityPlatform,
  accessToken: string,
): Promise<{ externalId: string; displayName: string }> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  if (platform === "twitch") {
    const body = z
      .object({ data: z.array(z.object({ id: externalIdSchema, display_name: nameSchema })).length(1) })
      .parse(
        await getJson("https://api.twitch.tv/helix/users", { ...auth, "Client-Id": providerClient(env, platform).id }),
      );
    return { externalId: body.data[0].id, displayName: body.data[0].display_name };
  }
  if (platform === "youtube") {
    const body = z
      .object({ items: z.array(z.object({ id: externalIdSchema, snippet: z.object({ title: nameSchema }) })).min(1) })
      .parse(await getJson("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", auth));
    return { externalId: body.items[0].id, displayName: body.items[0].snippet.title };
  }
  const body = z
    .object({ data: z.array(z.object({ user_id: externalIdSchema, name: nameSchema })).length(1) })
    .parse(await getJson("https://api.kick.com/public/v1/users", auth));
  return { externalId: body.data[0].user_id, displayName: body.data[0].name };
}

/** An app access token for Twitch EventSub webhooks (client credentials). It is never stored. */
async function twitchAppToken(env: AppEnv): Promise<string> {
  const client = providerClient(env, "twitch");
  const response = await postForm("https://id.twitch.tv/oauth2/token", {
    client_id: client.id,
    client_secret: client.secret,
    grant_type: "client_credentials",
  });
  if (!response.ok) throw new ProviderError(response.status);
  return z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
}

/** The Twitch EventSub types the feed uses, with their condition. */
function twitchSubscriptions(
  broadcaster: string,
): { type: string; version: string; condition: Record<string, string> }[] {
  const chat = { broadcaster_user_id: broadcaster, user_id: broadcaster };
  return [
    { type: "channel.chat.message", version: "1", condition: chat },
    { type: "channel.chat.message_delete", version: "1", condition: chat },
    { type: "channel.chat.clear", version: "1", condition: chat },
    { type: "channel.chat.clear_user_messages", version: "1", condition: chat },
    {
      type: "channel.moderate",
      version: "2",
      condition: { broadcaster_user_id: broadcaster, moderator_user_id: broadcaster },
    },
  ];
}

export const KICK_EVENTS: readonly string[] = ["chat.message.sent", "moderation.banned"];

const TWITCH_SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
const KICK_SUBSCRIPTIONS_URL = "https://api.kick.com/public/v1/events/subscriptions";

const twitchListSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        type: z.string().max(100),
        condition: z.record(z.string(), z.unknown()),
        transport: z.object({ method: z.string(), callback: z.string().optional() }),
      }),
    )
    .max(100),
  pagination: z.object({ cursor: z.string().max(512).optional() }).optional(),
});

const kickListSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        broadcaster_user_id: z.union([z.number(), z.string()]),
        event: z.string().max(100),
        method: z.string(),
      }),
    )
    .max(1000),
});

/** A provider subscription: its id and its event type. */
export interface ProviderSubscription {
  id: string;
  type: string;
}

/**
 * This app's webhook subscriptions for the channel at the provider, or null when the list cannot be
 * read. Twitch filters by user id with the app token; Kick by broadcaster with the broadcaster's token. Twitch
 * also checks the callback, so subscriptions of other deployments of the app stay untouched.
 */
export async function listSubscriptions(
  env: AppEnv,
  platform: ActivityPlatform,
  externalId: string,
  accessToken: string | null,
  callbackOrigin: string,
): Promise<ProviderSubscription[] | null> {
  if (platform === "youtube") return [];
  try {
    if (platform === "kick") {
      if (!accessToken) return null;
      const response = await fetch(`${KICK_SUBSCRIPTIONS_URL}?broadcaster_user_id=${encodeURIComponent(externalId)}`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (!response.ok) return null;
      return kickListSchema
        .parse(await response.json())
        .data.filter((item) => item.method === "webhook" && String(item.broadcaster_user_id) === externalId)
        .map((item) => ({ id: item.id, type: item.event }));
    }
    const headers = {
      Authorization: `Bearer ${await twitchAppToken(env)}`,
      "Client-Id": providerClient(env, platform).id,
    };
    const subscriptions: ProviderSubscription[] = [];
    let cursor: string | undefined;
    // At most 10 pages of 100: far more than the five subscriptions of one channel.
    for (let page = 0; page < 10; page++) {
      const url = new URL(TWITCH_SUBSCRIPTIONS_URL);
      url.searchParams.set("user_id", externalId);
      if (cursor) url.searchParams.set("after", cursor);
      const response = await fetch(url, { headers });
      if (!response.ok) return null;
      const body = twitchListSchema.parse(await response.json());
      for (const item of body.data)
        if (
          item.transport.method === "webhook" &&
          item.transport.callback === `${callbackOrigin}/hooks/twitch` &&
          item.condition.broadcaster_user_id === externalId
        )
          subscriptions.push({ id: item.id, type: item.type });
      cursor = body.pagination?.cursor;
      if (!cursor) return subscriptions;
    }
    return subscriptions;
  } catch {
    return null;
  }
}

/**
 * Creates the provider subscriptions for a channel. Each id goes into `created` as soon as it exists, so a
 * failure part way through never loses one. `conflicts` names the Twitch types that already had a subscription:
 * the caller then lists the existing ones to adopt them. Twitch webhooks need an app token; Kick takes the
 * broadcaster's own token. YouTube has no push API: the ingest object polls its live chat instead.
 */
export async function subscribe(
  env: AppEnv,
  platform: ActivityPlatform,
  externalId: string,
  accessToken: string,
  callbackOrigin: string,
  created: string[],
): Promise<{ conflicts: string[] }> {
  if (platform === "youtube") return { conflicts: [] };
  if (platform === "twitch") {
    const token = await twitchAppToken(env);
    const conflicts: string[] = [];
    for (const subscription of twitchSubscriptions(externalId)) {
      const response = await fetch(TWITCH_SUBSCRIPTIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Client-Id": providerClient(env, platform).id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...subscription,
          transport: {
            method: "webhook",
            callback: `${callbackOrigin}/hooks/twitch`,
            secret: env.TWITCH_EVENTSUB_SECRET,
          },
        }),
      });
      if (response.status === 409) {
        conflicts.push(subscription.type);
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new ReauthRequired();
      if (!response.ok) throw new ProviderError(response.status);
      const body = z
        .object({ data: z.array(z.object({ id: z.string().min(1).max(64) })).min(1) })
        .parse(await response.json());
      created.push(body.data[0].id);
    }
    return { conflicts };
  }
  const response = await fetch(KICK_SUBSCRIPTIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      broadcaster_user_id: Number(externalId),
      events: KICK_EVENTS.map((name: string) => ({ name, version: 1 })),
      method: "webhook",
    }),
  });
  if (response.status === 401 || response.status === 403) throw new ReauthRequired();
  if (!response.ok) throw new ProviderError(response.status);
  const body = z
    .object({
      data: z.array(z.object({ subscription_id: z.string().max(64).nullish(), error: z.string().max(200).nullish() })),
    })
    .parse(await response.json());
  for (const item of body.data) if (item.subscription_id) created.push(item.subscription_id);
  if (body.data.some((item) => !item.subscription_id)) throw new ProviderError(502);
  return { conflicts: [] };
}

/** Deletes the provider subscriptions. Returns the ids it could not delete. Never throws. */
export async function unsubscribe(
  env: AppEnv,
  platform: ActivityPlatform,
  ids: readonly string[],
  accessToken: string | null,
): Promise<string[]> {
  if (ids.length === 0) return [];
  // Kick deletes subscriptions only with the broadcaster's token.
  if (platform === "kick" && !accessToken) return [...ids];
  let headers: Record<string, string>;
  try {
    headers =
      platform === "twitch"
        ? { Authorization: `Bearer ${await twitchAppToken(env)}`, "Client-Id": providerClient(env, platform).id }
        : { Authorization: `Bearer ${accessToken}` };
  } catch {
    return [...ids];
  }
  const base = platform === "twitch" ? TWITCH_SUBSCRIPTIONS_URL : KICK_SUBSCRIPTIONS_URL;
  const failed: string[] = [];
  for (const id of ids) {
    try {
      const response = await fetch(`${base}?id=${encodeURIComponent(id)}`, { method: "DELETE", headers });
      // 404: the provider already removed it.
      if (!response.ok && response.status !== 404) failed.push(id);
    } catch {
      failed.push(id);
    }
  }
  return failed;
}

/** The live chat of the channel's active broadcast, or null when it is not live. Costs 1 quota unit. */
export async function youtubeLiveChat(accessToken: string): Promise<string | null> {
  const body = z
    .object({ items: z.array(z.object({ snippet: z.object({ liveChatId: z.string().max(128).optional() }) })) })
    .parse(
      await getJson(
        "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all",
        { Authorization: `Bearer ${accessToken}` },
      ),
    );
  return body.items.find((item) => item.snippet.liveChatId)?.snippet.liveChatId ?? null;
}

export const youtubeMessageSchema = z.object({
  id: z.string().min(1).max(128),
  snippet: z.object({
    type: z.string().max(64),
    publishedAt: z.string().max(64).optional(),
    displayMessage: z.string().max(2000).optional(),
    textMessageDetails: z.object({ messageText: z.string().max(2000) }).optional(),
    messageDeletedDetails: z.object({ deletedMessageId: z.string().max(128) }).optional(),
    userBannedDetails: z
      .object({
        bannedUserDetails: z.object({ channelId: z.string().max(64) }),
        banType: z.string().max(32),
        banDurationSeconds: z.coerce.number().nonnegative().optional(),
      })
      .optional(),
  }),
  authorDetails: z
    .object({
      channelId: z.string().max(64),
      displayName: z.string().max(200),
      isVerified: z.boolean().optional(),
      isChatOwner: z.boolean().optional(),
      isChatSponsor: z.boolean().optional(),
      isChatModerator: z.boolean().optional(),
    })
    .optional(),
});
export type YoutubeMessage = z.infer<typeof youtubeMessageSchema>;

/** One page of live chat messages. Costs 5 quota units. */
export async function youtubeChatPage(
  accessToken: string,
  liveChatId: string,
  pageToken: string | null,
): Promise<{ items: YoutubeMessage[]; nextPageToken: string | null; pollingIntervalMillis: number; offline: boolean }> {
  const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
  url.searchParams.set("liveChatId", liveChatId);
  url.searchParams.set("part", "id,snippet,authorDetails");
  url.searchParams.set("maxResults", "200");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const body = z
    .object({
      items: z.array(z.unknown()).max(2000),
      nextPageToken: z.string().max(512).optional(),
      pollingIntervalMillis: z.number().nonnegative().optional(),
      offlineAt: z.string().max(64).optional(),
    })
    .parse(await getJson(url.toString(), { Authorization: `Bearer ${accessToken}` }));
  const items: YoutubeMessage[] = [];
  for (const item of body.items) {
    const parsed = youtubeMessageSchema.safeParse(item);
    if (parsed.success) items.push(parsed.data);
  }
  return {
    items,
    nextPageToken: body.nextPageToken ?? null,
    pollingIntervalMillis: body.pollingIntervalMillis ?? 5000,
    offline: body.offlineAt !== undefined,
  };
}
