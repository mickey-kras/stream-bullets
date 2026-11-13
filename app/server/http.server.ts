import { z } from "zod";
import type { AppEnv } from "../env";
import { EMOTE_HOSTS } from "../lib/activity";

export class HttpError extends Error {
  // `code` is a stable, machine-readable reason (for example `step_up_required`) sent next to the message.
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export function getOrigin(env: AppEnv): string {
  let url: URL;
  try {
    url = new URL(env.APP_ORIGIN);
  } catch {
    throw new HttpError(503, "Application origin is not configured.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.origin !== env.APP_ORIGIN ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  ) {
    throw new HttpError(503, "Application origin is not configured.");
  }
  return url.origin;
}

export function requireSameOrigin(request: Request, env: AppEnv): void {
  if (request.headers.get("Origin") !== getOrigin(env) || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw new HttpError(403, "Use this site to submit changes.");
  }
}

// Refuse cross-origin browsers. No-Origin clients pass because they do not implicitly carry visitor cookies.
export function requireNotCrossSite(request: Request, env: AppEnv): void {
  const origin: string | null = request.headers.get("Origin");
  if ((origin !== null && origin !== getOrigin(env)) || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw new HttpError(403, "Use this site to submit changes.");
  }
}

export async function readBody(
  request: Pick<Request, "body" | "headers">,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))
    throw new HttpError(413, "Request is too large.");
  if (!request.body) throw new HttpError(400, "Request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "Request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Send JSON with application/json.");
  }
  const bytes = await readBody(request, 16 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "Send valid JSON.");
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid request.");
  return result.data;
}

export function queryParams(request: Request, allowed: string[]): URLSearchParams {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1)
      throw new HttpError(400, "Invalid query parameters.");
  }
  return params;
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

// Keep only stack frames, never messages: SQL/driver errors can expose secrets or PII across lines.
// Non-message-prefixed stacks yield no frames.
function stackFrames(error: Error): string[] {
  const header: string = String(error);
  if (!error.stack?.startsWith(header)) return [];
  return error.stack
    .slice(header.length)
    .split("\n")
    .map((line: string): string => line.trim())
    .filter((line: string): boolean => line.startsWith("at "));
}

// Log unexpected error class, stack frames, and Cloudflare Ray ID.
export function logError(event: string, error: unknown, request?: Request, requestId?: string): void {
  const frames: string[] = error instanceof Error ? stackFrames(error) : [];
  console.error(event, {
    cause: error instanceof Error ? error.name : typeof error,
    frames,
    ray: request?.headers.get("CF-Ray") ?? null,
    ...(requestId ? { requestId } : {}),
  });
}

export function errorResponse(error: unknown, request?: Request, requestId?: string): Response {
  if (error instanceof HttpError) {
    const response = json(
      error.code ? { error: error.message, code: error.code } : { error: error.message },
      error.status,
    );
    if (error.status === 429) response.headers.set("Retry-After", "60");
    return response;
  }
  logError("request_failed", error, request, requestId);
  const ray: string | null = request?.headers.get("CF-Ray") ?? null;
  return json(
    { error: "The request failed. Please try again.", ...(ray ? { ray } : {}), ...(requestId ? { requestId } : {}) },
    500,
  );
}

export function securityHeaders(
  response: Response,
  request: Request,
  nonce: string,
  origin: string,
  development: boolean,
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  // Overlay URLs carry secret keys; suppress Referer.
  const pathname: string = new URL(request.url).pathname;
  const overlayPage: boolean = /^\/@[^/]+\/overlay$/.test(pathname);
  // Only the overlay and its composition preview show chat emotes.
  const emoteHosts: string =
    overlayPage || pathname === "/overlay-control"
      ? ` ${EMOTE_HOSTS.map((host: string): string => `https://${host}`).join(" ")}`
      : "";
  headers.set("Referrer-Policy", overlayPage ? "no-referrer" : "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' blob: data:${emoteHosts}`,
      "font-src 'self'",
      `connect-src 'self' ${origin.replace(/^http/, "ws")}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  // HSTS preload requires a separate, domain-wide decision and is slow to undo.
  if (new URL(request.url).protocol === "https:")
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    ...(response.webSocket ? { webSocket: response.webSocket } : {}),
  });
}
