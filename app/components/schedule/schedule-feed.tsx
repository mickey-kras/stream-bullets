import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { t, tn } from "../../i18n";
import type { EventTopic, StreamEvent } from "../../types";
import { Icon } from "../ui/icon";
import { categoryIcon } from "../topic-icon";
import { upcomingRows } from "../../lib/schedule";
import {
  countdown,
  dayOf,
  durationLabel,
  platformIcon,
  platformLabel,
  repeatLabel,
  statusIcon,
  statusWord,
  timeOf,
  whenLine,
  zoneLabel,
} from "./format";

export function StatusTag({ event, className = "sched-badge" }: Readonly<{ event: StreamEvent; className?: string }>) {
  return (
    <span className={`${className} st-${event.status}`}>
      {event.status === "live" ? (
        <span className="live-pulse" aria-hidden="true" />
      ) : (
        <Icon name={statusIcon[event.status]} size={16} />
      )}
      <span className="st-word">{statusWord(event.status)}</span>
    </span>
  );
}

export function TopicChips({ topics, handle }: Readonly<{ topics: EventTopic[]; handle: string }>): ReactNode {
  if (topics.length === 0) return null;
  return (
    <div className="topic-chips" aria-label={t("schedule.linkedTopics")}>
      {topics.map((topic: EventTopic) => (
        <Link key={topic.id} className="topic-chip" to={`/@${handle}?view=topics&entry=${topic.id}`}>
          <Icon name={categoryIcon(topic.category)} size={18} />
          {topic.title}
        </Link>
      ))}
    </div>
  );
}

export function PlatformLink({ event, gold = false }: Readonly<{ event: StreamEvent; gold?: boolean }>): ReactNode {
  const label =
    event.status === "live"
      ? t("schedule.watchLive", { platform: platformLabel[event.platform] })
      : t("schedule.watchOn", { platform: platformLabel[event.platform] });
  return (
    <a
      className={`button-link${gold ? " gold" : ""} platform-link`}
      href={event.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      <Icon name={platformIcon[event.platform]} size={18} />
      {label}
      <span className="sr-only"> {t("common.newTab")}</span>
    </a>
  );
}

function EventRow({
  event,
  zone,
  onOpen,
}: Readonly<{ event: StreamEvent; zone: string; onOpen: (id: string) => void }>): ReactNode {
  const ended = event.status === "ended";
  const zoneName = zoneLabel(event.startsAt, zone);
  return (
    <li className={`sched-row status-${event.status}`}>
      <button type="button" className="sched-row-main" onClick={() => onOpen(event.id)}>
        <span className="sched-time">
          <strong>{timeOf(event.startsAt, zone)}</strong>
          <small>
            {zoneName}
            {zoneName === "UTC" ? "" : ` · ${timeOf(event.startsAt, "UTC")} UTC`}
          </small>
        </span>
        <span className="sched-info">
          <span className="sched-title-row">
            <span className="sched-title">{event.title}</span>
            {event.seriesId && (
              <span className="series-note"> · {t("schedule.every", { days: repeatLabel(event.repeatDays) })}</span>
            )}
          </span>
          <span className="sched-meta">
            <Icon name={platformIcon[event.platform]} size={18} />
            {platformLabel[event.platform]} · {durationLabel(event.durationMin)}
          </span>
        </span>
        <StatusTag event={event} />
      </button>
      {ended && (
        <span className="sched-row-action">
          {event.vodUrl ? (
            <a className="text-link" href={event.vodUrl} target="_blank" rel="noopener noreferrer">
              <Icon name="play" size={18} />
              {t("schedule.watchReplay")}
              <span className="sr-only"> {t("common.newTab")}</span>
            </a>
          ) : (
            <span className="muted">{t("schedule.noReplay")}</span>
          )}
        </span>
      )}
    </li>
  );
}

function groupByDay(events: StreamEvent[], zone: string): { day: string; items: StreamEvent[] }[] {
  const groups: { day: string; items: StreamEvent[] }[] = [];
  for (const event of events) {
    const day = dayOf(event.startsAt, zone);
    const group = groups.at(-1);
    if (group?.day === day) group.items.push(event);
    else groups.push({ day, items: [event] });
  }
  return groups;
}

function Hero({
  event,
  zone,
  now,
  handle,
  onOpen,
  onCalendar,
}: Readonly<{
  event: StreamEvent;
  zone: string;
  now: number;
  handle: string;
  onOpen: (id: string) => void;
  onCalendar: (event: StreamEvent) => void;
}>): ReactNode {
  const live = event.status === "live";
  return (
    <article className={`info-card sched-hero status-${event.status}`} aria-labelledby="up-next-title">
      <div className="sched-hero-top">
        <span className="eyebrow">{live ? t("schedule.onAir") : t("schedule.upNext")}</span>
        {live ? (
          <StatusTag event={event} />
        ) : (
          <span className="sched-countdown">
            <Icon name="timer" size={18} />
            {countdown(event.startsAt, now)}
          </span>
        )}
      </div>
      <h2 id="up-next-title">
        <button type="button" className="link-button" onClick={() => onOpen(event.id)}>
          {event.title}
        </button>
      </h2>
      <p className="sched-when">
        <Icon name="schedule" size={18} />
        {whenLine(event, zone)}
      </p>
      {event.notes && <p className="event-notes">{event.notes}</p>}
      <TopicChips topics={event.topics} handle={handle} />
      <div className="sched-actions">
        <PlatformLink event={event} gold={live} />
        <button type="button" onClick={() => onCalendar(event)}>
          <Icon name="schedule" size={18} />
          {t("schedule.addToCalendar")}
        </button>
      </div>
    </article>
  );
}

/** Feed: the live or next stream, upcoming streams by day (a series once, as its next date), past streams. */
export function ScheduleFeed({
  events,
  zone,
  now,
  handle,
  onOpen,
  onCalendar,
}: Readonly<{
  events: StreamEvent[];
  zone: string;
  now: number;
  handle: string;
  onOpen: (id: string) => void;
  onCalendar: (event: StreamEvent) => void;
}>): ReactNode {
  const [older, setOlder] = useState<boolean>(false);
  const next =
    events.find((event: StreamEvent) => event.status === "live") ??
    events.find((event: StreamEvent) => event.status === "scheduled" && event.startsAt > now);
  const upcoming = upcomingRows(events, next, now);
  const past = events
    .filter((event: StreamEvent) => event.status === "ended")
    .sort((a: StreamEvent, b: StreamEvent) => b.startsAt - a.startsAt);
  const shownPast = older ? past : past.slice(0, 2);
  return (
    <>
      {next && <Hero event={next} zone={zone} now={now} handle={handle} onOpen={onOpen} onCalendar={onCalendar} />}
      <section className="sched-upcoming" aria-labelledby="upcoming-title">
        <h2 id="upcoming-title">{t("schedule.upcoming")}</h2>
        {upcoming.length === 0 && <p className="muted">{t("schedule.nothingUpcoming")}</p>}
        {groupByDay(upcoming, zone).map((group) => (
          <section className="sched-day" key={group.day}>
            <h3>{group.day}</h3>
            <ul className="sched-list">
              {group.items.map((event: StreamEvent) => (
                <EventRow key={event.id} event={event} zone={zone} onOpen={onOpen} />
              ))}
            </ul>
          </section>
        ))}
      </section>
      {past.length > 0 && (
        <section className="sched-past" aria-labelledby="past-title">
          <h2 id="past-title">{t("schedule.past")}</h2>
          {shownPast.map((event: StreamEvent) => (
            <section className="sched-day" key={event.id}>
              <h3>{dayOf(event.startsAt, zone)}</h3>
              <ul className="sched-list">
                <EventRow event={event} zone={zone} onOpen={onOpen} />
              </ul>
            </section>
          ))}
          {past.length > shownPast.length && (
            <button type="button" className="load-more" onClick={() => setOlder(true)}>
              {tn("schedule.showOlder", past.length - shownPast.length)}
            </button>
          )}
        </section>
      )}
    </>
  );
}
