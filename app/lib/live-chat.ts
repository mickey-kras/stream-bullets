import type { ActivityChat, ActivityEvent, ActivityFragment, ActivityMessage, ActivityPlatform } from "./activity";
import { MAX_REMOVED_IDS, displayFragments } from "./chat-feed";

/**
 * The merged chat of the Live section of Streamer tools as a pure state machine (issue #1030). It reads the same
 * activity feed as the overlay chat (chat-feed.ts), but it is a log for the owner: a message stays until newer
 * messages push it out, nothing animates, and a moderated message stays in its place and says that it was removed.
 * It never runs a chat command.
 */

export const LIVE_CHAT_LIMITS = {
  /** The newest rows that the log keeps. A paused log also keeps the rows that it showed at the pause. */
  maxRows: 500,
  /** The longest message that a platform sends is shorter, so the owner reads the whole text. */
  maxDisplayChars: 500,
  maxBadges: 2,
} as const;

export interface LiveChatRow {
  id: string;
  /** Local arrival order. Rows are always sorted by it. */
  seq: number;
  platform: ActivityPlatform;
  userId: string;
  name: string;
  badges: { id: string; label: string }[];
  fragments: ActivityFragment[];
  truncated: boolean;
  /** Server time of the message. */
  receivedAt: number;
  /** A moderator deleted the message, or banned or timed out its author. The text does not show. */
  removed: boolean;
}

export interface LiveChatState {
  seq: number;
  /** Oldest first. */
  rows: LiveChatRow[];
  /** Ids of moderated messages, so a late duplicate never shows a removed message. */
  removed: ReadonlySet<string>;
  /** The newest row at the time of the pause: later rows wait. Null while the log follows the newest message. */
  pausedAt: number | null;
}

export type LiveChatAction = { type: "message"; message: ActivityMessage } | { type: "pause" } | { type: "resume" };

export function initialLiveChat(): LiveChatState {
  return { seq: 0, rows: [], removed: new Set<string>(), pausedAt: null };
}

function toRow(chat: ActivityChat, seq: number): LiveChatRow {
  const { fragments, truncated } = displayFragments(chat, LIVE_CHAT_LIMITS.maxDisplayChars);
  return {
    id: chat.id,
    seq,
    platform: chat.platform,
    userId: chat.user.id,
    name: chat.user.displayName || chat.user.login || "",
    badges: chat.badges.slice(0, LIVE_CHAT_LIMITS.maxBadges).map((badge) => ({ id: badge.id, label: badge.label })),
    fragments,
    truncated,
    receivedAt: chat.receivedAt,
    removed: false,
  };
}

function remember(removed: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  if (ids.length === 0) return removed;
  const next: string[] = [...removed, ...ids];
  return new Set<string>(next.slice(Math.max(0, next.length - MAX_REMOVED_IDS)));
}

/** The rows to keep. New messages never push out a row that a paused log shows, so the list stays in its place. */
function newest(rows: LiveChatRow[], pausedAt: number | null): LiveChatRow[] {
  const max: number = LIVE_CHAT_LIMITS.maxRows;
  const held: number = pausedAt === null ? 0 : rows.filter((row: LiveChatRow): boolean => row.seq <= pausedAt).length;
  return rows.length - held > max ? [...rows.slice(0, held), ...rows.slice(rows.length - max)] : rows;
}

function receiveChat(state: LiveChatState, chat: ActivityChat): LiveChatState {
  if (state.removed.has(chat.id) || state.rows.some((row: LiveChatRow): boolean => row.id === chat.id)) return state;
  const seq: number = state.seq + 1;
  return { ...state, seq, rows: newest([...state.rows, toRow(chat, seq)], state.pausedAt) };
}

/** Marks the rows that `match` names as removed. `id` is a message that may arrive later. */
function moderate(state: LiveChatState, match: (row: LiveChatRow) => boolean, id: string | null): LiveChatState {
  const ids: string[] = id === null ? [] : [id];
  let changed = false;
  const rows: LiveChatRow[] = state.rows.map((row: LiveChatRow): LiveChatRow => {
    if (row.removed || !match(row)) return row;
    changed = true;
    if (row.id !== id) ids.push(row.id);
    return { ...row, removed: true, fragments: [], badges: [], truncated: false };
  });
  const removed: ReadonlySet<string> = remember(state.removed, ids);
  if (!changed && removed === state.removed) return state;
  return { ...state, rows: changed ? rows : state.rows, removed };
}

function receiveEvent(state: LiveChatState, event: ActivityEvent): LiveChatState {
  switch (event.kind) {
    case "chat":
      return receiveChat(state, event);
    case "delete": {
      const id = `${event.platform}:${event.messageId}`;
      return moderate(state, (row: LiveChatRow): boolean => row.id === id, id);
    }
    case "ban":
    case "clear_user":
      return moderate(
        state,
        (row: LiveChatRow): boolean => row.platform === event.platform && row.userId === event.userId,
        null,
      );
    case "clear":
      return moderate(state, (row: LiveChatRow): boolean => row.platform === event.platform, null);
    case "status":
      return state;
  }
}

/**
 * A reconnect snapshot. The snapshot has each message that the producer keeps and that is newer than `since`. A
 * newer row that the snapshot does not have was moderated while this page was away. The snapshot tells nothing
 * about older rows: they stay. A producer from before `since` sends none: then the snapshot tells only about the
 * rows that are newer than its oldest message.
 */
function receiveSnapshot(state: LiveChatState, events: readonly ActivityEvent[], since?: number): LiveChatState {
  const chats: ActivityChat[] = events.filter((event: ActivityEvent): event is ActivityChat => event.kind === "chat");
  if (since === undefined && chats.length === 0) return state;
  const ids = new Set<string>(chats.map((chat: ActivityChat): string => chat.id));
  const windowStart: number = since ?? Math.min(...chats.map((chat: ActivityChat): number => chat.receivedAt));
  const gone = (row: LiveChatRow): boolean => !ids.has(row.id) && row.receivedAt > windowStart;
  let next: LiveChatState = moderate(state, gone, null);
  for (const chat of chats) next = receiveChat(next, chat);
  return next;
}

/** The next state of the log. Of the messages of the activity socket, playground frames change nothing. */
export function liveChatReducer(state: LiveChatState, action: LiveChatAction): LiveChatState {
  if (action.type === "pause") return state.pausedAt === null ? { ...state, pausedAt: state.seq } : state;
  if (action.type === "resume") return { ...state, pausedAt: null, rows: newest(state.rows, null) };
  const { message } = action;
  if (message.type === "snapshot") return receiveSnapshot(state, message.events, message.since);
  if (message.type === "event") return receiveEvent(state, message.event);
  return state;
}

/** The rows of the platforms that the owner did not filter out. */
export function shownRows(rows: readonly LiveChatRow[], hidden: ReadonlySet<ActivityPlatform>): LiveChatRow[] {
  return rows.filter((row: LiveChatRow): boolean => !hidden.has(row.platform));
}

/** The messages that arrived after the row `seq`, for the count of a paused chat. Removed messages do not count. */
export function newSince(rows: readonly LiveChatRow[], seq: number, hidden: ReadonlySet<ActivityPlatform>): number {
  return shownRows(rows, hidden).filter((row: LiveChatRow): boolean => row.seq > seq && !row.removed).length;
}
