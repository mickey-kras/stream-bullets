import type { LoaderFunctionArgs } from "react-router";
import { appContext, type AppContext } from "../env";
import { HttpError, logError } from "./http.server";

export function requestId(app: AppContext): string {
  app.requestId ??= crypto.randomUUID();
  app.responseHeaders.set("X-Request-ID", app.requestId);
  return app.requestId;
}

export function withRouteErrors<T>(
  load: (args: LoaderFunctionArgs) => Promise<T>,
): (args: LoaderFunctionArgs) => Promise<T> {
  return async (args: LoaderFunctionArgs): Promise<T> => {
    const app: AppContext = args.context.get(appContext);
    const id: string = requestId(app);
    try {
      return await load(args);
    } catch (error: unknown) {
      if (error instanceof Response) throw error;
      if (error instanceof HttpError) throw new Response(error.message, { status: error.status });
      if (!args.request.signal.aborted) logError("server_request_failed", error, args.request, id);
      throw Response.json({ requestId: id }, { status: 500 });
    }
  };
}
