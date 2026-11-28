import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import { parseActivityMessage, type ActivitySupport } from "../app/lib/activity";
import { ALERT_SHOW_MS, DEFAULT_RULES, type AlertView, type AlertsMessage } from "../app/lib/alerts";
import { GOAL_COUNTS, goalAmount } from "../app/lib/goals";
import { DEFAULT_LAYERS, emptyCells, storedLayersText, type OverlayLayers } from "../app/lib/overlay-layers";
import {
  alertCreditSchema,
  creditedTopic,
  featuredTopic,
  topicDeliveryId,
  topicSupport,
} from "../app/lib/topic-credit";
import { AlertHost } from "../app/server/alert-host";
import { ChannelIngest } from "../app/server/channel-ingest";
import { PlaygroundHost } from "../app/server/playground-host";
import { creditTopic } from "../app/server/topic-credit.server";
import { apiCaller } from "./helpers/api";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import { FakeSocket, installWorkersRuntime, RoomNamespace, RoomState, serverSocketOf } from "./helpers/room";

// The work that the API starts after its answer. The tests wait for it with `settle`.
const background = vi.hoisted((): { pending: Promise<unknown>[] } => ({ pending: [] }));
vi.mock("cloudflare:workers", async () => ({
  ...(await import("./helpers/room")),
  waitUntil: (promise: Promise<unknown>): void => {
    background.pending.push(promise);
  },
}));

/** The credit of a featured topic: from Live and the dock through the API to the alert host and the sockets. */

const T0 = 1_800_000_000_000;
const origin = "https://credit.example.test";
const secret = "test-only-secret-7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";
const page = "80000000-0000-4000-8000-000000000001";
const linked = "80000000-0000-4000-8000-000000000011";
const unlinked = "80000000-0000-4000-8000-000000000012";
const ownTopic = "80000000-0000-4000-8000-000000000013";
/** The Twitch user ID of the author of `linked`. No message, no log, and no storage of the object may have it. */
const TWITCH_ID = "418529637";

let database: TestDatabase;
let env: AppEnv;
let ingest: RoomNamespace<ChannelIngest>;
let ingestPaths: string[];

const { call } = apiCaller(() => env, origin, secret);

async function settle(): Promise<void> {
  while (background.pending.length > 0) await Promise.all(background.pending.splice(0));
}

function cell(c: number, r: number, w: number, h: number): { c: number; r: number; w: number; h: number } {
  return { c, r, w, h };
}

/** The topic layer and the alerts layer on the horizontal grid. The topic layer shows `ref` when it is on. */
function layers(alerts: boolean, topic: { ref: string | null; enabled: boolean }): OverlayLayers {
  return {
    ...DEFAULT_LAYERS,
    alerts: { enabled: alerts, rules: DEFAULT_RULES },
    items: { ...DEFAULT_LAYERS.items, topic: { ...DEFAULT_LAYERS.items.topic, ...topic } },
    cells: {
      horizontal: { ...emptyCells(), alerts: cell(0, 0, 16, 3), topic: cell(0, 6, 12, 4) },
      vertical: emptyCells(),
    },
  };
}

async function saveLayers(value: OverlayLayers): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO overlay_state (streamer_id,layers,revision,updated_at) VALUES (?,?,0,1)
      ON CONFLICT(streamer_id) DO UPDATE SET layers=excluded.layers`,
  )
    .bind(page, storedLayersText(value))
    .run();
  expect((await post("playground-config")).status).toBe(204);
}

function post(path: string, body?: unknown): Promise<Response> {
  return ingest.get(ingest.idFromName(page)).fetch(`https://channel-ingest.internal/${path}?streamerId=${page}`, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function listen(output: "horizontal" | "owner" = "horizontal"): Promise<FakeSocket> {
  const headers: Record<string, string> = output === "owner" ? { "X-SB-Owner": "1" } : { "X-SB-Overlay": output };
  const response = await ingest
    .get(ingest.idFromName(page))
    .fetch(`https://channel-ingest.internal/subscribe?streamerId=${page}`, {
      headers: { Upgrade: "websocket", ...headers },
    });
  expect(response.status).toBe(101);
  return serverSocketOf(response.webSocket);
}

/** Feature a topic from Live (the session of the owner), as the button "Feature on stream" does. */
async function featureFromLive(ref: string): Promise<Response> {
  const response = await call("POST", "overlay", {
    user: "owner",
    body: { action: "layers", items: { topic: { ref, enabled: true } } },
  });
  await settle();
  return response;
}

async function dockKey(): Promise<string> {
  const response = await call("POST", "dock/key", { user: "owner", body: {} });
  expect(response.status).toBe(200);
  await settle();
  return new URL((await response.json<{ url: string }>()).url).searchParams.get("key") ?? "";
}

async function featureFromDock(ref: string, key: string): Promise<Response> {
  const response = await call("POST", "dock/credit_page/overlay", {
    body: { action: "layers", items: { topic: { ref, enabled: true } } },
    headers: { "X-SB-Dock-Key": key },
  });
  await settle();
  return response;
}

function supportEvents(socket: FakeSocket): ActivitySupport[] {
  return socket.ofType<{ event: ActivitySupport }>("event").map((message) => message.event);
}

function alertStates(socket: FakeSocket): Extract<AlertsMessage, { type: "alerts" }>[] {
  return socket.sent.flatMap((raw: string) => {
    const message = parseActivityMessage(raw);
    return message?.type === "alerts" ? [message] : [];
  });
}

function current(socket: FakeSocket): AlertView | null {
  return alertStates(socket).at(-1)?.current ?? null;
}

function supportRows(): string[] {
  return ingest
    .entry(page)
    .state.storage.sql.exec<{ id: string }>("SELECT id FROM support ORDER BY seq")
    .toArray()
    .map((row: { id: string }): string => row.id);
}

/** Each value that the object keeps: each row of each table, and each stored key. */
function everythingStored(): string {
  const storage = ingest.entry(page).state.storage;
  const tables = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray();
  const rows = tables.map(({ name }) => storage.sql.exec(`SELECT * FROM "${name}"`).toArray());
  return JSON.stringify([rows, [...storage.values.entries()]]);
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  installWorkersRuntime();
  background.pending = [];
  ingestPaths = [];
  const rooms = new RoomNamespace((state) => new ChannelIngest(state as unknown as DurableObjectState, env));
  ingest = rooms;
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    CHANNEL_INGEST: {
      idFromName: (name: string) => rooms.idFromName(name),
      get: (id: { name: string }) => ({
        fetch: (input: string, init?: RequestInit): Promise<Response> => {
          ingestPaths.push(new URL(input).pathname);
          return rooms.get(id).fetch(input, init);
        },
      }),
    } as unknown as DurableObjectNamespace,
    POLL_ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 })) }),
    } as unknown as DurableObjectNamespace,
    REQUEST_LIMITER: {} as RateLimit,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: secret,
  };
  const users = JSON.stringify(["owner", "viewer", "quiet"]);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
    env.DB.prepare(
      `INSERT INTO user (id,name,email,email_verified,created_at,updated_at)
        SELECT value, 'Name '||value, value||'@example.test', 1, ?1, ?1 FROM json_each(?2)`,
    ).bind(T0, users),
    env.DB.prepare(
      `INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at)
        SELECT 's-'||value, value||'-session-token', value, ?1, ?2, ?2 FROM json_each(?3)`,
    ).bind(T0 + 86_400_000, T0, users),
    // The author of `linked` signed in with Twitch, and also with Google. The author of `unlinked` did not.
    env.DB.prepare(
      `INSERT INTO account (id,account_id,provider_id,user_id,created_at,updated_at) VALUES
        ('acc-1',?1,'twitch','viewer',1,1), ('acc-2','google-sub','google','viewer',1,1),
        ('acc-3','google-quiet','google','quiet',1,1)`,
    ).bind(TWITCH_ID),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','credit_page','Credit')").bind(
      page,
    ),
    env.DB.prepare(
      `INSERT INTO entries (id,streamer_id,author_id,kind,title,options,created_at) VALUES
        (?1,?4,'viewer','topic','Which boss first?','[]',1), (?2,?4,'quiet','topic','Speedrun it','[]',2),
        (?3,?4,'owner','topic','My own idea','[]',3)`,
    ).bind(linked, unlinked, ownTopic, page),
  ]);
  await saveLayers(layers(true, { ref: null, enabled: false }));
});

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the feature of a topic", (): void => {
  const before: OverlayLayers = layers(true, { ref: null, enabled: false });

  it("is a topic that goes on stream, or comes on stream in place of a different one", (): void => {
    expect(featuredTopic(before, layers(true, { ref: linked, enabled: true }))).toBe(linked);
    const shown: OverlayLayers = layers(true, { ref: linked, enabled: true });
    expect(featuredTopic(shown, layers(true, { ref: unlinked, enabled: true }))).toBe(unlinked);
    // The topic was picked while the layer was off: it goes on stream now.
    expect(featuredTopic(layers(true, { ref: linked, enabled: false }), shown)).toBe(linked);
    // The layer gets a place on the grid with its topic.
    const placed: OverlayLayers = { ...shown, cells: { ...shown.cells, horizontal: { ...emptyCells() } } };
    expect(featuredTopic(placed, shown)).toBe(linked);
  });

  it("is nothing when the same topic stays on stream, the layer goes off stream, or it has no topic", (): void => {
    const shown: OverlayLayers = layers(true, { ref: linked, enabled: true });
    expect(featuredTopic(shown, shown)).toBeNull();
    expect(featuredTopic(shown, { ...shown, alerts: { ...shown.alerts, enabled: false } })).toBeNull();
    expect(featuredTopic(shown, layers(true, { ref: linked, enabled: false }))).toBeNull();
    expect(featuredTopic(before, layers(true, { ref: null, enabled: true }))).toBeNull();
    const nowhere: OverlayLayers = { ...shown, cells: { horizontal: emptyCells(), vertical: emptyCells() } };
    expect(featuredTopic(before, nowhere)).toBeNull();
  });
});

describe("the event of a topic credit", (): void => {
  it("is a live direct support event for the author, with the title of the topic", (): void => {
    const event: ActivitySupport = topicSupport(linked, 7, "Which boss first?", { id: "viewer", name: "Zoë" }, T0);
    expect(event).toEqual({
      kind: "topic",
      id: `direct:topic:${linked}:7`,
      platform: "direct",
      deliveryId: `topic:${linked}:7`,
      sender: { id: "viewer", displayName: "Zoë" },
      anonymous: false,
      amount: null,
      currency: null,
      text: "Which boss first?",
      receivedAt: T0,
      replay: false,
    });
    expect(topicDeliveryId(linked, 7)).toBe(event.deliveryId);
    expect(creditedTopic(event.id)).toBe(linked);
    expect(creditedTopic("twitch:g1")).toBeNull();
    expect(creditedTopic(`direct:topic:${linked}:x`)).toBeNull();
    // A long name and a long title are cut to the limits of a support event, never inside a character.
    const long: ActivitySupport = topicSupport(linked, 1, "😀".repeat(400), { id: "viewer", name: "n".repeat(150) }, T0);
    expect(long.sender?.displayName).toHaveLength(100);
    expect(long.text).toBe("😀".repeat(250));
  });

  it("counts for no goal", (): void => {
    const event: ActivitySupport = topicSupport(linked, 1, "Title", { id: "viewer", name: "Zoë" }, T0);
    for (const counts of GOAL_COUNTS) expect(goalAmount(counts, event)).toBe(0);
  });

  it("is the only event that the internal operation takes", (): void => {
    const event: ActivitySupport = topicSupport(linked, 1, "Title", { id: "viewer", name: "Zoë" }, T0);
    const subject = { platform: "twitch", userId: TWITCH_ID };
    expect(alertCreditSchema.safeParse({ op: "credit", event, subject }).success).toBe(true);
    expect(alertCreditSchema.safeParse({ op: "credit", event, subject: null }).success).toBe(true);
    const refused: unknown[] = [
      { op: "credit", event: { ...event, replay: true }, subject },
      { op: "credit", event: { ...event, kind: "tip", amount: 1, currency: "USD" }, subject },
      { op: "credit", event: { ...event, id: "direct:tip-1", deliveryId: "tip-1" }, subject },
      { op: "credit", event, subject, extra: 1 },
      { op: "credit", event },
      { op: "replay", id: "twitch:g1", subject: null },
      { op: "test" },
    ];
    for (const body of refused) expect(alertCreditSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });
});

describe("a topic credit", (): void => {
  it("plays for a topic that the owner features in Live, and the character of the Twitch author waves", async (): Promise<void> => {
    const react = vi.spyOn(PlaygroundHost.prototype, "react");
    const [wide, owner] = [await listen("horizontal"), await listen("owner")];
    const answer = await featureFromLive(linked);
    expect(answer.status).toBe(200);
    expect(ingestPaths).toContain("/alert-credit");
    const id = `direct:topic:${linked}:1`;
    for (const socket of [wide, owner]) {
      expect(supportEvents(socket)).toEqual([
        {
          kind: "topic",
          id,
          platform: "direct",
          deliveryId: `topic:${linked}:1`,
          sender: { id: "viewer", displayName: "Name viewer" },
          anonymous: false,
          amount: null,
          currency: null,
          text: "Which boss first?",
          receivedAt: T0,
          replay: false,
        },
      ]);
      expect(current(socket)).toEqual({
        id,
        origin: "live",
        kind: "topic",
        platform: "direct",
        name: "Name viewer",
        anonymous: false,
        amount: null,
        currency: null,
        text: "Which boss first?",
        banner: true,
        chat: true,
        startsAt: T0,
        endsAt: T0 + ALERT_SHOW_MS,
      });
    }
    expect(supportRows()).toEqual([id]);
    expect(react.mock.calls).toEqual([[{ platform: "twitch", userId: TWITCH_ID }, "wave", undefined]]);
    // The link of the author is in no message to a page and in no storage of the object.
    for (const socket of [wide, owner]) expect(socket.sent.join("\n")).not.toContain(TWITCH_ID);
    expect(everythingStored()).not.toContain(TWITCH_ID);
    // A new socket gets the credit in its snapshot, as a replay.
    const late = await listen("owner");
    const snapshot = late.ofType<{ events: ActivitySupport[] }>("snapshot")[0];
    expect(snapshot.events).toEqual([expect.objectContaining({ id, replay: true })]);
  });

  it("plays for a topic that the dock features", async (): Promise<void> => {
    const key: string = await dockKey();
    const react = vi.spyOn(PlaygroundHost.prototype, "react");
    const socket = await listen();
    expect((await featureFromDock(unlinked, key)).status).toBe(200);
    expect(supportEvents(socket).map((event) => event.id)).toEqual([`direct:topic:${unlinked}:1`]);
    expect(current(socket)).toMatchObject({ kind: "topic", name: "Name quiet", text: "Speedrun it" });
    // The author has no Twitch sign-in: the crowd gets the action.
    expect(react.mock.calls).toEqual([[null, "wave", undefined]]);
  });

  it("does not play again while the same topic stays on stream, and plays for a new feature", async (): Promise<void> => {
    const socket = await listen();
    await featureFromLive(linked);
    // "Feature on stream" again, and a change of an other layer: the topic stays on stream.
    await featureFromLive(linked);
    expect((await call("POST", "overlay", { user: "owner", body: { action: "showResults", on: true } })).status).toBe(
      200,
    );
    await settle();
    expect(supportEvents(socket)).toHaveLength(1);
    // Off stream, then on stream again: one more credit.
    const off = await call("POST", "overlay", {
      user: "owner",
      body: { action: "layers", items: { topic: { enabled: false } } },
    });
    expect(off.status).toBe(200);
    await settle();
    vi.setSystemTime(T0 + ALERT_SHOW_MS);
    await featureFromLive(linked);
    expect(supportEvents(socket).map((event) => event.id)).toEqual([
      `direct:topic:${linked}:1`,
      `direct:topic:${linked}:5`,
    ]);
    expect(current(socket)?.id).toBe(`direct:topic:${linked}:5`);
  });

  it("is not made while the alerts layer is off stream", async (): Promise<void> => {
    await saveLayers(layers(false, { ref: null, enabled: false }));
    const socket = await listen();
    expect((await featureFromLive(linked)).status).toBe(200);
    expect(ingestPaths).not.toContain("/alert-credit");
    expect(supportEvents(socket)).toEqual([]);
    expect(supportRows()).toEqual([]);
  });

  it("is made one time for one delivery ID", async (): Promise<void> => {
    const socket = await listen();
    const event: ActivitySupport = topicSupport(linked, 9, "Which boss first?", { id: "viewer", name: "Z" }, T0);
    for (let send = 0; send < 2; send += 1)
      expect((await post("alert-credit", { op: "credit", event, subject: null })).status).toBe(200);
    expect(supportEvents(socket)).toHaveLength(1);
    expect(alertStates(socket).filter((state) => state.current !== null)).toHaveLength(1);
    expect(supportRows()).toEqual([event.id]);
  });

  it("keeps the link of an alert that waits in memory only: a new instance of the object uses the crowd", async (): Promise<void> => {
    const react = vi.spyOn(PlaygroundHost.prototype, "react");
    const socket = await listen();
    // A test alert is on stream, so each credit waits in the line.
    expect((await call("POST", "overlay/alerts", { user: "owner", body: { op: "test" } })).status).toBe(200);
    await featureFromLive(linked);
    await featureFromLive(unlinked);
    await featureFromLive(linked);
    expect(alertStates(socket).at(-1)).toMatchObject({ waiting: 3 });
    // The line in storage has the credits, and not the link of their author.
    expect(everythingStored()).toContain(`direct:topic:${linked}:3`);
    expect(everythingStored()).not.toContain(TWITCH_ID);
    vi.setSystemTime(T0 + ALERT_SHOW_MS);
    await ingest.entry(page).room.alarm();
    expect(current(socket)?.id).toBe(`direct:topic:${linked}:1`);
    expect(react.mock.calls.at(-1)).toEqual([{ platform: "twitch", userId: TWITCH_ID }, "wave", undefined]);
    // A new instance has the line from storage, without the link.
    ingest.restart(page);
    const next = await listen();
    for (const step of [2, 3]) {
      vi.setSystemTime(T0 + step * ALERT_SHOW_MS);
      await ingest.entry(page).room.alarm();
    }
    expect(current(next)?.id).toBe(`direct:topic:${linked}:3`);
    expect(react.mock.calls.at(-1)).toEqual([null, "wave", undefined]);
  });

  it("forgets the link of a credit that a mute removes from the line", async (): Promise<void> => {
    const react = vi.spyOn(PlaygroundHost.prototype, "react");
    const socket = await listen();
    expect((await call("POST", "overlay/alerts", { user: "owner", body: { op: "test" } })).status).toBe(200);
    await featureFromLive(linked);
    expect(alertStates(socket).at(-1)).toMatchObject({ waiting: 1 });
    for (const on of [true, false])
      expect((await call("POST", "overlay/alerts", { user: "owner", body: { op: "mute", on } })).status).toBe(200);
    expect(alertStates(socket).at(-1)).toMatchObject({ muted: false, current: null, waiting: 0 });
    vi.setSystemTime(T0 + ALERT_SHOW_MS);
    await ingest.entry(page).room.alarm();
    // Nothing of the muted time plays, so the character of the author never reacts.
    expect(react.mock.calls).toEqual([[null, "jump", undefined]]);
  });

  it("answers 503 when the host has no copy of the layers and cannot read them", async (): Promise<void> => {
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const host = new AlertHost({
      sql: new RoomState({ toString: (): string => "unread" }).storage.sql as unknown as SqlStorage,
      sockets: (): WebSocket[] => [],
      readLayers: (): Promise<OverlayLayers> => Promise.reject(new TypeError("no database")),
      schedule: (): Promise<void> => Promise.resolve(),
      react: (): number => 0,
      support: (): null => null,
    });
    host.load();
    const ingested = vi.fn();
    const event: ActivitySupport = topicSupport(linked, 1, "Title", { id: "viewer", name: "Z" }, T0);
    const body: string = JSON.stringify({ op: "credit", event, subject: null });
    const request = new Request("https://channel-ingest.internal/alert-credit", { method: "POST", body });
    const answer: Response = await host.route("/alert-credit", request, ingested);
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({ error: "alerts_unavailable" });
    expect(ingested).not.toHaveBeenCalled();
  });

  it("replays with the link that the API reads again, and adds no row", async (): Promise<void> => {
    const react = vi.spyOn(PlaygroundHost.prototype, "react");
    const socket = await listen();
    await featureFromLive(linked);
    const id = `direct:topic:${linked}:1`;
    vi.setSystemTime(T0 + ALERT_SHOW_MS);
    await ingest.entry(page).room.alarm();
    const replay = await call("POST", "overlay/alerts", { user: "owner", body: { op: "replay", id } });
    expect(replay.status).toBe(200);
    expect((await replay.json<{ current: AlertView }>()).current).toMatchObject({ id: `${id}~r1`, origin: "replay" });
    expect(react.mock.calls.at(-1)).toEqual([{ platform: "twitch", userId: TWITCH_ID }, "wave", undefined]);
    expect(supportEvents(socket)).toHaveLength(1);
    expect(supportRows()).toEqual([id]);
    // The author removed the Twitch sign-in: the next replay uses the crowd.
    await env.DB.prepare("DELETE FROM account WHERE provider_id='twitch'").run();
    vi.setSystemTime(T0 + 2 * ALERT_SHOW_MS);
    const again = await call("POST", "overlay/alerts", { user: "owner", body: { op: "replay", id } });
    expect(again.status).toBe(200);
    expect(react.mock.calls.at(-1)).toEqual([null, "wave", undefined]);
    // A replay of a credit that the object does not keep is refused with its code.
    const gone = `direct:topic:${unlinked}:3`;
    const missing = await call("POST", "overlay/alerts", { user: "owner", body: { op: "replay", id: gone } });
    expect(missing.status).toBe(404);
    expect((await missing.json<{ code: string }>()).code).toBe("alert_gone");
    expect(socket.sent.join("\n")).not.toContain(TWITCH_ID);
  });

  it("is refused on the routes of the owner and of the dock, and on the object path of the controls", async (): Promise<void> => {
    const key: string = await dockKey();
    await listen();
    const event: ActivitySupport = topicSupport(linked, 1, "Title", { id: "viewer", name: "Z" }, T0);
    const body = { op: "credit", event, subject: { platform: "twitch", userId: TWITCH_ID } };
    expect((await call("POST", "overlay/alerts", { user: "owner", body })).status).toBe(400);
    const dock = await call("POST", "dock/credit_page/alerts", { body, headers: { "X-SB-Dock-Key": key } });
    expect(dock.status).toBe(400);
    expect((await post("alerts", body)).status).toBe(400);
    expect(ingestPaths).not.toContain("/alert-credit");
    // The object path of the credit takes only a credit.
    expect((await post("alert-credit", { op: "test" })).status).toBe(400);
    expect((await post("alert-credit", { op: "credit", event: { ...event, replay: true }, subject: null })).status).toBe(
      400,
    );
    expect(supportRows()).toEqual([]);
  });

  it("logs a failure with its class only, and never the topic, the author, or the link", async (): Promise<void> => {
    const error = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    // The object refuses: the read of the layers fails.
    const failing: AppEnv = {
      ...env,
      CHANNEL_INGEST: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 503 })) }),
      } as unknown as DurableObjectNamespace,
    };
    await creditTopic(failing, page, linked, 1);
    expect(error.mock.calls).toEqual([["topic_credit_failed", { status: 503 }]]);
    const broken: AppEnv = {
      ...env,
      CHANNEL_INGEST: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: (): Promise<Response> => Promise.reject(new TypeError("network")) }),
      } as unknown as DurableObjectNamespace,
    };
    await creditTopic(broken, page, linked, 1);
    expect(error.mock.calls[1]).toEqual(["topic_credit_failed", { cause: "transport_error" }]);
    const fail = (): never => {
      throw new Error("db");
    };
    const odd: AppEnv = { ...env, DB: { prepare: fail } as unknown as D1Database };
    await creditTopic(odd, page, linked, 1);
    expect(error.mock.calls[2]).toEqual(["topic_credit_failed", { cause: "unexpected_error" }]);
    // The owner deleted the topic before the credit.
    await creditTopic(env, page, "80000000-0000-4000-8000-000000000099", 1);
    expect(warn.mock.calls).toContainEqual(["topic_credit_skipped", { reason: "topic_gone" }]);
    const logged: string = JSON.stringify([error.mock.calls, warn.mock.calls]);
    for (const secretValue of [TWITCH_ID, linked, "Which boss first?", "Name viewer"])
      expect(logged).not.toContain(secretValue);
  });
});
