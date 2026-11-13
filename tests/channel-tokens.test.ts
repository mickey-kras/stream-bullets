import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../app/env";
import {
  loadTokens,
  replaceTokens,
  tokenKeysConfigured,
  tokenStatement,
} from "../app/server/channel-tokens.server";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const keyA = `a:${btoa(String.fromCodePoint(...new Uint8Array(32).fill(1)))}`;
const keyB = `b:${btoa(String.fromCodePoint(...new Uint8Array(32).fill(2)))}`;

let database: TestDatabase;
let env: AppEnv;

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  await database.db.batch([
    database.db.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('u','U','u@x.test',1,1,1)"),
    database.db.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES ('s','u','host','Host')"),
    database.db.prepare(
      `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,created_at,updated_at)
        VALUES ('c1','s','kick','1','Host','',1,1), ('c2','s','twitch','2','Host','',1,1)`,
    ),
  ]);
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach((): void => {
  env = { DB: database.db, CHANNEL_TOKEN_KEYS: keyA } as AppEnv;
});

describe("channel token keys", (): void => {
  it("accepts a list of 32-byte keys and refuses anything else", (): void => {
    expect(tokenKeysConfigured({ CHANNEL_TOKEN_KEYS: `${keyA},${keyB}` } as AppEnv)).toBe(true);
    for (const value of [undefined, "", "a:short", `${keyA},${keyA}`, `bad id:${keyA.slice(2)}`, "a:!!!"])
      expect(tokenKeysConfigured({ CHANNEL_TOKEN_KEYS: value } as AppEnv)).toBe(false);
  });

  it("refuses to store a token without keys (503), never in plaintext", async (): Promise<void> => {
    await expect(
      tokenStatement({ DB: database.db } as AppEnv, "c1", "kick", { accessToken: "x", refreshToken: null, expiresAt: null }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("channel token storage", (): void => {
  it("round-trips tokens and stores only ciphertext", async (): Promise<void> => {
    await (await tokenStatement(env, "c1", "kick", { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: 5 }, 10)).run();
    const row = await database.db.prepare("SELECT * FROM channel_tokens WHERE connection_id='c1'").first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toMatch(/access-1|refresh-1/);
    expect(await loadTokens(env, "c1", "kick")).toEqual({
      keyId: "a",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 5,
      updatedAt: 10,
    });
    expect(await loadTokens(env, "missing", "kick")).toBeNull();
  });

  it("does not decrypt a value under another connection or platform (additional data)", async (): Promise<void> => {
    await (await tokenStatement(env, "c1", "kick", { accessToken: "access-1", refreshToken: null, expiresAt: null }, 10)).run();
    const row = await database.db
      .prepare("SELECT access_token FROM channel_tokens WHERE connection_id='c1'")
      .first<{ access_token: string }>();
    await database.db
      .prepare("INSERT OR REPLACE INTO channel_tokens (connection_id,key_id,access_token,updated_at) VALUES ('c2','a',?,1)")
      .bind(row?.access_token)
      .run();
    await expect(loadTokens(env, "c2", "twitch")).rejects.toThrow();
    await expect(loadTokens(env, "c1", "twitch")).rejects.toThrow();
  });

  it("refuses an unknown key id and rotates rows to the current key on the next write", async (): Promise<void> => {
    await (await tokenStatement(env, "c1", "kick", { accessToken: "old", refreshToken: "r", expiresAt: null }, 10)).run();
    await expect(loadTokens({ ...env, CHANNEL_TOKEN_KEYS: keyB }, "c1", "kick")).rejects.toThrow("Unknown channel token key");
    const rotated = { ...env, CHANNEL_TOKEN_KEYS: `${keyB},${keyA}` };
    expect((await loadTokens(rotated, "c1", "kick"))?.accessToken).toBe("old");
    expect(await replaceTokens(rotated, "c1", "kick", { accessToken: "new", refreshToken: "r2", expiresAt: 1 }, 10, 20)).toBe(true);
    expect(await loadTokens({ ...env, CHANNEL_TOKEN_KEYS: keyB }, "c1", "kick")).toMatchObject({
      keyId: "b",
      accessToken: "new",
      refreshToken: "r2",
      updatedAt: 20,
    });
  });

  it("writes refreshed tokens only over the row that was read (compare-and-set)", async (): Promise<void> => {
    await (await tokenStatement(env, "c1", "kick", { accessToken: "a", refreshToken: "r", expiresAt: null }, 10)).run();
    expect(await replaceTokens(env, "c1", "kick", { accessToken: "b", refreshToken: null, expiresAt: null }, 10, 10)).toBe(true);
    // The second writer read the same row: its older refresh result loses.
    expect(await replaceTokens(env, "c1", "kick", { accessToken: "c", refreshToken: "x", expiresAt: null }, 10, 30)).toBe(false);
    expect(await loadTokens(env, "c1", "kick")).toMatchObject({ accessToken: "b", refreshToken: null, updatedAt: 11 });
  });
});
