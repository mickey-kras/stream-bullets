import { RouterContextProvider } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appContext, type AppEnv } from "../app/env";
import {
  blockLanes,
  blockPosition,
  eventsOn,
  gridHours,
  sliceOn,
  visibleRange,
} from "../app/components/schedule/schedule-calendar";
import { atMark, nextMark, ServerOffset, startClock } from "../app/lib/clock";
import {
  effectiveStatus,
  expandSeries,
  liveEventAt,
  SCHEDULE_STEP_MS,
  scheduleMarks,
  SERIES_HORIZON_MS,
  statusesAt,
} from "../app/lib/schedule";
import { addDays, parseDate, zonedParts, zonedTime } from "../app/lib/zoned";
import { buildCalendar, escapeText, foldLine, icsTime } from "../app/server/ics";
import {
  createEvents,
  defaultRange,
  deleteEvent,
  listEvents,
  MAX_UPCOMING_EVENTS,
  patchEvent,
  planEvents,
  scheduleCalendar,
  topUpSeries,
  UPCOMING_LIMIT,
} from "../app/server/schedule.server";
import { loader as streamerLoader } from "../app/routes/streamer";
import { eventInputSchema } from "../app/server/validation";
import type { StreamEvent } from "../app/types";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const day = 86_400_000;

describe("time zones and weekly series", (): void => {
  it("keeps the wall-clock time across a daylight-saving change (Europe/Berlin)", (): void => {
    // Berlin leaves summer time on Sunday 25 October 2026: 19:00 is 17:00 UTC before, 18:00 UTC after.
    const starts = expandSeries(
      {
        first: { year: 2026, month: 10, day: 20 },
        hour: 19,
        minute: 0,
        zone: "Europe/Berlin",
        days: 1 << 2,
        until: null,
      },
      Date.UTC(2026, 10, 20),
    );
    expect(starts.slice(0, 3).map((time: number): string => new Date(time).toISOString())).toEqual([
      "2026-10-20T17:00:00.000Z",
      "2026-10-27T18:00:00.000Z",
      "2026-11-03T18:00:00.000Z",
    ]);
    for (const time of starts)
      expect(zonedParts(time, "Europe/Berlin")).toMatchObject({ hour: 19, minute: 0, weekday: 2 });
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

  function at(zone: string, date: string, time: string): string {
    const [hour, minute] = time.split(":").map(Number);
    return new Date(zonedTime(parseDate(date)!, hour, minute, zone)).toISOString();
  }

  it("moves a time skipped in spring forward by the gap in every zone", (): void => {
    // West of UTC: 02:30 does not exist on 8 March 2026; it becomes 03:30 daylight time.
    expect(at("America/New_York", "2026-03-08", "02:30")).toBe("2026-03-08T07:30:00.000Z");
    expect(at("America/Los_Angeles", "2026-03-08", "02:30")).toBe("2026-03-08T10:30:00.000Z");
    // East of UTC and in the southern hemisphere (Sydney springs forward in October).
    expect(at("Europe/Berlin", "2026-03-29", "02:30")).toBe("2026-03-29T01:30:00.000Z");
    expect(at("Australia/Sydney", "2026-10-04", "02:30")).toBe("2026-10-03T16:30:00.000Z");
    // Lord Howe Island moves by 30 minutes: 02:15 becomes 02:45 (UTC+11).
    expect(at("Australia/Lord_Howe", "2026-10-04", "02:15")).toBe("2026-10-03T15:45:00.000Z");
  });

  it("keeps times on either side of a spring change", (): void => {
    expect(at("America/New_York", "2026-03-08", "01:59")).toBe("2026-03-08T06:59:00.000Z");
    expect(at("America/New_York", "2026-03-08", "03:00")).toBe("2026-03-08T07:00:00.000Z");
    expect(at("America/Los_Angeles", "2026-03-08", "01:30")).toBe("2026-03-08T09:30:00.000Z");
    expect(at("America/Los_Angeles", "2026-03-08", "03:30")).toBe("2026-03-08T10:30:00.000Z");
    expect(at("Europe/Berlin", "2026-03-29", "01:30")).toBe("2026-03-29T00:30:00.000Z");
    expect(at("Europe/Berlin", "2026-03-29", "03:30")).toBe("2026-03-29T01:30:00.000Z");
    expect(at("Australia/Sydney", "2026-10-04", "01:30")).toBe("2026-10-03T15:30:00.000Z");
    expect(at("Australia/Sydney", "2026-10-04", "03:30")).toBe("2026-10-03T16:30:00.000Z");
    expect(at("Australia/Lord_Howe", "2026-10-04", "01:45")).toBe("2026-10-03T15:15:00.000Z");
    expect(at("Australia/Lord_Howe", "2026-10-04", "02:45")).toBe("2026-10-03T15:45:00.000Z");
  });

  it("keeps times on either side of an autumn change and picks one moment for a repeated time", (): void => {
    expect(at("America/New_York", "2026-11-01", "00:30")).toBe("2026-11-01T04:30:00.000Z");
    expect(at("America/New_York", "2026-11-01", "02:30")).toBe("2026-11-01T07:30:00.000Z");
    expect(at("Europe/Berlin", "2026-10-25", "01:30")).toBe("2026-10-24T23:30:00.000Z");
    expect(at("Europe/Berlin", "2026-10-25", "03:30")).toBe("2026-10-25T02:30:00.000Z");
    expect(at("Australia/Sydney", "2026-04-05", "01:30")).toBe("2026-04-04T14:30:00.000Z");
    expect(at("Australia/Sydney", "2026-04-05", "03:30")).toBe("2026-04-04T17:30:00.000Z");
    // A time that occurs twice takes the offset in force at that wall-clock time read as UTC: west of UTC that is
    // still daylight time (the earlier moment), east of UTC already standard time (the later one).
    expect(at("America/New_York", "2026-11-01", "01:30")).toBe("2026-11-01T05:30:00.000Z");
    expect(at("America/Los_Angeles", "2026-11-01", "01:30")).toBe("2026-11-01T08:30:00.000Z");
    expect(at("Europe/Berlin", "2026-10-25", "02:30")).toBe("2026-10-25T01:30:00.000Z");
    expect(at("Australia/Sydney", "2026-04-05", "02:30")).toBe("2026-04-04T16:30:00.000Z");
    expect(at("Australia/Lord_Howe", "2026-04-05", "01:45")).toBe("2026-04-04T15:15:00.000Z");
  });

  it("expands a daily series across the spring change in New York", (): void => {
    const starts = expandSeries(
      {
        first: { year: 2026, month: 3, day: 7 },
        hour: 2,
        minute: 30,
        zone: "America/New_York",
        days: 127,
        until: { year: 2026, month: 3, day: 9 },
      },
      Date.UTC(2027, 0, 1),
    );
    // 02:30 EST, then 03:30 EDT on the day 02:30 is skipped, then 02:30 EDT.
    expect(starts.map((time: number): string => new Date(time).toISOString())).toEqual([
      "2026-03-07T07:30:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z",
    ]);
  });

  it("asks for a calendar range that ends at the next local midnight, whatever the day's length", (): void => {
    const zone = "America/New_York";
    const late = (date: string): number => zonedTime(parseDate(date)!, 23, 30, zone);
    // Clocks fall back on 7 November 2027: the day is 25 hours long and midnight after it is 05:00 UTC.
    const fall = visibleRange("day", late("2027-11-07"), zone);
    expect(new Date(fall.from).toISOString()).toBe("2027-11-07T04:00:00.000Z");
    expect(new Date(fall.to).toISOString()).toBe("2027-11-08T05:00:00.000Z");
    expect(late("2027-11-07")).toBeLessThan(fall.to);
    // Clocks spring forward on 14 March 2027: a 23-hour day still ends at its own midnight.
    const spring = visibleRange("day", late("2027-03-14"), zone);
    expect(new Date(spring.to).toISOString()).toBe("2027-03-15T04:00:00.000Z");
    // A week or month ends at the midnight after its last day too.
    const week = visibleRange("week", late("2027-11-07"), zone);
    expect(zonedParts(week.to, zone)).toMatchObject({ hour: 0, minute: 0 });
    expect(Math.round((week.to - week.from) / 3_600_000)).toBe(7 * 24 + 1);
    const month = visibleRange("month", late("2027-11-07"), zone);
    expect(zonedParts(month.to, zone)).toMatchObject({ hour: 0, minute: 0 });
  });

  it("widens the Day and Week grid to early and late streams, and keeps 8 AM to midnight otherwise", (): void => {
    const zone = "America/New_York";
    const at = (hour: number, durationMin = 60) => ({
      startsAt: zonedTime({ year: 2027, month: 2, day: 3 }, hour, 0, zone),
      durationMin,
    });
    const early = [at(1), at(4), at(7)];
    const hours = gridHours(early as StreamEvent[], zone);
    expect(hours).toEqual({ first: 1, last: 24 });
    const tops = early.map((event) => blockPosition(event, zone, hours).top);
    expect(tops).toEqual([0, 3 * 48, 6 * 48]);
    for (const event of early) expect(blockPosition(event, zone, hours).height).toBe(48);
    // A late stream that runs past midnight stops at the bottom of its day: the next day shows the rest.
    const late = gridHours([at(10), at(22, 180)] as StreamEvent[], zone);
    expect(late).toEqual({ first: 8, last: 24 });
    expect(blockPosition(at(22, 180), zone, late)).toEqual({ top: 14 * 48, height: 2 * 48 });
    // Streams from 10:00 to 22:00 keep the mockup's 8 AM to midnight.
    expect(gridHours([at(10), at(21)] as StreamEvent[], zone)).toEqual({ first: 8, last: 24 });
    expect(gridHours([], zone)).toEqual({ first: 8, last: 24 });
  });

  it("shows a stream that crosses midnight on the next day too, from the top of its grid", (): void => {
    const zone = "America/New_York";
    const day = (date: string): number => zonedTime(parseDate(date)!, 0, 0, zone);
    const stream = (date: string, hour: number, durationMin: number) => ({
      startsAt: zonedTime(parseDate(date)!, hour, 0, zone),
      durationMin,
    });
    // 23:00 to 03:00: on its own day and on the next, where its block starts at 0:00 and runs three hours.
    const night = stream("2027-02-03", 23, 240);
    expect(eventsOn([night], day("2027-02-03"), zone)).toEqual([night]);
    expect(eventsOn([night], day("2027-02-04"), zone)).toEqual([night]);
    expect(eventsOn([night], day("2027-02-05"), zone)).toEqual([]);
    expect(sliceOn(night, day("2027-02-03"))).toBe(night);
    const rest = sliceOn(night, day("2027-02-04"));
    expect(rest).toEqual({ startsAt: day("2027-02-04"), durationMin: 180 });
    const hours = gridHours([rest], zone);
    expect(hours).toEqual({ first: 0, last: 24 });
    expect(blockPosition(rest, zone, hours)).toEqual({ top: 0, height: 3 * 48 });
    // On its own day the block stops at midnight.
    expect(blockPosition(night, zone, gridHours([night], zone))).toEqual({ top: 15 * 48, height: 48 });
    // A stream that ends exactly at midnight stays on its own day.
    expect(eventsOn([stream("2027-02-03", 22, 120)], day("2027-02-04"), zone)).toEqual([]);
    // Clocks spring forward on 14 March 2027: 23:00 for three hours ends at 03:00, two hours after midnight.
    const spring = stream("2027-03-13", 23, 180);
    expect(eventsOn([spring], day("2027-03-14"), zone)).toEqual([spring]);
    expect(sliceOn(spring, day("2027-03-14"))).toEqual({ startsAt: day("2027-03-14"), durationMin: 120 });
  });

  it("puts overlapping Day and Week blocks side by side, so none covers another", (): void => {
    const block = (hour: number, hours = 1) => ({ top: hour * 48, height: hours * 48 });
    // Two streams at the same time split the column.
    expect(blockLanes([block(10), block(10)])).toEqual([
      { lane: 0, lanes: 2 },
      { lane: 1, lanes: 2 },
    ]);
    // A chain of overlaps shares one count of lanes, a freed lane is reused, and a later stream gets the full width.
    expect(blockLanes([block(10, 3), block(11), block(12), block(14), block(20)])).toEqual([
      { lane: 0, lanes: 2 },
      { lane: 1, lanes: 2 },
      { lane: 1, lanes: 2 },
      { lane: 0, lanes: 1 },
      { lane: 0, lanes: 1 },
    ]);
    // Input order does not matter, and a stream that ends as the next starts does not overlap it.
    expect(blockLanes([block(12), block(11)])).toEqual([
      { lane: 0, lanes: 1 },
      { lane: 0, lanes: 1 },
    ]);
    expect(blockLanes([])).toEqual([]);
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
    expect(planEvents({ ...input, repeatDays: 0 }, now)).toMatchObject({
      seriesId: null,
      starts: [Date.UTC(2026, 10, 3, 18)],
    });
  });

  it("derives live and ended from the clock", (): void => {
    const start = 1_000_000;
    expect(effectiveStatus("scheduled", start, 60, start - 1)).toBe("scheduled");
    expect(effectiveStatus("scheduled", start, 60, start)).toBe("live");
    expect(effectiveStatus("scheduled", start, 60, start + 60 * 60_000)).toBe("ended");
    expect(effectiveStatus("cancelled", start, 60, start + 1)).toBe("cancelled");
  });
});

describe("the schedule clock", (): void => {
  afterEach((): void => {
    vi.useRealTimers();
  });

  it("wakes a whole step before each mark ahead, and not at all with none", (): void => {
    expect(nextMark(1_000, [61_000], 30_000)).toBe(31_000);
    expect(nextMark(31_000, [61_000], 30_000)).toBe(61_000);
    // The nearest step of any mark wins.
    expect(nextMark(1_000, [61_000, 200_000], 30_000)).toBe(20_000);
    expect(nextMark(61_000, [61_000, 200_000], 30_000)).toBe(80_000);
    expect(nextMark(200_000, [61_000, 200_000], 30_000)).toBeNull();
    expect(nextMark(0, [], 30_000)).toBeNull();
  });

  it("picks the stream live by the clock, not the status the loader stored", (): void => {
    const loaded = [
      { id: "off", status: "cancelled" as const, startsAt: 0, durationMin: 10 },
      { id: "next", status: "scheduled" as const, startsAt: 60_000, durationMin: 1 },
    ];
    expect(liveEventAt(loaded, 59_999)).toBeNull();
    expect(liveEventAt(loaded, 60_000)).toEqual({ ...loaded[1], status: "live" });
    expect(liveEventAt(loaded, 119_999)?.id).toBe("next");
    expect(liveEventAt(loaded, 120_000)).toBeNull();
    // A stream stored as live ends with the clock too.
    expect(liveEventAt([{ ...loaded[1], status: "live" as const }], 120_000)).toBeNull();
  });

  it("moves a stream from upcoming to live to ended as the clock crosses its start and end", (): void => {
    vi.useFakeTimers();
    // The local clock runs 5 seconds behind the server; the schedule follows the server.
    vi.setSystemTime(1_000_000 - 5_000);
    const serverNow = 1_000_000;
    const loaded = [
      { id: "next", status: "scheduled" as const, startsAt: serverNow + 70_000, durationMin: 2 },
      { id: "off", status: "cancelled" as const, startsAt: serverNow + 10_000, durationMin: 1 },
      { id: "done", status: "ended" as const, startsAt: serverNow - 600_000, durationMin: 1 },
    ];
    const seen: { now: number; status: string }[] = [];
    const stop = startClock(
      serverNow,
      (now: number): number | null => nextMark(now, scheduleMarks(loaded), SCHEDULE_STEP_MS),
      (now: number): void => {
        seen.push({ now, status: statusesAt(loaded, now)[0].status });
      },
    );
    vi.advanceTimersByTime(69_999);
    expect(seen.map((tick) => tick.status)).toEqual(["scheduled", "scheduled"]);
    vi.advanceTimersByTime(1);
    expect(seen.at(-1)).toEqual({ now: serverNow + 70_000, status: "live" });
    vi.advanceTimersByTime(120_000);
    expect(seen.at(-1)).toEqual({ now: serverNow + 190_000, status: "ended" });
    expect(seen.map((tick) => tick.now - serverNow)).toEqual([
      10_000, 40_000, 70_000, 100_000, 130_000, 160_000, 190_000,
    ]);
    // Nothing is ahead once the stream ends, so the clock sleeps.
    expect(vi.getTimerCount()).toBe(0);
    stop();
    expect(statusesAt(loaded, serverNow)[1]).toBe(loaded[1]);
  });

  it("waits out a mark further away than a timer can wait, and fires once at it", (): void => {
    vi.useFakeTimers();
    const serverNow = Date.now();
    const at = serverNow + 30 * day;
    const reached = vi.fn();
    atMark(serverNow, at, reached);
    vi.advanceTimersByTime(30 * day - 1);
    expect(reached).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reached).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * day);
    expect(reached).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // The schedule clock's wakes are just as far apart: the first step before a stream 40 days ahead.
    const ticks: number[] = [];
    startClock(
      serverNow,
      (now: number): number | null => nextMark(now, [serverNow + 40 * day], SCHEDULE_STEP_MS),
      (now: number): number => ticks.push(now),
    );
    vi.advanceTimersByTime(10_000);
    expect(ticks).toEqual([]);
  });

  it("keeps the server offset when it restarts with the same server time", (): void => {
    vi.useFakeTimers();
    const serverNow = Date.now() + 5_000;
    const offsets = new ServerOffset();
    const ticks: number[] = [];
    const run = (marks: number[]): (() => void) =>
      startClock(
        serverNow,
        (now: number): number | null => nextMark(now, marks, SCHEDULE_STEP_MS),
        (now: number): number => ticks.push(now - serverNow),
        offsets,
      );
    const first = run([serverNow + 60 * 60_000]);
    vi.advanceTimersByTime(10 * 60_000);
    // New marks (a range fetched later) restart the clock ten minutes after the page loaded.
    first();
    run([serverNow + 60 * 60_000, serverNow + 2 * 60 * 60_000]);
    ticks.length = 0;
    vi.advanceTimersByTime(SCHEDULE_STEP_MS);
    expect(ticks).toEqual([10 * 60_000 + SCHEDULE_STEP_MS]);
    // A new server time is measured afresh.
    expect(offsets.for(Date.now() + 1_000)).toBe(1_000);
  });

  it("cancels its timer when stopped", (): void => {
    vi.useFakeTimers();
    const ticks: number[] = [];
    const stop = startClock(
      Date.now(),
      (now: number): number => now + 1_000,
      (now: number): number => ticks.push(now),
    );
    vi.advanceTimersByTime(2_000);
    stop();
    vi.advanceTimersByTime(5_000);
    expect(ticks).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
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
      env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','nova','Nova')").bind(
        streamerId,
      ),
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
      (await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE series_id=?")
        .bind(first.seriesId)
        .first<{ n: number }>())!.n;
    const written = await count();
    expect(written).toBeGreaterThanOrEqual(83);
    expect(written).toBeLessThanOrEqual(85);
    expect(await topUpSeries(env, Date.now())).toBe(0);
    const added = await topUpSeries(env, Date.now() + 7 * day);
    expect(added).toBeGreaterThanOrEqual(6);
    expect(added).toBeLessThanOrEqual(7);
    expect(await count()).toBe(written + added);
    const latest = await env.DB.prepare(
      "SELECT id FROM stream_events WHERE series_id=? ORDER BY starts_at DESC LIMIT 1",
    )
      .bind(first.seriesId)
      .first<{ id: string }>();
    const topics = await env.DB.prepare("SELECT entry_id FROM stream_event_topics WHERE event_id=?")
      .bind(latest!.id)
      .all();
    expect(topics.results).toEqual([{ entry_id: topicId }]);
  });

  it("reloads an overlay showing Up next when the top-up writes new streams", async (): Promise<void> => {
    await createEvents(env, "owner", input(new Date(Date.now() + day), { repeatDays: 127 }));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM overlay_state"),
      env.DB.prepare(
        `INSERT INTO overlay_state (streamer_id, air, preview, position, size, instant, show_results, message, message_style, revision, updated_at)
        VALUES (?, '{"type":"next","ref":null}', '{"type":"message","ref":null}', 'top', 'l', 0, 1, '', 'info', 0, ?)`,
      ).bind(streamerId, Date.now()),
    ]);
    const revision = async (): Promise<number> =>
      (await env.DB.prepare("SELECT revision FROM overlay_state WHERE streamer_id=?")
        .bind(streamerId)
        .first<{ revision: number }>())!.revision;
    expect(await topUpSeries(env, Date.now())).toBe(0);
    expect(await revision()).toBe(0);
    expect(await topUpSeries(env, Date.now() + 7 * day)).toBeGreaterThan(0);
    expect(await revision()).toBe(1);
  });

  it("stops a series at its end date", async (): Promise<void> => {
    const start = new Date(Date.now() + day);
    const until = new Date(Date.now() + 15 * day);
    const first = await createEvents(
      env,
      "owner",
      input(start, { repeatDays: 1 << start.getUTCDay(), repeatUntil: until.toISOString().slice(0, 10) }),
    );
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE series_id=?")
      .bind(first.seriesId)
      .first<{ n: number }>();
    expect(rows!.n).toBe(3);
    // A series written to its end date is marked finished, so the cron never picks it again.
    const mark = await env.DB.prepare("SELECT written_through FROM stream_series WHERE id=?")
      .bind(first.seriesId)
      .first<{ written_through: number }>();
    expect(mark!.written_through).toBe(first.repeatUntil);
    expect(await topUpSeries(env, Date.now() + 60 * day)).toBe(0);
  });

  it("skips finished series so open-ended ones still get topped up", async (): Promise<void> => {
    const now = Date.now();
    const rows: D1PreparedStatement[] = [];
    // 50 series that have written every stream up to their end date (the end of its last local day).
    for (let index = 0; index < 50; index += 1) {
      const last = now + 10 * day + index * 60_000;
      const end = new Date(last);
      const until = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1) - 1;
      rows.push(
        env.DB.prepare(`INSERT INTO stream_events (id,streamer_id,series_id,title,starts_at,duration_min,platform,url,
          status,repeat_days,repeat_until,tz,created_at,updated_at) VALUES (?,?,?,'Done',?,60,'twitch',
          'https://twitch.tv/nova','scheduled',?,?,'UTC',?,?)`).bind(
          crypto.randomUUID(),
          streamerId,
          // Series ids sort ahead of the open-ended one's, as the cron's query reads them.
          `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          last,
          1 << end.getUTCDay(),
          until,
          now,
          now,
        ),
      );
    }
    await env.DB.batch(rows);
    const open = await createEvents(env, "owner", input(new Date(now + day), { repeatDays: 127 }));
    const count = async (): Promise<number> =>
      (await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE series_id=?")
        .bind(open.seriesId)
        .first<{ n: number }>())!.n;
    const before = await count();
    expect(await topUpSeries(env, now + 7 * day)).toBeGreaterThanOrEqual(6);
    expect(await count()).toBeGreaterThan(before);
    // The finished ones are marked as written through their end date and are not picked again.
    const marked = await env.DB.prepare(
      "SELECT count(*) AS n FROM stream_series WHERE id LIKE '00000000-%' AND written_through >= ?",
    )
      .bind(now + 10 * day)
      .first<{ n: number }>();
    expect(marked!.n).toBe(50);
  });

  it("never lets series on full pages use up the top-up's budget", async (): Promise<void> => {
    const now = Date.now();
    const at = now + 7 * day;
    const full = crypto.randomUUID();
    const rows: D1PreparedStatement[] = [
      env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'viewer','full_page','Full')").bind(full),
    ];
    // A page at the cap, 25 of its upcoming streams from open-ended series that sort ahead of every other series.
    for (let index = 0; index < MAX_UPCOMING_EVENTS; index += 1) {
      const series = index < 25 ? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` : null;
      rows.push(
        env.DB.prepare(`INSERT INTO stream_events (id,streamer_id,series_id,title,starts_at,duration_min,platform,url,
          status,repeat_days,repeat_until,tz,created_at,updated_at) VALUES (?,?,?,'Full',?,60,'twitch',
          'https://twitch.tv/full','scheduled',?,NULL,'UTC',?,?)`).bind(
          crypto.randomUUID(),
          full,
          series,
          at + day + index * 60_000,
          series ? 127 : 0,
          now,
          now,
        ),
      );
    }
    await env.DB.batch(rows);
    const open = await createEvents(env, "owner", input(new Date(now + day), { repeatDays: 127 }));
    const count = async (): Promise<number> =>
      (await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE series_id=?")
        .bind(open.seriesId)
        .first<{ n: number }>())!.n;
    const before = await count();
    // One series a page and 20 pages a run: before, the 25 full-page series took every page.
    await topUpSeries(env, at, 1);
    expect(await count()).toBeGreaterThan(before);
  });

  it("edits one stream or the following ones, cancels, adds replays and deletes", async (): Promise<void> => {
    const start = new Date(Date.now() + day);
    const first = await createEvents(env, "owner", input(start, { repeatDays: 1 << start.getUTCDay() }));
    const list = async (): Promise<StreamEvent[]> =>
      listEvents(env, streamerId, Date.now() - day, Date.now() + 120 * day);
    const all = await list();
    expect(all).toHaveLength(12);
    const second = all[1];
    const edited = await patchEvent(env, "owner", second.id, {
      action: "edit",
      scope: "one",
      ...input(new Date(second.startsAt)),
      title: "Special",
    });
    expect(edited).toMatchObject({ id: second.id, title: "Special", seriesId: first.seriesId });
    await expect(patchEvent(env, "viewer", second.id, { action: "cancel" })).rejects.toMatchObject({ status: 404 });
    expect(await patchEvent(env, "owner", second.id, { action: "cancel" })).toMatchObject({ status: "cancelled" });
    await expect(
      patchEvent(env, "owner", second.id, { action: "replay", vodUrl: "https://twitch.tv/videos/1" }),
    ).rejects.toMatchObject({ status: 409 });
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

  async function weekly(): Promise<StreamEvent[]> {
    const start = new Date(Date.now() + day);
    await createEvents(env, "owner", input(start, { repeatDays: 1 << start.getUTCDay() }));
    return listEvents(env, streamerId, Date.now() - day, Date.now() + 120 * day);
  }

  async function seriesRows(): Promise<{ title: string; starts_at: number; series_id: string | null }[]> {
    const { results } = await env.DB.prepare(
      "SELECT title, starts_at, series_id FROM stream_events WHERE streamer_id=? ORDER BY starts_at",
    )
      .bind(streamerId)
      .all<{ title: string; starts_at: number; series_id: string | null }>();
    return results;
  }

  it("never writes back streams deleted with this and the following ones", async (): Promise<void> => {
    const all = await weekly();
    await deleteEvent(env, "owner", all[4].id, { scope: "following" });
    expect(await topUpSeries(env, Date.now() + 30 * day)).toBe(0);
    expect((await seriesRows()).map((row) => row.starts_at)).toEqual(all.slice(0, 4).map((event) => event.startsAt));
  });

  it("stops the old series when the rest of it becomes a one-off", async (): Promise<void> => {
    const all = await weekly();
    await patchEvent(env, "owner", all[3].id, {
      action: "edit",
      scope: "following",
      ...input(new Date(all[3].startsAt)),
      title: "Finale",
      repeatDays: 0,
    });
    expect(await topUpSeries(env, Date.now() + 30 * day)).toBe(0);
    const rows = await seriesRows();
    expect(rows.map((row) => row.title)).toEqual(["Variety night", "Variety night", "Variety night", "Finale"]);
    expect(rows[3].series_id).toBeNull();
  });

  it("never writes back the newest stream when only that one is deleted", async (): Promise<void> => {
    const all = await weekly();
    await deleteEvent(env, "owner", all.at(-1)!.id, { scope: "one" });
    expect(await topUpSeries(env, Date.now())).toBe(0);
    expect(await topUpSeries(env, Date.now() + 7 * day)).toBe(1);
    const starts = (await seriesRows()).map((row) => row.starts_at);
    expect(starts).toEqual([...all.slice(0, -1).map((event) => event.startsAt), all.at(-1)!.startsAt + 7 * day]);
    // A series with no streams left loses its mark on the next run.
    const marks = async (): Promise<unknown> =>
      env.DB.prepare("SELECT count(*) AS n FROM stream_series WHERE streamer_id=?").bind(streamerId).first("n");
    expect(await marks()).toBe(1);
    await deleteEvent(env, "owner", all[0].id, { scope: "following" });
    await topUpSeries(env, Date.now());
    expect(await marks()).toBe(0);
  });

  it("follows the new days after this and the following ones are edited", async (): Promise<void> => {
    const all = await weekly();
    const moved = new Date(all[2].startsAt + day);
    await patchEvent(env, "owner", all[2].id, {
      action: "edit",
      scope: "following",
      ...input(moved),
      repeatDays: 1 << moved.getUTCDay(),
    });
    const before = (await seriesRows()).at(-1)!.starts_at;
    expect(await topUpSeries(env, Date.now() + 7 * day)).toBe(1);
    expect((await seriesRows()).at(-1)!.starts_at).toBe(before + 7 * day);
  });

  it("keeps extending a far-off series after its only stream is edited on its own", async (): Promise<void> => {
    // Fourteen weeks out, past the 12-week horizon: the series is written as that one stream.
    const start = new Date(Date.now() + 14 * 7 * day);
    const first = await createEvents(env, "owner", input(start, { repeatDays: 1 << start.getUTCDay() }));
    expect(await seriesRows()).toHaveLength(1);
    await patchEvent(env, "owner", first.id, {
      action: "edit",
      scope: "one",
      ...input(start),
      title: "Season opener",
      time: "20:00",
    });
    // Near its start, the series goes on from the template, not from the stream edited on its own.
    expect(await topUpSeries(env, first.startsAt - day)).toBeGreaterThanOrEqual(11);
    const rows = await seriesRows();
    expect(rows[0].title).toBe("Season opener");
    expect(rows[1]).toMatchObject({ title: "Variety night", starts_at: first.startsAt + 7 * day });
    expect(rows.every((row) => row.series_id === first.seriesId)).toBe(true);
  });

  it("keeps a far-off series whose only stream is deleted on its own, and drops one deleted onwards", async () => {
    const start = new Date(Date.now() + 14 * 7 * day);
    const kept = await createEvents(env, "owner", input(start, { repeatDays: 1 << start.getUTCDay() }));
    await deleteEvent(env, "owner", kept.id, { scope: "one" });
    // The hourly cleanup runs now; the series still has its template and goes on near its start.
    expect(await topUpSeries(env, Date.now())).toBe(0);
    expect(await topUpSeries(env, kept.startsAt - day)).toBeGreaterThanOrEqual(11);
    const rows = await seriesRows();
    expect(rows[0].starts_at).toBe(kept.startsAt + 7 * day);
    expect(rows.every((row) => row.series_id === kept.seriesId)).toBe(true);
    // A series deleted with this and the following from its first stream writes nothing again.
    await env.DB.prepare("DELETE FROM stream_events").run();
    const ended = await createEvents(env, "owner", input(start, { repeatDays: 1 << start.getUTCDay() }));
    await deleteEvent(env, "owner", ended.id, { scope: "following" });
    expect(await topUpSeries(env, Date.now())).toBe(0);
    expect(await topUpSeries(env, ended.startsAt - day)).toBe(0);
    expect(await seriesRows()).toEqual([]);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM stream_series WHERE id=?").bind(ended.seriesId).first("n"),
    ).toBe(0);
  });

  it("stops topping up at the page's cap, so every upcoming stream stays listed", async (): Promise<void> => {
    // Seven daily series that start past the horizon each pass the cap with one stream; together they would make
    // 7 × 84 = 588 upcoming streams near their start.
    const start = new Date(Date.now() + 13 * 7 * day);
    const series: StreamEvent[] = [];
    for (let index = 0; index < 7; index += 1) {
      const time = `${String(10 + index).padStart(2, "0")}:00`;
      // Six creations a minute is the owner's limit; the test is not about that.
      await env.DB.prepare("DELETE FROM app_rate_limits").run();
      series.push(await createEvents(env, "owner", input(start, { repeatDays: 127, time })));
    }
    expect(await seriesRows()).toHaveLength(7);
    const now = series[0].startsAt - day;
    await topUpSeries(env, now);
    const upcoming = (await seriesRows()).filter((row) => row.starts_at >= now).length;
    expect(upcoming).toBe(MAX_UPCOMING_EVENTS);
    const range = defaultRange(now);
    const listed = await listEvents(env, streamerId, range.from, range.to, now);
    expect(listed.filter((event: StreamEvent): boolean => event.startsAt >= now)).toHaveLength(upcoming);
    expect(UPCOMING_LIMIT).toBeGreaterThanOrEqual(MAX_UPCOMING_EVENTS);
    // The streams already written are kept, and the next run goes on from them as the page has room again.
    expect(await topUpSeries(env, now)).toBe(0);
  });

  it("refuses to move a past stream into a full schedule, and still edits upcoming ones", async (): Promise<void> => {
    const now = Date.now();
    const row = (id: string, startsAt: number, status = "scheduled"): D1PreparedStatement =>
      env.DB.prepare(`INSERT INTO stream_events (id,streamer_id,title,starts_at,duration_min,platform,url,status,tz,
        created_at,updated_at) VALUES (?,?,'Full',?,60,'twitch','https://twitch.tv/nova',?,'UTC',?,?)`).bind(
        id,
        streamerId,
        startsAt,
        status,
        now,
        now,
      );
    const past = crypto.randomUUID();
    const upcoming: string[] = Array.from({ length: MAX_UPCOMING_EVENTS }, (): string => crypto.randomUUID());
    await env.DB.batch([
      row(past, now - 3 * day),
      ...upcoming.map((id: string, index: number) =>
        row(id, now + day + index * 3_600_000, index ? "scheduled" : "cancelled"),
      ),
    ]);
    const edit = (id: string, date: Date, extra: Record<string, unknown> = {}): Promise<StreamEvent> =>
      patchEvent(env, "owner", id, { action: "edit", scope: "one", ...input(date), ...extra });
    await expect(edit(past, new Date(now + 2 * day))).rejects.toMatchObject({
      status: 409,
      message: `A schedule can hold up to ${MAX_UPCOMING_EVENTS} upcoming streams.`,
    });
    // Edits that keep the count, an upcoming one (cancelled too) or a past one that stays past, go through.
    expect(await edit(upcoming[5], new Date(now + 3 * day), { title: "Moved" })).toMatchObject({ title: "Moved" });
    expect(await edit(upcoming[0], new Date(now + 4 * day))).toMatchObject({ status: "cancelled" });
    expect(await edit(past, new Date(now - 2 * day), { title: "Renamed" })).toMatchObject({ title: "Renamed" });
  });

  /** Adds one-off streams from `after` on until the page holds `MAX_UPCOMING_EVENTS` upcoming streams. */
  async function fillToCap(page: string, after: number): Promise<void> {
    const row = await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE streamer_id=? AND starts_at >= ?")
      .bind(page, after)
      .first<{ n: number }>();
    const missing = MAX_UPCOMING_EVENTS - row!.n;
    if (missing <= 0) return;
    await env.DB.prepare(`INSERT INTO stream_events (id,streamer_id,title,starts_at,duration_min,platform,url,tz,
        created_at,updated_at)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      SELECT lower(hex(randomblob(16))), ?, 'Filler', ? + i * 60000, 60, 'twitch', 'https://twitch.tv/nova', 'UTC', ?, ?
      FROM n`)
      .bind(missing, page, after + 30 * day, after, after)
      .run();
  }

  /**
   * `env` with another writer filling `page` to the cap right after a capacity check reads its count, as a request
   * that commits between that check and this one's writes would.
   */
  function racingEnv(page: string): AppEnv {
    const check = "SELECT count(*) AS n FROM stream_events WHERE streamer_id=? AND starts_at >= ?";
    const db = new Proxy(env.DB, {
      get(target: D1Database, key: string | symbol): unknown {
        if (key !== "prepare") {
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string): D1PreparedStatement => {
          const statement = target.prepare(sql);
          if (sql !== check) return statement;
          return {
            bind: (streamer: string, after: number) => ({
              first: async (): Promise<unknown> => {
                const counted = await statement.bind(streamer, after).first();
                if (streamer === page) await fillToCap(page, after);
                return counted;
              },
            }),
          } as unknown as D1PreparedStatement;
        };
      },
    });
    return { ...env, DB: db };
  }

  async function upcomingOf(page: string, after: number): Promise<number> {
    return (await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE streamer_id=? AND starts_at >= ?")
      .bind(page, after)
      .first<{ n: number }>())!.n;
  }

  const fullMessage = `A schedule can hold up to ${MAX_UPCOMING_EVENTS} upcoming streams.`;

  it("holds the cap when series are created at the same time", async (): Promise<void> => {
    const now = Date.now();
    await fillToCap(streamerId, now);
    await env.DB.prepare("DELETE FROM stream_events WHERE id IN (SELECT id FROM stream_events LIMIT 100)").run();
    const tomorrow = new Date(now + day);
    const results = await Promise.allSettled(
      ["10:00", "12:00", "14:00"].map(
        (time: string): Promise<StreamEvent> => createEvents(env, "owner", input(tomorrow, { repeatDays: 127, time })),
      ),
    );
    expect(await upcomingOf(streamerId, now)).toBeLessThanOrEqual(MAX_UPCOMING_EVENTS);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((value) => value.status === "rejected"))
      expect(result.reason).toMatchObject({ status: 409, message: fullMessage });
    const series = await env.DB.prepare("SELECT count(*) AS n FROM stream_series WHERE streamer_id=?")
      .bind(streamerId)
      .first<{ n: number }>();
    expect(series!.n).toBe(1);
  });

  it("refuses a creation or edit that a write committed after its check would push past the cap", async () => {
    const now = Date.now();
    const racing = racingEnv(streamerId);
    await expect(
      createEvents(racing, "owner", input(new Date(now + day), { repeatDays: 127 })),
    ).rejects.toMatchObject({ status: 409, message: fullMessage });
    expect(await upcomingOf(streamerId, now)).toBe(MAX_UPCOMING_EVENTS);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM stream_series").first("n")).toBe(0);

    await env.DB.prepare("DELETE FROM stream_events").run();
    const past = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO stream_events (id,streamer_id,title,starts_at,duration_min,platform,url,tz,
      created_at,updated_at) VALUES (?,?,'Old',?,60,'twitch','https://twitch.tv/nova','UTC',?,?)`)
      .bind(past, streamerId, now - 3 * day, now, now)
      .run();
    await expect(
      patchEvent(racing, "owner", past, { action: "edit", scope: "one", ...input(new Date(now + 2 * day)) }),
    ).rejects.toMatchObject({ status: 409, message: fullMessage });
    expect(await env.DB.prepare("SELECT starts_at FROM stream_events WHERE id=?").bind(past).first("starts_at")).toBe(
      now - 3 * day,
    );

    await env.DB.prepare("DELETE FROM stream_events WHERE id<>?").bind(past).run();
    await expect(
      patchEvent(racing, "owner", past, {
        action: "edit",
        scope: "following",
        ...input(new Date(now + 2 * day), { repeatDays: 127 }),
      }),
    ).rejects.toMatchObject({ status: 409, message: fullMessage });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE id=?").bind(past).first("n")).toBe(1);
    expect(await upcomingOf(streamerId, now)).toBe(MAX_UPCOMING_EVENTS);
  });

  it("skips a series the cap stops mid top-up and still tops up other pages", async (): Promise<void> => {
    const other = crypto.randomUUID();
    const created = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO user (id,name,email,created_at,updated_at) VALUES ('owner2','o2',?,?,?)").bind(
        "owner2@example.test",
        created,
        created,
      ),
      env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner2','vega','Vega')").bind(other),
    ]);
    const tomorrow = new Date(created + day);
    const full = await createEvents(env, "owner", input(tomorrow, { repeatDays: 127 }));
    const open = await createEvents(env, "owner2", input(tomorrow, { repeatDays: 127 }));
    const count = async (seriesId: string | null): Promise<number> =>
      (await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE series_id=?")
        .bind(seriesId)
        .first<{ n: number }>())!.n;
    const [fullBefore, openBefore] = [await count(full.seriesId), await count(open.seriesId)];
    const now = created + 7 * day;
    const added = await topUpSeries(racingEnv(streamerId), now);
    expect(added).toBeGreaterThanOrEqual(6);
    expect(await count(open.seriesId)).toBe(openBefore + added);
    expect(await count(full.seriesId)).toBe(fullBefore);
    expect(await upcomingOf(streamerId, now)).toBe(MAX_UPCOMING_EVENTS);
  });

  /** `env` whose cron runs `change` right after it reads the series to top up, before it writes any of them. */
  function ownerRacesCron(change: () => Promise<unknown>): AppEnv {
    let pending = true;
    const db = new Proxy(env.DB, {
      get(target: D1Database, key: string | symbol): unknown {
        if (key !== "prepare") {
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string): D1PreparedStatement => {
          const statement = target.prepare(sql);
          if (!sql.includes("ORDER BY series_id")) return statement;
          return {
            bind: (...values: unknown[]) => ({
              all: async (): Promise<unknown> => {
                const read = await statement.bind(...values).all();
                if (pending) {
                  pending = false;
                  await change();
                }
                return read;
              },
            }),
          } as unknown as D1PreparedStatement;
        };
      },
    });
    return { ...env, DB: db };
  }

  async function streamsOf(seriesId: string | null): Promise<{ title: string; starts_at: number }[]> {
    const { results } = await env.DB.prepare(
      "SELECT title, starts_at FROM stream_events WHERE series_id=? ORDER BY starts_at",
    )
      .bind(seriesId)
      .all<{ title: string; starts_at: number }>();
    return results;
  }

  it.each(["stored", "legacy"])("never brings back a %s series ended while the cron tops it up", async (kind) => {
    const all = await weekly();
    const seriesId = all[0].seriesId;
    const daily = input(new Date(Date.now() + day), { repeatDays: 127, time: "09:00" });
    const other = await createEvents(env, "owner", daily);
    // A series written before 0018 has no stored template; the cron copies its latest stream.
    if (kind === "legacy") await env.DB.prepare("DELETE FROM stream_series WHERE id=?").bind(seriesId).run();
    const otherBefore = (await streamsOf(other.seriesId)).length;
    const racing = ownerRacesCron(() => deleteEvent(env, "owner", all[4].id, { scope: "following" }));
    const added = await topUpSeries(racing, Date.now() + 14 * day);
    expect(added).toBeGreaterThanOrEqual(13);
    expect((await streamsOf(other.seriesId)).length).toBe(otherBefore + added);
    const kept = all.slice(0, 4).map((event: StreamEvent): number => event.startsAt);
    expect((await streamsOf(seriesId)).map((row) => row.starts_at)).toEqual(kept);
    const end = Math.floor(all[4].startsAt / day) * day - 1;
    const stored = await env.DB.prepare("SELECT repeat_until FROM stream_series WHERE id=?").bind(seriesId).first();
    expect(stored).toEqual(kind === "stored" ? { repeat_until: end } : null);
    const { results } = await env.DB.prepare("SELECT DISTINCT repeat_until FROM stream_events WHERE series_id=?")
      .bind(seriesId)
      .all();
    expect(results).toEqual([{ repeat_until: end }]);
    await topUpSeries(env, Date.now() + 30 * day);
    expect((await streamsOf(seriesId)).map((row) => row.starts_at)).toEqual(kept);
  });

  it("keeps an edit to this and the following streams made while the cron tops the series up", async () => {
    const all = await weekly();
    const seriesId = all[0].seriesId;
    const from = new Date(all[2].startsAt);
    const racing = ownerRacesCron(() =>
      patchEvent(env, "owner", all[2].id, {
        action: "edit",
        scope: "following",
        ...input(from),
        title: "New format",
        time: "20:00",
        repeatDays: 1 << from.getUTCDay(),
      }),
    );
    await expect(topUpSeries(racing, Date.now() + 14 * day)).resolves.toBe(0);
    expect(
      await env.DB.prepare("SELECT title, hour, minute FROM stream_series WHERE id=?").bind(seriesId).first(),
    ).toEqual({ title: "New format", hour: 20, minute: 0 });
    const edited = (rows: { title: string; starts_at: number }[]): boolean =>
      rows.slice(2).every((row) => row.title === "New format" && new Date(row.starts_at).getUTCHours() === 20);
    const rows = await streamsOf(seriesId);
    expect(rows.slice(0, 2).map((row) => row.title)).toEqual(["Variety night", "Variety night"]);
    expect(edited(rows)).toBe(true);
    expect(await topUpSeries(env, Date.now() + 14 * day)).toBe(2);
    expect(edited(await streamsOf(seriesId))).toBe(true);
  });

  it("keeps a series' own time after a stream that fell in the spring gap", async (): Promise<void> => {
    // Created in December, a Sunday 02:30 New York series is first written only up to 8 March 2026, the day 02:30
    // does not exist (that stream is at 03:30 EDT). The next ones go back to 02:30.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2025, 11, 1));
    try {
      const first = await createEvents(env, "owner", {
        ...input(new Date(Date.UTC(2026, 2, 8)), { repeatDays: 1, time: "02:30", tz: "America/New_York" }),
      });
      expect(new Date(first.startsAt).toISOString()).toBe("2026-03-08T07:30:00.000Z");
      expect(
        await env.DB.prepare("SELECT hour, minute FROM stream_series WHERE id=?").bind(first.seriesId).first(),
      ).toEqual({ hour: 2, minute: 30 });
      expect(await topUpSeries(env, Date.UTC(2026, 1, 1))).toBeGreaterThanOrEqual(1);
      const starts = (await seriesRows()).map((row) => new Date(row.starts_at).toISOString());
      expect(starts.slice(0, 3)).toEqual([
        "2026-03-08T07:30:00.000Z",
        "2026-03-15T06:30:00.000Z",
        "2026-03-22T06:30:00.000Z",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps topping up a series after one stream is moved a year ahead on its own", async (): Promise<void> => {
    const all = await weekly();
    const moved = new Date(all[1].startsAt + 365 * day);
    await patchEvent(env, "owner", all[1].id, { action: "edit", scope: "one", ...input(moved) });
    const newest = all.at(-1)!.startsAt;
    expect(await topUpSeries(env, Date.now() + 7 * day)).toBe(1);
    const starts = (await seriesRows()).map((row) => row.starts_at);
    expect(starts).toContain(newest + 7 * day);
    expect(starts.filter((start: number): boolean => start > newest && start < moved.getTime())).toEqual([
      newest + 7 * day,
    ]);
  });

  it("does not copy a stream edited or cancelled on its own into later ones", async (): Promise<void> => {
    const all = await weekly();
    const newest = all.at(-1)!;
    await patchEvent(env, "owner", newest.id, {
      action: "edit",
      scope: "one",
      ...input(new Date(newest.startsAt)),
      title: "Special",
      time: "21:00",
    });
    await patchEvent(env, "owner", all.at(-2)!.id, { action: "cancel" });
    expect(await topUpSeries(env, Date.now() + 7 * day)).toBe(1);
    const added = (await seriesRows()).at(-1)!;
    expect(added.title).toBe("Variety night");
    expect(new Date(added.starts_at).getUTCHours()).toBe(18);
    expect(added.starts_at - all.at(-1)!.startsAt).toBe(7 * day);
  });

  it("refuses writes on a frozen page and from viewers", async (): Promise<void> => {
    await expect(createEvents(env, "viewer", input(new Date(Date.now() + day)))).rejects.toMatchObject({ status: 403 });
    await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(streamerId).run();
    await expect(createEvents(env, "owner", input(new Date(Date.now() + day)))).rejects.toMatchObject({ status: 423 });
    await expect(createEvents(env, "owner", { ...input(new Date()), url: "http://twitch.tv/x" })).rejects.toMatchObject(
      {
        status: 400,
      },
    );
  });

  it("lists every upcoming stream of four daily series after 90 days of history", async (): Promise<void> => {
    const now = Date.now();
    const range = defaultRange(now);
    const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    const rows: D1PreparedStatement[] = [];
    for (let series = 0; series < 4; series += 1)
      for (let offset = -90; offset < 84; offset += 1)
        rows.push(
          env.DB.prepare(`INSERT INTO stream_events (id,streamer_id,series_id,title,starts_at,duration_min,platform,url,
            status,repeat_days,tz,created_at,updated_at) VALUES (?,?,?,'Daily',?,60,'twitch','https://twitch.tv/nova',
            'scheduled',127,'UTC',?,?)`).bind(
            crypto.randomUUID(),
            streamerId,
            `series-${series}`,
            today + offset * day + (8 + series * 3) * 3_600_000,
            now,
            now,
          ),
        );
    await env.DB.batch(rows);
    const { n } = (await env.DB.prepare(
      "SELECT count(*) AS n FROM stream_events WHERE streamer_id=? AND starts_at >= ? AND starts_at < ?",
    )
      .bind(streamerId, now, range.to)
      .first<{ n: number }>())!;
    const events = await listEvents(env, streamerId, range.from, range.to, now);
    expect(events.filter((event: StreamEvent): boolean => event.startsAt >= now)).toHaveLength(n);
    expect(n).toBeGreaterThanOrEqual(332);
    // Recent history comes too, newest kept, and the list stays in time order.
    expect(events.some((event: StreamEvent): boolean => event.startsAt < now && event.startsAt > now - day)).toBe(true);
    expect(events.map((event: StreamEvent): number => event.startsAt)).toEqual(
      events.map((event: StreamEvent): number => event.startsAt).sort((a: number, b: number): number => a - b),
    );
  });

  it("opens a shared stream link outside the loaded range, but only for this page", async (): Promise<void> => {
    const now = Date.now();
    const other = crypto.randomUUID();
    const ids = { ahead: crypto.randomUUID(), back: crypto.randomUUID(), elsewhere: crypto.randomUUID() };
    const row = (id: string, page: string, startsAt: number): D1PreparedStatement =>
      env.DB.prepare(`INSERT INTO stream_events (id,streamer_id,title,starts_at,duration_min,platform,url,tz,created_at,
        updated_at) VALUES (?,?,'Far',?,60,'twitch','https://twitch.tv/nova','UTC',?,?)`).bind(
        id,
        page,
        startsAt,
        now,
        now,
      );
    await env.DB.batch([
      env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'viewer','other','Other')").bind(other),
      row(ids.ahead, streamerId, now + 200 * day),
      row(ids.back, streamerId, now - 120 * day),
      row(ids.elsewhere, other, now + 3 * day),
    ]);
    const load = async (event: string) => {
      const url = `https://streambullets.com/@nova?view=schedule&event=${event}`;
      const context = new RouterContextProvider();
      const pageEnv = { ...env, APP_ORIGIN: "https://streambullets.com", BETTER_AUTH_SECRET: "s".repeat(32) } as AppEnv;
      context.set(appContext, { env: pageEnv, nonce: "nonce", responseHeaders: new Headers() });
      return streamerLoader({
        request: new Request(url),
        params: { handle: "@nova" },
        context,
        url: new URL(url),
        pattern: "/:handle",
      });
    };
    for (const id of [ids.ahead, ids.back]) {
      const data = await load(id);
      expect(data.openEvent).toBe(id);
      expect(data.events.some((event: StreamEvent): boolean => event.id === id)).toBe(false);
      expect(data.linkedEvent?.id).toBe(id);
    }
    expect((await load(ids.elsewhere)).linkedEvent).toBeNull();
  });

  it("serves past and cancelled streams in the calendar feed", async (): Promise<void> => {
    const event = await createEvents(env, "owner", input(new Date(Date.now() + 2 * day)));
    await patchEvent(env, "owner", event.id, { action: "cancel" });
    const text = await scheduleCalendar(
      env,
      { id: streamerId, name: "Nova", handle: "nova" },
      "https://streambullets.com",
    );
    expect(text).toContain(`UID:${event.id}@streambullets.com`);
    expect(text).toContain("STATUS:CANCELLED");
    expect(text).toContain("Topics and polls: https://streambullets.com/@nova");
  });
});
