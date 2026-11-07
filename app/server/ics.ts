/**
 * iCalendar (RFC 5545) output for a streamer's schedule. Pure: the worker route serves the whole calendar and the
 * browser builds a one-event file for "Add to calendar". Times are written in UTC, so no VTIMEZONE is needed.
 */

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

/** Escapes a TEXT value: backslash, semicolon, comma and line breaks. Other control characters are dropped. */
export function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", String.raw`\;`)
    .replaceAll(",", String.raw`\,`)
    .replaceAll(/\r\n|\r|\n/g, String.raw`\n`)
    .replaceAll(/[^\P{Cc}\t]/gu, "");
}

/**
 * A URI or other non-TEXT value. It has no escapes, so every control character goes, CR and LF above all: one of
 * them would end the content line and start a new property (security review finding 2).
 */
export function plainValue(value: string): string {
  return value.replaceAll(/\p{Cc}/gu, "");
}

/** SEQUENCE counts seconds from here, so it fits a 32-bit integer for decades and grows with each change. */
export const SEQUENCE_EPOCH = Date.UTC(2026, 0, 1);

/**
 * The revision number calendar apps compare before they apply an update (RFC 5545 3.8.7.4). Some apps ignore an
 * update or a cancellation that does not raise it. It comes from `updated_at`, which every change sets.
 */
export function icsSequence(updatedAt: number): number {
  return Math.max(0, Math.floor((updatedAt - SEQUENCE_EPOCH) / 1000));
}

const encoder = new TextEncoder();

/**
 * Folds a content line so no physical line is longer than 75 octets: continuation lines start with one space.
 * Never splits a UTF-8 character.
 */
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

/** `20261105T180000Z` */
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
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//StreamBullets//Stream schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(`${name} · streams`)}`,
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
