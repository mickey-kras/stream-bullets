import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../../i18n";
import { statusesAt } from "../../lib/schedule";
import type { EventTopic, StreamEvent } from "../../types";
import { errorMessage, postJson, requestJson } from "../api";
import { EmptyState } from "../common";
import { Icon } from "../ui/icon";
import { Sheet } from "../ui/sheet";
import { useToast } from "../ui/toast";
import { useScheduleClock } from "../use-clock";
import { EventDialog, downloadEvent, type EventStep } from "./event-dialog";
import { useNarrow, useViewerZone } from "./format";
import {
  CalendarNav,
  DayView,
  MonthGrid,
  TimeGrid,
  stepAnchor,
  visibleDays,
  visibleRange,
  type CalendarMode,
} from "./schedule-calendar";
import { ScheduleFeed } from "./schedule-feed";
import { ScheduleForm, type EventBody } from "./schedule-form";

export type ScheduleMode = "feed" | CalendarMode;
export const scheduleModes: readonly ScheduleMode[] = ["feed", "day", "week", "month"];

const modeLabel: Record<ScheduleMode, string> = {
  feed: "schedule.mode.feed",
  day: "schedule.mode.day",
  week: "schedule.mode.week",
  month: "schedule.mode.month",
};

function merge(base: StreamEvent[], extra: StreamEvent[]): StreamEvent[] {
  const map = new Map<string, StreamEvent>(extra.map((event: StreamEvent) => [event.id, event]));
  for (const event of base) map.set(event.id, event);
  return [...map.values()].sort(
    (a: StreamEvent, b: StreamEvent) => a.startsAt - b.startsAt || a.id.localeCompare(b.id),
  );
}

function ScheduleBody({
  mode,
  days,
  anchor,
  events,
  zone,
  now,
  handle,
  name,
  owner,
  onOpen,
  onMove,
  onDay,
  onCreate,
}: Readonly<{
  mode: ScheduleMode;
  days: number[];
  anchor: number;
  events: StreamEvent[];
  zone: string;
  now: number;
  handle: string;
  name: string;
  owner: boolean;
  onOpen: (id: string) => void;
  onMove: (anchor: number) => void;
  onDay: (day: number) => void;
  onCreate: () => void;
}>): ReactNode {
  if (mode === "feed" && events.length === 0 && !owner)
    return (
      <EmptyState
        title={t("schedule.emptyTitle")}
        icon="schedule"
        action={
          <Link className="button-link gold" to="?view=topics">
            <Icon name="topics" size={18} />
            {t("schedule.exploreTopics")}
          </Link>
        }
      >
        {t("schedule.emptyBody", { name: name.split(" ")[0] })}
      </EmptyState>
    );
  if (mode === "feed" && events.length === 0)
    return (
      <EmptyState
        title={t("schedule.ownerEmptyTitle")}
        icon="schedule"
        action={
          <button type="button" className="gold" onClick={onCreate}>
            <Icon name="plus" size={18} />
            {t("schedule.create")}
          </button>
        }
      >
        {t("schedule.ownerEmptyBody")}
      </EmptyState>
    );
  return (
    <div className="sched-body">
      {mode === "feed" ? (
        <ScheduleFeed
          events={events}
          zone={zone}
          now={now}
          handle={handle}
          onOpen={onOpen}
          onCalendar={(event: StreamEvent) => downloadEvent(event, name, `${location.origin}/@${handle}`)}
        />
      ) : (
        <>
          <CalendarNav
            mode={mode}
            days={days}
            zone={zone}
            onStep={(direction: number) => onMove(stepAnchor(mode, anchor, zone, direction))}
            onToday={() => onMove(now)}
          />
          {mode === "month" && (
            <MonthGrid days={days} events={events} zone={zone} now={now} onOpen={onOpen} onDay={onDay} />
          )}
          {mode === "week" && <TimeGrid days={days} events={events} zone={zone} now={now} onOpen={onOpen} />}
          {mode === "day" && <DayView days={days} events={events} zone={zone} now={now} onOpen={onOpen} />}
        </>
      )}
      <p className="muted">
        <a className="text-link" href={`/@${handle}/schedule.ics`}>
          <Icon name="schedule" size={16} />
          {t("schedule.subscribe")}
        </a>
      </p>
    </div>
  );
}

// Feed/Day/Week/Month use the viewer's zone. Narrow Week/Month links show Feed with a note. Owners manage
// streams here.
export function ScheduleView({
  handle,
  name,
  events: loaded,
  linked,
  serverNow,
  owner,
  topics,
  mode: requested,
  openEvent,
  creating,
  onMode,
  onOpenEvent,
  onCreating,
  onChanged,
}: Readonly<{
  handle: string;
  name: string;
  events: StreamEvent[];
  // Linked out-of-range stream does not extend loaded coverage.
  linked: StreamEvent | null;
  serverNow: number;
  owner: boolean;
  topics: EventTopic[];
  mode: ScheduleMode;
  openEvent: string | null;
  creating: boolean;
  onMode: (mode: ScheduleMode) => void;
  onOpenEvent: (id: string | null) => void;
  onCreating: (open: boolean) => void;
  onChanged: () => Promise<void>;
}>): ReactNode {
  const zone = useViewerZone();
  const narrow = useNarrow();
  const toast = useToast();
  const [anchor, setAnchor] = useState<number>(serverNow);
  const [extra, setExtra] = useState<StreamEvent[]>([]);
  const [step, setStep] = useState<EventStep>("view");
  const [error, setError] = useState<string>("");
  const merged = merge(loaded, linked ? merge(extra, [linked]) : extra);
  const now = useScheduleClock(serverNow, merged);
  const events = statusesAt(merged, now);
  // Narrow screens use Feed instead of Week/Month.
  const effective = (value: ScheduleMode): ScheduleMode =>
    narrow && (value === "week" || value === "month") ? "feed" : value;
  const mode: ScheduleMode = effective(requested);
  const days = mode === "feed" ? [] : visibleDays(mode, anchor, zone);
  const open = openEvent ? (events.find((event: StreamEvent) => event.id === openEvent) ?? null) : null;

  // Fetch uncovered calendar ranges. Fresh requests replace prior results; others append.
  async function fetchVisible(at: number, fresh: boolean, view: ScheduleMode = mode): Promise<void> {
    const range = view === "feed" ? null : visibleRange(view, at, zone);
    const covered = (from: number, to: number): boolean =>
      loaded.length > 0 && loaded[0].startsAt <= from && loaded.at(-1)!.startsAt >= to;
    if (range === null || covered(range.from, range.to)) {
      if (fresh) setExtra([]);
      return;
    }
    try {
      const result = await requestJson<{ events: StreamEvent[] }>(
        `/api/streamers/${encodeURIComponent(handle)}/events?from=${range.from}&to=${range.to}`,
      );
      setExtra((current: StreamEvent[]) => (fresh ? result.events : merge(result.events, current)));
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    }
  }

  // Route all calendar navigation through range loading.
  async function show(at: number, view: ScheduleMode = requested): Promise<void> {
    setAnchor(at);
    if (view !== requested) onMode(view);
    await fetchVisible(at, false, effective(view));
  }

  // Refresh separately fetched ranges after mutations.
  async function changed(message: string, at: number = anchor): Promise<void> {
    onOpenEvent(null);
    onCreating(false);
    setStep("view");
    toast(message);
    await onChanged();
    await fetchVisible(at, true);
  }

  async function create(body: EventBody): Promise<void> {
    const result = await postJson<{ event: StreamEvent }>("/api/events", body);
    setAnchor(result.event.startsAt);
    await changed(t("schedule.saved"), result.event.startsAt);
  }

  const openId = (id: string): void => {
    setStep("view");
    onOpenEvent(id);
  };

  return (
    <>
      <div className="page-title">
        <div>
          <span className="eyebrow">{t("schedule.eyebrow")}</span>
          <h1>
            <span className="sr-only">{name}: </span>
            {t("schedule.title")}
          </h1>
        </div>
      </div>
      <div className="sched-toolbar">
        <fieldset className="tabs sched-switch">
          <legend className="sr-only">{t("schedule.viewLabel")}</legend>
          {scheduleModes.map((value: ScheduleMode) => (
            <button
              key={value}
              type="button"
              className={`${value === mode ? "active" : ""}${value === "week" || value === "month" ? " wide-only" : ""}`}
              aria-pressed={value === mode}
              onClick={() => void show(anchor, value)}
            >
              {t(modeLabel[value] as "schedule.mode.feed")}
            </button>
          ))}
        </fieldset>
        {owner && (
          <button type="button" className="gold" onClick={() => onCreating(true)}>
            <Icon name="plus" size={18} />
            {t("schedule.create")}
          </button>
        )}
      </div>
      {mode !== requested && (
        <p className="sched-hint" role="note">
          <Icon name="about" size={16} />
          {t("schedule.wideOnly")}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <ScheduleBody
        mode={mode}
        days={days}
        anchor={anchor}
        events={events}
        zone={zone}
        now={now}
        handle={handle}
        name={name}
        owner={owner}
        onOpen={openId}
        onMove={(next: number) => void show(next)}
        onDay={(day: number) => void show(day, "day")}
        onCreate={() => onCreating(true)}
      />
      <EventDialog
        event={open}
        step={step}
        zone={zone}
        handle={handle}
        name={name}
        owner={owner}
        events={events}
        topics={topics}
        onStep={setStep}
        onClose={() => {
          setStep("view");
          onOpenEvent(null);
        }}
        onChanged={changed}
      />
      {owner && (
        <Sheet open={creating} onOpenChange={onCreating} title={t("schedule.create")} name="schedule">
          <ScheduleForm formId="event-new" event={null} zone={zone} events={events} topics={topics} onSubmit={create} />
        </Sheet>
      )}
    </>
  );
}
