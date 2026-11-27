import type { ReactNode } from "react";
import { intlLocale, t, tn } from "../../i18n";
import { rowKey, type LiveSupportRow } from "../../lib/live-chat";
import { PlatformIcon } from "../overlay/wasteland/glyphs";
import { PLATFORM_NAMES } from "../overlay/wasteland/theme";
import { Icon } from "../ui/icon";

/** A money amount is in micros of its currency (activity.ts). */
const MICROS = 1_000_000;

/** The money of a row in the format of the language, for example "$5.00". */
function money(row: LiveSupportRow): string {
  const units: number = (row.amount ?? 0) / MICROS;
  const options: Intl.NumberFormatOptions = row.currency ? { style: "currency", currency: row.currency } : {};
  return new Intl.NumberFormat(intlLocale(), options).format(units);
}

/**
 * What a support event is, in words, with its amount. The name of the supporter is not in the line: the row shows
 * it before the line. A first month has no count. YouTube gives memberships as gifts, not subscriptions.
 */
export function supportLine(row: LiveSupportRow): string {
  const amount: number = row.amount ?? 0;
  switch (row.event) {
    case "follow":
      return t("tools.live.support.follow");
    case "subscription":
      return amount > 1 ? tn("tools.live.support.subscribedMonths", amount) : t("tools.live.support.subscribed");
    case "membership":
      return amount > 1 ? tn("tools.live.support.memberMonths", amount) : t("tools.live.support.member");
    case "gift":
      return tn(row.platform === "youtube" ? "tools.live.support.giftMemberships" : "tools.live.support.gift", amount);
    case "raid":
      return tn("tools.live.support.raid", amount);
    case "bits":
      return tn("tools.live.support.bits", amount);
    case "kicks":
      return tn("tools.live.support.kicks", amount);
    case "reactions":
      return tn("tools.live.support.reactions", amount);
    case "super_chat":
      return t("tools.live.support.superChat", { amount: money(row) });
    case "super_sticker":
      return t("tools.live.support.superSticker", { amount: money(row) });
    case "tip":
      return t("tools.live.support.tip", { amount: money(row) });
    case "topic":
      return t("tools.live.support.topic");
  }
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
