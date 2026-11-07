import { useSyncExternalStore } from "react";
import { locale, t } from "../../i18n";
import { hasWeekday } from "../../lib/schedule";
import type { StreamEvent, StreamEventStatus, StreamPlatform } from "../../types";
import type { IconName } from "../ui/icon";

const noop = (): (() => void) => () => undefined;

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The zone times show in: UTC while the server renders and during hydration, then the viewer's own zone. Reading it
 * through an external store keeps the first client render identical to the server's.
 */
export function useViewerZone(): string {
  return useSyncExternalStore(noop, browserZone, () => "UTC");
}

/** Week and Month need width: below 700px (43.75em) the page shows Feed and Day only. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    (change: () => void) => {
      const query = globalThis.matchMedia?.("(max-width: 43.75em)");
      query?.addEventListener("change", change);
      return () => query?.removeEventListener("change", change);
    },
    () => Boolean(globalThis.matchMedia?.("(max-width: 43.75em)").matches),
    () => false,
  );
}

export const platformLabel: Record<StreamPlatform, string> = {
  twitch: "Twitch",
  youtube: "YouTube",
  kick: "Kick",
  tiktok: "TikTok",
  other: "Other",
};

export const platformIcon: Record<StreamPlatform, IconName> = {
  twitch: "twitch",
  youtube: "youtube",
  kick: "kick",
  tiktok: "tiktok",
  other: "globe",
};

export const statusIcon: Record<StreamEventStatus, IconName> = {
  scheduled: "timer",
  live: "live",
  ended: "check",
  cancelled: "close",
};

export function statusWord(status: StreamEventStatus): string {
  return t(`schedule.status.${status}`);
}

function format(time: number, zone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { timeZone: zone, ...options }).format(new Date(time));
}

export function timeOf(time: number, zone: string): string {
  return format(time, zone, { hour: "numeric", minute: "2-digit" });
}

export function hourLabel(time: number, zone: string): string {
  return timeOf(time, zone).replace(":00", "");
}

export function dayOf(time: number, zone: string): string {
  return format(time, zone, { weekday: "short", month: "short", day: "numeric" });
}

export function longDay(time: number, zone: string): string {
  return format(time, zone, { weekday: "long", month: "long", day: "numeric" });
}

export function weekdayShort(time: number, zone: string): string {
  return format(time, zone, { weekday: "short" });
}

export function zoneLabel(time: number, zone: string): string {
  return (
    new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "short" })
      .formatToParts(new Date(time))
      .find((part: Intl.DateTimeFormatPart) => part.type === "timeZoneName")?.value ?? zone
  );
}

export function whenLine(event: StreamEvent, zone: string): string {
  const end = event.startsAt + event.durationMin * 60_000;
  return `${dayOf(event.startsAt, zone)} · ${timeOf(event.startsAt, zone)} – ${timeOf(end, zone)} · ${zoneLabel(event.startsAt, zone)}`;
}

function unit(value: number, name: "hour" | "minute"): string {
  return new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "short" }).format(value);
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return unit(minutes, "minute");
  const rest = minutes % 60;
  return `${unit(Math.floor(minutes / 60), "hour")}${rest ? ` ${unit(rest, "minute")}` : ""}`;
}

/** "Tue & Thu" for a weekday bitmask, in the viewer's language. Sunday 1 Nov 2026 anchors the weekday names. */
export function repeatLabel(mask: number): string {
  const names: string[] = [];
  for (let day = 0; day < 7; day += 1)
    if (hasWeekday(mask, day)) names.push(format(Date.UTC(2026, 10, 1 + day, 12), "UTC", { weekday: "short" }));
  return new Intl.ListFormat(locale, { style: "short", type: "conjunction" }).format(names);
}

/** "Starts in 2 days", "Starts in 3 hours", "Starts in 20 minutes". */
export function countdown(start: number, now: number): string {
  const diff = Math.max(0, start - now);
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  let text = relative.format(Math.round(diff / 60_000), "minute");
  if (diff >= 86_400_000) text = relative.format(Math.round(diff / 86_400_000), "day");
  else if (diff >= 3_600_000) text = relative.format(Math.round(diff / 3_600_000), "hour");
  return t("schedule.startsIn", { when: text });
}
