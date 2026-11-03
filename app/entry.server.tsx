import { renderToReadableStream } from "react-dom/server";
import { ServerRouter, type EntryContext, type HandleErrorFunction, type RouterContextProvider } from "react-router";
import { appContext } from "./env";

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
  const { nonce } = context.get(appContext);
  const stream = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
    {
      nonce,
      signal: request.signal,
      onError() {
        console.error("render_failed");
        status = 500;
      },
    },
  );
  await stream.allReady;
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(stream, { status, headers });
}
