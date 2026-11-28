import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AppEnv } from "../app/env";
import {
  DELIVERIES_KEPT,
  isSupport,
  parseActivityMessage,
  type ActivityChat,
  type ActivityEvent,
  type ActivityPlatform,
  type ActivitySupport,
} from "../app/lib/activity";
import { alertRefusal, alertsReplySchema, type AlertsReply } from "../app/lib/alert-control";
import { ALERT_SHOW_MS, DEFAULT_RULES, type AlertRules, type AlertView, type AlertsMessage } from "../app/lib/alerts";
import type { GoalCount } from "../app/lib/goals";
import { DEFAULT_LAYERS, emptyCells, storedLayersText, type OverlayLayers } from "../app/lib/overlay-layers";
import { ALERT_LINE_MAX, AlertHost, GOAL_PEOPLE_MAX, earliestAt } from "../app/server/alert-host";
import { ChannelSubscriptions } from "../app/server/channel-ingest-subscriptions";
import { ChannelIngest } from "../app/server/channel-ingest";
import { SEEN_TTL_MS, SNAPSHOT_MAX_AGE_MS } from "../app/server/channel-ingest-limits";
import { ALERTS } from "../app/server/channel-ingest-sql";
import { topicKey, voteKey } from "../app/server/goal-votes";
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

/** A chat message of a viewer. */
function chat(messageId: string, userId: string): ActivityChat {
  return {
    kind: "chat",
    id: `twitch:${messageId}`,
    platform: "twitch",
    channelId: "111",
    messageId,
    user: { id: userId, displayName: `Name of ${messageId}` },
    text: "hello",
    fragments: [{ type: "text", text: "hello" }],
    badges: [],
    sentAt: null,
    receivedAt: Date.now(),
    live: true,
  };
}

/** `event` with `suffix` at the end of its ID, so the object takes it as a new event. */
function renamed(event: ActivityEvent, suffix: string): ActivityEvent {
  if (event.kind === "chat") return { ...event, messageId: `${event.messageId}${suffix}`, id: `${event.id}${suffix}` };
  if (!isSupport(event)) return event;
  return { ...event, deliveryId: `${event.deliveryId}${suffix}`, id: `${event.id}${suffix}` };
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

/** `base` with the goal layer on the horizontal grid. "Show on stream" is off unless `goal` turns it on. */
function withGoal(
  counts: GoalCount,
  goal: Partial<OverlayLayers["goal"]> = {},
  base: OverlayLayers = layersOn(),
): OverlayLayers {
  return {
    ...base,
    goal: { ...DEFAULT_LAYERS.goal, counts, ...goal },
    cells: { ...base.cells, horizontal: { ...base.cells.horizontal, goal: { c: 0, r: 4, w: 8, h: 2 } } },
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
  readLayers: Mock<() => Promise<OverlayLayers>>;
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
  const readLayers = vi.fn<() => Promise<OverlayLayers>>((): Promise<OverlayLayers> => Promise.resolve(layers));
  const schedule = vi.fn<(at: number) => Promise<void>>((): Promise<void> => Promise.resolve());
  const kept = new Map<string, ActivitySupport>();
  const create = (): AlertHost => {
    const host = new AlertHost({
      sql: storage.sql as unknown as SqlStorage,
      sockets: (): WebSocket[] => sockets.filter((item: FakeSocket): boolean => item.open) as unknown as WebSocket[],
      readLayers,
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
  return { host, socket, sockets, react, readLayers, schedule, kept, storage, send, restart: create };
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

describe("the sample support event of the test deployment", (): void => {
  it("shows as a live event, plays its alert, and sets the alarm for the end of the alert", async (): Promise<void> => {
    // The test-chat path answers only in the test deployment.
    expect((await post("test-chat", undefined, { sample: "support" })).status).toBe(404);
    Object.assign(env, {
      APP_ENV: "test",
      APP_ORIGIN: "https://test.streambullets.com",
      TEST_ACCESS_SECRET: "s".repeat(40),
      TEST_DATABASE_ID: "e475eb5b-db31-43bd-8692-5926711e8faa",
      ADMIN_EMAILS: "admin@example.test",
    });
    const socket = await listen("horizontal");
    expect((await post("test-chat", undefined, { sample: "support" })).status).toBe(204);
    const id = `twitch:test-support-${T0}`;
    const events = socket
      .messages<{ type: string; event?: ActivitySupport }>()
      .flatMap((message): ActivitySupport[] => (message.type === "event" && message.event ? [message.event] : []));
    expect(events).toMatchObject([{ id, kind: "gift", amount: 5, replay: false }]);
    expect(supportRows()).toEqual([id]);
    expect(last(socket).current).toMatchObject({ id, origin: "live", name: "LanternFox", amount: 5 });
    // The alarm ends the alert on time, before the cleanup of the stored messages.
    expect(state().storage.alarm).toBe(T0 + ALERT_SHOW_MS);
    await fireAlarm();
    expect(last(socket).current).toBeNull();
    // The sample chat stays chat only.
    vi.setSystemTime(T0 + ALERT_SHOW_MS + 1000);
    expect((await post("test-chat")).status).toBe(204);
    expect(supportRows()).toEqual([id]);
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

describe("the goal", (): void => {
  it("counts each stored support event one time: never a replay, a test, or an event that comes again", async (): Promise<void> => {
    await setLayers(withGoal("subs"));
    const socket = await listen("horizontal");
    expect(last(socket).goal).toEqual({ counts: "subs", value: 0, startedAt: T0 });
    await deliver([gift("g1")]);
    // A gift bundle counts its gifts. The value comes with the state, to each socket.
    expect(last(socket)).toMatchObject({
      current: { id: "twitch:g1" },
      goal: { counts: "subs", value: 5, startedAt: T0 },
    });
    await run({ op: "replay", id: "twitch:g1" });
    await run({ op: "test" });
    await run({ op: "test", kind: "subscription" });
    expect((await run({ op: "status" })).goal?.value).toBe(5);
    // A provider sends the delivery again: the object refuses the ID for 15 minutes.
    await deliver([gift("g1")]);
    expect((await run({ op: "status" })).goal?.value).toBe(5);
    // After that time, and in a new instance, the object stores the event again and sends it again. The host knows
    // the ID: the event counts for nothing and plays nothing.
    await run({ op: "mute", on: true });
    await run({ op: "mute", on: false });
    ingest.restart(page);
    vi.setSystemTime(T0 + SEEN_TTL_MS + 1);
    const next = await listen("vertical");
    expect(last(next).goal).toEqual({ counts: "subs", value: 5, startedAt: T0 });
    await deliver([gift("g1")]);
    expect(next.ofType("event")).toHaveLength(1);
    expect(alertMessages(next)).toHaveLength(1);
    expect((await run({ op: "status" })).goal?.value).toBe(5);
    // A subscription and a membership count 1, not their months. A follow is not for this goal.
    await deliver([
      support("subscription", "s1", { amount: 12 }),
      support("membership", "m1", { amount: 3 }),
      support("follow", "f1"),
    ]);
    expect(last(next).goal).toEqual({ counts: "subs", value: 7, startedAt: T0 });
    expect(supportRows()).toEqual(["twitch:g1", "twitch:s1", "twitch:m1", "twitch:f1"]);
  });

  it("reads the layers before the first events when the object has no copy, with no page and no notice", async (): Promise<void> => {
    // An object from before the alerts: it stored no copy of the layers.
    state().storage.sql.exec("DELETE FROM alert_state");
    ingest.restart(page);
    await setLayers(withGoal("follows"), false);
    await deliver([support("follow", "f1")]);
    expect(await run({ op: "status" })).toMatchObject({ goal: { counts: "follows", value: 1 } });
  });

  it("starts the first goal at the earliest live event that woke the read, also when the read takes time", async (): Promise<void> => {
    const { host, readLayers, send } = standalone(withGoal("follows"));
    readLayers.mockImplementation((): Promise<OverlayLayers> => {
      vi.setSystemTime(T0 + 500);
      return Promise.resolve(withGoal("follows"));
    });
    const events: ActivityEvent[] = [support("follow", "f1", { sentAt: T0 - 100 }), support("follow", "f2")];
    await host.ready(earliestAt(events, Date.now()));
    for (const event of events) host.receive(event);
    expect(await (await send({ op: "status" })).json()).toMatchObject({
      goal: { counts: "follows", value: 2, startedAt: T0 - 100 },
    });
    // A goal that counts a different thing starts at the read: an event from before it does not count.
    readLayers.mockResolvedValue(withGoal("subs"));
    vi.setSystemTime(T0 + 1000);
    await host.layersChanged();
    host.receive(support("subscription", "s1", { sentAt: T0 + 900 }));
    expect(await (await send({ op: "status" })).json()).toMatchObject({
      goal: { counts: "subs", value: 0, startedAt: T0 + 1000 },
    });
  });

  it("starts the first goal at the earliest event of two deliveries that share the first read", async (): Promise<void> => {
    const { host, readLayers, send } = standalone(withGoal("follows"));
    let finish: (layers: OverlayLayers) => void = (): void => undefined;
    readLayers.mockImplementation(
      (): Promise<OverlayLayers> =>
        new Promise<OverlayLayers>((resolve: (layers: OverlayLayers) => void): void => {
          finish = resolve;
        }),
    );
    const first: ActivitySupport = support("follow", "f1", { sentAt: T0 - 200 });
    const second: ActivitySupport = support("follow", "f2", { sentAt: T0 - 100 });
    const reads: Promise<boolean>[] = [host.ready(earliestAt([first], T0)), host.ready(earliestAt([second], T0))];
    finish(withGoal("follows"));
    await Promise.all(reads);
    host.receive(first);
    host.receive(second);
    expect(await (await send({ op: "status" })).json()).toMatchObject({ goal: { value: 2, startedAt: T0 - 200 } });
  });

  it("applies no read that a wipe overtook, so a deleted page keeps no goal and no copy", async (): Promise<void> => {
    const { host, readLayers, storage, send } = standalone(withGoal("follows"));
    let finish: (layers: OverlayLayers) => void = (): void => undefined;
    readLayers.mockImplementation(
      (): Promise<OverlayLayers> =>
        new Promise<OverlayLayers>((resolve: (layers: OverlayLayers) => void): void => {
          finish = resolve;
        }),
    );
    const pending: Promise<boolean> = host.ready(T0);
    host.wipe();
    finish(withGoal("follows"));
    expect(await pending).toBe(false);
    expect(storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM alert_state").toArray()[0].n).toBe(0);
    readLayers.mockResolvedValue(withGoal("follows"));
    // A read after the wipe works as before.
    expect(await host.ready(T0)).toBe(true);
    expect(await (await send({ op: "status" })).json()).toMatchObject({ goal: { counts: "follows", value: 0 } });
  });

  it("takes the earliest send time of the live chat and support events only", (): void => {
    const old: ActivitySupport = support("follow", "old", { sentAt: T0 - 10 * 60_000 });
    const status: ActivityEvent = { kind: "clear", platform: "twitch", receivedAt: T0 - 5000 };
    expect(earliestAt([old, status], T0)).toBe(T0);
    expect(earliestAt([support("follow", "f1", { sentAt: T0 - 2000 })], T0)).toBe(T0 - 2000);
  });

  it("advances the alerts at the alarm before the provider work, so a slow provider holds no alert", async (): Promise<void> => {
    await listen();
    const order: string[] = [];
    vi.spyOn(AlertHost.prototype, "alarm").mockImplementation((): Promise<void> => {
      order.push("alerts");
      return Promise.resolve();
    });
    vi.spyOn(ChannelSubscriptions.prototype, "due").mockImplementation((): Promise<number | null> => {
      order.push("subscriptions");
      return Promise.resolve(null);
    });
    await room().alarm();
    expect(order).toEqual(["alerts", "subscriptions"]);
  });

  it("refuses a delivery while the first read of the layers fails, so the retry of the provider counts", async (): Promise<void> => {
    const error = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    state().storage.sql.exec("DELETE FROM alert_state");
    ingest.restart(page);
    await setLayers(withGoal("follows"), false);
    const faulty = faultyDatabase(database.db);
    faulty.fail(/SELECT layers/);
    env.DB = faulty.db;
    const body = { deliveryId: "retry-1", channelId: "111", events: [support("follow", "f1")] };
    expect((await post("event", body, { platform: "twitch" })).status).toBe(503);
    expect(error).toHaveBeenCalledWith("alerts_config_failed", { cause: "Error" });
    expect(supportRows()).toEqual([]);
    faulty.heal();
    expect((await post("event", body, { platform: "twitch" })).status).toBe(204);
    expect(await run({ op: "status" })).toMatchObject({ goal: { counts: "follows", value: 1 } });
  });

  it("counts while the alerts are muted, off stream, or have no page, and not while the layer has no place", async (): Promise<void> => {
    // The alerts layer is off, no socket is open, and the goal has "Show on stream" off.
    await setLayers(withGoal("follows", {}, DEFAULT_LAYERS));
    await deliver([support("follow", "f1")]);
    expect(await run({ op: "status" })).toMatchObject({ current: null, goal: { counts: "follows", value: 1 } });
    await setLayers(withGoal("follows"));
    const socket = await listen();
    await run({ op: "mute", on: true });
    await deliver([support("follow", "f2")]);
    expect(last(socket)).toMatchObject({ muted: true, current: null, goal: { value: 2 } });
    expect(ones(socket)).toEqual([]);
    // Off the grid of the two outputs, the page counts no goal. The host keeps the count.
    await setLayers(layersOn());
    expect(last(socket).goal).toBeNull();
    await deliver([support("follow", "f3")]);
    expect(last(socket).goal).toBeNull();
    // On the vertical grid only, and with a title and a target: the count goes on from its value.
    const tall: OverlayLayers = withGoal("follows", { enabled: true, title: "New followers", target: 10 });
    await setLayers({
      ...tall,
      cells: {
        horizontal: layersOn().cells.horizontal,
        vertical: { ...emptyCells(), goal: { c: 0, r: 4, w: 8, h: 2 } },
      },
    });
    expect(last(socket).goal).toEqual({ counts: "follows", value: 2, startedAt: T0 });
    await deliver([support("follow", "f4")]);
    expect(last(socket).goal?.value).toBe(3);
  });

  it("does not count an event from before the start of the count", async (): Promise<void> => {
    vi.setSystemTime(T0 + 5000);
    await setLayers(withGoal("bits"));
    const socket = await listen();
    expect(last(socket).goal).toEqual({ counts: "bits", value: 0, startedAt: T0 + 5000 });
    await deliver([support("bits", "old", { amount: 100, sentAt: T0 + 4999 })]);
    expect(last(socket).goal?.value).toBe(0);
    await deliver([support("bits", "new", { amount: 100, sentAt: T0 + 5000 }), support("bits", "now", { amount: 20 })]);
    expect(last(socket).goal?.value).toBe(120);
  });

  it("starts a new count when it counts a different thing, and not for a new title or target", async (): Promise<void> => {
    await setLayers(withGoal("subs"));
    const socket = await listen();
    await deliver([gift("g1")]);
    const sent: number = states(socket).length;
    await setLayers(withGoal("subs", { enabled: true, title: "Road to 50", target: 50 }));
    expect(states(socket)).toHaveLength(sent);
    expect(last(socket).goal).toEqual({ counts: "subs", value: 5, startedAt: T0 });
    vi.setSystemTime(T0 + 1000);
    await setLayers(withGoal("bits"));
    expect(last(socket).goal).toEqual({ counts: "bits", value: 0, startedAt: T0 + 1000 });
    await deliver([gift("g2"), support("bits", "b1", { amount: 250 })]);
    expect(last(socket).goal?.value).toBe(250);
    vi.setSystemTime(T0 + 2000);
    await setLayers(withGoal("subs"));
    expect(last(socket).goal).toEqual({ counts: "subs", value: 0, startedAt: T0 + 2000 });
  });

  it("counts follows, Bits, and KICKs, each in its own unit, and nothing for votes", async (): Promise<void> => {
    const socket = await listen();
    const events: ActivityEvent[] = [
      support("follow", "f"),
      support("bits", "b", { amount: 150 }),
      gift("g"),
      chat("m", "chatter-id-1"),
    ];
    for (const [index, [counts, value]] of (
      [
        ["follows", 1],
        ["bits", 150],
        ["subs", 5],
        ["votes", 0],
      ] as const
    ).entries()) {
      await setLayers(withGoal(counts));
      await deliver(events.map((event: ActivityEvent): ActivityEvent => renamed(event, `${index}`)));
      await deliver([support("kicks", `k${index}`, { amount: 30, platform: "kick" })], "kick");
      expect(last(socket).goal, counts).toMatchObject({ counts, value });
    }
    await setLayers(withGoal("kicks"));
    await deliver([support("kicks", "k", { amount: 30, platform: "kick" })], "kick");
    expect(last(socket).goal).toMatchObject({ counts: "kicks", value: 30 });
  });

  it("starts again at 0 for the owner, and an ID from before never counts in the new count", async (): Promise<void> => {
    await setLayers(withGoal("subs"));
    let socket = await listen();
    await deliver([gift("g1")]);
    vi.setSystemTime(T0 + 2000);
    const reset = await run({ op: "goalReset" });
    expect(reset.goal).toEqual({ counts: "subs", value: 0, startedAt: T0 + 2000 });
    expect(last(socket)).toEqual({ type: "alerts", ...reset });
    // The new count is in storage: a new instance does not go back to the old one.
    ingest.restart(page);
    socket = await listen();
    expect(last(socket).goal).toEqual(reset.goal);
    vi.setSystemTime(T0 + SEEN_TTL_MS + 1);
    await deliver([gift("g1")]);
    expect(last(socket).goal?.value).toBe(0);
    await deliver([gift("g2")]);
    expect(last(socket).goal?.value).toBe(5);
    // The host reads the saved layers for this control: it needs no notice of a change.
    await setLayers(layersOn(), false);
    expect(await refused({ op: "goalReset" })).toEqual([400, "goal_off"]);
    expect(last(socket).goal).toBeNull();
    await setLayers(withGoal("subs"), false);
    expect((await run({ op: "goalReset" })).goal).toMatchObject({ counts: "subs", value: 0 });
  });

  it("counts each person who chats one time, and keeps no user ID", async (): Promise<void> => {
    await setLayers(withGoal("chatters"));
    const socket = await listen();
    await deliver([chat("m1", "chatter-id-1"), chat("m2", "chatter-id-1"), chat("m3", "chatter-id-2")]);
    expect(last(socket).goal).toEqual({ counts: "chatters", value: 2, startedAt: T0 });
    // The same ID on a different platform is a different participant.
    await deliver([{ ...chat("m4", "chatter-id-1"), platform: "kick", id: "kick:m4" }], "kick");
    expect(last(socket).goal?.value).toBe(3);
    // A support event and a message from before the count are not for this goal.
    await deliver([gift("g1"), { ...chat("m5", "chatter-id-3"), sentAt: T0 - 1 }]);
    expect(last(socket).goal?.value).toBe(3);
    const sql = state().storage.sql;
    const people: { key: string }[] = sql.exec<{ key: string }>("SELECT key FROM goal_people").toArray();
    expect(people).toHaveLength(3);
    for (const person of people) expect(person.key).toMatch(/^[0-9a-f]{32}$/);
    const kept: string = JSON.stringify(sql.exec("SELECT body FROM alert_state").toArray());
    expect(kept).not.toContain("chatter-id");
    expect(JSON.stringify(alertMessages(socket))).not.toContain("chatter-id");
    // The count survives a new instance, and a known person does not count again.
    ingest.restart(page);
    const next = await listen();
    await deliver([chat("m6", "chatter-id-2"), chat("m7", "chatter-id-4")]);
    expect(last(next).goal?.value).toBe(4);
    // A new count forgets the people.
    await run({ op: "goalReset" });
    expect(sql.exec("SELECT key FROM goal_people").toArray()).toEqual([]);
    await deliver([chat("m8", "chatter-id-1")]);
    expect(last(next).goal?.value).toBe(1);
    // A new count has a new salt: the key of a person is not the key of the count before.
    const again: { key: string }[] = sql.exec<{ key: string }>("SELECT key FROM goal_people").toArray();
    expect(again).toHaveLength(1);
    expect(people.map((person): string => person.key)).not.toContain(again[0].key);
  });

  it("stops the count of chatters at GOAL_PEOPLE_MAX", async (): Promise<void> => {
    const { host, storage, restart, socket } = standalone(withGoal("chatters"));
    await host.layersChanged();
    host.receive(chat("m1", "chatter-id-1"));
    const stored = storage.sql.exec<{ body: string }>("SELECT body FROM alert_state WHERE key='goal'").toArray()[0];
    const goal = JSON.parse(stored.body) as { progress: { value: number } };
    goal.progress.value = GOAL_PEOPLE_MAX - 1;
    storage.sql.exec("UPDATE alert_state SET body=? WHERE key='goal'", JSON.stringify(goal));
    const next: AlertHost = restart();
    next.receive(chat("m2", "chatter-id-2"));
    next.receive(chat("m3", "chatter-id-3"));
    expect(last(socket).goal?.value).toBe(GOAL_PEOPLE_MAX);
    expect(storage.sql.exec("SELECT key FROM goal_people").toArray()).toHaveLength(2);
  });

  it("starts a new count when the stored count is not valid", async (): Promise<void> => {
    const { host, storage, restart, socket } = standalone(withGoal("follows"));
    await host.layersChanged();
    host.receive(support("follow", "f1"));
    expect(last(socket).goal?.value).toBe(1);
    storage.sql.exec(
      'UPDATE alert_state SET body=\'{"v":1,"progress":{"counts":"follows","value":-4}}\' WHERE key=\'goal\'',
    );
    const next: AlertHost = restart();
    next.receive(support("follow", "f2"));
    vi.setSystemTime(T0 + 3000);
    await next.opened(socket as unknown as WebSocket);
    expect(last(socket).goal).toEqual({ counts: "follows", value: 0, startedAt: T0 + 3000 });
  });

  it("reads the layers again at the alarm while the goal counts or the host has no copy, also with no page", async (): Promise<void> => {
    const { host, readLayers, sockets, send } = standalone(withGoal("subs"));
    sockets.length = 0;
    // The host has no copy.
    await host.alarm();
    expect(readLayers).toHaveBeenCalledTimes(1);
    // The copy is new.
    await host.alarm();
    expect(readLayers).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + LAYER_CHECK_MS);
    readLayers.mockResolvedValue(withGoal("bits"));
    await host.alarm();
    expect(readLayers).toHaveBeenCalledTimes(2);
    expect(await (await send({ op: "status" })).json()).toMatchObject({ goal: { counts: "bits", value: 0 } });
    // With no goal and no page, the host does not use the layers: it reads nothing.
    readLayers.mockResolvedValue(layersOn());
    vi.setSystemTime(T0 + 2 * LAYER_CHECK_MS);
    await host.alarm();
    vi.setSystemTime(T0 + 3 * LAYER_CHECK_MS);
    await host.alarm();
    expect(readLayers).toHaveBeenCalledTimes(3);
  });

  it("sets the alarm to the next read of the layers after the goal counted, also with no page", async (): Promise<void> => {
    const { host, schedule, sockets } = standalone(withGoal("follows"));
    sockets.length = 0;
    await host.layersChanged();
    await host.wake();
    // No event used the copy since the read: no alarm.
    expect(schedule).not.toHaveBeenCalled();
    vi.setSystemTime(T0 + 1000);
    host.receive(support("follow", "f1"));
    await host.wake();
    expect(schedule.mock.calls).toEqual([[T0 + LAYER_CHECK_MS]]);
    vi.setSystemTime(T0 + LAYER_CHECK_MS);
    schedule.mockClear();
    await host.alarm();
    // The read is new, and no event used it.
    expect(schedule).not.toHaveBeenCalled();
  });

  it("keeps the IDs of the newest DELIVERIES_KEPT support events when repeated IDs come", (): void => {
    const sql = new RoomState({ toString: (): string => "repeats" }).storage.sql as unknown as SqlStorage;
    ALERTS.create(sql);
    for (let index = 0; index < DELIVERIES_KEPT; index++) ALERTS.first(sql, `twitch:${index}`, DELIVERIES_KEPT);
    for (let index = 0; index < DELIVERIES_KEPT; index++)
      expect(ALERTS.first(sql, `twitch:${index}`, DELIVERIES_KEPT)).toBe(false);
    expect(ALERTS.first(sql, "twitch:new", DELIVERIES_KEPT)).toBe(true);
    expect(sql.exec<{ n: number }>("SELECT count(*) AS n FROM alert_counted").toArray()[0].n).toBe(DELIVERIES_KEPT);
    expect(ALERTS.first(sql, "twitch:1", DELIVERIES_KEPT)).toBe(false);
  });

  it("keeps the IDs of the newest DELIVERIES_KEPT support events", (): void => {
    const sql = new RoomState({ toString: (): string => "ids" }).storage.sql as unknown as SqlStorage;
    ALERTS.create(sql);
    for (let index = 0; index <= DELIVERIES_KEPT; index++)
      expect(ALERTS.first(sql, `twitch:${index}`, DELIVERIES_KEPT)).toBe(true);
    expect(sql.exec<{ n: number }>("SELECT count(*) AS n FROM alert_counted").toArray()[0].n).toBe(DELIVERIES_KEPT);
    expect(ALERTS.first(sql, "twitch:1", DELIVERIES_KEPT)).toBe(false);
    expect(ALERTS.first(sql, `twitch:${DELIVERIES_KEPT}`, DELIVERIES_KEPT)).toBe(false);
    // The oldest ID left the table.
    expect(ALERTS.first(sql, "twitch:0", DELIVERIES_KEPT)).toBe(true);
  });
});

describe("the goal for votes", (): void => {
  const poll = "a0000000-0000-4000-8000-000000000001";
  const other = "a0000000-0000-4000-8000-000000000002";
  const topic = "a0000000-0000-4000-8000-000000000003";

  /** One poll vote or new topic, as the API tells the object. The answer has no body. */
  async function count(key: string): Promise<number> {
    const response = await post("goal-count", { op: "count", key });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return response.status;
  }

  it("counts each poll vote and each new topic one time, so a changed vote counts once", async (): Promise<void> => {
    await setLayers(withGoal("votes"));
    const socket = await listen("horizontal");
    expect(last(socket).goal).toEqual({ counts: "votes", value: 0, startedAt: T0 });
    expect(await count(voteKey(poll, "voter-id-1"))).toBe(204);
    expect(last(socket).goal).toEqual({ counts: "votes", value: 1, startedAt: T0 });
    // The viewer changes the vote: the key is the same, so it counts for nothing.
    expect(await count(voteKey(poll, "voter-id-1"))).toBe(204);
    expect(await count(voteKey(poll, "voter-id-2"))).toBe(204);
    expect(await count(voteKey(other, "voter-id-1"))).toBe(204);
    expect(await count(topicKey(topic))).toBe(204);
    expect(await count(topicKey(topic))).toBe(204);
    expect(last(socket).goal).toEqual({ counts: "votes", value: 4, startedAt: T0 });
    // The count and the keys survive a new instance.
    ingest.restart(page);
    const next = await listen();
    expect(last(next).goal?.value).toBe(4);
    expect(await count(voteKey(poll, "voter-id-2"))).toBe(204);
    expect(last(next).goal?.value).toBe(4);
    // The object keeps a hash for each key, and no user ID. No message to a page has one.
    const sql = state().storage.sql;
    const keys: { key: string }[] = sql.exec<{ key: string }>("SELECT key FROM goal_people").toArray();
    expect(keys).toHaveLength(4);
    for (const key of keys) expect(key.key).toMatch(/^[0-9a-f]{32}$/);
    const kept: string = JSON.stringify(
      ["alert_state", "alert_counted", "alert_line"].map((table: string): unknown[] =>
        sql.exec(`SELECT * FROM ${table}`).toArray(),
      ),
    );
    expect(kept).not.toContain("voter-id");
    expect(JSON.stringify([...socket.sent, ...next.sent])).not.toContain("voter-id");
    // A new count forgets the keys: a vote that changes after it counts in the new count.
    vi.setSystemTime(T0 + 1000);
    await run({ op: "goalReset" });
    expect(sql.exec("SELECT key FROM goal_people").toArray()).toEqual([]);
    expect(await count(voteKey(poll, "voter-id-1"))).toBe(204);
    expect(last(next).goal).toEqual({ counts: "votes", value: 1, startedAt: T0 + 1000 });
  });

  it("counts nothing for a goal that counts a different thing, or while the goal has no place", async (): Promise<void> => {
    await setLayers(withGoal("subs"));
    const socket = await listen();
    expect(await count(voteKey(poll, "voter-id-1"))).toBe(204);
    expect(await count(topicKey(topic))).toBe(204);
    expect(last(socket).goal).toEqual({ counts: "subs", value: 0, startedAt: T0 });
    await setLayers(layersOn());
    expect(await count(topicKey(other))).toBe(204);
    expect(last(socket).goal).toBeNull();
    // The keys from before were not kept: they count for a goal that counts votes.
    vi.setSystemTime(T0 + 1000);
    await setLayers(withGoal("votes"));
    expect(await count(voteKey(poll, "voter-id-1"))).toBe(204);
    expect(await count(topicKey(topic))).toBe(204);
    expect(last(socket).goal).toEqual({ counts: "votes", value: 2, startedAt: T0 + 1000 });
  });

  it("never counts a test, a replay, a support event, or a chat message", async (): Promise<void> => {
    await setLayers(withGoal("votes"));
    const socket = await listen();
    await deliver([gift("g1"), support("follow", "f1"), chat("m1", "chatter-id-1")]);
    await run({ op: "test" });
    await run({ op: "test", kind: "follow" });
    await run({ op: "replay", id: "twitch:g1" });
    expect(last(socket).goal).toEqual({ counts: "votes", value: 0, startedAt: T0 });
    expect((await run({ op: "status" })).goal?.value).toBe(0);
  });

  it("stops at GOAL_PEOPLE_MAX keys", async (): Promise<void> => {
    const { host, storage, restart, socket } = standalone(withGoal("votes"));
    const send = (target: AlertHost, key: string): Promise<Response> =>
      target.goalCount(
        new Request("https://channel-ingest.internal/goal-count", {
          method: "POST",
          body: JSON.stringify({ op: "count", key }),
        }),
      );
    await host.layersChanged();
    expect((await send(host, topicKey(topic))).status).toBe(204);
    const stored = storage.sql.exec<{ body: string }>("SELECT body FROM alert_state WHERE key='goal'").toArray()[0];
    const goal = JSON.parse(stored.body) as { progress: { value: number } };
    goal.progress.value = GOAL_PEOPLE_MAX - 1;
    storage.sql.exec("UPDATE alert_state SET body=? WHERE key='goal'", JSON.stringify(goal));
    const next: AlertHost = restart();
    await send(next, topicKey(other));
    await send(next, topicKey(poll));
    expect(last(socket).goal?.value).toBe(GOAL_PEOPLE_MAX);
    expect(storage.sql.exec("SELECT key FROM goal_people").toArray()).toHaveLength(2);
  });

  it("refuses a body that is not one count, and the controls of the object refuse a count", async (): Promise<void> => {
    await setLayers(withGoal("votes"));
    const socket = await listen();
    for (const body of [
      {},
      { op: "count" },
      { op: "status" },
      { op: "count", key: "" },
      { op: "count", key: "vote:poll:voter-id-1" },
      { op: "count", key: `vote:${poll}` },
      { op: "count", key: `vote:${poll}:voter:id` },
      { op: "count", key: `vote:${poll}:${"v".repeat(129)}` },
      { op: "count", key: `topic:${topic}:voter-id-1` },
      { op: "count", key: `poll:${poll}` },
      { op: "count", key: topicKey(topic), value: 5 },
    ]) {
      const response = await post("goal-count", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid count" });
    }
    expect((await post("goal-count")).status).toBe(400);
    // The count is not a control: the route of the controls refuses it.
    expect(await refused({ op: "count", key: topicKey(topic) })).toEqual([400, null]);
    const read = await ingest.get(ingest.idFromName(page)).fetch(url("goal-count"));
    expect(read.status).toBe(405);
    expect(last(socket).goal?.value).toBe(0);
  });

  it("reads the layers when the object has no copy, and answers 503 while the read fails", async (): Promise<void> => {
    const error = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    state().storage.sql.exec("DELETE FROM alert_state");
    ingest.restart(page);
    await setLayers(withGoal("votes"), false);
    const faulty = faultyDatabase(database.db);
    faulty.fail(/SELECT layers/);
    env.DB = faulty.db;
    const failed = await post("goal-count", { op: "count", key: topicKey(topic) });
    expect(failed.status).toBe(503);
    expect(alertRefusal(await failed.json())).toBe("alerts_unavailable");
    expect(error).toHaveBeenCalledWith("alerts_config_failed", { cause: "Error" });
    faulty.heal();
    expect(await count(topicKey(topic))).toBe(204);
    expect(await run({ op: "status" })).toMatchObject({ goal: { counts: "votes", value: 1 } });
    // The host has a copy now: the next count reads no layers.
    faulty.fail(/SELECT layers/);
    expect(await count(topicKey(other))).toBe(204);
    expect(await run({ op: "status" })).toMatchObject({ goal: { counts: "votes", value: 2 } });
  });

  it("sets the alarm to the next read of the layers after a count, also with no page", async (): Promise<void> => {
    const { host, schedule, sockets } = standalone(withGoal("votes"));
    sockets.length = 0;
    await host.layersChanged();
    vi.setSystemTime(T0 + 1000);
    const request = new Request("https://channel-ingest.internal/goal-count", {
      method: "POST",
      body: JSON.stringify({ op: "count", key: topicKey(topic) }),
    });
    expect((await host.goalCount(request)).status).toBe(204);
    expect(schedule.mock.calls).toEqual([[T0 + LAYER_CHECK_MS]]);
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
    await setLayers(withGoal("subs"));
    const socket = await listen();
    await deliver([gift("g1"), gift("g2")]);
    await run({ op: "skip" });
    await run({ op: "mute", on: true });
    expect(last(socket).goal?.value).toBe(10);
    vi.setSystemTime(T0 + 4000);
    expect((await post("close")).status).toBe(204);
    expect(socket.open).toBe(false);
    expect(lineRows()).toBe(0);
    for (const table of ["alert_state", "alert_counted", "goal_people"])
      expect(state().storage.sql.exec(`SELECT * FROM ${table}`).toArray(), table).toEqual([]);
    const next = await listen();
    expect(last(next)).toMatchObject({ muted: false, current: null, waiting: 0 });
    // The count of the goal starts again too.
    expect(last(next).goal).toEqual({ counts: "subs", value: 0, startedAt: T0 + 4000 });
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
