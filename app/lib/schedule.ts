import type { StreamEventStatus } from "../types";
import { addDays, compareDates, weekdayOf, zonedTime, type LocalDate } from "./zoned";

/** A weekly series is stored as one row per occurrence, generated this far ahead; the hourly cron tops it up. */
export const SERIES_HORIZON_MS = 12 * 7 * 86_400_000;

/** At most this many occurrences are written for one series in one go (12 weeks × 7 days). */
export const MAX_SERIES_BATCH = 84;

/** Weekday bitmask: bit 0 is Sunday … bit 6 is Saturday. */
export function hasWeekday(mask: number, weekday: number): boolean {
  return (mask & (1 << weekday)) !== 0;
}

export interface SeriesRule {
  /** First day the series may occur on (local to `zone`). */
  first: LocalDate;
  hour: number;
  minute: number;
  zone: string;
  /** Weekday bitmask, 1..127. */
  days: number;
  /** Last day (inclusive), or null for no end. */
  until: LocalDate | null;
}

/**
 * The start times of a weekly series from `rule.first` onwards, before `horizon` (UTC ms) and up to `rule.until`.
 * Every occurrence keeps the same wall-clock time in the series' zone, so a daylight-saving change moves the UTC
 * time, not the local one. No RRULE: each occurrence is a plain timestamp.
 */
export function expandSeries(rule: SeriesRule, horizon: number, limit: number = MAX_SERIES_BATCH): number[] {
  const starts: number[] = [];
  if (rule.days <= 0) return starts;
  for (let offset = 0; starts.length < limit && offset < 400; offset += 1) {
    const date = addDays(rule.first, offset);
    if (rule.until && compareDates(date, rule.until) > 0) break;
    if (!hasWeekday(rule.days, weekdayOf(date))) continue;
    const start = zonedTime(date, rule.hour, rule.minute, rule.zone);
    if (start >= horizon) break;
    starts.push(start);
  }
  return starts;
}

/**
 * What a stream shows as: cancelled and ended stay as stored; otherwise the clock decides between upcoming
 * (scheduled), live and ended.
 */
export function effectiveStatus(
  stored: StreamEventStatus,
  startsAt: number,
  durationMin: number,
  now: number,
): StreamEventStatus {
  if (stored === "cancelled" || stored === "ended") return stored;
  if (now < startsAt) return stored === "live" ? "live" : "scheduled";
  return now < startsAt + durationMin * 60_000 ? "live" : "ended";
}
