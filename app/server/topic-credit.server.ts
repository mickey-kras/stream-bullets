import { waitUntil } from "cloudflare:workers";
import type { AppEnv } from "../env";
import type { AlertSubject } from "../lib/alerts";
import { onAnyOutput } from "../lib/overlay-layers";
import { topicSupport, type AlertCredit } from "../lib/topic-credit";
import { activityAvailable } from "./channel-tokens.server";
import { callIngest } from "./ingest-call.server";
import type { OverlayUpdate } from "./overlay.server";

/**
 * The credit of a featured topic (issue #1043, app/lib/topic-credit.ts). The API reads the topic, its author, and the
 * Twitch account that the author signed in with, and sends the credit to the ingest object of the page. Better Auth
 * stores the `sub` claim of the Twitch ID token as `account.account_id`: that is the Twitch user ID, the ID of the
 * author in Twitch chat. The account is used for the reaction of the character only. No log, no stored row, and no
 * message to a page has it.
 */

interface CreditRow {
  title: string;
  author_id: string;
  author: string;
  /** The Twitch user ID of the author, or null when the author has no Twitch sign-in. */
  twitch: string | null;
}

/**
 * The topic of the page with its author. A person can link more than one Twitch account: the oldest link is the one
 * that the credit uses. Null when the page has no such topic.
 */
async function topicFacts(env: AppEnv, streamerId: string, entryId: string): Promise<CreditRow | null> {
  return env.DB.prepare(
    `SELECT e.title, e.author_id, u.name AS author,
        (SELECT a.account_id FROM account a WHERE a.user_id=e.author_id AND a.provider_id='twitch'
          ORDER BY a.created_at, a.id LIMIT 1) AS twitch
      FROM entries e JOIN user u ON u.id=e.author_id WHERE e.id=? AND e.streamer_id=? AND e.kind='topic'`,
  )
    .bind(entryId, streamerId)
    .first<CreditRow>();
}

/** The participant of the author in Twitch chat, or null: the alert then gets the crowd effect. */
function subjectOf(row: CreditRow | null): AlertSubject | null {
  return row?.twitch ? { platform: "twitch", userId: row.twitch } : null;
}

function sendCredit(env: AppEnv, streamerId: string, credit: AlertCredit): Promise<Response> {
  return callIngest(env, streamerId, "alert-credit", {
    init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credit) },
  });
}

/**
 * Makes the credit of one feature: the support event of the kind `topic` for the author, with the revision of the
 * overlay that put the topic on stream. A failure is logged with its class only: never the topic, the author, or the
 * account. The feature itself stays.
 */
export async function creditTopic(env: AppEnv, streamerId: string, entryId: string, revision: number): Promise<void> {
  try {
    const row: CreditRow | null = await topicFacts(env, streamerId, entryId);
    // The owner deleted the topic after the feature: it has no author to credit.
    if (row === null) {
      console.warn("topic_credit_skipped", { reason: "topic_gone" });
      return;
    }
    const author = { id: row.author_id, name: row.author };
    const event = topicSupport(entryId, revision, row.title, author, Date.now());
    const response: Response = await sendCredit(env, streamerId, { op: "credit", event, subject: subjectOf(row) });
    if (!response.ok) console.error("topic_credit_failed", { status: response.status });
  } catch (error: unknown) {
    const cause: string = error instanceof TypeError ? "transport_error" : "unexpected_error";
    console.error("topic_credit_failed", { cause });
  }
}

/**
 * After a change of the overlay: credits the author of the topic that the change featured, while the alerts layer is
 * on stream in an output. It runs after the answer, as the notices of the live room do.
 */
export function notifyTopicCredit(
  env: AppEnv,
  streamerId: string,
  update: Pick<OverlayUpdate, "overlay" | "featured">,
): void {
  const { featured, overlay } = update;
  if (featured === null || !onAnyOutput(overlay.layers, "alerts") || !activityAvailable(env)) return;
  waitUntil(creditTopic(env, streamerId, featured, overlay.revision));
}

/**
 * A replay of the topic credit `id`. The API reads the account of the author again, so a replay never uses a link
 * that the author removed. The object keeps no link.
 */
export async function replayTopicCredit(
  env: AppEnv,
  streamerId: string,
  id: string,
  entryId: string,
): Promise<Response> {
  const row: CreditRow | null = await topicFacts(env, streamerId, entryId);
  return sendCredit(env, streamerId, { op: "replay", id, subject: subjectOf(row) });
}
