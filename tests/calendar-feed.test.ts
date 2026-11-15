import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../app/env";
import { isAllowedSupportLink } from "../app/lib/support";
import { isPlainUrlText } from "../app/lib/url-text";
import { buildCalendar, icsSequence, SEQUENCE_EPOCH, type IcsEvent } from "../app/server/ics";
import {
  createEvents,
  FEED_PAST_LIMIT,
  patchEvent,
  scheduleCalendar,
  UPCOMING_LIMIT,
} from "../app/server/schedule.server";
import { communityCardSchema, eventInputSchema, eventPatchSchema, isHttpsLink } from "../app/server/validation";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

// Calendar injection, revision ordering, and feed selection checks.

const day = 86_400_000;
const INJECTED =
  "https://twitch.tv/x\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Free subs\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nEND:VALARM";

function event(extra: Partial<IcsEvent> = {}): IcsEvent {
  return {
    id: "e1",
    title: "Boss rush",
    notes: "",
    startsAt: Date.UTC(2026, 10, 5, 18),
    durationMin: 90,
    url: "https://twitch.tv/nova",
    cancelled: false,
    updatedAt: Date.UTC(2026, 10, 1),
    ...extra,
  };
}

// Calendar content lines with folding removed.
function contentLines(text: string): string[] {
  return text.replaceAll("\r\n ", "").split("\r\n").filter(Boolean);
}

describe("links with control characters", (): void => {
  it("refuses CR, LF, tabs, spaces and invisible format characters inside a link", (): void => {
    for (const bad of [INJECTED, "https://twitch.tv/a\tb", "https://twitch.tv/a b", "https://twitch.tv/a​b"]) {
      expect([bad, isHttpsLink(bad)]).toEqual([bad, false]);
      expect([bad, isPlainUrlText(bad)]).toEqual([bad, false]);
      expect([bad, isAllowedSupportLink("twitch", bad.replace("/x", "/subs/x"))]).toEqual([bad, false]);
      expect([bad, isAllowedSupportLink("other", bad)]).toEqual([bad, false]);
    }
    expect(isHttpsLink("https://twitch.tv/nova")).toBe(true);
    expect(isAllowedSupportLink("twitch", "https://twitch.tv/subs/nova")).toBe(true);
  });

  it("refuses an injected event link and stores the parsed form of a good one", (): void => {
    const base = {
      title: "Variety night",
      date: "2026-11-20",
      time: "18:00",
      tz: "UTC",
      durationMin: 60,
      platform: "twitch",
    };
    expect(eventInputSchema.safeParse({ ...base, url: INJECTED }).success).toBe(false);
    expect(eventInputSchema.parse({ ...base, url: "  HTTPS://Twitch.TV/nova  " }).url).toBe("https://twitch.tv/nova");
    expect(eventPatchSchema.safeParse({ action: "replay", vodUrl: INJECTED }).success).toBe(false);
    expect(eventPatchSchema.parse({ action: "replay", vodUrl: "https://YouTube.com/watch?v=ab" })).toEqual({
      action: "replay",
      vodUrl: "https://youtube.com/watch?v=ab",
    });
  });

  it("normalises card button links and keeps tab targets", (): void => {
    const card = { title: "Join", body: "Come say hi", buttonLabel: "Go" };
    expect(communityCardSchema.safeParse({ ...card, buttonTarget: INJECTED }).success).toBe(false);
    expect(communityCardSchema.parse({ ...card, buttonTarget: "https://Example.com" }).buttonTarget).toBe(
      "https://example.com/",
    );
    expect(communityCardSchema.parse({ ...card, buttonTarget: "tab:topics" }).buttonTarget).toBe("tab:topics");
  });
});

describe("calendar content lines", (): void => {
  it("never lets a value start a new property, even when a bad link is already stored", (): void => {
    const text = buildCalendar("Nova\r\nX-EVIL:1", [
      event({ url: INJECTED, title: "Line\rbreak\u000B", notes: "One\rtwo\r\nthree\nfour", id: "e1\r\nX:1" }),
    ]);
    const lines = contentLines(text);
    expect(lines.filter((line: string): boolean => line === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines.filter((line: string): boolean => line.startsWith("BEGIN:VALARM"))).toHaveLength(0);
    expect(lines.some((line: string): boolean => line.startsWith("X-EVIL") || line.startsWith("X:"))).toBe(false);
    expect(lines).toContain(
      "URL:https://twitch.tv/xEND:VEVENTBEGIN:VEVENTSUMMARY:Free subsBEGIN:VALARMACTION:DISPLAYEND:VALARM",
    );
    // Escape bare CR as a line break; remove other control characters.
    expect(lines).toContain(String.raw`SUMMARY:Line\nbreak`);
    expect(lines).toContain(String.raw`DESCRIPTION:One\ntwo\nthree\nfour`);
    expect(lines).toContain("UID:e1X:1@streambullets.com");
    // Every physical line must end with CRLF and contain no other CR/LF.
    for (const line of text.split("\r\n")) expect(/[\r\n]/u.test(line)).toBe(false);
  });

  it("writes DTSTAMP from the last change and a SEQUENCE that grows with each change", (): void => {
    const now = Date.UTC(2026, 10, 2);
    const first = contentLines(buildCalendar("Nova", [event()], { now }));
    expect(first).toContain("DTSTAMP:20261101T000000Z");
    const sequence = icsSequence(Date.UTC(2026, 10, 1));
    expect(first).toContain(`SEQUENCE:${sequence}`);
    const later = contentLines(buildCalendar("Nova", [event({ updatedAt: Date.UTC(2026, 10, 1, 0, 0, 5) })], { now }));
    expect(later).toContain(`SEQUENCE:${sequence + 5}`);
    // Clamp future changes to now for DTSTAMP.
    expect(contentLines(buildCalendar("Nova", [event({ updatedAt: now + day })], { now }))).toContain(
      "DTSTAMP:20261102T000000Z",
    );
    expect(icsSequence(SEQUENCE_EPOCH - 1000)).toBe(0);
    expect(icsSequence(SEQUENCE_EPOCH + 1999)).toBe(1);
  });
});

describe("the calendar feed", (): void => {
  let database: TestDatabase;
  let env: AppEnv;
  const page = { id: "page-nova", name: "Nova", handle: "nova" };

  beforeAll(async (): Promise<void> => {
    database = await createTestDatabase();
    env = { DB: database.db } as AppEnv;
  });
  afterAll(async (): Promise<void> => database.dispose());
  beforeEach(async (): Promise<void> => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user"),
      env.DB.prepare("DELETE FROM app_rate_limits"),
      ...["owner", "other"].map((id: string) =>
        env.DB.prepare("INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)").bind(
          id,
          id,
          `${id}@example.test`,
          now,
          now,
        ),
      ),
      env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','nova','Nova')").bind(page.id),
      env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES ('page-other','other','other','Other')"),
    ]);
  });

  async function feed(now?: number): Promise<string[]> {
    return contentLines(await scheduleCalendar(env, page, "https://streambullets.com", now));
  }

  function input(date: Date, title: string): Record<string, unknown> {
    return {
      title,
      date: date.toISOString().slice(0, 10),
      time: "18:00",
      tz: "UTC",
      durationMin: 60,
      platform: "twitch",
      url: "https://twitch.tv/nova",
    };
  }

  it("holds only this page's streams, and raises SEQUENCE when a stream is cancelled", async (): Promise<void> => {
    const own = await createEvents(env, "owner", input(new Date(Date.now() + 2 * day), "Own stream"));
    const foreign = await createEvents(env, "other", input(new Date(Date.now() + 2 * day), "Other stream"));
    let lines = await feed();
    expect(lines).toContain(`UID:${own.id}@streambullets.com`);
    expect(lines).not.toContain(`UID:${foreign.id}@streambullets.com`);
    expect(lines.some((line: string): boolean => line.includes("Other stream"))).toBe(false);
    const before = Number(lines.find((line: string): boolean => line.startsWith("SEQUENCE:"))?.slice(9));
    await env.DB.prepare("UPDATE stream_events SET updated_at=updated_at-5000 WHERE id=?").bind(own.id).run();
    await patchEvent(env, "owner", own.id, { action: "cancel" });
    lines = await feed();
    const after = Number(lines.find((line: string): boolean => line.startsWith("SEQUENCE:"))?.slice(9));
    expect(after).toBeGreaterThanOrEqual(before);
    expect(lines).toContain("STATUS:CANCELLED");
  });

  it("keeps the furthest upcoming streams when the page has many past ones", async (): Promise<void> => {
    const now = Date.UTC(2026, 10, 7, 12);
    const rows = (count: number, first: number, step: number, prefix: string): D1PreparedStatement[] =>
      Array.from({ length: count }, (_: unknown, index: number) =>
        env.DB.prepare(`INSERT INTO stream_events (id,streamer_id,title,starts_at,duration_min,platform,url,tz,created_at,updated_at)
          VALUES (?,?,?,?,60,'twitch','https://twitch.tv/nova','UTC',?,?)`).bind(
          `${prefix}-${String(index).padStart(3, "0")}`,
          page.id,
          `${prefix} ${index}`,
          first + index * step,
          now,
          now,
        ),
      );
    // 150 past streams within 30 days; 450 upcoming within 12 weeks.
    await env.DB.batch(rows(150, now - 29 * day, 4 * 3_600_000, "past"));
    await env.DB.batch(rows(450, now + 3_600_000, 4 * 3_600_000, "next"));
    const uids = (await feed(now)).filter((line: string): boolean => line.startsWith("UID:"));
    expect(uids).toHaveLength(FEED_PAST_LIMIT + 450);
    expect(uids).toContain("UID:next-449@streambullets.com");
    expect(uids).toContain("UID:past-149@streambullets.com");
    expect(uids).not.toContain("UID:past-000@streambullets.com");
    expect(uids[0]).toBe(`UID:past-${String(150 - FEED_PAST_LIMIT).padStart(3, "0")}@streambullets.com`);
    expect(uids.at(-1)).toBe("UID:next-449@streambullets.com");
    expect(UPCOMING_LIMIT).toBeGreaterThanOrEqual(400);
  });
});
