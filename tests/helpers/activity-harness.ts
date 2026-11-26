import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response as RuntimeResponse, type Request as RuntimeRequest } from "miniflare";
import type { AppEnv } from "../../app/env";
import type { ActivityChat } from "../../app/lib/activity";
import { requiredSubscriptions } from "../../app/server/channel-providers.server";
import { tokenStatement } from "../../app/server/channel-tokens.server";
import type { IngestReport, StepReport, WorkerReport } from "./activity-worker";
import { fakeProviders, type FakeProviders, type ProviderFetch } from "./channels";
import { applyMigrations, migrationFiles } from "./database";

/**
 * The isolated harness of the activity path (docs/live-room-capacity.md): the real ChannelIngest object and the real
 * Twitch webhook in Miniflare, with workerd WebSockets, a temporary D1 with the real migrations and object SQLite
 * storage. Provider requests never leave the machine: the fake providers of tests/helpers/channels.ts answer them.
 */

type Socket = NonNullable<Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]>;
type Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;

/** The consumers of one ingestion: the web tools tab of the owner, the OBS dock and the two OBS outputs. */
export type Consumer = "owner" | "dock" | "horizontal" | "vertical";
export const CONSUMERS: readonly Consumer[] = ["owner", "dock", "horizontal", "vertical"];

/** The identity headers that the Worker sets after its checks. The harness sets them itself. */
const IDENTITY: Readonly<Record<Consumer, Record<string, string>>> = {
  owner: { "X-SB-Owner": "1" },
  dock: { "X-SB-Dock": "1" },
  horizontal: { "X-SB-Overlay": "horizontal" },
  vertical: { "X-SB-Overlay": "vertical" },
};

const ORIGIN = "https://capacity.test";
const EVENTSUB_SECRET = "capacity-eventsub-secret-0123456789abcdef";
const TOKEN_KEYS = `k1:${btoa(String.fromCodePoint(...new Uint8Array(32).fill(7)))}`;
const MESSAGE_TIMEOUT_MS = 10_000;

/** One page with its connected channels. */
export interface Page {
  id: string;
  /** The Twitch channel id, when the page has a Twitch connection. */
  twitch: string | null;
  /** The YouTube channel id, when the page has a YouTube connection. */
  youtube: string | null;
}

interface Snapshot {
  type: "snapshot";
  events: ActivityChat[];
}

type Incoming =
  | Snapshot
  | { type: "event"; event: { kind: string; id?: string; platform?: string; messageId?: string } }
  | { type: "unavailable" };

/** One open activity socket and what it received. */
export interface ActivityClient {
  page: Page;
  consumer: Consumer;
  socket: Socket;
  /** Milliseconds from the subscribe call to the snapshot. */
  snapshotMs: number;
  snapshots: Snapshot[];
  /** Received chat events, deletions and status events. */
  counts: { chat: number; moderation: number; status: number };
  /** Milliseconds from the send of a delivery to its event on this socket, for each timed delivery. */
  chatMs: number[];
  moderationMs: number[];
}

export interface Percentiles {
  p50: number;
  p95: number;
  max: number;
}

export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) throw new Error("No samples to measure");
  const sorted: number[] = [...values].sort((a: number, b: number): number => a - b);
  const at = (fraction: number): number =>
    Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
}

export class ActivityHarness {
  private nextPage = 0;
  private nextDelivery = 0;
  /** When each timed delivery left the test, by the key of its event. */
  private readonly sentAt = new Map<string, number>();
  readonly clients: ActivityClient[] = [];

  private constructor(
    private readonly runtime: Miniflare,
    private readonly database: Database,
    /** The fake providers: tests script their answers and read their calls. */
    readonly providers: FakeProviders,
  ) {}

  static async start(): Promise<ActivityHarness> {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("activity-worker.ts", import.meta.url))],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      target: "es2022",
      external: ["cloudflare:workers", "node:*"],
    });
    const { fake, fetch } = fakeProviders();
    const runtime = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-05-15",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { CHANNEL_INGEST: { className: "CapacityIngest", useSQLite: true } },
      d1Databases: { DB: "activity-capacity" },
      bindings: {
        APP_ORIGIN: ORIGIN,
        BETTER_AUTH_SECRET: "x".repeat(40),
        TWITCH_CLIENT_ID: "twitch-client",
        TWITCH_CLIENT_SECRET: "twitch-secret",
        TWITCH_EVENTSUB_SECRET: EVENTSUB_SECRET,
        GOOGLE_CLIENT_ID: "google-client",
        GOOGLE_CLIENT_SECRET: "google-secret",
        CHANNEL_TOKEN_KEYS: TOKEN_KEYS,
      },
      outboundService: (request: RuntimeRequest): Promise<RuntimeResponse> => providerAnswer(fetch, request),
    });
    try {
      const database: Database = await runtime.getD1Database("DB");
      await applyMigrations(database, await migrationFiles());
      return new ActivityHarness(runtime, database, fake);
    } catch (error: unknown) {
      await runtime.dispose();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    try {
      this.closeClients();
    } finally {
      await this.runtime.dispose();
    }
  }

  /** Closes the open sockets of a page, or of every page. */
  closeClients(page?: Page): void {
    for (const client of this.clients.filter((item: ActivityClient): boolean => !page || item.page === page)) {
      if (client.socket.readyState === 1) client.socket.close(1000, "Scenario complete");
      this.clients.splice(this.clients.indexOf(client), 1);
    }
  }

  /** Requests the Worker sent to a provider since the start. */
  providerCalls(): number {
    return this.providers.calls.length;
  }

  /** A new page with an owner and the given channels. `tokenExpiresAt` is for the YouTube access token. */
  async addPage(channels: { twitch?: boolean; youtube?: boolean; tokenExpiresAt?: number }): Promise<Page> {
    const index: number = this.nextPage++;
    const id: string = crypto.randomUUID();
    const page: Page = {
      id,
      twitch: channels.twitch ? String(100_000 + index) : null,
      youtube: channels.youtube ? `UCcapacity${index}` : null,
    };
    const db: Database = this.database;
    const connection = (platform: "twitch" | "youtube", externalId: string): D1PreparedStatement =>
      db
        .prepare(
          `INSERT INTO channel_connections
            (id,streamer_id,platform,external_id,display_name,scopes,status,created_at,updated_at)
            VALUES (?,?,?,?,'Host','','active',1,1)`,
        )
        .bind(`${platform}-${index}`, id, platform, externalId);
    const statements: D1PreparedStatement[] = [
      db
        .prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,'O',?,1,1,1)")
        .bind(`owner-${index}`, `owner-${index}@capacity.test`),
      db
        .prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,?,?,'Host')")
        .bind(id, `owner-${index}`, `capacity_${index}`),
    ];
    if (page.twitch) {
      statements.push(connection("twitch", page.twitch));
      // A connect made the subscriptions of a connected channel. The fake holds them as Twitch does.
      for (const type of requiredSubscriptions("twitch"))
        this.providers.subscriptions.push({
          platform: "twitch",
          id: `capacity-sub-${index}-${type}`,
          broadcaster: page.twitch,
          callback: `${ORIGIN}/hooks/twitch`,
          type,
        });
    }
    if (page.youtube) {
      const env = { DB: db, CHANNEL_TOKEN_KEYS: TOKEN_KEYS } as Partial<AppEnv> as AppEnv;
      const tokens = {
        accessToken: "youtube-stored-access",
        refreshToken: "youtube-stored-refresh",
        expiresAt: channels.tokenExpiresAt ?? Date.now() + 3_600_000,
      };
      statements.push(
        connection("youtube", page.youtube),
        await tokenStatement(env, `youtube-${index}`, "youtube", tokens, 100),
      );
    }
    await db.batch(statements);
    return page;
  }

  /** Opens an activity socket and waits for its snapshot. Without `timed`, the socket only counts events. */
  async listen(page: Page, consumer: Consumer, timed: boolean = true): Promise<ActivityClient> {
    const start: number = performance.now();
    const response = await this.runtime.dispatchFetch(`${ORIGIN}/${page.id}/subscribe`, {
      headers: { Upgrade: "websocket", ...IDENTITY[consumer] },
    });
    if (!response.webSocket) throw new Error(`Subscribe refused with status ${response.status}`);
    const client: ActivityClient = {
      page,
      consumer,
      socket: response.webSocket,
      snapshotMs: 0,
      snapshots: [],
      counts: { chat: 0, moderation: 0, status: 0 },
      chatMs: [],
      moderationMs: [],
    };
    await new Promise<void>((resolve, reject): void => {
      const timeout = setTimeout((): void => reject(new Error("Snapshot timed out")), MESSAGE_TIMEOUT_MS);
      client.socket.addEventListener("message", (event: { data: unknown }): void => {
        const first: boolean = client.snapshots.length === 0;
        this.receive(client, JSON.parse(String(event.data)) as Incoming, timed);
        if (!first || client.snapshots.length === 0) return;
        client.snapshotMs = performance.now() - start;
        clearTimeout(timeout);
        resolve();
      });
      client.socket.accept();
    });
    this.clients.push(client);
    return client;
  }

  private receive(client: ActivityClient, message: Incoming, timed: boolean): void {
    if (message.type === "snapshot") client.snapshots.push(message);
    if (message.type !== "event") return;
    const { kind, id, platform, messageId } = message.event;
    if (kind === "status") {
      client.counts.status += 1;
      return;
    }
    const chat: boolean = kind === "chat";
    client.counts[chat ? "chat" : "moderation"] += 1;
    if (!timed) return;
    const sent: number | undefined = this.sentAt.get(chat ? String(id) : `delete:${platform}:${messageId}`);
    if (sent !== undefined) (chat ? client.chatMs : client.moderationMs).push(performance.now() - sent);
  }

  /** One signed Twitch EventSub notification, as Twitch sends it to the Worker. Returns the HTTP status. */
  private async notify(page: Page, type: string, event: Record<string, unknown>, at: number): Promise<number> {
    if (!page.twitch) throw new Error("The page has no Twitch channel");
    const body: string = JSON.stringify({
      subscription: { type, condition: { broadcaster_user_id: page.twitch } },
      event,
    });
    const id: string = `capacity-${this.nextDelivery++}`;
    const timestamp: string = new Date(at).toISOString();
    const signature: string = createHmac("sha256", EVENTSUB_SECRET)
      .update(id + timestamp + body)
      .digest("hex");
    const response = await this.runtime.dispatchFetch(`${ORIGIN}/hooks/twitch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Twitch-Eventsub-Message-Id": id,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": `sha256=${signature}`,
        "Twitch-Eventsub-Message-Type": "notification",
      },
      body,
    });
    await response.arrayBuffer();
    return response.status;
  }

  /** One Twitch chat message through the webhook. `at` is the time of a set clock; the default is now. */
  chat(page: Page, messageId: string, at: number = Date.now()): Promise<number> {
    this.sentAt.set(`twitch:${messageId}`, performance.now());
    return this.notify(
      page,
      "channel.chat.message",
      {
        broadcaster_user_id: page.twitch,
        chatter_user_id: "200",
        chatter_user_login: "viewer",
        chatter_user_name: "Viewer",
        message_id: messageId,
        message: { text: `hello ${messageId}`, fragments: [{ type: "text", text: `hello ${messageId}` }] },
        badges: [],
      },
      at,
    );
  }

  /** One Twitch message deletion (a moderation event) through the webhook. */
  remove(page: Page, messageId: string, at: number = Date.now()): Promise<number> {
    this.sentAt.set(`delete:twitch:${messageId}`, performance.now());
    return this.notify(page, "channel.chat.message_delete", { message_id: messageId }, at);
  }

  private async json<T>(path: string): Promise<T> {
    const response = await this.runtime.dispatchFetch(`${ORIGIN}/${path}`, { method: "POST" });
    if (response.status !== 200) throw new Error(`Harness call ${path} answered ${response.status}`);
    return (await response.json()) as T;
  }

  report(page: Page): Promise<IngestReport> {
    return this.json<IngestReport>(`${page.id}/capacity-report`);
  }

  workerReport(): Promise<WorkerReport> {
    return this.json<WorkerReport>("worker-report");
  }

  /** Sets the clock of the Worker to `at` (null: real time) and runs the alarms of the page that are due then. */
  step(page: Page, at: number | null): Promise<StepReport> {
    return this.json<StepReport>(`${page.id}/capacity-step${at === null ? "" : `?at=${at}`}`);
  }

  /** The YouTube quota units that a page spent on a quota day. */
  async quotaUnits(page: Page, day: string): Promise<number> {
    const count: number | null = await this.database
      .prepare("SELECT count FROM app_rate_limits WHERE key=?")
      .bind(`youtube-quota:${day}:${page.id}`)
      .first<number>("count");
    return count ?? 0;
  }

  /** The stored status and status code of a connection. */
  async connectionStatus(page: Page, platform: "twitch" | "youtube"): Promise<string> {
    const row = await this.database
      .prepare("SELECT status, status_code FROM channel_connections WHERE streamer_id=? AND platform=?")
      .bind(page.id, platform)
      .first<{ status: string; status_code: string | null }>();
    if (!row) throw new Error(`No ${platform} connection`);
    return row.status_code ? `${row.status}:${row.status_code}` : row.status;
  }
}

/** Answers a provider request of the Worker with the fake providers. */
async function providerAnswer(fetch: ProviderFetch, request: RuntimeRequest): Promise<RuntimeResponse> {
  const body: string = await request.text();
  const answer: Response = await fetch(request.url, {
    method: request.method,
    headers: [...request.headers],
    ...(body === "" ? {} : { body }),
  });
  const text: string = await answer.text();
  return new RuntimeResponse(text === "" ? null : text, { status: answer.status, headers: [...answer.headers] });
}
