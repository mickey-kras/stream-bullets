import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import { EMOTE_HOSTS } from "../app/lib/activity";
import { securityHeaders } from "../app/server/http.server";
import {
  constantTimeEqual,
  hasOverlayKey,
  hashOverlayKey,
  newOverlayKey,
  overlayKeyMatches,
} from "../app/server/overlay-key.server";
import { apiCaller } from "./helpers/api";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const origin = "https://overlay-key.example.test";
const secret = "test-only-secret-0f9e8d7c6b5a49382716a5b4c3d2e1f0";
const day = 86_400_000;
const page = "30000000-0000-4000-8000-000000000001";
const frozenPage = "30000000-0000-4000-8000-000000000002";
const suspendedPage = "30000000-0000-4000-8000-000000000003";
const KEY = /^[\w-]{43}$/;

let database: TestDatabase;
let env: AppEnv;
let roomCalls: string[];

const { call } = apiCaller(() => env, origin, secret);

async function regenerate(user: string): Promise<Response> {
  return call("POST", "overlay/key", { user, body: {} });
}

async function newUrl(user: string = "owner"): Promise<{ url: string; key: string }> {
  const response = await regenerate(user);
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  return { url, key: new URL(url).searchParams.get("key") ?? "" };
}

async function seed(): Promise<void> {
  const now = Date.now();
  const users = JSON.stringify(["owner", "viewer", "frozen", "suspended"]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id,name,email,email_verified,created_at,updated_at)
        SELECT value, 'Name '||value, value||'@example.test', 1, ?1, ?1 FROM json_each(?2)`,
    ).bind(now, users),
    env.DB.prepare(
      `INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at)
        SELECT 's-'||value, value||'-session-token', value, ?1, ?2, ?2 FROM json_each(?3)`,
    ).bind(now + day, now, users),
    env.DB.prepare(
      `INSERT INTO streamers (id,owner_id,handle,name,about,is_official,status) VALUES
        (?1,'owner','key_page','Key','',0,'active'),
        (?2,'frozen','frozen_page','Frozen','',0,'frozen'),
        (?3,'suspended','gone_page','Gone','',0,'suspended')`,
    ).bind(page, frozenPage, suspendedPage),
  ]);
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    CHANNEL_INGEST: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (): Promise<Response> => new Response(null, { status: 204 }) }),
    } as unknown as DurableObjectNamespace,
    POLL_ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (url: string): Promise<Response> => {
          const target = new URL(url);
          roomCalls.push(`${target.pathname}${target.search}`);
          return new Response(null, { status: 204 });
        },
      }),
    } as unknown as DurableObjectNamespace,
    REQUEST_LIMITER: {} as RateLimit,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: secret,
  };
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  roomCalls = [];
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM moderation_actions"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
  ]);
  await seed();
});

afterEach((): void => {
  vi.restoreAllMocks();
});

describe("overlay key values", (): void => {
  it("makes 32 random bytes as base64url, different every time", (): void => {
    const keys = new Set(Array.from({ length: 50 }, () => newOverlayKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) {
      expect(key).toMatch(KEY);
      const binary = atob(key.replaceAll("-", "+").replaceAll("_", "/"));
      expect(binary).toHaveLength(32);
    }
  });

  it("hashes a key with SHA-256 as lowercase hex", async (): Promise<void> => {
    expect(await hashOverlayKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await hashOverlayKey("abd")).not.toBe(await hashOverlayKey("abc"));
  });

  it("compares strings whole: same text only, whatever the length or the first difference", (): void => {
    const hash = "a".repeat(64);
    expect(constantTimeEqual(hash, "a".repeat(64))).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual(hash, `b${"a".repeat(63)}`)).toBe(false);
    expect(constantTimeEqual(hash, `${"a".repeat(63)}b`)).toBe(false);
    expect(constantTimeEqual(hash, "a".repeat(63))).toBe(false);
    expect(constantTimeEqual(hash, `${hash}\0`)).toBe(false);
    expect(constantTimeEqual("", hash)).toBe(false);
  });

  it("reads every character, also after the first difference", (): void => {
    const read: number[] = [];
    const original = String.prototype.codePointAt;
    vi.spyOn(String.prototype, "codePointAt").mockImplementation(function (this: string, index: number) {
      read.push(index);
      return original.call(this, index);
    });
    constantTimeEqual("x".repeat(8), "y".repeat(8));
    expect(new Set(read)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(read).toHaveLength(16);
  });
});

describe("making and checking the overlay key", (): void => {
  it("gives the owner a link once, and stores only its hash", async (): Promise<void> => {
    expect(await hasOverlayKey(env, page)).toBe(false);
    const { url, key } = await newUrl();
    expect(url).toBe(`${origin}/@key_page/overlay?key=${key}`);
    expect(key).toMatch(KEY);
    expect(await hasOverlayKey(env, page)).toBe(true);
    const row = await env.DB.prepare("SELECT * FROM overlay_keys WHERE streamer_id=?").bind(page).first();
    expect(row).toEqual({ streamer_id: page, key_hash: await hashOverlayKey(key), created_at: expect.any(Number) });
    expect(JSON.stringify(row)).not.toContain(key);
    expect(await overlayKeyMatches(env, page, key)).toBe(true);
    const state = await call("GET", "overlay", { user: "owner" });
    const text = await state.text();
    expect(text).not.toContain(key);
    expect(text).not.toContain(await hashOverlayKey(key));
  });

  it("refuses a missing, malformed, wrong or other page's key", async (): Promise<void> => {
    const { key } = await newUrl();
    expect(await overlayKeyMatches(env, page, null)).toBe(false);
    expect(await overlayKeyMatches(env, page, "")).toBe(false);
    expect(await overlayKeyMatches(env, page, `${key}=`)).toBe(false);
    expect(await overlayKeyMatches(env, page, newOverlayKey())).toBe(false);
    expect(await overlayKeyMatches(env, frozenPage, key)).toBe(false);
  });

  it("revokes the old key when the owner makes a new one, and tells the live room", async (): Promise<void> => {
    const first = await newUrl();
    const second = await newUrl();
    expect(second.key).not.toBe(first.key);
    expect(await overlayKeyMatches(env, page, first.key)).toBe(false);
    expect(await overlayKeyMatches(env, page, second.key)).toBe(true);
    expect(roomCalls).toEqual([`/overlay-key?streamerId=${page}`, `/overlay-key?streamerId=${page}`]);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM overlay_keys").first())?.n).toBe(1);
  });

  it("audits each new key with its actor and never logs the key", async (): Promise<void> => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((): void => undefined),
    );
    const { key } = await newUrl();
    await overlayKeyMatches(env, page, key);
    const audit = await env.DB.prepare(
      "SELECT target_kind, target_id, streamer_id, action, reason, note, actor_id, metadata FROM moderation_actions",
    ).all();
    expect(audit.results).toEqual([
      {
        target_kind: "streamer",
        target_id: page,
        streamer_id: page,
        action: "overlay_key_regenerated",
        reason: "",
        note: "",
        actor_id: "owner",
        metadata: null,
      },
    ]);
    const hash = await hashOverlayKey(key);
    for (const spy of logs) {
      for (const args of spy.mock.calls) {
        expect(JSON.stringify(args)).not.toContain(key);
        expect(JSON.stringify(args)).not.toContain(hash);
      }
    }
  });

  it("lets only the page owner make a key, and offers no way to read it", async (): Promise<void> => {
    expect((await call("POST", "overlay/key", { body: {} })).status).toBe(401);
    const stranger = await regenerate("viewer");
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual({ error: "You do not have a streamer page." });
    expect((await call("GET", "overlay/key", { user: "owner" })).status).toBe(405);
    expect((await call("POST", "overlay/key", { user: "owner", body: { key: "chosen" } })).status).toBe(400);
    expect(await hasOverlayKey(env, page)).toBe(false);
    expect(roomCalls).toEqual([]);
  });

  it("refuses a key for a suspended page, and lets a frozen page replace a leaked one", async (): Promise<void> => {
    const suspended = await regenerate("suspended");
    expect(suspended.status).toBe(423);
    expect(await hasOverlayKey(env, suspendedPage)).toBe(false);
    const { key } = await newUrl("frozen");
    expect(await overlayKeyMatches(env, frozenPage, key)).toBe(true);
  });
});

describe("the overlay page", (): void => {
  const headers = (path: string): Headers =>
    securityHeaders(new Response("ok"), new Request(`${origin}${path}`), "nonce", origin, false).headers;

  it("sends no Referer, so the key in its URL never leaves the page", (): void => {
    expect(headers("/@key_page/overlay?key=abc").get("Referrer-Policy")).toBe("no-referrer");
    expect(headers("/@key_page").get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers("/overlay-control").get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("keeps the layer in the query, so a layer URL also sends no Referer", (): void => {
    expect(headers("/@key_page/overlay?key=abc&layer=chat").get("Referrer-Policy")).toBe("no-referrer");
    expect(headers("/@key_page/overlay/chat?key=abc").get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  const imageSources = (path: string): string[] | undefined =>
    (headers(path).get("Content-Security-Policy") ?? "")
      .split("; ")
      .find((part: string): boolean => part.startsWith("img-src "))
      ?.split(" ");

  it("loads emote images only from the emote hosts over HTTPS, and only on the overlay pages", (): void => {
    const emotes: string[] = EMOTE_HOSTS.map((host: string): string => `https://${host}`);
    for (const path of ["/@key_page/overlay?key=abc&layer=chat", "/overlay-control"]) {
      expect(imageSources(path)).toEqual(["img-src", "'self'", "blob:", "data:", ...emotes]);
      expect(headers(path).get("Content-Security-Policy")).not.toContain("http://static-cdn.jtvnw.net");
    }
    expect(emotes).toContain("https://static-cdn.jtvnw.net");
    for (const path of ["/", "/@key_page", "/@key_page/overlay/chat", "/settings", "/overlay-control/x"])
      expect(imageSources(path)).toEqual(["img-src", "'self'", "blob:", "data:"]);
  });
});
