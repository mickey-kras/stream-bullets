import { Buffer as NodeBuffer } from "node:buffer";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs, ServerBuild } from "react-router";
import type { AppContext, AppEnv } from "../app/env";
import { appContext } from "../app/env";
import { KEY_REFUSED_CLOSE } from "../app/lib/activity-socket";
import { regenerateDockKey } from "../app/server/dock-key.server";
import { hashOverlayKey, regenerateOverlayKey } from "../app/server/overlay-key.server";
import { PollRoom } from "../app/server/poll-room";
import { resetKickKey, resetRoutes } from "../app/server/channel-webhooks.server";
import { createEvents } from "../app/server/schedule.server";
import worker from "../worker";
import { apiCaller } from "./helpers/api";
import { installFakeProviders } from "./helpers/channels";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import { installWorkersRuntime, RoomNamespace, serverSocketOf } from "./helpers/room";

// Workers globals declare Buffer as any; use the Node constructor type for this Node test.
const Buffer: BufferConstructor = NodeBuffer as BufferConstructor;

vi.mock("cloudflare:workers", () => import("./helpers/room"));

// Stub the generated React Router build.
const router = vi.hoisted((): {
  mode: string;
  build: unknown;
  calls: { request: Request; context: { get: (key: unknown) => unknown } }[];
} => ({
  mode: "",
  build: null,
  calls: [],
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
// Rate-limit keys, the next admission result, and one key prefix that is always refused.
const limiter = { keys: [] as string[], allow: true, refused: null as string | null };
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
    fetch: (request: Request): Promise<Response> => {
      forwarded.push(request);
      return Promise.resolve(new Response(null, { status: 101, webSocket: new WebSocketPair()[0] }));
    },
  }));
}

function lastForwarded(): {
  url: string;
  key: string | null;
  user: string | null;
  owner: string | null;
  overlay: string | null;
  dock: string | null;
} {
  const request = forwarded.at(-1);
  if (!request) throw new Error("Nothing reached the room");
  return {
    url: request.url,
    key: request.headers.get("X-Stream-Bullets-Client"),
    user: request.headers.get("X-SB-User"),
    owner: request.headers.get("X-SB-Owner"),
    overlay: request.headers.get("X-SB-Overlay"),
    dock: request.headers.get("X-SB-Dock"),
  };
}

beforeAll(async (): Promise<void> => {
  installWorkersRuntime();
  database = await createTestDatabase();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    POLL_ROOMS: capturingRooms() as unknown as DurableObjectNamespace,
    CHANNEL_INGEST: capturingRooms() as unknown as DurableObjectNamespace,
    REQUEST_LIMITER: {
      limit: ({ key }: { key: string }): Promise<{ success: boolean }> => {
        limiter.keys.push(key);
        return Promise.resolve({ success: limiter.allow && !(limiter.refused && key.startsWith(limiter.refused)) });
      },
    },
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
  limiter.refused = null;
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
  it("advertises binary label reader compatibility after migration", async (): Promise<void> => {
    const response = await fetchPath("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("X-StreamBullets-Binary-Labels")).toBe("1");
  });

  it("names the deployed commit, so the deployment smoke check can tell the Worker versions apart", async (): Promise<void> => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const served = async (value: string | undefined): Promise<string | null> =>
      (await worker.fetch(new Request(`${env.APP_ORIGIN}/`), { ...env, DEPLOYED_COMMIT: value })).headers.get(
        "X-StreamBullets-Revision",
      );
    expect(await served(commit)).toBe(commit);
    expect(await served(undefined)).toBeNull();
    expect(await served("not a commit")).toBeNull();
  });

  it("answers 421 for another host name, with the error origin in the policy", async (): Promise<void> => {
    const response = await worker.fetch(new Request("https://other.example.test/"), env);
    expect(response.status).toBe(421);
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'self' wss://invalid.invalid");
    expect(router.calls).toHaveLength(0);
  });

  it("sends a plain-HTTP read of the application host to HTTPS, and nothing else", async (): Promise<void> => {
    const host: string = new URL(env.APP_ORIGIN).host;
    const moved = await worker.fetch(new Request(`http://${host}/privacy?lang=en`), env);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("Location")).toBe(`${env.APP_ORIGIN}/privacy?lang=en`);
    expect(moved.headers.get("X-Request-ID")).toMatch(/^[a-f0-9-]{36}$/);
    expect((await worker.fetch(new Request(`http://${host}/`, { method: "HEAD" }), env)).status).toBe(301);
    // A write, another port and another host keep the refusal.
    expect((await worker.fetch(new Request(`http://${host}/api/vote`, { method: "POST" }), env)).status).toBe(421);
    expect((await worker.fetch(new Request(`http://${host}:8080/`), env)).status).toBe(421);
    expect((await worker.fetch(new Request("http://other.example.test/"), env)).status).toBe(421);
    expect(router.calls).toHaveLength(0);
  });

  it("answers 503 when the app origin is not configured", async (): Promise<void> => {
    env.APP_ORIGIN = "not a url";
    expect((await fetchPath("/")).status).toBe(503);
  });

  it("rate limits by the hashed IPv4 address, IPv6 /64, or 'local' without one", async (): Promise<void> => {
    for (const ip of ["198.51.100.4", "2001:db8:1:2::1", "2001:DB8:1:2:aaaa:bbbb:cccc:dddd", "::ffff:198.51.100.4"])
      await fetchPath("/api/auth/get-session", { headers: { "CF-Connecting-IP": ip } });
    await fetchPath("/api/auth/get-session");
    expect(limiter.keys).toEqual([
      `auth:${await sha256("198.51.100.4")}`,
      `auth:${await sha256("2001:db8:1:2::/64")}`,
      `auth:${await sha256("2001:db8:1:2::/64")}`,
      `auth:${await sha256("198.51.100.4")}`,
      `auth:${await sha256("local")}`,
    ]);
  });

  it("keeps public pages, API reads, and images available behind an exhausted shared address", async (): Promise<void> => {
    limiter.allow = false;
    for (const path of ["/@zed_page", "/api/streamers", "/api/streamers.data", "/sitemap.xml"])
      expect((await fetchPath(path)).status).toBe(200);
    for (const method of ["GET", "HEAD"]) {
      const image: Response = await fetchPath("/images/logo/owner", { method });
      expect(image.status).toBe(200);
      await image.arrayBuffer();
    }
    expect(limiter.keys).toEqual([]);
  });

  it("keeps separate write, authentication, private read, and connection quotas", async (): Promise<void> => {
    await fetchPath("/api/topics", { method: "POST" });
    await fetchPath("/api/auth/get-session");
    await fetchPath("/api/account/export");
    await fetchPath("/api/admin/keys");
    await live("zed_page");
    const address: string = await sha256("local");
    expect(limiter.keys).toEqual(
      ["write", "auth", "private-read", "private-read", "connect"].map(
        (scope: string): string => `${scope}:${address}`,
      ),
    );
  });

  it("refuses one exhausted quota and still admits the other request kinds", async (): Promise<void> => {
    limiter.refused = "write:";
    expect((await fetchPath("/api/topics", { method: "POST" })).status).toBe(429);
    expect(router.calls).toHaveLength(0);
    expect((await fetchPath("/api/auth/get-session")).status).toBe(200);
    expect((await fetchPath("/api/account/export")).status).toBe(200);
    expect((await live("zed_page")).status).toBe(101);
  });

  it("matches the router: a data URL reaches the same API loader as its document path", async (): Promise<void> => {
    const { createRequestHandler: actualHandler, RouterContextProvider } =
      await vi.importActual<typeof import("react-router")>("react-router");
    const paths: string[] = [];
    const build: ServerBuild = {
      entry: { module: { default: (): Response => new Response("document") } },
      routes: {
        root: { id: "root", path: "", module: { default: (): null => null } },
        api: {
          id: "api",
          parentId: "root",
          path: "api/*",
          module: {
            default: (): null => null,
            loader: ({ params }: LoaderFunctionArgs): Response => {
              paths.push(params["*"] ?? "");
              return new Response("export");
            },
          },
        },
      },
      assets: { entry: { imports: [], module: "" }, routes: {}, url: "", version: "test" },
      publicPath: "/",
      assetsBuildDirectory: "build/client",
      future: {},
      ssr: true,
      isSpaMode: false,
      prerender: [],
      routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
    };
    const handle: ReturnType<typeof actualHandler> = actualHandler(build, "production");
    for (const path of ["/api/account/export", "/api/account/export.data", "/API/account%2Fexport"]) {
      const response: Response = await handle(new Request(`${origin}${path}`), new RouterContextProvider());
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    expect(paths).toEqual(["account/export", "account/export", "account/export"]);
  });

  it("applies the export quota to the equivalent React Router data URL", async (): Promise<void> => {
    const key: string = `private-read:${await sha256("local")}`;
    for (const path of ["/api/account/export", "/api/account/export.data"])
      expect((await fetchPath(path)).status).toBe(200);
    expect(router.calls).toHaveLength(2);
    expect(limiter.keys).toEqual([key, key]);
    router.calls = [];
    limiter.keys = [];
    limiter.allow = false;
    for (const path of ["/api/account/export", "/api/account/export.data"]) {
      const response: Response = await fetchPath(path);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
    }
    expect(limiter.keys).toEqual([key, key]);
    expect(router.calls).toHaveLength(0);
  });

  it.each([
    ["/api/%61dmin/keys", "private-read"],
    ["/api%2Fadmin%2Fkeys", "private-read"],
    ["/api%252fadmin%252fkeys", "private-read"],
    ["/API/AdMiN/keys", "private-read"],
    ["/api/admin/_.data", "private-read"],
    ["/api/account%2Fexport", "private-read"],
    ["/api/account%252Fexport", "private-read"],
    ["/%61pi/auth/get-session", "auth"],
    ["/API/Auth/get-session", "auth"],
    ["/api%252fauth%252fget-session", "auth"],
  ] as const)(
    "does not bypass %s admission with encoded separators or route casing",
    async (path: string, scope: string): Promise<void> => {
      limiter.allow = false;
      expect((await fetchPath(path)).status).toBe(429);
      expect(limiter.keys).toEqual([`${scope}:${await sha256("local")}`]);
      expect(router.calls).toHaveLength(0);
    },
  );

  it.each(["/api/%", "/api/%zz", "/api/%E0%A4%A"])(
    "rejects malformed path encoding in %s",
    async (path: string): Promise<void> => {
      expect((await fetchPath(path)).status).toBe(400);
      expect(limiter.keys).toEqual([]);
      expect(router.calls).toHaveLength(0);
    },
  );

  it("answers 429 with Retry-After once the limiter says no, before any route runs", async (): Promise<void> => {
    limiter.allow = false;
    const response = await fetchPath("/api/topics", { method: "POST" });
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
      expect(response.headers.get("Cache-Control")).toBe("no-store");
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
    const image: Response = await worker.fetch(
      new Request(`${testOrigin}/images/logo/owner`, { headers: { Cookie: cookie } }),
      testEnv,
    );
    expect([image.status, image.headers.get("Cache-Control")]).toEqual([200, "private, no-cache"]);
    await image.arrayBuffer();
    const missing: Response = await worker.fetch(
      new Request(`${testOrigin}/images/logo/nobody`, { headers: { Cookie: cookie } }),
      testEnv,
    );
    expect([missing.status, missing.headers.get("Cache-Control")]).toEqual([404, "no-store"]);
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
    expect(image.headers.get("Cache-Control")).toBe("public, max-age=60, must-revalidate");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    const head = await fetchPath("/images/logo/owner", { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([200, ""]);
    expect(head.headers.get("Cache-Control")).toBe("public, max-age=60, must-revalidate");
    const refused: Response = await fetchPath("/images/logo/owner", { method: "POST", headers: { Origin: origin } });
    expect([refused.status, refused.headers.get("Cache-Control")]).toEqual([405, "no-store"]);
    const missing: Response = await fetchPath("/images/logo/nobody");
    expect([missing.status, missing.headers.get("Cache-Control")]).toEqual([404, "no-store"]);
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
      dock: null,
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
    const key = await regenerateOverlayKey(env, "owner", { id: pageId, status: "active" }, "horizontal");
    await live("zed_page", {}, `?key=${key}`);
    expect(lastForwarded()).toMatchObject({ user: null, owner: null, overlay: "horizontal" });
    // Invalid keys receive signed-out seats.
    for (const query of [`?key=${"A".repeat(43)}`, `?key=${key}x`, "?key=", ""]) {
      await live("zed_page", {}, query);
      expect(lastForwarded()).toMatchObject({ user: null, owner: null, overlay: null });
    }
    // Owner sessions need no overlay key.
    await live("zed_page", { Cookie: await cookie("owner") }, `?key=${key}`);
    expect(lastForwarded()).toMatchObject({ user: "owner", owner: "1", overlay: null });
    const next = await regenerateOverlayKey(env, "owner", { id: pageId, status: "active" }, "horizontal");
    await live("zed_page", {}, `?key=${key}`);
    expect(lastForwarded().overlay).toBeNull();
    await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(pageId).run();
    await live("zed_page", {}, `?key=${next}`);
    expect(lastForwarded().overlay).toBe("horizontal");
  });

  it("marks a socket with the current dock key, also in a browser with the session of the owner", async (): Promise<void> => {
    const active = { id: pageId, status: "active" } as const;
    const key = await regenerateDockKey(env, "owner", active);
    await live("zed_page", {}, `?key=${key}`);
    expect(lastForwarded()).toMatchObject({ user: null, owner: null, overlay: null, dock: "1" });
    // The room closes the sockets with this mark at a new dock link. A dock of the signed-in owner needs it too.
    await live("zed_page", { Cookie: await cookie("owner") }, `?key=${key}`);
    expect(lastForwarded()).toMatchObject({ user: "owner", owner: "1", overlay: null, dock: "1" });
    // A tab of the owner without a key, and a client that names the mark itself, do not get it.
    await live("zed_page", { Cookie: await cookie("owner") });
    expect(lastForwarded()).toMatchObject({ owner: "1", dock: null });
    await live("zed_page", { "X-SB-Dock": "1" });
    expect(lastForwarded().dock).toBeNull();
    // The old key stops with a new dock link.
    await regenerateDockKey(env, "owner", active);
    await live("zed_page", { Cookie: await cookie("owner") }, `?key=${key}`);
    expect(lastForwarded()).toMatchObject({ owner: "1", dock: null });
  });

  it("names the output of the key: each output has its own key, and a new key for one keeps the other", async (): Promise<void> => {
    const active = { id: pageId, status: "active" } as const;
    const horizontal = await regenerateOverlayKey(env, "owner", active, "horizontal");
    const vertical = await regenerateOverlayKey(env, "owner", active, "vertical");
    await live("zed_page", {}, `?key=${vertical}`);
    expect(lastForwarded()).toMatchObject({ user: null, owner: null, overlay: "vertical" });
    await live("zed_page", {}, `?key=${horizontal}`);
    expect(lastForwarded().overlay).toBe("horizontal");
    // A client cannot name an output itself.
    await live("zed_page", { "X-SB-Overlay": "vertical" });
    expect(lastForwarded().overlay).toBeNull();
    await live("zed_page", { "X-SB-Overlay": "vertical" }, `?key=${horizontal}`);
    expect(lastForwarded().overlay).toBe("horizontal");
    // A new vertical key revokes the old vertical key only.
    const next = await regenerateOverlayKey(env, "owner", active, "vertical");
    await live("zed_page", {}, `?key=${vertical}`);
    expect(lastForwarded().overlay).toBeNull();
    await live("zed_page", {}, `?key=${next}`);
    expect(lastForwarded().overlay).toBe("vertical");
    await live("zed_page", {}, `?key=${horizontal}`);
    expect(lastForwarded().overlay).toBe("horizontal");
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
    const key = await regenerateOverlayKey(env, "owner", { id: pageId, status: "active" }, "horizontal");
    for (let index = 0; index < 10; index += 1) await live("zed_page", { "CF-Connecting-IP": "192.0.2.1" });
    expect((await live("zed_page", { "CF-Connecting-IP": "192.0.2.1" }, `?key=${key}`)).status).toBe(101);
    await regenerateOverlayKey(env, "owner", { id: pageId, status: "active" }, "horizontal");
    expect((await live("zed_page", { "CF-Connecting-IP": "192.0.2.1" }, `?key=${key}`)).status).toBe(429);
  });
});

describe("Worker activity feed and provider webhooks", (): void => {
  function activity(handle: string, headers: Record<string, string> = {}, query = ""): Promise<Response> {
    return fetchPath(`/api/activity/${handle}${query}`, { headers: { Origin: origin, Upgrade: "websocket", ...headers } });
  }

  /** Whether the response is an accepted socket that the Worker closed with the key refusal. */
  async function refusedKey(pending: Promise<Response>): Promise<boolean> {
    const response = await pending;
    if (response.status !== 101) return false;
    const socket = serverSocketOf((response as Response & { webSocket: unknown }).webSocket);
    return socket.closeCode === KEY_REFUSED_CLOSE && socket.closeReason === "Overlay key refused";
  }

  it("forwards the feed only with the current overlay key or the owner's session", async (): Promise<void> => {
    env.CHANNEL_INGEST = capturingRooms() as unknown as DurableObjectNamespace;
    const key = await regenerateOverlayKey(env, "owner", { id: pageId, status: "active" }, "horizontal");
    expect((await activity("zed_page", {}, `?key=${key}`)).status).toBe(101);
    expect(lastForwarded()).toMatchObject({ overlay: "horizontal", owner: null });
    expect(lastForwarded().url).toBe(`https://channel-ingest.internal/subscribe?streamerId=${pageId}`);
    expect((await activity("zed_page", { Cookie: await cookie("owner") })).status).toBe(101);
    expect(lastForwarded()).toMatchObject({ overlay: null, owner: "1" });
    // `characters=1` asks the ingest object for the playground frames too.
    expect((await activity("zed_page", {}, `?key=${key}&characters=1`)).status).toBe(101);
    expect(lastForwarded().url).toBe(`https://channel-ingest.internal/subscribe?streamerId=${pageId}&characters=1`);
    forwarded = [];
    expect((await activity("zed_page", {}, `?key=${key}&characters=0`)).status).toBe(400);
    // Viewers and client-sent identity headers get nothing.
    expect((await activity("zed_page", { Cookie: await cookie("viewer"), "X-SB-Owner": "1" })).status).toBe(403);
    // A wrong or revoked key gets a socket that is closed with the refusal code, so the overlay stops its retries.
    expect(await refusedKey(activity("zed_page", {}, `?key=${"A".repeat(43)}`))).toBe(true);
    expect(await refusedKey(activity("zed_page", { Cookie: await cookie("viewer") }, "?key=short"))).toBe(true);
    await regenerateOverlayKey(env, "owner", { id: pageId, status: "active" }, "horizontal");
    expect(await refusedKey(activity("zed_page", {}, `?key=${key}`))).toBe(true);
    expect((await activity("hidden_page", { Cookie: await cookie("hidden") })).status).toBe(404);
    expect((await activity("zed_page", { Origin: "https://evil.example" }, `?key=${key}`)).status).toBe(403);
    expect((await activity("zed_page", {}, "?other=1")).status).toBe(400);
    expect((await fetchPath("/api/activity/zed_page", { headers: { Origin: origin } })).status).toBe(426);
    expect(forwarded).toHaveLength(0);
  });

  it("forwards the feed with the output of the key, and refuses the old key of an output alone", async (): Promise<void> => {
    env.CHANNEL_INGEST = capturingRooms() as unknown as DurableObjectNamespace;
    const active = { id: pageId, status: "active" } as const;
    const horizontal = await regenerateOverlayKey(env, "owner", active, "horizontal");
    const vertical = await regenerateOverlayKey(env, "owner", active, "vertical");
    expect((await activity("zed_page", {}, `?key=${vertical}`)).status).toBe(101);
    expect(lastForwarded()).toMatchObject({ overlay: "vertical", owner: null });
    expect((await activity("zed_page", {}, `?key=${horizontal}&characters=1`)).status).toBe(101);
    expect(lastForwarded()).toMatchObject({ overlay: "horizontal", owner: null });
    // A header of the client names no output.
    expect((await activity("zed_page", { "X-SB-Overlay": "horizontal" })).status).toBe(403);
    forwarded = [];
    await regenerateOverlayKey(env, "owner", active, "horizontal");
    expect(await refusedKey(activity("zed_page", {}, `?key=${horizontal}`))).toBe(true);
    expect(forwarded).toHaveLength(0);
    expect((await activity("zed_page", {}, `?key=${vertical}`)).status).toBe(101);
    expect(lastForwarded().overlay).toBe("vertical");
  });

  it("refuses one page's overlay key on another page's feed", async (): Promise<void> => {
    env.CHANNEL_INGEST = capturingRooms() as unknown as DurableObjectNamespace;
    const otherId = "10000000-0000-4000-8000-000000000008";
    await env.DB.prepare(
      "INSERT INTO streamers (id,owner_id,handle,name,about,is_official,status) VALUES (?,'viewer','b_page','B','',0,'active')",
    )
      .bind(otherId)
      .run();
    const keyA = await regenerateOverlayKey(env, "owner", { id: pageId, status: "active" }, "horizontal");
    const keyB = await regenerateOverlayKey(env, "viewer", { id: otherId, status: "active" }, "horizontal");
    expect(await refusedKey(activity("b_page", {}, `?key=${keyA}`))).toBe(true);
    expect(await refusedKey(activity("zed_page", {}, `?key=${keyB}`))).toBe(true);
    expect((await activity("b_page", { Cookie: await cookie("owner") })).status).toBe(403);
    expect(forwarded).toHaveLength(0);
    expect((await activity("b_page", {}, `?key=${keyB}`)).status).toBe(101);
    expect(lastForwarded().url).toBe(`https://channel-ingest.internal/subscribe?streamerId=${otherId}`);
  });

  it("drops Kick webhooks and refuses the feed while channels are off", async (): Promise<void> => {
    env.CHANNELS_OFF = "1";
    expect((await fetchPath("/hooks/kick", { method: "POST", body: "{}" })).status).toBe(204);
    expect((await activity("zed_page", { Cookie: await cookie("owner") })).status).toBe(503);
    env.CHANNELS_OFF = undefined;
  });

  it("forwards a signed Kick delivery once and counts its repeats against the per-address limit", async (): Promise<void> => {
    resetRoutes();
    resetKickKey();
    env.CHANNEL_INGEST = capturingRooms() as unknown as DurableObjectNamespace;
    await env.DB.prepare(
      `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,created_at,updated_at)
        VALUES ('kick-conn',?,'kick','333','Host','',1,1)`,
    )
      .bind(pageId)
      .run();
    const keys = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const spki = btoa(String.fromCodePoint(...new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey))));
    // The fake for Kick's public key endpoint, as in tests/channel-webhooks.test.ts.
    const fake = installFakeProviders();
    fake.kickPublicKey = `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----`;
    const body = JSON.stringify({
      message_id: "k-repeat",
      broadcaster: { user_id: 333, username: "host" },
      sender: { user_id: 444, username: "fan", identity: null },
      content: "hello",
      created_at: new Date().toISOString(),
    });
    const id = "kick-repeat-id";
    const timestamp = new Date().toISOString();
    const signature = btoa(
      String.fromCodePoint(
        ...new Uint8Array(
          await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keys.privateKey, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
        ),
      ),
    );
    const deliver = (): Promise<Response> =>
      fetchPath("/hooks/kick", {
        method: "POST",
        body,
        headers: {
          "CF-Connecting-IP": "203.0.113.210",
          "Kick-Event-Message-Id": id,
          "Kick-Event-Message-Timestamp": timestamp,
          "Kick-Event-Signature": signature,
          "Kick-Event-Type": "chat.message.sent",
        },
      });
    try {
      // The first copy reaches the page's ingest object, and the limiter is not asked.
      expect((await deliver()).status).toBe(204);
      expect(forwarded.map((request) => new URL(request.url).pathname)).toEqual(["/event"]);
      expect(limiter.keys).toEqual([]);
      // Repeats are answered at once, never reach the object, and each one counts.
      expect((await deliver()).status).toBe(204);
      expect((await deliver()).status).toBe(204);
      expect(forwarded).toHaveLength(1);
      expect(limiter.keys).toHaveLength(2);
      // Once the limiter is exhausted, a repeat answers 429.
      limiter.allow = false;
      expect((await deliver()).status).toBe(429);
      expect(forwarded).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      installWorkersRuntime();
      await env.DB.prepare("DELETE FROM channel_connections WHERE id='kick-conn'").run();
    }
  });

  it("counts only rejected webhooks against the per-address limit", async (): Promise<void> => {
    limiter.allow = false;
    const secret = "eventsub-secret-0123456789abcdef0123";
    env.TWITCH_EVENTSUB_SECRET = secret;
    const warn = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    // A signed delivery passes without touching the limiter, even when it is exhausted.
    const body = JSON.stringify({
      subscription: { type: "channel.chat.clear", condition: { broadcaster_user_id: "424242" } },
      event: {},
    });
    const id = "delivery-1";
    const timestamp = new Date().toISOString();
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id + timestamp + body)));
    const signature = `sha256=${Array.from(mac, (byte: number): string => byte.toString(16).padStart(2, "0")).join("")}`;
    const signed = await fetchPath("/hooks/twitch", {
      method: "POST",
      body,
      headers: {
        "Twitch-Eventsub-Message-Id": id,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": signature,
        "Twitch-Eventsub-Message-Type": "notification",
      },
    });
    // The channel is unknown here: 410 tells Twitch to drop the subscription. It is not a rejection.
    expect(signed.status).toBe(410);
    expect(limiter.keys).toEqual([]);
    // A server-side failure (no secret) is not the sender's fault: it never counts.
    env.TWITCH_EVENTSUB_SECRET = undefined;
    expect((await fetchPath("/hooks/twitch", { method: "POST", body: "{}" })).status).toBe(503);
    expect(limiter.keys).toEqual([]);
    env.TWITCH_EVENTSUB_SECRET = secret;
    // A forged one counts, and the exhausted limiter answers 429.
    const forged = (path: string, init: RequestInit = {}): Promise<Response> =>
      fetchPath(path, { method: "POST", body: "{}", ...init, headers: { "CF-Connecting-IP": "203.0.113.200", ...init.headers } });
    expect((await forged("/hooks/twitch")).status).toBe(429);
    expect(limiter.keys).toHaveLength(1);
    // A large body and a wrong method count too.
    const kickHeaders = { "Kick-Event-Message-Id": "m", "Kick-Event-Message-Timestamp": "1", "Kick-Event-Signature": "c2ln" };
    expect((await forged("/hooks/kick", { body: "x".repeat(70_000), headers: kickHeaders })).status).toBe(429);
    expect((await forged("/hooks/kick", { method: "PUT" })).status).toBe(429);
    expect(limiter.keys).toHaveLength(3);
    // A stale signed delivery comes from the provider: it never counts, also with an exhausted limiter.
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    const staleMac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id + old + body)));
    const stale = await fetchPath("/hooks/twitch", {
      method: "POST",
      body,
      headers: {
        "Twitch-Eventsub-Message-Id": id,
        "Twitch-Eventsub-Message-Timestamp": old,
        "Twitch-Eventsub-Message-Signature": `sha256=${Array.from(staleMac, (byte: number): string => byte.toString(16).padStart(2, "0")).join("")}`,
        "Twitch-Eventsub-Message-Type": "notification",
      },
    });
    expect(stale.status).toBe(403);
    expect(limiter.keys).toHaveLength(3);
    // A signed but unparsable Twitch delivery comes from Twitch: it never counts.
    const junk = "{not json";
    const junkMac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}x${timestamp}${junk}`)));
    const unparsable = await fetchPath("/hooks/twitch", {
      method: "POST",
      body: junk,
      headers: {
        "Twitch-Eventsub-Message-Id": `${id}x`,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": `sha256=${Array.from(junkMac, (byte: number): string => byte.toString(16).padStart(2, "0")).join("")}`,
        "Twitch-Eventsub-Message-Type": "notification",
      },
    });
    expect(unparsable.status).toBe(400);
    expect(limiter.keys).toHaveLength(3);
    // With room in the limiter, a forged webhook gets its own answer.
    limiter.allow = true;
    const kick = await fetchPath("/hooks/kick", { method: "POST", body: "{}" });
    expect(kick.status).toBe(403);
    expect(await kick.json()).toEqual({ error: "Invalid signature." });
    // At most one rejection log a minute, with no header or body.
    // One log a minute for each platform and reason, with no header or body.
    expect(warn.mock.calls.filter((call) => call[0] === "channel_webhook_rejected")).toEqual([
      ["channel_webhook_rejected", { platform: "twitch", reason: "unavailable" }],
      ["channel_webhook_rejected", { platform: "twitch", reason: "signature" }],
      ["channel_webhook_rejected", { platform: "kick", reason: "size" }],
      ["channel_webhook_rejected", { platform: "kick", reason: "method" }],
      ["channel_webhook_rejected", { platform: "twitch", reason: "stale" }],
      ["channel_webhook_rejected", { platform: "twitch", reason: "payload" }],
      ["channel_webhook_rejected", { platform: "kick", reason: "signature" }],
    ]);
    // Other paths keep the normal limit.
    limiter.allow = false;
    expect((await fetchPath("/hooks/other", { method: "POST" })).status).toBe(429);
    env.TWITCH_EVENTSUB_SECRET = undefined;
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

describe("third-party notices", (): void => {
  it("serves the notices of the shipped packages from this build", async (): Promise<void> => {
    const { readFile } = await import("node:fs/promises");
    const expected: string = await readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
    const response = await fetchPath("/third-party-notices.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const text = await response.text();
    expect(text).toBe(expected);
    expect(text).toMatch(/^## react 19\./m);
    const head = await worker.fetch(new Request(`${env.APP_ORIGIN}/third-party-notices.txt`, { method: "HEAD" }), env);
    expect([head.status, await head.text()]).toEqual([200, ""]);
    const post = await worker.fetch(
      new Request(`${env.APP_ORIGIN}/third-party-notices.txt`, { method: "POST", headers: { Origin: env.APP_ORIGIN } }),
      env,
    );
    expect(post.status).toBe(405);
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
    for (const path of ["/", "/streamers", "/privacy", "/terms", "/ai", "/commands", "/@zed_page", "/@frozen_page"]) {
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
