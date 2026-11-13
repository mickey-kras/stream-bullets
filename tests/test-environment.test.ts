import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSignature } from "better-auth/crypto";
import type { AppEnv } from "../app/env";
import { getViewer } from "../app/server/auth.server";
import { canCreateStreamer, isAdmin, assertStreamerWritable, canViewStreamer } from "../app/server/access.server";
import { getStreamer, mutateEntry } from "../app/server/data.server";
import { getOverlayState } from "../app/server/overlay.server";
import { DEFAULT_OVERLAY } from "../app/server/overlay-state";
import {
  seedTestEnvironment,
  testEnvironmentResponse,
  testAccountId,
  requireTestAccess,
  TEST_ACCOUNTS,
  TEST_ORIGIN,
  validateTestEnvironment,
} from "../app/server/test-environment.server";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const secret = "test-access-secret-with-at-least-32-bytes";
const identity = "e475eb5b-db31-43bd-8692-5926711e8faa";
let database: TestDatabase;
let env: AppEnv;
const fetchRoom = vi.fn(async (): Promise<Response> => new Response(null, { status: 204 }));

function request(fields: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request(`${TEST_ORIGIN}/__test`, {
    method: "POST",
    headers: { Origin: TEST_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret, action: "login", account: "viewer", ...fields }),
    ...init,
  });
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    APP_ENV: "test",
    APP_ORIGIN: TEST_ORIGIN,
    TEST_DATABASE_ID: identity,
    TEST_ACCESS_SECRET: secret,
    ADMIN_EMAILS: "admin@example.test",
    BETTER_AUTH_SECRET: "separate-authentication-secret-at-least-32-bytes",
    POLL_ROOMS: { idFromName: (id: string): string => id, get: (): object => ({ fetch: fetchRoom }) },
  } as unknown as AppEnv;
  await env.DB.prepare("CREATE TABLE test_environment_identity(id TEXT PRIMARY KEY)").run();
  await env.DB.prepare("INSERT INTO test_environment_identity VALUES(?)").bind(identity).run();
});
afterAll(async (): Promise<void> => database.dispose());
beforeEach(async (): Promise<void> => {
  fetchRoom.mockClear();
  fetchRoom.mockResolvedValue(new Response(null, { status: 204 }));
  await seedTestEnvironment(env, true);
});

describe("test environment isolation", (): void => {
  it.each([undefined, "production", "development", "TEST"])(
    "rejects access with APP_ENV=%s before using a database",
    async (APP_ENV): Promise<void> => {
      const unsafe: AppEnv = { ...env, APP_ENV, DB: undefined as unknown as D1Database };
      expect(() => validateTestEnvironment(unsafe)).toThrow("forbidden");
      await expect(seedTestEnvironment(unsafe, true)).rejects.toMatchObject({ status: 503 });
      await expect(testEnvironmentResponse(request(), unsafe)).rejects.toMatchObject({ status: 503 });
    },
  );
  it("keeps production operational without test configuration and hides the test route", async (): Promise<void> => {
    const production: AppEnv = {
      ...env,
      APP_ENV: "production",
      TEST_ACCESS_SECRET: undefined,
      TEST_DATABASE_ID: undefined,
    };
    expect(() => validateTestEnvironment(production)).not.toThrow();
    await expect(seedTestEnvironment(production, false)).rejects.toMatchObject({ status: 404 });
    await expect(testEnvironmentResponse(request(), production)).rejects.toMatchObject({ status: 404 });
    expect(() => validateTestEnvironment({ ...production, TEST_DATABASE_ID: identity })).toThrow("forbidden");
  });
  it("cannot create revision metadata without the test environment and database guards", async (): Promise<void> => {
    const isolated = await createTestDatabase({ migrate: false });
    try {
      const production: AppEnv = {
        ...env,
        DB: isolated.db,
        APP_ENV: "production",
        TEST_ACCESS_SECRET: undefined,
        TEST_DATABASE_ID: undefined,
      };
      await expect(seedTestEnvironment(production, true)).rejects.toMatchObject({ status: 404 });
      await expect(seedTestEnvironment({ ...env, DB: isolated.db, APP_ENV: undefined }, true)).rejects.toMatchObject({
        status: 503,
      });
      await expect(seedTestEnvironment({ ...env, DB: isolated.db }, true)).rejects.toMatchObject({ status: 503 });
      expect(
        await isolated.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'test_fixture_%'").first(),
      ).toBeNull();
    } finally {
      await isolated.dispose();
    }
  });
  it.each([
    { APP_ORIGIN: "https://streambullets.com" },
    { TEST_ACCESS_SECRET: undefined },
    { TEST_ACCESS_SECRET: "short" },
    { BETTER_AUTH_SECRET: undefined as unknown as string },
    { BETTER_AUTH_SECRET: "short" },
    { BETTER_AUTH_SECRET: secret },
    { TEST_DATABASE_ID: undefined },
    { TEST_DATABASE_ID: "wrong" },
    { ADMIN_EMAILS: "someone@example.com" },
    { GOOGLE_CLIENT_ID: "x" },
    { GOOGLE_CLIENT_SECRET: "x" },
    { TWITCH_CLIENT_ID: "x" },
    { TWITCH_CLIENT_SECRET: "x" },
    { TIKTOK_CLIENT_KEY: "x" },
    { TIKTOK_CLIENT_SECRET: "x" },
    { INSTAGRAM_CLIENT_ID: "x" },
    { INSTAGRAM_CLIENT_SECRET: "x" },
    { NOTIFY_FROM: "x" },
    { NOTIFY_EMAIL: {} as SendEmail },
    { CRON_HEARTBEAT_URL: "https://example.com" },
  ])("fails closed for unsafe settings %j", (settings): void => {
    expect(() => validateTestEnvironment({ ...env, ...settings })).toThrow("not isolated");
  });
  it("requires a provisioned matching database marker", async (): Promise<void> => {
    await expect(
      seedTestEnvironment({ ...env, TEST_DATABASE_ID: "00000000-0000-4000-8000-000000000000" }, true),
    ).rejects.toMatchObject({ status: 503 });
    await env.DB.prepare("DELETE FROM test_environment_identity").run();
    await expect(seedTestEnvironment(env, false)).rejects.toMatchObject({ status: 503 });
    await env.DB.prepare("DROP TABLE test_environment_identity").run();
    await expect(seedTestEnvironment(env, false)).rejects.toMatchObject({ status: 503 });
    await env.DB.prepare("CREATE TABLE test_environment_identity(id TEXT PRIMARY KEY)").run();
    await env.DB.prepare("INSERT INTO test_environment_identity VALUES(?)").bind(identity).run();
  });
});

describe("test access", (): void => {
  it("shows account names without secrets, cookies, or indexing", async (): Promise<void> => {
    const response = await testEnvironmentResponse(new Request(`${TEST_ORIGIN}/__test`), env);
    const html = await response.text();
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(html).not.toContain(secret);
    for (const account of TEST_ACCOUNTS) expect(html).toContain(`<option>${account}</option>`);
  });
  it.each(TEST_ACCOUNTS)("creates a real isolated session for %s", async (account): Promise<void> => {
    const response = await testEnvironmentResponse(request({ account }), env);
    expect(response.status).toBe(303);
    const cookie: string = response.headers.get("Set-Cookie")!;
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    const viewer = await getViewer(new Request(TEST_ORIGIN, { headers: { Cookie: cookie.split(";")[0] } }), {
      env,
      nonce: "nonce",
      responseHeaders: new Headers(),
    });
    expect(viewer?.id).toBe(testAccountId(account));
    expect(await isAdmin(env, viewer!.id)).toBe(account === "admin");
    const session = await env.DB.prepare("SELECT admin_verified_at FROM session WHERE user_id=?")
      .bind(viewer!.id)
      .first<{ admin_verified_at: number | null }>();
    expect(session?.admin_verified_at).toBeNull();
  });
  it("rejects wrong credentials, foreign origins, role injection, malformed forms and methods", async (): Promise<void> => {
    await expect(testEnvironmentResponse(request({ secret: "wrong" }), env)).rejects.toMatchObject({ status: 403 });
    await expect(
      testEnvironmentResponse(request({}, { headers: { Origin: "https://foreign.test" } }), env),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      testEnvironmentResponse(
        request({}, { headers: { Origin: TEST_ORIGIN, "Content-Type": "application/json" } }),
        env,
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(testEnvironmentResponse(request({ account: "real-admin" }), env)).rejects.toMatchObject({
      status: 400,
    });
    await expect(testEnvironmentResponse(request({ action: "arbitrary" }), env)).rejects.toMatchObject({ status: 400 });
    await expect(testEnvironmentResponse(request({ role: "admin" }), env)).rejects.toMatchObject({ status: 400 });
    await expect(
      testEnvironmentResponse(request({}, { body: `secret=${secret}&secret=wrong` }), env),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      testEnvironmentResponse(request({}, { body: "account=viewer&action=login" }), env),
    ).rejects.toMatchObject({ status: 403 });
    await expect(testEnvironmentResponse(request({}, { method: "PUT" }), env)).rejects.toMatchObject({ status: 405 });
    await expect(
      testEnvironmentResponse(new Request(`${TEST_ORIGIN}/__test?secret=${secret}`), env),
    ).rejects.toMatchObject({ status: 400 });
    await expect(testEnvironmentResponse(request({}, { body: "x".repeat(5000) }), env)).rejects.toMatchObject({
      status: 413,
    });
  });
  it("protects signed-out requests with separate access cookies and rejects tampering", async (): Promise<void> => {
    const response = await testEnvironmentResponse(request({ account: "signedout" }), env);
    const cookies: string[] = response.headers.getSetCookie();
    expect(
      cookies.find((cookie: string): boolean => cookie.startsWith("__Host-stream-bullets.session_token=")),
    ).toContain("Max-Age=0");
    const cookie: string = cookies
      .find((value: string): boolean => value.startsWith("__Host-sb-test-access="))!
      .split(";")[0];
    await expect(
      requireTestAccess(new Request(TEST_ORIGIN, { headers: { Cookie: cookie } }), env),
    ).resolves.toBeUndefined();
    await expect(
      requireTestAccess(new Request(TEST_ORIGIN, { headers: { Cookie: `unrelated=x; ${cookie}` } }), env),
    ).resolves.toBeUndefined();
    for (const value of [undefined, "unrelated=x", "__Host-sb-test-access=%wrong", "__Host-sb-test-access=bad"]) {
      await expect(
        requireTestAccess(new Request(TEST_ORIGIN, { headers: value ? { Cookie: value } : {} }), env),
      ).rejects.toMatchObject({ status: 403 });
    }
    for (const expires of [Date.now() - 1000, Date.now() + 7_200_000]) {
      const token: string = `${expires}.${await makeSignature(String(expires), secret)}`;
      await expect(
        requireTestAccess(
          new Request(TEST_ORIGIN, { headers: { Cookie: `__Host-sb-test-access=${encodeURIComponent(token)}` } }),
          env,
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
    const fake: string = encodeURIComponent(`${Date.now() + 1000}.wrong`);
    await expect(
      requireTestAccess(new Request(TEST_ORIGIN, { headers: { Cookie: `__Host-sb-test-access=${fake}` } }), env),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      requireTestAccess(new Request(TEST_ORIGIN), {
        ...env,
        APP_ENV: "production",
        TEST_ACCESS_SECRET: undefined,
        TEST_DATABASE_ID: undefined,
      }),
    ).resolves.toBeUndefined();
  });
  it("requires valid seeded account identity and authentication secret", async (): Promise<void> => {
    await env.DB.prepare("DELETE FROM user WHERE id=?").bind(testAccountId("viewer")).run();
    await expect(testEnvironmentResponse(request(), env)).rejects.toMatchObject({ status: 409 });
    await seedTestEnvironment(env, false);
    await env.DB.prepare("UPDATE user SET email_verified=0 WHERE id=?").bind(testAccountId("viewer")).run();
    await expect(testEnvironmentResponse(request(), env)).rejects.toMatchObject({ status: 409 });
    await expect(testEnvironmentResponse(request(), { ...env, BETTER_AUTH_SECRET: "short" })).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("synthetic fixtures", (): void => {
  it("uses actual permissions across communities and application states", async (): Promise<void> => {
    expect(await canCreateStreamer(env, testAccountId("approved"))).toBe(true);
    for (const account of ["pending", "rejected", "viewer"] as const)
      expect(await canCreateStreamer(env, testAccountId(account))).toBe(false);
    const own = (await getStreamer(env, "test_host"))!;
    const other = (await getStreamer(env, "other_host"))!;
    expect(own.ownerId).not.toBe(other.ownerId);
    await expect(
      mutateEntry(env, own.ownerId, other.id, {
        action: "create",
        kind: "choice",
        title: "Unauthorized poll",
        options: ["One", "Two"],
      }),
    ).rejects.toMatchObject({ status: 403 });
    const frozen = (await getStreamer(env, "frozen_host"))!;
    const suspended = (await getStreamer(env, "suspended_host"))!;
    await expect(assertStreamerWritable(env, frozen.id, frozen.ownerId)).rejects.toMatchObject({ status: 423 });
    expect(await canViewStreamer(env, suspended, testAccountId("viewer"))).toBe(false);
    expect(await canViewStreamer(env, suspended, suspended.ownerId)).toBe(true);
    const nested = await env.DB.prepare(
      "SELECT count(*) AS count FROM entry_comments WHERE parent_id IS NOT NULL",
    ).first<{ count: number }>();
    expect(nested?.count).toBe(8);
  });
  it("resets sessions, content, images and rooms while preserving configuration and unrelated identities", async (): Promise<void> => {
    await testEnvironmentResponse(request(), env);
    await env.IMAGES.put(`avatar/${testAccountId("viewer")}/v1`, "image");
    await env.DB.prepare(
      "INSERT INTO user(id,name,email,created_at,updated_at) VALUES('unrelated','Unrelated','unrelated@example.test',1,1)",
    ).run();
    await env.DB.prepare("UPDATE entries SET title='Changed' WHERE author_id=?").bind(testAccountId("viewer")).run();
    await testEnvironmentResponse(request({ action: "seed" }), env);
    expect(
      (await env.DB.prepare("SELECT count(*) AS count FROM entries WHERE title='Changed'").first<{ count: number }>())!
        .count,
    ).toBeGreaterThan(0);
    const response = await testEnvironmentResponse(request({ action: "reset" }), env);
    expect(response.status).toBe(303);
    expect(fetchRoom).toHaveBeenCalledWith(expect.stringContaining("streamerId=00000000-0000-4000-8000-000000000002"), {
      method: "POST",
    });
    expect(await env.IMAGES.get(`avatar/${testAccountId("viewer")}/v1`)).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM session").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM entries WHERE title='Changed'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM user WHERE id='unrelated'").first()).not.toBeNull();
    expect((await env.DB.prepare("SELECT id FROM test_environment_identity").first<{ id: string }>())?.id).toBe(
      identity,
    );
    await env.DB.prepare("DELETE FROM user WHERE id='unrelated'").run();
  });
  it("invalidates reconnected rooms after the database replacement", async (): Promise<void> => {
    await env.DB.prepare("UPDATE entries SET title='Before reset' WHERE author_id=?")
      .bind(testAccountId("viewer"))
      .run();
    const observedTitles: string[] = [];
    fetchRoom.mockImplementation(async (): Promise<Response> => {
      const row = await env.DB.prepare("SELECT title FROM entries WHERE id=?")
        .bind("67500000-0000-4000-8001-000000000090")
        .first<{ title: string }>();
      observedTitles.push(row!.title);
      return new Response(null, { status: 204 });
    });
    await seedTestEnvironment(env, true);
    expect(observedTitles.slice(0, 5)).toEqual(Array<string>(5).fill("Before reset"));
    expect(observedTitles.slice(5)).toEqual(Array<string>(5).fill("Improve overlay text sizing"));
  });

  it("keeps fixture and official-board revisions increasing across repeated resets", async (): Promise<void> => {
    await env.DB.prepare("UPDATE streamers SET revision=revision+50").run();
    const before = await env.DB.prepare("SELECT id,revision FROM streamers").all<{ id: string; revision: number }>();
    for (const round of [1, 2]) {
      await seedTestEnvironment(env, true);
      for (const row of before.results) {
        const current = await env.DB.prepare("SELECT revision FROM streamers WHERE id=?")
          .bind(row.id)
          .first<{ revision: number }>();
        expect(current?.revision).toBe(row.revision + round);
      }
    }
  });

  it("captures writes made during asynchronous image cleanup in the reset batch", async (): Promise<void> => {
    const streamer = (await getStreamer(env, "test_host"))!;
    const before = (await env.DB.prepare("SELECT revision FROM streamers WHERE id=?")
      .bind(streamer.id)
      .first<{ revision: number }>())!.revision;
    const lateRevision: number = before + 100;
    let wrote = false;
    const bucket = new Proxy(env.IMAGES, {
      get(target: R2Bucket, key: string | symbol): unknown {
        if (key === "delete")
          return async (keys: string | string[]): Promise<void> => {
            if (!wrote) {
              wrote = true;
              await env.DB.prepare("UPDATE streamers SET revision=? WHERE id=?").bind(lateRevision, streamer.id).run();
            }
            await target.delete(keys);
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await seedTestEnvironment({ ...env, IMAGES: bucket }, true);
    expect(wrote).toBe(true);
    expect(
      (
        await env.DB.prepare("SELECT revision FROM streamers WHERE id=?")
          .bind(streamer.id)
          .first<{ revision: number }>()
      )?.revision,
    ).toBe(lateRevision + 1);
  });

  it("resets overlay contents above the previous revision across repeated resets", async (): Promise<void> => {
    const streamer = (await getStreamer(env, "test_host"))!;
    await env.DB.prepare(
      "INSERT INTO overlay_state(streamer_id,revision,updated_at,message,air) VALUES(?,100,1,'Old overlay',?) ON CONFLICT(streamer_id) DO UPDATE SET revision=revision+100,message=excluded.message,air=excluded.air",
    )
      .bind(streamer.id, JSON.stringify({ type: "message", ref: null }))
      .run();
    const previous = await getOverlayState(env, streamer.id);
    for (const round of [1, 2]) {
      await seedTestEnvironment(env, true);
      expect(await getOverlayState(env, streamer.id)).toEqual({
        ...DEFAULT_OVERLAY,
        revision: previous.revision + round,
      });
    }
  });

  it("retains the last revision when a fixture page was deleted before reset", async (): Promise<void> => {
    const streamer = (await getStreamer(env, "test_host"))!;
    await env.DB.prepare("UPDATE streamers SET revision=revision+100 WHERE id=?").bind(streamer.id).run();
    await env.DB.prepare(
      "INSERT INTO overlay_state(streamer_id,revision,updated_at) VALUES(?,100,1) ON CONFLICT(streamer_id) DO UPDATE SET revision=revision+100",
    )
      .bind(streamer.id)
      .run();
    const previousOverlay = await getOverlayState(env, streamer.id);
    const previous = (await env.DB.prepare("SELECT revision FROM streamers WHERE id=?")
      .bind(streamer.id)
      .first<{ revision: number }>())!.revision;
    await env.DB.prepare("DELETE FROM streamers WHERE id=?").bind(streamer.id).run();
    await seedTestEnvironment(env, true);
    expect(
      (
        await env.DB.prepare("SELECT revision FROM streamers WHERE id=?")
          .bind(streamer.id)
          .first<{ revision: number }>()
      )?.revision,
    ).toBe(previous + 1);
    expect(await getOverlayState(env, streamer.id)).toEqual({
      ...DEFAULT_OVERLAY,
      revision: previousOverlay.revision + 1,
    });
  });

  it("stops reset if live state cannot be cleared", async (): Promise<void> => {
    fetchRoom.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(seedTestEnvironment(env, true)).rejects.toMatchObject({ status: 503 });
    expect(await env.DB.prepare("SELECT id FROM user WHERE id=?").bind(testAccountId("viewer")).first()).not.toBeNull();
  });
});
