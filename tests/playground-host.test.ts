import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import { type ActivityChat, type ActivityEvent, parseActivityMessage } from "../app/lib/activity";
import { DEFAULT_LAYERS, emptyCells, storedLayersText, type OverlayLayers } from "../app/lib/overlay-layers";
import { CHARACTERS_TEST_MS } from "../app/lib/playground/constants";
import {
  CHAR_STATES,
  type PlaygroundFrame,
  type PlaygroundStatus,
  type RosterEntry,
} from "../app/lib/playground/protocol";
import { ChannelIngest } from "../app/server/channel-ingest";
import {
  CHECKPOINT_MS,
  FRAME_MS,
  LAYER_CHECK_MS,
  PLAYGROUND_KEY,
  type PlaygroundClock,
  PlaygroundHost,
  type ReactionSubject,
  readLayers,
  WATCHDOG_MS,
} from "../app/server/playground-host";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import {
  type FakeSocket,
  faultyDatabase,
  installWorkersRuntime,
  RoomNamespace,
  type RoomState,
  serverSocketOf,
} from "./helpers/room";

vi.mock("cloudflare:workers", () => import("./helpers/room"));

/** The character playground inside the page's ingest object: sockets, ticking, checkpoints and controls. */

const T0 = 1_800_000_000_000;
const page = "60000000-0000-4000-8000-000000000001";
const otherPage = "60000000-0000-4000-8000-000000000002";
const JUMP: number = CHAR_STATES.indexOf("jump");

let database: TestDatabase;
let env: AppEnv;
let ingest: RoomNamespace<ChannelIngest>;

function url(path: string, streamerId: string, query: Record<string, string> = {}): string {
  return `https://channel-ingest.internal/${path}?${new URLSearchParams({ streamerId, ...query })}`;
}

function post(
  path: string,
  body?: unknown,
  streamerId: string = page,
  query: Record<string, string> = {},
): Promise<Response> {
  return ingest.get(ingest.idFromName(streamerId)).fetch(url(path, streamerId, query), {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function listen(
  options: { characters?: boolean; overlay?: boolean; streamerId?: string } = {},
): Promise<FakeSocket> {
  const streamerId = options.streamerId ?? page;
  const headers: Record<string, string> = options.overlay ? { "X-SB-Overlay": "horizontal" } : { "X-SB-Owner": "1" };
  const response = await ingest
    .get(ingest.idFromName(streamerId))
    .fetch(url("subscribe", streamerId, options.characters === false ? {} : { characters: "1" }), {
      headers: { Upgrade: "websocket", ...headers },
    });
  expect(response.status).toBe(101);
  return serverSocketOf(response.webSocket);
}

function chat(messageId: string, userId: string, text: string, live = true): ActivityChat {
  return {
    kind: "chat",
    id: `twitch:${messageId}`,
    platform: "twitch",
    channelId: "111",
    messageId,
    user: { id: userId, displayName: `User ${userId}` },
    text,
    fragments: [{ type: "text", text }],
    badges: [],
    sentAt: null,
    receivedAt: Date.now(),
    live,
  };
}

let deliveries = 0;
function deliver(events: ActivityEvent[], streamerId: string = page): Promise<Response> {
  deliveries += 1;
  const channelId = streamerId === page ? "111" : "222";
  return post("event", { deliveryId: `d${deliveries}`, channelId, events }, streamerId, { platform: "twitch" });
}

/** The playground frames a socket got, parsed by the consumer's own parser. */
function frames(socket: FakeSocket): PlaygroundFrame[] {
  return socket.sent.flatMap((raw: string): PlaygroundFrame[] => {
    const message = parseActivityMessage(raw);
    return message?.type === "playground" ? [message] : [];
  });
}

/** The roster the frames of a socket add up to. */
function roster(socket: FakeSocket): RosterEntry[] {
  let current: RosterEntry[] = [];
  for (const frame of frames(socket)) if (frame.roster) current = frame.roster;
  return current;
}

function lastMode(socket: FakeSocket): { paused: boolean; test: boolean } | undefined {
  let mode: { paused: boolean; test: boolean } | undefined;
  for (const frame of frames(socket)) if (frame.mode) mode = frame.mode;
  return mode;
}

/** The terrain that the frames of a socket add up to. */
function lastTerrain(socket: FakeSocket): { ground: string; blocks: string } | undefined {
  let terrain: { ground: string; blocks: string } | undefined;
  for (const frame of frames(socket)) if (frame.terrain) terrain = frame.terrain;
  return terrain;
}

function state(streamerId: string = page): RoomState {
  return ingest.entry(streamerId).state;
}

function room(streamerId: string = page): ChannelIngest {
  return ingest.entry(streamerId).room;
}

async function setLayers(layers: OverlayLayers, streamerId: string = page): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO overlay_state (streamer_id,position,revision,updated_at,layers) VALUES (?,'lower',1,1,?)
      ON CONFLICT(streamer_id) DO UPDATE SET layers=excluded.layers`,
  )
    .bind(streamerId, storedLayersText(layers))
    .run();
}

/** The characters on stream in both orientations. */
const ON: OverlayLayers = {
  ...DEFAULT_LAYERS,
  characters: { enabled: true, timeout: 60, max: 40 },
  cells: {
    horizontal: { ...emptyCells(), characters: { c: 0, r: 14, w: 32, h: 4 } },
    vertical: { ...emptyCells(), characters: { c: 0, r: 26, w: 18, h: 6 } },
  },
};

async function control(body: unknown, streamerId: string = page): Promise<{ status: number; body: unknown }> {
  const response = await post("playground", body, streamerId);
  return { status: response.status, body: await response.json() };
}

/** Records the SQL of each D1 statement the objects prepare from now on. */
function watchQueries(): string[] {
  const real: D1Database = env.DB;
  const queries: string[] = [];
  env.DB = {
    prepare: (sql: string): D1PreparedStatement => {
      queries.push(sql);
      return real.prepare(sql);
    },
    batch: real.batch.bind(real),
  } as unknown as D1Database;
  return queries;
}

/** Runs the object's alarm at its time, as the runtime does: the alarm is cleared first. */
async function fireAlarm(): Promise<void> {
  const at: number | null = state().storage.alarm;
  if (at === null) throw new Error("no alarm set");
  await state().storage.deleteAlarm();
  vi.setSystemTime(Math.max(Date.now(), at));
  await room().alarm();
}

/** Advances the clock and the frame interval. */
function advance(ms: number): void {
  vi.advanceTimersByTime(ms);
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: T0 });
  installWorkersRuntime();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    POLL_ROOMS: {} as DurableObjectNamespace,
    CHANNEL_INGEST: {} as DurableObjectNamespace,
    REQUEST_LIMITER: {} as RateLimit,
    APP_ORIGIN: "https://playground.example.test",
    BETTER_AUTH_SECRET: "x".repeat(40),
  };
  ingest = new RoomNamespace(
    (roomState: RoomState) => new ChannelIngest(roomState as unknown as DurableObjectState, env),
  );
  env.CHANNEL_INGEST = ingest as unknown as DurableObjectNamespace;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare(
      "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('owner','O','o@x.test',1,1,1)",
    ),
    env.DB.prepare(
      "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('other','P','p@x.test',1,1,1)",
    ),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','host_page','Host')").bind(page),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'other','other_page','Other')").bind(
      otherPage,
    ),
    env.DB.prepare(
      `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,status,created_at,updated_at)
        VALUES ('conn-a',?,'twitch','111','Host','','active',1,1), ('conn-b',?,'twitch','222','Other','','active',1,1)`,
    ).bind(page, otherPage),
  ]);
  await setLayers(ON);
});

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("characters sockets", (): void => {
  it("start the playground: the snapshot, a full frame, then a tick frame every 100 ms", async (): Promise<void> => {
    const socket = await listen();
    expect(state().tagsOf(socket)).toEqual(["activity", "owner", "characters"]);
    expect(socket.messages<{ type: string }>().map((message) => message.type)).toEqual(["snapshot", "playground"]);
    const [full] = frames(socket);
    expect(full).toMatchObject({ full: true, tick: 0, chars: [], roster: [], mode: { paused: false, test: false } });
    // The characters cell is 32 x 4: a world of 640 x 80 logical px.
    expect(full.full && full.terrain).toMatchObject({ w: 640, h: 80 });
    expect(vi.getTimerCount()).toBe(1);
    expect(state().storage.alarm).toBe(T0 + WATCHDOG_MS);
    advance(FRAME_MS);
    expect(frames(socket)[1]).toMatchObject({ full: false, tick: 3 });
    advance(FRAME_MS * 9);
    expect(frames(socket).map((frame) => frame.tick)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
  });

  it("send identical frames to every characters socket and admit chat as characters", async (): Promise<void> => {
    const first = await listen();
    const second = await listen({ overlay: true });
    advance(FRAME_MS);
    await deliver([chat("m1", "u1", "hello"), chat("m2", "u2", "!jump")]);
    advance(FRAME_MS * 5);
    const ticks = (socket: FakeSocket): string[] => socket.sent.filter((raw: string) => raw.includes('"full":false'));
    expect(ticks(first)).toHaveLength(6);
    expect(ticks(second)).toEqual(ticks(first));
    expect(
      roster(first)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["User u1", "User u2"]);
    // Frames carry short numeric ids, never the platform user ids.
    expect(JSON.stringify(frames(first))).not.toContain('"u1"');
    // Chat events still reach both sockets.
    expect(first.ofType("event")).toHaveLength(2);
  });

  it("never send playground frames to a chat-only socket, and run nothing for it", async (): Promise<void> => {
    const socket = await listen({ characters: false });
    await deliver([chat("m1", "u1", "!jump")]);
    advance(FRAME_MS * 5);
    expect(state().tagsOf(socket)).toEqual(["activity", "owner"]);
    expect(socket.messages<{ type: string }>().map((message) => message.type)).toEqual(["snapshot", "event"]);
    expect(frames(socket)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
  });

  it("stop at the next frame after the last characters socket closes, and save a checkpoint", async (): Promise<void> => {
    const first = await listen();
    const second = await listen();
    first.close();
    room().webSocketClose(first as unknown as WebSocket);
    advance(FRAME_MS);
    expect(vi.getTimerCount()).toBe(1);
    second.close();
    room().webSocketClose(second as unknown as WebSocket);
    advance(FRAME_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(state().storage.values.get(PLAYGROUND_KEY)).toMatchObject({ v: 1, enabled: true, test: null });
    const count = second.sent.length;
    advance(FRAME_MS * 5);
    expect(second.sent).toHaveLength(count);
  });

  it("stop when a socket errors or sends a message", async (): Promise<void> => {
    const socket = await listen();
    room().webSocketError(socket as unknown as WebSocket);
    advance(FRAME_MS);
    expect(vi.getTimerCount()).toBe(0);
    const next = await listen();
    expect(vi.getTimerCount()).toBe(1);
    room().webSocketMessage(next as unknown as WebSocket);
    expect(next.closeCode).toBe(1008);
    advance(FRAME_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop at the next frame when the sockets are gone without a close event", async (): Promise<void> => {
    const socket = await listen();
    socket.close();
    advance(FRAME_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(true);
  });
});

describe("registry mode", (): void => {
  it("keeps scores and moderation without a characters socket, but drops commands", async (): Promise<void> => {
    const socket = await listen();
    await deliver([chat("m1", "u1", "hello")]);
    socket.close();
    room().webSocketClose(socket as unknown as WebSocket);
    advance(FRAME_MS);
    // Without a socket: a command, a new speaker and a ban.
    await deliver([chat("m2", "u1", "!jump"), chat("m3", "u2", "hi")]);
    await deliver([{ kind: "ban", platform: "twitch", userId: "u2", until: null, receivedAt: Date.now() }]);
    expect(vi.getTimerCount()).toBe(0);
    // The change is saved by the alarm, at most every CHECKPOINT_MS.
    expect(state().storage.alarm).toBeLessThanOrEqual(Date.now() + CHECKPOINT_MS);
    advance(CHECKPOINT_MS);
    await room().alarm();
    const stored = state().storage.values.get(PLAYGROUND_KEY) as { sim: string };
    expect(stored.sim).toContain('"u1"');
    expect(stored.sim).not.toContain('"twitch","u2"');
    const back = await listen();
    expect(roster(back).map((entry) => entry.name)).toEqual(["User u1"]);
    advance(FRAME_MS * 30);
    expect(frames(back).some((frame) => frame.chars.some((char) => char[3] === JUMP))).toBe(false);
  });

  it("forgets a viewer 30 minutes after their last message through the alarm, then deletes the checkpoint", async (): Promise<void> => {
    const socket = await listen();
    await deliver([chat("m1", "u1", "hello")]);
    const spoke: number = Date.now();
    advance(FRAME_MS);
    socket.close();
    room().webSocketClose(socket as unknown as WebSocket);
    advance(FRAME_MS);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    const expectedCheckpoint: unknown = expect.stringContaining('"u1"');
    expect(state().storage.values.get(PLAYGROUND_KEY)).toMatchObject({ sim: expectedCheckpoint });
    // No more chat: the alarms alone forget the viewer on time; they also read the layers every minute.
    for (let i = 0; i < 40 && state().storage.values.has(PLAYGROUND_KEY); i += 1) {
      expect(state().storage.alarm).toBeLessThanOrEqual(spoke + 30 * 60_000 + 1_000);
      await fireAlarm();
    }
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
    expect(Date.now()).toBeGreaterThanOrEqual(spoke + 30 * 60_000);
    // A new socket starts an empty playground.
    const back = await listen();
    expect(frames(back)[0]).toMatchObject({ full: true, roster: [] });
  });

  it("keeps a restriction until it ends, then nothing", async (): Promise<void> => {
    const socket = await listen();
    socket.close();
    room().webSocketClose(socket as unknown as WebSocket);
    advance(FRAME_MS);
    await deliver([
      { kind: "ban", platform: "twitch", userId: "u9", until: Date.now() + 60_000, receivedAt: Date.now() },
    ]);
    await fireAlarm();
    expect((state().storage.values.get(PLAYGROUND_KEY) as { sim: string }).sim).toContain("twitch:u9");
    for (let i = 0; i < 20 && state().storage.values.has(PLAYGROUND_KEY); i += 1) await fireAlarm();
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
    expect(Date.now()).toBeLessThan(T0 + 30 * 60_000);
  });

  it("keeps nothing with the characters layer off: a status read and chat create no playground", async (): Promise<void> => {
    await setLayers(DEFAULT_LAYERS);
    expect(await control({ op: "status" })).toEqual({ status: 200, body: { paused: false, testEndsAt: null } });
    await deliver([chat("m1", "u1", "hello")]);
    const socket = await listen();
    await deliver([chat("m2", "u1", "hello again")]);
    advance(CHECKPOINT_MS * 2);
    expect(frames(socket)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
    // A control other than status creates nothing either.
    expect(await control({ op: "pause" })).toEqual({ status: 200, body: { paused: false, testEndsAt: null } });
    expect(await control({ op: "remove", id: 1 })).toMatchObject({ status: 404 });
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
  });

  it("deletes the playground when the layer turns off, also without a socket", async (): Promise<void> => {
    const socket = await listen();
    await deliver([chat("m1", "u1", "hello")]);
    socket.close();
    room().webSocketClose(socket as unknown as WebSocket);
    advance(FRAME_MS);
    await Promise.resolve();
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(true);
    await setLayers(DEFAULT_LAYERS);
    expect((await post("playground-config")).status).toBe(204);
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
    await deliver([chat("m2", "u1", "hello")]);
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
  });

  it("deletes the playground at the next alarm, within a minute, when the layer change notice is lost", async (): Promise<void> => {
    const socket = await listen();
    await deliver([chat("m1", "u1", "hello")]);
    socket.close();
    room().webSocketClose(socket as unknown as WebSocket);
    advance(FRAME_MS);
    await Promise.resolve();
    await fireAlarm();
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(true);
    // The layer turns off, but no /playground-config request arrives.
    await setLayers(DEFAULT_LAYERS);
    const off: number = Date.now();
    expect(state().storage.alarm).toBeLessThanOrEqual(off + LAYER_CHECK_MS);
    await fireAlarm();
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
    expect(Date.now()).toBeLessThanOrEqual(off + LAYER_CHECK_MS);
    expect(await control({ op: "status" })).toEqual({ status: 200, body: { paused: false, testEndsAt: null } });
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
  });

  it("deletes a checkpoint whose delete failed, also after an eviction restored it", async (): Promise<void> => {
    const socket = await listen();
    await deliver([chat("m1", "u1", "hello")]);
    socket.close();
    room().webSocketClose(socket as unknown as WebSocket);
    advance(FRAME_MS);
    await Promise.resolve();
    const error = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const remove = vi.spyOn(state().storage, "delete").mockRejectedValueOnce(new TypeError("storage detail"));
    await setLayers(DEFAULT_LAYERS);
    expect((await post("playground-config")).status).toBe(204);
    expect(error).toHaveBeenCalledWith("playground_checkpoint_delete_failed", { cause: "TypeError" });
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(true);
    remove.mockRestore();
    // The object is evicted before its alarm, and the alarm is gone too: the new instance restores the checkpoint
    // saved with the layer on, and sets an alarm for it.
    await state().storage.deleteAlarm();
    ingest.restart(page);
    await state().ready;
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(true);
    expect(state().storage.alarm).toBeLessThanOrEqual(Date.now() + LAYER_CHECK_MS);
    await fireAlarm();
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
  });

  it("drops an old checkpoint saved with the layer off", async (): Promise<void> => {
    await state().storage.put(PLAYGROUND_KEY, { v: 1, sim: "{}", enabled: false, at: 1, test: null });
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    ingest.restart(page);
    await state().ready;
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
    expect(warn).toHaveBeenCalledWith("playground_checkpoint_invalid");
  });

  it("ignores chat before the playground ever ran", async (): Promise<void> => {
    await deliver([chat("m1", "u1", "hello")]);
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
    expect(state().storage.alarm).not.toBeNull();
  });
});

describe("eviction", (): void => {
  it("restores the checkpoint in a new instance without replaying a command", async (): Promise<void> => {
    const socket = await listen();
    await deliver([chat("m1", "u1", "hello")]);
    advance(FRAME_MS * 10);
    await deliver([chat("m2", "u1", "!jump")]);
    // The checkpoint of the last frame interval: the command is queued, but never stored.
    advance(CHECKPOINT_MS);
    const stored = state().storage.values.get(PLAYGROUND_KEY) as { sim: string; at: number };
    expect(stored.sim).not.toContain("jump");
    const id = roster(socket)[0].id;
    ingest.restart(page);
    expect(vi.getTimerCount()).toBe(1);
    // The old interval belongs to the old instance; the hibernated socket survives the eviction.
    vi.clearAllTimers();
    socket.readyState = 1;
    await state().ready;
    const count = socket.sent.length;
    // The watchdog alarm restarts the playground and sends the socket a new full frame.
    await room().alarm();
    expect(vi.getTimerCount()).toBe(1);
    expect(state().storage.alarm).toBe(Date.now() + WATCHDOG_MS);
    advance(FRAME_MS);
    const restored = frames({ sent: socket.sent.slice(count) } as FakeSocket);
    expect(restored[0]).toMatchObject({ full: true, roster: [{ id, name: "User u1" }] });
    advance(FRAME_MS * 29);
    const after = frames({ sent: socket.sent.slice(count) } as FakeSocket);
    expect(after.some((frame) => frame.chars.some((char) => char[0] === id && char[3] === JUMP))).toBe(false);
  });

  it("logs a fixed event for a malformed checkpoint and starts fresh", async (): Promise<void> => {
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    for (const value of ["{", { v: 1, sim: "{}", enabled: true, at: 1, test: null }, { v: 2 }]) {
      await state().storage.put(PLAYGROUND_KEY, value);
      ingest.restart(page);
      await state().ready;
      expect(warn).toHaveBeenLastCalledWith("playground_checkpoint_invalid");
      expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
    }
    const socket = await listen();
    expect(frames(socket)[0]).toMatchObject({ full: true, tick: 0, roster: [] });
  });
});

describe("closing", (): void => {
  it("stops for a revoked overlay key and keeps the owner's socket running", async (): Promise<void> => {
    const overlay = await listen({ overlay: true });
    expect((await post("overlay-key", { output: "horizontal" })).status).toBe(204);
    expect(overlay.closeCode).toBe(1001);
    advance(FRAME_MS);
    expect(vi.getTimerCount()).toBe(0);
    const owner = await listen();
    await post("overlay-key", { output: "horizontal" });
    expect(owner.open).toBe(true);
    advance(FRAME_MS);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops when the page is suspended", async (): Promise<void> => {
    const socket = await listen();
    await env.DB.prepare("UPDATE streamers SET status='suspended' WHERE id=?").bind(page).run();
    expect((await post("page-status")).status).toBe(204);
    expect(socket.closeCode).toBe(1001);
    advance(FRAME_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops when channels are off", async (): Promise<void> => {
    const socket = await listen();
    env.CHANNELS_OFF = "1";
    await room().alarm();
    expect(socket.closeCode).toBe(1001);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deletes the checkpoint when the page is deleted", async (): Promise<void> => {
    const socket = await listen();
    await deliver([chat("m1", "u1", "hello")]);
    advance(CHECKPOINT_MS);
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(true);
    expect((await post("close")).status).toBe(204);
    expect(socket.closeCode).toBe(1001);
    expect(vi.getTimerCount()).toBe(0);
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
    // A delivery after the close does not bring the playground back.
    await deliver([chat("m2", "u1", "hello")]);
    expect(state().storage.values.has(PLAYGROUND_KEY)).toBe(false);
  });
});

describe("controls", (): void => {
  it("pause and resume: a paused playground stands and shows the pause", async (): Promise<void> => {
    const socket = await listen();
    expect(await control({ op: "pause" })).toEqual({ status: 200, body: { paused: true, testEndsAt: null } });
    expect(vi.getTimerCount()).toBe(0);
    expect(lastMode(socket)).toEqual({ paused: true, test: false });
    // A socket that opens during the pause gets the paused frame and starts nothing.
    const late = await listen();
    expect(frames(late)[0]).toMatchObject({ full: true, mode: { paused: true } });
    expect(vi.getTimerCount()).toBe(0);
    expect(await control({ op: "resume" })).toEqual({ status: 200, body: { paused: false, testEndsAt: null } });
    expect(vi.getTimerCount()).toBe(1);
    advance(FRAME_MS);
    expect(lastMode(socket)).toEqual({ paused: false, test: false });
    expect((state().storage.values.get(PLAYGROUND_KEY) as { sim: string }).sim).toContain('"paused":false');
  });

  it("shows moderation at once while paused: a deleted message's bubble and a banned viewer go", async (): Promise<void> => {
    const socket = await listen();
    await deliver([chat("m1", "u1", "hello there"), chat("m2", "u2", "hi")]);
    let bubbles: string[] = [];
    for (let i = 0; i < 100 && bubbles.length === 0; i += 1) {
      advance(FRAME_MS);
      for (const frame of frames(socket)) if (frame.bubbles) bubbles = frame.bubbles.map((bubble) => bubble.text);
    }
    expect(bubbles).toContain("hello there");
    await control({ op: "pause" });
    const last = (): PlaygroundFrame => frames(socket).at(-1) as PlaygroundFrame;
    const sent: number = frames(socket).length;
    await deliver([{ kind: "delete", platform: "twitch", messageId: "m1", receivedAt: Date.now() }]);
    expect(frames(socket).length).toBe(sent + 1);
    expect(last()).toMatchObject({ full: true, mode: { paused: true } });
    expect(last().bubbles?.map((bubble) => bubble.text)).not.toContain("hello there");
    expect(roster(socket).map((entry) => entry.name)).toContain("User u1");
    await deliver([{ kind: "ban", platform: "twitch", userId: "u1", until: null, receivedAt: Date.now() }]);
    expect(roster(socket).map((entry) => entry.name)).not.toContain("User u1");
    expect(roster(socket).map((entry) => entry.name)).toContain("User u2");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a resume and a test to sockets that already had tick frames", async (): Promise<void> => {
    const socket = await listen();
    advance(FRAME_MS * 3);
    expect(lastMode(socket)).toEqual({ paused: false, test: false });
    await control({ op: "pause" });
    expect(lastMode(socket)).toEqual({ paused: true, test: false });
    await control({ op: "resume" });
    advance(FRAME_MS);
    expect(lastMode(socket)).toEqual({ paused: false, test: false });
    // A test started during a pause resumes the playground, so it shows at once.
    await control({ op: "pause" });
    expect(await control({ op: "test" })).toMatchObject({ body: { paused: false } });
    expect(vi.getTimerCount()).toBe(1);
    advance(FRAME_MS);
    expect(lastMode(socket)).toEqual({ paused: false, test: true });
    await control({ op: "pause" });
    await control({ op: "stopTest" });
    await control({ op: "resume" });
    advance(FRAME_MS);
    expect(lastMode(socket)).toEqual({ paused: false, test: false });
  });

  it("reset forgets every character, and remove takes one off", async (): Promise<void> => {
    const socket = await listen();
    await deliver([chat("m1", "u1", "hi"), chat("m2", "u2", "hi")]);
    advance(FRAME_MS);
    const [first, second] = roster(socket);
    expect((await control({ op: "remove", id: first.id })).status).toBe(200);
    advance(FRAME_MS);
    expect(roster(socket)).toEqual([second]);
    // A removed character stays off, also when it speaks again.
    await deliver([chat("m3", "u1", "back")]);
    advance(FRAME_MS);
    expect(roster(socket)).toEqual([second]);
    expect(await control({ op: "remove", id: 999 })).toEqual({ status: 404, body: { error: "Character not found" } });
    expect((await control({ op: "reset" })).status).toBe(200);
    advance(FRAME_MS);
    expect(roster(socket)).toEqual([]);
  });

  it("refuses a malformed control", async (): Promise<void> => {
    for (const body of [{}, { op: "jump" }, { op: "remove" }, { op: "remove", id: 0 }, { op: "pause", id: 1 }, "pause"])
      expect((await control(body)).status).toBe(400);
  });

  it("status reads the state and changes nothing", async (): Promise<void> => {
    const { body } = await control({ op: "test" });
    await control({ op: "pause" });
    const saved: unknown = state().storage.values.get(PLAYGROUND_KEY);
    advance(10_000);
    expect(await control({ op: "status" })).toEqual({
      status: 200,
      body: { paused: true, testEndsAt: (body as PlaygroundStatus).testEndsAt },
    });
    expect(state().storage.values.get(PLAYGROUND_KEY)).toBe(saved);
  });

  it("controls work before any characters socket opened", async (): Promise<void> => {
    expect(await control({ op: "pause" })).toEqual({ status: 200, body: { paused: true, testEndsAt: null } });
    expect(vi.getTimerCount()).toBe(0);
    const socket = await listen();
    expect(frames(socket)[0]).toMatchObject({ mode: { paused: true } });
  });

  it("plays a seeded test crowd beside the real chat, and ends it by stop or by time", async (): Promise<void> => {
    const socket = await listen();
    await deliver([chat("m1", "u1", "real")]);
    advance(FRAME_MS);
    const real = roster(socket)[0];
    const started = await control({ op: "test" });
    expect(started).toEqual({ status: 200, body: { paused: false, testEndsAt: Date.now() + CHARACTERS_TEST_MS } });
    advance(30_000);
    expect(lastMode(socket)).toEqual({ paused: false, test: true });
    expect(roster(socket).length).toBeGreaterThan(10);
    expect(roster(socket)).toContainEqual(real);
    // The test events never reach the activity sockets: only the one real chat message is there.
    expect(socket.ofType("event")).toHaveLength(1);
    expect(await control({ op: "stopTest" })).toEqual({ status: 200, body: { paused: false, testEndsAt: null } });
    advance(FRAME_MS);
    expect(lastMode(socket)).toEqual({ paused: false, test: false });
    expect(roster(socket)).toEqual([real]);
    // A second test runs out by itself.
    await control({ op: "test" });
    advance(CHARACTERS_TEST_MS + 2_000);
    expect(lastMode(socket)).toEqual({ paused: false, test: false });
    // The real participant stays in the registry; it walked out after the timeout, as it did not speak.
    advance(CHECKPOINT_MS);
    const stored = state().storage.values.get(PLAYGROUND_KEY) as { test: unknown; sim: string };
    expect(stored.test).toBeNull();
    const registry = (JSON.parse(stored.sim) as { registry: [number, string, string][] }).registry;
    expect(registry.map((record) => record[2])).toEqual(["u1"]);
  });

  it("keeps a running test across an eviction without replaying its past events", async (): Promise<void> => {
    const socket = await listen();
    const { body } = await control({ op: "test" });
    advance(20_000);
    const stored = state().storage.values.get(PLAYGROUND_KEY) as { test: { startMs: number } | null };
    expect(stored.test?.startMs).toBe(T0);
    ingest.restart(page);
    vi.clearAllTimers();
    socket.readyState = 1;
    await state().ready;
    await room().alarm();
    advance(FRAME_MS);
    expect(lastMode(socket)).toEqual({ paused: false, test: true });
    expect(await control({ op: "pause" })).toEqual({
      status: 200,
      body: { paused: true, testEndsAt: (body as PlaygroundStatus).testEndsAt },
    });
  });

  it("ends a paused test by the alarm alone: the sockets lose the test crowd and the checkpoint follows", async (): Promise<void> => {
    const socket = await listen();
    await deliver([chat("m1", "u1", "real")]);
    advance(FRAME_MS);
    const real = roster(socket)[0];
    await control({ op: "test" });
    advance(30_000);
    expect(roster(socket).length).toBeGreaterThan(1);
    await control({ op: "pause" });
    expect(vi.getTimerCount()).toBe(0);
    const ends: number = T0 + CHARACTERS_TEST_MS;
    for (let i = 0; i < 20 && Date.now() <= ends; i += 1) await fireAlarm();
    expect(Date.now()).toBeGreaterThan(ends);
    expect(lastMode(socket)).toEqual({ paused: true, test: false });
    expect(roster(socket)).toEqual([real]);
    const stored = state().storage.values.get(PLAYGROUND_KEY) as { test: unknown; sim: string };
    expect(stored.test).toBeNull();
    expect(JSON.parse(stored.sim)).toMatchObject({ testEndsAt: null });
    const registry = (JSON.parse(stored.sim) as { registry: [number, string, string][] }).registry;
    expect(registry.map((record) => record[2])).toEqual(["u1"]);
  });

  it("shows terrain that expires while paused: a hole dug before the pause repairs at the alarm", async (): Promise<void> => {
    const socket = await listen();
    const users: string[] = ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8"];
    await deliver(users.map((user: string, i: number) => chat(`m${i}`, user, "hello")));
    advance(10_000);
    await deliver(users.map((user: string, i: number) => chat(`d${i}`, user, "!dig")));
    advance(5_000);
    expect(lastTerrain(socket)?.ground).toMatch(/[123]/);
    await control({ op: "pause" });
    const sent: number = socket.sent.length;
    const ends: number = Date.now() + 31_000;
    for (let i = 0; i < 20 && Date.now() <= ends; i += 1) await fireAlarm();
    expect(Date.now()).toBeGreaterThan(ends);
    expect(socket.sent.length).toBeGreaterThan(sent);
    expect(lastTerrain(socket)?.ground).toMatch(/^[g0]+$/);
    expect(lastMode(socket)).toEqual({ paused: true, test: false });
  });

  it("clears the builds with one control and keeps the characters", async (): Promise<void> => {
    // A fixed seed: with some seeds no character builds a block in the 5 seconds.
    const random = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView<ArrayBuffer> | null>(array: T): T => {
        if (array instanceof Uint32Array && array.length === 1) array[0] = 7;
        else if (array) random(array);
        return array;
      },
    );
    const socket = await listen();
    const users: string[] = ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8"];
    await deliver(users.map((user: string, i: number) => chat(`m${i}`, user, "hello")));
    advance(10_000);
    await deliver(users.map((user: string, i: number) => chat(`b${i}`, user, "!up")));
    advance(5_000);
    expect(lastTerrain(socket)?.blocks).toMatch(/a/);
    expect((await control({ op: "clear" })).status).toBe(200);
    advance(FRAME_MS);
    expect(lastTerrain(socket)?.blocks).toBe("");
    expect(roster(socket)).toHaveLength(users.length);
  });

  it("forgets a viewer 30 minutes after their last message while paused, and shows and saves it", async (): Promise<void> => {
    const socket = await listen();
    await deliver([chat("m1", "u1", "hello")]);
    const spoke: number = Date.now();
    advance(FRAME_MS);
    await control({ op: "pause" });
    expect(roster(socket).map((entry) => entry.name)).toEqual(["User u1"]);
    for (let i = 0; i < 40 && Date.now() < spoke + 30 * 60_000; i += 1) await fireAlarm();
    expect(Date.now()).toBeGreaterThanOrEqual(spoke + 30 * 60_000);
    expect(roster(socket)).toEqual([]);
    expect(lastMode(socket)).toEqual({ paused: true, test: false });
    expect((state().storage.values.get(PLAYGROUND_KEY) as { sim: string }).sim).not.toContain('"u1"');
  });

  it("starts a test while the layer is saved on but stands until a socket listens", async (): Promise<void> => {
    expect((await control({ op: "test" })).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
    advance(10_000);
    const socket = await listen();
    // The events that fell due while nothing listened never play.
    expect(frames(socket)[0]).toMatchObject({ roster: [], mode: { test: true } });
  });
});

describe("configuration", (): void => {
  it("reads the saved layers again on a change: a new cell resizes the world, off stops", async (): Promise<void> => {
    const socket = await listen();
    const queries = watchQueries();
    const narrow: OverlayLayers = {
      ...ON,
      characters: { enabled: true, timeout: 120, max: 40 },
      cells: { ...ON.cells, horizontal: { ...ON.cells.horizontal, characters: { c: 0, r: 14, w: 16, h: 4 } } },
    };
    await setLayers(narrow);
    queries.length = 0;
    expect((await post("playground-config")).status).toBe(204);
    expect(queries).toEqual(["SELECT layers FROM overlay_state WHERE streamer_id=?"]);
    advance(FRAME_MS);
    const resized = frames(socket).at(-1);
    expect(resized?.terrain).toMatchObject({ w: 320, h: 80 });
    // The terrain of the last frame that sent one: a frame without a change of the world sends none.
    const lastTerrain = (): PlaygroundFrame["terrain"] =>
      frames(socket)
        .filter((frame: PlaygroundFrame): boolean => frame.terrain !== undefined)
        .at(-1)?.terrain;
    // One playground serves the two outputs. The output that the editor shows does not change its size.
    await setLayers({ ...narrow, orientation: "vertical" });
    await post("playground-config");
    advance(FRAME_MS);
    expect(frames(socket).at(-1)?.terrain).toBeUndefined();
    expect(lastTerrain()).toMatchObject({ w: 320, h: 80 });
    // Without a horizontal cell, the vertical cell gives the size, with each selected output.
    for (const orientation of ["horizontal", "vertical"] as const) {
      await setLayers({ ...narrow, cells: { ...narrow.cells, horizontal: emptyCells() }, orientation });
      await post("playground-config");
      advance(FRAME_MS);
      expect(lastTerrain()).toMatchObject({ w: 360, h: 120 });
    }
    await setLayers(DEFAULT_LAYERS);
    await post("playground-config");
    expect(vi.getTimerCount()).toBe(0);
    await setLayers(ON);
    await post("playground-config");
    expect(vi.getTimerCount()).toBe(1);
    // On the grid of one output only, the layer is on stream there: the playground runs, with each selected output.
    await setLayers({ ...ON, cells: { ...ON.cells, horizontal: emptyCells() } });
    await post("playground-config");
    expect(vi.getTimerCount()).toBe(1);
    await setLayers({ ...ON, cells: { ...ON.cells, vertical: emptyCells() }, orientation: "vertical" });
    await post("playground-config");
    expect(vi.getTimerCount()).toBe(1);
    // Off the grid of the two outputs, the layer is off stream: the playground stops.
    await setLayers({ ...ON, cells: { horizontal: emptyCells(), vertical: emptyCells() } });
    await post("playground-config");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not read the layers while no characters socket listens", async (): Promise<void> => {
    const queries = watchQueries();
    expect((await post("playground-config")).status).toBe(204);
    expect(queries).toEqual([]);
  });

  it("reads once more when the layers change during a read", async (): Promise<void> => {
    await listen();
    const queries = watchQueries();
    const narrow: OverlayLayers = {
      ...ON,
      cells: { ...ON.cells, horizontal: { ...ON.cells.horizontal, characters: { c: 0, r: 14, w: 16, h: 4 } } },
    };
    // The second change arrives while the first read runs; its read must see the newer layers.
    const first: Promise<Response> = post("playground-config");
    await setLayers(narrow);
    const second: Promise<Response> = post("playground-config");
    await Promise.all([first, second]);
    expect(queries.filter((sql: string) => sql.startsWith("SELECT layers"))).toHaveLength(2);
    const socket = await listen();
    expect(frames(socket)[0].terrain).toMatchObject({ w: 320 });
  });

  it("applies the saved maximum: a new playground admits no more, a lower one sends the extra out", async (): Promise<void> => {
    await setLayers({ ...ON, characters: { ...ON.characters, max: 5 } });
    const socket = await listen();
    advance(FRAME_MS);
    await deliver(Array.from({ length: 8 }, (_, i: number) => chat(`m${i}`, `u${i}`, "hello")));
    advance(FRAME_MS * 5);
    expect(roster(socket)).toHaveLength(5);
    await setLayers({ ...ON, characters: { ...ON.characters, max: 40 } });
    await post("playground-config");
    advance(FRAME_MS);
    expect(roster(socket)).toHaveLength(8);
    // Lower again while 8 stand: 3 walk to the exit door after the minimum time on screen.
    await setLayers({ ...ON, characters: { ...ON.characters, max: 5 } });
    await post("playground-config");
    advance(FRAME_MS);
    expect(roster(socket)).toHaveLength(8);
    for (let second = 0; second < 40; second++) {
      await deliver(Array.from({ length: 8 }, (_, i: number) => chat(`n${second}-${i}`, `u${i}`, "hello")));
      advance(1000);
    }
    // The one rotating slot can stand empty while its next character walks in.
    expect(roster(socket).length).toBeGreaterThanOrEqual(4);
    expect(roster(socket).length).toBeLessThanOrEqual(5);
  });

  it("keeps running on a failed layers read and logs a fixed event", async (): Promise<void> => {
    const socket = await listen();
    const error = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const faulty = faultyDatabase(database.db);
    faulty.fail(/SELECT layers/);
    env.DB = faulty.db;
    expect((await post("playground-config")).status).toBe(204);
    expect(error).toHaveBeenCalledWith("playground_config_failed", { cause: "Error" });
    expect(vi.getTimerCount()).toBe(1);
    advance(FRAME_MS);
    expect(frames(socket).at(-1)).toMatchObject({ full: false });
  });
});

describe("isolation", (): void => {
  it("keeps each page's playground to itself", async (): Promise<void> => {
    await setLayers(ON, otherPage);
    const mine = await listen();
    const theirs = await listen({ streamerId: otherPage });
    await deliver([chat("m1", "u1", "hello")]);
    await control({ op: "pause" }, otherPage);
    advance(FRAME_MS * 3);
    expect(roster(mine).map((entry) => entry.name)).toEqual(["User u1"]);
    expect(roster(theirs)).toEqual([]);
    expect(lastMode(mine)?.paused).toBe(false);
    expect(lastMode(theirs)?.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(state(otherPage).storage.values.get(PLAYGROUND_KEY)).not.toEqual(state().storage.values.get(PLAYGROUND_KEY));
  });
});

describe("PlaygroundHost", (): void => {
  /** A host on fake sockets, storage and clock. */
  function host(
    options: {
      put?: () => Promise<void>;
      remove?: () => Promise<boolean>;
      layers?: () => Promise<OverlayLayers>;
      /** The storage of an earlier host: this host is the object after an eviction. */
      values?: Map<string, unknown>;
    } = {},
  ) {
    let now = T0;
    let interval: (() => void) | null = null;
    const clock: PlaygroundClock = {
      now: (): number => now,
      setInterval: (callback: () => void): unknown => {
        interval = callback;
        return 1;
      },
      clearInterval: (): void => {
        interval = null;
      },
    };
    const values: Map<string, unknown> = options.values ?? new Map<string, unknown>();
    const sent: string[] = [];
    const socket = { readyState: 1, send: (message: string): void => void sent.push(message) } as unknown as WebSocket;
    const sockets: WebSocket[] = [];
    const playground = new PlaygroundHost({
      storage: {
        get: (key: string): Promise<unknown> => Promise.resolve(values.get(key)),
        put:
          options.put ?? ((key: string, value: unknown): Promise<void> => Promise.resolve(void values.set(key, value))),
        delete: options.remove ?? ((key: string): Promise<boolean> => Promise.resolve(values.delete(key))),
      } as unknown as DurableObjectStorage,
      sockets: (): WebSocket[] => sockets,
      readLayers: options.layers ?? ((): Promise<OverlayLayers> => Promise.resolve(ON)),
      schedule: (): Promise<void> => Promise.resolve(undefined),
      clock,
      seed: (): number => 7,
    });
    return {
      playground,
      sent,
      values,
      async open(): Promise<void> {
        sockets.push(socket);
        await playground.open(socket);
      },
      /** A characters socket that stayed open across an eviction: the host did not see it open. */
      attach(): void {
        sockets.push(socket);
      },
      close(): void {
        sockets.length = 0;
      },
      step(ms: number): void {
        now += ms;
        interval?.();
      },
      get running(): boolean {
        return interval !== null;
      },
      /** The state of each character in the newest frame, by name. Each frame must agree with the contract. */
      states(): Record<string, string> {
        const names = new Map<number, string>();
        let states: [string, string][] = [];
        for (const raw of sent) {
          const frame = parseActivityMessage(raw);
          if (frame?.type !== "playground") throw new Error("not a playground frame");
          for (const entry of frame.roster ?? []) names.set(entry.id, entry.name);
          states = frame.chars.map((char): [string, string] => [names.get(char[0]) ?? "", CHAR_STATES[char[3]]]);
        }
        return Object.fromEntries(states);
      },
    };
  }

  /** A running host with one character for each user id: `k…` on Kick and the others on Twitch. */
  async function crowded(users: string[], options: Parameters<typeof host>[0] = {}): Promise<ReturnType<typeof host>> {
    const fake = host(options);
    await fake.open();
    for (const [i, userId] of users.entries()) {
      const event: ActivityChat = chat(`m${i}`, userId, "hello");
      fake.playground.receive(userId.startsWith("k") ? { ...event, platform: "kick", id: `kick:m${i}` } : event);
    }
    fake.step(FRAME_MS);
    return fake;
  }

  const walks = (users: string[]): Record<string, string> =>
    Object.fromEntries(users.map((userId: string): [string, string] => [`User ${userId}`, "walk"]));

  it("makes the character of a viewer do the action, without a command bubble", async (): Promise<void> => {
    const fake = await crowded(["u1", "u2", "u3"]);
    expect(fake.states()).toEqual(walks(["u1", "u2", "u3"]));
    expect(fake.playground.react({ platform: "twitch", userId: "u1" }, "wave")).toBe(1);
    fake.step(FRAME_MS);
    expect(fake.states()).toEqual({ ...walks(["u2", "u3"]), "User u1": "wave" });
    expect(fake.playground.react({ platform: "twitch", userId: "u2" }, "jump")).toBe(1);
    fake.step(FRAME_MS);
    expect(fake.states()).toEqual({ "User u1": "wave", "User u2": "jump", "User u3": "walk" });
    // The frames have the bubbles of the messages only, and never the platform user id of the viewer.
    expect(fake.sent.join("")).not.toMatch(/!wave|!jump|"u1"|"u2"/);
  });

  it("makes each standing character cheer for an alert without a character", async (): Promise<void> => {
    const subjects: (ReactionSubject | null)[] = [null, { platform: "kick", userId: "nobody" }];
    for (const subject of subjects) {
      const fake = await crowded(["u1", "u2", "k3"]);
      // The first has its own reaction: it stands, so it cheers after its wave.
      expect(fake.playground.react({ platform: "twitch", userId: "u1" }, "wave")).toBe(1);
      fake.step(FRAME_MS);
      expect(fake.playground.react(subject, "jump")).toBe(3);
      fake.step(FRAME_MS);
      expect(fake.states()).toEqual({ "User u1": "wave", "User u2": "cheer", "User k3": "cheer" });
      for (let i = 0; i < 30 && fake.states()["User u1"] === "wave"; i++) fake.step(FRAME_MS);
      expect(fake.states()["User u1"]).toBe("cheer");
      expect(fake.sent.join("")).not.toContain("!");
    }
  });

  it("leaves one platform out of the crowd", async (): Promise<void> => {
    const fake = await crowded(["u1", "k2", "u3", "k4"]);
    expect(fake.playground.react(null, "cheer", "twitch")).toBe(2);
    fake.step(FRAME_MS);
    expect(fake.states()).toEqual({ ...walks(["u1", "u3"]), "User k2": "cheer", "User k4": "cheer" });
  });

  it("reacts to nothing in registry mode, and keeps no reaction for later", async (): Promise<void> => {
    const idle = host();
    // Nobody spoke yet: there is no playground.
    expect(idle.playground.react(null, "cheer")).toBe(0);
    const fake = await crowded(["u1", "u2"]);
    // The last characters socket is gone: the reaction stops the playground and does nothing.
    fake.close();
    expect(fake.playground.react({ platform: "twitch", userId: "u1" }, "wave")).toBe(0);
    expect(fake.running).toBe(false);
    expect(fake.playground.react(null, "cheer")).toBe(0);
    const count: number = fake.sent.length;
    fake.step(FRAME_MS);
    expect(fake.sent).toHaveLength(count);
    await fake.open();
    for (let i = 0; i < 12; i++) {
      fake.step(FRAME_MS);
      expect(fake.states()).toEqual(walks(["u1", "u2"]));
    }
    const pause = new Request("https://ingest.test/playground", { method: "POST", body: '{"op":"pause"}' });
    expect((await fake.playground.request("/playground", pause)).status).toBe(200);
    expect(fake.playground.react(null, "cheer")).toBe(0);
    expect(fake.running).toBe(false);
  });

  it("keeps a reaction out of the checkpoint, and runs one right after an eviction", async (): Promise<void> => {
    const first = await crowded(["u1", "u2"]);
    expect(first.playground.react(null, "cheer")).toBe(2);
    // The playground stops with the two reactions queued, and saves.
    first.close();
    first.step(FRAME_MS);
    await new Promise((resolve) => setImmediate(resolve));
    expect((first.values.get(PLAYGROUND_KEY) as { sim: string }).sim).not.toMatch(/reaction|cheer/);
    const second = host({ values: first.values });
    await second.playground.load();
    second.attach();
    // An alert wakes the object: the playground starts again for the socket that stayed open, and reacts.
    expect(second.running).toBe(false);
    expect(second.playground.react({ platform: "twitch", userId: "u2" }, "wave")).toBe(1);
    expect(second.running).toBe(true);
    await second.open();
    // The clock of this host starts 200 ms before the time of the checkpoint.
    second.step(FRAME_MS * 3);
    // Only the new reaction plays: the queued cheers of before the eviction are gone.
    expect(second.states()).toEqual({ "User u1": "walk", "User u2": "wave" });
  });

  it("gives the same frames for the same seed, messages and reactions", async (): Promise<void> => {
    const run = async (reactions: boolean): Promise<string[]> => {
      const fake = await crowded(["u1", "u2", "k3", "k4"]);
      for (let i = 0; i < 60; i++) {
        if (reactions && i === 5) fake.playground.react({ platform: "twitch", userId: "u1" }, "jump");
        if (reactions && i === 20) fake.playground.react(null, "cheer", "twitch");
        if (reactions && i === 40) fake.playground.react({ platform: "kick", userId: "nobody" }, "wave");
        fake.step(FRAME_MS);
      }
      return fake.sent;
    };
    const first: string[] = await run(true);
    expect(first).toHaveLength(62);
    expect(await run(true)).toEqual(first);
    // The reactions are in the frames: without them the playground goes another way.
    const plain: string[] = await run(false);
    expect(plain).toHaveLength(first.length);
    expect(plain.join("") === first.join("")).toBe(false);
  });

  it("reads the saved layers of a page, and the defaults without a page or an overlay row", async (): Promise<void> => {
    expect(await readLayers(env.DB, undefined)).toEqual(DEFAULT_LAYERS);
    expect(await readLayers(env.DB, "60000000-0000-4000-8000-00000000ffff")).toEqual(DEFAULT_LAYERS);
    expect(await readLayers(env.DB, page)).toEqual(ON);
  });

  it("runs at most MAX_STEP_TICKS after a stall and does not make the rest up", async (): Promise<void> => {
    const fake = host();
    await fake.open();
    fake.step(5_000);
    fake.step(FRAME_MS);
    const ticks = fake.sent.map((raw: string) => (JSON.parse(raw) as { tick: number }).tick);
    expect(ticks).toEqual([0, 10, 13]);
  });

  it("logs a failed checkpoint write and tries again later", async (): Promise<void> => {
    const error = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const fake = host({ put: async (): Promise<void> => Promise.reject(new TypeError("storage detail")) });
    await fake.open();
    fake.step(CHECKPOINT_MS);
    await new Promise((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalledWith("playground_checkpoint_failed", { cause: "TypeError" });
    expect(fake.playground.wakeAt()).toBe(T0 + CHECKPOINT_MS + WATCHDOG_MS);
  });

  it("stops and logs when a tick fails", async (): Promise<void> => {
    const error = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const fake = host();
    await fake.open();
    vi.spyOn(JSON, "stringify").mockImplementationOnce((): never => {
      throw new RangeError("frame detail");
    });
    fake.step(FRAME_MS);
    expect(error).toHaveBeenCalledWith("playground_tick_failed", { cause: "RangeError" });
    expect(fake.running).toBe(false);
  });

  it("logs a full frame that breaks the contract and sends it at the next frame", async (): Promise<void> => {
    const error = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    vi.spyOn(JSON, "stringify").mockImplementationOnce((): never => {
      throw new RangeError("frame detail");
    });
    const fake = host();
    await fake.open();
    expect(error).toHaveBeenCalledWith("playground_frame_invalid", { cause: "RangeError" });
    expect(fake.sent).toEqual([]);
    fake.step(FRAME_MS);
    expect(fake.sent.map((raw: string) => (JSON.parse(raw) as { full: boolean }).full)).toEqual([true, false]);
  });

  it("starts nothing when the first layers read fails", async (): Promise<void> => {
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const fake = host({ layers: async (): Promise<OverlayLayers> => Promise.reject(new Error("D1")) });
    await fake.open();
    expect(fake.running).toBe(false);
    expect(fake.sent).toEqual([]);
    const pause = new Request("https://ingest.test/playground", { method: "POST", body: '{"op":"pause"}' });
    await expect(fake.playground.request("/playground", pause)).rejects.toThrow("playground not created");
    expect(fake.playground.wakeAt()).toBeNull();
  });

  it("logs a failed delete of a malformed checkpoint without failing, and tries again by the alarm", async (): Promise<void> => {
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const error = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const fake = host({ remove: async (): Promise<boolean> => Promise.reject(new TypeError("storage detail")) });
    fake.values.set(PLAYGROUND_KEY, "{");
    await expect(fake.playground.load()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("playground_checkpoint_delete_failed", { cause: "TypeError" });
    expect(fake.playground.wakeAt()).toBe(T0 + CHECKPOINT_MS);
    await fake.playground.alarm();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("reads the layers again for a test control, also while a read runs", async (): Promise<void> => {
    const pending: ((layers: OverlayLayers) => void)[] = [];
    const layers = vi.fn(
      (): Promise<OverlayLayers> =>
        new Promise((resolve: (layers: OverlayLayers) => void): void => void pending.push(resolve)),
    );
    const fake = host({ layers });
    const opening: Promise<void> = fake.open();
    const test = new Request("https://ingest.test/playground", { method: "POST", body: '{"op":"test"}' });
    const testing: Promise<Response> = fake.playground.request("/playground", test);
    await new Promise((resolve) => setImmediate(resolve));
    pending[0](ON);
    await new Promise((resolve) => setImmediate(resolve));
    expect(layers).toHaveBeenCalledTimes(2);
    pending[1](DEFAULT_LAYERS);
    await opening;
    // The second read found the layer off: no test starts.
    expect(await (await testing).json()).toEqual({ paused: false, testEndsAt: null });
    expect(fake.running).toBe(false);
  });

  it("ignores status events and asks for no alarm while nothing changed", async (): Promise<void> => {
    const fake = host();
    fake.playground.receive({ kind: "status", platform: "twitch", status: "active" });
    expect(fake.playground.wakeAt()).toBeNull();
    await fake.playground.alarm();
    expect(fake.values.size).toBe(0);
  });
});
