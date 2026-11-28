import type { ActivityChat, ActivityEvent, ActivityMessage } from "./activity";

/** The state of the alerts as the socket sends it: the `alerts` message. */
export type AlertsStateMessage = Extract<ActivityMessage, { type: "alerts" }>;

/**
 * What an activity feed keeps of its socket for a reader that subscribes later. A socket sends its snapshot one time,
 * so a late reader would start empty. The history is what a new socket would get now: the chat of the snapshot and of
 * the events after it, without the messages that moderation removed, and the last state of the alerts.
 *
 * No support event is kept, and no `alert` message: an alert must not play again for a late reader. The state of
 * the alerts has the times of the alert on stream, so a late reader shows only the time that is left, and it has
 * the count of the goal.
 */
export interface ActivityHistory {
  /** False until the socket sent its snapshot: before that, the reader gets the snapshot of the socket itself. */
  ready: boolean;
  /** The chat messages, oldest first. */
  chats: readonly ActivityChat[];
  /** The receive time after which `chats` has each message that was not moderated. Undefined: the snapshot named none. */
  since: number | undefined;
  /** The newest `alerts` message of the socket. Null: the socket sent none. */
  alerts: AlertsStateMessage | null;
}

/** As many messages as a snapshot of the server holds (SNAPSHOT_SIZE of the ingest). */
export const HISTORY_SIZE = 100;

export function emptyHistory(): ActivityHistory {
  return { ready: false, chats: [], since: undefined, alerts: null };
}

function isChat(event: ActivityEvent): event is ActivityChat {
  return event.kind === "chat";
}

/** The newest `HISTORY_SIZE` messages. A message that leaves for the size raises `since`, as on the server. */
function trimmed(history: ActivityHistory): ActivityHistory {
  const extra: number = history.chats.length - HISTORY_SIZE;
  if (extra <= 0) return history;
  const left: number = Math.max(...history.chats.slice(0, extra).map((chat: ActivityChat): number => chat.receivedAt));
  return { ...history, chats: history.chats.slice(extra), since: Math.max(history.since ?? left, left) };
}

function without(history: ActivityHistory, gone: (chat: ActivityChat) => boolean): ActivityHistory {
  const chats: ActivityChat[] = history.chats.filter((chat: ActivityChat): boolean => !gone(chat));
  return chats.length === history.chats.length ? history : { ...history, chats };
}

function keepEvent(history: ActivityHistory, event: ActivityEvent): ActivityHistory {
  switch (event.kind) {
    case "chat":
      if (history.chats.some((chat: ActivityChat): boolean => chat.id === event.id)) return history;
      return trimmed({ ...history, chats: [...history.chats, event] });
    case "delete": {
      const id = `${event.platform}:${event.messageId}`;
      return without(history, (chat: ActivityChat): boolean => chat.id === id);
    }
    case "ban":
    case "clear_user":
      return without(
        history,
        (chat: ActivityChat): boolean => chat.platform === event.platform && chat.user.id === event.userId,
      );
    case "clear":
      return without(history, (chat: ActivityChat): boolean => chat.platform === event.platform);
    default:
      return history;
  }
}

/** `history` after one message of the socket. */
export function keepHistory(history: ActivityHistory, message: ActivityMessage): ActivityHistory {
  if (message.type === "unavailable") return emptyHistory();
  if (message.type === "snapshot")
    return trimmed({ ...history, ready: true, chats: message.events.filter(isChat), since: message.since });
  if (message.type === "alerts") return { ...history, alerts: message };
  // Before the snapshot the socket sent nothing that a late reader needs: the snapshot holds it.
  if (message.type === "event") return history.ready ? keepEvent(history, message.event) : history;
  return history;
}

/** The snapshot for a reader that subscribes now, or null while the socket sent none. */
export function historySnapshot(history: ActivityHistory): ActivityMessage | null {
  if (!history.ready) return null;
  const snapshot: ActivityMessage = { type: "snapshot", events: [...history.chats], replay: true };
  return history.since === undefined ? snapshot : { ...snapshot, since: history.since };
}

/**
 * The messages for a reader that subscribes now, in the sequence of the socket: the snapshot, then the state of the
 * alerts. Empty while the socket sent none of them.
 */
export function historyMessages(history: ActivityHistory): ActivityMessage[] {
  const snapshot: ActivityMessage | null = historySnapshot(history);
  return [...(snapshot ? [snapshot] : []), ...(history.alerts ? [history.alerts] : [])];
}
