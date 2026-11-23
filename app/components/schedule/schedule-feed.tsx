import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { t, tn } from "../../i18n";
import type { EventTopic, StreamEvent, StreamLink } from "../../types";
import { Icon } from "../ui/icon";
import { categoryIcon } from "../topic-icon";
import { upcomingRows } from "../../lib/schedule";
import {
  countdown,
  dayOf,
  durationLabel,
  platformIcon,
  platformLabel,
  platformsLabel,
  repeatLabel,
  statusIcon,
  statusWord,
  streamLinks,
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

/** The picture of a stream: the YouTube thumbnail fills the 16:9 frame, a Twitch cover sits in its middle. */
export function StreamPicture({ event, lazy = false }: Readonly<{ event: StreamEvent; lazy?: boolean }>): ReactNode {
  if (!event.image) return null;
  return (
    <span className={`sched-picture ${event.image.kind}`}>
      <img src={event.image.url} alt="" loading={lazy ? "lazy" : undefined} decoding="async" />
    </span>
  );
}

/** The Twitch category of a stream, with a small cover. */
export function CategoryChip({ event }: Readonly<{ event: StreamEvent }>): ReactNode {
  if (!event.category) return null;
  return (
    <span className="sched-category">
      {event.category.cover && <img src={event.category.cover} alt="" loading="lazy" decoding="async" />}
      {event.category.name}
    </span>
  );
}

export function PlatformLink({ event, gold = false }: Readonly<{ event: StreamEvent; gold?: boolean }>): ReactNode {
  return streamLinks(event).map((link: StreamLink) => (
    <a
      key={link.platform}
      className={`button-link${gold ? " gold" : ""} platform-link`}
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      <Icon name={platformIcon[link.platform]} size={18} />
      {event.status === "live"
        ? t("schedule.watchLive", { platform: platformLabel[link.platform] })
        : t("schedule.watchOn", { platform: platformLabel[link.platform] })}
      <span className="sr-only"> {t("common.newTab")}</span>
    </a>
  ));
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
        <StreamPicture event={event} lazy />
        <span className="sched-info">
          <span className="sched-title-row">
            <span className="sched-title">{event.title}</span>
            {event.seriesId && (
              <span className="series-note"> · {t("schedule.every", { days: repeatLabel(event.repeatDays) })}</span>
            )}
          </span>
          <span className="sched-meta">
            <CategoryChip event={event} />
            {streamLinks(event).map((link: StreamLink) => (
              <Icon key={link.platform} name={platformIcon[link.platform]} size={18} />
            ))}
            {platformsLabel(event)} · {durationLabel(event.durationMin)}
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
  // Before the stream, a calendar reminder is the main action; once it is live, watching is.
  const calendar = (
    <button type="button" className={live ? undefined : "gold"} onClick={() => onCalendar(event)}>
      <Icon name="schedule" size={18} />
      {t("schedule.addToCalendar")}
    </button>
  );
  return (
    <article
      className={`info-card sched-hero status-${event.status}${event.image ? " has-picture" : ""}`}
      aria-labelledby="up-next-title"
    >
      <StreamPicture event={event} />
      <div className="sched-hero-body">
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
        <CategoryChip event={event} />
        {event.notes && <p className="event-notes">{event.notes}</p>}
        <TopicChips topics={event.topics} handle={handle} />
        <div className="sched-actions">
          {!live && calendar}
          <PlatformLink event={event} gold={live} />
          {live && calendar}
        </div>
      </div>
    </article>
  );
}

// Live/next hero, upcoming dates (once per series), then past streams.
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
