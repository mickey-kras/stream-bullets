/**
 * The proposed targets of the live load model (docs/live-room-capacity.md, issue #1028).
 *
 * The owner has not set these numbers. Each one is a proposal until the owner confirms it. The load tests
 * (tests/activity-capacity.test.ts, tests/live-capacity.test.ts) assert each constant, so a change here is the only
 * change that a new target needs. Keep the table "Proposed targets" in the document equal to this file.
 */

/** Event-to-screen latency, p95, in the harness: from the webhook request to the event on an activity socket. */
export const EVENT_LATENCY_P95_MS = 250;

/** The same latency for a moderation event that arrives during a chat flood above the admission rate. */
export const MODERATION_LATENCY_P95_MS = 250;

/** Events of each type that the feed may drop while the offered rate is below the admission rate of the type. */
export const DROPPED_EVENTS_BELOW_ADMISSION: Readonly<Record<"chat" | "moderation", number>> = {
  chat: 0,
  moderation: 0,
};

/** Admitted events that may fail to reach an open activity socket, at any offered rate. */
export const LOST_ADMITTED_EVENTS = 0;

/**
 * Memory growth per live hour, as a storage proxy: the growth of the row count of the ingest object (snapshot,
 * seen ids, deleted ids) from one live hour to the next, after the first hour.
 */
export const STORAGE_ROW_GROWTH_PER_LIVE_HOUR = 0;

/** Public-page responsiveness: the p95 time until a vote burst reaches each of 200 live-room sockets, in ms. */
export const PUBLIC_UPDATE_P95_MS = 500;

/** The p95 time from a reconnect to the snapshot on the socket, in ms, when each socket reconnects at once. */
export const RECONNECT_SNAPSHOT_P95_MS = 500;

/** Provider requests that one reconnect of a consumer may cause. */
export const PROVIDER_REQUESTS_PER_RECONNECT = 0;

/** Provider quota per live channel: YouTube Data API units that one live channel may spend in one hour. */
export const YOUTUBE_UNITS_PER_LIVE_HOUR = 1_800;

/**
 * Cost per live channel-hour, as its drivers: what one busy live channel may use in one hour. Money needs the
 * current Cloudflare price list, which the owner applies to these counts.
 */
export const COST_DRIVERS_PER_LIVE_HOUR: Readonly<Record<"d1Statements" | "alarmRuns" | "providerRequests", number>> = {
  d1Statements: 2_000,
  alarmRuns: 400,
  providerRequests: 400,
};
