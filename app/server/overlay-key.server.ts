import { z } from "zod";
import type { AppEnv } from "../env";
import { ORIENTATIONS, type Orientation } from "../lib/overlay-layers";
import type { StreamerStatus } from "../types";
import { isStreamerListed } from "./access.server";
import { auditStatement } from "./audit.server";
import { openSecret, sealSecret, type SealedSecret } from "./channel-tokens.server";
import { HttpError } from "./http.server";

// Overlay keys grant owner admission even when full. The check uses the SHA-256 of the key. The key itself is kept
// encrypted, when the deployment has encryption keys, so the owner can see the link again. A replacement revokes
// the old key.
//
// Each output, horizontal and vertical, has its own key. A row of `overlay_keys` has two slots. The first slot
// (`key_hash`, ...) is the key of the output in `output`. The second slot (`other_key_hash`, ...) is the key of
// the other output. Thus a key from before the two outputs keeps its columns, and a Worker from before them still
// reads it.

// `POST /api/overlay/key` and `POST /api/overlay/key/show` name the output. Without it they use the horizontal one.
export const overlayKeySchema = z.object({ output: z.enum(ORIENTATIONS).default("horizontal") }).strict();

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

/** The output that is not `output`. */
function otherOutput(output: Orientation): Orientation {
  return output === "horizontal" ? "vertical" : "horizontal";
}

const keyRowSchema = z.object({
  output: z.enum(ORIENTATIONS),
  key_hash: z.string(),
  key_sealed: z.string().nullable(),
  key_id: z.string().nullable(),
  other_key_hash: z.string().nullable(),
  other_key_sealed: z.string().nullable(),
  other_key_id: z.string().nullable(),
});
type KeyRow = z.infer<typeof keyRowSchema>;

async function keyRow(env: AppEnv, streamerId: string): Promise<KeyRow | null> {
  const row = await env.DB.prepare(
    `SELECT output, key_hash, key_sealed, key_id, other_key_hash, other_key_sealed, other_key_id
      FROM overlay_keys WHERE streamer_id=?`,
  )
    .bind(streamerId)
    .first();
  return row === null ? null : keyRowSchema.parse(row);
}

/** The stored key of one output: its hash, and the encrypted key when the server kept it. Null: no key. */
function outputKey(row: KeyRow, output: Orientation): { hash: string; kept: SealedSecret | null } | null {
  const first: boolean = row.output === output;
  const hash: string | null = first ? row.key_hash : row.other_key_hash;
  if (hash === null) return null;
  const sealed: string | null = first ? row.key_sealed : row.other_key_sealed;
  const keyId: string | null = first ? row.key_id : row.other_key_id;
  return { hash, kept: sealed && keyId ? { sealed, keyId } : null };
}

/**
 * The output of `key`: horizontal or vertical. Null when the key is missing, malformed or revoked. The check
 * always compares the key with the keys of the two outputs, so its time does not tell which one matched.
 */
export async function overlayKeyOutput(
  env: AppEnv,
  streamerId: string,
  key: string | null,
): Promise<Orientation | null> {
  if (key === null || !KEY_PATTERN.test(key)) return null;
  const row: KeyRow | null = await keyRow(env, streamerId);
  if (!row) return null;
  const hash: string = await hashOverlayKey(key);
  const first: boolean = constantTimeEqual(hash, row.key_hash);
  const second: boolean = constantTimeEqual(hash, row.other_key_hash ?? "");
  if (first) return row.output;
  return second ? otherOutput(row.output) : null;
}

/** Which outputs of the page have an overlay key. */
export async function overlayKeyOutputs(env: AppEnv, streamerId: string): Promise<Record<Orientation, boolean>> {
  const row: KeyRow | null = await keyRow(env, streamerId);
  return {
    horizontal: row !== null && outputKey(row, "horizontal") !== null,
    vertical: row !== null && outputKey(row, "vertical") !== null,
  };
}

// Rotate the key of one output; the key of the other output stays. Audit actor and output only, never key/hash.
// Refuse suspended pages; permit frozen pages to replace leaked keys.
export async function regenerateOverlayKey(
  env: AppEnv,
  actorId: string,
  streamer: { id: string; status: StreamerStatus },
  output: Orientation,
): Promise<string> {
  if (!isStreamerListed(streamer.status))
    throw new HttpError(423, "This page is suspended. Nothing on it can change.", "page_suspended");
  const key = newOverlayKey();
  const now = Date.now();
  const kept: SealedSecret | null = await sealSecret(env, sealContext(streamer.id, output), key);
  // One statement, so two requests at the same time cannot lose a key. A page without a row gets its first slot.
  // A page with a row replaces the slot of `output`: the first slot when `output` is the output of the row.
  const mine = "overlay_keys.output = excluded.output";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO overlay_keys (streamer_id, output, key_hash, key_sealed, key_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(streamer_id) DO UPDATE SET
          key_hash = CASE WHEN ${mine} THEN excluded.key_hash ELSE overlay_keys.key_hash END,
          key_sealed = CASE WHEN ${mine} THEN excluded.key_sealed ELSE overlay_keys.key_sealed END,
          key_id = CASE WHEN ${mine} THEN excluded.key_id ELSE overlay_keys.key_id END,
          created_at = CASE WHEN ${mine} THEN excluded.created_at ELSE overlay_keys.created_at END,
          other_key_hash = CASE WHEN ${mine} THEN overlay_keys.other_key_hash ELSE excluded.key_hash END,
          other_key_sealed = CASE WHEN ${mine} THEN overlay_keys.other_key_sealed ELSE excluded.key_sealed END,
          other_key_id = CASE WHEN ${mine} THEN overlay_keys.other_key_id ELSE excluded.key_id END,
          other_created_at = CASE WHEN ${mine} THEN overlay_keys.other_created_at ELSE excluded.created_at END`,
    ).bind(streamer.id, output, await hashOverlayKey(key), kept?.sealed ?? null, kept?.keyId ?? null, now),
    auditStatement(env, {
      targetKind: "streamer",
      targetId: streamer.id,
      streamerId: streamer.id,
      action: "overlay_key_regenerated",
      actorId,
      metadata: { output },
      createdAt: now,
    }),
  ]);
  return key;
}

// The encrypted key belongs to one output of one page: a copy in another row or slot does not open.
function sealContext(streamerId: string, output: Orientation): string {
  return `overlay-key|${streamerId}|${output}`;
}

// The context of a key from before the two outputs.
function oldSealContext(streamerId: string): string {
  return `overlay-key|${streamerId}`;
}

// The current key of one output for the owner, or null when the output has no key that can be shown: the key is
// from before keys were kept, or its encryption key is gone. The audit names the actor and the output, never the key.
export async function showOverlayKey(
  env: AppEnv,
  actorId: string,
  streamerId: string,
  output: Orientation,
): Promise<string | null> {
  const row: KeyRow | null = await keyRow(env, streamerId);
  const stored = row ? outputKey(row, output) : null;
  if (!stored?.kept) return null;
  const key: string | null =
    (await openSecret(env, sealContext(streamerId, output), stored.kept)) ??
    (await openSecret(env, oldSealContext(streamerId), stored.kept));
  if (key === null || !constantTimeEqual(await hashOverlayKey(key), stored.hash)) return null;
  await env.DB.batch([
    auditStatement(env, {
      targetKind: "streamer",
      targetId: streamerId,
      streamerId,
      action: "overlay_key_shown",
      actorId,
      metadata: { output },
      createdAt: Date.now(),
    }),
  ]);
  return key;
}
