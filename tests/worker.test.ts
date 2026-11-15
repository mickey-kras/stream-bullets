import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext, AppEnv } from "../app/env";
import { appContext } from "../app/env";
import { hashOverlayKey, regenerateOverlayKey } from "../app/server/overlay-key.server";
import { PollRoom } from "../app/server/poll-room";
import { createEvents } from "../app/server/schedule.server";
import worker from "../worker";
import { apiCaller } from "./helpers/api";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import { installWorkersRuntime, RoomNamespace, serverSocketOf } from "./helpers/room";

vi.mock("cloudflare:workers", () => import("./helpers/room"));

// Stub the generated React Router build.
const router = vi.hoisted(() => ({
  mode: "",
  build: null as unknown,
  calls: [] as { request: Request; context: { get: (key: unknown) => unknown } }[],
}));
vi.mock("virtual:react-router/server-build", () => ({ build: "server-build" }));
vi.mock("react-router", async (original) => ({
  ...(await original<typeof import("react-router")>()),
  createRequestHandler: (build: () => Promise<unknown>, mode: string) => {
    router.mode = mode;
    return async (request: Request, context: { get: (key: unknown) => AppContext }): Promise<Response> => {
      router.build = await build();
      router.calls.push({ request, context });
      context.get(appContext).responseHeaders.append("Set-Cookie", "page=1; Path=/");
      return new Response("page", { headers: { "Content-Type": "text/html" } });
    };
  },
}));

const origin = "https://stream.example.test";
const secret = "test-only-secret-1f0c3f1e9a2b4c5d8e7f6a5b4c3d2e1f";
const day = 86_400_000;
const pageId = "10000000-0000-4000-8000-000000000001";
const png = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
);

let database: TestDatabase;
let env: AppEnv;
// Rate-limit keys and the next admission result.
const limiter = { keys: [] as string[], allow: true };
let forwarded: Request[] = [];

const { cookie } = apiCaller(() => env, origin, secret);

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte: number): string => byte.toString(16).padStart(2, "0")).join("");
}

function fetchPath(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${origin}${path}`, init), env);
}

// Same-origin live connection request.
function live(handle: string, headers: Record<string, string> = {}, query = ""): Promise<Response> {
  return fetchPath(`/api/live/${handle}${query}`, { headers: { Origin: origin, Upgrade: "websocket", ...headers } });
}

// Record room requests and accept the socket.
function capturingRooms(): RoomNamespace<{ fetch: (request: Request) => Promise<Response> }> {
  return new RoomNamespace(() => ({
    fetch: async (request: Request): Promise<Response> => {
      forwarded.push(request);
      return new Response(null, { status: 101, webSocket: new WebSocketPair()[0] } as ResponseInit);
    },
  }));
}

function lastForwarded(): {
  url: string;
  key: string | null;
  user: string | null;
  owner: string | null;
  overlay: string | null;
} {
  const request = forwarded.at(-1);
  if (!request) throw new Error("Nothing reached the room");
  return {
    url: request.url,
    key: request.headers.get("X-Stream-Bullets-Client"),
    user: request.headers.get("X-SB-User"),
    owner: request.headers.get("X-SB-Owner"),
    overlay: request.headers.get("X-SB-Overlay"),
  };
}

beforeAll(async (): Promise<void> => {
  installWorkersRuntime();
  database = await createTestDatabase();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    POLL_ROOMS: capturingRooms() as unknown as DurableObjectNamespace,
    REQUEST_LIMITER: {
      limit: async ({ key }: { key: string }): Promise<{ success: boolean }> => {
        limiter.keys.push(key);
        return { success: limiter.allow };
      },
    } as RateLimit,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: secret,
  };
  await database.bucket.put("logo/owner", png);
});

afterAll(async (): Promise<void> => {
  vi.unstubAllGlobals();
  await database?.dispose();
});

beforeEach(async (): Promise<void> => {
  limiter.keys = [];
  limiter.allow = true;
  forwarded = [];
  router.calls = [];
  env.APP_ORIGIN = origin;
  env.POLL_ROOMS = capturingRooms() as unknown as DurableObjectNamespace;
  const now = Date.now();
  const users = JSON.stringify(["owner", "viewer", "hidden"]);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare(
      `INSERT INTO user (id,name,email,email_verified,created_at,updated_at)
        SELECT value, 'Name '||value, value||'@example.test', 1, ?1, ?1 FROM json_each(?2)`,
    ).bind(now, users),
    env.DB.prepare(
      `INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at)
        SELECT 's-'||value, value||'-session-token', value, ?1, ?2, ?2 FROM json_each(?3)`,
    ).bind(now + day, now, users),
    env.DB.prepare(
      `INSERT INTO streamers (id,owner_id,handle,name,about,is_official,status,logo) VALUES
        (?1,'owner','zed_page','Zed','About zed',0,'active','/images/logo/owner'),
        ('10000000-0000-4000-8000-000000000009','hidden','hidden_page','Hidden','',0,'suspended',NULL)`,
    ).bind(pageId),
  ]);
});

describe("Worker request checks", (): void => {
  it("answers 421 for another host name, with the error origin in the policy", async (): Promise<void> => {
    const response = await worker.fetch(new Request("https://other.example.test/"), env);
    expect(response.status).toBe(421);
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'self' wss://invalid.invalid");
    expect(router.calls).toHaveLength(0);
  });

  it("answers 503 when the app origin is not configured", async (): Promise<void> => {
    env.APP_ORIGIN = "not a url";
    expect((await fetchPath("/")).status).toBe(503);
  });

  it("rate limits by the hashed IPv4 address, IPv6 /64, or 'local' without one", async (): Promise<void> => {
    for (const ip of ["198.51.100.4", "2001:db8:1:2::1", "2001:DB8:1:2:aaaa:bbbb:cccc:dddd", "::ffff:198.51.100.4"])
      await fetchPath("/", { headers: { "CF-Connecting-IP": ip } });
    await fetchPath("/");
    expect(limiter.keys).toEqual([
      await sha256("198.51.100.4"),
      await sha256("2001:db8:1:2::/64"),
      await sha256("2001:db8:1:2::/64"),
      await sha256("198.51.100.4"),
      await sha256("local"),
    ]);
  });

  it("answers 429 with Retry-After once the limiter says no, before any route runs", async (): Promise<void> => {
    limiter.allow = false;
    const response = await fetchPath("/");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(router.calls).toHaveLength(0);
  });
});

describe("Worker test environment", (): void => {
  it("protects pages, images and live connections while allowing protected signed-out journeys", async (): Promise<void> => {
    const testOrigin = "https://test.streambullets.com";
    const testSecret = "test-access-secret-with-at-least-32-bytes";
    const identity = "e475eb5b-db31-43bd-8692-5926711e8faa";
    const testEnv: AppEnv = {
      ...env,
      APP_ENV: "test",
      APP_ORIGIN: testOrigin,
      ADMIN_EMAILS: "admin@example.test",
      TEST_ACCESS_SECRET: testSecret,
      TEST_DATABASE_ID: identity,
      DEPLOYED_COMMIT: "a".repeat(40),
    };
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS test_environment_identity(id TEXT PRIMARY KEY)").run();
    await env.DB.prepare("INSERT OR IGNORE INTO test_environment_identity VALUES(?)").bind(identity).run();
    const form = await worker.fetch(new Request(`${testOrigin}/__test`), testEnv);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain("a".repeat(40));
    for (const path of ["/", "/images/logo/owner", "/api/live/zed_page"]) {
      const response = await worker.fetch(new Request(`${testOrigin}${path}`), testEnv);
      expect(response.status).toBe(403);
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
    expect(router.calls).toHaveLength(0);
    expect(forwarded).toHaveLength(0);
    const unlock = await worker.fetch(
      new Request(`${testOrigin}/__test`, {
        method: "POST",
        headers: { Origin: testOrigin, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: testSecret, action: "login", account: "signedout" }),
      }),
      testEnv,
    );
    expect(unlock.status).toBe(303);
    const cookie: string = unlock.headers
      .getSetCookie()
      .find((value: string): boolean => value.startsWith("__Host-sb-test-access="))!
      .split(";")[0];
    const page = await worker.fetch(new Request(testOrigin, { headers: { Cookie: cookie } }), testEnv);
    expect(page.status).toBe(200);
    expect(page.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await page.text()).toBe("page");
    const controller: ScheduledController = {
      scheduledTime: Date.now(),
      cron: "0 * * * *",
      noRetry: (): void => undefined,
    };
    await expect(
      worker.scheduled(controller, { ...testEnv, TEST_DATABASE_ID: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(worker.scheduled(controller, testEnv)).resolves.toBeUndefined();
  });

  it("rejects production test credentials before router or scheduled jobs", async (): Promise<void> => {
    const unsafe: AppEnv = { ...env, APP_ENV: "production", TEST_ACCESS_SECRET: "test-secret" };
    expect((await worker.fetch(new Request(origin), unsafe)).status).toBe(503);
    expect(router.calls).toHaveLength(0);
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: "0 * * * *", noRetry: (): void => undefined }, unsafe),
    ).rejects.toMatchObject({ status: 503 });
    const hidden = await worker.fetch(new Request(`${origin}/__test`), env);
    expect(hidden.status).toBe(404);
  });
});

describe("Worker pages", (): void => {
  it("hands other paths to React Router with the app context and adds the security headers", async (): Promise<void> => {
    const response = await fetchPath("/streamers?view=all", { headers: { "X-Request-ID": "untrusted-id" } });
    expect(await response.text()).toBe("page");
    expect(router.mode).toBe(import.meta.env.MODE);
    expect(router.build).toMatchObject({ build: "server-build" });
    const [{ request, context }] = router.calls;
    expect(request.url).toBe(`${origin}/streamers?view=all`);
    const app = context.get(appContext) as AppContext;
    expect(app.env).toBe(env);
    expect(app.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(app.requestId).not.toBe("untrusted-id");
    expect(response.headers.get("X-Request-ID")).toBe(app.requestId);
    expect(app.nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
    const policy = response.headers.get("Content-Security-Policy");
    expect(policy).toContain(`'nonce-${app.nonce}'`);
    expect(policy).toContain(`connect-src 'self' wss://stream.example.test`);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.getSetCookie()).toEqual(["page=1; Path=/"]);
  });

  it("uses a new nonce for every request", async (): Promise<void> => {
    await fetchPath("/");
    await fetchPath("/");
    const [first, second] = router.calls.map(({ context }) => (context.get(appContext) as AppContext).nonce);
    expect(first).not.toBe(second);
  });

  it("serves referenced images for GET and HEAD and refuses other methods", async (): Promise<void> => {
    const image = await fetchPath("/images/logo/owner");
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    const head = await fetchPath("/images/logo/owner", { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([200, ""]);
    expect((await fetchPath("/images/logo/owner", { method: "POST", headers: { Origin: origin } })).status).toBe(405);
    expect((await fetchPath("/images/logo/nobody")).status).toBe(404);
    expect(router.calls).toHaveLength(0);
  });
});

describe("Worker calendar feed", (): void => {
  it("serves a listed page's schedule as an inline calendar file", async (): Promise<void> => {
    const response = await fetchPath("/@zed_page/schedule.ics");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="zed_page-schedule.ics"');
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await response.text()).toMatch(/^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
  });

  it("answers HEAD with the headers and no body", async (): Promise<void> => {
    const response = await fetchPath("/@zed_page/schedule.ics", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(await response.text()).toBe("");
  });

  it("refuses other methods, query parameters, unknown and suspended pages", async (): Promise<void> => {
    expect((await fetchPath("/@zed_page/schedule.ics", { method: "POST" })).status).toBe(405);
    expect((await fetchPath("/@zed_page/schedule.ics?x=1")).status).toBe(400);
    expect((await fetchPath("/@nobody_here/schedule.ics")).status).toBe(404);
    expect((await fetchPath("/@hidden_page/schedule.ics")).status).toBe(404);
    expect(router.calls).toHaveLength(0);
  });
});

describe("Worker live connections", (): void => {
  it("forwards the upgrade to the page's room with the trusted client key and no account", async (): Promise<void> => {
    const response = await live("zed_page", { "CF-Connecting-IP": "203.0.113.7" });
    expect(response.status).toBe(101);
    expect((response as Response & { webSocket: unknown }).webSocket).not.toBeNull();
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(lastForwarded()).toEqual({
      url: `https://poll-room.internal/subscribe?streamerId=${pageId}`,
      key: await sha256("203.0.113.7"),
      user: null,
      owner: null,
      overlay: null,
    });
    expect(forwarded[0].headers.get("Upgrade")).toBe("websocket");
  });

  it("strips identity headers a client sends itself", async (): Promise<void> => {
    await live("zed_page", {
      "CF-Connecting-IP": "203.0.113.7",
      "X-Stream-Bullets-Client": "0".repeat(64),
      "X-SB-User": "owner",
      "X-SB-Owner": "1",
      "X-SB-Overlay": "1",
    });
    expect(lastForwarded()).toMatchObject({ key: await sha256("203.0.113.7"), user: null, owner: null, overlay: null });
    await live("zed_page", { Cookie: await cookie("viewer"), "X-SB-User": "owner", "X-SB-Owner": "1" });
    expect(lastForwarded()).toMatchObject({ user: "viewer", owner: null });
  });

  it("marks the signed-in viewer, and the page owner as owner", async (): Promise<void> => {
    await live("zed_page", { Cookie: await cookie("viewer") });
    expect(lastForwarded()).toMatchObject({ user: "viewer", owner: null });
    await live("zed_page", { Cookie: await cookie("owner") });
    expect(lastForwarded()).toMatchObject({ user: "owner", owner: "1" });
  });

  it("marks only a socket with the page's current overlay key as the owner's OBS source", async (): Promise<void> => {
    const key = await regenerateOverlayKey(env, "owner", { id: pageId, status: "active" });
    await live("zed_page", {}, `?key=${key}`);
    expect(lastForwarded()).toMatchObject({ user: null, owner: null, overlay: "1" });
    // Invalid keys receive signed-out seats.
    for (const query of [`?key=${"A".repeat(43)}`, `?key=${key}x`, "?key=", ""]) {
      await live("zed_page", {}, query);
      expect(lastForwarded()).toMatchObject({ user: null, owner: null, overlay: null });
    }
    // Owner sessions need no overlay key.
    await live("zed_page", { Cookie: await cookie("owner") }, `?key=${key}`);
    expect(lastForwarded()).toMatchObject({ user: "owner", owner: "1", overlay: null });
    const next = await regenerateOverlayKey(env, "owner", { id: pageId, status: "active" });
    await live("zed_page", {}, `?key=${key}`);
    expect(lastForwarded().overlay).toBeNull();
    await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(pageId).run();
    await live("zed_page", {}, `?key=${next}`);
    expect(lastForwarded().overlay).toBe("1");
  });

  it("refuses the overlay of a suspended page, even with its key", async (): Promise<void> => {
    const key = "k".repeat(43);
    await env.DB.prepare("INSERT INTO overlay_keys (streamer_id,key_hash,created_at) VALUES (?,?,1)")
      .bind("10000000-0000-4000-8000-000000000009", await hashOverlayKey(key))
      .run();
    expect((await live("hidden_page", {}, `?key=${key}`)).status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  it("counts an IPv6 client by its /64 and an IPv4-mapped address as its IPv4 address", async (): Promise<void> => {
    const keys: (string | null)[] = [];
    for (const ip of [
      "2001:db8:1:2::1",
      "2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd",
      "2001:db8:1:2:ffff::7%eth0",
      "2001:db8:1:3::1",
      "::ffff:192.0.2.1",
      "::ffff:198.51.100.9",
    ]) {
      await live("zed_page", { "CF-Connecting-IP": ip });
      keys.push(lastForwarded().key);
    }
    const network = await sha256("2001:db8:1:2::/64");
    expect(keys).toEqual([
      network,
      network,
      network,
      await sha256("2001:db8:1:3::/64"),
      await sha256("192.0.2.1"),
      await sha256("198.51.100.9"),
    ]);
  });

  it("refuses cross-site requests, query parameters, plain requests and pages that are not listed", async (): Promise<void> => {
    expect((await fetchPath("/api/live/zed_page", { headers: { Upgrade: "websocket" } })).status).toBe(403);
    expect((await live("zed_page", {}, "?x=1")).status).toBe(400);
    expect((await live("zed_page", { Upgrade: "h2c" })).status).toBe(426);
    const post = await fetchPath("/api/live/zed_page", {
      method: "POST",
      headers: { Origin: origin, Upgrade: "websocket" },
    });
    expect(post.status).toBe(426);
    expect((await live("nobody_here")).status).toBe(404);
    // Suspension blocks owners too.
    expect((await live("hidden_page", { Cookie: await cookie("hidden") })).status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });
});

describe("Worker live connections into the room", (): void => {
  beforeEach((): void => {
    const rooms = new RoomNamespace((state) => new PollRoom(state as unknown as DurableObjectState, env));
    env.POLL_ROOMS = rooms as unknown as DurableObjectNamespace;
  });

  it("holds one IPv6 /64 to ten sockets across its addresses", async (): Promise<void> => {
    for (let host = 1; host <= 10; host += 1)
      expect((await live("zed_page", { "CF-Connecting-IP": `2001:db8:1:2::${host}` })).status).toBe(101);
    expect((await live("zed_page", { "CF-Connecting-IP": "2001:db8:1:2:ffff::1" })).status).toBe(429);
    expect((await live("zed_page", { "CF-Connecting-IP": "2001:db8:1:3::1" })).status).toBe(101);
  });

  it("gives each IPv4-mapped client its own ten sockets", async (): Promise<void> => {
    for (let host = 1; host <= 10; host += 1)
      expect((await live("zed_page", { "CF-Connecting-IP": `::ffff:192.0.2.${host}` })).status).toBe(101);
    expect((await live("zed_page", { "CF-Connecting-IP": "::ffff:198.51.100.9" })).status).toBe(101);
  });

  it("admits the owner past the client cap and sends the page's snapshot", async (): Promise<void> => {
    for (let index = 0; index < 10; index += 1) await live("zed_page", { "CF-Connecting-IP": "192.0.2.1" });
    const owner = await live("zed_page", { "CF-Connecting-IP": "192.0.2.1", Cookie: await cookie("owner") });
    expect(owner.status).toBe(101);
    const socket = serverSocketOf((owner as Response & { webSocket: unknown }).webSocket);
    expect(socket.messages()[0]).toMatchObject({ type: "snapshot", polls: [] });
  });

  it("admits the OBS overlay with its key past the client cap, and not with a revoked key", async (): Promise<void> => {
    const key = await regenerateOverlayKey(env, "owner", { id: pageId, status: "active" });
    for (let index = 0; index < 10; index += 1) await live("zed_page", { "CF-Connecting-IP": "192.0.2.1" });
    expect((await live("zed_page", { "CF-Connecting-IP": "192.0.2.1" }, `?key=${key}`)).status).toBe(101);
    await regenerateOverlayKey(env, "owner", { id: pageId, status: "active" });
    expect((await live("zed_page", { "CF-Connecting-IP": "192.0.2.1" }, `?key=${key}`)).status).toBe(429);
  });
});

describe("Worker cron", (): void => {
  it("removes expired data and tops up weekly series", async (): Promise<void> => {
    const tomorrow = new Date(Date.now() + day).toISOString().slice(0, 10);
    const series = await createEvents(env, "owner", {
      title: "Daily stream",
      date: tomorrow,
      time: "18:00",
      tz: "UTC",
      durationMin: 60,
      platform: "twitch",
      url: "https://twitch.tv/zed",
      repeatDays: 127,
    });
    const count = async (sql: string, ...values: unknown[]): Promise<number> =>
      (
        await env.DB.prepare(sql)
          .bind(...values)
          .first<{ n: number }>()
      )?.n ?? 0;
    const written = await count("SELECT count(*) AS n FROM stream_events WHERE series_id=?", series.seriesId);
    const later = Date.now() + 7 * day;
    await worker.scheduled({ scheduledTime: later, cron: "0 * * * *", noRetry: () => undefined }, env);
    expect(await count("SELECT count(*) AS n FROM session")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM stream_events WHERE series_id=?", series.seriesId)).toBeGreaterThan(
      written,
    );
  });

  it("runs the top-up even when cleanup fails, logs the failure and fails the run", async (): Promise<void> => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const real = env.DB;
    const failing = new Proxy(real, {
      get(target: D1Database, key: string | symbol): unknown {
        if (key === "prepare")
          return (sql: string): D1PreparedStatement => {
            if (/DELETE FROM session/i.test(sql)) throw new Error("D1 down");
            return target.prepare(sql);
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const ping = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        worker.scheduled(
          { scheduledTime: Date.now(), cron: "17 * * * *", noRetry: () => undefined },
          { ...env, DB: failing, CRON_HEARTBEAT_URL: "https://hc.example/ping" },
        ),
      ).rejects.toThrow("Cron jobs failed: cleanup");
      expect(log.mock.calls.map((call: unknown[]) => call[0])).toEqual(["cron_cleanup_failed"]);
      // Failed runs send no heartbeat, allowing the monitor to alert.
      expect(ping).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      ping.mockRestore();
    }
  });

  it("pings the heartbeat after a successful run and logs a failed ping", async (): Promise<void> => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const ping = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    try {
      await worker.scheduled(
        { scheduledTime: Date.now(), cron: "17 * * * *", noRetry: () => undefined },
        { ...env, CRON_HEARTBEAT_URL: "https://hc.example/ping" },
      );
      expect(ping).toHaveBeenCalledWith("https://hc.example/ping", { method: "POST" });
      expect(log.mock.calls).toEqual([["cron_heartbeat_failed", { status: 503 }]]);
    } finally {
      log.mockRestore();
      ping.mockRestore();
    }
  });
});

describe("sitemap", (): void => {
  it("serves public pages and all listed profiles, including frozen pages", async (): Promise<void> => {
    await env.DB.prepare(
      "INSERT INTO streamers (id,owner_id,handle,name,status) VALUES ('frozen','viewer','frozen_page','Frozen','frozen')",
    ).run();
    const response = await fetchPath("/sitemap.xml?dialog=login");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    const xml: string = await response.text();
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    for (const path of ["/", "/streamers", "/privacy", "/terms", "/ai", "/@zed_page", "/@frozen_page"]) {
      expect(xml).toContain(`<loc>${origin}${path}</loc>`);
    }
    for (const path of ["hidden_page", "/admin", "/settings", "/overlay", "dialog="]) expect(xml).not.toContain(path);
    expect(router.calls).toHaveLength(0);
  });

  it("handles HEAD and rejects writes", async (): Promise<void> => {
    const head = await fetchPath("/sitemap.xml", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await fetchPath("/sitemap.xml", { method: "POST" })).status).toBe(405);
  });
});
