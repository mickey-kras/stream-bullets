import type { AppEnv } from "../env";
import type { ActivityPlatform } from "../lib/activity";
import { HttpError } from "./http.server";
import { fromBase64Url, toBase64Url } from "./webauthn.server";

/**
 * Provider tokens at rest (docs/channel-connections.md, "Token encryption"). Only this module reads or writes
 * `channel_tokens`. Each value is AES-256-GCM with a fresh 96-bit IV; the additional data binds it to its
 * connection, platform and field, so a value copied to another row or field does not decrypt.
 *
 * CHANNEL_TOKEN_KEYS is `id:base64key[,id:base64key...]`, a Worker secret separate from BETTER_AUTH_SECRET. The
 * first key encrypts; every listed key decrypts. To rotate, put a new key first and keep the old one until every
 * row shows the new `key_id` (rows move to the current key when their tokens are next written).
 */

export interface ChannelTokens {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token expires (ms), or null when the provider did not say. */
  expiresAt: number | null;
}

export interface StoredTokens extends ChannelTokens {
  keyId: string;
  updatedAt: number;
}

type Field = "access" | "refresh";

const KEY_ID = /^[\w-]{1,16}$/;

interface Keyring {
  currentId: string;
  keys: Map<string, CryptoKey>;
}

/** A key from CHANNEL_TOKEN_KEYS: standard base64. */
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char: string): number => char.codePointAt(0) ?? 0);
}

/** Whether an operator turned channel ingestion off (`CHANNELS_OFF=1`, docs/channel-connections.md). */
export function channelsOff(env: AppEnv): boolean {
  return env.CHANNELS_OFF === "1";
}

/** Whether channel connections can store tokens. Without valid keys the feature is off (503), never plaintext. */
export function tokenKeysConfigured(env: AppEnv): boolean {
  if (channelsOff(env)) return false;
  try {
    parseKeyList(env.CHANNEL_TOKEN_KEYS);
    return true;
  } catch {
    return false;
  }
}

function parseKeyList(value: string | undefined): { id: string; raw: Uint8Array<ArrayBuffer> }[] {
  if (!value) throw new HttpError(503, "Channel connections are not configured.");
  const entries = value.split(",").map((part: string) => {
    const separator = part.indexOf(":");
    const id = part.slice(0, separator).trim();
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = fromBase64(part.slice(separator + 1).trim());
    } catch {
      raw = new Uint8Array(0);
    }
    return { id, raw };
  });
  const ids = new Set(entries.map((entry) => entry.id));
  if (ids.size !== entries.length || entries.some((entry) => !KEY_ID.test(entry.id) || entry.raw.byteLength !== 32))
    throw new HttpError(503, "Channel connections are not configured.");
  return entries;
}

async function keyring(env: AppEnv): Promise<Keyring> {
  const entries = parseKeyList(env.CHANNEL_TOKEN_KEYS);
  const keys = new Map<string, CryptoKey>();
  for (const entry of entries) {
    keys.set(entry.id, await crypto.subtle.importKey("raw", entry.raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  return { currentId: entries[0].id, keys };
}

function additionalData(connectionId: string, platform: ActivityPlatform, field: Field): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${connectionId}|${platform}|${field}`);
}

async function encrypt(
  key: CryptoKey,
  connectionId: string,
  platform: ActivityPlatform,
  field: Field,
  value: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(connectionId, platform, field) },
    key,
    new TextEncoder().encode(value),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
}

async function decrypt(
  key: CryptoKey,
  connectionId: string,
  platform: ActivityPlatform,
  field: Field,
  value: string,
): Promise<string> {
  const [iv, sealed] = value.split(".");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: additionalData(connectionId, platform, field) },
    key,
    fromBase64Url(sealed ?? ""),
  );
  return new TextDecoder().decode(plain);
}

/**
 * The upsert for a connection's tokens, encrypted with the current key, to batch with the connection row. It
 * writes nothing while a disconnect of the connection runs, so a racing reconnect cannot leave tokens behind.
 */
export async function tokenStatement(
  env: AppEnv,
  connectionId: string,
  platform: ActivityPlatform,
  tokens: ChannelTokens,
  now: number = Date.now(),
): Promise<D1PreparedStatement> {
  const ring = await keyring(env);
  const key = ring.keys.get(ring.currentId) as CryptoKey;
  return env.DB.prepare(
    `INSERT INTO channel_tokens (connection_id, key_id, access_token, refresh_token, expires_at, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE (SELECT status_code FROM channel_connections WHERE id=?1) IS NOT 'disconnecting'
      ON CONFLICT(connection_id) DO UPDATE SET key_id=excluded.key_id, access_token=excluded.access_token,
        refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
  ).bind(
    connectionId,
    ring.currentId,
    await encrypt(key, connectionId, platform, "access", tokens.accessToken),
    tokens.refreshToken === null ? null : await encrypt(key, connectionId, platform, "refresh", tokens.refreshToken),
    tokens.expiresAt,
    now,
  );
}

/** A connection's tokens, or null when it has none. A value that does not decrypt is an error, never returned. */
export async function loadTokens(
  env: AppEnv,
  connectionId: string,
  platform: ActivityPlatform,
): Promise<StoredTokens | null> {
  const row = await env.DB.prepare(
    "SELECT key_id, access_token, refresh_token, expires_at, updated_at FROM channel_tokens WHERE connection_id=?",
  )
    .bind(connectionId)
    .first<{
      key_id: string;
      access_token: string;
      refresh_token: string | null;
      expires_at: number | null;
      updated_at: number;
    }>();
  if (!row) return null;
  const key = (await keyring(env)).keys.get(row.key_id);
  if (!key) throw new Error("Unknown channel token key");
  return {
    keyId: row.key_id,
    accessToken: await decrypt(key, connectionId, platform, "access", row.access_token),
    refreshToken:
      row.refresh_token === null ? null : await decrypt(key, connectionId, platform, "refresh", row.refresh_token),
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Stores refreshed tokens only when the row is still the one that was read (`updated_at` compare-and-set), so a
 * second writer can never replace a newer refresh token with an older one. Returns whether the write happened.
 */
export async function replaceTokens(
  env: AppEnv,
  connectionId: string,
  platform: ActivityPlatform,
  tokens: ChannelTokens,
  readAt: number,
  now: number = Date.now(),
): Promise<boolean> {
  const ring = await keyring(env);
  const key = ring.keys.get(ring.currentId) as CryptoKey;
  const result = await env.DB.prepare(
    `UPDATE channel_tokens SET key_id=?, access_token=?, refresh_token=?, expires_at=?, updated_at=?
      WHERE connection_id=? AND updated_at=?`,
  )
    .bind(
      ring.currentId,
      await encrypt(key, connectionId, platform, "access", tokens.accessToken),
      tokens.refreshToken === null ? null : await encrypt(key, connectionId, platform, "refresh", tokens.refreshToken),
      tokens.expiresAt,
      Math.max(now, readAt + 1),
      connectionId,
      readAt,
    )
    .run();
  return result.meta.changes > 0;
}
