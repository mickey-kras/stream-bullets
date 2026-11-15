import { z } from "zod";
import type { AppEnv } from "../env";
import { HttpError } from "./http.server";
import { visitorPrefix } from "./ip-prefix";

// Cron prunes votes after 30 days.
export const AI_INTEREST_RETENTION_DAYS = 30;

// `POST /api/ai-interest`. `agent` is the caller's own name for itself; it is not stored.
export const aiInterestSchema = z
  .object({ vote: z.enum(["up", "down"]), agent: z.string().max(100).optional() })
  .strict();

export interface AiInterestTotals {
  up: number;
  down: number;
}

export interface AiInterestStatus {
  // No `AI_INTEREST_SALT` disables the counter and buttons.
  available: boolean;
  totals: AiInterestTotals;
  // This visitor's vote today, or null.
  mine: "up" | "down" | null;
}

// The UTC day of `now`, as stored in `ai_interest.day`.
export function interestDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function salt(env: AppEnv): string | null {
  const value: string | undefined = env.AI_INTEREST_SALT;
  return value && value.length >= 16 ? value : null;
}

// HMAC-SHA-256 the UTC day and IPv4/IPv6 /64 with `AI_INTEREST_SALT`. Store no raw addresses or cross-day
// identifiers.
export async function visitorHash(secret: string, ip: string, day: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${day}\n${visitorPrefix(ip)}`));
  return Array.from(new Uint8Array(mac), (byte: number) => byte.toString(16).padStart(2, "0")).join("");
}

// Use Cloudflare's client address; all local visitors share the fallback.
export function visitorIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "local";
}

// The first day the counter still covers. Older days are pruned by the hourly cron.
function firstDay(now: number): string {
  return interestDay(now - AI_INTEREST_RETENTION_DAYS * 86_400_000);
}

// Read at most 31 daily rows, regardless of vote count.
export async function aiInterestTotals(env: AppEnv, now: number): Promise<AiInterestTotals> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(up), 0) AS up, COALESCE(SUM(down), 0) AS down FROM ai_interest_daily WHERE day >= ?",
  )
    .bind(firstDay(now))
    .first<{ up: number; down: number }>();
  return { up: row?.up ?? 0, down: row?.down ?? 0 };
}

// The totals and this visitor's vote today, for the /ai page and `GET /api/ai-interest`.
export async function aiInterestStatus(env: AppEnv, request: Request, now: number): Promise<AiInterestStatus> {
  const secret: string | null = salt(env);
  if (!secret) return { available: false, totals: { up: 0, down: 0 }, mine: null };
  const day: string = interestDay(now);
  const hash: string = await visitorHash(secret, visitorIp(request), day);
  const [totals, row] = await Promise.all([
    aiInterestTotals(env, now),
    env.DB.prepare("SELECT value FROM ai_interest WHERE day=? AND ip_hash=?")
      .bind(day, hash)
      .first<{ value: number }>(),
  ]);
  let mine: AiInterestStatus["mine"] = null;
  if (row) mine = row.value === 1 ? "up" : "down";
  return { available: true, totals, mine };
}

// Separate daily network quota: REQUEST_LIMITER permits 120/minute.
export const AI_INTEREST_LIMIT_KEY = "ai-interest";

// One unverified vote per network/day; duplicates return `counted: false`. Agent identity is self-declared.
// Use a separate limiter key from the Worker's per-address quota.
export async function recordAiInterest(
  env: AppEnv,
  request: Request,
  vote: "up" | "down",
  now: number,
): Promise<{ counted: boolean; totals: AiInterestTotals }> {
  const secret: string | null = salt(env);
  if (!secret) throw new HttpError(503, "The AI interest counter is not available.");
  const day: string = interestDay(now);
  const hash: string = await visitorHash(secret, visitorIp(request), day);
  if (!(await env.REQUEST_LIMITER.limit({ key: `${AI_INTEREST_LIMIT_KEY}:${hash}` })).success)
    throw new HttpError(429, "Too many requests. Please try again in a minute.");
  const up: number = vote === "up" ? 1 : 0;
  // Increment the daily total only for a new vote; `changes()` reads the preceding statement count.
  const [result] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO ai_interest (day, ip_hash, value) VALUES (?, ?, ?) ON CONFLICT(day, ip_hash) DO NOTHING",
    ).bind(day, hash, up ? 1 : -1),
    env.DB.prepare(`
      INSERT INTO ai_interest_daily (day, up, down) SELECT ?, ?, ? WHERE changes() = 1
      ON CONFLICT(day) DO UPDATE SET up = up + excluded.up, down = down + excluded.down
    `).bind(day, up, 1 - up),
  ]);
  return { counted: (result.meta.changes ?? 0) > 0, totals: await aiInterestTotals(env, now) };
}

// Deletes votes and daily totals older than the retention window. Called by the hourly cron.
export function pruneAiInterest(env: AppEnv, now: number): D1PreparedStatement[] {
  return [
    env.DB.prepare("DELETE FROM ai_interest WHERE day < ?").bind(firstDay(now)),
    env.DB.prepare("DELETE FROM ai_interest_daily WHERE day < ?").bind(firstDay(now)),
  ];
}
