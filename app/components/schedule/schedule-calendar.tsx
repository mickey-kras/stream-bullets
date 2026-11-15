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
// Default grid: 08:00..24:00; expand for outlying streams.
const FIRST_HOUR = 8;
const LAST_HOUR = 24;
const MINUTE_MS = 60_000;

type Timed = Pick<StreamEvent, "startsAt" | "durationMin">;

// Sunday = 0. Use Intl locale week starts where available; English starts Sunday.
function firstWeekday(): number {
  const info = (new Intl.Locale(intlLocale()) as Intl.Locale & { weekInfo?: { firstDay: number } }).weekInfo;
  return info ? info.firstDay % 7 : 0;
}

function dayStart(date: LocalDate, zone: string): number {
  return zonedTime(date, 0, 0, zone);
}

// Use local midnights; DST days may span 23 or 25 hours.
function dayEnd(start: number, zone: string): number {
  return dayStart(addDays(localDateOf(start, zone), 1), zone);
}

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

// Fetch from the first local midnight through the last day's end.
export function visibleRange(mode: CalendarMode, anchor: number, zone: string): { from: number; to: number } {
  const days = visibleDays(mode, anchor, zone);
  return { from: days[0], to: dayEnd(days.at(-1)!, zone) };
}

export function stepAnchor(mode: CalendarMode, anchor: number, zone: string, direction: number): number {
  const date = localDateOf(anchor, zone);
  if (mode === "month") {
    const shifted = new Date(Date.UTC(date.year, date.month - 1 + direction, 1));
    return dayStart({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: 1 }, zone);
  }
  return dayStart(addDays(date, direction * (mode === "week" ? 7 : 1)), zone);
}

function endOf(event: Timed): number {
  return event.startsAt + event.durationMin * MINUTE_MS;
}

// Include streams overlapping any part of the local day, including overnight streams.
export function eventsOn<T extends Timed>(events: readonly T[], start: number, zone: string): T[] {
  const end = dayEnd(start, zone);
  return events.filter((event: T) => event.startsAt < end && (event.startsAt >= start || endOf(event) > start));
}

// Clip overnight starts to local midnight.
export function sliceOn(event: Timed, start: number): Timed {
  if (event.startsAt >= start) return event;
  return { startsAt: start, durationMin: (endOf(event) - start) / MINUTE_MS };
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

export interface GridHours {
  first: number;
  last: number;
}

// Local end hour may exceed 24.
function localHours(event: Timed, zone: string): [number, number] {
  const local = zonedParts(event.startsAt, zone);
  const start = local.hour + local.minute / 60;
  return [start, start + event.durationMin / 60];
}

// Expand 08:00..24:00 to fit visible day slices. Split overnight streams at midnight instead of overlapping
// the next day's top.
export function gridHours(slices: readonly Timed[], zone: string): GridHours {
  let first = FIRST_HOUR;
  for (const slice of slices) first = Math.min(first, Math.floor(localHours(slice, zone)[0]));
  return { first, last: LAST_HOUR };
}

export function blockPosition(event: Timed, zone: string, hours: GridHours): { top: number; height: number } {
  const top = Math.max(0, (localHours(event, zone)[0] - hours.first) * HOUR_PX);
  const height = Math.max(28, Math.min((event.durationMin / 60) * HOUR_PX, (hours.last - hours.first) * HOUR_PX - top));
  return { top, height };
}

export interface BlockLane {
  lane: number;
  lanes: number;
}

// Overlap chains share a lane count. Assign each block the first lane free at its start, preventing
// occlusion.
export function blockLanes(blocks: readonly { top: number; height: number }[]): BlockLane[] {
  const order: number[] = blocks.map((_, index: number) => index);
  order.sort((a: number, b: number) => blocks[a].top - blocks[b].top || blocks[b].height - blocks[a].height);
  const result: BlockLane[] = blocks.map(() => ({ lane: 0, lanes: 1 }));
  let ends: number[] = [];
  let cluster: number[] = [];
  const close = (): void => {
    for (const index of cluster) result[index].lanes = ends.length;
    ends = [];
    cluster = [];
  };
  for (const index of order) {
    const { top, height } = blocks[index];
    if (cluster.length > 0 && ends.every((end: number) => end <= top)) close();
    let lane: number = ends.findIndex((end: number) => end <= top);
    if (lane === -1) lane = ends.push(0) - 1;
    ends[lane] = top + height;
    result[index].lane = lane;
    cluster.push(index);
  }
  close();
  return result;
}

function laneStyle({ lane, lanes }: BlockLane): CSSProperties {
  if (lanes === 1) return {};
  return {
    left: `calc(4px + (100% - 8px) * ${lane} / ${lanes})`,
    right: "auto",
    width: `calc((100% - 8px) / ${lanes} - 2px)`,
  };
}

function EventBlock({
  event,
  slice,
  zone,
  hours,
  place,
  onOpen,
}: Readonly<{
  event: StreamEvent;
  slice: Timed;
  zone: string;
  hours: GridHours;
  place: BlockLane;
  onOpen: (id: string) => void;
}>): ReactNode {
  const { top, height } = blockPosition(slice, zone, hours);
  const startDay = slice.startsAt === event.startsAt ? "" : `${dayOf(event.startsAt, zone)}, `;
  return (
    <button
      type="button"
      className={`cal-event status-${event.status}${place.lanes > 1 ? " is-split" : ""}`}
      style={{ top, minHeight: height, height, ...laneStyle(place) }}
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
        <span aria-hidden="true">
          {startDay}
          {timeOf(event.startsAt, zone)} ·{" "}
        </span>
        {platformLabel[event.platform]}
      </span>
    </button>
  );
}

// Zoned Day/Week grid; expand beyond 08:00..24:00 when needed.
export function TimeGrid({
  days,
  events,
  zone,
  now,
  onOpen,
}: Readonly<{ days: number[]; events: StreamEvent[]; zone: string; now: number; onOpen: (id: string) => void }>) {
  const today = dayStart(localDateOf(now, zone), zone);
  const nowLocal = zonedParts(now, zone);
  const columns = days.map((day: number) => ({
    day,
    list: eventsOn(events, day, zone).map((event: StreamEvent) => ({ event, slice: sliceOn(event, day) })),
  }));
  const range = gridHours(
    columns.flatMap(({ list }) => list.map(({ slice }) => slice)),
    zone,
  );
  const nowHour = nowLocal.hour + nowLocal.minute / 60;
  const hours = Array.from({ length: range.last - range.first }, (_, index: number) => range.first + index);
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
        {columns.map(({ day, list }) => {
          const places: BlockLane[] = blockLanes(list.map(({ slice }) => blockPosition(slice, zone, range)));
          return (
            <div key={day} className={`cal-col${day === today ? " is-today" : ""}`}>
              {list.map(({ event, slice }, index: number) => (
                <EventBlock
                  key={event.id}
                  event={event}
                  slice={slice}
                  zone={zone}
                  hours={range}
                  place={places[index]}
                  onOpen={onOpen}
                />
              ))}
              {day === today && nowHour >= range.first && (
                <span className="cal-now" style={{ top: (nowHour - range.first) * HOUR_PX }} aria-hidden="true" />
              )}
            </div>
          );
        })}
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
  const title = new Intl.DateTimeFormat(intlLocale(), { timeZone: zone, month: "long", year: "numeric" }).format(
    days[15],
  );
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
