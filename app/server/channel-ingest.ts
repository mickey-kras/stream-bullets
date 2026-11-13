import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "../env";
import { z } from "zod";
import {
  activityEventSchema,
  CHANNEL_STATUS_CODES,
  MAX_ACTIVITY_MESSAGE_LENGTH,
  quotaDay,
  type ActivityChat,
  type ActivityEvent,
  type ActivityPlatform,
  type ChannelStatus,
  type ChannelStatusCode,
} from "../lib/activity";
import { youtubeEvents } from "./channel-normalize";
import {
  channelIdentity,
  ProviderError,
  ReauthRequired,
  refreshTokens,
  revokeToken,
  listSubscriptions,
  subscribe,
  unsubscribe,
  youtubeChatPage,
  youtubeLiveChat,
} from "./channel-providers.server";
import { channelsOff, loadTokens, replaceTokens, type StoredTokens } from "./channel-tokens.server";
import { HttpError, getOrigin } from "./http.server";
import { ID_SQL, type IdTable } from "./channel-ingest-sql";
import {
  SNAPSHOT_SIZE,
  SNAPSHOT_MAX_AGE_MS,
  SEEN_TTL_MS,
  SEEN_MAX,
  CONNECTION_READS,
  CONNECTION_CACHE_MS,
  MAX_DELIVERY_EVENTS,
  CLEANUP_INTERVAL_MS,
  MAX_SOCKETS,
  HEALTH_INTERVAL_MS,
  YOUTUBE_MIN_POLL_MS,
  YOUTUBE_IDLE_POLL_MS,
  BACKOFF_MIN_MS,
  BACKOFF_MAX_MS,
  YOUTUBE_NAME_REFRESH_MS,
  YOUTUBE_NAME_RETRY_MS,
  YOUTUBE_JOB_RETRY_MS,
  YOUTUBE_DAILY_BUDGET,
  YOUTUBE_PAGE_DAILY_BUDGET,
  REFRESH_MARGIN_MS,
  type Admission,
  type Bucket,
  ADMISSIONS,
  newBuckets,
} from "./channel-ingest-limits";

/**
 * One per page (`idFromName(streamerId)`): the single ingestion point for the page's connected channels, shared by
 * every activity consumer (docs/channel-connections.md). It deduplicates deliveries, bounds the admission rate,
 * keeps a short reconnect snapshot, removes moderated messages from it, polls YouTube live chat while a consumer
 * listens, and refreshes provider tokens. Requests to the object can interleave while one waits for a fetch, so
 * one in-memory promise per connection serializes refreshes, and the stored row is replaced only by
 * compare-and-set.
 */

const STREAMER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORMS: readonly ActivityPlatform[] = ["twitch", "youtube", "kick"];
const ROUTES: Readonly<Record<string, "GET" | "POST">> = {
  "/subscribe": "GET",
  "/event": "POST",
  "/connect": "POST",
  "/disconnect": "POST",
  "/status": "POST",
  "/overlay-key": "POST",
  "/page-status": "POST",
  "/close": "POST",
  "/refresh": "POST",
};

interface Connection {
  id: string;
  externalId: string;
  status: ChannelStatus;
  /** The page is suspended: nothing is received or polled until an admin lifts it. */
  suspended: boolean;
}

interface YoutubeState {
  liveChatId: string | null;
  pageToken: string | null;
  backoffMs: number;
  /** No poll runs before this time: the backoff, the polling interval and quota waits all set it. */
  nextPollAt: number;
  /** When the channel title was last read again from YouTube. */
  nameAt: number;
}

const NEW_YOUTUBE_STATE: YoutubeState = { liveChatId: null, pageToken: null, backoffMs: 0, nextPollAt: 0, nameAt: 0 };

type EventRow = { body: string };

/**
 * The content key of a ban: the same user, end and ban time is one ban, so copies match while a new ban after an
 * unban (a new ban time) does not.
 */
function banKey(event: Extract<ActivityEvent, { kind: "ban" }>): string {
  return `ban:${event.platform}:${event.userId}:${event.until ?? "perm"}:${event.bannedAt ?? ""}`;
}

/** A disconnect or close started while a poll waited: the poll stops and writes nothing. */
class Superseded extends Error {}

function reply(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function isPlatform(value: string | null): value is ActivityPlatform {
  return value !== null && (PLATFORMS as readonly string[]).includes(value);
}

/**
 * The snapshot as one socket message. The oldest messages are left out until it fits the consumer's message limit,
 * so a reconnecting consumer always gets the newest history.
 */
export function snapshotMessage(events: readonly ActivityChat[]): string {
  let start = 0;
  let message = JSON.stringify({ type: "snapshot", events, replay: true });
  while (message.length > MAX_ACTIVITY_MESSAGE_LENGTH && start < events.length) {
    start += Math.max(1, Math.ceil((events.length - start) / 10));
    message = JSON.stringify({ type: "snapshot", events: events.slice(start), replay: true });
  }
  return message;
}

export class ChannelIngest extends DurableObject<AppEnv> {
  private streamerId: string | undefined;
  private readonly buckets: Record<Admission, Bucket> = newBuckets();
  private readonly dropped: Record<Admission, number> = { chat: 0, moderation: 0 };
  private droppedLoggedAt = 0;
  private readonly healthAt = new Map<ActivityPlatform, number>();
  /** The refresh in flight for each connection: a second caller waits for it instead of refreshing again. */
  private readonly refreshes = new Map<string, Promise<StoredTokens>>();
  /** Provider subscription replacements run one at a time for each platform. */
  private readonly subscriptions = new Map<ActivityPlatform, Promise<void>>();
  /** Rows in `seen` and `deleted`, so the count limit runs only when a table is over it. */
  private readonly counts = new Map<IdTable, number>();
  /** Connections read from D1, with when they were read. The handlers that change a connection clear it. */
  private readonly connections = new Map<ActivityPlatform, { value: Connection | null; at: number }>();
  /** Counts cache clears. A D1 read that a clear overtook is stale: it is neither cached nor used. */
  private connectionEpoch = 0;
  /** Bumped by disconnect and close, so a YouTube poll that started before them writes nothing after them. */
  private readonly generations = new Map<ActivityPlatform, number>();
  /** Counts page-status calls that found the page suspended, so a subscribe can see one that raced its check. */
  private suspensions = 0;
  /** Counts overlay key changes, so a subscribe with the old key that raced the change is refused. */
  private overlayKeys = 0;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async (): Promise<void> => {
      this.streamerId = await ctx.storage.get<string>("streamerId");
      this.createTables();
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private createTables(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL, message_id TEXT NOT NULL, user_id TEXT NOT NULL, received_at INTEGER NOT NULL,
      body TEXT NOT NULL)`);
    // Delivery and chat message ids, for deduplication; and deleted message ids, kept apart so that a burst of
    // new ids can never push them out early.
    for (const table of ["seen", "deleted"] as const) {
      sql.exec(ID_SQL[table].create);
      sql.exec(ID_SQL[table].index);
      this.counts.set(table, sql.exec<{ n: number }>(ID_SQL[table].count).toArray()[0].n);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const streamerId = url.searchParams.get("streamerId");
    const platform = url.searchParams.get("platform");
    if (
      streamerId === null ||
      !STREAMER_ID.test(streamerId) ||
      this.ctx.id.toString() !== this.env.CHANNEL_INGEST.idFromName(streamerId).toString() ||
      (this.streamerId !== undefined && this.streamerId !== streamerId)
    )
      return reply("Invalid stream", 400);
    const method = ROUTES[url.pathname];
    if (!method) return reply("Not found", 404);
    if (request.method !== method) return reply("Method not allowed", 405);
    if (this.streamerId === undefined) {
      this.streamerId = streamerId;
      await this.ctx.storage.put("streamerId", streamerId);
    }
    // These requests change a connection or the page: read them from D1 again afterwards.
    if (["/connect", "/disconnect", "/status", "/page-status", "/close", "/refresh"].includes(url.pathname))
      this.forgetConnections();
    // Ingestion is off: consumers get `unavailable` and reconnect once it is on again.
    if (channelsOff(this.env)) this.closeSockets("Channels off");
    if (url.pathname === "/subscribe") return this.subscribe(request);
    if (url.pathname === "/overlay-key") return this.overlayKeyRevoked();
    if (url.pathname === "/page-status") return this.pageStatusChanged();
    if (url.pathname === "/close") return this.closeAll();
    if (url.pathname === "/refresh") return Response.json(await this.refreshRequested());
    if (!isPlatform(platform)) return reply("Invalid platform", 400);
    if (url.pathname === "/event") return this.receive(platform, request);
    if (url.pathname === "/connect") return Response.json(await this.connectChannel(platform));
    if (url.pathname === "/disconnect") return Response.json(await this.disconnectChannel(platform));
    return this.statusChanged(platform, request);
  }

  // Sockets ------------------------------------------------------------------------------------------------------

  private async subscribe(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return reply("WebSocket required", 426);
    const overlay = request.headers.get("X-SB-Overlay") === "1";
    // The Worker sets these only for a valid overlay key or the signed-in owner.
    if (!overlay && request.headers.get("X-SB-Owner") !== "1") return reply("Forbidden", 403);
    const before = this.suspensions;
    const keysBefore = this.overlayKeys;
    const suspended = await this.pageSuspended();
    // A suspension that arrived while this check waited wins over the read. No await from here to the accept.
    if (suspended || this.suspensions !== before) return reply("Stream not found", 404);
    // A key change that arrived while this check waited revoked the key this request carries.
    if (overlay && this.overlayKeys !== keysBefore) return reply("Forbidden", 403);
    if (this.ctx.getWebSockets("activity").length >= MAX_SOCKETS) return reply("Too many connections", 429);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, overlay ? ["activity", "overlay-key"] : ["activity", "owner"]);
    this.send(server, snapshotMessage(this.snapshot(Date.now())));
    const youtube = await this.connection("youtube");
    if (youtube && youtube.status !== "needs_reauth" && !youtube.suspended) {
      // A new consumer never moves a poll forward past a backoff, an interval or a quota wait.
      const state = (await this.ctx.storage.get<YoutubeState>("youtube")) ?? NEW_YOUTUBE_STATE;
      await this.scheduleAlarm(Math.max(Date.now(), state.nextPollAt));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async pageSuspended(): Promise<boolean> {
    const row = await this.env.DB.prepare("SELECT status FROM streamers WHERE id=?")
      .bind(this.streamerId)
      .first<{ status: string }>();
    return row?.status === "suspended";
  }

  /** An admin changed the page's status. A suspended page shows nothing: every activity socket closes. */
  private async pageStatusChanged(): Promise<Response> {
    if (await this.pageSuspended()) {
      this.suspensions += 1;
      this.closeSockets("Page suspended");
    }
    return new Response(null, { status: 204 });
  }

  /** The page is going away (account deletion): close every socket and delete all stored state. */
  private async closeAll(): Promise<Response> {
    this.closeSockets("Page deleted");
    for (const platform of PLATFORMS) this.bump(platform);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.streamerId = undefined;
    this.forgetConnections();
    this.refreshes.clear();
    this.healthAt.clear();
    Object.assign(this.buckets, newBuckets());
    this.createTables();
    return new Response(null, { status: 204 });
  }

  private bump(platform: ActivityPlatform): void {
    this.generations.set(platform, (this.generations.get(platform) ?? 0) + 1);
  }

  private closeSockets(reason: string): void {
    for (const socket of this.ctx.getWebSockets("activity")) {
      this.send(socket, JSON.stringify({ type: "unavailable" }));
      socket.close(1001, reason);
    }
  }

  /** A new overlay key revokes the old one: its sockets close at once. */
  private overlayKeyRevoked(): Response {
    this.overlayKeys += 1;
    for (const socket of this.ctx.getWebSockets("overlay-key")) {
      this.send(socket, JSON.stringify({ type: "unavailable" }));
      socket.close(1001, "Overlay key revoked");
    }
    return new Response(null, { status: 204 });
  }

  async webSocketMessage(socket: WebSocket): Promise<void> {
    // Consumers only listen; anything but the ping (answered by the runtime) closes the socket.
    socket.close(1008, "Unsupported message");
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    socket.close();
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Activity connection failed");
  }

  private send(socket: WebSocket, message: string): void {
    try {
      socket.send(message);
    } catch {
      // The socket already closed; the runtime calls webSocketClose.
    }
  }

  private broadcast(event: ActivityEvent): void {
    const message = JSON.stringify({ type: "event", event });
    for (const socket of this.ctx.getWebSockets("activity")) this.send(socket, message);
  }

  // Ingestion -----------------------------------------------------------------------------------------------------

  /** The chat messages a reconnecting consumer gets. They are marked not live: commands in them never run again. */
  private snapshot(now: number): ActivityChat[] {
    this.prune(now);
    return this.ctx.storage.sql
      .exec<EventRow>("SELECT body FROM events ORDER BY seq")
      .toArray()
      .map((row: EventRow): ActivityChat => ({ ...(JSON.parse(row.body) as ActivityChat), live: false }));
  }

  private prune(now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM events WHERE received_at < ?", now - SNAPSHOT_MAX_AGE_MS);
    sql.exec("DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ?)", SNAPSHOT_SIZE);
    for (const table of ["seen", "deleted"] as const) {
      let count = (this.counts.get(table) ?? 0) - this.deleteIds(ID_SQL[table].expire, now - SEEN_TTL_MS);
      if (count > SEEN_MAX) count -= this.deleteIds(ID_SQL[table].trim, count - SEEN_MAX);
      this.counts.set(table, count);
    }
  }

  /** Runs a DELETE … RETURNING on an id table and returns how many rows it removed. */
  private deleteIds(query: string, value: number): number {
    return this.ctx.storage.sql.exec(query, value).toArray().length;
  }

  private known(table: IdTable, key: string): boolean {
    return this.ctx.storage.sql.exec(ID_SQL[table].find, key).toArray().length > 0;
  }

  private remember(table: IdTable, key: string, now: number): void {
    if (this.known(table, key)) return;
    this.ctx.storage.sql.exec(ID_SQL[table].add, key, now);
    this.counts.set(table, (this.counts.get(table) ?? 0) + 1);
  }

  /** Marks a key as seen. Returns false when it was seen before (a duplicate delivery). */
  private firstSight(key: string, now: number): boolean {
    if (this.known("seen", key)) return false;
    this.remember("seen", key, now);
    return true;
  }

  /** Takes up to `count` tokens from a bucket and returns how many it got. The rest is dropped and counted. */
  private admit(kind: Admission, count: number, now: number): number {
    if (count === 0) return 0;
    const { rate, burst } = ADMISSIONS[kind];
    const bucket = this.buckets[kind];
    const tokens = Math.min(burst, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * rate);
    const admitted = Math.min(count, Math.floor(tokens));
    this.buckets[kind] = { tokens: tokens - admitted, at: now };
    this.dropped[kind] += count - admitted;
    if (admitted < count && now - this.droppedLoggedAt >= 60_000) {
      console.warn("channel_ingest_dropped", { ...this.dropped });
      this.dropped.chat = 0;
      this.dropped.moderation = 0;
      this.droppedLoggedAt = now;
    }
    return admitted;
  }

  /** A verified delivery from the Worker: `{deliveryId, events}`. */
  private async receive(platform: ActivityPlatform, request: Request): Promise<Response> {
    const body: unknown = await request.json().catch((): null => null);
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const { deliveryId, channelId } = record;
    // At most MAX_DELIVERY_EVENTS events of any kind, so moderation in one delivery is bounded too.
    const events = Array.isArray(record.events) ? record.events.slice(0, MAX_DELIVERY_EVENTS) : null;
    if (typeof deliveryId !== "string" || deliveryId.length > 128 || typeof channelId !== "string" || events === null)
      return reply("Invalid event", 400);
    // Deduplication and admission come first: neither reads D1, so a burst costs no database reads.
    const now = Date.now();
    this.prune(now);
    if (this.known("seen", `delivery:${platform}:${deliveryId}`)) return new Response(null, { status: 204 });
    const parsed: ActivityEvent[] = [];
    for (const event of events) {
      const result = activityEventSchema.safeParse(event);
      if (result.success && result.data.platform === platform) parsed.push(result.data);
    }
    const admitted = this.admitEvents(parsed, now);
    if (admitted.length === 0) return new Response(null, { status: 204 });
    const connection = await this.connection(platform);
    // A delivery for a channel that is gone, needs a new authorization, belongs to a suspended page, or comes from
    // another channel (a route cached before the page changed its channel) is dropped.
    if (
      !connection ||
      connection.status === "needs_reauth" ||
      connection.suspended ||
      connection.externalId !== channelId
    )
      return new Response(null, { status: 204 });
    // A parallel copy of this delivery can finish while the connection is read.
    if (this.known("seen", `delivery:${platform}:${deliveryId}`)) return new Response(null, { status: 204 });
    // Every accepted delivery is remembered: a repeated clear or ban would otherwise remove newer chat again.
    this.remember("seen", `delivery:${platform}:${deliveryId}`, now);
    this.ingest(admitted, now);
    // The alarm expires stored messages and ids on time, also when no further delivery comes.
    await this.scheduleAlarm(now + SNAPSHOT_MAX_AGE_MS + 1);
    await this.touch(platform, connection, now);
    return new Response(null, { status: 204 });
  }

  /**
   * The events to ingest, in their order: the newest new chat messages the chat bucket allows, and the moderation
   * events the moderation bucket allows. The buckets are separate, so a chat flood cannot keep a deleted message on
   * screen. Chat already seen or deleted costs no token. Status events come only from the object itself.
   */
  private admitEvents(events: readonly ActivityEvent[], now: number): ActivityEvent[] {
    const fresh = events.filter((event: ActivityEvent): boolean => {
      if (event.kind === "status") return false;
      if (event.kind === "chat") return !this.known("deleted", event.id) && !this.known("seen", `message:${event.id}`);
      // Kick copies of one ban can reach other apps and come back with new delivery ids: a ban is deduplicated by
      // its content.
      if (event.kind === "ban") return !this.known("seen", banKey(event));
      return true;
    });
    const chats = fresh.filter((event: ActivityEvent) => event.kind === "chat").length;
    let skipChat = chats - this.admit("chat", chats, now);
    let keepModeration = this.admit("moderation", fresh.length - chats, now);
    return fresh.filter((event: ActivityEvent) => (event.kind === "chat" ? skipChat-- <= 0 : keepModeration-- > 0));
  }

  /** Stores and broadcasts events that already passed admission. */
  private ingest(events: readonly ActivityEvent[], now: number): void {
    const sql = this.ctx.storage.sql;
    for (const event of events) {
      if (event.kind === "chat") {
        // A message that was deleted (even before it arrived) or delivered before never enters again.
        if (this.known("deleted", event.id) || !this.firstSight(`message:${event.id}`, now)) continue;
        sql.exec(
          "INSERT INTO events (platform, message_id, user_id, received_at, body) VALUES (?, ?, ?, ?, ?)",
          event.platform,
          event.messageId,
          event.user.id,
          event.receivedAt,
          JSON.stringify(event),
        );
      } else if (event.kind === "delete") {
        this.remember("deleted", `${event.platform}:${event.messageId}`, now);
        sql.exec("DELETE FROM events WHERE platform=? AND message_id=?", event.platform, event.messageId);
      } else if (event.kind === "ban" || event.kind === "clear_user") {
        if (event.kind === "ban") this.remember("seen", banKey(event), now);
        sql.exec("DELETE FROM events WHERE platform=? AND user_id=?", event.platform, event.userId);
      } else if (event.kind === "clear") {
        sql.exec("DELETE FROM events WHERE platform=?", event.platform);
      }
      // Moderation leaves the snapshot before it is sent, so a reconnect never shows a removed message. A timeout
      // that already ended still removes the user's messages: consumers get a clear_user, not a ban that is over.
      if (event.kind === "ban" && event.until !== null && event.until <= now)
        this.broadcast({
          kind: "clear_user",
          platform: event.platform,
          userId: event.userId,
          receivedAt: event.receivedAt,
        });
      else this.broadcast(event);
    }
    this.prune(now);
  }

  // Connections ---------------------------------------------------------------------------------------------------

  private forgetConnections(): void {
    this.connections.clear();
    this.connectionEpoch += 1;
  }

  /**
   * The connection of a platform, cached for CONNECTION_CACHE_MS. A read that a cache clear (a connect, disconnect,
   * status or page change) overtook is read again; after CONNECTION_READS such reads the answer is no connection.
   */
  private async connection(platform: ActivityPlatform): Promise<Connection | null> {
    const now = Date.now();
    const cached = this.connections.get(platform);
    if (cached && now - cached.at < CONNECTION_CACHE_MS) return cached.value;
    for (let read = 0; read < CONNECTION_READS; read++) {
      const epoch = this.connectionEpoch;
      const value = await this.readConnection(platform);
      if (epoch !== this.connectionEpoch) continue;
      this.connections.set(platform, { value, at: now });
      return value;
    }
    return null;
  }

  private async readConnection(platform: ActivityPlatform): Promise<Connection | null> {
    const row = await this.env.DB.prepare(
      `SELECT c.id, c.external_id, c.status, s.status AS page_status FROM channel_connections c
        JOIN streamers s ON s.id = c.streamer_id WHERE c.streamer_id=? AND c.platform=?`,
    )
      .bind(this.streamerId, platform)
      .first<{ id: string; external_id: string; status: ChannelStatus; page_status: string }>();
    return row
      ? { id: row.id, externalId: row.external_id, status: row.status, suspended: row.page_status === "suspended" }
      : null;
  }

  private async setStatus(
    platform: ActivityPlatform,
    connection: Connection,
    status: ChannelStatus,
    code: ChannelStatusCode | null,
  ): Promise<void> {
    // A row that a disconnect marked keeps its mark, so the disconnect's final delete still matches it. The time
    // tells the controls when the status began (for example the quota day) and starts the 7-day removal of a
    // connection that needs a new authorization.
    const epoch = this.connectionEpoch;
    const result = await this.env.DB.prepare(
      `UPDATE channel_connections SET status=?1, status_code=?2,
          updated_at = CASE WHEN status IS NOT ?1 OR status_code IS NOT ?2 THEN ?3 ELSE updated_at END
        WHERE id=?4 AND (status_code IS NULL OR status_code <> 'disconnecting')`,
    )
      .bind(status, code, Date.now(), connection.id)
      .run();
    // A read that started before this write must not cache the old status. When a cache clear ran during the
    // write, or the write changed no row (a disconnect marked it), the next use reads the row again.
    const overtaken = this.connectionEpoch !== epoch || result.meta.changes === 0;
    this.connectionEpoch += 1;
    const cached = this.connections.get(platform);
    if (overtaken) this.connections.delete(platform);
    else if (cached?.value?.id === connection.id) cached.value = { ...cached.value, status };
    // Only the platform and fixed codes: never an id, a name or provider text.
    if (status !== connection.status || status !== "active")
      console.warn("channel_status_changed", { platform, status, code });
    this.broadcast({ kind: "status", platform, status, ...(code ? { code } : {}) });
  }

  private async touch(platform: ActivityPlatform, connection: Connection, now: number): Promise<void> {
    if (now - (this.healthAt.get(platform) ?? 0) < HEALTH_INTERVAL_MS) return;
    this.healthAt.set(platform, now);
    await this.env.DB.prepare("UPDATE channel_connections SET last_event_at=? WHERE id=?")
      .bind(now, connection.id)
      .run();
  }

  /**
   * The connection's tokens with a usable access token, refreshed first when it is about to expire. A second
   * caller during a refresh gets the same result, so one refresh token is never used twice.
   */
  private freshTokens(platform: ActivityPlatform, connection: Connection): Promise<StoredTokens> {
    const pending = this.refreshes.get(connection.id);
    if (pending) return pending;
    const refresh = this.loadFreshTokens(platform, connection).finally((): void => {
      this.refreshes.delete(connection.id);
    });
    this.refreshes.set(connection.id, refresh);
    return refresh;
  }

  /** Stored tokens. A row that does not decrypt (a removed key, a damaged value) needs a new authorization. */
  private async storedTokens(platform: ActivityPlatform, connection: Connection): Promise<StoredTokens | null> {
    try {
      return await loadTokens(this.env, connection.id, platform);
    } catch (error: unknown) {
      if (error instanceof HttpError) throw error;
      throw new ReauthRequired();
    }
  }

  private async loadFreshTokens(platform: ActivityPlatform, connection: Connection): Promise<StoredTokens> {
    const tokens = await this.storedTokens(platform, connection);
    if (!tokens) throw new ReauthRequired();
    const now = Date.now();
    if (tokens.expiresAt === null || tokens.expiresAt - REFRESH_MARGIN_MS > now) return tokens;
    if (!tokens.refreshToken) throw new ReauthRequired();
    let refreshed: Awaited<ReturnType<typeof refreshTokens>>;
    try {
      refreshed = await refreshTokens(this.env, platform, tokens.refreshToken, now);
    } catch (error: unknown) {
      // A reconnect may have stored a new authorization while the old one was refused: use the new one.
      if (!(error instanceof ReauthRequired)) throw error;
      const current = await this.storedTokens(platform, connection);
      if (!current || current.updatedAt === tokens.updatedAt) throw error;
      return current;
    }
    if (!(await replaceTokens(this.env, connection.id, platform, refreshed, tokens.updatedAt, now))) {
      // Another writer (a reconnect) stored newer tokens: use those.
      const current = await this.storedTokens(platform, connection);
      if (!current) throw new ReauthRequired();
      return current;
    }
    return { ...refreshed, keyId: tokens.keyId, updatedAt: Math.max(now, tokens.updatedAt + 1) };
  }

  /** After a (re)connect: creates the provider subscriptions and starts YouTube polling. */
  private async connectChannel(
    platform: ActivityPlatform,
  ): Promise<{ status: ChannelStatus; code: ChannelStatusCode | null }> {
    const connection = await this.connection(platform);
    if (!connection) return { status: "error", code: "subscribe_failed" };
    // A connect is a new authorization: polls that started under the old one are superseded and write nothing.
    // A close (account deletion) that overtakes this connect deleted all storage: nothing is written back.
    this.bump(platform);
    const generation = this.generations.get(platform);
    const overtaken = (): boolean => this.generations.get(platform) !== generation;
    try {
      const tokens = await this.freshTokens(platform, connection);
      await this.resubscribe(platform, connection, tokens.accessToken, overtaken);
      if (overtaken()) return { status: "error", code: "subscribe_failed" };
      if (platform === "youtube") {
        // A reconnect starts a new chat session but keeps a pending wait, so reconnecting cannot skip a quota wait.
        const previous = (await this.ctx.storage.get<YoutubeState>("youtube")) ?? NEW_YOUTUBE_STATE;
        // The callback read the title just now.
        const state: YoutubeState = { ...NEW_YOUTUBE_STATE, nextPollAt: previous.nextPollAt, nameAt: Date.now() };
        await this.ctx.storage.put("youtube", state);
        await this.scheduleAlarm(Math.max(Date.now(), state.nextPollAt));
      }
      await this.setStatus(platform, connection, "active", null);
      return { status: "active", code: null };
    } catch (error: unknown) {
      const reauth = error instanceof ReauthRequired;
      const code: ChannelStatusCode = reauth ? "authorization_revoked" : "subscribe_failed";
      if (!reauth)
        console.error("channel_connect_failed", { platform, cause: error instanceof Error ? error.name : "unknown" });
      // A newer connect or a close overtook this one: its outcome stands, so this failure writes nothing.
      if (overtaken()) return { status: "error", code };
      await this.setStatus(platform, connection, reauth ? "needs_reauth" : "error", code);
      return { status: reauth ? "needs_reauth" : "error", code };
    }
  }

  /** The subscriptions this object knows of and the ones the provider lists for the channel and this callback. */
  private async knownSubscriptions(
    platform: ActivityPlatform,
    connection: Connection,
    accessToken: string | null,
  ): Promise<{ ids: string[]; listed: boolean }> {
    const stored = (await this.ctx.storage.get<string[]>(`subs:${platform}`)) ?? [];
    const listed = await listSubscriptions(this.env, platform, connection.externalId, accessToken, getOrigin(this.env));
    return { ids: [...new Set([...stored, ...(listed ?? []).map((item) => item.id)])], listed: listed !== null };
  }

  /**
   * Deletes the old provider subscriptions of the channel and makes new ones. Undeleted and new ids stay stored
   * for a later disconnect. A Twitch 409 adopts the listed subscriptions of that type. A type left without a
   * subscription for this callback fails the connect.
   */
  private async resubscribe(
    platform: ActivityPlatform,
    connection: Connection,
    accessToken: string,
    overtaken: () => boolean,
  ): Promise<void> {
    await this.serialSubscriptions(platform, async (): Promise<void> => {
      if (!overtaken()) await this.replaceSubscriptions(platform, connection, accessToken, overtaken);
    });
  }

  private async serialSubscriptions<T>(platform: ActivityPlatform, work: () => Promise<T>): Promise<T> {
    const previous = this.subscriptions.get(platform) ?? Promise.resolve();
    const pending = previous.then(work);
    // The queue advances after either outcome; the caller still receives the original failure.
    const settled = pending.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.subscriptions.set(platform, settled);
    try {
      return await pending;
    } finally {
      if (this.subscriptions.get(platform) === settled) this.subscriptions.delete(platform);
    }
  }

  private async replaceSubscriptions(
    platform: ActivityPlatform,
    connection: Connection,
    accessToken: string,
    overtaken: () => boolean,
  ): Promise<void> {
    const key = `subs:${platform}`;
    const origin = getOrigin(this.env);
    const known = await this.knownSubscriptions(platform, connection, accessToken);
    if (overtaken()) return;
    let kept = await unsubscribe(this.env, platform, known.ids, accessToken);
    if (overtaken()) return;
    const created: string[] = [];
    try {
      const { conflicts } = await subscribe(this.env, platform, connection.externalId, accessToken, origin, created);
      if (conflicts.length > 0) {
        const listed = await listSubscriptions(this.env, platform, connection.externalId, accessToken, origin);
        const adopted = (listed ?? []).filter((item) => conflicts.includes(item.type));
        kept = [...kept, ...adopted.map((item) => item.id)];
        if (conflicts.some((type) => !adopted.some((item) => item.type === type))) throw new ProviderError(409);
      }
    } finally {
      if (!overtaken()) await this.ctx.storage.put(key, [...new Set([...kept, ...created])]);
    }
  }

  /**
   * Before the API deletes the connection: deletes the provider subscriptions, revokes the authorization (best
   * effort), purges the channel's messages and stops polling. Returns whether the provider confirmed the revoke.
   */
  private async disconnectChannel(platform: ActivityPlatform): Promise<{ revoked: boolean; unsubscribed: boolean }> {
    this.bump(platform);
    const generation = this.generations.get(platform);
    return this.serialSubscriptions(platform, () => this.cleanupChannel(platform, generation));
  }

  private async cleanupChannel(
    platform: ActivityPlatform,
    generation: number | undefined,
  ): Promise<{ revoked: boolean; unsubscribed: boolean }> {
    if (this.generations.get(platform) !== generation) return { revoked: false, unsubscribed: false };
    const connection = await this.connection(platform);
    const key = `subs:${platform}`;
    let revoked = false;
    let unsubscribed = true;
    let left: string[] = [];
    if (connection) {
      let tokens: StoredTokens | null;
      try {
        tokens = await this.freshTokens(platform, connection);
      } catch {
        // An expired token that cannot refresh may still revoke the refresh token.
        tokens = await loadTokens(this.env, connection.id, platform).catch((): null => null);
      }
      const known = await this.knownSubscriptions(platform, connection, tokens?.accessToken ?? null);
      left = await unsubscribe(this.env, platform, known.ids, tokens?.accessToken ?? null);
      // Reported as done only when the provider's own list was read and every delete succeeded.
      unsubscribed = known.listed && left.length === 0;
      if (tokens) revoked = await revokeToken(this.env, platform, tokens);
    }
    // A close (account deletion) during this disconnect already deleted all storage: write nothing back.
    if (this.generations.get(platform) !== generation) return { revoked, unsubscribed };
    // Ids that could not be deleted stay stored: a later connect deletes them first.
    if (left.length > 0) await this.ctx.storage.put(key, left);
    else await this.ctx.storage.delete(key);
    if (platform === "youtube") await this.ctx.storage.delete("youtube");
    this.ctx.storage.sql.exec("DELETE FROM events WHERE platform=?", platform);
    this.broadcast({ kind: "status", platform, status: "disconnected" });
    return { revoked, unsubscribed };
  }

  /** The Worker saw a provider revocation (Twitch `revocation` message): stop until the owner reconnects. */
  private async statusChanged(platform: ActivityPlatform, request: Request): Promise<Response> {
    const parsed = z
      .object({ code: z.enum(CHANNEL_STATUS_CODES) })
      .safeParse(await request.json().catch((): null => null));
    if (!parsed.success) return reply("Invalid status", 400);
    const { code } = parsed.data;
    const connection = await this.connection(platform);
    if (connection)
      await this.setStatus(platform, connection, code === "authorization_revoked" ? "needs_reauth" : "error", code);
    return new Response(null, { status: 204 });
  }

  // YouTube polling -----------------------------------------------------------------------------------------------

  /** Sets the alarm to `at`, unless it already runs earlier. */
  private async scheduleAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  /**
   * Spends units of today's quota: the page's own budget first, then the shared one. Returns false when either is
   * used up; a refused shared spend gives the page's units back.
   */
  private async spendQuota(units: number, now: number): Promise<boolean> {
    const { day, resetAt } = quotaDay(now);
    const spend = (key: string, budget: number): Promise<{ count: number } | null> =>
      this.env.DB.prepare(
        `INSERT INTO app_rate_limits (key, count, window_start) SELECT ?1, ?2, ?3 WHERE ?2 <= ?4
          ON CONFLICT(key) DO UPDATE SET count = count + excluded.count
          WHERE app_rate_limits.count + excluded.count <= ?4
          RETURNING count`,
      )
        // The row starts at the day's reset, so the 24-hour cleanup never removes it before the day ends.
        .bind(key, units, resetAt, budget)
        .first<{ count: number }>();
    const pageKey = `youtube-quota:${day}:${this.streamerId}`;
    if (!(await spend(pageKey, YOUTUBE_PAGE_DAILY_BUDGET))) return false;
    if (await spend(`youtube-quota:${day}`, YOUTUBE_DAILY_BUDGET)) return true;
    await this.env.DB.prepare("UPDATE app_rate_limits SET count = count - ? WHERE key = ?").bind(units, pageKey).run();
    return false;
  }

  /**
   * Expires old snapshot messages, so nothing stays past SNAPSHOT_MAX_AGE_MS even when no more traffic comes, and
   * polls YouTube. Polling runs only while a consumer listens, so an idle page spends no quota.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    if (channelsOff(this.env)) this.closeSockets("Channels off");
    this.prune(now);
    const expiry = this.nextExpiry();
    const cleanup = expiry === null ? null : Math.max(expiry, now + CLEANUP_INTERVAL_MS);
    // The cleanup alarm is set before the poll, so a failed poll can never stop the retention cleanup.
    if (cleanup !== null) await this.ctx.storage.setAlarm(cleanup);
    let wait: number | null;
    try {
      wait = await this.pollYoutube(now);
    } catch (error: unknown) {
      console.error("channel_poll_failed", {
        platform: "youtube",
        cause: error instanceof Error ? error.name : "unknown",
      });
      wait = CLEANUP_INTERVAL_MS;
    }
    if (wait === null) return;
    await this.ctx.storage.setAlarm(cleanup === null ? now + wait : Math.min(cleanup, now + wait));
  }

  /** When the oldest stored message or id expires, or null when nothing is stored. */
  private nextExpiry(): number | null {
    const row = this.ctx.storage.sql
      .exec<{ events: number | null; seen: number | null; deleted: number | null }>(
        `SELECT (SELECT min(received_at) FROM events) AS events, (SELECT min(at) FROM seen) AS seen,
          (SELECT min(at) FROM deleted) AS deleted`,
      )
      .toArray()[0];
    const times: number[] = [];
    if (row.events !== null) times.push(row.events + SNAPSHOT_MAX_AGE_MS + 1);
    for (const at of [row.seen, row.deleted]) if (at !== null) times.push(at + SEEN_TTL_MS + 1);
    return times.length > 0 ? Math.min(...times) : null;
  }

  /** One YouTube poll, when one is due. Returns the wait before the next one, or null for none. */
  private async pollYoutube(now: number): Promise<number | null> {
    if (channelsOff(this.env)) return null;
    if (this.streamerId === undefined || this.ctx.getWebSockets("activity").length === 0) return null;
    const connection = await this.connection("youtube");
    if (!connection || connection.status === "needs_reauth" || connection.suspended) return null;
    const state: YoutubeState = { ...NEW_YOUTUBE_STATE, ...(await this.ctx.storage.get<YoutubeState>("youtube")) };
    // The alarm also runs for cleanup and when a consumer connects: no poll before its time.
    if (now < state.nextPollAt) return state.nextPollAt - now;
    // A disconnect or close that runs during the poll bumps the generation: the poll then writes nothing more, so
    // no data, status or state comes back.
    const generation = this.generations.get("youtube") ?? 0;
    const stale = (): boolean => (this.generations.get("youtube") ?? 0) !== generation;
    const current = (): void => {
      if (stale()) throw new Superseded();
    };
    let next: number;
    try {
      next = await this.poll(connection, state, now, current);
      state.backoffMs = 0;
      if (stale()) return null;
      if (connection.status !== "active") await this.setStatus("youtube", connection, "active", null);
    } catch (error: unknown) {
      if (error instanceof Superseded || stale()) return null;
      next = await this.pollFailed(connection, state, error, now);
    }
    if (stale()) return null;
    state.nextPollAt = next >= 0 ? now + next : 0;
    await this.ctx.storage.put("youtube", state);
    return next >= 0 ? next : null;
  }

  /**
   * Reads the YouTube channel title again and stores it with the time (data_read_at). The quota unit is spent only
   * after a successful read of this channel. A token for another channel changes nothing.
   */
  private async refreshTitle(connection: Connection, accessToken: string, now: number): Promise<void> {
    const identity = await channelIdentity(this.env, "youtube", accessToken);
    // The token reads another channel: nothing about this one was refreshed.
    if (identity.externalId !== connection.externalId) throw new ProviderError(409, "channelMismatch");
    await this.spendQuota(1, now);
    await this.env.DB.prepare(
      `UPDATE channel_connections SET display_name=?, data_read_at=?
        WHERE id=? AND (status_code IS NULL OR status_code <> 'disconnecting')`,
    )
      .bind(identity.displayName, now, connection.id)
      .run();
  }

  /**
   * The hourly expiry job asks for a title refresh of an old YouTube connection: `refreshed`, `reauth`, `failed`,
   * or `recent` when an attempt ran in the last YOUTUBE_JOB_RETRY_MS (the job then tries another connection).
   */
  private async refreshRequested(): Promise<{ result: "refreshed" | "reauth" | "failed" | "recent" }> {
    const now = Date.now();
    const last = (await this.ctx.storage.get<number>("refreshAttemptAt")) ?? 0;
    if (now - last < YOUTUBE_JOB_RETRY_MS) return { result: "recent" };
    await this.ctx.storage.put("refreshAttemptAt", now);
    const connection = await this.connection("youtube");
    if (!connection || connection.status === "needs_reauth") return { result: "failed" };
    // A reconnect during this refresh replaced the authorization: a refusal of the old one writes nothing.
    const generation = this.generations.get("youtube");
    try {
      const tokens = await this.freshTokens("youtube", connection);
      await this.refreshTitle(connection, tokens.accessToken, now);
      return { result: "refreshed" };
    } catch (error: unknown) {
      if (!(error instanceof ReauthRequired)) {
        console.warn("channel_name_refresh_failed", {
          platform: "youtube",
          cause: error instanceof Error ? error.name : "unknown",
        });
        return { result: "failed" };
      }
      if (this.generations.get("youtube") !== generation) return { result: "failed" };
      await this.setStatus("youtube", connection, "needs_reauth", "authorization_revoked");
      return { result: "reauth" };
    }
  }

  /** Returns the wait before the next poll. */
  private async poll(connection: Connection, state: YoutubeState, now: number, current: () => void): Promise<number> {
    if (!(await this.spendQuota(state.liveChatId ? 5 : 1, now))) throw new ProviderError(403, "quotaExceeded");
    const tokens = await this.freshTokens("youtube", connection);
    // Stored YouTube data must be fresh (YouTube API Services policy): read the title again once a day. A failed
    // read is tried again after an hour, a read of another channel after a day; neither stops the chat poll.
    if (now - state.nameAt >= YOUTUBE_NAME_REFRESH_MS) {
      try {
        await this.refreshTitle(connection, tokens.accessToken, now);
        state.nameAt = now;
      } catch (error: unknown) {
        if (error instanceof ReauthRequired) throw error;
        console.warn("channel_name_refresh_failed", {
          platform: "youtube",
          cause: error instanceof Error ? error.name : "unknown",
        });
        const mismatch = error instanceof ProviderError && error.reason === "channelMismatch";
        state.nameAt = mismatch ? now : now - YOUTUBE_NAME_REFRESH_MS + YOUTUBE_NAME_RETRY_MS;
      }
      current();
    }
    if (!state.liveChatId) {
      state.liveChatId = await youtubeLiveChat(tokens.accessToken);
      state.pageToken = null;
      return state.liveChatId ? 0 : YOUTUBE_IDLE_POLL_MS;
    }
    const page = await youtubeChatPage(tokens.accessToken, state.liveChatId, state.pageToken);
    current();
    // The first page is ingested too: messages sent before LIVE_WINDOW_MS are not live, so no old command runs.
    this.ingest(this.admitEvents(youtubeEvents(page.items, connection.externalId, now), now), now);
    state.pageToken = page.nextPageToken;
    if (page.items.length > 0) await this.touch("youtube", connection, now);
    if (page.offline) {
      state.liveChatId = null;
      state.pageToken = null;
      return YOUTUBE_IDLE_POLL_MS;
    }
    return Math.max(page.pollingIntervalMillis, YOUTUBE_MIN_POLL_MS);
  }

  private async pollFailed(connection: Connection, state: YoutubeState, error: unknown, now: number): Promise<number> {
    if (error instanceof ReauthRequired) {
      await this.setStatus("youtube", connection, "needs_reauth", "authorization_revoked");
      return -1;
    }
    const reason = error instanceof ProviderError ? error.reason : null;
    if (reason === "liveChatEnded" || reason === "liveChatNotFound" || reason === "liveChatDisabled") {
      state.liveChatId = null;
      state.pageToken = null;
      return YOUTUBE_IDLE_POLL_MS;
    }
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      console.warn("channel_quota_exhausted", { platform: "youtube" });
      await this.setStatus("youtube", connection, "error", "quota_exhausted");
      // Try again a minute after the quota resets at midnight Pacific Time.
      return quotaDay(now).resetAt - now + 60_000;
    }
    console.error("channel_poll_failed", {
      platform: "youtube",
      cause: error instanceof Error ? error.name : "unknown",
    });
    state.backoffMs = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, state.backoffMs * 2));
    return Math.round(state.backoffMs * (0.5 + Math.random() / 2));
  }
}
