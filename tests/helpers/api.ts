import { makeSignature } from "better-auth/crypto";
import { RouterContextProvider } from "react-router";
import { appContext, type AppEnv } from "../../app/env";
import { action, loader } from "../../app/routes/api";

export interface CallOptions {
  user?: string;
  body?: unknown;
  raw?: BodyInit;
  type?: string;
}

/**
 * Calls `/api/{path}` the way React Router does: GET and HEAD go to the loader, everything else to the action.
 * A user `name` signs in with the session token `{name}-session-token`.
 */
export function apiCaller(
  getEnv: () => AppEnv,
  origin: string,
  secret: string,
): {
  call: (method: string, path: string, options?: CallOptions) => Promise<Response>;
  cookie: (user: string) => Promise<string>;
  context: () => RouterContextProvider;
} {
  const context = (): RouterContextProvider => {
    const provider = new RouterContextProvider();
    provider.set(appContext, { env: getEnv(), nonce: "nonce", responseHeaders: new Headers() });
    return provider;
  };
  const cookie = async (user: string): Promise<string> => {
    const token = `${user}-session-token`;
    return `__Host-stream-bullets.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, secret)}`)}`;
  };
  const call = async (method: string, path: string, options: CallOptions = {}): Promise<Response> => {
    const url = `${origin}/api/${path}`;
    const headers: Record<string, string> = {};
    if (options.user) headers.cookie = await cookie(options.user);
    if (method !== "GET" && method !== "HEAD") headers.Origin = origin;
    let body: BodyInit | undefined = options.raw;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }
    if (options.type) headers["Content-Type"] = options.type;
    const args = {
      request: new Request(url, { method, headers, body }),
      params: { "*": path.split("?")[0] },
      context: context(),
      url: new URL(url),
      pattern: "/api/*",
    };
    return method === "GET" || method === "HEAD" ? loader(args) : action(args);
  };
  return { call, cookie, context };
}
