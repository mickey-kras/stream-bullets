import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { handleError } from "../app/entry.server";

afterEach(() => vi.restoreAllMocks());

describe("server route error logging", () => {
  it("does not expose exception details, URLs, or credentials in logs", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    handleError(new TypeError("SQL failed: session token secret-value"), {
      request: new Request("https://app.example/api?code=oauth-secret", { headers: { "CF-Ray": "8f1e2d3c4b5a6978-AMS" } }),
      context: new RouterContextProvider(),
      params: {},
    });
    expect(log).toHaveBeenCalledTimes(1);
    const [event, details] = log.mock.calls[0] as [string, { cause: string; frames: string[]; ray: string | null }];
    // Enough to find the failure: the class, where it was thrown and the Ray ID to match the request.
    expect(event).toBe("server_request_failed");
    expect(details.cause).toBe("TypeError");
    expect(details.frames.length).toBeGreaterThan(0);
    expect(details.ray).toBe("8f1e2d3c4b5a6978-AMS");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret-value|oauth-secret|SQL failed/);
  });

  it("logs a thrown non-Error value without frames", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    handleError("boom", { request: new Request("https://app.example/"), context: new RouterContextProvider(), params: {} });
    expect(log.mock.calls).toEqual([["server_request_failed", { cause: "string", frames: [], ray: null }]]);
  });

  it("does not report a cancelled request as a server failure", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    controller.abort();
    handleError(new Error("cancelled"), {
      request: new Request("https://app.example/", { signal: controller.signal }),
      context: new RouterContextProvider(),
      params: {},
    });
    expect(log).not.toHaveBeenCalled();
  });
});
