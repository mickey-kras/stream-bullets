// UTC milliseconds; local dates are calendar days in an IANA zone.

export interface LocalDate {
  year: number;
  // 1..12
  month: number;
  day: number;
}

export interface ZonedParts extends LocalDate {
  hour: number;
  minute: number;
  // 0 = Sunday; 6 = Saturday
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

export function isValidZone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

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

// UTC offset in milliseconds: local minus UTC.
export function zoneOffset(time: number, zone: string): number {
  const p = zonedParts(time, zone);
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return local - Math.floor(time / 1000) * 1000;
}

// Resolve zoned wall time to UTC. Spring gaps move forward by the gap. Repeated autumn times use the offset
// at wall time interpreted as UTC: earlier west of UTC, later east.
export function zonedTime(date: LocalDate, hour: number, minute: number, zone: string): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const first = zoneOffset(guess, zone);
  const result = guess - first;
  const second = zoneOffset(result, zone);
  if (second === first) return result;
  const candidate = guess - second;
  const local = zonedParts(candidate, zone);
  if (local.hour === hour && local.minute === minute) return candidate;
  // Use the smaller offset to move past a spring gap.
  return guess - Math.min(first, second);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

// Zone-independent weekday: 0 = Sunday; 6 = Saturday.
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

// YYYY-MM-DD
export function formatDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

// Parse a real YYYY-MM-DD date; otherwise null.
export function parseDate(value: string): LocalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = addDays(date, 0);
  return compareDates(check, date) === 0 ? date : null;
}
