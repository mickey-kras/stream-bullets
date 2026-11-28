import { z } from "zod";
import { CHANNEL_PLATFORMS } from "../../db/enums";
import {
  PLATFORM_CAPABILITIES,
  STREAM_TITLE_LENGTH,
  SUPPORT_KINDS,
  type ActivityPlatform,
  type SupportKind,
  type SupportTotals,
} from "./activity";
import {
  BUCKET_MS,
  GAP_REASONS,
  MAX_INTERVALS,
  MAX_SESSION_MS,
  SESSION_ENDS,
  SESSION_STARTS,
  liveIntervalSchema,
  type GapReason,
  type LiveInterval,
  type SessionEnd,
  type SessionStart,
} from "./stream-session";

/**
 * The report of a stream session (issue #1047, docs/stream-reports.md): the stored summary and timeline, which
 * metric each platform gives, the cells of the report, and the estimate of first-time and returning contributors.
 * This module is pure. The report holds counts only: no names, no platform user IDs, and no person keys.
 */

const DAY_MS = 86_400_000;

// The current values of the owner's open decisions. Each decision changes one line here. -------------------------

/** How long a finished report stays, from its end. The current value. */
export const STREAM_REPORT_RETENTION_DAYS = 365;
export const STREAM_REPORT_RETENTION_MS = STREAM_REPORT_RETENTION_DAYS * DAY_MS;

/**
 * How the report tells first-time from returning contributors. The current value: one HMAC-SHA256 key for each
 * person of each page, kept for the look-back time of the platform (`PEOPLE_LOOKBACK_DAYS`).
 */
export const ESTIMATE_METHOD = "page_hmac_keys" as const;

/** How long a person key stays after the person's last session, in days, for each platform. The current values. */
export const PEOPLE_LOOKBACK_DAYS: Readonly<Record<ActivityPlatform, number>> = { twitch: 90, youtube: 30, kick: 90 };

/** The download formats of a report. The current value: CSV only. */
export const REPORT_FORMATS = ["csv"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/**
 * When a stream of the schedule without a session gets a report. The current value: only with activity, that is
 * one poll vote, one featured topic, or one event at least.
 */
export const SCHEDULE_ONLY_REPORTS = "with_activity" as const;

/** Direct tips through StreamBullets are not in a report until payments are ready. */
export const DIRECT_TIPS_READY = false;

// Bounds ------------------------------------------------------------------------------------------------------------

/** The most distinct people that one session counts. At the limit, the report says "at least". */
export const MAX_SESSION_PEOPLE = 100_000;
/** The most person keys that one page keeps for the estimate. */
export const MAX_PAGE_PEOPLE = 200_000;
/** The longest summary and timeline, as JSON. */
export const MAX_SUMMARY_LENGTH = 16_384;
export const MAX_TIMELINE_LENGTH = 98_304;
/** The buckets of the longest session. */
export const MAX_BUCKETS = MAX_SESSION_MS / BUCKET_MS;
export const MAX_GAPS = 300;
export const MAX_MARKERS = 200;
export const MAX_CURRENCIES = 16;

// What each platform gives ------------------------------------------------------------------------------------------

/** The support kinds that each platform sends (app/server/channel-support.ts). */
export const PLATFORM_SUPPORT: Readonly<Record<ActivityPlatform, readonly SupportKind[]>> = {
  twitch: ["follow", "subscription", "gift", "bits", "raid"],
  youtube: ["membership", "gift", "super_chat", "super_sticker"],
  kick: ["follow", "subscription", "gift", "kicks"],
};

/** The metrics of one platform in a report, in the order of the report. */
export const REPORT_METRICS = [
  "chat_messages",
  "removed_messages",
  "people_in_chat",
  "first_time",
  "returning",
  "follows",
  "subscriptions",
  "memberships",
  "gifts",
  "raids",
  "bits",
  "super_chats",
  "super_stickers",
  "kicks",
] as const;
export type ReportMetric = (typeof REPORT_METRICS)[number];

export type SupportMetric = Exclude<
  ReportMetric,
  "chat_messages" | "removed_messages" | "people_in_chat" | "first_time" | "returning"
>;

/** The units of the values of a report. A money value has its ISO 4217 code as its unit instead. */
export const REPORT_UNITS = [
  "messages",
  "people",
  "events",
  "gifts",
  "bits",
  "kicks",
  "votes",
  "topics",
  "authors",
] as const;
export type ReportUnit = (typeof REPORT_UNITS)[number];

/**
 * How each support metric reads the support totals. `events` counts events: a subscription and a membership count
 * one, not their months. `amount` sums the native amount: gifts in the bundles, Bits, or KICKs.
 */
export const SUPPORT_METRICS: Readonly<
  Record<SupportMetric, { kind: SupportKind; measure: "events" | "amount"; unit: ReportUnit }>
> = {
  follows: { kind: "follow", measure: "events", unit: "events" },
  subscriptions: { kind: "subscription", measure: "events", unit: "events" },
  memberships: { kind: "membership", measure: "events", unit: "events" },
  gifts: { kind: "gift", measure: "amount", unit: "gifts" },
  raids: { kind: "raid", measure: "events", unit: "events" },
  bits: { kind: "bits", measure: "amount", unit: "bits" },
  super_chats: { kind: "super_chat", measure: "events", unit: "events" },
  super_stickers: { kind: "super_sticker", measure: "events", unit: "events" },
  kicks: { kind: "kicks", measure: "amount", unit: "kicks" },
};

export function isSupportMetric(metric: ReportMetric): metric is SupportMetric {
  return metric in SUPPORT_METRICS;
}

function capabilitiesOf(platform: ActivityPlatform): Readonly<Record<ReportMetric, boolean>> {
  const offers = (metric: SupportMetric): boolean => PLATFORM_SUPPORT[platform].includes(SUPPORT_METRICS[metric].kind);
  return {
    chat_messages: true,
    removed_messages: PLATFORM_CAPABILITIES[platform].delete,
    people_in_chat: true,
    first_time: true,
    returning: true,
    follows: offers("follows"),
    subscriptions: offers("subscriptions"),
    memberships: offers("memberships"),
    gifts: offers("gifts"),
    raids: offers("raids"),
    bits: offers("bits"),
    super_chats: offers("super_chats"),
    super_stickers: offers("super_stickers"),
    kicks: offers("kicks"),
  };
}

/**
 * Which metric each platform gives. Removed messages come from `PLATFORM_CAPABILITIES.delete`: Kick does not tell a
 * deleted message. The support metrics come from `PLATFORM_SUPPORT`. A false entry shows as "Not available".
 */
export const REPORT_CAPABILITIES: Readonly<Record<ActivityPlatform, Readonly<Record<ReportMetric, boolean>>>> = {
  twitch: capabilitiesOf("twitch"),
  youtube: capabilitiesOf("youtube"),
  kick: capabilitiesOf("kick"),
};

/** The names of the platforms in the report and the CSV. */
export const REPORT_PLATFORM_NAMES: Readonly<Record<ActivityPlatform, string>> = {
  twitch: "Twitch",
  youtube: "YouTube",
  kick: "Kick",
};

// The stored summary and timeline -----------------------------------------------------------------------------------

/** The support of one platform in a session. Anonymous support is only a count. */
export interface SupportSummary extends SupportTotals {
  /** The number of events from supporters who asked to stay anonymous. */
  anonymous: number;
}

/** The counts of one platform in a session. */
export interface PlatformSummary {
  chatMessages: number;
  removedMessages: number;
  peopleInChat: number;
  /** True when a limit or a gap can make the counts low. The report then says "at least". */
  atLeast: boolean;
  /** The people who chatted or supported with a sender, and how many of them the page saw before. Null: no keys. */
  contributors: { total: number; seenBefore: number } | null;
  /** Null when the connection did not read support events. */
  support: SupportSummary | null;
}

/** The counts of the page itself. */
export interface PageSummary {
  pollVotes: number;
  topicsFeatured: number;
  authorsCredited: number;
}

/** The summary of a session. The server freezes it at the end. */
export interface SessionSummary {
  v: 1;
  startedAt: number;
  /** Null while the session is live. */
  endedAt: number | null;
  startedBy: SessionStart;
  endedBy: SessionEnd | null;
  title: string | null;
  platforms: Partial<Record<ActivityPlatform, PlatformSummary>>;
  page: PageSummary;
  /** When the page started to keep person keys, or null when this is the first session that keeps them. */
  historySince: number | null;
}

/** A gap of one platform in a session. */
export interface SessionGap {
  platform: ActivityPlatform;
  reason: GapReason;
  from: number;
  to: number;
}

/** A thing that happened at one time. `topic`: the owner put a topic on stream. */
export const MARKER_KINDS = ["topic"] as const;
export interface TimelineMarker {
  at: number;
  kind: (typeof MARKER_KINDS)[number];
}

/**
 * The timeline of a session. Bucket `i` of each list starts at `start + i * bucketMs`. `chat` and `support` count
 * the events of each platform. `votes` counts the poll votes of the page.
 */
export interface SessionTimeline {
  v: 1;
  bucketMs: typeof BUCKET_MS;
  start: number;
  chat: Partial<Record<ActivityPlatform, number[]>>;
  support: Partial<Record<ActivityPlatform, number[]>>;
  votes: number[];
  intervals: LiveInterval[];
  gaps: SessionGap[];
  markers: TimelineMarker[];
}

const platformSchema = z.enum(CHANNEL_PLATFORMS);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const kindCounts = z.partialRecord(z.enum(SUPPORT_KINDS), count);

const supportSummarySchema: z.ZodType<SupportSummary> = z.object({
  events: kindCounts,
  amounts: kindCounts,
  money: z
    .record(z.string().regex(/^[A-Z]{3}$/), count)
    .refine((money: Record<string, number>): boolean => Object.keys(money).length <= MAX_CURRENCIES),
  anonymous: count,
});

const platformSummarySchema: z.ZodType<PlatformSummary> = z.object({
  chatMessages: count,
  removedMessages: count,
  peopleInChat: count.max(MAX_SESSION_PEOPLE),
  atLeast: z.boolean(),
  contributors: z
    .object({ total: count, seenBefore: count })
    .refine((people: { total: number; seenBefore: number }): boolean => people.seenBefore <= people.total)
    .nullable(),
  support: supportSummarySchema.nullable(),
});

function fits(limit: number): (value: unknown) => boolean {
  return (value: unknown): boolean => JSON.stringify(value).length <= limit;
}

export const sessionSummarySchema: z.ZodType<SessionSummary> = z
  .object({
    v: z.literal(1),
    startedAt: time,
    endedAt: time.nullable(),
    startedBy: z.enum(SESSION_STARTS),
    endedBy: z.enum(SESSION_ENDS).nullable(),
    title: z.string().max(STREAM_TITLE_LENGTH).nullable(),
    platforms: z.partialRecord(platformSchema, platformSummarySchema),
    page: z.object({ pollVotes: count, topicsFeatured: count, authorsCredited: count }),
    historySince: time.nullable(),
  })
  .refine((summary: SessionSummary): boolean => (summary.endedAt === null) === (summary.endedBy === null))
  .refine((summary: SessionSummary): boolean => summary.endedAt === null || summary.startedAt <= summary.endedAt)
  .refine(fits(MAX_SUMMARY_LENGTH));

const buckets = z.array(count).max(MAX_BUCKETS);

export const sessionTimelineSchema: z.ZodType<SessionTimeline> = z
  .object({
    v: z.literal(1),
    bucketMs: z.literal(BUCKET_MS),
    start: time,
    chat: z.partialRecord(platformSchema, buckets),
    support: z.partialRecord(platformSchema, buckets),
    votes: buckets,
    intervals: z.array(liveIntervalSchema).max(MAX_INTERVALS),
    gaps: z
      .array(
        z
          .object({ platform: platformSchema, reason: z.enum(GAP_REASONS), from: time, to: time })
          .refine((gap: SessionGap): boolean => gap.from <= gap.to),
      )
      .max(MAX_GAPS),
    markers: z.array(z.object({ at: time, kind: z.enum(MARKER_KINDS) })).max(MAX_MARKERS),
  })
  .refine(fits(MAX_TIMELINE_LENGTH));

/** A finished or live report: the summary and its timeline. */
export interface SessionReport {
  summary: SessionSummary;
  timeline: SessionTimeline;
}

export const sessionReportSchema: z.ZodType<SessionReport> = z.object({
  summary: sessionSummarySchema,
  timeline: sessionTimelineSchema,
});

// The estimate ------------------------------------------------------------------------------------------------------

/** The estimate of the contributors of one platform in one session. */
export interface ContributorEstimate {
  firstTime: number;
  returning: number;
  /** How far back the page looks for a person on this platform. */
  lookbackDays: number;
  /** The start of the history that the estimate used. */
  historyStartsAt: number;
  /** False until the history covers the full look-back time: the report then says "History starts <date>". */
  historyComplete: boolean;
}

/**
 * First-time and returning contributors (`ESTIMATE_METHOD`). A contributor chatted, or supported with a sender, in
 * this session. A returning contributor has a key that the page saw in a session that ended in the look-back time.
 * Each other contributor is first-time. The count is an estimate: a person with two accounts is two people.
 */
export function contributorEstimate(
  platform: ActivityPlatform,
  contributors: { total: number; seenBefore: number },
  historySince: number | null,
  startedAt: number,
): ContributorEstimate {
  const { total, seenBefore } = contributors;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(seenBefore) || seenBefore < 0 || seenBefore > total)
    throw new RangeError(`Contributor counts are not valid: ${seenBefore} of ${total}`);
  const lookbackDays: number = PEOPLE_LOOKBACK_DAYS[platform];
  const historyStartsAt: number = Math.min(historySince ?? startedAt, startedAt);
  return {
    firstTime: total - seenBefore,
    returning: seenBefore,
    lookbackDays,
    historyStartsAt,
    historyComplete: historyStartsAt <= startedAt - lookbackDays * DAY_MS,
  };
}

// Cells -------------------------------------------------------------------------------------------------------------

/**
 * Why a cell has no value. `not_offered`: the API of the platform does not give it. `not_in_session`: the platform
 * was not live in the session. `support_not_read`: the connection did not read support events; reconnect it to
 * give the permissions. `no_history`: the page has no person keys for the platform, for example after a disconnect.
 */
export const NOT_AVAILABLE_REASONS = ["not_offered", "not_in_session", "support_not_read", "no_history"] as const;
export type NotAvailableReason = (typeof NOT_AVAILABLE_REASONS)[number];

export interface ValueCell {
  value: number;
  unit: ReportUnit;
  /** The true count can be higher: show "at least". */
  atLeast: boolean;
  /** The value is an estimate (`ESTIMATE_METHOD`). */
  estimate: boolean;
}

export interface NotAvailableCell {
  notAvailable: ActivityPlatform;
  why: NotAvailableReason;
}

export type ReportCell = ValueCell | NotAvailableCell;

export function isNotAvailable(cell: ReportCell): cell is NotAvailableCell {
  return "notAvailable" in cell;
}

/** The English note of a cell without a value, with the name of the platform. */
export function notAvailableNote(cell: NotAvailableCell): string {
  const name: string = REPORT_PLATFORM_NAMES[cell.notAvailable];
  switch (cell.why) {
    case "not_offered":
      return `Not available on ${name}: the platform does not report it.`;
    case "not_in_session":
      return `Not available on ${name}: the channel was not live in this session.`;
    case "support_not_read":
      return `Not available on ${name}: the connection does not read support events. Reconnect the channel.`;
    case "no_history":
      return `Not available on ${name}: the page has no history of people for this channel.`;
  }
}

function valueCell(value: number, unit: ReportUnit, atLeast: boolean, estimate: boolean = false): ValueCell {
  return { value, unit, atLeast, estimate };
}

function supportCell(metric: SupportMetric, support: SupportSummary, atLeast: boolean): ValueCell {
  const { kind, measure, unit } = SUPPORT_METRICS[metric];
  const value: number = (measure === "events" ? support.events[kind] : support.amounts[kind]) ?? 0;
  return valueCell(value, unit, atLeast);
}

/** The cell of one metric of one platform: a value, or why the platform has none. */
export function metricCell(platform: ActivityPlatform, metric: ReportMetric, summary: SessionSummary): ReportCell {
  if (!REPORT_CAPABILITIES[platform][metric]) return { notAvailable: platform, why: "not_offered" };
  const counts: PlatformSummary | undefined = summary.platforms[platform];
  if (!counts) return { notAvailable: platform, why: "not_in_session" };
  if (isSupportMetric(metric))
    return counts.support === null
      ? { notAvailable: platform, why: "support_not_read" }
      : supportCell(metric, counts.support, counts.atLeast);
  switch (metric) {
    case "chat_messages":
      return valueCell(counts.chatMessages, "messages", counts.atLeast);
    case "removed_messages":
      return valueCell(counts.removedMessages, "messages", counts.atLeast);
    case "people_in_chat":
      return valueCell(counts.peopleInChat, "people", counts.atLeast || counts.peopleInChat >= MAX_SESSION_PEOPLE);
    case "first_time":
    case "returning": {
      if (counts.contributors === null) return { notAvailable: platform, why: "no_history" };
      const estimate: ContributorEstimate = contributorEstimate(
        platform,
        counts.contributors,
        summary.historySince,
        summary.startedAt,
      );
      const value: number = metric === "first_time" ? estimate.firstTime : estimate.returning;
      return valueCell(value, "people", counts.atLeast, true);
    }
  }
}
