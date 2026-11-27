import type { ChannelStatus } from "../lib/activity";

/** One stored channel connection as the ingest object uses it. */
export interface Connection {
  id: string;
  externalId: string;
  status: ChannelStatus;
  /** Why the status is not `active`, as stored (`status_code`). */
  code: string | null;
  /** When the last delivery was accepted, at a resolution of HEALTH_INTERVAL_MS. */
  lastEventAt: number | null;
  /** The page is suspended: nothing is received or polled until an admin lifts it. */
  suspended: boolean;
  /** The connection reads support events (`support_events`). Without it, the object drops each support event. */
  support: boolean;
}

/** The YouTube polling state that the ingest object keeps in its storage. */
export interface YoutubeState {
  liveChatId: string | null;
  pageToken: string | null;
  backoffMs: number;
  /** No poll runs before this time: the backoff, the polling interval and quota waits all set it. */
  nextPollAt: number;
  /** When the channel title was last read again from YouTube. */
  nameAt: number;
}

export const NEW_YOUTUBE_STATE: YoutubeState = {
  liveChatId: null,
  pageToken: null,
  backoffMs: 0,
  nextPollAt: 0,
  nameAt: 0,
};

/** The subscription repair schedule of one platform that the ingest object keeps in its storage. */
export interface RepairState {
  /** No subscription check runs before this time. */
  nextAt: number;
  /** Above zero while a repair is owed (a revocation or a failed check): it then runs without a consumer too. */
  backoffMs: number;
  /** When the watchdog last reported this channel. */
  alertedAt: number;
}

export const NEW_REPAIR_STATE: RepairState = { nextAt: 0, backoffMs: 0, alertedAt: 0 };

/** What one subscription check did. `skipped`: a connect, a disconnect or a close overtook it. */
export type ReconcileResult = "ok" | "repaired" | "failed" | "reauth" | "skipped";
