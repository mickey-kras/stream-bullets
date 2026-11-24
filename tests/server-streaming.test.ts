import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider, type EntryContext } from "react-router";
import { appContext, type AppEnv } from "../app/env";

// The real ServerRouter needs a full route tree; the test controls when the render is complete.
let finish: () => void = (): void => {};
vi.mock("react-dom/server", () => ({
  renderToReadableStream: (): Promise<ReadableStream<Uint8Array> & { allReady: Promise<void> }> => {
    const allReady = new Promise<void>((resolve): void => {
      finish = resolve;
    });
    return Promise.resolve(Object.assign(new ReadableStream<Uint8Array>(), { allReady }));
  },
}));

const { default: handleRequest } = await import("../app/entry.server");

const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

function context(): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(appContext, { env: {} as AppEnv, nonce: "test", responseHeaders: new Headers(), requestId: "test-request", locale: "en" });
  return context;
}

type Outcome = { settled: boolean; response: Promise<Response> };

async function render(userAgent: string, isSpaMode = false): Promise<Outcome> {
  const request = new Request("https://app.example/", { headers: { "User-Agent": userAgent } });
  const outcome: Outcome = { settled: false, response: Promise.resolve(new Response()) };
  outcome.response = handleRequest(request, 200, new Headers(), { isSpaMode } as EntryContext, context()).then((response: Response): Response => {
    outcome.settled = true;
    return response;
  });
  // Let every step before the wait for the complete render run.
  await new Promise((resolve): void => {
    setTimeout(resolve, 0);
  });
  return outcome;
}

afterEach(() => finish());

describe("server rendering", () => {
  it("streams the page to a browser before the render is complete", async () => {
    const outcome = await render(BROWSER);
    expect(outcome.settled).toBe(true);
    const response = await outcome.response;
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Language")).toBe("en");
  });

  it("returns the document headers and no body for HEAD", async () => {
    const request = new Request("https://app.example/", { method: "HEAD" });
    const response = await handleRequest(request, 200, new Headers(), {} as EntryContext, context());
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Language")).toBe("en");
    expect(response.body).toBeNull();
  });

  it("sends the complete page to a bot", async () => {
    const outcome = await render(BOT);
    expect(outcome.settled).toBe(false);
    finish();
    expect((await outcome.response).status).toBe(200);
  });

  it("sends the complete page in SPA mode", async () => {
    const outcome = await render(BROWSER, true);
    expect(outcome.settled).toBe(false);
    finish();
    await outcome.response;
  });
});
