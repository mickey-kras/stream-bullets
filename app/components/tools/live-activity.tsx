import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useReducer,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { intlLocale, t, tAround } from "../../i18n";
import type { SupportKind } from "../../lib/activity";
import { alertsReplySchema, type AlertControl, type AlertsReply } from "../../lib/alert-control";
import type { AlertView } from "../../lib/alerts";
import { relativeAge } from "../../lib/channel-health";
import {
  INITIAL_ACTIVITY,
  activityAfter,
  nowLine,
  refusalText,
  replayable,
  secondsLeft,
  shownAlerts,
  type ActivityRow,
  type ShownAlerts,
} from "../../lib/live-activity";
import { onAnyOutput, type OverlayLayers } from "../../lib/overlay-layers";
import { toolsPath } from "../../lib/shell";
import { supportText } from "../../lib/support-line";
import { announce } from "../a11y/announcer";
import { ApiError, errorMessage } from "../api";
import type { ActivityFeed } from "../overlay/activity-feed";
import { ALERT_ICONS, alertWho } from "../overlay/alerts-layer";
import { ControlApiContext, type ControlApi } from "../overlay/control-api";
import { useAlerts } from "../overlay/use-alerts";
import { PLATFORM_NAMES } from "../overlay/wasteland/theme";
import { Icon, type IconName } from "../ui/icon";
import { useToast } from "../ui/toast";
import { LivePart } from "./live-part";

/** The icon of each kind of row. It is decoration: the title tells what the event is. */
const ROW_ICONS: Readonly<Record<SupportKind, IconName>> = { ...ALERT_ICONS, tip: "heart", reactions: "heart" };

/** The text of a failed control: the refusal of the alert host, or the general text of the error. */
export function failedText(error: unknown): string {
  const id = error instanceof ApiError ? refusalText(error.code, error.status) : null;
  return id === null ? errorMessage(error) : t(id);
}

/** Who and what, as one title. The name is untrusted text: it renders as text, in its own direction. */
function Title({
  row,
}: Readonly<{ row: Pick<ActivityRow, "kind" | "platform" | "amount" | "currency" | "name"> }>): ReactNode {
  return (
    <>
      <bdi>{row.name ?? t("tools.live.support.anonymous")}</bdi> {supportText(row)}
    </>
  );
}

/** The title as plain text, for the name of a Replay button. */
function titleText(row: ActivityRow): string {
  return `${row.name ?? t("tools.live.support.anonymous")} ${supportText(row)}`;
}

/** Where an event comes from. A tip comes from the tip page of the streamer, and a topic credit from StreamBullets. */
function source(row: ActivityRow): string {
  if (row.platform !== "direct") return PLATFORM_NAMES[row.platform];
  return row.kind === "topic" ? "StreamBullets" : t("tools.live.activity.tipPage");
}

/** The details line of a row: where from, and how long ago. A row that is itself a replay says so. */
function rowMeta(row: ActivityRow, now: number): string {
  const age: string = relativeAge(row.receivedAt, now, intlLocale()) ?? t("tools.live.activity.justNow");
  const parts: string[] = [source(row), age];
  if (!row.original) parts.push(t("tools.live.activity.origin.replay"));
  return parts.join(" · ");
}

/**
 * The whole seconds until the local time `until`. A timer ticks at each whole second that is left, so the count
 * goes down with the timer of `useAlerts`, which ends the alert at `until`.
 */
function useSecondsLeft(until: number): number {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = (): void => {
        const ms: number = until - Date.now();
        if (ms <= 0) return;
        timer = setTimeout(
          (): void => {
            onChange();
            wait();
          },
          ms % 1000 || 1000,
        );
      };
      wait();
      return (): void => clearTimeout(timer);
    },
    [until],
  );
  // The part shows an alert only after the socket sent it, never in the first render: one snapshot for both.
  const read = (): number => secondsLeft(until, Date.now());
  return useSyncExternalStore(subscribe, read, read);
}

/** The controls of the alerts: one request at a time for each control, and the answer of the newest one. */
export interface AlertsControl {
  /** The keys of the controls that run: the operation, or `replay:<id>`. */
  busy: ReadonlySet<string>;
  reply: AlertsReply | null;
  /** The rows whose event the server no longer keeps. */
  gone: ReadonlySet<string>;
  send: (control: AlertControl) => void;
}

function controlKey(control: AlertControl): string {
  return control.op === "replay" ? `replay:${control.id}` : control.op;
}

/**
 * Sends the controls through the control API of the page: the session of the owner, or the dock key. A refusal shows
 * as a toast, which the screen reader announces, and a replay of an event that the server no longer keeps hides its
 * button. A change of the mute is announced too.
 */
function useAlertsControl(): AlertsControl {
  const api: ControlApi = useContext(ControlApiContext);
  const toast = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set<string>());
  const [reply, setReply] = useState<AlertsReply | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set<string>());
  async function run(control: AlertControl): Promise<void> {
    const key: string = controlKey(control);
    setBusy((current: ReadonlySet<string>): ReadonlySet<string> => new Set<string>([...current, key]));
    try {
      const answer = alertsReplySchema.safeParse(await api.alerts(control));
      // A faulty answer changes nothing: the socket still sends the state.
      if (answer.success) setReply(answer.data);
      if (control.op === "mute")
        announce(t(control.on ? "tools.live.activity.mutedNow" : "tools.live.activity.unmutedNow"));
    } catch (error: unknown) {
      if (control.op === "replay" && error instanceof ApiError && error.code === "alert_gone")
        setGone((current: ReadonlySet<string>): ReadonlySet<string> => new Set<string>([...current, control.id]));
      toast(failedText(error), { tone: "error" });
    } finally {
      setBusy((current: ReadonlySet<string>): ReadonlySet<string> => {
        const next = new Set<string>(current);
        next.delete(key);
        return next;
      });
    }
  }
  return { busy, reply, gone, send: (control: AlertControl): void => void run(control) };
}

/** "On stream now:" with who and what of the alert on stream. */
function NowTitle({ alert }: Readonly<{ alert: AlertView }>): ReactNode {
  const [before, after] = tAround("tools.live.activity.onStream", "title");
  return (
    <>
      {before}
      <bdi>{alertWho(alert)}</bdi> {supportText(alert)}
      {after}
    </>
  );
}

/** The alert on stream: who and what, the Skip button, the time left, and the alerts that wait. */
function OnStreamNow({
  alert,
  until,
  waiting,
  busy,
  onSkip,
}: Readonly<{ alert: AlertView; until: number; waiting: number; busy: boolean; onSkip: () => void }>): ReactNode {
  const seconds: number = useSecondsLeft(until);
  const origin: string | null =
    alert.origin === "live"
      ? null
      : t(alert.origin === "test" ? "tools.live.activity.origin.test" : "tools.live.activity.origin.replay");
  return (
    <div className="tl-event tl-event-now" data-live-alert-now={alert.origin}>
      <span className="tl-event-title" data-live-alert-title>
        <NowTitle alert={alert} />
      </span>
      <span className="tl-event-slot">
        <button type="button" className="small-button" disabled={busy} data-live-alert-skip onClick={onSkip}>
          <Icon name="chevron-right" size={16} />
          {t("tools.live.activity.skip")}
        </button>
      </span>
      <span className="tl-event-meta" data-live-alert-left>
        {origin && `${origin} · `}
        {nowLine(seconds, waiting)}
      </span>
    </div>
  );
}

/** The Mute alerts toggle. It is pressed while the alerts are muted. */
function MuteButton({ alerts, control }: Readonly<{ alerts: ShownAlerts; control: AlertsControl }>): ReactNode {
  return (
    <button
      type="button"
      className="small-button tl-activity-button"
      aria-pressed={alerts.muted}
      disabled={control.busy.has("mute")}
      data-live-alerts-mute
      onClick={() => control.send({ op: "mute", on: !alerts.muted })}
    >
      <Icon name="eye-off" size={16} />
      {t("tools.live.activity.mute")}
    </button>
  );
}

function TestButton({
  control,
  onStream,
  reason,
}: Readonly<{ control: AlertsControl; onStream: boolean; reason: string }>): ReactNode {
  return (
    <button
      type="button"
      className="small-button tl-activity-button"
      disabled={!onStream || control.busy.has("test")}
      aria-describedby={onStream ? undefined : reason}
      data-live-alerts-test
      onClick={() => control.send({ op: "test" })}
    >
      <Icon name="play" size={16} />
      {t("tools.live.activity.test")}
    </button>
  );
}

/**
 * One recent support event: its icon, its title beside the Replay button, and the details line below them. The
 * dock shows no details line. Replay shows only while the server can still replay the event.
 */
function EventRow({
  row,
  now,
  replay,
  onStream,
  reason,
  control,
  details,
}: Readonly<{
  row: ActivityRow;
  now: number;
  replay: boolean;
  onStream: boolean;
  reason: string;
  control: AlertsControl;
  details: boolean;
}>): ReactNode {
  return (
    <li className="tl-event" data-activity-row={row.id} data-support={row.kind} data-replay={replay || undefined}>
      <Icon name={ROW_ICONS[row.kind]} size={18} className="tl-event-icon" />
      <span className="tl-event-title">
        <Title row={row} />
      </span>
      {replay && (
        <span className="tl-event-slot">
          <button
            type="button"
            className="small-button"
            aria-label={t("tools.live.activity.replayLabel", { title: titleText(row) })}
            aria-describedby={onStream ? undefined : reason}
            disabled={!onStream || control.busy.has(`replay:${row.id}`)}
            data-activity-replay
            onClick={() => control.send({ op: "replay", id: row.id })}
          >
            <Icon name="refresh" size={16} />
            {t("tools.live.activity.replay")}
          </button>
        </span>
      )}
      {details && (
        <span className="tl-event-meta" data-activity-meta>
          {rowMeta(row, now)}
        </span>
      )}
    </li>
  );
}

/** The closing line of Live: what a test and a replay do, and where the owner chooses what each event does. */
function ActivityNote(): ReactNode {
  const [before, after] = tAround("tools.live.activity.rules", "link");
  // The punctuation right after the link never starts a line.
  const mark: string = /^[»”’)）,.;:，、。：]*/u.exec(after)?.[0] ?? "";
  return (
    <p className="muted tl-note" data-live-activity-note>
      {t("tools.live.activity.note")} {before}
      <span className="tl-nowrap">
        <a className="text-link" href={toolsPath("overlay")}>
          {t("tools.tab.overlay")}
        </a>
        {mark}
      </span>
      {after.slice(mark.length)}
    </p>
  );
}

/** What the part shows. The hooks of `LiveActivity` give it; a test gives it as data. */
export interface ActivityViewProps {
  alerts: ShownAlerts;
  rows: readonly ActivityRow[];
  /** The IDs that the server keeps for a replay (`ActivityState.kept`). */
  kept: readonly string[];
  /** Server time, for the age of the rows and the end of a replay. */
  now: number;
  /** The Alerts layer is on stream in an output. */
  onStream: boolean;
  control: AlertsControl;
  dock: boolean;
}

/** The part for its state: the controls, the alert on stream, and the rows. */
export function ActivityView({
  alerts,
  rows,
  kept,
  now,
  onStream,
  control,
  dock,
}: Readonly<ActivityViewProps>): ReactNode {
  const reason: string = useId();
  const session: boolean = useContext(ControlApiContext).key === null;
  const mute: ReactNode = <MuteButton alerts={alerts} control={control} />;
  const test: ReactNode = <TestButton control={control} onStream={onStream} reason={reason} />;
  const skip = (): void => control.send({ op: "skip" });
  return (
    <LivePart
      name="activity"
      title={t("tools.live.activity")}
      action={
        dock ? (
          mute
        ) : (
          <div className="tl-activity-actions">
            {test}
            {mute}
          </div>
        )
      }
    >
      {alerts.muted && (
        <p className="tl-activity-muted" data-live-alerts-muted>
          <Icon name="eye-off" size={16} />
          <span>{t("tools.live.activity.muted")}</span>
        </p>
      )}
      {!onStream && (
        <p className="muted tl-note" id={reason} data-live-alerts-off>
          {t("tools.live.activity.offStream")}{" "}
          {session && (
            <a className="text-link" href={toolsPath("overlay")}>
              {t("tools.live.openOverlay")}
            </a>
          )}
        </p>
      )}
      {dock ? (
        <DockNow alerts={alerts} test={test} busy={control.busy.has("skip")} onSkip={skip} />
      ) : (
        alerts.current && (
          <OnStreamNow
            alert={alerts.current}
            until={alerts.until}
            waiting={alerts.waiting}
            busy={control.busy.has("skip")}
            onSkip={skip}
          />
        )
      )}
      {rows.length === 0 ? (
        <p className="muted tl-note" data-live-activity-empty>
          {t("tools.live.activity.empty")}
        </p>
      ) : (
        <ol className="tl-events" aria-label={t("tools.live.activity")} data-live-activity>
          {rows.map((row: ActivityRow) => (
            <EventRow
              key={row.id}
              row={row}
              now={now}
              replay={replayable(row, kept, now, control.gone)}
              onStream={onStream}
              reason={reason}
              control={control}
              details={!dock}
            />
          ))}
        </ol>
      )}
      {!dock && <ActivityNote />}
    </LivePart>
  );
}

/** The dock: Test alert and Skip alert in one row, and the alert on stream in one line below them. */
function DockNow({
  alerts,
  test,
  busy,
  onSkip,
}: Readonly<{ alerts: ShownAlerts; test: ReactNode; busy: boolean; onSkip: () => void }>): ReactNode {
  return (
    <>
      <div className="tl-activity-actions">
        {test}
        <button
          type="button"
          className="small-button tl-activity-button"
          disabled={alerts.current === null || busy}
          data-live-alert-skip
          onClick={onSkip}
        >
          <Icon name="chevron-right" size={16} />
          {t("tools.live.activity.skipAlert")}
        </button>
      </div>
      {alerts.current && (
        <p className="tl-note tl-activity-now" data-live-alert-now={alerts.current.origin}>
          <NowTitle alert={alerts.current} />
        </p>
      )}
    </>
  );
}

/**
 * The Activity part of the Live section and of the OBS dock (issue #1043): the controls of the alerts, the alert on
 * stream, and the recent support events, newest first. It reads the one activity socket of the page (`feed`) and
 * opens none: the `alerts` messages give the state, and the answer of a control gives it before the socket does.
 *
 * - Test alert plays a sample alert. Mute alerts stops the alert on stream at once, and the waiting alerts go.
 * - Skip ends the alert on stream. Replay plays the alert of an event again, while the server keeps the event.
 * - Test and Replay need the Alerts layer on stream in an output. Without it the part says so, and the buttons are
 *   off with that reason.
 *
 * The dock (`dock`) has the same actions in a narrow panel: Mute alerts beside the title, Test alert and Skip alert
 * in one row, and the rows without their details line. It has no session, so it has no link to Streamer tools.
 */
export function LiveActivity({
  feed,
  layers,
  now,
  serverOffset = 0,
  dock = false,
}: Readonly<{
  feed: ActivityFeed;
  layers: OverlayLayers;
  /** Server time, for the age of the rows and the end of a replay. */
  now: number;
  /** Server time minus the time of this device. */
  serverOffset?: number;
  dock?: boolean;
}>): ReactNode {
  const [state, dispatch] = useReducer(activityAfter, INITIAL_ACTIVITY);
  const { subscribe } = feed;
  useEffect(() => subscribe(dispatch), [subscribe]);
  const control: AlertsControl = useAlertsControl();
  const alerts: ShownAlerts = shownAlerts(useAlerts(feed, serverOffset), state.alertsAt, control.reply);
  return (
    <ActivityView
      alerts={alerts}
      rows={state.rows}
      kept={state.kept}
      now={now}
      onStream={onAnyOutput(layers, "alerts")}
      control={control}
      dock={dock}
    />
  );
}
