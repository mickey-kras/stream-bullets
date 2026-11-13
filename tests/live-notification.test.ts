import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { appContext, type AppEnv } from "../app/env";
import { notifyActivityPage, notifyOverlayKey } from "../app/server/live.server";
import { action } from "../app/routes/api";

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
        get: () => ({ fetch: async (): Promise<Response> => new Response(null, { status: 204 }) }),
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
  function envWith(ingestFetch: () => Promise<Response>): AppEnv {
    const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: ingestFetch }) };
    return {
      POLL_ROOMS: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
      CHANNEL_INGEST: namespace,
    } as unknown as AppEnv;
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("asks the activity feed to close the old key's sockets, and logs failures without details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    notifyOverlayKey(
      envWith(async () => {
        calls.push("ingest");
        return new Response(null, { status: 204 });
      }),
      "streamer",
    );
    await settle();
    expect(calls).toEqual(["ingest"]);
    notifyOverlayKey(envWith(async () => new Response(null, { status: 500 })), "streamer");
    notifyOverlayKey(envWith(() => Promise.reject(new TypeError("secret"))), "streamer");
    notifyActivityPage(envWith(() => Promise.reject(new Error("secret"))), "streamer");
    await settle();
    expect(log.mock.calls).toEqual([
      ["activity_notify_failed", { path: "overlay-key", status: 500 }],
      ["activity_notify_failed", { path: "overlay-key", cause: "transport_error" }],
      ["activity_notify_failed", { path: "page-status", cause: "unexpected_error" }],
    ]);
  });
});
