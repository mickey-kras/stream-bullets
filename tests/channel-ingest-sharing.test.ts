import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import type { ActivityChat } from "../app/lib/activity";
import { ChannelIngest } from "../app/server/channel-ingest";
import { RECONCILE_INTERVAL_MS, YOUTUBE_MIN_POLL_MS } from "../app/server/channel-ingest-limits";
import { requiredSubscriptions } from "../app/server/channel-providers.server";
import { tokenStatement } from "../app/server/channel-tokens.server";
import { installFakeProviders, youtubeText, type FakeProviders, type ProviderCall } from "./helpers/channels";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import { FakeSocket, installWorkersRuntime, RoomNamespace, serverSocketOf, type RoomState } from "./helpers/room";

vi.mock("cloudflare:workers", () => import("./helpers/room"));

/**
 * One provider ingestion for each connected channel (issue #1028): the web tools, the OBS dock and the two OBS
 * outputs share it. More consumers add no poll, no quota unit and no provider subscription.
 */

const origin = "https://sharing.example.test";
const page = "70000000-0000-4000-8000-000000000001";
const tokenKeys = `k1:${btoa(String.fromCodePoint(...new Uint8Array(32).fill(9)))}`;

/** The identity headers that the Worker sets for each consumer of the activity feed. */
const CONSUMERS: Readonly<Record<"owner" | "dock" | "horizontal" | "vertical", Record<string, string>>> = {
  owner: { "X-SB-Owner": "1" },
  dock: { "X-SB-Dock": "1" },
  horizontal: { "X-SB-Overlay": "horizontal" },
  vertical: { "X-SB-Overlay": "vertical" },
};

let database: TestDatabase;
let env: AppEnv;
let fake: FakeProviders;
let ingest: RoomNamespace<ChannelIngest>;
let clock: number;
let messages = 0;

function state(): RoomState {
  return ingest.entry(page).state;
}

function request(path: string, init: RequestInit, query: Record<string, string> = {}): Promise<Response> {
  const search = new URLSearchParams({ streamerId: page, ...query });
  return ingest.get(ingest.idFromName(page)).fetch(`https://channel-ingest.internal/${path}?${search}`, init);
}

async function listen(consumer: keyof typeof CONSUMERS): Promise<FakeSocket> {
  const response = await request("subscribe", { headers: { Upgrade: "websocket", ...CONSUMERS[consumer] } });
  expect(response.status).toBe(101);
  return serverSocketOf(response.webSocket);
}

/** The consumers leave: the runtime no longer lists a closed socket. */
function leave(sockets: readonly FakeSocket[]): void {
  for (const socket of sockets) socket.close();
  state().accepted.splice(0);
}

async function addConnection(platform: "twitch" | "youtube" | "kick"): Promise<void> {
  const id = `conn-${platform}`;
  const externalId = platform === "youtube" ? "UCchannel1" : "111";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO channel_connections
        (id,streamer_id,platform,external_id,display_name,scopes,status,created_at,updated_at)
        VALUES (?,?,?,?,'Host','','active',1,1)`,
    ).bind(id, page, platform, externalId),
    // A token without an expiry needs no refresh, so each period has the same provider requests.
    await tokenStatement(
      env,
      id,
      platform,
      { accessToken: `${platform}-access`, refreshToken: `${platform}-refresh`, expiresAt: null },
      100,
    ),
  ]);
}

/** The quota units of the page, on each quota day that the clock of the test reached. */
async function quotaUnits(): Promise<number> {
  const units = await env.DB.prepare(
    "SELECT sum(count) AS units FROM app_rate_limits WHERE key LIKE 'youtube-quota:%' AND substr(key, -36) = ?",
  )
    .bind(page)
    .first<number>("units");
  return units ?? 0;
}

/**
 * Runs the object for `period` of clock time, as the runtime does: each alarm at its time, consumed before it
 * runs. Each YouTube poll finds one new chat message. Returns the provider requests and the quota units of the period.
 */
async function live(period: number): Promise<{ requests: ProviderCall[]; units: number }> {
  const end = clock + period;
  const from = fake.calls.length;
  const unitsBefore = await quotaUnits();
  for (let alarms = 0; ; alarms++) {
    if (alarms > 1_000) throw new Error("The alarm never stops");
    const due = state().storage.alarm;
    if (due === null || due > end) break;
    clock = Math.max(clock, due);
    const sentAt = new Date(clock).toISOString();
    fake.chatPages = [
      {
        items: [youtubeText(`m${++messages}`, "UCviewer", "hi", {}, sentAt)],
        nextPageToken: `p${messages}`,
        pollingIntervalMillis: 1_000,
      },
    ];
    await state().storage.deleteAlarm();
    await ingest.entry(page).room.alarm();
  }
  clock = end;
  return { requests: fake.calls.slice(from), units: (await quotaUnits()) - unitsBefore };
}

function paths(calls: readonly ProviderCall[]): string[] {
  return calls.map((call: ProviderCall): string => `${call.method} ${call.url.hostname}${call.url.pathname}`);
}

function chatIds(socket: FakeSocket): string[] {
  return socket.ofType<{ event: ActivityChat }>("event").map((message): string => message.event.id);
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  installWorkersRuntime();
  fake = installFakeProviders();
  clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation((): number => clock);
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    POLL_ROOMS: {} as DurableObjectNamespace,
    CHANNEL_INGEST: {} as DurableObjectNamespace,
    REQUEST_LIMITER: {} as RateLimit,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: "x".repeat(40),
    TWITCH_CLIENT_ID: "twitch-client",
    TWITCH_CLIENT_SECRET: "twitch-secret",
    TWITCH_EVENTSUB_SECRET: "eventsub-secret-0123456789abcdef0123",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    KICK_CLIENT_ID: "kick-client",
    KICK_CLIENT_SECRET: "kick-secret",
    CHANNEL_TOKEN_KEYS: tokenKeys,
  };
  ingest = new RoomNamespace(
    (roomState: RoomState) => new ChannelIngest(roomState as unknown as DurableObjectState, env),
  );
  env.CHANNEL_INGEST = ingest as unknown as DurableObjectNamespace;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
    env.DB.prepare(
      "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('owner','O','o@x.test',1,1,1)",
    ),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','host_page','Host')").bind(page),
  ]);
});

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("one provider ingestion for each connected channel", (): void => {
  it("polls YouTube one time for four consumers, and stops when the last one leaves", async (): Promise<void> => {
    const period = 3 * 60_000;
    await addConnection("youtube");
    const owner = await listen("owner");
    // The first minute has the check for a live broadcast and the daily title read.
    await live(60_000);
    const one = await live(period);
    // One consumer: one chat page for each poll interval, at 5 quota units each.
    expect(paths(one.requests)).toEqual(
      Array.from(
        { length: period / YOUTUBE_MIN_POLL_MS },
        (): string => "GET www.googleapis.com/youtube/v3/liveChat/messages",
      ),
    );
    expect(one.units).toBe((period / YOUTUBE_MIN_POLL_MS) * 5);
    // The dock and the two outputs join. No provider request starts and no poll moves.
    const alarmAt = state().storage.alarm;
    const from = fake.calls.length;
    const others = [await listen("dock"), await listen("horizontal"), await listen("vertical")];
    expect(fake.calls).toHaveLength(from);
    expect(state().storage.alarm).toBe(alarmAt);
    // Four consumers: the same provider requests and the same quota units as one.
    const four = await live(period);
    expect(paths(four.requests)).toEqual(paths(one.requests));
    expect(four.units).toBe(one.units);
    // Each consumer gets each message of the one poll loop one time.
    const shared = chatIds(owner).slice(-four.requests.length);
    expect(new Set(shared).size).toBe(period / YOUTUBE_MIN_POLL_MS);
    for (const socket of others) expect(chatIds(socket)).toEqual(shared);
    // The last consumer leaves: the poll loop stops, and the page spends no more quota.
    leave([owner, ...others]);
    const none = await live(period);
    expect(none.requests).toEqual([]);
    expect(none.units).toBe(0);
  });

  it("keeps the provider subscriptions of Twitch and Kick the same for one and for four consumers", async (): Promise<void> => {
    const period = 3 * RECONCILE_INTERVAL_MS;
    for (const platform of ["twitch", "kick"] as const) {
      await addConnection(platform);
      const connect = await request("connect", { method: "POST" }, { platform });
      expect(await connect.json()).toEqual({ status: "active", code: null });
    }
    // The connect made each subscription that the two channels need. Twitch and Kick push: nothing polls.
    const subscriptions = fake.subscriptions.map((item): string => item.id);
    expect(subscriptions).toHaveLength(requiredSubscriptions("twitch").length + requiredSubscriptions("kick").length);
    const owner = await listen("owner");
    const one = await live(period);
    // One consumer: one check of each channel in each interval. A check reads the list of the provider.
    const check = [
      "POST id.twitch.tv/oauth2/token",
      "GET api.twitch.tv/helix/eventsub/subscriptions",
      "GET api.kick.com/public/v1/events/subscriptions",
    ];
    expect(paths(one.requests)).toEqual(Array.from({ length: period / RECONCILE_INTERVAL_MS }, () => check).flat());
    const from = fake.calls.length;
    const others = [await listen("dock"), await listen("horizontal"), await listen("vertical")];
    expect(fake.calls).toHaveLength(from);
    const four = await live(period);
    expect(paths(four.requests)).toEqual(paths(one.requests));
    expect(fake.subscriptions.map((item): string => item.id)).toEqual(subscriptions);
    // Without a consumer the checks stop. The subscriptions stay: the providers still push each event.
    leave([owner, ...others]);
    expect((await live(period)).requests).toEqual([]);
    expect(fake.subscriptions.map((item): string => item.id)).toEqual(subscriptions);
  });
});
