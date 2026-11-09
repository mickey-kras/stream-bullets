import type { StreamEvent, StreamEventStatus } from "../types";
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

/** The schedule's clock wakes this often before a mark: countdowns round to the nearest minute, hour or day. */
export const SCHEDULE_STEP_MS = 30_000;

export type Timed = Pick<StreamEvent, "status" | "startsAt" | "durationMin">;

/** The instants the schedule's display changes: each stream not yet ended or cancelled starts and ends. */
export function scheduleMarks(events: readonly Timed[]): number[] {
  const marks: number[] = [];
  for (const event of events)
    if (event.status !== "cancelled" && event.status !== "ended")
      marks.push(event.startsAt, event.startsAt + event.durationMin * 60_000);
  return marks;
}

/** The streams as they show at `now`: the loader's status moves on with the clock. */
export function statusesAt<T extends Timed>(events: readonly T[], now: number): T[] {
  return events.map((event: T): T => {
    const status = effectiveStatus(event.status, event.startsAt, event.durationMin, now);
    return status === event.status ? event : { ...event, status };
  });
}

/** The first stream live at `now`, by the clock rather than the status the loader stored. */
export function liveEventAt<T extends Timed>(events: readonly T[], now: number): T | null {
  return statusesAt(events, now).find((event: T) => event.status === "live") ?? null;
}

/**
 * The Upcoming list under the hero: one row per series, the next one still on, plus one-off streams.
 * A cancelled stream shows but never takes its series' place, so a cancellation cannot hide the next stream.
 * Live streams other than the hero come first (they started earlier), so overlapping streams never disappear.
 */
export function upcomingRows<T extends Pick<StreamEvent, "startsAt" | "status" | "seriesId">>(
  events: readonly T[],
  next: T | undefined,
  now: number,
): T[] {
  const taken = new Set<string>(next?.seriesId ? [next.seriesId] : []);
  return events.filter((event: T) => {
    if (event === next || (event.startsAt <= now && event.status !== "live")) return false;
    if (!event.seriesId || event.status === "cancelled") return true;
    if (taken.has(event.seriesId)) return false;
    taken.add(event.seriesId);
    return true;
  });
}
