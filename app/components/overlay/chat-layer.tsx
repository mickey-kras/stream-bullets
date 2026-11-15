import { memo, useState, type CSSProperties, type ReactNode } from "react";
import { t, tAround } from "../../i18n";
import type { ActivityFragment } from "../../lib/activity";
import { CHAT_LIMITS, graphemes, safeEmoteUrl, type ChatRow } from "../../lib/chat-feed";
import { Emblem, PlatformGlyph } from "./wasteland/glyphs";
import { chipOffset, PLATFORM_NAMES, WASTELAND_STYLE } from "./wasteland/theme";

/** User names longer than this many characters end in an ellipsis. */
const MAX_NAME_CHARS = 20;
/** The removed-message collapse runs at the end of the hold, so it ends when the reducer drops the row. */
const COLLAPSE_MS = 240;

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

function rowClass(row: ChatRow): string {
  const entering: boolean = row.animate && (row.phase === "entering" || row.phase === "shown");
  return entering ? "wl-item wl-in" : "wl-item";
}

/**
 * One row. Memoised: the reducer keeps a row object until the row changes, so a page re-render (like the server
 * clock tick) does not re-render every row.
 */
const ChatRowItem = memo(function ChatRowItem({
  row,
  removedText,
  before,
  after,
}: Readonly<{ row: ChatRow; removedText: string } & NameFrame>): ReactNode {
  const removed: boolean = row.phase === "removed";
  const style = {
    "--wl-chip-offset": `${chipOffset(row.id)}px`,
    "--wl-hold": `${Math.max(0, CHAT_LIMITS.removedHoldMs - COLLAPSE_MS)}ms`,
  } as CSSProperties;
  return (
    <li className={rowClass(row)} data-phase={row.phase} data-platform={row.platform} style={style}>
      <div className="wl-clip">
        <div className="wl-row">
          <PlatformGlyph className="wl-badge" platform={row.platform} label={PLATFORM_NAMES[row.platform]} />
          <span className="wl-divider" aria-hidden="true" />
          <span className="wl-txt">
            {!removed &&
              row.badges.slice(0, CHAT_LIMITS.maxBadges).map((badge) => (
                <span className="wl-chip" key={badge.id}>
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
          <Emblem className="wl-emblem" />
        </div>
      </div>
    </li>
  );
});

/**
 * The merged chat in the wasteland theme: one capsule row per message, newest at the bottom, overflow clipped at
 * the top. Fills its parent, which sets the size in design pixels. Renders message text as text only.
 */
export function ChatLayer({ rows, className }: Readonly<{ rows: readonly ChatRow[]; className?: string }>): ReactNode {
  const removedText: string = t("overlay.chat.removed");
  const { before, after }: NameFrame = nameFrame();
  return (
    <ol
      className={className ? `wl-chat ${className}` : "wl-chat"}
      style={WASTELAND_STYLE}
      aria-label={t("overlay.chat.label")}
      data-overlay-chat=""
    >
      {rows.map((row: ChatRow) => (
        <ChatRowItem key={row.id} row={row} removedText={removedText} before={before} after={after} />
      ))}
    </ol>
  );
}
