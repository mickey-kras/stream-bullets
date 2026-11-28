import { describe, expect, it } from "vitest";
import { CHANNEL_PLATFORMS } from "../db/enums";
import { PLATFORM_CAPABILITIES, type ActivityPlatform } from "../app/lib/activity";
import { BUCKET_MS, MAX_SESSION_MS } from "../app/lib/stream-session";
import {
  DIRECT_TIPS_READY,
  ESTIMATE_METHOD,
  MAX_BUCKETS,
  MAX_CURRENCIES,
  MAX_SESSION_PEOPLE,
  PEOPLE_LOOKBACK_DAYS,
  PLATFORM_SUPPORT,
  REPORT_CAPABILITIES,
  REPORT_FORMATS,
  REPORT_METRICS,
  SCHEDULE_ONLY_REPORTS,
  STREAM_REPORT_RETENTION_DAYS,
  STREAM_REPORT_RETENTION_MS,
  SUPPORT_METRICS,
  contributorEstimate,
  isNotAvailable,
  isSupportMetric,
  metricCell,
  notAvailableNote,
  sessionSummarySchema,
  sessionTimelineSchema,
  type NotAvailableCell,
  type PlatformSummary,
  type ReportCell,
  type SessionSummary,
  type SessionTimeline,
} from "../app/lib/stream-report";

// The report of a stream session: what each platform gives, the cells, the estimate, and the stored schemas.

const DAY = 86_400_000;
const START: number = Date.UTC(2026, 10, 28, 18, 0, 0);

const twitch: PlatformSummary = {
  chatMessages: 1200,
  removedMessages: 7,
  peopleInChat: 140,
  atLeast: false,
  contributors: { total: 150, seenBefore: 90 },
  support: {
    events: { follow: 30, subscription: 12, gift: 2, bits: 9, raid: 1 },
    amounts: { subscription: 40, gift: 15, bits: 2500, raid: 85 },
    money: {},
    anonymous: 1,
  },
};

const summary = (change: Partial<SessionSummary> = {}): SessionSummary => ({
  v: 1,
  startedAt: START,
  endedAt: START + 3 * 3_600_000,
  startedBy: "twitch",
  endedBy: "provider",
  title: "Ranked games",
  platforms: {
    twitch,
    youtube: { ...twitch, atLeast: true, support: null },
    kick: { ...twitch, contributors: null },
  },
  page: { pollVotes: 320, topicsFeatured: 4, authorsCredited: 3 },
  historySince: START - 200 * DAY,
  ...change,
});

const value = (cell: ReportCell): number | null => (isNotAvailable(cell) ? null : cell.value);

describe("the current values of the open decisions", (): void => {
  it("has one named value for each decision", (): void => {
    expect(STREAM_REPORT_RETENTION_DAYS).toBe(365);
    expect(STREAM_REPORT_RETENTION_MS).toBe(365 * DAY);
    expect(ESTIMATE_METHOD).toBe("page_hmac_keys");
    expect(PEOPLE_LOOKBACK_DAYS).toEqual({ twitch: 90, youtube: 30, kick: 90 });
    expect(REPORT_FORMATS).toEqual(["csv"]);
    expect(SCHEDULE_ONLY_REPORTS).toBe("with_activity");
    expect(DIRECT_TIPS_READY).toBe(false);
    expect(MAX_BUCKETS).toBe(MAX_SESSION_MS / BUCKET_MS);
    expect(MAX_BUCKETS).toBe(288);
  });
});

describe("what each platform gives", (): void => {
  it("takes removed messages from the platform capabilities", (): void => {
    for (const platform of CHANNEL_PLATFORMS)
      expect(REPORT_CAPABILITIES[platform].removed_messages).toBe(PLATFORM_CAPABILITIES[platform].delete);
    expect(REPORT_CAPABILITIES.kick.removed_messages).toBe(false);
  });

  it("takes the support metrics from the support kinds of each platform", (): void => {
    for (const platform of CHANNEL_PLATFORMS)
      for (const metric of REPORT_METRICS.filter(isSupportMetric))
        expect(REPORT_CAPABILITIES[platform][metric], `${platform} ${metric}`).toBe(
          PLATFORM_SUPPORT[platform].includes(SUPPORT_METRICS[metric].kind),
        );
    expect(REPORT_CAPABILITIES.youtube.super_chats).toBe(true);
    expect(REPORT_CAPABILITIES.twitch.super_chats).toBe(false);
    expect(REPORT_CAPABILITIES.youtube.follows).toBe(false);
    expect(REPORT_CAPABILITIES.kick.kicks).toBe(true);
  });

  it("gives chat, people, and the estimate on each platform", (): void => {
    for (const platform of CHANNEL_PLATFORMS)
      for (const metric of ["chat_messages", "people_in_chat", "first_time", "returning"] as const)
        expect(REPORT_CAPABILITIES[platform][metric]).toBe(true);
  });
});

describe("the cells of a report", (): void => {
  it("gives the counts of a platform", (): void => {
    const report: SessionSummary = summary();
    expect(metricCell("twitch", "chat_messages", report)).toEqual({
      value: 1200,
      unit: "messages",
      atLeast: false,
      estimate: false,
    });
    expect(value(metricCell("twitch", "removed_messages", report))).toBe(7);
    expect(metricCell("twitch", "people_in_chat", report)).toMatchObject({ value: 140, unit: "people" });
    expect(metricCell("twitch", "first_time", report)).toEqual({
      value: 60,
      unit: "people",
      atLeast: false,
      estimate: true,
    });
    expect(value(metricCell("twitch", "returning", report))).toBe(90);
  });

  it("counts events for subscriptions and raids, and amounts for gifts and Bits", (): void => {
    const report: SessionSummary = summary();
    expect(metricCell("twitch", "subscriptions", report)).toMatchObject({ value: 12, unit: "events" });
    expect(metricCell("twitch", "raids", report)).toMatchObject({ value: 1, unit: "events" });
    expect(metricCell("twitch", "gifts", report)).toMatchObject({ value: 15, unit: "gifts" });
    expect(metricCell("twitch", "bits", report)).toMatchObject({ value: 2500, unit: "bits" });
    expect(metricCell("kick", "kicks", report)).toMatchObject({ value: 0, unit: "kicks" });
  });

  it("says at least when a limit or a gap can make the counts low", (): void => {
    const report: SessionSummary = summary();
    expect(metricCell("youtube", "chat_messages", report)).toMatchObject({ atLeast: true });
    const full: SessionSummary = summary({
      platforms: { twitch: { ...twitch, peopleInChat: MAX_SESSION_PEOPLE } },
    });
    expect(metricCell("twitch", "people_in_chat", full)).toMatchObject({ atLeast: true });
    expect(metricCell("twitch", "chat_messages", full)).toMatchObject({ atLeast: false });
  });

  it("is not available, with the name of the platform and the reason", (): void => {
    const report: SessionSummary = summary({
      platforms: { twitch, kick: { ...twitch, contributors: null, support: null } },
    });
    const cases: [ActivityPlatform, (typeof REPORT_METRICS)[number], NotAvailableCell, string][] = [
      ["kick", "removed_messages", { notAvailable: "kick", why: "not_offered" }, "Not available on Kick: the platform"],
      [
        "twitch",
        "super_chats",
        { notAvailable: "twitch", why: "not_offered" },
        "Not available on Twitch: the platform",
      ],
      [
        "youtube",
        "chat_messages",
        { notAvailable: "youtube", why: "not_in_session" },
        "Not available on YouTube: the channel",
      ],
      ["kick", "follows", { notAvailable: "kick", why: "support_not_read" }, "Reconnect the channel."],
      ["kick", "first_time", { notAvailable: "kick", why: "no_history" }, "no history of people"],
    ];
    for (const [platform, metric, cell, note] of cases) {
      const result: ReportCell = metricCell(platform, metric, report);
      expect(result, `${platform} ${metric}`).toEqual(cell);
      expect(isNotAvailable(result) ? notAvailableNote(result) : "").toContain(note);
    }
  });
});

describe("the estimate of first-time and returning contributors", (): void => {
  it("counts the people that the page did not see before as first-time", (): void => {
    expect(contributorEstimate("twitch", { total: 10, seenBefore: 4 }, START - 100 * DAY, START)).toEqual({
      firstTime: 6,
      returning: 4,
      lookbackDays: 90,
      historyStartsAt: START - 100 * DAY,
      historyComplete: true,
    });
    expect(contributorEstimate("kick", { total: 0, seenBefore: 0 }, START - 90 * DAY, START)).toMatchObject({
      firstTime: 0,
      returning: 0,
      historyComplete: true,
    });
  });

  it("says when the history does not cover the look-back time yet", (): void => {
    expect(contributorEstimate("twitch", { total: 5, seenBefore: 1 }, START - 10 * DAY, START)).toMatchObject({
      historyStartsAt: START - 10 * DAY,
      historyComplete: false,
    });
    expect(contributorEstimate("youtube", { total: 5, seenBefore: 1 }, START - 31 * DAY, START)).toMatchObject({
      lookbackDays: 30,
      historyComplete: true,
    });
    expect(contributorEstimate("kick", { total: 3, seenBefore: 0 }, null, START)).toMatchObject({
      firstTime: 3,
      historyStartsAt: START,
      historyComplete: false,
    });
    expect(contributorEstimate("kick", { total: 3, seenBefore: 0 }, START + DAY, START).historyStartsAt).toBe(START);
  });

  it("refuses counts that are not valid", (): void => {
    for (const counts of [
      { total: 3, seenBefore: 4 },
      { total: 3, seenBefore: -1 },
      { total: 2.5, seenBefore: 1 },
      { total: 3, seenBefore: Number.NaN },
    ])
      expect(() => contributorEstimate("twitch", counts, null, START)).toThrow(RangeError);
  });
});

describe("the stored summary and timeline", (): void => {
  const timeline: SessionTimeline = {
    v: 1,
    bucketMs: BUCKET_MS,
    start: START,
    chat: { twitch: [10, 20] },
    support: { twitch: [0, 1] },
    votes: [0, 5],
    intervals: [{ platform: "twitch", from: START, to: START + BUCKET_MS * 2, endedBy: "provider" }],
    gaps: [{ platform: "twitch", reason: "outage", from: START + 60_000, to: START + 120_000 }],
    markers: [{ at: START + 90_000, kind: "topic" }],
  };

  it("accepts a valid summary, a live summary, and a valid timeline", (): void => {
    expect(sessionSummarySchema.safeParse(summary()).success).toBe(true);
    expect(sessionSummarySchema.safeParse(summary({ endedAt: null, endedBy: null })).success).toBe(true);
    expect(sessionTimelineSchema.safeParse(timeline).success).toBe(true);
  });

  it("refuses a summary that does not agree with itself", (): void => {
    const many: Record<string, number> = {};
    for (let index = 0; index <= MAX_CURRENCIES; index++) many[`A${String.fromCharCode(65 + index)}A`] = 1;
    const invalid: SessionSummary[] = [
      summary({ endedBy: null }),
      summary({ endedAt: START - 1 }),
      summary({ platforms: { twitch: { ...twitch, contributors: { total: 1, seenBefore: 2 } } } }),
      summary({ platforms: { twitch: { ...twitch, peopleInChat: MAX_SESSION_PEOPLE + 1 } } }),
      summary({
        platforms: { twitch: { ...twitch, support: { events: {}, amounts: {}, money: many, anonymous: 0 } } },
      }),
      summary({
        platforms: { twitch: { ...twitch, support: { events: {}, amounts: {}, money: { usd: 1 }, anonymous: 0 } } },
      }),
      summary({ title: "t".repeat(141) }),
    ];
    for (const report of invalid) expect(sessionSummarySchema.safeParse(report).success).toBe(false);
  });

  it("refuses a timeline with another bucket size, too many buckets, or a reversed gap", (): void => {
    const invalid: unknown[] = [
      { ...timeline, bucketMs: 60_000 },
      { ...timeline, votes: new Array<number>(MAX_BUCKETS + 1).fill(0) },
      { ...timeline, gaps: [{ platform: "twitch", reason: "outage", from: START + 2, to: START + 1 }] },
      { ...timeline, intervals: [{ platform: "twitch", from: START + 2, to: START + 1, endedBy: "provider" }] },
      { ...timeline, markers: [{ at: START, kind: "raid" }] },
    ];
    for (const value of invalid) expect(sessionTimelineSchema.safeParse(value).success).toBe(false);
  });
});
