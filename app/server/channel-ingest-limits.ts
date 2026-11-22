/** Limits of the ChannelIngest object: retention, admission rates, polling and quotas. */

import { quotaDay } from "../lib/activity";

/** Chat messages kept for the reconnect snapshot, and for how long. */
export const SNAPSHOT_SIZE = 100;
export const SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
/** Admission: a token bucket per page for chat. Messages past it are dropped and counted, never queued. */
export const ADMISSION_RATE = 50;
export const ADMISSION_BURST = 200;
/**
 * Moderation events (delete, ban, clear) have their own bucket, so a chat flood never holds them back and a
 * replayed moderation delivery cannot take over the object either.
 */
export const MODERATION_RATE = 20;
export const MODERATION_BURST = 200;
/**
 * Delivery and message ids, and the ids of deleted messages, are remembered this long. It is longer than the
 * webhook freshness window (MAX_WEBHOOK_AGE_MS, 10 minutes), so a retry inside that window is always recognized.
 */
export const SEEN_TTL_MS = 15 * 60_000;
/**
 * At most this many ids of each table. A delivery id is stored only for a delivery with at least one admitted
 * event, a message id only for admitted chat, and a ban key only for an admitted ban. In 10 minutes the object
 * admits at most C = 50 × 600 + 200 chat messages and M = 20 × 600 + 200 moderation events, so the ids of that
 * window fit in 2C + 2M. The count limit removes the oldest ids only beyond that.
 */
export const SEEN_MAX = 2 * (ADMISSION_RATE * 600 + ADMISSION_BURST) + 2 * (MODERATION_RATE * 600 + MODERATION_BURST);
/** How often a connection read that cache clears keep overtaking is tried before the object answers none. */
export const CONNECTION_READS = 3;
/** A connection read from D1 is used for this long, so a burst of deliveries does not read D1 each time. */
export const CONNECTION_CACHE_MS = 30_000;
/** Events read from one delivery. */
export const MAX_DELIVERY_EVENTS = 50;
/** Cleanup alarms run at most this often, so a busy page does not wake up for every expired id. */
export const CLEANUP_INTERVAL_MS = 60_000;
/** Activity sockets per page: overlay sources and the owner's preview. */
export const MAX_SOCKETS = 20;
/** last_event_at in D1 is written at most this often per channel. */
export const HEALTH_INTERVAL_MS = 30_000;
/**
 * YouTube: the floor between chat polls (5 units each), the wait between checks for a live broadcast while the
 * channel is not live (1 unit each), and the backoff bounds. At the floor, one live page spends 1,800 units an
 * hour; an open overlay on a channel that is not live spends 6 units an hour.
 */
export const YOUTUBE_MIN_POLL_MS = 10_000;
export const YOUTUBE_IDLE_POLL_MS = 10 * 60_000;
/**
 * The floor after a page without items, and for each poll once YOUTUBE_LOW_BUDGET_SHARE of a daily budget is
 * spent. It stays below LIVE_WINDOW_MS, so a message that waits one interval is still live.
 */
export const YOUTUBE_QUIET_POLL_MS = 20_000;
export const YOUTUBE_LOW_BUDGET_SHARE = 0.8;
/**
 * For this long after the first consumer connects, the check for a live broadcast runs at the shorter interval:
 * chat starts soon after the streamer goes live. The window costs at most 30 units.
 */
export const YOUTUBE_STARTUP_WINDOW_MS = 30 * 60_000;
export const YOUTUBE_STARTUP_POLL_MS = 60_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** The stored YouTube channel title is read again from YouTube this often while an overlay is open. */
export const YOUTUBE_NAME_REFRESH_MS = 86_400_000;
/** A failed title read is tried again after this long. */
export const YOUTUBE_NAME_RETRY_MS = 60 * 60_000;
/** The hourly expiry job skips a connection whose refresh it tried this recently: less than the job's interval. */
export const YOUTUBE_JOB_RETRY_MS = 50 * 60_000;
/** Units of the shared daily YouTube Data API quota (10,000 by default) the feed may spend, across all pages. */
export const YOUTUBE_DAILY_BUDGET = 9_000;
/** Units one page may spend each day: 5 hours of live chat. Lower it when more pages share the daily budget. */
export const YOUTUBE_PAGE_DAILY_BUDGET = 9_000;
/** Refresh an access token this long before it expires. */
export const REFRESH_MARGIN_MS = 60_000;

export type Admission = "chat" | "moderation";
export type Bucket = { tokens: number; at: number };

export const ADMISSIONS: Readonly<Record<Admission, { rate: number; burst: number }>> = {
  chat: { rate: ADMISSION_RATE, burst: ADMISSION_BURST },
  moderation: { rate: MODERATION_RATE, burst: MODERATION_BURST },
};

export function newBuckets(): Record<Admission, Bucket> {
  return { chat: { tokens: ADMISSION_BURST, at: 0 }, moderation: { tokens: MODERATION_BURST, at: 0 } };
}

/** Provider subscriptions are checked at most this often while a consumer listens. */
export const RECONCILE_INTERVAL_MS = 10 * 60_000;
/** The watchdog acts only when no delivery was accepted for this long while a consumer listened. */
export const WATCHDOG_QUIET_MS = 10 * 60_000;
/** The watchdog reports one channel at most this often. */
export const WATCHDOG_COOLDOWN_MS = 60 * 60_000;
/** Sampled refusals inside WATCHDOG_QUIET_MS before the watchdog counts them: one a minute for each isolate. */
export const WATCHDOG_MIN_REFUSALS = 3;

/**
 * Spends units of today's YouTube quota: the page's own budget first, then the shared one. Returns the larger spent
 * share of the two budgets (0 to 1), or null when either is used up; a refused shared spend gives the page's
 * units back.
 */
export async function spendYoutubeQuota(
  db: D1Database,
  streamerId: string | undefined,
  units: number,
  now: number,
): Promise<number | null> {
  const { day, resetAt } = quotaDay(now);
  const spend = (key: string, budget: number): Promise<{ count: number } | null> =>
    db
      .prepare(
        `INSERT INTO app_rate_limits (key, count, window_start) SELECT ?1, ?2, ?3 WHERE ?2 <= ?4
          ON CONFLICT(key) DO UPDATE SET count = count + excluded.count
          WHERE app_rate_limits.count + excluded.count <= ?4
          RETURNING count`,
      )
      // The row starts at the day's reset, so the 24-hour cleanup never removes it before the day ends.
      .bind(key, units, resetAt, budget)
      .first<{ count: number }>();
  const pageKey = `youtube-quota:${day}:${streamerId}`;
  const own = await spend(pageKey, YOUTUBE_PAGE_DAILY_BUDGET);
  if (!own) return null;
  const shared = await spend(`youtube-quota:${day}`, YOUTUBE_DAILY_BUDGET);
  if (shared) return Math.max(own.count / YOUTUBE_PAGE_DAILY_BUDGET, shared.count / YOUTUBE_DAILY_BUDGET);
  await db.prepare("UPDATE app_rate_limits SET count = count - ? WHERE key = ?").bind(units, pageKey).run();
  return null;
}
