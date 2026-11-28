import { tn, type MessageId } from "../i18n";
import {
  isSupport,
  type ActivityMessage,
  type ActivitySupport,
  type SupportKind,
  type SupportSource,
} from "./activity";
import type { AlertRefusal, AlertsReply } from "./alert-control";
import type { AlertsState, AlertView } from "./alerts";

/**
 * The Activity part of the Live section and of the OBS dock (issue #1043) as pure state: the recent support events,
 * whether the server can still replay the alert of a row, the state of the alerts, and the text for a refusal of a
 * control. The part reads the one activity socket of the page and never counts an event: a test and a replay show
 * an alert again and do not count for a goal, a report, or revenue.
 */

/** The server replays the events that it keeps: the events of the last 10 minutes (SNAPSHOT_MAX_AGE_MS). */
export const REPLAY_WINDOW_MS = 10 * 60_000;
/** The server keeps the newest 50 support events (SUPPORT_SNAPSHOT_SIZE). An older row has no Replay. */
export const REPLAY_KEPT = 50;
/** The newest rows that the part keeps. The rows after the newest REPLAY_KEPT show without Replay. */
export const ACTIVITY_ROWS = 100;

/** One support event in the list of the part. It has no user ID: the part shows only the name. */
export interface ActivityRow {
  id: string;
  kind: SupportKind;
  platform: SupportSource;
  /** The display name of the supporter. Null: anonymous, or the platform does not say. */
  name: string | null;
  amount: number | null;
  currency: string | null;
  /** Server time when the server got the event. */
  receivedAt: number;
  /**
   * False for an event that the server sent again as a replay or a test while this page listened: the row is itself
   * a replay, so it has no Replay of its own. The events of a snapshot are the events that the server keeps, and
   * they are originals.
   */
  original: boolean;
}

function toRow(event: ActivitySupport, original: boolean): ActivityRow {
  return {
    id: event.id,
    kind: event.kind,
    platform: event.platform,
    name: event.anonymous ? null : event.sender?.displayName || null,
    amount: event.amount,
    currency: event.currency,
    receivedAt: event.receivedAt,
    original,
  };
}

/**
 * `rows` with `added` (oldest first), newest first. A known ID adds no second row: a provider retry and a snapshot
 * copy.
 */
function withRows(rows: readonly ActivityRow[], added: readonly ActivityRow[]): readonly ActivityRow[] {
  const known = new Set<string>(rows.map((row: ActivityRow): string => row.id));
  const fresh: ActivityRow[] = [];
  for (const row of added) {
    if (known.has(row.id)) continue;
    known.add(row.id);
    fresh.push(row);
  }
  if (fresh.length === 0) return rows;
  // The sort keeps the order of equal times: a row that arrived later comes first.
  fresh.reverse();
  return [...fresh, ...rows]
    .sort((a: ActivityRow, b: ActivityRow): number => b.receivedAt - a.receivedAt)
    .slice(0, ACTIVITY_ROWS);
}

/** What the part keeps of the socket: the rows, the kept IDs, and the server time of the newest `alerts` message. */
export interface ActivityState {
  /** Newest first, at most ACTIVITY_ROWS. */
  rows: readonly ActivityRow[];
  /**
   * The IDs of the support events that the server keeps for a replay, in the order that the server stored them,
   * newest last, at most REPLAY_KEPT. The socket sends events in that order, and a snapshot lists the kept events in
   * that order. A time does not give this order: a YouTube poll can store events with an earlier time after an event
   * of a different platform. A disconnect of a platform deletes its events on the server, and here.
   */
  kept: readonly KeptEvent[];
  /** 0 before the first `alerts` message. */
  alertsAt: number;
}

export const INITIAL_ACTIVITY: ActivityState = { rows: [], kept: [], alertsAt: 0 };

/** A support event that the server keeps for a replay. */
export interface KeptEvent {
  id: string;
  platform: ActivitySupport["platform"];
  receivedAt: number;
}

const keptOf = (event: ActivitySupport): KeptEvent => ({
  id: event.id,
  platform: event.platform,
  receivedAt: event.receivedAt,
});

/**
 * The kept events after one message of the socket. A snapshot gives the list of the server; an original adds one; a
 * disconnect of a platform removes its events, as the server deletes them. As the server does when it stores an event,
 * the events older than REPLAY_WINDOW_MS go first, and only then the oldest above REPLAY_KEPT.
 */
function keptAfter(kept: readonly KeptEvent[], message: ActivityMessage): readonly KeptEvent[] {
  if (message.type === "snapshot") return message.events.filter(isSupport).map(keptOf).slice(-REPLAY_KEPT);
  if (message.type !== "event") return kept;
  const event = message.event;
  if (event.kind === "status" && event.status === "disconnected") {
    const left: KeptEvent[] = kept.filter((one: KeptEvent): boolean => one.platform !== event.platform);
    return left.length === kept.length ? kept : left;
  }
  if (!isSupport(event) || event.replay) return kept;
  const since: number = event.receivedAt - REPLAY_WINDOW_MS;
  const fresh: KeptEvent[] = kept.filter((one: KeptEvent): boolean => one.id !== event.id && one.receivedAt >= since);
  return [...fresh, keptOf(event)].slice(-REPLAY_KEPT);
}

/** The rows after one message of the socket. A reconnect snapshot adds the events that the server keeps. */
function rowsAfter(rows: readonly ActivityRow[], message: ActivityMessage): readonly ActivityRow[] {
  if (message.type === "snapshot")
    return withRows(
      rows,
      message.events.filter(isSupport).map((event: ActivitySupport): ActivityRow => toRow(event, true)),
    );
  if (message.type !== "event" || !isSupport(message.event)) return rows;
  return withRows(rows, [toRow(message.event, !message.event.replay)]);
}

/**
 * The state after one message of the socket. Chat, moderation and playground frames change nothing: no moderation
 * removes a support event. Each other message returns `state` itself.
 */
export function activityAfter(state: ActivityState, message: ActivityMessage): ActivityState {
  if (message.type === "alerts") return message.at > state.alertsAt ? { ...state, alertsAt: message.at } : state;
  const rows: readonly ActivityRow[] = rowsAfter(state.rows, message);
  const kept: readonly KeptEvent[] = keptAfter(state.kept, message);
  return rows === state.rows && kept === state.kept ? state : { ...state, rows, kept };
}

/**
 * True when the server can still replay the alert of `row` at the server time `serverNow`. The server keeps the
 * newest REPLAY_KEPT support events of the last REPLAY_WINDOW_MS, in the order that it stored them: `kept` of the
 * state. A row that is itself a replay has no Replay, and neither has a row whose event the server answered as gone
 * (`gone`).
 */
export function replayable(
  row: ActivityRow,
  kept: readonly KeptEvent[],
  serverNow: number,
  gone: ReadonlySet<string>,
): boolean {
  if (!row.original || gone.has(row.id) || serverNow - row.receivedAt >= REPLAY_WINDOW_MS) return false;
  return kept.some((one: KeptEvent): boolean => one.id === row.id);
}

/** The state of the alerts in the part, with the local time when this page ends the alert on stream. */
export interface ShownAlerts extends AlertsState {
  /** Local time. 0 without an alert on stream. */
  until: number;
}

/**
 * The state that the part shows. The `alerts` messages of the socket give it, at the server time `at` of the newest
 * one. The answer of a control of this page is newer when the socket did not send that change yet: then it gives
 * the mute and the line. It can end the alert on stream, but only the socket starts one, so each alert on stream
 * has the time of the page.
 */
export function shownAlerts(socket: ShownAlerts, socketAt: number, reply: AlertsReply | null): ShownAlerts {
  if (reply === null || reply.at < socketAt) return socket;
  const current: AlertView | null =
    socket.current !== null && reply.current?.id === socket.current.id ? socket.current : null;
  return {
    muted: reply.muted,
    current,
    waiting: reply.waiting,
    goal: reply.goal,
    until: current === null ? 0 : socket.until,
  };
}

/** The whole seconds until the local time `until`, from the local time `now`. Never below 0. */
export function secondsLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** The line below the alert on stream: the time left, and the count of the alerts that wait when one waits. */
export function nowLine(seconds: number, waiting: number): string {
  const left: string = tn("tools.live.activity.secondsLeft", seconds);
  return waiting > 0 ? `${left} · ${tn("tools.live.activity.waiting", waiting)}` : left;
}

/** The text of each refusal of the alert host (app/lib/alert-control.ts). */
export const REFUSAL_TEXT: Readonly<Record<AlertRefusal, MessageId>> = {
  alerts_off_stream: "tools.live.activity.refused.offStream",
  goal_off: "tools.live.activity.refused.goalOff",
  alert_gone: "tools.live.activity.refused.gone",
  alerts_muted: "tools.live.activity.refused.muted",
  alerts_unwatched: "tools.live.activity.refused.unwatched",
  alert_rule_off: "tools.live.activity.refused.ruleOff",
  alerts_full: "tools.live.activity.refused.full",
  alerts_unavailable: "tools.live.activity.refused.unavailable",
};

function isRefusal(code: string): code is AlertRefusal {
  return Object.hasOwn(REFUSAL_TEXT, code);
}

/**
 * The text for a failed control, from the code and the HTTP status of the answer. Null: the answer is no refusal
 * of the alerts, and the general text of the error applies (a sign-in, a frozen page, a network error).
 */
export function refusalText(code: string | null, status: number): MessageId | null {
  if (code !== null && isRefusal(code)) return REFUSAL_TEXT[code];
  if (status === 429) return "tools.live.activity.refused.rateLimit";
  if (status === 503) return "tools.live.activity.refused.unavailable";
  return null;
}
