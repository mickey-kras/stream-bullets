import type { z } from "zod";
import type { AppContext, AppEnv } from "../../env";
import type { Viewer } from "../../types";
import { getViewer } from "../auth.server";
import { HttpError, errorResponse, queryParams, requireSameOrigin } from "../http.server";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiContext {
  request: Request;
  app: AppContext;
  env: AppEnv;
  /** The match of the route's `path` against the part after `/api/`. Groups hold the path parameters. */
  match: RegExpExecArray;
  /** The signed-in account, or null. Always set for writes. */
  viewer: Viewer | null;
}

export interface WriteContext extends ApiContext {
  viewer: Viewer;
}

/**
 * One endpoint. Reads (`GET`, which also answers `HEAD`) run for anyone and parse their own query.
 * Writes run only for a signed-in viewer on a same-origin request with no query string; the router
 * checks that before the handler runs.
 */
export type ApiRoute =
  | { method: "GET"; path: RegExp; handler: (context: ApiContext) => Promise<Response> }
  | { method: Exclude<Method, "GET">; path: RegExp; handler: (context: WriteContext) => Promise<Response> };

export function get(path: RegExp, handler: (context: ApiContext) => Promise<Response>): ApiRoute {
  return { method: "GET", path, handler };
}

export function write(
  method: Exclude<Method, "GET">,
  path: RegExp,
  handler: (context: WriteContext) => Promise<Response>,
): ApiRoute {
  return { method, path, handler };
}

/** Parses the query string with a schema. Unknown or repeated keys are rejected. */
export function parsedQuery<T>(request: Request, keys: string[], schema: z.ZodType<T>): T {
  const result = schema.safeParse(Object.fromEntries(queryParams(request, keys)));
  if (!result.success) throw new HttpError(400, "Invalid query parameters.");
  return result.data;
}

export function requireViewer(viewer: Viewer | null): Viewer {
  if (!viewer) throw new HttpError(401, "Sign in to continue.");
  return viewer;
}

function anchored(path: RegExp, value: string): RegExpExecArray | null {
  const match = path.exec(value);
  return match && match.index === 0 && match[0].length === value.length ? match : null;
}

/**
 * Runs the endpoint for `path` (the part after `/api/`). Unknown paths answer 404; a known path
 * with another method answers 405.
 */
export async function dispatch(
  routes: readonly ApiRoute[],
  request: Request,
  app: AppContext,
  path: string,
): Promise<Response> {
  try {
    const method = request.method === "HEAD" ? "GET" : request.method;
    let viewer: Viewer | null;
    if (method === "GET") {
      viewer = await getViewer(request, app);
    } else {
      requireSameOrigin(request, app.env);
      queryParams(request, []);
      viewer = requireViewer(await getViewer(request, app));
    }
    let known = false;
    for (const route of routes) {
      const match = anchored(route.path, path);
      if (!match) continue;
      known = true;
      if (route.method !== method) continue;
      const context = { request, app, env: app.env, match };
      if (route.method === "GET") return await route.handler({ ...context, viewer });
      return await route.handler({ ...context, viewer: requireViewer(viewer) });
    }
    throw new HttpError(known ? 405 : 404, known ? "Method not allowed." : "Endpoint not found.");
  } catch (error) {
    return errorResponse(error);
  }
}
