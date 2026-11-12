import { sitemapResponse } from "../app/server/sitemap.server";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { appContext, type AppEnv } from "../app/env";
import { isStreamerListed } from "../app/server/access.server";
import { getViewer } from "../app/server/auth.server";
import { getStreamer } from "../app/server/data.server";
import {
  HttpError,
  errorResponse,
  getOrigin,
  logError,
  queryParams,
  requireSameOrigin,
  securityHeaders,
} from "../app/server/http.server";
import { serveImage } from "../app/server/images.server";
import { overlayKeyMatches } from "../app/server/overlay-key.server";
import { visitorPrefix } from "../app/server/ip-prefix";
import { cleanExpiredData } from "../app/server/cleanup.server";
import { scheduleCalendar, topUpSeries } from "../app/server/schedule.server";

export { PollRoom } from "../app/server/poll-room";

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte: number) => byte.toString(16).padStart(2, "0")).join("");
}

// Hash an IPv4 address or IPv6 /64; IPv4-mapped IPv6 counts as IPv4.
async function clientKey(request: Request): Promise<string> {
  return sha256(visitorPrefix(request.headers.get("CF-Connecting-IP") ?? "local"));
}

const handler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

async function calendarResponse(request: Request, env: AppEnv, handle: string, origin: string): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "Method not allowed.");
  queryParams(request, []);
  const streamer = await getStreamer(env, handle);
  // Suspension blocks calendars, including the owner's.
  if (!streamer || !isStreamerListed(streamer.status)) throw new HttpError(404, "Streamer not found.");
  const body = await scheduleCalendar(env, streamer, origin);
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="${streamer.handle}-schedule.ics"`,
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function liveResponse(
  request: Request,
  env: AppEnv,
  handle: string,
  key: string,
  nonce: string,
  responseHeaders: Headers,
): Promise<Response> {
  requireSameOrigin(request, env);
  const overlayKey: string | null = queryParams(request, ["key"]).get("key");
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    throw new HttpError(426, "Use a WebSocket connection.");
  const streamer = await getStreamer(env, handle);
  // Suspension blocks live connections, including the owner's.
  if (!streamer || !isStreamerListed(streamer.status)) throw new HttpError(404, "Streamer not found.");
  // Overwrite client identity headers before forwarding to the room.
  const viewer = await getViewer(request, { env, nonce, responseHeaders });
  const headers = new Headers({
    Upgrade: "websocket",
    "X-Stream-Bullets-Client": key,
  });
  if (viewer) headers.set("X-SB-User", viewer.id);
  if (viewer?.id === streamer.ownerId) headers.set("X-SB-Owner", "1");
  // Invalid/revoked keys join as signed-out viewers.
  else if (await overlayKeyMatches(env, streamer.id, overlayKey)) headers.set("X-SB-Overlay", "1");
  const room = env.POLL_ROOMS.get(env.POLL_ROOMS.idFromName(streamer.id));
  return room.fetch(`https://poll-room.internal/subscribe?streamerId=${encodeURIComponent(streamer.id)}`, { headers });
}

export default {
  // Run hourly jobs independently. Log each failure, then throw so cron failure alerts fire.
  async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
    const jobs: Record<string, (env: AppEnv, now: number) => Promise<unknown>> = {
      cleanup: cleanExpiredData,
      // Keep weekly series 12 weeks ahead.
      schedule_top_up: topUpSeries,
    };
    const names: string[] = Object.keys(jobs);
    const results = await Promise.allSettled(names.map((name: string) => jobs[name](env, controller.scheduledTime)));
    const failed: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;
      failed.push(names[index]);
      logError(`cron_${names[index]}_failed`, result.reason);
    }
    if (failed.length > 0) throw new Error(`Cron jobs failed: ${failed.join(", ")}`);
    // Heartbeat alerts also detect cron jobs that never run.
    if (env.CRON_HEARTBEAT_URL) {
      const ping = await fetch(env.CRON_HEARTBEAT_URL, { method: "POST" });
      if (!ping.ok) console.error("cron_heartbeat_failed", { status: ping.status });
    }
  },
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const nonce = btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(18))));
    const requestId: string = crypto.randomUUID();
    const responseHeaders = new Headers({ "X-Request-ID": requestId });
    let response: Response;
    let origin: string;
    try {
      origin = getOrigin(env);
      if (new URL(request.url).origin !== origin) throw new HttpError(421, "Use the configured application URL.");
      const key = await clientKey(request);
      if (!(await env.REQUEST_LIMITER.limit({ key })).success)
        throw new HttpError(429, "Too many requests. Please try again in a minute.");
      const path = new URL(request.url).pathname;
      const live = /^\/api\/live\/([a-z0-9_]{3,30})$/.exec(path);
      const calendar = /^\/@([a-z0-9_]{3,30})\/schedule\.ics$/.exec(path);
      if (path === "/sitemap.xml") {
        response = await sitemapResponse(request, env);
      } else if (calendar) {
        response = await calendarResponse(request, env, calendar[1], origin);
      } else if (live) {
        response = await liveResponse(request, env, live[1], key, nonce, responseHeaders);
      } else if (path.startsWith("/images/")) {
        if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "Method not allowed.");
        response = await serveImage(env, path.slice("/images/".length), request.method);
      } else {
        const context = new RouterContextProvider();
        context.set(appContext, { env, nonce, responseHeaders, requestId });
        response = await handler(request, context);
      }
    } catch (error) {
      response = errorResponse(error, request, requestId);
      origin = "https://invalid.invalid";
    }
    const secured = securityHeaders(response, request, nonce, origin, import.meta.env.DEV);
    secured.headers.set("X-Request-ID", requestId);
    for (const value of responseHeaders.getSetCookie()) secured.headers.append("Set-Cookie", value);
    return secured;
  },
} satisfies ExportedHandler<AppEnv>;
