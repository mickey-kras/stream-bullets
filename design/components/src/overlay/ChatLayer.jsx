import { useMemo, useRef, useState } from "react";
// Pure modules of the app: the platform glyphs and the FLIP row motion of the chat (issue #663).
import { PlatformIcon } from "../../../../app/components/overlay/wasteland/glyphs.tsx";
import { useRowMotion } from "../../../../app/components/overlay/use-row-motion.ts";

// WASTELAND_COLORS and WASTELAND_STYLE of app/components/overlay/wasteland/theme.ts. The fade is CHAT_LIMITS.leaveMs.
const WASTELAND_STYLE = {
  "--wl-card": "rgba(8, 43, 46, 0.9)",
  "--wl-border": "#b89649",
  "--wl-accent": "#e5bd54",
  "--wl-text": "#f4ebce",
  "--wl-muted": "#c4c2a8",
  "--wl-glow": "#e5bd5414",
  "--wl-inner": "#e5bd5429",
  "--wl-inset": "#081f2480",
  "--wl-scan": "#0000000c",
  "--wl-shadow": "#00000030",
  "--wl-outline": "#041517e6",
  "--wl-leave": "300ms",
};
const PLATFORM_NAMES = { youtube: "YouTube", twitch: "Twitch", kick: "Kick" };
/** User names longer than this many characters end in an ellipsis. */
const MAX_NAME_CHARS = 20;
/** Below this background opacity (percent) the text gets a dark outline. */
const OUTLINE_BELOW = 50;
const MAX_BADGES = 2;

/** Cuts a name to `max` user-perceived characters, never inside an emoji sequence. */
export function shortName(name, max = MAX_NAME_CHARS) {
  const chars =
    typeof Intl.Segmenter === "function"
      ? Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(name), (part) => part.segment)
      : Array.from(name);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : name;
}

/** An emote image; its name as text when the URL is not https or the image fails to load. */
function Emote({ name, url }) {
  const [failed, setFailed] = useState(false);
  if (!url?.startsWith("https://") || failed) return name;
  return (
    <img
      className="wl-emote"
      src={url}
      alt={name}
      title={name}
      referrerPolicy="no-referrer"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function phaseOf(row) {
  if (row.removed) return "removed";
  if (row.leaving) return "leaving";
  return row.enter ? "entering" : "shown";
}

/**
 * The merged chat in the wasteland theme (app/components/overlay/chat-layer.tsx): one compact card per message,
 * newest at the bottom, overflow faded and clipped at the top. Fills its positioned parent. With `test` the TEST tag
 * of a chat test shows in the top-right corner of the parent, as the app's chat slot renders it.
 */
export function ChatLayer({
  rows,
  backgroundOpacity = 100,
  test = false,
  label = "Chat",
  removedText = "message removed by a moderator",
  testLabel = "TEST",
  className,
  style,
}) {
  const list = useRef(null);
  useRowMotion(list, rows);
  const themed = useMemo(
    () => ({ ...WASTELAND_STYLE, "--wl-bg": String(backgroundOpacity / 100), ...style }),
    [backgroundOpacity, style],
  );
  // The newest active row (never a removed, leaving or fading row) gets the accent card.
  let newest = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row.removed && !row.leaving && !row.gone) {
      newest = index;
      break;
    }
  }
  return (
    <>
      <ol
        ref={list}
        className={className ? `wl-chat ${className}` : "wl-chat"}
        style={themed}
        aria-label={label}
        data-overlay-chat=""
        data-outline={backgroundOpacity < OUTLINE_BELOW || undefined}
      >
        {rows.map((row, index) => {
          const id = row.id ?? String(index);
          const removed = Boolean(row.removed);
          const fragments = row.fragments ?? [{ type: "text", text: row.text ?? "" }];
          return (
            <li
              key={id}
              className="wl-item"
              data-row-id={id}
              data-phase={phaseOf(row)}
              data-platform={row.platform}
              data-enter={row.enter || undefined}
              data-gone={row.gone || undefined}
              data-newest={index === newest || undefined}
            >
              <div className="wl-card">
                <span className="wl-line">
                  <PlatformIcon className="wl-icon" platform={row.platform} label={PLATFORM_NAMES[row.platform]} />
                  {!removed &&
                    (row.badges ?? []).slice(0, MAX_BADGES).map((badge) => (
                      <span className="wl-badge" key={badge}>
                        <span aria-hidden="true">{badge}</span>
                        <span className="sr-only">{`${badge} `}</span>
                      </span>
                    ))}
                  <span className="wl-user">
                    <bdi>{shortName(row.name)}</bdi>
                    {": "}
                  </span>
                  <span className="wl-msg" dir="auto">
                    {removed ? (
                      removedText
                    ) : (
                      <>
                        {fragments.map((fragment, at) =>
                          fragment.type === "emote" ? (
                            <Emote key={`${at}:${fragment.name}`} name={fragment.name} url={fragment.url} />
                          ) : (
                            fragment.text
                          ),
                        )}
                        {row.truncated && "…"}
                      </>
                    )}
                  </span>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      {test && (
        <span className="wl-test" data-chat-test="">
          {testLabel}
        </span>
      )}
    </>
  );
}
