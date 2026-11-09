import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../app/env";
import {
  AI_INTEREST_LIMIT_KEY,
  aiInterestStatus,
  interestDay,
  pruneAiInterest,
  recordAiInterest,
  visitorHash,
} from "../app/server/ai.server";
import { visitorPrefix } from "../app/server/ip-prefix";
import { action } from "../app/routes/api";
import { cleanExpiredData } from "../app/server/cleanup.server";
import { apiCaller } from "./helpers/api";
import { applyMigrations, createTestDatabase, migrationFiles, type TestDatabase } from "./helpers/database";

const ORIGIN = "https://streambullets.test";
const SALT = "test-salt-0123456789abcdef";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 7, 12);

let database: TestDatabase;
let env: AppEnv;
/** REQUEST_LIMITER keys seen, and whether the stub lets the next request through. */
let limiterKeys: string[] = [];
let limiterOpen = true;

function visitor(ip: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/ai-interest`, { headers: { "CF-Connecting-IP": ip, ...headers } });
}

async function rows(): Promise<{ day: string; ip_hash: string; value: number }[]> {
  const result = await database.db
    .prepare("SELECT day, ip_hash, value FROM ai_interest ORDER BY day, ip_hash")
    .all<{ day: string; ip_hash: string; value: number }>();
  return result.results;
}

beforeAll(async () => {
  database = await createTestDatabase();
  env = {
    DB: database.db,
    APP_ORIGIN: ORIGIN,
    AI_INTEREST_SALT: SALT,
    BETTER_AUTH_SECRET: "x".repeat(32),
    REQUEST_LIMITER: {
      limit: async ({ key }: { key: string }): Promise<{ success: boolean }> => {
        limiterKeys.push(key);
        return { success: limiterOpen };
      },
    },
  } as AppEnv;
});

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  limiterKeys = [];
  limiterOpen = true;
  await database.db.batch([
    database.db.prepare("DELETE FROM ai_interest"),
    database.db.prepare("DELETE FROM ai_interest_daily"),
  ]);
});

describe("AI interest counter", () => {
  it("keys each visitor by a salted hash of IP and day, never the IP itself", async () => {
    const hash: string = await visitorHash(SALT, "203.0.113.7", "2026-11-07");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("203.0.113.7");
    expect(await visitorHash(SALT, "203.0.113.7", "2026-11-08")).not.toBe(hash);
    expect(await visitorHash("another-salt-0123456789", "203.0.113.7", "2026-11-07")).not.toBe(hash);
    await recordAiInterest(env, visitor("203.0.113.7"), "up", NOW);
    const [row] = await rows();
    expect(row).toEqual({ day: "2026-11-07", ip_hash: hash, value: 1 });
  });

  it("counts one vote per visitor per day", async () => {
    expect(await recordAiInterest(env, visitor("198.51.100.1"), "up", NOW)).toEqual({
      counted: true,
      totals: { up: 1, down: 0 },
    });
    // The same visitor later that day, even with the other vote, changes nothing.
    expect(await recordAiInterest(env, visitor("198.51.100.1"), "down", NOW + 3_600_000)).toEqual({
      counted: false,
      totals: { up: 1, down: 0 },
    });
    expect(await recordAiInterest(env, visitor("198.51.100.2"), "down", NOW)).toEqual({
      counted: true,
      totals: { up: 1, down: 1 },
    });
    // The next day the first visitor may vote again.
    expect((await recordAiInterest(env, visitor("198.51.100.1"), "down", NOW + DAY)).totals).toEqual({
      up: 1,
      down: 2,
    });
    expect(await rows()).toHaveLength(3);
  });

  it("reports this visitor's vote today and the totals", async () => {
    await recordAiInterest(env, visitor("192.0.2.5"), "down", NOW);
    expect(await aiInterestStatus(env, visitor("192.0.2.5"), NOW)).toEqual({
      available: true,
      totals: { up: 0, down: 1 },
      mine: "down",
    });
    expect((await aiInterestStatus(env, visitor("192.0.2.6"), NOW)).mine).toBeNull();
    expect((await aiInterestStatus(env, visitor("192.0.2.5"), NOW + DAY)).mine).toBeNull();
  });

  it("is off without the AI_INTEREST_SALT secret", async () => {
    const off = { ...env, AI_INTEREST_SALT: undefined } as AppEnv;
    expect(await aiInterestStatus(off, visitor("192.0.2.5"), NOW)).toEqual({
      available: false,
      totals: { up: 0, down: 0 },
      mine: null,
    });
    await expect(recordAiInterest(off, visitor("192.0.2.5"), "up", NOW)).rejects.toMatchObject({ status: 503 });
    await expect(
      recordAiInterest({ ...env, AI_INTEREST_SALT: "short" } as AppEnv, visitor("192.0.2.5"), "up", NOW),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("forgets votes after 30 days, in the hourly cleanup", async () => {
    for (const age of [0, 29, 30, 31, 45]) await recordAiInterest(env, visitor(`10.0.0.${age}`), "up", NOW - age * DAY);
    await env.DB.batch(pruneAiInterest(env, NOW));
    expect((await rows()).map((row) => row.day)).toEqual([
      interestDay(NOW - 30 * DAY),
      interestDay(NOW - 29 * DAY),
      "2026-11-07",
    ]);
    await cleanExpiredData(env, NOW + DAY);
    expect((await rows()).map((row) => row.day)).toEqual([interestDay(NOW - 29 * DAY), "2026-11-07"]);
  });
});

describe("AI interest counter abuse (security review finding 3)", () => {
  it("reduces an IPv6 address to its /64 and leaves IPv4 alone", () => {
    expect(visitorPrefix("203.0.113.7")).toBe("203.0.113.7");
    expect(visitorPrefix("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(visitorPrefix("2001:0DB8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(visitorPrefix("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(visitorPrefix("::1")).toBe("0:0:0:0::/64");
    expect(visitorPrefix("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(visitorPrefix("2001:db8:1:2:3:4:192.0.2.1")).toBe("2001:db8:1:2::/64");
    expect(visitorPrefix("::ffff:192.0.2.1")).toBe("192.0.2.1");
    // An IPv4-mapped address counts as its IPv4 address in every spelling, not as the shared ::/64.
    expect(visitorPrefix("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(visitorPrefix("::FFFF:C000:0201")).toBe("192.0.2.1");
    expect(visitorPrefix("0:0:0:0:0:ffff:c000:201")).toBe("192.0.2.1");
    expect(visitorPrefix("0:0:0:0:0:ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(visitorPrefix("::ffff:7f00:1")).not.toBe(visitorPrefix("::ffff:7f00:2"));
    // Not an address: unchanged.
    for (const value of [
      "local",
      "1:2:3",
      "1::2::3",
      "1:2:3:4:5:6:7:8::",
      "zz::1",
      "1:2:3:4:5:6:7:8:9",
      "::ffff:192.0.2.999",
    ])
      expect([value, visitorPrefix(value)]).toEqual([value, value]);
  });

  it("counts one vote per IPv6 /64 per day, however many addresses it uses", async () => {
    for (let host = 1; host <= 20; host += 1)
      await recordAiInterest(env, visitor(`2001:db8:aa:bb::${host.toString(16)}`), "up", NOW);
    expect(await rows()).toHaveLength(1);
    expect((await recordAiInterest(env, visitor("2001:db8:aa:bc::1"), "up", NOW)).totals).toEqual({ up: 2, down: 0 });
    expect((await aiInterestStatus(env, visitor("2001:db8:aa:bb:ffff::9"), NOW)).mine).toBe("up");
    // Every address of one /64 shares one rate-limit key, and the key never holds the address.
    expect(new Set(limiterKeys.slice(0, 20)).size).toBe(1);
    expect(limiterKeys[0]).toMatch(new RegExp(`^${AI_INTEREST_LIMIT_KEY}:[0-9a-f]{64}$`));
    expect(limiterKeys[20]).not.toBe(limiterKeys[0]);
  });

  it("refuses a vote over the per-network limit and stores nothing", async () => {
    limiterOpen = false;
    await expect(recordAiInterest(env, visitor("2001:db8::5"), "up", NOW)).rejects.toMatchObject({ status: 429 });
    expect(await rows()).toEqual([]);
    expect((await aiInterestStatus(env, visitor("2001:db8::5"), NOW)).totals).toEqual({ up: 0, down: 0 });
  });

  it("reads the totals from the running daily counts, not from every vote", async () => {
    await recordAiInterest(env, visitor("192.0.2.1"), "up", NOW);
    await recordAiInterest(env, visitor("192.0.2.2"), "down", NOW - DAY);
    await recordAiInterest(env, visitor("192.0.2.2"), "up", NOW - DAY);
    const daily = await env.DB.prepare("SELECT day, up, down FROM ai_interest_daily ORDER BY day").all();
    expect(daily.results).toEqual([
      { day: interestDay(NOW - DAY), up: 0, down: 1 },
      { day: interestDay(NOW), up: 1, down: 0 },
    ]);
    // A vote row with no running count does not show: the totals never scan ai_interest.
    await env.DB.prepare("INSERT INTO ai_interest (day, ip_hash, value) VALUES (?, ?, 1)")
      .bind(interestDay(NOW), "f".repeat(64))
      .run();
    expect((await aiInterestStatus(env, visitor("192.0.2.9"), NOW)).totals).toEqual({ up: 1, down: 1 });
    // Days the cron has not pruned yet still drop out of the totals after 30 days.
    expect((await aiInterestStatus(env, visitor("192.0.2.9"), NOW + 30 * DAY)).totals).toEqual({ up: 1, down: 0 });
    await env.DB.batch(pruneAiInterest(env, NOW + 31 * DAY));
    expect((await env.DB.prepare("SELECT count(*) AS n FROM ai_interest_daily").first<{ n: number }>())?.n).toBe(0);
  });

  it("migrates the votes already stored into the daily counts", async () => {
    const fresh: TestDatabase = await createTestDatabase({ migrate: false });
    try {
      const files: string[] = await migrationFiles();
      await applyMigrations(
        fresh.db,
        files.filter((file: string): boolean => file < "0015"),
      );
      await fresh.db
        .prepare(
          "INSERT INTO ai_interest (day, ip_hash, value) VALUES ('2026-11-01', ?1, 1), ('2026-11-01', ?2, -1), ('2026-11-01', ?3, 1), ('2026-11-02', ?1, -1)",
        )
        .bind("a".repeat(64), "b".repeat(64), "c".repeat(64))
        .run();
      await applyMigrations(
        fresh.db,
        files.filter((file: string): boolean => file.startsWith("0015")),
      );
      const daily = await fresh.db.prepare("SELECT day, up, down FROM ai_interest_daily ORDER BY day").all();
      expect(daily.results).toEqual([
        { day: "2026-11-01", up: 2, down: 1 },
        { day: "2026-11-02", up: 0, down: 1 },
      ]);
    } finally {
      await fresh.dispose();
    }
  });
});

describe("POST /api/ai-interest", () => {
  const api = apiCaller(() => env, ORIGIN, "x".repeat(32));

  /** A POST with exactly these headers (the helper adds this site's Origin, which agents do not send). */
  async function post(headers: Record<string, string>, body: unknown = { vote: "up" }): Promise<Response> {
    const request = new Request(`${ORIGIN}/api/ai-interest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return action({
      request,
      params: { "*": "ai-interest" },
      context: api.context(),
      url: new URL(request.url),
      pattern: "/api/*",
    } as Parameters<typeof action>[0]);
  }

  it("takes a signed-out vote from this site", async () => {
    const response: Response = await api.call("POST", "ai-interest", { body: { vote: "down", agent: "test/1.0" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ counted: true, totals: { up: 0, down: 1 } });
    const status: Response = await api.call("GET", "ai-interest");
    expect(await status.json()).toEqual({ available: true, totals: { up: 0, down: 1 }, mine: "down" });
  });

  it("takes a vote from a client without an Origin header, such as an agent", async () => {
    const response: Response = await post({ "CF-Connecting-IP": "203.0.113.50" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { counted: boolean }).counted).toBe(true);
  });

  it("refuses browsers on other sites and bad bodies", async () => {
    expect((await post({ Origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post({}, { vote: "maybe" })).status).toBe(400);
    expect((await post({}, { vote: "up", extra: 1 })).status).toBe(400);
    expect((await api.call("POST", "ai-interest?x=1", { body: { vote: "up" } })).status).toBe(400);
  });
});
