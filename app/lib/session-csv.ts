import { CHANNEL_PLATFORMS } from "../../db/enums";
import type { ActivityPlatform } from "./activity";
import {
  REPORT_CAPABILITIES,
  REPORT_METRICS,
  REPORT_PLATFORM_NAMES,
  contributorEstimate,
  isNotAvailable,
  isSupportMetric,
  metricCell,
  notAvailableNote,
  sessionReportSchema,
  type ContributorEstimate,
  type PlatformSummary,
  type ReportCell,
  type ReportMetric,
  type SessionReport,
  type SessionSummary,
  type SessionTimeline,
  type SupportMetric,
} from "./stream-report";

/**
 * The CSV of a stream report (docs/stream-reports.md#csv). It is in long format: one value on each row. Times are
 * UTC in ISO 8601. The file is UTF-8 with a byte order mark, so a spreadsheet reads the encoding. The fields follow
 * RFC 4180. The input has counts only: no names and no IDs of people, so the CSV can have none.
 */

export const CSV_COLUMNS = ["section", "platform", "metric", "start", "end", "value", "unit", "note"] as const;
export const CSV_SECTIONS = [
  "session",
  "totals",
  "contributors",
  "support",
  "timeline",
  "live",
  "gaps",
  "markers",
] as const;
export type CsvSection = (typeof CSV_SECTIONS)[number];

/** The byte order mark at the start of the file. */
export const CSV_BOM = "﻿";
/** RFC 4180 ends each line with CRLF. */
const CRLF = "\r\n";

/** One row of the CSV. `platform` is `all` for the session and `page` for the counts of the page. */
export interface CsvRow {
  section: CsvSection;
  platform: ActivityPlatform | "page" | "all";
  metric: string;
  start: number | null;
  end: number | null;
  value: string;
  unit: string;
  note: string;
}

/** A spreadsheet runs a cell that starts with one of these as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One field. A field that a spreadsheet could run as a formula gets a leading apostrophe. A field with a quote, a
 * comma, or a line break is in quotes, and its quotes are doubled.
 */
export function csvField(value: string): string {
  const safe: string = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function isoTime(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toISOString();
}

/** A money amount in micros as a decimal, without a float: 12 500 000 is `12.50`. */
export function formatMicros(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new RangeError(`Money amount is not valid: ${micros}`);
  const whole: number = Math.floor(micros / 1_000_000);
  const digits: string = String(micros % 1_000_000).padStart(6, "0");
  // The trailing zeros go, but the cents stay.
  let end: number = digits.length;
  while (end > 2 && digits[end - 1] === "0") end -= 1;
  return `${whole}.${digits.slice(0, end)}`;
}

function cellRow(
  section: CsvSection,
  platform: ActivityPlatform,
  metric: ReportMetric,
  cell: ReportCell,
  summary: SessionSummary,
  note: string,
): CsvRow {
  const base = { section, platform, metric, start: summary.startedAt, end: summary.endedAt };
  if (isNotAvailable(cell)) return { ...base, value: "", unit: "", note: notAvailableNote(cell) };
  const atLeast: string = cell.atLeast ? "At least this many." : "";
  return { ...base, value: String(cell.value), unit: cell.unit, note: [atLeast, note].filter(Boolean).join(" ") };
}

function sessionRows(summary: SessionSummary): CsvRow[] {
  const end: number | null = summary.endedAt;
  const minutes: string = end === null ? "" : String(Math.floor((end - summary.startedAt) / 60_000));
  const ended: string = end === null ? "Live." : `Ended by ${summary.endedBy}.`;
  const how: string = `Started by ${summary.startedBy}. ${ended}`;
  const rows: CsvRow[] = [
    {
      section: "session",
      platform: "all",
      metric: "duration",
      start: summary.startedAt,
      end,
      value: minutes,
      unit: "minutes",
      note: how,
    },
  ];
  if (summary.title !== null) rows.push({ ...rows[0], metric: "title", value: summary.title, unit: "", note: "" });
  return rows;
}

function estimateNote(platform: ActivityPlatform, summary: SessionSummary, counts: PlatformSummary): string {
  if (counts.contributors === null) return "";
  const estimate: ContributorEstimate = contributorEstimate(
    platform,
    counts.contributors,
    summary.historySince,
    summary.startedAt,
  );
  if (estimate.historyComplete) return `Estimate. Look-back ${estimate.lookbackDays} days.`;
  return `Estimate. History starts ${isoTime(estimate.historyStartsAt).slice(0, 10)}.`;
}

/** The rows of one platform: totals, contributors, and support as the platform reported it. */
function platformRows(platform: ActivityPlatform, summary: SessionSummary, counts: PlatformSummary): CsvRow[] {
  const cell = (section: CsvSection, metric: ReportMetric, note: string = ""): CsvRow =>
    cellRow(section, platform, metric, metricCell(platform, metric, summary), summary, note);
  const rows: CsvRow[] = [
    cell("totals", "chat_messages"),
    cell("totals", "removed_messages"),
    cell("totals", "people_in_chat"),
  ];
  const note: string = estimateNote(platform, summary, counts);
  rows.push(cell("contributors", "first_time", note), cell("contributors", "returning", note));
  const reported = `As reported by ${REPORT_PLATFORM_NAMES[platform]}.`;
  const offered: SupportMetric[] = REPORT_METRICS.filter(isSupportMetric).filter(
    (metric: SupportMetric): boolean => REPORT_CAPABILITIES[platform][metric],
  );
  for (const metric of offered) rows.push(cell("support", metric, reported));
  if (counts.support === null) return rows;
  const span = { platform, start: summary.startedAt, end: summary.endedAt };
  for (const [currency, micros] of Object.entries(counts.support.money).sort(([a], [b]) => a.localeCompare(b)))
    rows.push({
      section: "support",
      ...span,
      metric: "money",
      value: formatMicros(micros),
      unit: currency,
      note: reported,
    });
  // Anonymous support is one count. No row names a supporter.
  rows.push({
    section: "support",
    ...span,
    metric: "anonymous_support",
    value: String(counts.support.anonymous),
    unit: "events",
    note: `${reported} A count only.`,
  });
  return rows;
}

function pageRows(summary: SessionSummary): CsvRow[] {
  const span = { section: "totals", platform: "page", start: summary.startedAt, end: summary.endedAt } as const;
  return [
    { ...span, metric: "poll_votes", value: String(summary.page.pollVotes), unit: "votes", note: "" },
    { ...span, metric: "topics_featured", value: String(summary.page.topicsFeatured), unit: "topics", note: "" },
    { ...span, metric: "authors_credited", value: String(summary.page.authorsCredited), unit: "authors", note: "" },
  ];
}

function bucketRows(
  platform: ActivityPlatform | "page",
  metric: string,
  unit: string,
  counts: readonly number[],
  timeline: SessionTimeline,
): CsvRow[] {
  return counts.map(
    (value: number, index: number): CsvRow => ({
      section: "timeline",
      platform,
      metric,
      start: timeline.start + index * timeline.bucketMs,
      end: timeline.start + (index + 1) * timeline.bucketMs,
      value: String(value),
      unit,
      note: "",
    }),
  );
}

function timelineRows(timeline: SessionTimeline): CsvRow[] {
  const rows: CsvRow[] = [];
  for (const platform of CHANNEL_PLATFORMS) {
    rows.push(
      ...bucketRows(platform, "chat_messages", "messages", timeline.chat[platform] ?? [], timeline),
      ...bucketRows(platform, "support_events", "events", timeline.support[platform] ?? [], timeline),
    );
  }
  rows.push(...bucketRows("page", "poll_votes", "votes", timeline.votes, timeline));
  for (const interval of timeline.intervals)
    rows.push({
      section: "live",
      platform: interval.platform,
      metric: "live",
      start: interval.from,
      end: interval.to,
      value: "",
      unit: "",
      note: `Ended by ${interval.endedBy}.`,
    });
  for (const gap of timeline.gaps)
    rows.push({
      section: "gaps",
      platform: gap.platform,
      metric: gap.reason,
      start: gap.from,
      end: gap.to,
      value: "",
      unit: "",
      note: "",
    });
  for (const marker of timeline.markers)
    rows.push({
      section: "markers",
      platform: "page",
      metric: marker.kind,
      start: marker.at,
      end: marker.at,
      value: "1",
      unit: "",
      note: "",
    });
  return rows;
}

/**
 * The rows of a report. Each platform that was live in the session has its rows, in the order of CHANNEL_PLATFORMS.
 * Direct tips have no row while `DIRECT_TIPS_READY` is false.
 */
export function reportRows(report: SessionReport): CsvRow[] {
  const { summary, timeline } = sessionReportSchema.parse(report);
  const rows: CsvRow[] = [...sessionRows(summary)];
  for (const platform of CHANNEL_PLATFORMS) {
    const counts: PlatformSummary | undefined = summary.platforms[platform];
    if (counts) rows.push(...platformRows(platform, summary, counts));
  }
  rows.push(...pageRows(summary), ...timelineRows(timeline));
  return rows;
}

export function csvLine(fields: readonly string[]): string {
  return fields.map(csvField).join(",");
}

/** The CSV file of a report: the byte order mark, the header, and one line for each row. */
export function sessionCsv(report: SessionReport): string {
  const lines: string[] = [csvLine(CSV_COLUMNS)];
  for (const row of reportRows(report))
    lines.push(
      csvLine([
        row.section,
        row.platform,
        row.metric,
        isoTime(row.start),
        isoTime(row.end),
        row.value,
        row.unit,
        row.note,
      ]),
    );
  return `${CSV_BOM}${lines.join(CRLF)}${CRLF}`;
}
