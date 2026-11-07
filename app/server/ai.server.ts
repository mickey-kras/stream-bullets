import { z } from "zod";
import type { AppEnv } from "../env";
import { HttpError } from "./http.server";

/** Votes older than this are pruned by the hourly cron, so the totals cover the last 30 days. */
export const AI_INTEREST_RETENTION_DAYS = 30;

/** `POST /api/ai-interest`. `agent` is the caller's own name for itself; it is not stored. */
export const aiInterestSchema = z
  .object({ vote: z.enum(["up", "down"]), agent: z.string().max(100).optional() })
  .strict();

export interface AiInterestTotals {
  up: number;
  down: number;
}

export interface AiInterestStatus {
  /** False when the AI_INTEREST_SALT secret is not set: the counter is off and the page hides the buttons. */
  available: boolean;
  totals: AiInterestTotals;
  /** This visitor's vote today, or null. */
  mine: "up" | "down" | null;
}

/** The UTC day of `now`, as stored in `ai_interest.day`. */
export function interestDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function salt(env: AppEnv): string | null {
  const value: string | undefined = env.AI_INTEREST_SALT;
  return value && value.length >= 16 ? value : null;
}

/**
 * The visitor's key for one day: an HMAC-SHA-256 of the day and the IP address, keyed with the AI_INTEREST_SALT
 * secret. The IP address itself is never stored, and keys from different days cannot be linked.
 */
export async function visitorHash(secret: string, ip: string, day: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${day}\n${ip}`));
  return Array.from(new Uint8Array(mac), (byte: number) => byte.toString(16).padStart(2, "0")).join("");
}

/** The address Cloudflare saw. Local development has none, so every local visitor counts as one. */
export function visitorIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "local";
}

export async function aiInterestTotals(env: AppEnv): Promise<AiInterestTotals> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(value = 1), 0) AS up, COALESCE(SUM(value = -1), 0) AS down FROM ai_interest",
  ).first<{ up: number; down: number }>();
  return { up: row?.up ?? 0, down: row?.down ?? 0 };
}

/** The totals and this visitor's vote today, for the /ai page and `GET /api/ai-interest`. */
export async function aiInterestStatus(env: AppEnv, request: Request, now: number): Promise<AiInterestStatus> {
  const secret: string | null = salt(env);
  if (!secret) return { available: false, totals: { up: 0, down: 0 }, mine: null };
  const day: string = interestDay(now);
  const hash: string = await visitorHash(secret, visitorIp(request), day);
  const [totals, row] = await Promise.all([
    aiInterestTotals(env),
    env.DB.prepare("SELECT value FROM ai_interest WHERE day=? AND ip_hash=?").bind(day, hash).first<{ value: number }>(),
  ]);
  let mine: AiInterestStatus["mine"] = null;
  if (row) mine = row.value === 1 ? "up" : "down";
  return { available: true, totals, mine };
}

/**
 * Records one vote per visitor per day. A second vote on the same day changes nothing and reports
 * `counted: false`. This is an unverified signal: anyone can claim to be an agent.
 */
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
  const result = await env.DB.prepare(
    "INSERT INTO ai_interest (day, ip_hash, value) VALUES (?, ?, ?) ON CONFLICT(day, ip_hash) DO NOTHING",
  )
    .bind(day, hash, vote === "up" ? 1 : -1)
    .run();
  return { counted: (result.meta.changes ?? 0) > 0, totals: await aiInterestTotals(env) };
}

/** Deletes votes older than the retention window. Called by the hourly cron. */
export function pruneAiInterest(env: AppEnv, now: number): D1PreparedStatement {
  return env.DB.prepare("DELETE FROM ai_interest WHERE day < ?").bind(
    interestDay(now - AI_INTEREST_RETENTION_DAYS * 86_400_000),
  );
}
