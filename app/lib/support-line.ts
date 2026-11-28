import { intlLocale, t, tn } from "../i18n";
import type { SupportKind, SupportSource } from "./activity";

/** A money amount is in micros of its currency (activity.ts). */
const MICROS = 1_000_000;

/** What the line of a support event tells: the kind, where it comes from, and the amount. */
export interface SupportFacts {
  kind: SupportKind;
  platform: SupportSource;
  /** The amount in the native unit of the kind (activity.ts). */
  amount: number | null;
  currency: string | null;
}

/** The money of an event in the format of the language, for example "$5.00". */
function money(facts: SupportFacts): string {
  const units: number = (facts.amount ?? 0) / MICROS;
  const options: Intl.NumberFormatOptions = facts.currency ? { style: "currency", currency: facts.currency } : {};
  return new Intl.NumberFormat(intlLocale(), options).format(units);
}

/**
 * What a support event is, in words, with its amount. The name of the supporter is not in the text: the reader shows
 * the name before it. A first month has no count. YouTube gives memberships as gifts, not subscriptions. The rows of
 * Live and the dock, the alert banner and the mark in chat use this one text.
 */
export function supportText(facts: SupportFacts): string {
  const amount: number = facts.amount ?? 0;
  switch (facts.kind) {
    case "follow":
      return t("tools.live.support.follow");
    case "subscription":
      return amount > 1 ? tn("tools.live.support.subscribedMonths", amount) : t("tools.live.support.subscribed");
    case "membership":
      return amount > 1 ? tn("tools.live.support.memberMonths", amount) : t("tools.live.support.member");
    case "gift":
      return tn(
        facts.platform === "youtube" ? "tools.live.support.giftMemberships" : "tools.live.support.gift",
        amount,
      );
    case "raid":
      return tn("tools.live.support.raid", amount);
    case "bits":
      return tn("tools.live.support.bits", amount);
    case "kicks":
      return tn("tools.live.support.kicks", amount);
    case "reactions":
      return tn("tools.live.support.reactions", amount);
    case "super_chat":
      return t("tools.live.support.superChat", { amount: money(facts) });
    case "super_sticker":
      return t("tools.live.support.superSticker", { amount: money(facts) });
    case "tip":
      return t("tools.live.support.tip", { amount: money(facts) });
    case "topic":
      return t("tools.live.support.topic");
  }
}
