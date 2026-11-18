import type { ChannelStatus } from "../lib/activity";

/** One stored channel connection as the ingest object uses it. */
export interface Connection {
  id: string;
  externalId: string;
  status: ChannelStatus;
  /** The page is suspended: nothing is received or polled until an admin lifts it. */
  suspended: boolean;
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
