import type { AppEnv } from "../env";
import type { ActivityPlatform } from "../lib/activity";
import { WATCHDOG_MIN_REFUSALS, WATCHDOG_QUIET_MS } from "./channel-ingest-limits";
import {
  ProviderError,
  ReauthRequired,
  listSubscriptions,
  requiredSubscriptions,
  subscribe,
  unsubscribe,
  type ProviderSubscription,
} from "./channel-providers.server";
import { getOrigin, logError } from "./http.server";

/** Repair of provider subscriptions without the owner, and the webhook health that the watchdog reads. */

/** What a subscription check found and did. It never throws: a failed provider call is a `failure`. */
export interface Reconciled {
  /** The subscription ids the provider holds now, or null when its list could not be read. */
  ids: string[] | null;
  /** A subscription was deleted or created. */
  changed: boolean;
  /** `reauth`: the provider refused the authorization. `provider`: another provider call failed. */
  failure: "reauth" | "provider" | null;
}

function delivering(item: ProviderSubscription): boolean {
  return item.health !== "unhealthy";
}

/** Creates the missing types. Returns the ids a Twitch 409 pointed to: the list must show them as delivering. */
async function createMissing(
  env: AppEnv,
  platform: ActivityPlatform,
  externalId: string,
  accessToken: string | null,
  missing: readonly string[],
  created: string[],
): Promise<string[]> {
  const origin = getOrigin(env);
  const { conflicts } = await subscribe(env, platform, externalId, accessToken, origin, created, missing);
  if (conflicts.length === 0) return [];
  const listed = (await listSubscriptions(env, platform, externalId, accessToken, origin)) ?? [];
  const adopted = listed.filter((item) => conflicts.includes(item.type) && delivering(item));
  if (conflicts.some((type) => !adopted.some((item) => item.type === type))) throw new ProviderError(409);
  return adopted.map((item) => item.id);
}

/** Deletes the subscriptions the provider reports as ended and creates the missing types. Healthy ones stay. */
export async function reconcileSubscriptions(
  env: AppEnv,
  platform: ActivityPlatform,
  externalId: string,
  accessToken: string | null,
): Promise<Reconciled> {
  const listed = await listSubscriptions(env, platform, externalId, accessToken, getOrigin(env));
  if (listed === null) return { ids: null, changed: false, failure: "provider" };
  const ended = listed.filter((item) => !delivering(item)).map((item) => item.id);
  const left = await unsubscribe(env, platform, ended, accessToken);
  const kept = listed.filter(delivering);
  const missing = requiredSubscriptions(platform).filter((type) => !kept.some((item) => item.type === type));
  const created: string[] = [];
  let adopted: string[] = [];
  let failure: Reconciled["failure"] = null;
  try {
    if (missing.length > 0) adopted = await createMissing(env, platform, externalId, accessToken, missing, created);
  } catch (error: unknown) {
    failure = error instanceof ReauthRequired ? "reauth" : "provider";
  }
  return {
    ids: [...new Set([...kept.map((item) => item.id), ...left, ...created, ...adopted])],
    changed: left.length < ended.length || created.length > 0,
    failure,
  };
}

const HEALTH_SAMPLE_MS = 60_000;
const MAX_SAMPLED_KEYS = 1_000;
const sampledAt = new Map<string, number>();

/** For tests: forget when each health row was last written. */
export function resetWebhookHealth(): void {
  sampledAt.clear();
}

function rejectedKey(platform: ActivityPlatform, channelId: string | null): string {
  return channelId === null ? `webhook-rejected:${platform}` : `webhook-rejected:${platform}:${channelId}`;
}

/** Writes a health row at most once a minute for each key and isolate. The count restarts after a quiet gap. */
async function mark(env: AppEnv, key: string, now: number): Promise<void> {
  if (now - (sampledAt.get(key) ?? -Infinity) < HEALTH_SAMPLE_MS) return;
  if (sampledAt.size >= MAX_SAMPLED_KEYS) sampledAt.clear();
  sampledAt.set(key, now);
  try {
    await env.DB.prepare(
      `INSERT INTO app_rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
        ON CONFLICT(key) DO UPDATE SET
          count = CASE WHEN ?2 - app_rate_limits.window_start > ?3 THEN 1 ELSE app_rate_limits.count + 1 END,
          window_start = ?2`,
    )
      .bind(key, now, WATCHDOG_QUIET_MS)
      .run();
  } catch (error: unknown) {
    logError("channel_webhook_health_failed", error);
  }
}

/** Counts a refused webhook: for the channel when a valid signature named it, else for the whole platform. */
export function markWebhookRejected(
  env: AppEnv,
  platform: ActivityPlatform,
  channelId: string | null,
  now: number,
): Promise<void> {
  return mark(env, rejectedKey(platform, channelId), now);
}

/** Records that the platform's webhook accepted a signed delivery for a connected channel. */
export function markWebhookAccepted(env: AppEnv, platform: ActivityPlatform, now: number): Promise<void> {
  return mark(env, `webhook-accepted:${platform}`, now);
}

/** True when signed deliveries for the channel were refused, or the platform refused some and accepted none. */
export async function webhooksOnlyRefused(
  env: AppEnv,
  platform: ActivityPlatform,
  externalId: string,
  now: number,
): Promise<boolean> {
  const keys = [rejectedKey(platform, externalId), rejectedKey(platform, null), `webhook-accepted:${platform}`];
  const { results } = await env.DB.prepare(
    "SELECT key, count FROM app_rate_limits WHERE key IN (?1, ?2, ?3) AND window_start >= ?4",
  )
    .bind(...keys, now - WATCHDOG_QUIET_MS)
    .all<{ key: string; count: number }>();
  const recent = (key: string, least: number): boolean => results.some((row) => row.key === key && row.count >= least);
  // Only a valid signature names a channel, so no forged delivery reaches the first check.
  if (recent(keys[0], WATCHDOG_MIN_REFUSALS)) return true;
  return recent(keys[1], WATCHDOG_MIN_REFUSALS) && !recent(keys[2], 1);
}
