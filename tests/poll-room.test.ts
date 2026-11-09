import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import { MASH_FLUSH_MS, MASH_TICK_MS } from "../app/lib/mash";
import { PollRoom } from "../app/server/poll-room";
import type { LiveSnapshot } from "../app/types";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import {
  faultyDatabase,
  type FakeSocket,
  installWorkersRuntime,
  LIVE_SCHEMA,
  liveRows,
  RoomNamespace,
  serverSocketOf,
} from "./helpers/room";

vi.mock("cloudflare:workers", () => import("./helpers/room"));

/*
 * The live room in this process with a controlled clock: the runtime's alarm is called by hand, and the 5 Hz ticker
 * only runs when a test advances the fake interval. tests/realtime.test.ts runs the same class in workerd.
 */

const origin = "https://streambullets.test";
const KEY = "a".repeat(64);
const MINUTE = 60_000;

type Reply = { type: string; id?: string; mine?: number; accepted?: number; reason?: string };
type Tick = {
  type: "mash";
  id: string;
  phase: string;
  totals: number[];
  players: number;
  assisted: number;
  tps: number;
};

let database: TestDatabase;
let faults: ReturnType<typeof faultyDatabase>;
let rooms: RoomNamespace<PollRoom>;
let streamerId: string;
const rows = liveRows(
  () => database.db,
  () => streamerId,
);

/** A distinct client key for socket number `index`. */
function seat(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function room(): PollRoom {
  return rooms.entry(streamerId).room;
}

function state(): ReturnType<RoomNamespace<PollRoom>["entry"]>["state"] {
  return rooms.entry(streamerId).state;
}

function call(path: string, init: RequestInit = {}, id: string = streamerId): Promise<Response> {
  return rooms
    .get(rooms.idFromName(streamerId))
    .fetch(`https://poll-room.internal/${path}?streamerId=${encodeURIComponent(id)}`, init);
}

function post(path: string, body?: unknown): Promise<Response> {
  return call(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

interface Visitor {
  key?: string;
  user?: string;
  owner?: boolean;
  /** Set by the Worker for a valid overlay key. */
  overlay?: boolean;
}

function subscribe(visitor: Visitor = {}): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket", "X-Stream-Bullets-Client": visitor.key ?? KEY };
  if (visitor.user) headers["X-SB-User"] = visitor.user;
  if (visitor.owner) headers["X-SB-Owner"] = "1";
  if (visitor.overlay) headers["X-SB-Overlay"] = "1";
  return call("subscribe", { headers });
}

/** Subscribes and returns the room's socket for the new connection. */
async function join(visitor: Visitor = {}): Promise<FakeSocket> {
  const response = await subscribe(visitor);
  expect(response.status).toBe(101);
  return serverSocketOf((response as Response & { webSocket: unknown }).webSocket);
}

/** Joins one socket per visitor, one millisecond apart so their age order is fixed. */
async function joinAll(count: number, visitor: (index: number) => Visitor): Promise<FakeSocket[]> {
  const joined: FakeSocket[] = [];
  for (let index = 0; index < count; index += 1) {
    joined.push(await join(visitor(index)));
    vi.setSystemTime(Date.now() + 1);
  }
  return joined;
}

/** Sends a tap batch and returns the room's reply to it, if any. */
async function tap(
  socket: FakeSocket,
  id: string,
  n: number,
  seq: number,
  assisted = false,
): Promise<Reply | undefined> {
  const before = socket.sent.length;
  await room().webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ t: "tap", id, n, assisted, seq }));
  return socket
    .messages<Reply>()
    .slice(before)
    .find((message: Reply): boolean => message.type === "mash-ack" || message.type === "mash-denied");
}

/** Fires the room's alarm now, as the runtime does: the alarm it runs is used up. */
async function fireAlarm(): Promise<void> {
  state().storage.alarm = null;
  await room().alarm();
}

/** Moves the clock, then fires the alarm. */
async function alarmAfter(ms: number): Promise<void> {
  vi.setSystemTime(Date.now() + ms);
  await fireAlarm();
}

function lastOf<T>(socket: FakeSocket, type: string): T | undefined {
  return socket.ofType<T>(type).at(-1);
}

beforeAll(async (): Promise<void> => {
  installWorkersRuntime();
  database = await createTestDatabase({ migrate: false });
  await database.db.exec(LIVE_SCHEMA.trim());
});

beforeEach(async (): Promise<void> => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  streamerId = crypto.randomUUID();
  await database.db.prepare("INSERT INTO streamers (id) VALUES (?)").bind(streamerId).run();
  faults = faultyDatabase(database.db);
  const env = { DB: faults.db, APP_ORIGIN: origin } as AppEnv;
  rooms = new RoomNamespace((roomState) => new PollRoom(roomState as unknown as DurableObjectState, env));
  env.POLL_ROOMS = rooms as unknown as DurableObjectNamespace;
});

afterEach((): void => {
  vi.useRealTimers();
});

afterAll(async (): Promise<void> => {
  vi.unstubAllGlobals();
  await database?.dispose();
});

describe("live room requests", (): void => {
  it("refuses a request for another page, an unknown path, the wrong method and bad identities", async (): Promise<void> => {
    expect((await call("subscribe", {}, crypto.randomUUID())).status).toBe(400);
    expect((await call("subscribe", {}, "not-a-uuid")).status).toBe(400);
    expect((await call("missing")).status).toBe(404);
    expect((await call("subscribe", { method: "POST" })).status).toBe(405);
    expect((await call("refresh")).status).toBe(405);
    expect((await call("subscribe")).status).toBe(426);
    const foreign = await call("subscribe", {
      headers: { Upgrade: "websocket", Origin: "https://foreign.test", "X-Stream-Bullets-Client": KEY },
    });
    expect(foreign.status).toBe(403);
    expect((await subscribe({ key: "not-a-digest" })).status).toBe(400);
    expect((await subscribe({ user: "bad user!" })).status).toBe(400);
    expect(await (await subscribe({ user: "bad user!" })).json()).toEqual({ error: "Invalid account" });
    expect(state().accepted).toHaveLength(0);
  });

  it("admits a socket from the app's own origin", async (): Promise<void> => {
    const response = await call("subscribe", {
      headers: { Upgrade: "websocket", Origin: origin, "X-Stream-Bullets-Client": KEY },
    });
    expect(response.status).toBe(101);
  });

  it("stays bound to the first page it served", async (): Promise<void> => {
    const other = crypto.randomUUID();
    rooms = new RoomNamespace((roomState) => {
      roomState.storage.values.set("streamerId", other);
      return new PollRoom(
        roomState as unknown as DurableObjectState,
        { DB: faults.db, POLL_ROOMS: rooms } as unknown as AppEnv,
      );
    });
    expect((await subscribe()).status).toBe(400);
  });

  it("binds itself to its page on the first request and remembers it", async (): Promise<void> => {
    await join();
    expect(await state().storage.get("streamerId")).toBe(streamerId);
  });

  it("answers pings without waking the room", async (): Promise<void> => {
    await join();
    expect(state().autoResponse).toMatchObject({ request: "ping", response: "pong" });
  });
});

describe("live room admission", (): void => {
  it("holds each client to ten sockets and frees a seat when one closes", async (): Promise<void> => {
    const sockets = await joinAll(10, () => ({ key: KEY }));
    const refused = await subscribe({ key: KEY });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "Too many live connections from this client" });
    await join({ key: "b".repeat(64) });
    sockets[0].close(1000, "Gone");
    await join({ key: KEY });
  });

  it("re-checks the cap after loading the snapshot, so overlapping subscriptions never pass it", async (): Promise<void> => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => subscribe({ key: KEY })));
    expect(responses.map((response) => response.status).sort()).toEqual([...Array(10).fill(101), 429, 429]);
  });

  it("lets signed-out sockets fill half the room, then only signed-in viewers", async (): Promise<void> => {
    await joinAll(100, (index) => ({ key: seat(index) }));
    const refused = await subscribe({ key: seat(500) });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "Stream is full" });
    await join({ key: seat(501), user: "member-1" });
  });

  it("gives a signed-in viewer the seat of the oldest signed-out socket in a full room", async (): Promise<void> => {
    const anonymous = await joinAll(100, (index) => ({ key: seat(index) }));
    await joinAll(100, (index) => ({ key: seat(200 + index), user: `member-${index}` }));
    await join({ key: seat(400), user: "late-member" });
    expect(anonymous[0].ofType("unavailable")).toHaveLength(1);
    expect([anonymous[0].closeCode, anonymous[0].closeReason]).toEqual([1013, "Live room is full"]);
    expect(anonymous.slice(1).every((socket) => socket.open)).toBe(true);
    // A signed-out newcomer takes nobody's seat.
    expect((await subscribe({ key: seat(401) })).status).toBe(503);
  });

  it("refuses a signed-in viewer when the room is full of signed-in viewers", async (): Promise<void> => {
    await joinAll(200, (index) => ({ key: seat(index), user: `member-${index}` }));
    expect((await subscribe({ key: seat(300), user: "late-member" })).status).toBe(503);
  });

  it("always admits the page owner: past the client cap, and in a full room by evicting the oldest", async (): Promise<void> => {
    await joinAll(10, () => ({ key: KEY }));
    const owner = await join({ key: KEY, user: "owner-1", owner: true });
    expect(state().tagsOf(owner)).toEqual(["role:owner"]);
    const members = await joinAll(189, (index) => ({ key: seat(index), user: `member-${index}` }));
    // 10 signed-out, 1 owner and 189 members fill the room; the owner's next socket takes a signed-out seat.
    const anonymous = state().getWebSockets("role:anonymous");
    await join({ key: KEY, user: "owner-1", owner: true });
    expect(anonymous[0].closeCode).toBe(1013);
    for (const socket of anonymous.slice(1)) socket.close(1000, "Gone");
    await joinAll(9, (index) => ({ key: seat(300 + index), user: `member-x${index}` }));
    // No signed-out socket is left: the oldest member makes way.
    await join({ key: KEY, user: "owner-1", owner: true });
    expect(members[0].closeCode).toBe(1013);
    expect(members[1].open).toBe(true);
  });

  it("keeps ten owner sockets and closes the owner's oldest for the eleventh", async (): Promise<void> => {
    const owners = await joinAll(10, () => ({ key: KEY, user: "owner-1", owner: true }));
    await join({ key: KEY, user: "owner-1", owner: true });
    expect(owners[0].closeCode).toBe(1013);
    expect(owners.slice(1).every((socket) => socket.open)).toBe(true);
  });

  it("always admits the OBS overlay with a valid key, also in a room full of signed-out sockets", async (): Promise<void> => {
    const anonymous = await joinAll(90, (index) => ({ key: seat(index) }));
    await joinAll(10, () => ({ key: KEY }));
    await joinAll(100, (index) => ({ key: seat(200 + index), user: `member-${index}` }));
    // Without the key, the OBS source is one more signed-out socket.
    expect((await subscribe({ key: KEY })).status).toBe(429);
    expect((await subscribe({ key: seat(500) })).status).toBe(503);
    const overlay = await join({ key: KEY, overlay: true });
    expect(state().tagsOf(overlay)).toEqual(["role:owner", "overlay-key"]);
    expect(anonymous[0].closeCode).toBe(1013);
    expect(state().getWebSockets().filter((socket) => socket.open)).toHaveLength(200);
  });

  it("drops only the sockets that came in with a revoked overlay key", async (): Promise<void> => {
    const [overlay, broken] = await joinAll(2, () => ({ key: KEY, overlay: true }));
    const owner = await join({ key: KEY, user: "owner-1", owner: true });
    const viewer = await join({ key: seat(1) });
    broken.failSends = true;
    expect((await post("overlay-key")).status).toBe(204);
    expect(overlay.ofType("unavailable")).toHaveLength(1);
    expect([overlay.closeCode, overlay.closeReason]).toEqual([1001, "Overlay key revoked"]);
    expect(broken.closeCode).toBe(1011);
    expect([owner.open, viewer.open]).toEqual([true, true]);
  });

  it("treats an owner header without an account as a signed-out socket", async (): Promise<void> => {
    const response = await call("subscribe", {
      headers: { Upgrade: "websocket", "X-Stream-Bullets-Client": KEY, "X-SB-Owner": "1" },
    });
    const socket = serverSocketOf((response as Response & { webSocket: unknown }).webSocket);
    expect(state().tagsOf(socket)).toEqual([`client:${KEY}`, "role:anonymous"]);
  });
});

describe("live room connections over time", (): void => {
  it("closes sockets that stopped pinging for a minute and keeps the ones that ping", async (): Promise<void> => {
    const quiet = await join();
    const busy = await join({ key: "b".repeat(64) });
    vi.setSystemTime(Date.now() + 50_000);
    state().ping(busy);
    await alarmAfter(MINUTE - 50_000 - 1);
    expect(quiet.open).toBe(true);
    await alarmAfter(1);
    expect([quiet.closeCode, quiet.closeReason]).toEqual([1001, "Live connection idle"]);
    expect(quiet.ofType("unavailable")).toHaveLength(1);
    expect(busy.open).toBe(true);
  });

  it("ends every lease after an hour, also for a socket that keeps pinging", async (): Promise<void> => {
    const opened = Date.now();
    const socket = await join();
    for (let at = opened + 50_000; at < opened + 60 * MINUTE; at += 50_000) {
      vi.setSystemTime(at);
      state().ping(socket);
    }
    vi.setSystemTime(opened + 60 * MINUTE - 1);
    await fireAlarm();
    expect(socket.open).toBe(true);
    await alarmAfter(1);
    expect([socket.closeCode, socket.closeReason]).toEqual([1001, "Live connection lease expired"]);
  });

  it("treats a socket with an unreadable lease as expired and signed out", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 });
    const socket = await join({ user: "player-1" });
    socket.serializeAttachment({ expiresAt: "later" });
    expect(await tap(socket, id, 1, 1)).toEqual({ type: "mash-denied", id, reason: "sign-in" });
    state().ping(socket);
    await fireAlarm();
    expect(socket.closeReason).toBe("Live connection lease expired");
  });

  it("closes a socket the runtime reports as failed", async (): Promise<void> => {
    const socket = await join();
    room().webSocketError(socket as unknown as WebSocket, new Error("reset"));
    expect([socket.closeCode, socket.closeReason]).toEqual([1011, "Live connection failed"]);
  });

  it("closes a socket whose send fails instead of throwing", async (): Promise<void> => {
    const socket = await join();
    socket.failSends = true;
    expect((await post("overlay")).status).toBe(204);
    expect(socket.closeCode).toBe(1011);
  });
});

describe("live room snapshots", (): void => {
  it("sends current votes at subscribe and pushes each refresh to every viewer", async (): Promise<void> => {
    const id = await rows.addPoll();
    await rows.vote(id, 1);
    const first = await join();
    const second = await join({ key: "b".repeat(64) });
    expect(first.messages<LiveSnapshot>()[0]).toMatchObject({
      type: "snapshot",
      revision: 1,
      polls: [{ id, kind: "choice", options: ["First", "Second"], counts: [0, 1], total: 1, revealed: false }],
    });
    await rows.vote(id, 0);
    expect((await post("refresh")).status).toBe(204);
    for (const socket of [first, second]) {
      expect(lastOf<LiveSnapshot>(socket, "snapshot")).toMatchObject({ revision: 2, polls: [{ counts: [1, 1] }] });
    }
  });

  it("keeps an older open poll in the snapshot when the newest entry is a finished battle", async (): Promise<void> => {
    const open = await rows.addPoll("choice", null, 1);
    const newer: string[] = [];
    for (let index = 0; index < 50; index += 1) newer.push(await rows.addPoll("choice", null, 10 + index));
    await database.db
      .prepare("UPDATE entries SET revealed=1 WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(newer))
      .run();
    const battle = await rows.addBattle({}, { startsAt: Date.now() - 60_000, endsAt: Date.now() - 30_000 });
    await database.db.prepare("UPDATE entry_mash SET phase='finished' WHERE entry_id=?").bind(battle).run();
    const socket = await join();
    const ids = socket.messages<LiveSnapshot>()[0].polls.map((poll) => poll.id);
    expect(ids).toContain(open);
    expect(ids[0]).toBe(battle);
  });

  it("hides the counts of a binary poll until it is revealed", async (): Promise<void> => {
    const id = await rows.addPoll("binary");
    await rows.vote(id, 0);
    const socket = await join();
    expect(socket.messages<LiveSnapshot>()[0].polls[0]).toMatchObject({ kind: "binary", counts: null, total: 1 });
    await database.db.prepare("UPDATE entries SET revealed = 1 WHERE id = ?").bind(id).run();
    await rows.vote(id, 1);
    await post("refresh");
    expect(lastOf<LiveSnapshot>(socket, "snapshot")?.polls[0]).toMatchObject({ revealed: true, counts: [1, 1] });
  });

  it("never goes back to an older revision than it already sent", async (): Promise<void> => {
    const kept = await rows.addPoll();
    await rows.vote(kept, 0);
    const socket = await join();
    await rows.addPoll();
    await database.db.prepare("UPDATE streamers SET revision = 0 WHERE id = ?").bind(streamerId).run();
    await post("refresh");
    expect(lastOf<LiveSnapshot>(socket, "snapshot")).toMatchObject({ revision: 1, polls: [{ id: kept }] });
  });

  it("repairs a missed refresh at the 15 second resync", async (): Promise<void> => {
    const id = await rows.addPoll();
    const socket = await join();
    const opened = Date.now();
    expect(state().storage.alarm).toBe(opened + 15_000);
    await rows.vote(id, 1);
    await alarmAfter(15_000);
    expect(lastOf<LiveSnapshot>(socket, "snapshot")?.polls[0].counts).toEqual([0, 1]);
    expect(state().storage.alarm).toBe(Date.now() + 15_000);
  });

  it("wakes at a poll's end when that comes before the next resync", async (): Promise<void> => {
    const endsAt = Date.now() + 5_000;
    await rows.addPoll("choice", endsAt);
    await rows.addPoll("choice", Date.now() - 1);
    await join();
    expect(state().storage.alarm).toBe(endsAt);
  });

  it("keeps an earlier alarm, and clears it when the last socket closes", async (): Promise<void> => {
    await state().storage.setAlarm(Date.now() + 1_000);
    const socket = await join();
    expect(state().storage.alarm).toBe(Date.now() + 1_000);
    socket.close(1000, "Gone");
    await room().webSocketClose(socket as unknown as WebSocket, 1000, "Gone", true);
    expect(state().storage.alarm).toBeNull();
  });

  it("brings a later alarm forward to the next resync", async (): Promise<void> => {
    await state().storage.setAlarm(Date.now() + MINUTE);
    await join();
    expect(state().storage.alarm).toBe(Date.now() + 15_000);
  });

  it("does no snapshot work for a refresh with nobody watching, and sleeps with no alarm", async (): Promise<void> => {
    await database.db.prepare("DELETE FROM streamers WHERE id = ?").bind(streamerId).run();
    expect((await post("refresh")).status).toBe(204);
    expect(state().storage.alarm).toBeNull();
  });

  it("does nothing on an alarm before it served any page", async (): Promise<void> => {
    await state().storage.setAlarm(Date.now());
    await fireAlarm();
    expect(state().storage.alarm).toBeNull();
  });

  it("tells viewers the stream is unavailable when the page row is gone", async (): Promise<void> => {
    const socket = await join();
    await database.db.prepare("DELETE FROM streamers WHERE id = ?").bind(streamerId).run();
    const refreshed = await post("refresh");
    expect(refreshed.status).toBe(503);
    expect(await refreshed.json()).toEqual({ error: "Live updates unavailable" });
    expect(socket.ofType("unavailable")).toHaveLength(1);
    expect(socket.closeCode).toBe(1011);
  });

  it("lets a failing alarm throw so the runtime retries it", async (): Promise<void> => {
    await join();
    faults.fail(/SELECT revision, status FROM streamers/);
    await expect(alarmAfter(15_000)).rejects.toThrow("injected");
  });

  it("refuses to send a snapshot with malformed stored options", async (): Promise<void> => {
    const id = await rows.addPoll();
    await database.db.prepare("UPDATE entries SET options = ? WHERE id = ?").bind('{"not":"options"}', id).run();
    expect((await subscribe()).status).toBe(503);
    expect(state().accepted).toHaveLength(0);
  });

  it("closes every socket of a suspended page and refuses new ones", async (): Promise<void> => {
    const socket = await join();
    await database.db.prepare("UPDATE streamers SET status = 'suspended' WHERE id = ?").bind(streamerId).run();
    expect((await post("refresh")).status).toBe(204);
    expect(socket.ofType("unavailable")).toHaveLength(1);
    expect([socket.closeCode, socket.closeReason]).toEqual([1011, "Live updates unavailable"]);
    const again = await subscribe();
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "Stream not found" });
  });

  it("closes the sockets of a page suspended between refreshes at the next alarm", async (): Promise<void> => {
    const socket = await join();
    await database.db.prepare("UPDATE streamers SET status = 'suspended' WHERE id = ?").bind(streamerId).run();
    await alarmAfter(15_000);
    expect(socket.closeCode).toBe(1011);
  });

  it("sends a changed overlay to every viewer of this page only", async (): Promise<void> => {
    const socket = await join();
    const page = streamerId;
    streamerId = crypto.randomUUID();
    await database.db.prepare("INSERT INTO streamers (id) VALUES (?)").bind(streamerId).run();
    const other = await join();
    await database.db
      .prepare(
        `INSERT INTO overlay_state (streamer_id, air, preview, position, size, instant, show_results, message, message_style, revision)
        VALUES (?, '{"type":"message","ref":null}', '{"type":"message","ref":null}', 'top', 'l', 0, 1, 'BRB 5 min', 'info', 3)`,
      )
      .bind(streamerId)
      .run();
    expect((await post("overlay")).status).toBe(204);
    const update = lastOf<{ overlay: Record<string, unknown> }>(other, "overlay");
    expect(update?.overlay).toMatchObject({ air: { type: "message" }, position: "top", message: "BRB 5 min" });
    expect(update?.overlay).not.toHaveProperty("preview");
    streamerId = page;
    expect(socket.ofType("overlay")).toEqual([]);
  });
});

describe("live room tap messages", (): void => {
  it("closes sockets that send anything but a well-formed tap", async (): Promise<void> => {
    const id = crypto.randomUUID();
    const good = { t: "tap", id, n: 1, assisted: false, seq: 1 };
    const bad: (string | ArrayBuffer)[] = [
      new ArrayBuffer(4),
      JSON.stringify({ ...good, pad: "x".repeat(256) }),
      "{not json",
      "null",
      "7",
      JSON.stringify({ ...good, t: "vote" }),
      JSON.stringify({ ...good, id: "not-a-uuid" }),
      JSON.stringify({ ...good, id: 5 }),
      JSON.stringify({ ...good, n: 0 }),
      JSON.stringify({ ...good, n: 1.5 }),
      JSON.stringify({ ...good, n: "1" }),
      JSON.stringify({ ...good, assisted: 1 }),
      JSON.stringify({ ...good, seq: -1 }),
      JSON.stringify({ ...good, seq: 0.5 }),
      JSON.stringify({ ...good, seq: "1" }),
    ];
    for (const message of bad) {
      const socket = await join({ key: "b".repeat(64) });
      await room().webSocketMessage(socket as unknown as WebSocket, message);
      expect([String(message).slice(0, 40), socket.closeCode, socket.closeReason]).toEqual([
        String(message).slice(0, 40),
        1008,
        "Unsupported message",
      ]);
    }
    const socket = await join();
    await room().webSocketMessage(socket as unknown as WebSocket, JSON.stringify(good));
    expect(socket.open).toBe(true);
  });

  it("refuses taps from signed-out sockets and from accounts without a valid side", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-3": 3 });
    expect(await tap(await join(), id, 1, 1)).toEqual({ type: "mash-denied", id, reason: "sign-in" });
    expect(await tap(await join({ user: "nobody" }), id, 1, 1)).toEqual({ type: "mash-denied", id, reason: "pick" });
    // Side 3 of a two-sided battle (a vote from before the options changed).
    expect(await tap(await join({ user: "player-3" }), id, 1, 1)).toMatchObject({ reason: "pick" });
  });

  it("refuses taps before the start, after the end, on a frozen page and for an unknown battle", async (): Promise<void> => {
    const soon = await rows.addBattle({ "player-1": 0 }, { phase: "countdown", startsAt: Date.now() + 3_000 });
    const over = await rows.addBattle({ "player-1": 0 }, { startsAt: Date.now() - 20_000, endsAt: Date.now() - 1 });
    const socket = await join({ user: "player-1" });
    for (const id of [soon, over, crypto.randomUUID()])
      expect(await tap(socket, id, 1, 1)).toEqual({ type: "mash-denied", id, reason: "closed" });
    await database.db.prepare("UPDATE streamers SET status = 'frozen' WHERE id = ?").bind(streamerId).run();
    const live = await rows.addBattle({ "player-1": 0 });
    expect(await tap(socket, live, 1, 1)).toMatchObject({ reason: "closed" });
  });

  it("remembers for two seconds that a battle is not live", async (): Promise<void> => {
    const id = await rows.addPoll();
    const socket = await join({ user: "player-1" });
    expect(await tap(socket, id, 1, 1)).toMatchObject({ reason: "closed" });
    await database.db.batch([
      database.db.prepare("INSERT OR IGNORE INTO user (id) VALUES ('player-1')"),
      database.db.prepare("INSERT INTO entry_votes (entry_id, user_id, choice) VALUES (?, 'player-1', 0)").bind(id),
      database.db
        .prepare(
          "INSERT INTO entry_mash (entry_id, duration_s, phase, starts_at, ends_at) VALUES (?, 10, 'live', ?, ?)",
        )
        .bind(id, Date.now(), Date.now() + 10_000),
    ]);
    vi.setSystemTime(Date.now() + 1_999);
    expect(await tap(socket, id, 1, 2)).toMatchObject({ reason: "closed" });
    vi.setSystemTime(Date.now() + 1);
    expect(await tap(socket, id, 1, 3)).toMatchObject({ type: "mash-ack", accepted: 1 });
  });

  it("forgets a not-live battle at once when the API says it started", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 }, { phase: "countdown", startsAt: Date.now() + 60_000 });
    const socket = await join({ user: "player-1" });
    await database.db.prepare("DELETE FROM entry_mash WHERE entry_id = ?").bind(id).run();
    expect(await tap(socket, id, 1, 1)).toMatchObject({ reason: "closed" });
    await database.db
      .prepare("INSERT INTO entry_mash (entry_id, duration_s, phase, starts_at, ends_at) VALUES (?, 10, 'live', ?, ?)")
      .bind(id, Date.now(), Date.now() + 10_000)
      .run();
    expect((await post("mash", { id })).status).toBe(204);
    expect(await tap(socket, id, 1, 2)).toMatchObject({ type: "mash-ack" });
  });

  it("refuses a battle notice without a battle id", async (): Promise<void> => {
    for (const body of ["not json", { id: 7 }, { id: "not-a-uuid" }, null]) {
      const response = await call("mash", {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      expect(await response.json()).toEqual({ error: "Invalid battle" });
    }
  });
});

describe("live room token bucket", (): void => {
  it("holds one account to 15 taps a second across all of its sockets", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0, "player-2": 1 });
    const first = await join({ user: "player-1" });
    const second = await join({ key: "b".repeat(64), user: "player-1" });
    expect(await tap(first, id, 500, 1)).toEqual({ type: "mash-ack", id, mine: 15, accepted: 15 });
    expect(await tap(second, id, 20, 1)).toEqual({ type: "mash-ack", id, mine: 15, accepted: 0 });
    // Another account has its own bucket.
    expect(await tap(await join({ key: "c".repeat(64), user: "player-2" }), id, 4, 1)).toMatchObject({ accepted: 4 });
    vi.setSystemTime(Date.now() + 400);
    expect(await tap(second, id, 20, 2)).toMatchObject({ accepted: 6, mine: 21 });
  });

  it("holds assisted tapping to 6 taps a second", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 1 });
    expect(await tap(await join({ user: "player-1" }), id, 20, 1, true)).toMatchObject({ accepted: 6 });
  });

  it("never counts a batch number the socket already sent", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 });
    const socket = await join({ user: "player-1" });
    expect(await tap(socket, id, 2, 5)).toMatchObject({ accepted: 2, mine: 2 });
    expect(await tap(socket, id, 2, 5)).toBeUndefined();
    expect(await tap(socket, id, 2, 4)).toBeUndefined();
    expect(await tap(socket, id, 1, 6)).toMatchObject({ accepted: 1, mine: 3 });
    // Batch numbers are per socket: a new socket of the account starts again.
    expect(await tap(await join({ key: "b".repeat(64), user: "player-1" }), id, 1, 0)).toMatchObject({ mine: 4 });
  });

  it("looks a side up again after a failed lookup, and stays silent for the failed batch", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 });
    const socket = await join({ user: "player-1" });
    await post("mash", { id });
    faults.fail(/FROM entry_votes/);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await tap(socket, id, 2, 1)).toBeUndefined();
    expect(errors).toHaveBeenCalledWith("mash_side_lookup_failed");
    faults.heal();
    expect(await tap(socket, id, 2, 2)).toMatchObject({ type: "mash-ack", accepted: 2 });
    errors.mockRestore();
  });

  it("looks a side up once for overlapping batches", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 });
    const first = await join({ user: "player-1" });
    const second = await join({ key: "b".repeat(64), user: "player-1" });
    await post("mash", { id });
    const lookups = vi.spyOn(faults.db, "prepare");
    await Promise.all([tap(first, id, 1, 1), tap(second, id, 1, 1)]);
    const sideQueries = lookups.mock.calls.filter(([sql]) => sql.includes("FROM entry_votes"));
    expect(sideQueries).toHaveLength(1);
    expect(lastOf<Reply>(second, "mash-ack")).toMatchObject({ mine: 2 });
  });
});

describe("live room battles", (): void => {
  it("broadcasts live totals with players, assisted players and taps a second", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0, "player-2": 1 });
    const one = await join({ user: "player-1" });
    const two = await join({ key: "b".repeat(64), user: "player-2" });
    await tap(one, id, 3, 1);
    await tap(two, id, 2, 1, true);
    await alarmAfter(MASH_TICK_MS);
    expect(lastOf<Tick>(two, "mash")).toMatchObject({
      id,
      phase: "live",
      totals: [3, 2],
      players: 2,
      assisted: 1,
      tps: 5,
      left: 10,
    });
    // A late joiner sees the counted taps that D1 has not seen yet.
    const late = await join({ key: "c".repeat(64) });
    expect(late.messages<LiveSnapshot>()[0].polls[0].mash).toMatchObject({ totals: [3, 2], players: 2, assisted: 1 });
  });

  it("sends a tick only for a change, and every fifth tick regardless", async (): Promise<void> => {
    await rows.addBattle({});
    const socket = await join();
    const ticks = (): number => socket.ofType("mash").length;
    await alarmAfter(MASH_TICK_MS);
    expect(ticks()).toBe(1);
    for (let index = 0; index < 3; index += 1) await fireAlarm();
    expect(ticks()).toBe(1);
    await fireAlarm();
    expect(ticks()).toBe(2);
  });

  it("runs the 5 Hz ticker while a battle runs and stops it when the battle is gone", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 });
    const socket = await join({ user: "player-1" });
    await tap(socket, id, 1, 1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(MASH_TICK_MS);
    await vi.waitFor(() => expect(socket.ofType("mash")).toHaveLength(1));
    await database.db.prepare("UPDATE entry_mash SET phase = 'setup' WHERE entry_id = ?").bind(id).run();
    await post("mash", { id });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs a failed tick and keeps ticking", async (): Promise<void> => {
    const id = await rows.addBattle({}, { phase: "countdown", startsAt: Date.now() + 100 });
    const socket = await join();
    await post("mash", { id });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    faults.fail(/SET phase='live'/);
    vi.advanceTimersByTime(MASH_TICK_MS);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("mash_tick_failed"));
    faults.heal();
    vi.advanceTimersByTime(MASH_TICK_MS);
    await vi.waitFor(() => expect(lastOf<Tick>(socket, "mash")?.phase).toBe("live"));
    errors.mockRestore();
  });

  it("writes taps to D1 once a second, never sooner", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 });
    const socket = await join({ user: "player-1" });
    await tap(socket, id, 3, 1);
    await alarmAfter(MASH_FLUSH_MS - 1);
    expect(await rows.storedTaps(id)).toEqual([]);
    await alarmAfter(1);
    expect(await rows.storedTaps(id)).toEqual([{ user_id: "player-1", side: 0, taps: 3 }]);
    await tap(socket, id, 2, 2, true);
    await alarmAfter(MASH_FLUSH_MS);
    const stored = await database.db
      .prepare("SELECT taps, assisted_taps FROM mash_taps WHERE entry_id = ?")
      .bind(id)
      .first();
    expect(stored).toEqual({ taps: 5, assisted_taps: 2 });
  });

  it("keeps taps that could not be written and adds them to the next write", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0, "player-2": 1 });
    const one = await join({ user: "player-1" });
    const two = await join({ key: "b".repeat(64), user: "player-2" });
    await tap(one, id, 3, 1);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let release = (): void => undefined;
    faults.fail(
      /INSERT INTO mash_taps/,
      new Promise<void>((resolve): void => {
        release = resolve;
      }),
    );
    const flushing = alarmAfter(MASH_FLUSH_MS);
    await vi.waitFor(() => expect(faults.held()).toBe(1));
    // Taps counted while the failing write is in flight.
    await tap(one, id, 2, 2);
    await tap(two, id, 4, 1);
    release();
    await flushing;
    expect(errors).toHaveBeenCalledWith("mash_flush_failed");
    expect(await rows.storedTaps(id)).toEqual([]);
    faults.heal();
    await alarmAfter(MASH_FLUSH_MS);
    expect(await rows.storedTaps(id)).toEqual([
      { user_id: "player-1", side: 0, taps: 5 },
      { user_id: "player-2", side: 1, taps: 4 },
    ]);
    errors.mockRestore();
  });

  it("goes live at the end of the countdown, in memory and in D1", async (): Promise<void> => {
    const startsAt = Date.now() + 3_000;
    const id = await rows.addBattle({ "player-1": 0 }, { phase: "countdown", startsAt });
    const socket = await join({ user: "player-1" });
    await post("mash", { id });
    await alarmAfter(MASH_TICK_MS);
    expect(lastOf<Tick>(socket, "mash")?.phase).toBe("countdown");
    expect(await rows.battleRow(id)).toMatchObject({ phase: "countdown" });
    vi.setSystemTime(startsAt);
    await fireAlarm();
    expect(lastOf<Tick>(socket, "mash")?.phase).toBe("live");
    expect(await rows.battleRow(id)).toMatchObject({ phase: "live" });
    expect(await tap(socket, id, 1, 1)).toMatchObject({ type: "mash-ack" });
  });

  it("ends a battle on time: last write, the winner, a new revision and a snapshot for everyone", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0, "player-2": 1 });
    const one = await join({ user: "player-1" });
    const two = await join({ key: "b".repeat(64), user: "player-2" });
    await tap(one, id, 3, 1);
    await tap(two, id, 1, 1);
    await alarmAfter(10_000);
    expect(await rows.battleRow(id)).toEqual({ phase: "finished", winner: 0 });
    expect(await rows.storedTaps(id)).toEqual([
      { user_id: "player-1", side: 0, taps: 3 },
      { user_id: "player-2", side: 1, taps: 1 },
    ]);
    expect(lastOf<LiveSnapshot>(two, "snapshot")).toMatchObject({ revision: 1, polls: [{ id, kind: "mash" }] });
    expect(lastOf<LiveSnapshot>(two, "snapshot")?.polls[0].mash).toMatchObject({ phase: "finished", winner: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stores a draw for a tie and for a battle nobody tapped in", async (): Promise<void> => {
    const tie = await rows.addBattle({ "player-1": 0, "player-2": 1 });
    const empty = await rows.addBattle({});
    await tap(await join({ user: "player-1" }), tie, 2, 1);
    await tap(await join({ key: "b".repeat(64), user: "player-2" }), tie, 2, 1);
    await post("mash", { id: empty });
    await alarmAfter(10_000);
    expect(await rows.battleRow(tie)).toEqual({ phase: "finished", winner: -1 });
    expect(await rows.battleRow(empty)).toEqual({ phase: "finished", winner: -1 });
  });

  it("ends a battle on time with nobody watching, after the room woke up", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 });
    await database.db
      .prepare("INSERT INTO mash_taps (entry_id, user_id, side, taps, assisted_taps) VALUES (?, 'player-1', 0, 4, 0)")
      .bind(id)
      .run();
    expect((await post("refresh")).status).toBe(204);
    await fireAlarm();
    // Nobody watches, yet the alarm is due at the battle's end.
    expect(state().storage.alarm).toBe(Date.now() + 10_000);
    await alarmAfter(10_000);
    expect(await rows.battleRow(id)).toEqual({ phase: "finished", winner: 0 });
  });

  it("keeps a battle open while its last taps cannot be written, then stores the right winner", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0, "player-2": 1 });
    const one = await join({ user: "player-1" });
    await tap(await join({ key: "b".repeat(64), user: "player-2" }), id, 1, 1);
    await alarmAfter(MASH_FLUSH_MS);
    await tap(one, id, 3, 1);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    faults.fail(/INSERT INTO mash_taps/);
    await alarmAfter(10_000);
    // Without its last taps side 2 would win; the battle stays open instead.
    expect(await rows.battleRow(id)).toEqual({ phase: "live", winner: null });
    faults.heal();
    await alarmAfter(MASH_TICK_MS);
    expect(await rows.battleRow(id)).toEqual({ phase: "finished", winner: 0 });
    errors.mockRestore();
  });

  it("tries the end again when storing the winner fails", async (): Promise<void> => {
    const id = await rows.addBattle({});
    await join();
    await post("mash", { id });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    faults.fail(/SET phase='finished'/);
    await alarmAfter(10_000);
    expect(errors).toHaveBeenCalledWith("mash_finish_failed");
    expect(await rows.battleRow(id)).toMatchObject({ phase: "live" });
    faults.heal();
    await fireAlarm();
    expect(await rows.battleRow(id)).toMatchObject({ phase: "finished" });
    errors.mockRestore();
  });

  it("drops a restarted battle with its unwritten taps and refuses new ones", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 });
    const socket = await join({ user: "player-1" });
    await tap(socket, id, 2, 1);
    await database.db
      .prepare("UPDATE entry_mash SET phase = 'setup', starts_at = NULL, ends_at = NULL WHERE entry_id = ?")
      .bind(id)
      .run();
    expect((await post("mash", { id })).status).toBe(204);
    expect(await tap(socket, id, 2, 2)).toMatchObject({ reason: "closed" });
    await alarmAfter(MASH_FLUSH_MS);
    expect(await rows.storedTaps(id)).toEqual([]);
  });

  it("starts a restarted run from the taps D1 holds for it", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 });
    const socket = await join({ user: "player-1" });
    await tap(socket, id, 2, 1);
    const next = Date.now() + 5_000;
    await database.db
      .prepare("UPDATE entry_mash SET phase = 'countdown', starts_at = ?, ends_at = ? WHERE entry_id = ?")
      .bind(next, next + 10_000, id)
      .run();
    await post("mash", { id });
    vi.setSystemTime(next);
    expect(await tap(socket, id, 1, 2)).toMatchObject({ type: "mash-ack", mine: 1 });
  });

  it("never lets the end of an old run touch the restarted battle", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 }, { endsAt: Date.now() + 2_500 });
    const socket = await join({ user: "player-1" });
    await tap(socket, id, 2, 1);
    await post("mash", { id });
    // The owner restarted and started again; the room still holds the old run and its unwritten taps.
    const next = Date.now() + MINUTE;
    await database.db.batch([
      database.db.prepare("DELETE FROM mash_taps WHERE entry_id = ?").bind(id),
      database.db
        .prepare(
          "UPDATE entry_mash SET phase = 'countdown', starts_at = ?, ends_at = ?, winner = NULL WHERE entry_id = ?",
        )
        .bind(next, next + 10_000, id),
    ]);
    const snapshots = socket.ofType("snapshot").length;
    // Only the ticker runs, so the room never reloads the battle from D1 before the old run ends.
    vi.setSystemTime(Date.now() + 2_500);
    vi.advanceTimersToNextTimer();
    await vi.waitFor(() => expect(socket.ofType("snapshot").length).toBeGreaterThan(snapshots));
    expect(await rows.battleRow(id)).toEqual({ phase: "countdown", winner: null });
    expect(await rows.storedTaps(id)).toEqual([]);
  });

  it("keeps the alarm after the last socket closes while a battle runs", async (): Promise<void> => {
    const id = await rows.addBattle({ "player-1": 0 });
    const socket = await join({ user: "player-1" });
    await tap(socket, id, 1, 1);
    socket.close(1000, "Gone");
    await room().webSocketClose(socket as unknown as WebSocket, 1000, "Gone", true);
    expect(state().storage.alarm).not.toBeNull();
  });
});
