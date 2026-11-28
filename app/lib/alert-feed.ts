import type { ActivityMessage, ActivityPlatform } from "./activity";
import { alertShownOn, type AlertsState, type AlertView } from "./alerts";
import type { GoalProgress } from "./goals";
import type { GoalLayer } from "./overlay-layers";

/**
 * What an overlay page makes of the alert messages of the activity socket (issue #1043): the alert on stream with
 * the time that the page shows it, the mark in chat, and the bar of the goal. This module is pure and reads no
 * clock: each function gets the time.
 */

/**
 * What the overlay shows of an alert: who, what, and where from. It has no text of the supporter. That text never
 * shows on the banner or on the mark in chat: it stays in chat and in the lists of the owner.
 */
export type AlertFace = Pick<
  AlertView,
  "id" | "origin" | "kind" | "platform" | "name" | "anonymous" | "amount" | "currency"
>;

/** The face of a view. It names each field, so a new field of a view never shows on stream by accident. */
export function alertFace(view: AlertView): AlertFace {
  return {
    id: view.id,
    origin: view.origin,
    kind: view.kind,
    platform: view.platform,
    // An anonymous alert never shows a name, also when a faulty producer sends one.
    name: view.anonymous ? null : view.name,
    anonymous: view.anonymous,
    amount: view.amount,
    currency: view.currency,
  };
}

/** The alert of the editor preview. It is a sample of the look: no event made it. */
export const SAMPLE_ALERT: AlertFace = {
  id: "sample",
  origin: "live",
  kind: "gift",
  platform: "twitch",
  name: "Mad Maxine",
  anonymous: false,
  amount: 5,
  currency: null,
};

/** The state of a page that got no `alerts` message: no alert, and no count of the goal. */
export const NO_ALERTS: AlertsState = { muted: false, current: null, waiting: 0, goal: null };

/** What a page keeps of the `alerts` messages. */
export interface AlertsSeen {
  /** The state of the newest `alerts` message. */
  state: AlertsState;
  /** The local time when the page got the alert on stream (`state.current`) for the first time. 0 without one. */
  seenAt: number;
}

export const INITIAL_ALERTS: AlertsSeen = { state: NO_ALERTS, seenAt: 0 };

/** `seen` without an alert on stream and without a line. The mute state and the goal stay. */
function withoutAlert(seen: AlertsSeen): AlertsSeen {
  if (seen.state.current === null && seen.state.waiting === 0) return seen;
  return { state: { ...seen.state, current: null, waiting: 0 }, seenAt: 0 };
}

/**
 * `seen` after one message of the socket at the local time `now`. An `alerts` message is the whole state, so it
 * replaces the state. A message with the alert that the page shows keeps the time of the first one: the server sends
 * the state again while the alert is on stream, for example when the goal counts. `unavailable` ends the alert: the
 * feed is off, so no message would end it. Each other message returns `seen` itself.
 */
export function alertsAfter(seen: AlertsSeen, message: ActivityMessage, now: number): AlertsSeen {
  if (message.type === "unavailable") return withoutAlert(seen);
  if (message.type !== "alerts") return seen;
  const { muted, current, waiting, goal } = message;
  const state: AlertsState = { muted, current, waiting, goal };
  if (current === null) return { state, seenAt: 0 };
  return { state, seenAt: seen.state.current?.id === current.id ? seen.seenAt : now };
}

/**
 * How long the page shows the alert on stream, counted from `seen.seenAt`, in milliseconds. 0 without an alert, and
 * for an alert that ended. `serverOffset` is server time minus local time. The time is never longer than the alert
 * itself, so a page with a wrong clock never keeps a banner on stream. A page that connects during an alert shows
 * only the time that is left.
 */
export function bannerMs(seen: AlertsSeen, serverOffset: number): number {
  const alert: AlertView | null = seen.state.current;
  if (alert === null) return 0;
  const left: number = alert.endsAt - (seen.seenAt + serverOffset);
  return Math.max(0, Math.min(left, alert.endsAt - alert.startsAt));
}

/** The alert of a message that a chat can mark: an alert that plays at once, or the alert on stream. */
function markedAlert(message: ActivityMessage, serverNow: number): AlertView | null {
  if (message.type === "alert") return message.alert;
  if (message.type !== "alerts" || message.current === null) return null;
  // A state from before the end of its alert can come late, and a late reader gets the last state: no mark then.
  return serverNow < message.current.endsAt ? message.current : null;
}

/**
 * The alert that the chat of an output marks for `message` at the server time `serverNow`, or null. The rule of the
 * alert must have the mark in chat on, and an output that shows only `platform` marks only the alerts that it shows
 * (`alertShownOn`). The server sends the state again while an alert is on stream: the chat marks each alert ID one
 * time (app/lib/chat-feed.ts).
 */
export function chatMark(
  message: ActivityMessage,
  platform: ActivityPlatform | null,
  serverNow: number,
): AlertView | null {
  const alert: AlertView | null = markedAlert(message, serverNow);
  return alert?.chat && alertShownOn(alert, platform) ? alert : null;
}

/** What the goal layer shows. */
export interface GoalBar {
  /** The count. It can be more than the target. */
  value: number;
  target: number;
  /** The part of the bar that is full, from 0 to 1. A count above the target is a full bar. */
  part: number;
}

/**
 * The bar of the goal layer for the count that the server sent. The count is 0 before the first message, and while
 * the server still counts a different thing than the layer: a goal that counts a new thing starts again.
 */
export function goalBar(goal: Pick<GoalLayer, "counts" | "target">, progress: GoalProgress | null): GoalBar {
  const value: number = progress?.counts === goal.counts ? progress.value : 0;
  const target: number = Math.max(1, goal.target);
  return { value, target, part: Math.min(1, value / target) };
}
