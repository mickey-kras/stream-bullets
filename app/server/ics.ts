// RFC 5545 schedules: Worker serves calendars; browser exports single events. UTC needs no VTIMEZONE.

export interface IcsEvent {
  id: string;
  title: string;
  notes: string;
  startsAt: number;
  durationMin: number;
  url: string;
  cancelled: boolean;
  updatedAt: number;
}

export const ICS_UID_DOMAIN = "streambullets.com";

// Escapes a TEXT value: backslash, semicolon, comma and line breaks. Other control characters are dropped.
export function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", String.raw`\;`)
    .replaceAll(",", String.raw`\,`)
    .replaceAll(/\r\n|\r|\n/g, String.raw`\n`)
    .replaceAll(/[^\P{Cc}\t]/gu, "");
}

// Strip controls from non-TEXT values; CR/LF could inject calendar properties.
export function plainValue(value: string): string {
  return value.replaceAll(/\p{Cc}/gu, "");
}

// Count SEQUENCE seconds from this epoch to fit a 32-bit integer for decades.
export const SEQUENCE_EPOCH = Date.UTC(2026, 0, 1);

// RFC 5545 3.8.7.4 revision from `updated_at`. Updates/cancellations must increase it or clients may ignore
// them.
export function icsSequence(updatedAt: number): number {
  return Math.max(0, Math.floor((updatedAt - SEQUENCE_EPOCH) / 1000));
}

const encoder = new TextEncoder();

// Fold at 75 octets without splitting UTF-8; prefix continuation lines with a space.
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const character of line) {
    const bytes = encoder.encode(character).length;
    const limit = out.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += character;
    size += bytes;
  }
  out.push(current);
  return out.join("\r\n ");
}

// `20261105T180000Z`
export function icsTime(time: number): string {
  return new Date(time)
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export function buildCalendar(
  name: string,
  events: readonly IcsEvent[],
  options: { pageUrl?: string; now?: number } = {},
): string {
  const now = options.now ?? Date.now();
  const calendarName: string = escapeText(`${name} · streams`);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//StreamBullets//Stream schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${calendarName}`,
  ];
  for (const event of events) {
    const description = [event.notes, options.pageUrl ? `Topics and polls: ${options.pageUrl}` : ""]
      .filter(Boolean)
      .join("\n\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${plainValue(event.id)}@${ICS_UID_DOMAIN}`,
      `DTSTAMP:${icsTime(Math.min(event.updatedAt || now, now))}`,
      `SEQUENCE:${icsSequence(event.updatedAt)}`,
      `DTSTART:${icsTime(event.startsAt)}`,
      `DTEND:${icsTime(event.startsAt + event.durationMin * 60_000)}`,
      `SUMMARY:${escapeText(event.title)}`,
      ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
      `URL:${plainValue(event.url)}`,
      `LOCATION:${escapeText(event.url)}`,
      `STATUS:${event.cancelled ? "CANCELLED" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
