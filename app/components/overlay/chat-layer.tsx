import { useState, type CSSProperties, type ReactNode } from "react";
import { t } from "../../i18n";
import { EMOTE_HOSTS, type ActivityFragment } from "../../lib/activity";
import { CHAT_LIMITS, type ChatRow } from "../../lib/chat-feed";
import { Emblem, PlatformGlyph } from "./wasteland/glyphs";
import { chipOffset, PLATFORM_NAMES, WASTELAND_STYLE } from "./wasteland/theme";

/** User names longer than this many characters end in an ellipsis. */
const MAX_NAME_CHARS = 20;
/** The removed-message collapse runs at the end of the hold, so it ends when the reducer drops the row. */
const COLLAPSE_MS = 240;

let segmenter: Intl.Segmenter | null = null;

/** Cuts a name to `max` user-perceived characters, never inside an emoji sequence or a combining mark. */
export function shortName(name: string, max: number = MAX_NAME_CHARS): string {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const chars: string[] = Array.from(segmenter.segment(name), (part: Intl.SegmentData): string => part.segment);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : name;
}

/** Emote images load only over HTTPS from EMOTE_HOSTS. Anything else shows the emote name as text. */
export function safeEmoteUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && EMOTE_HOSTS.includes(parsed.hostname) ? parsed.href : null;
  } catch {
    return null;
  }
}

/** An emote image; its name as text when the URL is not allowed or the image fails to load. */
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

function ChatRowItem({ row, removedText }: Readonly<{ row: ChatRow; removedText: string }>): ReactNode {
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
              <bdi>{shortName(row.name)}</bdi>:
            </span>{" "}
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
}

/**
 * The merged chat in the wasteland theme: one capsule row per message, newest at the bottom, overflow clipped at
 * the top. Fills its parent, which sets the size in design pixels. Renders message text as text only.
 */
export function ChatLayer({ rows, className }: Readonly<{ rows: readonly ChatRow[]; className?: string }>): ReactNode {
  const removedText: string = t("overlay.chat.removed");
  return (
    <ol
      className={className ? `wl-chat ${className}` : "wl-chat"}
      style={WASTELAND_STYLE}
      aria-label={t("overlay.chat.label")}
      data-overlay-chat=""
    >
      {rows.map((row: ChatRow) => (
        <ChatRowItem key={row.id} row={row} removedText={removedText} />
      ))}
    </ol>
  );
}
