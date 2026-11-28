import type { ReactNode } from "react";
import { t } from "../../i18n";
import { rowKey, type LiveSupportRow } from "../../lib/live-chat";
import { supportText } from "../../lib/support-line";
import { PlatformIcon } from "../overlay/wasteland/glyphs";
import { PLATFORM_NAMES } from "../overlay/wasteland/theme";
import { Icon } from "../ui/icon";

/**
 * What the support event of a row is, in words, with its amount (`supportText`). The name of the supporter is not in
 * the line: the row shows it before the line.
 */
export function supportLine(row: LiveSupportRow): string {
  return supportText({ kind: row.event, platform: row.platform, amount: row.amount, currency: row.currency });
}

/**
 * A support event in the chat log of the Live section: the platform, the supporter, what the event is, and the
 * text of the supporter. The text is untrusted: it renders as text only.
 */
export function SupportRow({ row }: Readonly<{ row: LiveSupportRow }>): ReactNode {
  return (
    <li
      className="tl-chat-row tl-support"
      data-chat-row={rowKey(row)}
      data-support={row.event}
      data-platform={row.platform}
    >
      {row.platform === "direct" ? (
        <Icon name="heart" size={16} className="tl-chat-icon" />
      ) : (
        <PlatformIcon className="tl-chat-icon" platform={row.platform} label={PLATFORM_NAMES[row.platform]} />
      )}
      <strong className="tl-chat-name">
        <bdi>{row.name ?? t("tools.live.support.anonymous")}</bdi>
      </strong>{" "}
      <span className="tl-support-line">{supportLine(row)}</span>
      {row.text !== null && (
        <>
          {" "}
          <span className="tl-chat-text" dir="auto">
            {row.text}
          </span>
        </>
      )}
    </li>
  );
}
