import type { ModerationReason, StreamerStatus } from "../types";
import { intlLocale, t, type MessageId } from "../i18n";

export const reasonLabels: Record<ModerationReason, MessageId> = {
  illegal: "moderation.reason.illegal",
  harassment: "moderation.reason.harassment",
  spam: "moderation.reason.spam",
  privacy: "moderation.reason.privacy",
  impersonation: "moderation.reason.impersonation",
  other: "moderation.reason.other",
};

// Translate known reasons; preserve legacy free text.
export function reasonText(reason: string): string {
  return reason in reasonLabels ? t(reasonLabels[reason as ModerationReason]) : reason;
}

// Owner notice: action, date, reason and effect when known. Empty for active pages.
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
