import { DurableObject } from 'cloudflare:workers';
import type { AppEnv } from '../env';
import type { LiveSnapshot } from '../types';

const MAX_CONNECTIONS = 200;
const RESYNC_INTERVAL_MS = 15_000;
const STREAMER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PollRow {
  id: string;
  title: string;
  kind: 'choice' | 'binary';
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
}

function response(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function optionsFromJson(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 6
    || !parsed.every((option: unknown): option is string => typeof option === 'string' && option.length > 0 && option.length <= 80)) {
    throw new Error('Invalid stored poll options');
  }
  return parsed;
}

export class PollRoom extends DurableObject<AppEnv> {
  private streamerId: string | undefined;
  private latestSnapshot: LiveSnapshot | undefined;
  private pendingSnapshot: Promise<LiveSnapshot> | undefined;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async (): Promise<void> => {
      this.streamerId = await ctx.storage.get<string>('streamerId');
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const streamerId = url.searchParams.get('streamerId');
    if (url.searchParams.size !== 1 || !streamerId || !STREAMER_ID.test(streamerId)
      || this.ctx.id.toString() !== this.env.POLL_ROOMS.idFromName(streamerId).toString()
      || (this.streamerId !== undefined && this.streamerId !== streamerId)) {
      return response('Invalid stream', 400);
    }
    if (url.pathname !== '/subscribe' && url.pathname !== '/refresh') return response('Not found', 404);
    if (request.method !== (url.pathname === '/subscribe' ? 'GET' : 'POST')) return response('Method not allowed', 405);
    if (url.pathname === '/subscribe') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return response('WebSocket required', 426);
      const origin = request.headers.get('Origin');
      if (origin !== null && origin !== this.env.APP_ORIGIN) return response('Origin not allowed', 403);
      if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) return response('Stream is full', 503);
    }

    try {
      if (this.streamerId === undefined) {
        this.streamerId = streamerId;
        await this.ctx.storage.put('streamerId', streamerId);
      }
      if (url.pathname === '/refresh') {
        if (this.ctx.getWebSockets().length > 0) {
          const snapshot = await this.snapshot();
          this.broadcast(snapshot);
          await this.scheduleResync();
        }
        return new Response(null, { status: 204 });
      }

      const snapshot = await this.snapshot();
      if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) return response('Stream is full', 503);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.send(server, JSON.stringify(snapshot));
      await this.scheduleResync();
      return new Response(null, { status: 101, webSocket: client });
    } catch {
      this.disconnect();
      return response('Live updates unavailable', 503);
    }
  }

  webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): void {
    socket.close(1008, 'This stream is read-only');
  }

  async webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    socket.close();
    if (this.ctx.getWebSockets().length === 0) await this.ctx.storage.deleteAlarm();
  }

  webSocketError(socket: WebSocket, _error: unknown): void {
    socket.close(1011, 'Live connection failed');
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    try {
      this.broadcast(await this.snapshot());
      await this.scheduleResync();
    } catch (error: unknown) {
      this.disconnect();
      throw error;
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

  private async loadSnapshot(): Promise<LiveSnapshot> {
    if (this.streamerId === undefined) throw new Error('Unbound poll room');
    const [streamer, polls] = await this.env.DB.batch([
      this.env.DB.prepare('SELECT revision FROM streamers WHERE id = ?').bind(this.streamerId),
      this.env.DB.prepare(`
        WITH selected AS (
          SELECT id, title, kind, options, ends_at, revealed, created_at
          FROM entries WHERE streamer_id = ? AND kind IN ('choice', 'binary')
          ORDER BY created_at DESC, id DESC LIMIT 50
        )
        SELECT e.id, e.title, e.kind, e.options, e.ends_at, e.revealed,
          COUNT(v.user_id) AS total,
          SUM(CASE WHEN v.choice = 0 THEN 1 ELSE 0 END) AS count_0,
          SUM(CASE WHEN v.choice = 1 THEN 1 ELSE 0 END) AS count_1,
          SUM(CASE WHEN v.choice = 2 THEN 1 ELSE 0 END) AS count_2,
          SUM(CASE WHEN v.choice = 3 THEN 1 ELSE 0 END) AS count_3,
          SUM(CASE WHEN v.choice = 4 THEN 1 ELSE 0 END) AS count_4,
          SUM(CASE WHEN v.choice = 5 THEN 1 ELSE 0 END) AS count_5
        FROM selected e LEFT JOIN entry_votes v ON v.entry_id = e.id
        GROUP BY e.id ORDER BY e.created_at DESC, e.id DESC
      `).bind(this.streamerId),
    ]);
    const revisionRow = streamer.results[0] as { revision: number } | undefined;
    if (!revisionRow || !Number.isSafeInteger(revisionRow.revision) || revisionRow.revision < 0) {
      throw new Error('Stream unavailable');
    }
    if (this.latestSnapshot && revisionRow.revision < this.latestSnapshot.revision) return this.latestSnapshot;
    const snapshot: LiveSnapshot = {
      type: 'snapshot',
      revision: revisionRow.revision,
      serverNow: Date.now(),
      polls: (polls.results as unknown as PollRow[]).map((poll: PollRow) => {
        const options = optionsFromJson(poll.options);
        return {
          id: poll.id,
          title: poll.title,
          kind: poll.kind,
          options,
          endsAt: poll.ends_at,
          revealed: poll.revealed === 1,
          counts: poll.kind === 'binary' && poll.revealed !== 1 ? null
            : [poll.count_0, poll.count_1, poll.count_2, poll.count_3, poll.count_4, poll.count_5].slice(0, options.length),
          total: poll.total,
        };
      }),
    };
    this.latestSnapshot = snapshot;
    return snapshot;
  }

  private broadcast(snapshot: LiveSnapshot): void {
    const message = JSON.stringify(snapshot);
    for (const socket of this.ctx.getWebSockets()) this.send(socket, message);
  }

  private send(socket: WebSocket, message: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(message);
    } catch {
      socket.close(1011, 'Live connection failed');
    }
  }

  private disconnect(): void {
    for (const socket of this.ctx.getWebSockets()) {
      this.send(socket, JSON.stringify({ type: 'unavailable' }));
      if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Live updates unavailable');
    }
  }

  private async scheduleResync(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    let deadline = now + RESYNC_INTERVAL_MS;
    for (const poll of this.latestSnapshot?.polls ?? []) {
      if (!poll.revealed && poll.endsAt !== null && poll.endsAt > now) deadline = Math.min(deadline, poll.endsAt);
    }
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > deadline) await this.ctx.storage.setAlarm(deadline);
  }
}
