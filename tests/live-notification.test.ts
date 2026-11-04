import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { appContext } from "../app/env";
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
