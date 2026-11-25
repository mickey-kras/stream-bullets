import type { AppEnv } from "../env";
import type { StreamerStatus } from "../types";
import { isStreamerListed } from "./access.server";
import { auditStatement } from "./audit.server";
import { HttpError } from "./http.server";
import { constantTimeEqual, hashOverlayKey, newOverlayKey } from "./overlay-key.server";

// The key of the private OBS dock. It grants the live controls of one page: the dock page, its live room, its
// activity feed, and the dock actions of the API. It grants nothing else: no account, no channel management, and
// no overlay link. It is separate from the overlay keys: an overlay key never grants a control action, and the dock
// key never opens the overlay as an OBS source.
//
// The server stores only the SHA-256 of the key. The link shows one time, when the owner makes it. A new key
// replaces the old one, and the open dock pages lose their sockets and their actions at once.

// 32 bytes in base64url without padding, the form of an overlay key.
const KEY_PATTERN = /^[\w-]{43}$/;

/** Whether `key` is the current dock key of the page. A missing, malformed or replaced key is never a match. */
export async function dockKeyMatches(env: AppEnv, streamerId: string, key: string | null): Promise<boolean> {
  if (key === null || !KEY_PATTERN.test(key)) return false;
  const row = await env.DB.prepare("SELECT key_hash FROM dock_keys WHERE streamer_id=?")
    .bind(streamerId)
    .first<{ key_hash: string }>();
  if (!row) return false;
  return constantTimeEqual(await hashOverlayKey(key), row.key_hash);
}

/** Whether the page has a dock key. */
export async function hasDockKey(env: AppEnv, streamerId: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 FROM dock_keys WHERE streamer_id=?").bind(streamerId).first()) !== null;
}

// Makes a new dock key and revokes the old one. Audit the actor only, never the key or its hash. Refuse suspended
// pages; permit frozen pages to replace a leaked key.
export async function regenerateDockKey(
  env: AppEnv,
  actorId: string,
  streamer: { id: string; status: StreamerStatus },
): Promise<string> {
  if (!isStreamerListed(streamer.status))
    throw new HttpError(423, "This page is suspended. Nothing on it can change.", "page_suspended");
  const key: string = newOverlayKey();
  const now: number = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dock_keys (streamer_id, key_hash, created_at) VALUES (?, ?, ?)
        ON CONFLICT(streamer_id) DO UPDATE SET key_hash=excluded.key_hash, created_at=excluded.created_at`,
    ).bind(streamer.id, await hashOverlayKey(key), now),
    auditStatement(env, {
      targetKind: "streamer",
      targetId: streamer.id,
      streamerId: streamer.id,
      action: "dock_key_regenerated",
      actorId,
      createdAt: now,
    }),
  ]);
  return key;
}
