import nodeCrypto from "node:crypto";
import type { AppEnv } from "../env";
import {
  quotaDay,
  type ActivityEvent,
  type ActivityPlatform,
  type ChannelStatus,
  type ChannelStatusCode,
} from "../lib/activity";
import { earliestAt } from "./alert-host";
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  YOUTUBE_IDLE_POLL_MS,
  YOUTUBE_JOB_RETRY_MS,
  YOUTUBE_LOW_BUDGET_SHARE,
  YOUTUBE_MIN_POLL_MS,
  YOUTUBE_NAME_REFRESH_MS,
  YOUTUBE_NAME_RETRY_MS,
  YOUTUBE_QUIET_POLL_MS,
  YOUTUBE_STARTUP_POLL_MS,
  YOUTUBE_STARTUP_WINDOW_MS,
  spendYoutubeQuota,
} from "./channel-ingest-limits";
import { NEW_YOUTUBE_STATE, type Connection, type YoutubeState } from "./channel-ingest-state";
import { youtubeEvents } from "./channel-normalize";
import {
  channelIdentity,
  IMPORT_HORIZON_MS,
  type ImportedStream,
  ProviderError,
  ReauthRequired,
  twitchSchedule,
  youtubeChatPage,
  youtubeLiveChat,
  youtubeUpcoming,
} from "./channel-providers.server";
import { youtubeSupport } from "./channel-support";
import { channelsOff, type StoredTokens } from "./channel-tokens.server";

/**
 * The YouTube live chat poll of a page, with the title refresh and the schedule read. The poll runs only while a
 * consumer listens, so an idle page spends no quota.
 */

/** A disconnect or close started while a poll waited: the poll stops and writes nothing. */
class Superseded extends Error {}

/** What the YouTube poll needs from the page's ChannelIngest object. */
export interface YoutubeHost {
  env: AppEnv;
  storage: Pick<DurableObjectStorage, "get" | "put">;
  streamerId: () => string | undefined;
  /** Whether a consumer listens. */
  listening: () => boolean;
  connection: (platform: ActivityPlatform) => Promise<Connection | null>;
  setStatus: (
    platform: ActivityPlatform,
    connection: Connection,
    status: ChannelStatus,
    code: ChannelStatusCode | null,
  ) => Promise<void>;
  freshTokens: (platform: ActivityPlatform, connection: Connection) => Promise<StoredTokens>;
  /** Changes with each connect, disconnect and close: work that one of them overtook writes nothing. */
  generation: (platform: ActivityPlatform) => number | undefined;
  /** Sets the object's alarm to `at`, unless it already runs earlier. */
  schedule: (at: number) => Promise<void>;
  /** Records that the channel works (last_event_at). */
  touch: (platform: ActivityPlatform, connection: Connection, now: number) => Promise<void>;
  /** Whether the alerts can take events from `since`. */
  alertsReady: (since: number) => Promise<boolean>;
  /** Admits the events, then stores and broadcasts the admitted ones. */
  ingest: (events: readonly ActivityEvent[], now: number) => void;
}

export class YoutubePoller {
  constructor(private readonly host: YoutubeHost) {}

  /** A consumer listens: the poll starts, but never earlier than a backoff, an interval or a quota wait. */
  async listeningStarted(now: number): Promise<void> {
    const youtube = await this.host.connection("youtube");
    if (!youtube || youtube.status === "needs_reauth" || youtube.suspended) return;
    const state = (await this.host.storage.get<YoutubeState>("youtube")) ?? NEW_YOUTUBE_STATE;
    await this.host.schedule(Math.max(now, state.nextPollAt));
  }

  /** A connect succeeded: polling starts. */
  async connected(now: number): Promise<void> {
    // A reconnect starts a new chat session but keeps a pending wait, so reconnecting cannot skip a quota wait.
    const previous = (await this.host.storage.get<YoutubeState>("youtube")) ?? NEW_YOUTUBE_STATE;
    // The callback read the title just now.
    const state: YoutubeState = { ...NEW_YOUTUBE_STATE, nextPollAt: previous.nextPollAt, nameAt: now };
    await this.host.storage.put("youtube", state);
    await this.host.schedule(Math.max(now, state.nextPollAt));
  }

  /** One YouTube poll, when one is due. Returns the wait before the next one, or null for none. */
  async poll(now: number): Promise<number | null> {
    const { env, storage } = this.host;
    if (channelsOff(env)) return null;
    if (this.host.streamerId() === undefined || !this.host.listening()) return null;
    const connection = await this.host.connection("youtube");
    if (!connection || connection.status === "needs_reauth" || connection.suspended) return null;
    const state: YoutubeState = { ...NEW_YOUTUBE_STATE, ...(await storage.get<YoutubeState>("youtube")) };
    // The alarm also runs for cleanup and when a consumer connects: no poll before its time.
    if (now < state.nextPollAt) return state.nextPollAt - now;
    // A disconnect or close that runs during the poll bumps the generation: the poll then writes nothing more, so
    // no data, status or state comes back.
    const generation = this.host.generation("youtube") ?? 0;
    const stale = (): boolean => (this.host.generation("youtube") ?? 0) !== generation;
    const current = (): void => {
      if (stale()) throw new Superseded();
    };
    let next: number;
    try {
      next = await this.pollChat(connection, state, now, current);
      state.backoffMs = 0;
      if (stale()) return null;
      if (connection.status !== "active") await this.host.setStatus("youtube", connection, "active", null);
    } catch (error: unknown) {
      if (error instanceof Superseded || stale()) return null;
      next = await this.pollFailed(connection, state, error, now);
    }
    if (stale()) return null;
    state.nextPollAt = next >= 0 ? now + next : 0;
    await storage.put("youtube", state);
    return next >= 0 ? next : null;
  }

  /**
   * Reads the YouTube channel title again and stores it with the time (data_read_at). The quota unit is spent only
   * after a successful read of this channel. A token for another channel changes nothing.
   */
  private async refreshTitle(connection: Connection, accessToken: string, now: number): Promise<void> {
    const { env } = this.host;
    const identity = await channelIdentity(env, "youtube", accessToken);
    // The token reads another channel: nothing about this one was refreshed.
    if (identity.externalId !== connection.externalId) throw new ProviderError(409, "channelMismatch");
    await spendYoutubeQuota(env.DB, this.host.streamerId(), 1, now);
    await env.DB.prepare(
      `UPDATE channel_connections SET display_name=?, data_read_at=?
        WHERE id=? AND (status_code IS NULL OR status_code <> 'disconnecting')`,
    )
      .bind(identity.displayName, now, connection.id)
      .run();
  }

  /**
   * The hourly expiry job asks for a title refresh of an old YouTube connection: `refreshed`, `reauth`, `failed`,
   * or `recent` when an attempt ran in the last YOUTUBE_JOB_RETRY_MS (the job then tries another connection).
   */
  async refreshRequested(): Promise<{ result: "refreshed" | "reauth" | "failed" | "recent" }> {
    const now = Date.now();
    const last = (await this.host.storage.get<number>("refreshAttemptAt")) ?? 0;
    if (now - last < YOUTUBE_JOB_RETRY_MS) return { result: "recent" };
    await this.host.storage.put("refreshAttemptAt", now);
    const connection = await this.host.connection("youtube");
    if (!connection || connection.status === "needs_reauth") return { result: "failed" };
    // A reconnect during this refresh replaced the authorization: a refusal of the old one writes nothing.
    const generation = this.host.generation("youtube");
    try {
      const tokens = await this.host.freshTokens("youtube", connection);
      await this.refreshTitle(connection, tokens.accessToken, now);
      return { result: "refreshed" };
    } catch (error: unknown) {
      if (!(error instanceof ReauthRequired)) {
        console.warn("channel_name_refresh_failed", {
          platform: "youtube",
          cause: error instanceof Error ? error.name : "unknown",
        });
        return { result: "failed" };
      }
      if (this.host.generation("youtube") !== generation) return { result: "failed" };
      await this.host.setStatus("youtube", connection, "needs_reauth", "authorization_revoked");
      return { result: "reauth" };
    }
  }

  /**
   * The channel's scheduled streams for 4 weeks (schedule import), or null when they cannot be read now: the import
   * then changes nothing. Twitch uses the app token; YouTube spends 1 quota unit of the page for each page of 50.
   */
  async upcomingRequested(platform: ActivityPlatform): Promise<{ streams: ImportedStream[] | null }> {
    const { env } = this.host;
    const connection = channelsOff(env) || platform === "kick" ? null : await this.host.connection(platform);
    const blocked =
      connection?.status === "needs_reauth" || connection?.suspended || connection?.code === "disconnecting";
    if (!connection || blocked) return { streams: null };
    const now = Date.now();
    const generation = this.host.generation(platform);
    try {
      if (platform === "twitch")
        return { streams: await twitchSchedule(env, connection.externalId, now, now + IMPORT_HORIZON_MS) };
      const tokens = await this.host.freshTokens(platform, connection);
      const spend = (): Promise<number | null> => spendYoutubeQuota(env.DB, this.host.streamerId(), 1, Date.now());
      return { streams: await youtubeUpcoming(tokens.accessToken, now + IMPORT_HORIZON_MS, spend) };
    } catch (error: unknown) {
      if (error instanceof ReauthRequired && platform === "youtube" && this.host.generation(platform) === generation)
        await this.host.setStatus(platform, connection, "needs_reauth", "authorization_revoked");
      else console.warn("schedule_read_failed", { platform, cause: error instanceof Error ? error.name : "unknown" });
      return { streams: null };
    }
  }

  /** Returns the wait before the next poll. */
  private async pollChat(
    connection: Connection,
    state: YoutubeState,
    now: number,
    current: () => void,
  ): Promise<number> {
    const spent = await spendYoutubeQuota(this.host.env.DB, this.host.streamerId(), state.liveChatId ? 5 : 1, now);
    if (spent === null) throw new ProviderError(403, "quotaExceeded");
    const tokens = await this.host.freshTokens("youtube", connection);
    // Stored YouTube data must be fresh (YouTube API Services policy): read the title again once a day. A failed
    // read is tried again after an hour, a read of another channel after a day; neither stops the chat poll.
    if (now - state.nameAt >= YOUTUBE_NAME_REFRESH_MS) {
      await this.refreshPollingTitle(connection, tokens.accessToken, state, now);
      current();
    }
    if (!state.liveChatId) {
      state.liveChatId = await youtubeLiveChat(tokens.accessToken);
      state.pageToken = null;
      if (state.liveChatId) return 0;
      const since = (await this.host.storage.get<number>("listeningSince")) ?? now;
      return now - since < YOUTUBE_STARTUP_WINDOW_MS ? YOUTUBE_STARTUP_POLL_MS : YOUTUBE_IDLE_POLL_MS;
    }
    const page = await youtubeChatPage(tokens.accessToken, state.liveChatId, state.pageToken);
    // The first page is ingested too: messages sent before LIVE_WINDOW_MS are not live, so no old command runs.
    // Support events come from the same page at no cost. Only a connect, which supersedes this poll, changes them.
    const support = connection.support ? youtubeSupport(page.items, now) : [];
    const events = [...youtubeEvents(page.items, connection.externalId, now), ...support];
    if (!(await this.host.alertsReady(earliestAt(events, now)))) throw new Error("alerts_unavailable");
    current();
    this.host.ingest(events, now);
    state.pageToken = page.nextPageToken;
    if (page.items.length > 0) await this.host.touch("youtube", connection, now);
    if (page.offline) {
      state.liveChatId = null;
      state.pageToken = null;
      return YOUTUBE_IDLE_POLL_MS;
    }
    // A quiet chat and a budget that runs low both get the longer floor: the day's units last longer.
    const quiet = page.items.length === 0 || spent >= YOUTUBE_LOW_BUDGET_SHARE;
    return Math.max(page.pollingIntervalMillis, quiet ? YOUTUBE_QUIET_POLL_MS : YOUTUBE_MIN_POLL_MS);
  }

  private async refreshPollingTitle(
    connection: Connection,
    accessToken: string,
    state: YoutubeState,
    now: number,
  ): Promise<void> {
    try {
      await this.refreshTitle(connection, accessToken, now);
      state.nameAt = now;
    } catch (error: unknown) {
      if (error instanceof ReauthRequired) throw error;
      console.warn("channel_name_refresh_failed", {
        platform: "youtube",
        cause: error instanceof Error ? error.name : "unknown",
      });
      const mismatch = error instanceof ProviderError && error.reason === "channelMismatch";
      state.nameAt = mismatch ? now : now - YOUTUBE_NAME_REFRESH_MS + YOUTUBE_NAME_RETRY_MS;
    }
  }

  private async pollFailed(connection: Connection, state: YoutubeState, error: unknown, now: number): Promise<number> {
    if (error instanceof ReauthRequired) {
      await this.host.setStatus("youtube", connection, "needs_reauth", "authorization_revoked");
      return -1;
    }
    const reason = error instanceof ProviderError ? error.reason : null;
    if (reason === "liveChatEnded" || reason === "liveChatNotFound" || reason === "liveChatDisabled") {
      state.liveChatId = null;
      state.pageToken = null;
      return YOUTUBE_IDLE_POLL_MS;
    }
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      console.warn("channel_quota_exhausted", { platform: "youtube" });
      await this.host.setStatus("youtube", connection, "error", "quota_exhausted");
      // Try again a minute after the quota resets at midnight Pacific Time.
      return quotaDay(now).resetAt - now + 60_000;
    }
    console.error("channel_poll_failed", {
      platform: "youtube",
      cause: error instanceof Error ? error.name : "unknown",
    });
    state.backoffMs = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, state.backoffMs * 2));
    return nodeCrypto.randomInt(Math.ceil(state.backoffMs / 2), state.backoffMs + 1);
  }
}
