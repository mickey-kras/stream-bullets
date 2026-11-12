import { renderToReadableStream } from "react-dom/server";
import { ServerRouter, type EntryContext, type HandleErrorFunction, type RouterContextProvider } from "react-router";
import { appContext } from "./env";
import { requestLocale } from "./i18n/resolve";
import { withLocale } from "./i18n/server";
import { NonceContext } from "./lib/nonce";
import { logError } from "./server/http.server";
import { requestId } from "./server/route-errors.server";

export const handleError: HandleErrorFunction = (error, { request, context }) => {
  if (!request.signal.aborted) logError("server_request_failed", error, request, requestId(context.get(appContext)));
};

export default async function handleRequest(
  request: Request,
  status: number,
  headers: Headers,
  routerContext: EntryContext,
  context: RouterContextProvider,
): Promise<Response> {
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const app = context.get(appContext);
  const { nonce } = app;
  // Prefer the root loader's account locale; otherwise use cookie and browser.
  const locale = app.locale ?? requestLocale(request, null);
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
    // Render inside the locale scope before streaming.
    await stream.allReady;
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Content-Language", locale);
    return new Response(stream, { status, headers });
  });
}
