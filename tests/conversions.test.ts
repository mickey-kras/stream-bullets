import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import { trackCta } from "../app/lib/conversions";
import { conversionRoutes } from "../app/server/api/conversions";
import { dispatch } from "../app/server/api/router";
import { cleanExpiredData } from "../app/server/cleanup.server";
import { apiCaller } from "./helpers/api";
import { applyMigrations, createTestDatabase, migrationFiles, type TestDatabase } from "./helpers/database";

let database: TestDatabase;
let env: AppEnv;
const secret = "conversion-test-secret-at-least-32-characters";
const { call } = apiCaller(() => env, "https://example.test", secret);
const run = async (sql: string): Promise<void> => {
  await database.db.prepare(sql).run();
};
const totals = async (): Promise<Record<string, number>> => {
  const rows = await database.db
    .prepare("SELECT event,sum(count) AS n FROM conversion_daily GROUP BY event")
    .all<{ event: string; n: number }>();
  return Object.fromEntries(rows.results.map((row) => [row.event, row.n]));
};

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
  env = { DB: database.db, APP_ORIGIN: "https://example.test", BETTER_AUTH_SECRET: secret } as AppEnv;
  const files = await migrationFiles();
  await applyMigrations(
    database.db,
    files.filter((file) => file < "0022"),
  );
  await run(
    "INSERT INTO user(id,name,email,created_at,updated_at) VALUES ('old','Old','old@example.test',1,1),('new','New','new@example.test',1,1)",
  );
  await run(
    "INSERT INTO streamers(id,owner_id,handle,name,about,avatar,background) VALUES ('page','old','example','Example','',NULL,NULL)",
  );
  await run(
    "INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at) VALUES ('poll','page','old','choice','Poll','','','[\"A\",\"B\"]',1),('old-topic','page','old','topic','Topic','','','[]',1)",
  );
  await run("INSERT INTO entry_votes(entry_id,user_id,choice) VALUES ('poll','old',0)");
  await applyMigrations(
    database.db,
    files.filter((file) => file >= "0022"),
  );
});
afterAll(async () => {
  await database.dispose();
});

describe("anonymous conversion totals", () => {
  it("backfills milestone flags without counting historical activity", async () => {
    expect(await totals()).toEqual({});
    expect(
      await database.db.prepare("SELECT first_vote_counted,first_topic_counted FROM user WHERE id='old'").first(),
    ).toEqual({ first_vote_counted: 1, first_topic_counted: 1 });
  });

  it("counts first votes and topics once, including after deletion and concurrent retries", async () => {
    const vote =
      "INSERT INTO entry_votes(entry_id,user_id,choice) VALUES ('poll','new',1) ON CONFLICT(entry_id,user_id) DO UPDATE SET choice=excluded.choice";
    await Promise.all([run(vote), run(vote)]);
    await run("DELETE FROM entry_votes WHERE user_id='new'");
    await run(vote);
    const topic =
      "INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at) VALUES ('new-topic','page','new','topic','Private title','','','[]',1)";
    await run(topic);
    await run("DELETE FROM entries WHERE id='new-topic'");
    await run(topic);
    expect(await totals()).toEqual({ first_topic: 1, first_vote: 1 });
    const before = await totals();
    await expect(
      database.db.batch([
        database.db.prepare(
          "INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES ('rollback','rollback','new',2,1,1)",
        ),
        database.db.prepare(
          "INSERT INTO user(id,name,email,created_at,updated_at) VALUES ('new','Duplicate','duplicate@example.test',1,1)",
        ),
      ]),
    ).rejects.toThrow();
    expect(await totals()).toEqual(before);
  });

  it("counts session creation and first applications, not session refreshes or application edits", async () => {
    await run(
      "INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES ('signin','signin','new',2,1,1)",
    );
    await run("UPDATE session SET updated_at=2 WHERE id='signin'");
    await run(
      "INSERT INTO streamer_applications(id,user_id,links,note,status,created_at,updated_at) VALUES ('application','new','[\"https://twitch.tv/example\"]','','pending',1,1)",
    );
    await run("UPDATE streamer_applications SET note='Private note',updated_at=2 WHERE id='application'");
    expect(await totals()).toMatchObject({ sign_in_completed: 1, streamer_application: 1 });
    const columns = await database.db.prepare("PRAGMA table_info(conversion_daily)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(["day", "event", "count"]);
  });

  it("accepts only anonymous CTA labels and deduplicates receipt IDs", async () => {
    const body = { id: crypto.randomUUID(), event: "cta_browse" };
    const responses = await Promise.all([call("POST", "conversions", { body }), call("POST", "conversions", { body })]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const results: { counted: boolean }[] = await Promise.all(
      responses.map(async (response) => (await response.json()) as { counted: boolean }),
    );
    expect(results.filter((result) => result.counted)).toHaveLength(1);
    expect(await totals()).toMatchObject({ cta_browse: 1 });
    for (const invalid of [
      { ...body, event: "sign_in_completed" },
      { ...body, email: "private@example.test" },
      { ...body, id: "invalid" },
    ]) {
      expect((await call("POST", "conversions", { body: invalid })).status).toBe(400);
    }
    expect(await totals()).toMatchObject({ cta_browse: 1 });
    const blocked = await dispatch(
      conversionRoutes,
      new Request("https://example.test/api/conversions", {
        method: "POST",
        headers: { Origin: "https://other.test" },
        body: JSON.stringify(body),
      }),
      { env, nonce: "test", responseHeaders: new Headers() },
      "conversions",
    );
    expect(blocked.status).toBe(403);
  });

  it("expires receipts and old aggregate days", async () => {
    await run("INSERT INTO conversion_daily(day,event,count) VALUES ('2000-01-01','cta_vote',1)");
    await run("UPDATE conversion_clicks SET created_at=1");
    await cleanExpiredData(env, Date.now());
    expect(await database.db.prepare("SELECT count(*) AS n FROM conversion_clicks").first("n")).toBe(0);
    expect(
      await database.db.prepare("SELECT count(*) AS n FROM conversion_daily WHERE day='2000-01-01'").first("n"),
    ).toBe(0);
    expect(await totals()).toMatchObject({ first_topic: 1, first_vote: 1, cta_browse: 1 });
  });
});

it("sends only a fixed label and fresh receipt, and never blocks navigation on failure", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", fetch);
  try {
    trackCta("cta_browse");
    trackCta("cta_browse");
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = fetch.mock.calls[0];
    expect(first[0]).toBe("/api/conversions");
    expect(first[1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", keepalive: true });
    const one = JSON.parse(first[1]!.body as string) as { event: string; id: string };
    const two = JSON.parse(fetch.mock.calls[1][1]!.body as string) as { event: string; id: string };
    expect(Object.keys(one)).toEqual(["event", "id"]);
    expect(one.event).toBe("cta_browse");
    expect(one.id).not.toBe(two.id);
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    trackCta("cta_vote");
    await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
    fetch.mockRejectedValueOnce(new Error("offline"));
    trackCta("cta_vote");
    await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(2));
  } finally {
    vi.unstubAllGlobals();
    warning.mockRestore();
  }
});
