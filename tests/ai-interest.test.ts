import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../app/env";
import { aiInterestStatus, interestDay, pruneAiInterest, recordAiInterest, visitorHash } from "../app/server/ai.server";
import { action } from "../app/routes/api";
import { cleanExpiredData } from "../app/server/cleanup.server";
import { apiCaller } from "./helpers/api";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const ORIGIN = "https://streambullets.test";
const SALT = "test-salt-0123456789abcdef";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 7, 12);

let database: TestDatabase;
let env: AppEnv;

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
  env = { DB: database.db, APP_ORIGIN: ORIGIN, AI_INTEREST_SALT: SALT, BETTER_AUTH_SECRET: "x".repeat(32) } as AppEnv;
});

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  await database.db.prepare("DELETE FROM ai_interest").run();
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
    await pruneAiInterest(env, NOW).run();
    expect((await rows()).map((row) => row.day)).toEqual([
      interestDay(NOW - 30 * DAY),
      interestDay(NOW - 29 * DAY),
      "2026-11-07",
    ]);
    await cleanExpiredData(env, NOW + DAY);
    expect((await rows()).map((row) => row.day)).toEqual([interestDay(NOW - 29 * DAY), "2026-11-07"]);
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
