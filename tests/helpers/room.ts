import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { vi } from "vitest";

/**
 * Just enough of the Workers runtime to run the live room in this process, where V8 coverage can see it. Storage,
 * alarms and hibernatable sockets are kept in memory; D1 stays a real Miniflare database.
 */

/**
 * `waitUntil` for code under test that tells the room something after the response. It cannot come from
 * ./workers: vitest.config.ts aliases `cloudflare:workers` to that file, so a test that mocks the module with this
 * one would import itself.
 */
export function waitUntil(promise: Promise<unknown>): void {
  void promise;
}

/** Stands in for `cloudflare:workers` (the test file mocks the module with this one). */
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

const OPEN = 1;
const CLOSED = 3;

/** The room's end of a live connection. `sent` holds what the room sent, as the viewer would receive it. */
export class FakeSocket {
  readyState: number = OPEN;
  readonly sent: string[] = [];
  closeCode: number | null = null;
  closeReason = "";
  /** A send that throws, as on a connection the network already dropped. */
  failSends = false;
  private attachment: unknown;

  send(message: string): void {
    if (this.failSends) throw new Error("Network connection lost");
    this.sent.push(message);
  }

  close(code: number = 1005, reason: string = ""): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.closeCode = code;
    this.closeReason = reason;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  /** Every message the room sent, parsed. */
  messages<T = Record<string, unknown>>(): T[] {
    return this.sent.map((message: string): T => JSON.parse(message) as T);
  }

  /** The messages of one type. */
  ofType<T = Record<string, unknown>>(type: string): T[] {
    return this.messages<{ type: string }>().filter((message) => message.type === type) as T[];
  }

  get open(): boolean {
    return this.readyState === OPEN;
  }
}

class FakeSocketPair {
  0: FakeSocket;
  1: FakeSocket;

  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
    peers.set(this[0], this[1]);
  }
}

/** The room's socket for the client socket an upgrade response carries. */
const peers = new WeakMap<FakeSocket, FakeSocket>();

export function serverSocketOf(client: unknown): FakeSocket {
  const server = peers.get(client as FakeSocket);
  if (!server) throw new Error("Not a client socket of this runtime");
  return server;
}

class FakeResponsePair {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
}

/** Node refuses status 101; the Workers runtime answers an upgrade with it and the client socket. */
class UpgradeResponse extends Response {
  readonly webSocket: WebSocket | null;

  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: WebSocket | null }) {
    const upgrade = init?.status === 101;
    super(body, upgrade ? { ...init, status: 200 } : init);
    this.webSocket = init?.webSocket ?? null;
    if (upgrade) Object.defineProperty(this, "status", { value: 101 });
  }
}

/** Installs the runtime globals the room and the Worker use. Undo with vi.unstubAllGlobals(). */
export function installWorkersRuntime(): void {
  vi.stubGlobal("WebSocketPair", FakeSocketPair);
  vi.stubGlobal("WebSocketRequestResponsePair", FakeResponsePair);
  vi.stubGlobal("Response", UpgradeResponse);
}

/** The Durable Object SQL API on an in-memory SQLite database: `exec` with bound values and `toArray()`. */
class RoomSql {
  readonly db = new DatabaseSync(":memory:");

  exec<T>(query: string, ...bindings: SQLInputValue[]): { toArray: () => T[] } {
    const rows = this.db.prepare(query).all(...bindings) as T[];
    return { toArray: (): T[] => rows };
  }
}

class RoomStorage {
  readonly values = new Map<string, unknown>();
  readonly sql = new RoomSql();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(time: number | Date): Promise<void> {
    this.alarm = typeof time === "number" ? time : time.getTime();
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

/** A Durable Object's state: storage, alarm, and the hibernation API for tagged sockets. */
export class RoomState {
  readonly storage = new RoomStorage();
  readonly accepted: { socket: FakeSocket; tags: string[] }[] = [];
  /** When each socket last got the automatic "pong". */
  readonly pings = new Map<FakeSocket, Date>();
  autoResponse: FakeResponsePair | null = null;
  ready: Promise<unknown> = Promise.resolve();

  constructor(readonly id: { toString: () => string }) {}

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const result = callback();
    this.ready = result;
    return result;
  }

  setWebSocketAutoResponse(pair: FakeResponsePair): void {
    this.autoResponse = pair;
  }

  acceptWebSocket(socket: FakeSocket, tags: string[] = []): void {
    this.accepted.push({ socket, tags });
  }

  getWebSockets(tag?: string): FakeSocket[] {
    return this.accepted.filter((entry) => tag === undefined || entry.tags.includes(tag)).map((entry) => entry.socket);
  }

  getWebSocketAutoResponseTimestamp(socket: FakeSocket): Date | null {
    return this.pings.get(socket) ?? null;
  }

  tagsOf(socket: FakeSocket): string[] {
    return this.accepted.find((entry) => entry.socket === socket)?.tags ?? [];
  }

  /** The viewer sent "ping" and the runtime answered without waking the room. */
  ping(socket: FakeSocket, at: number = Date.now()): void {
    if (this.autoResponse?.request !== "ping") throw new Error("The room set no ping auto-response");
    this.pings.set(socket, new Date(at));
  }
}

interface RoomLike {
  fetch(request: Request): Promise<Response>;
}

/** A Durable Object namespace whose rooms live in this process, one per name. */
export class RoomNamespace<Room extends RoomLike> {
  private readonly rooms = new Map<string, { state: RoomState; room: Room }>();

  constructor(private readonly create: (state: RoomState) => Room) {}

  idFromName(name: string): { name: string; toString: () => string } {
    return { name, toString: (): string => `room:${name}` };
  }

  get(id: { name: string }): { fetch: (input: string, init?: RequestInit) => Promise<Response> } {
    return {
      fetch: async (input: string, init?: RequestInit): Promise<Response> => {
        const { state, room } = this.entry(id.name);
        await state.ready;
        return room.fetch(new Request(input, init));
      },
    };
  }

  /**
   * The runtime restarts the room (an eviction or a deploy): a new instance on the same storage. Its memory, the
   * sockets and the ticker are gone.
   */
  restart(name: string): void {
    const entry = this.rooms.get(name);
    if (!entry) throw new Error(`No room ${name}`);
    for (const { socket } of entry.state.accepted) socket.close(1012, "Restart");
    this.rooms.set(name, { state: entry.state, room: this.create(entry.state) });
  }

  entry(name: string): { state: RoomState; room: Room } {
    let entry = this.rooms.get(name);
    if (!entry) {
      const state = new RoomState(this.idFromName(name));
      entry = { state, room: this.create(state) };
      this.rooms.set(name, entry);
    }
    return entry;
  }
}

/** The tables the live room reads, without the rest of the app's schema. */
export const LIVE_SCHEMA = `
  CREATE TABLE streamers (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active');
  CREATE TABLE user (id TEXT PRIMARY KEY);
  CREATE TABLE entry_mash (entry_id TEXT PRIMARY KEY, duration_s INTEGER NOT NULL, phase TEXT NOT NULL DEFAULT 'setup', starts_at INTEGER, ends_at INTEGER, winner INTEGER);
  CREATE TABLE mash_taps (entry_id TEXT NOT NULL, user_id TEXT NOT NULL, side INTEGER NOT NULL, taps INTEGER NOT NULL DEFAULT 0, assisted_taps INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(entry_id, user_id));
  CREATE TABLE overlay_state (streamer_id TEXT PRIMARY KEY, air TEXT NOT NULL, preview TEXT NOT NULL, position TEXT NOT NULL, size TEXT NOT NULL, instant INTEGER NOT NULL, show_results INTEGER NOT NULL, message TEXT NOT NULL, message_style TEXT NOT NULL, revision INTEGER NOT NULL);
  CREATE TABLE entries (id TEXT PRIMARY KEY, streamer_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, options TEXT NOT NULL, ends_at INTEGER, revealed INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE entry_votes (entry_id TEXT NOT NULL, user_id TEXT NOT NULL, choice INTEGER NOT NULL, PRIMARY KEY(entry_id, user_id));
  CREATE TABLE entry_vote_counts (entry_id TEXT NOT NULL, choice INTEGER NOT NULL, votes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(entry_id, choice));
  CREATE TRIGGER entry_votes_count_insert AFTER INSERT ON entry_votes BEGIN INSERT INTO entry_vote_counts SELECT NEW.entry_id, NEW.choice, 0 WHERE NOT EXISTS (SELECT 1 FROM entry_vote_counts WHERE entry_id = NEW.entry_id AND choice = NEW.choice); UPDATE entry_vote_counts SET votes = votes + 1 WHERE entry_id = NEW.entry_id AND choice = NEW.choice; END;
  CREATE TRIGGER entry_votes_count_update AFTER UPDATE OF choice ON entry_votes WHEN OLD.choice != NEW.choice BEGIN UPDATE entry_vote_counts SET votes = votes - 1 WHERE entry_id = OLD.entry_id AND choice = OLD.choice; INSERT INTO entry_vote_counts SELECT NEW.entry_id, NEW.choice, 0 WHERE NOT EXISTS (SELECT 1 FROM entry_vote_counts WHERE entry_id = NEW.entry_id AND choice = NEW.choice); UPDATE entry_vote_counts SET votes = votes + 1 WHERE entry_id = NEW.entry_id AND choice = NEW.choice; END;
  CREATE TRIGGER entry_votes_count_delete AFTER DELETE ON entry_votes BEGIN UPDATE entry_vote_counts SET votes = votes - 1 WHERE entry_id = OLD.entry_id AND choice = OLD.choice; END;
  CREATE INDEX entries_streamer ON entries(streamer_id, created_at, id);
`;

/** Rows for the live room's tables, on one page. */
export function liveRows(db: () => D1Database, streamerId: () => string) {
  async function addPoll(
    kind: "choice" | "binary" = "choice",
    endsAt: number | null = null,
    createdAt: number = Date.now(),
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db()
      .prepare(
        "INSERT INTO entries (id, streamer_id, title, kind, options, ends_at, revealed, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      )
      .bind(
        id,
        streamerId(),
        "Which one?",
        kind,
        JSON.stringify(kind === "binary" ? ["Yes", "No"] : ["First", "Second"]),
        endsAt,
        createdAt,
      )
      .run();
    return id;
  }

  /** A Mash Battle in `phase` from `startsAt` to `endsAt`, with viewers on their sides. */
  async function addBattle(
    picks: Record<string, number>,
    times: { phase?: "countdown" | "live"; startsAt?: number; endsAt?: number } = {},
  ): Promise<string> {
    const id = await addPoll();
    const startsAt = times.startsAt ?? Date.now();
    const statements = [
      db()
        .prepare("INSERT INTO entry_mash (entry_id, duration_s, phase, starts_at, ends_at) VALUES (?, 10, ?, ?, ?)")
        .bind(id, times.phase ?? "live", startsAt, times.endsAt ?? startsAt + 10_000),
    ];
    for (const [user, side] of Object.entries(picks)) {
      statements.push(db().prepare("INSERT OR IGNORE INTO user (id) VALUES (?)").bind(user));
      statements.push(
        db().prepare("INSERT INTO entry_votes (entry_id, user_id, choice) VALUES (?, ?, ?)").bind(id, user, side),
      );
    }
    await db().batch(statements);
    return id;
  }

  async function vote(id: string, choice: number): Promise<void> {
    await db().batch([
      db()
        .prepare("INSERT INTO entry_votes (entry_id, user_id, choice) VALUES (?, ?, ?)")
        .bind(id, crypto.randomUUID(), choice),
      db().prepare("UPDATE streamers SET revision = revision + 1 WHERE id = ?").bind(streamerId()),
    ]);
  }

  function battleRow(id: string): Promise<{ phase: string; winner: number | null } | null> {
    return db()
      .prepare("SELECT phase, winner FROM entry_mash WHERE entry_id = ?")
      .bind(id)
      .first<{ phase: string; winner: number | null }>();
  }

  async function storedTaps(id: string): Promise<unknown[]> {
    const rows = await db()
      .prepare("SELECT user_id, side, taps FROM mash_taps WHERE entry_id = ? ORDER BY user_id")
      .bind(id)
      .all();
    return rows.results;
  }

  return { addPoll, addBattle, vote, battleRow, storedTaps };
}

/**
 * A D1 database that fails on demand: every query or batch that touches SQL matching a pattern throws, as D1 does
 * when it is down. The database itself is real.
 */
export function faultyDatabase(real: D1Database): {
  db: D1Database;
  fail: (pattern: RegExp, until?: Promise<unknown>) => void;
  heal: () => void;
  /** Queries held by a failure that waits for its `until`. */
  held: () => number;
} {
  const faults: { pattern: RegExp; until?: Promise<unknown> }[] = [];
  let held = 0;
  const sqlOf = new WeakMap<object, string>();
  const realOf = new WeakMap<object, D1PreparedStatement>();
  const check = async (sql: string[]): Promise<void> => {
    const fault = faults.find(({ pattern }) => sql.some((text: string): boolean => pattern.test(text)));
    if (!fault) return;
    held += 1;
    await fault.until;
    held -= 1;
    throw new Error("D1_ERROR: injected failure");
  };
  const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]): D1PreparedStatement => wrap(sql, statement.bind(...values)),
      first: async <T>(column?: string): Promise<T | null> => {
        await check([sql]);
        return column === undefined ? statement.first<T>() : statement.first<T>(column);
      },
      all: async <T>(): Promise<D1Result<T>> => {
        await check([sql]);
        return statement.all<T>();
      },
      run: async <T>(): Promise<D1Result<T>> => {
        await check([sql]);
        return statement.run<T>();
      },
    };
    sqlOf.set(wrapped, sql);
    realOf.set(wrapped, statement);
    return wrapped as unknown as D1PreparedStatement;
  };
  const db = {
    prepare: (sql: string): D1PreparedStatement => wrap(sql, real.prepare(sql)),
    batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      await check(statements.map((statement): string => sqlOf.get(statement) ?? ""));
      return real.batch<T>(statements.map((statement): D1PreparedStatement => realOf.get(statement) ?? statement));
    },
  };
  return {
    db: db as unknown as D1Database,
    fail: (pattern: RegExp, until?: Promise<unknown>): void => {
      faults.push({ pattern, until });
    },
    heal: (): void => {
      faults.length = 0;
    },
    held: (): number => held,
  };
}
