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
import { MASH_COLUMN, mashValue, notFinishedBattle } from "./mash-sql";
import { OVERLAY_COLUMNS, overlayPublic, overlayValue, type OverlayRow } from "./overlay-state";

/** The most sockets one room holds. */
const MAX_CONNECTIONS = 200;
/** Signed-out sockets may fill at most half the room, so signed-in viewers always find a seat. */
const MAX_ANONYMOUS_CONNECTIONS = 100;
/** Sockets per client address (an IPv4 address or an IPv6 /64, hashed by the Worker). */
const MAX_CLIENT_CONNECTIONS = 10;
/** The page owner is always admitted. Past this many owner sockets, the owner's oldest one makes way. */
const MAX_OWNER_CONNECTIONS = 10;
const CONNECTION_LEASE_MS = 60 * 60 * 1_000;
/** A socket that has not pinged for this long is closed. Clients ping every 20 seconds. */
const IDLE_TIMEOUT_MS = 60_000;
const CLIENT_KEY = /^[0-9a-f]{64}$/;
const USER_ID = /^[\w-]{1,100}$/;
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESYNC_INTERVAL_MS = 15_000;
const STREAMER_ID = ENTRY_ID;
const MAX_MESSAGE_LENGTH = 256;
/** A tap for a battle that is not live does not look it up again for this long. */
const NOT_LIVE_CACHE_MS = 2_000;
const ROOM_PATHS: Readonly<Record<string, "GET" | "POST">> = {
  "/subscribe": "GET",
  "/refresh": "POST",
  "/mash": "POST",
  "/overlay": "POST",
  "/overlay-key": "POST",
};

/** The socket attachment: when the lease ends, the signed-in account the Worker vouched for, and when it opened. */
interface ConnectionLease {
  expiresAt: number;
  userId: string | null;
  openedAt: number;
}

/** Who holds a socket. The owner is always admitted; signed-out sockets are the first to make way. */
type SocketRole = "owner" | "member" | "anonymous";

/** A page that is suspended: its room closes every socket and shows nothing. */
class PageSuspended extends Error {}

interface TapMessage {
  t: "tap";
  id: string;
  n: number;
  assisted: boolean;
  seq: number;
}

/**
 * A battle in countdown or live, held in memory so taps never wait on D1. Accepted taps wait in `pending` for up
 * to one second (MASH_FLUSH_MS) before they are written. If the runtime evicts or restarts the room in that second
 * (a deploy, for example), those taps are lost even though they were acknowledged. This is a known limit: the
 * room keeps them in memory only, so taps never wait on storage.
 */
interface Battle {
  id: string;
  sides: number;
  phase: MashPhase;
  startsAt: number | null;
  endsAt: number | null;
  writable: boolean;
  /** Durable taps at load plus every tap counted since. */
  totals: number[];
  mine: Map<string, number>;
  players: Set<string>;
  assistedPlayers: Set<string>;
  sideOf: Map<string, Promise<number | null>>;
  pending: Map<string, TapDelta>;
  seqs: Map<WebSocket, number>;
  /** Taps counted in each of the last five ticks, for the host's taps a second. */
  recent: number[];
  tickTaps: number;
  dirty: boolean;
  flushing: boolean;
  finishing: boolean;
  lastFlush: number;
}

type PollRow = {
  id: string;
  title: string;
  kind: "choice" | "binary";
  options: string;
  ends_at: number | null;
  revealed: number;
  total: number;
  count_0: number;
  count_1: number;
  count_2: number;
  count_3: number;
  count_4: number;
  count_5: number;
  mash: string | null;
};

type BattleRow = {
  duration_s: number;
  phase: MashPhase;
  starts_at: number | null;
  ends_at: number | null;
  options: string;
  status: string;
};

type TapRow = { user_id: string; side: number; taps: number; assisted_taps: number };

function response(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function optionsFromJson(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length < 2 ||
    parsed.length > 6 ||
    !parsed.every(
      (option: unknown): option is string => typeof option === "string" && option.length > 0 && option.length <= 80,
    )
  ) {
    throw new Error("Invalid stored poll options");
  }
  return parsed;
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
  // A larger batch (taps that piled up while the socket reconnected) is cut to one message's worth. The token
  // bucket then decides how many count.
  return { t, id, n: Math.min(n, MASH_MAX_BATCH), assisted, seq };
}

/** The socket that opened first, or null for none. */
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
  /** One bucket per account, shared by all of its sockets. */
  private readonly buckets = new Map<string, TokenBucket>();
  private ticker: ReturnType<typeof setInterval> | undefined;
  private ticks = 0;
  private ticking = false;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async (): Promise<void> => {
      this.streamerId = await ctx.storage.get<string>("streamerId");
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const streamerId = url.searchParams.get("streamerId");
    if (
      url.searchParams.size !== 1 ||
      !streamerId ||
      !STREAMER_ID.test(streamerId) ||
      this.ctx.id.toString() !== this.env.POLL_ROOMS.idFromName(streamerId).toString() ||
      (this.streamerId !== undefined && this.streamerId !== streamerId)
    ) {
      return response("Invalid stream", 400);
    }
    const method = ROOM_PATHS[url.pathname];
    if (!method) return response("Not found", 404);
    if (request.method !== method) return response("Method not allowed", 405);
    const clientKey = request.headers.get("X-Stream-Bullets-Client") ?? "";
    const userId = request.headers.get("X-SB-User");
    let role: SocketRole = userId === null ? "anonymous" : "member";
    if (userId !== null && request.headers.get("X-SB-Owner") === "1") role = "owner";
    // The Worker sets this only for a valid overlay key: the OBS source is the owner's, signed in or not.
    const overlayKey = request.headers.get("X-SB-Overlay") === "1";
    if (overlayKey) role = "owner";
    if (url.pathname === "/subscribe") {
      const invalidSubscription = this.validateSubscription(request, clientKey, userId, role);
      if (invalidSubscription) return invalidSubscription;
    }

    try {
      if (this.streamerId === undefined) {
        this.streamerId = streamerId;
        await this.ctx.storage.put("streamerId", streamerId);
      }
      if (url.pathname === "/refresh") return await this.refresh();
      if (url.pathname === "/mash") return await this.mashChanged(request);
      if (url.pathname === "/overlay") return await this.overlayChanged();
      if (url.pathname === "/overlay-key") return this.overlayKeyRevoked();

      const snapshot = await this.snapshot();
      this.expireConnections();
      // Checked again after the await: other subscriptions may have taken seats meanwhile.
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
      await this.scheduleResync();
      return new Response(null, { status: 101, webSocket: client });
    } catch (error: unknown) {
      this.disconnect();
      if (!(error instanceof PageSuspended)) return response("Live updates unavailable", 503);
      return url.pathname === "/subscribe" ? response("Stream not found", 404) : new Response(null, { status: 204 });
    }
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

  private async refresh(): Promise<Response> {
    this.expireConnections();
    // A page status change (frozen, suspended) also stops its battles. loadBattle can drop a battle, so the loop
    // walks a copy of the ids.
    const ids: string[] = [...this.battles.keys()];
    for (const id of ids) await this.loadBattle(id);
    if (this.activeSockets().length > 0) {
      const snapshot = await this.snapshot();
      this.broadcast(snapshot);
    }
    await this.scheduleResync();
    return new Response(null, { status: 204 });
  }

  /** The API changed a battle (start, end, restart): reload it from D1 and tell everyone. */
  private async mashChanged(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch((): null => null);
    const id = typeof body === "object" && body !== null && "id" in body ? body.id : null;
    if (typeof id !== "string" || !ENTRY_ID.test(id)) return response("Invalid battle", 400);
    this.notLive.delete(id);
    await this.loadBattle(id);
    return this.refresh();
  }

  /** The owner made a new overlay key: sockets that came in with the old one reconnect and lose the owner's seat. */
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

  async alarm(): Promise<void> {
    this.expireConnections();
    await this.resumeBattles();
    if (this.activeSockets().length === 0) {
      await this.scheduleResync();
      return;
    }
    try {
      this.broadcast(await this.snapshot());
      await this.scheduleResync();
    } catch (error: unknown) {
      this.disconnect();
      if (!(error instanceof PageSuspended)) throw error;
      await this.scheduleResync();
    }
  }

  /** Counts one batch of taps. Returns the reply for this socket, or null to stay silent. */
  private async tap(socket: WebSocket, message: TapMessage): Promise<object | null> {
    const lease = this.lease(socket);
    if (!lease.userId) return { type: "mash-denied", id: message.id, reason: "sign-in" };
    const userId = lease.userId;
    const battle = await this.battleFor(message.id);
    if (!battle || !battle.writable || battle.finishing || mashPhaseAt(battle, Date.now()) !== "live")
      return { type: "mash-denied", id: message.id, reason: "closed" };
    // Each socket numbers its batches; a batch seen before (a resend) never counts twice.
    if (message.seq <= (battle.seqs.get(socket) ?? -1)) return null;
    battle.seqs.set(socket, message.seq);
    const pick = await this.sideFor(battle, userId);
    // The lookup failed (a D1 error). Nothing is cached, so the next batch looks again.
    if (pick === undefined) return null;
    if (pick === null || pick >= battle.sides) return { type: "mash-denied", id: message.id, reason: "pick" };
    const now = Date.now();
    if (battle.finishing || mashPhaseAt(battle, now) !== "live") return null;
    const { bucket, accepted } = takeTaps(this.buckets.get(userId), message.n, message.assisted, now);
    this.buckets.set(userId, bucket);
    if (accepted > 0) {
      battle.totals[pick] += accepted;
      battle.mine.set(userId, (battle.mine.get(userId) ?? 0) + accepted);
      battle.players.add(userId);
      if (message.assisted) battle.assistedPlayers.add(userId);
      const delta = battle.pending.get(userId) ?? { userId, side: pick, taps: 0, assisted: 0 };
      delta.taps += accepted;
      if (message.assisted) delta.assisted += accepted;
      battle.pending.set(userId, delta);
      battle.tickTaps += accepted;
      battle.dirty = true;
    }
    return { type: "mash-ack", id: battle.id, mine: battle.mine.get(userId) ?? 0, accepted };
  }

  /** The side this account picked, cached for the battle. Undefined when the lookup failed; a failure is not cached. */
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

  /** The battle in memory, or loaded from D1 when it is live but this room just woke up. */
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
      // Restarted or deleted: unwritten taps belong to a battle that no longer exists.
      this.battles.delete(id);
      this.stopTickerIfIdle();
      return null;
    }
    if (known && known.startsAt === row.starts_at) {
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
      players: new Set(),
      assistedPlayers: new Set(),
      sideOf: new Map(),
      pending: new Map(),
      seqs: new Map(),
      recent: [],
      tickTaps: 0,
      dirty: true,
      flushing: false,
      finishing: false,
      lastFlush: Date.now(),
    };
    for (const tap of tapResult.results as TapRow[]) {
      if (tap.side < sides) battle.totals[tap.side] += tap.taps;
      battle.mine.set(tap.user_id, tap.taps);
      battle.sideOf.set(tap.user_id, Promise.resolve(tap.side));
      if (tap.taps > 0) battle.players.add(tap.user_id);
      if (tap.assisted_taps > 0) battle.assistedPlayers.add(tap.user_id);
    }
    this.battles.set(id, battle);
    this.startTicker();
    return battle;
  }

  /** After a restart of the room: pick up battles that are still running, and end the ones that ran out. */
  private async resumeBattles(): Promise<void> {
    if (this.streamerId === undefined) return;
    const rows = await this.env.DB.prepare(`SELECT m.entry_id AS id FROM entry_mash m JOIN entries e ON e.id=m.entry_id
      WHERE e.streamer_id=? AND m.phase IN ('countdown','live')`)
      .bind(this.streamerId)
      .all<{ id: string }>();
    for (const { id } of rows.results) await this.loadBattle(id);
    await this.tick();
  }

  private startTicker(): void {
    if (this.ticker !== undefined || this.battles.size === 0) return;
    this.ticker = setInterval((): void => {
      void this.tick().catch((): void => {
        console.error("mash_tick_failed");
      });
    }, MASH_TICK_MS);
  }

  private stopTickerIfIdle(): void {
    if (this.battles.size > 0 || this.ticker === undefined) return;
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  /** 5 Hz: broadcast live totals, write taps once a second, and end battles that ran out. */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickBattles();
    } finally {
      this.ticking = false;
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

  /** Writes the taps counted since the last flush. On failure they stay pending for the next try. */
  private async flush(battle: Battle): Promise<void> {
    battle.lastFlush = Date.now();
    if (battle.flushing || battle.pending.size === 0) return;
    battle.flushing = true;
    const deltas = [...battle.pending.values()];
    battle.pending = new Map();
    try {
      const statements = tapUpserts(battle.id, battle.startsAt, deltas).map(({ sql, params }) =>
        this.env.DB.prepare(sql).bind(...params),
      );
      await this.env.DB.batch(statements);
    } catch {
      console.error("mash_flush_failed");
      for (const delta of deltas) {
        const merged = battle.pending.get(delta.userId);
        if (merged) {
          merged.taps += delta.taps;
          merged.assisted += delta.assisted;
        } else battle.pending.set(delta.userId, delta);
      }
    } finally {
      battle.flushing = false;
    }
  }

  /**
   * Ends a battle: last flush, winner from D1, then a fresh snapshot for everyone. While taps are still unwritten
   * (D1 failed), the battle stays open and the next tick or alarm tries again, so the winner never comes from
   * partial counts. The updates match this run's start only, so a late finish never ends a restarted battle.
   */
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
      this.battles.delete(battle.id);
      this.stopTickerIfIdle();
      if (this.activeSockets().length > 0) this.broadcast(await this.snapshot());
    } catch {
      // The next tick or alarm tries again.
      battle.finishing = false;
      console.error("mash_finish_failed");
    }
  }

  private async snapshot(): Promise<LiveSnapshot> {
    if (this.pendingSnapshot) return this.pendingSnapshot;
    const pending = this.loadSnapshot();
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

  private async loadSnapshot(): Promise<LiveSnapshot> {
    if (this.streamerId === undefined) throw new Error("Unbound poll room");
    const [streamer, polls, overlay] = await this.env.DB.batch([
      this.env.DB.prepare("SELECT revision, status FROM streamers WHERE id = ?").bind(this.streamerId),
      this.env.DB.prepare(`
        WITH recent AS (
          SELECT id, title, kind, options, ends_at, revealed, created_at
          FROM entries WHERE streamer_id = ? AND kind IN ('choice', 'binary')
          ORDER BY created_at DESC, id DESC LIMIT 50
        ), active AS (
          SELECT id, title, kind, options, ends_at, revealed, created_at
          FROM entries WHERE streamer_id = ? AND kind IN ('choice', 'binary')
            AND revealed = 0 AND (ends_at IS NULL OR ends_at > unixepoch('subsec') * 1000)
            AND ${notFinishedBattle("unixepoch('subsec') * 1000")}
          ORDER BY created_at DESC, id DESC LIMIT 1
        ), selected AS (
          SELECT * FROM (SELECT * FROM recent UNION SELECT * FROM active)
          ORDER BY (id = (SELECT id FROM active)) DESC, created_at DESC, id DESC LIMIT 50
        )
        SELECT e.id, e.title, e.kind, e.options, e.ends_at, e.revealed,
          COUNT(v.user_id) AS total,
          SUM(CASE WHEN v.choice = 0 THEN 1 ELSE 0 END) AS count_0,
          SUM(CASE WHEN v.choice = 1 THEN 1 ELSE 0 END) AS count_1,
          SUM(CASE WHEN v.choice = 2 THEN 1 ELSE 0 END) AS count_2,
          SUM(CASE WHEN v.choice = 3 THEN 1 ELSE 0 END) AS count_3,
          SUM(CASE WHEN v.choice = 4 THEN 1 ELSE 0 END) AS count_4,
          SUM(CASE WHEN v.choice = 5 THEN 1 ELSE 0 END) AS count_5,
          ${MASH_COLUMN}
        FROM selected e LEFT JOIN entry_votes v ON v.entry_id = e.id
        GROUP BY e.id ORDER BY e.created_at DESC, e.id DESC
      `).bind(this.streamerId, this.streamerId),
      this.env.DB.prepare(`SELECT ${OVERLAY_COLUMNS} FROM overlay_state WHERE streamer_id=?`).bind(this.streamerId),
    ]);
    const revisionRow = streamer.results[0] as { revision: number; status: string } | undefined;
    if (!revisionRow || !Number.isSafeInteger(revisionRow.revision) || revisionRow.revision < 0) {
      throw new Error("Stream unavailable");
    }
    // A suspended page shows nothing live, also on sockets that opened before the suspension.
    if (revisionRow.status === "suspended") throw new PageSuspended("Stream suspended");
    this.overlay = overlayPublic(overlayValue(overlay.results[0] as OverlayRow | undefined));
    if (this.latestSnapshot && revisionRow.revision < this.latestSnapshot.revision)
      return { ...this.latestSnapshot, overlay: this.overlay };
    const snapshot: LiveSnapshot = {
      type: "snapshot",
      revision: revisionRow.revision,
      serverNow: Date.now(),
      polls: (polls.results as PollRow[]).map((poll: PollRow) => {
        const options = optionsFromJson(poll.options);
        const mash = mashValue(poll.mash, options.length);
        return {
          id: poll.id,
          title: poll.title,
          kind: mash ? "mash" : poll.kind,
          options,
          endsAt: poll.ends_at,
          revealed: poll.revealed === 1,
          counts:
            poll.kind === "binary" && poll.revealed !== 1
              ? null
              : [poll.count_0, poll.count_1, poll.count_2, poll.count_3, poll.count_4, poll.count_5].slice(
                  0,
                  options.length,
                ),
          total: poll.total,
          mash,
        };
      }),
      overlay: this.overlay,
    };
    this.latestSnapshot = snapshot;
    return snapshot;
  }

  /** The snapshot with the in-memory totals of running battles, which D1 has not seen yet. */
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

  /** The open sockets, all or those with one tag (`role:owner`, `role:anonymous`, `client:<key>`). */
  private activeSockets(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((socket: WebSocket): boolean => socket.readyState === WebSocket.OPEN);
  }

  /**
   * Whether a new socket may join, and which socket makes way for it. The owner always gets in. Signed-out sockets
   * fill at most half the room, and when the room is full a signed-in viewer or the owner takes the seat of the
   * oldest signed-out socket.
   */
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

  /** Closes sockets whose lease ran out, and sockets that have not pinged for IDLE_TIMEOUT_MS. */
  private expireConnections(): void {
    const now = Date.now();
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

  private async scheduleResync(): Promise<void> {
    const sockets = this.activeSockets();
    const now = Date.now();
    let deadline = sockets.length > 0 ? now + RESYNC_INTERVAL_MS : Number.POSITIVE_INFINITY;
    for (const socket of sockets) deadline = Math.min(deadline, this.lease(socket).expiresAt);
    if (sockets.length > 0) {
      for (const poll of this.latestSnapshot?.polls ?? []) {
        if (!poll.revealed && poll.endsAt !== null && poll.endsAt > now) deadline = Math.min(deadline, poll.endsAt);
      }
    }
    // A running battle ends on time even when nobody watches and the room was evicted.
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
