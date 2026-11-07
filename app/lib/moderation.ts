import type { ModerationReason } from "../admin-types";
import { t, type MessageId } from "../i18n";
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

/** The owner's notice for a moderated page (R13): what happened and, when known, why. Empty for an active page. */
export function ownerNotice(status: StreamerStatus, reason: string | null): string {
  if (status === "active") return "";
  const text: string = t(status === "frozen" ? "moderation.frozenOwner" : "moderation.suspendedOwner");
  return reason ? `${text} ${t("moderation.reasonLine", { reason: reasonText(reason) })}` : text;
}
