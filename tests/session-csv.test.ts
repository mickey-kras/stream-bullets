import { describe, expect, it } from "vitest";
import { BUCKET_MS } from "../app/lib/stream-session";
import {
  CSV_BOM,
  CSV_COLUMNS,
  csvField,
  csvLine,
  formatMicros,
  isoTime,
  reportRows,
  sessionCsv,
  type CsvRow,
} from "../app/lib/session-csv";
import type { PlatformSummary, SessionReport, SessionSummary } from "../app/lib/stream-report";

// The CSV of a stream report: long format, BOM, UTC times, RFC 4180 fields, and the guard against formulas.

const DAY = 86_400_000;
const START: number = Date.UTC(2026, 10, 28, 18, 0, 0);
const END: number = START + 2 * 3_600_000 + 30 * 60_000;

const twitch: PlatformSummary = {
  chatMessages: 900,
  removedMessages: 3,
  peopleInChat: 80,
  atLeast: true,
  contributors: { total: 85, seenBefore: 50 },
  support: { events: { follow: 4, subscription: 2 }, amounts: { subscription: 7 }, money: {}, anonymous: 0 },
};

const youtube: PlatformSummary = {
  chatMessages: 400,
  removedMessages: 0,
  peopleInChat: 30,
  atLeast: false,
  contributors: { total: 32, seenBefore: 10 },
  support: {
    events: { super_chat: 3, membership: 1 },
    amounts: { membership: 1 },
    money: { USD: 12_500_000, EUR: 1_234_567 },
    anonymous: 2,
  },
};

const kick: PlatformSummary = { ...twitch, atLeast: false, contributors: null, support: null };

function report(change: Partial<SessionSummary> = {}): SessionReport {
  return {
    summary: {
      v: 1,
      startedAt: START,
      endedAt: END,
      startedBy: "twitch",
      endedBy: "provider",
      title: '=HYPERLINK("https://example.test", "Ranked, games")',
      platforms: { twitch, youtube, kick },
      page: { pollVotes: 120, topicsFeatured: 2, authorsCredited: 2 },
      historySince: START - 10 * DAY,
      ...change,
    },
    timeline: {
      v: 1,
      bucketMs: BUCKET_MS,
      start: START,
      chat: { twitch: [5, 6], youtube: [1] },
      support: { twitch: [0, 2] },
      votes: [3],
      intervals: [{ platform: "twitch", from: START, to: END, endedBy: "provider" }],
      gaps: [{ platform: "twitch", reason: "outage", from: START + 600_000, to: START + 1_200_000 }],
      markers: [{ at: START + 300_000, kind: "topic" }],
    },
  };
}

const rows = (value: SessionReport = report()): CsvRow[] => reportRows(value);
const find = (list: readonly CsvRow[], platform: string, metric: string): CsvRow | undefined =>
  list.find((row: CsvRow): boolean => row.platform === platform && row.metric === metric);

describe("one CSV field", (): void => {
  it("quotes commas, quotes, and line breaks as RFC 4180 says", (): void => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("one\ntwo")).toBe('"one\ntwo"');
    expect(csvField("")).toBe("");
  });

  it("puts an apostrophe before a field that a spreadsheet would run as a formula", (): void => {
    // A field with a line break is in quotes: the apostrophe is the first character in them.
    for (const start of ["=", "+", "-", "@", "\t", "\r"])
      expect(csvField(`${start}1`).replace(/^"/, "").startsWith("'"), JSON.stringify(start)).toBe(true);
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("\rx")).toBe('"\'\rx"');
    expect(csvField('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvField("a=1")).toBe("a=1");
    expect(csvLine(["=x", "y,z"])).toBe('\'=x,"y,z"');
  });
});

describe("values", (): void => {
  it("writes times in UTC ISO 8601, and money as a decimal without a float", (): void => {
    expect(isoTime(START)).toBe("2026-11-28T18:00:00.000Z");
    expect(isoTime(null)).toBe("");
    expect(formatMicros(12_500_000)).toBe("12.50");
    expect(formatMicros(1_234_567)).toBe("1.234567");
    expect(formatMicros(0)).toBe("0.00");
    expect(formatMicros(5_000_000)).toBe("5.00");
    expect(formatMicros(10_000)).toBe("0.01");
    for (const wrong of [-1, 1.5, Number.NaN]) expect(() => formatMicros(wrong)).toThrow(RangeError);
  });
});

describe("the CSV file", (): void => {
  const csv: string = sessionCsv(report());
  const lines: string[] = csv.slice(CSV_BOM.length).split("\r\n");

  it("is UTF-8 with a byte order mark, a header, and CRLF line ends", (): void => {
    expect(csv.startsWith("﻿")).toBe(true);
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines[0]).toBe("section,platform,metric,start,end,value,unit,note");
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(lines.at(-1)).toBe("");
    expect(lines).toHaveLength(rows().length + 2);
  });

  it("guards the title against formula injection", (): void => {
    expect(lines).toContain(
      "session,all,title,2026-11-28T18:00:00.000Z,2026-11-28T20:30:00.000Z," +
        '"\'=HYPERLINK(""https://example.test"", ""Ranked, games"")",,',
    );
    expect(lines.some((line: string): boolean => line.split(",").some((field: string) => field.startsWith("=")))).toBe(
      false,
    );
  });

  it("has the session, its duration, and how it started and ended", (): void => {
    expect(lines[1]).toBe(
      "session,all,duration,2026-11-28T18:00:00.000Z,2026-11-28T20:30:00.000Z,150,minutes,Started by twitch. Ended by provider.",
    );
    const live: CsvRow[] = rows(report({ endedAt: null, endedBy: null, title: null }));
    expect(find(live, "all", "duration")).toMatchObject({ value: "", end: null, note: "Started by twitch. Live." });
    expect(find(live, "all", "title")).toBeUndefined();
  });

  it("writes Not available with the name of the platform", (): void => {
    expect(find(rows(), "kick", "removed_messages")).toMatchObject({
      section: "totals",
      value: "",
      note: "Not available on Kick: the platform does not report it.",
    });
    expect(find(rows(), "kick", "follows")?.note).toContain("Not available on Kick");
    expect(find(rows(), "kick", "first_time")?.note).toContain("no history of people");
    expect(find(rows(), "twitch", "super_chats")).toBeUndefined();
  });

  it("says at least and estimate, with the start of the history", (): void => {
    expect(find(rows(), "twitch", "chat_messages")).toMatchObject({ value: "900", note: "At least this many." });
    expect(find(rows(), "youtube", "chat_messages")?.note).toBe("");
    expect(find(rows(), "twitch", "first_time")).toMatchObject({
      section: "contributors",
      value: "35",
      note: "At least this many. Estimate. History starts 2026-11-18.",
    });
    const complete: CsvRow[] = rows(report({ historySince: START - 100 * DAY }));
    expect(find(complete, "youtube", "returning")).toMatchObject({ value: "10", note: "Estimate. Look-back 30 days." });
  });

  it("writes support as the platform reported it, money in each currency, and anonymous support as a count", () => {
    expect(find(rows(), "youtube", "super_chats")).toMatchObject({ value: "3", note: "As reported by YouTube." });
    const money: CsvRow[] = rows().filter((row: CsvRow): boolean => row.metric === "money");
    expect(money.map((row: CsvRow) => [row.platform, row.value, row.unit])).toEqual([
      ["youtube", "1.234567", "EUR"],
      ["youtube", "12.50", "USD"],
    ]);
    expect(find(rows(), "youtube", "anonymous_support")).toMatchObject({
      section: "support",
      value: "2",
      unit: "events",
      note: "As reported by YouTube. A count only.",
    });
    expect(find(rows(), "kick", "anonymous_support")).toBeUndefined();
  });

  it("has rows only for the platforms of the session", (): void => {
    const only: CsvRow[] = rows(report({ platforms: { youtube } }));
    expect(only.filter((row: CsvRow): boolean => row.section === "totals").map((row: CsvRow) => row.platform)).toEqual([
      "youtube",
      "youtube",
      "youtube",
      "page",
      "page",
      "page",
    ]);
  });

  it("has the counts of the page", (): void => {
    expect(find(rows(), "page", "poll_votes")).toMatchObject({ section: "totals", value: "120", unit: "votes" });
    expect(find(rows(), "page", "topics_featured")?.value).toBe("2");
    expect(find(rows(), "page", "authors_credited")?.value).toBe("2");
  });

  it("has the buckets, the live intervals, the gaps, and the markers of the timeline", (): void => {
    const timeline: CsvRow[] = rows().filter((row: CsvRow): boolean => row.section === "timeline");
    expect(timeline.map((row: CsvRow) => [row.platform, row.metric, row.value])).toEqual([
      ["twitch", "chat_messages", "5"],
      ["twitch", "chat_messages", "6"],
      ["twitch", "support_events", "0"],
      ["twitch", "support_events", "2"],
      ["youtube", "chat_messages", "1"],
      ["page", "poll_votes", "3"],
    ]);
    expect(timeline[1]).toMatchObject({ start: START + BUCKET_MS, end: START + 2 * BUCKET_MS });
    expect(lines).toContain("live,twitch,live,2026-11-28T18:00:00.000Z,2026-11-28T20:30:00.000Z,,,Ended by provider.");
    expect(lines).toContain("gaps,twitch,outage,2026-11-28T18:10:00.000Z,2026-11-28T18:20:00.000Z,,,");
    expect(lines).toContain("markers,page,topic,2026-11-28T18:05:00.000Z,2026-11-28T18:05:00.000Z,1,,");
  });

  it("holds no field that the input types do not have", (): void => {
    const named = { ...report(), summary: { ...report().summary, supporters: ["Tess", "user-123"] } };
    const text: string = sessionCsv(named);
    expect(text).not.toContain("Tess");
    expect(text).not.toContain("user-123");
  });

  it("refuses a report that is not valid", (): void => {
    const wrong: SessionReport = report({ endedAt: START - 1 });
    expect(() => sessionCsv(wrong)).toThrow();
  });
});
