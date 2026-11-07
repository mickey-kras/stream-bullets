import type { CSSProperties, ReactNode } from "react";
import { intlLocale, t, tn } from "../../i18n";
import { addDays, localDateOf, weekdayOf, zonedParts, zonedTime, type LocalDate } from "../../lib/zoned";
import type { StreamEvent } from "../../types";
import { EmptyState } from "../common";
import { Icon } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { StatusTag } from "./schedule-feed";
import {
  dayOf,
  hourLabel,
  longDay,
  platformLabel,
  statusIcon,
  statusWord,
  timeOf,
  weekdayShort,
  zoneLabel,
} from "./format";

export type CalendarMode = "day" | "week" | "month";

const HOUR_PX = 48;
const FIRST_HOUR = 8;
const LAST_HOUR = 24;

/** 0 = Sunday. English starts the week on Sunday; Intl week info covers other locales where available. */
function firstWeekday(): number {
  const info = (new Intl.Locale(intlLocale()) as Intl.Locale & { weekInfo?: { firstDay: number } }).weekInfo;
  return info ? info.firstDay % 7 : 0;
}

function dayStart(date: LocalDate, zone: string): number {
  return zonedTime(date, 0, 0, zone);
}

/** The local days a view shows, as their midnights. */
export function visibleDays(mode: CalendarMode, anchor: number, zone: string): number[] {
  const date = localDateOf(anchor, zone);
  if (mode === "day") return [dayStart(date, zone)];
  if (mode === "week") {
    const first = addDays(date, -((weekdayOf(date) - firstWeekday() + 7) % 7));
    return Array.from({ length: 7 }, (_, index: number) => dayStart(addDays(first, index), zone));
  }
  const month = { year: date.year, month: date.month, day: 1 };
  const first = addDays(month, -((weekdayOf(month) - firstWeekday() + 7) % 7));
  return Array.from({ length: 42 }, (_, index: number) => dayStart(addDays(first, index), zone));
}

/** Moves the anchor one day, week or month. */
export function stepAnchor(mode: CalendarMode, anchor: number, zone: string, direction: number): number {
  const date = localDateOf(anchor, zone);
  if (mode === "month") {
    const shifted = new Date(Date.UTC(date.year, date.month - 1 + direction, 1));
    return dayStart({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: 1 }, zone);
  }
  return dayStart(addDays(date, direction * (mode === "week" ? 7 : 1)), zone);
}

function eventsOn(events: StreamEvent[], start: number, zone: string): StreamEvent[] {
  const end = dayStart(addDays(localDateOf(start, zone), 1), zone);
  return events.filter((event: StreamEvent) => event.startsAt >= start && event.startsAt < end);
}

export function CalendarNav({
  mode,
  days,
  zone,
  onStep,
  onToday,
}: Readonly<{
  mode: CalendarMode;
  days: number[];
  zone: string;
  onStep: (direction: number) => void;
  onToday: () => void;
}>): ReactNode {
  let title = longDay(days[0], zone);
  if (mode === "week") {
    const end = days[6];
    title = `${new Intl.DateTimeFormat(intlLocale(), { timeZone: zone, month: "short", day: "numeric" }).format(days[0])} – ${new Intl.DateTimeFormat(intlLocale(), { timeZone: zone, month: "short", day: "numeric", year: "numeric" }).format(end)}`;
  }
  if (mode === "month")
    title = new Intl.DateTimeFormat(intlLocale(), { timeZone: zone, month: "long", year: "numeric" }).format(days[15]);
  return (
    <div className="cal-nav">
      <div className="cal-nav-buttons">
        <IconButton label={t("schedule.previous")} icon="chevron-left" iconSize={18} onClick={() => onStep(-1)} />
        <button type="button" onClick={onToday}>
          {t("schedule.today")}
        </button>
        <IconButton label={t("schedule.next")} icon="chevron-right" iconSize={18} onClick={() => onStep(1)} />
      </div>
      <h2 className="cal-title" aria-live="polite">
        {title}
      </h2>
      <span className="muted cal-zone">{t("schedule.timesIn", { zone: zoneLabel(days[0], zone) })}</span>
    </div>
  );
}

function EventBlock({
  event,
  zone,
  onOpen,
}: Readonly<{ event: StreamEvent; zone: string; onOpen: (id: string) => void }>): ReactNode {
  const local = zonedParts(event.startsAt, zone);
  const top = Math.max(0, (local.hour + local.minute / 60 - FIRST_HOUR) * HOUR_PX);
  const height = Math.max(28, Math.min((event.durationMin / 60) * HOUR_PX, (LAST_HOUR - FIRST_HOUR) * HOUR_PX - top));
  return (
    <button
      type="button"
      className={`cal-event status-${event.status}`}
      style={{ top, minHeight: height, height }}
      onClick={() => onOpen(event.id)}
    >
      <span className="sr-only">
        {dayOf(event.startsAt, zone)}, {timeOf(event.startsAt, zone)},{" "}
      </span>
      <strong>{event.title}</strong>
      <span className="sr-only">, </span>
      <StatusTag event={event} className="cal-status" />
      <span className="sr-only">, </span>
      <span className="cal-meta">
        <span aria-hidden="true">{timeOf(event.startsAt, zone)} · </span>
        {platformLabel[event.platform]}
      </span>
    </button>
  );
}

/** Day and Week: an hour grid from 8 AM to midnight in the viewer's zone. */
export function TimeGrid({
  days,
  events,
  zone,
  now,
  onOpen,
}: Readonly<{ days: number[]; events: StreamEvent[]; zone: string; now: number; onOpen: (id: string) => void }>) {
  const today = dayStart(localDateOf(now, zone), zone);
  const nowLocal = zonedParts(now, zone);
  const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, index: number) => FIRST_HOUR + index);
  return (
    <section className="cal-scroll" aria-label={t("schedule.grid")}>
      <div className="cal-grid" style={{ "--days": days.length, "--hour": `${HOUR_PX}px` } as CSSProperties}>
        <div className="cal-corner" />
        {days.map((day: number) => (
          <div key={day} className={`cal-colhead${day === today ? " is-today" : ""}`}>
            <span>{weekdayShort(day, zone)}</span>
            <strong>{zonedParts(day, zone).day}</strong>
          </div>
        ))}
        <div className="cal-hours">
          {hours.map((hour: number) => (
            <div className="cal-hour" key={hour}>
              <span>{hourLabel(Date.UTC(2026, 0, 1, hour), "UTC")}</span>
            </div>
          ))}
        </div>
        {days.map((day: number) => (
          <div key={day} className={`cal-col${day === today ? " is-today" : ""}`}>
            {eventsOn(events, day, zone).map((event: StreamEvent) => (
              <EventBlock key={event.id} event={event} zone={zone} onOpen={onOpen} />
            ))}
            {day === today && nowLocal.hour >= FIRST_HOUR && (
              <span
                className="cal-now"
                style={{ top: (nowLocal.hour + nowLocal.minute / 60 - FIRST_HOUR) * HOUR_PX }}
                aria-hidden="true"
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function DayView(props: Readonly<Parameters<typeof TimeGrid>[0]>): ReactNode {
  if (eventsOn(props.events, props.days[0], props.zone).length === 0)
    return <EmptyState title={t("schedule.noStreamsDay")}>{t("schedule.noStreamsDayBody")}</EmptyState>;
  return <TimeGrid {...props} />;
}

function MonthCell({
  day,
  month,
  today,
  events,
  zone,
  onOpen,
  onDay,
}: Readonly<{
  day: number;
  month: number;
  today: number;
  events: StreamEvent[];
  zone: string;
  onOpen: (id: string) => void;
  onDay: (day: number) => void;
}>): ReactNode {
  const list = eventsOn(events, day, zone);
  const live = list.filter((event: StreamEvent) => event.status === "live").length;
  const parts = zonedParts(day, zone);
  const label = [
    longDay(day, zone),
    list.length ? tn("schedule.streams", list.length) : t("schedule.noStreams"),
    ...(live ? [tn("schedule.liveCount", live)] : []),
  ].join(", ");
  return (
    <td
      className={`month-cell${parts.month === month ? "" : " is-out"}${day === today ? " is-today" : ""}`}
      aria-current={day === today ? "date" : undefined}
    >
      <span className="month-date" aria-hidden="true">
        {parts.day}
      </span>
      <span className="sr-only month-sr">{longDay(day, zone)}</span>
      <div className="month-chips">
        {list.slice(0, 2).map((event: StreamEvent) => (
          <button
            key={event.id}
            type="button"
            className={`month-chip status-${event.status}`}
            onClick={() => onOpen(event.id)}
          >
            <Icon name={statusIcon[event.status]} size={16} />
            <span className="sr-only">{statusWord(event.status)}, </span>
            <span className="chip-time">{hourLabel(event.startsAt, zone)}</span> {event.title}
          </button>
        ))}
        {list.length > 2 && (
          <button type="button" className="month-more" onClick={() => onDay(day)}>
            {t("schedule.more", { count: list.length - 2 })}
            <span className="sr-only"> {longDay(day, zone)}</span>
          </button>
        )}
      </div>
      <button type="button" className="day-btn" onClick={() => onDay(day)}>
        <span className="sr-only">{label}</span>
      </button>
      <span className="month-bars" aria-hidden="true">
        {list.map((event: StreamEvent) => (
          <span key={event.id} className={`month-bar status-${event.status}`}>
            <Icon name={statusIcon[event.status]} size={16} />
          </span>
        ))}
      </span>
    </td>
  );
}

export function MonthGrid({
  days,
  events,
  zone,
  now,
  onOpen,
  onDay,
}: Readonly<{
  days: number[];
  events: StreamEvent[];
  zone: string;
  now: number;
  onOpen: (id: string) => void;
  onDay: (day: number) => void;
}>): ReactNode {
  const today = dayStart(localDateOf(now, zone), zone);
  const month = zonedParts(days[15], zone).month;
  const title = new Intl.DateTimeFormat(intlLocale(), { timeZone: zone, month: "long", year: "numeric" }).format(days[15]);
  return (
    <table className="month-grid">
      <caption className="sr-only">{title}</caption>
      <thead>
        <tr>
          {days.slice(0, 7).map((day: number) => (
            <th scope="col" key={day}>
              <abbr title={new Intl.DateTimeFormat(intlLocale(), { timeZone: zone, weekday: "long" }).format(day)}>
                {weekdayShort(day, zone)}
              </abbr>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {[0, 1, 2, 3, 4, 5].map((row: number) => (
          <tr key={row}>
            {days.slice(row * 7, row * 7 + 7).map((day: number) => (
              <MonthCell
                key={day}
                day={day}
                month={month}
                today={today}
                events={events}
                zone={zone}
                onOpen={onOpen}
                onDay={onDay}
              />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
