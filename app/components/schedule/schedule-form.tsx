import { useId, useState, type FormEvent, type ReactNode } from "react";
import { STREAM_PLATFORMS } from "../../../db/enums";
import { t } from "../../i18n";
import { hasWeekday } from "../../lib/schedule";
import { formatDate, localDateOf, parseDate, weekdayOf, zonedParts, zonedTime } from "../../lib/zoned";
import type { EventTopic, StreamEvent, StreamPlatform } from "../../types";
import { categoryIcon } from "../topic-icon";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Select, type SelectOption } from "../ui/select";
import { durationLabel, platformIcon, platformLabel, timeOf, weekdayShort } from "./format";

export interface EventBody {
  title: string;
  notes: string;
  date: string;
  time: string;
  tz: string;
  durationMin: number;
  platform: StreamPlatform;
  url: string;
  repeatDays: number;
  repeatUntil: string | null;
  topicIds: string[];
  scope?: "one" | "following";
}

const DURATIONS = [30, 60, 90, 120, 150, 180, 240, 300, 360, 480, 720];
const ZONES = ["Europe/Berlin", "Europe/London", "America/New_York", "America/Los_Angeles", "UTC"];

function initial(
  event: StreamEvent | null,
  zone: string,
  channels: Partial<Record<StreamPlatform, string>>,
): EventBody {
  if (!event)
    return {
      title: "",
      notes: "",
      date: "",
      time: "",
      tz: zone,
      durationMin: 120,
      platform: "twitch",
      url: channels.twitch ?? "",
      repeatDays: 0,
      repeatUntil: null,
      topicIds: [],
    };
  const local = zonedParts(event.startsAt, event.tz);
  return {
    title: event.title,
    notes: event.notes,
    date: formatDate(local),
    time: `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`,
    tz: event.tz,
    durationMin: event.durationMin,
    platform: event.platform,
    url: event.url,
    repeatDays: event.repeatDays,
    repeatUntil: event.repeatUntil === null ? null : formatDate(localDateOf(event.repeatUntil, event.tz)),
    topicIds: event.topics.map((topic: EventTopic) => topic.id),
    scope: event.seriesId ? "one" : undefined,
  };
}

/** The other stream this one would overlap, if any (cancelled streams do not count). */
function overlapping(body: EventBody, events: StreamEvent[], editing: string | null): StreamEvent | null {
  const date = parseDate(body.date);
  if (!date || !/^\d{2}:\d{2}$/.test(body.time)) return null;
  const [hour, minute] = body.time.split(":").map(Number);
  const start = zonedTime(date, hour, minute, body.tz);
  const end = start + body.durationMin * 60_000;
  return (
    events.find(
      (event: StreamEvent) =>
        event.id !== editing &&
        event.status !== "cancelled" &&
        event.startsAt < end &&
        event.startsAt + event.durationMin * 60_000 > start,
    ) ?? null
  );
}

function RepeatFields({
  body,
  repeat,
  firstDay,
  onRepeat,
  onChange: update,
}: Readonly<{
  body: EventBody;
  repeat: boolean;
  firstDay: ReturnType<typeof parseDate>;
  onRepeat: (repeat: boolean) => void;
  onChange: (patch: Partial<EventBody>) => void;
}>): ReactNode {
  const setRepeat = onRepeat;
  return (
    <fieldset className="repeat-field">
      <legend className="sr-only">{t("schedule.form.repeat")}</legend>
      <label className="choice">
        <input
          type="checkbox"
          name="repeat"
          checked={repeat}
          onChange={(input) => {
            const on = input.currentTarget.checked;
            setRepeat(on);
            if (on && body.repeatDays === 0 && firstDay) update({ repeatDays: 1 << weekdayOf(firstDay) });
          }}
        />
        <span>{t("schedule.form.repeatWeekly")}</span>
      </label>
      {repeat && (
        <div className="repeat-options">
          <div className="day-toggles" role="group" aria-label={t("schedule.form.repeatOn")}>
            {[0, 1, 2, 3, 4, 5, 6].map((day: number) => (
              <button
                key={day}
                type="button"
                className="day-toggle"
                aria-pressed={hasWeekday(body.repeatDays, day)}
                onClick={() => update({ repeatDays: body.repeatDays ^ (1 << day) })}
              >
                {weekdayShort(Date.UTC(2026, 10, 1 + day, 12), "UTC")}
              </button>
            ))}
          </div>
          <label>
            <span>{t("schedule.form.endsOn")}</span>
            <input
              type="date"
              name="until"
              value={body.repeatUntil ?? ""}
              min={body.date || undefined}
              onChange={(input) => update({ repeatUntil: input.currentTarget.value || null })}
            />
          </label>
        </div>
      )}
    </fieldset>
  );
}

function TopicPicker({
  topics,
  selected,
  onChange,
}: Readonly<{ topics: EventTopic[]; selected: string[]; onChange: (topicIds: string[]) => void }>): ReactNode {
  const id = useId();
  if (topics.length === 0) return null;
  return (
    <div className="field">
      <span className="field-label" id={`${id}-topics`}>
        {t("schedule.linkedTopics")}
      </span>
      <div className="topic-chips" role="group" aria-labelledby={`${id}-topics`}>
        {topics.map((topic: EventTopic) => {
          const on = selected.includes(topic.id);
          return (
            <button
              key={topic.id}
              type="button"
              className="topic-chip toggle"
              aria-pressed={on}
              onClick={() =>
                onChange(
                  on ? selected.filter((value: string) => value !== topic.id) : [...selected, topic.id].slice(0, 5),
                )
              }
            >
              <Icon name={categoryIcon(topic.category)} size={18} />
              {topic.title}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** "Schedule a stream" and "Edit stream": one form in a sheet; the parent sends it. */
export function ScheduleForm({
  formId,
  event,
  zone,
  events,
  topics,
  onSubmit,
}: Readonly<{
  formId: string;
  event: StreamEvent | null;
  zone: string;
  events: StreamEvent[];
  topics: EventTopic[];
  onSubmit: (body: EventBody) => Promise<void>;
}>): ReactNode {
  const id = useId();
  const channels: Partial<Record<StreamPlatform, string>> = {};
  for (const item of events) channels[item.platform] ??= item.url;
  const [body, setBody] = useState<EventBody>(() => initial(event, zone, channels));
  const [repeat, setRepeat] = useState<boolean>(body.repeatDays > 0);
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState<boolean>(false);
  const update = (patch: Partial<EventBody>): void => setBody((current: EventBody) => ({ ...current, ...patch }));
  const zones: SelectOption[] = [...new Set([zone, body.tz, ...ZONES])].map((value: string) => ({
    value,
    label: value === zone ? t("schedule.form.yourZone", { zone: value }) : value,
  }));
  const durations: SelectOption[] = [...new Set([...DURATIONS, body.durationMin])]
    .sort((a: number, b: number) => a - b)
    .map((minutes: number) => ({ value: String(minutes), label: durationLabel(minutes) }));
  const platforms: SelectOption[] = STREAM_PLATFORMS.map((platform: StreamPlatform) => ({
    value: platform,
    label: platformLabel[platform],
    icon: platformIcon[platform],
  }));
  const overlap = overlapping(body, events, event?.id ?? null);
  const firstDay = parseDate(body.date);

  async function submit(formEvent: FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    setPending(true);
    setError("");
    try {
      await onSubmit({
        ...body,
        repeatDays: repeat ? body.repeatDays : 0,
        repeatUntil: repeat ? body.repeatUntil : null,
      });
    } catch (error_: unknown) {
      setError(error_ instanceof Error ? error_.message : t("common.failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form id={formId} className="schedule-form" onSubmit={(formEvent) => void submit(formEvent)}>
      <label>
        <span>{t("schedule.form.title")}</span>
        <input
          name="title"
          required
          maxLength={100}
          value={body.title}
          placeholder={t("schedule.form.titlePlaceholder")}
          onChange={(input) => update({ title: input.currentTarget.value })}
        />
      </label>
      <div className="form-row">
        <label>
          <span>{t("schedule.form.date")}</span>
          <input
            type="date"
            name="date"
            required
            value={body.date}
            onChange={(input) => update({ date: input.currentTarget.value })}
          />
        </label>
        <label>
          <span>{t("schedule.form.time")}</span>
          <input
            type="time"
            name="time"
            required
            value={body.time}
            onChange={(input) => update({ time: input.currentTarget.value })}
          />
        </label>
      </div>
      <div className="form-row">
        <div className="field">
          <span className="field-label" id={`${id}-duration`}>
            {t("schedule.form.duration")}
          </span>
          <Select
            id={`${id}-duration-select`}
            labelledBy={`${id}-duration`}
            options={durations}
            value={String(body.durationMin)}
            onValueChange={(value: string) => update({ durationMin: Number(value) })}
          />
        </div>
        <div className="field">
          <span className="field-label" id={`${id}-zone`}>
            {t("schedule.form.zone")}
          </span>
          <Select
            id={`${id}-zone-select`}
            labelledBy={`${id}-zone`}
            options={zones}
            value={body.tz}
            onValueChange={(value: string) => update({ tz: value })}
          />
        </div>
      </div>
      <RepeatFields body={body} repeat={repeat} firstDay={firstDay} onRepeat={setRepeat} onChange={update} />
      {event?.seriesId && (
        <fieldset className="poll-types">
          <legend>{t("schedule.form.applyTo")}</legend>
          {(["one", "following"] as const).map((scope) => (
            <label key={scope}>
              <input type="radio" name="scope" checked={body.scope === scope} onChange={() => update({ scope })} />
              <span>{t(scope === "one" ? "schedule.form.thisStream" : "schedule.form.following")}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="form-row">
        <div className="field">
          <span className="field-label" id={`${id}-platform`}>
            {t("schedule.form.platform")}
          </span>
          <Select
            id={`${id}-platform-select`}
            labelledBy={`${id}-platform`}
            options={platforms}
            value={body.platform}
            onValueChange={(value: string) => {
              const platform = value as StreamPlatform;
              update({ platform, url: channels[platform] ?? (body.url === channels[body.platform] ? "" : body.url) });
            }}
          />
        </div>
        <label>
          <span>{t("schedule.form.url")}</span>
          <input
            type="url"
            name="url"
            required
            pattern="https://.+"
            value={body.url}
            placeholder="https://twitch.tv/yourchannel"
            onChange={(input) => update({ url: input.currentTarget.value })}
          />
        </label>
      </div>
      <TopicPicker topics={topics} selected={body.topicIds} onChange={(topicIds: string[]) => update({ topicIds })} />
      <output className="handle-warn overlap-warn">
        {overlap && (
          <>
            <Icon name="warning" size={16} />
            {t("schedule.form.overlap", { title: overlap.title, time: timeOf(overlap.startsAt, zone) })}
          </>
        )}
      </output>
      <label>
        <span>{t("schedule.form.notes")}</span>
        <textarea
          name="notes"
          rows={3}
          maxLength={1000}
          value={body.notes}
          onChange={(input) => update({ notes: input.currentTarget.value })}
        />
      </label>
      <p className="form-error" role="alert">
        {error}
      </p>
      <DialogActions>
        <button className="gold" type="submit" disabled={pending}>
          {pending ? t("common.saving") : t("common.save")}
        </button>
      </DialogActions>
    </form>
  );
}
