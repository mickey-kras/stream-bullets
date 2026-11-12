import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "../env";
import {
  MASH_FLUSH_MS,
  MASH_MAX_BATCH,
  MASH_TICK_MS,
  mashPhaseAt,
  mashWinner,
  secondsLeft,
  takeTaps,
  tapUpserts,
  type TapDelta,
  type TokenBucket,
} from "../lib/mash";
import type { LiveSnapshot, MashPhase, MashTick, OverlayPublic } from "../types";
import { LIVE_POLLS_SQL, livePolls, optionsFromJson, type PollRow } from "./live-polls";
import { OVERLAY_COLUMNS, overlayPublic, overlayValue, type OverlayRow } from "./overlay-state";

const MAX_CONNECTIONS = 200;
// Reserve half the room for signed-in viewers.
const MAX_ANONYMOUS_CONNECTIONS = 100;
// Per hashed IPv4 address or IPv6 /64.
const MAX_CLIENT_CONNECTIONS = 10;
// Always admit owners; replace their oldest socket at this limit.
const MAX_OWNER_CONNECTIONS = 10;
const CONNECTION_LEASE_MS = 60 * 60 * 1_000;
// Clients ping every 20 seconds; close after this idle period.
const IDLE_TIMEOUT_MS = 60_000;
const CLIENT_KEY = /^[0-9a-f]{64}$/;
const USER_ID = /^[\w-]{1,100}$/;
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESYNC_INTERVAL_MS = 15_000;
const STREAMER_ID = ENTRY_ID;
const MAX_MESSAGE_LENGTH = 256;
// Cache non-live battle lookups for this interval.
const NOT_LIVE_CACHE_MS = 2_000;
const ROOM_PATHS: Readonly<Record<string, "GET" | "POST">> = {
  "/subscribe": "GET",
  "/refresh": "POST",
  "/mash": "POST",
  "/overlay": "POST",
  "/overlay-key": "POST",
};

// Worker-vouched account, opening time, and lease expiry.
interface ConnectionLease {
  expiresAt: number;
  userId: string | null;
  openedAt: number;
}

// Owners always enter; anonymous sockets yield first.
type SocketRole = "owner" | "member" | "anonymous";

// Suspension closes all sockets and hides live data.
class PageSuspended extends Error {}

interface TapMessage {
  t: "tap";
  id: string;
  n: number;
  assisted: boolean;
  seq: number;
}

// Keep active battles in memory. Persist each tap to `tap_journal` before acknowledgement; flush totals to D1
// every second. Recover journals after eviction/deploy. Per-player cumulative totals make repeated writes
// idempotent.
interface Battle {
  id: string;
  sides: number;
  phase: MashPhase;
  startsAt: number | null;
  endsAt: number | null;
  writable: boolean;
  // Durable taps at load plus every tap counted since.
  totals: number[];
  // Per-player D1 totals at load plus newly accepted taps.
  mine: Map<string, number>;
  mineAssisted: Map<string, number>;
  players: Set<string>;
  assistedPlayers: Set<string>;
  sideOf: Map<string, Promise<number | null>>;
  // Players pending a D1 flush.
  pending: Set<string>;
  seqs: Map<WebSocket, number>;
  // Last five ticks for the host tap-rate display.
  recent: number[];
  tickTaps: number;
  dirty: boolean;
  flushing: boolean;
  finishing: boolean;
  lastFlush: number;
}

type BattleRow = {
  duration_s: number;
  phase: MashPhase;
  starts_at: number | null;
  ends_at: number | null;
  options: string;
  status: string;
};

type TapRow = { user_id: string; side: number; taps: number; assisted_taps: number };
type JournalRow = { user_id: string; side: number; taps: number; assisted: number };

// Coalesce burst refreshes before reading D1.
const REFRESH_COALESCE_MS = 250;

function response(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function tapMessage(raw: string | ArrayBuffer): TapMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { t, id, n, assisted, seq } = value as Record<string, unknown>;
  if (
    t !== "tap" ||
    typeof id !== "string" ||
    !ENTRY_ID.test(id) ||
    typeof n !== "number" ||
    !Number.isSafeInteger(n) ||
    n < 1 ||
    typeof assisted !== "boolean" ||
    typeof seq !== "number" ||
    !Number.isSafeInteger(seq) ||
    seq < 0
  )
    return null;
  // Cap reconnect backlogs per message; the token bucket decides accepted taps.
  return { t, id, n: Math.min(n, MASH_MAX_BATCH), assisted, seq };
}

// The socket that opened first, or null for none.
function oldest(sockets: readonly WebSocket[], openedAt: (socket: WebSocket) => number): WebSocket | null {
  let found: WebSocket | null = null;
  for (const socket of sockets) if (found === null || openedAt(socket) < openedAt(found)) found = socket;
  return found;
}

export class PollRoom extends DurableObject<AppEnv> {
  private streamerId: string | undefined;
  private latestSnapshot: LiveSnapshot | undefined;
  private pendingSnapshot: Promise<LiveSnapshot> | undefined;
  private overlay: OverlayPublic | undefined;
  private readonly battles = new Map<string, Battle>();
  private readonly loadingBattles = new Map<string, Promise<Battle | null>>();
  private readonly notLive = new Map<string, number>();
  // One bucket per account, shared by all of its sockets.
  private readonly buckets = new Map<string, TokenBucket>();
  private ticker: ReturnType<typeof setInterval> | undefined;
  // Requests awaiting a refresh started after their arrival.
  private readonly refreshWaiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  private refreshing: Promise<void> | undefined;
  private ticks = 0;
  private ticking = false;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async (): Promise<void> => {
      this.streamerId = await ctx.storage.get<string>("streamerId");
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tap_journal (entry_id TEXT NOT NULL, starts_at INTEGER,
        user_id TEXT NOT NULL, side INTEGER NOT NULL, taps INTEGER NOT NULL, assisted INTEGER NOT NULL,
        PRIMARY KEY (entry_id, user_id))`);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const streamerId = url.searchParams.get("streamerId");
    if (!this.validStream(url, streamerId)) return response("Invalid stream", 400);
    const method = ROOM_PATHS[url.pathname];
    if (!method) return response("Not found", 404);
    if (request.method !== method) return response("Method not allowed", 405);
    const clientKey = request.headers.get("X-Stream-Bullets-Client") ?? "";
    const userId = request.headers.get("X-SB-User");
    let role: SocketRole = userId === null ? "anonymous" : "member";
    if (userId !== null && request.headers.get("X-SB-Owner") === "1") role = "owner";
    // Only valid overlay keys grant owner priority, even signed out.
    const overlayKey = request.headers.get("X-SB-Overlay") === "1";
    if (overlayKey) role = "owner";
    if (url.pathname === "/subscribe") {
      const invalidSubscription = this.validateSubscription(request, clientKey, userId, role);
      if (invalidSubscription) return invalidSubscription;
    }

    try {
      return await this.handleRequest(request, url.pathname, streamerId, clientKey, userId, role, overlayKey);
    } catch (error: unknown) {
      this.disconnect();
      if (!(error instanceof PageSuspended)) return response("Live updates unavailable", 503);
      return url.pathname === "/subscribe" ? response("Stream not found", 404) : new Response(null, { status: 204 });
    }
  }

  private async handleRequest(
    request: Request,
    path: string,
    streamerId: string,
    clientKey: string,
    userId: string | null,
    role: SocketRole,
    overlayKey: boolean,
  ): Promise<Response> {
    if (this.streamerId === undefined) {
      this.streamerId = streamerId;
      await this.ctx.storage.put("streamerId", streamerId);
    }
    if (path === "/refresh") return await this.refresh();
    if (path === "/mash") return await this.mashChanged(request);
    if (path === "/overlay") return await this.overlayChanged();
    if (path === "/overlay-key") return this.overlayKeyRevoked();

    return await this.subscribe(clientKey, userId, role, overlayKey);
  }

  private validStream(url: URL, streamerId: string | null): streamerId is string {
    return (
      url.searchParams.size === 1 &&
      streamerId !== null &&
      STREAMER_ID.test(streamerId) &&
      this.ctx.id.toString() === this.env.POLL_ROOMS.idFromName(streamerId).toString() &&
      (this.streamerId === undefined || this.streamerId === streamerId)
    );
  }

  private async subscribe(
    clientKey: string,
    userId: string | null,
    role: SocketRole,
    overlayKey: boolean,
  ): Promise<Response> {
    const snapshot = await this.snapshot();
    this.expireConnections();
    // Recheck after await: concurrent subscriptions may fill seats.
    const admission = this.admission(clientKey, role);
    if (admission.refusal) return admission.refusal;
    if (admission.evict) this.evict(admission.evict);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const tags = role === "owner" ? ["role:owner"] : [`client:${clientKey}`, `role:${role}`];
    this.ctx.acceptWebSocket(server, overlayKey ? [...tags, "overlay-key"] : tags);
    const now = Date.now();
    const lease: ConnectionLease = { expiresAt: now + CONNECTION_LEASE_MS, userId: userId ?? null, openedAt: now };
    server.serializeAttachment(lease);
    this.send(server, JSON.stringify(this.withBattles(snapshot)));
    this.startTicker();
    await this.scheduleResync();
    return new Response(null, { status: 101, webSocket: client });
  }

  private validateSubscription(
    request: Request,
    clientKey: string,
    userId: string | null,
    role: SocketRole,
  ): Response | undefined {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return response("WebSocket required", 426);
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== this.env.APP_ORIGIN) return response("Origin not allowed", 403);
    if (!CLIENT_KEY.test(clientKey)) return response("Invalid client", 400);
    if (userId !== null && !USER_ID.test(userId)) return response("Invalid account", 400);
    this.expireConnections();
    return this.admission(clientKey, role).refusal ?? undefined;
  }

  // Coalesce requests during a refresh into one further query. Resolve each request after a refresh started
  // after it; steady traffic cannot starve earlier requests.
  private async refresh(): Promise<Response> {
    const done = new Promise<void>((resolve, reject): void => {
      this.refreshWaiters.push({ resolve, reject });
    });
    this.refreshing ??= this.runRefreshes().finally((): void => {
      this.refreshing = undefined;
    });
    await done;
    return new Response(null, { status: 204 });
  }

  private async runRefreshes(): Promise<void> {
    while (this.refreshWaiters.length > 0) {
      const round = this.refreshWaiters.splice(0);
      try {
        await this.refreshOnce();
        for (const waiter of round) waiter.resolve();
      } catch (error) {
        for (const waiter of round) waiter.reject(error);
      }
      if (this.refreshWaiters.length > 0) await new Promise((resolve) => setTimeout(resolve, REFRESH_COALESCE_MS));
    }
  }

  private async refreshOnce(): Promise<void> {
    this.expireConnections();
    // Recover persisted battles and purge deleted journals before deciding that this room is idle.
    await this.resumeBattles();
    if (this.activeSockets().length > 0) {
      const snapshot = await this.snapshot();
      this.broadcast(snapshot);
    }
    await this.scheduleResync();
  }

  // Reload API battle changes from D1 and broadcast.
  private async mashChanged(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch((): null => null);
    const id = typeof body === "object" && body !== null && "id" in body ? body.id : null;
    if (typeof id !== "string" || !ENTRY_ID.test(id)) return response("Invalid battle", 400);
    this.notLive.delete(id);
    await this.loadBattle(id);
    return this.refresh();
  }

  // Reconnect old-key sockets without owner priority.
  private overlayKeyRevoked(): Response {
    for (const socket of this.activeSockets("overlay-key")) {
      this.send(socket, JSON.stringify({ type: "unavailable" }));
      if (socket.readyState === WebSocket.OPEN) socket.close(1001, "Overlay key revoked");
    }
    return new Response(null, { status: 204 });
  }

  private async overlayChanged(): Promise<Response> {
    this.overlay = await this.loadOverlay();
    if (this.latestSnapshot) this.latestSnapshot = { ...this.latestSnapshot, overlay: this.overlay };
    const message = JSON.stringify({ type: "overlay", overlay: this.overlay });
    for (const socket of this.activeSockets()) this.send(socket, message);
    return new Response(null, { status: 204 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tap = tapMessage(message);
    if (!tap) {
      socket.close(1008, "Unsupported message");
      return;
    }
    const result = await this.tap(socket, tap);
    if (result !== null) this.send(socket, JSON.stringify(result));
  }

  async webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    socket.close();
    for (const battle of this.battles.values()) battle.seqs.delete(socket);
    if (this.activeSockets().length === 0 && this.battles.size === 0) await this.ctx.storage.deleteAlarm();
  }

  webSocketError(socket: WebSocket, _error: unknown): void {
    socket.close(1011, "Live connection failed");
  }

  // Recover/end battles and broadcast a snapshot. Reschedule in `finally` so D1 failures cannot stop recovery.
  async alarm(): Promise<void> {
    let retry = false;
    try {
      this.expireConnections();
      await this.resumeBattles();
      if (this.activeSockets().length > 0) this.broadcast(await this.snapshot(true));
    } catch (error: unknown) {
      this.disconnect();
      // Log only the class; D1 messages can expose stored values.
      if (!(error instanceof PageSuspended)) {
        retry = true;
        console.error("live_resync_failed", { cause: error instanceof Error ? error.name : "unknown" });
      }
    } finally {
      await this.scheduleResync(retry);
    }
  }

  // Counts one batch of taps. Returns the reply for this socket, or null to stay silent.
  private async tap(socket: WebSocket, message: TapMessage): Promise<object | null> {
    const lease = this.lease(socket);
    if (!lease.userId) return { type: "mash-denied", id: message.id, reason: "sign-in" };
    const userId = lease.userId;
    const battle = await this.battleFor(message.id);
    if (!battle || !battle.writable || battle.finishing || mashPhaseAt(battle, Date.now()) !== "live")
      return { type: "mash-denied", id: message.id, reason: "closed" };
    // Per-socket sequence numbers prevent replayed tap batches.
    if (message.seq <= (battle.seqs.get(socket) ?? -1)) return null;
    battle.seqs.set(socket, message.seq);
    const pick = await this.sideFor(battle, userId);
    // Do not cache D1 failures; retry on the next batch.
    if (pick === undefined) return null;
    if (pick === null || pick >= battle.sides) return { type: "mash-denied", id: message.id, reason: "pick" };
    const now = Date.now();
    if (battle.finishing || mashPhaseAt(battle, now) !== "live") return null;
    const { bucket, accepted } = takeTaps(this.buckets.get(userId), message.n, message.assisted, now);
    this.buckets.set(userId, bucket);
    if (accepted > 0) {
      const taps: number = (battle.mine.get(userId) ?? 0) + accepted;
      const assisted: number = (battle.mineAssisted.get(userId) ?? 0) + (message.assisted ? accepted : 0);
      // The runtime holds acknowledgements until this write is durable.
      this.ctx.storage.sql.exec(
        `INSERT INTO tap_journal (entry_id, starts_at, user_id, side, taps, assisted) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (entry_id, user_id) DO UPDATE SET starts_at = excluded.starts_at, side = excluded.side,
          taps = excluded.taps, assisted = excluded.assisted`,
        battle.id,
        battle.startsAt,
        userId,
        pick,
        taps,
        assisted,
      );
      battle.totals[pick] += accepted;
      battle.mine.set(userId, taps);
      battle.mineAssisted.set(userId, assisted);
      battle.players.add(userId);
      if (message.assisted) battle.assistedPlayers.add(userId);
      battle.pending.add(userId);
      battle.tickTaps += accepted;
      battle.dirty = true;
    }
    return { type: "mash-ack", id: battle.id, mine: battle.mine.get(userId) ?? 0, accepted };
  }

  // Cache player sides per battle, but never cache lookup failures.
  private async sideFor(battle: Battle, userId: string): Promise<number | null | undefined> {
    let side = battle.sideOf.get(userId);
    if (!side) {
      side = this.lookupSide(battle.id, userId);
      battle.sideOf.set(userId, side);
    }
    try {
      return await side;
    } catch {
      if (battle.sideOf.get(userId) === side) battle.sideOf.delete(userId);
      console.error("mash_side_lookup_failed");
      return undefined;
    }
  }

  private async lookupSide(entryId: string, userId: string): Promise<number | null> {
    const row = await this.env.DB.prepare("SELECT choice FROM entry_votes WHERE entry_id=? AND user_id=?")
      .bind(entryId, userId)
      .first<{ choice: number }>();
    return row ? row.choice : null;
  }

  // Load live battles from D1 after waking.
  private async battleFor(id: string): Promise<Battle | null> {
    const known = this.battles.get(id);
    if (known) return known;
    if ((this.notLive.get(id) ?? 0) > Date.now()) return null;
    const battle = await this.loadBattle(id);
    if (!battle) this.notLive.set(id, Date.now() + NOT_LIVE_CACHE_MS);
    return battle;
  }

  private loadBattle(id: string): Promise<Battle | null> {
    const loading = this.loadingBattles.get(id);
    if (loading) return loading;
    const pending = this.readBattle(id).finally((): void => {
      this.loadingBattles.delete(id);
    });
    this.loadingBattles.set(id, pending);
    return pending;
  }

  private async readBattle(id: string): Promise<Battle | null> {
    const [battleResult, tapResult] = await this.env.DB.batch([
      this.env.DB.prepare(`SELECT m.duration_s, m.phase, m.starts_at, m.ends_at, e.options, s.status
        FROM entry_mash m JOIN entries e ON e.id=m.entry_id JOIN streamers s ON s.id=e.streamer_id
        WHERE m.entry_id=? AND e.streamer_id=?`).bind(id, this.streamerId),
      this.env.DB.prepare("SELECT user_id, side, taps, assisted_taps FROM mash_taps WHERE entry_id=?").bind(id),
    ]);
    const row = battleResult.results[0] as BattleRow | undefined;
    const known = this.battles.get(id);
    if (!row || row.phase === "setup" || row.phase === "finished") {
      // Discard unwritten taps from restarted/deleted battles.
      this.dropBattle(id);
      return null;
    }
    if (known?.startsAt === row.starts_at) {
      known.phase = row.phase;
      known.endsAt = row.ends_at;
      known.writable = row.status === "active";
      this.startTicker();
      return known;
    }
    const sides = optionsFromJson(row.options).length;
    const battle: Battle = {
      id,
      sides,
      phase: row.phase,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      writable: row.status === "active",
      totals: Array.from({ length: sides }, (): number => 0),
      mine: new Map(),
      mineAssisted: new Map(),
      players: new Set(),
      assistedPlayers: new Set(),
      sideOf: new Map(),
      pending: new Set(),
      seqs: new Map(),
      recent: [],
      tickTaps: 0,
      dirty: true,
      flushing: false,
      finishing: false,
      lastFlush: Date.now(),
    };
    const count = (tap: TapRow, pending: boolean): void => {
      if (tap.side < sides) battle.totals[tap.side] += tap.taps - (battle.mine.get(tap.user_id) ?? 0);
      battle.mine.set(tap.user_id, tap.taps);
      battle.mineAssisted.set(tap.user_id, tap.assisted_taps);
      battle.sideOf.set(tap.user_id, Promise.resolve(tap.side));
      if (tap.taps > 0) battle.players.add(tap.user_id);
      if (tap.assisted_taps > 0) battle.assistedPlayers.add(tap.user_id);
      if (pending) battle.pending.add(tap.user_id);
    };
    for (const tap of tapResult.results as TapRow[]) count(tap, false);
    // Flush recovered taps not yet reflected in D1.
    const journal = this.ctx.storage.sql
      .exec<JournalRow>(
        "SELECT user_id, side, taps, assisted FROM tap_journal WHERE entry_id = ? AND starts_at IS ?",
        id,
        row.starts_at,
      )
      .toArray();
    for (const entry of journal) {
      if (entry.taps > (battle.mine.get(entry.user_id) ?? 0))
        count({ user_id: entry.user_id, side: entry.side, taps: entry.taps, assisted_taps: entry.assisted }, true);
    }
    this.ctx.storage.sql.exec("DELETE FROM tap_journal WHERE entry_id = ? AND starts_at IS NOT ?", id, row.starts_at);
    this.battles.set(id, battle);
    this.startTicker();
    return battle;
  }

  // Recover running battles and finish expired ones.
  private async resumeBattles(): Promise<void> {
    if (this.streamerId === undefined) return;
    const rows = await this.env.DB.prepare(`SELECT m.entry_id AS id FROM entry_mash m JOIN entries e ON e.id=m.entry_id
      WHERE e.streamer_id=? AND m.phase IN ('countdown','live')`)
      .bind(this.streamerId)
      .all<{ id: string }>();
    // Refresh remembered battles for deletion and page-status changes.
    const ids: Set<string> = new Set([...this.battles.keys(), ...rows.results.map(({ id }): string => id)]);
    for (const id of ids) await this.loadBattle(id);
    // Purge stopped-battle journals after restart; deleted pages/accounts never reach `dropBattle`, leaving
    // player IDs.
    this.ctx.storage.sql.exec(
      "DELETE FROM tap_journal WHERE entry_id NOT IN (SELECT value FROM json_each(?))",
      JSON.stringify([...this.battles.keys()]),
    );
    await this.tick();
  }

  // Forgets a battle that finished, restarted or was deleted, with its journal.
  private dropBattle(id: string): void {
    this.battles.delete(id);
    this.ctx.storage.sql.exec("DELETE FROM tap_journal WHERE entry_id = ?", id);
    this.stopTickerIfIdle();
  }

  private startTicker(): void {
    if (this.ticker !== undefined || this.battles.size === 0) return;
    this.ticker = setInterval((): void => {
      void this.tick().catch((): void => {
        console.error("mash_tick_failed");
      });
    }, MASH_TICK_MS);
  }

  // Tick only with watchers or pending taps, allowing hibernation. The end alarm still finishes unwatched
  // battles.
  private stopTickerIfIdle(): void {
    if (this.ticker === undefined) return;
    const busy = (battle: Battle): boolean => battle.pending.size > 0 || battle.flushing || battle.finishing;
    if (this.battles.size > 0 && (this.activeSockets().length > 0 || [...this.battles.values()].some(busy))) return;
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  // 5 Hz: broadcast live totals, write taps once a second, and end battles that ran out.
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickBattles();
    } finally {
      this.ticking = false;
      this.stopTickerIfIdle();
    }
  }

  private async tickBattles(): Promise<void> {
    this.ticks += 1;
    const now = Date.now();
    // finish() can drop a battle, so the loop walks a copy.
    const battles: Battle[] = [...this.battles.values()];
    for (const battle of battles) {
      const phase = mashPhaseAt(battle, now);
      battle.recent = [...battle.recent.slice(-4), battle.tickTaps];
      battle.tickTaps = 0;
      if (phase === "finished") {
        await this.finish(battle);
        continue;
      }
      if (phase === "live" && battle.phase === "countdown") {
        battle.phase = "live";
        battle.dirty = true;
        await this.env.DB.prepare(
          "UPDATE entry_mash SET phase='live' WHERE entry_id=? AND phase='countdown' AND starts_at IS ?",
        )
          .bind(battle.id, battle.startsAt)
          .run();
      }
      if (battle.dirty || this.ticks % 5 === 0) {
        battle.dirty = false;
        const message = JSON.stringify(this.mashTick(battle, phase, now));
        for (const socket of this.activeSockets()) this.send(socket, message);
      }
      if (now - battle.lastFlush >= MASH_FLUSH_MS) await this.flush(battle);
    }
  }

  private mashTick(battle: Battle, phase: MashPhase, now: number): MashTick {
    return {
      type: "mash",
      id: battle.id,
      phase,
      totals: battle.totals,
      left: secondsLeft(battle.endsAt, now),
      endsAt: battle.endsAt,
      players: battle.players.size,
      assisted: battle.assistedPlayers.size,
      tps: battle.recent.reduce((sum: number, taps: number): number => sum + taps, 0),
      serverNow: now,
    };
  }

  // Writes the taps counted since the last flush. On failure they stay pending for the next try.
  private async flush(battle: Battle): Promise<void> {
    battle.lastFlush = Date.now();
    if (battle.flushing || battle.pending.size === 0) return;
    battle.flushing = true;
    const users: string[] = [...battle.pending];
    battle.pending = new Set();
    const deltas: TapDelta[] = [];
    for (const userId of users) {
      const side = await battle.sideOf.get(userId);
      if (typeof side !== "number") continue;
      const taps: number = battle.mine.get(userId) ?? 0;
      deltas.push({ userId, side, taps, assisted: battle.mineAssisted.get(userId) ?? 0 });
    }
    try {
      const statements = tapUpserts(battle.id, battle.startsAt, deltas).map(({ sql, params }) =>
        this.env.DB.prepare(sql).bind(...params),
      );
      await this.env.DB.batch(statements);
    } catch (error: unknown) {
      console.error("mash_flush_failed", { cause: error instanceof Error ? error.name : "unknown" });
      for (const userId of users) battle.pending.add(userId);
    } finally {
      battle.flushing = false;
    }
  }

  // Flush before reading the winner from D1. On failure, retry next tick/alarm without finalizing partial
  // counts. Match the run start so a late finish cannot end a restarted battle.
  private async finish(battle: Battle): Promise<void> {
    if (battle.finishing) return;
    battle.finishing = true;
    try {
      await this.flush(battle);
      if (battle.pending.size > 0) await this.flush(battle);
      if (battle.pending.size > 0) {
        battle.finishing = false;
        return;
      }
      const sums = await this.env.DB.prepare(
        "SELECT side, sum(taps) AS taps FROM mash_taps WHERE entry_id=? GROUP BY side",
      )
        .bind(battle.id)
        .all<{ side: number; taps: number }>();
      const totals = Array.from({ length: battle.sides }, (_: unknown, side: number): number => {
        return sums.results.find((row) => row.side === side)?.taps ?? 0;
      });
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE entry_mash SET phase='finished', winner=?
            WHERE entry_id=? AND phase IN ('countdown','live') AND starts_at IS ?`,
        ).bind(mashWinner(totals), battle.id, battle.startsAt),
        this.env.DB.prepare("UPDATE streamers SET revision=revision+1 WHERE id=?").bind(this.streamerId),
      ]);
      this.dropBattle(battle.id);
      if (this.activeSockets().length > 0) this.broadcast(await this.snapshot());
    } catch {
      // The next tick or alarm tries again.
      battle.finishing = false;
      console.error("mash_finish_failed");
    }
  }

  // Share one D1 read across callers. `unchangedOk` checks page/overlay revisions first and reuses unchanged
  // snapshots.
  private async snapshot(unchangedOk = false): Promise<LiveSnapshot> {
    if (this.pendingSnapshot) return this.pendingSnapshot;
    const pending = unchangedOk ? this.reuseOrLoadSnapshot() : this.loadSnapshot();
    this.pendingSnapshot = pending;
    try {
      return await pending;
    } finally {
      this.pendingSnapshot = undefined;
    }
  }

  private async loadOverlay(): Promise<OverlayPublic> {
    const row = await this.env.DB.prepare(`SELECT ${OVERLAY_COLUMNS} FROM overlay_state WHERE streamer_id=?`)
      .bind(this.streamerId)
      .first<OverlayRow>();
    return overlayPublic(overlayValue(row));
  }

  private async reuseOrLoadSnapshot(): Promise<LiveSnapshot> {
    const latest = this.latestSnapshot;
    if (!latest) return this.loadSnapshot();
    const deadlinePassed = latest.polls.some(
      (poll): boolean =>
        !poll.revealed && poll.endsAt !== null && poll.endsAt > latest.serverNow && poll.endsAt <= Date.now(),
    );
    if (deadlinePassed) return this.loadSnapshot();
    // Overlay and page revisions are independent.
    const row = await this.env.DB.prepare(
      `SELECT s.revision, s.status, COALESCE(o.revision, 0) AS overlay_revision
       FROM streamers s LEFT JOIN overlay_state o ON o.streamer_id = s.id WHERE s.id = ?`,
    )
      .bind(this.streamerId)
      .first<{ revision: number; status: string; overlay_revision: number }>();
    if (row?.status === "suspended") throw new PageSuspended("Stream suspended");
    if (row?.revision !== latest.revision || row.overlay_revision !== latest.overlay?.revision)
      return this.loadSnapshot();
    return { ...latest, serverNow: Date.now() };
  }

  private async loadSnapshot(): Promise<LiveSnapshot> {
    if (this.streamerId === undefined) throw new Error("Unbound poll room");
    const [streamer, polls, overlay] = await this.env.DB.batch([
      this.env.DB.prepare("SELECT revision, status FROM streamers WHERE id = ?").bind(this.streamerId),
      this.env.DB.prepare(LIVE_POLLS_SQL).bind(this.streamerId, this.streamerId),
      this.env.DB.prepare(`SELECT ${OVERLAY_COLUMNS} FROM overlay_state WHERE streamer_id=?`).bind(this.streamerId),
    ]);
    const revisionRow = streamer.results[0] as { revision: number; status: string } | undefined;
    if (!revisionRow || !Number.isSafeInteger(revisionRow.revision) || revisionRow.revision < 0) {
      throw new Error("Stream unavailable");
    }
    // Suspension also hides data on existing sockets.
    if (revisionRow.status === "suspended") throw new PageSuspended("Stream suspended");
    this.overlay = overlayPublic(overlayValue(overlay.results[0] as OverlayRow | undefined));
    if (this.latestSnapshot && revisionRow.revision < this.latestSnapshot.revision)
      return { ...this.latestSnapshot, overlay: this.overlay };
    const snapshot: LiveSnapshot = {
      type: "snapshot",
      revision: revisionRow.revision,
      serverNow: Date.now(),
      polls: livePolls(polls.results as PollRow[]),
      overlay: this.overlay,
    };
    this.latestSnapshot = snapshot;
    return snapshot;
  }

  // Overlay unflushed battle totals on the snapshot.
  private withBattles(snapshot: LiveSnapshot): LiveSnapshot {
    if (this.battles.size === 0) return snapshot;
    return {
      ...snapshot,
      serverNow: Date.now(),
      polls: snapshot.polls.map((poll) => {
        const battle = this.battles.get(poll.id);
        if (!poll.mash || !battle) return poll;
        return {
          ...poll,
          mash: {
            ...poll.mash,
            totals: [...battle.totals],
            players: battle.players.size,
            assisted: battle.assistedPlayers.size,
          },
        };
      }),
    };
  }

  private broadcast(snapshot: LiveSnapshot): void {
    const message = JSON.stringify(this.withBattles(snapshot));
    for (const socket of this.activeSockets()) this.send(socket, message);
  }

  private send(socket: WebSocket, message: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(message);
    } catch {
      socket.close(1011, "Live connection failed");
    }
  }

  private disconnect(): void {
    for (const socket of this.activeSockets()) {
      this.send(socket, JSON.stringify({ type: "unavailable" }));
      if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Live updates unavailable");
    }
  }

  // The open sockets, all or those with one tag (`role:owner`, `role:anonymous`, `client:<key>`).
  private activeSockets(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((socket: WebSocket): boolean => socket.readyState === WebSocket.OPEN);
  }

  // Always admit owners. Anonymous sockets fill at most half the room; members/owners evict the oldest
  // anonymous socket when full.
  private admission(clientKey: string, role: SocketRole): { refusal: Response | null; evict: WebSocket | null } {
    const openedAt = (socket: WebSocket): number => this.lease(socket).openedAt;
    const anonymous = this.activeSockets("role:anonymous");
    const full = this.activeSockets().length >= MAX_CONNECTIONS;
    if (role === "owner") {
      const owners = this.activeSockets("role:owner");
      if (owners.length >= MAX_OWNER_CONNECTIONS) return { refusal: null, evict: oldest(owners, openedAt) };
      if (!full) return { refusal: null, evict: null };
      const evict = oldest(anonymous, openedAt) ?? oldest(this.activeSockets("role:member"), openedAt);
      return { refusal: null, evict };
    }
    if (this.activeSockets(`client:${clientKey}`).length >= MAX_CLIENT_CONNECTIONS) {
      return { refusal: response("Too many live connections from this client", 429), evict: null };
    }
    const evict = role === "member" && full ? oldest(anonymous, openedAt) : null;
    if ((role === "anonymous" && anonymous.length >= MAX_ANONYMOUS_CONNECTIONS) || (full && evict === null)) {
      console.warn("live_room_full");
      return { refusal: response("Stream is full", 503), evict: null };
    }
    return { refusal: null, evict };
  }

  private evict(socket: WebSocket): void {
    this.send(socket, JSON.stringify({ type: "unavailable" }));
    if (socket.readyState === WebSocket.OPEN) socket.close(1013, "Live room is full");
  }

  private lease(socket: WebSocket): ConnectionLease {
    const lease: unknown = socket.deserializeAttachment();
    if (
      typeof lease !== "object" ||
      lease === null ||
      !("expiresAt" in lease) ||
      typeof lease.expiresAt !== "number" ||
      !Number.isSafeInteger(lease.expiresAt)
    )
      return { expiresAt: 0, userId: null, openedAt: 0 };
    const userId = "userId" in lease && typeof lease.userId === "string" ? lease.userId : null;
    const openedAt = "openedAt" in lease && typeof lease.openedAt === "number" ? lease.openedAt : 0;
    return { expiresAt: lease.expiresAt, userId, openedAt };
  }

  private pruneConnectionCaches(now: number): void {
    for (const [id, until] of this.notLive) if (until <= now) this.notLive.delete(id);
    // Drop full buckets without sockets; keep partial ones so reconnects cannot reset quotas.
    const signedIn = new Set(this.activeSockets().map((socket: WebSocket): string | null => this.lease(socket).userId));
    for (const [userId, bucket] of this.buckets)
      if (!signedIn.has(userId) && now - bucket.at >= 1_000) this.buckets.delete(userId);
  }

  // Closes sockets whose lease ran out, and sockets that have not pinged for IDLE_TIMEOUT_MS.
  private expireConnections(): void {
    const now: number = Date.now();
    this.pruneConnectionCaches(now);
    for (const socket of this.activeSockets()) {
      const lease = this.lease(socket);
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0;
      const idle = now - Math.max(lease.openedAt, pinged) >= IDLE_TIMEOUT_MS;
      if (lease.expiresAt > now && !idle) continue;
      this.send(socket, JSON.stringify({ type: "unavailable" }));
      if (socket.readyState === WebSocket.OPEN)
        socket.close(1001, idle ? "Live connection idle" : "Live connection lease expired");
    }
  }

  private async scheduleResync(retry = false): Promise<void> {
    const sockets = this.activeSockets();
    const now = Date.now();
    let deadline = retry || sockets.length > 0 ? now + RESYNC_INTERVAL_MS : Number.POSITIVE_INFINITY;
    for (const socket of sockets) deadline = Math.min(deadline, this.lease(socket).expiresAt);
    if (sockets.length > 0) {
      for (const poll of this.latestSnapshot?.polls ?? []) {
        if (!poll.revealed && poll.endsAt !== null && poll.endsAt > now) deadline = Math.min(deadline, poll.endsAt);
      }
    }
    // End unwatched battles after eviction too.
    for (const battle of this.battles.values()) {
      if (battle.endsAt !== null) deadline = Math.min(deadline, Math.max(battle.endsAt, now + MASH_TICK_MS));
    }
    if (deadline === Number.POSITIVE_INFINITY) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > deadline) await this.ctx.storage.setAlarm(deadline);
  }
}
