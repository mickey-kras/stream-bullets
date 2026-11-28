import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { AppEnv } from "../app/env";
import { STREAM_TITLE_LENGTH, activityEventSchema, type ActivityStream, type IngestEvent } from "../app/lib/activity";
import { type Connection } from "../app/server/channel-ingest-state";
import { YoutubePoller, type YoutubeHost } from "../app/server/channel-ingest-youtube";
import {
  KICK_LIVE_EVENTS,
  LIVE_SUBSCRIPTIONS,
  TWITCH_LIVE_TYPES,
  kickLiveSignal,
  twitchLiveSignal,
  twitchLiveSubscriptions,
} from "../app/server/channel-live";
import { subscribe } from "../app/server/channel-providers.server";
import { reconcileSubscriptions } from "../app/server/channel-repair.server";
import { requiredSubscriptions, wantedSubscriptions } from "../app/server/channel-subscription-types";
import { installFakeProviders, type FakeProviders } from "./helpers/channels";

/** The live signals of the providers (app/server/channel-live.ts), their optional subscriptions, and the YouTube poll. */

const receivedAt = Date.parse("2026-11-28T10:00:00Z");
const startedAt = "2026-11-28T09:30:00.123Z";

/** A `stream.online` event as Twitch documents it. */
function online(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "9001",
    broadcaster_user_id: "111",
    broadcaster_user_login: "twitchhost",
    broadcaster_user_name: "TwitchHost",
    type,
    started_at: startedAt,
    ...extra,
  };
}

/** A `livestream.status.updated` body as Kick documents it. */
function kickBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    broadcaster: {
      is_anonymous: false,
      user_id: 333,
      username: "KickHost",
      is_verified: false,
      profile_picture: "https://kick.test/avatar.png",
      channel_slug: "kickhost",
      identity: null,
    },
    is_live: true,
    title: "Evening build",
    started_at: "2026-11-28T09:30:00+00:00",
    ended_at: null,
    ...extra,
  };
}

/** Each signal must pass the contract that the ingest object parses a delivery with. */
function valid(signals: readonly ActivityStream[]): readonly ActivityStream[] {
  for (const signal of signals) expect(activityEventSchema.safeParse(signal).success).toBe(true);
  return signals;
}

describe("Twitch live signals", (): void => {
  it("makes a start signal only for a stream of type live, with the start time", (): void => {
    expect(valid(twitchLiveSignal("stream.online", online("live"), receivedAt))).toEqual([
      { kind: "stream", platform: "twitch", live: true, startedAt: Date.parse(startedAt), receivedAt },
    ]);
    for (const type of ["playlist", "watch_party", "premiere", "rerun"])
      expect(twitchLiveSignal("stream.online", online(type), receivedAt)).toEqual([]);
  });

  it("makes a stop signal for stream.offline", (): void => {
    const offline = { broadcaster_user_id: "111", broadcaster_user_login: "twitchhost", broadcaster_user_name: "TwitchHost" };
    expect(valid(twitchLiveSignal("stream.offline", offline, receivedAt))).toEqual([
      { kind: "stream", platform: "twitch", live: false, receivedAt },
    ]);
  });

  it("refuses a malformed payload and the other types", (): void => {
    const malformed: unknown[] = [
      null,
      "live",
      {},
      online("broadcast"),
      online("live", { started_at: "yesterday" }),
      online("live", { started_at: undefined }),
      online("live", { started_at: "1969-12-31T23:59:59Z" }),
      online("live", { broadcaster_user_id: "../111" }),
    ];
    for (const event of malformed) expect(twitchLiveSignal("stream.online", event, receivedAt)).toEqual([]);
    expect(twitchLiveSignal("stream.offline", null, receivedAt)).toEqual([]);
    expect(twitchLiveSignal("stream.offline", { broadcaster_user_login: "twitchhost" }, receivedAt)).toEqual([]);
    expect(twitchLiveSignal("channel.chat.message", online("live"), receivedAt)).toEqual([]);
  });
});

describe("Kick live signals", (): void => {
  it("makes a start and a stop signal from is_live, with the start time and the title", (): void => {
    expect(valid(kickLiveSignal("livestream.status.updated", kickBody(), receivedAt))).toEqual([
      { kind: "stream", platform: "kick", live: true, startedAt: Date.parse("2026-11-28T09:30:00Z"), title: "Evening build", receivedAt },
    ]);
    const ended = kickBody({ is_live: false, ended_at: "2026-11-28T11:00:00+00:00" });
    expect(valid(kickLiveSignal("livestream.status.updated", ended, receivedAt))).toEqual([
      { kind: "stream", platform: "kick", live: false, startedAt: Date.parse("2026-11-28T09:30:00Z"), title: "Evening build", receivedAt },
    ]);
  });

  it("cuts the title to the contract length without control characters, and leaves out an empty title", (): void => {
    const [long] = valid(kickLiveSignal("livestream.status.updated", kickBody({ title: `‮${"a".repeat(300)}` }), receivedAt));
    expect(long.title).toBe("a".repeat(STREAM_TITLE_LENGTH));
    const [empty] = valid(kickLiveSignal("livestream.status.updated", kickBody({ title: "" }), receivedAt));
    expect(empty).not.toHaveProperty("title");
  });

  it("refuses a malformed payload and the other events", (): void => {
    const malformed: unknown[] = [
      null,
      {},
      kickBody({ is_live: "yes" }),
      kickBody({ title: undefined }),
      kickBody({ title: "x".repeat(2001) }),
      kickBody({ started_at: "soon" }),
      kickBody({ ended_at: undefined }),
      kickBody({ broadcaster: undefined }),
    ];
    for (const body of malformed) expect(kickLiveSignal("livestream.status.updated", body, receivedAt)).toEqual([]);
    expect(kickLiveSignal("chat.message.sent", kickBody(), receivedAt)).toEqual([]);
  });
});

describe("live subscriptions", (): void => {
  const env = {
    APP_ORIGIN: "https://app.test",
    TWITCH_CLIENT_ID: "twitch-client",
    TWITCH_CLIENT_SECRET: "twitch-secret",
    TWITCH_EVENTSUB_SECRET: "eventsub-secret-0123456789abcdef0123",
    KICK_CLIENT_ID: "kick-client",
    KICK_CLIENT_SECRET: "kick-secret",
  } as AppEnv;
  let fake: FakeProviders;
  let warn: MockInstance<typeof console.warn>;

  beforeEach((): void => {
    fake = installFakeProviders();
    warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
  });

  afterEach((): void => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function types(platform: "twitch" | "kick"): string[] {
    return fake.subscriptions.filter((item) => item.platform === platform).map((item) => item.type ?? "");
  }

  function refusals(): unknown[][] {
    return warn.mock.calls.filter((call: unknown[]) => call[0] === "channel_live_refused");
  }

  it("asks for stream.online and stream.offline with the broadcaster, and Kick for its status event", (): void => {
    expect(twitchLiveSubscriptions("111")).toEqual([
      { type: "stream.online", version: "1", condition: { broadcaster_user_id: "111" } },
      { type: "stream.offline", version: "1", condition: { broadcaster_user_id: "111" } },
    ]);
    expect(LIVE_SUBSCRIPTIONS).toEqual({ twitch: TWITCH_LIVE_TYPES, youtube: [], kick: KICK_LIVE_EVENTS });
    expect(KICK_LIVE_EVENTS).toEqual(["livestream.status.updated"]);
  });

  it("needs no live type for a healthy channel, but a repair wants each one", (): void => {
    for (const platform of ["twitch", "youtube", "kick"] as const)
      for (const support of [true, false]) {
        const required = requiredSubscriptions(platform, support);
        expect(required.filter((type: string) => LIVE_SUBSCRIPTIONS[platform].includes(type))).toEqual([]);
        expect(wantedSubscriptions(platform, support)).toEqual([...required, ...LIVE_SUBSCRIPTIONS[platform]]);
      }
  });

  it("keeps chat and support when Twitch refuses a live type, and logs only the platform and the type", async (): Promise<void> => {
    fake.liveStatus = 403;
    const created: string[] = [];
    const scope = { only: null, support: true };
    expect(await subscribe(env, "twitch", "111", null, env.APP_ORIGIN, created, scope)).toEqual({ conflicts: [], refused: false });
    expect(created).toHaveLength(11);
    expect(types("twitch").filter((type: string) => TWITCH_LIVE_TYPES.includes(type))).toEqual([]);
    expect(refusals()).toEqual([
      ["channel_live_refused", { platform: "twitch", type: "stream.online" }],
      ["channel_live_refused", { platform: "twitch", type: "stream.offline" }],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/111|token|TwitchHost/);
  });

  it("keeps chat and support when Kick refuses the live event, with no new authorization", async (): Promise<void> => {
    for (const status of [401, 403]) {
      fake.subscriptions.length = 0;
      warn.mockClear();
      fake.liveStatus = status;
      const created: string[] = [];
      const scope = { only: null, support: true };
      expect(await subscribe(env, "kick", "333", "kick-token", env.APP_ORIGIN, created, scope)).toEqual({ conflicts: [], refused: false });
      expect(created).toHaveLength(7);
      expect(types("kick")).not.toContain("livestream.status.updated");
      expect(refusals()).toEqual([["channel_live_refused", { platform: "kick", type: "livestream.status.updated" }]]);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/333|kick-token|KickHost/);
    }
  });

  it("asks a repair for a missing live type again, and a refusal of it is no failure", async (): Promise<void> => {
    for (const [index, type] of requiredSubscriptions("twitch", false).entries())
      fake.subscriptions.push({ platform: "twitch", id: `sub-${index}`, broadcaster: "111", callback: `${env.APP_ORIGIN}/hooks/twitch`, type });
    fake.liveStatus = 403;
    const refused = await reconcileSubscriptions(env, "twitch", "111", null, false);
    expect(refused).toMatchObject({ changed: false, failure: null, supportRefused: false });
    expect(refused.ids).toHaveLength(5);
    const asked = fake.calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/subscriptions"));
    expect(asked.map((call) => (JSON.parse(call.body) as { type: string }).type)).toEqual(["stream.online", "stream.offline"]);
    expect(refusals()).toHaveLength(2);
    // The provider takes the live types later: the next check makes them.
    fake.liveStatus = null;
    const repaired = await reconcileSubscriptions(env, "twitch", "111", null, false);
    expect(repaired).toMatchObject({ changed: true, failure: null, supportRefused: false });
    expect(types("twitch").slice(-2)).toEqual(["stream.online", "stream.offline"]);
  });
});

describe("YouTube live signals", (): void => {
  const connection: Connection = {
    id: "conn-youtube",
    externalId: "UCchannel1",
    status: "active",
    code: null,
    lastEventAt: null,
    suspended: false,
    support: false,
  };
  /** The quota rows: each spend succeeds. */
  const quotaDb = { prepare: () => ({ bind: () => ({ first: () => Promise.resolve({ count: 1 }) }) }) } as unknown as D1Database;
  let fake: FakeProviders;
  let signals: ActivityStream[];
  let youtube: YoutubePoller;
  let now: number;

  beforeEach((): void => {
    fake = installFakeProviders();
    signals = [];
    now = receivedAt;
    const stored = new Map<string, unknown>();
    const host: YoutubeHost = {
      env: { DB: quotaDb } as AppEnv,
      storage: {
        get: (key: string): Promise<unknown> => Promise.resolve(stored.get(key)),
        put: (key: string, value: unknown): Promise<void> => {
          stored.set(key, value);
          return Promise.resolve();
        },
      } as unknown as YoutubeHost["storage"],
      streamerId: () => "50000000-0000-4000-8000-000000000001",
      listening: () => true,
      connection: () => Promise.resolve(connection),
      setStatus: () => Promise.resolve(),
      freshTokens: () => Promise.resolve({ accessToken: "youtube-access", refreshToken: null, expiresAt: null, keyId: "k1", updatedAt: 1 }),
      generation: () => 1,
      schedule: () => Promise.resolve(),
      touch: () => Promise.resolve(),
      alertsReady: () => Promise.resolve(true),
      ingest: (events: readonly IngestEvent[]): void => {
        for (const event of events) if (event.kind === "stream") signals.push(event);
      },
    };
    youtube = new YoutubePoller(host);
  });

  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  /** One poll an hour later, so no wait of the poller holds it. */
  async function poll(): Promise<void> {
    now += 3_600_000;
    await youtube.poll(now);
  }

  function signal(live: boolean): ActivityStream {
    return { kind: "stream", platform: "youtube", live, receivedAt: now };
  }

  it("sends a signal only when the broadcast state changes, not for each poll", async (): Promise<void> => {
    await youtube.connected(now);
    await poll();
    expect(signals).toEqual([signal(true)]);
    // The chat polls of a live stream, and a chat that goes offline, send nothing.
    await poll();
    fake.chatPages = [{ items: [], offlineAt: "2026-11-28T12:00:00Z" }];
    await poll();
    expect(signals).toHaveLength(1);
    // The next poll finds no active broadcast: the stream stopped. A later poll that finds none again sends nothing.
    fake.liveChatId = null;
    await poll();
    expect(signals.at(-1)).toEqual(signal(false));
    await poll();
    expect(signals).toHaveLength(2);
  });

  it("keeps the live state across a reconnect, and lets the broadcast decide after a chat that ended", async (): Promise<void> => {
    vi.spyOn(console, "error").mockImplementation((): void => undefined);
    await youtube.connected(now);
    await poll();
    expect(signals).toEqual([signal(true)]);
    // A reconnect during the stream forgets the chat, but not that the stream is live.
    await youtube.connected(now);
    await poll();
    expect(signals).toHaveLength(1);
    fake.chatError = "liveChatEnded";
    await poll();
    expect(signals).toHaveLength(1);
    fake.chatError = null;
    fake.liveChatId = null;
    await poll();
    expect(signals.map((item: ActivityStream): boolean => item.live)).toEqual([true, false]);
    expect(signals.at(-1)).toEqual(signal(false));
  });
});
