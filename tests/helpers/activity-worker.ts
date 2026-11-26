import type { AppEnv } from "../../app/env";
import { ChannelIngest } from "../../app/server/channel-ingest";
import { twitchWebhook } from "../../app/server/channel-webhooks.server";
import { HttpError } from "../../app/server/http.server";

/**
 * The Worker of the activity capacity harness (tests/activity-capacity.test.ts). esbuild bundles this file for
 * Miniflare; nothing imports it in production. It hosts the real ChannelIngest object and the real Twitch webhook,
 * and adds what only a measurement needs: counters, a storage report and a clock that the test can set.
 */

/** What one ingest object did since it started. */
export interface IngestCounts {
  /** Requests the object received: deliveries, subscribes and status calls. */
  requests: number;
  /** Alarm runs. */
  alarms: number;
  /** D1 statements the object executed. */
  d1Statements: number;
}

/** The counters of one ingest object and the size of its storage. */
export interface IngestReport extends IngestCounts {
  /** Open activity sockets. */
  sockets: number;
  /** Rows in the snapshot table. */
  events: number;
  /** Rows in the table of delivery ids, message ids and ban keys. */
  seen: number;
  /** Message ids in `seen`: one for each chat message that passed admission in the last 15 minutes. */
  chatIds: number;
  /** Rows in the table of deleted message ids. */
  deleted: number;
  /** Bytes of the object's SQLite database. */
  databaseBytes: number;
  /** The time of the next alarm, or null. */
  alarmAt: number | null;
}

/** What the stateless Worker of the harness did since it started. */
export interface WorkerReport {
  /** Webhook requests the Worker received. */
  webhooks: number;
  /** D1 statements the Worker executed for webhooks. */
  d1Statements: number;
}

/** The answer of a clock step: how many alarms it ran. */
export interface StepReport {
  alarms: number;
}

// The clock of the bundle. A set time stands still, so a scenario of several hours gives the same rows each run.
let fixedNow: number | null = null;
const realNow: () => number = Date.now.bind(Date);
Date.now = (): number => fixedNow ?? realNow();

/** A step runs at most this many due alarms, so a poll that is always due cannot hold a request. */
const MAX_ALARMS_PER_STEP = 5;
const EXECUTORS: ReadonlySet<string | symbol> = new Set(["all", "first", "run", "raw"]);
const workerCounts: WorkerReport = { webhooks: 0, d1Statements: 0 };

function countedStatement(raw: D1PreparedStatement, counts: { d1Statements: number }): D1PreparedStatement {
  return new Proxy(raw, {
    get(target: D1PreparedStatement, key: string | symbol): unknown {
      if (key === "bind")
        return (...values: unknown[]): D1PreparedStatement => countedStatement(target.bind(...values), counts);
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (EXECUTORS.has(key)) counts.d1Statements += 1;
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/** D1 with a count of each executed statement. A batch counts each of its statements. */
function countedDatabase(db: D1Database, counts: { d1Statements: number }): D1Database {
  return new Proxy(db, {
    get(target: D1Database, key: string | symbol): unknown {
      if (key === "prepare") return (query: string): D1PreparedStatement => countedStatement(target.prepare(query), counts);
      if (key === "batch")
        return (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
          counts.d1Statements += statements.length;
          return target.batch(statements);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? (...args: unknown[]): unknown => Reflect.apply(value, target, args) : value;
    },
  });
}

export class CapacityIngest extends ChannelIngest {
  private readonly measured: IngestCounts;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    const counts: IngestCounts = { requests: 0, alarms: 0, d1Statements: 0 };
    super(ctx, { ...env, DB: countedDatabase(env.DB, counts) });
    this.measured = counts;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/capacity-report") return Response.json(await this.report());
    if (url.pathname === "/capacity-step") return Response.json(await this.step(url.searchParams.get("at")));
    this.measured.requests += 1;
    return super.fetch(request);
  }

  override async alarm(): Promise<void> {
    this.measured.alarms += 1;
    await super.alarm();
  }

  private count(query: string): number {
    return this.ctx.storage.sql.exec<{ n: number }>(query).one().n;
  }

  private async report(): Promise<IngestReport> {
    return {
      ...this.measured,
      sockets: this.ctx.getWebSockets("activity").length,
      events: this.count("SELECT count(*) AS n FROM events"),
      seen: this.count("SELECT count(*) AS n FROM seen"),
      chatIds: this.count("SELECT count(*) AS n FROM seen WHERE key LIKE 'message:%'"),
      deleted: this.count("SELECT count(*) AS n FROM deleted"),
      databaseBytes: this.ctx.storage.sql.databaseSize,
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }

  /** Sets the clock (`at`), or returns it to real time (no `at`), and runs the alarms that are due then. */
  private async step(at: string | null): Promise<StepReport> {
    fixedNow = at === null ? null : Number(at);
    let alarms = 0;
    while (alarms < MAX_ALARMS_PER_STEP) {
      const due: number | null = await this.ctx.storage.getAlarm();
      if (due === null || due > Date.now()) break;
      // The runtime clears an alarm before it runs the handler.
      await this.ctx.storage.deleteAlarm();
      await this.alarm();
      alarms += 1;
    }
    return { alarms };
  }
}

async function webhook(request: Request, env: AppEnv): Promise<Response> {
  workerCounts.webhooks += 1;
  try {
    return await twitchWebhook(request, { ...env, DB: countedDatabase(env.DB, workerCounts) });
  } catch (error: unknown) {
    if (error instanceof HttpError) return new Response(null, { status: error.status });
    throw error;
  }
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/hooks/twitch") return webhook(request, env);
    if (url.pathname === "/worker-report") return Response.json(workerCounts);
    const [, page, path] = url.pathname.split("/");
    url.pathname = `/${path}`;
    url.searchParams.set("streamerId", page);
    return env.CHANNEL_INGEST.get(env.CHANNEL_INGEST.idFromName(page)).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<AppEnv>;
