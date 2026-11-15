import { createElement, Suspense, use, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider, type EntryContext } from "react-router";
import handleRequest from "../app/entry.server";
import { appContext, type AppEnv } from "../app/env";

const render = vi.hoisted(() => ({ element: null as ReactElement | null }));
vi.mock("react-router", async (original) => ({
  ...(await original<typeof import("react-router")>()),
  ServerRouter: (): ReactElement | null => render.element,
}));

function context(): RouterContextProvider {
  const result = new RouterContextProvider();
  result.set(appContext, { env: {} as AppEnv, nonce: "test", responseHeaders: new Headers(), locale: "en" });
  return result;
}

function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done): void => { resolve = done; });
  return { promise, resolve };
}

function pendingPage(promise: Promise<string>, rendered: () => void): ReactElement {
  function Content(): ReactElement {
    rendered();
    return createElement("p", null, use(promise));
  }
  return createElement("main", null, createElement(Suspense, { fallback: createElement("p", null, "Loading content") }, createElement(Content)));
}

function request(userAgent: string, isSpaMode: boolean = false, method: string = "GET"): Promise<Response> {
  return handleRequest(
    new Request("https://app.example/", { method, headers: { "User-Agent": userAgent } }),
    200,
    new Headers(),
    { isSpaMode } as EntryContext,
    context(),
  );
}

afterEach((): void => { vi.restoreAllMocks(); });

describe("streaming server rendering", (): void => {
  it("returns and sends the browser shell while suspended content is still pending", async (): Promise<void> => {
    const content = deferred();
    render.element = pendingPage(content.promise, (): void => {});
    const response = await request("Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Language")).toBe("en");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("Loading content");
    content.resolve("Finished content");
    let remaining = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remaining += new TextDecoder().decode(chunk.value);
    }
    expect(remaining).toContain("Finished content");
  });

  it.each([
    ["Googlebot", false],
    ["Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36", true],
  ] as const)("waits for complete HTML for %s with SPA mode %s", async (agent, spa): Promise<void> => {
    const content = deferred();
    let rendering = false;
    let responded = false;
    render.element = pendingPage(content.promise, (): void => { rendering = true; });
    const response = request(agent, spa).then((result: Response): Response => { responded = true; return result; });
    await vi.waitFor((): void => { expect(rendering).toBe(true); });
    expect(responded).toBe(false);
    content.resolve("Finished crawler content");
    const html = await (await response).text();
    expect(html).toContain("Finished crawler content");
    expect(html).not.toContain("Loading content");
  });

  it("does not render a HEAD body", async (): Promise<void> => {
    render.element = createElement("p", null, "Not rendered");
    const response = await request("Googlebot", false, "HEAD");
    expect(response.body).toBeNull();
  });

  it("logs a late rendering failure after sending the shell", async (): Promise<void> => {
    const log = vi.spyOn(console, "error").mockImplementation((): void => {});
    const content = deferred();
    function Content(): ReactElement {
      use(content.promise);
      throw new Error("private render details");
    }
    render.element = createElement(Suspense, { fallback: "Pending" }, createElement(Content));
    const response = await request("Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36");
    expect(response.status).toBe(200);
    content.resolve("fail");
    await response.text();
    expect(log.mock.calls.some(([event]): boolean => event === "render_failed")).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private render details");
  });
});
