import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build, type PluginBuild } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import type { LiveSnapshot } from "../app/types";

type LiveSocket = NonNullable<Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]>;
type Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;

let runtime: Miniflare;
let database: Database;
let streamerId: string;
const sockets: LiveSocket[] = [];
const origin = "https://streambullets.test";
const clientKey = "a".repeat(64);

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

async function addPoll(kind: "choice" | "binary" = "choice", endsAt: number | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await database
    .prepare(
      "INSERT INTO entries (id, streamer_id, title, kind, options, ends_at, revealed, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(
      id,
      streamerId,
      "Which one?",
      kind,
      JSON.stringify(kind === "binary" ? ["Yes", "No"] : ["First", "Second"]),
      endsAt,
      Date.now(),
    )
    .run();
  return id;
}

async function vote(id: string, choice: number): Promise<void> {
  await database.batch([
    database
      .prepare("INSERT INTO entry_votes (entry_id, user_id, choice) VALUES (?, ?, ?)")
      .bind(id, crypto.randomUUID(), choice),
    database.prepare("UPDATE streamers SET revision = revision + 1 WHERE id = ?").bind(streamerId),
  ]);
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
  await database.exec(`
    CREATE TABLE streamers (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE entries (id TEXT PRIMARY KEY, streamer_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, options TEXT NOT NULL, ends_at INTEGER, revealed INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE entry_votes (entry_id TEXT NOT NULL, user_id TEXT NOT NULL, choice INTEGER NOT NULL, PRIMARY KEY(entry_id, user_id));
    CREATE INDEX entries_streamer ON entries(streamer_id, created_at, id);
  `);
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
    const id = await addPoll();
    await vote(id, 0);
    const first = await connect();
    const second = await connect();
    expect(first.snapshot.polls[0]).toMatchObject({ id, counts: [1, 0], total: 1 });
    expect(second.snapshot.revision).toBe(1);

    const firstUpdate = nextSnapshot(first.socket);
    const secondUpdate = nextSnapshot(second.socket);
    await vote(id, 1);
    expect((await request("refresh")).status).toBe(204);
    const updates = await Promise.all([firstUpdate, secondUpdate]);
    for (const snapshot of updates) {
      expect(snapshot.revision).toBe(2);
      expect(snapshot.polls[0]).toMatchObject({ counts: [1, 1], total: 2 });
    }
  });

  it("does not disclose exact binary results or account identity before reveal", async (): Promise<void> => {
    const id = await addPoll("binary");
    await vote(id, 0);
    const { socket, snapshot } = await connect();
    expect(snapshot.polls[0].counts).toBeNull();
    expect(Object.keys(snapshot.polls[0]).sort()).toEqual([
      "counts",
      "endsAt",
      "id",
      "kind",
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
    const id = await addPoll();
    const { socket } = await connect();
    const update = nextSnapshot(socket);
    await vote(id, 1);
    expect((await request("alarm")).status).toBe(204);
    expect((await update).polls[0]).toMatchObject({ counts: [0, 1], total: 1 });
  });

  it("loads durable votes for a reconnect instead of relying on the previous socket state", async (): Promise<void> => {
    const id = await addPoll();
    const first = await connect();
    first.socket.close(1000, "Reconnect");
    await vote(id, 1);
    const second = await connect();
    expect(second.snapshot.revision).toBe(1);
    expect(second.snapshot.polls[0].counts).toEqual([0, 1]);
  });

  it("schedules the next deadline and leaves unlimited polls open", async (): Promise<void> => {
    const deadline = Date.now() + 8_000;
    const timed = await addPoll("choice", deadline);
    const unlimited = await addPoll("binary");
    const { snapshot } = await connect();
    expect(snapshot.polls.find((poll) => poll.id === timed)?.endsAt).toBe(deadline);
    expect(snapshot.polls.find((poll) => poll.id === unlimited)?.endsAt).toBeNull();
    const alarm: unknown = await (await request("alarm-at")).json();
    expect(alarm).toBe(deadline);
  });

  it("bounds snapshots to fifty polls and excludes topics and other streamers", async (): Promise<void> => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      database
        .prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, NULL, 0, ?)")
        .bind(crypto.randomUUID(), streamerId, `Poll ${index}`, "choice", '["A","B"]', index),
    );
    rows.push(
      database
        .prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, NULL, 0, ?)")
        .bind(crypto.randomUUID(), streamerId, "Topic", "topic", "[]", 100),
    );
    rows.push(
      database
        .prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, NULL, 0, ?)")
        .bind(crypto.randomUUID(), crypto.randomUUID(), "Private scope", "choice", '["A","B"]', 100),
    );
    await database.batch(rows);
    const { snapshot } = await connect();
    expect(snapshot.polls).toHaveLength(50);
    expect(snapshot.polls[0].title).toBe("Poll 50");
    expect(snapshot.polls.at(-1)?.title).toBe("Poll 1");
  });

  it("retains an old active poll beyond fifty newer results and falls back after reveal", async (): Promise<void> => {
    const active = await addPoll("binary");
    await database.prepare("UPDATE entries SET created_at = 1 WHERE id = ?").bind(active).run();
    await vote(active, 0);
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
    const id = await addPoll();
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
    const responses = await Promise.all(
      Array.from({ length: 201 }, (_, index) =>
        runtime.dispatchFetch(`${origin}/${streamerId}/subscribe?streamerId=${streamerId}`, {
          headers: { Upgrade: "websocket", "X-Stream-Bullets-Client": index.toString(16).padStart(64, "0") },
        }),
      ),
    );
    for (const result of responses) {
      if (result.webSocket) {
        sockets.push(result.webSocket);
        result.webSocket.accept();
      }
    }
    expect(responses.filter((result) => result.status === 101)).toHaveLength(200);
    expect(responses.filter((result) => result.status === 503)).toHaveLength(1);
  });

  it("limits each client to ten concurrent connections without excluding another client", async (): Promise<void> => {
    const responses = await Promise.all(
      Array.from({ length: 11 }, () =>
        runtime.dispatchFetch(`${origin}/${streamerId}/subscribe?streamerId=${streamerId}`, {
          headers: { Upgrade: "websocket", "X-Stream-Bullets-Client": clientKey },
        }),
      ),
    );
    for (const result of responses) {
      if (result.webSocket) {
        sockets.push(result.webSocket);
        result.webSocket.accept();
      }
    }
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
    const pong = new Promise<string>((resolve): void => {
      socket.addEventListener("message", (event): void => resolve(String(event.data)), { once: true });
    });
    socket.send("ping");
    expect(await pong).toBe("pong");
    expect(await (await request("lease-at")).json()).toBe(expiry);
    const expired = nextSnapshot(socket);
    await request("expire-client");
    await request("alarm");
    expect(await expired).toEqual({ type: "unavailable" });
    expect(await (await request("alarm-at")).json()).toBeNull();
  });

  it("replaces caller-supplied connection identity with the trusted IP digest in the public Worker", async (): Promise<void> => {
    const workerPath = fileURLToPath(new URL("../worker/index.ts", import.meta.url));
    const bundle = await build({
      stdin: {
        contents: `
          import worker from ${JSON.stringify(workerPath)};
          import { DurableObject } from 'cloudflare:workers';
          export class CaptureRoom extends DurableObject {
            fetch(request) { return Response.json({ key: request.headers.get('X-Stream-Bullets-Client') }); }
          }
          export default {
            fetch(request, env) {
              return worker.fetch(request, { ...env, REQUEST_LIMITER: { limit: async () => ({ success: true }) } });
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
      define: { "import.meta.env.DEV": "false", "import.meta.env.MODE": '"production"' },
      plugins: [
        {
          name: "isolate-live-worker-dependencies",
          setup(plugin: PluginBuild): void {
            plugin.onResolve(
              {
                filter: /^(react-router|virtual:react-router\/server-build)$|\/(data|images|cleanup|schedule)\.server$/,
              },
              (args) => ({ path: args.path, namespace: "live-worker-test" }),
            );
            plugin.onLoad({ filter: /.*/, namespace: "live-worker-test" }, (args) => {
              if (args.path === "react-router")
                return {
                  contents:
                    "export const createContext = () => ({}); export const createRequestHandler = () => () => new Response(null, {status: 404}); export class RouterContextProvider { set() {} }",
                };
              if (args.path.endsWith("data.server"))
                return { contents: "export const getStreamer = async env => ({ id: env.TEST_STREAMER });" };
              if (args.path.endsWith("images.server"))
                return { contents: "export const serveImage = () => new Response(null, {status: 404});" };
              if (args.path.endsWith("cleanup.server"))
                return { contents: "export const cleanExpiredData = async () => {};" };
              if (args.path.endsWith("schedule.server"))
                return {
                  contents: "export const scheduleCalendar = async () => ''; export const topUpSeries = async () => 0;",
                };
              return { contents: "export default {};" };
            });
          },
        },
      ],
    });
    const worker = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-05-15",
      durableObjects: { POLL_ROOMS: { className: "CaptureRoom", useSQLite: true } },
      bindings: { APP_ORIGIN: origin, TEST_STREAMER: streamerId },
    });
    try {
      const ip = "203.0.113.7";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
      const expected = Array.from(new Uint8Array(digest), (byte: number): string =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      for (const spoofed of ["0".repeat(64), "1".repeat(64)]) {
        const result = await worker.dispatchFetch(`${origin}/api/live/test_host`, {
          headers: { Origin: origin, Upgrade: "websocket", "CF-Connecting-IP": ip, "X-Stream-Bullets-Client": spoofed },
        });
        expect(result.status).toBe(200);
        expect(await result.json()).toEqual({ key: expected });
      }
    } finally {
      await worker.dispose();
    }
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
    const id = await addPoll();
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
