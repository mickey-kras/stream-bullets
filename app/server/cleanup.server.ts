import type { AppEnv } from "../env";
import { pruneAiInterest } from "./ai.server";

/** Resolved reports are deleted after 365 days. */
export const REPORT_RETENTION_MS = 365 * 86_400_000;

export async function cleanExpiredData(env: AppEnv, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM session WHERE id IN (SELECT id FROM session WHERE expires_at <= ? LIMIT 5000)").bind(
      now,
    ),
    env.DB.prepare(
      "DELETE FROM verification WHERE id IN (SELECT id FROM verification WHERE expires_at <= ? LIMIT 5000)",
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM rate_limit WHERE id IN (SELECT id FROM rate_limit WHERE last_request < ? LIMIT 5000)",
    ).bind(now - 86_400_000),
    env.DB.prepare(
      "DELETE FROM app_rate_limits WHERE key IN (SELECT key FROM app_rate_limits WHERE window_start < ? LIMIT 5000)",
    ).bind(now - 86_400_000),
    // Resolved reports are kept for one year as a moderation record, then removed.
    env.DB.prepare(
      "DELETE FROM content_reports WHERE id IN (SELECT id FROM content_reports WHERE status <> 'open' AND resolved_at < ? LIMIT 5000)",
    ).bind(now - REPORT_RETENTION_MS),
    // AI interest votes count for 30 days.
    pruneAiInterest(env, now),
  ]);
}
