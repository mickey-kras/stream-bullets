import {
  EMOTE_HOSTS,
  type ActivityChat,
  type ActivityEvent,
  type ActivityFragment,
  type ActivityMessage,
  type ActivityPlatform,
} from "./activity";

/**
 * The merged overlay chat as a pure state machine (issue #663). It consumes the activity feed of #662 and decides
 * which rows the chat layer shows and in which phase. It reads no clock and no randomness: every action carries the
 * time, so the same actions always give the same rows.
 *
 * - Rows keep the local arrival order (`seq`). The platform's `sentAt` never reorders them.
 * - A reconnect snapshot is authoritative for its window. It never animates and never replays.
 * - Live messages wait in a short queue. A burst favours the newest messages over animation.
 * - Moderation removes rows and queued messages. Nothing here ever runs a chat command.
 */

export const CHAT_LIMITS = {
  maxRows: 40,
  maxPending: 8,
  /** Rows in their exit animation at once. Extra leaving rows vanish at once. */
  maxLeaving: 8,
  lifetimeMs: 120_000,
  removedHoldMs: 1_400,
  enterMs: 420,
  leaveMs: 240,
  enterIntervalMs: 150,
  burstThreshold: 4,
  maxDisplayChars: 200,
  maxBadges: 2,
} as const;

export type ChatLimits = { readonly [K in keyof typeof CHAT_LIMITS]: number };

/** Ids of moderated messages that the state remembers, so a late duplicate never shows a removed message again. */
export const MAX_REMOVED_IDS = 1_000;

/** The snapshot size of the producer (SNAPSHOT_SIZE in channel-ingest-limits.ts). A full snapshot has a window. */
const FULL_SNAPSHOT = 100;

export type RowPhase = "entering" | "shown" | "removed" | "leaving";

export interface ChatRow {
  id: string;
  /** Local arrival order. Rows are always sorted by it. */
  seq: number;
  platform: ActivityPlatform;
  userId: string;
  name: string;
  badges: { id: string; label: string }[];
  fragments: ActivityFragment[];
  truncated: boolean;
  /** Server time of the message (from the feed). */
  receivedAt: number;
  /** Local time from which the row's lifetime counts (for a snapshot row: its server time in local terms). */
  shownAt: number;
  phase: RowPhase;
  /** Local time the current phase started. */
  phaseAt: number;
  /** True only for a row that slides in. Snapshot rows and burst rows never animate. */
  animate: boolean;
  /** True when the message is a chat command (`!word`), so turning on hideCommands can remove it later. */
  command: boolean;
}

export interface ChatState {
  seq: number;
  /** Visible rows, oldest first. */
  rows: ChatRow[];
  /** Live messages waiting to enter, oldest first. */
  pending: ChatRow[];
  /** Ids of moderated messages (bounded by MAX_REMOVED_IDS, oldest forgotten first). */
  removed: ReadonlySet<string>;
}

export interface ChatOptions {
  hideCommands: boolean;
  limits?: Partial<ChatLimits>;
}

/**
 * `now` is local time (Date.now()). `serverOffset` is server time minus local time; it places snapshot rows in
 * local time for their lifetime. Without it the clocks are taken as equal.
 *
 * `filter` applies a changed hideCommands setting to what is already on screen. Turning it on sends shown command
 * rows to `leaving` and drops queued ones. Turning it off changes nothing: hidden commands were never kept, so only
 * new messages show commands again.
 */
export type ChatAction =
  | { type: "message"; message: ActivityMessage; now: number; serverOffset?: number }
  | { type: "tick"; now: number }
  | { type: "filter"; hideCommands: boolean; now: number }
  | { type: "reset" };

export function initialChatState(): ChatState {
  return { seq: 0, rows: [], pending: [], removed: new Set<string>() };
}

// Leading white space and invisible format characters (ZWJ, BOM, bidi marks) are skipped. "！" is the full-width "!".
const COMMAND = /^[\s\p{Cf}]*[!！][\p{L}\p{N}_-]{1,32}(?:\s|$)/u;

/** A message whose first visible text is `!word` (like `!jump` or `！jump`). The overlay can hide these. */
export function isChatCommand(text: string): boolean {
  return COMMAND.test(text);
}

let segmenter: Intl.Segmenter | null = null;

/** The user-perceived characters of a text: an emoji sequence or a letter with combining marks is one. */
export function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), (part: Intl.SegmentData): string => part.segment);
}

/**
 * The URL of an emote image, or null when it must not load: only HTTPS on the default port from EMOTE_HOSTS, with
 * no user name or password.
 */
export function safeEmoteUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const allowed: boolean =
      parsed.protocol === "https:" &&
      EMOTE_HOSTS.includes(parsed.hostname) &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "";
    return allowed ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * The fragments to show, cut to `maxChars` user-perceived characters. A cut never splits an emoji sequence or a
 * combining mark. An emote counts as one character. An emote with a URL outside EMOTE_HOSTS becomes its name as
 * text (the parser already refuses those; this is defence in depth).
 */
export function displayFragments(
  chat: ActivityChat,
  maxChars: number,
): { fragments: ActivityFragment[]; truncated: boolean } {
  const source: ActivityFragment[] =
    chat.fragments.length > 0 ? chat.fragments : chat.text ? [{ type: "text", text: chat.text }] : [];
  const fragments: ActivityFragment[] = [];
  let left: number = Math.max(0, Math.floor(maxChars));
  for (const fragment of source) {
    const part: ActivityFragment =
      fragment.type === "emote" && safeEmoteUrl(fragment.url) === null
        ? { type: "text", text: fragment.name }
        : fragment;
    if (part.type === "emote") {
      if (left === 0) return { fragments, truncated: true };
      fragments.push(part);
      left -= 1;
      continue;
    }
    if (!part.text) continue;
    const chars: string[] = graphemes(part.text);
    if (chars.length > left) {
      if (left > 0) fragments.push({ type: "text", text: chars.slice(0, left).join("") });
      return { fragments, truncated: true };
    }
    fragments.push(part);
    left -= chars.length;
  }
  return { fragments, truncated: false };
}

function limitsOf(options: ChatOptions): ChatLimits {
  return { ...CHAT_LIMITS, ...options.limits };
}

function toRow(chat: ActivityChat, seq: number, limits: ChatLimits): ChatRow {
  const { fragments, truncated } = displayFragments(chat, limits.maxDisplayChars);
  return {
    id: chat.id,
    seq,
    platform: chat.platform,
    userId: chat.user.id,
    name: chat.user.displayName || chat.user.login || "",
    badges: chat.badges.slice(0, limits.maxBadges).map((badge) => ({ id: badge.id, label: badge.label })),
    fragments,
    truncated,
    receivedAt: chat.receivedAt,
    shownAt: 0,
    phase: "shown",
    phaseAt: 0,
    animate: false,
    command: isChatCommand(chat.text),
  };
}

function hidden(chat: ActivityChat, options: ChatOptions): boolean {
  return options.hideCommands && isChatCommand(chat.text);
}

/** Applies a turned-on hideCommands to shown and queued rows (see ChatAction `filter`). */
function filterCommands(state: ChatState, hideCommands: boolean, now: number): ChatState {
  if (!hideCommands) return state;
  let changed = false;
  const rows: ChatRow[] = state.rows.map((row: ChatRow): ChatRow => {
    if (!row.command || !active(row)) return row;
    changed = true;
    return { ...row, phase: "leaving", phaseAt: now, animate: false };
  });
  const pending: ChatRow[] = state.pending.filter((row: ChatRow): boolean => !row.command);
  if (pending.length !== state.pending.length) changed = true;
  return changed ? { ...state, rows, pending } : state;
}

function active(row: ChatRow): boolean {
  return row.phase === "entering" || row.phase === "shown";
}

function remember(removed: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  if (ids.length === 0) return removed;
  const next = new Set<string>(removed);
  for (const id of ids) {
    next.delete(id);
    next.add(id);
  }
  if (next.size <= MAX_REMOVED_IDS) return next;
  const keep: string[] = [...next].slice(next.size - MAX_REMOVED_IDS);
  return new Set<string>(keep);
}

/** The local time of the newest promotion (a promotion sets `shownAt` to its time). */
function lastPromotion(rows: readonly ChatRow[]): number {
  let latest: number = Number.NEGATIVE_INFINITY;
  for (const row of rows) if (row.shownAt > latest) latest = row.shownAt;
  return latest;
}

/**
 * Moves time forward: ends finished phases, retires expired rows, promotes queued messages and enforces the row
 * bound. Returns the same object when nothing changes.
 */
function advance(state: ChatState, now: number, limits: ChatLimits): ChatState {
  let changed = false;
  let rows: ChatRow[] = [];
  for (const row of state.rows) {
    if (row.phase === "leaving" && now - row.phaseAt >= limits.leaveMs) {
      changed = true;
      continue;
    }
    if (row.phase === "removed" && now - row.phaseAt >= limits.removedHoldMs) {
      changed = true;
      continue;
    }
    if (active(row) && now - row.shownAt >= limits.lifetimeMs) {
      rows.push({ ...row, phase: "leaving", phaseAt: now });
      changed = true;
      continue;
    }
    if (row.phase === "entering" && now - row.phaseAt >= limits.enterMs) {
      rows.push({ ...row, phase: "shown", phaseAt: now });
      changed = true;
      continue;
    }
    rows.push(row);
  }
  let pending: ChatRow[] = state.pending;
  if (pending.length > 0 && now - lastPromotion(rows) >= limits.enterIntervalMs) {
    changed = true;
    if (pending.length > limits.burstThreshold) {
      // A burst: the queue holds the newest messages. Show them all at once, without animation.
      rows = [...rows, ...pending.map((row) => ({ ...row, phase: "shown" as const, shownAt: now, phaseAt: now }))];
      pending = [];
    } else {
      const [next, ...rest] = pending;
      rows = [...rows, { ...next, phase: "entering", shownAt: now, phaseAt: now, animate: true }];
      pending = rest;
    }
  }
  const bounded: ChatRow[] = bound(rows, now, limits, true);
  if (bounded !== rows) {
    changed = true;
    rows = bounded;
  }
  return changed ? { ...state, rows, pending } : state;
}

/**
 * At most `maxRows` rows that are not leaving: the oldest extra rows leave (or vanish at once when `animate` is
 * false). Leaving rows are capped at `maxLeaving`, so a burst never piles up exit animations.
 */
function bound(rows: ChatRow[], now: number, limits: ChatLimits, animate: boolean): ChatRow[] {
  const leavingOf = (list: readonly ChatRow[]): number =>
    list.filter((row: ChatRow): boolean => row.phase === "leaving").length;
  let extra: number = rows.length - leavingOf(rows) - limits.maxRows;
  let next: ChatRow[] = rows;
  if (extra > 0) {
    next = [];
    for (const row of rows) {
      if (extra > 0 && row.phase !== "leaving") {
        extra -= 1;
        if (animate) next.push({ ...row, phase: "leaving", phaseAt: now });
        continue;
      }
      next.push(row);
    }
  }
  let drop: number = leavingOf(next) - limits.maxLeaving;
  if (drop <= 0) return next;
  return next.filter((row: ChatRow): boolean => {
    if (drop <= 0 || row.phase !== "leaving") return true;
    drop -= 1;
    return false;
  });
}

function receiveChat(state: ChatState, chat: ActivityChat, options: ChatOptions): ChatState {
  const limits: ChatLimits = limitsOf(options);
  const known = (row: ChatRow): boolean => row.id === chat.id;
  if (state.removed.has(chat.id) || state.rows.some(known) || state.pending.some(known)) return state;
  if (hidden(chat, options)) return state;
  const seq: number = state.seq + 1;
  let pending: ChatRow[] = [...state.pending, toRow(chat, seq, limits)];
  // A full queue drops its oldest message: fresh chat matters more than complete chat.
  if (pending.length > limits.maxPending) pending = pending.slice(pending.length - limits.maxPending);
  return { ...state, seq, pending };
}

type Match = (row: ChatRow) => boolean;

function moderate(
  state: ChatState,
  match: Match,
  phase: "removed" | "leaving",
  extraId: string | null,
  now: number,
): ChatState {
  const ids: string[] = extraId ? [extraId] : [];
  let changed = false;
  const rows: ChatRow[] = state.rows.map((row: ChatRow): ChatRow => {
    if (!match(row)) return row;
    ids.push(row.id);
    if (!active(row)) return row;
    changed = true;
    return { ...row, phase, phaseAt: now, animate: false };
  });
  const pending: ChatRow[] = state.pending.filter((row: ChatRow): boolean => {
    if (!match(row)) return true;
    ids.push(row.id);
    changed = true;
    return false;
  });
  const removed: ReadonlySet<string> = remember(state.removed, ids);
  if (!changed && removed === state.removed) return state;
  return { ...state, rows: changed ? rows : state.rows, pending: changed ? pending : state.pending, removed };
}

function receiveEvent(state: ChatState, event: ActivityEvent, now: number, options: ChatOptions): ChatState {
  switch (event.kind) {
    case "chat":
      return receiveChat(state, event, options);
    case "delete": {
      const id = `${event.platform}:${event.messageId}`;
      return moderate(state, (row: ChatRow): boolean => row.id === id, "removed", id, now);
    }
    case "ban":
    case "clear_user":
      return moderate(
        state,
        (row: ChatRow): boolean => row.platform === event.platform && row.userId === event.userId,
        "removed",
        null,
        now,
      );
    case "clear":
      return moderate(state, (row: ChatRow): boolean => row.platform === event.platform, "leaving", null, now);
    default:
      // `status` changes nothing on screen.
      return state;
  }
}

/**
 * A reconnect snapshot. It is the server's truth for its window: a row missing from it was moderated (or expired)
 * while this page was away, and goes without animation. Rows newer than the newest row on screen are added without
 * animation, and nothing in a snapshot is ever live.
 */
function receiveSnapshot(
  state: ChatState,
  events: readonly ActivityEvent[],
  now: number,
  serverOffset: number,
  options: ChatOptions,
): ChatState {
  const limits: ChatLimits = limitsOf(options);
  const chats: ActivityChat[] = events.filter((event: ActivityEvent): event is ActivityChat => event.kind === "chat");
  const ids = new Set<string>(chats.map((chat: ActivityChat): string => chat.id));
  const windowStart: number =
    chats.length >= FULL_SNAPSHOT
      ? Math.min(...chats.map((chat: ActivityChat): number => chat.receivedAt))
      : Number.NEGATIVE_INFINITY;
  const confirmed = (row: ChatRow): boolean => !active(row) || ids.has(row.id) || row.receivedAt < windowStart;
  // Queued messages enter at once: the snapshot already holds anything newer.
  const flushed: ChatRow[] = state.pending
    .filter(confirmed)
    .map((row: ChatRow): ChatRow => ({ ...row, phase: "shown", shownAt: now, phaseAt: now, animate: false }));
  let rows: ChatRow[] = [...state.rows.filter(confirmed), ...flushed];
  const known = new Set<string>(rows.map((row: ChatRow): string => row.id));
  let newest: number = Number.NEGATIVE_INFINITY;
  for (const row of rows) if (row.receivedAt > newest) newest = row.receivedAt;
  let seq: number = state.seq;
  for (const chat of chats) {
    if (chat.receivedAt < newest || known.has(chat.id) || state.removed.has(chat.id) || hidden(chat, options)) continue;
    const shownAt: number = Math.min(now, chat.receivedAt - serverOffset);
    if (now - shownAt >= limits.lifetimeMs) continue;
    seq += 1;
    known.add(chat.id);
    rows.push({ ...toRow(chat, seq, limits), shownAt, phaseAt: now });
  }
  rows = bound(rows, now, limits, false);
  return { ...state, seq, rows, pending: [] };
}

export function chatReducer(state: ChatState, action: ChatAction, options: ChatOptions): ChatState {
  if (action.type === "reset") return initialChatState();
  const limits: ChatLimits = limitsOf(options);
  if (action.type === "tick") return advance(state, action.now, limits);
  if (action.type === "filter")
    return advance(filterCommands(state, action.hideCommands, action.now), action.now, limits);
  const { message, now } = action;
  if (message.type === "unavailable") return initialChatState();
  const next: ChatState =
    message.type === "snapshot"
      ? receiveSnapshot(state, message.events, now, action.serverOffset ?? 0, options)
      : receiveEvent(state, message.event, now, options);
  return advance(next, now, limits);
}

/** The next local time at which a `tick` changes the state, or null when nothing is scheduled. */
export function nextWakeAt(state: ChatState, options: ChatOptions): number | null {
  const limits: ChatLimits = limitsOf(options);
  let wake: number = Number.POSITIVE_INFINITY;
  for (const row of state.rows) {
    if (row.phase === "entering") wake = Math.min(wake, row.phaseAt + limits.enterMs, row.shownAt + limits.lifetimeMs);
    else if (row.phase === "shown") wake = Math.min(wake, row.shownAt + limits.lifetimeMs);
    else if (row.phase === "removed") wake = Math.min(wake, row.phaseAt + limits.removedHoldMs);
    else wake = Math.min(wake, row.phaseAt + limits.leaveMs);
  }
  if (state.pending.length > 0) {
    const due: number = lastPromotion(state.rows) + limits.enterIntervalMs;
    wake = Math.min(wake, Number.isFinite(due) ? due : 0);
  }
  return Number.isFinite(wake) ? wake : null;
}

const SAMPLE_TIME = 1_700_000_000_000;

function sample(
  index: number,
  platform: ActivityPlatform,
  user: string,
  text: string,
  extra: Partial<Pick<ActivityChat, "fragments" | "badges">> = {},
): ActivityChat {
  const messageId = `sample-${index}`;
  return {
    kind: "chat",
    id: `${platform}:${messageId}`,
    platform,
    channelId: `sample-${platform}`,
    messageId,
    user: { id: `sample-user-${index}`, displayName: user },
    text,
    fragments: extra.fragments ?? [{ type: "text", text }],
    badges: extra.badges ?? [],
    sentAt: null,
    receivedAt: SAMPLE_TIME + index * 1_000,
    live: false,
  };
}

/** Sample chat for the editor preview: every platform, Unicode, emoji, a Twitch emote, a badge and a command. */
export const SAMPLE_CHAT: readonly ActivityChat[] = [
  sample(1, "twitch", "RustBucket", "Wasteland radio is live. Grab a seat by the fire!", {
    badges: [{ id: "subscriber/12", label: "Subscriber" }],
  }),
  sample(2, "youtube", "Ngozi Okafor", "Greetings from Lagos 👋🏾 the dust storm look is wild"),
  sample(3, "kick", "Zoë_Ünter", "Wer hat noch Wasser übrig? 💧"),
  sample(4, "twitch", "scav_kid", "that boss had no chance Kappa GG", {
    fragments: [
      { type: "text", text: "that boss had no chance " },
      { type: "emote", id: "25", name: "Kappa", url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0" },
      { type: "text", text: " GG" },
    ],
  }),
  sample(5, "youtube", "ليلى", "مرحبا من القاهرة! البث رائع"),
  sample(6, "kick", "dune_runner", "!jump"),
  sample(7, "twitch", "山田太郎", "こんにちは！ 👩‍🚀🚀 family run: 👨‍👩‍👧‍👦"),
  sample(
    8,
    "youtube",
    "Long Haul Trucker",
    "Okay so I have been driving the convoy route for six hours straight, the radio keeps cutting out, " +
      "the water filter is clogged again, and I still think this is the best stream on the whole frequency. " +
      "Keep the lights on, everyone, and save me a can of beans.",
  ),
  sample(9, "kick", "Mad Maxine", "V8! 🔥🔥🔥"),
];
