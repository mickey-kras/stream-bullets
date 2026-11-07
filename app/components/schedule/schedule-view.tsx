import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../../i18n";
import type { EventTopic, StreamEvent } from "../../types";
import { errorMessage, postJson, requestJson } from "../api";
import { EmptyState } from "../common";
import { Icon } from "../ui/icon";
import { Sheet } from "../ui/sheet";
import { useToast } from "../ui/toast";
import { EventDialog, downloadEvent, type EventStep } from "./event-dialog";
import { useNarrow, useViewerZone } from "./format";
import {
  CalendarNav,
  DayView,
  MonthGrid,
  TimeGrid,
  stepAnchor,
  visibleDays,
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
  if (mode === "feed" && events.length === 0)
    return (
      <EmptyState
        title={t("schedule.ownerEmptyTitle")}
        icon="schedule"
        action={
          owner && (
            <button type="button" className="gold" onClick={onCreate}>
              <Icon name="plus" size={18} />
              {t("schedule.create")}
            </button>
          )
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

/**
 * The Schedule tab (item 23): Feed, Day, Week and Month in the viewer's zone. Week and Month need a wide screen;
 * on a phone a shared link to them shows the Feed with a note. The owner schedules, edits, cancels and deletes here.
 */
export function ScheduleView({
  handle,
  name,
  events: loaded,
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
  const events = merge(loaded, extra);
  const mode: ScheduleMode = narrow && (requested === "week" || requested === "month") ? "feed" : requested;
  const days = mode === "feed" ? [] : visibleDays(mode, anchor, zone);
  const open = openEvent ? (events.find((event: StreamEvent) => event.id === openEvent) ?? null) : null;

  async function moveTo(next: number): Promise<void> {
    setAnchor(next);
    if (mode === "feed") return;
    const range = visibleDays(mode, next, zone);
    const from = range[0];
    const to = range.at(-1)! + 86_400_000;
    const covered = loaded.length > 0 && loaded[0].startsAt <= from && loaded.at(-1)!.startsAt >= to;
    if (covered) return;
    try {
      const result = await requestJson<{ events: StreamEvent[] }>(
        `/api/streamers/${encodeURIComponent(handle)}/events?from=${from}&to=${to}`,
      );
      setExtra((current: StreamEvent[]) => merge(result.events, current));
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    }
  }

  async function changed(message: string): Promise<void> {
    setExtra([]);
    onOpenEvent(null);
    onCreating(false);
    setStep("view");
    toast(message);
    await onChanged();
  }

  async function create(body: EventBody): Promise<void> {
    const result = await postJson<{ event: StreamEvent }>("/api/events", body);
    await changed(t("schedule.saved"));
    setAnchor(result.event.startsAt);
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
      {events.length === 0 && !owner ? (
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
      ) : (
        <>
          <div className="sched-toolbar">
            <fieldset className="tabs sched-switch">
              <legend className="sr-only">{t("schedule.viewLabel")}</legend>
              {scheduleModes.map((value: ScheduleMode) => (
                <button
                  key={value}
                  type="button"
                  className={`${value === mode ? "active" : ""}${value === "week" || value === "month" ? " wide-only" : ""}`}
                  aria-pressed={value === mode}
                  onClick={() => onMode(value)}
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
            now={serverNow}
            handle={handle}
            name={name}
            owner={owner}
            onOpen={openId}
            onMove={(next: number) => void moveTo(next)}
            onDay={(day: number) => {
              setAnchor(day);
              onMode("day");
            }}
            onCreate={() => onCreating(true)}
          />
        </>
      )}
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
