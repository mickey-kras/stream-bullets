import { z } from "zod";
import type { AppEnv } from "../env";
import type { StreamerStatus } from "../types";
import { isStreamerListed } from "./access.server";
import { auditStatement } from "./audit.server";
import { HttpError } from "./http.server";

/**
 * The secret key in the owner's OBS overlay URL (`/@handle/overlay?key=…`). With it, the overlay's live socket counts
 * as the owner's, so a full room never turns it away. Only the SHA-256 of the key is stored: the key is shown once,
 * when it is made, and a new key revokes the old one.
 */

/** `POST /api/overlay/key` takes no options. */
export const overlayKeySchema = z.object({}).strict();

const KEY_BYTES = 32;
/** 32 bytes in base64url without padding. */
const KEY_PATTERN = /^[\w-]{43}$/;

/** A new key: 32 random bytes as base64url. */
export function newOverlayKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** The hex SHA-256 of a key, as stored. */
export async function hashOverlayKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte: number): string => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings in time that depends only on their lengths, never on where they first differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index++) {
    difference |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0);
  }
  return difference === 0;
}

/** Whether `key` is the page's current overlay key. A missing, malformed or revoked key is never a match. */
export async function overlayKeyMatches(env: AppEnv, streamerId: string, key: string | null): Promise<boolean> {
  if (key === null || !KEY_PATTERN.test(key)) return false;
  const row = await env.DB.prepare("SELECT key_hash FROM overlay_keys WHERE streamer_id=?")
    .bind(streamerId)
    .first<{ key_hash: string }>();
  if (!row) return false;
  return constantTimeEqual(await hashOverlayKey(key), row.key_hash);
}

/** Whether the page has an overlay key. The key itself can never be read back. */
export async function hasOverlayKey(env: AppEnv, streamerId: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 FROM overlay_keys WHERE streamer_id=?").bind(streamerId).first()) !== null;
}

/**
 * Makes a new key for the page and revokes the old one. The audit row records only who did it, never the key or its
 * hash. A suspended page gets no key. A frozen page may still replace a leaked one.
 */
export async function regenerateOverlayKey(
  env: AppEnv,
  actorId: string,
  streamer: { id: string; status: StreamerStatus },
): Promise<string> {
  if (!isStreamerListed(streamer.status)) throw new HttpError(423, "This page is suspended. Nothing on it can change.");
  const key = newOverlayKey();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO overlay_keys (streamer_id, key_hash, created_at) VALUES (?, ?, ?)
        ON CONFLICT(streamer_id) DO UPDATE SET key_hash=excluded.key_hash, created_at=excluded.created_at`,
    ).bind(streamer.id, await hashOverlayKey(key), now),
    auditStatement(env, {
      targetKind: "streamer",
      targetId: streamer.id,
      streamerId: streamer.id,
      action: "overlay_key_regenerated",
      actorId,
      createdAt: now,
    }),
  ]);
  return key;
}
