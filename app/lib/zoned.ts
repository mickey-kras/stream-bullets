// Times are UTC milliseconds. A local date is a calendar day in an IANA zone.

export interface LocalDate {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
}

export interface ZonedParts extends LocalDate {
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(zone, value);
  }
  return value;
}

/** Whether the runtime knows this IANA zone name. */
export function isValidZone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The calendar fields of a moment in a zone. */
export function zonedParts(time: number, zone: string): ZonedParts & { second: number } {
  const parts: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(new Date(time))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdays[parts.weekday] ?? 0,
  };
}

/** The zone's offset from UTC at a moment, in milliseconds (local minus UTC). */
export function zoneOffset(time: number, zone: string): number {
  const p = zonedParts(time, zone);
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return local - Math.floor(time / 1000) * 1000;
}

/**
 * The UTC moment of a wall-clock time in a zone. Across a daylight-saving change the offset is re-read at the
 * result, so 19:00 in Berlin stays 19:00 on both sides of the switch. A time that does not exist (the hour skipped
 * in spring) moves forward by the gap.
 */
export function zonedTime(date: LocalDate, hour: number, minute: number, zone: string): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const first = zoneOffset(guess, zone);
  const result = guess - first;
  const second = zoneOffset(result, zone);
  return second === first ? result : guess - second;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday, for a calendar day (independent of any zone). */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export function localDateOf(time: number, zone: string): LocalDate {
  const { year, month, day } = zonedParts(time, zone);
  return { year, month, day };
}

/** Midnight at the start of the local day that contains `time`. */
export function startOfDay(time: number, zone: string): number {
  return zonedTime(localDateOf(time, zone), 0, 0, zone);
}

/** `YYYY-MM-DD` */
export function formatDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** Parses `YYYY-MM-DD`; null when it is not a real calendar day. */
export function parseDate(value: string): LocalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = addDays(date, 0);
  return compareDates(check, date) === 0 ? date : null;
}
