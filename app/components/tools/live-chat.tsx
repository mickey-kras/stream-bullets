import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode, type UIEvent } from "react";
import { t, type MessageId } from "../../i18n";
import type { ActivityFragment, ActivityPlatform } from "../../lib/activity";
import {
  initialLiveChat,
  liveChatReducer,
  newSince,
  shownRows,
  type LiveChatRow,
  type LiveChatState,
} from "../../lib/live-chat";
import { toolsPath } from "../../lib/shell";
import type { ActivityFeed, ActivityFeedStatus } from "../overlay/activity-feed";
import { ChatFragment } from "../overlay/chat-layer";
import { PlatformIcon } from "../overlay/wasteland/glyphs";
import { PLATFORM_NAMES } from "../overlay/wasteland/theme";
import { LivePart } from "./live-part";

const PLATFORMS: readonly ActivityPlatform[] = ["twitch", "youtube", "kick"];

/** The list counts as scrolled up when its end is this far below the view, in pixels. */
const PAUSE_DISTANCE = 32;

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

/**
 * The merged chat of the connected platforms, for the owner. New messages keep the newest in view. A scroll up, or
 * the pause button, pauses the list: it then keeps its place and counts the new messages. "Jump to latest" resumes
 * it. The pause and the platform filters are local to this browser. A moderated message keeps its row and loses
 * its text, also while the list is paused.
 */
export function LiveChat({ feed, delivers }: Readonly<{ feed: ActivityFeed; delivers: boolean }>): ReactNode {
  const [state, receive] = useReducer(liveChatReducer, undefined, initialLiveChat);
  const { subscribe } = feed;
  useEffect(() => subscribe(receive), [subscribe]);
  const [hidden, setHidden] = useState<ReadonlySet<ActivityPlatform>>(new Set<ActivityPlatform>());
  // The newest row at the time of the pause: later rows wait. Null while the chat follows the newest message.
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const list = useRef<HTMLOListElement | null>(null);
  const rows: LiveChatRow[] = shownRows(state.rows, hidden).filter(
    (row: LiveChatRow): boolean => pausedAt === null || row.seq <= pausedAt,
  );
  const waiting: number = pausedAt === null ? 0 : newSince(state.rows, pausedAt, hidden);
  const last: number = rows.at(-1)?.seq ?? 0;
  useLayoutEffect(() => {
    const element: HTMLOListElement | null = list.current;
    if (element && pausedAt === null) element.scrollTop = element.scrollHeight;
  }, [last, pausedAt]);

  const pause = (current: LiveChatState): void => setPausedAt(current.seq);
  const scrolled = (event: UIEvent<HTMLOListElement>): void => {
    const element: HTMLOListElement = event.currentTarget;
    const below: number = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (pausedAt === null && below > PAUSE_DISTANCE) pause(state);
  };
  const toggle = (platform: ActivityPlatform): void =>
    setHidden((current: ReadonlySet<ActivityPlatform>): ReadonlySet<ActivityPlatform> => {
      const next = new Set<ActivityPlatform>(current);
      if (!next.delete(platform)) next.add(platform);
      return next;
    });
  const feedText: MessageId | null = FEED_TEXT[feed.status];
  return (
    <LivePart name="chat" title={t("tools.live.chat")}>
      <div className="seg tl-chat-filters" role="group" aria-label={t("tools.live.chat.filters")}>
        {PLATFORMS.map((platform: ActivityPlatform) => (
          <button
            key={platform}
            type="button"
            aria-pressed={!hidden.has(platform)}
            data-chat-filter={platform}
            onClick={() => toggle(platform)}
          >
            {PLATFORM_NAMES[platform]}
          </button>
        ))}
      </div>
      {!delivers && (
        <p className="muted tl-note" data-chat-no-channel>
          {t("tools.live.chat.noChannel")}{" "}
          <a className="text-link" href={toolsPath("channels")}>
            {t("tools.live.openChannels")}
          </a>
        </p>
      )}
      {feedText && (
        <p className="muted tl-note" data-chat-feed={feed.status}>
          {t(feedText)}
        </p>
      )}
      <ol
        className="tl-chat"
        ref={list}
        role="log"
        aria-label={t("tools.live.chat")}
        tabIndex={0}
        onScroll={scrolled}
        data-live-chat
        data-paused={pausedAt !== null || undefined}
      >
        {rows.map((row: LiveChatRow) => (
          <ChatRow key={row.id} row={row} />
        ))}
      </ol>
      {rows.length === 0 && (
        <p className="muted tl-note" data-chat-empty>
          {t("tools.live.chat.empty")}
        </p>
      )}
      <div className="tl-actions tl-chat-bar">
        {pausedAt === null ? (
          <>
            <span className="muted">{t("tools.live.chat.hint")}</span>
            <button type="button" className="small-button" data-chat-pause onClick={() => pause(state)}>
              {t("tools.live.chat.pause")}
            </button>
          </>
        ) : (
          <>
            <span data-chat-paused>{t("tools.live.chat.paused", { count: waiting })}</span>
            <button type="button" className="small-button" data-chat-jump onClick={() => setPausedAt(null)}>
              {t("tools.live.chat.jump")}
            </button>
          </>
        )}
      </div>
    </LivePart>
  );
}
