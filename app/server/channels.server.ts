import { z } from "zod";
import { CHANNEL_PLATFORMS } from "../../db/enums";
import type { AppEnv } from "../env";
import { PLATFORM_CAPABILITIES, type ActivityPlatform, type ChannelStatus, type ConnectResult } from "../lib/activity";
import { assertStreamerWritable } from "./access.server";
import { auditStatement } from "./audit.server";
import {
  PROVIDERS,
  ReauthRequired,
  authorizationUrl,
  channelIdentity,
  configuredPlatform,
  exchangeCode,
  revokeToken,
} from "./channel-providers.server";
import { channelsOff, tokenKeysConfigured, tokenStatement } from "./channel-tokens.server";
import { getOwnStreamer } from "./data.server";
import { HttpError, getOrigin, logError } from "./http.server";
import { callIngest } from "./ingest-call.server";
import { hex } from "./overlay-key.server";
import { toBase64Url } from "./webauthn.server";

/**
 * Channel connections (docs/channel-connections.md). Separate from sign-in: their own redirect URI
 * (`/channels/callback/:platform`), state rows and tables; they never touch Better Auth's `account` table.
 */

export const platformSchema = z.enum(CHANNEL_PLATFORMS);

/** The authorization state lives this long and works once. */
export const STATE_TTL_MS = 10 * 60_000;
const STATE_PATTERN = /^[\w-]{43}$/;

export interface ChannelConnectionView {
  platform: ActivityPlatform;
  /** Whether the server has this platform's credentials. */
  available: boolean;
  connection: {
    displayName: string;
    status: ChannelStatus;
    code: string | null;
    connectedAt: number;
    lastEventAt: number | null;
    /** When the status or its code last changed (the status clock only). */
    updatedAt: number;
  } | null;
  capabilities: (typeof PLATFORM_CAPABILITIES)[ActivityPlatform];
}

function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function stateIdentifier(state: string): Promise<string> {
  return `channel-connect:${hex(await digest(state))}`;
}

export function redirectUri(env: AppEnv, platform: ActivityPlatform): string {
  return `${getOrigin(env)}/channels/callback/${platform}`;
}

/** Every platform with its connection state. Never includes tokens or scopes. */
export async function listConnections(env: AppEnv, streamerId: string): Promise<ChannelConnectionView[]> {
  const { results } = await env.DB.prepare(
    `SELECT platform, display_name, status, status_code, created_at, updated_at, last_event_at FROM channel_connections
      WHERE streamer_id=?`,
  )
    .bind(streamerId)
    .all<{
      platform: ActivityPlatform;
      display_name: string;
      status: ChannelStatus;
      status_code: string | null;
      created_at: number;
      last_event_at: number | null;
      updated_at: number;
    }>();
  const enabled = tokenKeysConfigured(env);
  return CHANNEL_PLATFORMS.map((platform: ActivityPlatform): ChannelConnectionView => {
    const row = results.find((item) => item.platform === platform);
    return {
      platform,
      available: enabled && configuredPlatform(env, platform),
      connection: row
        ? {
            displayName: row.display_name,
            status: row.status,
            code: row.status_code,
            connectedAt: row.created_at,
            lastEventAt: row.last_event_at,
            updatedAt: row.updated_at,
          }
        : null,
      capabilities: PLATFORM_CAPABILITIES[platform],
    };
  });
}

const stateValueSchema = z.object({
  userId: z.string().min(1).max(100),
  streamerId: z.string().min(1).max(100),
  platform: platformSchema,
  codeVerifier: z.string().regex(STATE_PATTERN),
});

/**
 * Starts a connection: stores a single-use state (only its SHA-256 is the lookup key) with the PKCE verifier,
 * bound to the account and page, and returns the provider's authorization URL.
 */
export async function startConnect(
  env: AppEnv,
  userId: string,
  streamerId: string,
  platform: ActivityPlatform,
  now: number = Date.now(),
): Promise<string> {
  if (!tokenKeysConfigured(env))
    throw new HttpError(503, "Channel connections are not configured.", "platform_unavailable");
  const state = randomToken();
  const codeVerifier = randomToken();
  const challenge = toBase64Url(await digest(codeVerifier));
  const url = authorizationUrl(env, platform, {
    state,
    redirectUri: redirectUri(env, platform),
    codeChallenge: challenge,
  });
  await env.DB.prepare(
    "INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      await stateIdentifier(state),
      JSON.stringify({ userId, streamerId, platform, codeVerifier }),
      now + STATE_TTL_MS,
      now,
      now,
    )
    .run();
  return url;
}

/** Takes the state row: it works once, before it expires, and only for its platform. */
async function consumeState(
  env: AppEnv,
  platform: ActivityPlatform,
  state: string | null,
  now: number,
): Promise<z.infer<typeof stateValueSchema> | null> {
  if (state === null || !STATE_PATTERN.test(state)) return null;
  const row = await env.DB.prepare("DELETE FROM verification WHERE identifier=? RETURNING value, expires_at")
    .bind(await stateIdentifier(state))
    .first<{ value: string; expires_at: number }>();
  if (!row || row.expires_at <= now) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    return null;
  }
  const parsed = stateValueSchema.safeParse(value);
  return parsed.success && parsed.data.platform === platform ? parsed.data : null;
}

/**
 * Completes a connection from the provider's redirect. The state must be this account's, unused and fresh; the
 * page must still be the account's and writable; the channel must not belong to another page. Tokens are stored
 * encrypted, and the ingest object then subscribes to the channel's events.
 */
export async function completeConnect(
  env: AppEnv,
  userId: string | null,
  platform: ActivityPlatform,
  params: URLSearchParams,
  now: number = Date.now(),
): Promise<ConnectResult> {
  const state = await consumeState(env, platform, params.get("state"), now);
  if (!state) return "state_invalid";
  if (channelsOff(env)) return "failed";
  // A callback in another account's session (a forged or swapped link) never connects anything.
  if (userId === null || state.userId !== userId) return "session_mismatch";
  const code = params.get("code");
  if (params.has("error") || code === null || code.length > 2048) return "denied";
  const streamer = await getOwnStreamer(env, userId);
  if (streamer?.id !== state.streamerId) return "session_mismatch";
  await assertStreamerWritable(env, streamer.id, userId);
  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  let identity: { externalId: string; displayName: string };
  try {
    tokens = await exchangeCode(env, platform, {
      code,
      redirectUri: redirectUri(env, platform),
      codeVerifier: state.codeVerifier,
    });
    identity = await channelIdentity(env, platform, tokens.accessToken);
  } catch (error: unknown) {
    if (!(error instanceof ReauthRequired)) logError("channel_callback_failed", error);
    return error instanceof ReauthRequired ? "denied" : "failed";
  }
  if (PROVIDERS[platform].scopes.some((scope: string) => !tokens.scopes.includes(scope))) {
    await refuseTokens(env, platform, tokens, identity.externalId);
    return "scope_missing";
  }
  const owner = await env.DB.prepare(
    `SELECT id, streamer_id, external_id, status_code FROM channel_connections
      WHERE platform=? AND (external_id=? OR streamer_id=?)`,
  )
    .bind(platform, identity.externalId, streamer.id)
    .all<{ id: string; streamer_id: string; external_id: string; status_code: string | null }>();
  if (owner.results.some((row) => row.streamer_id !== streamer.id)) {
    await refuseTokens(env, platform, tokens, identity.externalId);
    return "channel_taken";
  }
  const existing = owner.results[0];
  // A disconnect of this channel is still running: a reconnect now would race its final delete.
  if (existing?.status_code === "disconnecting") {
    await refuseTokens(env, platform, tokens, identity.externalId);
    return "disconnect_first";
  }
  // Reconnecting keeps the row; a different channel on the same platform needs a disconnect first.
  if (existing && existing.external_id !== identity.externalId) {
    await refuseTokens(env, platform, tokens, identity.externalId);
    return "disconnect_first";
  }
  const connectionId = existing?.id ?? crypto.randomUUID();
  let written: boolean;
  try {
    // The row shows an error until the ingest object confirms the subscriptions.
    const [upsert] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO channel_connections
          (id, streamer_id, platform, external_id, display_name, scopes, status, status_code, created_at, updated_at,
            data_read_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'error', 'subscribe_failed', ?7, ?7, ?7)
          ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, scopes=excluded.scopes, status='error',
            status_code='subscribe_failed', updated_at=excluded.updated_at, data_read_at=excluded.data_read_at
          WHERE channel_connections.status_code IS NOT 'disconnecting'`,
      ).bind(
        connectionId,
        streamer.id,
        platform,
        identity.externalId,
        identity.displayName,
        tokens.scopes.join(" "),
        now,
      ),
      auditStatement(
        env,
        {
          targetKind: "streamer",
          targetId: streamer.id,
          streamerId: streamer.id,
          action: existing ? "channel_reconnected" : "channel_connected",
          actorId: userId,
          metadata: { platform },
          createdAt: now,
        },
        { afterChange: true },
      ),
      await tokenStatement(env, connectionId, platform, tokens, now),
    ]);
    // No change: a disconnect marked the row after the check above. Its final delete removes the row and tokens.
    written = upsert.meta.changes > 0;
  } catch (error: unknown) {
    await refuseTokens(env, platform, tokens, identity.externalId);
    // A parallel callback claimed the channel or the platform slot between the check and the write.
    const message =
      error instanceof Error ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}` : "";
    if (message.includes("channel_connections.platform, channel_connections.external_id")) return "channel_taken";
    if (message.includes("channel_connections.streamer_id, channel_connections.platform")) return "disconnect_first";
    logError("channel_callback_failed", error);
    return "failed";
  }
  if (!written) {
    await refuseTokens(env, platform, tokens, identity.externalId);
    return "disconnect_first";
  }
  // This isolate may have cached the channel as unknown: deliveries start at once here.
  forgetRoutes(platform, identity.externalId);
  try {
    const response = await callIngest(env, streamer.id, "connect", { platform });
    if (!response.ok) throw new Error(`Ingest answered ${response.status}`);
    const result = z
      .object({ status: z.string() })
      .catch({ status: "error" })
      .parse(await response.json().catch((): null => null));
    // A refused subscription keeps the row with its error, so the owner can see it and reconnect.
    return result.status === "active" ? "connected" : "failed";
  } catch (error: unknown) {
    return abandonConnect(
      env,
      platform,
      tokens,
      { id: connectionId, writtenAt: now, reconnect: existing !== undefined },
      error,
    );
  }
}

/**
 * Gives back an authorization the callback refused. Google revokes the user's whole grant for this app, so a
 * YouTube token is not revoked while a stored connection of the same channel still uses that grant.
 */
async function refuseTokens(
  env: AppEnv,
  platform: ActivityPlatform,
  tokens: Awaited<ReturnType<typeof exchangeCode>>,
  externalId: string,
): Promise<void> {
  if (platform === "youtube") {
    const shared = await env.DB.prepare("SELECT 1 FROM channel_connections WHERE platform='youtube' AND external_id=?")
      .bind(externalId)
      .first();
    if (shared) return;
  }
  await revokeToken(env, platform, tokens);
}

/**
 * The ingest object did not subscribe: logs `error`, gives the new authorization back and leaves no usable
 * tokens. A new row goes; a reconnected row keeps its place as `needs_reauth`.
 */
async function abandonConnect(
  env: AppEnv,
  platform: ActivityPlatform,
  tokens: Awaited<ReturnType<typeof exchangeCode>>,
  connection: { id: string; writtenAt: number; reconnect: boolean },
  error: unknown,
): Promise<ConnectResult> {
  logError("channel_connect_failed", error);
  // Google revokes the user's whole grant, which a newer reconnect of the channel can use: a YouTube token is
  // revoked only after the cleanup found the row still this callback's own.
  if (platform !== "youtube") await revokeToken(env, platform, tokens);
  let owned = true;
  // Only the tokens this callback wrote are its own. A newer callback, or a disconnect that marked the row
  // meanwhile, owns the row: it stays as it is.
  try {
    const [first] = await env.DB.batch(
      connection.reconnect
        ? [
            env.DB.prepare(
              `UPDATE channel_connections SET status='needs_reauth', status_code='authorization_revoked'
                WHERE id=?1 AND (SELECT updated_at FROM channel_tokens WHERE connection_id=?1) = ?2
                  AND (status_code IS NULL OR status_code <> 'disconnecting')`,
            ).bind(connection.id, connection.writtenAt),
            env.DB.prepare(
              `DELETE FROM channel_tokens WHERE connection_id=?1 AND updated_at=?2
                AND (SELECT status_code FROM channel_connections WHERE id=?1) IS NOT 'disconnecting'`,
            ).bind(connection.id, connection.writtenAt),
          ]
        : [
            env.DB.prepare(
              `DELETE FROM channel_connections WHERE id=?1
                AND (SELECT updated_at FROM channel_tokens WHERE connection_id=?1) = ?2
                AND (status_code IS NULL OR status_code <> 'disconnecting')`,
            ).bind(connection.id, connection.writtenAt),
          ],
    );
    owned = first.meta.changes > 0;
  } catch (cleanupError: unknown) {
    // The token is revoked, so what stays cannot read the channel. The owner sees an error and retries.
    logError("channel_connect_cleanup_failed", cleanupError);
  }
  if (platform === "youtube" && owned) await revokeToken(env, platform, tokens);
  return "failed";
}

/**
 * Stops ingestion and removes the connection. The row is marked first, so the ingest object drops deliveries
 * that race the disconnect. The ingest object then deletes the provider subscriptions and revokes the
 * authorization (best effort). The tokens and the row are deleted even when the provider or the ingest object
 * fails. The audit row records whether the revoke and the unsubscribe were confirmed.
 */
export async function disconnect(
  env: AppEnv,
  userId: string,
  streamerId: string,
  platform: ActivityPlatform,
): Promise<{ revoked: boolean }> {
  const row = await env.DB.prepare(
    `UPDATE channel_connections SET status='needs_reauth', status_code='disconnecting', updated_at=?
      WHERE streamer_id=? AND platform=? RETURNING id`,
  )
    .bind(Date.now(), streamerId, platform)
    .first<{ id: string }>();
  if (!row) throw new HttpError(404, "This channel is not connected.");
  let outcome = { revoked: false, unsubscribed: false };
  try {
    const response = await callIngest(env, streamerId, "disconnect", { platform });
    outcome = z
      .object({ revoked: z.boolean(), unsubscribed: z.boolean() })
      .catch(outcome)
      .parse(await response.json().catch((): null => null));
  } catch (error: unknown) {
    logError("channel_disconnect_failed", error);
  }
  const [deleted] = await env.DB.batch([
    // Only the row this disconnect marked: a reconnect that already replaced it stays.
    env.DB.prepare("DELETE FROM channel_connections WHERE id=? AND status_code='disconnecting'").bind(row.id),
    auditStatement(
      env,
      {
        targetKind: "streamer",
        targetId: streamerId,
        streamerId,
        action: "channel_disconnected",
        actorId: userId,
        metadata: { platform, revoked: outcome.revoked, unsubscribed: outcome.unsubscribed },
      },
      { afterChange: true },
    ),
  ]);
  // No row left to delete: a reconnect replaced it, or another disconnect or cleanup removed it meanwhile.
  if (deleted.meta.changes === 0)
    throw new HttpError(
      409,
      "The channel changed while it was disconnecting. Check the list and try again.",
      "channel_conflict",
    );
  return { revoked: outcome.revoked };
}

/** How long account deletion waits for each channel's provider cleanup before it goes on without it. */
export const DELETION_CLEANUP_MS = 5_000;

/** Resolves to `fallback` when `work` takes longer than `ms`. The work itself goes on in the background. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/**
 * Before an account is deleted: for each connected channel of the page, stops ingestion, deletes the provider
 * subscriptions and revokes the authorization, then closes every activity socket. Each step is best effort and
 * bounded in time, so a provider outage never blocks the deletion. The database cascade deletes the rows.
 */
export async function disconnectAllChannels(
  env: AppEnv,
  streamerId: string,
  timeoutMs: number = DELETION_CLEANUP_MS,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `UPDATE channel_connections SET status='needs_reauth', status_code='disconnecting', updated_at=?
      WHERE streamer_id=? RETURNING platform`,
  )
    .bind(Date.now(), streamerId)
    .all<{ platform: ActivityPlatform }>();
  const call = async (path: "disconnect" | "close", platform?: ActivityPlatform): Promise<void> => {
    try {
      await within(callIngest(env, streamerId, path, platform ? { platform } : {}), timeoutMs, null);
    } catch (error: unknown) {
      logError("channel_cleanup_failed", error);
    }
  };
  await Promise.all(results.map((row) => call("disconnect", row.platform)));
  await call("close");
}

/** A YouTube connection that needs a new authorization is removed after this long. */
export const YOUTUBE_REAUTH_RETENTION_MS = 7 * 86_400_000;
/** YouTube API data not read again for this long is removed (YouTube API Services policy: refresh within 30 days). */
export const YOUTUBE_DATA_RETENTION_MS = 30 * 86_400_000;
/** The hourly job asks for a title refresh when the data is this old, so a refresh fails rarely at 30 days. */
export const YOUTUBE_DATA_REFRESH_MS = 25 * 86_400_000;
/** At most this many connections each run, for the refreshes and for the removals. */
export const EXPIRY_BATCH = 20;
/** A row that a disconnect marked longer ago than this is a stopped disconnect: the hourly job finishes it. */
export const STUCK_DISCONNECT_MS = 60 * 60_000;
/** A backstop: YouTube data older than this is removed even when no refresh of it was tried. */
export const YOUTUBE_DATA_BACKSTOP_MS = 32 * 86_400_000;

/**
 * Hourly: keeps stored YouTube data fresh, and removes connections whose data cannot be kept fresh.
 *
 * 1. The connections with the oldest data (older than 25 days) get a title refresh from their ingest object
 *    (1 quota unit). At most EXPIRY_BATCH real attempts each run; a connection tried in the last 50 minutes is
 *    skipped, so failing ones cannot starve the others.
 * 2. A connection is removed for a reason this run can prove: its refresh found the access revoked, or failed
 *    while its data is still older than 30 days (`stale`); it needs a new authorization for more than 7 days
 *    (`reauth`); its data is older than 32 days, tried or not (`stale_backstop`); or a disconnect of it stopped
 *    more than an hour ago without finishing (`stuck`, any platform).
 *
 * A removal runs the disconnect path first, best effort and bounded in time, then deletes the row (the tokens go
 * with it) and writes an audit row. While CHANNELS_OFF is set, the job only finishes stopped disconnects, without
 * a call to the ingest object or the providers. `channel_youtube_overdue` reports data older than 30 days that is
 * left after a run.
 */
export async function expireYoutubeConnections(env: AppEnv, now: number): Promise<void> {
  const off = channelsOff(env);
  // A disconnect that stopped (a crash after its mark) leaves a marked row: sweep it after an hour, any platform.
  const stuck = await env.DB.prepare(
    `SELECT id, streamer_id, platform FROM channel_connections WHERE status_code='disconnecting' AND updated_at < ?
      LIMIT ?`,
  )
    .bind(now - STUCK_DISCONNECT_MS, EXPIRY_BATCH)
    .all<{ id: string; streamer_id: string; platform: ActivityPlatform }>();
  const removals: { id: string; streamer_id: string; platform: ActivityPlatform; reason: string }[] = stuck.results.map(
    (row) => ({ ...row, reason: "stuck" }),
  );
  if (!off) removals.push(...(await expiredYoutubeRows(env, now)));
  const reasons: Record<string, number> = {};
  for (const row of removals) {
    if (!off) {
      try {
        await within(
          callIngest(env, row.streamer_id, "disconnect", { platform: row.platform }),
          DELETION_CLEANUP_MS,
          null,
        );
      } catch (error: unknown) {
        logError("channel_cleanup_failed", error);
      }
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM channel_connections WHERE id=? AND status_code='disconnecting'").bind(row.id),
      auditStatement(
        env,
        {
          targetKind: "streamer",
          targetId: row.streamer_id,
          streamerId: row.streamer_id,
          action: "channel_expired",
          actorId: null,
          metadata: { platform: row.platform, reason: row.reason },
          createdAt: now,
        },
        { afterChange: true },
      ),
    ]);
    reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
  }
  for (const [reason, count] of Object.entries(reasons)) console.warn("channel_youtube_expired", { count, reason });
  if (off) return;
  const overdue = await env.DB.prepare(
    `SELECT count(*) AS count FROM channel_connections WHERE platform='youtube' AND data_read_at < ?
      AND status_code IS NOT 'disconnecting'`,
  )
    .bind(now - YOUTUBE_DATA_RETENTION_MS)
    .first<number>("count");
  if (overdue) console.warn("channel_youtube_overdue", { count: overdue });
}

/** Refreshes the oldest YouTube data and marks the connections to remove (steps 1 and 2 above, without `stuck`). */
async function expiredYoutubeRows(
  env: AppEnv,
  now: number,
): Promise<{ id: string; streamer_id: string; platform: ActivityPlatform; reason: string }[]> {
  const old = await env.DB.prepare(
    `SELECT id, streamer_id, data_read_at FROM channel_connections WHERE platform='youtube' AND status <> 'needs_reauth'
      AND status_code IS NOT 'disconnecting' AND data_read_at < ? ORDER BY data_read_at LIMIT ?`,
  )
    .bind(now - YOUTUBE_DATA_REFRESH_MS, EXPIRY_BATCH * 5)
    .all<{ id: string; streamer_id: string; data_read_at: number }>();
  const revoked: string[] = [];
  const stale: string[] = [];
  let attempts = 0;
  let failures = 0;
  for (const row of old.results) {
    if (attempts >= EXPIRY_BATCH) break;
    let result = "failed";
    try {
      const response = await within(
        callIngest(env, row.streamer_id, "refresh", { platform: "youtube" }),
        DELETION_CLEANUP_MS,
        null,
      );
      result = z
        .object({ result: z.string() })
        .catch({ result: "failed" })
        .parse(await response?.json().catch((): null => null)).result;
    } catch (error: unknown) {
      logError("channel_refresh_failed", error);
    }
    if (result === "recent") continue;
    attempts += 1;
    if (result === "reauth") revoked.push(row.id);
    else if (result !== "refreshed") {
      failures += 1;
      if (row.data_read_at < now - YOUTUBE_DATA_RETENTION_MS) stale.push(row.id);
    }
  }
  if (failures > 0) console.warn("channel_youtube_refresh_failed", { count: failures });
  // A stale row is checked again here: a refresh that timed out for the job can still have written fresh data.
  const marked = await env.DB.prepare(
    `UPDATE channel_connections SET status='needs_reauth', status_code='disconnecting', updated_at=?1
      WHERE id IN (SELECT id FROM channel_connections WHERE platform='youtube' AND status_code IS NOT 'disconnecting'
        AND (id IN (SELECT value FROM json_each(?3)) OR (id IN (SELECT value FROM json_each(?4)) AND data_read_at < ?6)
          OR (status='needs_reauth' AND updated_at < ?2) OR data_read_at < ?7)
        ORDER BY data_read_at LIMIT ?5)
      RETURNING id, streamer_id, platform, CASE
        WHEN id IN (SELECT value FROM json_each(?3)) THEN 'reauth'
        WHEN id IN (SELECT value FROM json_each(?4)) AND data_read_at < ?6 THEN 'stale'
        WHEN data_read_at < ?7 THEN 'stale_backstop'
        ELSE 'reauth' END AS reason`,
  )
    .bind(
      now,
      now - YOUTUBE_REAUTH_RETENTION_MS,
      JSON.stringify(revoked),
      JSON.stringify(stale),
      EXPIRY_BATCH,
      now - YOUTUBE_DATA_RETENTION_MS,
      now - YOUTUBE_DATA_BACKSTOP_MS,
    )
    .all<{ id: string; streamer_id: string; platform: ActivityPlatform; reason: string }>();
  return marked.results;
}

/** How long a channel's page is remembered, so a burst of deliveries reads D1 once per isolate. */
export const ROUTE_CACHE_MS = 30_000;
/** The most routes one isolate keeps; past it, the cache starts again. */
const MAX_ROUTES = 10_000;
/** A channel without a connection is remembered this long, for signed notifications only. */
export const UNKNOWN_CACHE_MS = 10_000;
const routes = new Map<string, { streamerId: string | null; at: number }>();

/** Forgets every cached route (tests), or the route of one channel (a connect in this isolate). */
export function forgetRoutes(platform?: ActivityPlatform, externalId?: string): void {
  if (platform && externalId) routes.delete(`${platform}:${externalId}`);
  else routes.clear();
}

/**
 * The page that owns a channel. A cached route can be up to ROUTE_CACHE_MS old: a delivery for a channel that
 * was just disconnected then reaches the old page's ingest object, which drops it. An unknown channel is cached
 * for UNKNOWN_CACHE_MS, so a stream of notifications for an orphaned subscription reads D1 once in that time. A
 * connect clears its channel's entry in its own isolate; other isolates can wait up to UNKNOWN_CACHE_MS.
 */
export async function routeFor(
  env: AppEnv,
  platform: ActivityPlatform,
  externalId: string,
  now: number,
): Promise<string | null> {
  const key = `${platform}:${externalId}`;
  const cached = routes.get(key);
  if (cached && now - cached.at < (cached.streamerId === null ? UNKNOWN_CACHE_MS : ROUTE_CACHE_MS))
    return cached.streamerId;
  const connection = await connectionForChannel(env, platform, externalId);
  if (routes.size >= MAX_ROUTES) routes.clear();
  routes.set(key, { streamerId: connection?.streamerId ?? null, at: now });
  return connection?.streamerId ?? null;
}

/** The page whose ingest object receives a verified delivery for this channel, or null for an unknown channel. */
export async function connectionForChannel(
  env: AppEnv,
  platform: ActivityPlatform,
  externalId: string,
): Promise<{ streamerId: string } | null> {
  const row = await env.DB.prepare("SELECT streamer_id FROM channel_connections WHERE platform=? AND external_id=?")
    .bind(platform, externalId)
    .first<{ streamer_id: string }>();
  return row ? { streamerId: row.streamer_id } : null;
}
