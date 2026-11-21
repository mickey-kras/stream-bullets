import { z } from "zod";
import type { AppEnv } from "../env";
import type { StreamerStatus } from "../types";
import { isStreamerListed } from "./access.server";
import { auditStatement } from "./audit.server";
import { openSecret, sealSecret, type SealedSecret } from "./channel-tokens.server";
import { HttpError } from "./http.server";

// Overlay keys grant owner admission even when full. The check uses the SHA-256 of the key. The key itself is kept
// encrypted, when the deployment has encryption keys, so the owner can see the link again. A replacement revokes
// the old key.

// `POST /api/overlay/key` takes no options.
export const overlayKeySchema = z.object({}).strict();

const KEY_BYTES = 32;
// 32 bytes in base64url without padding.
const KEY_PATTERN = /^[\w-]{43}$/;

// A new key: 32 random bytes as base64url.
export function newOverlayKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

// Bytes as lowercase hex.
export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte: number): string => byte.toString(16).padStart(2, "0")).join("");
}

// The hex SHA-256 of a key, as stored.
export async function hashOverlayKey(key: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
}

// Compares two strings in time that depends only on their lengths, never on where they first differ.
export function constantTimeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index++) {
    difference |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0);
  }
  return difference === 0;
}

// Whether `key` is the page's current overlay key. A missing, malformed or revoked key is never a match.
export async function overlayKeyMatches(env: AppEnv, streamerId: string, key: string | null): Promise<boolean> {
  if (key === null || !KEY_PATTERN.test(key)) return false;
  const row = await env.DB.prepare("SELECT key_hash FROM overlay_keys WHERE streamer_id=?")
    .bind(streamerId)
    .first<{ key_hash: string }>();
  if (!row) return false;
  return constantTimeEqual(await hashOverlayKey(key), row.key_hash);
}

// Whether the page has an overlay key.
export async function hasOverlayKey(env: AppEnv, streamerId: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 FROM overlay_keys WHERE streamer_id=?").bind(streamerId).first()) !== null;
}

// Rotate the key; audit actor only, never key/hash. Refuse suspended pages; permit frozen pages to replace
// leaked keys.
export async function regenerateOverlayKey(
  env: AppEnv,
  actorId: string,
  streamer: { id: string; status: StreamerStatus },
): Promise<string> {
  if (!isStreamerListed(streamer.status))
    throw new HttpError(423, "This page is suspended. Nothing on it can change.", "page_suspended");
  const key = newOverlayKey();
  const now = Date.now();
  const kept: SealedSecret | null = await sealSecret(env, sealContext(streamer.id), key);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO overlay_keys (streamer_id, key_hash, key_sealed, key_id, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(streamer_id) DO UPDATE SET key_hash=excluded.key_hash, key_sealed=excluded.key_sealed,
          key_id=excluded.key_id, created_at=excluded.created_at`,
    ).bind(streamer.id, await hashOverlayKey(key), kept?.sealed ?? null, kept?.keyId ?? null, now),
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

// The encrypted key belongs to one page: a copy in another row does not open.
function sealContext(streamerId: string): string {
  return `overlay-key|${streamerId}`;
}

// The current key of the page for its owner, or null when the page has no key that can be shown: the key is
// from before keys were kept, or its encryption key is gone. The audit names the actor, never the key.
export async function showOverlayKey(env: AppEnv, actorId: string, streamerId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT key_hash, key_sealed, key_id FROM overlay_keys WHERE streamer_id=?")
    .bind(streamerId)
    .first<{ key_hash: string; key_sealed: string | null; key_id: string | null }>();
  if (!row?.key_sealed || !row.key_id) return null;
  const key: string | null = await openSecret(env, sealContext(streamerId), {
    sealed: row.key_sealed,
    keyId: row.key_id,
  });
  if (key === null || !constantTimeEqual(await hashOverlayKey(key), row.key_hash)) return null;
  await env.DB.batch([
    auditStatement(env, {
      targetKind: "streamer",
      targetId: streamerId,
      streamerId,
      action: "overlay_key_shown",
      actorId,
      createdAt: Date.now(),
    }),
  ]);
  return key;
}
