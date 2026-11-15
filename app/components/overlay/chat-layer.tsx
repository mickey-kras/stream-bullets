import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t, tAround } from "../../i18n";
import type { ActivityFragment } from "../../lib/activity";
import { CHAT_LIMITS, graphemes, safeEmoteUrl, type ChatRow } from "../../lib/chat-feed";
import {
  goneWakeAt,
  nextGone,
  pruneGone,
  shownRows,
  type ChatView,
  type FadeLimits,
  type GoneRow,
  type ShownRow,
} from "../../lib/fading-rows";
import { motionReduced } from "../station/motion";
import { useRowMotion } from "./use-row-motion";
import { PlatformIcon, VaultMark } from "./wasteland/glyphs";
import { PLATFORM_NAMES, WASTELAND_STYLE } from "./wasteland/theme";

/** User names longer than this many characters end in an ellipsis. */
const MAX_NAME_CHARS = 20;
/** A removed row fades out for leaveMs after the reducer drops it, like a leaving row; at most maxLeaving fade at once. */
const FADE_LIMITS: FadeLimits = {
  leaveMs: CHAT_LIMITS.leaveMs,
  maxLeaving: CHAT_LIMITS.maxLeaving,
  removedHoldMs: CHAT_LIMITS.removedHoldMs,
};

/** Cuts a name to `max` user-perceived characters, never inside an emoji sequence or a combining mark. */
export function shortName(name: string, max: number = MAX_NAME_CHARS): string {
  const chars: string[] = graphemes(name);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : name;
}

/**
 * The text before and after the user name, with the separator to the message: "{name}: " in English, "{name} : " in
 * French, "{name}：" in Japanese (a full-width colon, no space). A trailing space inside the name element still
 * separates it from the message, because the next text does not start with a space.
 */
interface NameFrame {
  before: string;
  after: string;
}

function nameFrame(): NameFrame {
  const [before, after] = tAround("overlay.chat.name", "name");
  return { before, after };
}

/** An emote image; its name as text when the URL is not allowed (see safeEmoteUrl) or the image fails to load. */
function Emote({ name, url }: Readonly<{ name: string; url: string }>): ReactNode {
  const [failed, setFailed] = useState<boolean>(false);
  const src: string | null = safeEmoteUrl(url);
  if (!src || failed) return name;
  return (
    <img
      className="wl-emote"
      src={src}
      alt={name}
      title={name}
      referrerPolicy="no-referrer"
      decoding="async"
      draggable={false}
      onError={(): void => setFailed(true)}
    />
  );
}

function Fragment({ fragment }: Readonly<{ fragment: ActivityFragment }>): ReactNode {
  if (fragment.type === "text") return fragment.text;
  return <Emote name={fragment.name} url={fragment.url} />;
}

/**
 * The rows to render: the reducer's rows plus the removed rows that it just dropped, each for leaveMs while its card
 * fades (see fading-rows.ts), in arrival order. The reducer drops a removed row at the end of its hold
 * (CHAT_LIMITS.removedHoldMs); the fade starts at the time of that drop (`ChatView.at`), so the full fade plays, and
 * then the column closes up. A row that a snapshot drops before its hold ends, the rows of a reset, and with reduced
 * motion every dropped row, go at once.
 */
function useFadingRows(chat: ChatView): ShownRow[] {
  const [seen, setSeen] = useState<ChatView>(chat);
  const [gone, setGone] = useState<readonly GoneRow[]>([]);
  if (seen !== chat) {
    // Derived from the previous state during render, so a dropped row keeps its element (no remount, no flash).
    const next: readonly GoneRow[] = motionReduced() ? [] : nextGone(gone, seen, chat, FADE_LIMITS);
    setSeen(chat);
    if (next !== gone && (next.length > 0 || gone.length > 0)) setGone(next);
  }
  useEffect(() => {
    // One timer, for the fade that ends first.
    const wake: number | null = goneWakeAt(gone, FADE_LIMITS);
    if (wake === null) return;
    const timer = setTimeout(
      (): void => setGone((current) => pruneGone(current, Math.max(Date.now(), wake), FADE_LIMITS)),
      Math.max(0, wake - Date.now()),
    );
    return (): void => clearTimeout(timer);
  }, [gone]);
  const rows: readonly ChatRow[] = chat.rows;
  return useMemo((): ShownRow[] => shownRows(rows, gone), [rows, gone]);
}

/**
 * One card. Memoised: the reducer keeps a row object until the row changes, so a page re-render (like the server
 * clock tick) does not re-render every card.
 */
const ChatRowItem = memo(function ChatRowItem({
  row,
  gone,
  newest,
  removedText,
  before,
  after,
}: Readonly<{ row: ChatRow; gone: boolean; newest: boolean; removedText: string } & NameFrame>): ReactNode {
  const removed: boolean = row.phase === "removed";
  return (
    <li
      className="wl-item"
      data-row-id={row.id}
      data-phase={row.phase}
      data-platform={row.platform}
      data-enter={row.animate || undefined}
      data-gone={gone || undefined}
      data-newest={newest || undefined}
    >
      <div className="wl-card">
        <span className="wl-line">
          <PlatformIcon className="wl-icon" platform={row.platform} label={PLATFORM_NAMES[row.platform]} />
          {!removed &&
            row.badges.slice(0, CHAT_LIMITS.maxBadges).map((badge) => (
              // Like PlatformIcon: the label for screen readers ends in a space, so it never runs into the name.
              <span className="wl-badge" key={badge.id}>
                <span aria-hidden="true">{badge.label}</span>
                <span className="sr-only">{`${badge.label} `}</span>
              </span>
            ))}
          <span className="wl-user">
            {before}
            <bdi>{shortName(row.name)}</bdi>
            {after}
          </span>
          <span className="wl-msg" dir="auto">
            {removed ? (
              removedText
            ) : (
              <>
                {row.fragments.map((fragment: ActivityFragment, index: number) => (
                  // Fragments never reorder within a row.
                  <Fragment key={index} fragment={fragment} />
                ))}
                {row.truncated && "…"}
              </>
            )}
          </span>
        </span>
        <VaultMark className="wl-vault" />
      </div>
    </li>
  );
});

/**
 * The merged chat in the wasteland theme: one compact card per message, newest at the bottom, overflow faded and
 * clipped at the top. Fills its parent, which sets the size in design pixels. Renders message text as text only.
 */
export const ChatLayer = memo(function ChatLayer({
  chat,
  className,
}: Readonly<{ chat: ChatView; className?: string }>): ReactNode {
  const removedText: string = t("overlay.chat.removed");
  const { before, after }: NameFrame = nameFrame();
  const shown: ShownRow[] = useFadingRows(chat);
  const list = useRef<HTMLOListElement>(null);
  useRowMotion(list, shown);
  return (
    <ol
      ref={list}
      className={className ? `wl-chat ${className}` : "wl-chat"}
      style={WASTELAND_STYLE}
      aria-label={t("overlay.chat.label")}
      data-overlay-chat=""
    >
      {shown.map(({ row, gone, newest }: ShownRow) => (
        <ChatRowItem
          key={row.id}
          row={row}
          gone={gone}
          newest={newest}
          removedText={removedText}
          before={before}
          after={after}
        />
      ))}
    </ol>
  );
});
