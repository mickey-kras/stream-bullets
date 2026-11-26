import {
  isSupport,
  type ActivityChat,
  type ActivityEvent,
  type ActivityFragment,
  type ActivityMessage,
  type ActivityPlatform,
  type ActivitySupport,
  type SupportKind,
  type SupportSource,
} from "./activity";
import { MAX_REMOVED_IDS, displayFragments } from "./chat-feed";

/**
 * The merged chat of the Live section of Streamer tools as a pure state machine (issue #1030). It reads the same
 * activity feed as the overlay chat (chat-feed.ts), but it is a log for the owner: a message stays until newer
 * messages push it out, nothing animates, and a moderated message stays in its place and says that it was removed.
 * It never runs a chat command. The support events of the feed are rows of the same log (issue #1042): no
 * moderation event removes them.
 */

export const LIVE_CHAT_LIMITS = {
  /** The newest rows that the log keeps. A paused log also keeps the rows that it showed at the pause. */
  maxRows: 500,
  /** The longest message that a platform sends is shorter, so the owner reads the whole text. */
  maxDisplayChars: 500,
  maxBadges: 2,
} as const;

interface RowBase {
  id: string;
  /** Local arrival order. Rows are always sorted by it. */
  seq: number;
  /** Server time of the event. */
  receivedAt: number;
}

export interface LiveChatRow extends RowBase {
  kind: "chat";
  platform: ActivityPlatform;
  userId: string;
  name: string;
  badges: { id: string; label: string }[];
  fragments: ActivityFragment[];
  truncated: boolean;
  /** A moderator deleted the message, or banned or timed out its author. The text does not show. */
  removed: boolean;
}

/** A support event in the log. The log has one row for each event ID. */
export interface LiveSupportRow extends RowBase {
  kind: "support";
  event: SupportKind;
  platform: SupportSource;
  /** The display name of the supporter. Null: anonymous, or the platform does not say. */
  name: string | null;
  /** The amount in the native unit of the kind (activity.ts). */
  amount: number | null;
  currency: string | null;
  /** The text that the supporter sent. Untrusted, as chat text. */
  text: string | null;
}

export type LiveRow = LiveChatRow | LiveSupportRow;

/** The key of a row in a list. A chat message and a support event can have the same ID. */
export function rowKey(row: LiveRow): string {
  return row.kind === "chat" ? row.id : `support:${row.id}`;
}

export interface LiveChatState {
  seq: number;
  /** Oldest first. */
  rows: LiveRow[];
  /** Ids of moderated messages, so a late duplicate never shows a removed message. */
  removed: ReadonlySet<string>;
  /**
   * IDs of the support events that the log got. A reconnect snapshot has a support event for 10 minutes, also
   * after newer rows pushed its row out: the ID keeps it from a second row.
   */
  supported: ReadonlySet<string>;
  /** The newest row at the time of the pause: later rows wait. Null while the log follows the newest message. */
  pausedAt: number | null;
}

export type LiveChatAction = { type: "message"; message: ActivityMessage } | { type: "pause" } | { type: "resume" };

export function initialLiveChat(): LiveChatState {
  return { seq: 0, rows: [], removed: new Set<string>(), supported: new Set<string>(), pausedAt: null };
}

function toRow(chat: ActivityChat, seq: number): LiveChatRow {
  const { fragments, truncated } = displayFragments(chat, LIVE_CHAT_LIMITS.maxDisplayChars);
  return {
    kind: "chat",
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

/** `removed` with `ids`. It keeps the newest MAX_REMOVED_IDS: the oldest ID goes first. */
function remember(removed: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  if (ids.length === 0) return removed;
  const next: string[] = [...removed, ...ids];
  return new Set<string>(next.slice(Math.max(0, next.length - MAX_REMOVED_IDS)));
}

/** The rows to keep. New messages never push out a row that a paused log shows, so the list stays in its place. */
function newest(rows: LiveRow[], pausedAt: number | null): LiveRow[] {
  const max: number = LIVE_CHAT_LIMITS.maxRows;
  const held: number = pausedAt === null ? 0 : rows.filter((row: LiveRow): boolean => row.seq <= pausedAt).length;
  return rows.length - held > max ? [...rows.slice(0, held), ...rows.slice(rows.length - max)] : rows;
}

function receiveChat(state: LiveChatState, chat: ActivityChat): LiveChatState {
  const known = (row: LiveRow): boolean => row.kind === "chat" && row.id === chat.id;
  if (state.removed.has(chat.id) || state.rows.some(known)) return state;
  const seq: number = state.seq + 1;
  return { ...state, seq, rows: newest([...state.rows, toRow(chat, seq)], state.pausedAt) };
}

/** A replay, a provider retry and the copy of a snapshot have an ID that the log got before: no second row. */
function receiveSupport(state: LiveChatState, support: ActivitySupport): LiveChatState {
  if (state.supported.has(support.id)) return state;
  const seq: number = state.seq + 1;
  const row: LiveSupportRow = {
    kind: "support",
    id: support.id,
    seq,
    event: support.kind,
    platform: support.platform,
    name: support.sender?.displayName || null,
    amount: support.amount,
    currency: support.currency,
    text: support.text || null,
    receivedAt: support.receivedAt,
  };
  const supported: ReadonlySet<string> = remember(state.supported, [support.id]);
  return { ...state, seq, supported, rows: newest([...state.rows, row], state.pausedAt) };
}

/**
 * Marks the chat rows that `match` names as removed. `id` is a message that may arrive later. A support row is
 * never removed.
 */
function moderate(state: LiveChatState, match: (row: LiveChatRow) => boolean, id: string | null): LiveChatState {
  const ids: string[] = id === null ? [] : [id];
  let changed = false;
  const rows: LiveRow[] = state.rows.map((row: LiveRow): LiveRow => {
    if (row.kind !== "chat" || row.removed || !match(row)) return row;
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
    default:
      return receiveSupport(state, event);
  }
}

/**
 * A reconnect snapshot. The snapshot has each message that the producer keeps and that is newer than `since`. A
 * newer row that the snapshot does not have was moderated while this page was away. The snapshot tells nothing
 * about older rows: they stay. A producer from before `since` sends none: then the snapshot tells only about the
 * rows that are newer than its oldest message.
 *
 * The support events of the snapshot go into the log with its chat, in the order of their receive times. A snapshot
 * tells nothing about a support row that it does not have: the row stays.
 */
function receiveSnapshot(state: LiveChatState, events: readonly ActivityEvent[], since?: number): LiveChatState {
  const chats: ActivityChat[] = events.filter((event: ActivityEvent): event is ActivityChat => event.kind === "chat");
  let next: LiveChatState = state;
  if (since !== undefined || chats.length > 0) {
    const ids = new Set<string>(chats.map((chat: ActivityChat): string => chat.id));
    const windowStart: number = since ?? Math.min(...chats.map((chat: ActivityChat): number => chat.receivedAt));
    next = moderate(state, (row: LiveChatRow): boolean => !ids.has(row.id) && row.receivedAt > windowStart, null);
  }
  const added: (ActivityChat | ActivitySupport)[] = [...chats, ...events.filter(isSupport)].sort(
    (a: ActivityChat | ActivitySupport, b: ActivityChat | ActivitySupport): number => a.receivedAt - b.receivedAt,
  );
  for (const event of added) next = event.kind === "chat" ? receiveChat(next, event) : receiveSupport(next, event);
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

/** The rows of the platforms that the owner did not filter out. A direct tip is from no platform: it always shows. */
export function shownRows(rows: readonly LiveRow[], hidden: ReadonlySet<ActivityPlatform>): LiveRow[] {
  return rows.filter((row: LiveRow): boolean => row.platform === "direct" || !hidden.has(row.platform));
}

/** The rows that arrived after the row `seq`, for the count of a paused chat. Removed messages do not count. */
export function newSince(rows: readonly LiveRow[], seq: number, hidden: ReadonlySet<ActivityPlatform>): number {
  const counts = (row: LiveRow): boolean => row.seq > seq && !(row.kind === "chat" && row.removed);
  return shownRows(rows, hidden).filter(counts).length;
}

/** The text sizes of the full-screen chat, as a factor of the normal size. The owner steps through them. */
export const CHAT_TEXT_SIZES: readonly number[] = [0.875, 1, 1.25, 1.5, 2];
/** The step that the view starts with: larger than the page text, for a phone that stands on a desk. */
export const CHAT_TEXT_DEFAULT = 2;

/** The step that a stored value names, or the default for a value that is not a step. */
export function chatTextStep(stored: string | null | undefined): number {
  const step: number = Number(stored);
  const known: boolean = stored !== null && stored !== undefined && stored !== "" && Number.isInteger(step);
  return known && step >= 0 && step < CHAT_TEXT_SIZES.length ? step : CHAT_TEXT_DEFAULT;
}

/** The next step in a direction, inside the list of sizes. */
export function nextChatTextStep(step: number, direction: 1 | -1): number {
  return Math.max(0, Math.min(CHAT_TEXT_SIZES.length - 1, step + direction));
}
