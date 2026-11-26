import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import { EMOTE_HOSTS } from "../app/lib/activity";
import { securityHeaders } from "../app/server/http.server";
import type { Orientation } from "../app/lib/overlay-layers";
import { sealSecret, type SealedSecret } from "../app/server/channel-tokens.server";
import {
  constantTimeEqual,
  hashOverlayKey,
  newOverlayKey,
  overlayKeyOutput,
  overlayKeyOutputs,
  overlayKeySchema,
  regenerateOverlayKey,
  showOverlayKey,
} from "../app/server/overlay-key.server";
import { dockKeyMatches, hasDockKey } from "../app/server/dock-key.server";
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

/** Without `output`, the body is `{}`: the horizontal output. */
async function regenerate(user: string, output?: Orientation): Promise<Response> {
  return call("POST", "overlay/key", { user, body: output ? { output } : {} });
}

async function newUrl(user: string = "owner", output?: Orientation): Promise<{ url: string; key: string }> {
  const response = await regenerate(user, output);
  expect(response.status).toBe(200);
  const { url } = await response.json<{ url: string }>();
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
      get: () => ({ fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 })) }),
    } as unknown as DurableObjectNamespace,
    POLL_ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (url: string, init?: RequestInit): Promise<Response> => {
          const target = new URL(url);
          roomCalls.push(`${target.pathname}${target.search} ${typeof init?.body === "string" ? init.body : ""}`);
          return Promise.resolve(new Response(null, { status: 204 }));
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
    const original = Object.getOwnPropertyDescriptor(String.prototype, "codePointAt")!.value as (
      this: string,
      index: number,
    ) => number | undefined;
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
    expect(await overlayKeyOutputs(env, page)).toEqual({ horizontal: false, vertical: false });
    const { url, key } = await newUrl();
    expect(url).toBe(`${origin}/@key_page/overlay?key=${key}`);
    expect(key).toMatch(KEY);
    expect(await overlayKeyOutputs(env, page)).toEqual({ horizontal: true, vertical: false });
    const row = await env.DB.prepare("SELECT * FROM overlay_keys WHERE streamer_id=?").bind(page).first();
    const expectedCreatedAt: unknown = expect.any(Number);
    // This deployment has no encryption keys, so the key is not kept.
    expect(row).toEqual({
      streamer_id: page,
      key_hash: await hashOverlayKey(key),
      key_sealed: null,
      key_id: null,
      created_at: expectedCreatedAt,
      output: "horizontal",
      other_key_hash: null,
      other_key_sealed: null,
      other_key_id: null,
      other_created_at: null,
    });
    expect(JSON.stringify(row)).not.toContain(key);
    expect(await overlayKeyOutput(env, page, key)).toBe("horizontal");
    const state = await call("GET", "overlay", { user: "owner" });
    const text = await state.text();
    expect(text).not.toContain(key);
    expect(text).not.toContain(await hashOverlayKey(key));
  });

  it("refuses a missing, malformed, wrong or other page's key", async (): Promise<void> => {
    const { key } = await newUrl();
    expect(await overlayKeyOutput(env, page, null)).toBeNull();
    expect(await overlayKeyOutput(env, page, "")).toBeNull();
    expect(await overlayKeyOutput(env, page, `${key}=`)).toBeNull();
    expect(await overlayKeyOutput(env, page, newOverlayKey())).toBeNull();
    expect(await overlayKeyOutput(env, frozenPage, key)).toBeNull();
    // A page without a key refuses each key, also a well-formed one.
    expect(await overlayKeyOutput(env, suspendedPage, key)).toBeNull();
  });

  it("revokes the old key when the owner makes a new one, and tells the live room", async (): Promise<void> => {
    const first = await newUrl();
    const second = await newUrl();
    expect(second.key).not.toBe(first.key);
    expect(await overlayKeyOutput(env, page, first.key)).toBeNull();
    expect(await overlayKeyOutput(env, page, second.key)).toBe("horizontal");
    const notice = `/overlay-key?streamerId=${page} {"output":"horizontal"}`;
    expect(roomCalls).toEqual([notice, notice]);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM overlay_keys").first())?.n).toBe(1);
  });

  it("audits each new key with its actor and never logs the key", async (): Promise<void> => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((): void => undefined),
    );
    const { key } = await newUrl();
    await overlayKeyOutput(env, page, key);
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
        metadata: '{"output":"horizontal"}',
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

  it("shows the current link to the owner again, and to no other account", async (): Promise<void> => {
    const keys = `a:${btoa(String.fromCodePoint(...new Uint8Array(32).fill(7)))}`;
    env = { ...env, CHANNEL_TOKEN_KEYS: keys };
    const { url } = await newUrl();
    const shown = await call("POST", "overlay/key/show", { user: "owner", body: {} });
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual({ url });
    expect((await call("POST", "overlay/key/show", { body: {} })).status).toBe(401);
    expect((await call("POST", "overlay/key/show", { user: "viewer", body: {} })).status).toBe(404);
    const stored = await env.DB.prepare("SELECT key_sealed, key_id FROM overlay_keys WHERE streamer_id=?")
      .bind(page)
      .first<{ key_sealed: string; key_id: string }>();
    expect(stored?.key_id).toBe("a");
    expect(stored?.key_sealed).not.toContain(new URL(url).searchParams.get("key"));
    const { results } = await env.DB.prepare(
      "SELECT action, actor_id, metadata FROM moderation_actions WHERE action='overlay_key_shown'",
    ).all<{ action: string; actor_id: string; metadata: string | null }>();
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain(new URL(url).searchParams.get("key"));
    // An encrypted key of one page does not open for another page.
    await newUrl("frozen");
    await env.DB.prepare(
      "UPDATE overlay_keys SET key_sealed=(SELECT key_sealed FROM overlay_keys WHERE streamer_id=?) WHERE streamer_id=?",
    )
      .bind(page, frozenPage)
      .run();
    expect(await (await call("POST", "overlay/key/show", { user: "frozen", body: {} })).json()).toEqual({ url: null });
    env = { ...env, CHANNEL_TOKEN_KEYS: undefined };
  });

  it("shows no link when the key was not kept or its encryption key is gone", async (): Promise<void> => {
    await newUrl();
    expect(await (await call("POST", "overlay/key/show", { user: "owner", body: {} })).json()).toEqual({ url: null });
    const first = `a:${btoa(String.fromCodePoint(...new Uint8Array(32).fill(7)))}`;
    const second = `b:${btoa(String.fromCodePoint(...new Uint8Array(32).fill(9)))}`;
    env = { ...env, CHANNEL_TOKEN_KEYS: first };
    const { url } = await newUrl();
    env = { ...env, CHANNEL_TOKEN_KEYS: `${second},${first}` };
    expect(await (await call("POST", "overlay/key/show", { user: "owner", body: {} })).json()).toEqual({ url });
    env = { ...env, CHANNEL_TOKEN_KEYS: second };
    expect(await (await call("POST", "overlay/key/show", { user: "owner", body: {} })).json()).toEqual({ url: null });
    env = { ...env, CHANNEL_TOKEN_KEYS: undefined };
  });

  it("lets only the page owner make a key, and reads no key with GET", async (): Promise<void> => {
    expect((await call("POST", "overlay/key", { body: {} })).status).toBe(401);
    const stranger = await regenerate("viewer");
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual({ error: "You do not have a streamer page." });
    expect((await call("GET", "overlay/key", { user: "owner" })).status).toBe(405);
    expect((await call("POST", "overlay/key", { user: "owner", body: { key: "chosen" } })).status).toBe(400);
    expect((await call("POST", "overlay/key", { user: "owner", body: { output: "diagonal" } })).status).toBe(400);
    expect((await call("POST", "overlay/key/show", { user: "owner", body: { output: "both" } })).status).toBe(400);
    expect(await overlayKeyOutputs(env, page)).toEqual({ horizontal: false, vertical: false });
    expect(roomCalls).toEqual([]);
  });

  it("refuses a key for a suspended page, and lets a frozen page replace a leaked one", async (): Promise<void> => {
    const suspended = await regenerate("suspended");
    expect(suspended.status).toBe(423);
    expect(await suspended.json()).toMatchObject({ code: "page_suspended" });
    expect(await overlayKeyOutputs(env, suspendedPage)).toEqual({ horizontal: false, vertical: false });
    const { key } = await newUrl("frozen");
    expect(await overlayKeyOutput(env, frozenPage, key)).toBe("horizontal");
    expect((await regenerate("suspended", "vertical")).status).toBe(423);
  });
});

describe("one key for each output", (): void => {
  const KEYS = `a:${btoa(String.fromCodePoint(...new Uint8Array(32).fill(7)))}`;
  const active = { id: page, status: "active" } as const;

  interface KeyColumns {
    output: string;
    key_hash: string;
    key_sealed: string | null;
    other_key_hash: string | null;
    other_key_sealed: string | null;
    other_key_id: string | null;
    other_created_at: number | null;
  }

  async function columns(streamerId: string = page): Promise<KeyColumns | null> {
    return env.DB.prepare(
      `SELECT output, key_hash, key_sealed, other_key_hash, other_key_sealed, other_key_id, other_created_at
        FROM overlay_keys WHERE streamer_id=?`,
    )
      .bind(streamerId)
      .first<KeyColumns>();
  }

  async function shown(output?: Orientation, user: string = "owner"): Promise<string | null> {
    const response = await call("POST", "overlay/key/show", { user, body: output ? { output } : {} });
    expect(response.status).toBe(200);
    return (await response.json<{ url: string | null }>()).url;
  }

  afterEach((): void => {
    env = { ...env, CHANNEL_TOKEN_KEYS: undefined };
  });

  it("reads the output from the request, and takes the horizontal output without one", (): void => {
    expect(overlayKeySchema.parse({})).toEqual({ output: "horizontal" });
    expect(overlayKeySchema.parse({ output: "vertical" })).toEqual({ output: "vertical" });
    for (const body of [{ output: "diagonal" }, { output: null }, { output: "vertical", key: "x" }, { key: "x" }])
      expect(overlayKeySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });

  it("gives each output its own key, in one row, and tells which output a key is for", async (): Promise<void> => {
    const horizontal = await newUrl();
    const vertical = await newUrl("owner", "vertical");
    expect(vertical.key).not.toBe(horizontal.key);
    expect(vertical.url).toBe(`${origin}/@key_page/overlay?key=${vertical.key}`);
    expect(await overlayKeyOutput(env, page, horizontal.key)).toBe("horizontal");
    expect(await overlayKeyOutput(env, page, vertical.key)).toBe("vertical");
    expect(await overlayKeyOutput(env, page, newOverlayKey())).toBeNull();
    expect(await overlayKeyOutputs(env, page)).toEqual({ horizontal: true, vertical: true });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM overlay_keys").first())?.n).toBe(1);
    const expectedTime: unknown = expect.any(Number);
    expect(await columns()).toEqual({
      output: "horizontal",
      key_hash: await hashOverlayKey(horizontal.key),
      key_sealed: null,
      other_key_hash: await hashOverlayKey(vertical.key),
      other_key_sealed: null,
      other_key_id: null,
      other_created_at: expectedTime,
    });
  });

  it("replaces the key of one output and keeps the key of the other", async (): Promise<void> => {
    const horizontal = await newUrl();
    const vertical = await newUrl("owner", "vertical");
    roomCalls = [];
    const nextVertical = await newUrl("owner", "vertical");
    expect(await overlayKeyOutput(env, page, vertical.key)).toBeNull();
    expect(await overlayKeyOutput(env, page, nextVertical.key)).toBe("vertical");
    expect(await overlayKeyOutput(env, page, horizontal.key)).toBe("horizontal");
    const nextHorizontal = await newUrl("owner", "horizontal");
    expect(await overlayKeyOutput(env, page, horizontal.key)).toBeNull();
    expect(await overlayKeyOutput(env, page, nextHorizontal.key)).toBe("horizontal");
    expect(await overlayKeyOutput(env, page, nextVertical.key)).toBe("vertical");
    // The live room hears which output lost its key.
    expect(roomCalls).toEqual([
      `/overlay-key?streamerId=${page} {"output":"vertical"}`,
      `/overlay-key?streamerId=${page} {"output":"horizontal"}`,
    ]);
  });

  it("makes the first key of a page for the vertical output, then adds the horizontal key", async (): Promise<void> => {
    const vertical = await newUrl("owner", "vertical");
    expect(await overlayKeyOutputs(env, page)).toEqual({ horizontal: false, vertical: true });
    expect(await columns()).toMatchObject({
      output: "vertical",
      key_hash: await hashOverlayKey(vertical.key),
      other_key_hash: null,
    });
    expect(await overlayKeyOutput(env, page, vertical.key)).toBe("vertical");
    const horizontal = await newUrl("owner", "horizontal");
    expect(await columns()).toMatchObject({
      output: "vertical",
      key_hash: await hashOverlayKey(vertical.key),
      other_key_hash: await hashOverlayKey(horizontal.key),
    });
    expect(await overlayKeyOutput(env, page, vertical.key)).toBe("vertical");
    expect(await overlayKeyOutput(env, page, horizontal.key)).toBe("horizontal");
  });

  it("reads the key of a page that showed the vertical orientation as the vertical key", async (): Promise<void> => {
    // The row of a page from before the two outputs, after the migration set its output.
    const old: string = newOverlayKey();
    await env.DB.prepare(
      "INSERT INTO overlay_keys (streamer_id, key_hash, created_at, output) VALUES (?, ?, 1, 'vertical')",
    )
      .bind(page, await hashOverlayKey(old))
      .run();
    expect(await overlayKeyOutput(env, page, old)).toBe("vertical");
    expect(await overlayKeyOutputs(env, page)).toEqual({ horizontal: false, vertical: true });
    const horizontal = await newUrl();
    expect(await columns()).toMatchObject({
      output: "vertical",
      key_hash: await hashOverlayKey(old),
      other_key_hash: await hashOverlayKey(horizontal.key),
    });
    expect(await overlayKeyOutput(env, page, old)).toBe("vertical");
    expect(await overlayKeyOutput(env, page, horizontal.key)).toBe("horizontal");
  });

  it("refuses a row with an output that is not an output", async (): Promise<void> => {
    await env.DB.prepare(
      "INSERT INTO overlay_keys (streamer_id, key_hash, created_at, output) VALUES (?, ?, 1, 'diagonal')",
    )
      .bind(page, "a".repeat(64))
      .run();
    await expect(overlayKeyOutput(env, page, newOverlayKey())).rejects.toThrow();
  });

  it("shows the link of each output again, and never the link of the other output", async (): Promise<void> => {
    env = { ...env, CHANNEL_TOKEN_KEYS: KEYS };
    const horizontal = await newUrl();
    expect(await shown("vertical")).toBeNull();
    const vertical = await newUrl("owner", "vertical");
    expect(await shown()).toBe(horizontal.url);
    expect(await shown("horizontal")).toBe(horizontal.url);
    expect(await shown("vertical")).toBe(vertical.url);
    const stored = await columns();
    expect(stored?.other_key_id).toBe("a");
    expect(stored?.other_key_sealed).not.toContain(vertical.key);
    // The strict write quota counts each request above.
    await env.DB.prepare("DELETE FROM app_rate_limits").run();
    // An encrypted key in the slot of the other output does not open: its hash and its context are different.
    await env.DB.prepare("UPDATE overlay_keys SET other_key_sealed=key_sealed WHERE streamer_id=?").bind(page).run();
    expect(await shown("vertical")).toBeNull();
    expect(await shown("horizontal")).toBe(horizontal.url);
    const { results } = await env.DB.prepare(
      "SELECT metadata FROM moderation_actions WHERE action='overlay_key_shown' ORDER BY created_at, rowid",
    ).all<{ metadata: string | null }>();
    expect(results.map((row: { metadata: string | null }): string | null => row.metadata).sort()).toEqual([
      '{"output":"horizontal"}',
      '{"output":"horizontal"}',
      '{"output":"horizontal"}',
      '{"output":"vertical"}',
    ]);
  });

  it("shows a link that the server kept before the two outputs", async (): Promise<void> => {
    env = { ...env, CHANNEL_TOKEN_KEYS: KEYS };
    const old: string = newOverlayKey();
    const kept: SealedSecret | null = await sealSecret(env, `overlay-key|${page}`, old);
    expect(kept).not.toBeNull();
    const insert = (output: Orientation): Promise<unknown> =>
      env.DB.prepare(
        `INSERT INTO overlay_keys (streamer_id, key_hash, key_sealed, key_id, created_at, output) VALUES (?, ?, ?, ?, 1, ?)
          ON CONFLICT(streamer_id) DO UPDATE SET output=excluded.output`,
      )
        .bind(page, oldHash, kept?.sealed ?? null, kept?.keyId ?? null, output)
        .run();
    const oldHash: string = await hashOverlayKey(old);
    await insert("horizontal");
    expect(await shown("horizontal")).toBe(`${origin}/@key_page/overlay?key=${old}`);
    expect(await shown("vertical")).toBeNull();
    // The same row after the migration gave it to the vertical output.
    await insert("vertical");
    expect(await shown("vertical")).toBe(`${origin}/@key_page/overlay?key=${old}`);
    expect(await shown("horizontal")).toBeNull();
    // The functions agree with the API.
    expect(await showOverlayKey(env, "owner", page, "vertical")).toBe(old);
    expect(await showOverlayKey(env, "owner", frozenPage, "vertical")).toBeNull();
  });

  it("audits a new key with its actor and its output, and never the key or its hash", async (): Promise<void> => {
    const key: string = await regenerateOverlayKey(env, "owner", active, "vertical");
    const audit = await env.DB.prepare("SELECT action, actor_id, metadata FROM moderation_actions").all();
    expect(audit.results).toEqual([
      { action: "overlay_key_regenerated", actor_id: "owner", metadata: '{"output":"vertical"}' },
    ]);
    expect(JSON.stringify(audit.results)).not.toContain(key);
    expect(JSON.stringify(audit.results)).not.toContain(await hashOverlayKey(key));
  });

  it("keeps the two keys when two requests make them at the same time", async (): Promise<void> => {
    const [horizontal, vertical] = await Promise.all([
      regenerateOverlayKey(env, "owner", active, "horizontal"),
      regenerateOverlayKey(env, "owner", active, "vertical"),
    ]);
    expect(await overlayKeyOutput(env, page, horizontal)).toBe("horizontal");
    expect(await overlayKeyOutput(env, page, vertical)).toBe("vertical");
  });
});

describe("the key of the OBS dock", (): void => {
  const poll = "30000000-0000-4000-8000-000000000011";
  const topic = "30000000-0000-4000-8000-000000000012";

  async function dockUrl(user: string = "owner"): Promise<{ url: string; key: string }> {
    const response = await call("POST", "dock/key", { user, body: {} });
    expect(response.status).toBe(200);
    const { url } = await response.json<{ url: string }>();
    return { url, key: new URL(url).searchParams.get("key") ?? "" };
  }
  /** A dock request: no session, and the key in the header. */
  const dock = (path: string, body: unknown, key?: string, handle: string = "key_page"): Promise<Response> =>
    call("POST", `dock/${handle}/${path}`, { body, headers: key === undefined ? {} : { "X-SB-Dock-Key": key } });
  const code = async (response: Response): Promise<string | undefined> =>
    (await response.json<{ code?: string }>()).code;
  const hide = { action: "showResults", on: false };

  beforeEach(async (): Promise<void> => {
    await env.DB.prepare(
      `INSERT INTO entries (id,streamer_id,author_id,kind,title,options,created_at) VALUES
        (?1,?3,'owner','choice','Pick one','["A","B"]',2), (?2,?3,'viewer','topic','A topic','[]',1)`,
    )
      .bind(poll, topic, page)
      .run();
  });

  it("gives the owner the dock link once, stores only its hash, and closes the old dock sockets", async (): Promise<void> => {
    const { url, key } = await dockUrl();
    expect(url).toBe(`${origin}/@key_page/dock?key=${key}`);
    expect(key).toMatch(KEY);
    const row = await env.DB.prepare("SELECT * FROM dock_keys WHERE streamer_id=?").bind(page).first();
    expect(row).toMatchObject({ streamer_id: page, key_hash: await hashOverlayKey(key) });
    expect(JSON.stringify(row)).not.toContain(key);
    expect(await dockKeyMatches(env, page, key)).toBe(true);
    expect(await hasDockKey(env, page)).toBe(true);
    expect(await hasDockKey(env, frozenPage)).toBe(false);
    // The live room and the activity feed drop the sockets of the dock, and no OBS source.
    expect(roomCalls).toEqual([`/overlay-key?streamerId=${page} {"output":"dock"}`]);
    // The audit names the actor, never the key or its hash.
    const audits = await env.DB.prepare("SELECT * FROM moderation_actions WHERE action='dock_key_regenerated'").all();
    expect(audits.results).toHaveLength(1);
    expect(audits.results[0]).toMatchObject({ actor_id: "owner", streamer_id: page });
    expect(JSON.stringify(audits.results)).not.toContain(key);
    expect(JSON.stringify(audits.results)).not.toContain(await hashOverlayKey(key));
    // A new link revokes the old one.
    const next = await dockUrl();
    expect(next.key).not.toBe(key);
    expect(await dockKeyMatches(env, page, key)).toBe(false);
    expect(await dockKeyMatches(env, page, next.key)).toBe(true);
    expect((await dock("overlay", hide, key)).status).toBe(403);
  });

  it("lets only the page owner make the link, and not for a suspended page", async (): Promise<void> => {
    expect((await call("POST", "dock/key", { user: "viewer", body: {} })).status).toBe(404);
    expect((await call("POST", "dock/key", { body: {} })).status).toBe(401);
    expect((await call("POST", "dock/key", { user: "owner", body: { output: "vertical" } })).status).toBe(400);
    expect((await call("POST", "dock/key", { user: "suspended", body: {} })).status).toBe(423);
    expect((await call("POST", "dock/key", { user: "frozen", body: {} })).status).toBe(200);
  });

  it("runs a live control with the dock key and no session, and tells OBS", async (): Promise<void> => {
    const { key } = await dockUrl();
    roomCalls = [];
    const hidden = await dock("overlay", hide, key);
    expect(hidden.status).toBe(200);
    expect((await hidden.json<{ overlay: { showResults: boolean } }>()).overlay.showResults).toBe(false);
    expect(roomCalls).toEqual([`/overlay?streamerId=${page} `]);
    // The controls of the Live section: the message, and the poll, the topic, and the message banner on stream.
    for (const action of [
      { action: "message", text: "Back soon", style: "info" },
      { action: "layers", items: { poll: { enabled: false } } },
      { action: "layers", items: { poll: { qr: false, ref: poll } } },
      { action: "layers", items: { topic: { ref: topic, enabled: true } } },
      { action: "layers", items: { message: { enabled: true } } },
    ])
      expect((await dock("overlay", action, key)).status, JSON.stringify(action)).toBe(200);
  });

  it("refuses a request without the dock key, and never takes an overlay key for a control", async (): Promise<void> => {
    const { key } = await dockUrl();
    const wide = await newUrl("owner", "horizontal");
    const tall = await newUrl("owner", "vertical");
    const other = await dockUrl("frozen");
    for (const wrong of [undefined, "", "short", "A".repeat(43), wide.key, tall.key, other.key]) {
      const refused = await dock("overlay", hide, wrong);
      expect(refused.status, String(wrong)).toBe(403);
      expect(await code(refused)).toBe("dock_key");
      expect((await dock("poll", { id: poll }, wrong)).status, String(wrong)).toBe(403);
    }
    // The same answer for a page that does not exist and for a suspended page.
    expect((await dock("overlay", hide, key, "no_such_page")).status).toBe(403);
    expect((await dock("overlay", hide, key, "gone_page")).status).toBe(403);
    // The keys are for different things: the dock key is not an overlay key, and the reverse.
    expect(await overlayKeyOutput(env, page, key)).toBeNull();
    expect(await dockKeyMatches(env, page, wide.key)).toBe(false);
    expect(await dockKeyMatches(env, page, tall.key)).toBe(false);
    expect(await dockKeyMatches(env, page, null)).toBe(false);
    // Nothing changed.
    const row = await env.DB.prepare("SELECT show_results FROM overlay_state WHERE streamer_id=?").bind(page).first();
    expect(row?.show_results ?? 1).toBe(1);
  });

  it("refuses each change that is not a live control, also with the dock key", async (): Promise<void> => {
    const { key } = await dockUrl();
    const cell = { c: 0, r: 0, w: 10, h: 6 };
    for (const action of [
      { action: "layers", cells: { horizontal: { chat: cell } } },
      { action: "layers", orientation: "vertical" },
      { action: "layers", chat: { enabled: true } },
      { action: "layers", characters: { enabled: true } },
      { action: "layers", camera: { enabled: true } },
      { action: "layers", twitchOnly: { horizontal: true } },
      { action: "layers", items: { card: { enabled: true } } },
      { action: "layers", items: { poll: { backgroundOpacity: 50 } } },
      { action: "layers", items: { poll: { enabled: true } }, cells: { horizontal: { poll: cell } } },
      { action: "layers" },
      { action: "chatTest", on: true },
    ]) {
      const refused = await dock("overlay", action, key);
      expect(refused.status, JSON.stringify(action)).toBe(403);
      expect(await code(refused)).toBe("dock_action");
    }
    expect((await dock("overlay", { action: "unknown" }, key)).status).toBe(400);
    // The dock key is no session: the endpoints of the owner stay closed.
    const headers = { "X-SB-Dock-Key": key };
    expect((await call("POST", "overlay", { body: hide, headers })).status).toBe(401);
    expect((await call("POST", "overlay/key", { body: {}, headers })).status).toBe(401);
    expect((await call("POST", "dock/key", { body: {}, headers })).status).toBe(401);
    expect(
      (
        await call("POST", "overlay/layouts", {
          body: { action: "select", output: "horizontal", id: "preset:gameplay", keep: "My layout" },
          headers,
        })
      ).status,
    ).toBe(401);
  });

  it("closes the voting of a poll of the page, and of nothing else", async (): Promise<void> => {
    const { key } = await dockUrl();
    roomCalls = [];
    const closed = await dock("poll", { id: poll }, key);
    expect(closed.status).toBe(200);
    expect(await env.DB.prepare("SELECT revealed FROM entries WHERE id=?").bind(poll).first()).toEqual({ revealed: 1 });
    expect(roomCalls).toEqual([`/refresh?streamerId=${page} `]);
    expect((await dock("poll", { id: topic }, key)).status).toBe(404);
    expect((await dock("poll", { id: "not-an-id" }, key)).status).toBe(400);
    expect((await dock("poll", { id: poll, extra: true }, key)).status).toBe(400);
    // The key of this page is not a key of a different page.
    await dockUrl("frozen");
    expect((await dock("poll", { id: poll }, key, "frozen_page")).status).toBe(403);
  });
});

describe("the overlay page", (): void => {
  const headers = (path: string): Headers =>
    securityHeaders(new Response("ok"), new Request(`${origin}${path}`), "nonce", origin, false).headers;

  it("sends no Referer, so the key in its URL never leaves the page", (): void => {
    expect(headers("/@key_page/overlay?key=abc").get("Referrer-Policy")).toBe("no-referrer");
    expect(headers("/@key_page").get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers("/tools").get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
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

  // A CSP applies per document, and in-app links reach the composition preview without a new document.
  it("loads emote images only from the emote hosts over HTTPS, on every page", (): void => {
    const emotes: string[] = EMOTE_HOSTS.map((host: string): string => `https://${host}`);
    expect(emotes).toContain("https://static-cdn.jtvnw.net");
    for (const path of [
      "/",
      "/@key_page",
      "/@key_page/overlay?key=abc&layer=chat",
      "/@key_page/overlay/chat",
      "/tools",
      "/settings",
    ]) {
      expect(imageSources(path)).toEqual(["img-src", "'self'", "blob:", "data:", ...emotes]);
      expect(headers(path).get("Content-Security-Policy")).not.toContain("http://static-cdn.jtvnw.net");
    }
  });
});
