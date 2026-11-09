import type { PageAction, StreamerStatus } from "../types";
import type { AppEnv } from "../env";
import { DEFAULT_LOCALE, isLocale, t, type MessageId } from "../i18n";
import { withLocale } from "../i18n/server";
import { contactEmails } from "../legal";
import { ownerNotice } from "../lib/moderation";
import { isPlaceholderEmail } from "./validation";

/**
 * The optional owner email for page moderation (R13). The owner always sees the in-app notice (the page banner,
 * the account menu and Edit your page). Email goes out only when the admin ticks "Notify the owner" and both the
 * `NOTIFY_EMAIL` send_email binding and the `NOTIFY_FROM` sender address are configured. A failed send never
 * undoes the moderation action.
 */

export interface NotifyMessage {
  to: string;
  subject: string;
  text: string;
}

const subjects: Record<PageAction, MessageId> = {
  freeze: "notify.subjectFrozen",
  unfreeze: "notify.subjectActive",
  suspend: "notify.subjectSuspended",
  unsuspend: "notify.subjectActive",
};

interface OwnerRow {
  handle: string;
  status: StreamerStatus;
  status_reason: string | null;
  email: string;
  locale: string | null;
}

/** The email for the page's owner in their language, or null when there is no real address to write to. */
export async function ownerEmail(env: AppEnv, streamerId: string, action: PageAction): Promise<NotifyMessage | null> {
  const row = await env.DB.prepare(`
    SELECT s.handle, s.status, s.status_reason, u.email, u.locale
    FROM streamers s JOIN user u ON u.id = s.owner_id WHERE s.id=?
  `)
    .bind(streamerId)
    .first<OwnerRow>();
  if (!row?.email || isPlaceholderEmail(row.email)) return null;
  const locale = isLocale(row.locale) ? row.locale : DEFAULT_LOCALE;
  return withLocale(locale, async () => {
    const pageUrl = `${env.APP_ORIGIN}/@${row.handle}`;
    const lines: string[] = [
      row.status === "active" ? t("notify.activeBody") : ownerNotice(row.status, row.status_reason),
      t("notify.pageLine", { url: pageUrl }),
      t("notify.contactLine", { email: contactEmails.support }),
    ];
    return { to: row.email, subject: t(subjects[action], { handle: row.handle }), text: lines.join("\n\n") };
  });
}

/** Emails the owner about a moderation action. Returns whether an email went out. */
export async function notifyOwner(env: AppEnv, streamerId: string, action: PageAction): Promise<boolean> {
  if (!env.NOTIFY_EMAIL || !env.NOTIFY_FROM?.trim()) return false;
  try {
    const message = await ownerEmail(env, streamerId, action);
    if (!message) return false;
    await env.NOTIFY_EMAIL.send({ from: env.NOTIFY_FROM.trim(), ...message });
    return true;
  } catch (error_: unknown) {
    // No addresses or message text in logs.
    console.error("owner_notify_failed", { action, cause: error_ instanceof Error ? error_.name : "unknown" });
    return false;
  }
}
