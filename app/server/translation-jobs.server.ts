import { waitUntil } from "cloudflare:workers";
import { LOCALES } from "../../db/enums";
import type { AppEnv } from "../env";
import type { Locale } from "../i18n";
import { translateEntry } from "./entry-translation.server";
import { translatePendingPages } from "./page-translation.server";
import { translateComment } from "./translation.server";

// The cron trigger of the translation run. See wrangler.jsonc.
export const TRANSLATION_CRON = "*/10 * * * *";
// The items of each kind that one run translates. One item starts the model for each site language, and each
// start has 5 or 6 database statements. D1 permits 1000 statements in one run of the Worker.
export const TRANSLATION_BATCH = 4;

async function ids(env: AppEnv, sql: string, limit: number): Promise<string[]> {
  const { results } = await env.DB.prepare(sql).bind(LOCALES.length, limit).all<{ id: string }>();
  return results.map((row: { id: string }): string => row.id);
}

/**
 * Translates the newest comments and entries that do not have a stored result for each site language, and the
 * text of pages. This is
 * the translation of new content, the first translation of content from before this feature, and the new
 * attempt after a failure. Gives the number of items that it examined. Throws when each start failed.
 */
export async function translatePending(env: AppEnv, now: number, limit: number = TRANSLATION_BATCH): Promise<number> {
  if (!env.AI) return 0;
  const [comments, entries] = await Promise.all([
    ids(
      env,
      `SELECT c.id FROM entry_comments c WHERE c.removed_at IS NULL
        AND (SELECT COUNT(*) FROM comment_translations t WHERE t.comment_id=c.id) < ?
        ORDER BY COALESCE(c.edited_at, c.created_at) DESC LIMIT ?`,
      limit,
    ),
    ids(
      env,
      `SELECT e.id FROM entries e
        WHERE (SELECT COUNT(*) FROM entry_translations t WHERE t.entry_id=e.id) < ?
        ORDER BY e.created_at DESC LIMIT ?`,
      limit,
    ),
  ]);
  // A stored result starts no model. A failure of one language does not stop the other languages.
  const work: Promise<unknown>[] = LOCALES.flatMap((locale: Locale): Promise<unknown>[] => [
    ...comments.map((id: string): Promise<unknown> => translateComment(env, id, null, locale, now)),
    ...entries.map((id: string): Promise<unknown> => translateEntry(env, id, null, locale, now)),
  ]);
  const results = await Promise.allSettled(work);
  // The About text, the cards and the streams of pages. This work has its own batch.
  const pages = await translatePendingPages(env, now);
  const starts: number = work.length + pages.starts;
  const failed: number = results.filter((result): boolean => result.status === "rejected").length + pages.failed;
  if (starts > 0 && failed === starts) throw new Error(`All ${failed} translation starts failed.`);
  return comments.length + entries.length;
}

/** Translates one comment or entry to each site language. A failure of one language does not stop the others. */
export async function translateItem(env: AppEnv, kind: "comment" | "entry", id: string, now: number): Promise<void> {
  if (!env.AI) return;
  await Promise.allSettled(
    LOCALES.map(
      (locale: Locale): Promise<unknown> =>
        kind === "comment" ? translateComment(env, id, null, locale, now) : translateEntry(env, id, null, locale, now),
    ),
  );
}

/**
 * Starts the translation of the content that a person posted or edited, after the response. A failure leaves
 * the content for the next run of the cron trigger.
 */
export function translateAfterPost(env: AppEnv, kind: "comment" | "entry", id: string): void {
  if (env.AI) waitUntil(translateItem(env, kind, id, Date.now()));
}
