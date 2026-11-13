import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t, tAround } from "../../i18n";
import type { ActivityFragment } from "../../lib/activity";
import { CHAT_LIMITS, graphemes, safeEmoteUrl, type ChatRow } from "../../lib/chat-feed";
import { motionReduced } from "../station/motion";
import { useRowMotion } from "./use-row-motion";
import { PlatformIcon, VaultMark } from "./wasteland/glyphs";
import { PLATFORM_NAMES, WASTELAND_STYLE } from "./wasteland/theme";

/** User names longer than this many characters end in an ellipsis. */
const MAX_NAME_CHARS = 20;
/** A removed row fades out for this long after its hold, like a leaving row (the fade in wasteland.css). */
const FADE_MS: number = CHAT_LIMITS.leaveMs;

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

/** A row on screen. `gone` marks a removed row that the reducer dropped after its hold: it fades out. */
interface ShownRow {
  row: ChatRow;
  gone: boolean;
}

/**
 * The rows to render: the reducer's rows plus, for FADE_MS, the removed rows that it just dropped, in arrival order.
 * The reducer drops a removed row at the end of its hold (CHAT_LIMITS.removedHoldMs); the fade runs after that, and
 * then the column closes up. With reduced motion a dropped row goes at once.
 */
function useFadingRows(rows: readonly ChatRow[]): ShownRow[] {
  const [seen, setSeen] = useState<readonly ChatRow[]>(rows);
  const [gone, setGone] = useState<readonly ChatRow[]>([]);
  if (seen !== rows) {
    // Derived from the previous rows during render, so a dropped row keeps its element (no remount, no flash).
    const ids = new Set<string>(rows.map((row: ChatRow): string => row.id));
    const dropped: ChatRow[] = motionReduced()
      ? []
      : seen.filter((row: ChatRow): boolean => row.phase === "removed" && !ids.has(row.id));
    const kept: ChatRow[] = gone.filter((row: ChatRow): boolean => !ids.has(row.id));
    setSeen(rows);
    if (dropped.length > 0 || kept.length !== gone.length) setGone([...kept, ...dropped]);
  }
  useEffect(() => {
    if (gone.length === 0) return;
    const timer = setTimeout((): void => setGone([]), FADE_MS);
    return (): void => clearTimeout(timer);
  }, [gone]);
  return useMemo((): ShownRow[] => {
    const shown: ShownRow[] = rows.map((row: ChatRow): ShownRow => ({ row, gone: false }));
    if (gone.length === 0) return shown;
    return [...shown, ...gone.map((row: ChatRow): ShownRow => ({ row, gone: true }))].sort(
      (a: ShownRow, b: ShownRow): number => a.row.seq - b.row.seq,
    );
  }, [rows, gone]);
}

/**
 * One card. Memoised: the reducer keeps a row object until the row changes, so a page re-render (like the server
 * clock tick) does not re-render every card.
 */
const ChatRowItem = memo(function ChatRowItem({
  row,
  gone,
  removedText,
  before,
  after,
}: Readonly<{ row: ChatRow; gone: boolean; removedText: string } & NameFrame>): ReactNode {
  const removed: boolean = row.phase === "removed";
  return (
    <li
      className="wl-item"
      data-row-id={row.id}
      data-phase={row.phase}
      data-platform={row.platform}
      data-enter={row.animate || undefined}
      data-gone={gone || undefined}
    >
      <div className="wl-card">
        <span className="wl-line">
          <PlatformIcon className="wl-icon" platform={row.platform} label={PLATFORM_NAMES[row.platform]} />
          {!removed &&
            row.badges.slice(0, CHAT_LIMITS.maxBadges).map((badge) => (
              <span className="wl-badge" key={badge.id}>
                {badge.label}
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
  rows,
  className,
}: Readonly<{ rows: readonly ChatRow[]; className?: string }>): ReactNode {
  const removedText: string = t("overlay.chat.removed");
  const { before, after }: NameFrame = nameFrame();
  const shown: ShownRow[] = useFadingRows(rows);
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
      {shown.map(({ row, gone }: ShownRow) => (
        <ChatRowItem key={row.id} row={row} gone={gone} removedText={removedText} before={before} after={after} />
      ))}
    </ol>
  );
});
