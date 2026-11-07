import { useState, type FormEvent, type ReactNode } from "react";
import { t } from "../../i18n";
import { buildCalendar } from "../../server/ics";
import type { EventTopic, StreamEvent } from "../../types";
import { errorMessage, sendJson } from "../api";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Sheet } from "../ui/sheet";
import { useToast } from "../ui/toast";
import { durationLabel, platformIcon, platformLabel, repeatLabel, statusWord, whenLine } from "./format";
import { PlatformLink, TopicChips } from "./schedule-feed";
import { ScheduleForm, type EventBody } from "./schedule-form";

export type EventStep = "view" | "edit" | "cancel" | "delete" | "replay";

/** Downloads a one-stream .ics file for the viewer's calendar app. */
export function downloadEvent(event: StreamEvent, name: string, pageUrl: string): void {
  const text = buildCalendar(
    name,
    [
      {
        id: event.id,
        title: event.title,
        notes: event.notes,
        startsAt: event.startsAt,
        durationMin: event.durationMin,
        url: event.url,
        cancelled: event.status === "cancelled",
        updatedAt: event.updatedAt,
      },
    ],
    { pageUrl },
  );
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/calendar" }));
  link.download = `${event.title.replaceAll(/[^\w-]+/g, "-").slice(0, 40) || "stream"}.ics`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function Facts({ event, zone, handle }: Readonly<{ event: StreamEvent; zone: string; handle: string }>): ReactNode {
  return (
    <>
      <div className="event-facts">
        <span className={`sched-status status-${event.status}`}>
          {event.status === "live" && <span className="live-pulse" aria-hidden="true" />}
          {statusWord(event.status)}
        </span>
        <p>
          <Icon name="schedule" size={18} />
          {whenLine(event, zone)}
        </p>
        <p>
          <Icon name="timer" size={18} />
          {durationLabel(event.durationMin)}
          {event.seriesId && ` · ${t("schedule.every", { days: repeatLabel(event.repeatDays) })}`}
        </p>
        <p>
          <Icon name={platformIcon[event.platform]} size={18} />
          <a className="text-link" href={event.url} target="_blank" rel="noopener noreferrer">
            {platformLabel[event.platform]} · {event.url.replace("https://", "")}
          </a>
        </p>
      </div>
      {event.notes && <p className="event-notes">{event.notes}</p>}
      {event.topics.length > 0 && (
        <div className="field">
          <span className="field-label">{t("schedule.linkedTopics")}</span>
          <TopicChips topics={event.topics} handle={handle} />
        </div>
      )}
    </>
  );
}

function ViewStep({
  event,
  zone,
  handle,
  owner,
  onStep,
  onCalendar,
}: Readonly<{
  event: StreamEvent;
  zone: string;
  handle: string;
  owner: boolean;
  onStep: (step: EventStep) => void;
  onCalendar: () => void;
}>): ReactNode {
  const toast = useToast();
  const ended = event.status === "ended";
  return (
    <>
      <Facts event={event} zone={zone} handle={handle} />
      <div className="sched-actions">
        {ended &&
          (event.vodUrl ? (
            <a className="button-link gold platform-link" href={event.vodUrl} target="_blank" rel="noopener noreferrer">
              <Icon name="play" size={18} />
              {t("schedule.watchReplay")}
            </a>
          ) : (
            <p className="muted">{t("schedule.noReplayLong")}</p>
          ))}
        {!ended && event.status !== "cancelled" && <PlatformLink event={event} />}
        {!ended && (
          <button type="button" onClick={onCalendar}>
            <Icon name="schedule" size={18} />
            {t("schedule.addToCalendar")}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            const url = `${location.origin}/@${handle}?view=schedule&event=${event.id}`;
            void navigator.clipboard
              ?.writeText(url)
              .then(() => toast(t("schedule.linkCopied")))
              .catch(() => toast(url));
          }}
        >
          <Icon name="link" size={18} />
          {t("schedule.copyLink")}
        </button>
      </div>
      {owner && (
        <div className="owner-tools">
          <span className="eyebrow">{t("schedule.owner")}</span>
          <div className="sched-actions">
            <button type="button" onClick={() => onStep("edit")}>
              {t("common.edit")}
            </button>
            {!ended && event.status !== "cancelled" && (
              <button type="button" onClick={() => onStep("cancel")}>
                {t("schedule.cancelStream")}
              </button>
            )}
            {ended && (
              <button type="button" onClick={() => onStep("replay")}>
                {event.vodUrl ? t("schedule.changeReplay") : t("schedule.addReplay")}
              </button>
            )}
            <button type="button" className="danger" onClick={() => onStep("delete")}>
              <Icon name="trash" size={18} />
              {t("common.delete")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function ConfirmStep({
  event,
  step,
  zone,
  onDone,
}: Readonly<{
  event: StreamEvent;
  step: "cancel" | "delete";
  zone: string;
  onDone: (message: string) => Promise<void>;
}>) {
  const [scope, setScope] = useState<"one" | "following">("one");
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState<boolean>(false);
  async function confirm(): Promise<void> {
    setPending(true);
    setError("");
    try {
      if (step === "cancel") await sendJson("PATCH", `/api/events/${event.id}`, { action: "cancel" });
      else await sendJson("DELETE", `/api/events/${event.id}`, { scope });
      await onDone(t(step === "cancel" ? "schedule.cancelled" : "schedule.deleted"));
    } catch (error_: unknown) {
      setError(errorMessage(error_));
      setPending(false);
    }
  }
  return (
    <>
      <p>
        {step === "cancel"
          ? t("schedule.cancelBody", { title: event.title, day: whenLine(event, zone) })
          : t("schedule.deleteBody", { title: event.title })}
      </p>
      {step === "delete" && event.seriesId && (
        <fieldset className="poll-types">
          <legend>{t("schedule.form.applyTo")}</legend>
          {(["one", "following"] as const).map((value) => (
            <label key={value}>
              <input type="radio" name="delete-scope" checked={scope === value} onChange={() => setScope(value)} />
              <span>{t(value === "one" ? "schedule.form.thisStream" : "schedule.form.following")}</span>
            </label>
          ))}
        </fieldset>
      )}
      <p className="form-error" role="alert">
        {error}
      </p>
      <DialogActions cancelLabel={t("schedule.keepIt")}>
        <button type="button" className="danger" disabled={pending} onClick={() => void confirm()}>
          {step === "cancel" ? t("schedule.cancelStream") : t("schedule.deleteStream")}
        </button>
      </DialogActions>
    </>
  );
}

function ReplayStep({ event, onDone }: Readonly<{ event: StreamEvent; onDone: (message: string) => Promise<void> }>) {
  const [url, setUrl] = useState<string>(event.vodUrl ?? "");
  const [error, setError] = useState<string>("");
  async function save(formEvent: FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    setError("");
    try {
      await sendJson("PATCH", `/api/events/${event.id}`, { action: "replay", vodUrl: url.trim() || null });
      await onDone(t("schedule.replaySaved"));
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    }
  }
  return (
    <form onSubmit={(formEvent) => void save(formEvent)}>
      <label>
        <span>{t("schedule.replayUrl")}</span>
        <input
          type="url"
          name="vod"
          pattern="https://.+"
          value={url}
          placeholder="https://twitch.tv/videos/…"
          onChange={(input) => setUrl(input.currentTarget.value)}
        />
      </label>
      <p className="muted">{t("schedule.replayHint")}</p>
      <p className="form-error" role="alert">
        {error}
      </p>
      <DialogActions>
        <button className="gold" type="submit">
          {t("schedule.saveReplay")}
        </button>
      </DialogActions>
    </form>
  );
}

/** One stream: its facts and actions; the owner edits, cancels, deletes or adds a replay in the same sheet. */
export function EventDialog({
  event,
  step,
  zone,
  handle,
  name,
  owner,
  events,
  topics,
  onStep,
  onClose,
  onChanged,
}: Readonly<{
  event: StreamEvent | null;
  step: EventStep;
  zone: string;
  handle: string;
  name: string;
  owner: boolean;
  events: StreamEvent[];
  topics: EventTopic[];
  onStep: (step: EventStep) => void;
  onClose: () => void;
  onChanged: (message: string) => Promise<void>;
}>): ReactNode {
  if (!event) return null;
  const titles: Record<EventStep, string> = {
    view: event.title,
    edit: t("schedule.editStream"),
    cancel: t("schedule.cancelTitle"),
    delete: t("schedule.deleteTitle"),
    replay: t("schedule.addReplay"),
  };
  async function saveEdit(body: EventBody): Promise<void> {
    if (!event) return;
    await sendJson("PATCH", `/api/events/${event.id}`, { action: "edit", scope: "one", ...body });
    await onChanged(t("schedule.saved"));
  }
  return (
    <Sheet
      open
      onOpenChange={(open: boolean) => !open && onClose()}
      title={titles[step]}
      name="event"
      short={step === "cancel" || step === "delete" || step === "replay"}
      onBack={step === "view" ? undefined : () => onStep("view")}
    >
      {step === "view" && (
        <ViewStep
          event={event}
          zone={zone}
          handle={handle}
          owner={owner}
          onStep={onStep}
          onCalendar={() => downloadEvent(event, name, `${location.origin}/@${handle}`)}
        />
      )}
      {step === "edit" && (
        <ScheduleForm
          formId="event-edit"
          event={event}
          zone={zone}
          events={events}
          topics={topics}
          onSubmit={saveEdit}
        />
      )}
      {(step === "cancel" || step === "delete") && (
        <ConfirmStep event={event} step={step} zone={zone} onDone={onChanged} />
      )}
      {step === "replay" && <ReplayStep event={event} onDone={onChanged} />}
    </Sheet>
  );
}
