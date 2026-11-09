import type { ModerationReason } from "../admin-types";
import { intlLocale, t, type MessageId } from "../i18n";
import type { StreamerStatus } from "../types";

export const reasonLabels: Record<ModerationReason, MessageId> = {
  illegal: "moderation.reason.illegal",
  harassment: "moderation.reason.harassment",
  spam: "moderation.reason.spam",
  privacy: "moderation.reason.privacy",
  impersonation: "moderation.reason.impersonation",
  other: "moderation.reason.other",
};

/** A stored reason in words. Older rows may hold free text, which shows as written. */
export function reasonText(reason: string): string {
  return reason in reasonLabels ? t(reasonLabels[reason as ModerationReason]) : reason;
}

/**
 * The owner's notice for a moderated page (R13): what happened, when and why, as far as known. Empty for an active
 * page. With a date it reads like the mockup: "Your page was frozen on {date}. Reason: {reason}. {effect}"
 */
export function ownerNotice(status: StreamerStatus, reason: string | null, changedAt: number | null = null): string {
  if (status === "active") return "";
  const frozen: boolean = status === "frozen";
  const why: string = reason ? t("moderation.reasonLine", { reason: reasonText(reason) }) : "";
  if (changedAt === null) {
    const text: string = t(frozen ? "moderation.frozenOwner" : "moderation.suspendedOwner");
    return why ? `${text} ${why}` : text;
  }
  const date: string = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium" }).format(changedAt);
  const parts: string[] = [t(frozen ? "moderation.frozenOn" : "moderation.suspendedOn", { date })];
  if (why) parts.push(why);
  parts.push(t(frozen ? "moderation.frozenEffect" : "moderation.suspendedEffect"));
  return parts.join(" ");
}
