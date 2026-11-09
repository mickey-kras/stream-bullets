import { renderToReadableStream } from "react-dom/server";
import { ServerRouter, type EntryContext, type HandleErrorFunction, type RouterContextProvider } from "react-router";
import { appContext } from "./env";
import { requestLocale } from "./i18n/resolve";
import { withLocale } from "./i18n/server";
import { NonceContext } from "./lib/nonce";

export const handleError: HandleErrorFunction = (_error, { request }) => {
  if (!request.signal.aborted) console.error("server_request_failed");
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
  // The root loader resolved the language with the account's saved choice; without it, use cookie and browser.
  const locale = app.locale ?? requestLocale(request, null);
  return withLocale(locale, async (): Promise<Response> => {
    const stream = await renderToReadableStream(
      <NonceContext value={nonce}>
        <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
      </NonceContext>,
      {
        nonce,
        signal: request.signal,
        onError() {
          console.error("render_failed");
          status = 500;
        },
      },
    );
    // Rendering finishes inside the language scope; the response only streams what is already rendered.
    await stream.allReady;
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Content-Language", locale);
    return new Response(stream, { status, headers });
  });
}
