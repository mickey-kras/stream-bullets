import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { cpus, platform, arch, totalmem } from "node:os";
import { writeFile } from "node:fs/promises";
import { LIVE_SCHEMA, liveRows } from "./helpers/room";
import type { LiveSnapshot } from "../app/types";

type Socket = NonNullable<Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]>;
type Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;
type Role = "anonymous" | "member" | "owner" | "overlay";
interface Client { socket: Socket; role: Role; user: string; key: string }
interface Metrics { statements: number }
interface Message { type: string; id?: string; accepted?: number; mine?: number; totals?: number[] }
const enabled: boolean = process.env.LIVE_CAPACITY === "1";
const origin = "https://capacity.test";
let runtime: Miniflare;
let database: Database;
let room: string;
let nextClient = 0;
const clients: Client[] = [];
const reports: Record<string, unknown>[] = [];

function percentiles(values: number[]): { p50: number; p95: number; max: number } {
  const sorted: number[] = [...values].sort((a: number, b: number): number => a - b);
  const at = (fraction: number): number => Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
}

function message<T>(socket: Socket, match: (value: T) => boolean): Promise<T> {
  return new Promise((resolve, reject): void => {
    const listener = (event: { data: unknown }): void => {
      const value: T = JSON.parse(String(event.data)) as T;
      if (!match(value)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      resolve(value);
    };
    const timeout = setTimeout((): void => {
      socket.removeEventListener("message", listener);
      reject(new Error("Capacity message timed out"));
    }, 10_000);
    socket.addEventListener("message", listener);
  });
}

function request(path: string): ReturnType<Miniflare["dispatchFetch"]> {
  return runtime.dispatchFetch(`${origin}/${room}/${path}?streamerId=${room}`, { method: "POST" });
}

async function metrics(): Promise<Metrics> {
  return await (await request("metrics")).json() as Metrics;
}

async function join(role: Role, previousUser?: string): Promise<{ status: number; ms: number; client?: Client }> {
  const index: number = nextClient++;
  const key: string = index.toString(16).padStart(64, "0");
  const user: string = previousUser ?? `capacity-${index}`;
  const headers: Record<string, string> = { Upgrade: "websocket", Origin: origin, "X-Stream-Bullets-Client": key };
  if (role === "member" || role === "owner") headers["X-SB-User"] = user;
  if (role === "owner") headers["X-SB-Owner"] = "1";
  if (role === "overlay") headers["X-SB-Overlay"] = "1";
  const start: number = performance.now();
  const result = await runtime.dispatchFetch(`${origin}/${room}/subscribe?streamerId=${room}`, { headers });
  if (!result.webSocket) return { status: result.status, ms: performance.now() - start };
  const socket: Socket = result.webSocket;
  const snapshot = message<LiveSnapshot>(socket, (value: LiveSnapshot): boolean => value.type === "snapshot");
  socket.accept();
  await snapshot;
  const client: Client = { socket, role, key, user };
  clients.push(client);
  return { status: result.status, ms: performance.now() - start, client };
}

async function burst(label: string, roles: Role[], accepted: number = roles.length): Promise<void> {
  const results = await Promise.all(roles.map((role: Role) => join(role)));
  const statuses: Record<string, number> = {};
  for (const result of results) statuses[result.status] = (statuses[result.status] ?? 0) + 1;
  expect(statuses[101] ?? 0).toBe(accepted);
  expect(statuses[503] ?? 0).toBe(roles.length - accepted);
  expect(Object.keys(statuses).every((status: string): boolean => status === "101" || status === "503")).toBe(true);
  reports.push({ scenario: label, attempts: roles.length, statuses, handshakeMs: percentiles(results.map((result) => result.ms)) });
}

async function freshRoom(): Promise<void> {
  room = crypto.randomUUID();
  await database.prepare("INSERT INTO streamers (id) VALUES (?)").bind(room).run();
}

function closeClients(): void {
  for (const { socket } of clients.splice(0)) {
    if (socket.readyState === 1) socket.close(1000, "Scenario complete");
  }
}

beforeAll(async (): Promise<void> => {
  if (!enabled) return;
  const modulePath: string = fileURLToPath(new URL("../app/server/poll-room.ts", import.meta.url));
  const bundle = await build({
    stdin: {
      contents: `
        import { PollRoom } from ${JSON.stringify(modulePath)};
        export class CapacityRoom extends PollRoom {
          counts = { statements: 0 };
          constructor(ctx, env) {
            const counts = { statements: 0 };
            const statement = (raw) => new Proxy(raw, { get(target, key) {
              if (key === 'bind') return (...args) => statement(target.bind(...args));
              const value = target[key];
              if (typeof value !== 'function') return value;
              return (...args) => { if (['all','first','run','raw'].includes(key)) counts.statements++; return value.apply(target,args); };
            }});
            const db = new Proxy(env.DB, { get(target, key) {
              if (key === 'prepare') return (sql) => statement(target.prepare(sql));
              if (key === 'batch') return (statements) => { counts.statements += statements.length; return target.batch(statements); };
              const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
            }});
            super(ctx, { ...env, DB: db });
            this.counts = counts;
          }
          async metrics() { return this.counts; }
          async openCount() { return this.ctx.getWebSockets().filter(socket => socket.readyState === 1).length; }
          async reset() { this.ctx.abort('Capacity recovery test'); }
          async invokeAlarm() { await this.alarm(); }
          async journal() { return this.ctx.storage.sql.exec('SELECT SUM(taps) AS total FROM tap_journal').toArray()[0].total ?? 0; }
        }
        export default { async fetch(request, env) {
          const url = new URL(request.url);
          const [, room, path] = url.pathname.split('/');
          const stub = env.POLL_ROOMS.get(env.POLL_ROOMS.idFromName(room));
          if (path === 'metrics') return Response.json(await stub.metrics());
          if (path === 'open-count') return Response.json(await stub.openCount());
          if (path === 'journal') return Response.json(await stub.journal());
          if (path === 'alarm') { await stub.invokeAlarm(); return new Response(null, {status:204}); }
          if (path === 'reset') { try { await stub.reset(); } catch { return new Response(null, {status:204}); } throw new Error('Reset did not abort'); }
          url.pathname = '/' + path;
          return stub.fetch(new Request(url, request));
        }};
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", external: ["cloudflare:workers"],
  });
  runtime = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-05-15",
    durableObjects: { POLL_ROOMS: { className: "CapacityRoom", useSQLite: true } }, d1Databases: { DB: "capacity" },
    bindings: { APP_ORIGIN: origin },
  });
  database = await runtime.getD1Database("DB");
  await database.exec(LIVE_SCHEMA.trim());
}, 30_000);

afterAll(async (): Promise<void> => {
  if (!enabled) return;
  try { closeClients(); } finally { await runtime?.dispose(); }
});

it("measures local room admission, saturation, votes, mash and recovery", { skip: !enabled, timeout: 120_000 }, async (): Promise<void> => {
  reports.push({ environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)) } });
  for (const [role, limit] of [["anonymous", 100], ["member", 200]] as const) {
    for (const attempts of [limit - 1, limit, limit + 1]) {
      await freshRoom();
      await burst(`${role}-${attempts}`, Array.from({ length: attempts }, (): Role => role), Math.min(attempts, limit));
      expect(clients.filter((client: Client): boolean => client.socket.readyState === 1)).toHaveLength(Math.min(attempts, limit));
      closeClients();
    }
  }
  await freshRoom();
  const rows = liveRows(() => database as unknown as D1Database, (): string => room);
  const poll: string = await rows.addPoll();
  await burst("mixed-full", [...Array.from({ length: 100 }, (): Role => "anonymous"), ...Array.from({ length: 98 }, (): Role => "member"), "owner", "overlay"]);
  const owners: Client[] = clients.filter((client: Client): boolean => client.role === "owner" || client.role === "overlay");
  const beforeStorm: Metrics = await metrics();
  await burst("saturated-anonymous-storm", Array.from({ length: 250 }, (): Role => "anonymous"), 0);
  expect(await (await request("open-count")).json()).toBe(200);
  expect(await metrics()).toEqual(beforeStorm);
  for (const owner of owners) expect(owner.socket.readyState).toBe(1);
  let evictions = 0;
  const evicted = new Promise<void>((resolve): void => {
    for (const client of clients) client.socket.addEventListener("close", (): void => {
      evictions++;
      if (evictions === 2) resolve();
    }, { once: true });
  });
  await burst("owner-overlay-during-storm", ["owner", "overlay"]);
  await evicted;
  expect(await (await request("open-count")).json()).toBe(200);
  const current: Client[] = clients.filter((client: Client): boolean => client.socket.readyState === 1);
  expect(current).toHaveLength(200);
  const latency: number[] = [];
  const beforeVotes: Metrics = await metrics();
  const started: number = performance.now();
  const updates = current.map(async ({ socket }: Client): Promise<void> => {
    const update: LiveSnapshot = await message<LiveSnapshot>(socket, (value: LiveSnapshot): boolean => value.type === "snapshot" && value.revision >= 20);
    expect(update.polls.find((value) => value.id === poll)).toMatchObject({ counts: [10, 10], total: 20 });
    latency.push(performance.now() - started);
  });
  await Promise.all(Array.from({ length: 20 }, async (_, index: number): Promise<void> => {
    await rows.vote(poll, index % 2);
    expect((await request("refresh")).status).toBe(204);
  }));
  await Promise.all(updates);
  const afterVotes: Metrics = await metrics();
  reports.push({ scenario: "20-votes-200-sockets", updateMs: percentiles(latency), roomD1Statements: afterVotes.statements - beforeVotes.statements, fixtureVoteStatements: 40 });
  const members: Client[] = current.filter((client: Client): boolean => client.role === "member").slice(0, 20);
  const battle: string = await rows.addBattle(Object.fromEntries(members.map((client: Client, index: number) => [client.user, index % 2])), { endsAt: Date.now() + 120_000 });
  const acks: number[] = [];
  let accepted = 0;
  const beforeMash: Metrics = await metrics();
  const tickLatency: number[] = [];
  const mashStarted: number = performance.now();
  const ticks = current.map(async ({ socket }: Client): Promise<void> => {
    await message<Message>(socket, (value: Message): boolean => value.type === "mash" && value.id === battle && (value.totals ?? []).reduce((sum: number, value: number): number => sum + value, 0) === 180);
    tickLatency.push(performance.now() - mashStarted);
  });
  for (let seq = 0; seq < 3; seq++) {
    await Promise.all(members.map(async ({ socket }: Client): Promise<void> => {
      const ack = message<Message>(socket, (value: Message): boolean => value.type === "mash-ack" && value.id === battle);
      const start: number = performance.now();
      socket.send(JSON.stringify({ t: "tap", id: battle, n: 3, seq, assisted: false }));
      const reply: Message = await ack;
      accepted += reply.accepted ?? 0;
      acks.push(performance.now() - start);
    }));
  }
  await Promise.all(ticks);
  const journal: number = await (await request("journal")).json() as number;
  expect(journal).toBe(accepted);
  expect(accepted).toBe(180);
  const afterMash: Metrics = await metrics();
  reports.push({ scenario: "60-mash-batches-200-sockets", acceptedTaps: accepted, ackMs: percentiles(acks), updateMs: percentiles(tickLatency), roomD1Statements: afterMash.statements - beforeMash.statements, durableJournalTaps: journal });
  expect((await request("reset")).status).toBe(204);
  closeClients();
  await request("alarm");
  const recovered = await join("owner");
  expect(recovered.status).toBe(101);
  const recovery = await database.prepare("SELECT SUM(taps) AS total FROM mash_taps WHERE entry_id = ?").bind(battle).first<number>("total");
  // Alarm resumes the journal; an additional second permits its bounded D1 flush.
  if (recovery !== accepted) {
    await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 1_100));
    await request("alarm");
  }
  expect(await database.prepare("SELECT SUM(taps) AS total FROM mash_taps WHERE entry_id = ?").bind(battle).first("total")).toBe(accepted);
  const reconnected = await join("member", members[0].user);
  if (!reconnected.client) throw new Error("Reconnect refused");
  const reconnectAck = message<Message>(reconnected.client.socket, (value: Message): boolean => value.type === "mash-ack");
  reconnected.client.socket.send(JSON.stringify({ t: "tap", id: battle, n: 1, seq: 0, assisted: false }));
  expect(await reconnectAck).toMatchObject({ accepted: 1, mine: 10 });
  expect(await (await request("journal")).json()).toBe(accepted + 1);
  reports.push({ scenario: "object-abort-recovery", expectedTaps: accepted, storedTaps: accepted, reconnectedPlayerMine: 10, journalAfterReconnect: accepted + 1 });
  console.log("LIVE_CAPACITY_RESULTS", JSON.stringify(reports));
  const output: string | undefined = process.env.LIVE_CAPACITY_OUTPUT;
  if (output) await writeFile(output, JSON.stringify(reports, null, 2) + "\n");
});
