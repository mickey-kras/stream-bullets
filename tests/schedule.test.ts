import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../app/env";
import { effectiveStatus, expandSeries, SERIES_HORIZON_MS } from "../app/lib/schedule";
import { addDays, parseDate, zonedParts, zonedTime } from "../app/lib/zoned";
import { buildCalendar, escapeText, foldLine, icsTime } from "../app/server/ics";
import {
  createEvents,
  deleteEvent,
  listEvents,
  patchEvent,
  planEvents,
  scheduleCalendar,
  topUpSeries,
} from "../app/server/schedule.server";
import { eventInputSchema } from "../app/server/validation";
import type { StreamEvent } from "../app/types";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const day = 86_400_000;

describe("time zones and weekly series", (): void => {
  it("keeps the wall-clock time across a daylight-saving change (Europe/Berlin)", (): void => {
    // Berlin leaves summer time on Sunday 25 October 2026: 19:00 is 17:00 UTC before, 18:00 UTC after.
    const starts = expandSeries(
      { first: { year: 2026, month: 10, day: 20 }, hour: 19, minute: 0, zone: "Europe/Berlin", days: 1 << 2, until: null },
      Date.UTC(2026, 10, 20),
    );
    expect(starts.slice(0, 3).map((time: number): string => new Date(time).toISOString())).toEqual([
      "2026-10-20T17:00:00.000Z",
      "2026-10-27T18:00:00.000Z",
      "2026-11-03T18:00:00.000Z",
    ]);
    for (const time of starts) expect(zonedParts(time, "Europe/Berlin")).toMatchObject({ hour: 19, minute: 0, weekday: 2 });
  });

  it("handles the US change a week later and several weekdays", (): void => {
    const starts = expandSeries(
      {
        first: { year: 2026, month: 10, day: 29 },
        hour: 20,
        minute: 30,
        zone: "America/New_York",
        days: (1 << 2) | (1 << 4),
        until: { year: 2026, month: 11, day: 5 },
      },
      Date.UTC(2027, 0, 1),
    );
    // Thu 29 Oct (EDT, UTC-4), Tue 3 Nov and Thu 5 Nov (EST, UTC-5). The end date is inclusive.
    expect(starts.map((time: number): string => new Date(time).toISOString())).toEqual([
      "2026-10-30T00:30:00.000Z",
      "2026-11-04T01:30:00.000Z",
      "2026-11-06T01:30:00.000Z",
    ]);
  });

  it("moves a time skipped in spring forward and stops at the horizon", (): void => {
    // 02:30 does not exist in Berlin on 29 March 2026; it becomes 03:30 local (01:30 UTC).
    expect(new Date(zonedTime({ year: 2026, month: 3, day: 29 }, 2, 30, "Europe/Berlin")).toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    const first = { year: 2026, month: 1, day: 5 };
    const starts = expandSeries(
      { first, hour: 12, minute: 0, zone: "UTC", days: 127, until: null },
      Date.UTC(2026, 0, 5, 12) + 3 * day,
    );
    expect(starts).toHaveLength(3);
    expect(addDays(first, 30)).toEqual({ year: 2026, month: 2, day: 4 });
    expect(parseDate("2026-02-30")).toBeNull();
  });

  it("plans a series 12 weeks ahead and always includes the first date's weekday", (): void => {
    const now = Date.UTC(2026, 10, 1);
    const input = eventInputSchema.parse({
      title: "Variety night",
      date: "2026-11-03",
      time: "19:00",
      tz: "Europe/Berlin",
      durationMin: 120,
      platform: "twitch",
      url: "https://twitch.tv/nova",
      repeatDays: 1 << 4,
    });
    const plan = planEvents(input, now);
    expect(plan.repeatDays).toBe((1 << 2) | (1 << 4));
    expect(plan.seriesId).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.starts[0]).toBe(Date.UTC(2026, 10, 3, 18));
    expect(plan.starts.at(-1)! <= Date.UTC(2026, 10, 3, 18) + SERIES_HORIZON_MS).toBe(true);
    expect(plan.starts).toHaveLength(24);
    expect(planEvents({ ...input, repeatDays: 0 }, now)).toMatchObject({ seriesId: null, starts: [Date.UTC(2026, 10, 3, 18)] });
  });

  it("derives live and ended from the clock", (): void => {
    const start = 1_000_000;
    expect(effectiveStatus("scheduled", start, 60, start - 1)).toBe("scheduled");
    expect(effectiveStatus("scheduled", start, 60, start)).toBe("live");
    expect(effectiveStatus("scheduled", start, 60, start + 60 * 60_000)).toBe("ended");
    expect(effectiveStatus("cancelled", start, 60, start + 1)).toBe("cancelled");
  });
});

describe("ICS output", (): void => {
  it("escapes text values", (): void => {
    expect(escapeText("Q&A; mics, cams\\lights\nPart 2")).toBe(String.raw`Q&A\; mics\, cams\\lights\nPart 2`);
  });

  it("folds long lines at 75 octets without splitting characters", (): void => {
    const line = `SUMMARY:${"Ünïcödé stream ".repeat(10)}`;
    const folded = foldLine(line);
    const physical = folded.split("\r\n");
    expect(physical.length).toBeGreaterThan(1);
    for (const part of physical) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(physical.slice(1).every((part: string): boolean => part.startsWith(" "))).toBe(true);
    expect(physical.map((part: string, index: number): string => (index ? part.slice(1) : part)).join("")).toBe(line);
    expect(foldLine("SHORT:ok")).toBe("SHORT:ok");
  });

  it("writes UTC times, UIDs and cancelled streams", (): void => {
    const text = buildCalendar(
      "Nova",
      [
        {
          id: "e1",
          title: "Boss rush, part 2",
          notes: "",
          startsAt: Date.UTC(2026, 10, 5, 18),
          durationMin: 90,
          url: "https://twitch.tv/nova",
          cancelled: true,
          updatedAt: Date.UTC(2026, 10, 1),
        },
      ],
      { now: Date.UTC(2026, 10, 2) },
    );
    expect(text).toContain("\r\nUID:e1@streambullets.com\r\n");
    expect(text).toContain("DTSTART:20261105T180000Z");
    expect(text).toContain("DTEND:20261105T193000Z");
    expect(text).toContain(String.raw`SUMMARY:Boss rush\, part 2`);
    expect(text).toContain("STATUS:CANCELLED");
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(icsTime(0)).toBe("19700101T000000Z");
  });
});

describe("schedule storage", (): void => {
  let database: TestDatabase;
  let env: AppEnv;
  let streamerId: string;
  let topicId: string;

  beforeAll(async (): Promise<void> => {
    database = await createTestDatabase();
    env = { DB: database.db } as AppEnv;
  });
  afterAll(async (): Promise<void> => database.dispose());
  beforeEach(async (): Promise<void> => {
    streamerId = crypto.randomUUID();
    topicId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user"),
      env.DB.prepare("DELETE FROM app_rate_limits"),
      ...["owner", "viewer"].map((id: string) =>
        env.DB.prepare("INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)").bind(
          id,
          id,
          `${id}@example.test`,
          now,
          now,
        ),
      ),
      env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','nova','Nova')").bind(streamerId),
      env.DB.prepare(
        "INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,created_at) VALUES (?,?,'viewer','topic','Mics','b','Gaming',?)",
      ).bind(topicId, streamerId, now),
    ]);
  });

  function input(date: Date, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      title: "Variety night",
      date: date.toISOString().slice(0, 10),
      time: "18:00",
      tz: "UTC",
      durationMin: 120,
      platform: "twitch",
      url: "https://twitch.tv/nova",
      topicIds: [topicId, crypto.randomUUID()],
      ...extra,
    };
  }

  it("writes a weekly series 12 weeks ahead and tops it up as time passes", async (): Promise<void> => {
    const tomorrow = new Date(Date.now() + day);
    const first = await createEvents(env, "owner", input(tomorrow, { repeatDays: 127 }));
    expect(first.seriesId).not.toBeNull();
    expect(first.topics.map((topic) => topic.id)).toEqual([topicId]);
    const count = async (): Promise<number> =>
      (await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE series_id=?").bind(first.seriesId).first<{ n: number }>())!.n;
    const written = await count();
    expect(written).toBeGreaterThanOrEqual(83);
    expect(written).toBeLessThanOrEqual(85);
    expect(await topUpSeries(env, Date.now())).toBe(0);
    const added = await topUpSeries(env, Date.now() + 7 * day);
    expect(added).toBeGreaterThanOrEqual(6);
    expect(added).toBeLessThanOrEqual(7);
    expect(await count()).toBe(written + added);
    const latest = await env.DB.prepare("SELECT id FROM stream_events WHERE series_id=? ORDER BY starts_at DESC LIMIT 1")
      .bind(first.seriesId)
      .first<{ id: string }>();
    const topics = await env.DB.prepare("SELECT entry_id FROM stream_event_topics WHERE event_id=?").bind(latest!.id).all();
    expect(topics.results).toEqual([{ entry_id: topicId }]);
  });

  it("stops a series at its end date", async (): Promise<void> => {
    const start = new Date(Date.now() + day);
    const until = new Date(Date.now() + 15 * day);
    const first = await createEvents(
      env,
      "owner",
      input(start, { repeatDays: 1 << start.getUTCDay(), repeatUntil: until.toISOString().slice(0, 10) }),
    );
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE series_id=?").bind(first.seriesId).first<{ n: number }>();
    expect(rows!.n).toBe(3);
    expect(await topUpSeries(env, Date.now() + 60 * day)).toBe(0);
  });

  it("edits one stream or the following ones, cancels, adds replays and deletes", async (): Promise<void> => {
    const start = new Date(Date.now() + day);
    const first = await createEvents(env, "owner", input(start, { repeatDays: 1 << start.getUTCDay() }));
    const list = async (): Promise<StreamEvent[]> => listEvents(env, streamerId, Date.now() - day, Date.now() + 120 * day);
    const all = await list();
    expect(all).toHaveLength(12);
    const second = all[1];
    const edited = await patchEvent(env, "owner", second.id, { action: "edit", scope: "one", ...input(new Date(second.startsAt)), title: "Special" });
    expect(edited).toMatchObject({ id: second.id, title: "Special", seriesId: first.seriesId });
    await expect(patchEvent(env, "viewer", second.id, { action: "cancel" })).rejects.toMatchObject({ status: 404 });
    expect(await patchEvent(env, "owner", second.id, { action: "cancel" })).toMatchObject({ status: "cancelled" });
    await expect(patchEvent(env, "owner", second.id, { action: "replay", vodUrl: "https://twitch.tv/videos/1" })).rejects.toMatchObject({ status: 409 });
    const third = all[2];
    const following = await patchEvent(env, "owner", third.id, {
      action: "edit",
      scope: "following",
      ...input(new Date(third.startsAt)),
      title: "New format",
      repeatDays: 1 << new Date(third.startsAt).getUTCDay(),
      time: "20:00",
    });
    const after = await list();
    expect(after.filter((event) => event.title === "New format")).toHaveLength(10);
    expect(after.filter((event) => event.title === "Variety night")).toHaveLength(1);
    expect(new Date(following.startsAt).getUTCHours()).toBe(20);
    await deleteEvent(env, "owner", following.id, { scope: "following" });
    expect(await list()).toHaveLength(2);
    await deleteEvent(env, "owner", first.id, undefined);
    expect((await list()).map((event) => event.title)).toEqual(["Special"]);
  });

  it("refuses writes on a frozen page and from viewers", async (): Promise<void> => {
    await expect(createEvents(env, "viewer", input(new Date(Date.now() + day)))).rejects.toMatchObject({ status: 403 });
    await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(streamerId).run();
    await expect(createEvents(env, "owner", input(new Date(Date.now() + day)))).rejects.toMatchObject({ status: 423 });
    await expect(createEvents(env, "owner", { ...input(new Date()), url: "http://twitch.tv/x" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("serves past and cancelled streams in the calendar feed", async (): Promise<void> => {
    const event = await createEvents(env, "owner", input(new Date(Date.now() + 2 * day)));
    await patchEvent(env, "owner", event.id, { action: "cancel" });
    const text = await scheduleCalendar(env, { id: streamerId, name: "Nova", handle: "nova" }, "https://streambullets.com");
    expect(text).toContain(`UID:${event.id}@streambullets.com`);
    expect(text).toContain("STATUS:CANCELLED");
    expect(text).toContain("Topics and polls: https://streambullets.com/@nova");
  });
});
