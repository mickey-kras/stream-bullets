import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type UIEvent,
} from "react";
import { Dialog as RadixDialog, ScrollArea } from "radix-ui";
import { t, type MessageId } from "../../i18n";
import type { ActivityFragment, ActivityPlatform } from "../../lib/activity";
import {
  CHAT_TEXT_SIZES,
  chatTextStep,
  initialLiveChat,
  liveChatReducer,
  newSince,
  nextChatTextStep,
  shownRows,
  type LiveChatRow,
} from "../../lib/live-chat";
import { toolsPath } from "../../lib/shell";
import type { ActivityFeed, ActivityFeedStatus } from "../overlay/activity-feed";
import { ControlApiContext } from "../overlay/control-api";
import { ChatFragment } from "../overlay/chat-layer";
import { PlatformIcon } from "../overlay/wasteland/glyphs";
import { PLATFORM_NAMES } from "../overlay/wasteland/theme";
import { useReturnFocus } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { LivePart } from "./live-part";
import { useWakeLock, type WakeLockState } from "./use-wake-lock";

const PLATFORMS: readonly ActivityPlatform[] = ["twitch", "youtube", "kick"];

/** The list counts as scrolled up when its end is this far below the view, in pixels. */
const PAUSE_DISTANCE = 32;

/** Where the device keeps the text size of the full-screen chat. */
const TEXT_SIZE_KEY = "sb-chat-text";

/** What the panel says about a feed that is not live, or null for a live feed. */
const FEED_TEXT: Readonly<Record<ActivityFeedStatus, MessageId | null>> = {
  live: null,
  connecting: "tools.live.chat.connecting",
  reconnecting: "tools.live.chat.reconnecting",
  refused: "tools.live.chat.unavailable",
  off: "tools.live.chat.unavailable",
};

function ChatRow({ row }: Readonly<{ row: LiveChatRow }>): ReactNode {
  const occurrences = new Map<string, number>();
  return (
    <li
      className="tl-chat-row"
      data-chat-row={row.id}
      data-platform={row.platform}
      data-removed={row.removed || undefined}
    >
      <PlatformIcon className="tl-chat-icon" platform={row.platform} label={PLATFORM_NAMES[row.platform]} />
      {row.badges.map((badge) => (
        <span className="tl-chat-badge" key={badge.id}>
          {badge.label}{" "}
        </span>
      ))}
      <strong className="tl-chat-name">
        <bdi>{row.name}</bdi>
      </strong>{" "}
      <span className="tl-chat-text" dir="auto">
        {row.removed
          ? t("overlay.chat.removed")
          : row.fragments.map((fragment: ActivityFragment) => {
              const content: string = JSON.stringify(fragment);
              const occurrence: number = occurrences.get(content) ?? 0;
              occurrences.set(content, occurrence + 1);
              return <ChatFragment key={`${content}:${occurrence}`} fragment={fragment} />;
            })}
        {row.truncated && "…"}
      </span>
    </li>
  );
}

/** The chat log with its pause and its platform filters: one state for the panel and for the full-screen view. */
export interface ChatModel {
  /** The rows in view: the platforms that are not hidden, up to the pause. */
  rows: LiveChatRow[];
  /** True while the list keeps its place. */
  paused: boolean;
  /** The messages that arrived after the pause. */
  waiting: number;
  pause: () => void;
  jump: () => void;
  hidden: ReadonlySet<ActivityPlatform>;
  toggle: (platform: ActivityPlatform) => void;
  /** The scrolling element of the list. The list is in one place at a time. */
  list: (element: HTMLDivElement | null) => void;
  scrolled: (event: UIEvent<HTMLDivElement>) => void;
  status: ActivityFeedStatus;
}

/**
 * The merged chat of the connected platforms, for the owner. New messages keep the newest in view. A scroll up, or
 * the pause button, pauses the list: it then keeps its place and counts the new messages. "Jump to latest" resumes
 * it. The pause and the platform filters are local to this browser. A moderated message keeps its row and loses
 * its text, also while the list is paused.
 */
export function useChatModel(feed: ActivityFeed): ChatModel {
  const [state, receive] = useReducer(liveChatReducer, undefined, initialLiveChat);
  const { subscribe } = feed;
  useEffect(() => subscribe(receive), [subscribe]);
  const [hidden, setHidden] = useState<ReadonlySet<ActivityPlatform>>(new Set<ActivityPlatform>());
  // The newest row at the time of the pause: later rows wait. Null while the chat follows the newest message.
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const element = useRef<HTMLDivElement | null>(null);
  // The last scroll position, to tell a scroll up from a list that only changed its size.
  const top = useRef<number>(0);
  const following = useRef<boolean>(true);
  const sizes = useRef<ResizeObserver | null>(null);
  const rows: LiveChatRow[] = shownRows(state.rows, hidden).filter(
    (row: LiveChatRow): boolean => pausedAt === null || row.seq <= pausedAt,
  );
  const last: number = rows.at(-1)?.seq ?? 0;
  const toEnd = useCallback((current: HTMLDivElement): void => {
    current.scrollTop = current.scrollHeight;
    top.current = current.scrollTop;
  }, []);
  useLayoutEffect(() => {
    following.current = pausedAt === null;
    const current: HTMLDivElement | null = element.current;
    if (current && pausedAt === null) toEnd(current);
  }, [last, pausedAt, toEnd]);
  // A list that comes on screen starts at its end: the panel after a load, the full-screen view when it opens.
  // While the list follows, it also stays at its end when its size changes: a new text size, a turn of the phone.
  const list = useCallback(
    (next: HTMLDivElement | null): void => {
      sizes.current?.disconnect();
      sizes.current = null;
      element.current = next;
      if (!next) return;
      toEnd(next);
      if (typeof ResizeObserver !== "function") return;
      const observer = new ResizeObserver((): void => {
        if (following.current) toEnd(next);
      });
      observer.observe(next);
      const content: Element | null = next.querySelector(".tl-chat-list");
      if (content) observer.observe(content);
      sizes.current = observer;
    },
    [toEnd],
  );
  // Only a scroll up pauses. A list that grows or shrinks also sends scroll events, and they do not go up.
  const scrolled = (event: UIEvent<HTMLDivElement>): void => {
    const current: HTMLDivElement = event.currentTarget;
    const up: boolean = current.scrollTop < top.current - 1;
    top.current = current.scrollTop;
    const below: number = current.scrollHeight - current.scrollTop - current.clientHeight;
    if (pausedAt === null && up && below > PAUSE_DISTANCE) setPausedAt(state.seq);
  };
  const toggle = (platform: ActivityPlatform): void =>
    setHidden((current: ReadonlySet<ActivityPlatform>): ReadonlySet<ActivityPlatform> => {
      const next = new Set<ActivityPlatform>(current);
      if (!next.delete(platform)) next.add(platform);
      return next;
    });
  return {
    rows,
    paused: pausedAt !== null,
    waiting: pausedAt === null ? 0 : newSince(state.rows, pausedAt, hidden),
    pause: (): void => setPausedAt(state.seq),
    jump: (): void => setPausedAt(null),
    hidden,
    toggle,
    list,
    scrolled,
    status: feed.status,
  };
}

function ChatFilters({ chat }: Readonly<{ chat: ChatModel }>): ReactNode {
  return (
    <fieldset className="tl-chat-filters">
      <legend className="sr-only">{t("tools.live.chat.filters")}</legend>
      <div className="seg">
        {PLATFORMS.map((platform: ActivityPlatform) => (
          <button
            key={platform}
            type="button"
            aria-pressed={!chat.hidden.has(platform)}
            data-chat-filter={platform}
            onClick={() => chat.toggle(platform)}
          >
            {PLATFORM_NAMES[platform]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** The list scrolls, so the keyboard must reach it: the scroll area takes the focus, as the topic list does. */
function ChatList({
  rows,
  paused,
  listRef,
  onScroll,
  style,
}: Readonly<{
  rows: readonly LiveChatRow[];
  paused: boolean;
  listRef: (element: HTMLDivElement | null) => void;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
  style?: CSSProperties;
}>): ReactNode {
  return (
    <ScrollArea.Root className="tl-chat-root">
      <ScrollArea.Viewport asChild tabIndex={0} style={{ overflowY: "auto" }}>
        <div
          className="tl-chat"
          ref={listRef}
          role="log"
          aria-label={t("tools.live.chat")}
          onScroll={onScroll}
          data-live-chat
          data-paused={paused || undefined}
        >
          <ol className="tl-chat-list" style={style}>
            {rows.map((row: LiveChatRow) => (
              <ChatRow key={row.id} row={row} />
            ))}
          </ol>
        </div>
      </ScrollArea.Viewport>
    </ScrollArea.Root>
  );
}

/** The pause of the list: its button while the list follows, and the count with "Jump to latest" while it waits. */
function ChatPause({ chat, hint }: Readonly<{ chat: ChatModel; hint: boolean }>): ReactNode {
  if (chat.paused)
    return (
      <>
        <span data-chat-paused>{t("tools.live.chat.paused", { count: chat.waiting })}</span>
        <button type="button" className="small-button" data-chat-jump onClick={chat.jump}>
          {t("tools.live.chat.jump")}
        </button>
      </>
    );
  return (
    <>
      {hint && <span className="muted">{t("tools.live.chat.hint")}</span>}
      <button type="button" className="small-button" data-chat-pause onClick={chat.pause}>
        {t("tools.live.chat.pause")}
      </button>
    </>
  );
}

function ChatNotes({ chat, delivers }: Readonly<{ chat: ChatModel; delivers: boolean }>): ReactNode {
  const feedText: MessageId | null = FEED_TEXT[chat.status];
  // The dock has no session, so a link to Streamer tools leads nowhere there.
  const session: boolean = useContext(ControlApiContext).key === null;
  return (
    <>
      {!delivers && (
        <p className="muted tl-note" data-chat-no-channel>
          {t("tools.live.chat.noChannel")}{" "}
          {session && (
            <a className="text-link" href={toolsPath("channels")}>
              {t("tools.live.openChannels")}
            </a>
          )}
        </p>
      )}
      {feedText && (
        <p className="muted tl-note" data-chat-feed={chat.status}>
          {t(feedText)}
        </p>
      )}
    </>
  );
}

// The text size of the full-screen chat as a store, so each view of it follows a change at once. The device keeps
// the size. If the browser blocks its storage, the size holds until the page closes.
const sizeListeners = new Set<() => void>();
let sizeInMemory: number | null = null;

function subscribeSize(listener: () => void): () => void {
  sizeListeners.add(listener);
  globalThis.addEventListener("storage", listener);
  return (): void => {
    sizeListeners.delete(listener);
    globalThis.removeEventListener("storage", listener);
  };
}

function storedSize(): number {
  if (sizeInMemory !== null) return sizeInMemory;
  try {
    return chatTextStep(globalThis.localStorage?.getItem(TEXT_SIZE_KEY));
  } catch {
    return chatTextStep(null);
  }
}

function keepSize(step: number): void {
  sizeInMemory = step;
  try {
    globalThis.localStorage?.setItem(TEXT_SIZE_KEY, String(step));
  } catch {
    // Storage is blocked: the size holds until the page closes.
  }
  for (const listener of sizeListeners) listener();
}

/** The text size step of the full-screen chat. The stored size applies after the page loads. */
function useChatTextSize(): { step: number; change: (direction: 1 | -1) => void } {
  const step: number = useSyncExternalStore(subscribeSize, storedSize, (): number => chatTextStep(null));
  return { step, change: (direction: 1 | -1): void => keepSize(nextChatTextStep(step, direction)) };
}

/**
 * The full-screen chat for a phone that stands in front of the streamer: the controls, the item on stream in one
 * line, and the chat. In portrait the controls are at the top. In landscape they are in a rail at the side.
 */
export function FullChatView({
  chat,
  delivers,
  onAir,
  wake,
  step,
  onStep,
  onExit,
}: Readonly<{
  chat: ChatModel;
  delivers: boolean;
  /** What is on stream, in one line, or null for nothing. */
  onAir: string | null;
  wake: WakeLockState;
  step: number;
  onStep: (direction: 1 | -1) => void;
  onExit: () => void;
}>): ReactNode {
  return (
    <div className="tl-full-body" data-chat-full>
      <div className="tl-full-rail">
        <button type="button" className="small-button" data-chat-exit onClick={onExit}>
          <Icon name="close" size={16} />
          {t("tools.live.chat.exit")}
        </button>
        <div className="tl-full-sizes">
          <button
            type="button"
            className="small-button"
            aria-label={t("tools.live.chat.smaller")}
            disabled={step === 0}
            data-chat-smaller
            onClick={() => onStep(-1)}
          >
            <span aria-hidden="true">A−</span>
          </button>
          <button
            type="button"
            className="small-button"
            aria-label={t("tools.live.chat.larger")}
            disabled={step === CHAT_TEXT_SIZES.length - 1}
            data-chat-larger
            onClick={() => onStep(1)}
          >
            <span aria-hidden="true">A+</span>
          </button>
        </div>
        <ChatFilters chat={chat} />
        <div className="tl-full-pause">
          <ChatPause chat={chat} hint={false} />
        </div>
      </div>
      <div className="tl-full-main">
        {onAir && (
          <p className="tl-full-air" data-chat-on-air>
            {t("tools.live.chat.onAir", { title: onAir })}
          </p>
        )}
        <ChatNotes chat={chat} delivers={delivers} />
        {wake !== "on" && (
          <p className="muted tl-note" data-chat-wake={wake}>
            {t("tools.live.chat.screenOff")}
          </p>
        )}
        <ChatList
          rows={chat.rows}
          paused={chat.paused}
          listRef={chat.list}
          onScroll={chat.scrolled}
          style={{ fontSize: `${CHAT_TEXT_SIZES[step]}rem` }}
        />
      </div>
    </div>
  );
}

/**
 * The full-screen view as a dialog over the page. It keeps the screen on while it is open. Where the browser can
 * show an element in full screen, the view asks for that, so the browser bars go too. iPhone Safari cannot: there
 * the view covers the page, and the bars of the site are under it. Leaving the full screen of the browser exits.
 */
function FullChat({
  open,
  onExit,
  ...view
}: Readonly<{
  open: boolean;
  onExit: () => void;
  chat: ChatModel;
  delivers: boolean;
  onAir: string | null;
}>): ReactNode {
  const wake: WakeLockState = useWakeLock(open);
  const { step, change } = useChatTextSize();
  const focus = useReturnFocus();
  // The dialog puts its element on the page after it opens, so the element is state: the effect waits for it.
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const exit = useRef<() => void>(onExit);
  useEffect(() => {
    exit.current = onExit;
  });
  useEffect(() => {
    if (!open || !content) return;
    let entered = false;
    // The browser refuses without a user action, as after a load of the address: the view then covers the page.
    content.requestFullscreen?.().then(
      (): void => {
        entered = true;
      },
      (): void => undefined,
    );
    const changed = (): void => {
      if (entered && document.fullscreenElement === null) exit.current();
    };
    document.addEventListener("fullscreenchange", changed);
    return (): void => {
      document.removeEventListener("fullscreenchange", changed);
      if (document.fullscreenElement !== null) void document.exitFullscreen().catch((): void => undefined);
    };
  }, [open, content]);
  return (
    <RadixDialog.Root open={open} onOpenChange={(next: boolean) => !next && onExit()}>
      <RadixDialog.Portal>
        <RadixDialog.Content
          className="tl-full"
          ref={setContent}
          aria-describedby={undefined}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
        >
          <RadixDialog.Title className="sr-only">{t("tools.live.chat.fullTitle")}</RadixDialog.Title>
          <FullChatView {...view} wake={wake} step={step} onStep={change} onExit={onExit} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * The chat part of the Live section, and its full-screen view. The list is in the view while the view is open, so
 * the page under it does not draw the rows twice.
 */
export function LiveChat({
  feed,
  delivers,
  full = false,
  onFull,
  onAir = null,
}: Readonly<{
  feed: ActivityFeed;
  delivers: boolean;
  /** True while the full-screen view is open. The page keeps this in its address. */
  full?: boolean;
  /** Opens or exits the full-screen view. Without it the part has no button for the view. */
  onFull?: (open: boolean) => void;
  onAir?: string | null;
}>): ReactNode {
  const chat: ChatModel = useChatModel(feed);
  return (
    <LivePart name="chat" title={t("tools.live.chat")}>
      <ChatFilters chat={chat} />
      <ChatNotes chat={chat} delivers={delivers} />
      {!full && <ChatList rows={chat.rows} paused={chat.paused} listRef={chat.list} onScroll={chat.scrolled} />}
      {chat.rows.length === 0 && (
        <p className="muted tl-note" data-chat-empty>
          {t("tools.live.chat.empty")}
        </p>
      )}
      <div className="tl-actions tl-chat-bar">
        <ChatPause chat={chat} hint />
      </div>
      {onFull && (
        <p className="tl-note">
          <button type="button" className="small-button" data-chat-open-full onClick={() => onFull(true)}>
            <Icon name="overlay" size={16} />
            {t("tools.live.chat.full")}
          </button>
        </p>
      )}
      {onFull && <FullChat open={full} onExit={() => onFull(false)} chat={chat} delivers={delivers} onAir={onAir} />}
    </LivePart>
  );
}
