import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AppEnv } from "../app/env";
import {
  isSupport,
  parseActivityMessage,
  type ActivityEvent,
  type ActivityPlatform,
  type ActivitySupport,
} from "../app/lib/activity";
import { alertRefusal, alertsReplySchema, type AlertsReply } from "../app/lib/alert-control";
import { ALERT_SHOW_MS, DEFAULT_RULES, type AlertRules, type AlertView, type AlertsMessage } from "../app/lib/alerts";
import { DEFAULT_LAYERS, emptyCells, storedLayersText, type OverlayLayers } from "../app/lib/overlay-layers";
import { ALERT_LINE_MAX, AlertHost } from "../app/server/alert-host";
import { ChannelIngest } from "../app/server/channel-ingest";
import { SNAPSHOT_MAX_AGE_MS } from "../app/server/channel-ingest-limits";
import { LAYER_CHECK_MS, PlaygroundHost } from "../app/server/playground-host";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import {
  FakeSocket,
  faultyDatabase,
  installWorkersRuntime,
  RoomNamespace,
  RoomState,
  serverSocketOf,
} from "./helpers/room";

vi.mock("cloudflare:workers", () => import("./helpers/room"));

/** The alert host inside the page's ingest object: live alerts, the line, the controls, and what the sockets get. */

const T0 = 1_800_000_000_000;
const page = "70000000-0000-4000-8000-000000000001";

type StateMessage = Extract<AlertsMessage, { type: "alerts" }>;
type OneMessage = Extract<AlertsMessage, { type: "alert" }>;
type Output = "horizontal" | "vertical" | "dock" | "owner";

let database: TestDatabase;
let env: AppEnv;
let ingest: RoomNamespace<ChannelIngest>;
let deliveries = 0;

function url(path: string, query: Record<string, string> = {}): string {
  return `https://channel-ingest.internal/${path}?${new URLSearchParams({ streamerId: page, ...query })}`;
}

function post(path: string, body?: unknown, query: Record<string, string> = {}): Promise<Response> {
  return ingest.get(ingest.idFromName(page)).fetch(url(path, query), {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

const HEADERS: Readonly<Record<Output, Record<string, string>>> = {
  horizontal: { "X-SB-Overlay": "horizontal" },
  vertical: { "X-SB-Overlay": "vertical" },
  dock: { "X-SB-Dock": "1" },
  owner: { "X-SB-Owner": "1" },
};

async function listen(output: Output = "owner", characters = false): Promise<FakeSocket> {
  const response = await ingest
    .get(ingest.idFromName(page))
    .fetch(url("subscribe", characters ? { characters: "1" } : {}), {
      headers: { Upgrade: "websocket", ...HEADERS[output] },
    });
  expect(response.status).toBe(101);
  return serverSocketOf(response.webSocket);
}

function state(): RoomState {
  return ingest.entry(page).state;
}

function room(): ChannelIngest {
  return ingest.entry(page).room;
}

/** A support event as the Worker normalizes it. */
function support(
  kind: ActivitySupport["kind"],
  deliveryId: string,
  fields: Partial<ActivitySupport> = {},
): ActivitySupport {
  const platform = fields.platform ?? "twitch";
  return {
    kind,
    id: `${platform}:${deliveryId}`,
    platform,
    deliveryId,
    sender: { id: "viewer-id-1", displayName: "Supporter" },
    anonymous: false,
    amount: null,
    currency: null,
    receivedAt: Date.now(),
    replay: false,
    ...fields,
  };
}

function gift(deliveryId: string, fields: Partial<ActivitySupport> = {}): ActivitySupport {
  return support("gift", deliveryId, { amount: 5, ...fields });
}

/** One delivery of the Worker for the connected channel. */
async function deliver(events: ActivityEvent[], platform: ActivityPlatform = "twitch"): Promise<void> {
  deliveries += 1;
  const response = await post("event", { deliveryId: `d${deliveries}`, channelId: "111", events }, { platform });
  expect(response.status).toBe(204);
}

async function control(body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await post("alerts", body);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return { status: response.status, body: await response.json() };
}

/** A control that the host runs: its answer is the state. */
async function run(body: unknown): Promise<AlertsReply> {
  const answer = await control(body);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return alertsReplySchema.parse(answer.body);
}

/** A control that the host refuses: the status and the code of the refusal. */
async function refused(body: unknown): Promise<[number, string | null]> {
  const answer = await control(body);
  return [answer.status, alertRefusal(answer.body)];
}

/** The alert messages that a socket got, as the parser of a consumer reads them. */
function alertMessages(socket: FakeSocket): AlertsMessage[] {
  return socket.sent.flatMap((raw: string): AlertsMessage[] => {
    const message = parseActivityMessage(raw);
    return message?.type === "alerts" || message?.type === "alert" ? [message] : [];
  });
}

function states(socket: FakeSocket): StateMessage[] {
  return alertMessages(socket).filter((message: AlertsMessage): message is StateMessage => message.type === "alerts");
}

function ones(socket: FakeSocket): AlertView[] {
  return alertMessages(socket)
    .filter((message: AlertsMessage): message is OneMessage => message.type === "alert")
    .map((message: OneMessage): AlertView => message.alert);
}

function last(socket: FakeSocket): StateMessage {
  const message = states(socket).at(-1);
  if (!message) throw new Error("no alerts state");
  return message;
}

function supportRows(): string[] {
  return state()
    .storage.sql.exec<{ id: string }>("SELECT id FROM support ORDER BY seq")
    .toArray()
    .map((row: { id: string }): string => row.id);
}

function lineRows(): number {
  return state().storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM alert_line").toArray()[0].n;
}

async function setLayers(layers: OverlayLayers, notify = true): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO overlay_state (streamer_id,position,revision,updated_at,layers) VALUES (?,'lower',1,1,?)
      ON CONFLICT(streamer_id) DO UPDATE SET layers=excluded.layers`,
  )
    .bind(page, storedLayersText(layers))
    .run();
  if (notify) expect((await post("playground-config")).status).toBe(204);
}

function rules(changes: Partial<AlertRules>): AlertRules {
  return { ...DEFAULT_RULES, ...changes };
}

/** The alerts layer on stream in the two outputs. */
function layersOn(changes: Partial<AlertRules> = {}, more: Partial<OverlayLayers> = {}): OverlayLayers {
  return {
    ...DEFAULT_LAYERS,
    alerts: { enabled: true, rules: rules(changes) },
    cells: {
      horizontal: { ...emptyCells(), alerts: { c: 0, r: 0, w: 16, h: 3 } },
      vertical: { ...emptyCells(), alerts: { c: 0, r: 0, w: 16, h: 3 } },
    },
    ...more,
  };
}

/** Runs the object's alarm at its time, as the runtime does: the alarm is cleared first. */
async function fireAlarm(): Promise<void> {
  const at: number | null = state().storage.alarm;
  if (at === null) throw new Error("no alarm set");
  await state().storage.deleteAlarm();
  vi.setSystemTime(Math.max(Date.now(), at));
  await room().alarm();
}

/** A host without the object around it: the test gives the sockets, the layers, and the kept events. */
function standalone(layers: OverlayLayers = layersOn()): {
  host: AlertHost;
  socket: FakeSocket;
  sockets: FakeSocket[];
  react: Mock<PlaygroundHost["react"]>;
  schedule: Mock<(at: number) => Promise<void>>;
  kept: Map<string, ActivitySupport>;
  storage: RoomState["storage"];
  send: (body: unknown) => Promise<Response>;
  restart: () => AlertHost;
} {
  const storage = new RoomState({ toString: (): string => "standalone" }).storage;
  const socket = new FakeSocket();
  const sockets: FakeSocket[] = [socket];
  const react = vi.fn<PlaygroundHost["react"]>((): number => 1);
  const schedule = vi.fn<(at: number) => Promise<void>>((): Promise<void> => Promise.resolve());
  const kept = new Map<string, ActivitySupport>();
  const create = (): AlertHost => {
    const host = new AlertHost({
      sql: storage.sql as unknown as SqlStorage,
      sockets: (): WebSocket[] => sockets.filter((item: FakeSocket): boolean => item.open) as unknown as WebSocket[],
      readLayers: (): Promise<OverlayLayers> => Promise.resolve(layers),
      schedule,
      react,
      support: (id: string): ActivitySupport | null => kept.get(id) ?? null,
    });
    host.load();
    return host;
  };
  const host = create();
  const send = (body: unknown): Promise<Response> =>
    host.request(new Request("https://channel-ingest.internal/alerts", { method: "POST", body: JSON.stringify(body) }));
  return { host, socket, sockets, react, schedule, kept, storage, send, restart: create };
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: T0 });
  installWorkersRuntime();
  deliveries = 0;
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    POLL_ROOMS: {} as DurableObjectNamespace,
    CHANNEL_INGEST: {} as DurableObjectNamespace,
    REQUEST_LIMITER: {} as RateLimit,
    APP_ORIGIN: "https://alerts.example.test",
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
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','host_page','Host')").bind(page),
    env.DB.prepare(
      `INSERT INTO channel_connections
        (id,streamer_id,platform,external_id,display_name,scopes,status,created_at,updated_at,support_events)
        VALUES ('conn-t',?1,'twitch','111','Host','','active',1,1,1), ('conn-k',?1,'kick','111','Host','','active',1,1,1)`,
    ).bind(page),
  ]);
  await setLayers(layersOn());
});

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a live alert", (): void => {
  it("reaches the horizontal and the vertical output, the owner, and the dock, after its event", async (): Promise<void> => {
    const sockets = [await listen("horizontal"), await listen("vertical"), await listen("owner"), await listen("dock")];
    for (const socket of sockets) {
      expect(socket.messages<{ type: string }>().map((message) => message.type)).toEqual(["snapshot", "alerts"]);
      expect(last(socket)).toEqual({ type: "alerts", at: T0, muted: false, current: null, waiting: 0, goal: null });
    }
    await deliver([gift("g1")]);
    const view: AlertView = {
      id: "twitch:g1",
      origin: "live",
      kind: "gift",
      platform: "twitch",
      name: "Supporter",
      anonymous: false,
      amount: 5,
      currency: null,
      banner: true,
      chat: true,
      startsAt: T0,
      endsAt: T0 + ALERT_SHOW_MS,
    };
    for (const socket of sockets) {
      // The row of the event comes first, then the alert.
      expect(socket.messages<{ type: string }>().map((message) => message.type)).toEqual([
        "snapshot",
        "alerts",
        "event",
        "alerts",
      ]);
      expect(last(socket)).toEqual({ type: "alerts", at: T0, muted: false, current: view, waiting: 0, goal: null });
    }
    // The alarm ends the alert on time.
    expect(state().storage.alarm).toBe(T0 + ALERT_SHOW_MS);
    await fireAlarm();
    for (const socket of sockets)
      expect(last(socket)).toMatchObject({ at: T0 + ALERT_SHOW_MS, current: null, waiting: 0 });
    expect(state().storage.alarm).not.toBe(T0 + ALERT_SHOW_MS);
  });

  it("shows one alert at one time: the others wait, and the alarm starts the next one", async (): Promise<void> => {
    const socket = await listen("horizontal");
    await deliver([gift("g1"), gift("g2"), gift("g3")]);
    expect(states(socket).map((message) => [message.current?.id, message.waiting])).toEqual([
      [undefined, 0],
      ["twitch:g1", 0],
      ["twitch:g1", 1],
      ["twitch:g1", 2],
    ]);
    expect(lineRows()).toBe(2);
    // An alarm before the end changes nothing, and the object sets the alarm for the end again.
    vi.setSystemTime(T0 + 1000);
    await state().storage.deleteAlarm();
    await room().alarm();
    expect(states(socket)).toHaveLength(4);
    expect(state().storage.alarm).toBe(T0 + ALERT_SHOW_MS);
    await fireAlarm();
    expect(last(socket)).toMatchObject({ waiting: 1, current: { id: "twitch:g2", startsAt: T0 + ALERT_SHOW_MS } });
    expect(last(socket).current?.endsAt).toBe(T0 + 2 * ALERT_SHOW_MS);
    expect(lineRows()).toBe(1);
    await fireAlarm();
    expect(last(socket)).toMatchObject({ waiting: 0, current: { id: "twitch:g3" } });
    await fireAlarm();
    expect(last(socket)).toMatchObject({ waiting: 0, current: null });
    expect(lineRows()).toBe(0);
  });

  it("gives a socket that opens later the alert on stream with its end time", async (): Promise<void> => {
    await listen("horizontal");
    await deliver([gift("g1"), gift("g2")]);
    vi.setSystemTime(T0 + 2500);
    const late = await listen("vertical");
    expect(last(late)).toMatchObject({ at: T0 + 2500, waiting: 1, current: { id: "twitch:g1", endsAt: T0 + 6000 } });
    // An alarm that is late never keeps an alert on stream: after the end time the state has none.
    vi.setSystemTime(T0 + ALERT_SHOW_MS);
    expect(last(await listen("owner"))).toMatchObject({ current: null, waiting: 1 });
    expect((await run({ op: "status" })).current).toBeNull();
  });

  it("applies the amount of each rule, end to end", async (): Promise<void> => {
    await setLayers(layersOn({ gift: { ...DEFAULT_RULES.gift, min: 10 } }));
    const socket = await listen();
    const started = (): (string | undefined)[] => states(socket).map((message) => message.current?.id);
    await deliver([
      support("bits", "b99", { amount: 99 }),
      support("raid", "r4", { amount: 4 }),
      support("gift", "g9", { amount: 9 }),
    ]);
    await deliver([support("kicks", "k99", { amount: 99, platform: "kick" })], "kick");
    expect(started()).toEqual([undefined]);
    await deliver([support("bits", "b100", { amount: 100 })]);
    expect(started().at(-1)).toBe("twitch:b100");
    await deliver([support("raid", "r5", { amount: 5 }), support("gift", "g10", { amount: 10 })]);
    await deliver([support("kicks", "k100", { amount: 100, platform: "kick" })], "kick");
    expect(last(socket).waiting).toBe(3);
    // A rule without an amount starts for each event.
    await deliver([support("subscription", "s1", { amount: 1 })]);
    expect(last(socket).waiting).toBe(4);
    // Each event has its row, also when it makes no alert.
    expect(supportRows()).toHaveLength(9);
  });

  it("plays an alert without a banner at once, and never puts it in the line", async (): Promise<void> => {
    const [wide, tall] = [await listen("horizontal"), await listen("vertical")];
    await deliver([gift("g1"), support("follow", "f1"), support("follow", "f2")]);
    for (const socket of [wide, tall]) {
      expect(ones(socket)).toEqual([
        expect.objectContaining({
          id: "twitch:f1",
          kind: "follow",
          banner: false,
          chat: true,
          startsAt: T0,
          endsAt: T0,
        }),
        expect.objectContaining({ id: "twitch:f2" }),
      ]);
      // The follows did not change the line.
      expect(last(socket)).toMatchObject({ current: { id: "twitch:g1" }, waiting: 0 });
      expect(states(socket)).toHaveLength(2);
    }
  });

  it("does nothing for a rule that has each switch off, and sends no message for a character only", async (): Promise<void> => {
    const react = vi.spyOn(PlaygroundHost.prototype, "react");
    await setLayers(
      layersOn({
        follow: { min: 1, banner: false, chat: false, character: false },
        gift: { min: 1, banner: false, chat: false, character: true },
      }),
    );
    const socket = await listen();
    await deliver([support("follow", "f1"), gift("g1")]);
    expect(alertMessages(socket)).toHaveLength(1);
    // The character of the supporter still reacts.
    expect(react.mock.calls).toEqual([[{ platform: "twitch", userId: "viewer-id-1" }, "jump", undefined]]);
  });

  it("never plays without a page, off stream, or for an event that is not live", async (): Promise<void> => {
    // No socket is open.
    await deliver([gift("g0")]);
    const socket = await listen();
    expect(last(socket)).toMatchObject({ current: null, waiting: 0 });
    // A provider sends an old event again: it has its row, and it plays no alert.
    await deliver([gift("g1", { sentAt: T0 - 31_000 })]);
    expect(states(socket)).toHaveLength(1);
    await deliver([gift("g2", { sentAt: T0 - 30_000 })]);
    expect(last(socket).current?.id).toBe("twitch:g2");
    // A socket that closed is not a page.
    socket.close();
    await deliver([gift("g3")]);
    expect(lineRows()).toBe(0);
    // The alerts layer off stream: off, or with no place in an output.
    const next = await listen();
    for (const layers of [
      layersOn({}, { alerts: { enabled: false, rules: rules({}) } }),
      layersOn({}, { cells: { horizontal: emptyCells(), vertical: emptyCells() } }),
      DEFAULT_LAYERS,
    ]) {
      await setLayers(layers);
      await deliver([gift(`off-${deliveries}`)]);
      expect(last(next)).toMatchObject({ current: null, waiting: 0 });
    }
    expect(supportRows()).toHaveLength(7);
    // On stream in one output is on stream.
    await setLayers(layersOn({}, { cells: { horizontal: emptyCells(), vertical: layersOn().cells.vertical } }));
    await deliver([gift("g4")]);
    expect(last(next).current?.id).toBe("twitch:g4");
  });

  it("never puts the message of the supporter in an alert", async (): Promise<void> => {
    const socket = await listen();
    await deliver([support("bits", "b1", { amount: 500, text: "read this on stream" })]);
    expect(last(socket).current).toMatchObject({ id: "twitch:b1", name: "Supporter", amount: 500 });
    expect(last(socket).current).not.toHaveProperty("text");
    expect(JSON.stringify(alertMessages(socket))).not.toContain("read this");
    expect(JSON.stringify(await run({ op: "replay", id: "twitch:b1" }))).not.toContain("read this");
    // The row of the event keeps the message, for chat and the activity list.
    expect(socket.ofType<{ event: ActivitySupport }>("event")[0].event.text).toBe("read this on stream");
    // The sample text of a test stays out too. The text of a topic credit is the title of the topic: it stays.
    await run({ op: "skip" });
    await run({ op: "skip" });
    const tested = await run({ op: "test", kind: "bits" });
    expect(tested.current).toMatchObject({ origin: "test", kind: "bits", amount: 500 });
    expect(tested.current).not.toHaveProperty("text");
    await run({ op: "skip" });
    expect((await run({ op: "test", kind: "topic" })).current).toMatchObject({
      kind: "topic",
      text: "Which boss first?",
    });
  });

  it("holds at most ALERT_LINE_MAX alerts that wait, and drops the next one", async (): Promise<void> => {
    expect(ALERT_LINE_MAX).toBe(SNAPSHOT_MAX_AGE_MS / ALERT_SHOW_MS);
    const socket = await listen();
    for (const batch of [0, 1])
      await deliver(Array.from({ length: 50 }, (_, index): ActivitySupport => gift(`a${batch}-${index}`)));
    expect(last(socket).waiting).toBe(99);
    // The support bucket fills again with time.
    vi.setSystemTime(T0 + 1000);
    await deliver([gift("b1"), gift("b2"), gift("b3")]);
    expect(last(socket)).toMatchObject({ waiting: ALERT_LINE_MAX, current: { id: "twitch:a0-0" } });
    expect(lineRows()).toBe(ALERT_LINE_MAX);
    expect(await refused({ op: "test" })).toEqual([409, "alerts_full"]);
    // A test that the line refuses uses no play number.
    await run({ op: "skip" });
    expect((await run({ op: "test", kind: "follow" })).waiting).toBe(ALERT_LINE_MAX - 1);
    expect(ones(socket).map((view) => view.id)).toEqual(["twitch:test-1"]);
  });
});

describe("the reaction of the characters", (): void => {
  it("moves the character of the supporter, or the crowd", async (): Promise<void> => {
    const { host, react } = standalone();
    await host.layersChanged();
    host.receive(gift("g1"));
    host.receive(support("follow", "f1"));
    host.receive(support("raid", "r1", { amount: 50 }));
    host.receive(gift("g2", { anonymous: true, sender: null }));
    // The raid and the anonymous gift wait in the line: their characters react when they start.
    expect(react.mock.calls).toEqual([
      [{ platform: "twitch", userId: "viewer-id-1" }, "jump", undefined],
      [{ platform: "twitch", userId: "viewer-id-1" }, "wave", undefined],
    ]);
    vi.setSystemTime(T0 + ALERT_SHOW_MS);
    await host.alarm();
    // A raid is for the crowd, which always cheers.
    expect(react.mock.calls[2]).toEqual([null, "cheer", undefined]);
    vi.setSystemTime(T0 + 2 * ALERT_SHOW_MS);
    await host.alarm();
    // An anonymous supporter has no character: the crowd gets the action.
    expect(react.mock.calls[3]).toEqual([null, "jump", undefined]);
  });

  it("leaves the Twitch characters out when an output shows only Twitch and the event is from elsewhere", async (): Promise<void> => {
    const { host, react, send } = standalone(layersOn({}, { twitchOnly: { horizontal: false, vertical: true } }));
    await host.layersChanged();
    host.receive(support("follow", "f1", { platform: "kick" }));
    host.receive(support("follow", "f2"));
    expect(react.mock.calls).toEqual([
      [{ platform: "kick", userId: "viewer-id-1" }, "wave", "twitch"],
      [{ platform: "twitch", userId: "viewer-id-1" }, "wave", undefined],
    ]);
    // A test has no viewer. A topic credit shows in each output, so each character can react.
    react.mockClear();
    expect((await send({ op: "test", kind: "super_chat" })).status).toBe(200);
    expect((await send({ op: "skip" })).status).toBe(200);
    expect((await send({ op: "test", kind: "topic" })).status).toBe(200);
    expect(react.mock.calls).toEqual([
      [null, "jump", "twitch"],
      [null, "wave", undefined],
    ]);
  });

  it("sets the alarm of the object to the end of an alert that a control starts", async (): Promise<void> => {
    const { host, schedule, send } = standalone();
    await host.layersChanged();
    expect((await send({ op: "status" })).status).toBe(200);
    expect(schedule).not.toHaveBeenCalled();
    expect((await send({ op: "test" })).status).toBe(200);
    expect(schedule.mock.calls).toEqual([[T0 + ALERT_SHOW_MS]]);
    vi.setSystemTime(T0 + 1000);
    expect((await send({ op: "test" })).status).toBe(200);
    expect((await send({ op: "skip" })).status).toBe(200);
    expect(schedule.mock.calls.at(-1)).toEqual([T0 + 1000 + ALERT_SHOW_MS]);
  });

  it("does not move a character when the rule has the character switch off", async (): Promise<void> => {
    const { host, react, socket } = standalone(layersOn({ gift: { ...DEFAULT_RULES.gift, character: false } }));
    await host.layersChanged();
    host.receive(gift("g1"));
    expect(react).not.toHaveBeenCalled();
    expect(last(socket).current?.id).toBe("twitch:g1");
  });

  it("reaches the playground of the object", async (): Promise<void> => {
    const react = vi.spyOn(PlaygroundHost.prototype, "react");
    await listen();
    await deliver([gift("g1")]);
    expect(react.mock.calls).toEqual([[{ platform: "twitch", userId: "viewer-id-1" }, "jump", undefined]]);
  });
});

describe("mute", (): void => {
  it("stops the alert on stream at once, discards the line, and lets nothing of the muted time play", async (): Promise<void> => {
    const [wide, tall] = [await listen("horizontal"), await listen("vertical")];
    await deliver([gift("g1"), gift("g2"), gift("g3")]);
    expect(last(wide)).toMatchObject({ current: { id: "twitch:g1" }, waiting: 2 });
    const muted = await run({ op: "mute", on: true });
    expect(muted).toEqual({ at: T0, muted: true, current: null, waiting: 0, goal: null });
    for (const socket of [wide, tall]) expect(last(socket)).toEqual({ type: "alerts", ...muted });
    expect(lineRows()).toBe(0);
    // A second mute changes nothing and sends nothing.
    const sent: number = wide.sent.length;
    expect(await run({ op: "mute", on: true })).toEqual(muted);
    expect(wide.sent).toHaveLength(sent);
    // New events have their rows and make no alert in an output: no banner, and no mark in chat.
    await deliver([gift("g4"), support("follow", "f1"), support("raid", "r1", { amount: 90 })]);
    for (const socket of [wide, tall]) {
      expect(socket.ofType("event")).toHaveLength(6);
      expect(alertMessages(socket).slice(-1)).toEqual([{ type: "alerts", ...muted }]);
      expect(ones(socket)).toEqual([]);
    }
    // The alarm of the alert that the mute stopped starts nothing.
    await fireAlarm();
    expect(last(wide)).toEqual({ type: "alerts", ...muted });
    // A test and a replay are refused with a clear reason.
    expect(await refused({ op: "test" })).toEqual([409, "alerts_muted"]);
    expect(await refused({ op: "replay", id: "twitch:g4" })).toEqual([409, "alerts_muted"]);
    // Skip has nothing to end.
    expect(await run({ op: "skip" })).toMatchObject({ muted: true, current: null });
    // Mute off: nothing from the muted time plays, and the next event does.
    vi.setSystemTime(T0 + 20_000);
    const open = await run({ op: "mute", on: false });
    expect(open).toEqual({ at: T0 + 20_000, muted: false, current: null, waiting: 0, goal: null });
    for (const socket of [wide, tall]) expect(last(socket)).toEqual({ type: "alerts", ...open });
    await deliver([gift("g5")]);
    for (const socket of [wide, tall])
      expect(last(socket)).toMatchObject({ muted: false, current: { id: "twitch:g5" }, waiting: 0 });
  });

  it("survives a new instance of the object", async (): Promise<void> => {
    await listen("horizontal");
    await run({ op: "mute", on: true });
    ingest.restart(page);
    const [wide, tall] = [await listen("horizontal"), await listen("vertical")];
    for (const socket of [wide, tall]) expect(last(socket)).toMatchObject({ muted: true, current: null });
    await deliver([gift("g1"), support("follow", "f1")]);
    for (const socket of [wide, tall]) {
      expect(socket.ofType("event")).toHaveLength(2);
      expect(alertMessages(socket)).toHaveLength(1);
    }
    expect((await run({ op: "status" })).muted).toBe(true);
    await run({ op: "mute", on: false });
    ingest.restart(page);
    expect(last(await listen("horizontal")).muted).toBe(false);
  });
});

describe("skip", (): void => {
  it("ends the alert on stream and starts the next one", async (): Promise<void> => {
    const socket = await listen();
    await deliver([gift("g1"), gift("g2")]);
    vi.setSystemTime(T0 + 1000);
    const skipped = await run({ op: "skip" });
    expect(skipped).toMatchObject({ waiting: 0, current: { id: "twitch:g2", startsAt: T0 + 1000, endsAt: T0 + 7000 } });
    expect(last(socket)).toEqual({ type: "alerts", ...skipped });
    // The old alarm comes first and changes nothing. The alarm of the new alert ends it.
    await fireAlarm();
    expect(last(socket).current?.id).toBe("twitch:g2");
    expect(state().storage.alarm).toBe(T0 + 7000);
    expect(await run({ op: "skip" })).toMatchObject({ current: null, waiting: 0 });
    // With no alert on stream, a skip changes nothing and sends nothing.
    const sent: number = socket.sent.length;
    expect(await run({ op: "skip" })).toMatchObject({ current: null, waiting: 0 });
    expect(socket.sent).toHaveLength(sent);
  });
});

describe("a test and a replay", (): void => {
  it("add no support row and send no event", async (): Promise<void> => {
    const [wide, tall] = [await listen("horizontal"), await listen("vertical")];
    await deliver([gift("g1")]);
    await run({ op: "skip" });
    const rows: string[] = supportRows();
    const snapshot = (await listen()).ofType<{ events: ActivityEvent[] }>("snapshot")[0].events;
    const replayed = await run({ op: "replay", id: "twitch:g1" });
    expect(replayed.current).toMatchObject({ id: "twitch:g1~r1", origin: "replay", kind: "gift", name: "Supporter" });
    const tested = await run({ op: "test" });
    expect(tested).toMatchObject({ waiting: 1, current: { id: "twitch:g1~r1" } });
    await run({ op: "skip" });
    const anonymous = await run({ op: "test", kind: "anonymous" });
    expect(anonymous).toMatchObject({ waiting: 1, current: { id: "twitch:test-2", origin: "test", kind: "gift" } });
    // Each play has its own ID, so a page shows a second replay of one event.
    expect((await run({ op: "replay", id: "twitch:g1" })).waiting).toBe(2);
    await run({ op: "skip" });
    await run({ op: "skip" });
    expect(last(wide).current?.id).toBe("twitch:g1~r4");
    for (const socket of [wide, tall]) {
      expect(socket.ofType("event")).toHaveLength(1);
      expect(socket.ofType("snapshot")).toHaveLength(1);
    }
    expect(supportRows()).toEqual(rows);
    expect((await listen()).ofType<{ events: ActivityEvent[] }>("snapshot")[0].events).toEqual(snapshot);
    expect(snapshot.filter(isSupport)).toHaveLength(1);
  });

  it("ignore the amount of the rule, and keep the switches of the rule", async (): Promise<void> => {
    const socket = await listen();
    await deliver([support("bits", "b1", { amount: 1 }), support("follow", "f1")]);
    expect(last(socket).current).toBeNull();
    expect((await run({ op: "replay", id: "twitch:b1" })).current).toMatchObject({ id: "twitch:b1~r1", amount: 1 });
    // A follow has no banner: its replay and its test play at once.
    expect((await run({ op: "replay", id: "twitch:f1" })).waiting).toBe(0);
    await run({ op: "test", kind: "follow" });
    expect(ones(socket).map((view) => [view.id, view.origin])).toEqual([
      ["twitch:f1", "live"],
      ["twitch:f1~r2", "replay"],
      ["twitch:test-3", "test"],
    ]);
    for (const kind of ["subscription", "gift", "bits", "super_chat", "raid", "topic", "anonymous"])
      expect((await control({ op: "test", kind })).status, kind).toBe(200);
    expect((await run({ op: "status" })).waiting).toBe(7);
  });

  it("are refused with a reason when they cannot play", async (): Promise<void> => {
    await setLayers(layersOn({ gift: { min: 1, banner: false, chat: false, character: false } }));
    // No page listens.
    expect(await refused({ op: "test" })).toEqual([409, "alerts_unwatched"]);
    const socket = await listen();
    await deliver([gift("g1"), support("follow", "f1")]);
    // The rule has each switch off.
    expect(await refused({ op: "test" })).toEqual([409, "alert_rule_off"]);
    expect(await refused({ op: "replay", id: "twitch:g1" })).toEqual([409, "alert_rule_off"]);
    // The event is not kept: an unknown ID, the ID of a play, or an event that is too old.
    expect(await refused({ op: "replay", id: "twitch:nothing" })).toEqual([404, "alert_gone"]);
    expect(await refused({ op: "replay", id: "twitch:f1~r1" })).toEqual([404, "alert_gone"]);
    vi.setSystemTime(T0 + SNAPSHOT_MAX_AGE_MS);
    expect((await control({ op: "replay", id: "twitch:f1" })).status).toBe(200);
    vi.setSystemTime(T0 + SNAPSHOT_MAX_AGE_MS + 1);
    expect(await refused({ op: "replay", id: "twitch:f1" })).toEqual([404, "alert_gone"]);
    // The alerts layer is not on stream. The host reads the saved layers for each test, also without a notice.
    await setLayers(DEFAULT_LAYERS, false);
    expect(await refused({ op: "test", kind: "follow" })).toEqual([400, "alerts_off_stream"]);
    expect(await refused({ op: "replay", id: "twitch:f1" })).toEqual([400, "alerts_off_stream"]);
    await setLayers(layersOn(), false);
    expect((await control({ op: "test" })).status).toBe(200);
    expect(alertMessages(socket).at(-1)).toMatchObject({ type: "alerts", current: { origin: "test" } });
  });

  it("answer 400 for a body that is not a control", async (): Promise<void> => {
    await listen();
    for (const body of [
      {},
      { op: "play" },
      { op: "test", kind: "tip" },
      { op: "mute" },
      { op: "mute", on: "yes" },
      { op: "replay" },
      { op: "replay", id: "" },
      { op: "replay", id: "x".repeat(161) },
      { op: "skip", id: "twitch:g1" },
      { op: "status", extra: true },
    ]) {
      const answer = await control(body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(alertRefusal(answer.body)).toBeNull();
    }
    const raw = await ingest.get(ingest.idFromName(page)).fetch(url("alerts"), { method: "POST", body: "not json" });
    expect(raw.status).toBe(400);
    expect((await ingest.get(ingest.idFromName(page)).fetch(url("alerts"))).status).toBe(405);
  });
});

describe("an anonymous event", (): void => {
  it("never shows a name or an ID: live, as a replay, and after a reconnect", async (): Promise<void> => {
    const socket = await listen("horizontal");
    await deliver([
      gift("anon", { anonymous: true, sender: null }),
      support("follow", "named", { sender: { id: "viewer-id-2", displayName: "Visible Name" } }),
    ]);
    expect(last(socket).current).toMatchObject({ id: "twitch:anon", anonymous: true, name: null });
    const late = await listen("vertical");
    expect(last(late).current).toMatchObject({ anonymous: true, name: null });
    await run({ op: "skip" });
    const replayed = await run({ op: "replay", id: "twitch:anon" });
    expect(replayed.current).toMatchObject({ id: "twitch:anon~r1", anonymous: true, name: null });
    await run({ op: "replay", id: "twitch:named" });
    await run({ op: "test", kind: "anonymous" });
    ingest.restart(page);
    const again = await listen("horizontal");
    expect(last(again).current).toMatchObject({ id: "twitch:anon~r1", anonymous: true, name: null });
    for (const one of [socket, late, again]) {
      const anonymous: AlertView[] = [
        ...states(one).flatMap((message): AlertView[] => (message.current ? [message.current] : [])),
        ...ones(one),
      ].filter((view: AlertView): boolean => view.anonymous);
      for (const view of anonymous) expect(view.name).toBeNull();
      // No alert message has a platform user ID, with a name or without one.
      const text: string = JSON.stringify(alertMessages(one));
      expect(text).not.toContain("viewer-id");
      expect(text).not.toMatch(/subject|sender|userId/);
    }
    expect(ones(socket).map((view) => view.name)).toEqual(["Visible Name", "Visible Name"]);
    // The answers of the controls are the same state.
    expect(JSON.stringify(await run({ op: "status" }))).not.toContain("viewer-id");
  });
});

describe("the saved layers", (): void => {
  it("stop the alerts when the layer goes off stream", async (): Promise<void> => {
    const socket = await listen();
    await deliver([gift("g1"), gift("g2")]);
    await setLayers(layersOn({ gift: { ...DEFAULT_RULES.gift, min: 2 } }));
    // A change that keeps the layer on stream keeps the line.
    expect(last(socket)).toMatchObject({ current: { id: "twitch:g1" }, waiting: 1 });
    await setLayers(layersOn({}, { alerts: { enabled: false, rules: rules({}) } }));
    expect(last(socket)).toMatchObject({ current: null, waiting: 0 });
    expect(lineRows()).toBe(0);
  });

  it("are read again when a socket opens or the alarm runs, when the copy is old", async (): Promise<void> => {
    const socket = await listen();
    await deliver([gift("g1"), gift("g2"), gift("g3")]);
    // A change notice did not arrive.
    await setLayers(DEFAULT_LAYERS, false);
    vi.setSystemTime(T0 + LAYER_CHECK_MS - 1);
    await listen();
    expect(last(socket).waiting).toBe(2);
    vi.setSystemTime(T0 + LAYER_CHECK_MS);
    const late = await listen();
    // The read changed the state: each socket gets it.
    for (const one of [socket, late]) expect(last(one)).toMatchObject({ current: null, waiting: 0 });
    await setLayers(layersOn(), false);
    await deliver([gift("g4")]);
    expect(last(socket).current).toBeNull();
    vi.setSystemTime(T0 + 2 * LAYER_CHECK_MS);
    await state().storage.deleteAlarm();
    await room().alarm();
    await deliver([gift("g5")]);
    expect(last(socket).current?.id).toBe("twitch:g5");
  });

  it("stay as the host knows them when a read fails", async (): Promise<void> => {
    const error = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const socket = await listen();
    const faulty = faultyDatabase(database.db);
    faulty.fail(/SELECT layers/);
    env.DB = faulty.db;
    expect((await post("playground-config")).status).toBe(204);
    expect(error).toHaveBeenCalledWith("alerts_config_failed", { cause: "Error" });
    // The host uses its copy: a test plays.
    expect((await control({ op: "test" })).status).toBe(200);
    expect(last(socket).current?.origin).toBe("test");
    await run({ op: "skip" });
    // A new instance has the copy from storage.
    ingest.restart(page);
    const next = await listen();
    await deliver([gift("g1")]);
    expect(last(next).current?.id).toBe("twitch:g1");
  });

  it("answer 503 for a test when the host has no copy and cannot read them", async (): Promise<void> => {
    const error = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    const host = new AlertHost({
      sql: new RoomState({ toString: (): string => "unread" }).storage.sql as unknown as SqlStorage,
      sockets: (): WebSocket[] => [],
      readLayers: (): Promise<OverlayLayers> => Promise.reject(new TypeError("no database")),
      schedule: (): Promise<void> => Promise.resolve(),
      react: (): number => 0,
      support: (): null => null,
    });
    host.load();
    const request = (body: unknown): Request =>
      new Request("https://channel-ingest.internal/alerts", { method: "POST", body: JSON.stringify(body) });
    const answer = await host.request(request({ op: "test" }));
    expect(answer.status).toBe(503);
    expect(alertRefusal(await answer.json())).toBe("alerts_unavailable");
    expect(error).toHaveBeenCalledWith("alerts_config_failed", { cause: "TypeError" });
    // The controls that need no layers still answer.
    expect((await host.request(request({ op: "mute", on: true }))).status).toBe(200);
    expect((await host.request(request({ op: "status" }))).status).toBe(200);
  });

  it("are read once more when they change, or a test comes, during a read", async (): Promise<void> => {
    const test = (): Request =>
      new Request("https://channel-ingest.internal/alerts", { method: "POST", body: '{"op":"test"}' });
    for (const second of ["notice", "test"] as const) {
      let reads = 0;
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve): void => {
        release = resolve;
      });
      const host = new AlertHost({
        sql: new RoomState({ toString: (): string => "reads" }).storage.sql as unknown as SqlStorage,
        sockets: (): WebSocket[] => [],
        // The first read is slow and sees the old layers.
        readLayers: async (): Promise<OverlayLayers> => {
          reads += 1;
          if (reads > 1) return layersOn();
          await held;
          return DEFAULT_LAYERS;
        },
        schedule: (): Promise<void> => Promise.resolve(),
        react: (): number => 0,
        support: (): null => null,
      });
      host.load();
      const first: Promise<void> = host.layersChanged();
      const next: Promise<Response | void> = second === "test" ? host.request(test()) : host.layersChanged();
      // The second caller reaches the host while the first read still runs.
      await new Promise<void>((resolve): void => void setTimeout(resolve, 0));
      expect(reads).toBe(1);
      release?.();
      const [, answer] = await Promise.all([first, next]);
      expect(reads, second).toBe(2);
      // The copy is the newer one: a test finds no page, not a layer that is off stream.
      const refusal = alertRefusal(await (answer ?? (await host.request(test()))).json());
      expect(refusal, second).toBe("alerts_unwatched");
    }
  });
});

describe("what the object keeps", (): void => {
  it("restores the alert on stream and the line in a new instance", async (): Promise<void> => {
    await listen();
    await deliver([gift("g1"), gift("g2"), gift("g3")]);
    await run({ op: "replay", id: "twitch:g1" });
    ingest.restart(page);
    const socket = await listen();
    expect(last(socket)).toMatchObject({ current: { id: "twitch:g1", endsAt: T0 + ALERT_SHOW_MS }, waiting: 3 });
    await fireAlarm();
    expect(last(socket)).toMatchObject({ current: { id: "twitch:g2" }, waiting: 2 });
    // The number of plays is kept too: the next replay has a new ID.
    await run({ op: "skip" });
    await run({ op: "skip" });
    expect((await run({ op: "replay", id: "twitch:g1" })).waiting).toBe(1);
    await run({ op: "skip" });
    expect((await run({ op: "status" })).current?.id).toBe("twitch:g1~r2");
  });

  it("drops the line when no page listens at the alarm", async (): Promise<void> => {
    const socket = await listen();
    await deliver([gift("g1"), gift("g2")]);
    socket.close();
    await fireAlarm();
    expect(lineRows()).toBe(0);
    // Nothing plays later: a page that opens gets no alert.
    const next = await listen();
    expect(last(next)).toMatchObject({ current: null, waiting: 0 });
    // Without an alert, an alarm with no page changes nothing.
    next.close();
    await state().storage.deleteAlarm();
    await room().alarm();
    expect(lineRows()).toBe(0);
  });

  it("starts with no alert when the stored state or the stored line is not valid", async (): Promise<void> => {
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    for (const damage of [
      "UPDATE alert_state SET body='{\"v\":2}' WHERE key='state'",
      "UPDATE alert_state SET body='not json' WHERE key='state'",
      "UPDATE alert_line SET body='{\"view\":{}}'",
    ]) {
      const { host, storage, restart, socket } = standalone();
      await host.layersChanged();
      host.receive(gift("g1"));
      host.receive(gift("g2"));
      storage.sql.exec(damage);
      warn.mockClear();
      const next: AlertHost = restart();
      expect(warn.mock.calls).toEqual([["alerts_state_invalid"]]);
      expect(storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM alert_line").toArray()[0].n).toBe(0);
      await next.opened(socket as unknown as WebSocket);
      expect(last(socket).waiting).toBe(0);
      // The host stored a valid state again: the next instance has nothing to drop.
      warn.mockClear();
      restart();
      expect(warn).not.toHaveBeenCalled();
    }
    // A copy of the layers that is not valid is read again, with no warning.
    const { host, storage, restart, socket } = standalone();
    await host.layersChanged();
    storage.sql.exec("UPDATE alert_state SET body='{\"shown\":true}' WHERE key='config'");
    warn.mockClear();
    const next: AlertHost = restart();
    next.receive(gift("g1"));
    expect(states(socket)).toEqual([]);
    await next.opened(socket as unknown as WebSocket);
    next.receive(gift("g2"));
    expect(last(socket).current?.id).toBe("twitch:g2");
    expect(warn).not.toHaveBeenCalled();
  });

  it("removes the alerts of a platform that the owner disconnects", async (): Promise<void> => {
    const { host, socket, storage } = standalone();
    await host.layersChanged();
    for (const [index, platform] of (["kick", "twitch", "kick", "twitch"] as const).entries())
      host.receive(gift(`g${index}`, { platform }));
    expect(last(socket)).toMatchObject({ current: { id: "kick:g0" }, waiting: 3 });
    host.dropPlatform("youtube");
    expect(states(socket)).toHaveLength(4);
    vi.setSystemTime(T0 + 500);
    host.dropPlatform("kick");
    // The alert on stream was of the platform: the next one starts.
    expect(last(socket)).toMatchObject({ current: { id: "twitch:g1", startsAt: T0 + 500 }, waiting: 1 });
    expect(storage.sql.exec<{ id: string }>("SELECT id FROM alert_line").toArray()).toEqual([{ id: "twitch:g3" }]);
    host.dropPlatform("twitch");
    expect(last(socket)).toMatchObject({ current: null, waiting: 0 });
  });

  it("forgets everything when the page goes away", async (): Promise<void> => {
    const socket = await listen();
    await deliver([gift("g1"), gift("g2")]);
    await run({ op: "skip" });
    await run({ op: "mute", on: true });
    expect((await post("close")).status).toBe(204);
    expect(socket.open).toBe(false);
    expect(lineRows()).toBe(0);
    expect(state().storage.sql.exec("SELECT key FROM alert_state").toArray()).toEqual([]);
    const next = await listen();
    expect(last(next)).toMatchObject({ muted: false, current: null, waiting: 0 });
    // The plays start again, and the host reads the layers again before the next alert.
    expect((await run({ op: "test" })).current?.id).toBe("twitch:test-1");
  });

  it("sends to a socket that closed without an error", async (): Promise<void> => {
    const { host, socket } = standalone();
    await host.layersChanged();
    socket.failSends = true;
    expect((): void => host.receive(gift("g1"))).not.toThrow();
    socket.failSends = false;
    await host.opened(socket as unknown as WebSocket);
    expect(last(socket).current?.id).toBe("twitch:g1");
  });
});
