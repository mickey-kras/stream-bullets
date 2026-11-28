import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { appContext, type AppEnv } from "../app/env";
import { notifyActivityPage, notifyOverlayKey } from "../app/server/live.server";
import { action } from "../app/routes/api";
import { mutateEntry } from "../app/server/data.server";

vi.mock("../app/server/auth.server", () => ({
  getViewer: vi.fn().mockResolvedValue({ id: "viewer" }),
  configuredProviders: vi.fn(),
}));
vi.mock("../app/server/data.server", () => ({
  getStreamer: vi.fn().mockResolvedValue({ id: "streamer" }),
  mutateEntry: vi.fn().mockResolvedValue({ id: "entry" }),
}));

afterEach(() => vi.restoreAllMocks());

async function mutate(fetchRoom: () => Promise<Response>): Promise<Response> {
  const context = new RouterContextProvider();
  context.set(appContext, {
    env: {
      APP_ORIGIN: "https://app.example",
      DB: {} as D1Database,
      IMAGES: {} as R2Bucket,
      REQUEST_LIMITER: {} as RateLimit,
      BETTER_AUTH_SECRET: "test-secret",
      CHANNEL_INGEST: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 })) }),
      } as unknown as DurableObjectNamespace,
      POLL_ROOMS: {
        idFromName: vi.fn(),
        idFromString: vi.fn(),
        newUniqueId: vi.fn(),
        getByName: vi.fn(),
        jurisdiction: vi.fn(),
        get: vi.fn().mockReturnValue({ fetch: fetchRoom }),
      },
    },
    nonce: "nonce",
    responseHeaders: new Headers(),
  });
  return action({
    request: new Request("https://app.example/api/streamers/test_host", {
      method: "POST",
      headers: { Origin: "https://app.example", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id: "12345678-1234-4234-8234-123456789012" }),
    }),
    params: { "*": "streamers/test_host" },
    context,
    url: new URL("https://app.example/api/streamers/test_host"),
    pattern: "/api/*",
  });
}

describe("live notification failure recovery", () => {
  it("preserves committed mutation success and logs safe transport diagnostics", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await mutate(() => Promise.reject(new TypeError("secret credential")));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "entry" });
    expect(log.mock.calls).toEqual([["live_refresh_failed", { cause: "transport_error" }]]);
  });

  it("records the failed room response status", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await mutate(() => Promise.resolve(new Response(null, { status: 503 })));
    expect(response.status).toBe(200);
    expect(log.mock.calls).toEqual([["live_refresh_failed", { status: 503 }]]);
  });

  it("classifies other room failures without their message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await mutate(() => Promise.reject(new Error("secret credential")));
    expect(response.status).toBe(200);
    expect(log.mock.calls).toEqual([["live_refresh_failed", { cause: "unexpected_error" }]]);
  });
});

describe("overlay key revocation notices", () => {
  type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
  const done: Fetch = (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 }));

  function envWith(ingestFetch: Fetch, roomFetch: Fetch = done): AppEnv {
    return {
      POLL_ROOMS: { idFromName: (name: string) => name, get: () => ({ fetch: roomFetch }) },
      CHANNEL_INGEST: { idFromName: (name: string) => name, get: () => ({ fetch: ingestFetch }) },
    } as unknown as AppEnv;
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("tells the live room and the activity feed which output lost its key", async () => {
    const calls: { target: string; path: string; method: string | undefined; body: unknown }[] = [];
    const record =
      (target: string): Fetch =>
      (url: string, init?: RequestInit): Promise<Response> => {
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ target, path: new URL(url).pathname, method: init?.method, body });
        return Promise.resolve(new Response(null, { status: 204 }));
      };
    notifyOverlayKey(envWith(record("ingest"), record("room")), "streamer", "vertical");
    notifyOverlayKey(envWith(record("ingest"), record("room")), "streamer", "horizontal");
    await settle();
    type Call = (typeof calls)[number];
    const sorted: Call[] = [...calls].sort((a: Call, b: Call): number => a.target.localeCompare(b.target));
    expect(sorted).toEqual([
      { target: "ingest", path: "/overlay-key", method: "POST", body: { output: "vertical" } },
      { target: "ingest", path: "/overlay-key", method: "POST", body: { output: "horizontal" } },
      { target: "room", path: "/overlay-key", method: "POST", body: { output: "vertical" } },
      { target: "room", path: "/overlay-key", method: "POST", body: { output: "horizontal" } },
    ]);
  });

  it("asks the activity feed to close the old key's sockets, and logs failures without details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    notifyOverlayKey(
      envWith(() => {
        calls.push("ingest");
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
      "streamer",
      "horizontal",
    );
    await settle();
    expect(calls).toEqual(["ingest"]);
    notifyOverlayKey(
      envWith(() => Promise.resolve(new Response(null, { status: 500 }))),
      "streamer",
      "horizontal",
    );
    notifyOverlayKey(
      envWith(() => Promise.reject(new TypeError("secret"))),
      "streamer",
      "vertical",
    );
    notifyActivityPage(
      envWith(() => Promise.reject(new Error("secret"))),
      "streamer",
    );
    await settle();
    expect(log.mock.calls).toEqual([
      ["activity_notify_failed", { path: "overlay-key", status: 500 }],
      ["activity_notify_failed", { path: "overlay-key", cause: "transport_error" }],
      ["activity_notify_failed", { path: "page-status", cause: "unexpected_error" }],
    ]);
  });
});

describe("the goal for votes", () => {
  const poll = "12345678-1234-4234-8234-123456789012";
  const topic = "12345678-1234-4234-8234-000000000077";
  type Call = { path: string; body: unknown };

  function namespace(fetch: (url: string, init?: RequestInit) => Promise<Response>): DurableObjectNamespace {
    return { idFromName: (name: string) => name, get: () => ({ fetch }) } as unknown as DurableObjectNamespace;
  }

  /** One mutation of the public page by the viewer `viewer`. It gives the requests to the activity feed. */
  async function post(body: unknown, env: Partial<AppEnv> = {}): Promise<{ status: number; calls: Call[] }> {
    const calls: Call[] = [];
    const ingest = (url: string, init?: RequestInit): Promise<Response> => {
      const parsed: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ path: new URL(url).pathname, body: parsed });
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const done = (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 }));
    const context = new RouterContextProvider();
    context.set(appContext, {
      env: {
        APP_ORIGIN: "https://app.example",
        DB: {} as D1Database,
        IMAGES: {} as R2Bucket,
        REQUEST_LIMITER: {} as RateLimit,
        BETTER_AUTH_SECRET: "test-secret",
        CHANNEL_INGEST: namespace(ingest),
        POLL_ROOMS: namespace(done),
        ...env,
      },
      nonce: "nonce",
      responseHeaders: new Headers(),
    });
    const response = await action({
      request: new Request("https://app.example/api/streamers/test_host", {
        method: "POST",
        headers: { Origin: "https://app.example", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      params: { "*": "streamers/test_host" },
      context,
      url: new URL("https://app.example/api/streamers/test_host"),
      pattern: "/api/*",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { status: response.status, calls };
  }

  it("tells the activity feed of each poll vote, with the same key for a changed vote", async () => {
    const first = await post({ action: "vote", id: poll, choice: 0 });
    const changed = await post({ action: "vote", id: poll, choice: 1 });
    for (const result of [first, changed]) {
      expect(result.status).toBe(200);
      expect(result.calls).toEqual([{ path: "/goal-count", body: { op: "count", key: `vote:${poll}:viewer` } }]);
    }
  });

  it("tells the activity feed of each new topic, and of no other change", async () => {
    vi.mocked(mutateEntry).mockResolvedValueOnce({ id: topic });
    const created = await post({ action: "create", kind: "topic", title: "A topic", body: "Details", category: "Gaming" });
    expect(created.status).toBe(200);
    expect(created.calls).toEqual([{ path: "/goal-count", body: { op: "count", key: `topic:${topic}` } }]);
    for (const body of [
      { action: "create", kind: "choice", title: "A poll", options: ["A", "B"] },
      { action: "react", id: poll, value: 1 },
      { action: "reveal", id: poll },
      { action: "delete", id: poll },
    ]) {
      const other = await post(body);
      expect(other.status, JSON.stringify(body)).toBe(200);
      expect(other.calls, JSON.stringify(body)).toEqual([]);
    }
  });

  it("tells nothing while the activity feed is off, and logs a failure without the key", async () => {
    expect((await post({ action: "vote", id: poll, choice: 0 }, { CHANNELS_OFF: "1" })).calls).toEqual([]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = namespace((): Promise<Response> => Promise.resolve(new Response(null, { status: 503 })));
    expect((await post({ action: "vote", id: poll, choice: 0 }, { CHANNEL_INGEST: failing })).status).toBe(200);
    expect(log.mock.calls).toEqual([["activity_notify_failed", { path: "goal-count", status: 503 }]]);
  });
});
