import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createStaticHandler,
  createStaticRouter,
  RouterContextProvider,
  StaticRouterProvider,
  type LoaderFunctionArgs,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appContext, type AppContext, type AppEnv } from "../app/env";
import { RouteErrorBoundary } from "../app/components/route-error";
import { HttpError } from "../app/server/http.server";
import { withRouteErrors } from "../app/server/route-errors.server";

function args(): LoaderFunctionArgs {
  const context = new RouterContextProvider();
  context.set(appContext, { env: {} as AppEnv, nonce: "test", responseHeaders: new Headers() });
  return {
    request: new Request("https://stream.example.test/streamers?query=private-search", {
      headers: { "X-Request-ID": "attacker-supplied-id" },
    }),
    context,
    params: {},
    url: new URL("https://stream.example.test/streamers?query=private-search"),
    pattern: "/streamers",
  };
}

afterEach(() => vi.restoreAllMocks());

describe("traceable route failures", () => {
  it("renders the logged request ID without exception details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const input: LoaderFunctionArgs = args();
    const loader = withRouteErrors(async (): Promise<never> => {
      throw new TypeError("D1 query failed for private@example.test with session=secret");
    });
    const handler = createStaticHandler([
      { id: "directory", path: "/streamers", loader, ErrorBoundary: RouteErrorBoundary },
    ]);
    const result = await handler.query(input.request, { requestContext: input.context });
    if (result instanceof Response) throw new Error("Expected a route render, not a redirect.");
    const markup: string = renderToStaticMarkup(
      createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, result), context: result }),
    );
    const app: AppContext = input.context.get(appContext);
    expect(result.statusCode).toBe(500);
    expect(app.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(markup).toContain(`Request ID: ${app.requestId}`);
    expect(app.responseHeaders.get("X-Request-ID")).toBe(app.requestId);
    expect(log).toHaveBeenCalledWith("server_request_failed", expect.objectContaining({ requestId: app.requestId }));
    expect(markup + JSON.stringify(log.mock.calls)).not.toMatch(/private@example|session=secret|private-search|attacker-supplied/);
  });

  it("keeps one ID across loaders and separate IDs across requests", async () => {
    const loader = withRouteErrors(async (): Promise<string> => "loaded");
    const first: LoaderFunctionArgs = args();
    await loader(first);
    const id: string | undefined = first.context.get(appContext).requestId;
    await loader(first);
    expect(first.context.get(appContext).requestId).toBe(id);
    const second: LoaderFunctionArgs = args();
    await loader(second);
    expect(second.context.get(appContext).requestId).not.toBe(id);
  });

  it("preserves redirects and expected HTTP statuses without logging them", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const redirect = new Response(null, { status: 302, headers: { Location: "/streamers" } });
    await expect(withRouteErrors(async (): Promise<never> => { throw redirect; })(args())).rejects.toBe(redirect);
    await expect(withRouteErrors(async (): Promise<never> => { throw new HttpError(403, "Forbidden."); })(args()))
      .rejects.toMatchObject({ status: 403 });
    expect(log).not.toHaveBeenCalled();
  });

  it("does not report a cancelled loader as a server failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const input: LoaderFunctionArgs = args();
    const controller = new AbortController();
    controller.abort();
    input.request = new Request(input.request, { signal: controller.signal });
    await expect(withRouteErrors(async (): Promise<never> => { throw new Error("cancelled"); })(input))
      .rejects.toMatchObject({ status: 500 });
    expect(log).not.toHaveBeenCalled();
  });
});
