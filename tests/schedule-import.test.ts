import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import { quotaDay } from "../app/lib/activity";
import { ChannelIngest } from "../app/server/channel-ingest";
import { YOUTUBE_DAILY_BUDGET } from "../app/server/channel-ingest-limits";
import { IMPORT_HORIZON_MS, YOUTUBE_UPCOMING_PAGES } from "../app/server/channel-providers.server";
import { tokenStatement } from "../app/server/channel-tokens.server";
import { deleteEvent, listEvents, MAX_UPCOMING_EVENTS, patchEvent } from "../app/server/schedule.server";
import {
  CRON_PAGES,
  importOnVisit,
  importPageSchedule,
  importSchedules,
  OWNER_READ_INTERVAL_MS,
  sameStream,
  SOURCE_RETENTION_MS,
  syncPlatform,
  testStreams,
} from "../app/server/schedule-import.server";
import type { StreamEvent } from "../app/types";
import { installFakeProviders, type FakeProviders } from "./helpers/channels";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import { installWorkersRuntime, RoomNamespace, type RoomState } from "./helpers/room";

vi.mock("cloudflare:workers", () => import("./helpers/room"));

const page = "50000000-0000-4000-8000-000000000001";
const otherPage = "50000000-0000-4000-8000-000000000002";
const tokenKeys = `k1:${btoa(String.fromCodePoint(...new Uint8Array(32).fill(9)))}`;
const hour = 3_600_000;
const day = 24 * hour;

let database: TestDatabase;
let env: AppEnv;
let fake: FakeProviders;
let now: number;

function iso(time: number): string {
  return new Date(time).toISOString();
}

function segment(id: string, title: string, start: number, options: { end?: number | null; canceled?: boolean } = {}): unknown {
  const end = options.end === undefined ? start + 2 * hour : options.end;
  return {
    id,
    start_time: iso(start),
    end_time: end === null ? null : iso(end),
    title,
    canceled_until: options.canceled ? iso(end ?? start) : null,
    category: { id: "509658", name: "Just Chatting" },
    is_recurring: false,
  };
}

function schedule(segments: unknown[], cursor?: string, vacation: unknown = null): unknown {
  return {
    data: {
      segments,
      broadcaster_id: "111",
      broadcaster_name: "TwitchHost",
      broadcaster_login: "TwitchHost",
      vacation,
    },
    pagination: cursor ? { cursor } : {},
  };
}

function broadcast(id: string, title: string, start: number, privacy = "public", end?: number): unknown {
  return {
    id,
    snippet: {
      title,
      scheduledStartTime: iso(start),
      ...(end === undefined ? {} : { scheduledEndTime: iso(end) }),
    },
    status: { privacyStatus: privacy, lifeCycleStatus: "ready" },
  };
}

/** Manual entries far after the import horizon that fill the page's upcoming schedule. */
function fillers(count: number): D1PreparedStatement[] {
  return Array.from({ length: count }, (_, index: number) =>
    env.DB.prepare(`INSERT INTO stream_events (id,streamer_id,title,starts_at,duration_min,platform,url,tz,created_at,updated_at)
      VALUES (?,?,'Filler',?,60,'other','https://example.test/','UTC',1,1)`).bind(crypto.randomUUID(), page, now + 40 * day + index * hour),
  );
}

async function addConnection(
  platform: "twitch" | "youtube" | "kick",
  streamerId = page,
  options: { status?: string; externalId?: string } = {},
): Promise<void> {
  const id = `conn-${platform}-${streamerId.slice(-1)}`;
  const external = options.externalId ?? (platform === "youtube" ? `UCchannel${streamerId.slice(-1)}` : `11${streamerId.slice(-1)}`);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,status,created_at,updated_at)
        VALUES (?,?,?,?,'Host','',?,1,1)`,
    ).bind(id, streamerId, platform, external, options.status ?? "active"),
    await tokenStatement(
      env,
      id,
      platform,
      { accessToken: `${platform}-stored-access`, refreshToken: `${platform}-stored-refresh`, expiresAt: Date.now() + hour },
      100,
    ),
  ]);
}

async function events(streamerId = page): Promise<StreamEvent[]> {
  return listEvents(env, streamerId, now - 30 * day, now + 60 * day, now);
}

async function imported(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT imported FROM stream_events WHERE id=?").bind(id).first<{ imported: number }>();
  return row?.imported ?? -1;
}

function providerCalls(path: string): number {
  return fake.calls.filter((call) => `${call.url.hostname}${call.url.pathname}` === path).length;
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  installWorkersRuntime();
  fake = installFakeProviders();
  now = Date.now();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    POLL_ROOMS: {} as DurableObjectNamespace,
    CHANNEL_INGEST: {} as DurableObjectNamespace,
    REQUEST_LIMITER: {} as RateLimit,
    APP_ORIGIN: "https://app.example.test",
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
  const ingest = new RoomNamespace((state: RoomState) => new ChannelIngest(state as unknown as DurableObjectState, env));
  env.CHANNEL_INGEST = ingest as unknown as DurableObjectNamespace;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
    env.DB.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('owner','O','o@x.test',1,1,1)"),
    env.DB.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('owner2','P','p@x.test',1,1,1)"),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','host_page','Host')").bind(page),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner2','other_page','Other')").bind(otherPage),
  ]);
});

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the match rule", (): void => {
  it("joins streams at most 15 minutes apart, whatever their titles", (): void => {
    const start = Date.UTC(2026, 11, 1, 18);
    expect(sameStream({ startsAt: start }, { startsAt: start + 15 * 60_000 })).toBe(true);
    expect(sameStream({ startsAt: start }, { startsAt: start - 15 * 60_000 })).toBe(true);
    expect(sameStream({ startsAt: start }, { startsAt: start + 16 * 60_000 })).toBe(false);
  });
});

describe("reading the platforms", (): void => {
  it("reads Twitch with the app token for 4 weeks, without cancelled segments, over pages", async (): Promise<void> => {
    await addConnection("twitch");
    fake.twitchSchedule = [
      schedule(
        [
          segment("s1", "Morning show", now + 2 * day),
          segment("s2", "Cancelled one", now + 3 * day, { canceled: true }),
          segment("s3", "", now + 4 * day, { end: null }),
        ],
        "1",
      ),
      schedule([segment("s4", "Late", now + 5 * day, { end: now + 5 * day + 10 * 60_000 }), segment("s5", "Too far", now + IMPORT_HORIZON_MS + day)]),
    ];
    await importPageSchedule(env, page, now);
    const list = await events();
    expect(list.map((event: StreamEvent) => [event.title, event.durationMin, event.platform, event.url])).toEqual([
      ["Morning show", 120, "twitch", "https://www.twitch.tv/twitchhost"],
      // An empty title takes the category; a segment without an end gets the default length.
      ["Just Chatting", 120, "twitch", "https://www.twitch.tv/twitchhost"],
      // A segment shorter than 15 minutes is stored as 15 minutes.
      ["Late", 15, "twitch", "https://www.twitch.tv/twitchhost"],
    ]);
    const call = fake.calls.find((item) => item.url.pathname === "/helix/schedule");
    expect(call?.headers.get("Authorization")).toBe("Bearer twitch-app-token");
    expect(call?.url.searchParams.get("broadcaster_id")).toBe("111");
    expect(call?.url.searchParams.get("first")).toBe("25");
    expect(providerCalls("api.twitch.tv/helix/schedule")).toBe(2);
  });

  it("reads only public YouTube broadcasts with a planned start, and spends one quota unit", async (): Promise<void> => {
    await addConnection("youtube");
    fake.upcoming = [
      broadcast("vid-1", "Q&A", now + day, "public", now + day + 90 * 60_000),
      broadcast("vid-2", "Private test", now + day, "private"),
      broadcast("vid-3", "Unlisted", now + day, "unlisted"),
      { id: "vid-4", snippet: { title: "No time" }, status: { privacyStatus: "public" } },
      broadcast("vid-5", "Too far", now + IMPORT_HORIZON_MS + day),
    ];
    await importPageSchedule(env, page, now);
    const list = await events();
    expect(list.map((event: StreamEvent) => [event.title, event.durationMin, event.platform, event.url])).toEqual([
      ["Q&A", 90, "youtube", "https://www.youtube.com/watch?v=vid-1"],
    ]);
    const call = fake.calls.find((item) => item.url.pathname === "/youtube/v3/liveBroadcasts");
    expect(call?.url.searchParams.get("broadcastStatus")).toBe("upcoming");
    expect(call?.url.searchParams.get("part")).toBe("id,snippet,status");
    expect(call?.headers.get("Authorization")).toBe("Bearer youtube-stored-access");
    const quota = await env.DB.prepare("SELECT count FROM app_rate_limits WHERE key=?")
      .bind(`youtube-quota:${quotaDay(now).day}:${page}`)
      .first<{ count: number }>();
    expect(quota?.count).toBe(1);
  });

  it("accepts the Base64 segment IDs that Twitch gives", async (): Promise<void> => {
    await addConnection("twitch");
    // The form of the ID in the Twitch reference: Base64 of 108 characters, with `=` at the end.
    const id = btoa(JSON.stringify({ segmentID: "e4acc724-371f-402c-81ca-23ada79759d4", isoYear: 2021, isoWeek: 26 }));
    expect(id).toMatch(/=$/);
    fake.twitchSchedule = [schedule([segment(id, "Show", now + 2 * day)])];
    await importPageSchedule(env, page, now);
    expect((await events()).map((event: StreamEvent) => event.title)).toEqual(["Show"]);
    const source = await env.DB.prepare("SELECT external_id FROM stream_event_sources").first<{ external_id: string }>();
    expect(source?.external_id).toBe(id);
  });

  it("leaves out Twitch segments in the vacation of the channel", async (): Promise<void> => {
    await addConnection("twitch");
    const vacation = { start_time: iso(now + 3 * day), end_time: iso(now + 10 * day) };
    fake.twitchSchedule = [
      schedule(
        [segment("s1", "Before", now + 2 * day), segment("s2", "Away", now + 4 * day), segment("s3", "Back", now + 11 * day)],
        undefined,
        vacation,
      ),
    ];
    await importPageSchedule(env, page, now);
    expect((await events()).map((event: StreamEvent) => event.title)).toEqual(["Before", "Back"]);
  });

  it("removes nothing after a Twitch read with more pages than the import reads", async (): Promise<void> => {
    await addConnection("twitch");
    fake.twitchSchedule = [schedule([segment("s1", "Show", now + 2 * day)])];
    await importPageSchedule(env, page, now);
    // Each page has a cursor and no segment past the horizon: page 5 can hold "Show".
    fake.twitchSchedule = Array.from({ length: 5 }, (_, index: number) =>
      schedule([segment(`other-${index}`, "Other", now + day + index * hour)], String(index + 1)),
    );
    await importPageSchedule(env, page, now + 60_000);
    expect((await events()).map((event: StreamEvent) => event.title)).toEqual(["Show"]);
  });

  it("reads each page of YouTube broadcasts, one quota unit for each", async (): Promise<void> => {
    await addConnection("youtube");
    // 50 private broadcasts fill the first page; the public one is on the second.
    fake.upcoming = [
      ...Array.from({ length: 50 }, (_, index: number) => broadcast(`priv-${index}`, "Private", now + day, "private")),
      broadcast("vid-late", "Second page", now + 2 * day),
    ];
    await importPageSchedule(env, page, now);
    expect((await events()).map((event: StreamEvent) => event.title)).toEqual(["Second page"]);
    const pages = fake.calls.filter((item) => item.url.pathname === "/youtube/v3/liveBroadcasts");
    expect(pages.map((item) => item.url.searchParams.get("pageToken"))).toEqual([null, "50"]);
    const quota = await env.DB.prepare("SELECT count FROM app_rate_limits WHERE key=?")
      .bind(`youtube-quota:${quotaDay(now).day}:${page}`)
      .first<{ count: number }>();
    expect(quota?.count).toBe(2);
  });

  it("removes nothing after an incomplete YouTube read", async (): Promise<void> => {
    await addConnection("youtube");
    fake.upcoming = [broadcast("vid-1", "Show", now + 2 * day)];
    await importPageSchedule(env, page, now);
    // More pages than the import reads: the read is not complete, so "Show" is not known to be gone.
    fake.upcoming = Array.from({ length: 50 * YOUTUBE_UPCOMING_PAGES + 1 }, (_, index: number) =>
      broadcast(`priv-${index}`, "Private", now + day, "private"),
    );
    await importPageSchedule(env, page, now + 60_000);
    expect((await events()).map((event: StreamEvent) => event.title)).toEqual(["Show"]);
    // Quota for the first page only: the same.
    fake.upcoming = Array.from({ length: 51 }, (_, index: number) => broadcast(`priv-${index}`, "Private", now + day, "private"));
    await env.DB.prepare("UPDATE app_rate_limits SET count=? WHERE key=?")
      .bind(YOUTUBE_DAILY_BUDGET - 1, `youtube-quota:${quotaDay(now).day}`)
      .run();
    await importPageSchedule(env, page, now + 120_000);
    expect((await events()).map((event: StreamEvent) => event.title)).toEqual(["Show"]);
  });

  it("treats a Twitch channel without a schedule as an empty schedule", async (): Promise<void> => {
    await addConnection("twitch");
    fake.twitchSchedule = [schedule([segment("s1", "Show", now + 2 * day)])];
    await importPageSchedule(env, page, now);
    fake.twitchSchedule = 404;
    await importPageSchedule(env, page, now + 60_000);
    expect(await events()).toEqual([]);
  });

  it("does not read Kick, a channel that needs a new authorization, or a page without channels", async (): Promise<void> => {
    await addConnection("kick");
    await addConnection("twitch", page, { status: "needs_reauth" });
    await importPageSchedule(env, page, now);
    await importPageSchedule(env, otherPage, now);
    expect(fake.calls).toEqual([]);
  });
});

describe("one entry for one stream", (): void => {
  beforeEach(async (): Promise<void> => {
    await addConnection("twitch");
    await addConnection("youtube");
  });

  it("shows the same stream on two platforms as one entry with both links, also with different titles", async (): Promise<void> => {
    fake.twitchSchedule = [schedule([segment("s1", "Friday Stream", now + 2 * day), segment("s2", "Solo", now + 3 * day)])];
    fake.upcoming = [
      broadcast("vid-1", "Friday stream (part 5)", now + 2 * day + 10 * 60_000),
      // A start 20 minutes apart is another stream.
      broadcast("vid-2", "Solo", now + 3 * day + 20 * 60_000),
    ];
    await importPageSchedule(env, page, now);
    const list = await events();
    expect(list.map((event: StreamEvent) => [event.title, event.platform, event.alsoOn])).toEqual([
      ["Friday Stream", "twitch", [{ platform: "youtube", url: "https://www.youtube.com/watch?v=vid-1" }]],
      ["Solo", "twitch", []],
      ["Solo", "youtube", []],
    ]);
  });

  it("updates an entry on a new read and never adds a second one", async (): Promise<void> => {
    fake.twitchSchedule = [schedule([segment("s1", "Show", now + 2 * day)])];
    fake.upcoming = [broadcast("vid-1", "Show", now + 2 * day)];
    await importPageSchedule(env, page, now);
    fake.twitchSchedule = [schedule([segment("s1", "Show, new title", now + 2 * day + hour, { end: now + 2 * day + 4 * hour })])];
    await importPageSchedule(env, page, now + 60_000);
    const list = await events();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "Show, new title", startsAt: now + 2 * day + hour, durationMin: 180 });
    // The YouTube link stays with the entry: only the platform that created it changes it.
    expect(list[0].alsoOn).toEqual([{ platform: "youtube", url: "https://www.youtube.com/watch?v=vid-1" }]);
  });

  it("keeps a manual entry as it is and links the stream to it", async (): Promise<void> => {
    const manual = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO stream_events (id,streamer_id,title,notes,starts_at,duration_min,platform,url,tz,
        created_at,updated_at) VALUES (?,?,'Big Show','Mine',?,60,'kick','https://kick.com/host','Europe/Berlin',1,1)`)
      .bind(manual, page, now + 2 * day)
      .run();
    fake.twitchSchedule = [schedule([segment("s1", "big show", now + 2 * day + 5 * 60_000)])];
    await importPageSchedule(env, page, now);
    fake.twitchSchedule = [schedule([segment("s1", "big show", now + 2 * day + 9 * 60_000)])];
    await importPageSchedule(env, page, now + 60_000);
    const list = await events();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: manual, title: "Big Show", notes: "Mine", platform: "kick", durationMin: 60 });
    expect(list[0].alsoOn).toEqual([{ platform: "twitch", url: "https://www.twitch.tv/twitchhost" }]);
    // The stream left Twitch: the manual entry stays and loses only the link.
    fake.twitchSchedule = 404;
    await importPageSchedule(env, page, now + 120_000);
    expect((await events()).map((event: StreamEvent) => [event.id, event.alsoOn])).toEqual([[manual, []]]);
  });

  it("keeps an entry that the owner edited, also when the platform removes the stream", async (): Promise<void> => {
    fake.twitchSchedule = [schedule([segment("s1", "Show", now + 2 * day), segment("s2", "Other", now + 3 * day)])];
    await importPageSchedule(env, page, now);
    const [first] = await events();
    expect(await imported(first.id)).toBe(1);
    const date = new Date(first.startsAt).toISOString().slice(0, 10);
    const time = new Date(first.startsAt).toISOString().slice(11, 16);
    await patchEvent(env, "owner", first.id, {
      action: "edit",
      scope: "one",
      title: "My title",
      notes: "",
      date,
      time,
      tz: "UTC",
      durationMin: 60,
      platform: "twitch",
      url: "https://www.twitch.tv/twitchhost",
      repeatDays: 0,
      repeatUntil: null,
      topicIds: [],
    });
    expect(await imported(first.id)).toBe(0);
    fake.twitchSchedule = [schedule([segment("s1", "Twitch title", now + 2 * day + hour), segment("s2", "Other", now + 3 * day)])];
    await importPageSchedule(env, page, now + 60_000);
    expect((await events())[0]).toMatchObject({ id: first.id, title: "My title", durationMin: 60 });
    // A cancel on the platform removes the imported entry, not the edited one.
    fake.twitchSchedule = [schedule([segment("s2", "Other", now + 3 * day, { canceled: true })])];
    await importPageSchedule(env, page, now + 120_000);
    expect((await events()).map((event: StreamEvent) => event.title)).toEqual(["My title"]);
  });

  it("removes a cancelled stream, keeps one that starts within the hour, and does not add a deleted one again", async (): Promise<void> => {
    fake.twitchSchedule = [
      schedule([segment("soon", "Soon", now + 30 * 60_000), segment("s1", "Show", now + 2 * day), segment("s2", "Gone", now + 3 * day)]),
    ];
    await importPageSchedule(env, page, now);
    const list = await events();
    expect(list.map((event: StreamEvent) => event.title)).toEqual(["Soon", "Show", "Gone"]);
    await deleteEvent(env, "owner", list[1].id, {});
    fake.twitchSchedule = [schedule([segment("s1", "Show", now + 2 * day)])];
    await importPageSchedule(env, page, now + 60_000);
    // "Soon" can be live already; "Gone" was cancelled; "Show" was deleted by the owner.
    expect((await events()).map((event: StreamEvent) => event.title)).toEqual(["Soon"]);
  });

  it("changes nothing when a platform read fails", async (): Promise<void> => {
    fake.twitchSchedule = [schedule([segment("s1", "Show", now + 2 * day)])];
    fake.upcoming = [broadcast("vid-9", "Tube", now + 4 * day)];
    await importPageSchedule(env, page, now);
    const before = await events();
    fake.twitchSchedule = 500;
    fake.upcoming = 403;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await importPageSchedule(env, page, now + 60_000);
    expect(await events()).toEqual(before);
    expect(warn).toHaveBeenCalledWith("schedule_read_failed", { platform: "twitch", cause: "Error" });
  });

  it("marks a refused YouTube authorization and changes nothing", async (): Promise<void> => {
    fake.upcoming = [broadcast("vid-9", "Tube", now + 4 * day)];
    await importPageSchedule(env, page, now);
    fake.upcoming = 401;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await importPageSchedule(env, page, now + 60_000);
    expect((await events()).map((event: StreamEvent) => event.title)).toEqual(["Tube"]);
    const row = await env.DB.prepare("SELECT status FROM channel_connections WHERE platform='youtube'").first<{ status: string }>();
    expect(row?.status).toBe("needs_reauth");
  });

  it("adds no entry to a full schedule", async (): Promise<void> => {
    await env.DB.batch(fillers(MAX_UPCOMING_EVENTS));
    fake.twitchSchedule = [schedule([segment("s1", "Show", now + 2 * day)])];
    await importPageSchedule(env, page, now);
    const count = await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE streamer_id=? AND title='Show'")
      .bind(page)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("keeps a past entry in the past when a full schedule has no room for its new start", async (): Promise<void> => {
    fake.twitchSchedule = [schedule([segment("s1", "Show", now - 2 * hour)])];
    await importPageSchedule(env, page, now);
    await env.DB.batch(fillers(MAX_UPCOMING_EVENTS));
    fake.twitchSchedule = [schedule([segment("s1", "Show", now + 2 * day)])];
    await importPageSchedule(env, page, now + 60_000);
    const show = await env.DB.prepare("SELECT starts_at FROM stream_events WHERE title='Show'").first<{ starts_at: number }>();
    expect(show?.starts_at).toBe(now - 2 * hour);
  });

  it("rolls the import back when a parallel write filled the schedule", async (): Promise<void> => {
    let calls = 0;
    // The first batch reads the sources and the room; before the second one writes, another write fills the page.
    const racing = Object.assign(Object.create(env.DB) as D1Database, {
      batch: async (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
        calls += 1;
        if (calls === 2) await env.DB.batch(fillers(MAX_UPCOMING_EVENTS));
        return env.DB.batch(statements);
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stream = { externalId: "s1", title: "Show", startsAt: now + 2 * day, durationMin: 60, url: "https://www.twitch.tv/host" };
    expect(await syncPlatform({ ...env, DB: racing }, page, "twitch", [stream], now)).toBe(false);
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledWith("schedule_import_full", { platform: "twitch" });
    const count = await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE title='Show'").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe("isolation between pages", (): void => {
  it("reads each page's own channels and joins only entries of the same page", async (): Promise<void> => {
    await addConnection("twitch");
    await addConnection("twitch", otherPage);
    const theirs = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO stream_events (id,streamer_id,title,starts_at,duration_min,platform,url,tz,created_at,updated_at)
        VALUES (?,?,'Show',?,60,'kick','https://kick.com/other','UTC',1,1)`)
      .bind(theirs, otherPage, now + 2 * day)
      .run();
    fake.twitchSchedule = [schedule([segment("s1", "Show", now + 2 * day)])];
    await importPageSchedule(env, page, now);
    const mine = await events(page);
    expect(mine.map((event: StreamEvent) => [event.title, event.platform])).toEqual([["Show", "twitch"]]);
    expect((await events(otherPage)).map((event: StreamEvent) => [event.id, event.alsoOn])).toEqual([[theirs, []]]);
    const broadcasters = fake.calls
      .filter((call) => call.url.pathname === "/helix/schedule")
      .map((call) => call.url.searchParams.get("broadcaster_id"));
    expect(broadcasters).toEqual(["111"]);
    // The other page's read of the same segment id makes its own entry and leaves this page alone.
    await importPageSchedule(env, otherPage, now);
    expect((await events(page)).map((event: StreamEvent) => event.id)).toEqual(mine.map((event: StreamEvent) => event.id));
    expect((await events(otherPage)).map((event: StreamEvent) => [event.id, event.alsoOn.length])).toEqual([[theirs, 1]]);
  });
});

describe("when the import runs", (): void => {
  it("reads on the owner's visit at most each 10 minutes", async (): Promise<void> => {
    await addConnection("twitch");
    fake.twitchSchedule = [schedule([segment("s1", "Show", now + 2 * day)])];
    await importOnVisit(env, page, now);
    await importOnVisit(env, page, now + OWNER_READ_INTERVAL_MS - 1);
    expect(providerCalls("api.twitch.tv/helix/schedule")).toBe(1);
    await importOnVisit(env, page, now + OWNER_READ_INTERVAL_MS);
    expect(providerCalls("api.twitch.tv/helix/schedule")).toBe(2);
    // A page without a channel reads nothing.
    await importOnVisit(env, otherPage, now);
    expect(providerCalls("api.twitch.tv/helix/schedule")).toBe(2);
  });

  it("does not read when channels are off", async (): Promise<void> => {
    await addConnection("twitch");
    env.CHANNELS_OFF = "1";
    await importOnVisit(env, page, now);
    expect(await importSchedules(env, now)).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("reads the pages with channels each 6 hours in the hourly job", async (): Promise<void> => {
    await addConnection("twitch");
    await addConnection("youtube", otherPage);
    fake.twitchSchedule = [schedule([segment("s1", "Show", now + 2 * day)])];
    expect(await importSchedules(env, now)).toBe(2);
    expect(await importSchedules(env, now + hour)).toBe(0);
    expect(await importSchedules(env, now + 6 * hour)).toBe(2);
    expect(CRON_PAGES).toBeGreaterThan(0);
    expect((await events()).map((event: StreamEvent) => event.title)).toEqual(["Show"]);
  });

  it("deletes YouTube data that no read found for 30 days, and keeps Twitch history", async (): Promise<void> => {
    await addConnection("twitch");
    await addConnection("youtube");
    fake.twitchSchedule = [schedule([segment("s1", "Twitch show", now + 2 * day)])];
    fake.upcoming = [broadcast("vid-1", "Tube show", now + 3 * day)];
    await importPageSchedule(env, page, now);
    await env.DB.prepare("DELETE FROM channel_connections").run();
    expect(await importSchedules(env, now + SOURCE_RETENTION_MS)).toBe(0);
    expect((await events()).map((event: StreamEvent) => event.title)).toEqual(["Twitch show", "Tube show"]);
    await importSchedules(env, now + SOURCE_RETENTION_MS + 1);
    expect((await events()).map((event: StreamEvent) => event.title)).toEqual(["Twitch show"]);
    const sources = await env.DB.prepare("SELECT platform FROM stream_event_sources").all<{ platform: string }>();
    expect(sources.results).toEqual([{ platform: "twitch" }]);
  });

  it("keeps an entry that Twitch also holds when its YouTube data expires", async (): Promise<void> => {
    await addConnection("twitch");
    await addConnection("youtube");
    fake.twitchSchedule = [schedule([segment("s1", "Same show", now + 2 * day)])];
    fake.upcoming = [broadcast("vid-1", "Same show", now + 2 * day)];
    await importPageSchedule(env, page, now);
    expect((await events()).map((event: StreamEvent) => event.alsoOn.length)).toEqual([1]);
    await env.DB.prepare("DELETE FROM channel_connections").run();
    await importSchedules(env, now + SOURCE_RETENTION_MS + 1);
    const list = await events();
    expect(list.map((event: StreamEvent) => [event.title, event.platform, event.alsoOn.length])).toEqual([["Same show", "twitch", 0]]);
    const sources = await env.DB.prepare("SELECT platform FROM stream_event_sources").all<{ platform: string }>();
    expect(sources.results).toEqual([{ platform: "twitch" }]);
  });

  it("gives an entry from YouTube the Twitch link when its YouTube data expires", async (): Promise<void> => {
    await addConnection("youtube");
    fake.upcoming = [broadcast("vid-1", "Same show", now + 2 * day)];
    await importPageSchedule(env, page, now);
    await addConnection("twitch");
    fake.twitchSchedule = [schedule([segment("s1", "Same show", now + 2 * day)])];
    await importPageSchedule(env, page, now + 60_000);
    expect((await events()).map((event: StreamEvent) => [event.platform, event.alsoOn.length])).toEqual([["youtube", 1]]);
    await env.DB.prepare("DELETE FROM channel_connections").run();
    await importSchedules(env, now + 60_000 + SOURCE_RETENTION_MS + 1);
    const list = await events();
    expect(list.map((event: StreamEvent) => [event.platform, event.url, event.alsoOn.length])).toEqual([
      ["twitch", "https://www.twitch.tv/twitchhost", 0],
    ]);
  });

  it("keeps an imported entry that the owner gave a replay link when its YouTube data expires", async (): Promise<void> => {
    await addConnection("youtube");
    fake.upcoming = [broadcast("vid-1", "Tube show", now + 2 * hour)];
    await importPageSchedule(env, page, now);
    const [entry] = await events();
    // After the stream ended, the owner adds the replay.
    vi.useFakeTimers({ now: now + day, toFake: ["Date"] });
    await patchEvent(env, "owner", entry.id, { action: "replay", vodUrl: "https://www.youtube.com/watch?v=vid-1" });
    vi.useRealTimers();
    await env.DB.prepare("DELETE FROM channel_connections").run();
    await importSchedules(env, now + SOURCE_RETENTION_MS + 1);
    const row = await env.DB.prepare("SELECT vod_url, imported FROM stream_events WHERE id=?")
      .bind(entry.id)
      .first<{ vod_url: string; imported: number }>();
    expect(row).toEqual({ vod_url: "https://www.youtube.com/watch?v=vid-1", imported: 0 });
  });

  it("uses synthetic streams in the test deployment and calls no provider", async (): Promise<void> => {
    await addConnection("twitch");
    await addConnection("youtube");
    env.APP_ENV = "test";
    await importOnVisit(env, page, now);
    expect(fake.calls).toEqual([]);
    const list = await events();
    expect(list.map((event: StreamEvent) => [event.title, event.platform, event.alsoOn.map((link) => link.platform)])).toEqual([
      ["Test stream", "twitch", ["youtube"]],
      ["Twitch only", "twitch", []],
      ["YouTube only", "youtube", []],
    ]);
    expect(testStreams("twitch", now)).toHaveLength(2);
  });
});
