import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import type { LiveSnapshot } from "../app/types";
import { LIVE_SCHEMA, liveRows } from "./helpers/room";

type LiveSocket = NonNullable<Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]>;
type Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;

let runtime: Miniflare;
let database: Database;
let streamerId: string;
const sockets: LiveSocket[] = [];
const origin = "https://streambullets.test";
const clientKey = "a".repeat(64);
const rows = liveRows(
  () => database as unknown as D1Database,
  () => streamerId,
);

function nextSnapshot(socket: LiveSocket): Promise<LiveSnapshot> {
  return new Promise((resolve, reject): void => {
    const timeout = setTimeout((): void => reject(new Error("Snapshot timed out")), 5_000);
    socket.addEventListener(
      "message",
      (event): void => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(String(event.data)) as LiveSnapshot);
        } catch (error: unknown) {
          reject(error);
        }
      },
      { once: true },
    );
  });
}

function nextClose(socket: LiveSocket): Promise<number> {
  return new Promise((resolve, reject): void => {
    const timeout = setTimeout((): void => reject(new Error("Close timed out")), 5_000);
    socket.addEventListener(
      "close",
      (event): void => {
        clearTimeout(timeout);
        resolve(event.code);
      },
      { once: true },
    );
  });
}

function request(
  path: string,
  method: string = "POST",
  room: string = streamerId,
  key: string = clientKey,
): ReturnType<Miniflare["dispatchFetch"]> {
  return runtime.dispatchFetch(`${origin}/${room}/${path}?streamerId=${streamerId}`, {
    method,
    headers: { "X-Stream-Bullets-Client": key },
  });
}

async function connect(key: string = clientKey): Promise<{ socket: LiveSocket; snapshot: LiveSnapshot }> {
  const result = await runtime.dispatchFetch(`${origin}/${streamerId}/subscribe?streamerId=${streamerId}`, {
    headers: { Upgrade: "websocket", Origin: origin, "X-Stream-Bullets-Client": key },
  });
  expect(result.status).toBe(101);
  const socket = result.webSocket;
  if (!socket) throw new Error("Missing WebSocket");
  sockets.push(socket);
  const first = nextSnapshot(socket);
  socket.accept();
  return { socket, snapshot: await first };
}

/** Waits for the next message that matches, skipping snapshots and ticks it does not want. */
function nextMessage<T extends { type: string }>(
  socket: LiveSocket,
  match: (message: T) => boolean,
  timeoutMs: number = 5_000,
): Promise<T> {
  return new Promise((resolve, reject): void => {
    const listener = (event: { data: unknown }): void => {
      const message = JSON.parse(String(event.data)) as T;
      if (!match(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      resolve(message);
    };
    const timeout = setTimeout((): void => {
      socket.removeEventListener("message", listener);
      reject(new Error("Message timed out"));
    }, timeoutMs);
    socket.addEventListener("message", listener);
  });
}

type MashReply = { type: string; id: string; mine?: number; accepted?: number; reason?: string };

function mashReply(socket: LiveSocket): Promise<MashReply> {
  return nextMessage<MashReply>(socket, (message) => message.type === "mash-ack" || message.type === "mash-denied");
}

async function connectAs(
  userId: string | null,
  key: string = clientKey,
): Promise<{ socket: LiveSocket; snapshot: LiveSnapshot }> {
  const headers: Record<string, string> = { Upgrade: "websocket", Origin: origin, "X-Stream-Bullets-Client": key };
  if (userId) headers["X-SB-User"] = userId;
  const result = await runtime.dispatchFetch(`${origin}/${streamerId}/subscribe?streamerId=${streamerId}`, { headers });
  expect(result.status).toBe(101);
  const socket = result.webSocket;
  if (!socket) throw new Error("Missing WebSocket");
  sockets.push(socket);
  const first = nextSnapshot(socket);
  socket.accept();
  return { socket, snapshot: await first };
}

/** A distinct client key for socket number `index`. */
function seat(index: number): string {
  return index.toString(16).padStart(64, "0");
}

/** Opens `count` subscriptions at once, each with its client key, account and owner flag, and accepts the sockets. */
async function subscribeMany(
  count: number,
  spec: (index: number) => { key: string; user?: string; owner?: boolean },
): Promise<Awaited<ReturnType<Miniflare["dispatchFetch"]>>[]> {
  const responses = await Promise.all(
    Array.from({ length: count }, (_, index) => {
      const { key, user, owner } = spec(index);
      const headers: Record<string, string> = { Upgrade: "websocket", "X-Stream-Bullets-Client": key };
      if (user) headers["X-SB-User"] = user;
      if (owner) headers["X-SB-Owner"] = "1";
      return runtime.dispatchFetch(`${origin}/${streamerId}/subscribe?streamerId=${streamerId}`, { headers });
    }),
  );
  for (const result of responses) {
    if (result.webSocket) {
      sockets.push(result.webSocket);
      result.webSocket.accept();
    }
  }
  return responses;
}

/** How many sockets the room holds open, all of them or one client's. */
async function openCount(key: string = ""): Promise<number> {
  return (await (await request("open-count", "POST", streamerId, key)).json()) as number;
}

/** The next message as text, without parsing it. */
function nextRaw(socket: LiveSocket): Promise<string> {
  return new Promise((resolve): void => {
    socket.addEventListener("message", (event): void => resolve(String(event.data)), { once: true });
  });
}

function tap(socket: LiveSocket, id: string, n: number, seq: number, assisted: boolean = false): void {
  socket.send(JSON.stringify({ t: "tap", id, n, assisted, seq }));
}

beforeAll(async (): Promise<void> => {
  const modulePath = fileURLToPath(new URL("../app/server/poll-room.ts", import.meta.url));
  const bundle = await build({
    stdin: {
      contents: `
        import { PollRoom } from ${JSON.stringify(modulePath)};
        export class TestPollRoom extends PollRoom {
          async invokeAlarm() { await this.alarm(); }
          async alarmAt() { return this.ctx.storage.getAlarm(); }
          async leaseAt(key) {
            return this.ctx.getWebSockets('client:' + key)[0].deserializeAttachment().expiresAt;
          }
          async expireClient(key) {
            for (const socket of this.ctx.getWebSockets('client:' + key)) socket.serializeAttachment({ expiresAt: Date.now() - 1 });
          }
          async openCount(key) {
            return this.ctx.getWebSockets(key ? 'client:' + key : undefined).filter((socket) => socket.readyState === 1).length;
          }
          async ageClient(key) {
            for (const socket of this.ctx.getWebSockets('client:' + key)) {
              socket.serializeAttachment({ ...socket.deserializeAttachment(), openedAt: Date.now() - 120000 });
            }
          }
        }
        export default {
          async fetch(request, env) {
            const url = new URL(request.url);
            const [, room, path] = url.pathname.split('/');
            const stub = env.POLL_ROOMS.get(env.POLL_ROOMS.idFromName(room));
            if (path === 'alarm') { await stub.invokeAlarm(); return new Response(null, { status: 204 }); }
            if (path === 'alarm-at') return Response.json(await stub.alarmAt());
            const key = request.headers.get('X-Stream-Bullets-Client');
            if (path === 'lease-at') return Response.json(await stub.leaseAt(key));
            if (path === 'expire-client') { await stub.expireClient(key); return new Response(null, { status: 204 }); }
            if (path === 'open-count') return Response.json(await stub.openCount(key));
            if (path === 'age-client') { await stub.ageClient(key); return new Response(null, { status: 204 }); }
            url.pathname = '/' + path;
            return stub.fetch(new Request(url, request));
          }
        };
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["cloudflare:workers"],
  });
  runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-05-15",
    durableObjects: { POLL_ROOMS: { className: "TestPollRoom", useSQLite: true } },
    d1Databases: { DB: "realtime" },
    bindings: { APP_ORIGIN: origin },
  });
  database = await runtime.getD1Database("DB");
  await database.exec(LIVE_SCHEMA.trim());
});

beforeEach(async (): Promise<void> => {
  streamerId = crypto.randomUUID();
  await database.prepare("INSERT INTO streamers (id) VALUES (?)").bind(streamerId).run();
});

afterEach((): void => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === 1) socket.close(1000, "Test complete");
  }
});

afterAll(async (): Promise<void> => {
  await runtime?.dispose();
});

describe("public poll updates", (): void => {
  it("sends current votes at subscribe and pushes committed updates to every viewer", async (): Promise<void> => {
    const id = await rows.addPoll();
    await rows.vote(id, 0);
    const first = await connect();
    const second = await connect();
    expect(first.snapshot.polls[0]).toMatchObject({ id, counts: [1, 0], total: 1 });
    expect(second.snapshot.revision).toBe(1);

    const firstUpdate = nextSnapshot(first.socket);
    const secondUpdate = nextSnapshot(second.socket);
    await rows.vote(id, 1);
    expect((await request("refresh")).status).toBe(204);
    const updates = await Promise.all([firstUpdate, secondUpdate]);
    for (const snapshot of updates) {
      expect(snapshot.revision).toBe(2);
      expect(snapshot.polls[0]).toMatchObject({ counts: [1, 1], total: 2 });
    }
  });

  it("does not disclose exact binary results or account identity before reveal", async (): Promise<void> => {
    const id = await rows.addPoll("binary");
    await rows.vote(id, 0);
    const { socket, snapshot } = await connect();
    expect(snapshot.polls[0].counts).toBeNull();
    expect(Object.keys(snapshot.polls[0]).sort()).toEqual([
      "counts",
      "endsAt",
      "id",
      "kind",
      "mash",
      "options",
      "revealed",
      "title",
      "total",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/userId|authorId|email|myVote|score/);
    const update = nextSnapshot(socket);
    await database.batch([
      database.prepare("UPDATE entries SET revealed = 1 WHERE id = ?").bind(id),
      database.prepare("UPDATE streamers SET revision = revision + 1 WHERE id = ?").bind(streamerId),
    ]);
    await request("refresh");
    expect((await update).polls[0]).toMatchObject({ revealed: true, counts: [1, 0] });
  });

  it("repairs a missed mutation notification during the scheduled resync", async (): Promise<void> => {
    const id = await rows.addPoll();
    const { socket } = await connect();
    const update = nextSnapshot(socket);
    await rows.vote(id, 1);
    expect((await request("alarm")).status).toBe(204);
    expect((await update).polls[0]).toMatchObject({ counts: [0, 1], total: 1 });
  });

  it("loads durable votes for a reconnect instead of relying on the previous socket state", async (): Promise<void> => {
    const id = await rows.addPoll();
    const first = await connect();
    first.socket.close(1000, "Reconnect");
    await rows.vote(id, 1);
    const second = await connect();
    expect(second.snapshot.revision).toBe(1);
    expect(second.snapshot.polls[0].counts).toEqual([0, 1]);
  });

  it("schedules the next deadline and leaves unlimited polls open", async (): Promise<void> => {
    const deadline = Date.now() + 8_000;
    const timed = await rows.addPoll("choice", deadline);
    const unlimited = await rows.addPoll("binary");
    const { snapshot } = await connect();
    expect(snapshot.polls.find((poll) => poll.id === timed)?.endsAt).toBe(deadline);
    expect(snapshot.polls.find((poll) => poll.id === unlimited)?.endsAt).toBeNull();
    const alarm: unknown = await (await request("alarm-at")).json();
    expect(alarm).toBe(deadline);
  });

  it("bounds snapshots to fifty polls and excludes topics and other streamers", async (): Promise<void> => {
    const inserts = Array.from({ length: 51 }, (_, index) =>
      database
        .prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, NULL, 0, ?)")
        .bind(crypto.randomUUID(), streamerId, `Poll ${index}`, "choice", '["A","B"]', index),
    );
    inserts.push(
      database
        .prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, NULL, 0, ?)")
        .bind(crypto.randomUUID(), streamerId, "Topic", "topic", "[]", 100),
    );
    inserts.push(
      database
        .prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, NULL, 0, ?)")
        .bind(crypto.randomUUID(), crypto.randomUUID(), "Private scope", "choice", '["A","B"]', 100),
    );
    await database.batch(inserts);
    const { snapshot } = await connect();
    expect(snapshot.polls).toHaveLength(50);
    expect(snapshot.polls[0].title).toBe("Poll 50");
    expect(snapshot.polls.at(-1)?.title).toBe("Poll 1");
  });

  it("retains an old active poll beyond fifty newer results and falls back after reveal", async (): Promise<void> => {
    const active = await rows.addPoll("binary");
    await database.prepare("UPDATE entries SET created_at = 1 WHERE id = ?").bind(active).run();
    await rows.vote(active, 0);
    const newest = crypto.randomUUID();
    await database.batch(
      Array.from({ length: 50 }, (_, index) =>
        database
          .prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, NULL, 1, ?)")
          .bind(
            index === 49 ? newest : crypto.randomUUID(),
            streamerId,
            `Result ${index}`,
            "choice",
            '["A","B"]',
            index + 2,
          ),
      ),
    );
    const { socket, snapshot } = await connect();
    expect(snapshot.polls).toHaveLength(50);
    expect(snapshot.polls[0].id).toBe(newest);
    expect(snapshot.polls.at(-1)).toMatchObject({ id: active, revealed: false, counts: null });
    expect(snapshot.polls.filter((poll) => !poll.revealed).map((poll) => poll.id)).toEqual([active]);

    const update = nextSnapshot(socket);
    await database.batch([
      database.prepare("UPDATE entries SET revealed = 1 WHERE id = ?").bind(active),
      database.prepare("UPDATE streamers SET revision = revision + 1 WHERE id = ?").bind(streamerId),
    ]);
    await request("refresh");
    const revealed = await update;
    expect(revealed.polls).toHaveLength(50);
    expect(revealed.polls.every((poll) => poll.revealed)).toBe(true);
    expect(revealed.polls.some((poll) => poll.id === active)).toBe(false);
    expect(revealed.polls[0].id).toBe(newest);
  });

  it("rejects messages that try to mutate the read-only stream", async (): Promise<void> => {
    const id = await rows.addPoll();
    const { socket } = await connect();
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ action: "vote", id, choice: 0 }));
    expect(await closed).toBe(1008);
    expect(
      await database.prepare("SELECT COUNT(*) AS count FROM entry_votes WHERE entry_id = ?").bind(id).first("count"),
    ).toBe(0);
  });

  it("rejects another stream ID for the same object and cross-origin browser connections", async (): Promise<void> => {
    const other = crypto.randomUUID();
    const mismatched = await runtime.dispatchFetch(`${origin}/${streamerId}/subscribe?streamerId=${other}`, {
      headers: { Upgrade: "websocket", "X-Stream-Bullets-Client": clientKey },
    });
    expect(mismatched.status).toBe(400);
    const foreignOrigin = await runtime.dispatchFetch(`${origin}/${streamerId}/subscribe?streamerId=${streamerId}`, {
      headers: { Upgrade: "websocket", Origin: "https://foreign.test" },
    });
    expect(foreignOrigin.status).toBe(403);
    expect((await connect()).snapshot.polls).toEqual([]);
  });

  it("reports service failure to subscribers when the authoritative stream is unavailable", async (): Promise<void> => {
    const { socket } = await connect();
    const update = nextSnapshot(socket);
    await database.prepare("DELETE FROM streamers WHERE id = ?").bind(streamerId).run();
    const refreshed = await request("refresh");
    expect(refreshed.status).toBe(503);
    expect(await refreshed.json()).toEqual({ error: "Live updates unavailable" });
    expect(await update).toEqual({ type: "unavailable" });
  });

  it("does no snapshot database work for refresh notifications with no subscribers", async (): Promise<void> => {
    await database.prepare("DELETE FROM streamers WHERE id = ?").bind(streamerId).run();
    expect((await request("refresh")).status).toBe(204);
  });

  it("enforces the connection cap when subscription reads overlap", async (): Promise<void> => {
    const responses = await subscribeMany(201, (index) => ({ key: seat(index), user: `member-${index}` }));
    expect(responses.filter((result) => result.status === 101)).toHaveLength(200);
    expect(responses.filter((result) => result.status === 503)).toHaveLength(1);
  });

  it("caps signed-out sockets at half the room", async (): Promise<void> => {
    const responses = await subscribeMany(101, (index) => ({ key: seat(index) }));
    expect(responses.filter((result) => result.status === 101)).toHaveLength(100);
    expect(responses.filter((result) => result.status === 503)).toHaveLength(1);
    // Signed-in viewers still find a seat.
    expect((await subscribeMany(1, () => ({ key: "b".repeat(64), user: "member-1" })))[0].status).toBe(101);
  });

  it("always admits the page owner, also past the per-client cap and in a full room", async (): Promise<void> => {
    await subscribeMany(90, (index) => ({ key: seat(index) }));
    await subscribeMany(10, () => ({ key: clientKey }));
    await subscribeMany(100, (index) => ({ key: seat(200 + index), user: `member-${index}` }));
    expect((await subscribeMany(1, () => ({ key: clientKey, user: "member-x" })))[0].status).toBe(429);
    // The OBS overlay and the dashboard of the owner, from the same network as ten other sockets.
    const owner = await subscribeMany(3, () => ({ key: clientKey, user: "owner-1", owner: true }));
    expect(owner.map((result) => result.status)).toEqual([101, 101, 101]);
    expect(await openCount()).toBe(200);
  });

  it("closes sockets that stopped pinging and keeps the ones that ping", async (): Promise<void> => {
    const quiet = await connect();
    const busy = await connect("b".repeat(64));
    await request("age-client", "POST", streamerId, clientKey);
    await request("age-client", "POST", streamerId, "b".repeat(64));
    const pong = nextRaw(busy.socket);
    busy.socket.send("ping");
    expect(await pong).toBe("pong");
    const closed = nextSnapshot(quiet.socket);
    await request("alarm");
    expect(await closed).toEqual({ type: "unavailable" });
    expect(await openCount(clientKey)).toBe(0);
    expect(await openCount("b".repeat(64))).toBe(1);
  });

  it("closes open sockets and refuses new ones once the page is suspended", async (): Promise<void> => {
    const { socket } = await connect();
    const update = nextSnapshot(socket);
    await database.prepare("UPDATE streamers SET status = 'suspended' WHERE id = ?").bind(streamerId).run();
    expect((await request("refresh")).status).toBe(204);
    expect(await update).toEqual({ type: "unavailable" });
    expect(await openCount()).toBe(0);
    const again = await runtime.dispatchFetch(`${origin}/${streamerId}/subscribe?streamerId=${streamerId}`, {
      headers: { Upgrade: "websocket", Origin: origin, "X-Stream-Bullets-Client": clientKey },
    });
    expect(again.status).toBe(404);
    expect(again.webSocket).toBeNull();
  });

  it("limits each client to ten concurrent connections without excluding another client", async (): Promise<void> => {
    const responses = await subscribeMany(11, () => ({ key: clientKey }));
    expect(responses.filter((result) => result.status === 101)).toHaveLength(10);
    expect(responses.filter((result) => result.status === 429)).toHaveLength(1);
    expect((await connect("b".repeat(64))).snapshot.polls).toEqual([]);
  });

  it("expires fixed connection leases through alarms even when the client sends ping", async (): Promise<void> => {
    const started = Date.now();
    const { socket } = await connect();
    const expiry: unknown = await (await request("lease-at")).json();
    expect(expiry).toBeGreaterThanOrEqual(started + 3_600_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 3_600_000);
    const pong = nextRaw(socket);
    socket.send("ping");
    expect(await pong).toBe("pong");
    expect(await (await request("lease-at")).json()).toBe(expiry);
    const expired = nextSnapshot(socket);
    await request("expire-client");
    await request("alarm");
    expect(await expired).toEqual({ type: "unavailable" });
    expect(await (await request("alarm-at")).json()).toBeNull();
  });

  it("rejects missing or malformed internal client identity", async (): Promise<void> => {
    for (const key of ["", "not-a-digest", "a".repeat(65)]) {
      const result = await runtime.dispatchFetch(`${origin}/${streamerId}/subscribe?streamerId=${streamerId}`, {
        headers: { Upgrade: "websocket", "X-Stream-Bullets-Client": key },
      });
      expect(result.status).toBe(400);
    }
  });

  it("rejects malformed stored poll options without sending an unsafe snapshot", async (): Promise<void> => {
    const id = await rows.addPoll();
    await database.prepare("UPDATE entries SET options = ? WHERE id = ?").bind('{"not":"options"}', id).run();
    const result = await runtime.dispatchFetch(`${origin}/${streamerId}/subscribe?streamerId=${streamerId}`, {
      headers: { Upgrade: "websocket", "X-Stream-Bullets-Client": clientKey },
    });
    expect(result.status).toBe(503);
    expect(result.webSocket).toBeNull();
  });

  it("preserves stream, route, method, upgrade, origin, and client validation order", async (): Promise<void> => {
    const cases: {
      path: string;
      query: string;
      method: string;
      upgrade?: string;
      status: number;
    }[] = [
      { path: "missing", query: "invalid", method: "POST", status: 400 },
      { path: "missing", query: streamerId, method: "POST", status: 404 },
      { path: "subscribe", query: streamerId, method: "POST", status: 405 },
      { path: "subscribe", query: streamerId, method: "GET", status: 426 },
      {
        path: "subscribe",
        query: streamerId,
        method: "GET",
        upgrade: "websocket",
        status: 403,
      },
    ];
    for (const testCase of cases) {
      const result = await runtime.dispatchFetch(
        `${origin}/${streamerId}/${testCase.path}?streamerId=${testCase.query}`,
        {
          method: testCase.method,
          headers: {
            ...(testCase.upgrade ? { Upgrade: testCase.upgrade } : {}),
            Origin: "https://foreign.test",
          },
        },
      );
      expect(result.status).toBe(testCase.status);
      expect(result.webSocket).toBeNull();
    }
  });

  it("rejects malformed requests before opening a socket", async (): Promise<void> => {
    expect((await request("subscribe", "POST")).status).toBe(405);
    expect((await request("subscribe", "GET")).status).toBe(426);
    expect((await request("missing")).status).toBe(404);
    const repeated = await runtime.dispatchFetch(
      `${origin}/${streamerId}/subscribe?streamerId=${streamerId}&streamerId=${streamerId}`,
      { headers: { Upgrade: "websocket", "X-Stream-Bullets-Client": clientKey } },
    );
    expect(repeated.status).toBe(400);
  });
});

describe("Mash Battle taps", (): void => {
  it("refuses taps from signed-out sockets", async (): Promise<void> => {
    const id = await rows.addBattle({});
    const { socket } = await connectAs(null);
    const reply = mashReply(socket);
    tap(socket, id, 3, 1);
    expect(await reply).toMatchObject({ type: "mash-denied", id, reason: "sign-in" });
  });

  it("caps two sockets of one account with one token bucket", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 });
    const first = await connectAs("player-1");
    const second = await connectAs("player-1", "b".repeat(64));
    const firstReply = mashReply(first.socket);
    tap(first.socket, id, 20, 1);
    const firstAck = await firstReply;
    const secondReply = mashReply(second.socket);
    tap(second.socket, id, 20, 1);
    const secondAck = await secondReply;
    // The bucket holds one second at 15 a second. The second socket finds it empty.
    expect(firstAck).toMatchObject({ type: "mash-ack", accepted: 15, mine: 15 });
    expect(secondAck.accepted).toBeLessThanOrEqual(1);
    expect(secondAck.mine).toBeLessThanOrEqual(16);
  });

  it("closes sockets that send anything but a well-formed tap", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 });
    for (const message of [
      { t: "tap", id, n: 0, assisted: false, seq: 1 },
      { t: "vote", id, n: 1, assisted: false, seq: 1 },
    ]) {
      const { socket } = await connectAs("player-1");
      const closed = nextClose(socket);
      socket.send(JSON.stringify(message));
      expect(await closed).toBe(1008);
    }
  });
});

describe("overlay updates", (): void => {
  it("reaches only the room of the page that changed", async (): Promise<void> => {
    const { socket } = await connect();
    const otherId = streamerId;
    streamerId = crypto.randomUUID();
    await database.prepare("INSERT INTO streamers (id) VALUES (?)").bind(streamerId).run();
    const other = await connect("c".repeat(64));
    let leaked = false;
    socket.addEventListener("message", (event): void => {
      if (String(event.data).includes('"type":"overlay"')) leaked = true;
    });
    await database
      .prepare(
        `INSERT INTO overlay_state (streamer_id, air, preview, position, size, instant, show_results, message, message_style, revision)
        VALUES (?, '{"type":"message","ref":null}', '{"type":"message","ref":null}', 'top', 'l', 0, 1, 'BRB 5 min', 'info', 3)`,
      )
      .bind(streamerId)
      .run();
    const update = nextMessage<{ type: string; overlay: Record<string, unknown> }>(
      other.socket,
      (message) => message.type === "overlay",
    );
    expect((await request("overlay")).status).toBe(204);
    expect((await update).overlay).toMatchObject({
      air: { type: "message", ref: null },
      position: "top",
      size: "l",
      message: "BRB 5 min",
      revision: 3,
    });
    expect((await update).overlay).not.toHaveProperty("preview");
    // One room sends in order, so a leaked update would arrive before this refresh's snapshot.
    streamerId = otherId;
    const refreshed = nextMessage<{ type: string }>(socket, (message) => message.type === "snapshot");
    expect((await request("refresh")).status).toBe(204);
    await refreshed;
    expect(leaked).toBe(false);
  });
});
