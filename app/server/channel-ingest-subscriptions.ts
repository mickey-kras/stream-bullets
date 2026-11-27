import nodeCrypto from "node:crypto";
import type { AppEnv } from "../env";
import type { ActivityPlatform, ChannelStatus, ChannelStatusCode } from "../lib/activity";
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  RECONCILE_INTERVAL_MS,
  WATCHDOG_COOLDOWN_MS,
  WATCHDOG_QUIET_MS,
} from "./channel-ingest-limits";
import { NEW_REPAIR_STATE, type Connection, type ReconcileResult, type RepairState } from "./channel-ingest-state";
import {
  ProviderError,
  ReauthRequired,
  configuredPlatform,
  listSubscriptions,
  subscribe,
  unsubscribe,
} from "./channel-providers.server";
import { reconcileSubscriptions, webhooksOnlyRefused, type Reconciled } from "./channel-repair.server";
import { channelsOff, type StoredTokens } from "./channel-tokens.server";
import { getOrigin } from "./http.server";

/** The provider subscriptions of a page's channels: made on connect, and repaired without the owner. */

/** The platforms with provider subscriptions that a check can repair. YouTube is polled. */
const REPAIRABLE: readonly ActivityPlatform[] = ["twitch", "kick"];

/** What the subscriptions need from the page's ChannelIngest object. */
export interface SubscriptionHost {
  env: AppEnv;
  storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
  streamerId: () => string | undefined;
  /** Whether a consumer listens. */
  listening: () => boolean;
  connection: (platform: ActivityPlatform) => Promise<Connection | null>;
  /** Forgets the connections that the object read: the next use reads them from D1 again. */
  forget: () => void;
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
  /** When the object last accepted a delivery of the platform, as far as its memory knows. */
  acceptedAt: (platform: ActivityPlatform) => number;
}

export class ChannelSubscriptions {
  /** Changes of the provider subscriptions run one at a time for each platform. */
  private readonly queue = new Map<ActivityPlatform, Promise<void>>();
  /** Platforms without a channel to check, with when to look again: no alarm runs for them. */
  private readonly absent = new Map<ActivityPlatform, number>();

  constructor(private readonly host: SubscriptionHost) {}

  /** A connection changed: every platform is looked at again. */
  forget(): void {
    this.absent.clear();
  }

  /** Runs `work` after the earlier subscription work of the platform ended, whatever its outcome. */
  async serial<T>(platform: ActivityPlatform, work: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(platform) ?? Promise.resolve();
    const pending = previous.then(work);
    // The queue advances after either outcome; the caller still receives the original failure.
    const settled = pending.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.queue.set(platform, settled);
    try {
      return await pending;
    } finally {
      if (this.queue.get(platform) === settled) this.queue.delete(platform);
    }
  }

  /** The subscriptions this object knows of and the ones the provider lists for the channel and this callback. */
  async known(
    platform: ActivityPlatform,
    connection: Connection,
    accessToken: string | null,
  ): Promise<{ ids: string[]; listed: boolean }> {
    const { env, storage } = this.host;
    const stored = (await storage.get<string[]>(`subs:${platform}`)) ?? [];
    const listed = await listSubscriptions(env, platform, connection.externalId, accessToken, getOrigin(env));
    return { ids: [...new Set([...stored, ...(listed ?? []).map((item) => item.id)])], listed: listed !== null };
  }

  /** On a connect: deletes the old subscriptions of the channel and makes new ones. A missing type fails it. */
  async resubscribe(
    platform: ActivityPlatform,
    connection: Connection,
    accessToken: string,
    overtaken: () => boolean,
  ): Promise<void> {
    await this.serial(platform, async (): Promise<void> => {
      if (!overtaken()) await this.replace(platform, connection, accessToken, overtaken);
    });
  }

  /**
   * The provider refused a subscription that only support events need: the connection reads no support events
   * until its owner reconnects it. The subscriptions of chat and the status stay as they are, and the next check
   * deletes what is left.
   */
  private async supportRefused(platform: ActivityPlatform, connection: Connection): Promise<void> {
    await this.host.env.DB.prepare("UPDATE channel_connections SET support_events=0 WHERE id=?")
      .bind(connection.id)
      .run();
    this.host.forget();
    // Only the platform: never an id, a name or provider text.
    console.warn("channel_support_refused", { platform });
  }

  /** Undeleted and new ids stay stored for a later disconnect. A Twitch 409 adopts the listed ids of that type. */
  private async replace(
    platform: ActivityPlatform,
    connection: Connection,
    accessToken: string,
    overtaken: () => boolean,
  ): Promise<void> {
    const { env, storage } = this.host;
    const origin = getOrigin(env);
    const known = await this.known(platform, connection, accessToken);
    if (overtaken()) return;
    let kept = await unsubscribe(env, platform, known.ids, accessToken);
    if (overtaken()) return;
    const created: string[] = [];
    try {
      const scope = { only: null, support: connection.support };
      const { conflicts, refused } = await subscribe(
        env,
        platform,
        connection.externalId,
        accessToken,
        origin,
        created,
        scope,
      );
      if (refused && !overtaken()) await this.supportRefused(platform, connection);
      if (conflicts.length > 0) {
        const listed = await listSubscriptions(env, platform, connection.externalId, accessToken, origin);
        const adopted = (listed ?? []).filter((item) => conflicts.includes(item.type));
        kept = [...kept, ...adopted.map((item) => item.id)];
        if (conflicts.some((type) => !adopted.some((item) => item.type === type))) throw new ProviderError(409);
      }
    } finally {
      if (!overtaken()) await storage.put(`subs:${platform}`, [...new Set([...kept, ...created])]);
    }
  }

  // Repair --------------------------------------------------------------------------------------------------------

  /** A connect made every subscription just now: the next check waits one interval. */
  async connected(platform: ActivityPlatform, now: number): Promise<void> {
    await this.host.storage.put(`repair:${platform}`, { ...NEW_REPAIR_STATE, nextAt: now + RECONCILE_INTERVAL_MS });
    await this.host.schedule(now + RECONCILE_INTERVAL_MS);
  }

  /** A consumer starts to listen: the check of each connected channel runs, no earlier than its own wait. */
  async listeningStarted(now: number): Promise<void> {
    const { env } = this.host;
    const platforms = REPAIRABLE.filter((platform: ActivityPlatform) => configuredPlatform(env, platform));
    if (platforms.length === 0) return;
    const { results } = await env.DB.prepare(
      `SELECT platform FROM channel_connections
        WHERE streamer_id=? AND platform IN ('twitch','kick') AND status <> 'needs_reauth'`,
    )
      .bind(this.host.streamerId())
      .all<{ platform: ActivityPlatform }>();
    this.absent.clear();
    for (const row of results) {
      if (!platforms.includes(row.platform)) continue;
      // A new consumer never moves a check forward past its interval or a backoff.
      await this.host.schedule(Math.max(now, (await this.state(row.platform)).nextAt));
    }
  }

  /** A check needs provider credentials and a connection that is not suspended or waiting for its owner. */
  private checkable(platform: ActivityPlatform, connection: Connection | null): connection is Connection {
    if (!connection || !configuredPlatform(this.host.env, platform)) return false;
    return connection.status !== "needs_reauth" && !connection.suspended;
  }

  private async state(platform: ActivityPlatform): Promise<RepairState> {
    return { ...NEW_REPAIR_STATE, ...(await this.host.storage.get<RepairState>(`repair:${platform}`)) };
  }

  /** The next backoff: twice the last one, inside BACKOFF_MIN_MS and BACKOFF_MAX_MS. */
  private nextBackoff(backoffMs: number): number {
    return Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, backoffMs * 2));
  }

  /** After a revocation: schedules a repair with exponential backoff. A repair already owed keeps its time. */
  async owe(platform: ActivityPlatform, now: number): Promise<void> {
    if (!REPAIRABLE.includes(platform)) return;
    const state = await this.state(platform);
    if (state.backoffMs === 0 || state.nextAt <= now) {
      state.backoffMs = this.nextBackoff(state.backoffMs);
      state.nextAt = now + state.backoffMs;
      await this.host.storage.put(`repair:${platform}`, state);
    }
    await this.host.schedule(state.nextAt);
  }

  /** Checks the provider subscriptions of a channel, repairs them and sets the status that the result proves. */
  private reconcile(platform: ActivityPlatform, connection: Connection): Promise<ReconcileResult> {
    const generation = this.host.generation(platform);
    const overtaken = (): boolean => this.host.generation(platform) !== generation;
    return this.serial(platform, () => this.reconcileNow(platform, connection, overtaken));
  }

  private async reconcileNow(
    platform: ActivityPlatform,
    connection: Connection,
    overtaken: () => boolean,
  ): Promise<ReconcileResult> {
    if (overtaken()) return "skipped";
    const outcome = await this.reconciled(platform, connection);
    // A connect, a disconnect or a close ran during the check: its outcome stands, so this one writes nothing.
    if (overtaken()) return "skipped";
    if (outcome.ids !== null) await this.host.storage.put(`subs:${platform}`, outcome.ids);
    if (outcome.supportRefused) await this.supportRefused(platform, connection);
    // A revocation can arrive during the check: the status it set stands, so the stale one writes no status.
    const current = await this.host.connection(platform);
    if (!this.checkable(platform, current)) return "skipped";
    if (outcome.failure !== null) return this.reconcileFailed(platform, current, outcome);
    if (outcome.changed) console.warn("channel_subscriptions_repaired", { platform });
    // A healthy list does not disprove refused webhooks: only a repair or an accepted delivery ends that code.
    const refused = current.code === "webhooks_rejected" && !outcome.changed;
    if (current.status !== "active" && !refused) await this.host.setStatus(platform, current, "active", null);
    return outcome.changed ? "repaired" : "ok";
  }

  /** The provider check with the token it needs. Twitch needs only the app token; Kick the broadcaster's. */
  private async reconciled(platform: ActivityPlatform, connection: Connection): Promise<Reconciled> {
    let accessToken: string | null = null;
    try {
      if (platform === "kick") accessToken = (await this.host.freshTokens(platform, connection)).accessToken;
    } catch (error: unknown) {
      const failure = error instanceof ReauthRequired ? "reauth" : "provider";
      return { ids: null, changed: false, failure, supportRefused: false };
    }
    return reconcileSubscriptions(this.host.env, platform, connection.externalId, accessToken, connection.support);
  }

  private async reconcileFailed(
    platform: ActivityPlatform,
    connection: Connection,
    outcome: Reconciled,
  ): Promise<ReconcileResult> {
    if (outcome.failure === "reauth") {
      await this.host.setStatus(platform, connection, "needs_reauth", "authorization_revoked");
      return "reauth";
    }
    console.error("channel_reconcile_failed", { platform });
    // A list that cannot be read proves nothing about the channel. An error status keeps the reason it names.
    if (outcome.ids !== null && connection.status !== "error")
      await this.host.setStatus(platform, connection, "error", "subscribe_failed");
    return "failed";
  }

  /** Stores when the next check runs. Returns the wait before it, or null when no alarm is needed for it. */
  private async scheduled(
    platform: ActivityPlatform,
    state: RepairState,
    result: ReconcileResult,
    listening: boolean,
    now: number,
  ): Promise<number | null> {
    // A connect, a disconnect or a close overtook the check and owns the stored state.
    if (result === "skipped") return null;
    const key = `repair:${platform}`;
    // Without a consumer, a repair that still fails at the longest backoff is left to the hourly job.
    const stop = result === "reauth" || (!listening && state.backoffMs >= BACKOFF_MAX_MS);
    if (result !== "failed" || stop) {
      await this.host.storage.put(key, { ...state, nextAt: now + RECONCILE_INTERVAL_MS, backoffMs: 0 });
      return listening && result !== "reauth" ? RECONCILE_INTERVAL_MS : null;
    }
    const backoffMs = this.nextBackoff(state.backoffMs);
    const wait = nodeCrypto.randomInt(Math.ceil(backoffMs / 2), backoffMs + 1);
    await this.host.storage.put(key, { ...state, nextAt: now + wait, backoffMs });
    return wait;
  }

  /** Reports a channel whose webhooks are only refused while a consumer listens. Returns the connection to use. */
  private async watch(
    platform: ActivityPlatform,
    connection: Connection,
    state: RepairState,
    now: number,
  ): Promise<Connection> {
    const since = (await this.host.storage.get<number>("listeningSince")) ?? now;
    const accepted = Math.max(connection.lastEventAt ?? 0, this.host.acceptedAt(platform), since);
    // An accepted delivery in the window proves the channel healthy: refusals alone then change nothing.
    if (now - accepted < WATCHDOG_QUIET_MS || now - state.alertedAt < WATCHDOG_COOLDOWN_MS) return connection;
    if (!(await webhooksOnlyRefused(this.host.env, platform, connection.externalId, now))) return connection;
    state.alertedAt = now;
    // Only the platform: never a header, a body, a signature or an id.
    console.warn("channel_webhooks_all_rejected", { platform });
    // A revocation can arrive during the read above: the status it set stands.
    const current = await this.host.connection(platform);
    if (!this.checkable(platform, current)) return current ?? connection;
    if (current.code === "webhooks_rejected") return current;
    await this.host.setStatus(platform, current, "error", "webhooks_rejected");
    return { ...current, status: "error", code: "webhooks_rejected" };
  }

  /** One due subscription check of a platform. Returns the wait before its next one, or null for none. */
  private async platformDue(platform: ActivityPlatform, listening: boolean, now: number): Promise<number | null> {
    if (now < (this.absent.get(platform) ?? 0)) return null;
    const state = await this.state(platform);
    // A check runs while a consumer listens, or when a revocation or a failed check owes one.
    if (!listening && state.backoffMs === 0) return null;
    if (now < state.nextAt) return state.nextAt - now;
    const connection = await this.host.connection(platform);
    if (!this.checkable(platform, connection)) {
      // Nothing to check until a connect or a new consumer: both clear this mark.
      this.absent.set(platform, now + RECONCILE_INTERVAL_MS);
      await this.host.storage.delete(`repair:${platform}`);
      return null;
    }
    const current = listening ? await this.watch(platform, connection, state, now) : connection;
    if (!this.checkable(platform, current)) return null;
    const result = await this.reconcile(platform, current);
    return this.scheduled(platform, state, result, listening, now);
  }

  /** A check that throws (storage, D1) is logged. It runs again after one interval while a consumer listens. */
  private async checked(platform: ActivityPlatform, listening: boolean, now: number): Promise<number | null> {
    try {
      return await this.platformDue(platform, listening, now);
    } catch (error: unknown) {
      console.error("channel_repair_failed", { platform, cause: error instanceof Error ? error.name : "unknown" });
      return listening ? RECONCILE_INTERVAL_MS : null;
    }
  }

  /** Runs the subscription checks that are due. Returns the wait before the next one, or null for none. */
  async due(now: number): Promise<number | null> {
    if (channelsOff(this.host.env) || this.host.streamerId() === undefined) return null;
    const listening = this.host.listening();
    let soonest: number | null = null;
    for (const platform of REPAIRABLE) {
      const wait = await this.checked(platform, listening, now);
      if (wait !== null) soonest = Math.min(soonest ?? Infinity, wait);
    }
    return soonest;
  }

  /** The hourly job asks for a check. One that ran or is scheduled inside the interval stands: `recent`. */
  async requested(platform: ActivityPlatform, now: number): Promise<{ result: ReconcileResult | "recent" }> {
    if (!REPAIRABLE.includes(platform) || channelsOff(this.host.env)) return { result: "skipped" };
    const state = await this.state(platform);
    if (now < state.nextAt) return { result: "recent" };
    const connection = await this.host.connection(platform);
    if (!this.checkable(platform, connection)) return { result: "skipped" };
    const result = await this.reconcile(platform, connection);
    const wait = await this.scheduled(platform, state, result, this.host.listening(), now);
    if (wait !== null) await this.host.schedule(now + wait);
    return { result };
  }
}
