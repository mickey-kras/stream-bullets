import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import {
  isRouteErrorResponse,
  ServerRouter,
  type EntryContext,
  type HandleErrorFunction,
  type RouterContextProvider,
} from "react-router";
import { appContext } from "./env";
import { requestLocale } from "./i18n/resolve";
import { withLocale } from "./i18n/server";
import { NonceContext } from "./lib/nonce";
import { logError } from "./server/http.server";
import { requestId } from "./server/route-errors.server";

export const handleError: HandleErrorFunction = (error, { request, context }) => {
  // A client error, like the 404 of an address with no route, is not a server failure.
  if (isRouteErrorResponse(error) && error.status < 500) return;
  if (!request.signal.aborted) logError("server_request_failed", error, request, requestId(context.get(appContext)));
};

export default async function handleRequest(
  request: Request,
  status: number,
  headers: Headers,
  routerContext: EntryContext,
  context: RouterContextProvider,
): Promise<Response> {
  const app = context.get(appContext);
  const { nonce } = app;
  // Prefer the root loader's account locale; otherwise use cookie and browser.
  const locale = app.locale ?? requestLocale(request, null);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Language", locale);
  // Keep edge analytics scripts out of app documents, including private overlays and OAuth flows.
  headers.set("Cache-Control", "no-store, no-transform");
  if (request.method === "HEAD") return new Response(null, { status, headers });
  return withLocale(locale, async (): Promise<Response> => {
    const stream = await renderToReadableStream(
      <NonceContext value={nonce}>
        <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
      </NonceContext>,
      {
        nonce,
        signal: request.signal,
        onError(error: unknown) {
          logError("render_failed", error, request, requestId(app));
          status = 500;
        },
      },
    );
    // Bots and SPA mode get the complete document. Browsers get the shell first, so the status
    // and headers are sent before a late render error can change them.
    if (isbot(request.headers.get("User-Agent")) || routerContext.isSpaMode) await stream.allReady;
    return new Response(stream, { status, headers });
  });
}
